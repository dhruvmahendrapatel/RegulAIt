/**
 * ADR-0253 (P29) — the bridge between RegulAIt's neutral model contract and the
 * Vercel AI SDK's provider specification (`@ai-sdk/provider`, LanguageModelV4).
 *
 * WHAT THIS FILE IS. The AI SDK splits into a vendor-neutral SPEC
 * (`@ai-sdk/provider`), per-vendor IMPLEMENTATIONS of that spec (`@ai-sdk/google`,
 * `@ai-sdk/anthropic`, …) and an orchestration CORE (`ai`). We take the first two
 * and deliberately NOT the core: `ai` hard-depends on `@ai-sdk/gateway`, and a bare
 * string model id handed to it (`'openai/gpt-x'`) is routed to Vercel's hosted AI
 * Gateway. Without `ai` there is no string-id resolver to misuse — every model is a
 * provider INSTANCE we construct with our own key, base URL and guarded fetch.
 * `ai-sdk-guard.test.ts` keeps it that way.
 *
 * WHAT STAYS OURS. This file only translates shapes. Governance, cost attribution
 * (pillar 5 — the usage numbers each adapter reports are read from the VENDOR'S raw
 * usage block, not the SDK's re-summed view, so a bill is unchanged by the swap),
 * token optimisation (pillar 6) and audit all happen upstream in the gateway, which
 * sees only `ModelDispatchRequest` / `ModelDispatchResult` exactly as before.
 *
 * Telemetry: the provider packages have none. OpenTelemetry spans live in `ai`
 * core (`experimental_telemetry`, opt-in), which we do not install.
 */
import { APICallError } from "@ai-sdk/provider";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolChoice,
} from "@ai-sdk/provider";
import { ModelProviderError, isModelDeadlineError, modelDispatchTimeout } from "./core.js";
import type { ModelChatMessage, ModelContentBlock, ModelDispatchRequest } from "./index.js";

type V4UserPart = Extract<LanguageModelV4Message, { role: "user" }>["content"][number];
type V4AssistantPart = Extract<LanguageModelV4Message, { role: "assistant" }>["content"][number];
type V4ToolPart = Extract<LanguageModelV4Message, { role: "tool" }>["content"][number];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The effective ordered turn list (same precedence rule as every adapter:
 * `messages` verbatim when present, else `input` as one user turn). */
export function bridgeTurns(req: ModelDispatchRequest): ModelChatMessage[] {
  return req.messages && req.messages.length > 0 ? req.messages : [{ role: "user", content: req.input }];
}

export interface PromptOptions {
  /** how an image/document block reaches the model. "placeholder" names the
   * attachment in text (never fabricates content) — the behaviour the Gemini
   * adapter has always had. */
  attachments: "placeholder";
  /** Gemini's functionCall args is a Struct: a non-object input becomes `{}` */
  objectToolInput: boolean;
}

function attachmentText(b: Extract<ModelContentBlock, { type: "image" | "document" }>): string {
  return `[attached ${b.type}${b.name ? `: ${b.name}` : ""}]`;
}

/**
 * Neutral history → LanguageModelV4 prompt.
 *
 * Our contract carries tool results INSIDE a user turn (Anthropic's shape); the
 * spec carries them in a separate `tool` message. A user turn is therefore split
 * into consecutive runs — tool_result blocks become a `tool` message, everything
 * else a `user` message — preserving block order. The tool NAME a result needs is
 * recovered from the tool_use blocks earlier in the same history (the loop
 * contract always replays the assistant's tool_use turn first); an id with no
 * matching tool_use falls back to the raw id (degraded, never dropped).
 * Prior-turn thinking blocks are skipped, as the vendors themselves do.
 */
export function toV4Prompt(req: ModelDispatchRequest, opts: PromptOptions): LanguageModelV4Prompt {
  const turns = bridgeTurns(req);
  const toolNames = new Map<string, string>();
  for (const m of turns) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b.type === "tool_use") toolNames.set(b.id, b.name);
  }
  const prompt: LanguageModelV4Prompt = [];
  if (req.system) prompt.push({ role: "system", content: req.system });

  for (const m of turns) {
    if (typeof m.content === "string") {
      prompt.push(
        m.role === "assistant"
          ? { role: "assistant", content: [{ type: "text", text: m.content }] }
          : { role: "user", content: [{ type: "text", text: m.content }] },
      );
      continue;
    }
    if (m.role === "assistant") {
      const content: V4AssistantPart[] = [];
      for (const b of m.content) {
        if (b.type === "text") content.push({ type: "text", text: b.text });
        else if (b.type === "image" || b.type === "document") content.push({ type: "text", text: attachmentText(b) });
        else if (b.type === "tool_use") {
          content.push({
            type: "tool-call",
            toolCallId: b.id,
            toolName: b.name,
            input: opts.objectToolInput ? (isRecord(b.input) ? b.input : {}) : b.input,
          });
        }
        // thinking / redacted_thinking: skipped; a tool_result on an assistant turn is not a shape the contract emits
      }
      if (content.length > 0) prompt.push({ role: "assistant", content });
      continue;
    }
    // user turn: split into user / tool runs, in order
    let run: { role: "user"; parts: V4UserPart[] } | { role: "tool"; parts: V4ToolPart[] } | null = null;
    const flush = () => {
      if (!run || run.parts.length === 0) return;
      prompt.push(
        run.role === "user"
          ? { role: "user", content: run.parts }
          : { role: "tool", content: run.parts },
      );
      run = null;
    };
    for (const b of m.content) {
      if (b.type === "tool_result") {
        if (!run || run.role !== "tool") {
          flush();
          run = { role: "tool", parts: [] };
        }
        (run.parts as V4ToolPart[]).push({
          type: "tool-result",
          toolCallId: b.toolUseId,
          toolName: toolNames.get(b.toolUseId) ?? b.toolUseId,
          output: b.isError ? { type: "error-text", value: b.content } : { type: "text", value: b.content },
        });
        continue;
      }
      let part: V4UserPart | null = null;
      if (b.type === "text") part = { type: "text", text: b.text };
      else if (b.type === "image" || b.type === "document") part = { type: "text", text: attachmentText(b) };
      if (!part) continue;
      if (!run || run.role !== "user") {
        flush();
        run = { role: "user", parts: [] };
      }
      (run.parts as V4UserPart[]).push(part);
    }
    flush();
  }
  return prompt;
}

