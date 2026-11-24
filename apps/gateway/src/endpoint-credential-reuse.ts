/**
 * ADR-0350 §11 (lane E31) — the same credential reused across endpoints, found from fingerprints only.
 *
 * Each device reports a keyed HMAC-SHA256 of every secret it finds, under the tenant's credential-reuse key
 * (`regulait-agent credential-reuse-key`). The value never leaves the device. That device key is NOT a secret from
 * the device's own users: it is in the agent config on every enrolled device, so anyone with a laptop can compute
 * device fingerprints. What protects the stored rows is a second, server-side layer: the gateway never stores the
 * device fingerprint, only `HMAC(serverKey, keyId ‖ 0x00 ‖ deviceFingerprint)`, with `serverKey` derived from the
 * gateway's deploy-time data key (HKDF-SHA-256, its own label). A copy of this table plus a laptop's key is then not
 * enough to test guesses; the attacker also needs the gateway's data key. Without a data key nothing is recorded.
 *
 * A stored value seen under the same key id by two or more active devices, or two or more device users, is a finding:
 *   - recorded on report ingest (`recordCredentialFingerprints`), raised once per reporting identity in the audit
 *     trail when it first becomes shared;
 *   - pruned on ingest: a complete report (no collection gaps) replaces the identity's set, and rows under a key id
 *     the identity no longer reports are dropped, so a rotated secret or tenant key stops counting;
 *   - listed by `GET /v1/endpoint-credential-reuse` (admin-only by the app default), which shows the first 12 hex
 *     characters of the server-keyed value only, the active devices and user pseudonyms, and the key rules that matched.
 */
import { createHmac, hkdfSync } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { and, auditLog, endpointCredentialFingerprints, eq, isNull, notInArray, sql, type Db } from "@regulait/db";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const MAX_PER_REPORT = 500;
const LIST_MAX = 200;
const HOLDERS_MAX = 50;
const SERVER_KEY_INFO = "regulait/adr0350/credential-reuse/v1";

const serverKeys = new Map<string, Buffer>();
/** the server-side fingerprint key, derived from the data key (own HKDF label); null without a usable data key */
export function credentialReuseServerKey(dataKey: string | undefined): Buffer | null {
  if (!dataKey || dataKey.length < 32) return null;
  let k = serverKeys.get(dataKey);
  if (!k) {
    k = Buffer.from(hkdfSync("sha256", Buffer.from(dataKey, "utf8"), Buffer.alloc(0), SERVER_KEY_INFO, 32));
    serverKeys.set(dataKey, k);
  }
  return k;
}

/** what is stored for a device fingerprint: never the device value itself */
export function storedFingerprint(serverKey: Buffer, keyId: string, deviceFingerprint: string): string {
  return createHmac("sha256", serverKey).update(`${keyId}\u0000${deviceFingerprint}`).digest("hex");
}

export interface ReportedKey {
  ruleId?: string;
  fingerprint?: string;
  fingerprintKeyId?: string;
}

export interface RecordOptions {
  /** the gateway's data key; without one nothing is recorded (fail closed) */
  dataKey: string | undefined;
  /** the report read everything it was asked to (no gaps): its set replaces the identity's stored set */
  complete: boolean;
}

/**
 * Record a report's fingerprints for one agent identity, prune what it no longer holds, and raise a finding for each
 * that is now shared with another active device or user. Facts the report path refused are not passed in.
 */
