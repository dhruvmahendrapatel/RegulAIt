/**
 * ADR-0060 — canonicalization tests.
 *
 * These are the tests that decide whether the whole control is usable. A
 * hash-chain that reports tampering on untouched data is worse than no chain:
 * it trains the operator to ignore the alarm. Everything here is about the
 * canonical form being STABLE under transformations that are not changes, and
 * SENSITIVE to transformations that are.
 *
 * The Postgres round-trip half of this lives in the gateway suite
 * (`audit-chain.test.ts` there), because it needs a real database.
 */
import { describe, expect, it } from "vitest";
import {
  AUDIT_GENESIS_CONTENT_HASH,
  AUDIT_GENESIS_PREV_HASH,
  AUDIT_GENESIS_ROW,
  AUDIT_GENESIS_ROW_HASH,
  AUDIT_PAYLOAD_VERSION,
  auditContentHash,
  auditRowHash,
  canonicalAuditPayload,
  canonicalJson,
  sha256Hex,
  verifyChainBatch,
  type AuditChainFields,
  type ChainedAuditRow,
} from "./audit-chain.js";

describe("canonicalJson — key order is not data", () => {
  it("hashes every permutation of a flat object identically", () => {
    const permutations = [
      { a: 1, b: 2, c: 3 },
      { c: 3, b: 2, a: 1 },
      { b: 2, a: 1, c: 3 },
      { c: 3, a: 1, b: 2 },
    ];
    const canonical = permutations.map(canonicalJson);
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe('{"a":1,"b":2,"c":3}');
  });

  it("sorts recursively, at every depth, through arrays of objects", () => {
    const a = { z: { y: 1, x: { w: true, v: null } }, list: [{ q: 1, p: 2 }] };
    const b = { list: [{ p: 2, q: 1 }], z: { x: { v: null, w: true }, y: 1 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"list":[{"p":2,"q":1}],"z":{"x":{"v":null,"w":true},"y":1}}');
  });

  it("sorts keys whose Postgres jsonb order would differ from ours", () => {
    // jsonb orders by key LENGTH first, then bytewise: it would emit
    // {"b":…,"aa":…}. We order purely by code unit: {"aa":…,"b":…}. The point
    // is that OUR order is the one that matters and it is applied to whatever
    // comes back, so the storage engine's choice is irrelevant.
    expect(canonicalJson({ b: 1, aa: 2 })).toBe('{"aa":2,"b":1}');
    expect(canonicalJson({ aa: 2, b: 1 })).toBe('{"aa":2,"b":1}');
  });

  it("does NOT sort arrays — element order is data", () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
    expect(canonicalJson(["b", "a"])).toBe('["b","a"]');
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalJson({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
  });
});

describe("canonicalJson — null, undefined and absence", () => {
  it("treats an undefined object value as absent, exactly as jsonb will store it", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1 })).toBe(canonicalJson({ a: 1, b: undefined }));
  });

  it("keeps null distinct from absent — that difference survives storage", () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });

  it("turns an undefined array element into null, matching JSON.stringify", () => {
    expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]");
    // sparse array: the hole is also null
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalJson([1, , 3])).toBe("[1,null,3]");
  });

  it("drops functions and symbols from objects and nulls them in arrays", () => {
    expect(canonicalJson({ a: 1, f: () => 1 })).toBe('{"a":1}');
    expect(canonicalJson([1, () => 1])).toBe("[1,null]");
  });
});

