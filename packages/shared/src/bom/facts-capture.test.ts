/** ADR-0189 B2 — the pure half of decision fact capture: what is recorded, from where, and what is refused. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bomCanonicalBytes,
  bomDigestOf,
  bomRowDigest,
  buildDecisionFacts,
  composeAuditRetentionDays,
  decisionFactRefs,
  decisionFactsHash,
  DecisionFactsCaptureError,
  decisionFactsSchema,
  isReceiptEligibleAuditRow,
  type DecisionAuditRow,
  type DecisionFactReads,
} from "../index.js";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SPONSOR = U(1);
const SERVER = U(2);
const IDENT = U(3);
const GRANT = U(4);
const APPROVAL = U(5);
const PROJECT = U(6);
const D = "d".repeat(64);

const row = (o: Partial<DecisionAuditRow> = {}): DecisionAuditRow => ({
  id: U(100), seq: 42, at: new Date("2026-10-10T12:00:00.000Z"), userId: SPONSOR, objectType: "mcp_tool", objectId: null,
  serverId: SERVER, toolName: "search", effect: "allow", detail: { receiptClass: "decision", argumentsDigest: D },
  actorIdentityId: null, delegationGrantId: null, actorChain: null, chainVersion: null, ...o,
});
const reads = (o: Partial<{ [K in keyof DecisionFactReads]: DecisionFactReads[K] }> = {}): DecisionFactReads => ({
  projectTags: new Map(), approvals: new Map(), approvalDecisions: new Map(), grants: new Map(), identities: new Map(), ...o,
});
const identity = { id: IDENT, kind: "agent", agentId: U(7), builderAgentId: null, engineRunnerId: null, identifier: `spiffe://regulait.internal/regulait/agent/${U(7)}`, status: "active", grantsRevision: 1 };
const grant = { id: GRANT, rootGrantId: GRANT, parentGrantId: null, path: [], depth: 0, sponsorUserId: SPONSOR, actorIdentityId: IDENT, scope: [{ kind: "tool", serverId: SERVER, toolName: "search" }], capMicros: null, environment: "in_process", audience: "regulait", authCredentialId: null, bindingKind: "in_process", bindingThumbprint: null, expiresAt: new Date("2026-10-11T00:00:00.000Z"), revokedAt: null, createdAt: new Date("2026-10-10T11:00:00.000Z") };

describe("the eligibility predicate and the retention composition", () => {
  it("a receipt object type with receiptClass decision, nothing else", () => {
    expect(isReceiptEligibleAuditRow({ objectType: "mcp_tool", detail: { receiptClass: "decision" } })).toBe(true);
    expect(isReceiptEligibleAuditRow({ objectType: "approval", detail: { receiptClass: "decision" } })).toBe(true);
    expect(isReceiptEligibleAuditRow({ objectType: "workflow", detail: { receiptClass: "decision" } })).toBe(false);
    expect(isReceiptEligibleAuditRow({ objectType: "mcp_tool", detail: { receiptClass: "configuration" } })).toBe(false);
    expect(isReceiptEligibleAuditRow({ objectType: "mcp_tool", detail: null })).toBe(false);
    expect(isReceiptEligibleAuditRow({ objectType: "mcp_tool", detail: [{ receiptClass: "decision" }] })).toBe(false);
  });
  it("the longest profile and the org default, the larger winning; unbounded only when neither is set", () => {
    expect(composeAuditRetentionDays([], null)).toBeNull();
    expect(composeAuditRetentionDays([null, 30], null)).toBe(30);
    expect(composeAuditRetentionDays([30, 400], 90)).toBe(400);
    expect(composeAuditRetentionDays([], 90)).toBe(90);
    expect(composeAuditRetentionDays([30], 90)).toBe(90);
  });
});

describe("buildDecisionFacts", () => {
  it("a v1 decision: target and digest from the row, no actors (pre_identity), no policy, outcome from the effect", () => {
    const f = buildDecisionFacts(row(), reads());
    expect(f).toMatchObject({
      v: "regulait.decision-facts.v1", auditId: U(100), auditSeq: 42, actors: null, policy: null, model: null, rows: [],
      action: { argumentsDigest: D, contextDigest: null, target: { kind: "mcp_tool", serverId: SERVER, toolName: "search", toolNameHash: null, connectorId: null, agentId: null }, inputs: null, dataSensitivity: null, complianceTags: [] },
      outcome: { effect: "allow", refusalCode: null, upstreamStatusClass: null },
    });
    expect(decisionFactsHash(f)).toBe(bomDigestOf(f));
  });
  it("inputs the path does not record are NOT RECORDED (null), never a claimed empty list; the contract keeps both apart", () => {
    const f = buildDecisionFacts(row(), reads());
    expect(f.action!.inputs).toBeNull();
    // `[]` stays a valid, distinct claim ("recorded: none"), and the two hash differently
    const none = decisionFactsSchema.parse({ ...f, action: { ...f.action!, inputs: [] } });
    expect(none.action!.inputs).toEqual([]);
    expect(decisionFactsHash(none)).not.toBe(decisionFactsHash(f));
    expect(bomCanonicalBytes(f)).toContain('"inputs":null');
  });
  it("policy: the epoch and kill-switch state the path recorded; every list it did not record is null; no epoch, no section", () => {
    const f = buildDecisionFacts(row({ detail: { receiptClass: "decision", policyEpoch: 7, killSwitch: "engaged" } }), reads());
    expect(f.policy).toEqual({ governancePolicyEpoch: 7, abacPolicyVersions: null, configVersions: null, guardrailConfigDigest: null, modelPolicyRuleIds: null, killSwitch: "engaged" });
    expect(buildDecisionFacts(row({ detail: { receiptClass: "decision", policyEpoch: 0 } }), reads()).policy!.killSwitch).toBeNull();
    expect(buildDecisionFacts(row({ detail: { receiptClass: "decision", policyEpoch: 7, killSwitch: "maybe" } }), reads()).policy!.killSwitch).toBeNull();
    // NEGATIVE CONTROLS: a path that recorded no epoch (or not an integer one) gets no policy section
    expect(buildDecisionFacts(row(), reads()).policy).toBeNull();
    expect(buildDecisionFacts(row({ detail: { receiptClass: "decision", policyEpoch: "7", killSwitch: "off" } }), reads()).policy).toBeNull();
    expect(buildDecisionFacts(row({ detail: { receiptClass: "decision", policyEpoch: 1.5 } }), reads()).policy).toBeNull();
  });
  it("a digest that is not one is not recorded; an unrepresentable tool name is recorded by its SHA-256", () => {
    const f = buildDecisionFacts(row({ toolName: "tool with spaces", detail: { receiptClass: "decision", argumentsDigest: "not-a-digest" } }), reads());
    expect(f.action!.argumentsDigest).toBeNull();
    expect(f.action!.target).toMatchObject({ toolName: null, toolNameHash: createHash("sha256").update("tool with spaces").digest("hex") });
  });
  it("a v2 decision by a person: actors with the sponsor and an empty chain", () => {
    expect(buildDecisionFacts(row({ chainVersion: 2 }), reads()).actors).toEqual({ sponsorUserId: SPONSOR, actorIdentityId: null, delegationGrantId: null, actorChain: [] });
  });
  it("a v2 decision by an agent: the chain as workload identity URIs from the columns, the grant and identities bound", () => {
    const r = row({ chainVersion: 2, actorIdentityId: IDENT, delegationGrantId: GRANT, actorChain: [IDENT] });
    expect(decisionFactRefs(r)).toMatchObject({ grantId: GRANT, identityIds: [IDENT] });
    const f = buildDecisionFacts(r, reads({ grants: new Map([[GRANT, grant]]), identities: new Map([[IDENT, identity]]) }));
    expect(f.actors).toEqual({ sponsorUserId: SPONSOR, actorIdentityId: IDENT, delegationGrantId: GRANT, actorChain: [identity.identifier] });
    expect(f.rows.map((b) => b.table)).toEqual(["delegation_grants", "workload_identities"]);
    for (const b of f.rows) expect(b.digest).toBe(bomRowDigest(b.table, b.projection));
  });
  it("FAIL CLOSED: an actor chain that cannot be resolved, or a grant that is gone, refuses the capture", () => {
    const r = row({ chainVersion: 2, actorIdentityId: IDENT, delegationGrantId: GRANT, actorChain: [IDENT] });
    expect(() => buildDecisionFacts(r, reads({ grants: new Map([[GRANT, grant]]) }))).toThrow(DecisionFactsCaptureError);
    expect(() => buildDecisionFacts(r, reads({ identities: new Map([[IDENT, identity]]) }))).toThrow(/delegation grant/);
    expect(() => buildDecisionFacts(r, reads({ grants: new Map([[GRANT, grant]]), identities: new Map([[IDENT, { ...identity, identifier: "not-spiffe" }]]) }))).toThrow(/SPIFFE/);
  });
  it("a v1 row's actor columns are never read (only an audit v2 hash covers them)", () => {
    const r = row({ chainVersion: null, actorIdentityId: IDENT, delegationGrantId: GRANT, actorChain: [IDENT] });
    expect(decisionFactRefs(r)).toMatchObject({ grantId: null, identityIds: [] });
    expect(buildDecisionFacts(r, reads()).actors).toBeNull();
  });
  it("the attributed project's tags, sorted; a project that is gone or a tag the contract cannot hold makes the section unrecorded", () => {
    const attributed = row({ detail: { receiptClass: "decision", projectId: PROJECT } });
    expect(buildDecisionFacts(attributed, reads({ projectTags: new Map([[PROJECT, ["soc2", "hipaa", "soc2"]]]) })).action!.complianceTags).toEqual(["hipaa", "soc2"]);
    expect(buildDecisionFacts(attributed, reads({ projectTags: new Map([[PROJECT, null]]) })).action!.complianceTags).toEqual([]);
    expect(buildDecisionFacts(attributed, reads()).action).toBeNull();
    expect(buildDecisionFacts(attributed, reads({ projectTags: new Map([[PROJECT, ["a tag with spaces"]]]) })).action).toBeNull();
  });
  it("binds the named approval and every decision on it; an approval that is gone is not bound", () => {
    const approval = { id: APPROVAL, objectType: "mcp_tool", serverId: SERVER, toolName: "search", status: "approved", quorum: 1, requestedAt: new Date("2026-10-10T11:00:00.000Z"), argumentsDigest: D };
    const decision = { id: U(8), approvalId: APPROVAL, deciderUserId: U(9), principalUserId: U(9), decision: "approved", stepUpMethod: null, credentialId: null, signedDigest: null, counterBefore: null, decidedAt: new Date("2026-10-10T11:30:00.000Z") };
    const r = row({ detail: { receiptClass: "decision", approvedApprovalId: APPROVAL } });
    const f = buildDecisionFacts(r, reads({ approvals: new Map([[APPROVAL, approval]]), approvalDecisions: new Map([[APPROVAL, [decision]]]) }));
    expect(f.rows.map((b) => `${b.table}:${b.id}`)).toEqual([`approval_decisions:${U(8)}`, `approvals:${APPROVAL}`]);
    expect(buildDecisionFacts(r, reads()).rows).toEqual([]);
  });
  it("an agent decision names its agent and claims nothing else about the model", () => {
    const f = buildDecisionFacts(row({ objectType: "agent", objectId: U(7), serverId: null, toolName: null }), reads());
    expect(f.model).toEqual({ agentId: U(7), provider: null, requestedModel: null, servedModel: null, pinnedModelVersion: null, modelCardId: null, modelCardApprovalId: null, aiBomSnapshotId: null });
    expect(f.action!.target).toMatchObject({ kind: "agent", agentId: U(7) });
  });
  it("refuses an effect that is not a decision outcome", () => {
    expect(() => buildDecisionFacts(row({ effect: "maybe" }), reads())).toThrow(/not a decision outcome/);
  });
});
