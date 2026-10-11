/**
 * ADR-0189 B6: the browser's BOM model against the LIVE contract.
 *
 * The SPA mirrors the shared vocabularies (it does not import @regulait/shared
 * at runtime), so these tests import the shared source and fail on drift. The
 * fixtures are built with the shared helpers and parsed by the shared zod
 * schemas first, so a reader is only ever tested on data the gateway's own
 * contract accepts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import * as m from "./bomModel";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const sharedBom = async (): Promise<Any> => import(/* @vite-ignore */ new URL("../../../../../../packages/shared/src/bom/index.ts", import.meta.url).pathname);
const sharedFile = async (file: string): Promise<Any> => import(/* @vite-ignore */ new URL(`../../../../../../packages/shared/src/${file}`, import.meta.url).pathname);

const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const H = (c: string) => c.repeat(64);
const T = "2026-10-10T12:00:00.000Z";
const SIG = "A".repeat(86);

const adminCaps = (over: Record<string, unknown> = {}) => ({
  access: "admin", exportRoles: "admins_only", auditorGrant: null, canExport: true, exportUnavailableReason: null,
  canVerify: true, canViewDrift: true, exportRequiresStepUp: false, rateLimitPerMinute: 30, ...over,
});

/** the contract test's Decision BOM read response (packages/shared/src/bom/contract-b4.test.ts), built with the shared helpers */
async function readResponse(finality = "anchored", version = 1): Promise<Any> {
  const s = await sharedBom();
  const { canonicalJson } = await sharedFile("audit-chain.ts");
  const { RECEIPT_PAYLOAD_VERSION } = await sharedFile("batch4.ts");
  const projection = s.projectBomRow("approvals", {
    id: U(9), objectType: "mcp_tool", serverId: U(2), toolName: "read_ledger", ruleId: U(3), connectorId: null,
    projectId: U(4), approverUserId: U(5), namedApproverUserId: null, approverRoleId: null, status: "approved",
    requestedAt: new Date(T), decidedBy: U(5), decidedAt: new Date(T), argumentsDigest: H("a"), contextDigest: H("b"),
    approvalScope: "once", quorum: 2, signatureMode: "passkey", expiresAt: null,
  });
  const row = { table: "approvals", id: U(9), projection, digest: s.bomRowDigest("approvals", projection) };
  const outcome = { effect: "allow", refusalCode: null, upstreamStatusClass: "2xx" };
  const facts = { v: s.DECISION_FACTS_VERSION, auditId: U(1), auditSeq: 41, action: null, policy: null, model: null, actors: null, outcome, rows: [row] };
  const receiptPayload = canonicalJson({ v: RECEIPT_PAYLOAD_VERSION, receiptSeq: 5 });
  const anchored = finality !== "chain_signed";
  const doc = {
    v: s.DECISION_BOM_VERSION, id: U(20 + version), auditId: U(1), version, supersedes: version === 1 ? null : U(20 + version - 1), finality,
    decision: { auditSeq: 41, at: T, objectType: "mcp_tool", objectId: null, serverId: U(2), toolName: "read_ledger", effect: "allow", ruleId: "grant-allow", ruleChain: ["grant-allow"] },
    receipt: { receiptSeq: 5, payloadHash: s.bomSha256(receiptPayload), keyId: "receipt-2026", payload: receiptPayload, signature: SIG },
    principal: { sponsorUserId: U(5) }, actors: null, action: null, policy: null, model: null, approval: [row], outcome,
    cost: { usageEventIds: [U(30)], inputTokens: 10, outputTokens: 20, costUsd: s.bomCostString(0.000123), costSource: "usage_events.cost_usd" },
    trace: null,
    proof: {
      chain: [{ seq: 41, contentHash: H("1"), prevHash: H("0"), rowHash: H("2") }, { seq: 42, contentHash: H("3"), prevHash: H("2"), rowHash: H("4") }],
      anchor: anchored
        ? {
            id: U(40), record: { seq: 42, rowHash: H("4"), headAt: T, algorithm: "sha256", payloadVersion: "regulait.audit.v1", capturedAt: T },
            destination: "s3_object_lock", status: "flushed", externalRef: "s3://anchors/a/anchor-42.json", flushedAt: T, tamperResistant: true,
            observationMode: "compliance", observedAt: T, retainUntil: "2033-10-10T12:00:00.000Z", tsa: null,
          }
        : null,
    },
    facts: { payload: s.bomCanonicalBytes(facts), addenda: [] },
    completeness: Object.fromEntries(
      s.DECISION_BOM_SECTIONS.map((sec: string) =>
        ["actors", "action", "policy", "model"].includes(sec)
          ? [sec, { status: "not_recorded", reason: sec === "actors" ? "pre_identity" : "pre_facts" }]
          : sec === "trace"
            ? [sec, { status: "not_recorded", reason: "no_bound_row" }]
            : [sec, { status: "recorded" }],
      ),
    ),
    basis: { auditSeq: 42, anchorId: anchored ? U(40) : null, receiptSeq: 5, aiBomSnapshotId: null },
  };
  const body = s.bomCanonicalBytes(doc);
  const summary = (v: number) => ({ id: U(20 + v), version: v, supersedes: v === 1 ? null : U(20 + v - 1), finality, bodySha256: v === version ? s.bomSha256(body) : H("e"), keyId: "receipt-2026", createdAt: T });
  const r = {
    auditId: U(1),
    bom: { ...summary(version), body, signature: SIG, aiBomSnapshotId: null, reportedFinality: finality },
    document: doc,
    versions: Array.from({ length: version }, (_, i) => summary(i + 1)),
    renderings: [],
    bundle: { schema: "regulait.export-bundle/3", subject: "decision-bom", href: `/v1/decisions/${U(1)}/bom/bundle?version=${version}` },
    capabilities: adminCaps(),
  };
  expect(s.decisionBomReadResponseSchema.safeParse(r).success).toBe(true);
  return JSON.parse(JSON.stringify(r));
}

