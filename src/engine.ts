/**
 * Shared engine for the four "ask about edgeorgie" tools. Both the MCP tool
 * handlers (create-server.ts) and the REST routes (api/ask.ts, api/story.ts,
 * api/experience.ts, api/projects.ts) call these so
 * there's exactly one implementation.
 *
 * get_experience  -> returns resume.txt's work-history section verbatim.
 * get_projects    -> returns the 6 shipped artifacts with their
 *                    metrics/URLs, every field traceable to each repo's
 *                    public commit/PR history and RELIABILITY-REPORT.md.
 *                    The project list and this count are mirrored in several
 *                    hand-maintained places (the tool description, README,
 *                    BUILD-LOG prose); tests/project-list.test.ts derives the
 *                    real set from doGetProjects() and asserts each mirror
 *                    against it, because the last addition left most of those
 *                    mirrors stale at once.
 * get_story       -> returns a hand-written chronological timeline of the
 *                    candidate's background as ordered beats. This is
 *                    editorial copy maintained in this file, NOT retrieval
 *                    over data/ — see doGetStory's own comment.
 * ask_about_edgeorgie -> TF-IDF retrieval over the full corpus (see
 *                    src/corpus.ts CORPUS_FILES for the authoritative list;
 *                    public evidence only),
 *                    same scoring/citation contract as repoask-mcp.
 *                    Every claim in the deterministic answer is a direct
 *                    excerpt from an indexed source file + line range —
 *                    nothing is generated beyond what's indexed unless an
 *                    LLM key is configured, in which case the model is
 *                    instructed to ground every sentence in the numbered
 *                    excerpts and cite them inline.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCorpusIndex } from "./corpus.js";
import { retrieveFromCorpus, type Citation } from "./retrieval.js";
import { synthesize, deterministicAnswer, hasLlmKey } from "./llm.js";
import { checkQuestionLength } from "./rate-limit.js";
import type { Chunk } from "@edgeorgie/retrieval-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readDataFile(name: string): Promise<string> {
  for (const dir of [path.join(__dirname, "data"), path.join(__dirname, "..", "data")]) {
    try {
      return await fs.readFile(path.join(dir, name), "utf8");
    } catch {
      // try next
    }
  }
  throw new Error(`Could not find data file ${name}`);
}

// ---------------------------------------------------------------------------
// get_experience
// ---------------------------------------------------------------------------

export interface ExperienceResult {
  source: string;
  summary: string;
  roles: { employer: string; title: string; dates: string; bullets: string[] }[];
}

/**
 * Parses resume.txt's WORK EXPERIENCE block exactly as written. No bullet is
 * reworded, trimmed, or embellished — this is a structural parse of the
 * verbatim resume text, not a rewrite.
 */
export async function doGetExperience(): Promise<ExperienceResult> {
  const text = await readDataFile("resume.txt");
  const lines = text.split("\n");

  const summaryLine = lines.find((l) => l.includes("Software Engineer focused on AI-enabled")) ?? "";

  const startIdx = lines.findIndex((l) => l.trim() === "WORK EXPERIENCE");
  const endIdx = lines.findIndex((l) => l.trim() === "LEADERSHIP EXPERIENCE");
  const block = lines.slice(startIdx + 1, endIdx === -1 ? undefined : endIdx);

  const roles: ExperienceResult["roles"] = [];
  let current: ExperienceResult["roles"][number] | null = null;
  for (const raw of block) {
    const line = raw.trim();
    if (!line) continue;
    // "Employer            Remote" header line (employer + location, no dates)
    if (/^[A-Z][\w .&-]+\s{2,}\S.*$/.test(line) && !/\d{4}/.test(line) && !/–|-/.test(line.split(/\s{2,}/)[1] ?? "")) {
      if (current) roles.push(current);
      const [employer] = line.split(/\s{2,}/);
      current = { employer: employer.trim(), title: "", dates: "", bullets: [] };
      continue;
    }
    // "Title          Month Year – Month Year" header line (has a date range)
    if (/\d{4}/.test(line) && current && current.title === "") {
      const parts = line.split(/\s{2,}/);
      current.title = parts[0].trim();
      current.dates = parts.slice(1).join(" ").trim();
      continue;
    }
    if (current) current.bullets.push(line);
  }
  if (current) roles.push(current);

  return {
    source: "resume.txt (verbatim parse, no rewording)",
    summary: summaryLine.trim(),
    roles,
  };
}

