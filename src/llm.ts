/**
 * Optional LLM answer synthesis — public entry point. Everything outside src/llm/
 * imports from here.
 *
 *   src/llm/prompt.ts     system prompt + spotlighted user prompt (prompt-injection defense)
 *   src/llm/providers.ts  Anthropic / OpenAI transport, timeouts, failure classification
 *   src/llm/fallback.ts   the citation-only answer used when no model writes one
 *
 * Contract: if no provider key is set, `synthesize` returns null and the caller
 * answers deterministically (same "no key required" contract as repoask and
 * triage-desk). If keys are set, providers are tried in order; if every one
 * fails, `synthesize` throws a `SynthesisError` whose `reason` is safe to show
 * and whose `detail` is only ever logged.
 */
import type { Chunk } from "@edgeorgie/retrieval-core";
import { buildSpotlightedPrompt, SPOTLIGHTED_SYSTEM_PROMPT } from "./llm/prompt.js";
import { configuredProviders, SynthesisError, type ProviderName } from "./llm/providers.js";

export {
  buildSpotlightedPrompt,
  sanitizeRetrievedText,
  SPOTLIGHTED_SYSTEM_PROMPT,
  SPOTLIGHT_SYSTEM_INSTRUCTION,
  IDENTITY_AND_SCOPE_INSTRUCTION,
} from "./llm/prompt.js";
export { SynthesisError, SYNTHESIS_REASONS, PROVIDER_TIMEOUT_MS, type SynthesisReason } from "./llm/providers.js";
export { deterministicAnswer, type FallbackCause } from "./llm/fallback.js";

export interface SynthesisResult {
  answer: string;
  provider: ProviderName;
  model: string;
}

export async function synthesize(question: string, repoLabel: string, chunks: Chunk[]): Promise<SynthesisResult | null> {
  const providers = configuredProviders();
  if (providers.length === 0) return null;

  const request = { system: SPOTLIGHTED_SYSTEM_PROMPT, prompt: buildSpotlightedPrompt(question, repoLabel, chunks) };
  let lastError: SynthesisError | undefined;
  for (const provider of providers) {
    try {
      return await provider.call(request);
    } catch (err) {
      lastError =
        err instanceof SynthesisError ? err : new SynthesisError(provider.name, "provider_error", (err as Error)?.message ?? String(err));
      // The only place provider detail goes: the function log. One line, so
      // it is greppable in Vercel's runtime logs ("[llm] anthropic auth").
      console.error(`[llm] ${lastError.provider} ${lastError.reason}: ${lastError.detail}`);
    }
  }
  throw lastError;
}

/** True when at least one LLM provider key is present in the environment. */
export function hasLlmKey(): boolean {
  return configuredProviders().length > 0;
}
