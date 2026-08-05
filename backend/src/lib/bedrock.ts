/**
 * Amazon Bedrock client initialization.
 *
 * Provides configured clients for:
 * - BedrockRuntime: Direct model invocations (Claude, Titan Image)
 * - BedrockAgentRuntime: Invoking Bedrock Agents (DM, Lore, Updater)
 * - Bedrock: Agent management and model listing
 */

import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockClient } from '@aws-sdk/client-bedrock';

const region = process.env.AWS_REGION || 'us-east-1';

/**
 * Client for invoking foundation models directly (Claude, Titan Image).
 * Used for: text generation, image generation, embeddings.
 */
export const bedrockRuntimeClient = new BedrockRuntimeClient({ region });

/**
 * Client for invoking Bedrock Agents with session state.
 * Used for: DM Agent, Lore Generator Agent, State Updater Agent.
 */
export const bedrockAgentRuntimeClient = new BedrockAgentRuntimeClient({ region });

/**
 * Client for Bedrock management operations.
 * Used for: listing available models, checking model access.
 */
export const bedrockClient = new BedrockClient({ region });

/** Default model IDs used throughout the application. */
export const MODELS = {
  /** Claude model for narrative/reasoning tasks (DM, Lore, State Updater) */
  CLAUDE: 'anthropic.claude-sonnet-4-20250514-v1:0',

  /** Image generation for maps, portraits, scene illustrations (Stable Image Core in us-west-2) */
  IMAGE: process.env.BEDROCK_IMAGE_MODEL_ID || 'stability.stable-image-core-v1:1',
} as const;

/** Region for image generation (Stable Image Core available in us-west-2) */
export const IMAGE_REGION = process.env.BEDROCK_IMAGE_REGION || 'us-west-2';

/** S3 bucket for storing generated assets */
export const ASSETS_BUCKET = process.env.ASSETS_BUCKET || 'gen-dnd-images-383466764719';

/** Bedrock Agent configuration loaded from environment variables. */
export const AGENTS = {
  DM: {
    agentId: process.env.BEDROCK_DM_AGENT_ID || '',
    agentAliasId: process.env.BEDROCK_DM_AGENT_ALIAS || '',
  },
  LORE: {
    agentId: process.env.BEDROCK_LORE_AGENT_ID || '',
    agentAliasId: process.env.BEDROCK_LORE_AGENT_ALIAS || '',
  },
  UPDATER: {
    agentId: process.env.BEDROCK_UPDATER_AGENT_ID || '',
    agentAliasId: process.env.BEDROCK_UPDATER_AGENT_ALIAS || '',
  },
} as const;
