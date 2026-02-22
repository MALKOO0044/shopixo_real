const crypto = require('crypto')

const DEFAULT_VIDEO_URL =
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'

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

function toSafeSeedPart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function buildImageUrl(payload) {
  const width = Number(payload?.width)
  const height = Number(payload?.height)
  const safeWidth = Number.isFinite(width) && width > 0 ? Math.min(Math.round(width), 4096) : 2048
  const safeHeight = Number.isFinite(height) && height > 0 ? Math.min(Math.round(height), 4096) : 2048

  const seedParts = [
    toSafeSeedPart(payload?.cjProductId) || 'product',
    toSafeSeedPart(payload?.color) || 'color',
    toSafeSeedPart(payload?.mediaIndex) || '1',
    Date.now().toString(36),
  ]

  const seed = encodeURIComponent(seedParts.join('-'))
  return `https://picsum.photos/seed/${seed}/${safeWidth}/${safeHeight}.jpg`
}

function buildVideoUrl(payload) {
  const seed = encodeURIComponent(
    [
      toSafeSeedPart(payload?.cjProductId) || 'product',
      toSafeSeedPart(payload?.color) || 'color',
      toSafeSeedPart(payload?.mediaIndex) || '1',
    ].join('-')
  )

  return `${DEFAULT_VIDEO_URL}?v=${seed}`
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return sendJson(res, 405, {
      error: 'Method not allowed. Use POST.',
      code: 'METHOD_NOT_ALLOWED',
    })
  }

  const expectedToken = String(process.env.AI_MEDIA_INTERNAL_PROVIDER_TOKEN || '').trim()
  if (!expectedToken) {
    return sendJson(res, 500, {
      error: 'Provider token is not configured on service.',
      code: 'PROVIDER_TOKEN_MISSING',
    })
  }

  const authHeader = String(req.headers.authorization || '').trim()
  const providedToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : ''

  if (!secureTokenEqual(providedToken, expectedToken)) {
    return sendJson(res, 401, {
      error: 'Invalid or missing bearer token.',
      code: 'UNAUTHORIZED',
    })
  }

  const payload = await parseRequestBody(req)
  if (!payload || typeof payload !== 'object') {
    return sendJson(res, 400, {
      error: 'Invalid JSON payload.',
      code: 'INVALID_JSON',
    })
  }

  const mediaType = String(payload.mediaType || '').trim().toLowerCase()
  if (mediaType !== 'image' && mediaType !== 'video') {
    return sendJson(res, 400, {
      error: 'mediaType must be image or video.',
      code: 'INVALID_MEDIA_TYPE',
    })
  }

  const outputUrl = mediaType === 'video' ? buildVideoUrl(payload) : buildImageUrl(payload)

  return sendJson(res, 200, {
    outputUrl,
    provider: 'internal_microservice',
    assetId: `mock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    meta: {
      traceId: crypto.randomUUID(),
      mode: 'starter_mock_provider',
      mediaType,
    },
  })
}
