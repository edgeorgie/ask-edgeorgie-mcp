/**
 * Human-facing REST route: GET /api/story — same engine as the get_story
 * MCP tool (src/engine.ts doGetStory). Returns the candidate's personal
 * timeline as structured beats for the public page to render visually.
 *
 * Rate limiting: deliberately NOT applied, same as api/experience.ts and
 * api/projects.ts. doGetStory returns a compile-time constant — no corpus
 * read, no retrieval, no LLM call — so the per-request cost is a JSON
 * serialization and there is nothing abusable to meter. src/rate-limit.ts
 * exists to cap the paths that can trigger real work (/mcp, /api/ask and the
 * optional synthesis path). Add a limiter here the moment this route starts
 * reading files or calling a provider.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { doGetStory } from "../src/engine.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method Not Allowed: use GET." });
    return;
  }
  try {
    const story = await doGetStory();
    res.status(200).json(story);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
