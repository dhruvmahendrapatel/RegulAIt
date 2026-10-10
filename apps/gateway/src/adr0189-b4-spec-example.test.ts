/**
 * ADR-0189 "B4 bundle and signature specification (pre-build, 2026-10-10)" — the
 * anti-drift test for §B4.6's worked example.
 *
 * It rebuilds the example (`testing/bom-b4-spec-example.ts`) and checks:
 *  - every bundle file equals, byte for byte, the fenced `b4-example:<path>`
 *    block in the ADR, and the ADR's SHA256SUMS and tar digest blocks;
 *  - the frozen B1/#307 schemas accept the body, facts, receipt and manifest;
 *  - all three signatures verify with the PUBLIC keys only (the receipt key from
 *    `receipt-keys.json`'s JWK, the export key from `signing-key.pub`), and the
 *    fingerprints follow ADR-0116's DER SubjectPublicKeyInfo rule;
 *  - the receipt binds the facts (`factsHash`) and the chain row, the chain row's
 *    `rowHash` recomputes, and every section re-derives from the facts payload
 *    and the receipt payload with this file's OWN projector (§B4.4), not B4's;
 *  - the USTAR headers carry the pinned mode, uid, gid and mtime (§B4.1), and
 *    the ADR-0116 writer reproduces the tar from the file list.
 *
 * The USTAR reader below is test-local on purpose: the assertions are about raw
 * header fields, which a tar library abstracts away (tar-stream is in the
 * lockfile only transitively and is not admitted for this; ADR-0176 check in
 * the commit). Pure: no database, no network, no clock.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bomCanonicalBytes,
  decisionBomBodySchema,
  decisionFactsSchema,
  DECISION_BOM_SECTIONS,
  exportBundleV3ManifestSchema,
  findEmailShapes,
  hasEmailShape,
  isDecisionReceiptPayload,
} from "@regulait/shared";
import { buildTarGz, publicKeyFingerprint } from "./export-bundle.js";
import {
  BUNDLE_ROOT,
  buildB4SpecExample,
  CANARY_EXPORT_KEY_ID,
  CANARY_EXPORT_SEED_TEXT,
  CANARY_RECEIPT_KEY_ID,
  CANARY_RECEIPT_SEED_TEXT,
  SPKI_ED25519_PREFIX,
} from "./testing/bom-b4-spec-example.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ADR_PATH = path.resolve(here, "../../../docs/decisions/0189-batch6-decision-bom-ai-bom.md");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** the fenced blocks opened by a line "```text b4-example:<name>" (a line scan, no regex over the document) */
function adrBlocks(): Map<string, string> {
  const lines = readFileSync(ADR_PATH, "utf8").split("\n");
  const out = new Map<string, string>();
  const opener = "```text b4-example:";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith(opener)) continue;
    const name = line.slice(opener.length).trim();
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j] !== "```") body.push(lines[j++]!);
    if (j >= lines.length) throw new Error(`unterminated b4-example block ${name}`);
    if (out.has(name)) throw new Error(`duplicate b4-example block ${name}`);
    out.set(name, body.join("\n"));
    i = j;
  }
  return out;
}

