/**
 * Derived guard for every hand-maintained mirror of the get_projects list.
 *
 * `doGetProjects()` in src/engine.ts is the authoritative set of shipped
 * artifacts this server advertises. Several places restate that list — and its
 * COUNT — in prose for humans and for calling agents, and none of them is
 * updated by the compiler when a project is added.
 *
 * All of them went stale at once when `agentlens` shipped. The failure was not
 * cosmetic: `agentlens` was absent from `doGetProjects()` entirely while the
 * repo's own corpus and the application narrative both named it, so the
 * structured tool an agent calls returned 5 projects and omitted the one the
 * narrative called most relevant — the same class of defect as a corpus that
 * served a false cited claim, and equally invisible to tests, `tsc`, `build`
 * and the deploy check, all of which were green in that state.
 *
 * The mirrors gated here:
 *
 *   1. src/engine.ts's module header comment ("returns the N shipped artifacts")
 *   2. src/engine.ts's doGetProjects doc comment ("Hardcoded to the N ...")
 *   3. src/create-server.ts's get_projects tool description (names + count)
 *   4. README.md's tools table row for get_projects (names + count)
 *   5. data/BUILD-LOG.md's own project list (the corpus a recruiter is served)
 *
 * This file follows tests/corpus-list.test.ts's design deliberately: the
 * expectation is DERIVED by calling the real function, and comparisons are
 * bidirectional (set EQUALITY, not "is every project mentioned"), so a mirror
 * naming a project that does not exist fails just as loudly as one missing a
 * project that does. Over-advertising is the worse direction for an evidence
 * tool — a caller told an artifact exists that cannot be shown.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { doGetProjects } from "../src/engine.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const projects = await doGetProjects();
const expectedNames = projects.map((p) => p.name).sort();
const expectedCount = projects.length;

/** Spelled-out numerals a prose mirror might use instead of a digit. */
const NUMBER_WORDS: Record<number, string> = {
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
};

async function read(...parts: string[]): Promise<string> {
  return fs.readFile(path.join(repoRoot, ...parts), "utf8");
}

/**
 * Project names present in a chunk of text, as a deduped sorted set.
 *
 * Driven by the real project list rather than by shape (unlike the corpus
 * guard, project names have no distinguishing shape — `agentlens` is an
 * ordinary word). That makes the "extra" direction unreachable here, so the
 * COUNT assertions below carry that half: a mirror naming a sixth project
 * while the real list holds five states a count that cannot match.
 *
 * Word boundaries matter: without them `repoask-mcp` is a substring of
 * `repoask-mcp-work` and `agentlens` of `agentlensx`.
 */
function mentionedProjects(text: string): string[] {
  return expectedNames
    .filter((name) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text))
    .sort();
}

/**
 * Asserts a mirror states the real project count, accepting either a digit or
 * the spelled-out word, and rejecting every OTHER count in the same range —
 * so "the five things I shipped" fails once a sixth exists, in whichever form
 * the prose happens to use.
 */
function assertStatesCount(text: string, label: string): void {
  const word = NUMBER_WORDS[expectedCount];
  const digitRe = new RegExp(`(?<![\\w.])${expectedCount}(?![\\w.])`);
  const wordRe = word ? new RegExp(`\\b${word}\\b`, "i") : null;

  assert.ok(
    digitRe.test(text) || (wordRe?.test(text) ?? false),
    `${label} does not state the real project count (${expectedCount}${word ? `/"${word}"` : ""}). ` +
      `doGetProjects() returns [${expectedNames.join(", ")}].`,
  );

  for (const [n, otherWord] of Object.entries(NUMBER_WORDS)) {
    const other = Number(n);
    if (other === expectedCount) continue;
    // Only the spelled-out form is checked for wrong counts. Bare digits are
    // far too common in this prose for a digit scan to mean anything (version
    // numbers, pass rates, PR numbers), and asserting on them would make this
    // guard fail for unrelated edits — a guard that cries wolf gets deleted.
    assert.ok(
      !new RegExp(`\\b${otherWord}\\b`, "i").test(text),
      `${label} still says "${otherWord}" while doGetProjects() returns ${expectedCount} ` +
        `projects ([${expectedNames.join(", ")}]). A stale count in prose is exactly the ` +
        `defect this guard exists for.`,
    );
  }
}

