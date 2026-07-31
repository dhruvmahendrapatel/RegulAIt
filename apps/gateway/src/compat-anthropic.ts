/**
 * ADR-0020 (ROADMAP Batch H) — `POST /v1/messages`, the Anthropic Messages
 * compatibility surface.
 *
 * This file is a TRANSLATION SHIM and nothing else: Anthropic wire shape in,
 * `ModelChatMessage`/`ModelContentBlock` out, `compat-core` does every
 * governance-bearing thing, then the result is translated back into the
 * Anthropic response (or its SSE event sequence). No policy decision is taken
 * here — see `compat-core.ts` for why that separation is the whole point.
 *
 * WHY THIS ENDPOINT EXISTS: an `ANTHROPIC_BASE_URL`-configurable client
 * (Claude Code, Cline, Roo, Continue, Zed) speaks exactly this shape. Pointing
 * it here turns its model calls into governed, attributed, PII-checked,
 * audited RegulAIt dispatches without changing the client.
 *
 * OFF BY DEFAULT — the route 404s until an admin enables it (ADR-0020).
 */

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { Db } from "@regulait/db";
import type {
  ModelChatMessage,
  ModelContentBlock,
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

/** The ONLY top-level request fields this surface honours. Anything else is a
 * 400 naming the field — see CompatFieldError's rationale. `tool_choice` and
 * `thinking` joined the honoured tier on 2026-07-31 (ADR-0020 §5 amendment):
 * each has a REAL end-to-end mapping, never an accept-and-ignore. */
export const ANTHROPIC_SUPPORTED_FIELDS = [
  "model",
  "messages",
  "system",
  "max_tokens",
  "stream",
  "tools",
  "tool_choice",
  "thinking",
] as const;

const base64Source = z.object({
  type: z.string(),
  media_type: z.string().optional(),
  data: z.string().optional(),
});

const anyBlock = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    source: base64Source.optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
    cache_control: z.unknown().optional(),
  })
  .passthrough();

const anthropicRequestSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.string(),
        content: z.union([z.string(), z.array(anyBlock)]),
      }),
    )
    .min(1),
  system: z.union([z.string(), z.array(anyBlock)]).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  tools: z
    .array(
      z
        .object({
          name: z.string(),
          description: z.string().optional(),
          input_schema: z.record(z.unknown()).optional(),
          type: z.string().optional(),
        })
        .passthrough(),
    )
    .optional(),
  tool_choice: z
    .object({
      type: z.string(),
      name: z.string().optional(),
      disable_parallel_tool_use: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
  thinking: z
    .object({
      type: z.string(),
      budget_tokens: z.number().int().positive().optional(),
    })
    .passthrough()
    .optional(),
});

type AnyBlock = z.infer<typeof anyBlock>;

/** Anthropic error envelope. Clients parse this shape, so a governance denial
 * has to arrive as one — with the RegulAIt code preserved alongside. */
export function anthropicError(status: number, code: string, message: string) {
  const type =
    status === 400
      ? "invalid_request_error"
      : status === 401
        ? "authentication_error"
        : status === 403
          ? "permission_error"
          : status === 404
            ? "not_found_error"
            : status === 409
              ? "invalid_request_error"
              : status === 429
                ? "rate_limit_error"
                : status >= 500
                  ? "api_error"
                  : "invalid_request_error";
  return { type: "error", error: { type, message, regulait_code: code } };
}

/** Request content block -> the neutral ModelContentBlock. Unmappable blocks
 * (server_tool_use, url/file sources, per-message cache_control) throw rather
 * than vanish. thinking / redacted_thinking are a REAL mapping since the
 * 2026-07-31 ADR-0020 amendment — but only on ASSISTANT turns, the only place
 * the vendor's own dialect puts them. */
