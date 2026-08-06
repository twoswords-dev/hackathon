/**
 * SSE Event types for the Gen DND game engine.
 * These events are pushed from the server to connected clients via Server-Sent Events.
 */

export type SSEEventType =
  | 'narrative'
  | 'dice_request'
  | 'dice_result'
  | 'state_update'
  | 'step_update'
  | 'turn_change'
  | 'map_update'
  | 'player_joined'
  | 'player_left'
  | 'game_started'
  | 'game_over'
  | 'error'
  | 'ping';

export interface SSEEvent<T = unknown> {
  type: SSEEventType;
  data: T;
  timestamp: string;
  targetPlayerId?: string; // if set, only this player receives it
}

// Specific event data types

export interface NarrativeEventData {
  text: string;
  eventNumber: number;
  title?: string;
}

export interface DiceRequestEventData {
  targetPlayerId: string;
  targetPlayerName: string;
  diceType: string;
  reason: string;
  attemptNumber: number; // 1 = first try, 2 = re-roll, 3+ = virtual fallback offered
}

export interface DiceResultEventData {
  playerId: string;
  playerName: string;
  diceType: string;
  rollValue: number;
  source: 'physical' | 'virtual';
}

export interface StateUpdateEventData {
  playerId: string;
  statChanges: { stat: string; oldValue: number; newValue: number }[];
  description: string;
}

export interface TurnChangeEventData {
  previousPlayerId: string;
  currentPlayerId: string;
  currentPlayerName: string;
  turnNumber: number;
}

export interface MapUpdateEventData {
  tilesRevealed: { x: number; y: number; terrain: string }[];
  playerPositions: { playerId: string; x: number; y: number }[];
}

export interface PlayerJoinedEventData {
  playerId: string;
  playerName: string;
  totalPlayers: number;
}

export interface PlayerLeftEventData {
  playerId: string;
  playerName: string;
  reason: 'disconnect' | 'kicked' | 'left';
}

export interface GameOverEventData {
  summary: string;
  playerStats: { playerId: string; playerName: string; finalStats: Record<string, number> }[];
  totalTurns: number;
  totalEvents: number;
}

export interface ErrorEventData {
  message: string;
  code?: string;
  recoverable: boolean;
}
