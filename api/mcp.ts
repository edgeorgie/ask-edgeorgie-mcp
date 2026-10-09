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
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { handleMcpRequest } from "../src/http-server.js";

/**
 * Vercel's (req, res) and Express's (req, res) are both just thin wrappers
 * around Node's IncomingMessage/ServerResponse with slightly different added
 * methods (VercelRequest adds `query`/`cookies`/`body` parsing conventions
 * that happen to be a structural superset of what express.Request declares).
 * `handleMcpRequest` (src/http-server.ts) only reads method/headers/body and
 * calls res.status()/json()/writeHead()/end() — all present on both types.
 * We cast through the real target type (ExpressRequest/ExpressResponse)
 * instead of through `any`, so a genuine shape mismatch (e.g. a renamed
 * method on either side) still fails typecheck instead of being silenced.
 */
function asExpressRequest(req: VercelRequest): ExpressRequest {
  return req as unknown as ExpressRequest;
}
function asExpressResponse(res: VercelResponse): ExpressResponse {
  return res as unknown as ExpressResponse;
}

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
    await handleMcpRequest(asExpressRequest(req), asExpressResponse(res));
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
