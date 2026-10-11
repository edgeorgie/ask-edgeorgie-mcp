/**
 * Shared MCP server factory: builds a fresh McpServer with the four
 * "ask about edgeorgie" tools registered (get_experience, get_projects,
 * get_story, ask_about_edgeorgie). Both transports (stdio in server.ts, Streamable HTTP
 * in http-server.ts / api/mcp.ts) call this so tool definitions live in
 * exactly one place. Implementations live in src/engine.ts, shared with the
 * human-facing REST routes (api/experience.ts, api/projects.ts, api/story.ts, api/ask.ts)
 * so the MCP tools and the web UI are provably the same engine.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  doGetExperience,
  doGetProjects,
  doAskAboutEdgeorgie,
  doGetStory,
  type ProjectResult,
} from "./engine.js";
import { capture, questionAskedProperties } from "./analytics.js";

/**
 * Renders the `get_projects` text block from the engine's own project data.
 *
 * Exported, and deliberately a pure function of its argument, for one reason:
 * the committed transcripts in `examples/` are guarded by
 * `tests/transcript-freshness.test.ts`, which previously could only check the
 * `structuredContent` half. A critic defeated that by rewriting the TEXT
 * block alone — inflating a measured accuracy figure, adding a fabricated
 * adoption section, and attributing one project's caveats to another — with
 * the suite green, because the text was built inline here and nothing else
 * could reproduce it. With the rendering extracted, the guard derives the
 * expected text by calling this exact function, so the human-readable half of
 * the transcripts is now covered by construction rather than by a parallel
 * reimplementation that could itself drift.
 *
 * Limitations are rendered into the text block, not only into
 * `structuredContent`: a client that displays text content (most chat-style
 * MCP clients do) would otherwise show the metrics and silently drop the
 * caveats attached to them, which is the one direction this tool must never
 * fail in.
 */
export function renderProjectsText(projects: ProjectResult[]): string {
  return projects
    .map((p) => {
      const caveats = p.limitations?.length
        ? `\n\nLimitations:\n${p.limitations.map((l) => `- ${l}`).join("\n")}`
        : "";
      return `## ${p.name}\n${p.description}\n\nMetrics:\n${p.realMetrics.map((m) => `- ${m}`).join("\n")}${caveats}`;
    })
    .join("\n\n");
}


