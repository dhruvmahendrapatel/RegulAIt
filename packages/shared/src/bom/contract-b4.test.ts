/**
 * ADR-0189 slice B4 — the frozen API contract (contract-b4.ts): every route's
 * request and response bodies round-trip with synthetic fixtures, every
 * finality state and every refusal code is representable, and each invariant
 * has a negative control beside it. Pure: no database, no clock, no network.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../audit-chain.js";
import { RECEIPT_PAYLOAD_VERSION } from "../batch4.js";
import {
  AI_BOM_ONLY_CHECKS,
  AI_BOM_VERSION,
  aiBomSerialNumber,
  aiBomSnapshotFormatQuerySchema,
  BOM_ANCHOR_PENDING_REASONS,
  BOM_B4_ERROR_CODES,
  BOM_B4_ROUTE_CONTRACT,
  BOM_B4_ROUTES,
  BOM_BUNDLE_HEADERS,
  BOM_CANNOT_PROVE,
  BOM_CANNOT_PROVE_COPY,
  BOM_ERROR_CODES,
  BOM_ROUTES,
  BOM_VERIFY_CHECKS,
  bomBundleHeadersSchema,
  bomCanonicalBytes,
  bomCapabilitiesSchema,
  bomCostString,
  bomErrorEnvelopeSchema,
  bomRowDigest,
  bomSha256,
  bomVerifyCheckResultSchema,
  bomVerifyRequestSchema,
  bomVerifyResponseSchema,
  DECISION_BOM_CANNOT_PROVE_FIXED,
  DECISION_BOM_FINALITY_STATES,
  DECISION_BOM_ONLY_CHECKS,
  DECISION_BOM_SECTIONS,
  DECISION_BOM_VERSION,
  DECISION_FACTS_VERSION,
  decisionBomReadQuerySchema,
  decisionBomReadResponseSchema,
  exportBundleV3ManifestSchema,
  projectBomRow,
  type BomCapabilities,
  type BomErrorCode,
  type BomVerifyResponse,
  type DecisionBomBody,
  type DecisionBomFinalityState,
  type DecisionBomReadResponse,
} from "./index.js";

const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const H = (c: string) => c.repeat(64);
const T = "2026-10-10T12:00:00.000Z";
const SIG = "A".repeat(86);
const clone = <V>(v: V): V => JSON.parse(JSON.stringify(v)) as V;
/** a JSON round trip through the schema: what the server sends is what the UI parses back */
const roundTrips = (schema: { parse: (v: unknown) => unknown }, value: unknown) => {
  const once = schema.parse(value);
  expect(schema.parse(clone(once))).toEqual(once);
  return once;
};

function approvalRow() {
  const projection = projectBomRow("approvals", {
    id: U(9), objectType: "mcp_tool", serverId: U(2), toolName: "read_ledger", ruleId: U(3), connectorId: null,
    projectId: U(4), approverUserId: U(5), namedApproverUserId: null, approverRoleId: null, status: "approved",
    requestedAt: new Date(T), decidedBy: U(5), decidedAt: new Date(T), argumentsDigest: H("a"), contextDigest: H("b"),
    approvalScope: "once", quorum: 2, signatureMode: "passkey", expiresAt: null,
  });
  return { table: "approvals" as const, id: U(9), projection, digest: bomRowDigest("approvals", projection) };
}

