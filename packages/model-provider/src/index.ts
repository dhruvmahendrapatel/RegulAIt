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

export const MODEL_PROVIDER_KINDS = [
  "anthropic",
  "openai",
  "google",
  "xai",
  // ADR-0034: an ADMIN-REGISTERED endpoint the platform ships no adapter for
  // (Ollama, vLLM, LM Studio, LocalAI, Azure OpenAI, a Bedrock proxy, an
  // internal gateway). It is a KIND, not a vendor — which endpoint is a
  // separate FK on the agent row, so this stays a closed vocabulary.
  "custom",
  // ADR-0065: a model TRAINED BY THIS DEPLOYMENT — a RegulAIt-LLM artifact
  // registered for inference. It is a kind rather than a vendor for the same
  // reason 'custom' is: which artifact serves is a separate FK on the agent
  // row, so this stays a closed vocabulary. It makes NO network call of its
  // own (the artifact is queried in-process), which is why
  // `defaultBaseUrlFor` returns null for it and why the credential path skips
  // it entirely — there is no vendor to hold a key for.
  //
  // `resolveTrainingBackend`'s `ArtifactModelProvider` (in
  // @regulait/training-provider) is the implementation; this package
  // deliberately does not import it, because the artifact has to be LOADED
  // from the database before it can be served and only the gateway can do
  // that. `resolveModelProvider` therefore refuses this kind explicitly
  // rather than silently returning something inert — see the case below.
  "regulait_llm",
  "mock",
] as const;
export type ModelProviderKind = (typeof MODEL_PROVIDER_KINDS)[number];

export function isModelProviderKind(value: string): value is ModelProviderKind {
  return (MODEL_PROVIDER_KINDS as readonly string[]).includes(value);
}

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
 * is the following user turn carrying that tool's output back into history;
 * image / document carry a user-uploaded attachment (base64) so a turn can be
 * multimodal — a photo/screenshot the model sees as vision, or a PDF it reads
 * as a document. Providers without native vision degrade these to a short text
 * placeholder rather than dropping them silently.
 * thinking / redacted_thinking carry an earlier assistant turn's extended-
 * thinking blocks back through a multi-turn history: the Anthropic adapter
 * round-trips them natively (signature intact — required for verification);
 * every other adapter SKIPS them, which mirrors the vendors' own behaviour of
 * stripping prior-turn thinking rather than feeding it back as prose.
 * Together they let a tool-using loop append turns across iterations. */
export type ModelContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string; name?: string }
  | { type: "document"; mediaType: string; dataBase64: string; name?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string };

/** ADR-0020 long tail — the neutral tool_choice contract. "auto" lets the
 * model decide, "none" forbids tool calls, "required" forces SOME tool call,
 * `{name}` forces THAT tool. Every adapter has a real native mapping (see the
 * per-adapter tables); anything a provider dialect can express beyond this
 * (e.g. Anthropic's disable_parallel_tool_use=true) is NOT representable here
 * and must fail loudly upstream rather than be dropped. */
export type ModelToolChoice = "auto" | "none" | "required" | { name: string };

/** ADR-0020 long tail — structured outputs, in the OpenAI response_format
 * dialect's terms because that is the surface that speaks it. json_object
 * constrains the model to emit valid JSON; json_schema additionally pins the
 * shape. Honoured only by adapters with a NATIVE mechanism (OpenAI/xAI
 * response_format, Google responseMimeType/responseSchema, mock echo);
 * the Anthropic adapter has none and callers must 400 rather than pretend
 * a prompt nudge is a guarantee. */
export type ModelResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; name?: string; schema: Record<string, unknown>; strict?: boolean };

/** An extended-thinking block on a RESULT: what the model reasoned before
 * answering. `signature` is the provider's verification token and must be
 * carried back verbatim when the block is replayed into history. */
export type ModelThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

/** A short human-readable stand-in for an attachment on providers that can't
 * take the bytes natively (mock, and the chat-completions/Gemini text join).
 * Never fabricates content — it only names what was attached. */
function attachmentPlaceholder(b: Extract<ModelContentBlock, { type: "image" | "document" }>): string {
  return `[attached ${b.type}${b.name ? `: ${b.name}` : ""}]`;
}

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
  /** pillar-6 prompt caching: when true AND `system` is present, the adapter
   * marks the system prefix cacheable (Anthropic cache_control ephemeral) so a
   * repeat dispatch reusing it reads it from cache. Adapters without an
   * explicit cache-control mechanism (OpenAI/xAI auto-cache; Google) treat this
   * as a no-op. Purely a cost annotation — never changes the model or output. */
  cacheSystem?: boolean;
  maxTokens?: number;
  /** tools the model may call this turn (pillar 7). When absent, the request
   * is byte-identical to the tool-free contract — no adapter sends a `tools`
   * field. When present, a model may answer with stopReason "tool_use" and
   * `toolCalls`, which the caller executes and feeds back as tool_result
   * turns. */
  tools?: ModelToolDef[];
  /** ADR-0020 long tail: constrain WHICH tools the model may/must call this
   * turn. When absent the request is byte-identical to the pre-toolChoice
   * contract. Callers are responsible for only naming tools present in
   * `tools` — adapters map, they do not validate. */
  toolChoice?: ModelToolChoice;
  /** ADR-0020 long tail: structured-output constraint. Only set on adapters
   * with a native mechanism (openai / xai / google / mock); the Anthropic
   * adapter throws rather than degrade it to an unenforced prompt nudge. */
  responseFormat?: ModelResponseFormat;
  /** ADR-0020 long tail: Anthropic extended thinking with an explicit token
   * budget. Only set on adapters that implement it (anthropic / mock);
   * callers must fail a request loudly rather than pass this to an adapter
   * that would drop it. Thinking tokens are OUTPUT tokens in the provider's
   * own accounting — usage.outputTokens already includes them. */
  thinking?: { budgetTokens: number };
  /** streaming: called with each text delta as it arrives. The returned
   * result is still the COMPLETE message — accounting and refusal handling
   * are identical to the non-streaming path. */
  onText?: (delta: string) => void;
  /** streaming (thinking): called with each thinking delta, and once with the
   * block's signature when the provider emits it. Only fires on adapters that
   * implement `thinking`. */
  onThinking?: (delta: { thinking?: string; signature?: string }) => void;
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
  /** present only when the request enabled extended thinking AND the model
   * emitted thinking content: the thinking / redacted_thinking blocks, in
   * order, with signatures intact so a caller can replay them into the next
   * turn's history. Usage note: the tokens these represent are already
   * inside `usage.outputTokens` (the provider bills thinking as output). */
  thinking?: ModelThinkingBlock[];
  /** MEASURED by the provider, never estimated here. `reasoningTokens` is
   * present only when the provider reports a distinct reasoning-token count
   * (OpenAI Responses API `output_tokens_details.reasoning_tokens`). Honesty
   * note: OpenAI's own `output_tokens` already INCLUDES reasoning tokens —
   * that is the provider's billed output total, so `outputTokens` carries it
   * unchanged, and `reasoningTokens` surfaces the reasoning SUBSET distinctly
   * rather than folding it in silently. Never add the two together. */
  usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number };
  /** provider-side message/request identifier for cross-system audit joins */
  providerMessageId: string | null;
  /** ADR-0175 A4 — THE MODEL THE PROVIDER SAYS IT SERVED, verbatim from the
   * response (Anthropic / OpenAI / OpenAI-compatible `model`, Google
   * `modelVersion`). It can differ from the requested id: an alias resolves
   * to a dated snapshot, or a provider swaps what an alias means. Null (or
   * absent, for adapters outside this package) when the response does not
   * say — NEVER filled in from the request, because a guess here would hide
   * exactly the change this field exists to show. */
  servedModel?: string | null;
}

