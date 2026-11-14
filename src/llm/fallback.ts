/**
 * The answer returned when no model writes one: the best-matching excerpts,
 * quoted directly, each under its citation.
 *
 * Two audiences read this text — an agent calling `ask_about_edgeorgie`, and a
 * person in the portfolio's terminal, which renders it as Markdown — so it
 * has to work for both:
 *   - The preamble states the cause in one sentence. The precise cause is in
 *     structured fields (`answerMode`, `llmKeyConfigured`, `fallbackReason`),
 *     not prose, and NEVER includes provider error text (see ./providers.ts).
 *   - Excerpts are trimmed to a sentence boundary and quoted, instead of the
 *     first 8 raw lines of each chunk, which cut mid-sentence and pasted
 *     half-headings into the answer.
 *   - Chunks overlap by design (src/corpus.ts CHUNK_OVERLAP_CHARS), so the top
 *     results often repeat the same passage. Excerpts that mostly overlap one
 *     already shown are skipped; their [n] stays in `citations`.
 */
import type { Chunk } from "@edgeorgie/retrieval-core";

export type FallbackCause = "no-key" | "synthesis-failed";

/** At most this many excerpts in the prose answer; `citations` still carries all of them. */
export const MAX_EXCERPTS = 3;
const EXCERPT_CHAR_LIMIT = 420;

export const NO_KEY_PREAMBLE =
  "No LLM key configured (ANTHROPIC_API_KEY / OPENAI_API_KEY), so this answer quotes the most relevant " +
  "source excerpts directly. Each one is cited by file and line range.";

export const SYNTHESIS_FAILED_PREAMBLE =
  "LLM synthesis is temporarily unavailable (a model key is configured, but the provider call did not " +
  "succeed), so this answer quotes the most relevant source excerpts directly. Each one is cited by file " +
  "and line range.";

export const NO_MATCH_ANSWER = "No sufficiently similar chunks were found in the index for this question.";

/** Fraction of a chunk's lines that may overlap an already-shown chunk before it is skipped. */
const OVERLAP_SKIP_RATIO = 0.5;

function overlapRatio(a: Chunk, b: Chunk): number {
  if (a.path !== b.path) return 0;
  const lo = Math.max(a.start, b.start);
  const hi = Math.min(a.end, b.end);
  if (hi < lo) return 0;
  return (hi - lo + 1) / (a.end - a.start + 1);
}

/**
 * Collapses a chunk to readable prose: drops Markdown heading markers and
 * blank runs, then trims to the last sentence end under the limit.
 */
export function excerptForDisplay(text: string, limit = EXCERPT_CHAR_LIMIT): string {
  const parts: string[] = [];
  let length = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+/.test(line);
    // A heading after real content starts a different section (the FAQ is
    // one question per heading): stop there instead of bleeding into it.
    if (heading && length >= 120) break;
    const clean = line.replace(/^#{1,6}\s+/, "");
    parts.push(heading ? `${clean} —` : clean);
    length += clean.length + 1;
  }
  const flat = parts.join(" ").replace(/\s+/g, " ").replace(/ —$/, "").trim();
  if (flat.length <= limit) return flat;
  const window = flat.slice(0, limit);
  const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
  // Only cut at a sentence end if it keeps a meaningful amount of text.
  const cut = sentenceEnd > limit * 0.5 ? sentenceEnd + 1 : window.lastIndexOf(" ");
  return `${flat.slice(0, cut > 0 ? cut : limit).trimEnd()} …`;
}

export function deterministicAnswer(chunks: Chunk[], cause: FallbackCause = "no-key"): string {
  if (chunks.length === 0) return NO_MATCH_ANSWER;

  const shown: { n: number; chunk: Chunk }[] = [];
  chunks.forEach((chunk, i) => {
    if (shown.length >= MAX_EXCERPTS) return;
    if (shown.some((s) => overlapRatio(chunk, s.chunk) > OVERLAP_SKIP_RATIO)) return;
    shown.push({ n: i + 1, chunk });
  });

  const blocks = shown.map(
    // Plain "[n] file (lines a-b)" rather than bold Markdown: the static web
    // UI in public/ renders this as escaped text, where ** would show raw.
    // "> " reads as a quote in both plain text and Markdown.
    ({ n, chunk }) => `[${n}] ${chunk.path} (lines ${chunk.start}-${chunk.end})\n> ${excerptForDisplay(chunk.text)}`,
  );
  const preamble = cause === "no-key" ? NO_KEY_PREAMBLE : SYNTHESIS_FAILED_PREAMBLE;
  return `${preamble}\n\n${blocks.join("\n\n")}`;
}