function document(finality: DecisionBomFinalityState = "anchored", version = 1): DecisionBomBody {
  const outcome = { effect: "allow" as const, refusalCode: null, upstreamStatusClass: "2xx" as const };
  const facts = {
    v: DECISION_FACTS_VERSION, auditId: U(1), auditSeq: 41, action: null, policy: null, model: null, actors: null, outcome, rows: [approvalRow()],
  };
  const receiptPayload = canonicalJson({ v: RECEIPT_PAYLOAD_VERSION, receiptSeq: 5 });
  const anchored = finality !== "chain_signed";
  return {
    v: DECISION_BOM_VERSION,
    id: U(20 + version),
    auditId: U(1),
    version,
    supersedes: version === 1 ? null : U(20 + version - 1),
    finality,
    decision: { auditSeq: 41, at: T, objectType: "mcp_tool", objectId: null, serverId: U(2), toolName: "read_ledger", effect: "allow", ruleId: "grant-allow", ruleChain: ["grant-allow"] },
    receipt: { receiptSeq: 5, payloadHash: bomSha256(receiptPayload), keyId: "receipt-2026", payload: receiptPayload, signature: SIG },
    principal: { sponsorUserId: U(5) },
    actors: null,
    action: null,
    policy: null,
    model: null,
    approval: [approvalRow()],
    outcome,
    cost: { usageEventIds: [U(30)], inputTokens: 10, outputTokens: 20, costUsd: bomCostString(0.000123), costSource: "usage_events.cost_usd" },
    trace: null,
    proof: {
      chain: [
        { seq: 41, contentHash: H("1"), prevHash: H("0"), rowHash: H("2") },
        { seq: 42, contentHash: H("3"), prevHash: H("2"), rowHash: H("4") },
      ],
      anchor: anchored
        ? {
            id: U(40),
            record: { seq: 42, rowHash: H("4"), headAt: T, algorithm: "sha256", payloadVersion: "regulait.audit.v1", capturedAt: T },
            destination: finality === "anchored_unverified_destination" ? "local_worm" : "s3_object_lock",
            status: "flushed", externalRef: "s3://anchors/a/anchor-42.json", flushedAt: T,
            tamperResistant: finality !== "anchored_unverified_destination",
            observationMode: finality === "anchored_unverified_destination" ? "sink_constant" : "compliance",
            observedAt: T, retainUntil: "2033-10-10T12:00:00.000Z",
            tsa: null,
          }
        : null,
    },
    facts: { payload: bomCanonicalBytes(facts), addenda: [] },
    completeness: Object.fromEntries(
      DECISION_BOM_SECTIONS.map((s) =>
        ["actors", "action", "policy", "model"].includes(s)
          ? [s, { status: "not_recorded", reason: s === "actors" ? "pre_identity" : "pre_facts" }]
          : s === "trace"
            ? [s, { status: "not_recorded", reason: "no_bound_row" }]
            : [s, { status: "recorded" }],
      ),
    ) as DecisionBomBody["completeness"],
    basis: { auditSeq: 42, anchorId: anchored ? U(40) : null, receiptSeq: 5, aiBomSnapshotId: null },
  };
}

const adminCaps = (over: Partial<BomCapabilities> = {}): BomCapabilities => ({
  access: "admin", exportRoles: "admins_only", auditorGrant: null, canExport: true, exportUnavailableReason: null,
  canVerify: true, canViewDrift: true, exportRequiresStepUp: false, rateLimitPerMinute: 30, ...over,
});
const auditorCaps = (): BomCapabilities => ({
  access: "auditor_grant", exportRoles: "admins_and_auditors", auditorGrant: { id: U(60), grantedAt: T, grantedBy: U(5) },
  canExport: false, exportUnavailableReason: "export_signing_key_absent", canVerify: true, canViewDrift: false, exportRequiresStepUp: false, rateLimitPerMinute: 30,
});

function readResponse(finality: DecisionBomFinalityState = "anchored", version = 1): DecisionBomReadResponse {
  const doc = document(finality, version);
  const body = bomCanonicalBytes(doc);
  const summary = (v: number) => ({ id: U(20 + v), version: v, supersedes: v === 1 ? null : U(20 + v - 1), finality, bodySha256: v === version ? bomSha256(body) : H("e"), keyId: "receipt-2026", createdAt: T });
  return {
    auditId: U(1),
    bom: { ...summary(version), body, signature: SIG, aiBomSnapshotId: null, reportedFinality: finality },
    document: doc,
    versions: Array.from({ length: version }, (_, i) => summary(i + 1)),
    renderings: [],
    bundle: { schema: "regulait.export-bundle/3", subject: "decision-bom", href: `/v1/decisions/${U(1)}/bom/bundle?version=${version}` },
    capabilities: adminCaps(),
  };
}

