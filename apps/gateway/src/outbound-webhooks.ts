/**
 * ADR-0173 batch 2b — OUTBOUND WEBHOOKS.
 *
 *   GET    /v1/webhooks/events                       the event registry
 *   GET    /v1/webhooks                              subscriptions (never the secret)
 *   POST   /v1/webhooks                              create; the secret is shown ONCE
 *   PATCH  /v1/webhooks/:subscriptionId              edit
 *   DELETE /v1/webhooks/:subscriptionId              remove (and its delivery log)
 *   POST   /v1/webhooks/:subscriptionId/rotate-secret  new secret, shown ONCE
 *   POST   /v1/webhooks/:subscriptionId/test         send a test notification now
 *   GET    /v1/webhooks/:subscriptionId/deliveries   the delivery log
 *   POST   /v1/webhooks/deliveries/:deliveryId/retry requeue a failed delivery
 *   POST   /v1/webhooks/sweep                        run the retry sweep now
 *
 * All admin-only through the default gate (none is in NON_ADMIN_ROUTES).
 *
 * SIGNING follows the Standard Webhooks specification through its reference
 * library: `webhook-id` (one per event, the same on every retry, so a receiver
 * can de-duplicate), `webhook-timestamp` (seconds, this attempt) and
 * `webhook-signature` (`v1,<base64 HMAC-SHA256>` over `id.timestamp.body`)
 * under a per-subscription `whsec_` secret, stored as a REGULAIT_DATA_KEY
 * envelope. A receiver verifies with any off-the-shelf Standard Webhooks
 * verifier.
 *
 * EGRESS: every POST goes through `createGuardedFetch` with the org's egress
 * allow-list — the same guard and allow-list custom providers, external
 * scorers and connectors use: default-deny, DNS-pinned, redirects refused,
 * https unless both the subscription and the host entry allow plaintext.
 *
 * DELIVERY: an event becomes one `webhook_deliveries` row per matching active
 * subscription (the delivery log). The first attempt runs right after the
 * emitting request commits; failures retry with exponential backoff on the
 * scheduler sweep (ADR-0064) until delivered or `maxAttempts` is spent, when
 * the row is `failed` and an audit row says so. Each attempt claims the row
 * with a short lease, so a manual sweep racing the scheduler sends once.
 *
 * PAYLOADS carry only the fields the event declares in the shared registry —
 * ids, names, hashes, actor ids, timestamps — never template text or secrets.
 */
import crypto from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { Webhook } from "standardwebhooks";
import {
  and,
  auditLog,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  webhookDeliveries,
  webhookSubscriptions,
  type Db,
  type WebhookDeliveryRow,
  type WebhookSubscriptionRow,
} from "@regulait/db";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_FAMILIES,
  WEBHOOK_LIMITS,
  WEBHOOK_TEST_EVENT,
  webhookPayloadFor,
  webhookRetryDelaySeconds,
  webhookSelectorMatches,
  webhookSubscriptionCreateSchema,
  webhookSubscriptionUpdateSchema,
  type WebhookEventName,
} from "@regulait/shared";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { checkEgress, createGuardedFetch, egressRefusal, type EgressResolver } from "./egress-guard.js";
import { scheduleBackgroundWork } from "./background-work.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
/** one attempt's claim; well past the send deadline (WEBHOOK_LIMITS.timeoutMs) */
const LEASE_SECONDS = 60;
const SWEEP_LIMIT = 100;
/** a pass stops claiming new deliveries after this; the scheduler runs it every 60 s */
const SWEEP_BUDGET_MS = 45_000;

export const WEBHOOK_RULE_IDS = {
  created: "webhook-subscription-created",
  updated: "webhook-subscription-updated",
  deleted: "webhook-subscription-deleted",
  rotated: "webhook-secret-rotated",
  tested: "webhook-test-sent",
  egressBlocked: "egress-blocked",
  gaveUp: "webhook-delivery-failed",
  requeued: "webhook-delivery-requeued",
  sweepRun: "webhook-sweep-run",
} as const;