describe("canonicalJson — numbers", () => {
  it("hashes -0 as 0, because JSON and jsonb both lose the sign", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson({ a: -0 })).toBe(canonicalJson({ a: 0 }));
  });

  it("hashes 1 and 1.0 identically — they are the same double", () => {
    expect(canonicalJson(1)).toBe(canonicalJson(1.0));
    expect(canonicalJson(1)).toBe("1");
  });

  it("keeps an integer distinct from a nearby float", () => {
    expect(canonicalJson(1)).not.toBe(canonicalJson(1.0000000001));
  });

  it("emits NaN and infinities as null, because that is what reaches the column", () => {
    expect(canonicalJson(Number.NaN)).toBe("null");
    expect(canonicalJson(Number.POSITIVE_INFINITY)).toBe("null");
    expect(canonicalJson(Number.NEGATIVE_INFINITY)).toBe("null");
    expect(canonicalJson({ a: Number.NaN })).toBe(JSON.stringify({ a: Number.NaN }));
  });

  it("round-trips the extremes of the double range through its own output", () => {
    for (const n of [
      0,
      -1,
      Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      1e21,
      1e-7,
      0.1 + 0.2,
      123456789.123456789,
    ]) {
      expect(JSON.parse(canonicalJson(n))).toBe(n);
    }
  });

  it("refuses bigint rather than silently coercing it", () => {
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint/);
  });
});

