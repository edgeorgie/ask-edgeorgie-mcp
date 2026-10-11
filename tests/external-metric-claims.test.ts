/**
 * Guard for claims whose AUTHORITY LIVES OUTSIDE THIS REPO.
 *
 * WHY THIS IS A DIFFERENT CLASS FROM EVERY OTHER GUARD HERE
 *
 * The guards already in this suite all work the same way: something in the
 * code is authoritative (`CORPUS_FILES`, `doGetProjects()`, `listTools()`,
 * the real tsconfig program), prose restates it, and the test derives the
 * expectation by calling the real thing. That shape cannot work here.
 *
 * `crispy-profiling`'s npm download count is a fact about a third party's
 * live state. Nothing in this repository knows it, so there is no local
 * authority to derive from — and the number is monotonically increasing, so
 * unlike "0 stars" or "2 open issues" (both of which happened to still be
 * exact when this was written) it is GUARANTEED to go stale by simply
 * existing. It did: the served corpus told recruiters 754 while npm reported
 * 1266, a 68% understatement, with `tsc`, the build, CI, the deploy check and
 * all 62 tests green. The metric's SHAPE is what made it rot, which is the
 * part worth generalising — a cumulative counter in static prose has an
 * expiry date whether or not anyone writes one down.
 *
 * WHAT IS ENFORCED HERE, AND WHAT DELIBERATELY IS NOT
 *
 * Offline and deterministic, so it belongs in the per-PR suite:
 *
 *   1. CROSS-MIRROR EQUALITY. The claim is stated twice — in
 *      `src/engine.ts`'s `limitations` (served to agents via `get_projects`)
 *      and in `data/BUILD-LOG.md` (served to recruiters via retrieval). Those
 *      two numbers must be equal. This half IS derivable, and it is the half
 *      that would otherwise let a future fix update one surface and leave the
 *      other serving the old figure — the exact mirror-drift this repo has
 *      now killed four times.
 *   2. THE CLAIM MUST BE DATED. An undated external number cannot be judged
 *      by a reader at all: 1266 with no date is indistinguishable from 754
 *      with no date. Requiring "as of <ISO date>" turns an invisible
 *      staleness bug into a visible, checkable one.
 *   3. THE DATE MUST BE REAL. Parseable, and not in the future.
 *
 * NOT enforced here: whether the number is actually CORRECT right now. That
 * requires a network call to `api.npmjs.org`, and putting one in this suite
 * would (a) make every PR's CI depend on a third party being reachable, and
 * (b) fail builds for a reason unrelated to the change under review. Freshness
 * is owned instead by `npm run check:external`, which queries the real
 * registry and is wired to a SCHEDULED workflow — so drift is surfaced loudly
 * on a timer without holding unrelated work hostage. The division is
 * deliberate: this file proves the claim is internally consistent and
 * self-dating, the script proves it is true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { doGetProjects } from "../src/engine.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Matches a lifetime-download claim and captures the figure. Tolerant of
 * thousands separators and of surrounding markdown emphasis, so a prose edit
 * that bolds the number does not silently stop being checked.
 *
 * GLOBAL on purpose. The first version used a non-global `.exec()` against the
 * whole corpus file, so the FIRST match won — and a dated decoy earlier in the
 * text ("the retrieval index covers 1266 as of 2026-10-11") let the real
 * figure rot back to 754 with the suite green. Every surface must now contain
 * exactly ONE claim, asserted below.
 */
const DOWNLOAD_CLAIM = /\*{0,2}([\d,]{3,})\*{0,2}\s+as of\s+(\d{4}-\d{2}-\d{2})/g;

/** Any "as of <date>" occurrence, used to locate dated claims generically. */
const AS_OF = /as of\s+(\d{4}-\d{2}-\d{2})/g;

/**
 * A download figure stated in prose, dated or not.
 *
 * The first version of this pattern was `(?:reports|downloads?:?\s*)\**([\d,]{3,})`
 * — with no separator between the alternation and the capture group, so
 * `reports` had to be IMMEDIATELY followed by digits. It therefore did not
 * match "npm reports 754 downloads", the exact string the test below names as
 * the regression it prevents, and the test was vacuous on a clean tree: the
 * pre-filter match set was empty, so `assert.deepEqual([], [])` judged
 * nothing. The anti-vacuity assertion below now fails if that recurs.
 */
const ANY_FIGURE = /(?:reports|downloads?)\b[^\d\n]{0,16}([\d,]{3,})/gi;

