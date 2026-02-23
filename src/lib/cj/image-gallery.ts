const NON_PRODUCT_IMAGE_RE = /(sprite|icon|favicon|logo|placeholder|blank|loading|alipay|wechat|whatsapp|kefu|service|avatar|thumb|thumbnail|small|tiny|mini|sizechart|size\s*chart|chart|table|guide|tips|hot|badge|flag|promo|banner|sale|discount|qr)/i;
const IMAGE_KEY_SIZE_TOKEN_RE = /[_-](\d{2,4})x(\d{2,4})(?=\.)/gi;
const INLINE_SIZE_TOKEN_RE = /[_-](\d{2,4})x(\d{2,4})(?=(?:\.|[_?&#]))/i;

function normalizeImageUrl(url: string): string {
  const raw = String(url || '').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return raw;
  }
}

function parseJsonArrayString(value: string): unknown[] {
  const text = value.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return [];

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractUrlsFromUnknown(value: unknown): string[] {
  if (value == null) return [];

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];

    const parsedArray = parseJsonArrayString(text);
    if (parsedArray.length > 0) {
      return parsedArray.flatMap((entry) => extractUrlsFromUnknown(entry));
    }

    if (/[;,|\n\r\t]+/.test(text) && text.includes('http')) {
      return text
        .split(/[;,|\n\r\t]+/)
        .map((part) => part.trim())
        .filter(Boolean);
    }

    return [text];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractUrlsFromUnknown(entry));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const candidateFields = [
      obj.url,
      obj.src,
      obj.image,
      obj.imageUrl,
      obj.imgUrl,
      obj.big,
      obj.origin,
      obj.bigImage,
      obj.mainImage,
      obj.originImage,
      obj.whiteImage,
      obj.variantImage,
      obj.attributeImage,
      obj.skuImage,
      obj.propImage,
      obj.optionImage,
      obj.pic,
      obj.picture,
      obj.photo,
    ];

    return candidateFields.flatMap((entry) => extractUrlsFromUnknown(entry));
  }

  return [];
}

function isLikelySmallImage(url: string): boolean {
  const sizeToken = url.match(INLINE_SIZE_TOKEN_RE);
  if (sizeToken) {
    const width = Number(sizeToken[1]);
    const height = Number(sizeToken[2]);
    if (Number.isFinite(width) && Number.isFinite(height) && Math.max(width, height) < 320) {
      return true;
    }
  }

  const querySizes = Array.from(url.matchAll(/[?&](?:w|width|h|height)=(\d{2,4})/gi))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  if (querySizes.length > 0 && Math.max(...querySizes) < 320) {
    return true;
  }

  return false;
}

function scoreImageQuality(url: string, index: number): number {
  const lower = url.toLowerCase();
  let score = 50 - Math.min(15, index * 0.35);

  if (/(\/original\/|\/big\/|\/large\/|highres|master)/i.test(lower)) score += 18;
  if (/(?:^|[^\d])(2048|1920|1600|1500|1440|1280|1200|1080|1000|900|800)x(?:2048|1920|1600|1500|1440|1280|1200|1080|1000|900|800)(?:[^\d]|$)/i.test(lower)) score += 16;
  if (/_1600|_1500|_1400|_1200|_1080|_1000|_900|_800|1600x|1500x|1400x|1200x|1080x|1000x|900x|800x/i.test(lower)) score += 14;
  if (/_700|_600|700x|600x/i.test(lower)) score += 8;

  const sizeToken = lower.match(INLINE_SIZE_TOKEN_RE);
  if (sizeToken) {
    const width = Number(sizeToken[1]);
    const height = Number(sizeToken[2]);
    const maxDim = Math.max(width, height);
    if (Number.isFinite(maxDim)) {
      if (maxDim >= 1000) score += 10;
      else if (maxDim >= 700) score += 4;
      else if (maxDim < 320) score -= 35;
    }
  }

  const querySizes = Array.from(lower.matchAll(/[?&](?:w|width|h|height)=(\d{2,4})/gi))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  if (querySizes.length > 0) {
    const maxQuerySize = Math.max(...querySizes);
    if (maxQuerySize >= 1000) score += 8;
    else if (maxQuerySize < 320) score -= 30;
  }

  if (/(thumb|thumbnail|tiny|mini)/i.test(lower)) score -= 30;
  if (/(detail|closeup|close-up)/i.test(lower)) score -= 4;

  return score;
}

