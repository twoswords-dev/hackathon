import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const TABLE_PREFIX = process.env.DYNAMODB_TABLE_PREFIX || 'GenDnd';

// Table names
export const TABLE_NAMES = {
  gameSessions: `${TABLE_PREFIX}_GameSessions`,
  players: `${TABLE_PREFIX}_Players`,
  gameEvents: `${TABLE_PREFIX}_GameEvents`,
  gameState: `${TABLE_PREFIX}_GameState`,
} as const;

// DynamoDB client configuration
const clientConfig: ConstructorParameters<typeof DynamoDBClient>[0] = {
  region: process.env.AWS_REGION || 'us-east-1',
};

// Use local DynamoDB endpoint in development
if (process.env.DYNAMODB_ENDPOINT) {
  clientConfig.endpoint = process.env.DYNAMODB_ENDPOINT;
  clientConfig.credentials = {
    accessKeyId: 'local',
    secretAccessKey: 'local',
  };
}

const dynamoClient = new DynamoDBClient(clientConfig);

export const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

export { dynamoClient };
