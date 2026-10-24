/**
 * ADR-0189 slice B4 — THE VERIFIER AGAINST EVERY SPECIFICATION-ONLY VECTOR
 * (`packages/shared/test-vectors/decision-bom/b4-vectors.json`, read-only here).
 *
 * Each positive and negative bundle is written as the B4.1 USTAR stream from its
 * entries (a test-local writer, so the directory and symlink entries of N-M16 and
 * N-M18 can be expressed), gzipped, and fed to `verifyBomBundle` as a `bundle`
 * source under the vector's own trust root. The `online` vectors load the export
 * trust root through `bomOnlineExportTrust` (the keyring plus the deployment's own
 * key), exactly as `POST /v1/boms/verify` does. Every report is also checked
 * against the frozen response schema (`bomVerifyResponseSchema`).
 *
 * The finality-emission vectors run through `decisionBomFinalityDetail`, and the
 * verify-response rules through `bomVerifyResponseSchema`. The assembly vectors
 * that need no database (X04 to X09) run through `assembleDecisionBom` here; the
 * others are covered by the gateway's B4 integration test.
 */
import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { bomCanonicalBytes, bomRowDigest, bomSha256, decisionBomBodyV2Schema, decisionFactsSchema } from "./contract.js";
import { bomVerifyResponseSchema, type BomVerifyCheck } from "./contract-b4.js";
import { assembleDecisionBom, bomDecimalSum, DecisionBomAssemblyError, decisionBomSameContent, type DecisionBomAssemblyInput } from "./decision-bom-assembly.js";
import { decisionBomFinalityDetail } from "./finality.js";
import { BomExportKeyringError, bomOnlineExportTrust, verifyBomBundle, verifyStoredAiBom, verifyStoredDecisionBom, type BomVerifyReport, type BomVerifyTrust } from "./verify.js";
import { BomExportRefusal, buildAiBomBundle, buildDecisionBomBundle, type BomBundleEnvelope, type BuiltBomBundle } from "./bom-bundle.js";
import { buildAiBom } from "./ai-bom-builder.js";
import { AI_BOM_INSTALL_SUBJECT_ID } from "./contract.js";
import type { AiBomRecordSet } from "./ai-bom-records.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(path.resolve(here, "../../test-vectors/decision-bom/b4-vectors.json"), "utf8"));
type Entry = { name: string; type: "file" | "directory" | "symlink"; text: string; linkname?: string };
type Vector = { id: string; subject: "decision-bom" | "ai-bom"; trust: any; bundle: { entries?: Entry[]; base?: string; replace?: Record<string, string>; tarSha256: string; tarBytes: number }; expect: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const positives = new Map<string, Vector>(corpus.positives.map((p: Vector) => [p.id, p]));

/** the USTAR writer of B4.1 "Tar order and headers", with the two non-file types the negatives need */
function tarOf(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.text ?? "", "utf8");
    const header = Buffer.alloc(512);
    let [prefix, name] = ["", e.name];
    if (Buffer.byteLength(name) > 99) {
      const at = name.lastIndexOf("/", 154);
      [prefix, name] = [name.slice(0, at), name.slice(at + 1)];
    }
    const size = e.type === "file" ? body.length : 0;
    const put = (off: number, s: string) => header.write(s, off, "latin1");
    header.write(name, 0, "utf8");
    put(100, "0000644\0");
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, `${size.toString(8).padStart(11, "0")}\0`);
    put(136, "00000000000\0");
    put(148, "        ");
    put(156, { file: "0", directory: "5", symlink: "2" }[e.type]);
    if (e.linkname) header.write(e.linkname, 157, "utf8");
    put(257, "ustar\0");
    put(263, "00");
    if (prefix) header.write(prefix, 345, "utf8");
    let sum = 0;
    for (const b of header) sum += b;
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    parts.push(header);
    if (size) parts.push(body, Buffer.alloc((512 - (size % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
function entriesOf(v: Vector): Entry[] {
  if (v.bundle.entries) return v.bundle.entries;
  const replace = v.bundle.replace ?? {};
  return positives.get(v.bundle.base!)!.bundle.entries!.map((e) => (e.name in replace ? { ...e, text: replace[e.name]! } : e));
}

/** the vector's trust root, as the offline script or the online route builds it */
function trustOf(v: Vector): BomVerifyTrust {
  const t = v.trust;
  const receipt = t.receipt.pinnedFingerprints ? { pinnedFingerprints: t.receipt.pinnedFingerprints } : { keys: t.receipt.keyring.keys };
  const boundary = t.receipt.keyring ? t.receipt.keyring.receiptV2FromAuditSeq : t.receipt.receiptV2FromAuditSeq;
  const exportTrust = t.export.pinnedFingerprints
    ? { pinnedFingerprints: t.export.pinnedFingerprints }
    : t.mode === "online"
      ? bomOnlineExportTrust(t.export.keyring.length ? t.export.keyring : null, t.export.ownKey)
      : { keys: t.export.keyring.map((k: { keyId: string; publicKeyPem: string }) => ({ keyId: k.keyId, publicKeyPem: k.publicKeyPem })) };
  return { receipt, receiptV2FromAuditSeq: boundary, export: exportTrust, timestamp: null, verificationTime: t.verificationTime };
}

const CAPABILITIES = { access: "admin", exportRoles: "admins_only", auditorGrant: null, canExport: true, exportUnavailableReason: null, canVerify: true, canViewDrift: true, exportRequiresStepUp: false, rateLimitPerMinute: 30 };
function asResponse(r: BomVerifyReport, source: "bundle" | "decision_bom" | "ai_bom_snapshot" = "bundle") {
  return { trust: "deployment_registry", source, ...r, verifiedAt: "2026-10-11T00:00:00.000Z", capabilities: CAPABILITIES };
}
async function run(v: Vector): Promise<BomVerifyReport> {
  const tar = tarOf(entriesOf(v));
  expect(createHash("sha256").update(tar).digest("hex"), `${v.id} tar bytes`).toBe(v.bundle.tarSha256);
  return verifyBomBundle(gzipSync(tar), trustOf(v));
}
const reported = (r: BomVerifyReport, check: string) => r.checks.filter((c) => c.check === (check as BomVerifyCheck));

describe("ADR-0189 B4 verifier: the positive vectors", () => {
  for (const v of corpus.positives as Vector[]) {
    it(`${v.id} verifies ${v.expect.outcome}, with exactly the expected checks`, async () => {
      const r = await run(v);
      const why = JSON.stringify(r.checks.filter((c) => c.status !== "valid"));
      expect(r.outcome, why).toBe(v.expect.outcome);
      const listed = Object.entries(v.expect.checks as Record<string, "absent" | { result: string; reason?: string; ref?: string }>);
      for (const [name, want] of listed) {
        const got = reported(r, name);
        if (want === "absent") expect(got, `${v.id} ${name}`).toEqual([]);
        else expect(got.map((c) => ({ result: c.status, ...(c.reason ? { reason: c.reason } : {}), ...(want.ref ? { ref: c.ref } : {}) })), `${v.id} ${name}`).toEqual([want]);
      }
      // nothing reported beyond what the vector lists
      const names = new Set(listed.filter(([, w]) => w !== "absent").map(([n]) => n));
      expect(r.checks.map((c) => c.check).filter((c) => !names.has(c)), `${v.id} unexpected checks`).toEqual([]);
      expect(r.cannotProve).toEqual(v.expect.cannotProve);
      if (v.subject === "decision-bom") {
        expect(r.identity).toMatchObject({ recordedFinality: v.expect.recordedFinality, reportedFinality: v.expect.reportedFinality, receiptPayloadVersion: v.expect.receiptPayloadVersion });
        const body = JSON.parse(entriesOf(v).find((e) => e.name.endsWith("/content/decision-bom.json"))!.text);
        expect(r.sections.every((s) => s.status === "valid")).toBe(true);
        for (const s of r.sections) {
          expect({ status: s.completeness, ...(s.notRecordedReason ? { reason: s.notRecordedReason } : {}) }, s.section).toEqual(body.completeness[s.section]);
        }
      } else {
        expect(r.identity).toEqual(v.expect.identity);
        expect(r.sections).toEqual([]);
      }
      expect(r.manifest).not.toBeNull();
      const shaped = bomVerifyResponseSchema.safeParse(asResponse(r));
      expect(shaped.success, JSON.stringify(shaped.error?.issues)).toBe(true);
    });
  }
});

describe("ADR-0189 B4 verifier: the negative vectors", () => {
  for (const v of corpus.negatives as Vector[]) {
    it(`${v.id} is ${v.expect.outcome === "not_run" ? "refused at keyring load" : "invalid, under the named checks"}`, async () => {
      if (v.expect.outcome === "not_run") {
        expect(() => trustOf(v)).toThrow(BomExportKeyringError);
        return;
      }
      const r = await run(v);
      expect(r.outcome).toBe("invalid");
      for (const [name, want] of Object.entries(v.expect.checks as Record<string, { result: string; reason: string }>)) {
        const got = reported(r, name);
        expect(got.some((c) => c.status === want.result && c.reason === want.reason), `${v.id} ${name}: ${JSON.stringify(r.checks.filter((c) => c.status !== "valid"))}`).toBe(true);
      }
      for (const [section, status] of Object.entries((v.expect.sections ?? {}) as Record<string, string>)) {
        expect(r.sections.find((s) => s.section === section)?.status, `${v.id} section ${section}`).toBe(status);
      }
      const shaped = bomVerifyResponseSchema.safeParse(asResponse(r));
      expect(shaped.success, JSON.stringify(shaped.error?.issues)).toBe(true);
    });
  }
});

describe("ADR-0189 B4.5: finality as emitted (the finalityEmission vectors)", () => {
  for (const e of corpus.finalityEmission.vectors) {
    it(`${e.id} ${e.title}`, () => {
      const i = e.input;
      // the vectors give the end of the retention; one day of retention ending there is the same input
      const retentionEnd = i.retentionEnd === null ? null : new Date(i.retentionEnd);
      const out = decisionBomFinalityDetail({
        anchor: i.anchor === null ? null : { status: i.anchor.status, tamperResistant: i.anchor.tamperResistant, tsaGranted: i.anchor.timestampGranted, retainUntil: i.anchor.retainUntil === null ? null : new Date(i.anchor.retainUntil) },
        receiptSigned: true,
        timestampMode: i.timestampMode,
        decisionAt: retentionEnd ? new Date(retentionEnd.getTime() - 86_400_000) : new Date(i.freezeAt),
        retainedDays: retentionEnd ? 1 : null,
        now: new Date(i.freezeAt),
        setting: i.floor,
        finiteLock: i.finiteLockFinality,
      });
      const got = out.freeze ? (out.shortOf ? { freeze: out.state, shortOf: out.shortOf } : { freeze: out.state }) : { pending: out.reason };
      expect(got).toEqual(e.expect);
    });
  }
});

describe("ADR-0189 B4.4 and B4.8: the verify-response rules", () => {
  // the vectors' response shorthand, mapped onto the frozen response schema
  for (const q of corpus.responseRules) {
    it(`${q.id} ${q.conforms ? "conforms" : "does not conform"}`, () => {
      const r = q.response;
      const ai = r.subject === "ai_bom";
      const source = r.source === "bundle" ? "bundle" : r.storedKind === "ai_bom_snapshot" || r.storedKind === "decision_bom" ? r.storedKind : ai ? "ai_bom_snapshot" : "decision_bom";
      const identity = ai
        ? { subject: "ai-bom", snapshotId: "ab000000-0000-4000-8000-000000000001", subjectKind: "install", subjectId: "00000000-0000-0000-0000-000000000000", version: r.version ?? 1, serialNumber: "urn:uuid:589e3cf8-69ef-8a44-acc8-a8c6bda58790" }
        : { subject: "decision-bom", auditId: "a0000000-0000-4000-8000-000000000042", bomId: "b0000000-0000-4000-8000-000000000001", version: 1, recordedFinality: r.finality, reportedFinality: r.finality, receiptPayloadVersion: r.receiptPayloadVersion };
      const SECTIONS = ["decision", "receipt", "principal", "actors", "action", "policy", "model", "approval", "outcome", "cost", "trace", "proof"];
      const sections = ai ? [] : SECTIONS.map((s) => ({ section: s, status: r.sections?.[s] ?? "valid", completeness: "recorded", notRecordedReason: null }));
      const response = {
        trust: "deployment_registry",
        source,
        bodyVersion: ai ? "regulait.ai-bom.v1" : "regulait.decision-bom.v1",
        identity,
        outcome: r.outcome,
        checks: r.checks.map((c: { name: string; result: string; reason?: string; ref?: string }) => ({ check: c.name, status: c.result, reason: c.reason ?? null, ref: c.ref ?? null })),
        sections,
        cannotProve: r.cannotProve,
        manifest: null,
        verifiedAt: "2026-10-11T00:00:00.000Z",
        capabilities: CAPABILITIES,
      };
      // the schema's own manifest rule (a manifest exactly for a readable bundle) is not what these vectors test
      const parsed = bomVerifyResponseSchema.safeParse(response);
      const issues = parsed.success ? [] : parsed.error.issues.filter((i) => !i.message.startsWith("a manifest exactly"));
      expect(issues.length === 0, JSON.stringify(issues)).toBe(q.conforms);
    });
  }
});

// ---------------------------------------------------------------------------
// the assembly refusals that need no database (X04 to X09)
// ---------------------------------------------------------------------------

describe("ADR-0189 B4.4: assembly refusals (the database-free assembly vectors)", () => {
  const p01 = positives.get("P01")!;
  const bodyOf = (v: Vector) => JSON.parse(entriesOf(v).find((e) => e.name.endsWith("/content/decision-bom.json"))!.text);
  const p09 = bodyOf(positives.get("P09")!);
  const base = (body: any): DecisionBomAssemblyInput => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const facts = body.facts.payload === null ? null : JSON.parse(body.facts.payload);
    return {
      id: body.id, auditId: body.auditId, version: body.version, supersedes: body.supersedes, finality: body.finality,
      receipt: { receiptSeq: body.receipt.receiptSeq, payload: JSON.parse(body.receipt.payload), payloadHash: body.receipt.payloadHash, signature: body.receipt.signature, keyId: body.receipt.keyId },
      facts: facts && { facts, factsHash: bomSha256(body.facts.payload) },
      addenda: body.facts.addenda.map((a: { n: number; prevHash: string; payload: string; signature: string; keyId: string }) => ({ n: a.n, prevHash: a.prevHash, facts: JSON.parse(a.payload), factsHash: bomSha256(a.payload), signature: a.signature, keyId: a.keyId })),
      noFactsReason: "pre_facts", ruleChain: body.decision.ruleChain, chain: body.proof.chain, anchor: body.proof.anchor,
    };
  };
  /** recompute the stored hashes and the addendum chain after a fixture edit, so only the edited rule breaks */
  const rechain = (input: DecisionBomAssemblyInput) => {
    input.facts!.factsHash = bomSha256(bomCanonicalBytes(input.facts!.facts));
    let prev = input.facts!.factsHash;
    for (const a of input.addenda) {
      (a.facts as { prev: string }).prev = prev;
      a.prevHash = prev;
      a.factsHash = bomSha256(bomCanonicalBytes(a.facts));
      prev = a.factsHash;
    }
  };
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof DecisionBomAssemblyError) return { status: e.status, code: e.code };
      throw e;
    }
    return null;
  };

  it("the assembler rebuilds every positive Decision BOM body as the same version (ADR-0190 I8: v1 vectors, v2 assembly, no new fact)", () => {
    for (const v of (corpus.positives as Vector[]).filter((x) => x.subject === "decision-bom")) {
      const text = entriesOf(v).find((e) => e.name.endsWith("/content/decision-bom.json"))!.text;
      const body = JSON.parse(text);
      const reason = body.completeness.action?.reason === "capture_off" ? "capture_off" : "pre_facts";
      const assembled = assembleDecisionBom({ ...base(body), noFactsReason: reason });
      expect(assembled.body.v, v.id).toBe("regulait.decision-bom.v2");
      expect(decisionBomBodyV2Schema.safeParse(assembled.body).success, v.id).toBe(true);
      // the v1 vector's facts predate execution facts: v2 says so, and records nothing else new
      expect((assembled.body.completeness as Record<string, unknown>).execution, v.id).toEqual(body.facts.payload === null ? { status: "not_recorded", reason } : { status: "not_recorded", reason: "pre_isolation" });
      expect(decisionBomSameContent(body, assembled.body), v.id).toBe(true);
    }
  });
  it("X04 a usage event bound in facts.rows and again in addendum 1: 500 bom_integrity_failure", () => {
    const input = base(p09);
    const add1 = input.addenda[0]!.facts as { rows: Array<{ table: string }>; prev: string };
    const usage = add1.rows.find((r) => r.table === "usage_events")!;
    const facts = input.facts!.facts as { rows: unknown[] };
    facts.rows = [...facts.rows, usage].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    rechain(input);
    expect(refusal(() => assembleDecisionBom(input))).toEqual({ status: 500, code: "bom_integrity_failure" });
  });
  it("X05 a bound row whose digest does not match its projection: 500 bom_integrity_failure", () => {
    const input = base(bodyOf(p01));
    const facts = input.facts!.facts as { rows: Array<{ digest: string }> };
    facts.rows[0]!.digest = "0".repeat(64);
    input.facts!.factsHash = bomSha256(bomCanonicalBytes(facts));
    expect(refusal(() => assembleDecisionBom(input))).toEqual({ status: 500, code: "bom_integrity_failure" });
  });
  it("X06 addendum 2's prev_hash is not addendum 1's facts_hash: 500 bom_integrity_failure", () => {
    const input = base(p09);
    input.addenda[1]!.prevHash = "1".repeat(64);
    expect(refusal(() => assembleDecisionBom(input))).toEqual({ status: 500, code: "bom_integrity_failure" });
  });
  it("X07 facts.actors.sponsorUserId differs from the receipt's decision.userId: 500 bom_integrity_failure", () => {
    const input = base(bodyOf(p01));
    const facts = input.facts!.facts as { actors: { sponsorUserId: string } };
    facts.actors.sponsorUserId = "c0000000-0000-4000-8000-000000000009";
    expect(decisionFactsSchema.safeParse(facts).success).toBe(true);
    input.facts!.factsHash = bomSha256(bomCanonicalBytes(facts));
    expect(refusal(() => assembleDecisionBom(input))).toEqual({ status: 500, code: "bom_integrity_failure" });
  });
  it("X08 a rule chain of 65 entries: 422 bom_decision_not_eligible (64 is admitted)", () => {
    const input = base(bodyOf(p01));
    expect(refusal(() => assembleDecisionBom({ ...input, ruleChain: Array.from({ length: 64 }, (_, i) => `r${i}`) }))).toBeNull();
    expect(refusal(() => assembleDecisionBom({ ...input, ruleChain: Array.from({ length: 65 }, (_, i) => `r${i}`) }))).toEqual({ status: 422, code: "bom_decision_not_eligible" });
  });
  it("a stored receipt whose hash does not re-check is an integrity failure, never assembled", () => {
    const input = base(bodyOf(p01));
    expect(refusal(() => assembleDecisionBom({ ...input, receipt: { ...input.receipt, payloadHash: "2".repeat(64) } }))).toEqual({ status: 500, code: "bom_integrity_failure" });
  });
  it("bomRowDigest is the digest the facts carry (G1)", () => {
    const facts = JSON.parse(bodyOf(p01).facts.payload);
    for (const r of facts.rows) expect(bomRowDigest(r.table, r.projection)).toBe(r.digest);
  });
});