export function normalizeCjImageKey(url: string): string {
  const normalizedUrl = normalizeImageUrl(url).toLowerCase();
  if (!normalizedUrl) return '';

  try {
    const parsed = new URL(normalizedUrl);
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(IMAGE_KEY_SIZE_TOKEN_RE, '');
    return parsed.toString();
  } catch {
    return normalizedUrl
      .replace(/[?#].*$/, '')
      .replace(IMAGE_KEY_SIZE_TOKEN_RE, '');
  }
}

export function prioritizeCjHeroImage(images: string[]): string[] {
  if (!Array.isArray(images) || images.length <= 1) return Array.isArray(images) ? images : [];

  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < images.length; i += 1) {
    const score = scoreImageQuality(images[i], i);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex === 0) return images;

  const hero = images[bestIndex];
  return [hero, ...images.filter((_, index) => index !== bestIndex)];
}

export function extractCjProductGalleryImages(item: any, maxImages: number = 50): string[] {
  if (!item || typeof item !== 'object') return [];

  const candidates: string[] = [];
  const pushValue = (value: unknown) => {
    const urls = extractUrlsFromUnknown(value);
    for (const raw of urls) {
      const normalized = normalizeImageUrl(raw);
      if (normalized) candidates.push(normalized);
    }
  };

  const mainFields = ['productImage', 'bigImage', 'image', 'mainImage', 'mainImageUrl', 'productImageSet'] as const;
  for (const field of mainFields) {
    pushValue(item[field]);
  }

  const arrayFields = ['productImageSet', 'imageList', 'productImageList', 'detailImageList', 'variantImageList', 'pictureList', 'productImages'] as const;
  for (const field of arrayFields) {
    pushValue(item[field]);
  }

  const stringFields = ['images', 'imageUrls', 'images2'] as const;
  for (const field of stringFields) {
    pushValue(item[field]);
  }

  const propertyList = item.productPropertyList || item.propertyList || item.productOptions || [];
  if (Array.isArray(propertyList)) {
    for (const property of propertyList) {
      pushValue(property?.image || property?.imageUrl || property?.propImage || property?.optionImage);
      const propertyValues = property?.propertyValueList || property?.values || property?.options || [];
      if (Array.isArray(propertyValues)) {
        for (const value of propertyValues) {
          pushValue(value?.image || value?.imageUrl || value?.propImage || value?.bigImage);
        }
      }
    }
  }

  const variantList = item.variantList || item.skuList || item.variants || [];
  if (Array.isArray(variantList)) {
    for (const variant of variantList) {
      pushValue([
        variant?.whiteImage,
        variant?.image,
        variant?.imageUrl,
        variant?.imgUrl,
        variant?.variantImage,
        variant?.attributeImage,
        variant?.skuImage,
        variant?.bigImage,
        variant?.originImage,
        variant?.mainImage,
      ]);

      const variantImages = variant?.variantImageList || variant?.skuImageList || variant?.imageList || [];
      pushValue(variantImages);

      const variantProps = variant?.variantPropertyList || variant?.propertyList || variant?.properties || [];
      pushValue(variantProps);
    }
  }

  const visited = new WeakSet<object>();
  const deepScan = (value: unknown, depth: number = 0) => {
    if (depth > 3 || !value || typeof value !== 'object') return;

    const obj = value as Record<string, unknown>;
    if (visited.has(obj)) return;
    visited.add(obj);

    for (const [key, entry] of Object.entries(obj)) {
      if (/image|img|photo|pic/i.test(key)) {
        pushValue(entry);
      }

      if (Array.isArray(entry)) {
        for (const nested of entry) {
          deepScan(nested, depth + 1);
        }
      } else if (entry && typeof entry === 'object') {
        deepScan(entry, depth + 1);
      }
    }
  };

  deepScan(item);

  const filtered: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate || !/^https?:\/\//i.test(candidate)) continue;
    if (NON_PRODUCT_IMAGE_RE.test(candidate)) continue;
    if (isLikelySmallImage(candidate)) continue;

    const key = normalizeCjImageKey(candidate);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    filtered.push(candidate);
  }

  if (filtered.length === 0) {
    for (const candidate of candidates) {
      if (!candidate || !/^https?:\/\//i.test(candidate)) continue;
      if (NON_PRODUCT_IMAGE_RE.test(candidate)) continue;

      const key = normalizeCjImageKey(candidate);
      if (!key || seen.has(key)) continue;

      seen.add(key);
      filtered.push(candidate);
      if (filtered.length >= maxImages) break;
    }
  }

  return prioritizeCjHeroImage(filtered).slice(0, Math.max(1, maxImages));
}
