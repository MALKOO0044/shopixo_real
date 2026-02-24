import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ensureAdmin } from '@/lib/auth/admin-guard';
import { queryProductByPidOrKeyword, mapCjItemToProductLike } from '@/lib/cj/v2';
import { hasTable, hasColumn } from '@/lib/db-features';
import { loggerForRequest } from '@/lib/log';
import { calculateRetailSar, usdToSar } from '@/lib/pricing';
import { isKillSwitchOn } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

async function productVariantsTableExists(_admin: any): Promise<boolean> {
  return await hasTable('product_variants');
}

export async function GET(req: Request) {
  const log = loggerForRequest(req);
  try {
    const guard = await ensureAdmin();
    if (!guard.ok) {
      const r = NextResponse.json({ ok: false, version: 'cj-sync-v1', error: guard.reason }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      const r = NextResponse.json({ ok: false, error: 'Server not configured' }, { status: 500 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    // Global kill-switch enforcement: block write operations
    if (await isKillSwitchOn()) {
      const r = NextResponse.json({ ok: false, version: 'cj-sync-v1', error: 'Kill switch is ON. Sync is temporarily disabled.' }, { status: 423, headers: { 'Cache-Control': 'no-store' } });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    const { searchParams } = new URL(req.url);
    const limit = Math.max(1, Math.min(50, Number(searchParams.get('limit') || '20')));
    const offset = Math.max(0, Number(searchParams.get('offset') || '0'));
    const idsCsv = searchParams.get('ids');
    const updatePrice = (searchParams.get('updatePrice') || 'false').toLowerCase() === 'true';
    const updateImages = (searchParams.get('updateImages') || 'false').toLowerCase() === 'true';
    const updateVideo = (searchParams.get('updateVideo') || 'false').toLowerCase() === 'true';
    const updateRetail = (searchParams.get('updateRetail') || 'false').toLowerCase() === 'true';
    const margin = Number(searchParams.get('margin') || '0.35');
    const handlingSar = Number(searchParams.get('handlingSar') || '0');
    const cjCurrency = (searchParams.get('cjCurrency') || 'USD').toUpperCase(); // USD | SAR

    const hasVariants = await productVariantsTableExists(supabase);
    const productVideoColumns = [
      'video_url',
      'video_source_url',
      'video_4k_url',
      'video_delivery_mode',
      'video_quality_gate_passed',
      'video_source_quality_hint',
      'has_video',
    ] as const;
    const availableVideoColumns = new Set<string>();
    const videoColumnResults = await Promise.all(
      productVideoColumns.map(async (col) => ({ col, exists: await hasColumn('products', col).catch(() => false) }))
    );
    for (const result of videoColumnResults) {
      if (result.exists) availableVideoColumns.add(result.col);
    }

    let products: any[] = [];
    if (idsCsv) {
      const ids = idsCsv.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
      if (ids.length === 0) return NextResponse.json({ ok: false, version: 'cj-sync-v1', error: 'No valid ids provided' }, { status: 400 });
      const { data } = await supabase
        .from('products')
        .select('id, cj_product_id, slug, title, price, images')
        .in('id', ids)
        .not('cj_product_id', 'is', null);
      products = data || [];
    } else {
      const { data } = await supabase
        .from('products')
        .select('id, cj_product_id, slug, title, price, images')
        .not('cj_product_id', 'is', null)
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1);
      products = data || [];
    }

    if (products.length === 0) {
      const r = NextResponse.json({ ok: true, version: 'cj-sync-v1', synced: 0, results: [] }, { headers: { 'Cache-Control': 'no-store' } });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    const results: any[] = [];

    for (const p of products) {
      try {
        const pid = String(p.cj_product_id);
        const raw = await queryProductByPidOrKeyword({ pid });
        const itemRaw = Array.isArray(raw?.data?.content)
          ? raw.data.content[0]
          : Array.isArray(raw?.content)
            ? raw.content[0]
            : (raw?.data || raw);
        const cj = mapCjItemToProductLike(itemRaw);
        if (!cj) throw new Error('CJ item map failed');

        // Update variants if table exists
        if (hasVariants) {
          const rows = (cj.variants || [])
            .filter((v: any) => v && (v.size || v.cjSku))
            .map((v: any) => {
              // Supplier cost (assume CJ in USD unless specified)
              const supplierCostRaw = typeof v.price === 'number' ? v.price : undefined;
              const supplierCostSar = typeof supplierCostRaw === 'number'
                ? (cjCurrency === 'USD' ? usdToSar(supplierCostRaw) : supplierCostRaw)
                : undefined;

              // Weight and dims
              const weightG = typeof v.weightGrams === 'number' ? Math.max(0, v.weightGrams) : undefined;
              const actualKg = typeof weightG === 'number' ? Math.max(0.05, weightG / 1000) : 0.3; // fallback 0.3kg
              const L = typeof v.lengthCm === 'number' ? v.lengthCm : 25; // sensible apparel defaults
              const W = typeof v.widthCm === 'number' ? v.widthCm : 20;
              const H = typeof v.heightCm === 'number' ? v.heightCm : 3;

              // Compute retail inclusive of DDP + margin if requested
              let retailSar: number | null = null;
              let retailSansShip: number | null = null;
              if (updateRetail && typeof supplierCostSar === 'number' && supplierCostSar > 0) {
                const calc = calculateRetailSar(supplierCostSar, { actualKg, lengthCm: L, widthCm: W, heightCm: H }, { handlingSar, margin });
                retailSar = calc.retailSar;
                retailSansShip = Math.max(0, calc.retailSar - calc.ddpShippingSar);
              }

              return {
                product_id: p.id,
                option_name: 'Size',
                option_value: v.size || '-',
                cj_sku: v.cjSku || null,
                price: (retailSansShip ?? (typeof v.price === 'number' ? (cjCurrency === 'USD' ? usdToSar(v.price) : v.price) : null)),
                stock: typeof v.stock === 'number' ? v.stock : 0,
                weight_grams: typeof v.weightGrams === 'number' ? Math.round(v.weightGrams) : null,
                length_cm: typeof v.lengthCm === 'number' ? v.lengthCm : null,
                width_cm: typeof v.widthCm === 'number' ? v.widthCm : null,
                height_cm: typeof v.heightCm === 'number' ? v.heightCm : null,
              } as any;
            });
          await supabase.from('product_variants').delete().eq('product_id', p.id);
          if (rows.length > 0) {
            const { error: vErr } = await supabase.from('product_variants').insert(rows);
            if (vErr) throw vErr;
          }
        }

        // Update product stock, media, and optionally price
        let update: Record<string, any> = {};
        if (hasVariants) {
          const stockSum = (cj.variants || []).reduce((acc: number, v: any) => acc + (typeof v.stock === 'number' ? v.stock : 0), 0);
          update.stock = stockSum;
        }
        if (updateRetail) {
          // Compute product-level price as min of variant retail
          const variantRetail: { full: number; sansShip: number }[] = [];
          for (const v of (cj.variants || [])) {
            const costRaw = typeof v.price === 'number' ? v.price : undefined;
            const costSar = typeof costRaw === 'number' ? (cjCurrency === 'USD' ? usdToSar(costRaw) : costRaw) : undefined;
            const weightG = typeof v.weightGrams === 'number' ? Math.max(0, v.weightGrams) : undefined;
            const actualKg = typeof weightG === 'number' ? Math.max(0.05, weightG / 1000) : 0.3;
            const L = typeof v.lengthCm === 'number' ? v.lengthCm : 25;
            const W = typeof v.widthCm === 'number' ? v.widthCm : 20;
            const H = typeof v.heightCm === 'number' ? v.heightCm : 3;
            if (typeof costSar === 'number' && costSar > 0) {
              const calc = calculateRetailSar(costSar, { actualKg, lengthCm: L, widthCm: W, heightCm: H }, { handlingSar, margin });
              if (typeof calc.retailSar === 'number' && isFinite(calc.retailSar)) variantRetail.push({ full: calc.retailSar, sansShip: Math.max(0, calc.retailSar - calc.ddpShippingSar) });
            }
          }
          if (variantRetail.length > 0) update.price = Math.min(...variantRetail.map(v => v.sansShip));
        } else if (updatePrice) {
          const priceCandidates = (cj.variants || [])
            .map((v: any) => (typeof v.price === 'number' ? (cjCurrency === 'USD' ? usdToSar(v.price) : v.price) : NaN))
            .filter((n: number) => !isNaN(n));
          const base = priceCandidates.length > 0 ? Math.min(...priceCandidates) : undefined;
          if (typeof base === 'number') update.price = base;
        }
        if (updateImages && Array.isArray(cj.images) && cj.images.length > 0) {
          update.images = cj.images;
        }
        if (updateVideo) {
          if (availableVideoColumns.has('video_url')) {
            update.video_url = cj.videoUrl || null;
          }
          if (availableVideoColumns.has('video_source_url')) {
            update.video_source_url = cj.videoSourceUrl || null;
          }
          if (availableVideoColumns.has('video_4k_url')) {
            update.video_4k_url = cj.video4kUrl || null;
          }
          if (availableVideoColumns.has('video_delivery_mode')) {
            update.video_delivery_mode = cj.videoDeliveryMode || null;
          }
          if (availableVideoColumns.has('video_quality_gate_passed')) {
            update.video_quality_gate_passed =
              typeof cj.videoQualityGatePassed === 'boolean' ? cj.videoQualityGatePassed : null;
          }
          if (availableVideoColumns.has('video_source_quality_hint')) {
            update.video_source_quality_hint = cj.videoSourceQualityHint || null;
          }
          if (availableVideoColumns.has('has_video')) {
            update.has_video = Boolean(cj.video4kUrl || cj.videoUrl);
          }
        }
        // Product-level shipping metadata (best-effort)
        if (typeof (cj as any).deliveryTimeHours === 'number') {
          update.delivery_time_hours = Math.round((cj as any).deliveryTimeHours);
        }
        if (typeof (cj as any).processingTimeHours === 'number') {
          update.processing_time_hours = Math.round((cj as any).processingTimeHours);
        }
        if ((cj as any).originArea) update.origin_area = (cj as any).originArea;
        if ((cj as any).originCountryCode) update.origin_country_code = (cj as any).originCountryCode;
        if (Object.keys(update).length > 0) {
          await supabase.from('products').update(update).eq('id', p.id);
        }

        // Recompute stock via RPC if present
        try { await supabase.rpc('recompute_product_stock', { product_id_in: p.id }); } catch {}

        results.push({ ok: true, productId: p.id, cjPid: pid, updated: Object.keys(update) });
      } catch (e: any) {
        results.push({ ok: false, productId: p?.id, error: e?.message || String(e) });
      }
    }

    const r = NextResponse.json({ ok: true, version: 'cj-sync-v1', synced: results.filter(r => r.ok).length, results }, { headers: { 'Cache-Control': 'no-store' } });
    r.headers.set('x-request-id', log.requestId);
    return r;
  } catch (e: any) {
    const r = NextResponse.json({ ok: false, version: 'cj-sync-v1', error: e?.message || 'Sync failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    r.headers.set('x-request-id', loggerForRequest(req).requestId);
    return r;
  }
}
