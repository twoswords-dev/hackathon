import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getGame, joinGame, startGame, selectCharacter, type GameDetails, type Player } from '../api/gameApi';
import { useGameEvents } from '../hooks/useGameEvents';
import CharacterCard from '../components/CharacterCard';

export default function Lobby() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [game, setGame] = useState<GameDetails | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [joinName, setJoinName] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');
  const [selectedCharacter, setSelectedCharacter] = useState<string>('');
  const [selectingCharacter, setSelectingCharacter] = useState(false);

  const handleSelectCharacter = async (characterId: string) => {
    if (!sessionId || !player || selectingCharacter) return;
    setSelectingCharacter(true);
    setError('');
    try {
      const result = await selectCharacter(sessionId, player.playerId, characterId);
      setSelectedCharacter(characterId);
      setPlayer(result.player);
      sessionStorage.setItem(`player_${sessionId}`, JSON.stringify(result.player));
      // Refresh game to see updated player list
      const updated = await getGame(sessionId);
      setGame(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to select character');
    } finally {
      setSelectingCharacter(false);
    }
  };

  // Load player from session storage
  useEffect(() => {
    if (sessionId) {
      const stored = sessionStorage.getItem(`player_${sessionId}`);
      if (stored) {
        const p = JSON.parse(stored);
        setPlayer(p);
        if (p.character?.id) {
          setSelectedCharacter(p.character.id);
        }
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
      if (event.type === 'player_joined' || event.type === 'game_started') {
        // Refresh game data
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
      sessionStorage.setItem(`player_${sessionId}`, JSON.stringify(result.player));
      // Refresh game
      const updated = await getGame(sessionId);
      setGame(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to join');
    } finally {
      setJoining(false);
    }
  };

  const [starting, setStarting] = useState(false);

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

  if (!sessionId) return <div>Invalid session</div>;

  // Not joined yet - show join form
  if (!player) {
    return (
      <div className="page-container">
        <h1>⚔️ Join Campaign</h1>
        <div className="card">
          <h2>Session: {sessionId.substring(0, 8)}...</h2>
          {game && <p>World: <strong>{game.lore?.worldName}</strong></p>}
          <div className="join-form">
            <input
              type="text"
              placeholder="Enter your name..."
              value={joinName}
              onChange={(e) => setJoinName(e.target.value)}
              className="form-input"
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
            />
            <button onClick={handleJoin} disabled={joining} className="btn btn-primary">
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
    <div className="page-container">
      <h1>🏰 {game?.lore?.worldName || 'Loading...'}</h1>

      <div className="lobby-layout">
        {/* World Info */}
        <div className="lobby-section">
          <h2>📜 World Lore</h2>
          <p className="lore-text">{game?.lore?.worldDescription}</p>
          {game?.lore?.factions && game.lore.factions.length > 0 && (
            <div className="factions">
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
                {p.playerId === player.playerId && <span className="badge you-badge">YOU</span>}
              </div>
            ))}
          </div>

          <div className="invite-section">
            <p>Share this link to invite players:</p>
            <code className="invite-link">{window.location.origin}/lobby/{sessionId}</code>
          </div>
        </div>

        {/* Character Selection */}
        <div className="lobby-section full-width">
          <h2>⚔️ Choose Your Character</h2>
          <div className="character-grid">
            {game?.lore?.suggestedCharacters.map((char) => {
              const claimedBy = game.players.find(p => p.character?.id === char.id);
              const isMine = claimedBy?.playerId === player.playerId;
              const isTaken = !!claimedBy && !isMine;
              return (
                <div key={char.id} className={`character-select-wrapper ${isTaken ? 'taken' : ''}`}>
                  <CharacterCard
                    character={char}
                    selected={selectedCharacter === char.id || isMine}
                    onClick={() => !isTaken && handleSelectCharacter(char.id)}
                  />
                  {isTaken && (
                    <div className="character-claimed-badge">
                      Claimed by {claimedBy.playerName}
                    </div>
                  )}
                  {isMine && (
                    <div className="character-yours-badge">✓ Your Character</div>
                  )}
                </div>
              );
            })}
          </div>
          {selectingCharacter && <p className="selecting-text">Selecting character...</p>}
        </div>

        {/* Start Game */}
        {player.isHost && (
          <div className="lobby-section">
            <button onClick={handleStartGame} disabled={starting} className="btn btn-primary btn-large">
              {starting ? '⏳ Starting...' : '🎲 Start Adventure'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