export function createAskEdgeorgieServer(): McpServer {
  const server = new McpServer({
    name: "ask-edgeorgie-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "get_experience",
    {
      title: "Get Edwin Jorge's (edgeorgie) real work experience",
      description:
        "Returns the candidate's actual work history exactly as written on his resume (resume.txt) — " +
        "employer, title, dates, and bullets, verbatim, no embellishment. Covers Mercado Libre " +
        "(Software Engineer, Nov 2022-present, AI workflows/agent-based architectures at 4.3M+ LATAM " +
        "users), Vansa, and Freelance roles.",
      inputSchema: {},
      outputSchema: {
        source: z.string(),
        summary: z.string(),
        roles: z.array(
          z.object({
            employer: z.string(),
            title: z.string(),
            dates: z.string(),
            bullets: z.array(z.string()),
          }),
        ),
      },
    },
    async () => {
      const result = await doGetExperience();
      // Usage shape only (the tool name), captured after the result exists and
      // awaited before it is returned: the transport writes the response the
      // moment this handler resolves, and a serverless instance may freeze
      // right after that. A no-op without POSTHOG_KEY; never throws.
      await capture("mcp_tool_called", { tool: "get_experience" });
      return {
        content: [
          {
            type: "text",
            text: `${result.summary}\n\n${result.roles
              .map((r) => `${r.employer} — ${r.title} (${r.dates})\n${r.bullets.map((b) => `  - ${b}`).join("\n")}`)
              .join("\n\n")}`,
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "get_projects",
    {
      title: "Get Edwin Jorge's (edgeorgie) real shipped project evidence",
      description:
        "Returns the 6 publicly shipped artifacts (triage-desk, eval-lab, repoask-mcp, " +
        "crispy-profiling, simplescope, agentlens) with their " +
        "real measured metrics, PR/commit/run URLs, and live demo links — sourced from each repo's public " +
        "commit history and RELIABILITY-REPORT.md. No metric here is estimated or invented; every claim cites exactly where " +
        "it was verified. EVERY project also returns a non-empty `limitations` array stating caveats a caller could not " +
        "infer from its metrics (no adoption, not on a registry, a self-labeled benchmark, a missing licence, a capability " +
        "it deliberately lacks). Caveats are mandatory per entry, not added only where they happened to be noticed, so an " +
        "absent caveat never means 'this one has none'.",
      inputSchema: {},
      outputSchema: {
        projects: z.array(
          z.object({
            name: z.string(),
            repo: z.string(),
            description: z.string(),
            realMetrics: z.array(z.string()),
            evidence: z.array(z.string()),
            // Per-string minimum, not just `.min(1)` on the array. A single
            // whitespace string satisfied an array-length check while stating
            // nothing, which made the caveat policy cosmetic.
            limitations: z.array(z.string().trim().min(40)).min(1),
            source: z.string(),
          }),
        ),
      },
    },
    async () => {
      const projects = await doGetProjects();
      await capture("mcp_tool_called", { tool: "get_projects" });
      return {
        content: [{ type: "text", text: renderProjectsText(projects) }],
        structuredContent: { projects } as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "get_story",
    {
      title: "Get Edwin Jorge's (edgeorgie) personal story as a timeline",
      description:
        "Returns a chronological, beat-by-beat narrative of who the candidate is beyond the resume — " +
        "from shipping a solo 2D platformer at 15, through his Electronic Engineering + Software " +
        "degrees, picking up Kotlin/Swift on the job, owning UX/design decisions, to what he's " +
        "self-teaching right now (Unreal Engine game dev, guitar, a 4x/week morning gym routine). " +
        "Structured as ordered beats (year, label, body), not a single prose block — render it as an " +
        "actual timeline rather than dumping the text. Unlike ask_about_edgeorgie, this tool does NOT " +
        "do retrieval and returns no line-level citations: the beats are the candidate's own " +
        "hand-written summary, maintained as editorial copy in src/engine.ts. The underlying facts " +
        "also appear in data/RECRUITER-FAQ.md and some phrasing overlaps with it, so treat this as " +
        "editorial copy rather than either a quote or a clean paraphrase — use ask_about_edgeorgie " +
        "when you need a cited source file and line range.",
      inputSchema: {},
      outputSchema: {
        intro: z.string(),
        beats: z.array(
          z.object({
            year: z.string(),
            label: z.string(),
            body: z.string(),
          }),
        ),
        source: z.string(),
      },
    },
    async () => {
      const result = await doGetStory();
      await capture("mcp_tool_called", { tool: "get_story" });
      return {
        content: [
          {
            type: "text",
            text: `${result.intro}\n\n${result.beats
              .map((b) => `[${b.year}] ${b.label}\n${b.body}`)
              .join("\n\n")}`,
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "ask_about_edgeorgie",
    {
      title: "Ask a grounded, cited question about Edwin Jorge (edgeorgie)",
      description:
        "Answers a natural-language question about the candidate's experience, projects, or skills using " +
        "TF-IDF retrieval over a corpus built ONLY from his real resume.txt, RELIABILITY-REPORT.md, " +
        "BUILD-LOG.md, and RECRUITER-FAQ.md (public evidence only). Returns citations " +
        "with exact source file + line range. If ANTHROPIC_API_KEY or OPENAI_API_KEY is set, also returns " +
        "a synthesized prose answer with inline [n] citations grounded strictly in the retrieved excerpts; " +
        "otherwise 'answer' is a deterministic citation dump and 'answerMode' is 'deterministic'. If a key is " +
        "set but the provider call fails, 'answerMode' is 'synthesis-failed' (not 'deterministic') and " +
        "'llmKeyConfigured' is true, so the cause is never misreported as a missing key. Never " +
        "answers beyond what's indexed — if nothing relevant is found, it says so rather than inventing " +
        "an answer.",
      inputSchema: {
        question: z.string().min(3).describe("Natural-language question about edgeorgie's experience/projects/skills."),
        topK: z.number().int().min(1).max(20).optional().describe("Number of citations to return. Default 6."),
      },
      outputSchema: {
        question: z.string(),
        answer: z.string(),
        answerMode: z.enum(["llm", "deterministic", "synthesis-failed"]),
        llmKeyConfigured: z.boolean(),
        model: z.string().optional(),
        citations: z.array(
          z.object({
            rank: z.number().int(),
            source: z.string(),
            startLine: z.number().int(),
            endLine: z.number().int(),
            score: z.number(),
            excerpt: z.string(),
          }),
        ),
      },
    },
    async ({ question, topK }) => {
      const startedAt = Date.now();
      const result = await doAskAboutEdgeorgie(question, topK);
      // Same event name as POST /api/ask (surface "web") so one chart shows
      // humans and agents side by side. Sent concurrently with the tool-call
      // event; neither can reject, so Promise.all cannot either.
      await Promise.all([
        capture("mcp_tool_called", { tool: "ask_about_edgeorgie" }),
        capture("question_asked", questionAskedProperties("mcp", question.length, result, Date.now() - startedAt)),
      ]);
      return {
        content: [{ type: "text", text: result.answer }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}
