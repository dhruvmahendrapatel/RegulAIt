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

/** A tool the model may call during a turn (pillar 7 tool-using workers). The
 * `inputSchema` is a JSON Schema object — the same shape the MCP manifest
 * carries, so a governed tool's declared inputs pass straight through. */
export interface ModelToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** A block inside a multi-turn message's content. Text is the ordinary case;
 * tool_use is what an assistant turn appends when it calls a tool; tool_result
 * is the following user turn carrying that tool's output back into history.
 * Together they let a tool-using loop append turns across iterations. */
export type ModelContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

/** One turn of a multi-turn conversation. `system` is deliberately NOT a
 * role here — it stays a separate ModelDispatchRequest field, because two of
 * the providers (Anthropic, Google) carry it out-of-band anyway. `content` is
 * a plain string for ordinary turns, or an ordered block array when a turn
 * carries tool_use / tool_result parts (a tool-using loop's history). */
export interface ModelChatMessage {
  role: "user" | "assistant";
  content: string | ModelContentBlock[];
}

export interface ModelDispatchRequest {
  /** provider-native model id (e.g. claude-opus-5) — chosen upstream by routing */
  model: string;
  /** the user's request text, sent as a single user turn. IGNORED when
   * `messages` is present — the newest turn must ride inside `messages`. */
  input: string;
  /** multi-turn contract: when present, this is the FULL ordered history
   * INCLUDING the newest user turn, and `input` is ignored entirely; when
   * absent, behaviour is byte-identical to the single-turn contract (`input`
   * as one user turn). `system` stays a separate field either way. */
  messages?: ModelChatMessage[];
  system?: string;
  maxTokens?: number;
  /** tools the model may call this turn (pillar 7). When absent, the request
   * is byte-identical to the tool-free contract — no adapter sends a `tools`
   * field. When present, a model may answer with stopReason "tool_use" and
   * `toolCalls`, which the caller executes and feeds back as tool_result
   * turns. */
  tools?: ModelToolDef[];
  /** streaming: called with each text delta as it arrives. The returned
   * result is still the COMPLETE message — accounting and refusal handling
   * are identical to the non-streaming path. */
  onText?: (delta: string) => void;
}

export interface ModelDispatchResult {
  outputText: string;
  /** normalized: end_turn | max_tokens | refusal | tool_use | other. tool_use
   * means the model paused to call the tools in `toolCalls`. */
  stopReason: "end_turn" | "max_tokens" | "refusal" | "tool_use" | "other";
  /** true when the model itself declined (stop_reason=refusal) — callers must
   * check this before treating outputText as an answer */
  refusal: boolean;
  /** present only when stopReason is "tool_use": the tool calls the model
   * wants executed, in the provider-neutral shape the caller re-governs and
   * runs before feeding results back as the next turn. */
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  /** MEASURED by the provider, never estimated here */
  usage: { inputTokens: number; outputTokens: number };
  /** provider-side message/request identifier for cross-system audit joins */
  providerMessageId: string | null;
}

export interface ModelProvider {
  readonly kind: ModelProviderKind;
  dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult>;
}

/** The effective ordered turn list: `messages` verbatim when present (the
 * full-history contract above), else `input` as the single user turn — the
 * one place the messages-vs-input precedence is decided, so every adapter
 * agrees on it. */
function chatTurns(req: ModelDispatchRequest): ModelChatMessage[] {
  return req.messages && req.messages.length > 0
    ? req.messages
    : [{ role: "user", content: req.input }];
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
      // roles map 1:1 onto the Messages API; a block-array turn (tool_use /
      // tool_result history) maps each block to its native content shape
      messages: chatTurns(req).map((m) => ({
        role: m.role,
        content: anthropicContent(m.content),
      })),
      ...(req.tools
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              ...(t.description ? { description: t.description } : {}),
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
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
      msg.stop_reason === "tool_use"
        ? "tool_use"
        : msg.stop_reason === "end_turn" || msg.stop_reason === "max_tokens" || refusal
          ? (msg.stop_reason as ModelDispatchResult["stopReason"])
          : "other";
    // the tool_use content blocks the loop executes — these are exactly the
    // ones a text-only caller ignores; surfaced here as neutral toolCalls
    const toolCalls = msg.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, arguments: b.input }));
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
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      usage: {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
      },
      providerMessageId: msg.id ?? null,
    };
  }
}

/** Map our neutral content (string or block array) onto Anthropic's native
 * message content. A string stays a string (byte-identical to the tool-free
 * path); a block array maps text / tool_use / tool_result to the Messages API
 * block shapes. */
function anthropicContent(
  content: string | ModelContentBlock[],
): string | Anthropic.ContentBlockParam[] {
  if (typeof content === "string") return content;
  return content.map((b): Anthropic.ContentBlockParam => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "tool_use") {
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    }
    return {
      type: "tool_result",
      tool_use_id: b.toolUseId,
      content: b.content,
      ...(b.isError ? { is_error: true } : {}),
    };
  });
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
  if (finishReason === "tool_calls") return "tool_use";
  return "other";
}

/** Tool-call arguments arrive as a JSON string on the OpenAI family; parse
 * defensively so a malformed fragment never throws out of the adapter. */
function parseJsonArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Flatten our neutral turns onto OpenAI chat messages. A string turn maps
 * 1:1 (byte-identical to the tool-free path). A block-array turn can expand:
 * an assistant turn's tool_use blocks become `tool_calls`, and each
 * tool_result block becomes its own `role:"tool"` message — the shape the
 * chat-completions API requires. */
function openAiMessages(
  turns: ModelChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (const m of turns) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
      continue;
    }
    const text = m.content
      .filter((b): b is Extract<ModelContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolUses = m.content.filter(
      (b): b is Extract<ModelContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolUses.length > 0
          ? {
              tool_calls: toolUses.map((b) => ({
                id: b.id,
                type: "function" as const,
                function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
              })),
            }
          : {}),
      });
    } else if (text) {
      out.push({ role: "user", content: text });
    }
    // tool_result blocks always ride as their own tool-role messages
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.content });
      }
    }
  }
  return out;
}

