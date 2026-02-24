import ProductCard from "@/components/product-card"
import Breadcrumbs from "@/components/breadcrumbs"
import { getSupabaseAnonServer } from "@/lib/supabase-server"
import type { Product } from "@/lib/types"
import { createClient } from "@supabase/supabase-js"
import SubcategoryCircles from "@/components/category/SubcategoryCircles"
import CategorySidebar from "@/components/category/CategorySidebar"
import SortDropdown from "@/components/category/SortDropdown"
import CategoryProductCard from "@/components/category/CategoryProductCard"

export const metadata = { title: "Best Sellers | Shopixo", description: "Best selling products at Shopixo" }
export const revalidate = 60
export const dynamic = "force-dynamic"

const productSelect = "id, title, slug, description, price, images, category, stock, variants, displayed_rating, rating_confidence, original_price, msrp, badge, available_colors";
const productSelectFallback = "id, title, slug, description, price, images, category, stock, variants, displayed_rating, rating_confidence";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

export default async function BestsellersPage({ searchParams }: { searchParams?: { sort?: string; min?: string; max?: string } }) {
  const supabase = getSupabaseAnonServer()
  const supabaseAdmin = getSupabaseAdmin()
  
  let topCategories: any[] = []
  
  const categoryClient = supabaseAdmin || supabase
  if (categoryClient) {
    try {
      const { data: cats, error } = await categoryClient
        .from("categories")
        .select("*")
        .is("parent_id", null)
        .eq("is_active", true)
        .order("id", { ascending: true })
        .limit(20)
      
      if (!error && cats) {
        topCategories = cats
        console.log("[BestSellers] Loaded", cats.length, "top categories")
      } else if (error) {
        console.error("[BestSellers] Category error:", error.message)
      }
    } catch (e: any) {
      console.error("[BestSellers] Category exception:", e.message)
    }
  } else {
    console.log("[BestSellers] No supabase client available")
  }
  
  let products: any[] | null = null
  if (!supabase) {
    products = []
  } else {
    try {
      const min = Number(searchParams?.min)
      const max = Number(searchParams?.max)
      const sort = searchParams?.sort || ""

      const applyPriceFilters = (q: any) => {
        if (!isNaN(min) && min > 0) q = q.gte("price", min)
        if (!isNaN(max) && max > 0) q = q.lte("price", max)
        return q
      }

      const isMissingIsActiveError = (err: any): boolean => {
        const message = String(err?.message || "").toLowerCase()
        return !!err && message.includes("is_active")
      }

      const fetchProducts = async (includeActiveFilter: boolean) => {
        const buildQuery = (select: string) => {
          let query = supabase.from("products").select(select) as any
          if (includeActiveFilter) {
            query = query.or("is_active.is.null,is_active.eq.true")
          }
          return applyPriceFilters(query)
        }

        if (sort === "price-asc" || sort === "price-desc") {
          const ascending = sort === "price-asc"
          let { data, error } = await buildQuery(productSelect).order("price", { ascending })
          if (error && (error as any).code === "42703") {
            const fallback = await buildQuery(productSelectFallback).order("price", { ascending })
            data = fallback.data as any
            error = fallback.error as any
          }
          return { data, error }
        }

        let { data, error } = await buildQuery(productSelect).order("sales_count", { ascending: false })
        if (error && (error as any).code === "42703") {
          const byRating = await buildQuery(productSelect).order("displayed_rating", { ascending: false })
          if (byRating.error && (byRating.error as any).code === "42703") {
            const byRatingFallback = await buildQuery(productSelectFallback).order("displayed_rating", { ascending: false })
            data = byRatingFallback.data as any
            error = byRatingFallback.error as any
            if (error && (error as any).code === "42703") {
              const byPriceFallback = await buildQuery(productSelectFallback).order("price", { ascending: false })
              data = byPriceFallback.data as any
              error = byPriceFallback.error as any
            }
          } else {
            data = byRating.data as any
            error = byRating.error as any
          }
        }
        return { data, error }
      }

      let { data, error } = await fetchProducts(true)
      if (isMissingIsActiveError(error)) {
        const retry = await fetchProducts(false)
        data = retry.data
        error = retry.error
      }

      if (error) {
        console.error("[BestSellers] Product query error:", error.message || error)
      }
      products = (data as any[] | null) ?? []
    } catch {
      products = []
    }
  }

  const sidebarCategories = [
    { name: "Men", slug: "mens-clothing" },
    { name: "Women", slug: "womens-clothing" },
    { name: "Home", slug: "home-garden-furniture" },
    { name: "Wedding", slug: "weddings-events" },
  ]

  return (
    <main className="bg-white min-h-screen">
      <div className="max-w-[1320px] mx-auto px-4 py-6">
        <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Best Sellers" }]} />
        
        {topCategories.length > 0 && (
          <SubcategoryCircles 
            subcategories={topCategories.map(c => ({
              id: c.id,
              name: c.name.replace("'s Clothing", "").replace(", Garden & Furniture", "").replace(", Beauty & Hair", "").replace(" & Watches", "").replace(" & Shoes", "").replace(", Kids & Babies", ""),
              slug: c.slug,
              image_url: c.image_url
            }))} 
            parentSlug="bestsellers"
            showNavigationAlways={true}
          />
        )}

        <div className="flex flex-col lg:flex-row gap-6">
          <div className="w-full lg:w-[200px] shrink-0">
            <div className="sticky top-4">
              <div className="flex items-center gap-2 mb-4 cursor-pointer">
                <span className="text-lg font-semibold">Filters</span>
              </div>
              
              <div className="mb-6">
                <h3 className="font-semibold text-gray-900 mb-3">Best Sellers</h3>
                <ul className="space-y-2">
                  {sidebarCategories.map((cat) => (
                    <li key={cat.slug}>
                      <a 
                        href={`/category/${cat.slug}`}
                        className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
                      >
                        {cat.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mb-6">
                <h3 className="font-semibold text-gray-900 mb-3">price</h3>
                <form className="space-y-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      name="min"
                      placeholder="Min"
                      defaultValue={searchParams?.min || ""}
                      className="w-20 px-2 py-1.5 border rounded text-sm"
                    />
                    <span className="text-gray-400">-</span>
                    <input
                      type="number"
                      name="max"
                      placeholder="Max"
                      defaultValue={searchParams?.max || ""}
                      className="w-20 px-2 py-1.5 border rounded text-sm"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full py-2 bg-gray-900 text-white text-sm rounded hover:bg-gray-800 transition-colors"
                  >
                    Go
                  </button>
                </form>
              </div>
            </div>
          </div>
          
          <div className="flex-1">
            <div className="flex items-center justify-between mb-4 pb-3 border-b">
              <h1 className="text-xl font-bold text-gray-900">Best Sellers</h1>
              <div className="flex items-center gap-4">
                <span className="text-sm text-gray-500">{products?.length || 0} products</span>
                <SortDropdown currentSort={searchParams?.sort} />
              </div>
            </div>
            
            {products && products.length > 0 ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                {products.map((p) => (
                  <CategoryProductCard key={p.id} product={p as any} />
                ))}
              </div>
            ) : (
              <div className="text-center py-12 bg-gray-50 rounded-lg">
                <p className="text-gray-500">No products available.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