/** test seams only: no production caller passes either (see GuardedFetchOptions) */
export interface WebhookDeliveryDeps {
  resolve?: EgressResolver | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** a new Standard Webhooks secret: `whsec_` + base64 of 32 random bytes */
export function newWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// emitting
// ---------------------------------------------------------------------------

/**
 * Write one delivery per active subscription that selects `event`. Runs on
 * whatever handle it is given — inside the emitting transaction, so the event
 * commits or rolls back with what it reports. Returns the delivery ids; the
 * caller kicks them AFTER commit (`kickWebhookDeliveries`).
 */
export async function enqueueWebhookEvent(
  db: Db,
  event: WebhookEventName,
  data: Record<string, unknown>,
  now: Date = new Date(),
): Promise<string[]> {
  const subs = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.active, true));
  const matching = subs.filter((s) => webhookSelectorMatches(s.events ?? [], event));
  if (!matching.length) return [];
  const payload = { ...webhookPayloadFor(event, data), occurredAt: now.toISOString() };
  const messageId = `msg_${crypto.randomUUID()}`;
  const rows = await db
    .insert(webhookDeliveries)
    .values(
      matching.map((s) => ({
        subscriptionId: s.id,
        event,
        // one id per EVENT per subscription; the same on every retry
        messageId: `${messageId}_${s.id.slice(0, 8)}`,
        payload,
        maxAttempts: WEBHOOK_LIMITS.maxAttempts,
        nextRetryAt: now,
      })),
    )
    .returning({ id: webhookDeliveries.id });
  return rows.map((r) => r.id);
}

/** attempt these deliveries after the current request, tracked (a closing app drains it) */
export function kickWebhookDeliveries(
  db: Db,
  dataKey: string | undefined,
  ids: string[],
  log?: FastifyBaseLogger,
  deps: WebhookDeliveryDeps = {},
): void {
  if (!ids.length) return;
  scheduleBackgroundWork(
    db,
    async () => {
      for (const id of ids) await attemptDelivery(db, dataKey, id, deps);
    },
    log,
  );
}

/** enqueue + kick, for an emitter that is not inside a transaction */
export async function emitWebhookEvent(
  db: Db,
  dataKey: string | undefined,
  event: WebhookEventName,
  data: Record<string, unknown>,
  log?: FastifyBaseLogger,
): Promise<void> {
  kickWebhookDeliveries(db, dataKey, await enqueueWebhookEvent(db, event, data), log);
}

// ---------------------------------------------------------------------------
// delivering
// ---------------------------------------------------------------------------

function envelope(event: string, payload: Record<string, unknown>, at: Date): string {
  // the Standard Webhooks payload structure: type, timestamp, data
  return JSON.stringify({ type: event, timestamp: at.toISOString(), data: payload });
}

export interface SendOutcome {
  ok: boolean;
  responseCode: number | null;
  error: string | null;
}

