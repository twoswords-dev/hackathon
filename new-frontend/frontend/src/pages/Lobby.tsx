import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getGame, joinGame, startGame, type GameDetails, type Player } from '../api/gameApi';
import { useGameEvents } from '../hooks/useGameEvents';

export default function Lobby() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [game, setGame] = useState<GameDetails | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [joinName, setJoinName] = useState('');
  const [joining, setJoining] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  // Load player from session storage
  useEffect(() => {
    if (sessionId) {
      const stored = sessionStorage.getItem(`player_${sessionId}`);
      if (stored) {
        setPlayer(JSON.parse(stored));
      }
    }
  }, [sessionId]);

  // Load game details
  useEffect(() => {
    if (!sessionId) return;
    getGame(sessionId).then(setGame).catch((e) => setError(e.message));
  }, [sessionId]);

  // SSE for real-time updates
  useGameEvents({
    sessionId: sessionId || '',
    playerId: player?.playerId,
    onEvent: (event) => {
      if (event.type === 'player_joined' || event.type === 'state_update') {
        if (sessionId) getGame(sessionId).then(setGame);
      }
      if (event.type === 'game_started') {
        navigate(`/game/${sessionId}`);
      }
    },
  });

  const handleJoin = async () => {
    if (!sessionId || !joinName.trim()) return;
    setJoining(true);
    setError('');
    try {
      const result = await joinGame(sessionId, joinName.trim());
      setPlayer(result.player);
      sessionStorage.setItem(`player_${sessionId}`, JSON.stringify({
        playerId: result.player.playerId,
        playerName: result.player.playerName,
        isHost: result.player.isHost,
      }));
      const updated = await getGame(sessionId);
      setGame(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to join');
    } finally {
      setJoining(false);
    }
  };

  const handleStartGame = async () => {
    if (!sessionId) return;
    setStarting(true);
    setError('');
    try {
      await startGame(sessionId);
      navigate(`/game/${sessionId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start game');
    } finally {
      setStarting(false);
    }
  };

  if (!sessionId) return <div className="page-lobby"><p>Invalid session</p></div>;

  // Not joined yet - show join form
  if (!player) {
    return (
      <div className="page-lobby">
        <h1 className="page-title">⚔️ Join Campaign</h1>
        <div className="lobby-card">
          <h2>Session: {sessionId.substring(0, 8)}...</h2>
          {game && <p className="lobby-world">World: <strong>{game.lore?.worldName}</strong></p>}
          <div className="join-form">
            <input
              type="text"
              placeholder="Enter your name..."
              value={joinName}
              onChange={(e) => setJoinName(e.target.value)}
              className="form-input"
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
            />
            <button onClick={handleJoin} disabled={joining} className="btn-primary">
              {joining ? 'Joining...' : 'Join Game'}
            </button>
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
      </div>
    );
  }

  // Joined - show lobby
  return (
    <div className="page-lobby">
      <h1 className="page-title">🏰 {game?.lore?.worldName || 'Loading...'}</h1>

      <div className="lobby-layout">
        {/* World Info */}
        <div className="lobby-section">
          <h2>📜 World Lore</h2>
          <p className="lore-text">{game?.lore?.worldDescription}</p>
          {game?.lore?.factions && game.lore.factions.length > 0 && (
            <div className="factions-list">
              <h3>Factions</h3>
              {game.lore.factions.map((f) => (
                <div key={f.id} className="faction-item">
                  <strong>{f.name}</strong>: {f.description}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Players */}
        <div className="lobby-section">
          <h2>👥 Players ({game?.players.length}/{game?.session.maxPlayers})</h2>
          <div className="player-list">
            {game?.players.map((p) => (
              <div key={p.playerId} className={`player-item ${p.playerId === player.playerId ? 'you' : ''}`}>
                <span className="player-name">{p.playerName}</span>
                {p.isHost && <span className="badge">HOST</span>}
                {p.playerId === player.playerId && <span className="badge badge-you">YOU</span>}
              </div>
            ))}
          </div>

          <div className="invite-section">
            <p>Share this link to invite players:</p>
            <code className="invite-link">{window.location.origin}/lobby/{sessionId}</code>
          </div>
        </div>

        {/* Characters */}
        {game?.lore?.suggestedCharacters && game.lore.suggestedCharacters.length > 0 && (
          <div className="lobby-section lobby-section--full">
            <h2>⚔️ Characters</h2>
            <div className="character-grid">
              {game.lore.suggestedCharacters.map((char) => (
                <div key={char.id} className="character-card-mini">
                  <h4>{char.name}</h4>
                  <span className="char-class">{char.race} {char.class}</span>
                  <p className="char-desc">{char.description}</p>
                  <div className="char-stats-mini">
                    <span>❤️ {char.stats.hp}</span>
                    <span>💪 {char.stats.str}</span>
                    <span>🏃 {char.stats.dex}</span>
                    <span>🧠 {char.stats.int}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Start Game */}
        {player.isHost && (
          <div className="lobby-section lobby-start">
            <button onClick={handleStartGame} disabled={starting} className="btn-primary btn-large">
              {starting ? '⏳ Starting...' : '🎲 Start Adventure'}
            </button>
          </div>
        )}

        {error && <div className="form-error">{error}</div>}
      </div>
    </div>
  );
}
