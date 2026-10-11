/**
 * ADR-0189 slice B4 — the Decision BOM ASSEMBLER and FREEZE, and the AI BOM and
 * Decision BOM BUNDLES (B4.1 to B4.5, R5, R15, R40, R44, R6).
 *
 * The body is a pure function of stored rows (`assembleDecisionBom` in
 * `@regulait/shared`): the signed receipt, `decision_facts`, its signed addenda,
 * the decision row's `rule_chain`, the chain rows and the covering anchor. Live
 * tables are never a source for a historical fact (R18). Assembly and version
 * allocation hold the per-decision lock (the capture-status marker row `FOR
 * UPDATE` and the facts row, or an advisory lock keyed by the audit id for a
 * decision older than the marker) through the `decision_boms` insert, so two
 * first requests return the same frozen version (4237344247, R40).
 *
 * A request assembles a new version only when its body would differ from the
 * newest version's in anything but `id`, `version` and `supersedes` (B4.4 item
 * 5); otherwise it returns the newest frozen version, which needs no key (R6).
 * Nothing frozen is ever edited.
 */
import { sign } from "node:crypto";
import {
  and,
  asc,
  auditAnchors,
  auditLog,
  decisionBoms,
  decisionCaptureStatus,
  decisionFactAddenda,
  decisionFactAddendumSignatures,
  decisionFacts,
  decisionReceipts,
  desc,
  eq,
  gte,
  lockDecisionForBom,
  lte,
  ORG_SETTINGS_ID,
  receiptSigningKeys,
  sql,
  type Db,
} from "@regulait/db";
import {
  assembleDecisionBom,
  bomExpiresAt,
  composeAuditRetentionDays,
  decisionBomBodySchema,
  decisionBomFinalityDetail,
  DecisionBomAssemblyError,
  decisionBomSameContent,
  findEmailShapes,
  isReceiptEligibleAuditRow,
  type AnyDecisionReceiptPayload,
  type BOM_ANCHOR_PENDING_REASONS,
  type DecisionBomAnchor,
  type DecisionBomFinalitySetting,
  type DecisionBomFinalityState,
} from "@regulait/shared";

type BomAnchorPendingReason = (typeof BOM_ANCHOR_PENDING_REASONS)[number];
import { anchorRecordFromRow } from "./audit-timestamp.js";
import { loadReceiptSigningKey, ReceiptKeyError, registerReceiptSigningKey, sameReceiptPublicKey } from "./decision-receipts.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const DAY_MS = 86_400_000;
/** a decision with no flushed anchor yet: ask again in a minute (the anchor job's cadence) */
export const BOM_PENDING_RETRY_AFTER_SECONDS = 60;
/** a proof segment longer than this is not carried (the body schema's own ceiling) */
const MAX_CHAIN_ROWS = 100_000;

/** a refusal in the B4 contract's envelope (`bomErrorEnvelopeSchema`) */
export class BomRouteError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown> & { error: string },
    readonly retryAfterSeconds?: number,
  ) {
    super(String(body.detail ?? body.error));
    this.name = "BomRouteError";
  }
}
const pending = (reason: BomAnchorPendingReason, detail: string) =>
  new BomRouteError(409, { error: "bom_anchor_pending", reason, retryAfterSeconds: BOM_PENDING_RETRY_AFTER_SECONDS, detail }, BOM_PENDING_RETRY_AFTER_SECONDS);
const noReceiptKey = () =>
  new BomRouteError(409, { error: "bom_signing_unavailable", missingKey: "receipt", detail: `No receipt signing key is available (the install-generated key in REGULAIT_INSTALL_SECRETS_DIR, or REGULAIT_RECEIPT_SIGNING_KEY/_ID); see GET /v1/org/posture receiptSigningKey. A Decision BOM is never stored unsigned.` });
/** a configured key that cannot be used (unreadable, malformed, or conflicting with its recorded public key) is 503, as on the AI BOM routes */
const invalidReceiptKey = () =>
  new BomRouteError(503, { error: "receipt_signing_key_invalid", detail: "The receipt signing key is configured but unusable or conflicts with its recorded public key; see GET /v1/org/posture receiptSigningKey. Nothing was stored." });

const rowsOf = <T>(r: unknown): T[] => (r as { rows?: T[] }).rows ?? [];

/** the receipt key, or null; a key that conflicts with its recorded public key is a refusal, never a fallback */
function receiptKeyOrNull() {
  try {
    return loadReceiptSigningKey();
  } catch (e) {
    if (e instanceof ReceiptKeyError) throw invalidReceiptKey();
    throw e;
  }
}

