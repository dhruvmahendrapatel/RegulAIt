/**
 * ADR-0190 I8: the Decision BOM v2 `execution` section in the browser. The fixture is a v2 body assembled by the
 * shared assembler (the gateway's own code path) and parsed by the shared read-response schema first, so the
 * reader is only tested on what the live contract accepts; then it is shown, from the signed body only.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import * as m from "./bomModel";
import { ExecutionFacts, PlacementReports, RelaxationRecord } from "./DecisionBomPanel";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const sharedBom = async (): Promise<Any> => import(/* @vite-ignore */ new URL("../../../../../../packages/shared/src/bom/index.ts", import.meta.url).pathname);
const sharedFile = async (file: string): Promise<Any> => import(/* @vite-ignore */ new URL(`../../../../../../packages/shared/src/${file}`, import.meta.url).pathname);

const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const H = (c: string) => c.repeat(64);
const T = "2026-10-10T12:00:00.000Z";
const SIG = "A".repeat(86);
const caps = { access: "admin", exportRoles: "admins_only", auditorGrant: null, canExport: true, exportUnavailableReason: null, canVerify: true, canViewDrift: true, exportRequiresStepUp: false, rateLimitPerMinute: 30 };

const PLACED = {
  workloadKind: "mcp_stdio", placement: "placed", placementId: U(901), requiredClass: "user_space_kernel", requiredBy: "data_sensitivity",
  appliedClass: "user_space_kernel", refusalCode: null,
  profile: { id: U(902), name: "restricted", version: 3, digest: H("a") },
  executor: { id: U(903), backend: "gvisor", runtimeVersion: "test-only-1.0", identityId: U(904), identity: "spiffe://test-only.example/regulait/worker_runtime/executor-1" },
  attestation: { placementReportSha256: H("b"), executorAttestationId: U(905), executorReportSha256: H("c") },
};
const IN_GATEWAY = { workloadKind: "model_call", placement: "in_gateway", placementId: null, requiredClass: null, requiredBy: null, appliedClass: "in_gateway", refusalCode: null, profile: null, executor: null, attestation: null };

