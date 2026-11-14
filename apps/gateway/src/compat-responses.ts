/**
 * ADR-0287 — `POST /v1/responses`, the OpenAI Responses API compatibility
 * surface (PENDING P33 follow-up).
 *
 * laravel/ai's default `openai` driver, and the official OpenAI SDKs'
 * `responses.create`, speak this dialect rather than Chat Completions. Like
 * `compat-openai.ts` it is a TRANSLATION SHIM over the one governed dispatch
 * core in `compat-core.ts`: the same entitlement, routing, PII, rate-limit,
 * cost-attribution and audit path, so a Responses-shaped call is governed
 * exactly like a Chat-Completions-shaped one.
 *
 * It rides the OpenAI-compatible surface's admin switch (`openaiCompatEnabled`,
 * and its ADR-0024 scope rules): it is the same vendor dialect, so opening the
 * OpenAI surface opens both, and a disabled surface answers the same
 * indistinguishable 404 (the gate lives in app.ts).
 *
 * STATELESS BY DESIGN. RegulAIt does not keep the conversation server-side: a
 * stored response would be prompt and output content held outside every
 * retention and PII control the gateway applies. So `previous_response_id` is a
 * 400 naming the field, `store: true` is a 400, and every response says
 * `store: false`. Clients send the whole history (laravel/ai: the provider's
 * `store => false` option; the OpenAI SDKs: `store: false` plus the prior
 * output items in `input`). The output items this shim emits round-trip as
 * input items, so a tool loop works without any server state.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import type { Db } from "@regulait/db";
import type {
  ModelChatMessage,
  ModelContentBlock,
  ModelResponseFormat,
  ModelToolChoice,
  ModelToolDef,
} from "@regulait/model-provider";
import { z } from "zod";
import type { DispatchOutcome } from "./agents-connectors.js";
import {
  CompatFieldError,
  disclosureHeaderPairs,
  disclosureHeaders,
  executeCompatCall,
  prepareCompatCall,
  providerCapabilityError,
  rejectUnsupportedFields,
  type CompatPrepared,
} from "./compat-core.js";
import { openaiError } from "./compat-openai.js";

/** The ONLY top-level request fields this surface honours; anything else is a
 * 400 naming it (the ADR-0020 rule), except the shared accept-and-disclose tier
 * (`temperature`). */
export const RESPONSES_SUPPORTED_FIELDS = [
  "model",
  "input",
  "instructions",
  "stream",
  "tools",
  "tool_choice",
  "max_output_tokens",
  "text",
  "store",
  "include",
] as const;

/** `include` values that are honoured. This shim emits no reasoning items, so
 * asking for their encrypted content is satisfied by construction (there is
 * nothing to include); laravel/ai sends it for reasoning-model names. */
const HONOURED_INCLUDES: ReadonlySet<string> = new Set(["reasoning.encrypted_content"]);

const contentPart = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    image_url: z.string().optional(),
  })
  .passthrough();

const inputItem = z
  .object({
    type: z.string().optional(),
    role: z.string().optional(),
    content: z.union([z.string(), z.array(contentPart)]).optional(),
    call_id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
    output: z.string().optional(),
  })
  .passthrough();

const responsesRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string().min(1), z.array(inputItem).min(1)]),
  instructions: z.string().nullable().optional(),
  stream: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  tools: z
    .array(
      z
        .object({
          type: z.string(),
          name: z.string().optional(),
          description: z.string().nullable().optional(),
          parameters: z.record(z.string(), z.unknown()).nullable().optional(),
          strict: z.boolean().nullable().optional(),
        })
        .passthrough(),
    )
    .optional(),
  tool_choice: z
    .union([z.string(), z.object({ type: z.string(), name: z.string().optional() }).passthrough()])
    .optional(),
  text: z
    .object({
      format: z
        .object({
          type: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          schema: z.record(z.string(), z.unknown()).optional(),
          strict: z.boolean().nullable().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
  store: z.boolean().optional(),
  include: z.array(z.string()).optional(),
});

type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

export interface ResponsesTranslation {
  messages: ModelChatMessage[];
  system: string | undefined;
}

/** A data: URI carrying base64 image bytes -> the neutral image block. A remote
 * URL or a file id is refused: RegulAIt would have to fetch content it never saw. */
function imageBlock(url: string | undefined, where: string): ModelContentBlock {
  const m = typeof url === "string" ? /^data:([^;,]+);base64,(.+)$/s.exec(url) : null;
  if (!m) {
    throw new CompatFieldError(
      `${where}.image_url`,
      "only base64 data: URIs are supported for images; a remote URL or file id would make RegulAIt fetch content it cannot govern",
    );
  }
  return { type: "image", mediaType: m[1]!, dataBase64: m[2]! };
}

/** Append blocks to the previous turn when it has the same role, else open a
 * new turn: consecutive function_call items are ONE assistant turn and
 * consecutive function_call_output items ONE user turn, the shape every
 * adapter round-trips. */
function pushBlocks(out: ModelChatMessage[], role: "user" | "assistant", blocks: ModelContentBlock[]) {
  const last = out[out.length - 1];
  if (last && last.role === role && Array.isArray(last.content)) {
    last.content.push(...blocks);
    return;
  }
  out.push({ role, content: blocks });
}

/**
 * Responses `instructions` + `input` -> {system, ModelChatMessage[]}.
 *
 * `instructions` and system/developer messages are hoisted into the dispatch's
 * out-of-band system field (joined in order), as the Chat Completions shim does.
 * Every item type without a governed mapping (reasoning, item references,
 * built-in tool calls) is a 400 naming it.
 */
export function toModelMessages(input: ResponsesRequest["input"], instructions: string | null | undefined): ResponsesTranslation {
  const systemParts: string[] = instructions ? [instructions] : [];
  if (typeof input === "string") {
    return { messages: [{ role: "user", content: input }], system: systemParts.length ? systemParts.join("\n\n") : undefined };
  }
  const out: ModelChatMessage[] = [];
  input.forEach((item, i) => {
    const where = `input[${i}]`;
    const type = item.type ?? "message";
    if (type === "function_call") {
      if (!item.call_id || !item.name) {
        throw new CompatFieldError(`${where}`, "a 'function_call' item needs 'call_id' and 'name'");
      }
      let parsed: unknown = {};
      try {
        parsed = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        throw new CompatFieldError(`${where}.arguments`, "function_call arguments must be a JSON object string");
      }
      pushBlocks(out, "assistant", [{ type: "tool_use", id: item.call_id, name: item.name, input: parsed }]);
      return;
    }
    if (type === "function_call_output") {
      if (!item.call_id) {
        throw new CompatFieldError(`${where}.call_id`, "a 'function_call_output' item needs 'call_id'");
      }
      if (typeof item.output !== "string") {
        throw new CompatFieldError(`${where}.output`, "a 'function_call_output' item needs a string 'output'");
      }
      pushBlocks(out, "user", [{ type: "tool_result", toolUseId: item.call_id, content: item.output }]);
      return;
    }
    if (type !== "message") {
      throw new CompatFieldError(
        `${where}.type='${type}'`,
        "supported input item types are message, function_call and function_call_output",
      );
    }
    const role = item.role;
    const content = item.content;
    const parts = (allowed: readonly string[]): ModelContentBlock[] => {
      if (typeof content === "string") return [{ type: "text", text: content }];
      if (!content) return [];
      return content.map((p, j) => {
        if (allowed.includes(p.type) && (p.type === "input_text" || p.type === "output_text")) {
          return { type: "text", text: p.text ?? "" };
        }
        if (allowed.includes(p.type) && p.type === "input_image") {
          return imageBlock(p.image_url, `${where}.content[${j}]`);
        }
        throw new CompatFieldError(
          `${where}.content[${j}].type='${p.type}'`,
          `supported content part types for role '${role}' are ${allowed.join(", ")}`,
        );
      });
    };
    switch (role) {
      case "system":
      case "developer": {
        const text = parts(["input_text"]).map((b) => (b.type === "text" ? b.text : "")).join("\n");
        systemParts.push(text);
        return;
      }
      case "user": {
        const blocks = parts(["input_text", "input_image"]);
        if (typeof content === "string") out.push({ role: "user", content });
        else pushBlocks(out, "user", blocks);
        return;
      }
      case "assistant": {
        const blocks = parts(["output_text", "input_text"]);
        if (blocks.length) pushBlocks(out, "assistant", blocks);
        return;
      }
      default:
        throw new CompatFieldError(
          `${where}.role='${role ?? ""}'`,
          "supported message roles are system, developer, user and assistant",
        );
    }
  });
  if (out.length === 0) {
    throw new CompatFieldError(
      "input",
      "at least one user, assistant or function item is required — a request of only system turns has nothing to dispatch",
    );
  }
  return { messages: out, system: systemParts.length ? systemParts.join("\n\n") : undefined };
}

/** Responses tools are flat (`{type:'function', name, parameters}`). Only
 * function tools: a built-in tool (web search, file search, code interpreter)
 * runs inside the vendor, where RegulAIt cannot govern it. */
export function toTools(tools: ResponsesRequest["tools"]): ModelToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t, i) => {
    if (t.type !== "function") {
      throw new CompatFieldError(
        `tools[${i}].type='${t.type}'`,
        "only 'function' tools are supported; built-in/server-side tools cannot be governed by RegulAIt",
      );
    }
    if (!t.name) throw new CompatFieldError(`tools[${i}].name`, "every function tool needs a 'name'");
    if ((t as Record<string, unknown>)["defer_loading"] !== undefined) {
      throw new CompatFieldError(`tools[${i}].defer_loading`, "deferred tool loading (tool search) is not supported");
    }
    return {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: t.parameters ?? { type: "object", properties: {} },
    };
  });
}

