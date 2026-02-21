import type {
  AIMediaQualityContract,
  AIMediaResolutionPreset,
  CreateAIMediaRunRequest,
  NormalizedAIMediaRunRequest,
} from './types';

export const MIN_IMAGES_PER_COLOR = 1;
export const DEFAULT_IMAGES_PER_COLOR = 4;
export const MAX_IMAGES_PER_COLOR = 8;

export type AIMediaQualityProfile = 'fast' | 'balanced' | 'premium';
export const DEFAULT_AI_MEDIA_QUALITY_PROFILE: AIMediaQualityProfile = 'balanced';

const RESOLUTION_PRESETS: Record<AIMediaResolutionPreset, { width: number; height: number }> = {
  '2k': { width: 2048, height: 2048 },
  '4k': { width: 4096, height: 4096 },
};

const QUALITY_PROFILE_DEFAULTS: Record<
  AIMediaQualityProfile,
  { imagesPerColor: number; includeVideo: boolean; resolutionPreset: AIMediaResolutionPreset }
> = {
  fast: {
    imagesPerColor: 2,
    includeVideo: false,
    resolutionPreset: '2k',
  },
  balanced: {
    imagesPerColor: 4,
    includeVideo: true,
    resolutionPreset: '2k',
  },
  premium: {
    imagesPerColor: 6,
    includeVideo: true,
    resolutionPreset: '4k',
  },
};

export const STRICT_PRODUCT_FIDELITY_RULES: string[] = [
  'Do not change the product color, print, pattern, cut, shape, stitching, hardware, or branding.',
  'Do not add or remove product elements (buttons, straps, pockets, logos, text, labels).',
  'Do not stylize the product surface in a way that modifies material identity.',
  'Environment and model can change, but the product itself must remain 1:1 with source references.',
  'If exact fidelity is uncertain, reject and regenerate rather than publishing the output.',
];

export const REQUIRED_FIDELITY_CHECKS: string[] = [
  'color_consistency',
  'silhouette_consistency',
  'logo_text_consistency',
  'material_texture_consistency',
  'component_presence_consistency',
];

function normalizeColorToken(input: string): string {
  const compact = String(input || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return '';
  return compact
    .split(' ')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function isLikelyHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function cleanOptionalUrl(value: unknown): string | undefined {
  const url = String(value || '').trim();
  if (!url || !isLikelyHttpUrl(url)) return undefined;
  return url;
}

function cleanUrlList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const url = String(value || '').trim();
    if (!url || !isLikelyHttpUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function cleanColorMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const entries = Object.entries(input as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    const color = normalizeColorToken(key);
    const url = String(value || '').trim();
    if (!color || !isLikelyHttpUrl(url)) continue;
    out[color] = url;
  }
  return out;
}

function normalizeTargetColors(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const rawColor of input) {
    const color = normalizeColorToken(String(rawColor || ''));
    if (!color) continue;
    const key = color.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(color);
  }

  return out;
}

function normalizeQualityProfile(input: unknown): AIMediaQualityProfile {
  const normalized = String(input || '').trim().toLowerCase();
  if (normalized === 'fast' || normalized === 'balanced' || normalized === 'premium') {
    return normalized;
  }
  return DEFAULT_AI_MEDIA_QUALITY_PROFILE;
}

function resolveQualityProfileDefaults(): {
  imagesPerColor: number;
  includeVideo: boolean;
  resolutionPreset: AIMediaResolutionPreset;
} {
  const profile = normalizeQualityProfile(process.env.AI_MEDIA_QUALITY_PROFILE);
  const defaults = QUALITY_PROFILE_DEFAULTS[profile] || QUALITY_PROFILE_DEFAULTS[DEFAULT_AI_MEDIA_QUALITY_PROFILE];
  return {
    imagesPerColor: defaults.imagesPerColor,
    includeVideo: defaults.includeVideo,
    resolutionPreset: defaults.resolutionPreset,
  };
}

function resolveMaxImagesPerColorCap(): number {
  const parsed = Number(process.env.AI_MEDIA_MAX_IMAGES_PER_COLOR);
  if (!Number.isFinite(parsed)) return MAX_IMAGES_PER_COLOR;
  return Math.min(MAX_IMAGES_PER_COLOR, Math.max(MIN_IMAGES_PER_COLOR, Math.round(parsed)));
}

function parseBooleanEnv(value: unknown): boolean | undefined {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
}

function resolveIncludeVideoDefault(fallback: boolean): boolean {
  const parsed = parseBooleanEnv(process.env.AI_MEDIA_ENABLE_VIDEO_DEFAULT);
  return typeof parsed === 'boolean' ? parsed : fallback;
}

function normalizeImagesPerColor(input: unknown, fallback: number): number {
  const maxCap = resolveMaxImagesPerColorCap();
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) {
    return Math.min(maxCap, Math.max(MIN_IMAGES_PER_COLOR, Math.round(fallback)));
  }
  return Math.min(maxCap, Math.max(MIN_IMAGES_PER_COLOR, Math.round(parsed)));
}

