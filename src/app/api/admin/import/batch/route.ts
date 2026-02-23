import { NextRequest, NextResponse } from "next/server";
import { ensureAdmin } from "@/lib/auth/admin-guard";
import { 
  isImportDbConfigured, 
  testImportDbConnection, 
  createImportBatch, 
  addProductToQueue, 
  logImportAction,
  getBatches,
  checkProductQueueSchema
} from "@/lib/db/import-db";
import { extractCjProductVideoUrl, normalizeCjVideoUrl } from "@/lib/cj/video";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  console.log('[Import Batch] POST request received');
  try {
    const guard = await ensureAdmin();
    console.log('[Import Batch] Admin guard result:', guard.ok ? 'authenticated' : guard.reason);
    if (!guard.ok) {
      return NextResponse.json({ ok: false, error: guard.reason }, { status: 401 });
    }
    
    if (!isImportDbConfigured()) {
      console.error('[Import Batch] Supabase not configured');
      return NextResponse.json({ ok: false, error: "Database not configured. Please contact support." }, { status: 500 });
    }
    
    console.log('[Import Batch] Database configured, testing connection...');
    const connTest = await testImportDbConnection();
    if (!connTest.ok) {
      console.error('[Import Batch] Database connection test failed:', connTest.error);
      return NextResponse.json({ ok: false, error: connTest.error || "Database connection failed" }, { status: 500 });
    }
    
    console.log('[Import Batch] Database connection verified, checking schema...');
    
    // Check if schema has all required columns
    const schemaCheck = await checkProductQueueSchema();
    if (!schemaCheck.ready) {
      console.error('[Import Batch] Schema check failed. Missing columns:', schemaCheck.missingColumns);
      return NextResponse.json({ 
        ok: false, 
        error: `Database schema is missing required columns: ${schemaCheck.missingColumns.join(', ')}. Please run the migration SQL in Supabase SQL Editor, then reload the schema in Settings → API.`,
        missingColumns: schemaCheck.missingColumns,
        migrationSQL: schemaCheck.migrationSQL,
        instructions: [
          '1. Go to Supabase Dashboard → SQL Editor',
          '2. Paste and run this SQL:',
          schemaCheck.migrationSQL,
          '3. Go to Settings → API → Click "Reload schema"',
          '4. Try importing products again'
        ]
      }, { status: 400 });
    }
    
    console.log('[Import Batch] Schema verified, processing batch...');
    
    const body = await req.json();
    const { name, keywords, category, filters, products } = body;
    
    if (!products || !Array.isArray(products) || products.length === 0) {
      return NextResponse.json({ ok: false, error: "No products provided" }, { status: 400 });
    }

    const missingRequired: string[] = [];
    for (const p of products) {
      if (!p?.pid && !p?.cjProductId && !p?.productId) missingRequired.push(`pid`);
      if (!p?.name) missingRequired.push(`name`);
      if (!Array.isArray(p?.variants) || p.variants.length === 0) {
        missingRequired.push(`variants`);
      } else {
        for (const v of p.variants) {
          if (!v?.variantSku) missingRequired.push(`variantSku`);
          if (v?.sellPriceSAR == null) missingRequired.push(`sellPriceSAR`);
        }
      }
      if (missingRequired.length > 0) break;
    }
    if (missingRequired.length > 0) {
      return NextResponse.json({ ok: false, error: `Missing required fields: ${missingRequired.join(', ')}` }, { status: 400 });
    }

    const batch = await createImportBatch({
      name: name || `Import ${new Date().toISOString()}`,
      keywords: keywords || "",
      category: category || "General",
      filters: filters || {},
      productsFound: products.length,
    });

    if (!batch) {
      console.error("Failed to create batch");
      return NextResponse.json({ ok: false, error: "Failed to create batch" }, { status: 500 });
    }

    let addedCount = 0;
    let failedCount = 0;
    const failedProducts: string[] = [];
    const errorMessages: string[] = [];
    
    for (const p of products) {
      let avgPrice = p.avgPriceSAR || 0;
      if (!avgPrice && p.variants?.length > 0) {
        avgPrice = p.variants.reduce((sum: number, v: any) => sum + (v.price || v.variantSellPrice || 0), 0) / p.variants.length;
      }

      let totalStock = p.stock || 0;
      if (!totalStock && p.variants?.length > 0) {
        totalStock = p.variants.reduce((sum: number, v: any) => sum + (v.stock || v.variantQuantity || 0), 0);
      }

      const productId = p.cjProductId || p.pid || p.productId;
      
      // Handle images - could be array or single image
      let images: string[] = [];
      if (Array.isArray(p.images)) {
        images = p.images;
      } else if (p.image) {
        images = [p.image];
      }

      const extractedVideoUrl = extractCjProductVideoUrl(p);
      const fallbackVideoUrl = normalizeCjVideoUrl(p?.videoUrl || p?.video || p?.productVideo);
      const videoUrl = extractedVideoUrl || fallbackVideoUrl || undefined;

      const result = await addProductToQueue(batch.id, {
        productId,
        cjSku: p.cjSku || undefined,
        storeSku: p.storeSku || undefined,
        name: p.name || undefined,
        description: p.description || undefined,
        overview: p.overview || undefined,
        productInfo: p.productInfo || undefined,
        sizeInfo: p.sizeInfo || undefined,
        productNote: p.productNote || undefined,
        packingList: p.packingList || undefined,
        category: p.categoryName || category || "General",
        images,
        videoUrl,
        variants: p.variants || [],
        avgPrice,
        displayedRating: typeof p.displayedRating === 'number' ? p.displayedRating : undefined,
        ratingConfidence: typeof p.ratingConfidence === 'number' ? p.ratingConfidence : undefined,
        totalStock,
        processingDays: p.processingDays ?? undefined,
        deliveryDaysMin: p.deliveryDaysMin ?? undefined,
        deliveryDaysMax: p.deliveryDaysMax ?? undefined,
        qualityScore: p.qualityScore ?? undefined,
        weightG: p.productWeight || undefined,
        packLength: p.packLength || undefined,
        packWidth: p.packWidth || undefined,
        packHeight: p.packHeight || undefined,
        material: p.material || undefined,
        productType: p.productType || undefined,
        originCountry: p.originCountry || undefined,
        hsCode: p.hsCode || undefined,
        sizeChartImages: p.sizeChartImages || undefined,
        availableSizes: p.availableSizes || undefined,
        availableColors: p.availableColors || undefined,
        availableModels: p.availableModels || undefined,
        categoryName: p.categoryName || undefined,
        cjCategoryId: p.cjCategoryId || undefined,
        supabaseCategoryId: p.supabaseCategoryId || undefined,
        supabaseCategorySlug: p.supabaseCategorySlug || undefined,
        variantPricing: p.variantPricing || [],
        sizeChartData: p.sizeChartData || undefined,
        specifications: p.specifications || undefined,
        sellingPoints: p.sellingPoints || undefined,
        inventoryByWarehouse: p.inventoryByWarehouse || p.inventory || undefined,
        inventoryStatus: p.inventoryStatus || undefined,
        inventoryErrorMessage: p.inventoryErrorMessage || undefined,
        priceBreakdown: p.priceBreakdown || undefined,
        colorImageMap: p.colorImageMap || undefined,
        cjTotalCost: p.cjTotalCost || undefined,
        cjShippingCost: p.cjShippingCost || undefined,
        cjProductCost: p.cjProductCost || undefined,
        profitMargin: p.profitMargin || undefined,
      });

      if (result.success) {
        addedCount++;
      } else {
        failedCount++;
        failedProducts.push(productId);
        if (result.error && errorMessages.length < 3) {
          errorMessages.push(result.error);
        }
      }
    }
    
    if (addedCount === 0 && products.length > 0) {
      const errorDetail = errorMessages.length > 0 
        ? ` First error: ${errorMessages[0]}`
        : '';
      return NextResponse.json({ 
        ok: false, 
        error: `Failed to add any products to queue. ${failedCount} products failed.${errorDetail}`,
        failedProducts: failedProducts.slice(0, 10),
        errorDetails: errorMessages
      }, { status: 500 });
    }

    await logImportAction(batch.id, "batch_created", "success", { 
      products_count: products.length, 
      keywords, 
      category 
    });

    return NextResponse.json({
      ok: true,
      batchId: batch.id,
      productsAdded: addedCount,
      productsFailed: failedCount,
      ...(failedCount > 0 && { warning: `${failedCount} products failed to add` }),
    });
  } catch (e: any) {
    console.error("Batch creation error:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}

export async function GET() {
  try {
    const batches = await getBatches(50);
    return NextResponse.json({ ok: true, batches });
  } catch (e: any) {
    console.error("Failed to fetch batches:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}