/** Responses `tool_choice` -> neutral. Same rules as the Chat Completions shim:
 * a forcing variant needs tools; a named function must be in the tools list. */
export function toToolChoice(tc: ResponsesRequest["tool_choice"], tools: ModelToolDef[] | undefined): ModelToolChoice | undefined {
  if (tc === undefined) return undefined;
  const names = new Set((tools ?? []).map((t) => t.name));
  if (typeof tc === "string") {
    if (tc === "auto" || tc === "none") return names.size > 0 ? tc : undefined;
    if (tc === "required") {
      if (names.size === 0) {
        throw new CompatFieldError("tool_choice='required'", "tool_choice 'required' needs at least one tool in the request");
      }
      return "required";
    }
    throw new CompatFieldError(
      `tool_choice='${tc}'`,
      `tool_choice variant '${tc}' is not supported. Supported: auto, none, required, {type:'function',name}.`,
    );
  }
  if (tc.type !== "function") {
    throw new CompatFieldError(
      `tool_choice.type='${tc.type}'`,
      "only 'function' tool_choice objects are supported; other variants have no governed mapping",
    );
  }
  if (!tc.name) throw new CompatFieldError("tool_choice.name", "a function tool_choice needs 'name'");
  if (!names.has(tc.name)) {
    throw new CompatFieldError(
      "tool_choice.name",
      `tool_choice names '${tc.name}', which is not in this request's tools list (${[...names].join(", ") || "empty"})`,
    );
  }
  return { name: tc.name };
}

