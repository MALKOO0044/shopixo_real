const crypto = require('crypto')

const VALID_MEDIA_TYPES = new Set(['image', 'video'])

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
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

  return crypto
    .createHmac('sha256', secret)
    .update(`${assetKey}|${mediaType}|${sourceUrl}`)
    .digest('hex')
}

function resolveAssetKey(req) {
  if (req.query && typeof req.query.assetKey === 'string') {
    return req.query.assetKey
  }

  const fallbackPath = String(req.url || '').split('?')[0]
  const parts = fallbackPath.split('/').filter(Boolean)
  const raw = parts[parts.length - 1] || ''

  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return sendJson(res, 405, {
      error: 'Method not allowed. Use GET or HEAD.',
      code: 'METHOD_NOT_ALLOWED',
    })
  }

  const assetKey = String(resolveAssetKey(req) || '').trim()
  const mediaType = String(req.query?.mediaType || '').trim().toLowerCase()
  const sourceUrl = String(req.query?.src || '').trim()
  const providedSignature = String(req.query?.sig || '').trim()

  if (!assetKey || !sourceUrl || !VALID_MEDIA_TYPES.has(mediaType)) {
    return sendJson(res, 400, {
      error: 'Missing required parameters. Expected asset key path, src, and mediaType.',
      code: 'INVALID_RUNTIME_ASSET_REQUEST',
    })
  }

  if (!isHttpUrl(sourceUrl)) {
    return sendJson(res, 400, {
      error: 'src must be an absolute http(s) URL.',
      code: 'INVALID_SOURCE_URL',
    })
  }

  if (mediaType === 'video' && !parseBooleanEnv(process.env.AI_MEDIA_RUNTIME_ENABLE_VIDEO, false)) {
    return sendJson(res, 503, {
      error: 'Runtime video access is disabled for phase-1 image stabilization.',
      code: 'RUNTIME_VIDEO_DISABLED',
    })
  }

  const expectedSignature = buildAssetSignature(assetKey, mediaType, sourceUrl)
  if (expectedSignature && !secureTokenEqual(providedSignature, expectedSignature)) {
    return sendJson(res, 403, {
      error: 'Invalid runtime asset signature.',
      code: 'INVALID_RUNTIME_ASSET_SIGNATURE',
    })
  }

  res.statusCode = 307
  res.setHeader('Location', sourceUrl)
  res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=600, stale-while-revalidate=300')
  res.end()
}
