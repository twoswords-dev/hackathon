import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

const REGION = process.env.AWS_REGION || 'us-east-1';
const S3_BUCKET = process.env.S3_IMAGE_BUCKET || 'gen-dnd-images-383466764719';
const IMAGE_MODEL_ID = process.env.BEDROCK_IMAGE_MODEL || 'amazon.nova-canvas-v1:0';

const bedrockClient = new BedrockRuntimeClient({ region: REGION });
const s3Client = new S3Client({ region: REGION });

export type ImageType = 'campaign_map' | 'character_portrait' | 'scene' | 'tile';

interface GenerateImageResult {
  assetId: string;
  s3Key: string;
  url: string;
  generated: boolean; // true if AI-generated, false if placeholder
}

/**
 * Generate an image and store it in S3.
 * Falls back to SVG placeholder if Bedrock image models are unavailable.
 */
export async function generateImage(params: {
  sessionId: string;
  prompt: string;
  imageType: ImageType;
  label?: string;
}): Promise<GenerateImageResult> {
  const { sessionId, prompt, imageType, label } = params;
  const assetId = uuidv4();
  const s3Key = `sessions/${sessionId}/${imageType}/${assetId}.png`;

  let imageBuffer: Buffer;
  let generated = false;

  try {
    // Try Bedrock image generation
    imageBuffer = await generateWithBedrock(prompt);
    generated = true;
    console.log(`[ImageGen] Generated image via Bedrock: ${imageType} (${label || 'no label'})`);
  } catch (err) {
    // Fallback to placeholder
    console.log(`[ImageGen] Bedrock unavailable, using placeholder for: ${imageType} (${label || prompt.substring(0, 50)})`);
    imageBuffer = generatePlaceholderSVG(prompt, imageType, label);
  }

  // Upload to S3
  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: imageBuffer,
      ContentType: generated ? 'image/png' : 'image/svg+xml',
      Metadata: {
        sessionId,
        imageType,
        prompt: prompt.substring(0, 256),
        generated: String(generated),
      },
    })
  );

  // Generate a presigned URL (valid for 24 hours)
  const url = await getPresignedUrl(s3Key);

  return { assetId, s3Key, url, generated };
}

/**
 * Get a presigned URL for an existing asset.
 */
export async function getAssetUrl(s3Key: string): Promise<string> {
  return getPresignedUrl(s3Key);
}

/**
 * Generate campaign map + character portraits for a new game.
 */
export async function generateGameAssets(params: {
  sessionId: string;
  campaignMapDescription: string;
  characters: { id: string; name: string; description: string; class: string }[];
}): Promise<{
  campaignMapAssetId: string;
  campaignMapUrl: string;
  characterAssets: { characterId: string; assetId: string; url: string }[];
}> {
  const { sessionId, campaignMapDescription, characters } = params;

  // Generate campaign map
  const mapResult = await generateImage({
    sessionId,
    prompt: `Fantasy campaign map, overhead view, illustrated style: ${campaignMapDescription}`,
    imageType: 'campaign_map',
    label: 'Campaign Overview Map',
  });

  // Generate character portraits
  const characterAssets = await Promise.all(
    characters.map(async (char) => {
      const result = await generateImage({
        sessionId,
        prompt: `Fantasy character portrait, D&D style, ${char.class}: ${char.description}`,
        imageType: 'character_portrait',
        label: char.name,
      });
      return {
        characterId: char.id,
        assetId: result.assetId,
        url: result.url,
      };
    })
  );

  return {
    campaignMapAssetId: mapResult.assetId,
    campaignMapUrl: mapResult.url,
    characterAssets,
  };
}

/**
 * Try to generate an image using Bedrock (Nova Canvas / Titan Image).
 */
async function generateWithBedrock(prompt: string): Promise<Buffer> {
  const body = JSON.stringify({
    taskType: 'TEXT_IMAGE',
    textToImageParams: { text: prompt },
    imageGenerationConfig: {
      numberOfImages: 1,
      height: 512,
      width: 512,
      cfgScale: 8.0,
    },
  });

  const command = new InvokeModelCommand({
    modelId: IMAGE_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: new TextEncoder().encode(body),
  });

  const response = await bedrockClient.send(command);
  const result = JSON.parse(new TextDecoder().decode(response.body));

  if (result.images && result.images.length > 0) {
    return Buffer.from(result.images[0], 'base64');
  }

  throw new Error('No images in Bedrock response');
}

/**
 * Generate a styled SVG placeholder image.
 */
function generatePlaceholderSVG(prompt: string, imageType: ImageType, label?: string): Buffer {
  const colors = {
    campaign_map: { bg: '#2d4a3e', fg: '#7cb342', accent: '#4caf50', icon: '🗺️' },
    character_portrait: { bg: '#3d2c5c', fg: '#ce93d8', accent: '#9c27b0', icon: '⚔️' },
    scene: { bg: '#1a3a5c', fg: '#64b5f6', accent: '#2196f3', icon: '🏰' },
    tile: { bg: '#4a3728', fg: '#a1887f', accent: '#795548', icon: '🌲' },
  };

  const c = colors[imageType];
  const displayLabel = label || imageType.replace('_', ' ');
  const shortPrompt = prompt.length > 80 ? prompt.substring(0, 77) + '...' : prompt;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${c.bg}"/>
      <stop offset="100%" style="stop-color:#1a1a2e"/>
    </linearGradient>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M 32 0 L 0 0 0 32" fill="none" stroke="${c.fg}" stroke-width="0.5" opacity="0.2"/>
    </pattern>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <rect width="512" height="512" fill="url(#grid)"/>
  <rect x="20" y="20" width="472" height="472" rx="16" fill="none" stroke="${c.accent}" stroke-width="2" opacity="0.6"/>
  <text x="256" y="200" text-anchor="middle" font-size="64" fill="${c.fg}">${c.icon}</text>
  <text x="256" y="280" text-anchor="middle" font-family="serif" font-size="24" fill="${c.fg}" font-weight="bold">${escapeXml(displayLabel)}</text>
  <text x="256" y="320" text-anchor="middle" font-family="sans-serif" font-size="12" fill="${c.fg}" opacity="0.7">${escapeXml(shortPrompt.substring(0, 50))}</text>
  <text x="256" y="340" text-anchor="middle" font-family="sans-serif" font-size="12" fill="${c.fg}" opacity="0.7">${escapeXml(shortPrompt.substring(50))}</text>
  <text x="256" y="480" text-anchor="middle" font-family="monospace" font-size="10" fill="${c.accent}" opacity="0.5">GEN DND • AI Image Pending</text>
</svg>`;

  return Buffer.from(svg, 'utf-8');
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function getPresignedUrl(s3Key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
  });
  return getSignedUrl(s3Client, command, { expiresIn: 86400 }); // 24 hours
}
