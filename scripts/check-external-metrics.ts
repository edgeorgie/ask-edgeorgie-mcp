/**
 * Checks the repo's externally-sourced claims against their real live
 * sources, and exits nonzero on drift OR on any declared claim it could not
 * find.
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
 * .github/workflows/external-metrics.yml). Drift gets surfaced on a timer;
 * nobody's PR is held hostage by api.npmjs.org.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY COVERAGE IS DECLARED, NOT DISCOVERED  (the bug that shaped this file)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The first version of this script ran a regex per metric and did
 * `if (match) record(...)`. A claim whose WORDING changed therefore vanished
 * from the result set instead of being reported — and with an empty result
 * set the script printed "All external claims still accurate" and exited 0.
 * Measured: rewording `0 open issues on the repo` to `7 open issues on the
 * tracker` left a flatly false claim being served with this checker reporting
 * clean. Its `stars` pattern was separately defeated by a thousands
 * separator: `/(\d+)\s+GitHub stars/` against "1,000 GitHub stars" captures
 * "000", which is 0, which matched the live count exactly.
 *
 * That is a third instance of the pattern that defeated two earlier guards in
 * this project — asserting on the PRESENCE of something rather than the
 * behaviour behind it — and it was sitting in the file whose own docstring
 * warned about it.
 *
 * The structural fix: every claim this script is responsible for is DECLARED
 * in `CLAIMS` below, and a declared claim that cannot be located in the prose
 * is a failure (exit 2, "could not check"), never silence. Adding a claim
 * surface means adding a row, and a reworded claim fails loudly until the row
 * is updated. Coverage is a property of the table, not of whether a regex
 * happened to fire.
 *
 * Exits:
 *   0 = every declared claim was found AND still matches its live source
 *   1 = drift found (a claim was located and is now wrong)
 *   2 = could not check (sources unreachable, or a declared claim not found)
 *
 * Usage: npm run check:external
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { doGetProjects } from "../src/engine.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Relative drift above which a stated download figure is called stale.
 *
 * Deliberately small. An earlier 15% was miscalibrated in both directions: a
 * single publish day moved 512 downloads (40% of the total at the time), so it
 * was far too narrow to absorb the real noise source it was written for, while
 * still permitting ~190 downloads of silent staleness. Staleness is better
 * bounded by the as-of DATE than by a value band, which is what
 * MAX_CLAIM_AGE_DAYS does; this tolerance now only absorbs the handful of
 * mirror refetches that land between a correct update and the next check.
 */
const DRIFT_TOLERANCE = 0.02;

/**
 * How old a dated claim may be before it is reported regardless of drift.
 *
 * This is the assertion that actually matches the risk. A cumulative counter
 * is never "wrong by X%" in a way a reader cares about — it is OUT OF DATE,
 * and the honest signal is the age of the measurement.
 */
const MAX_CLAIM_AGE_DAYS = 45;

const PACKAGE = "crispy-profiling";

/**
 * Lifetime download total.
 *
 * NOT `point/last-month`, which the first version used on the reasoning that
 * any window spanning the first publish returns the running total. True when
 * written, and a clock bomb: `last-month` is a ROLLING window, so once it
 * stopped spanning 2026-10-05 it would have reported a partial figure and the
 * weekly job would have cried ~100% drift against a correct claim forever.
 * Measured at the time of writing: `last-month` 1266 (correct), but the
 * explicit window `2026-10-06:2026-10-12` only 743. A fixed start date cannot
 * roll off the first publish.
 */
function npmLifetimeUrl(pkg: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `https://api.npmjs.org/downloads/point/1970-01-01:${today}/${pkg}`;
}

/** Comma-tolerant on purpose: figures in prose are written "1,266" as often as "1266". */
const DOWNLOAD_CLAIM = /\*{0,2}([\d,]{3,})\*{0,2}\s+as of\s+(\d{4}-\d{2}-\d{2})/g;

/** A repo-state claim: which repo, which metric, and the pattern that locates it. */
interface RepoClaim {
  /** Human label for the failure message. */
  label: string;
  /** owner/repo whose live state is authoritative. */
  repo: string;
  /** Which GitHub field answers it. */
  metric: "stargazers_count" | "open_issues_count" | "forks_count" | "subscribers_count";
  /**
   * Must capture the figure in group 1, and MUST carry the `g` flag — see
   * `assertGlobal`. Comma-tolerant: a `(\d+)` here is how the stars check was
   * silently defeated by "1,000".
   */
  pattern: RegExp;
  /**
   * Which prose surfaces are REQUIRED to state it. A declared surface missing
   * the claim is "could not check" (exit 2).
   *
   * This is a floor, not a ceiling: the pattern is evaluated against EVERY
   * surface, and any occurrence anywhere that disagrees with the live value is
   * drift. Declaring a surface only adds the requirement that the claim be
   * present there — it never exempts the others from being read.
   */
  surfaces: SurfaceId[];
}