function normalizeResolutionPreset(
  input: unknown,
  fallback: AIMediaResolutionPreset
): AIMediaResolutionPreset {
  if (input === '2k' || input === '4k') return input;
  return fallback;
}

export function buildQualityContract(input: CreateAIMediaRunRequest): AIMediaQualityContract {
  const qualityDefaults = resolveQualityProfileDefaults();
  const includeVideoDefault = resolveIncludeVideoDefault(qualityDefaults.includeVideo);
  const resolutionPreset = normalizeResolutionPreset(
    input.resolutionPreset,
    qualityDefaults.resolutionPreset
  );
  const dims = RESOLUTION_PRESETS[resolutionPreset];

  return {
    imagesPerColor: normalizeImagesPerColor(
      input.imagesPerColor,
      qualityDefaults.imagesPerColor
    ),
    includeVideo:
      typeof input.includeVideo === 'boolean'
        ? input.includeVideo
        : includeVideoDefault,
    resolutionPreset,
    outputWidth: dims.width,
    outputHeight: dims.height,
    strictProductFidelity: true,
    forbidProductEdits: STRICT_PRODUCT_FIDELITY_RULES,
    requiredChecks: REQUIRED_FIDELITY_CHECKS,
  };
}

export function normalizeMediaRunRequest(input: CreateAIMediaRunRequest): NormalizedAIMediaRunRequest {
  const quality = buildQualityContract(input);
  const targetColors = normalizeTargetColors(input.targetColors);
  const queueProductId = Number(input.queueProductId);
  const productId = Number(input.productId);
  const createdBy = input.createdBy ? String(input.createdBy).trim() : undefined;

  if (!input.cjProductId || !String(input.cjProductId).trim()) {
    throw new Error('cjProductId is required');
  }
  if (!input.sourceContext) {
    throw new Error('sourceContext is required');
  }
  if (targetColors.length === 0) {
    throw new Error('At least one target color is required');
  }

  return {
    cjProductId: String(input.cjProductId).trim(),
    sourceContext: input.sourceContext,
    targetColors,
    sourceImages: cleanUrlList(input.sourceImages),
    sourceVideoUrl: cleanOptionalUrl(input.sourceVideoUrl),
    colorImageMap: cleanColorMap(input.colorImageMap),
    queueProductId: Number.isFinite(queueProductId) && queueProductId > 0 ? queueProductId : undefined,
    productId: Number.isFinite(productId) && productId > 0 ? productId : undefined,
    createdBy: createdBy || undefined,
    categorySlug: input.categorySlug ? String(input.categorySlug).trim() : undefined,
    categoryLabel: input.categoryLabel ? String(input.categoryLabel).trim() : undefined,
    preferredVisualStyle: input.preferredVisualStyle
      ? String(input.preferredVisualStyle).trim()
      : undefined,
    luxuryPresentation: input.luxuryPresentation !== false,
    quality,
  };
}

export function selectBestAnchorImage(
  color: string,
  colorImageMap: Record<string, string>,
  sourceImages: string[]
): string | null {
  const normalized = normalizeColorToken(color).toLowerCase();
  const normalizedKey = normalized.replace(/[^a-z0-9]/g, '');

  for (const [mapColor, url] of Object.entries(colorImageMap || {})) {
    const mapNormalized = normalizeColorToken(mapColor).toLowerCase();
    const mapKey = mapNormalized.replace(/[^a-z0-9]/g, '');
    if (
      mapNormalized === normalized ||
      mapKey === normalizedKey ||
      mapKey.includes(normalizedKey) ||
      normalizedKey.includes(mapKey)
    ) {
      return url;
    }
  }

  return sourceImages[0] || null;
}

export function buildStrictFidelityPromptBlock(): string {
  return [
    'STRICT PRODUCT FIDELITY REQUIREMENT:',
    ...STRICT_PRODUCT_FIDELITY_RULES.map((rule) => `- ${rule}`),
  ].join('\n');
}