test("doGetProjects returns a non-empty list with unique names", async () => {
  // Guards the guard: every assertion below derives from this list, so an empty
  // or duplicate-ridden list would make the whole file pass vacuously.
  assert.ok(expectedCount > 0, "doGetProjects() returned no projects");
  assert.equal(
    new Set(expectedNames).size,
    expectedCount,
    `duplicate project names in doGetProjects(): [${expectedNames.join(", ")}]`,
  );
});

test("every project entry carries real evidence, not just a description", async () => {
  for (const project of projects) {
    assert.ok(
      project.realMetrics.length > 0,
      `project "${project.name}" has no realMetrics — an evidence tool must not advertise an artifact with nothing measured`,
    );
    assert.ok(
      project.evidence.length > 0,
      `project "${project.name}" has no evidence URLs — every claim must be independently checkable`,
    );
    assert.ok(
      project.source.trim().length > 0,
      `project "${project.name}" has no source field saying where its claims were verified`,
    );
  }
});

test("src/engine.ts's module header states the real project count", async () => {
  const source = await read("src", "engine.ts");
  // Scoped to the `get_projects ->` bullet, not the whole header block. The
  // header also says "the four ... tools", which is a correct, unrelated count
  // (tools, not projects) — scanning the whole block makes the guard fail on a
  // true statement, and a guard that cries wolf gets deleted.
  const marker = "get_projects";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `could not locate the ${marker} header bullet`);
  const bullet = source.slice(start, source.indexOf("* get_story", start));
  assert.notEqual(bullet.length, 0, "could not locate the end of the get_projects header bullet");
  assertStatesCount(bullet, "src/engine.ts's get_projects header bullet");
});

test("doGetProjects's own doc comment states the real project count", async () => {
  const source = await read("src", "engine.ts");
  const marker = "Hardcoded to the";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `could not locate doGetProjects's doc comment (missing "${marker}")`);
  const comment = source.slice(start, source.indexOf("*/", start));
  assertStatesCount(comment, "doGetProjects's doc comment");
});

test("the get_projects tool description lists exactly the projects the tool returns", async () => {
  const source = await read("src", "create-server.ts");
  const start = source.indexOf('"get_projects"');
  assert.notEqual(start, -1, "could not locate the get_projects registration");
  const end = source.indexOf("inputSchema", start);
  assert.notEqual(end, -1, "could not locate the end of the get_projects description");
  const description = source.slice(start, end);

  assert.deepEqual(
    mentionedProjects(description),
    expectedNames,
    `the get_projects description advertises [${mentionedProjects(description).join(", ")}] but ` +
      `the tool returns [${expectedNames.join(", ")}] — a calling agent is being told the wrong set`,
  );
  assertStatesCount(description, "the get_projects tool description");
});

test("README's tools table row for get_projects lists exactly the projects the tool returns", async () => {
  const readme = await read("README.md");
  const row = readme.split("\n").find((line) => line.startsWith("| `get_projects`"));
  assert.ok(row, "could not locate README's tools-table row for get_projects");

  assert.deepEqual(
    mentionedProjects(row),
    expectedNames,
    `README's get_projects row names [${mentionedProjects(row).join(", ")}] but the tool returns ` +
      `[${expectedNames.join(", ")}]`,
  );
  assertStatesCount(row, "README's get_projects table row");
});

