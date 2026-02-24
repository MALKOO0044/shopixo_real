import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { listCjProductsPage, mapCjItemToProductLike, queryProductByPidOrKeyword } from '@/lib/cj/v2'
import { calculateRetailSar, usdToSar } from '@/lib/pricing'
import { getJob, patchJob, startJob, finishJob, upsertJobItemByPid } from '@/lib/jobs'
import { runScannerJob } from '@/lib/scanner'
import { runMediaJob } from '@/lib/ai/media/service'

function getAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

export async function runJob(id: number): Promise<{ ok: boolean; processed?: number; kind?: string; error?: string }> {
  const db = getAdmin()
  if (!db) return { ok: false, error: 'Server not configured' }
  const state = await getJob(id)
  if (!state) return { ok: false, error: 'Job not found' }
  const job = state.job
  if (job.status === 'success' || job.status === 'canceled') return { ok: true, processed: 0, kind: job.kind }

  await startJob(id)

  try {
    if (job.kind === 'finder') {
      // Run until done by stepping many times
      let processed = 0
      for (let i = 0; i < 2000; i++) {
        const r = await stepFinderJob(id)
        processed += r.added
        if (r.done) break
      }
      await finishJob(id, 'success', { candidates: (job?.totals?.candidates || 0) + processed })
      return { ok: true, processed, kind: job.kind }
    }
    if (job.kind === 'scanner') {
      const res = await runScannerJob(id)
      await finishJob(id, 'success', res)
      return { ok: true, processed: res.updated || 0, kind: job.kind }
    }
    if (job.kind === 'media') {
      const res = await runMediaJob(id)
      const status = res.status === 'failed'
        ? 'error'
        : res.status === 'canceled'
          ? 'canceled'
          : 'success'

      await finishJob(
        id,
        status,
        {
          processed: res.processed,
          approved: res.approved,
          rejected: res.rejected,
          mediaStatus: res.status,
        },
        status === 'error' ? 'AI media run failed' : undefined
      )

      return {
        ok: status !== 'error',
        processed: res.processed,
        kind: job.kind,
        error: status === 'error' ? 'media run failed' : undefined,
      }
    }
    // Other kinds not implemented yet
    await finishJob(id, 'error', null, 'Runner does not support this job kind yet')
    return { ok: false, error: 'unsupported kind' }
  } catch (e: any) {
    await finishJob(id, 'error', null, e?.message || String(e))
    return { ok: false, error: e?.message || String(e) }
  }
}

