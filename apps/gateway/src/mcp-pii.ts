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

/**
 * B3S-04 (batch-3 security review) — BASE64 `blob` CONTENT IS SCANNED OR
 * WITHHELD, NEVER RELEASED UNSCANNED.
 *
 * MCP carries binary resource content as a base64 `blob` (an embedded resource
 * in a tool result, `resources/read` contents). The PII block/warn/log scan
 * read the JSON text of a result, in which a blob is opaque, so a text file
 * full of PII went out unscanned whenever it was base64-wrapped. Now every
 * `blob` is either DECODED AND SCANNED (its `mimeType` is `text/*`,
 * `application/json` or `application/xml`, it is canonical base64 and the
 * bytes are valid UTF-8) or reported UNSCANNABLE, and the caller withholds an
 * unscannable result under every PII mode except off. (Redact mode already
 * withholds any blob: base64 cannot be released redacted.)
 */
const SCANNABLE_BLOB_MIME = new Set(["application/json", "application/xml"]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function isScannableBlobMime(mime: unknown): boolean {
  if (typeof mime !== "string") return false;
  const base = mime.split(";")[0]!.trim().toLowerCase();
  return base.startsWith("text/") || SCANNABLE_BLOB_MIME.has(base);
}

/** the decoded text of one blob, or null when it cannot be scanned */
function decodeTextBlob(blob: unknown, mime: unknown): string | null {
  if (typeof blob !== "string" || !isScannableBlobMime(mime)) return null;
  if (blob.length % 4 !== 0 || !BASE64_RE.test(blob)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(blob, "base64"));
  } catch {
    return null;
  }
}

export interface McpBlobContents {
  /** the decoded text of every scannable blob, to be scanned with the rest */
  texts: string[];
  /** at least one blob (or a structure too deep to walk) cannot be scanned */
  unscannable: boolean;
  /** the result carries at least one blob */
  any: boolean;
}

/** every base64 `blob` anywhere in an MCP result (tool result, resource contents, a notification) */
export function decodeMcpBlobs(value: unknown): McpBlobContents {
  const out: McpBlobContents = { texts: [], unscannable: false, any: false };
  const walk = (v: unknown, depth: number): void => {
    if (depth > 64) {
      out.unscannable = true;
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(o, "blob")) {
        out.any = true;
        const text = decodeTextBlob(o.blob, o.mimeType);
        if (text === null) out.unscannable = true;
        else out.texts.push(text);
      }
      for (const [k, x] of Object.entries(o)) if (k !== "blob") walk(x, depth + 1);
    }
  };
  walk(value, 0);
  return out;
}

/** the text a non-redact PII (or guardrail) scan reads: the JSON plus every decoded blob */
export function scannableMcpText(value: unknown, blobs: McpBlobContents): string {
  return [JSON.stringify(value ?? null), ...blobs.texts].join("\n");
}
