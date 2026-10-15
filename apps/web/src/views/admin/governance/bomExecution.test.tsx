/**
 * ADR-0190 I8: the Decision BOM v2 `execution` section in the browser. The fixture is a v2 body assembled by the
 * shared assembler (the gateway's own code path) and parsed by the shared read-response schema first, so the
 * reader is only tested on what the live contract accepts; then it is shown, from the signed body only.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as m from "./bomModel";
import { ExecutionFacts } from "./DecisionBomPanel";

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
async function v2Response(execution: Any, objectType = "mcp_tool"): Promise<Any> {
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
  };
  expect(s.decisionBomReadResponseSchema.safeParse(r).success).toBe(true);
  return JSON.parse(JSON.stringify(r));
}
const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe("ADR-0190 I8: a v2 Decision BOM's execution facts in the browser", () => {
  it("reads the execution section from the signed body, with its thirteen sections", async () => {
    const view = m.readDecisionBom(await v2Response(PLACED), U(1));
    expect(view.bodyVersion).toBe("regulait.decision-bom.v2");
    expect(view.execution).toEqual(PLACED);
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
      ["an extra field", lie({ ...PLACED, imageDigest: H("d") })],
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
  it("an in-gateway call is L0, never a sandbox, with no attestation claimed", () => {
    const out = html(<ExecutionFacts execution={IN_GATEWAY as m.ExecutionView} />);
    expect(out).toContain("Ran in the gateway (L0, not isolated)");
    expect(out.toLowerCase()).not.toContain("sandbox");
    expect(out).not.toContain("Software-attested");
  });
});
