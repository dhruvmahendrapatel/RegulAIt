/**
 * ADR-0223 amendment 1 (P13b follow-up, #628 security review) — a scoped, WRITE-ONLY ingestion credential per drift
 * monitor, so a customer's pipeline pushes production summaries without an admin API key.
 *
 *   GET    /v1/model-drift/monitors/:monitorId/ingest-credentials                       admin (list; no secret)
 *   POST   /v1/model-drift/monitors/:monitorId/ingest-credentials                       admin + identity_manage step-up
 *   POST   /v1/model-drift/monitors/:monitorId/ingest-credentials/:credentialId/rotate  admin + identity_manage step-up
 *   DELETE /v1/model-drift/monitors/:monitorId/ingest-credentials/:credentialId         admin + identity_manage step-up
 *   POST   /v1/model-drift/ingest/:monitorId/reports                                    THE CREDENTIAL'S ONE ROUTE
 *
 * THE PATTERN is the repo's in-route token path (the signed feedback link, the supplier portal, SCIM): an `rgldi_`
 * token of 256 random bits, shown once, stored only as its SHA-256 (`hashToken`); the ingest route is auth-exempt
 * and non-admin for the platform hooks (`route-classes.ts`), so a platform session or key is never read there, and
 * it authenticates IN-ROUTE on `Authorization: Bearer rgldi_…` only. The token is in `scim_tokens`' position, not
 * `api_keys`', so presenting it on any other route is an ordinary 401: it opens nothing else, reads nothing (the
 * route returns only the report it just recorded) and is bound to one monitor by the row, never by the request.
 *
 * OFF UNLESS ISSUED (ADR-0180). No credential row = every request to the ingest route is 401. Issuing needs the drift
 * feature on (every drift write does); a credential always expires (default 90 days, at most 365, CHECK-capped); at
 * most two are live per monitor (a rotation overlap is not needed: rotation is atomic). Turning the feature off
 * makes every push 409 without touching the credentials; revoking works whether the feature is on or off.
 *
 * REVOCATION IS IMMEDIATE. The pre-check and the in-transaction gate both use `liveIngestCredential()` on the
 * database clock, and the gate runs inside the report's transaction after the per-monitor lock, so nothing is cached.
 *
 * REPLAY. The HMAC webhook pattern (ChatOps, outbound webhooks) needs the server to hold the secret to recompute a
 * signature, which contradicts hash-only storage, so it does not fit. Instead every push carries an `Idempotency-Key`
 * (16–128 characters): one key records one report per monitor (a partial unique index backs the check made under the
 * per-monitor lock). A repeat with the same summary returns the original report (200, `replayed: true`, nothing
 * written); a repeat with a different summary is 409. TLS protects the bearer in transit, as for every API key.
 *
 * RATE LIMITS. Per address before the lookup and per credential after it (the gateway's `@fastify/rate-limit`
 * buckets, as the feedback link and supplier portal do), plus the existing per-monitor hourly cap counted in the
 * database under the transaction lock.
 *
 * AUDIT. Issue, rotate and revoke write their audit row in the same transaction as the change. A known-but-dead
 * credential (revoked or expired) and a live credential naming another monitor are audited as denials (bounded by
 * the per-credential bucket); an unknown token is not (nothing to attribute it to). A recorded report is audited by
 * `recordDriftReport` with `detail.actor = { type: "drift_ingest_credential", id, name }`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { and, auditLog, desc, eq, modelDriftIngestCredentials, modelDriftMonitors, sql, type Db } from "@regulait/db";
import { hashToken } from "./token-hash.js";
import { requireStepUp } from "./step-up.js";
import { loadDriftSettings } from "./classical-drift-monitor.js";
import {
  INGEST_BODY_LIMIT,
  INGEST_CREDENTIAL_REFUSED,
  MODEL_DRIFT_DISABLED,
  ingestReportBody,
  liveIngestCredential,
  monitorParam,
  recordDriftReport,
} from "./classical-drift.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/** the credential's one route; listed in AUTH_EXEMPT_ROUTES and NON_ADMIN_ROUTES (route-classes.ts) */
export const DRIFT_INGEST_ROUTE = "/v1/model-drift/ingest/:monitorId/reports";
export const DRIFT_INGEST_TOKEN_PREFIX = "rgldi_";
export const DRIFT_INGEST_CREDENTIAL_LIMITS = { defaultDays: 90, maxDays: 365, maxLivePerMonitor: 2 } as const;
export const DRIFT_INGEST_RATE_LIMITS = {
  perAddress: { max: 120, windowMs: 15 * 60_000 },
  perCredential: { max: 60, windowMs: 15 * 60_000 },
} as const;
export const DRIFT_INGEST_AUDIT_RULE_IDS = {
  issued: "model-drift-ingest-credential-issued",
  rotated: "model-drift-ingest-credential-rotated",
  revoked: "model-drift-ingest-credential-revoked",
  refused: "model-drift-ingest-credential-refused",
} as const;