function decisionManifest() {
  return {
    schema: "regulait.export-bundle/3", product: "regulait", installId: null, installIdSource: "absent", exportedAt: T, exportedAtSource: "database",
    exportedByUserId: U(5),
    subject: { kind: "decision-bom", id: U(1), descriptor: { auditId: U(1), bomId: U(21), version: 1, finality: "anchored", bodySha256: H("d"), receiptSeq: 5, aiBomSnapshotId: null, formats: [] } },
    files: [{ path: "README.txt", sha256: H("6") }, { path: "audit/chain.tsv", sha256: H("7") }, { path: "content/decision-bom.json", sha256: H("8") }, { path: "signing-key.pub", sha256: H("9") }],
    audit: { payloadScope: "none", segmentFromSeq: 41, segmentToSeq: 42, segmentRowCount: 2 },
    signingKeyId: "export-2026", signingKeyFingerprint: `sha256:${H("f")}`,
  };
}

const decisionChecks = (lapsed = false) => [
  ...DECISION_BOM_ONLY_CHECKS.map((check) => ({ check, status: "valid" as const, reason: null, ref: null })),
  { check: "bundle_manifest_signature" as const, status: "valid" as const, reason: null, ref: "manifest.json" },
].map((c) =>
  c.check === "decision_content_binding"
    ? { ...c, status: "unverifiable" as const, reason: "preimage_not_exported" as const }
    : c.check === "tsa_token"
      ? { ...c, status: "unverifiable" as const, reason: "no_timestamp_token" as const }
      : c.check === "finality" && lapsed
        ? { ...c, status: "valid" as const }
        : c,
);

function verifyResponse(finality: DecisionBomFinalityState = "anchored", opts: { lapsed?: boolean; receipt?: "v1" | "v2" } = {}): BomVerifyResponse {
  const cannotProve = new Set<string>(DECISION_BOM_CANNOT_PROVE_FIXED);
  if (opts.lapsed) cannotProve.add("commitment_after_retain_until");
  if (finality === "anchored_finite_lock") cannotProve.add("finite_lock_under_unbounded_retention");
  if ((opts.receipt ?? "v1") === "v1") cannotProve.add("facts_recorded_at_decision_time");
  return {
    trust: "deployment_registry",
    source: "bundle",
    bodyVersion: DECISION_BOM_VERSION,
    identity: { subject: "decision-bom", auditId: U(1), bomId: U(21), version: 1, recordedFinality: finality, reportedFinality: opts.lapsed ? "anchored_lapsed" : finality, receiptPayloadVersion: opts.receipt ?? "v1" },
    outcome: "valid_with_unverifiable",
    checks: decisionChecks(opts.lapsed),
    sections: DECISION_BOM_SECTIONS.map((section) => ({ section, status: "valid" as const, completeness: section === "trace" ? ("not_recorded" as const) : ("recorded" as const), notRecordedReason: section === "trace" ? ("no_bound_row" as const) : null })),
    cannotProve: [...cannotProve] as BomVerifyResponse["cannotProve"],
    manifest: decisionManifest() as BomVerifyResponse["manifest"],
    verifiedAt: T,
    capabilities: adminCaps(),
  };
}

// ---------------------------------------------------------------------------

describe("B4 contract: the route table", () => {
  it("covers exactly the five B1 stubs that B4 builds, each a §9 route", () => {
    expect([...BOM_B4_ROUTES].sort()).toEqual([
      "GET /v1/ai-bom/snapshots/:snapshotId",
      "GET /v1/ai-bom/snapshots/:snapshotId/bundle",
      "GET /v1/decisions/:auditId/bom",
      "GET /v1/decisions/:auditId/bom/bundle",
      "POST /v1/boms/verify",
    ]);
    for (const r of BOM_B4_ROUTES) expect(BOM_ROUTES as readonly string[]).toContain(r);
  });
  it("every refusal code a route lists is a code the envelope can carry, and every B1 code is kept", () => {
    for (const r of BOM_B4_ROUTES) {
      for (const codes of Object.values(BOM_B4_ROUTE_CONTRACT[r].errors)) for (const c of codes) expect(BOM_B4_ERROR_CODES, r).toContain(c);
    }
    for (const c of BOM_ERROR_CODES) expect(BOM_B4_ERROR_CODES).toContain(c);
    expect(BOM_B4_ERROR_CODES).toEqual(expect.arrayContaining(["bom_signing_unavailable", "bom_snapshot_busy", "ai_bom_too_large", "bom_anchor_pending"]));
  });
});