/** Responses `text.format` -> neutral structured-output request. */
export function toResponseFormat(text: ResponsesRequest["text"]): ModelResponseFormat | undefined {
  if (!text) return undefined;
  const extra = Object.keys(text).filter((k) => k !== "format");
  if (extra.length) {
    throw new CompatFieldError(`text.${extra[0]}`, "only text.format is supported on this endpoint");
  }
  const f = text.format;
  if (!f || f.type === "text") return undefined;
  if (f.type === "json_object") return { type: "json_object" };
  if (f.type === "json_schema") {
    if (!f.schema) {
      throw new CompatFieldError("text.format.schema", "text.format type 'json_schema' needs 'schema' (a JSON Schema object)");
    }
    return {
      type: "json_schema",
      ...(f.name ? { name: f.name } : {}),
      schema: f.schema,
      ...(typeof f.strict === "boolean" ? { strict: f.strict } : {}),
    };
  }
  throw new CompatFieldError(
    `text.format.type='${f.type}'`,
    `text.format variant '${f.type}' is not supported. Supported: text, json_object, json_schema.`,
  );
}

/** Fields that would need server-side state or behaviour RegulAIt does not have. */
function rejectStatefulFields(body: ResponsesRequest): void {
  if (body.store === true) {
    throw new CompatFieldError(
      "store",
      "RegulAIt does not store responses (prompt and output content held outside the gateway's retention and PII controls); " +
        "send store:false, or omit it, and pass the conversation in 'input'",
    );
  }
  for (const v of body.include ?? []) {
    if (!HONOURED_INCLUDES.has(v)) {
      throw new CompatFieldError(`include='${v}'`, `include value '${v}' is not supported. Supported: ${[...HONOURED_INCLUDES].join(", ")}.`);
    }
  }
}

type ToolCall = { id: string; name: string; arguments: unknown };
type Result = Extract<DispatchOutcome, { ok: true }>["result"];

const hex = () => randomUUID().replace(/-/g, "");

