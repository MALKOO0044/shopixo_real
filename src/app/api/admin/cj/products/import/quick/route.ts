import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { queryProductByPidOrKeyword, mapCjItemToProductLike, type CjProductLike } from '@/lib/cj/v2';
import { slugify } from '@/lib/utils/slug';
import { ensureAdmin } from '@/lib/auth/admin-guard';
import { hasTable, hasColumn } from '@/lib/db-features';
import { loggerForRequest } from '@/lib/log';
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

async function columnExists(_admin: any, table: string, col: string): Promise<boolean> {
  // Backward-compatible wrapper around centralized feature detection
  return await hasColumn(table, col);
}

async function omitMissingProductColumns(_admin: any, payload: Record<string, any>, cols: string[]) {
  for (const c of cols) {
    if (!(c in payload)) continue;
    try {
      const exists = await hasColumn('products', c);
      if (!exists) delete payload[c];
    } catch {
      delete payload[c];
    }
  }
}

async function productVariantsTableExists(_admin: any): Promise<boolean> {
  return await hasTable('product_variants');
}

function extractPidFromUrl(u?: string | null): string | undefined {
  if (!u) return undefined;
  try {
    const url = new URL(u);
    const cand = url.searchParams.get('pid') || url.searchParams.get('productId') || url.searchParams.get('id');
    if (cand) return cand;
    const m = url.href.match(/[0-9A-Fa-f-]{16,}/);
    return m?.[0];
  } catch {
    return undefined;
  }
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
      const r = NextResponse.json({ ok: false, version: 'quick-v2', error: guard.reason }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      const r = NextResponse.json({ ok: false, error: 'Server not configured' }, { status: 500 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    // Global kill-switch enforcement
    if (await isKillSwitchOn()) {
      const r = NextResponse.json({ ok: false, version: 'quick-v2', error: 'Kill switch is ON. Import is disabled.' }, { status: 423, headers: { 'Cache-Control': 'no-store' } });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    const { searchParams } = new URL(req.url);

    // Collect PIDs from multiple forms: pid=, pids=csv, url=, urls=csv
    const pids = new Set<string>();

    const pidParams = searchParams.getAll('pid');
    for (const p of pidParams) if (p && p.trim()) pids.add(p.trim());

    const pidsCsv = searchParams.get('pids');
    if (pidsCsv) {
      for (const p of pidsCsv.split(',').map((s) => s.trim()).filter(Boolean)) pids.add(p);
    }

    const urlParams = searchParams.getAll('url');
    for (const u of urlParams) {
      const pid = extractPidFromUrl(u);
      if (pid) pids.add(pid);
    }

    const urlsCsv = searchParams.get('urls');
    if (urlsCsv) {
      for (const u of urlsCsv.split(',').map((s) => s.trim()).filter(Boolean)) {
        const pid = extractPidFromUrl(u);
        if (pid) pids.add(pid);
      }
    }

    if (pids.size === 0) {
      const r = NextResponse.json({ ok: false, error: 'Provide pid=... or url=... (supports multiple)' }, { status: 400 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    // Optional pricing params
    const marginPct = Math.max(0, Number(searchParams.get('marginPct') || '0'));
    const shippingSar = Math.max(0, Number(searchParams.get('shippingSar') || '0'));
    const mediaModeParam = (searchParams.get('mediaMode') || '').trim();

    // 1) Fetch CJ items by PID
    const fetched: CjProductLike[] = [];
    for (const pid of Array.from(pids)) {
      try {
        const raw = await queryProductByPidOrKeyword({ pid });
        const itemRaw = Array.isArray(raw?.data?.list)
          ? raw.data.list[0]
          : Array.isArray(raw?.data?.content)
            ? raw.data.content[0]
            : Array.isArray(raw?.content)
              ? raw.content[0]
              : Array.isArray(raw?.data)
                ? raw.data[0]
                : (raw?.data || raw);
        const mapped = mapCjItemToProductLike(itemRaw);
        if (mapped) fetched.push(mapped);
      } catch (e) {
        // continue
      }
    }

    if (fetched.length === 0) {
      const r = NextResponse.json({ ok: false, error: 'No CJ products found for provided inputs' }, { status: 404 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    // 2) Import
    const results: any[] = [];

    for (const cj of fetched) {
      try {
        let existing: any = null;
        if (await columnExists(supabase, 'products', 'cj_product_id')) {
          const resp = await supabase
            .from('products')
            .select('id, slug')
            .eq('cj_product_id', cj.productId)
            .maybeSingle();
          existing = resp.data || null;
        }

        const baseSlug = await ensureUniqueSlug(supabase, cj.name);
        const priceCandidates = (cj.variants || []).map((v) => (typeof v.price === 'number' ? v.price : NaN)).filter((n) => !isNaN(n));
        const baseCost = priceCandidates.length > 0 ? Math.min(...priceCandidates) : 0;
        const defaultPrice = marginPct > 0 || shippingSar > 0
          ? Math.round((baseCost + shippingSar) * (1 + marginPct))
          : baseCost;
        const totalStock = (cj.variants || []).reduce((acc, v) => acc + (typeof v.stock === 'number' ? v.stock : 0), 0);

        let productPayload: any = {
          title: cj.name,
          slug: existing?.slug || baseSlug,
          price: defaultPrice,
          category: 'Women',
          stock: totalStock,
        };

        // optional fields
        const optional: Record<string, any> = {
          description: '',
          images: cj.images || [],
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

        // Prune optional fields that do not exist in schema
        await omitMissingProductColumns(supabase, optional, [
          'description','images','video_url','video_source_url','video_4k_url','video_delivery_mode','video_quality_gate_passed',
          'video_source_quality_hint','media_mode','has_video','processing_time_hours','delivery_time_hours','origin_area',
          'origin_country_code','free_shipping','inventory_shipping_fee','last_mile_fee','shipping_from','cj_product_id','is_active'
        ]);

        let productId: number;
        if (existing?.id) {
          const { data: upd, error: upErr } = await supabase
            .from('products')
            .update({ ...productPayload, ...optional })
            .eq('id', existing.id)
            .select('id')
            .single();
          if (upErr || !upd) throw upErr || new Error('Failed to update product');
          productId = upd.id as number;
        } else {
          // Insert with basic idempotency on slug conflicts
          let insResult: any = null;
          try {
            const { data: ins, error: insErr } = await supabase
              .from('products')
              .insert(productPayload)
              .select('id')
              .single();
            if (insErr || !ins) throw insErr || new Error('Failed to insert product');
            insResult = ins;
          } catch (e: any) {
            const msg = String(e?.message || e || '');
            if (/duplicate key|unique constraint|unique violation|already exists/i.test(msg)) {
              const base = productPayload.slug || slugify(cj.name);
              productPayload.slug = await ensureUniqueSlug(supabase, base);
              const { data: ins2, error: err2 } = await supabase
                .from('products')
                .insert(productPayload)
                .select('id')
                .single();
              if (err2 || !ins2) throw err2 || new Error('Failed to insert product (retry)');
              insResult = ins2;
            } else {
              throw e;
            }
          }
          productId = insResult.id as number;
        }

        // Optional update with pruned optional fields
        if (Object.keys(optional).length > 0) {
          await supabase.from('products').update(optional).eq('id', productId);
        }

        const variantsRows = (cj.variants || [])
          .filter((v) => v && (v.size || v.cjSku || (v as any).vid))
          .map((v) => ({
            product_id: productId,
            option_name: 'Size',
            option_value: v.size || '-',
            cj_sku: v.cjSku || null,
            cj_variant_id: (v as any).vid || (v as any).variantId || null,
            price: typeof v.price === 'number' ? v.price : null,
            stock: typeof v.stock === 'number' ? v.stock : 0,
          }));
        if (variantsRows.length > 0) {
          const { error: vErr } = await supabase.from('product_variants').insert(variantsRows);
          if (vErr) {
            console.warn('[Quick Import] Variant insert failed:', vErr.message);
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

    const r = NextResponse.json({ ok: true, version: 'quick-v2', imported: results.filter(r => r.ok).length, results }, { headers: { 'Cache-Control': 'no-store' } });
    r.headers.set('x-request-id', log.requestId);
    return r;
  } catch (e: any) {
    const r = NextResponse.json({ ok: false, version: 'quick-v2', error: e?.message || 'Quick import failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    r.headers.set('x-request-id', loggerForRequest(req).requestId);
    return r;
  }
}