/** The chat-completions dispatch core, shared by every OpenAI-compatible
 * provider (OpenAI itself, xAI). `label` only flavors error messages. */
async function dispatchChatCompletions(
  client: OpenAI,
  req: ModelDispatchRequest,
  label: string,
): Promise<ModelDispatchResult> {
  const messages = [
      ...(req.system
        ? [{ role: "system" as const, content: req.system }]
        : []),
      // system first (as today), then the ordered turns — assistant stays
      // assistant; block-array turns flatten to tool_calls / tool messages
      ...openAiMessages(chatTurns(req)),
    ];
    const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    const toolParam = req.tools
      ? {
          tools: req.tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              ...(t.description ? { description: t.description } : {}),
              parameters: t.inputSchema,
            },
          })),
        }
      : {};
    try {
      if (req.onText !== undefined || maxTokens > STREAM_THRESHOLD_TOKENS) {
        const stream = await client.chat.completions.create({
          model: req.model,
          max_completion_tokens: maxTokens,
          messages,
          ...toolParam,
          stream: true,
          stream_options: { include_usage: true },
        });
        let text = "";
        let refusalText = "";
        let finishReason: string | null = null;
        let id: string | null = null;
        let usage = { inputTokens: 0, outputTokens: 0 };
        // tool_calls arrive fragmented across deltas, keyed by index
        const toolAcc = new Map<number, { id: string; name: string; args: string }>();
        for await (const chunk of stream) {
          id = id ?? chunk.id ?? null;
          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) {
            text += choice.delta.content;
            req.onText?.(choice.delta.content);
          }
          if (choice?.delta?.refusal) refusalText += choice.delta.refusal;
          for (const tc of choice?.delta?.tool_calls ?? []) {
            const slot = toolAcc.get(tc.index) ?? { id: "", name: "", args: "" };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
            toolAcc.set(tc.index, slot);
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          }
        }
        const refusal = mapOpenAiStop(finishReason) === "refusal" || refusalText.length > 0;
        const toolCalls = [...toolAcc.values()].map((t) => ({
          id: t.id,
          name: t.name,
          arguments: parseJsonArgs(t.args),
        }));
        return {
          outputText: refusal ? "" : text,
          stopReason: refusal ? "refusal" : mapOpenAiStop(finishReason),
          refusal,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          usage,
          providerMessageId: id,
        };
      }

      const res = await client.chat.completions.create({
        model: req.model,
        max_completion_tokens: maxTokens,
        messages,
        ...toolParam,
      });
      const choice = res.choices[0];
      const refusal =
        mapOpenAiStop(choice?.finish_reason) === "refusal" || Boolean(choice?.message?.refusal);
      const toolCalls = (choice?.message?.tool_calls ?? []).flatMap((tc) =>
        tc.type === "function"
          ? [{ id: tc.id, name: tc.function.name, arguments: parseJsonArgs(tc.function.arguments) }]
          : [],
      );
      return {
        // a refusal's content must never be surfaced as an answer
        outputText: refusal ? "" : (choice?.message?.content ?? ""),
        stopReason: refusal ? "refusal" : mapOpenAiStop(choice?.finish_reason),
        refusal,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
        },
        providerMessageId: res.id ?? null,
      };
  } catch (err) {
    if (err instanceof OpenAI.APIError) {
      throw new ModelProviderError(
        `${label} dispatch failed: ${err.message}`,
        typeof err.status === "number" ? err.status : undefined,
      );
    }
    throw err;
  }
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

  dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    return dispatchChatCompletions(this.client, req, "openai");
  }
}

// ---------------------------------------------------------------------------
// xAI adapter — Grok speaks OpenAI-compatible chat completions, so this is
// the shared core pointed at api.x.ai. Same contract, same refusal
// discipline, same streaming accounting.
// ---------------------------------------------------------------------------

const XAI_DEFAULT_BASE = "https://api.x.ai/v1";

export class XaiProvider implements ModelProvider {
  readonly kind = "xai" as const;
  private readonly client: OpenAI;

  constructor(opts: OpenAiAdapterOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl ?? XAI_DEFAULT_BASE,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
      maxRetries: 2,
    });
  }

  dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    return dispatchChatCompletions(this.client, req, "xai");
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

interface GeminiFunctionCall {
  name: string;
  args?: Record<string, unknown>;
}
interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
}
interface GeminiChunk {
  responseId?: string;
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Map our neutral content onto Gemini parts. A string stays one text part
 * (byte-identical to the tool-free path). tool_use → functionCall, tool_result
 * → functionResponse. Gemini keys a functionResponse by the tool NAME, which
 * our tool_result block does not carry — the loop's providers of record are
 * Anthropic + the OpenAI family, so this mapping is best-effort and not
 * exercised by the tool-loop tests. */
function googleParts(content: string | ModelContentBlock[]): Record<string, unknown>[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map((b) => {
    if (b.type === "text") return { text: b.text };
    if (b.type === "tool_use") return { functionCall: { name: b.name, args: b.input } };
    return {
      functionResponse: { name: b.toolUseId, response: { content: b.content, isError: b.isError ?? false } },
    };
  });
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
          // Gemini's assistant role is "model"
          contents: chatTurns(req).map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: googleParts(m.content),
          })),
          ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
          ...(req.tools
            ? {
                tools: [
                  {
                    functionDeclarations: req.tools.map((t) => ({
                      name: t.name,
                      ...(t.description ? { description: t.description } : {}),
                      parameters: t.inputSchema,
                    })),
                  },
                ],
              }
            : {}),
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
    const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
    const absorb = (chunk: GeminiChunk) => {
      id = id ?? chunk.responseId ?? null;
      blockReason = blockReason ?? chunk.promptFeedback?.blockReason ?? null;
      const candidate = chunk.candidates?.[0];
      const delta = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (delta) {
        text += delta;
        req.onText?.(delta);
      }
      for (const p of candidate?.content?.parts ?? []) {
        if (p.functionCall) {
          toolCalls.push({
            id: `${id ?? "gemini"}-fc-${toolCalls.length}`,
            name: p.functionCall.name,
            arguments: p.functionCall.args ?? {},
          });
        }
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
      stopReason: refusal
        ? "refusal"
        : toolCalls.length > 0
          ? "tool_use"
          : mapGoogleStop(finishReason),
      refusal,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      usage,
      providerMessageId: id,
    };
  }
}

