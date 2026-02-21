import { NextResponse } from 'next/server'
import { ensureAdmin } from '@/lib/auth/admin-guard'
import { loggerForRequest } from '@/lib/log'
import { aiMediaLimiter, getClientIp } from '@/lib/ratelimit'
import { getLatestReadyMediaByCjProductId } from '@/lib/ai/media/service'

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
    const cjProductId = String(searchParams.get('cjProductId') || '').trim()
    if (!cjProductId) {
      const r = NextResponse.json({ ok: false, error: 'cjProductId is required' }, { status: 400 })
      r.headers.set('x-request-id', log.requestId)
      return r
    }

    const result = await getLatestReadyMediaByCjProductId(cjProductId)
    const latestRun = result.runs[0] || null

    const r = NextResponse.json({
      ok: true,
      cjProductId,
      run: latestRun,
      assets: result.assets,
    })
    r.headers.set('x-request-id', log.requestId)
    return r
  } catch (e: any) {
    const r = NextResponse.json({ ok: false, error: e?.message || 'Failed to fetch latest ready media' }, { status: 500 })
    r.headers.set('x-request-id', log.requestId)
    return r
  }
}
