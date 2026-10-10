/**
 * ADR-0189 B1 — the shared BOM contract, pure (no database): canonical bytes,
 * the serial number, the row projections, the facts / Decision BOM / AI BOM
 * schemas and their invariants, the finality rule (with #280's unbounded
 * retention policy), the common expires_at, the strict settings, and receipt
 * payload v2 verification across the R42 boundary (B1 verifies v2, emits v1).
 *
 * Every positive case has a negative control beside it.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import canonicalize from "canonicalize";
import { canonicalJson } from "../audit-chain.js";
import {
  RECEIPT_EMITTER_SUPPORTS_V2,
  RECEIPT_GENESIS_PREV,
  RECEIPT_PAYLOAD_VERSION,
  RECEIPT_PAYLOAD_VERSION_V2,
  receiptCanonicalBytes,
  type AnyDecisionReceiptPayload,
} from "../batch4.js";
import { isDecisionReceiptPayload, isDecisionReceiptPayloadV1, receiptPayloadHash, verifyReceiptBundle, type ReceiptBundle, type ReceiptPublicKey } from "../receipts/verify.js";
import {
  AI_BOM_INSTALL_SUBJECT_ID,
  AI_BOM_VERSION,
  aiBomNativeBodySchema,
  aiBomSerialNumber,
  BOM_ROW_PROJECTIONS,
  BOM_ROUTES,
  bomCanonicalBytes,
  bomCostString,
  bomDigestOf,
  bomRowDigest,
  bomSha256,
  DECISION_BOM_SECTIONS,
  DECISION_BOM_VERSION,
  DECISION_FACTS_ADDENDUM_VERSION,
  DECISION_FACTS_VERSION,
  decisionBomBodySchema,
  decisionFactsAddendumSchema,
  decisionFactsSchema,
  evalCasesDigest,
  findEmailShapes,
  parseTrainingDatasetChecksum,
  projectBomRow,
  type DecisionBomBody,
} from "./contract.js";
import { bomExpiresAt, decisionBomFinality, reportedFinality, type FinalityInput } from "./finality.js";
import { BOM_STRICT_DEFAULTS, bomOrgSettingsFields, bomSettingLooser, bomSettingRelaxed } from "./settings.js";

const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const H = (c: string) => c.repeat(64);
const T = "2026-10-10T12:00:00.000Z";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function approvalRow() {
  const projection = projectBomRow("approvals", {
    id: U(9), objectType: "mcp_tool", serverId: U(2), toolName: "read_ledger", ruleId: U(3), connectorId: null,
    projectId: U(4), approverUserId: U(5), namedApproverUserId: null, approverRoleId: null, status: "approved",
    requestedAt: new Date(T), decidedBy: U(5), decidedAt: new Date(T), argumentsDigest: H("a"), contextDigest: H("b"),
    approvalScope: "once", quorum: 2, signatureMode: "passkey", expiresAt: null,
    // free text on the row is never projected
    decisionReason: "looks fine to me", argumentsPreview: { secret: "x" },
  });
  return { table: "approvals" as const, id: U(9), projection, digest: bomRowDigest("approvals", projection) };
}

function facts() {
  return {
    v: DECISION_FACTS_VERSION,
    auditId: U(1),
    auditSeq: 41,
    action: {
      argumentsDigest: H("a"), contextDigest: H("b"),
      target: { kind: "mcp_tool" as const, serverId: U(2), toolName: "read_ledger", toolNameHash: null, connectorId: null, agentId: null },
      inputs: [{ kind: "prompt_commit" as const, id: "pc-1", digest: H("c"), classification: "internal" }],
      dataSensitivity: "internal", complianceTags: ["sox"],
    },
    policy: { governancePolicyEpoch: 3, abacPolicyVersions: [{ id: "abac-7", schemaVersion: 2 }], configVersions: [{ id: U(6), version: 4, canary: false }], guardrailConfigDigest: null, modelPolicyRuleIds: [], killSwitch: "off" as const },
    model: { agentId: U(7), provider: "provider-alpha", requestedModel: "alpha-large", servedModel: "alpha-large", pinnedModelVersion: null, modelCardId: null, modelCardApprovalId: null, aiBomSnapshotId: null },
    actors: null,
    outcome: { effect: "allow" as const, refusalCode: null, upstreamStatusClass: "2xx" as const },
    rows: [approvalRow()],
  };
}

function decisionBom(): DecisionBomBody {
  const f = facts();
  const receiptPayload = canonicalJson({ v: RECEIPT_PAYLOAD_VERSION, receiptSeq: 5 });
  return {
    v: DECISION_BOM_VERSION,
    id: U(20),
    auditId: U(1),
    version: 1,
    supersedes: null,
    finality: "anchored",
    decision: { auditSeq: 41, at: T, objectType: "mcp_tool", objectId: null, serverId: U(2), toolName: "read_ledger", effect: "allow", ruleId: "grant-allow", ruleChain: ["grant-allow"] },
    receipt: { receiptSeq: 5, payloadHash: bomSha256(receiptPayload), keyId: "receipt-2026", payload: receiptPayload, signature: "s".repeat(86) },
    principal: { sponsorUserId: U(5) },
    actors: null,
    action: f.action,
    policy: f.policy,
    model: f.model,
    approval: [approvalRow()],
    outcome: f.outcome,
    cost: { usageEventIds: [U(30)], inputTokens: 10, outputTokens: 20, costUsd: bomCostString(0.000123), costSource: "usage_events.cost_usd" },
    trace: null,
    proof: {
      chain: [
        { seq: 41, contentHash: H("1"), prevHash: H("0"), rowHash: H("2") },
        { seq: 42, contentHash: H("3"), prevHash: H("2"), rowHash: H("4") },
      ],
      anchor: {
        id: U(40),
        record: { seq: 42, rowHash: H("4"), headAt: T, algorithm: "sha256", payloadVersion: 1, capturedAt: T },
        destination: "s3_object_lock", status: "flushed", externalRef: "s3://anchors/a/anchor-42.json", flushedAt: T,
        tamperResistant: true, observationMode: "compliance", observedAt: T, retainUntil: "2033-10-10T12:00:00.000Z",
        tsa: { token: "MIIB", genTime: T, messageImprint: H("5"), policyOid: "1.2.3", nonce: "ab12", requestSentAt: T, requestFactsLegacy: false },
      },
    },
    facts: { payload: bomCanonicalBytes(f), addenda: [] },
    completeness: Object.fromEntries(
      DECISION_BOM_SECTIONS.map((s) => [s, s === "actors" ? { status: "not_recorded", reason: "pre_identity" } : s === "trace" ? { status: "not_recorded", reason: "no_bound_row" } : { status: "recorded" }]),
    ) as DecisionBomBody["completeness"],
    basis: { auditSeq: 42, anchorId: U(40), receiptSeq: 5, aiBomSnapshotId: null },
  };
}

function aiBom(snapshotId = U(50)) {
  return {
    v: AI_BOM_VERSION,
    snapshot: { id: snapshotId, subjectKind: "use_case" as const, subjectId: U(51), version: 1, supersedes: null, trigger: "use_case_approval" as const, createdAt: T, basis: [{ table: "ai_use_cases", id: U(51), sha256: H("6") }] },
    serialNumber: `urn:uuid:${aiBomSerialNumber(snapshotId)}`,
    subject: { id: U(51), dataSensitivity: "internal" },
    records: {
      agents: [{ id: U(7), provider: "provider-alpha" }],
      endpoints: [{ id: "ep-1", url: "https://api.alpha.example/v1/chat" }],
    },
    unrecorded: [{ ref: "dataset:ds-eval-02", field: "classification", reason: "not_recorded" }],
    compositions: [
      { aggregate: "complete" as const, assemblies: [`agent:${U(7)}`] },
      { aggregate: "incomplete" as const, assemblies: ["dataset:ds-eval-02"] },
    ],
    renderings: {
      "cyclonedx-1.7": { status: "rendered" as const, sha256: H("7"), bytes: 1234, validator: "cyclonedx bom-1.7 schema" },
      "spdx-3.0.1": { status: "not_producible" as const, missing: ["releaseTime", "downloadLocation"] },
    },
  };
}

// ---------------------------------------------------------------------------
describe("canonical bytes (the pinned canonicalize, ADR-0176)", () => {
  it("is byte-identical to canonicalJson for facts, Decision BOM and AI BOM shapes, whatever the key order", () => {
    const reverse = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reverse) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)])) : v;
    for (const shape of [facts(), decisionBom(), aiBom(), approvalRow()]) {
      expect(bomCanonicalBytes(shape)).toBe(canonicalJson(shape));
      expect(bomCanonicalBytes(reverse(shape))).toBe(bomCanonicalBytes(shape));
      expect(canonicalize(JSON.parse(bomCanonicalBytes(shape)))).toBe(bomCanonicalBytes(shape));
    }
  });
  it("refuses what RFC 8785 cannot hold (negative control)", () => {
    expect(() => bomCanonicalBytes({ x: Number.NaN })).toThrow();
  });
  it("a cost is the lossless decimal string of the stored double (R23)", () => {
    for (const v of [0.000123, 1e-9, 0.1 + 0.2, 12.5, 0]) expect(Number(bomCostString(v))).toBe(v);
    expect(bomCostString(null)).toBeNull();
    expect(() => bomCostString(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("the v8 serial number (amendment 5)", () => {
  it("is a deterministic RFC 9562 v8 UUID of the snapshot id", () => {
    const a = aiBomSerialNumber(U(50));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(aiBomSerialNumber(U(50))).toBe(a);
    expect(aiBomSerialNumber(U(51))).not.toBe(a);
  });
});

describe("row projections (R5, R18, R26)", () => {
  // tool names are identifiers (regex-limited in the facts schema); display names and prose are not
  const FREE_TEXT = /reason|preview|note|comment|detail|attributes|assertion|signedPayload|^name$|displayName|roleName|description|email/i;
  it("project only ids, digests, enums, integers and times — never free text (except digest-only eval cases)", () => {
    for (const [table, cols] of Object.entries(BOM_ROW_PROJECTIONS)) {
      if (table === "eval_cases") continue;
      for (const c of cols) expect(c, `${table}.${c}`).not.toMatch(FREE_TEXT);
    }
  });
  it("drops every column not on the list, writes times as ISO and doubles as strings", () => {
    const row = approvalRow();
    expect(Object.keys(row.projection)).toEqual([...BOM_ROW_PROJECTIONS.approvals]);
    expect(JSON.stringify(row.projection)).not.toContain("looks fine");
    expect(row.projection.requestedAt).toBe(T);
    const usage = projectBomRow("usage_events", { id: U(30), costUsd: 0.1 + 0.2, inputTokens: 3 });
    expect(usage.costUsd).toBe("0.30000000000000004");
    expect(() => projectBomRow("usage_events", { inputTokens: 2.5 })).toThrow(/safe integers/);
    expect(() => projectBomRow("delegation_grants", { capMicros: 2n ** 60n })).toThrow(/2\^53/);
  });
  it("the evaluation dataset digest is order-independent and changes with any case (R26)", () => {
    const cases = [{ id: U(61), datasetId: U(60), datasetVersion: 2, input: "q1" }, { id: U(62), datasetId: U(60), datasetVersion: 2, input: "q2" }];
    expect(evalCasesDigest(cases)).toBe(evalCasesDigest([...cases].reverse()));
    expect(evalCasesDigest([{ ...cases[0]!, input: "q1!" }, cases[1]!])).not.toBe(evalCasesDigest(cases));
  });
});

describe("training_datasets.checksum parsing (R26, #280 round 13): fail closed", () => {
  const hex = "7d865e959b2466918c9863afca942d0fb89d7c9ac0c99bafc3749504ded97730";
  it("parses the sha256 form, the legacy form and the empty default", () => {
    expect(parseTrainingDatasetChecksum(`sha256:${hex}:1200`, 1200)).toEqual({ kind: "sha256", sha256: hex, rowCount: 1200 });
    expect(parseTrainingDatasetChecksum(`sha256:${hex}:${Number.MAX_SAFE_INTEGER}`)).toMatchObject({ rowCount: Number.MAX_SAFE_INTEGER });
    expect(parseTrainingDatasetChecksum("fnv1a32:0badf00d")).toEqual({ kind: "legacy", value: "fnv1a32:0badf00d" });
    expect(parseTrainingDatasetChecksum("")).toEqual({ kind: "empty" });
  });
  it("refuses 2^53 + 1 (no silent rounding), an over-long digit string, a mismatch with row_count, and any other shape", () => {
    expect(() => parseTrainingDatasetChecksum(`sha256:${hex}:9007199254740993`)).toThrow(/not a safe integer/);
    expect(() => parseTrainingDatasetChecksum(`sha256:${hex}:${"9".repeat(400)}`)).toThrow(/too many digits/);
    expect(() => parseTrainingDatasetChecksum(`sha256:${hex}:1200`, 1201)).toThrow(/disagrees/);
    for (const bad of [`sha256:${hex}`, `sha256:${hex}:-1`, `sha256:${hex}:1e3`, `sha256:${hex}:012`, `SHA256:${hex}:1`, `sha256:${hex.slice(1)}:1`, "fnv1a32:xyz", "md5:abc:1"]) {
      expect(() => parseTrainingDatasetChecksum(bad), bad).toThrow();
    }
  });
});

describe("regulait.decision-facts.v1 and the addendum", () => {
  it("accepts the facts of a decision", () => {
    expect(decisionFactsSchema.safeParse(facts()).success).toBe(true);
  });
  it("refuses prose, a forged row digest, a re-shaped projection and a twice-bound row", () => {
    const prose = facts();
    prose.action.target.toolName = "please read the ledger";
    expect(decisionFactsSchema.safeParse(prose).success).toBe(false);
    const forged = facts();
    forged.rows[0]!.projection.status = "rejected";
    expect(decisionFactsSchema.safeParse(forged).success).toBe(false);
    const extra = facts();
    (extra.rows[0]!.projection as Record<string, unknown>).decisionReason = "x";
    expect(decisionFactsSchema.safeParse(extra).success).toBe(false);
    const twice = facts();
    twice.rows.push(approvalRow());
    expect(decisionFactsSchema.safeParse(twice).success).toBe(false);
  });
  it("an addendum names its predecessor; an unknown version is refused", () => {
    const a = { v: DECISION_FACTS_ADDENDUM_VERSION, auditId: U(1), n: 1, prev: bomDigestOf(facts()), rows: [], postActionVerification: { result: "passed" as const, stageId: null } };
    expect(decisionFactsAddendumSchema.safeParse(a).success).toBe(true);
    expect(decisionFactsAddendumSchema.safeParse({ ...a, v: "regulait.decision-facts-addendum.v2" }).success).toBe(false);
    expect(decisionFactsAddendumSchema.safeParse({ ...a, n: 0 }).success).toBe(false);
  });
});

describe("regulait.decision-bom.v1", () => {
  it("accepts a complete body", () => {
    const r = decisionBomBodySchema.safeParse(decisionBom());
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it("never fills a section from nowhere, and never hides a recorded one", () => {
    const filled = decisionBom();
    filled.completeness.trace = { status: "recorded" };
    expect(decisionBomBodySchema.safeParse(filled).success).toBe(false);
    const hidden = decisionBom();
    hidden.cost = null;
    expect(decisionBomBodySchema.safeParse(hidden).success).toBe(false);
    const reasonless = decisionBom();
    reasonless.completeness.actors = { status: "not_recorded" };
    expect(decisionBomBodySchema.safeParse(reasonless).success).toBe(false);
  });
  it("refuses an email anywhere (R10, R21), a receipt whose bytes do not hash to its payloadHash (R48), and an unknown v", () => {
    const mail = decisionBom();
    mail.decision.objectId = "someone@example.com";
    expect(decisionBomBodySchema.safeParse(mail).success).toBe(false);
    const receipt = decisionBom();
    receipt.receipt.payload = receipt.receipt.payload.replace("5", "6");
    expect(decisionBomBodySchema.safeParse(receipt).success).toBe(false);
    expect(decisionBomBodySchema.safeParse({ ...decisionBom(), v: AI_BOM_VERSION }).success).toBe(false);
  });
  it("the anchor covers the last chain row, the segment starts at the decision, and only chain_signed has no anchor", () => {
    const wrongAnchor = decisionBom();
    wrongAnchor.proof.anchor!.record.rowHash = H("9");
    expect(decisionBomBodySchema.safeParse(wrongAnchor).success).toBe(false);
    const wrongStart = decisionBom();
    wrongStart.proof.chain[0]!.seq = 40;
    expect(decisionBomBodySchema.safeParse(wrongStart).success).toBe(false);
    const noAnchor = decisionBom();
    noAnchor.proof.anchor = null;
    expect(decisionBomBodySchema.safeParse(noAnchor).success).toBe(false);
    noAnchor.finality = "chain_signed";
    expect(decisionBomBodySchema.safeParse(noAnchor).success).toBe(true);
  });
  it("a legacy timestamp may lack request facts (#280); any other may not (R33)", () => {
    const legacy = decisionBom();
    Object.assign(legacy.proof.anchor!.tsa!, { nonce: null, requestSentAt: null, requestFactsLegacy: true });
    expect(decisionBomBodySchema.safeParse(legacy).success).toBe(true);
    const missing = clone(legacy);
    missing.proof.anchor!.tsa!.requestFactsLegacy = false;
    expect(decisionBomBodySchema.safeParse(missing).success).toBe(false);
  });
});

describe("regulait.ai-bom.v1 (the signed native body)", () => {
  it("accepts a body; its serial number is derived from the snapshot id", () => {
    const r = aiBomNativeBodySchema.safeParse(aiBom());
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    const wrong = aiBom();
    wrong.serialNumber = `urn:uuid:${aiBomSerialNumber(U(99))}`;
    expect(aiBomNativeBodySchema.safeParse(wrong).success).toBe(false);
  });
  it("INVARIANT: never `complete` with an unrecorded member", () => {
    const b = aiBom();
    b.compositions[0]!.assemblies.push("dataset:ds-eval-02");
    expect(aiBomNativeBodySchema.safeParse(b).success).toBe(false);
  });
  it("INVARIANT: no email in a key or a value; no credential-bearing endpoint (R47)", () => {
    const key = aiBom() as unknown as { records: Record<string, Array<Record<string, unknown>>> };
    key.records.agents![0]!["owner@example.com"] = "x";
    expect(aiBomNativeBodySchema.safeParse(key).success).toBe(false);
    expect(findEmailShapes({ a: ["ok", { "b@c.de": 1 }] })).toEqual(["$.a[1]{key}"]);
    for (const url of ["https://api.example/v1?token=abc", "https://api.example/v1#secret", "https://user:pass@api.example/v1"]) {
      const b = aiBom();
      b.records.endpoints[0]!.url = url;
      expect(aiBomNativeBodySchema.safeParse(b).success, url).toBe(false);
    }
  });
  it("the install subject is the nil uuid (R20)", () => {
    const b = aiBom();
    b.snapshot.subjectKind = "install" as never;
    expect(aiBomNativeBodySchema.safeParse(b).success).toBe(false);
    b.snapshot.subjectId = AI_BOM_INSTALL_SUBJECT_ID;
    expect(aiBomNativeBodySchema.safeParse(b).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("finality (R4, R44) and #280's unbounded-retention policy", () => {
  const decisionAt = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date("2026-02-01T00:00:00.000Z");
  const base: FinalityInput = {
    anchor: { status: "flushed", tamperResistant: true, tsaGranted: true, retainUntil: new Date("2027-06-01T00:00:00.000Z") },
    receiptSigned: true, timestampMode: "required", decisionAt, retainedDays: 365, now, setting: "anchored",
  };
  it("anchored only when the lock covers the decision's retention", () => {
    expect(decisionBomFinality(base)).toEqual({ freeze: true, state: "anchored" });
    expect(decisionBomFinality({ ...base, retainedDays: 1000 })).toEqual({ freeze: false, reason: "lock_shorter_than_retention" });
  });
  it("UNBOUNDED retention freezes as anchored_finite_lock under the strict default — never pending forever", () => {
    expect(decisionBomFinality({ ...base, retainedDays: null })).toEqual({ freeze: true, state: "anchored_finite_lock" });
    // still needs every other anchored fact
    expect(decisionBomFinality({ ...base, retainedDays: null, anchor: { ...base.anchor!, tamperResistant: false } })).toEqual({ freeze: false, reason: "destination_not_tamper_resistant" });
    expect(decisionBomFinality({ ...base, retainedDays: null, anchor: { ...base.anchor!, retainUntil: null } })).toEqual({ freeze: false, reason: "lock_not_recorded" });
    expect(decisionBomFinality({ ...base, retainedDays: null, anchor: { ...base.anchor!, retainUntil: new Date(now.getTime() - 1) } })).toEqual({ freeze: false, reason: "lock_lapsed" });
    expect(decisionBomFinality({ ...base, retainedDays: null, anchor: { ...base.anchor!, tsaGranted: false } })).toEqual({ freeze: false, reason: "timestamp_pending" });
  });
  it("the verifier reports anchored_lapsed once retain_until passes; a frozen state is never edited", () => {
    const until = base.anchor!.retainUntil!;
    expect(reportedFinality("anchored_finite_lock", until, new Date(until.getTime() - 1))).toBe("anchored_finite_lock");
    expect(reportedFinality("anchored_finite_lock", until, until)).toBe("anchored_lapsed");
    expect(reportedFinality("anchored", until, new Date(until.getTime() + 1))).toBe("anchored_lapsed");
    expect(reportedFinality("anchored_unverified_destination", until, new Date(until.getTime() + 1))).toBe("anchored_unverified_destination");
  });
  it("the relaxed floors freeze the weaker states; nothing freezes before the receipt is signed", () => {
    const local = { ...base, anchor: { ...base.anchor!, tamperResistant: false } };
    expect(decisionBomFinality(local)).toEqual({ freeze: false, reason: "destination_not_tamper_resistant" });
    expect(decisionBomFinality({ ...local, setting: "anchored_unverified_destination" })).toEqual({ freeze: true, state: "anchored_unverified_destination" });
    expect(decisionBomFinality({ ...base, anchor: null, setting: "chain_signed" })).toEqual({ freeze: true, state: "chain_signed" });
    expect(decisionBomFinality({ ...base, anchor: null })).toEqual({ freeze: false, reason: "anchor_not_flushed" });
    expect(decisionBomFinality({ ...base, receiptSigned: false, setting: "chain_signed" })).toEqual({ freeze: false, reason: "receipt_unsigned" });
    expect(decisionBomFinality({ ...base, timestampMode: "off", anchor: { ...base.anchor!, tsaGranted: false } })).toEqual({ freeze: true, state: "anchored" });
  });
  it("the common expires_at is the audit time plus retention, or null when retention is unbounded", () => {
    expect(bomExpiresAt(decisionAt, 30)?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(bomExpiresAt(decisionAt, null)).toBeNull();
    expect(() => bomExpiresAt(decisionAt, 0)).toThrow();
  });
});

describe("the strict BOM settings (§7)", () => {
  it("relaxation and the ordered comparison against the stored value", () => {
    expect(bomSettingRelaxed("decisionFactsCapture", "off")).toBe(true);
    expect(bomSettingRelaxed("decisionBomFinality", "chain_signed")).toBe(true);
    expect(bomSettingRelaxed("cyclonedxExportVersions", ["1.7", "1.6"])).toBe(true);
    expect(bomSettingRelaxed("cyclonedxExportVersions", ["1.7"])).toBe(false);
    expect(bomSettingRelaxed("bomExportRateLimitPerMinute", 31)).toBe(true);
    expect(bomSettingRelaxed("bomExportRateLimitPerMinute", 10)).toBe(false);
    expect(bomSettingLooser("decisionBomFinality", "anchored_unverified_destination", "chain_signed")).toBe(false);
    expect(bomSettingLooser("decisionBomFinality", "chain_signed", "anchored_unverified_destination")).toBe(true);
    expect(bomSettingLooser("bomExportRateLimitPerMinute", 20, 10)).toBe(true);
    expect(bomSettingLooser("aiBomSnapshotWithoutKey", "refuse", "skip_and_record")).toBe(false);
    for (const [k, v] of Object.entries(BOM_STRICT_DEFAULTS)) expect(bomSettingRelaxed(k as never, v as never), k).toBe(false);
  });
  it("zod refuses 1.6 alone, duplicates and out-of-bound rates", () => {
    expect(bomOrgSettingsFields.cyclonedxExportVersions.safeParse(["1.6"]).success).toBe(false);
    expect(bomOrgSettingsFields.cyclonedxExportVersions.safeParse(["1.7", "1.7"]).success).toBe(false);
    expect(bomOrgSettingsFields.cyclonedxExportVersions.parse(["1.6", "1.7"])).toEqual(["1.7", "1.6"]);
    expect(bomOrgSettingsFields.bomExportRateLimitPerMinute.safeParse(601).success).toBe(false);
    expect(bomOrgSettingsFields.bomExportRateLimitPerMinute.safeParse(0).success).toBe(false);
  });
  it("routes: every §9 route, no live draft route (R8)", () => {
    expect(BOM_ROUTES).toHaveLength(8);
    expect(BOM_ROUTES.some((r) => r === ("GET /v1/ai-bom/:subjectKind/:subjectId" as string))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("receipt payload v2 (R34, R42, R48): verified, never emitted by this build", () => {
  const pair = generateKeyPairSync("ed25519");
  const keys: ReceiptPublicKey[] = [{ keyId: "k1", jwk: pair.publicKey.export({ format: "jwk" }) as ReceiptPublicKey["jwk"] }];
  const decision = { at: T, userId: U(5), objectType: "mcp_tool" as const, objectId: null, serverId: null, toolName: "t", effect: "allow" as const, ruleId: "r" };
  function chain(versions: Array<"v1" | "v2">, factsStatus: "captured" | "capture_off" = "captured"): ReceiptBundle["receipts"] {
    let prev = RECEIPT_GENESIS_PREV;
    return versions.map((v, i) => {
      const common = { receiptSeq: i + 1, audit: { id: U(100 + i), seq: (i + 1) * 10, rowHash: H("1"), contentHash: H("2") }, decision, prev, keyId: "k1" };
      const payload: AnyDecisionReceiptPayload =
        v === "v1"
          ? { v: RECEIPT_PAYLOAD_VERSION, ...common }
          : { v: RECEIPT_PAYLOAD_VERSION_V2, ...common, actor: { identityId: null, delegationGrantId: null, chain: null }, factsStatus, factsHash: factsStatus === "captured" ? H("f") : null };
      prev = receiptPayloadHash(payload);
      return { receiptSeq: i + 1, payload, keyId: "k1", signature: sign(null, Buffer.from(receiptCanonicalBytes(payload)), pair.privateKey).toString("base64url") };
    });
  }
  const verify = (receipts: ReceiptBundle["receipts"], boundary?: number | null) =>
    verifyReceiptBundle({ verifier: RECEIPT_PAYLOAD_VERSION, receipts, keys, ...(boundary !== undefined ? { receiptV2FromAuditSeq: boundary } : {}) }).results.map((r) => r.status);

  it("NEGATIVE CONTROL: this build emits v1 only", () => {
    expect(RECEIPT_EMITTER_SUPPORTS_V2).toBe(false);
  });
  it("a v1 chain still verifies with no boundary (the receipts emitted today)", () => {
    expect(verify(chain(["v1", "v1"]))).toEqual(["valid", "valid"]);
  });
  it("v1 below the boundary and v2 from it on verify; a v1 at or above it, or a v2 below it, is invalid", () => {
    expect(verify(chain(["v1", "v2", "v2"]), 20)).toEqual(["valid", "valid", "valid"]);
    expect(verify(chain(["v1", "v1", "v2"]), 20)[1]).toBe("invalid");
    expect(verify(chain(["v2", "v2"]), 20)[0]).toBe("invalid");
  });
  it("a v2 receipt with no recorded boundary is invalid (nothing emits v2 before the cutover)", () => {
    expect(verify(chain(["v1", "v2"]))[1]).toBe("invalid");
    expect(verify(chain(["v1", "v2"]), null)[1]).toBe("invalid");
  });
  it("capture_off carries a null factsHash inside the signed bytes; any other mismatch is malformed", () => {
    expect(verify(chain(["v2"], "capture_off"), 10)).toEqual(["valid"]);
    const [r] = chain(["v2"]);
    expect(isDecisionReceiptPayload({ ...r!.payload, factsHash: null })).toBe(false);
    expect(isDecisionReceiptPayload({ ...r!.payload, factsStatus: "capture_off" })).toBe(false);
    expect(isDecisionReceiptPayloadV1(r!.payload)).toBe(false);
    expect(isDecisionReceiptPayload(r!.payload)).toBe(true);
  });
});
