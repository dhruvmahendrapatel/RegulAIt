/**
 * ADR-0193 (I4) first slice: content provenance P0 and P1 at the gateway's interception point.
 *
 * P0 (`recordContentProvenance`): at a governed return path (an MCP tool result, a connector result) the label and
 * BOTH digests are written as evidence, in one transaction: a provenance audit row whose `detail.contentProvenance`
 * is the label (so the row's content hash, the chain and the anchors cover it; the covering anchor's RFC 3161 token
 * is the timestamp evidence, decision 4) and a `content_provenance_records` row (append-only) that names that audit
 * row and the decision that allowed the call. Keyed (pii, or unscanned) digests use the per-tenant key in
 * `content_digest_keys`, a data-key envelope made on first use, the same custody as ADR-0195's pseudonym key; the key
 * never leaves the control plane. No signing here: signing and export are P2/P3 (decision 2).
 *
 * P1 (`contentTrustGate`): the kernel rule. A WRITE whose causal context (an orchestration run, a builder thread)
 * already holds content from a source below the write floor is refused. The context's tier is the lowest of every
 * recorded tier and every source's CURRENT tier, so demoting a source takes effect for content already in a run,
 * and promoting one never raises content that was observed under a lower tier.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  and,
  asc,
  auditLog,
  contentDigestKeys,
  contentProvenanceRecords,
  contentTrustSettings,
  contentTrustTiers,
  eq,
  inArray,
  sql,
  type Db,
} from "@regulait/db";
import {
  buildContentProvenanceLabel,
  DEFAULT_CONTENT_TRUST_TIER,
  DEFAULT_CONTENT_TRUST_WRITE_FLOOR,
  evaluateContentTrust,
  isContentTrustTier,
  isContentTrustWriteFloor,
  tierSourceOf,
  type ContentClassification,
  type ContentProvenanceLabel,
  type ContentProvenanceSource,
  type ContentSourceKind,
  type ContentTrustTier,
  type ContentTrustVerdict,
  type ContentTrustWriteFloor,
} from "@regulait/shared";
import { dataKeyFingerprint, decryptSecret, encryptSecret, FINGERPRINT_PREFIX } from "./secrets.js";

/**
 * The per-tenant content digest key, made on first use; null when no data key is configured. Found by the envelope's
 * key-fingerprint segment, so it is the key sealed under THIS data key: a deployment runs one data key (the boot gate
 * refuses another), so there is one row: concurrent first uses take an advisory lock on the marker, so exactly one of
 * them creates it. After a re-encryption walk the row carries the new key's marker; a call made under the new key
 * before the walk reached the row makes a second one, and the oldest wins from then on. Every record names the row it
 * was keyed under, so both stay verifiable.
 */