/** the provider-reported model id, or null — a blank or non-string value is
 * "not reported", never coerced */
function reportedModel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
      timeout: modelDispatchTimeout(),
    });
  }

  async dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    const params = {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      // pillar-6 prompt caching: when the caller asks to cache the system
      // prefix, send `system` as a single text block carrying an ephemeral
      // cache_control breakpoint (the SDK accepts either a string or a text
      // block array). Absent cacheSystem, `system` stays a plain string —
      // byte-identical to the pre-caching request.
      ...(req.system
        ? {
            system: req.cacheSystem
              ? ([
                  { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
                ] as Anthropic.TextBlockParam[])
              : req.system,
          }
        : {}),
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
      // ADR-0020 long tail: the neutral tool_choice maps 1:1 onto Anthropic's
      // four native shapes — auto / none / any (our "required") / tool+name.
      ...(req.toolChoice ? { tool_choice: anthropicToolChoice(req.toolChoice) } : {}),
      // ADR-0020 long tail: extended thinking is a REAL Anthropic parameter;
      // the response's thinking blocks are surfaced on the result and the
      // provider's own usage already counts them as output tokens.
      ...(req.thinking
        ? { thinking: { type: "enabled" as const, budget_tokens: req.thinking.budgetTokens } }
        : {}),
    };
    if (req.responseFormat) {
      // No native structured-output mechanism exists on the Messages API. A
      // system-prompt nudge cannot GUARANTEE valid JSON the way OpenAI's json
      // mode does, and a forced-single-tool emulation reshapes the response
      // (tool_use instead of text; breaks text-delta streaming) — neither is
      // a faithful mapping, so this adapter fails loudly instead of
      // pretending. Callers must route responseFormat away before dispatch.
      throw new ModelProviderError(
        "anthropic dispatch does not support responseFormat: the Messages API has no native " +
          "structured-output mechanism, and RegulAIt will not degrade a guarantee to a prompt nudge",
      );
    }
    // stream when the caller wants deltas, or when the output budget is large
    // enough that a single non-streaming request risks a timeout
    const useStream =
      req.onText !== undefined ||
      req.onThinking !== undefined ||
      params.max_tokens > STREAM_THRESHOLD_TOKENS;
    let msg: Anthropic.Message;
    try {
      if (useStream) {
        const stream = this.client.messages.stream(params);
        if (req.onText) stream.on("text", (delta) => req.onText!(delta));
        if (req.onThinking) {
          stream.on("thinking", (delta) => req.onThinking!({ thinking: delta }));
          stream.on("signature", (signature) => req.onThinking!({ signature }));
        }
        msg = await stream.finalMessage();
      } else {
        msg = await this.client.messages.create(params);
      }
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        throw new ModelProviderError(
          `anthropic dispatch failed: ${err.message}`,
          typeof err.status === "number" ? err.status : undefined,
          { cause: err },
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
    // thinking / redacted_thinking blocks surface on the result IN ORDER with
    // signatures intact, so a caller can replay them into the next turn's
    // history verbatim (Anthropic verifies the signature on replay).
    const thinkingBlocks: ModelThinkingBlock[] = msg.content.flatMap((b): ModelThinkingBlock[] =>
      b.type === "thinking"
        ? [{ type: "thinking" as const, thinking: b.thinking, signature: b.signature }]
        : b.type === "redacted_thinking"
          ? [{ type: "redacted_thinking" as const, data: b.data }]
          : [],
    );
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
      ...(thinkingBlocks.length > 0 ? { thinking: thinkingBlocks } : {}),
      usage: {
        // honesty note: output_tokens is Anthropic's own billed output total,
        // which INCLUDES thinking tokens — carried unchanged, never re-derived
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
      },
      providerMessageId: msg.id ?? null,
      servedModel: reportedModel(msg.model),
    };
  }
}

/** neutral tool_choice -> Anthropic's native shape (1:1, no loss) */
function anthropicToolChoice(tc: ModelToolChoice): Anthropic.ToolChoice {
  if (tc === "auto") return { type: "auto" };
  if (tc === "none") return { type: "none" };
  if (tc === "required") return { type: "any" };
  return { type: "tool", name: tc.name };
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
    // Native multimodal: Claude takes images (vision) and PDFs (documents) as
    // base64 source blocks. This is the one provider that sees the real bytes.
    if (b.type === "image") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: b.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: b.dataBase64,
        },
      };
    }
    if (b.type === "document") {
      return {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: b.dataBase64 },
      };
    }
    if (b.type === "tool_use") {
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    }
    // Native thinking round-trip: an earlier assistant turn's thinking blocks
    // ride back verbatim, signature included (Anthropic verifies it on replay).
    if (b.type === "thinking") {
      return { type: "thinking", thinking: b.thinking, signature: b.signature ?? "" };
    }
    if (b.type === "redacted_thinking") {
      return { type: "redacted_thinking", data: b.data };
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
      .map((b) =>
        b.type === "text"
          ? b.text
          : b.type === "image" || b.type === "document"
            ? attachmentPlaceholder(b)
            : "",
      )
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

/** neutral tool_choice -> the chat-completions shape (1:1, no loss) */
function openAiToolChoice(
  tc: ModelToolChoice,
): NonNullable<OpenAI.Chat.Completions.ChatCompletionCreateParams["tool_choice"]> {
  if (typeof tc === "string") return tc;
  return { type: "function", function: { name: tc.name } };
}

/** neutral responseFormat -> the chat-completions response_format (native
 * passthrough — this IS the dialect the neutral shape was modeled on) */
function openAiResponseFormat(
  rf: ModelResponseFormat,
): NonNullable<OpenAI.Chat.Completions.ChatCompletionCreateParams["response_format"]> {
  if (rf.type === "json_object") return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: {
      name: rf.name ?? "response",
      schema: rf.schema,
      ...(rf.strict !== undefined ? { strict: rf.strict } : {}),
    },
  };
}