/** one signed POST through the egress guard; never throws */
export async function sendSignedWebhook(
  db: Db,
  dataKey: string | undefined,
  sub: Pick<WebhookSubscriptionRow, "url" | "allowPlaintextHttp" | "secretCiphertext" | "name">,
  messageId: string,
  event: string,
  payload: Record<string, unknown>,
  at: Date,
  deps: WebhookDeliveryDeps = {},
): Promise<SendOutcome> {
  if (!dataKey) {
    return { ok: false, responseCode: null, error: "no REGULAIT_DATA_KEY is set on this gateway, so nothing can be signed" };
  }
  let secret: string;
  try {
    secret = decryptSecret(dataKey, sub.secretCiphertext);
  } catch {
    return { ok: false, responseCode: null, error: "the signing secret does not open under this gateway's data key" };
  }
  const body = envelope(event, payload, at);
  const signature = new Webhook(secret).sign(messageId, at, body);
  const guarded = createGuardedFetch({
    allowList: await loadEgressAllowList(db),
    providerAllowsPlaintextHttp: sub.allowPlaintextHttp,
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  try {
    const res = await guarded(sub.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "RegulAIt-Webhooks/1",
        "webhook-id": messageId,
        "webhook-timestamp": String(Math.floor(at.getTime() / 1000)),
        "webhook-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_LIMITS.timeoutMs),
    });
    // drain so the socket is released; the body is not stored
    await res.arrayBuffer().catch(() => undefined);
    return res.ok
      ? { ok: true, responseCode: res.status, error: null }
      : { ok: false, responseCode: res.status, error: `the receiver answered HTTP ${res.status}` };
  } catch (err) {
    const refusal = egressRefusal(err);
    if (refusal) return { ok: false, responseCode: null, error: `egress refused: ${refusal}` };
    let cur: unknown = err;
    for (let i = 0; i < 8 && cur; i += 1) {
      if (cur instanceof Error && (cur.name === "TimeoutError" || cur.name === "AbortError")) {
        return { ok: false, responseCode: null, error: `no answer within ${WEBHOOK_LIMITS.timeoutMs} ms` };
      }
      cur = (cur as { cause?: unknown }).cause;
    }
    const msg = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    return { ok: false, responseCode: null, error: `request failed: ${msg}`.slice(0, 500) };
  }
}

/**
 * One attempt at one delivery. Claims the row with a lease first (a racing
 * sweep finds it leased and skips it), sends, then records the outcome.
 * Returns the row as recorded, or null when it was not due, not claimable, or
 * its lease was lost before the outcome could be written.
 *
 * TIME. Nothing here reuses a caller's clock reading for anything but "is it
 * due": the lease is taken from the time of the claim, the signature's
 * `webhook-timestamp` from the moment of sending (a receiver rejects a stale
 * one, so a pass held up by a slow receiver must not sign later deliveries with
 * its start time), and the backoff from that same send time. `dueBy` is the
 * sweep's selection time — the only thing a pass's `now` decides.
 *
 * OWNERSHIP. Every outcome UPDATE is conditional on the lease this attempt
 * wrote still being the row's lease (`lease_until = <claimed value>`). If the
 * lease ran out and another worker claimed the row, this attempt writes
 * nothing and returns null rather than overwriting that worker's result.
 */
export async function attemptDelivery(
  db: Db,
  dataKey: string | undefined,
  deliveryId: string,
  deps: WebhookDeliveryDeps = {},
  dueBy?: Date,
): Promise<WebhookDeliveryRow | null> {
  const claimAt = new Date();
  const [claimed] = await db
    .update(webhookDeliveries)
    .set({ leaseUntil: new Date(claimAt.getTime() + LEASE_SECONDS * 1000) })
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        eq(webhookDeliveries.status, "pending"),
        or(isNull(webhookDeliveries.nextRetryAt), lte(webhookDeliveries.nextRetryAt, dueBy ?? claimAt)),
        or(isNull(webhookDeliveries.leaseUntil), lt(webhookDeliveries.leaseUntil, claimAt)),
      ),
    )
    .returning();
  if (!claimed) return null;
  // the outcome is written only while this attempt still holds the row
  const stillOurs = and(eq(webhookDeliveries.id, claimed.id), eq(webhookDeliveries.leaseUntil, claimed.leaseUntil!));
  const [sub] = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, claimed.subscriptionId));
  const attempts = claimed.attempts + 1;
  if (!sub || !sub.active) {
    const [row] = await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        attempts,
        lastAttemptAt: new Date(),
        lastError: "the subscription was deactivated before this was delivered",
        nextRetryAt: null,
        leaseUntil: null,
      })
      .where(stillOurs)
      .returning();
    return row ?? null;
  }
  const sentAt = new Date();
  const out = await sendSignedWebhook(db, dataKey, sub, claimed.messageId, claimed.event, claimed.payload, sentAt, deps);
  if (out.ok) {
    const [row] = await db
      .update(webhookDeliveries)
      .set({
        status: "delivered",
        attempts,
        lastAttemptAt: sentAt,
        responseCode: out.responseCode,
        lastError: null,
        deliveredAt: new Date(),
        nextRetryAt: null,
        leaseUntil: null,
      })
      .where(stillOurs)
      .returning();
    return row ?? null;
  }
  const exhausted = attempts >= claimed.maxAttempts;
  const [row] = await db
    .update(webhookDeliveries)
    .set({
      status: exhausted ? "failed" : "pending",
      attempts,
      lastAttemptAt: sentAt,
      responseCode: out.responseCode,
      lastError: out.error,
      nextRetryAt: exhausted ? null : new Date(sentAt.getTime() + webhookRetryDelaySeconds(attempts) * 1000),
      leaseUntil: null,
    })
    .where(stillOurs)
    .returning();
  if (!row) return null;
  if (exhausted) {
    await db.insert(auditLog).values({
      userId: NIL_USER,
      objectType: "webhook_subscription",
      objectId: sub.id,
      detail: { deliveryId: claimed.id, event: claimed.event, messageId: claimed.messageId, attempts, responseCode: out.responseCode },
      effect: "deny",
      ruleId: WEBHOOK_RULE_IDS.gaveUp,
      ruleChain: [],
      reason: `webhook '${sub.name}' gave up on ${claimed.event} after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${out.error}`,
    });
  }
  return row ?? null;
}

