/**
 * ADR-0189 slice B4 — THE PURE BOM VERIFIER (§6, R19, B4.1 to B4.10).
 *
 * One verifier for both subjects (R19) and every source: an `export-bundle/3`
 * archive (`verifyBomBundle`), or a stored frozen Decision BOM or AI BOM
 * snapshot (`verifyStoredDecisionBom`, `verifyStoredAiBom`). `POST
 * /v1/boms/verify` runs it online against the deployment's recorded keys;
 * `scripts/verify-bom.mjs` runs it offline against an out-of-band trust root.
 * The keys inside a bundle (`signing-key.pub`, `receipt-keys.json`) are never
 * the authority: a key is found by id in the CALLER's trust root only (B4.2).
 *
 * Pure: no database, no network, no clock (the verification time is an input).
 * The one asynchronous step is the optional RFC 3161 token check, which the
 * caller supplies (`BomTimestampVerifier`: the gateway's pkijs verifier and its
 * TSA trust bundle); without it a token is reported `unverifiable`, never
 * `valid`.
 *
 * Every rule of B4.9's G9 table is reported under its check and reason. The
 * outcome and `cannotProve` follow B4.8 through the contract's own
 * `isUnverifiableByDesign` and `bomCannotProveFor`.
 */
import { createHash, createPublicKey, verify as ed25519Verify, type KeyObject } from "node:crypto";
import { auditRowHash, canonicalJson } from "../audit-chain.js";
import { RECEIPT_PAYLOAD_VERSION, RECEIPT_PAYLOAD_VERSION_V2, type AnyDecisionReceiptPayload } from "../batch4.js";
import { isDecisionReceiptPayload } from "../receipts/verify.js";
import { readBomArchive } from "./bom-archive.js";
import {
  AI_BOM_VERSION,
  aiBomNativeBodySchema,
  aiBomSerialNumber,
  bomCanonicalBytes,
  bomSha256,
  DECISION_BOM_SECTIONS,
  DECISION_BOM_VERSION,
  decisionBomBodySchema,
  decisionFactsAddendumSchema,
  decisionFactsSchema,
  findEmailShapes,
  hasEmailShape,
  type DecisionBomFinalityState,
  type DecisionBomSection,
  type DecisionFacts,
  type DecisionFactsAddendum,
} from "./contract.js";
import {
  AI_BOM_DOWNLOAD_FORMATS,
  BOM_ANCHOR_CHECKS,
  BOM_VERIFY_CHECKS,
  bomCannotProveFor,
  bomExportVerifyKeyringSchema,
  bomVerifyIdentitySchema,
  exportBundleV3ManifestSchema,
  isUnverifiableByDesign,
  type BomByDesignContext,
  type BomCannotProve,
  type BomReportedFinality,
  type BomVerifyCheck,
  type BomVerifyCheckResult,
  type BomVerifyInvalidReason,
  type BomVerifyOutcome,
  type BomVerifySource,
  type BomVerifyUnverifiableReason,
  type ExportBundleV3Manifest,
} from "./contract-b4.js";
import { boundRowsOf, bomCompare, projectDecisionBom, type DecisionBomAnchor, type DecisionBomChainRow, type DecisionBomNoFactsReason } from "./decision-bom-assembly.js";
import { reportedFinality as reportedFinalityAt } from "./finality.js";

// ---------------------------------------------------------------------------
// the trust root (B4.2 "Finding the key"); never read from the bundle
// ---------------------------------------------------------------------------

export interface BomReceiptJwk {
  kty: string;
  crv: string;
  x: string;
}
/** receipt keys: a keyring (`GET /v1/receipts/keys` shape, or `receipt_signing_keys` online), or pinned fingerprints */
export type BomReceiptTrust =
  | { keys: ReadonlyArray<{ keyId: string; jwk: BomReceiptJwk }> }
  | { pinnedFingerprints: readonly string[] };
/**
 * export keys: a keyring (online: `REGULAIT_EXPORT_VERIFY_PUBLIC_KEYS` plus the deployment's own configured export
 * key; offline: ADR-0116 `--keyring`), or ADR-0116 `--fingerprint` pins. Null for a stored source (no envelope).
 */
export type BomExportTrust =
  | { keys: ReadonlyArray<{ keyId: string; publicKeyPem: string }> }
  | { pinnedFingerprints: readonly string[] };

/** R33: what the RFC 3161 check needs; the gateway supplies its pkijs verifier (`audit-timestamp-verify.ts`) */
export interface BomTimestampFacts {
  recordBytes: Uint8Array;
  nonceHex: string;
  policyOid: string | null;
  sentAt: Date;
  now: Date;
}
export interface BomTimestampVerifier {
  /** the SHA-256 message imprint inside the token, lower-case hex; throws on an unreadable token */
  messageImprint(tokenBase64: string): string;
  /** null when no TSA trust bundle is configured: the token is then `unverifiable` `no_tsa_trust_bundle` */
  verify: ((tokenBase64: string, facts: BomTimestampFacts) => Promise<{ genTime: Date }>) | null;
}

export interface BomVerifyTrust {
  receipt: BomReceiptTrust;
  /** the receipt v2 boundary (R42), from the trust root, never the bundle; null = no cutover recorded */
  receiptV2FromAuditSeq: number | null;
  export: BomExportTrust | null;
  timestamp: BomTimestampVerifier | null;
  /** `now` for R33's window and R44's lapse (ISO-8601) */
  verificationTime: string;
}