/** a stored-source AI BOM verify report (version 2: supersedes is checked in place) */
async function aiVerify(over: Record<string, unknown> = {}): Promise<Any> {
  const s = await sharedBom();
  const r = {
    trust: "deployment_registry", source: "ai_bom_snapshot", bodyVersion: s.AI_BOM_VERSION,
    identity: { subject: "ai-bom", snapshotId: U(70), subjectKind: "agent", subjectId: U(71), version: 2, serialNumber: `urn:uuid:${U(72)}` },
    outcome: "valid",
    checks: [
      ...["body_version", "body_schema", "body_signature", "serial_number", "supersedes"].map((check) => ({ check, status: "valid", reason: null, ref: null })),
      { check: "rendering_hashes", status: "valid", reason: null, ref: "cyclonedx-1.7" },
      ...s.BOM_BUNDLE_REQUIRED_CHECKS.map((check: string) => ({ check, status: "unverifiable", reason: "not_a_bundle", ref: null })),
    ],
    sections: [], cannotProve: [...s.AI_BOM_CANNOT_PROVE_FIXED], manifest: null, verifiedAt: T, capabilities: adminCaps(), ...over,
  };
  return r;
}

describe("the mirrored vocabularies match @regulait/shared", () => {
  it("subjects, triggers, formats, sections, finality and verify vocabularies", async () => {
    const s = await sharedBom();
    expect(m.AI_BOM_SUBJECT_KINDS).toEqual(s.AI_BOM_SUBJECT_KINDS);
    expect(m.AI_BOM_INSTALL_SUBJECT_ID).toBe(s.AI_BOM_INSTALL_SUBJECT_ID);
    expect(m.AI_BOM_SNAPSHOT_TRIGGERS).toEqual(s.AI_BOM_SNAPSHOT_TRIGGERS);
    expect(m.AI_BOM_DOWNLOAD_FORMATS).toEqual(s.AI_BOM_DOWNLOAD_FORMATS);
    expect(m.BOM_RENDERING_FORMATS).toEqual(s.BOM_RENDERING_FORMATS);
    expect(m.AI_BOM_DRIFT_CHANGES).toEqual(s.AI_BOM_DRIFT_CHANGES);
    expect(m.DECISION_BOM_SECTIONS).toEqual(s.DECISION_BOM_SECTIONS);
    expect(m.BOM_SECTION_STATUSES).toEqual(s.BOM_SECTION_STATUSES);
    expect(m.BOM_NOT_RECORDED_REASONS).toEqual(s.BOM_NOT_RECORDED_REASONS);
    expect(m.DECISION_BOM_FINALITY_STATES).toEqual(s.DECISION_BOM_FINALITY_STATES);
    expect(m.BOM_REPORTED_FINALITY_STATES).toEqual(s.BOM_REPORTED_FINALITY_STATES);
    expect(m.BOM_ANCHOR_PENDING_REASONS).toEqual(s.BOM_ANCHOR_PENDING_REASONS);
    expect(m.BOM_VERIFY_CHECKS).toEqual(s.BOM_VERIFY_CHECKS);
    expect(m.BOM_VERIFY_INVALID_REASONS).toEqual(s.BOM_VERIFY_INVALID_REASONS);
    expect(m.BOM_VERIFY_UNVERIFIABLE_REASONS).toEqual(s.BOM_VERIFY_UNVERIFIABLE_REASONS);
    expect(m.BOM_VERIFY_OUTCOMES).toEqual(s.BOM_VERIFY_OUTCOMES);
    expect(m.BOM_VERIFY_SOURCES).toEqual(s.BOM_VERIFY_SOURCES);
    expect(m.BOM_CANNOT_PROVE).toEqual(s.BOM_CANNOT_PROVE);
    expect(m.BOM_CANNOT_PROVE_COPY).toEqual(s.BOM_CANNOT_PROVE_COPY);
  });
  it("every refusal code a BOM route can answer has its own sentence (none falls through to the generic text)", async () => {
    const s = await sharedBom();
    // the gateway's own B3 list, read as text (importing the gateway would pull in its database layer)
    const routesSource = readFileSync(new URL("../../../../../../apps/gateway/src/bom-routes.ts", import.meta.url), "utf8");
    const b3 = /AI_BOM_ROUTE_ERRORS = \[([^\]]*)\]/.exec(routesSource)?.[1] ?? "";
    const b3Codes = [...b3.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!);
    expect(b3Codes.length).toBeGreaterThan(5);
    // the drift baseline's own 500 (ai-bom.ts), not in either list
    const codes = new Set<string>([...s.BOM_B4_ERROR_CODES, ...b3Codes, "ai_bom_baseline_unreadable"]);
    // owned by the global client (the MFA gate), not a BOM refusal
    codes.delete("mfa_enrollment_required");
    for (const code of codes) {
      const generic = new ApiError(400, { error: code }).message;
      expect(m.bomRefusalText(new ApiError(400, { error: code })), code).not.toBe(generic);
    }
  });
  it("every check, section, finality, trigger and limit has a label", () => {
    for (const c of m.BOM_VERIFY_CHECKS) expect(m.checkLabel(c)).not.toBe(c);
    for (const s of m.DECISION_BOM_SECTIONS) expect(m.sectionLabel(s)).not.toBe(s);
    for (const f of m.BOM_REPORTED_FINALITY_STATES) expect(m.finalityLabel(f)).not.toBe(f);
    for (const t of m.AI_BOM_SNAPSHOT_TRIGGERS) expect(m.triggerLabel(t)).not.toBe(t);
    for (const r of m.BOM_NOT_RECORDED_REASONS) expect(m.notRecordedLabel(r)).not.toBe(r);
  });
});

