/**
 * ADR-0189 slice B4 — the fix round of the ADR-0191 review of #344.
 *
 *  1. The envelope is not malleable: a bundle whose archive differs from the B4.1 archive of its own files in any
 *     byte that no signature covers (a `uname` or `linkname`, padding after a name or between entries, the entry
 *     order, a second gzip member) is `invalid` `bundle_unreadable`, and a JSON entry that is not in its RFC 8785
 *     form (duplicate keys in `receipt-keys.json`) is `bundle_manifest_files` `schema_violation`. Each case has its
 *     control: the same construction without the mutation verifies `valid`.
 *  2. Crafted input never throws: deep JSON, a non-numeric or huge cost, and an internal fault all give a report.
 *  4. The B4.3 v2 actor binding is load-bearing, in the assembler and in the verifier (P25 corrected, N-R13/N-R14).
 */
import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { bomCanonicalBytes, bomSha256, findEmailShapes } from "./contract.js";
import { readBomArchive, writeBomTar } from "./bom-archive.js";
import { assembleDecisionBom, bomDecimalSum, DecisionBomAssemblyError, decisionBomSameContent, isBomCostString, projectDecisionBom, type DecisionBomAssemblyInput } from "./decision-bom-assembly.js";
import { verifyBomBundle, verifyStoredDecisionBom, type BomVerifyReport, type BomVerifyTrust } from "./verify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(path.resolve(here, "../../test-vectors/decision-bom/b4-vectors.json"), "utf8"));
type Entry = { name: string; type: string; text: string };
type Vector = { id: string; trust: any; bundle: { entries?: Entry[]; base?: string; replace?: Record<string, string> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const byId = new Map<string, Vector>([...corpus.positives, ...corpus.negatives].map((v: Vector) => [v.id, v]));
const entriesOf = (id: string): Entry[] => {
  const v = byId.get(id)!;
  if (v.bundle.entries) return v.bundle.entries;
  const r = v.bundle.replace ?? {};
  return byId.get(v.bundle.base!)!.bundle.entries!.map((e) => (e.name in r ? { ...e, text: r[e.name]! } : e));
};
const trustOf = (id: string): BomVerifyTrust => {
  const t = byId.get(id)!.trust;
  return { receipt: { keys: t.receipt.keyring.keys }, receiptV2FromAuditSeq: t.receipt.keyring.receiptV2FromAuditSeq, export: { keys: t.export.keyring }, timestamp: null, verificationTime: t.verificationTime };
};
const filesOf = (entries: Entry[]) => entries.map((e) => ({ path: e.name, body: Buffer.from(e.text, "utf8") }));
const check = (r: BomVerifyReport, name: string) => r.checks.find((c) => c.check === name);

/** recompute a header's checksum after a test edits one of its fields */
function reChecksum(h: Buffer) {
  h.write("        ", 148, 8, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}
/** the tar of P01, with `edit` applied to the raw bytes (headers re-checksummed so only the edited field differs) */
function tarWith(edit: (tar: Buffer) => void): Buffer {
  const tar = writeBomTar(filesOf(entriesOf("P01")));
  edit(tar);
  for (let off = 0; off + 512 <= tar.length; off += 512) {
    const h = tar.subarray(off, off + 512);
    if (h.subarray(257, 263).toString("latin1") === "ustar\0") reChecksum(h);
  }
  return tar;
}
const firstHeaderOf = (tar: Buffer, suffix: string): number => {
  for (let off = 0; off + 512 <= tar.length; off += 512) {
    const h = tar.subarray(off, off + 512);
    if (h.subarray(257, 263).toString("latin1") === "ustar\0" && h.subarray(0, 100).toString("utf8").replace(/\0+$/, "").endsWith(suffix)) return off;
  }
  throw new Error(`no header for ${suffix}`);
};

describe("review item 1: the B4.1 envelope is exactly the B4.1 archive", () => {
  it("control: the B4.1 writer's archive of P01 is the vector's bytes and verifies valid", async () => {
    const tar = writeBomTar(filesOf(entriesOf("P01")));
    expect(createHash("sha256").update(tar).digest("hex")).toBe(byId.get("P01")!.bundle.entries ? (corpus.positives[0].bundle.tarSha256 as string) : "");
    expect((await verifyBomBundle(gzipSync(tar), trustOf("P01"))).outcome).toBe("valid");
  });
  const cases: Array<[string, (tar: Buffer) => void]> = [
    ["an email in a header's uname", (tar) => void tar.write("ops@example.org", firstHeaderOf(tar, "README.txt") + 265, "latin1")],
    ["an email in a header's linkname", (tar) => void tar.write("ops@example.org", firstHeaderOf(tar, "README.txt") + 157, "latin1")],
    ["bytes after the NUL that ends a name", (tar) => void tar.write("ops@example.org", firstHeaderOf(tar, "README.txt") + 80, "latin1")],
    ["bytes in the zero padding between entries", (tar) => void tar.write("ops@example.org", firstHeaderOf(tar, "README.txt") + 512 + 600, "latin1")],
  ];
  for (const [what, edit] of cases) {
    it(`${what} is invalid bundle_unreadable, never valid`, async () => {
      const tar = tarWith(edit);
      expect(tar.equals(writeBomTar(filesOf(entriesOf("P01"))))).toBe(false);
      const r = await verifyBomBundle(gzipSync(tar), trustOf("P01"));
      expect(r.outcome).toBe("invalid");
      expect(check(r, "bundle_manifest_files")).toMatchObject({ status: "invalid", reason: "bundle_unreadable" });
    });
  }
  it("entries out of the B4.1 order are refused (control: the same entries in order are read)", () => {
    const tar = writeBomTar(filesOf(entriesOf("P01")));
    const blocks: Buffer[] = [];
    let off = 0;
    while (off < tar.length - 1024) {
      const size = Number.parseInt(tar.subarray(off + 124, off + 135).toString("latin1"), 8);
      const len = 512 + Math.ceil(size / 512) * 512;
      blocks.push(tar.subarray(off, off + len));
      off += len;
    }
    const swapped = Buffer.concat([blocks[1]!, blocks[0]!, ...blocks.slice(2), Buffer.alloc(1024)]);
    expect(readBomArchive(gzipSync(tar)).ok).toBe(true);
    expect(readBomArchive(gzipSync(swapped))).toMatchObject({ ok: false });
  });
  it("a second gzip member is refused (control: the one member alone is read)", async () => {
    const gz = gzipSync(writeBomTar(filesOf(entriesOf("P01"))));
    expect(readBomArchive(gz).ok).toBe(true);
    // a second member that decompresses to zeros reads as tar padding to a multi-member reader
    const r = await verifyBomBundle(Buffer.concat([gz, gzipSync(Buffer.alloc(512))]), trustOf("P01"));
    expect(check(r, "bundle_manifest_files")).toMatchObject({ status: "invalid", reason: "bundle_unreadable" });
    // a gzip header with a file name (FNAME) carries data no signature covers
    const named = Buffer.concat([gz.subarray(0, 10), Buffer.from("ops@example.org\0", "latin1"), gz.subarray(10)]);
    named[3] = 0x08;
    expect(readBomArchive(named)).toMatchObject({ ok: false });
  });

  /** P01 with `receipt-keys.json` replaced and the manifest re-listed and re-signed by the TEST-ONLY export key */
  async function withReceiptKeys(text: string) {
    const entries = entriesOf("P01").map((e) => ({ ...e }));
    const rk = entries.find((e) => e.name.endsWith("/receipt-keys.json"))!;
    rk.text = text;
    const m = entries.find((e) => e.name.endsWith("/manifest.json"))!;
    const manifest = JSON.parse(m.text) as { files: Array<{ path: string; sha256: string }> };
    manifest.files.find((f) => f.path === "receipt-keys.json")!.sha256 = bomSha256(text);
    m.text = bomCanonicalBytes(manifest);
    const k = corpus.keys.find((x: { keyId: string }) => x.keyId === "TEST-ONLY-CANARY-export-key-1");
    const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), createHash("sha256").update(k.seedText, "utf8").digest()]), format: "der", type: "pkcs8" });
    entries.find((e) => e.name.endsWith("/manifest.json.sig"))!.text = `${edSign(null, Buffer.from(m.text, "utf8"), priv).toString("base64")}\n`;
    return verifyBomBundle(gzipSync(writeBomTar(filesOf(entries))), trustOf("P01"));
  }
  it("a JSON entry with duplicate keys is schema_violation (control: the canonical file, re-signed the same way, is valid)", async () => {
    const original = entriesOf("P01").find((e) => e.name.endsWith("/receipt-keys.json"))!.text;
    expect((await withReceiptKeys(original)).outcome).toBe("valid");
    const duplicated = original.replace('{"keys":[', '{"keys":[],"keys":[');
    expect(JSON.parse(duplicated)).toEqual(JSON.parse(original));
    const r = await withReceiptKeys(duplicated);
    expect(r.outcome).toBe("invalid");
    expect(check(r, "bundle_manifest_files")).toMatchObject({ status: "invalid", reason: "schema_violation" });
  });
});

