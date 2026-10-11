/**
 * Server-side product analytics: the only place this repo talks to PostHog.
 *
 * WHY THIS SHAPE. The two public surfaces (the web UI's POST /api/ask and the
 * MCP tools) share one engine, and the question this module exists to answer
 * is "how much is each surface used, and does it stay fast", never "who asked
 * what". So every event carries shapes of use only: enums, booleans, counts,
 * durations in milliseconds and length buckets. The question text, the
 * answer, citation excerpts, caller IPs, emails and names are never passed in
 * here, and `questionAskedProperties` takes the question's length rather than
 * the question so the text cannot reach this module by accident.
 *
 * OFF BY DEFAULT. Without POSTHOG_KEY nothing happens: no client is built, no
 * request leaves the process, nothing is logged, and importing this module
 * has no side effects. That matters doubly for the stdio transport, whose
 * stdout IS the MCP protocol stream.
 *
 * NEVER FAILS A REQUEST. `capture` resolves either way: the send is wrapped in
 * try/catch, retries are off and the request timeout is short. Callers still
 * await it, before the response is written, because a Vercel function may be
 * frozen as soon as its response ends, which is exactly when a batched,
 * fire-and-forget capture would be in flight. That is why `captureImmediate`
 * is used instead of `capture` plus a periodic flush.
 */

import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import type { AskResult } from "./engine.js";

/** The whole allowlist. Adding an event means adding it here and to the README. */
export type AnalyticsEvent = "question_asked" | "mcp_tool_called" | "rate_limited";

/** Where a request came from: the static web UI (via /api/ask) or an MCP client. */
export type Surface = "web" | "mcp";

/** Primitives only, so no object or array of user content can be passed by mistake. */
export type AnalyticsProperties = Record<string, string | number | boolean>;

export type LengthBucket = "<40" | "40-120" | "120-300" | "300+";

const APP = "ask-edgeorgie-mcp";
const HOST = "https://us.i.posthog.com";
/**
 * Bounds what an analytics outage can cost a request, since the send is
 * awaited before the response is written: one attempt, then the event is
 * dropped. posthog-node's defaults (3 retries, 3 s apart, 10 s timeout) would
 * otherwise hold an answer for most of a minute while PostHog is down.
 */
const REQUEST_TIMEOUT_MS = 3000;

let client: PostHog | undefined;

function getClient(): PostHog | null {
  const key = process.env.POSTHOG_KEY;
  if (!key) return null;
  // flushAt 1 / flushInterval 0 keep the client from ever holding a queue or
  // a timer; captureImmediate below bypasses the queue regardless.
  client ??= new PostHog(key, {
    host: HOST,
    flushAt: 1,
    flushInterval: 0,
    fetchRetryCount: 0,
    requestTimeout: REQUEST_TIMEOUT_MS,
  });
  return client;
}

/** Buckets, not raw lengths: a raw length is a small fingerprint, a bucket is not. */
export function lengthBucket(length: number): LengthBucket {
  if (length < 40) return "<40";
  if (length < 120) return "40-120";
  if (length < 300) return "120-300";
  return "300+";
}

/**
 * The `question_asked` payload, built in one place so the web and MCP
 * surfaces cannot drift apart: the point of sharing the event name is one
 * chart with both surfaces on it. Reads nothing from `result` but the mode
 * and the citation count.
 */
export function questionAskedProperties(
  surface: Surface,
  questionLength: number,
  result: Pick<AskResult, "answerMode" | "citations">,
  latencyMs: number,
): AnalyticsProperties {
  return {
    surface,
    mode: result.answerMode,
    cited: result.citations.length > 0,
    citations: result.citations.length,
    latency_ms: latencyMs,
    length_bucket: lengthBucket(questionLength),
  };
}

/**
 * Records one event. A no-op without POSTHOG_KEY; otherwise one awaited send
 * that resolves even if PostHog is unreachable.
 */
export async function capture(event: AnalyticsEvent, properties: AnalyticsProperties): Promise<void> {
  const posthog = getClient();
  if (!posthog) return;
  try {
    await posthog.captureImmediate({
      // A fresh id per event: nothing links two requests, and no person
      // profile is created ($process_person_profile: false), matching the
      // cookieless browser side of the owner's portfolio.
      distinctId: randomUUID(),
      event,
      properties: { app: APP, ...properties, $process_person_profile: false },
    });
  } catch {
    // Analytics is observability, not the product: a failed send is dropped
    // and the caller's response is unaffected.
  }
}
