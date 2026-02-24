const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|m3u8|avi|mkv|ogv)(?:[?#].*)?$/i
const VIDEO_HOST_HINT_RE = /(video|vod|stream|play|media|cdn)/i
const VIDEO_PATH_HINT_RE = /(?:^|\/)(video|videos|vod|media|stream)(?:\/|$)/i
const LOW_QUALITY_HINT_RE = /(\b360p\b|\b480p\b|_360|_480|[?&](?:w|width)=(?:3\d\d|4\d\d))/i
const HD_QUALITY_HINT_RE = /(\b720p\b|\b1080p\b|_720|_1080|1920x1080|1080x1920|[?&](?:w|width)=(?:7\d\d|8\d\d|9\d\d|10\d\d))/i
const UHD_QUALITY_HINT_RE = /(\b2k\b|\b4k\b|\b2160p\b|3840x2160|4096x2160|_2160|_4k|[?&](?:w|width)=(?:2\d\d\d|3\d\d\d|4\d\d\d))/i

export type CjVideoQualityHint = '4k' | 'hd' | 'sd' | 'unknown'

function parseJsonArrayMaybe(value: string): unknown[] {
  const text = String(value || '').trim()
  if (!text.startsWith('[') || !text.endsWith(']')) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseJsonObjectMaybe(value: string): Record<string, unknown> | null {
  const text = String(value || '').trim()
  if (!text.startsWith('{') || !text.endsWith('}')) return null
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function normalizeComparableUrl(value: string): string {
  try {
    const parsed = new URL(value)
    parsed.hash = ''
    parsed.search = ''
    return `${parsed.origin}${parsed.pathname}`.toLowerCase()
  } catch {
    return value.split('#')[0].split('?')[0].toLowerCase()
  }
}

function collectUrlsFromUnknown(value: unknown): string[] {
  if (!value) return []

  if (typeof value === 'string') {
    const raw = value.trim()
    if (!raw) return []

    const parsedArray = parseJsonArrayMaybe(raw)
    if (parsedArray.length > 0) {
      return parsedArray.flatMap((entry) => collectUrlsFromUnknown(entry))
    }

    const parsedObject = parseJsonObjectMaybe(raw)
    if (parsedObject) {
      return collectUrlsFromUnknown(parsedObject)
    }

    if (/[;,|\n\r\t]+/.test(raw) && raw.includes('http')) {
      return raw
        .split(/[;,|\n\r\t]+/)
        .map((part) => part.trim())
        .filter(Boolean)
    }

    return [raw]
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectUrlsFromUnknown(entry))
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const candidates = [
      obj.url,
      obj.src,
      obj.videoUrl,
      obj.video_url,
      obj.video,
      obj.videoSource,
      obj.videoSrc,
      obj.videoPath,
      obj.videoPlayUrl,
      obj.coverVideo,
      obj.coverVideoUrl,
      obj.productVideo,
      obj.productVideoUrl,
      obj.mainVideo,
      obj.masterVideo,
      obj.materialVideo,
      obj.playUrl,
      obj.playURL,
      obj.mediaUrl,
      obj.mediaURL,
      obj.mp4,
      obj.mov,
      obj.m4v,
      obj.m3u8,
      obj.hls,
      obj.file,
      obj.path,
      obj.outputUrl,
    ]
    return candidates.flatMap((entry) => collectUrlsFromUnknown(entry))
  }

  return []
}

export function normalizeCjVideoUrl(value: unknown): string | null {
  const raw = String(value || '').replace(/&amp;/g, '&').trim()
  if (!raw) return null

  if (raw.startsWith('data:video/')) return raw

  let candidate = raw
  if (candidate.startsWith('//')) candidate = `https:${candidate}`
  if (candidate.startsWith('http://')) candidate = `https://${candidate.slice('http://'.length)}`

  try {
    const parsed = new URL(candidate)
    if (!/^https?:$/i.test(parsed.protocol)) return null
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

export function isLikelyCjVideoUrl(value: unknown): boolean {
  const normalized = normalizeCjVideoUrl(value)
  if (!normalized) return false
  if (/^data:video\//i.test(normalized)) return true

  const lower = normalized.toLowerCase()
  if (VIDEO_EXT_RE.test(lower)) return true

  try {
    const parsed = new URL(lower)
    const pathname = parsed.pathname || ''
    if (VIDEO_PATH_HINT_RE.test(pathname)) return true
    if (VIDEO_HOST_HINT_RE.test(parsed.hostname)) {
      if (pathname.includes('.mp4') || pathname.includes('.m3u8')) return true
      if (/(^|[?&])(format|type)=video/i.test(parsed.search)) return true
    }
  } catch {
    // ignore
  }

  return false
}

export function inferCjVideoQualityHint(value: unknown): CjVideoQualityHint {
  const normalized = normalizeCjVideoUrl(value)
  if (!normalized) return 'unknown'
  const lower = normalized.toLowerCase()

  if (UHD_QUALITY_HINT_RE.test(lower)) return '4k'
  if (HD_QUALITY_HINT_RE.test(lower)) return 'hd'
  if (LOW_QUALITY_HINT_RE.test(lower)) return 'sd'
  return 'unknown'
}

function scoreVideoCandidate(url: string, index: number): number {
  const lower = url.toLowerCase()
  let score = 100 - Math.min(30, index)

  if (UHD_QUALITY_HINT_RE.test(lower)) score += 40
  else if (HD_QUALITY_HINT_RE.test(lower)) score += 20
  else if (LOW_QUALITY_HINT_RE.test(lower)) score -= 35

  if (/\.(mp4|mov|m4v)(?:[?#].*)?$/i.test(lower)) score += 12
  if (/\.(m3u8|webm|ogv)(?:[?#].*)?$/i.test(lower)) score += 8
  if (/(preview|sample|demo|thumbnail|thumb)/i.test(lower)) score -= 25

  return score
}

export function extractCjProductVideoCandidates(item: unknown, maxVideos: number = 12): string[] {
  if (!item || typeof item !== 'object') return []

  const source = item as Record<string, unknown>
  const candidates: string[] = []
  const seen = new Set<string>()

  const push = (value: unknown) => {
    const urls = collectUrlsFromUnknown(value)
    for (const url of urls) {
      const normalized = normalizeCjVideoUrl(url)
      if (!normalized) continue
      if (!isLikelyCjVideoUrl(normalized)) continue
      const key = normalizeComparableUrl(normalized)
      if (!key || seen.has(key)) continue
      seen.add(key)
      candidates.push(normalized)
      if (candidates.length >= maxVideos) return
    }
  }

  push(source.videoUrl)
  push(source.video)
  push(source.productVideo)
  push(source.videoPlayUrl)
  push(source.playUrl)
  push(source.playURL)
  push(source.videoHdUrl)
  push(source.video4kUrl)
  push(source.videoList)
  push(source.videos)
  push(source.media)

  const visited = new WeakSet<object>()
  const deepScan = (value: unknown, depth: number = 0) => {
    if (depth > 3 || !value || typeof value !== 'object') return

    const obj = value as Record<string, unknown>
    if (visited.has(obj)) return
    visited.add(obj)

    for (const [key, entry] of Object.entries(obj)) {
      if (/video|mp4|mov|m4v|m3u8|playurl|mediaurl|stream|playback|hls/i.test(key)) {
        push(entry)
      }

      if (Array.isArray(entry)) {
        for (const nested of entry) {
          deepScan(nested, depth + 1)
        }
      } else if (entry && typeof entry === 'object') {
        deepScan(entry, depth + 1)
      }

      if (candidates.length >= maxVideos) return
    }
  }

  deepScan(source)

  return candidates
    .map((url, index) => ({ url, score: scoreVideoCandidate(url, index) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.url)
    .slice(0, maxVideos)
}

export function extractCjProductVideoUrl(item: unknown): string | undefined {
  const list = extractCjProductVideoCandidates(item, 1)
  return list[0]
}