describe("B4 contract: GET /v1/decisions/:auditId/bom", () => {
  it.each(DECISION_BOM_FINALITY_STATES)("a read response round-trips with finality %s", (finality) => {
    const r = roundTrips(decisionBomReadResponseSchema, readResponse(finality)) as DecisionBomReadResponse;
    expect(r.document.finality).toBe(finality);
  });
  it("lists every version of the decision, and anchored_lapsed only for an anchored state (R44)", () => {
    const v2 = readResponse("anchored", 2);
    expect(roundTrips(decisionBomReadResponseSchema, v2)).toBeTruthy();
    for (const f of ["anchored", "anchored_finite_lock"] as const) {
      expect(decisionBomReadResponseSchema.safeParse({ ...readResponse(f), bom: { ...readResponse(f).bom, reportedFinality: "anchored_lapsed" } }).success).toBe(true);
    }
    const bad = readResponse("chain_signed");
    expect(decisionBomReadResponseSchema.safeParse({ ...bad, bom: { ...bad.bom, reportedFinality: "anchored_lapsed" } }).success).toBe(false);
  });
  it("negative controls: body, hash, metadata and versions must agree with the signed document", () => {
    const r = readResponse();
    expect(decisionBomReadResponseSchema.safeParse({ ...r, bom: { ...r.bom, body: `${r.bom.body} ` } }).success).toBe(false);
    expect(decisionBomReadResponseSchema.safeParse({ ...r, bom: { ...r.bom, bodySha256: H("0") } }).success).toBe(false);
    // a self-consistent body and hash that are NOT the displayed document
    const other = bomCanonicalBytes({ ...r.document, decision: { ...r.document.decision, ruleId: "grant-other" } });
    expect(decisionBomReadResponseSchema.safeParse({ ...r, bom: { ...r.bom, body: other, bodySha256: bomSha256(other) } }).success).toBe(false);
    expect(decisionBomReadResponseSchema.safeParse({ ...r, bom: { ...r.bom, finality: "chain_signed", reportedFinality: "chain_signed" } }).success).toBe(false);
    expect(decisionBomReadResponseSchema.safeParse({ ...r, versions: [{ ...r.versions[0]!, id: U(99) }] }).success).toBe(false);
    expect(decisionBomReadResponseSchema.safeParse({ ...r, bundle: { ...r.bundle, subject: "ai-bom" } }).success).toBe(false);
    expect(decisionBomReadResponseSchema.safeParse({ ...r, extra: 1 }).success).toBe(false);
  });
  it("the query takes an optional positive version", () => {
    expect(decisionBomReadQuerySchema.parse({})).toEqual({});
    expect(decisionBomReadQuerySchema.parse({ version: "3" })).toEqual({ version: 3 });
    for (const version of ["0", "-1", "1.5", "01", "x"]) expect(decisionBomReadQuerySchema.safeParse({ version }).success, version).toBe(false);
  });
});

describe("B4 contract: capabilities (decided by the server, never an input)", () => {
  it("round-trips an admin and an auditor-grant caller", () => {
    roundTrips(bomCapabilitiesSchema, adminCaps());
    roundTrips(bomCapabilitiesSchema, auditorCaps());
  });
  it("negative controls: auditor needs a grant AND the relaxed setting; drift is admin-only; no step-up; reason iff blocked", () => {
    expect(bomCapabilitiesSchema.safeParse({ ...auditorCaps(), auditorGrant: null }).success).toBe(false);
    expect(bomCapabilitiesSchema.safeParse({ ...auditorCaps(), exportRoles: "admins_only" }).success).toBe(false);
    expect(bomCapabilitiesSchema.safeParse({ ...auditorCaps(), canViewDrift: true }).success).toBe(false);
    expect(bomCapabilitiesSchema.safeParse(adminCaps({ canViewDrift: false })).success).toBe(false);
    expect(bomCapabilitiesSchema.safeParse({ ...adminCaps(), exportRequiresStepUp: true }).success).toBe(false);
    expect(bomCapabilitiesSchema.safeParse(adminCaps({ canExport: false })).success).toBe(false);
    expect(bomCapabilitiesSchema.safeParse(adminCaps({ exportUnavailableReason: "export_signing_key_absent" })).success).toBe(false);
    expect(bomCapabilitiesSchema.safeParse(adminCaps({ rateLimitPerMinute: 601 })).success).toBe(false);
  });
});