// ---------------------------------------------------------------------------
// Mock adapter — deterministic, in-memory, for tests and air-gapped
// development. An input containing "<<refuse>>" produces a refusal so the
// refusal path is testable end-to-end without a live model. The reply is
// canned assistant behaviour, NOT an echo: intent keywords in the input pick
// a plausible shape (summary / review / plan / code / explanation / test
// plan / general), the model id's tier (fast / balanced / premium) controls
// depth, and a present system prompt is acknowledged in the opening line so
// demos visibly prove context flowed through. Multi-turn requests keep the
// same discipline: intent/tier dispatch on the LAST user turn, a visible
// continuation opener when history precedes it, and a terse follow-up
// inherits the previous user turn's topic. Everything is a pure function of
// (model, input/messages, system) — no randomness, no network.
// ---------------------------------------------------------------------------

export interface MockDispatch extends ModelDispatchRequest {
  seq: number;
}

/** deterministic stand-in for provider-side token accounting */
function mockTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

type MockTier = "fast" | "balanced" | "premium";
type MockIntent = "summarize" | "review" | "test" | "plan" | "implement" | "explain" | "general";

/** the model id names its tier (mock-fast/-balanced/-premium); anything
 * unlabelled gets the middle answer */
function mockTier(model: string): MockTier {
  if (model.includes("fast")) return "fast";
  if (model.includes("premium")) return "premium";
  return "balanced";
}

/** first matching keyword family wins — the specific asks (summarize/review/
 * test) are checked ahead of the broad build/explain verbs */
const MOCK_INTENT_PATTERNS: ReadonlyArray<readonly [MockIntent, RegExp]> = [
  ["summarize", /\b(summar|tl;?dr|recap|condense|digest)/i],
  ["review", /\b(review|critique|feedback|audit|assess)/i],
  ["test", /\b(test|verif|validat|coverage)/i],
  ["plan", /\b(plan|roadmap|milestone|approach|architect|design)/i],
  ["implement", /\b(implement|build|write|code|draft|create|add|fix|refactor)/i],
  ["explain", /\b(explain|why\b|how\b|what\s+is|describe|clarif)/i],
];

function mockIntent(input: string): MockIntent {
  for (const [intent, pattern] of MOCK_INTENT_PATTERNS) {
    if (pattern.test(input)) return intent;
  }
  return "general";
}

/** lift the request's subject (first line, minus politeness/intent verbs) so
 * canned replies read as responsive — never a restatement of the input */
function mockTopic(input: string): string {
  let t = (input.trim().split("\n", 1)[0] ?? "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(please|kindly)[,\s]+/i, "");
  t = t.replace(/^(can|could|would|will)\s+you\s+(please\s+)?/i, "");
  t = t.replace(
    /^(summarize|summarise|review|critique|plan|implement|explain|test|draft|write|build|create|describe|outline|fix|refactor|add)\b[:,\s]*/i,
    "",
  );
  t = t.replace(/^(the|a|an|this|these|that|those|my|our)\s+/i, "");
  t = t.replace(/[.?!,;:\s]+$/, "");
  const words = t.split(" ").filter(Boolean).slice(0, 8).join(" ");
  const capped = words.length > 60 ? `${words.slice(0, 60)}…` : words;
  return capped || "the request";
}

/** a plausible identifier for canned code blocks, derived from the topic */
function mockIdent(topic: string): string {
  const words = topic
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 3);
  if (words.length === 0) return "handleRequest";
  return words.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join("");
}

/** one visible opening line proving the system context flowed through — the
 * workflow-nesting demo (signed-off artifacts as worker context) relies on
 * this being present in the worker's answer */
function mockSystemAck(system: string): string {
  const firstLine = (system.split("\n", 1)[0] ?? "").trim().replace(/^you are\s+/i, "");
  const snippet = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
  return `Working within the signed-off scope: ${snippet}`;
}