type SurfaceId = "data/BUILD-LOG.md" | "src/engine.ts limitations[]";

/**
 * EVERY external claim this script is responsible for.
 *
 * Generalised past the single package the first version hard-coded. It checked
 * only `crispy-profiling` and so never looked at `simplescope`'s "12 open
 * issues" — the MORE volatile of the two, since it moves whenever the author
 * files anything.
 *
 * `simplescope` is nonetheless ABSENT from this table, for a reason worth
 * recording rather than quietly omitting: the repo is PRIVATE. Its API returns
 * 404 unauthenticated, so this job — which runs with no secrets, by design —
 * cannot verify any claim about it, and declaring it here would make the
 * scheduled run permanently exit 2. The honest consequence is that
 * `simplescope`'s open-issue count is unverifiable from CI and must be
 * maintained by hand; see the note on it in src/engine.ts. A row here would
 * look like coverage without being any.
 */
const CLAIMS: RepoClaim[] = [
  {
    label: "crispy-profiling stars",
    repo: "edgeorgie/crispy-profiling",
    metric: "stargazers_count",
    pattern: /([\d,]+)\s+GitHub stars/g,
    surfaces: ["data/BUILD-LOG.md", "src/engine.ts limitations[]"],
  },
  {
    label: "crispy-profiling open issues",
    repo: "edgeorgie/crispy-profiling",
    metric: "open_issues_count",
    pattern: /([\d,]+)\s+open issues? on the repo/g,
    surfaces: ["src/engine.ts limitations[]"],
  },
];

/**
 * A `RepoClaim.pattern` without the `g` flag silently degrades this check from
 * "every occurrence" to "the first occurrence", which is the same non-global
 * `.exec()` defect already fixed once for the download claim. The flag is load
 * bearing, so it is asserted rather than trusted to survive editing.
 */
function assertGlobal(claims: RepoClaim[]): void {
  const bad = claims.filter((c) => !c.pattern.flags.includes("g"));
  if (bad.length > 0) {
    throw new Error(
      `CLAIMS pattern(s) missing the \`g\` flag: ${bad.map((c) => c.label).join(", ")}. ` +
        `Without it only the first occurrence in each surface is read, so a second, ` +
        `contradictory figure elsewhere in the same text is never compared.`,
    );
  }
}

interface Problem {
  kind: "drift" | "unchecked";
  surface: string;
  message: string;
}

/**
 * Why api.github.com calls are AUTHENTICATED when a token is present.
 *
 * Unauthenticated, api.github.com allows 60 requests/hour **per source IP**,
 * and GitHub-hosted runners share a NAT pool with every other job on the
 * platform. The budget is therefore not this repo's to spend: a run can be
 * refused having made no prior call of its own. Measured on a real PR
 * (`dependabot/github_actions/actions/setup-node-7`, run 38188353650): this
 * job exited 2 with
 *
 *     UNABLE TO CHECK — live sources unreachable:
 *     https://api.github.com/repos/edgeorgie/crispy-profiling -> HTTP 403
 *
 * That exit code was CORRECT — "could not check" is not a pass, which is the
 * property this script was built around. The defect is upstream of it: the
 * check cannot answer its question on a shared IP, so it fails on a condition
 * unrelated to the change under review. An alert that fires on something the
 * reader cannot act on is noise, and noise on a freshness gate is worse than
 * no gate, because a permanently-red check is one nobody reads.
 *
 * `GITHUB_TOKEN` raises the ceiling to 5,000/hour scoped to this repository's
 * installation, and `permissions: contents: read` is all it needs. The token
 * is optional on purpose: a local `npm run check:external` with no token in
 * the environment still works against the unauthenticated budget, so the
 * script is not CI-only.
 *
 * api.npmjs.org is deliberately NOT authenticated — it takes no credential and
 * has no comparable per-IP limit.
 */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "ask-edgeorgie-mcp-metric-check",
    "x-github-api-version": "2022-11-28",
  };
  // GH_TOKEN as well as GITHUB_TOKEN: the former is what `gh` exports, so a
  // local run inside an authenticated shell picks the higher limit up for free.
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    // Rate-limit refusals are reported as such rather than as a bare status.
    // A 403 from api.github.com is overwhelmingly an exhausted budget, not a
    // permissions problem, and the two want different responses from a reader:
    // one is "wait or add a token", the other is "the claim is unverifiable".
    const remaining = res.headers.get("x-ratelimit-remaining");
    const detail =
      remaining === "0"
        ? ` (rate limit exhausted; x-ratelimit-limit=${res.headers.get("x-ratelimit-limit")}` +
          `, resets at ${new Date(
            Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000,
          ).toISOString()}` +
          `${headers.authorization ? "" : " — this request was UNAUTHENTICATED"})`
        : "";
    throw new Error(`${url} -> HTTP ${res.status}${detail}`);
  }
  return res.json();
}

