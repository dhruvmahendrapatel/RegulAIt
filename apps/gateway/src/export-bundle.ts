/**
 * ADR-0116 — the SIGNED, OFFLINE-VERIFIABLE export bundle.
 *
 * THE CLAIM THIS FILE EXISTS TO MAKE TRUE
 * ---------------------------------------
 * The customer-facing material says "signed exports an auditor can verify
 * alone" and "exports verify without us — no portal login, no working session
 * with the vendor". Before this file, `GET /v1/reports/runs/:id/export` and
 * `GET /v1/audit.csv` returned plain, unsigned bytes, and the only integrity
 * check the product offered was `GET /v1/audit/verify` — a LIVE API call
 * against the running system, which is the precise opposite of the promise.
 *
 * WHAT A BUNDLE IS
 * ----------------
 *   manifest.json         canonical JSON (ADR-0060 `canonicalJson`) — the ONE
 *                         signed object. Names every file and its SHA-256, the
 *                         subject, the database-clock export time, the actor,
 *                         the install identity, the chain head, and the key.
 *   manifest.json.sig     base64 Ed25519 over manifest.json's EXACT bytes.
 *   content/<file>        the exported bytes, verbatim — byte-identical to
 *                         what the unsigned route returns.
 *   audit/chain.tsv       seq, contentHash, prevHash, rowHash — one line per
 *                         row of the included chain segment, `seq` ascending.
 *   audit/rows/<seq>.payload
 *                         the EXACT canonical payload bytes ADR-0060 hashes to
 *                         produce that row's content_hash. This is what makes
 *                         the bundle checkable with nothing but `sha256sum`:
 *                         the verifier never has to re-implement canonical
 *                         JSON, it hashes a file. It is also what makes the
 *                         bundle READABLE — the auditor can see the audit row
 *                         whose hash they just recomputed.
 *   signing-key.pub       the public key, as a CONVENIENCE ONLY. See below.
 *   README.txt            what the bundle proves and does not prove.
 *
 * THE TRUST ROOT — AND WHY THE BUNDLED KEY IS NOT IT
 * -------------------------------------------------
 * A bundle that carries its own public key is self-CONSISTENT, not
 * self-VERIFYING: anyone can doctor the content, mint a fresh keypair, re-sign,
 * drop the new public key in, and the bundle still "passes". So the key inside
 * the bundle is never the authority. `scripts/verify-export-bundle.sh` REFUSES
 * to run unless the auditor supplies the trust root themselves — either
 * `--fingerprint sha256:<hex>` (a value obtained ONCE, out of band, from the
 * organisation that runs the install) or `--keyring <dir>` holding the pinned
 * `.pub`. That is the same posture `verify-update-bundle.sh` and
 * `licensing.ts` already take, moved to the export path.
 *
 * The fingerprint is SHA-256 over the DER SubjectPublicKeyInfo, printed as
 * `sha256:<64 hex>` — reproducible with stock tooling and nothing of ours:
 *   openssl pkey -pubin -in key.pub -outform DER | sha256sum
 *
 * NO KEY MEANS NO BUNDLE
 * ----------------------
 * If no signing key is configured, the bundle route REFUSES (409) and says so.
 * It does not fall back to an unsigned bundle, and it does NOT generate a
 * keypair on the box at first use. A key the product minted for itself proves
 * only "whoever held this machine signed this", and an error message telling
 * an auditor to "get the public key from the vendor" would be false, because
 * the vendor never had it. Key custody is an operator act, performed once,
 * out of band — exactly like `infra/release-keys/`.
 */
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import {
  auditLog,
  and,
  asc,
  eq,
  gte,
  lte,
  sql,
  users,
  type Db,
} from "@regulait/db";
import {
  AUDIT_CHAIN_ALGORITHM,
  AUDIT_GENESIS_PREV_HASH,
  AUDIT_GENESIS_ROW_HASH,
  AUDIT_PAYLOAD_VERSION,
  canonicalAuditPayload,
  canonicalJson,
} from "@regulait/shared";

