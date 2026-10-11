/**
 * Guards that every TypeScript file in this repo is actually typechecked by CI.
 *
 * The hole this closes was real and measured, not hypothetical. `tsconfig.json`
 * sets `include: ["src/**\/*.ts"]`, correctly — src/ is what `npm run build`
 * emits to dist/. CI's `Typecheck` step runs `tsc --noEmit` against that
 * config, so it covered **none** of api/, tests/ or examples/, and `tsx` (the
 * test runner's loader) strips types without checking them, so the suite could
 * not notice either. A type error planted in `api/projects.ts` left
 * `tsc --noEmit` at exit 0, `npm run build` at exit 0, and the whole suite
 * green.
 *
 * api/ is what made that more than hygiene: those files are the deployed Vercel
 * serverless functions, so the production request handlers were the
 * least-checked code in the repo. `tsconfig.check.json` now covers src/, api/,
 * tests/ and examples/, and CI runs it as its own step.
 *
 * Why this test exists on top of that config
 * ------------------------------------------
 * The check config's `include` is hand-maintained. A new top-level directory of
 * real TypeScript — `scripts/`, `lib/`, a second API surface — is not added to
 * it by the compiler, so it would be unchecked from the moment it is created
 * with every CI step green. That is the same fail-silent shape as the gap this
 * guard exists because of, merely moved one level up.
 *
 * How the expected set is derived — and the mistake this file already made once
 * ---------------------------------------------------------------------------
 * The first version of this guard parsed the `include` arrays out of both
 * configs and reimplemented tsconfig's glob matching to decide coverage. A cold
 * review broke it immediately: adding `"exclude": ["api"]` while LEAVING
 * `api/**\/*.ts` in `include` passed at full green, and the original planted
 * `api/projects.ts` type error came back undetected — three CI gates at exit 0,
 * suite 61/61. Asserting on `include` is asserting on a *stated intention*;
 * `exclude` (and `files`, and `extends` chains, and tsconfig's default
 * exclusions) all override it. The guard was reading the wrong thing.
 *
 * So coverage is no longer modelled here at all. It is asked of the compiler:
 * `tsc -p <config> --listFilesOnly` prints the exact set of files that config
 * resolves, which is by construction the set it would typecheck. There is no
 * glob syntax to reimplement, no `exclude`/`files` interaction to remember, and
 * no way for a config shape this file has never seen to be silently misread —
 * if tsc counts a file, it is checked; if tsc does not, it is not.
 *
 * The walk of real files stays EXCLUSION-based on purpose. An inclusion list of
 * "directories to look in" would reproduce the original bug inside the test
 * written to detect it: a new directory would be invisible to the walker and to
 * the config at the same time, and this guard would pass at full green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Directories never worth typechecking: generated build output, installed
 * dependencies, VCS metadata, static assets, corpus data. Everything NOT named
 * here is walked, so a new source directory is covered by default rather than
 * by someone remembering to add it.
 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".vercel", "coverage", "public", "data"]);

/** The configs whose union must cover the repo. */
const CONFIGS = ["tsconfig.json", "tsconfig.check.json"];

/** Every `.ts` file under `dir`, repo-relative and POSIX-separated, with SKIP_DIRS pruned. */
async function collectTsFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectTsFiles(path.join(dir, entry.name), acc);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      acc.push(path.relative(repoRoot, path.join(dir, entry.name)).split(path.sep).join("/"));
    }
  }
  return acc;
}

/**
 * The files `configFile` actually resolves, straight from the compiler.
 *
 * `--listFilesOnly` resolves the program and prints its file list without
 * typechecking, so this is fast and — unlike parsing `include` — accounts for
 * `exclude`, `files`, `extends` and tsconfig's own default exclusions.
 * `node_modules` entries (lib.d.ts, @types, dependency sources) are dropped:
 * this guard is about first-party code.
 */
async function filesCoveredBy(configFile: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", configFile, "--listFilesOnly"],
    { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
  );
  const covered = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("node_modules"))
    .map((abs) => path.relative(repoRoot, abs).split(path.sep).join("/"));
  return new Set(covered);
}

test("tsconfig.check.json exists and extends the build config", async () => {
  const raw = JSON.parse(await fs.readFile(path.join(repoRoot, "tsconfig.check.json"), "utf8")) as {
    extends?: string;
    compilerOptions?: { noEmit?: boolean };
  };
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

test("every tracked .ts file is in a tsconfig's resolved program", async () => {
  const files = await collectTsFiles(repoRoot);

  // Vacuity floors. If the walker silently returned nothing (wrong root,
  // over-eager SKIP_DIRS), the assertion below would pass against an empty set.
  // api/ is the directory whose absence from coverage caused this file to
  // exist, so require it present in the walked set specifically.
  assert.ok(files.length >= 15, `walker found only ${files.length} .ts files — it is not walking the repo`);
  assert.ok(
    files.some((f) => f.startsWith("api/")),
    "walker found no api/*.ts — the deployed serverless functions must be in the walked set",
  );

  const coveredSets = await Promise.all(CONFIGS.map(filesCoveredBy));
  const covered = new Set(coveredSets.flatMap((s) => [...s]));

  // Second floor, on the other side: a config that resolved nothing (bad path,
  // tsc error swallowed) would make `covered` empty and the diff below would
  // name every file, which is a confusing way to report a broken harness.
  assert.ok(covered.size >= 15, `the configs resolved only ${covered.size} first-party files — harness is broken`);

  const uncovered = files.filter((file) => !covered.has(file));
  assert.deepEqual(
    uncovered,
    [],
    `these TypeScript files are in NO tsconfig's resolved program, so a type error in them ` +
      `passes CI silently. Add their directory to tsconfig.check.json's include (and check ` +
      `nothing in "exclude" cancels it): ${uncovered.join(", ")}`,
  );
});

test("the deployed api/ handlers are in the check config's resolved program", async () => {
  // Named as its own assertion rather than left to the derived check above,
  // because this is the specific regression that motivated the whole change and
  // it deserves to fail with a message that says so. It is also the assertion
  // that survives if someone deletes api/*.ts from the walked set by widening
  // SKIP_DIRS.
  const covered = await filesCoveredBy("tsconfig.check.json");
  for (const handler of ["ask", "experience", "mcp", "projects", "story"]) {
    assert.ok(
      covered.has(`api/${handler}.ts`),
      `api/${handler}.ts is a deployed serverless function and must be typechecked — ` +
        `it is not in tsconfig.check.json's resolved program`,
    );
  }
});

test("tests/ and examples/ are in the check config's resolved program", async () => {
  // tests/ holds the derived guards the README's measured claims rest on;
  // examples/run-session.ts generates the committed evidence transcripts.
  const covered = await filesCoveredBy("tsconfig.check.json");
  assert.ok(
    [...covered].some((f) => f.startsWith("tests/")),
    "no tests/*.ts in the check config's resolved program",
  );
  assert.ok(
    [...covered].some((f) => f.startsWith("examples/")),
    "no examples/*.ts in the check config's resolved program",
  );
});