// ---------------------------------------------------------------------------
// get_projects
// ---------------------------------------------------------------------------

export interface ProjectResult {
  name: string;
  /**
   * Public repo URL. OPTIONAL and omitted when no public repo exists: a
   * private repo returns 404 unauthenticated, so emitting the URL anyway
   * hands every caller a dead link and claims inspectable code that is not.
   * When this is absent, `limitations` says why.
   */
  repo?: string;
  description: string;
  realMetrics: string[];
  evidence: string[];
  /**
   * Caveats a caller cannot infer from `realMetrics` and would otherwise have
   * to discover for themselves (not published, no adoption, a capability the
   * project deliberately does not have).
   *
   * REQUIRED, and each entry must be substantive — an optional field present
   * on one project implies the others have no caveats, and a placeholder
   * string satisfies a length check while saying nothing. `tsc` gates
   * presence, the zod output schema gates per-string length, and
   * `tests/server.test.ts` gates that each caveat reaches the rendered text
   * block under its OWN project's heading.
   */
  limitations: string[];
  source: string;
}

/**
 * Hardcoded to the 6 shipped artifacts. Every metric/URL below is a
 * direct, unmodified copy of facts already verified and logged in
 * progress.log / RELIABILITY-REPORT.md / this candidate's public repos —
 * nothing here is invented or estimated. The "source" field on each entry
 * tells a caller exactly where to independently check the claim.
 */
