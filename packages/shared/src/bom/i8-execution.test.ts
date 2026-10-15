/**
 * ADR-0190 slice I8 — execution facts in the evidence: `regulait.decision-facts.v2`, `regulait.decision-bom.v2`,
 * and both Decision BOM versions verifying online (stored source) and offline (the bundle the script reads).
 *
 * The v1 corpus (`b4-vectors.json`, P01 and the rest) stays the proof that a frozen v1 BOM verifies for ever; the
 * v2 documents here are built from P01's own rows with v2 facts and a re-signed receipt, under the same TEST-ONLY
 * CANARY keys (derived from their published seed texts; no private key is stored).
 */
import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { writeBomTar } from "./bom-archive.js";
import { buildDecisionBomBundle } from "./bom-bundle.js";
import { buildAiBom } from "./ai-bom-builder.js";
import type { AiBomRecordSet } from "./ai-bom-records.js";
import {
  AI_BOM_INSTALL_SUBJECT_ID,
  bomCanonicalBytes,
  bomSha256,
  DECISION_BOM_SECTIONS,
  DECISION_BOM_SECTIONS_V2,
  decisionBomBodySchema,
  decisionBomBodyV1Schema,
  decisionBomBodyV2Schema,
  decisionExecutionFactsSchema,
  decisionFactsSchema,
  decisionFactsV1Schema,
  type DecisionExecutionFacts,
} from "./contract.js";
import { bomVerifyResponseSchema } from "./contract-b4.js";
import { assembleDecisionBom, decisionBomSameContent, projectDecisionBom, type DecisionBomAssemblyInput } from "./decision-bom-assembly.js";
import { buildDecisionFacts, buildExecutionFacts, DecisionFactsCaptureError, type DecisionAuditRow, type DecisionFactReads, type DecisionPlacementRead } from "./facts-capture.js";
import { verifyBomBundle, verifyStoredDecisionBom, type BomVerifyReport, type BomVerifyTrust } from "./verify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(path.resolve(here, "../../test-vectors/decision-bom/b4-vectors.json"), "utf8"));
type Entry = { name: string; text: string };
const p01Vector = corpus.positives.find((v: { id: string }) => v.id === "P01") as { bundle: { entries: Entry[] }; trust: { receipt: { keyring: { keys: unknown[] } }; verificationTime: string } };
const fileOf = (p: string) => p01Vector.bundle.entries.find((e) => e.name.endsWith(`/${p}`))!.text;
const P01_TEXT = fileOf("content/decision-bom.json");
const P01 = JSON.parse(P01_TEXT);
const P01_SIG = JSON.parse(fileOf("content/decision-bom.json.sig"));

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function canary(keyId: string) {
  const k = corpus.keys.find((x: { keyId: string }) => x.keyId === keyId);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, createHash("sha256").update(k.seedText, "utf8").digest()]), format: "der", type: "pkcs8" });
  return { keyId, publicKeyPem: k.publicKeyPem as string, fingerprint: k.fingerprint as string, sign: (b: Buffer) => edSign(null, b, privateKey) };
}
const R1 = canary("TEST-ONLY-CANARY-receipt-key-1");
const E1 = canary("TEST-ONLY-CANARY-export-key-1");

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const D = (c: string) => c.repeat(64);
const PLACEMENT = U(901);
const PROFILE = U(902);
const EXECUTOR = U(903);
const EXECUTOR_IDENTITY = U(904);
const ATTESTATION = U(905);
const EXECUTOR_URI = "spiffe://test-only.example/TEST-ONLY-CANARY/regulait/worker_runtime/executor-1";

const EXTERNAL: DecisionExecutionFacts = {
  workloadKind: "remote_mcp", placement: "external", placementId: null, requiredClass: null, requiredBy: null, appliedClass: "external",
  refusalCode: null, profile: null, executor: null, attestation: null,
};
const PLACED: DecisionExecutionFacts = {
  workloadKind: "mcp_stdio", placement: "placed", placementId: PLACEMENT, requiredClass: "user_space_kernel", requiredBy: "workload_kind",
  appliedClass: "user_space_kernel", refusalCode: null,
  profile: { id: PROFILE, name: "restricted", version: 1, digest: D("a") },
  executor: { id: EXECUTOR, backend: "gvisor", runtimeVersion: "test-only-1.0", identityId: EXECUTOR_IDENTITY, identity: EXECUTOR_URI },
  attestation: { placementReportSha256: D("b"), executorAttestationId: ATTESTATION, executorReportSha256: D("c") },
};

