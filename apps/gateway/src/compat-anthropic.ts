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
import type { ModelChatMessage, ModelContentBlock, ModelToolDef } from "@regulait/model-provider";
import { z } from "zod";
import type { DispatchOutcome } from "./agents-connectors.js";
import {
  CompatFieldError,
  disclosureHeaderPairs,
  disclosureHeaders,
  executeCompatCall,
  prepareCompatCall,
  rejectUnsupportedFields,
  type CompatPrepared,
} from "./compat-core.js";

/** The ONLY top-level request fields this surface honours. Anything else is a
 * 400 naming the field — see CompatFieldError's rationale. */
export const ANTHROPIC_SUPPORTED_FIELDS = [
  "model",
  "messages",
  "system",
  "max_tokens",
  "stream",
  "tools",
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
 * (thinking, redacted_thinking, server_tool_use, url/file sources,
 * per-message cache_control) throw rather than vanish. */
function toModelBlock(b: AnyBlock, where: string): ModelContentBlock {
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
    default:
      throw new CompatFieldError(
        `${where}.type='${b.type}'`,
        `content blocks of type '${b.type}' are not supported by this endpoint. Supported block types: ` +
          `text, image, document, tool_use, tool_result.`,
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
    return {
      role: m.role,
      content: m.content.map((b, j) => toModelBlock(b, `messages[${i}].content[${j}]`)),
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
    let ignoredFields: string[] = [];
    try {
      const raw = (req.body ?? {}) as Record<string, unknown>;
      ignoredFields = rejectUnsupportedFields(raw, ANTHROPIC_SUPPORTED_FIELDS, "Anthropic");
      body = anthropicRequestSchema.parse(raw);
      messages = toModelMessages(body.messages);
      system = toSystem(body.system);
      tools = toTools(body.tools);
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
    const msgId = `msg_${randomUUID().replace(/-/g, "")}`;

    // ---- streaming -------------------------------------------------------
    // The stream opens LAZILY: nothing is hijacked until the first delta (or a
    // successful outcome), so a governed denial raised inside the dispatch
    // (PII input block, project budget gate) still returns a proper HTTP error
    // instead of a 200 that carries a failure.
    if (prepared.useStream) {
      let opened = false;
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
        send("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
      };
      const send = (event: string, data: unknown) =>
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const outcome = await executeCompatCall(db, opts.dataKey, prepared, {
        surface: "anthropic",
        messages,
        system: system.text,
        cacheSystem: system.cacheSystem,
        tools,
        maxTokens: body.max_tokens,
        onText: (delta) => {
          open();
          send("content_block_delta", {
            type: "content_block_delta",
            index: 0,
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
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      // Tool calls ride as extra content blocks after the text block, so a
      // tool-using client sees the same shape it would from the vendor.
      let index = 1;
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
