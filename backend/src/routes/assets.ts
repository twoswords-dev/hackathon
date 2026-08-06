import { Router, Request, Response } from 'express';
import { getAssetUrl, generateImage } from '../agents/imageGenerator';
import { generateCharacterSVG, generateCritActionSVG, generateHitActionSVG } from '../agents/svgCharacterGenerator';
import { gameState } from '../db';

const router = Router();

/**
 * GET /api/assets/character/:sessionId/:characterId/svg
 * Generate and return SVG pixel art for a character.
 */
router.get('/character/:sessionId/:characterId/svg', async (req: Request, res: Response) => {
  try {
    const { sessionId, characterId } = req.params;

    const state = await gameState.getGameState(sessionId);
    if (!state) {
      return res.status(404).json({ error: 'Game state not found' });
    }

    const character = state.worldLore.suggestedCharacters.find(c => c.id === characterId);
    if (!character) {
      return res.status(404).json({ error: 'Character not found' });
    }

    const svg = generateCharacterSVG({
      name: character.name,
      class: character.class,
      race: character.race,
      stats: character.stats,
    });

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24h
    res.send(svg);
  } catch (err) {
    console.error('[Assets] Error generating character SVG:', err);
    res.status(500).json({ error: 'Failed to generate character SVG' });
  }
});

/**
 * GET /api/assets/crit-action/:damage/:diceRoll
 * Generate and return crit action splat SVG.
 */
router.get('/crit-action/:damage/:diceRoll', (req: Request, res: Response) => {
  try {
    const damage = parseInt(req.params.damage) || 20;
    const diceRoll = parseInt(req.params.diceRoll) || 20;

    const svg = generateCritActionSVG(damage, diceRoll);

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(svg);
  } catch (err) {
    console.error('[Assets] Error generating crit SVG:', err);
    res.status(500).json({ error: 'Failed to generate crit action SVG' });
  }
});

/**
 * GET /api/assets/hit-action/:damage/:diceRoll
 * Generate and return hit action SVG.
 */
router.get('/hit-action/:damage/:diceRoll', (req: Request, res: Response) => {
  try {
    const damage = parseInt(req.params.damage) || 10;
    const diceRoll = parseInt(req.params.diceRoll) || 10;

    const svg = generateHitActionSVG(damage, diceRoll);

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(svg);
  } catch (err) {
    console.error('[Assets] Error generating hit SVG:', err);
    res.status(500).json({ error: 'Failed to generate hit action SVG' });
  }
});

/**
 * GET /api/assets/:sessionId/:assetId
 * Redirect to presigned S3 URL for an asset.
 */
router.get('/:sessionId/:imageType/:assetId', async (req: Request, res: Response) => {
  try {
    const { sessionId, imageType, assetId } = req.params;
    const s3Key = `sessions/${sessionId}/${imageType}/${assetId}.png`;
    const url = await getAssetUrl(s3Key);
    res.redirect(url);
  } catch (err) {
    console.error('[Assets] Error getting asset URL:', err);
    res.status(404).json({ error: 'Asset not found' });
  }
});

/**
 * POST /api/assets/:sessionId/generate
 * Generate an image on demand (for scene illustrations during gameplay).
 */
router.post('/:sessionId/generate', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { prompt, imageType, label } = req.body;

    if (!prompt || !imageType) {
      return res.status(400).json({ error: 'prompt and imageType are required' });
    }

    const result = await generateImage({ sessionId, prompt, imageType, label });
    res.json(result);
  } catch (err) {
    console.error('[Assets] Error generating image:', err);
    res.status(500).json({ error: 'Failed to generate image' });
  }
});

export default router;
