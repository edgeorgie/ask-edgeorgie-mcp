/**
 * Guard: no corpus chunk may lose text to the embedder's input cap.
 *
 * `embedText` from @edgeorgie/retrieval-core truncates its input to 1500
 * characters before the TF-IDF vocabulary is fitted. Anything past that point
 * is not merely ranked lower — it never becomes a term, so a query using those
 * words scores 0.0000 against every chunk in the corpus and retrieval returns
 * nothing at all.
 *
 * This shipped, and it was the cause of the server's worst behaviour. At the
 * original 30-line/6-overlap setting, RECRUITER-FAQ.md — the file holding
 * Edwin's own answers to recruiter questions — became two ~3000-char chunks,
 * each cut in half. "visa", "sponsorship", "salary" and "relocation" were all
 * in the file and none were in the vocabulary. Asked "Do you need visa
 * sponsorship?", the server retrieved ZERO chunks and replied that it had no
 * such information, directly contradicting the prompt's own instruction not to
 * deflect when the answer is in the corpus. Measured across the corpus,
 * 47.3% of all embed input was being discarded.
 *
 * Nothing caught it: the text was present in `data/`, every chunk had a valid
 * line range, citations looked well-formed, and the full suite was green. The
 * loss happened inside the embedder, after chunking and before scoring.
 *
 * The check is derived from the real index and the real embedder, so it keeps
 * holding when corpus files grow or chunk settings change — the two ways this
 * regresses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCorpusIndex } from "../src/corpus.js";

/** Mirrors the cap inside @edgeorgie/retrieval-core's embedText. */
const EMBED_INPUT_CAP = 1500;

/**
 * Budget, not zero. One line in BUILD-LOG.md is 1820 chars on its own, so no
 * window size can keep every chunk under the cap — a single oversized line is
 * irreducible by chunking. The budget is set just above the measured 8.5% so
 * it fails on a real regression (a corpus edit or a larger window) without
 * demanding the impossible.
 */
const MAX_LOSS_RATIO = 0.1;

test("corpus loss to the embed cap stays within budget", async () => {
  const index = await buildCorpusIndex();
  let total = 0;
  let lost = 0;
  const truncated: string[] = [];

  for (const c of index.chunks) {
    const full = `${c.path}\n${c.text}`;
    total += full.length;
    if (full.length > EMBED_INPUT_CAP) {
      lost += full.length - EMBED_INPUT_CAP;
      truncated.push(`  ${c.path}:${c.start}-${c.end} = ${full.length} chars`);
    }
  }

  const ratio = lost / total;
  assert.ok(
    ratio <= MAX_LOSS_RATIO,
    `${(ratio * 100).toFixed(1)}% of embed input is discarded by the ${EMBED_INPUT_CAP}-char ` +
      `cap (budget ${(MAX_LOSS_RATIO * 100).toFixed(0)}%). Terms past the cap never enter the ` +
      `vocabulary, so queries using them score 0 against every chunk:\n${truncated.join("\n")}`,
  );
});

test("recruiter-FAQ terms are actually in the fitted vocabulary", async () => {
  const index = await buildCorpusIndex();
  const vocab = index.model.vocab as unknown;
  const terms =
    vocab instanceof Map ? new Set(vocab.keys()) : new Set(Object.keys(vocab as object));

  // Every one of these is a word a recruiter types and that Edwin answered in
  // his own words. Each was missing from the vocabulary before the chunk-size
  // fix, which is why the server claimed to have no information about them.
  for (const term of ["visa", "sponsorship", "salary", "relocation"]) {
    assert.ok(
      terms.has(term),
      `"${term}" is in the corpus text but not in the TF-IDF vocabulary — ` +
        `queries using it will score 0 against every chunk`,
    );
  }
});

test("a question answered in the FAQ retrieves the FAQ", async () => {
  const { retrieveFromCorpus } = await import("../src/retrieval.js");
  const index = await buildCorpusIndex();

  // Phrased the way a recruiter would, not as keywords.
  for (const q of [
    "Do you need visa sponsorship?",
    "What is your salary expectation?",
    "Are you open to relocation?",
  ]) {
    const cites = retrieveFromCorpus(index, q, 6);
    assert.ok(cites.length > 0, `"${q}" retrieved nothing at all`);
    assert.ok(
      cites.some((c) => c.source.includes("RECRUITER-FAQ")),
      `"${q}" did not retrieve RECRUITER-FAQ.md, which contains the answer; ` +
        `got: ${cites.map((c) => c.source).join(", ")}`,
    );
  }
});

test("a claim and the evidence that proves it land in the same chunk", async () => {
  const { retrieveFromCorpus } = await import("../src/retrieval.js");
  const index = await buildCorpusIndex();

  // The regression this guards: at 6-line windows, BUILD-LOG.md split
  // "triage-desk and eval-lab are both agent/CI-driven with" from the link to
  // triage-desk PR #27 that substantiates it. The server then retrieved the
  // claim, could not see the proof, and told a recruiter asking for evidence
  // that it had none — while the evidence sat one chunk away.
  const cites = retrieveFromCorpus(
    index,
    "Show me proof an AI agent actually drives one of his projects.",
    6,
  );
  assert.ok(cites.length > 0, "retrieved nothing at all");
  assert.ok(
    cites.some((c) => /pull\/27/.test(c.excerpt)),
    `no retrieved chunk contains the PR link that proves the claim; got:\n` +
      cites.map((c) => `  ${c.source}:${c.startLine}-${c.endLine}`).join("\n"),
  );
});

test("chunks are sized by character budget, not line count", async () => {
  const index = await buildCorpusIndex();

  // Guards the unit itself. Line-based windows are wrong for this corpus
  // because average line length ranges from 54 to 205 chars across files, so
  // one line count is too coarse for one file and too fine for another. If a
  // future change reverts to line windows, chunk sizes diverge wildly again.
  const sizes = index.chunks.map((c) => `${c.path}\n${c.text}`.length);
  const oversized = sizes.filter((n) => n > EMBED_INPUT_CAP).length;

  // Only genuinely unsplittable lines may exceed the cap. BUILD-LOG.md has
  // exactly one such line (1820 chars); allow a little room, not a free pass.
  assert.ok(
    oversized <= 2,
    `${oversized} chunks exceed the ${EMBED_INPUT_CAP}-char cap; only lines too long ` +
      `to split should. Sizes: ${sizes.filter((n) => n > EMBED_INPUT_CAP).join(", ")}`,
  );
});