/** a v2 read response for one decision, assembled by the shared assembler from v2 facts carrying `execution` */
async function v2Response(execution: Any, objectType = "mcp_tool", placementReports?: Any[], extra: Record<string, unknown> = {}): Promise<Any> {
  const s = await sharedBom();
  const { canonicalJson } = await sharedFile("audit-chain.ts");
  const { RECEIPT_PAYLOAD_VERSION } = await sharedFile("batch4.ts");
  const auditId = U(1);
  const facts = { v: s.DECISION_FACTS_VERSION_V2, auditId, auditSeq: 41, action: null, policy: null, model: null, actors: null, outcome: { effect: "allow", refusalCode: null, upstreamStatusClass: null }, rows: [], execution };
  const factsBytes = s.bomCanonicalBytes(facts);
  const receipt = {
    v: RECEIPT_PAYLOAD_VERSION, keyId: "receipt-2026", receiptSeq: 5, prev: H("0"),
    audit: { id: auditId, seq: 41, contentHash: H("1"), rowHash: H("2") },
    decision: { at: T, userId: U(5), objectType, objectId: null, serverId: null, toolName: null, effect: "allow", ruleId: "grant-allow" },
  };
  const payloadBytes = canonicalJson(receipt);
  const a = s.assembleDecisionBom({
    id: U(21), auditId, version: 1, supersedes: null, finality: "chain_signed",
    receipt: { receiptSeq: 5, payload: receipt, payloadHash: s.bomSha256(payloadBytes), signature: SIG, keyId: "receipt-2026" },
    facts: { facts, factsHash: s.bomSha256(factsBytes) }, addenda: [], noFactsReason: "pre_facts", ruleChain: ["grant-allow"],
    chain: [{ seq: 41, contentHash: H("1"), prevHash: H("0"), rowHash: H("2") }], anchor: null,
  });
  const summary = { id: U(21), version: 1, supersedes: null, finality: "chain_signed", bodySha256: a.bodySha256, keyId: "receipt-2026", createdAt: T };
  const r = {
    auditId,
    bom: { ...summary, body: a.bodyBytes, signature: SIG, aiBomSnapshotId: null, reportedFinality: "chain_signed" },
    document: a.body,
    versions: [summary],
    renderings: [],
    bundle: { schema: "regulait.export-bundle/3", subject: "decision-bom", href: `/v1/decisions/${auditId}/bom/bundle?version=1` },
    capabilities: caps,
    ...(placementReports ? { placementReports } : {}),
    ...extra,
  };
  expect(s.decisionBomReadResponseSchema.safeParse(r).success).toBe(true);
  return JSON.parse(JSON.stringify(r));
}
const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe("ADR-0190 I8: a v2 Decision BOM's execution facts in the browser", () => {
  it("reads the execution section from the signed body, with its thirteen sections", async () => {
    const view = m.readDecisionBom(await v2Response(PLACED), U(1));
    expect(view.bodyVersion).toBe("regulait.decision-bom.v2");
    expect(view.execution).toEqual({ ...PLACED, offerId: null, imageDigest: null, runtimeFlagsSha256: null, relaxation: null });
    expect(view.placementReports).toEqual([]);
    expect(view.completeness.map((c) => c.section)).toEqual([...m.DECISION_BOM_SECTIONS_V2]);
    expect(view.completeness.find((c) => c.section === "execution")).toEqual({ section: "execution", status: "recorded", reason: null });
  });
  it("a v2 body with no placement says so, and an approval says not applicable", async () => {
    const none = m.readDecisionBom(await v2Response(null), U(1));
    expect(none.execution).toBeNull();
    expect(none.completeness.find((c) => c.section === "execution")).toEqual({ section: "execution", status: "not_recorded", reason: "no_placement" });
    expect(m.notRecordedLabel("no_placement")).toBe("No placement recorded");
    const approval = m.readDecisionBom(await v2Response(null, "approval"), U(1));
    expect(approval.completeness.find((c) => c.section === "execution")!.status).toBe("not_applicable");
  });
  it("refuses an execution section it cannot read in full: nothing is shown in part", async () => {
    const r = await v2Response(PLACED);
    const lie = (execution: Any, completeness?: Any) => {
      const doc = { ...r.document, execution, ...(completeness ? { completeness: { ...r.document.completeness, execution: completeness } } : {}) };
      return { ...r, document: doc, bom: { ...r.bom, body: JSON.stringify(doc) } };
    };
    for (const [what, bad] of [
      ["an extra field", lie({ ...PLACED, hostPath: "/srv" })],
      ["an image digest that is not sha256:<64 hex>", lie({ ...PLACED, imageDigest: H("d") })],
      ["a placed row naming an offer", lie({ ...PLACED, offerId: U(906) })],
      ["an unknown class", lie({ ...PLACED, appliedClass: "sandbox" })],
      ["a placement with no profile", lie({ ...PLACED, profile: null })],
      ["an in-gateway call with an executor", lie({ ...IN_GATEWAY, executor: PLACED.executor })],
      ["recorded but absent", lie(null)],
      ["present but not recorded", lie(PLACED, { status: "not_recorded", reason: "no_placement" })],
      ["a v2 body without its execution key", (() => { const { execution: _e, ...doc } = r.document; return { ...r, document: doc, bom: { ...r.bom, body: JSON.stringify(doc) } }; })()],
    ] as const) {
      expect(() => m.readDecisionBom(bad, U(1)), what).toThrow(m.BomEvidenceError);
    }
  });
  it("ADR-0190 owner decision C: a relaxed requirement names the relaxation (subject kind and id), from the signed body", async () => {
    const relaxation = { kind: "person_stdio_l2", subjectKind: "interactive_person", relaxationId: U(950), scopeKind: "mcp_server", scopeId: U(951) };
    const view = m.readDecisionBom(await v2Response({ ...PLACED, relaxation }), U(1));
    expect(view.execution!.relaxation).toEqual({ relaxationId: U(950), scopeKind: "mcp_server", scopeId: U(951) });
    const out = html(<ExecutionFacts execution={view.execution!} />);
    expect(out).toContain("Isolation relaxation");
    expect(out).toContain("L3 lowered to L2 by an admin for this MCP server");
    expect(out).toContain(U(950));
    // NEGATIVE CONTROL: no relaxation, no row
    expect(html(<ExecutionFacts execution={m.readDecisionBom(await v2Response(PLACED), U(1)).execution!} />)).not.toContain("Isolation relaxation");
    // a malformed one makes the whole BOM unreadable, never shown in part
    const r = await v2Response({ ...PLACED, relaxation });
    for (const bad of [{ ...relaxation, subjectKind: "api_key" }, { ...relaxation, scopeKind: "org" }, { ...relaxation, extra: 1 }]) {
      const doc = { ...r.document, execution: { ...r.document.execution, relaxation: bad } };
      expect(() => m.readDecisionBom({ ...r, document: doc, bom: { ...r.bom, body: JSON.stringify(doc) } }, U(1)), JSON.stringify(bad)).toThrow(m.BomEvidenceError);
    }
  });
  it("shows where it ran, the class it required and why, the profile, the executor and the attestation references", () => {
    const out = html(<ExecutionFacts execution={PLACED as m.ExecutionView} />);
    expect(out).toContain("Placed on an executor");
    expect(out).toContain("L2 user-space kernel, set by the data sensitivity");
    expect(out).toContain("restricted version 3");
    expect(out).toContain("spiffe://test-only.example/regulait/worker_runtime/executor-1");
    expect(out).toContain(H("b"));
    expect(out).toContain(H("c"));
    expect(out).toContain("Software-attested");
  });
  it("review L1: a mismatch shows the reported class as disputed and claims no attestation", () => {
    const mismatch = { ...PLACED, placement: "mismatch", refusalCode: "execution_profile_mismatch", appliedClass: "hardened_container" } as m.ExecutionView;
    const out = html(<ExecutionFacts execution={mismatch} />);
    expect(out).toContain("Reported class (disputed)");
    expect(out).not.toContain("Applied isolation");
    expect(out).not.toContain("Software-attested");
    // NEGATIVE CONTROL: a placement keeps its applied class and the note
    const placed = html(<ExecutionFacts execution={PLACED as m.ExecutionView} />);
    expect(placed).toContain("Applied isolation");
    expect(placed).not.toContain("disputed");
  });
  it("ADR-0190 I4: an OFFERED placement (decided before anything ran) and its linked reports, shown as unsigned", async () => {
    const OFFERED = {
      ...PLACED,
      placement: "offered",
      offerId: U(906),
      imageDigest: `sha256:${H("e")}`,
      runtimeFlagsSha256: H("f"),
      attestation: { placementReportSha256: null, executorAttestationId: U(905), executorReportSha256: H("c") },
    };
    const reports = [
      { id: U(907), placementId: U(901), offerId: U(906), auditId: U(908), outcome: "placed", appliedClass: "user_space_kernel", reportSha256: H("b"), refusalCode: null, endCode: null, createdAt: T },
      { id: U(909), placementId: U(901), offerId: U(906), auditId: U(910), outcome: "cancelled", appliedClass: null, reportSha256: null, refusalCode: null, endCode: "later_gate", createdAt: T },
    ];
    const view = m.readDecisionBom(await v2Response(OFFERED, "mcp_tool", reports), U(1));
    expect(view.execution).toEqual({ ...OFFERED, relaxation: null });
    expect(view.placementReports.map((r) => r.outcome)).toEqual(["placed", "cancelled"]);
    const facts = html(<ExecutionFacts execution={view.execution!} />);
    expect(facts).toContain("Offered to an executor");
    expect(facts).toContain(`sha256:${H("e")}`);
    expect(facts).toContain("no placement report");
    const after = html(<PlacementReports reports={view.placementReports} />);
    expect(after).toContain("not part of the signed Decision BOM");
    expect(after).toContain("Ran: the sandbox&#x27;s report was accepted");
    expect(after).toContain("Cancelled by the gateway before the call used it: a later check refused the call");
    // an offered row with a report hash, or without its offer, is unreadable
    const r = await v2Response(OFFERED);
    for (const bad of [{ ...OFFERED, attestation: { ...OFFERED.attestation, placementReportSha256: H("b") } }, { ...OFFERED, offerId: null }]) {
      const doc = { ...r.document, execution: bad };
      expect(() => m.readDecisionBom({ ...r, document: doc, bom: { ...r.bom, body: JSON.stringify(doc) } }, U(1))).toThrow(m.BomEvidenceError);
    }
  });
  it("ADR-0190 I4 review M2: a policy_unresolved refusal is readable with no requirement and no profile", async () => {
    const unresolved = { ...PLACED, placement: "refused", executor: null, appliedClass: null, attestation: null, refusalCode: "policy_unresolved", requiredClass: null, requiredBy: null, profile: null };
    const view = m.readDecisionBom(await v2Response(unresolved), U(1));
    expect(view.execution).toMatchObject({ placement: "refused", refusalCode: "policy_unresolved", requiredClass: null, profile: null });
  });
  it("an in-gateway call is L0, never a sandbox, with no attestation claimed", () => {
    const out = html(<ExecutionFacts execution={IN_GATEWAY as m.ExecutionView} />);
    expect(out).toContain("Ran in the gateway (L0, not isolated)");
    expect(out.toLowerCase()).not.toContain("sandbox");
    expect(out).not.toContain("Software-attested");
  });
});

