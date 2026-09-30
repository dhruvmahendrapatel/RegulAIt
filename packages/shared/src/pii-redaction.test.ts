import { describe, expect, it } from "vitest";
import { detectPII, PII_REDACTION_VERSION, redactPII } from "./pii.js";
import { ALL_INTERNATIONAL_CATEGORIES, INTERNATIONAL_DETECTORS } from "./pii-international.js";
import { DOCUMENTED_MISSES, NEGATIVE_VECTORS, POSITIVE_VECTORS } from "./pii-vectors.js";

describe("validated PII redaction foundation", () => {
  for (const vector of POSITIVE_VECTORS) {
    it(`removes the complete ${vector.id} using enabled validators`, () => {
      const text = `before <${vector.text}> after`;
      const result = redactPII(text, ALL_INTERNATIONAL_CATEGORIES);
      if (vector.id === "p.cpf.in_json") {
        expect(result.text).toBe('before <{"cpf":"[CPF]"}> after');
      } else {
        expect(result.text).toMatch(/^before <\[[A-Z_]+\]> after$/);
      }
      expect(result.text).not.toContain(vector.text);
      expect(result.hits).toEqual(detectPII(text, ALL_INTERNATIONAL_CATEGORIES));
      expect(result.hits.some((hit) => hit.category === vector.category)).toBe(true);
      expect(detectPII(result.text, ALL_INTERNATIONAL_CATEGORIES)).toEqual([]);
      expect(redactPII(result.text, ALL_INTERNATIONAL_CATEGORIES).text).toBe(result.text);
    });
  }

  for (const vector of [...NEGATIVE_VECTORS, ...DOCUMENTED_MISSES]) {
    it(`preserves the detector's limits for ${vector.id}`, () => {
      const probe = vector.category === "email" ? "123-45-6789" : "probe@regulait.invalid";
      const text = `before ${vector.text} probe ${probe} after`;
      const result = redactPII(text, ALL_INTERNATIONAL_CATEGORIES);
      expect(result.hits).toEqual(detectPII(text, ALL_INTERNATIONAL_CATEGORIES));
      expect(result.hits.some((hit) => hit.category === vector.category)).toBe(false);
      expect(result.text).not.toContain(probe);
      expect(result.text).toContain(vector.category === "email" ? "[SSN]" : "[EMAIL]");
    });
  }

  for (const detector of INTERNATIONAL_DETECTORS) {
    it(`${detector.category} reports exactly one validated offset per count`, () => {
      const vector = POSITIVE_VECTORS.find((v) => v.category === detector.category)!;
      const text = `first <${vector.text}> second <${vector.text}>`;
      const matches: [number, number][] = [];
      const count = detector.count(text, (start, end) => matches.push([start, end]));
      expect(count).toBe(2);
      expect(matches).toHaveLength(count);
      expect(matches.map(([start, end]) => text.slice(start, end))).toEqual([vector.text, vector.text]);
      for (const nearMiss of NEGATIVE_VECTORS.filter((v) => v.category === detector.category)) {
        const unexpected: number[] = [];
        expect(detector.count(nearMiss.text, (start) => unexpected.push(start))).toBe(0);
        expect(unexpected).toEqual([]);
      }
    });
  }

  it("keeps clean text byte-for-byte, including empty and Unicode strings", () => {
    for (const text of ["", "  \r\n", "Benign text: \u{1F512} caf\u00e9", "[EMAIL] [CARD] [AADHAAR]"]) {
      expect(redactPII(text, ALL_INTERNATIONAL_CATEGORIES)).toEqual({ text, hits: [] });
    }
  });

  it("replaces repeated matches without consuming adjacent punctuation or Unicode", () => {
    const result = redactPII("\u{1F512} a@b.invalid/a@b.invalid; 123-45-6789. caf\u00e9");
    expect(result).toEqual({
      text: "\u{1F512} [EMAIL]/[EMAIL]; [SSN]. caf\u00e9",
      hits: [{ category: "email", count: 2 }, { category: "ssn", count: 1 }],
    });
  });

  it("assigns a nested match one placeholder while retaining existing detector counts", () => {
    const result = redactPII("415-555-2671@example.invalid");
    expect(result).toEqual({
      text: "[EMAIL]",
      hits: [{ category: "email", count: 1 }, { category: "phone", count: 1 }],
    });
  });

  it("removes the full union when a higher-priority match only overlaps a tail", () => {
    const text = "before 4111 1111 1111 1111@example.invalid after";
    expect(redactPII(text)).toEqual({
      text: "before [EMAIL] after",
      hits: [{ category: "email", count: 1 }, { category: "credit_card", count: 1 }],
    });
  });

  it("does not enable opt-in categories on upgrade", () => {
    const text = "Aadhaar 234567890124";
    expect(redactPII(text)).toEqual({ text, hits: [] });
    expect(redactPII(text, ["aadhaar"])).toEqual({
      text: "Aadhaar [AADHAAR]", hits: [{ category: "aadhaar", count: 1 }],
    });
  });

  it("is deterministic across reordered and duplicate enabled categories", () => {
    const text = POSITIVE_VECTORS.map((v) => v.text).join("; ");
    const first = redactPII(text, ALL_INTERNATIONAL_CATEGORIES);
    const reordered = [...ALL_INTERNATIONAL_CATEGORIES].reverse();
    expect(redactPII(text, [...reordered, ...reordered])).toEqual(first);
    expect(first.hits).toEqual(detectPII(text, ALL_INTERNATIONAL_CATEGORIES));
    expect(PII_REDACTION_VERSION).toBe("validated-spans-v1");
  });

  it("returns no offsets or original substrings in metadata", () => {
    const result = redactPII("a@b.invalid 123-45-6789");
    expect(Object.keys(result).sort()).toEqual(["hits", "text"]);
    for (const hit of result.hits) expect(Object.keys(hit).sort()).toEqual(["category", "count"]);
    expect(JSON.stringify(result)).not.toContain("a@b.invalid");
    expect(JSON.stringify(result)).not.toContain("123-45-6789");
  });

  it("redacts decoded escaped strings without treating raw JSON as decoded content", () => {
    const encoded = '"a\\u0040b.invalid"';
    expect(redactPII(encoded).hits).toEqual([]);
    expect(redactPII(JSON.parse(encoded))).toEqual({
      text: "[EMAIL]", hits: [{ category: "email", count: 1 }],
    });
  });

  it("international match visitors remain reentrant", () => {
    for (const detector of INTERNATIONAL_DETECTORS) {
      const vector = POSITIVE_VECTORS.find((v) => v.category === detector.category)!;
      let visited = 0;
      expect(detector.count(`${vector.text}; ${vector.text}`, () => {
        visited++;
        expect(detector.count(vector.text)).toBe(1);
      })).toBe(2);
      expect(visited).toBe(2);
    }
  });
});
