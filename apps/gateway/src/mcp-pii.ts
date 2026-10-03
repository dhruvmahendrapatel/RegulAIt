import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import {
  approvalArgumentsDigest,
  canonicalJson,
  preparePiiApproval,
  redactPiiPayload,
  sha256Hex,
  type InternationalPiiCategory,
  type PreparedPiiApproval,
} from "@regulait/shared";

export class McpPiiPreparationError extends Error {
  constructor() {
    super("MCP PII transformation or input schema validation failed");
  }
}

/** The first integration only accepts synchronous, self-contained schemas. */
function assertSupportedSchema(value: unknown, depth = 0): void {
  if (depth > 64) throw new McpPiiPreparationError();
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["$id", "$ref", "$dynamicRef", "$recursiveRef", "$async"].includes(key)) {
      throw new McpPiiPreparationError();
    }
    assertSupportedSchema(child, depth + 1);
  }
}

export function prepareMcpPiiAction(
  projectId: string | null,
  args: Record<string, unknown> | undefined,
  international: readonly InternationalPiiCategory[],
  inputSchema: Record<string, unknown> | null | undefined,
): PreparedPiiApproval {
  try {
    if (!inputSchema || inputSchema.type !== "object") throw new McpPiiPreparationError();
    assertSupportedSchema(inputSchema);
    if (inputSchema.$schema !== undefined && inputSchema.$schema !== "http://json-schema.org/draft-07/schema#") {
      throw new McpPiiPreparationError();
    }
    const prepared = preparePiiApproval({ projectId, arguments: args }, international);
    // Strict schema validation refuses unknown keywords/formats; a fresh
    // instance cannot reuse another tool's contract through the schema-ID cache.
    const validator = new Ajv({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
    addFormats.default(validator);
    const validate = validator.compile(inputSchema);
    if (!validate(prepared.effectiveArguments)) throw new McpPiiPreparationError();
    const schemaDigest = sha256Hex(canonicalJson(inputSchema));
    return Object.freeze({
      ...prepared,
      argumentsDigest: approvalArgumentsDigest({
        projectId,
        arguments: { namespace: "regulait.mcp-pii-action.v1", preparedDigest: prepared.argumentsDigest, schemaDigest },
      }),
      argumentsPreview: Object.freeze({ prepared: prepared.argumentsPreview, schemaDigest }),
    });
  } catch {
    // Validator messages may interpolate instance values/schema literals.
    throw new McpPiiPreparationError();
  }
}

export function redactMcpResult(result: unknown, international: readonly InternationalPiiCategory[]) {
  const transformed = redactPiiPayload(result, international);
  const value = transformed.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpPiiPreparationError();
  const record = value as Record<string, unknown>;
  // Text and decoded structuredContent are supported. Do not pretend to inspect
  // base64, resource links, embedded resources, or extension content blocks.
  if (!Array.isArray(record.content) || record.content.some((block) =>
    !block || typeof block !== "object" || (block as { type?: unknown }).type !== "text" ||
    typeof (block as { text?: unknown }).text !== "string" ||
    Object.keys(block).some((key) => key !== "type" && key !== "text")
  ) || Object.keys(record).some((key) => !["content", "structuredContent", "isError"].includes(key))) {
    throw new McpPiiPreparationError();
  }
  return transformed;
}