export async function doGetProjects(): Promise<ProjectResult[]> {
  return [
    {
      name: "triage-desk",
      repo: "https://github.com/edgeorgie/triage-desk",
      description:
        "GitHub-webhook-triggered autonomous triage bot (not a human-clicked UI demo). Fires on real `issues: [opened]` / `pull_request_target: [opened]` webhooks, posts a triage comment and applies kind/priority labels via Octokit using the workflow's GITHUB_TOKEN. Falls back to a deterministic heuristic classifier when no LLM key is configured (truthfully labeled in each run, not faked as an LLM call).",
      realMetrics: [
        "Webhook-triggered run (issue #26 opened -> bot commented + labeled) completed in 22s, conclusion: success",
        "Heuristic classifier accuracy: 83.3% (15/18) on both kind and priority, self-labeled ground truth, n=18 — see RELIABILITY-REPORT.md",
        "Duplicate detection: 1/2 (50%) — near-verbatim duplicate caught, paraphrased duplicate missed (Jaccard token-overlap limitation)",
        "22/22 local unit tests passing",
        "eval-lab-gated CI: 6/6 cases passed (cross-dogfooded, see eval-lab entry below)",
      ],
      evidence: [
        "PR #25 (webhook conversion): https://github.com/edgeorgie/triage-desk/pull/25",
        "PR #27 (eval-lab CI gate): https://github.com/edgeorgie/triage-desk/pull/27",
        "PR #28 (ACCURACY.md benchmark): https://github.com/edgeorgie/triage-desk/pull/28",
        "Real webhook run: https://github.com/edgeorgie/triage-desk/actions/runs/37983913473",
        "Real bot comment: https://github.com/edgeorgie/triage-desk/issues/26#issuecomment-6088283797",
      ],
      // Every caveat below was verified against the live GitHub and npm APIs
      // on 2026-10-11, not inferred from a log. Stated rather than omitted:
      // `limitations` is REQUIRED on every entry (gated by
      // tests/server.test.ts), because caveats on only some artifacts would
      // imply the others have none, which is true of none of them.
      limitations: [
        "0 GitHub stars, 0 forks, 0 watchers — nobody but the author has used it. The webhook runs and the accuracy benchmark are real, the adoption is zero.",
        "The 83.3% accuracy figure is self-labeled ground truth on n=18 issues written by the same person who wrote the classifier. Treat it as an internal consistency check, not a benchmark.",
        "The classifier that produced those numbers is the deterministic HEURISTIC path, not an LLM — no LLM key is configured in the deployed workflow, so the LLM branch has never run against real traffic.",
        "Not published to any registry (`https://registry.npmjs.org/triage-desk` → 404). It runs as a GitHub Actions workflow in its own repo; using it elsewhere means copying the workflow.",
      ],
      source: "progress.log 2026-10-09 entries (triage-desk sections); RELIABILITY-REPORT.md section 2",
    },
    {
      name: "eval-lab",
      repo: "https://github.com/edgeorgie/eval-lab",
      description:
        "Installable CLI + reusable GitHub Action for evaluating prompts/agents (variant runner, deterministic checks, LLM judge, regression diff vs. a baseline). Dogfooded in its own CI and in triage-desk's CI (eval-lab gates triage-desk's real heuristic-triage logic). Ships an offline `demo` model so it runs at $0 cost with zero API key.",
      realMetrics: [
        "Benchmark: 100% pass rate (24/24 cells), 3 runs, avg latency 20.21ms/cell, wall-clock ~255-259ms/run, $0 cost — see RELIABILITY-REPORT.md section 1",
        "7/7 local unit tests passing (node:test)",
        "PR CI run caught a real regression: baseline run reported 'all 2 cells passed'; regressed run reported '1 regression(s), 0 fix(es)' and exited 1",
      ],
      evidence: [
        "PR #21 (CLI + Action + dogfood): https://github.com/edgeorgie/eval-lab/pull/21",
        "PR #22 (exec-model bugfix: npx-symlink main-module guard never matched, silently exited 0): https://github.com/edgeorgie/eval-lab/pull/22",
        "PR #23 (BENCHMARKS.md): https://github.com/edgeorgie/eval-lab/pull/23",
        "Real CI run (regression caught, exit 1): https://github.com/edgeorgie/eval-lab/actions/runs/37983754854",
        "Post-merge run on main: https://github.com/edgeorgie/eval-lab/actions/runs/37983891269",
      ],
      limitations: [
        "0 GitHub stars, 0 forks, 0 watchers. The CI integration is real and cross-dogfooded into triage-desk, but no third party has adopted it.",
        "Not published to npm (`https://registry.npmjs.org/eval-lab` → 404, and the scoped `@edgeorgie/eval-lab` → 404 too). \"Installable CLI\" means installable from GitHub, not `npm i eval-lab`.",
        "The 100% / 24-of-24 benchmark runs entirely against the built-in offline `demo` model, which is deterministic by design. It measures that the harness, checks and regression diff work — it measures nothing about any real model's quality, and the $0 cost and ~20ms latency are properties of the stub, not of a live provider.",
        "The LLM-judge path exists but is not covered by the benchmark above, because running it needs a provider key that CI does not have.",
      ],
      source: "progress.log 2026-10-09 entries (eval-lab sections); RELIABILITY-REPORT.md section 1",
    },
    {
      name: "repoask-mcp",
      repo: "https://github.com/edgeorgie/repoask-mcp",
      description:
        "MCP server (official @modelcontextprotocol/sdk) that lets an agent index any public GitHub repo and ask it questions, getting back TF-IDF-retrieved citations with exact file+line ranges (optional LLM synthesis layered on top). Ships both stdio and Streamable HTTP transports from one shared tool factory, plus a human-usable web UI backed by the identical engine. Deployed live and publicly reachable with no auth wall.",
      realMetrics: [
        "3/3 automated tests passing against real network calls to GitHub (no mocks)",
        "Live public URL verified with a bare unauthenticated curl: GET / -> 200 health JSON, no SSO redirect",
        "Real external MCP SDK Client (StreamableHTTPClientTransport) over the open internet: list_tools, index_repo(octocat/git-consortium) -> fileCount=2, chunkCount=8; ask_repo -> 4 real citations",
        "Vercel deployment debugging: 3 real root causes found and fixed (builds-vs-rewrites build-target detection, routes-vs-rewrites routing-mode mismatch once builds was added, ssoProtection deploymentProtection PATCHed off via the Vercel API) — this debugging story is documented start-to-finish in BUILD-LOG.md and progress.log",
      ],
      evidence: [
        "Build commit (stdio + tools): https://github.com/edgeorgie/repoask-mcp/commit/9a866c5",
        "HTTP transport + Vercel wrapper commit: https://github.com/edgeorgie/repoask-mcp/commit/b23effc",
        "Public deployment fix commit: https://github.com/edgeorgie/repoask-mcp/commit/72b6e89",
        "Web UI commit: https://github.com/edgeorgie/repoask-mcp/commit/fb88c31 (PR #1)",
        "Live URL: https://repoask-mcp.vercel.app (health) / https://repoask-mcp.vercel.app/mcp (MCP endpoint)",
      ],
      limitations: [
        "0 GitHub stars, 0 forks, 0 watchers, not on npm (`https://registry.npmjs.org/repoask-mcp` → 404). Deployed and publicly callable is not the same as used by anyone.",
        "Retrieval is TF-IDF over chunked files — lexical, not semantic. A question that shares no vocabulary with the source returns weak or no citations, and there is no embedding model anywhere in the path.",
        "The deployed instance has no LLM key configured, so it answers in deterministic citation-only mode. The LLM synthesis layer is implemented but inert in production.",
        "The 3/3 test figure is three tests. It covers the real network path to GitHub with no mocks, which is the valuable part, but it is a smoke suite rather than broad coverage.",
        "No auth and no per-caller quota beyond a rate limit — anyone can make it index public repos on the author's deployment.",
      ],
      source:
        "progress.log 2026-10-09 entries ('Artifact C shipped', 'Streamable HTTP transport SHIPPED', 'PUBLIC VERCEL DEPLOYMENT FIXED AND VERIFIED', 'GETS A REAL HUMAN-USABLE WEB UI'); BUILD-LOG.md 'The MCP server's deployment wall' section",
    },
    {
      name: "crispy-profiling",
      repo: "https://github.com/edgeorgie/crispy-profiling",
      description:
        "React re-render profiler shipped as four surfaces off one engine: CLI, GitHub Action, MCP server, and an Agent Skill (skills/react-render-profiling/SKILL.md) so Claude Code, Cursor, Codex and similar tools can measure a re-render fix instead of guessing at one. Opens the target app in headless Chromium, drives described interactions, and reports which components re-rendered, how many times, why (props/state/context/parent), and which renders were avoidable. Published to npm.",
      realMetrics: [
        "Published and installable: `npm i -D crispy-profiling` (https://www.npmjs.com/package/crispy-profiling)",
        "Validated against 5 real open-source apps (Redux Essentials, Next.js App Router Playground, Excalidraw, shadcn-admin, react-admin) — found a fixable re-render problem in each",
        "OpenSSF Scorecard badge live on the repo; CI badge live and green",
        "Tested on React 19, validated on 18.3 and 19.0 apps",
      ],
      evidence: [
        "npm package: https://www.npmjs.com/package/crispy-profiling",
        "Repo: https://github.com/edgeorgie/crispy-profiling",
        "Agent Skill: https://github.com/edgeorgie/crispy-profiling/blob/develop/skills/react-render-profiling/SKILL.md",
        "CI status: https://github.com/edgeorgie/crispy-profiling/actions/workflows/ci.yml",
      ],
      limitations: [
        "0 GitHub stars, 0 forks, 0 watchers. It is published and installable, which is a real bar most of these do not clear, but published is not adopted.",
        "The download count is a lifetime total, not a rate: every npm download window wide enough to contain the first publish (2026-10-05) returns the same running total, so a last-week and a last-month figure read identically until the window rolls past that date. The figure is 1378 as of 2026-10-15, and it is dated because it moves — an earlier snapshot of 754 was still being served here days after npm had passed it. Every nonzero day lines up with the author's own publishes: 523 on Oct 5 (0.1.0, 0.2.0) and 512 on Oct 10 (0.4.0, 0.5.0 and 0.6.0 inside three hours), which is the shape of registry mirrors and CI refetching a new version, not users.",
        "The \"found a fixable re-render problem in each of 5 apps\" result was produced and judged by the author. No maintainer of those apps reviewed or accepted a fix.",
        "0 open issues on the repo as of 2026-10-11, and the two that were open (both unresolved product work) have since been closed.",
      ],
      source: "Live GitHub repo README + npm registry listing, read directly (not from a secondary log) on 2026-10-10.",
    },
    {
      name: "simplescope",
      // No `repo` field: the GitHub repo is private and returns 404 to any
      // unauthenticated reader. `evidence` already refused to list it for
      // exactly this reason; emitting it here contradicted that decision and
      // handed agents a dead link. `limitations` states the repo is private.
      description:
        "Interactive, visual, gamified platform for learning algorithms by watching real JavaScript run — not static diagrams. Built with Next.js (App Router) + TypeScript, Tailwind v4, shadcn/ui, MDX lessons; optional account/progress-sync via Better Auth + Drizzle on Neon Postgres, with the site fully functional with zero environment variables (progress falls back to browser localStorage) when accounts aren't configured.",
      realMetrics: [
        "Deployed live and publicly reachable: https://simplescope-one.vercel.app",
        "Works with zero required env vars — graceful degradation design (accounts hide automatically, localStorage progress still works) verified from the repo's own README, not assumed",
      ],
      evidence: [
        "Live site: https://simplescope-one.vercel.app",
        // Deliberately NOT a repo URL. `evidence[]` is the list of links a
        // reviewer clicks, and this repo is private: the URL returns 404
        // unauthenticated, so listing it offered a dead link as proof.
        "No repo link: the GitHub repo is private and returns 404 to any reader, so the code is not independently inspectable. The deployed site is the only verifiable evidence for this artifact.",
      ],
      limitations: [
        "It carries NO LICENCE FILE — the GitHub API reports `NOASSERTION`, the only one of these six artifacts that is not MIT. Legally that means default copyright: nobody may reuse, modify or redistribute it, including a reviewer who only wants to clone and run it. This is stated rather than silently fixed because choosing a licence is a commitment on the author's own work, not an automated edit.",
        "Its GitHub repo is PRIVATE, so none of its repo-state numbers can be verified by a reader: the API returns 404 unauthenticated, and the linked repo URL will not open for anyone but the author. Stated from the authenticated view on 2026-10-11: 0 stars, 0 forks, 0 watchers, 12 open issues — several of them unfinished product work (a Lighthouse audit, an SEO audit, per-page content gaps, a trademark/domain question), not stale noise. Unlike every other artifact here, those figures are maintained by hand and are not covered by this repo's automated freshness check, precisely because a private repo cannot be checked without a credential. The deployed site is public and returns 200.",
        "It is the only artifact here with no automated-test or accuracy metric of any kind. Its evidence is that it is deployed and that the zero-env-var degradation works; there is no measured number behind it.",
        "Not on npm and not intended to be — it is a deployed web app. Nothing here is installable or agent-callable; it is the one artifact aimed only at humans.",
      ],
      source: "Live GitHub repo README, read directly on 2026-10-10.",
    },
    {
      name: "agentlens",
      repo: "https://github.com/edgeorgie/agentlens",
      description:
        "Zero-dependency tracing + waterfall visualizer for AI agent tool calls: latency, tokens, cost, nesting, errors. Built to answer 'which step of this agent run was slow, and which one threw' — `node:async_hooks` AsyncLocalStorage propagates parent/child span context without threading a context object through every signature, so concurrent sibling spans cannot leak into each other's parent. `renderHtml` emits a self-contained waterfall with no external references.",
      realMetrics: [
        "Zero runtime dependencies — only two Node builtins (`node:async_hooks`, `node:crypto`), Node 18+",
        "5/5 tests passing on a fresh clone (tests 5 / pass 5 / fail 0)",
        "6/6 GitHub Actions CI runs `success`",
        "Viewer deployed live and publicly reachable: https://agentlens-nine.vercel.app/ returns 200",
      ],
      evidence: [
        "Repo: https://github.com/edgeorgie/agentlens",
        "Live viewer: https://agentlens-nine.vercel.app/",
        "CI runs: https://github.com/edgeorgie/agentlens/actions",
      ],
      // Stated as limitations rather than omitted: an agent reading this tool
      // gets the same caveats a human reading the README would, and neither
      // can be inferred from the metrics above.
      limitations: [
        "Does NOT call any LLM API and knows no provider's pricing — `tokensIn`/`tokensOut`/`costUsd`/`model` are optional fields the caller sets via `setAttrs()`, and agentlens only sums what it is told. The demo's token numbers are stubbed and labeled as demo values so the demo costs nothing and needs no API key.",
        "NOT published on the npm registry, for two independent reasons: no npm credentials in the build environment (`npm whoami` -> ENEEDAUTH), and the name `agentlens` is already taken on npm by an unrelated package, so publishing would require renaming (e.g. `@edgeorgie/agentlens`). Installing from GitHub works today: `npm install github:edgeorgie/agentlens`.",
        "Version 0.1.0, 0 stars, no known users — a tool built for the author's own use that has not been adopted by anyone.",
      ],
      source:
        "Live GitHub repo (package.json, test run, Actions history) and a live HTTP check of the viewer, all read directly on 2026-10-11 — not from a secondary log.",
    },
  ];
}

