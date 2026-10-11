/**
 * Human-facing REST route: POST /api/ask { question, topK? } — same engine
 * as the ask_about_edgeorgie MCP tool (src/engine.ts doAskAboutEdgeorgie).
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { doAskAboutEdgeorgie } from "../src/engine.js";
import { checkRateLimit, getClientId, checkQuestionLength } from "../src/rate-limit.js";
import { capture, questionAskedProperties } from "../src/analytics.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed: use POST." });
    return;
  }
  const callerId = getClientId(req as unknown as { headers: Record<string, unknown>; socket?: { remoteAddress?: string } });
  const limit = checkRateLimit(callerId);
  if (!limit.allowed) {
    await capture("rate_limited", { surface: "web", reason: limit.reason === "global" ? "global" : "per-caller" });
    res.setHeader("Retry-After", String(limit.retryAfterSeconds ?? 60));
    res.status(429).json({
      error: `Rate limit exceeded (${limit.reason === "global" ? "global" : "per-caller"} limit). Retry after ${limit.retryAfterSeconds}s.`,
    });
    return;
  }
  try {
    const body = (req.body ?? {}) as { question?: string; topK?: number };
    if (!body.question || body.question.trim().length < 3) {
      res.status(400).json({ error: "Missing or too-short 'question' field." });
      return;
    }
    // The engine enforces this too (it is the shared chokepoint for every
    // transport), but it signals the failure by throwing, which this handler
    // would map to a 500. Checking here first keeps an oversized question a
    // client error — 413 — rather than reporting the server as broken.
    const lengthCheck = checkQuestionLength(body.question);
    if (!lengthCheck.ok) {
      res.status(413).json({ error: lengthCheck.error });
      return;
    }
    const startedAt = Date.now();
    const result = await doAskAboutEdgeorgie(body.question, body.topK);
    // Awaited before the response is written: Vercel may freeze the function
    // as soon as the response ends, so a capture started afterwards can be
    // lost. A no-op without POSTHOG_KEY, and it never throws (src/analytics.ts).
    await capture(
      "question_asked",
      questionAskedProperties("web", body.question.length, result, Date.now() - startedAt),
    );
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
