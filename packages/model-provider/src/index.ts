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
import OpenAI from "openai";

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
// OpenAI adapter — official SDK, injectable fetch, same discipline as the
// Anthropic adapter: complete result either way, refusals never surfaced as
// answers, usage is the provider's own accounting.
// ---------------------------------------------------------------------------

export interface OpenAiAdapterOptions {
  apiKey: string;
  /** override for BYOC/air-gapped bridges; default is OpenAI's API */
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
}

function mapOpenAiStop(finishReason: string | null | undefined): ModelDispatchResult["stopReason"] {
  if (finishReason === "stop") return "end_turn";
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "content_filter") return "refusal";
  return "other";
}

export class OpenAiProvider implements ModelProvider {
  readonly kind = "openai" as const;
  private readonly client: OpenAI;

  constructor(opts: OpenAiAdapterOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
      maxRetries: 2,
    });
  }

  async dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    const messages = [
      ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
      { role: "user" as const, content: req.input },
    ];
    const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    try {
      if (req.onText !== undefined || maxTokens > STREAM_THRESHOLD_TOKENS) {
        const stream = await this.client.chat.completions.create({
          model: req.model,
          max_completion_tokens: maxTokens,
          messages,
          stream: true,
          stream_options: { include_usage: true },
        });
        let text = "";
        let refusalText = "";
        let finishReason: string | null = null;
        let id: string | null = null;
        let usage = { inputTokens: 0, outputTokens: 0 };
        for await (const chunk of stream) {
          id = id ?? chunk.id ?? null;
          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) {
            text += choice.delta.content;
            req.onText?.(choice.delta.content);
          }
          if (choice?.delta?.refusal) refusalText += choice.delta.refusal;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          }
        }
        const refusal = mapOpenAiStop(finishReason) === "refusal" || refusalText.length > 0;
        return {
          outputText: refusal ? "" : text,
          stopReason: refusal ? "refusal" : mapOpenAiStop(finishReason),
          refusal,
          usage,
          providerMessageId: id,
        };
      }

      const res = await this.client.chat.completions.create({
        model: req.model,
        max_completion_tokens: maxTokens,
        messages,
      });
      const choice = res.choices[0];
      const refusal =
        mapOpenAiStop(choice?.finish_reason) === "refusal" || Boolean(choice?.message?.refusal);
      return {
        // a refusal's content must never be surfaced as an answer
        outputText: refusal ? "" : (choice?.message?.content ?? ""),
        stopReason: refusal ? "refusal" : mapOpenAiStop(choice?.finish_reason),
        refusal,
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
        },
        providerMessageId: res.id ?? null,
      };
    } catch (err) {
      if (err instanceof OpenAI.APIError) {
        throw new ModelProviderError(
          `openai dispatch failed: ${err.message}`,
          typeof err.status === "number" ? err.status : undefined,
        );
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Google (Gemini) adapter — RAW fetch, deliberately: the unified
// @google/genai SDK does not expose injectable fetch, and untestable network
// code loses to plain REST (the git/pm adapters set this precedent). Same
// neutral contract and refusal discipline as the SDK-based adapters.
// ---------------------------------------------------------------------------

export interface GoogleAdapterOptions {
  apiKey: string;
  /** override for BYOC/air-gapped bridges; default is the Gemini API */
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
}

const GOOGLE_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_REFUSAL_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]);

interface GeminiChunk {
  responseId?: string;
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function mapGoogleStop(finishReason: string | null | undefined): ModelDispatchResult["stopReason"] {
  if (finishReason === "STOP") return "end_turn";
  if (finishReason === "MAX_TOKENS") return "max_tokens";
  if (finishReason && GOOGLE_REFUSAL_REASONS.has(finishReason)) return "refusal";
  return "other";
}

export class GoogleProvider implements ModelProvider {
  readonly kind = "google" as const;
  private readonly apiKey: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GoogleAdapterOptions) {
    this.apiKey = opts.apiKey;
    this.base = (opts.baseUrl ?? GOOGLE_DEFAULT_BASE).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    const useStream = req.onText !== undefined || maxTokens > STREAM_THRESHOLD_TOKENS;
    const method = useStream ? "streamGenerateContent?alt=sse" : "generateContent";
    const res = await this.fetchImpl(
      `${this.base}/models/${encodeURIComponent(req.model)}:${method}`,
      {
        method: "POST",
        headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: req.input }] }],
          ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      },
    );
    if (!res.ok) {
      let message = res.statusText;
      try {
        const j = (await res.json()) as { error?: { message?: string } };
        message = j.error?.message ?? message;
      } catch {
        /* non-JSON error body */
      }
      throw new ModelProviderError(`google dispatch failed: ${message}`, res.status);
    }

    let text = "";
    let finishReason: string | null = null;
    let blockReason: string | null = null;
    let id: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0 };
    const absorb = (chunk: GeminiChunk) => {
      id = id ?? chunk.responseId ?? null;
      blockReason = blockReason ?? chunk.promptFeedback?.blockReason ?? null;
      const candidate = chunk.candidates?.[0];
      const delta = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (delta) {
        text += delta;
        req.onText?.(delta);
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      if (chunk.usageMetadata) {
        usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
        };
      }
    };

    if (useStream) {
      // incremental SSE parse so onText fires as chunks arrive
      const reader = res.body?.getReader();
      if (!reader) throw new ModelProviderError("google dispatch failed: empty stream body");
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buffer.indexOf("\n");
          if (nl === -1) break;
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.startsWith("data: ")) absorb(JSON.parse(line.slice(6)) as GeminiChunk);
        }
      }
    } else {
      absorb((await res.json()) as GeminiChunk);
    }

    const refusal = blockReason !== null || mapGoogleStop(finishReason) === "refusal";
    return {
      // a refusal's content must never be surfaced as an answer
      outputText: refusal ? "" : text,
      stopReason: refusal ? "refusal" : mapGoogleStop(finishReason),
      refusal,
      usage,
      providerMessageId: id,
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
    case "openai":
      if (!config.apiKey) {
        throw new ModelProviderError("openai requires an apiKey");
      }
      return new OpenAiProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "google":
      if (!config.apiKey) {
        throw new ModelProviderError("google requires an apiKey");
      }
      return new GoogleProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "mock":
      return sharedMock;
    case "xai":
      throw new ModelProviderError(
        `provider '${config.provider}' is interface-ready but its adapter is not implemented yet`,
      );
  }
}
