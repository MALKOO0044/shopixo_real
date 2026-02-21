import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { hasTable } from '@/lib/db-features'
import { slugFromLabel } from '@/lib/categories'
import { getSetting } from '@/lib/settings'
import { addJobItem, cancelJob, createJob, getJob } from '@/lib/jobs'
import { logAIAction, updateAIAction } from '@/lib/ai/action-logger'
import { recordMetric } from '@/lib/ai/metrics-tracker'
import { resolveAIMediaCategoryProfile } from './category-profiles'
import { evaluateAIMediaFidelity } from './fidelity'
import { generateAIMediaAsset } from './provider'
import { normalizeMediaRunRequest, selectBestAnchorImage } from './quality-policy'
import type {
  AIMediaAssetRecord,
  AIMediaColorProgress,
  AIMediaRunDetails,
  AIMediaRunRecord,
  AIMediaRunStatus,
  AIMediaType,
  CreateAIMediaRunRequest,
  CreateAIMediaRunResult,
} from './types'

function getAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

const AI_MEDIA_SCHEMA_FIX_MESSAGE =
  'AI media schema is missing or outdated. Run supabase/migrations/20260221T153000_ai_media_generation_core.sql in Supabase SQL Editor, then go to Settings > API and click "Reload schema".'

function isMissingTableOrSchemaCacheError(error: unknown): boolean {
  const code = String((error as any)?.code || '').toUpperCase()
  const message = String((error as any)?.message || error || '')
  const details = String((error as any)?.details || '')
  const hint = String((error as any)?.hint || '')
  const combined = `${message} ${details} ${hint}`.toLowerCase()

  if (code === '42P01' || code === 'PGRST205') return true
  if (/does not exist|relation .* does not exist/i.test(combined)) return true
  if (/could not find the table .* in the schema cache/i.test(combined)) return true
  if (combined.includes('schema cache') && combined.includes('table')) return true

  return false
}

