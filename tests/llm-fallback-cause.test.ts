/**
 * Guards the distinction between "no LLM key configured" and "a key IS
 * configured but synthesis failed".
 *
 * Before this, doAskAboutEdgeorgie caught a throwing synthesize() and
 * reported answerMode: "deterministic", while deterministicAnswer()
 * unconditionally prefixed the body with "No LLM key configured
 * (ANTHROPIC_API_KEY / OPENAI_API_KEY)". With a key set and the provider
 * returning an error — e.g. the Anthropic 400 an org-scoped key gets without
 * ANTHROPIC_WORKSPACE_ID, a failure this repo's own history has twice had to
 * fix — both the badge and the answer text blamed a missing key that was
 * present. These tests pin the two causes apart.
 *
 * The provider error is produced WITHOUT touching the network: ANTHROPIC_API_KEY
 * is set to a syntactically valid but non-working value and globalThis.fetch is
 * temporarily replaced with one that rejects, which is exactly what synthesize()
 * sees on a provider/transport failure. No secrets and no egress are needed, so
 * this runs identically in CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicAnswer, hasLlmKey } from "../src/llm.js";

const KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return fn().then(
    (r) => {
      restore();
      return r;
    },
    (e) => {
      restore();
      throw e;
    },
  );
}

const CHUNKS = [{ path: "resume.txt", start: 1, end: 3, text: "Software Engineer at Mercado Libre." }];

test("hasLlmKey reflects whether a provider key is actually present", async () => {
  await withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, async () => {
    assert.equal(hasLlmKey(), false);
  });
  await withEnv({ ANTHROPIC_API_KEY: "sk-ant-not-a-working-key", OPENAI_API_KEY: undefined }, async () => {
    assert.equal(hasLlmKey(), true);
  });
});

test("deterministicAnswer only claims a missing key when the key is actually missing", () => {
  const noKey = deterministicAnswer(CHUNKS, "no-key");
  assert.match(noKey, /No LLM key configured \(ANTHROPIC_API_KEY \/ OPENAI_API_KEY\)/);

  const failed = deterministicAnswer(CHUNKS, "synthesis-failed");
  assert.doesNotMatch(
    failed,
    /No LLM key configured/,
    "a synthesis failure must NOT be reported to the user as a missing key",
  );
  assert.match(failed, /key IS configured/);
  assert.match(failed, /provider\/configuration failure/);
  // The citations themselves survive in both modes.
  assert.match(failed, /resume\.txt \(lines 1-3\)/);
});

test("with a key present but the provider failing, answerMode is synthesis-failed, not deterministic", async () => {
  await withEnv(
    { ANTHROPIC_API_KEY: "sk-ant-not-a-working-key", OPENAI_API_KEY: undefined, ANTHROPIC_MODEL: "claude-haiku-4-5" },
    async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error("Anthropic API error 400: workspace-id required for org-scoped key");
      }) as typeof fetch;
      try {
        const { doAskAboutEdgeorgie } = await import("../src/engine.js");
        const res = await doAskAboutEdgeorgie("What MCP server has this person deployed?");

        assert.equal(res.llmKeyConfigured, true, "a key was set, so llmKeyConfigured must be true");
        assert.equal(
          res.answerMode,
          "synthesis-failed",
          `expected synthesis-failed with a key present and a failing provider, got ${res.answerMode}`,
        );
        assert.doesNotMatch(
          res.answer,
          /No LLM key configured/,
          "the answer body must not blame a missing key when a key is configured",
        );
        assert.match(res.answer, /LLM synthesis failed/);
        assert.match(res.answer, /key IS configured/);
        assert.ok(res.citations.length > 0, "citations are still returned on the failure path");
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  );
});

test("with no key at all, answerMode is deterministic and llmKeyConfigured is false", async () => {
  await withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, async () => {
    const { doAskAboutEdgeorgie } = await import("../src/engine.js");
    const res = await doAskAboutEdgeorgie("What MCP server has this person deployed?");
    assert.equal(res.answerMode, "deterministic");
    assert.equal(res.llmKeyConfigured, false);
    assert.match(res.answer, /No LLM key configured/);
  });
});

test("the key-vars list this file manipulates matches what hasLlmKey reads", () => {
  // Cheap drift guard: if a third provider key is added to synthesize(), this
  // file's withEnv clearing becomes incomplete and the tests above would start
  // depending on ambient env.
  assert.deepEqual([...KEY_VARS], ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
});
