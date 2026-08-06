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
 * Generate an SVG pixel art portrait for a character.
 */
export function generateCharacterSVG(character: CharacterInput): string {
  const racePalette = RACE_PALETTES[character.race] || RACE_PALETTES.Human;
  const classPalette = CLASS_PALETTES[character.class] || CLASS_PALETTES.Warrior;
  const template = CLASS_TEMPLATES[character.class] || CLASS_TEMPLATES.Warrior;

  // Merge palettes: race (1-6) + class (7-9)
  const palette: Record<number, string> = { ...racePalette, ...classPalette };

  const pixelSize = 8; // Each pixel is 8x8 SVG units
  const gridSize = 16;
  const svgSize = gridSize * pixelSize;

  let pixels = '';
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const colorIndex = template[y]?.[x] || 0;
      if (colorIndex === 0) continue; // transparent

      const color = palette[colorIndex] || '#FF00FF'; // magenta for missing colors
      pixels += `<rect x="${x * pixelSize}" y="${y * pixelSize}" width="${pixelSize}" height="${pixelSize}" fill="${color}"/>`;
    }
  }

  // Add a subtle background
  const bgColor = getClassBgColor(character.class);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgSize} ${svgSize}" width="${svgSize}" height="${svgSize}" style="image-rendering: pixelated;">
  <rect width="${svgSize}" height="${svgSize}" fill="${bgColor}" rx="4"/>
  ${pixels}
  <text x="${svgSize / 2}" y="${svgSize - 2}" font-family="monospace" font-size="6" fill="white" text-anchor="middle" opacity="0.8">${character.name.substring(0, 10)}</text>
</svg>`;
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
