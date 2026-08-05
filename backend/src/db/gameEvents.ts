import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from './client';
import { GameEvent, ActionRequired, DiceType, StatChange, MapChange } from '../types/game';

/**
 * Create a new game event
 */
export async function createGameEvent(params: {
  sessionId: string;
  eventNumber: number;
  title: string;
  narrative: string;
  actionRequired: ActionRequired;
  targetPlayerId?: string;
  diceType?: DiceType;
}): Promise<GameEvent> {
  const event: GameEvent = {
    sessionId: params.sessionId,
    eventNumber: params.eventNumber,
    title: params.title,
    narrative: params.narrative,
    actionRequired: params.actionRequired,
    targetPlayerId: params.targetPlayerId,
    diceType: params.diceType,
    isComplete: false,
    timestamp: new Date().toISOString(),
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.gameEvents,
      Item: event,
    })
  );

  return event;
}

/**
 * Get a specific event
 */
export async function getGameEvent(
  sessionId: string,
  eventNumber: number
): Promise<GameEvent | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.gameEvents,
      Key: { sessionId, eventNumber },
    })
  );

  return (result.Item as GameEvent) || null;
}

/**
 * Get all events for a session (ordered by eventNumber)
 */
export async function getSessionEvents(sessionId: string): Promise<GameEvent[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.gameEvents,
      KeyConditionExpression: 'sessionId = :sid',
      ExpressionAttributeValues: { ':sid': sessionId },
      ScanIndexForward: true, // ascending order by eventNumber
    })
  );

  return (result.Items as GameEvent[]) || [];
}

/**
 * Record a dice result for an event
 */
export async function recordDiceResult(
  sessionId: string,
  eventNumber: number,
  diceResult: number
): Promise<GameEvent> {
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.gameEvents,
      Key: { sessionId, eventNumber },
      UpdateExpression: 'SET diceResult = :result',
      ExpressionAttributeValues: { ':result': diceResult },
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes as GameEvent;
}

/**
 * Complete an event with outcome and changes
 */
export async function completeEvent(
  sessionId: string,
  eventNumber: number,
  params: {
    outcome: string;
    statChanges?: StatChange[];
    mapChanges?: MapChange[];
  }
): Promise<GameEvent> {
  const updateParts = ['isComplete = :true', 'outcome = :outcome'];
  const exprValues: Record<string, unknown> = {
    ':true': true,
    ':outcome': params.outcome,
  };

  if (params.statChanges && params.statChanges.length > 0) {
    updateParts.push('statChanges = :statChanges');
    exprValues[':statChanges'] = params.statChanges;
  }

  if (params.mapChanges && params.mapChanges.length > 0) {
    updateParts.push('mapChanges = :mapChanges');
    exprValues[':mapChanges'] = params.mapChanges;
  }

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.gameEvents,
      Key: { sessionId, eventNumber },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ExpressionAttributeValues: exprValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes as GameEvent;
}

/**
 * Get the latest (most recent) event for a session
 */
export async function getLatestEvent(sessionId: string): Promise<GameEvent | null> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.gameEvents,
      KeyConditionExpression: 'sessionId = :sid',
      ExpressionAttributeValues: { ':sid': sessionId },
      ScanIndexForward: false, // descending - latest first
      Limit: 1,
    })
  );

  return result.Items && result.Items.length > 0 ? (result.Items[0] as GameEvent) : null;
}