/** The manifest schema id. Bumped with the shape, never silently. */
export const EXPORT_BUNDLE_SCHEMA = "regulait.export-bundle/1" as const;
export const SCOPED_EXPORT_BUNDLE_SCHEMA = "regulait.export-bundle/2" as const;

/** How many chain rows a single bundle will carry, at most. A bundle is
 * evidence an auditor reads, not a database dump. Truncation is DISCLOSED in
 * the manifest rather than silently applied. */
export function exportBundleMaxChainRows(): number {
  const raw = process.env.REGULAIT_EXPORT_BUNDLE_MAX_CHAIN_ROWS;
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return 2000;
  return Math.min(100_000, Math.max(1, Math.trunc(n)));
}

/**
 * The row ceiling for a CSV export that is going to be BUNDLED.
 *
 * Lower than `csvMaxRows()` on purpose: the streaming route never holds more
 * than one batch, but a bundle must hold the whole file in memory to hash and
 * sign it. Hitting this ceiling is DISCLOSED — `emitCsv` appends its notice
 * row inside the signed bytes, and the manifest's subject descriptor records
 * both the ceiling and whether it bit.
 */
export function exportBundleMaxCsvRows(): number {
  const raw = process.env.REGULAIT_EXPORT_BUNDLE_MAX_CSV_ROWS;
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return 50_000;
  return Math.min(5_000_000, Math.max(1, Math.trunc(n)));
}

// ---------------------------------------------------------------------------
// The signing key
// ---------------------------------------------------------------------------

export interface ExportSigningKey {
  ok: true;
  keyId: string;
  /** `sha256:<64 hex>` over the DER SubjectPublicKeyInfo. */
  fingerprint: string;
  publicKeyPem: string;
  sign(bytes: Buffer): Buffer;
}

export interface ExportSigningRefusal {
  ok: false;
  ruleId:
    | "export-signing-key-absent"
    | "export-signing-key-id-absent"
    | "export-signing-key-id-malformed"
    | "export-signing-key-unreadable";
  reason: string;
}

/** `sha256:<hex>` over a public key's DER SubjectPublicKeyInfo. */
export function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

/**
 * Resolve the export signing key from the environment, or REFUSE.
 *
 * Deliberately two separate variables. A key file with no id would have to be
 * given a name by this code, and a name this code invented is a name the
 * auditor was never told out of band — which is the whole failure this design
 * exists to avoid.
 */
export function resolveExportSigningKey(): ExportSigningKey | ExportSigningRefusal {
  const keyPath = process.env.REGULAIT_EXPORT_SIGNING_KEY;
  const keyId = process.env.REGULAIT_EXPORT_SIGNING_KEY_ID;

  if (!keyPath || keyPath.trim() === "") {
    return {
      ok: false,
      ruleId: "export-signing-key-absent",
      reason:
        "no export signing key is configured on this deployment ($REGULAIT_EXPORT_SIGNING_KEY is unset), " +
        "so a signed export cannot be produced. This is a REFUSAL, not a fallback: an unsigned bundle " +
        "would look like evidence and prove nothing, and a keypair generated here at first use would " +
        "prove only that whoever holds this machine signed it. Generate the keypair off this host, " +
        "install the private key, and publish its fingerprint to your auditors out of band. " +
        "infra/export-keys/README.md has the exact commands and the rotation rules.",
    };
  }
  if (!keyId || keyId.trim() === "") {
    return {
      ok: false,
      ruleId: "export-signing-key-id-absent",
      reason:
        "$REGULAIT_EXPORT_SIGNING_KEY is set but $REGULAIT_EXPORT_SIGNING_KEY_ID is not. Every bundle " +
        "names the key that signed it so a verifier can select the right pinned public key; a key id " +
        "this code invented would be one the auditor was never given.",
    };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(keyId)) {
    return {
      ok: false,
      ruleId: "export-signing-key-id-malformed",
      reason:
        `signing key id '${keyId}' contains characters that are not permitted in a key id. A key id ` +
        "names a file in a pinned keyring; only [A-Za-z0-9._-] is allowed.",
    };
  }
  if (!existsSync(keyPath)) {
    return {
      ok: false,
      ruleId: "export-signing-key-unreadable",
      reason: `the configured export signing key is not present at ${keyPath}`,
    };
  }

  let privateKey: ReturnType<typeof createPrivateKey>;
  let publicKeyPem: string;
  try {
    privateKey = createPrivateKey(readFileSync(keyPath));
    publicKeyPem = createPublicKey(privateKey as unknown as string).export({ type: "spki", format: "pem" }).toString();
  } catch (err) {
    return {
      ok: false,
      ruleId: "export-signing-key-unreadable",
      reason: `the export signing key at ${keyPath} could not be loaded: ${(err as Error).message}`,
    };
  }

  return {
    ok: true,
    keyId,
    fingerprint: publicKeyFingerprint(publicKeyPem),
    publicKeyPem,
    // Ed25519: the algorithm argument is null — it signs the message itself,
    // so there is no digest choice and no padding mode to get wrong. Same call
    // shape as licensing.ts's verify, deliberately.
    sign: (bytes: Buffer) => cryptoSign(null, bytes, privateKey),
  };
}

