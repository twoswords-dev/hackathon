// Game entity types for Gen DND

// ============ Enums & Constants ============

export type GameLength = 'short' | 'medium' | 'long';
export type SessionStatus = 'waiting_for_players' | 'in_progress' | 'paused' | 'completed';
export type DiceType = 'd4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20' | 'd100';
export type ActionRequired = 'dice_roll' | 'choice' | 'none';
export type TerrainType = 'forest' | 'mountain' | 'town' | 'dungeon' | 'plains' | 'river' | 'cave' | 'castle' | 'swamp' | 'desert';

export const GAME_LENGTH_EVENTS: Record<GameLength, number> = {
  short: 5,
  medium: 15,
  long: 30,
};

// ============ Character & Stats ============

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

export interface StatusEffect {
  name: string;
  description: string;
  duration: number; // remaining turns
}

export interface InventoryItem {
  id: string;
  name: string;
  description: string;
  type: 'weapon' | 'armor' | 'potion' | 'misc';
  quantity: number;
}

export interface Character {
  id: string;
  name: string;
  class: string;
  race: string;
  description: string;
  portraitAssetId: string;
  stats: CharacterStats;
  statusEffects: StatusEffect[];
  inventory: InventoryItem[];
}

// ============ Map Types ============

export interface MapTile {
  x: number;
  y: number;
  terrain: TerrainType;
  name: string;
  isPoi: boolean;
  explored: boolean;
  entities: string[]; // player IDs or NPC IDs present on tile
}

export interface GameMap {
  width: number;
  height: number;
  tiles: MapTile[];
  campaignMapAssetId: string; // illustrated overview image
}

// ============ Lore Types ============

export interface Location {
  id: string;
  name: string;
  description: string;
  tileX: number;
  tileY: number;
}

export interface Faction {
  id: string;
  name: string;
  description: string;
  alignment: string;
}

export interface EventOutline {
  eventNumber: number;
  title: string;
  description: string;
  locationId: string;
  difficulty: 'easy' | 'medium' | 'hard';
  requiredDiceType: DiceType;
  type?: 'narrative' | 'combat'; // default is 'narrative'
  enemyName?: string;
  enemyHp?: number;
}

export interface WorldLore {
  worldName: string;
  worldDescription: string;
  sourceMaterial: string;
  locations: Location[];
  factions: Faction[];
  eventOutlines: EventOutline[];
  campaignMapDescription: string;
  suggestedCharacters: Character[];
}

// ============ DynamoDB Table Entities ============

/**
 * GameSessions table - PK: sessionId
 */
export interface GameSession {
  sessionId: string;
  status: SessionStatus;
  gameLength: GameLength;
  totalEvents: number;
  currentEvent: number;
  sourceMaterial: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  maxPlayers: number;
  ttl?: number; // TTL for auto-cleanup (epoch seconds)
}

/**
 * Players table - PK: sessionId, SK: playerId
 */
export interface Player {
  sessionId: string;
  playerId: string;
  playerName: string;
  character: Character;
  isConnected: boolean;
  isHost: boolean;
  joinedAt: string;
  lastActiveAt: string;
}

/**
 * GameEvents table - PK: sessionId, SK: eventNumber
 */
export interface GameEvent {
  sessionId: string;
  eventNumber: number;
  title: string;
  narrative: string;
  actionRequired: ActionRequired;
  targetPlayerId?: string;
  diceType?: DiceType;
  diceResult?: number;
  outcome?: string;
  statChanges?: StatChange[];
  mapChanges?: MapChange[];
  isComplete: boolean;
  timestamp: string;
}

export interface StatChange {
  playerId: string;
  stat: keyof CharacterStats;
  delta: number;
}

export interface MapChange {
  tileX: number;
  tileY: number;
  explored?: boolean;
  entities?: string[];
}

/**
 * GameState table - PK: sessionId
 * Stores the current runtime state of the game
 */
export interface GameState {
  sessionId: string;
  worldLore: WorldLore;
  map: GameMap;
  currentTurnPlayerId: string;
  turnOrder: string[]; // player IDs
  turnNumber: number;
  waitingForDice: boolean;
  lastDmNarrative: string;
  updatedAt: string;
}

// ============ API Request/Response Types ============

export interface CreateGameRequest {
  sourceMaterial: string;
  gameLength: GameLength;
  playerCount: number;
  hostName: string;
}

export interface CreateGameResponse {
  sessionId: string;
  session: GameSession;
}

export interface JoinGameRequest {
  playerName: string;
}

export interface DiceResultInput {
  diceType: DiceType;
  rollValue: number;
  confidence?: number;
  source: 'physical' | 'virtual';
}
