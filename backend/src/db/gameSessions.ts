import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from './client';
import { GameSession, SessionStatus, GameLength, GAME_LENGTH_EVENTS } from '../types/game';
import { v4 as uuidv4 } from 'uuid';

/**
 * Create a new game session
 */
export async function createGameSession(params: {
  gameLength: GameLength;
  sourceMaterial: string;
  createdBy: string;
  maxPlayers: number;
}): Promise<GameSession> {
  const now = new Date().toISOString();
  const session: GameSession = {
    sessionId: uuidv4(),
    status: 'waiting_for_players',
    gameLength: params.gameLength,
    totalEvents: GAME_LENGTH_EVENTS[params.gameLength],
    currentEvent: 0,
    sourceMaterial: params.sourceMaterial,
    createdAt: now,
    updatedAt: now,
    createdBy: params.createdBy,
    maxPlayers: params.maxPlayers,
    // Auto-expire sessions after 24 hours
    ttl: Math.floor(Date.now() / 1000) + 86400,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.gameSessions,
      Item: session,
      ConditionExpression: 'attribute_not_exists(sessionId)',
    })
  );

  return session;
}

/**
 * Get a game session by ID
 */
export async function getGameSession(sessionId: string): Promise<GameSession | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.gameSessions,
      Key: { sessionId },
    })
  );

  return (result.Item as GameSession) || null;
}

/**
 * Update the session status
 */
export async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus
): Promise<GameSession> {
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.gameSessions,
      Key: { sessionId },
      UpdateExpression: 'SET #status = :status, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': status,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes as GameSession;
}

/**
 * Advance to the next event
 */
export async function advanceEvent(sessionId: string): Promise<GameSession> {
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.gameSessions,
      Key: { sessionId },
      UpdateExpression: 'SET currentEvent = currentEvent + :one, updatedAt = :now',
      ExpressionAttributeValues: {
        ':one': 1,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes as GameSession;
}

/**
 * Delete a game session
 */
export async function deleteGameSession(sessionId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TABLE_NAMES.gameSessions,
      Key: { sessionId },
    })
  );
}

/**
 * List all active (non-completed) sessions
 */
export async function listActiveSessions(): Promise<GameSession[]> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAMES.gameSessions,
      FilterExpression: '#status <> :completed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':completed': 'completed' },
    })
  );

  return (result.Items as GameSession[]) || [];
}
