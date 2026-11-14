/**
 * ADR-0303 — SIEM delivery of the audit chain (ADR-0135's proposed contract, P18 C6).
 *
 *   GET  /v1/siem/destinations                         destinations, their state and lag (never the secret)
 *   POST /v1/siem/destinations                         create one, OFF; the signing secret is shown once
 *   PUT  /v1/siem/destinations/:destinationId/enabled  on (step-up, audited as a relaxation) or off (audited)
 *   POST /v1/siem/destinations/:destinationId/rotate-secret  a new secret, shown once (step-up, audited)
 *   POST /v1/siem/destinations/:destinationId/recover  leave dead-letter or backoff and retry now (audited)
 *
 * All admin-only through the default gate.
 *
 * WHAT LEAVES (ADR-0135 point 1). A scrubbed, versioned envelope built from COMMITTED, CHAINED audit rows only: the
 * row id, sequence, time, deploy-mode scope, effect, rule id, object type and id, and the chain hashes. Never `detail`,
 * `reason`, the user or actor ids, `rule_chain`, server or tool names, prompts or payloads. One allow-list
 * (`siemEventFromAuditRow`) builds every event, and a test pins its keys.
 *
 * ORDER AND ACKNOWLEDGEMENT (point 2). Each destination is a cursor over `audit_log.seq`. A batch is the next rows
 * after the cursor in chain order; the cursor moves to the batch's last seq only when the receiver answers 2xx. A
 * failure resends the same rows (the same `webhook-id`), so delivery is at least once and receivers deduplicate on the
 * event id. Rows the audit prune removed before delivery show up as `gap` on the next batch, never silently.
 *
 * TRANSPORT (point 3). Standard Webhooks signing through its reference library (`standardwebhooks`, already pinned
 * for ADR-0173's outbound webhooks), a per-destination `whsec_` secret under REGULAIT_DATA_KEY, and the egress-guarded
 * fetch with the admin allow-list (default-deny, pinned addresses, no redirects, https unless both the destination and
 * the host entry allow plaintext). Failures back off exponentially (30 s doubling, at most one hour, a 429's
 * Retry-After respected within that); after `DEAD_LETTER_AFTER` consecutive failures the destination is dead-lettered
 * and stops until an admin recovers it. Only a fixed error CODE is stored, never receiver text.
 *
 * NEVER IN THE DECISION PATH. Delivery runs only on the scheduler job, reads the audit log and writes only its own
 * table (plus an audit row on a state change). A sender failure cannot roll back, delay or block a governance
 * decision, and a success writes no audit row, so delivery never feeds itself.
 *
 * ADAPTERS (point 4). One adapter: a signed JSON batch over HTTPS, the contract this file defines and its receiver
 * test pins. Azure Monitor, Security Lake, Splunk, Sentinel, Datadog or LogScale are not claimed.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { Webhook } from "standardwebhooks";
import {
  and,
  asc,
  auditLog,
  eq,
  gt,
  isNotNull,
  sql,
  siemDestinations,
  type Db,
  type SiemDestinationRow,
} from "@regulait/db";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { createGuardedFetch, egressRefusal, type EgressResolver } from "./egress-guard.js";
import { requireStepUp } from "./step-up.js";
import type { SchedulerJobDefinition } from "./scheduler.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export const SIEM_ENVELOPE_SCHEMA = "regulait.siem.audit.v1";
export const SIEM_DELIVERY_JOB_NAME = "siem-delivery-sweep";

export const SIEM_LIMITS = {
  batchSize: 200,
  /** batches one destination may send in one pass before yielding */
  maxBatchesPerPass: 10,
  timeoutMs: 10_000,
  leaseSeconds: 120,
  baseBackoffSeconds: 30,
  maxBackoffSeconds: 3600,
  deadLetterAfter: 12,
  destinationsListed: 100,
} as const;

export const SIEM_RULE_IDS = {
  created: "siem-destination-created",
  enabled: "siem-destination-enabled",
  disabled: "siem-destination-disabled",
  secretRotated: "siem-destination-secret-rotated",
  deadLettered: "siem-destination-dead-lettered",
  recovered: "siem-destination-recovered",
} as const;

