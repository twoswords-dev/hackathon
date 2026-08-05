import { Router, Request, Response } from 'express';
import { handleDiceResult } from '../game/gameLoop';
import { gameState } from '../db';

const router = Router();

/**
 * POST /api/dice/:sessionId/submit
 *
 * External dice agent API endpoint.
 * Your OpenCV device should POST dice results here.
 *
 * Request body:
 * {
 *   "dice_type": "d20",        // d4, d6, d8, d10, d12, d20, d100
 *   "roll_value": 15,          // 1 to max value of dice
 *   "confidence": 0.95,        // optional, 0-1
 *   "device_id": "opencv-pi"   // optional, for tracking
 * }
 *
 * Response:
 * { "success": true, "accepted": true, "diceType": "d20", "rollValue": 15 }
 *
 * Error cases:
 * - 400: Invalid dice type or roll value
 * - 409: Game is not waiting for a dice roll
 * - 404: Session not found
 */
router.post('/:sessionId/submit', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const {
      dice_type,
      roll_value,
      confidence,
      device_id,
      // Also accept camelCase for flexibility
      diceType: diceTypeCamel,
      rollValue: rollValueCamel,
    } = req.body;

    // Normalize - accept both snake_case and camelCase
    const diceType = dice_type || diceTypeCamel;
    const rollValue = roll_value ?? rollValueCamel;

    if (!diceType || rollValue === undefined || rollValue === null) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: { dice_type: 'string (d4-d100)', roll_value: 'number (1-max)' },
        example: { dice_type: 'd20', roll_value: 15 },
      });
    }

    // Validate dice type
    const validDice = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];
    const normalizedDice = diceType.toLowerCase();
    if (!validDice.includes(normalizedDice)) {
      return res.status(400).json({
        error: `Invalid dice_type: ${diceType}`,
        valid: validDice,
      });
    }

    // Validate roll value
    const maxValue = parseInt(normalizedDice.replace('d', ''));
    const numericRoll = Number(rollValue);
    if (isNaN(numericRoll) || numericRoll < 1 || numericRoll > maxValue) {
      return res.status(400).json({
        error: `Invalid roll_value: ${rollValue}. Must be 1-${maxValue} for ${normalizedDice}`,
      });
    }

    // Check if game is waiting for dice
    const state = await gameState.getGameState(sessionId);
    if (!state) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!state.waitingForDice) {
      return res.status(409).json({
        error: 'Game is not currently waiting for a dice roll',
        waitingForDice: false,
      });
    }

    // Submit the result
    await handleDiceResult(sessionId, {
      diceType: normalizedDice as 'd4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20' | 'd100',
      rollValue: numericRoll,
      source: 'physical',
      confidence: confidence ? Number(confidence) : undefined,
    });

    console.log(`[DiceAgent] Accepted: ${normalizedDice}=${numericRoll} (confidence: ${confidence || 'n/a'}, device: ${device_id || 'unknown'})`);

    res.json({
      success: true,
      accepted: true,
      diceType: normalizedDice,
      rollValue: numericRoll,
      confidence: confidence || null,
    });
  } catch (err) {
    console.error('[DiceAgent] Error:', err);
    res.status(500).json({
      error: 'Failed to process dice result',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/dice/:sessionId/status
 *
 * Check if the game is waiting for a dice roll.
 * Your device can poll this to know when to start reading.
 *
 * Response:
 * {
 *   "waitingForDice": true,
 *   "expectedDiceType": "d20",
 *   "targetPlayerName": "Gandalf"
 * }
 */
router.get('/:sessionId/status', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const state = await gameState.getGameState(sessionId);
    if (!state) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!state.waitingForDice) {
      return res.json({
        waitingForDice: false,
        expectedDiceType: null,
        targetPlayerName: null,
      });
    }

    // Get the current event to find expected dice type
    const { gameEvents } = await import('../db');
    const session = await import('../db').then((db) => db.gameSessions.getGameSession(sessionId));
    const currentEvt = session ? await gameEvents.getGameEvent(sessionId, session.currentEvent) : null;

    res.json({
      waitingForDice: true,
      expectedDiceType: currentEvt?.diceType || 'd20',
      targetPlayerId: state.currentTurnPlayerId,
      sessionId,
    });
  } catch (err) {
    console.error('[DiceAgent] Status error:', err);
    res.status(500).json({ error: 'Failed to get dice status' });
  }
});

/**
 * GET /api/dice/sessions
 *
 * List all active game sessions that are in progress.
 * Useful for the dice device to discover which game to send results to.
 */
router.get('/sessions', async (_req: Request, res: Response) => {
  try {
    const { gameSessions } = await import('../db');
    const sessions = await gameSessions.listActiveSessions();
    const inProgress = sessions.filter((s) => s.status === 'in_progress');

    res.json({
      activeSessions: inProgress.map((s) => ({
        sessionId: s.sessionId,
        sourceMaterial: s.sourceMaterial,
        currentEvent: s.currentEvent,
        totalEvents: s.totalEvents,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

export default router;
