/**
 * Corpus loader + index builder for the "ask about edgeorgie" retrieval tool.
 *
 * The corpus is built ONLY from real, already-written public-evidence files
 * committed to this repo under data/ — direct copies of:
 *   - resume.txt                  (candidate's actual resume)
 *   - RELIABILITY-REPORT.md       (measured pass-rate/latency/accuracy numbers)
 *   - BUILD-LOG.md                (first-person build/debugging narrative)
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
import { chunkFile, embedText, fitTfidf, embedBatchTfidf, type Chunk, type TfidfModel, type Vector } from "@edgeorgie/retrieval-core";

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
    chunks.push(...chunkFile(name, text, 30, 6));
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