describe("canonicalJson — strings and unicode", () => {
  it("leaves non-ASCII literal so it hashes as its own UTF-8 bytes", () => {
    expect(canonicalJson("héllo 日本語 🙂")).toBe('"héllo 日本語 🙂"');
    expect(canonicalJson({ "clé": "válue" })).toBe('{"clé":"válue"}');
  });

  it("hashes the same text identically regardless of how the source spelled it", () => {
    // same code points, different JS source escapes
    expect(sha256Hex(canonicalJson("é"))).toBe(sha256Hex(canonicalJson("é")));
  });

  it("distinguishes NFC from NFD — they are different code point sequences", () => {
    // Deliberate: canonicalization is byte-level, not linguistic. Two strings
    // that LOOK identical but differ in code points are different data, and
    // Postgres stores them differently too.
    const nfc = "é";
    const nfd = "é";
    expect(canonicalJson(nfc)).not.toBe(canonicalJson(nfd));
  });

  it("escapes quotes, backslashes and control characters", () => {
    expect(canonicalJson('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });

  it("sorts unicode keys deterministically", () => {
    const a = { "🙂": 1, "é": 2, a: 3 };
    const b = { a: 3, "🙂": 1, "é": 2 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

describe("canonicalJson — toJSON", () => {
  it("converts a nested Date the way jsonb will actually store it", () => {
    const d = new Date("2026-08-02T03:04:05.678Z");
    expect(canonicalJson({ when: d })).toBe('{"when":"2026-08-02T03:04:05.678Z"}');
    expect(canonicalJson({ when: d })).toBe(canonicalJson({ when: d.toISOString() }));
  });
});

// -----------------------------------------------------------------------------

const BASE: AuditChainFields = {
  id: "11111111-1111-1111-1111-111111111111",
  at: new Date("2026-08-02T12:00:00.000Z"),
  userId: "22222222-2222-2222-2222-222222222222",
  objectType: "mcp_tool",
  objectId: null,
  detail: { phase: "call", args: { b: 1, a: 2 } },
  serverId: null,
  toolName: "search",
  effect: "allow",
  ruleId: "grant",
  ruleChain: ["grant", "no-approval-rule"],
  reason: "granted",
  deployMode: null,
};

describe("canonicalAuditPayload", () => {
  it("is version-prefixed so a future rule change cannot collide with v1", () => {
    expect(canonicalAuditPayload(BASE).startsWith(`${AUDIT_PAYLOAD_VERSION}\n`)).toBe(true);
  });

  it("is insensitive to the ORDER of the jsonb columns' keys", () => {
    const reordered: AuditChainFields = { ...BASE, detail: { args: { a: 2, b: 1 }, phase: "call" } };
    expect(auditContentHash(reordered)).toBe(auditContentHash(BASE));
  });

  it("is insensitive to the order the FIELDS were written in the object literal", () => {
    const shuffled: AuditChainFields = {
      reason: BASE.reason,
      ruleChain: BASE.ruleChain,
      effect: BASE.effect,
      at: BASE.at,
      id: BASE.id,
      userId: BASE.userId,
      ruleId: BASE.ruleId,
      toolName: BASE.toolName,
      objectType: BASE.objectType,
      detail: BASE.detail,
    };
    expect(auditContentHash(shuffled)).toBe(auditContentHash(BASE));
  });

  it("treats an omitted nullable field and an explicit null identically", () => {
    const { objectId: _o, serverId: _s, deployMode: _d, ...withoutNullables } = BASE;
    expect(auditContentHash(withoutNullables as AuditChainFields)).toBe(auditContentHash(BASE));
  });

  it("accepts `at` as a Date or as the ISO string it round-trips to", () => {
    expect(auditContentHash({ ...BASE, at: "2026-08-02T12:00:00.000Z" })).toBe(auditContentHash(BASE));
  });

  it("changes when ANY immutable fact changes", () => {
    const baseline = auditContentHash(BASE);
    const mutations: Array<Partial<AuditChainFields>> = [
      { reason: "granted." },
      { effect: "deny" },
      { ruleId: "grant2" },
      { toolName: "search2" },
      { objectType: "agent" },
      { userId: "22222222-2222-2222-2222-222222222223" },
      { at: new Date("2026-08-02T12:00:00.001Z") },
      { detail: { phase: "call", args: { b: 1, a: 3 } } },
      { detail: { phase: "call", args: { b: 1 } } },
      { ruleChain: ["grant"] },
      { ruleChain: ["no-approval-rule", "grant"] },
      { deployMode: "hosted" },
    ];
    for (const m of mutations) {
      expect(auditContentHash({ ...BASE, ...m })).not.toBe(baseline);
    }
  });

  it("rejects an unusable timestamp instead of hashing garbage", () => {
    expect(() => canonicalAuditPayload({ ...BASE, at: "not-a-date" })).toThrow(/invalid 'at'/);
  });
});

describe("auditRowHash", () => {
  it("is SHA-256 over the concatenated hex of prev_hash and content_hash", () => {
    const prev = "a".repeat(64);
    const content = "b".repeat(64);
    expect(auditRowHash(prev, content)).toBe(sha256Hex(prev + content));
  });

  it("accumulates history: changing an EARLY row changes every later row_hash", () => {
    const chain = (contents: string[]) => {
      let prev = AUDIT_GENESIS_PREV_HASH;
      for (const c of contents) prev = auditRowHash(prev, c);
      return prev;
    };
    const clean = chain(["c1", "c2", "c3", "c4"]);
    const forged = chain(["c1", "TAMPERED", "c3", "c4"]);
    // This is the property the WORM anchor depends on. If prev_hash were the
    // predecessor's CONTENT hash instead, these two heads would be equal and
    // the anchor would be decorative.
    expect(forged).not.toBe(clean);
  });
});

describe("the genesis row", () => {
  it("has hashes that are constants of the product, not of an install", () => {
    expect(AUDIT_GENESIS_CONTENT_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(AUDIT_GENESIS_ROW_HASH).toBe(sha256Hex(AUDIT_GENESIS_PREV_HASH + AUDIT_GENESIS_CONTENT_HASH));
    expect(auditContentHash(AUDIT_GENESIS_ROW)).toBe(AUDIT_GENESIS_CONTENT_HASH);
  });

  it("says in the record itself that prior rows are not covered", () => {
    expect(AUDIT_GENESIS_ROW.reason).toMatch(/un-chained legacy/);
    expect((AUDIT_GENESIS_ROW.detail as Record<string, unknown>).legacyRowsAreUnchained).toBe(true);
  });

  it("carries no install-specific value, which is what keeps its hash constant", () => {
    const payload = canonicalAuditPayload(AUDIT_GENESIS_ROW);
    expect(payload).not.toMatch(/legacyRowCount|rowsBefore/);
  });
});

// -----------------------------------------------------------------------------

function chainOf(count: number, mutate?: (rows: ChainedAuditRow[]) => void): ChainedAuditRow[] {
  const rows: ChainedAuditRow[] = [];
  let prev = AUDIT_GENESIS_PREV_HASH;
  for (let i = 1; i <= count; i += 1) {
    const fields: AuditChainFields = {
      ...BASE,
      id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      at: new Date(Date.UTC(2026, 7, 2, 0, 0, i)),
      reason: `row ${i}`,
    };
    const contentHash = auditContentHash(fields);
    const rowHash = auditRowHash(prev, contentHash);
    rows.push({ ...fields, seq: i, contentHash, prevHash: prev, rowHash });
    prev = rowHash;
  }
  mutate?.(rows);
  return rows;
}

describe("verifyChainBatch", () => {
  const start = { expectedSeq: 1, prevRowHash: AUDIT_GENESIS_PREV_HASH };

  it("passes a clean chain", () => {
    expect(verifyChainBatch(chainOf(10), start).break).toBeNull();
  });

  it("resumes across keyset batches without holding the whole chain", () => {
    const rows = chainOf(10);
    let state = start;
    for (let i = 0; i < rows.length; i += 3) {
      const res = verifyChainBatch(rows.slice(i, i + 3), state);
      expect(res.break).toBeNull();
      state = { expectedSeq: res.expectedSeq, prevRowHash: res.prevRowHash };
    }
    expect(state.expectedSeq).toBe(11);
  });

  it("localizes an in-place content edit to the exact seq", () => {
    const rows = chainOf(10, (r) => {
      r[5]!.reason = "quietly rewritten";
    });
    const res = verifyChainBatch(rows, start);
    expect(res.break?.seq).toBe(6);
    expect(res.break?.kind).toBe("content_mismatch");
  });

  it("localizes a deletion to the surviving successor", () => {
    const rows = chainOf(10);
    rows.splice(5, 1); // remove seq 6
    const res = verifyChainBatch(rows, start);
    expect(res.break?.seq).toBe(7);
    expect(res.break?.kind).toBe("sequence_gap");
    expect(res.break?.detail).toMatch(/missing/);
  });

  it("catches a reordering as a linkage mismatch", () => {
    const rows = chainOf(10);
    const a = rows[4]!;
    const b = rows[5]!;
    rows[4] = { ...b, seq: 5 };
    rows[5] = { ...a, seq: 6 };
    const res = verifyChainBatch(rows, start);
    expect(res.break?.seq).toBe(5);
    expect(res.break?.kind).toBe("linkage_mismatch");
  });

  it("catches a directly edited row_hash", () => {
    const rows = chainOf(10, (r) => {
      r[3]!.rowHash = "f".repeat(64);
    });
    const res = verifyChainBatch(rows, start);
    expect(res.break?.seq).toBe(4);
    expect(res.break?.kind).toBe("row_hash_mismatch");
  });

  it("catches a row smuggled in without hashes", () => {
    const rows = chainOf(4, (r) => {
      r[2]!.contentHash = null;
    });
    const res = verifyChainBatch(rows, start);
    expect(res.break?.seq).toBe(3);
    expect(res.break?.kind).toBe("missing_hash");
  });

  it("PASSES a fully recomputed forgery — the honest limit of local verification", () => {
    // An adversary with total DB write edits row 6 and re-derives every hash
    // from there on. The chain is internally consistent, so local recomputation
    // has nothing to complain about. Only the anchored head catches this, which
    // is exactly why the anchor is not decorative.
    const clean = chainOf(10);
    const forged = chainOf(10, (r) => {
      r[5]!.reason = "quietly rewritten";
      let prev = r[4]!.rowHash!;
      for (let i = 5; i < r.length; i += 1) {
        const row = r[i]!;
        row.prevHash = prev;
        row.contentHash = auditContentHash(row);
        row.rowHash = auditRowHash(prev, row.contentHash);
        prev = row.rowHash;
      }
    });
    expect(verifyChainBatch(forged, start).break).toBeNull();
    // ...but the head moved, which is the divergence the anchor detects.
    expect(forged.at(-1)!.rowHash).not.toBe(clean.at(-1)!.rowHash);
  });
});
