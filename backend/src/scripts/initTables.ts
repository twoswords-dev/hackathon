/**
 * Initialize DynamoDB tables for Gen DND.
 * Run against DynamoDB Local for development or against AWS for production.
 *
 * Usage:
 *   npx tsx src/scripts/initTables.ts
 *   DYNAMODB_ENDPOINT=http://localhost:8000 npx tsx src/scripts/initTables.ts
 */

import {
  CreateTableCommand,
  ListTablesCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import { dynamoClient, TABLE_NAMES } from '../db/client';

interface TableDefinition {
  tableName: string;
  keySchema: { AttributeName: string; KeyType: 'HASH' | 'RANGE' }[];
  attributeDefinitions: { AttributeName: string; AttributeType: 'S' | 'N' | 'B' }[];
}

const TABLE_DEFINITIONS: TableDefinition[] = [
  {
    tableName: TABLE_NAMES.gameSessions,
    keySchema: [{ AttributeName: 'sessionId', KeyType: 'HASH' }],
    attributeDefinitions: [{ AttributeName: 'sessionId', AttributeType: 'S' }],
  },
  {
    tableName: TABLE_NAMES.players,
    keySchema: [
      { AttributeName: 'sessionId', KeyType: 'HASH' },
      { AttributeName: 'playerId', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'sessionId', AttributeType: 'S' },
      { AttributeName: 'playerId', AttributeType: 'S' },
    ],
  },
  {
    tableName: TABLE_NAMES.gameEvents,
    keySchema: [
      { AttributeName: 'sessionId', KeyType: 'HASH' },
      { AttributeName: 'eventNumber', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'sessionId', AttributeType: 'S' },
      { AttributeName: 'eventNumber', AttributeType: 'N' },
    ],
  },
  {
    tableName: TABLE_NAMES.gameState,
    keySchema: [{ AttributeName: 'sessionId', KeyType: 'HASH' }],
    attributeDefinitions: [{ AttributeName: 'sessionId', AttributeType: 'S' }],
  },
];

async function tableExists(tableName: string): Promise<boolean> {
  try {
    await dynamoClient.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'name' in err && err.name === 'ResourceNotFoundException') {
      return false;
    }
    throw err;
  }
}

async function createTable(def: TableDefinition): Promise<void> {
  const exists = await tableExists(def.tableName);
  if (exists) {
    console.log(`  ✓ Table "${def.tableName}" already exists, skipping.`);
    return;
  }

  await dynamoClient.send(
    new CreateTableCommand({
      TableName: def.tableName,
      KeySchema: def.keySchema,
      AttributeDefinitions: def.attributeDefinitions,
      BillingMode: 'PAY_PER_REQUEST',
    })
  );

  console.log(`  ✓ Created table "${def.tableName}"`);
}

async function main() {
  const endpoint = process.env.DYNAMODB_ENDPOINT || 'AWS (production)';
  console.log(`\n🎲 Gen DND - DynamoDB Table Initialization`);
  console.log(`   Endpoint: ${endpoint}`);
  console.log(`   Prefix: ${process.env.DYNAMODB_TABLE_PREFIX || 'GenDnd'}\n`);

  // List existing tables
  const listResult = await dynamoClient.send(new ListTablesCommand({}));
  console.log(`   Existing tables: ${listResult.TableNames?.join(', ') || '(none)'}\n`);

  console.log('Creating tables...');
  for (const def of TABLE_DEFINITIONS) {
    await createTable(def);
  }

  // Verify
  console.log('\nVerifying...');
  const verifyResult = await dynamoClient.send(new ListTablesCommand({}));
  console.log(`   Tables: ${verifyResult.TableNames?.join(', ')}`);
  console.log('\n✅ Done!\n');
}

main().catch((err) => {
  console.error('❌ Failed to initialize tables:', err);
  process.exit(1);
});