/** the verifier's result: `bomVerifyResponseSchema` without the route's own fields (trust, source, time, capabilities) */
export interface BomVerifyReport {
  bodyVersion: typeof DECISION_BOM_VERSION | typeof AI_BOM_VERSION | null;
  identity: ReturnType<typeof bomVerifyIdentitySchema.parse> | null;
  outcome: BomVerifyOutcome;
  checks: BomVerifyCheckResult[];
  sections: Array<{ section: DecisionBomSection; status: "valid" | "invalid"; completeness: "recorded" | "not_applicable" | "not_recorded"; notRecordedReason: string | null }>;
  cannotProve: BomCannotProve[];
  manifest: ExportBundleV3Manifest | null;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function hashBytes(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}
/** a receipt-key fingerprint: `sha256:` and SHA-256 of the Ed25519 SPKI prefix and the base64url-decoded `x` (B4.2) */
export function bomReceiptKeyFingerprint(x: string): string {
  return `sha256:${hashBytes(Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(x, "base64url")]))}`;
}
/** an export-key fingerprint: `sha256:` and SHA-256 of the DER SubjectPublicKeyInfo (ADR-0116) */
export function bomSpkiFingerprint(publicKeyPem: string): string {
  return `sha256:${hashBytes(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }))}`;
}
const B64URL_SIG = /^[A-Za-z0-9_-]{86}$/;
const B64STD_SIG = /^[A-Za-z0-9+/]{86}==$/;
const DIGEST = /^[0-9a-f]{64}$/;

function tryJson(text: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (text === undefined) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
/** the parsed value, or a symbol that has no canonical form (so a comparison with its text fails) */
const tryJsonValue = (text: string): unknown => {
  const j = tryJson(text);
  return j.ok ? j.value : Symbol("unparseable");
};
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const canonicalOf = (v: unknown): string | null => {
  try {
    return bomCanonicalBytes(v);
  } catch {
    return null;
  }
};
const sameJson = (a: unknown, b: unknown): boolean => {
  const x = canonicalOf(a);
  return x !== null && x === canonicalOf(b);
};

function ed25519KeyFromJwk(jwk: BomReceiptJwk): KeyObject | null {
  try {
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") return null;
    const k = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
    return k.asymmetricKeyType === "ed25519" ? k : null;
  } catch {
    return null;
  }
}
function ed25519KeyFromPem(pem: string): KeyObject | null {
  try {
    const k = createPublicKey(pem);
    return k.asymmetricKeyType === "ed25519" ? k : null;
  } catch {
    return null;
  }
}
const rawOf = (k: KeyObject): string => Buffer.from(k.export({ type: "spki", format: "der" })).toString("hex");
function verifySig(key: KeyObject, bytes: string | Uint8Array, signature: Buffer): boolean {
  try {
    return ed25519Verify(null, typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes, key, signature);
  } catch {
    return false;
  }
}

/** the receipt-keys.json convenience file, parsed for the pinned-fingerprint trust root only */
type ReceiptKeysFile = Array<{ keyId: string; jwk: BomReceiptJwk }> | null;

/** B4.2: a receipt key by id in the trust root; null = `unknown_key` (absent, or held twice with different keys) */
function receiptKeyFor(trust: BomReceiptTrust, keyId: string, bundled: ReceiptKeysFile): KeyObject | null {
  if ("pinnedFingerprints" in trust) {
    const entries = (bundled ?? []).filter((k) => k.keyId === keyId);
    const xs = new Set(entries.map((k) => k.jwk.x));
    if (xs.size !== 1) return null;
    const entry = entries[0]!;
    if (!trust.pinnedFingerprints.includes(bomReceiptKeyFingerprint(entry.jwk.x))) return null;
    return ed25519KeyFromJwk(entry.jwk);
  }
  const keys = trust.keys.filter((k) => k.keyId === keyId).map((k) => ed25519KeyFromJwk(k.jwk));
  if (keys.some((k) => k === null)) return null;
  const distinct = new Map((keys as KeyObject[]).map((k) => [rawOf(k), k]));
  return distinct.size === 1 ? [...distinct.values()][0]! : null;
}
/** B4.2: the export key by the manifest's `signingKeyId`, or the pinned fingerprint of the bundled key (ADR-0116) */
function exportKeyFor(trust: BomExportTrust, keyId: string, bundledPem: string | undefined): KeyObject | null {
  if ("pinnedFingerprints" in trust) {
    if (bundledPem === undefined) return null;
    let fp: string;
    try {
      fp = bomSpkiFingerprint(bundledPem);
    } catch {
      return null;
    }
    return trust.pinnedFingerprints.includes(fp) ? ed25519KeyFromPem(bundledPem) : null;
  }
  const keys = trust.keys.filter((k) => k.keyId === keyId).map((k) => ed25519KeyFromPem(k.publicKeyPem));
  if (keys.some((k) => k === null)) return null;
  const distinct = new Map((keys as KeyObject[]).map((k) => [rawOf(k), k]));
  return distinct.size === 1 ? [...distinct.values()][0]! : null;
}

/** the online export verification keyring could not be loaded (B4.2: a keyring with a wrong pin is refused whole) */
export class BomExportKeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BomExportKeyringError";
  }
}
/**
 * B4.2 (master decision, contract round 2): the ONLINE export trust root. The configured public-only keyring
 * (`bomExportVerifyKeyringSchema`, inline or from a file; `null` when neither is set) plus the deployment's own
 * configured export key, when there is one. A keyring entry whose `fingerprint` does not match its key, or that is
 * not an Ed25519 key, refuses the whole keyring at load. A key read from a bundle is never part of it.
 */
export function bomOnlineExportTrust(keyringJson: unknown | null, ownKey: { keyId: string; publicKeyPem: string } | null): BomExportTrust {
  const keys: Array<{ keyId: string; publicKeyPem: string }> = [];
  if (keyringJson !== null) {
    const parsed = bomExportVerifyKeyringSchema.safeParse(keyringJson);
    if (!parsed.success) throw new BomExportKeyringError("the export verification keyring is not a list of {keyId, publicKeyPem, fingerprint?}, each id once");
    for (const k of parsed.data) {
      if (!ed25519KeyFromPem(k.publicKeyPem)) throw new BomExportKeyringError(`export verification key ${k.keyId} is not an Ed25519 public key`);
      if (k.fingerprint !== undefined && bomSpkiFingerprint(k.publicKeyPem) !== k.fingerprint) throw new BomExportKeyringError(`export verification key ${k.keyId}: the fingerprint does not match the key`);
      keys.push({ keyId: k.keyId, publicKeyPem: k.publicKeyPem });
    }
  }
  if (ownKey) keys.push(ownKey);
  return { keys };
}

class CheckList {
  private readonly items: BomVerifyCheckResult[] = [];
  valid(check: BomVerifyCheck, ref: string | null = null) {
    this.items.push({ check, status: "valid", reason: null, ref });
  }
  invalid(check: BomVerifyCheck, reason: BomVerifyInvalidReason, ref: string | null = null) {
    this.items.push({ check, status: "invalid", reason, ref });
  }
  unverifiable(check: BomVerifyCheck, reason: BomVerifyUnverifiableReason, ref: string | null = null) {
    this.items.push({ check, status: "unverifiable", reason, ref });
  }
  /** one result from an `[status, reason]` pair */
  put(check: BomVerifyCheck, r: Result, ref: string | null = null) {
    if (r === null) this.valid(check, ref);
    else if (r.status === "invalid") this.invalid(check, r.reason, ref);
    else this.unverifiable(check, r.reason, ref);
  }
  has(check: BomVerifyCheck) {
    return this.items.some((c) => c.check === check);
  }
  sorted(): BomVerifyCheckResult[] {
    const at = (c: BomVerifyCheck) => BOM_VERIFY_CHECKS.indexOf(c);
    return this.items.map((c, i) => [c, i] as const).sort(([a, i], [b, j]) => at(a.check) - at(b.check) || i - j).map(([c]) => c);
  }
}
type Result = null | { status: "invalid"; reason: BomVerifyInvalidReason } | { status: "unverifiable"; reason: BomVerifyUnverifiableReason };
const bad = (reason: BomVerifyInvalidReason): Result => ({ status: "invalid", reason });
const unv = (reason: BomVerifyUnverifiableReason): Result => ({ status: "unverifiable", reason });

