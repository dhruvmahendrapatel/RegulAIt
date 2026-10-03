/**
 * ADR-0104 — the payload-binding fingerprint, pinned.
 *
 * These are the properties the gateway matcher RELIES on. If any of them stops
 * holding, an approval either stops matching a call it was granted for (noise)
 * or starts matching one it was not (the hole ADR-0104 closes).
 */
import { describe, expect, it } from "vitest";
import {
  APPROVAL_CONTEXT_DIGEST_VERSION,
  APPROVAL_DIGEST_VERSION,
  DEFAULT_APPROVAL_SCOPE,
  DEFAULT_APPROVAL_TTL_HOURS,
  approvalArgumentsDigest,
  approvalArgumentsPreview,
  approvalContextDigest,
  effectiveApprovalScope,
  normalizeApprovalArguments,
  scrubAuditDetail,
  sortApprovalRuleVersions,
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

/**
 * ADR-0105 — the CONSENT-CONTEXT fingerprint, pinned.
 *
 * The gateway's consumption predicate compares this string to one stored hours
 * or days earlier. Every property below is one the predicate relies on: if the
 * digest moved for a reason that is not a policy change, every consent would
 * spontaneously stop matching (noise); if it failed to move for one that is,
 * the ADR-0105 gap is still open.
 */
describe("ADR-0105 — the consent-context fingerprint", () => {
  const RULE_A = "11111111-1111-4111-8111-111111111111";
  const RULE_B = "22222222-2222-4222-8222-222222222222";
  const V1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const V2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const APPROVER = "99999999-9999-4999-8999-999999999999";
  const base = {
    ruleVersions: [{ ruleId: RULE_A, activeVersionId: V1 }],
    requiredApproverUserId: APPROVER,
    approvalScope: "action" as const,
  };

  it("AER-039: the MCP target is part of the consent — destination, egress posture and admitted manifest each change it", () => {
    const target = {
      kind: "mcp_server" as const,
      serverId: "55555555-5555-4555-8555-555555555555",
      url: "https://tools-a.example.test/mcp",
      allowPrivateRanges: false,
      admissionManifestDigest: "a".repeat(64),
    };
    const signed = approvalContextDigest({ ...base, target });
    expect(signed).not.toBe(approvalContextDigest(base));
    expect(approvalContextDigest({ ...base, target: { ...target, url: "https://tools-b.example.test/mcp" } })).not.toBe(signed);
    expect(approvalContextDigest({ ...base, target: { ...target, allowPrivateRanges: true } })).not.toBe(signed);
    expect(approvalContextDigest({ ...base, target: { ...target, admissionManifestDigest: "b".repeat(64) } })).not.toBe(signed);
    // the same target (a fresh object) is the same consent — key order and identity are not inputs
    expect(approvalContextDigest({ ...base, target: { admissionManifestDigest: "a".repeat(64), allowPrivateRanges: false, url: target.url, serverId: target.serverId, kind: "mcp_server" } })).toBe(signed);
    // and the version tag moved, so every pre-target consent re-queues rather than matching by accident
    expect(APPROVAL_CONTEXT_DIGEST_VERSION).toBe("regulait.approval-context.v3");
  });

  it("is a sha256 hex string, and a DIFFERENT one from the payload digest", () => {
    expect(approvalContextDigest(base)).toMatch(/^[0-9a-f]{64}$/);
    // the two digests are separate namespaces — a version tag each — so no
    // context digest can ever be mistaken for a payload digest
    expect(APPROVAL_CONTEXT_DIGEST_VERSION).not.toBe(APPROVAL_DIGEST_VERSION);
    expect(approvalContextDigest(base)).not.toBe(approvalArgumentsDigest({ arguments: {} }));
  });

  it("RULE-LOAD ORDER IS NOT AN INPUT — the pairs are sorted before hashing", () => {
    // The rule loads carry no ORDER BY and are owed none: the kernel's decision
    // does not depend on it. A digest that DID depend on it would be a consent
    // that stops matching when the planner changes its mind, which reads
    // exactly like a policy change and is not one.
    const forwards = approvalContextDigest({
      ...base,
      ruleVersions: [
        { ruleId: RULE_A, activeVersionId: V1 },
        { ruleId: RULE_B, activeVersionId: V2 },
      ],
    });
    const backwards = approvalContextDigest({
      ...base,
      ruleVersions: [
        { ruleId: RULE_B, activeVersionId: V2 },
        { ruleId: RULE_A, activeVersionId: V1 },
      ],
    });
    expect(forwards).toBe(backwards);
    expect(sortApprovalRuleVersions([
      { ruleId: RULE_B, activeVersionId: V2 },
      { ruleId: RULE_A, activeVersionId: V1 },
    ])).toEqual([
      { ruleId: RULE_A, activeVersionId: V1 },
      { ruleId: RULE_B, activeVersionId: V2 },
    ]);
  });

  it("a rule's ACTIVE VERSION changing changes the digest — this is the finding", () => {
    expect(approvalContextDigest({ ...base, ruleVersions: [{ ruleId: RULE_A, activeVersionId: V2 }] }))
      .not.toBe(approvalContextDigest(base));
  });

  it("binds active ABAC policy identity and source independently of approval rules", () => {
    const policy = { policyId: RULE_B, version: 1, source: "forbid when A" };
    const first = approvalContextDigest({ ...base, abacPolicies: [policy] });
    expect(first).not.toBe(approvalContextDigest(base));
    expect(first).not.toBe(approvalContextDigest({
      ...base, abacPolicies: [{ ...policy, version: 2 }],
    }));
    expect(first).not.toBe(approvalContextDigest({
      ...base, abacPolicies: [{ ...policy, source: "forbid when B" }],
    }));
  });

  it("an UNVERSIONED rule hashes to a STABLE value, not to 'unknown'", () => {
    // pre-ADR-0073 rules have no version rows at all. That has to be a fixed
    // input or every unversioned rule would look like a policy change on every
    // single call.
    const none = { ...base, ruleVersions: [{ ruleId: RULE_A, activeVersionId: null }] };
    expect(approvalContextDigest(none)).toBe(approvalContextDigest(none));
    expect(approvalContextDigest(none)).not.toBe(approvalContextDigest(base));
  });

  it("the REQUIRED APPROVER is in the digest", () => {
    expect(approvalContextDigest({ ...base, requiredApproverUserId: RULE_B }))
      .not.toBe(approvalContextDigest(base));
    // absent and explicit-null are one value: an evaluation that names no
    // approver must not hash differently from one that names none
    expect(approvalContextDigest({ ...base, requiredApproverUserId: null }))
      .toBe(approvalContextDigest({ ruleVersions: base.ruleVersions, approvalScope: "action" }));
  });

  it("the APPROVAL SCOPE is in the digest — it changes what a signature MEANS", () => {
    expect(approvalContextDigest({ ...base, approvalScope: "tool" }))
      .not.toBe(approvalContextDigest(base));
  });

  it("ADDING a matched rule changes the digest; the same set does not", () => {
    expect(approvalContextDigest(base)).toBe(approvalContextDigest({ ...base }));
    expect(
      approvalContextDigest({
        ...base,
        ruleVersions: [...base.ruleVersions, { ruleId: RULE_B, activeVersionId: null }],
      }),
    ).not.toBe(approvalContextDigest(base));
  });

  it("is pure — no clock, no I/O: the same input hashes the same twice in a row", () => {
    expect(approvalContextDigest(base)).toBe(approvalContextDigest(base));
  });

  it("the shipped TTL default is 72 hours", () => {
    // stated in TypeScript beside the DDL default it mirrors, so a change to
    // one without the other is visible here rather than only in production
    expect(DEFAULT_APPROVAL_TTL_HOURS).toBe(72);
  });
});
