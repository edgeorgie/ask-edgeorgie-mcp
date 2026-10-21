# Recruiter FAQ

*Direct, first-person answers to the questions recruiters and hiring managers actually ask that a resume or project README doesn't cover. These are Edwin's own answers, not generated or inferred — kept here so `ask_about_edgeorgie` can answer them directly instead of saying "I don't have that information" or redirecting elsewhere.*

## What's your biggest weakness / area you're actively working on?

I genuinely like working on a team — I'm not someone who prefers working alone by default. The honest pattern is more specific than that: when I hit a problem I find genuinely interesting, I get absorbed in solving it myself before thinking to loop others in. At Mercado Libre that's part of how I ended up individually owning 10+ initiatives end-to-end — real scope carried solo, which shows capability, but also shows I don't always pause to pull in another perspective when a problem has hooked me. I'm actively working on catching that earlier: noticing the pull to just keep solving it myself, and deliberately checking whether the team should be in the loop instead.

## Why are you looking to leave Mercado Libre / why are you job searching?

I've grown a lot at Mercado Libre — owned real scope, shipped production AI-agent workflows, worked across web/mobile/TV at LATAM scale. I'm looking for what's next because I want to keep compounding that growth in a wider AI/agent ecosystem than one company's internal tooling can expose me to: more surface area to learn from, more different problems and teams to grow alongside, not a step away from something that isn't working.

## Are you open to relocation? Do you need visa sponsorship?

Yes — open to relocation, and would need visa sponsorship for a role outside Colombia. Not a blocker on my end, just something to plan for upfront.

## What's your salary expectation?

Negotiable — I'd rather discuss this directly in conversation than quote a fixed number here, since it depends on role scope, location, and total compensation structure.

## What's your current location and work setup?

Barranquilla, Colombia. Currently fully remote at Mercado Libre (since November 2022). Comfortable with remote-first roles; open to relocating as noted above.

## What's your English level?

Professional/fluent. I handle meetings, code review, technical interviews and written async communication in English without friction — my day-to-day at Mercado Libre is a LATAM-scale org where English is normal working language for documentation and cross-team work. Spanish is my native language.

## What's your notice period / when could you start?

30 days.

## What timezone are you in, and how much do you overlap with US teams?

UTC-5 (Colombia, no daylight saving). That's full overlap with US East and a solid working overlap with the West Coast. I'm flexible on hours and happy to shift my day toward the team's timezone — I've worked remote-first since 2022, so async-heavy collaboration is normal for me, not an adjustment.

## What's your biggest professional failure?

The first monetization feature I took to production at Mercado Libre. Monetization is about as unforgiving as scope gets — a bug there doesn't degrade an experience, it stops revenue — and mine had one. It blocked monetization for roughly two weeks before it was fully resolved. I diagnosed it and shipped the fix myself.

What I took from it: on revenue-critical paths, "it works in staging" is not evidence. The failure mode wasn't in the happy path I'd tested, it was in a real-money edge case I hadn't thought to construct. It's a big part of why my side projects now lean so hard on measured evidence and mutation-tested guards rather than a passing demo — I'd rather find out from a test than from two weeks of lost revenue.

## Have you fine-tuned an LLM, or do you use APIs?

APIs, prompting, RAG and evals — not fine-tuning. I want to be precise about that rather than let "AI engineer" imply model training: my depth is in the layer around the model. Retrieval and chunking (`repoask`, `repoask-mcp`, this server), eval harnesses that gate CI (`eval-lab`), tracing agent tool calls (`agentlens`), and cost-governed agent loops (`budget-keeper`). Fine-tuning is a gap I can state plainly; the harness engineering is where I've actually shipped.

## What's your experience with Rust?

None. I haven't shipped Rust and I'm not going to claim otherwise. My depth is TypeScript/JavaScript, with production Kotlin and Swift at Mercado Libre that I picked up on the job — which is the honest evidence that I ramp on a new language when a role needs it.

## Have you been on call for production incidents?

Yes — formal on-call rotation at Mercado Libre with real incidents, not just office-hours support. That's also where my SRE practice comes from: Kibana, New Relic, Datadog, Grafana, and working against defined SLA/SLI/SLOs rather than ad-hoc firefighting.

## What's your experience with Kubernetes, Docker and infrastructure?

