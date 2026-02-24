import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { computeRating, normalizeDisplayedRating } from '@/lib/rating/engine';
import { hasTable } from '@/lib/db-features';
import { sarToUsd } from '@/lib/pricing';
import { normalizeCjVideoUrl } from '@/lib/cj/video';

let supabaseAdmin: SupabaseClient | null = null;

function getSupabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('[Import DB] Missing Supabase credentials:', { url: !!url, key: !!key });
    return null;
  }
  if (!supabaseAdmin) {
    supabaseAdmin = createClient(url, key);
  }
  return supabaseAdmin;
}

export function isImportDbConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Check if all required columns exist in product_queue table
// This covers ALL columns that addProductToQueue writes to
export async function checkProductQueueSchema(): Promise<{
  ready: boolean;
  missingColumns: string[];
  migrationSQL: string;
}> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return { ready: false, missingColumns: ['(supabase not configured)'], migrationSQL: '' };
  }

  // ALL extended columns that addProductToQueue requires
  const requiredColumns = [
    { name: 'video_url', type: 'TEXT', default: 'NULL' },
    { name: 'video_source_url', type: 'TEXT', default: 'NULL' },
    { name: 'video_4k_url', type: 'TEXT', default: 'NULL' },
    { name: 'video_delivery_mode', type: 'TEXT', default: 'NULL' },
    { name: 'video_quality_gate_passed', type: 'BOOLEAN', default: 'NULL' },
    { name: 'video_source_quality_hint', type: 'TEXT', default: 'NULL' },
    { name: 'media_mode', type: 'TEXT', default: 'NULL' },
    { name: 'has_video', type: 'BOOLEAN', default: 'false' },
    { name: 'product_code', type: 'TEXT', default: 'NULL' },
    { name: 'weight_g', type: 'NUMERIC', default: 'NULL' },
    { name: 'pack_length', type: 'NUMERIC', default: 'NULL' },
    { name: 'pack_width', type: 'NUMERIC', default: 'NULL' },
    { name: 'pack_height', type: 'NUMERIC', default: 'NULL' },
    { name: 'material', type: 'TEXT', default: 'NULL' },
    { name: 'origin_country', type: 'TEXT', default: 'NULL' },
    { name: 'hs_code', type: 'TEXT', default: 'NULL' },
    { name: 'category_name', type: 'TEXT', default: 'NULL' },
    { name: 'store_sku', type: 'TEXT', default: 'NULL' },
    { name: 'overview', type: 'TEXT', default: 'NULL' },
    { name: 'product_info', type: 'TEXT', default: 'NULL' },
    { name: 'size_info', type: 'TEXT', default: 'NULL' },
    { name: 'product_note', type: 'TEXT', default: 'NULL' },
    { name: 'packing_list', type: 'TEXT', default: 'NULL' },
    { name: 'available_colors', type: 'JSONB', default: 'NULL' },
    { name: 'available_sizes', type: 'JSONB', default: 'NULL' },
    { name: 'available_models', type: 'JSONB', default: 'NULL' },
    { name: 'size_chart_images', type: 'JSONB', default: 'NULL' },
    { name: 'cj_category_id', type: 'TEXT', default: 'NULL' },
    { name: 'variant_pricing', type: 'JSONB', default: "'[]'::JSONB" },
    { name: 'size_chart_data', type: 'JSONB', default: 'NULL' },
    { name: 'specifications', type: 'JSONB', default: "'{}'::JSONB" },
    { name: 'selling_points', type: 'JSONB', default: "'[]'::JSONB" },
    { name: 'inventory_by_warehouse', type: 'JSONB', default: 'NULL' },
    { name: 'inventory_status', type: 'TEXT', default: 'NULL' },
    { name: 'inventory_error_message', type: 'TEXT', default: 'NULL' },
    { name: 'price_breakdown', type: 'JSONB', default: 'NULL' },
    { name: 'cj_total_cost', type: 'NUMERIC(10,2)', default: 'NULL' },
    { name: 'cj_shipping_cost', type: 'NUMERIC(10,2)', default: 'NULL' },
    { name: 'cj_product_cost', type: 'NUMERIC(10,2)', default: 'NULL' },
    { name: 'profit_margin', type: 'NUMERIC(5,2)', default: 'NULL' },
    { name: 'color_image_map', type: 'JSONB', default: 'NULL' },
    { name: 'displayed_rating', type: 'NUMERIC(3,1)', default: 'NULL' },
    { name: 'rating_confidence', type: 'NUMERIC(3,2)', default: 'NULL' },
  ];

  const missingColumns: string[] = [];

  for (const col of requiredColumns) {
    try {
      const { error } = await supabase
        .from('product_queue')
        .select(col.name)
        .limit(1);

      if (error?.code === 'PGRST204') {
        missingColumns.push(col.name);
      }
    } catch (err) {
      missingColumns.push(col.name);
    }
  }

  const migrationSQL = missingColumns.length > 0
    ? requiredColumns
        .filter(col => missingColumns.includes(col.name))
        .map(col => `ALTER TABLE product_queue ADD COLUMN IF NOT EXISTS ${col.name} ${col.type} DEFAULT ${col.default};`)
        .join('\n')
    : '';

  return {
    ready: missingColumns.length === 0,
    missingColumns,
    migrationSQL
  };
}

