/**
 * Pins the provider layer (src/llm/providers.ts, src/llm.ts) and the fallback
 * text (src/llm/fallback.ts).
 *
 * The regression this file exists for, observed in production on 2026-11-14:
 * the Anthropic key on the live deployment was rejected (401
 * `invalid x-api-key`), and doAskAboutEdgeorgie pasted the provider's raw error
 * body — JSON, error type, request id — into the public `answer`, so the
 * portfolio's "Ask" terminal opened every reply with it. Nothing was logged
 * server-side. These tests replay exactly that response with a stubbed fetch
 * (no network, no secrets) and assert the body stays out of the answer and
 * goes to the log instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesize, SynthesisError } from "../src/llm.js";
import { statusToReason, configuredProviders } from "../src/llm/providers.js";
import { deterministicAnswer, excerptForDisplay, MAX_EXCERPTS } from "../src/llm/fallback.js";

const KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_MODEL", "OPENAI_MODEL", "ANTHROPIC_WORKSPACE_ID"] as const;

type FetchStub = (url: string, init: RequestInit) => Promise<Response>;

/** Runs fn with the given env and fetch stub, capturing console.error lines. */
async function withStubs<T>(env: Partial<Record<(typeof KEY_VARS)[number], string>>, stub: FetchStub, fn: (logs: string[]) => Promise<T>): Promise<T> {
  const savedEnv = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
  for (const k of KEY_VARS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const logs: string[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => stub(String(url), init)) as typeof fetch;
  console.error = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  try {
    return await fn(logs);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const ANTHROPIC_401_BODY = JSON.stringify({
  type: "error",
  error: { type: "authentication_error", message: "invalid x-api-key" },
  request_id: "req_011Ch1v38oqsuUs9Vb4HVEFo",
});

const anthropic401: FetchStub = async () =>
  new Response(ANTHROPIC_401_BODY, { status: 401, headers: { "content-type": "application/json", "request-id": "req_011Ch1v38oqsuUs9Vb4HVEFo" } });

const CHUNKS = [{ path: "resume.txt", start: 1, end: 3, text: "Software Engineer at Mercado Libre." }];

test("statusToReason classifies provider statuses", () => {
  assert.equal(statusToReason(401), "auth");
  assert.equal(statusToReason(403), "auth");
  assert.equal(statusToReason(429), "rate_limited");
  assert.equal(statusToReason(529), "rate_limited");
  assert.equal(statusToReason(400), "provider_error");
  assert.equal(statusToReason(500), "provider_error");
});

test("a blank or whitespace key does not count as configured", () => {
  assert.equal(configuredProviders({ ANTHROPIC_API_KEY: "   ", OPENAI_API_KEY: "" }).length, 0);
  assert.deepEqual(
    configuredProviders({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b" }).map((p) => p.name),
    ["anthropic", "openai"],
  );
});

test("a rejected key throws SynthesisError(auth) and logs the provider detail server-side", async () => {
  await withStubs({ ANTHROPIC_API_KEY: "sk-ant-revoked" }, anthropic401, async (logs) => {
    await assert.rejects(
      () => synthesize("q", "label", CHUNKS),
      (err: unknown) => err instanceof SynthesisError && err.reason === "auth" && err.provider === "anthropic",
    );
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[llm\] anthropic auth: HTTP 401 \(request-id req_011Ch1v38oqsuUs9Vb4HVEFo\)/);
    assert.match(logs[0], /invalid x-api-key/, "the detail must reach the log, which is the only place it belongs");
  });
});

test("the production 401 never reaches the public answer", async () => {
  await withStubs({ ANTHROPIC_API_KEY: "sk-ant-revoked" }, anthropic401, async () => {
    const { doAskAboutEdgeorgie } = await import("../src/engine.js");
    const res = await doAskAboutEdgeorgie("What has this person built with AI agents?");
    assert.equal(res.answerMode, "synthesis-failed");
    assert.equal(res.fallbackReason, "auth");
    assert.equal(res.llmKeyConfigured, true);
    for (const leak of [/invalid x-api-key/, /authentication_error/, /req_011/, /HTTP 401/, /Anthropic API error/, /\{"type"/]) {
      assert.doesNotMatch(res.answer, leak, `answer leaked provider text matching ${leak}`);
      assert.doesNotMatch(JSON.stringify(res), leak, `structured result leaked provider text matching ${leak}`);
    }
    assert.ok(res.citations.length > 0);
  });
});

test("with both keys, an Anthropic failure falls through to OpenAI", async () => {
  const calls: string[] = [];
  const stub: FetchStub = async (url) => {
    calls.push(new URL(url).host);
    if (url.includes("anthropic")) return anthropic401(url, {});
    return new Response(JSON.stringify({ choices: [{ message: { content: "Answer from OpenAI [1]." } }] }), { status: 200 });
  };
  await withStubs({ ANTHROPIC_API_KEY: "sk-ant-revoked", OPENAI_API_KEY: "sk-openai" }, stub, async (logs) => {
    const res = await synthesize("q", "label", CHUNKS);
    assert.deepEqual(calls, ["api.anthropic.com", "api.openai.com"]);
    assert.equal(res?.provider, "openai");
    assert.equal(res?.model, "gpt-4o-mini");
    assert.equal(res?.answer, "Answer from OpenAI [1].");
    assert.equal(logs.length, 1, "the Anthropic failure is still logged");
  });
});

test("a provider timeout is classified as timeout, and the request carries an abort signal", async () => {
  let sawSignal = false;
  const stub: FetchStub = async (_url, init) => {
    sawSignal = init.signal instanceof AbortSignal;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  await withStubs({ ANTHROPIC_API_KEY: "sk-ant" }, stub, async () => {
    await assert.rejects(() => synthesize("q", "label", CHUNKS), (err: unknown) => err instanceof SynthesisError && err.reason === "timeout");
    assert.ok(sawSignal, "every provider call must be bounded by a timeout signal");
  });
});

test("a 200 with no text is a failure, not an empty llm answer", async () => {
  const stub: FetchStub = async () => new Response(JSON.stringify({ content: [] }), { status: 200 });
  await withStubs({ ANTHROPIC_API_KEY: "sk-ant" }, stub, async () => {
    await assert.rejects(() => synthesize("q", "label", CHUNKS), (err: unknown) => err instanceof SynthesisError && err.reason === "empty_response");
  });
});

test("a successful Anthropic call sends the workspace header only when configured", async () => {
  const seen: Record<string, string>[] = [];
  const stub: FetchStub = async (_url, init) => {
    seen.push(init.headers as Record<string, string>);
    return new Response(JSON.stringify({ content: [{ type: "text", text: "  Grounded answer [1].  " }] }), { status: 200 });
  };
  await withStubs({ ANTHROPIC_API_KEY: "sk-ant" }, stub, async () => {
    const res = await synthesize("q", "label", CHUNKS);
    assert.deepEqual(res, { answer: "Grounded answer [1].", provider: "anthropic", model: "claude-haiku-4-5" });
  });
  await withStubs({ ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_WORKSPACE_ID: "wrkspc_1" }, stub, async () => {
    await synthesize("q", "label", CHUNKS);
  });
  assert.equal(seen[0]["anthropic-workspace-id"], undefined);
  assert.equal(seen[1]["anthropic-workspace-id"], "wrkspc_1");
});

test("the fallback answer skips mostly-overlapping excerpts and caps how many it quotes", () => {
  const chunks = [
    { path: "RECRUITER-FAQ.md", start: 79, end: 86, text: "One engine, two audiences." },
    { path: "BUILD-LOG.md", start: 32, end: 36, text: "agentlens: tracing my own agents." },
    { path: "RECRUITER-FAQ.md", start: 75, end: 82, text: "The harness matters more than the prompt." }, // 4/8 lines overlap [1]: kept
    { path: "RECRUITER-FAQ.md", start: 80, end: 85, text: "Overlaps [1] almost entirely." }, // 6/6 overlap: skipped
    { path: "resume.txt", start: 1, end: 5, text: "A fifth excerpt beyond the cap." },
  ];
  const answer = deterministicAnswer(chunks, "no-key");
  assert.match(answer, /\[1\] RECRUITER-FAQ\.md \(lines 79-86\)\n> One engine/);
  assert.match(answer, /\[2\] BUILD-LOG\.md/);
  assert.match(answer, /\[3\] RECRUITER-FAQ\.md \(lines 75-82\)/);
  assert.doesNotMatch(answer, /\[4\]/, "a chunk inside one already shown is skipped");
  assert.doesNotMatch(answer, /\[5\]/, `at most ${MAX_EXCERPTS} excerpts are quoted`);
});

test("excerptForDisplay drops heading markers and trims to a sentence end", () => {
  assert.equal(excerptForDisplay("## Heading\n\nFirst line.\nSecond line."), "Heading — First line. Second line.");
  const twoSections = `## Q one?\n${"Answer one is long enough. ".repeat(6)}\n## Q two?\nAnswer two.`;
  assert.doesNotMatch(excerptForDisplay(twoSections), /Q two/, "stops at the next section heading");
  const long = `${"Alpha beta gamma. ".repeat(30)}`;
  const out = excerptForDisplay(long, 100);
  assert.ok(out.length <= 102, `got ${out.length} chars`);
  assert.match(out, /gamma\. …$/);
});