function mockReplyBody(intent: MockIntent, tier: MockTier, topic: string): string {
  const ident = mockIdent(topic);
  switch (intent) {
    case "summarize": {
      if (tier === "fast") {
        return (
          `Summary — ${topic}: the material makes one central claim and supports it adequately. ` +
          `Key takeaway: the approach described is sound and can proceed as written, with scope ` +
          `the only watch item. No contradictions or blockers surfaced. Recommended next step: ` +
          `accept this summary and move to the follow-on action.`
        );
      }
      if (tier === "premium") {
        return (
          `## Summary: ${topic}\n\n` +
          `The material presents a well-scoped argument. The objective is explicit, the ` +
          `constraints are named rather than implied, and the recommended direction follows ` +
          `logically from both. Read end to end it is internally consistent, and nothing in the ` +
          `supporting detail undercuts the headline claim.\n\n` +
          `## Key points\n\n` +
          `1. The objective and its success criteria are stated up front and are measurable.\n` +
          `2. The proposed approach fits the stated constraints without stretching them.\n` +
          `3. Dependencies are acknowledged, though one assumption — that current scope holds — ` +
          `is left implicit and is quietly load-bearing.\n` +
          `4. The level of detail is even throughout; no section is under-specified.\n\n` +
          `## Implications\n\n` +
          `Confirm the scope assumption with its owner before build begins; it is the only item ` +
          `that could invalidate the plan. Everything else can proceed exactly as written, and ` +
          `this summary only needs revisiting if that assumption breaks. A one-line ` +
          `confirmation in the tracking record is enough to close it out.`
        );
      }
      return (
        `Summary — ${topic}.\n\n` +
        `The material makes a focused argument: the goal is well defined, the constraints are ` +
        `explicit, and the proposed direction follows from both. The supporting detail is ` +
        `consistent with the headline claim, though one assumption — that current scope holds — ` +
        `is doing quiet load-bearing work and deserves an explicit check before build.\n\n` +
        `Key points:\n` +
        `- The objective and its success criteria are stated clearly and are measurable.\n` +
        `- The chosen approach matches the constraints given, with no stretch.\n` +
        `- One open assumption on scope should be confirmed with its owner first.\n\n` +
        `Net: solid and actionable as written once that assumption is confirmed.`
      );
    }
    case "review": {
      if (tier === "fast") {
        return (
          `Review — ${topic}. Two findings:\n` +
          `- The core approach is sound and the main flow is easy to follow; keep it as shaped.\n` +
          `- One gap: the failure path is under-specified — decide explicitly what happens on ` +
          `error rather than leaving it implicit.\n` +
          `Verdict: approve once the gap is addressed; nothing here forces a redesign.`
        );
      }
      if (tier === "premium") {
        return (
          `## Review: ${topic}\n\n` +
          `Overall this is a solid change: the direction is right, the structure is clean, and ` +
          `the scope is appropriately narrow. One finding needs resolving before sign-off; the ` +
          `rest can ride along in the same change.\n\n` +
          `### Findings\n\n` +
          `1. **[major] Failure path under-specified.** The success path is well covered, but ` +
          `error handling is left implicit. Decide and document what happens on failure — ` +
          `retry, surface, or abort — before this ships, since callers will otherwise guess.\n` +
          `2. **[minor] Terminology drift.** Two sections use different names for the same ` +
          `concept, which will read as two different things in the audit trail. Align on one term.\n` +
          `3. **[positive] Clean core structure.** The main flow is small, composable, and easy ` +
          `to verify — keep it exactly as shaped.\n\n` +
          `### Recommendation\n\n` +
          `Approve once the major finding is resolved. No re-review is needed unless the ` +
          `failure-path decision changes the interface.`
        );
      }
      return (
        `Review — ${topic}. Overall: solid direction, one issue to fix before sign-off.\n\n` +
        `- [major] The failure path is under-specified — decide explicitly what happens on ` +
        `error (retry, surface, or abort) rather than leaving callers to guess.\n` +
        `- [minor] Naming drifts between sections; two names for the same concept will read as ` +
        `two different things later, so align on one term now.\n` +
        `- [positive] The happy path is clean, narrow, and well structured; no changes needed there.\n\n` +
        `Recommendation: address the major finding, fold the minor one into the same change, ` +
        `and this is ready to sign off. No re-review needed unless the interface shifts.`
      );
    }
    case "test": {
      if (tier === "fast") {
        return (
          `Test checklist — ${topic}:\n` +
          `- Happy path: a typical input produces exactly the expected result.\n` +
          `- Edges: empty and oversized inputs are handled without surprises.\n` +
          `- Failure: an induced error is surfaced to the caller, never swallowed.\n` +
          `Three focused cases give the highest confidence per test here; start with the ` +
          `failure case since it is the one most often missed.`
        );
      }
      if (tier === "premium") {
        return (
          `## Test plan: ${topic}\n\n` +
          `The aim is a small suite that proves behaviour, not line coverage for its own sake. ` +
          `Each case below pins one property the change must keep.\n\n` +
          `### Cases\n\n` +
          `1. **Happy path.** A representative input produces exactly the expected output; ` +
          `assert the full result, not a fragment, so regressions cannot hide.\n` +
          `2. **Boundary inputs.** Empty, minimal, and oversized inputs each get a defined ` +
          `outcome — accepted, trimmed, or rejected, but never undefined behaviour.\n` +
          `3. **Failure surfacing.** An induced downstream error reaches the caller with its ` +
          `context intact; nothing is swallowed or replaced by a generic message.\n` +
          `4. **Idempotence.** Running the same operation twice leaves the same state as ` +
          `running it once.\n\n` +
          `### Coverage note\n\n` +
          `The failure and idempotence cases are the ones most often skipped and the ones that ` +
          `catch real incidents; write them first while the happy path is still fresh. ` +
          `Everything else in the suite is optional polish once these four hold.`
        );
      }
      return (
        `Test plan — ${topic}. Four focused cases:\n\n` +
        `1. Happy path: a representative input produces exactly the expected output — assert ` +
        `the full result so regressions cannot hide in fragments.\n` +
        `2. Boundaries: empty and oversized inputs each get a defined outcome, never ` +
        `undefined behaviour.\n` +
        `3. Failure surfacing: an induced error reaches the caller with context intact, ` +
        `not swallowed.\n` +
        `4. Idempotence: running the operation twice leaves the same state as once.\n\n` +
        `Start with the failure case — it is the one most often skipped and the one that ` +
        `catches real incidents.`
      );
    }
    case "plan": {
      if (tier === "fast") {
        return (
          `Plan — ${topic}:\n` +
          `1. Pin down the current state and the exact desired outcome.\n` +
          `2. Make the smallest change that achieves it behind the existing interfaces.\n` +
          `3. Verify with one focused check, then roll forward.\n` +
          `The effort is small and step 1 can start immediately; the only real risk is hidden ` +
          `coupling, which step 1's baseline makes visible.`
        );
      }
      if (tier === "premium") {
        return (
          `## Objective\n\n` +
          `Deliver ${topic} with a verifiable result and no scope creep.\n\n` +
          `## Plan\n\n` +
          `1. **Baseline.** Record current behaviour and agree the acceptance criteria; every ` +
          `later step is judged against this, not against memory.\n` +
          `2. **Design.** Choose the smallest viable change that meets the criteria without ` +
          `touching unrelated surfaces.\n` +
          `3. **Build.** Implement behind the existing interfaces, keeping each edit ` +
          `reviewable on its own.\n` +
          `4. **Verify.** Run the focused checks from step 1 and compare against the baseline ` +
          `before anything rolls forward.\n` +
          `5. **Roll forward.** Ship once the checks pass, with the baseline kept as the ` +
          `rollback reference.\n\n` +
          `## Risks and mitigations\n\n` +
          `- Hidden coupling discovered mid-build — mitigated by the baseline in step 1, which ` +
          `makes any surprise visible immediately.\n` +
          `- Scope creep — mitigated by the acceptance criteria agreed up front; anything ` +
          `outside them is a new request, not this plan.\n\n` +
          `## Next step\n\n` +
          `Confirm the acceptance criteria in step 1 and the build can begin immediately.`
        );
      }
      return (
        `Plan — ${topic}. Four steps:\n\n` +
        `1. Baseline: capture current behaviour and the acceptance criteria so success is ` +
        `checkable, not assumed.\n` +
        `2. Design: choose the smallest change that meets the criteria without touching ` +
        `unrelated surfaces.\n` +
        `3. Build: implement behind the existing interfaces, keeping each edit reviewable ` +
        `on its own.\n` +
        `4. Verify: run the focused checks from step 1 against the baseline before rollout.\n\n` +
        `The main risk is hidden coupling discovered mid-build; the mitigation is the baseline ` +
        `in step 1, which makes any surprise visible immediately. Ready to start on your ` +
        `go-ahead.`
      );
    }
    case "implement": {
      if (tier === "fast") {
        return (
          `Minimal implementation — ${topic}:\n\n` +
          "```ts\n" +
          `export function ${ident}(input: Request): Response {\n` +
          `  const checked = validate(input);\n` +
          `  return respond(process(checked));\n` +
          `}\n` +
          "```\n\n" +
          `Validate first, process once, respond — the smallest shape that does the job for ` +
          `${topic} and stays independently testable.`
        );
      }
      if (tier === "premium") {
        return (
          `## Implementation: ${topic}\n\n` +
          `The sketch below keeps validation, processing, and response as separate seams so ` +
          `each is testable on its own and the failure path is explicit rather than implied.\n\n` +
          "```ts\n" +
          `export function ${ident}(input: Request): Response {\n` +
          `  const checked = validate(input); // reject early, with the reason attached\n` +
          `  const result = process(checked); // the one place business logic lives\n` +
          `  return respond(result); // shape the outcome for the caller\n` +
          `}\n\n` +
          `export function ${ident}Fallback(err: Error): Response {\n` +
          `  return respondError(err); // failures surface with context, never swallowed\n` +
          `}\n` +
          "```\n\n" +
          `### How it works\n\n` +
          `Input is checked once at the boundary, the core transformation happens in exactly ` +
          `one place, and every failure routes through the fallback with its context intact.\n\n` +
          `### Notes\n\n` +
          `- Each seam (validate, process, respond) can be unit-tested in isolation.\n` +
          `- The error path is a first-class function, so refusals and faults are visible in ` +
          `review rather than buried in a catch block.\n` +
          `- Nothing outside these functions needs to change to adopt this.`
        );
      }
      return (
        `Implementation sketch — ${topic}:\n\n` +
        "```ts\n" +
        `export function ${ident}(input: Request): Response {\n` +
        `  const checked = validate(input); // reject early, reason attached\n` +
        `  const result = process(checked); // business logic lives here only\n` +
        `  return respond(result);\n` +
        `}\n` +
        "```\n\n" +
        `One line of intent per seam: validate at the boundary, transform in one place, shape ` +
        `the response last. Failures reject early with the reason attached instead of ` +
        `surfacing halfway through processing.\n\n` +
        `- Each seam is unit-testable in isolation.\n` +
        `- The failure path stays explicit: reject early rather than patching results downstream.\n` +
        `- Nothing outside this function needs to change to adopt it.`
      );
    }
    case "explain": {
      if (tier === "fast") {
        return (
          `Briefly, on ${topic}: it works the way it does because each part has exactly one ` +
          `job — input is checked once, handled once, and answered once. The practical ` +
          `consequence is that behaviour stays predictable under change, and any failure ` +
          `points at exactly one place. That single-responsibility shape is the whole story.`
        );
      }
      if (tier === "premium") {
        return (
          `## Explanation: ${topic}\n\n` +
          `The behaviour comes from three deliberate properties rather than accident.\n\n` +
          `**Single responsibility.** Each part has exactly one job: input is checked once at ` +
          `the boundary, transformed in one place, and answered once. When something fails, ` +
          `the failure points at exactly one seam instead of smearing across the flow.\n\n` +
          `**Explicit boundaries.** The seams between the parts are named interfaces, so a ` +
          `change on one side cannot silently reshape the other. This is what keeps behaviour ` +
          `predictable as the system grows.\n\n` +
          `**Failures as first-class outcomes.** Errors are surfaced with their context ` +
          `attached rather than swallowed, which is why the observable behaviour under fault ` +
          `matches the documented behaviour.\n\n` +
          `## In short\n\n` +
          `Predictability here is a designed property: one job per part, hard boundaries ` +
          `between parts, and honest failures. Change any one of the three and the guarantees ` +
          `above weaken accordingly. That is also the order in which to check things when the ` +
          `behaviour surprises you.`
        );
      }
      return (
        `On ${topic}: the behaviour follows from each part having exactly one job. Input is ` +
        `checked once at the boundary, transformed in exactly one place, and answered once — ` +
        `so when something fails, the failure points at a single seam instead of smearing ` +
        `across the flow.\n\n` +
        `The seams between parts are explicit interfaces, which is why a change on one side ` +
        `cannot silently reshape the other, and why behaviour stays predictable as things ` +
        `grow.\n\n` +
        `In short: predictability here is designed, not accidental — one job per part, hard ` +
        `boundaries between parts, and failures surfaced with context rather than swallowed.`
      );
    }
    case "general": {
      if (tier === "fast") {
        return (
          `On ${topic}: understood, and it is actionable as stated. The intent is clear, the ` +
          `scope is bounded, and nothing blocks starting now. I would take the direct route ` +
          `first and only add structure if a complication actually appears — that keeps the ` +
          `feedback loop short. Say the word and I will proceed.`
        );
      }
      if (tier === "premium") {
        return (
          `## On ${topic}\n\n` +
          `Understood. The request is clear and self-contained: the intent is unambiguous, ` +
          `the scope is bounded, and it can be acted on without further clarification. The ` +
          `direct route is the right first move here — structure can be added later if a ` +
          `complication actually appears, and starting simple keeps the feedback loop short.\n\n` +
          `## What I would do\n\n` +
          `1. Confirm the one detail that shapes everything else — the expected outcome — so ` +
          `effort lands where it counts.\n` +
          `2. Take the direct implementation route first; it is reversible and produces ` +
          `evidence quickly.\n` +
          `3. Close with a quick verification against the stated intent before calling it ` +
          `done, so the result is checked rather than assumed.\n\n` +
          `## Next step\n\n` +
          `Point one is the only open question; answer it and the rest proceeds without ` +
          `further input. If the outcome is already documented somewhere, a pointer to it is ` +
          `all I need. Happy to expand any step into a full plan on request.`
        );
      }
      return (
        `Understood — here is my take on ${topic}.\n\n` +
        `The request is clear and self-contained: the intent is unambiguous, the scope is ` +
        `bounded, and it can be acted on without further clarification. The direct route is ` +
        `the right first move; structure can be added later if a complication appears.\n\n` +
        `What I would do next:\n` +
        `- Confirm the expected outcome, since that one detail shapes everything else.\n` +
        `- Take the direct implementation route first — it is reversible and fast to verify.\n` +
        `- Close with a quick check against the stated intent before calling it done.\n\n` +
        `Happy to expand any of these into a concrete plan, or to start immediately.`
      );
    }
  }
}

