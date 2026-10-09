/**
 * Retrieval over the local corpus (resume.txt, RELIABILITY-REPORT.md,
 * BUILD-LOG.md — public evidence only).
 * Same scoring contract as repoask-mcp's src/retrieval.ts: both import
 * embedTfidf/topK/diversify from @edgeorgie/retrieval-core and apply them to
 * their own index, so one document can't crowd out the rest, return
 * citations with exact source file + line range.
 */

import type { CorpusIndex } from "./corpus.js";
import { embedTfidf, topK, diversify, type Scored, type Chunk } from "@edgeorgie/retrieval-core";

export interface Citation {
  rank: number;
  source: string;
  startLine: number;
  endLine: number;
  score: number;
  excerpt: string;
}

export function retrieveFromCorpus(index: CorpusIndex, question: string, k = 6): Citation[] {
  const q = embedTfidf(question, index.model);
  const scored: Scored[] = topK(q, index.vectors, Math.max(k * 3, 12), 0.03);
  const diversified = diversify(scored, (i) => index.chunks[i].path, 3).slice(0, k);
  return diversified.map((s, rank) => {
    const c: Chunk = index.chunks[s.index];
    return {
      rank: rank + 1,
      source: c.path,
      startLine: c.start,
      endLine: c.end,
      score: Math.round(s.score * 1000) / 1000,
      excerpt: c.text,
    };
  });
}
