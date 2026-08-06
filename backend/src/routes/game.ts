import { Router, Request, Response } from 'express';
import { gameSessions, players, gameState, gameEvents } from '../db';
import { generateLore } from '../agents/loreGenerator';
import { generateGameAssets, generateImage } from '../agents/imageGenerator';
import { startGameLoop, handleDiceResult, isGameRunning, getStepInfo, getRequestedDiceType } from '../game/gameLoop';
import { buildCustomCharacter, SUPPORTED_RACES, SUPPORTED_CLASSES, statsFor, normalizeRace, normalizeClass } from '../game/characterPresets';
import { sseManager } from '../sse';
import { CreateGameRequest, GameLength, GAME_LENGTH_EVENTS, GameMap, MapTile, TerrainType, Character, CharacterStats, SUPPORTED_DICE, DEFAULT_DICE_TYPE, parseDiceType, diceFaces } from '../types/game';

const router = Router();

/**
 * POST /api/game/create
 * Create a new game session with AI-generated lore.
 */
router.post('/create', async (req: Request, res: Response) => {
  try {
    const { sourceMaterial, gameLength, playerCount, hostName, customCharacter } = req.body as CreateGameRequest & {
      customCharacter?: { name?: string; race?: string; class?: string; description?: string };
    };

    // Validate inputs
    if (!sourceMaterial || !gameLength || !playerCount || !hostName) {
      return res.status(400).json({
        error: 'Missing required fields: sourceMaterial, gameLength, playerCount, hostName',
      });
    }

    if (!['short', 'medium', 'long'].includes(gameLength)) {
      return res.status(400).json({
        error: 'gameLength must be "short", "medium", or "long"',
      });
    }

    if (playerCount < 1 || playerCount > 6) {
      return res.status(400).json({ error: 'playerCount must be between 1 and 6' });
    }

    console.log(`[GameCreate] Creating game: "${sourceMaterial}" (${gameLength}, ${playerCount} players)`);

    // 1. Create the game session in DynamoDB
    const session = await gameSessions.createGameSession({
      gameLength: gameLength as GameLength,
      sourceMaterial,
      createdBy: hostName,
      maxPlayers: playerCount,
    });

    console.log(`[GameCreate] Session created: ${session.sessionId}`);

    // 2. Add the host as the first player
    const hostPlayer = await players.addPlayer({
      sessionId: session.sessionId,
      playerName: hostName,
      isHost: true,
    });

    console.log(`[GameCreate] Host player added: ${hostPlayer.playerId}`);

    // 3. Generate lore using Bedrock
    console.log(`[GameCreate] Generating lore with Bedrock...`);
    const worldLore = await generateLore({
      sourceMaterial,
      gameLength: gameLength as GameLength,
      playerCount,
    });

    // 4. Create initial map from lore — terrain follows the world the prompt
    // described rather than being randomised.
    const map = createInitialMap({
      locations: worldLore.locations.map((l) => ({
        name: l.name,
        x: l.tileX,
        y: l.tileY,
        terrain: l.terrain,
      })),
      dominantTerrain: worldLore.dominantTerrain,
      worldDescription: worldLore.worldDescription,
      campaignMapDescription: worldLore.campaignMapDescription,
      sourceMaterial,
      seed: session.sessionId,
    });

    // 4b. If the host created their own character, put it at the front of the
    // roster so it is the obvious pick, and auto-assign it to them.
    let hostCharacter: Character | null = null;
    if (customCharacter && (customCharacter.name || customCharacter.race || customCharacter.class)) {
      hostCharacter = buildCustomCharacter({
        id: `custom-${hostPlayer.playerId.substring(0, 8)}`,
        name: customCharacter.name,
        race: customCharacter.race,
        class: customCharacter.class,
        description: customCharacter.description,
      });
      worldLore.suggestedCharacters.unshift(hostCharacter);
      console.log(`[GameCreate] Custom character: ${hostCharacter.name} (${hostCharacter.race} ${hostCharacter.class})`);
    }

    // 4c. Assign SVG pixel art portrait URLs to characters
    for (const char of worldLore.suggestedCharacters) {
      char.portraitAssetId = `/api/assets/character/${session.sessionId}/${char.id}/svg`;
    }

    // 5. Store game state with lore and map
    const state = await gameState.createGameState({
      sessionId: session.sessionId,
      worldLore,
      map,
      turnOrder: [hostPlayer.playerId],
    });

    console.log(`[GameCreate] Game state created with ${worldLore.eventOutlines.length} events`);

    // 5b. Assign the custom character now that its portrait URL is set.
    let responsePlayer = hostPlayer;
    if (hostCharacter) {
      responsePlayer = await players.assignCharacter(
        session.sessionId,
        hostPlayer.playerId,
        hostCharacter
      );
    }

    // 6. Return response
    res.status(201).json({
      sessionId: session.sessionId,
      session,
      player: responsePlayer,
      lore: {
        worldName: worldLore.worldName,
        worldDescription: worldLore.worldDescription,
        adventureSummary: worldLore.adventureSummary,
        locations: worldLore.locations,
        factions: worldLore.factions,
        eventCount: worldLore.eventOutlines.length,
        characterCount: worldLore.suggestedCharacters.length,
        suggestedCharacters: worldLore.suggestedCharacters,
      },
      map,
    });

    // 7. Illustrate the campaign map. This previously never ran — the generator
    // was imported but never called, so campaignMapAssetId stayed empty and no
    // map was ever drawn. It takes ~10s, so it runs after the response and
    // announces itself over SSE when ready rather than delaying game creation.
    void generateCampaignMap({
      sessionId: session.sessionId,
      worldName: worldLore.worldName,
      campaignMapDescription: worldLore.campaignMapDescription,
      worldDescription: worldLore.worldDescription,
      dominantTerrain: worldLore.dominantTerrain,
      locations: worldLore.locations,
      sourceMaterial,
    });
  } catch (err) {
    console.error('[GameCreate] Error:', err);
    res.status(500).json({
      error: 'Failed to create game',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/game/character-options
 * Race/class choices for the character creator, with the stat line each
 * combination produces. Served from the same source the engine uses so the
 * preview always matches what gets created.
 */
router.get('/character-options', (_req: Request, res: Response) => {
  res.json({
    races: SUPPORTED_RACES,
    classes: SUPPORTED_CLASSES,
    statsByCombo: SUPPORTED_RACES.flatMap((race) =>
      SUPPORTED_CLASSES.map((cls) => ({ race, class: cls, stats: statsFor(race, cls) }))
    ),
  });
});

/**
 * GET /api/game/:sessionId
 * Get game session details
 */
/**
 * GET /api/game/dice-options
 * The dice the engine supports, so the UI never offers an unsupported die.
 */
router.get('/dice-options', (_req: Request, res: Response) => {
  res.json({ supportedDice: SUPPORTED_DICE, defaultDice: DEFAULT_DICE_TYPE });
});

router.get('/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const session = await gameSessions.getGameSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const sessionPlayers = await players.getSessionPlayers(sessionId);
    const state = await gameState.getGameState(sessionId);

    res.json({
      session,
      players: sessionPlayers,
      lore: state ? {
        worldName: state.worldLore.worldName,
        worldDescription: state.worldLore.worldDescription,
        adventureSummary: state.worldLore.adventureSummary,
        locations: state.worldLore.locations,
        factions: state.worldLore.factions,
        suggestedCharacters: state.worldLore.suggestedCharacters,
        eventCount: state.worldLore.eventOutlines.length,
      } : null,
      map: state?.map || null,
      campaignMapUrl:
        state?.map?.campaignMapAssetId
          ? `/api/assets/${sessionId}/campaign_map/${state.map.campaignMapAssetId}`
          : null,
    });
  } catch (err) {
    console.error('[GameGet] Error:', err);
    res.status(500).json({ error: 'Failed to get game session' });
  }
});

/**
 * POST /api/game/:sessionId/join
 * Join an existing game session
 */
router.post('/:sessionId/join', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { playerName } = req.body;

    if (!playerName) {
      return res.status(400).json({ error: 'playerName is required' });
    }

    const session = await gameSessions.getGameSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'waiting_for_players') {
      return res.status(400).json({ error: 'Game already in progress' });
    }

    const currentPlayers = await players.getSessionPlayers(sessionId);
    if (currentPlayers.length >= session.maxPlayers) {
      return res.status(400).json({ error: 'Game is full' });
    }

    const player = await players.addPlayer({
      sessionId,
      playerName,
      isHost: false,
    });

    // Broadcast to other connected clients
    sseManager.emit(sessionId, 'player_joined', {
      playerId: player.playerId,
      playerName: player.playerName,
      totalPlayers: currentPlayers.length + 1,
    });

    res.status(201).json({ player, session });
  } catch (err) {
    console.error('[GameJoin] Error:', err);
    res.status(500).json({ error: 'Failed to join game' });
  }
});

