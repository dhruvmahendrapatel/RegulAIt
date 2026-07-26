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

/** One turn of a multi-turn conversation. `system` is deliberately NOT a
 * role here — it stays a separate ModelDispatchRequest field, because two of
 * the providers (Anthropic, Google) carry it out-of-band anyway. */
export interface ModelChatMessage {
  role: "user" | "assistant";
  content: string;
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
      // roles map 1:1 onto the Messages API
      messages: chatTurns(req).map((m) => ({ role: m.role, content: m.content })),
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

/** The chat-completions dispatch core, shared by every OpenAI-compatible
 * provider (OpenAI itself, xAI). `label` only flavors error messages. */
async function dispatchChatCompletions(
  client: OpenAI,
  req: ModelDispatchRequest,
  label: string,
): Promise<ModelDispatchResult> {
  const messages = [
      ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
      // system first (as today), then the ordered turns — assistant stays assistant
      ...chatTurns(req).map((m) => ({ role: m.role, content: m.content })),
    ];
    const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    try {
      if (req.onText !== undefined || maxTokens > STREAM_THRESHOLD_TOKENS) {
        const stream = await client.chat.completions.create({
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

      const res = await client.chat.completions.create({
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
          // Gemini's assistant role is "model"
          contents: chatTurns(req).map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
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
    const lastUser = lastUserIdx >= 0 ? turns[lastUserIdx]!.content : "";
    const historyText = turns.map((m) => m.content).join("\n");
    if (lastUser.includes("<<refuse>>")) {
      return {
        outputText: "",
        stopReason: "refusal",
        refusal: true,
        usage: { inputTokens: mockTokens(historyText), outputTokens: 0 },
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
      if (terse && prevUser) topicSource = prevUser.content;
      const n = turns.length - 1;
      continuation =
        `Continuing from the previous ${n} turn${n === 1 ? "" : "s"}` +
        (terse && prevUser ? `, still on ${mockTopic(prevUser.content)}:` : ":");
    }
    // Planning requests answer with ONLY the JSON plan (tolerably fenced) —
    // no system-ack or continuation opener, since the caller machine-parses
    // the reply. Streaming and usage accounting stay on the shared path.
    const planning = req.system?.includes(TASK_DECOMPOSITION_SENTINEL) ?? false;
    const outputText = planning
      ? mockDecompositionReply(lastUser, req.system!, mockTier(req.model))
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
