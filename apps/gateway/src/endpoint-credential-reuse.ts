/**
 * ADR-0350 §11 (lane E31) — the same credential reused across endpoints, found from fingerprints only.
 *
 * Each device reports a keyed HMAC-SHA256 of every secret it finds, under the tenant's credential-reuse key
 * (`regulait-agent credential-reuse-key`, deployed in the agent's root-owned config). The value never leaves the
 * device and this control plane never holds the key, so a copy of these rows cannot be used to test guesses. A
 * fingerprint seen under the same key id by two or more devices, or two or more device users, is a finding:
 *   - recorded on report ingest (`recordCredentialFingerprints`), raised once per reporting identity in the audit
 *     trail when it first becomes shared;
 *   - listed by `GET /v1/endpoint-credential-reuse` (admin-only by the app default), which shows a fingerprint's
 *     first 12 hex characters only, the devices and user pseudonyms, and the key rules that matched.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { and, auditLog, endpointAgentIdentities, endpointCredentialFingerprints, endpointDevices, eq, inArray, isNull, sql, type Db } from "@regulait/db";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const MAX_PER_REPORT = 500;
const LIST_MAX = 200;

export interface ReportedKey {
  ruleId?: string;
  fingerprint?: string;
  fingerprintKeyId?: string;
}

/**
 * Record a report's fingerprints for one agent identity and raise a finding for each that is now shared with another
 * device or user. Facts the report path refused are not passed in.
 */
export async function recordCredentialFingerprints(db: Db, identityId: string, keys: readonly ReportedKey[]): Promise<{ recorded: number; reused: number }> {
  const seen = new Map<string, { keyId: string; fingerprint: string; ruleId: string | null }>();
  for (const k of keys) {
    if (!k.fingerprint || !k.fingerprintKeyId) continue;
    seen.set(`${k.fingerprintKeyId}:${k.fingerprint}`, { keyId: k.fingerprintKeyId, fingerprint: k.fingerprint, ruleId: k.ruleId ?? null });
    if (seen.size >= MAX_PER_REPORT) break;
  }
  if (!seen.size) return { recorded: 0, reused: 0 };
  const rows = [...seen.values()];
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
  return { recorded: rows.length, reused: hits.length };
}

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(LIST_MAX).default(50) }).strict();

/** Reuse groups: fingerprints held by two or more devices or users under the same key id, most widely held first. */
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
  const holders = await db
    .select({
      keyId: endpointCredentialFingerprints.keyId,
      fingerprint: endpointCredentialFingerprints.fingerprint,
      ruleId: endpointCredentialFingerprints.ruleId,
      deviceId: endpointAgentIdentities.deviceId,
      devicePseudonym: endpointDevices.devicePseudonym,
      userPseudonym: endpointAgentIdentities.deviceUserPseudonym,
    })
    .from(endpointCredentialFingerprints)
    .innerJoin(endpointAgentIdentities, eq(endpointAgentIdentities.identityId, endpointCredentialFingerprints.identityId))
    .innerJoin(endpointDevices, eq(endpointDevices.id, endpointAgentIdentities.deviceId))
    .where(inArray(endpointCredentialFingerprints.fingerprint, groups.map((g) => g.fingerprint)));
  return groups.map((g) => {
    const mine = holders.filter((h) => h.keyId === g.key_id && h.fingerprint === g.fingerprint);
    return {
      keyId: g.key_id,
      fingerprintPrefix: g.fingerprint.slice(0, 12),
      devices: [...new Map(mine.map((h) => [h.deviceId, { deviceId: h.deviceId, pseudonym: h.devicePseudonym }])).values()],
      userPseudonyms: [...new Set(mine.map((h) => h.userPseudonym))].sort(),
      ruleIds: [...new Set(mine.map((h) => h.ruleId).filter((r): r is string => r !== null))].sort(),
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