describe("ADR-0190 owner decision C (A1): the relaxation's record beside the signed facts", () => {
  const relaxation = { kind: "person_stdio_l2", subjectKind: "interactive_person", relaxationId: U(950), scopeKind: "project", scopeId: U(951) };
  const RELAXED = { ...PLACED, relaxation };
  const record = { id: U(950), scopeKind: "project", scopeId: U(951), setBy: U(952), setAt: "2026-10-09T08:30:00.000Z", clearedBy: null, clearedAt: null, setAuditId: U(953) };
  const shown = (r: m.RelaxationRecordView | undefined) =>
    html(
      <MemoryRouter>
        <RelaxationRecord record={r} names={new Map([[U(952), "Avery Admin"], [U(954), "Drew Reviewer"]])} />
      </MemoryRouter>,
    );

  it("shows its id, who set it, its scope, when, and a link to the audit row that set it", async () => {
    // the fixture passed the shared read-response schema first (v2Response), so this is the live contract
    const view = m.readDecisionBom(await v2Response(RELAXED, "mcp_tool", undefined, { executionRelaxation: record }), U(1));
    expect(view.relaxationRecord).toEqual(record);
    const out = shown(view.relaxationRecord!);
    expect(out).toContain(U(950));
    expect(out).toContain("Avery Admin");
    expect(out).toContain(U(952));
    expect(out).toContain(`Project <code`);
    expect(out).toContain(U(951));
    expect(out).toContain(m.shownTime("2026-10-09T08:30:00.000Z"));
    expect(out).toContain(`href="/admin/audit?id=${U(953)}"`);
    expect(out).toContain("Still in force");
    expect(out).toContain("not part of the signed Decision BOM");
  });
  it("says when the audit row is gone and when the relaxation was cleared since", () => {
    const out = shown({ ...record, setAuditId: null, clearedBy: U(954), clearedAt: "2026-10-12T09:00:00.000Z" } as m.RelaxationRecordView);
    expect(out).toContain("Not found: the audit row may have been pruned");
    expect(out).not.toContain("href=");
    expect(out).toContain("by Drew Reviewer; L3 applies again");
  });
  it("a gateway before A1 reports nothing: the screen says so, and no record is invented", async () => {
    const view = m.readDecisionBom(await v2Response(RELAXED), U(1));
    expect(view.relaxationRecord).toBeUndefined();
    expect(shown(undefined)).toContain("Not reported");
    // NEGATIVE CONTROL: with no relaxation in the facts the record is null, not undefined
    expect(m.readDecisionBom(await v2Response(PLACED, "mcp_tool", undefined, { executionRelaxation: null }), U(1)).relaxationRecord).toBeNull();
  });
  it("a record that is not the row the signed facts name makes the whole BOM unreadable", async () => {
    const s = await sharedBom();
    const r = await v2Response(RELAXED, "mcp_tool", undefined, { executionRelaxation: record });
    for (const [what, bad] of [
      ["another relaxation", { ...record, id: U(960) }],
      ["another scope kind", { ...record, scopeKind: "mcp_server" }],
      ["another scope", { ...record, scopeId: U(961) }],
      ["cleared with no one", { ...record, clearedAt: "2026-10-12T09:00:00.000Z" }],
      ["cleared before it was set", { ...record, clearedBy: U(963), clearedAt: "2000-01-01T00:00:00.000Z" }],
      ["an extra field", { ...record, apiKeyId: U(962) }],
      ["null while the facts name one", null],
    ] as const) {
      expect(() => m.readDecisionBom({ ...r, executionRelaxation: bad }, U(1)), what).toThrow(m.BomEvidenceError);
      // the shared contract refuses the same response (the gateway could not send it)
      expect(s.decisionBomReadResponseSchema.safeParse({ ...r, executionRelaxation: bad }).success, what).toBe(false);
    }
    // a record when the facts name no relaxation
    const plain = await v2Response(PLACED);
    expect(() => m.readDecisionBom({ ...plain, executionRelaxation: record }, U(1))).toThrow(m.BomEvidenceError);
    expect(s.decisionBomReadResponseSchema.safeParse({ ...plain, executionRelaxation: record }).success).toBe(false);
  });

  // ADR-0197 Q3: a relaxation expires; the record shows the expiry in force today and the latest renewal
  const withExpiry = { ...record, expiresAt: "2026-11-08T08:30:00.000Z", renewedBy: null, renewedAt: null };
  const R = (r: object) => r as m.RelaxationRecordView;
  it("ADR-0197 Q3: shows the expiry, and says when it has expired that L3 applies again", async () => {
    const view = m.readDecisionBom(await v2Response(RELAXED, "mcp_tool", undefined, { executionRelaxation: withExpiry }), U(1));
    expect(view.relaxationRecord).toEqual(withExpiry);
    const future = { ...withExpiry, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    const live = shown(R(future));
    expect(live).toContain(m.shownTime(future.expiresAt));
    expect(live).toContain("Still in force");
    const past = shown(R({ ...withExpiry, expiresAt: "2026-10-09T09:30:00.000Z" }));
    expect(past).toContain(`Expired ${m.shownTime("2026-10-09T09:30:00.000Z")}; L3 applies again until an admin renews it`);
    expect(past).not.toContain("Still in force");
    const renewed = shown(R({ ...future, renewedBy: U(954), renewedAt: "2026-10-11T10:00:00.000Z" }));
    expect(renewed).toContain(`renewed ${m.shownTime("2026-10-11T10:00:00.000Z")} by Drew Reviewer`);
    // a gateway before Q3 does not report the expiry: the screen says so
    expect(shown(R(record))).toContain("Not reported: this gateway does not say when the relaxation expires");
  });
  it("ADR-0197 Q3: a record whose expiry or renewal cannot be true is unreadable, as the shared contract says", async () => {
    const s = await sharedBom();
    const r = await v2Response(RELAXED, "mcp_tool", undefined, { executionRelaxation: withExpiry });
    for (const [what, bad] of [
      ["expires before it was set", { ...withExpiry, expiresAt: "2026-10-01T00:00:00.000Z" }],
      ["expires when it was set", { ...withExpiry, expiresAt: withExpiry.setAt }],
      ["renewed by no one", { ...withExpiry, renewedAt: "2026-10-11T10:00:00.000Z" }],
      ["renewed at no time", { ...withExpiry, renewedBy: U(954) }],
      ["renewed before it was set", { ...withExpiry, renewedBy: U(954), renewedAt: "2000-01-01T00:00:00.000Z" }],
      ["an expiry without the renewal fields", { ...record, expiresAt: withExpiry.expiresAt }],
      ["the renewal fields without an expiry", { ...record, renewedBy: null, renewedAt: null }],
    ] as const) {
      expect(() => m.readDecisionBom({ ...r, executionRelaxation: bad }, U(1)), what).toThrow(m.BomEvidenceError);
      expect(s.decisionBomReadResponseSchema.safeParse({ ...r, executionRelaxation: bad }).success, what).toBe(false);
    }
  });
});
