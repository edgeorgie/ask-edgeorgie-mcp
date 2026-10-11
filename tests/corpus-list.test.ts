/**
 * Derived guard for every hand-maintained mirror of CORPUS_FILES.
 *
 * `src/corpus.ts` exports CORPUS_FILES — the real, authoritative list of files
 * the retrieval index is built from. Several places restate that list in prose
 * for humans and for calling agents, and none of them is updated by the
 * compiler when CORPUS_FILES changes. All of them silently went stale when
 * RECRUITER-FAQ.md was added: the tool description told every calling agent
 * the corpus contained three files while the server was indexing and citing
 * four.
 *
 * The mirrors gated here:
 *
 *   1. src/corpus.ts's own header comment (the bullet list above the export)
 *   2. src/create-server.ts's ask_about_edgeorgie tool description
 *   3. README.md's "## The corpus" section
 *   4. README.md's tools table row for ask_about_edgeorgie
 *   5. examples/transcript.json      — the committed agent transcript
 *   6. examples/http-transcript.json — ditto, over HTTP
 *
 * WHY THE COMPARISON IS BIDIRECTIONAL. The first version of this guard asked
 * only "is every real corpus file mentioned?", via
 * `CORPUS_FILES.filter(n => text.includes(n))`. That is a subset test, and it
 * let three real defects through with the whole suite green:
 *
 *   - a mirror naming files that DO NOT EXIST (a description advertising a
 *     `SALARY-NEGOTIATION-NOTES.md` would pass). Over-advertising is the worst
 *     failure mode for a provenance tool: a caller is told evidence exists
 *     that cannot be shown.
 *   - a rename to a SUPERSTRING: `OLD-BUILD-LOG.md` contains the substring
 *     `BUILD-LOG.md`, so `includes()` was satisfied by a filename the
 *     retriever would never cite.
 *   - shrinking CORPUS_FILES itself, which shrinks the derived expectation, so
 *     every mirror could be left overstating the corpus with no failure.
 *
 * So instead of asking the constant what to look for, each mirror is parsed
 * for ALL corpus-file-shaped tokens (`FOO-BAR.md`, `resume.txt`) with real
 * token boundaries, and that set is compared for EQUALITY against
 * CORPUS_FILES. Extra, missing, renamed and case-altered entries all fail, in
 * both directions, regardless of which side drifted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CORPUS_FILES } from "../src/corpus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/**
 * Every corpus-file-shaped token in a chunk of text, deduped and sorted.
 *
 * The leading `(?<![\w.-])` is what defeats the superstring hole: without it,
 * `OLD-BUILD-LOG.md` would yield `BUILD-LOG.md`. Matching is driven by SHAPE,
 * not by CORPUS_FILES, so a mirror naming a file that does not exist produces
 * an extra entry and fails rather than passing unnoticed.
 */
function corpusFileTokens(text: string): string[] {
  const matches = text.match(/(?<![\w.-])[A-Za-z][A-Za-z0-9-]*\.(?:md|txt)\b/g) ?? [];
  return [...new Set(matches)].sort();
}

const expected = [...CORPUS_FILES].sort();

async function read(...parts: string[]): Promise<string> {
  return fs.readFile(path.join(repoRoot, ...parts), "utf8");
}

/** Fail loudly if an anchor is missing, rather than silently scanning the wrong slice. */
function sliceBetween(
  source: string,
  startMarker: string,
  endMarker: string,
  label: string,
): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `could not locate ${label} (missing ${JSON.stringify(startMarker)})`);
  const rest = source.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  assert.notEqual(
    end,
    -1,
    `could not locate the end of ${label} (missing ${JSON.stringify(endMarker)})`,
  );
  return rest.slice(0, end);
}

