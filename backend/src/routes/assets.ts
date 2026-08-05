import { Router, Request, Response } from 'express';
import { getAssetUrl, generateImage } from '../agents/imageGenerator';
import { gameState } from '../db';

const router = Router();

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
