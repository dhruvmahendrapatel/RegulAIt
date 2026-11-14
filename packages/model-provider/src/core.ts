/**
 * Runtime pieces shared by every adapter file in this package: the error type, the
 * model deadline (AER-021), the usage helpers (ADR-0212, ADR-0173 2c, ADR-0175 A4)
 * and the dispatch defaults. They live here, not in `index.ts`, so adapter modules
 * (`google-ai-sdk.ts`, `ai-sdk-bridge.ts`) can import them without an import cycle
 * through the package entry point. `index.ts` re-exports all of it unchanged.
 */

export const GOOGLE_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** ADR-0034: the ORIGINAL failure, preserved. The SDKs flatten a transport
     * failure to "Connection error.", which would turn an egress-guard refusal
     * (a governance decision) into an opaque network blip. Callers walk this
     * chain to report the real reason. */
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** ADR-0212: image/audio token counts out of a provider's usage block (structurally the shared type) */
export interface ModalityTokenCounts {
  image?: { inputTokens: number; outputTokens: number };
  audio?: { inputTokens: number; outputTokens: number };
}

const positiveCount = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);

/** spread into `usage`: `{ modality }` only when some image or audio count is positive */
function modalityUsage(m: ModalityTokenCounts): { modality?: ModalityTokenCounts } {
  const out: ModalityTokenCounts = {};
  for (const k of ["image", "audio"] as const) {
    const v = m[k];
    const inputTokens = positiveCount(v?.inputTokens);
    const outputTokens = positiveCount(v?.outputTokens);
    if (inputTokens > 0 || outputTokens > 0) out[k] = { inputTokens, outputTokens };
  }
  return out.image || out.audio ? { modality: out } : {};
}

/** OpenAI chat completions: `prompt_tokens_details` / `completion_tokens_details` carry `audio_tokens`
 * (and, on some compatible endpoints, `image_tokens`) */
export function openAiChatModality(usage: unknown): { modality?: ModalityTokenCounts } {
  const u = (usage ?? {}) as {
    prompt_tokens_details?: { audio_tokens?: unknown; image_tokens?: unknown } | null;
    completion_tokens_details?: { audio_tokens?: unknown; image_tokens?: unknown } | null;
  };
  return modalityUsage({
    image: {
      inputTokens: positiveCount(u.prompt_tokens_details?.image_tokens),
      outputTokens: positiveCount(u.completion_tokens_details?.image_tokens),
    },
    audio: {
      inputTokens: positiveCount(u.prompt_tokens_details?.audio_tokens),
      outputTokens: positiveCount(u.completion_tokens_details?.audio_tokens),
    },
  });
}

/** Gemini `usageMetadata`: per-modality `promptTokensDetails` / `candidatesTokensDetails` */
export function geminiModality(meta: GeminiUsageMetadata | undefined): { modality?: ModalityTokenCounts } {
  const sum = (details: GeminiModalityCount[] | undefined, modality: string) =>
    (details ?? []).filter((d) => d?.modality === modality).reduce((n, d) => n + positiveCount(d.tokenCount), 0);
  return modalityUsage({
    image: {
      inputTokens: sum(meta?.promptTokensDetails, "IMAGE") + sum(meta?.promptTokensDetails, "VIDEO"),
      outputTokens: sum(meta?.candidatesTokensDetails, "IMAGE"),
    },
    audio: {
      inputTokens: sum(meta?.promptTokensDetails, "AUDIO"),
      outputTokens: sum(meta?.candidatesTokensDetails, "AUDIO"),
    },
  });
}

/** the provider's prompt-cache counts, only when positive (see `usage`) */
/** internal to this package (exported only for the adapter modules) */
export function cacheUsage(read: unknown, creation: unknown): { cacheReadInputTokens?: number; cacheCreationInputTokens?: number } {
  const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  return { ...(pos(read) ? { cacheReadInputTokens: read } : {}), ...(pos(creation) ? { cacheCreationInputTokens: creation } : {}) };
}

/** the provider-reported model id, or null — a blank or non-string value is
 * "not reported", never coerced */
export function reportedModel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const DEFAULT_MAX_TOKENS = 1024;
/** above this, the Anthropic adapter streams internally even without a
 * caller onText — long generations must not ride a single request timeout */
export const STREAM_THRESHOLD_TOKENS = 16_000;

export interface GeminiModalityCount {
  modality?: string;
  tokenCount?: number;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  /** ADR-0212: per-modality breakdowns (TEXT, IMAGE, VIDEO, AUDIO) */
  promptTokensDetails?: GeminiModalityCount[];
  candidatesTokensDetails?: GeminiModalityCount[];
}

