import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from './client';
import { GameState, WorldLore, GameMap, MapTile } from '../types/game';

/**
 * Create the initial game state (called after lore generation)
 */
export async function createGameState(params: {
  sessionId: string;
  worldLore: WorldLore;
  map: GameMap;
  turnOrder: string[];
}): Promise<GameState> {
  const state: GameState = {
    sessionId: params.sessionId,
    worldLore: params.worldLore,
    map: params.map,
    currentTurnPlayerId: params.turnOrder[0] || '',
    turnOrder: params.turnOrder,
    turnNumber: 1,
    waitingForDice: false,
    lastDmNarrative: '',
    updatedAt: new Date().toISOString(),
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.gameState,
      Item: state,
    })
  );

  return state;
}

/**
 * Get the game state for a session
 */
export async function getGameState(sessionId: string): Promise<GameState | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.gameState,
      Key: { sessionId },
    })
  );

  return (result.Item as GameState) || null;
}

/**
 * Update the current turn player
 */
export async function updateTurn(
  sessionId: string,
  nextPlayerId: string,
  turnNumber: number
): Promise<GameState> {
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.gameState,
      Key: { sessionId },
      UpdateExpression:
        'SET currentTurnPlayerId = :pid, turnNumber = :tn, updatedAt = :now',
      ExpressionAttributeValues: {
        ':pid': nextPlayerId,
        ':tn': turnNumber,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes as GameState;
}

/**
 * Set the waiting for dice flag
 */
export async function setWaitingForDice(
  sessionId: string,
  waiting: boolean
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.gameState,
      Key: { sessionId },
      UpdateExpression: 'SET waitingForDice = :waiting, updatedAt = :now',
      ExpressionAttributeValues: {
        ':waiting': waiting,
        ':now': new Date().toISOString(),
      },
    })
  );
}

/**
 * Update the last DM narrative
 */
export async function updateLastNarrative(
  sessionId: string,
  narrative: string
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.gameState,
      Key: { sessionId },
      UpdateExpression: 'SET lastDmNarrative = :narrative, updatedAt = :now',
      ExpressionAttributeValues: {
        ':narrative': narrative,
        ':now': new Date().toISOString(),
      },
    })
  );
}

/**
 * Update map tiles (e.g., reveal explored areas, move entities)
 */
export async function updateMapTiles(
  sessionId: string,
  tileUpdates: Partial<MapTile>[]
): Promise<GameState> {
  // Get current state first to modify the map
  const state = await getGameState(sessionId);
  if (!state) {
    throw new Error(`Game state not found for session: ${sessionId}`);
  }

  // Apply tile updates
  for (const update of tileUpdates) {
    const tileIndex = state.map.tiles.findIndex(
      (t) => t.x === update.x && t.y === update.y
    );
    if (tileIndex >= 0) {
      state.map.tiles[tileIndex] = { ...state.map.tiles[tileIndex], ...update };
    }
  }

  // Write back updated map
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.gameState,
      Key: { sessionId },
      UpdateExpression: 'SET #map = :map, updatedAt = :now',
      ExpressionAttributeNames: { '#map': 'map' },
      ExpressionAttributeValues: {
        ':map': state.map,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes as GameState;
}

/**
 * Persist the campaign map image asset for a session.
 */
export async function setCampaignMapAsset(
  sessionId: string,
  campaignMapAssetId: string
): Promise<GameState | null> {
  const state = await getGameState(sessionId);
  if (!state) return null;

  const map = { ...state.map, campaignMapAssetId };

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.gameState,
      Key: { sessionId },
      UpdateExpression: 'SET #map = :map, updatedAt = :now',
      ExpressionAttributeNames: { '#map': 'map' },
      ExpressionAttributeValues: {
        ':map': map,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes as GameState;
}

/**
 * Delete game state (cleanup)
 */
export async function deleteGameState(sessionId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TABLE_NAMES.gameState,
      Key: { sessionId },
    })
  );
}