/** P01's rows with v2 facts carrying `execution`, its receipt re-pointed at those facts and re-signed with R1 */
function v2Input(execution: DecisionExecutionFacts | null): DecisionBomAssemblyInput {
  const facts = { ...JSON.parse(P01.facts.payload), v: "regulait.decision-facts.v2", execution };
  const factsBytes = bomCanonicalBytes(facts);
  const payload = { ...JSON.parse(P01.receipt.payload), factsHash: bomSha256(factsBytes) };
  const payloadBytes = bomCanonicalBytes(payload);
  return {
    id: P01.id, auditId: P01.auditId, version: 1, supersedes: null, finality: P01.finality,
    receipt: { receiptSeq: P01.receipt.receiptSeq, payload, payloadHash: bomSha256(payloadBytes), signature: R1.sign(Buffer.from(payloadBytes, "utf8")).toString("base64url"), keyId: R1.keyId },
    facts: { facts, factsHash: bomSha256(factsBytes) },
    addenda: [], noFactsReason: "pre_facts", ruleChain: P01.decision.ruleChain, chain: P01.proof.chain, anchor: P01.proof.anchor,
  };
}
const signed = (bodyBytes: string) => ({ body: bodyBytes, bodySha256: bomSha256(bodyBytes), signature: R1.sign(Buffer.from(bodyBytes, "utf8")).toString("base64url"), keyId: R1.keyId, linkedAiBom: null });
const trust = (): BomVerifyTrust => ({ receipt: { keys: p01Vector.trust.receipt.keyring.keys as never }, receiptV2FromAuditSeq: 42, export: null, timestamp: null, verificationTime: p01Vector.trust.verificationTime });
const CAPABILITIES = { access: "admin", exportRoles: "admins_only", auditorGrant: null, canExport: true, exportUnavailableReason: null, canVerify: true, canViewDrift: true, exportRequiresStepUp: false, rateLimitPerMinute: 30 };
const asResponse = (r: BomVerifyReport, source: "bundle" | "decision_bom") => ({ trust: "deployment_registry", source, ...r, verifiedAt: "2026-10-11T00:00:00.000Z", capabilities: CAPABILITIES });
const section = (r: BomVerifyReport, s: string) => r.sections.find((x) => x.section === s);

// ---------------------------------------------------------------------------
// the facts
// ---------------------------------------------------------------------------

describe("ADR-0190 I8: the execution facts contract", () => {
  it("accepts a placement, a refusal, a mismatch, in_gateway and external, each with exactly its own fields", () => {
    expect(decisionExecutionFactsSchema.safeParse(PLACED).success).toBe(true);
    expect(decisionExecutionFactsSchema.safeParse(EXTERNAL).success).toBe(true);
    expect(decisionExecutionFactsSchema.safeParse({ ...EXTERNAL, workloadKind: "model_call", placement: "in_gateway", appliedClass: "in_gateway" }).success).toBe(true);
    expect(decisionExecutionFactsSchema.safeParse({ ...PLACED, placement: "refused", executor: null, appliedClass: null, attestation: null, refusalCode: "no_executor" }).success).toBe(true);
    expect(decisionExecutionFactsSchema.safeParse({ ...PLACED, placement: "mismatch", refusalCode: "execution_profile_mismatch" }).success).toBe(true);
  });
  it("refuses what the placement could not have been: nothing is inferred or mixed", () => {
    const bad: Array<[string, unknown]> = [
      ["a placement without its executor", { ...PLACED, executor: null }],
      ["a placement without its report", { ...PLACED, attestation: { ...PLACED.attestation!, placementReportSha256: null } }],
      ["a refusal that started an executor", { ...PLACED, placement: "refused", refusalCode: "no_executor" }],
      ["a refusal with no reason", { ...PLACED, placement: "refused", executor: null, appliedClass: null, attestation: null }],
      ["a mismatch with another code", { ...PLACED, placement: "mismatch", refusalCode: "no_executor" }],
      ["a remote MCP call called in_gateway", { ...EXTERNAL, placement: "in_gateway", appliedClass: "in_gateway" }],
      ["a model call called external", { ...EXTERNAL, workloadKind: "model_call" }],
      ["an external call with a profile", { ...EXTERNAL, profile: PLACED.profile }],
      ["a model call placed by an executor", { ...PLACED, workloadKind: "model_call" }],
      ["an executor placement applying in_gateway", { ...PLACED, appliedClass: "in_gateway" }],
      ["an attestation id without its report", { ...PLACED, attestation: { ...PLACED.attestation!, executorReportSha256: null } }],
      ["an executor identity that is not a SPIFFE ID", { ...PLACED, executor: { ...PLACED.executor!, identity: "https://executor.invalid/x" } }],
      ["an unknown field", { ...PLACED, imageDigest: D("d") }],
    ];
    for (const [what, value] of bad) expect(decisionExecutionFactsSchema.safeParse(value).success, what).toBe(false);
  });
  it("v1 facts still parse; v1 never carries execution, and v2 always has the key", () => {
    const v1 = JSON.parse(P01.facts.payload);
    expect(decisionFactsV1Schema.safeParse(v1).success).toBe(true);
    expect(decisionFactsSchema.safeParse(v1).success).toBe(true);
    expect(decisionFactsSchema.safeParse({ ...v1, execution: EXTERNAL }).success).toBe(false);
    expect(decisionFactsSchema.safeParse({ ...v1, v: "regulait.decision-facts.v2" }).success).toBe(false);
    expect(decisionFactsSchema.safeParse({ ...v1, v: "regulait.decision-facts.v2", execution: null }).success).toBe(true);
    expect(decisionFactsSchema.safeParse({ ...v1, v: "regulait.decision-facts.v3", execution: null }).success).toBe(false);
  });
});

