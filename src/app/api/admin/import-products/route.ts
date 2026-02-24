import { NextRequest, NextResponse } from 'next/server';
import { productSchema } from '@/lib/schemas/product';
import { calculateRetailSar, usdToSar, computeVolumetricWeightKg, detectPricingAnomalies } from '@/lib/pricing';
import { slugify } from '@/lib/utils/slug';
import { generateTitle, generateDescription, translateAr } from '@/lib/ai/enrich';
import { mapCategory } from '@/lib/ai/category-map';
import { hasColumn } from '@/lib/db-features';
import { loggerForRequest } from '@/lib/log';
import { isKillSwitchOn } from '@/lib/settings';
import { ensureAdmin } from '@/lib/auth/admin-guard';
import { getSupabaseAdmin } from '@/app/admin/products/actions';

export const runtime = 'nodejs';

type ImportItem = {
  name: string;
  supplierCost: number;        // numeric in SAR or USD (see currency)
  currency?: 'SAR' | 'USD';
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  weightKg?: number;
  imagesCsv?: string;          // comma-separated URLs (required by schema)
  videoUrl?: string;           // optional single video URL if available from CJ
  videoSourceUrl?: string;
  video4kUrl?: string;
  videoDeliveryMode?: 'native' | 'enhanced' | 'passthrough';
  videoQualityGatePassed?: boolean;
  videoSourceQualityHint?: '4k' | 'hd' | 'sd' | 'unknown';
  mediaMode?: string;
  category?: string;           // optional
  stock?: number;              // default 100
  margin?: number;             // default 0.35
};