export type SiemErrorCode =
  | "http_4xx"
  | "http_408"
  | "http_413"
  | "http_429"
  | "http_5xx"
  | "timeout"
  | "network"
  | "egress_blocked"
  | "no_data_key"
  | "secret_unreadable";

/** the ONE allow-list of what an audit row contributes to a SIEM event (ADR-0135 point 1) */
type AuditRow = typeof auditLog.$inferSelect;
export function siemEventFromAuditRow(r: Pick<
  AuditRow,
  "id" | "seq" | "at" | "deployMode" | "effect" | "ruleId" | "objectType" | "objectId" | "prevHash" | "rowHash" | "chainVersion"
>) {
  return {
    id: r.id,
    seq: r.seq,
    at: r.at.toISOString(),
    scope: { deployMode: r.deployMode ?? null },
    effect: r.effect,
    ruleId: r.ruleId,
    object: { type: r.objectType, id: r.objectId ?? null },
    chain: { prevHash: r.prevHash, rowHash: r.rowHash, version: r.chainVersion ?? 1 },
  };
}
export type SiemEvent = ReturnType<typeof siemEventFromAuditRow>;

export function newSiemSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString("base64")}`;
}

/** the backoff after the n-th consecutive failure (n >= 1), in seconds */
export function siemBackoffSeconds(n: number, retryAfterSeconds: number | null = null): number {
  const exp = Math.min(SIEM_LIMITS.maxBackoffSeconds, SIEM_LIMITS.baseBackoffSeconds * 2 ** Math.min(20, Math.max(0, n - 1)));
  if (retryAfterSeconds == null) return exp;
  return Math.min(SIEM_LIMITS.maxBackoffSeconds, Math.max(exp, retryAfterSeconds));
}

/** Retry-After as delta-seconds only (an HTTP-date is ignored: the backoff applies); linear, no regex */
function retryAfterSeconds(h: string | null): number | null {
  if (!h || h.length > 10) return null;
  for (const c of h) if (c < "0" || c > "9") return null;
  const n = Number(h);
  return Number.isSafeInteger(n) ? n : null;
}

function statusCode(status: number): SiemErrorCode {
  if (status === 408) return "http_408";
  if (status === 413) return "http_413";
  if (status === 429) return "http_429";
  if (status >= 500) return "http_5xx";
  return "http_4xx";
}

export interface SiemDeliveryDeps {
  resolve?: EgressResolver | undefined;
  fetchImpl?: typeof fetch | undefined;
}

type SendResult = { ok: true } | { ok: false; code: SiemErrorCode; retryAfter: number | null };

async function sendBatch(
  db: Db,
  dest: SiemDestinationRow,
  dataKey: string | undefined,
  messageId: string,
  body: string,
  deps: SiemDeliveryDeps,
): Promise<SendResult> {
  if (!dataKey) return { ok: false, code: "no_data_key", retryAfter: null };
  let secret: string;
  try {
    secret = decryptSecret(dataKey, dest.secretCiphertext);
  } catch {
    return { ok: false, code: "secret_unreadable", retryAfter: null };
  }
  const at = new Date();
  const signature = new Webhook(secret).sign(messageId, at, body);
  const guarded = createGuardedFetch({
    allowList: await loadEgressAllowList(db),
    providerAllowsPlaintextHttp: dest.allowPlaintextHttp,
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  try {
    const res = await guarded(dest.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "RegulAIt-SIEM/1",
        "webhook-id": messageId,
        "webhook-timestamp": String(Math.floor(at.getTime() / 1000)),
        "webhook-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(SIEM_LIMITS.timeoutMs),
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return { ok: false, code: statusCode(res.status), retryAfter: retryAfterSeconds(res.headers.get("retry-after")) };
  } catch (err) {
    if (egressRefusal(err)) return { ok: false, code: "egress_blocked", retryAfter: null };
    let cur: unknown = err;
    for (let i = 0; i < 8 && cur; i += 1) {
      if (cur instanceof Error && (cur.name === "TimeoutError" || cur.name === "AbortError")) {
        return { ok: false, code: "timeout", retryAfter: null };
      }
      cur = (cur as { cause?: unknown }).cause;
    }
    return { ok: false, code: "network", retryAfter: null };
  }
}

async function auditState(
  db: Db,
  actor: string,
  dest: Pick<SiemDestinationRow, "id" | "name">,
  ruleId: string,
  effect: "allow" | "deny",
  reason: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({
    userId: actor,
    objectType: "siem_destination",
    objectId: dest.id,
    detail: { subsystem: "siem-delivery", adr: "0303", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

export interface SiemDestinationPassResult {
  destinationId: string;
  delivered: number;
  batches: number;
  outcome: "idle" | "delivered" | "failed" | "dead_lettered" | "not_claimed";
  code?: SiemErrorCode;
}

/**
 * One pass for one destination: claim it with a lease, send batches in chain order until caught up, a failure, or
 * the per-pass cap, and record the outcome. Every write after the claim is conditional on this pass's lease, so a
 * pass whose lease ran out writes nothing over another's.
 */
export async function deliverSiemDestinationOnce(
  db: Db,
  destinationId: string,
  dataKey: string | undefined,
  deps: SiemDeliveryDeps = {},
): Promise<SiemDestinationPassResult> {
  const token = crypto.randomUUID();
  const [claimed] = await db
    .update(siemDestinations)
    .set({ leaseUntil: sql`now() + make_interval(secs => ${SIEM_LIMITS.leaseSeconds})`, leaseToken: token })
    .where(
      and(
        eq(siemDestinations.id, destinationId),
        eq(siemDestinations.enabled, true),
        sql`${siemDestinations.state} <> 'dead_letter'`,
        sql`(${siemDestinations.leaseUntil} IS NULL OR ${siemDestinations.leaseUntil} < now())`,
        sql`(${siemDestinations.nextAttemptAt} IS NULL OR ${siemDestinations.nextAttemptAt} <= now())`,
      ),
    )
    .returning();
  if (!claimed) return { destinationId, delivered: 0, batches: 0, outcome: "not_claimed" };
  const mine = and(eq(siemDestinations.id, destinationId), eq(siemDestinations.leaseToken, token));

  let cursor = claimed.cursorSeq;
  let delivered = 0;
  let batches = 0;
  for (; batches < SIEM_LIMITS.maxBatchesPerPass; ) {
    const rows = await db
      .select({
        id: auditLog.id,
        seq: auditLog.seq,
        at: auditLog.at,
        deployMode: auditLog.deployMode,
        effect: auditLog.effect,
        ruleId: auditLog.ruleId,
        objectType: auditLog.objectType,
        objectId: auditLog.objectId,
        prevHash: auditLog.prevHash,
        rowHash: auditLog.rowHash,
        chainVersion: auditLog.chainVersion,
      })
      .from(auditLog)
      .where(and(isNotNull(auditLog.seq), gt(auditLog.seq, cursor)))
      .orderBy(asc(auditLog.seq))
      .limit(SIEM_LIMITS.batchSize);
    if (rows.length === 0) break;
    const fromSeq = rows[0]!.seq!;
    const toSeq = rows[rows.length - 1]!.seq!;
    const body = JSON.stringify({
      schema: SIEM_ENVELOPE_SCHEMA,
      destinationId,
      batch: {
        afterSeq: cursor,
        fromSeq,
        toSeq,
        count: rows.length,
        // rows between the cursor and this batch were pruned (audit retention) before they were delivered
        gap: fromSeq !== cursor + 1,
      },
      events: rows.map((r) => siemEventFromAuditRow(r as Parameters<typeof siemEventFromAuditRow>[0])),
    });
    const messageId = `siem_${destinationId}_${cursor}_${toSeq}`;
    const sent = await sendBatch(db, claimed, dataKey, messageId, body, deps);
    batches += 1;
    if (!sent.ok) {
      const failures = claimed.consecutiveFailures + 1;
      const dead = failures >= SIEM_LIMITS.deadLetterAfter;
      const [saved] = await db
        .update(siemDestinations)
        .set({
          cursorSeq: cursor,
          deliveredEvents: sql`${siemDestinations.deliveredEvents} + ${delivered}`,
          consecutiveFailures: failures,
          state: dead ? "dead_letter" : "backoff",
          nextAttemptAt: dead ? null : sql`now() + make_interval(secs => ${siemBackoffSeconds(failures, sent.retryAfter)})`,
          lastAttemptAt: sql`now()`,
          lastErrorCode: sent.code,
          leaseUntil: null,
          leaseToken: null,
          updatedAt: sql`now()`,
        })
        .where(mine)
        .returning({ id: siemDestinations.id });
      if (saved && dead) {
        await auditState(db, NIL_UUID, claimed, SIEM_RULE_IDS.deadLettered, "deny",
          `SIEM destination '${claimed.name}' dead-lettered after ${failures} consecutive failures (last: ${sent.code}); delivery stopped at seq ${cursor} until an admin recovers it (ADR-0303)`,
          { failures, code: sent.code, cursorSeq: cursor });
      }
      return { destinationId, delivered, batches, outcome: dead ? "dead_lettered" : "failed", code: sent.code };
    }
    const [saved] = await db
      .update(siemDestinations)
      .set({
        cursorSeq: toSeq,
        deliveredEvents: sql`${siemDestinations.deliveredEvents} + ${rows.length}`,
        consecutiveFailures: 0,
        state: "active",
        nextAttemptAt: null,
        lastAttemptAt: sql`now()`,
        lastSuccessAt: sql`now()`,
        lastErrorCode: null,
        updatedAt: sql`now()`,
      })
      .where(mine)
      .returning({ id: siemDestinations.id });
    if (!saved) return { destinationId, delivered, batches, outcome: "not_claimed" };
    claimed.consecutiveFailures = 0;
    cursor = toSeq;
    delivered += rows.length;
    if (rows.length < SIEM_LIMITS.batchSize) break;
  }
  await db.update(siemDestinations).set({ leaseUntil: null, leaseToken: null }).where(mine);
  return { destinationId, delivered, batches, outcome: delivered > 0 ? "delivered" : "idle" };
}

/** the scheduler pass: every enabled, due, non-dead-lettered destination */
export async function runSiemDeliverySweep(db: Db, dataKey: string | undefined, deps: SiemDeliveryDeps = {}) {
  const due = await db
    .select({ id: siemDestinations.id })
    .from(siemDestinations)
    .where(
      and(
        eq(siemDestinations.enabled, true),
        sql`${siemDestinations.state} <> 'dead_letter'`,
        sql`(${siemDestinations.nextAttemptAt} IS NULL OR ${siemDestinations.nextAttemptAt} <= now())`,
      ),
    )
    .orderBy(asc(siemDestinations.createdAt))
    .limit(SIEM_LIMITS.destinationsListed);
  const results: SiemDestinationPassResult[] = [];
  for (const d of due) results.push(await deliverSiemDestinationOnce(db, d.id, dataKey, deps));
  return { destinations: results.length, delivered: results.reduce((n, r) => n + r.delivered, 0), results };
}

export function siemJobDefinitions(opts: { dataKey?: string | undefined } = {}): SchedulerJobDefinition[] {
  return [
    {
      name: SIEM_DELIVERY_JOB_NAME,
      description:
        "Deliver new audit-chain rows to each enabled SIEM destination as signed, ordered batches; the cursor moves " +
        "only on the receiver's 2xx. Failures back off and dead-letter after repeated failures. Reads the audit log; " +
        "never in a decision path. With no destination enabled it sends nothing.",
      adr: "ADR-0303",
      defaultIntervalSeconds: 60,
      run: async (ctx) => {
        const out = await runSiemDeliverySweep(ctx.db, opts.dataKey);
        return { itemsProcessed: out.delivered, detail: { destinations: out.destinations, delivered: out.delivered } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const destParam = z.object({ destinationId: z.string().uuid() });
const createBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    url: z.string().min(1).max(2048),
    allowPlaintextHttp: z.boolean().optional(),
    /** "now" (default): deliver rows written from now on; "beginning": the whole chained audit log */
    startFrom: z.enum(["now", "beginning"]).optional(),
  })
  .strict();
const enabledBody = z.object({ enabled: z.boolean() }).strict();

/** https, or http only when the destination asks for plaintext (the egress allow entry must agree at send time) */
function urlProblem(raw: string, allowPlaintextHttp: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "url is not a URL";
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && allowPlaintextHttp)) {
    return "url must be https (http only with allowPlaintextHttp, and the egress allow entry must permit it)";
  }
  if (u.username || u.password) return "url must not carry credentials";
  if (u.hash) return "url must not carry a fragment";
  return null;
}

async function headSeq(db: Db): Promise<number> {
  const [r] = await db.select({ max: sql<string | null>`max(${auditLog.seq})` }).from(auditLog);
  return r?.max == null ? 0 : Number(r.max);
}

function destinationView(d: SiemDestinationRow, head: number) {
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    url: d.url,
    allowPlaintextHttp: d.allowPlaintextHttp,
    enabled: d.enabled,
    state: d.state,
    cursorSeq: d.cursorSeq,
    /** chained audit rows not yet acknowledged */
    lag: Math.max(0, head - d.cursorSeq),
    consecutiveFailures: d.consecutiveFailures,
    nextAttemptAt: d.nextAttemptAt,
    lastAttemptAt: d.lastAttemptAt,
    lastSuccessAt: d.lastSuccessAt,
    lastErrorCode: d.lastErrorCode,
    deliveredEvents: d.deliveredEvents,
    secretRotatedAt: d.secretRotatedAt,
    createdAt: d.createdAt,
    envelope: SIEM_ENVELOPE_SCHEMA,
  };
}

export function registerSiemDeliveryRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;
  const refuse = (reply: FastifyReply, status: number, error: string, detail?: string) =>
    reply.status(status).send({ error, ...(detail ? { detail } : {}) });
  const load = async (reply: FastifyReply, params: unknown): Promise<SiemDestinationRow | null> => {
    const p = destParam.safeParse(params);
    if (!p.success) {
      await refuse(reply, 400, "invalid_request", "destinationId must be a uuid");
      return null;
    }
    const [row] = await db.select().from(siemDestinations).where(eq(siemDestinations.id, p.data.destinationId));
    if (!row) {
      await refuse(reply, 404, "not_found");
      return null;
    }
    return row;
  };

  app.get("/v1/siem/destinations", async () => {
    const [rows, head] = await Promise.all([
      db.select().from(siemDestinations).orderBy(asc(siemDestinations.createdAt)).limit(SIEM_LIMITS.destinationsListed),
      headSeq(db),
    ]);
    return {
      destinations: rows.map((r) => destinationView(r, head)),
      headSeq: head,
      limits: SIEM_LIMITS,
      envelope: {
        schema: SIEM_ENVELOPE_SCHEMA,
        fields: ["id", "seq", "at", "scope.deployMode", "effect", "ruleId", "object.type", "object.id", "chain.prevHash", "chain.rowHash", "chain.version"],
        note: "Verify each POST with any Standard Webhooks library and the destination's whsec_ secret; deduplicate on the event id.",
      },
    };
  });

  app.post("/v1/siem/destinations", async (req, reply) => {
    const b = createBody.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_request", "send {name, url, allowPlaintextHttp?, startFrom?: 'now' | 'beginning'}");
    const allowPlaintextHttp = b.data.allowPlaintextHttp ?? false;
    const problem = urlProblem(b.data.url, allowPlaintextHttp);
    if (problem) return refuse(reply, 400, "invalid_url", problem);
    if (!opts.dataKey) return refuse(reply, 503, "no_data_key", "REGULAIT_DATA_KEY is not set, so the signing secret cannot be stored");
    const secret = newSiemSecret();
    const startFrom = b.data.startFrom ?? "now";
    const created = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [dupe] = await t.select({ id: siemDestinations.id }).from(siemDestinations).where(sql`lower(${siemDestinations.name}) = lower(${b.data.name})`);
      if (dupe) return null;
      const cursorSeq = startFrom === "now" ? await headSeq(t) : 0;
      const [row] = await t
        .insert(siemDestinations)
        .values({
          name: b.data.name,
          url: new URL(b.data.url).toString(),
          allowPlaintextHttp,
          secretCiphertext: encryptSecret(opts.dataKey!, secret),
          cursorSeq,
          createdBy: req.authCtx.userId ?? null,
        })
        .returning();
      await auditState(t, actor(req), row!, SIEM_RULE_IDS.created, "allow", `SIEM destination '${row!.name}' created, off until enabled (ADR-0303)`, {
        url: row!.url,
        startFrom,
        cursorSeq,
        enabled: false,
      });
      return row!;
    });
    if (!created) return refuse(reply, 409, "destination_name_taken");
    return reply.status(201).send({
      destination: destinationView(created, await headSeq(db)),
      // shown once: configure it in the receiver's Standard Webhooks verifier
      secret,
    });
  });

  // on is a relaxation (audit data leaves the deployment): a step-up bound to this destination and URL
  app.put("/v1/siem/destinations/:destinationId/enabled", async (req, reply) => {
    const dest = await load(reply, req.params);
    if (!dest) return reply;
    const b = enabledBody.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_request", "send {enabled: true | false}");
    if (b.data.enabled === dest.enabled) return { destination: destinationView(dest, await headSeq(db)) };
    let method: string | null = null;
    if (b.data.enabled) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { siem: "enable", destinationId: dest.id, url: dest.url } });
      if (!su.ok) return reply;
      method = su.method;
    }
    const saved = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [row] = await t
        .update(siemDestinations)
        .set({ enabled: b.data.enabled, updatedAt: sql`now()` })
        .where(eq(siemDestinations.id, dest.id))
        .returning();
      await auditState(
        t,
        actor(req),
        dest,
        b.data.enabled ? SIEM_RULE_IDS.enabled : SIEM_RULE_IDS.disabled,
        b.data.enabled ? "deny" : "allow",
        b.data.enabled
          ? `SIEM destination '${dest.name}' enabled: audit-chain events are sent to ${dest.url} (step-up ${method}) (ADR-0303)`
          : `SIEM destination '${dest.name}' disabled: nothing more is sent (ADR-0303)`,
        { url: dest.url, from: { enabled: dest.enabled }, to: { enabled: b.data.enabled }, relaxation: b.data.enabled, ...(method ? { stepUp: method } : {}) },
      );
      return row!;
    });
    return { destination: destinationView(saved, await headSeq(db)) };
  });

  app.post("/v1/siem/destinations/:destinationId/rotate-secret", async (req, reply) => {
    const dest = await load(reply, req.params);
    if (!dest) return reply;
    if (!opts.dataKey) return refuse(reply, 503, "no_data_key", "REGULAIT_DATA_KEY is not set, so the signing secret cannot be stored");
    const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { siem: "rotate_secret", destinationId: dest.id } });
    if (!su.ok) return reply;
    const secret = newSiemSecret();
    const saved = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [row] = await t
        .update(siemDestinations)
        .set({ secretCiphertext: encryptSecret(opts.dataKey!, secret), secretRotatedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(siemDestinations.id, dest.id))
        .returning();
      await auditState(t, actor(req), dest, SIEM_RULE_IDS.secretRotated, "allow", `the signing secret of SIEM destination '${dest.name}' was rotated (step-up ${su.method}) (ADR-0303)`, { stepUp: su.method });
      return row!;
    });
    return { destination: destinationView(saved, await headSeq(db)), secret };
  });

  app.post("/v1/siem/destinations/:destinationId/recover", async (req, reply) => {
    const dest = await load(reply, req.params);
    if (!dest) return reply;
    if (dest.state === "active") return { destination: destinationView(dest, await headSeq(db)) };
    const saved = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [row] = await t
        .update(siemDestinations)
        .set({ state: "active", consecutiveFailures: 0, nextAttemptAt: null, updatedAt: sql`now()` })
        .where(eq(siemDestinations.id, dest.id))
        .returning();
      await auditState(t, actor(req), dest, SIEM_RULE_IDS.recovered, "allow", `SIEM destination '${dest.name}' recovered from ${dest.state}; delivery resumes after seq ${dest.cursorSeq} (ADR-0303)`, {
        from: dest.state,
        lastErrorCode: dest.lastErrorCode,
        cursorSeq: dest.cursorSeq,
      });
      return row!;
    });
    return { destination: destinationView(saved, await headSeq(db)) };
  });
}
