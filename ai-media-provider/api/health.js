function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return sendJson(res, 405, {
      error: 'Method not allowed. Use GET.',
      code: 'METHOD_NOT_ALLOWED',
    })
  }

  const hasProviderToken = Boolean(String(process.env.AI_MEDIA_INTERNAL_PROVIDER_TOKEN || '').trim())
  const hasRuntimeBackendUrl = Boolean(String(process.env.AI_MEDIA_RUNTIME_BACKEND_URL || '').trim())
  const hasRuntimeBackendToken = Boolean(String(process.env.AI_MEDIA_RUNTIME_BACKEND_TOKEN || '').trim())
  const ready = hasProviderToken && hasRuntimeBackendUrl

  return sendJson(res, 200, {
    ok: ready,
    service: 'ai-media-provider',
    mode: hasRuntimeBackendUrl ? 'proxy_to_runtime_backend' : 'runtime_backend_missing',
    checks: {
      providerTokenConfigured: hasProviderToken,
      runtimeBackendUrlConfigured: hasRuntimeBackendUrl,
      runtimeBackendTokenConfigured: hasRuntimeBackendToken,
    },
    timestamp: new Date().toISOString(),
  })
}
