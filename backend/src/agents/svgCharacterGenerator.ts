/**
 * SVG Pixel Art Character Generator
 * Generates 16x16 pixel art portraits as SVG based on character class and race.
 * Also generates crit action splat overlays.
 */

import { RACE_PALETTES, CLASS_PALETTES, CLASS_TEMPLATES, CRIT_EFFECTS } from './svgTemplates';

interface CharacterInput {
  name: string;
  class: string;
  race: string;
  stats?: { hp: number; maxHp: number; str: number; dex: number; int: number; wis: number; cha: number; con: number };
}

/**
 * How battered the portrait should look. Derived from the live HP ratio so the
 * art tracks damage taken during play.
 */
export type InjuryTier = 'healthy' | 'bruised' | 'wounded' | 'critical' | 'downed';

/** Wound colours, layered over the body pixels. */
const WOUND_COLOR = '#8E1616';
const WOUND_DARK = '#5C0D0D';
const BRUISE_COLOR = '#5B3A6E';

/**
 * Classify an HP ratio into an injury tier.
 *
 * 0 HP is `downed` rather than merely critical: the engine treats a character at
 * 0 as out of the adventure, and the portrait should say so unmistakably.
 */
export function injuryTierFor(hp: number, maxHp: number): InjuryTier {
  if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0) return 'healthy';
  if (hp <= 0) return 'downed';
  const ratio = hp / maxHp;
  if (ratio > 0.75) return 'healthy';
  if (ratio > 0.5) return 'bruised';
  if (ratio > 0.25) return 'wounded';
  return 'critical';
}

/** Number of wound marks to scatter for each tier. */
const WOUND_COUNT: Record<InjuryTier, number> = {
  healthy: 0,
  bruised: 2,
  wounded: 4,
  critical: 7,
  downed: 8,
};

/**
 * Deterministic hash so a given character always takes wounds in the same
 * places. Without this the marks would jump around on every re-render.
 */
function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
function makeRng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convert a hex colour to its greyscale equivalent (for downed portraits). */
function toGreyscale(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // Rec. 601 luma, then darkened so downed clearly reads as "out".
  const y = Math.round((0.299 * r + 0.587 * g + 0.114 * b) * 0.75);
  const c = Math.max(0, Math.min(255, y)).toString(16).padStart(2, '0');
  return `#${c}${c}${c}`;
}

