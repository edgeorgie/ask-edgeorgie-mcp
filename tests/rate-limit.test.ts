/**
 * Unit tests for the in-memory rate limiter (src/rate-limit.ts) used by
 * /mcp and /api/ask. No network/server needed — exercises the pure logic
 * directly so it's fast and deterministic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRateLimit, checkQuestionLength, _resetForTests, RATE_LIMIT_CONFIG } from "../src/rate-limit.js";

test("allows requests under the per-caller limit", () => {
  _resetForTests();
  const now = Date.now();
  for (let i = 0; i < RATE_LIMIT_CONFIG.PER_CALLER_MAX_REQUESTS; i++) {
    const result = checkRateLimit("1.2.3.4", now + i);
    assert.equal(result.allowed, true, `request ${i} should be allowed`);
  }
});

test("blocks a caller once they exceed the per-caller limit, with Retry-After", () => {
  _resetForTests();
  const now = Date.now();
  for (let i = 0; i < RATE_LIMIT_CONFIG.PER_CALLER_MAX_REQUESTS; i++) {
    checkRateLimit("5.6.7.8", now + i);
  }
  const blocked = checkRateLimit("5.6.7.8", now + RATE_LIMIT_CONFIG.PER_CALLER_MAX_REQUESTS);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "per-caller");
  assert.ok(typeof blocked.retryAfterSeconds === "number" && blocked.retryAfterSeconds > 0);
});

test("a different caller is not blocked by another caller's usage", () => {
  _resetForTests();
  const now = Date.now();
  for (let i = 0; i < RATE_LIMIT_CONFIG.PER_CALLER_MAX_REQUESTS; i++) {
    checkRateLimit("9.9.9.9", now + i);
  }
  const otherCaller = checkRateLimit("1.1.1.1", now + RATE_LIMIT_CONFIG.PER_CALLER_MAX_REQUESTS);
  assert.equal(otherCaller.allowed, true, "different caller should not share the first caller's bucket");
});

test("the window resets once enough time has elapsed", () => {
  _resetForTests();
  const now = Date.now();
  for (let i = 0; i < RATE_LIMIT_CONFIG.PER_CALLER_MAX_REQUESTS; i++) {
    checkRateLimit("2.2.2.2", now + i);
  }
  const blocked = checkRateLimit("2.2.2.2", now + 1);
  assert.equal(blocked.allowed, false);
  const afterWindow = checkRateLimit("2.2.2.2", now + RATE_LIMIT_CONFIG.PER_CALLER_WINDOW_MS + 1000);
  assert.equal(afterWindow.allowed, true, "request after the window has fully elapsed should be allowed again");
});

test("the global ceiling trips even across many distinct caller IDs", () => {
  // SCOPE, stated because a green test here previously sat next to a README
  // claiming more than this proves: it proves the ceiling holds WITHIN ONE
  // PROCESS. It says nothing about the deployment, and the live measurement
  // contradicts the stronger reading — 40 concurrent POSTs from one IP got
  // 36x200 / 4x429, because each Vercel instance has its own empty Map.
  _resetForTests();
  const now = Date.now();
  let lastResult;
  for (let i = 0; i < RATE_LIMIT_CONFIG.GLOBAL_MAX_REQUESTS + 5; i++) {
    // Every request uses a unique caller ID, so the per-caller limit never trips —
    // only the global ceiling can block these.
    lastResult = checkRateLimit(`caller-${i}`, now + i);
  }
  assert.equal(lastResult!.allowed, false);
  assert.equal(lastResult!.reason, "global");
});

test("checkQuestionLength accepts a question at exactly the limit", () => {
  const atLimit = "a".repeat(RATE_LIMIT_CONFIG.MAX_QUESTION_LENGTH);
  const result = checkQuestionLength(atLimit);
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
});

test("checkQuestionLength rejects one character over the limit, naming the real length", () => {
  const overLimit = "a".repeat(RATE_LIMIT_CONFIG.MAX_QUESTION_LENGTH + 1);
  const result = checkQuestionLength(overLimit);
  assert.equal(result.ok, false);
  // The message must carry both numbers: a caller hitting this needs to know
  // how far over they are, not just that they failed.
  assert.match(result.error ?? "", new RegExp(String(RATE_LIMIT_CONFIG.MAX_QUESTION_LENGTH + 1)));
  assert.match(result.error ?? "", new RegExp(String(RATE_LIMIT_CONFIG.MAX_QUESTION_LENGTH)));
});

test("the cap is small enough to bound prompt cost, and large enough for real questions", () => {
  // Guards the constant itself against a future "just raise it" edit that
  // would quietly restore the unbounded-input-token vector. 19,500 chars is
  // the size actually accepted by production before the cap existed.
  assert.ok(
    RATE_LIMIT_CONFIG.MAX_QUESTION_LENGTH < 19_500,
    "a cap at or above the measured abuse payload bounds nothing",
  );
  assert.ok(
    RATE_LIMIT_CONFIG.MAX_QUESTION_LENGTH >= 500,
    "a cap this low would reject legitimate multi-part questions",
  );
});