describe("the B3 metadata readers", () => {
  const subject = { kind: "agent" as const, id: U(71) };
  const snap = { id: U(70), version: 1, serialNumber: `urn:uuid:${U(72)}`, trigger: "model_card_approval", bodySha256: H("a"), keyId: "receipt-2026", createdAt: T, formats: ["cyclonedx-1.6", "cyclonedx-1.7"] };
  it("subjectPath refuses a bad kind, a bad id, and a non-install use of the nil key (R20)", () => {
    expect(m.subjectPath(subject)).toBe(`/v1/ai-bom/agent/${U(71)}`);
    expect(m.subjectPath({ kind: "install", id: m.AI_BOM_INSTALL_SUBJECT_ID })).toBe(`/v1/ai-bom/install/${m.AI_BOM_INSTALL_SUBJECT_ID}`);
    expect(() => m.subjectPath({ kind: "agent", id: m.AI_BOM_INSTALL_SUBJECT_ID })).toThrow();
    expect(() => m.subjectPath({ kind: "install", id: U(1) })).toThrow();
    expect(() => m.subjectPath({ kind: "model" as never, id: U(1) })).toThrow();
  });
  it("reads the live snapshot list, and offers native plus only the rendered formats", () => {
    const list = m.readSnapshotList({ subject, released: true, snapshots: [snap] }, subject);
    expect(list.snapshots[0]!.trigger).toBe("model_card_approval");
    expect(m.downloadableFormats(list.snapshots[0]!)).toEqual(["native", "cyclonedx-1.7", "cyclonedx-1.6"]);
  });
  it("refuses a list for another subject, an unknown trigger or a malformed digest", () => {
    expect(() => m.readSnapshotList({ subject: { kind: "agent", id: U(99) }, released: true, snapshots: [] }, subject)).toThrow(m.BomEvidenceError);
    expect(() => m.readSnapshotList({ subject, released: true, snapshots: [{ ...snap, trigger: "whenever" }] }, subject)).toThrow(m.BomEvidenceError);
    expect(() => m.readSnapshotList({ subject, released: true, snapshots: [{ ...snap, bodySha256: "x" }] }, subject)).toThrow(m.BomEvidenceError);
  });
  it("reads drift with its gaps (R25 item 4) and never treats it as evidence", () => {
    const gap = { auditId: U(80), at: T, kind: "skipped_no_key", trigger: "prompt_promotion", triggeringObjectId: U(81), code: "bom_signing_unavailable" };
    const d = m.readDrift(
      {
        evidence: false, subject, baseline: { snapshotId: U(70), version: 1, createdAt: T, serialNumber: `urn:uuid:${U(72)}` },
        changes: [{ ref: `service:mcp:${U(3)}`, change: "added", before: null, after: { version: "2", hashes: [`SHA-256:${H("b")}`] } }],
        gaps: [gap], gapsTruncated: false,
      },
      subject,
    );
    expect(d.gaps).toEqual([gap]);
    expect(m.driftRefKind(d.changes[0]!.ref)).toBe("MCP server or tool");
    expect(() => m.readDrift({ evidence: true, subject, baseline: {}, changes: [], gaps: [], gapsTruncated: false }, subject)).toThrow(m.BomEvidenceError);
  });
  it("names every bom-ref the shared builder mints", async () => {
    const { aiBomRef } = await sharedFile("bom/ai-bom-cyclonedx.ts");
    const refs = [
      aiBomRef.useCase(U(1)), aiBomRef.agent(U(1)), aiBomRef.builderAgent(U(1)), aiBomRef.model(U(1)), aiBomRef.modelOfAgent(U(1)), aiBomRef.modelCard(U(1)),
      aiBomRef.artifact(U(1)), aiBomRef.trainingArtifact(U(1)), aiBomRef.engine("garak"), aiBomRef.trainingDataset(U(1), 1), aiBomRef.evalDataset(U(1), 1),
      aiBomRef.prompt(U(1), "prod"), aiBomRef.config("agent_config", U(1)), aiBomRef.provider(U(1)), aiBomRef.mcp(U(1)), aiBomRef.tool(U(1), U(2)),
      aiBomRef.connector(U(1)), aiBomRef.skill(U(1), U(2)), aiBomRef.memory("vector", null), aiBomRef.devTool("x"), aiBomRef.install(),
    ];
    for (const ref of refs) expect(m.driftRefKind(ref), ref).not.toBe("Component");
    expect(m.driftRefKind(aiBomRef.trainingArtifact(U(1)))).toBe("Training artifact");
    expect(m.driftRefKind(aiBomRef.tool(U(1), U(2)))).toBe("MCP server or tool");
  });
});

