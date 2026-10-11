/**
 * The committed agent transcripts are a MIRROR of what the server returns, and
 * nothing in this repo regenerates them. That makes them the same drift class
 * already killed twice here (the /health `tools: [...]` array, the
 * CORPUS_FILES prose mirrors) — except worse, because a transcript is the
 * repo's own recorded EVIDENCE. A reviewer who opens examples/ sees what the
 * product used to do and takes it for what it does.
 *
 * It had already drifted, and in exactly the direction that matters. PR #26
 * made `limitations` required on every project entry — the whole point being
 * that an absent caveat must never read as "this one has none" — and PR #27
 * tightened the tool schema (`minItems`, `minLength: 40`, `limitations` in
 * `required`). Both transcripts were left at the pre-#26 shape:
 * examples/http-transcript.json carried `limitations` on 1 of 6 projects and
 * advertised the old, laxer schema. So the repo shipped a guard asserting
 * caveats are mandatory, alongside committed proof that they are not.
 *
 * WHAT THIS GUARD ASSERTS, AND WHY IT IS SHAPED THIS WAY.
 *
 * It does NOT compare transcript text to a fresh server response. That would
 * fail on every legitimate prose edit to a project description, which is both
 * noisy and wrong — the transcript is allowed to be a recording, it is not
 * allowed to be a recording of a DIFFERENT CONTRACT. So the comparison is
 * against the structural contract only, derived at runtime from the real
 * `doGetProjects()` and the real tool schema:
 *
 *   1. the set of project names is EQUAL (not a subset) in both directions, so
 *      a project added to the engine and a project deleted from it both fail;
 *   2. every project in every transcript carries a non-empty `limitations`
 *      array whose entries clear the same 40-char floor the live schema
 *      enforces — the specific regression that was found;
 *   3. the `get_projects` tool schema recorded in the transcript's
 *      `list_tools` lists `limitations` as required, so a transcript recorded
 *      against a server whose contract was laxer cannot pass.
 *
 * Regenerate with, from the repo root:
 *   npm run build
 *   node --import tsx examples/run-session.ts                                   # stdio
 *   node --import tsx examples/run-session.ts <deployed-url>/mcp examples/http-transcript.json
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doGetProjects } from "../src/engine.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Mirrors the live schema's `minLength` on a limitations entry. */
const MIN_LIMITATION_CHARS = 40;

const TRANSCRIPTS = ["examples/transcript.json", "examples/http-transcript.json"] as const;

interface TranscriptProject {
  name?: string;
  limitations?: unknown;
}

async function readTranscript(relPath: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(path.join(repoRoot, relPath), "utf8"));
}

function projectsOf(transcript: Record<string, any>, label: string): TranscriptProject[] {
  const projects = transcript?.get_projects?.structuredContent?.projects;
  assert.ok(
    Array.isArray(projects) && projects.length > 0,
    `${label}: no get_projects.structuredContent.projects array. Either the transcript ` +
      `predates structured output, or it was recorded against a failing server. ` +
      `Do not relax this assertion — regenerate the transcript.`,
  );
  return projects as TranscriptProject[];
}

test("both committed transcripts record the same project set the engine returns", async () => {
  const live = (await doGetProjects()).map((p) => p.name).sort();
  assert.ok(live.length > 0, "doGetProjects() returned nothing — this guard would be vacuous");

  for (const relPath of TRANSCRIPTS) {
    const recorded = projectsOf(await readTranscript(relPath), relPath)
      .map((p) => p.name)
      .filter((n): n is string => typeof n === "string")
      .sort();

    // Equality, not inclusion: a project REMOVED from the engine while still
    // advertised in a committed transcript is over-advertising evidence, which
    // is the worse direction for a provenance tool.
    assert.deepEqual(
      recorded,
      live,
      `${relPath} records projects [${recorded.join(", ")}] but the engine returns ` +
        `[${live.join(", ")}]. Regenerate the transcript (see this file's header).`,
    );
  }
});

test("every project in every committed transcript carries real limitations", async () => {
  for (const relPath of TRANSCRIPTS) {
    const projects = projectsOf(await readTranscript(relPath), relPath);

    for (const project of projects) {
      const where = `${relPath} → ${project.name ?? "<unnamed>"}`;
      assert.ok(
        Array.isArray(project.limitations) && project.limitations.length > 0,
        `${where}: no non-empty \`limitations\`. The live schema requires one on every ` +
          `entry precisely so an absent caveat never reads as "this one has none" — a ` +
          `transcript without it is committed proof of the opposite.`,
      );

      for (const limitation of project.limitations as unknown[]) {
        assert.equal(typeof limitation, "string", `${where}: a non-string limitation entry`);
        // A whitespace-only or one-word entry satisfied an earlier non-empty
        // check while saying nothing, so length is asserted on trimmed text
        // against the same floor the live schema enforces.
        assert.ok(
          (limitation as string).trim().length >= MIN_LIMITATION_CHARS,
          `${where}: limitation ${JSON.stringify(limitation)} is under ` +
            `${MIN_LIMITATION_CHARS} chars of real text. Length is not a policy, but the ` +
            `live schema enforces this floor and the transcript must record the same contract.`,
        );
      }
    }
  }
});

test("the tool schema recorded in each transcript requires limitations", async () => {
  for (const relPath of TRANSCRIPTS) {
    const transcript = await readTranscript(relPath);
    const tools = transcript?.list_tools?.tools;
    assert.ok(Array.isArray(tools), `${relPath}: no list_tools.tools array`);

    const getProjects = (tools as { name?: string }[]).find((t) => t.name === "get_projects");
    assert.ok(getProjects, `${relPath}: list_tools does not include get_projects`);

    // Walk to the per-project schema without assuming a fixed nesting depth,
    // so a schema refactor surfaces as "could not find it" rather than a
    // vacuous pass on an `undefined` that happens not to be compared.
    const entrySchema = (getProjects as any)?.outputSchema?.properties?.projects?.items;
    assert.ok(
      entrySchema,
      `${relPath}: could not locate the per-project output schema under ` +
        `get_projects.outputSchema.properties.projects.items. If the schema moved, update ` +
        `this path — do not delete the assertion.`,
    );
    assert.ok(
      Array.isArray(entrySchema.required) && entrySchema.required.includes("limitations"),
      `${relPath}: the recorded get_projects schema does not list \`limitations\` as ` +
        `required, so this transcript was captured against a server with a laxer contract ` +
        `than the one this repo now ships. Regenerate it.`,
    );
  }
});
