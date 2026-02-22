import type {
  AIMediaFaceVisibility,
  AIMediaFaceVisibilityPolicy,
  AIMediaQualityContract,
  AIMediaRenderMode,
  AIMediaResolutionPreset,
  AIMediaViewTag,
  CreateAIMediaRunRequest,
  NormalizedAIMediaRunRequest,
} from './types';

export const MIN_IMAGES_PER_COLOR = 1;
export const DEFAULT_IMAGES_PER_COLOR = 4;
export const MAX_IMAGES_PER_COLOR = 8;
export const DEFAULT_RENDER_MODE: AIMediaRenderMode = 'background_only_preserve_product';

const DEFAULT_ALLOWED_VIEWS: AIMediaViewTag[] = ['front'];
const DEFAULT_FACE_VISIBILITY_POLICY: AIMediaFaceVisibilityPolicy = {
  upperWear: 'half_face_allowed',
  fullBody: 'face_hidden',
};

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

function normalizeViewTag(input: unknown): AIMediaViewTag | undefined {
  const normalized = String(input || '').trim().toLowerCase();
  if (normalized === 'front' || normalized === 'back' || normalized === 'side' || normalized === 'detail') {
    return normalized;
  }
  if (normalized === 'unknown') return 'unknown';
  return undefined;
}

export function inferViewTagFromUrl(url: string): AIMediaViewTag {
  const normalized = String(url || '').trim().toLowerCase();
  if (!normalized) return 'unknown';

  const tokenized = normalized
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!tokenized) return 'unknown';

  if (/(^|\s)(back|rear|backside|behind|reverse)(\s|$)/.test(tokenized)) return 'back';
  if (/(^|\s)(front|main|primary|hero)(\s|$)/.test(tokenized)) return 'front';
  if (/(^|\s)(side|profile|lateral)(\s|$)/.test(tokenized)) return 'side';
  if (/(^|\s)(detail|closeup|close|zoom|macro)(\s|$)/.test(tokenized)) return 'detail';

  return 'unknown';
}

function cleanSourceViewMap(input: unknown): Record<string, AIMediaViewTag> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, AIMediaViewTag> = {};
  for (const [rawUrl, rawTag] of Object.entries(input as Record<string, unknown>)) {
    const url = String(rawUrl || '').trim();
    if (!url || !isLikelyHttpUrl(url)) continue;
    const tag = normalizeViewTag(rawTag);
    if (!tag) continue;
    out[url] = tag;
  }
  return out;
}

function deriveSourceViewMap(
  sourceImages: string[],
  colorImageMap: Record<string, string>,
  inputMap: unknown
): Record<string, AIMediaViewTag> {
  const merged = {
    ...cleanSourceViewMap(inputMap),
  };

  const candidates = [...sourceImages, ...Object.values(colorImageMap)];
  for (const url of candidates) {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl || !isLikelyHttpUrl(normalizedUrl)) continue;
    if (merged[normalizedUrl]) continue;
    merged[normalizedUrl] = inferViewTagFromUrl(normalizedUrl);
  }

  return merged;
}

function normalizeAllowedViews(
  input: unknown,
  sourceViewMap: Record<string, AIMediaViewTag>
): AIMediaViewTag[] {
  const seen = new Set<string>();
  const out: AIMediaViewTag[] = [];

  if (Array.isArray(input)) {
    for (const raw of input) {
      const tag = normalizeViewTag(raw);
      if (!tag || tag === 'unknown') continue;
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
  }

  if (out.length > 0) return out;

  for (const tag of Object.values(sourceViewMap)) {
    if (tag === 'unknown' || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }

  return out.length > 0 ? out : [...DEFAULT_ALLOWED_VIEWS];
}

function normalizeRenderMode(input: unknown): AIMediaRenderMode {
  const normalized = String(input || '').trim();
  if (normalized === 'background_only_preserve_product' || normalized === 'pose_aware_model_wear') {
    return normalized;
  }
  return DEFAULT_RENDER_MODE;
}

function normalizeFaceVisibility(input: unknown, fallback: AIMediaFaceVisibility): AIMediaFaceVisibility {
  return input === 'half_face_allowed' || input === 'face_hidden' ? input : fallback;
}

function normalizeFaceVisibilityPolicy(input: unknown): AIMediaFaceVisibilityPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_FACE_VISIBILITY_POLICY };
  }

  const policy = input as Partial<AIMediaFaceVisibilityPolicy>;
  return {
    upperWear: normalizeFaceVisibility(policy.upperWear, DEFAULT_FACE_VISIBILITY_POLICY.upperWear),
    fullBody: normalizeFaceVisibility(policy.fullBody, DEFAULT_FACE_VISIBILITY_POLICY.fullBody),
  };
}

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
  const includeVideoDefault = resolveIncludeVideoDefault(false);
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
  const sourceImages = cleanUrlList(input.sourceImages);
  const colorImageMap = cleanColorMap(input.colorImageMap);
  const sourceViewMap = deriveSourceViewMap(sourceImages, colorImageMap, input.sourceViewMap);
  const allowedViews = normalizeAllowedViews(input.allowedViews, sourceViewMap);
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
    sourceImages,
    sourceVideoUrl: cleanOptionalUrl(input.sourceVideoUrl),
    colorImageMap,
    queueProductId: Number.isFinite(queueProductId) && queueProductId > 0 ? queueProductId : undefined,
    productId: Number.isFinite(productId) && productId > 0 ? productId : undefined,
    createdBy: createdBy || undefined,
    categorySlug: input.categorySlug ? String(input.categorySlug).trim() : undefined,
    categoryLabel: input.categoryLabel ? String(input.categoryLabel).trim() : undefined,
    preferredVisualStyle: input.preferredVisualStyle
      ? String(input.preferredVisualStyle).trim()
      : undefined,
    luxuryPresentation: input.luxuryPresentation !== false,
    renderMode: normalizeRenderMode(input.renderMode),
    allowedViews,
    sourceViewMap,
    enforceSourceViewOnly: input.enforceSourceViewOnly !== false,
    faceVisibilityPolicy: normalizeFaceVisibilityPolicy(input.faceVisibilityPolicy),
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
