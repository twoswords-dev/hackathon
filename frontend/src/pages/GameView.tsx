import { useEffect, useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { getGame, getGameState, rollVirtualDice, submitDiceResult, type GameDetails, type Character } from '../api/gameApi';
import { useGameEvents, type SSEEvent } from '../hooks/useGameEvents';
import CharacterCard from '../components/CharacterCard';

interface NarrativeEntry {
  text: string;
  eventNumber: number;
  title: string;
  timestamp: string;
  diceResult: number | null;
  diceType: string | null;
  outcome: string | null;
  characterName?: string;
  characterClass?: string;
  playerName?: string;
  statChanges?: StatChange[];
}

interface DiceRequest {
  targetPlayerId: string;
  targetPlayerName: string;
  characterName: string;
  characterClass: string;
  characterStats: {
    hp: number;
    maxHp: number;
    str: number;
    dex: number;
    int: number;
    wis: number;
    cha: number;
    con: number;
  } | null;
  diceType: string;
  reason: string;
  attemptNumber: number;
}

interface StatChange {
  playerId: string;
  stat: string;
  delta: number;
}

interface DiceResultData {
  playerId: string;
  playerName: string;
  characterName: string;
  characterClass: string;
  characterStats: {
    hp: number;
    maxHp: number;
    str: number;
    dex: number;
    int: number;
    wis: number;
    cha: number;
    con: number;
  } | null;
  diceType: string;
  rollValue: number;
  maxValue: number;
  source: string;
  outcome: string;
  reason: string;
  difficulty: string;
  statChanges: StatChange[];
  isBossFight?: boolean;
  bossHp?: number;
  bossMaxHp?: number;
  playerDied?: boolean;
  isCombat?: boolean;
  enemyHp?: number;
  enemyMaxHp?: number;
  enemyName?: string;
  isCrit?: boolean;
  critDamage?: number;
}

interface GameOverData {
  summary: string;
  totalTurns: number;
  playerStats: { playerId: string; playerName: string; finalStats: Record<string, number> }[];
}

export default function GameView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [game, setGame] = useState<GameDetails | null>(null);
  const [narratives, setNarratives] = useState<NarrativeEntry[]>([]);
  const [diceRequest, setDiceRequest] = useState<DiceRequest | null>(null);
  const [lastDiceResult, setLastDiceResult] = useState<DiceResultData | null>(null);
  const [diceHistory, setDiceHistory] = useState<DiceResultData[]>([]);
  const [gameOver, setGameOver] = useState<GameOverData | null>(null);
  const [rolling, setRolling] = useState(false);
  const [rollAnimation, setRollAnimation] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [showCharPanel, setShowCharPanel] = useState(true);
  const narrativeEndRef = useRef<HTMLDivElement>(null);

  // Get player info from session storage
  const stored = sessionId ? sessionStorage.getItem(`player_${sessionId}`) : null;
  const player = stored ? JSON.parse(stored) : null;

  // Load game info
  useEffect(() => {
    if (!sessionId) return;
    getGame(sessionId).then(setGame).catch((e) => setError(e.message));
  }, [sessionId]);

  // Hydrate from current game loop state (catch up on missed SSE events)
  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;

    const fetchState = async () => {
      try {
        const state = await getGameState(sessionId);
        if (cancelled) return;

        // Load narrative history
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
        }
        // Load dice request if waiting
        if (state.waitingForDice && state.diceRequest) {
          setDiceRequest(state.diceRequest);
        } else if (!state.waitingForDice) {
          setDiceRequest(null);
        }

        // Update game info
        if (state.status === 'completed') {
          setGameOver({ summary: 'The adventure has come to an end!', totalTurns: state.currentEvent, playerStats: [] });
        }
      } catch {
        // State may not exist yet if game hasn't started
      }
    };

    // Initial fetch
    fetchState();

    // Poll every 5 seconds as a fallback for missed SSE events
    const interval = setInterval(fetchState, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionId]);

  // SSE events
  const { connected } = useGameEvents({
    sessionId: sessionId || '',
    playerId: player?.playerId,
    onEvent: (event: SSEEvent) => {
      switch (event.type) {
        case 'narrative': {
          const data = event.data as { text: string; eventNumber: number; title: string; diceResult?: number; diceType?: string; outcome?: string; characterName?: string; characterClass?: string; playerName?: string };
          setNarratives((prev) => [...prev, {
            text: data.text,
            eventNumber: data.eventNumber,
            title: data.title,
            timestamp: event.timestamp,
            diceResult: data.diceResult ?? null,
            diceType: data.diceType ?? null,
            outcome: data.outcome ?? null,
            characterName: data.characterName,
            characterClass: data.characterClass,
            playerName: data.playerName,
          }]);
          setDiceRequest(null);
          setLastDiceResult(null);
          break;
        }
        case 'dice_request': {
          const data = event.data as DiceRequest;
          setDiceRequest(data);
          setLastDiceResult(null);
          break;
        }
        case 'dice_result': {
          const data = event.data as DiceResultData;
          setLastDiceResult(data);
          setDiceHistory((prev) => [...prev, data]);
          setDiceRequest(null);
          // Also update the last narrative entry with dice result for inline display
          setNarratives((prev) => {
            if (prev.length === 0) return prev;
            const updated = [...prev];
            const last = { ...updated[updated.length - 1] };
            last.diceResult = data.rollValue;
            last.diceType = data.diceType;
            last.outcome = data.outcome;
            last.characterName = data.characterName;
            last.characterClass = data.characterClass;
            last.statChanges = data.statChanges;
            updated[updated.length - 1] = last;
            return updated;
          });
          break;
        }
        case 'game_over': {
          const data = event.data as GameOverData;
          setGameOver(data);
          setDiceRequest(null);
          break;
        }
        case 'state_update': {
          if (sessionId) getGame(sessionId).then(setGame);
          break;
        }
      }
    },
  });

  // Auto-scroll to latest narrative
  useEffect(() => {
    narrativeEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [narratives, lastDiceResult]);

  const handleVirtualRoll = async () => {
    if (!sessionId || !diceRequest) return;
    setRolling(true);
    setError('');

    const animInterval = setInterval(() => {
      const max = parseInt(diceRequest.diceType.replace('d', ''));
      setRollAnimation(Math.floor(Math.random() * max) + 1);
    }, 100);

    try {
      const result = await rollVirtualDice(sessionId, diceRequest.diceType);
      clearInterval(animInterval);
      setRollAnimation(result.rollValue);
      setTimeout(() => setRollAnimation(null), 1000);
    } catch (e) {
      clearInterval(animInterval);
      setRollAnimation(null);
      setError(e instanceof Error ? e.message : 'Failed to roll');
    } finally {
      setRolling(false);
    }
  };

  const handleManualRoll = async (value: number) => {
    if (!sessionId || !diceRequest) return;
    setRolling(true);
    setError('');
    try {
      await submitDiceResult(sessionId, diceRequest.diceType, value, 'physical');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to submit');
    } finally {
      setRolling(false);
    }
  };

  if (!sessionId) return <div className="page-container"><p>Invalid session</p></div>;

  const getOutcomeClass = (result: DiceResultData): string => {
    if (!result.outcome) return '';
    return getOutcomeClassFromString(result.outcome);
  };

  const getOutcomeClassFromString = (outcome: string | null): string => {
    if (!outcome) return '';
    const o = outcome.toLowerCase();
    if (o.includes('critical success') || o.includes('crit!') || o.includes('critical hit') || o.includes('devastates')) return 'outcome-crit-success';
    if (o.includes('success') || o.includes('prevails') || o.includes('strikes') || o.includes('strike')) return 'outcome-success';
    if (o.includes('partial') || o.includes('mixed') || o.includes('weak blow') || o.includes('grazes')) return 'outcome-partial';
    if (o.includes('critical failure') || o.includes('disastrous') || o.includes('struck down')) return 'outcome-crit-fail';
    if (o.includes('failure') || o.includes('not go as planned') || o.includes('misses') || o.includes('miss')) return 'outcome-fail';
    return '';
  };

  const getOutcomeEmoji = (result: DiceResultData): string => {
    if (!result.outcome) return '🎲';
    return getOutcomeEmojiFromString(result.outcome);
  };

  const getOutcomeEmojiFromString = (outcome: string | null): string => {
    if (!outcome) return '🎲';
    const o = outcome.toLowerCase();
    if (o.includes('critical success') || o.includes('crit!') || o.includes('critical hit') || o.includes('devastates')) return '⚡';
    if (o.includes('success') || o.includes('prevails') || o.includes('strikes') || o.includes('strike')) return '✅';
    if (o.includes('partial') || o.includes('mixed') || o.includes('weak blow') || o.includes('grazes')) return '⚠️';
    if (o.includes('critical failure') || o.includes('disastrous') || o.includes('struck down')) return '💀';
    if (o.includes('failure') || o.includes('not go as planned') || o.includes('misses') || o.includes('miss')) return '❌';
    return '🎲';
  };

  const isMyTurn = diceRequest && player && diceRequest.targetPlayerId === player.playerId;
  const maxDie = diceRequest ? parseInt(diceRequest.diceType.replace('d', '')) : 20;

  // Get characters from game data
  const characters: Character[] = game?.lore?.suggestedCharacters || [];
  const gameStatus = game?.session?.status || 'unknown';
  const isCompleted = gameStatus === 'completed';

  // Helper to get character portrait by name
  const getCharacterPortrait = (characterName: string | undefined) => {
    if (!characterName) return <span>⚔️</span>;
    const char = characters.find(c => c.name === characterName);
    if (char?.portraitAssetId) {
      const src = char.portraitAssetId.startsWith('/api/') ? char.portraitAssetId : `/api/assets/${char.portraitAssetId}`;
      return <img src={src} alt={characterName} className="dice-char-portrait-img" />;
    }
    return <span>⚔️</span>;
  };

  return (
    <div className="page-container game-view">
      {/* Header */}
      <header className="game-header">
        <h1>⚔️ {game?.lore?.worldName || 'Adventure'}</h1>
        <div className="game-status">
          <span className={`connection-dot ${connected ? 'connected' : 'disconnected'}`} />
          <span>{connected ? 'Connected' : 'Reconnecting...'}</span>
          {game && (
            <span className="event-counter">
              {isCompleted ? '✅ Complete' : `Event ${game.session.currentEvent}/${game.session.totalEvents}`}
            </span>
          )}
          <button
            className="btn btn-sm btn-toggle-panel"
            onClick={() => setShowCharPanel(!showCharPanel)}
            aria-label="Toggle character panel"
          >
            {showCharPanel ? '👤 Hide Party' : '👤 Show Party'}
          </button>
        </div>
      </header>

      {error && <div className="form-error">{error}</div>}

      {/* Game Progress Bar */}
      {game && (
        <div className="game-progress-bar">
          <div className="progress-info">
            <span className="progress-label">
              {isCompleted ? '🏆 Adventure Complete' : '⚔️ Adventure in Progress'}
            </span>
            <span className="progress-stats">
              {game.session.currentEvent}/{game.session.totalEvents} events
              {game.players && ` • ${game.players.length} player${game.players.length !== 1 ? 's' : ''}`}
              {game.session.gameLength && ` • ${game.session.gameLength} campaign`}
            </span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${(game.session.currentEvent / game.session.totalEvents) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Game Over Banner */}
      {gameOver && (
        <div className="game-over-panel">
          <h2>🏆 Adventure Complete!</h2>
          <p>{gameOver.summary}</p>
          <p className="turns-count">Total events: {gameOver.totalTurns}</p>
          {gameOver.playerStats.length > 0 && (
            <div className="player-stats-grid">
              {gameOver.playerStats.map((ps) => (
                <div key={ps.playerId} className="stat-card">
                  <strong>{ps.playerName}</strong>
                  {Object.entries(ps.finalStats).map(([k, v]) => (
                    <span key={k}>{k}: {v}</span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Main game area */}
      <div className="game-layout">
        {/* Character & Game Info Sidebar */}
        {showCharPanel && (
          <aside className="game-sidebar">
            {/* Party Members */}
            <div className="sidebar-section">
              <h3>👥 Party</h3>
              {game?.players && game.players.length > 0 ? (
                <div className="party-list">
                  {game.players.map((p) => {
                    // Try to find a matching character from lore
                    const char = characters.find((c) =>
                      p.character?.id === c.id
                    ) || p.character;
                    return (
                      <div key={p.playerId} className="party-member">
                        <div className="party-member-header">
                          <span className="party-member-name">{p.playerName}</span>
                          {p.isHost && <span className="badge">HOST</span>}
                        </div>
                        {char && (
                          <CharacterCard character={char} compact />
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="sidebar-empty">No players yet</p>
              )}
            </div>

            {/* Available Characters (from lore) */}
            {characters.length > 0 && (
              <div className="sidebar-section">
                <h3>⚔️ Characters</h3>
                <div className="character-list-sidebar">
                  {characters.map((char) => (
                    <CharacterCard key={char.id} character={char} compact />
                  ))}
                </div>
              </div>
            )}

            {/* World Info */}
            {game?.lore && (
              <div className="sidebar-section">
                <h3>🗺️ World</h3>
                <p className="world-description">{game.lore.worldDescription}</p>
                {game.lore.locations && game.lore.locations.length > 0 && (
                  <div className="location-list">
                    <h4>Locations</h4>
                    {game.lore.locations.map((loc) => (
                      <div key={loc.id} className="location-item">
                        <span className="location-name">📍 {loc.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Dice Roll History */}
            {diceHistory.length > 0 && (
              <div className="sidebar-section">
                <h3>🎲 Roll History</h3>
                <div className="dice-history-list">
                  {diceHistory.slice(-10).reverse().map((roll, i) => (
                    <div key={i} className={`dice-history-item ${getOutcomeClass(roll)}`}>
                      <div className="dice-history-top">
                        <span className="dice-history-player">{roll.playerName}</span>
                        <span className="dice-history-die">{roll.diceType.toUpperCase()}</span>
                      </div>
                      <div className="dice-history-result">
                        <span className="dice-history-value">{roll.rollValue}</span>
                        <span className="dice-history-max">/{roll.maxValue || parseInt(roll.diceType.replace('d', ''))}</span>
                        {roll.outcome && (
                          <span className={`dice-history-outcome ${getOutcomeClass(roll)}`}>
                            {getOutcomeEmoji(roll)} {roll.outcome}
                          </span>
                        )}
                      </div>
                      {roll.reason && <span className="dice-history-reason">{roll.reason}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>
        )}

        {/* Narrative Panel */}
        <div className="narrative-panel">
          <h2>📜 Story</h2>
          <div className="narrative-scroll">
            {narratives.length === 0 && !gameOver && (
              <div className="narrative-waiting">
                <p>⏳ Waiting for the Dungeon Master...</p>
                <p className="hint">The DM is crafting your adventure. Stand by!</p>
              </div>
            )}
            {narratives.map((n, i) => (
              <div key={i}>
                <div className="narrative-entry">
                  <div className="narrative-header">
                    <span className="event-badge">Event {n.eventNumber}</span>
                    <span className="event-title">{n.title}</span>
                  </div>
                  <div className="narrative-text">
                    {n.text.split('\n').map((paragraph, pi) => (
                      <p key={pi}>{paragraph}</p>
                    ))}
                  </div>
                </div>
                {/* Dice Roll Result between events */}
                {n.diceResult !== null && (
                  <div className={`narrative-dice-result ${getOutcomeClassFromString(n.outcome)}`}>
                    {/* Character who rolled */}
                    {n.characterName && (
                      <div className="narrative-dice-character">
                        <span className="narrative-dice-char-icon">⚔️</span>
                        <span className="narrative-dice-char-name">{n.characterName}</span>
                        {n.characterClass && <span className="narrative-dice-char-class">{n.characterClass}</span>}
                      </div>
                    )}
                    <div className="narrative-dice-roll-info">
                      <div className="narrative-dice-visual">
                        <span className="narrative-dice-icon">🎲</span>
                        <span className="narrative-dice-type">{(n.diceType || 'd20').toUpperCase()}</span>
                        <span className="narrative-dice-value">{n.diceResult}</span>
                        <span className="narrative-dice-max">/ {parseInt((n.diceType || 'd20').replace('d', ''))}</span>
                      </div>
                      {n.outcome && (
                        <div className={`narrative-dice-outcome ${getOutcomeClassFromString(n.outcome)}`}>
                          <span className="narrative-outcome-emoji">{getOutcomeEmojiFromString(n.outcome)}</span>
                          <span className="narrative-outcome-text">{n.outcome}</span>
                        </div>
                      )}
                    </div>
                    {/* Stat changes */}
                    {n.statChanges && n.statChanges.length > 0 && (
                      <div className="narrative-stat-changes">
                        {n.statChanges.map((sc, si) => (
                          <span key={si} className={`stat-change ${sc.delta > 0 ? 'stat-up' : 'stat-down'}`}>
                            {sc.stat.toUpperCase()} {sc.delta > 0 ? '+' : ''}{sc.delta}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {lastDiceResult && (
              <div className={`dice-result-entry ${getOutcomeClass(lastDiceResult)} ${lastDiceResult.playerDied ? 'player-died' : ''}`}>
                {/* Character + Roll Header */}
                <div className="dice-result-character">
                  <div className="dice-char-avatar">
                    {getCharacterPortrait(lastDiceResult.characterName)}
                  </div>
                  <div className="dice-char-info">
                    <span className="dice-char-name">{lastDiceResult.characterName || lastDiceResult.playerName}</span>
                    <span className="dice-char-class">{lastDiceResult.characterClass || 'Adventurer'}</span>
                  </div>
                  {lastDiceResult.characterStats && (
                    <div className="dice-char-hp">
                      ❤️ {lastDiceResult.characterStats.hp}/{lastDiceResult.characterStats.maxHp}
                    </div>
                  )}
                </div>

                {/* Crit Action Splat */}
                {lastDiceResult.isCrit && (
                  <div className="crit-action-overlay">
                    <img
                      src={`/api/assets/crit-action/${lastDiceResult.critDamage || 20}/${lastDiceResult.rollValue}`}
                      alt="CRIT!"
                      className="crit-splat-img"
                    />
                  </div>
                )}

                {/* Roll Result */}
                <div className="dice-result-roll">
                  <div className="roll-die-visual">
                    <span className="roll-die-type">{lastDiceResult.diceType.toUpperCase()}</span>
                    <span className="roll-value">{lastDiceResult.rollValue}</span>
                    <span className="roll-max">/ {lastDiceResult.maxValue || parseInt(lastDiceResult.diceType.replace('d', ''))}</span>
                  </div>
                  <div className="roll-outcome-info">
                    <span className={`roll-outcome-badge ${getOutcomeClass(lastDiceResult)}`}>
                      {getOutcomeEmoji(lastDiceResult)} {lastDiceResult.outcome}
                    </span>
                    {(lastDiceResult.isBossFight || lastDiceResult.isCombat) && lastDiceResult.enemyHp !== undefined && (
                      <span className="boss-hp-display">
                        👹 {lastDiceResult.enemyName || 'Boss'} HP: {lastDiceResult.enemyHp}/{lastDiceResult.enemyMaxHp || lastDiceResult.bossMaxHp}
                      </span>
                    )}
                    {lastDiceResult.isBossFight && lastDiceResult.bossHp !== undefined && !lastDiceResult.isCombat && (
                      <span className="boss-hp-display">
                        👹 Boss HP: {lastDiceResult.bossHp}/{lastDiceResult.bossMaxHp}
                      </span>
                    )}
                  </div>
                </div>

                {/* Stat Changes */}
                {lastDiceResult.statChanges && lastDiceResult.statChanges.length > 0 && (
                  <div className="dice-stat-changes">
                    {lastDiceResult.statChanges.map((sc, i) => (
                      <span key={i} className={`stat-change ${sc.delta > 0 ? 'stat-up' : 'stat-down'}`}>
                        {sc.stat.toUpperCase()} {sc.delta > 0 ? '+' : ''}{sc.delta}
                      </span>
                    ))}
                  </div>
                )}

                {lastDiceResult.playerDied && (
                  <div className="player-death-banner">💀 {lastDiceResult.characterName} has fallen!</div>
                )}
              </div>
            )}
            <div ref={narrativeEndRef} />
          </div>
        </div>

        {/* Dice Panel */}
        <div className="dice-panel">
          <h2>🎲 Dice</h2>

          {!diceRequest && !gameOver && (
            <div className="dice-idle">
              {lastDiceResult ? (
                <div className="dice-last-roll">
                  <div className={`last-roll-badge ${getOutcomeClass(lastDiceResult)}`}>
                    <span className="last-roll-value">{lastDiceResult.rollValue}</span>
                    <span className="last-roll-die">{lastDiceResult.diceType.toUpperCase()}</span>
                  </div>
                  <p className={`last-roll-outcome ${getOutcomeClass(lastDiceResult)}`}>
                    {getOutcomeEmoji(lastDiceResult)} {lastDiceResult.outcome}
                  </p>
                  <p className="last-roll-waiting">Waiting for next event...</p>
                </div>
              ) : (
                <p>Waiting for the DM to request a roll...</p>
              )}
            </div>
          )}

          {/* Completed game dice summary */}
          {isCompleted && !diceRequest && (
            <div className="dice-idle">
              <div className="dice-complete-summary">
                <p>🏆 All dice have been cast!</p>
                {diceHistory.length > 0 && (
                  <p className="dice-summary-stat">
                    {diceHistory.length} total rolls this adventure
                  </p>
                )}
              </div>
            </div>
          )}

          {diceRequest && (
            <div className={`dice-request-card ${isMyTurn ? 'your-turn' : ''}`}>
              <div className="dice-request-header">
                {isMyTurn ? '🎯 Your Turn!' : `⏳ ${diceRequest.targetPlayerName}'s Turn`}
              </div>

              {/* Character Info */}
              <div className="dice-character-info">
                <span className="char-name-label">{diceRequest.characterName || diceRequest.targetPlayerName}</span>
                <span className="char-class-label">{diceRequest.characterClass || 'Adventurer'}</span>
                {diceRequest.characterStats && (
                  <div className="char-mini-stats">
                    <span className="mini-stat">❤️ {diceRequest.characterStats.hp}/{diceRequest.characterStats.maxHp}</span>
                    <span className="mini-stat">💪 {diceRequest.characterStats.str}</span>
                    <span className="mini-stat">🏃 {diceRequest.characterStats.dex}</span>
                    <span className="mini-stat">🧠 {diceRequest.characterStats.int}</span>
                    <span className="mini-stat">👁️ {diceRequest.characterStats.wis}</span>
                  </div>
                )}
              </div>

              <p className="dice-reason">{diceRequest.reason}</p>
              <div className="dice-type-badge">{diceRequest.diceType.toUpperCase()}</div>

              {/* Roll animation */}
              {rollAnimation !== null && (
                <div className="roll-animation">
                  <span className="roll-number">{rollAnimation}</span>
                </div>
              )}

              {/* Roll controls - only shown for active player */}
              {isMyTurn && !rolling && rollAnimation === null && (
                <div className="dice-controls">
                  <button onClick={handleVirtualRoll} className="btn btn-primary btn-roll">
                    🎲 Roll {diceRequest.diceType.toUpperCase()}
                  </button>
                  <div className="manual-roll">
                    <p className="manual-label">Or enter physical roll:</p>
                    <div className="manual-buttons">
                      {Array.from({ length: Math.min(maxDie, 20) }, (_, i) => i + 1).map((v) => (
                        <button
                          key={v}
                          onClick={() => handleManualRoll(v)}
                          className="btn btn-manual-die"
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {rolling && <p className="rolling-text">🎲 Rolling...</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