/** B4.2 "Signature file": the canonical `{alg, keyId, signature, signedSha256}` */
interface SignatureFile {
  keyId: string;
  signature: string;
  signedSha256: string;
}
function parseSignatureFile(text: string | undefined): SignatureFile | null {
  const j = tryJson(text);
  if (!j.ok || !isObject(j.value)) return null;
  const v = j.value;
  if (canonicalOf(v) !== text) return null;
  if (Object.keys(v).sort(bomCompare).join() !== "alg,keyId,signature,signedSha256") return null;
  if (v.alg !== "Ed25519" || typeof v.keyId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(v.keyId)) return null;
  if (typeof v.signature !== "string" || !B64URL_SIG.test(v.signature) || typeof v.signedSha256 !== "string" || !DIGEST.test(v.signedSha256)) return null;
  return { keyId: v.keyId, signature: v.signature, signedSha256: v.signedSha256 };
}

/** a signed body against a signature file: schema, the signed hash, the key, the signature (B4.9 G9 rows) */
function bodySignatureResult(sig: SignatureFile | null, bodyText: string, wantSha: string | null, trust: BomReceiptTrust, bundled: ReceiptKeysFile, linkMismatch = false): Result {
  if (!sig) return bad("schema_violation");
  if (sig.signedSha256 !== bomSha256(bodyText) || (wantSha !== null && sig.signedSha256 !== wantSha)) return bad("hash_mismatch");
  if (linkMismatch) return bad("bom_link_mismatch");
  const key = receiptKeyFor(trust, sig.keyId, bundled);
  if (!key) return bad("unknown_key");
  return verifySig(key, bodyText, Buffer.from(sig.signature, "base64url")) ? null : bad("signature_mismatch");
}

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------

function finish(
  checks: CheckList,
  ctx: { source: BomVerifySource; manifest: ExportBundleV3Manifest | null },
  subject:
    | { kind: "decision-bom"; identity: unknown; sections: BomVerifyReport["sections"]; receiptPayloadVersion: "v1" | "v2" | null; recordedFinality: DecisionBomFinalityState | null; reportedFinality: BomReportedFinality | null; version: number }
    | { kind: "ai-bom"; identity: unknown; version: number }
    | null,
): BomVerifyReport {
  const list = checks.sorted();
  const parsedIdentity = subject ? bomVerifyIdentitySchema.safeParse(subject.identity) : null;
  const identity = parsedIdentity?.success ? parsedIdentity.data : null;
  const design: BomByDesignContext | null =
    subject === null
      ? null
      : subject.kind === "decision-bom"
        ? { subject: "decision-bom", source: ctx.source, receiptPayloadVersion: subject.receiptPayloadVersion, recordedFinality: subject.recordedFinality, version: subject.version }
        : { subject: "ai-bom", source: ctx.source, receiptPayloadVersion: null, recordedFinality: null, version: subject.version };
  const sections = subject?.kind === "decision-bom" ? subject.sections : [];
  const anyInvalid = list.some((c) => c.status === "invalid") || sections.some((s) => s.status === "invalid") || identity === null;
  const lowering = list.some((c) => c.status === "unverifiable" && (design === null || !isUnverifiableByDesign(c.check, c.reason, design)));
  const outcome: BomVerifyOutcome = anyInvalid ? "invalid" : lowering ? "unverifiable" : "valid";
  const cannotProve =
    identity === null || design === null
      ? []
      : bomCannotProveFor({ ...design, reportedFinality: subject?.kind === "decision-bom" ? subject.reportedFinality : null });
  return {
    bodyVersion: identity === null ? null : identity.subject === "decision-bom" ? DECISION_BOM_VERSION : AI_BOM_VERSION,
    identity,
    outcome,
    checks: list,
    sections,
    cannotProve,
    manifest: ctx.manifest,
  };
}

const unreadable = (why: string): BomVerifyReport => {
  void why;
  const c = new CheckList();
  c.invalid("bundle_manifest_files", "bundle_unreadable");
  return finish(c, { source: "bundle", manifest: null }, null);
};

// ---------------------------------------------------------------------------
// the Decision BOM checks (B4.3, B4.4, B4.5, B4.9)
// ---------------------------------------------------------------------------

interface DecisionInputs {
  source: BomVerifySource;
  bodyText: string;
  sig: SignatureFile | null;
  /** the body hash the envelope names (`descriptor.bodySha256`), or null when there is no envelope */
  envelopeBodySha: string | null;
  bundledReceiptKeys: ReceiptKeysFile;
  /** the linked AI BOM (B4.9): carried, absent (pruned or never carried) */
  linkedAi: { bodyText: string; sig: SignatureFile | null } | null;
}

interface DecisionOutcome {
  body: Record<string, unknown> | null;
  identity: unknown;
  sections: BomVerifyReport["sections"];
  receiptPayloadVersion: "v1" | "v2" | null;
  recordedFinality: DecisionBomFinalityState | null;
  reportedFinality: BomReportedFinality | null;
  version: number;
}