/** ADR-0020 long tail: `thinking` is Anthropic-only. An adapter that cannot
 * honour it must FAIL LOUDLY, never drop it — a silently-vanished thinking
 * budget would change what the model does without the caller learning. */
function rejectThinking(req: ModelDispatchRequest, label: string): void {
  if (req.thinking) {
    throw new ModelProviderError(
      `${label} dispatch does not support 'thinking': extended thinking has no native mapping ` +
        `on this provider, and RegulAIt never silently drops a field that changes what the model does`,
    );
  }
}

/** The chat-completions dispatch core, shared by every OpenAI-compatible
 * provider (OpenAI itself, xAI). `label` only flavors error messages. */
async function dispatchChatCompletions(
  client: OpenAI,
  req: ModelDispatchRequest,
  label: string,
): Promise<ModelDispatchResult> {
  rejectThinking(req, label);
  const messages = [
      // pillar-6 prompt caching: `req.cacheSystem` is intentionally ignored on
      // the OpenAI-compatible family — OpenAI/xAI auto-cache long prompt
      // prefixes and expose no explicit ephemeral cache-control breakpoint, so
      // the system message rides as a plain string exactly as before.
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
    // ADR-0020 long tail: native passthrough — the OpenAI dialect is the one
    // the neutral toolChoice / responseFormat shapes were modeled on.
    const choiceParam = req.toolChoice ? { tool_choice: openAiToolChoice(req.toolChoice) } : {};
    const formatParam = req.responseFormat
      ? { response_format: openAiResponseFormat(req.responseFormat) }
      : {};
    try {
      if (req.onText !== undefined || maxTokens > STREAM_THRESHOLD_TOKENS) {
        const stream = await client.chat.completions.create({
          model: req.model,
          max_completion_tokens: maxTokens,
          messages,
          ...toolParam,
          ...choiceParam,
          ...formatParam,
          stream: true,
          stream_options: { include_usage: true },
        });
        let text = "";
        let refusalText = "";
        let finishReason: string | null = null;
        let id: string | null = null;
        let servedModel: string | null = null;
        let usage = { inputTokens: 0, outputTokens: 0 };
        // tool_calls arrive fragmented across deltas, keyed by index
        const toolAcc = new Map<number, { id: string; name: string; args: string }>();
        for await (const chunk of stream) {
          id = id ?? chunk.id ?? null;
          servedModel = servedModel ?? reportedModel(chunk.model);
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
          servedModel,
        };
      }

      const res = await client.chat.completions.create({
        model: req.model,
        max_completion_tokens: maxTokens,
        messages,
        ...toolParam,
        ...choiceParam,
        ...formatParam,
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
        servedModel: reportedModel(res.model),
      };
  } catch (err) {
    if (err instanceof OpenAI.APIError) {
      throw new ModelProviderError(
        `${label} dispatch failed: ${err.message}`,
        typeof err.status === "number" ? err.status : undefined,
        { cause: err },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// OpenAI Responses API surface.
//
// Selection rule (explicit and conservative, behavior-preserving): a request
// routes to `client.responses.create` ONLY when its model id is on the static
// OPENAI_RESPONSES_ONLY_MODELS list below — the ids OpenAI serves EXCLUSIVELY
// through the Responses API, which today 404 on chat.completions and therefore
// cannot have been working on the existing path. Every other model id —
// including every chat-capable gpt-4*/gpt-5*/o1/o3/o4-mini id currently in
// use — keeps the EXISTING chat-completions path byte-for-byte; no model that
// works today changes path silently. Extending Responses coverage to a
// chat-capable model is a deliberate future edit to this list, never an
// inference. The xAI adapter never consults this list: Grok speaks
// chat-completions only.
// ---------------------------------------------------------------------------

/** Model ids (exact, or `<id>-` dated/variant prefixes) that OpenAI serves
 * only via the Responses API. Deliberately narrow — see the selection rule
 * above before adding anything chat-capable. */
export const OPENAI_RESPONSES_ONLY_MODELS = [
  "o1-pro",
  "o3-pro",
  "gpt-5-pro",
  "gpt-5-codex",
  "o3-deep-research",
  "o4-mini-deep-research",
  "codex-mini-latest",
  "computer-use-preview",
] as const;

/** The selection predicate: exact id or a dated/variant suffix of a listed id
 * (e.g. "o3-pro-2025-06-10"). Everything else stays on chat completions. */
export function openAiUsesResponsesApi(model: string): boolean {
  return OPENAI_RESPONSES_ONLY_MODELS.some((m) => model === m || model.startsWith(`${m}-`));
}

/** Flatten our neutral turns onto Responses-API input items. A text turn maps
 * to a `message` item (role preserved — user/assistant both exist here). A
 * block-array turn can expand: its text rides as a message item, each
 * tool_use block becomes a top-level `function_call` item, and each
 * tool_result block becomes a `function_call_output` item keyed by the same
 * call_id — the Responses API carries tool traffic as sibling items, not as
 * message content. Attachments degrade to the same named text placeholder as
 * the chat-completions path. */
function openAiResponsesInput(turns: ModelChatMessage[]): OpenAI.Responses.ResponseInputItem[] {
  const out: OpenAI.Responses.ResponseInputItem[] = [];
  for (const m of turns) {
    if (typeof m.content === "string") {
      out.push({ type: "message", role: m.role, content: m.content });
      continue;
    }
    const text = m.content
      .map((b) =>
        b.type === "text"
          ? b.text
          : b.type === "image" || b.type === "document"
            ? attachmentPlaceholder(b)
            : "",
      )
      .join("");
    if (text) out.push({ type: "message", role: m.role, content: text });
    for (const b of m.content) {
      if (b.type === "tool_use") {
        out.push({
          type: "function_call",
          call_id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        });
      } else if (b.type === "tool_result") {
        out.push({ type: "function_call_output", call_id: b.toolUseId, output: b.content });
      }
    }
  }
  return out;
}

/** Normalize a terminal Responses-API `Response` object onto the neutral
 * result — shared by the non-streaming path and the streaming path's final
 * snapshot so both agree exactly.
 *
 * Stop-reason mapping: a refusal content part or `incomplete_details.reason
 * = "content_filter"` → refusal (content suppressed, as everywhere else);
 * any `function_call` output item → tool_use; `incomplete_details.reason =
 * "max_output_tokens"` → max_tokens; status "completed" → end_turn;
 * anything else → other. */
function normalizeOpenAiResponse(res: OpenAI.Responses.Response): ModelDispatchResult {
  let text = "";
  let refusal = false;
  const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
  for (const item of res.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") text += part.text;
        else if (part.type === "refusal") refusal = true;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({ id: item.call_id, name: item.name, arguments: parseJsonArgs(item.arguments) });
    }
  }
  const incompleteReason = res.incomplete_details?.reason;
  if (incompleteReason === "content_filter") refusal = true;
  const stopReason: ModelDispatchResult["stopReason"] = refusal
    ? "refusal"
    : toolCalls.length > 0
      ? "tool_use"
      : incompleteReason === "max_output_tokens"
        ? "max_tokens"
        : res.status === "completed"
          ? "end_turn"
          : "other";
  // usage honesty: output_tokens is OpenAI's billed output total (reasoning
  // INCLUDED, per their own accounting); reasoning_tokens is surfaced as the
  // distinct subset — never folded, never double-counted.
  const reasoningTokens = res.usage?.output_tokens_details?.reasoning_tokens ?? 0;
  return {
    // a refusal's content must never be surfaced as an answer
    outputText: refusal ? "" : text,
    stopReason,
    refusal,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    usage: {
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    },
    providerMessageId: res.id ?? null,
    servedModel: reportedModel(res.model),
  };
}

/** The Responses-API dispatch core. Same contract and discipline as
 * `dispatchChatCompletions`: complete result either way, refusals never
 * surfaced as answers, usage is the provider's own accounting, errors wrap
 * as ModelProviderError. `req.cacheSystem` stays a no-op here for the same
 * reason as the chat path — OpenAI auto-caches long prompt prefixes and
 * exposes no explicit cache-control breakpoint. */
async function dispatchResponses(
  client: OpenAI,
  req: ModelDispatchRequest,
  label: string,
): Promise<ModelDispatchResult> {
  rejectThinking(req, label);
  const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
  const params = {
    model: req.model,
    max_output_tokens: maxTokens,
    // system rides as `instructions` — the Responses API's native out-of-band
    // system slot, mirroring how Anthropic/Google carry it
    ...(req.system ? { instructions: req.system } : {}),
    input: openAiResponsesInput(chatTurns(req)),
    ...(req.tools
      ? {
          // Responses flattens the function fields (no nested `function`
          // object, unlike chat completions); strict:false because governed
          // MCP manifests carry arbitrary JSON Schema, not the strict subset
          tools: req.tools.map((t) => ({
            type: "function" as const,
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            parameters: t.inputSchema,
            strict: false,
          })),
        }
      : {}),
    // ADR-0020 long tail: same neutral shapes, Responses-native spellings —
    // tool_choice flattens the function name (no nested `function` object),
    // response_format rides as text.format.
    ...(req.toolChoice
      ? {
          tool_choice:
            typeof req.toolChoice === "string"
              ? req.toolChoice
              : ({ type: "function" as const, name: req.toolChoice.name } as OpenAI.Responses.ToolChoiceFunction),
        }
      : {}),
    ...(req.responseFormat
      ? {
          text: {
            format:
              req.responseFormat.type === "json_object"
                ? ({ type: "json_object" } as const)
                : {
                    type: "json_schema" as const,
                    name: req.responseFormat.name ?? "response",
                    schema: req.responseFormat.schema,
                    ...(req.responseFormat.strict !== undefined
                      ? { strict: req.responseFormat.strict }
                      : {}),
                  },
          },
        }
      : {}),
    // data minimization (pillar 1): the Responses API persists request/
    // response state server-side BY DEFAULT (store:true); this gateway is the
    // system of record for audit, so provider-side retention is opted out
    store: false,
  };
  try {
    if (req.onText !== undefined || maxTokens > STREAM_THRESHOLD_TOKENS) {
      const stream = await client.responses.create({ ...params, stream: true });
      let final: OpenAI.Responses.Response | null = null;
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          req.onText?.(event.delta);
        } else if (
          event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed"
        ) {
          // the terminal event carries the complete Response snapshot —
          // normalizing that keeps streaming and non-streaming byte-identical
          final = event.response;
        }
      }
      if (!final) {
        throw new ModelProviderError(
          `${label} dispatch failed: response stream ended without a terminal event`,
        );
      }
      return normalizeOpenAiResponse(final);
    }
    const res = await client.responses.create(params);
    return normalizeOpenAiResponse(res);
  } catch (err) {
    if (err instanceof OpenAI.APIError) {
      throw new ModelProviderError(
        `${label} dispatch failed: ${err.message}`,
        typeof err.status === "number" ? err.status : undefined,
        { cause: err },
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
      timeout: modelDispatchTimeout(),
    });
  }

  dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    // Responses-only models take the Responses surface; everything else keeps
    // the existing chat-completions path (see the selection rule above)
    return openAiUsesResponsesApi(req.model)
      ? dispatchResponses(this.client, req, "openai")
      : dispatchChatCompletions(this.client, req, "openai");
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
      timeout: modelDispatchTimeout(),
    });
  }

  dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    return dispatchChatCompletions(this.client, req, "xai");
  }
}

