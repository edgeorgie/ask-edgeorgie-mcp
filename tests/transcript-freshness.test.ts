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

/**
 * WHY THIS ASSERTS EQUALITY AND NOT A SHAPE.
 *
 * The first version of this test checked only that each entry's `limitations`
 * was a non-empty array of strings clearing the schema's 40-char floor. Both
 * of these attacks were measured passing it 53/53:
 *
 *   1. FILLER. Replace all six projects' caveats with one reused 47-char
 *      sentence ("This project has some caveats worth noting here."). Every
 *      entry clears the floor and the transcript records nothing true.
 *   2. CROSS-WIRING. Shift each project's real caveats to the NEXT project.
 *      Every entry is long, specific, genuine prose — attributed to the wrong
 *      artifact. The transcript then shows the server telling a caller that
 *      simplescope's missing-licence warning belongs to crispy-profiling.
 *
 * Attack 2 is the worse one, and it is the reason a shape check cannot be the
 * guard: it produces a transcript that is WRONG rather than SILENT, which is
 * strictly more damaging for a provenance tool than an absent caveat. Length
 * measures volume; neither attack is a volume problem.
 *
 * `limitations` is, unlike a project description, a verbatim array copied out
 * of `doGetProjects()` into the structured output — so the honest check is
 * equality against the real engine, per project, in order. That is a stricter
 * contract than the rest of this file applies, and deliberately so: it is the
 * one field whose drift was the actual defect, and the one a reader is most
 * likely to trust as the repo's own disclosure of what its artifacts cannot do.
 *
 * The accepted cost: editing a caveat in `src/engine.ts` now requires
 * regenerating the transcripts (commands in this file's header). That is the
 * intended consequence, not an inconvenience to design around — a recording of
 * output that no longer matches the output is the thing being prevented.
 */
test("every project's recorded limitations are verbatim what the engine returns", async () => {
  const live = new Map((await doGetProjects()).map((p) => [p.name, p.limitations]));
  assert.ok(live.size > 0, "doGetProjects() returned nothing — this guard would be vacuous");

  // The engine is the authority, so its own entries must clear the schema floor
  // before transcripts are judged against them. Without this, filler shipped in
  // the ENGINE would become the expected value and both attacks would simply
  // move one layer down.
  for (const [name, limitations] of live) {
    assert.ok(
      Array.isArray(limitations) && limitations.length > 0,
      `src/engine.ts → ${name}: no non-empty \`limitations\`. The schema requires one on ` +
        `every entry precisely so an absent caveat never reads as "this one has none".`,
    );
    for (const limitation of limitations) {
      assert.ok(
        typeof limitation === "string" && limitation.trim().length >= MIN_LIMITATION_CHARS,
        `src/engine.ts → ${name}: limitation ${JSON.stringify(limitation)} is under ` +
          `${MIN_LIMITATION_CHARS} chars of real text.`,
      );
    }
  }

  for (const relPath of TRANSCRIPTS) {
    for (const project of projectsOf(await readTranscript(relPath), relPath)) {
      const where = `${relPath} → ${project.name ?? "<unnamed>"}`;
      const expected = live.get(project.name as string);
      assert.ok(
        expected,
        `${where}: recorded a project the engine does not return (covered in detail by the ` +
          `set-equality test above)`,
      );

      // deepEqual, in order, so reused filler and caveats attributed to the
      // wrong artifact both fail — neither is detectable by shape or length.
      assert.deepEqual(
        project.limitations,
        expected,
        `${where}: the recorded \`limitations\` are not what the engine returns for this ` +
          `project. Either the engine's caveats changed and the transcript was not ` +
          `regenerated, or the transcript's caveats are filler/attributed to the wrong ` +
          `artifact. Regenerate it (see this file's header) — do not hand-edit it to match.`,
      );
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
