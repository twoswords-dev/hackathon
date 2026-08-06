import { Router, Request, Response } from 'express';
import { gameSessions, players, gameState, gameEvents } from '../db';
import { generateLore } from '../agents/loreGenerator';
import { generateGameAssets } from '../agents/imageGenerator';
import { startGameLoop, handleDiceResult, isGameRunning, getStepInfo } from '../game/gameLoop';
import { buildCustomCharacter, SUPPORTED_RACES, SUPPORTED_CLASSES, statsFor, normalizeRace, normalizeClass } from '../game/characterPresets';
import { sseManager } from '../sse';
import { CreateGameRequest, GameLength, GAME_LENGTH_EVENTS, GameMap, MapTile, Character, CharacterStats } from '../types/game';

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

    // 4. Create initial map from lore
    const map = createInitialMap(worldLore.locations.map((l) => ({
      name: l.name,
      x: l.tileX,
      y: l.tileY,
    })));

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
        locations: worldLore.locations,
        factions: worldLore.factions,
        eventCount: worldLore.eventOutlines.length,
        characterCount: worldLore.suggestedCharacters.length,
        suggestedCharacters: worldLore.suggestedCharacters,
      },
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
        locations: state.worldLore.locations,
        factions: state.worldLore.factions,
        suggestedCharacters: state.worldLore.suggestedCharacters,
        eventCount: state.worldLore.eventOutlines.length,
      } : null,
      map: state?.map || null,
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
 * Create an initial 8x8 map grid with locations placed.
 */
function createInitialMap(locations: { name: string; x: number; y: number }[]): GameMap {
  const tiles: MapTile[] = [];
  const terrainTypes: Array<'forest' | 'mountain' | 'plains' | 'river' | 'swamp'> = [
    'forest', 'mountain', 'plains', 'river', 'swamp',
  ];

  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const location = locations.find((l) => l.x === x && l.y === y);
      tiles.push({
        x,
        y,
        terrain: location ? 'town' : terrainTypes[Math.floor(Math.random() * terrainTypes.length)],
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
      diceRequest = {
        targetPlayerId: state.currentTurnPlayerId,
        targetPlayerName: targetPlayer?.playerName || 'Unknown',
        characterName: targetPlayer?.character?.name || targetPlayer?.playerName || 'Unknown',
        characterClass: targetPlayer?.character?.class || 'Adventurer',
        characterStats: targetPlayer?.character?.stats || null,
        diceType: currentEvent?.diceType || 'd20',
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

    // Validate roll value
    const maxValue = parseInt(diceType.replace('d', ''));
    if (isNaN(maxValue) || rollValue < 1 || rollValue > maxValue) {
      return res.status(400).json({ error: `Invalid roll: ${rollValue} for ${diceType}` });
    }

    await handleDiceResult(sessionId, {
      diceType,
      rollValue: Number(rollValue),
      source,
      confidence,
    });

    res.json({ success: true, diceType, rollValue, source });
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

    const maxValue = parseInt(diceType.replace('d', ''));
    if (isNaN(maxValue)) {
      return res.status(400).json({ error: `Invalid dice type: ${diceType}` });
    }

    const rollValue = Math.floor(Math.random() * maxValue) + 1;

    await handleDiceResult(sessionId, {
      diceType,
      rollValue,
      source: 'virtual',
    });

    res.json({ success: true, diceType, rollValue, source: 'virtual' });
  } catch (err) {
    console.error('[DiceVirtual] Error:', err);
    res.status(500).json({
      error: 'Failed to roll virtual dice',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

export default router;
