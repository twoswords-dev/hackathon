// Game entity types for Gen DND

// ============ Enums & Constants ============

export type GameLength = 'short' | 'medium' | 'long';
export type SessionStatus = 'waiting_for_players' | 'in_progress' | 'paused' | 'completed';
export type DiceType = 'd4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20' | 'd100';
export type ActionRequired = 'dice_roll' | 'choice' | 'none';
export type TerrainType = 'forest' | 'mountain' | 'town' | 'dungeon' | 'plains' | 'river' | 'cave' | 'castle' | 'swamp' | 'desert' | 'snow';

export const GAME_LENGTH_EVENTS: Record<GameLength, number> = {
  short: 5,
  medium: 15,
  long: 30,
};

/**
 * Every die the engine supports for a roll — physical or virtual.
 *
 * This is the single source of truth: the DM agent's requested die is normalized
 * against it, and the virtual-roll endpoint rejects anything outside it, so the
 * DM can never ask for a die the virtual roller cannot offer.
 */
export const SUPPORTED_DICE: readonly DiceType[] = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];

/** The die used when a requested type is missing or unrecognised. */
export const DEFAULT_DICE_TYPE: DiceType = 'd20';

/**
 * Number of faces for a die type. Prefer this over `parseInt(type.slice(1))`
 * so unsupported strings cannot silently produce a bogus face count.
 */
export function diceFaces(diceType: string): number {
  const normalized = normalizeDiceType(diceType);
  return parseInt(normalized.slice(1), 10);
}

/**
 * Coerce arbitrary model or client input to a supported die.
 * Returns null when the value is not a die this engine offers.
 */
export function parseDiceType(value: unknown): DiceType | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toLowerCase();
  return SUPPORTED_DICE.includes(candidate as DiceType) ? (candidate as DiceType) : null;
}

/**
 * Same as parseDiceType but falls back to the default die instead of null.
 */
export function normalizeDiceType(value: unknown): DiceType {
  return parseDiceType(value) ?? DEFAULT_DICE_TYPE;
}

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
  /** Terrain at this location, chosen by the lore generator from the prompt. */
  terrain?: TerrainType;
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
  /** Short opening synopsis of the campaign arc, shown before the first event. */
  adventureSummary?: string;
  /** Terrain that most of the world is made of, used to fill non-location tiles. */
  dominantTerrain?: TerrainType;
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
