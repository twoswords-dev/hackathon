import { Character } from '../api/gameApi';

interface CharacterCardProps {
  character: Character;
  selected?: boolean;
  compact?: boolean;
  onClick?: () => void;
}

export default function CharacterCard({ character, selected, compact, onClick }: CharacterCardProps) {
  const stats = character.stats;

  return (
    <div
      className={`character-card ${selected ? 'selected' : ''} ${compact ? 'compact' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className="char-portrait">
        {character.portraitAssetId ? (
          <img
            src={character.portraitAssetId.startsWith('/api/') ? character.portraitAssetId : `/api/assets/${character.portraitAssetId}`}
            alt={character.name}
            className="char-portrait-img"
          />
        ) : (
          <div className="char-portrait-placeholder">⚔️</div>
        )}
      </div>

      <div className="char-info">
        <h3 className="char-name">{character.name}</h3>
        <div className="char-class">{character.race} {character.class}</div>
        {!compact && <p className="char-desc">{character.description}</p>}
      </div>

      <div className="char-stats">
        <StatBar label="HP" value={stats.hp} max={stats.maxHp} color="#e53935" />
        <div className="stat-grid">
          <StatPill label="STR" value={stats.str} />
          <StatPill label="DEX" value={stats.dex} />
          <StatPill label="INT" value={stats.int} />
          <StatPill label="WIS" value={stats.wis} />
          <StatPill label="CHA" value={stats.cha} />
          <StatPill label="CON" value={stats.con} />
        </div>
      </div>

      {!compact && character.inventory && character.inventory.length > 0 && (
        <div className="char-inventory">
          <h4>Inventory</h4>
          {character.inventory.map((item) => (
            <span key={item.id} className="inventory-item">
              {item.name} {item.quantity > 1 ? `x${item.quantity}` : ''}
            </span>
          ))}
        </div>
      )}

      {selected && <div className="selected-indicator">✓ Selected</div>}
    </div>
  );
}

function StatBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.round((value / max) * 100);
  return (
    <div className="stat-bar">
      <span className="stat-label">{label}</span>
      <div className="stat-bar-track">
        <div className="stat-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="stat-value">{value}/{max}</span>
    </div>
  );
}

function StatPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-pill">
      <span className="stat-pill-label">{label}</span>
      <span className="stat-pill-value">{value}</span>
    </div>
  );
}
