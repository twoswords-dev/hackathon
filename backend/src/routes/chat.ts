import { Router, Request, Response } from 'express';
import { invokeClaudeModel, MODELS } from '../agents/bedrockClient';
import { gameState } from '../db';

const router = Router();

/**
 * POST /api/chat/:sessionId
 * Ask a question about the game lore/world via Bedrock.
 */
router.post('/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { message } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Get game state for lore context
    const state = await gameState.getGameState(sessionId);
    if (!state) {
      return res.status(404).json({ error: 'Game session not found' });
    }

    const lore = state.worldLore;

    // Build context from world lore
    const worldContext = [
      `World: ${lore.worldName}`,
      `Description: ${lore.worldDescription}`,
      `Source Material: ${lore.sourceMaterial}`,
      '',
      'Locations:',
      ...lore.locations.map((l: { name: string; description: string }) => `- ${l.name}: ${l.description}`),
      '',
      'Factions:',
      ...lore.factions.map((f: { name: string; description: string }) => `- ${f.name}: ${f.description}`),
      '',
      'Characters:',
      ...lore.suggestedCharacters.map((c: { name: string; race: string; class: string; description: string }) =>
        `- ${c.name} (${c.race} ${c.class}): ${c.description}`
      ),
    ].join('\n');

    const systemPrompt = `You are a knowledgeable guide for a tabletop RPG game set in the following world. Answer the player's questions about the lore, characters, locations, factions, and game mechanics. Stay in-character as a helpful narrator/sage. Keep answers concise (2-4 sentences) unless the player asks for more detail.

WORLD CONTEXT:
${worldContext}

Rules:
- Only answer questions related to the game world, lore, characters, and gameplay
- Don't reveal future plot points or event outlines
- Be helpful and engaging, maintain the fantasy tone
- If asked about something not in the lore, improvise consistently with the established world`;

    const response = await invokeClaudeModel({
      modelId: MODELS.dungeonMaster,
      systemPrompt,
      userMessage: message.trim(),
      maxTokens: 512,
      temperature: 0.7,
    });

    res.json({ reply: response });
  } catch (err) {
    console.error('[Chat] Error:', err);
    res.status(500).json({
      error: 'Failed to get response',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

export default router;