function toModelBlock(b: AnyBlock, where: string, role: "user" | "assistant"): ModelContentBlock {
  if (b.cache_control !== undefined) {
    throw new CompatFieldError(
      `${where}.cache_control`,
      `per-message 'cache_control' is not supported. RegulAIt's pillar-6 prompt caching is applied ` +
        `to the system prefix automatically — send cache_control on a 'system' block instead.`,
    );
  }
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text ?? "" };
    case "image":
    case "document": {
      const src = b.source;
      if (!src || src.type !== "base64" || !src.media_type || !src.data) {
        throw new CompatFieldError(
          `${where}.source`,
          `only base64 '${b.type}' sources are supported (source.type must be 'base64' with media_type and data); ` +
            `url/file/text sources would require RegulAIt to fetch content it cannot govern.`,
        );
      }
      return {
        type: b.type,
        mediaType: src.media_type,
        dataBase64: src.data,
        ...(b.name ? { name: b.name } : {}),
      };
    }
    case "tool_use":
      if (!b.id || !b.name) {
        throw new CompatFieldError(`${where}.tool_use`, "a tool_use block needs both 'id' and 'name'");
      }
      return { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} };
    case "tool_result": {
      if (!b.tool_use_id) {
        throw new CompatFieldError(`${where}.tool_result`, "a tool_result block needs 'tool_use_id'");
      }
      const content = b.content;
      let text: string;
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        for (const part of content) {
          const t = (part as { type?: string }).type;
          if (t !== "text") {
            throw new CompatFieldError(
              `${where}.tool_result.content[].type='${t}'`,
              "only text parts are supported inside a tool_result",
            );
          }
        }
        text = content.map((p) => (p as { text?: string }).text ?? "").join("\n");
      } else text = "";
      return {
        type: "tool_result",
        toolUseId: b.tool_use_id,
        content: text,
        ...(b.is_error ? { isError: true } : {}),
      };
    }
    case "thinking": {
      // A prior assistant turn's extended-thinking block riding back through
      // history — a real round-trip mapping (the Anthropic adapter replays it
      // natively, signature intact). Only assistant turns may carry one,
      // exactly as in the vendor's own dialect.
      if (role !== "assistant") {
        throw new CompatFieldError(
          `${where}.type='thinking'`,
          "thinking blocks are only valid on assistant turns (a prior response replayed into history)",
        );
      }
      const thinking = (b as { thinking?: unknown }).thinking;
      if (typeof thinking !== "string") {
        throw new CompatFieldError(`${where}.thinking`, "a thinking block needs a string 'thinking'");
      }
      const signature = (b as { signature?: unknown }).signature;
      return {
        type: "thinking",
        thinking,
        ...(typeof signature === "string" ? { signature } : {}),
      };
    }
    case "redacted_thinking": {
      if (role !== "assistant") {
        throw new CompatFieldError(
          `${where}.type='redacted_thinking'`,
          "redacted_thinking blocks are only valid on assistant turns",
        );
      }
      const data = (b as { data?: unknown }).data;
      if (typeof data !== "string") {
        throw new CompatFieldError(`${where}.data`, "a redacted_thinking block needs a string 'data'");
      }
      return { type: "redacted_thinking", data };
    }
    default:
      throw new CompatFieldError(
        `${where}.type='${b.type}'`,
        `content blocks of type '${b.type}' are not supported by this endpoint. Supported block types: ` +
          `text, image, document, tool_use, tool_result, thinking, redacted_thinking.`,
      );
  }
}

/** Anthropic messages[] -> ModelChatMessage[]. */
export function toModelMessages(
  messages: z.infer<typeof anthropicRequestSchema>["messages"],
): ModelChatMessage[] {
  return messages.map((m, i) => {
    if (m.role !== "user" && m.role !== "assistant") {
      throw new CompatFieldError(
        `messages[${i}].role='${m.role}'`,
        "only 'user' and 'assistant' roles are valid in the Anthropic Messages shape; put instructions in 'system'",
      );
    }
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    const role = m.role;
    return {
      role,
      content: m.content.map((b, j) => toModelBlock(b, `messages[${i}].content[${j}]`, role)),
    };
  });
}

/** `system` (string or text-block array) -> the dispatch's system string.
 * A cache_control marker on a system block maps onto pillar-6 prompt caching
 * (`cacheSystem`) — a real supported mapping, not a dropped field. */