describe("review item 2: crafted input never throws", () => {
  it("findEmailShapes walks 200 000 levels of nesting without overflowing, in document order", () => {
    let deep: unknown = "ops@example.org";
    for (let i = 0; i < 200_000; i++) deep = { a: deep };
    expect(findEmailShapes(deep)).toHaveLength(1);
    expect(findEmailShapes({ b: "x@y.zz", "k@e.yy": ["z@w.vv"] })).toEqual(["$.b", "${key}", "$.k@e.yy[0]"]);
  });
  it("a bundle whose body is deep JSON is reported invalid, not thrown", async () => {
    const entries = entriesOf("P01").map((e) => (e.name.endsWith("/content/decision-bom.json") ? { ...e, text: `${"[".repeat(100_000)}${"]".repeat(100_000)}` } : e));
    const r = await verifyBomBundle(gzipSync(writeBomTar(filesOf(entries))), trustOf("P01"));
    expect(r.outcome).toBe("invalid");
  });
  it("costs are validated as R23 strings before any arithmetic; a huge exponent or prose is refused fast", () => {
    for (const ok of ["0.000123", "1e-7", "1.5e+21", "0", "-2.5"]) expect(isBomCostString(ok), ok).toBe(true);
    for (const bad of ["abc", "1e9999999", "NaN", "Infinity", "1.0", "0x10", " 1", "", "1".repeat(40)]) expect(isBomCostString(bad), bad).toBe(false);
    const started = Date.now();
    expect(() => bomDecimalSum(["1e9999999", "1"])).toThrow(RangeError);
    expect(() => bomDecimalSum(["abc", "1"])).toThrow(RangeError);
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("a bound usage event with a malformed costUsd is a cost problem in the projection, not an exception", () => {
    const body = JSON.parse(entriesOf("P07").find((e) => e.name.endsWith("/content/decision-bom.json"))!.text);
    const facts = JSON.parse(body.facts.payload);
    facts.rows.find((r: { table: string }) => r.table === "usage_events").projection.costUsd = "1e9999999";
    const p = projectDecisionBom({ bodyVersion: body.v, receipt: JSON.parse(body.receipt.payload), receiptSeq: 1, facts, addenda: [], noFactsReason: "pre_facts", ruleChain: [], chain: body.proof.chain, anchor: null });
    expect(p.problems.map((x) => x.section)).toContain("cost");
    expect(p.cost?.costUsd).toBeNull();
  });
  it("an internal fault is reported invalid with a fixed check (the online route and the offline script both call this)", async () => {
    const broken = { ...trustOf("P01"), receipt: null } as unknown as BomVerifyTrust;
    const body = entriesOf("P01").find((e) => e.name.endsWith("/content/decision-bom.json"))!.text;
    const sig = JSON.parse(entriesOf("P01").find((e) => e.name.endsWith("/content/decision-bom.json.sig"))!.text);
    const row = { body, bodySha256: sig.signedSha256, signature: sig.signature, keyId: sig.keyId, linkedAiBom: null };
    // control: the same stored row under a well-formed trust root is valid
    expect((await verifyStoredDecisionBom(row, trustOf("P01"))).outcome).toBe("valid");
    const stored = await verifyStoredDecisionBom(row, broken);
    expect(stored).toMatchObject({ outcome: "invalid", identity: null });
    expect(stored.checks).toEqual([{ check: "body_schema", status: "invalid", reason: "schema_violation", ref: null }]);
    const bundled = await verifyBomBundle(gzipSync(writeBomTar(filesOf(entriesOf("P01")))), broken);
    expect(bundled.outcome).toBe("invalid");
  });
});

describe("review item 4: the B4.3 v2 actor binding is load-bearing", () => {
  const p25 = JSON.parse(entriesOf("P25").find((e) => e.name.endsWith("/content/decision-bom.json"))!.text);
  const input = (): DecisionBomAssemblyInput => ({
    id: p25.id, auditId: p25.auditId, version: 1, supersedes: null, finality: p25.finality,
    receipt: { receiptSeq: p25.receipt.receiptSeq, payload: JSON.parse(p25.receipt.payload), payloadHash: p25.receipt.payloadHash, signature: p25.receipt.signature, keyId: p25.receipt.keyId },
    facts: { facts: JSON.parse(p25.facts.payload), factsHash: bomSha256(p25.facts.payload) },
    addenda: [], noFactsReason: "pre_facts", ruleChain: p25.decision.ruleChain, chain: p25.proof.chain, anchor: p25.proof.anchor,
  });
  it("P25 now carries a lower-case SPIFFE trust domain and verifies valid (positive control)", async () => {
    expect(JSON.parse(p25.facts.payload).actors.actorChain[0]).toMatch(/^spiffe:\/\/test-only\.example\/TEST-ONLY-CANARY\//);
    // ADR-0190 I8: the assembler now writes v2; the frozen v1 vector is the same version (format change, no new fact)
    const assembled = assembleDecisionBom(input());
    expect(assembled.body.v).toBe("regulait.decision-bom.v2");
    expect(decisionBomSameContent(p25, assembled.body)).toBe(true);
    const r = await verifyBomBundle(gzipSync(writeBomTar(filesOf(entriesOf("P25")))), trustOf("P25"));
    expect(r.outcome).toBe("valid");
  });
  it("the assembler refuses a v2 receipt whose actor differs from the recorded actors", () => {
    const x = input();
    const payload = x.receipt.payload as { actor: { identityId: string } };
    payload.actor.identityId = "c1000000-0000-4000-8000-0000000000ff";
    x.receipt.payloadHash = bomSha256(bomCanonicalBytes(payload));
    let e: unknown = null;
    try {
      assembleDecisionBom(x);
    } catch (err) {
      e = err;
    }
    expect(e).toBeInstanceOf(DecisionBomAssemblyError);
    expect((e as DecisionBomAssemblyError).message).toContain("actor");
  });
  it("N-R13 and N-R14 fail on the actor binding alone: the body is schema-valid, only actors is invalid", async () => {
    for (const id of ["N-R13", "N-R14"]) {
      const r = await verifyBomBundle(gzipSync(writeBomTar(filesOf(entriesOf(id)))), trustOf(id));
      expect(check(r, "body_schema"), id).toMatchObject({ status: "valid" });
      expect(r.checks.filter((c) => c.status === "invalid").map((c) => c.check), id).toEqual(["sections_projection"]);
      expect(r.sections.filter((s) => s.status === "invalid").map((s) => s.section), id).toEqual(["actors"]);
    }
  });
});
