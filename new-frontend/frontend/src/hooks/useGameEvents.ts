import { useEffect, useRef, useState, useCallback } from 'react';

export type SSEEventType =
  | 'narrative'
  | 'dice_request'
  | 'dice_result'
  | 'state_update'
  | 'step_update'
  | 'turn_change'
  | 'map_update'
  | 'player_joined'
  | 'player_left'
  | 'game_started'
  | 'game_over'
  | 'error'
  | 'ping';

export interface SSEEvent<T = unknown> {
  type: SSEEventType;
  data: T;
  timestamp: string;
  targetPlayerId?: string;
}

interface UseGameEventsOptions {
  sessionId: string;
  playerId?: string;
  autoReconnect?: boolean;
  reconnectDelay?: number;
  onEvent?: (event: SSEEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
}

interface UseGameEventsReturn {
  connected: boolean;
  transport: 'sse' | 'poll' | null;
  events: SSEEvent[];
  latestByType: Partial<Record<SSEEventType, SSEEvent>>;
  disconnect: () => void;
  reconnect: () => void;
  clearEvents: () => void;
}

/**
 * How long to wait for the SSE stream to open before assuming a buffering proxy
 * sits in front of us (e.g. an API Gateway HTTP API, which buffers responses and
 * returns 503 at its 30s integration timeout) and switching to polling.
 */
const SSE_OPEN_TIMEOUT_MS = 6000;
const POLL_INTERVAL_MS = 1500;

export function useGameEvents(options: UseGameEventsOptions): UseGameEventsReturn {
  const {
    sessionId,
    playerId,
    autoReconnect = true,
    reconnectDelay = 3000,
    onEvent,
    onConnectionChange,
  } = options;

  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState<'sse' | 'poll' | null>(null);
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [latestByType, setLatestByType] = useState<Partial<Record<SSEEventType, SSEEvent>>>({});

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingRef = useRef(false);
  const sinceRef = useRef(-1);
  const pollClientIdRef = useRef<string>(
    `poll-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  );
  const onEventRef = useRef(onEvent);
  const onConnectionChangeRef = useRef(onConnectionChange);

  onEventRef.current = onEvent;
  onConnectionChangeRef.current = onConnectionChange;

  const updateConnectionState = useCallback((state: boolean) => {
    setConnected(state);
    onConnectionChangeRef.current?.(state);
  }, []);

  const handleEvent = useCallback((event: SSEEvent) => {
    if (event.type === 'ping') return;
    setEvents((prev) => [...prev, event]);
    setLatestByType((prev) => ({ ...prev, [event.type]: event }));
    onEventRef.current?.(event);
  }, []);

  const clearTimers = useCallback(() => {
    for (const ref of [reconnectTimeoutRef, openTimeoutRef, pollTimeoutRef]) {
      if (ref.current) {
        clearTimeout(ref.current);
        ref.current = null;
      }
    }
  }, []);

  const stopPolling = useCallback(() => {
    pollingRef.current = false;
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }, []);

  /**
   * Polling transport: reads the server-side event buffer via
   * GET /api/events/:sessionId/poll?since=<seq>. Used when the SSE stream
   * cannot be established.
   */
  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    setTransport('poll');

    const poll = async () => {
      if (!pollingRef.current) return;

      const params = new URLSearchParams({
        since: String(sinceRef.current),
        clientId: pollClientIdRef.current,
      });
      if (playerId) params.set('playerId', playerId);

      try {
        const res = await fetch(`/api/events/${sessionId}/poll?${params.toString()}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`poll failed: ${res.status}`);

        const body: { lastSeq: number; events: SSEEvent[] } = await res.json();
        sinceRef.current = body.lastSeq;
        updateConnectionState(true);
        for (const event of body.events) handleEvent(event);
      } catch {
        updateConnectionState(false);
      }

      if (pollingRef.current) {
        pollTimeoutRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    void poll();
  }, [sessionId, playerId, handleEvent, updateConnectionState]);

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const params = new URLSearchParams();
    if (playerId) params.set('playerId', playerId);

    const url = `/api/events/${sessionId}${params.toString() ? '?' + params.toString() : ''}`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    let streamOpened = false;

    const fallBackToPolling = () => {
      if (openTimeoutRef.current) {
        clearTimeout(openTimeoutRef.current);
        openTimeoutRef.current = null;
      }
      eventSource.close();
      if (eventSourceRef.current === eventSource) eventSourceRef.current = null;
      startPolling();
    };

    // If the stream never opens, a buffering proxy is in the way - poll instead.
    openTimeoutRef.current = setTimeout(() => {
      if (!streamOpened) {
        console.warn('[useGameEvents] SSE stream did not open, falling back to polling');
        fallBackToPolling();
      }
    }, SSE_OPEN_TIMEOUT_MS);

    const markOpen = () => {
      if (streamOpened) return;
      streamOpened = true;
      if (openTimeoutRef.current) {
        clearTimeout(openTimeoutRef.current);
        openTimeoutRef.current = null;
      }
      setTransport('sse');
      updateConnectionState(true);
    };

    eventSource.onopen = markOpen;

    const eventTypes: SSEEventType[] = [
      'narrative', 'dice_request', 'dice_result', 'state_update', 'step_update',
      'turn_change', 'map_update', 'player_joined', 'player_left',
      'game_started', 'game_over', 'error', 'ping',
    ];

    for (const type of eventTypes) {
      eventSource.addEventListener(type, (e: MessageEvent) => {
        markOpen();
        try {
          const event: SSEEvent = JSON.parse(e.data);
          handleEvent(event);
        } catch (err) {
          console.error(`[useGameEvents] Failed to parse ${type} event:`, err);
        }
      });
    }

    eventSource.onmessage = (e: MessageEvent) => {
      markOpen();
      try {
        const event: SSEEvent = JSON.parse(e.data);
        handleEvent(event);
      } catch {
        // Initial connection message or non-JSON, ignore
      }
    };

    eventSource.onerror = () => {
      updateConnectionState(false);

      // Never established a stream: the transport is unusable on this host.
      if (!streamOpened) {
        fallBackToPolling();
        return;
      }

      eventSource.close();
      eventSourceRef.current = null;

      if (autoReconnect) {
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, reconnectDelay);
      }
    };
  }, [
    sessionId,
    playerId,
    autoReconnect,
    reconnectDelay,
    handleEvent,
    updateConnectionState,
    startPolling,
  ]);

  const disconnect = useCallback(() => {
    clearTimers();
    stopPolling();
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setTransport(null);
    updateConnectionState(false);
  }, [clearTimers, stopPolling, updateConnectionState]);

  const reconnect = useCallback(() => {
    disconnect();
    connect();
  }, [disconnect, connect]);

  const clearEvents = useCallback(() => {
    setEvents([]);
    setLatestByType({});
  }, []);

  useEffect(() => {
    if (sessionId) {
      connect();
    }
    return () => {
      clearTimers();
      stopPolling();
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [sessionId, playerId, connect, clearTimers, stopPolling]);

  return { connected, transport, events, latestByType, disconnect, reconnect, clearEvents };
}
