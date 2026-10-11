/**
 * ADR-0189 slice B4 — the `export-bundle/3` FILE SET and MANIFEST (B4.1, B4.2).
 *
 * Pure: frozen rows in, the bundle's files out, with the manifest signed by the
 * caller's export-key `sign` function. The gateway writes the USTAR stream with
 * ADR-0116's `buildTarGz` (no tar dependency, B4.1).
 *
 * Build order (R21, B4.1): every file, then the manifest, then the email scan
 * over every entry INCLUDING `manifest.json` (an operator-set `installId` is
 * scanned with it), then the manifest signature. A hit refuses the export with
 * the file and the JSON path, never the value (422 `bom_export_refused`).
 */
import { createHash } from "node:crypto";
import { AI_BOM_DOWNLOAD_FORMATS, EXPORT_BUNDLE_V3_SCHEMA, exportBundleV3ManifestSchema, type AiBomDownloadFormat, type ExportBundleV3Manifest } from "./contract-b4.js";
import { bomCanonicalBytes, findEmailShapes, hasEmailShape, type BomRenderingFormat, type DecisionBomFinalityState } from "./contract.js";
import { bomCompare } from "./decision-bom-assembly.js";
import { bomReceiptKeyFingerprint } from "./verify.js";

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** the export signing key, as the gateway resolves it (ADR-0116 `resolveExportSigningKey`) */
export interface BomBundleExportKey {
  keyId: string;
  fingerprint: string;
  publicKeyPem: string;
  sign(bytes: Buffer): Buffer;
}
/** a frozen, signed body row (`decision_boms` or `ai_bom_snapshots`) */
export interface BomSignedRow {
  body: string;
  bodySha256: string;
  signature: string;
  keyId: string;
}
export interface BomBundleEnvelope {
  installId: string | null;
  /** ADR-0116 sources mapped (B4.1): environment -> operator, license -> license, none -> absent */
  installIdSource: "operator" | "license" | "absent";
  /** the database clock, `toISOString()` form */
  exportedAt: string;
  exportedByUserId: string;
  exportKey: BomBundleExportKey;
  /** every receipt key the bundle's signatures name, from `receipt_signing_keys` (public JWKs only) */
  receiptKeys: ReadonlyArray<{ keyId: string; jwk: { kty: "OKP"; crv: "Ed25519"; x: string } }>;
}
export interface BuiltBomBundle {
  root: string;
  /** every file under the root, `manifest.json` and its signature included, sorted by full name */
  files: Array<{ path: string; body: Buffer }>;
  manifest: ExportBundleV3Manifest;
  manifestSha256: string;
  bodySha256: string;
}

/** R10 / R21: the export was refused by the email scan; names the file and the JSON path, never the value */
export class BomExportRefusal extends Error {
  constructor(
    readonly file: string,
    readonly path: string,
  ) {
    super(`an email-shaped value in ${file} at ${path}`);
    this.name = "BomExportRefusal";
  }
}

const DECISION_README =
  "RegulAIt signed export bundle (regulait.export-bundle/3, subject decision-bom)\n" +
  "\n" +
  "Verify with an out-of-band trust root only: the export key fingerprint for\n" +
  "manifest.json.sig, and the receipt key for content/decision-bom.json.sig,\n" +
  "the receipt and any addenda. signing-key.pub and receipt-keys.json are\n" +
  "convenience copies, never the trust root.\n" +
  "\n" +
  "    node scripts/verify-bom.mjs <bundle.tar.gz> --fingerprint sha256:<hex> \\\n" +
  "        --receipt-keyring <receipt-keys-from-your-operator.json>\n" +
  "\n" +
  "This bundle carries no audit row payloads (ADR-0189 R39): audit/chain.tsv\n" +
  "holds hashes only, so the decision row's content is not disclosed.\n";
const AI_README =
  "RegulAIt signed export bundle (regulait.export-bundle/3, subject ai-bom)\n" +
  "\n" +
  "Verify with an out-of-band trust root only: the export key fingerprint for\n" +
  "manifest.json.sig, and the receipt key for content/ai-bom.json.sig.\n" +
  "signing-key.pub and receipt-keys.json are convenience copies, never the\n" +
  "trust root. Each content/ai-bom.<format>.json rendering is authenticated\n" +
  "only by the SHA-256 and length the signed body commits to (ADR-0189 R7).\n" +
  "\n" +
  "    node scripts/verify-bom.mjs <bundle.tar.gz> --fingerprint sha256:<hex> \\\n" +
  "        --receipt-keyring <receipt-keys-from-your-operator.json>\n";