export async function POST(req: NextRequest) {
  const log = loggerForRequest(req);
  // Require admin user via centralized guard
  {
    const guard = await ensureAdmin();
    if (!guard.ok) {
      const r = NextResponse.json({ error: 'Not authorized' }, { status: 401 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
  }

  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    const r = NextResponse.json({ error: 'Server misconfiguration: missing Supabase envs' }, { status: 500 });
    r.headers.set('x-request-id', log.requestId);
    return r;
  }

  // Global kill-switch enforcement: block write operations
  if (await isKillSwitchOn()) {
    const r = NextResponse.json({ error: 'Kill switch is ON. Import is temporarily disabled.' }, { status: 423 });
    r.headers.set('x-request-id', log.requestId);
    return r;
  }

  // Probe optional media columns once using centralized db-features
  const [
    hasVideoColumn,
    hasVideoSourceColumn,
    hasVideo4kColumn,
    hasVideoDeliveryModeColumn,
    hasVideoQualityGateColumn,
    hasVideoSourceQualityHintColumn,
    hasMediaModeColumn,
    hasHasVideoColumn,
  ] = await Promise.all([
    hasColumn('products', 'video_url'),
    hasColumn('products', 'video_source_url'),
    hasColumn('products', 'video_4k_url'),
    hasColumn('products', 'video_delivery_mode'),
    hasColumn('products', 'video_quality_gate_passed'),
    hasColumn('products', 'video_source_quality_hint'),
    hasColumn('products', 'media_mode'),
    hasColumn('products', 'has_video'),
  ]);

  let body: { items: ImportItem[]; preview?: boolean; draftOnAnomalies?: boolean };
  try { body = await req.json(); } catch {
    const r = NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    r.headers.set('x-request-id', log.requestId);
    return r;
  }

  const items = Array.isArray(body.items) ? body.items : [];
  const preview = !!body.preview;
  const draftOnAnomalies = !!body.draftOnAnomalies;
  if (items.length === 0) {
    const r = NextResponse.json({ error: 'No items provided' }, { status: 400 });
    r.headers.set('x-request-id', log.requestId);
    return r;
  }

  const results: any[] = [];
  const toInsert: any[] = [];

  for (const it of items) {
    const currency = it.currency || 'SAR';
    const supplierSar = currency === 'USD' ? usdToSar(it.supplierCost) : it.supplierCost;
    const lengthCm = it.lengthCm ?? 25;
    const widthCm = it.widthCm ?? 20;
    const heightCm = it.heightCm ?? 3;
    const weightKg = it.weightKg ?? 0.4;

    const retailCalc = calculateRetailSar(supplierSar, {
      actualKg: weightKg,
      lengthCm,
      widthCm,
      heightCm,
    }, { margin: it.margin ?? 0.35 });
    const volumetricKg = computeVolumetricWeightKg({ actualKg: weightKg, lengthCm, widthCm, heightCm });
    const anomalies = detectPricingAnomalies({
      actualKg: weightKg,
      volumetricKg,
      billedKg: retailCalc.billedWeightKg,
      ddpShippingSar: retailCalc.ddpShippingSar,
      landedCostSar: retailCalc.landedCostSar,
      retailSar: retailCalc.retailSar,
    });

    let title = it.name?.trim() || 'Untitled Product';
    // AI enrichment (optional)
    try {
      title = await generateTitle(title);
    } catch {}
    const slug = slugify(title);
    // Require real product media; do NOT fallback to placeholder
    if (!it.imagesCsv || it.imagesCsv.trim().length === 0) {
      results.push({
        title,
        ok: false,
        errors: { images: ['Images are required. Provide at least one image URL from your source (e.g., CJ).'] },
      });
      continue;
    }
    const images = it.imagesCsv;
    let desc = `${title} — auto-imported. Landed SAR: ${retailCalc.landedCostSar}.`;
    try {
      const gen = await generateDescription(title);
      if (gen) desc = gen;
    } catch {}
    let descAr = '';
    try { descAr = await translateAr(desc); } catch {}

    // Category mapping with confidence; honor provided category when present
    let finalCategory = (it.category && it.category.trim().length > 0) ? it.category.trim() : '';
    if (!finalCategory || finalCategory.toLowerCase() === 'general') {
      const mapped = mapCategory({ cjCategory: it.category, title, description: desc });
      finalCategory = mapped.category;
    }

    const formLike = {
      title,
      slug,
      description: desc,
      price: retailCalc.retailSar,
      stock: it.stock ?? 100,
      category: finalCategory || 'General',
      images,
      ...(draftOnAnomalies && anomalies.length > 0 ? { is_active: false } : {}),
    } as Record<string, any>;

    const validated = productSchema.safeParse(formLike);
    if (!validated.success) {
      results.push({ title, ok: false, errors: validated.error.flatten().fieldErrors });
      continue;
    }

    // Include optional video delivery fields only when corresponding DB columns exist
    const insertRow: Record<string, unknown> = { ...validated.data };
    const canonicalVideoUrl = typeof it.videoUrl === 'string' && it.videoUrl.trim().length > 0
      ? it.videoUrl
      : (typeof it.video4kUrl === 'string' && it.video4kUrl.trim().length > 0 ? it.video4kUrl : undefined);
    if (hasVideoColumn && canonicalVideoUrl) {
      insertRow.video_url = canonicalVideoUrl;
    }
    if (hasVideoSourceColumn && typeof it.videoSourceUrl === 'string') {
      insertRow.video_source_url = it.videoSourceUrl;
    }
    if (hasVideo4kColumn && typeof it.video4kUrl === 'string') {
      insertRow.video_4k_url = it.video4kUrl;
    }
    if (hasVideoDeliveryModeColumn && typeof it.videoDeliveryMode === 'string') {
      insertRow.video_delivery_mode = it.videoDeliveryMode;
    }
    if (hasVideoQualityGateColumn && typeof it.videoQualityGatePassed === 'boolean') {
      insertRow.video_quality_gate_passed = it.videoQualityGatePassed;
    }
    if (hasVideoSourceQualityHintColumn && typeof it.videoSourceQualityHint === 'string') {
      insertRow.video_source_quality_hint = it.videoSourceQualityHint;
    }
    if (hasMediaModeColumn && typeof it.mediaMode === 'string') {
      insertRow.media_mode = it.mediaMode;
    }
    if (hasHasVideoColumn) {
      insertRow.has_video = Boolean(canonicalVideoUrl);
    }
    toInsert.push(insertRow);
    results.push({
      title,
      slug,
      ok: true,
      pricing: retailCalc,
      volumetricKg,
      anomalies,
      category: finalCategory || 'General',
      description: desc,
      description_ar: descAr,
      images: images.split(',').map((s) => s.trim()).filter(Boolean),
      ...(it.videoUrl ? { videoUrl: it.videoUrl } : {}),
    });
  }

  if (!preview && toInsert.length > 0) {
    const { error } = await supabase.from('products').insert(toInsert);
    if (error) {
      const r = NextResponse.json({ error: error.message, results }, { status: 500 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
  }

  const r = NextResponse.json({ inserted: preview ? 0 : toInsert.length, preview, results });
  r.headers.set('x-request-id', log.requestId);
  return r;
}
