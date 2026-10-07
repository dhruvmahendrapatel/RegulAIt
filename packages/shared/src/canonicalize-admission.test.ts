/**
 * ADR-0186 — the ADMISSION TEST for `canonicalize` 5.1.0 (Apache-2.0, RFC 8785
 * JCS). ADR-0176 says a validated module replaces hand-written code; ADR-0186
 * admits this one only if it is BYTE-IDENTICAL to our `canonicalJson`
 * (`audit-chain.ts`, ADR-0060) for receipt payloads, because every existing
 * digest (audit chain, approval binding, accountability records) and every
 * receipt signature would otherwise change meaning under a swap.
 *
 * What is compared: a corpus of receipt-shaped payloads (the
 * `DecisionReceiptPayload` shape with real-looking values, nulls, every effect,
 * non-ASCII and escape-needing strings, key orders shuffled, nested objects,
 * arrays, Dates via toJSON, -0 and large integers) plus 2 000 seeded random
 * JSON values. Every one must serialise identically.
 *
 * Where they DIFFER, by construction (not part of the admission; pinned below
 * so a reader sees the difference): `canonicalize` THROWS on NaN, ±Infinity and
 * lone surrogates (RFC 8785 forbids them), where `canonicalJson` writes `null`
 * for non-finite numbers (JSON.stringify's rule, what reaches jsonb) and
 * escapes a lone surrogate. A receipt payload holds neither: its numbers are
 * sequence numbers and its strings are uuids, hex digests, ISO times, rule ids
 * and tool names.
 *
 * Result recorded in ADR-0186's note list by the foundation: ADMITTED for
 * receipt payloads (this file passes). `canonicalJson` stays the canonicaliser
 * of the existing digests; slice R may use either for receipts, and the test
 * below is what keeps that choice safe.
 */
import { describe, expect, it } from "vitest";
import canonicalize from "canonicalize";
import { canonicalJson } from "./audit-chain.js";
import { RECEIPT_GENESIS_PREV, RECEIPT_PAYLOAD_VERSION, type DecisionReceiptPayload } from "./batch4.js";

const hex = (n: number, seed: number) => {
  let x = seed >>> 0;
  let out = "";
  for (let i = 0; i < n; i += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out += (x >>> 28).toString(16);
  }
  return out;
};
const uuid = (seed: number) => {
  const h = hex(32, seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function receipt(i: number, over: Partial<DecisionReceiptPayload["decision"]> = {}): DecisionReceiptPayload {
  return {
    v: RECEIPT_PAYLOAD_VERSION,
    receiptSeq: i + 1,
    audit: { id: uuid(i), seq: 1000 + i * 7, rowHash: hex(64, i + 11), contentHash: hex(64, i + 13) },
    decision: {
      at: new Date(Date.UTC(2026, 9, 7, 12, 0, i % 60, i % 1000)).toISOString(),
      userId: uuid(i + 99),
      objectType: (["mcp_tool", "agent", "connector", "approval"] as const)[i % 4]!,
      objectId: i % 3 === 0 ? null : uuid(i + 7),
      serverId: i % 2 === 0 ? uuid(i + 5) : null,
      toolName: i % 5 === 0 ? null : `tool_${i}.read-file`,
      effect: (["allow", "deny", "require_approval"] as const)[i % 3]!,
      ruleId: i % 4 === 0 ? null : `rule-${i}`,
      ...over,
    },
    prev: i === 0 ? RECEIPT_GENESIS_PREV : hex(64, i + 17),
    keyId: `receipt-key-${i % 3}`,
  };
}

/** the same object with its keys inserted in reverse order, at every depth */
function reversedKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reversedKeys);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).reverse()) out[k] = reversedKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function randomJson(seedRef: { s: number }, depth = 0): unknown {
  const next = () => {
    seedRef.s = (Math.imul(seedRef.s, 1103515245) + 12345) >>> 0;
    return seedRef.s;
  };
  const pick = next() % (depth > 3 ? 5 : 7);
  switch (pick) {
    case 0:
      return null;
    case 1:
      return next() % 2 === 0;
    case 2: {
      const r = next();
      return r % 3 === 0 ? r : r % 3 === 1 ? -(r % 100000) / 7 : (r % 1000) * 1e15;
    }
    case 3: {
      const alphabet = ['a', 'Z', '0', ' ', '"', "\\", "\n", "\t", "\u0001", "é", "€", "😀", " ", "/", "<"];
      let s = "";
      const n = next() % 12;
      for (let i = 0; i < n; i += 1) s += alphabet[next() % alphabet.length];
      return s;
    }
    case 4:
      return uuid(next());
    case 5: {
      const n = next() % 5;
      return Array.from({ length: n }, () => randomJson(seedRef, depth + 1));
    }
    default: {
      const n = next() % 6;
      const o: Record<string, unknown> = {};
      for (let i = 0; i < n; i += 1) o[`${["k", "K", "é", "a_b", "10", "2", "é", "😀"][next() % 8]}${next() % 4}`] = randomJson(seedRef, depth + 1);
      return o;
    }
  }
}

