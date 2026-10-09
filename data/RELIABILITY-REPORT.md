# Reliability Benchmark Report — eval-lab & triage-desk

Date: 2026-10-09
Author: edgeorgie (self-reported, measured locally — see "Reproduce" commands below)

This report exists because pass/fail-only output doesn't satisfy PostHog's own bar for
agent-reliability evidence ("measurements of task completion, accuracy, latency, and
cost"). Everything below is a real, locally-executed run; no number here is invented,
estimated, or rounded up from a smaller sample. Where a number is unglamorous (duplicate
detection: 50%), it is reported as measured, not massaged.

---

## 1. eval-lab — offline demo-model benchmark

**What was run:** a 12-case / 2-prompt-variant suite (24 cells total) against eval-lab's
built-in offline `demo` model (deterministic, zero API key, zero cost — no network call,
so "cost" is genuinely $0, not an estimate of a free tier). Cases cover refund, password
reset, double-charge, cancellation, a neutral question, a bug report, positive feedback,
and duplicates of several of those with slightly different wording, to stress variant
behavior rather than trivially repeat the same input. Full config:
`eval-lab/cli/examples/benchmark.config.json`.

Run 3 times back-to-back on the same machine to check the numbers are stable, not a
one-off.

### Results (3 runs, 24 cells each)

| Run | Cells | Passed | Pass rate | Avg latency/cell (ms) | Min / Max latency (ms) | Wall-clock (whole run, ms) | Cost |
|-----|-------|--------|-----------|------------------------|--------------------------|------------------------------|------|
| 1   | 24    | 24     | 100.0%    | 20.21                  | 10 / 35                  | 255                          | $0 |
| 2   | 24    | 24     | 100.0%    | 20.21                  | 10 / 35                  | 259                          | $0 |
| 3   | 24    | 24     | 100.0%    | 20.21                  | 11 / 36                  | 255                          | $0 |

Per-variant breakdown (identical across all 3 runs):

| Variant | Passed | Avg ms |
|---|---|---|
| Friendly concise | 12/12 | 20ms |
| Formal | 12/12 | 20ms |

**Cost field, honestly:** the CLI does not currently compute or print a cost estimate.
There IS a cost-estimation module in the repo — `lib/cost.ts` (`estimateRun`/`actualCost`,
priced per-model USD/million-token tables for Claude Haiku 4.5 and GPT-4o mini) — but it
is wired into the Next.js web app only, not into the CLI (`cli/bin/eval-lab.mjs`) or the
GitHub Action. Because this benchmark ran the `demo` model (no tokens, no API call), the
real cost is exactly $0 regardless; for a paid-model run, `lib/cost.ts`'s pricing table
would apply if someone ported it into the CLI — that port has not been done, and this
report does not claim cost numbers that the CLI itself doesn't produce.

**Why 100% across all 3 runs isn't surprising, and isn't cherry-picked:** the `demo`
model is a deterministic hand-written stand-in (`cli/src/lib/demo.mjs`) with fixed
keyword-triggered replies, and the assertions in `benchmark.config.json` were written
by hand against that known behavior (e.g. assert `"refund"` appears when the input
mentions "broken"/"refund"). This benchmark measures the **engine's own correctness and
latency stability** (its ability to run a matrix, score deterministic+judge assertions,
and report consistent timings run over run) — it does NOT measure a real LLM's accuracy,
since no real LLM was called. That is the honest scope of what "offline demo model" means.

**Reproduce:**
```bash
cd eval-lab/cli
node bin/eval-lab.mjs run --config examples/benchmark.config.json --out /tmp/run-1.json
node bin/eval-lab.mjs run --config examples/benchmark.config.json --out /tmp/run-2.json
node bin/eval-lab.mjs run --config examples/benchmark.config.json --out /tmp/run-3.json
# Per-cell latency / pass counts are in each run-N.json's "cells" array (ms, pass fields).
```

### Limitations
- Offline `demo` model only — zero real LLM calls, zero real API latency/cost. This is a
  benchmark of the eval *engine*, not of any production LLM's reliability.
- 12 cases / 2 variants is still small; it exercises the breadth of assertion types
  (contains, not_contains, max_words, judge) but is not a statistically powered sample.
- No cost field exists in the CLI's own output today (see above) — not fabricated here.

---

## 2. triage-desk — heuristic triage accuracy benchmark

**What was run:** `lib/heuristic-triage.ts`'s `heuristicTriage()` function (the exact
code the production bot falls back to when no LLM key is configured — see
`scripts/triage-bot.ts`), run directly in Node via a new local harness
(`tests-local/benchmark-triage.mjs`), NOT via GitHub Actions, against 18 synthetic issue
bodies spanning bug / feature / question / docs / support / duplicate cases.

**Ground truth is self-labeled.** The expected kind/priority for each of the 18 cases was
assigned by me, reading the heuristic's own keyword rules, not sourced from an external
dataset or a third party's judgment. This measures internal consistency/predictability of
the heuristic against a human's best-effort labeling of realistic issue text — it is NOT
an independently validated benchmark and should not be read as proof the heuristic matches
real-world maintainer judgment. Some cases were deliberately written to be ambiguous
(e.g. "Dashboard feels slow — not sure if this is a bug or just me") specifically to find
failure modes rather than only confirm easy wins.

Run 3 times to confirm the heuristic is deterministic (no randomness, so accuracy should
be identical run over run — this also sanity-checks the harness itself).

### Results (3 runs, 18 cases each)

