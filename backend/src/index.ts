import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { sseManager } from './sse';
import gameRoutes from './routes/game';
import assetRoutes from './routes/assets';
import diceRoutes from './routes/dice';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'gen-dnd-backend',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// API index
app.get('/api', (_req, res) => {
  res.json({
    message: 'Gen DND Game Engine API',
    endpoints: {
      health: 'GET /api/health',
      events: 'GET /api/events/:sessionId',
      game: {
        create: 'POST /api/game/create',
        join: 'POST /api/game/:sessionId/join',
        start: 'POST /api/game/:sessionId/start',
        diceResult: 'POST /api/game/:sessionId/dice-result',
        diceVirtual: 'POST /api/game/:sessionId/dice-virtual',
      },
    },
  });
});

// ============ SSE Events Endpoint ============

// Game routes
app.use('/api/game', gameRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/dice', diceRoutes);

/**
 * SSE stream for real-time game events.
 * Clients connect with optional playerId query param.
 * GET /api/events/:sessionId?playerId=xxx
 */
app.get('/api/events/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const playerId = req.query.playerId as string | undefined;
  const clientId = uuidv4();

  // Register client with SSE manager
  sseManager.addClient(clientId, sessionId, res, playerId);

  // Send initial session info
  sseManager.emit(sessionId, 'state_update', {
    connectedClients: sseManager.getSessionClientCount(sessionId),
    connectedPlayers: sseManager.getConnectedPlayers(sessionId),
  });
});

// ============ Test endpoint for SSE (development) ============

/**
 * POST /api/events/:sessionId/test
 * Push a test event to all clients in a session (for development/testing)
 */
app.post('/api/events/:sessionId/test', (req, res) => {
  const { sessionId } = req.params;
  const { type = 'narrative', data } = req.body;

  sseManager.emit(sessionId, type, data || { text: 'Test event from server', eventNumber: 0 });

  res.json({
    success: true,
    message: `Event sent to ${sseManager.getSessionClientCount(sessionId)} clients`,
  });
});

// ============ Start Server ============

app.listen(PORT, () => {
  console.log(`[gen-dnd-backend] Server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[gen-dnd-backend] Shutting down...');
  sseManager.shutdown();
  process.exit(0);
});

export default app;
