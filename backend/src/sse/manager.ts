import { Response } from 'express';
import { SSEEvent, SSEEventType } from './types';

interface SSEClient {
  id: string;
  playerId?: string;
  response: Response;
  sessionId: string;
  connectedAt: Date;
}

/**
 * SSE Manager - tracks connected clients per game session and broadcasts events.
 */
class SSEManager {
  private clients: Map<string, SSEClient> = new Map(); // clientId -> client
  private sessionClients: Map<string, Set<string>> = new Map(); // sessionId -> Set<clientId>

  private pingInterval: NodeJS.Timeout | null = null;
  private readonly PING_INTERVAL_MS = 30000; // 30 seconds

  constructor() {
    this.startPingLoop();
  }

  /**
   * Register a new SSE client connection.
   */
  addClient(clientId: string, sessionId: string, response: Response, playerId?: string): void {
    // Set SSE headers
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    });

    // Send initial connection event
    response.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

    const client: SSEClient = {
      id: clientId,
      playerId,
      response,
      sessionId,
      connectedAt: new Date(),
    };

    this.clients.set(clientId, client);

    if (!this.sessionClients.has(sessionId)) {
      this.sessionClients.set(sessionId, new Set());
    }
    this.sessionClients.get(sessionId)!.add(clientId);

    console.log(`[SSE] Client ${clientId} connected to session ${sessionId} (player: ${playerId || 'observer'})`);

    // Handle disconnect
    response.on('close', () => {
      this.removeClient(clientId);
    });
  }

  /**
   * Remove a client on disconnect.
   */
  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    this.clients.delete(clientId);

    const sessionSet = this.sessionClients.get(client.sessionId);
    if (sessionSet) {
      sessionSet.delete(clientId);
      if (sessionSet.size === 0) {
        this.sessionClients.delete(client.sessionId);
      }
    }

    console.log(`[SSE] Client ${clientId} disconnected from session ${client.sessionId}`);
  }

  /**
   * Send an event to all clients in a session.
   */
  broadcast(sessionId: string, event: SSEEvent): void {
    const clientIds = this.sessionClients.get(sessionId);
    if (!clientIds || clientIds.size === 0) return;

    const payload = this.formatEvent(event);

    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (!client) continue;

      // If event has a target player, only send to that player
      if (event.targetPlayerId && client.playerId !== event.targetPlayerId) {
        continue;
      }

      try {
        client.response.write(payload);
      } catch (err) {
        console.error(`[SSE] Error writing to client ${clientId}:`, err);
        this.removeClient(clientId);
      }
    }
  }

  /**
   * Send an event to a specific player in a session.
   */
  sendToPlayer(sessionId: string, playerId: string, event: SSEEvent): void {
    const clientIds = this.sessionClients.get(sessionId);
    if (!clientIds) return;

    const payload = this.formatEvent(event);

    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client && client.playerId === playerId) {
        try {
          client.response.write(payload);
        } catch (err) {
          console.error(`[SSE] Error writing to player ${playerId}:`, err);
          this.removeClient(clientId);
        }
      }
    }
  }

  /**
   * Get the number of connected clients for a session.
   */
  getSessionClientCount(sessionId: string): number {
    return this.sessionClients.get(sessionId)?.size || 0;
  }

  /**
   * Get connected player IDs for a session.
   */
  getConnectedPlayers(sessionId: string): string[] {
    const clientIds = this.sessionClients.get(sessionId);
    if (!clientIds) return [];

    const playerIds: string[] = [];
    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client?.playerId) {
        playerIds.push(client.playerId);
      }
    }
    return playerIds;
  }

  /**
   * Helper: Create and broadcast an event.
   */
  emit(sessionId: string, type: SSEEventType, data: unknown, targetPlayerId?: string): void {
    const event: SSEEvent = {
      type,
      data,
      timestamp: new Date().toISOString(),
      targetPlayerId,
    };
    this.broadcast(sessionId, event);
  }

  /**
   * Format an SSE event into the wire protocol.
   */
  private formatEvent(event: SSEEvent): string {
    const eventLine = `event: ${event.type}\n`;
    const dataLine = `data: ${JSON.stringify(event)}\n\n`;
    return eventLine + dataLine;
  }

  /**
   * Send periodic pings to keep connections alive.
   */
  private startPingLoop(): void {
    this.pingInterval = setInterval(() => {
      const now = new Date().toISOString();
      for (const [sessionId] of this.sessionClients) {
        this.broadcast(sessionId, {
          type: 'ping',
          data: { timestamp: now },
          timestamp: now,
        });
      }
    }, this.PING_INTERVAL_MS);
  }

  /**
   * Cleanup on shutdown.
   */
  shutdown(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    for (const [clientId, client] of this.clients) {
      try {
        client.response.end();
      } catch {
        // ignore
      }
      this.clients.delete(clientId);
    }
    this.sessionClients.clear();
  }
}

// Singleton instance
export const sseManager = new SSEManager();