describe("B4 contract: the bundle downloads", () => {
  const headers = {
    [BOM_BUNDLE_HEADERS.contentType]: "application/gzip",
    [BOM_BUNDLE_HEADERS.contentDisposition]: `attachment; filename="regulait-export-decision-bom-${U(1)}.tar.gz"`,
    [BOM_BUNDLE_HEADERS.schema]: "regulait.export-bundle/3",
    [BOM_BUNDLE_HEADERS.subject]: "decision-bom",
    [BOM_BUNDLE_HEADERS.archiveSha256]: H("1"),
    [BOM_BUNDLE_HEADERS.manifestSha256]: H("2"),
    [BOM_BUNDLE_HEADERS.exportKeyId]: "export-2026",
    [BOM_BUNDLE_HEADERS.exportKeyFingerprint]: `sha256:${H("3")}`,
    [BOM_BUNDLE_HEADERS.bodySha256]: H("4"),
  };
  it("the headers round-trip, and an older schema or bare rendering type is refused (R7)", () => {
    roundTrips(bomBundleHeadersSchema, headers);
    expect(bomBundleHeadersSchema.safeParse({ ...headers, [BOM_BUNDLE_HEADERS.schema]: "regulait.export-bundle/2" }).success).toBe(false);
    expect(bomBundleHeadersSchema.safeParse({ ...headers, [BOM_BUNDLE_HEADERS.contentType]: "application/vnd.cyclonedx+json" }).success).toBe(false);
  });
  it("the snapshot format query defaults to native and accepts only §9's formats", () => {
    expect(aiBomSnapshotFormatQuerySchema.parse({})).toEqual({ format: "native" });
    for (const format of ["cyclonedx-1.7", "cyclonedx-1.6", "spdx-3.0.1"]) expect(aiBomSnapshotFormatQuerySchema.parse({ format })).toEqual({ format });
    for (const format of ["in-toto", "cyclonedx", "SPDX"]) expect(aiBomSnapshotFormatQuerySchema.safeParse({ format }).success, format).toBe(false);
  });
  it("the export-bundle/3 manifest is ids only and carries no audit row payloads (R39, R45)", () => {
    roundTrips(exportBundleV3ManifestSchema, decisionManifest());
    expect(exportBundleV3ManifestSchema.safeParse({ ...decisionManifest(), exportedByDisplayName: "someone" }).success).toBe(false);
    const withRow = { ...decisionManifest(), files: [...decisionManifest().files, { path: "audit/rows/41.payload", sha256: H("a") }] };
    expect(exportBundleV3ManifestSchema.safeParse(withRow).success).toBe(false);
    expect(exportBundleV3ManifestSchema.safeParse({ ...decisionManifest(), audit: null }).success).toBe(false);
    expect(exportBundleV3ManifestSchema.safeParse({ ...decisionManifest(), files: [...decisionManifest().files].reverse() }).success).toBe(false);
    const ai = {
      ...decisionManifest(),
      subject: { kind: "ai-bom", id: U(50), descriptor: { snapshotId: U(50), subjectKind: "agent", subjectId: U(7), version: 1, serialNumber: `urn:uuid:${aiBomSerialNumber(U(50))}`, trigger: "on_demand", bodySha256: H("d"), formats: ["native", "cyclonedx-1.7"] } },
      audit: null,
    };
    roundTrips(exportBundleV3ManifestSchema, ai);
    expect(exportBundleV3ManifestSchema.safeParse({ ...ai, audit: decisionManifest().audit }).success).toBe(false);
  });
});