describe("ADR-0190 I8: capture (buildExecutionFacts)", () => {
  const row = (o: Partial<DecisionAuditRow> = {}): DecisionAuditRow => ({
    id: U(100), seq: 42, at: new Date("2026-10-10T12:00:00.000Z"), userId: U(1), objectType: "mcp_tool", objectId: null,
    serverId: U(2), toolName: "search", effect: "allow", detail: { receiptClass: "decision" },
    actorIdentityId: null, delegationGrantId: null, actorChain: null, chainVersion: null, ...o,
  });
  const reads = (o: Partial<DecisionFactReads> = {}): DecisionFactReads => ({
    projectTags: new Map(), approvals: new Map(), approvalDecisions: new Map(), grants: new Map(), identities: new Map(), ...o,
  });
  const placedRead = (o: Partial<DecisionPlacementRead> = {}, p: Record<string, unknown> = {}): DecisionPlacementRead => ({
    placement: { id: PLACEMENT, auditId: U(100), workloadKind: "mcp_stdio", requiredClass: "user_space_kernel", requiredBy: "workload_kind", enforcement: "enforce", profileDigest: D("a"), executorId: EXECUTOR, appliedClass: "user_space_kernel", reportSha256: D("b"), outcome: "placed", refusalCode: null, createdAt: new Date("2026-10-10T11:59:59.000Z"), ...p },
    profile: { id: PROFILE, name: "restricted", version: 1, digest: D("a") },
    executor: { id: EXECUTOR, backend: "gvisor", runtimeVersion: "test-only-1.0", workloadIdentityId: EXECUTOR_IDENTITY },
    executorIdentity: EXECUTOR_URI,
    executorAttestation: { id: ATTESTATION, reportSha256: D("c") },
    ...o,
  });

  it("no placement row: a model or connector call ran in the gateway, a remote MCP call on the upstream's host", () => {
    expect(buildExecutionFacts(row({ objectType: "agent", objectId: U(7), serverId: null }), reads())).toMatchObject({ workloadKind: "model_call", placement: "in_gateway", appliedClass: "in_gateway", profile: null });
    expect(buildExecutionFacts(row({ objectType: "connector", objectId: U(8), serverId: null }), reads())).toMatchObject({ workloadKind: "connector_call", placement: "in_gateway" });
    for (const transport of ["streamable_http", "sse"]) {
      expect(buildExecutionFacts(row(), reads({ mcpServerTransports: new Map([[U(2), transport]]) }))).toEqual(EXTERNAL);
    }
  });
  it("no placement row and nothing to record: a stdio call, an unknown server, an approval are NOT RECORDED (null)", () => {
    expect(buildExecutionFacts(row(), reads({ mcpServerTransports: new Map([[U(2), "stdio"]]) }))).toBeNull();
    expect(buildExecutionFacts(row(), reads())).toBeNull();
    expect(buildExecutionFacts(row({ serverId: null }), reads({ mcpServerTransports: new Map([[U(2), "sse"]]) }))).toBeNull();
    expect(buildExecutionFacts(row({ objectType: "approval", serverId: null }), reads())).toBeNull();
  });
  it("a placement row written in the decision's transaction is captured: class, floor, profile, executor and attestation", () => {
    // the transport says remote, but the placement row is the authority (the row exists only because it was placed)
    const f = buildDecisionFacts(row(), reads({ placements: new Map([[U(100), placedRead()]]), mcpServerTransports: new Map([[U(2), "sse"]]) }));
    expect(f.v).toBe("regulait.decision-facts.v2");
    expect(f.v === "regulait.decision-facts.v2" && f.execution).toEqual(PLACED);
  });
  it("a refusal and a mismatch keep their own shape; an executor without a SPIFFE identity records none", () => {
    const refused = buildExecutionFacts(row(), reads({ placements: new Map([[U(100), placedRead({ executor: null, executorIdentity: null, executorAttestation: null }, { outcome: "refused", executorId: null, appliedClass: null, reportSha256: null, refusalCode: "attestation_stale" })]]) }));
    expect(refused).toMatchObject({ placement: "refused", refusalCode: "attestation_stale", executor: null, attestation: null, appliedClass: null });
    const mismatch = buildExecutionFacts(row(), reads({ placements: new Map([[U(100), placedRead({ executorIdentity: "not-a-spiffe-id", executorAttestation: null }, { outcome: "mismatch", appliedClass: null, refusalCode: "execution_profile_mismatch" })]]) }));
    expect(mismatch).toMatchObject({ placement: "mismatch", appliedClass: null, executor: { identity: null }, attestation: { placementReportSha256: D("b"), executorAttestationId: null, executorReportSha256: null } });
  });
  it("FAIL CLOSED: a placement row the contract cannot represent refuses the capture (and the decision with it)", () => {
    const broken = reads({ placements: new Map([[U(100), placedRead({ executor: null })]]) });
    expect(() => buildDecisionFacts(row(), broken)).toThrow(DecisionFactsCaptureError);
    const unknownFloor = reads({ placements: new Map([[U(100), placedRead({}, { requiredBy: "a_floor_nobody_named" })]]) });
    expect(() => buildDecisionFacts(row(), unknownFloor)).toThrow(/regulait\.decision-facts\.v2/);
  });
});

