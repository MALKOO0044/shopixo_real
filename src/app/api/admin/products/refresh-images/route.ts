import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ensureAdmin } from '@/lib/auth/admin-guard';
import { fetchProductDetailsByPid, getAccessToken } from '@/lib/cj/v2';
import { fetchJson } from '@/lib/http';
import { extractCjProductGalleryImages } from '@/lib/cj/image-gallery';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function extractAllImages(item: any): string[] {
  return extractCjProductGalleryImages(item, 50);
}

async function fetchProductFromCj(cjProductId: string): Promise<any | null> {
  try {
    const details = await fetchProductDetailsByPid(cjProductId);
    return details;
  } catch (e: any) {
    console.log(`[Refresh Images] Failed to fetch CJ product ${cjProductId}:`, e?.message);
    return null;
  }
}

async function fetchProductByVariantSku(variantSku: string): Promise<any | null> {
  try {
    const token = await getAccessToken();
    const base = process.env.CJ_API_BASE || 'https://developers.cjdropshipping.com/api2.0/v1';
    
    const res = await fetchJson<any>(`${base}/product/variant/queryByVid?vid=${encodeURIComponent(variantSku)}`, {
      headers: {
        'CJ-Access-Token': token,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      timeoutMs: 15000,
    });
    
    const pid = res?.data?.pid || res?.data?.productId;
    if (pid) {
      return await fetchProductDetailsByPid(pid);
    }
    return null;
  } catch (e: any) {
    console.log(`[Refresh Images] Failed to fetch by variant SKU ${variantSku}:`, e?.message);
    return null;
  }
}

async function refreshProductImages(
  supabase: any,
  productId: number
): Promise<{ success: boolean; imagesCount: number; error?: string }> {
  const { data: product, error: fetchError } = await supabase
    .from('products')
    .select('id, title, cj_product_id, supplier_sku, images')
    .eq('id', productId)
    .single();
  
  if (fetchError || !product) {
    return { success: false, imagesCount: 0, error: 'Product not found' };
  }
  
  let cjDetails: any = null;
  
  if ((product as any).cj_product_id) {
    cjDetails = await fetchProductFromCj((product as any).cj_product_id);
  }
  
  if (!cjDetails && (product as any).supplier_sku) {
    const sku = ((product as any).supplier_sku as string).replace(/^CJ-/, '');
    
    if (sku.length > 15 && !sku.includes('-')) {
      cjDetails = await fetchProductFromCj(sku);
    }
    
    if (!cjDetails) {
      cjDetails = await fetchProductByVariantSku(sku);
    }
  }
  
  if (!cjDetails) {
    return { 
      success: false, 
      imagesCount: Array.isArray((product as any).images) ? (product as any).images.length : 0, 
      error: 'No CJ product ID or valid supplier SKU found' 
    };
  }
  
  const allImages = extractAllImages(cjDetails);
  
  if (allImages.length === 0) {
    return { 
      success: false, 
      imagesCount: 0, 
      error: 'No images found in CJ response' 
    };
  }
  
  const { error: updateError } = await supabase
    .from('products')
    .update({ 
      images: allImages,
      updated_at: new Date().toISOString()
    })
    .eq('id', productId);
  
  if (updateError) {
    return { success: false, imagesCount: 0, error: updateError.message };
  }
  
  console.log(`[Refresh Images] Product ${productId} "${(product as any).title}": ${allImages.length} images synced`);
  
  return { success: true, imagesCount: allImages.length };
}

export async function POST(req: Request) {
  try {
    const guard = await ensureAdmin();
    if (!guard.ok) {
      return NextResponse.json(
        { ok: false, error: guard.reason },
        { status: 401 }
      );
    }
    
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json(
        { ok: false, error: 'Database not configured' },
        { status: 500 }
      );
    }
    
    const body = await req.json().catch(() => ({}));
    const { productId, productIds, all } = body;
    
    if (all === true) {
      const { data: products, error } = await supabase
        .from('products')
        .select('id')
        .or('cj_product_id.not.is.null,supplier_sku.not.is.null')
        .order('id', { ascending: true });
      
      if (error) {
        return NextResponse.json(
          { ok: false, error: error.message },
          { status: 500 }
        );
      }
      
      const results: { id: number; success: boolean; imagesCount: number; error?: string }[] = [];
      
      for (const p of (products || [])) {
        const result = await refreshProductImages(supabase, p.id);
        results.push({ id: p.id, ...result });
        
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      const successful = results.filter(r => r.success).length;
      const totalImages = results.reduce((sum, r) => sum + r.imagesCount, 0);
      
      return NextResponse.json({
        ok: true,
        message: `Refreshed images for ${successful}/${results.length} products`,
        totalProducts: results.length,
        successfulProducts: successful,
        totalImages,
        results
      });
    }
    
    if (Array.isArray(productIds) && productIds.length > 0) {
      const results: { id: number; success: boolean; imagesCount: number; error?: string }[] = [];
      
      for (const id of productIds) {
        const result = await refreshProductImages(supabase, Number(id));
        results.push({ id: Number(id), ...result });
        
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      const successful = results.filter(r => r.success).length;
      
      return NextResponse.json({
        ok: true,
        message: `Refreshed images for ${successful}/${results.length} products`,
        results
      });
    }
    
    if (productId) {
      const result = await refreshProductImages(supabase, Number(productId));
      
      return NextResponse.json({
        ok: result.success,
        ...result
      });
    }
    
    return NextResponse.json(
      { ok: false, error: 'Provide productId, productIds array, or all: true' },
      { status: 400 }
    );
    
  } catch (e: any) {
    console.error('[Refresh Images] Error:', e);
    return NextResponse.json(
      { ok: false, error: e?.message || 'Internal error' },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  try {
    const guard = await ensureAdmin();
    if (!guard.ok) {
      return NextResponse.json(
        { ok: false, error: guard.reason },
        { status: 401 }
      );
    }
    
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json(
        { ok: false, error: 'Database not configured' },
        { status: 500 }
      );
    }
    
    const { data: products, error } = await supabase
      .from('products')
      .select('id, title, images, cj_product_id, supplier_sku')
      .or('cj_product_id.not.is.null,supplier_sku.not.is.null')
      .order('id', { ascending: true });
    
    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      );
    }
    
    const stats = {
      totalProducts: products?.length || 0,
      withOneImage: 0,
      withMultipleImages: 0,
      noImages: 0,
      products: (products || []).map(p => {
        const imgCount = Array.isArray(p.images) ? p.images.length : 0;
        if (imgCount === 0) stats.noImages++;
        else if (imgCount === 1) stats.withOneImage++;
        else stats.withMultipleImages++;
        
        return {
          id: p.id,
          title: p.title,
          imageCount: imgCount,
          hasCjId: !!p.cj_product_id,
          hasSupplierSku: !!p.supplier_sku
        };
      })
    };
    
    return NextResponse.json({ ok: true, ...stats });
    
  } catch (e: any) {
    console.error('[Refresh Images] GET Error:', e);
    return NextResponse.json(
      { ok: false, error: e?.message || 'Internal error' },
      { status: 500 }
    );
  }
}
