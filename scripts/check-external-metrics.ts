/**
 * Checks the repo's externally-sourced claims against their real live
 * sources, and exits nonzero on drift.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST
 *
 * `tests/external-metric-claims.test.ts` proves the download claim is
 * internally consistent and self-dating. It cannot prove the number is still
 * TRUE, because the authority is npm's registry, not this repo. Closing that
 * requires a network call — which does not belong in a per-PR suite, where a
 * third party being briefly unreachable would fail CI for a reason unrelated
 * to the change under review.
 *
 * So freshness runs on a schedule instead (see the `external-metrics` job in
 * .github/workflows/external-metrics.yml). Drift gets surfaced loudly on a
 * timer; nobody's PR is held hostage by api.npmjs.org.
 *
 * WHAT IT CHECKS
 *
 *   - The dated download figure in `src/engine.ts` and `data/BUILD-LOG.md`
 *     against npm's real lifetime total.
 *   - The repo-state figures stated alongside it (stars, forks, watchers,
 *     open issues) against the GitHub API, unauthenticated.
 *
 * TOLERANCE, AND WHY IT IS NOT ZERO. A cumulative download counter moves on
 * its own — registry mirrors refetch, CI pulls. Demanding exactness would
 * mean a failing scheduled job within days of every correct update, which
 * trains everyone to ignore it. The bar is instead "is the stated figure
 * still an honest characterisation": drift beyond DRIFT_TOLERANCE (relative)
 * fails. The 754 -> 1266 case this exists to catch was 68% off, far outside
 * any sane tolerance.
 *
 * Usage:  npm run check:external
 * Exits:  0 = every claim still accurate; 1 = drift found; 2 = could not check.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { doGetProjects } from "../src/engine.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Relative drift above which a stated download figure is called stale. */
const DRIFT_TOLERANCE = 0.15;

const PACKAGE = "crispy-profiling";
const REPO = "edgeorgie/crispy-profiling";

/** npm's download endpoints return the lifetime total for any window spanning the first publish. */
const NPM_DOWNLOADS = `https://api.npmjs.org/downloads/point/last-month/${PACKAGE}`;
const GITHUB_REPO = `https://api.github.com/repos/${REPO}`;

const DOWNLOAD_CLAIM = /\*{0,2}([\d,]{3,})\*{0,2}\s+as of\s+(\d{4}-\d{2}-\d{2})/;

interface Drift {
  surface: string;
  claim: string;
  live: string;
  detail: string;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": `${PACKAGE}-metric-check` },
  });
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`);
  }
  return res.json();
}

/** The stated figure, read from both surfaces. Equality between them is the test's job. */
async function statedDownloads(): Promise<{ value: number; asOf: string }> {
  const crispy = (await doGetProjects()).find((p) => p.name === PACKAGE);
  if (!crispy) {
    throw new Error(`doGetProjects() returned no project named "${PACKAGE}"`);
  }
  const fromEngine = crispy.limitations
    .map((l) => DOWNLOAD_CLAIM.exec(l))
    .find((m): m is RegExpExecArray => m !== null);
  if (!fromEngine) {
    throw new Error(`no dated download figure found in ${PACKAGE}'s limitations`);
  }
  return { value: Number(fromEngine[1].replace(/,/g, "")), asOf: fromEngine[2] };
}

/**
 * Repo-state figures stated in prose, which drift in BOTH directions.
 *
 * Reads BOTH claim surfaces, not just the corpus file. The first version read
 * only `data/BUILD-LOG.md` and therefore silently skipped a stale "2 open
 * issues" claim that lived only in `src/engine.ts`'s limitations — a checker
 * that looks at one of two mirrors reports a clean result for a claim it never
 * examined, which is the same failure class this whole file exists to catch.
 */
async function statedRepoState(): Promise<
  Array<{ surface: string; kind: string; claimed: number }>
> {
  const surfaces: Array<[string, string]> = [
    ["data/BUILD-LOG.md", await fs.readFile(path.join(repoRoot, "data", "BUILD-LOG.md"), "utf8")],
    [
      "src/engine.ts limitations[]",
      ((await doGetProjects()).find((p) => p.name === PACKAGE)?.limitations ?? []).join("\n"),
    ],
  ];

  const patterns: Array<[string, RegExp]> = [
    ["stars", /(\d+)\s+GitHub stars/],
    ["open issues", /(\d+)\s+open issues? on the repo/],
  ];

  const found: Array<{ surface: string; kind: string; claimed: number }> = [];
  for (const [surface, text] of surfaces) {
    for (const [kind, pattern] of patterns) {
      const m = pattern.exec(text);
      if (m) found.push({ surface, kind, claimed: Number(m[1]) });
    }
  }
  return found;
}

async function main(): Promise<number> {
  const drifts: Drift[] = [];

  let npm: any;
  let gh: any;
  try {
    [npm, gh] = await Promise.all([getJson(NPM_DOWNLOADS), getJson(GITHUB_REPO)]);
  } catch (err) {
    // A failed fetch is NOT a clean result. Report it as unchecked, with a
    // distinct exit code, so a network outage can never read as "no drift".
    console.error(`UNABLE TO CHECK — live sources unreachable: ${(err as Error).message}`);
    console.error("This is not a pass. Nothing was verified; re-run when the sources respond.");
    return 2;
  }

  const claimed = await statedDownloads();
  const live = npm.downloads as number;
  const drift = Math.abs(live - claimed.value) / Math.max(live, 1);
  if (drift > DRIFT_TOLERANCE) {
    drifts.push({
      surface: "src/engine.ts limitations[] + data/BUILD-LOG.md",
      claim: `${claimed.value} (as of ${claimed.asOf})`,
      live: String(live),
      detail:
        `${(drift * 100).toFixed(1)}% off, tolerance ${(DRIFT_TOLERANCE * 100).toFixed(0)}%. ` +
        "Update both surfaces and the as-of date together.",
    });
  }

  for (const stated of await statedRepoState()) {
    const live = stated.kind === "stars" ? gh.stargazers_count : gh.open_issues_count;
    if (stated.claimed !== live) {
      drifts.push({
        surface: stated.surface,
        claim: `${stated.claimed} ${stated.kind}`,
        live: String(live),
        detail: `${stated.kind} move in both directions; exact match is required.`,
      });
    }
  }

  if (drifts.length === 0) {
    console.log(
      `All external claims still accurate — ${PACKAGE} downloads ${live} ` +
        `(claimed ${claimed.value} as of ${claimed.asOf}), ${REPO} ` +
        `${gh.stargazers_count} stars / ${gh.open_issues_count} open issues.`,
    );
    return 0;
  }

  console.error(`${drifts.length} external claim(s) have drifted from their live source:\n`);
  for (const d of drifts) {
    console.error(`  ${d.surface}`);
    console.error(`    claims: ${d.claim}`);
    console.error(`    live:   ${d.live}`);
    console.error(`    ${d.detail}\n`);
  }
  console.error(
    "These numbers are served to agents via get_projects and to readers via the retrieval " +
      "corpus. A stale figure is a cited claim that is no longer true.",
  );
  return 1;
}

process.exitCode = await main();
