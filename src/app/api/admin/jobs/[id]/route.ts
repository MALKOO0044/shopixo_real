import { NextResponse } from 'next/server';
import { ensureAdmin } from '@/lib/auth/admin-guard';
import { loggerForRequest } from '@/lib/log';
import { getJob, cancelJob } from '@/lib/jobs';
import { cancelAIMediaRun } from '@/lib/ai/media/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const log = loggerForRequest(_req);
  try {
    const guard = await ensureAdmin();
    if (!guard.ok) {
      const r = NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
    const id = Number(ctx.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      const r = NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
    const data = await getJob(id);
    if (!data) {
      const r = NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
    const r = NextResponse.json({ ok: true, ...data });
    r.headers.set('x-request-id', log.requestId);
    return r;
  } catch (e: any) {
    const r = NextResponse.json({ ok: false, error: e?.message || 'job get failed' }, { status: 500 });
    r.headers.set('x-request-id', log.requestId);
    return r;
  }
}

export async function POST(req: Request, ctx: { params: { id: string } }) {
  const log = loggerForRequest(req);
  try {
    const guard = await ensureAdmin();
    if (!guard.ok) {
      const r = NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
    const id = Number(ctx.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      const r = NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
    let body: any = {}; try { body = await req.json(); } catch {}
    const action = String(body?.action || '').toLowerCase();
    if (action === 'cancel') {
      const jobState = await getJob(id);
      if (!jobState?.job) {
        const r = NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
        r.headers.set('x-request-id', log.requestId);
        return r;
      }

      let ok = false;
      if (jobState.job.kind === 'media') {
        const runId = Number((jobState.job as any)?.params?.runId);
        if (Number.isFinite(runId) && runId > 0) {
          ok = await cancelAIMediaRun(runId);
        } else {
          ok = await cancelJob(id);
        }
      } else {
        ok = await cancelJob(id);
      }

      const r = NextResponse.json({ ok }, { status: ok ? 200 : 409 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
    const r = NextResponse.json({ ok: false, error: 'Unsupported action' }, { status: 400 });
    r.headers.set('x-request-id', log.requestId);
    return r;
  } catch (e: any) {
    const r = NextResponse.json({ ok: false, error: e?.message || 'job action failed' }, { status: 500 });
    r.headers.set('x-request-id', log.requestId);
    return r;
  }
}
