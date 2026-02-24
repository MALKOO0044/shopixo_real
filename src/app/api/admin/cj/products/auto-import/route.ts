import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { queryProductByPidOrKeyword, mapCjItemToProductLike, type CjProductLike } from '@/lib/cj/v2';
import { slugify } from '@/lib/utils/slug';
import { ensureAdmin } from '@/lib/auth/admin-guard';
import { loggerForRequest } from '@/lib/log';
import { hasColumn, hasTable } from '@/lib/db-features';
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

async function ensureUniqueSlug(admin: any, base: string): Promise<string> {
  const s = slugify(base);
  let candidate = s;
  for (let i = 2; i <= 50; i++) {
    const { data } = await admin
      .from('products')
      .select('id')
      .eq('slug', candidate)
      .maybeSingle();
    if (!data) return candidate;
    candidate = `${s}-${i}`;
  }
  return `${s}-${Date.now()}`;
}

export async function GET(req: Request) {
  const log = loggerForRequest(req);
  try {
    const guard = await ensureAdmin();
    if (!guard.ok) {
      const r = NextResponse.json({ ok: false, version: 'auto-import-v2', error: guard.reason }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
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
      const r = NextResponse.json({ ok: false, version: 'auto-import-v2', error: 'Kill switch is ON. Auto-import is temporarily disabled.' }, { status: 423, headers: { 'Cache-Control': 'no-store' } });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    const { searchParams } = new URL(req.url);
    const keywordsParam = searchParams.get('keywords') || '';
    const limit = Math.max(1, Math.min(10, Number(searchParams.get('limit') || '2')));
    const categoryParam = (searchParams.get('category') || 'General').trim();
    const mediaModeParam = (searchParams.get('mediaMode') || '').trim();

    const keywords = keywordsParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (keywords.length === 0) {
      const r = NextResponse.json({ ok: false, error: 'Provide ?keywords=women%20dress,women%20blouse&limit=2' }, { status: 400 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    // 1) Aggregate results from CJ for all keywords
    const pool: any[] = [];
    for (const kw of keywords) {
      try {
        const raw = await queryProductByPidOrKeyword({ keyword: kw });
        const itemsRaw = Array.isArray(raw?.data?.list)
          ? raw.data.list
          : Array.isArray(raw?.data?.content)
            ? raw.data.content
            : Array.isArray(raw?.content)
              ? raw.content
              : Array.isArray(raw?.data)
                ? raw.data
                : Array.isArray(raw)
                  ? raw
                  : (raw?.data ? [raw.data] : []);
        for (const it of itemsRaw) {
          const mapped = mapCjItemToProductLike(it);
          if (mapped) pool.push(mapped);
        }
      } catch (e) {
        // continue
      }
    }

    // 2) Deduplicate by productId and take first N
    const seen = new Set<string>();
    const selected: CjProductLike[] = [];
    for (const it of pool) {
      if (!it.productId) continue;
      if (seen.has(it.productId)) continue;
      seen.add(it.productId);
      selected.push(it);
      if (selected.length >= limit) break;
    }

    if (selected.length === 0) {
      const r = NextResponse.json({ ok: false, error: 'No CJ products found from given keywords' }, { status: 404 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    // 3) Import selected items (same logic as POST import route)
    const results: any[] = [];

    const hasVariantsTable = await hasTable('product_variants');
    const productOptionalColumns = [
      'is_active',
      'video_url',
      'video_source_url',
      'video_4k_url',
      'video_delivery_mode',
      'video_quality_gate_passed',
      'video_source_quality_hint',
      'media_mode',
      'has_video',
    ] as const;
    const optionalColumnSet = new Set<string>();
    const optionalColumnResults = await Promise.all(
      productOptionalColumns.map(async (col) => ({ col, exists: await hasColumn('products', col).catch(() => false) }))
    );
    for (const result of optionalColumnResults) {
      if (result.exists) optionalColumnSet.add(result.col);
    }

    for (const cj of selected) {
      try {
        const { data: existing } = await supabase
          .from('products')
          .select('id, slug')
          .eq('cj_product_id', cj.productId)
          .maybeSingle();

        const baseSlug = await ensureUniqueSlug(supabase, cj.name);
        // Compute a conservative product price using min retail without shipping if we can compute; fallback to min supplier cost
        const priceCandidates = (cj.variants || []).map((v) => (typeof v.price === 'number' ? v.price : NaN)).filter((n) => !isNaN(n));
        const defaultPrice = priceCandidates.length > 0 ? Math.min(...priceCandidates) : 0;
        const totalStock = (cj.variants || []).reduce((acc, v) => acc + (typeof v.stock === 'number' ? v.stock : 0), 0);

        let productPayload: any = {
          title: cj.name,
          slug: existing?.slug || baseSlug,
          description: '',
          price: defaultPrice,
          images: cj.images || [],
          category: categoryParam,
          stock: totalStock,
          video_url: cj.videoUrl || null,
          video_source_url: cj.videoSourceUrl || null,
          video_4k_url: cj.video4kUrl || null,
          video_delivery_mode: cj.videoDeliveryMode || null,
          video_quality_gate_passed:
            typeof cj.videoQualityGatePassed === 'boolean' ? cj.videoQualityGatePassed : null,
          video_source_quality_hint: cj.videoSourceQualityHint || null,
          media_mode: mediaModeParam || null,
          has_video: Boolean(cj.video4kUrl || cj.videoUrl),
          processing_time_hours: null,
          delivery_time_hours: cj.deliveryTimeHours ?? null,
          origin_area: cj.originArea ?? null,
          origin_country_code: cj.originCountryCode ?? null,
          free_shipping: true,
          inventory_shipping_fee: 0,
          last_mile_fee: 0,
          cj_product_id: cj.productId,
          shipping_from: cj.originArea ?? null,
          is_active: true,
        };

        // Omit is_active if column missing
        try {
          const probeActive = await supabase.from('products').select('is_active').limit(1);
          if (probeActive.error) {
            const { is_active, ...rest } = productPayload;
            productPayload = rest;
          }
        } catch {
          const { is_active, ...rest } = productPayload;
          productPayload = rest;
        }

        for (const col of productOptionalColumns) {
          if (!optionalColumnSet.has(col) && col in productPayload) {
            delete productPayload[col];
          }
        }

        let productId: number;
        if (existing?.id) {
          const { data: upd, error: upErr } = await supabase
            .from('products')
            .update(productPayload)
            .eq('id', existing.id)
            .select('id')
            .single();
          if (upErr || !upd) throw upErr || new Error('Failed to update product');
          productId = upd.id as number;

          await supabase.from('product_variants').delete().eq('product_id', productId);
        } else {
          const { data: ins, error: insErr } = await supabase
            .from('products')
            .insert(productPayload)
            .select('id')
            .single();
          if (insErr || !ins) throw insErr || new Error('Failed to insert product');
          productId = ins.id as number;
        }

        if (hasVariantsTable) {
          const variantsRows = (cj.variants || [])
            .filter((v) => v && ((v.size || v.color) || v.cjSku))
            .map((v) => {
              const color = (v as any).color || null;
              const size = (v as any).size || null;
              const optionValue = color ? (size ? `${color} / ${size}` : color) : (size || '-');
              return {
                product_id: productId,
                option_name: 'Variant',
                option_value: optionValue,
                cj_sku: v.cjSku || null,
                price: typeof v.price === 'number' ? v.price : null,
                stock: typeof v.stock === 'number' ? v.stock : 0,
                weight_grams: typeof (v as any).weightGrams === 'number' ? Math.round((v as any).weightGrams) : null,
                length_cm: typeof (v as any).lengthCm === 'number' ? (v as any).lengthCm : null,
                width_cm: typeof (v as any).widthCm === 'number' ? (v as any).widthCm : null,
                height_cm: typeof (v as any).heightCm === 'number' ? (v as any).heightCm : null,
              } as any;
            });
          if (variantsRows.length > 0) {
            const { error: vErr } = await supabase.from('product_variants').insert(variantsRows as any[]);
            if (vErr) throw vErr;
          }
        }

        try {
          await supabase.rpc('recompute_product_stock', { product_id_in: productId });
        } catch {}

        results.push({ ok: true, productId, title: cj.name });
      } catch (e: any) {
        results.push({ ok: false, error: e?.message || String(e), title: cj?.name });
      }
    }

    const r = NextResponse.json({ ok: true, version: 'auto-import-v2', selected: selected.map((s) => ({ productId: s.productId, name: s.name })), results }, { headers: { 'Cache-Control': 'no-store' } });
    r.headers.set('x-request-id', log.requestId);
    return r;
  } catch (e: any) {
    const r = NextResponse.json({ ok: false, version: 'auto-import-v2', error: e?.message || 'Auto import failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    r.headers.set('x-request-id', loggerForRequest(req).requestId);
    return r;
  }
}
