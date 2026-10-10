/**
 * ADR-0020 (ROADMAP Batch H) — `POST /v1/chat/completions`, the OpenAI Chat
 * Completions compatibility surface.
 *
 * Same contract as `compat-anthropic.ts`: a TRANSLATION SHIM over the one
 * governed dispatch core in `compat-core.ts`. Cursor and every
 * "OpenAI-compatible base URL" client speaks this shape, so pointing them here
 * makes their model calls governed, attributed, PII-checked and audited
 * without changing the client.
 *
 * OFF BY DEFAULT — the route 404s until an admin enables it (ADR-0020).
 */

import type { FastifyInstance } from "fastify";
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

/** The ONLY top-level request fields this surface honours. Anything else is a
 * 400 naming the field — RegulAIt will not silently ignore a parameter that
 * changes what the model does. `tool_choice` and `response_format` joined the
 * honoured tier on 2026-07-31 (ADR-0020 §5 amendment): each has a REAL
 * end-to-end mapping, never an accept-and-ignore. */
export const OPENAI_SUPPORTED_FIELDS = [
  "model",
  "messages",
  "stream",
  "tools",
  "max_tokens",
  "max_completion_tokens",
  "tool_choice",
  "response_format",
] as const;

const contentPart = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    image_url: z.object({ url: z.string(), detail: z.string().optional() }).optional(),
  })
  .passthrough();

const openaiRequestSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z
        .object({
          role: z.string(),
          content: z.union([z.string(), z.array(contentPart), z.null()]).optional(),
          name: z.string().optional(),
          tool_call_id: z.string().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.string().optional(),
                function: z.object({ name: z.string(), arguments: z.string().optional() }),
              }),
            )
            .optional(),
        })
        .passthrough(),
    )
    .min(1),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  tools: z
    .array(
      z
        .object({
          type: z.string().optional(),
          function: z.object({
            name: z.string(),
            description: z.string().optional(),
            parameters: z.record(z.string(), z.unknown()).optional(),
          }),
        })
        .passthrough(),
    )
    .optional(),
  tool_choice: z
    .union([
      z.string(),
      z
        .object({
          type: z.string(),
          function: z.object({ name: z.string() }).optional(),
        })
        .passthrough(),
    ])
    .optional(),
  response_format: z
    .object({
      type: z.string(),
      json_schema: z
        .object({
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
});

/** OpenAI error envelope. */
export function openaiError(status: number, code: string, message: string) {
  const type =
    status === 400
      ? "invalid_request_error"
      : status === 401
        ? "authentication_error"
        : status === 403
          ? "permission_error"
          : status === 404
            ? "not_found_error"
            : status === 429
              ? "rate_limit_error"
              : status >= 500
                ? "api_error"
                : "invalid_request_error";
  return { error: { message, type, param: null, code, regulait_code: code } };
}

/** A data: URI carrying base64 image bytes -> the neutral image block. A remote
 * https:// image URL is REJECTED: fetching it would mean RegulAIt shipping
 * content it never saw into a governed dispatch. */
function imageBlockFromUrl(url: string, where: string): ModelContentBlock {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!m) {
    throw new CompatFieldError(
      `${where}.image_url.url`,
      "only base64 data: URIs are supported for images; a remote URL would make RegulAIt fetch content it cannot govern",
    );
  }
  return { type: "image", mediaType: m[1]!, dataBase64: m[2]! };
}

export interface OpenAiTranslation {
  messages: ModelChatMessage[];
  system: string | undefined;
}

/**
 * OpenAI messages[] -> {system, ModelChatMessage[]}.
 *
 * `system`/`developer` turns are HOISTED into the dispatch's out-of-band
 * `system` field (joined in order) because two of the four real providers
 * carry system out-of-band anyway — see ModelChatMessage's own note. A `tool`
 * turn becomes a user turn carrying one tool_result block, which is the
 * neutral shape the Anthropic adapter round-trips natively.
 */
export function toModelMessages(
  messages: z.infer<typeof openaiRequestSchema>["messages"],
): OpenAiTranslation {
  const systemParts: string[] = [];
  const out: ModelChatMessage[] = [];
  messages.forEach((m, i) => {
    const where = `messages[${i}]`;
    const textOf = (): string => {
      const c = m.content;
      if (typeof c === "string") return c;
      if (!c) return "";
      return c
        .map((p, j) => {
          if (p.type === "text") return p.text ?? "";
          throw new CompatFieldError(
            `${where}.content[${j}].type='${p.type}'`,
            "only text parts are supported in this role's content",
          );
        })
        .join("\n");
    };
    switch (m.role) {
      case "system":
      case "developer":
        systemParts.push(textOf());
        return;
      case "user": {
        const c = m.content;
        if (typeof c === "string" || c == null) {
          out.push({ role: "user", content: c ?? "" });
          return;
        }
        const blocks: ModelContentBlock[] = c.map((p, j) => {
          if (p.type === "text") return { type: "text", text: p.text ?? "" };
          if (p.type === "image_url") {
            if (!p.image_url) {
              throw new CompatFieldError(`${where}.content[${j}].image_url`, "image_url part needs an 'image_url'");
            }
            return imageBlockFromUrl(p.image_url.url, `${where}.content[${j}]`);
          }
          throw new CompatFieldError(
            `${where}.content[${j}].type='${p.type}'`,
            "supported user content part types are 'text' and 'image_url' (base64 data: URI)",
          );
        });
        out.push({ role: "user", content: blocks });
        return;
      }
      case "assistant": {
        const blocks: ModelContentBlock[] = [];
        const text = textOf();
        if (text) blocks.push({ type: "text", text });
        for (const call of m.tool_calls ?? []) {
          if (call.type !== undefined && call.type !== "function") {
            throw new CompatFieldError(
              `${where}.tool_calls[].type='${call.type}'`,
              "only 'function' tool calls are supported",
            );
          }
          let parsed: unknown = {};
          try {
            parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            throw new CompatFieldError(
              `${where}.tool_calls[].function.arguments`,
              "tool-call arguments must be a JSON object string",
            );
          }
          blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: parsed });
        }
        out.push({ role: "assistant", content: blocks.length ? blocks : (text ?? "") });
        return;
      }
      case "tool": {
        if (!m.tool_call_id) {
          throw new CompatFieldError(`${where}.tool_call_id`, "a 'tool' message needs 'tool_call_id'");
        }
        out.push({
          role: "user",
          content: [{ type: "tool_result", toolUseId: m.tool_call_id, content: textOf() }],
        });
        return;
      }
      default:
        throw new CompatFieldError(
          `${where}.role='${m.role}'`,
          "supported roles are system, developer, user, assistant and tool",
        );
    }
  });
  if (out.length === 0) {
    throw new CompatFieldError(
      "messages",
      "at least one user/assistant/tool message is required — a request of only system turns has nothing to dispatch",
    );
  }
  return { messages: out, system: systemParts.length ? systemParts.join("\n\n") : undefined };
}

function toTools(tools: z.infer<typeof openaiRequestSchema>["tools"]): ModelToolDef[] | undefined {
  if (!tools) return undefined;
  return tools.map((t, i) => {
    if (t.type !== undefined && t.type !== "function") {
      throw new CompatFieldError(
        `tools[${i}].type='${t.type}'`,
        "only 'function' tools are supported; built-in/server-side tools cannot be governed by RegulAIt",
      );
    }
    if (!t.function.parameters) {
      throw new CompatFieldError(`tools[${i}].function.parameters`, "every tool needs a 'parameters' JSON Schema");
    }
    return {
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      inputSchema: t.function.parameters,
    };
  });
}

/**
 * OpenAI `tool_choice` -> the neutral ModelToolChoice (ADR-0020 §5,
 * 2026-07-31 amendment). The three string variants and the named-function
 * object map 1:1. Anything else — `allowed_tools`, `custom`, unknown strings
 * — is a 400 naming the exact variant, never a drop. A named tool must be in
 * the request's own tools list; a forcing variant needs a non-empty list;
 * "auto"/"none" without tools degrade to absent (behaviourally identical).
 */
