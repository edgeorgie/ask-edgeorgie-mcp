#!/usr/bin/env node
/**
 * ask-edgeorgie-mcp — an MCP server that lets an agent ask grounded, cited
 * questions about Edwin Jorge (edgeorgie): his real work experience, real
 * shipped projects, and real skills. A personal-site MCP endpoint so a
 * recruiter's agent can query him directly, instead of parsing a static
 * resume PDF.
 *
 * Retrieval is 100% local (TF-IDF over a corpus built from resume.txt,
 * RELIABILITY-REPORT.md, and BUILD-LOG.md — public evidence only, no
 * external embedding API, no paid key). An LLM key
 * (ANTHROPIC_API_KEY or OPENAI_API_KEY) is OPTIONAL and used only to turn
 * retrieved excerpts into prose with inline citations; without one,
 * ask_about_edgeorgie deterministically returns the top-matching excerpts.
 *
 * Transport: stdio (the standard transport for local MCP clients like Claude
 * Desktop / Cursor). For a remote/network-reachable client, see
 * http-server.ts (Streamable HTTP transport, same tools via
 * create-server.ts — nothing duplicated).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAskEdgeorgieServer } from "./create-server.js";

async function main() {
  const server = createAskEdgeorgieServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("ask-edgeorgie-mcp fatal error:", err);
  process.exit(1);
});