export function toV4Tools(req: ModelDispatchRequest): LanguageModelV4FunctionTool[] | undefined {
  if (!req.tools) return undefined;
  return req.tools.map((t) => ({
    type: "function",
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    inputSchema: t.inputSchema as LanguageModelV4FunctionTool["inputSchema"],
  }));
}

export function toV4ToolChoice(req: ModelDispatchRequest): LanguageModelV4ToolChoice | undefined {
  const tc = req.toolChoice;
  if (tc === undefined) return undefined;
  if (tc === "auto" || tc === "none" || tc === "required") return { type: tc };
  return { type: "tool", toolName: tc.name };
}

export function toV4ResponseFormat(req: ModelDispatchRequest): LanguageModelV4CallOptions["responseFormat"] {
  const rf = req.responseFormat;
  if (!rf) return undefined;
  if (rf.type === "json_object") return { type: "json" };
  return {
    type: "json",
    schema: rf.schema as NonNullable<Extract<LanguageModelV4CallOptions["responseFormat"], { type: "json" }>["schema"]>,
    ...(rf.name ? { name: rf.name } : {}),
  };
}

/** Our tool calls out of the spec's content: only calls WE must execute
 * (provider-executed server tools never reach the governed loop). */
export function toolCallsOf(content: LanguageModelV4Content[]): Array<{ id: string; name: string; arguments: unknown }> {
  const out: Array<{ id: string; name: string; arguments: unknown }> = [];
  for (const c of content) {
    if (c.type !== "tool-call" || c.providerExecuted) continue;
    out.push({ id: c.toolCallId, name: c.toolName, arguments: parseArgs(c.input) });
  }
  return out;
}

function parseArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return raw;
  }
}

/**
 * Every failure out of an AI SDK call, mapped onto our error contract:
 * - our model deadline (AER-021) is named as one, with a 504, never as a vendor failure;
 * - an HTTP failure keeps the vendor's status and message;
 * - anything else (an egress-guard refusal, a programming error) passes through
 *   unchanged so the caller's cause-chain walk still finds it.
 */
export function mapAiSdkError(err: unknown, label: string, phase: "request" | "body"): unknown {
  if (err instanceof ModelProviderError) return err;
  if (isModelDeadlineError(err) || isModelDeadlineError((err as { cause?: unknown } | null)?.cause)) {
    return new ModelProviderError(
      `${label} dispatch exceeded the ${modelDispatchTimeout()}ms model deadline` +
        (phase === "body" ? " while reading the response body" : ""),
      504,
      { cause: err },
    );
  }
  if (APICallError.isInstance(err)) {
    return new ModelProviderError(`${label} dispatch failed: ${err.message}`, err.statusCode, { cause: err });
  }
  return err;
}

export interface StreamCollected {
  text: string;
  content: LanguageModelV4Content[];
  responseId: string | null;
  finishRaw: string | undefined;
  providerMetadata: Record<string, unknown> | undefined;
  rawChunks: unknown[];
}

/**
 * Drain a doStream() result: forward text deltas to `onText` as they arrive and
 * collect what the non-streaming path would have returned. The reader is always
 * released (a half-read body left open is a held socket); a deadline that fires
 * mid-body is named as one.
 */
export async function collectStream(
  model: LanguageModelV4,
  options: LanguageModelV4CallOptions,
  onText: ((delta: string) => void) | undefined,
  label: string,
): Promise<StreamCollected> {
  let stream: ReadableStream<LanguageModelV4StreamPart>;
  try {
    ({ stream } = await model.doStream({ ...options, includeRawChunks: true }));
  } catch (err) {
    throw mapAiSdkError(err, label, "request");
  }
  const out: StreamCollected = {
    text: "",
    content: [],
    responseId: null,
    finishRaw: undefined,
    providerMetadata: undefined,
    rawChunks: [],
  };
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      switch (value.type) {
        case "text-delta":
          if (value.delta) {
            out.text += value.delta;
            onText?.(value.delta);
          }
          break;
        case "tool-call":
          out.content.push(value);
          break;
        case "response-metadata":
          out.responseId = out.responseId ?? value.id ?? null;
          break;
        case "raw":
          out.rawChunks.push(value.rawValue);
          break;
        case "finish":
          out.finishRaw = value.finishReason.raw;
          out.providerMetadata = value.providerMetadata as Record<string, unknown> | undefined;
          break;
        case "error":
          throw value.error;
        default:
          break;
      }
    }
  } catch (err) {
    throw mapAiSdkError(err, label, "body");
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}