/**
 * POST /api/game/:sessionId/select-character
 * Select a character for a player (during lobby)
 */
router.post('/:sessionId/select-character', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { playerId, characterId } = req.body;

    if (!playerId || !characterId) {
      return res.status(400).json({ error: 'playerId and characterId are required' });
    }

    const session = await gameSessions.getGameSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'waiting_for_players') {
      return res.status(400).json({ error: 'Cannot select character after game has started' });
    }

    const state = await gameState.getGameState(sessionId);
    if (!state) {
      return res.status(404).json({ error: 'Game state not found' });
    }

    // Find the character in the lore
    const character = state.worldLore.suggestedCharacters.find(c => c.id === characterId);
    if (!character) {
      return res.status(404).json({ error: 'Character not found in this game' });
    }

    // Check if character is already taken by another player
    const sessionPlayers = await players.getSessionPlayers(sessionId);
    const alreadyTaken = sessionPlayers.find(
      p => p.character?.id === characterId && p.playerId !== playerId
    );
    if (alreadyTaken) {
      return res.status(409).json({
        error: `Character "${character.name}" is already taken by ${alreadyTaken.playerName}`,
      });
    }

    // Verify the player exists in this session
    const player = sessionPlayers.find(p => p.playerId === playerId);
    if (!player) {
      return res.status(404).json({ error: 'Player not found in this session' });
    }

    // Assign the character
    const updatedPlayer = await players.assignCharacter(sessionId, playerId, character);

    // Broadcast so other players see the selection
    sseManager.emit(sessionId, 'player_joined', {
      playerId: updatedPlayer.playerId,
      playerName: updatedPlayer.playerName,
      characterId: character.id,
      characterName: character.name,
      totalPlayers: sessionPlayers.length,
    });

    console.log(`[CharSelect] ${updatedPlayer.playerName} selected ${character.name} (${character.class})`);

    res.json({ player: updatedPlayer });
  } catch (err) {
    console.error('[CharSelect] Error:', err);
    res.status(500).json({ error: 'Failed to select character' });
  }
});