interface DatedClaim {
  /** Where it was found, for failure messages. */
  surface: string;
  /** The numeric figure asserted. */
  value: number;
  /** The ISO date the claim is scoped to. */
  asOf: string;
}

function parseFigure(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/**
 * Extracts the dated download claims from a blob of text.
 *
 * Returns ALL of them so the caller can require exactly one — a surface with
 * two dated figures is ambiguous, and the one that gets checked may not be the
 * one a reader sees.
 */
function extractDownloadClaims(text: string, surface: string): DatedClaim[] {
  return [...text.matchAll(DOWNLOAD_CLAIM)].map((m) => ({
    surface,
    value: parseFigure(m[1]),
    asOf: m[2],
  }));
}

/** The single dated claim in a surface, failing if there is not exactly one. */
function soleDownloadClaim(text: string, surface: string, hint: string): DatedClaim {
  const claims = extractDownloadClaims(text, surface);
  assert.equal(
    claims.length,
    1,
    `${surface}: expected exactly 1 dated download claim, found ${claims.length}` +
      (claims.length > 1
        ? ` (${claims.map((c) => `${c.value} as of ${c.asOf}`).join("; ")}). A second dated ` +
          `figure makes the match ambiguous — that is how a decoy let the real figure rot ` +
          `back to a stale value with this suite green.`
        : `. ${hint}`),
  );
  return claims[0];
}

/**
 * The agent-facing surface: the `limitations` entry on crispy-profiling that
 * `get_projects` returns. Read through the real function, not by grepping the
 * source, so a refactor that moves the text still gets checked.
 */
function claimFromEngine(): Promise<DatedClaim> {
  return doGetProjects().then((projects) => {
    const crispy = projects.find((p) => p.name === "crispy-profiling");
    assert.ok(
      crispy,
      `doGetProjects() no longer returns a project named "crispy-profiling" ` +
        `(found: ${projects.map((p) => p.name).join(", ")}). If it was renamed, update this ` +
        "guard; if it was removed, delete this guard rather than letting it pass vacuously.",
    );

    return soleDownloadClaim(
      crispy.limitations.join("\n"),
      "src/engine.ts limitations[]",
      "crispy-profiling's limitations no longer state a dated download figure. npm's counter " +
        "only ever goes up, so an undated or absent figure here is how the 754-vs-1266 drift " +
        'happened. State it as "<N> as of <YYYY-MM-DD>".',
    );
  });
}

/** The recruiter-facing surface: the corpus file the retrieval tool cites. */
async function claimFromBuildLog(): Promise<DatedClaim> {
  const text = await fs.readFile(path.join(repoRoot, "data", "BUILD-LOG.md"), "utf8");
  return soleDownloadClaim(
    text,
    "data/BUILD-LOG.md",
    "data/BUILD-LOG.md no longer states a dated download figure. This file is indexed into " +
      "the corpus, so an undated number here is served to recruiters as a cited fact with " +
      "no way to judge its age.",
  );
}

test("the claim extractor is not vacuous", () => {
  // Positive controls. Without these, an extractor that always matched nothing
  // (pattern typo, changed wording) would make the assertions below pass for
  // entirely the wrong reason — a vacuous guard is worse than none, because it
  // licenses the belief that this class of drift is handled.
  assert.deepEqual(extractDownloadClaims("the figure is 1266 as of 2026-10-11.", "x"), [
    { surface: "x", value: 1266, asOf: "2026-10-11" },
  ]);
  assert.deepEqual(extractDownloadClaims("stands at **1,266 as of 2026-10-11**", "x"), [
    { surface: "x", value: 1266, asOf: "2026-10-11" },
  ]);
  // Undated figures must NOT be accepted — that is the whole defect.
  assert.deepEqual(extractDownloadClaims("npm reports 754 downloads", "x"), []);
  assert.deepEqual(extractDownloadClaims("no numbers here at all", "x"), []);
  // Two dated figures must be reported as two, so the caller can reject the
  // ambiguity rather than silently checking whichever came first.
  assert.equal(
    extractDownloadClaims("index covers 1266 as of 2026-10-11; stands at 754 as of 2026-10-11", "x")
      .length,
    2,
  );

  // ANY_FIGURE's own controls, which the first version of this file omitted —
  // it positive-controlled the dated extractor and then relied on a DIFFERENT,
  // broken pattern for the undated check below.
  const figuresIn = (s: string) => [...s.matchAll(ANY_FIGURE)].map((m) => m[1]);
  assert.deepEqual(figuresIn("npm reports 754 downloads"), ["754"]);
  assert.deepEqual(figuresIn("npm reports 2,400 installs"), ["2,400"]);
  assert.deepEqual(figuresIn("downloads: 2400"), ["2400"]);
  assert.deepEqual(figuresIn("no figures at all here"), []);
});

test("both surfaces state the same download figure, and it is dated", async () => {
  const engine = await claimFromEngine();
  const buildLog = await claimFromBuildLog();

  assert.equal(
    engine.value,
    buildLog.value,
    `The agent-facing and recruiter-facing surfaces disagree: ` +
      `${engine.surface} says ${engine.value}, ${buildLog.surface} says ${buildLog.value}. ` +
      "One was updated and the other was not — update both, or neither.",
  );

  assert.equal(
    engine.asOf,
    buildLog.asOf,
    `Same figure (${engine.value}) but different as-of dates: ${engine.surface} is scoped to ` +
      `${engine.asOf}, ${buildLog.surface} to ${buildLog.asOf}. One of the two is lying about ` +
      "when it was last checked.",
  );
});

test("the as-of date is real and not in the future", async () => {
  for (const claim of [await claimFromEngine(), await claimFromBuildLog()]) {
    const parsed = new Date(`${claim.asOf}T00:00:00Z`);
    assert.ok(
      !Number.isNaN(parsed.getTime()),
      `${claim.surface} is dated "${claim.asOf}", which is not a real date.`,
    );
    // Compared against end-of-day UTC so a check run on the as-of date itself
    // never trips this.
    const endOfClaimDay = parsed.getTime() + 24 * 60 * 60 * 1000;
    assert.ok(
      endOfClaimDay <= Date.now() + 24 * 60 * 60 * 1000,
      `${claim.surface} claims a figure "as of ${claim.asOf}", which is in the future. A ` +
        "measurement cannot be dated later than the moment it was taken.",
    );
  }
});

test("no undated cumulative figure is reintroduced alongside the dated one", async () => {
  // The specific regression shape: someone adds "npm reports N downloads"
  // next to the dated claim, and the dated one stops being the number a
  // reader sees first. Every download figure in these surfaces must be
  // attached to an as-of date.
  const buildLog = await fs.readFile(path.join(repoRoot, "data", "BUILD-LOG.md"), "utf8");
  const engineText = (await doGetProjects()).flatMap((p) => p.limitations).join("\n");

  for (const [surface, text] of [
    ["data/BUILD-LOG.md", buildLog],
    ["src/engine.ts limitations[]", engineText],
  ] as const) {
    const datedFigures = new Set<string>();
    for (const m of text.matchAll(AS_OF)) {
      // Capture the figure immediately preceding each "as of".
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      const fig = /([\d,]{3,})\*{0,2}\s*$/.exec(before);
      if (fig) datedFigures.add(fig[1].replace(/,/g, ""));
    }

    const allFigures = [...text.matchAll(ANY_FIGURE)].map((m) => m[1].replace(/,/g, ""));

    // ANTI-VACUITY FLOOR, on the DATED extractor rather than on ANY_FIGURE.
    //
    // The previous version of this test filtered an always-empty match set and
    // asserted `[] === []`, which judged nothing — its pattern required digits
    // immediately after "reports", so the exact regression string named in the
    // comment above did not match. ANY_FIGURE is now unit-tested against that
    // string directly (see "the claim extractor is not vacuous").
    //
    // The floor here is deliberately NOT "ANY_FIGURE matched something": a
    // surface may legitimately state its figure as "stands at 1266 as of
    // <date>" with no "reports"/"downloads" within reach of the number, and
    // demanding otherwise would dictate prose wording rather than check a
    // fact. What must hold is that this surface states a figure we can SEE —
    // if the dated claim is gone, the subtraction below has nothing to
    // subtract from and the check is meaningless.
    assert.equal(
      datedFigures.size >= 1,
      true,
      `${surface}: found NO dated download figure, so the undated-figure check below ` +
        `would pass vacuously. Either the claim was removed from this surface, or it is ` +
        `no longer written as "<N> as of <YYYY-MM-DD>".`,
    );

    const undated = allFigures.filter((n) => !datedFigures.has(n));

    assert.deepEqual(
      undated,
      [],
      `${surface} states download figure(s) [${undated.join(", ")}] with no "as of <date>". ` +
        "npm's counter only goes up, so an undated figure is a claim that silently becomes " +
        "false. Attach a date, or drop the number.",
    );
  }
});