export async function testImportDbConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return { ok: false, error: 'Supabase not configured' };
    }
    const { error } = await supabase.from('import_batches').select('id').limit(1);
    if (error) {
      if (error.message.includes('does not exist')) {
        return { ok: false, error: 'Import tables not found. Please run the database migration.' };
      }
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Connection failed' };
  }
}

export async function createImportBatch(data: {
  name: string;
  keywords: string;
  category: string;
  filters: any;
  productsFound: number;
}): Promise<{ id: number } | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data: batch, error } = await supabase
    .from('import_batches')
    .insert({
      name: data.name,
      keywords: data.keywords,
      category: data.category,
      filters: data.filters,
      status: 'active',
      products_found: data.productsFound,
      products_approved: 0,
      products_imported: 0,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[Import DB] Failed to create batch:', error.message);
    return null;
  }
  return batch;
}

export async function addProductToQueue(batchId: number, product: {
  productId: string;
  cjSku?: string;
  storeSku?: string;
  name: string;
  description?: string;
  overview?: string;
  productInfo?: string;
  sizeInfo?: string;
  productNote?: string;
  packingList?: string;
  category: string;
  images: string[];
  videoUrl?: string;
  videoSourceUrl?: string;
  video4kUrl?: string;
  videoDeliveryMode?: 'native' | 'enhanced' | 'passthrough';
  videoQualityGatePassed?: boolean;
  videoSourceQualityHint?: '4k' | 'hd' | 'sd' | 'unknown';
  mediaMode?: string;
  variants: any[];
  avgPrice: number;
  supplierRating?: number;
  totalSales?: number;
  totalStock: number;
  processingDays?: number;
  deliveryDaysMin?: number;
  deliveryDaysMax?: number;
  qualityScore?: number;
  displayedRating?: number;
  ratingConfidence?: number;
  weightG?: number;
  packLength?: number;
  packWidth?: number;
  packHeight?: number;
  material?: string;
  productType?: string;
  originCountry?: string;
  hsCode?: string;
  sizeChartImages?: string[];
  availableSizes?: string[];
  availableColors?: string[];
  availableModels?: string[];
  categoryName?: string;
  cjCategoryId?: string;
  supabaseCategoryId?: number;
  supabaseCategorySlug?: string;
  variantPricing?: any[];
  sizeChartData?: any;
  specifications?: Record<string, any>;
  sellingPoints?: string[];
  inventoryByWarehouse?: any;
  inventoryStatus?: string;
  inventoryErrorMessage?: string;
  priceBreakdown?: any;
  cjTotalCost?: number;
  cjShippingCost?: number;
  cjProductCost?: number;
  profitMargin?: number;
  colorImageMap?: Record<string, string>;
}): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { success: false, error: 'Supabase not configured' };
  if (!product.productId) return { success: false, error: 'Missing required field: pid' };
  if (!product.name) return { success: false, error: 'Missing required field: name' };
  if (!Array.isArray(product.variants) || product.variants.length === 0) {
    return { success: false, error: 'Missing required field: variants' };
  }
  for (const v of product.variants) {
    if (!v?.variantSku) return { success: false, error: 'Missing required field: variantSku' };
    if (v?.sellPriceSAR == null) return { success: false, error: 'Missing required field: sellPriceSAR' };
  }

  const normalizedVideoUrl = normalizeCjVideoUrl(product.videoUrl);
  const normalizedVideoSourceUrl = normalizeCjVideoUrl(product.videoSourceUrl);
  const normalizedVideo4kUrl = normalizeCjVideoUrl(product.video4kUrl);
  const canonicalVideoUrl = normalizedVideoUrl || normalizedVideo4kUrl;
  const hasVideo = typeof canonicalVideoUrl === 'string' && canonicalVideoUrl.length > 0;
  const admin = supabase as SupabaseClient;

  async function generateUniqueProductCode(client: SupabaseClient): Promise<string> {
    const gen = () => 'xo' + Math.floor(Math.random() * 1_0000_0000).toString().padStart(8, '0');
    for (let i = 0; i < 6; i++) {
      const code = gen();
      const [{ data: q1 }, { data: q2 }] = await Promise.all([
        client.from('product_queue').select('id').eq('product_code', code).limit(1),
        client.from('products').select('id').eq('product_code', code).limit(1),
      ]);
      if (!q1?.length && !q2?.length) return code;
    }
    const ts = Date.now() % 100000000;
    return 'xo' + String(ts).padStart(8, '0');
  }

  const productCode = await generateUniqueProductCode(admin);
  const storeSku = product.storeSku || productCode;

  const imagesCount = Array.isArray(product.images) ? product.images.length : 0;
  const vpArray: any[] = Array.isArray(product.variantPricing) ? product.variantPricing : [];
  const usdCandidates: number[] = [];
  for (const vp of vpArray) {
    const c = Number(vp?.costPrice);
    if (Number.isFinite(c) && c > 0) usdCandidates.push(c);
  }
  if (Array.isArray(product.variants)) {
    for (const v of product.variants) {
      const c = Number(v?.variantPriceUSD ?? v?.variantPrice);
      if (Number.isFinite(c) && c > 0) usdCandidates.push(c);
    }
  }
  const fallbackAvgUsd = Number((product as any).avgPriceUsd)
    || (Number(product.avgPrice) ? sarToUsd(Number(product.avgPrice)) : 0);
  const minVariantUsd = usdCandidates.length > 0 ? Math.min(...usdCandidates) : fallbackAvgUsd;
  const imgNorm = Math.max(0, Math.min(1, imagesCount / 15));
  const priceNorm = Math.max(0, Math.min(1, minVariantUsd / 50));
  const dynQuality = Math.max(0, Math.min(1, 0.6 * imgNorm + 0.4 * (1 - priceNorm)));

  const ratingSignals = {
    imageCount: imagesCount,
    stock: product.totalStock || 0,
    variantCount: Array.isArray(product.variants) ? product.variants.length : 0,
    qualityScore: typeof product.qualityScore === 'number'
      ? Math.max(0, Math.min(1, product.qualityScore))
      : dynQuality,
    priceUsd: minVariantUsd,
    sentiment: 0,
    orderVolume: 0,
  };
  const ratingOut = computeRating(ratingSignals);
  const providedDisplayed = typeof product.displayedRating === 'number' ? normalizeDisplayedRating(product.displayedRating) : undefined;
  const providedConfidence = typeof product.ratingConfidence === 'number' && Number.isFinite(product.ratingConfidence)
    ? Math.max(0.05, Math.min(1, product.ratingConfidence))
    : undefined;

  // Core fields that always exist
  const productData: Record<string, any> = {
    batch_id: batchId,
    cj_product_id: product.productId,
    cj_sku: product.cjSku || null,
    store_sku: storeSku,
    name_en: product.name,
    name_ar: null,
    description_en: product.description || null,
    description_ar: null,
    overview: product.overview || null,
    product_info: product.productInfo || null,
    size_info: product.sizeInfo || null,
    product_note: product.productNote || null,
    packing_list: product.packingList || null,
    category: product.category,
    images: product.images,
    variants: product.variants,
    cj_price_usd: minVariantUsd,
    shipping_cost_usd: null,
    calculated_retail_sar: null,
    margin_applied: null,
    supplier_rating: product.supplierRating ?? null,
    total_sales: product.totalSales ?? null,
    stock_total: product.totalStock,
    processing_days: product.processingDays ?? null,
    delivery_days_min: product.deliveryDaysMin ?? null,
    delivery_days_max: product.deliveryDaysMax ?? null,
    quality_score: product.qualityScore ?? null,
    displayed_rating: providedDisplayed ?? ratingOut.displayedRating,
    rating_confidence: providedConfidence ?? ratingOut.ratingConfidence,
    status: 'pending',
    admin_notes: null,
    reviewed_by: null,
    reviewed_at: null,
    shopixo_product_id: null,
    imported_at: null,
    updated_at: new Date().toISOString(),
    weight_g: product.weightG || null,
    pack_length: product.packLength || null,
    pack_width: product.packWidth || null,
    pack_height: product.packHeight || null,
    material: product.material || null,
    product_type: product.productType || null,
    origin_country: product.originCountry || null,
    hs_code: product.hsCode || null,
    category_name: product.categoryName || null,
    size_chart_images: product.sizeChartImages || null,
    available_sizes: product.availableSizes || null,
    available_colors: product.availableColors || null,
    available_models: product.availableModels || null,
    cj_category_id: product.cjCategoryId || null,
    supabase_category_id: product.supabaseCategoryId || null,
    supabase_category_slug: product.supabaseCategorySlug || null,
    inventory_status: product.inventoryStatus || null,
    inventory_error_message: product.inventoryErrorMessage || null,
  };
  
  // New columns that require migration - check if they exist first
  const newColumns: Record<string, any> = {
    variant_pricing: product.variantPricing || [],
    size_chart_data: product.sizeChartData || null,
    specifications: product.specifications || {},
    selling_points: product.sellingPoints || [],
    inventory_by_warehouse: product.inventoryByWarehouse || null,
    price_breakdown: product.priceBreakdown || null,
    cj_total_cost: product.cjTotalCost || null,
    cj_shipping_cost: product.cjShippingCost || null,
    cj_product_cost: product.cjProductCost || null,
    profit_margin: product.profitMargin || null,
    color_image_map: product.colorImageMap || null,
    product_code: productCode,
    video_url: canonicalVideoUrl || null,
    video_source_url: normalizedVideoSourceUrl || null,
    video_4k_url: normalizedVideo4kUrl || null,
    video_delivery_mode: product.videoDeliveryMode || null,
    video_quality_gate_passed: typeof product.videoQualityGatePassed === 'boolean' ? product.videoQualityGatePassed : null,
    video_source_quality_hint: product.videoSourceQualityHint || null,
    media_mode: product.mediaMode || null,
    has_video: hasVideo,
  };
  
  // Check which new columns exist in the schema
  const schemaCheck = await checkProductQueueSchema();
  if (schemaCheck.ready) {
    // All new columns exist, add them to productData
    Object.assign(productData, newColumns);
  } else {
    // Only add columns that exist
    for (const col of Object.keys(newColumns)) {
      if (!schemaCheck.missingColumns.includes(col)) {
        productData[col] = newColumns[col];
      }
    }
  }

  // First check if product already exists
  const { data: existing } = await supabase
    .from('product_queue')
    .select('id')
    .eq('cj_product_id', product.productId)
    .maybeSingle();

  let error;
  if (existing) {
    const result = await supabase
      .from('product_queue')
      .update(productData)
      .eq('cj_product_id', product.productId);
    error = result.error;
  } else {
    const result = await supabase
      .from('product_queue')
      .insert(productData);
    error = result.error;
  }

  if (error) {
    // Provide clearer error message for schema cache issues
    let errorMsg = `${error.message} (code: ${error.code})`;
    if (error.code === 'PGRST204') {
      errorMsg = `Database schema cache is outdated. Please go to Supabase Dashboard → Settings → API → click "Reload schema" to refresh. Original error: ${error.message}`;
    }
    if (error.details) {
      errorMsg += ` - ${error.details}`;
    }
    console.error('[Import DB] Failed to add product to queue:', {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      productId: product.productId
    });
    return { success: false, error: errorMsg };
  }

  try {
    const signalsTable = await hasTable('product_rating_signals').catch(() => false);
    if (signalsTable) {
      await supabase.from('product_rating_signals').insert({
        product_id: null,
        cj_product_id: product.productId,
        context: 'queue',
        signals: ratingOut.signals,
        displayed_rating: productData.displayed_rating,
        rating_confidence: productData.rating_confidence,
      });
    }
  } catch {
    // Non-fatal
  }

  return { success: true };
}

