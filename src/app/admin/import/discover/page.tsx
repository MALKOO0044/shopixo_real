"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Package, Loader2, CheckCircle, Star, Trash2, Eye, X, Play, TrendingUp, ChevronLeft, ChevronRight, Image as ImageIcon, BarChart3, DollarSign, Grid3X3, FileText, Truck, Sparkles } from "lucide-react";
import PreviewPageOne from "@/components/admin/import/preview/PreviewPageOne";
import PreviewPageThree from "@/components/admin/import/preview/PreviewPageThree";
import PreviewPageFour from "@/components/admin/import/preview/PreviewPageFour";
import PreviewPageFive from "@/components/admin/import/preview/PreviewPageFive";
import PreviewPageSix from "@/components/admin/import/preview/PreviewPageSix";
import PreviewPageSeven from "@/components/admin/import/preview/PreviewPageSeven";
import type { PricedProduct, PricedVariant } from "@/components/admin/import/preview/types";
import { sarToUsd } from "@/lib/pricing";

type Category = {
  categoryId: string;
  categoryName: string;
  children?: Category[];
};

type FeatureOption = {
  id: string;
  name: string;
  parentId?: string;
  level: number;
};

type SupabaseCategory = {
  id: number;
  name: string;
  slug: string;
  level: number;
  parentId: number | null;
  children?: SupabaseCategory[];
};

type SelectedFeature = {
  cjCategoryId: string;
  cjCategoryName: string;
  supabaseCategoryId: number;
  supabaseCategorySlug: string;
};

const DISCOVER_NON_PRODUCT_IMAGE_RE = /(sprite|icon|favicon|logo|placeholder|blank|loading|badge|flag|promo|banner|sale|discount|qr|sizechart|size\s*chart|chart|table|guide|thumb|thumbnail|small|tiny|mini)/i;
const DISCOVER_IMAGE_KEY_SIZE_TOKEN_RE = /[_-](\d{2,4})x(\d{2,4})(?=\.)/gi;

