#!/usr/bin/env node
/**
 * ask-edgeorgie-mcp — Streamable HTTP transport (MCP spec 2025-03-26+).
 *
 * Remote entrypoint: exposes the same 3 tools as the stdio server
 * (get_experience, get_projects, ask_about_edgeorgie, built via the shared
 * factory in create-server.ts) over HTTP so any MCP client on the network —
 * not just a local subprocess — can connect. This is what makes it possible
 * for a recruiter to literally point Claude Desktop/Cursor at a public URL
 * and ask about the candidate, the same way Rafa Audibert's MCP endpoint
 * works at rafaaudibert.dev/mcp/.
 *
 * Runs STATELESS (sessionIdGenerator: undefined) — same documented pattern
 * used by repoask-mcp, because serverless platforms like Vercel don't
 * guarantee warm-instance reuse across requests, so stateful in-memory MCP
 * sessions would silently break. The corpus index itself is still cached
 * in-process (see corpus.ts) so repeated asks within one warm instance are
 * fast; a cold start just rebuilds the TF-IDF index from the committed
 * data/ files (milliseconds, no network call).
 *
 * Usage:
 *   node dist/http-server.js            # listens on PORT (default 3000), path /mcp
 *
 * Used directly by:
 *   - api/mcp.ts (Vercel serverless function wrapper, same handler)
 *   - any standalone Node host via `npm run start:http`
 */

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAskEdgeorgieServer } from "./create-server.js";

export async function handleMcpRequest(req: express.Request, res: express.Response): Promise<void> {
  const server = createAskEdgeorgieServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/", (_req, res) => {
    res.json({
      name: "ask-edgeorgie-mcp",
      description: "Ask an AI agent real, grounded, cited questions about Edwin Jorge (edgeorgie).",
      transport: "streamable-http",
      mcpEndpoint: "/mcp",
      tools: ["get_experience", "get_projects", "ask_about_edgeorgie"],
      status: "ok",
    });
  });

  app.post("/mcp", async (req, res) => {
    try {
      await handleMcpRequest(req, res);
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
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed: this server is stateless (no GET/SSE stream)." },
      id: null,
    });
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed: this server is stateless (no sessions to delete)." },
      id: null,
    });
  });

  return app;
}

const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`ask-edgeorgie-mcp Streamable HTTP server listening on :${port} (POST /mcp)`);
  });
}