export async function recordCredentialFingerprints(db: Db, identityId: string, keys: readonly ReportedKey[], opts: RecordOptions): Promise<{ recorded: number; reused: number; pruned: number }> {
  const serverKey = credentialReuseServerKey(opts.dataKey);
  if (!serverKey) return { recorded: 0, reused: 0, pruned: 0 };
  const seen = new Map<string, { keyId: string; fingerprint: string; ruleId: string | null }>();
  let truncated = false;
  for (const k of keys) {
    if (!k.fingerprint || !k.fingerprintKeyId) continue;
    if (seen.size >= MAX_PER_REPORT) {
      truncated = true;
      break;
    }
    const fingerprint = storedFingerprint(serverKey, k.fingerprintKeyId, k.fingerprint);
    seen.set(`${k.fingerprintKeyId}:${fingerprint}`, { keyId: k.fingerprintKeyId, fingerprint, ruleId: k.ruleId ?? null });
  }
  const rows = [...seen.values()];
  const pruned = await pruneFingerprints(db, identityId, rows, opts.complete && !truncated);
  if (!rows.length) return { recorded: 0, reused: 0, pruned };
  await db
    .insert(endpointCredentialFingerprints)
    .values(rows.map((r) => ({ identityId, ...r })))
    .onConflictDoUpdate({
      target: [endpointCredentialFingerprints.identityId, endpointCredentialFingerprints.keyId, endpointCredentialFingerprints.fingerprint],
      set: { lastSeenAt: sql`now()`, ruleId: sql`excluded.rule_id` },
    });
  // shared now, and not yet reported for this identity: one finding each, raised once
  const shared = await db.execute(sql`
    SELECT f.key_id, f.fingerprint
      FROM endpoint_credential_fingerprints f
      JOIN endpoint_agent_identities i ON i.identity_id = f.identity_id
     WHERE f.identity_id = ${identityId} AND f.reuse_reported_at IS NULL
       AND EXISTS (SELECT 1 FROM endpoint_credential_fingerprints o
                     JOIN endpoint_agent_identities oi ON oi.identity_id = o.identity_id
                     JOIN endpoint_devices od ON od.id = oi.device_id AND od.revoked_at IS NULL
                    WHERE o.key_id = f.key_id AND o.fingerprint = f.fingerprint AND o.identity_id <> f.identity_id
                      AND (oi.device_id <> i.device_id OR oi.device_user_pseudonym <> i.device_user_pseudonym))`);
  const hits = shared.rows as Array<{ key_id: string; fingerprint: string }>;
  for (const h of hits) {
    const [marked] = await db
      .update(endpointCredentialFingerprints)
      .set({ reuseReportedAt: sql`now()` })
      .where(and(eq(endpointCredentialFingerprints.identityId, identityId), eq(endpointCredentialFingerprints.keyId, h.key_id), eq(endpointCredentialFingerprints.fingerprint, h.fingerprint), isNull(endpointCredentialFingerprints.reuseReportedAt)))
      .returning({ identityId: endpointCredentialFingerprints.identityId });
    if (!marked) continue;
    await db.insert(auditLog).values({
      userId: NIL_UUID,
      objectType: "endpoint_credential_reuse",
      objectId: identityId,
      detail: { adr: "ADR-0350", keyId: h.key_id, fingerprintPrefix: h.fingerprint.slice(0, 12) },
      effect: "deny",
      ruleId: "endpoint-credential-reuse-detected",
      ruleChain: [],
      reason: "the same credential fingerprint is on another endpoint or user",
    });
  }
  return { recorded: rows.length, reused: hits.length, pruned };
}

/**
 * Drop what this identity no longer holds. Rows under a key id the report does not use are dropped whenever the
 * report carries fingerprints (the tenant key was rotated). A complete report also replaces the set: any stored value
 * it did not report is gone (the secret was rotated or removed). A report with gaps never prunes by value.
 */
async function pruneFingerprints(db: Db, identityId: string, rows: ReadonlyArray<{ keyId: string; fingerprint: string }>, complete: boolean): Promise<number> {
  const t = endpointCredentialFingerprints;
  const keyIds = [...new Set(rows.map((r) => r.keyId))];
  let pruned = 0;
  if (keyIds.length) {
    pruned += (await db.delete(t).where(and(eq(t.identityId, identityId), notInArray(t.keyId, keyIds))).returning({ k: t.keyId })).length;
  }
  if (complete) {
    const keep = rows.map((r) => sql`(${r.keyId}, ${r.fingerprint})`);
    const where = keep.length ? and(eq(t.identityId, identityId), sql`(${t.keyId}, ${t.fingerprint}) NOT IN (${sql.join(keep, sql`, `)})`) : eq(t.identityId, identityId);
    pruned += (await db.delete(t).where(where).returning({ k: t.keyId })).length;
  }
  return pruned;
}

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(LIST_MAX).default(50) }).strict();

