"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  CheckCircle,
  XCircle,
  Clock,
  Package,
  Download,
  Edit,
  Trash2,
  Star,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Filter,
  MoreHorizontal,
  Eye,
  Play,
} from "lucide-react";
import { normalizeDisplayedRating } from "@/lib/rating/engine";
import { sarToUsd } from "@/lib/pricing";

type QueueProduct = {
  id: number;
  batch_id: number | null;
  cj_product_id: string;
  store_sku?: string | null;
  product_code?: string | null;
  name_en: string;
  name_ar: string | null;
  category: string;
  images: string[];
  variants: any[];
  cj_price_usd: number;
  shipping_cost_usd: number | null;
  calculated_retail_sar: number | null;
  profit_margin?: number | null;
  displayed_rating?: number | null;
  rating_confidence?: number | null;
  stock_total: number;
  quality_score: number;
  status: string;
  admin_notes: string | null;
  delivery_days_min: number;
  delivery_days_max: number;
  created_at: string;
  available_colors?: string[];
  available_sizes?: string[];
  variant_pricing?: any[] | string | null;
  video_url?: string | null;
  video_source_url?: string | null;
  video_4k_url?: string | null;
  video_delivery_mode?: 'native' | 'enhanced' | 'passthrough' | null;
  video_quality_gate_passed?: boolean | null;
  video_source_quality_hint?: '4k' | 'hd' | 'sd' | 'unknown' | null;
  media_mode?: string | null;
  has_video?: boolean | null;
};

function parseQueueVariantPricing(value: QueueProduct["variant_pricing"]): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function resolveQueueDisplayPriceUsd(product: QueueProduct): number | null {
  const variantPricing = parseQueueVariantPricing(product.variant_pricing);
  const directUsdPrices = variantPricing
    .map((v: any) => Number(v?.priceUsd ?? v?.sellPriceUSD ?? v?.sellPriceUsd))
    .filter((p: number) => Number.isFinite(p) && p > 0);

  if (directUsdPrices.length > 0) {
    return Math.min(...directUsdPrices);
  }

  const directRetailSar = Number(product.calculated_retail_sar);
  if (Number.isFinite(directRetailSar) && directRetailSar > 0) {
    return sarToUsd(directRetailSar);
  }

  const variantRetailPrices = variantPricing
    .map((v: any) => Number(v?.price ?? v?.sellPriceSAR ?? v?.sellPriceSar))
    .filter((p: number) => Number.isFinite(p) && p > 0);

  if (variantRetailPrices.length > 0) {
    return sarToUsd(Math.min(...variantRetailPrices));
  }

  return null;
}

function resolveQueueMarginPercent(product: QueueProduct): number | null {
  const directMargin = Number(product.profit_margin);
  if (Number.isFinite(directMargin) && directMargin > 0) return directMargin;

  const variantPricing = parseQueueVariantPricing(product.variant_pricing);
  const margins = variantPricing
    .map((v: any) => Number(v?.marginPercent ?? v?.profitMargin ?? v?.margin))
    .filter((m: number) => Number.isFinite(m) && m > 0);

  if (margins.length === 0) return null;
  return Number((margins.reduce((sum, m) => sum + m, 0) / margins.length).toFixed(1));
}

function resolveQueueStoreSku(product: QueueProduct): string {
  const storeSku = typeof product.store_sku === "string" ? product.store_sku.trim() : "";
  if (storeSku) return storeSku;

  const productCode = typeof product.product_code === "string" ? product.product_code.trim() : "";
  if (productCode) return productCode;

  return product.cj_product_id || "-";
}

function hasQueueVideo(product: QueueProduct): boolean {
  const primary = typeof product.video_4k_url === "string" ? product.video_4k_url.trim() : "";
  const fallback = typeof product.video_url === "string" ? product.video_url.trim() : "";
  return primary.length > 0 || fallback.length > 0 || product.has_video === true;
}

function getQueueVideoUrl(product: QueueProduct): string | null {
  const primary = typeof product.video_4k_url === "string" ? product.video_4k_url.trim() : "";
  if (primary) return primary;

  const fallback = typeof product.video_url === "string" ? product.video_url.trim() : "";
  return fallback || null;
}

type Stats = {
  pending: number;
  approved: number;
  rejected: number;
  imported: number;
};

type LocalCategory = {
  id: number;
  name: string;
  slug: string;
  level: number;
  parentId: number | null;
  parentName: string | null;
  children?: LocalCategory[];
};