test("src/corpus.ts's own header comment lists exactly the indexed corpus files", async () => {
  const source = await read("src", "corpus.ts");
  // The leading /** ... */ block specifically. Slicing "everything before the
  // export" instead would let ANY code above the export satisfy a claim about
  // the prose, and would silently scan the whole file if the export were ever
  // reformatted across two lines (indexOf -> -1, slice(0, -1) -> everything).
  const header = sliceBetween(source, "/**", "*/", "src/corpus.ts's header comment block");
  assert.deepEqual(
    corpusFileTokens(header),
    expected,
    `src/corpus.ts's header comment names [${corpusFileTokens(header).join(", ")}] ` +
      `but CORPUS_FILES indexes [${expected.join(", ")}]`,
  );
});

test("the ask_about_edgeorgie tool description lists exactly the indexed corpus files", async () => {
  const source = await read("src", "create-server.ts");
  const description = sliceBetween(
    source,
    '"ask_about_edgeorgie"',
    "inputSchema",
    "the ask_about_edgeorgie registration",
  );
  assert.deepEqual(
    corpusFileTokens(description),
    expected,
    `the ask_about_edgeorgie description advertises [${corpusFileTokens(description).join(", ")}] ` +
      `but CORPUS_FILES indexes [${expected.join(", ")}] — a calling agent is being told the ` +
      `corpus differs from what the server actually indexes`,
  );
});

test("README's '## The corpus' section lists exactly the indexed corpus files", async () => {
  const readme = await read("README.md");
  const section = sliceBetween(readme, "## The corpus", "\n## ", "README's '## The corpus' section");
  assert.deepEqual(
    corpusFileTokens(section),
    expected,
    `README's corpus section names [${corpusFileTokens(section).join(", ")}] ` +
      `but CORPUS_FILES indexes [${expected.join(", ")}]`,
  );
});

test("README's tools table row for ask_about_edgeorgie lists exactly the indexed corpus files", async () => {
  const readme = await read("README.md");
  // Anchor on the row's FIRST cell. Matching any row that merely *mentions*
  // the tool picks up the get_story row (it cross-references
  // ask_about_edgeorgie in its prose), which names no corpus files at all —
  // so the assertion would compare [] and fail for the wrong reason.
  const row = readme
    .split("\n")
    .find((line) => line.startsWith("| `ask_about_edgeorgie`"));
  assert.ok(row, "could not locate README's tools-table row for ask_about_edgeorgie");
  assert.deepEqual(
    corpusFileTokens(row),
    expected,
    `README's tools-table row for ask_about_edgeorgie names [${corpusFileTokens(row).join(", ")}] ` +
      `but CORPUS_FILES indexes [${expected.join(", ")}]`,
  );
});

// The committed transcripts are this repo's agent-facing provenance evidence:
// they are what a reviewer reads to see what an agent is actually told. They
// are generated, but they are generated and then COMMITTED, so they go stale
// exactly like a comment does — and a transcript that advertises a 3-file
// corpus while citing a 4th file further down contradicts itself in public.
for (const transcript of ["transcript.json", "http-transcript.json"]) {
  test(`examples/${transcript}'s ask_about_edgeorgie description lists exactly the indexed corpus files`, async () => {
    const raw = await read("examples", transcript);
    const parsed = JSON.parse(raw) as unknown;

    // Find the tool's advertised description wherever it sits in the shape,
    // rather than hardcoding a path a regeneration could legitimately move.
    const descriptions: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.name === "ask_about_edgeorgie" && typeof record.description === "string") {
        descriptions.push(record.description);
      }
      Object.values(record).forEach(walk);
    };
    walk(parsed);

    assert.ok(
      descriptions.length > 0,
      `examples/${transcript} contains no ask_about_edgeorgie tool description — ` +
        `if the transcript format changed, update this guard rather than deleting it`,
    );
    for (const description of descriptions) {
      assert.deepEqual(
        corpusFileTokens(description),
        expected,
        `examples/${transcript}'s ask_about_edgeorgie description advertises ` +
          `[${corpusFileTokens(description).join(", ")}] but CORPUS_FILES indexes ` +
          `[${expected.join(", ")}] — the committed transcript is public evidence and is ` +
          `misstating the corpus`,
      );
    }
  });
}