/** Reuse groups: fingerprints held by two or more active devices or users under the same key id, most widely held first. */
export async function listCredentialReuse(db: Db, limit: number) {
  const groups = (
    await db.execute(sql`
      SELECT f.key_id, f.fingerprint, count(DISTINCT i.device_id)::int AS devices, count(DISTINCT i.device_user_pseudonym)::int AS users,
             min(f.first_seen_at) AS first_seen_at, max(f.last_seen_at) AS last_seen_at
        FROM endpoint_credential_fingerprints f
        JOIN endpoint_agent_identities i ON i.identity_id = f.identity_id
        JOIN endpoint_devices d ON d.id = i.device_id AND d.revoked_at IS NULL
       GROUP BY f.key_id, f.fingerprint
      HAVING count(DISTINCT i.device_id) > 1 OR count(DISTINCT i.device_user_pseudonym) > 1
       ORDER BY count(DISTINCT i.device_id) DESC, max(f.last_seen_at) DESC
       LIMIT ${limit}`)
  ).rows as Array<{ key_id: string; fingerprint: string; devices: number; users: number; first_seen_at: string | Date; last_seen_at: string | Date }>;
  if (!groups.length) return [];
  // the active holders of each group, at most HOLDERS_MAX per group (the counts above are the full ones)
  const pairs = groups.map((g) => sql`(${g.key_id}, ${g.fingerprint})`);
  const holders = (
    await db.execute(sql`
      SELECT key_id, fingerprint, rule_id, device_id, device_pseudonym, user_pseudonym FROM (
        SELECT f.key_id, f.fingerprint, f.rule_id, i.device_id, d.device_pseudonym, i.device_user_pseudonym AS user_pseudonym,
               row_number() OVER (PARTITION BY f.key_id, f.fingerprint ORDER BY f.last_seen_at DESC) AS n
          FROM endpoint_credential_fingerprints f
          JOIN endpoint_agent_identities i ON i.identity_id = f.identity_id
          JOIN endpoint_devices d ON d.id = i.device_id AND d.revoked_at IS NULL
         WHERE (f.key_id, f.fingerprint) IN (${sql.join(pairs, sql`, `)})
      ) h WHERE n <= ${HOLDERS_MAX}`)
  ).rows as Array<{ key_id: string; fingerprint: string; rule_id: string | null; device_id: string; device_pseudonym: string; user_pseudonym: string }>;
  return groups.map((g) => {
    const mine = holders.filter((h) => h.key_id === g.key_id && h.fingerprint === g.fingerprint);
    return {
      keyId: g.key_id,
      fingerprintPrefix: g.fingerprint.slice(0, 12),
      deviceCount: g.devices,
      userCount: g.users,
      devices: [...new Map(mine.map((h) => [h.device_id, { deviceId: h.device_id, pseudonym: h.device_pseudonym }])).values()],
      userPseudonyms: [...new Set(mine.map((h) => h.user_pseudonym))].sort(),
      ruleIds: [...new Set(mine.map((h) => h.rule_id).filter((r): r is string => r !== null))].sort(),
      firstSeenAt: new Date(g.first_seen_at).toISOString(),
      lastSeenAt: new Date(g.last_seen_at).toISOString(),
    };
  });
}

const refuse = (reply: FastifyReply, status: number, error: string, detail: string) => reply.status(status).send({ error, detail });

/** Admin-only by the app default (not in NON_ADMIN_ROUTES); read-only. */
export function registerEndpointCredentialReuseRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/endpoint-credential-reuse", async (req, reply) => {
    const q = listQuery.safeParse(req.query ?? {});
    if (!q.success) return refuse(reply, 400, "invalid_query", q.error.issues.map((i) => i.message).join("; "));
    return { items: await listCredentialReuse(db, q.data.limit) };
  });
}