/** B4.2 "Signature file": the canonical detached signature of a body */
export const bomSignatureFile = (row: BomSignedRow): string =>
  bomCanonicalBytes({ alg: "Ed25519", keyId: row.keyId, signature: row.signature, signedSha256: row.bodySha256 });

/** R21: scan every entry (`.json` files parsed too), then return the first hit, or null */
export function bomBundleEmailHit(files: ReadonlyArray<{ path: string; body: Buffer }>): { file: string; path: string } | null {
  for (const f of files) {
    const text = f.body.toString("utf8");
    if (f.path.endsWith(".json")) {
      try {
        const hits = findEmailShapes(JSON.parse(text));
        if (hits.length) return { file: f.path, path: hits[0]! };
      } catch {
        /* not JSON: the whole-text scan below still runs */
      }
    }
    if (hasEmailShape(text)) return { file: f.path, path: "$" };
  }
  return null;
}

function finish(root: string, content: Map<string, Buffer>, subject: ExportBundleV3Manifest["subject"], audit: ExportBundleV3Manifest["audit"], env: BomBundleEnvelope, bodySha256: string): BuiltBomBundle {
  const files = [...content.entries()].map(([path, body]) => ({ path, body })).sort((a, b) => bomCompare(a.path, b.path));
  const manifest = {
    schema: EXPORT_BUNDLE_V3_SCHEMA,
    product: "regulait" as const,
    installId: env.installId,
    installIdSource: env.installIdSource,
    exportedAt: env.exportedAt,
    exportedAtSource: "database" as const,
    exportedByUserId: env.exportedByUserId,
    subject,
    files: files.map((f) => ({ path: f.path, sha256: sha256(f.body) })),
    audit,
    signingKeyId: env.exportKey.keyId,
    signingKeyFingerprint: env.exportKey.fingerprint,
  };
  const manifestBytes = Buffer.from(bomCanonicalBytes(manifest), "utf8");
  // R21: scan every entry, the manifest included, BEFORE it is signed
  const hit = bomBundleEmailHit([...files, { path: "manifest.json", body: manifestBytes }]);
  if (hit) throw new BomExportRefusal(hit.file, hit.path);
  const parsed = exportBundleV3ManifestSchema.parse(manifest);
  const signature = env.exportKey.sign(manifestBytes);
  const all = [...files, { path: "manifest.json", body: manifestBytes }, { path: "manifest.json.sig", body: Buffer.from(`${signature.toString("base64")}\n`, "utf8") }];
  return {
    root,
    files: all.map((f) => ({ path: `${root}/${f.path}`, body: f.body })).sort((a, b) => bomCompare(a.path, b.path)),
    manifest: parsed,
    manifestSha256: sha256(manifestBytes),
    bodySha256,
  };
}

/** `receipt-keys.json`: one entry per distinct key id named, sorted by key id (B4.1) */
function receiptKeysFile(names: Iterable<string>, env: BomBundleEnvelope): Buffer {
  const wanted = [...new Set(names)].sort(bomCompare);
  const keys = wanted.map((keyId) => {
    const k = env.receiptKeys.find((r) => r.keyId === keyId);
    if (!k) throw new Error(`receipt key ${keyId} is not recorded; a bundle names only recorded keys`);
    return { fingerprint: bomReceiptKeyFingerprint(k.jwk.x), jwk: { crv: k.jwk.crv, kty: k.jwk.kty, x: k.jwk.x }, keyId };
  });
  return Buffer.from(bomCanonicalBytes({ keys }), "utf8");
}

