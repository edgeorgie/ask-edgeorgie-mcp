/**
 * Shared engine for the three "ask about edgeorgie" tools. Both the MCP tool
 * handlers (create-server.ts) and the REST route (api/ask.ts) call these so
 * there's exactly one implementation.
 *
 * get_experience  -> returns resume.txt's work-history section verbatim.
 * get_projects    -> returns the 3 real shipped artifacts with their real
 *                    metrics/URLs, every field traceable to each repo's
 *                    public commit/PR history and RELIABILITY-REPORT.md.
 * ask_about_edgeorgie -> TF-IDF retrieval over the full corpus (resume.txt +
 *                    RELIABILITY-REPORT.md + BUILD-LOG.md, public evidence
 *                    only), same scoring/citation contract as repoask-mcp.
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
import { synthesize, deterministicAnswer } from "./llm.js";
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
  repo: string;
  description: string;
  realMetrics: string[];
  evidence: string[];
  source: string;
}

/**
 * Hardcoded to the 3 real shipped artifacts. Every metric/URL below is a
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
      source: "Live GitHub repo README + npm registry listing, read directly (not from a secondary log) on 2026-10-10.",
    },
    {
      name: "simplescope",
      repo: "https://github.com/edgeorgie/simplescope",
      description:
        "Interactive, visual, gamified platform for learning algorithms by watching real JavaScript run — not static diagrams. Built with Next.js (App Router) + TypeScript, Tailwind v4, shadcn/ui, MDX lessons; optional account/progress-sync via Better Auth + Drizzle on Neon Postgres, with the site fully functional with zero environment variables (progress falls back to browser localStorage) when accounts aren't configured.",
      realMetrics: [
        "Deployed live and publicly reachable: https://simplescope-one.vercel.app",
        "Works with zero required env vars — graceful degradation design (accounts hide automatically, localStorage progress still works) verified from the repo's own README, not assumed",
      ],
      evidence: [
        "Live site: https://simplescope-one.vercel.app",
        "Repo: https://github.com/edgeorgie/simplescope",
      ],
      source: "Live GitHub repo README, read directly on 2026-10-10.",
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
 * Every beat is a real, candidate-stated fact — see RECRUITER-FAQ.md's
 * "What do you do outside of work?" and "core technical stack" entries for
 * the first-person source.
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
        body: "Dual degrees — Electronic Engineering and Software Development. The electronics background is part of why a new stack doesn't feel intimidating: used to learning a discipline from its fundamentals up.",
      },
      {
        year: "On the job",
        label: "Kotlin and Swift, learned by shipping",
        body: "JavaScript/TypeScript is the core expertise, but at Mercado Libre I picked up Kotlin (Android) and Swift (iOS) for AI-assisted native work — learned both while shipping, not before. Same pattern as the platformer: figure it out by building the real thing.",
      },
      {
        year: "Always",
        label: "Design isn't handed to me, I own it",
        body: "UX and interaction design on these projects — this portfolio and MCP included — are my own decisions, not a template someone else made. Caring how something feels to use, not only whether the API underneath is correct.",
      },
      {
        year: "Right now",
        label: "Self-teaching Unreal Engine (5.8.3)",
        body: "Still building games, not just playing them — currently self-teaching game development and design in Unreal Engine. Same self-directed approach as the platformer at 15, just a bigger engine.",
      },
      {
        year: "Right now",
        label: "Guitar, and the gym at sunrise",
        body: "Learning to play guitar. At the gym 4 mornings a week — a morning person, prefers getting moving early over pushing it to the end of the day.",
      },
    ],
    source: "RECRUITER-FAQ.md 'What do you do outside of work?' / 'core technical stack' entries; mirrors edgeorgie-portfolio's 'Beyond the code' timeline.",
  };
}

// ---------------------------------------------------------------------------
// ask_about_edgeorgie
// ---------------------------------------------------------------------------

export interface AskResult {
  question: string;
  answer: string;
  answerMode: "llm" | "deterministic";
  model?: string;
  citations: Citation[];
}

export async function doAskAboutEdgeorgie(question: string, topK?: number): Promise<AskResult> {
  const index = await buildCorpusIndex();
  const citations = retrieveFromCorpus(index, question, topK ?? 6);
  const chunksForPrompt: Chunk[] = citations.map((c) => ({
    path: c.source,
    start: c.startLine,
    end: c.endLine,
    text: c.excerpt,
  }));

  let answer: string;
  let answerMode: "llm" | "deterministic";
  let model: string | undefined;
  try {
    const synth = await synthesize(question, "Edwin Jorge (edgeorgie) — candidate corpus", chunksForPrompt);
    if (synth) {
      answer = synth.answer;
      answerMode = "llm";
      model = synth.model;
    } else {
      answer = deterministicAnswer(chunksForPrompt);
      answerMode = "deterministic";
    }
  } catch (err) {
    answer = `LLM synthesis failed (${(err as Error).message}); falling back to citations.\n\n${deterministicAnswer(chunksForPrompt)}`;
    answerMode = "deterministic";
  }

  return { question, answer, answerMode, model, citations };
}
