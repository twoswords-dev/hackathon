import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  getGame,
  joinGame,
  startGame,
  selectCharacter,
  characterPortraitUrl,
  type GameDetails,
  type Player,
} from '../api/gameApi';
import { useGameEvents } from '../hooks/useGameEvents';

export default function Lobby() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [game, setGame] = useState<GameDetails | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [joinName, setJoinName] = useState('');
  const [joining, setJoining] = useState(false);
  const [starting, setStarting] = useState(false);
  const [selectingId, setSelectingId] = useState<string | null>(null);
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

  const handleSelectCharacter = async (characterId: string) => {
    if (!sessionId || !player) return;
    setSelectingId(characterId);
    setError('');
    try {
      await selectCharacter(sessionId, player.playerId, characterId);
      const updated = await getGame(sessionId);
      setGame(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to select character');
    } finally {
      setSelectingId(null);
    }
  };

  // Who owns which character, so the roster can show claims
  const claimedBy = new Map<string, Player>();
  for (const p of game?.players ?? []) {
    if (p.character?.id) claimedBy.set(p.character.id, p);
  }
  const myCharacterId = game?.players.find((p) => p.playerId === player?.playerId)?.character?.id;

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
                {p.character && sessionId && (
                  <img
                    className="pixel-portrait pixel-portrait--tiny"
                    src={characterPortraitUrl(sessionId, p.character)}
                    alt={`Portrait of ${p.character.name}`}
                    width={32}
                    height={32}
                  />
                )}
                <span className="player-name">{p.playerName}</span>
                {p.character && <span className="player-char">as {p.character.name}</span>}
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
        {game?.lore?.suggestedCharacters && game.lore.suggestedCharacters.length > 0 && sessionId && (
          <div className="lobby-section lobby-section--full">
            <h2>⚔️ Choose Your Character</h2>
            <p className="form-hint">
              {myCharacterId
                ? 'You can change your pick until the adventure starts.'
                : 'Click a character to claim it. Unclaimed players get one assigned automatically.'}
            </p>
            <div className="character-grid">
              {game.lore.suggestedCharacters.map((char) => {
                const owner = claimedBy.get(char.id);
                const isMine = char.id === myCharacterId;
                const takenByOther = owner && owner.playerId !== player.playerId;

                return (
                  <button
                    key={char.id}
                    type="button"
                    className={`character-card-mini ${isMine ? 'character-card-mini--mine' : ''} ${takenByOther ? 'character-card-mini--taken' : ''}`}
                    onClick={() => !takenByOther && handleSelectCharacter(char.id)}
                    disabled={!!takenByOther || selectingId === char.id}
                    aria-pressed={isMine}
                    aria-label={`Choose ${char.name}, ${char.race} ${char.class}`}
                  >
                    <img
                      className="pixel-portrait"
                      src={characterPortraitUrl(sessionId, char)}
                      alt={`Pixel art portrait of ${char.name}`}
                      width={80}
                      height={80}
                    />
                    <h4>{char.name}</h4>
                    <span className="char-class">{char.race} {char.class}</span>
                    <p className="char-desc">{char.description}</p>
                    <div className="char-stats-mini">
                      <span>❤️ {char.stats.hp}</span>
                      <span>💪 {char.stats.str}</span>
                      <span>🏃 {char.stats.dex}</span>
                      <span>🧠 {char.stats.int}</span>
                    </div>
                    {isMine && <span className="char-claim char-claim--mine">✓ Your character</span>}
                    {takenByOther && <span className="char-claim">Taken by {owner!.playerName}</span>}
                    {selectingId === char.id && <span className="char-claim">Claiming...</span>}
                  </button>
                );
              })}
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
