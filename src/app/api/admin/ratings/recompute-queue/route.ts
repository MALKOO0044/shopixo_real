import { NextRequest, NextResponse } from "next/server";
import { ensureAdmin } from "@/lib/auth/admin-guard";
import { createClient } from "@supabase/supabase-js";
import { hasTable } from "@/lib/db-features";
import { computeRating } from "@/lib/rating/engine";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type QueueStatus = 'pending' | 'approved' | 'rejected' | 'imported';

const DEFAULT_STATUSES: QueueStatus[] = ['pending', 'approved', 'rejected', 'imported'];
const ALLOWED_STATUS_SET = new Set<QueueStatus>(DEFAULT_STATUSES);

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function parseArrayOrEmpty(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseStatuses(value: unknown): QueueStatus[] {
  if (!Array.isArray(value)) return DEFAULT_STATUSES;
  const out: QueueStatus[] = [];
  for (const entry of value) {
    const normalized = String(entry || '').trim().toLowerCase() as QueueStatus;
    if (!ALLOWED_STATUS_SET.has(normalized)) continue;
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out.length > 0 ? out : DEFAULT_STATUSES;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function finitePositiveOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function finiteOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const intValue = Math.floor(n);
  return Math.max(min, Math.min(max, intValue));
}

export async function POST(req: NextRequest) {
  try {
    const guard = await ensureAdmin();
    if (!guard.ok) {
      return NextResponse.json({ ok: false, error: guard.reason }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const ids = Array.isArray(body?.queueIds)
      ? body.queueIds
          .map((id: unknown) => parseBoundedInteger(id, 0, 0, Number.MAX_SAFE_INTEGER))
          .filter((id: number) => id > 0)
      : [];
    const statuses = parseStatuses(body?.statuses);
    const limit = parseBoundedInteger(body?.limit, 500, 1, 2000);
    const offset = parseBoundedInteger(body?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const dryRun = body?.dryRun === true;

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json({ ok: false, error: 'Database not configured' }, { status: 500 });
    }

    const hasSignalsTable = await hasTable('product_rating_signals').catch(() => false);

    let query = admin
      .from('product_queue')
      .select('*')
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);

    if (ids.length > 0) {
      query = query.in('id', ids);
    } else {
      query = query.in('status', statuses);
    }

    const { data: rows, error: fetchError } = await query;
    if (fetchError) {
      return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });
    }

    let updated = 0;
    let failures = 0;
    const errors: Array<{ id: number; error: string }> = [];
    const samples: Array<{
      id: number;
      status: string;
      displayed_before: number | null;
      displayed_after: number;
      confidence_before: number | null;
      confidence_after: number;
    }> = [];

    for (const row of rows || []) {
      try {
        const images = parseArrayOrEmpty((row as any)?.images);
        const variants = parseArrayOrEmpty((row as any)?.variants);
        const variantPricing = parseArrayOrEmpty((row as any)?.variant_pricing);

        const usdCandidates: number[] = [];

        for (const pricingRow of variantPricing) {
          const cost = finitePositiveOrZero(
            pricingRow?.costPrice ?? pricingRow?.cost_price ?? pricingRow?.variantPriceUSD ?? pricingRow?.variantPriceUsd
          );
          if (cost > 0) usdCandidates.push(cost);
        }

        for (const variant of variants) {
          const variantCost = finitePositiveOrZero(
            variant?.variantPriceUSD ?? variant?.variantPriceUsd ?? variant?.variantPrice ?? variant?.costPrice ?? variant?.cost_usd
          );
          if (variantCost > 0) usdCandidates.push(variantCost);
        }

        const minCostUsd = usdCandidates.length > 0
          ? Math.min(...usdCandidates)
          : finitePositiveOrZero((row as any)?.cj_product_cost || (row as any)?.cj_price_usd);

        const imageCount = images.length;
        const variantCount = variants.length > 0 ? variants.length : variantPricing.length;
        const stock = finiteOrZero((row as any)?.stock_total);
        const orderVolume = finiteOrZero((row as any)?.total_sales);

        const imgNorm = clamp01(imageCount / 15);
        const priceNorm = clamp01(minCostUsd / 50);
        const dynQuality = clamp01(0.6 * imgNorm + 0.4 * (1 - priceNorm));

        const qualityScoreRaw = Number((row as any)?.quality_score);
        const qualityScore = Number.isFinite(qualityScoreRaw) ? clamp01(qualityScoreRaw) : dynQuality;

        const ratingOut = computeRating({
          imageCount,
          stock,
          variantCount,
          qualityScore,
          priceUsd: minCostUsd,
          sentiment: 0,
          orderVolume,
        });

        const displayedAfter = Number(ratingOut.displayedRating);
        const confidenceAfter = Number(Math.max(0.05, Math.min(1, ratingOut.ratingConfidence)));

        const displayedBeforeRaw = Number((row as any)?.displayed_rating);
        const confidenceBeforeRaw = Number((row as any)?.rating_confidence);
        const displayedBefore = Number.isFinite(displayedBeforeRaw) ? displayedBeforeRaw : null;
        const confidenceBefore = Number.isFinite(confidenceBeforeRaw) ? confidenceBeforeRaw : null;

        if (!dryRun) {
          const { error: updateError } = await admin
            .from('product_queue')
            .update({
              displayed_rating: displayedAfter,
              rating_confidence: confidenceAfter,
              updated_at: new Date().toISOString(),
            })
            .eq('id', row.id);

          if (updateError) {
            throw new Error(updateError.message);
          }

          if (hasSignalsTable) {
            await admin.from('product_rating_signals').insert({
              product_id: null,
              cj_product_id: (row as any)?.cj_product_id || null,
              context: 'queue-recompute',
              signals: ratingOut.signals,
              displayed_rating: displayedAfter,
              rating_confidence: confidenceAfter,
            });
          }
        }

        updated++;
        if (samples.length < 50) {
          samples.push({
            id: row.id,
            status: String((row as any)?.status || ''),
            displayed_before: displayedBefore,
            displayed_after: displayedAfter,
            confidence_before: confidenceBefore,
            confidence_after: confidenceAfter,
          });
        }
      } catch (error: any) {
        failures++;
        errors.push({ id: Number((row as any)?.id || 0), error: error?.message || 'Unknown error' });
      }
    }

    return NextResponse.json({
      ok: true,
      mode: dryRun ? 'dry-run' : 'write',
      statuses,
      requestedIds: ids,
      offset,
      limit,
      processed: (rows || []).length,
      updated,
      failures,
      samples,
      errors: errors.slice(0, 50),
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || 'Server error' }, { status: 500 });
  }
}