async function verifyDecisionBody(checks: CheckList, trust: BomVerifyTrust, inp: DecisionInputs): Promise<DecisionOutcome> {
  const parsedJson = tryJson(inp.bodyText);
  const raw = parsedJson.ok && isObject(parsedJson.value) ? parsedJson.value : null;

  // body_version: the domain is the `v` inside the signed bytes (OWNER DECISION 2)
  checks.put("body_version", raw?.v === DECISION_BOM_VERSION ? null : bad("unknown_body_version"));
  // body_schema: canonical and `decisionBomBodySchema`
  const schemaOk = raw !== null && canonicalOf(raw) === inp.bodyText && decisionBomBodySchema.safeParse(raw).success;
  checks.put("body_schema", schemaOk ? null : bad("schema_violation"));
  // body_signature
  checks.put("body_signature", bodySignatureResult(inp.sig, inp.bodyText, inp.envelopeBodySha, trust.receipt, inp.bundledReceiptKeys));

  const empty: DecisionOutcome = { body: raw, identity: null, sections: [], receiptPayloadVersion: null, recordedFinality: null, reportedFinality: null, version: 1 };
  if (raw === null) {
    for (const c of ["receipt_signature", "receipt_payload_hash", "receipt_facts_binding", "sections_projection", "chain_links"] as const) checks.invalid(c, c === "receipt_facts_binding" ? "facts_hash_mismatch" : c === "chain_links" ? "chain_break" : c === "sections_projection" ? "section_mismatch" : "schema_violation");
    return empty;
  }
  const b = raw as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- each read below is guarded
  const chain: DecisionBomChainRow[] = Array.isArray(b.proof?.chain) ? b.proof.chain : [];
  const anchor: DecisionBomAnchor | null = b.proof?.anchor ?? null;
  const first = chain[0];
  const last = chain[chain.length - 1];

  // --- the receipt (B4.3) ---------------------------------------------------
  const receipt = isObject(b.receipt) ? b.receipt : {};
  const payloadText: string = typeof receipt.payload === "string" ? receipt.payload : "";
  const payloadJson = tryJson(payloadText);
  const payload: AnyDecisionReceiptPayload | null = payloadJson.ok && isDecisionReceiptPayload(payloadJson.value) ? payloadJson.value : null;
  const payloadCanonical = payloadJson.ok && (() => { try { return canonicalJson(payloadJson.value) === payloadText; } catch { return false; } })();
  checks.put(
    "receipt_payload_hash",
    !payload || !payloadCanonical ? bad("schema_violation") : bomSha256(payloadText) !== receipt.payloadHash ? bad("hash_mismatch") : null,
  );
  const receiptPayloadVersion = payload ? (payload.v === RECEIPT_PAYLOAD_VERSION_V2 ? "v2" : "v1") : null;
  {
    let r: Result = null;
    const auditWant = { contentHash: first?.contentHash, id: b.auditId, rowHash: first?.rowHash, seq: b.decision?.auditSeq };
    if (!payload || payload.keyId !== receipt.keyId || payload.receiptSeq !== receipt.receiptSeq || !sameJson(payload.audit, auditWant)) r = bad("subject_mismatch");
    else if (typeof receipt.signature !== "string" || !B64URL_SIG.test(receipt.signature)) r = bad("schema_violation");
    else {
      const key = receiptKeyFor(trust.receipt, String(receipt.keyId), inp.bundledReceiptKeys);
      if (!key) r = bad("unknown_key");
      else if (!verifySig(key, payloadText, Buffer.from(receipt.signature, "base64url"))) r = bad("signature_mismatch");
    }
    checks.put("receipt_signature", r);
  }
  const factsPayload: string | null = typeof b.facts?.payload === "string" ? b.facts.payload : null;
  {
    // B4.3 receipt_facts_binding, with G10's boundary rule
    const boundary = trust.receiptV2FromAuditSeq;
    let r: Result;
    if (!payload) r = bad("facts_hash_mismatch");
    else if (payload.v === RECEIPT_PAYLOAD_VERSION_V2) {
      if (boundary === null || payload.audit.seq < boundary) r = bad("v2_receipt_before_boundary");
      else if (payload.factsStatus === "captured") r = factsPayload !== null && bomSha256(factsPayload) === payload.factsHash ? null : bad("facts_hash_mismatch");
      else r = b.facts?.payload === null ? null : bad("facts_hash_mismatch");
    } else if (payload.v === RECEIPT_PAYLOAD_VERSION) {
      r = boundary !== null && payload.audit.seq >= boundary ? bad("v1_receipt_after_boundary") : unv("receipt_v1_no_factsHash");
    } else r = bad("facts_hash_mismatch");
    checks.put("receipt_facts_binding", r);
  }

  // --- facts and addenda (R35, G3) -------------------------------------------
  const factsJson = factsPayload === null ? null : tryJson(factsPayload);
  const factsParsed = factsJson?.ok ? decisionFactsSchema.safeParse(factsJson.value) : null;
  const facts: DecisionFacts | null = factsParsed?.success && canonicalOf(factsJson!.ok ? factsJson!.value : null) === factsPayload ? factsParsed.data : null;
  const factsBroken = factsPayload !== null && facts === null;
  const entries: Array<Record<string, unknown>> = Array.isArray(b.facts?.addenda) ? b.facts.addenda : [];
  const addenda: DecisionFactsAddendum[] = [];
  let addendaBroken = false;
  if (entries.length) {
    let r: Result = null;
    let prev = factsPayload === null ? null : bomSha256(factsPayload);
    // G3 with G15 and B4.4's approval row: a usage event or span is bound once; an approval re-bound by an addendum
    // after its status changed is kept twice (B4.4 "every binding is kept"; vector P11), so it is not a break
    const once = (table: string) => table === "usage_events" || table === "trace_spans";
    const seen = new Set<string>((facts?.rows ?? []).filter((row) => once(row.table)).map((row) => `${row.table}\u0000${row.id}`));
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const text = typeof e.payload === "string" ? e.payload : "";
      const j = tryJson(text);
      const parsed = j.ok ? decisionFactsAddendumSchema.safeParse(j.value) : null;
      if (e.n !== i + 1) { r ??= bad("addendum_chain_break"); addendaBroken = true; break; }
      if (!parsed?.success || canonicalOf(j.ok ? j.value : null) !== text) { r ??= bad("schema_violation"); addendaBroken = true; break; }
      const a = parsed.data;
      if (a.n !== e.n || a.prev !== e.prevHash || a.auditId !== b.auditId || prev === null || a.prev !== prev) { r ??= bad("addendum_chain_break"); addendaBroken = true; break; }
      for (const row of a.rows.filter((x) => once(x.table))) {
        const k = `${row.table}\u0000${row.id}`;
        if (seen.has(k)) r ??= bad("addendum_chain_break");
        seen.add(k);
      }
      addenda.push(a);
      prev = bomSha256(text);
    }
    checks.put("facts_addenda_chain", r);
    // facts_addenda_signatures: once, failing on the first bad addendum
    let s: Result = null;
    for (const e of entries) {
      if (typeof e.signature !== "string" || !B64URL_SIG.test(e.signature) || typeof e.keyId !== "string") { s = bad("schema_violation"); break; }
      const key = receiptKeyFor(trust.receipt, e.keyId, inp.bundledReceiptKeys);
      if (!key) { s = bad("unknown_key"); break; }
      if (!verifySig(key, String(e.payload ?? ""), Buffer.from(e.signature, "base64url"))) { s = bad("signature_mismatch"); break; }
    }
    checks.put("facts_addenda_signatures", s);
  }

  // --- sections_projection (B4.4, G13, G15) ----------------------------------
  const failed = new Set<DecisionBomSection>();
  const completeness = isObject(b.completeness) ? (b.completeness as Record<string, { status?: string; reason?: string }>) : {};
  if (!payload) {
    for (const s of ["decision", "principal", "receipt"] as const) failed.add(s);
  } else {
    const bodyReason = completeness.action?.reason;
    const noFactsReason: DecisionBomNoFactsReason =
      payload.v === RECEIPT_PAYLOAD_VERSION_V2
        ? payload.factsStatus === "capture_off" ? "capture_off" : "pre_facts"
        : bodyReason === "capture_off" ? "capture_off" : "pre_facts";
    const proj = projectDecisionBom({
      receipt: payload,
      receiptSeq: Number(receipt.receiptSeq),
      facts,
      addenda: facts ? addenda : [],
      noFactsReason,
      ruleChain: Array.isArray(b.decision?.ruleChain) ? b.decision.ruleChain : [],
      chain,
      anchor,
    });
    for (const p of proj.problems) failed.add(p.section);
    const simple = ["decision", "principal", "actors", "action", "policy", "model", "approval", "outcome", "cost", "trace"] as const;
    for (const s of simple) if (!sameJson(b[s], proj[s])) failed.add(s);
    for (const s of DECISION_BOM_SECTIONS) if (!sameJson(completeness[s], proj.completeness[s])) failed.add(s);
    const basis = isObject(b.basis) ? b.basis : {};
    if (basis.auditSeq !== proj.basis.auditSeq || basis.anchorId !== proj.basis.anchorId) failed.add("proof");
    if (basis.receiptSeq !== proj.basis.receiptSeq) failed.add("receipt");
    if (basis.aiBomSnapshotId !== proj.basis.aiBomSnapshotId) failed.add("model");
  }
  if (factsBroken) for (const s of ["actors", "action", "policy", "model", "outcome", "approval", "cost", "trace"] as const) failed.add(s);
  if (addendaBroken) for (const s of ["approval", "cost", "trace"] as const) failed.add(s);
  // G15: a row bound twice across the facts and the addenda has no valid projection, whatever the body says
  {
    const all = boundRowsOf(facts, addenda);
    for (const [table, section] of [["usage_events", "cost"], ["trace_spans", "trace"]] as const) {
      const ids = all.filter((r) => r.table === table).map((r) => r.id);
      if (new Set(ids).size !== ids.length) failed.add(section);
    }
  }
  checks.put("sections_projection", failed.size ? bad("section_mismatch") : null);

  // --- the chain and the decision row (§6, R39) ------------------------------
  {
    let ok = chain.length >= 1 && first?.seq === b.decision?.auditSeq;
    chain.forEach((row, i) => {
      if (!ok) return;
      if (!row || typeof row.prevHash !== "string" || typeof row.contentHash !== "string" || row.rowHash !== auditRowHash(row.prevHash, row.contentHash)) ok = false;
      else if (i > 0 && (row.prevHash !== chain[i - 1]!.rowHash || row.seq !== chain[i - 1]!.seq + 1)) ok = false;
    });
    if (b.finality === "chain_signed" && chain.length !== 1) ok = false;
    checks.put("chain_links", ok ? null : bad("chain_break"));
  }
  checks.unverifiable("decision_content_binding", "preimage_not_exported");

  // --- the anchor (R1, R33, G5) ----------------------------------------------
  if (b.finality === "chain_signed") {
    for (const c of BOM_ANCHOR_CHECKS) checks.unverifiable(c, "anchor_absent");
  } else if (!isObject(anchor)) {
    for (const c of BOM_ANCHOR_CHECKS) checks.invalid(c, "anchor_record_incomplete");
  } else {
    const rec = isObject(anchor.record) ? anchor.record : null;
    const six = ["seq", "rowHash", "headAt", "algorithm", "payloadVersion", "capturedAt"] as const;
    const complete = rec !== null && Object.keys(rec).length === 6 && six.every((k) => rec[k] !== undefined && rec[k] !== null);
    checks.put("anchor_record", !complete ? bad("anchor_record_incomplete") : rec!.seq !== last?.seq || rec!.rowHash !== last?.rowHash ? bad("anchor_mismatch") : null);
    const tsa = isObject(anchor.tsa) ? anchor.tsa : null;
    if (!complete || !rec) {
      checks.invalid("anchor_imprint", "anchor_record_incomplete");
      checks.put("tsa_token", tsa === null ? unv("no_timestamp_token") : bad("anchor_record_incomplete"));
    } else if (tsa === null) {
      checks.unverifiable("anchor_imprint", "no_timestamp_token");
      checks.unverifiable("tsa_token", "no_timestamp_token");
    } else {
      // the imprint is SHA-256 over canonicalJson of the six stored fields (audit-timestamp.ts anchorCanonicalBytes)
      const recordBytes = Buffer.from(canonicalJson({ seq: rec.seq, rowHash: rec.rowHash, headAt: rec.headAt, algorithm: rec.algorithm, payloadVersion: rec.payloadVersion, capturedAt: rec.capturedAt }), "utf8");
      const imprint = hashBytes(recordBytes);
      let tokenImprint: string | null = null;
      if (trust.timestamp) {
        try {
          tokenImprint = trust.timestamp.messageImprint(String(tsa.token));
        } catch {
          tokenImprint = "";
        }
      }
      if (tsa.messageImprint !== imprint || (tokenImprint !== null && tokenImprint !== imprint)) checks.invalid("anchor_imprint", "anchor_mismatch");
      else if (tokenImprint === null) checks.unverifiable("anchor_imprint", "no_tsa_trust_bundle");
      else checks.valid("anchor_imprint");
      // tsa_token (R33)
      if (!trust.timestamp?.verify) checks.unverifiable("tsa_token", "no_tsa_trust_bundle");
      else if (tsa.requestFactsLegacy === true) checks.unverifiable("tsa_token", "request_facts_not_recorded");
      else {
        try {
          const out = await trust.timestamp.verify(String(tsa.token), {
            recordBytes,
            nonceHex: String(tsa.nonce),
            policyOid: typeof tsa.policyOid === "string" ? tsa.policyOid : null,
            sentAt: new Date(String(tsa.requestSentAt)),
            now: new Date(trust.verificationTime),
          });
          checks.put("tsa_token", out.genTime.toISOString() === tsa.genTime ? null : bad("timestamp_invalid"));
        } catch {
          checks.invalid("tsa_token", "timestamp_invalid");
        }
      }
    }
  }

  // --- finality, structural (B4.5) --------------------------------------------
  const finality = b.finality as DecisionBomFinalityState;
  let reported: BomReportedFinality | null = null;
  {
    let ok: boolean;
    if (finality === "chain_signed") ok = anchor === null;
    else if (finality === "anchored_unverified_destination") ok = isObject(anchor) && anchor.status === "flushed";
    else if (finality === "anchored" || finality === "anchored_finite_lock") ok = isObject(anchor) && anchor.status === "flushed" && anchor.tamperResistant === true && typeof anchor.retainUntil === "string";
    else ok = false;
    checks.put("finality", ok ? null : bad("anchor_mismatch"));
    if (typeof finality === "string" && ["anchored", "anchored_finite_lock", "anchored_unverified_destination", "chain_signed"].includes(finality)) {
      const retainUntil = isObject(anchor) && typeof anchor.retainUntil === "string" ? new Date(anchor.retainUntil) : null;
      reported = reportedFinalityAt(finality, retainUntil, new Date(trust.verificationTime));
    }
  }

  // --- the linked AI BOM (B4.9) -----------------------------------------------
  const link = b.basis?.aiBomSnapshotId ?? null;
  if (link !== null) {
    if (!inp.linkedAi) checks.unverifiable("ai_bom_link", "snapshot_not_in_bundle");
    else {
      const j = tryJson(inp.linkedAi.bodyText);
      const ok = j.ok && canonicalOf(j.value) === inp.linkedAi.bodyText && aiBomNativeBodySchema.safeParse(j.value).success;
      if (!ok) checks.invalid("ai_bom_link", "schema_violation");
      else {
        const mismatch = (j.value as { snapshot: { id: string } }).snapshot.id !== link;
        checks.put("ai_bom_link", bodySignatureResult(inp.linkedAi.sig, inp.linkedAi.bodyText, null, trust.receipt, inp.bundledReceiptKeys, mismatch));
      }
    }
  }

  // --- sections and identity ---------------------------------------------------
  const sections = DECISION_BOM_SECTIONS.map((s) => {
    const e = completeness[s];
    const status: "recorded" | "not_applicable" | "not_recorded" = e?.status === "recorded" || e?.status === "not_applicable" ? e.status : "not_recorded";
    return {
      section: s,
      status: failed.has(s) ? ("invalid" as const) : ("valid" as const),
      completeness: status,
      notRecordedReason: status === "not_recorded" ? (typeof e?.reason === "string" ? e.reason : "pre_facts") : null,
    };
  });
  const identity = {
    subject: "decision-bom",
    auditId: b.auditId,
    bomId: b.id,
    version: b.version,
    recordedFinality: finality,
    reportedFinality: reported,
    receiptPayloadVersion,
  };
  return {
    body: raw,
    identity,
    sections,
    receiptPayloadVersion,
    recordedFinality: typeof finality === "string" ? finality : null,
    reportedFinality: reported,
    version: typeof b.version === "number" ? b.version : 1,
  };
}

