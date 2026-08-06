import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  getGame,
  getGameState,
  rollVirtualDice,
  submitDiceResult,
  characterPortraitUrl,
  type GameDetails,
  type DiceRequestData,
  type DiceResultData,
  type GameOverData,
  type GameStepInfo,
  type Character,
  type CharacterStats,
} from '../api/gameApi';
import { useGameEvents, type SSEEvent } from '../hooks/useGameEvents';
import DungeonMaster from '../components/DungeonMaster';
import VideoScreen from '../components/VideoScreen';
import ChatPanel from '../components/ChatPanel';
import type { ChatMessage } from '../types';

let nextId = 0;
const makeId = () => `${Date.now()}-${nextId++}`;

export default function GameView() {
  const { sessionId } = useParams<{ sessionId: string }>();

  // Game state
  const [game, setGame] = useState<GameDetails | null>(null);
  const [diceRequest, setDiceRequest] = useState<DiceRequestData | null>(null);
  const [lastDiceResult, setLastDiceResult] = useState<DiceResultData | null>(null);
  const [gameOver, setGameOver] = useState<GameOverData | null>(null);
  const [error, setError] = useState('');

  // DM speech state (drives DungeonMaster component)
  const [isDmSpeaking, setIsDmSpeaking] = useState(false);
  const [dmSpeechText, setDmSpeechText] = useState('');

  // Authoritative current-step info, pushed by the backend as `step_update`.
  const [step, setStep] = useState<GameStepInfo | null>(null);
  // Once live step events arrive, the periodic /state poll must not overwrite them.
  const hasLiveStep = useRef(false);
  // Chat history is only seeded from the server once, then driven by live events.
  const hasSeededChat = useRef(false);

  // Live character stats for this player, applied immediately from dice results
  // so the HP bar moves without waiting for a refetch.
  const [liveStats, setLiveStats] = useState<CharacterStats | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isDmThinking, setIsDmThinking] = useState(false);

  // Dice state for VideoScreen
  const [pendingDiceType, setPendingDiceType] = useState<string | null>(null);
  const [lastRollValue, setLastRollValue] = useState<number | null>(null);
  const [diceSubmitted, setDiceSubmitted] = useState(false);

  // Player info
  const stored = sessionId ? sessionStorage.getItem(`player_${sessionId}`) : null;
  const player = stored ? JSON.parse(stored) : null;

  // Get the active character from game state
  const getActiveCharacter = (): Character | null => {
    if (!game) return null;

    // The player record is authoritative: stat changes are persisted there.
    if (player && game.players) {
      const myPlayer = game.players.find((p) => p.playerId === player.playerId);
      if (myPlayer?.character) return myPlayer.character;
    }
    // Fallback for observers or before a character has been assigned.
    return game.lore?.suggestedCharacters?.[0] || null;
  };

  const baseCharacter = getActiveCharacter();

  // Overlay the freshest stats we have seen for this character.
  const activeCharacter: Character | null = baseCharacter
    ? { ...baseCharacter, stats: liveStats ?? baseCharacter.stats }
    : null;

  const isMyTurn = Boolean(
    player && step?.activePlayerId && step.activePlayerId === player.playerId
  );

  // Load game info
  useEffect(() => {
    if (!sessionId) return;
    getGame(sessionId).then(setGame).catch((e) => setError(e.message));
  }, [sessionId]);

  // Hydrate from game state on mount, then poll as a safety net for reconnects
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    const fetchState = async () => {
      try {
        const state = await getGameState(sessionId);
        if (cancelled) return;

        if (state.narrativeHistory && state.narrativeHistory.length > 0 && !hasSeededChat.current) {
          // Restore the story so far after a refresh or reconnect.
          hasSeededChat.current = true;
          setMessages((prev) => {
            if (prev.length > 0) return prev;
            return state.narrativeHistory.map((n) => ({
              id: makeId(),
              role: 'dm' as const,
              text: [
                n.title ? `📜 ${n.title}` : null,
                n.text,
                n.diceResult !== null ? `🎲 Rolled ${n.diceResult}${n.diceType ? ` (${n.diceType.toUpperCase()})` : ''}` : null,
                n.outcome,
              ]
                .filter(Boolean)
                .join('\n\n'),
              timestamp: Date.now(),
            }));
          });
        }

        // Only seed the step panel from polling until live events take over,
        // otherwise the poll would keep reverting it to a stale snapshot.
        if (!hasLiveStep.current && state.step) {
          setStep(state.step);
        }

        if (state.waitingForDice && state.diceRequest) {
          setDiceRequest((prev) => prev ?? state.diceRequest);
          setPendingDiceType((prev) => prev ?? state.diceRequest!.diceType);
        }

        if (state.status === 'completed') {
          setGameOver((prev) => prev ?? {
            summary: 'The adventure has come to an end!',
            totalTurns: state.currentEvent,
            playerStats: [],
          });
        }
      } catch {
        // State may not exist yet
      }
    };

    fetchState();

    const interval = setInterval(fetchState, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sessionId]);

  // Handle SSE events
  const handleSSEEvent = useCallback((event: SSEEvent) => {
    switch (event.type) {
      case 'step_update': {
        // Authoritative current-step info from the engine.
        hasLiveStep.current = true;
        const data = event.data as GameStepInfo;
        setStep(data);
        // Keep my own stats in sync when the step carries them.
        if (player && data.activePlayerId === player.playerId && data.characterStats) {
          setLiveStats(data.characterStats);
        }
        break;
      }
      case 'narrative': {
        const data = event.data as { text: string; eventNumber: number; title: string; diceResult?: number; diceType?: string; outcome?: string };
        setDiceRequest(null);
        setLastDiceResult(null);
        setPendingDiceType(null);
        setDiceSubmitted(false);

        // Trigger DM speech
        setDmSpeechText(data.text);
        setIsDmSpeaking(true);
        setIsDmThinking(false);

        // Add to chat
        setMessages((prev) => [...prev, {
          id: makeId(),
          role: 'dm',
          text: data.title ? `📜 ${data.title}\n\n${data.text}` : data.text,
          timestamp: Date.now(),
        }]);
        break;
      }
      case 'dice_request': {
        const data = event.data as DiceRequestData;
        setDiceRequest(data);
        setLastDiceResult(null);
        setPendingDiceType(data.diceType);
        setLastRollValue(null);
        setDiceSubmitted(false);

        setMessages((prev) => [...prev, {
          id: makeId(),
          role: 'dm',
          text: `🎲 ${data.targetPlayerName}, roll ${data.diceType.toUpperCase()}! ${data.reason}`,
          timestamp: Date.now(),
        }]);
        break;
      }
      case 'dice_result': {
        const data = event.data as DiceResultData;
        setLastDiceResult(data);
        // Keep diceRequest visible briefly so user sees what they rolled for
        setDiceSubmitted(true);
        setPendingDiceType(null);
        setLastRollValue(data.rollValue);

        // Apply the persisted stat line for this player immediately.
        const mineFromMap = player ? data.updatedStats?.[player.playerId] : undefined;
        if (mineFromMap) {
          setLiveStats(mineFromMap);
        } else if (player && data.playerId === player.playerId && data.characterStats) {
          setLiveStats(data.characterStats);
        }
        // Refetch so the authoritative player record (and other players) catch up.
        if (sessionId) getGame(sessionId).then(setGame).catch(() => {});

        const resultText = `🎲 ${data.playerName} rolled ${data.rollValue}/${data.maxValue} (${data.diceType.toUpperCase()}) — ${data.outcome}`;

        // Add result to chat
        setMessages((prev) => [...prev, {
          id: makeId(),
          role: 'dm',
          text: resultText + (data.statChanges?.length ? '\n' + data.statChanges.map(s => `  ${s.stat.toUpperCase()} ${s.delta > 0 ? '+' : ''}${s.delta}`).join('\n') : ''),
          timestamp: Date.now(),
        }]);
        setIsDmThinking(true);

        // Clear dice request after a delay so the result is visible
        setTimeout(() => {
          setDiceRequest(null);
        }, 2000);
        break;
      }
      case 'game_over': {
        const data = event.data as GameOverData;
        setGameOver(data);
        setDiceRequest(null);
        setPendingDiceType(null);
        setDmSpeechText(data.summary);
        setIsDmSpeaking(true);

        setMessages((prev) => [...prev, {
          id: makeId(),
          role: 'dm',
          text: `🏆 Adventure Complete!\n\n${data.summary}`,
          timestamp: Date.now(),
        }]);
        break;
      }
      case 'state_update': {
        if (sessionId) getGame(sessionId).then(setGame).catch(() => {});
        break;
      }
      case 'player_joined': {
        const data = event.data as { playerName: string };
        setMessages((prev) => [...prev, {
          id: makeId(),
          role: 'dm',
          text: `👋 ${data.playerName} has joined the adventure!`,
          timestamp: Date.now(),
        }]);
        break;
      }
    }
  }, [sessionId, player]);

  const { connected } = useGameEvents({
    sessionId: sessionId || '',
    playerId: player?.playerId,
    onEvent: handleSSEEvent,
  });

  // Handle player chat messages
  const handleSendMessage = async (text: string) => {
    const playerMessage: ChatMessage = {
      id: makeId(),
      role: 'player',
      text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, playerMessage]);

    // If there's a dice request for this player and they type a number, submit it
    if (diceRequest && player && diceRequest.targetPlayerId === player.playerId && !diceSubmitted) {
      const num = parseInt(text);
      const max = parseInt(diceRequest.diceType.replace('d', ''));
      if (!isNaN(num) && num >= 1 && num <= max) {
        handleManualDiceSubmit(num);
        return;
      }
    }

    // Otherwise, ask Bedrock about lore/game
    if (sessionId) {
      setIsDmThinking(true);
      try {
        const res = await fetch(`/api/chat/${sessionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text }),
        });
        const data = await res.json();
        if (data.reply) {
          setMessages((prev) => [...prev, {
            id: makeId(),
            role: 'dm',
            text: data.reply,
            timestamp: Date.now(),
          }]);
        } else if (data.error) {
          setMessages((prev) => [...prev, {
            id: makeId(),
            role: 'dm',
            text: `⚠️ ${data.error}`,
            timestamp: Date.now(),
          }]);
        }
      } catch {
        setMessages((prev) => [...prev, {
          id: makeId(),
          role: 'dm',
          text: '⚠️ Could not reach the sage. Try again.',
          timestamp: Date.now(),
        }]);
      } finally {
        setIsDmThinking(false);
      }
    }
  };

  // Handle virtual dice roll (backend rolls for us)
  const handleVirtualRoll = async () => {
    if (!sessionId || !diceRequest || diceSubmitted) return;
    setDiceSubmitted(true);

    try {
      const result = await rollVirtualDice(sessionId, diceRequest.diceType);
      setLastRollValue(result.rollValue);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to roll virtual dice');
      setDiceSubmitted(false);
    }
  };

  // Handle manual dice submit from chat
  const handleManualDiceSubmit = async (value: number) => {
    if (!sessionId || !diceRequest || diceSubmitted) return;
    setDiceSubmitted(true);
    try {
      await submitDiceResult(sessionId, diceRequest.diceType, value, 'physical');
      setLastRollValue(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to submit');
      setDiceSubmitted(false);
    }
  };

  const handleSpeechComplete = () => {
    setIsDmSpeaking(false);
  };

  // Show dice request to ALL players (not just isMyTurn) — everyone sees it
  const canRoll = diceRequest && player && diceRequest.targetPlayerId === player.playerId && !diceSubmitted;

  const hpRatio = activeCharacter && activeCharacter.stats.maxHp > 0
    ? activeCharacter.stats.hp / activeCharacter.stats.maxHp
    : 0;

  // A character at 0 HP is out of the adventure and no longer rolls.
  const isDowned = Boolean(activeCharacter && activeCharacter.stats.hp <= 0);

  if (!sessionId) return <div className="page-game"><p>Invalid session</p></div>;

  return (
    <div className="dashboard dashboard--game">
      <header className="dashboard__header">
        <h1>⚔️ {game?.lore?.worldName || 'AI Dungeon Master'}</h1>
        <span className="dashboard__status">
          <span className={`connection-dot ${connected ? 'connected' : 'disconnected'}`} />
          {connected ? 'Connected' : 'Reconnecting...'}
          {game && !gameOver && (
            <span className="event-counter">
              &nbsp;• Event {step?.eventNumber ?? game.session.currentEvent}/{step?.totalEvents || game.session.totalEvents}
              {step?.encounter === 'combat' && ' • ⚔️ In Combat'}
              {step?.encounter === 'boss' && ' • 👹 Boss Fight'}
            </span>
          )}
          {gameOver && <span className="event-counter">&nbsp;• 🏆 Complete</span>}
        </span>
      </header>

      <div className="dashboard__dm">
        <DungeonMaster
          isSpeaking={isDmSpeaking}
          speechText={dmSpeechText}
          onSpeechComplete={handleSpeechComplete}
          step={step}
          isMyTurn={isMyTurn}
          connected={connected}
        />
      </div>

      <div className="dashboard__video">
        <VideoScreen
          diceRequest={diceRequest}
          lastRollValue={lastRollValue}
          onVirtualRoll={canRoll ? handleVirtualRoll : undefined}
          pendingDiceType={pendingDiceType}
          diceResult={lastDiceResult}
          diceSubmitted={diceSubmitted}
        />
      </div>

      <div className="dashboard__chat-area">
        {/* Character Stats Panel */}
        {activeCharacter && (
          <div className="character-stats-panel">
            {/* Pixel art portrait */}
            <div className="stats-panel__portrait">
              <img
                className="pixel-portrait"
                src={characterPortraitUrl(sessionId, activeCharacter)}
                alt={`Pixel art portrait of ${activeCharacter.name}, ${activeCharacter.race} ${activeCharacter.class}`}
                width={96}
                height={96}
              />
            </div>

            <h3 className="stats-panel__name">{activeCharacter.name}</h3>
            <span className="stats-panel__class">{activeCharacter.race} {activeCharacter.class}</span>

            {isDowned && (
              <span className="stats-panel__downed" role="status">
                💀 Downed — sitting out the rest of the adventure
              </span>
            )}

            {/* HP Bar */}
            <div className="stats-panel__hp">
              <div className="hp-bar">
                <div
                  className={`hp-bar__fill ${hpRatio <= 0.25 ? 'hp-bar__fill--critical' : hpRatio <= 0.5 ? 'hp-bar__fill--low' : ''}`}
                  style={{ width: `${Math.max(0, Math.min(100, hpRatio * 100))}%` }}
                />
              </div>
              <span className="hp-bar__text">❤️ {activeCharacter.stats.hp}/{activeCharacter.stats.maxHp}</span>
            </div>

            {/* Core Stats */}
            <div className="stats-panel__grid">
              <div className="stat-pill"><span className="stat-label">STR</span><span className="stat-value">{activeCharacter.stats.str}</span></div>
              <div className="stat-pill"><span className="stat-label">DEX</span><span className="stat-value">{activeCharacter.stats.dex}</span></div>
              <div className="stat-pill"><span className="stat-label">INT</span><span className="stat-value">{activeCharacter.stats.int}</span></div>
              <div className="stat-pill"><span className="stat-label">WIS</span><span className="stat-value">{activeCharacter.stats.wis}</span></div>
              <div className="stat-pill"><span className="stat-label">CHA</span><span className="stat-value">{activeCharacter.stats.cha}</span></div>
              <div className="stat-pill"><span className="stat-label">CON</span><span className="stat-value">{activeCharacter.stats.con}</span></div>
            </div>

            {/* Last dice result display */}
            {lastDiceResult && (
              <div className="stats-panel__last-roll">
                <span className="last-roll-label">Last Roll</span>
                <span className="last-roll-value">{lastDiceResult.rollValue}/{lastDiceResult.maxValue}</span>
                <span className="last-roll-outcome">{lastDiceResult.outcome}</span>
              </div>
            )}
          </div>
        )}

        {/* Chat Panel */}
        <div className="dashboard__chat">
          <ChatPanel
            messages={messages}
            isDmThinking={isDmThinking}
            onSendMessage={handleSendMessage}
          />
        </div>
      </div>

      {error && <div className="game-error">{error}</div>}
    </div>
  );
}
