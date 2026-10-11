/**
 * The committed agent transcripts are a MIRROR of what the server returns, and
 * nothing in this repo regenerates them. That makes them the same drift class
 * already killed twice here (the /health `tools: [...]` array, the
 * CORPUS_FILES prose mirrors) — except worse, because a transcript is the
 * repo's own recorded EVIDENCE. A reviewer who opens examples/ sees what the
 * product used to do and takes it for what it does.
 *
 * It HAD drifted when this guard was written, in exactly the direction that
 * matters, and the state below is historical — the transcripts were
 * regenerated in the same commit, so none of it describes the files today.
 * PR #26 made `limitations` required on every project entry (the point being
 * that an absent caveat must never read as "this one has none") and PR #27
 * tightened the tool schema (`minItems`, `minLength: 40`, `limitations` in
 * `required`). Both transcripts were left at the pre-#26 shape:
 * examples/http-transcript.json carried `limitations` on 1 of 6 projects and
 * advertised the old, laxer schema. So the repo shipped a guard asserting
 * caveats are mandatory, alongside committed proof that they are not.
 *
 * WHAT THIS GUARD ASSERTS, AND WHY IT IS SHAPED THIS WAY.
 *
 * It does NOT compare project descriptions to a fresh server response. That
 * would fail on every legitimate prose edit to a description, which is both
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
import { renderProjectsText } from "../src/create-server.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Mirrors the live schema's `minLength` on a limitations entry. */
const MIN_LIMITATION_CHARS = 40;