/** linear: a fixed prefix and one character class of fixed length (43 = base64url of 32 bytes) */
const TOKEN_RE = /^rgldi_[A-Za-z0-9_-]{43}$/;
/** linear: one character class, length-capped */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{16,128}$/;

/** 256 bits of randomness; only `hashToken(token)` is stored */
export function generateDriftIngestToken(): string {
  return DRIFT_INGEST_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** the `rgldi_` token on `Authorization: Bearer`, or null; nothing else (no cookie, no x-api-key) is read */
function presentedToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string" || h.length > 7 + 6 + 43 + 8) return null;
  if (h.slice(0, 7).toLowerCase() !== "bearer ") return null;
  const t = h.slice(7).trim();
  return TOKEN_RE.test(t) ? t : null;
}

const issueBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    expiresInDays: z.number().int().min(1).max(DRIFT_INGEST_CREDENTIAL_LIMITS.maxDays).default(DRIFT_INGEST_CREDENTIAL_LIMITS.defaultDays),
  })
  .strict();
const rotateBody = z
  .object({ expiresInDays: z.number().int().min(1).max(DRIFT_INGEST_CREDENTIAL_LIMITS.maxDays).default(DRIFT_INGEST_CREDENTIAL_LIMITS.defaultDays) })
  .strict();
const credentialParams = z.object({ monitorId: z.string().uuid(), credentialId: z.string().uuid() });

type CredentialRow = typeof modelDriftIngestCredentials.$inferSelect;
type CredentialState = "active" | "revoked" | "expired";

function credentialView(c: CredentialRow, state: CredentialState) {
  return {
    id: c.id,
    monitorId: c.monitorId,
    name: c.name,
    state,
    expiresAt: c.expiresAt.toISOString(),
    replacesId: c.replacesId,
    createdBy: c.createdBy,
    createdAt: c.createdAt.toISOString(),
    lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
    revokedAt: c.revokedAt?.toISOString() ?? null,
    revokedBy: c.revokedBy,
  };
}

/** a credential's state, decided by the one liveness predicate on the database clock */
const stateColumn = () =>
  sql<CredentialState>`CASE WHEN ${modelDriftIngestCredentials.revokedAt} IS NOT NULL THEN 'revoked' WHEN ${liveIngestCredential()} THEN 'active' ELSE 'expired' END`;

// ---------------------------------------------------------------------------------------------------------------
// rate limits (the feedback-link / supplier-portal pattern: the gateway's @fastify/rate-limit buckets)
// ---------------------------------------------------------------------------------------------------------------

type Limiter = (req: FastifyRequest) => Promise<{ isExceeded: boolean; max: number; ttlInSeconds: number; timeWindow: number }>;
const ingestBucket = new WeakMap<FastifyRequest, string>();