// ---------------------------------------------------------------------------
// get_story
// ---------------------------------------------------------------------------

export interface StoryBeat {
  year: string;
  label: string;
  body: string;
}

export interface StoryResult {
  intro: string;
  beats: StoryBeat[];
  source: string;
}

/**
 * Same chronological narrative as the portfolio's "Beyond the code" timeline
 * (edgeorgie-portfolio src/data/content.ts `beyond`) — kept in sync by hand
 * since this repo has no shared package with the portfolio. Returned as
 * structured beats (year/label/body), not one prose paragraph, so an agent
 * or UI can render it as an actual timeline instead of a wall of text.
 *
 * PROVENANCE, stated precisely because this repo's whole contract is that a
 * `source` field names text you can go and read: these beats are the
 * candidate's own editorial copy, authored for the portfolio timeline and
 * maintained here by hand. They are NOT retrieved from data/ at runtime. The
 * facts behind them (the 2D platformer at 15, the dual degrees, Kotlin/Swift
 * on the job, Unreal Engine, guitar, the 4x/week morning gym routine) also
 * appear in RECRUITER-FAQ.md, and some phrasing genuinely overlaps with it —
 * the longest shared runs measured 51, 45 and 39 characters — so this is
 * NOT a clean paraphrase either. `source` therefore describes the copy's
 * origin rather than citing a file+line range, because no single range backs
 * the whole beat. Use doAskAboutEdgeorgie when a caller needs a citation.
 *
 * Deliberate design note: if anyone later makes this data file-driven (read
 * the beats out of data/), that creates an UNSPOTLIGHTED path from file
 * content into whatever renders it — doGetStory bypasses src/llm.ts's
 * sanitizeRetrievedText / <retrieved_context> wrapping entirely, which is
 * only safe today because this is a compile-time constant with no
 * caller-controlled input. Route any file-driven version through the
 * corpus/retrieval path instead.
 */
