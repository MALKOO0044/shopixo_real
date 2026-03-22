"use client"

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  ArrowLeft,
  AlertTriangle,
  RefreshCw,
  Plus,
  Loader2,
  Image as ImageIcon,
  CheckCircle,
  XCircle,
  ChevronLeft,
  ChevronRight,
  Eye,
  Layers,
  FileText,
  Box,
  Truck,
  Package,
  Sparkles,
} from 'lucide-react'
import type { PricedProduct } from '@/components/admin/import/preview/types'
import PreviewPageOne from '@/components/admin/import/preview/PreviewPageOne'
import PreviewPageThree from '@/components/admin/import/preview/PreviewPageThree'
import PreviewPageFour from '@/components/admin/import/preview/PreviewPageFour'
import PreviewPageFive from '@/components/admin/import/preview/PreviewPageFive'
import PreviewPageSix from '@/components/admin/import/preview/PreviewPageSix'
import PreviewPageSeven from '@/components/admin/import/preview/PreviewPageSeven'
import { normalizeDisplayedRating } from '@/lib/rating/engine'
import { sarToUsd, usdToSar } from '@/lib/pricing'

function ImageWithFallback({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)

  if (error || !src) {
    return (
      <div className={`flex items-center justify-center bg-gray-100 ${className}`}>
        <ImageIcon className="h-8 w-8 text-gray-300" />
      </div>
    )
  }

  return (
    <div className={`relative ${className}`}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      )}
      <img
        src={src}
        alt={alt}
        className={`w-full h-full object-cover ${loading ? 'opacity-0' : 'opacity-100'} transition-opacity`}
        onLoad={() => setLoading(false)}
        onError={() => { setError(true); setLoading(false) }}
      />
    </div>
  )
}

type TabType = 'overview' | 'images' | 'specs' | 'inventory' | 'shipping' | 'variants' | 'aiMedia'

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function parseArray(value: unknown): any[] {
  const parsed = parseJsonMaybe(value)
  return Array.isArray(parsed) ? parsed : []
}

function parseStringArray(value: unknown): string[] {
  return parseArray(value)
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean)
}

function parseObject(value: unknown): Record<string, any> {
  const parsed = parseJsonMaybe(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, any>
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function toFiniteNumberOrUndefined(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function toPositiveNumberOrUndefined(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function normalizeVideoDeliveryMode(value: unknown): 'native' | 'enhanced' | 'passthrough' | undefined {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'native' || normalized === 'enhanced' || normalized === 'passthrough') {
    return normalized
  }
  return undefined
}

function normalizeVideoQualityHint(value: unknown): '4k' | 'hd' | 'sd' | 'unknown' | undefined {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === '4k' || normalized === 'hd' || normalized === 'sd' || normalized === 'unknown') {
    return normalized
  }
  return undefined
}

function normalizeInventoryStatus(value: unknown): 'ok' | 'error' | 'partial' | undefined {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'ok' || normalized === 'error' || normalized === 'partial') {
    return normalized
  }
  return undefined
}

function normalizeVariantKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s\-_.]/g, '')
}

function collectVariantLookupKeys(variant: Record<string, any>): string[] {
  const keys = [
    normalizeVariantKey(variant?.variantId),
    normalizeVariantKey(variant?.vid),
    normalizeVariantKey(variant?.variantSku),
    normalizeVariantKey(variant?.sku),
    normalizeVariantKey(variant?.cjSku),
  ].filter(Boolean)

  return Array.from(new Set(keys))
}

function toOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function buildQueueFallbackProduct(row: Record<string, any>, pid: string): PricedProduct {
  const images = parseStringArray(row.images)
  const queueVariants = parseArray(row.variants).filter((entry) => entry && typeof entry === 'object') as Record<string, any>[]
  const variantPricing = parseArray(row.variant_pricing).filter((entry) => entry && typeof entry === 'object') as Record<string, any>[]

  const variantPricingIndex = new Map<string, Record<string, any>>()
  for (const pricingRow of variantPricing) {
    for (const key of collectVariantLookupKeys(pricingRow)) {
      if (!variantPricingIndex.has(key)) {
        variantPricingIndex.set(key, pricingRow)
      }
    }
  }

  const sourceVariants = queueVariants.length > 0 ? queueVariants : variantPricing

  const processingDays = toFiniteNumber(row.processing_days, 0)
  const deliveryMin = toFiniteNumber(row.delivery_days_min, 0)
  const deliveryMax = toFiniteNumber(row.delivery_days_max, 0)
  const fallbackDeliveryLabel = deliveryMin > 0 && deliveryMax > 0
    ? `${deliveryMin}-${deliveryMax} days`
    : deliveryMax > 0
      ? `${deliveryMax} days`
      : 'Unknown'

  const mappedVariants = sourceVariants.map((variant) => {
    const variantKeys = collectVariantLookupKeys(variant)
    const pricingRow = variantKeys
      .map((key) => variantPricingIndex.get(key))
      .find((entry): entry is Record<string, any> => Boolean(entry))
      ?? (queueVariants.length === 0 ? variant : null)

    const variantId = String(
      variant?.variantId
      ?? variant?.vid
      ?? pricingRow?.variantId
      ?? pricingRow?.vid
      ?? variant?.variantSku
      ?? variant?.sku
      ?? ''
    ).trim()
    const variantSku = String(
      variant?.variantSku
      ?? variant?.sku
      ?? variant?.cjSku
      ?? pricingRow?.sku
      ?? pricingRow?.variantSku
      ?? pricingRow?.cjSku
      ?? ''
    ).trim()

    if (!variantId && !variantSku) {
      return null
    }

    const variantPriceUSD = toFiniteNumber(
      variant?.variantPriceUSD
      ?? variant?.variantPriceUsd
      ?? variant?.variantPrice
      ?? variant?.costPrice
      ?? pricingRow?.costPrice
      ?? pricingRow?.variantPriceUSD
      ?? pricingRow?.variantPrice,
      0
    )
    const allShippingOptions = Array.isArray(variant?.allShippingOptions)
      ? variant.allShippingOptions
      : Array.isArray(pricingRow?.allShippingOptions)
        ? pricingRow.allShippingOptions
        : []

    const explicitShippingPriceUSD = toFiniteNumberOrUndefined(
      variant?.shippingPriceUSD
      ?? variant?.shipping_price_usd
      ?? variant?.shippingCost
      ?? pricingRow?.shippingPriceUSD
      ?? pricingRow?.shipping_price_usd
      ?? pricingRow?.shippingCost
    )
    const rowShippingFallbackUSD = sourceVariants.length === 1
      ? toFiniteNumberOrUndefined(row.cj_shipping_cost)
      : undefined
    const hasKnownShippingValue = explicitShippingPriceUSD !== undefined || rowShippingFallbackUSD !== undefined
    const shippingPriceUSD = Math.max(0, explicitShippingPriceUSD ?? rowShippingFallbackUSD ?? 0)

    const explicitSellSar = toFiniteNumber(
      variant?.sellPriceSAR
      ?? variant?.sellPriceSar
      ?? variant?.price
      ?? pricingRow?.sellPriceSAR
      ?? pricingRow?.sellPriceSar
      ?? pricingRow?.price,
      0
    )
    const explicitSellUsd = toFiniteNumber(
      variant?.sellPriceUSD
      ?? variant?.sellPriceUsd
      ?? variant?.priceUsd
      ?? pricingRow?.sellPriceUSD
      ?? pricingRow?.sellPriceUsd
      ?? pricingRow?.priceUsd,
      0
    )

    const sellPriceUSD = explicitSellUsd > 0
      ? explicitSellUsd
      : explicitSellSar > 0
        ? sarToUsd(explicitSellSar)
        : 0
    const sellPriceSAR = explicitSellSar > 0
      ? explicitSellSar
      : sellPriceUSD > 0
        ? usdToSar(sellPriceUSD)
        : 0

    const totalCostUSD = toFiniteNumber(variant?.totalCostUSD, variantPriceUSD + shippingPriceUSD)
    const totalCostSAR = toFiniteNumber(variant?.totalCostSAR, usdToSar(totalCostUSD))
    const profitUSD = toFiniteNumber(variant?.profitUSD, sellPriceUSD - totalCostUSD)
    const profitSAR = toFiniteNumber(variant?.profitSAR, sellPriceSAR - totalCostSAR)

    const marginCandidate = toFiniteNumber(
      variant?.marginPercent ?? variant?.profitMargin ?? variant?.margin ?? row.profit_margin,
      0
    )
    const marginPercent = marginCandidate > 0 ? marginCandidate : undefined

    const stock = toFiniteNumber(variant?.stock ?? variant?.stockQty ?? variant?.quantity ?? pricingRow?.stock, 0)
    const cjStock = toFiniteNumber(variant?.cjStock ?? pricingRow?.cjStock, 0)
    const factoryStock = toFiniteNumber(variant?.factoryStock ?? pricingRow?.factoryStock, 0)
    const explicitShippingAvailable = typeof variant?.shippingAvailable === 'boolean'
      ? variant.shippingAvailable
      : typeof pricingRow?.shippingAvailable === 'boolean'
        ? pricingRow.shippingAvailable
        : undefined
    const shippingAvailable = typeof explicitShippingAvailable === 'boolean'
      ? explicitShippingAvailable
      : (hasKnownShippingValue || allShippingOptions.length > 0)

    const deliveryDays = toOptionalTrimmedString(variant?.deliveryDays)
      ?? toOptionalTrimmedString(pricingRow?.deliveryDays)
      ?? fallbackDeliveryLabel

    return {
      variantId: variantId || variantSku,
      variantSku: variantSku || variantId,
      variantPriceUSD,
      shippingAvailable,
      shippingPriceUSD,
      shippingPriceSAR: usdToSar(shippingPriceUSD),
      deliveryDays,
      logisticName: toOptionalTrimmedString(variant?.logisticName) ?? toOptionalTrimmedString(pricingRow?.logisticName),
      sellPriceSAR,
      sellPriceUSD: sellPriceUSD > 0 ? sellPriceUSD : undefined,
      totalCostSAR,
      totalCostUSD: totalCostUSD > 0 ? totalCostUSD : undefined,
      profitSAR,
      profitUSD: profitUSD !== 0 ? profitUSD : undefined,
      marginPercent,
      stock,
      cjStock,
      factoryStock,
      variantName: toOptionalTrimmedString(variant?.variantName)
        ?? toOptionalTrimmedString(variant?.variantKey)
        ?? toOptionalTrimmedString(pricingRow?.variantName),
      variantImage: toOptionalTrimmedString(variant?.variantImage)
        ?? toOptionalTrimmedString(variant?.colorImage)
        ?? toOptionalTrimmedString(pricingRow?.colorImage)
        ?? toOptionalTrimmedString(pricingRow?.variantImage),
      size: toOptionalTrimmedString(variant?.size) ?? toOptionalTrimmedString(pricingRow?.size),
      color: toOptionalTrimmedString(variant?.color) ?? toOptionalTrimmedString(pricingRow?.color),
      allShippingOptions,
    }
  }).filter((variant): variant is any => variant !== null)

  const sellUsdCandidates = mappedVariants
    .map((variant) => Number((variant as any).sellPriceUSD))
    .filter((value) => Number.isFinite(value) && value > 0)
  const sellSarCandidates = mappedVariants
    .map((variant) => Number(variant.sellPriceSAR))
    .filter((value) => Number.isFinite(value) && value > 0)

  const directRetailSar = toFiniteNumber(row.calculated_retail_sar, 0)
  const directRetailUsd = toFiniteNumber(row.calculated_retail_usd, 0)
  if (sellSarCandidates.length === 0 && directRetailSar > 0) {
    sellSarCandidates.push(directRetailSar)
  }
  if (sellUsdCandidates.length === 0 && directRetailSar > 0) {
    sellUsdCandidates.push(sarToUsd(directRetailSar))
  }
  if (sellUsdCandidates.length === 0 && directRetailUsd > 0) {
    sellUsdCandidates.push(directRetailUsd)
  }
  if (sellSarCandidates.length === 0 && directRetailUsd > 0) {
    sellSarCandidates.push(usdToSar(directRetailUsd))
  }

  const minPriceUSD = sellUsdCandidates.length > 0 ? Math.min(...sellUsdCandidates) : 0
  const maxPriceUSD = sellUsdCandidates.length > 0 ? Math.max(...sellUsdCandidates) : minPriceUSD
  const avgPriceUSD = sellUsdCandidates.length > 0
    ? sellUsdCandidates.reduce((sum, value) => sum + value, 0) / sellUsdCandidates.length
    : minPriceUSD

  const minPriceSAR = sellSarCandidates.length > 0 ? Math.min(...sellSarCandidates) : usdToSar(minPriceUSD)
  const maxPriceSAR = sellSarCandidates.length > 0 ? Math.max(...sellSarCandidates) : usdToSar(maxPriceUSD)
  const avgPriceSAR = sellSarCandidates.length > 0
    ? sellSarCandidates.reduce((sum, value) => sum + value, 0) / sellSarCandidates.length
    : usdToSar(avgPriceUSD)

  const stockFromVariants = mappedVariants.reduce((sum, variant) => sum + Number((variant as any).stock || 0), 0)
  const stock = toFiniteNumber(row.stock_total, stockFromVariants)

  const rawColorImageMap = parseObject(row.color_image_map)
  const colorImageMap: Record<string, string> = {}
  for (const [color, imageUrl] of Object.entries(rawColorImageMap)) {
    if (typeof imageUrl === 'string' && imageUrl.trim()) {
      colorImageMap[String(color)] = imageUrl.trim()
    }
  }

  const derivedColors = Array.from(
    new Set(
      mappedVariants
        .map((variant) => toOptionalTrimmedString((variant as any).color))
        .filter((value): value is string => Boolean(value))
    )
  )
  const derivedSizes = Array.from(
    new Set(
      mappedVariants
        .map((variant) => toOptionalTrimmedString((variant as any).size))
        .filter((value): value is string => Boolean(value))
    )
  )

  const availableColorsFromQueue = parseStringArray(row.available_colors)
  const availableSizesFromQueue = parseStringArray(row.available_sizes)
  const availableColors = availableColorsFromQueue.length > 0 ? availableColorsFromQueue : derivedColors
  const availableSizes = availableSizesFromQueue.length > 0 ? availableSizesFromQueue : derivedSizes
  const availableModels = parseStringArray(row.available_models)
  const sizeChartImages = parseStringArray(row.size_chart_images)

  const parsedInventory = parseObject(row.inventory_by_warehouse)
  const parsedWarehouses = parseArray(parsedInventory.warehouses)
  const normalizedWarehouses = parsedWarehouses.map((entry: any, index: number) => ({
    areaId: toFiniteNumber(entry?.areaId, index + 1),
    areaName: String(entry?.areaName ?? entry?.warehouseName ?? 'Warehouse').trim() || 'Warehouse',
    countryCode: String(entry?.countryCode ?? '').trim(),
    totalInventory: toFiniteNumber(entry?.totalInventory, 0),
    cjInventory: toFiniteNumber(entry?.cjInventory, 0),
    factoryInventory: toFiniteNumber(entry?.factoryInventory, 0),
  }))
  const warehousesTotalInventory = normalizedWarehouses.reduce((sum, warehouse) => sum + warehouse.totalInventory, 0)
  const inventory = normalizedWarehouses.length > 0 || Number.isFinite(Number(parsedInventory.totalAvailable))
    ? {
        totalCJ: toFiniteNumber(parsedInventory.totalCJ, 0),
        totalFactory: toFiniteNumber(parsedInventory.totalFactory, 0),
        totalAvailable: toFiniteNumber(
          parsedInventory.totalAvailable,
          warehousesTotalInventory > 0 ? warehousesTotalInventory : stock
        ),
        warehouses: normalizedWarehouses,
      }
    : undefined

  const inventoryVariants = mappedVariants.map((variant, index) => {
    const fallbackLabel = variant.variantName || variant.size || variant.color || variant.variantSku || `Variant ${index + 1}`
    return {
      variantId: variant.variantId,
      sku: variant.variantSku,
      shortName: fallbackLabel,
      priceUSD: toFiniteNumber(variant.variantPriceUSD, 0),
      cjStock: toFiniteNumber((variant as any).cjStock, 0),
      factoryStock: toFiniteNumber((variant as any).factoryStock, 0),
      totalStock: toFiniteNumber((variant as any).stock, 0),
    }
  })

  const reviewCount = toFiniteNumber(row.review_count, 0)
  const displayedRating = toPositiveNumberOrUndefined(row.displayed_rating)
  const ratingConfidence = toPositiveNumberOrUndefined(row.rating_confidence)

  const estimatedProcessingDays = processingDays > 0
    ? `${processingDays} day${processingDays === 1 ? '' : 's'}`
    : undefined
  const estimatedDeliveryDays = deliveryMin > 0 && deliveryMax > 0
    ? `${deliveryMin}-${deliveryMax} days`
    : deliveryMax > 0
      ? `${deliveryMax} days`
      : undefined

  return {
    pid,
    cjSku: String(row.cj_sku || row.cj_product_id || `CJ-${pid}`),
    storeSku: typeof row.store_sku === 'string' ? row.store_sku : undefined,
    name: String(row.name_en || `CJ Product ${pid}`),
    images,
    minPriceSAR,
    maxPriceSAR,
    avgPriceSAR,
    minPriceUSD: minPriceUSD > 0 ? minPriceUSD : undefined,
    maxPriceUSD: maxPriceUSD > 0 ? maxPriceUSD : undefined,
    avgPriceUSD: avgPriceUSD > 0 ? avgPriceUSD : undefined,
    profitMarginApplied: toPositiveNumberOrUndefined(row.profit_margin),
    stock,
    listedNum: toFiniteNumber(row.total_sales, 0),
    totalVerifiedInventory: inventory?.totalCJ,
    totalUnVerifiedInventory: inventory?.totalFactory,
    inventory,
    inventoryStatus: normalizeInventoryStatus(row.inventory_status),
    inventoryErrorMessage: typeof row.inventory_error_message === 'string' ? row.inventory_error_message : undefined,
    variants: mappedVariants,
    inventoryVariants,
    successfulVariants: mappedVariants.length,
    totalVariants: queueVariants.length > 0 ? queueVariants.length : mappedVariants.length,
    description: typeof row.description_en === 'string' ? row.description_en : undefined,
    overview: typeof row.overview === 'string' ? row.overview : undefined,
    productInfo: typeof row.product_info === 'string' ? row.product_info : undefined,
    sizeInfo: typeof row.size_info === 'string' ? row.size_info : undefined,
    productNote: typeof row.product_note === 'string' ? row.product_note : undefined,
    packingList: typeof row.packing_list === 'string' ? row.packing_list : undefined,
    displayedRating,
    ratingConfidence,
    rating: toPositiveNumberOrUndefined(row.supplier_rating),
    reviewCount: reviewCount > 0 ? Math.floor(reviewCount) : undefined,
    categoryName: typeof row.category_name === 'string' && row.category_name.trim()
      ? row.category_name
      : typeof row.category === 'string'
        ? row.category
        : undefined,
    productWeight: toPositiveNumberOrUndefined(row.weight_g),
    packLength: toPositiveNumberOrUndefined(row.pack_length),
    packWidth: toPositiveNumberOrUndefined(row.pack_width),
    packHeight: toPositiveNumberOrUndefined(row.pack_height),
    material: typeof row.material === 'string' ? row.material : undefined,
    productType: typeof row.product_type === 'string' ? row.product_type : undefined,
    sizeChartImages: sizeChartImages.length > 0 ? sizeChartImages : undefined,
    processingTimeHours: processingDays > 0 ? Math.round(processingDays * 24) : undefined,
    deliveryTimeHours: deliveryMax > 0 ? Math.round(deliveryMax * 24) : undefined,
    estimatedProcessingDays,
    estimatedDeliveryDays,
    originCountry: typeof row.origin_country === 'string' ? row.origin_country : undefined,
    hsCode: typeof row.hs_code === 'string' ? row.hs_code : undefined,
    videoUrl: typeof row.video_4k_url === 'string' && row.video_4k_url.trim()
      ? row.video_4k_url
      : typeof row.video_url === 'string'
        ? row.video_url
        : undefined,
    videoSourceUrl: typeof row.video_source_url === 'string' ? row.video_source_url : undefined,
    video4kUrl: typeof row.video_4k_url === 'string' ? row.video_4k_url : undefined,
    videoDeliveryMode: normalizeVideoDeliveryMode(row.video_delivery_mode),
    videoQualityGatePassed: typeof row.video_quality_gate_passed === 'boolean' ? row.video_quality_gate_passed : undefined,
    videoSourceQualityHint: normalizeVideoQualityHint(row.video_source_quality_hint),
    availableSizes: availableSizes.length > 0 ? availableSizes : undefined,
    availableColors: availableColors.length > 0 ? availableColors : undefined,
    availableModels: availableModels.length > 0 ? availableModels : undefined,
    colorImageMap: Object.keys(colorImageMap).length > 0 ? colorImageMap : undefined,
  }
}

