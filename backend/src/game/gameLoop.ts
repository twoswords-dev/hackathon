import { gameSessions, players, gameEvents, gameState } from '../db';
import { generateNarrative, DMResponse } from '../agents/dungeonMaster';
import { synthesizeAndCache } from '../agents/pollyNarrator';
import { sseManager } from '../sse';
import { DiceResultInput, GameState, Player, StatChange, Character, CharacterStats, DiceType, normalizeDiceType, diceFaces } from '../types/game';

// Track active game loops
const activeGames = new Map<string, { running: boolean }>();

/**
 * Pacing delays (ms).
 *
 * These control how long a dice result stays on screen: the frontend keeps the
 * result panel up until the next `narrative` or `dice_request` arrives, so the
 * engine's delay before moving on *is* the display duration.
 */
const INTRO_READ_MS = 8000;        // time to read the opening adventure summary
const DICE_RESULT_DISPLAY_MS = 7000; // result of a single-roll event stays up
const COMBAT_ROLL_DISPLAY_MS = 5000; // result of a combat/boss round stays up
const ENCOUNTER_END_DISPLAY_MS = 4000; // victory/defeat beat before next event

/**
 * The finale is always a d20 fight — the widest spread, so crits and crit-fails
 * are both on the table. Named rather than inlined so it is clearly deliberate
 * and not a leftover hardcoded default like combat rounds used to have.
 */
const BOSS_DICE_TYPE: DiceType = 'd20';

/**
 * Live, human-readable description of what the game is currently waiting on.
 * Kept in memory alongside the loop so the UI can render an accurate
 * "current step" panel and reconnecting clients can rehydrate it.
 */
export interface StepInfo {
  phase: 'idle' | 'narrating' | 'awaiting_roll' | 'resolving' | 'complete';
  encounter: 'none' | 'combat' | 'boss';
  title: string;
  detail: string;
  eventNumber: number;
  totalEvents: number;
  activePlayerId?: string;
  activePlayerName?: string;
  characterName?: string;
  characterClass?: string;
  characterStats?: CharacterStats | null;
  diceType?: string;
  roundNumber?: number;
  enemyName?: string;
  enemyHp?: number;
  enemyMaxHp?: number;
  lastRoll?: { playerName: string; characterName: string; rollValue: number; maxValue: number; outcome: string } | null;
  updatedAt: string;
}

const stepInfoBySession = new Map<string, StepInfo>();

/**
 * Strip decoration that sounds wrong when read aloud.
 *
 * Narratives carry emoji, bullet glyphs and compact stat lines ("HP:71 STR:12")
 * that Polly would either skip or read character by character, so they are
 * removed before synthesis. The on-screen text keeps them.
 */
function toSpeechText(text: string): string {
  return text
    // Arrow notation used in recaps. Must run before the symbol strip below,
    // whose range covers U+2190-U+21FF and would otherwise delete the arrow.
    .replace(/→/g, ' then ')
    // Drop emoji / pictographs / dingbats.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, ' ')
    // Bullet and list glyphs become sentence breaks.
    .replace(/[•·▪]/g, '. ')
    // Stat shorthand reads badly; drop those runs entirely.
    .replace(/\b(HP|STR|DEX|INT|WIS|CHA|CON|MAXHP)\s*:\s*-?\d+/gi, '')
    // Em/en dashes left dangling after the strips above add nothing spoken.
    .replace(/\s[—–]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/(\.\s*){2,}/g, '. ')
    .trim();
}

/**
 * Emit a `narrative` SSE event, attaching synthesized speech when available.
 *
 * Synthesis is awaited so the text and its audio reach clients together, which
 * lets the UI pace the on-screen reveal against the real clip duration. A TTS
 * failure is non-fatal: the narrative still goes out, just silently.
 */
async function emitNarrative(
  sessionId: string,
  eventNumber: number,
  data: Record<string, unknown> & { text: string },
  speechTextOverride?: string
): Promise<void> {
  let audioUrl: string | undefined;

  try {
    const speech = toSpeechText(speechTextOverride ?? data.text);
    if (speech.length > 0) {
      audioUrl = await synthesizeAndCache(sessionId, eventNumber, speech);
    }
  } catch (err) {
    console.error('[GameLoop] TTS synthesis failed; emitting narrative without audio:', err);
  }

  sseManager.emit(sessionId, 'narrative', { ...data, eventNumber, audioUrl });
}

/**
 * Merge a partial update into the session's step info and broadcast it so every
 * client's step panel reflects the same state.
 */