/** a test-local USTAR reader: the raw header fields of every entry */
function readUstar(tar: Buffer) {
  const field = (h: Buffer, off: number, len: number) => h.subarray(off, off + len).toString("latin1");
  const entries: Array<{ path: string; header: Buffer; body: Buffer }> = [];
  let off = 0;
  for (;;) {
    const h = tar.subarray(off, off + 512);
    if (h.length < 512) throw new Error("truncated tar");
    if (h.every((b) => b === 0)) break;
    const cstr = (o: number, l: number) => { const s = field(h, o, l); const z = s.indexOf("\0"); return z === -1 ? s : s.slice(0, z); };
    const prefix = cstr(345, 155);
    const name = cstr(0, 100);
    const size = parseInt(cstr(124, 12), 8);
    entries.push({ path: prefix ? `${prefix}/${name}` : name, header: Buffer.from(h), body: tar.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return { entries, endOffset: off };
}

/**
 * §B4.4 — the facts-to-section projection, written here from the ADR text
 * alone (covers the shapes the example uses; B4's projector is separate).
 */
function projectSections(factsPayload: string | null, addenda: Array<{ payload: string }>, receiptPayload: Record<string, any>, ruleChain: string[]) {
  const facts = factsPayload === null ? null : (JSON.parse(factsPayload) as Record<string, any>);
  const adds = addenda.map((a) => JSON.parse(a.payload) as Record<string, any>);
  const rows: Array<Record<string, any>> = [...(facts?.rows ?? []), ...adds.flatMap((a) => a.rows)];
  const byKey = (a: Record<string, any>, b: Record<string, any>) => (a.table + "\u0000" + a.id < b.table + "\u0000" + b.id ? -1 : a.table + "\u0000" + a.id > b.table + "\u0000" + b.id ? 1 : 0);
  const r = receiptPayload.decision;
  const missing = facts === null ? { status: "not_recorded", reason: receiptPayload.factsStatus === "capture_off" ? "capture_off" : "pre_facts" } : null;
  const fromFacts = (v: unknown, reason: string) => (missing ? missing : v === null ? { status: "not_recorded", reason } : { status: "recorded" });
  const approvals = rows.filter((x) => x.table === "approvals" || x.table === "approval_decisions").sort(byKey);
  const usage = rows.filter((x) => x.table === "usage_events").sort(byKey);
  const spans = rows.filter((x) => x.table === "trace_spans").sort(byKey);
  if (usage.length > 1) throw new Error("this test projector covers zero or one usage event");
  const sections = {
    decision: { auditSeq: receiptPayload.audit.seq, at: r.at, objectType: r.objectType, objectId: r.objectId, serverId: r.serverId, toolName: r.toolName, effect: r.effect, ruleId: r.ruleId, ruleChain },
    principal: { sponsorUserId: r.userId },
    actors: facts?.actors ?? null,
    action: facts?.action ?? null,
    policy: facts?.policy ?? null,
    model: facts?.model ?? null,
    approval: approvals.length ? approvals : null,
    outcome: facts?.outcome ?? null,
    cost: usage.length
      ? { usageEventIds: usage.map((u) => u.id), inputTokens: usage.reduce((s, u) => s + u.projection.inputTokens, 0), outputTokens: usage.reduce((s, u) => s + u.projection.outputTokens, 0), costUsd: usage[0]!.projection.costUsd, costSource: "usage_events.cost_usd" }
      : null,
    trace: spans.length ? { traceIds: [...new Set(spans.map((s) => s.projection.traceId as string))].sort(), spanIds: spans.map((s) => s.id as string) } : null,
  };
  const completeness = {
    decision: { status: "recorded" },
    receipt: { status: "recorded" },
    principal: { status: "recorded" },
    actors: missing ?? (facts!.actors === null ? { status: "not_recorded", reason: "pre_identity" } : { status: "recorded" }),
    action: fromFacts(facts?.action ?? null, "not_captured_by_path"),
    policy: fromFacts(facts?.policy ?? null, "not_captured_by_path"),
    model: fromFacts(facts?.model ?? null, "not_captured_by_path"),
    approval: missing ?? (approvals.length ? { status: "recorded" } : { status: "not_recorded", reason: "no_bound_row" }),
    outcome: missing ?? { status: "recorded" },
    cost: missing ?? (usage.length ? { status: "recorded" } : { status: "not_recorded", reason: "no_bound_row" }),
    trace: missing ?? (spans.length ? { status: "recorded" } : { status: "not_recorded", reason: "no_bound_row" }),
  };
  return { sections, completeness };
}

const ex = buildB4SpecExample();
const file = (p: string) => {
  const b = ex.files.get(p);
  if (!b) throw new Error(`no ${p}`);
  return b;
};

describe("ADR-0189 §B4.6: the worked export-bundle/3 example", () => {
  it("every file equals its fenced block in the ADR, and the SHA256SUMS and tar digest blocks hold", () => {
    const blocks = adrBlocks();
    const paths = [...ex.files.keys()].sort();
    for (const p of paths) {
      expect(blocks.has(p), `ADR block b4-example:${p}`).toBe(true);
      const text = file(p).toString("utf8");
      // a fence ends its last line itself: a file's own final newline is not repeated inside the block
      expect(blocks.get(p)).toBe(text.endsWith("\n") ? text.slice(0, -1) : text);
    }
    expect(blocks.get("receipt-payload")).toBe((ex.body.receipt as { payload: string }).payload);
    expect(blocks.get("facts-payload")).toBe(ex.factsBytes);
    expect(blocks.size).toBe(paths.length + 4);
    const sums = paths.map((p) => `${sha256(file(p))}  ${p}`).join("\n");
    expect(blocks.get("SHA256SUMS")).toBe(sums);
    expect(blocks.get("tar.sha256")).toBe(`${sha256(ex.tar)}  ${BUNDLE_ROOT}.tar (uncompressed, ${ex.tar.length} bytes)`);
    // the ADR publishes the seed strings and key ids the TEST-ONLY keys come from
    const adr = readFileSync(ADR_PATH, "utf8");
    for (const s of [CANARY_RECEIPT_SEED_TEXT, CANARY_EXPORT_SEED_TEXT, CANARY_RECEIPT_KEY_ID, CANARY_EXPORT_KEY_ID]) {
      expect(adr.includes(s)).toBe(true);
      expect(s.includes("CANARY")).toBe(true);
    }
  });

  it("the frozen B1 and #307 schemas accept the body, the facts, the receipt and the manifest", () => {
    const body = decisionBomBodySchema.safeParse(JSON.parse(file("content/decision-bom.json").toString("utf8")));
    expect(body.success, JSON.stringify(body.error?.issues)).toBe(true);
    expect(decisionFactsSchema.safeParse(JSON.parse(ex.factsBytes)).success).toBe(true);
    expect(isDecisionReceiptPayload(ex.receiptPayload)).toBe(true);
    const manifest = exportBundleV3ManifestSchema.safeParse(JSON.parse(file("manifest.json").toString("utf8")));
    expect(manifest.success, JSON.stringify(manifest.error?.issues)).toBe(true);
  });

  it("the manifest is canonical, lists every other file by SHA-256 in code-unit order, and verifies with the export key", () => {
    const manifestText = file("manifest.json").toString("utf8");
    const manifest = JSON.parse(manifestText);
    expect(bomCanonicalBytes(manifest)).toBe(manifestText);
    const listed = [...ex.files.keys()].filter((p) => p !== "manifest.json" && p !== "manifest.json.sig").sort();
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual(listed);
    for (const f of manifest.files) expect(f.sha256).toBe(sha256(file(f.path)));
    const pem = file("signing-key.pub").toString("utf8");
    // ADR-0116: SHA-256 over the DER SubjectPublicKeyInfo
    const der = createPublicKey(pem).export({ type: "spki", format: "der" });
    expect(`sha256:${sha256(der)}`).toBe(manifest.signingKeyFingerprint);
    expect(publicKeyFingerprint(pem)).toBe(manifest.signingKeyFingerprint);
    const sigText = file("manifest.json.sig").toString("utf8");
    expect(sigText.endsWith("\n")).toBe(true);
    const sig = Buffer.from(sigText.slice(0, -1), "base64");
    expect(sig.length).toBe(64);
    expect(verify(null, file("manifest.json"), createPublicKey(pem), sig)).toBe(true);
    expect(manifest.signingKeyId).toBe(CANARY_EXPORT_KEY_ID);
  });

  it("the body signature verifies with the receipt key's JWK only; any changed byte or a foreign v fails", () => {
    const keys = JSON.parse(file("receipt-keys.json").toString("utf8")).keys as Array<{ keyId: string; jwk: { kty: string; crv: string; x: string }; fingerprint: string }>;
    const sigFile = JSON.parse(file("content/decision-bom.json.sig").toString("utf8"));
    expect(bomCanonicalBytes(sigFile)).toBe(file("content/decision-bom.json.sig").toString("utf8"));
    expect(sigFile.alg).toBe("Ed25519");
    const key = keys.find((k) => k.keyId === sigFile.keyId)!;
    const pub = createPublicKey({ key: key.jwk, format: "jwk" });
    // the receipt fingerprint follows the same rule: SPKI prefix || raw x
    expect(key.fingerprint).toBe(`sha256:${sha256(Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(key.jwk.x, "base64url")]))}`);
    const bodyBytes = file("content/decision-bom.json");
    expect(sigFile.signedSha256).toBe(sha256(bodyBytes));
    const sig = Buffer.from(sigFile.signature, "base64url");
    expect(sigFile.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(verify(null, bodyBytes, pub, sig)).toBe(true);
    const tampered = Buffer.from(bodyBytes);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
    expect(verify(null, tampered, pub, sig)).toBe(false);
    // domain separation: the receipt signature is not a body signature, and the reverse
    const body = JSON.parse(bodyBytes.toString("utf8"));
    expect(verify(null, Buffer.from(body.receipt.payload, "utf8"), pub, sig)).toBe(false);
    expect(verify(null, bodyBytes, pub, Buffer.from(body.receipt.signature, "base64url"))).toBe(false);
  });

  it("the receipt verifies, binds the facts and the chain row; the chain row recomputes; chain.tsv equals proof.chain", () => {
    const body = JSON.parse(file("content/decision-bom.json").toString("utf8"));
    const keys = JSON.parse(file("receipt-keys.json").toString("utf8")).keys as Array<{ keyId: string; jwk: object }>;
    const payloadText = body.receipt.payload as string;
    const payload = JSON.parse(payloadText);
    expect(bomCanonicalBytes(payload)).toBe(payloadText);
    expect(sha256(payloadText)).toBe(body.receipt.payloadHash);
    expect(payload.keyId).toBe(body.receipt.keyId);
    expect(payload.receiptSeq).toBe(body.receipt.receiptSeq);
    const pub = createPublicKey({ key: keys.find((k) => k.keyId === body.receipt.keyId)!.jwk as never, format: "jwk" });
    expect(verify(null, Buffer.from(payloadText, "utf8"), pub, Buffer.from(body.receipt.signature, "base64url"))).toBe(true);
    // v2: factsHash is SHA-256 of the exact facts payload bytes
    expect(payload.v).toBe("regulait.receipt.v2");
    expect(payload.factsHash).toBe(sha256(body.facts.payload));
    const row = body.proof.chain[0];
    expect(payload.audit).toEqual({ id: body.auditId, seq: body.decision.auditSeq, rowHash: row.rowHash, contentHash: row.contentHash });
    expect(row.rowHash).toBe(sha256(`${row.prevHash}${row.contentHash}`));
    const tsv = body.proof.chain.map((c: Record<string, string>) => `${c.seq}\t${c.contentHash}\t${c.prevHash}\t${c.rowHash}\n`).join("");
    expect(file("audit/chain.tsv").toString("utf8")).toBe(tsv);
    expect(body.basis).toEqual({ auditSeq: row.seq, anchorId: null, receiptSeq: body.receipt.receiptSeq, aiBomSnapshotId: null });
  });

  it("every section and its completeness re-derive from the facts payload and the receipt payload (§B4.4)", () => {
    const body = JSON.parse(file("content/decision-bom.json").toString("utf8"));
    const { sections, completeness } = projectSections(body.facts.payload, body.facts.addenda, JSON.parse(body.receipt.payload), body.decision.ruleChain);
    for (const [name, value] of Object.entries(sections)) expect(body[name], name).toEqual(value);
    for (const [name, value] of Object.entries(completeness)) expect(body.completeness[name], name).toEqual(value);
    // chain_signed: no anchor, so proof is not_recorded / anchor_absent
    expect(body.finality).toBe("chain_signed");
    expect(body.proof.anchor).toBeNull();
    expect(body.completeness.proof).toEqual({ status: "not_recorded", reason: "anchor_absent" });
    expect(Object.keys(body.completeness)).toEqual([...DECISION_BOM_SECTIONS].sort());
  });

  it("the R21 email scan finds nothing in any bundle entry", () => {
    for (const [p, b] of ex.files) {
      const text = b.toString("utf8");
      if (p.endsWith(".json")) expect(findEmailShapes(JSON.parse(text)), p).toEqual([]);
      expect(hasEmailShape(text), p).toBe(false);
    }
  });

  it("the USTAR stream: entries sorted by full path, pinned header fields, two zero blocks, reproducible by the ADR-0116 writer", () => {
    const { entries, endOffset } = readUstar(ex.tar);
    const want = [...ex.files.keys()].map((p) => `${BUNDLE_ROOT}/${p}`).sort();
    expect(entries.map((e) => e.path)).toEqual(want);
    for (const e of entries) {
      const h = e.header;
      const f = (o: number, l: number) => h.subarray(o, o + l).toString("latin1");
      expect(f(100, 8)).toBe("0000644\0");
      expect(f(108, 8)).toBe("0000000\0");
      expect(f(116, 8)).toBe("0000000\0");
      expect(f(124, 12)).toBe(e.body.length.toString(8).padStart(11, "0") + "\0");
      expect(f(136, 12)).toBe("00000000000\0");
      expect(f(156, 1)).toBe("0");
      expect(f(257, 6)).toBe("ustar\0");
      expect(f(263, 2)).toBe("00");
      // uname, gname, devmajor, devminor and linkname are all NUL
      for (const [o, l] of [[157, 100], [265, 32], [297, 32], [329, 8], [337, 8]] as const) expect(h.subarray(o, o + l).every((b) => b === 0)).toBe(true);
      const withSpaces = Buffer.from(h);
      withSpaces.fill(0x20, 148, 156);
      const sum = withSpaces.reduce((s, b) => s + b, 0);
      expect(f(148, 8)).toBe(sum.toString(8).padStart(6, "0") + "\0 ");
      expect(Buffer.compare(e.body, file(e.path.slice(BUNDLE_ROOT.length + 1)))).toBe(0);
    }
    expect(ex.tar.length).toBe(endOffset + 1024);
    expect(ex.tar.subarray(endOffset).every((b) => b === 0)).toBe(true);
    // the gzip member: magic, deflate, no flags, MTIME 0 (the OS byte is not pinned, §B4.1)
    expect([...ex.archive.subarray(0, 8)]).toEqual([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0]);
    const rebuilt = buildTarGz([...ex.files].map(([p, body]) => ({ path: `${BUNDLE_ROOT}/${p}`, body })).sort((a, b) => (a.path < b.path ? -1 : 1)));
    expect(Buffer.compare(rebuilt, ex.archive)).toBe(0);
  });
});