/**
 * The scheduler's retry pass (and the manual sweep route): every due pending
 * delivery, bounded. `now` only SELECTS what is due; each attempt takes its own
 * time for its lease and its signature (see `attemptDelivery`).
 *
 * A dead receiver cannot starve the others: once one of a subscription's
 * deliveries gets no HTTP answer at all (timeout, refused connection), its
 * remaining deliveries wait for a later pass instead of each burning a full
 * timeout here, and the pass stops claiming new work once its time budget is
 * spent. Both leave the rows `pending` and due (`deferred`); nothing is lost.
 */
export async function runWebhookDeliverySweep(
  db: Db,
  dataKey: string | undefined,
  opts: { now?: Date; limit?: number; budgetMs?: number; deps?: WebhookDeliveryDeps } = {},
): Promise<{ due: number; delivered: number; retrying: number; failed: number; skipped: number; deferred: number }> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? SWEEP_BUDGET_MS;
  const due = await db
    .select({ id: webhookDeliveries.id, subscriptionId: webhookDeliveries.subscriptionId })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        or(isNull(webhookDeliveries.nextRetryAt), lte(webhookDeliveries.nextRetryAt, now)),
        or(isNull(webhookDeliveries.leaseUntil), lt(webhookDeliveries.leaseUntil, new Date())),
      ),
    )
    .orderBy(webhookDeliveries.nextRetryAt)
    .limit(opts.limit ?? SWEEP_LIMIT);
  const out = { due: due.length, delivered: 0, retrying: 0, failed: 0, skipped: 0, deferred: 0 };
  const unanswered = new Set<string>();
  for (const d of due) {
    if (unanswered.has(d.subscriptionId) || Date.now() - started >= budgetMs) {
      out.deferred += 1;
      continue;
    }
    const row = await attemptDelivery(db, dataKey, d.id, opts.deps ?? {}, now);
    if (!row) out.skipped += 1;
    else if (row.status === "delivered") out.delivered += 1;
    else if (row.status === "failed") out.failed += 1;
    else out.retrying += 1;
    if (row && row.status !== "delivered" && row.responseCode === null) unanswered.add(d.subscriptionId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// routes — admin-only through the default gate
// ---------------------------------------------------------------------------

const subParam = z.object({ subscriptionId: z.string().uuid() });
const deliveryParam = z.object({ deliveryId: z.string().uuid() });

function publicSubscription(row: WebhookSubscriptionRow) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events,
    active: row.active,
    allowPlaintextHttp: row.allowPlaintextHttp,
    createdByUserId: row.createdByUserId,
    secretRotatedAt: row.secretRotatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function publicDelivery(row: WebhookDeliveryRow) {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    event: row.event,
    messageId: row.messageId,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    responseCode: row.responseCode,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** the host of a URL for an audit row — never the path or query, which may carry a token */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function registerOutboundWebhookRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { dataKey?: string | undefined; deps?: WebhookDeliveryDeps } = {},
): void {
  const deps = opts.deps ?? {};
  const actor = (req: { authCtx: { userId?: string | null } }) => req.authCtx.userId ?? NIL_USER;
  const audit = (
    userId: string,
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
    effect: "allow" | "deny" = "allow",
  ) =>
    db.insert(auditLog).values({ userId, objectType: "webhook_subscription", objectId, detail, effect, ruleId, ruleChain: [], reason });

  const preflight = async (url: string, allowPlaintextHttp: boolean) =>
    checkEgress(url, {
      allowList: await loadEgressAllowList(db),
      providerAllowsPlaintextHttp: allowPlaintextHttp,
      ...(deps.resolve ? { resolve: deps.resolve } : {}),
    });

  app.get("/v1/webhooks/events", async () => ({
    families: WEBHOOK_EVENT_FAMILIES,
    events: Object.entries(WEBHOOK_EVENTS).map(([name, spec]) => ({
      name,
      family: spec.family,
      description: spec.description,
      fields: spec.fields,
    })),
    signing: {
      scheme: "Standard Webhooks",
      headers: ["webhook-id", "webhook-timestamp", "webhook-signature"],
      note: "Verify with any Standard Webhooks library using the subscription's whsec_ secret.",
    },
  }));

  app.get("/v1/webhooks", async () => {
    const subs = await db.select().from(webhookSubscriptions).orderBy(webhookSubscriptions.name);
    // the latest delivery per subscription, for the list's status column
    const latest = subs.length
      ? await db
          .select({
            subscriptionId: webhookDeliveries.subscriptionId,
            status: webhookDeliveries.status,
            at: webhookDeliveries.createdAt,
            pending: sql<number>`count(*) FILTER (WHERE ${webhookDeliveries.status} = 'pending') OVER (PARTITION BY ${webhookDeliveries.subscriptionId})`,
            failed: sql<number>`count(*) FILTER (WHERE ${webhookDeliveries.status} = 'failed') OVER (PARTITION BY ${webhookDeliveries.subscriptionId})`,
            rn: sql<number>`row_number() OVER (PARTITION BY ${webhookDeliveries.subscriptionId} ORDER BY ${webhookDeliveries.createdAt} DESC)`,
          })
          .from(webhookDeliveries)
          .where(inArray(webhookDeliveries.subscriptionId, subs.map((s) => s.id)))
      : [];
    const bySub = new Map(latest.filter((l) => Number(l.rn) === 1).map((l) => [l.subscriptionId, l]));
    return {
      subscriptions: subs.map((s) => {
        const l = bySub.get(s.id);
        return {
          ...publicSubscription(s),
          lastDelivery: l ? { status: l.status, at: new Date(l.at).toISOString() } : null,
          pendingDeliveries: l ? Number(l.pending) : 0,
          failedDeliveries: l ? Number(l.failed) : 0,
        };
      }),
    };
  });

  app.post("/v1/webhooks", async (req, reply) => {
    const body = webhookSubscriptionCreateSchema.parse(req.body);
    if (!opts.dataKey) return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY to sign webhooks" });
    const decision = await preflight(body.url, body.allowPlaintextHttp);
    if (!decision.ok) {
      await audit(actor(req), null, WEBHOOK_RULE_IDS.egressBlocked, `webhook subscription refused: ${decision.reason}`,
        { phase: "webhook-create", host: hostOf(body.url), code: decision.code }, "deny");
      return reply.status(400).send({ error: "egress_blocked", code: decision.code, detail: decision.reason });
    }
    const secret = newWebhookSecret();
    const [row] = await db
      .insert(webhookSubscriptions)
      .values({
        name: body.name,
        url: body.url,
        events: body.events,
        active: body.active,
        allowPlaintextHttp: body.allowPlaintextHttp,
        secretCiphertext: encryptSecret(opts.dataKey, secret),
        createdByUserId: req.authCtx.userId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return reply.status(409).send({ error: "duplicate_name", detail: `a webhook named '${body.name}' already exists` });
    await audit(actor(req), row.id, WEBHOOK_RULE_IDS.created,
      `webhook '${row.name}' created for ${decision.host} on [${row.events.join(", ")}]`,
      { name: row.name, host: decision.host, events: row.events, active: row.active, allowPlaintextHttp: row.allowPlaintextHttp });
    // the secret leaves the gateway exactly once, here
    return reply.status(201).send({ ...publicSubscription(row), secret });
  });

  app.patch("/v1/webhooks/:subscriptionId", async (req, reply) => {
    const { subscriptionId } = subParam.parse(req.params);
    const body = webhookSubscriptionUpdateSchema.parse(req.body);
    const [row] = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, subscriptionId));
    if (!row) return reply.status(404).send({ error: "unknown_webhook" });
    const url = body.url ?? row.url;
    const plain = body.allowPlaintextHttp ?? row.allowPlaintextHttp;
    if (url !== row.url || plain !== row.allowPlaintextHttp) {
      const decision = await preflight(url, plain);
      if (!decision.ok) {
        await audit(actor(req), row.id, WEBHOOK_RULE_IDS.egressBlocked, `webhook '${row.name}' endpoint change refused: ${decision.reason}`,
          { phase: "webhook-update", host: hostOf(url), code: decision.code }, "deny");
        return reply.status(400).send({ error: "egress_blocked", code: decision.code, detail: decision.reason });
      }
    }
    if (body.name && body.name !== row.name) {
      const [clash] = await db.select({ id: webhookSubscriptions.id }).from(webhookSubscriptions).where(eq(webhookSubscriptions.name, body.name));
      if (clash) return reply.status(409).send({ error: "duplicate_name", detail: `a webhook named '${body.name}' already exists` });
    }
    const [updated] = await db
      .update(webhookSubscriptions)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(body.events !== undefined ? { events: body.events } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.allowPlaintextHttp !== undefined ? { allowPlaintextHttp: body.allowPlaintextHttp } : {}),
        updatedAt: new Date(),
      })
      .where(eq(webhookSubscriptions.id, row.id))
      .returning();
    const changed = Object.keys(body).filter((k) => k !== "url");
    await audit(actor(req), row.id, WEBHOOK_RULE_IDS.updated, `webhook '${updated!.name}' updated (${[...changed, ...(body.url ? ["url"] : [])].join(", ") || "no change"})`,
      { changed: Object.keys(body), host: hostOf(updated!.url), events: updated!.events, active: updated!.active });
    return publicSubscription(updated!);
  });

  app.delete("/v1/webhooks/:subscriptionId", async (req, reply) => {
    const { subscriptionId } = subParam.parse(req.params);
    const [row] = await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, subscriptionId)).returning();
    if (!row) return reply.status(404).send({ error: "unknown_webhook" });
    await audit(actor(req), row.id, WEBHOOK_RULE_IDS.deleted, `webhook '${row.name}' deleted with its delivery log`,
      { name: row.name, host: hostOf(row.url) });
    return { deleted: true, id: row.id };
  });

  app.post("/v1/webhooks/:subscriptionId/rotate-secret", async (req, reply) => {
    const { subscriptionId } = subParam.parse(req.params);
    if (!opts.dataKey) return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY to sign webhooks" });
    const secret = newWebhookSecret();
    const now = new Date();
    const [row] = await db
      .update(webhookSubscriptions)
      .set({ secretCiphertext: encryptSecret(opts.dataKey, secret), secretRotatedAt: now, updatedAt: now })
      .where(eq(webhookSubscriptions.id, subscriptionId))
      .returning();
    if (!row) return reply.status(404).send({ error: "unknown_webhook" });
    await audit(actor(req), row.id, WEBHOOK_RULE_IDS.rotated, `webhook '${row.name}' signing secret rotated`, { name: row.name });
    return { ...publicSubscription(row), secret };
  });

  app.post("/v1/webhooks/:subscriptionId/test", async (req, reply) => {
    const { subscriptionId } = subParam.parse(req.params);
    const [row] = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, subscriptionId));
    if (!row) return reply.status(404).send({ error: "unknown_webhook" });
    const now = new Date();
    const messageId = `msg_${crypto.randomUUID()}`;
    const payload = { subscriptionId: row.id, subscriptionName: row.name, requestedByUserId: req.authCtx.userId ?? null, occurredAt: now.toISOString() };
    const out = await sendSignedWebhook(db, opts.dataKey, row, messageId, WEBHOOK_TEST_EVENT, payload, now, deps);
    // the test is in the delivery log like any delivery: one attempt, never retried
    const [logged] = await db
      .insert(webhookDeliveries)
      .values({
        subscriptionId: row.id,
        event: WEBHOOK_TEST_EVENT,
        messageId,
        payload,
        status: out.ok ? "delivered" : "failed",
        attempts: 1,
        maxAttempts: 1,
        lastAttemptAt: now,
        responseCode: out.responseCode,
        lastError: out.error,
        deliveredAt: out.ok ? now : null,
      })
      .returning();
    await audit(actor(req), row.id, WEBHOOK_RULE_IDS.tested,
      `test notification to webhook '${row.name}' ${out.ok ? `delivered (HTTP ${out.responseCode})` : `failed: ${out.error}`}`,
      { messageId, responseCode: out.responseCode, ok: out.ok }, out.ok ? "allow" : "deny");
    return { ok: out.ok, responseCode: out.responseCode, error: out.error, delivery: publicDelivery(logged!) };
  });

  app.get("/v1/webhooks/:subscriptionId/deliveries", async (req, reply) => {
    const { subscriptionId } = subParam.parse(req.params);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const [row] = await db.select({ id: webhookSubscriptions.id }).from(webhookSubscriptions).where(eq(webhookSubscriptions.id, subscriptionId));
    if (!row) return reply.status(404).send({ error: "unknown_webhook" });
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.subscriptionId, subscriptionId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(q.limit);
    return { deliveries: rows.map(publicDelivery) };
  });

  app.post("/v1/webhooks/deliveries/:deliveryId/retry", async (req, reply) => {
    const { deliveryId } = deliveryParam.parse(req.params);
    const [row] = await db
      .update(webhookDeliveries)
      .set({ status: "pending", attempts: 0, nextRetryAt: new Date(), leaseUntil: null })
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, "failed"), sql`${webhookDeliveries.event} <> ${WEBHOOK_TEST_EVENT}`))
      .returning();
    if (!row) return reply.status(409).send({ error: "not_retryable", detail: "only a failed event delivery can be requeued (a test is re-sent from Test)" });
    await audit(actor(req), row.subscriptionId, WEBHOOK_RULE_IDS.requeued, `webhook delivery of ${row.event} requeued by an admin`,
      { deliveryId: row.id, event: row.event, messageId: row.messageId });
    kickWebhookDeliveries(db, opts.dataKey, [row.id], app.log, deps);
    return publicDelivery(row);
  });

  // a manual sweep SENDS deliveries, so it is an admin action on the record
  app.post("/v1/webhooks/sweep", async (req) => {
    const out = await runWebhookDeliverySweep(db, opts.dataKey, { deps });
    await audit(actor(req), null, WEBHOOK_RULE_IDS.sweepRun,
      `webhook retry sweep run by an admin: ${out.due} due, ${out.delivered} delivered, ${out.retrying} retrying, ` +
        `${out.failed} failed, ${out.skipped} skipped, ${out.deferred} deferred`,
      { phase: "webhook-sweep", ...out });
    return out;
  });
}