test("data/BUILD-LOG.md discusses every project the tool returns, not just names it", async () => {
  // The build log is INDEXED CORPUS, not just docs: it is what the retrieval
  // tool cites to a recruiter. When it omitted agentlens, the live server
  // answered "I don't find any reference to agentlens" with a citation while
  // the application narrative led with it.
  //
  // Subset, not equality, and no count assertion: the build log is a narrative
  // of specific debugging episodes, legitimately covers projects in uneven
  // depth, and its numerals ("three ways", "four providers") describe those
  // episodes rather than the project list. The one thing it must never do is
  // fail to give the retrieval layer something citable about a project.
  //
  // PRESENCE IS NOT ENOUGH, and NEITHER IS BLOCK LENGTH. Two earlier
  // revisions of this guard were each defeated by a near-identical variant of
  // the bug it was written for:
  //
  //   1. Mention-anywhere passed over a BUILD-LOG.md TRUNCATED TO ITS TITLE
  //      LINE, because the title enumerates all six names.
  //   2. Mention-in-a->=400-char-block passed over the title line plus ONE
  //      682-char enumeration paragraph ("triage-desk, eval-lab, repoask-mcp,
  //      crispy-profiling, simplescope and agentlens come down to one
  //      idea..."), and over a corpus where agentlens's three real paragraphs
  //      were deleted and the name merely dropped once inside a long
  //      triage-desk paragraph. Length is not aboutness.
  //
  // So the assertion is that each project has a FOCUS BLOCK: a block of real
  // prose that is ABOUT that project and not about the others. Three
  // conditions together, each closing a measured hole:
  //
  //   - >= MIN_CONTEXT_CHARS  — a heading or a one-line list cannot pass.
  //   - >= MIN_OCCURRENCES    — a single name-drop inside a paragraph about
  //                             something else cannot pass. Sustained
  //                             discussion refers back to its subject.
  //   - names no OTHER project — an enumeration sentence listing all six, or
  //                             a block about project A that mentions B in
  //                             passing, cannot pass for any of them.
  //
  // The third is the load-bearing one: it is what makes "a long block that
  // merely contains the name" insufficient, because filler that name-drops
  // several projects fails for every project it names.
  const MIN_CONTEXT_CHARS = 400;
  const MIN_OCCURRENCES = 2;
  const buildLog = await read("data", "BUILD-LOG.md");

  // Blocks = paragraphs.
  const blocks = buildLog.split(/\n\s*\n/);
  const boundaryFor = (name: string) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`, "g");

  const unsupported: string[] = [];
  for (const name of expectedNames) {
    const others = expectedNames.filter((other) => other !== name);
    const focusBlocks = blocks.filter((block) => {
      if (block.trim().length < MIN_CONTEXT_CHARS) return false;
      if ((block.match(boundaryFor(name)) ?? []).length < MIN_OCCURRENCES) return false;
      return !others.some((other) => boundaryFor(other).test(block));
    });
    if (focusBlocks.length === 0) {
      // Report the best near-miss, so a genuine failure says what to change.
      const best = blocks
        .filter((block) => boundaryFor(name).test(block))
        .map((block) => ({
          len: block.trim().length,
          occ: (block.match(boundaryFor(name)) ?? []).length,
          others: others.filter((other) => boundaryFor(other).test(block)).length,
        }))
        .sort((a, b) => b.occ - a.occ)[0];
      unsupported.push(
        best
          ? `${name} (best block: ${best.len} chars, ${best.occ} mention(s), names ${best.others} other project(s))`
          : `${name} (not mentioned at all)`,
      );
    }
  }

  assert.deepEqual(
    unsupported,
    [],
    `data/BUILD-LOG.md has no passage actually ABOUT these projects, so the retrieval layer ` +
      `has nothing substantive to cite for them: [${unsupported.join(", ")}]. A focus block is ` +
      `>=${MIN_CONTEXT_CHARS} chars, mentions the project >=${MIN_OCCURRENCES} times, and does ` +
      `not name another project — a heading, an enumeration of all six, or a passing mention ` +
      `inside a paragraph about something else does not count as evidence.`,
  );
});
