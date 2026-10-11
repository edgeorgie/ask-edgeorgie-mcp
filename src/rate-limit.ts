/**
 * In-memory rate limiting for the public, unauthenticated HTTP endpoints
 * (/mcp, /api/ask, and anything else that can trigger doAskAboutEdgeorgie's
 * optional LLM synthesis path in src/llm.ts).
 *
 * WHY THIS EXISTS: an ANTHROPIC_API_KEY *is* configured on this deployment
 * today — `POST /api/ask` was measured returning `answerMode: "llm"`,
 * `llmKeyConfigured: true`, model `claude-haiku-4-5` (2026-10-11) — so every
 * anonymous request already bills the repo owner's own Anthropic account.
 * (An earlier version of this comment said no key was set and framed the
 * limiter as protection added *before* one existed; that was stale, and it
 * understated the exposure.) ask_about_edgeorgie only falls back to
 * deterministic TF-IDF retrieval when the key is absent or the call fails.
 *
 * Two independent limits are enforced:
 *   1. Per-caller sliding window — keyed by client IP (best-effort; see
 *      getClientId below). Generous enough for normal MCP client usage
 *      (tools/list + a couple of real questions) but caps any single caller.
 *   2. Process-wide ceiling — a cap on TOTAL requests/minute across every
 *      caller within THIS instance, independent of the per-IP key. It bounds
 *      worst-case request volume (and therefore worst-case LLM spend) hitting
 *      a single process no matter how callers identify themselves. It is NOT
 *      a deployment-wide ceiling; see the measured limitation below.
 *   3. Question-length cap — see MAX_QUESTION_LENGTH. Request *count* limits
 *      alone do not bound spend, because the question is concatenated into
 *      the LLM prompt: one accepted request can carry an arbitrarily large
 *      input-token bill.
 *
 * MEASURED LIMITATION — READ BEFORE CITING THESE LIMITS AS PROTECTION. This
 * is a plain in-memory sliding window (a Map of timestamps), which is the
 * right level of effort for a low-traffic portfolio demo, but it does NOT
 * survive serverless reality on Vercel. Measured against this deployment
 * (`POST /api/ask`, 2026-10-11), not inferred:
 *   - CONCURRENCY LARGELY DEFEATS BOTH WINDOWS. 40 simultaneous POSTs from
 *     one IP with no header manipulation returned 36x200 / 4x429 — i.e. 36
 *     billable calls where the documented ceiling is 10. Vercel allocates
 *     instances in response to parallelism and each starts with an empty
 *     Map, so parallel requests are counted against different fresh buckets.
 *   - The limits bind a SEQUENTIAL caller, which is what they actually
 *     control: 14 requests in a loop returned 10x200 then 4x429, exactly as
 *     configured.
 *   - Each cold start also gets a fresh, empty Map, resetting all counters —
 *     but cold starts are the lesser issue; plain parallelism is enough and
 *     needs no timing games.
 *   - Do NOT claim this ceiling survives a caller spoofing or rotating
 *     X-Forwarded-For. Vercel's edge sets that header and the platform value
 *     is what this code observes, so forged values are not the live bypass;
 *     concurrency is.
 * It therefore raises the cost of a naive abuse loop without being a hard
 * spend cap, and must not be described as one. The real hard ceiling belongs
 * at the billing layer (an Anthropic spend limit on the key). To actually
 * close the concurrency hole, replace this with a distributed store shared
 * across instances — e.g. Upstash Redis or Vercel KV with INCR + TTL / a
 * sliding-window Lua script — so limits hold across instances and cold starts.
 */

interface CallerState {
  timestamps: number[];
}

const PER_CALLER_WINDOW_MS = 60_000;
const PER_CALLER_MAX_REQUESTS = 10;

const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX_REQUESTS = 60;

/**
 * Maximum accepted question length, in characters.
 *
 * The question is concatenated verbatim into the LLM prompt alongside the
 * retrieved corpus excerpts (see src/llm.ts `buildSpotlightedPrompt`), so an
 * unbounded question is an unbounded input-token bill per call — a cost
 * vector the request-count limits above do not touch at all. Measured on the
 * live deployment before this cap existed: a single 19,500-character question
 * was accepted and answered with `answerMode: "llm"` (HTTP 200).
 *
 * 2000 characters is far longer than any real question a human or agent asks
 * about a person (this repo's own README examples are under 60), while being
 * short enough that it cannot dominate prompt cost. Enforced in
 * src/engine.ts's doAskAboutEdgeorgie, i.e. on every route and transport that
 * can reach it (REST /api/ask, /mcp, and the stdio server), rather than at a
 * single HTTP entry point.
 *
 * Mirrors MAX_QUESTION_LENGTH in the sibling repoask-mcp, where this cap
 * already existed; this module documented itself as a faithful port of that
 * one while silently lacking the cap.
 */
const MAX_QUESTION_LENGTH = 2000;

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

export interface QuestionLengthResult {
  ok: boolean;
  /** Human-readable rejection reason, set whenever ok is false. */
  error?: string;
}

/**
 * Rejects questions long enough to be a cost-amplification vector. Returns a
 * result rather than throwing so each caller can map it to its own error
 * shape (REST JSON vs JSON-RPC).
 */
export function checkQuestionLength(question: string): QuestionLengthResult {
  if (question.length > MAX_QUESTION_LENGTH) {
    return {
      ok: false,
      error: `Question too long: ${question.length} characters (maximum ${MAX_QUESTION_LENGTH}).`,
    };
  }
  return { ok: true };
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
  MAX_QUESTION_LENGTH,
};
