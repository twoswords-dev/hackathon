import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createGame,
  getCharacterOptions,
  characterPreviewUrl,
  type CharacterOptions,
  type CharacterStats,
} from '../api/gameApi';

const SOURCE_PRESETS = [
  { label: '🧙 Lord of the Rings', value: 'Lord of the Rings' },
  { label: '⚡ Star Wars', value: 'Star Wars' },
  { label: '🐉 Game of Thrones', value: 'Game of Thrones' },
  { label: '🧛 Castlevania', value: 'Castlevania' },
  { label: '🦸 Marvel Universe', value: 'Marvel Universe' },
  { label: '✨ Custom...', value: '' },
];

const CLASS_ICONS: Record<string, string> = {
  Warrior: '🗡️',
  Mage: '🔮',
  Rogue: '🏹',
  Cleric: '✨',
};

const RACE_ICONS: Record<string, string> = {
  Human: '🧑',
  Elf: '🧝',
  Dwarf: '🧔',
  Halfling: '🧒',
};

export default function CreateGame() {
  const navigate = useNavigate();
  const [sourceMaterial, setSourceMaterial] = useState('');
  const [customSource, setCustomSource] = useState('');
  const [gameLength, setGameLength] = useState<'short' | 'medium' | 'long'>('short');
  const [playerCount, setPlayerCount] = useState(2);
  const [hostName, setHostName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Character creation
  const [options, setOptions] = useState<CharacterOptions | null>(null);
  const [charName, setCharName] = useState('');
  const [charRace, setCharRace] = useState('Human');
  const [charClass, setCharClass] = useState('Warrior');

  useEffect(() => {
    getCharacterOptions()
      .then(setOptions)
      .catch(() => {
        // Fall back to the known-supported sets if the lookup fails.
        setOptions({
          races: ['Human', 'Elf', 'Dwarf', 'Halfling'],
          classes: ['Warrior', 'Mage', 'Rogue', 'Cleric'],
          statsByCombo: [],
        });
      });
  }, []);

  // Stat line the server will produce for the current race/class pick
  const previewStats: CharacterStats | null =
    options?.statsByCombo.find((c) => c.race === charRace && c.class === charClass)?.stats ?? null;

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
        customCharacter: {
          name: charName.trim() || hostName.trim(),
          race: charRace,
          class: charClass,
        },
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

        {/* ---- Character creation ---- */}
        <div className="form-section char-create">
          <label className="form-label">Your Character</label>
          <p className="form-hint">
            Build the hero you will play. Pixel art and stats update as you choose.
          </p>

          <div className="char-create__body">
            <div className="char-create__preview">
              <img
                className="pixel-portrait pixel-portrait--large"
                src={characterPreviewUrl({ race: charRace, class: charClass, name: charName || hostName })}
                alt={`Pixel art preview of a ${charRace} ${charClass}`}
                width={128}
                height={128}
              />
              <strong className="char-create__preview-name">
                {charName || hostName || 'Unnamed Hero'}
              </strong>
              <span className="char-create__preview-sub">{charRace} {charClass}</span>

              {previewStats && (
                <div className="char-create__stats">
                  <span className="char-create__hp">❤️ {previewStats.hp} HP</span>
                  <div className="char-create__stat-grid">
                    <span>STR {previewStats.str}</span>
                    <span>DEX {previewStats.dex}</span>
                    <span>INT {previewStats.int}</span>
                    <span>WIS {previewStats.wis}</span>
                    <span>CHA {previewStats.cha}</span>
                    <span>CON {previewStats.con}</span>
                  </div>
                </div>
              )}
            </div>

            <div className="char-create__fields">
              <label className="form-label form-label--sub" htmlFor="char-name">
                Character Name
              </label>
              <input
                id="char-name"
                type="text"
                placeholder={hostName ? `e.g. ${hostName} the Bold` : 'Name your hero...'}
                value={charName}
                onChange={(e) => setCharName(e.target.value)}
                className="form-input"
                maxLength={24}
              />

              <span className="form-label form-label--sub" id="race-label">Race</span>
              <div className="chip-grid" role="group" aria-labelledby="race-label">
                {(options?.races ?? []).map((race) => (
                  <button
                    key={race}
                    type="button"
                    className={`chip ${charRace === race ? 'chip--active' : ''}`}
                    onClick={() => setCharRace(race)}
                    aria-pressed={charRace === race}
                  >
                    <span aria-hidden="true">{RACE_ICONS[race] ?? '🎭'}</span> {race}
                  </button>
                ))}
              </div>

              <span className="form-label form-label--sub" id="class-label">Class</span>
              <div className="chip-grid" role="group" aria-labelledby="class-label">
                {(options?.classes ?? []).map((cls) => (
                  <button
                    key={cls}
                    type="button"
                    className={`chip ${charClass === cls ? 'chip--active' : ''}`}
                    onClick={() => setCharClass(cls)}
                    aria-pressed={charClass === cls}
                  >
                    <span aria-hidden="true">{CLASS_ICONS[cls] ?? '⚔️'}</span> {cls}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

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
