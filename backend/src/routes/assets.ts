import { Router, Request, Response } from 'express';
import { getAssetUrl, generateImage } from '../agents/imageGenerator';
import { generateCharacterSVG, generateCritActionSVG, generateHitActionSVG } from '../agents/svgCharacterGenerator';
import { normalizeRace, normalizeClass, statsFor } from '../game/characterPresets';
import { gameState, players } from '../db';

const router = Router();

/**
 * GET /api/assets/preview/character?race=Elf&class=Mage&name=Lyra
 * Pixel art for a race/class combination with no session required, so the
 * character creator can preview art before the game exists.
 */
router.get('/preview/character', (req: Request, res: Response) => {
  try {
    const race = normalizeRace(req.query.race);
    const characterClass = normalizeClass(req.query.class);
    const rawName = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    const name = (rawName || `${race} ${characterClass}`).substring(0, 24);

    const svg = generateCharacterSVG({
      name,
      class: characterClass,
      race,
      stats: statsFor(race, characterClass),
    });

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(svg);
  } catch (err) {
    console.error('[Assets] Error generating preview SVG:', err);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

/**
 * GET /api/assets/character/:sessionId/:characterId/svg
 * Generate and return SVG pixel art for a character.
 *
 * The player record is preferred over the lore template because stat changes
 * (HP loss) are persisted there — reading the template would always render an
 * undamaged portrait. An optional `hp` query parameter lets the client request a
 * specific HP state, which also serves as a cache key so the browser refetches
 * the art as the character takes damage.
 */
router.get('/character/:sessionId/:characterId/svg', async (req: Request, res: Response) => {
  try {
    const { sessionId, characterId } = req.params;

    const state = await gameState.getGameState(sessionId);
    if (!state) {
      return res.status(404).json({ error: 'Game state not found' });
    }

    // Live player character first, falling back to the lore template.
    const sessionPlayers = await players.getSessionPlayers(sessionId);
    const owner = sessionPlayers.find((p) => p.character?.id === characterId);
    const character =
      owner?.character || state.worldLore.suggestedCharacters.find((c) => c.id === characterId);

    if (!character) {
      return res.status(404).json({ error: 'Character not found' });
    }

    // An explicit hp overrides the stored value so the portrait can be rendered
    // for a known state even before the write has propagated.
    const hpParam = typeof req.query.hp === 'string' ? parseInt(req.query.hp, 10) : NaN;
    const stats = Number.isFinite(hpParam)
      ? { ...character.stats, hp: Math.max(0, Math.min(hpParam, character.stats.maxHp)) }
      : character.stats;

    const svg = generateCharacterSVG({
      name: character.name,
      class: character.class,
      race: character.race,
      stats,
    });

    res.setHeader('Content-Type', 'image/svg+xml');
    // Portraits change with HP, so they must not be cached for long. The hp
    // query parameter makes distinct states individually cacheable.
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
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