function ingestLimiter(app: FastifyInstance) {
  let limiter: Limiter | null = null;
  const limits = (key: string) => (key.startsWith("dic:cred:") ? DRIFT_INGEST_RATE_LIMITS.perCredential : DRIFT_INGEST_RATE_LIMITS.perAddress);
  return async (req: FastifyRequest, reply: FastifyReply, bucket: string): Promise<boolean> => {
    // REGULAIT_RATE_LIMIT=off turns every HTTP limiter off at once; these buckets follow it
    if (!app.hasDecorator("createRateLimit")) return false;
    limiter ??= app.createRateLimit({
      keyGenerator: (r: FastifyRequest) => ingestBucket.get(r) ?? `dic:addr:${r.ip}`,
      max: (_r: FastifyRequest, k: string) => limits(k).max,
      timeWindow: (_r: FastifyRequest, k: string) => limits(k).windowMs,
      allowList: () => false,
    }) as unknown as Limiter;
    ingestBucket.set(req, bucket);
    const v = await limiter(req);
    if (!v.isExceeded) return false;
    await reply.status(429).header("retry-after", String(v.ttlInSeconds)).send({
      error: "rate_limited",
      detail: `too many ingestion requests — limit ${v.max} per ${Math.round(v.timeWindow / 60_000)} minutes`,
      retryAfterSeconds: v.ttlInSeconds,
    });
    return true;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------------------------

export function registerDriftIngestCredentialRoutes(app: FastifyInstance, db: Db): void {
  const limit = ingestLimiter(app);

  async function audit(
    tx: Db,
    row: { userId: string | null; objectId: string; ruleId: string; reason: string; detail: Record<string, unknown>; effect?: "allow" | "deny" },
  ): Promise<void> {
    await tx.insert(auditLog).values({
      userId: row.userId ?? NO_IDENTITY,
      objectType: "model_drift_ingest_credential",
      objectId: row.objectId,
      detail: row.detail,
      effect: row.effect ?? "allow",
      ruleId: row.ruleId,
      ruleChain: [],
      reason: row.reason,
    });
  }

  async function monitorOr404(reply: FastifyReply, monitorId: string) {
    const [m] = await db.select({ id: modelDriftMonitors.id, name: modelDriftMonitors.name }).from(modelDriftMonitors).where(eq(modelDriftMonitors.id, monitorId));
    if (!m) await reply.status(404).send({ error: "unknown_drift_monitor" });
    return m ?? null;
  }

  /** insert one credential, returning the row and the plaintext token (shown once, never stored) */
  async function insertCredential(tx: Db, v: { monitorId: string; name: string; expiresInDays: number; createdBy: string | null; replacesId: string | null }) {
    const token = generateDriftIngestToken();
    const [row] = await tx
      .insert(modelDriftIngestCredentials)
      .values({
        monitorId: v.monitorId,
        name: v.name,
        tokenHash: hashToken(token),
        // on the database clock, so the CHECK (expires_at <= created_at + 365 days) compares like with like
        createdAt: sql`now()`,
        expiresAt: sql`now() + make_interval(days => ${v.expiresInDays})`,
        replacesId: v.replacesId,
        createdBy: v.createdBy,
      })
      .returning();
    return { row: row!, token };
  }

  app.get("/v1/model-drift/monitors/:monitorId/ingest-credentials", async (req, reply) => {
    const { monitorId } = monitorParam.parse(req.params);
    if (!(await monitorOr404(reply, monitorId))) return reply;
    const rows = await db
      .select({ c: modelDriftIngestCredentials, state: stateColumn() })
      .from(modelDriftIngestCredentials)
      .where(eq(modelDriftIngestCredentials.monitorId, monitorId))
      .orderBy(desc(modelDriftIngestCredentials.createdAt))
      .limit(100);
    return { credentials: rows.map((r) => credentialView(r.c, r.state)), ingestRoute: DRIFT_INGEST_ROUTE.replace(":monitorId", monitorId) };
  });

  app.post("/v1/model-drift/monitors/:monitorId/ingest-credentials", async (req, reply) => {
    const { monitorId } = monitorParam.parse(req.params);
    const body = issueBody.parse(req.body ?? {});
    if (!(await loadDriftSettings(db)).enabled) return reply.status(409).send(MODEL_DRIFT_DISABLED);
    const m = await monitorOr404(reply, monitorId);
    if (!m) return reply;
    const su = await requireStepUp(db, req, reply, {
      kind: "identity_manage",
      facts: { op: "drift_ingest_credential_issue", monitorId, name: body.name, expiresInDays: body.expiresInDays },
    });
    if (!su.ok) return reply;
    const userId = req.authCtx.userId ?? null;
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"model-drift-ingest:" + monitorId}))`);
      const [{ live } = { live: 0 }] = await tx
        .select({ live: sql<number>`count(*)::int` })
        .from(modelDriftIngestCredentials)
        .where(and(eq(modelDriftIngestCredentials.monitorId, monitorId), liveIngestCredential()));
      if (live >= DRIFT_INGEST_CREDENTIAL_LIMITS.maxLivePerMonitor) return null;
      const issued = await insertCredential(tx, { monitorId, name: body.name, expiresInDays: body.expiresInDays, createdBy: userId, replacesId: null });
      await audit(tx, {
        userId,
        objectId: issued.row.id,
        ruleId: DRIFT_INGEST_AUDIT_RULE_IDS.issued,
        reason: `a write-only ingestion credential '${body.name}' was issued for drift monitor '${m.name}', expiring in ${body.expiresInDays} day(s)`,
        detail: { monitorId, name: body.name, expiresAt: issued.row.expiresAt.toISOString(), expiresInDays: body.expiresInDays },
      });
      return issued;
    });
    if (!out) {
      return reply.status(409).send({
        error: "too_many_ingest_credentials",
        detail: `a monitor holds at most ${DRIFT_INGEST_CREDENTIAL_LIMITS.maxLivePerMonitor} live ingestion credentials; rotate or revoke one first`,
      });
    }
    return reply
      .status(201)
      .header("cache-control", "no-store")
      .send({ credential: credentialView(out.row, "active"), token: out.token, ingestRoute: DRIFT_INGEST_ROUTE.replace(":monitorId", monitorId) });
  });

  app.post("/v1/model-drift/monitors/:monitorId/ingest-credentials/:credentialId/rotate", async (req, reply) => {
    const { monitorId, credentialId } = credentialParams.parse(req.params);
    const body = rotateBody.parse(req.body ?? {});
    if (!(await loadDriftSettings(db)).enabled) return reply.status(409).send(MODEL_DRIFT_DISABLED);
    const m = await monitorOr404(reply, monitorId);
    if (!m) return reply;
    const [c] = await db
      .select({ c: modelDriftIngestCredentials, state: stateColumn() })
      .from(modelDriftIngestCredentials)
      .where(and(eq(modelDriftIngestCredentials.id, credentialId), eq(modelDriftIngestCredentials.monitorId, monitorId)));
    if (!c) return reply.status(404).send({ error: "unknown_ingest_credential" });
    if (c.state !== "active") return reply.status(409).send({ error: "ingest_credential_not_live", detail: `this credential is ${c.state}; issue a new one instead` });
    const su = await requireStepUp(db, req, reply, {
      kind: "identity_manage",
      facts: { op: "drift_ingest_credential_rotate", monitorId, credentialId, expiresInDays: body.expiresInDays },
    });
    if (!su.ok) return reply;
    const userId = req.authCtx.userId ?? null;
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"model-drift-ingest:" + monitorId}))`);
      // revoke the old secret first, still live, on the database clock: a concurrent revoke or expiry wins
      const [old] = await tx
        .update(modelDriftIngestCredentials)
        .set({ revokedAt: sql`now()`, revokedBy: userId })
        .where(and(eq(modelDriftIngestCredentials.id, credentialId), eq(modelDriftIngestCredentials.monitorId, monitorId), liveIngestCredential()))
        .returning();
      if (!old) return null;
      const issued = await insertCredential(tx, { monitorId, name: old.name, expiresInDays: body.expiresInDays, createdBy: userId, replacesId: old.id });
      await audit(tx, {
        userId,
        objectId: issued.row.id,
        ruleId: DRIFT_INGEST_AUDIT_RULE_IDS.rotated,
        reason: `ingestion credential '${old.name}' for drift monitor '${m.name}' was rotated: the old secret is revoked and a new one expires in ${body.expiresInDays} day(s)`,
        detail: { monitorId, name: old.name, replacedId: old.id, expiresAt: issued.row.expiresAt.toISOString(), expiresInDays: body.expiresInDays },
      });
      return issued;
    });
    if (!out) return reply.status(409).send({ error: "ingest_credential_not_live", detail: "this credential was revoked or expired meanwhile; issue a new one instead" });
    return reply
      .status(201)
      .header("cache-control", "no-store")
      .send({ credential: credentialView(out.row, "active"), token: out.token, replacedId: credentialId, ingestRoute: DRIFT_INGEST_ROUTE.replace(":monitorId", monitorId) });
  });

  // revoking tightens, so it works whether the feature is on or off; it still needs a step-up (ADR-0223 amendment 1)
  app.delete("/v1/model-drift/monitors/:monitorId/ingest-credentials/:credentialId", async (req, reply) => {
    const { monitorId, credentialId } = credentialParams.parse(req.params);
    const m = await monitorOr404(reply, monitorId);
    if (!m) return reply;
    const [c] = await db
      .select()
      .from(modelDriftIngestCredentials)
      .where(and(eq(modelDriftIngestCredentials.id, credentialId), eq(modelDriftIngestCredentials.monitorId, monitorId)));
    if (!c) return reply.status(404).send({ error: "unknown_ingest_credential" });
    if (c.revokedAt) return reply.send({ id: credentialId, revokedAt: c.revokedAt.toISOString(), changed: false });
    const su = await requireStepUp(db, req, reply, { kind: "identity_manage", facts: { op: "drift_ingest_credential_revoke", monitorId, credentialId } });
    if (!su.ok) return reply;
    const userId = req.authCtx.userId ?? null;
    const revokedAt = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [row] = await tx
        .update(modelDriftIngestCredentials)
        .set({ revokedAt: sql`now()`, revokedBy: userId })
        .where(and(eq(modelDriftIngestCredentials.id, credentialId), sql`${modelDriftIngestCredentials.revokedAt} IS NULL`))
        .returning({ revokedAt: modelDriftIngestCredentials.revokedAt });
      if (!row) return null;
      await audit(tx, {
        userId,
        objectId: credentialId,
        ruleId: DRIFT_INGEST_AUDIT_RULE_IDS.revoked,
        reason: `ingestion credential '${c.name}' for drift monitor '${m.name}' was revoked`,
        detail: { monitorId, name: c.name },
      });
      return row.revokedAt!;
    });
    if (!revokedAt) {
      const [now] = await db.select({ revokedAt: modelDriftIngestCredentials.revokedAt }).from(modelDriftIngestCredentials).where(eq(modelDriftIngestCredentials.id, credentialId));
      return reply.send({ id: credentialId, revokedAt: now?.revokedAt?.toISOString() ?? null, changed: false });
    }
    return reply.send({ id: credentialId, revokedAt: revokedAt.toISOString(), changed: true });
  });

  // ---- THE credential's one route (AUTH_EXEMPT + NON_ADMIN; authenticated here, on the bearer token only) ----
  app.post(DRIFT_INGEST_ROUTE, { bodyLimit: INGEST_BODY_LIMIT }, async (req, reply) => {
    if (await limit(req, reply, `dic:addr:${req.ip}`)) return reply;
    const token = presentedToken(req);
    const params = monitorParam.safeParse(req.params);
    if (!token || !params.success) return reply.status(401).send({ ...INGEST_CREDENTIAL_REFUSED });
    const [c] = await db
      .select({ id: modelDriftIngestCredentials.id, monitorId: modelDriftIngestCredentials.monitorId, name: modelDriftIngestCredentials.name, state: stateColumn() })
      .from(modelDriftIngestCredentials)
      .where(eq(modelDriftIngestCredentials.tokenHash, hashToken(token)));
    if (!c) return reply.status(401).send({ ...INGEST_CREDENTIAL_REFUSED });
    if (await limit(req, reply, `dic:cred:${c.id}`)) return reply;
    const monitorId = params.data.monitorId;
    if (c.state !== "active" || c.monitorId !== monitorId) {
      const wrongMonitor = c.state === "active";
      await db.transaction(async (rawTx) =>
        audit(rawTx as unknown as Db, {
          userId: null,
          objectId: c.id,
          ruleId: DRIFT_INGEST_AUDIT_RULE_IDS.refused,
          effect: "deny",
          reason: wrongMonitor
            ? `ingestion credential '${c.name}' was presented for a drift monitor it is not bound to, and was refused`
            : `ingestion credential '${c.name}' was presented while ${c.state}, and was refused`,
          detail: { actor: { type: "drift_ingest_credential", id: c.id, name: c.name }, boundMonitorId: c.monitorId, requestedMonitorId: monitorId, state: c.state },
        }),
      );
      return wrongMonitor
        ? reply.status(403).send({ error: "credential_not_for_monitor", detail: "this ingestion credential is bound to a different drift monitor" })
        : reply.status(401).send({ ...INGEST_CREDENTIAL_REFUSED });
    }
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !IDEMPOTENCY_KEY_RE.test(key)) {
      return reply.status(422).send({
        error: "idempotency_key_required",
        detail: "send an Idempotency-Key header of 16 to 128 characters (letters, digits, '.', '_', ':' or '-'), new for each summary",
      });
    }
    const parsed = ingestReportBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const out = await recordDriftReport(db, req, monitorId, parsed.data, { kind: "credential", credentialId: c.id, credentialName: c.name, idempotencyKey: key });
    return reply.status(out.status).send(out.body);
  });
}