// ---------------------------------------------------------------------------
// Custom adapter (ADR-0034) — an ADMIN-REGISTERED OpenAI-compatible or
// Anthropic-Messages-compatible endpoint.
//
// This deliberately implements NO protocol of its own. `openai_chat` is the
// same `dispatchChatCompletions` core that already serves OpenAI and xAI,
// pointed at the admin's baseUrl; `anthropic_messages` delegates to the real
// `AnthropicProvider`. Streaming, refusal discipline, tool calls, usage
// accounting and error labelling are therefore identical to the shipped
// adapters by construction rather than by re-implementation — the only new
// behaviour on this path is WHERE the bytes go, which is precisely the part
// the egress guard governs.
//
// THE KEYLESS CASE. A local Ollama / LocalAI endpoint has no API key. The
// OpenAI SDK refuses to construct without one, so we pass a sentinel and then
// DELETE the Authorization header outright (openai-node treats a null default
// header as "remove"). The result is a request that carries no credential at
// all, rather than one that quietly ships the string "unused" to whatever the
// admin pointed us at.
// ---------------------------------------------------------------------------

export type CustomWireProtocol = "openai_chat" | "anthropic_messages";

export interface CustomAdapterOptions {
  /** null/absent = a keyless endpoint (local Ollama, LocalAI, an internal
   * gateway that authenticates by network position) */
  apiKey?: string | null;
  /** REQUIRED — a custom provider is nothing but its endpoint */
  baseUrl: string;
  wireProtocol: CustomWireProtocol;
  fetchImpl?: typeof fetch;
}

