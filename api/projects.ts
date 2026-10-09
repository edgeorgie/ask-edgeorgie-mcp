/**
 * Human-facing REST route: GET /api/projects — same engine as the
 * get_projects MCP tool (src/engine.ts doGetProjects).
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { doGetProjects } from "../src/engine.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method Not Allowed: use GET." });
    return;
  }
  try {
    const projects = await doGetProjects();
    res.status(200).json({ projects });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
