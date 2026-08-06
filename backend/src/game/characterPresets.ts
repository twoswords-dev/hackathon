import { Character, CharacterStats } from '../types/game';

/**
 * Races and classes that have pixel-art templates in svgTemplates.ts.
 *
 * The character creator only offers these so a created character always has
 * matching art instead of silently falling back to Human/Warrior.
 */
export const SUPPORTED_RACES = ['Human', 'Elf', 'Dwarf', 'Halfling'] as const;
export const SUPPORTED_CLASSES = ['Warrior', 'Mage', 'Rogue', 'Cleric'] as const;

export type SupportedRace = (typeof SUPPORTED_RACES)[number];
export type SupportedClass = (typeof SUPPORTED_CLASSES)[number];

/**
 * Base stat lines per class. Deliberately balanced: same stat total (78 plus HP),
 * distributed to match the class fantasy.
 */
const CLASS_BASE_STATS: Record<SupportedClass, CharacterStats> = {
  Warrior: { hp: 90, maxHp: 90, str: 17, dex: 12, int: 9, wis: 10, cha: 12, con: 16 },
  Mage: { hp: 65, maxHp: 65, str: 9, dex: 12, int: 18, wis: 15, cha: 13, con: 10 },
  Rogue: { hp: 75, maxHp: 75, str: 12, dex: 18, int: 13, wis: 11, cha: 14, con: 11 },
  Cleric: { hp: 80, maxHp: 80, str: 12, dex: 10, int: 12, wis: 17, cha: 14, con: 13 },
};

/**
 * Small racial modifiers, applied on top of the class base line.
 */
const RACE_MODIFIERS: Record<SupportedRace, Partial<CharacterStats>> = {
  Human: { cha: 1, wis: 1 },
  Elf: { dex: 2, int: 1, hp: -5, maxHp: -5 },
  Dwarf: { con: 2, str: 1, hp: 5, maxHp: 5, dex: -1 },
  Halfling: { dex: 2, cha: 1, str: -1 },
};

function normalizeChoice<T extends string>(input: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof input !== 'string') return fallback;
  const match = allowed.find((option) => option.toLowerCase() === input.trim().toLowerCase());
  return match || fallback;
}

export function normalizeRace(input: unknown): SupportedRace {
  return normalizeChoice(input, SUPPORTED_RACES, 'Human');
}

export function normalizeClass(input: unknown): SupportedClass {
  return normalizeChoice(input, SUPPORTED_CLASSES, 'Warrior');
}

/**
 * Compute the stat line for a race/class combination.
 */
export function statsFor(race: SupportedRace, characterClass: SupportedClass): CharacterStats {
  const stats: CharacterStats = { ...CLASS_BASE_STATS[characterClass] };
  const modifiers = RACE_MODIFIERS[race];

  for (const [key, delta] of Object.entries(modifiers)) {
    const stat = key as keyof CharacterStats;
    stats[stat] = Math.max(1, stats[stat] + (delta ?? 0));
  }

  // HP and maxHp must agree for a freshly created character.
  stats.maxHp = stats.hp;
  return stats;
}

/**
 * Build a full Character from the minimal input the create-game form collects.
 */
export function buildCustomCharacter(params: {
  id: string;
  name?: unknown;
  race?: unknown;
  class?: unknown;
  description?: unknown;
}): Character {
  const race = normalizeRace(params.race);
  const characterClass = normalizeClass(params.class);

  const rawName = typeof params.name === 'string' ? params.name.trim() : '';
  const name = (rawName || `${race} ${characterClass}`).substring(0, 24);

  const rawDescription = typeof params.description === 'string' ? params.description.trim() : '';
  const description = (rawDescription || `A ${race.toLowerCase()} ${characterClass.toLowerCase()} of your own making.`).substring(0, 120);

  return {
    id: params.id,
    name,
    class: characterClass,
    race,
    description,
    portraitAssetId: '',
    stats: statsFor(race, characterClass),
    statusEffects: [],
    inventory: [],
  };
}