Straight answer: Docker yes, Kubernetes not really. I'm comfortable with containers in my own workflow and projects. At Mercado Libre, deployment and orchestration run on internal platform tooling, so I consume that platform rather than designing or operating clusters myself — I'd be learning Kubernetes properly on the job, not arriving with production depth in it. My production depth is application-level: full-stack and cross-platform work, plus the reliability/observability side above.

## What does "agent-native software" mean to you?

It means an agent is a real user of the thing, not an afterthought bolted onto a human UI. I've been building this way since the first models that were actually good enough to build on — at Mercado Libre on production agent workflows, and in my own projects to try things I couldn't try at work.

Three things I've landed on:

**The harness matters more than the prompt.** Most of the real engineering is the control architecture around the model: which tools exist, what the agent is allowed to do, where failures get caught, how output gets verified before anyone trusts it. Prompts are the easy part, and the part people obsess over.

**If an agent says something, you should be able to check it.** My retrieval tools hand back citations with exact file and line ranges instead of prose. `get_projects` has a required `limitations` field, so whoever calls it gets the caveats they couldn't have guessed — not a highlight reel. I'd rather ship a tool that admits what it doesn't know than one that just sounds confident.

**One engine, two audiences.** The same code powers the MCP tool and the human web UI. If a capability only lives behind a chat box, it isn't agent-native. If it only lives in a UI, an agent can't touch it at all.

## Do you have the agent/MCP projects (triage-desk, eval-lab, repoask-mcp, ask-edgeorgie-mcp, agentlens, crispy-profiling, simplescope) doing something besides AI/agents?

Yes — my production experience at Mercado Libre is full-stack and cross-platform (web, mobile WebViews, smart TV receivers for LG/Samsung/Vidaa/TitanOS), with real SRE practice (Kibana/NewRelic/Datadog/Grafana, SLA/SLI/SLO) and Clean Architecture/DDD on legacy refactors — not just an AI-agent specialist footnote. The agent/MCP side projects are a deliberate specialty built on top of that general engineering foundation, not a replacement for it.

## What is agentlens, and what can't it do?

agentlens (https://github.com/edgeorgie/agentlens) is my zero-dependency tracing and waterfall visualizer for AI agent tool calls — latency, tokens, cost, nesting, errors. Version 0.1.0, no runtime dependencies, just the Node builtins `node:async_hooks` (AsyncLocalStorage, which is how spans know their parent) and `node:crypto`, on Node 18+. 5/5 tests pass on a fresh clone, 6/6 GitHub Actions runs are green, and the viewer is live at https://agentlens-nine.vercel.app/. `npm run demo` traces a multi-step agent (plan -> search_docs -> read_doc x2 -> write_summary) with one read step failing on purpose so the error path is actually exercised.

What it can't do, stated upfront: it does not call any LLM API and doesn't know any provider's pricing — tokens and cost are optional fields you set yourself via `setAttrs({ tokensIn, tokensOut, costUsd, model })` and agentlens only sums what you tell it, so the demo's token numbers are stubbed demo values (that's deliberate, it keeps the demo free and key-less). It's also not on the npm registry: there are no npm credentials in my build environment (`npm whoami` returns ENEEDAUTH), and separately the name `agentlens` is already taken on npm by an unrelated package, so publishing means renaming to something like `@edgeorgie/agentlens`. `npm install github:edgeorgie/agentlens` works today. It has 0 stars and no users — I built it for my own debugging, not for an audience.

## What's your core technical stack, and how comfortable are you picking up a new one?

JavaScript/TypeScript is my core expertise — that's where I'm deepest and fastest. I don't shy away from new stacks though: at Mercado Libre I did AI-assisted native development in Kotlin (Android) and Swift (iOS) alongside the web work, picking both up on the job rather than coming in already fluent. I'm self-taught by background — I hold an Electronic Engineering degree alongside Software Development, and most of what I know about AI/agentic systems specifically I taught myself outside of any formal course.

## Do you design, or just build to someone else's design?

Both. UX and interaction design are something I actively work on, not just hand off — the projects I've shipped (this portfolio included) are my own design decisions, not a template. I care about how something feels to use, not just whether the API underneath is correct.

## What do you do outside of work?

A few real things, not just a hobbies line for the sake of one: I play video games, but I also build them — at 15 I built and shipped a 2D platformer on my own, which got about 50 downloads. I'm now teaching myself game development and design in Unreal Engine (5.8.3) as a self-directed project, same self-taught approach I bring to engineering generally. I'm also learning to play guitar. I go to the gym 4 mornings a week — I'm a morning person, prefer getting trained and moving early in the day over doing it later.

