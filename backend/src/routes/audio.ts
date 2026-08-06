import { Router } from 'express';
import { getCachedAudio } from '../agents/pollyNarrator';

const router = Router();

/**
 * GET /api/audio/:sessionId/:eventNumber
 * Serves the cached Polly-synthesized MP3 audio for a narrative event.
 */
router.get('/:sessionId/:eventNumber', (req, res) => {
  const { sessionId, eventNumber } = req.params;
  const eventNum = parseInt(eventNumber, 10);

  if (isNaN(eventNum)) {
    res.status(400).json({ error: 'Invalid event number' });
    return;
  }

  const audioBuffer = getCachedAudio(sessionId, eventNum);

  if (!audioBuffer) {
    res.status(404).json({ error: 'Audio not found or expired' });
    return;
  }

  res.set({
    'Content-Type': 'audio/mpeg',
    'Content-Length': audioBuffer.length.toString(),
    'Cache-Control': 'no-cache',
  });

  res.send(audioBuffer);
});

export default router;
