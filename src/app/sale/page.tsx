import { createClient } from "@supabase/supabase-js";
import type { Metadata } from "next";
import { getSiteUrl } from "@/lib/site";
import ProductCard from "@/components/product-card";
import Breadcrumbs, { type Crumb } from "@/components/breadcrumbs";
import type { Product } from "@/lib/types";
import { headers } from "next/headers";
import type { Route } from "next";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  const storeName = process.env.NEXT_PUBLIC_STORE_NAME || "Shopixo";
  const title = `Sale | ${storeName}`;
  const description = `Shop our best deals and discounts at ${storeName}. Discover amazing offers on quality products.`;
  return {
    title,
    description,
    alternates: { canonical: `${getSiteUrl()}/sale` },
    openGraph: {
      title,
      description,
      url: `${getSiteUrl()}/sale`,
      type: "website",
      images: ["/logo-wordmark.svg"],
    },
    twitter: { card: "summary_large_image", title, description, images: ["/logo-wordmark.svg"] },
  };
}

export default async function SalePage({ searchParams }: { searchParams?: { sort?: string; min?: string; max?: string; page?: string } }) {
  const nonce = headers().get('x-csp-nonce') || undefined;
  const supabase = getSupabaseAdmin();

  const isMissingIsActiveError = (err: any): boolean => {
    const message = String(err?.message || "").toLowerCase();
    return !!err && message.includes("is_active");
  };

  const page = Math.max(1, parseInt(searchParams?.page || "1") || 1);
  const perPage = 24;
  const offset = (page - 1) * perPage;

  const min = Number(searchParams?.min);
  const max = Number(searchParams?.max);
  const sort = (searchParams?.sort || '').toLowerCase();

  if (!supabase) {
    return (
      <main className="container mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold text-red-600">SALE</h1>
        <p className="text-gray-500 mt-4">Unable to load sale items. Please try again later.</p>
      </main>
    );
  }

  const runSaleQuery = async (includeActiveFilter: boolean) => {
    let query = supabase
      .from("products")
      .select("*", { count: "exact" }) as any;

    if (includeActiveFilter) {
      query = query.or("is_active.is.null,is_active.eq.true");
    }

    if (!isNaN(min) && min > 0) {
      query = query.gte("price", min);
    }
    if (!isNaN(max) && max > 0) {
      query = query.lte("price", max);
    }

    if (sort === "price_asc") {
      query = query.order("price", { ascending: true });
    } else if (sort === "price_desc") {
      query = query.order("price", { ascending: false });
    } else {
      query = query.order("created_at", { ascending: false });
    }

    query = query.range(offset, offset + perPage - 1);
    return await query;
  };

  let { data: products, count, error } = await runSaleQuery(true);
  if (isMissingIsActiveError(error)) {
    const fallback = await runSaleQuery(false);
    products = fallback.data;
    count = fallback.count;
    error = fallback.error;
  }

  if (error) {
    console.error("[Sale] Failed to fetch products:", error.message || error);
  }

  const total = count || 0;

  const allProducts = (products || []) as Product[];

  const crumbs: Crumb[] = [
    { name: "Home", href: "/" as Route },
    { name: "Sale" },
  ];

  const totalPages = Math.ceil(total / perPage);

  return (
    <main className="container mx-auto px-4 py-6" nonce={nonce}>
      <Breadcrumbs items={crumbs} />
      <div className="flex flex-col md:flex-row gap-6 mt-4">
        <div className="flex-1">
          <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-600">Sort by:</span>
              <a href={`/sale?sort=price_asc${searchParams?.min ? `&min=${searchParams.min}` : ''}${searchParams?.max ? `&max=${searchParams.max}` : ''}`}
                 className={`flex items-center gap-1 px-3 py-1 rounded border ${sort === 'price_asc' ? 'bg-red-50 border-red-300' : 'border-gray-300'}`}>
                Price <span className="text-xs">↑</span>
              </a>
              <a href={`/sale?sort=price_desc${searchParams?.min ? `&min=${searchParams.min}` : ''}${searchParams?.max ? `&max=${searchParams.max}` : ''}`}
                 className={`flex items-center gap-1 px-3 py-1 rounded border ${sort === 'price_desc' ? 'bg-red-50 border-red-300' : 'border-gray-300'}`}>
                Price <span className="text-xs">↓</span>
              </a>
            </div>
            <form action="/sale" method="GET" className="flex items-center gap-2">
              {searchParams?.sort && <input type="hidden" name="sort" value={searchParams.sort} />}
              <span className="text-sm text-gray-600">Price from</span>
              <input type="number" name="min" defaultValue={searchParams?.min || ''} className="w-20 px-2 py-1 border rounded" placeholder="" />
              <span className="text-sm text-gray-600">to</span>
              <input type="number" name="max" defaultValue={searchParams?.max || ''} className="w-20 px-2 py-1 border rounded" placeholder="" />
              <button type="submit" className="px-3 py-1 border rounded hover:bg-gray-50">Apply</button>
            </form>
          </div>

          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-red-600">SALE</h1>
            <span className="text-sm text-gray-500">{total} products</span>
          </div>

          {allProducts.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {allProducts.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-gray-500">
              No sale items found.
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex justify-center gap-2 mt-8">
              {page > 1 && (
                <a href={`/sale?page=${page - 1}${searchParams?.sort ? `&sort=${searchParams.sort}` : ''}${searchParams?.min ? `&min=${searchParams.min}` : ''}${searchParams?.max ? `&max=${searchParams.max}` : ''}`}
                   className="px-4 py-2 border rounded hover:bg-gray-50">
                  Previous
                </a>
              )}
              <span className="px-4 py-2">Page {page} of {totalPages}</span>
              {page < totalPages && (
                <a href={`/sale?page=${page + 1}${searchParams?.sort ? `&sort=${searchParams.sort}` : ''}${searchParams?.min ? `&min=${searchParams.min}` : ''}${searchParams?.max ? `&max=${searchParams.max}` : ''}`}
                   className="px-4 py-2 border rounded hover:bg-gray-50">
                  Next
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