// ---------------------------------------------------------------------------
// the AI BOM checks (R19, G12)
// ---------------------------------------------------------------------------

interface AiInputs {
  source: BomVerifySource;
  bodyText: string;
  sig: SignatureFile | null;
  envelopeBodySha: string | null;
  bundledReceiptKeys: ReceiptKeysFile;
  /** each carried rendering (bundle) or stored rendering row, by format */
  renderings: Array<{ format: string; bytes: Buffer }>;
  /** stored source only: the subject's snapshot of `version - 1` (`pruned` when no such row exists) */
  previous?: { id: string } | "pruned";
}

function verifyAiBody(checks: CheckList, trust: BomVerifyTrust, inp: AiInputs): { body: Record<string, any> | null; identity: unknown; version: number } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const j = tryJson(inp.bodyText);
  const raw = j.ok && isObject(j.value) ? (j.value as Record<string, any>) : null; // eslint-disable-line @typescript-eslint/no-explicit-any
  checks.put("body_version", raw?.v === AI_BOM_VERSION ? null : bad("unknown_body_version"));
  checks.put("body_schema", raw !== null && canonicalOf(raw) === inp.bodyText && aiBomNativeBodySchema.safeParse(raw).success ? null : bad("schema_violation"));
  checks.put("body_signature", bodySignatureResult(inp.sig, inp.bodyText, inp.envelopeBodySha, trust.receipt, inp.bundledReceiptKeys));
  const snap = isObject(raw?.snapshot) ? raw!.snapshot : null;
  const id = typeof snap?.id === "string" ? snap.id : "";
  let serialOk = false;
  try {
    serialOk = raw?.serialNumber === `urn:uuid:${aiBomSerialNumber(id)}` && id !== "";
  } catch {
    serialOk = false;
  }
  checks.put("serial_number", serialOk ? null : bad("serial_mismatch"));
  const version = typeof snap?.version === "number" ? snap.version : 1;
  if (version > 1) {
    if (inp.source === "bundle") checks.unverifiable("supersedes", "earlier_snapshot_not_in_bundle");
    else if (inp.previous === "pruned" || inp.previous === undefined) checks.unverifiable("supersedes", "earlier_snapshot_not_in_bundle");
    else checks.put("supersedes", inp.previous.id === snap?.supersedes ? null : bad("supersedes_mismatch"));
  }
  const commitments = isObject(raw?.renderings) ? (raw!.renderings as Record<string, any>) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const r of inp.renderings) {
    const c = commitments[r.format];
    if (!isObject(c) || c.status !== "rendered") checks.invalid("rendering_hashes", "rendering_not_in_body", r.format);
    else checks.put("rendering_hashes", c.sha256 === hashBytes(r.bytes) && c.bytes === r.bytes.length ? null : bad("hash_mismatch"), r.format);
  }
  const identity = snap ? { subject: "ai-bom", snapshotId: snap.id, subjectKind: snap.subjectKind, subjectId: snap.subjectId, version: snap.version, serialNumber: raw?.serialNumber } : null;
  return { body: raw, identity, version };
}

