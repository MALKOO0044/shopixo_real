import { NextResponse } from 'next/server'
import { ensureAdmin } from '@/lib/auth/admin-guard'
import { loggerForRequest } from '@/lib/log'
import { aiMediaLimiter, getClientIp } from '@/lib/ratelimit'
import { createAIMediaRun, isAIMediaFeatureEnabled, listAIMediaRuns } from '@/lib/ai/media/service'
import type {
  AIMediaRunStatus,
  AIMediaSourceContext,
  CreateAIMediaRunRequest,
} from '@/lib/ai/media/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

function parseSourceContext(value: unknown): AIMediaSourceContext {
  const context = String(value || 'queue').trim()
  if (context === 'discover' || context === 'cj_detail' || context === 'queue' || context === 'product') {
    return context
  }
  return 'queue'
}

function parseStatus(value: string | null): AIMediaRunStatus | undefined {
  const status = String(value || '').trim() as AIMediaRunStatus
  if (
    status === 'pending' ||
    status === 'running' ||
    status === 'partial' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'canceled'
  ) {
    return status
  }
  return undefined
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.floor(parsed)
}

function isSchemaOrTableError(message: string): boolean {
  const normalized = String(message || '').toLowerCase()
  return (
    normalized.includes('schema cache') ||
    normalized.includes('could not find the table') ||
    normalized.includes('relation') && normalized.includes('does not exist') ||
    normalized.includes('does not exist') ||
    normalized.includes('pgrst205') ||
    normalized.includes('42p01')
  )
}

async function enforceRateLimit(req: Request, requestId: string): Promise<NextResponse | null> {
  try {
    const ip = getClientIp(req)
    const lim = await aiMediaLimiter.limit(`admin_ai_media:${ip}`)
    if (!lim.success) {
      const r = NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 })
      r.headers.set('x-request-id', requestId)
      return r
    }
  } catch {
    // ignore limiter failures in environments where Upstash is unavailable
  }
  return null
}

export async function GET(req: Request) {
  const log = loggerForRequest(req)
  try {
    const guard = await ensureAdmin()
    if (!guard.ok) {
      const r = NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
      r.headers.set('x-request-id', log.requestId)
      return r
    }

    const rateLimited = await enforceRateLimit(req, log.requestId)
    if (rateLimited) return rateLimited

    const { searchParams } = new URL(req.url)
    const rawLimit = searchParams.get('limit')
    const parsedLimit = rawLimit && rawLimit.trim() ? Number(rawLimit) : NaN
    const limit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(200, Math.floor(parsedLimit)))
      : 50
    const cjProductId = String(searchParams.get('cjProductId') || '').trim() || undefined
    const status = parseStatus(searchParams.get('status'))

    const runs = await listAIMediaRuns({ limit, cjProductId, status })

    const r = NextResponse.json({ ok: true, runs })
    r.headers.set('x-request-id', log.requestId)
    return r
  } catch (e: any) {
    const r = NextResponse.json({ ok: false, error: e?.message || 'Failed to list AI media runs' }, { status: 500 })
    r.headers.set('x-request-id', log.requestId)
    return r
  }
}

export async function POST(req: Request) {
  const log = loggerForRequest(req)
  try {
    const guard = await ensureAdmin()
    if (!guard.ok) {
      const r = NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
      r.headers.set('x-request-id', log.requestId)
      return r
    }

    const rateLimited = await enforceRateLimit(req, log.requestId)
    if (rateLimited) return rateLimited

    const enabled = await isAIMediaFeatureEnabled()
    if (!enabled) {
      const r = NextResponse.json({ ok: false, error: 'AI media generation is disabled' }, { status: 403 })
      r.headers.set('x-request-id', log.requestId)
      return r
    }

    let body: any = {}
    try {
      body = await req.json()
    } catch {}

    const cjProductId = String(body?.cjProductId || '').trim()
    if (!cjProductId) {
      const r = NextResponse.json({ ok: false, error: 'cjProductId is required' }, { status: 400 })
      r.headers.set('x-request-id', log.requestId)
      return r
    }

    const requestPayload: CreateAIMediaRunRequest = {
      cjProductId,
      sourceContext: parseSourceContext(body?.sourceContext),
      targetColors: Array.isArray(body?.targetColors) ? body.targetColors : undefined,
      sourceImages: Array.isArray(body?.sourceImages) ? body.sourceImages : undefined,
      sourceVideoUrl: typeof body?.sourceVideoUrl === 'string' ? body.sourceVideoUrl : undefined,
      colorImageMap: body?.colorImageMap && typeof body.colorImageMap === 'object' ? body.colorImageMap : undefined,
      queueProductId: parsePositiveInteger(body?.queueProductId),
      productId: parsePositiveInteger(body?.productId),
      createdBy: typeof body?.createdBy === 'string'
        ? body.createdBy
        : String((guard as any)?.user?.email || '').trim() || undefined,
      imagesPerColor: typeof body?.imagesPerColor === 'number' ? body.imagesPerColor : undefined,
      includeVideo: typeof body?.includeVideo === 'boolean' ? body.includeVideo : undefined,
      resolutionPreset: body?.resolutionPreset === '2k' ? '2k' : body?.resolutionPreset === '4k' ? '4k' : undefined,
      categorySlug: typeof body?.categorySlug === 'string' ? body.categorySlug : undefined,
      categoryLabel: typeof body?.categoryLabel === 'string' ? body.categoryLabel : undefined,
      preferredVisualStyle: typeof body?.preferredVisualStyle === 'string' ? body.preferredVisualStyle : undefined,
      luxuryPresentation: typeof body?.luxuryPresentation === 'boolean' ? body.luxuryPresentation : undefined,
    }

    const created = await createAIMediaRun(requestPayload)

    const r = NextResponse.json({ ok: true, run: created }, { status: 201 })
    r.headers.set('x-request-id', log.requestId)
    return r
  } catch (e: any) {
    const message = e?.message || 'Failed to create AI media run'
    const lower = String(message).toLowerCase()
    const status = lower.includes('required') || lower.includes('at least one')
      ? 400
      : isSchemaOrTableError(message) || lower.includes('missing')
        ? 503
        : 500

    const r = NextResponse.json({ ok: false, error: message }, { status })
    r.headers.set('x-request-id', log.requestId)
    return r
  }
}