/** A terse follow-up ("now make it shorter") carries no topic of its own —
 * below this word count the mock pulls the topic from the PREVIOUS user turn
 * so the demo visibly proves history flowed through. */
const TERSE_FOLLOW_UP_WORDS = 8;

// ---------------------------------------------------------------------------
// Task-decomposition planning (pillar 7). The gateway's decompose endpoint
// puts this sentinel at the top of its planning system prompt; when the mock
// sees it, the reply is a VALID deterministic JSON plan derived from the goal
// text — 4 nodes: analyze → two parallel topic-flavoured middles → an
// integrate/verify node depending on both. Agent names are parsed out of the
// roster the prompt embeds (cheapest for analysis/verification, mid-tier for
// build), and the model tier still shapes instruction verbosity. Two
// deterministic test triggers ride the goal text like "<<refuse>>" does:
// "<<badplan>>" emits broken JSON EVERY time (exercising the retry-then-422
// path), "<<rogueagent>>" assigns one node an agent name outside the roster
// (exercising substitution recording).
// ---------------------------------------------------------------------------

export const TASK_DECOMPOSITION_SENTINEL = "TASK-DECOMPOSITION REQUEST";

// ---------------------------------------------------------------------------
// Context compaction (pillar 6, TOKEN_OPTIMIZATION_SPEC §5). The gateway's
// compaction dispatch puts this sentinel at the top of its summarization
// system prompt; when the mock sees it, the reply is a deterministic,
// faithful-looking summary derived from the transcript it was handed —
// opening/closing topics parsed back out of the "user:"/"assistant:" lines,
// turn count included — so the whole compaction loop is demoable with zero
// external keys. A transcript carrying "<<refuse>>" still refuses first
// (the shared lastUser check), which is exactly the fail-open test hook.
// ---------------------------------------------------------------------------

