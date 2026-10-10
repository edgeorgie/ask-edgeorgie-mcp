/**
 * Spins up the compiled server (dist/server.js) as a real subprocess and
 * drives it with a real @modelcontextprotocol/sdk Client over stdio.
 * No mocks: this exercises the actual corpus-loading, TF-IDF retrieval, and
 * tool-handler code paths exactly as a real MCP client would.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "dist", "server.js");

async function withClient(fn: (client: Client) => Promise<void>) {
  const transport = new StdioClientTransport({ command: "node", args: [SERVER_PATH] });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

test("list_tools exposes the 3 expected tools", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["ask_about_edgeorgie", "get_experience", "get_projects"]);
  });
});

test("get_experience returns real resume roles including Mercado Libre", async () => {
  await withClient(async (client) => {
    const res: any = await client.callTool({ name: "get_experience", arguments: {} });
    const roles = res.structuredContent.roles;
    assert.ok(roles.length >= 3, "expected at least 3 roles");
    const ml = roles.find((r: any) => r.employer.includes("Mercado Libre"));
    assert.ok(ml, "Mercado Libre role must be present");
    assert.ok(ml.bullets.some((b: string) => b.includes("agent-based architectures")));
  });
});

test("get_projects returns all 5 real shipped artifacts", async () => {
  await withClient(async (client) => {
    const res: any = await client.callTool({ name: "get_projects", arguments: {} });
    const names = res.structuredContent.projects.map((p: any) => p.name).sort();
    assert.deepEqual(names, ["crispy-profiling", "eval-lab", "repoask-mcp", "simplescope", "triage-desk"]);
  });
});

test("ask_about_edgeorgie grounds an MCP-related question in real citations", async () => {
  await withClient(async (client) => {
    const res: any = await client.callTool({
      name: "ask_about_edgeorgie",
      arguments: { question: "What MCP server has this person built and deployed?" },
    });
    const structured = res.structuredContent;
    assert.ok(structured.citations.length > 0, "expected at least one citation");
    assert.ok(
      structured.citations.some((c: any) => /repoask-mcp|BUILD-LOG/i.test(c.source)),
      "expected a citation from a source mentioning repoask-mcp",
    );
  });
});

test("ask_about_edgeorgie on an unrelated question returns no fabricated answer", async () => {
  await withClient(async (client) => {
    const res: any = await client.callTool({
      name: "ask_about_edgeorgie",
      arguments: { question: "What is the capital of a fictional planet Zorblax?" },
    });
    const structured = res.structuredContent;
    // Either zero citations, or low-scoring ones — never a confident invented answer.
    assert.equal(structured.answerMode, "deterministic");
  });
});
