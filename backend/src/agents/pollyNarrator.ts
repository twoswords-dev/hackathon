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
 *
 * Gregory is Amazon's deep, mature male narration voice, which suits a Dungeon
 * Master far better than the default newsreader-toned Matthew.
 */
function getVoiceId(): VoiceId {
  return (process.env.POLLY_VOICE_ID as VoiceId) || 'Gregory';
}

/**
 * Get the configured Polly engine.
 *
 * The `long-form` engine would be the natural fit for narration, but it is not
 * offered in every region (it is rejected in us-west-2 where this runs), so
 * `neural` is the default and long-form can be opted into via POLLY_ENGINE
 * where it is available.
 */
function getEngine(): Engine {
  return (process.env.POLLY_ENGINE as Engine) || 'neural';
}

/**
 * Wrap narration in SSML to give the DM a slower, weightier delivery.
 *
 * Only features the neural engine supports are used: `prosody rate` and
 * `break`. Neural rejects `prosody pitch` with InvalidSsmlException, so pitch
 * is deliberately absent.
 */
function buildSsml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  // A short pause after sentence-final punctuation lets dramatic beats land.
  const paced = escaped.replace(/([.!?])\s+/g, '$1 <break time="350ms"/> ');

  const rate = process.env.POLLY_RATE || '94%';
  return `<speak><prosody rate="${rate}">${paced}</prosody></speak>`;
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

    // SSML gives the DM a measured, deliberate cadence. If the model of the
    // moment rejects the markup we retry as plain text rather than losing the
    // narration entirely.
    const ssml = buildSsml(text);

    let response;
    try {
      response = await client.send(
        new SynthesizeSpeechCommand({
          Engine: getEngine(),
          VoiceId: getVoiceId(),
          OutputFormat: 'mp3',
          TextType: 'ssml',
          Text: ssml,
        })
      );
    } catch (ssmlErr) {
      console.warn(
        `[PollyNarrator] SSML synthesis rejected (${ssmlErr instanceof Error ? ssmlErr.message : ssmlErr}); retrying as plain text`
      );
      response = await client.send(
        new SynthesizeSpeechCommand({
          Engine: getEngine(),
          VoiceId: getVoiceId(),
          OutputFormat: 'mp3',
          TextType: 'text',
          Text: text,
        })
      );
    }

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
    console.log(
      `[PollyNarrator] Synthesized ${buffer.length} bytes with ${getVoiceId()}/${getEngine()} for: "${text.substring(0, 50)}..."`
    );
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
