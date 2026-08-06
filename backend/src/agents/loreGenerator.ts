import { invokeClaudeModel, MODELS } from './bedrockClient';
import { WorldLore, GameLength, GAME_LENGTH_EVENTS, Character, DiceType } from '../types/game';
import { v4 as uuidv4 } from 'uuid';

const LORE_SYSTEM_PROMPT = `You are a world-building AI for a Dungeons & Dragons game engine. Your job is to create game worlds based on source material provided by the player.

IMPORTANT: Keep ALL text fields very short (under 100 characters each) for testing purposes.

You must output ONLY valid JSON (no markdown, no explanation text) matching this exact schema:

{
  "worldName": "string - creative name (max 30 chars)",
  "worldDescription": "string - 1 sentence max, under 100 chars",
  "sourceMaterial": "string - the original source material reference",
  "locations": [
    {
      "id": "string - unique id",
      "name": "string - max 20 chars",
      "description": "string - max 50 chars",
      "tileX": number (0-7),
      "tileY": number (0-7)
    }
  ],
  "factions": [
    {
      "id": "string - unique id",
      "name": "string - max 20 chars",
      "description": "string - max 50 chars",
      "alignment": "string - e.g. lawful good, chaotic evil, neutral"
    }
  ],
  "eventOutlines": [
    {
      "eventNumber": number (starting at 1),
      "title": "string - max 30 chars",
      "description": "string - max 80 chars",
      "locationId": "string - reference to a location id",
      "difficulty": "easy" | "medium" | "hard",
      "requiredDiceType": "d4" | "d6" | "d8" | "d10" | "d12" | "d20",
      "type": "narrative" | "combat",
      "enemyName": "string (only for combat type) - max 25 chars",
      "enemyHp": number (only for combat type, 20-80 based on difficulty)
    }
  ],
  "campaignMapDescription": "string - short map description, max 80 chars",
  "suggestedCharacters": [
    {
      "id": "string - unique id",
      "name": "string - max 20 chars",
      "class": "string - e.g. Warrior, Mage, Rogue, Cleric",
      "race": "string - e.g. Human, Elf, Dwarf, Halfling",
      "description": "string - max 50 chars",
      "portraitAssetId": "",
      "stats": {
        "hp": number (50-100),
        "maxHp": number (same as hp),
        "str": number (8-18),
        "dex": number (8-18),
        "int": number (8-18),
        "wis": number (8-18),
        "cha": number (8-18),
        "con": number (8-18)
      },
      "statusEffects": [],
      "inventory": [
        {
          "id": "string",
          "name": "string - max 20 chars",
          "description": "string - max 40 chars",
          "type": "weapon" | "armor" | "potion" | "misc",
          "quantity": number
        }
      ]
    }
  ]
}

Rules:
- Generate the EXACT number of events specified
- Create 3-4 locations on an 8x8 grid
- Create 2 factions
- Generate 4 suggested characters with varied classes
- ALL text fields must be very short (under 100 chars) - this is for testing
- Stats should be balanced but varied per class
- Make 30-40% of events "combat" type with enemyName and enemyHp. The rest should be "narrative" type.
- Combat enemyHp: easy=20-30, medium=30-50, hard=50-80
- The LAST event should always be "narrative" (the final boss is handled separately by the engine)`;

/**
 * Generate world lore from source material using Bedrock Claude.
 */
export async function generateLore(params: {
  sourceMaterial: string;
  gameLength: GameLength;
  playerCount: number;
}): Promise<WorldLore> {
  const { sourceMaterial, gameLength, playerCount } = params;
  const eventCount = GAME_LENGTH_EVENTS[gameLength];

  const userMessage = `Create a D&D game world based on the following source material: "${sourceMaterial}"

Requirements:
- Game length: ${gameLength} (exactly ${eventCount} events)
- Number of players: ${playerCount}
- Generate exactly ${eventCount} event outlines
- Generate exactly ${Math.max(4, playerCount)} suggested characters so players have choices

Make it epic, immersive, and fun!`;

  console.log(`[LoreGenerator] Generating lore for "${sourceMaterial}" (${gameLength}, ${eventCount} events)...`);

  const responseText = await invokeClaudeModel({
    modelId: MODELS.loreGenerator,
    systemPrompt: LORE_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 4096,
    temperature: 0.8,
  });

  // Parse the JSON response
  let loreData: WorldLore;
  try {
    // Try to extract JSON from the response (in case model wraps it in markdown)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON object found in response');
    }
    loreData = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[LoreGenerator] Failed to parse response:', responseText.substring(0, 500));
    throw new Error(`Failed to parse lore generation response: ${err}`);
  }

  // Validate and fix up the response
  loreData = validateAndFixLore(loreData, eventCount, playerCount);

  console.log(`[LoreGenerator] Generated: ${loreData.worldName} with ${loreData.eventOutlines.length} events, ${loreData.suggestedCharacters.length} characters`);

  return loreData;
}