describe("ADR-0186 canonicalize admission: byte-identical to canonicalJson for receipt payloads", () => {
  it("every receipt-shaped payload in the corpus serialises identically (and key order is not an input)", () => {
    const corpus: unknown[] = [];
    for (let i = 0; i < 300; i += 1) corpus.push(receipt(i));
    corpus.push(
      receipt(1, { toolName: 'quote " backslash \\ newline \n tab \t nul \u0000 bell \u0007' }),
      receipt(2, { toolName: "non-ASCII é € 漢字 😀    " }),
      receipt(3, { ruleId: "</script><!--" }),
      receipt(4, { objectId: null, serverId: null, toolName: null, ruleId: null }),
    );
    for (const p of corpus) {
      const ours = canonicalJson(p);
      expect(canonicalize(p)).toBe(ours);
      expect(canonicalize(reversedKeys(p))).toBe(ours);
      expect(canonicalJson(reversedKeys(p))).toBe(ours);
    }
  });

  it("the edge values a payload builder could pass agree too: Date via toJSON, -0, big safe integers, nested arrays", () => {
    const values: unknown[] = [
      { at: new Date(Date.UTC(2026, 0, 1)), n: -0, big: Number.MAX_SAFE_INTEGER, small: Number.MIN_SAFE_INTEGER },
      { a: [1, [2, [3, { z: 1, a: 2 }]]], e: [], o: {} },
      { exp: 1e21, frac: 0.1 + 0.2, tiny: 5e-324, neg: -1.5e-7 },
      { skip: undefined, keep: null },
      [undefined, null, 1],
      "top-level string",
      42,
      null,
      true,
    ];
    for (const v of values) expect(canonicalize(v)).toBe(canonicalJson(v));
  });

  it("2 000 seeded random JSON values serialise identically", () => {
    const seed = { s: 186 };
    for (let i = 0; i < 2000; i += 1) {
      const v = randomJson(seed);
      expect(canonicalize(v), JSON.stringify(v)).toBe(canonicalJson(v));
    }
  });

  it("the known, documented differences (outside receipt payloads): canonicalize refuses what canonicalJson maps", () => {
    expect(canonicalJson({ n: Number.NaN })).toBe('{"n":null}');
    expect(() => canonicalize({ n: Number.NaN })).toThrow(/NaN/);
    expect(canonicalJson({ n: Number.POSITIVE_INFINITY })).toBe('{"n":null}');
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(/Infinity/);
    expect(canonicalJson({ s: "\ud800" })).toBe('{"s":"\\ud800"}');
    expect(() => canonicalize({ s: "\ud800" })).toThrow(/surrogate/i);
  });
});