/**
 * Illustrate the campaign map from the lore and attach it to the session.
 *
 * Runs in the background: image generation takes several seconds and must not
 * hold up game creation. On completion the asset id is persisted and pushed to
 * clients via `map_update`, so the lobby can show the map as soon as it exists.
 * Failures are logged and swallowed — the tile grid is still playable without an
 * illustration.
 */
async function generateCampaignMap(params: {
  sessionId: string;
  worldName: string;
  campaignMapDescription?: string;
  worldDescription?: string;
  dominantTerrain?: string;
  locations: { name: string; terrain?: string }[];
  sourceMaterial: string;
}): Promise<void> {
  const {
    sessionId,
    worldName,
    campaignMapDescription,
    worldDescription,
    dominantTerrain,
    locations,
    sourceMaterial,
  } = params;

  try {
    // Build the prompt from the world the model actually described, so the
    // picture matches the campaign instead of being generic fantasy art.
    const landmarks = locations
      .slice(0, 5)
      .map((l) => (l.terrain ? `${l.name} (${l.terrain})` : l.name))
      .filter(Boolean)
      .join(', ');

    const promptParts = [
      'Top-down fantasy campaign map on aged parchment, hand-drawn cartography,',
      'ink linework with muted watercolour wash, compass rose, no text labels.',
      `World: ${worldName}.`,
      dominantTerrain ? `Predominant terrain: ${dominantTerrain}.` : '',
      campaignMapDescription ? `Map: ${campaignMapDescription}` : '',
      worldDescription ? `Setting: ${worldDescription}` : '',
      landmarks ? `Key locations to depict: ${landmarks}.` : '',
      `Inspired by ${sourceMaterial}.`,
    ];

    const prompt = promptParts.filter(Boolean).join(' ').substring(0, 1800);

    console.log(`[GameCreate] Illustrating campaign map for ${worldName}...`);

    const result = await generateImage({
      sessionId,
      prompt,
      imageType: 'campaign_map',
      label: `${worldName} Campaign Map`,
    });

    const updated = await gameState.setCampaignMapAsset(sessionId, result.assetId);
    if (!updated) {
      console.warn(`[GameCreate] Map generated but session ${sessionId} no longer exists`);
      return;
    }

    console.log(
      `[GameCreate] Campaign map ready for ${worldName} (assetId=${result.assetId}, aiGenerated=${result.generated})`
    );

    sseManager.emit(sessionId, 'map_update', {
      campaignMapAssetId: result.assetId,
      campaignMapUrl: `/api/assets/${sessionId}/campaign_map/${result.assetId}`,
      generated: result.generated,
    });
  } catch (err) {
    console.error('[GameCreate] Campaign map generation failed:', err);
  }
}

