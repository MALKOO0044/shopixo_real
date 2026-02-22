"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Film,
  Image as ImageIcon,
  Loader2,
  Play,
  RefreshCw,
  Square,
} from "lucide-react";
import type {
  AIMediaAssetRecord,
  AIMediaColorProgress,
  AIMediaRunRecord,
  AIMediaRunStatus,
} from "@/lib/ai/media/types";
import type { PricedProduct } from "./types";

type PreviewPageSevenProps = {
  product: PricedProduct;
  sourceContext: "discover" | "cj_detail";
};

type AIMediaRunDetailsPayload = {
  run: AIMediaRunRecord;
  assets: AIMediaAssetRecord[];
  byColor: AIMediaColorProgress[];
  jobId: number | null;
};

type ReadyAssetsGroup = {
  color: string;
  images: AIMediaAssetRecord[];
  videos: AIMediaAssetRecord[];
};

const POLL_INTERVAL_MS = 3500;
const DEFAULT_RENDER_MODE = "background_only_preserve_product" as const;

function inferViewTagFromUrl(url: string): "front" | "back" | "side" | "detail" | "unknown" {
  const normalized = String(url || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return "unknown";
  if (/(^|\s)(back|rear|backside|behind|reverse)(\s|$)/.test(normalized)) return "back";
  if (/(^|\s)(front|main|primary|hero)(\s|$)/.test(normalized)) return "front";
  if (/(^|\s)(side|profile|lateral)(\s|$)/.test(normalized)) return "side";
  if (/(^|\s)(detail|closeup|close|zoom|macro)(\s|$)/.test(normalized)) return "detail";
  return "unknown";
}

function buildSourceViewMap(product: PricedProduct): Record<string, "front" | "back" | "side" | "detail" | "unknown"> {
  const urls = Array.from(
    new Set([
      ...(Array.isArray(product.images) ? product.images : []),
      ...Object.values(product.colorImageMap || {}),
    ])
  );

  const out: Record<string, "front" | "back" | "side" | "detail" | "unknown"> = {};
  for (const raw of urls) {
    const url = String(raw || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    out[url] = inferViewTagFromUrl(url);
  }
  return out;
}

function collectTargetColors(product: PricedProduct): string[] {
  const candidates: string[] = [
    ...(Array.isArray(product.availableColors) ? product.availableColors : []),
    ...(Array.isArray(product.variants)
      ? product.variants.map((variant) => String(variant?.color || "").trim())
      : []),
    ...(product.colorImageMap ? Object.keys(product.colorImageMap) : []),
  ];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const color of candidates) {
    const normalized = String(color || "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }

  return out;
}

function statusClasses(status: AIMediaRunStatus | null | undefined): string {
  if (status === "completed") return "bg-emerald-100 text-emerald-700 border-emerald-200";
  if (status === "partial") return "bg-amber-100 text-amber-700 border-amber-200";
  if (status === "running") return "bg-blue-100 text-blue-700 border-blue-200";
  if (status === "pending") return "bg-slate-100 text-slate-700 border-slate-200";
  if (status === "failed") return "bg-red-100 text-red-700 border-red-200";
  if (status === "canceled") return "bg-zinc-100 text-zinc-700 border-zinc-200";
  return "bg-gray-100 text-gray-700 border-gray-200";
}

function isActiveStatus(status: AIMediaRunStatus | null | undefined): boolean {
  return status === "pending" || status === "running";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString();
}

export default function PreviewPageSeven({ product, sourceContext }: PreviewPageSevenProps) {
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [latestRun, setLatestRun] = useState<AIMediaRunRecord | null>(null);
  const [latestReadyRun, setLatestReadyRun] = useState<AIMediaRunRecord | null>(null);
  const [latestReadyAssets, setLatestReadyAssets] = useState<AIMediaAssetRecord[]>([]);
  const [runDetails, setRunDetails] = useState<AIMediaRunDetailsPayload | null>(null);

  const targetColors = useMemo(() => collectTargetColors(product), [product]);

  const currentRunStatus = (runDetails?.run?.status || latestRun?.status || null) as AIMediaRunStatus | null;
  const currentRunId = Number(runDetails?.run?.id || latestRun?.id || 0) || null;
  const canCancel = isActiveStatus(currentRunStatus) && Boolean(currentRunId);

  const readyAssetsByColor = useMemo<ReadyAssetsGroup[]>(() => {
    const grouped = new Map<string, { images: AIMediaAssetRecord[]; videos: AIMediaAssetRecord[] }>();

    for (const asset of latestReadyAssets) {
      const color = String(asset?.color || "Unknown").trim() || "Unknown";
      if (!grouped.has(color)) grouped.set(color, { images: [], videos: [] });
      const entry = grouped.get(color)!;
      if (asset.media_type === "video") {
        entry.videos.push(asset);
      } else {
        entry.images.push(asset);
      }
    }

    for (const entry of grouped.values()) {
      entry.images.sort((a, b) => Number(a.media_index || 0) - Number(b.media_index || 0));
    }

    return Array.from(grouped.entries())
      .map(([color, entry]) => ({ color, ...entry }))
      .sort((a, b) => a.color.localeCompare(b.color));
  }, [latestReadyAssets]);

  const byColorProgress = useMemo<AIMediaColorProgress[]>(() => {
    if (runDetails?.byColor?.length) return runDetails.byColor;

    return targetColors.map((color: string) => {
      const readyForColor = readyAssetsByColor.find(
        (entry: ReadyAssetsGroup) => entry.color.toLowerCase() === color.toLowerCase()
      );
      const approvedImages = readyForColor?.images.length || 0;
      const approvedVideo = readyForColor?.videos.length ? 1 : 0;
      return {
        color,
        approvedImages,
        rejectedImages: 0,
        approvedVideo,
        rejectedVideo: 0,
        done: approvedImages > 0 || approvedVideo > 0,
      } as AIMediaColorProgress;
    });
  }, [readyAssetsByColor, runDetails?.byColor, targetColors]);

  const runRequest = useMemo(() => {
    const requestFromDetails = runDetails?.run?.params?.request;
    if (requestFromDetails && typeof requestFromDetails === "object") return requestFromDetails as Record<string, any>;
    const requestFromLatest = latestRun?.params?.request;
    if (requestFromLatest && typeof requestFromLatest === "object") return requestFromLatest as Record<string, any>;
    return null;
  }, [latestRun?.params, runDetails?.run?.params]);

  const renderModeLabel =
    runRequest?.renderMode === "pose_aware_model_wear"
      ? "Pose-Aware Model Wear"
      : "Background-Only Product Preserve";

  const readyQualityScores = useMemo(() => {
    const readyAssets = (runDetails?.assets || []).filter(
      (asset: AIMediaAssetRecord) => asset.status === "ready"
    );
    const scores = readyAssets
      .map((asset: AIMediaAssetRecord) => Number((asset?.fidelity as Record<string, any> | null)?.overallScore ?? NaN))
      .filter((value: number) => Number.isFinite(value));
    if (scores.length === 0) return null;
    const average = scores.reduce((sum: number, value: number) => sum + value, 0) / scores.length;
    return Math.round(average * 100);
  }, [runDetails?.assets]);

  const rejectionReasons = useMemo(() => {
    if (!Array.isArray(runDetails?.assets)) return [] as Array<{ reason: string; count: number }>;
    const rejectedAssets = runDetails.assets.filter(
      (asset: AIMediaAssetRecord) => asset.status === "rejected"
    );
    const counts = new Map<string, number>();
    for (const asset of rejectedAssets) {
      const fidelity = (asset?.fidelity || {}) as Record<string, any>;
      const reason =
        String(fidelity?.summary || "").trim() ||
        String((fidelity?.rejectionReasons || [])[0] || "").trim() ||
        "Rejected by fidelity policy";
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [runDetails?.assets]);

  const loadState = useCallback(
    async (silent = false) => {
      if (!product?.pid) {
        setLatestRun(null);
        setLatestReadyRun(null);
        setLatestReadyAssets([]);
        setRunDetails(null);
        return;
      }

      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        setError(null);

        const encodedPid = encodeURIComponent(product.pid);
        const [runsRes, latestRes] = await Promise.all([
          fetch(`/api/admin/ai/media/runs?cjProductId=${encodedPid}&limit=1`, { cache: "no-store" }),
          fetch(`/api/admin/ai/media/latest?cjProductId=${encodedPid}`, { cache: "no-store" }),
        ]);

        const runsBody = await runsRes.json().catch(() => ({}));
        const latestBody = await latestRes.json().catch(() => ({}));

        if (!runsRes.ok || !runsBody?.ok) {
          throw new Error(runsBody?.error || `Failed to load AI media runs (${runsRes.status})`);
        }
        if (!latestRes.ok || !latestBody?.ok) {
          throw new Error(latestBody?.error || `Failed to load latest AI media (${latestRes.status})`);
        }

        const nextLatestRun = (Array.isArray(runsBody?.runs) ? runsBody.runs[0] : null) as
          | AIMediaRunRecord
          | null;
        const nextReadyRun = (latestBody?.run || null) as AIMediaRunRecord | null;
        const nextReadyAssets = (Array.isArray(latestBody?.assets)
          ? latestBody.assets
          : []) as AIMediaAssetRecord[];

        setLatestRun(nextLatestRun);
        setLatestReadyRun(nextReadyRun);
        setLatestReadyAssets(nextReadyAssets);

        const detailsRunId = Number(nextLatestRun?.id || nextReadyRun?.id || 0);
        if (Number.isFinite(detailsRunId) && detailsRunId > 0) {
          const detailsRes = await fetch(`/api/admin/ai/media/runs/${detailsRunId}`, {
            cache: "no-store",
          });
          const detailsBody = await detailsRes.json().catch(() => ({}));
          if (detailsRes.ok && detailsBody?.ok && detailsBody?.details) {
            setRunDetails(detailsBody.details as AIMediaRunDetailsPayload);
          } else {
            setRunDetails(null);
          }
        } else {
          setRunDetails(null);
        }
      } catch (e: any) {
        setError(e?.message || "Failed to load AI media state");
      } finally {
        if (silent) {
          setRefreshing(false);
        } else {
          setLoading(false);
        }
      }
    },
    [product?.pid]
  );

  useEffect(() => {
    void loadState(false);
  }, [loadState]);

  useEffect(() => {
    if (!currentRunId || !isActiveStatus(currentRunStatus)) return;
    const timer = window.setInterval(() => {
      void loadState(true);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [currentRunId, currentRunStatus, loadState]);

  const handleStartGeneration = useCallback(async () => {
    if (!product?.pid) return;

    setCreating(true);
    setError(null);

    try {
      const payload = {
        cjProductId: product.pid,
        sourceContext,
        targetColors,
        sourceImages: Array.isArray(product.images) ? product.images : [],
        sourceVideoUrl: product.videoUrl || undefined,
        colorImageMap: product.colorImageMap || undefined,
        categoryLabel: product.categoryName || undefined,
        renderMode: DEFAULT_RENDER_MODE,
        includeVideo: false,
        enforceSourceViewOnly: true,
        allowedViews: ["front", "back"],
        sourceViewMap: buildSourceViewMap(product),
        faceVisibilityPolicy: {
          upperWear: "half_face_allowed",
          fullBody: "face_hidden",
        },
      };

      const createRes = await fetch("/api/admin/ai/media/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const createBody = await createRes.json().catch(() => ({}));

      if (!createRes.ok || !createBody?.ok || !createBody?.run?.runId) {
        throw new Error(createBody?.error || `Failed to create AI media run (${createRes.status})`);
      }

      const jobId = Number(createBody?.run?.jobId || 0);
      if (Number.isFinite(jobId) && jobId > 0) {
        void fetch(`/api/admin/jobs/${jobId}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "all" }),
        }).catch(() => undefined);
      }

      await loadState(true);
    } catch (e: any) {
      setError(e?.message || "Failed to start AI media generation");
    } finally {
      setCreating(false);
    }
  }, [loadState, product, sourceContext, targetColors]);

  const handleCancelRun = useCallback(async () => {
    const runId = Number(runDetails?.run?.id || latestRun?.id || 0);
    if (!Number.isFinite(runId) || runId <= 0) return;

    setCanceling(true);
    setError(null);

    try {
      const res = await fetch(`/api/admin/ai/media/runs/${runId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok || !body?.ok) {
        throw new Error(body?.error || `Failed to cancel AI media run (${res.status})`);
      }

      await loadState(true);
    } catch (e: any) {
      setError(e?.message || "Failed to cancel AI media run");
    } finally {
      setCanceling(false);
    }
  }, [latestRun?.id, loadState, runDetails?.run?.id]);

  const totals = (runDetails?.run?.totals || latestRun?.totals || {}) as Record<string, unknown>;
  const totalsApprovedImages = Number(totals.approvedImages || 0);
  const totalsApprovedVideos = Number(totals.approvedVideos || 0);
  const totalsRejectedImages = Number(totals.rejectedImages || 0);
  const totalsRejectedVideos = Number(totals.rejectedVideos || 0);

  const colorsDetected = targetColors.length;
  const disableStart = creating || canceling || colorsDetected === 0;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-purple-200 bg-gradient-to-br from-purple-50 via-white to-blue-50 p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h4 className="text-lg font-semibold text-gray-900">AI Media (Page 7)</h4>
            <p className="text-sm text-gray-600">
              Generates AI media using the active backend quality profile with strict fidelity checks.
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Source: {sourceContext === "discover" ? "Product Discovery" : "CJ Product Details"}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void loadState(true)}
              disabled={loading || refreshing || creating || canceling}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </button>

            <button
              onClick={handleStartGeneration}
              disabled={disableStart}
              className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-3 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {latestRun ? "Regenerate" : "Generate AI Media"}
            </button>

            {canCancel && (
              <button
                onClick={handleCancelRun}
                disabled={canceling || creating}
                className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {canceling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                Cancel Run
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <p className="text-xs text-gray-500">Detected Colors</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">{colorsDetected}</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <p className="text-xs text-gray-500">Approved Images</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">{totalsApprovedImages}</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <p className="text-xs text-gray-500">Approved Videos</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">{totalsApprovedVideos}</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <p className="text-xs text-gray-500">Rejected Images</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">{totalsRejectedImages}</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <p className="text-xs text-gray-500">Rejected Videos</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">{totalsRejectedVideos}</p>
          </div>
        </div>

        {colorsDetected === 0 && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
            No colors were detected for this product yet. Please ensure variants/colors are available.
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-700">Latest Run:</span>
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClasses(
              currentRunStatus
            )}`}
          >
            {(currentRunStatus || "none").toUpperCase()}
          </span>
          {currentRunId && <span className="text-xs text-gray-500">Run #{currentRunId}</span>}
          <span className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">
            {renderModeLabel}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-gray-600 md:grid-cols-2">
          <p>Created: {formatDate(runDetails?.run?.created_at || latestRun?.created_at || null)}</p>
          <p>Finished: {formatDate(runDetails?.run?.finished_at || latestRun?.finished_at || null)}</p>
          <p>
            Latest ready run: {latestReadyRun ? `#${latestReadyRun.id}` : "none"}
          </p>
          <p>Ready assets: {latestReadyAssets.length}</p>
          <p>
            Avg ready quality score: {typeof readyQualityScores === "number" ? `${readyQualityScores}%` : "-"}
          </p>
          <p>
            Source-view lock: {runRequest?.enforceSourceViewOnly === false ? "Off" : "On"}
          </p>
        </div>

        {rejectionReasons.length > 0 && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-800">
              Top rejection reasons
            </p>
            <ul className="space-y-1 text-sm text-amber-800">
              {rejectionReasons.map((item: { reason: string; count: number }) => (
                <li key={item.reason} className="flex items-start justify-between gap-3">
                  <span className="line-clamp-2">{item.reason}</span>
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                    {item.count}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <h5 className="mb-3 text-sm font-semibold text-gray-800">Per-color progress</h5>
        {byColorProgress.length === 0 ? (
          <p className="text-sm text-gray-500">No progress yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {byColorProgress.map((item: AIMediaColorProgress) => (
              <div key={item.color} className="rounded-lg border border-gray-200 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="font-medium text-gray-900">{item.color}</p>
                  {item.done ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <Loader2 className="h-4 w-4 text-gray-400" />
                  )}
                </div>
                <div className="space-y-1 text-xs text-gray-600">
                  <p>Approved images: {item.approvedImages}</p>
                  <p>Rejected images: {item.rejectedImages}</p>
                  <p>Approved video: {item.approvedVideo}</p>
                  <p>Rejected video: {item.rejectedVideo}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <h5 className="mb-4 text-sm font-semibold text-gray-800">Approved AI media gallery</h5>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            Loading AI media...
          </div>
        ) : readyAssetsByColor.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
            <AlertCircle className="mx-auto mb-2 h-5 w-5" />
            No approved AI assets yet. Start generation to populate this gallery.
          </div>
        ) : (
          <div className="space-y-6">
            {readyAssetsByColor.map((entry: ReadyAssetsGroup) => (
              <div key={entry.color} className="rounded-lg border border-gray-200 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h6 className="font-semibold text-gray-900">{entry.color}</h6>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span className="inline-flex items-center gap-1">
                      <ImageIcon className="h-3.5 w-3.5" />
                      {entry.images.length} images
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Film className="h-3.5 w-3.5" />
                      {entry.videos.length} videos
                    </span>
                  </div>
                </div>

                {entry.images.length > 0 && (
                  <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                    {entry.images.map((asset: AIMediaAssetRecord, index: number) => (
                      <div key={asset.id || `${entry.color}-img-${index}`} className="overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
                        <img
                          src={asset.storage_url}
                          alt={`${entry.color} AI image ${index + 1}`}
                          className="aspect-square w-full object-cover"
                          loading="lazy"
                        />
                      </div>
                    ))}
                  </div>
                )}

                {entry.videos.length > 0 && (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {entry.videos.map((asset: AIMediaAssetRecord, index: number) => (
                      <video
                        key={asset.id || `${entry.color}-video-${index}`}
                        src={asset.storage_url}
                        controls
                        preload="metadata"
                        className="w-full rounded-lg border border-gray-200 bg-black"
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
