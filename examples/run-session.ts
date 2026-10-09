/**
 * Standalone MCP client harness: connects to a running ask-edgeorgie-mcp
 * server (stdio by default, or Streamable HTTP if a URL is passed as argv[1])
 * and runs a fixed set of real questions, saving the literal JSON-RPC-level
 * request/response transcript to examples/transcript.json.
 *
 * Usage:
 *   node --import tsx examples/run-session.ts                      # stdio, local dist/server.js
 *   node --import tsx examples/run-session.ts <http-url> <outfile> # remote Streamable HTTP
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const serverUrl = process.argv[2];
  const outFile = process.argv[3] ?? path.join(__dirname, "transcript.json");

  const client = new Client({ name: "ask-edgeorgie-example-client", version: "1.0.0" });
  let transport;
  if (serverUrl) {
    transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  } else {
    const serverPath = path.join(__dirname, "..", "dist", "server.js");
    transport = new StdioClientTransport({ command: "node", args: [serverPath] });
  }
  await client.connect(transport);

  const transcript: Record<string, unknown> = {
    serverUrl: serverUrl ?? "stdio:dist/server.js",
    ranAt: new Date().toISOString(),
  };

  const toolsList = await client.listTools();
  transcript.list_tools = toolsList;

  const experience = await client.callTool({ name: "get_experience", arguments: {} });
  transcript.get_experience = experience;

  const projects = await client.callTool({ name: "get_projects", arguments: {} });
  transcript.get_projects = projects;

  const q1 = "What AI agent infrastructure has this person built in production?";
  const ask1 = await client.callTool({ name: "ask_about_edgeorgie", arguments: { question: q1 } });
  transcript.ask_about_edgeorgie_q1 = { question: q1, result: ask1 };

  const q2 = "What's the most technically interesting thing they shipped?";
  const ask2 = await client.callTool({ name: "ask_about_edgeorgie", arguments: { question: q2 } });
  transcript.ask_about_edgeorgie_q2 = { question: q2, result: ask2 };

  const q3 = "What is their measured accuracy on the triage bot and what are its known failure modes?";
  const ask3 = await client.callTool({ name: "ask_about_edgeorgie", arguments: { question: q3 } });
  transcript.ask_about_edgeorgie_q3 = { question: q3, result: ask3 };

  await fs.writeFile(outFile, JSON.stringify(transcript, null, 2), "utf8");
  console.log(`Transcript written to ${outFile}`);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