/** a Decision BOM bundle (B4.1): the body, its signature file, the hash-only chain, the linked AI BOM when kept */
export function buildDecisionBomBundle(
  input: {
    row: BomSignedRow & { id: string; auditId: string; version: number; finality: DecisionBomFinalityState };
    /** the snapshot `basis.aiBomSnapshotId` names, when it still exists (B4.9: pruned = not carried) */
    linkedAiBom: BomSignedRow | null;
    renderings: ReadonlyArray<{ format: BomRenderingFormat; bytes: string }>;
    /** the README text (B4.1: wording not normative); the default says what is and is not the trust root */
    readme?: string;
  },
  env: BomBundleEnvelope,
): BuiltBomBundle {
  const body = JSON.parse(input.row.body) as {
    basis: { aiBomSnapshotId: string | null };
    receipt: { receiptSeq: number; keyId: string };
    proof: { chain: Array<{ seq: number; contentHash: string; prevHash: string; rowHash: string }> };
    facts: { addenda: Array<{ keyId: string }> };
  };
  const chain = body.proof.chain;
  const content = new Map<string, Buffer>();
  content.set("README.txt", Buffer.from(input.readme ?? DECISION_README, "utf8"));
  content.set("audit/chain.tsv", Buffer.from(chain.map((c) => `${c.seq}\t${c.contentHash}\t${c.prevHash}\t${c.rowHash}\n`).join(""), "utf8"));
  content.set("content/decision-bom.json", Buffer.from(input.row.body, "utf8"));
  content.set("content/decision-bom.json.sig", Buffer.from(bomSignatureFile(input.row), "utf8"));
  const formats = (["cyclonedx-1.7", "cyclonedx-1.6", "spdx-3.0.1", "in-toto"] as const).filter((f) => input.renderings.some((r) => r.format === f));
  for (const f of formats) content.set(`content/decision-bom.${f}.json`, Buffer.from(input.renderings.find((r) => r.format === f)!.bytes, "utf8"));
  const keyNames = [input.row.keyId, body.receipt.keyId, ...body.facts.addenda.map((a) => a.keyId)];
  const linked = body.basis.aiBomSnapshotId !== null ? input.linkedAiBom : null;
  if (linked) {
    content.set("content/ai-bom.json", Buffer.from(linked.body, "utf8"));
    content.set("content/ai-bom.json.sig", Buffer.from(bomSignatureFile(linked), "utf8"));
    keyNames.push(linked.keyId);
  }
  content.set("receipt-keys.json", receiptKeysFile(keyNames, env));
  content.set("signing-key.pub", Buffer.from(env.exportKey.publicKeyPem, "utf8"));
  const root = `regulait-export-decision-bom-${input.row.auditId}-v${input.row.version}`;
  return finish(
    root,
    content,
    {
      kind: "decision-bom",
      id: input.row.auditId,
      descriptor: {
        auditId: input.row.auditId,
        bomId: input.row.id,
        version: input.row.version,
        finality: input.row.finality,
        bodySha256: input.row.bodySha256,
        receiptSeq: body.receipt.receiptSeq,
        aiBomSnapshotId: body.basis.aiBomSnapshotId,
        formats: [...formats],
      },
    },
    { payloadScope: "none", segmentFromSeq: chain[0]!.seq, segmentToSeq: chain[chain.length - 1]!.seq, segmentRowCount: chain.length },
    env,
    input.row.bodySha256,
  );
}

/**
 * an AI BOM bundle (B4.1, G12): `?format=<f>` carries the native body plus that one rendering (`native`: none);
 * `…/bundle` carries every download format whose commitment is `rendered`. Never bare rendering bytes (R7).
 */
export function buildAiBomBundle(
  input: {
    row: BomSignedRow;
    renderings: ReadonlyArray<{ format: string; bytes: string }>;
    request: { kind: "format"; format: AiBomDownloadFormat } | { kind: "bundle" };
    readme?: string;
  },
  env: BomBundleEnvelope,
): BuiltBomBundle {
  const body = JSON.parse(input.row.body) as {
    serialNumber: string;
    snapshot: { id: string; subjectKind: string; subjectId: string; version: number; trigger: string };
    renderings: Record<string, { status: string }>;
  };
  const s = body.snapshot;
  const renderable = AI_BOM_DOWNLOAD_FORMATS.filter((f) => f !== "native" && body.renderings[f]?.status === "rendered" && input.renderings.some((r) => r.format === f));
  const carried = input.request.kind === "bundle" ? renderable : input.request.format === "native" ? [] : [input.request.format];
  const content = new Map<string, Buffer>();
  content.set("README.txt", Buffer.from(input.readme ?? AI_README, "utf8"));
  content.set("content/ai-bom.json", Buffer.from(input.row.body, "utf8"));
  content.set("content/ai-bom.json.sig", Buffer.from(bomSignatureFile(input.row), "utf8"));
  for (const f of carried) {
    const r = input.renderings.find((x) => x.format === f);
    if (!r) throw new Error(`rendering ${f} is not stored for snapshot ${s.id}`);
    content.set(`content/ai-bom.${f}.json`, Buffer.from(r.bytes, "utf8"));
  }
  content.set("receipt-keys.json", receiptKeysFile([input.row.keyId], env));
  content.set("signing-key.pub", Buffer.from(env.exportKey.publicKeyPem, "utf8"));
  const base = `regulait-export-ai-bom-${s.id}`;
  const root = input.request.kind === "bundle" ? base : `${base}-${input.request.format}`;
  return finish(
    root,
    content,
    {
      kind: "ai-bom",
      id: s.id,
      descriptor: {
        snapshotId: s.id,
        subjectKind: s.subjectKind as never,
        subjectId: s.subjectId,
        version: s.version,
        serialNumber: body.serialNumber,
        trigger: s.trigger as never,
        bodySha256: input.row.bodySha256,
        formats: ["native", ...carried] as AiBomDownloadFormat[],
      },
    },
    null,
    env,
    input.row.bodySha256,
  );
}