function toAIMediaSchemaErrorMessage(originalMessage?: string): string {
  const base = AI_MEDIA_SCHEMA_FIX_MESSAGE
  const detail = String(originalMessage || '').trim()
  return detail ? `${base} Original error: ${detail}` : base
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function toStringArray(value: unknown): string[] {
  const parsed = parseJsonMaybe(value)
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    const v = String(item || '').trim()
    if (!v) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

function toUrlArray(value: unknown): string[] {
  return toStringArray(value).filter((v) => /^https?:\/\//i.test(v))
}

function toColorMap(value: unknown): Record<string, string> {
  const parsed = parseJsonMaybe(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [k, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const color = String(k || '').trim()
    const url = String(raw || '').trim()
    if (!color || !/^https?:\/\//i.test(url)) continue
    out[color] = url
  }
  return out
}

function mergeColors(...groups: string[][]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const color of group) {
      const v = String(color || '').trim()
      if (!v) continue
      const key = v.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(v)
    }
  }
  return out
}

function extractVariantColors(value: unknown): string[] {
  const parsed = parseJsonMaybe(value)
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    const color = String((item as any)?.color || '').trim()
    if (!color) continue
    const key = color.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(color)
  }
  return out
}

function sanitizePathSegment(value: string): string {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'na'
}

function extensionFromContentType(contentType: string | null, mediaType: AIMediaType, fallbackUrl: string): string {
  const lower = String(contentType || '').toLowerCase()
  if (lower.includes('image/png')) return 'png'
  if (lower.includes('image/webp')) return 'webp'
  if (lower.includes('image/avif')) return 'avif'
  if (lower.includes('image/jpeg') || lower.includes('image/jpg')) return 'jpg'
  if (lower.includes('video/webm')) return 'webm'
  if (lower.includes('video/ogg')) return 'ogv'
  if (lower.includes('video/mp4')) return 'mp4'

  const m = String(fallbackUrl || '').match(/\.([a-z0-9]{2,5})(?:[?#].*)?$/i)
  if (m?.[1]) return m[1].toLowerCase()

  return mediaType === 'video' ? 'mp4' : 'jpg'
}

async function ensureProductsBucket(db: SupabaseClient): Promise<void> {
  try {
    const { data: bucket, error } = await db.storage.getBucket('products')
    if (!bucket || error) {
      await db.storage.createBucket('products', { public: true })
    }
  } catch {
    // best effort
  }
}

async function uploadRemoteAssetToStorage(input: {
  db: SupabaseClient
  runId: number
  cjProductId: string
  color: string
  mediaType: AIMediaType
  mediaIndex: number
  sourceUrl: string
}): Promise<string> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 120000)

  let response: Response
  try {
    response = await fetch(input.sourceUrl, { cache: 'no-store', signal: ac.signal })
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw new Error(`Unable to fetch generated media for storage: HTTP ${response.status}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const contentType = response.headers.get('content-type')
  const ext = extensionFromContentType(contentType, input.mediaType, input.sourceUrl)

  const path = [
    'ai-media',
    sanitizePathSegment(input.cjProductId),
    `run-${input.runId}`,
    sanitizePathSegment(input.color),
    `${input.mediaType}-${input.mediaIndex}-${Date.now()}.${ext}`,
  ].join('/')

  const { error: uploadError } = await input.db.storage
    .from('products')
    .upload(path, Buffer.from(arrayBuffer), {
      upsert: true,
      contentType: contentType || undefined,
    })

  if (uploadError) {
    throw new Error(`Failed to upload generated media to storage: ${uploadError.message}`)
  }

  const pub = input.db.storage.from('products').getPublicUrl(path)
  const publicUrl = (pub as any)?.data?.publicUrl || (pub as any)?.publicURL || null
  if (!publicUrl) {
    throw new Error('Failed to resolve public URL for stored media')
  }

  return String(publicUrl)
}

function summarizeColorProgress(
  colors: string[],
  includeVideo: boolean,
  imagesPerColor: number,
  assets: AIMediaAssetRecord[]
): AIMediaColorProgress[] {
  return colors.map((color) => {
    const colorAssets = assets.filter((a) => a.color === color)
    const approvedImages = colorAssets.filter((a) => a.media_type === 'image' && a.status === 'ready').length
    const rejectedImages = colorAssets.filter((a) => a.media_type === 'image' && a.status === 'rejected').length
    const approvedVideo = colorAssets.filter((a) => a.media_type === 'video' && a.status === 'ready').length
    const rejectedVideo = colorAssets.filter((a) => a.media_type === 'video' && a.status === 'rejected').length

    const expected = imagesPerColor + (includeVideo ? 1 : 0)
    const done = approvedImages + rejectedImages + approvedVideo + rejectedVideo >= expected

    return {
      color,
      approvedImages,
      rejectedImages,
      approvedVideo,
      rejectedVideo,
      done,
    }
  })
}

async function loadQueueContext(db: SupabaseClient, input: CreateAIMediaRunRequest): Promise<any | null> {
  if (!(await hasTable('product_queue'))) return null

  if (Number(input.queueProductId) > 0) {
    const { data } = await db
      .from('product_queue')
      .select('id,cj_product_id,images,video_url,available_colors,variants,color_image_map,category')
      .eq('id', Number(input.queueProductId))
      .maybeSingle()
    return data || null
  }

  const { data } = await db
    .from('product_queue')
    .select('id,cj_product_id,images,video_url,available_colors,variants,color_image_map,category')
    .eq('cj_product_id', input.cjProductId)
    .order('id', { ascending: false })
    .limit(1)

  return Array.isArray(data) ? data[0] || null : null
}

async function loadProductContext(db: SupabaseClient, input: CreateAIMediaRunRequest): Promise<any | null> {
  if (!(await hasTable('products'))) return null

  if (Number(input.productId) > 0) {
    const { data } = await db
      .from('products')
      .select('id,cj_product_id,images,video_url,available_colors,variants,color_image_map,category')
      .eq('id', Number(input.productId))
      .maybeSingle()
    return data || null
  }

  const { data } = await db
    .from('products')
    .select('id,cj_product_id,images,video_url,available_colors,variants,color_image_map,category')
    .eq('cj_product_id', input.cjProductId)
    .order('id', { ascending: false })
    .limit(1)

  return Array.isArray(data) ? data[0] || null : null
}

async function hydrateMediaRunRequest(db: SupabaseClient, input: CreateAIMediaRunRequest): Promise<CreateAIMediaRunRequest> {
  const [queueContext, productContext] = await Promise.all([
    loadQueueContext(db, input),
    loadProductContext(db, input),
  ])

  const queueColors = toStringArray(queueContext?.available_colors)
  const productColors = toStringArray(productContext?.available_colors)
  const variantColors = mergeColors(
    extractVariantColors(queueContext?.variants),
    extractVariantColors(productContext?.variants)
  )

  const mergedColorMap = {
    ...toColorMap(queueContext?.color_image_map),
    ...toColorMap(productContext?.color_image_map),
    ...(input.colorImageMap || {}),
  }

  const inputColors = toStringArray(input.targetColors)
  const targetColors = mergeColors(inputColors, queueColors, productColors, variantColors, Object.keys(mergedColorMap))

  const sourceImages = mergeColors(
    toUrlArray(input.sourceImages),
    toUrlArray(queueContext?.images),
    toUrlArray(productContext?.images),
    Object.values(mergedColorMap)
  )

  const sourceVideoUrl = String(
    input.sourceVideoUrl || queueContext?.video_url || productContext?.video_url || ''
  ).trim() || undefined

  const categoryLabel =
    input.categoryLabel ||
    String(queueContext?.category || productContext?.category || '').trim() ||
    undefined

  const categorySlug = input.categorySlug || (categoryLabel ? slugFromLabel(categoryLabel) : undefined)

  const queueProductId = Number(input.queueProductId || queueContext?.id || 0)
  const productId = Number(input.productId || productContext?.id || 0)

  return {
    ...input,
    queueProductId: Number.isFinite(queueProductId) && queueProductId > 0 ? queueProductId : undefined,
    productId: Number.isFinite(productId) && productId > 0 ? productId : undefined,
    targetColors,
    sourceImages,
    sourceVideoUrl,
    colorImageMap: mergedColorMap,
    categoryLabel,
    categorySlug,
  }
}

export async function isAIMediaFeatureEnabled(): Promise<boolean> {
  const enabled = await getSetting<boolean>('ai_media_generation_enabled', true)
  return enabled !== false
}

export async function createAIMediaRun(input: CreateAIMediaRunRequest): Promise<CreateAIMediaRunResult> {
  const db = getAdmin()
  if (!db) {
    throw new Error('Server not configured for AI media generation')
  }

  const [runsTableExists, assetsTableExists] = await Promise.all([
    hasTable('ai_media_runs'),
    hasTable('ai_media_assets'),
  ])

  if (!runsTableExists || !assetsTableExists) {
    const missingTables = [
      !runsTableExists ? 'ai_media_runs' : null,
      !assetsTableExists ? 'ai_media_assets' : null,
    ].filter(Boolean)

    throw new Error(
      `AI media tables missing (${missingTables.join(', ')}). ${AI_MEDIA_SCHEMA_FIX_MESSAGE}`
    )
  }

  const hydrated = await hydrateMediaRunRequest(db, input)
  const normalized = normalizeMediaRunRequest(hydrated)

  if (normalized.sourceImages.length === 0 && Object.keys(normalized.colorImageMap).length === 0) {
    throw new Error('At least one source image is required for AI media generation')
  }
  if (normalized.targetColors.length === 0) {
    throw new Error('At least one target color is required for AI media generation')
  }

  const profile = resolveAIMediaCategoryProfile({
    categorySlug: normalized.categorySlug,
    categoryLabel: normalized.categoryLabel,
  })

  const params = {
    request: normalized,
    profile,
  }

  const totals = {
    requestedColors: normalized.targetColors.length,
    requestedImages: normalized.targetColors.length * normalized.quality.imagesPerColor,
    requestedVideos: normalized.quality.includeVideo ? normalized.targetColors.length : 0,
    processed: 0,
    approvedImages: 0,
    approvedVideos: 0,
    rejectedImages: 0,
    rejectedVideos: 0,
    jobId: null as number | null,
  }

  const { data: insertedRun, error: insertError } = await db
    .from('ai_media_runs')
    .insert({
      cj_product_id: normalized.cjProductId,
      queue_product_id: normalized.queueProductId || null,
      product_id: normalized.productId || null,
      source_context: normalized.sourceContext,
      status: 'pending',
      requested_images_per_color: normalized.quality.imagesPerColor,
      include_video: normalized.quality.includeVideo,
      category_profile: profile.id,
      params,
      totals,
      created_by: normalized.createdBy || null,
    })
    .select('id,status')
    .single()

  if (insertError || !insertedRun) {
    if (insertError && isMissingTableOrSchemaCacheError(insertError)) {
      throw new Error(toAIMediaSchemaErrorMessage(insertError?.message))
    }
    throw new Error(insertError?.message || 'Failed to create AI media run')
  }

  const runId = Number(insertedRun.id)

  const actionId = await logAIAction({
    actionType: 'ai_media_run_created',
    agentName: 'merchandising',
    entityType: 'ai_media_run',
    entityId: String(runId),
    actionData: {
      runId,
      cjProductId: normalized.cjProductId,
      colors: normalized.targetColors.length,
      includeVideo: normalized.quality.includeVideo,
      imagesPerColor: normalized.quality.imagesPerColor,
      resolutionPreset: normalized.quality.resolutionPreset,
    },
    severity: 'info',
  })

  const job = await createJob('media', {
    runId,
    cjProductId: normalized.cjProductId,
    sourceContext: normalized.sourceContext,
    actionId: actionId || null,
  })

  if (!job?.id) {
    const enqueueError = 'Failed to enqueue AI media job'

    await db
      .from('ai_media_runs')
      .update({
        status: 'failed',
        error_text: enqueueError,
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId)

    if (actionId) {
      await updateAIAction(actionId, {
        status: 'failed',
        errorMessage: enqueueError,
        resultData: { runId },
      })
    }

    throw new Error(enqueueError)
  }

  totals.jobId = job.id
  await db
    .from('ai_media_runs')
    .update({ totals })
    .eq('id', runId)

  if (actionId) {
    await updateAIAction(actionId, {
      status: 'completed',
      resultData: {
        runId,
        jobId: job.id,
      },
    })
  }

  return {
    runId,
    jobId: job.id,
    status: insertedRun.status as AIMediaRunStatus,
  }
}

function getActionIdFromJobParams(jobParams: any): number | null {
  const actionId = Number(jobParams?.actionId)
  return Number.isFinite(actionId) && actionId > 0 ? actionId : null
}

export async function runMediaJob(jobId: number): Promise<{
  processed: number
  approved: number
  rejected: number
  status: AIMediaRunStatus
}> {
  const db = getAdmin()
  if (!db) throw new Error('Server not configured')

  const state = await getJob(jobId)
  if (!state?.job) throw new Error('Job not found')

  const runId = Number(state.job.params?.runId)
  if (!Number.isFinite(runId) || runId <= 0) {
    throw new Error('Media job is missing runId in params')
  }

  const { data: runRow, error: runError } = await db
    .from('ai_media_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle()

  if (runError || !runRow) {
    throw new Error(runError?.message || 'AI media run not found')
  }

  if (
    runRow.status === 'completed' ||
    runRow.status === 'partial' ||
    runRow.status === 'failed' ||
    runRow.status === 'canceled'
  ) {
    const totals = runRow.totals || {}
    const processedFromTotals = Number(totals?.processed)
    const approved = Number(totals?.approvedImages || 0) + Number(totals?.approvedVideos || 0)
    const rejected = Number(totals?.rejectedImages || 0) + Number(totals?.rejectedVideos || 0)
    const processed = Number.isFinite(processedFromTotals) && processedFromTotals >= 0
      ? processedFromTotals
      : approved + rejected
    return {
      processed,
      approved,
      rejected,
      status: runRow.status as AIMediaRunStatus,
    }
  }

  const actionIdFromJob = getActionIdFromJobParams(state.job.params)
  const generationActionId = await logAIAction({
    actionType: 'ai_media_generation',
    agentName: 'merchandising',
    entityType: 'ai_media_run',
    entityId: String(runId),
    actionData: {
      runId,
      cjProductId: runRow.cj_product_id,
      jobId,
    },
    severity: 'info',
  })

  if (generationActionId) {
    await updateAIAction(generationActionId, { status: 'running' })
  }

  await db
    .from('ai_media_runs')
    .update({
      status: 'running',
      started_at: runRow.started_at || new Date().toISOString(),
      error_text: null,
    })
    .eq('id', runId)

  await ensureProductsBucket(db)

  const params = (runRow.params || {}) as Record<string, any>
  const request = (params.request || {}) as Record<string, any>
  const profileInput = (params.profile || {}) as Record<string, any>

  const normalized = normalizeMediaRunRequest({
    cjProductId: String(request.cjProductId || runRow.cj_product_id || ''),
    sourceContext: (request.sourceContext || runRow.source_context || 'queue') as any,
    targetColors: toStringArray(request.targetColors),
    sourceImages: toUrlArray(request.sourceImages),
    sourceVideoUrl: String(request.sourceVideoUrl || '').trim() || undefined,
    colorImageMap: toColorMap(request.colorImageMap),
    queueProductId: runRow.queue_product_id || undefined,
    productId: runRow.product_id || undefined,
    createdBy: runRow.created_by || undefined,
    imagesPerColor: Number(request?.quality?.imagesPerColor || runRow.requested_images_per_color || 6),
    includeVideo: Boolean(request?.quality?.includeVideo ?? runRow.include_video),
    resolutionPreset: request?.quality?.resolutionPreset === '2k' ? '2k' : '4k',
    categorySlug: String(profileInput.categorySlug || request.categorySlug || '').trim() || undefined,
    categoryLabel: String(profileInput.categoryLabel || request.categoryLabel || '').trim() || undefined,
    preferredVisualStyle: String(request.preferredVisualStyle || '').trim() || undefined,
    luxuryPresentation: request.luxuryPresentation !== false,
  })

  const profile = resolveAIMediaCategoryProfile({
    categorySlug: String(profileInput.categorySlug || normalized.categorySlug || '').trim() || undefined,
    categoryLabel: String(profileInput.categoryLabel || normalized.categoryLabel || '').trim() || undefined,
  })

  let approvedImages = 0
  let rejectedImages = 0
  let approvedVideos = 0
  let rejectedVideos = 0
  let haltedAsCanceled = false
  let runErrorText: string | null = null

  for (const color of normalized.targetColors) {
    const beforeColor = {
      approvedImages,
      rejectedImages,
      approvedVideos,
      rejectedVideos,
    }

    const latestJob = await getJob(jobId)
    if (!latestJob?.job || latestJob.job.status === 'canceled') {
      haltedAsCanceled = true
      break
    }

    const anchorImage = selectBestAnchorImage(color, normalized.colorImageMap, normalized.sourceImages)
    if (!anchorImage) {
      rejectedImages += normalized.quality.imagesPerColor
      if (normalized.quality.includeVideo) rejectedVideos += 1
      if (!runErrorText) {
        runErrorText = `No anchor image found for color: ${color}`
      }
      await addJobItem(jobId, {
        status: 'error',
        step: 'media_color_anchor_missing',
        cj_product_id: runRow.cj_product_id,
        result: { color, error: 'No anchor image found for this color' },
      })
      continue
    }

    for (let i = 1; i <= normalized.quality.imagesPerColor; i++) {
      const imageLoopJob = await getJob(jobId)
      if (!imageLoopJob?.job || imageLoopJob.job.status === 'canceled') {
        haltedAsCanceled = true
        break
      }

      try {
        const generated = await generateAIMediaAsset({
          mediaType: 'image',
          cjProductId: normalized.cjProductId,
          color,
          mediaIndex: i,
          anchorImageUrl: anchorImage,
          sourceVideoUrl: normalized.sourceVideoUrl,
          outputWidth: normalized.quality.outputWidth,
          outputHeight: normalized.quality.outputHeight,
          categoryPrompt: profile.promptTemplate,
          categoryNegativePrompt: profile.negativePromptTemplate,
          preferredVisualStyle: normalized.preferredVisualStyle,
          luxuryPresentation: normalized.luxuryPresentation,
        })

        const fidelity = evaluateAIMediaFidelity({
          sourceUrl: anchorImage,
          outputUrl: generated.url,
          requiredChecks: normalized.quality.requiredChecks,
        })

        let storageUrl = generated.url
        const status: 'ready' | 'rejected' = fidelity.strictPass ? 'ready' : 'rejected'

        if (status === 'ready') {
          storageUrl = await uploadRemoteAssetToStorage({
            db,
            runId,
            cjProductId: normalized.cjProductId,
            color,
            mediaType: 'image',
            mediaIndex: i,
            sourceUrl: generated.url,
          })
        }

        const assetRow = {
          run_id: runId,
          cj_product_id: normalized.cjProductId,
          queue_product_id: normalized.queueProductId || null,
          product_id: normalized.productId || null,
          color,
          media_type: 'image' as const,
          media_index: i,
          storage_url: storageUrl,
          provider: generated.provider || null,
          provider_asset_id: generated.providerAssetId || null,
          prompt_snapshot: generated.promptSnapshot || null,
          fidelity,
          status,
        }

        const { error: insertAssetError } = await db
          .from('ai_media_assets')
          .insert(assetRow)
        if (insertAssetError) {
          throw new Error(insertAssetError.message)
        }

        if (status === 'ready') {
          approvedImages += 1
        } else {
          rejectedImages += 1
        }
      } catch (e: any) {
        rejectedImages += 1
        if (!runErrorText) {
          runErrorText = e?.message || String(e)
        }
      }
    }

    if (haltedAsCanceled) {
      break
    }

    if (normalized.quality.includeVideo) {
      const videoLoopJob = await getJob(jobId)
      if (!videoLoopJob?.job || videoLoopJob.job.status === 'canceled') {
        haltedAsCanceled = true
        break
      }

      try {
        const generatedVideo = await generateAIMediaAsset({
          mediaType: 'video',
          cjProductId: normalized.cjProductId,
          color,
          mediaIndex: 1,
          anchorImageUrl: anchorImage,
          sourceVideoUrl: normalized.sourceVideoUrl,
          outputWidth: normalized.quality.outputWidth,
          outputHeight: normalized.quality.outputHeight,
          categoryPrompt: profile.promptTemplate,
          categoryNegativePrompt: profile.negativePromptTemplate,
          preferredVisualStyle: normalized.preferredVisualStyle,
          luxuryPresentation: normalized.luxuryPresentation,
        })

        const fidelity = evaluateAIMediaFidelity({
          sourceUrl: normalized.sourceVideoUrl || anchorImage,
          outputUrl: generatedVideo.url,
          requiredChecks: normalized.quality.requiredChecks,
        })

        let storageUrl = generatedVideo.url
        const status: 'ready' | 'rejected' = fidelity.strictPass ? 'ready' : 'rejected'

        if (status === 'ready') {
          storageUrl = await uploadRemoteAssetToStorage({
            db,
            runId,
            cjProductId: normalized.cjProductId,
            color,
            mediaType: 'video',
            mediaIndex: 1,
            sourceUrl: generatedVideo.url,
          })
        }

        const assetRow = {
          run_id: runId,
          cj_product_id: normalized.cjProductId,
          queue_product_id: normalized.queueProductId || null,
          product_id: normalized.productId || null,
          color,
          media_type: 'video' as const,
          media_index: 1,
          storage_url: storageUrl,
          provider: generatedVideo.provider || null,
          provider_asset_id: generatedVideo.providerAssetId || null,
          prompt_snapshot: generatedVideo.promptSnapshot || null,
          fidelity,
          status,
        }

        const { error: insertAssetError } = await db
          .from('ai_media_assets')
          .insert(assetRow)
        if (insertAssetError) {
          throw new Error(insertAssetError.message)
        }

        if (status === 'ready') {
          approvedVideos += 1
        } else {
          rejectedVideos += 1
        }
      } catch (e: any) {
        rejectedVideos += 1
        if (!runErrorText) {
          runErrorText = e?.message || String(e)
        }
      }
    }

    if (haltedAsCanceled) {
      break
    }

    const colorApprovedImages = approvedImages - beforeColor.approvedImages
    const colorRejectedImages = rejectedImages - beforeColor.rejectedImages
    const colorApprovedVideos = approvedVideos - beforeColor.approvedVideos
    const colorRejectedVideos = rejectedVideos - beforeColor.rejectedVideos

    await addJobItem(jobId, {
      status: 'success',
      step: 'media_color_complete',
      cj_product_id: normalized.cjProductId,
      result: {
        color,
        approvedImages: colorApprovedImages,
        rejectedImages: colorRejectedImages,
        approvedVideos: colorApprovedVideos,
        rejectedVideos: colorRejectedVideos,
        totals: {
          approvedImages,
          rejectedImages,
          approvedVideos,
          rejectedVideos,
        },
      },
    })
  }

  const latestJobAfterLoop = await getJob(jobId)
  if (!latestJobAfterLoop?.job || latestJobAfterLoop.job.status === 'canceled') {
    haltedAsCanceled = true
  }

  const requestedImages = normalized.targetColors.length * normalized.quality.imagesPerColor
  const requestedVideos = normalized.quality.includeVideo ? normalized.targetColors.length : 0
  const totalRequested = requestedImages + requestedVideos
  const totalApproved = approvedImages + approvedVideos
  const totalRejected = rejectedImages + rejectedVideos
  const totalProcessed = totalApproved + totalRejected

  let finalStatus: AIMediaRunStatus = 'failed'
  if (haltedAsCanceled) {
    finalStatus = 'canceled'
  } else if (totalRequested > 0 && totalApproved === totalRequested) {
    finalStatus = 'completed'
  } else if (totalApproved > 0) {
    finalStatus = 'partial'
  }

  const totals = {
    requestedColors: normalized.targetColors.length,
    requestedImages,
    requestedVideos,
    processed: totalProcessed,
    approvedImages,
    approvedVideos,
    rejectedImages,
    rejectedVideos,
    passRate: totalRequested > 0 ? Number(((totalApproved / totalRequested) * 100).toFixed(2)) : 0,
    jobId,
  }

  const runUpdatePayload = {
    status: finalStatus,
    totals,
    error_text: runErrorText,
    finished_at: new Date().toISOString(),
  }

  if (finalStatus === 'canceled') {
    await db
      .from('ai_media_runs')
      .update(runUpdatePayload)
      .eq('id', runId)
  } else {
    await db
      .from('ai_media_runs')
      .update(runUpdatePayload)
      .eq('id', runId)
      .neq('status', 'canceled')

    const { data: latestRunState } = await db
      .from('ai_media_runs')
      .select('status')
      .eq('id', runId)
      .maybeSingle()

    if (latestRunState?.status === 'canceled') {
      finalStatus = 'canceled'
    }
  }

  await recordMetric({
    metricType: 'media_assets_generated',
    agentName: 'merchandising',
    value: totalApproved,
    unit: 'count',
    metadata: {
      runId,
      cjProductId: normalized.cjProductId,
      status: finalStatus,
    },
  })

  await recordMetric({
    metricType: 'media_fidelity_pass_rate',
    agentName: 'merchandising',
    value: totalRequested > 0 ? Number(((totalApproved / totalRequested) * 100).toFixed(2)) : 0,
    unit: 'percent',
    metadata: {
      runId,
      cjProductId: normalized.cjProductId,
      totalRequested,
    },
  })

  if (generationActionId) {
    const generationActionStatus = finalStatus === 'failed' || finalStatus === 'canceled'
      ? 'failed'
      : 'completed'
    await updateAIAction(generationActionId, {
      status: generationActionStatus,
      resultData: {
        runId,
        status: finalStatus,
        totals,
      },
      errorMessage:
        finalStatus === 'failed'
          ? runErrorText || 'No assets were approved'
          : finalStatus === 'canceled'
            ? 'Canceled by admin'
            : undefined,
    })
  }

  if (actionIdFromJob && (finalStatus === 'failed' || finalStatus === 'canceled')) {
    await updateAIAction(actionIdFromJob, {
      status: 'failed',
      resultData: {
        runId,
        status: finalStatus,
      },
      errorMessage:
        finalStatus === 'canceled'
          ? 'Canceled by admin'
          : runErrorText || 'AI media run failed',
    })
  }

  return {
    processed: totalProcessed,
    approved: totalApproved,
    rejected: totalRejected,
    status: finalStatus,
  }
}

export async function getAIMediaRunDetails(runId: number): Promise<AIMediaRunDetails | null> {
  const db = getAdmin()
  if (!db) return null

  const { data: run } = await db
    .from('ai_media_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle()

  if (!run) return null

  const { data: assets } = await db
    .from('ai_media_assets')
    .select('*')
    .eq('run_id', runId)
    .order('created_at', { ascending: true })

  const request = ((run as any).params?.request || {}) as any
  const assetsList = (assets || []) as AIMediaAssetRecord[]
  const targetColorsFromRequest = toStringArray(request.targetColors)
  const targetColorsFromAssets = Array.from(
    new Set(
      assetsList
        .map((asset) => String((asset as any)?.color || '').trim())
        .filter(Boolean)
    )
  )
  const targetColors = targetColorsFromRequest.length > 0
    ? targetColorsFromRequest
    : targetColorsFromAssets
  const includeVideo =
    typeof (run as any).include_video === 'boolean'
      ? Boolean((run as any).include_video)
      : Boolean(request?.quality?.includeVideo)
  const requestedImagesPerColor = Number(
    (run as any).requested_images_per_color || request?.quality?.imagesPerColor || 0
  )
  const byColor = summarizeColorProgress(
    targetColors,
    includeVideo,
    Number.isFinite(requestedImagesPerColor) ? requestedImagesPerColor : 0,
    assetsList
  )

  let jobId: number | null = null
  const totalsJobId = Number((run as any)?.totals?.jobId)
  if (Number.isFinite(totalsJobId) && totalsJobId > 0) {
    jobId = totalsJobId
  } else {
    const { data: jobs } = await db
      .from('admin_jobs')
      .select('id')
      .eq('kind', 'media')
      .contains('params', { runId })
      .order('id', { ascending: false })
      .limit(1)

    if (Array.isArray(jobs) && jobs[0]?.id) {
      jobId = Number(jobs[0].id)
    }
  }

  return {
    run: run as AIMediaRunRecord,
    assets: assetsList,
    byColor,
    jobId,
  }
}

export async function listAIMediaRuns(input?: {
  limit?: number
  cjProductId?: string
  status?: AIMediaRunStatus
}): Promise<AIMediaRunRecord[]> {
  const db = getAdmin()
  if (!db) return []

  const parsedLimit = Number(input?.limit)
  const limit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(200, Math.floor(parsedLimit)))
    : 50
  const cjProductId = String(input?.cjProductId || '').trim()
  const statusRaw = String(input?.status || '').trim()
  const status: AIMediaRunStatus | undefined =
    statusRaw === 'pending' ||
    statusRaw === 'running' ||
    statusRaw === 'partial' ||
    statusRaw === 'completed' ||
    statusRaw === 'failed' ||
    statusRaw === 'canceled'
      ? (statusRaw as AIMediaRunStatus)
      : undefined

  let query = db
    .from('ai_media_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (cjProductId) {
    query = query.eq('cj_product_id', cjProductId)
  }
  if (status) {
    query = query.eq('status', status)
  }

  const { data } = await query
  return (data || []) as AIMediaRunRecord[]
}

export async function cancelAIMediaRun(runId: number): Promise<boolean> {
  const db = getAdmin()
  if (!db) return false

  const { data: run } = await db
    .from('ai_media_runs')
    .select('id,status,totals')
    .eq('id', runId)
    .maybeSingle()

  if (!run) return false

  if (
    run.status === 'completed' ||
    run.status === 'partial' ||
    run.status === 'failed' ||
    run.status === 'canceled'
  ) {
    return run.status === 'canceled'
  }

  let jobId: number | null = null
  const totalsJobId = Number((run as any)?.totals?.jobId)
  if (Number.isFinite(totalsJobId) && totalsJobId > 0) {
    jobId = totalsJobId
  } else {
    const { data: jobs } = await db
      .from('admin_jobs')
      .select('id')
      .eq('kind', 'media')
      .contains('params', { runId })
      .order('id', { ascending: false })
      .limit(1)

    if (Array.isArray(jobs) && jobs[0]?.id) {
      jobId = Number(jobs[0].id)
    }
  }

  if (!jobId && run.status === 'running') {
    return false
  }

  let linkedJobStatus: string | null = null
  if (jobId) {
    const linkedJob = await getJob(jobId)
    linkedJobStatus = linkedJob?.job?.status || null

    if (!linkedJobStatus && run.status === 'running') {
      return false
    }

    if (
      (run.status === 'pending' || run.status === 'running') &&
      linkedJobStatus &&
      linkedJobStatus !== 'pending' &&
      linkedJobStatus !== 'running' &&
      linkedJobStatus !== 'canceled'
    ) {
      return false
    }
  }

  if (jobId && (linkedJobStatus === 'pending' || linkedJobStatus === 'running')) {
    const canceled = await cancelJob(jobId)
    if (!canceled) {
      const latestJob = await getJob(jobId)
      if (latestJob?.job?.status !== 'canceled') {
        return false
      }
    }
  }

  const { data: canceledRun, error } = await db
    .from('ai_media_runs')
    .update({
      status: 'canceled',
      error_text: 'Canceled by admin',
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId)
    .in('status', ['pending', 'running'])
    .select('id,status')
    .maybeSingle()

  if (error) {
    return false
  }

  if (canceledRun?.id) {
    return true
  }

  const { data: latestRun } = await db
    .from('ai_media_runs')
    .select('status')
    .eq('id', runId)
    .maybeSingle()

  return latestRun?.status === 'canceled'
}

export async function getLatestReadyMediaByCjProductId(cjProductId: string): Promise<{
  assets: AIMediaAssetRecord[]
  runs: AIMediaRunRecord[]
}> {
  const db = getAdmin()
  if (!db) return { assets: [], runs: [] }

  const { data: assets } = await db
    .from('ai_media_assets')
    .select('*')
    .eq('cj_product_id', cjProductId)
    .eq('status', 'ready')
    .order('created_at', { ascending: false })

  const runIds = Array.from(new Set((assets || []).map((a: any) => Number(a.run_id)).filter((id) => Number.isFinite(id) && id > 0)))

  if (runIds.length === 0) {
    return { assets: [], runs: [] }
  }

  let runs: AIMediaRunRecord[] = []
  const { data: runRows } = await db
    .from('ai_media_runs')
    .select('*')
    .in('id', runIds)
    .in('status', ['completed', 'partial'])
    .order('created_at', { ascending: false })

  runs = (runRows || []) as AIMediaRunRecord[]
  if (runs.length === 0) {
    return { assets: [], runs: [] }
  }

  const latestRun = runs[0]
  const latestRunId = Number((latestRun as any)?.id)
  const latestAssets = (assets || [])
    .filter((a: any) => Number(a.run_id) === latestRunId)
    .sort((a: any, b: any) => {
      const ta = Date.parse(String(a?.created_at || ''))
      const tb = Date.parse(String(b?.created_at || ''))
      return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0)
    })

  return {
    assets: latestAssets as AIMediaAssetRecord[],
    runs: [latestRun],
  }
}