describe("B4 contract: POST /v1/boms/verify", () => {
  it("the request takes a bundle or a stored reference, and never a key, trust root or time", () => {
    roundTrips(bomVerifyRequestSchema, { source: "bundle", bundleBase64: "H4sIAAAAAAAA" });
    expect(bomVerifyRequestSchema.parse({ source: "decision_bom", auditId: U(1).toUpperCase(), version: 2 })).toEqual({ source: "decision_bom", auditId: U(1), version: 2 });
    roundTrips(bomVerifyRequestSchema, { source: "ai_bom_snapshot", snapshotId: U(50) });
    for (const extra of [{ keys: [] }, { trustRoot: "x" }, { now: T }, { tsaTrustBundle: "x" }]) {
      expect(bomVerifyRequestSchema.safeParse({ source: "bundle", bundleBase64: "H4sI", ...extra }).success).toBe(false);
    }
    expect(bomVerifyRequestSchema.safeParse({ source: "bundle", bundleBase64: "not base64!" }).success).toBe(false);
    expect(bomVerifyRequestSchema.safeParse({ source: "decision_bom", auditId: "41" }).success).toBe(false);
  });

  it.each(DECISION_BOM_FINALITY_STATES)("a Decision BOM verify response round-trips with recorded finality %s", (finality) => {
    roundTrips(bomVerifyResponseSchema, verifyResponse(finality));
  });
  it("every reported finality state, including anchored_lapsed, round-trips (R44)", () => {
    roundTrips(bomVerifyResponseSchema, verifyResponse("anchored", { lapsed: true }));
    roundTrips(bomVerifyResponseSchema, verifyResponse("anchored_finite_lock", { lapsed: true }));
    roundTrips(bomVerifyResponseSchema, verifyResponse("anchored", { receipt: "v2" }));
  });
  it("an AI BOM verify response round-trips with its own checks only (R19)", () => {
    const ai: BomVerifyResponse = {
      ...verifyResponse(),
      source: "ai_bom_snapshot",
      bodyVersion: AI_BOM_VERSION,
      identity: { subject: "ai-bom", snapshotId: U(50), subjectKind: "use_case", subjectId: U(8), version: 2, serialNumber: `urn:uuid:${aiBomSerialNumber(U(50))}` },
      outcome: "valid_with_unverifiable",
      checks: [
        { check: "body_signature", status: "valid", reason: null, ref: null },
        ...AI_BOM_ONLY_CHECKS.map((check) => ({ check, status: "valid" as const, reason: null, ref: check === "rendering_hashes" ? "cyclonedx-1.7" : null })),
        { check: "supersedes", status: "unverifiable", reason: "earlier_snapshot_not_in_bundle", ref: null },
        { check: "bundle_manifest_signature", status: "unverifiable", reason: "not_a_bundle", ref: null },
      ],
      sections: [],
      cannotProve: ["facts_true", "signing_time_beyond_anchor"],
      manifest: null,
    };
    roundTrips(bomVerifyResponseSchema, ai);
    expect(bomVerifyResponseSchema.safeParse({ ...ai, checks: [...ai.checks, { check: "chain_links", status: "valid", reason: null, ref: null }] }).success).toBe(false);
    expect(bomVerifyResponseSchema.safeParse({ ...ai, bodyVersion: DECISION_BOM_VERSION }).success).toBe(false);
  });
  it("an unreadable bundle is reported invalid with no identity", () => {
    roundTrips(bomVerifyResponseSchema, {
      ...verifyResponse(), bodyVersion: null, identity: null, outcome: "invalid", sections: [], cannotProve: [], manifest: null,
      checks: [{ check: "bundle_manifest_signature", status: "invalid", reason: "bundle_unreadable", ref: null }],
    });
  });
  it("negative controls: outcome, sections, cannotProve and lapse must follow the checks", () => {
    const r = verifyResponse();
    expect(bomVerifyResponseSchema.safeParse({ ...r, outcome: "valid" }).success).toBe(false);
    expect(bomVerifyResponseSchema.safeParse({ ...r, sections: r.sections.slice(1) }).success).toBe(false);
    expect(bomVerifyResponseSchema.safeParse({ ...r, cannotProve: r.cannotProve.filter((c) => c !== "decision_row_content") }).success).toBe(false);
    expect(bomVerifyResponseSchema.safeParse({ ...r, cannotProve: r.cannotProve.filter((c) => c !== "facts_recorded_at_decision_time") }).success).toBe(false);
    const lapsed = verifyResponse("anchored", { lapsed: true });
    expect(bomVerifyResponseSchema.safeParse({ ...lapsed, cannotProve: lapsed.cannotProve.filter((c) => c !== "commitment_after_retain_until") }).success).toBe(false);
    const finite = verifyResponse("anchored_finite_lock");
    expect(bomVerifyResponseSchema.safeParse({ ...finite, cannotProve: finite.cannotProve.filter((c) => c !== "finite_lock_under_unbounded_retention") }).success).toBe(false);
    const chainSigned = verifyResponse("chain_signed");
    expect(bomVerifyResponseSchema.safeParse({ ...chainSigned, identity: { ...chainSigned.identity!, reportedFinality: "anchored_lapsed" } }).success).toBe(false);
    expect(bomVerifyResponseSchema.safeParse({ ...r, trust: "bundle_keys" }).success).toBe(false);
    expect(bomVerifyResponseSchema.safeParse({ ...r, manifest: null }).success).toBe(false);
  });
  it("a check's reason matches its status", () => {
    expect(bomVerifyCheckResultSchema.safeParse({ check: "body_signature", status: "invalid", reason: "signature_mismatch", ref: null }).success).toBe(true);
    expect(bomVerifyCheckResultSchema.safeParse({ check: "body_signature", status: "invalid", reason: "preimage_not_exported", ref: null }).success).toBe(false);
    expect(bomVerifyCheckResultSchema.safeParse({ check: "decision_content_binding", status: "unverifiable", reason: "signature_mismatch", ref: null }).success).toBe(false);
    expect(bomVerifyCheckResultSchema.safeParse({ check: "body_signature", status: "valid", reason: "hash_mismatch", ref: null }).success).toBe(false);
    expect(bomVerifyCheckResultSchema.safeParse({ check: "body_signature", status: "invalid", reason: null, ref: null }).success).toBe(false);
    expect(new Set(BOM_VERIFY_CHECKS).size).toBe(BOM_VERIFY_CHECKS.length);
  });
  it("every cannotProve entry has its sentence", () => {
    for (const c of BOM_CANNOT_PROVE) expect(BOM_CANNOT_PROVE_COPY[c].length, c).toBeGreaterThan(10);
  });
});