export const CONVERSATION_COMPACTION_SENTINEL = "CONVERSATION-COMPACTION REQUEST";

function mockCompactionSummary(transcript: string): string {
  const turnLines = transcript.split("\n").filter((l) => /^(user|assistant): /.test(l));
  const userLines = turnLines
    .filter((l) => l.startsWith("user: "))
    .map((l) => l.slice("user: ".length));
  const opening = mockTopic(userLines[0] ?? "the request");
  const latest = mockTopic(userLines[userLines.length - 1] ?? "the request");
  const cumulative = transcript.includes("Prior summary:");
  const span = latest === opening ? "" : ` and most recently covered ${latest}`;
  return (
    `Summary of the conversation (${turnLines.length} earlier turns` +
    `${cumulative ? ", cumulative with the prior summary" : ""}): ` +
    `the discussion opened on ${opening}${span}. ` +
    `Decisions and constraints agreed in those turns stay binding: scope is held exactly as stated, ` +
    `every name, number, and system mentioned is preserved as given, and open questions keep their ` +
    `assigned owners. The assistant's earlier replies — summaries, plans, and reviews — were accepted ` +
    `as consistent with that scope. Nothing in the compacted turns contradicts the current direction; ` +
    `continue from this context as if the full history were present.`
  );
}

const PLAN_STOPWORDS = new Set([
  "the", "and", "that", "this", "those", "these", "with", "into", "from", "over",
  "your", "our", "their", "them", "then", "should", "must", "will", "have",
  "make", "build", "create", "implement", "write", "draft", "please", "them",
  "public", "private", "some", "every", "each", "when", "where", "what", "them",
]);

/** two distinct topic words lifted from the goal so the parallel middle
 * tasks read as goal-specific, never boilerplate */
function planKeywords(goal: string): [string, string] {
  const words = goal
    .replace(/<<[^>]*>>/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !PLAN_STOPWORDS.has(w));
  const uniq = [...new Set(words)];
  return [uniq[0] ?? "core", uniq[1] ?? "supporting"];
}

function planSlug(word: string): string {
  const s = word.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return s || "task";
}

/** roster lines look like "- fast-mock (tier 0, $1 in / $5 out per MTok)" —
 * the stable format the gateway's planning prompt emits */
