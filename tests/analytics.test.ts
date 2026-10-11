/**
 * Guards the analytics facade's promises (src/analytics.ts).
 *
 * 1. Inert without POSTHOG_KEY. The point of merging this before a key exists
 *    is that the deployment behaves exactly as before: no request, no log
 *    line, no thrown error. "No request" is asserted by replacing the global
 *    fetch posthog-node uses with one that records every call, and "no log
 *    line" by capturing console output, so a future edit that builds the
 *    client eagerly or logs a warning fails here rather than on the stdout of
 *    the stdio transport, which IS the MCP protocol stream.
 *
 * 2. Never fails a request when a key IS set. The send is exercised against a
 *    fetch that rejects, which is what a PostHog outage looks like from inside
 *    the function, with no egress and no real key: the same technique
 *    tests/llm-fallback-cause.test.ts uses for the provider call.
 *
 * 3. The question_asked payload is shapes only. The builder is handed a
 *    length, never the question, and the test asserts the exact key set so an
 *    added property is a deliberate, README-visible change rather than drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { capture, lengthBucket, questionAskedProperties } from "../src/analytics.js";

/**
 * Runs `fn` with POSTHOG_KEY set (or unset), a recording fetch and silenced
 * console, then restores all three whatever the outcome.
 */
async function withAnalyticsEnv<T>(
  key: string | undefined,
  fetchImpl: () => Promise<Response>,
  fn: (urls: string[], logs: string[]) => Promise<T>,
): Promise<T> {
  const savedKey = process.env.POSTHOG_KEY;
  const savedFetch = globalThis.fetch;
  const savedConsole = { log: console.log, warn: console.warn, error: console.error };
  const urls: string[] = [];
  const logs: string[] = [];
  if (key === undefined) delete process.env.POSTHOG_KEY;
  else process.env.POSTHOG_KEY = key;
  globalThis.fetch = ((input: string | URL | Request) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return fetchImpl();
  }) as typeof fetch;
  for (const level of ["log", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  }
  try {
    return await fn(urls, logs);
  } finally {
    if (savedKey === undefined) delete process.env.POSTHOG_KEY;
    else process.env.POSTHOG_KEY = savedKey;
    globalThis.fetch = savedFetch;
    Object.assign(console, savedConsole);
  }
}

test("without POSTHOG_KEY, capture resolves, sends nothing and logs nothing", async () => {
  await withAnalyticsEnv(
    undefined,
    () => Promise.reject(new Error("fetch must not be called without a key")),
    async (urls, logs) => {
      await capture("question_asked", {
        surface: "web",
        mode: "deterministic",
        cited: true,
        citations: 6,
        latency_ms: 12,
        length_bucket: "<40",
      });
      await capture("mcp_tool_called", { tool: "get_story" });
      await capture("rate_limited", { surface: "mcp", reason: "global" });
      assert.deepEqual(urls, [], "no request may leave the process without a key");
      assert.deepEqual(logs, [], "nothing may be written to the console without a key");
    },
  );
});

test("with a key and PostHog unreachable, capture still resolves after exactly one attempt", async () => {
  await withAnalyticsEnv(
    "phc_not_a_real_key",
    () => Promise.reject(new Error("connect ECONNREFUSED")),
    async (urls) => {
      await capture("mcp_tool_called", { tool: "get_experience" });
      // One send and no retries: the capture is awaited before the response is
      // written, so a retry schedule would be paid by the caller's latency.
      assert.equal(urls.length, 1, `expected exactly one send attempt, saw ${urls.length}`);
      assert.ok(urls[0].startsWith("https://us.i.posthog.com/"), `unexpected analytics host: ${urls[0]}`);
    },
  );
});

test("lengthBucket uses the plan's four buckets with exact boundaries", () => {
  assert.equal(lengthBucket(0), "<40");
  assert.equal(lengthBucket(39), "<40");
  assert.equal(lengthBucket(40), "40-120");
  assert.equal(lengthBucket(119), "40-120");
  assert.equal(lengthBucket(120), "120-300");
  assert.equal(lengthBucket(299), "120-300");
  assert.equal(lengthBucket(300), "300+");
  assert.equal(lengthBucket(2000), "300+");
});

test("question_asked carries shapes only: a fixed key set, no text, no long strings", () => {
  const question = "What AI agent infrastructure has this person built in production?";
  const result = {
    answerMode: "deterministic" as const,
    citations: [
      {
        rank: 1,
        source: "resume.txt",
        startLine: 1,
        endLine: 3,
        score: 0.2,
        excerpt: "Software Engineer at Mercado Libre.",
      },
    ],
  };
  const props = questionAskedProperties("web", question.length, result, 812);
  assert.deepEqual(props, {
    surface: "web",
    mode: "deterministic",
    cited: true,
    citations: 1,
    latency_ms: 812,
    length_bucket: "40-120",
  });
  const serialized = JSON.stringify(props);
  assert.ok(!serialized.includes(question), "the question text must never be in the payload");
  assert.ok(!serialized.includes(result.citations[0].excerpt), "citation text must never be in the payload");
  for (const value of Object.values(props)) {
    if (typeof value === "string") {
      assert.ok(value.length <= 64, `a property value this long is content, not a shape: ${value}`);
    }
  }
});
