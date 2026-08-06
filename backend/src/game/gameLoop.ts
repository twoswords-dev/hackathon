import { gameSessions, players, gameEvents, gameState } from '../db';
import { generateNarrative, DMResponse } from '../agents/dungeonMaster';
import { sseManager } from '../sse';
import { DiceResultInput, GameState, Player, StatChange } from '../types/game';

// Track active game loops
const activeGames = new Map<string, { running: boolean }>();

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
  roundNumber: number;
  playerIndex: number;
  deadPlayers: Set<string>;
}>();

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

  // === JOURNEY SUMMARY (opening) ===
  const journeySummary = buildJourneySummary(state, sessionPlayers);
  sseManager.emit(sessionId, 'narrative', {
    text: journeySummary,
    eventNumber: 0,
    title: '📖 The Journey Begins',
  });

  // Brief pause then start first event
  setTimeout(() => advanceToNextEvent(sessionId), 2000);
}

/**
 * Build a journey summary from lore data.
 */
function buildJourneySummary(state: GameState, sessionPlayers: Player[]): string {
  const lore = state.worldLore;
  let summary = `Welcome to ${lore.worldName}. ${lore.worldDescription}\n\n`;
  summary += `Your party:\n`;
  for (const p of sessionPlayers) {
    const char = lore.suggestedCharacters.find(c => c.id === p.character?.id) || lore.suggestedCharacters[0];
    if (char) {
      summary += `• ${char.name} (${char.race} ${char.class}) — HP:${char.stats.hp} STR:${char.stats.str} DEX:${char.stats.dex}\n`;
    } else {
      summary += `• ${p.playerName} — ready for adventure\n`;
    }
  }
  summary += `\n${lore.eventOutlines.length} challenges await. The final battle will test you all.`;
  return summary;
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

  // Pick the player for this event (rotate)
  const sessionPlayers = await players.getSessionPlayers(sessionId);
  const playerIndex = (nextEventNumber - 1) % sessionPlayers.length;
  const activePlayer = sessionPlayers[playerIndex];

  // Get their character
  const character = state.worldLore.suggestedCharacters.find(
    c => c.id === activePlayer?.character?.id
  ) || state.worldLore.suggestedCharacters[playerIndex % state.worldLore.suggestedCharacters.length];

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
  character: { name: string; class: string; stats: { hp: number; maxHp: number; str: number; dex: number; int: number; wis: number; cha: number; con: number } }
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
    diceType: dmResponse.dice_type || eventOutline.requiredDiceType || 'd20',
  });

  // Update game state
  await gameState.updateLastNarrative(sessionId, dmResponse.narrative_text);
  await gameState.setWaitingForDice(sessionId, true);

  // Update current turn player
  await gameState.updateTurn(sessionId, activePlayer.playerId, state.turnNumber + 1);

  // Broadcast narrative with character info
  sseManager.emit(sessionId, 'narrative', {
    text: dmResponse.narrative_text,
    eventNumber,
    title: eventOutline.title,
    characterName: character.name,
    characterClass: character.class,
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
  const diceType = dmResponse.dice_type || eventOutline.requiredDiceType || 'd20';
  sseManager.emit(sessionId, 'dice_request', {
    targetPlayerId: activePlayer.playerId,
    targetPlayerName: activePlayer.playerName,
    characterName: character.name,
    characterClass: character.class,
    characterStats: character.stats,
    diceType,
    reason: dmResponse.dice_reason || `${character.name} must face this challenge!`,
    attemptNumber: 1,
  });

  console.log(`[GameLoop] Event ${eventNumber}: ${character.name} (${activePlayer.playerName}) rolls ${diceType}`);
}

/**
 * Start a combat encounter for a mid-game event.
 */
async function startCombatEncounter(
  sessionId: string,
  eventNumber: number,
  eventOutline: { enemyName?: string; enemyHp?: number; title: string },
  sessionPlayers: Player[],
  state: GameState
): Promise<void> {
  const enemyHp = eventOutline.enemyHp || sessionPlayers.length * 30;
  const enemyName = eventOutline.enemyName || 'Enemy';

  combatEncounters.set(sessionId, {
    enemyHp,
    enemyMaxHp: enemyHp,
    enemyName,
    eventNumber,
    roundNumber: 1,
    playerIndex: 0,
    deadPlayers: new Set(),
  });

  console.log(`[Combat] Starting encounter: ${enemyName} (HP: ${enemyHp}) at event ${eventNumber}`);

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

  // Find next alive player
  let attempts = 0;
  while (combat.deadPlayers.has(sessionPlayers[combat.playerIndex]?.playerId) && attempts < sessionPlayers.length) {
    combat.playerIndex = (combat.playerIndex + 1) % sessionPlayers.length;
    attempts++;
  }

  // All players dead? End combat as loss
  if (attempts >= sessionPlayers.length || combat.deadPlayers.size >= sessionPlayers.length) {
    await endCombatEncounter(sessionId, false);
    return;
  }

  const activePlayer = sessionPlayers[combat.playerIndex];
  const character = state.worldLore.suggestedCharacters.find(
    c => c.id === activePlayer?.character?.id
  ) || state.worldLore.suggestedCharacters[combat.playerIndex % state.worldLore.suggestedCharacters.length];

  await gameState.setWaitingForDice(sessionId, true);
  await gameState.updateTurn(sessionId, activePlayer.playerId, combat.roundNumber);

  sseManager.emit(sessionId, 'dice_request', {
    targetPlayerId: activePlayer.playerId,
    targetPlayerName: activePlayer.playerName,
    characterName: character?.name || activePlayer.playerName,
    characterClass: character?.class || 'Adventurer',
    characterStats: character?.stats || null,
    diceType: 'd20',
    reason: `${character?.name || activePlayer.playerName} attacks ${combat.enemyName}! (Enemy HP: ${combat.enemyHp}/${combat.enemyMaxHp})`,
    attemptNumber: combat.roundNumber,
    isCombat: true,
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
  character: { name: string; class: string; stats: { hp: number; maxHp: number; str: number; dex: number; int: number; wis: number; cha: number; con: number } } | undefined
): Promise<void> {
  const combat = combatEncounters.get(sessionId);
  if (!combat) return;

  const rollValue = diceResult.rollValue;
  const maxValue = parseInt(diceResult.diceType.replace('d', ''));
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

  // Apply damage to enemy
  combat.enemyHp = Math.max(0, combat.enemyHp - damage);

  // Broadcast the result
  sseManager.emit(sessionId, 'dice_result', {
    playerId: targetPlayer?.playerId || '',
    playerName: targetPlayer?.playerName || 'Unknown',
    characterName: charName,
    characterClass: character?.class || 'Adventurer',
    characterStats: character?.stats || null,
    diceType: diceResult.diceType,
    rollValue,
    maxValue,
    source: diceResult.source,
    outcome,
    reason: `Attack ${combat.enemyName}`,
    difficulty: 'medium',
    statChanges,
    isCombat: true,
    enemyHp: combat.enemyHp,
    enemyMaxHp: combat.enemyMaxHp,
    enemyName: combat.enemyName,
    playerDied,
    isCrit: rollValue >= maxValue * 0.9,
    critDamage: rollValue >= maxValue * 0.9 ? damage : undefined,
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

  // Request next roll after brief pause
  setTimeout(() => requestCombatRoll(sessionId), 1500);
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
  sseManager.emit(sessionId, 'narrative', {
    text: playersWon
      ? `⚔️ ${combat.enemyName} falls! The heroes are victorious! (${combat.enemyMaxHp} HP dealt)`
      : `💀 A hero has fallen to ${combat.enemyName}. The remaining party steels themselves and moves on.`,
    eventNumber: combat.eventNumber,
    title: playersWon ? `⚔️ Victory: ${combat.enemyName} Defeated` : `💀 Fallen to ${combat.enemyName}`,
    isCombat: true,
    enemyHp: 0,
    enemyMaxHp: combat.enemyMaxHp,
  });

  combatEncounters.delete(sessionId);

  // Continue to next event (game doesn't end on mid-combat death, only boss)
  setTimeout(() => advanceToNextEvent(sessionId), 2000);
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
    diceType: 'd20',
  });

  // Broadcast counter update
  sseManager.emit(sessionId, 'state_update', {
    currentEvent: eventNumber,
    totalEvents: session.totalEvents,
  });

  // Broadcast boss narrative
  sseManager.emit(sessionId, 'narrative', {
    text: `🔥 ${bossName} emerges from the darkness! HP: ${bossHp}/${bossHp}. Each hero must strike — roll well or suffer the consequences!`,
    eventNumber,
    title: `⚔️ BOSS FIGHT: ${bossName}`,
    isBossFight: true,
    bossHp,
    bossMaxHp: bossHp,
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

  // Find next alive player
  let attempts = 0;
  while (boss.deadPlayers.has(sessionPlayers[boss.playerIndex]?.playerId) && attempts < sessionPlayers.length) {
    boss.playerIndex = (boss.playerIndex + 1) % sessionPlayers.length;
    attempts++;
  }

  // All players dead?
  if (attempts >= sessionPlayers.length || boss.deadPlayers.size >= sessionPlayers.length) {
    await endBossFight(sessionId, false);
    return;
  }

  const activePlayer = sessionPlayers[boss.playerIndex];
  const character = state.worldLore.suggestedCharacters.find(
    c => c.id === activePlayer?.character?.id
  ) || state.worldLore.suggestedCharacters[boss.playerIndex % state.worldLore.suggestedCharacters.length];

  await gameState.setWaitingForDice(sessionId, true);
  await gameState.updateTurn(sessionId, activePlayer.playerId, boss.roundNumber);

  sseManager.emit(sessionId, 'dice_request', {
    targetPlayerId: activePlayer.playerId,
    targetPlayerName: activePlayer.playerName,
    characterName: character?.name || activePlayer.playerName,
    characterClass: character?.class || 'Adventurer',
    characterStats: character?.stats || null,
    diceType: 'd20',
    reason: `${character?.name || activePlayer.playerName} attacks ${boss.bossName}! (Boss HP: ${boss.bossHp}/${boss.bossMaxHp})`,
    attemptNumber: boss.roundNumber,
    isBossFight: true,
    bossHp: boss.bossHp,
    bossMaxHp: boss.bossMaxHp,
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

  // Get character info
  const character = state.worldLore.suggestedCharacters.find(
    c => c.id === targetPlayer?.character?.id
  ) || state.worldLore.suggestedCharacters[0];

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
    characterStats: character?.stats || null,
    diceType: diceResult.diceType,
    rollValue: diceResult.rollValue,
    maxValue: parseInt(diceResult.diceType.replace('d', '')),
    source: diceResult.source,
    outcome,
    reason: eventOutline?.title || 'Fate decides...',
    difficulty: eventOutline?.difficulty || 'medium',
    statChanges,
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

  // Advance to next event after brief pause
  setTimeout(() => advanceToNextEvent(sessionId), 2000);
}

/**
 * Handle dice result during boss fight.
 */
async function handleBossDiceResult(
  sessionId: string,
  diceResult: DiceResultInput,
  targetPlayer: Player | undefined,
  character: { name: string; class: string; stats: { hp: number; maxHp: number; str: number; dex: number; int: number; wis: number; cha: number; con: number } } | undefined
): Promise<void> {
  const boss = bossFights.get(sessionId);
  if (!boss) return;

  const rollValue = diceResult.rollValue;
  const maxValue = parseInt(diceResult.diceType.replace('d', ''));
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

  // Apply damage to boss
  boss.bossHp = Math.max(0, boss.bossHp - damage);

  // Broadcast the result
  sseManager.emit(sessionId, 'dice_result', {
    playerId: targetPlayer?.playerId || '',
    playerName: targetPlayer?.playerName || 'Unknown',
    characterName: charName,
    characterClass: character?.class || 'Adventurer',
    characterStats: character?.stats || null,
    diceType: diceResult.diceType,
    rollValue,
    maxValue,
    source: diceResult.source,
    outcome,
    reason: `Attack ${boss.bossName}`,
    difficulty: 'hard',
    statChanges,
    isBossFight: true,
    bossHp: boss.bossHp,
    bossMaxHp: boss.bossMaxHp,
    playerDied,
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

  // Request next roll after brief pause
  setTimeout(() => requestBossRoll(sessionId), 1500);
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
  sseManager.emit(sessionId, 'narrative', {
    text: playersWon
      ? `🏆 ${boss?.bossName || 'The Boss'} falls! The heroes are victorious!`
      : `💀 All heroes have fallen. ${boss?.bossName || 'The Boss'} reigns supreme.`,
    eventNumber: session.currentEvent,
    title: playersWon ? '🏆 VICTORY!' : '💀 DEFEAT',
    isBossFight: true,
    bossHp: 0,
    bossMaxHp: boss?.bossMaxHp || 100,
  });

  // End the game
  setTimeout(() => endGame(sessionId), 2000);
}

/**
 * Calculate stat changes based on dice roll.
 */
function calculateStatChanges(rollValue: number, diceType: string, playerId: string): StatChange[] {
  const maxValue = parseInt(diceType.replace('d', ''));
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
  const maxValue = parseInt(diceType.replace('d', ''));
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
async function endGame(sessionId: string): Promise<void> {
  activeGames.delete(sessionId);
  await gameSessions.updateSessionStatus(sessionId, 'completed');

  const sessionPlayers = await players.getSessionPlayers(sessionId);
  const allEvents = await gameEvents.getSessionEvents(sessionId);
  const state = await gameState.getGameState(sessionId);

  // Build journey recap
  let recap = '📖 JOURNEY RECAP\n\n';
  for (const evt of allEvents) {
    const player = sessionPlayers.find(p => p.playerId === evt.targetPlayerId);
    const char = state?.worldLore.suggestedCharacters.find(c => c.id === player?.character?.id);
    const charName = char?.name || player?.playerName || 'Hero';
    recap += `Event ${evt.eventNumber}: ${evt.title}\n`;
    recap += `  ${charName} rolled ${evt.diceResult || '?'} → ${evt.outcome || 'Unknown'}\n`;
    if (evt.statChanges && evt.statChanges.length > 0) {
      recap += `  Stats: ${evt.statChanges.map(s => `${s.stat} ${s.delta > 0 ? '+' : ''}${s.delta}`).join(', ')}\n`;
    }
    recap += '\n';
  }

  // Broadcast recap as narrative
  sseManager.emit(sessionId, 'narrative', {
    text: recap,
    eventNumber: 999,
    title: '📖 Journey Recap',
  });

  // Broadcast game over
  sseManager.emit(sessionId, 'game_over', {
    summary: recap,
    totalTurns: allEvents.length,
    playerStats: sessionPlayers.map((p) => ({
      playerId: p.playerId,
      playerName: p.playerName,
      finalStats: p.character?.stats || {},
    })),
  });

  console.log(`[GameLoop] Game ${sessionId} completed!`);
}

/**
 * Check if a game is currently running.
 */
export function isGameRunning(sessionId: string): boolean {
  return activeGames.get(sessionId)?.running || false;
}