function normalizeDiscoverGalleryImageKey(url: string): string {
  const normalizedUrl = String(url || '').trim().toLowerCase();
  if (!normalizedUrl) return '';

  try {
    const parsed = new URL(normalizedUrl);
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(DISCOVER_IMAGE_KEY_SIZE_TOKEN_RE, '');
    return parsed.toString();
  } catch {
    return normalizedUrl
      .replace(/[?#].*$/, '')
      .replace(DISCOVER_IMAGE_KEY_SIZE_TOKEN_RE, '');
  }
}

function isValidDiscoverGalleryImageUrl(url: string): boolean {
  const candidate = String(url || '').trim();
  if (!/^https?:\/\//i.test(candidate)) return false;
  if (DISCOVER_NON_PRODUCT_IMAGE_RE.test(candidate)) return false;
  return true;
}

function extractDiscoverDescriptionImages(html: string): string[] {
  if (!html) return [];

  const results: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const candidate = raw.replace(/&amp;/g, '&').trim();
    if (!isValidDiscoverGalleryImageUrl(candidate)) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    results.push(candidate);
  };

  const imgTagRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = imgTagRegex.exec(html)) !== null) {
    push(match[1]);
  }

  const urlRegex = /https?:\/\/[^\s<>"']+\.(?:jpg|jpeg|png|gif|webp|avif|bmp)(?:\?[^\s<>"']*)?/gi;
  while ((match = urlRegex.exec(html)) !== null) {
    push(match[0]);
  }

  return results;
}

export default function ProductDiscoveryPage() {
  const [category, setCategory] = useState("all");
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([]);
  const [selectedFeaturesWithIds, setSelectedFeaturesWithIds] = useState<SelectedFeature[]>([]);
  const [supabaseCategories, setSupabaseCategories] = useState<SupabaseCategory[]>([]);
  const [quantity, setQuantity] = useState(50);
  const [minStock, setMinStock] = useState(0);
  const [maxPrice, setMaxPrice] = useState(100);
  const [minPrice, setMinPrice] = useState(0);
  const [profitMargin, setProfitMargin] = useState(8);
  const [popularity, setPopularity] = useState("any");
  const [minRating, setMinRating] = useState("any");
  // Always use CJPacket Ordinary - no filter option (100% accuracy requirement)
  const shippingMethod = "cjpacket ordinary";
  const [freeShippingOnly, setFreeShippingOnly] = useState(false);
  const [media, setMedia] = useState("");
  
  const [loading, setLoading] = useState(false);
  const [searchProgress, setSearchProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<PricedProduct[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  
  const [categories, setCategories] = useState<Category[]>([]);
  const [features, setFeatures] = useState<FeatureOption[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<{
    connected: boolean;
    latency: number;
    categoryCount: number;
    message: string;
  } | null>(null);
  
  const [batchName, setBatchName] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedBatchId, setSavedBatchId] = useState<number | null>(null);
  
  const [previewProduct, setPreviewProduct] = useState<PricedProduct | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const TOTAL_PREVIEW_PAGES = 7;

  const quantityPresets = [2000, 1500, 1000, 500, 250, 100, 50, 25, 10];
  const profitPresets = [100, 50, 25, 15, 8];
  

  const testConnection = async () => {
    const start = Date.now();
    try {
      const res = await fetch("/api/admin/cj/categories");
      const data = await res.json();
      const latency = Date.now() - start;
      
      if (data.ok && data.categories) {
        setCategories(data.categories);
        setConnectionStatus({
          connected: true,
          latency,
          categoryCount: data.categories.length,
          message: `Connected successfully. Found ${data.categories.length} category groups.`
        });
        
        const allFeatures: FeatureOption[] = [];
        const extractFeatures = (cats: Category[], level: number = 0, parentId?: string) => {
          for (const cat of cats) {
            allFeatures.push({
              id: cat.categoryId,
              name: cat.categoryName,
              parentId,
              level,
            });
            if (cat.children && cat.children.length > 0) {
              extractFeatures(cat.children, level + 1, cat.categoryId);
            }
          }
        };
        extractFeatures(data.categories);
        setFeatures(allFeatures);
      } else {
        setConnectionStatus({
          connected: false,
          latency,
          categoryCount: 0,
          message: data.error || "Connection failed"
        });
      }
    } catch (e: any) {
      setConnectionStatus({
        connected: false,
        latency: Date.now() - start,
        categoryCount: 0,
        message: e?.message || "Connection failed"
      });
    }
  };

  const loadSupabaseCategories = async () => {
    try {
      const res = await fetch("/api/admin/categories/tree");
      const data = await res.json();
      if (data.ok && data.categories) {
        setSupabaseCategories(data.categories);
        console.log("[Discovery] Loaded", data.total, "Supabase categories");
      }
    } catch (e) {
      console.error("Failed to load Supabase categories:", e);
    }
  };

  useEffect(() => {
    testConnection();
    loadSupabaseCategories();
  }, []);

  const loadFeatures = async (categoryId: string) => {
    if (categoryId === "all") {
      setSelectedFeatures([]);
      return;
    }
    
    try {
      const res = await fetch(`/api/admin/cj/categories?parentId=${categoryId}`);
      const data = await res.json();
      if (data.ok && data.categories) {
        const newFeatures: FeatureOption[] = data.categories.map((cat: Category) => ({
          id: cat.categoryId,
          name: cat.categoryName,
          parentId: categoryId,
          level: 2,
        }));
        setFeatures(prev => {
          const filtered = prev.filter(f => f.parentId !== categoryId);
          return [...filtered, ...newFeatures];
        });
      }
    } catch (e) {
      console.error("Failed to load features:", e);
    }
  };

  const searchProducts = async () => {
    if (category === "all" && selectedFeatures.length === 0) {
      setError("Please select a category or feature to search");
      return;
    }
    
    setLoading(true);
    setError(null);
    setProducts([]);
    setSelected(new Set());
    setSavedBatchId(null);
    
    const categoryIds = selectedFeatures.length > 0 ? selectedFeatures : [category];
    const allProducts: PricedProduct[] = [];
    let hasMore = true;
    let cursor = "0.1.0"; // Initial cursor: categoryIndex.pageNum.itemOffset
    let seenPids: string[] = []; // Track processed PIDs across batches
    let batchNumber = 0;
    let lastError: string | null = null;
    let consecutiveEmptyBatches = 0; // Track stalls
    
    try {
      // Use batch mode to avoid Vercel timeout (10s limit)
      // Each request processes 3 products max, then we accumulate results
      while (hasMore && allProducts.length < quantity) {
        batchNumber++;
        setSearchProgress(`Finding products... (batch ${batchNumber}, found ${allProducts.length}/${quantity})`);
        
        // Use POST to handle large seenPids arrays (URL length limits)
        // Cursor stays in URL (small), seenPids goes in body (can be large)
        const remainingNeeded = quantity - allProducts.length;
        const params = new URLSearchParams({
          categoryIds: categoryIds.join(","),
          quantity: quantity.toString(),
          minPrice: minPrice.toString(),
          maxPrice: maxPrice.toString(),
          minStock: minStock.toString(),
          profitMargin: profitMargin.toString(),
          popularity: popularity,
          minRating: minRating,
          shippingMethod: shippingMethod,
          freeShippingOnly: freeShippingOnly ? "1" : "0",
          // Batch mode params - cursor-based pagination
          batchMode: "1",
          batchSize: "3",
          cursor: cursor,
          remainingNeeded: remainingNeeded.toString(),
        });
        
        const res = await fetch(`/api/admin/cj/products/search-and-price?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seenPids }),
        });
        
        // Check content-type before parsing JSON to avoid parse errors on timeouts/errors
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          const text = await res.text();
          throw new Error(`Server error: ${text.slice(0, 100)}...`);
        }
        
        const data = await res.json();
        
        if (!res.ok || !data.ok) {
          if (data.quotaExhausted || res.status === 429) {
            lastError = "CJ Dropshipping API limit reached. Showing products found so far.";
            break;
          }
          throw new Error(data.error || `Search failed: ${res.status}`);
        }
        
        // Add products from this batch, but stop at exactly the requested quantity
        const batchProducts: PricedProduct[] = data.products || [];
        for (const p of batchProducts) {
          // Stop if we've reached the requested quantity
          if (allProducts.length >= quantity) break;
          // Avoid duplicates
          if (!allProducts.some(existing => existing.pid === p.pid)) {
            allProducts.push(p);
          }
        }
        
        // If we've reached the requested quantity, stop batching
        if (allProducts.length >= quantity) {
          console.log(`Reached requested quantity: ${allProducts.length}/${quantity}`);
          break;
        }
        
        // Update products in real-time so user sees progress
        setProducts([...allProducts]);
        
        // Check batch pagination info
        if (data.batch) {
          hasMore = data.batch.hasMore;
          // Update cursor for next batch (resume from where we left off)
          if (data.batch.cursor) {
            cursor = data.batch.cursor;
          }
          // Accumulate ALL attempted PIDs (backup deduplication)
          if (data.batch.attemptedPids) {
            seenPids = [...seenPids, ...data.batch.attemptedPids];
          }
          console.log(`Batch ${batchNumber}: got ${batchProducts.length} products, hasMore=${hasMore}, cursor=${cursor}, totalSeen=${seenPids.length}`);
        } else {
          // Non-batch response (fallback)
          hasMore = false;
        }
        
        // Trust the server's hasMore flag - it knows when categories are exhausted
        // Only use client-side guards as last-resort safety nets
        const newAttempts = data.batch?.attemptedPids?.length || 0;
        if (batchProducts.length === 0) {
          consecutiveEmptyBatches++;
          console.log(`Batch returned 0 products (${newAttempts} attempts filtered), consecutiveEmpty=${consecutiveEmptyBatches}`);
          
          // Only stop if BOTH: no new attempts AND server says no more
          // This means cursor is exhausted and nothing left to try
          if (newAttempts === 0 && !hasMore) {
            console.log('No new attempts and server says no more - stopping');
            break;
          }
        } else {
          // Reset counter on successful batch
          consecutiveEmptyBatches = 0;
        }
        
        // Safety: limit total batches to prevent infinite loops
        if (batchNumber >= 100) {
          console.log('Max batch limit reached');
          break;
        }
      }
      
      // Set final products
      setProducts(allProducts);
      
      // Check if we got the requested quantity
      if (allProducts.length < quantity) {
        const reason = lastError || `Found ${allProducts.length}/${quantity} products. Not enough matching products in this category.`;
        setError(`Notice: ${reason}`);
      }
      
      if (allProducts.length === 0) {
        setError("No products found with CJPacket Ordinary shipping. Try a different category.");
      }
      
    } catch (e: any) {
      setError(e?.message || "Search failed");
      // Keep any products we found before the error
      if (allProducts.length > 0) {
        setProducts(allProducts);
      }
    } finally {
      setLoading(false);
      setSearchProgress("");
    }
  };

  const toggleSelect = (productId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(products.map(p => p.pid)));
  };

  const deselectAll = () => {
    setSelected(new Set());
  };

  const removeProduct = (productId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setProducts(prev => prev.filter(p => p.pid !== productId));
    setSelected(prev => {
      const next = new Set(prev);
      next.delete(productId);
      return next;
    });
  };

  const openPreview = (product: PricedProduct, e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviewProduct(product);
    setPreviewPage(1);
  };

  const nextPage = () => {
    if (previewPage < TOTAL_PREVIEW_PAGES) {
      setPreviewPage(previewPage + 1);
    }
  };

  const prevPage = () => {
    if (previewPage > 1) {
      setPreviewPage(previewPage - 1);
    }
  };

  const getPageTitle = (page: number) => {
    switch (page) {
      case 1: return "Overview";
      case 2: return "Product Gallery";
      case 3: return "Specifications";
      case 4: return "Stock & Popularity";
      case 5: return "Shipping & Delivery";
      case 6: return "Price Details";
      case 7: return "AI Media";
      default: return "Product Preview";
    }
  };

  const getPageIcon = (page: number) => {
    switch (page) {
      case 1: return <Package className="h-4 w-4" />;
      case 2: return <Grid3X3 className="h-4 w-4" />;
      case 3: return <FileText className="h-4 w-4" />;
      case 4: return <BarChart3 className="h-4 w-4" />;
      case 5: return <Truck className="h-4 w-4" />;
      case 6: return <DollarSign className="h-4 w-4" />;
      case 7: return <Sparkles className="h-4 w-4" />;
      default: return null;
    }
  };

  const previewGalleryImages = useMemo(() => {
    if (!previewProduct) return [];

    const merged: string[] = [];
    const seen = new Set<string>();
    const pushImage = (raw: unknown) => {
      if (typeof raw !== 'string') return;
      const candidate = raw.trim();
      if (!isValidDiscoverGalleryImageUrl(candidate)) return;

      const key = normalizeDiscoverGalleryImageKey(candidate);
      if (!key || seen.has(key)) return;

      seen.add(key);
      merged.push(candidate);
    };

    for (const imageUrl of previewProduct.images || []) {
      pushImage(imageUrl);
    }

    const descriptionImages = extractDiscoverDescriptionImages(String(previewProduct.description || ''));
    for (const imageUrl of descriptionImages) {
      pushImage(imageUrl);
    }

    return merged;
  }, [previewProduct]);

  const saveBatch = async () => {
    if (selected.size === 0) return;
    
    setSaving(true);
    try {
      const selectedProducts = products.filter(p => selected.has(p.pid));
      const res = await fetch("/api/admin/import/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: batchName || `Discovery ${new Date().toLocaleDateString()}`,
          category: category !== 'all' ? categories.find(c => c.categoryId === category)?.categoryName : undefined,
          products: selectedProducts.map(p => {
            const pricedVariants = p.variants.filter(v => {
              const sell = Number((v as any)?.sellPriceSAR);
              return Number.isFinite(sell) && sell > 0;
            });

            const htmlToPlain = (value: unknown): string => {
              return String(value ?? '')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/p>/gi, '\n')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/gi, ' ')
                .replace(/&amp;/gi, '&')
                .replace(/\r/g, '')
                .replace(/[ \t]+/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            };

            const htmlToLines = (value: unknown): string[] => {
              return htmlToPlain(value)
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean);
            };

            const sourceSpecs = (p as any).specifications && typeof (p as any).specifications === 'object'
              ? (p as any).specifications
              : {};
            const plainSpecifications: Record<string, string> = {};
            const blockedSpecKeys = new Set([
              'productinfo',
              'sizeinfo',
              'overview',
              'productnote',
              'packinglist',
              'description',
            ]);

            for (const [key, rawValue] of Object.entries(sourceSpecs)) {
              const keyText = String(key || '').trim();
              if (!keyText) continue;
              const normalizedKey = keyText.toLowerCase().replace(/[^a-z0-9]/g, '');
              if (blockedSpecKeys.has(normalizedKey)) continue;
              const cleanValue = htmlToPlain(rawValue);
              if (!cleanValue) continue;
              plainSpecifications[keyText] = cleanValue.slice(0, 500);
            }

            if (p.material && !plainSpecifications.Material) {
              plainSpecifications.Material = htmlToPlain(p.material);
            }
            if (p.productType && !plainSpecifications['Product Type']) {
              plainSpecifications['Product Type'] = htmlToPlain(p.productType);
            }

            const sourceSellingPoints = Array.isArray((p as any).sellingPoints)
              ? (p as any).sellingPoints.map((s: unknown) => htmlToPlain(s)).filter(Boolean)
              : [];
            const normalizedSellingPoints = sourceSellingPoints.length > 0
              ? sourceSellingPoints
              : htmlToLines(p.overview).slice(0, 8);
            const appliedMargin = Number((p as any).profitMarginApplied ?? profitMargin);
            
            return {
              cjProductId: p.pid,
              cjSku: p.cjSku,
              storeSku: p.storeSku,
              name: p.name,
              description: p.description,
              overview: p.overview,
              productInfo: p.productInfo,
              sizeInfo: p.sizeInfo,
              productNote: p.productNote,
              packingList: p.packingList,
              images: p.images,
              videoUrl: p.videoUrl,
              minPriceSAR: p.minPriceSAR,
              maxPriceSAR: p.maxPriceSAR,
              avgPriceSAR: p.avgPriceSAR,
              minPriceUSD: (p as any).minPriceUSD,
              maxPriceUSD: (p as any).maxPriceUSD,
              avgPriceUSD: (p as any).avgPriceUSD,
              stock: p.stock,
              variants: p.variants,
              categoryName: p.categoryName,
              cjCategoryId: category !== 'all' ? category : undefined,
              supabaseCategoryId: selectedFeaturesWithIds.length > 0 ? selectedFeaturesWithIds[0].supabaseCategoryId : undefined,
              supabaseCategorySlug: selectedFeaturesWithIds.length > 0 ? selectedFeaturesWithIds[0].supabaseCategorySlug : undefined,
              displayedRating: p.displayedRating,
              ratingConfidence: p.ratingConfidence,
              productWeight: p.productWeight,
              packLength: p.packLength,
              packWidth: p.packWidth,
              packHeight: p.packHeight,
              material: p.material,
              productType: p.productType,
              originCountry: p.originCountry,
              hsCode: p.hsCode,
              sizeChartImages: p.sizeChartImages,
              availableSizes: p.availableSizes,
              availableColors: p.availableColors,
              availableModels: p.availableModels,
              processingDays: p.processingTimeHours,
              deliveryDaysMin: undefined,
              deliveryDaysMax: p.deliveryTimeHours,
              variantPricing: pricedVariants.map(v => {
                const sellPriceSar = Number((v as any).sellPriceSAR || 0);
                const sellPriceUsdFromVariant = Number((v as any).sellPriceUSD);
                const sellPriceUsd = Number.isFinite(sellPriceUsdFromVariant) && sellPriceUsdFromVariant > 0
                  ? sellPriceUsdFromVariant
                  : (sellPriceSar > 0 ? sarToUsd(sellPriceSar) : 0);
                const variantMarginPercent = Number((v as any).marginPercent);

                return {
                  variantId: v.variantId,
                  sku: v.variantSku,
                  color: v.color,
                  size: v.size,
                  price: sellPriceSar,
                  priceUsd: sellPriceUsd > 0 ? sellPriceUsd : null,
                  marginPercent: Number.isFinite(variantMarginPercent)
                    ? variantMarginPercent
                    : (Number.isFinite(appliedMargin) ? appliedMargin : null),
                  costPrice: v.variantPriceUSD,
                  shippingCost: v.shippingPriceUSD,
                  stock: v.stock ?? null,
                  cjStock: v.cjStock ?? null,
                  factoryStock: v.factoryStock ?? null,
                  colorImage: v.variantImage,
                };
              }),
              specifications: plainSpecifications,
              sellingPoints: normalizedSellingPoints,
              inventoryByWarehouse: p.inventory,
              inventoryStatus: p.inventoryStatus,
              inventoryErrorMessage: p.inventoryErrorMessage,
              colorImageMap: p.colorImageMap,
              priceBreakdown: undefined,
              cjProductCost: undefined,
              cjShippingCost: undefined,
              cjTotalCost: undefined,
              profitMargin: Number.isFinite(appliedMargin) && appliedMargin > 0 ? appliedMargin : undefined,
            };
          }),
        }),
      });
      
      const data = await res.json();
      if (data.ok && data.batchId) {
        setSavedBatchId(data.batchId);
      } else {
        throw new Error(data.error || "Failed to save batch");
      }
    } catch (e: any) {
      setError(e?.message || "Failed to save batch");
    } finally {
      setSaving(false);
    }
  };

  const findMatchingSupabaseCategory = (cjCategoryName: string): SupabaseCategory | null => {
    const normalizedName = cjCategoryName.toLowerCase().trim();
    
    for (const main of supabaseCategories) {
      if (main.children) {
        for (const group of main.children) {
          if (group.children) {
            for (const item of group.children) {
              const itemName = item.name.toLowerCase().trim();
              if (itemName === normalizedName || 
                  item.slug === normalizedName.replace(/[^a-z0-9]+/g, '-')) {
                return item;
              }
            }
          }
          const groupName = group.name.toLowerCase().trim();
          if (groupName === normalizedName) {
            return group;
          }
        }
      }
      const mainName = main.name.toLowerCase().trim();
      if (mainName === normalizedName) {
        return main;
      }
    }
    return null;
  };

  const toggleFeature = (featureId: string) => {
    const isRemoving = selectedFeatures.includes(featureId);
    
    setSelectedFeatures(prev => {
      if (prev.includes(featureId)) {
        return prev.filter(f => f !== featureId);
      } else {
        return [...prev, featureId];
      }
    });
    
    // Always sync selectedFeaturesWithIds - remove if already selected
    if (isRemoving) {
      setSelectedFeaturesWithIds(prev => prev.filter(sf => sf.cjCategoryId !== featureId));
      return; // Exit early on removal
    }
    
    // Adding new feature - try to find matching Supabase category
    const feature = features.find(f => f.id === featureId);
    if (feature) {
      const matchingSupabase = findMatchingSupabaseCategory(feature.name);
      const newFeature: SelectedFeature = {
        cjCategoryId: featureId,
        cjCategoryName: feature.name,
        supabaseCategoryId: matchingSupabase?.id || 0,
        supabaseCategorySlug: matchingSupabase?.slug || '',
      };
      setSelectedFeaturesWithIds(prev => [...prev, newFeature]);
      if (matchingSupabase) {
        console.log(`[Discovery] Matched CJ "${feature.name}" to Supabase category ${matchingSupabase.id} (${matchingSupabase.slug})`);
      } else {
        console.warn(`[Discovery] No Supabase match found for CJ category "${feature.name}"`);
      }
    }
  };

  const getFeatureName = (id: string) => {
    const feature = features.find(f => f.id === id);
    return feature?.name || id;
  };

  const getCategoryChildren = (parentId: string) => {
    return features.filter(f => f.parentId === parentId);
  };

  const selectedCategory = categories.find(c => c.categoryId === category);
  
  // Apply client-side media filter to fetched products
  const displayedProducts = products.filter((p) => {
    if (media === 'withVideo') return !!(p as any).videoUrl;
    if (media === 'imagesOnly') return !(p as any).videoUrl;
    return true;
  });
  
  // Find matching Supabase main category based on CJ category name
  const getMatchingSupabaseMainCategory = (): SupabaseCategory | null => {
    if (!selectedCategory || category === 'all') return null;
    
    const cjName = selectedCategory.categoryName.toLowerCase();
    return supabaseCategories.find(sc => {
      const scName = sc.name.toLowerCase();
      const scSlug = sc.slug.toLowerCase();
      return scName === cjName || 
             scSlug === cjName.replace(/[^a-z0-9]+/g, '-') ||
             scName.includes(cjName) ||
             cjName.includes(scName);
    }) || null;
  };
  
  const matchingSupabaseCategory = getMatchingSupabaseMainCategory();

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Search Products</h1>
      </div>

      {connectionStatus && (
        <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${
          connectionStatus.connected 
            ? "bg-green-50 border-green-200" 
            : "bg-red-50 border-red-200"
        }`}>
          <button
            onClick={testConnection}
            className="px-4 py-1.5 bg-white border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50"
          >
            Test Connection
          </button>
          <span className="text-sm text-gray-600">{connectionStatus.latency}ms</span>
          <span className={`text-sm ${connectionStatus.connected ? "text-green-700" : "text-red-700"}`}>
            CJ Dropshipping API {connectionStatus.connected ? "●" : "○"} {connectionStatus.message}
          </span>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
        <div className="grid grid-cols-3 gap-6">
          <div>
            <label className="block text-sm text-gray-600 mb-2">Category</label>
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setSelectedFeatures([]);
                setSelectedFeaturesWithIds([]); // Clear Supabase category tracking when category changes
                loadFeatures(e.target.value);
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded"
            >
              <option value="all">All Categories</option>
              {categories.map(cat => (
                <option key={cat.categoryId} value={cat.categoryId}>
                  {cat.categoryName}
                </option>
              ))}
            </select>
          </div>
          
          <div>
            <label className="block text-sm text-gray-600 mb-2">Features ({selectedFeatures.length} selected)</label>
            <div className="relative">
              <select
                onChange={(e) => {
                  if (e.target.value) {
                    // Parse the value: "cjId:supabaseId:name"
                    const [cjId, supabaseId, ...nameParts] = e.target.value.split(':');
                    const name = nameParts.join(':');
                    
                    // Toggle the CJ feature ID
                    toggleFeature(cjId);
                    
                    // Track the Supabase category ID if available
                    if (supabaseId && parseInt(supabaseId) > 0) {
                      const existing = selectedFeaturesWithIds.find(sf => sf.cjCategoryId === cjId);
                      if (!existing) {
                        setSelectedFeaturesWithIds(prev => [...prev, {
                          cjCategoryId: cjId,
                          cjCategoryName: name,
                          supabaseCategoryId: parseInt(supabaseId),
                          supabaseCategorySlug: '',
                        }]);
                        console.log(`[Discovery] Selected Feature: ${name} (CJ: ${cjId}, Supabase: ${supabaseId})`);
                      }
                    }
                  }
                  e.target.value = "";
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded appearance-none"
              >
                <option value="">Select features...</option>
                {/* Use Supabase categories if available for better organization */}
                {matchingSupabaseCategory?.children?.map(group => (
                  <optgroup key={group.id} label={group.name}>
                    {group.children?.map(item => {
                      // Find matching CJ category by name for the CJ search
                      const matchingCjCat = selectedCategory?.children
                        ?.flatMap(c => c.children || [])
                        ?.find(cj => cj?.categoryName?.toLowerCase() === item.name.toLowerCase());
                      const cjId = matchingCjCat?.categoryId || `supabase-${item.id}`;
                      
                      return (
                        <option 
                          key={item.id} 
                          value={`${cjId}:${item.id}:${item.name}`}
                          disabled={selectedFeatures.includes(cjId)}
                        >
                          {item.name}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
                {/* Fallback to CJ categories if no Supabase match */}
                {!matchingSupabaseCategory && selectedCategory?.children?.map(child => (
                  <optgroup key={child.categoryId} label={child.categoryName}>
                    {child.children?.map(subChild => (
                      <option 
                        key={subChild.categoryId} 
                        value={`${subChild.categoryId}:0:${subChild.categoryName}`}
                        disabled={selectedFeatures.includes(subChild.categoryId)}
                      >
                        {subChild.categoryName}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-1 mt-2">
              {selectedFeatures.map(featureId => (
                <span
                  key={featureId}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-amber-100 text-amber-800 rounded-full text-xs"
                >
                  {getFeatureName(featureId)}
                  <button
                    onClick={() => toggleFeature(featureId)}
                    className="hover:text-amber-900"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
          
          <div>
            <label className="block text-sm text-gray-600 mb-2">Quantity to Find</label>
            <div className="flex gap-1 mb-2">
              {quantityPresets.map(preset => (
                <button
                  key={preset}
                  onClick={() => setQuantity(preset)}
                  className={`px-2 py-1 text-xs rounded ${
                    quantity === preset
                      ? "bg-amber-500 text-white"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  {preset}
                </button>
              ))}
            </div>
            <input
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded text-left"
              dir="ltr"
            />
          </div>
        </div>

        <div className="grid grid-cols-6 gap-4">
          <div>
            <label className="block text-sm text-gray-600 mb-2">Min Price (USD)</label>
            <input
              type="number"
              value={minPrice}
              onChange={(e) => setMinPrice(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded text-left"
              dir="ltr"
            />
          </div>
          
          <div>
            <label className="block text-sm text-gray-600 mb-2">Max Price (USD)</label>
            <input
              type="number"
              value={maxPrice}
              onChange={(e) => setMaxPrice(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded text-left"
              dir="ltr"
            />
          </div>
          
          <div>
            <label className="block text-sm text-gray-600 mb-2">Min Stock</label>
            <input
              type="number"
              value={minStock}
              onChange={(e) => setMinStock(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded text-left"
              dir="ltr"
            />
          </div>
          
          <div>
            <label className="block text-sm text-gray-600 mb-2">Popularity</label>
            <select
              value={popularity}
              onChange={(e) => setPopularity(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded"
            >
              <option value="any">Any Popularity</option>
              <option value="high">High (1000+ listed)</option>
              <option value="medium">Medium (100-999 listed)</option>
              <option value="low">Low (&lt;100 listed)</option>
            </select>
          </div>
          
          <div>
            <label className="block text-sm text-gray-600 mb-2 flex items-center gap-1">
              <Star className="h-4 w-4 text-amber-500" />
              Min Rating
            </label>
            <select
              value={minRating}
              onChange={(e) => setMinRating(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded"
            >
              <option value="any">Any Rating</option>
              <option value="4.5">4.5+ Stars</option>
              <option value="4">4+ Stars</option>
              <option value="3.5">3.5+ Stars</option>
              <option value="3">3+ Stars</option>
            </select>
          </div>
          
          <div>
            <label className="block text-sm text-gray-600 mb-2 flex items-center gap-1">
              <Truck className="h-4 w-4 text-blue-500" />
              Shipping Method
            </label>
            <div className="w-full px-3 py-2 border border-blue-300 rounded bg-blue-50 text-blue-800 font-medium">
              CJPacket Ordinary (7-12 days)
            </div>
            <p className="text-xs text-gray-500 mt-1">Fixed for 100% accuracy</p>
          </div>
          
        </div>
        

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm text-amber-700 font-medium">*Profit Margin % ({profitMargin}%)</span>
              <div className="flex gap-1">
                {profitPresets.map(preset => (
                  <button
                    key={preset}
                    onClick={() => setProfitMargin(preset)}
                    className={`px-3 py-1.5 text-sm rounded ${
                      profitMargin === preset
                        ? "bg-amber-500 text-white font-medium"
                        : "bg-white border border-gray-300 text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    {preset}%
                  </button>
                ))}
              </div>
              <span className="text-gray-400">%</span>
              <input
                type="number"
                value={profitMargin}
                onChange={(e) => setProfitMargin(Number(e.target.value))}
                className="w-16 px-2 py-1.5 border border-gray-300 rounded text-center"
                dir="ltr"
              />
            </div>
            
            <div className="flex items-center gap-4">
              <input
                type="checkbox"
                checked={freeShippingOnly}
                onChange={(e) => setFreeShippingOnly(e.target.checked)}
                className="w-4 h-4 border-gray-300 rounded"
              />
              <label className="text-sm text-gray-700">Free Shipping Only</label>
            </div>
          </div>
          <p className="text-xs text-amber-600 mt-2 text-right">
            Set your desired profit margin. Products display final USD sell prices from priced variants using this applied margin.
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 pt-4 border-t border-gray-200">
          <Link
            href={"/admin/import/queue" as Route}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm"
          >
            Review Queue
          </Link>
          <button
            onClick={searchProducts}
            disabled={loading}
            className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            Search Products
          </button>
        </div>
      </div>

      {loading && searchProgress && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-amber-600" />
            <div className="flex-1">
              <div className="h-2 bg-amber-200 rounded-full overflow-hidden">
                <div className="h-full bg-amber-500 rounded-full animate-pulse" style={{ width: '60%' }} />
              </div>
            </div>
            <span className="text-sm text-amber-700">{searchProgress}</span>
          </div>
          <p className="text-xs text-amber-600 mt-2">
            Searching products, calculating shipping costs, and applying {profitMargin}% profit margin. Final USD sell prices (with applied margin) will be added to the checklist exactly as shown.
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-600 hover:text-red-800">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {products.length > 0 && (
        <>
          <div className="flex items-center justify-between bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-900">
                Found <strong>{displayedProducts.length}</strong> of <strong>{products.length}</strong> products (filtered)
              </span>
              <span className="text-sm text-gray-400">|</span>
              <span className="text-sm text-gray-600">
                <strong>{selected.size}</strong> selected
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setSelected(new Set(displayedProducts.map(p => p.pid)))} className="text-sm text-blue-600 hover:underline">Select All</button>
              <button onClick={deselectAll} className="text-sm text-gray-500 hover:underline">Clear</button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {displayedProducts.map((product) => {
              const isSelected = selected.has(product.pid);
              
              return (
                <div
                  key={product.pid}
                  className={`bg-white rounded-xl border-2 overflow-hidden transition-all ${
                    isSelected ? "border-blue-500 ring-2 ring-blue-100" : "border-gray-100 hover:border-gray-200"
                  }`}
                >
                  <div className="relative aspect-square bg-gray-100">
                    {product.images?.[0] ? (
                      <img
                        src={product.images[0]}
                        alt={product.name}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-400">
                        <Package className="h-12 w-12" />
                      </div>
                    )}
                    {(product as any).videoUrl && (
                      <div className="absolute left-2 bottom-2 rounded-full bg-black/60 text-white px-2 py-1 text-[11px] flex items-center gap-1">
                        <Play className="h-3.5 w-3.5" />
                        <span>Video</span>
                      </div>
                    )}
                    
                    <div className="absolute top-2 right-2 flex items-center gap-1">
                      <button
                        onClick={(e) => toggleSelect(product.pid, e)}
                        className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors ${
                          isSelected ? "bg-blue-500" : "bg-white border border-gray-300 hover:bg-gray-100"
                        }`}
                      >
                        {isSelected && <CheckCircle className="h-4 w-4 text-white" />}
                      </button>
                    </div>
                    
                    <div className="absolute top-2 left-2 flex gap-1">
                      <button
                        onClick={(e) => openPreview(product, e)}
                        className="w-7 h-7 bg-white/90 rounded-full flex items-center justify-center hover:bg-white"
                        title="Preview"
                      >
                        <Eye className="h-3.5 w-3.5 text-gray-700" />
                      </button>
                      <button
                        onClick={(e) => removeProduct(product.pid, e)}
                        className="w-7 h-7 bg-white/90 rounded-full flex items-center justify-center hover:bg-red-50"
                        title="Remove"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </button>
                    </div>
                    
                    <div className="absolute bottom-2 right-2 flex items-center gap-1 px-2 py-1 bg-black/70 rounded text-xs text-white">
                      <TrendingUp className="h-3 w-3" />
                      {product.listedNum || 0}
                    </div>
                  </div>
                  
                  <div className="p-3 space-y-2">
                    <h3 className="font-medium text-gray-900 text-sm line-clamp-2 leading-tight" dir="ltr">
                      {product.name}
                    </h3>
                    <p className="text-xs text-gray-400 font-mono" title={product.cjSku}>
                      SKU: {product.cjSku.length > 12 ? `...${product.cjSku.slice(-8)}` : product.cjSku}
                    </p>
                    
                    <div className="bg-green-50 rounded-lg p-2">
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-gray-600">Sell Price (USD)</span>
                        <span className="font-bold text-green-700 text-lg">
                          {(() => {
                            const directMinUsd = Number((product as any).minPriceUSD);
                            const directMaxUsd = Number((product as any).maxPriceUSD);
                            const fallbackMinUsd = Number(product.minPriceSAR) > 0
                              ? sarToUsd(Number(product.minPriceSAR))
                              : NaN;
                            const fallbackMaxUsd = Number(product.maxPriceSAR) > 0
                              ? sarToUsd(Number(product.maxPriceSAR))
                              : NaN;

                            const minUsd = Number.isFinite(directMinUsd) && directMinUsd > 0 ? directMinUsd : fallbackMinUsd;
                            const maxUsd = Number.isFinite(directMaxUsd) && directMaxUsd > 0 ? directMaxUsd : fallbackMaxUsd;

                            if (Number.isFinite(minUsd) && minUsd > 0) {
                              if (Number.isFinite(maxUsd) && maxUsd > minUsd) {
                                return `$${minUsd.toFixed(2)} - $${maxUsd.toFixed(2)}`;
                              }
                              return `$${minUsd.toFixed(2)}`;
                            }
                            return "$-";
                          })()}
                        </span>
                      </div>
                      {(() => {
                        const appliedMargin = Number((product as any).profitMarginApplied ?? profitMargin);
                        if (!Number.isFinite(appliedMargin) || appliedMargin <= 0) return null;
                        return (
                          <p className="text-[11px] text-emerald-700 mt-1">
                            Applied margin: {appliedMargin.toFixed(0)}%
                          </p>
                        );
                      })()}
                    </div>
                    
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="flex flex-col">
                        <span className="text-gray-500">Stock</span>
                        <span className={`font-semibold ${(product.stock ?? 0) > 0 ? "text-gray-900" : "text-red-500"}`}>
                          {product.stock ?? "-"}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-gray-500">Variants</span>
                        <span className="font-semibold text-gray-900">
                          {product.successfulVariants}/{product.totalVariants}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {selected.size > 0 && (
            <div className="sticky bottom-4 bg-white rounded-xl border shadow-lg p-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                  <Package className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <p className="font-medium text-gray-900">{selected.size} products selected</p>
                  <p className="text-sm text-gray-500">Ready to add to import queue</p>
                </div>
              </div>
              
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={batchName}
                  onChange={(e) => setBatchName(e.target.value)}
                  placeholder="Batch name (optional)"
                  className="px-3 py-2 border rounded-lg text-sm w-48"
                  dir="ltr"
                />
                <button
                  onClick={saveBatch}
                  disabled={saving}
                  className="flex items-center gap-2 px-5 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                  Add to Queue
                </button>
              </div>
            </div>
          )}

          {savedBatchId && (
            <div className="rounded-lg bg-green-50 border border-green-200 p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <CheckCircle className="h-5 w-5 text-green-600" />
                <span className="text-green-800">
                  {selected.size} products added to queue successfully!
                </span>
              </div>
              <Link
                href={"/admin/import/queue" as Route}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm"
              >
                View Queue
              </Link>
            </div>
          )}
        </>
      )}

      {previewProduct && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setPreviewProduct(null)}>
          <div className="bg-white rounded-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Header with page navigation */}
            <div className="bg-white border-b p-4 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                {getPageIcon(previewPage)}
                <h3 className="text-lg font-semibold">{getPageTitle(previewPage)}</h3>
              </div>
              
              {/* Page indicator and navigation */}
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <button 
                    onClick={prevPage}
                    disabled={previewPage === 1}
                    className={`p-2 rounded-full transition-colors ${
                      previewPage === 1 
                        ? "text-gray-300 cursor-not-allowed" 
                        : "text-gray-600 hover:bg-gray-100"
                    }`}
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  
                  {/* Page dots */}
                  <div className="flex items-center gap-1.5">
                    {Array.from({ length: TOTAL_PREVIEW_PAGES }, (_, i) => (
                      <button
                        key={i}
                        onClick={() => setPreviewPage(i + 1)}
                        className={`w-2.5 h-2.5 rounded-full transition-all ${
                          previewPage === i + 1 
                            ? "bg-blue-600 w-6" 
                            : "bg-gray-300 hover:bg-gray-400"
                        }`}
                      />
                    ))}
                  </div>
                  
                  <button 
                    onClick={nextPage}
                    disabled={previewPage === TOTAL_PREVIEW_PAGES}
                    className={`p-2 rounded-full transition-colors ${
                      previewPage === TOTAL_PREVIEW_PAGES 
                        ? "text-gray-300 cursor-not-allowed" 
                        : "text-gray-600 hover:bg-gray-100"
                    }`}
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                </div>
                
                <span className="text-sm text-gray-500 font-medium">
                  {previewPage} / {TOTAL_PREVIEW_PAGES}
                </span>
                
                <button onClick={() => setPreviewProduct(null)} className="p-2 hover:bg-gray-100 rounded-full ml-2">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            
            {/* Page content */}
            <div className="p-6 overflow-y-auto flex-1">
              {/* Page 1: Product Overview */}
              {previewPage === 1 && (
                <PreviewPageOne product={previewProduct} />
              )}
              
              {/* Page 2: Product Gallery */}
              {previewPage === 2 && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="font-medium text-gray-900">Product Gallery ({previewGalleryImages.length})</h4>
                  </div>
                  
                  {previewGalleryImages.length > 0 ? (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                      {previewGalleryImages.map((img, index) => (
                        <div key={index} className="relative aspect-square bg-gray-100 rounded-lg overflow-hidden group">
                          <img 
                            src={img} 
                            alt={`${previewProduct.name} - Image ${index + 1}`}
                            className="w-full h-full object-cover transition-transform group-hover:scale-105"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                          <div className="absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
                            {index + 1}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                      <ImageIcon className="h-12 w-12 mb-3" />
                      <p>No images available</p>
                    </div>
                  )}
                </div>
              )}
              
              {/* Page 3: Product Specifications */}
              {previewPage === 3 && (
                <PreviewPageThree product={previewProduct} />
              )}
              
              {/* Page 4: Stock & Popularity */}
              {previewPage === 4 && (
                <PreviewPageFour product={previewProduct} />
              )}

              {/* Page 5: Shipping & Delivery */}
              {previewPage === 5 && (
                <PreviewPageFive product={previewProduct} />
              )}
              
              {/* Page 6: Variant Pricing */}
              {previewPage === 6 && (
                <PreviewPageSix product={previewProduct} />
              )}

              {/* Page 7: AI Media */}
              {previewPage === 7 && (
                <PreviewPageSeven
                  product={previewProduct}
                  sourceContext="discover"
                />
              )}
            </div>
            
            {/* Footer navigation */}
            <div className="bg-gray-50 border-t p-4 flex items-center justify-between shrink-0">
              <button 
                onClick={prevPage}
                disabled={previewPage === 1}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                  previewPage === 1 
                    ? "text-gray-400 cursor-not-allowed" 
                    : "text-gray-700 hover:bg-gray-200"
                }`}
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </button>
              
              <div className="text-sm text-gray-500">
                Page {previewPage} of {TOTAL_PREVIEW_PAGES}
              </div>
              
              <button 
                onClick={nextPage}
                disabled={previewPage === TOTAL_PREVIEW_PAGES}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                  previewPage === TOTAL_PREVIEW_PAGES 
                    ? "text-gray-400 cursor-not-allowed" 
                    : "bg-blue-600 text-white hover:bg-blue-700"
                }`}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
