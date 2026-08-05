import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from './client';
import { Player, Character } from '../types/game';
import { v4 as uuidv4 } from 'uuid';

/**
 * Add a player to a session
 */
export async function addPlayer(params: {
  sessionId: string;
  playerName: string;
  isHost: boolean;
}): Promise<Player> {
  const now = new Date().toISOString();
  const player: Player = {
    sessionId: params.sessionId,
    playerId: uuidv4(),
    playerName: params.playerName,
    character: null as unknown as Character, // assigned during character selection
    isConnected: true,
    isHost: params.isHost,
    joinedAt: now,
    lastActiveAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.players,
      Item: player,
    })
  );

  return player;
}

/**
 * Get a specific player
 */
export async function getPlayer(sessionId: string, playerId: string): Promise<Player | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.players,
      Key: { sessionId, playerId },
    })
  );

  return (result.Item as Player) || null;
}

/**
 * Get all players in a session
 */
export async function getSessionPlayers(sessionId: string): Promise<Player[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.players,
      KeyConditionExpression: 'sessionId = :sid',
      ExpressionAttributeValues: { ':sid': sessionId },
    })
  );

  return (result.Items as Player[]) || [];
}

/**
 * Assign a character to a player
 */
export async function assignCharacter(
  sessionId: string,
  playerId: string,
  character: Character
): Promise<Player> {
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.players,
      Key: { sessionId, playerId },
      UpdateExpression: 'SET #char = :character, lastActiveAt = :now',
      ExpressionAttributeNames: { '#char': 'character' },
      ExpressionAttributeValues: {
        ':character': character,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes as Player;
}

/**
 * Update player connection status
 */
export async function updatePlayerConnection(
  sessionId: string,
  playerId: string,
  isConnected: boolean
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.players,
      Key: { sessionId, playerId },
      UpdateExpression: 'SET isConnected = :connected, lastActiveAt = :now',
      ExpressionAttributeValues: {
        ':connected': isConnected,
        ':now': new Date().toISOString(),
      },
    })
  );
}

/**
 * Update player character stats (after dice roll outcomes)
 */
export async function updatePlayerStats(
  sessionId: string,
  playerId: string,
  stats: Partial<Character['stats']>
): Promise<Player> {
  // Build update expression dynamically for each stat being changed
  const updateParts: string[] = [];
  const exprValues: Record<string, unknown> = { ':now': new Date().toISOString() };

  for (const [key, value] of Object.entries(stats)) {
    updateParts.push(`#char.stats.${key} = :${key}`);
    exprValues[`:${key}`] = value;
  }

  updateParts.push('lastActiveAt = :now');

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.players,
      Key: { sessionId, playerId },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ExpressionAttributeNames: { '#char': 'character' },
      ExpressionAttributeValues: exprValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes as Player;
}

/**
 * Remove a player from a session
 */
export async function removePlayer(sessionId: string, playerId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TABLE_NAMES.players,
      Key: { sessionId, playerId },
    })
  );
}
