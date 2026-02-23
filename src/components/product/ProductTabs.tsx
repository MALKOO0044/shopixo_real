"use client";

import { useState, useMemo } from "react";
import { Star, ThumbsUp, Image as ImageIcon, Package, Ruler, Palette } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import DescriptionGallery from "./DescriptionGallery";
import SafeHtmlRenderer, { parseProductDescription } from "./SafeHtmlRenderer";
import { normalizeDisplayedRating } from "@/lib/rating/engine";

const NON_PRODUCT_GALLERY_IMAGE_RE = /(sprite|icon|favicon|logo|placeholder|blank|loading|alipay|wechat|whatsapp|kefu|service|avatar|thumb|thumbnail|small|tiny|mini|sizechart|size\s*chart|chart|table|guide|tips|hot|badge|flag|promo|banner|sale|discount|qr)/i;
const GALLERY_IMAGE_KEY_SIZE_TOKEN_RE = /[_-](\d{2,4})x(\d{2,4})(?=\.)/gi;
const PRODUCT_IMAGE_LABEL_RE = /Product\s*Image\s*:?\s*/gi;

function normalizeProductGalleryImageKey(url: string): string {
  const normalizedUrl = String(url || "").trim().toLowerCase();
  if (!normalizedUrl) return "";

  try {
    const parsed = new URL(normalizedUrl);
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(GALLERY_IMAGE_KEY_SIZE_TOKEN_RE, "");
    return parsed.toString();
  } catch {
    return normalizedUrl
      .replace(/[?#].*$/, "")
      .replace(GALLERY_IMAGE_KEY_SIZE_TOKEN_RE, "");
  }
}

function isValidProductGalleryImageUrl(url: string): boolean {
  const candidate = String(url || "").trim();
  if (!/^https?:\/\//i.test(candidate)) return false;
  if (NON_PRODUCT_GALLERY_IMAGE_RE.test(candidate)) return false;
  return true;
}

function extractImagesFromRichHtml(html: string): string[] {
  if (!html) return [];

  const images: string[] = [];
  const seen = new Set<string>();
  const pushImage = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const candidate = raw.replace(/&amp;/g, "&").trim();
    if (!isValidProductGalleryImageUrl(candidate)) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    images.push(candidate);
  };

  const imgTagRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = imgTagRegex.exec(html)) !== null) {
    pushImage(match[1]);
  }

  const urlRegex = /https?:\/\/[^\s<>"']+\.(?:jpg|jpeg|png|gif|webp|avif|bmp)(?:\?[^\s<>"']*)?/gi;
  while ((match = urlRegex.exec(html)) !== null) {
    pushImage(match[0]);
  }

  return images;
}

function sanitizeRichSectionHtml(html: string): { html: string; extractedImages: string[] } {
  const source = String(html || "");
  if (!source.trim()) return { html: "", extractedImages: [] };

  const extractedImages = extractImagesFromRichHtml(source);
  const sanitized = source
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(PRODUCT_IMAGE_LABEL_RE, " ")
    .replace(/<([a-z][a-z0-9]*)\b[^>]*>\s*<\/\1>/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return { html: sanitized, extractedImages };
}

interface Review {
  id: number;
  author: string;
  date: string;
  rating: number;
  content: string;
  helpful: number;
  images?: string[];
  purchased?: string;
  fit?: string;
}

interface RelatedProduct {
  id: number;
  slug: string;
  title: string;
  image: string;
  price: number;
  originalPrice?: number;
  displayed_rating?: number | null;
  badge?: string;
}

interface ProductTabsProps {
  description?: string;
  overviewHtml?: string;
  productInfoHtml?: string;
  sizeInfoHtml?: string;
  productNoteHtml?: string;
  packingListHtml?: string;
  highlights?: string[];
  sellingPoints?: string[];
  specifications?: Record<string, string>;
  reviews?: Review[];
  averageRating?: number;
  totalReviews?: number;
  recommendations?: RelatedProduct[];
  productTitle?: string;
}

export default function ProductTabs({
  description = "",
  overviewHtml = "",
  productInfoHtml = "",
  sizeInfoHtml = "",
  productNoteHtml = "",
  packingListHtml = "",
  highlights = [],
  sellingPoints = [],
  specifications = {},
  reviews = [],
  averageRating = 0,
  totalReviews = 0,
  recommendations = [],
  productTitle = "Product",
}: ProductTabsProps) {
  const [activeTab, setActiveTab] = useState<"overview" | "reviews" | "recommendations">("overview");
  const normalizedAverageRating = normalizeDisplayedRating(averageRating);

  const richSections = useMemo(() => {
    return [
      { key: "overview", title: "Overview", html: overviewHtml },
      { key: "productInfo", title: "Product Information", html: productInfoHtml },
      { key: "sizeInfo", title: "Size Information", html: sizeInfoHtml },
      { key: "productNote", title: "Product Notes", html: productNoteHtml },
      { key: "packingList", title: "Packing List", html: packingListHtml },
    ].map((section) => {
      const sanitized = sanitizeRichSectionHtml(section.html);
      return {
        ...section,
        html: sanitized.html,
        extractedImages: sanitized.extractedImages,
      };
    }).filter((section) => {
      const text = String(section.html || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .trim();
      return text.length > 0;
    });
  }, [overviewHtml, productInfoHtml, sizeInfoHtml, productNoteHtml, packingListHtml]);

  const parsedDescription = useMemo(() => {
    return parseProductDescription(description);
  }, [description]);

  const galleryImages = useMemo(() => {
    const merged: string[] = [];
    const seen = new Set<string>();
    const pushImage = (raw: unknown) => {
      if (typeof raw !== "string") return;
      const candidate = raw.trim();
      if (!isValidProductGalleryImageUrl(candidate)) return;

      const key = normalizeProductGalleryImageKey(candidate);
      if (!key || seen.has(key)) return;

      seen.add(key);
      merged.push(candidate);
    };

    for (const imageUrl of parsedDescription.extractedImages) {
      pushImage(imageUrl);
    }

    for (const section of richSections) {
      for (const imageUrl of section.extractedImages) {
        pushImage(imageUrl);
      }
    }

    return merged;
  }, [parsedDescription.extractedImages, richSections]);

  const hasGalleryImages = galleryImages.length > 0;

  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "reviews" as const, label: `Reviews (${totalReviews})` },
    { id: "recommendations" as const, label: "Recommendations" },
  ];

  const allHighlights = useMemo(() => {
    const combined = [...highlights];
    for (const h of parsedDescription.highlights) {
      if (!combined.some(existing => existing.toLowerCase().includes(h.toLowerCase().split(":")[0]))) {
        combined.push(h);
      }
    }
    return combined;
  }, [highlights, parsedDescription.highlights]);

  return (
    <div className="mt-8 border-t pt-6">
      <div className="flex gap-6 border-b mb-6 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`pb-3 text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === tab.id
                ? "text-gray-900 border-b-2 border-gray-900"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "overview" && (
        <div className="space-y-8">
          {allHighlights.length > 0 && (
            <div className="bg-gray-50 rounded-xl p-6">
              <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                <Star className="w-5 h-5 text-amber-500" />
                Highlights
              </h3>
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {allHighlights.map((h, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary mt-2 shrink-0" />
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {sellingPoints.length > 0 && (
            <div className="bg-blue-50 rounded-xl p-6">
              <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                <Package className="w-5 h-5 text-blue-600" />
                Selling Points
              </h3>
              <ol className="space-y-2 text-sm text-gray-700">
                {sellingPoints.map((p, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold shrink-0">
                      {i + 1}
                    </span>
                    <span className="pt-0.5">{p}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {Object.keys(specifications).length > 0 && (
            <div className="bg-white border rounded-xl p-6">
              <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                <Ruler className="w-5 h-5 text-gray-600" />
                Specifications
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {Object.entries(specifications).map(([key, value]) => (
                  <div key={key} className="bg-gray-50 rounded-lg p-3">
                    <div className="text-xs text-gray-500 mb-1">{key}</div>
                    <div className="text-sm font-medium text-gray-900">{value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {parsedDescription.textContent && (
            <div className="bg-white border rounded-xl p-6">
              <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                <Palette className="w-5 h-5 text-gray-600" />
                More about this item
              </h3>
              <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
                {parsedDescription.textContent}
              </p>
            </div>
          )}

          {richSections.map((section) => (
            <div key={section.key} className="bg-white border rounded-xl p-6">
              <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                <Palette className="w-5 h-5 text-gray-600" />
                {section.title}
              </h3>
              <SafeHtmlRenderer html={section.html} className="text-sm text-gray-700" />
            </div>
          ))}

          {hasGalleryImages && (
            <div className="bg-white border rounded-xl p-6">
              <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                <ImageIcon className="w-5 h-5 text-gray-600" />
                Product Gallery
              </h3>
              <DescriptionGallery 
                images={galleryImages} 
                title={productTitle}
              />
            </div>
          )}
        </div>
      )}

      {activeTab === "reviews" && (
        <div className="space-y-6">
          {totalReviews > 0 && averageRating > 0 ? (
            <>
              <div className="flex flex-col md:flex-row md:items-start gap-6 md:gap-8">
                <div className="bg-gray-50 rounded-xl p-6 text-center md:text-left">
                  <div className="flex items-center justify-center md:justify-start gap-2 mb-2">
                    <span className="text-4xl font-bold">{normalizedAverageRating.toFixed(1)}</span>
                    <div className="flex">
                      {[...Array(5)].map((_, i) => (
                        <Star
                          key={i}
                          className={`w-5 h-5 ${
                            i < Math.floor(normalizedAverageRating)
                              ? "fill-amber-400 text-amber-400"
                              : "fill-gray-200 text-gray-200"
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                  <p className="text-sm text-gray-600">{totalReviews} {totalReviews === 1 ? 'review' : 'reviews'}</p>
                </div>
              </div>

              {reviews.length > 0 && (
                <div className="space-y-4 pt-4 border-t">
                  {reviews.map((review) => {
                    const reviewRating = normalizeDisplayedRating(review.rating);
                    const reviewStars = Math.floor(reviewRating);
                    return (
                      <div key={review.id} className="bg-white border rounded-xl p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <div className="flex">
                              {[...Array(5)].map((_, i) => (
                                <Star
                                  key={i}
                                  className={`w-4 h-4 ${
                                    i < reviewStars
                                      ? "fill-amber-400 text-amber-400"
                                      : "fill-gray-200 text-gray-200"
                                  }`}
                                />
                              ))}
                            </div>
                            <span className="text-sm font-medium">{reviewRating.toFixed(1)}</span>
                          </div>
                          <span className="text-xs text-gray-400">{review.date}</span>
                        </div>
                        <button className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 transition-colors">
                          <ThumbsUp className="w-4 h-4" />
                          <span className="hidden sm:inline">Helpful</span> ({review.helpful})
                        </button>
                        <p className="text-sm text-gray-700 mb-3">{review.content}</p>
                        {review.images && review.images.length > 0 && (
                          <div className="flex gap-2 mb-3">
                            {review.images.map((img, i) => (
                              <div key={i} className="w-16 h-16 rounded-lg overflow-hidden relative">
                                <Image src={img} alt="" fill className="object-cover" />
                              </div>
                            ))}
                          </div>
                        )}
                        {review.purchased && (
                          <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2 inline-block">
                            Purchased: {review.purchased}
                            {review.fit && ` | Overall Fit: ${review.fit}`}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-12 bg-gray-50 rounded-xl">
              <Star className="w-12 h-12 text-gray-300 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-700 mb-2">No Reviews Yet</h3>
              <p className="text-sm text-gray-500">Be the first to review this product</p>
            </div>
          )}
        </div>
      )}

      {activeTab === "recommendations" && (
        <div>
          <h3 className="font-bold text-lg mb-4">Recommendations</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {recommendations.length > 0 ? (
              recommendations.map((product) => (
                <Link
                  key={product.id}
                  href={`/product/${product.slug}`}
                  className="group"
                >
                  <div className="relative aspect-[3/4] rounded-lg overflow-hidden bg-gray-100 mb-2">
                    <Image
                      src={product.image}
                      alt={product.title}
                      fill
                      className="object-cover group-hover:scale-105 transition-transform"
                    />
                    {product.badge && (
                      <span className="absolute top-2 left-2 bg-[#e31e24] text-white text-xs px-2 py-0.5 rounded">
                        {product.badge}
                      </span>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-black/70 text-white text-center py-2 text-sm font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                      QUICK SHOP
                    </div>
                  </div>
                  <h4 className="text-sm text-gray-700 line-clamp-2">
                    {product.title}
                  </h4>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="font-bold text-gray-900">${product.price.toFixed(2)}</span>
                    {product.originalPrice && (
                      <span className="text-xs text-gray-400 line-through">
                        ${product.originalPrice.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 mt-1">
                    {(() => {
                      const rating = normalizeDisplayedRating(product.displayed_rating);
                      return (
                        <>
                          {[...Array(5)].map((_, i) => (
                            <Star
                              key={i}
                              className={`w-3 h-3 ${
                                i < Math.floor(rating)
                                  ? "fill-amber-400 text-amber-400"
                                  : "fill-gray-200 text-gray-200"
                              }`}
                            />
                          ))}
                          <span className="text-xs text-gray-500">{rating.toFixed(1)}</span>
                        </>
                      );
                    })()}
                  </div>
                </Link>
              ))
            ) : (
              <p className="text-gray-500 col-span-full">No recommendations available yet.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