export interface DecisionBomSettings {
  floor: DecisionBomFinalitySetting;
  finiteLock: "refuse" | "accept";
  timestampMode: "required" | "off";
  retainedDays: number | null;
}
export async function loadDecisionBomSettings(tx: { execute: Db["execute"] }): Promise<DecisionBomSettings> {
  const [row] = rowsOf<{ floor: string | null; finite: string | null; ts: string | null; org_days: number | string | null; profile_days: number | string | null }>(
    await tx.execute(sql`select
      (select "decision_bom_finality" from "org_settings" where "id" = ${ORG_SETTINGS_ID}) as "floor",
      (select "decision_bom_finite_lock_finality" from "org_settings" where "id" = ${ORG_SETTINGS_ID}) as "finite",
      (select "audit_anchor_timestamp_mode" from "org_settings" where "id" = ${ORG_SETTINGS_ID}) as "ts",
      (select "default_audit_retention_days" from "org_settings" where "id" = ${ORG_SETTINGS_ID}) as "org_days",
      (select max("audit_retention_days") from "compliance_profiles") as "profile_days"`),
  );
  const days = (v: number | string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  // a missing settings row reads as the strict column defaults (ADR-0180)
  return {
    floor: row?.floor === "anchored_unverified_destination" || row?.floor === "chain_signed" ? row.floor : "anchored",
    finiteLock: row?.finite === "accept" ? "accept" : "refuse",
    timestampMode: row?.ts === "off" ? "off" : "required",
    retainedDays: composeAuditRetentionDays([days(row?.profile_days)], days(row?.org_days)),
  };
}

/** a `decision_boms` row as the routes return it */
export type DecisionBomRow = typeof decisionBoms.$inferSelect;

/** the versions of one decision's BOM, ascending */
export async function listDecisionBomVersions(db: Pick<Db, "select">, auditId: string): Promise<DecisionBomRow[]> {
  return db.select().from(decisionBoms).where(eq(decisionBoms.auditId, auditId)).orderBy(asc(decisionBoms.version));
}

/** the anchor row as the body carries it (R1, R4, R33, R44, G4); the token is the stored reply DER, base64 */
export function decisionBomAnchorOf(row: typeof auditAnchors.$inferSelect): DecisionBomAnchor {
  const record = anchorRecordFromRow(row);
  let token: string | null = null;
  if (row.tsaStatus === "granted" && row.tsaToken) {
    if (row.tsaToken.startsWith("{")) {
      const stored = JSON.parse(row.tsaToken) as { replyDer?: unknown };
      token = typeof stored.replyDer === "string" ? stored.replyDer : null;
    } else token = row.tsaToken;
  }
  return {
    id: row.id,
    record: { seq: record.seq, rowHash: record.rowHash, headAt: record.headAt, algorithm: record.algorithm, payloadVersion: record.payloadVersion, capturedAt: record.capturedAt },
    destination: row.destination,
    status: row.status,
    externalRef: row.externalRef,
    flushedAt: row.flushedAt?.toISOString() ?? null,
    tamperResistant: row.tamperResistant,
    observationMode: row.tamperObservationMode ?? null,
    observedAt: row.tamperObservedAt?.toISOString() ?? null,
    retainUntil: row.retainUntil?.toISOString() ?? null,
    tsa:
      token && row.tsaGenTime && row.tsaMessageImprint
        ? {
            token,
            genTime: row.tsaGenTime.toISOString(),
            messageImprint: row.tsaMessageImprint,
            policyOid: row.tsaPolicyOid,
            nonce: row.tsaNonce,
            requestSentAt: row.tsaRequestSentAt?.toISOString() ?? null,
            requestFactsLegacy: row.tsaRequestFactsLegacy,
          }
        : null,
  };
}

/**
 * The FREEZE (B4.4 Freezing 1 to 5). Returns the newest frozen version, assembling and freezing a new one first when
 * the recorded facts support a body that differs from it. Throws `BomRouteError` with the contract's refusal.
 */
export async function freezeDecisionBom(db: Db, auditId: string, actorUserId: string | null): Promise<{ row: DecisionBomRow; created: boolean }> {
  return db.transaction(async (tx) => {
    // 1. the per-decision lock (4237344247, R40): the marker row, then the facts row; an advisory lock without a marker
    // (READ COMMITTED: every read below is taken after the lock is held, so it sees the previous holder's commit)
    await lockDecisionForBom(tx, auditId);
    const [marker] = await tx.select().from(decisionCaptureStatus).where(eq(decisionCaptureStatus.auditId, auditId));
    const [factsRow] = marker ? await tx.select().from(decisionFacts).where(eq(decisionFacts.auditId, auditId)).for("update") : [];
    const [newest] = await tx.select().from(decisionBoms).where(eq(decisionBoms.auditId, auditId)).orderBy(desc(decisionBoms.version)).limit(1);

    const [audit] = await tx
      .select({ id: auditLog.id, seq: auditLog.seq, at: auditLog.at, objectType: auditLog.objectType, detail: auditLog.detail, ruleChain: auditLog.ruleChain })
      .from(auditLog)
      .where(eq(auditLog.id, auditId));
    if (!audit) {
      // R16: the audit row may be pruned while its frozen BOM is retained; the newest frozen version still reads
      if (newest) return { row: newest, created: false };
      throw new BomRouteError(404, { error: "bom_decision_not_found" });
    }
    if (audit.seq === null || !isReceiptEligibleAuditRow(audit)) {
      throw new BomRouteError(422, { error: "bom_decision_not_eligible", detail: "Only a receipt-eligible governed decision has a Decision BOM." });
    }

    // 2. the receipt and every addendum must be signed (R15)
    const [receipt] = await tx.select().from(decisionReceipts).where(eq(decisionReceipts.auditId, auditId));
    // the key is read only where it is needed (R6: returning an already-frozen version never needs it)
    if (!receipt) throw receiptKeyOrNull() ? pending("receipt_unsigned", "The decision's receipt has not been signed yet; the receipt sweep signs it shortly.") : noReceiptKey();
    const addenda = factsRow ? await tx.select().from(decisionFactAddenda).where(eq(decisionFactAddenda.auditId, auditId)).orderBy(asc(decisionFactAddenda.n)) : [];
    const signatures = addenda.length ? await tx.select().from(decisionFactAddendumSignatures).where(eq(decisionFactAddendumSignatures.auditId, auditId)) : [];
    const signatureOf = new Map(signatures.map((s) => [s.n, s]));
    if (addenda.some((a) => !signatureOf.has(a.n) || signatureOf.get(a.n)!.factsHash !== a.factsHash)) {
      throw receiptKeyOrNull() ? pending("receipt_unsigned", "A late fact for this decision has not been signed yet; the receipt sweep signs it shortly.") : noReceiptKey();
    }
    if (marker?.status === "captured" && !factsRow) throw new BomRouteError(500, { error: "bom_integrity_failure", detail: "The decision's capture marker says captured, but its facts row is missing." });

    // 3. finality (B4.5): the strongest state any covering anchor supports
    const settings = await loadDecisionBomSettings(tx);
    const clock = rowsOf<{ now: Date | string }>(await tx.execute(sql`select now() as "now"`))[0]!;
    const now = new Date(clock.now);
    const expiresAt = marker ? marker.expiresAt : bomExpiresAt(audit.at, settings.retainedDays);
    const retainedDays = expiresAt === null ? null : Math.round((expiresAt.getTime() - audit.at.getTime()) / DAY_MS);
    const anchors = await tx
      .select()
      .from(auditAnchors)
      .where(and(gte(auditAnchors.seq, audit.seq), lte(auditAnchors.seq, audit.seq + MAX_CHAIN_ROWS - 1)))
      .orderBy(asc(auditAnchors.seq))
      .limit(64);
    const RANK: Record<DecisionBomFinalityState, number> = { anchored: 4, anchored_finite_lock: 3, anchored_unverified_destination: 2, chain_signed: 1 };
    const decide = (a: (typeof anchors)[number] | null) =>
      decisionBomFinalityDetail({
        anchor: a && { status: a.status, tamperResistant: a.tamperResistant, tsaGranted: a.tsaStatus === "granted", retainUntil: a.retainUntil },
        receiptSigned: true,
        timestampMode: settings.timestampMode,
        decisionAt: audit.at,
        retainedDays,
        now,
        setting: settings.floor,
        finiteLock: settings.finiteLock,
      });
    // every flushed covering anchor is a candidate, and so is "no anchor" (chain_signed); the strongest frozen state
    // wins, the earliest anchor on a tie; when none freezes, the first flushed anchor's shortfall is the reason
    const flushed = anchors.filter((x) => x.status === "flushed");
    const candidates = [null, ...flushed].map((anchor) => ({ anchor, result: decide(anchor) }));
    const score = (c: (typeof candidates)[number]) => (c.result.freeze ? RANK[c.result.state] : 0);
    let best = candidates.reduce((a, c) => (score(c) > score(a) ? c : a));
    if (!best.result.freeze && flushed.length) best = candidates[1]!;
    if (!best.result.freeze) {
      if (newest) return { row: newest, created: false };
      throw pending(best.result.reason, `The Decision BOM is not final yet (${best.result.reason}).`);
    }
    const finality = best.result.state;
    const anchorRow = finality === "chain_signed" ? null : best.anchor;

    // 4. the chain segment, the decision row to the anchor's seq (the decision row alone for chain_signed)
    const toSeq = anchorRow ? anchorRow.seq : audit.seq;
    const chainRows = await tx
      .select({ seq: auditLog.seq, contentHash: auditLog.contentHash, prevHash: auditLog.prevHash, rowHash: auditLog.rowHash })
      .from(auditLog)
      .where(and(gte(auditLog.seq, audit.seq), lte(auditLog.seq, toSeq)))
      .orderBy(asc(auditLog.seq));
    if (chainRows.length !== toSeq - audit.seq + 1 || chainRows.some((r) => r.seq === null || !r.contentHash || !r.prevHash || !r.rowHash)) {
      throw new BomRouteError(500, { error: "bom_integrity_failure", detail: "The audit chain segment from the decision to its anchor is not complete." });
    }

    // 5. assemble (B4.4), and keep the newest version when nothing changed (Freezing item 5)
    const idRow = rowsOf<{ id: string }>(await tx.execute(sql`select gen_random_uuid()::text as "id"`))[0]!;
    let assembled;
    try {
      assembled = assembleDecisionBom({
        id: idRow.id,
        auditId,
        version: (newest?.version ?? 0) + 1,
        supersedes: newest?.id ?? null,
        finality,
        receipt: { receiptSeq: receipt.receiptSeq, payload: receipt.payload as AnyDecisionReceiptPayload, payloadHash: receipt.payloadHash, signature: receipt.signature, keyId: receipt.keyId },
        facts: factsRow ? { facts: factsRow.facts, factsHash: factsRow.factsHash } : null,
        addenda: addenda.map((a) => ({ n: a.n, prevHash: a.prevHash, facts: a.facts, factsHash: a.factsHash, signature: signatureOf.get(a.n)!.signature, keyId: signatureOf.get(a.n)!.keyId })),
        noFactsReason: marker?.status === "capture_off" ? "capture_off" : "pre_facts",
        ruleChain: audit.ruleChain,
        chain: chainRows.map((r) => ({ seq: r.seq!, contentHash: r.contentHash!, prevHash: r.prevHash!, rowHash: r.rowHash! })),
        anchor: anchorRow ? decisionBomAnchorOf(anchorRow) : null,
      });
    } catch (e) {
      if (e instanceof DecisionBomAssemblyError) throw new BomRouteError(e.status, { error: e.code, detail: e.message });
      throw e;
    }
    if (newest && decisionBomSameContent(JSON.parse(newest.body) as Record<string, unknown>, assembled.body)) return { row: newest, created: false };

    // 6. the email scan (R10), the frozen schema, then the signature (no key, no new BOM)
    const emails = findEmailShapes(assembled.body);
    if (emails.length) throw new BomRouteError(422, { error: "bom_export_refused", reason: "email_shape", file: "body", path: emails[0]!.slice(0, 1024) });
    if (!decisionBomBodySchema.safeParse(assembled.body).success) throw new BomRouteError(500, { error: "bom_integrity_failure", detail: "The assembled body does not meet regulait.decision-bom.v1." });
    const key = receiptKeyOrNull();
    if (!key) throw noReceiptKey();
    const [recorded] = await tx.select().from(receiptSigningKeys).where(eq(receiptSigningKeys.keyId, key.keyId));
    if (recorded && (!sameReceiptPublicKey(recorded.publicJwk, key.jwk) || recorded.retiredAt)) throw invalidReceiptKey();
    if (!recorded) await registerReceiptSigningKey(tx as unknown as Db, key, now, "decision-bom");
    const signature = sign(null, Buffer.from(assembled.bodyBytes, "utf8"), key.privateKey).toString("base64url");
    const [row] = await tx
      .insert(decisionBoms)
      .values({
        id: idRow.id,
        auditId,
        version: (newest?.version ?? 0) + 1,
        supersedesId: newest?.id ?? null,
        finality,
        body: assembled.bodyBytes,
        bodySha256: assembled.bodySha256,
        signature,
        keyId: key.keyId,
        basis: assembled.body.basis as Record<string, unknown>,
        aiBomSnapshotId: assembled.aiBomSnapshotId,
        expiresAt,
        createdBy: actorUserId,
      })
      .returning();
    return { row: row!, created: true };
  });
}

/** a frozen version by number (no assembly), or the newest */
export async function readDecisionBomVersion(db: Db, auditId: string, version: number | undefined): Promise<DecisionBomRow | null> {
  const where = version === undefined ? eq(decisionBoms.auditId, auditId) : and(eq(decisionBoms.auditId, auditId), eq(decisionBoms.version, version));
  const [row] = await db.select().from(decisionBoms).where(where).orderBy(desc(decisionBoms.version)).limit(1);
  return row ?? null;
}