describe("the B4 readers", () => {
  it("reads a contract-valid Decision BOM, its completeness as recorded and its capabilities", async () => {
    const view = m.readDecisionBom(await readResponse("anchored", 2), U(1));
    expect(view.bom.version).toBe(2);
    expect(view.versions.map((x) => x.version)).toEqual([1, 2]);
    expect(view.completeness.find((c) => c.section === "actors")).toEqual({ section: "actors", status: "not_recorded", reason: "pre_identity" });
    expect(view.bundleHref).toBe(`/v1/decisions/${U(1)}/bom/bundle?version=2`);
    expect(view.capabilities.canExport).toBe(true);
  });
  it("bomB4Api.decision checks the body against its digest before showing anything", async () => {
    const { bomB4Api } = await import("./bomB4Api");
    const good = await readResponse();
    vi.stubGlobal("fetch", async () => Response.json(good));
    try {
      const shown = await bomB4Api.decision(U(1));
      expect(shown.bom.bodySha256).toBe(good.bom.bodySha256);
      expect("body" in shown).toBe(false);
      vi.stubGlobal("fetch", async () => Response.json({ ...good, bom: { ...good.bom, body: good.bom.body.replace("read_ledger", "read_ledgeR") } }));
      await expect(bomB4Api.decision(U(1))).rejects.toThrow(/does not match its digest/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("the view comes from the signed body: a document that disagrees with it is refused", async () => {
    const r = await readResponse();
    // the completeness shown would differ from what was signed
    const lying = { ...r.document, completeness: { ...r.document.completeness, actors: { status: "recorded" } } };
    expect(() => m.readDecisionBom({ ...r, document: lying }, U(1))).toThrow(m.BomEvidenceError);
    // key order is not a disagreement
    const reordered = Object.fromEntries(Object.entries(r.document).reverse());
    expect(m.readDecisionBom({ ...r, document: reordered }, U(1)).completeness).toHaveLength(12);
  });
  it("supersedes and the AI BOM link must match the signed body", async () => {
    const r2 = await readResponse("anchored", 2);
    expect(() => m.readDecisionBom({ ...r2, bom: { ...r2.bom, supersedes: U(99) } }, U(1))).toThrow(m.BomEvidenceError);
    expect(() => m.readDecisionBom({ ...r2, bom: { ...r2.bom, supersedes: null } }, U(1))).toThrow(m.BomEvidenceError);
    const r = await readResponse();
    expect(() => m.readDecisionBom({ ...r, bom: { ...r.bom, aiBomSnapshotId: U(98) } }, U(1))).toThrow(m.BomEvidenceError);
  });
  it("refuses a read whose bundle link, finality or document does not match the summary", async () => {
    const r = await readResponse();
    expect(() => m.readDecisionBom({ ...r, bundle: { ...r.bundle, href: `/v1/decisions/${U(1)}/bom/bundle?version=9` } }, U(1))).toThrow(m.BomEvidenceError);
    expect(() => m.readDecisionBom({ ...r, bom: { ...r.bom, reportedFinality: "chain_signed" } }, U(1))).toThrow(m.BomEvidenceError);
    expect(() => m.readDecisionBom({ ...r, document: { ...r.document, version: 7 } }, U(1))).toThrow(m.BomEvidenceError);
    expect(() => m.readDecisionBom(r, U(2))).toThrow(m.BomEvidenceError);
  });
  it("reads anchored_lapsed only for an anchored state (R44)", async () => {
    const r = await readResponse("anchored");
    expect(m.readDecisionBom({ ...r, bom: { ...r.bom, reportedFinality: "anchored_lapsed" } }, U(1)).bom.reportedFinality).toBe("anchored_lapsed");
    const c = await readResponse("chain_signed");
    expect(() => m.readDecisionBom({ ...c, bom: { ...c.bom, reportedFinality: "anchored_lapsed" } }, U(1))).toThrow(m.BomEvidenceError);
  });
  it("reads a contract-valid verify report; by-design limits do not lower the outcome", async () => {
    const s = await sharedBom();
    const r = await aiVerify();
    expect(s.bomVerifyResponseSchema.safeParse(r).success).toBe(true);
    const view = m.readVerifyReport(r, { source: "ai_bom_snapshot", snapshotId: U(70) });
    expect(view.outcome).toBe("valid");
    expect(view.checks.filter((c) => c.byDesign).map((c) => c.check)).toEqual(s.BOM_BUNDLE_REQUIRED_CHECKS);
    expect(view.cannotProve).toEqual(["facts_true", "signing_time_beyond_anchor"]);
  });
  it("never shows an overclaiming report: valid over an invalid check is refused, not displayed", async () => {
    const s = await sharedBom();
    const r = await aiVerify();
    r.checks[2] = { check: "body_signature", status: "invalid", reason: "signature_mismatch", ref: null };
    expect(s.bomVerifyResponseSchema.safeParse(r).success).toBe(false);
    expect(() => m.readVerifyReport(r, { source: "ai_bom_snapshot", snapshotId: U(70) })).toThrow(/inconsistent/);
    const honest = { ...r, outcome: "invalid" };
    expect(m.readVerifyReport(honest, { source: "ai_bom_snapshot", snapshotId: U(70) }).outcome).toBe("invalid");
  });
  it("an unverifiable result that is not by design lowers the outcome", async () => {
    const r = await aiVerify({ outcome: "unverifiable" });
    r.checks[5] = { check: "rendering_hashes", status: "unverifiable", reason: "rendering_not_producible", ref: "spdx-3.0.1" };
    expect((await sharedBom()).bomVerifyResponseSchema.safeParse(r).success).toBe(true);
    expect(m.readVerifyReport(r, { source: "ai_bom_snapshot", snapshotId: U(70) }).outcome).toBe("unverifiable");
    expect(() => m.readVerifyReport({ ...r, outcome: "valid" }, { source: "ai_bom_snapshot", snapshotId: U(70) })).toThrow(/inconsistent/);
  });
  it("refuses a report about a different subject than the one asked for", async () => {
    const r = await aiVerify();
    expect(() => m.readVerifyReport(r, { source: "ai_bom_snapshot", snapshotId: U(99) })).toThrow(m.BomEvidenceError);
    expect(() => m.readVerifyReport({ ...r, source: "decision_bom" }, { source: "decision_bom", auditId: U(1) })).toThrow(m.BomEvidenceError);
  });
  it("reads an unreadable bundle as invalid, with no identity", () => {
    const r = {
      trust: "deployment_registry", source: "bundle", bodyVersion: null, identity: null, outcome: "invalid",
      checks: [{ check: "bundle_manifest_signature", status: "invalid", reason: "bundle_unreadable", ref: null }],
      sections: [], cannotProve: [], manifest: null, verifiedAt: T, capabilities: adminCaps(),
    };
    const view = m.readVerifyReport(r, { source: "bundle" });
    expect(view.outcome).toBe("invalid");
    expect(view.identity).toBeNull();
  });
  it("capabilities: the export reason is set exactly when export is unavailable", () => {
    expect(m.readCapabilities(adminCaps({ canExport: false, exportUnavailableReason: "export_signing_key_absent" })).canExport).toBe(false);
    expect(() => m.readCapabilities(adminCaps({ canExport: false }))).toThrow(m.BomEvidenceError);
  });
  it("capabilities: no export step-up, drift for admins only, an auditor needs a grant; each agrees with the shared schema", async () => {
    const s = await sharedBom();
    const auditor = { ...adminCaps(), access: "auditor_grant", exportRoles: "admins_and_auditors", canViewDrift: false, auditorGrant: { id: U(60), grantedAt: T, grantedBy: U(5) } };
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ["admin", adminCaps(), true],
      ["auditor with a grant", auditor, true],
      ["export step-up claimed", adminCaps({ exportRequiresStepUp: true }), false],
      ["admin without drift", adminCaps({ canViewDrift: false }), false],
      ["auditor with drift", { ...auditor, canViewDrift: true }, false],
      ["auditor with no grant", { ...auditor, auditorGrant: null }, false],
      ["auditor while admins only", { ...auditor, exportRoles: "admins_only" }, false],
      ["rate above 600", adminCaps({ rateLimitPerMinute: 601 }), false],
    ];
    for (const [name, value, ok] of cases) {
      expect(s.bomCapabilitiesSchema.safeParse(value).success, `shared: ${name}`).toBe(ok);
      if (ok) expect(m.readCapabilities(value).access, name).toBe(value.access);
      else expect(() => m.readCapabilities(value), name).toThrow(m.BomEvidenceError);
    }
  });
  it("the required-check sets and cannotProve rule match the shared contract", async () => {
    const s = await sharedBom();
    expect(m.DECISION_BOM_REQUIRED_CHECKS).toEqual(s.DECISION_BOM_REQUIRED_CHECKS);
    expect(m.AI_BOM_REQUIRED_CHECKS).toEqual(s.AI_BOM_REQUIRED_CHECKS);
    expect(m.BOM_BUNDLE_REQUIRED_CHECKS).toEqual(s.BOM_BUNDLE_REQUIRED_CHECKS);
    expect(m.BOM_ANCHOR_CHECKS).toEqual(s.BOM_ANCHOR_CHECKS);
    expect(m.DECISION_BOM_ONLY_CHECKS).toEqual(s.DECISION_BOM_ONLY_CHECKS);
    expect(m.AI_BOM_ONLY_CHECKS).toEqual(s.AI_BOM_ONLY_CHECKS);
    expect(m.DECISION_BOM_CANNOT_PROVE_FIXED).toEqual(s.DECISION_BOM_CANNOT_PROVE_FIXED);
    expect(m.AI_BOM_CANNOT_PROVE_FIXED).toEqual(s.AI_BOM_CANNOT_PROVE_FIXED);
    for (const source of m.BOM_VERIFY_SOURCES) {
      for (const recordedFinality of m.DECISION_BOM_FINALITY_STATES) {
        for (const lapsed of [false, true]) {
          for (const receiptPayloadVersion of ["v1", "v2"] as const) {
            const reportedFinality = lapsed ? "anchored_lapsed" : recordedFinality;
            const id = { subject: "decision-bom" as const, auditId: U(1), bomId: U(2), version: 1, recordedFinality, reportedFinality, receiptPayloadVersion };
            expect(m.cannotProveFor(id, source)).toEqual(s.bomCannotProveFor({ subject: "decision-bom", source, receiptPayloadVersion, recordedFinality, version: 1, reportedFinality }));
          }
        }
      }
      for (const version of [1, 2]) {
        const id = { subject: "ai-bom" as const, snapshotId: U(1), subjectKind: "agent", subjectId: U(2), version, serialNumber: `urn:uuid:${U(3)}` };
        expect(m.cannotProveFor(id, source)).toEqual(s.bomCannotProveFor({ subject: "ai-bom", source, receiptPayloadVersion: null, recordedFinality: null, version, reportedFinality: null }));
      }
    }
  });
  it("an empty 'valid' report is never shown as Valid", async () => {
    const r = await aiVerify({ checks: [] });
    expect((await sharedBom()).bomVerifyResponseSchema.safeParse(r).success).toBe(false);
    expect(() => m.readVerifyReport(r, { source: "ai_bom_snapshot", snapshotId: U(70) })).toThrow(/no checks/);
  });
  it("a report that leaves out a required check, or carries the wrong limits, is refused (and the shared schema agrees)", async () => {
    const s = await sharedBom();
    const noSignature = await aiVerify();
    noSignature.checks = noSignature.checks.filter((c: Any) => c.check !== "body_signature");
    expect(s.bomVerifyResponseSchema.safeParse(noSignature).success).toBe(false);
    expect(() => m.readVerifyReport(noSignature, { source: "ai_bom_snapshot", snapshotId: U(70) })).toThrow(/body_signature/);
    const noSupersedes = await aiVerify();
    noSupersedes.checks = noSupersedes.checks.filter((c: Any) => c.check !== "supersedes");
    expect(s.bomVerifyResponseSchema.safeParse(noSupersedes).success).toBe(false);
    expect(() => m.readVerifyReport(noSupersedes, { source: "ai_bom_snapshot", snapshotId: U(70) })).toThrow(/supersedes/);
    const fewerLimits = await aiVerify({ cannotProve: ["facts_true"] });
    expect(s.bomVerifyResponseSchema.safeParse(fewerLimits).success).toBe(false);
    expect(() => m.readVerifyReport(fewerLimits, { source: "ai_bom_snapshot", snapshotId: U(70) })).toThrow(/cannot be proved/);
    const claimsBundle = await aiVerify();
    claimsBundle.checks = claimsBundle.checks.map((c: Any) => (c.check === "bundle_subject" ? { ...c, status: "valid", reason: null } : c));
    expect(s.bomVerifyResponseSchema.safeParse(claimsBundle).success).toBe(false);
    expect(() => m.readVerifyReport(claimsBundle, { source: "ai_bom_snapshot", snapshotId: U(70) })).toThrow(/bundle checks/);
    const foreign = await aiVerify();
    foreign.checks = [...foreign.checks, { check: "finality", status: "valid", reason: null, ref: null }];
    expect(s.bomVerifyResponseSchema.safeParse(foreign).success).toBe(false);
    expect(() => m.readVerifyReport(foreign, { source: "ai_bom_snapshot", snapshotId: U(70) })).toThrow(/other kind/);
  });
  it("an invalid report that is missing checks is still shown, as invalid (it claims nothing)", async () => {
    const r = await aiVerify({ outcome: "invalid" });
    r.checks = [{ check: "body_signature", status: "invalid", reason: "signature_mismatch", ref: null }, ...r.checks.filter((c: Any) => c.check.startsWith("bundle_"))];
    expect((await sharedBom()).bomVerifyResponseSchema.safeParse(r).success).toBe(true);
    expect(m.readVerifyReport(r, { source: "ai_bom_snapshot", snapshotId: U(70) }).outcome).toBe("invalid");
  });
});

describe("refusals are shown as what they are", () => {
  it("a missing or unusable key says nothing was signed or stored", () => {
    expect(m.bomRefusalText(new ApiError(409, { error: "bom_signing_unavailable", missingKey: "receipt" }))).toMatch(/No receipt signing key.*nothing was signed or stored/);
    expect(m.bomRefusalText(new ApiError(409, { error: "bom_signing_unavailable", missingKey: "export" }))).toMatch(/No export signing key.*nothing was exported/);
    expect(m.bomRefusalText(new ApiError(503, { error: "receipt_signing_key_invalid" }))).toMatch(/cannot be used.*nothing was signed or stored/);
  });
  it("a pending anchor names its reason and when to retry", () => {
    expect(m.bomRefusalText(new ApiError(409, { error: "bom_anchor_pending", reason: "timestamp_pending", retryAfterSeconds: 60 }))).toBe(
      "This decision's BOM is not final yet: its trusted timestamp has not been granted yet. Nothing was frozen. Try again in about 60 seconds.",
    );
  });
  it("forbidden is recognised so the controls are hidden, not offered again", () => {
    expect(m.isBomForbidden(new ApiError(403, { error: "bom_export_forbidden" }))).toBe(true);
    expect(m.isBomForbidden(new ApiError(403, { error: "step_up_required" }))).toBe(false);
  });
});