/**
 * Validate the generated lore and fix common issues.
 */
function validateAndFixLore(lore: WorldLore, expectedEvents: number, playerCount: number): WorldLore {
  // Ensure IDs are set
  if (!lore.locations) lore.locations = [];
  for (const loc of lore.locations) {
    if (!loc.id) loc.id = uuidv4();
  }

  if (!lore.factions) lore.factions = [];
  for (const faction of lore.factions) {
    if (!faction.id) faction.id = uuidv4();
  }

  // Validate event count
  if (!lore.eventOutlines) lore.eventOutlines = [];
  if (lore.eventOutlines.length < expectedEvents) {
    console.warn(`[LoreGenerator] Only ${lore.eventOutlines.length}/${expectedEvents} events generated, padding...`);
    while (lore.eventOutlines.length < expectedEvents) {
      const n = lore.eventOutlines.length + 1;
      const isCombat = n % 3 === 0; // every 3rd padded event is combat
      const diff = n > expectedEvents * 0.7 ? 'hard' : n > expectedEvents * 0.3 ? 'medium' : 'easy';
      lore.eventOutlines.push({
        eventNumber: n,
        title: isCombat ? `Combat ${n}` : `Event ${n}`,
        description: isCombat ? `A dangerous foe blocks the path.` : `A challenging encounter awaits the adventurers.`,
        locationId: lore.locations[0]?.id || 'unknown',
        difficulty: diff,
        requiredDiceType: 'd20' as DiceType,
        type: isCombat ? 'combat' : 'narrative',
        enemyName: isCombat ? `Shadow Beast` : undefined,
        enemyHp: isCombat ? (diff === 'hard' ? 60 : diff === 'medium' ? 40 : 25) : undefined,
      });
    }
  }

  // Ensure event numbers are sequential and validate combat fields
  lore.eventOutlines = lore.eventOutlines.slice(0, expectedEvents);
  lore.eventOutlines.forEach((event, i) => {
    event.eventNumber = i + 1;
    if (!event.type) event.type = 'narrative';
    if (event.type === 'combat') {
      if (!event.enemyName) event.enemyName = 'Dark Creature';
      if (!event.enemyHp) {
        event.enemyHp = event.difficulty === 'hard' ? 60 : event.difficulty === 'medium' ? 40 : 25;
      }
    }
  });

  // Validate characters
  if (!lore.suggestedCharacters) lore.suggestedCharacters = [];
  const minChars = Math.max(4, playerCount);
  if (lore.suggestedCharacters.length < minChars) {
    console.warn(`[LoreGenerator] Only ${lore.suggestedCharacters.length}/${minChars} characters, adding defaults...`);
    const defaultChars: Partial<Character>[] = [
      { name: 'Thorin', class: 'Warrior', race: 'Dwarf', description: 'A stout warrior with a braided beard.' },
      { name: 'Lyra', class: 'Mage', race: 'Elf', description: 'A graceful elf with arcane markings.' },
      { name: 'Finn', class: 'Rogue', race: 'Halfling', description: 'A quick-fingered trickster with a grin.' },
      { name: 'Brother Marcus', class: 'Cleric', race: 'Human', description: 'A devoted healer with a warm smile.' },
    ];

    while (lore.suggestedCharacters.length < minChars) {
      const template = defaultChars[lore.suggestedCharacters.length % defaultChars.length];
      lore.suggestedCharacters.push({
        id: uuidv4(),
        name: template.name || 'Adventurer',
        class: template.class || 'Warrior',
        race: template.race || 'Human',
        description: template.description || 'A brave adventurer.',
        portraitAssetId: '',
        stats: { hp: 75, maxHp: 75, str: 12, dex: 12, int: 12, wis: 12, cha: 12, con: 12 },
        statusEffects: [],
        inventory: [],
      });
    }
  }

  // Ensure all characters have IDs and valid stats
  for (const char of lore.suggestedCharacters) {
    if (!char.id) char.id = uuidv4();
    if (!char.stats) {
      char.stats = { hp: 75, maxHp: 75, str: 12, dex: 12, int: 12, wis: 12, cha: 12, con: 12 };
    }
    if (!char.stats.maxHp) char.stats.maxHp = char.stats.hp;
    if (!char.statusEffects) char.statusEffects = [];
    if (!char.inventory) char.inventory = [];
    if (!char.portraitAssetId) char.portraitAssetId = '';
  }

  return lore;
}
