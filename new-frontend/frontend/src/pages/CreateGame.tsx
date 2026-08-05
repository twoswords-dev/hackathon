import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createGame } from '../api/gameApi';

const SOURCE_PRESETS = [
  { label: '🧙 Lord of the Rings', value: 'Lord of the Rings' },
  { label: '⚡ Star Wars', value: 'Star Wars' },
  { label: '🐉 Game of Thrones', value: 'Game of Thrones' },
  { label: '🧛 Castlevania', value: 'Castlevania' },
  { label: '🦸 Marvel Universe', value: 'Marvel Universe' },
  { label: '✨ Custom...', value: '' },
];

export default function CreateGame() {
  const navigate = useNavigate();
  const [sourceMaterial, setSourceMaterial] = useState('');
  const [customSource, setCustomSource] = useState('');
  const [gameLength, setGameLength] = useState<'short' | 'medium' | 'long'>('short');
  const [playerCount, setPlayerCount] = useState(2);
  const [hostName, setHostName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const source = sourceMaterial || customSource;
    if (!source) {
      setError('Please select or enter source material');
      setLoading(false);
      return;
    }
    if (!hostName.trim()) {
      setError('Please enter your name');
      setLoading(false);
      return;
    }

    try {
      const result = await createGame({
        sourceMaterial: source,
        gameLength,
        playerCount,
        hostName: hostName.trim(),
      });

      sessionStorage.setItem(`player_${result.sessionId}`, JSON.stringify({
        playerId: result.player.playerId,
        playerName: result.player.playerName,
        isHost: result.player.isHost,
      }));

      navigate(`/lobby/${result.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create game');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-create">
      <h1 className="page-title">⚔️ Create New Campaign</h1>

      <form onSubmit={handleSubmit} className="create-form">
        <div className="form-section">
          <label className="form-label">Source Material</label>
          <p className="form-hint">Choose a world to base your campaign on</p>
          <div className="preset-grid">
            {SOURCE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={`preset-btn ${sourceMaterial === preset.value ? 'active' : ''}`}
                onClick={() => {
                  setSourceMaterial(preset.value);
                  if (preset.value) setCustomSource('');
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          {sourceMaterial === '' && (
            <input
              type="text"
              placeholder="Describe your custom world..."
              value={customSource}
              onChange={(e) => setCustomSource(e.target.value)}
              className="form-input"
            />
          )}
        </div>

        <div className="form-section">
          <label className="form-label">Game Length</label>
          <div className="length-selector">
            {(['short', 'medium', 'long'] as const).map((len) => (
              <button
                key={len}
                type="button"
                className={`length-btn ${gameLength === len ? 'active' : ''}`}
                onClick={() => setGameLength(len)}
              >
                <strong>{len.charAt(0).toUpperCase() + len.slice(1)}</strong>
                <span>{len === 'short' ? '~5 events' : len === 'medium' ? '~15 events' : '~30 events'}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="form-row">
          <div className="form-section">
            <label className="form-label">Players</label>
            <select
              value={playerCount}
              onChange={(e) => setPlayerCount(Number(e.target.value))}
              className="form-input"
            >
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>{n} {n === 1 ? 'player' : 'players'}</option>
              ))}
            </select>
          </div>

          <div className="form-section">
            <label className="form-label">Your Name</label>
            <input
              type="text"
              placeholder="Enter your name..."
              value={hostName}
              onChange={(e) => setHostName(e.target.value)}
              className="form-input"
              required
            />
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <button type="submit" className="btn-primary btn-large" disabled={loading}>
          {loading ? '🎲 Generating World...' : '✨ Create Campaign'}
        </button>

        {loading && (
          <p className="loading-hint">AI is crafting your world. This may take 15-30 seconds...</p>
        )}
      </form>
    </div>
  );
}
