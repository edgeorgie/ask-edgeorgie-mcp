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
import type express from "express";
import { handleMcpRequest } from "../src/http-server.js";
import { checkRateLimit, getClientId } from "../src/rate-limit.js";

/**
 * handleMcpRequest's signature is express.Request/express.Response because
 * it's shared with the standalone Express server (src/http-server.ts). The
 * MCP SDK's StreamableHTTPServerTransport only reads/writes the
 * IncomingMessage/ServerResponse surface both Vercel's and Express's request/
 * response objects implement (method, url, headers, on('data'/'end'),
 * writeHead/end, etc.) — VercelRequest/VercelResponse are structurally
 * IncomingMessage/ServerResponse plus extra fields (query/cookies/body,
 * send/json helpers) that aren't used by the transport, so this cast is a
 * real but narrow type-system gap (no official @vercel/node<->express adapter
 * type exists), not a silenced error. Casting to the specific express types
 * (rather than `any`) keeps everything handleMcpRequest actually touches
 * type-checked.
 */
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

  // Rate limit before doing any real work. See src/rate-limit.ts for the full
  // rationale — this is what keeps the endpoint safe the moment an LLM key
  // is ever configured (today it only gates the cheap TF-IDF fallback path).
  const callerId = getClientId(req as unknown as { headers: Record<string, unknown>; socket?: { remoteAddress?: string } });
  const limit = checkRateLimit(callerId);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSeconds ?? 60));
    res.status(429).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: `Rate limit exceeded (${limit.reason === "global" ? "global" : "per-caller"} limit). Retry after ${limit.retryAfterSeconds}s.`,
      },
      id: null,
    });
    return;
  }

  try {
    await handleMcpRequest(req as unknown as express.Request, res as unknown as express.Response);
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