function setStep(sessionId: string, patch: Partial<StepInfo>): StepInfo {
  const previous = stepInfoBySession.get(sessionId);
  const next: StepInfo = {
    phase: 'idle',
    encounter: 'none',
    title: 'Preparing the adventure',
    detail: '',
    eventNumber: 0,
    totalEvents: 0,
    lastRoll: null,
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  stepInfoBySession.set(sessionId, next);
  sseManager.emit(sessionId, 'step_update', next);
  return next;
}

/**
 * Current step info for a session (used by GET /:sessionId/state).
 */
export function getStepInfo(sessionId: string): StepInfo | null {
  return stepInfoBySession.get(sessionId) || null;
}

/**
 * The die the engine is actually waiting on right now, or null if it is not
 * waiting for a roll.
 *
 * The persisted event row is not reliable for this: it stores the die chosen
 * when the event was created, while combat and boss rounds request their own
 * die each round. Step info is updated on every request, so it is the single
 * authoritative answer for normal events, combat and boss fights alike.
 */
export function getRequestedDiceType(sessionId: string): DiceType | null {
  const step = stepInfoBySession.get(sessionId);
  if (!step || step.phase !== 'awaiting_roll') return null;
  return step.diceType ? normalizeDiceType(step.diceType) : null;
}

// Boss fight state (in-memory per session)
const bossFights = new Map<string, {
  bossHp: number;
  bossMaxHp: number;
  bossName: string;
  roundNumber: number;
  playerIndex: number;
  deadPlayers: Set<string>;
}>();

// Combat encounter state (in-memory per session) - for mid-game combat events
const combatEncounters = new Map<string, {
  enemyHp: number;
  enemyMaxHp: number;
  enemyName: string;
  eventNumber: number;
  diceType: DiceType;
  roundNumber: number;
  playerIndex: number;
  deadPlayers: Set<string>;
}>();

/**
 * Resolve the character a player is actually playing.
 *
 * The player record is the source of truth once a character has been assigned,
 * because that is where stat changes (HP loss, etc.) are persisted. The lore's
 * suggestedCharacters list is only a template used as a fallback.
 */
function resolveCharacter(
  state: GameState,
  player: Player | undefined,
  fallbackIndex = 0
): Character | undefined {
  if (player?.character?.stats) return player.character;

  const suggested = state.worldLore.suggestedCharacters;
  if (!suggested || suggested.length === 0) return undefined;

  const byId = suggested.find((c) => c.id === player?.character?.id);
  return byId || suggested[fallbackIndex % suggested.length];
}

/**
 * A character at 0 HP is downed and cannot act.
 *
 * Persisted HP is the single source of truth here, rather than a parallel
 * "dead players" set, so a downed hero stays downed across encounters instead
 * of being asked to roll again in the next event.
 */
function isDowned(state: GameState, player: Player | undefined, index = 0): boolean {
  if (!player) return true;
  const character = resolveCharacter(state, player, index);
  if (!character) return false;
  return character.stats.hp <= 0;
}

/**
 * Players who can still act, paired with their original roster index so
 * character fallbacks stay stable.
 */
function livingParty(state: GameState, sessionPlayers: Player[]): { player: Player; index: number }[] {
  return sessionPlayers
    .map((player, index) => ({ player, index }))
    .filter(({ player, index }) => !isDowned(state, player, index));
}

/**
 * Apply stat deltas to players and persist them.
 *
 * Without this, HP changes were only ever broadcast in the SSE payload and the
 * character sheet never actually changed. Returns the new stats per player so
 * the outgoing event can carry authoritative values.
 */async function applyStatChanges(
  sessionId: string,
  state: GameState,
  statChanges: StatChange[]
): Promise<Record<string, CharacterStats>> {
  if (!statChanges || statChanges.length === 0) return {};

  const sessionPlayers = await players.getSessionPlayers(sessionId);
  const updated: Record<string, CharacterStats> = {};

  // Group deltas by player so each player is written once.
  const byPlayer = new Map<string, StatChange[]>();
  for (const change of statChanges) {
    if (!change.playerId) continue;
    const list = byPlayer.get(change.playerId) || [];
    list.push(change);
    byPlayer.set(change.playerId, list);
  }

  for (const [playerId, changes] of byPlayer) {
    const player = sessionPlayers.find((p) => p.playerId === playerId);
    if (!player) continue;

    const index = sessionPlayers.indexOf(player);
    const baseCharacter = resolveCharacter(state, player, index);
    if (!baseCharacter) continue;

    // Deep-ish clone so we never mutate the shared lore template.
    const character: Character = {
      ...baseCharacter,
      stats: { ...baseCharacter.stats },
      statusEffects: [...(baseCharacter.statusEffects || [])],
      inventory: [...(baseCharacter.inventory || [])],
    };

    for (const change of changes) {
      const stat = change.stat;
      const current = character.stats[stat] ?? 0;
      let next = current + change.delta;

      if (stat === 'hp') {
        // HP is clamped to the character's own ceiling and floored at 0, so the
        // -999 "downed" sentinel resolves to exactly 0 rather than a negative.
        next = Math.max(0, Math.min(next, character.stats.maxHp));
      } else if (stat === 'maxHp') {
        next = Math.max(1, next);
      } else {
        next = Math.max(1, next);
      }

      character.stats[stat] = next;
    }

    // Write the whole character: the player may not have had one assigned yet,
    // and a nested-path update would fail on a missing attribute.
    await players.assignCharacter(sessionId, playerId, character);
    updated[playerId] = character.stats;

    console.log(
      `[Stats] ${player.playerName} (${character.name}): ` +
        changes.map((c) => `${c.stat}${c.delta >= 0 ? '+' : ''}${c.delta}`).join(' ') +
        ` → HP ${character.stats.hp}/${character.stats.maxHp}`
    );
  }

  return updated;
}


/**
 * Start the game loop for a session.
 */
export async function startGameLoop(sessionId: string): Promise<void> {
  if (activeGames.has(sessionId)) {
    console.log(`[GameLoop] Game ${sessionId} already running`);
    return;
  }

  const session = await gameSessions.getGameSession(sessionId);
  if (!session) throw new Error('Session not found');

  // Update status
  await gameSessions.updateSessionStatus(sessionId, 'in_progress');
  activeGames.set(sessionId, { running: true });

  const state = await gameState.getGameState(sessionId);
  if (!state) throw new Error('Game state not found');

  const sessionPlayers = await players.getSessionPlayers(sessionId);

  // Broadcast game started
  sseManager.emit(sessionId, 'game_started', {
    totalEvents: session.totalEvents,
    message: 'The adventure begins!',
  });

  console.log(`[GameLoop] Starting game ${sessionId} (${session.totalEvents} events)`);

  setStep(sessionId, {
    phase: 'narrating',
    encounter: 'none',
    title: 'The Journey Begins',
    detail: `The Dungeon Master is introducing ${state.worldLore.worldName}.`,
    eventNumber: 0,
    totalEvents: session.totalEvents,
    lastRoll: null,
  });

  // === JOURNEY SUMMARY (opening) ===
  const journeySummary = buildJourneySummary(state, sessionPlayers);
  // Narrate only the prose intro; the party roster and road-ahead list are
  // reference material that does not read well aloud.
  const journeyNarration = buildJourneyNarration(state);
  await emitNarrative(sessionId, 0, {
    text: journeySummary,
    title: '📖 The Journey Begins',
  }, journeyNarration);

  // Give players time to read the opening summary before the first event
  setTimeout(() => advanceToNextEvent(sessionId), INTRO_READ_MS);
}

/**
 * Build a journey summary from lore data.
 */
function buildJourneySummary(state: GameState, sessionPlayers: Player[]): string {
  const lore = state.worldLore;
  let summary = `Welcome to ${lore.worldName}. ${lore.worldDescription}\n\n`;

  // Opening synopsis of the whole campaign arc, so players know what they signed
  // up for before the first roll.
  if (lore.adventureSummary) {
    summary += `${lore.adventureSummary}\n\n`;
  }

  summary += `Your party:\n`;
  for (let i = 0; i < sessionPlayers.length; i++) {
    const p = sessionPlayers[i];
    const char = resolveCharacter(state, p, i);
    if (char) {
      summary += `• ${char.name} (${char.race} ${char.class}) — HP:${char.stats.hp} STR:${char.stats.str} DEX:${char.stats.dex}\n`;
    } else {
      summary += `• ${p.playerName} — ready for adventure\n`;
    }
  }

  // Preview the road ahead by title so the arc is legible from turn one.
  const previewCount = 3;
  const preview = lore.eventOutlines.slice(0, previewCount);
  if (preview.length > 0) {
    summary += `\nThe road ahead:\n`;
    for (const evt of preview) {
      summary += `${evt.eventNumber}. ${evt.title}${evt.type === 'combat' ? ' ⚔️' : ''}\n`;
    }
    if (lore.eventOutlines.length > previewCount) {
      summary += `…and ${lore.eventOutlines.length - previewCount} more.\n`;
    }
  }

  summary += `\n${lore.eventOutlines.length} challenges await. The final battle will test you all.`;
  return summary;
}

/**
 * Spoken form of the opening: world framing plus the campaign synopsis.
 */
function buildJourneyNarration(state: GameState): string {
  const lore = state.worldLore;
  return [
    `Welcome to ${lore.worldName}.`,
    lore.worldDescription,
    lore.adventureSummary,
    `${lore.eventOutlines.length} challenges await. The final battle will test you all.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Advance to the next event in the game.
 */
async function advanceToNextEvent(sessionId: string): Promise<void> {
  if (!activeGames.get(sessionId)?.running) return;

  const session = await gameSessions.getGameSession(sessionId);
  if (!session) return;

  const state = await gameState.getGameState(sessionId);
  if (!state) return;

  const nextEventNumber = session.currentEvent + 1;

  // Check if this is the FINAL event → boss fight
  if (nextEventNumber === session.totalEvents) {
    // Advance counter first
    await gameSessions.advanceEvent(sessionId);
    await startBossFight(sessionId, state);
    return;
  }

  // Check if game is over (past total)
  if (nextEventNumber > session.totalEvents) {
    await endGame(sessionId);
    return;
  }

  // Advance session counter
  const updatedSession = await gameSessions.advanceEvent(sessionId);
  console.log(`[GameLoop] Advanced to event ${updatedSession.currentEvent}/${updatedSession.totalEvents}`);

  // Broadcast the counter update immediately
  sseManager.emit(sessionId, 'state_update', {
    currentEvent: updatedSession.currentEvent,
    totalEvents: updatedSession.totalEvents,
  });

  // Get event outline
  const eventOutline = state.worldLore.eventOutlines.find(
    (e) => e.eventNumber === nextEventNumber
  );

  if (!eventOutline) {
    console.error(`[GameLoop] No event outline for event ${nextEventNumber}`);
    await endGame(sessionId);
    return;
  }

  // Pick the player for this event, rotating only among heroes still standing.
  const sessionPlayers = await players.getSessionPlayers(sessionId);
  const living = livingParty(state, sessionPlayers);

  // Whole party downed: the campaign ends here rather than asking corpses to roll.
  if (living.length === 0) {
    await endGame(sessionId, 'wipe');
    return;
  }

  const turn = living[(nextEventNumber - 1) % living.length];
  const activePlayer = turn.player;
  const playerIndex = turn.index;

  // Get their live character (player record wins over the lore template)
  const character = resolveCharacter(state, activePlayer, playerIndex);

  setStep(sessionId, {
    phase: 'narrating',
    encounter: 'none',
    title: eventOutline.title,
    detail: 'The Dungeon Master is setting the scene...',
    eventNumber: nextEventNumber,
    totalEvents: updatedSession.totalEvents,
    activePlayerId: activePlayer?.playerId,
    activePlayerName: activePlayer?.playerName,
    characterName: character?.name,
    characterClass: character?.class,
    characterStats: character?.stats || null,
    diceType: undefined,
    roundNumber: undefined,
    enemyName: undefined,
    enemyHp: undefined,
    enemyMaxHp: undefined,
  });

  // Generate DM narrative for this event — tied to the character
  await generateAndBroadcastNarrative(sessionId, state, nextEventNumber, activePlayer, character);
}

/**
 * Generate narrative from DM agent and broadcast to players.
 */
async function generateAndBroadcastNarrative(
  sessionId: string,
  state: GameState,
  eventNumber: number,
  activePlayer: Player,
  character: Character | undefined
): Promise<void> {
  const sessionPlayers = await players.getSessionPlayers(sessionId);
  const previousEvts = await gameEvents.getSessionEvents(sessionId);
  const session = await gameSessions.getGameSession(sessionId);
  if (!session) return;

  const eventOutline = state.worldLore.eventOutlines.find(
    (e) => e.eventNumber === eventNumber
  );
  if (!eventOutline) return;

  // Call DM agent
  const dmResponse = await generateNarrative({
    gameState: state,
    players: sessionPlayers,
    currentEvent: null,
    previousEvents: previousEvts,
    eventOutlineTitle: eventOutline.title,
    eventOutlineDescription: eventOutline.description,
    isFirstBeat: true,
    totalEvents: session.totalEvents,
    currentEventNumber: eventNumber,
  });

  // Create game event in DB
  await gameEvents.createGameEvent({
    sessionId,
    eventNumber,
    title: eventOutline.title,
    narrative: dmResponse.narrative_text,
    actionRequired: 'dice_roll',
    targetPlayerId: activePlayer.playerId,
    diceType: normalizeDiceType(dmResponse.dice_type || eventOutline.requiredDiceType),
  });

  // Update game state
  await gameState.updateLastNarrative(sessionId, dmResponse.narrative_text);
  await gameState.setWaitingForDice(sessionId, true);

  // Update current turn player
  await gameState.updateTurn(sessionId, activePlayer.playerId, state.turnNumber + 1);

  // Broadcast narrative with character info
  await emitNarrative(sessionId, eventNumber, {
    text: dmResponse.narrative_text,
    title: eventOutline.title,
    characterName: character?.name,
    characterClass: character?.class,
    playerName: activePlayer.playerName,
    isCombat: eventOutline.type === 'combat',
    enemyName: eventOutline.enemyName,
    enemyHp: eventOutline.enemyHp,
  });

  // If this is a combat event, start a combat encounter loop
  if (eventOutline.type === 'combat' && eventOutline.enemyName && eventOutline.enemyHp) {
    await startCombatEncounter(sessionId, eventNumber, eventOutline, sessionPlayers, state);
    return;
  }

  // Broadcast dice request tied to the character (single roll events)
  const diceType = normalizeDiceType(dmResponse.dice_type || eventOutline.requiredDiceType);
  const reason = dmResponse.dice_reason || `${character?.name || activePlayer.playerName} must face this challenge!`;

  setStep(sessionId, {
    phase: 'awaiting_roll',
    encounter: 'none',
    title: eventOutline.title,
    detail: reason,
    eventNumber,
    totalEvents: session.totalEvents,
    activePlayerId: activePlayer.playerId,
    activePlayerName: activePlayer.playerName,
    characterName: character?.name,
    characterClass: character?.class,
    characterStats: character?.stats || null,
    diceType,
  });

  sseManager.emit(sessionId, 'dice_request', {
    targetPlayerId: activePlayer.playerId,
    targetPlayerName: activePlayer.playerName,
    characterName: character?.name,
    characterClass: character?.class,
    characterStats: character?.stats || null,
    diceType,
    reason,
    attemptNumber: 1,
    eventNumber,
    totalEvents: session.totalEvents,
    eventTitle: eventOutline.title,
    difficulty: eventOutline.difficulty,
  });

  console.log(`[GameLoop] Event ${eventNumber}: ${character?.name} (${activePlayer.playerName}) rolls ${diceType}`);
}

/**
 * Start a combat encounter for a mid-game event.
 */
async function startCombatEncounter(
  sessionId: string,
  eventNumber: number,
  eventOutline: { enemyName?: string; enemyHp?: number; title: string; requiredDiceType?: DiceType },
  sessionPlayers: Player[],
  state: GameState
): Promise<void> {
  const enemyHp = eventOutline.enemyHp || sessionPlayers.length * 30;
  const enemyName = eventOutline.enemyName || 'Enemy';
  // Combat used to force d20 every round; honour the event's own die so the
  // party actually rolls the variety the lore asked for.
  const diceType = normalizeDiceType(eventOutline.requiredDiceType);

  combatEncounters.set(sessionId, {
    enemyHp,
    enemyMaxHp: enemyHp,
    enemyName,
    eventNumber,
    diceType,
    roundNumber: 1,
    playerIndex: 0,
    deadPlayers: new Set(),
  });

  console.log(`[Combat] Starting encounter: ${enemyName} (HP: ${enemyHp}) at event ${eventNumber}`);

  const session = await gameSessions.getGameSession(sessionId);
  setStep(sessionId, {
    phase: 'narrating',
    encounter: 'combat',
    title: `Combat: ${enemyName}`,
    detail: `${enemyName} blocks the path (HP ${enemyHp}/${enemyHp}).`,
    eventNumber,
    totalEvents: session?.totalEvents ?? 0,
    roundNumber: 1,
    enemyName,
    enemyHp,
    enemyMaxHp: enemyHp,
    lastRoll: null,
  });

  // Request first player's roll
  await requestCombatRoll(sessionId);
}

/**
 * Request the next roll in a combat encounter.
 */
async function requestCombatRoll(sessionId: string): Promise<void> {
  const combat = combatEncounters.get(sessionId);
  if (!combat) return;

  const sessionPlayers = await players.getSessionPlayers(sessionId);
  const state = await gameState.getGameState(sessionId);
  if (!state) return;
  const session = await gameSessions.getGameSession(sessionId);

  // Find the next hero still standing. HP is authoritative; the per-encounter
  // set only catches deaths that happened during this fight.
  const isOut = (idx: number) =>
    combat.deadPlayers.has(sessionPlayers[idx]?.playerId) || isDowned(state, sessionPlayers[idx], idx);

  let attempts = 0;
  while (isOut(combat.playerIndex) && attempts < sessionPlayers.length) {
    combat.playerIndex = (combat.playerIndex + 1) % sessionPlayers.length;
    attempts++;
  }

  // All players down? End combat as loss
  if (isOut(combat.playerIndex)) {
    await endCombatEncounter(sessionId, false);
    return;
  }

  const activePlayer = sessionPlayers[combat.playerIndex];
  const character = resolveCharacter(state, activePlayer, combat.playerIndex);

  await gameState.setWaitingForDice(sessionId, true);
  await gameState.updateTurn(sessionId, activePlayer.playerId, combat.roundNumber);

  const reason = `${character?.name || activePlayer.playerName} attacks ${combat.enemyName}!`;

  setStep(sessionId, {
    phase: 'awaiting_roll',
    encounter: 'combat',
    title: `Combat: ${combat.enemyName}`,
    detail: reason,
    eventNumber: combat.eventNumber,
    totalEvents: session?.totalEvents ?? 0,
    activePlayerId: activePlayer.playerId,
    activePlayerName: activePlayer.playerName,
    characterName: character?.name,
    characterClass: character?.class,
    characterStats: character?.stats || null,
    diceType: combat.diceType,
    roundNumber: combat.roundNumber,
    enemyName: combat.enemyName,
    enemyHp: combat.enemyHp,
    enemyMaxHp: combat.enemyMaxHp,
  });

  sseManager.emit(sessionId, 'dice_request', {
    targetPlayerId: activePlayer.playerId,
    targetPlayerName: activePlayer.playerName,
    characterName: character?.name || activePlayer.playerName,
    characterClass: character?.class || 'Adventurer',
    characterStats: character?.stats || null,
    diceType: combat.diceType,
    reason: `${reason} (Enemy HP: ${combat.enemyHp}/${combat.enemyMaxHp})`,
    attemptNumber: combat.roundNumber,
    eventNumber: combat.eventNumber,
    totalEvents: session?.totalEvents ?? 0,
    isCombat: true,
    roundNumber: combat.roundNumber,
    enemyHp: combat.enemyHp,
    enemyMaxHp: combat.enemyMaxHp,
    enemyName: combat.enemyName,
  });
}

/**
 * Handle dice result during a combat encounter.
 */
async function handleCombatDiceResult(
  sessionId: string,
  diceResult: DiceResultInput,
  targetPlayer: Player | undefined,
  character: Character | undefined
): Promise<void> {
  const combat = combatEncounters.get(sessionId);
  if (!combat) return;

  const state = await gameState.getGameState(sessionId);
  const session = await gameSessions.getGameSession(sessionId);

  const rollValue = diceResult.rollValue;
  const maxValue = diceFaces(diceResult.diceType);
  const charName = character?.name || targetPlayer?.playerName || 'Hero';

  let damage = 0;
  let outcome = '';
  let statChanges: StatChange[] = [];
  let playerDied = false;

  if (rollValue >= maxValue * 0.9) {
    // Crit — massive damage
    damage = 20;
    outcome = `⚡ CRIT! ${charName} devastates ${combat.enemyName} for ${damage} damage!`;
    statChanges = [{ playerId: targetPlayer?.playerId || '', stat: 'str', delta: 1 }];
  } else if (rollValue >= maxValue * 0.5) {
    // Hit — solid damage
    damage = 10;
    outcome = `✅ ${charName} strikes ${combat.enemyName} for ${damage} damage!`;
  } else if (rollValue >= maxValue * 0.25) {
    // Glancing blow + retaliation
    damage = 3;
    outcome = `⚠️ ${charName} grazes ${combat.enemyName} (${damage} dmg) but takes a hit! -5 HP`;
    statChanges = [{ playerId: targetPlayer?.playerId || '', stat: 'hp', delta: -5 }];
  } else if (rollValue > 1) {
    // Miss + heavy retaliation
    damage = 0;
    outcome = `❌ ${charName} misses! ${combat.enemyName} retaliates! -10 HP`;
    statChanges = [{ playerId: targetPlayer?.playerId || '', stat: 'hp', delta: -10 }];
  } else {
    // Crit fail — character is downed
    damage = 0;
    outcome = `💀 Critical failure! ${charName} is struck down by ${combat.enemyName}!`;
    statChanges = [{ playerId: targetPlayer?.playerId || '', stat: 'hp', delta: -999 }];
    playerDied = true;
    if (targetPlayer) combat.deadPlayers.add(targetPlayer.playerId);
  }

  // Persist the stat changes so the character sheet actually updates.
  const updatedStats = state ? await applyStatChanges(sessionId, state, statChanges) : {};
  const liveStats = (targetPlayer && updatedStats[targetPlayer.playerId]) || character?.stats || null;

  // A character reduced to 0 HP is out of the fight, however it happened.
  if (liveStats && liveStats.hp <= 0 && targetPlayer) {
    combat.deadPlayers.add(targetPlayer.playerId);
    playerDied = true;
  }

  // Apply damage to enemy
  combat.enemyHp = Math.max(0, combat.enemyHp - damage);

  // Broadcast the result
  sseManager.emit(sessionId, 'dice_result', {
    playerId: targetPlayer?.playerId || '',
    playerName: targetPlayer?.playerName || 'Unknown',
    characterName: charName,
    characterClass: character?.class || 'Adventurer',
    characterStats: liveStats,
    diceType: diceResult.diceType,
    rollValue,
    maxValue,
    source: diceResult.source,
    outcome,
    reason: `Attack ${combat.enemyName}`,
    difficulty: 'medium',
    statChanges,
    updatedStats,
    isCombat: true,
    roundNumber: combat.roundNumber,
    enemyHp: combat.enemyHp,
    enemyMaxHp: combat.enemyMaxHp,
    enemyName: combat.enemyName,
    playerDied,
    isCrit: rollValue >= maxValue * 0.9,
    critDamage: rollValue >= maxValue * 0.9 ? damage : undefined,
  });

  setStep(sessionId, {
    phase: 'resolving',
    encounter: 'combat',
    title: `Combat: ${combat.enemyName}`,
    detail: outcome,
    eventNumber: combat.eventNumber,
    totalEvents: session?.totalEvents ?? 0,
    characterName: charName,
    characterClass: character?.class,
    characterStats: liveStats,
    roundNumber: combat.roundNumber,
    enemyName: combat.enemyName,
    enemyHp: combat.enemyHp,
    enemyMaxHp: combat.enemyMaxHp,
    lastRoll: {
      playerName: targetPlayer?.playerName || 'Unknown',
      characterName: charName,
      rollValue,
      maxValue,
      outcome,
    },
  });

  console.log(`[Combat] ${charName}: rolled ${rollValue} → ${damage} dmg → ${combat.enemyName} HP: ${combat.enemyHp}/${combat.enemyMaxHp}`);

  // Check if enemy is dead
  if (combat.enemyHp <= 0) {
    await endCombatEncounter(sessionId, true);
    return;
  }

  // Move to next player
  const sessionPlayers = await players.getSessionPlayers(sessionId);
  combat.playerIndex = (combat.playerIndex + 1) % sessionPlayers.length;

  // Check if we've gone around — new round
  if (combat.playerIndex === 0) {
    combat.roundNumber++;
  }

  // Hold this round's result on screen, then request the next roll
  setTimeout(() => requestCombatRoll(sessionId), COMBAT_ROLL_DISPLAY_MS);
}

/**
 * End a combat encounter.
 */
async function endCombatEncounter(sessionId: string, playersWon: boolean): Promise<void> {
  const combat = combatEncounters.get(sessionId);
  if (!combat) return;

  const session = await gameSessions.getGameSession(sessionId);
  if (!session) return;

  // Complete the event in DB
  await gameEvents.completeEvent(sessionId, combat.eventNumber, {
    outcome: playersWon
      ? `Victory! ${combat.enemyName} has been defeated!`
      : `A hero has fallen to ${combat.enemyName}... The party presses on.`,
  });

  // Broadcast combat end narrative
  await emitNarrative(sessionId, combat.eventNumber, {
    text: playersWon
      ? `⚔️ ${combat.enemyName} falls! The heroes are victorious! (${combat.enemyMaxHp} HP dealt)`
      : `💀 A hero has fallen to ${combat.enemyName}. The remaining party steels themselves and moves on.`,
    title: playersWon ? `⚔️ Victory: ${combat.enemyName} Defeated` : `💀 Fallen to ${combat.enemyName}`,
    isCombat: true,
    enemyHp: 0,
    enemyMaxHp: combat.enemyMaxHp,
  });

  combatEncounters.delete(sessionId);

  setStep(sessionId, {
    phase: 'narrating',
    encounter: 'none',
    title: playersWon ? `Victory: ${combat.enemyName} defeated` : `Fallen to ${combat.enemyName}`,
    detail: playersWon
      ? 'The party presses on to the next challenge.'
      : 'The remaining party steels themselves and moves on.',
    eventNumber: combat.eventNumber,
    totalEvents: session.totalEvents,
    roundNumber: undefined,
    enemyName: undefined,
    enemyHp: undefined,
    enemyMaxHp: undefined,
  });

  // Continue to next event (game doesn't end on mid-combat death, only boss)
  setTimeout(() => advanceToNextEvent(sessionId), ENCOUNTER_END_DISPLAY_MS);
}

/**
 * Start the boss fight (final event).
 */
async function startBossFight(sessionId: string, state: GameState): Promise<void> {
  const session = await gameSessions.getGameSession(sessionId);
  if (!session) return;

  const sessionPlayers = await players.getSessionPlayers(sessionId);
  const eventNumber = session.totalEvents;

  // Boss stats based on player count
  const bossHp = sessionPlayers.length * 50;
  const bossName = `The Shadow Lord`;

  bossFights.set(sessionId, {
    bossHp,
    bossMaxHp: bossHp,
    bossName,
    roundNumber: 1,
    playerIndex: 0,
    deadPlayers: new Set(),
  });

  // Create the boss event
  await gameEvents.createGameEvent({
    sessionId,
    eventNumber,
    title: `⚔️ BOSS: ${bossName}`,
    narrative: `${bossName} appears! HP: ${bossHp}/${bossHp}. All heroes must fight!`,
    actionRequired: 'dice_roll',
    targetPlayerId: sessionPlayers[0]?.playerId,
    diceType: BOSS_DICE_TYPE,
  });

  // Broadcast counter update
  sseManager.emit(sessionId, 'state_update', {
    currentEvent: eventNumber,
    totalEvents: session.totalEvents,
  });

  // Broadcast boss narrative
  await emitNarrative(sessionId, eventNumber, {
    text: `🔥 ${bossName} emerges from the darkness! HP: ${bossHp}/${bossHp}. Each hero must strike — roll well or suffer the consequences!`,
    title: `⚔️ BOSS FIGHT: ${bossName}`,
    isBossFight: true,
    bossHp,
    bossMaxHp: bossHp,
  });

  setStep(sessionId, {
    phase: 'narrating',
    encounter: 'boss',
    title: `Boss Fight: ${bossName}`,
    detail: `${bossName} emerges from the darkness. Every hero must fight.`,
    eventNumber,
    totalEvents: session.totalEvents,
    roundNumber: 1,
    enemyName: bossName,
    enemyHp: bossHp,
    enemyMaxHp: bossHp,
    lastRoll: null,
  });

  // Request first player's roll
  await requestBossRoll(sessionId);
}

/**
 * Request the next roll in a boss fight.
 */
async function requestBossRoll(sessionId: string): Promise<void> {
  const boss = bossFights.get(sessionId);
  if (!boss) return;

  const sessionPlayers = await players.getSessionPlayers(sessionId);
  const state = await gameState.getGameState(sessionId);
  if (!state) return;
  const session = await gameSessions.getGameSession(sessionId);

  // Find the next hero still standing (persisted HP is authoritative).
  const isOut = (idx: number) =>
    boss.deadPlayers.has(sessionPlayers[idx]?.playerId) || isDowned(state, sessionPlayers[idx], idx);

  let attempts = 0;
  while (isOut(boss.playerIndex) && attempts < sessionPlayers.length) {
    boss.playerIndex = (boss.playerIndex + 1) % sessionPlayers.length;
    attempts++;
  }

  // All players down?
  if (isOut(boss.playerIndex)) {
    await endBossFight(sessionId, false);
    return;
  }

  const activePlayer = sessionPlayers[boss.playerIndex];
  const character = resolveCharacter(state, activePlayer, boss.playerIndex);

  await gameState.setWaitingForDice(sessionId, true);
  await gameState.updateTurn(sessionId, activePlayer.playerId, boss.roundNumber);

  const reason = `${character?.name || activePlayer.playerName} attacks ${boss.bossName}!`;

  setStep(sessionId, {
    phase: 'awaiting_roll',
    encounter: 'boss',
    title: `Boss Fight: ${boss.bossName}`,
    detail: reason,
    eventNumber: session?.currentEvent ?? 0,
    totalEvents: session?.totalEvents ?? 0,
    activePlayerId: activePlayer.playerId,
    activePlayerName: activePlayer.playerName,
    characterName: character?.name,
    characterClass: character?.class,
    characterStats: character?.stats || null,
    diceType: BOSS_DICE_TYPE,
    roundNumber: boss.roundNumber,
    enemyName: boss.bossName,
    enemyHp: boss.bossHp,
    enemyMaxHp: boss.bossMaxHp,
  });

  sseManager.emit(sessionId, 'dice_request', {
    targetPlayerId: activePlayer.playerId,
    targetPlayerName: activePlayer.playerName,
    characterName: character?.name || activePlayer.playerName,
    characterClass: character?.class || 'Adventurer',
    characterStats: character?.stats || null,
    diceType: BOSS_DICE_TYPE,
    reason: `${reason} (Boss HP: ${boss.bossHp}/${boss.bossMaxHp})`,
    attemptNumber: boss.roundNumber,
    eventNumber: session?.currentEvent ?? 0,
    totalEvents: session?.totalEvents ?? 0,
    isBossFight: true,
    roundNumber: boss.roundNumber,
    enemyName: boss.bossName,
    bossHp: boss.bossHp,
    bossMaxHp: boss.bossMaxHp,
    enemyHp: boss.bossHp,
    enemyMaxHp: boss.bossMaxHp,
  });
}

/**
 * Handle a dice result from a player (or the dice agent).
 */
export async function handleDiceResult(
  sessionId: string,
  diceResult: DiceResultInput
): Promise<void> {
  const state = await gameState.getGameState(sessionId);
  if (!state) throw new Error('Game state not found');

  if (!state.waitingForDice) {
    throw new Error('Game is not waiting for a dice roll');
  }

  const session = await gameSessions.getGameSession(sessionId);
  if (!session) throw new Error('Session not found');

  const eventNumber = session.currentEvent;
  const sessionPlayers = await players.getSessionPlayers(sessionId);

  // Record the dice result
  await gameEvents.recordDiceResult(sessionId, eventNumber, diceResult.rollValue);
  await gameState.setWaitingForDice(sessionId, false);

  const targetPlayer = sessionPlayers.find(
    (p) => p.playerId === state.currentTurnPlayerId
  );

  // Get the player's live character (persisted stats win over the lore template)
  const character = resolveCharacter(
    state,
    targetPlayer,
    targetPlayer ? sessionPlayers.indexOf(targetPlayer) : 0
  );

  // === COMBAT ENCOUNTER HANDLING ===
  if (combatEncounters.has(sessionId)) {
    await handleCombatDiceResult(sessionId, diceResult, targetPlayer, character);
    return;
  }

  // === BOSS FIGHT HANDLING ===
  if (bossFights.has(sessionId)) {
    await handleBossDiceResult(sessionId, diceResult, targetPlayer, character);
    return;
  }

  // === NORMAL EVENT HANDLING ===
  const eventOutline = state.worldLore.eventOutlines.find(
    (e) => e.eventNumber === eventNumber
  );
  const outcome = interpretDiceResult(diceResult.rollValue, diceResult.diceType, eventOutline?.difficulty || 'medium');

  // Calculate stat changes based on roll
  const statChanges = calculateStatChanges(diceResult.rollValue, diceResult.diceType, targetPlayer?.playerId || '');

  // Persist them so the character sheet actually reflects the outcome.
  const updatedStats = await applyStatChanges(sessionId, state, statChanges);
  const liveStats = (targetPlayer && updatedStats[targetPlayer.playerId]) || character?.stats || null;

  // Complete the event with outcome and stat changes
  await gameEvents.completeEvent(sessionId, eventNumber, {
    outcome,
    statChanges,
  });

  // Broadcast dice result with character info and stat changes
  sseManager.emit(sessionId, 'dice_result', {
    playerId: state.currentTurnPlayerId,
    playerName: targetPlayer?.playerName || 'Unknown',
    characterName: character?.name || 'Unknown',
    characterClass: character?.class || 'Adventurer',
    characterStats: liveStats,
    diceType: diceResult.diceType,
    rollValue: diceResult.rollValue,
    maxValue: diceFaces(diceResult.diceType),
    source: diceResult.source,
    outcome,
    reason: eventOutline?.title || 'Fate decides...',
    difficulty: eventOutline?.difficulty || 'medium',
    statChanges,
    updatedStats,
    eventNumber,
    totalEvents: session.totalEvents,
  });

  setStep(sessionId, {
    phase: 'resolving',
    encounter: 'none',
    title: eventOutline?.title || `Event ${eventNumber}`,
    detail: outcome,
    eventNumber,
    totalEvents: session.totalEvents,
    activePlayerId: targetPlayer?.playerId,
    activePlayerName: targetPlayer?.playerName,
    characterName: character?.name,
    characterClass: character?.class,
    characterStats: liveStats,
    diceType: diceResult.diceType,
    lastRoll: {
      playerName: targetPlayer?.playerName || 'Unknown',
      characterName: character?.name || 'Unknown',
      rollValue: diceResult.rollValue,
      maxValue: diceFaces(diceResult.diceType),
      outcome,
    },
  });

  console.log(`[GameLoop] ${character?.name}: rolled ${diceResult.rollValue} → ${outcome} | stat changes: ${JSON.stringify(statChanges)}`);

  // Broadcast state update with new event counter
  sseManager.emit(sessionId, 'state_update', {
    eventNumber,
    outcome,
    rollValue: diceResult.rollValue,
    currentEvent: session.currentEvent,
    totalEvents: session.totalEvents,
  });

  // Hold the result on screen, then advance
  setTimeout(() => advanceToNextEvent(sessionId), DICE_RESULT_DISPLAY_MS);
}

/**
 * Handle dice result during boss fight.
 */
async function handleBossDiceResult(
  sessionId: string,
  diceResult: DiceResultInput,
  targetPlayer: Player | undefined,
  character: Character | undefined
): Promise<void> {
  const boss = bossFights.get(sessionId);
  if (!boss) return;

  const state = await gameState.getGameState(sessionId);
  const session = await gameSessions.getGameSession(sessionId);

  const rollValue = diceResult.rollValue;
  const maxValue = diceFaces(diceResult.diceType);
  const charName = character?.name || targetPlayer?.playerName || 'Hero';

  let damage = 0;
  let outcome = '';
  let statChanges: StatChange[] = [];
  let playerDied = false;

  if (rollValue >= maxValue * 0.9) {
    // Crit — massive damage to boss
    damage = 25;
    outcome = `⚡ Critical hit! ${charName} deals ${damage} damage to ${boss.bossName}!`;
    statChanges = [{ playerId: targetPlayer?.playerId || '', stat: 'str', delta: 1 }];
  } else if (rollValue >= maxValue * 0.5) {
    // Success — solid hit
    damage = 15;
    outcome = `✅ ${charName} strikes ${boss.bossName} for ${damage} damage!`;
  } else if (rollValue >= maxValue * 0.25) {
    // Partial — glancing blow + take damage
    damage = 5;
    outcome = `⚠️ ${charName} lands a weak blow (${damage} dmg) but takes a hit! -10 HP`;
    statChanges = [{ playerId: targetPlayer?.playerId || '', stat: 'hp', delta: -10 }];
  } else if (rollValue > 1) {
    // Fail — miss + heavy damage
    damage = 0;
    outcome = `❌ ${charName} misses! ${boss.bossName} retaliates! -25 HP`;
    statChanges = [{ playerId: targetPlayer?.playerId || '', stat: 'hp', delta: -25 }];
  } else {
    // Crit fail — character dies
    damage = 0;
    outcome = `💀 Critical failure! ${charName} is struck down by ${boss.bossName}!`;
    statChanges = [{ playerId: targetPlayer?.playerId || '', stat: 'hp', delta: -999 }];
    playerDied = true;
    if (targetPlayer) boss.deadPlayers.add(targetPlayer.playerId);
  }

  // Persist the stat changes so the character sheet actually updates.
  const updatedStats = state ? await applyStatChanges(sessionId, state, statChanges) : {};
  const liveStats = (targetPlayer && updatedStats[targetPlayer.playerId]) || character?.stats || null;

  if (liveStats && liveStats.hp <= 0 && targetPlayer) {
    boss.deadPlayers.add(targetPlayer.playerId);
    playerDied = true;
  }

  // Apply damage to boss
  boss.bossHp = Math.max(0, boss.bossHp - damage);

  // Broadcast the result
  sseManager.emit(sessionId, 'dice_result', {
    playerId: targetPlayer?.playerId || '',
    playerName: targetPlayer?.playerName || 'Unknown',
    characterName: charName,
    characterClass: character?.class || 'Adventurer',
    characterStats: liveStats,
    diceType: diceResult.diceType,
    rollValue,
    maxValue,
    source: diceResult.source,
    outcome,
    reason: `Attack ${boss.bossName}`,
    difficulty: 'hard',
    statChanges,
    updatedStats,
    isBossFight: true,
    roundNumber: boss.roundNumber,
    enemyName: boss.bossName,
    bossHp: boss.bossHp,
    bossMaxHp: boss.bossMaxHp,
    enemyHp: boss.bossHp,
    enemyMaxHp: boss.bossMaxHp,
    playerDied,
  });

  setStep(sessionId, {
    phase: 'resolving',
    encounter: 'boss',
    title: `Boss Fight: ${boss.bossName}`,
    detail: outcome,
    eventNumber: session?.currentEvent ?? 0,
    totalEvents: session?.totalEvents ?? 0,
    characterName: charName,
    characterClass: character?.class,
    characterStats: liveStats,
    roundNumber: boss.roundNumber,
    enemyName: boss.bossName,
    enemyHp: boss.bossHp,
    enemyMaxHp: boss.bossMaxHp,
    lastRoll: {
      playerName: targetPlayer?.playerName || 'Unknown',
      characterName: charName,
      rollValue,
      maxValue,
      outcome,
    },
  });

  console.log(`[BossFight] ${charName}: rolled ${rollValue} → ${damage} dmg → Boss HP: ${boss.bossHp}/${boss.bossMaxHp}`);

  // Check if boss is dead
  if (boss.bossHp <= 0) {
    await endBossFight(sessionId, true);
    return;
  }

  // Move to next player
  boss.playerIndex = (boss.playerIndex + 1) % (await players.getSessionPlayers(sessionId)).length;

  // Check if we've gone around — new round
  const sessionPlayers = await players.getSessionPlayers(sessionId);
  if (boss.playerIndex === 0) {
    boss.roundNumber++;
  }

  // Hold this round's result on screen, then request the next roll
  setTimeout(() => requestBossRoll(sessionId), COMBAT_ROLL_DISPLAY_MS);
}

/**
 * End the boss fight.
 */
async function endBossFight(sessionId: string, playersWon: boolean): Promise<void> {
  const boss = bossFights.get(sessionId);
  const session = await gameSessions.getGameSession(sessionId);
  if (!session) return;

  // Complete the boss event
  await gameEvents.completeEvent(sessionId, session.currentEvent, {
    outcome: playersWon
      ? `Victory! ${boss?.bossName || 'The Boss'} has been defeated!`
      : `Defeat... All heroes have fallen to ${boss?.bossName || 'The Boss'}.`,
  });

  bossFights.delete(sessionId);

  // Emit boss defeat/victory
  await emitNarrative(sessionId, session.currentEvent, {
    text: playersWon
      ? `🏆 ${boss?.bossName || 'The Boss'} falls! The heroes are victorious!`
      : `💀 All heroes have fallen. ${boss?.bossName || 'The Boss'} reigns supreme.`,
    title: playersWon ? '🏆 VICTORY!' : '💀 DEFEAT',
    isBossFight: true,
    bossHp: 0,
    bossMaxHp: boss?.bossMaxHp || 100,
  });

  // End the game — a boss-fight loss means the party was wiped.
  setTimeout(() => endGame(sessionId, playersWon ? 'completed' : 'wipe'), ENCOUNTER_END_DISPLAY_MS);
}

/**
 * Calculate stat changes based on dice roll.
 */
function calculateStatChanges(rollValue: number, diceType: string, playerId: string): StatChange[] {
  const maxValue = diceFaces(diceType);
  const ratio = rollValue / maxValue;

  if (ratio >= 0.9) {
    // Crit success: gain HP and a random stat
    return [
      { playerId, stat: 'hp', delta: 5 },
      { playerId, stat: 'str', delta: 1 },
    ];
  } else if (ratio >= 0.5) {
    // Success: small HP gain
    return [{ playerId, stat: 'hp', delta: 2 }];
  } else if (ratio >= 0.25) {
    // Partial: minor HP loss
    return [{ playerId, stat: 'hp', delta: -3 }];
  } else if (ratio > 0.05) {
    // Failure: HP loss
    return [{ playerId, stat: 'hp', delta: -8 }];
  } else {
    // Crit fail: big HP loss
    return [{ playerId, stat: 'hp', delta: -15 }];
  }
}

/**
 * Interpret a dice result based on the roll value and difficulty.
 */
function interpretDiceResult(rollValue: number, diceType: string, difficulty: string): string {
  const maxValue = diceFaces(diceType);
  const ratio = rollValue / maxValue;

  const thresholds = {
    easy: 0.3,
    medium: 0.5,
    hard: 0.7,
  };

  const threshold = thresholds[difficulty as keyof typeof thresholds] || 0.5;

  if (ratio >= 0.9) return 'Critical success! Outstanding result.';
  if (ratio >= threshold) return 'Success! The adventurer prevails.';
  if (ratio >= threshold * 0.5) return 'Partial success. The outcome is mixed.';
  if (ratio > 0.1) return 'Failure. Things do not go as planned.';
  return 'Critical failure! A disastrous outcome.';
}

/**
 * End the game with a journey recap.
 */
async function endGame(sessionId: string, outcome: 'completed' | 'wipe' = 'completed'): Promise<void> {
  activeGames.delete(sessionId);
  await gameSessions.updateSessionStatus(sessionId, 'completed');

  // A downed party should not leave a half-finished fight running.
  combatEncounters.delete(sessionId);
  bossFights.delete(sessionId);

  const sessionPlayers = await players.getSessionPlayers(sessionId);
  const allEvents = await gameEvents.getSessionEvents(sessionId);
  const state = await gameState.getGameState(sessionId);

  // Build journey recap
  let recap = outcome === 'wipe'
    ? '💀 THE PARTY HAS FALLEN\n\nEvery hero was downed before the journey could be completed.\n\n📖 JOURNEY RECAP\n\n'
    : '📖 JOURNEY RECAP\n\n';
  for (const evt of allEvents) {
    const player = sessionPlayers.find(p => p.playerId === evt.targetPlayerId);
    const char = player?.character || state?.worldLore.suggestedCharacters.find(c => c.id === player?.character?.id);
    const charName = char?.name || player?.playerName || 'Hero';
    recap += `Event ${evt.eventNumber}: ${evt.title}\n`;
    recap += `  ${charName} rolled ${evt.diceResult || '?'} → ${evt.outcome || 'Unknown'}\n`;
    if (evt.statChanges && evt.statChanges.length > 0) {
      recap += `  Stats: ${evt.statChanges.map(s => `${s.stat} ${s.delta > 0 ? '+' : ''}${s.delta}`).join(', ')}\n`;
    }
    recap += '\n';
  }

  // Broadcast recap as narrative. The recap body is a stat table, so narrate a
  // short spoken closing instead of reading every row aloud.
  const spokenClosing = outcome === 'wipe'
    ? `The party has fallen. Every hero was downed after ${allEvents.length} events. The tale ends here.`
    : `The journey is complete. Your party survived ${allEvents.length} events. The tale of this adventure ends here.`;
  await emitNarrative(sessionId, 999, {
    text: recap,
    title: outcome === 'wipe' ? '💀 The Party Has Fallen' : '📖 Journey Recap',
  }, spokenClosing);

  // Broadcast game over
  sseManager.emit(sessionId, 'game_over', {
    summary: recap,
    outcome,
    totalTurns: allEvents.length,
    playerStats: sessionPlayers.map((p) => ({
      playerId: p.playerId,
      playerName: p.playerName,
      finalStats: p.character?.stats || {},
    })),
  });

  setStep(sessionId, {
    phase: 'complete',
    encounter: 'none',
    title: outcome === 'wipe' ? 'The Party Has Fallen' : 'Adventure Complete',
    detail: outcome === 'wipe'
      ? `Every hero was downed after ${allEvents.length} events.`
      : `The journey ends after ${allEvents.length} events.`,
    totalEvents: allEvents.length,
    roundNumber: undefined,
    enemyName: undefined,
    enemyHp: undefined,
    enemyMaxHp: undefined,
  });

  console.log(`[GameLoop] Game ${sessionId} ended (${outcome})`);
}

/**
 * Check if a game is currently running.
 */
export function isGameRunning(sessionId: string): boolean {
  return activeGames.get(sessionId)?.running || false;
}
