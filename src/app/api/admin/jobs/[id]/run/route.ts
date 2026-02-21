import { NextResponse } from 'next/server'
import { ensureAdmin } from '@/lib/auth/admin-guard'
import { loggerForRequest } from '@/lib/log'
import { getJob, startJob, finishJob } from '@/lib/jobs'
import { runJob, stepFinderJob } from '@/lib/runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(req: Request, ctx: { params: { id: string } }) {
  const log = loggerForRequest(req)
  try {
    const guard = await ensureAdmin()
    if (!guard.ok) {
      const r = NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
      r.headers.set('x-request-id', log.requestId)
      return r
    }
    const id = Number(ctx.params.id)
    if (!Number.isFinite(id) || id <= 0) {
      const r = NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 })
      r.headers.set('x-request-id', log.requestId)
      return r
    }
    const st = await getJob(id)
    if (!st) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    if (st.job.kind !== 'finder') {
      const result = await runJob(id)
      const r = NextResponse.json({
        ok: result.ok,
        done: true,
        kind: st.job.kind,
        processed: result.processed || 0,
        error: result.error || null,
      }, { status: result.ok ? 200 : 500 })
      r.headers.set('x-request-id', log.requestId)
      return r
    }

    let body: any = {}
    try { body = await req.json() } catch {}
    const mode = (body?.mode || 'step') as 'step' | 'all'
    const maxSteps = Math.max(1, Math.min(200, Number(body?.steps || 1)))

    if (st.job.status === 'pending') await startJob(id)

    let stepsRun = 0
    let candidatesAddedTotal = 0
    let done = false

    const safety = mode === 'all' ? 2000 : maxSteps
    for (let i = 0; i < safety; i++) {
      const res = await stepFinderJob(id)
      stepsRun++
      candidatesAddedTotal += res.added
      if (res.done) { done = true; break }
      if (mode === 'step' && stepsRun >= maxSteps) break
    }

    if (done) {
      // ensure job is success (stepFinderJob finalizes, but be safe)
      try { await finishJob(id, 'success', { stepsRun, candidatesAddedTotal }) } catch {}
    }

    const r = NextResponse.json({ ok: true, done, stepsRun, candidatesAddedTotal })
    r.headers.set('x-request-id', log.requestId)
    return r
  } catch (e: any) {
    const r = NextResponse.json({ ok: false, error: e?.message || 'run failed' }, { status: 500 })
    r.headers.set('x-request-id', log.requestId)
    return r
  }
}
