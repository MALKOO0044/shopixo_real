import { fetchWithMeta } from '@/lib/http'
import { buildStrictFidelityPromptBlock } from './quality-policy'
import type {
  AIMediaFaceVisibilityPolicy,
  AIMediaRenderMode,
  AIMediaType,
  AIMediaViewTag,
} from './types'

export const AI_MEDIA_PROVIDER_REQUIRED_MESSAGE =
  'AI media provider is not configured. Set AI_MEDIA_PROVIDER_URL (and AI_MEDIA_PROVIDER_TOKEN if required), then retry generation.'

const DEFAULT_PROVIDER_TIMEOUT_MS = 120000
const DEFAULT_PROVIDER_RETRIES = 1
const PRODUCT_PRESERVE_MODES: AIMediaRenderMode[] = [
  'background_only_preserve_product',
  'pose_aware_model_wear',
]
const VALID_VIEW_TAGS: AIMediaViewTag[] = ['front', 'back', 'side', 'detail', 'unknown']

function parsePositiveIntegerEnv(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.round(parsed)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function resolveProviderTimeoutMs(): number {
  return parsePositiveIntegerEnv(
    process.env.AI_MEDIA_PROVIDER_TIMEOUT_MS,
    DEFAULT_PROVIDER_TIMEOUT_MS,
    15000,
    300000
  )
}

function resolveProviderRetries(): number {
  return parsePositiveIntegerEnv(
    process.env.AI_MEDIA_PROVIDER_RETRIES,
    DEFAULT_PROVIDER_RETRIES,
    0,
    3
  )
}

export interface GenerateAIMediaAssetInput {
  mediaType: AIMediaType
  cjProductId: string
  color: string
  mediaIndex: number
  anchorImageUrl: string
  sourceVideoUrl?: string
  outputWidth: number
  outputHeight: number
  categoryPrompt: string
  categoryNegativePrompt: string
  preferredVisualStyle?: string
  luxuryPresentation: boolean
  renderMode: AIMediaRenderMode
  sourceViewTag: AIMediaViewTag
  requestedViewTag: AIMediaViewTag
  allowedViews: AIMediaViewTag[]
  enforceSourceViewOnly: boolean
  faceVisibilityPolicy: AIMediaFaceVisibilityPolicy
}

export interface GenerateAIMediaAssetOutput {
  url: string
  provider: string
  providerAssetId?: string
  mode: AIMediaRenderMode
  viewTag: AIMediaViewTag
  traceId?: string
  promptSnapshot: Record<string, any>
}

export function isAIMediaProviderConfigured(): boolean {
  return Boolean(String(process.env.AI_MEDIA_PROVIDER_URL || '').trim())
}

export function assertAIMediaProviderConfigured(): void {
  if (!isAIMediaProviderConfigured()) {
    throw new Error(AI_MEDIA_PROVIDER_REQUIRED_MESSAGE)
  }
}

function buildPrompt(input: GenerateAIMediaAssetInput): string {
  const style = input.preferredVisualStyle
    ? `Preferred visual style: ${input.preferredVisualStyle}.`
    : 'Preferred visual style: premium ecommerce luxury composition.'

  const resolution = `Target resolution: ${input.outputWidth}x${input.outputHeight}.`
  const luxury = input.luxuryPresentation
    ? 'Use luxury-grade cinematic presentation and premium editorial direction.'
    : 'Use clean premium ecommerce presentation.'
  const modeInstruction = input.renderMode === 'pose_aware_model_wear'
    ? 'Render mode: pose-aware model-wear with strict product preservation.'
    : 'Render mode: background-only with strict product preservation.'
  const viewInstruction = [
    `Requested view: ${input.requestedViewTag}.`,
    `Source anchor view: ${input.sourceViewTag}.`,
    `Allowed output views: ${input.allowedViews.join(', ')}.`,
  ].join(' ')
  const sourceViewConstraint = input.enforceSourceViewOnly
    ? 'Do not invent unseen angles. If requested view is unsupported by source references, fallback to source-available view only.'
    : 'View constraint relaxed: use best effort while preserving product identity.'
  const facePolicy =
    `Face visibility policy — upper wear: ${input.faceVisibilityPolicy.upperWear}; full body: ${input.faceVisibilityPolicy.fullBody}.`

  return [
    input.categoryPrompt,
    `Color focus: ${input.color}.`,
    modeInstruction,
    viewInstruction,
    sourceViewConstraint,
    facePolicy,
    style,
    luxury,
    resolution,
    buildStrictFidelityPromptBlock(),
  ].join('\n')
}

function normalizeProviderMode(value: unknown): AIMediaRenderMode | null {
  const mode = String(value || '').trim()
  if (mode === 'background_only_preserve_product' || mode === 'pose_aware_model_wear') {
    return mode
  }
  return null
}

function normalizeViewTag(value: unknown): AIMediaViewTag {
  const tag = String(value || '').trim().toLowerCase()
  if ((VALID_VIEW_TAGS as string[]).includes(tag)) {
    return tag as AIMediaViewTag
  }
  return 'unknown'
}

async function tryExternalProvider(
  input: GenerateAIMediaAssetInput,
  prompt: string,
  negativePrompt: string
): Promise<GenerateAIMediaAssetOutput> {
  const providerUrl = String(process.env.AI_MEDIA_PROVIDER_URL || '').trim()
  if (!providerUrl) {
    throw new Error(AI_MEDIA_PROVIDER_REQUIRED_MESSAGE)
  }

  const token = String(process.env.AI_MEDIA_PROVIDER_TOKEN || '').trim()
  const timeoutMs = resolveProviderTimeoutMs()
  const retries = resolveProviderRetries()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const payload = {
    mediaType: input.mediaType,
    cjProductId: input.cjProductId,
    color: input.color,
    mediaIndex: input.mediaIndex,
    anchorImageUrl: input.anchorImageUrl,
    sourceVideoUrl: input.sourceVideoUrl || null,
    renderMode: input.renderMode,
    sourceViewTag: input.sourceViewTag,
    requestedViewTag: input.requestedViewTag,
    allowedViews: input.allowedViews,
    enforceSourceViewOnly: input.enforceSourceViewOnly,
    faceVisibilityPolicy: input.faceVisibilityPolicy,
    prompt,
    negativePrompt,
    width: input.outputWidth,
    height: input.outputHeight,
    strictFidelity: true,
  }

  const meta = await fetchWithMeta<any>(providerUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    timeoutMs,
    retries,
  })

  if (!meta.ok) {
    const providerError =
      typeof meta.body === 'string'
        ? meta.body
        : (meta.body?.error || `AI media provider failed with status ${meta.status}`)
    throw new Error(`AI media provider request failed: ${providerError}`)
  }

  const body = meta.body || {}
  const url = String(body.url || body.outputUrl || '').trim()
  if (!url) {
    throw new Error('AI media provider returned success without output URL')
  }
  const providerMeta = body.meta && typeof body.meta === 'object' ? body.meta : {}
  const mode =
    normalizeProviderMode((providerMeta as any)?.mode) ||
    normalizeProviderMode((body as any)?.mode)
  if (!mode || !(PRODUCT_PRESERVE_MODES as string[]).includes(mode)) {
    throw new Error('AI media provider returned output without a valid product-preserve mode')
  }

  const allowedModeFallback =
    input.renderMode === 'pose_aware_model_wear' && mode === 'background_only_preserve_product'
  if (mode !== input.renderMode && !allowedModeFallback) {
    throw new Error(
      `AI media provider returned mode "${mode}" which is incompatible with requested mode "${input.renderMode}"`
    )
  }

  const viewTag = normalizeViewTag(
    (providerMeta as any)?.viewTag ||
      (providerMeta as any)?.sourceViewTag ||
      (body as any)?.viewTag ||
      input.requestedViewTag ||
      input.sourceViewTag
  )

  if (
    input.enforceSourceViewOnly &&
    input.allowedViews.length > 0 &&
    viewTag !== 'unknown' &&
    !input.allowedViews.includes(viewTag)
  ) {
    throw new Error(
      `AI media provider returned disallowed view tag "${viewTag}" for allowed views [${input.allowedViews.join(', ')}]`
    )
  }

  const traceId = String((providerMeta as any)?.traceId || '').trim() || undefined

  return {
    url,
    provider: String(body.provider || 'internal_microservice'),
    providerAssetId: body.assetId ? String(body.assetId) : undefined,
    mode,
    viewTag,
    traceId,
    promptSnapshot: {
      prompt,
      negativePrompt,
      providerPayload: payload,
      providerRequestOptions: { timeoutMs, retries },
      providerResponseMeta: body.meta || null,
    },
  }
}

export async function generateAIMediaAsset(
  input: GenerateAIMediaAssetInput
): Promise<GenerateAIMediaAssetOutput> {
  assertAIMediaProviderConfigured()

  const prompt = buildPrompt(input)
  const negativePrompt = input.categoryNegativePrompt

  return tryExternalProvider(input, prompt, negativePrompt)
}
