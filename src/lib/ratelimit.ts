import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Create a single Redis client from environment when available.
// In local/dev build environments without env, fall back to a permissive no-op limiter
// so builds do not crash. On Vercel, envs are present and Redis is used.
let redis: ReturnType<typeof Redis.fromEnv> | null = null;
try {
  // Only construct if both vars present
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = Redis.fromEnv();
  }
} catch {
  redis = null;
}

// One-time production warning when rate limiting is disabled due to missing env
let warned = false;
if (!redis && process.env.NODE_ENV === 'production' && !warned) {
  warned = true;
  console.warn("[ratelimit] Upstash env vars are missing in production; API routes will not be rate limited.");
}

export function getClientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  const realIp = (req.headers.get("x-real-ip") || "").trim();
  return realIp || "unknown";
}

function makeLimiter(prefix: string, max: number, window: string) {
  if (redis) {
    return new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(max, window as any),
      analytics: true,
      prefix,
    });
  }
  // No-op limiter for local build/dev without env
  return {
    async limit(_key: string) {
      return { success: true } as const;
    },
  } as unknown as Ratelimit;
}

// Sliding window: 30 req / 30s for search
export const searchLimiter = makeLimiter("rl:search", 30, "30 s");

// Uploads: 20 req / min per IP
export const uploadLimiter = makeLimiter("rl:upload", 20, "60 s");

// Cloudinary sign: 60 req / min per IP
export const signLimiter = makeLimiter("rl:sign", 60, "60 s");

// Auth endpoints (e.g., check-email): 30 req / min per IP
export const authLimiter = makeLimiter("rl:auth", 30, "60 s");

// Marketing (newsletter): 20 req / min per IP
export const marketingLimiter = makeLimiter("rl:marketing", 20, "60 s");

// Contact form submissions: 10 req / 5 min per IP
export const contactLimiter = makeLimiter("rl:contact", 10, "300 s");

// CJ webhook: 120 req / min per IP (adjust if needed based on CJ event volume)
export const cjWebhookLimiter = makeLimiter("rl:cj_webhook", 120, "60 s");

// Chat: 15 req / min per IP
export const chatLimiter = makeLimiter("rl:chat", 15, "60 s");

// Shipping calc: 60 req / min per IP
export const shippingLimiter = makeLimiter("rl:shipping", 60, "60 s");

// Admin AI media operations: 20 req / min per IP
export const aiMediaLimiter = makeLimiter("rl:ai_media", 20, "60 s");