describe("ADR-0189 B4.7-3: the exact decimal cost sum", () => {
  it("is exact, in plain notation, with no trailing fractional zeros", () => {
    expect(bomDecimalSum(["0.1", "0.2", "1e-7"])).toBe("0.3000001");
    expect(bomDecimalSum(["0.25", "0.75"])).toBe("1");
    expect(bomDecimalSum(["1.5e-10", "2e+21"])).toBe("2000000000000000000000.00000000015");
    expect(String(0.1 + 0.2 + 1e-7)).not.toBe("0.3000001");
  });
});

// ---------------------------------------------------------------------------
// the bundle builder reproduces the specification's bundles byte for byte
// ---------------------------------------------------------------------------

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** a TEST-ONLY CANARY key, derived from its published seed text (no private key is stored anywhere) */
function canary(keyId: string) {
  const k = corpus.keys.find((x: { keyId: string }) => x.keyId === keyId);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, createHash("sha256").update(k.seedText, "utf8").digest()]), format: "der", type: "pkcs8" });
  return { keyId, publicKeyPem: k.publicKeyPem as string, fingerprint: k.fingerprint as string, sign: (b: Buffer) => edSign(null, b, privateKey) };
}
const fileOf = (v: Vector, p: string) => entriesOf(v).find((e) => e.name.endsWith(`/${p}`))?.text;
function envOf(v: Vector, exportKeyId = "TEST-ONLY-CANARY-export-key-1"): BomBundleEnvelope {
  const manifest = JSON.parse(fileOf(v, "manifest.json")!);
  const rk = JSON.parse(fileOf(v, "receipt-keys.json")!).keys as Array<{ keyId: string; jwk: { kty: "OKP"; crv: "Ed25519"; x: string } }>;
  return { installId: manifest.installId, installIdSource: manifest.installIdSource, exportedAt: manifest.exportedAt, exportedByUserId: manifest.exportedByUserId, exportKey: canary(exportKeyId), receiptKeys: rk };
}
const tarOfBuilt = (b: BuiltBomBundle) => tarOf(b.files.map((f) => ({ name: f.path, type: "file" as const, text: f.body.toString("utf8") })));
const rowOf = (body: string, sigText: string) => {
  const sig = JSON.parse(sigText);
  return { body, bodySha256: sig.signedSha256 as string, signature: sig.signature as string, keyId: sig.keyId as string };
};
const decisionRowOf = (v: Vector) => {
  const body = fileOf(v, "content/decision-bom.json")!;
  const b = JSON.parse(body);
  return { ...rowOf(body, fileOf(v, "content/decision-bom.json.sig")!), id: b.id as string, auditId: b.auditId as string, version: b.version as number, finality: b.finality };
};

