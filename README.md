# ask-edgeorgie-mcp

> Don't read my resume. **Ask it a question.**

A public [MCP](https://modelcontextprotocol.io) server for **Edwin Jorge**
([edgeorgie](https://github.com/edgeorgie)). Point Claude Desktop, Cursor, or any
MCP client at this URL to ask about my work experience, shipped projects, and
skills — answers are **grounded and cited** against my resume and project
history.

**Live URL:** `https://ask-edgeorgie-mcp.vercel.app/mcp` — the MCP Streamable
HTTP endpoint on `POST`, and the JSON health check on `GET` (also reachable at
`/api/mcp`). The bare root `https://ask-edgeorgie-mcp.vercel.app/` serves the
human-facing HTML landing page, not JSON. There is no `/health` route.

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
| `get_projects` | Returns the 6 real shipped artifacts ([triage-desk](https://github.com/edgeorgie/triage-desk), [eval-lab](https://github.com/edgeorgie/eval-lab), [repoask-mcp](https://github.com/edgeorgie/repoask-mcp), [crispy-profiling](https://github.com/edgeorgie/crispy-profiling), [simplescope](https://github.com/edgeorgie/simplescope), [agentlens](https://github.com/edgeorgie/agentlens)) with their real measured metrics and PR/commit/run URLs, plus a `limitations` array on any project with caveats a caller could not infer from its metrics (not on a registry, no adoption, a capability it deliberately lacks). |
| `get_story` | Returns my background as a structured chronological timeline (year, label, detail) rather than prose, so a client can render it as a real timeline instead of a paragraph. Same beats as the portfolio's "Beyond the code" section, kept in sync deliberately. This one is editorial copy maintained in `src/engine.ts`, not retrieval — it returns no file+line citations, and its `source` field says so. Use `ask_about_edgeorgie` when you need a citation. |
| `ask_about_edgeorgie` | Retrieval-based Q&A. TF-IDF search over a corpus built from `resume.txt`, `RELIABILITY-REPORT.md`, `BUILD-LOG.md` and `RECRUITER-FAQ.md` (public evidence only). Every answer cites the exact source file + line range it came from. If no LLM key is set, the response is a deterministic citation dump (no generation at all) and `answerMode` is `deterministic`; if `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set, a model synthesizes prose but is instructed to ground every sentence in the retrieved excerpts and cite them inline — it never answers beyond what's indexed. If a key is set but the provider call fails, `answerMode` is `synthesis-failed` and `llmKeyConfigured` is `true`, so the fallback is never misreported as a missing key. |

## Rate limiting

`/mcp` and `/api/ask` are public and unauthenticated, and an
`ANTHROPIC_API_KEY` **is** configured on the live deployment — a measured
`POST /api/ask` returns `answerMode: "llm"`, model `claude-haiku-4-5`, so
every anonymous request bills my own Anthropic account. Three controls apply
(`src/rate-limit.ts`):

- **Per-caller sliding window:** 10 requests/minute per IP (best-effort, via
  `X-Forwarded-For`/socket address).
- **Process-wide ceiling:** 60 requests/minute total within a single
  instance, regardless of caller identity. Note "process-wide," not
  "global" — see the measured limitation below.
- **Question-length cap:** 2000 characters. Request-count limits alone do
  not bound spend, because the question goes into the prompt verbatim: one
  accepted request can carry an arbitrary input-token bill. Before this cap
  existed, a single 19,500-character question was accepted and answered.
  Enforced in `src/engine.ts` so it covers REST, `/mcp` and stdio alike;
  `/api/ask` additionally maps it to `413` so an oversized question reads as
  a client error rather than a server fault.

Exceeding either rate limit returns `429` with a `Retry-After` header
(seconds); an over-length question returns `413`.

`/api/experience`, `/api/projects` and `/api/story` are deliberately **not**
rate limited: each returns a compile-time constant or a single parsed local
file — no retrieval, no provider call — so there is no per-request cost worth
metering. That decision is recorded in each route's header comment; add a
limiter the moment one of them starts doing real work.

**Measured limitation — don't read these limits as a spend cap.** The window
is a plain in-memory `Map`, and concurrency largely defeats it: 40
simultaneous POSTs from one IP, no header manipulation, returned **36×200 /
4×429** — 36 billable calls against a documented ceiling of 10. Vercel
allocates instances in response to parallelism and each starts with an empty
Map. The limits do bind a *sequential* caller exactly as configured (14 in a
loop → 10×200 then 4×429), which is what they really control. Cold starts
also reset the counters, but that is the lesser issue; plain parallelism needs
no timing games. Forged `X-Forwarded-For` values are **not** the bypass —
Vercel's edge sets that header and the platform value is what this code
observes. The real hard ceiling belongs at the billing layer (an Anthropic
spend limit on the key); closing the concurrency hole properly needs a
distributed store (Upstash Redis / Vercel KV, `INCR` + TTL). See the comment
block at the top of `src/rate-limit.ts` for the full rationale.

## Environment variables

None are required: a clean checkout answers in deterministic retrieval mode,
which is what CI asserts. Every variable below is optional.

| Variable | Effect when set |
|---|---|
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | Turns on LLM synthesis in `ask_about_edgeorgie` (`answerMode: "llm"`). Billed to the key's owner, so read "Rate limiting" above first. `ANTHROPIC_MODEL` / `OPENAI_MODEL` override the provider's default model; `ANTHROPIC_WORKSPACE_ID` is needed by org-scoped Anthropic keys. |
| `POSTHOG_KEY` | Turns on server-side product analytics (`src/analytics.ts`, via [posthog-node](https://github.com/PostHog/posthog-js/tree/main/packages/node)). Unset, the facade is a complete no-op: no client is created, no request leaves the function, nothing is logged. Set it in the Vercel project's environment variables to start recording. |
| `PORT` | Listen port for the standalone Streamable HTTP server (`npm run start:http`); default 3000. Not used on Vercel. |

### What analytics records, and what it never sends

Three events, each with `app: "ask-edgeorgie-mcp"` and a fresh random
`distinctId` per event (no person profile, no cookies, nothing linking two
requests):

- `question_asked`: `surface` (`web` for `POST /api/ask`, `mcp` for the
  `ask_about_edgeorgie` tool), `mode` (the `answerMode` enum), `cited`
  (boolean), `citations` (count), `latency_ms` (engine time, retrieval plus
  any provider call) and `length_bucket` of the question: `<40`, `40-120`,
  `120-300` or `300+`.
- `mcp_tool_called`: `tool`, for each of the four MCP tools.
- `rate_limited`: `surface` and `reason` (`per-caller` or `global`) whenever
  the limiter rejects a request.

Never sent: the question, the answer, citation text, caller IPs, emails or
names. Only buckets, counts, booleans, durations and enums leave the server,
and `tests/analytics.test.ts` asserts that shape. Each capture is awaited
before the response is written, because a serverless function may be frozen
as soon as its response ends; the client makes one attempt with a short
timeout, so an analytics outage costs at most that timeout and never changes
a response. The static web UI in `public/` ships no browser analytics; its
usage is visible through the `surface: "web"` events above.

## The corpus

The retrieval corpus is a direct copy of files that already existed
before this repo, with no new biographical or project claims invented:

- `resume.txt` — the actual resume.
- `RELIABILITY-REPORT.md` — measured pass-rate/latency/accuracy numbers for
  eval-lab and triage-desk.
- `BUILD-LOG.md` — a first-person account of the real debugging episodes
  (including this project's own Vercel deployment fix, documented below).
- `RECRUITER-FAQ.md` — the candidate's own first-person answers to questions
  recruiters actually ask (why job-searching, relocation, salary stance).

The authoritative list is `CORPUS_FILES` in `src/corpus.ts`;
`tests/corpus-list.test.ts` asserts the bullet list above and that constant
agree, because this list silently went stale once already when a fourth file
was added.

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
- `api/experience.ts`, `api/projects.ts`, `api/story.ts`, `api/ask.ts` — thin REST routes that
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
   `api/projects.ts`, `api/story.ts`, `api/ask.ts`, and `public/**` directly, with `dist/`
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

- `npm test` passes the whole suite (exact count stated once below, derived
  from the real suite by `tests/readme-test-claims.test.ts`): `tests/server.test.ts` spins
  up the **compiled** server as a real subprocess and drives it with a real
  `@modelcontextprotocol/sdk` `Client` over stdio (`list_tools` shape, the
  health-check tool list matching the tools actually registered,
  `get_experience` structural check incl. Mercado Libre, `get_projects`
  returns every artifact the engine advertises (set equality, derived at
  runtime — not a hardcoded count), `get_story` returns a chronological timeline
  rather than prose, `ask_about_edgeorgie` grounds an MCP-related question in a
  real citation, and an unrelated/nonsense question correctly stays in
  deterministic/no-fabrication mode); `tests/health-endpoints.test.ts`
  asserts on the **actual runtime responses** of `api/mcp.ts`'s GET handler
  and of `src/http-server.ts` served over a real loopback socket, compared
  against what `listTools()` really returns — so advertising fewer tools than
  are registered fails for any array whose value is the same in every
  environment, literal or computed (a source-text lint alone misses e.g.
  `[...].slice(0, 3)`); it does not catch a deliberately
  environment-conditional array, which no single-environment assertion can,
  plus `GET /api/story`
  200/405 coverage; `tests/llm-fallback-cause.test.ts` pins "no LLM key
  configured" apart from "a key is configured but synthesis failed" in both
  the `answerMode` value and the user-visible answer text;
  `tests/rate-limit.test.ts` covers the
  per-caller window, the global ceiling and `Retry-After`;
  `tests/llm-prompt-injection.test.ts` covers prompt spotlighting and
  delimiter-forgery sanitization of retrieved content;
  `tests/typecheck-coverage.test.ts` asserts every tracked `.ts` file is
  reached by one of the two tsconfigs, so a new directory of TypeScript
  cannot arrive unchecked (see the typecheck note below);
  `tests/analytics.test.ts` asserts the analytics facade is inert without
  `POSTHOG_KEY` (no request, no console output), swallows a failed send when
  a key is set, and builds `question_asked` from counts and buckets only;
  `tests/external-metric-claims.test.ts` guards the one claim class the other
  guards structurally cannot (see below).
- **The guard class that could not be derived locally.** Every other guard here
  works by calling the real authority — `CORPUS_FILES`, `doGetProjects()`,
  `listTools()`, the actual tsconfig program — and asserting prose matches. One
  claim has no local authority: `crispy-profiling`'s npm download total is a
  fact about a third party's live state, and it is a cumulative counter, so it
  goes stale by simply existing. It did — this repo served **754** to agents and
  readers while npm reported **1266**, a 68% understatement, with `tsc`, the
  build, the deploy check and all 62 tests green. The response is split by what
  each half can actually prove offline:
  [`tests/external-metric-claims.test.ts`](tests/external-metric-claims.test.ts)
  asserts the agent-facing (`get_projects`) and reader-facing (`data/BUILD-LOG.md`)
  copies state the *same* figure and that it carries an `as of <date>` — an
  undated cumulative number cannot be judged by a reader at all — while
  [`scripts/check-external-metrics.ts`](scripts/check-external-metrics.ts)
  (`npm run check:external`) queries npm and GitHub for real and runs on a
  schedule, not in the PR suite, so a third party being unreachable never fails
  an unrelated PR. It exits 2 rather than 0 when a source cannot be reached,
  because "could not check" is not "nothing changed".
  Both of those guards were first shipped broken and were fixed only because
  a cold read tried to defeat them: the checker reported "all claims accurate"
  when a claim had merely been *reworded* past its regex (a missing claim is
  now `exit 2`, "could not check"), its stars pattern read `1,000` as `000`,
  and the dated-figure test's own pre-filter never matched the string it named
  as the regression, so it asserted `[] === []` and judged nothing.
  [`scripts/mutation-battery.sh`](scripts/mutation-battery.sh) is the result:
  it reintroduces each of those defeats in turn and fails if the guard does
  not. It also fails if a mutation did not *apply* — a `sed` that silently
  matches nothing scores as a guard passing when the guard was never
  exercised, which is the same false comfort one level up.
- The suite is **15 test files**. That sentence is the only count this README
  states, and [`tests/readme-test-claims.test.ts`](tests/readme-test-claims.test.ts)
  derives the number from the real suite and asserts it matches. The previous
  wording claimed "28/28 passing across six files" long after the suite had
  grown past it: a hand-maintained mirror of something the code already knows,
  in prose, where no compiler or test was looking. The README is this repo's
  evidence surface, so a reader who checks the one number they can cheaply
  verify and finds it wrong has good reason to discount the measured numbers
  that are right.
  A *test* count is deliberately not stated: one test in
  `tests/corpus-list.test.ts` is declared inside a loop over the two committed
  transcripts, so no count derived from source is exact, and the same guard
  fails if a total reappears in the prose. Run `npm test` for the real figure.
- CI (`.github/workflows/ci.yml`) runs install → typecheck (`tsc --noEmit`) →
  typecheck api/tests/examples (`tsc -p tsconfig.check.json`) → build →
  `npm test` → production-dependency audit on every push to `main` and every
  pull request, with no secrets provided to any step, so the suite is held to
  passing in deterministic mode on a clean checkout.
- **Why there are two typecheck steps, and why that is not redundant.**
  `tsconfig.json`'s `include` is `src/**/*.ts`, because src/ is what the build
  emits to `dist/`. A consequence nobody intended: `tsc --noEmit` covered none
  of `api/`, `tests/` or `examples/`, and `tsx` strips types without checking
  them, so the suite could not notice either. Measured rather than assumed — a
  type error planted in `api/projects.ts` left `tsc --noEmit` at exit 0,
  `npm run build` at exit 0 and the full suite green. `api/` is the worst place
  for that: those five files are the deployed Vercel serverless functions, so
  the production request handlers were the repo's least-checked code.
  `tsconfig.check.json` extends the build config and adds all three
  directories; the same planted error gives exit 2.
  Its `include` is still a hand-maintained list, so
  `tests/typecheck-coverage.test.ts` derives the real file set by walking the
  repo from the root with an *exclusion* list and asserts every tracked `.ts`
  file is matched by one of the two configs — a new source directory therefore
  fails CI instead of arriving silently unchecked.
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

Full real transcript (`list_tools` plus `get_experience`, `get_projects` and
3 `ask_about_edgeorgie` questions, exact JSON-RPC-level request/response):
[`examples/transcript.json`](./examples/transcript.json). Note the committed
transcripts predate `get_story` and do not exercise it — the tools they do
cover are listed above, and `get_story`'s REST + MCP surface is covered by
`tests/health-endpoints.test.ts` and `tests/server.test.ts` instead.

## Remote deployment status

**LIVE.** Deployed to Vercel (new project, GitHub-integration-linked to this
repo, same account already used for the other 8 live demos/repoask-mcp).

- Health check, bare unauthenticated `curl`, zero Vercel session/cookie:
  `curl https://ask-edgeorgie-mcp.vercel.app/mcp` → real 200
  `application/json`
  (`{"name":"ask-edgeorgie-mcp", ..., "tools":["get_experience","get_projects","get_story","ask_about_edgeorgie"], "status":"ok"}`),
  **no SSO redirect** — the project's `ssoProtection` was `PATCH`ed to `null`
  via `https://api.vercel.com/v9/projects/ask-edgeorgie-mcp` immediately after
  the first deploy (same fix already proven for repoask-mcp), confirmed by a
  fresh deployment-protection check before this was written up. The bare root
  `/` is routed to the static landing page by `vercel.json` and returns
  `text/html`; `/mcp` (or `/api/mcp`) is the route that returns the JSON.
- `POST /mcp` `tools/list` over the real public internet → correct 4-tool
  schema (`get_experience`, `get_projects`, `get_story`, `ask_about_edgeorgie`).
- Ran `examples/run-session.ts` with the real `@modelcontextprotocol/sdk`
  `Client` + `StreamableHTTPClientTransport` against
  `https://ask-edgeorgie-mcp.vercel.app/mcp` (a genuine external network
  client, not stdio, not in-process). Full transcript committed at
  [`examples/http-transcript.json`](./examples/http-transcript.json). Real
  results:
  - `get_experience` → 3 roles (Mercado Libre, Vansa, Freelance), parsed
    verbatim from the live-deployed copy of `resume.txt`.
  - `get_projects` → all 6 artifacts (triage-desk, eval-lab, repoask-mcp,
    crispy-profiling, simplescope, agentlens) with their real metrics/URLs.
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
  - `GET /api/experience`, `GET /api/projects`, `GET /api/story`,
    `POST /api/ask` (the human-facing REST routes, same engine) also verified
    live and returning correct real data.
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
