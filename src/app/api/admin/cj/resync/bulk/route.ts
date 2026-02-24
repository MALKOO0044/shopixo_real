import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { queryProductByPidOrKeyword } from "@/lib/cj/v2";
import { ensureAdmin } from "@/lib/auth/admin-guard";
import { normalizeSingleSize, normalizeSizeList } from "@/lib/cj/size-normalization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

async function resyncProduct(supabase: any, product: any): Promise<{ ok: boolean; message: string }> {
  const cjPid = product.cj_product_id;
  if (!cjPid) {
    return { ok: false, message: "No CJ product ID" };
  }

  try {
    const cjResponse = await queryProductByPidOrKeyword({ pid: cjPid });
    const cjData = cjResponse?.data ?? cjResponse;
    const cjProduct = Array.isArray(cjData) ? cjData[0] : (cjData?.content?.[0] ?? cjData);

    if (!cjProduct) {
      return { ok: false, message: "CJ product not found" };
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
      return { ok: false, message: updateError.message };
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
      
      const cjStock = v.cjStock ?? v.cj_stock ?? null;
      const factoryStock = v.factoryStock ?? v.factory_stock ?? null;
      const directStock = v.stock ?? v.variantQuantity ?? null;
      
      let stock: number | null = null;
      
      if (typeof directStock === 'number' && directStock >= 0) {
        stock = Math.max(0, directStock - 5);
      } else if (typeof cjStock === 'number' && cjStock >= 0) {
        const combined = cjStock + (typeof factoryStock === 'number' && factoryStock >= 0 ? factoryStock : 0);
        stock = Math.max(0, combined - 5);
      } else if (typeof factoryStock === 'number' && factoryStock >= 0) {
        stock = Math.max(0, factoryStock - 5);
      }

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
        console.error(`[Bulk Resync] Variant insert error for ${product.id}:`, insertError);
      }
    }

    return { 
      ok: true, 
      message: `${deduplicatedColors.length} colors, ${deduplicatedSizes.length} sizes, ${variantRows.length} variants` 
    };
  } catch (e: any) {
    return { ok: false, message: e?.message || "Resync failed" };
  }
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
    const limit = body?.limit || 100;

    const { data: products, error: queryError } = await supabase
      .from("products")
      .select("id, title, cj_product_id")
      .not("cj_product_id", "is", null)
      .limit(limit);

    if (queryError) {
      return NextResponse.json({ ok: false, error: queryError.message }, { status: 500 });
    }

    if (!products || products.length === 0) {
      return NextResponse.json({ ok: true, message: "No CJ products found to resync", results: [] });
    }

    const results: { id: number; title: string; ok: boolean; message: string }[] = [];

    for (const product of products) {
      const result = await resyncProduct(supabase, product);
      results.push({
        id: product.id,
        title: product.title,
        ok: result.ok,
        message: result.message,
      });
      
      await new Promise(r => setTimeout(r, 200));
    }

    const successful = results.filter(r => r.ok).length;
    const failedCount = results.filter(r => !r.ok).length;

    return NextResponse.json({
      ok: true,
      message: `Bulk resync complete: ${successful} succeeded, ${failedCount} failed`,
      total: results.length,
      updated: successful,
      failed: failedCount,
      results,
    });
  } catch (e: any) {
    console.error("[Bulk Resync] Error:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Bulk resync failed" }, { status: 500 });
  }
}
