/**
 * Derived guard for the hand-maintained mirrors of CORPUS_FILES.
 *
 * `src/corpus.ts` exports CORPUS_FILES — the real, authoritative list of files
 * the retrieval index is built from. Three places restate that list in prose
 * for humans and for calling agents:
 *
 *   1. src/corpus.ts's own header comment (the bullet list above the export)
 *   2. src/create-server.ts's ask_about_edgeorgie tool description
 *   3. README.md's "## The corpus" section
 *
 * None of those is updated by the compiler when CORPUS_FILES gains a member,
 * and all three silently went stale when RECRUITER-FAQ.md was added: the tool
 * description told every calling agent the corpus contained three files while
 * the server was indexing and citing four. That is the same drift class as the
 * /health tool-list bug, so it gets the same treatment — the expected set is
 * DERIVED from the real constant at runtime and compared against each mirror
 * parsed out of the source, so the two cannot diverge again without a failure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CORPUS_FILES } from "../src/corpus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** Every corpus filename that appears in a chunk of text, in sorted order. */
function mentionedCorpusFiles(text: string): string[] {
  return [...CORPUS_FILES].filter((name) => text.includes(name)).sort();
}

const expected = [...CORPUS_FILES].sort();

test("src/corpus.ts's own header comment lists every indexed corpus file", async () => {
  const source = await fs.readFile(path.join(repoRoot, "src", "corpus.ts"), "utf8");
  // Only the header block, i.e. everything before the export itself, so the
  // export's own text can't satisfy the assertion about the prose.
  const header = source.slice(0, source.indexOf("export const CORPUS_FILES"));
  assert.ok(header.length > 0, "could not locate the CORPUS_FILES export");
  assert.deepEqual(
    mentionedCorpusFiles(header),
    expected,
    `src/corpus.ts's header comment mentions ${mentionedCorpusFiles(header).join(",")} ` +
      `but CORPUS_FILES indexes ${expected.join(",")}`,
  );
});

test("the ask_about_edgeorgie tool description lists every indexed corpus file", async () => {
  const source = await fs.readFile(path.join(repoRoot, "src", "create-server.ts"), "utf8");
  const start = source.indexOf('"ask_about_edgeorgie"');
  assert.ok(start !== -1, "could not locate the ask_about_edgeorgie registration");
  // The description is the next ~2kB; bounded so a later tool's text can't
  // accidentally satisfy this.
  const description = source.slice(start, start + 2000);
  assert.deepEqual(
    mentionedCorpusFiles(description),
    expected,
    `the ask_about_edgeorgie description advertises ${mentionedCorpusFiles(description).join(",")} ` +
      `but CORPUS_FILES indexes ${expected.join(",")} — a calling agent is being told the ` +
      `corpus is smaller than it really is`,
  );
});

test("README.md's corpus section lists every indexed corpus file", async () => {
  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
  const start = readme.indexOf("## The corpus");
  assert.ok(start !== -1, "could not locate README's '## The corpus' section");
  const rest = readme.slice(start + "## The corpus".length);
  const end = rest.indexOf("\n## ");
  const section = end === -1 ? rest : rest.slice(0, end);
  // Only the bullet list, not the surrounding prose — otherwise an explanatory
  // sentence that happens to name a corpus file would satisfy this assertion
  // vacuously while the actual list stayed stale.
  const bullets = section
    .split("\n")
    .filter((line) => line.startsWith("- ") || line.startsWith("  "))
    .join("\n");
  assert.deepEqual(
    mentionedCorpusFiles(bullets),
    expected,
    `README's corpus bullet list names ${mentionedCorpusFiles(bullets).join(",")} ` +
      `but CORPUS_FILES indexes ${expected.join(",")}`,
  );
});