export function toToolChoice(
  tc: z.infer<typeof openaiRequestSchema>["tool_choice"],
  tools: ModelToolDef[] | undefined,
): ModelToolChoice | undefined {
  if (tc === undefined) return undefined;
  const names = new Set((tools ?? []).map((t) => t.name));
  if (typeof tc === "string") {
    if (tc === "auto" || tc === "none") return names.size > 0 ? tc : undefined;
    if (tc === "required") {
      if (names.size === 0) {
        throw new CompatFieldError(
          "tool_choice='required'",
          "tool_choice 'required' forces a tool call, so the request must declare at least one tool",
        );
      }
      return "required";
    }
    throw new CompatFieldError(
      `tool_choice='${tc}'`,
      `tool_choice variant '${tc}' is not supported by this endpoint. ` +
        `Supported: auto, none, required, {type:'function',function:{name}}.`,
    );
  }
  if (tc.type !== "function") {
    throw new CompatFieldError(
      `tool_choice.type='${tc.type}'`,
      "only 'function' tool_choice objects are supported; other variants have no governed mapping",
    );
  }
  const name = tc.function?.name;
  if (!name) {
    throw new CompatFieldError("tool_choice.function.name", "a function tool_choice needs function.name");
  }
  if (!names.has(name)) {
    throw new CompatFieldError(
      "tool_choice.function.name",
      `tool_choice names '${name}', which is not in this request's tools list ` +
        `(${[...names].join(", ") || "empty"}) — a forced tool must be one the model can actually call`,
    );
  }
  return { name };
}

/** OpenAI `response_format` -> the neutral shape (ADR-0020 §5, 2026-07-31
 * amendment). `text` is a real mapping onto "absent" (it IS the default);
 * json_object passes through; json_schema needs its schema. Any other type is
 * a 400 naming the variant. */
export function toResponseFormat(
  rf: z.infer<typeof openaiRequestSchema>["response_format"],
): ModelResponseFormat | undefined {
  if (!rf) return undefined;
  if (rf.type === "text") return undefined;
  if (rf.type === "json_object") return { type: "json_object" };
  if (rf.type === "json_schema") {
    const schema = rf.json_schema?.schema;
    if (!schema) {
      throw new CompatFieldError(
        "response_format.json_schema.schema",
        "response_format type 'json_schema' needs json_schema.schema (a JSON Schema object)",
      );
    }
    return {
      type: "json_schema",
      ...(rf.json_schema?.name ? { name: rf.json_schema.name } : {}),
      schema,
      ...(typeof rf.json_schema?.strict === "boolean" ? { strict: rf.json_schema.strict } : {}),
    };
  }
  throw new CompatFieldError(
    `response_format.type='${rf.type}'`,
    `response_format variant '${rf.type}' is not supported by this endpoint. ` +
      `Supported: text, json_object, json_schema.`,
  );
}

/** normalized stop reason -> OpenAI finish_reason */
export const FINISH_REASON: Record<string, string> = {
  end_turn: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  // the model itself declined — OpenAI's nearest honest equivalent
  refusal: "content_filter",
  other: "stop",
};

