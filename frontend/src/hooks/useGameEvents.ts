import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * SSE Event types matching the backend
 */
export type SSEEventType =
  | 'narrative'
  | 'dice_request'
  | 'dice_result'
  | 'state_update'
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
  /** The game session ID to subscribe to */
  sessionId: string;
  /** The current player's ID (for targeted events) */
  playerId?: string;
  /** Whether to auto-reconnect on disconnect */
  autoReconnect?: boolean;
  /** Reconnect delay in ms */
  reconnectDelay?: number;
  /** Event handler callback */
  onEvent?: (event: SSEEvent) => void;
  /** Connection state change callback */
  onConnectionChange?: (connected: boolean) => void;
}

interface UseGameEventsReturn {
  /** Whether the SSE connection is active */
  connected: boolean;
  /** All events received (chronological) */
  events: SSEEvent[];
  /** The most recent event of each type */
  latestByType: Partial<Record<SSEEventType, SSEEvent>>;
  /** Manually disconnect */
  disconnect: () => void;
  /** Manually reconnect */
  reconnect: () => void;
  /** Clear event history */
  clearEvents: () => void;
}

/**
 * React hook for subscribing to game events via Server-Sent Events.
 *
 * @example
 * ```tsx
 * const { connected, events, latestByType } = useGameEvents({
 *   sessionId: 'abc-123',
 *   playerId: 'player-1',
 *   onEvent: (event) => console.log('New event:', event),
 * });
 * ```
 */
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
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [latestByType, setLatestByType] = useState<Partial<Record<SSEEventType, SSEEvent>>>({});

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEventRef = useRef(onEvent);
  const onConnectionChangeRef = useRef(onConnectionChange);

  // Keep callback refs fresh
  onEventRef.current = onEvent;
  onConnectionChangeRef.current = onConnectionChange;

  const updateConnectionState = useCallback((state: boolean) => {
    setConnected(state);
    onConnectionChangeRef.current?.(state);
  }, []);

  const handleEvent = useCallback((event: SSEEvent) => {
    // Skip ping events from UI state
    if (event.type === 'ping') return;

    setEvents((prev) => [...prev, event]);
    setLatestByType((prev) => ({ ...prev, [event.type]: event }));
    onEventRef.current?.(event);
  }, []);

  const connect = useCallback(() => {
    // Clean up existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const params = new URLSearchParams();
    if (playerId) params.set('playerId', playerId);

    const url = `/api/events/${sessionId}${params.toString() ? '?' + params.toString() : ''}`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      updateConnectionState(true);
    };

    // Listen for all typed events
    const eventTypes: SSEEventType[] = [
      'narrative',
      'dice_request',
      'dice_result',
      'state_update',
      'turn_change',
      'map_update',
      'player_joined',
      'player_left',
      'game_started',
      'game_over',
      'error',
      'ping',
    ];

    for (const type of eventTypes) {
      eventSource.addEventListener(type, (e: MessageEvent) => {
        try {
          const event: SSEEvent = JSON.parse(e.data);
          handleEvent(event);
        } catch (err) {
          console.error(`[useGameEvents] Failed to parse ${type} event:`, err);
        }
      });
    }

    // Also listen for generic message events (fallback)
    eventSource.onmessage = (e: MessageEvent) => {
      try {
        const event: SSEEvent = JSON.parse(e.data);
        handleEvent(event);
      } catch {
        // Initial connection message or non-JSON data, ignore
      }
    };

    eventSource.onerror = () => {
      updateConnectionState(false);
      eventSource.close();
      eventSourceRef.current = null;

      // Auto-reconnect
      if (autoReconnect) {
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, reconnectDelay);
      }
    };
  }, [sessionId, playerId, autoReconnect, reconnectDelay, handleEvent, updateConnectionState]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    updateConnectionState(false);
  }, [updateConnectionState]);

  const reconnect = useCallback(() => {
    disconnect();
    connect();
  }, [disconnect, connect]);

  const clearEvents = useCallback(() => {
    setEvents([]);
    setLatestByType({});
  }, []);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    if (sessionId) {
      connect();
    }

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [sessionId, playerId, connect]);

  return {
    connected,
    events,
    latestByType,
    disconnect,
    reconnect,
    clearEvents,
  };
}
