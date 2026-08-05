/**
 * Bedrock Agent invocation helper.
 *
 * Provides a unified interface for invoking any of the game's Bedrock Agents
 * (DM, Lore Generator, State Updater) with session management.
 */

import {
  InvokeAgentCommand,
  InvokeAgentCommandInput,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { bedrockAgentRuntimeClient, AGENTS } from '../lib/bedrock';

export type AgentRole = 'DM' | 'LORE' | 'UPDATER';

export interface AgentInvocationOptions {
  /** Which agent to invoke */
  role: AgentRole;
  /** The input prompt/message for the agent */
  inputText: string;
  /** Session ID for maintaining conversation state across turns */
  sessionId: string;
  /** Whether to end the session after this invocation */
  endSession?: boolean;
}

export interface AgentResponse {
  /** The full text response from the agent */
  completion: string;
  /** The session ID (for continuing the conversation) */
  sessionId: string;
}

/**
 * Invoke a Bedrock Agent and collect the streamed response.
 *
 * @throws Error if agent configuration is missing or invocation fails
 */
export async function invokeAgent(options: AgentInvocationOptions): Promise<AgentResponse> {
  const { role, inputText, sessionId, endSession = false } = options;
  const agentConfig = AGENTS[role];

  if (!agentConfig.agentId || !agentConfig.agentAliasId) {
    throw new Error(
      `Bedrock Agent not configured for role "${role}". ` +
      `Set BEDROCK_${role}_AGENT_ID and BEDROCK_${role}_AGENT_ALIAS environment variables.`
    );
  }

  const input: InvokeAgentCommandInput = {
    agentId: agentConfig.agentId,
    agentAliasId: agentConfig.agentAliasId,
    sessionId,
    inputText,
    endSession,
  };

  const command = new InvokeAgentCommand(input);
  const response = await bedrockAgentRuntimeClient.send(command);

  // Collect streamed response chunks into a single completion string
  let completion = '';

  if (response.completion) {
    for await (const event of response.completion) {
      if (event.chunk?.bytes) {
        completion += new TextDecoder().decode(event.chunk.bytes);
      }
    }
  }

  return {
    completion,
    sessionId,
  };
}

/**
 * Invoke an agent and parse the response as JSON.
 * All game agents are expected to return structured JSON.
 *
 * @throws Error if response is not valid JSON
 */
export async function invokeAgentJSON<T = unknown>(
  options: AgentInvocationOptions
): Promise<T> {
  const response = await invokeAgent(options);

  // Try to extract JSON from the response (agents sometimes wrap in markdown code blocks)
  let jsonStr = response.completion.trim();

  // Strip markdown code fence if present
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  try {
    return JSON.parse(jsonStr) as T;
  } catch (err) {
    throw new Error(
      `Failed to parse agent response as JSON.\nRole: ${options.role}\nResponse: ${response.completion}\nError: ${err}`
    );
  }
}
