import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function extractFirstImage(images: any): string {
  if (!images) return "";
  
  if (Array.isArray(images) && images.length > 0) {
    return images[0];
  }
  
  if (typeof images === 'string') {
    const cleaned = images.replace(/^\{|\}$/g, '');
    const urls = cleaned.split(',').filter(u => u.startsWith('http'));
    if (urls.length > 0) {
      return urls[0].trim();
    }
  }
  
  return "";
}

function isMissingIsActiveError(err: any): boolean {
  const message = String(err?.message || "").toLowerCase();
  return !!err && message.includes("is_active");
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "4"), 10);

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: "Database not configured" }, { status: 500 });
    }

    const runPrimaryQuery = async (includeActiveFilter: boolean) => {
      let query = supabase
        .from("products")
        .select("id, title, price, images, slug, rating, stock")
        .gt("stock", 0) as any;

      if (includeActiveFilter) {
        query = query.or("is_active.is.null,is_active.eq.true");
      }

      return await query
        .order("rating", { ascending: false, nullsFirst: false })
        .order("stock", { ascending: false })
        .limit(limit * 2);
    };

    let { data: products, error } = await runPrimaryQuery(true);
    if (isMissingIsActiveError(error)) {
      const fallback = await runPrimaryQuery(false);
      products = fallback.data;
      error = fallback.error;
    }

    if (error) {
      console.error("Error fetching curated products:", error);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    
    if (!products || products.length === 0) {
      const runFallbackQuery = async (includeActiveFilter: boolean) => {
        let query = supabase
          .from("products")
          .select("id, title, price, images, slug, rating, stock") as any;

        if (includeActiveFilter) {
          query = query.or("is_active.is.null,is_active.eq.true");
        }

        return await query
          .order("rating", { ascending: false, nullsFirst: false })
          .limit(limit * 2);
      };

      let fallbackResult = await runFallbackQuery(true);
      if (isMissingIsActiveError(fallbackResult.error)) {
        fallbackResult = await runFallbackQuery(false);
      }
      
      if (!fallbackResult.error) {
        products = fallbackResult.data;
      }
    }
    
    const curated = (products || [])
      .map((p: any) => {
        const firstImage = extractFirstImage(p.images);
        return {
          id: p.id,
          name: p.title,
          price: p.price || 0,
          image: firstImage,
          slug: p.slug || String(p.id),
          inStock: (p.stock || 0) > 0,
        };
      })
      .filter((p: any) => p.image)
      .slice(0, limit);

    return NextResponse.json({ ok: true, products: curated });
  } catch (e: any) {
    console.error("Curated products error:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}
