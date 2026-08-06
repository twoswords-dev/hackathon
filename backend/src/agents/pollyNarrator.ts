import { PollyClient, SynthesizeSpeechCommand, Engine, VoiceId } from '@aws-sdk/client-polly';

/**
 * In-memory cache for synthesized audio clips.
 * Key format: `${sessionId}:${eventNumber}`
 */
const audioCache = new Map<string, { buffer: Buffer; createdAt: number }>();

/** TTL for cached audio clips (60 seconds) */
const CACHE_TTL_MS = 60_000;

/** Cleanup interval (every 30 seconds) */
const CLEANUP_INTERVAL_MS = 30_000;

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of audioCache.entries()) {
    if (now - entry.createdAt > CACHE_TTL_MS) {
      audioCache.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS);

/**
 * Check if Polly TTS is enabled via environment config.
 */
export function isPollyEnabled(): boolean {
  return process.env.POLLY_ENABLED !== 'false';
}

/**
 * Get the configured Polly voice ID.
 */
function getVoiceId(): VoiceId {
  return (process.env.POLLY_VOICE_ID as VoiceId) || 'Matthew';
}

/**
 * Get the configured Polly engine.
 */
function getEngine(): Engine {
  return (process.env.POLLY_ENGINE as Engine) || 'neural';
}

/**
 * Create a Polly client using the same AWS region as other services.
 */
function createPollyClient(): PollyClient {
  return new PollyClient({
    region: process.env.AWS_REGION || 'us-east-1',
  });
}

/**
 * Synthesize speech from text using AWS Polly.
 * Returns the MP3 audio buffer, or null if Polly is disabled or fails.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  if (!isPollyEnabled()) {
    return null;
  }

  if (!text || text.trim().length === 0) {
    return null;
  }

  try {
    const client = createPollyClient();

    const command = new SynthesizeSpeechCommand({
      Engine: getEngine(),
      VoiceId: getVoiceId(),
      OutputFormat: 'mp3',
      TextType: 'text',
      Text: text,
    });

    const response = await client.send(command);

    if (!response.AudioStream) {
      console.error('[PollyNarrator] No audio stream in response');
      return null;
    }

    // Convert the stream to a Buffer
    const chunks: Uint8Array[] = [];
    const stream = response.AudioStream as AsyncIterable<Uint8Array>;
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    console.log(`[PollyNarrator] Synthesized ${buffer.length} bytes for: "${text.substring(0, 50)}..."`);
    return buffer;
  } catch (err) {
    console.error('[PollyNarrator] Failed to synthesize speech:', err);
    return null;
  }
}

/**
 * Synthesize and cache audio for a game event.
 * Returns the relative URL to fetch the audio, or undefined if synthesis fails.
 */
export async function synthesizeAndCache(
  sessionId: string,
  eventNumber: number,
  text: string
): Promise<string | undefined> {
  const buffer = await synthesizeSpeech(text);
  if (!buffer) return undefined;

  const cacheKey = `${sessionId}:${eventNumber}`;
  audioCache.set(cacheKey, { buffer, createdAt: Date.now() });

  return `/api/audio/${sessionId}/${eventNumber}`;
}

/**
 * Retrieve cached audio buffer for a session/event.
 * Returns the buffer or null if not found/expired.
 */
export function getCachedAudio(sessionId: string, eventNumber: number): Buffer | null {
  const cacheKey = `${sessionId}:${eventNumber}`;
  const entry = audioCache.get(cacheKey);

  if (!entry) return null;

  // Check TTL
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    audioCache.delete(cacheKey);
    return null;
  }

  return entry.buffer;
}