describe("ADR-0189 B4.9 G12: the AI BOM worked example is what buildAiBom writes (the build requirement)", () => {
  /** the fenced `b4-ai-example:<name>` blocks of the ADR (a line scan) */
  const adr = readFileSync(path.resolve(here, "../../../../internal/decisions/0189-batch6-decision-bom-ai-bom.md"), "utf8").split("\n");
  const block = (name: string) => {
    const i = adr.indexOf(`\`\`\`text b4-ai-example:${name}`);
    expect(i, name).toBeGreaterThanOrEqual(0);
    const out: string[] = [];
    for (let j = i + 1; adr[j] !== "```"; j++) out.push(adr[j]!);
    return out.join("\n");
  };
  const install = { kind: "install" as const, id: AI_BOM_INSTALL_SUBJECT_ID };
  const empty = (): AiBomRecordSet => ({
    subject: install, install: { installId: null }, useCases: [], agents: [], customProviders: [], modelCards: [], modelCardApprovals: [], modelCardEvidence: [],
    evalRuns: [], evalDatasets: [], trainingDatasets: [], trainingJobs: [], trainingArtifacts: [], modelArtifacts: [], artifactScans: [], engineRuns: [], engines: [],
    promptTags: [], configVersions: [], mcpServers: [], mcpTools: [], connectors: [], grants: [], builderAgents: [], builderSkills: [], memoryStores: [],
  });
  /**
   * KNOWN DRIFT, reported and not changed here: the ADR's blocks were written from `buildAiBom` on main @ b19a6dc,
   * before slice B9 (R51) added `records.spdxFields` to every native body. Today's builder writes the same bytes
   * plus `"spdxFields":[]` in `records`; the renderings are byte-identical. The vectors A01 to A03 are self-consistent
   * signed bundles and verify either way. This pins that the ONLY difference is that one key.
   */
  // B9's spdxFields and ADR-0190 I8's execution lists postdate the worked example; empty, they are its only difference
  const withoutSpdxFields = (bytes: string) => {
    const body = JSON.parse(bytes) as { records: Record<string, unknown> };
    for (const list of ["spdxFields", "executionProfiles", "executors", "executionAssignments"]) {
      expect(body.records[list], list).toEqual([]);
      delete body.records[list];
    }
    return bomCanonicalBytes(body);
  };
  it("rebuilds A01's body and CycloneDX 1.7 rendering, and A03's body, byte for byte (apart from B9's spdxFields)", () => {
    const meta = { subjectKind: "install" as const, subjectId: AI_BOM_INSTALL_SUBJECT_ID, trigger: "on_demand" as const };
    const v1 = buildAiBom(empty(), { ...meta, id: "ab000000-0000-4000-8000-000000000001", version: 1, supersedes: null, createdAt: "2026-10-10T11:00:00.000Z" }, { cyclonedxVersions: ["1.7"] });
    expect(v1.bodyBytes).not.toBe(block("v1/content/ai-bom.json"));
    expect(withoutSpdxFields(v1.bodyBytes)).toBe(block("v1/content/ai-bom.json"));
    expect(v1.renderings.find((r) => r.format === "cyclonedx-1.7")!.bytes).toBe(block("v1/content/ai-bom.cyclonedx-1.7.json"));
    const v2 = buildAiBom(empty(), { ...meta, id: "ab000000-0000-4000-8000-000000000002", version: 2, supersedes: "ab000000-0000-4000-8000-000000000001", createdAt: "2026-10-10T11:30:00.000Z" }, { cyclonedxVersions: ["1.7"] });
    expect(withoutSpdxFields(v2.bodyBytes)).toBe(block("v2/content/ai-bom.json"));
  });
});