export function toOpenAiResponse(
  id: string,
  created: number,
  prepared: CompatPrepared,
  result: Extract<DispatchOutcome, { ok: true }>["result"],
) {
  const toolCalls = (result.toolCalls ?? []).map((c, i) => ({
    index: i,
    id: c.id,
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
  }));
  return {
    id,
    object: "chat.completion",
    created,
    // ALWAYS the model actually served — never silently the requested one.
    model: result.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.outputText || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: FINISH_REASON[result.stopReason] ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    },
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

export function registerOpenAiCompat(app: FastifyInstance, db: Db, opts: { dataKey?: string } = {}) {
  app.post("/v1/chat/completions", async (req, reply) => {
    // The disabled-surface 404 is applied by app.ts's interception gate in the
    // onRequest phase, before auth — a disabled endpoint is indistinguishable
    // from one that was never registered.
    let body: z.infer<typeof openaiRequestSchema>;
    let translated: OpenAiTranslation;
    let tools: ModelToolDef[] | undefined;
    let toolChoice: ModelToolChoice | undefined;
    let responseFormat: ModelResponseFormat | undefined;
    let ignoredFields: string[] = [];
    try {
      const raw = (req.body ?? {}) as Record<string, unknown>;
      ignoredFields = rejectUnsupportedFields(raw, OPENAI_SUPPORTED_FIELDS, "OpenAI");
      body = openaiRequestSchema.parse(raw);
      translated = toModelMessages(body.messages);
      tools = toTools(body.tools);
      toolChoice = toToolChoice(body.tool_choice, tools);
      responseFormat = toResponseFormat(body.response_format);
    } catch (err) {
      if (err instanceof CompatFieldError) {
        return reply.status(400).send(openaiError(400, "unsupported_field", err.detail));
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
      return reply.status(prep.status).send(openaiError(prep.status, prep.error, prep.detail));
    }
    const prepared = prep.prepared;
    // ADR-0020 long tail: response_format is expressible in this dialect, but
    // the SERVED provider must have a native structured-output mechanism —
    // notably the Anthropic adapter has none, so a request routed there is a
    // 400 naming the field (the documented per-surface asymmetry), never a
    // prompt-nudge pretence.
    const capability = providerCapabilityError(prepared, {
      responseFormat: responseFormat !== undefined,
    });
    if (capability) {
      return reply
        .status(capability.status)
        .send(openaiError(capability.status, capability.error, capability.detail));
    }
    const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`;
    const created = Math.floor(Date.now() / 1000);
    const maxTokens = body.max_completion_tokens ?? body.max_tokens;

    // ---- streaming -------------------------------------------------------
    // Lazily opened, exactly like the Anthropic shim, so a denial raised
    // inside the governed dispatch still returns a real HTTP error.
    if (prepared.useStream) {
      let opened = false;
      const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>) =>
        reply.raw.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: prepared.resolution.servedModel,
            choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
            ...(extra ?? {}),
          })}\n\n`,
        );
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
        chunk({ role: "assistant", content: "" }, null);
      };

      const outcome = await executeCompatCall(db, opts.dataKey, prepared, {
        surface: "openai",
        messages: translated.messages,
        system: translated.system,
        tools,
        toolChoice,
        responseFormat,
        maxTokens,
        onText: (delta) => {
          open();
          chunk({ content: delta }, null);
        },
      });

      if (!outcome.ok) {
        if (!opened) {
          return reply
            .status(outcome.status)
            .send(openaiError(outcome.status, outcome.error, outcome.detail ?? outcome.error));
        }
        reply.raw.write(
          `data: ${JSON.stringify(openaiError(outcome.status, outcome.error, outcome.detail ?? outcome.error))}\n\n`,
        );
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return reply;
      }
      open();
      const toolCalls = (outcome.result.toolCalls ?? []).map((c, i) => ({
        index: i,
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
      }));
      if (toolCalls.length) chunk({ tool_calls: toolCalls }, null);
      chunk({}, FINISH_REASON[outcome.result.stopReason] ?? "stop", {
        usage: {
          prompt_tokens: outcome.result.usage.inputTokens,
          completion_tokens: outcome.result.usage.outputTokens,
          total_tokens: outcome.result.usage.inputTokens + outcome.result.usage.outputTokens,
        },
      });
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return reply;
    }

    // ---- buffered --------------------------------------------------------
    const outcome = await executeCompatCall(db, opts.dataKey, prepared, {
      surface: "openai",
      messages: translated.messages,
      system: translated.system,
      tools,
      toolChoice,
      responseFormat,
      maxTokens,
    });
    disclosureHeaders(reply, prepared);
    if (!outcome.ok) {
      return reply
        .status(outcome.status)
        .send(openaiError(outcome.status, outcome.error, outcome.detail ?? outcome.error));
    }
    return reply.send(toOpenAiResponse(id, created, prepared, outcome.result));
  });
}