export async function logImportAction(batchId: number, action: string, status: string, details: any): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  await supabase.from('import_logs').insert({
    batch_id: batchId,
    action,
    status,
    details,
  });
}

export async function getQueuedProducts(options: {
  status?: string;
  batchId?: number;
  limit?: number;
  offset?: number;
}): Promise<any[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];

  let query = supabase.from('product_queue').select('*');

  if (options.status) {
    query = query.eq('status', options.status);
  }
  if (options.batchId) {
    query = query.eq('batch_id', options.batchId);
  }
  
  query = query.order('created_at', { ascending: false });
  
  if (options.limit) {
    query = query.limit(options.limit);
  }
  if (options.offset) {
    query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[Import DB] Failed to get queued products:', error.message);
    return [];
  }
  return data || [];
}

export async function updateProductStatus(productId: string, status: string, notes?: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;

  const { error } = await supabase
    .from('product_queue')
    .update({
      status,
      admin_notes: notes || null,
      reviewed_at: new Date().toISOString(),
    })
    .eq('cj_product_id', productId);

  if (error) {
    console.error('[Import DB] Failed to update product status:', error.message);
    return false;
  }
  return true;
}

export async function getBatches(limit: number = 50): Promise<any[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('import_batches')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[Import DB] Failed to get batches:', error.message);
    return [];
  }
  return data || [];
}

export async function getQueueStats(): Promise<{ pending: number; approved: number; rejected: number; imported: number }> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { pending: 0, approved: 0, rejected: 0, imported: 0 };

  const [pending, approved, rejected, imported] = await Promise.all([
    supabase.from('product_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('product_queue').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
    supabase.from('product_queue').select('id', { count: 'exact', head: true }).eq('status', 'rejected'),
    supabase.from('product_queue').select('id', { count: 'exact', head: true }).eq('status', 'imported'),
  ]);

  return {
    pending: pending.count || 0,
    approved: approved.count || 0,
    rejected: rejected.count || 0,
    imported: imported.count || 0,
  };
}
