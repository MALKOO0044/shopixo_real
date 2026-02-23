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

function isRecursiveGenerateTarget(req, runtimeBackendUrl) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase()

  if (!host || !runtimeBackendUrl) return false

  try {
    const runtimeUrl = new URL(runtimeBackendUrl)
    if (runtimeUrl.host.toLowerCase() !== host) return false

    const normalizedPath = runtimeUrl.pathname.replace(/\/+$/, '').toLowerCase() || '/'
    return normalizedPath === '/generate' || normalizedPath === '/api/generate'
  } catch {
    return false
  }
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

function resolveRuntimeBackendUrl() {
  return String(
    process.env.AI_MEDIA_RUNTIME_BACKEND_URL ||
      process.env.AI_MEDIA_UPSTREAM_URL ||
      process.env.AI_MEDIA_BACKEND_URL ||
      ''
  ).trim()
}

function isSameHostRuntimeTarget(req, runtimeBackendUrl) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase()

  if (!host || !runtimeBackendUrl) return false

  try {
    const runtimeUrl = new URL(runtimeBackendUrl)
    return runtimeUrl.host.toLowerCase() === host
  } catch {
    return false
  }
}

async function parseBackendBody(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  if (contentType.includes('application/json')) {
    try {
      return await response.json()
    } catch {
      return null
    }
  }

  try {
    return await response.text()
  } catch {
    return null
  }
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
  if (!VALID_MEDIA_TYPES.has(mediaType)) {
    return sendJson(res, 400, {
      error: 'mediaType must be image or video.',
      code: 'INVALID_MEDIA_TYPE',
    })
  }

  if (mediaType === 'video' && !parseBooleanEnv(process.env.AI_MEDIA_ENABLE_VIDEO_GENERATION, false)) {
    return sendJson(res, 503, {
      error: 'Video generation is temporarily disabled until strict image fidelity is stable.',
      code: 'VIDEO_GENERATION_DISABLED',
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

  const runtimeBackendUrl = resolveRuntimeBackendUrl()
  if (!runtimeBackendUrl) {
    return sendJson(res, 503, {
      error:
        'Runtime generation backend is not configured. Set AI_MEDIA_RUNTIME_BACKEND_URL (or AI_MEDIA_UPSTREAM_URL) on the provider service.',
      code: 'RUNTIME_BACKEND_NOT_CONFIGURED',
      meta: {
        mode: renderMode,
        sourceViewTag,
        requestedViewTag,
      },
    })
  }

  if (isRecursiveGenerateTarget(req, runtimeBackendUrl)) {
    return sendJson(res, 503, {
      error:
        'Invalid runtime backend URL configuration. AI_MEDIA_RUNTIME_BACKEND_URL must not point to /generate on this same provider service.',
      code: 'RUNTIME_BACKEND_RECURSIVE_CONFIG',
      meta: {
        runtimeBackendUrl,
      },
    })
  }

  const runtimeBackendToken = String(
    process.env.AI_MEDIA_RUNTIME_BACKEND_TOKEN || process.env.AI_MEDIA_UPSTREAM_TOKEN || ''
  ).trim()
  const internalBootstrapToken = isSameHostRuntimeTarget(req, runtimeBackendUrl)
    ? String(process.env.AI_MEDIA_INTERNAL_PROVIDER_TOKEN || '').trim()
    : ''
  const runtimeToken = runtimeBackendToken || internalBootstrapToken
  const runtimeHeaders = {
    'Content-Type': 'application/json',
  }
  if (runtimeToken) {
    runtimeHeaders.Authorization = `Bearer ${runtimeToken}`
  }

  const traceId = crypto.randomUUID()
  const proxyPayload = {
    ...payload,
    renderMode,
    sourceViewTag,
    requestedViewTag,
    allowedViews,
    strictFidelity: true,
    traceId,
  }

  let backendResponse
  try {
    backendResponse = await fetch(runtimeBackendUrl, {
      method: 'POST',
      headers: runtimeHeaders,
      body: JSON.stringify(proxyPayload),
    })
  } catch (error) {
    return sendJson(res, 503, {
      error: `Runtime backend request failed: ${String(error?.message || error || 'unknown error')}`,
      code: 'RUNTIME_BACKEND_UNREACHABLE',
      meta: {
        traceId,
        mode: renderMode,
        requestedViewTag,
      },
    })
  }

  const backendBody = await parseBackendBody(backendResponse)
  if (!backendResponse.ok) {
    const errorMessage =
      typeof backendBody === 'string'
        ? backendBody
        : String(backendBody?.error || `Runtime backend failed with status ${backendResponse.status}`)

    return sendJson(res, 502, {
      error: errorMessage,
      code: 'RUNTIME_BACKEND_ERROR',
      meta: {
        traceId,
        mode: renderMode,
        requestedViewTag,
        status: backendResponse.status,
      },
    })
  }

  const outputUrl = String(backendBody?.outputUrl || backendBody?.url || '').trim()
  if (!/^https?:\/\//i.test(outputUrl)) {
    return sendJson(res, 502, {
      error: 'Runtime backend returned success without a valid outputUrl.',
      code: 'RUNTIME_BACKEND_INVALID_RESPONSE',
      meta: {
        traceId,
        mode: renderMode,
      },
    })
  }

  const backendMeta = backendBody?.meta && typeof backendBody.meta === 'object' ? backendBody.meta : {}
  const responseMode = normalizeRenderMode(backendMeta.mode || backendBody.mode || renderMode)
  const responseViewTag = normalizeViewTag(
    backendMeta.viewTag || backendBody.viewTag || requestedViewTag || sourceViewTag
  )
  const responseAssetId = String(backendBody?.assetId || '').trim()

  return sendJson(res, 200, {
    outputUrl,
    provider: String(backendBody?.provider || 'internal_runtime_proxy'),
    assetId:
      responseAssetId ||
      `runtime_${toSafeSeedPart(payload?.cjProductId || 'product')}_${Date.now().toString(36)}`,
    meta: {
      traceId,
      mode: responseMode,
      viewTag: responseViewTag,
      requestedViewTag,
      sourceViewTag,
      allowedViews,
      mediaType,
      backendStatus: backendResponse.status,
    },
  })
}
