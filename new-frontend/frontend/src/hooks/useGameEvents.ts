import { useEffect, useRef, useState, useCallback } from 'react';

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
  sessionId: string;
  playerId?: string;
  autoReconnect?: boolean;
  reconnectDelay?: number;
  onEvent?: (event: SSEEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
}

interface UseGameEventsReturn {
  connected: boolean;
  events: SSEEvent[];
  latestByType: Partial<Record<SSEEventType, SSEEvent>>;
  disconnect: () => void;
  reconnect: () => void;
  clearEvents: () => void;
}

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

  const connect = useCallback(() => {
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

    const eventTypes: SSEEventType[] = [
      'narrative', 'dice_request', 'dice_result', 'state_update',
      'turn_change', 'map_update', 'player_joined', 'player_left',
      'game_started', 'game_over', 'error', 'ping',
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

    eventSource.onmessage = (e: MessageEvent) => {
      try {
        const event: SSEEvent = JSON.parse(e.data);
        handleEvent(event);
      } catch {
        // Initial connection message or non-JSON, ignore
      }
    };

    eventSource.onerror = () => {
      updateConnectionState(false);
      eventSource.close();
      eventSourceRef.current = null;

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

  return { connected, events, latestByType, disconnect, reconnect, clearEvents };
}
