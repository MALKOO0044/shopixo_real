# Queue Rating Backfill Runbook

This runbook recomputes queue `displayed_rating` and `rating_confidence` from the internal `computeRating(...)` engine for these queue statuses:

- `pending`
- `approved`
- `rejected`
- `imported`

Endpoint:

- `POST /api/admin/ratings/recompute-queue`

## Preconditions

- You are logged in as an admin user.
- App is running.
- `SUPABASE_SERVICE_ROLE_KEY` is configured.

## 1) Dry run first (safe)

Open browser console while logged into admin and run:

```js
await fetch('/api/admin/ratings/recompute-queue', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    statuses: ['pending', 'approved', 'rejected', 'imported'],
    limit: 500,
    offset: 0,
    dryRun: true,
  }),
}).then((r) => r.json())
```

Review response fields:

- `processed`
- `updated`
- `failures`
- `samples`
- `errors`

## 2) Execute write run

If dry run looks correct, run:

```js
await fetch('/api/admin/ratings/recompute-queue', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    statuses: ['pending', 'approved', 'rejected', 'imported'],
    limit: 500,
    offset: 0,
    dryRun: false,
  }),
}).then((r) => r.json())
```

## 3) Process next batch (if needed)

If total queue rows are larger than `limit`, rerun with next offset:

- second run: `offset: 500`
- third run: `offset: 1000`
- continue until `processed` is `0`

## 4) Target specific queue IDs (optional)

```js
await fetch('/api/admin/ratings/recompute-queue', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    queueIds: [101, 102, 103],
    dryRun: false,
  }),
}).then((r) => r.json())
```

## 5) Verification checklist

- Queue tabs show stable ratings from `displayed_rating` only.
- `displayed_rating` and `rating_confidence` are populated for old queue rows.
- New queued products and imported products keep engine-derived values.
