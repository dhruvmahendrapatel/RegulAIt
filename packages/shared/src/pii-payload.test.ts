import { describe, expect, it } from "vitest";
import { ALL_INTERNATIONAL_CATEGORIES, type InternationalPiiCategory } from "./pii-international.js";
import { detectPII } from "./pii.js";
import { PII_PAYLOAD_LIMITS, PII_PAYLOAD_VERSION, PiiPayloadError, redactPiiPayload } from "./pii-payload.js";
import { POSITIVE_VECTORS } from "./pii-vectors.js";

describe("decoded structured PII transformation", () => {
  for (const vector of POSITIVE_VECTORS) {
    it(`redacts ${vector.id} in a nested string leaf`, () => {
      const input = { nested: [null, { text: vector.text }], clean: [true, 12.5] };
      const original = JSON.stringify(input);
      const result = redactPiiPayload(input, ALL_INTERNATIONAL_CATEGORIES);
      expect(JSON.stringify(result.value)).not.toContain(vector.text);
      expect(detectPII(JSON.stringify(result.value), ALL_INTERNATIONAL_CATEGORIES)).toEqual([]);
      expect(result.hits.some((hit) => hit.category === vector.category)).toBe(true);
      expect(JSON.stringify(input)).toBe(original);
      expect(result.value).toMatchObject({ clean: [true, 12.5], nested: [null, expect.any(Object)] });
    });
  }

  it("scans decoded JSON escapes, not their wire spelling", () => {
    const input = JSON.parse('{"email":"a\\u0040b.invalid","ssn":"123\\u002d45-6789"}');
    expect(redactPiiPayload(input, [])).toEqual({
      value: { email: "[EMAIL]", ssn: "[SSN]" },
      hits: [{ category: "email", count: 1 }, { category: "ssn", count: 1 }],
    });
  });

  it("preserves punctuation, escaped quotes, backslashes and value types", () => {
    const input = { text: 'say "a@b.invalid" in C:\\work\nnext', count: 3, enabled: false, absent: null };
    expect(redactPiiPayload(input, []).value).toEqual({
      text: 'say "[EMAIL]" in C:\\work\nnext', count: 3, enabled: false, absent: null,
    });
  });

  it("aggregates counts in detector order, independent of property/category order", () => {
    const a = redactPiiPayload({ z: "a@b.invalid", a: ["123-45-6789", "c@d.invalid", "234567890124"] }, ["aadhaar"]);
    const b = redactPiiPayload({ a: ["123-45-6789", "c@d.invalid", "234567890124"], z: "a@b.invalid" }, ["aadhaar", "aadhaar"]);
    expect(a).toEqual(b);
    expect(a.hits).toEqual([{ category: "email", count: 2 }, { category: "ssn", count: 1 }, { category: "aadhaar", count: 1 }]);
  });

  it("keeps international categories opt-in", () => {
    expect(redactPiiPayload({ id: "234567890124" }, [])).toEqual({ value: { id: "234567890124" }, hits: [] });
    expect(redactPiiPayload({ id: "234567890124" }, ["aadhaar"]).value).toEqual({ id: "[AADHAAR]" });
  });

  it("rejects PII in keys without renaming, colliding or mutating fields", () => {
    const input = { "a@b.invalid": "one", "c@d.invalid": "two", clean: "unchanged" };
    expect(() => redactPiiPayload(input, [])).toThrowError(new PiiPayloadError("sensitive_key"));
    expect(Object.keys(input)).toEqual(["a@b.invalid", "c@d.invalid", "clean"]);
  });

  it("rejects numeric PII instead of changing its type", () => {
    expect(() => redactPiiPayload({ card: 4111111111111111 }, [])).toThrowError(new PiiPayloadError("unsafe_number"));
    expect(() => redactPiiPayload({ id: 234567890124 }, ["aadhaar"])).toThrowError(new PiiPayloadError("unsafe_number"));
    expect(redactPiiPayload({ id: 234567890124 }, []).value).toEqual({ id: 234567890124 });
  });

  it("rejects non-finite and precision-losing numbers", () => {
    for (const number of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => redactPiiPayload({ number }, [])).toThrowError(new PiiPayloadError("unsafe_number"));
    }
  });

  it("copies and deeply freezes the exact effective payload", () => {
    const input = { nested: [{ text: "a@b.invalid", clean: "original" }] };
    const result = redactPiiPayload(input, []);
    input.nested[0]!.clean = "changed";
    expect(result.value).toEqual({ nested: [{ text: "[EMAIL]", clean: "original" }] });
    const value = result.value as { nested: { text: string; clean: string }[] };
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(Object.isFrozen(value.nested[0])).toBe(true);
    expect(() => { value.nested[0]!.text = "changed"; }).toThrow();
    expect(() => value.nested.push({ text: "changed", clean: "changed" })).toThrow();
  });

  it("treats __proto__ as data and does not pollute prototypes", () => {
    const input = JSON.parse('{"__proto__":{"text":"a@b.invalid"},"constructor":"ordinary"}');
    const result = redactPiiPayload(input, []);
    expect(Object.hasOwn(result.value as object, "__proto__")).toBe(true);
    expect(JSON.stringify(result.value)).toBe('{"__proto__":{"text":"[EMAIL]"},"constructor":"ordinary"}');
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "text")).toBe(false);
  });

  it("rejects unsupported values rather than silently omitting them", () => {
    for (const value of [undefined, () => "ignored", Symbol("ignored"), 1n, new Date(), new Map(), new Set()]) {
      expect(() => redactPiiPayload({ value }, [])).toThrowError(new PiiPayloadError("unsupported_value"));
    }
  });

  it("refuses accessors without invoking their code", () => {
    let calls = 0;
    const input = Object.defineProperty({}, "text", { enumerable: true, get: () => { calls++; return "a@b.invalid"; } });
    expect(() => redactPiiPayload(input, [])).toThrowError(new PiiPayloadError("unsupported_value"));
    expect(calls).toBe(0);
  });

  it("rejects symbols and hidden fields", () => {
    const hidden = Object.defineProperty({}, "text", { value: "a@b.invalid", enumerable: false });
    expect(() => redactPiiPayload(hidden, [])).toThrowError(new PiiPayloadError("unsupported_value"));
    expect(() => redactPiiPayload({ [Symbol("text")]: "a@b.invalid" }, [])).toThrowError(new PiiPayloadError("unsupported_value"));
  });

  it("rejects sparse or decorated arrays", () => {
    expect(() => redactPiiPayload(new Array(2), [])).toThrowError(new PiiPayloadError("unsupported_value"));
    const decorated = Object.assign(["clean"], { secret: "a@b.invalid" });
    expect(() => redactPiiPayload(decorated, [])).toThrowError(new PiiPayloadError("unsupported_value"));
  });

  it("rejects cycles but allows repeated acyclic references", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => redactPiiPayload(cycle, [])).toThrowError(new PiiPayloadError("unsupported_value"));
    const shared = { text: "a@b.invalid" };
    expect(redactPiiPayload([shared, shared], [])).toEqual({
      value: [{ text: "[EMAIL]" }, { text: "[EMAIL]" }], hits: [{ category: "email", count: 2 }],
    });
  });

  it("enforces depth and node limits at their boundaries", () => {
    const limits = { ...PII_PAYLOAD_LIMITS, maxDepth: 1, maxNodes: 3 };
    expect(redactPiiPayload([true, null], [], limits).value).toEqual([true, null]);
    expect(() => redactPiiPayload([true, null, false], [], limits)).toThrowError(new PiiPayloadError("limit_exceeded"));
    expect(() => redactPiiPayload([[true]], [], limits)).toThrowError(new PiiPayloadError("limit_exceeded"));
  });

  it("limits cumulative decoded text and keys before scanning", () => {
    const limits = { ...PII_PAYLOAD_LIMITS, maxCodeUnits: 6 };
    expect(redactPiiPayload({ key: "abc" }, [], limits).value).toEqual({ key: "abc" });
    expect(() => redactPiiPayload({ key: "abcd" }, [], limits)).toThrowError(new PiiPayloadError("limit_exceeded"));
    expect(() => redactPiiPayload(["abc", "abcd"], [], limits)).toThrowError(new PiiPayloadError("limit_exceeded"));
  });

  it("rejects invalid configuration rather than silently weakening coverage", () => {
    for (const maxDepth of [0, -1, Infinity, NaN, 1.5, PII_PAYLOAD_LIMITS.maxDepth + 1]) {
      expect(() => redactPiiPayload({}, [], { ...PII_PAYLOAD_LIMITS, maxDepth })).toThrowError(new PiiPayloadError("invalid_configuration"));
    }
    expect(() => redactPiiPayload({}, ["unknown" as InternationalPiiCategory])).toThrowError(new PiiPayloadError("invalid_configuration"));
    expect(PII_PAYLOAD_VERSION).toBe("decoded-json-v1");
  });

  it("errors expose no raw payload, key or offset", () => {
    try {
      redactPiiPayload({ "secret.person@regulait.invalid": "secret value" }, []);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PiiPayloadError);
      expect(String(error)).not.toContain("secret");
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(Object.keys(error as object).sort()).toEqual(["code", "name"]);
    }
  });
});
