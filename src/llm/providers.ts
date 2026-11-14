/**
 * Provider transport for answer synthesis: one function per provider, each
 * with a hard timeout, and one error type that classifies every failure.
 *
 * Why the classification exists. The previous version threw
 * `new Error(\`Anthropic API error ${status}: ${body}\`)` and the engine pasted
 * that message into the public answer. When the production key went bad, every
 * visitor of the portfolio's "Ask" terminal was shown the raw provider body —
 * `{"type":"error","error":{"type":"authentication_error","message":"invalid
 * x-api-key"},"request_id":"req_…"}` — as the first line of the answer. Nothing
 * was logged server-side either, so the only place the failure was visible was
 * in front of the people it should have been hidden from.
 *
 * Now the provider body and request id go to the function log (console.error,
 * which Vercel keeps), and callers only ever see a `SynthesisReason` enum.
 */

export type ProviderName = "anthropic" | "openai";

/**
 * Why synthesis failed, without any provider text. Safe to return to clients:
 *   auth           -> the key was rejected (401/403). Rotate it.
 *   rate_limited   -> provider 429 / overloaded 529.
 *   timeout        -> no response within PROVIDER_TIMEOUT_MS.
 *   network        -> the request never got a response (DNS, reset, ...).
 *   provider_error -> any other non-2xx status.
 *   empty_response -> 2xx but no text in the body.
 */
export type SynthesisReason = "auth" | "rate_limited" | "timeout" | "network" | "provider_error" | "empty_response";

export const SYNTHESIS_REASONS: readonly SynthesisReason[] = [
  "auth",
  "rate_limited",
  "timeout",
  "network",
  "provider_error",
  "empty_response",
];

export class SynthesisError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly reason: SynthesisReason,
    /** Server-side detail only (status, provider body, request id). Never send to a client. */
    readonly detail: string,
  ) {
    super(`${provider} synthesis failed: ${reason}`);
    this.name = "SynthesisError";
  }
}

export interface ProviderAnswer {
  answer: string;
  provider: ProviderName;
  model: string;
}

export interface ProviderRequest {
  system: string;
  prompt: string;
}

/**
 * Hard ceiling per provider call. The portfolio's proxy gives up on this
 * service after 15s, so a provider that hangs must fail well before that, with
 * time left to return the citation fallback instead of a gateway timeout.
 */
export const PROVIDER_TIMEOUT_MS = 9_000;

const MAX_TOKENS = 700;

export function statusToReason(status: number): SynthesisReason {
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || status === 529) return "rate_limited";
  return "provider_error";
}

/** Maps a thrown fetch error (abort, DNS, reset) to a reason. */
function transportError(provider: ProviderName, err: unknown): SynthesisError {
  const e = err as Error;
  const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
  return new SynthesisError(provider, timedOut ? "timeout" : "network", `${e?.name ?? "Error"}: ${e?.message ?? String(err)}`);
}

async function post(provider: ProviderName, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (err) {
    throw transportError(provider, err);
  }
  if (!res.ok) {
    const requestId = res.headers.get("request-id") ?? res.headers.get("x-request-id") ?? "n/a";
    const text = await res.text().catch(() => "");
    throw new SynthesisError(provider, statusToReason(res.status), `HTTP ${res.status} (request-id ${requestId}): ${text.slice(0, 500)}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new SynthesisError(provider, "provider_error", `unparseable JSON body: ${(err as Error).message}`);
  }
}

function requireText(provider: ProviderName, text: string | undefined): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) throw new SynthesisError(provider, "empty_response", "2xx response with no text content");
  return trimmed;
}

export async function callAnthropic(apiKey: string, req: ProviderRequest): Promise<ProviderAnswer> {
  const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  const data = (await post(
    "anthropic",
    "https://api.anthropic.com/v1/messages",
    {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Org-scoped API keys (not scoped to a single workspace) are rejected
      // with a 400 unless this header names the workspace. Harmless to omit
      // for a workspace-scoped key.
      ...(workspaceId ? { "anthropic-workspace-id": workspaceId } : {}),
    },
    {
      model,
      max_tokens: MAX_TOKENS,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
    },
  )) as { content?: { type: string; text?: string }[] };
  const text = data.content?.find((b) => b.type === "text")?.text;
  return { answer: requireText("anthropic", text), provider: "anthropic", model };
}

export async function callOpenAI(apiKey: string, req: ProviderRequest): Promise<ProviderAnswer> {
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const data = (await post(
    "openai",
    "https://api.openai.com/v1/chat/completions",
    { authorization: `Bearer ${apiKey}` },
    {
      model,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
    },
  )) as { choices?: { message?: { content?: string } }[] };
  return { answer: requireText("openai", data.choices?.[0]?.message?.content), provider: "openai", model };
}

export interface ConfiguredProvider {
  name: ProviderName;
  call: (req: ProviderRequest) => Promise<ProviderAnswer>;
}

/**
 * Providers with a key present, in preference order. With both keys set,
 * OpenAI is a real fallback when Anthropic fails instead of dead code: before
 * this, an Anthropic failure skipped straight to the citation dump even if an
 * OpenAI key was configured.
 */
export function configuredProviders(env: NodeJS.ProcessEnv = process.env): ConfiguredProvider[] {
  const out: ConfiguredProvider[] = [];
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  const openaiKey = env.OPENAI_API_KEY?.trim();
  if (anthropicKey) out.push({ name: "anthropic", call: (r) => callAnthropic(anthropicKey, r) });
  if (openaiKey) out.push({ name: "openai", call: (r) => callOpenAI(openaiKey, r) });
  return out;
}