export async function doGetStory(): Promise<StoryResult> {
  return {
    intro:
      "The same habit, from age 15 to now: build it yourself to understand it, whatever 'it' is.",
    beats: [
      {
        year: "Age 15",
        label: "Shipped my first game, solo",
        body: "Built and released a 2D platformer entirely on my own — no team, no course. It got about 50 downloads. First time I remember building something just to see if I could, and then actually finishing it.",
      },
      {
        year: "Degree",
        label: "Electronic Engineering, then Software",
        body: "Dual degrees — Electronic Engineering and Software Development. The electronics background is part of why a new stack doesn't feel intimidating: I'm used to learning a discipline from its fundamentals up.",
      },
      {
        year: "On the job",
        label: "Kotlin and Swift, learned by shipping",
        body: "JavaScript/TypeScript is the core expertise, but at Mercado Libre I picked up Kotlin (Android) and Swift (iOS) for AI-assisted native work — learned both while shipping, not before. Same pattern as the platformer: figure it out by building the real thing.",
      },
      {
        year: "Always",
        label: "Design isn't handed to me, I own it",
        body: "UX and interaction design on these projects — this portfolio and MCP included — are my own decisions, not a template someone else made. I care how something feels to use, not only whether the API underneath is correct.",
      },
      {
        year: "Right now",
        label: "Self-teaching Unreal Engine (5.8.3)",
        body: "Still building games, not just playing them — I'm currently self-teaching game development and design in Unreal Engine. Same self-directed approach as the platformer at 15, just a bigger engine.",
      },
      {
        year: "Right now",
        label: "Guitar, and the gym at sunrise",
        body: "Learning to play guitar. At the gym 4 mornings a week — I'm a morning person, I prefer getting moving early over pushing it to the end of the day.",
      },
    ],
    source:
      "Candidate's own timeline copy, hand-maintained in src/engine.ts and mirrored from edgeorgie-portfolio's 'Beyond the code' section. Paraphrase, not a quote: the same facts are covered in data/RECRUITER-FAQ.md ('What do you do outside of work?', 'core technical stack'), and some phrases overlap it verbatim, but this is editorial copy rather than an indexed excerpt — call ask_about_edgeorgie for file+line citations.",
  };
}

