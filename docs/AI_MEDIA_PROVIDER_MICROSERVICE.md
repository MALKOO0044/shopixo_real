# AI Media Provider Microservice Contract (Option B)

This document defines the contract expected by Shopixo when `AI_MEDIA_PROVIDER_URL` points to your separate AI media microservice.

## 1) Security

Your provider endpoint must require bearer auth.

- Request header from Shopixo:
  - `Authorization: Bearer <AI_MEDIA_PROVIDER_TOKEN>`
- Recommended provider-side env:
  - `AI_MEDIA_INTERNAL_PROVIDER_TOKEN`

Reject missing or invalid tokens with `401`.

## 2) Endpoint

- Method: `POST`
- Path: `/generate` (recommended)
- Content-Type: `application/json`

Set `AI_MEDIA_PROVIDER_URL` to the full endpoint URL, for example:

```text
https://ai-media.your-company.com/generate
```

Provider now supports two runtime patterns:

1. **External runtime service** (recommended long-term):
   - `AI_MEDIA_RUNTIME_BACKEND_URL=https://<runtime-domain>/generate`
2. **Internal bootstrap runtime** (fast start, same provider project):
   - `AI_MEDIA_RUNTIME_BACKEND_URL=https://<provider-domain>/runtime-generate`

## 3) Request payload (sent by Shopixo)

```json
{
  "mediaType": "image",
  "cjProductId": "123456",
  "color": "Navy Blue",
  "mediaIndex": 1,
  "anchorImageUrl": "https://.../anchor.jpg",
  "sourceVideoUrl": "https://.../source.mp4",
  "renderMode": "background_only_preserve_product",
  "sourceViewTag": "front",
  "requestedViewTag": "front",
  "allowedViews": ["front", "back"],
  "enforceSourceViewOnly": true,
  "faceVisibilityPolicy": "half_face_allowed",
  "prompt": "...strict fidelity prompt...",
  "negativePrompt": "...",
  "width": 2048,
  "height": 2048,
  "strictFidelity": true
}
```

Notes:
- `mediaType` is `image` or `video`.
- `sourceVideoUrl` can be `null`.
- `prompt` already includes strict product fidelity rules.
- `renderMode`, `sourceViewTag`, and `requestedViewTag` are required for strict product-preserve compliance.
- `allowedViews` + `enforceSourceViewOnly=true` enforce source-view locking.

## 4) Success response contract

Return `200` with at least one of `url` or `outputUrl`:

```json
{
  "outputUrl": "https://cdn.your-company.com/generated/asset-001.jpg",
  "provider": "internal_microservice",
  "assetId": "gen_abc123",
  "meta": {
    "traceId": "trace-123",
    "latencyMs": 8420
  }
}
```

Shopixo reads:
- `url` or `outputUrl` (required)
- `provider` (optional)
- `assetId` (optional)
- `meta` (optional)

Runtime metadata should include at least:
- `meta.mode`
- `meta.viewTag`
- `meta.traceId`

## 5) Error response contract

For provider failures, return non-2xx with JSON:

```json
{
  "error": "human readable message",
  "code": "optional_machine_code"
}
```

Examples:
- `400` invalid input
- `401` invalid token
- `429` rate limited
- `503` temporary model backend unavailable

## 6) Operational defaults for launch

Recommended for your scale:
- `AI_MEDIA_QUALITY_PROFILE=balanced`
- balanced defaults in Shopixo:
  - 4 images per color
  - video disabled by default during stabilization
  - 2k resolution default

Provider-side defaults:
- `AI_MEDIA_RUNTIME_BACKEND_URL` **required** (real generation backend)
- `AI_MEDIA_ENABLE_VIDEO_GENERATION=false` unless your backend can reliably generate per-color videos
- `AI_MEDIA_RUNTIME_ENABLE_VIDEO=false` for bootstrap runtime image-first rollout
- `AI_MEDIA_RUNTIME_ASSET_SECRET=<long-random-secret>` to sign runtime asset URLs

## 7) Reliability knobs already supported by Shopixo

- `AI_MEDIA_PROVIDER_TIMEOUT_MS` (defaults to 120000)
- `AI_MEDIA_PROVIDER_RETRIES` (defaults to 1)

## 8) Validation that remains in Shopixo

Even if provider succeeds, Shopixo still performs:
- media-type mismatch rejection
- source-copy rejection
- duplicate output URL rejection
- strict fidelity scoring and rejection flow

So your microservice should prioritize correctness, but the store pipeline still enforces final quality gates.

## 9) Quick bootstrap if you do not have a provider project yet

This repository already includes a starter provider service at:

```text
ai-media-provider/
```

Deploy it as a separate Vercel project:

1. Vercel Dashboard -> Add New... -> Project
2. Import this same GitHub repository
3. Set **Root Directory** to `ai-media-provider`
4. Add env var in the provider project:
   - `AI_MEDIA_INTERNAL_PROVIDER_TOKEN=<your-shared-token>`
   - `AI_MEDIA_RUNTIME_BACKEND_URL=https://<provider-domain>/runtime-generate`
   - `AI_MEDIA_RUNTIME_ASSET_SECRET=<long-random-secret>`
   - Optional: `AI_MEDIA_RUNTIME_BACKEND_TOKEN=<runtime-backend-token>`
5. Deploy and copy provider domain
6. In your main `shopixo-only` project set:
   - `AI_MEDIA_PROVIDER_URL=https://<provider-domain>/generate`
   - `AI_MEDIA_PROVIDER_TOKEN=<same-shared-token>`

After this, redeploy both projects and retry AI media generation.

If `AI_MEDIA_RUNTIME_BACKEND_URL` is not set, the provider intentionally returns `503` with
`RUNTIME_BACKEND_NOT_CONFIGURED` to prevent accidental mock/random outputs.

## 10) Internal bootstrap runtime endpoints (included in `ai-media-provider`)

- `POST /runtime-generate`
  - Validates media/view payload and returns signed `outputUrl` for runtime assets.
  - Video is disabled by default (`AI_MEDIA_RUNTIME_ENABLE_VIDEO=false`).
- `GET|HEAD /runtime-asset/:assetKey`
  - Signed URL endpoint used by `outputUrl`.
  - Returns `307` redirect to original source media URL (bootstrap behavior).
- `GET /health`
  - Lightweight readiness/config visibility endpoint.

This bootstrap mode is intended for phase-1 runtime activation and contract stabilization.
For full background compositing/removal and model-wear generation, point
`AI_MEDIA_RUNTIME_BACKEND_URL` to your dedicated runtime generation server.