export function toSystem(
  system: z.infer<typeof anthropicRequestSchema>["system"],
): { text: string | undefined; cacheSystem: boolean } {
  if (system === undefined) return { text: undefined, cacheSystem: false };
  if (typeof system === "string") return { text: system, cacheSystem: false };
  let cacheSystem = false;
  const parts: string[] = [];
  system.forEach((b, i) => {
    if (b.type !== "text") {
      throw new CompatFieldError(
        `system[${i}].type='${b.type}'`,
        "only text blocks are supported in 'system'",
      );
    }
    if (b.cache_control !== undefined) cacheSystem = true;
    parts.push(b.text ?? "");
  });
  return { text: parts.join("\n\n"), cacheSystem };
}

function toTools(
  tools: z.infer<typeof anthropicRequestSchema>["tools"],
): ModelToolDef[] | undefined {
  if (!tools) return undefined;
  return tools.map((t, i) => {
    if (t.type !== undefined && t.type !== "custom") {
      throw new CompatFieldError(
        `tools[${i}].type='${t.type}'`,
        "server-side / built-in tool types are not supported; RegulAIt only governs tools it can see declared",
      );
    }
    if (!t.input_schema) {
      throw new CompatFieldError(`tools[${i}].input_schema`, "every tool needs an 'input_schema'");
    }
    return {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: t.input_schema,
    };
  });
}

/**
 * Anthropic `tool_choice` -> the neutral ModelToolChoice (ADR-0020 §5,
 * 2026-07-31 amendment). All four native variants map 1:1 (auto / none /
 * any→required / tool+name). Anything the neutral contract cannot carry —
 * `disable_parallel_tool_use: true`, unknown types — is a 400 naming the
 * exact variant, never a drop. A named tool must exist in the request's own
 * tools list, and a forcing variant (any / tool) needs a non-empty list;
 * auto / none without tools degrade to absent, which is behaviourally
 * identical (nothing to choose from).
 */
export function toToolChoice(
  tc: z.infer<typeof anthropicRequestSchema>["tool_choice"],
  tools: ModelToolDef[] | undefined,
): ModelToolChoice | undefined {
  if (!tc) return undefined;
  if (tc.disable_parallel_tool_use === true) {
    throw new CompatFieldError(
      "tool_choice.disable_parallel_tool_use",
      "'tool_choice.disable_parallel_tool_use: true' has no mapping in RegulAIt's neutral dispatch " +
        "contract, so it is rejected rather than silently dropped — remove it or leave it false (the default).",
    );
  }
  const names = new Set((tools ?? []).map((t) => t.name));
  switch (tc.type) {
    case "auto":
      return names.size > 0 ? "auto" : undefined;
    case "none":
      return names.size > 0 ? "none" : undefined;
    case "any":
      if (names.size === 0) {
        throw new CompatFieldError(
          "tool_choice.type='any'",
          "tool_choice 'any' forces a tool call, so the request must declare at least one tool",
        );
      }
      return "required";
    case "tool": {
      if (!tc.name) {
        throw new CompatFieldError("tool_choice.name", "tool_choice type 'tool' needs a 'name'");
      }
      if (!names.has(tc.name)) {
        throw new CompatFieldError(
          "tool_choice.name",
          `tool_choice names '${tc.name}', which is not in this request's tools list ` +
            `(${[...names].join(", ") || "empty"}) — a forced tool must be one the model can actually call`,
        );
      }
      return { name: tc.name };
    }
    default:
      throw new CompatFieldError(
        `tool_choice.type='${tc.type}'`,
        `tool_choice variant '${tc.type}' is not supported by this endpoint. Supported: auto, none, any, tool.`,
      );
  }
}

/** Anthropic `thinking` -> the neutral shape. `enabled` needs its
 * budget_tokens; `disabled` is a real mapping onto "absent" (the vendor's own
 * semantics); anything else is a 400 naming the variant. */
export function toThinking(
  t: z.infer<typeof anthropicRequestSchema>["thinking"],
): { budgetTokens: number } | undefined {
  if (!t) return undefined;
  if (t.type === "disabled") return undefined;
  if (t.type === "enabled") {
    if (!t.budget_tokens) {
      throw new CompatFieldError(
        "thinking.budget_tokens",
        "thinking type 'enabled' needs a positive integer 'budget_tokens'",
      );
    }
    return { budgetTokens: t.budget_tokens };
  }
  throw new CompatFieldError(
    `thinking.type='${t.type}'`,
    `thinking variant '${t.type}' is not supported by this endpoint. ` +
      `Supported: enabled (with budget_tokens), disabled.`,
  );
}

