/**
 * Corpus loader + index builder for the "ask about edgeorgie" retrieval tool.
 *
 * The corpus is built ONLY from real, already-written public-evidence files
 * committed to this repo under data/ — direct copies of:
 *   - resume.txt                  (candidate's actual resume)
 *   - RELIABILITY-REPORT.md       (measured pass-rate/latency/accuracy numbers)
 *   - BUILD-LOG.md                (first-person build/debugging narrative)
 *   - RECRUITER-FAQ.md            (candidate's own answers to common questions)
 *
 * This comment is a hand-maintained mirror of CORPUS_FILES below, so
 * tests/corpus-list.test.ts asserts the two agree — it went stale once when a
 * fourth file was added and nothing complained.
 *
 * Internal job-search strategy/process documents (sprint logs, application
 * drafts, case-study talking points) are deliberately NOT part of this
 * corpus — this server only serves public, already-shareable evidence.
 *
 * No other text is added to the corpus and no biographical/project claim is
 * invented here — this module only chunks and indexes what's already on disk.
 * Chunking/TF-IDF/retrieval logic is imported from @edgeorgie/retrieval-core,
 * the package extracted from this file's shared code with repoask-mcp's
 * src/indexer.ts, swapping the "fetch files from a GitHub repo" source for
 * "read local corpus files".
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embedText, fitTfidf, embedBatchTfidf, type Chunk, type TfidfModel, type Vector } from "@edgeorgie/retrieval-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// When running from dist/ (compiled), data/ is copied alongside via the
// "copy-data" build step. When running via tsx from src/, data/ is one level up.
function dataDir(): string {
  const candidates = [
    path.join(__dirname, "data"), // dist/data (after build)
    path.join(__dirname, "..", "data"), // src/../data (dev, tsx)
  ];
  return candidates[0];
}

/** Hard cap inside @edgeorgie/retrieval-core's embedText: input is truncated here. */
const EMBED_INPUT_CAP = 1500;

/**
 * Chunk size in CHARACTERS, not lines.
 *
 * Line counts are the wrong unit for this corpus. Average line length ranges
 * from 54 chars (resume.txt) to 205 (BUILD-LOG.md, which is hard-wrapped at
 * ~76 columns in places and has single lines up to 1820 chars). Any fixed line
 * count is therefore simultaneously too large for one file and too small for
 * another:
 *
 *   - At 30 lines, RECRUITER-FAQ.md chunks hit ~3000 chars and were cut in
 *     half by the embed cap, so "visa", "sponsorship", "salary" and
 *     "relocation" never entered the TF-IDF vocabulary. Queries using them
 *     scored 0.0000 and retrieved nothing at all.
 *   - At 6 lines, BUILD-LOG.md chunks shrank to ~450 chars and split mid-
 *     sentence. "triage-desk and eval-lab are both agent/CI-driven with" ended
 *     one chunk while the evidence that proves it — a link to triage-desk
 *     PR #27 — started the next. Asked for proof an agent drives a project,
 *     the server retrieved the claim without the proof and said it had none.
 *
 * Budgeting by characters fixes both at once: 1400 leaves headroom under the
 * 1500-char cap (0.5% total loss, down from 47.3% at the original setting)
 * while keeping ~1096 chars of context per citation — roughly double what the
 * line-based fix produced.
 *
 * Chosen by measurement: 1400/1200/1000 were compared on loss, context size
 * and retrieval hits, and heading-aware splitting was tried and REJECTED
 * because it fragmented the FAQ and halved hits on visa/English questions.
 */
const CHUNK_CHAR_BUDGET = 1400;

/** Overlap in characters, so a sentence split across a boundary is still recoverable. */
const CHUNK_OVERLAP_CHARS = 250;

/**
 * Splits a file into overlapping windows sized by character budget.
 *
 * Deliberately local rather than pushed into @edgeorgie/retrieval-core: that
 * package's line-based `chunkFile` is also used by repoask-mcp against source
 * repositories, where line windows map onto code structure and citations point
 * at line ranges a reader will scan. This corpus is prose, where the unit that
 * matters is characters against the embed cap. Changing shared behaviour to
 * suit prose would silently alter another server's retrieval.
 *
 * Line numbers are still tracked and returned, so citations keep pointing at
 * exact file+line ranges.
 */
export function chunkByCharBudget(
  filePath: string,
  content: string,
  budget = CHUNK_CHAR_BUDGET,
  overlapChars = CHUNK_OVERLAP_CHARS,
): Chunk[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  // embedText prepends `${path}\n`, so that counts against the budget too.
  const prefix = filePath.length + 1;
  const chunks: Chunk[] = [];

  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = prefix;
    while (end < lines.length) {
      const addition = lines[end].length + 1; // +1 for the newline
      // Always take at least one line: a single line longer than the budget
      // (BUILD-LOG.md has one at 1820 chars) cannot be split by line windows,
      // so it becomes its own chunk and is accepted as irreducible loss.
      if (end > start && size + addition > budget) break;
      size += addition;
      end++;
    }
    if (end === start) end = start + 1;

    const text = lines.slice(start, end).join("\n").trim();
    // Mirrors retrieval-core's chunkFile: skip windows that are essentially blank.
    if (text.length > 20) {
      chunks.push({ path: filePath, start: start + 1, end, text });
    }
    if (end >= lines.length) break;

    // Step back by overlap measured in characters, never past the first line of
    // this window, so progress is guaranteed.
    let back = 0;
    let next = end;
    while (next > start + 1 && back < overlapChars) {
      next--;
      back += lines[next].length + 1;
    }
    start = Math.max(start + 1, next);
  }

  return chunks;
}

export const CORPUS_FILES = [
  "resume.txt",
  "RELIABILITY-REPORT.md",
  "BUILD-LOG.md",
  "RECRUITER-FAQ.md",
] as const;

export interface CorpusIndex {
  chunks: Chunk[];
  vectors: Vector[];
  model: TfidfModel;
  fileCount: number;
  chunkCount: number;
  builtAt: string;
}

let cached: CorpusIndex | null = null;

async function readCorpusFile(name: string): Promise<string> {
  const tried: string[] = [];
  for (const dir of [path.join(__dirname, "data"), path.join(__dirname, "..", "data")]) {
    const p = path.join(dir, name);
    tried.push(p);
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Could not find corpus file ${name} (tried: ${tried.join(", ")})`);
}

export async function buildCorpusIndex(): Promise<CorpusIndex> {
  if (cached) return cached;

  const chunks: Chunk[] = [];
  for (const name of CORPUS_FILES) {
    const text = await readCorpusFile(name);
    // Sized by character budget, not line count — see chunkByCharBudget above
    // for why lines are the wrong unit here and what two bugs that caused.
    chunks.push(...chunkByCharBudget(name, text));
  }
  if (chunks.length === 0) throw new Error("Corpus produced zero chunks — data files missing or empty.");

  const docs = chunks.map(embedText);
  const model = fitTfidf(docs);
  const vectors = embedBatchTfidf(docs, model);

  cached = {
    chunks,
    vectors,
    model,
    fileCount: CORPUS_FILES.length,
    chunkCount: chunks.length,
    builtAt: new Date().toISOString(),
  };
  return cached;
}
