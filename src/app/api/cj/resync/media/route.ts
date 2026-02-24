import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { loggerForRequest } from '@/lib/log'
import { queryProductByPidOrKeyword, mapCjItemToProductLike } from '@/lib/cj/v2'
import { hasColumn } from '@/lib/db-features'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

async function resyncOne(db: any, id: number, availableColumns: Set<string>) {
  // 1) Load product row (need cj_product_id, title as fallback)
  const { data: p } = await db.from('products')
    .select('id, slug, title, images, cj_product_id')
    .eq('id', id)
    .maybeSingle()
  if (!p) return { id, ok: false, error: 'product not found' }

  // 2) Determine CJ lookup input (pid preferred, else keyword)
  const pid: string | undefined = (p as any).cj_product_id || undefined
  const keyword: string | undefined = pid ? undefined : String((p as any).title || '').split(' ').slice(0, 6).join(' ') || undefined

  const raw = await queryProductByPidOrKeyword({ pid, keyword })
  const list: any[] = Array.isArray(raw?.data?.content)
    ? raw.data.content
    : Array.isArray(raw?.data?.list)
      ? raw.data.list
      : Array.isArray(raw?.content)
        ? raw.content
        : Array.isArray(raw?.data)
          ? raw.data
          : []
  if (!list || list.length === 0) return { id, ok: false, error: 'cj not found' }

  const mapped = mapCjItemToProductLike(list[0])
  if (!mapped) return { id, ok: false, error: 'map failed' }

  // 3) Update only media + title; keep existing slug/price
  const patch: any = {
    title: mapped.name,
    images: mapped.images || [],
  }
  if (availableColumns.has('is_active')) {
    patch.is_active = true
  }
  if (availableColumns.has('video_url')) {
    patch.video_url = mapped.videoUrl || null
  }
  if (availableColumns.has('video_source_url')) {
    patch.video_source_url = mapped.videoSourceUrl || null
  }
  if (availableColumns.has('video_4k_url')) {
    patch.video_4k_url = mapped.video4kUrl || null
  }
  if (availableColumns.has('video_delivery_mode')) {
    patch.video_delivery_mode = mapped.videoDeliveryMode || null
  }
  if (availableColumns.has('video_quality_gate_passed')) {
    patch.video_quality_gate_passed =
      typeof mapped.videoQualityGatePassed === 'boolean' ? mapped.videoQualityGatePassed : null
  }
  if (availableColumns.has('video_source_quality_hint')) {
    patch.video_source_quality_hint = mapped.videoSourceQualityHint || null
  }
  if (availableColumns.has('has_video')) {
    patch.has_video = Boolean(mapped.video4kUrl || mapped.videoUrl)
  }
  // Only set cj_product_id if present and column exists
  try {
    const { error: err } = await db.from('products').update(patch).eq('id', id)
    if (err) return { id, ok: false, error: err.message }
  } catch (e: any) {
    return { id, ok: false, error: e?.message || 'update failed' }
  }
  return { id, ok: true, slug: p.slug }
}

export async function GET(req: Request) {
  const log = loggerForRequest(req)
  try {
    const db = getAdmin()
    if (!db) {
      const r = NextResponse.json({ ok: false, error: 'Supabase not configured' }, { status: 500 })
      r.headers.set('x-request-id', log.requestId)
      return r
    }

    const managedColumns = [
      'is_active',
      'video_url',
      'video_source_url',
      'video_4k_url',
      'video_delivery_mode',
      'video_quality_gate_passed',
      'video_source_quality_hint',
      'has_video',
    ] as const
    const availableColumns = new Set<string>()
    const columnResults = await Promise.all(
      managedColumns.map(async (col) => ({ col, exists: await hasColumn('products', col).catch(() => false) }))
    )
    for (const result of columnResults) {
      if (result.exists) availableColumns.add(result.col)
    }

    const { searchParams } = new URL(req.url)
    const idsParam = searchParams.get('ids') || ''
    let ids: number[] = []
    if (idsParam) {
      ids = idsParam.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
    }

    // If no ids specified, pick up to 10 products missing images
    if (ids.length === 0) {
      const { data } = await db
        .from('products')
        .select('id, images')
        .order('id', { ascending: false })
        .limit(20)
      const candidates = (data || []) as any[]
      ids = candidates
        .filter((p) => !p.images || (Array.isArray(p.images) && p.images.length === 0) || (typeof p.images === 'string' && (!p.images.trim() || p.images.trim() === '[]')))
        .slice(0, 10)
        .map((p) => p.id)
    }

    const results: any[] = []
    for (const id of ids) {
      try { results.push(await resyncOne(db, id, availableColumns)) } catch (e: any) { results.push({ id, ok: false, error: e?.message || 'resync failed' }) }
    }

    const r = NextResponse.json({ ok: true, results })
    r.headers.set('x-request-id', log.requestId)
    return r
  } catch (e: any) {
    const r = NextResponse.json({ ok: false, error: e?.message || 'resync error' }, { status: 500 })
    r.headers.set('x-request-id', log.requestId)
    return r
  }
}
