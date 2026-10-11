/**
 * Derived guard for the README's test-count claims.
 *
 * THE DRIFT THIS EXISTS TO PREVENT
 *
 * The README said "`npm test` → 28/28 passing across six files" while the real
 * suite was 58 tests across 12. Nothing could have caught it: a prose count is
 * invisible to the compiler, to CI, and to every other test in the repo — the
 * same hand-maintained-mirror class this repo has already killed twice in
 * code (`CORPUS_FILES` versus its three mirrors, including a tool
 * *description* that told every calling agent the corpus was smaller than it
 * was; and the tool-array mirrors in the health endpoints) while leaving the
 * prose copy of the identical mistake live.
 *
 * It matters more here than a typo would. This server's entire product claim
 * is that its answers are grounded in real, checkable facts, and the README is
 * the surface a reviewer checks first. A reader who verifies the one number
 * they can verify cheaply, finds it wrong, and then reads the measured
 * reliability figures has good reason to discount those too.
 *
 * WHAT IS ASSERTED, AND WHY ONLY THIS
 *
 * The file count is derived by discovering test files exactly the way
 * `package.json`'s `test` script does (`tests/*.test.ts`), so it is exact and
 * is asserted against the README.
 *
 * The *test* count is deliberately NOT asserted, and the README deliberately
 * does not state one. This is not laziness — it is the only honest option
 * here, and the reason is worth recording:
 *
 *   `tests/corpus-list.test.ts` declares one of its tests inside a `for`
 *   loop over the two committed transcripts, so one source-level `test(`
 *   produces two real tests. Any static count of `test(` declarations
 *   therefore UNDERCOUNTS this suite (56 declarations, 58 tests at the time
 *   of writing), and no amount of regex sophistication fixes that — the
 *   multiplicity is only known at runtime.
 *
 * A guard that asserted a statically-derived total would be the very bug it
 * exists to prevent: a confidently-wrong number, now with a passing test
 * standing behind it. So the third assertion below actively FAILS if a
 * test-count claim reappears in the prose, and the helper refuses to report a
 * total at all once it detects loop-generated tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

/**
 * Counts top-level `test("…")` declarations in a source file, and reports
 * whether any of them sit inside a loop — in which case the declaration count
 * is a FLOOR on the real test count, not the real count.
 *
 * No parser needed: every test in this suite is declared at column 0 or, in
 * the one loop case, at a single indent directly inside a top-level `for`.
 */
function scanTests(source: string): { declarations: number; loopGenerated: boolean } {
  const lines = source.split("\n");
  const declarations = lines.filter((line) => /^\s*test\(/.test(line)).length;
  // A `test(` at any indentation means it is nested in something — a loop, a
  // conditional, a describe block — so its runtime multiplicity is unknown.
  const loopGenerated = lines.some((line) => /^\s+test\(/.test(line));
  return { declarations, loopGenerated };
}

async function discoverSuite(): Promise<{
  files: string[];
  declarations: number;
  loopGenerated: boolean;
}> {
  // Mirrors package.json's `test` script glob: `tests/*.test.ts` — top level
  // only, which is why tests/helpers/ would not be picked up.
  const entries = await fs.readdir(path.join(ROOT, "tests"), { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
    .map((e) => path.join("tests", e.name))
    .sort();

  let declarations = 0;
  let loopGenerated = false;
  for (const file of files) {
    const scan = scanTests(await fs.readFile(path.join(ROOT, file), "utf8"));
    declarations += scan.declarations;
    loopGenerated = loopGenerated || scan.loopGenerated;
  }
  return { files, declarations, loopGenerated };
}

test("the test-scanning helper is not vacuous", async () => {
  // Positive controls. Without these, a `scanTests` that always returned 0
  // (wrong glob, renamed directory, changed declaration style) would make the
  // assertions below pass for entirely the wrong reason.
  assert.deepEqual(scanTests('test("a", () => {});\ntest("b", () => {});\n'), {
    declarations: 2,
    loopGenerated: false,
  });
  assert.deepEqual(scanTests('for (const x of y) {\n  test(`${x}`, () => {});\n}\n'), {
    declarations: 1,
    loopGenerated: true,
  });
  assert.deepEqual(scanTests('// a comment mentioning test( in prose\n'), {
    declarations: 0,
    loopGenerated: false,
  });

  const { files, declarations } = await discoverSuite();
  assert.ok(files.length >= 5, `expected to discover the real suite, found ${files.length} files`);
  assert.ok(
    declarations >= files.length,
    `expected at least one test declaration per file, found ${declarations}`,
  );
});

test("the README's test-file count matches the real suite", async () => {
  const { files } = await discoverSuite();
  const readme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");

  const claim = /The suite is \*\*(\d+) test files\*\*\./.exec(readme);
  assert.ok(
    claim,
    'README.md must contain exactly the sentence "The suite is **N test files**." so this ' +
      "guard can check it. If the wording changed, update the pattern here too — do not " +
      "delete the assertion.",
  );

  assert.equal(
    Number(claim[1]),
    files.length,
    `README claims ${claim[1]} test files; the suite really has ${files.length} ` +
      `(${files.join(", ")}).`,
  );
});

test("the README states no test COUNT, because this suite's cannot be derived statically", async () => {
  // Not a style rule — a correctness one. One test in tests/corpus-list.test.ts
  // is declared inside a `for` loop over the committed transcripts, so the
  // declaration count is strictly below the real test count. Asserting a
  // statically-derived total would ship a confidently-wrong number with a
  // green test behind it, which is worse than the stale number this file
  // exists to prevent.
  const { loopGenerated, declarations } = await discoverSuite();
  assert.equal(
    loopGenerated,
    true,
    "No loop-generated tests found any more. If every test is now declared at the top " +
      "level, a total CAN be derived exactly — at which point this assertion should be " +
      "replaced by one that checks a stated count, not deleted.",
  );

  const readme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");
  const stray = readme.match(/\b\d+\/\d+\s+tests?\b|\b\d+\s+tests?\s+(?:passing|across|in)\b/gi) ?? [];
  assert.deepEqual(
    stray,
    [],
    `README states a test count (${stray.join(", ")}), but this suite's total cannot be ` +
      `derived from source: ${declarations} declarations expand to more at runtime. State ` +
      `the file count instead, or make every test a top-level declaration first.`,
  );
});