// ---------------------------------------------------------------------------
// The install's identity
// ---------------------------------------------------------------------------

export interface InstallIdentity {
  installId: string | null;
  source: "environment" | "license" | "none";
  note: string;
}

/**
 * What names THIS deployment in a bundle, so two bundles from two installs can
 * never be confused for one another.
 *
 * There is deliberately no generated-at-first-use install uuid: a value this
 * code minted is a value nobody attested to, and it would read as an identity
 * while being a random number. The honest answer is an operator-set value, or
 * the id of a licence somebody actually signed, or NOTHING — with the key
 * fingerprint carrying the identity in that last case, since it is the value
 * the auditor holds out of band anyway.
 */
export async function resolveInstallIdentity(
  db: Db,
  licenseId: string | null,
): Promise<InstallIdentity> {
  void db;
  const fromEnv = process.env.REGULAIT_INSTALL_ID;
  if (fromEnv && fromEnv.trim() !== "") {
    return {
      installId: fromEnv.trim(),
      source: "environment",
      note: "installId was set by the operator ($REGULAIT_INSTALL_ID).",
    };
  }
  if (licenseId) {
    return {
      installId: licenseId,
      source: "license",
      note: "installId is the id of the signed licence installed on this deployment.",
    };
  }
  return {
    installId: null,
    source: "none",
    note:
      "This deployment has no operator-set installId and no installed licence, so the bundle carries " +
      "none. The signing key fingerprint is the install's identity in that case — it is the value an " +
      "auditor holds out of band. A generated-here id is deliberately NOT substituted: it would read " +
      "as an attested identity while being a number this process invented.",
  };
}

// ---------------------------------------------------------------------------
// The chain segment
// ---------------------------------------------------------------------------

export interface ChainSegmentRow {
  seq: number;
  contentHash: string;
  prevHash: string;
  rowHash: string;
  /** the EXACT bytes ADR-0060 hashes to get contentHash */
  payload: string;
  subject: boolean;
}

export interface ChainSegment {
  rows: ChainSegmentRow[];
  head: { seq: number; rowHash: string } | null;
  fromSeq: number | null;
  toSeq: number | null;
  truncated: boolean;
  /** seqs of rows about this subject that fell OUTSIDE the carried segment */
  subjectSeqsOmitted: number[];
  note: string;
}

/** The chain head, by `seq`. NULLs (pre-genesis legacy rows) are excluded. */
async function readHead(db: Db): Promise<{ seq: number; rowHash: string } | null> {
  const rows = await db
    .select({ seq: auditLog.seq, rowHash: auditLog.rowHash })
    .from(auditLog)
    .where(sql`${auditLog.seq} is not null`)
    .orderBy(sql`${auditLog.seq} desc`)
    .limit(1);
  const head = rows[0];
  if (!head?.seq || !head.rowHash) return null;
  return { seq: head.seq, rowHash: head.rowHash };
}

