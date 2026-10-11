/**
 * Guards the public corpus against personal contact details that a scraper
 * gets for free.
 *
 * This repo is a PUBLIC MCP server: every tracked file under `data/` is
 * indexed and served, verbatim, to any anonymous caller — and `examples/`
 * holds committed transcripts of real responses, so anything in the corpus
 * also ends up duplicated in the repo as literal JSON.
 *
 * A phone number reached that surface: `data/resume.txt` carried
 * `+57 <digits>` because it was transcribed from a résumé, where a phone
 * number is appropriate — a document a human chooses to send to a specific
 * recipient. A public retrieval API is not that, and it was duplicated four
 * times across the two transcripts.
 *
 * An email address is deliberately ALLOWED: the point of this server is to be
 * contactable, and the author publishes that address on the portfolio anyway.
 * A phone number is different in kind — it reaches a device, it cannot be
 * filtered, and it cannot be rotated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Directories whose contents are public: served by the API or committed output of it. */
const PUBLIC_DIRS = ["data", "examples"];

/**
 * Patterns that reach a person directly and cannot be revoked.
 *
 * Deliberately NOT a generic digit-run match: the corpus is full of legitimate
 * numbers (line ranges, download counts, PR numbers, SHAs, scores), and a
 * guard that fires on those gets deleted by the next maintainer. These anchor
 * on telephone SHAPE — an international prefix or a parenthesised area code.
 */
const FORBIDDEN: { label: string; pattern: RegExp }[] = [
  {
    label: "international phone number (+NN NNN ...)",
    // +57 300 281 3676 / +57 300-281-3676 / +573002813676
    pattern: /\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3}[\s.-]?\d{3,4}/,
  },
  {
    label: "US/CA-style phone number ((NNN) NNN-NNNN)",
    pattern: /\(\d{3}\)\s?\d{3}[\s.-]?\d{4}/,
  },
];

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(repoRoot, dir), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(rel)));
    else out.push(rel);
  }
  return out;
}

test("no personal phone number is served by the public corpus or committed transcripts", async () => {
  const files: string[] = [];
  for (const dir of PUBLIC_DIRS) files.push(...(await filesUnder(dir)));

  // Guards the guard: an empty file list would make every assertion below pass
  // over nothing. `data/resume.txt` is the specific file the leak was found in,
  // so its absence from the scan is itself a failure.
  assert.ok(
    files.includes(path.join("data", "resume.txt")),
    `the scan did not reach data/resume.txt — it covered [${files.join(", ")}], so a leak ` +
      `there would go unnoticed. Fix the walk, do not relax the assertion.`,
  );

  const hits: string[] = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(repoRoot, file), "utf8");
    for (const { label, pattern } of FORBIDDEN) {
      const match = text.match(pattern);
      if (match) hits.push(`${file}: ${label} — ${JSON.stringify(match[0])}`);
    }
  }

  assert.deepEqual(
    hits,
    [],
    `personal contact details found in publicly-served files. Every file under ` +
      `${PUBLIC_DIRS.join("/ and ")}/ is either indexed and returned by the live server or a ` +
      `committed transcript of its output, so these are scrapeable from the repo AND reachable ` +
      `through an anonymous API call: [${hits.join("; ")}]. Remove them from the source file, ` +
      `then regenerate the transcripts — editing only the transcripts leaves the server still ` +
      `serving the value.`,
  );
});