describe("ADR-0189 B4.1: the bundle builder", () => {
  it("rebuilds every Decision BOM positive's archive byte for byte from its frozen rows", () => {
    for (const v of (corpus.positives as Vector[]).filter((x) => x.subject === "decision-bom")) {
      const manifest = JSON.parse(fileOf(v, "manifest.json")!);
      const linked = fileOf(v, "content/ai-bom.json");
      const built = buildDecisionBomBundle(
        { row: decisionRowOf(v), linkedAiBom: linked ? rowOf(linked, fileOf(v, "content/ai-bom.json.sig")!) : null, renderings: [], readme: fileOf(v, "README.txt")! },
        envOf(v, manifest.signingKeyId),
      );
      expect(createHash("sha256").update(tarOfBuilt(built)).digest("hex"), v.id).toBe(v.bundle.tarSha256);
    }
  });
  it("rebuilds the AI BOM positives (A01 native, A02 cyclonedx-1.7, A03 native) byte for byte", () => {
    for (const v of (corpus.positives as Vector[]).filter((x) => x.subject === "ai-bom")) {
      const body = fileOf(v, "content/ai-bom.json")!;
      const cdx = fileOf(v, "content/ai-bom.cyclonedx-1.7.json");
      const built = buildAiBomBundle(
        {
          row: rowOf(body, fileOf(v, "content/ai-bom.json.sig")!),
          renderings: cdx ? [{ format: "cyclonedx-1.7", bytes: cdx }] : [],
          request: { kind: "format", format: cdx ? "cyclonedx-1.7" : "native" },
          readme: fileOf(v, "README.txt")!,
        },
        envOf(v),
      );
      expect(createHash("sha256").update(tarOfBuilt(built)).digest("hex"), v.id).toBe(v.bundle.tarSha256);
    }
  });
  it("its default README bundle verifies valid under the vector's trust root", async () => {
    const v = positives.get("P01")!;
    const built = buildDecisionBomBundle({ row: decisionRowOf(v), linkedAiBom: null, renderings: [] }, envOf(v));
    const r = await verifyBomBundle(gzipSync(tarOfBuilt(built)), trustOf(v));
    expect(r.outcome).toBe("valid");
  });
  it("X10: an email-shaped installId refuses the export, naming manifest.json and the path, never the value", () => {
    const v = positives.get("P01")!;
    const env = { ...envOf(v), installId: "ops@example.org", installIdSource: "operator" as const };
    let refusal: BomExportRefusal | null = null;
    try {
      buildDecisionBomBundle({ row: decisionRowOf(v), linkedAiBom: null, renderings: [] }, env);
    } catch (e) {
      if (e instanceof BomExportRefusal) refusal = e;
      else throw e;
    }
    expect(refusal && { file: refusal.file, path: refusal.path }).toEqual({ file: "manifest.json", path: "$.installId" });
    expect(refusal!.message).not.toContain("ops@example.org");
  });
});


