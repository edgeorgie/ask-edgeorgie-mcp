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

## Have you been on call for production incidents?

Yes — formal on-call rotation at Mercado Libre with real incidents, not just office-hours support. That's also where my SRE practice comes from: Kibana, New Relic, Datadog, Grafana, and working against defined SLA/SLI/SLOs rather than ad-hoc firefighting.

## What's your experience with Kubernetes, Docker and infrastructure?

Straight answer: Docker yes, Kubernetes not really. I'm comfortable with containers in my own workflow and projects. At Mercado Libre, deployment and orchestration run on internal platform tooling, so I consume that platform rather than designing or operating clusters myself — I'd be learning Kubernetes properly on the job, not arriving with production depth in it. My production depth is application-level: full-stack and cross-platform work, plus the reliability/observability side above.

## What does "agent-native software" mean to you?

<!-- DRAFT — Edwin to review and rewrite in his own words. Captured from a
     voice note and reconstructed, so the phrasing is the assistant's, not
     his. The substance (early adoption since the first capable models,
     harness/control architecture, extracting maximum leverage) is his. -->

Software designed so an agent is a first-class user, not a human-only UI with an API bolted on. Concretely, three things I keep coming back to:

1. **The harness is the product.** The interesting engineering is rarely the prompt — it's the control architecture around the model: what tools exist, what the agent is allowed to do, how failures are caught, how output gets verified. I've been building that kind of scaffolding since capable models first shipped, both at Mercado Libre on production agent workflows and in my own projects.
2. **Every claim an agent makes should be checkable.** That's why my projects return citations with exact file and line ranges instead of prose, and why `get_projects` ships a mandatory `limitations` field — an agent consuming it gets the caveats it could not infer, not just the highlights.
3. **Dual-audience by default.** The same engine serves the MCP tool and the human web UI. If a capability only exists behind a chat box, it isn't agent-native; if it only exists in a UI, an agent can't use it at all.

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