// ---------------------------------------------------------------------------
// the bundle (B4.1, G9)
// ---------------------------------------------------------------------------

const DECISION_FIXED_FILES = ["README.txt", "audit/chain.tsv", "content/decision-bom.json", "content/decision-bom.json.sig", "receipt-keys.json", "signing-key.pub"];
const AI_FIXED_FILES = ["README.txt", "content/ai-bom.json", "content/ai-bom.json.sig", "receipt-keys.json", "signing-key.pub"];
const DECISION_RENDERING_FORMATS = ["cyclonedx-1.7", "cyclonedx-1.6", "spdx-3.0.1", "in-toto"] as const;
const AI_RENDERING_FORMATS = AI_BOM_DOWNLOAD_FORMATS.filter((f) => f !== "native");

/** the carried renderings `content/<stem>.<format>.json`, in the given order */
function carriedFormats(paths: Iterable<string>, stem: string, order: readonly string[]): string[] {
  const set = new Set(paths);
  return order.filter((f) => set.has(`content/${stem}.${f}.json`));
}

/** `exportBundleV3ManifestSchema` apart from its email refinement (G9: the email shape is `bundle_email_scan`'s) */
function manifestSchemaIssues(value: unknown): boolean {
  const r = exportBundleV3ManifestSchema.safeParse(value);
  if (r.success) return false;
  return r.error.issues.some((i) => !i.message.startsWith("email-shaped value at") && !i.message.startsWith("an email-shaped installId"));
}

