import { INTERNATIONAL_PII_CATEGORIES, type InternationalPiiCategory } from "./pii-international.js";
import { redactPII, type PiiCategory, type PiiHit } from "./pii.js";

export type PiiJsonValue = null | boolean | number | string |
  readonly PiiJsonValue[] | { readonly [key: string]: PiiJsonValue };

export const PII_PAYLOAD_VERSION = "decoded-json-v1";
export interface PiiPayloadLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxCodeUnits: number;
}
export const PII_PAYLOAD_LIMITS: PiiPayloadLimits = Object.freeze({ maxDepth: 64, maxNodes: 20_000, maxCodeUnits: 1_000_000 });
export type PiiPayloadErrorCode = "unsupported_value" | "sensitive_key" | "unsafe_number" |
  "limit_exceeded" | "invalid_configuration";

/** No payload, key, path or offending value is attached to this error. */
export class PiiPayloadError extends Error {
  constructor(readonly code: PiiPayloadErrorCode) {
    super(`PII payload transformation refused: ${code}`);
    this.name = "PiiPayloadError";
  }
}

/**
 * Transform a parsed JSON payload without changing its shape or mutating it.
 * Sensitive keys and numeric identifiers are refused: renaming a field or
 * changing a number to a placeholder string can change a tool's operation.
 * The returned copy is deeply frozen for final-byte approval binding. A
 * caller may tighten the published resource limits, never raise them.
 * This scans decoded string values, not encoded/binary content or nested
 * serialization formats inside a string. Only hits are safe audit metadata.
 */
export function redactPiiPayload(
  input: unknown,
  international: readonly InternationalPiiCategory[],
  limits: PiiPayloadLimits = PII_PAYLOAD_LIMITS,
): { value: PiiJsonValue; hits: PiiHit[] } {
  if (Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1) ||
      !Number.isSafeInteger(limits.maxDepth) || !Number.isSafeInteger(limits.maxNodes) ||
      !Number.isSafeInteger(limits.maxCodeUnits) ||
      limits.maxDepth > PII_PAYLOAD_LIMITS.maxDepth || limits.maxNodes > PII_PAYLOAD_LIMITS.maxNodes ||
      limits.maxCodeUnits > PII_PAYLOAD_LIMITS.maxCodeUnits ||
      international.some((category) => !INTERNATIONAL_PII_CATEGORIES.includes(category))) {
    throw new PiiPayloadError("invalid_configuration");
  }
  const enabled = [...new Set(international)];
  const counts = new Map<PiiCategory, number>();
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  let codeUnits = 0;
  const consumeText = (text: string) => {
    codeUnits += text.length;
    if (codeUnits > limits.maxCodeUnits) throw new PiiPayloadError("limit_exceeded");
    return redactPII(text, enabled);
  };
  const visit = (value: unknown, depth: number): PiiJsonValue => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) throw new PiiPayloadError("limit_exceeded");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      const result = consumeText(value);
      for (const hit of result.hits) counts.set(hit.category, (counts.get(hit.category) ?? 0) + hit.count);
      return result.text;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
          consumeText(String(value)).hits.length > 0) {
        throw new PiiPayloadError("unsafe_number");
      }
      return value;
    }
    if (typeof value !== "object") throw new PiiPayloadError("unsupported_value");
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new PiiPayloadError("unsupported_value");
    }
    if (ancestors.has(value)) throw new PiiPayloadError("unsupported_value");
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) throw new PiiPayloadError("unsupported_value");
    const read = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new PiiPayloadError("unsupported_value");
      }
      return descriptor.value;
    };
    let output: PiiJsonValue;
    if (array) {
      // Refuse holes, custom array properties and getters rather than letting
      // JSON serialization silently omit or reinterpret them.
      if (keys.length !== value.length + 1 || value.length > limits.maxNodes - nodes) {
        throw new PiiPayloadError(keys.length !== value.length + 1 ? "unsupported_value" : "limit_exceeded");
      }
      const items: PiiJsonValue[] = [];
      for (let i = 0; i < value.length; i++) items.push(visit(read(String(i)), depth + 1));
      output = Object.freeze(items);
    } else {
      if (keys.length > limits.maxNodes - nodes) throw new PiiPayloadError("limit_exceeded");
      const entries: [string, PiiJsonValue][] = [];
      // Stable traversal makes hit ordering independent of JSON property order.
      for (const key of (keys as string[]).sort()) {
        if (consumeText(key).hits.length > 0) throw new PiiPayloadError("sensitive_key");
        entries.push([key, visit(read(key), depth + 1)]);
      }
      // fromEntries defines __proto__ as an own data property, not a setter.
      output = Object.freeze(Object.fromEntries(entries));
    }
    ancestors.delete(value);
    return output;
  };
  const value = visit(input, 0);
  const order: PiiCategory[] = ["email", "ssn", "credit_card", "phone", ...INTERNATIONAL_PII_CATEGORIES];
  const hits = order.filter((category) => counts.has(category))
    .map((category) => ({ category, count: counts.get(category)! }));
  return { value, hits };
}
