# Build log: triage-desk, eval-lab, repoask-mcp

*Posted 2026-10-09. Working notes from converting three side projects from "demo I click through" into "thing an agent or CI pipeline actually drives." Writing this the way I'd want to read it — including the parts that didn't work on the first try.*

I keep a progress log while I work (mostly for myself, partly so I don't quietly round a "mostly works" into a "it works"). This is the cleaned-up version of a few days from that log, for the three things I actually shipped: a webhook-triggered GitHub triage bot, an eval CLI/Action, and a fresh MCP server built off an older RAG side project. I'm not going to pretend any of this went in a straight line.

## Pinning repos doesn't have an API. At all.

First task was boring repo hygiene — archive 32 dead tutorial clones, pin the ones that matter. Archiving was easy, `gh repo archive`, done, verified `isArchived:true` on all 32. Pinning was not. I assumed this was a `gh` CLI gap and went looking for the right flag or a GraphQL mutation. There isn't one. I introspected the GraphQL schema's `mutationType.fields` directly — no `pinItem`, no `pinRepository`, nothing. The old REST endpoint (`PUT /user/pinned_repositories`) 404s. Repo pinning on GitHub is, as far as I can tell, a web-UI-only feature with zero programmatic path in 2026. That's a genuine surprise — I expected "I'm holding this wrong," not "this capability doesn't exist for anyone." I left a note for myself to just drag-and-drop pin the five that matter, instead of burning more time hunting for an API that isn't there.

## eval-lab's CLI was silently passing when it should have failed

eval-lab started as a browser-only eval demo. I pulled the engine out into a framework-agnostic CLI (`npx eval-lab run`) plus a GitHub Action, wired up a dogfood workflow that runs a passing baseline then a deliberately regressed prompt variant, and asserted the Action actually caught the regression. First version: it didn't catch anything. The CI job reported success on a config I'd broken on purpose.

The bug was a main-module guard: `import.meta.url === file://${argv[1]}` — a pattern meant to make the file both importable and runnable as a script. It works fine when you run `node cli/bin/eval-lab.mjs` directly. It silently fails when the file is invoked through the `npx` bin symlink, which is exactly how `action.yml` calls it. The comparison just never matched, so the whole CLI body never ran, and node happily exited 0 having done nothing. I only caught this because I later added `--exec` support and watched the CI run for *that* PR report green on a config I knew should fail — went back, ran `npx --no-install eval-lab` on the regressed config manually, confirmed it exited 0 with zero output. Fixed it with a realpath-resolved comparison instead of a raw string match, re-verified exit 1 three ways (direct node, manual symlink, npx). The unsettling part: this bug would have shipped silently in any CI pipeline using the Action as documented, exit code always 0, nobody the wiser. ([PR #22](https://github.com/edgeorgie/eval-lab/pull/22))

## NODE_ENV=production quietly deleted my build tools

Building the HTTP transport for repoask-mcp, `npm run build` started failing with `tsc: not found` — despite `typescript` sitting right there in `package.json`. Took a minute to realize why: this sandbox has `NODE_ENV=production` set globally, and `npm install` respects that by skipping devDependencies entirely, no warning, no error, just a smaller `node_modules` than I expected. Not a code bug, just an environment variable I didn't know was set, doing exactly what it's documented to do. `npm install --include=dev` fixed it. Filing this under "read your env before you blame your code."

## The MCP server's deployment wall: four providers, one wall — since resolved

Once the stdio-transport MCP server was working (ported retrieval logic from repoask: chunking, TF-IDF embedding swapped in for the browser's transformer-worker since there's no headless equivalent, vector scoring — real tests against octocat repos, 3/3 passing, a committed transcript of an actual MCP client session), I built a Streamable HTTP transport and a Vercel serverless wrapper so it could be reached over the network instead of only from a local process. Locally it worked — I ran a real `StreamableHTTPClientTransport` client against `localhost:3000/mcp`, got back real citations, committed the transcript.

Getting it *publicly* reachable is where I stalled for a while, and it's worth keeping the record of why. I went through Vercel, Railway, Render, and Fly in that order (Vercel first since I already have 8 apps live there). Every single one wanted an interactive login — OAuth through a logged-in browser session or a pre-existing access token — and I had neither bound to this environment. Vercel: no token, no `~/.vercel/auth.json`. Railway and Render: GitHub-OAuth-only signup, and the GitHub CLI token I have authorizes `gh`/git operations but can't complete a browser OAuth consent flow. Fly: same pattern, didn't bother going further once it was the third confirmation. For a stretch the README said plainly that remote deployment was pending a human doing one interactive login; the code (`vercel.json`, `api/mcp.ts`) was deploy-ready the whole time, so it was purely an access problem, not a code problem.

That gap is now closed. The login happened once, by hand, and Vercel's Git integration took over from there — the same push-to-deploy path my other apps use, so there's nothing interactive left in the loop. `repoask-mcp` is publicly reachable today: `GET https://repoask-mcp.vercel.app/` returns 200, and a `POST` to `https://repoask-mcp.vercel.app/mcp` with `Accept: application/json, text/event-stream` and a `tools/list` JSON-RPC body comes back as a real SSE `event: message` frame listing the `index_repo` tool with its full description and input schema. I re-checked both with `curl` rather than trusting the dashboard. The lesson I'm keeping is the unglamorous one: the blocker was never the code, and no amount of re-reading the code would have moved it.

## The heuristic triage bot is 83.3% accurate, and I know exactly where it breaks

The last piece worth writing up: I benchmarked triage-desk's fallback heuristic (the path that runs when no LLM key is configured) against 18 self-labeled synthetic issues. 83.3% (15/18) on both `kind` and `priority` classification, same three misses for both since they're coupled. I expected something cleaner. The actual confusion matrix is more interesting than the number: one issue titled "...or a bug?" got classified as a bug purely because the literal substring "bug" appears before the question-detection branch runs in the if/else chain — a rhetorical mention of the word outranks the actual question structure. A paraphrased duplicate issue was missed entirely by the Jaccard token-overlap duplicate detector, while a near-verbatim duplicate was caught — the detector is brittle to rewording, not just noise-sensitive. None of this is a "needs more training data" problem, it's a few lines of ordering and a weak similarity metric. Worth fixing, but the number and failure modes here are reported as measured, not rounded up. ([ACCURACY.md](https://github.com/edgeorgie/triage-desk/blob/main/ACCURACY.md), [PR #28](https://github.com/edgeorgie/triage-desk/pull/28))

## agentlens: tracing my own agents, with zero dependencies

The newest of these is `agentlens` ([repo](https://github.com/edgeorgie/agentlens)) — "zero-dependency tracing + waterfall visualizer for AI agent tool calls: latency, tokens, cost, nesting, errors." It came out of a plain annoyance: when a multi-step agent run goes wrong, I couldn't see *where*. Which tool call was slow, which one threw, what was nested under what. So I wrote the smallest thing that would answer that.

It's version 0.1.0 and it has no runtime dependencies at all — only two Node builtins, `node:async_hooks` and `node:crypto`, on Node 18+. `AsyncLocalStorage` is doing the interesting work: it's what lets a span know its own parent without me threading a context object through every function signature, and it's what makes concurrent sibling spans not leak into each other's parent. There are 5 tests and all 5 pass on a fresh clone (`tests 5 / pass 5 / fail 0`): nested spans getting the right parent/child via AsyncLocalStorage, a span whose fn throws recording error status and message without losing the rest of the trace, token and cost fields summing into trace totals, concurrent siblings not cross-contaminating parent context, and `renderHtml` producing self-contained HTML with no external references. CI is 6 GitHub Actions runs, all 6 `success`. The viewer is live at `https://agentlens-nine.vercel.app/` (200). `npm run demo` runs a small multi-step agent — plan -> search_docs -> read_doc x2 -> write_summary — where one of the read steps deliberately fails, because an error path you've never rendered is an error path you don't know renders.

Two limitations I'd rather state than have someone discover. First: agentlens does not call any LLM API and does not know any provider's pricing. Tokens and cost are optional fields the caller sets themselves via `setAttrs({ tokensIn, tokensOut, costUsd, model })`, and agentlens only sums what it's told — the demo's token numbers are stubbed and labeled as demo values, specifically so the demo costs nothing and needs no API key. If you want real cost, you supply real cost. Second: it is not published on the npm registry. Two separate reasons, not one — there are no npm credentials in this build environment (`npm whoami` returns `ENEEDAUTH`), and independently of that the name `agentlens` is already taken on npm by an unrelated package, so publishing would mean renaming to something like `@edgeorgie/agentlens`. Installing from GitHub works today: `npm install github:edgeorgie/agentlens`. It has 0 stars and no users I know of; it's a tool I built for myself and it hasn't been adopted by anyone.

## Why these three exist

triage-desk, eval-lab, and repoask-mcp are the same idea I keep coming back
to: tools and pipelines a model can drive directly, not just a human clicking
a UI. A webhook-triggered triage bot, a CI-gating eval harness, and an
MCP server all follow from that — each one is a different shape of "let an
agent act instead of a human."

---

Net state right now: triage-desk and eval-lab are both agent/CI-driven with
run evidence, cross-dogfooded (eval-lab gates triage-desk's own CI —
[triage-desk PR #27](https://github.com/edgeorgie/triage-desk/pull/27)), and
benchmarked rather than just demoed. repoask-mcp works end-to-end over both
stdio and HTTP, with an MCP-client transcript, and is now publicly deployed
and reachable from outside my own machine — `https://repoask-mcp.vercel.app/`
answers 200 and its `/mcp` endpoint returns a real `tools/list` response over
SSE, both re-verified with `curl`. That gap is closed. agentlens is the
newest and the least proven: 5/5 tests green, 6/6 CI runs green, a live
viewer, and no users — unpublished on npm, installable from GitHub only.
