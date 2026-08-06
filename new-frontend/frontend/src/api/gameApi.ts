const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// --- Types ---

export interface CharacterStats {
  hp: number;
  maxHp: number;
  str: number;
  dex: number;
  int: number;
  wis: number;
  cha: number;
  con: number;
}

export interface Character {
  id: string;
  name: string;
  class: string;
  race: string;
  description: string;
  portraitAssetId: string;
  stats: CharacterStats;
  inventory: { id: string; name: string; type: string; quantity: number }[];
}

export interface GameSession {
  sessionId: string;
  status: 'waiting_for_players' | 'in_progress' | 'paused' | 'completed';
  gameLength: 'short' | 'medium' | 'long';
  totalEvents: number;
  currentEvent: number;
  sourceMaterial: string;
  maxPlayers: number;
}

export interface Player {
  playerId: string;
  playerName: string;
  isHost: boolean;
  character: Character | null;
}

export interface LoreSummary {
  worldName: string;
  worldDescription: string;
  locations: { id: string; name: string; description: string }[];
  factions: { id: string; name: string; description: string }[];
  suggestedCharacters: Character[];
  eventCount: number;
}

export interface CreateGameParams {
  sourceMaterial: string;
  gameLength: 'short' | 'medium' | 'long';
  playerCount: number;
  hostName: string;
  customCharacter?: CustomCharacterInput;
}

export interface CustomCharacterInput {
  name: string;
  race: string;
  class: string;
  description?: string;
}

export interface CharacterOptions {
  races: string[];
  classes: string[];
  statsByCombo: { race: string; class: string; stats: CharacterStats }[];
}

/**
 * Pixel art URL for a character within a session.
 * Falls back to building the path when portraitAssetId was not populated.
 */
export function characterPortraitUrl(sessionId: string, character: Character): string {
  return character.portraitAssetId || `/api/assets/character/${sessionId}/${character.id}/svg`;
}

/** Pixel art URL for a race/class combination, usable before a game exists. */
export function characterPreviewUrl(params: { race: string; class: string; name?: string }): string {
  const query = new URLSearchParams({ race: params.race, class: params.class });
  if (params.name) query.set('name', params.name);
  return `/api/assets/preview/character?${query.toString()}`;
}

export interface CreateGameResponse {
  sessionId: string;
  session: GameSession;
  player: Player;
  lore: LoreSummary;
}

export interface GameDetails {
  session: GameSession;
  players: Player[];
  lore: LoreSummary | null;
  map: unknown;
}

export interface DiceRequestData {
  targetPlayerId: string;
  targetPlayerName: string;
  characterName: string;
  characterClass: string;
  characterStats: CharacterStats | null;
  diceType: string;
  reason: string;
  attemptNumber: number;
  eventNumber?: number;
  totalEvents?: number;
  eventTitle?: string;
  difficulty?: string;
  isCombat?: boolean;
  roundNumber?: number;
  enemyName?: string;
  enemyHp?: number;
  enemyMaxHp?: number;
  isBossFight?: boolean;
  bossHp?: number;
  bossMaxHp?: number;
}

/**
 * Authoritative description of what the game is currently waiting on.
 * Emitted by the backend as `step_update` and also returned by /state so the
 * panel stays correct across reconnects.
 */
export interface GameStepInfo {
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
  lastRoll?: {
    playerName: string;
    characterName: string;
    rollValue: number;
    maxValue: number;
    outcome: string;
  } | null;
  updatedAt: string;
}

export interface StatChange {
  playerId: string;
  stat: string;
  delta: number;
}

export interface NarrativeHistoryEntry {
  text: string;
  eventNumber: number;
  title: string;
  diceResult: number | null;
  diceType: string | null;
  outcome: string | null;
  actionRequired: string;
  isComplete: boolean;
  statChanges?: StatChange[];
  targetPlayerId?: string;
}

export interface GameLoopState {
  status: string;
  currentEvent: number;
  totalEvents: number;
  waitingForDice: boolean;
  diceRequest: DiceRequestData | null;
  step: GameStepInfo | null;
  narrativeHistory: NarrativeHistoryEntry[];
  lastNarrative: string;
  currentTurnPlayerId: string;
  turnNumber: number;
  gameRunning: boolean;
}

export interface DiceResultData {
  playerId: string;
  playerName: string;
  characterName: string;
  characterClass: string;
  characterStats: CharacterStats | null;
  diceType: string;
  rollValue: number;
  maxValue: number;
  source: string;
  outcome: string;
  reason: string;
  difficulty: string;
  statChanges: StatChange[];
  /** Post-change stats keyed by playerId, authoritative after persistence. */
  updatedStats?: Record<string, CharacterStats>;
  eventNumber?: number;
  totalEvents?: number;
  isCombat?: boolean;
  roundNumber?: number;
  enemyName?: string;
  enemyHp?: number;
  enemyMaxHp?: number;
  isBossFight?: boolean;
  bossHp?: number;
  bossMaxHp?: number;
  playerDied?: boolean;
}

export interface GameOverData {
  summary: string;
  outcome?: 'completed' | 'wipe';
  totalTurns: number;
  playerStats: { playerId: string; playerName: string; finalStats: Record<string, number> }[];
}

// --- API Functions ---

export async function createGame(params: CreateGameParams): Promise<CreateGameResponse> {
  return request('/game/create', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function getGame(sessionId: string): Promise<GameDetails> {
  return request(`/game/${sessionId}`);
}

export async function joinGame(sessionId: string, playerName: string): Promise<{ player: Player; session: GameSession }> {
  return request(`/game/${sessionId}/join`, {
    method: 'POST',
    body: JSON.stringify({ playerName }),
  });
}

export async function startGame(sessionId: string): Promise<{ success: boolean }> {
  return request(`/game/${sessionId}/start`, { method: 'POST' });
}

export async function submitDiceResult(sessionId: string, diceType: string, rollValue: number, source: 'physical' | 'virtual'): Promise<unknown> {
  return request(`/game/${sessionId}/dice-result`, {
    method: 'POST',
    body: JSON.stringify({ diceType, rollValue, source }),
  });
}

export async function rollVirtualDice(sessionId: string, diceType: string): Promise<{ rollValue: number }> {
  return request(`/game/${sessionId}/dice-virtual`, {
    method: 'POST',
    body: JSON.stringify({ diceType }),
  });
}

export async function getGameState(sessionId: string): Promise<GameLoopState> {
  return request(`/game/${sessionId}/state`);
}

export async function getCharacterOptions(): Promise<CharacterOptions> {
  return request('/game/character-options');
}

export async function selectCharacter(
  sessionId: string,
  playerId: string,
  characterId: string
): Promise<{ player: Player }> {
  return request(`/game/${sessionId}/select-character`, {
    method: 'POST',
    body: JSON.stringify({ playerId, characterId }),
  });
}
