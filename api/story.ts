/**
 * Human-facing REST route: GET /api/story — same engine as the get_story
 * MCP tool (src/engine.ts doGetStory). Returns the candidate's personal
 * timeline as structured beats for the public page to render visually.
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
