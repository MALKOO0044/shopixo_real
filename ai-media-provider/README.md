# Shopixo AI Media Provider (Option B)

This folder is a standalone Vercel microservice for `AI_MEDIA_PROVIDER_URL`.

## Endpoint

- Method: `POST`
- Path: `/generate`
- Auth: `Authorization: Bearer <AI_MEDIA_PROVIDER_TOKEN>`

Internal runtime bootstrap endpoints added in this service:
- `POST /runtime-generate` (runtime backend contract)
- `GET|HEAD /runtime-asset/:assetKey` (signed runtime output URL)
- `GET /health`

## Required Environment Variables (provider project)

- `AI_MEDIA_INTERNAL_PROVIDER_TOKEN` = same token value used by Shopixo as `AI_MEDIA_PROVIDER_TOKEN`
- `AI_MEDIA_RUNTIME_BACKEND_URL` = runtime backend endpoint (must return `outputUrl`)

### Fast bootstrap (same Vercel project)

If you want to start immediately without deploying a second runtime project, set:

```text
AI_MEDIA_RUNTIME_BACKEND_URL=https://<provider-domain>/runtime-generate
```

This uses the internal runtime bootstrap endpoint included in `ai-media-provider`.

## Optional Environment Variables

- `AI_MEDIA_RUNTIME_BACKEND_TOKEN` = bearer token sent to your runtime backend (if it requires auth)
- `AI_MEDIA_ENABLE_VIDEO_GENERATION` = `true` to enable video requests (default is disabled)
- `AI_MEDIA_RUNTIME_ENABLE_VIDEO` = `true` to allow video from internal runtime bootstrap (default disabled)
- `AI_MEDIA_RUNTIME_ASSET_SECRET` = signing secret for `/runtime-asset/:assetKey` URLs (recommended)

## Deploy on Vercel (click-by-click)

1. Go to Vercel Dashboard.
2. Click **Add New...** -> **Project**.
3. Select this repository.
4. In project setup, set **Root Directory** to `ai-media-provider`.
5. Click **Environment Variables** and add:
   - Key: `AI_MEDIA_INTERNAL_PROVIDER_TOKEN`
   - Value: your generated secure token
   - Environment: `Production` (and Preview if needed)
   - Key: `AI_MEDIA_RUNTIME_BACKEND_URL`
   - Value: `https://<provider-domain>/runtime-generate` (bootstrap)
   - Environment: `Production` (and Preview if needed)
   - Key: `AI_MEDIA_RUNTIME_ASSET_SECRET`
   - Value: use a long random token (recommended)
   - Environment: `Production` (and Preview if needed)
6. Click **Deploy**.
7. After deploy, copy your provider domain from **Settings** -> **Domains**.
8. In your `shopixo-only` project, set:
   - `AI_MEDIA_PROVIDER_URL=https://<provider-domain>/generate`
   - `AI_MEDIA_PROVIDER_TOKEN=<same token>`
9. Redeploy `shopixo-only`.

## Notes

- This provider no longer returns mock media. It strictly proxies requests to runtime backend.
- If `AI_MEDIA_RUNTIME_BACKEND_URL` is missing or unreachable, it returns `503`.
- It forwards render/view constraints and returns mode/view metadata for Shopixo fidelity checks.
- Internal runtime bootstrap mode currently prioritizes image stabilization and keeps video disabled by default.
