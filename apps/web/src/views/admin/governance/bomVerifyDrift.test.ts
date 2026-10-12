/**
 * ADR-0189 B6 drift guard: the browser's verify reader (`readVerifyReport` and its
 * `brokenRule`) against the shared `bomVerifyResponseSchema`.
 *
 * The SPA mirrors the shared contract (it does not import @regulait/shared at
 * runtime), so this test builds a matrix of reports (every subject, source,
 * finality and receipt version, a set of rule-breaking mutations, and each
 * outcome) and asserts that the browser and the shared schema agree on accept
 * or refuse for every one. A rule added to either side without the other fails
 * here.
 */
import { describe, expect, it } from "vitest";
import * as m from "./bomModel";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const sharedBom = async (): Promise<Any> => import(/* @vite-ignore */ new URL("../../../../../../packages/shared/src/bom/index.ts", import.meta.url).pathname);

const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const H = (c: string) => c.repeat(64);
const T = "2026-10-10T12:00:00.000Z";

const adminCaps = () => ({
  access: "admin", exportRoles: "admins_only", auditorGrant: null, canExport: true, exportUnavailableReason: null,
  canVerify: true, canViewDrift: true, exportRequiresStepUp: false, rateLimitPerMinute: 30,
});

/** the shared contract test's bundle manifest (contract-b4.test.ts `decisionManifest`) */
const manifestFixture = () => ({
  schema: "regulait.export-bundle/3", product: "regulait", installId: null, installIdSource: "absent", exportedAt: T, exportedAtSource: "database",
  exportedByUserId: U(5),
  subject: { kind: "decision-bom", id: U(1), descriptor: { auditId: U(1), bomId: U(21), version: 1, finality: "anchored", bodySha256: H("d"), receiptSeq: 5, aiBomSnapshotId: null, formats: [] } },
  files: [{ path: "README.txt", sha256: H("6") }, { path: "audit/chain.tsv", sha256: H("7") }, { path: "content/decision-bom.json", sha256: H("8") }, { path: "signing-key.pub", sha256: H("9") }],
  audit: { payloadScope: "none", segmentFromSeq: 41, segmentToSeq: 42, segmentRowCount: 2 },
  signingKeyId: "export-2026", signingKeyFingerprint: `sha256:${H("f")}`,
});

type Check = { check: string; status: string; reason: string | null; ref: string | null };
const ok = (check: string, ref: string | null = null): Check => ({ check, status: "valid", reason: null, ref });
const unv = (check: string, reason: string, ref: string | null = null): Check => ({ check, status: "unverifiable", reason, ref });
const bad = (check: string, reason: string, ref: string | null = null): Check => ({ check, status: "invalid", reason, ref });

/** recompute cannotProve from the identity with the shared helper, so a mutation tests one rule rather than the limits list */
function withLimits(s: Any, r: Any): Any {
  const id = r.identity;
  const cannotProve =
    id === null
      ? []
      : s.bomCannotProveFor(
          id.subject === "decision-bom"
            ? { subject: id.subject, source: r.source, receiptPayloadVersion: id.receiptPayloadVersion, recordedFinality: id.recordedFinality, version: id.version, reportedFinality: id.reportedFinality }
            : { subject: id.subject, source: r.source, receiptPayloadVersion: null, recordedFinality: null, version: id.version, reportedFinality: null },
        );
  return { ...r, cannotProve };
}

/** a contract-valid report for one subject and source; the matrix mutates it and sets each outcome */
function verifyBase(s: Any, o: { subject: "decision-bom" | "ai-bom"; source: string; finality?: string; receipt?: "v1" | "v2"; version?: number }): Any {
  const bundle = o.source === "bundle";
  const envelope: Check[] = s.BOM_BUNDLE_REQUIRED_CHECKS.map((c: string) => (bundle ? ok(c, "manifest.json") : unv(c, "not_a_bundle")));
  let identity: Any;
  let checks: Check[];
  let sections: Any[] = [];
  if (o.subject === "decision-bom") {
    const finality = o.finality ?? "anchored";
    const receipt = o.receipt ?? "v2";
    identity = { subject: "decision-bom", auditId: U(1), bomId: U(21), version: 1, recordedFinality: finality, reportedFinality: finality, receiptPayloadVersion: receipt };
    checks = s.DECISION_BOM_REQUIRED_CHECKS.map((c: string) => {
      if (c === "decision_content_binding") return unv(c, "preimage_not_exported");
      if (c === "receipt_facts_binding" && receipt === "v1") return unv(c, "receipt_v1_no_factsHash");
      if (s.BOM_ANCHOR_CHECKS.includes(c) && finality === "chain_signed") return unv(c, "anchor_absent");
      return ok(c);
    });
    sections = s.DECISION_BOM_SECTIONS.map((section: string) => ({
      section, status: "valid", completeness: section === "trace" ? "not_recorded" : "recorded", notRecordedReason: section === "trace" ? "no_bound_row" : null,
    }));
  } else {
    const version = o.version ?? 2;
    identity = { subject: "ai-bom", snapshotId: U(70), subjectKind: "agent", subjectId: U(71), version, serialNumber: `urn:uuid:${U(72)}` };
    checks = [...s.AI_BOM_REQUIRED_CHECKS.map((c: string) => ok(c)), ok("rendering_hashes", "cyclonedx-1.7")];
    if (version > 1) checks.push(bundle ? unv("supersedes", "earlier_snapshot_not_in_bundle") : ok("supersedes"));
  }
  return withLimits(s, {
    trust: "deployment_registry", source: o.source, bodyVersion: o.subject === "decision-bom" ? s.DECISION_BOM_VERSION : s.AI_BOM_VERSION,
    identity, outcome: "valid", checks: [...checks, ...envelope], sections, cannotProve: [], manifest: bundle ? manifestFixture() : null, verifiedAt: T, capabilities: adminCaps(),
  });
}

