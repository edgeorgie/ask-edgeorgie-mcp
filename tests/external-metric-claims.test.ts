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
 */
const DOWNLOAD_CLAIM = /\*{0,2}([\d,]{3,})\*{0,2}\s+as of\s+(\d{4}-\d{2}-\d{2})/;

/** Any "as of <date>" occurrence, used to locate dated claims generically. */
const AS_OF = /as of\s+(\d{4}-\d{2}-\d{2})/g;

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

/** Extracts the dated download claim from a blob of text, or null. */
function extractDownloadClaim(text: string, surface: string): DatedClaim | null {
  const m = DOWNLOAD_CLAIM.exec(text);
  if (!m) return null;
  return { surface, value: parseFigure(m[1]), asOf: m[2] };
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

    const withClaim = crispy.limitations
      .map((l) => extractDownloadClaim(l, "src/engine.ts limitations[]"))
      .find((c): c is DatedClaim => c !== null);

    assert.ok(
      withClaim,
      "crispy-profiling's limitations no longer state a dated download figure. npm's counter " +
        "only ever goes up, so an undated or absent figure here is how the 754-vs-1266 drift " +
        'happened. State it as "<N> as of <YYYY-MM-DD>".',
    );
    return withClaim;
  });
}

/** The recruiter-facing surface: the corpus file the retrieval tool cites. */
async function claimFromBuildLog(): Promise<DatedClaim> {
  const text = await fs.readFile(path.join(repoRoot, "data", "BUILD-LOG.md"), "utf8");
  const claim = extractDownloadClaim(text, "data/BUILD-LOG.md");
  assert.ok(
    claim,
    "data/BUILD-LOG.md no longer states a dated download figure. This file is indexed into " +
      "the corpus, so an undated number here is served to recruiters as a cited fact with " +
      "no way to judge its age.",
  );
  return claim;
}

test("the claim extractor is not vacuous", () => {
  // Positive controls. Without these, an extractor that always returned null
  // (pattern typo, changed wording) would make the assertions below pass for
  // entirely the wrong reason — a vacuous guard is worse than none, because it
  // licenses the belief that this class of drift is handled.
  assert.deepEqual(extractDownloadClaim("the figure is 1266 as of 2026-10-11.", "x"), {
    surface: "x",
    value: 1266,
    asOf: "2026-10-11",
  });
  assert.deepEqual(extractDownloadClaim("stands at **1,266 as of 2026-10-11**", "x"), {
    surface: "x",
    value: 1266,
    asOf: "2026-10-11",
  });
  // Undated figures must NOT be accepted — that is the whole defect.
  assert.equal(extractDownloadClaim("npm reports 754 downloads", "x"), null);
  assert.equal(extractDownloadClaim("no numbers here at all", "x"), null);
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

    const undated = [...text.matchAll(/(?:reports|downloads?:?\s*)\**([\d,]{3,})\**/gi)]
      .map((m) => m[1].replace(/,/g, ""))
      .filter((n) => !datedFigures.has(n));

    assert.deepEqual(
      undated,
      [],
      `${surface} states download figure(s) [${undated.join(", ")}] with no "as of <date>". ` +
        "npm's counter only goes up, so an undated figure is a claim that silently becomes " +
        "false. Attach a date, or drop the number.",
    );
  }
});