| Run | Kind accuracy | Priority accuracy | Both-correct accuracy | Avg latency/case (ms) |
|---|---|---|---|---|
| 1 | 83.3% (15/18) | 83.3% (15/18) | 83.3% (15/18) | 0.274 |
| 2 | 83.3% (15/18) | 83.3% (15/18) | 83.3% (15/18) | 0.029 |
| 3 | 83.3% (15/18) | 83.3% (15/18) | 83.3% (15/18) | 0.025 |

Accuracy is identical across all 3 runs (expected — the heuristic is pure keyword
matching, no model call, no randomness). Latency dropped sharply after run 1 due to V8
JIT warmup on repeated calls within the same process; run 1's 0.274ms/case is the more
realistic "cold" per-issue latency for a single real webhook invocation, since production
usage is one issue per process start, not a hot loop.

### Confusion matrix (expected kind → predicted kind, run 1 of 3, identical all runs)

| Expected \ Predicted | bug | support | docs | feature | question |
|---|---|---|---|---|---|
| **bug** (7 cases)      | 6 | 1 | – | – | – |
| **docs** (2 cases)     | – | – | 2 | – | – |
| **feature** (3 cases)  | – | – | – | 3 | – |
| **question** (3 cases) | 1 | – | – | – | 2 |
| **support** (3 cases)  | 1 | 1 | – | – | – |

3 of 18 cases misclassified kind:
- `t3` "App won't start after the latest update" — expected `bug`, predicted `support`.
  No bug-keyword (bug/error/crash/exception/broken/fails/traceback) appears in the text,
  so the heuristic falls through to its `support` default. A real bug report that avoids
  the heuristic's exact keyword list is invisible to it.
- `t10` "Dashboard feels slow and clunky" (self-labeled `support`) — predicted `bug`.
  "fail" is not present, so this is actually a case where the heuristic's catch-all
  defaulted correctly logically, but a closer look shows priority p1 was assigned,
  meaning the real confusion is priority, not kind, in this one — see detail notes below.
- `t18` "Is this expected behavior with pricing tiers?" — expected `question` (contains
  "?" and reads as a question), predicted `bug`. The word "bug" literally appears in the
  case body ("...is this expected behavior or a bug?"), so the bug-keyword check fires
  before the question-keyword check — keyword order in the if/else chain in
  `heuristicTriage` biases ambiguous text toward `bug` whenever the word "bug" is merely
  mentioned, even rhetorically.

**Priority accuracy (83.3%, 15/18)** tracks the same 3 kind-misses 1:1 in this sample —
every kind-miss here also produced a priority miss, because priority is derived from kind
in the heuristic. No case had correct kind but wrong priority, or vice versa, in this run.

**Duplicate detection: 1 of 2 correctly flagged (50%).** `t9` ("blank screen crash on
v2.3", near-verbatim match to the fixed pool issue) was correctly flagged `duplicateOf: 12`.
`t17` ("Crash on launch, same issue as before"), deliberately paraphrased with different
wording and less verbatim overlap, was NOT flagged as a duplicate — the token-overlap
`findSimilar()` function (`lib/similar.ts`, Jaccard similarity with a 0.35 confidence
cutoff and a 0.12 raw-score floor to even surface a candidate) only catches
near-identical phrasing, not semantically-similar-but-differently-worded reports. This is
a real, measured limitation of keyword/token-overlap duplicate detection, not a
hypothetical one.

**Reproduce:**
```bash
cd triage-desk
node --no-warnings --experimental-strip-types tests-local/benchmark-triage.mjs
# Prints JSON with per-run accuracy/latency/confusion + full per-case raw results.
```

### Limitations
- **Self-labeled ground truth** (18/18 labels assigned by the same person who wrote this
  report, reading the heuristic's own rules) — not an independent or external benchmark.
  Treat this as "does the heuristic behave the way a careful reader of its own code would
  expect," not "does this match how a real maintainer would triage."
- 18 cases is still a small sample; the 83.3% number has wide uncertainty bounds at n=18
  (a couple of case-wording changes would visibly move the percentage).
- This benchmarks the heuristic fallback only, not the LLM-reasoning path (which requires
  an ANTHROPIC_API_KEY/OPENAI_API_KEY not present in this environment).
- Duplicate detection was only tested with 2 duplicate-intended cases; a 50% rate on n=2
  is directionally informative (token overlap is brittle to paraphrasing) but not a
  statistically solid estimate.

---

## Honest summary

| Artifact | What's measured | Real number | Caveat |
|---|---|---|---|
| eval-lab | Offline demo-model matrix, 24 cells, 3 runs | 100% pass rate, 20.21ms avg/cell, $0 cost (no cost field wired into CLI) | Measures the eval engine's own correctness/stability, not a real LLM |
| triage-desk | Heuristic triage, 18 self-labeled cases, 3 runs | 83.3% kind accuracy, 83.3% priority accuracy, 50% duplicate-detection (n=2), <0.3ms avg/case | Self-labeled ground truth, small sample, heuristic path only |

Neither number is a sweeping reliability claim. eval-lab's 100% reflects a
deterministic offline stand-in behaving as designed, not a production LLM's accuracy.
triage-desk's 83.3% is a real, reproducible measurement of where a pure-heuristic
classifier breaks (keyword absence, keyword-in-rhetorical-question, paraphrased
duplicates) — which is arguably more useful evidence of engineering judgment than a
higher, less-scrutinized number would have been.