export async function contentDigestKey(db: Db, dataKey: string | undefined): Promise<{ id: string; bytes: Buffer } | null> {
  if (!dataKey) return null;
  const marker = dataKeyFingerprint(dataKey).slice(FINGERPRINT_PREFIX.length);
  const read = async (q: Pick<Db, "select"> = db) =>
    (
      await q
        .select()
        .from(contentDigestKeys)
        .where(sql`split_part(${contentDigestKeys.keyCiphertext}, '.', 4) = ${marker}`)
        .orderBy(asc(contentDigestKeys.createdAt), asc(contentDigestKeys.id))
        .limit(1)
    )[0];
  let row = await read();
  if (!row) {
    // first use: concurrent callers serialise on this marker's lock, so the second one finds the first one's row
    // instead of inserting its own (R1 on PR #428). A unique index per marker cannot do this, because a re-encryption
    // walk legitimately leaves two rows under one marker. When `db` is already a transaction the lock is held until
    // it commits, which is when the new row becomes visible to the waiters.
    row = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`content_digest_key:${marker}`}, 0))`);
      const found = await read(tx);
      if (found) return found;
      await tx.insert(contentDigestKeys).values({ keyCiphertext: encryptSecret(dataKey, randomBytes(32).toString("hex")) });
      return read(tx);
    });
  }
  if (!row) throw new Error("the content digest key could not be created");
  return { id: row.id, bytes: Buffer.from(decryptSecret(dataKey, row.keyCiphertext), "hex") };
}

/** a source's admin-set tier; a source nobody has classified is `untrusted` */
export async function sourceTrustTier(db: Db, kind: ContentSourceKind, id: string): Promise<ContentTrustTier> {
  const [row] = await db
    .select({ tier: contentTrustTiers.tier })
    .from(contentTrustTiers)
    .where(and(eq(contentTrustTiers.sourceKind, kind), eq(contentTrustTiers.sourceId, id)));
  return row && isContentTrustTier(row.tier) ? row.tier : DEFAULT_CONTENT_TRUST_TIER;
}

/** the write floor; a missing or unreadable row reads as the strict default */
export async function contentTrustWriteFloor(db: Db): Promise<ContentTrustWriteFloor> {
  const [row] = await db.select({ writeFloor: contentTrustSettings.writeFloor }).from(contentTrustSettings).where(eq(contentTrustSettings.id, 1));
  return row && isContentTrustWriteFloor(row.writeFloor) ? row.writeFloor : DEFAULT_CONTENT_TRUST_WRITE_FLOOR;
}

/**
 * The classification a digest is keyed on. `pii` when the scan found PII (or withheld the result for it), `clean`
 * when a scan ran and found none, `unscanned` when none ran (an unattributed call, or encoded content the scanner
 * could not read). Only `clean` gets a plain digest.
 */
export function classifyScannedContent(input: { scanned: boolean; piiHits: number; piiWithheld: boolean }): ContentClassification {
  if (input.piiHits > 0 || input.piiWithheld) return "pii";
  return input.scanned ? "clean" : "unscanned";
}

/**
 * P0: write the label and digests as evidence. `db` may be a transaction (the connector path writes its evidence in
 * one); otherwise the two rows are written in a transaction of their own. Throws if the evidence cannot be written:
 * the caller delivers nothing it has no record of.
 */
export async function recordContentProvenance(
  db: Db,
  dataKey: string | undefined,
  input: {
    userId: string;
    source: ContentProvenanceSource;
    upstream: unknown;
    delivered: unknown;
    classification: ContentClassification;
    decisionAuditId: string;
    contextId: string | null;
    projectId: string | null;
  },
): Promise<ContentProvenanceLabel> {
  const tierSource = tierSourceOf(input.source);
  const trustTier = await sourceTrustTier(db, tierSource.kind, tierSource.id);
  const key = input.classification === "clean" ? null : await contentDigestKey(db, dataKey);
  const label = buildContentProvenanceLabel({
    source: input.source,
    trustTier,
    classification: input.classification,
    upstream: input.upstream,
    delivered: input.delivered,
    key,
    decisionAuditId: input.decisionAuditId,
    contextId: input.contextId,
  });
  const recordId = randomUUID();
  const auditId = randomUUID();
  const sourceDetail =
    input.source.kind === "mcp_tool" ? input.source.toolName : `${input.source.operation}${input.source.object ? `:${input.source.object}` : ""}`;
  await db.transaction(async (tx) => {
    await tx.insert(auditLog).values({
      id: auditId,
      userId: input.userId,
      objectType: "content_provenance",
      objectId: recordId,
      detail: { contentProvenance: label, recordId, projectId: input.projectId },
      effect: "allow",
      ruleId: "content-provenance",
      ruleChain: [],
      reason:
        `content provenance recorded: ${label.source.kind} from a ${trustTier} source, ${label.classification}, ` +
        `digest ${label.digest.alg}`,
    });
    await tx.insert(contentProvenanceRecords).values({
      id: recordId,
      auditId,
      decisionAuditId: input.decisionAuditId,
      contextId: input.contextId,
      sourceKind: tierSource.kind,
      sourceId: tierSource.id,
      sourceDetail,
      trustTier,
      classification: label.classification,
      digestAlg: label.digest.alg,
      digestKeyId: label.digest.keyId,
      upstreamDigest: label.digest.upstream,
      deliveredDigest: label.digest.delivered,
      label,
    });
  });
  return label;
}

/** the tiers of every piece of content recorded in a causal context, each at the lower of recorded and current */
export async function contextContentTiers(db: Db, contextId: string): Promise<ContentTrustTier[]> {
  const recorded = await db
    .selectDistinct({ sourceKind: contentProvenanceRecords.sourceKind, sourceId: contentProvenanceRecords.sourceId, tier: contentProvenanceRecords.trustTier })
    .from(contentProvenanceRecords)
    .where(eq(contentProvenanceRecords.contextId, contextId));
  if (recorded.length === 0) return [];
  const ids = [...new Set(recorded.map((r) => r.sourceId))];
  const current = await db.select().from(contentTrustTiers).where(inArray(contentTrustTiers.sourceId, ids));
  const now = new Map(current.map((c) => [`${c.sourceKind}:${c.sourceId}`, c.tier]));
  const out: ContentTrustTier[] = [];
  for (const r of recorded) {
    out.push(r.tier as ContentTrustTier);
    const cur = now.get(`${r.sourceKind}:${r.sourceId}`);
    out.push(cur && isContentTrustTier(cur) ? cur : DEFAULT_CONTENT_TRUST_TIER);
  }
  return out;
}

/** P1: may this action run, given what is already in its causal context? */
export async function contentTrustGate(db: Db, action: "read" | "write", contextId: string | null | undefined): Promise<ContentTrustVerdict> {
  if (!contextId || action === "read") return { ok: true, lowest: null };
  const [tiers, floor] = await Promise.all([contextContentTiers(db, contextId), contentTrustWriteFloor(db)]);
  return evaluateContentTrust(action, tiers, floor);
}

/** the anchor that covers an audit row (the first anchor at or past its seq), with its RFC 3161 state */
export async function coveringAnchors(
  db: Db,
  auditIds: readonly string[],
): Promise<Map<string, { anchorId: string; anchorSeq: number; tsaStatus: string; tsaGenTime: string | null }>> {
  const out = new Map<string, { anchorId: string; anchorSeq: number; tsaStatus: string; tsaGenTime: string | null }>();
  if (auditIds.length === 0) return out;
  const res = await db.execute<{ audit_id: string; anchor_id: string; anchor_seq: string | number; tsa_status: string; tsa_gen_time: Date | string | null }>(sql`
    SELECT l.id AS audit_id, a.id AS anchor_id, a.seq AS anchor_seq, a.tsa_status, a.tsa_gen_time
      FROM audit_log l
      JOIN LATERAL (
        SELECT x.id, x.seq, x.tsa_status, x.tsa_gen_time FROM audit_anchors x
         WHERE l.seq IS NOT NULL AND x.seq >= l.seq ORDER BY x.seq ASC LIMIT 1
      ) a ON true
     WHERE l.id IN (${sql.join(auditIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  for (const r of res.rows) {
    const gen = r.tsa_gen_time === null ? null : new Date(r.tsa_gen_time).toISOString();
    out.set(r.audit_id, { anchorId: r.anchor_id, anchorSeq: Number(r.anchor_seq), tsaStatus: r.tsa_status, tsaGenTime: gen });
  }
  return out;
}
