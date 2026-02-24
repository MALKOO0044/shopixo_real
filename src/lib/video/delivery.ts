import { inferCjVideoQualityHint, normalizeCjVideoUrl, type CjVideoQualityHint } from '@/lib/cj/video';

export type VideoDeliveryMode = 'native' | 'enhanced' | 'passthrough';

export type VideoDeliveryResult = {
  sourceUrl?: string;
  deliveryUrl?: string;
  mode: VideoDeliveryMode;
  sourceQualityHint: CjVideoQualityHint;
  qualityGatePassed: boolean;
};

const FOUR_K_TRANSFORM = 'f_mp4,vc_h264,ac_aac,q_auto:best,c_limit,w_3840,h_2160';

function getCloudinaryCloudName(): string | undefined {
  const fromPublic = String(process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || '').trim();
  if (fromPublic) return fromPublic;

  const fromServer = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  return fromServer || undefined;
}

function isCloudinaryVideoUrl(url: string): boolean {
  return url.includes('res.cloudinary.com') && (url.includes('/video/upload/') || url.includes('/video/fetch/'));
}

export function requiresVideoForMediaMode(mediaMode: unknown): boolean {
  const mode = String(mediaMode || '').trim();
  return mode === 'withVideo' || mode === 'both';
}

export function looksLike4kDelivery(value: unknown): boolean {
  const normalized = normalizeCjVideoUrl(value);
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  return /(w_3840|h_2160|w_4096|2160p|\b4k\b|3840x2160|4096x2160|_2160|_4k)/.test(lower);
}

function ensureCloudinary4kTransform(url: string): string {
  if (!isCloudinaryVideoUrl(url)) return url;
  if (looksLike4kDelivery(url)) return url;

  const marker = url.includes('/video/upload/') ? '/video/upload/' : '/video/fetch/';
  const markerIndex = url.indexOf(marker);
  if (markerIndex < 0) return url;

  const before = url.slice(0, markerIndex + marker.length);
  const after = url.slice(markerIndex + marker.length);
  return `${before}${FOUR_K_TRANSFORM}/${after}`;
}

function buildCloudinaryFetch4kUrl(sourceUrl: string, cloudName: string): string {
  if (isCloudinaryVideoUrl(sourceUrl)) {
    return ensureCloudinary4kTransform(sourceUrl);
  }

  return `https://res.cloudinary.com/${cloudName}/video/fetch/${FOUR_K_TRANSFORM}/${encodeURIComponent(sourceUrl)}`;
}

export function build4kVideoDelivery(source: unknown): VideoDeliveryResult {
  const sourceUrl = normalizeCjVideoUrl(source) || undefined;
  if (!sourceUrl) {
    return {
      sourceUrl: undefined,
      deliveryUrl: undefined,
      mode: 'passthrough',
      sourceQualityHint: 'unknown',
      qualityGatePassed: false,
    };
  }

  const sourceQualityHint = inferCjVideoQualityHint(sourceUrl);

  if (sourceQualityHint === '4k') {
    return {
      sourceUrl,
      deliveryUrl: sourceUrl,
      mode: 'native',
      sourceQualityHint,
      qualityGatePassed: true,
    };
  }

  const cloudName = getCloudinaryCloudName();
  if (cloudName) {
    const deliveryUrl = buildCloudinaryFetch4kUrl(sourceUrl, cloudName);
    return {
      sourceUrl,
      deliveryUrl,
      mode: 'enhanced',
      sourceQualityHint,
      qualityGatePassed: looksLike4kDelivery(deliveryUrl),
    };
  }

  return {
    sourceUrl,
    deliveryUrl: sourceUrl,
    mode: 'passthrough',
    sourceQualityHint,
    qualityGatePassed: false,
  };
}

export function buildStorefrontVideoUrl(source: unknown): string | undefined {
  return build4kVideoDelivery(source).deliveryUrl;
}