describe("B4 contract: the refusal envelope", () => {
  const extras: Partial<Record<BomErrorCode, Record<string, unknown>>> = {
    rate_limited: { retryAfterSeconds: 12 },
    bom_signing_unavailable: { missingKey: "receipt" },
    bom_anchor_pending: { reason: "anchor_not_flushed", retryAfterSeconds: 30 },
    format_not_rendered_for_snapshot: { formats: ["native", "cyclonedx-1.7"] },
    bom_export_refused: { reason: "email_shape", file: "content/ai-bom.json", path: "$.records.agents[0].name" },
  };
  it.each(BOM_B4_ERROR_CODES)("%s round-trips, and an unknown field is refused", (code) => {
    const env = { error: code, detail: "synthetic", ...(extras[code] ?? {}) };
    roundTrips(bomErrorEnvelopeSchema, env);
    expect(bomErrorEnvelopeSchema.safeParse({ ...env, stack: "x" }).success).toBe(false);
    if (extras[code]) expect(bomErrorEnvelopeSchema.safeParse({ error: code }).success, code).toBe(false);
  });
  it("every pending reason and both missing keys are representable", () => {
    for (const reason of BOM_ANCHOR_PENDING_REASONS) roundTrips(bomErrorEnvelopeSchema, { error: "bom_anchor_pending", reason, retryAfterSeconds: 5 });
    roundTrips(bomErrorEnvelopeSchema, { error: "bom_signing_unavailable", missingKey: "export" });
    expect(bomErrorEnvelopeSchema.safeParse({ error: "bom_anchor_pending", reason: "soon", retryAfterSeconds: 5 }).success).toBe(false);
    expect(bomErrorEnvelopeSchema.safeParse({ error: "no_such_code" }).success).toBe(false);
  });
});