/**
 * ROADMAP G2 — the deadline every real SDK client is constructed with.
 *
 * WHY THIS LIVES HERE AND THE ENV VAR DOES NOT. The number belongs to the
 * package that uses it, so there is one definition; the gateway's `timeouts.ts`
 * IMPORTS this default and is the only thing that reads
 * `REGULAIT_MODEL_TIMEOUT_MS`, then pushes the resolved value in. One number,
 * one env reader, no mirrored constant to drift — this repo has already been
 * bitten once by a hand-maintained mirror (ADR-0121's connector-kind list).
 *
 * WHY IT MATTERS. Both SDKs default to a TEN-MINUTE timeout and both retry
 * twice, so the real worst case for one held request was around half an hour,
 * inherited silently from a vendor default nobody chose. Five minutes is
 * deliberately not aggressive: a long completion is legitimate work and this is
 * a governance layer, not a latency budget.
 */
export const MODEL_DISPATCH_TIMEOUT_MS_DEFAULT = 300_000;

let modelDispatchTimeoutMs: number = MODEL_DISPATCH_TIMEOUT_MS_DEFAULT;

/** Called by the gateway once at start-up, and by tests that need a short one. */
export function setModelDispatchTimeoutMs(ms: number): void {
  modelDispatchTimeoutMs = ms;
}

export function modelDispatchTimeout(): number {
  return modelDispatchTimeoutMs;
}

/** marker so wrapping twice is a no-op rather than two armed signals */
const DEADLINE_BOUND = Symbol.for("regulait.model.deadlineBoundFetch");

/**
 * AER-021 — THE DEADLINE EVERY RAW-FETCH ADAPTER GETS WHETHER ITS AUTHOR
 * THOUGHT ABOUT IT OR NOT.
 *
 * ADR-0126 bounded model dispatch by passing `modelDispatchTimeout()` to each
 * SDK constructor — which covered Anthropic, OpenAI, xAI and custom, and missed
 * `GoogleProvider` completely, because Google is the one adapter written against
 * raw `fetch`. A hung Gemini endpoint could hold gateway work forever, ignoring
 * the operator's `REGULAIT_MODEL_TIMEOUT_MS` entirely, while the ADR and the
 * roadmap both claimed no unbounded wait remained on any model path.
 *
 * The narrow fix is to add a signal in `GoogleProvider.dispatch`. That was
 * rejected: it leaves the NEXT raw-fetch adapter free to omit it just as
 * silently. This wrapper is applied in `resolveModelProvider`, the single funnel
 * every production dispatch is built through, so a provider added later inherits
 * the bound without its author doing anything — the omission becomes structurally
 * impossible rather than something to remember.
 *
 * ── WHY THE TIMER IS NEVER CLEARED EARLY ───────────────────────────────────
 * `AbortSignal.timeout` is the same primitive `mcp-egress.ts` uses for the MCP
 * connect deadline, and it is the right one here for a reason specific to
 * streaming: aborting the signal a fetch was given **also errors the response
 * BODY stream**, so the deadline stays live through `reader.read()` and
 * `res.json()` — which is exactly where the Google adapter used to hang after
 * headers had already arrived. A wrapper cannot know when the caller has
 * finished reading a body, so there is nothing to clear on; the signal simply
 * expires. `AbortSignal.timeout` does not hold the event loop open, and an abort
 * that lands after a fully-consumed body is a no-op.
 *
 * Since ADR-0253 the Gemini adapter rides `@ai-sdk/google`, which is handed this
 * same bound fetch, so the binding (and the body-stream half of it) is unchanged.
 *
 * A caller-supplied signal is PRESERVED and composed with `AbortSignal.any`, so
 * this can never take away a cancellation the caller already arranged.
 */
export function deadlineBoundFetch(inner: typeof fetch = fetch): typeof fetch {
  if ((inner as { [DEADLINE_BOUND]?: true })[DEADLINE_BOUND]) return inner;
  const bound: typeof fetch = (input, init) => {
    const deadline = AbortSignal.timeout(modelDispatchTimeout());
    const caller = init?.signal ?? null;
    return inner(input, {
      ...init,
      signal: caller ? AbortSignal.any([caller, deadline]) : deadline,
    });
  };
  Object.defineProperty(bound, DEADLINE_BOUND, { value: true });
  return bound;
}

/**
 * Was this failure our model deadline rather than the provider's refusal?
 *
 * `AbortSignal.timeout` rejects with a DOMException named `TimeoutError`; an
 * abort from a composed caller signal is `AbortError`. Both are distinguished
 * from a provider error so the ledger can say "we stopped waiting" rather than
 * "the vendor failed" — they send an operator to different places.
 */
export function isModelDeadlineError(err: unknown): boolean {
  const e = err as { name?: string } | null;
  return e?.name === "TimeoutError" || e?.name === "AbortError";
}