const expectationFor = (r: Any): m.VerifyExpectation =>
  r.source === "bundle"
    ? { source: "bundle" }
    : r.source === "decision_bom"
      ? { source: "decision_bom", auditId: r.identity?.auditId ?? U(1) }
      : { source: "ai_bom_snapshot", snapshotId: r.identity?.snapshotId ?? U(70) };

describe("drift: readVerifyReport accepts exactly what the shared bomVerifyResponseSchema accepts", () => {
  it("agrees on every report in a matrix of subjects, sources, rule-breaking mutations and outcomes", async () => {
    const s = await sharedBom();
    const bases: Array<[string, Any]> = [];
    for (const source of ["bundle", "decision_bom"]) {
      for (const finality of s.DECISION_BOM_FINALITY_STATES) {
        for (const receipt of ["v1", "v2"] as const) bases.push([`decision ${source} ${finality} ${receipt}`, verifyBase(s, { subject: "decision-bom", source, finality, receipt })]);
      }
    }
    for (const source of ["bundle", "ai_bom_snapshot"]) {
      for (const version of [1, 2]) bases.push([`ai ${source} v${version}`, verifyBase(s, { subject: "ai-bom", source, version })]);
    }
    // every base is contract-valid as built (its outcome is set per case below)
    for (const [name, base] of bases) {
      const valid = ["valid", "unverifiable", "invalid"].some((outcome) => s.bomVerifyResponseSchema.safeParse({ ...base, outcome }).success);
      expect(valid, name).toBe(true);
    }
    const setCheck = (r: Any, check: string, value: Check | null): Any => {
      const rest = r.checks.filter((c: Check) => c.check !== check);
      return { ...r, checks: value ? [...rest, value] : rest };
    };
    const withId = (r: Any, over: Record<string, unknown>): Any => withLimits(s, { ...r, identity: { ...r.identity, ...over } });
    const firstSection = (r: Any, over: Record<string, unknown>): Any => ({ ...r, sections: r.sections.map((x: Any, i: number) => (i === 0 ? { ...x, ...over } : x)) });
    const noIdentity = (r: Any): Any => ({ ...r, identity: null, cannotProve: [] });
    const mutations: Array<[string, (r: Any) => Any]> = [
      ["unchanged", (r) => r],
      ["bodyVersion null", (r) => ({ ...r, bodyVersion: null })],
      ["bodyVersion null, a failing check", (r) => setCheck({ ...r, bodyVersion: null }, "body_version", bad("body_version", "unknown_body_version"))],
      ["bodyVersion of the other subject", (r) => ({ ...r, bodyVersion: r.bodyVersion === s.AI_BOM_VERSION ? s.DECISION_BOM_VERSION : s.AI_BOM_VERSION })],
      ["manifest dropped", (r) => ({ ...r, manifest: null })],
      ["manifest added", (r) => ({ ...r, manifest: manifestFixture() })],
      ["supersedes valid", (r) => setCheck(r, "supersedes", ok("supersedes"))],
      ["supersedes snapshot_not_in_bundle", (r) => setCheck(r, "supersedes", unv("supersedes", "snapshot_not_in_bundle"))],
      ["supersedes earlier_snapshot_not_in_bundle", (r) => setCheck(r, "supersedes", unv("supersedes", "earlier_snapshot_not_in_bundle"))],
      ["supersedes invalid", (r) => setCheck(r, "supersedes", bad("supersedes", "supersedes_mismatch"))],
      ["supersedes removed", (r) => setCheck(r, "supersedes", null)],
      ["facts binding valid", (r) => setCheck(r, "receipt_facts_binding", ok("receipt_facts_binding"))],
      ["facts binding v1 no factsHash", (r) => setCheck(r, "receipt_facts_binding", unv("receipt_facts_binding", "receipt_v1_no_factsHash"))],
      ["facts binding v1 after boundary", (r) => setCheck(r, "receipt_facts_binding", bad("receipt_facts_binding", "v1_receipt_after_boundary"))],
      ["facts binding v2 before boundary", (r) => setCheck(r, "receipt_facts_binding", bad("receipt_facts_binding", "v2_receipt_before_boundary"))],
      ["v2 boundary on another check", (r) => setCheck(r, "receipt_signature", bad("receipt_signature", "v2_receipt_before_boundary"))],
      ["v1 reason on another check", (r) => setCheck(r, "receipt_signature", unv("receipt_signature", "receipt_v1_no_factsHash"))],
      ["anchor_absent on tsa_token", (r) => setCheck(r, "tsa_token", unv("tsa_token", "anchor_absent"))],
      ["anchor_absent on finality", (r) => setCheck(r, "finality", unv("finality", "anchor_absent"))],
      ["anchor record valid", (r) => setCheck(r, "anchor_record", ok("anchor_record"))],
      ["tsa_token no timestamp token", (r) => setCheck(r, "tsa_token", unv("tsa_token", "no_timestamp_token"))],
      ["sections_projection unverifiable", (r) => setCheck(r, "sections_projection", unv("sections_projection", "snapshot_not_in_bundle"))],
      ["sections_projection invalid", (r) => setCheck(r, "sections_projection", bad("sections_projection", "section_mismatch"))],
      ["a section invalid", (r) => (r.sections.length ? firstSection(r, { status: "invalid" }) : r)],
      ["a section invalid and the projection too", (r) => (r.sections.length ? setCheck(firstSection(r, { status: "invalid" }), "sections_projection", bad("sections_projection", "section_mismatch")) : r)],
      ["a recorded section with a reason", (r) => (r.sections.length ? firstSection(r, { notRecordedReason: "pre_facts" }) : r)],
      ["content binding valid", (r) => setCheck(r, "decision_content_binding", ok("decision_content_binding"))],
      ["not_a_bundle on a body check", (r) => setCheck(r, "body_schema", unv("body_schema", "not_a_bundle"))],
      ["bundle_subject valid", (r) => setCheck(r, "bundle_subject", ok("bundle_subject", "manifest.json"))],
      ["bundle_subject not_a_bundle", (r) => setCheck(r, "bundle_subject", unv("bundle_subject", "not_a_bundle"))],
      ["body_signature removed", (r) => setCheck(r, "body_signature", null)],
      ["body_signature invalid", (r) => setCheck(r, "body_signature", bad("body_signature", "signature_mismatch"))],
      ["serial_number added", (r) => setCheck(r, "serial_number", ok("serial_number"))],
      ["finality added", (r) => setCheck(r, "finality", ok("finality"))],
      ["a repeated check without refs", (r) => ({ ...r, checks: [...r.checks, r.checks[0]] })],
      ["receipt version flipped", (r) => (r.identity.subject === "decision-bom" ? withId(r, { receiptPayloadVersion: r.identity.receiptPayloadVersion === "v1" ? "v2" : "v1" }) : r)],
      ["reported lapsed", (r) => (r.identity.subject === "decision-bom" ? withId(r, { reportedFinality: "anchored_lapsed" }) : r)],
      ["reported chain_signed", (r) => (r.identity.subject === "decision-bom" ? withId(r, { reportedFinality: "chain_signed" }) : r)],
      ["recorded chain_signed", (r) => (r.identity.subject === "decision-bom" ? withId(r, { recordedFinality: "chain_signed", reportedFinality: "chain_signed" }) : r)],
      ["ai version 1", (r) => (r.identity.subject === "ai-bom" ? withId(r, { version: 1 }) : r)],
      ["ai version 3", (r) => (r.identity.subject === "ai-bom" ? withId(r, { version: 3 }) : r)],
      ["wrong limits", (r) => ({ ...r, cannotProve: r.cannotProve.slice(1) })],
      ["no identity", noIdentity],
      ["no identity, a failing check", (r) => setCheck(noIdentity(r), "body_schema", bad("body_schema", "schema_violation"))],
      ["no identity, only the failing check", (r) => ({ ...noIdentity(r), sections: [], checks: [bad("bundle_manifest_signature", "bundle_unreadable")] })],
      ["no identity, only an unverifiable check", (r) => ({ ...noIdentity(r), sections: [], checks: [unv("bundle_manifest_signature", "not_a_bundle")] })],
    ];
    let accepted = 0;
    let refused = 0;
    for (const [baseName, base] of bases) {
      for (const [mutName, mutate] of mutations) {
        for (const outcome of m.BOM_VERIFY_OUTCOMES) {
          const r = JSON.parse(JSON.stringify({ ...mutate(base), outcome }));
          const shared = s.bomVerifyResponseSchema.safeParse(r).success;
          let web = true;
          try {
            m.readVerifyReport(r, expectationFor(r));
          } catch (err) {
            if (!(err instanceof m.BomEvidenceError)) throw err;
            web = false;
          }
          expect(web, `${baseName} / ${mutName} / ${outcome}: the shared schema ${shared ? "accepts" : "refuses"} it`).toBe(shared);
          if (shared) accepted++;
          else refused++;
        }
      }
    }
    // both sides are exercised, so a reader that refused (or accepted) everything would not pass
    expect(accepted).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(500);
  });
});