/** verify an `export-bundle/3` archive (the gzip bytes) against an out-of-band trust root */
async function verifyBomBundleUnguarded(archive: Uint8Array, trust: BomVerifyTrust): Promise<BomVerifyReport> {
  const read = readBomArchive(archive);
  if (!read.ok) return unreadable(read.why);
  const files = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const [path, bytes] of read.files) {
    try {
      files.set(path, decoder.decode(bytes));
    } catch {
      return unreadable("a file is not UTF-8");
    }
  }
  const checks = new CheckList();
  const manifestText = files.get("manifest.json");
  const manifestJson = tryJson(manifestText);
  const m = manifestJson.ok && isObject(manifestJson.value) ? (manifestJson.value as Record<string, any>) : null; // eslint-disable-line @typescript-eslint/no-explicit-any
  const kind: "decision-bom" | "ai-bom" | null =
    m?.subject?.kind === "decision-bom" || m?.subject?.kind === "ai-bom"
      ? m.subject.kind
      : files.has("content/decision-bom.json") ? "decision-bom" : files.has("content/ai-bom.json") && !files.has("content/decision-bom.json") ? "ai-bom" : null;

  // --- bundle_manifest_signature (B4.1, B4.2) ---------------------------------
  {
    const sigText = files.get("manifest.json.sig");
    let r: Result = null;
    if (sigText === undefined || !sigText.endsWith("\n") || !B64STD_SIG.test(sigText.slice(0, -1))) r = bad("schema_violation");
    else if (!trust.export || manifestText === undefined) r = bad("unknown_key");
    else {
      const key = exportKeyFor(trust.export, typeof m?.signingKeyId === "string" ? m.signingKeyId : "", files.get("signing-key.pub"));
      if (!key) r = bad("unknown_key");
      else if (!verifySig(key, manifestText, Buffer.from(sigText.slice(0, -1), "base64"))) r = bad("signature_mismatch");
    }
    checks.put("bundle_manifest_signature", r);
  }

  // --- the subject's body, read first for the file set and the envelope -------
  const bodyPath = kind === "ai-bom" ? "content/ai-bom.json" : "content/decision-bom.json";
  const bodyText = files.get(bodyPath);
  const bodyJson = tryJson(bodyText);
  const body = bodyJson.ok && isObject(bodyJson.value) ? (bodyJson.value as Record<string, any>) : null; // eslint-disable-line @typescript-eslint/no-explicit-any

  // --- bundle_manifest_files (B4.1 files table, G9) ---------------------------
  {
    let r: Result = null;
    const archivePaths = [...files.keys()].filter((p) => p !== "manifest.json" && p !== "manifest.json.sig").sort(bomCompare);
    const listed: string[] = Array.isArray(m?.files) ? m!.files.map((f: { path?: unknown }) => String(f?.path)) : [];
    if (m === null || canonicalOf(m) !== manifestText || manifestSchemaIssues(m)) r = bad("schema_violation");
    else if (kind === null) r = bad("manifest_mismatch");
    else {
      const allowed = new Set(kind === "decision-bom" ? DECISION_FIXED_FILES : AI_FIXED_FILES);
      if (kind === "decision-bom") {
        for (const f of DECISION_RENDERING_FORMATS) allowed.add(`content/decision-bom.${f}.json`);
        // B4.1: the linked AI BOM is carried only when basis.aiBomSnapshotId names one, with its signature file
        if (body?.basis?.aiBomSnapshotId != null) for (const p of ["content/ai-bom.json", "content/ai-bom.json.sig"]) allowed.add(p);
      } else for (const f of AI_RENDERING_FORMATS) allowed.add(`content/ai-bom.${f}.json`);
      const required = kind === "decision-bom" ? DECISION_FIXED_FILES : AI_FIXED_FILES;
      const pairOk = files.has("content/ai-bom.json") === files.has("content/ai-bom.json.sig");
      if (
        listed.join("\n") !== archivePaths.join("\n") ||
        !archivePaths.every((p) => allowed.has(p)) ||
        !required.every((p) => files.has(p)) ||
        !pairOk
      ) r = bad("manifest_mismatch");
      else if ((m.files as Array<{ path: string; sha256: string }>).some((f) => f.sha256 !== hashBytes(read.files.get(f.path)!))) r = bad("hash_mismatch");
      // every JSON entry is in its RFC 8785 form (so it has no duplicate key, and the scan reads what a parser reads)
      else if ([...files].some(([p, text]) => p.endsWith(".json") && canonicalOf(tryJsonValue(text)) !== text)) r = bad("schema_violation");
    }
    checks.put("bundle_manifest_files", r);
  }

  // --- bundle_email_scan (R21, B4.1 build order, G14) -------------------------
  {
    let hit = false;
    for (const [path, text] of files) {
      if (hasEmailShape(text)) hit = true;
      if (path.endsWith(".json")) {
        const j = tryJson(text);
        if (j.ok && findEmailShapes(j.value).length) hit = true;
      }
    }
    checks.put("bundle_email_scan", hit ? bad("email_shape") : null);
  }

  const manifestParsed = m !== null ? exportBundleV3ManifestSchema.safeParse(m) : null;
  const manifest = manifestParsed?.success ? manifestParsed.data : null;
  const descriptor = isObject(m?.subject?.descriptor) ? m!.subject.descriptor : null;
  const envelopeBodySha = typeof descriptor?.bodySha256 === "string" ? descriptor.bodySha256 : "";
  const receiptKeysJson = tryJson(files.get("receipt-keys.json"));
  const bundledReceiptKeys: ReceiptKeysFile =
    receiptKeysJson.ok && isObject(receiptKeysJson.value) && Array.isArray(receiptKeysJson.value.keys)
      ? (receiptKeysJson.value.keys as Array<{ keyId: string; jwk: BomReceiptJwk }>).filter((k) => isObject(k) && typeof k.keyId === "string" && isObject(k.jwk))
      : null;

  if (kind === null || bodyText === undefined) {
    checks.invalid("bundle_subject", "subject_mismatch");
    return finish(checks, { source: "bundle", manifest }, null);
  }

  if (kind === "decision-bom") {
    const linked = files.get("content/ai-bom.json");
    const out = await verifyDecisionBody(checks, trust, {
      source: "bundle",
      bodyText,
      sig: parseSignatureFile(files.get("content/decision-bom.json.sig")),
      envelopeBodySha,
      bundledReceiptKeys,
      linkedAi: linked === undefined ? null : { bodyText: linked, sig: parseSignatureFile(files.get("content/ai-bom.json.sig")) },
    });
    // bundle_subject: the envelope against the body (G9)
    let ok = m !== null && m.subject?.kind === "decision-bom" && body !== null;
    if (ok) {
      const chain: DecisionBomChainRow[] = Array.isArray(body!.proof?.chain) ? body!.proof.chain : [];
      const formats = carriedFormats(files.keys(), "decision-bom", DECISION_RENDERING_FORMATS);
      const wantDescriptor = {
        aiBomSnapshotId: body!.basis?.aiBomSnapshotId ?? null,
        auditId: body!.auditId,
        bodySha256: bomSha256(bodyText),
        bomId: body!.id,
        finality: body!.finality,
        formats,
        receiptSeq: body!.receipt?.receiptSeq,
        version: body!.version,
      };
      const wantAudit = chain.length
        ? { payloadScope: "none", segmentFromSeq: chain[0]!.seq, segmentRowCount: chain.length, segmentToSeq: chain[chain.length - 1]!.seq }
        : null;
      const wantTsv = chain.map((c) => `${c.seq}\t${c.contentHash}\t${c.prevHash}\t${c.rowHash}\n`).join("");
      ok =
        m!.subject.id === body!.auditId &&
        sameJson(descriptor, wantDescriptor) &&
        read.root === `regulait-export-decision-bom-${body!.auditId}-v${body!.version}` &&
        sameJson(m!.audit, wantAudit) &&
        files.get("audit/chain.tsv") === wantTsv;
    }
    checks.put("bundle_subject", ok ? null : bad("subject_mismatch"));
    return finish(checks, { source: "bundle", manifest }, { kind: "decision-bom", ...out });
  }

  // the AI BOM bundle (G12)
  const carried = carriedFormats(files.keys(), "ai-bom", AI_RENDERING_FORMATS);
  const out = verifyAiBody(checks, trust, {
    source: "bundle",
    bodyText,
    sig: parseSignatureFile(files.get("content/ai-bom.json.sig")),
    envelopeBodySha,
    bundledReceiptKeys,
    renderings: carried.map((f) => ({ format: f, bytes: read.files.get(`content/ai-bom.${f}.json`)! })),
  });
  {
    let ok = m !== null && m.subject?.kind === "ai-bom" && body !== null && isObject(body.snapshot);
    if (ok) {
      const s = body!.snapshot;
      const wantDescriptor = {
        bodySha256: bomSha256(bodyText),
        formats: ["native", ...carried],
        serialNumber: body!.serialNumber,
        snapshotId: s.id,
        subjectId: s.subjectId,
        subjectKind: s.subjectKind,
        trigger: s.trigger,
        version: s.version,
      };
      // B4.1 roots: `-native` with no rendering, `-<format>` with exactly that one, or the bare `…/bundle` root with
      // every rendering the body commits to as `rendered`
      const base = `regulait-export-ai-bom-${s.id}`;
      const rendered = AI_RENDERING_FORMATS.filter((f) => isObject(body!.renderings) && (body!.renderings as Record<string, { status?: string }>)[f]?.status === "rendered");
      const rootOk =
        (read.root === `${base}-native` && carried.length === 0) ||
        (carried.length === 1 && read.root === `${base}-${carried[0]}`) ||
        (read.root === base && carried.join() === rendered.join());
      ok = m!.subject.id === s.id && sameJson(descriptor, wantDescriptor) && m!.audit === null && rootOk;
    }
    checks.put("bundle_subject", ok ? null : bad("subject_mismatch"));
  }
  return finish(checks, { source: "bundle", manifest }, { kind: "ai-bom", identity: out.identity, version: out.version });
}