// ---------------------------------------------------------------------------
// the Decision BOM
// ---------------------------------------------------------------------------

describe("ADR-0190 I8: regulait.decision-bom.v2", () => {
  it("v2 carries the execution section exactly as the facts recorded it, and its completeness entry", () => {
    const a = assembleDecisionBom(v2Input(PLACED));
    expect(a.body.v).toBe("regulait.decision-bom.v2");
    expect(a.body.execution).toEqual(PLACED);
    expect((a.body.completeness as Record<string, unknown>).execution).toEqual({ status: "recorded" });
    expect(Object.keys(a.body.completeness as object).sort()).toEqual([...DECISION_BOM_SECTIONS_V2].sort());
    expect(decisionBomBodyV2Schema.safeParse(a.body).success).toBe(true);
  });
  it("completeness says why execution is missing: pre_isolation, no_placement, the no-facts reason, not_applicable", () => {
    const base = v2Input(null);
    const v1Facts = { facts: JSON.parse(P01.facts.payload), factsHash: bomSha256(P01.facts.payload) };
    const project = (over: Partial<Parameters<typeof projectDecisionBom>[0]>) =>
      projectDecisionBom({ bodyVersion: "regulait.decision-bom.v2", receipt: base.receipt.payload, receiptSeq: 1, facts: base.facts!.facts as never, addenda: [], noFactsReason: "pre_facts", ruleChain: [], chain: P01.proof.chain, anchor: null, ...over });
    expect(project({}).completeness.execution).toEqual({ status: "not_recorded", reason: "no_placement" });
    expect(project({ facts: v1Facts.facts }).completeness.execution).toEqual({ status: "not_recorded", reason: "pre_isolation" });
    expect(project({ facts: null, noFactsReason: "capture_off" }).completeness.execution).toEqual({ status: "not_recorded", reason: "capture_off" });
    const approval = { ...base.receipt.payload, decision: { ...base.receipt.payload.decision, objectType: "approval" } } as typeof base.receipt.payload;
    expect(project({ receipt: approval }).completeness.execution).toEqual({ status: "not_applicable" });
    // a v1 projection has no execution section at all
    const v1 = project({ bodyVersion: "regulait.decision-bom.v1", facts: v1Facts.facts });
    expect("execution" in v1.completeness).toBe(false);
    expect(v1.problems).toEqual([]);
    // and a v1 body never carries v2 facts (their execution section would be dropped unseen)
    expect(project({ bodyVersion: "regulait.decision-bom.v1" }).problems.map((p) => p.section)).toEqual(["decision"]);
  });
  it("the schema: recorded exactly when present; not_applicable only for an approval", () => {
    const a = assembleDecisionBom(v2Input(PLACED)).body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(decisionBomBodySchema.safeParse({ ...a, execution: null }).success).toBe(false);
    const na = { ...a, execution: null, completeness: { ...a.completeness, execution: { status: "not_applicable" } } };
    expect(decisionBomBodySchema.safeParse(na).success).toBe(false);
    expect(decisionBomBodySchema.safeParse({ ...na, decision: { ...a.decision, objectType: "approval" } }).success).toBe(true);
    // v1 and v2 do not mix: v1 has no execution key, v2 always has one
    const { execution: _e, ...withoutExecution } = a;
    expect(decisionBomBodySchema.safeParse(withoutExecution).success).toBe(false);
    expect(decisionBomBodyV1Schema.safeParse({ ...a, v: "regulait.decision-bom.v1" }).success).toBe(false);
    expect(decisionBomBodyV1Schema.safeParse(P01).success).toBe(true);
  });
  it("a format change is not a new fact: a frozen v1 body and its v2 re-assembly are the same version; a recorded execution is not", () => {
    const v1Again = assembleDecisionBom({ ...v2Input(null), receipt: { ...v2Input(null).receipt, payload: JSON.parse(P01.receipt.payload), payloadHash: P01.receipt.payloadHash, signature: P01.receipt.signature, keyId: P01.receipt.keyId }, facts: { facts: JSON.parse(P01.facts.payload), factsHash: bomSha256(P01.facts.payload) } });
    expect(v1Again.body.v).toBe("regulait.decision-bom.v2");
    expect(decisionBomSameContent(P01, v1Again.body)).toBe(true);
    expect(decisionBomSameContent(v1Again.body, P01)).toBe(true);
    // NEGATIVE CONTROLS: a v2 body with a recorded execution, or any other difference, is a new version
    expect(decisionBomSameContent(P01, assembleDecisionBom(v2Input(EXTERNAL)).body)).toBe(false);
    expect(decisionBomSameContent(P01, { ...v1Again.body, finality: "anchored" })).toBe(false);
    expect(decisionBomSameContent(P01, { ...v1Again.body, completeness: { ...(v1Again.body.completeness as object), execution: { status: "not_recorded", reason: "no_placement" } } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verification: both versions, stored (online) and bundled (the offline script)
// ---------------------------------------------------------------------------

describe("ADR-0190 I8: verifying v1 and v2 Decision BOMs", () => {
  it("a frozen v1 BOM still verifies valid, stored and bundled, with its twelve sections and no execution", async () => {
    const stored = await verifyStoredDecisionBom({ body: P01_TEXT, bodySha256: P01_SIG.signedSha256, signature: P01_SIG.signature, keyId: P01_SIG.keyId, linkedAiBom: null }, trust());
    expect(stored.outcome, JSON.stringify(stored.checks.filter((c) => c.status === "invalid"))).toBe("valid");
    expect(stored.bodyVersion).toBe("regulait.decision-bom.v1");
    expect(stored.sections.map((s) => s.section)).toEqual([...DECISION_BOM_SECTIONS]);
    expect(bomVerifyResponseSchema.safeParse(asResponse(stored, "decision_bom")).success).toBe(true);
    const bundled = await verifyBomBundle(gzipSync(writeBomTar(p01Vector.bundle.entries.map((e) => ({ path: e.name, body: Buffer.from(e.text, "utf8") })))), { ...trust(), export: { keys: [{ keyId: E1.keyId, publicKeyPem: E1.publicKeyPem }] } });
    expect(bundled.outcome).toBe("valid");
    expect(bundled.bodyVersion).toBe("regulait.decision-bom.v1");
    expect(bomVerifyResponseSchema.safeParse(asResponse(bundled, "bundle")).success).toBe(true);
  });
  for (const [what, execution] of [["placed", PLACED], ["external", EXTERNAL], ["not recorded (no placement)", null]] as const) {
    it(`a v2 BOM (${what}) verifies valid stored and bundled, its execution section recomputed from the facts`, async () => {
      const a = assembleDecisionBom(v2Input(execution));
      const stored = await verifyStoredDecisionBom(signed(a.bodyBytes), trust());
      expect(stored.outcome, JSON.stringify(stored.checks.filter((c) => c.status !== "valid"))).toBe("valid");
      expect(stored.bodyVersion).toBe("regulait.decision-bom.v2");
      expect(stored.sections.map((s) => s.section)).toEqual([...DECISION_BOM_SECTIONS_V2]);
      expect(section(stored, "execution")).toEqual({ section: "execution", status: "valid", completeness: execution ? "recorded" : "not_recorded", notRecordedReason: execution ? null : "no_placement" });
      expect(bomVerifyResponseSchema.safeParse(asResponse(stored, "decision_bom")).success).toBe(true);

      const row = signed(a.bodyBytes);
      const env = { installId: null, installIdSource: "absent" as const, exportedAt: "2026-10-11T00:00:00.000Z", exportedByUserId: U(1), exportKey: E1, receiptKeys: [{ keyId: R1.keyId, jwk: (p01Vector.trust.receipt.keyring.keys[0] as { jwk: { kty: "OKP"; crv: "Ed25519"; x: string } }).jwk }] };
      const built = buildDecisionBomBundle({ row: { ...row, id: P01.id, auditId: P01.auditId, version: 1, finality: P01.finality }, linkedAiBom: null, renderings: [] }, env);
      const bundled = await verifyBomBundle(gzipSync(writeBomTar(built.files)), { ...trust(), export: { keys: [{ keyId: E1.keyId, publicKeyPem: E1.publicKeyPem }] } });
      expect(bundled.outcome, JSON.stringify(bundled.checks.filter((c) => c.status !== "valid"))).toBe("valid");
      expect(bundled.bodyVersion).toBe("regulait.decision-bom.v2");
      expect(bomVerifyResponseSchema.safeParse(asResponse(bundled, "bundle")).success).toBe(true);
    });
  }
  it("an execution section that is not the facts' is invalid, even correctly signed", async () => {
    const a = assembleDecisionBom(v2Input(PLACED));
    const forged = bomCanonicalBytes({ ...a.body, execution: { ...PLACED, appliedClass: "microvm" } });
    const r = await verifyStoredDecisionBom(signed(forged), trust());
    expect(r.outcome).toBe("invalid");
    expect(r.checks.find((c) => c.check === "sections_projection")).toMatchObject({ status: "invalid", reason: "section_mismatch" });
    expect(section(r, "execution")?.status).toBe("invalid");
    // and a completeness entry that hides a recorded execution
    const hidden = bomCanonicalBytes({ ...a.body, execution: null, completeness: { ...(a.body.completeness as object), execution: { status: "not_recorded", reason: "no_placement" } } });
    expect((await verifyStoredDecisionBom(signed(hidden), trust())).outcome).toBe("invalid");
  });
  it("a v1 body carrying v2 facts is invalid (the execution facts would be dropped unseen)", async () => {
    const a = assembleDecisionBom(v2Input(PLACED)).body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { execution: _x, completeness, ...rest } = a;
    const { execution: _y, ...v1Completeness } = completeness;
    const relabelled = bomCanonicalBytes({ ...rest, v: "regulait.decision-bom.v1", completeness: v1Completeness });
    expect(decisionBomBodyV1Schema.safeParse(JSON.parse(relabelled)).success).toBe(true);
    const r = await verifyStoredDecisionBom(signed(relabelled), trust());
    expect(r.outcome).toBe("invalid");
    expect(r.bodyVersion).toBe("regulait.decision-bom.v1");
    expect(section(r, "decision")?.status).toBe("invalid");
    expect(bomVerifyResponseSchema.safeParse(asResponse(r, "decision_bom")).success).toBe(true);
  });
  it("an unknown version is still refused (OWNER DECISION 2)", async () => {
    const a = assembleDecisionBom(v2Input(PLACED));
    const r = await verifyStoredDecisionBom(signed(bomCanonicalBytes({ ...a.body, v: "regulait.decision-bom.v3" })), trust());
    expect(r.checks.find((c) => c.check === "body_version")).toMatchObject({ status: "invalid", reason: "unknown_body_version" });
  });
});

// ---------------------------------------------------------------------------
// the AI BOM: executors and profiles (decision 9), still regulait.ai-bom.v1
// ---------------------------------------------------------------------------

describe("ADR-0190 I8: executors and profiles in the AI BOM", () => {
  const STDIO = U(950);
  const L2 = U(951);
  const L1 = U(952);
  const EXEC = U(953);
  const CUSTOMER = U(954);
  const install = { kind: "install" as const, id: AI_BOM_INSTALL_SUBJECT_ID };
  const meta = { id: U(960), subjectKind: "install" as const, subjectId: AI_BOM_INSTALL_SUBJECT_ID, version: 1, supersedes: null, trigger: "on_demand" as const, createdAt: "2026-10-15T12:00:00.000Z" };
  const profile = (id: string, name: string, digest: string, minClass: string, retired = false) => ({ id, name, version: 1, digest, minClass, shipped: name === "restricted", retired });
  type Att = { profileDigest: string; class: string; reportSha256: string; observedAt: string };
  const att = (profileDigest: string, cls: string): Att => ({ profileDigest, class: cls, reportSha256: D("b"), observedAt: "2026-10-15T11:00:00.000Z" });
  const executor = (o: Partial<{ id: string; backend: string; status: string; classesDeclared: string[]; declaredClass: string | null; attestations: Att[] }> = {}) => ({
    id: EXEC, name: "executor-one", backend: "gvisor", runtimeVersion: "test-only-1.0", classesDeclared: ["user_space_kernel", "hardened_container"], declaredClass: null as string | null, status: "active",
    workloadIdentity: "spiffe://test-only.example/TEST-ONLY-CANARY/regulait/worker_runtime/executor-one",
    attestations: [att(D("a"), "user_space_kernel")],
    ...o,
  });
  const customer = (attestations: Att[]) => executor({ id: CUSTOMER, backend: "customer", classesDeclared: ["customer_declared"], attestations });
  const stdioServer = { id: STDIO, name: "stdio-files", transport: "stdio", url: "stdio:stdio-files", releaseDigest: null, admissionState: "clean", admissionManifestDigest: null, identityPropagation: "none", ownerUserId: null, ownerDisplayName: null };
  const records = (o: Partial<AiBomRecordSet> = {}): AiBomRecordSet => ({
    subject: install, install: { installId: null }, useCases: [], agents: [], customProviders: [], modelCards: [], modelCardApprovals: [], modelCardEvidence: [],
    evalRuns: [], evalDatasets: [], trainingDatasets: [], trainingJobs: [], trainingArtifacts: [], modelArtifacts: [], artifactScans: [], engineRuns: [], engines: [],
    promptTags: [], configVersions: [], connectors: [], grants: [], builderAgents: [], builderSkills: [], memoryStores: [], mcpTools: [],
    mcpServers: [stdioServer],
    executionProfiles: [profile(L2, "restricted", D("a"), "user_space_kernel"), profile(L1, "hardened", D("c"), "hardened_container")],
    executors: [executor()],
    executionAssignments: [{ targetKind: "mcp_server", targetId: STDIO, profileId: L2 }],
    ...o,
  });
  const build = (r: AiBomRecordSet) => buildAiBom(r, meta, { cyclonedxVersions: ["1.7", "1.6"] });
  type Built = ReturnType<typeof build>;
  type Ref = { "bom-ref": string; properties?: Array<{ name: string; value: string }> } & Record<string, unknown>;
  const cdx = (b: Built) => JSON.parse(b.renderings.find((x) => x.format === "cyclonedx-1.7")!.bytes) as { components: Ref[]; services: Ref[]; dependencies: Array<{ ref: string; dependsOn?: string[] }> };
  const isolationGaps = (b: Built) => b.gaps.filter((g) => g.field === "isolation").map((g) => g.reason);
  const mcpRef = `service:mcp:${STDIO}`;

  it("a profile is a hashed configuration component; an executor a service with its trust zone, runtime and attestations", () => {
    const b = build(records());
    expect(b.body.v).toBe("regulait.ai-bom.v1");
    const doc = cdx(b);
    const p = doc.components.find((c) => c["bom-ref"] === `execution-profile:${L2}`)!;
    expect(p).toMatchObject({ type: "data", name: "restricted", version: "1", hashes: [{ alg: "SHA-256", content: D("a") }], data: [{ type: "configuration" }] });
    expect(p.properties).toContainEqual({ name: "regulait:execution:profile:minClass", value: "user_space_kernel" });
    const s = doc.services.find((x) => x["bom-ref"] === `service:executor:${EXEC}`)!;
    expect(s).toMatchObject({ name: "executor-one", version: "test-only-1.0", trustZone: "regulait-execution-plane" });
    expect(s.properties).toEqual(expect.arrayContaining([
      { name: "regulait:executor:backend", value: "gvisor" },
      { name: "regulait:executor:attested", value: `user_space_kernel:${D("a")}` },
      { name: "regulait:executor:attestationReport", value: `user_space_kernel:${D("a")}:sha256:${D("b")}` },
    ]));
    const deps = new Map(doc.dependencies.map((d) => [d.ref, d.dependsOn ?? []]));
    expect(deps.get(`service:executor:${EXEC}`)).toEqual([`execution-profile:${L2}`]);
    expect(deps.get(mcpRef)).toContain(`execution-profile:${L2}`);
    expect(doc.services.find((x) => x["bom-ref"] === mcpRef)!.properties).toContainEqual({ name: "regulait:execution:placement", value: "executor" });
    // attested at L2 for its profile: no isolation gap
    expect(isolationGaps(b)).toEqual([]);
    expect((b.body.records.executors as unknown[]).length).toBe(1);
    // SPDX maps the profile as a configuration file (executors are services: CycloneDX only)
    const spdx = b.renderings.find((x) => x.format === "spdx-3.0.1");
    expect(spdx, "the SPDX rendering is produced").toBeDefined();
    const graph = JSON.parse(spdx!.bytes)["@graph"] as Array<{ type: string; name?: string; software_primaryPurpose?: string }>;
    expect(graph.some((e) => e.type === "software_File" && e.name === "restricted" && e.software_primaryPurpose === "configuration")).toBe(true);
  });
  it("isolation evidence short of an attested L2 makes the stdio server's composition incomplete, with the reason", () => {
    const cases: Array<[string, Partial<AiBomRecordSet>, string]> = [
      ["no profile assigned", { executionAssignments: [] }, "execution_profile_not_assigned"],
      ["an L1 profile", { executionAssignments: [{ targetKind: "mcp_server", targetId: STDIO, profileId: L1 }] }, "isolation_hardened_container"],
      ["a retired profile", { executionProfiles: [profile(L2, "restricted", D("a"), "user_space_kernel", true)] }, "execution_profile_retired"],
      ["no executor", { executors: [] }, "isolation_not_attested"],
      ["a quarantined executor", { executors: [executor({ status: "quarantined" })] }, "isolation_not_attested"],
      ["an attestation below the profile's class", { executors: [executor({ attestations: [att(D("a"), "hardened_container")] })] }, "isolation_not_attested"],
      ["an attestation for another profile", { executors: [executor({ backend: "kata", attestations: [att(D("c"), "microvm")] })] }, "isolation_not_attested"],
      ["only a customer-declared plane", { executors: [customer([att(D("a"), "customer_declared")])] }, "isolation_customer_declared"],
    ];
    for (const [what, over, reason] of cases) {
      const b = build(records(over));
      expect(isolationGaps(b), what).toEqual([reason]);
      const comps = b.body.compositions.filter((c) => c.assemblies.includes(mcpRef));
      expect(comps.length, what).toBeGreaterThan(0);
      expect(comps.every((c) => c.aggregate !== "complete"), what).toBe(true);
    }
    // a microvm attestation satisfies an L2 profile (a class is a floor)
    expect(isolationGaps(build(records({ executors: [executor({ backend: "kata", classesDeclared: ["hardened_container", "microvm"], attestations: [att(D("a"), "microvm")] })] })))).toEqual([]);
  });
  it("a customer plane's executor sits in the customer's trust zone; a remote MCP server is external", () => {
    const remote = { ...stdioServer, id: U(955), name: "remote", transport: "streamable_http", url: "https://mcp.example/x" };
    const b = build(records({ executors: [{ ...customer([]), declaredClass: "user_space_kernel" }], mcpServers: [stdioServer, remote] }));
    const doc = cdx(b);
    expect(doc.services.find((x) => x["bom-ref"] === `service:executor:${CUSTOMER}`)).toMatchObject({ trustZone: "customer-execution-plane" });
    expect(doc.services.find((x) => x["bom-ref"] === `service:mcp:${U(955)}`)!.properties).toContainEqual({ name: "regulait:execution:placement", value: "external" });
  });
  it("refuses a dangling assignment, an unknown attestation field and an unknown class (never dropped, never copied)", () => {
    expect(() => build(records({ executionAssignments: [{ targetKind: "mcp_server", targetId: STDIO, profileId: U(999) }] }))).toThrow(/not loaded/);
    expect(() => build(records({ executionAssignments: [{ targetKind: "agent", targetId: U(998), profileId: L2 }] }))).toThrow(/not in the record set/);
    expect(() => build(records({ executors: [executor({ attestations: [{ ...att(D("a"), "user_space_kernel"), report: "raw" } as Att] })] }))).toThrow(/attestations\[0\]/);
    expect(() => build(records({ executors: [executor({ attestations: [att(D("a"), "sandbox")] })] }))).toThrow(/class/);
  });
  it("records without the execution lists still build (optional on input), with empty lists in the body", () => {
    const { executionProfiles: _p, executors: _e, executionAssignments: _a, ...older } = records({ mcpServers: [] });
    const b = build(older as AiBomRecordSet);
    expect(b.body.records.executionProfiles).toEqual([]);
    expect(b.body.records.executors).toEqual([]);
    expect(b.body.records.executionAssignments).toEqual([]);
  });
});
