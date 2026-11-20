import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

interface Hit {
  count: number;
  resetAt: number;
}

const hits = new Map<string, Hit>();
const MAX_KEYS = 10000;

function prune(now: number) {
  if (hits.size < MAX_KEYS) return;
  for (const [key, hit] of hits) if (hit.resetAt < now) hits.delete(key);
}

/** Simple fixed-window limiter. Returns true when the caller has exceeded `max` attempts. */
export function rateLimited(key: string, max = 10, windowMs = 15 * 60 * 1000): boolean {
  const now = Date.now();
  prune(now);
  const entry = hits.get(key);
  if (!entry || entry.resetAt < now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count++;
  return entry.count > max;
}

/**
 * Client address for rate limiting. On Render and similar proxies the proxy appends the real
 * client address to X-Forwarded-For, so the rightmost entry is the one a client cannot forge.
 */
export function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (!forwarded) return "unknown";
  const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? "unknown";
}

/**
 * Per-user and per-IP limits for the AI routes. Returns a 429 response when either limit is
 * exceeded, otherwise null.
 */
export function aiRateLimit(
  req: NextRequest,
  userId: string,
  scope: string,
  limits: { perUser: number; perIp: number; windowMs?: number } = { perUser: 20, perIp: 60 }
): NextResponse | null {
  const windowMs = limits.windowMs ?? 60 * 60 * 1000;
  const overUser = rateLimited(`ai:${scope}:user:${userId}`, limits.perUser, windowMs);
  const overIp = rateLimited(`ai:${scope}:ip:${clientKey(req)}`, limits.perIp, windowMs);
  if (!overUser && !overIp) return null;
  const minutes = Math.ceil(windowMs / 60000);
  return NextResponse.json(
    { success: false, error: `Too many requests. Try again in up to ${minutes} minutes.` },
    { status: 429 }
  );
}
