/**
 * Guard: every URL this server hands a caller must be publicly fetchable.
 *
 * `get_projects` is an evidence tool. Its whole value is that a caller can
 * follow a link and check a claim, so a URL that 404s is worse than an absent
 * one: it asserts inspectable code that nobody can inspect, and the caller
 * only finds out after clicking.
 *
 * This shipped broken. `simplescope`'s repo is private, and `evidence[]`
 * deliberately refused to list the repo URL with a comment saying "the URL
 * returns 404 unauthenticated, so listing it offered a dead link as proof" —
 * but the sibling `repo:` field emitted that exact URL anyway. The honest
 * decision was made in one field and contradicted in another, and every test,
 * `tsc` and the deploy check stayed green.
 *
 * Design, following tests/project-list.test.ts: the expectation is DERIVED by
 * calling the real function, never a hand-copied list, so a newly added
 * project is covered automatically instead of being silently exempt.
 *
 * Network calls are skipped when OFFLINE=1 so the suite stays runnable with no
 * egress; the structural half (shape of any `repo` value, and the requirement
 * that a project without one explains why) always runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { doGetProjects } from "../src/engine.js";

const OFFLINE = process.env.OFFLINE === "1";

/** A URL is "live" if it is fetchable by an anonymous reader. */
async function statusOf(url: string): Promise<number> {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "user-agent": "ask-edgeorgie-mcp link check" },
    signal: AbortSignal.timeout(20_000),
  });
  return res.status;
}

test("every project's repo URL, when present, is a public GitHub URL", async () => {
  const projects = await doGetProjects();
  assert.ok(projects.length > 0, "no projects to check");

  for (const p of projects) {
    if (p.repo === undefined) continue;
    assert.match(
      p.repo,
      /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/,
      `${p.name}: repo must be a bare https GitHub URL, got ${p.repo}`,
    );
  }
});

test("a project with no repo URL says why in limitations", async () => {
  for (const p of await doGetProjects()) {
    if (p.repo !== undefined) continue;
    const explains = p.limitations.some((l) => /private|not public|no public repo/i.test(l));
    assert.ok(
      explains,
      `${p.name}: omits a repo URL but no limitation explains the absence, ` +
        `so a caller cannot tell a deliberate omission from a data gap`,
    );
  }
});

test(
  "no served URL 404s for an anonymous reader",
  { skip: OFFLINE ? "OFFLINE=1" : false },
  async () => {
    const projects = await doGetProjects();

    // Collect every URL the tool emits: repo fields plus any link inside the
    // prose arrays, which is where evidence links actually live.
    //
    // EXCEPTION: a URL whose own sentence says it 404s. Several limitations
    // cite `registry.npmjs.org/<name>` → 404 as the PROOF that a project is
    // not published; there the 404 is the evidence, not a broken link. Only
    // URLs offered as something a reader should successfully open are checked.
    const urls = new Set<string>();
    const cited404 = /404|not published|not on (a |any )?(npm|registry)/i;
    for (const p of projects) {
      if (p.repo) urls.add(p.repo);
      for (const line of [...p.realMetrics, ...p.evidence, ...p.limitations]) {
        for (const m of line.matchAll(/https?:\/\/[^\s)<>"'`,]+/g)) {
          const url = m[0].replace(/[.,;:`]$/, "");
          // Look only at the clause around this URL, so one 404 mention does
          // not exempt every other link in a long paragraph.
          const at = line.indexOf(m[0]);
          const clause = line.slice(Math.max(0, at - 90), at + m[0].length + 90);
          if (cited404.test(clause)) continue;
          urls.add(url);
        }
      }
    }
    assert.ok(urls.size > 0, "expected at least one URL to check");

    const dead: string[] = [];
    await Promise.all(
      [...urls].map(async (url) => {
        let status: number;
        try {
          status = await statusOf(url);
        } catch {
          return; // network flake: do not fail the suite on egress problems
        }
        // 403/429 = reachable but bot-walled (LinkedIn, rate limits).
        // 405 = endpoint exists, wrong method. Only 404/410 mean "not there".
        if (status === 404 || status === 410) dead.push(`${status} ${url}`);
      }),
    );

    assert.deepEqual(dead, [], `served URLs that do not resolve:\n  ${dead.join("\n  ")}`);
  },
);
