import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { queryProductByPidOrKeyword } from "@/lib/cj/v2";
import { ensureAdmin } from "@/lib/auth/admin-guard";
import { isAdminUser } from "@/lib/auth/admin-check";
import { normalizeSingleSize, normalizeSizeList } from "@/lib/cj/size-normalization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const isAdmin = await isAdminUser();
  if (!isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const productId = searchParams.get('productId');

  if (!productId) {
    const { data: products } = await supabase
      .from('products')
      .select('id, title, cj_product_id')
      .not('cj_product_id', 'is', null)
      .order('id', { ascending: false })
      .limit(20);

    return NextResponse.json({
      message: 'Add ?productId=X to resync variants for a specific product, or POST with {"productId": X}',
      products_with_cj_id: products || [],
      example_url: products?.[0] ? `/api/admin/cj/resync/variants?productId=${products[0].id}` : null,
      example_post: { productId: products?.[0]?.id || 328 },
    });
  }

  const { data: product } = await supabase
    .from('products')
    .select('id, title, cj_product_id')
    .eq('id', parseInt(productId))
    .single();

  if (!product) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 });
  }

  const { data: currentVariants } = await supabase
    .from('product_variants')
    .select('id, option_name, option_value, cj_variant_id, cj_sku')
    .eq('product_id', parseInt(productId));

  return NextResponse.json({
    product,
    current_variants: currentVariants || [],
    has_cj_variant_ids: (currentVariants || []).some((v: any) => v.cj_variant_id),
    action: 'POST to this URL with {"productId": ' + productId + '} to resync variants from CJ',
  });
}

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function deduplicateByNormalizedKey(items: string[]): string[] {
  const seen = new Map<string, string>();
  for (const item of items) {
    if (!item || typeof item !== 'string') continue;
    const display = item.trim();
    if (!display) continue;
    const key = display.toLowerCase().replace(/\s+/g, ' ');
    if (!seen.has(key)) {
      seen.set(key, display);
    }
  }
  return Array.from(seen.values());
}

function isSkuCode(str: string): boolean {
  if (!str) return false;
  const upper = str.toUpperCase().trim();
  
  if (/^CJ[A-Z]{2,}\d{5,}/.test(upper)) return true;
  
  if (/^[A-Z]{2}\d{4,}[A-Z]+\d+/.test(upper)) return true;
  
  if (/^\d{7,}/.test(str)) return true;
  
  if (/^[A-Z]{2,3}\d{6,}/.test(upper)) return true;
  
  return false;
}

function extractColorAndSize(variantKey: string): { color: string | null; size: string | null } {
  if (!variantKey) return { color: null, size: null };
  
  const separators = ['-', '/'];
  for (const sep of separators) {
    if (variantKey.includes(sep)) {
      const parts = variantKey.split(sep).map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const lastPart = parts[parts.length - 1];
        const normalizedLastSize = normalizeSingleSize(lastPart, { allowNumeric: false });
        if (normalizedLastSize) {
          const colorParts = parts.slice(0, -1);
          const potentialColor = colorParts.join(' ');
          if (isSkuCode(potentialColor)) {
            return { color: null, size: normalizedLastSize };
          }
          return { color: potentialColor, size: normalizedLastSize };
        }
        const firstPart = parts[0];
        const normalizedFirstSize = normalizeSingleSize(firstPart, { allowNumeric: false });
        if (normalizedFirstSize) {
          const colorParts = parts.slice(1);
          const potentialColor = colorParts.join(' ');
          if (isSkuCode(potentialColor)) {
            return { color: null, size: normalizedFirstSize };
          }
          return { color: potentialColor, size: normalizedFirstSize };
        }
      }
    }
  }
  
  if (isSkuCode(variantKey)) {
    return { color: null, size: null };
  }
  
  return { color: variantKey, size: null };
}

