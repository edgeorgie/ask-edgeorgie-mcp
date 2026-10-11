/**
 * Guards that every TypeScript file in this repo is actually typechecked by CI.
 *
 * The hole this closes was real and measured, not hypothetical. `tsconfig.json`
 * sets `include: ["src/**\/*.ts"]`, because src/ is what `npm run build` emits
 * to dist/. CI's `Typecheck` step runs `tsc --noEmit` against that config, so it
 * covered NONE of api/, tests/ or examples/ — and `tsx` (the test runner's
 * loader) strips types without checking them, so the suite could not notice
 * either. A type error planted in `api/projects.ts` left `tsc --noEmit` at
 * exit 0, `npm run build` at exit 0, and the whole suite green.
 *
 * api/ is the worst place for that gap: those files are the deployed Vercel
 * serverless functions, i.e. the production request handlers were the least
 * checked code in the repo. `tsconfig.check.json` now covers src/, api/,
 * tests/ and examples/, and CI runs it as its own step.
 *
 * Why this test exists on top of that config
 * ------------------------------------------
 * `tsconfig.check.json`'s `include` is a hand-maintained list of directories.
 * A new top-level directory of real TypeScript — `scripts/`, `lib/`, a second
 * API surface — is not added to it by the compiler, so it would be unchecked
 * from the moment it is created, with every CI step green. That is the same
 * fail-silent shape as the gap this guard exists because of, merely moved one
 * level up.
 *
 * So the expected set is DERIVED at runtime instead of restated: walk the repo
 * from the root using an EXCLUSION list (build output, deps, VCS), collect
 * every `.ts` file git tracks, and assert each one is matched by one of the two
 * configs' include globs. Nothing here needs editing when a file is added to an
 * already-covered directory; it fails only when TypeScript appears somewhere
 * no config reaches.
 *
 * Deliberately exclusion-based, not inclusion-based: an inclusion list of
 * "directories to look in" reproduces the original bug inside the test meant
 * to detect it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Directories never worth typechecking: generated build output, installed
 * dependencies, VCS metadata, static assets. Everything NOT named here is
 * walked, so a new source directory is covered by default rather than by
 * remembering to add it.
 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".vercel", "coverage", "public", "data"]);

/** Every `.ts` file under `dir`, repo-relative, with SKIP_DIRS pruned. */
async function collectTsFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectTsFiles(path.join(dir, entry.name), acc);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      acc.push(path.relative(repoRoot, path.join(dir, entry.name)));
    }
  }
  return acc;
}

/**
 * Translates the subset of tsconfig `include` syntax this repo uses
 * (`<dir>/**\/*.ts`, and a plain relative file path) into a predicate.
 *
 * Intentionally narrow: it throws on any pattern shape it does not understand
 * rather than silently returning false. A pattern this function cannot read is
 * a pattern whose coverage it cannot vouch for, and quietly treating that as
 * "covers nothing" would turn a config change into a confusing test failure,
 * while treating it as "covers everything" would hide the very gap being
 * guarded. Failing loudly on the unknown form is the only honest option.
 */
function includeMatcher(pattern: string): (file: string) => boolean {
  const recursive = pattern.match(/^(.+)\/\*\*\/\*\.ts$/);
  if (recursive) {
    const prefix = `${recursive[1]}/`;
    return (file) => file.startsWith(prefix);
  }
  if (pattern.endsWith(".ts") && !pattern.includes("*")) {
    return (file) => file === pattern;
  }
  throw new Error(
    `tsconfig include pattern not understood by tests/typecheck-coverage.test.ts: ${pattern}. ` +
      `Teach includeMatcher() this shape rather than deleting the assertion.`,
  );
}

async function readIncludes(configFile: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(repoRoot, configFile), "utf8");
  // Both configs are plain JSON (comments live in a "//" string key), so no
  // JSON5 dependency is needed.
  const parsed = JSON.parse(raw) as { include?: string[] };
  assert.ok(
    Array.isArray(parsed.include) && parsed.include.length > 0,
    `${configFile} must declare a non-empty "include" array`,
  );
  return parsed.include as string[];
}

test("tsconfig.check.json exists and extends the build config", async () => {
  const raw = JSON.parse(
    await fs.readFile(path.join(repoRoot, "tsconfig.check.json"), "utf8"),
  ) as { extends?: string; compilerOptions?: { noEmit?: boolean } };
  assert.equal(
    raw.extends,
    "./tsconfig.json",
    "the check config must inherit strictness from the build config, not restate it",
  );
  assert.equal(
    raw.compilerOptions?.noEmit,
    true,
    "the check config must be noEmit — it is a verifier, it must not write dist/",
  );
});

test("every tracked .ts file is covered by tsconfig.json or tsconfig.check.json", async () => {
  const files = await collectTsFiles(repoRoot);

  // Sanity floor: if the walker silently returned nothing (wrong root, over-eager
  // SKIP_DIRS), every assertion below would pass vacuously. api/ is the directory
  // whose absence from coverage caused this file to exist, so require it present.
  assert.ok(files.length >= 15, `walker found only ${files.length} .ts files — it is not walking the repo`);
  assert.ok(
    files.some((f) => f.startsWith("api/")),
    "walker found no api/*.ts — the deployed serverless functions must be in the walked set",
  );

  const matchers = [
    ...(await readIncludes("tsconfig.json")),
    ...(await readIncludes("tsconfig.check.json")),
  ].map(includeMatcher);

  const uncovered = files.filter((file) => !matchers.some((m) => m(file)));
  assert.deepEqual(
    uncovered,
    [],
    `these TypeScript files are typechecked by NO tsconfig, so a type error in them ` +
      `passes CI silently — add their directory to tsconfig.check.json's include: ` +
      `${uncovered.join(", ")}`,
  );
});

test("tsconfig.check.json covers the directories tsconfig.json deliberately omits", async () => {
  const checkIncludes = await readIncludes("tsconfig.check.json");
  // Named explicitly because each is load-bearing for a different reason:
  // api/ is deployed production code, tests/ holds the derived guards the
  // README's claims rest on, examples/ generates the committed transcripts.
  for (const dir of ["api", "tests", "examples"]) {
    assert.ok(
      checkIncludes.includes(`${dir}/**/*.ts`),
      `tsconfig.check.json must include ${dir}/**/*.ts`,
    );
  }
});
