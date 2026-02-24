import ProductCard from "@/components/product-card"
import Breadcrumbs from "@/components/breadcrumbs"
import { getSupabaseAnonServer } from "@/lib/supabase-server"
import type { Product } from "@/lib/types"

export const metadata = { title: "New Arrivals", description: "Latest products added to the store" }
export const revalidate = 60
export const dynamic = "force-dynamic"

export default async function NewArrivalsPage() {
  const supabase = getSupabaseAnonServer()
  let products: any[] | null = null
  if (!supabase) {
    products = []
  } else {
    try {
      let { data, error } = await supabase
        .from("products")
        .select("*")
        .or("is_active.is.null,is_active.eq.true")
        .order("created_at", { ascending: false })

      if (error && String(error.message || "").toLowerCase().includes("is_active")) {
        const activeFallback = await supabase.from("products").select("*").order("created_at", { ascending: false })
        data = activeFallback.data as any
        error = activeFallback.error as any
      }

      if (error && (error as any).code === "42703") {
        const fb = await supabase.from("products").select("*").order("id", { ascending: false })
        data = fb.data as any
      }
      products = (data as any[] | null) ?? []
    } catch {
      products = []
    }
  }

  return (
    <div className="container py-10">
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "New Arrivals" }]} />
      <h1 className="text-3xl font-bold">New Arrivals</h1>
      <p className="mt-2 text-slate-600">Check out the latest additions to our collection.</p>
      {products && products.length > 0 ? (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {products.map((p) => (
            <ProductCard key={p.id} product={p as Product} />
          ))}
        </div>
      ) : (
        <div className="mt-6 rounded-md border p-6 text-center text-slate-500">No products available.</div>
      )}
    </div>
  )
}