function planRoster(system: string): Array<{ name: string; tier: number }> {
  const out: Array<{ name: string; tier: number }> = [];
  for (const m of system.matchAll(/^- (.+?) \(tier (\d+)/gm)) {
    out.push({ name: m[1]!, tier: Number(m[2]) });
  }
  return out;
}

/** tier controls how many of a node's candidate sentences survive — the same
 * fast/balanced/premium verbosity contract the canned replies keep */
function planInstruction(sentences: string[], tier: MockTier): string {
  const keep = tier === "fast" ? 2 : tier === "balanced" ? 3 : 4;
  return sentences.slice(0, keep).join(" ");
}

function mockDecompositionReply(goal: string, system: string, tier: MockTier): string {
  if (goal.includes("<<badplan>>")) {
    // deliberately unparseable, EVERY time — the caller's one retry cannot fix it
    return '```json\n{"name": "broken plan", "nodes": [{"id": "oops"\n```';
  }
  const roster = planRoster(system).sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
  const cheap = roster[0]?.name ?? "unknown-agent";
  const mid = roster[Math.floor((roster.length - 1) / 2)]?.name ?? cheap;
  const [kw1, kw2] = planKeywords(goal);
  const topic = mockTopic(goal.replace(/<<[^>]*>>/g, " ").trim());
  const slug1 = planSlug(kw1);
  let slug2 = planSlug(kw2);
  if (slug2 === slug1) slug2 = `${slug2}-2`;
  const rogue = goal.includes("<<rogueagent>>");

  // §5.1 Team-Lead delegation demo hook: "<<lead-plan>>" deterministically
  // emits a TWO-LEVEL hierarchy — one lead coordinating two workers that
  // delegate to it via leadId — so the whole narrowing tier is demoable with
  // zero external keys. The lead declares allowedAgents = {cheap, mid} plus one
  // deliberately over-broad name outside the roster, so the gateway's
  // drop-and-record path is exercised; the two workers are owned by cheap/mid,
  // both inside the ceiling.
  if (goal.includes("<<lead-plan>>")) {
    const leadNodes = [
      {
        id: "coordinate",
        title: `Coordinate the ${topic} effort`,
        instruction: planInstruction(
          [
            `Coordinate the delivery of "${topic}" by delegating to the two worker tasks under you.`,
            `Hold the workers to the agent and tool ceiling declared here; do not let scope widen.`,
            `Reconcile the two tracks into one coherent result before reporting.`,
            `State explicitly whether the goal is met or what remains.`,
          ],
          tier,
        ),
        agent: cheap,
        dependsOn: [] as string[],
        allowedAgents: [cheap, mid, "shadow-unsanctioned-agent"],
      },
      {
        id: `build-${slug1}`,
        title: `Implement the ${kw1} changes`,
        instruction: planInstruction(
          [
            `Implement the ${kw1} portion under the coordinate lead, staying inside the delegated agent/tool ceiling.`,
            `Describe the change precisely enough for the lead to verify it.`,
            `Flag any deviation and the reason for it.`,
          ],
          tier,
        ),
        agent: mid,
        dependsOn: ["coordinate"],
        leadId: "coordinate",
      },
      {
        id: "verify",
        title: `Verify the ${topic} result`,
        instruction: planInstruction(
          [
            `Verify the combined result for "${topic}" against the coordinate lead's acceptance criteria.`,
            `Report each check with its outcome; never silently prefer one track.`,
            `State clearly whether the goal is met.`,
          ],
          tier,
        ),
        agent: cheap,
        dependsOn: [`build-${slug1}`],
        leadId: "coordinate",
      },
    ];
    return "```json\n" + JSON.stringify({ name: topic, nodes: leadNodes }, null, 2) + "\n```";
  }
  const nodes = [
    {
      id: "analyze-requirements",
      title: `Analyze the requirements for ${topic}`,
      instruction: planInstruction(
        [
          `Analyze the goal "${topic}" and enumerate every concrete requirement it implies, including constraints that are stated only indirectly.`,
          `Produce a short written analysis a downstream worker can act on without seeing the original goal.`,
          `Call out any ambiguity explicitly rather than resolving it silently.`,
          `Close with the acceptance criteria the final verification step should check against.`,
        ],
        tier,
      ),
      agent: cheap,
      dependsOn: [],
    },
    {
      id: `build-${slug1}`,
      title: `Implement the ${kw1} changes`,
      instruction: planInstruction(
        [
          `Implement the ${kw1} portion of the work described by the analysis task, keeping the change minimal and self-contained.`,
          `Describe the change precisely enough that a reviewer can verify it without further context.`,
          `State explicitly how each error case is handled.`,
          `Flag any deviation from the analysis and the reason for it.`,
        ],
        tier,
      ),
      agent: mid,
      dependsOn: ["analyze-requirements"],
    },
    {
      id: `build-${slug2}`,
      title: `Prepare the ${kw2} deliverable`,
      instruction: planInstruction(
        [
          `Prepare the ${kw2} deliverable independently of the other build task — the two run in parallel and must not assume each other's output.`,
          `Keep the result complete and reviewable on its own.`,
          `List anything the integration step must reconcile between the two parallel tracks.`,
          `Note any follow-up work that is out of scope here.`,
        ],
        tier,
      ),
      agent: rogue ? "shadow-unsanctioned-agent" : mid,
      dependsOn: ["analyze-requirements"],
    },
    {
      id: "integrate-verify",
      title: `Integrate and verify ${topic}`,
      instruction: planInstruction(
        [
          `Integrate the outputs of both parallel build tasks into one coherent result for ${topic}.`,
          `Verify the combined result against the acceptance criteria from the analysis task and report each check with its outcome.`,
          `Resolve any conflict between the two tracks explicitly, never by silently preferring one.`,
          `State clearly whether the goal is met or what remains.`,
        ],
        tier,
      ),
      agent: cheap,
      dependsOn: [`build-${slug1}`, `build-${slug2}`],
    },
  ];
  // fenced on purpose: callers must tolerate a code fence around the object
  return "```json\n" + JSON.stringify({ name: topic, nodes }, null, 2) + "\n```";
}

// ---------------------------------------------------------------------------
// Tool-using loop test hooks (pillar 7). Mirroring "<<refuse>>": an input
// containing "<<use-tool:NAME>>" makes the mock emit ONE tool_use for NAME on
// the turn it appears; once a tool_result rides in history the mock finalizes
// with a text answer that QUOTES the tool result, so the whole governed loop
// is demoable with zero external keys. "<<use-tool-loop:NAME>>" keeps
// requesting the tool on EVERY turn (never finalizes) — the deterministic way
// to exercise a node's maxTurns cap.
// ---------------------------------------------------------------------------

/** flatten a turn's content to plain text (text + tool_result bodies) so the
 * intent/tier/sentinel logic reads a string regardless of block vs string */
function mockBlockText(content: string | ModelContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : ""))
    .join(" ");
}

function mockHasToolResult(turns: ModelChatMessage[]): boolean {
  return turns.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
  );
}

function mockToolResults(turns: ModelChatMessage[]): string[] {
  return turns.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : []))
      : [],
  );
}

export class MockModelProvider implements ModelProvider {
  readonly kind = "mock" as const;
  readonly dispatches: MockDispatch[] = [];
  private seq = 0;

