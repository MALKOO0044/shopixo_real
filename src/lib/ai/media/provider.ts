import { fetchWithMeta } from '@/lib/http'
import { buildStrictFidelityPromptBlock } from './quality-policy'
import type { AIMediaType } from './types'

export const AI_MEDIA_PROVIDER_REQUIRED_MESSAGE =
  'AI media provider is not configured. Set AI_MEDIA_PROVIDER_URL (and AI_MEDIA_PROVIDER_TOKEN if required), then retry generation.'

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
}

export interface GenerateAIMediaAssetOutput {
  url: string
  provider: string
  providerAssetId?: string
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

  return [
    input.categoryPrompt,
    `Color focus: ${input.color}.`,
    style,
    luxury,
    resolution,
    buildStrictFidelityPromptBlock(),
  ].join('\n')
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
    timeoutMs: 120000,
    retries: 1,
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

  return {
    url,
    provider: String(body.provider || 'external_provider'),
    providerAssetId: body.assetId ? String(body.assetId) : undefined,
    promptSnapshot: {
      prompt,
      negativePrompt,
      providerPayload: payload,
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