const STOP_REASON: Record<string, string> = {
  end_turn: "end_turn",
  max_tokens: "max_tokens",
  refusal: "refusal",
  tool_use: "tool_use",
  other: "end_turn",
};

/** Governed dispatch result -> the Anthropic Messages response body. */
export function toAnthropicResponse(
  id: string,
  prepared: CompatPrepared,
  result: Extract<DispatchOutcome, { ok: true }>["result"],
) {
  const content: Array<Record<string, unknown>> = [];
  // thinking blocks come FIRST, exactly as the vendor orders them, with
  // signatures intact so the client can replay them into the next turn
  for (const t of result.thinking ?? []) {
    content.push(
      t.type === "thinking"
        ? { type: "thinking", thinking: t.thinking, signature: t.signature }
        : { type: "redacted_thinking", data: t.data },
    );
  }
  if (result.outputText) content.push({ type: "text", text: result.outputText });
  for (const call of result.toolCalls ?? []) {
    content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id,
    type: "message",
    role: "assistant",
    // ALWAYS the model actually served — `router_decides` may differ from what
    // the client asked for, and it must be visible here, never silent.
    model: result.model,
    content,
    stop_reason: STOP_REASON[result.stopReason] ?? "end_turn",
    stop_sequence: null,
    usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens },
    // RegulAIt disclosure — additive, ignored by clients that don't look.
    regulait: {
      requestedModel: prepared.resolution.requestedModel,
      servedModel: prepared.resolution.servedModel,
      servedAgentId: prepared.resolution.servedAgentId,
      resolutionMode: prepared.resolution.mode,
      routerOverrode: prepared.resolution.routerOverrode,
      ...(prepared.resolution.tieBreak ? { tieBreak: prepared.resolution.tieBreak } : {}),
      projectId: prepared.projectId,
      costUsd: result.costUsd,
      ...(prepared.streamingSuppressed ? { streamingSuppressed: true } : {}),
      ...(result.pii ? { pii: { mode: result.pii.mode, action: result.pii.action } } : {}),
    },
  };
}

