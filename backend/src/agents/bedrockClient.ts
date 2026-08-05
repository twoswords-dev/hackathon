import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const REGION = process.env.AWS_REGION || 'us-east-1';

// Model IDs - using inference profiles for cross-region routing
export const MODELS = {
  // For lore/narrative generation (strong creative writing)
  loreGenerator: process.env.BEDROCK_LORE_MODEL || 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  // For DM narration
  dungeonMaster: process.env.BEDROCK_DM_MODEL || 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  // For state updates (fast, structured output)
  stateUpdater: process.env.BEDROCK_UPDATER_MODEL || 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
} as const;

const bedrockClient = new BedrockRuntimeClient({ region: REGION });

/**
 * Invoke a Claude model via Bedrock with the Messages API.
 */
export async function invokeClaudeModel(params: {
  modelId: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const { modelId, systemPrompt, userMessage, maxTokens = 4096, temperature = 0.7 } = params;

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userMessage,
      },
    ],
  });

  const command = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: new TextEncoder().encode(body),
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  // Extract text from the response
  if (responseBody.content && responseBody.content.length > 0) {
    return responseBody.content[0].text;
  }

  throw new Error('No content in Bedrock response');
}

export { bedrockClient };
