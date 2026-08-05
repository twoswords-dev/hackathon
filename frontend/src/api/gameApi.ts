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

// Game API

export interface CreateGameParams {
  sourceMaterial: string;
  gameLength: 'short' | 'medium' | 'long';
  playerCount: number;
  hostName: string;
}

export interface GameSession {
  sessionId: string;
  status: string;
  gameLength: string;
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

export interface Character {
  id: string;
  name: string;
  class: string;
  race: string;
  description: string;
  portraitAssetId: string;
  stats: {
    hp: number;
    maxHp: number;
    str: number;
    dex: number;
    int: number;
    wis: number;
    cha: number;
    con: number;
  };
  inventory: { id: string; name: string; type: string; quantity: number }[];
}

export interface LoreSummary {
  worldName: string;
  worldDescription: string;
  locations: { id: string; name: string; description: string }[];
  factions: { id: string; name: string; description: string }[];
  suggestedCharacters: Character[];
  eventCount: number;
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

export interface GameLoopState {
  status: string;
  currentEvent: number;
  totalEvents: number;
  waitingForDice: boolean;
  diceRequest: {
    targetPlayerId: string;
    targetPlayerName: string;
    characterName: string;
    characterClass: string;
    characterStats: {
      hp: number;
      maxHp: number;
      str: number;
      dex: number;
      int: number;
      wis: number;
      cha: number;
      con: number;
    } | null;
    diceType: string;
    reason: string;
    attemptNumber: number;
  } | null;
  narrativeHistory: {
    text: string;
    eventNumber: number;
    title: string;
    diceResult: number | null;
    diceType: string | null;
    outcome: string | null;
    actionRequired: string;
    isComplete: boolean;
    statChanges?: { playerId: string; stat: string; delta: number }[];
    targetPlayerId?: string;
  }[];
  lastNarrative: string;
  currentTurnPlayerId: string;
  turnNumber: number;
  gameRunning: boolean;
}

export async function getGameState(sessionId: string): Promise<GameLoopState> {
  return request(`/game/${sessionId}/state`);
}