const STDIO_TRANSCRIPT = "examples/transcript.json";
const HTTP_TRANSCRIPT = "examples/http-transcript.json";
const TRANSCRIPTS = [STDIO_TRANSCRIPT, HTTP_TRANSCRIPT] as const;

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
 *
 * WHAT THIS DOES NOT COVER, stated because an earlier version of this comment
 * overstated it. The engine-side floor check below bounds the ENGINE's own
 * caveats, and a critic measured the limit of that precisely: mutating the
 * engine AND regenerating the transcripts to match leaves everything green, as
 * it must — at that point the transcripts are faithful recordings of what the
 * server really says, and no transcript guard can be the thing that decides
 * whether the server is telling the truth. The floor catches degenerate engine
 * content (under 40 chars); it does not catch plausible-length filler written
 * upstream. Reviewing `src/engine.ts` is what covers that, and claiming
 * otherwise here would be the same overstatement this file exists to stop.
 *
 * WHY THE TWO TRANSCRIPTS ARE HELD TO DIFFERENT STANDARDS.
 *
 * The first version of this guard compared BOTH transcripts to the local
 * engine, and that was a latent deadlock rather than a strictness win. The
 * stdio transcript is produced by the code in the working tree, so local
 * equality is exactly right. The HTTP transcript is produced by the DEPLOYED
 * server — which, by construction, cannot know about an engine change until
 * that change is deployed, and a change is only deployed after it merges,
 * which requires this suite to be green. Any edit to engine data therefore
 * made CI unpassable: regenerating against production re-records the OLD
 * values, and hand-editing the file to the new ones is precisely the
 * falsification this guard exists to prevent.
 *
 * It fired for real on a one-word metric correction, with the only green paths
 * being "fake the evidence" or "revert the fix". A guard whose cheapest escape
 * is forging the recording is worse than no guard.
 *
 * So the HTTP transcript is held to what a recording of a remote server can
 * honestly prove: INTERNAL CONSISTENCY between its own two representations,
 * derived through the production renderer. That still catches every mutation
 * measured against the prose half (fabricated `Adoption:` section, inflated
 * accuracy, invented stars, cross-wired caveats), because each edits the text
 * a client displays while leaving the structured half it was rendered from
 * untouched.
 *
 * Honestly stated limit: a falsification applied CONSISTENTLY to both halves
 * of the HTTP recording passes until production catches up, at which point the
 * next regeneration overwrites it. The manual step that closes the window is
 * re-running the HTTP harness after the deploy lands
 * (`node --import tsx examples/run-session.ts <url>/mcp examples/http-transcript.json`),
 * which is the same command the header already documents.
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

  // The stdio transcript is produced by the working tree's own code, so exact
  // equality against the engine is both correct and achievable. The HTTP
  // transcript records the deployed server and is reconciled against its own
  // structured half below — see this test's header for why.
  for (const project of projectsOf(await readTranscript(STDIO_TRANSCRIPT), STDIO_TRANSCRIPT)) {
    const where = `${STDIO_TRANSCRIPT} → ${project.name ?? "<unnamed>"}`;
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

  // The HTTP recording still has to clear the contract floor on its OWN
  // entries, so a deployed server returning degenerate or absent caveats is
  // caught even while its content legitimately lags the working tree.
  for (const project of projectsOf(await readTranscript(HTTP_TRANSCRIPT), HTTP_TRANSCRIPT)) {
    const where = `${HTTP_TRANSCRIPT} → ${project.name ?? "<unnamed>"}`;
    assert.ok(
      Array.isArray(project.limitations) && project.limitations.length > 0,
      `${where}: no non-empty \`limitations\` in the recorded response.`,
    );
    for (const limitation of project.limitations as unknown[]) {
      assert.ok(
        typeof limitation === "string" && limitation.trim().length >= MIN_LIMITATION_CHARS,
        `${where}: recorded limitation ${JSON.stringify(limitation)} is under ` +
          `${MIN_LIMITATION_CHARS} chars of real text — filler, not a caveat.`,
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

/**
 * THE HUMAN-READABLE HALF, which was entirely unguarded until a critic walked
 * through it.
 *
 * Every assertion above reads `get_projects.structuredContent`. But the tool
 * returns TWO representations of the same data, and `content[0].text` is the
 * one most MCP clients actually display — so it is the one a human reviewer
 * opening `examples/` reads. Twelve mutations to the text block alone were
 * measured passing at 53/53, including:
 *
 *   - `83.3% (15/18)` rewritten to `99.8% (1247/1250)`
 *   - `0 GitHub stars` rewritten to `1,400 stars`
 *   - a fabricated `Adoption:` section added
 *   - the same cross-wiring attack this file already defends against in
 *     `structuredContent`, applied one surface over
 *
 * That is the worse half to leave open: a falsified metric in prose needs no
 * schema knowledge to read and no tooling to believe.
 *
 * The fix is derivation, not a second parser. `renderProjectsText()` is
 * exported from `src/create-server.ts` — the exact function the tool handler
 * calls — so the expected text is produced by the production code path rather
 * than by a reimplementation here that could itself drift from it. Comparing
 * against a hand-written template in this file would re-create the mirror
 * problem one level up.
 */
test("the recorded text block is what the server's own renderer produces", async () => {
  const expected = renderProjectsText(await doGetProjects());
  assert.ok(
    expected.trim().length > 0,
    "renderProjectsText() produced nothing — this guard would be vacuous",
  );

  /** Pulls the single text block out of a recording, failing loudly if the shape changed. */
  async function textBlockOf(relPath: string): Promise<string> {
    const transcript = await readTranscript(relPath);
    const content = transcript?.get_projects?.content;
    assert.ok(
      Array.isArray(content) && content.length > 0,
      `${relPath}: no get_projects.content array — the human-readable half of the ` +
        `recording is missing entirely. Regenerate the transcript.`,
    );

    const textBlocks = (content as { type?: string; text?: string }[]).filter(
      (c) => c.type === "text" && typeof c.text === "string",
    );
    assert.equal(
      textBlocks.length,
      1,
      `${relPath}: expected exactly 1 text block in get_projects.content, found ` +
        `${textBlocks.length}. More than one would mean half the prose escapes the ` +
        `comparison below.`,
    );
    return textBlocks[0].text as string;
  }

  // The stdio recording came from this working tree, so it must match the
  // renderer exactly.
  assert.equal(
    await textBlockOf(STDIO_TRANSCRIPT),
    expected,
    `${STDIO_TRANSCRIPT}: the recorded get_projects text block is not what ` +
      `renderProjectsText() produces from the current engine data. Either the engine ` +
      `changed and the transcript was not regenerated, or the recorded prose was edited ` +
      `— an inflated metric, a fabricated section, or caveats attributed to the wrong ` +
      `project all land here. Regenerate it (see this file's header); do not hand-edit ` +
      `it to match.`,
  );

  // The HTTP recording legitimately lags the working tree until a deploy lands,
  // so it is reconciled against ITS OWN structured half, rendered through the
  // same production function. This is the assertion that catches a tampered
  // prose block: the displayed text must be exactly what the recorded
  // structured data renders to, whatever that data happens to be.
  const httpTranscript = await readTranscript(HTTP_TRANSCRIPT);
  const recordedProjects = httpTranscript?.get_projects?.structuredContent?.projects;
  assert.ok(
    Array.isArray(recordedProjects) && recordedProjects.length > 0,
    `${HTTP_TRANSCRIPT}: no structured projects to reconcile the text block against.`,
  );
  assert.equal(
    await textBlockOf(HTTP_TRANSCRIPT),
    renderProjectsText(recordedProjects),
    `${HTTP_TRANSCRIPT}: the recorded text block is not what renderProjectsText() ` +
      `produces from the structured half of the SAME recording. The two representations ` +
      `of one response disagree, which means the prose was edited after capture — ` +
      `exactly the falsification a reviewer reading examples/ would believe. Regenerate ` +
      `it against the deployed server; do not hand-edit it.`,
  );
});

/**
 * Transcript PROVENANCE. The header of each file states which server produced
 * it and when, and both fields were editable with the suite green — so a
 * transcript claiming to be a capture of the live public deployment could
 * actually be a local stdio run, which is the difference between "an agent
 * reached this over the internet" and "it ran on my laptop". That distinction
 * is the entire evidentiary value of the HTTP transcript.
 *
 * Asserted narrowly and honestly: this checks the two files do not claim the
 * SAME origin, and that each claims the right KIND of origin. It cannot verify
 * a capture really happened at the stated time — nothing short of a signed
 * attestation could — and `ranAt` is deliberately not range-checked, because a
 * date assertion would start failing on a correct transcript the moment it
 * ages, which trains people to delete guards.
 */
test("each transcript records the kind of origin it claims", async () => {
  const origins = new Map<string, string>();

  for (const relPath of TRANSCRIPTS) {
    const transcript = await readTranscript(relPath);
    const serverUrl = transcript?.serverUrl;
    assert.equal(
      typeof serverUrl,
      "string",
      `${relPath}: no \`serverUrl\` — the recording does not say what produced it.`,
    );
    assert.match(
      transcript?.ranAt ?? "",
      /^\d{4}-\d{2}-\d{2}T/,
      `${relPath}: \`ranAt\` is not an ISO timestamp.`,
    );
    origins.set(relPath, serverUrl as string);
  }

  const stdio = origins.get("examples/transcript.json")!;
  const http = origins.get("examples/http-transcript.json")!;

  assert.match(
    stdio,
    /^stdio:/,
    `examples/transcript.json claims origin "${stdio}", but this file is the stdio ` +
      `capture. Regenerate it with the stdio harness.`,
  );
  assert.match(
    http,
    /^https:\/\/.+\/mcp$/,
    `examples/http-transcript.json claims origin "${http}", but this file's evidentiary ` +
      `value is that a real MCP client reached the deployed server over the internet. A ` +
      `local or non-HTTPS origin here silently downgrades that claim.`,
  );
  assert.notEqual(
    stdio,
    http,
    "both transcripts claim the same origin, so one of them is mislabeled and the two " +
      "files are not the two independent transports they are presented as.",
  );
});
