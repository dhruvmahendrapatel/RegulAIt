/**
 * ADR-0104 — the payload-binding fingerprint, pinned.
 *
 * These are the properties the gateway matcher RELIES on. If any of them stops
 * holding, an approval either stops matching a call it was granted for (noise)
 * or starts matching one it was not (the hole ADR-0104 closes).
 */
import { describe, expect, it } from "vitest";
import {
  APPROVAL_DIGEST_VERSION,
  DEFAULT_APPROVAL_SCOPE,
  approvalArgumentsDigest,
  approvalArgumentsPreview,
  effectiveApprovalScope,
  normalizeApprovalArguments,
  scrubAuditDetail,
} from "./index.js";

describe("ADR-0104 — the consent fingerprint", () => {
  it("is a sha256 hex string", () => {
    expect(approvalArgumentsDigest({ arguments: { a: 1 } })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does NOT depend on key order — the property the whole match rests on", () => {
    // `jsonb` does not preserve insertion order, so a digest that depended on
    // it would stop matching the moment the row round-tripped through Postgres.
    const a = approvalArgumentsDigest({ arguments: { a: 1, b: 2 } });
    const b = approvalArgumentsDigest({ arguments: { b: 2, a: 1 } });
    expect(a).toBe(b);
    // and recursively, at depth
    expect(approvalArgumentsDigest({ arguments: { o: { x: 1, y: [1, { p: 1, q: 2 }] } } })).toBe(
      approvalArgumentsDigest({ arguments: { o: { y: [1, { q: 2, p: 1 }], x: 1 } } }),
    );
  });

  it("treats ARRAY ORDER as data — reordering an array is a different call", () => {
    expect(approvalArgumentsDigest({ arguments: { xs: [1, 2] } })).not.toBe(
      approvalArgumentsDigest({ arguments: { xs: [2, 1] } }),
    );
  });

  it("normalizes absent, undefined and null arguments to the SAME empty bag", () => {
    // The MCP surface treats a missing arguments object and an empty one as the
    // same call, so consent must not be able to distinguish them. This is the
    // explicit null-vs-{} decision ADR-0104 makes, pinned here.
    expect(normalizeApprovalArguments(undefined)).toEqual({});
    expect(normalizeApprovalArguments(null)).toEqual({});
    const empty = approvalArgumentsDigest({ arguments: {} });
    expect(approvalArgumentsDigest({})).toBe(empty);
    expect(approvalArgumentsDigest({ arguments: undefined })).toBe(empty);
    expect(approvalArgumentsDigest({ arguments: null })).toBe(empty);
  });

  it("distinguishes an absent key from an explicit null value", () => {
    // ADR-0060 rule 6: `null` survives the `jsonb` round trip and is NOT the
    // same as absent, so the digest must respect the difference.
    expect(approvalArgumentsDigest({ arguments: { a: null } })).not.toBe(
      approvalArgumentsDigest({ arguments: {} }),
    );
  });

  it("puts projectId in the fingerprint — the same call in another project is another consent", () => {
    const args = { text: "hi" };
    const inA = approvalArgumentsDigest({ projectId: "11111111-1111-1111-1111-111111111111", arguments: args });
    const inB = approvalArgumentsDigest({ projectId: "22222222-2222-2222-2222-222222222222", arguments: args });
    const unattributed = approvalArgumentsDigest({ arguments: args });
    expect(inA).not.toBe(inB);
    expect(inA).not.toBe(unattributed);
    // absent and explicit null attribution are the same "unattributed"
    expect(approvalArgumentsDigest({ projectId: null, arguments: args })).toBe(unattributed);
  });

  it("changes when any argument value changes", () => {
    expect(approvalArgumentsDigest({ arguments: { text: "hi" } })).not.toBe(
      approvalArgumentsDigest({ arguments: { text: "again" } }),
    );
  });

  it("is versioned, so a future canonicalization change cannot silently collide", () => {
    expect(APPROVAL_DIGEST_VERSION).toBe("regulait.approval-binding.v1");
  });
});

describe("ADR-0104 — the approver-facing preview", () => {
  it("REDACTS a credential while the digest, taken on the raw value, is unmoved", () => {
    // This is the load-bearing pair. The approver must not read the secret; the
    // consent must nonetheless identify the call that carried it. A digest
    // taken after scrubbing would make two different secrets the same consent.
    const raw = { note: "deploy", apiKey: "sk-test-SYNTHETIC-NOT-A-REAL-KEY-000" };
    const preview = approvalArgumentsPreview(raw) as Record<string, unknown>;

    expect(preview.note).toBe("deploy");
    expect(String(preview.apiKey)).not.toContain("SYNTHETIC-NOT-A-REAL-KEY");
    // it is the ONE redactor (ADR-0099), called — not a second implementation
    expect(preview).toEqual(scrubAuditDetail(raw));

    // and the identity of the consent is untouched by any of that
    expect(approvalArgumentsDigest({ arguments: raw })).toBe(
      approvalArgumentsDigest({ arguments: { apiKey: "sk-test-SYNTHETIC-NOT-A-REAL-KEY-000", note: "deploy" } }),
    );
    // two DIFFERENT secrets stay two different consents even though both
    // previews render identically
    expect(approvalArgumentsDigest({ arguments: raw })).not.toBe(
      approvalArgumentsDigest({
        arguments: { note: "deploy", apiKey: "sk-test-SYNTHETIC-NOT-A-REAL-KEY-999" },
      }),
    );
  });

  it("renders an empty bag for an argument-less call rather than null", () => {
    expect(approvalArgumentsPreview(undefined)).toEqual({});
  });
});

describe("ADR-0104 — strictest-wins across matching rules", () => {
  it("defaults to 'action' with no matching rule at all", () => {
    expect(DEFAULT_APPROVAL_SCOPE).toBe("action");
    expect(effectiveApprovalScope([])).toBe("action");
  });

  it("reads an ABSENT scope as 'action', never as the loose one", () => {
    expect(effectiveApprovalScope([{}])).toBe("action");
    expect(effectiveApprovalScope([{ approvalScope: null }])).toBe("action");
  });

  it("is 'tool' only when EVERY matching rule opts out", () => {
    expect(effectiveApprovalScope([{ approvalScope: "tool" }])).toBe("tool");
    expect(
      effectiveApprovalScope([{ approvalScope: "tool" }, { approvalScope: "tool" }]),
    ).toBe("tool");
  });

  it("one action-scoped rule among many tool-scoped ones binds the whole consent", () => {
    expect(
      effectiveApprovalScope([
        { approvalScope: "tool" },
        { approvalScope: "action" },
        { approvalScope: "tool" },
      ]),
    ).toBe("action");
  });
});