/**
 * A CONTIGUOUS run of chained rows ending at the head.
 *
 * Contiguity is not a nicety: it is what lets the verifier check linkage
 * (`prev_hash[n] === row_hash[n-1]`) at all. A bundle carrying only "the rows
 * about this report" would be a bag of rows with no chain in it, and each
 * row's hashes would be checkable only against themselves.
 *
 * The segment starts at the earliest chained row that mentions this subject,
 * so the generation event and the export event are both inside it, and is
 * capped. When the cap bites, the manifest says so and names the subject rows
 * left out — an auditor must never have to guess whether a short segment is
 * the whole story.
 */
export async function readChainSegment(db: Db, subjectId: string | null): Promise<ChainSegment> {
  const head = await readHead(db);
  if (!head) {
    return {
      rows: [],
      head: null,
      fromSeq: null,
      toSeq: null,
      truncated: false,
      subjectSeqsOmitted: [],
      note:
        "This deployment's audit log has no chained rows at all (ADR-0060's genesis row is absent), so " +
        "the bundle carries no chain segment and nothing here ties the content to an audit trail.",
    };
  }

  const cap = exportBundleMaxChainRows();

  let subjectSeqs: number[] = [];
  if (subjectId) {
    const rows = await db
      .select({ seq: auditLog.seq })
      .from(auditLog)
      .where(and(eq(auditLog.objectId, subjectId), sql`${auditLog.seq} is not null`))
      .orderBy(asc(auditLog.seq));
    subjectSeqs = rows.map((r) => r.seq).filter((s): s is number => typeof s === "number");
  }

  const earliestWanted = subjectSeqs.length > 0 ? Math.min(...subjectSeqs) : head.seq;
  const uncappedFrom = Math.max(1, Math.min(earliestWanted, head.seq));
  const cappedFrom = Math.max(uncappedFrom, head.seq - cap + 1);
  const truncated = cappedFrom > uncappedFrom;

  const raw = await db
    .select()
    .from(auditLog)
    .where(and(gte(auditLog.seq, cappedFrom), lte(auditLog.seq, head.seq)))
    .orderBy(asc(auditLog.seq));

  const rows: ChainSegmentRow[] = raw.map((r) => ({
    seq: r.seq as number,
    contentHash: r.contentHash as string,
    prevHash: r.prevHash as string,
    rowHash: r.rowHash as string,
    payload: canonicalAuditPayload(r),
    subject: subjectId !== null && r.objectId === subjectId,
  }));

  return {
    rows,
    head,
    fromSeq: cappedFrom,
    toSeq: head.seq,
    truncated,
    subjectSeqsOmitted: subjectSeqs.filter((s) => s < cappedFrom),
    note: truncated
      ? `The segment was capped at ${cap} rows (REGULAIT_EXPORT_BUNDLE_MAX_CHAIN_ROWS). It is contiguous ` +
        `and ends at the head, but it does NOT reach back to the genesis row, so this bundle alone ` +
        `cannot prove the chain is intact before seq ${cappedFrom}.`
      : cappedFrom === 1
        ? "The segment runs from the genesis row to the head: this bundle alone verifies the whole chain."
        : `The segment is contiguous from seq ${cappedFrom} to the head. It does not reach the genesis ` +
          `row, so this bundle alone cannot prove the chain is intact before seq ${cappedFrom}.`,
  };
}

// ---------------------------------------------------------------------------
// A deterministic USTAR writer
// ---------------------------------------------------------------------------
//
// Written here rather than pulled in as a dependency for two reasons. First,
// supply chain: a tar library in the gateway to emit seven small files is not a
// trade this repo makes. Second, and more important, DETERMINISM — every field
// a tar header can vary (mtime, uid, gid, mode, device numbers) is pinned to a
// constant here, so the same inputs produce the same archive bytes. An evidence
// artifact whose bytes change between two identical exports is one an auditor
// cannot diff.

