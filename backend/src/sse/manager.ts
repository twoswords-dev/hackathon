import { Response } from 'express';
import { SSEEvent, SSEEventType } from './types';

interface SSEClient {
  id: string;
  playerId?: string;
  response: Response;
  sessionId: string;
  connectedAt: Date;
}

interface StoredEvent {
  seq: number;
  event: SSEEvent;
}

interface PollClient {
  playerId?: string;
  lastSeen: number;
}

/**
 * SSE Manager - tracks connected clients per game session and broadcasts events.
 *
 * Every broadcast event is also appended to a per-session ring buffer with a
 * monotonic sequence number. This allows clients that cannot hold an open
 * stream (e.g. when the app is fronted by API Gateway, which buffers responses
 * and times out at 30s) to poll `getEventsSince()` instead.
 */
class SSEManager {
  private clients: Map<string, SSEClient> = new Map(); // clientId -> client
  private sessionClients: Map<string, Set<string>> = new Map(); // sessionId -> Set<clientId>

  // Polling fallback state
  private sessionHistory: Map<string, StoredEvent[]> = new Map(); // sessionId -> events
  private seqCounters: Map<string, number> = new Map(); // sessionId -> last seq
  private pollClients: Map<string, Map<string, PollClient>> = new Map(); // sessionId -> clientId -> info
  private readonly HISTORY_LIMIT = 300;
  private readonly POLL_CLIENT_TTL_MS = 15000;

  private pingInterval: NodeJS.Timeout | null = null;
  private readonly PING_INTERVAL_MS = 30000; // 30 seconds

  constructor() {
    this.startPingLoop();
  }

  // ============ Polling fallback ============

  /**
   * Append an event to the session history ring buffer.
   * Pings are not stored - they carry no game state.
   */
  private record(sessionId: string, event: SSEEvent): void {
    if (event.type === 'ping') return;

    const seq = (this.seqCounters.get(sessionId) || 0) + 1;
    this.seqCounters.set(sessionId, seq);

    let history = this.sessionHistory.get(sessionId);
    if (!history) {
      history = [];
      this.sessionHistory.set(sessionId, history);
    }
    history.push({ seq, event });
    if (history.length > this.HISTORY_LIMIT) {
      history.splice(0, history.length - this.HISTORY_LIMIT);
    }
  }

  /**
   * Return events for a session newer than `since`.
   *
   * `since < 0` means "first poll": no backlog is replayed, matching SSE
   * semantics where a client only receives events from the moment it connects.
   */
  getEventsSince(
    sessionId: string,
    since: number,
    playerId?: string
  ): { lastSeq: number; events: SSEEvent[] } {
    const lastSeq = this.seqCounters.get(sessionId) || 0;

    if (since < 0) {
      return { lastSeq, events: [] };
    }

    const history = this.sessionHistory.get(sessionId) || [];
    const events = history
      .filter((entry) => entry.seq > since)
      .filter((entry) => !entry.event.targetPlayerId || entry.event.targetPlayerId === playerId)
      .map((entry) => entry.event);

    return { lastSeq, events };
  }

  /**
   * Record presence for a polling client so connection counts stay accurate.
   */
  touchPollClient(sessionId: string, clientId: string, playerId?: string): void {
    let sessionPollers = this.pollClients.get(sessionId);
    if (!sessionPollers) {
      sessionPollers = new Map();
      this.pollClients.set(sessionId, sessionPollers);
    }
    sessionPollers.set(clientId, { playerId, lastSeen: Date.now() });
    this.prunePollClients(sessionId);
  }

  private prunePollClients(sessionId: string): void {
    const sessionPollers = this.pollClients.get(sessionId);
    if (!sessionPollers) return;

    const cutoff = Date.now() - this.POLL_CLIENT_TTL_MS;
    for (const [clientId, info] of sessionPollers) {
      if (info.lastSeen < cutoff) sessionPollers.delete(clientId);
    }
    if (sessionPollers.size === 0) this.pollClients.delete(sessionId);
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
    // Always record, even with zero live clients - pollers read from history.
    this.record(sessionId, event);

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
    this.record(sessionId, { ...event, targetPlayerId: playerId });

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
   * Get the number of connected clients for a session (streaming + polling).
   */
  getSessionClientCount(sessionId: string): number {
    this.prunePollClients(sessionId);
    const streaming = this.sessionClients.get(sessionId)?.size || 0;
    const polling = this.pollClients.get(sessionId)?.size || 0;
    return streaming + polling;
  }

  /**
   * Get connected player IDs for a session (streaming + polling).
   */
  getConnectedPlayers(sessionId: string): string[] {
    this.prunePollClients(sessionId);

    const playerIds = new Set<string>();

    const clientIds = this.sessionClients.get(sessionId);
    if (clientIds) {
      for (const clientId of clientIds) {
        const client = this.clients.get(clientId);
        if (client?.playerId) playerIds.add(client.playerId);
      }
    }

    const sessionPollers = this.pollClients.get(sessionId);
    if (sessionPollers) {
      for (const info of sessionPollers.values()) {
        if (info.playerId) playerIds.add(info.playerId);
      }
    }

    return [...playerIds];
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