/**
 * Valid terrain values, used to sanitise model output.
 */
const TERRAIN_VALUES: TerrainType[] = [
  'forest', 'mountain', 'town', 'dungeon', 'plains', 'river', 'cave', 'castle', 'swamp', 'desert', 'snow',
];

/**
 * Terrain keywords to look for when the model gives us nothing usable.
 *
 * Order matters: snow is tested before desert so a "frozen wasteland" is not
 * classified as desert on the word "waste".
 */
const TERRAIN_KEYWORDS: [RegExp, TerrainType][] = [
  [/snow|ice|icy|frozen|frost|tundra|arctic|glacier|winter|blizzard/i, 'snow'],
  [/desert|dune|sand|waste|arrakis|tatooine/i, 'desert'],
  [/swamp|marsh|bog|fen|mire/i, 'swamp'],
  [/mountain|peak|alp|summit|crag|misty/i, 'mountain'],
  [/forest|wood|jungle|grove|shire|tree/i, 'forest'],
  [/cave|cavern|tunnel|mine|underdark/i, 'cave'],
  [/river|lake|sea|coast|ocean|water|isle|island/i, 'river'],
  [/castle|keep|fortress|citadel|palace/i, 'castle'],
  [/dungeon|crypt|tomb|catacomb|lair/i, 'dungeon'],
  [/city|town|village|market|port|hold/i, 'town'],
  [/plain|field|meadow|steppe|grass/i, 'plains'],
];

/**
 * Infer terrain from free text, so a world described as a desert does not end up
 * rendered as swamp.
 */
function inferTerrain(...sources: (string | undefined)[]): TerrainType | null {
  const haystack = sources.filter(Boolean).join(' ');
  if (!haystack) return null;
  for (const [pattern, terrain] of TERRAIN_KEYWORDS) {
    if (pattern.test(haystack)) return terrain;
  }
  return null;
}

/** Coerce a model-supplied terrain string to a valid TerrainType. */
function parseTerrain(value: unknown): TerrainType | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toLowerCase() as TerrainType;
  return TERRAIN_VALUES.includes(candidate) ? candidate : null;
}

/**
 * Build the 8x8 tile grid from the lore.
 *
 * Terrain used to be assigned with Math.random(), so a desert campaign could be
 * rendered as swamp and the same session produced a different map on every
 * call. Tiles are now derived from the world's own terrain: each location keeps
 * the terrain the lore gave it, and the surrounding tiles blend the dominant
 * terrain with the nearest location's, chosen deterministically from the session
 * seed so the map is stable.
 */