// ---------------------------------------------------------------------------
// the stored sources (B4.4: no envelope, so no bundle checks)
// ---------------------------------------------------------------------------

export interface StoredSignedBody {
  body: string;
  bodySha256: string;
  signature: string;
  keyId: string;
}
const storedSig = (s: StoredSignedBody): SignatureFile | null =>
  B64URL_SIG.test(s.signature) && DIGEST.test(s.bodySha256) ? { keyId: s.keyId, signature: s.signature, signedSha256: s.bodySha256 } : null;

/** a frozen `decision_boms` row, with its linked AI BOM snapshot when it still exists (`null` when pruned or none) */
async function verifyStoredDecisionBomUnguarded(input: StoredSignedBody & { linkedAiBom: StoredSignedBody | null }, trust: BomVerifyTrust): Promise<BomVerifyReport> {
  const checks = new CheckList();
  const out = await verifyDecisionBody(checks, trust, {
    source: "decision_bom",
    bodyText: input.body,
    sig: storedSig(input),
    envelopeBodySha: null,
    bundledReceiptKeys: null,
    linkedAi: input.linkedAiBom ? { bodyText: input.linkedAiBom.body, sig: storedSig(input.linkedAiBom) } : null,
  });
  return finish(checks, { source: "decision_bom", manifest: null }, { kind: "decision-bom", ...out });
}

/** a frozen `ai_bom_snapshots` row, its `bom_renderings` rows, and the subject's previous version (if any) */
async function verifyStoredAiBomUnguarded(
  input: StoredSignedBody & { renderings: Array<{ format: string; bytes: string }>; previous: { id: string } | "pruned" | null },
  trust: BomVerifyTrust,
): Promise<BomVerifyReport> {
  const checks = new CheckList();
  const out = verifyAiBody(checks, trust, {
    source: "ai_bom_snapshot",
    bodyText: input.body,
    sig: storedSig(input),
    envelopeBodySha: null,
    bundledReceiptKeys: null,
    renderings: [...input.renderings].sort((a, b) => bomCompare(a.format, b.format)).map((r) => ({ format: r.format, bytes: Buffer.from(r.bytes, "utf8") })),
    ...(input.previous === null ? {} : { previous: input.previous }),
  });
  return finish(checks, { source: "ai_bom_snapshot", manifest: null }, { kind: "ai-bom", identity: out.identity, version: out.version });
}


// ---------------------------------------------------------------------------
// the entry points: crafted input never throws (ADR-0191 review of #344, item 2)
// ---------------------------------------------------------------------------

/** an input the verifier could not even evaluate is `invalid` with one fixed check, never an exception */
function evaluationFailed(source: BomVerifySource): BomVerifyReport {
  const c = new CheckList();
  if (source === "bundle") c.invalid("bundle_manifest_files", "bundle_unreadable");
  else c.invalid("body_schema", "schema_violation");
  return finish(c, { source, manifest: null }, null);
}
async function guarded(source: BomVerifySource, run: () => Promise<BomVerifyReport>): Promise<BomVerifyReport> {
  try {
    return await run();
  } catch {
    return evaluationFailed(source);
  }
}

/** verify an `export-bundle/3` archive (the gzip bytes) against an out-of-band trust root; never throws */
export const verifyBomBundle = (archive: Uint8Array, trust: BomVerifyTrust): Promise<BomVerifyReport> =>
  guarded("bundle", () => verifyBomBundleUnguarded(archive, trust));
/** a frozen `decision_boms` row, with its linked AI BOM snapshot when it still exists (`null` when pruned or none); never throws */
export const verifyStoredDecisionBom = (input: StoredSignedBody & { linkedAiBom: StoredSignedBody | null }, trust: BomVerifyTrust): Promise<BomVerifyReport> =>
  guarded("decision_bom", () => verifyStoredDecisionBomUnguarded(input, trust));
/** a frozen `ai_bom_snapshots` row, its `bom_renderings` rows, and the subject's previous version (if any); never throws */
export const verifyStoredAiBom = (
  input: StoredSignedBody & { renderings: Array<{ format: string; bytes: string }>; previous: { id: string } | "pruned" | null },
  trust: BomVerifyTrust,
): Promise<BomVerifyReport> => guarded("ai_bom_snapshot", () => verifyStoredAiBomUnguarded(input, trust));