const KEYLESS_SENTINEL = "regulait-keyless";

export class CustomProvider implements ModelProvider {
  readonly kind = "custom" as const;
  /** set for anthropic_messages; null for openai_chat */
  private readonly anthropic: AnthropicProvider | null = null;
  /** set for openai_chat; null for anthropic_messages */
  private readonly openai: OpenAI | null = null;

  constructor(opts: CustomAdapterOptions) {
    if (!opts.baseUrl) {
      throw new ModelProviderError("custom provider requires a baseUrl");
    }
    if (opts.wireProtocol === "anthropic_messages") {
      this.anthropic = new AnthropicProvider({
        // the Anthropic SDK sends x-api-key; a keyless endpoint gets the
        // sentinel rather than a crash. Documented in ADR-0034: an
        // anthropic-dialect endpoint that needs no key is not a shape any
        // known deployment has, so it is not worth a header surgery path.
        apiKey: opts.apiKey ?? KEYLESS_SENTINEL,
        baseUrl: opts.baseUrl,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      return;
    }
    this.openai = new OpenAI({
      apiKey: opts.apiKey ?? KEYLESS_SENTINEL,
      baseURL: opts.baseUrl,
      // null removes the header entirely — a keyless endpoint sees no
      // Authorization at all, not a bogus bearer token
      ...(opts.apiKey ? {} : { defaultHeaders: { Authorization: null } }),
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
      maxRetries: 2,
      timeout: modelDispatchTimeout(),
    });
  }

  dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    if (this.openai) return dispatchChatCompletions(this.openai, req, "custom");
    if (this.anthropic) return this.anthropic.dispatch(req);
    // unreachable — the constructor sets exactly one of the two
    throw new ModelProviderError("custom provider has no wire adapter");
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
  /** ADR-0175 A4: the model version that served, as Gemini reports it */
  modelVersion?: string;
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** JSON-Schema keywords Gemini's Schema dialect shares verbatim — everything
 * else must be translated or DROPPED, because generateContent's strict proto
 * parsing rejects unknown fields with a 400 (so `additionalProperties`,
 * `$schema`, `$defs`/`$ref`, `allOf`, … cannot pass through). `nullable`,
 * `type`, `const`, and the structural keywords are handled explicitly in
 * googleSchema. */
const GOOGLE_SCHEMA_PASSTHROUGH_KEYS = [
  "description",
  "format",
  "title",
  "enum",
  "required",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minProperties",
  "maxProperties",
  "pattern",
  "default",
  "example",
  "propertyOrdering",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Translate a JSON-Schema object (the MCP-manifest dialect our ModelToolDef
 * carries) into Gemini's Schema dialect (an OpenAPI-3.0 subset):
 * - `type` becomes the uppercase enum Gemini's proto expects (OBJECT, STRING,
 *   …). A JSON-Schema union type `["string","null"]` — which Gemini cannot
 *   express as a type — becomes the single non-null type plus
 *   `nullable: true`, Gemini's own nullability mechanism; a bare
 *   `type:"null"` degrades to `nullable: true` alone.
 * - `properties` / `items` / `anyOf` recurse; a JSON-Schema tuple `items`
 *   array collapses to its first schema (Gemini has no tuple form); `oneOf`
 *   approximates as `anyOf` (the closest Gemini construct).
 * - `const` becomes a single-value `enum` (Gemini has no const).
 * - `required`, `enum`, and the shared scalar keywords pass through; every
 *   unsupported keyword is dropped so the request cannot 400 on an unknown
 *   field. Caveat: Gemini only supports `enum` on STRING-typed schemas —
 *   values pass through untouched, so non-string enums remain the caller's
 *   responsibility. */
function googleSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return {};
  const out: Record<string, unknown> = {};
  let type = schema.type;
  let nullable = schema.nullable === true;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null");
    if (nonNull.length < type.length) nullable = true;
    type = nonNull[0];
  }
  if (type === "null") {
    nullable = true;
  } else if (typeof type === "string") {
    out.type = type.toUpperCase();
  }
  if (nullable) out.nullable = true;
  for (const k of GOOGLE_SCHEMA_PASSTHROUGH_KEYS) {
    if (schema[k] !== undefined) out[k] = schema[k];
  }
  if (schema.const !== undefined && out.enum === undefined) out.enum = [schema.const];
  if (isRecord(schema.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, googleSchema(v)]),
    );
  }
  if (Array.isArray(schema.items)) {
    out.items = googleSchema(schema.items[0]);
  } else if (isRecord(schema.items)) {
    out.items = googleSchema(schema.items);
  }
  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (variants) out.anyOf = variants.map(googleSchema);
  return out;
}

/** Gemini pairs a functionResponse with its functionCall by the tool NAME
 * (and, for parallel calls, by part order within the turn). Our tool_result
 * block carries only the call id, so the id→name pairing is recovered from
 * the tool_use blocks earlier in the SAME history — the loop contract always
 * replays the assistant's tool_use turn before the tool_result turn. */
function googleToolNames(turns: ModelChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of turns) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use") names.set(b.id, b.name);
    }
  }
  return names;
}

/** Map our neutral content onto Gemini parts. A string stays one text part
 * (byte-identical to the tool-free path). An assistant turn's tool_use blocks
 * become functionCall parts (role "model" upstream); a user turn's
 * tool_result blocks become functionResponse parts (role "user" upstream —
 * the role Gemini requires function responses to ride in), keyed by the tool
 * NAME resolved via `toolNames`; parallel calls answer as multiple
 * functionResponse parts in the same turn, in call order. The functionResponse
 * body follows Gemini's documented convention: `{output: …}` for a success,
 * `{error: …}` for a failed call. An id with no matching tool_use in history
 * falls back to the raw id as the name (degraded, but never dropped). */