export async function stepFinderJob(id: number): Promise<{ added: number; done: boolean }> {
  const db = getAdmin()
  if (!db) return { added: 0, done: true }
  const state = await getJob(id)
  if (!state) return { added: 0, done: true }
  const job = state.job
  const params = (job.params || {}) as any

  const keywords: string[] = Array.isArray(params.keywords) ? params.keywords : []
  const pageSize: number = Math.max(1, Math.min(50, Number(params.pageSize || 20)))
  const maxPagesPerKeyword: number = Math.max(1, Math.min(40, Number(params.maxPagesPerKeyword || 5)))
  const pricing = params.pricing || {}
  const margin = typeof pricing.margin === 'number' ? pricing.margin : 0.35
  const handlingSar = typeof pricing.handlingSar === 'number' ? pricing.handlingSar : 0
  const cjCurrency: 'USD' | 'SAR' = (pricing.cjCurrency || 'USD').toUpperCase() === 'SAR' ? 'SAR' : 'USD'

  // Initialize or read cursor
  const cur = params.cursor && typeof params.cursor === 'object'
    ? params.cursor
    : { kwIndex: 0, pageNum: 1, collected: 0 }

  if (!keywords || keywords.length === 0 || cur.kwIndex >= keywords.length) {
    await finishJob(id, 'success', job.totals || { candidates: job.totals?.candidates || 0 })
    return { added: 0, done: true }
  }

  const kw = keywords[cur.kwIndex]

  // Stop if exceeded max pages for current keyword
  if (cur.pageNum > maxPagesPerKeyword) {
    const next = { kwIndex: cur.kwIndex + 1, pageNum: 1, collected: cur.collected }
    await patchJob(id, { params: { ...params, cursor: next } })
    const done = next.kwIndex >= keywords.length
    if (done) await finishJob(id, 'success', job.totals || { candidates: job.totals?.candidates || 0 })
    return { added: 0, done }
  }

  // Fetch a single page
  let list: any[] = []
  try {
    const lr = await listCjProductsPage({ pageNum: cur.pageNum, pageSize, keyword: kw })
    list = Array.isArray(lr?.data?.list) ? lr.data.list : []
  } catch {}

  // If empty page, advance to next keyword
  if (!list || list.length === 0) {
    const next = { kwIndex: cur.kwIndex + 1, pageNum: 1, collected: cur.collected }
    await patchJob(id, { params: { ...params, cursor: next } })
    const done = next.kwIndex >= keywords.length
    if (done) await finishJob(id, 'success', job.totals || { candidates: job.totals?.candidates || 0 })
    return { added: 0, done }
  }

  let added = 0
  for (const it of list) {
    const pid = String(it?.pid || it?.productId || it?.id || '')
    if (!pid) continue

    let mapped: any = null
    try {
      const det = await queryProductByPidOrKeyword({ pid })
      const base = Array.isArray((det as any)?.data?.content) ? (det as any).data.content[0] : ((det as any).data || det)
      mapped = mapCjItemToProductLike(base)
    } catch {}
    if (!mapped) continue

    const variants = Array.isArray(mapped.variants) ? mapped.variants : []
    let stockSum = 0
    let minRetailSansShip: number | null = null
    const outVariants: any[] = []
    for (const v of variants) {
      const costUSD = typeof v.price === 'number' ? v.price : undefined
      const supplierCostSar = typeof costUSD === 'number' ? (cjCurrency === 'USD' ? usdToSar(costUSD) : costUSD) : undefined
      const weightG = typeof v.weightGrams === 'number' ? Math.max(0, v.weightGrams) : undefined
      const L = typeof v.lengthCm === 'number' ? v.lengthCm : 25
      const W = typeof v.widthCm === 'number' ? v.widthCm : 20
      const H = typeof v.heightCm === 'number' ? v.heightCm : 3
      const actualKg = typeof weightG === 'number' ? Math.max(0.05, weightG / 1000) : 0.3

      let retailSar: number | null = null
      let ddpShippingSar: number | null = null
      if (typeof supplierCostSar === 'number' && supplierCostSar > 0) {
        const calc = calculateRetailSar(supplierCostSar, { actualKg, lengthCm: L, widthCm: W, heightCm: H }, { margin, handlingSar })
        retailSar = calc.retailSar
        ddpShippingSar = calc.ddpShippingSar
        const sans = Math.max(0, retailSar - ddpShippingSar)
        if (minRetailSansShip === null || sans < minRetailSansShip) minRetailSansShip = sans
      }
      const stock = typeof v.stock === 'number' ? v.stock : 0
      stockSum += stock

      outVariants.push({
        size: v.size || null,
        color: v.color || null,
        cj_sku: v.cjSku || null,
        supplier_cost_sar: typeof supplierCostSar === 'number' ? supplierCostSar : null,
        retail_sar: typeof retailSar === 'number' ? retailSar : null,
        ddp_shipping_sar: typeof ddpShippingSar === 'number' ? ddpShippingSar : null,
        stock,
        weight_grams: typeof weightG === 'number' ? Math.round(weightG) : null,
        length_cm: typeof v.lengthCm === 'number' ? v.lengthCm : null,
        width_cm: typeof v.widthCm === 'number' ? v.widthCm : null,
        height_cm: typeof v.heightCm === 'number' ? v.heightCm : null,
        imageUrl: v.imageUrl || null,
      })
    }

    await upsertJobItemByPid(id, mapped.productId, {
      status: 'success',
      step: 'candidate',
      result: {
        product: {
          cj_product_id: mapped.productId,
          name: mapped.name,
          images: mapped.images,
          video_url: mapped.videoUrl || null,
          video_source_url: mapped.videoSourceUrl || null,
          video_4k_url: mapped.video4kUrl || null,
          video_delivery_mode: mapped.videoDeliveryMode || null,
          video_quality_gate_passed:
            typeof mapped.videoQualityGatePassed === 'boolean' ? mapped.videoQualityGatePassed : null,
          video_source_quality_hint: mapped.videoSourceQualityHint || null,
          has_video: Boolean(mapped.video4kUrl || mapped.videoUrl),
          origin_area: (mapped as any).originArea ?? null,
          origin_country_code: (mapped as any).originCountryCode ?? null,
          processing_time_hours: (mapped as any).processingTimeHours ?? null,
          delivery_time_hours: (mapped as any).deliveryTimeHours ?? null,
        },
        metrics: {
          stock_sum: stockSum,
          min_retail_sans_ship: minRetailSansShip,
        },
        variants: outVariants,
      },
    })
    added++
  }

  // Advance cursor to next page
  const next = { kwIndex: cur.kwIndex, pageNum: cur.pageNum + 1, collected: cur.collected + added }
  await patchJob(id, { params: { ...params, cursor: next }, totals: { candidates: (job?.totals?.candidates || 0) + added } })

  return { added, done: false }
}