/**
 * ustar splits a long path across `prefix` (155 bytes) and `name` (100 bytes),
 * joined with "/". Implemented rather than avoided by shortening names: the
 * bundle's paths carry the subject's uuid twice (once in the root directory,
 * once in the content filename) because an auditor holding several bundles
 * needs to tell them apart from the extracted tree alone, and truncating the
 * id to fit a header field would be an evidence artifact losing information to
 * an archive format's 1988 layout.
 */
function splitUstarPath(full: string): { name: string; prefix: string } {
  if (Buffer.byteLength(full, "utf8") <= 99) return { name: full, prefix: "" };
  // the LAST separator that leaves a name short enough, so the prefix carries
  // as much of the path as it can
  for (let i = full.length - 1; i > 0; i--) {
    if (full[i] !== "/") continue;
    const name = full.slice(i + 1);
    const prefix = full.slice(0, i);
    if (Buffer.byteLength(name, "utf8") <= 99 && Buffer.byteLength(prefix, "utf8") <= 154) {
      return { name, prefix };
    }
  }
  throw new Error(`export bundle: path too long for ustar (${full})`);
}

function tarHeader(full: string, size: number): Buffer {
  const { name, prefix } = splitUstarPath(full);
  const h = Buffer.alloc(512);
  const put = (s: string, off: number, len: number) => h.write(s, off, len, "utf8");
  const oct = (n: number, off: number, len: number) =>
    h.write(n.toString(8).padStart(len - 1, "0") + "\0", off, len, "ascii");

  put(name, 0, 100);
  oct(0o644, 100, 8); // mode
  oct(0, 108, 8); // uid
  oct(0, 116, 8); // gid
  oct(size, 124, 12);
  oct(0, 136, 12); // mtime — pinned to the epoch, see above
  h.write("        ", 148, 8, "ascii"); // checksum placeholder
  h.write("0", 156, 1, "ascii"); // typeflag: regular file
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  if (prefix) put(prefix, 345, 155);

  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

export function buildTarGz(files: Array<{ path: string; body: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(tarHeader(f.path, f.body.length));
    parts.push(f.body);
    const pad = (512 - (f.body.length % 512)) % 512;
    if (pad > 0) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // two zero blocks: end of archive
  // Node's gzip writes MTIME=0 in the header unconditionally, so the archive
  // bytes are a pure function of the file list.
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

export interface ExportSubject {
  /** which producer made this — `report-run`, `audit-log`, … */
  kind: string;
  /** the id an auditor can quote back. `null` for a query-shaped export. */
  id: string | null;
  /** free-form, canonicalised into the signed manifest */
  descriptor: Record<string, unknown>;
}

export interface ExportContentFile {
  /** file name inside content/ */
  name: string;
  body: Buffer;
  contentType: string;
}

export interface BuiltBundle {
  ok: true;
  archive: Buffer;
  filename: string;
  manifest: Record<string, unknown>;
  manifestBytes: Buffer;
  signatureBase64: string;
  keyId: string;
  fingerprint: string;
}

function sha256Hex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

const README = (m: {
  keyId: string;
  fingerprint: string;
  subjectKind: string;
  segmentNote: string;
  payloadScope: "full" | "subject";
}) => `RegulAIt signed export bundle
=============================

HOW TO VERIFY THIS BUNDLE WITHOUT US
------------------------------------
You need: openssl, sha256sum (or shasum), tar, and a POSIX shell. You do NOT
need a RegulAIt installation, a database, a network connection, a portal login,
or any contact with the vendor.

    scripts/verify-export-bundle.sh <this-bundle.tar.gz> \\
        --fingerprint ${m.fingerprint}

THE FINGERPRINT ABOVE IS PRINTED HERE FOR CONVENIENCE AND IS NOT THE AUTHORITY.
Take the fingerprint you compare against from the organisation that operates
this deployment, out of band, ONCE — not from this file, and not from the
public key shipped beside it. Anyone can alter a bundle, sign it with a key
they just made, and write that key's fingerprint into this README. The check
only means something when the value you pass to --fingerprint came from
somewhere the person who produced this bundle could not edit.

WHAT A PASSING VERIFICATION PROVES
----------------------------------
  * The content in content/ is byte-for-byte what was signed.
  * It was signed by the private key whose fingerprint you supplied — key id
    '${m.keyId}'.
  * Disclosed audit payloads hash to their content hashes in audit/chain.tsv.
    Every row's signed hash commitment links into a contiguous chain ending
    at the head recorded in the signed manifest.
  * The export happened at the time the signed manifest records, by the
    database's own clock, and was performed by the recorded actor.

WHAT IT DOES NOT PROVE
----------------------
  * It does not prove the underlying records are TRUE. An operator with
    administrative access to the source database could, in principle, rewrite
    the audit log wholesale and re-derive a consistent chain before exporting.
    Detecting THAT requires an anchor written outside the deployment's control
    (RegulAIt writes chain heads to WORM storage; see POST /v1/audit/anchor).
    If you retained such an anchor, compare it to the head in the manifest.
  * ${m.segmentNote}
  * ${m.payloadScope === "subject" ? "Only the report's own audit payloads are disclosed. Other rows carry signed hash commitments, so their underlying content cannot be independently rehashed from this bundle." : "All audit payloads in the chain segment are disclosed."}
  * It does not prove the export is COMPLETE with respect to any query you did
    not specify. The manifest's subject descriptor records exactly what was
    asked for, including any row ceiling or date window that shaped it.
  * It says nothing about the vendor. This key is the DEPLOYMENT's key, held by
    the organisation that runs it, not by the software vendor. A vendor
    signature would not be able to attest to this customer's data anyway.

WHAT IS IN HERE
---------------
  manifest.json             the signed object; canonical JSON, sorted keys
  manifest.json.sig         base64 Ed25519 signature over manifest.json's bytes
  content/                  the export itself (subject kind: ${m.subjectKind})
  audit/chain.tsv           seq, content_hash, prev_hash, row_hash${m.payloadScope === "subject" ? ", payload|commitment" : ""}
  audit/rows/<seq>.payload  exact bytes for ${m.payloadScope === "subject" ? "subject rows only" : "every chain row"}
  signing-key.pub           the public key — a convenience, NOT the trust root
`;

/**
 * Build a signed bundle. Returns a refusal object rather than throwing when no
 * key is configured, so the route can turn it into an honest 409.
 */
export async function buildExportBundle(args: {
  db: Db;
  subject: ExportSubject;
  content: ExportContentFile[];
  actor: { userId: string | null; via: string };
  licenseId: string | null;
  auditPayloadScope?: "full" | "subject";
}): Promise<BuiltBundle | ExportSigningRefusal> {
  const key = resolveExportSigningKey();
  if (!key.ok) return key;

  // The DATABASE clock, not this process's. A bundle timestamped by the host
  // is timestamped by the one clock an operator can trivially move, and the
  // audit rows it is bundled with are stamped by Postgres.
  const clock = await args.db.execute(sql`select now() as now`);
  const exportedAt = new Date(
    (clock as unknown as { rows: Array<{ now: string | Date }> }).rows[0]?.now ?? Date.now(),
  ).toISOString();

  const segment = await readChainSegment(args.db, args.subject.id);
  const payloadScope = args.auditPayloadScope ?? "full";

  // The actor's NAME as the deployment knows it, resolved here rather than
  // taken from the request: an auditor reading a bundle six months later needs
  // a human to ask, and a uuid alone is not one.
  let actorName: string | null = null;
  if (args.actor.userId) {
    const found = await args.db
      .select({ displayName: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, args.actor.userId))
      .limit(1);
    actorName = found[0] ? found[0].displayName || found[0].email : null;
  }
  const install = await resolveInstallIdentity(args.db, args.licenseId);

  const files: Array<{ path: string; body: Buffer }> = [];
  const listed: Array<{ path: string; sha256: string }> = [];

  const addListed = (p: string, body: Buffer) => {
    files.push({ path: p, body });
    listed.push({ path: p, sha256: sha256Hex(body) });
  };

  for (const c of args.content) addListed(`content/${c.name}`, c.body);

  const chainTsv = segment.rows
    .map((r) => `${r.seq}\t${r.contentHash}\t${r.prevHash}\t${r.rowHash}${payloadScope === "subject" ? `\t${r.subject ? "payload" : "commitment"}` : ""}`)
    .join("\n");
  addListed("audit/chain.tsv", Buffer.from(chainTsv.length > 0 ? `${chainTsv}\n` : "", "utf8"));

  // The payload files are NOT in `files[]`: their digests ARE the content
  // hashes in chain.tsv, and chain.tsv is itself listed and signed. Listing
  // them twice would let the two lists disagree.
  const payloadFiles = segment.rows.filter((r) => payloadScope === "full" || r.subject).map((r) => ({
    path: `audit/rows/${r.seq}.payload`,
    body: Buffer.from(r.payload, "utf8"),
  }));

  addListed("signing-key.pub", Buffer.from(key.publicKeyPem, "utf8"));
  addListed(
    "README.txt",
    Buffer.from(
      README({
        keyId: key.keyId,
        fingerprint: key.fingerprint,
        subjectKind: args.subject.kind,
        segmentNote: segment.note,
        payloadScope,
      }),
      "utf8",
    ),
  );

  const manifest: Record<string, unknown> = {
    schema: payloadScope === "subject" ? SCOPED_EXPORT_BUNDLE_SCHEMA : EXPORT_BUNDLE_SCHEMA,
    product: "regulait",
    installId: install.installId,
    installIdSource: install.source,
    exportedAt,
    exportedAtSource: "database",
    exportedByUserId: args.actor.userId,
    exportedByDisplayName: actorName,
    exportedByAuthVia: args.actor.via,
    subject: {
      kind: args.subject.kind,
      id: args.subject.id,
      descriptor: args.subject.descriptor,
    },
    files: listed.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    audit: {
      algorithm: AUDIT_CHAIN_ALGORITHM,
      payloadVersion: AUDIT_PAYLOAD_VERSION,
      payloadScope,
      genesisPrevHash: AUDIT_GENESIS_PREV_HASH,
      genesisRowHash: AUDIT_GENESIS_ROW_HASH,
      head: segment.head,
      segmentFromSeq: segment.fromSeq,
      segmentToSeq: segment.toSeq,
      segmentRowCount: segment.rows.length,
      segmentTruncated: segment.truncated,
      subjectSeqsOmitted: segment.subjectSeqsOmitted,
      note: segment.note,
    },
    signingKeyId: key.keyId,
    signingKeyFingerprint: key.fingerprint,
    trustRootNote:
      "signing-key.pub inside this bundle is a convenience copy and is NOT the trust root. Verify " +
      "against a fingerprint obtained out of band from the operator of this deployment.",
  };

  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
  const signature = key.sign(manifestBytes);
  const signatureBase64 = signature.toString("base64");

  const root = `regulait-export-${args.subject.kind}-${(args.subject.id ?? "query").slice(0, 36)}`;
  const archive = buildTarGz(
    [
      { path: `${root}/manifest.json`, body: manifestBytes },
      { path: `${root}/manifest.json.sig`, body: Buffer.from(`${signatureBase64}\n`, "utf8") },
      ...files.map((f) => ({ path: `${root}/${f.path}`, body: f.body })),
      ...payloadFiles.map((f) => ({ path: `${root}/${f.path}`, body: f.body })),
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );

  return {
    ok: true,
    archive,
    filename: `${root}.tar.gz`,
    manifest,
    manifestBytes,
    signatureBase64,
    keyId: key.keyId,
    fingerprint: key.fingerprint,
  };
}