/** status + incomplete_details from the normalized stop reason. */
export function completion(stopReason: string): { status: "completed" | "incomplete"; incomplete_details: { reason: string } | null } {
  if (stopReason === "max_tokens") return { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
  // the model itself declined — the dialect's nearest honest equivalent
  if (stopReason === "refusal") return { status: "incomplete", incomplete_details: { reason: "content_filter" } };
  return { status: "completed", incomplete_details: null };
}

function messageItem(id: string, text: string, status: string) {
  return {
    type: "message",
    id,
    status,
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function functionCallItem(c: ToolCall, status: string, args?: string) {
  return {
    type: "function_call",
    id: `fc_${hex()}`,
    call_id: c.id,
    name: c.name,
    arguments: args ?? JSON.stringify(c.arguments ?? {}),
    status,
  };
}

function usageOf(result: Result) {
  return {
    input_tokens: result.usage.inputTokens,
    input_tokens_details: { cached_tokens: result.usage.cacheReadInputTokens ?? 0 },
    output_tokens: result.usage.outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: result.usage.inputTokens + result.usage.outputTokens,
  };
}

interface Envelope {
  id: string;
  createdAt: number;
  body: ResponsesRequest;
  prepared: CompatPrepared;
}

/** The response object, in every state (in_progress / completed / incomplete). */
function responseObject(
  env: Envelope,
  state: { status: string; incomplete_details: { reason: string } | null },
  model: string,
  output: unknown[],
  usage: ReturnType<typeof usageOf> | null,
  result?: Result,
) {
  const { prepared, body } = env;
  return {
    id: env.id,
    object: "response",
    created_at: env.createdAt,
    status: state.status,
    error: null,
    incomplete_details: state.incomplete_details,
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    // ALWAYS the model actually served — never silently the requested one.
    model,
    output,
    previous_response_id: null,
    store: false,
    text: body.text ?? { format: { type: "text" } },
    tool_choice: body.tool_choice ?? "auto",
    tools: body.tools ?? [],
    usage,
    regulait: {
      requestedModel: prepared.resolution.requestedModel,
      servedModel: prepared.resolution.servedModel,
      servedAgentId: prepared.resolution.servedAgentId,
      resolutionMode: prepared.resolution.mode,
      routerOverrode: prepared.resolution.routerOverrode,
      ...(prepared.resolution.tieBreak ? { tieBreak: prepared.resolution.tieBreak } : {}),
      projectId: prepared.projectId,
      ...(result ? { costUsd: result.costUsd } : {}),
      ...(prepared.streamingSuppressed ? { streamingSuppressed: true } : {}),
      ...(result?.pii ? { pii: { mode: result.pii.mode, action: result.pii.action } } : {}),
    },
  };
}

export function toResponsesResponse(env: Envelope, result: Result) {
  const output: unknown[] = [];
  if (result.outputText) output.push(messageItem(`msg_${hex()}`, result.outputText, "completed"));
  for (const c of result.toolCalls ?? []) output.push(functionCallItem(c, "completed"));
  return responseObject(env, completion(result.stopReason), result.model, output, usageOf(result), result);
}

/** Server-sent events in the Responses dialect: `event: <type>` + a JSON body
 * carrying the same `type` and a monotonically increasing `sequence_number`. */
class ResponsesStream {
  private seq = 0;
  private opened = false;
  private text = "";
  private messageId = `msg_${hex()}`;
  private messageOpen = false;
  constructor(
    private readonly reply: FastifyReply,
    private readonly env: Envelope,
  ) {}

  private emit(type: string, data: Record<string, unknown>) {
    this.reply.raw.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...data })}\n\n`);
  }

  get isOpen() {
    return this.opened;
  }

  open() {
    if (this.opened) return;
    this.opened = true;
    this.reply.hijack();
    this.reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      // No `connection` header (ADR-0257): Node keeps the socket alive unless the
      // client asked to close, and forcing keep-alive hangs clients that read to EOF.
      ...disclosureHeaderPairs(this.env.prepared),
    });
    const initial = responseObject(
      this.env,
      { status: "in_progress", incomplete_details: null },
      this.env.prepared.resolution.servedModel,
      [],
      null,
    );
    this.emit("response.created", { response: initial });
    this.emit("response.in_progress", { response: initial });
  }

  private openMessage() {
    if (this.messageOpen) return;
    this.messageOpen = true;
    this.emit("response.output_item.added", {
      output_index: 0,
      item: { type: "message", id: this.messageId, status: "in_progress", role: "assistant", content: [] },
    });
    this.emit("response.content_part.added", {
      item_id: this.messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  }

  delta(d: string) {
    this.open();
    this.openMessage();
    this.text += d;
    this.emit("response.output_text.delta", { item_id: this.messageId, output_index: 0, content_index: 0, delta: d });
  }

  finish(result: Result) {
    this.open();
    const output: unknown[] = [];
    // A buffered (PII-scanned) stream releases the complete text here.
    const finalText = result.outputText ?? this.text;
    if (finalText && !this.messageOpen) this.delta(finalText);
    if (this.messageOpen) {
      const part = { type: "output_text", text: finalText, annotations: [] };
      this.emit("response.output_text.done", { item_id: this.messageId, output_index: 0, content_index: 0, text: finalText });
      this.emit("response.content_part.done", { item_id: this.messageId, output_index: 0, content_index: 0, part });
      const item = messageItem(this.messageId, finalText, "completed");
      this.emit("response.output_item.done", { output_index: 0, item });
      output.push(item);
    }
    for (const c of result.toolCalls ?? []) {
      const outputIndex = output.length;
      const args = JSON.stringify(c.arguments ?? {});
      const done = functionCallItem(c, "completed", args);
      this.emit("response.output_item.added", { output_index: outputIndex, item: { ...done, arguments: "", status: "in_progress" } });
      this.emit("response.function_call_arguments.delta", { item_id: done.id, output_index: outputIndex, delta: args });
      this.emit("response.function_call_arguments.done", { item_id: done.id, output_index: outputIndex, arguments: args });
      this.emit("response.output_item.done", { output_index: outputIndex, item: done });
      output.push(done);
    }
    const state = completion(result.stopReason);
    const response = responseObject(this.env, state, result.model, output, usageOf(result), result);
    this.emit(state.status === "completed" ? "response.completed" : "response.incomplete", { response });
    this.reply.raw.end();
  }

  fail(status: number, code: string, message: string) {
    const err = openaiError(status, code, message).error;
    this.emit("error", { code, message: err.message, param: null });
    this.reply.raw.end();
  }
}

export function registerResponsesCompat(app: FastifyInstance, db: Db, opts: { dataKey?: string } = {}) {
  app.post("/v1/responses", async (req, reply) => {
    // The disabled-surface 404 is applied by app.ts's interception gate in the
    // onRequest phase, before auth.
    let body: ResponsesRequest;
    let translated: ResponsesTranslation;
    let tools: ModelToolDef[] | undefined;
    let toolChoice: ModelToolChoice | undefined;
    let responseFormat: ModelResponseFormat | undefined;
    let ignoredFields: string[] = [];
    try {
      const raw = (req.body ?? {}) as Record<string, unknown>;
      ignoredFields = rejectUnsupportedFields(raw, RESPONSES_SUPPORTED_FIELDS, "OpenAI Responses");
      body = responsesRequestSchema.parse(raw);
      rejectStatefulFields(body);
      translated = toModelMessages(body.input, body.instructions);
      tools = toTools(body.tools);
      toolChoice = toToolChoice(body.tool_choice, tools);
      responseFormat = toResponseFormat(body.text);
    } catch (err) {
      if (err instanceof CompatFieldError) {
        // the message NAMES the field (ADR-0020): "<field>: <why>"
        const message = err.detail.startsWith(`'${err.field}'`) ? err.detail : `${err.field}: ${err.detail}`;
        return reply.status(400).send(openaiError(400, "unsupported_field", message));
      }
      if (err instanceof z.ZodError) {
        return reply
          .status(400)
          .send(openaiError(400, "validation", err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")));
      }
      throw err;
    }

    const flatText = translated.messages
      .map((m) =>
        typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join(" "),
      )
      .join("\n");

    const prep = await prepareCompatCall(db, opts.dataKey, req, {
      requestedModel: body.model,
      stream: body.stream === true,
      text: flatText,
      ignoredFields,
    });
    if (!prep.ok) {
      return reply.status(prep.status).send(openaiError(prep.status, prep.error, prep.detail));
    }
    const prepared = prep.prepared;
    const capability = providerCapabilityError(prepared, { responseFormat: responseFormat !== undefined });
    if (capability) {
      return reply.status(capability.status).send(openaiError(capability.status, capability.error, capability.detail));
    }
    const env: Envelope = { id: `resp_${hex()}`, createdAt: Math.floor(Date.now() / 1000), body, prepared };
    const dispatch = {
      surface: "openai_responses" as const,
      messages: translated.messages,
      system: translated.system,
      tools,
      toolChoice,
      responseFormat,
      maxTokens: body.max_output_tokens,
    };

    // ---- streaming: lazily opened, so a denial raised inside the governed
    // dispatch still returns a real HTTP error --------------------------------
    if (prepared.useStream) {
      const stream = new ResponsesStream(reply, env);
      const outcome = await executeCompatCall(db, opts.dataKey, prepared, {
        ...dispatch,
        onText: (delta) => stream.delta(delta),
      });
      if (!outcome.ok) {
        if (!stream.isOpen) {
          return reply
            .status(outcome.status)
            .send(openaiError(outcome.status, outcome.error, outcome.detail ?? outcome.error));
        }
        stream.fail(outcome.status, outcome.error, outcome.detail ?? outcome.error);
        return reply;
      }
      stream.finish(outcome.result);
      return reply;
    }

    // ---- buffered -----------------------------------------------------------
    const outcome = await executeCompatCall(db, opts.dataKey, prepared, dispatch);
    disclosureHeaders(reply, prepared);
    if (!outcome.ok) {
      return reply
        .status(outcome.status)
        .send(openaiError(outcome.status, outcome.error, outcome.detail ?? outcome.error));
    }
    return reply.send(toResponsesResponse(env, outcome.result));
  });
}