describe("ADR-0189 B8 review H1: the receipt v2 boundary is never defaulted", () => {
  const vec = (id: string): Vector => [...corpus.positives, ...corpus.negatives].find((x: Vector) => x.id === id);
  const bytes = (id: string) => gzipSync(tarOf(entriesOf(vec(id))));
  it("an ABSENT boundary is refused at every entry point (absent is not null)", () => {
    const { receiptV2FromAuditSeq: _absent, ...noBoundary } = trustOf(vec("N-R12"));
    const t = noBoundary as unknown as BomVerifyTrust;
    expect(() => verifyBomBundle(bytes("N-R12"), t)).toThrow(TypeError);
    expect(() => verifyStoredDecisionBom({} as never, t)).toThrow(TypeError);
    expect(() => verifyStoredAiBom({} as never, t)).toThrow(TypeError);
  });
  it("a boundary that is not null or a positive audit seq is refused", () => {
    for (const bad of [0, -1, 1.5, "42", Number.NaN, undefined]) {
      expect(() => verifyBomBundle(bytes("A02"), { ...trustOf(vec("A02")), receiptV2FromAuditSeq: bad as never }), String(bad)).toThrow(TypeError);
    }
  });
  it("an explicit null is honoured (no cutover recorded): an AI BOM verifies", async () => {
    expect((await verifyBomBundle(bytes("A02"), { ...trustOf(vec("A02")), receiptV2FromAuditSeq: null })).outcome).toBe("valid");
  });
  it("a value is enforced: N-R12's v1 receipt at boundary 42 is invalid v1_receipt_after_boundary", async () => {
    const r = await verifyBomBundle(bytes("N-R12"), trustOf(vec("N-R12")));
    expect(r.outcome).toBe("invalid");
    expect(r.checks).toContainEqual(expect.objectContaining({ check: "receipt_facts_binding", status: "invalid", reason: "v1_receipt_after_boundary" }));
  });
});