/** Blend a colour toward white to render blood loss as pallor. */
function paleFy(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (channel: number) => Math.round(channel + (235 - channel) * amount);
  const r = mix((n >> 16) & 0xff);
  const g = mix((n >> 8) & 0xff);
  const b = mix(n & 0xff);
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

/** How much pallor each tier applies to skin tones. */
const PALLOR: Record<InjuryTier, number> = {
  healthy: 0,
  bruised: 0.08,
  wounded: 0.22,
  critical: 0.4,
  downed: 0,
};

/**
 * Generate an SVG pixel art portrait for a character.
 *
 * When stats are supplied the portrait reflects damage: skin pales, wounds are
 * scattered over the body, and a downed character is rendered grey with crossed
 * out eyes.
 */
export function generateCharacterSVG(character: CharacterInput): string {
  const racePalette = RACE_PALETTES[character.race] || RACE_PALETTES.Human;
  const classPalette = CLASS_PALETTES[character.class] || CLASS_PALETTES.Warrior;
  const template = CLASS_TEMPLATES[character.class] || CLASS_TEMPLATES.Warrior;

  const tier = character.stats
    ? injuryTierFor(character.stats.hp, character.stats.maxHp)
    : 'healthy';

  // Merge palettes: race (1-6) + class (7-9)
  let palette: Record<number, string> = { ...racePalette, ...classPalette };

  // Skin (1) and skin shadow (2) drain of colour as the character weakens.
  const pallor = PALLOR[tier];
  if (pallor > 0) {
    palette = { ...palette, 1: paleFy(palette[1], pallor), 2: paleFy(palette[2], pallor) };
  }

  // A downed hero is rendered entirely in greys.
  if (tier === 'downed') {
    palette = Object.fromEntries(
      Object.entries(palette).map(([k, v]) => [k, toGreyscale(v)])
    ) as Record<number, string>;
  }

  const pixelSize = 8; // Each pixel is 8x8 SVG units
  const gridSize = 16;
  const svgSize = gridSize * pixelSize;

  let pixels = '';
  // Track which cells are part of the body so wounds only land on the figure.
  const bodyCells: { x: number; y: number }[] = [];

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const colorIndex = template[y]?.[x] || 0;
      if (colorIndex === 0) continue; // transparent

      const color = palette[colorIndex] || '#FF00FF'; // magenta for missing colors
      pixels += `<rect x="${x * pixelSize}" y="${y * pixelSize}" width="${pixelSize}" height="${pixelSize}" fill="${color}"/>`;

      // Eyes (5) and eye detail (6) are excluded so wounds never cover the face
      // in a way that reads as a rendering glitch.
      if (colorIndex !== 5 && colorIndex !== 6) {
        bodyCells.push({ x, y });
      }
    }
  }

  // Scatter wounds deterministically across the body.
  const woundCount = WOUND_COUNT[tier];
  if (woundCount > 0 && bodyCells.length > 0) {
    const rng = makeRng(hashString(`${character.name}|${character.class}|${character.race}`));
    // Shuffle a copy so each wound lands on a distinct cell.
    const shuffled = [...bodyCells];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const marks = shuffled.slice(0, Math.min(woundCount, shuffled.length));
    marks.forEach((cell, i) => {
      // Light damage shows as bruising; heavier damage as open wounds.
      const color = tier === 'bruised' ? BRUISE_COLOR : i % 3 === 0 ? WOUND_DARK : WOUND_COLOR;
      pixels += `<rect x="${cell.x * pixelSize}" y="${cell.y * pixelSize}" width="${pixelSize}" height="${pixelSize}" fill="${color}" opacity="0.85"/>`;
    });
  }

  // Crossed-out eyes make a downed character unmistakable at a glance.
  if (tier === 'downed') {
    const eyeCells = [];
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        if (template[y]?.[x] === 5) eyeCells.push({ x, y });
      }
    }
    for (const cell of eyeCells) {
      const cx = cell.x * pixelSize;
      const cy = cell.y * pixelSize;
      pixels += `<path d="M${cx} ${cy} L${cx + pixelSize} ${cy + pixelSize} M${cx + pixelSize} ${cy} L${cx} ${cy + pixelSize}" stroke="${WOUND_COLOR}" stroke-width="2" fill="none"/>`;
    }
  }

  // Add a subtle background
  const bgColor = tier === 'downed' ? '#1A1A1A' : getClassBgColor(character.class);

  const label = character.name.substring(0, 10);
  const statusLabel = tier === 'downed' ? 'DOWNED' : tier === 'critical' ? 'CRITICAL' : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgSize} ${svgSize}" width="${svgSize}" height="${svgSize}" style="image-rendering: pixelated;" role="img" aria-label="${escapeXmlAttr(character.name)}, ${escapeXmlAttr(character.race)} ${escapeXmlAttr(character.class)}${statusLabel ? `, ${statusLabel.toLowerCase()}` : ''}">
  <rect width="${svgSize}" height="${svgSize}" fill="${bgColor}" rx="4"/>
  ${pixels}${
    statusLabel
      ? `\n  <text x="${svgSize / 2}" y="10" font-family="monospace" font-size="8" font-weight="bold" fill="${WOUND_COLOR}" text-anchor="middle">${statusLabel}</text>`
      : ''
  }
  <text x="${svgSize / 2}" y="${svgSize - 2}" font-family="monospace" font-size="6" fill="white" text-anchor="middle" opacity="0.8">${escapeXmlAttr(label)}</text>