  async dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    const seq = ++this.seq;
    this.dispatches.push({ ...req, seq });
    // Multi-turn: intent/tier/refusal dispatch on the LAST user turn (input
    // is ignored when messages is present, per the request contract), while
    // measured input tokens cover the WHOLE history — context costs what it
    // costs. With no messages both reduce exactly to the single-input path.
    const turns = chatTurns(req);
    const lastUserIdx = turns.map((m) => m.role).lastIndexOf("user");
    const lastUser = lastUserIdx >= 0 ? mockBlockText(turns[lastUserIdx]!.content) : "";
    const historyText = turns.map((m) => mockBlockText(m.content)).join("\n");
    if (lastUser.includes("<<refuse>>")) {
      return {
        outputText: "",
        stopReason: "refusal",
        refusal: true,
        usage: { inputTokens: mockTokens(historyText), outputTokens: 0 },
        providerMessageId: `mock-msg-${seq}`,
      };
    }

    // Test/demo affordance for §8.4 OUTPUT-side PII enforcement: the sentinel
    // itself carries NO PII pattern (so an INPUT PII check passes it through),
    // but the reply emits a well-known INVALID test SSN — letting a suite
    // exercise the OUTPUT bill-and-withhold path deterministically. Never real
    // PII. Mirrors the "<<refuse>>" / "<<use-tool:…>>" sentinels above.
    if (lastUser.includes("<<emit-ssn>>")) {
      const outputText = "For your records, the flagged identifier is 123-45-6789 — handle per policy.";
      if (req.onText) {
        const chunkSize = 40;
        for (let i = 0; i < outputText.length; i += chunkSize) {
          req.onText(outputText.slice(i, i + chunkSize));
        }
      }
      return {
        outputText,
        stopReason: "end_turn",
        refusal: false,
        usage: { inputTokens: mockTokens(historyText), outputTokens: mockTokens(outputText) },
        providerMessageId: `mock-msg-${seq}`,
      };
    }

    // Tool-using loop (pillar 7). "<<refuse>>" already took precedence above.
    // The loop sentinel keeps requesting the tool every turn; the once sentinel
    // requests it until a tool_result comes back, then finalizes. Detection
    // reads the WHOLE history text (the instruction turn persists across
    // iterations), gated on tool_result presence for the once case.
    const loopMatch = historyText.match(/<<use-tool-loop:([A-Za-z0-9_.-]+)>>/);
    const onceMatch = historyText.match(/<<use-tool:([A-Za-z0-9_.-]+)>>/);
    const toolResultSeen = mockHasToolResult(turns);
    const wantTool = loopMatch ?? (!toolResultSeen ? onceMatch : null);
    if (wantTool) {
      // one deterministic tool_use, canned empty args — a governed loop turns
      // this into a re-checked tool call, then feeds the result back
      return {
        outputText: "",
        stopReason: "tool_use",
        refusal: false,
        toolCalls: [{ id: `mock-tool-${seq}`, name: wantTool[1]!, arguments: {} }],
        usage: { inputTokens: mockTokens(historyText), outputTokens: 1 },
        providerMessageId: `mock-msg-${seq}`,
      };
    }
    if (toolResultSeen) {
      // finalize: a plain text answer that QUOTES the tool result(s) so the
      // loop's demo visibly proves the tool output flowed back into the model
      const quoted = mockToolResults(turns).join(" | ");
      const finalText =
        `Tool call complete — the tool returned: ${quoted}. ` +
        `Final answer for "${mockTopic(lastUser || historyText)}" incorporating that result.`;
      if (req.onText) {
        const chunkSize = 40;
        for (let i = 0; i < finalText.length; i += chunkSize) {
          req.onText(finalText.slice(i, i + chunkSize));
        }
      }
      return {
        outputText: finalText,
        stopReason: "end_turn",
        refusal: false,
        usage: { inputTokens: mockTokens(historyText), outputTokens: mockTokens(finalText) },
        providerMessageId: `mock-msg-${seq}`,
      };
    }
    // A short continuation opener whenever real history precedes the newest
    // turn; a terse follow-up additionally inherits the previous user turn's
    // topic — "now make it shorter" answers about the earlier subject, not
    // about the four words themselves.
    let topicSource = lastUser;
    let continuation = "";
    if (turns.length > 1) {
      const prevUser = turns
        .slice(0, Math.max(lastUserIdx, 0))
        .reverse()
        .find((m) => m.role === "user");
      const terse =
        lastUser.trim().split(/\s+/).filter(Boolean).length < TERSE_FOLLOW_UP_WORDS;
      if (terse && prevUser) topicSource = mockBlockText(prevUser.content);
      const n = turns.length - 1;
      continuation =
        `Continuing from the previous ${n} turn${n === 1 ? "" : "s"}` +
        (terse && prevUser ? `, still on ${mockTopic(mockBlockText(prevUser.content))}:` : ":");
    }
    // Planning requests answer with ONLY the JSON plan (tolerably fenced) —
    // no system-ack or continuation opener, since the caller machine-parses
    // the reply. Compaction requests answer with ONLY the deterministic
    // summary — same reasoning: the caller persists the reply verbatim.
    // Streaming and usage accounting stay on the shared path.
    const planning = req.system?.includes(TASK_DECOMPOSITION_SENTINEL) ?? false;
    const compacting = req.system?.includes(CONVERSATION_COMPACTION_SENTINEL) ?? false;
    const outputText = planning
      ? mockDecompositionReply(lastUser, req.system!, mockTier(req.model))
      : compacting
        ? mockCompactionSummary(lastUser)
        : [
            ...(req.system ? [mockSystemAck(req.system)] : []),
            ...(continuation ? [continuation] : []),
            mockReplyBody(mockIntent(lastUser), mockTier(req.model), mockTopic(topicSource)),
          ].join("\n\n");
    if (req.onText) {
      // deterministic chunking so the streaming path is testable end-to-end
      const chunkSize = 40;
      for (let i = 0; i < outputText.length; i += chunkSize) {
        req.onText(outputText.slice(i, i + chunkSize));
      }
    }
    return {
      outputText,
      stopReason: "end_turn",
      refusal: false,
      usage: { inputTokens: mockTokens(historyText), outputTokens: mockTokens(outputText) },
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
    case "xai":
      if (!config.apiKey) {
        throw new ModelProviderError("xai requires an apiKey");
      }
      return new XaiProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "mock":
      return sharedMock;
  }
}
