/**
 * In-memory rate limiting for the public, unauthenticated HTTP endpoints
 * (/mcp, /api/ask, and anything else that can trigger doAskAboutEdgeorgie's
 * optional LLM synthesis path in src/llm.ts).
 *
 * WHY THIS EXISTS: today, with no ANTHROPIC_API_KEY/OPENAI_API_KEY configured,
 * ask_about_edgeorgie falls back to deterministic TF-IDF retrieval (cheap,
 * CPU-only, no external call) — so hammering these endpoints is annoying but
 * not expensive. The moment either key IS added (see src/llm.ts), every
 * request to these endpoints can trigger a real, billed LLM call with zero
 * per-caller budget or cost ceiling. This module closes that gap now, before
 * a key is ever added, so protection doesn't silently depend on remembering
 * to add rate limiting later.
 *
 * Two independent limits are enforced:
 *   1. Per-caller sliding window — keyed by client IP (best-effort; see
 *      getClientId below). Generous enough for normal MCP client usage
 *      (tools/list + a couple of real questions) but caps any single caller.
 *   2. Global hard ceiling — a cap on TOTAL requests/minute across every
 *      caller, independent of the per-IP key. This is the "cost ceiling
 *      regardless of auth" backstop: IP-based limiting can be defeated by
 *      spoofing X-Forwarded-For or rotating source IPs, but the global
 *      ceiling still bounds worst-case request volume (and therefore
 *      worst-case LLM spend) hitting this process no matter how callers are
 *      identified.
 *
 * IMPLEMENTATION NOTE / KNOWN LIMITATION: this is a plain in-memory sliding
 * window (a Map of timestamps), which is the right level of effort for a
 * low-traffic portfolio demo, but it does NOT survive serverless reality on
 * Vercel:
 *   - Each cold start gets a fresh, empty Map, resetting all counters.
 *   - Concurrent requests landing on different warm instances each see their
 *     own independent Map, so the "global" ceiling is actually per-instance,
 *     not truly global across the deployment.
 * Before this endpoint is ever put under real load with a paid LLM key
 * behind it, replace this with a distributed store shared across instances
 * — e.g. Upstash Redis or Vercel KV with INCR + TTL / a sliding-window
 * Lua script — so limits hold across cold starts and horizontal scaling.
 */

interface CallerState {
  timestamps: number[];
}

const PER_CALLER_WINDOW_MS = 60_000;
const PER_CALLER_MAX_REQUESTS = 10;

const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX_REQUESTS = 60;

const callerState = new Map<string, CallerState>();
let globalTimestamps: number[] = [];

/** Drop timestamps older than `windowMs` from an array, in place conceptually (returns a new filtered array). */
function pruneOld(timestamps: number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs;
  return timestamps.filter((t) => t > cutoff);
}

/** Opportunistic cleanup so callerState doesn't grow unboundedly across a long-lived warm instance. */
function pruneStaleCallers(now: number): void {
  for (const [key, state] of callerState) {
    const kept = pruneOld(state.timestamps, now, PER_CALLER_WINDOW_MS);
    if (kept.length === 0) {
      callerState.delete(key);
    } else {
      state.timestamps = kept;
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds the caller should wait before retrying, set whenever allowed is false. */
  retryAfterSeconds?: number;
  /** Which limit tripped, for logging/debugging. */
  reason?: "per-caller" | "global";
}

/**
 * Checks and records one request attempt for `callerId`. Call this exactly
 * once per inbound request, before doing any real work.
 */
export function checkRateLimit(callerId: string, now: number = Date.now()): RateLimitResult {
  // Global hard ceiling first: this is the no-key-required cost ceiling that
  // protects the deployment even if per-caller identity is spoofed/rotated.
  globalTimestamps = pruneOld(globalTimestamps, now, GLOBAL_WINDOW_MS);
  if (globalTimestamps.length >= GLOBAL_MAX_REQUESTS) {
    const oldestInWindow = globalTimestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + GLOBAL_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSeconds, reason: "global" };
  }

  // Per-caller sliding window.
  if (callerState.size > 10_000) {
    pruneStaleCallers(now);
  }
  const existing = callerState.get(callerId);
  const priorTimestamps = existing ? pruneOld(existing.timestamps, now, PER_CALLER_WINDOW_MS) : [];
  if (priorTimestamps.length >= PER_CALLER_MAX_REQUESTS) {
    const oldestInWindow = priorTimestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + PER_CALLER_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSeconds, reason: "per-caller" };
  }

  // Record the attempt in both counters.
  priorTimestamps.push(now);
  callerState.set(callerId, { timestamps: priorTimestamps });
  globalTimestamps.push(now);

  return { allowed: true };
}

/**
 * Best-effort caller identity from a Node-style request's headers/socket.
 * X-Forwarded-For is attacker-controllable (hence the global ceiling above
 * as a backstop), but it's the only per-caller signal available behind
 * Vercel's edge network, which terminates the real client IP there.
 */
export function getClientId(req: {
  headers: Record<string, unknown> | { [key: string]: string | string[] | undefined };
  socket?: { remoteAddress?: string };
}): string {
  const xff = (req.headers as Record<string, string | string[] | undefined>)["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return xff[0];
  }
  const realIp = (req.headers as Record<string, string | string[] | undefined>)["x-real-ip"];
  if (typeof realIp === "string" && realIp.length > 0) {
    return realIp;
  }
  if (req.socket?.remoteAddress) {
    return req.socket.remoteAddress;
  }
  return "unknown";
}

/** Test-only: resets all in-memory counters so tests don't bleed into each other. */
export function _resetForTests(): void {
  callerState.clear();
  globalTimestamps = [];
}

export const RATE_LIMIT_CONFIG = {
  PER_CALLER_WINDOW_MS,
  PER_CALLER_MAX_REQUESTS,
  GLOBAL_WINDOW_MS,
  GLOBAL_MAX_REQUESTS,
};