function createInitialMap(params: {
  locations: { name: string; x: number; y: number; terrain?: TerrainType }[];
  dominantTerrain?: TerrainType;
  worldDescription?: string;
  campaignMapDescription?: string;
  sourceMaterial?: string;
  seed: string;
}): GameMap {
  const { locations, dominantTerrain, worldDescription, campaignMapDescription, sourceMaterial, seed } = params;

  // What most of this world looks like: the model's own answer if valid,
  // otherwise inferred from the world text, otherwise plains.
  const textTerrain = inferTerrain(campaignMapDescription, worldDescription, sourceMaterial);
  let dominant: TerrainType = parseTerrain(dominantTerrain) || textTerrain || 'plains';

  // Climate sanity check. The model sometimes answers `desert` for an icy world
  // (a "cold desert" is technically defensible but renders as sand), and the two
  // are unmistakably opposite, so an explicit snow signal in the prompt wins.
  const climateOpposites: Partial<Record<TerrainType, TerrainType>> = {
    desert: 'snow',
    snow: 'desert',
  };
  if (textTerrain && climateOpposites[dominant] === textTerrain) {
    console.log(
      `[GameCreate] Overriding dominant terrain "${dominant}" with "${textTerrain}" — the prompt describes the opposite climate`
    );
    dominant = textTerrain;
  }

  // A secondary terrain adds variety without turning the map into noise.
  const secondary: TerrainType =
    dominant === 'desert' ? 'mountain'
    : dominant === 'snow' ? 'mountain'
    : dominant === 'forest' ? 'river'
    : dominant === 'mountain' ? 'cave'
    : dominant === 'swamp' ? 'river'
    : dominant === 'plains' ? 'forest'
    : 'plains';

  // Deterministic per session, so repeated reads render the same world.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let rngState = h >>> 0;
  const rng = () => {
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const tiles: MapTile[] = [];

  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const location = locations.find((l) => l.x === x && l.y === y);

      let terrain: TerrainType;
      if (location) {
        // A named place keeps its own terrain; default to a town if unspecified.
        terrain = parseTerrain(location.terrain) || inferTerrain(location.name) || 'town';
      } else {
        // Tiles near a location take on its character, so the map reads as
        // regions rather than static.
        const nearest = locations.reduce<{ dist: number; terrain: TerrainType | null }>(
          (best, l) => {
            const dist = Math.abs(l.x - x) + Math.abs(l.y - y);
            return dist < best.dist ? { dist, terrain: parseTerrain(l.terrain) } : best;
          },
          { dist: Infinity, terrain: null }
        );

        const roll = rng();
        if (nearest.dist <= 1 && nearest.terrain && roll < 0.5) {
          terrain = nearest.terrain;
        } else {
          terrain = roll < 0.72 ? dominant : secondary;
        }
      }

      tiles.push({
        x,
        y,
        terrain,
        name: location?.name || '',
        isPoi: !!location,
        explored: false,
        entities: [],
      });
    }
  }

  // Reveal starting location (first location)
  if (locations.length > 0) {
    const startTile = tiles.find((t) => t.x === locations[0].x && t.y === locations[0].y);
    if (startTile) {
      startTile.explored = true;
    }
  }

  return {
    width: 8,
    height: 8,
    tiles,
    campaignMapAssetId: '',
  };
}

/**
 * GET /api/game/:sessionId/state
 * Get the current game loop state (for reconnecting clients)
 */
router.get('/:sessionId/state', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const session = await gameSessions.getGameSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const state = await gameState.getGameState(sessionId);
    if (!state) return res.status(404).json({ error: 'Game state not found' });

    const sessionPlayers = await players.getSessionPlayers(sessionId);
    const events = await gameEvents.getSessionEvents(sessionId);
    const currentEvent = await gameEvents.getGameEvent(sessionId, session.currentEvent);

    // Build the current dice request info if waiting
    let diceRequest = null;
    if (state.waitingForDice) {
      const targetPlayer = sessionPlayers.find(
        (p) => p.playerId === state.currentTurnPlayerId
      );
      // Prefer the live requested die; the stored event row holds the die picked
      // at event creation, which differs during combat and boss rounds.
      const liveDice = getRequestedDiceType(sessionId);
      diceRequest = {
        targetPlayerId: state.currentTurnPlayerId,
        targetPlayerName: targetPlayer?.playerName || 'Unknown',
        characterName: targetPlayer?.character?.name || targetPlayer?.playerName || 'Unknown',
        characterClass: targetPlayer?.character?.class || 'Adventurer',
        characterStats: targetPlayer?.character?.stats || null,
        diceType: liveDice || currentEvent?.diceType || DEFAULT_DICE_TYPE,
        reason: 'The fates demand a roll...',
        attemptNumber: 1,
      };
    }

    // Build narrative history from completed events (include dice results & outcomes)
    const narrativeHistory = events
      .filter((e) => e.narrative)
      .map((e) => ({
        text: e.narrative,
        eventNumber: e.eventNumber,
        title: e.title,
        diceResult: e.diceResult ?? null,
        diceType: e.diceType ?? null,
        outcome: e.outcome ?? null,
        actionRequired: e.actionRequired,
        isComplete: e.isComplete,
        statChanges: e.statChanges ?? [],
        targetPlayerId: e.targetPlayerId ?? null,
      }));

    // Add current event narrative if not in history
    if (currentEvent?.narrative && !narrativeHistory.find((n) => n.eventNumber === currentEvent.eventNumber)) {
      narrativeHistory.push({
        text: currentEvent.narrative,
        eventNumber: currentEvent.eventNumber,
        title: currentEvent.title,
        diceResult: currentEvent.diceResult ?? null,
        diceType: currentEvent.diceType ?? null,
        outcome: currentEvent.outcome ?? null,
        actionRequired: currentEvent.actionRequired,
        isComplete: currentEvent.isComplete,
        statChanges: currentEvent.statChanges ?? [],
        targetPlayerId: currentEvent.targetPlayerId ?? null,
      });
    }

    res.json({
      status: session.status,
      currentEvent: session.currentEvent,
      totalEvents: session.totalEvents,
      waitingForDice: state.waitingForDice,
      diceRequest,
      step: getStepInfo(sessionId),
      narrativeHistory,
      lastNarrative: state.lastDmNarrative,
      currentTurnPlayerId: state.currentTurnPlayerId,
      turnNumber: state.turnNumber,
      gameRunning: isGameRunning(sessionId),
    });
  } catch (err) {
    console.error('[GameState] Error:', err);
    res.status(500).json({ error: 'Failed to get game state' });
  }
});

