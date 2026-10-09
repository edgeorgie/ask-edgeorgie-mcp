/**
 * Shared MCP server factory: builds a fresh McpServer with the three
 * "ask about edgeorgie" tools registered (get_experience, get_projects,
 * ask_about_edgeorgie). Both transports (stdio in server.ts, Streamable HTTP
 * in http-server.ts / api/mcp.ts) call this so tool definitions live in
 * exactly one place. Implementations live in src/engine.ts, shared with the
 * human-facing REST routes (api/experience.ts, api/projects.ts, api/ask.ts)
 * so the MCP tools and the web UI are provably the same engine.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { doGetExperience, doGetProjects, doAskAboutEdgeorgie } from "./engine.js";

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
        "Returns the 3 real, publicly shipped artifacts (triage-desk, eval-lab, repoask-mcp) with their " +
        "real measured metrics, PR/commit/run URLs, and live demo links — sourced from each repo's public " +
        "commit history and RELIABILITY-REPORT.md. No metric here is estimated or invented; every claim cites exactly where " +
        "it was verified.",
      inputSchema: {},
      outputSchema: {
        projects: z.array(
          z.object({
            name: z.string(),
            repo: z.string(),
            description: z.string(),
            realMetrics: z.array(z.string()),
            evidence: z.array(z.string()),
            source: z.string(),
          }),
        ),
      },
    },
    async () => {
      const projects = await doGetProjects();
      return {
        content: [
          {
            type: "text",
            text: projects
              .map((p) => `## ${p.name}\n${p.description}\n\nMetrics:\n${p.realMetrics.map((m) => `- ${m}`).join("\n")}`)
              .join("\n\n"),
          },
        ],
        structuredContent: { projects } as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "ask_about_edgeorgie",
    {
      title: "Ask a grounded, cited question about Edwin Jorge (edgeorgie)",
      description:
        "Answers a natural-language question about the candidate's experience, projects, or skills using " +
        "TF-IDF retrieval over a corpus built ONLY from his real resume.txt, RELIABILITY-REPORT.md, and " +
        "BUILD-LOG.md (public evidence only). Returns citations " +
        "with exact source file + line range. If ANTHROPIC_API_KEY or OPENAI_API_KEY is set, also returns " +
        "a synthesized prose answer with inline [n] citations grounded strictly in the retrieved excerpts; " +
        "otherwise 'answer' is a deterministic citation dump and 'answerMode' is 'deterministic'. Never " +
        "answers beyond what's indexed — if nothing relevant is found, it says so rather than inventing " +
        "an answer.",
      inputSchema: {
        question: z.string().min(3).describe("Natural-language question about edgeorgie's experience/projects/skills."),
        topK: z.number().int().min(1).max(20).optional().describe("Number of citations to return. Default 6."),
      },
      outputSchema: {
        question: z.string(),
        answer: z.string(),
        answerMode: z.enum(["llm", "deterministic"]),
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
      const result = await doAskAboutEdgeorgie(question, topK);
      return {
        content: [{ type: "text", text: result.answer }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}
