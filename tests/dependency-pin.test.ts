/**
 * Makes the git-dependency pin self-enforcing.
 *
 * `@edgeorgie/retrieval-core` is consumed straight from GitHub rather than the
 * npm registry, and a bare `github:owner/repo` spec means "whatever that
 * branch's HEAD happens to be at install time". That was the state this repo
 * shipped in until the spec was pinned by SHA: `npm install` with the lockfile
 * fully intact was measured drifting the installed package from `40f3c5a` to
 * `279fe9f` on 3/3 runs — and not only in the lockfile text, the executing
 * code swapped (`tokenize("toString")` changed output). Nothing in this repo
 * had a sensor for that: the suite, `tsc`, `build`, `npm audit` and the deploy
 * check were all green in both states.
 *
 * The pin was applied by hand, so nothing stops the next dependency edit (or a
 * well-meaning `npm install <pkg>` rewriting the manifest) from dropping the
 * fragment and restoring floating installs silently. These assertions are the
 * guard, and they are deliberately DERIVED rather than hardcoded: the expected
 * SHA is read out of the lockfile's `resolved` URL at runtime, so this file
 * never needs editing when the dependency is legitimately bumped — it only
 * fails when manifest and lockfile disagree, or when the pin disappears.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(repoRoot, relPath), "utf8"));
}

/** `github:owner/repo#<sha>` / `git+ssh://...#<sha>` — the fragment is the pin. */
const SHA_FRAGMENT = /#([0-9a-f]{40})$/;

/**
 * Specs that resolve to the npm REGISTRY. Everything else is treated as a git
 * dependency.
 *
 * Detection is by EXCLUSION, and the exclusion list is deliberately narrow.
 * Two earlier revisions each missed a real floating git spec:
 *
 *   1. Inclusion matching (`/^(github:|git\+|git:)/`) could not see npm's
 *      shorthand `owner/repo#ref`, which has no scheme prefix at all.
 *   2. Excluding anything starting with a digit (`\d`) could not see
 *      `0xowner/repo#main` — GitHub usernames may begin with a digit, and
 *      npm's own `npm-package-arg` classifies that spec as `type: "git"`.
 *      Reintroducing it was measured passing: the dependency vanished from the
 *      set and the suite stayed green over a short list.
 *
 * So a bare leading digit is no longer enough to be called a registry range —
 * it must look like an actual semver version (`1`, `1.2`, `1.2.3-rc.1`), which
 * `owner/repo#ref` cannot, because of the slash. A dependency form this
 * function has never seen falls through to the git branch and is REPORTED
 * (fails closed), never silently skipped.
 */
const REGISTRY_SPEC =
  /^(\*|latest|[~^><=]|\d+(\.\d+)*([-+][\w.-]+)?$|\d+(\.\d+)*\s*(-\s*\d|\|\|)|workspace:|npm:|file:|link:)/;

function gitDependencies(manifest: Record<string, unknown>): [string, string][] {
  const deps = {
    ...((manifest.dependencies as Record<string, string>) ?? {}),
    ...((manifest.devDependencies as Record<string, string>) ?? {}),
  };
  return Object.entries(deps).filter(([, spec]) => !REGISTRY_SPEC.test(spec.trim()));
}

test("every git dependency is pinned to a full 40-hex commit SHA, not a floating ref", async () => {
  const manifest = await readJson("package.json");
  const gitDeps = gitDependencies(manifest);

  // Guards the guard: if the repo ever stops consuming a git dependency this
  // test would otherwise pass vacuously, asserting nothing about anything.
  //
  // The remedy named here is deliberately NOT "delete this file". An earlier
  // revision said exactly that, which is dangerous advice: the most likely way
  // to reach an empty set is not that the git dependency was legitimately
  // removed, it is that a manifest edit changed its spec into a form
  // `gitDependencies()` no longer recognises — the very regression this guard
  // exists to catch. Telling the next maintainer to delete the guard on that
  // signal hands them the loaded gun.
  assert.ok(
    gitDeps.length > 0,
    "gitDependencies() matched NOTHING in package.json. Do not delete this file on this " +
      "signal. Either (a) the git dependency was genuinely removed — confirm by hand that " +
      "package.json's dependencies are all registry ranges, and only then retire this guard, " +
      "or (b) its spec changed into a form this guard cannot see, which is the exact " +
      "regression it exists to catch. Check case (b) first.",
  );

  for (const [name, spec] of gitDeps) {
    assert.match(
      spec,
      SHA_FRAGMENT,
      `dependency "${name}" is declared as "${spec}", which floats to whatever the default branch's HEAD is at install time. Append "#<40-hex-sha>" to pin it.`,
    );
  }
});

test("the declared pin is the commit the lockfile actually installs", async () => {
  const [manifest, lockfile] = await Promise.all([
    readJson("package.json"),
    readJson("package-lock.json"),
  ]);
  const packages = (lockfile.packages ?? {}) as Record<string, { resolved?: string }>;

  for (const [name, spec] of gitDependencies(manifest)) {
    const declared = spec.match(SHA_FRAGMENT)?.[1];
    assert.ok(declared, `"${name}" is not SHA-pinned (covered by the test above)`);

    const entry = packages[`node_modules/${name}`];
    assert.ok(entry, `"${name}" is declared in package.json but absent from package-lock.json`);

    const locked = entry.resolved?.match(SHA_FRAGMENT)?.[1];
    assert.ok(
      locked,
      `"${name}" has no SHA in its lockfile "resolved" URL (${entry.resolved ?? "missing"})`,
    );
    assert.equal(
      locked,
      declared,
      `"${name}" manifest/lockfile disagree: package.json pins ${declared}, the lockfile installs ${locked}. The manifest pin is cosmetic in this state — the lockfile is what npm ci obeys.`,
    );
  }
});
