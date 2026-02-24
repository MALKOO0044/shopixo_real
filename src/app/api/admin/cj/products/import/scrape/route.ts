import { NextResponse } from 'next/server';
import { hasTable, hasColumn } from '@/lib/db-features';
import { loggerForRequest } from '@/lib/log';
import { fetchWithMeta } from '@/lib/http';
import { createClient } from '@supabase/supabase-js';
import { slugify } from '@/lib/utils/slug';
import { ensureAdmin } from '@/lib/auth/admin-guard';
import { isKillSwitchOn } from '@/lib/settings';
import { build4kVideoDelivery } from '@/lib/video/delivery';

// Ensure this route is always dynamic and not cached at the edge
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function uniq<T>(arr: T[]): T[] { return Array.from(new Set(arr)); }

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

function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    url.search = '';
    url.protocol = 'https:';
    return url.toString();
  } catch { return u; }
}

function sanitizeTitle(t: string): string {
  let s = t.trim();
  // remove any occurrence of 'CJDropshipping' or 'CJ Dropshipping' (any case, with/without dash)
  s = s.replace(/\b(cj\s*-?\s*dropshipping)\b/ig, '');
  // remove trailing/leading separators left over
  s = s.replace(/\s*-\s*$/g, '');
  s = s.replace(/^\s*-\s*/g, '');
  // collapse multiple spaces
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

function extractFromHtml(html: string, pageUrl: string) {
  // Title: og:title > <title>
  let title = '';
  const og = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (og && og[1]) title = og[1].trim();
  if (!title) {
    const t = html.match(/<title>([^<]+)<\/title>/i);
    if (t && t[1]) title = t[1].trim();
  }
  if (!title) title = 'Untitled';
  title = sanitizeTitle(title);

  // Images: parse <img src|data-src> and filter to product media
  const imgs: string[] = [];
  const attrImgs = html.matchAll(/<img[^>]+(?:data-src|src)=["']([^"']+\.(?:jpg|jpeg|png|webp))(?:\?[^"']*)?["'][^>]*>/ig);
  for (const m of attrImgs) {
    if (typeof m[1] === 'string') imgs.push(normalizeUrl(m[1]));
  }
  // Also catch direct URLs
  const directImgs = html.matchAll(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>]*)?/ig);
  for (const m of directImgs) { if (typeof m[0] === 'string') imgs.push(normalizeUrl(m[0])); }

  // Filter out icons/logos/ui/badges/flags/size-charts/etc.
  const deny = /(sprite|icon|favicon|logo|placeholder|blank|loading|alipay|wechat|whatsapp|kefu|service|avatar|thumb|thumbnail|small|tiny|mini|sizechart|size\s*chart|chart|table|guide|tips|hot|badge|flag|promo|banner|sale|discount|qr|cm|inch)/i;
  const allowHost = /(cjdropshipping|aliyuncs|alicdn|oss-)/i;
  function isSmall(u: string) {
    // match -100x100 etc
    const m = u.match(/-(\d{2,4})x(\d{2,4})(?=\.)/i);
    if (m) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (w < 512 || h < 512) return true;
    }
    // query hints
    const qm = u.match(/[?&](?:w|width|h|height)=(\d{2,4})/i);
    if (qm && Number(qm[1]) < 512) return true;
    return false;
  }
  function normKey(u: string) {
    try {
      const url = new URL(u);
      const name = url.pathname.split('/').pop() || u;
      return name.toLowerCase().replace(/-\d{2,4}x\d{2,4}(?=\.)/, '');
    } catch { return u; }
  }
  const seen = new Set<string>();
  const filtered: string[] = [];
  for (const u of imgs) {
    if (deny.test(u)) continue;
    if (!allowHost.test(u)) continue;
    if (isSmall(u)) continue;
    const key = normKey(u);
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(u);
    if (filtered.length >= 8) break;
  }
  const images = filtered;

  // Video: try og:video, <video src>, <source src>
  let videoUrl: string | null = null;
  const ogv = html.match(/<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i);
  if (ogv && ogv[1]) videoUrl = normalizeUrl(ogv[1]);
  if (!videoUrl) {
    const v1 = html.match(/<video[^>]+src=["']([^"']+\.(?:mp4|m3u8))(?:\?[^"']*)?["']/i);
    if (v1 && v1[1]) videoUrl = normalizeUrl(v1[1]);
  }
  if (!videoUrl) {
    const v2 = html.match(/<source[^>]+src=["']([^"']+\.(?:mp4|m3u8))(?:\?[^"']*)?["']/i);
    if (v2 && v2[1]) videoUrl = normalizeUrl(v2[1]);
  }
  if (!videoUrl) {
    const jv = html.match(/["']videoUrl["']\s*[:=]\s*["'](https?:[^"']+\.(?:mp4|m3u8))["']/i);
    if (jv && jv[1]) videoUrl = normalizeUrl(jv[1]);
  }

  // Attempt to extract numeric id from URL pattern p-123456...html
  const np = pageUrl.match(/p-([0-9]{6,})/i);
  const numericId = np ? np[1] : undefined;

  return { title, images, numericId, videoUrl };
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
      const r = NextResponse.json({ ok: false, version: 'scrape-v3', error: guard.reason }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
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
      const r = NextResponse.json({ ok: false, version: 'scrape-v3', error: 'Kill switch is ON. Import is disabled.' }, { status: 423, headers: { 'Cache-Control': 'no-store' } });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    const { searchParams } = new URL(req.url);
    const urls = new Set<string>();
    for (const u of searchParams.getAll('url')) if (u && u.trim()) urls.add(u.trim());
    const urlsCsv = searchParams.get('urls');
    if (urlsCsv) for (const u of urlsCsv.split(',').map((s) => s.trim()).filter(Boolean)) urls.add(u);
    if (urls.size === 0) {
      const r = NextResponse.json({ ok: false, error: 'Provide url=... (supports multiple)' }, { status: 400 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    const priceParam = Number(searchParams.get('price') || NaN);
    const defaultPrice = Math.max(1, Number(process.env.DEFAULT_SCRAPE_PRICE_SAR || '69'));
    const mediaModeParam = (searchParams.get('mediaMode') || '').trim();

    const results: any[] = [];

    for (const u of Array.from(urls)) {
      try {
        const meta = await fetchWithMeta<string>(u, { method: 'GET', cache: 'no-store', timeoutMs: 12000, retries: 1 });
        log.info('scrape_fetch', { url: u, status: meta.status, ok: meta.ok });
        const html = typeof meta.body === 'string' ? meta.body : '';
        if (!meta.ok || !html) throw new Error('Failed to fetch source page');
        const ext = extractFromHtml(html, u);
        const videoDelivery = build4kVideoDelivery(ext.videoUrl || undefined);
        const deliverableVideoUrl = videoDelivery.qualityGatePassed ? videoDelivery.deliveryUrl : undefined;

        const baseSlug = await ensureUniqueSlug(supabase, ext.title);
        const productPayload: any = {
          // Start with the most common columns only
          title: ext.title,
          slug: baseSlug,
          price: Number.isFinite(priceParam) && priceParam > 0 ? Math.round(priceParam) : defaultPrice,
          category: 'Women',
          stock: 100,
        };

        // Add optional fields that we will prune if absent
        productPayload.description = '';
        productPayload.images = ext.images;
        productPayload.video_url = deliverableVideoUrl || null;
        productPayload.video_source_url = videoDelivery.sourceUrl || null;
        productPayload.video_4k_url = deliverableVideoUrl || null;
        productPayload.video_delivery_mode = videoDelivery.mode;
        productPayload.video_quality_gate_passed = videoDelivery.qualityGatePassed;
        productPayload.video_source_quality_hint = videoDelivery.sourceQualityHint;
        productPayload.media_mode = mediaModeParam || null;
        productPayload.has_video = Boolean(deliverableVideoUrl);
        productPayload.cj_product_id = ext.numericId || null;
        productPayload.processing_time_hours = null;
        productPayload.delivery_time_hours = null;
        productPayload.origin_area = null;
        productPayload.origin_country_code = null;
        productPayload.free_shipping = true;
        productPayload.inventory_shipping_fee = 0;
        productPayload.last_mile_fee = 0;
        productPayload.shipping_from = null;
        productPayload.is_active = (productPayload.price > 0);

        // Omit optional columns that may not exist in this schema
        await omitMissingProductColumns(supabase, productPayload, [
          'cj_product_id',
          'is_active',
          'video_url',
          'video_source_url',
          'video_4k_url',
          'video_delivery_mode',
          'video_quality_gate_passed',
          'video_source_quality_hint',
          'media_mode',
          'has_video',
          'processing_time_hours',
          'delivery_time_hours',
          'origin_area',
          'origin_country_code',
          'free_shipping',
          'inventory_shipping_fee',
          'last_mile_fee',
          'shipping_from',
          'description',
          'images',
        ]);

        // Omit cj_product_id if column missing
        if (!(await hasColumn('products', 'cj_product_id'))) {
          delete productPayload.cj_product_id;
        }

        // Omit is_active if column missing
        if (!(await hasColumn('products', 'is_active'))) {
          delete productPayload.is_active;
        }

        // Insert with base columns only to avoid schema issues
        const baseInsert = {
          title: productPayload.title,
          slug: productPayload.slug,
          price: productPayload.price,
          category: productPayload.category,
          stock: productPayload.stock,
        } as any;

        let productId: number;
        // Insert with basic idempotency on slug conflicts
        try {
          const { data: ins, error: insErr } = await supabase
            .from('products')
            .insert(baseInsert)
            .select('id')
            .single();
          if (insErr || !ins) throw insErr || new Error('Failed to insert product');
          productId = ins.id as number;
        } catch (e: any) {
          const msg = String(e?.message || e || '');
          if (/duplicate key|unique constraint|unique violation|already exists/i.test(msg)) {
            const base = baseInsert.slug || slugify(ext.title);
            const newSlug = await ensureUniqueSlug(supabase, base);
            const retry = { ...baseInsert, slug: newSlug };
            const { data: ins2, error: err2 } = await supabase
              .from('products')
              .insert(retry)
              .select('id')
              .single();
            if (err2 || !ins2) throw err2 || new Error('Failed to insert product (retry)');
            productId = ins2.id as number;
          } else {
            throw e;
          }
        }

        // Optional update with pruned fields if any remain
        const optionalUpdate: Record<string, any> = { ...productPayload };
        delete optionalUpdate.title;
        delete optionalUpdate.slug;
        delete optionalUpdate.price;
        delete optionalUpdate.category;
        delete optionalUpdate.stock;

        await omitMissingProductColumns(supabase, optionalUpdate, [
          'images', 'description', 'video_url', 'video_source_url', 'video_4k_url', 'video_delivery_mode',
          'video_quality_gate_passed', 'video_source_quality_hint', 'media_mode', 'has_video', 'processing_time_hours',
          'delivery_time_hours', 'origin_area', 'origin_country_code', 'free_shipping', 'inventory_shipping_fee',
          'last_mile_fee', 'shipping_from', 'cj_product_id', 'is_active'
        ]);
        const keysLeft = Object.keys(optionalUpdate);
        if (keysLeft.length > 0) {
          await supabase.from('products').update(optionalUpdate).eq('id', productId);
        }

        let variantsInserted = false;
        if (await productVariantsTableExists(supabase)) {
          // One default variant placeholder; will be enriched later by API
          const { error: vErr } = await supabase
            .from('product_variants')
            .insert([{ product_id: productId, option_name: 'Size', option_value: '-', cj_sku: null, price: null, stock: 0 }]);
          if (vErr) throw vErr;
          variantsInserted = true;
        }

        results.push({ ok: true, productId, url: u, title: ext.title, images: ext.images.length, variantsInserted });
      } catch (e: any) {
        results.push({ ok: false, url: u, error: e?.message || String(e) });
      }
    }

    const r = NextResponse.json({ ok: true, version: 'scrape-v3', imported: results.filter(r => r.ok).length, results }, { headers: { 'Cache-Control': 'no-store' } });
    r.headers.set('x-request-id', log.requestId);
    return r;
  } catch (e: any) {
    const r = NextResponse.json({ ok: false, version: 'scrape-v3', error: e?.message || 'Scrape import failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    r.headers.set('x-request-id', loggerForRequest(req).requestId);
    return r;
  }
}
