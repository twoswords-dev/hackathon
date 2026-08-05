import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  getGame,
  getGameState,
  rollVirtualDice,
  submitDiceResult,
  type GameDetails,
  type DiceRequestData,
  type DiceResultData,
  type GameOverData,
  type StatChange,
  type Character,
} from '../api/gameApi';
import { useGameEvents, type SSEEvent } from '../hooks/useGameEvents';
import DungeonMaster from '../components/DungeonMaster';
import VideoScreen from '../components/VideoScreen';
import ChatPanel from '../components/ChatPanel';
import type { ChatMessage } from '../types';

interface NarrativeEntry {
  text: string;
  eventNumber: number;
  title: string;
  timestamp: string;
  diceResult: number | null;
  diceType: string | null;
  outcome: string | null;
  statChanges?: StatChange[];
}

let nextId = 0;
const makeId = () => `${Date.now()}-${nextId++}`;

export default function GameView() {
  const { sessionId } = useParams<{ sessionId: string }>();

  // Game state
  const [game, setGame] = useState<GameDetails | null>(null);
  const [narratives, setNarratives] = useState<NarrativeEntry[]>([]);
  const [diceRequest, setDiceRequest] = useState<DiceRequestData | null>(null);
  const [lastDiceResult, setLastDiceResult] = useState<DiceResultData | null>(null);
  const [gameOver, setGameOver] = useState<GameOverData | null>(null);
  const [error, setError] = useState('');

  // DM speech state (drives DungeonMaster component)
  const [isDmSpeaking, setIsDmSpeaking] = useState(false);
  const [dmSpeechText, setDmSpeechText] = useState('');
  const [nextStepText, setNextStepText] = useState('Awaiting the Dungeon Master...');

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
    if (!game?.lore?.suggestedCharacters) return null;
    // In a single-player game, the first character is theirs
    // In multiplayer, find the character assigned to the current player
    if (player && game.players) {
      const myPlayer = game.players.find(p => p.playerId === player.playerId);
      if (myPlayer?.character) return myPlayer.character;
    }
    // Fallback: return first suggested character
    return game.lore.suggestedCharacters[0] || null;
  };

  const activeCharacter = getActiveCharacter();

  // Load game info
  useEffect(() => {
    if (!sessionId) return;
    getGame(sessionId).then(setGame).catch((e) => setError(e.message));
  }, [sessionId]);

  // Hydrate from game state on mount
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    const fetchState = async () => {
      try {
        const state = await getGameState(sessionId);
        if (cancelled) return;

        if (state.narrativeHistory && state.narrativeHistory.length > 0) {
          setNarratives(
            state.narrativeHistory.map((n) => ({
              text: n.text,
              eventNumber: n.eventNumber,
              title: n.title,
              timestamp: new Date().toISOString(),
              diceResult: n.diceResult ?? null,
              diceType: n.diceType ?? null,
              outcome: n.outcome ?? null,
              statChanges: n.statChanges || [],
            }))
          );
          const last = state.narrativeHistory[state.narrativeHistory.length - 1];
          if (last) {
            setNextStepText(last.text);
          }
        }

        if (state.waitingForDice && state.diceRequest) {
          setDiceRequest(state.diceRequest);
          setPendingDiceType(state.diceRequest.diceType);
          setDiceSubmitted(false);
          setNextStepText(`Waiting for ${state.diceRequest.targetPlayerName} to roll ${state.diceRequest.diceType.toUpperCase()}...`);
        }

        if (state.status === 'completed') {
          setGameOver({ summary: 'The adventure has come to an end!', totalTurns: state.currentEvent, playerStats: [] });
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
      case 'narrative': {
        const data = event.data as { text: string; eventNumber: number; title: string; diceResult?: number; diceType?: string; outcome?: string };
        const entry: NarrativeEntry = {
          text: data.text,
          eventNumber: data.eventNumber,
          title: data.title,
          timestamp: event.timestamp,
          diceResult: data.diceResult ?? null,
          diceType: data.diceType ?? null,
          outcome: data.outcome ?? null,
        };
        setNarratives((prev) => [...prev, entry]);
        setDiceRequest(null);
        setLastDiceResult(null);
        setPendingDiceType(null);
        setDiceSubmitted(false);

        // Trigger DM speech
        setDmSpeechText(data.text);
        setIsDmSpeaking(true);
        setNextStepText(data.text);
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

        const isMe = player && data.targetPlayerId === player.playerId;
        const stepText = isMe
          ? `🎯 Your turn! Roll ${data.diceType.toUpperCase()} — ${data.reason}`
          : `⏳ Waiting for ${data.targetPlayerName} to roll ${data.diceType.toUpperCase()}...`;
        setNextStepText(stepText);

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

        const resultText = `🎲 ${data.playerName} rolled ${data.rollValue}/${data.maxValue} (${data.diceType.toUpperCase()}) — ${data.outcome}`;
        setNextStepText(resultText);

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
        setNextStepText('🏆 Adventure Complete!');
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
        if (sessionId) getGame(sessionId).then(setGame);
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
              &nbsp;• Event {game.session.currentEvent}/{game.session.totalEvents}
              {narratives.length > 0 && ` (${narratives.length} narrations)`}
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
          nextStepText={nextStepText}
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
            <h3 className="stats-panel__name">{activeCharacter.name}</h3>
            <span className="stats-panel__class">{activeCharacter.race} {activeCharacter.class}</span>

            {/* HP Bar */}
            <div className="stats-panel__hp">
              <div className="hp-bar">
                <div
                  className="hp-bar__fill"
                  style={{ width: `${(activeCharacter.stats.hp / activeCharacter.stats.maxHp) * 100}%` }}
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
