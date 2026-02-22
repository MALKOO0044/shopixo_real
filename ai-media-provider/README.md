# Shopixo AI Media Provider (Option B)

This folder is a standalone Vercel microservice for `AI_MEDIA_PROVIDER_URL`.

## Endpoint

- Method: `POST`
- Path: `/generate`
- Auth: `Authorization: Bearer <AI_MEDIA_PROVIDER_TOKEN>`

## Required Environment Variable (provider project)

- `AI_MEDIA_INTERNAL_PROVIDER_TOKEN` = same token value used by Shopixo as `AI_MEDIA_PROVIDER_TOKEN`

## Deploy on Vercel (click-by-click)

1. Go to Vercel Dashboard.
2. Click **Add New...** -> **Project**.
3. Select this repository.
4. In project setup, set **Root Directory** to `ai-media-provider`.
5. Click **Environment Variables** and add:
   - Key: `AI_MEDIA_INTERNAL_PROVIDER_TOKEN`
   - Value: your generated secure token
   - Environment: `Production` (and Preview if needed)
6. Click **Deploy**.
7. After deploy, copy your provider domain from **Settings** -> **Domains**.
8. In your `shopixo-only` project, set:
   - `AI_MEDIA_PROVIDER_URL=https://<provider-domain>/generate`
   - `AI_MEDIA_PROVIDER_TOKEN=<same token>`
9. Redeploy `shopixo-only`.

## Notes

- This starter provider currently returns deterministic public media URLs to unblock integration.
- Replace generation logic in `api/generate.js` with your real model pipeline when ready.
