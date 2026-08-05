import { invokeClaudeModel, MODELS } from './bedrockClient';
import { GameState, GameEvent, Player, DiceType, ActionRequired } from '../types/game';

const DM_SYSTEM_PROMPT = `You are an AI Dungeon Master for a D&D game. You narrate events, describe scenes, create tension, and drive the story forward.

You receive the current game state and must generate the next narrative beat. You decide:
1. What narrative to present to the players
2. Whether a dice roll is needed (and from whom)
3. Which player acts next

Your response MUST be valid JSON with this exact structure:
{
  "narrative_text": "string - KEEP THIS UNDER 100 CHARACTERS. Be extremely brief.",
  "action_required": "dice_roll" | "choice" | "none",
  "target_player_id": "string - player ID who needs to act (required if action_required != none)",
  "dice_type": "d4" | "d6" | "d8" | "d10" | "d12" | "d20" (required if action_required == dice_roll),
  "dice_reason": "string - brief explanation of what the roll is for",
  "next_turn_player_id": "string - who acts next after this resolves"
}

Rules:
- CRITICAL: narrative_text MUST be under 100 characters total. One short sentence max.
- Match the tone and themes of the source material
- Harder events should require higher dice (d20 for hard, d12 for medium, d6-d8 for easy)
- Rotate between players fairly
- If this is the final event, make it feel like a grand finale`;

/**
 * DM Agent response structure
 */
export interface DMResponse {
  narrative_text: string;
  action_required: ActionRequired;
  target_player_id?: string;
  dice_type?: DiceType;
  dice_reason?: string;
  next_turn_player_id?: string;
}

/**
 * Generate the next narrative beat from the DM agent.
 */
export async function generateNarrative(params: {
  gameState: GameState;
  players: Player[];
  currentEvent: GameEvent | null;
  previousEvents: GameEvent[];
  eventOutlineTitle: string;
  eventOutlineDescription: string;
  isFirstBeat: boolean;
  totalEvents: number;
  currentEventNumber: number;
}): Promise<DMResponse> {
  const {
    gameState,
    players,
    currentEvent,
    previousEvents,
    eventOutlineTitle,
    eventOutlineDescription,
    isFirstBeat,
    totalEvents,
    currentEventNumber,
  } = params;

  const playerSummary = players.map((p) => ({
    id: p.playerId,
    name: p.playerName,
    character: p.character ? {
      name: p.character.name,
      class: p.character.class,
      hp: p.character.stats.hp,
      maxHp: p.character.stats.maxHp,
    } : null,
  }));

  const recentHistory = previousEvents.slice(-3).map((e) => ({
    title: e.title,
    outcome: e.outcome,
    narrative: e.narrative?.substring(0, 200),
  }));

  const userMessage = `
GAME STATE:
- World: ${gameState.worldLore.worldName}
- Source: ${gameState.worldLore.sourceMaterial}
- Event ${currentEventNumber} of ${totalEvents}: "${eventOutlineTitle}"
- Event Description: ${eventOutlineDescription}
- Current Turn Player: ${gameState.currentTurnPlayerId}

ACTIVE CHARACTER (this character is the focus of this event):
${JSON.stringify(playerSummary.find(p => p.id === gameState.currentTurnPlayerId) || playerSummary[0], null, 2)}

ALL PLAYERS:
${JSON.stringify(playerSummary, null, 2)}

RECENT HISTORY:
${recentHistory.length > 0 ? JSON.stringify(recentHistory, null, 2) : 'None - this is the beginning'}

${currentEvent?.diceResult ? `LAST DICE RESULT: ${currentEvent.diceResult} (${currentEvent.diceType})` : ''}

Write a SHORT narrative (under 100 chars) focused on the active character BY NAME. They are about to face a challenge and roll dice. Reference their abilities.`;

  console.log(`[DM Agent] Generating narrative for event ${currentEventNumber}/${totalEvents}...`);

  const responseText = await invokeClaudeModel({
    modelId: MODELS.dungeonMaster,
    systemPrompt: DM_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 512,
    temperature: 0.8,
  });

  // Parse response
  let dmResponse: DMResponse;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    dmResponse = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[DM Agent] Failed to parse response, using fallback');
    dmResponse = {
      narrative_text: responseText.substring(0, 500),
      action_required: 'dice_roll',
      target_player_id: players[0]?.playerId,
      dice_type: 'd20',
      dice_reason: 'Fate decides...',
      next_turn_player_id: players[0]?.playerId,
    };
  }

  // Validate player IDs
  const playerIds = players.map((p) => p.playerId);
  if (dmResponse.target_player_id && !playerIds.includes(dmResponse.target_player_id)) {
    dmResponse.target_player_id = playerIds[0];
  }
  if (dmResponse.next_turn_player_id && !playerIds.includes(dmResponse.next_turn_player_id)) {
    dmResponse.next_turn_player_id = playerIds[Math.floor(Math.random() * playerIds.length)];
  }

  console.log(`[DM Agent] Generated: action=${dmResponse.action_required}, target=${dmResponse.target_player_id?.substring(0, 8)}`);
  return dmResponse;
}