</svg>`;
}

/** Escape text destined for an XML attribute or text node. */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate a crit action splat SVG with damage number.
 */
export function generateCritActionSVG(damageAmount: number, diceRoll: number): string {
  const size = 128;
  const effect = diceRoll === 20 ? CRIT_EFFECTS.explosion : CRIT_EFFECTS.slash;

  // Star burst / explosion shape
  const points = generateStarPoints(size / 2, size / 2, size * 0.45, size * 0.25, 12);
  const innerPoints = generateStarPoints(size / 2, size / 2, size * 0.3, size * 0.15, 8);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <!-- Outer burst -->
  <polygon points="${points}" fill="${effect.color1}" stroke="${effect.outline}" stroke-width="2">
    <animate attributeName="opacity" values="1;0.8;1" dur="0.5s" repeatCount="indefinite"/>
  </polygon>
  <!-- Inner burst -->
  <polygon points="${innerPoints}" fill="${effect.color2}">
    <animate attributeName="opacity" values="0.9;1;0.9" dur="0.3s" repeatCount="indefinite"/>
  </polygon>
  <!-- Center glow -->
  <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.18}" fill="${effect.color3}" opacity="0.7">
    <animate attributeName="r" values="${size * 0.15};${size * 0.2};${size * 0.15}" dur="0.4s" repeatCount="indefinite"/>
  </circle>
  <!-- Damage number -->
  <text x="${size / 2}" y="${size / 2 + 8}" font-family="Impact, sans-serif" font-size="32" font-weight="bold" fill="${effect.textColor}" stroke="${effect.outline}" stroke-width="2" text-anchor="middle">${damageAmount}</text>
  <!-- "CRIT!" label -->
  <text x="${size / 2}" y="${size / 2 - 18}" font-family="Impact, sans-serif" font-size="16" font-weight="bold" fill="${effect.color2}" stroke="${effect.outline}" stroke-width="1" text-anchor="middle">CRIT!</text>
  <!-- Dice roll badge -->
  <circle cx="${size - 20}" cy="20" r="14" fill="#333" stroke="${effect.color2}" stroke-width="2"/>
  <text x="${size - 20}" y="25" font-family="monospace" font-size="12" font-weight="bold" fill="white" text-anchor="middle">${diceRoll}</text>
</svg>`;
}

/**
 * Generate a hit action SVG (non-crit combat hit).
 */
export function generateHitActionSVG(damageAmount: number, diceRoll: number): string {
  const size = 96;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <!-- Impact circle -->
  <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.35}" fill="none" stroke="#FFD700" stroke-width="3" opacity="0.8">
    <animate attributeName="r" values="${size * 0.3};${size * 0.4};${size * 0.35}" dur="0.6s" repeatCount="1"/>
  </circle>
  <!-- Damage number -->
  <text x="${size / 2}" y="${size / 2 + 6}" font-family="Impact, sans-serif" font-size="24" font-weight="bold" fill="#FFD700" stroke="#333" stroke-width="1.5" text-anchor="middle">${damageAmount}</text>
  <!-- "HIT" label -->
  <text x="${size / 2}" y="${size / 2 - 14}" font-family="Impact, sans-serif" font-size="12" fill="#FFF" stroke="#333" stroke-width="1" text-anchor="middle">HIT</text>
  <!-- Dice badge -->
  <circle cx="${size - 16}" cy="16" r="11" fill="#333" stroke="#FFD700" stroke-width="1.5"/>
  <text x="${size - 16}" y="20" font-family="monospace" font-size="10" fill="white" text-anchor="middle">${diceRoll}</text>
</svg>`;
}

/**
 * Generate star/burst polygon points for the crit splat.
 */
function generateStarPoints(cx: number, cy: number, outerR: number, innerR: number, numPoints: number): string {
  const points: string[] = [];
  for (let i = 0; i < numPoints * 2; i++) {
    const angle = (i * Math.PI) / numPoints - Math.PI / 2;
    const r = i % 2 === 0 ? outerR : innerR;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return points.join(' ');
}

/**
 * Get a background color based on class.
 */
function getClassBgColor(charClass: string): string {
  switch (charClass) {
    case 'Warrior': return '#2C1810';
    case 'Mage': return '#1A0A2E';
    case 'Rogue': return '#1A2C1A';
    case 'Cleric': return '#2C2A10';
    default: return '#1A1A2E';
  }
}
