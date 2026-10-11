/**
 * Behavioural regression guard for the /health-style tool advertisement.
 *
 * tests/server.test.ts already pins the hand-maintained `tools: [...]` array
 * by REGEXING THE SOURCE TEXT of api/mcp.ts and src/http-server.ts. That
 * catches the literal regression (an element deleted from the array) but it
 * is a source lint, not a statement about behaviour: the identical
 * user-visible bug expressed non-literally — e.g.
 *
 *   tools: ["get_experience", "get_projects", "get_story", "ask_about_edgeorgie"].slice(0, 3)
 *
 * — leaves that guard perfectly green while the deployed payload again
 * advertises 3 of 4 tools.
 *
 * So this file asserts on the ACTUAL RUNTIME RESPONSE instead:
 *   - api/mcp.ts      -> invokes the real exported default handler with a GET
 *                        and reads the JSON it writes to the response.
 *   - src/http-server -> boots the real Express app on an ephemeral port and
 *                        performs a real HTTP GET / over the loopback socket.
 * Both are compared against what the real MCP server's listTools() returns.
 *
 * Scope, stated precisely rather than absolutely: no source text is parsed
 * here, so any array whose value is the SAME IN EVERY ENVIRONMENT — literal,
 * sliced, filtered, or computed — is covered. What this cannot cover is an
 * environment-CONDITIONAL array (e.g. keyed off process.env.NODE_ENV), since
 * these assertions only observe the value produced in the test process. A
 * guard that watches one environment cannot make a claim about another; the
 * honest bound is "catches drift, not deliberate per-environment divergence."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import mcpHandler from "../api/mcp.js";
import { createApp } from "../src/http-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "dist", "server.js");

/** The tools the MCP server really registers, via a real client over stdio. */
async function registeredToolNames(): Promise<string[]> {
  const transport = new StdioClientTransport({ command: "node", args: [SERVER_PATH] });
  const client = new Client({ name: "health-test-client", version: "1.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

/**
 * Minimal VercelResponse stand-in: captures whatever the handler actually
 * serializes, so the assertion is about the real emitted payload rather than
 * the expression that produced it.
 */
function captureResponse() {
  const captured: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return { res, captured };
}

test("api/mcp.ts GET really responds with every tool the server registers", async () => {
  const registered = await registeredToolNames();
  const { res, captured } = captureResponse();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await mcpHandler({ method: "GET", headers: {} } as any, res as any);

  assert.equal(captured.statusCode, 200, "GET /mcp must answer 200");
  const body = captured.body as { tools?: unknown; status?: string };
  assert.ok(Array.isArray(body.tools), "the GET payload must carry a tools array");
  const advertised = [...(body.tools as string[])].sort();
  assert.deepEqual(
    advertised,
    registered,
    `api/mcp.ts GET really returned [${advertised.join(",")}] but the server registers [${registered.join(",")}]`,
  );
  assert.equal(body.status, "ok");
});

test("src/http-server.ts GET / over a real socket advertises every registered tool", async () => {
  const registered = await registeredToolNames();
  const app = createApp();
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200, "GET / must answer 200");
    const body = (await res.json()) as { tools?: unknown; status?: string };
    assert.ok(Array.isArray(body.tools), "the health payload must carry a tools array");
    const advertised = [...(body.tools as string[])].sort();
    assert.deepEqual(
      advertised,
      registered,
      `src/http-server.ts GET / really returned [${advertised.join(",")}] but the server registers [${registered.join(",")}]`,
    );
    assert.equal(body.status, "ok");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("GET /api/story really returns 200 with a usable timeline", async () => {
  const { default: storyHandler } = await import("../api/story.js");
  const { res, captured } = captureResponse();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await storyHandler({ method: "GET", headers: {} } as any, res as any);

  assert.equal(captured.statusCode, 200, "GET /api/story must answer 200");
  const body = captured.body as { intro?: string; beats?: any[]; source?: string };
  assert.ok(body.intro && body.intro.length > 10, "story must carry an intro");
  assert.ok(Array.isArray(body.beats) && body.beats.length >= 5, "expected at least 5 beats");
  assert.ok(
    body.beats!.every((b) => typeof b.year === "string" && b.year.length > 0 && b.label && b.body),
    "every beat needs a non-empty year/label/body",
  );
  // The origin beat is specifically "Age 15" — a bare /15/ match would also be
  // satisfied by "2015" or "1500", which is why this pins the exact label.
  assert.ok(
    body.beats!.some((b) => b.year === "Age 15"),
    `expected an "Age 15" origin beat, got years [${body.beats!.map((b) => b.year).join(", ")}]`,
  );
  assert.ok(body.source && body.source.length > 10, "story must state its provenance");
  // The source field must not claim a file+line citation it cannot back:
  // doGetStory is editorial copy, not retrieval. See src/engine.ts doGetStory.
  assert.match(body.source!, /paraphrase, not a quote/i);
});

test("GET /api/story rejects non-GET methods", async () => {
  const { default: storyHandler } = await import("../api/story.js");
  const { res, captured } = captureResponse();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await storyHandler({ method: "POST", headers: {} } as any, res as any);
  assert.equal(captured.statusCode, 405);
});

test("POST /api/ask maps an over-length question to 413, not 500", async () => {
  // The README states an oversized question returns 413. Without this test
  // that claim is unfalsifiable: the engine-level cap signals by throwing,
  // which this handler's catch maps to 500, so deleting the route's own
  // length check degrades a client error into "the server is broken" while
  // every other test stays green (verified by mutation — removing the check
  // left the suite at 36/36 before this test existed).
  const { default: askHandler } = await import("../api/ask.js");
  const { res, captured } = captureResponse();

  const oversized = "token ".repeat(4000); // 24,000 chars, over the 2000 cap
  await askHandler(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { method: "POST", headers: {}, body: { question: oversized } } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res as any,
  );

  assert.equal(captured.statusCode, 413, "an over-length question is a client error, not a 500");
  const body = captured.body as { error?: string };
  assert.match(body.error ?? "", /too long/i);
  // The real length must be reported so a caller can see how far over it is.
  assert.match(body.error ?? "", new RegExp(String(oversized.length)));
});

test("POST /api/ask still answers a question just under the cap", async () => {
  // Pairs with the test above so the 413 path cannot be satisfied by a
  // handler that rejects everything.
  const { default: askHandler } = await import("../api/ask.js");
  const { res, captured } = captureResponse();

  await askHandler(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { method: "POST", headers: {}, body: { question: "What MCP server has this person built?" } } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res as any,
  );

  assert.equal(captured.statusCode, 200, "a normal question must still be answered");
  const body = captured.body as { citations?: unknown[] };
  assert.ok(Array.isArray(body.citations), "expected a normal cited answer");
});
