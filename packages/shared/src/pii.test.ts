import { describe, expect, it } from "vitest";
import { detectPII, type PiiHit } from "./pii.js";

/** helper: the count for one category, or 0 if absent */
function countOf(hits: PiiHit[], category: PiiHit["category"]): number {
  return hits.find((h) => h.category === category)?.count ?? 0;
}

describe("detectPII", () => {
  it("returns [] for empty input", () => {
    expect(detectPII("")).toEqual([]);
    expect(detectPII("   ")).toEqual([]);
  });

  it("returns [] for benign prose with no PII", () => {
    const text =
      "Plan an audit-export endpoint for PHI access logs. Retention is seven years. " +
      "Deliverables: the endpoint contract in src/checkout/payments.ts.";
    expect(detectPII(text)).toEqual([]);
  });

  describe("email", () => {
    it("detects an email address", () => {
      expect(countOf(detectPII("contact dana@regulait.local please"), "email")).toBe(1);
    });
    it("counts multiple emails", () => {
      expect(countOf(detectPII("a@b.com and c.d@e-f.co.uk"), "email")).toBe(2);
    });
    it("does not match a bare domain or handle", () => {
      expect(countOf(detectPII("visit example.com or @dana"), "email")).toBe(0);
    });
  });

  describe("ssn", () => {
    it("detects a well-formed US SSN", () => {
      expect(countOf(detectPII("SSN 123-45-6789 on file"), "ssn")).toBe(1);
    });
    it("rejects invalid area/group/serial ranges", () => {
      // area 000, area 666, group 00, serial 0000 are never issued
      expect(countOf(detectPII("000-12-3456"), "ssn")).toBe(0);
      expect(countOf(detectPII("666-12-3456"), "ssn")).toBe(0);
      expect(countOf(detectPII("900-12-3456"), "ssn")).toBe(0);
      expect(countOf(detectPII("123-00-6789"), "ssn")).toBe(0);
      expect(countOf(detectPII("123-45-0000"), "ssn")).toBe(0);
    });
    it("does not match a non-SSN digit shape", () => {
      expect(countOf(detectPII("order 12-345-6789"), "ssn")).toBe(0);
    });
  });

  describe("credit_card", () => {
    it("detects a Luhn-valid 16-digit card (grouped by spaces)", () => {
      expect(countOf(detectPII("card 4111 1111 1111 1111 exp"), "credit_card")).toBe(1);
    });
    it("detects a Luhn-valid card with no separators", () => {
      expect(countOf(detectPII("4111111111111111"), "credit_card")).toBe(1);
    });
    it("rejects a 16-digit run that FAILS the Luhn check", () => {
      expect(countOf(detectPII("1234 5678 9012 3456"), "credit_card")).toBe(0);
      expect(countOf(detectPII("4111 1111 1111 1112"), "credit_card")).toBe(0);
    });
    it("does not treat a 9-digit SSN as a card", () => {
      expect(countOf(detectPII("123-45-6789"), "credit_card")).toBe(0);
    });
  });

  describe("phone", () => {
    it("detects a formatted US phone", () => {
      expect(countOf(detectPII("call (415) 555-2671 today"), "phone")).toBe(1);
      expect(countOf(detectPII("415-555-2671"), "phone")).toBe(1);
      expect(countOf(detectPII("+1 415 555 2671"), "phone")).toBe(1);
    });
    it("does not match a bare 10-digit run (no separators)", () => {
      expect(countOf(detectPII("id 4155552671"), "phone")).toBe(0);
    });
    it("does not match an SSN as a phone", () => {
      expect(countOf(detectPII("123-45-6789"), "phone")).toBe(0);
    });
  });

  it("reports COUNTS ONLY — never the matched substrings", () => {
    const hits = detectPII("dana@regulait.local and SSN 123-45-6789");
    // every hit is exactly {category, count} — no field can leak the match
    for (const h of hits) {
      expect(Object.keys(h).sort()).toEqual(["category", "count"]);
      expect(typeof h.count).toBe("number");
    }
    expect(countOf(hits, "email")).toBe(1);
    expect(countOf(hits, "ssn")).toBe(1);
  });

  it("detects multiple categories together in a stable order", () => {
    const hits = detectPII("email x@y.com ssn 123-45-6789 card 4111 1111 1111 1111 tel 415-555-2671");
    expect(hits.map((h) => h.category)).toEqual(["email", "ssn", "credit_card", "phone"]);
  });
});
