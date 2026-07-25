/**
 * @regulait/model-provider — the real dispatch layer behind pillar 1's agent
 * registry (EPIC-04 §7/§8 measured savings, pillar 5 actual-spend ledger).
 *
 * Follows the git-provider/pm-provider playbook: a neutral interface, one real
 * adapter (Anthropic, official SDK with injectable fetch), an in-memory mock
 * for tests and air-gapped development, and a registry that explicitly rejects
 * providers that are interface-ready but not implemented — no silent promises.
 *
 * Placement rule (OPTIMIZATION §8, GOVERNANCE §7): dispatch always runs
 * strictly AFTER the governance decision and the routing selection. This
 * package never chooses a model — it is handed the served agent's
 * provider-native model id and executes exactly that. Widening entitlement
 * here is structurally impossible because the model id is an input.
 *
 * Honesty rule (pillar 5): the usage numbers returned here are MEASURED —
 * they come from the provider's own usage accounting, not from our
 * estimators. Callers ledger them separately from estimate-based cost_events.
 */

import Anthropic from "@anthropic-ai/sdk";

export const MODEL_PROVIDER_KINDS = ["anthropic", "openai", "google", "xai", "mock"] as const;
export type ModelProviderKind = (typeof MODEL_PROVIDER_KINDS)[number];

export function isModelProviderKind(value: string): value is ModelProviderKind {
  return (MODEL_PROVIDER_KINDS as readonly string[]).includes(value);
}

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ModelDispatchRequest {
  /** provider-native model id (e.g. claude-opus-5) — chosen upstream by routing */
  model: string;
  /** the user's request text, sent as a single user turn */
  input: string;
  system?: string;
  maxTokens?: number;
  /** streaming: called with each text delta as it arrives. The returned
   * result is still the COMPLETE message — accounting and refusal handling
   * are identical to the non-streaming path. */
  onText?: (delta: string) => void;
}

export interface ModelDispatchResult {
  outputText: string;
  /** normalized: end_turn | max_tokens | refusal | other */
  stopReason: "end_turn" | "max_tokens" | "refusal" | "other";
  /** true when the model itself declined (stop_reason=refusal) — callers must
   * check this before treating outputText as an answer */
  refusal: boolean;
  /** MEASURED by the provider, never estimated here */
  usage: { inputTokens: number; outputTokens: number };
  /** provider-side message/request identifier for cross-system audit joins */
  providerMessageId: string | null;
}

export interface ModelProvider {
  readonly kind: ModelProviderKind;
  dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult>;
}

const DEFAULT_MAX_TOKENS = 1024;
/** above this, the Anthropic adapter streams internally even without a
 * caller onText — long generations must not ride a single request timeout */
const STREAM_THRESHOLD_TOKENS = 16_000;

// ---------------------------------------------------------------------------
// Anthropic adapter — official SDK, injectable fetch (same testability
// discipline as the ADO/git adapters: unit tests never touch the network).
// ---------------------------------------------------------------------------

export interface AnthropicAdapterOptions {
  apiKey: string;
  /** override for BYOC/air-gapped bridges; default is Anthropic's API */
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
}

export class AnthropicProvider implements ModelProvider {
  readonly kind = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(opts: AnthropicAdapterOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
      maxRetries: 2,
    });
  }

  async dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    const params = {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(req.system ? { system: req.system } : {}),
      messages: [{ role: "user" as const, content: req.input }],
    };
    // stream when the caller wants deltas, or when the output budget is large
    // enough that a single non-streaming request risks a timeout
    const useStream = req.onText !== undefined || params.max_tokens > STREAM_THRESHOLD_TOKENS;
    let msg: Anthropic.Message;
    try {
      if (useStream) {
        const stream = this.client.messages.stream(params);
        if (req.onText) stream.on("text", (delta) => req.onText!(delta));
        msg = await stream.finalMessage();
      } else {
        msg = await this.client.messages.create(params);
      }
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        throw new ModelProviderError(
          `anthropic dispatch failed: ${err.message}`,
          typeof err.status === "number" ? err.status : undefined,
        );
      }
      throw err;
    }
    const refusal = msg.stop_reason === "refusal";
    const stopReason: ModelDispatchResult["stopReason"] =
      msg.stop_reason === "end_turn" || msg.stop_reason === "max_tokens" || refusal
        ? (msg.stop_reason as ModelDispatchResult["stopReason"])
        : "other";
    return {
      // a refusal's content must never be surfaced as an answer
      outputText: refusal
        ? ""
        : msg.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join(""),
      stopReason,
      refusal,
      usage: {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
      },
      providerMessageId: msg.id ?? null,
    };
  }
}

// ---------------------------------------------------------------------------
// Mock adapter — deterministic, in-memory, for tests and air-gapped
// development. An input containing "<<refuse>>" produces a refusal so the
// refusal path is testable end-to-end without a live model.
// ---------------------------------------------------------------------------

export interface MockDispatch extends ModelDispatchRequest {
  seq: number;
}

/** deterministic stand-in for provider-side token accounting */
function mockTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class MockModelProvider implements ModelProvider {
  readonly kind = "mock" as const;
  readonly dispatches: MockDispatch[] = [];
  private seq = 0;

  async dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    const seq = ++this.seq;
    this.dispatches.push({ ...req, seq });
    if (req.input.includes("<<refuse>>")) {
      return {
        outputText: "",
        stopReason: "refusal",
        refusal: true,
        usage: { inputTokens: mockTokens(req.input), outputTokens: 0 },
        providerMessageId: `mock-msg-${seq}`,
      };
    }
    const outputText = `mock(${req.model}): ${req.input}`;
    if (req.onText) {
      // deterministic chunking so the streaming path is testable end-to-end
      const mid = Math.ceil(outputText.length / 2);
      req.onText(outputText.slice(0, mid));
      req.onText(outputText.slice(mid));
    }
    return {
      outputText,
      stopReason: "end_turn",
      refusal: false,
      usage: { inputTokens: mockTokens(req.input), outputTokens: mockTokens(outputText) },
      providerMessageId: `mock-msg-${seq}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ModelProviderConfig {
  provider: ModelProviderKind;
  /** required for real providers; the mock needs none (air-gapped path) */
  apiKey?: string | null;
  baseUrl?: string | null;
}

/** shared mock instance so state persists across resolutions in one process */
const sharedMock = new MockModelProvider();

export function resolveModelProvider(
  config: ModelProviderConfig,
  fetchImpl?: typeof fetch,
): ModelProvider {
  switch (config.provider) {
    case "anthropic":
      if (!config.apiKey) {
        throw new ModelProviderError("anthropic requires an apiKey");
      }
      return new AnthropicProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "mock":
      return sharedMock;
    case "openai":
    case "google":
    case "xai":
      throw new ModelProviderError(
        `provider '${config.provider}' is interface-ready but its adapter is not implemented yet`,
      );
  }
}