function googleParts(
  content: string | ModelContentBlock[],
  toolNames: Map<string, string>,
): Record<string, unknown>[] {
  if (typeof content === "string") return [{ text: content }];
  return content.flatMap((b): Record<string, unknown>[] => {
    if (b.type === "text") return [{ text: b.text }];
    if (b.type === "image" || b.type === "document") return [{ text: attachmentPlaceholder(b) }];
    // prior-turn thinking blocks are SKIPPED, mirroring the vendors' own
    // behaviour of stripping replayed thinking (never fed back as prose)
    if (b.type === "thinking" || b.type === "redacted_thinking") return [];
    if (b.type === "tool_use") {
      // Gemini's args is a Struct — always an object, never a scalar/array
      return [{ functionCall: { name: b.name, args: isRecord(b.input) ? b.input : {} } }];
    }
    return [
      {
        functionResponse: {
          name: toolNames.get(b.toolUseId) ?? b.toolUseId,
          response: b.isError ? { error: b.content } : { output: b.content },
        },
      },
    ];
  });
}

/** neutral tool_choice -> Gemini's functionCallingConfig (1:1: AUTO / NONE /
 * ANY, with a forced tool spelled as ANY restricted to one allowed name) */
function googleFunctionCallingConfig(tc: ModelToolChoice): Record<string, unknown> {
  if (tc === "auto") return { mode: "AUTO" };
  if (tc === "none") return { mode: "NONE" };
  if (tc === "required") return { mode: "ANY" };
  return { mode: "ANY", allowedFunctionNames: [tc.name] };
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
    rejectThinking(req, "google");
    const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    const useStream = req.onText !== undefined || maxTokens > STREAM_THRESHOLD_TOKENS;
    const method = useStream ? "streamGenerateContent?alt=sse" : "generateContent";
    const res = await this.fetchImpl(
      `${this.base}/models/${encodeURIComponent(req.model)}:${method}`,
      {
        method: "POST",
        headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          // Gemini's assistant role is "model"; tool_result turns stay role
          // "user" (the role Gemini requires functionResponse parts to ride
          // in), with each functionResponse re-keyed by tool NAME via the
          // id→name pairing recovered from the history's tool_use blocks
          contents: (() => {
            const toolNames = googleToolNames(chatTurns(req));
            return chatTurns(req).map((m) => ({
              role: m.role === "assistant" ? "model" : "user",
              parts: googleParts(m.content, toolNames),
            }));
          })(),
          // pillar-6 prompt caching: `req.cacheSystem` is intentionally ignored
          // here — the Gemini generateContent surface exposes no per-request
          // ephemeral cache-control breakpoint, so the systemInstruction is sent
          // unchanged.
          ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
          ...(req.tools
            ? {
                tools: [
                  {
                    // JSON Schema → Gemini's Schema dialect (see googleSchema).
                    // Gemini quirk: an OBJECT schema with no properties is
                    // rejected — a no-arg tool must OMIT `parameters` entirely.
                    functionDeclarations: req.tools.map((t) => {
                      const parameters = googleSchema(t.inputSchema);
                      const noArgs =
                        parameters.type === "OBJECT" &&
                        (!isRecord(parameters.properties) ||
                          Object.keys(parameters.properties).length === 0);
                      return {
                        name: t.name,
                        ...(t.description ? { description: t.description } : {}),
                        ...(noArgs ? {} : { parameters }),
                      };
                    }),
                  },
                ],
              }
            : {}),
          // ADR-0020 long tail: tool_choice maps onto Gemini's native
          // functionCallingConfig (AUTO / NONE / ANY [+allowedFunctionNames])
          ...(req.toolChoice
            ? { toolConfig: { functionCallingConfig: googleFunctionCallingConfig(req.toolChoice) } }
            : {}),
          generationConfig: {
            maxOutputTokens: maxTokens,
            // ADR-0020 long tail: structured outputs map onto Gemini's NATIVE
            // mechanism — responseMimeType for json_object, plus responseSchema
            // (translated to the Gemini Schema dialect exactly as tool schemas
            // are) for json_schema.
            ...(req.responseFormat
              ? {
                  responseMimeType: "application/json",
                  ...(req.responseFormat.type === "json_schema"
                    ? { responseSchema: googleSchema(req.responseFormat.schema) }
                    : {}),
                }
              : {}),
          },
        }),
      },
    ).catch((err: unknown) => {
      // AER-021: our deadline, not the vendor's failure. `deadlineBoundFetch`
      // arms an `AbortSignal.timeout`, so a hung endpoint rejects here — and
      // "we stopped waiting" must not be reported as "google failed", because
      // the two send an operator to different places.
      if (isModelDeadlineError(err)) {
        throw new ModelProviderError(
          `google dispatch exceeded the ${modelDispatchTimeout()}ms model deadline`,
          504,
          { cause: err },
        );
      }
      throw err;
    });
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
    let servedModel: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0 };
    const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
    const absorb = (chunk: GeminiChunk) => {
      id = id ?? chunk.responseId ?? null;
      servedModel = servedModel ?? reportedModel(chunk.modelVersion);
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

    // AER-021 — THE BODY IS INSIDE THE DEADLINE TOO, and this is the half a
    // naive fix misses. Headers arriving is not the end of the wait: the old
    // code could hang forever in `reader.read()` or `res.json()` on a response
    // that never finished. Because the signal handed to `fetch` also errors the
    // response BODY stream, the same deadline covers both — and a timeout here
    // is named as one rather than surfacing as a parse failure.
    try {
      if (useStream) {
        // incremental SSE parse so onText fires as chunks arrive
        const reader = res.body?.getReader();
        if (!reader) throw new ModelProviderError("google dispatch failed: empty stream body");
        try {
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
        } finally {
          // release the stream whether we finished, timed out or threw — a
          // half-read body left open is a held socket
          await reader.cancel().catch(() => {});
        }
      } else {
        absorb((await res.json()) as GeminiChunk);
      }
    } catch (err) {
      if (isModelDeadlineError(err)) {
        throw new ModelProviderError(
          `google dispatch exceeded the ${modelDispatchTimeout()}ms model deadline while reading the ` +
            `response body`,
          504,
          { cause: err },
        );
      }
      throw err;
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
      servedModel,
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
    .map((b) =>
      b.type === "text"
        ? b.text
        : b.type === "tool_result"
          ? b.content
          : b.type === "image" || b.type === "document"
            ? attachmentPlaceholder(b)
            : "",
    )
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

/** ADR-0175 A4 test/demo affordance: `<<serve-as:NAME>>` anywhere in the
 * conversation makes the mock REPORT that it served NAME instead of the
 * requested model — a provider silently swapping the model behind an id,
 * reproducible without a network. Same sentinel discipline as `<<refuse>>`. */
export const MOCK_SERVE_AS_SENTINEL = /<<serve-as:([^>\s]+)>>/;

export class MockModelProvider implements ModelProvider {
  readonly kind = "mock" as const;
  readonly dispatches: MockDispatch[] = [];
  private seq = 0;

  /** The mock reports a served model the way a real provider does: the
   * requested id, unless the `<<serve-as:NAME>>` sentinel asks it to report
   * a different one. */
  async dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    const result = await this.cannedDispatch(req);
    const swap = MOCK_SERVE_AS_SENTINEL.exec(chatTurns(req).map((m) => mockBlockText(m.content)).join("\n"));
    return { ...result, servedModel: swap ? swap[1]! : req.model };
  }

  private async cannedDispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
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

    // ADR-0066 §4 test/demo affordance: a genuine UPSTREAM/TRANSPORT failure,
    // the ONLY class of failure that may trigger a provider fallback chain.
    // Deliberately a thrown `ModelProviderError` and NOT a refusal — the whole
    // point of ADR-0066's rule 1 is that those two are different, and a suite
    // proving "a refusal does not fall back, an upstream error does" needs both
    // reachable without a network. Same sentinel discipline as `<<refuse>>` and
    // `<<emit-ssn>>` above: the mock never invents this.
    //
    // TWO FORMS, because a fallback test needs the primary to fail and the hop
    // to succeed on the SAME prompt (the chain re-sends the caller's input
    // verbatim, which is itself the correct behaviour):
    //   `<<upstream-error>>`            — every model fails (chain exhaustion)
    //   `<<upstream-error:some-model>>` — only that model id fails
    const scopedFailure = /<<upstream-error:([^>]+)>>/.exec(lastUser);
    if (scopedFailure ? scopedFailure[1]!.trim() === req.model : lastUser.includes("<<upstream-error>>")) {
      throw new ModelProviderError(`mock: simulated upstream failure for model '${req.model}'`, 503);
    }

    // ADR-0020 long tail: deterministic extended-thinking support so the
    // whole thinking path (blocks, signature, SSE deltas, ledger) is testable
    // with zero external keys. The thinking tokens are counted as OUTPUT
    // tokens, exactly the provider's own accounting convention.
    const thinkingOut: ModelThinkingBlock[] | undefined = req.thinking
      ? [
          {
            type: "thinking",
            thinking:
              `Thinking (budget ${req.thinking.budgetTokens}): weighing how to answer ` +
              `"${mockTopic(lastUser || historyText)}" within the given scope.`,
            signature: "mock-signature",
          },
        ]
      : undefined;
    const thinkingTokens = thinkingOut
      ? mockTokens(thinkingOut[0]!.type === "thinking" ? thinkingOut[0]!.thinking : "")
      : 0;
    const emitThinking = () => {
      if (!thinkingOut || !req.onThinking) return;
      const text = thinkingOut[0]!.type === "thinking" ? thinkingOut[0]!.thinking : "";
      const chunkSize = 40;
      for (let i = 0; i < text.length; i += chunkSize) {
        req.onThinking({ thinking: text.slice(i, i + chunkSize) });
      }
      req.onThinking({ signature: "mock-signature" });
    };

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
    // ADR-0020 long tail: toolChoice is honoured OBSERVABLY so e2e suites can
    // assert a real effect — "none" suppresses even a sentinel-requested tool
    // call; a named/{required} choice forces a tool_use with no sentinel at
    // all (falling back to the first declared tool for "required"). A forced
    // choice stops forcing once a tool_result is in history, so governed
    // loops still terminate.
    const choice = req.toolChoice;
    const forcedName =
      typeof choice === "object"
        ? choice.name
        : choice === "required"
          ? (req.tools?.[0]?.name ?? null)
          : null;
    const sentinelName = (loopMatch ?? (!toolResultSeen ? onceMatch : null))?.[1] ?? null;
    const wantToolName =
      choice === "none" ? null : (sentinelName ?? (!toolResultSeen ? forcedName : null));
    if (wantToolName) {
      // one deterministic tool_use, canned empty args — a governed loop turns
      // this into a re-checked tool call, then feeds the result back
      emitThinking();
      return {
        outputText: "",
        stopReason: "tool_use",
        refusal: false,
        toolCalls: [{ id: `mock-tool-${seq}`, name: wantToolName, arguments: {} }],
        ...(thinkingOut ? { thinking: thinkingOut } : {}),
        usage: { inputTokens: mockTokens(historyText), outputTokens: 1 + thinkingTokens },
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
      emitThinking();
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
        ...(thinkingOut ? { thinking: thinkingOut } : {}),
        usage: {
          inputTokens: mockTokens(historyText),
          outputTokens: mockTokens(finalText) + thinkingTokens,
        },
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
    // ADR-0020 long tail: responseFormat gets ECHO COMPLIANCE — the reply is
    // pure, parseable JSON (no ack/continuation prose, exactly as a real json
    // mode suppresses free text) naming which format was honoured and, for
    // json_schema, the schema name — so a suite can assert the constraint
    // flowed through end to end.
    const outputText = req.responseFormat
      ? JSON.stringify(
          req.responseFormat.type === "json_schema"
            ? {
                format: "json_schema",
                schema: req.responseFormat.name ?? "response",
                topic: mockTopic(topicSource),
              }
            : { format: "json_object", topic: mockTopic(topicSource) },
        )
      : planning
        ? mockDecompositionReply(lastUser, req.system!, mockTier(req.model))
        : compacting
          ? mockCompactionSummary(lastUser)
          : [
              ...(req.system ? [mockSystemAck(req.system)] : []),
              ...(continuation ? [continuation] : []),
              mockReplyBody(mockIntent(lastUser), mockTier(req.model), mockTopic(topicSource)),
            ].join("\n\n");
    emitThinking();
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
      ...(thinkingOut ? { thinking: thinkingOut } : {}),
      usage: {
        inputTokens: mockTokens(historyText),
        outputTokens: mockTokens(outputText) + thinkingTokens,
      },
      providerMessageId: `mock-msg-${seq}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ModelProviderConfig {
  provider: ModelProviderKind;
  /** required for real vendors; the mock needs none (air-gapped path), and a
   * 'custom' endpoint may genuinely be keyless (local Ollama / LocalAI) */
  apiKey?: string | null;
  baseUrl?: string | null;
  /** ADR-0034 — REQUIRED when provider === 'custom': which dialect the
   * admin-registered endpoint speaks. There is no default: guessing a wire
   * protocol would mean silently sending a request the endpoint cannot parse. */
  wireProtocol?: CustomWireProtocol | null;
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

/** shared mock instance so state persists across resolutions in one process */
const sharedMock = new MockModelProvider();

export function resolveModelProvider(
  config: ModelProviderConfig,
  fetchImpl?: typeof fetch,
): ModelProvider {
  // AER-021: bind the model deadline to the fetch ONCE, here, so every adapter
  // built through this funnel is bounded — including the raw-fetch ones and
  // including any added later. SDK-backed adapters also receive the number
  // through their constructor options; double-binding is harmless (whichever
  // deadline expires first wins, and they are the same number).
  const boundFetch = deadlineBoundFetch(fetchImpl ?? fetch);
  switch (config.provider) {
    case "anthropic":
      if (!config.apiKey) {
        throw new ModelProviderError("anthropic requires an apiKey");
      }
      return new AnthropicProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl ?? null,
        fetchImpl: boundFetch,
      });
    case "openai":
      if (!config.apiKey) {
        throw new ModelProviderError("openai requires an apiKey");
      }
      return new OpenAiProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl ?? null,
        fetchImpl: boundFetch,
      });
    case "google":
      if (!config.apiKey) {
        throw new ModelProviderError("google requires an apiKey");
      }
      return new GoogleProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl ?? null,
        fetchImpl: boundFetch,
      });
    case "xai":
      if (!config.apiKey) {
        throw new ModelProviderError("xai requires an apiKey");
      }
      return new XaiProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl ?? null,
        fetchImpl: boundFetch,
      });
    // ADR-0034: an admin-registered endpoint. NO API KEY IS REQUIRED — that is
    // the whole point of supporting local Ollama and air-gapped gateways — but
    // baseUrl and wireProtocol are, and their absence is a config error that
    // fails explicit rather than defaulting to somebody's SaaS.
    case "custom":
      if (!config.baseUrl) {
        throw new ModelProviderError("custom requires a baseUrl");
      }
      if (!config.wireProtocol) {
        throw new ModelProviderError("custom requires a wireProtocol (openai_chat | anthropic_messages)");
      }
      return new CustomProvider({
        apiKey: config.apiKey ?? null,
        baseUrl: config.baseUrl,
        wireProtocol: config.wireProtocol,
        fetchImpl: boundFetch,
      });
    // ADR-0065 — a locally trained artifact. It CANNOT be built from a config
    // object: serving it needs the artifact payload, which lives in the
    // database. The gateway loads it and constructs `ArtifactModelProvider`
    // itself, exactly as it does for a guarded 'custom' endpoint. Reaching
    // this line means an agent claimed the kind without the gateway having
    // resolved its artifact, and the honest answer is to say so loudly rather
    // than hand back something that would answer nothing.
    case "regulait_llm":
      throw new ModelProviderError(
        "regulait_llm agents are served from a stored training artifact, which the gateway resolves " +
          "before dispatch — this registry cannot construct one from configuration alone",
      );
    case "mock":
      return sharedMock;
  }
}

// ---------------------------------------------------------------------------
// ADR-0062 — THE COMPILED VENDOR DEFAULTS, MADE VISIBLE
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS. The ADR-0034/0043 egress guard adjudicates URLs a human
// typed. It never saw the endpoint an adapter falls back to when no `baseUrl`
// override exists, because "nobody can type a constant" is a complete answer to
// SSRF. It is NOT an answer to "may this deployment talk to that vendor at all",
// which is the question an AIR-GAPPED install is buying (ADR-0062).
//
// To adjudicate a compiled default you first have to be able to NAME it. Two of
// these four lived only inside a vendor SDK's own default, so this repo's
// `grep` for compiled absolute URLs (docs/deployment/DATA_BOUNDARY.md §1) did
// not list them — the destination was real and invisible at the same time. They
// are written down here so the set is complete and checkable.
//
// THE ENV VARS ARE PART OF THE ANSWER, not a footnote. `@anthropic-ai/sdk` and
// `openai` both read their own `*_BASE_URL` environment variable when no
// `baseURL` is passed, so on a box where one is set the SDK's real destination
// is that value, not the vendor. `defaultBaseUrlFor` therefore reads the same
// variables the SDK reads: what this function returns is what the adapter will
// actually reach, which is the only thing worth adjudicating. (The gateway's
// own env-key fallback ALREADY threads these into the guarded `baseUrl` path;
// this covers the remaining case of a stored credential with no override on a
// box that also sets the variable.)
//
// The literal constants are pinned against the SDKs' own defaults by a drift
// test in `index.test.ts` — a constant that silently stopped matching the SDK
// would make the guard adjudicate a host the adapter never contacts.

/** `@anthropic-ai/sdk`'s own default base URL. */
export const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";
/** `openai`'s own default base URL. */
export const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
export { GOOGLE_DEFAULT_BASE, XAI_DEFAULT_BASE };

/**
 * The endpoint a provider kind reaches when NO `baseUrl` override is supplied.
 *
 *   string     the destination, ready to be adjudicated against the egress
 *              allow-list;
 *   null       there is nothing to adjudicate — the adapter makes no network
 *              call of its own (`mock`, in-process) or cannot exist without an
 *              explicit, already-guarded `baseUrl` (`custom`, ADR-0034);
 *   undefined  NOT STATICALLY KNOWABLE. Reserved for a kind whose default this
 *              module cannot name. A caller under a strict posture must REFUSE
 *              on undefined rather than assume it is safe — "we could not work
 *              out where this goes" is not a reason to let it go there.
 *
 * `env` is injectable so the decision is testable without mutating the process.
 */
export function defaultBaseUrlFor(
  kind: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null | undefined {
  switch (kind) {
    case "anthropic":
      return env["ANTHROPIC_BASE_URL"] || ANTHROPIC_DEFAULT_BASE;
    case "openai":
      return env["OPENAI_BASE_URL"] || OPENAI_DEFAULT_BASE;
    case "google":
      return GOOGLE_DEFAULT_BASE;
    case "xai":
      return XAI_DEFAULT_BASE;
    case "custom":
    // ADR-0065: an artifact this deployment trained is queried IN-PROCESS.
    // There is no compiled vendor endpoint behind it, so there is nothing for
    // the ADR-0062 strict posture to adjudicate — the same answer `mock` gets,
    // and for the same reason. This is what makes a home-trained model usable
    // on an air-gapped install.
    case "regulait_llm":
    case "mock":
      return null;
    default:
      return undefined;
  }
}