export function registerAnthropicCompat(app: FastifyInstance, db: Db, opts: { dataKey?: string } = {}) {
  app.post("/v1/messages", async (req, reply) => {
    // The disabled-surface 404 is applied by app.ts's interception gate, in the
    // onRequest phase — before auth, so a disabled endpoint is truly
    // indistinguishable from one that was never registered.
    let body: z.infer<typeof anthropicRequestSchema>;
    let messages: ModelChatMessage[];
    let system: { text: string | undefined; cacheSystem: boolean };
    let tools: ModelToolDef[] | undefined;
    let toolChoice: ModelToolChoice | undefined;
    let thinking: { budgetTokens: number } | undefined;
    let ignoredFields: string[] = [];
    try {
      const raw = (req.body ?? {}) as Record<string, unknown>;
      ignoredFields = rejectUnsupportedFields(raw, ANTHROPIC_SUPPORTED_FIELDS, "Anthropic");
      body = anthropicRequestSchema.parse(raw);
      messages = toModelMessages(body.messages);
      system = toSystem(body.system);
      tools = toTools(body.tools);
      toolChoice = toToolChoice(body.tool_choice, tools);
      thinking = toThinking(body.thinking);
    } catch (err) {
      if (err instanceof CompatFieldError) {
        return reply.status(400).send(anthropicError(400, "unsupported_field", err.detail));
      }
      if (err instanceof z.ZodError) {
        return reply
          .status(400)
          .send(anthropicError(400, "validation", err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")));
      }
      throw err;
    }

    const flatText = messages
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : m.content.map((b) => (b.type === "text" ? b.text : "")).join(" "),
      )
      .join("\n");

    const prep = await prepareCompatCall(db, opts.dataKey, req, {
      requestedModel: body.model,
      stream: body.stream === true,
      text: flatText,
      ignoredFields,
    });
    if (!prep.ok) {
      return reply.status(prep.status).send(anthropicError(prep.status, prep.error, prep.detail));
    }
    const prepared = prep.prepared;
    // ADR-0020 long tail: the field is expressible in this dialect, but the
    // SERVED provider must be able to honour it — a mismatch is a 400 naming
    // the field, never a silent drop (thinking is anthropic/mock only).
    const capability = providerCapabilityError(prepared, { thinking: thinking !== undefined });
    if (capability) {
      return reply
        .status(capability.status)
        .send(anthropicError(capability.status, capability.error, capability.detail));
    }
    const msgId = `msg_${randomUUID().replace(/-/g, "")}`;

    // ---- streaming -------------------------------------------------------
    // The stream opens LAZILY: nothing is hijacked until the first delta (or a
    // successful outcome), so a governed denial raised inside the dispatch
    // (PII input block, project budget gate) still returns a proper HTTP error
    // instead of a 200 that carries a failure.
    if (prepared.useStream) {
      let opened = false;
      // Content blocks open LAZILY and in the vendor's own order: an optional
      // thinking block first (thinking_delta / signature_delta framing), then
      // the text block, then tool_use blocks — so a thinking-enabled stream is
      // frame-compatible with the real Messages API.
      let blockIndex = -1;
      let openBlock: "thinking" | "text" | null = null;
      const send = (event: string, data: unknown) =>
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const open = () => {
        if (opened) return;
        opened = true;
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          ...disclosureHeaderPairs(prepared),
        });
        send("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model: prepared.resolution.servedModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
      };
      const startBlock = (kind: "thinking" | "text") => {
        open();
        if (openBlock !== null) send("content_block_stop", { type: "content_block_stop", index: blockIndex });
        blockIndex += 1;
        openBlock = kind;
        send("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block:
            kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
        });
      };

      const outcome = await executeCompatCall(db, opts.dataKey, prepared, {
        surface: "anthropic",
        messages,
        system: system.text,
        cacheSystem: system.cacheSystem,
        tools,
        toolChoice,
        thinking,
        maxTokens: body.max_tokens,
        onThinking: (d) => {
          if (d.thinking) {
            if (openBlock !== "thinking") startBlock("thinking");
            send("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "thinking_delta", thinking: d.thinking },
            });
          }
          // the signature arrives as its own delta before the block closes,
          // exactly the vendor framing — clients need it to replay the block
          if (d.signature && openBlock === "thinking") {
            send("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "signature_delta", signature: d.signature },
            });
          }
        },
        onText: (delta) => {
          if (openBlock !== "text") startBlock("text");
          send("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "text_delta", text: delta },
          });
        },
      });

      if (!outcome.ok) {
        if (!opened) {
          return reply
            .status(outcome.status)
            .send(anthropicError(outcome.status, outcome.error, outcome.detail ?? outcome.error));
        }
        send("error", {
          type: "error",
          error: { type: "api_error", message: outcome.detail ?? outcome.error, regulait_code: outcome.error },
        });
        reply.raw.end();
        return reply;
      }
      open();
      // shape fidelity: there is always at least one text block, even when no
      // text delta ever fired (refusal / pure tool_use)
      if (openBlock !== "text") startBlock("text");
      send("content_block_stop", { type: "content_block_stop", index: blockIndex });
      openBlock = null;
      // Tool calls ride as extra content blocks after the text block, so a
      // tool-using client sees the same shape it would from the vendor.
      let index = blockIndex + 1;
      for (const call of outcome.result.toolCalls ?? []) {
        send("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments ?? {}) },
        });
        send("content_block_stop", { type: "content_block_stop", index });
        index += 1;
      }
      send("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: STOP_REASON[outcome.result.stopReason] ?? "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: outcome.result.usage.outputTokens },
      });
      send("message_stop", { type: "message_stop" });
      reply.raw.end();
      return reply;
    }

    // ---- buffered --------------------------------------------------------
    const outcome = await executeCompatCall(db, opts.dataKey, prepared, {
      surface: "anthropic",
      messages,
      system: system.text,
      cacheSystem: system.cacheSystem,
      tools,
      toolChoice,
      thinking,
      maxTokens: body.max_tokens,
    });
    disclosureHeaders(reply, prepared);
    if (!outcome.ok) {
      return reply
        .status(outcome.status)
        .send(anthropicError(outcome.status, outcome.error, outcome.detail ?? outcome.error));
    }
    return reply.send(toAnthropicResponse(msgId, prepared, outcome.result));
  });
}
