/**
 * Guard for the external-metric freshness job's own ABILITY TO RUN.
 *
 * WHY THIS EXISTS AS A SEPARATE FILE
 *
 * `external-metric-claims.test.ts` guards what the claims SAY. This guards
 * whether the job that checks them can reach its sources at all — a different
 * failure mode, and the one that actually fired.
 *
 * `scripts/check-external-metrics.ts` is built around one property: "could not
 * check" is never reported as a pass (exit 2, distinct from exit 1 for drift).
 * That property held. What defeated the job was upstream of it — it called
 * `api.github.com` with no credential, and the unauthenticated budget is 60
 * requests/hour **per source IP**, shared across every job on GitHub's runner
 * NAT pool. So the run was refused having made no prior call of its own:
 *
 *     run 38188353650, PR branch dependabot/github_actions/actions/setup-node-7
 *     UNABLE TO CHECK — live sources unreachable:
 *     https://api.github.com/repos/edgeorgie/crispy-profiling -> HTTP 403
 *
 * A freshness gate that is red for a reason unrelated to the change under
 * review is one nobody reads, which is strictly worse than not having it:
 * the next REAL drift lands in a check that has been failing for weeks.
 *
 * WHAT IS ENFORCED, AND WHY EACH ASSERTION IS THE DERIVED ONE
 *
 * The fix is two coupled halves — the script must SEND the header, and the
 * workflow must SUPPLY the token — and either half alone is silently useless.
 * A test over only one of them is the "client half proven, server half
 * assumed" shape this project has already been bitten by. So both are
 * asserted, each against its own real file, and the coupling between them
 * (the env var NAME) is asserted rather than assumed to match.
 *
 * Deliberately NOT enforced here: whether the token actually raises the limit.
 * That is GitHub's behaviour, not this repo's, and asserting it would need a
 * network call in the per-PR suite. It was verified once, by hand, in both
 * directions: with no token the script exits 0 against the local
 * unauthenticated budget, and with a deliberately-invalid token it reports
 * `HTTP 401` — a 401 can only come back if the authorization header genuinely
 * reached GitHub, which is the proof that the header is wired, not merely
 * constructed.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCRIPT = "scripts/check-external-metrics.ts";
const WORKFLOW = ".github/workflows/external-metrics.yml";

/** The env var the two halves must agree on. Asserted, never assumed. */
const PRIMARY_TOKEN_VAR = "GITHUB_TOKEN";

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, rel), "utf8");
}

test("the metric checker reads a GitHub token from the environment", async () => {
  const src = await read(SCRIPT);

  assert.match(
    src,
    new RegExp(`process\\.env\\.${PRIMARY_TOKEN_VAR}`),
    `${SCRIPT} must read \`process.env.${PRIMARY_TOKEN_VAR}\`. Without it every ` +
      `api.github.com call runs on the 60/hour-per-IP unauthenticated budget, shared ` +
      `across GitHub's runner NAT pool, and the job fails 403 on PRs that did not touch ` +
      `any claim (observed: run 38188353650).`,
  );
});

test("the token is actually sent as an Authorization header, not merely read", async () => {
  const src = await read(SCRIPT);

  // Reading the env var and never using it is the exact shape of a fix that
  // looks applied and does nothing — so the header construction is asserted
  // separately from the env read above.
  assert.match(
    src,
    /authorization\b/i,
    `${SCRIPT} reads a token but never builds an \`authorization\` header, so every ` +
      `request still goes out unauthenticated. The env read alone is not the fix.`,
  );
  assert.match(
    src,
    /Bearer \$\{token\}|Bearer \$\{.*[Tt]oken.*\}/,
    `${SCRIPT} must send the token as \`Bearer <token>\`; api.github.com rejects other ` +
      `schemes, and a malformed header degrades silently back to the 60/hour budget.`,
  );
});

test("the token stays OPTIONAL, so a local run with no credential still works", async () => {
  const src = await read(SCRIPT);

  // The script must not become CI-only. A hard requirement on the token would
  // make `npm run check:external` unrunnable on a developer machine, which is
  // how a check stops being used before it stops being correct.
  assert.match(
    src,
    /if \(token\)|token \?\?|token &&/,
    `${SCRIPT} must treat the token as optional (guard the header on its presence). ` +
      `A hard requirement makes a local \`npm run check:external\` impossible.`,
  );
});

test("the workflow supplies the token to the step that needs it", async () => {
  const wf = await read(WORKFLOW);

  assert.match(
    wf,
    new RegExp(`${PRIMARY_TOKEN_VAR}:\\s*\\$\\{\\{\\s*secrets\\.GITHUB_TOKEN\\s*\\}\\}`),
    `${WORKFLOW} must pass \`${PRIMARY_TOKEN_VAR}: \${{ secrets.GITHUB_TOKEN }}\` to the ` +
      `check step. The script half is inert without it — this is the server half of a ` +
      `two-part fix, and proving only the script half is how half-fixes ship.`,
  );
});

test("the env var name in the workflow is the one the script actually reads", async () => {
  const [src, wf] = await Promise.all([read(SCRIPT), read(WORKFLOW)]);

  // The coupling between the two files is a plain string, with nothing in the
  // type system to keep it honest: renaming it on one side leaves both files
  // individually plausible and the job unauthenticated again.
  const inScript = new RegExp(`process\\.env\\.${PRIMARY_TOKEN_VAR}`).test(src);
  const inWorkflow = new RegExp(`${PRIMARY_TOKEN_VAR}:`).test(wf);

  assert.equal(
    inScript && inWorkflow,
    true,
    `${PRIMARY_TOKEN_VAR} must appear in BOTH ${SCRIPT} (read) and ${WORKFLOW} (supplied). ` +
      `Found in script: ${inScript}, in workflow: ${inWorkflow}. A rename on one side only ` +
      `silently returns the job to the unauthenticated budget.`,
  );
});

test("the workflow declares no more permission than the token needs", async () => {
  const wf = await read(WORKFLOW);

  // Least privilege: this job reads public repo metadata and nothing else.
  // `contents: read` is sufficient, and a widened scope on a job that runs
  // against pull_request refs is worth failing loudly over.
  assert.match(
    wf,
    /permissions:\s*\n\s+contents:\s*read\s*\n/,
    `${WORKFLOW} must keep \`permissions: { contents: read }\`. The metric check needs ` +
      `no write scope, and this job runs on pull_request refs.`,
  );
  assert.doesNotMatch(
    wf,
    /\b(contents|pull-requests|issues|packages|id-token):\s*write\b/,
    `${WORKFLOW} must not grant any \`write\` permission — nothing in a read-only ` +
      `freshness check requires one.`,
  );
});
