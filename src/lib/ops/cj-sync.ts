import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { slugify } from '@/lib/utils/slug'
import { hasTable, hasColumn } from '@/lib/db-features'
import type { CjProductLike } from '@/lib/cj/v2'
import { freightCalculate } from '@/lib/cj/v2'
import { loadPricingPolicy } from '@/lib/pricing-policy'
import { computeRetailFromLanded, convertToSar, maybeUsdToSar } from '@/lib/pricing'

function getSupabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
  if (!url || !key) return null
  return createClient(url, key)
}

export async function productVariantsTableExists(): Promise<boolean> {
  return await hasTable('product_variants')
}

async function ensureUniqueSlug(admin: SupabaseClient, base: string): Promise<string> {
  const s = slugify(base)
  let candidate = s
  for (let i = 2; i <= 50; i++) {
    const { data } = await admin.from('products').select('id').eq('slug', candidate).maybeSingle()
    if (!data) return candidate
    candidate = `${s}-${i}`
  }
  return `${s}-${Date.now()}`
}

export type UpsertOptions = {
  updateImages?: boolean
  updateVideo?: boolean
  updatePrice?: boolean
}

export async function upsertProductFromCj(cj: CjProductLike, options: UpsertOptions = {}): Promise<{ ok: true; productId: number; updated: string[] } | { ok: false; error: string }>{
  const admin = getSupabaseAdmin()
  if (!admin) return { ok: false, error: 'Supabase not configured' }

  try {
    // Find existing by cj_product_id when column exists
    let existing: any = null
    if (await hasColumn('products', 'cj_product_id')) {
      const resp = await admin.from('products').select('id, slug, price').eq('cj_product_id', cj.productId).maybeSingle()
      existing = resp.data || null
    }

    const baseSlug = await ensureUniqueSlug(admin, cj.name)
    const priceCandidates = (cj.variants || []).map((v) => (typeof v.price === 'number' ? v.price : NaN)).filter((n) => !isNaN(n))
    const minVariantPrice = priceCandidates.length > 0 ? Math.min(...priceCandidates) : 0
    const minVariant = (cj.variants || []).reduce<{ price: number; sku?: string } | null>((best, v) => {
      const p = typeof v.price === 'number' ? v.price : NaN
      if (isNaN(p)) return best
      if (!best || p < best.price) return { price: p, sku: v.cjSku }
      return best
    }, null)

    const totalStock = (cj.variants || []).reduce((acc, v) => acc + (typeof v.stock === 'number' ? v.stock : 0), 0)

    const productPayload: any = {
      title: cj.name,
      slug: existing?.slug || baseSlug,
      price: existing?.price ?? minVariantPrice,
      category: 'Women',
      stock: totalStock,
    }

    const optional: Record<string, any> = {
      images: options.updateImages ? (cj.images || []) : undefined,
      video_url: options.updateVideo ? (cj.videoUrl || null) : undefined,
      video_source_url: options.updateVideo ? (cj.videoSourceUrl || null) : undefined,
      video_4k_url: options.updateVideo ? (cj.video4kUrl || null) : undefined,
      video_delivery_mode: options.updateVideo ? (cj.videoDeliveryMode || null) : undefined,
      video_quality_gate_passed:
        options.updateVideo
          ? (typeof cj.videoQualityGatePassed === 'boolean' ? cj.videoQualityGatePassed : null)
          : undefined,
      video_source_quality_hint: options.updateVideo ? (cj.videoSourceQualityHint || null) : undefined,
      has_video: options.updateVideo ? Boolean(cj.video4kUrl || cj.videoUrl) : undefined,
      is_active: true,
      cj_product_id: cj.productId,
      processing_time_hours: (cj as any).processingTimeHours ?? null,
      delivery_time_hours: (cj as any).deliveryTimeHours ?? null,
      origin_area: (cj as any).originArea ?? null,
      origin_country_code: (cj as any).originCountryCode ?? null,
      shipping_from: (cj as any).originArea ?? null,
    }

    // Prune undefineds and columns that don't exist
    const toPrune = Object.keys(optional)
    for (const c of toPrune) {
      if (optional[c] === undefined) delete optional[c]
      else {
        const exists = await hasColumn('products', c)
        if (!exists) delete optional[c]
      }
    }

    const updated: string[] = []

    let productId: number
    if (existing?.id) {
      const { data: upd, error: upErr } = await admin
        .from('products')
        .update({ ...productPayload, ...optional })
        .eq('id', existing.id)
        .select('id')
        .single()
      if (upErr || !upd) throw upErr || new Error('Failed to update product')
      productId = upd.id as number
      updated.push('product')
    } else {
      // Insert with slug conflict retry (include optional columns on insert)
      let insRes: any = null
      try {
        const { data: ins, error: insErr } = await admin
          .from('products')
          .insert({ ...productPayload, ...optional })
          .select('id')
          .single()
        if (insErr || !ins) throw insErr || new Error('Failed to insert product')
        insRes = ins
      } catch (e: any) {
        const msg = String(e?.message || e || '')
        if (/duplicate key|unique constraint|unique violation|already exists/i.test(msg)) {
          const base = productPayload.slug || slugify(cj.name)
          productPayload.slug = await ensureUniqueSlug(admin, base)
          const { data: ins2, error: err2 } = await admin
            .from('products')
            .insert({ ...productPayload, ...optional })
            .select('id')
            .single()
          if (err2 || !ins2) throw err2 || new Error('Failed to insert product (retry)')
          insRes = ins2
        } else {
          throw e
        }
      }
      productId = insRes.id as number
      updated.push('product')
    }

    // Recalculate retail price with shipping + margin when requested
    if (options.updatePrice) {
      try {
        const policy = await loadPricingPolicy()
        let shippingSar = 0
        try {
          // Use variant vid for exact CJ "According to Shipping Method" data
          const variantVid = (minVariant as any)?.vid || minVariant?.sku || cj.productId;
          
          const fc = await freightCalculate({ 
            countryCode: 'US', 
            vid: variantVid, 
            quantity: 1
          })
          if (fc.ok) {
            const cheapest = (fc.options || []).reduce<{ price: number; currency?: string; aging?: { min?: number; max?: number } } | null>((best: { price: number; currency?: string; aging?: { min?: number; max?: number } } | null, opt: any) => {
              const p = Number(opt.price || 0)
              if (!best || p < best.price) return { price: p, currency: opt.currency, aging: opt.logisticAgingDays }
              return best
            }, null)
            if (cheapest) {
              shippingSar = convertToSar(cheapest.price, cheapest.currency)
              // If we have an aging estimate in days, persist to product
              try {
                const aging = cheapest.aging
                if (aging && (typeof aging.min === 'number' || typeof aging.max === 'number')) {
                  const avgDays = typeof aging.min === 'number' && typeof aging.max === 'number' ? (aging.min + aging.max) / 2
                    : (typeof aging.min === 'number' ? aging.min : (aging.max as number))
                  const hours = Math.max(1, Math.round(avgDays * 24))
                  await admin.from('products').update({ delivery_time_hours: hours }).eq('id', productId)
                  updated.push('delivery_time_hours')
                }
              } catch {}
            }
          }
        } catch {}

        const baseCostSar = typeof minVariantPrice === 'number' ? maybeUsdToSar(minVariantPrice) : 0
        const landed = Math.max(0, baseCostSar) + Math.max(0, shippingSar)
        let retail = computeRetailFromLanded(landed, { margin: policy.margin, roundTo: policy.roundTo, prettyEnding: policy.endings })
        if (retail < policy.floorSar) retail = policy.floorSar
        await admin.from('products').update({ price: retail }).eq('id', productId)
        updated.push('price')
      } catch {}
    }

    // Variants table
    if (await productVariantsTableExists()) {
      const variants = (cj.variants || []).filter((v) => v && (v.size || (v as any).color || v.cjSku))
      const hasSize = variants.some((v) => !!(v as any).size)
      const hasColor = variants.some((v: any) => !!(v as any).color)
      const both = hasSize && hasColor
      const optionName = both ? 'Variant' : (hasSize ? 'Size' : (hasColor ? 'Color' : 'Variant'))

      const rows = variants.map((v: any) => ({
        product_id: productId,
        option_name: optionName,
        option_value: both ? `${(v.color as string) || '-'} / ${(v.size as string) || '-'}` : (hasSize ? (v.size || '-') : ((v.color as string) || '-')),
        cj_sku: v.cjSku || null,
        price: typeof v.price === 'number' ? v.price : null,
        stock: typeof v.stock === 'number' ? v.stock : 0,
        // Shipping metadata when available
        weight_grams: typeof v.weightGrams === 'number' ? v.weightGrams : null,
        length_cm: typeof v.lengthCm === 'number' ? v.lengthCm : null,
        width_cm: typeof v.widthCm === 'number' ? v.widthCm : null,
        height_cm: typeof v.heightCm === 'number' ? v.heightCm : null,
      }))
      await admin.from('product_variants').delete().eq('product_id', productId)
      if (rows.length > 0) await admin.from('product_variants').insert(rows)
      updated.push('variants')
    }

    try { await admin.rpc('recompute_product_stock', { product_id_in: productId }) } catch {}

    return { ok: true, productId, updated }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'upsert failed' }
  }
}

export async function persistRawCj(productId: number, raw: any): Promise<void> {
  const admin = getSupabaseAdmin()
  if (!admin) return
  if (!(await hasTable('raw_cj_responses'))) return
  try {
    await admin.from('raw_cj_responses').insert({ product_id: productId, source: 'cj', payload: raw })
  } catch {}
}

export async function logSync(event: string, meta: Record<string, any>) {
  const admin = getSupabaseAdmin()
  if (!admin) return
  if (!(await hasTable('sync_logs'))) return
  try {
    await admin.from('sync_logs').insert({ event, meta })
  } catch {}
}
