/**
 * Human-facing REST route: GET /api/experience — same engine as the
 * get_experience MCP tool (src/engine.ts doGetExperience), so the web UI and
 * the MCP server are provably the same source of truth.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { doGetExperience } from "../src/engine.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method Not Allowed: use GET." });
    return;
  }
  try {
    const result = await doGetExperience();
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