// ---------------------------------------------------------------------------
// ask_about_edgeorgie
// ---------------------------------------------------------------------------

export interface AskResult {
  question: string;
  answer: string;
  /**
   * "llm"              -> a provider key was set and synthesis succeeded.
   * "deterministic"    -> no provider key is configured; citation dump only.
   * "synthesis-failed" -> a provider key IS configured but the call failed
   *                       (e.g. Anthropic 400 for an org-scoped key missing
   *                       ANTHROPIC_WORKSPACE_ID). Previously this case also
   *                       reported "deterministic", so the badge and the
   *                       answer body both blamed a missing key that was in
   *                       fact present. These are now distinguishable.
   */
  answerMode: "llm" | "deterministic" | "synthesis-failed";
  /** Whether any provider key is present, independent of whether the call worked. */
  llmKeyConfigured: boolean;
  model?: string;
  citations: Citation[];
}

export async function doAskAboutEdgeorgie(question: string, topK?: number): Promise<AskResult> {
  // Enforced here, not in the HTTP route, so every transport that can reach
  // the billable synthesis path is covered by one check: REST /api/ask, the
  // Streamable HTTP /mcp function, and the stdio server. A per-route check
  // would have to be remembered four times.
  const lengthCheck = checkQuestionLength(question);
  if (!lengthCheck.ok) {
    throw new Error(lengthCheck.error);
  }

  const index = await buildCorpusIndex();
  const citations = retrieveFromCorpus(index, question, topK ?? 6);
  const chunksForPrompt: Chunk[] = citations.map((c) => ({
    path: c.source,
    start: c.startLine,
    end: c.endLine,
    text: c.excerpt,
  }));

  const llmKeyConfigured = hasLlmKey();
  let answer: string;
  let answerMode: "llm" | "deterministic" | "synthesis-failed";
  let model: string | undefined;
  try {
    const synth = await synthesize(question, "Edwin Jorge (edgeorgie) — candidate corpus", chunksForPrompt);
    if (synth) {
      answer = synth.answer;
      answerMode = "llm";
      model = synth.model;
    } else {
      // synthesize() returns null only when no provider key is set.
      answer = deterministicAnswer(chunksForPrompt, "no-key");
      answerMode = "deterministic";
    }
  } catch (err) {
    // A key was present (synthesize threw rather than returning null), so the
    // failure cause is the provider/config, never a missing key.
    answer = `LLM synthesis failed (${(err as Error).message}); falling back to citations.\n\n${deterministicAnswer(chunksForPrompt, "synthesis-failed")}`;
    answerMode = "synthesis-failed";
  }

  return { question, answer, answerMode, llmKeyConfigured, model, citations };
}
