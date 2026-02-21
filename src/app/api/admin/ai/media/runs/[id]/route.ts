import { NextResponse } from 'next/server'
import { ensureAdmin } from '@/lib/auth/admin-guard'
import { loggerForRequest } from '@/lib/log'
import { aiMediaLimiter, getClientIp } from '@/lib/ratelimit'
import { cancelAIMediaRun, getAIMediaRunDetails } from '@/lib/ai/media/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

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

export async function GET(req: Request, ctx: { params: { id: string } }) {
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

    const runId = Number(ctx.params.id)
    if (!Number.isFinite(runId) || runId <= 0) {
      const r = NextResponse.json({ ok: false, error: 'Invalid run id' }, { status: 400 })
      r.headers.set('x-request-id', log.requestId)
      return r
    }

    const details = await getAIMediaRunDetails(runId)
    if (!details) {
      const r = NextResponse.json({ ok: false, error: 'AI media run not found' }, { status: 404 })
      r.headers.set('x-request-id', log.requestId)
      return r
    }

    const r = NextResponse.json({ ok: true, details })
    r.headers.set('x-request-id', log.requestId)
    return r
  } catch (e: any) {
    const r = NextResponse.json({ ok: false, error: e?.message || 'Failed to fetch AI media run' }, { status: 500 })
    r.headers.set('x-request-id', log.requestId)
    return r
  }
}

export async function POST(req: Request, ctx: { params: { id: string } }) {
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

    const runId = Number(ctx.params.id)
    if (!Number.isFinite(runId) || runId <= 0) {
      const r = NextResponse.json({ ok: false, error: 'Invalid run id' }, { status: 400 })
      r.headers.set('x-request-id', log.requestId)
      return r
    }

    let body: any = {}
    try {
      body = await req.json()
    } catch {}

    const action = String(body?.action || 'cancel').toLowerCase()
    if (action !== 'cancel') {
      const r = NextResponse.json({ ok: false, error: 'Unsupported action' }, { status: 400 })
      r.headers.set('x-request-id', log.requestId)
      return r
    }

    const ok = await cancelAIMediaRun(runId)
    const statusCode = ok ? 200 : 409
    const r = NextResponse.json({ ok }, { status: statusCode })
    r.headers.set('x-request-id', log.requestId)
    return r
  } catch (e: any) {
    const r = NextResponse.json({ ok: false, error: e?.message || 'Failed to cancel AI media run' }, { status: 500 })
    r.headers.set('x-request-id', log.requestId)
    return r
  }
}
