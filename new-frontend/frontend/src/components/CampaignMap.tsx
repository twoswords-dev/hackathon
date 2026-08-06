import type { GameMap } from "../api/gameApi";
import "./CampaignMap.css";

interface CampaignMapProps {
  map: GameMap | null;
  /** Illustrated overview image; absent until background generation finishes. */
  campaignMapUrl?: string | null;
  worldName?: string;
}

/**
 * Terrain glyph and colour per tile type. Keys match the backend TerrainType
 * union, so an unknown value falls back to plains rather than rendering blank.
 */
const TERRAIN_STYLE: Record<string, { icon: string; color: string; label: string }> = {
  forest: { icon: "🌲", color: "#2e5d34", label: "Forest" },
  mountain: { icon: "⛰️", color: "#5d5750", label: "Mountain" },
  town: { icon: "🏘️", color: "#8a6d3b", label: "Town" },
  dungeon: { icon: "🕳️", color: "#2b2233", label: "Dungeon" },
  plains: { icon: "🌾", color: "#6b7a3a", label: "Plains" },
  river: { icon: "🌊", color: "#2b5d7a", label: "River" },
  cave: { icon: "🦇", color: "#33302b", label: "Cave" },
  castle: { icon: "🏰", color: "#6b5f7a", label: "Castle" },
  swamp: { icon: "🐸", color: "#3f4a2b", label: "Swamp" },
  desert: { icon: "🏜️", color: "#9c7b45", label: "Desert" },
  snow: { icon: "❄️", color: "#8fa9bf", label: "Snow" },
};

const FALLBACK = TERRAIN_STYLE.plains;

export default function CampaignMap({ map, campaignMapUrl, worldName }: CampaignMapProps) {
  if (!map || !map.tiles || map.tiles.length === 0) {
    return (
      <div className="campaign-map campaign-map--empty">
        <p className="campaign-map__pending">🗺️ The cartographers are still at work...</p>
      </div>
    );
  }

  // Sort defensively: tile order from storage is not guaranteed, and the grid
  // relies on row-major order.
  const tiles = [...map.tiles].sort((a, b) => (a.y - b.y) || (a.x - b.x));

  // Which terrains actually appear, for the legend.
  const present = Array.from(new Set(tiles.map((t) => t.terrain)));

  return (
    <div className="campaign-map">
      {campaignMapUrl ? (
        <img
          className="campaign-map__illustration"
          src={campaignMapUrl}
          alt={`Illustrated campaign map of ${worldName || "the campaign world"}`}
          loading="lazy"
        />
      ) : (
        <p className="campaign-map__pending">
          🖌️ Illustrating the world map... it will appear here shortly.
        </p>
      )}

      <div
        className="campaign-map__grid"
        style={{ gridTemplateColumns: `repeat(${map.width}, 1fr)` }}
        role="img"
        aria-label={`Campaign map grid, ${map.width} by ${map.height} tiles`}
      >
        {tiles.map((tile) => {
          const style = TERRAIN_STYLE[tile.terrain] || FALLBACK;
          return (
            <div
              key={`${tile.x},${tile.y}`}
              className={`map-tile${tile.isPoi ? " map-tile--poi" : ""}`}
              style={{ backgroundColor: style.color }}
              title={tile.name ? `${tile.name} (${style.label})` : style.label}
            >
              <span className="map-tile__icon" aria-hidden="true">{style.icon}</span>
              {tile.isPoi && tile.name && (
                <span className="map-tile__name">{tile.name}</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="campaign-map__legend">
        {present.map((terrain) => {
          const style = TERRAIN_STYLE[terrain] || FALLBACK;
          return (
            <span key={terrain} className="map-legend__item">
              <span aria-hidden="true">{style.icon}</span> {style.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
