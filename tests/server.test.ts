/**
 * Spins up the compiled server (dist/server.js) as a real subprocess and
 * drives it with a real @modelcontextprotocol/sdk Client over stdio.
 * No mocks: this exercises the actual corpus-loading, TF-IDF retrieval, and
 * tool-handler code paths exactly as a real MCP client would.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "dist", "server.js");

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({ command: "node", args: [SERVER_PATH] });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("list_tools exposes the 4 expected tools", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["ask_about_edgeorgie", "get_experience", "get_projects", "get_story"]);
  });
});

test("the health-check tool list matches the tools the server actually registers", async () => {
  // Regression guard: the /health JSON in api/mcp.ts and src/http-server.ts is a
  // hand-maintained array, so it silently drifted when get_story was added and
  // advertised only 3 of the 4 real tools to anyone curling the deployment.
  const registered = await withClient(async (client) => {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const sources = [
    ["src/http-server.ts", path.join(here, "..", "src", "http-server.ts")],
    ["api/mcp.ts", path.join(here, "..", "api", "mcp.ts")],
  ] as const;

  for (const [label, file] of sources) {
    const source = await readFile(file, "utf8");
    const match = source.match(/tools:\s*\[([^\]]+)\]/);
    assert.ok(match, `${label} must declare a tools array in its health payload`);
    const advertised = match[1]
      .split(",")
      .map((s: string) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
      .sort();
    assert.deepEqual(
      advertised,
      registered,
      `${label} advertises ${advertised.join(",")} but the server registers ${registered.join(",")}`,
    );
  }
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

test("get_story returns a chronological timeline, not prose", async () => {
  await withClient(async (client) => {
    const res: any = await client.callTool({ name: "get_story", arguments: {} });
    const beats = res.structuredContent.beats;
    assert.ok(Array.isArray(beats) && beats.length >= 5, "expected at least 5 story beats");
    assert.ok(
      beats.every((b: any) => typeof b.year === "string" && b.year.trim() && b.label && b.body),
      "every beat needs year/label/body",
    );
    // Pin the exact origin-beat label: a bare /15/ test is also satisfied by
    // "2015" or "1500", so it would not actually prove the age-15 beat exists.
    assert.ok(
      beats.some((b: any) => b.year === "Age 15"),
      `expected an "Age 15" origin beat, got years [${beats.map((b: any) => b.year).join(", ")}]`,
    );
    // The source field must describe provenance it can actually back —
    // get_story is editorial copy, not retrieval, so it must not read as a
    // file+line citation. See src/engine.ts doGetStory.
    assert.match(res.structuredContent.source, /paraphrase, not a quote/i);
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

test("an over-length question is rejected through the real MCP transport", async () => {
  // This is the test that actually guards the cap. The unit tests in
  // tests/rate-limit.test.ts only exercise checkQuestionLength as a pure
  // function — deleting the call site in src/engine.ts would leave them all
  // green while production went back to accepting a 19,500-character
  // question (which it demonstrably did before the cap existed). Driving a
  // real MCP client against the compiled server proves the check is wired
  // into the path a caller can actually reach.
  await withClient(async (client) => {
    const oversized = "token ".repeat(4000); // 24,000 chars, well over the 2000 cap
    const res: any = await client.callTool({
      name: "ask_about_edgeorgie",
      arguments: { question: oversized },
    });
    assert.equal(res.isError, true, "an over-length question must not be answered");
    const text = JSON.stringify(res.content ?? res);
    assert.match(text, /too long/i, `expected a length rejection, got: ${text.slice(0, 300)}`);
    // The real length must appear, so a caller can see how far over they are.
    assert.match(text, new RegExp(String(oversized.length)));
  });
});

test("a question just under the cap is still answered normally", async () => {
  // Pairs with the test above: proves the cap rejects on length rather than
  // on some incidental property of a long string, and that a legitimately
  // long question is not collateral damage.
  await withClient(async (client) => {
    const nearLimit = "What MCP server has this person built and deployed? " + "x".repeat(1900);
    const res: any = await client.callTool({
      name: "ask_about_edgeorgie",
      arguments: { question: nearLimit.slice(0, 1999) },
    });
    assert.notEqual(res.isError, true, "a 1999-character question must still be answered");
    assert.ok(res.structuredContent, "expected a normal structured answer");
  });
});
