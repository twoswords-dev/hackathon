import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const REGION = process.env.AWS_REGION || 'us-west-2';

// Model IDs. Overridable via env so the deployment can target whatever the
// account is actually entitled to invoke.
export const MODELS = {
  // For lore/narrative generation (strong creative writing)
  loreGenerator: process.env.BEDROCK_LORE_MODEL || 'amazon.nova-lite-v1:0',
  // For DM narration
  dungeonMaster: process.env.BEDROCK_DM_MODEL || 'amazon.nova-lite-v1:0',
  // For state updates (fast, structured output)
  stateUpdater: process.env.BEDROCK_UPDATER_MODEL || 'amazon.nova-lite-v1:0',
} as const;

const bedrockClient = new BedrockRuntimeClient({ region: REGION });

/**
 * Invoke a text model via the Bedrock Converse API.
 *
 * Converse is model-agnostic: the same call works for Anthropic, Nova, Llama,
 * etc. This avoids hard-coding a single provider's request/response shape so the
 * model can be swapped through env vars alone.
 */
export async function invokeClaudeModel(params: {
  modelId: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const { modelId, systemPrompt, userMessage, maxTokens = 4096, temperature = 0.7 } = params;

  const command = new ConverseCommand({
    modelId,
    system: systemPrompt ? [{ text: systemPrompt }] : undefined,
    messages: [
      {
        role: 'user',
        content: [{ text: userMessage }],
      },
    ],
    inferenceConfig: {
      maxTokens,
      temperature,
    },
  });

  const response = await bedrockClient.send(command);

  const text = response.output?.message?.content
    ?.map((block) => block.text)
    .filter((t): t is string => Boolean(t))
    .join('');

  if (!text) {
    throw new Error('No content in Bedrock response');
  }

  return text;
}

export { bedrockClient };
