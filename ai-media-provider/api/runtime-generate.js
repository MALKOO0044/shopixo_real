const crypto = require('crypto')

const VALID_MEDIA_TYPES = new Set(['image', 'video'])
const VALID_RENDER_MODES = new Set([
  'background_only_preserve_product',
  'pose_aware_model_wear',
])
const VALID_VIEW_TAGS = new Set(['front', 'back', 'side', 'detail', 'unknown'])

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

async function parseRequestBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body
  }

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body)
    } catch {
      return null
    }
  }

  if (Buffer.isBuffer(req.body)) {
    const rawBufferBody = req.body.toString('utf8').trim()
    if (!rawBufferBody) return {}
    try {
      return JSON.parse(rawBufferBody)
    } catch {
      return null
    }
  }

  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim()
  if (!rawBody) return {}

  try {
    return JSON.parse(rawBody)
  } catch {
    return null
  }
}

function secureTokenEqual(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function parseBooleanEnv(value, fallback = false) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return fallback
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false
  }
  return fallback
}

function normalizeRenderMode(value, fallback = 'background_only_preserve_product') {
  const mode = String(value || '').trim()
  if (VALID_RENDER_MODES.has(mode)) return mode
  return fallback
}

function normalizeViewTag(value) {
  const tag = String(value || '').trim().toLowerCase()
  if (VALID_VIEW_TAGS.has(tag)) return tag
  return 'unknown'
}

function normalizeAllowedViews(input, fallbackView) {
  if (!Array.isArray(input)) return [fallbackView]

  const out = []
  const seen = new Set()
  for (const raw of input) {
    const tag = normalizeViewTag(raw)
    if (tag === 'unknown') continue
    if (seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }

  if (out.length > 0) return out
  return [fallbackView]
}

function toSafeSeedPart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function getRequestOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  if (!host) return ''

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
  const proto = forwardedProto || 'https'
  return `${proto}://${host}`
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim())
}

function getAssetSignSecret() {
  return String(
    process.env.AI_MEDIA_RUNTIME_ASSET_SECRET ||
      process.env.AI_MEDIA_RUNTIME_BACKEND_TOKEN ||
      process.env.AI_MEDIA_INTERNAL_PROVIDER_TOKEN ||
      ''
  ).trim()
}

function buildAssetSignature(assetKey, mediaType, sourceUrl) {
  const secret = getAssetSignSecret()
  if (!secret) return ''

  const payload = `${assetKey}|${mediaType}|${sourceUrl}`
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
}

function buildAssetOutputUrl(req, input) {
  const origin = getRequestOrigin(req)
  if (!origin) return ''

  const search = new URLSearchParams({
    src: input.sourceUrl,
    mediaType: input.mediaType,
    sig: buildAssetSignature(input.assetKey, input.mediaType, input.sourceUrl),
  })

  return `${origin}/runtime-asset/${encodeURIComponent(input.assetKey)}?${search.toString()}`
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return sendJson(res, 405, {
      error: 'Method not allowed. Use POST.',
      code: 'METHOD_NOT_ALLOWED',
    })
  }

  const expectedToken = String(
    process.env.AI_MEDIA_RUNTIME_BACKEND_TOKEN ||
      process.env.AI_MEDIA_UPSTREAM_TOKEN ||
      process.env.AI_MEDIA_INTERNAL_PROVIDER_TOKEN ||
      ''
  ).trim()
  if (expectedToken) {
    const authHeader = String(req.headers.authorization || '').trim()
    const providedToken = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : ''

    if (!secureTokenEqual(providedToken, expectedToken)) {
      return sendJson(res, 401, {
        error: 'Invalid or missing runtime backend bearer token.',
        code: 'UNAUTHORIZED_RUNTIME_BACKEND',
      })
    }
  }

  const payload = await parseRequestBody(req)
  if (!payload || typeof payload !== 'object') {
    return sendJson(res, 400, {
      error: 'Invalid JSON payload.',
      code: 'INVALID_JSON',
    })
  }

  const mediaType = String(payload.mediaType || '').trim().toLowerCase()
  if (!VALID_MEDIA_TYPES.has(mediaType)) {
    return sendJson(res, 400, {
      error: 'mediaType must be image or video.',
      code: 'INVALID_MEDIA_TYPE',
    })
  }

  if (mediaType === 'video' && !parseBooleanEnv(process.env.AI_MEDIA_RUNTIME_ENABLE_VIDEO, false)) {
    return sendJson(res, 503, {
      error: 'Runtime video generation is disabled for phase-1 image stabilization.',
      code: 'RUNTIME_VIDEO_DISABLED',
    })
  }

  const anchorImageUrl = String(payload.anchorImageUrl || '').trim()
  const sourceVideoUrl = String(payload.sourceVideoUrl || '').trim()
  const sourceUrl = mediaType === 'video' ? sourceVideoUrl : anchorImageUrl

  if (!isHttpUrl(sourceUrl)) {
    return sendJson(res, 400, {
      error: `Valid ${mediaType === 'video' ? 'sourceVideoUrl' : 'anchorImageUrl'} is required.`,
      code: 'MISSING_SOURCE_URL',
    })
  }

  const renderMode = normalizeRenderMode(payload.renderMode)
  const sourceViewTag = normalizeViewTag(payload.sourceViewTag)
  const requestedViewTag = normalizeViewTag(payload.requestedViewTag || sourceViewTag)
  const allowedViews = normalizeAllowedViews(payload.allowedViews, requestedViewTag)

  if (parseBooleanEnv(payload.enforceSourceViewOnly, true) && !allowedViews.includes(requestedViewTag)) {
    return sendJson(res, 400, {
      error: `Requested view "${requestedViewTag}" is not in allowed views [${allowedViews.join(', ')}].`,
      code: 'VIEW_CONSTRAINT_VIOLATION',
    })
  }

  const mediaIndex = Math.max(1, Math.floor(Number(payload.mediaIndex) || 1))
  const assetKey = [
    toSafeSeedPart(payload.cjProductId) || 'product',
    toSafeSeedPart(payload.color) || 'color',
    mediaType,
    String(mediaIndex),
    Date.now().toString(36),
    crypto.randomBytes(3).toString('hex'),
  ].join('-')

  const traceId = String(payload.traceId || crypto.randomUUID())

  const outputUrl = buildAssetOutputUrl(req, {
    assetKey,
    mediaType,
    sourceUrl,
  })

  if (!outputUrl) {
    return sendJson(res, 500, {
      error: 'Unable to resolve public request origin for runtime output URL.',
      code: 'RUNTIME_ORIGIN_RESOLUTION_FAILED',
    })
  }

  return sendJson(res, 200, {
    outputUrl,
    provider: 'internal_runtime_server',
    assetId: `runtime_${assetKey}`,
    meta: {
      traceId,
      mode: renderMode,
      viewTag: requestedViewTag,
      sourceViewTag,
      allowedViews,
      mediaType,
      pipeline: 'source_preserve_bootstrap',
      phase: 'image_stabilization',
    },
  })
}