export default function CjProductAdminPage({ params }: { params: { pid: string } }) {
  const searchParams = useSearchParams()
  const pid = decodeURIComponent(params.pid)
  const queueId = (searchParams?.get('queueId') || '').trim()
  const [loading, setLoading] = useState(true)
  const [product, setProduct] = useState<PricedProduct | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sourceNotice, setSourceNotice] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [activeTab, setActiveTab] = useState<TabType>('overview')
  const [selectedImageIndex, setSelectedImageIndex] = useState(0)
  const [addingToQueue, setAddingToQueue] = useState(false)
  const [queueMessage, setQueueMessage] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true

    async function loadQueueFallbackProduct(): Promise<PricedProduct | null> {
      const params = new URLSearchParams({ status: 'all', limit: '1' })
      if (queueId) {
        params.set('queue_id', queueId)
      } else {
        params.set('cj_product_id', pid)
      }

      const res = await fetch(`/api/admin/import/queue?${params.toString()}`, { cache: 'no-store' })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok || !payload?.ok) return null

      const row = Array.isArray(payload?.products) ? payload.products[0] : null
      if (!row || typeof row !== 'object') return null

      return buildQueueFallbackProduct(row as Record<string, any>, pid)
    }

    async function load() {
      setLoading(true)
      setErr(null)
      setSourceNotice(null)

      try {
        const res = await fetch(`/api/admin/cj/products/${encodeURIComponent(pid)}/details`, { cache: 'no-store' })
        const j = await res.json().catch(() => ({}))
        if (!mounted) return
        if (!res.ok || !j.ok) {
          const errorType = typeof j?.errorType === 'string' ? j.errorType : ''
          const canFallbackToQueue = Boolean(j?.canFallbackToQueue) || errorType === 'not_found'
          if (canFallbackToQueue) {
            const queueFallback = await loadQueueFallbackProduct().catch(() => null)
            if (!mounted) return

            if (queueFallback) {
              setProduct(queueFallback)
              setErr(null)
              setSourceNotice('Loaded queue snapshot because this product was not found in live CJ API.')
              return
            }
          }

          setProduct(null)
          setErr(j?.error || 'Failed to load product details')
        } else {
          setProduct(j.product)
          setErr(null)
        }
      } catch (e: any) {
        if (!mounted) return
        setProduct(null)
        setErr(e?.message || String(e))
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [pid, queueId])

  async function forceResync() {
    setSyncing(true)
    try {
      const res = await fetch(`/api/cj/sync/product/${encodeURIComponent(pid)}?updateImages=true&updateVideo=true&updatePrice=true`, { cache: 'no-store' })
      const j = await res.json()
      alert(res.ok ? 'Re-sync complete' : `Re-sync failed: ${j?.error || res.status}`)
      if (res.ok) window.location.reload()
    } catch (e: any) {
      alert(`Re-sync error: ${e?.message || String(e)}`)
    } finally {
      setSyncing(false)
    }
  }

  async function addToQueue() {
    if (!product) return
    setAddingToQueue(true)
    setQueueMessage(null)
    try {
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
          .trim()
      }

      // Build variant_pricing array with all variant data for accurate import
      const variantPricing = (product.variants || [])
        .map(v => {
          const sellPriceSar = Number(v.sellPriceSAR || 0)
          const directSellUsd = Number((v as any).sellPriceUSD)
          const sellPriceUsd = Number.isFinite(directSellUsd) && directSellUsd > 0
            ? directSellUsd
            : (sellPriceSar > 0 ? sarToUsd(sellPriceSar) : 0)
          const variantMarginPercent = Number((v as any).marginPercent)

          return {
            variantId: v.variantId,
            sku: v.variantSku,
            color: v.color,
            size: v.size,
            colorImage: v.variantImage,
            price: sellPriceSar,
            priceUsd: sellPriceUsd,
            marginPercent: Number.isFinite(variantMarginPercent) ? variantMarginPercent : null,
            costPrice: v.variantPriceUSD || 0,
            shippingCost: v.shippingPriceUSD || 0,
            stock: (v.cjStock || 0) + (v.factoryStock || 0),
            cjStock: v.cjStock || 0,
            factoryStock: v.factoryStock || 0,
          }
        })
        .filter(v => Number(v.price) > 0)

      const specifications: Record<string, string> = {}
      if (product.material) specifications.Material = htmlToPlain(product.material)
      if (product.productType) specifications['Product Type'] = htmlToPlain(product.productType)
      if (product.originCountry) specifications['Origin Country'] = htmlToPlain(product.originCountry)
      if (product.productWeight) specifications.Weight = `${product.productWeight} g`

      const sellingPoints = htmlToPlain(product.overview || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 8)

      const res = await fetch('/api/admin/import/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Single Import: ${product.name}`,
          category: product.categoryName || 'General',
          products: [{
            pid,
            cjProductId: pid,
            cjSku: product.cjSku,
            name: product.name || 'Unknown Product',
            description: product.description || product.overview || '',
            categoryName: product.categoryName || 'Uncategorized',
            images: product.images.slice(0, 15),
            videoUrl: product.videoUrl,
            variants: product.variants,
            variantPricing,
            stock: product.stock,
            totalSales: product.listedNum,
            displayedRating: typeof product.displayedRating === 'number' ? product.displayedRating : undefined,
            ratingConfidence: typeof product.ratingConfidence === 'number' ? product.ratingConfidence : undefined,
            availableColors: product.availableColors || [],
            availableSizes: product.availableSizes || [],
            specifications,
            sellingPoints,
            productWeight: product.productWeight,
            packLength: product.packLength,
            packWidth: product.packWidth,
            packHeight: product.packHeight,
            processingDays: product.processingTimeHours ? Math.ceil(product.processingTimeHours / 24) : undefined,
            deliveryDaysMax: product.deliveryTimeHours ? Math.ceil(product.deliveryTimeHours / 24) : undefined,
            originCountry: product.originCountry,
            hsCode: product.hsCode,
            sizeChartImages: product.sizeChartImages,
            profitMargin: Number((product as any).profitMarginApplied) || undefined,
          }]
        })
      })
      const j = await res.json()
      if (res.ok && j.ok) {
        setQueueMessage('Product added to import queue with full data!')
      } else {
        setQueueMessage(`Failed: ${j.error || 'Unknown error'}`)
      }
    } catch (e: any) {
      setQueueMessage(`Error: ${e?.message || String(e)}`)
    } finally {
      setAddingToQueue(false)
    }
  }

  const tabs: { id: TabType; label: string; icon: any }[] = [
    { id: 'overview', label: 'Overview', icon: Eye },
    { id: 'images', label: 'Images', icon: ImageIcon },
    { id: 'specs', label: 'Specifications', icon: FileText },
    { id: 'inventory', label: 'Stock & Popularity', icon: Box },
    { id: 'shipping', label: 'Shipping & Delivery', icon: Truck },
    { id: 'variants', label: 'Variants', icon: Layers },
    { id: 'aiMedia', label: 'AI Media', icon: Sparkles },
  ]

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-12 w-12 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-gray-600">Loading product details from CJ API...</p>
          <p className="text-sm text-gray-400 mt-2">This may take a moment as we fetch inventory and shipping data</p>
        </div>
      </div>
    )
  }

  if (err || !product) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertTriangle className="h-12 w-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Failed to Load Product</h2>
          <p className="text-gray-600 mb-4">{err || 'Product not found'}</p>
          <Link href="/admin/cj" className="text-blue-600 hover:underline">
            Back to CJ Products
          </Link>
        </div>
      </div>
    )
  }

  const images = product.images || []
  const totalStock = product.stock || 0
  const maxShippingEstUsd = Array.isArray(product.variants)
    ? product.variants.reduce((highest: number, variant: any) => {
      const shippingUsd = Number((variant as any)?.shippingPriceUSD || 0)
      return shippingUsd > highest ? shippingUsd : highest
    }, 0)
    : 0
  const displayedRating = typeof product.displayedRating === 'number'
    ? normalizeDisplayedRating(product.displayedRating)
    : null

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/admin/import/queue" className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
                <ArrowLeft className="h-5 w-5 text-gray-600" />
              </Link>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-gray-500">CJ #{pid.slice(-8)}</span>
                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                    totalStock > 100 ? 'bg-green-100 text-green-700' :
                    totalStock > 0 ? 'bg-amber-100 text-amber-700' :
                    'bg-red-100 text-red-700'
                  }`}>
                    {totalStock > 0 ? `${totalStock.toLocaleString()} in stock` : 'Out of stock'}
                  </span>
                  {displayedRating !== null && (
                    <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700">
                      ★ {displayedRating.toFixed(1)}
                    </span>
                  )}
                </div>
                <h1 className="text-lg font-semibold text-gray-900 line-clamp-1 max-w-xl">
                  {product.name || 'Unknown Product'}
                </h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {!sourceNotice && (
                <>
                  <button
                    onClick={forceResync}
                    disabled={syncing}
                    className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                  >
                    <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
                    {syncing ? 'Syncing...' : 'Re-sync'}
                  </button>
                  <button
                    onClick={addToQueue}
                    disabled={addingToQueue}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    <Plus className="h-4 w-4" />
                    {addingToQueue ? 'Adding...' : 'Add to Queue'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {queueMessage && (
        <div className={`max-w-7xl mx-auto px-4 mt-4`}>
          <div className={`p-4 rounded-lg flex items-center gap-3 ${
            queueMessage.includes('added') ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'
          }`}>
            {queueMessage.includes('added') ? (
              <CheckCircle className="h-5 w-5 text-green-600" />
            ) : (
              <XCircle className="h-5 w-5 text-red-600" />
            )}
            <span className={queueMessage.includes('added') ? 'text-green-800' : 'text-red-800'}>
              {queueMessage}
            </span>
          </div>
        </div>
      )}

      {sourceNotice && (
        <div className="max-w-7xl mx-auto px-4 mt-4">
          <div className="p-4 rounded-lg flex items-center gap-3 bg-blue-50 border border-blue-200">
            <AlertTriangle className="h-5 w-5 text-blue-600" />
            <span className="text-blue-800">{sourceNotice}</span>
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
              <div className="aspect-video relative bg-gray-100">
                {images.length > 0 ? (
                  <ImageWithFallback
                    src={images[selectedImageIndex]}
                    alt={product.name || 'Product'}
                    className="w-full h-full"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <ImageIcon className="h-16 w-16 text-gray-300" />
                  </div>
                )}
                {images.length > 1 && (
                  <>
                    <button
                      onClick={() => setSelectedImageIndex(prev => prev === 0 ? images.length - 1 : prev - 1)}
                      className="absolute left-4 top-1/2 -translate-y-1/2 p-2 bg-white/80 rounded-full shadow hover:bg-white transition-colors"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                      onClick={() => setSelectedImageIndex(prev => (prev + 1) % images.length)}
                      className="absolute right-4 top-1/2 -translate-y-1/2 p-2 bg-white/80 rounded-full shadow hover:bg-white transition-colors"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                  </>
                )}
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/60 px-3 py-1 rounded-full text-white text-xs">
                  {selectedImageIndex + 1} / {images.length}
                </div>
              </div>
              <div className="p-4 border-t">
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {images.slice(0, 12).map((img, idx) => (
                    <button
                      key={idx}
                      onClick={() => setSelectedImageIndex(idx)}
                      className={`flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-colors ${
                        selectedImageIndex === idx ? 'border-blue-500' : 'border-transparent hover:border-gray-300'
                      }`}
                    >
                      <ImageWithFallback src={img} alt={`Thumbnail ${idx + 1}`} className="w-full h-full" />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border shadow-sm">
              <div className="border-b">
                <div className="flex overflow-x-auto">
                  {tabs.map(tab => {
                    const Icon = tab.icon
                    return (
                      <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`flex items-center gap-2 px-6 py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                          activeTab === tab.id
                            ? 'border-blue-600 text-blue-600'
                            : 'border-transparent text-gray-600 hover:text-gray-900'
                        }`}
                      >
                        <Icon className="h-4 w-4" />
                        {tab.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="p-6">
                {activeTab === 'overview' && (
                  <PreviewPageOne product={product} />
                )}
                {activeTab === 'images' && (
                  <div className="space-y-6">
                    <h3 className="text-lg font-semibold text-gray-900">Product Images ({images.length})</h3>
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                      {images.map((img, idx) => (
                        <button
                          key={idx}
                          onClick={() => setSelectedImageIndex(idx)}
                          className={`aspect-square rounded-lg overflow-hidden border-2 transition-colors ${
                            selectedImageIndex === idx ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-200 hover:border-gray-400'
                          }`}
                        >
                          <ImageWithFallback src={img} alt={`Image ${idx + 1}`} className="w-full h-full" />
                        </button>
                      ))}
                    </div>
                    {product.sizeChartImages && product.sizeChartImages.length > 0 && (
                      <div className="mt-8">
                        <h4 className="text-md font-semibold text-gray-900 mb-4">Size Charts</h4>
                        <div className="grid grid-cols-2 gap-4">
                          {product.sizeChartImages.map((img, idx) => (
                            <div key={idx} className="rounded-lg overflow-hidden border">
                              <ImageWithFallback src={img} alt={`Size chart ${idx + 1}`} className="w-full h-auto" />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {activeTab === 'specs' && (
                  <PreviewPageThree product={product} />
                )}
                {activeTab === 'inventory' && (
                  <PreviewPageFour product={product} />
                )}
                {activeTab === 'shipping' && (
                  <PreviewPageFive product={product} />
                )}
                {activeTab === 'variants' && (
                  <PreviewPageSix product={product} />
                )}
                {activeTab === 'aiMedia' && (
                  <PreviewPageSeven product={product} sourceContext="cj_detail" />
                )}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="bg-white rounded-xl border shadow-sm p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Quick Stats</h3>
              <div className="space-y-4">
                <div className="flex justify-between items-center py-2 border-b">
                  <span className="text-gray-600">Product ID</span>
                  <span className="font-mono text-sm text-gray-900">{pid.slice(-12)}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b">
                  <span className="text-gray-600">SKU</span>
                  <span className="font-mono text-sm text-gray-900">{product.cjSku}</span>
                </div>
                {displayedRating !== null && (
                  <div className="flex justify-between items-center py-2 border-b">
                    <span className="text-gray-600">Rating</span>
                    <span className="font-semibold text-amber-600">★ {displayedRating.toFixed(1)}</span>
                  </div>
                )}
                <div className="flex justify-between items-center py-2 border-b">
                  <span className="text-gray-600">Total Stock</span>
                  <span className={`font-semibold ${totalStock > 100 ? 'text-green-600' : totalStock > 0 ? 'text-amber-600' : 'text-red-600'}`}>
                    {totalStock.toLocaleString()}
                  </span>
                </div>
                {product.totalVerifiedInventory !== undefined && (
                  <div className="flex justify-between items-center py-2 border-b">
                    <span className="text-gray-600">CJ Warehouse</span>
                    <span className="font-semibold text-green-600">{product.totalVerifiedInventory.toLocaleString()}</span>
                  </div>
                )}
                {product.totalUnVerifiedInventory !== undefined && (
                  <div className="flex justify-between items-center py-2 border-b">
                    <span className="text-gray-600">Factory</span>
                    <span className="font-semibold text-amber-600">{product.totalUnVerifiedInventory.toLocaleString()}</span>
                  </div>
                )}
                <div className="flex justify-between items-center py-2 border-b">
                  <span className="text-gray-600">Variants</span>
                  <span className="font-semibold">{product.totalVariants}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b">
                  <span className="text-gray-600">Images</span>
                  <span className="font-semibold">{images.length}</span>
                </div>
                {product.listedNum > 0 && (
                  <div className="flex justify-between items-center py-2 border-b">
                    <span className="text-gray-600">Times Listed</span>
                    <span className="font-semibold text-blue-600">{product.listedNum.toLocaleString()}</span>
                  </div>
                )}
              </div>
            </div>

            {product.minPriceSAR > 0 && (
              <div className="bg-white rounded-xl border shadow-sm p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Pricing (USD)</h3>
                <div className="space-y-4">
                  <div className="flex justify-between items-center py-2 border-b">
                    <span className="text-gray-600">Cost Price</span>
                    <span className="font-semibold">${(product.variants[0]?.variantPriceUSD || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b">
                    <span className="text-gray-600">Shipping (Applied Highest)</span>
                    <span className="font-semibold">${maxShippingEstUsd.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b">
                    <span className="text-gray-600">Suggested Retail</span>
                    <span className="font-bold text-green-600">
                      {(() => {
                        const directMinUsd = Number((product as any).minPriceUSD)
                        const directMaxUsd = Number((product as any).maxPriceUSD)
                        const minUsd = Number.isFinite(directMinUsd) && directMinUsd > 0
                          ? directMinUsd
                          : sarToUsd(Number(product.minPriceSAR))
                        const maxUsd = Number.isFinite(directMaxUsd) && directMaxUsd > 0
                          ? directMaxUsd
                          : sarToUsd(Number(product.maxPriceSAR))
                        return `$${minUsd.toFixed(2)} - $${maxUsd.toFixed(2)}`
                      })()}
                    </span>
                  </div>
                  {Number((product as any).profitMarginApplied) > 0 && (
                    <div className="flex justify-between items-center py-2 border-b">
                      <span className="text-gray-600">Applied Margin</span>
                      <span className="font-semibold text-emerald-700">
                        {Number((product as any).profitMarginApplied).toFixed(0)}%
                      </span>
                    </div>
                  )}
                  {product.variants[0]?.profitSAR > 0 && (
                    <div className="flex justify-between items-center py-2">
                      <span className="text-gray-600">Est. Profit</span>
                      <span className="font-bold text-emerald-600">
                        {(() => {
                          const directProfitUsd = Number((product.variants[0] as any)?.profitUSD)
                          const profitUsd = Number.isFinite(directProfitUsd)
                            ? directProfitUsd
                            : sarToUsd(Number(product.variants[0].profitSAR))
                          return `$${profitUsd.toFixed(2)}`
                        })()}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {(product.availableColors?.length || product.availableSizes?.length || product.availableModels?.length) && (
              <div className="bg-white rounded-xl border shadow-sm p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Available Options</h3>
                <div className="space-y-4">
                  {product.availableColors && product.availableColors.length > 0 && (
                    <div>
                      <span className="text-sm font-medium text-gray-700">Colors ({product.availableColors.length})</span>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {product.availableColors.slice(0, 10).map((color, idx) => (
                          <span key={idx} className="px-3 py-1 bg-gray-100 text-gray-700 text-sm rounded-full">
                            {color}
                          </span>
                        ))}
                        {product.availableColors.length > 10 && (
                          <span className="px-3 py-1 bg-gray-200 text-gray-600 text-sm rounded-full">
                            +{product.availableColors.length - 10} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {product.availableSizes && product.availableSizes.length > 0 && (
                    <div>
                      <span className="text-sm font-medium text-gray-700">Sizes ({product.availableSizes.length})</span>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {product.availableSizes.slice(0, 10).map((size, idx) => (
                          <span key={idx} className="px-3 py-1 bg-blue-100 text-blue-700 text-sm rounded-full">
                            {size}
                          </span>
                        ))}
                        {product.availableSizes.length > 10 && (
                          <span className="px-3 py-1 bg-blue-200 text-blue-600 text-sm rounded-full">
                            +{product.availableSizes.length - 10} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {product.availableModels && product.availableModels.length > 0 && (
                    <div>
                      <span className="text-sm font-medium text-gray-700">Compatible Devices ({product.availableModels.length})</span>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {product.availableModels.slice(0, 8).map((model, idx) => (
                          <span key={idx} className="px-3 py-1 bg-purple-100 text-purple-700 text-sm rounded-full">
                            {model}
                          </span>
                        ))}
                        {product.availableModels.length > 8 && (
                          <span className="px-3 py-1 bg-purple-200 text-purple-600 text-sm rounded-full">
                            +{product.availableModels.length - 8} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {product.categoryName && (
              <div className="bg-white rounded-xl border shadow-sm p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Category</h3>
                <p className="text-gray-700">{product.categoryName}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
