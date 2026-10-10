# ask-edgeorgie-mcp

> Don't read my resume. **Ask it a question.**

A public [MCP](https://modelcontextprotocol.io) server for **Edwin Jorge**
([edgeorgie](https://github.com/edgeorgie)). Point Claude Desktop, Cursor, or any
MCP client at this URL to ask about my work experience, shipped projects, and
skills — answers are **grounded and cited** against my resume and project
history.

**Live URL:** `https://ask-edgeorgie-mcp.vercel.app` (health check) /
`https://ask-edgeorgie-mcp.vercel.app/mcp` (MCP Streamable HTTP endpoint)

## Why this exists

repoask-mcp answers questions about someone else's GitHub repo, grounded and
cited against the actual source instead of generated from scratch. I wanted
the same thing pointed at myself: an agent that can answer real questions
about my work using my resume and project history as the retrieval corpus,
rather than whatever a model happens to already know (or guess) about me.

## Tools

| Tool | What it does |
|---|---|
| `get_experience` | Returns my real work history straight from `resume.txt` — Mercado Libre, Vansa, Freelance — verbatim, no embellishment. |
| `get_projects` | Returns the 3 real shipped artifacts ([triage-desk](https://github.com/edgeorgie/triage-desk), [eval-lab](https://github.com/edgeorgie/eval-lab), [repoask-mcp](https://github.com/edgeorgie/repoask-mcp)) with their real measured metrics and PR/commit/run URLs. |
| `ask_about_edgeorgie` | Retrieval-based Q&A. TF-IDF search over a corpus built from `resume.txt`, `RELIABILITY-REPORT.md`, and `BUILD-LOG.md` (public evidence only). Every answer cites the exact source file + line range it came from. If no LLM key is set, the response is a deterministic citation dump (no generation at all); if `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set, a model synthesizes prose but is instructed to ground every sentence in the retrieved excerpts and cite them inline — it never answers beyond what's indexed. |

## The corpus

The retrieval corpus is a direct copy of files that already existed
before this repo, with no new biographical or project claims invented:

- `resume.txt` — the actual resume.
- `RELIABILITY-REPORT.md` — measured pass-rate/latency/accuracy numbers for
  eval-lab and triage-desk.
- `BUILD-LOG.md` — a first-person account of the real debugging episodes
  (including this project's own Vercel deployment fix, documented below).

Internal job-search process documents (sprint logs, application drafts,
employer-specific case-study notes) are intentionally excluded from this
corpus — this server only serves content meant to be public.

Questions outside the corpus get a "no good match" response rather than an
invented answer (see the test suite's "unrelated question" case).

## Architecture — same proven pattern as repoask-mcp

This reuses the exact working deployment shape already proven for
[repoask-mcp](https://github.com/edgeorgie/repoask-mcp):

- Official `@modelcontextprotocol/sdk`, one shared server factory
  (`src/create-server.ts`) used by **both** transports:
  - `src/server.ts` — stdio transport (local MCP clients, e.g. Claude Desktop).
  - `src/http-server.ts` — Streamable HTTP transport, **stateless**
    (`sessionIdGenerator: undefined`) because serverless platforms don't
    guarantee warm-instance reuse across requests.
- `api/mcp.ts` — Vercel serverless function wrapping the same HTTP handler, so
  the identical tool set is reachable at `/mcp` over the public internet.
- `api/experience.ts`, `api/projects.ts`, `api/ask.ts` — thin REST routes that
  call the exact same `src/engine.ts` functions the MCP tools call, so the
  human-facing web UI (`public/`) and the agent-facing MCP server are
  provably the same engine, not a parallel copy.
- Retrieval logic — chunking, TF-IDF embedding, cosine scoring, prompt/citation
  building — is imported from
  [`@edgeorgie/retrieval-core`](https://github.com/edgeorgie/retrieval-core),
  a package extracted from this repo and repoask-mcp after a direct diff
  showed their `chunk.ts`/`vector.ts`/`embedder.ts`/`rag.ts` were
  byte-identical. Same chunking window, same stopword list, same
  cosine-similarity scoring, now maintained once instead of copy-pasted
  twice — pointed here at a local text corpus instead of a fetched GitHub
  repo (see `src/corpus.ts`).

### Deployment gotchas (pre-applied from repoask-mcp's deployment debugging)

repoask-mcp hit three real Vercel deployment issues before it became publicly
reachable. All three were applied proactively here, not re-discovered:

1. **`rewrites` doesn't choose which file Vercel builds.** Zero-config
   detection would try to build `dist/server.js` (the stdio entrypoint) and
   fail with "No exports found in module". Fixed by using an explicit
   `builds` array in `vercel.json` targeting `api/mcp.ts`, `api/experience.ts`,
   `api/projects.ts`, `api/ask.ts`, and `public/**` directly, with `dist/`
   excluded via `.vercelignore`.
2. **Once `builds` is present, `rewrites` stops working** — `routes` is the
   correct routing primitive in that mode. `vercel.json` here uses `routes`
   from the start.
3. **`ssoProtection` (Vercel's deployment-protection wall)** returns a 302 to
   Vercel SSO on a plain `curl` by default on some account configurations.
   Disabled via `PATCH https://api.vercel.com/v9/projects/<id>` with
   `{"ssoProtection": null}` immediately after deploy, before calling it done.
4. This sandbox's global `NODE_ENV=production` silently makes `npm install`
   skip all `devDependencies` (including `typescript`), breaking the build
   with a confusing "tsc: not found". Build with
   `unset NODE_ENV && npm install --include=dev`.

## Connect an agent

Claude Desktop / Cursor (`claude_desktop_config.json` or equivalent):

```json
{
  "mcpServers": {
    "ask-edgeorgie": {
      "url": "https://ask-edgeorgie-mcp.vercel.app/mcp"
    }
  }
}
```

Or with the official SDK directly:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-client", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("https://ask-edgeorgie-mcp.vercel.app/mcp")));

const answer = await client.callTool({
  name: "ask_about_edgeorgie",
  arguments: { question: "What AI agent infrastructure has this person built in production?" },
});
```

## Verification

`npm test` runs a `pretest` hook (`npm run build`) first, so a fresh clone +
`npm install && npm test` works without any manual build step — tests spin up
the compiled server from `dist/`, which doesn't exist until `pretest` builds it.

- `npm test` → 5/5 passing: spins up the **compiled** server as a real
  subprocess and drives it with a real `@modelcontextprotocol/sdk` `Client`
  over stdio (`list_tools` shape, `get_experience` structural check incl.
  Mercado Libre, `get_projects` returns all 3 artifacts, `ask_about_edgeorgie`
  grounds an MCP-related question in a real citation, and an unrelated/
  nonsense question correctly stays in deterministic/no-fabrication mode).
- `examples/run-session.ts` is a standalone MCP client harness (same SDK
  `Client`, real stdio or real Streamable HTTP depending on args) that asks
  the real questions below and commits the literal transcript to
  `examples/transcript.json`.
- See the "Remote deployment status" section below for the real public-URL
  verification.

### Transcript excerpt (deterministic mode, no LLM key configured)

> **Q: What AI agent infrastructure has this person built in production?**
> Top citation: `resume.txt` — the Mercado Libre work-history bullet on
> agent-based architectures, correctly surfaced as the most relevant source
> for "production" + "AI agent infrastructure".

> **Q: What's the most technically interesting thing they shipped?**
> Top citation: `BUILD-LOG.md` lines 1-26 (score 0.09) — the first-person
> build log covering the repoask-mcp deployment debugging story, correctly
> surfaced as the most relevant source for "technically interesting."

Full real transcript (all 3 tools, 3 questions, exact JSON-RPC-level
request/response): [`examples/transcript.json`](./examples/transcript.json).

## Remote deployment status

**LIVE.** Deployed to Vercel (new project, GitHub-integration-linked to this
repo, same account already used for the other 8 live demos/repoask-mcp).

- Health check, bare unauthenticated `curl`, zero Vercel session/cookie:
  `curl https://ask-edgeorgie-mcp.vercel.app/` → real 200 JSON
  (`{"name":"ask-edgeorgie-mcp", ..., "tools":["get_experience","get_projects","ask_about_edgeorgie"], "status":"ok"}`),
  **no SSO redirect** — the project's `ssoProtection` was `PATCH`ed to `null`
  via `https://api.vercel.com/v9/projects/ask-edgeorgie-mcp` immediately after
  the first deploy (same fix already proven for repoask-mcp), confirmed by a
  fresh deployment-protection check before this was written up.
- `POST /mcp` `tools/list` over the real public internet → correct 3-tool
  schema (`get_experience`, `get_projects`, `ask_about_edgeorgie`).
- Ran `examples/run-session.ts` with the real `@modelcontextprotocol/sdk`
  `Client` + `StreamableHTTPClientTransport` against
  `https://ask-edgeorgie-mcp.vercel.app/mcp` (a genuine external network
  client, not stdio, not in-process). Full transcript committed at
  [`examples/http-transcript.json`](./examples/http-transcript.json). Real
  results:
  - `get_experience` → 3 roles (Mercado Libre, Vansa, Freelance), parsed
    verbatim from the live-deployed copy of `resume.txt`.
  - `get_projects` → all 3 artifacts (triage-desk, eval-lab, repoask-mcp)
    with their real metrics/URLs.
  - `ask_about_edgeorgie("What AI agent infrastructure has this person built
    in production?")` → `answerMode: deterministic` (no LLM key set in this
    deployment), top citation `resume.txt` — correctly
    surfaces the Mercado Libre agent-architecture bullet.
  - `ask_about_edgeorgie("What's the most technically interesting thing they
    shipped?")` → top citation `BUILD-LOG.md` lines 1-26 (score 0.09) —
    correctly surfaces the build-log entry point, whose body covers the
    repoask-mcp deployment debugging story cited elsewhere in the same
    answer's lower-ranked citations.
  - `ask_about_edgeorgie("What is their measured accuracy on the triage bot
    and what are its known failure modes?")` → citations include
    `RELIABILITY-REPORT.md` lines 63-92 and 168-187 (score 0.119/0.09) — the
    exact section with the real 83.3% triage-desk accuracy numbers and
    confusion-matrix failure modes.
  - `GET /api/experience`, `GET /api/projects`, `POST /api/ask` (the
    human-facing REST routes, same engine) also verified live and returning
    correct real data.
- Deployment protection fixes applied proactively (not re-discovered) from
  repoask-mcp's own deployment debugging history: explicit `builds`/`routes` in
  `vercel.json` (not `rewrites`), `.vercelignore` excluding `dist/`, and the
  `ssoProtection: null` PATCH — see "Deployment gotchas" above.

## Scope

- No biographical claim beyond what's in `resume.txt`.
- No project claim beyond what's already in each repo's public commit/PR
  history and `RELIABILITY-REPORT.md`; every number in `get_projects`'s
  output cites exactly where it came from.
- This repo does not modify `edgeorgie-portfolio` or `repoask-mcp` — wiring
  this server in as the portfolio's primary "ask an agent about me" CTA is a
  separate, follow-up workstream.

## License

MIT