export async function POST(req: NextRequest) {
  try {
    const guard = await ensureAdmin();
    if (!guard.ok) {
      return NextResponse.json({ ok: false, error: guard.reason }, { status: 401 });
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: "Database not configured" }, { status: 500 });
    }

    const body = await req.json();
    const productId = body?.productId as number | undefined;
    const cjProductId = body?.cjProductId as string | undefined;

    if (!productId && !cjProductId) {
      return NextResponse.json({ ok: false, error: "Provide productId or cjProductId" }, { status: 400 });
    }

    let product: any = null;
    if (productId) {
      const { data } = await supabase.from("products").select("*").eq("id", productId).single();
      product = data;
    } else if (cjProductId) {
      const { data } = await supabase.from("products").select("*").eq("cj_product_id", cjProductId).single();
      product = data;
    }

    if (!product) {
      return NextResponse.json({ ok: false, error: "Product not found" }, { status: 404 });
    }

    const cjPid = product.cj_product_id;
    if (!cjPid) {
      return NextResponse.json({ ok: false, error: "Product has no CJ product ID" }, { status: 400 });
    }

    const cjResponse = await queryProductByPidOrKeyword({ pid: cjPid });
    const cjData = cjResponse?.data ?? cjResponse;
    const cjProduct = Array.isArray(cjData) ? cjData[0] : (cjData?.content?.[0] ?? cjData);

    if (!cjProduct) {
      return NextResponse.json({ ok: false, error: "CJ product not found" }, { status: 404 });
    }

    const variants = cjProduct.variants || cjProduct.productVariantList || [];
    const allColors: string[] = [];
    const allSizes: string[] = [];

    for (const v of variants) {
      const variantKey = v.variantKey || v.variantNameEn || v.variant_key || '';
      const parsed = extractColorAndSize(variantKey);
      
      const vColor = v.color ? String(v.color).trim() : null;
      const vSize = normalizeSingleSize(v.size ? String(v.size).trim() : null, { allowNumeric: false });
      
      const finalColor = (vColor && !isSkuCode(vColor)) ? vColor : parsed.color;
      const finalSize = (vSize && !isSkuCode(vSize)) ? vSize : parsed.size;
      
      if (finalColor) allColors.push(finalColor);
      if (finalSize) allSizes.push(finalSize);
    }

    const deduplicatedColors = deduplicateByNormalizedKey(allColors);
    const deduplicatedSizes = normalizeSizeList(allSizes, { allowNumeric: false });

    const { error: updateError } = await supabase
      .from("products")
      .update({
        available_colors: deduplicatedColors,
        available_sizes: deduplicatedSizes,
      })
      .eq("id", product.id);

    if (updateError) {
      console.error("[Resync] Update error:", updateError);
      return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
    }

    await supabase.from("product_variants").delete().eq("product_id", product.id);

    const variantRows = variants.map((v: any) => {
      const variantKey = v.variantKey || v.variantNameEn || v.variant_key || '';
      const parsed = extractColorAndSize(variantKey);
      
      const vColor = v.color ? String(v.color).trim() : null;
      const vSize = normalizeSingleSize(v.size ? String(v.size).trim() : null, { allowNumeric: false });
      
      const finalColor = (vColor && !isSkuCode(vColor)) ? vColor : parsed.color;
      const finalSize = (vSize && !isSkuCode(vSize)) ? vSize : parsed.size;
      
      let optionValue: string;
      if (finalColor && finalSize) {
        optionValue = `${finalColor} / ${finalSize}`;
      } else if (finalSize) {
        optionValue = finalSize;
      } else if (finalColor) {
        optionValue = finalColor;
      } else {
        optionValue = variantKey;
      }
      
      // CRITICAL: Properly handle stock - null means "unknown availability" (NOT 0)
      // Only set explicit stock when CJ actually provides the data
      const cjStock = v.cjStock ?? v.cj_stock ?? null;
      const factoryStock = v.factoryStock ?? v.factory_stock ?? null;
      const directStock = v.stock ?? v.variantQuantity ?? null;
      
      let stock: number | null = null;
      
      if (typeof directStock === 'number' && directStock >= 0) {
        // Apply 5-unit safety buffer when we have explicit stock data
        stock = Math.max(0, directStock - 5);
      } else if (typeof cjStock === 'number' && cjStock >= 0) {
        const combined = cjStock + (typeof factoryStock === 'number' && factoryStock >= 0 ? factoryStock : 0);
        stock = Math.max(0, combined - 5);
      } else if (typeof factoryStock === 'number' && factoryStock >= 0) {
        stock = Math.max(0, factoryStock - 5);
      }
      // If no stock data is available, stock stays null = "unknown availability" (treated as in-stock)

      return {
        product_id: product.id,
        option_name: "Color / Size",
        option_value: optionValue,
        cj_sku: v.cjSku || v.variantSku || null,
        cj_variant_id: v.vid || v.variantId || null,
        price: typeof v.sellPrice === 'number' ? v.sellPrice : (typeof v.price === 'number' ? v.price : null),
        stock: stock,
        image_url: v.variantImage || v.imageUrl || null,
      };
    });

    if (variantRows.length > 0) {
      const { error: insertError } = await supabase
        .from("product_variants")
        .insert(variantRows);
      
      if (insertError) {
        console.error("[Resync] Variant insert error:", insertError);
      }
    }

    return NextResponse.json({
      ok: true,
      productId: product.id,
      colors: deduplicatedColors,
      sizes: deduplicatedSizes,
      variantsCount: variantRows.length,
      message: `Resynced ${product.title}: ${deduplicatedColors.length} colors, ${deduplicatedSizes.length} sizes, ${variantRows.length} variants`,
    });
  } catch (e: any) {
    console.error("[Resync] Error:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Resync failed" }, { status: 500 });
  }
}