/**
 * POST /api/game/:sessionId/start
 * Start the game loop (host only)
 */
router.post('/:sessionId/start', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const session = await gameSessions.getGameSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (session.status === 'in_progress') {
      return res.status(400).json({ error: 'Game already in progress' });
    }

    if (isGameRunning(sessionId)) {
      return res.status(400).json({ error: 'Game loop already running' });
    }

    // Start the game loop (async - returns immediately)
    startGameLoop(sessionId).catch((err) => {
      console.error(`[GameStart] Error in game loop:`, err);
    });

    res.json({ success: true, message: 'Game started!' });
  } catch (err) {
    console.error('[GameStart] Error:', err);
    res.status(500).json({ error: 'Failed to start game' });
  }
});

/**
 * POST /api/game/:sessionId/dice-result
 * Submit a dice result (from OpenCV agent or player)
 */
router.post('/:sessionId/dice-result', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { diceType, rollValue, source = 'physical', confidence } = req.body;

    if (!diceType || rollValue === undefined) {
      return res.status(400).json({ error: 'diceType and rollValue are required' });
    }

    // Validate the die against the supported set, then bound the roll to it.
    const validated = parseDiceType(diceType);
    if (!validated) {
      return res.status(400).json({
        error: `Unsupported dice type: ${diceType}`,
        supportedDice: SUPPORTED_DICE,
      });
    }

    const maxValue = diceFaces(validated);
    if (rollValue < 1 || rollValue > maxValue) {
      return res.status(400).json({ error: `Invalid roll: ${rollValue} for ${validated}` });
    }

    await handleDiceResult(sessionId, {
      diceType: validated,
      rollValue: Number(rollValue),
      source,
      confidence,
    });

    res.json({ success: true, diceType: validated, rollValue, source });
  } catch (err) {
    console.error('[DiceResult] Error:', err);
    res.status(500).json({
      error: 'Failed to process dice result',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/game/:sessionId/dice-virtual
 * Roll a virtual die (fallback when physical dice read fails)
 */
router.post('/:sessionId/dice-virtual', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { diceType } = req.body;

    if (!diceType) {
      return res.status(400).json({ error: 'diceType is required' });
    }

    // Only dice the engine actually offers may be rolled. Previously any string
    // was accepted and the face count came from a bare parseInt, so "d7" or
    // "d999" would silently produce an off-spec roll.
    const validated = parseDiceType(diceType);
    if (!validated) {
      return res.status(400).json({
        error: `Unsupported dice type: ${diceType}`,
        supportedDice: SUPPORTED_DICE,
      });
    }

    // Keep the roll aligned with what the DM actually asked for, so a client
    // cannot swap in an easier die than the challenge requires. The live step is
    // authoritative: combat and boss rounds request their own die each round,
    // which the persisted event row does not track.
    const requested = getRequestedDiceType(sessionId);

    if (requested && requested !== validated) {
      return res.status(409).json({
        error: `The Dungeon Master asked for ${requested}, not ${validated}`,
        requestedDice: requested,
      });
    }

    const rollValue = Math.floor(Math.random() * diceFaces(validated)) + 1;

    await handleDiceResult(sessionId, {
      diceType: validated,
      rollValue,
      source: 'virtual',
    });

    res.json({ success: true, diceType: validated, rollValue, source: 'virtual' });
  } catch (err) {
    console.error('[DiceVirtual] Error:', err);
    res.status(500).json({
      error: 'Failed to roll virtual dice',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

export default router;