const statusColors: Record<string, { bg: string; text: string; icon: any }> = {
  pending: { bg: "bg-amber-100", text: "text-amber-800", icon: Clock },
  approved: { bg: "bg-green-100", text: "text-green-800", icon: CheckCircle },
  rejected: { bg: "bg-red-100", text: "text-red-800", icon: XCircle },
  imported: { bg: "bg-blue-100", text: "text-blue-800", icon: Package },
};

export default function QueuePage() {
  const [products, setProducts] = useState<QueueProduct[]>([]);
  const [stats, setStats] = useState<Stats>({ pending: 0, approved: 0, rejected: 0, imported: 0 });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localCategories, setLocalCategories] = useState<LocalCategory[]>([]);
  
  const [statusFilter, setStatusFilter] = useState("pending");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [page, setPage] = useState(0);
  const limit = 20;

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [actionLoading, setActionLoading] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editData, setEditData] = useState<Partial<QueueProduct>>({});

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        category: categoryFilter,
        limit: limit.toString(),
        offset: (page * limit).toString(),
      });
      
      const res = await fetch(`/api/admin/import/queue?${params}`);
      const data = await res.json();
      
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to fetch queue");
      }
      
      setProducts(data.products || []);
      setTotal(data.total || 0);
      setStats(data.stats || { pending: 0, approved: 0, rejected: 0, imported: 0 });
    } catch (e: any) {
      setError(e?.message || "Failed to load queue");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, categoryFilter, page]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  useEffect(() => {
    async function fetchLocalCategories() {
      try {
        const res = await fetch("/api/admin/categories/map");
        const data = await res.json();
        if (data.ok && data.categories) {
          setLocalCategories(data.categories);
        }
      } catch (e) {
        console.error("Failed to fetch local categories:", e);
      }
    }
    fetchLocalCategories();
  }, []);

  const toggleSelect = (id: number) => {
    setSelected((prev: Set<number>) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(products.map((p: QueueProduct) => p.id)));
  };

  const deselectAll = () => {
    setSelected(new Set());
  };

  const handleBulkAction = async (action: string) => {
    if (selected.size === 0) return;
    
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/import/queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected), action }),
      });
      
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Action failed");
      }
      
      setSelected(new Set());
      fetchProducts();
    } catch (e: any) {
      setError(e?.message || "Action failed");
    } finally {
      setActionLoading(false);
    }
  };

  const handleImport = async () => {
    const approvedIds = products
      .filter((p: QueueProduct) => p.status === "approved" && selected.has(p.id))
      .map((p: QueueProduct) => p.id);
    if (approvedIds.length === 0) {
      setError("Select approved products to import");
      return;
    }
    
    if (!confirm(`Import ${approvedIds.length} products to your store?`)) return;
    
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/import/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: approvedIds }),
      });
      
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Import failed");
      }
      
      setSelected(new Set());
      fetchProducts();
      alert(`Successfully imported ${data.imported} products!`);
    } catch (e: any) {
      setError(e?.message || "Import failed");
    } finally {
      setActionLoading(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    
    if (!confirm(`Delete ${selected.size} products from the queue? This cannot be undone.`)) return;
    
    setActionLoading(true);
    try {
      const ids = Array.from(selected).join(",");
      const res = await fetch(`/api/admin/import/queue?ids=${ids}`, {
        method: "DELETE",
      });
      
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Delete failed");
      }
      
      setSelected(new Set());
      fetchProducts();
    } catch (e: any) {
      setError(e?.message || "Delete failed");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSingleAction = async (id: number, action: string) => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/import/queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id], action }),
      });
      
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Action failed");
      }
      
      fetchProducts();
    } catch (e: any) {
      setError(e?.message || "Action failed");
    } finally {
      setActionLoading(false);
    }
  };

  const startEdit = (product: QueueProduct) => {
    setEditingId(product.id);
    setEditData({
      name_en: product.name_en,
      name_ar: product.name_ar || "",
      category: product.category,
      admin_notes: product.admin_notes || "",
    });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/import/queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [editingId], action: "update", data: editData }),
      });
      
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Update failed");
      }
      
      setEditingId(null);
      setEditData({});
      fetchProducts();
    } catch (e: any) {
      setError(e?.message || "Update failed");
    } finally {
      setActionLoading(false);
    }
  };

  const exportCsv = () => {
    const headers = [
      "ID",
      "Store SKU",
      "CJ Product ID",
      "Name",
      "Category",
      "Retail USD",
      "Cost USD",
      "Margin %",
      "Stock",
      "Displayed Rating",
      "Status",
      "Created",
    ];
    const rows = products.map((p: QueueProduct) => [
      p.id,
      resolveQueueStoreSku(p),
      p.cj_product_id,
      `"${p.name_en.replace(/"/g, '""')}"`,
      p.category,
      resolveQueueDisplayPriceUsd(p)?.toFixed(2) ?? "",
      p.cj_price_usd,
      resolveQueueMarginPercent(p)?.toFixed(1) ?? "",
      p.stock_total,
      normalizeDisplayedRating(p.displayed_rating).toFixed(1),
      p.status,
      new Date(p.created_at).toLocaleDateString(),
    ]);
    
    const csv = [headers.join(","), ...rows.map((r: Array<string | number | null>) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `queue-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Import Queue</h1>
          <p className="text-sm text-gray-500 mt-1">قائمة انتظار الاستيراد - Review and approve products</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={exportCsv}
            className="flex items-center gap-2 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
          <Link
            href="/admin/import/discover"
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
          >
            Discover Products
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {Object.entries(stats).map(([status, count]) => {
          const colors = statusColors[status] || statusColors.pending;
          const Icon = colors.icon;
          return (
            <button
              key={status}
              onClick={() => { setStatusFilter(status); setPage(0); }}
              className={`p-4 rounded-xl border-2 transition-all ${
                statusFilter === status ? "border-gray-900 bg-gray-50" : "border-gray-100 hover:border-gray-200"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className={`w-10 h-10 rounded-lg ${colors.bg} flex items-center justify-center`}>
                  <Icon className={`h-5 w-5 ${colors.text}`} />
                </div>
                <span className="text-2xl font-bold text-gray-900">{count}</span>
              </div>
              <p className="mt-2 text-sm text-gray-600 capitalize">{status}</p>
            </button>
          );
        })}
      </div>

      <div className="bg-white rounded-xl border shadow-sm p-4">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-gray-500" />
            <span className="text-sm font-medium text-gray-700">Filter by Category:</span>
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => { setCategoryFilter(e.target.value); setPage(0); }}
            className="flex-1 max-w-md px-3 py-2 border border-gray-300 rounded-lg text-sm"
          >
            <option value="all">All Categories</option>
            {localCategories
              .filter(c => c.level === 1)
              .map(mainCat => (
                <optgroup key={mainCat.id} label={mainCat.name}>
                  <option value={mainCat.slug}>All {mainCat.name}</option>
                  {localCategories
                    .filter(c => c.level === 2 && c.parentId === mainCat.id)
                    .flatMap(subCat => [
                      <option key={`sub-${subCat.id}`} value={subCat.slug}>
                        {subCat.name}
                      </option>,
                      ...localCategories
                        .filter(c => c.level === 3 && c.parentId === subCat.id)
                        .map(leaf => (
                          <option key={`leaf-${leaf.id}`} value={leaf.slug}>
                            &nbsp;&nbsp;↳ {leaf.name}
                          </option>
                        ))
                    ])}
                </optgroup>
              ))}
          </select>
          {categoryFilter !== "all" && (
            <button
              onClick={() => { setCategoryFilter("all"); setPage(0); }}
              className="text-sm text-blue-600 hover:underline"
            >
              Clear filter
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {selected.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between">
          <span className="text-blue-800 font-medium">{selected.size} products selected</span>
          <div className="flex items-center gap-2">
            {statusFilter === "pending" && (
              <>
                <button
                  onClick={() => handleBulkAction("approve")}
                  disabled={actionLoading}
                  className="flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50"
                >
                  <CheckCircle className="h-4 w-4" />
                  Approve All
                </button>
                <button
                  onClick={() => handleBulkAction("reject")}
                  disabled={actionLoading}
                  className="flex items-center gap-1 px-3 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700 disabled:opacity-50"
                >
                  <XCircle className="h-4 w-4" />
                  Reject All
                </button>
              </>
            )}
            {statusFilter === "approved" && (
              <button
                onClick={handleImport}
                disabled={actionLoading}
                className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                <Package className="h-4 w-4" />
                Import to Store
              </button>
            )}
            <button
              onClick={handleBulkDelete}
              disabled={actionLoading}
              className="flex items-center gap-1 px-3 py-1.5 bg-gray-600 text-white rounded text-sm hover:bg-gray-700 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              Delete Selected
            </button>
            <button onClick={deselectAll} className="text-sm text-gray-500 hover:underline ml-2">
              Clear Selection
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="p-4 border-b flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={selectAll} className="text-sm text-blue-600 hover:underline">Select All</button>
            <span className="text-gray-300">|</span>
            <span className="text-sm text-gray-500">
              Showing {products.length} of {total} products
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="p-1.5 border rounded hover:bg-gray-50 disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm text-gray-600">
              Page {page + 1} of {totalPages || 1}
            </span>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              className="p-1.5 border rounded hover:bg-gray-50 disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-gray-500">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3" />
            Loading...
          </div>
        ) : products.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>No products in queue</p>
            <Link href="/admin/import/discover" className="text-blue-600 hover:underline text-sm mt-2 inline-block">
              Discover products to import
            </Link>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 border-b">
                <th className="w-10 px-4 py-3"></th>
                <th className="w-20 px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Image</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Price</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Variants</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Rating</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="w-32 px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {products.map((product) => {
                const isSelected = selected.has(product.id);
                const colors = statusColors[product.status] || statusColors.pending;
                const StatusIcon = colors.icon;
                const displayRetailUsd = resolveQueueDisplayPriceUsd(product);
                const displayMarginPercent = resolveQueueMarginPercent(product);
                const displayStoreSku = resolveQueueStoreSku(product);
                const queueVideoUrl = getQueueVideoUrl(product);

                return editingId === product.id ? (
                  <tr key={product.id} className="bg-blue-50">
                    <td colSpan={10} className="px-4 py-4">
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">English Name</label>
                            <input
                              type="text"
                              value={editData.name_en || ""}
                              onChange={(e) => setEditData(d => ({ ...d, name_en: e.target.value }))}
                              className="w-full px-3 py-2 border rounded text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Arabic Name</label>
                            <input
                              type="text"
                              value={editData.name_ar || ""}
                              onChange={(e) => setEditData(d => ({ ...d, name_ar: e.target.value }))}
                              className="w-full px-3 py-2 border rounded text-sm"
                              dir="rtl"
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Category</label>
                            <select
                              value={editData.category || ""}
                              onChange={(e) => setEditData(d => ({ ...d, category: e.target.value }))}
                              className="w-full px-3 py-2 border rounded text-sm"
                            >
                              <option value="">Select Category</option>
                              {localCategories
                                .filter(c => c.level === 1)
                                .map(mainCat => (
                                  <optgroup key={mainCat.id} label={mainCat.name}>
                                    {localCategories
                                      .filter(c => c.level === 2 && c.parentId === mainCat.id)
                                      .flatMap(subCat => [
                                        <option key={`sub-${subCat.id}`} value={subCat.name}>
                                          {subCat.name}
                                        </option>,
                                        ...localCategories
                                          .filter(c => c.level === 3 && c.parentId === subCat.id)
                                          .map(leaf => (
                                            <option key={`leaf-${leaf.id}`} value={leaf.name}>
                                              ↳ {leaf.name}
                                            </option>
                                          ))
                                      ])}
                                  </optgroup>
                                ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Admin Notes</label>
                            <input
                              type="text"
                              value={editData.admin_notes || ""}
                              onChange={(e) => setEditData(d => ({ ...d, admin_notes: e.target.value }))}
                              className="w-full px-3 py-2 border rounded text-sm"
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={saveEdit}
                            disabled={actionLoading}
                            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
                          >
                            Save Changes
                          </button>
                          <button
                            onClick={() => { setEditingId(null); setEditData({}); }}
                            className="px-4 py-2 border rounded text-sm hover:bg-gray-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={product.id} className={isSelected ? "bg-blue-50" : "hover:bg-gray-50"}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(product.id)}
                        className="rounded border-gray-300"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="relative w-14 h-14 rounded-lg overflow-hidden bg-gray-100">
                        {product.images[0] ? (
                          <img
                            src={product.images[0]}
                            alt={product.name_en}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400">
                            <Package className="h-6 w-6" />
                          </div>
                        )}

                        {queueVideoUrl && (
                          <a
                            href={queueVideoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="absolute bottom-1 left-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white"
                            title="Open product video"
                          >
                            <Play className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900 line-clamp-2">{product.name_en}</p>
                      {hasQueueVideo(product) && (
                        <div className="space-y-0.5">
                          <span className="inline-flex items-center gap-1 text-[11px] text-blue-700">
                            <Play className="h-3 w-3" />
                            {product.video_4k_url ? '4K video ready' : 'Video available'}
                          </span>
                          {product.video_delivery_mode && (
                            <span className="block text-[10px] text-gray-500">
                              Delivery mode: {product.video_delivery_mode}
                              {product.video_source_quality_hint ? ` · Source hint: ${product.video_source_quality_hint.toUpperCase()}` : ''}
                              {typeof product.video_quality_gate_passed === 'boolean'
                                ? ` · Gate: ${product.video_quality_gate_passed ? 'passed' : 'failed'}`
                                : ''}
                            </span>
                          )}
                        </div>
                      )}
                      <span className="block font-mono text-xs text-emerald-700" title={displayStoreSku}>
                        Store SKU: {displayStoreSku}
                      </span>
                      <span className="font-mono text-xs text-blue-600" title={product.cj_product_id}>
                        CJ PID: {product.cj_product_id.length > 12 ? `...${product.cj_product_id.slice(-8)}` : product.cj_product_id}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-1 bg-gray-100 rounded text-xs text-gray-700">{product.category}</span>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-green-600">
                        {displayRetailUsd !== null ? `$${displayRetailUsd.toFixed(2)} USD` : "$-"}
                      </p>
                      <p className="text-xs text-gray-500">Base Cost: ${product.cj_price_usd?.toFixed(2) || "0.00"}</p>
                      {displayMarginPercent !== null && (
                        <p className="text-xs text-emerald-600">Margin: {displayMarginPercent.toFixed(1)}%</p>
                      )}
                      <p className="text-xs text-gray-500">Stock: {product.stock_total}</p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        {product.available_colors && product.available_colors.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className="text-xs text-gray-500">Colors:</span>
                            <span className="text-xs font-medium text-gray-700">{product.available_colors.length}</span>
                            <span className="text-xs text-gray-400 truncate max-w-[120px]" title={product.available_colors.join(', ')}>
                              ({product.available_colors.slice(0, 3).join(', ')}{product.available_colors.length > 3 ? '...' : ''})
                            </span>
                          </div>
                        )}
                        {product.available_sizes && product.available_sizes.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className="text-xs text-gray-500">Sizes:</span>
                            <span className="text-xs font-medium text-gray-700">{product.available_sizes.length}</span>
                            <span className="text-xs text-gray-400 truncate max-w-[120px]" title={product.available_sizes.join(', ')}>
                              ({product.available_sizes.slice(0, 4).join(', ')}{product.available_sizes.length > 4 ? '...' : ''})
                            </span>
                          </div>
                        )}
                        {(!product.available_colors || product.available_colors.length === 0) && (!product.available_sizes || product.available_sizes.length === 0) && (
                          <span className="text-xs text-gray-400">{product.variants?.length || 0} variants</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        {(() => {
                          const rating = normalizeDisplayedRating(product.displayed_rating);
                          const confidence =
                            typeof product.rating_confidence === "number"
                              ? product.rating_confidence >= 0.75
                                ? "high"
                                : product.rating_confidence >= 0.4
                                  ? "medium"
                                  : "low"
                              : "unknown";

                          return (
                            <>
                        <div className="flex items-center gap-1">
                          {[1, 2, 3, 4, 5].map((star) => (
                            <Star
                              key={star}
                              className={`h-3 w-3 ${
                                star <= Math.round(rating)
                                  ? "fill-amber-400 text-amber-400"
                                  : "text-gray-300"
                              }`}
                            />
                          ))}
                          <span className="text-xs font-medium ml-1">{rating.toFixed(1)}</span>
                        </div>
                        <p className="text-xs text-gray-500">{confidence} confidence</p>
                            </>
                          );
                        })()}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${colors.bg} ${colors.text}`}>
                        <StatusIcon className="h-3 w-3" />
                        {product.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {product.status === "pending" && (
                          <>
                            <button
                              onClick={() => handleSingleAction(product.id, "approve")}
                              disabled={actionLoading}
                              className="p-1.5 text-green-600 hover:bg-green-50 rounded"
                              title="Approve"
                            >
                              <CheckCircle className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleSingleAction(product.id, "reject")}
                              disabled={actionLoading}
                              className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                              title="Reject"
                            >
                              <XCircle className="h-4 w-4" />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => startEdit(product)}
                          className="p-1.5 text-gray-600 hover:bg-gray-100 rounded"
                          title="Edit"
                        >
                          <Edit className="h-4 w-4" />
                        </button>
                        <Link
                          href={`/admin/cj/product/${product.cj_product_id}`}
                          className="p-1.5 text-gray-600 hover:bg-gray-100 rounded"
                          title="View Details"
                        >
                          <Eye className="h-4 w-4" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
