import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "dist", "server.js");
const transport = new StdioClientTransport({ command: "node", args: [serverPath] });
const client = new Client({ name: "verify-client", version: "1.0.0" });
await client.connect(transport);

const qs = [
  "how many initiatives has this candidate delivered",
  "what smart TV platforms has this candidate worked with",
  "what production feature reached 1.5 million users with zero incidents",
];
for (const q of qs) {
  const res = await client.callTool({ name: "ask_about_edgeorgie", arguments: { question: q } });
  console.log("Q:", q);
  console.log(JSON.stringify(res.structuredContent, null, 2));
  console.log("-----");
}
await client.close();