function parseFigure(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/**
 * The prose of each claim surface, keyed by id.
 *
 * `src/engine.ts limitations[]` is read through the real `doGetProjects()`
 * rather than by grepping the file, so a refactor that moves the text still
 * gets checked — and ALL projects' limitations are included, not one package's.
 */
async function loadSurfaces(): Promise<Map<SurfaceId, string>> {
  const projects = await doGetProjects();
  return new Map<SurfaceId, string>([
    [
      "data/BUILD-LOG.md",
      await fs.readFile(path.join(repoRoot, "data", "BUILD-LOG.md"), "utf8"),
    ],
    ["src/engine.ts limitations[]", projects.flatMap((p) => p.limitations).join("\n")],
  ]);
}

/**
 * The dated download figure. Uses matchAll and requires EXACTLY ONE claim per
 * surface: the first version used a non-global `.exec()` over the whole
 * corpus file, so a dated decoy earlier in the text hijacked the match and the
 * real, rotten figure went unread.
 */
function downloadClaimsIn(text: string): Array<{ value: number; asOf: string }> {
  return [...text.matchAll(DOWNLOAD_CLAIM)].map((m) => ({
    value: parseFigure(m[1]),
    asOf: m[2],
  }));
}

async function main(): Promise<number> {
  const problems: Problem[] = [];
  const surfaces = await loadSurfaces();

  const repos = [...new Set(CLAIMS.map((c) => c.repo))];
  let npm: any;
  const ghByRepo = new Map<string, any>();
  const ghHeaders = githubHeaders();
  try {
    const [npmRes, ...ghRes] = await Promise.all([
      getJson(npmLifetimeUrl(PACKAGE), {
        accept: "application/json",
        "user-agent": "ask-edgeorgie-mcp-metric-check",
      }),
      ...repos.map((r) => getJson(`https://api.github.com/repos/${r}`, ghHeaders)),
    ]);
    npm = npmRes;
    repos.forEach((r, i) => ghByRepo.set(r, ghRes[i]));
  } catch (err) {
    // A failed fetch is NOT a clean result. Report it as unchecked, with a
    // distinct exit code, so a network outage can never read as "no drift".
    console.error(`UNABLE TO CHECK — live sources unreachable: ${(err as Error).message}`);
    console.error("This is not a pass. Nothing was verified; re-run when the sources respond.");
    return 2;
  }

  // ── The download claim: must appear exactly once per surface, agree across
  //    surfaces, be within tolerance of the live total, and not be stale.
  const liveDownloads = npm.downloads as number;
  const perSurface = new Map<SurfaceId, { value: number; asOf: string }>();
  for (const [id, text] of surfaces) {
    const claims = downloadClaimsIn(text);
    if (claims.length !== 1) {
      problems.push({
        kind: "unchecked",
        surface: id,
        message:
          `expected exactly 1 dated download claim, found ${claims.length}` +
          (claims.length > 1
            ? ` (${claims.map((c) => `${c.value} as of ${c.asOf}`).join("; ")}). More than ` +
              `one means an ambiguous match, and the wrong one may be the one checked.`
            : ". The claim is either missing or reworded past the pattern — either way it " +
              "is NOT being verified. Restate it, or update the pattern."),
      });
      continue;
    }
    perSurface.set(id, claims[0]);
  }

  for (const [id, claim] of perSurface) {
    const drift = Math.abs(liveDownloads - claim.value) / Math.max(liveDownloads, 1);
    if (drift > DRIFT_TOLERANCE) {
      problems.push({
        kind: "drift",
        surface: id,
        message:
          `claims ${claim.value} downloads (as of ${claim.asOf}), live total is ` +
          `${liveDownloads} — ${(drift * 100).toFixed(1)}% off, tolerance ` +
          `${(DRIFT_TOLERANCE * 100).toFixed(0)}%.`,
      });
    }

    const ageDays = (Date.now() - Date.parse(`${claim.asOf}T00:00:00Z`)) / 86_400_000;
    if (ageDays > MAX_CLAIM_AGE_DAYS) {
      problems.push({
        kind: "drift",
        surface: id,
        message:
          `the download figure is dated ${claim.asOf}, ${Math.floor(ageDays)} days ago ` +
          `(limit ${MAX_CLAIM_AGE_DAYS}). A cumulative counter this old is stale whether ` +
          `or not it is still numerically close.`,
      });
    }
  }

  // ── Repo-state claims: every DECLARED claim must be found on its declared
  //    surfaces, and EVERY occurrence on EVERY surface must match the live
  //    value — including surfaces the claim does not declare.
  //
  //    The declared-surface list alone was insufficient: an undeclared figure
  //    matching the same pattern could be added to any other surface and go
  //    unread, so a false "7 open issues on the repo" planted in
  //    data/BUILD-LOG.md (a surface the open-issues row does not declare) was
  //    served with this script reporting clean and exiting 0. Declaring a
  //    surface now raises a presence REQUIREMENT; it never scopes the reading.
  assertGlobal(CLAIMS);
  for (const claim of CLAIMS) {
    const gh = ghByRepo.get(claim.repo);
    const live = gh?.[claim.metric] as number | undefined;
    if (typeof live !== "number") {
      problems.push({
        kind: "unchecked",
        surface: claim.repo,
        message: `GitHub did not return \`${claim.metric}\` for ${claim.repo}.`,
      });
      continue;
    }

    for (const [surfaceId, text] of surfaces) {
      const matches = [...text.matchAll(claim.pattern)];

      if (matches.length === 0) {
        // Absent from a surface that is REQUIRED to state it: "could not
        // check", never "clean". Absent from a surface that merely may
        // mention it is fine and says nothing.
        if (claim.surfaces.includes(surfaceId)) {
          problems.push({
            kind: "unchecked",
            surface: surfaceId,
            message:
              `declared claim "${claim.label}" was NOT FOUND (pattern ${claim.pattern}). ` +
              `It was either removed or reworded — in both cases it is no longer being ` +
              `verified, and a reworded false claim would be served silently. Restate the ` +
              `claim, update the pattern, or delete the row from CLAIMS.`,
          });
        }
        continue;
      }

      for (const m of matches) {
        const claimed = parseFigure(m[1]);
        if (claimed !== live) {
          problems.push({
            kind: "drift",
            surface: surfaceId,
            message:
              `"${claim.label}" claims ${claimed}, live is ${live}` +
              (claim.surfaces.includes(surfaceId)
                ? "."
                : ` — found on a surface this claim does not declare, which is ` +
                  `exactly the case a declared-surfaces-only read would have missed.`),
          });
        }
      }
    }
  }

  if (problems.length === 0) {
    const summary = CLAIMS.map((c) => `${c.label}=${ghByRepo.get(c.repo)[c.metric]}`).join(", ");
    console.log(
      `All ${CLAIMS.length + perSurface.size} declared claims found and accurate — ` +
        `${PACKAGE} lifetime downloads ${liveDownloads}; ${summary}.`,
    );
    return 0;
  }

  const unchecked = problems.filter((p) => p.kind === "unchecked");
  const drifted = problems.filter((p) => p.kind === "drift");

  if (drifted.length > 0) {
    console.error(`${drifted.length} external claim(s) have DRIFTED from their live source:\n`);
    for (const p of drifted) console.error(`  ${p.surface}\n    ${p.message}\n`);
  }
  if (unchecked.length > 0) {
    console.error(`${unchecked.length} declared claim(s) could NOT BE CHECKED:\n`);
    for (const p of unchecked) console.error(`  ${p.surface}\n    ${p.message}\n`);
  }
  console.error(
    "These numbers are served to agents via get_projects and to readers via the retrieval " +
      "corpus. A stale figure is a cited claim that is no longer true; an unchecked one is " +
      "a claim nobody is watching.",
  );

  // An unlocatable claim is the more dangerous state — it looks like success
  // to any check that only reads the drift list — so it decides the exit code.
  return unchecked.length > 0 ? 2 : 1;
}

process.exitCode = await main();
