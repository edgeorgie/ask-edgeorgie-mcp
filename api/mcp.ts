/**
 * Vercel serverless function entrypoint: wraps the same Streamable HTTP MCP
 * handler used by src/http-server.ts so the 3 tools (get_experience,
 * get_projects, ask_about_edgeorgie) are reachable at
 * https://<deployment>.vercel.app/mcp over the internet.
 *
 * Deliberately stateless (StreamableHTTPServerTransport with
 * sessionIdGenerator: undefined via handleMcpRequest) — see
 * src/http-server.ts for rationale. vercel.json routes /mcp -> /api/mcp.ts.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleMcpRequest } from "../src/http-server.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === "GET") {
    res.status(200).json({
      name: "ask-edgeorgie-mcp",
      description: "Ask an AI agent real, grounded, cited questions about Edwin Jorge (edgeorgie).",
      transport: "streamable-http",
      mcpEndpoint: "/mcp",
      tools: ["get_experience", "get_projects", "ask_about_edgeorgie"],
      status: "ok",
    });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed: use POST for MCP JSON-RPC calls." },
      id: null,
    });
    return;
  }
  try {
    await handleMcpRequest(req as unknown as any, res as unknown as any);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}
