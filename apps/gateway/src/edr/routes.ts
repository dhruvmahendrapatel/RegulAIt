/**
 * ADR-0360 §6 — EDR integration routes. Admin-only (none is in NON_ADMIN_ROUTES) except the vendor webhook, which is
 * auth-exempt and authenticated in-route (Falcon: HMAC-SHA256 over body + delivery timestamp; SentinelOne: the shared
 * token in a custom header; MDE: none accepted), with a freshness window and a replay table.
 *
 *   POST /v1/discovery/sources/:sourceId/edr-connections   create (read-only); the credential is sealed, never returned;
 *                                                         a webhook secret is shown once (Falcon, SentinelOne)
 *   GET  /v1/discovery/sources/:sourceId/edr-connections   list (no secret, no ciphertext)
 *   PUT  /v1/edr-connections/:connectionId/settings        {enabled?, isolation?}: isolation on is a settings_relax step-up
 *   POST /v1/edr-connections/:connectionId/credential      replace the vendor credential (settings_relax step-up, audited)
 *   POST /v1/edr-connections/:connectionId/webhook-secret/rotate  a new webhook secret, shown once (step-up, audited)
 *   POST /v1/edr-connections/:connectionId/sync            pull signals now (the scheduler does it every 15 minutes)
 *   GET  /v1/discovery/sources/:sourceId/edr-signals       each enrolled device's latest normalised signal (paged)
 *   POST /v1/edr-connections/:connectionId/isolations      ask to isolate one device (refused while isolation is off)
 *   GET  /v1/edr-isolations                                requests, newest first (?open, keyset ?after), with the allowed next steps
 *   POST /v1/edr-isolations/:requestId/:event              approve | reject | request_release | approve_release | reject_release
 *   POST /v1/edr-webhooks/:connectionId                    the vendor's push
 *
 * Two signed-in people, always: a request, a release request and every decision need a person's session (the bootstrap
 * credential and keys are refused with `user_required`), and the decider is never the requester (route and CHECKs).
 * Isolation narrows access: an approver other than the requester, with a fresh `approval_decide` step-up bound to the
 * request, before anything is sent. Release widens access back: the same, with a `settings_relax` step-up. The device
 * quarantine lane E15 builds is applied on top when it lands (PENDING); this lane builds no parallel one.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  and,
  asc,
  auditLog,
  desc,
  discoverySources,
  edrConnections,
  edrDeviceSignals,
  edrIsolationRequests,
  endpointDevices,
  eq,
  inArray,
  notInArray,
  sql,
  type Db,
  type EdrConnectionRow,
  type EdrIsolationRequestRow,
} from "@regulait/db";
import { refuseConnectionEgressWrite, type ConnectionEgressDeps } from "../connection-egress.js";
import { encryptSecret, decryptSecret } from "../secrets.js";
import { requireStepUp, type StepUpCheckArgs } from "../step-up.js";
import { EDR_ADAPTERS, EDR_VENDORS } from "./adapters.js";
import { ISOLATION_MACHINE, ISOLATION_OPEN_STATES, type IsolationEvent, type IsolationState } from "./lifecycle.js";
import { ingestEdrWebhook, moveIsolationAudited, pollEdrIsolations, pruneEdrDeliveries, submitIsolation, syncEdrConnection, type EdrDeps } from "./service.js";
import type { SchedulerJobDefinition } from "../scheduler.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
export const EDR_WEBHOOK_PATH = "/v1/edr-webhooks/:connectionId";
export const EDR_WEBHOOK_MAX_BYTES = 256 * 1024;
export const EDR_SIGNALS_PAGE = 500;
export const EDR_ISOLATIONS_PAGE = 200;
const WEBHOOK_SECRET_PREFIX = "rgedr_";

/** ADR-0360 §6: the step-ups that relax or decide isolation, each bound to exactly what it allows */
export const edrIsolationEnableStepUp = (connectionId: string): StepUpCheckArgs => ({ kind: "settings_relax", facts: { op: "edr_isolation_enabled", connectionId, isolation: true } });
export const edrIsolationDecideStepUp = (requestId: string, decision: "approve" | "reject"): StepUpCheckArgs => ({ kind: "approval_decide", facts: { op: "edr_isolation", requestId, decision } });
export const edrReleaseStepUp = (requestId: string): StepUpCheckArgs => ({ kind: "settings_relax", facts: { op: "edr_isolation_release", requestId } });
export const edrCredentialRotateStepUp = (connectionId: string): StepUpCheckArgs => ({ kind: "settings_relax", facts: { op: "edr_credential_rotate", connectionId } });
export const edrWebhookSecretRotateStepUp = (connectionId: string): StepUpCheckArgs => ({ kind: "settings_relax", facts: { op: "edr_webhook_secret_rotate", connectionId } });

const uuid = z.string().uuid();
const httpsOrigin = z
  .string()
  .url()
  .max(255)
  .refine((u) => {
    const p = new URL(u);
    return p.protocol === "https:" && p.pathname === "/" && !p.search && !p.hash && !p.username && !p.password;
  }, "an https origin with no path")
  .transform((u) => new URL(u).origin);
const createSchema = z
  .object({
    vendor: z.enum(EDR_VENDORS),
    name: z.string().trim().min(1).max(100),
    baseUrl: httpsOrigin,
    tenantId: z.string().uuid().optional(),
    clientId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
    secret: z.string().min(16).max(4096),
  })
  .strict()
  .refine((b) => b.vendor !== "defender" || (b.tenantId && b.clientId), { message: "Defender needs tenantId and clientId" })
  .refine((b) => b.vendor !== "falcon" || b.clientId, { message: "Falcon needs clientId" });
const settingsSchema = z.object({ enabled: z.boolean().optional(), isolation: z.boolean().optional() }).strict().refine((b) => b.enabled !== undefined || b.isolation !== undefined);
const isolateSchema = z.object({ deviceId: uuid, reason: z.string().trim().min(1).max(500) }).strict();
const credentialSchema = z.object({ secret: z.string().min(16).max(4096), clientId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional() }).strict();
/** the signals cursor is the last row's (deviceId, connectionId): a device can have rows from several connections */
const signalsPageSchema = z.object({ after: z.string().regex(/^[0-9a-f-]{36}\.[0-9a-f-]{36}$/i).optional() }).strict();
const isolationsPageSchema = z.object({ after: uuid.optional(), open: z.enum(["true", "false"]).optional() }).strict();
const ADMIN_EVENTS = ["approve", "reject", "request_release", "approve_release", "reject_release"] as const satisfies readonly IsolationEvent[];

function connectionView(c: EdrConnectionRow) {
  return {
    id: c.id,
    sourceId: c.sourceId,
    vendor: c.vendor,
    name: c.name,
    baseUrl: c.baseUrl,
    tenantId: c.tenantId,
    clientId: c.clientId,
    enabled: c.enabled,
    isolationEnabled: c.isolationEnabled,
    webhooks: EDR_ADAPTERS[c.vendor].webhooks,
    lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
    lastSyncCode: c.lastSyncCode,
    createdAt: c.createdAt.toISOString(),
  };
}

const SYSTEM_EVENTS = ISOLATION_MACHINE.events.filter((e) => ISOLATION_MACHINE.def.transitions[e].by.includes("system"));

function isolationView(r: EdrIsolationRequestRow, viewer: string | null) {
  const blocked: Partial<Record<IsolationEvent, string>> = {};
  for (const e of SYSTEM_EVENTS) blocked[e] = "the EDR's reported state or the decision time limit decides this";
  if (!viewer) for (const e of ADMIN_EVENTS) blocked[e] = "this needs a signed-in admin (two people decide an isolation)";
  if (viewer && viewer === r.requestedBy) blocked.approve = blocked.reject = "the requester cannot decide their own request";
  // fail closed: a release with no named requester cannot be decided by "someone else"
  if (!r.releaseRequestedBy) blocked.approve_release = blocked.reject_release = "the release has no named requester";
  if (viewer && viewer === r.releaseRequestedBy) blocked.approve_release = blocked.reject_release = "the requester cannot decide their own release";
  return {
    id: r.id,
    connectionId: r.connectionId,
    deviceId: r.deviceId,
    state: r.state,
    reason: r.reason,
    requestedBy: r.requestedBy,
    decidedBy: r.decidedBy,
    releaseRequestedBy: r.releaseRequestedBy,
    releaseDecidedBy: r.releaseDecidedBy,
    errorCode: r.errorCode,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lifecycle: ISOLATION_MACHINE.describe(r.state as IsolationState, blocked),
  };
}

async function audit(db: Db, actor: string, sourceId: string, ruleId: string, reason: string, detail: Record<string, unknown>, effect: "allow" | "deny" = "allow", id?: string) {
  await db.insert(auditLog).values({ ...(id ? { id } : {}), userId: actor, objectType: "discovery_source", objectId: sourceId, detail: { subsystem: "edr", adr: "0360", ...detail }, effect, ruleId, ruleChain: [], reason });
}

export function registerEdrRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined; egress?: ConnectionEgressDeps } = {}): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;
  const deps = (): EdrDeps | null => (opts.dataKey ? { dataKey: opts.dataKey, ...(opts.egress ? { egress: opts.egress } : {}) } : null);
  const userRequired = (reply: FastifyReply) => reply.status(403).send({ error: "user_required", detail: "an isolation is requested and decided by signed-in people; the bootstrap credential and keys cannot" });
  const noKey = (reply: FastifyReply) => reply.status(503).send({ error: "data_key_unavailable", detail: "the data key is not configured, so an EDR credential cannot be stored or used" });
  const idParam = (req: FastifyRequest, name: string) => {
    const v = (req.params as Record<string, unknown>)[name];
    return uuid.safeParse(v).success ? (v as string) : null;
  };
  const agentSource = async (reply: FastifyReply, id: string | null) => {
    if (!id) return void (await reply.status(400).send({ error: "invalid_request", detail: "sourceId must be a uuid" }));
    const [s] = await db.select().from(discoverySources).where(eq(discoverySources.id, id));
    if (!s) return void (await reply.status(404).send({ error: "not_found", detail: "no such discovery source" }));
    if (s.kind !== "endpoint_agent") return void (await reply.status(409).send({ error: "not_an_agent_source", detail: "EDR connections belong to an endpoint agent source" }));
    return s;
  };
  const connection = async (reply: FastifyReply, id: string | null) => {
    if (!id) return void (await reply.status(400).send({ error: "invalid_request", detail: "connectionId must be a uuid" }));
    const [c] = await db.select().from(edrConnections).where(eq(edrConnections.id, id));
    if (!c) return void (await reply.status(404).send({ error: "not_found", detail: "no such EDR connection" }));
    return c;
  };

  app.post("/v1/discovery/sources/:sourceId/edr-connections", async (req, reply) => {
    const d = deps();
    if (!d) return noKey(reply);
    const source = await agentSource(reply, idParam(req, "sourceId"));
    if (!source) return reply;
    const b = createSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_request", detail: "send {vendor, name, baseUrl (https origin), tenantId? clientId? (Defender: both; Falcon: clientId), secret}" });
    const blocked = await refuseConnectionEgressWrite(db, { surface: "edr_connection", baseUrl: b.data.baseUrl, userId: req.authCtx.userId ?? null, phase: "edr_connection_write", label: `EDR connection '${b.data.name}' baseUrl`, ...(opts.egress ? { deps: opts.egress } : {}) });
    if (blocked) return reply.status(400).send(blocked);
    const webhookSecret = EDR_ADAPTERS[b.data.vendor].webhooks ? WEBHOOK_SECRET_PREFIX + randomBytes(32).toString("hex") : null;
    try {
      const row = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [c] = await tx
          .insert(edrConnections)
          .values({
            sourceId: source.id,
            vendor: b.data.vendor,
            name: b.data.name,
            baseUrl: b.data.baseUrl,
            tenantId: b.data.tenantId ?? null,
            clientId: b.data.clientId ?? null,
            secretCiphertext: encryptSecret(d.dataKey, b.data.secret),
            webhookSecretCiphertext: webhookSecret ? encryptSecret(d.dataKey, webhookSecret) : null,
            createdBy: req.authCtx.userId ?? null,
          })
          .returning();
        await audit(tx, actor(req), source.id, "edr-connection-created", `EDR connection '${c!.name}' (${c!.vendor}) created, read-only (ADR-0360)`, { connectionId: c!.id, vendor: c!.vendor, isolationEnabled: false });
        return c!;
      });
      reply.header("cache-control", "no-store");
      return reply.status(201).send({ connection: connectionView(row), ...(webhookSecret ? { webhook: { path: EDR_WEBHOOK_PATH.replace(":connectionId", row.id), secret: webhookSecret } } : {}) });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return reply.status(409).send({ error: "name_taken", detail: "this source already has an EDR connection with that name" });
      throw e;
    }
  });

  app.get("/v1/discovery/sources/:sourceId/edr-connections", async (req, reply) => {
    const source = await agentSource(reply, idParam(req, "sourceId"));
    if (!source) return reply;
    // a source has few connections; bounded at 100
    const rows = await db.select().from(edrConnections).where(eq(edrConnections.sourceId, source.id)).orderBy(asc(edrConnections.name)).limit(100);
    return reply.send({ connections: rows.map(connectionView) });
  });

  app.put("/v1/edr-connections/:connectionId/settings", async (req, reply) => {
    const c = await connection(reply, idParam(req, "connectionId"));
    if (!c) return reply;
    const b = settingsSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_request", detail: "send {enabled?: boolean, isolation?: boolean}" });
    const turnOn = b.data.isolation === true && !c.isolationEnabled;
    const su = turnOn ? await requireStepUp(db, req, reply, edrIsolationEnableStepUp(c.id)) : null;
    if (su && !su.ok) return reply;
    const row = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const set: Partial<typeof edrConnections.$inferInsert> = {};
      if (b.data.enabled !== undefined) set.enabled = b.data.enabled;
      if (turnOn && su?.ok) {
        const auditId = randomUUID();
        await audit(tx, actor(req), c.sourceId, "edr-isolation-relaxed", `isolation turned on for EDR connection '${c.name}' (step-up ${su.method}) (ADR-0360)`, { connectionId: c.id, relaxation: true, stepUp: su.method }, "allow", auditId);
        Object.assign(set, { isolationEnabled: true, isolationRelaxedBy: req.authCtx.userId ?? null, isolationStepUp: su.method, isolationAuditId: auditId });
      }
      if (b.data.isolation === false && c.isolationEnabled) {
        Object.assign(set, { isolationEnabled: false, isolationRelaxedBy: null, isolationStepUp: null, isolationAuditId: null });
        await audit(tx, actor(req), c.sourceId, "edr-isolation-off", `isolation turned off for EDR connection '${c.name}' (ADR-0360)`, { connectionId: c.id });
      }
      if (b.data.enabled !== undefined && b.data.enabled !== c.enabled) {
        await audit(tx, actor(req), c.sourceId, b.data.enabled ? "edr-connection-enabled" : "edr-connection-disabled", `EDR connection '${c.name}' ${b.data.enabled ? "enabled" : "disabled"} (ADR-0360)`, { connectionId: c.id });
      }
      if (Object.keys(set).length === 0) return c;
      const [u] = await tx.update(edrConnections).set(set).where(eq(edrConnections.id, c.id)).returning();
      return u!;
    });
    return reply.send({ connection: connectionView(row) });
  });

  // R2 #5: both secrets are rotatable in place, so a leaked one is replaced without losing the connection's evidence
  app.post("/v1/edr-connections/:connectionId/credential", async (req, reply) => {
    const d = deps();
    if (!d) return noKey(reply);
    const c = await connection(reply, idParam(req, "connectionId"));
    if (!c) return reply;
    const b = credentialSchema.safeParse(req.body ?? {});
    if (!b.success || (b.data.clientId && c.vendor === "sentinelone")) return reply.status(400).send({ error: "invalid_request", detail: "send {secret, clientId? (Defender, Falcon)}" });
    const su = await requireStepUp(db, req, reply, edrCredentialRotateStepUp(c.id));
    if (!su.ok) return reply;
    const row = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [u] = await tx
        .update(edrConnections)
        .set({ secretCiphertext: encryptSecret(d.dataKey, b.data.secret), ...(b.data.clientId ? { clientId: b.data.clientId } : {}) })
        .where(eq(edrConnections.id, c.id))
        .returning();
      await audit(tx, actor(req), c.sourceId, "edr-credential-rotated", `the credential of EDR connection '${c.name}' was replaced (step-up ${su.method}) (ADR-0360)`, { connectionId: c.id, clientIdChanged: Boolean(b.data.clientId && b.data.clientId !== c.clientId), stepUp: su.method });
      return u!;
    });
    return reply.send({ connection: connectionView(row) });
  });

  app.post("/v1/edr-connections/:connectionId/webhook-secret/rotate", async (req, reply) => {
    const d = deps();
    if (!d) return noKey(reply);
    const c = await connection(reply, idParam(req, "connectionId"));
    if (!c) return reply;
    if (!EDR_ADAPTERS[c.vendor].webhooks) return reply.status(409).send({ error: "no_webhooks", detail: "this EDR sends no webhooks, so there is no webhook secret" });
    const su = await requireStepUp(db, req, reply, edrWebhookSecretRotateStepUp(c.id));
    if (!su.ok) return reply;
    const secret = WEBHOOK_SECRET_PREFIX + randomBytes(32).toString("hex");
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx.update(edrConnections).set({ webhookSecretCiphertext: encryptSecret(d.dataKey, secret) }).where(eq(edrConnections.id, c.id));
      await audit(tx, actor(req), c.sourceId, "edr-webhook-secret-rotated", `the webhook secret of EDR connection '${c.name}' was rotated; the old one stops working now (step-up ${su.method}) (ADR-0360)`, { connectionId: c.id, stepUp: su.method });
    });
    reply.header("cache-control", "no-store");
    return reply.send({ webhook: { path: EDR_WEBHOOK_PATH.replace(":connectionId", c.id), secret } });
  });

  app.post("/v1/edr-connections/:connectionId/sync", async (req, reply) => {
    const d = deps();
    if (!d) return noKey(reply);
    const c = await connection(reply, idParam(req, "connectionId"));
    if (!c) return reply;
    if (!c.enabled) return reply.status(409).send({ error: "connection_disabled", detail: "enable this EDR connection first" });
    return reply.send(await syncEdrConnection(db, c, d));
  });

  app.get("/v1/discovery/sources/:sourceId/edr-signals", async (req, reply) => {
    const source = await agentSource(reply, idParam(req, "sourceId"));
    if (!source) return reply;
    const q = signalsPageSchema.safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send({ error: "invalid_request", detail: "after must be the previous page's next cursor" });
    const [afterDevice, afterConnection] = q.data.after?.split(".") ?? [];
    const rows = await db
      .select({ s: edrDeviceSignals, vendor: edrConnections.vendor, pseudonym: endpointDevices.devicePseudonym })
      .from(edrDeviceSignals)
      .innerJoin(edrConnections, eq(edrConnections.id, edrDeviceSignals.connectionId))
      .innerJoin(endpointDevices, eq(endpointDevices.id, edrDeviceSignals.deviceId))
      .where(and(eq(edrConnections.sourceId, source.id), afterDevice ? sql`(${edrDeviceSignals.deviceId}, ${edrDeviceSignals.connectionId}) > (${afterDevice}::uuid, ${afterConnection}::uuid)` : undefined))
      .orderBy(asc(edrDeviceSignals.deviceId), asc(edrDeviceSignals.connectionId))
      .limit(EDR_SIGNALS_PAGE + 1);
    const page = rows.slice(0, EDR_SIGNALS_PAGE);
    return reply.send({
      signals: page.map((r) => ({
        deviceId: r.s.deviceId,
        devicePseudonym: r.pseudonym,
        connectionId: r.s.connectionId,
        vendor: r.vendor,
        risk: r.s.risk,
        alerts: { low: r.s.alertsLow, medium: r.s.alertsMedium, high: r.s.alertsHigh, critical: r.s.alertsCritical },
        isolatedAtVendor: r.s.isolatedAtVendor,
        observedAt: r.s.observedAt.toISOString(),
      })),
      next: rows.length > EDR_SIGNALS_PAGE ? `${page[page.length - 1]!.s.deviceId}.${page[page.length - 1]!.s.connectionId}` : null,
    });
  });

  app.post("/v1/edr-connections/:connectionId/isolations", async (req, reply) => {
    const me = req.authCtx.userId ?? null;
    if (!me) return userRequired(reply);
    const c = await connection(reply, idParam(req, "connectionId"));
    if (!c) return reply;
    if (!c.enabled || !c.isolationEnabled) return reply.status(409).send({ error: "isolation_off", detail: "isolation is off for this EDR connection; turn it on first (that asks you to confirm it's you, and is audited)" });
    const b = isolateSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_request", detail: "send {deviceId, reason (1 to 500 characters)}" });
    const [sig] = await db.select().from(edrDeviceSignals).where(and(eq(edrDeviceSignals.connectionId, c.id), eq(edrDeviceSignals.deviceId, b.data.deviceId)));
    if (!sig) return reply.status(409).send({ error: "device_not_seen", detail: "this EDR has not reported this device; sync first" });
    const inserted = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [r] = await tx
        .insert(edrIsolationRequests)
        .values({ connectionId: c.id, deviceId: b.data.deviceId, vendorDeviceId: sig.vendorDeviceId, reason: b.data.reason, requestedBy: me })
        .onConflictDoNothing()
        .returning();
      if (!r) return null;
      await audit(tx, actor(req), c.sourceId, "edr-isolation-requested", `isolation of an enrolled device requested through EDR '${c.name}'; it waits for a second admin's approval (ADR-0360)`, { connectionId: c.id, requestId: r.id, deviceId: r.deviceId });
      return r;
    });
    if (!inserted) return reply.status(409).send({ error: "request_open", detail: "this device already has an open isolation request" });
    return reply.status(202).send({ isolation: isolationView(inserted, me) });
  });

  app.get("/v1/edr-isolations", async (req, reply) => {
    const q = isolationsPageSchema.safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send({ error: "invalid_request", detail: "after must be a request id; open is true or false" });
    // newest first, keyset-paged on (created_at, id)
    const rows = await db
      .select()
      .from(edrIsolationRequests)
      .where(
        and(
          q.data.open === undefined ? undefined : q.data.open === "true" ? inArray(edrIsolationRequests.state, [...ISOLATION_OPEN_STATES]) : notInArray(edrIsolationRequests.state, [...ISOLATION_OPEN_STATES]),
          q.data.after ? sql`(${edrIsolationRequests.createdAt}, ${edrIsolationRequests.id}) < (SELECT "created_at", "id" FROM "edr_isolation_requests" WHERE "id" = ${q.data.after})` : undefined,
        ),
      )
      .orderBy(desc(edrIsolationRequests.createdAt), desc(edrIsolationRequests.id))
      .limit(EDR_ISOLATIONS_PAGE + 1);
    const page = rows.slice(0, EDR_ISOLATIONS_PAGE);
    return reply.send({ isolations: page.map((r) => isolationView(r, req.authCtx.userId ?? null)), open: ISOLATION_OPEN_STATES, next: rows.length > EDR_ISOLATIONS_PAGE ? page[page.length - 1]!.id : null });
  });

  app.post("/v1/edr-isolations/:requestId/:event", async (req, reply) => {
    const id = idParam(req, "requestId");
    const event = (req.params as Record<string, string>).event as (typeof ADMIN_EVENTS)[number];
    if (!id || !ADMIN_EVENTS.includes(event)) return reply.status(400).send({ error: "invalid_request", detail: `requestId must be a uuid and the event one of ${ADMIN_EVENTS.join(", ")}` });
    // two people: every request and decision is a person's (the bootstrap credential and keys have no person to compare)
    const me = req.authCtx.userId ?? null;
    if (!me) return userRequired(reply);
    const [r] = await db.select().from(edrIsolationRequests).where(eq(edrIsolationRequests.id, id));
    if (!r) return reply.status(404).send({ error: "not_found", detail: "no such isolation request" });
    const view = isolationView(r, me).lifecycle.transitions.find((t) => t.event === event)!;
    if (!view.allowed) return reply.status(ISOLATION_MACHINE.def.transitions[event].from.includes(r.state as IsolationState) ? 403 : 409).send({ error: ISOLATION_MACHINE.def.transitions[event].from.includes(r.state as IsolationState) ? "caller_cannot_decide" : "illegal_transition", detail: view.reason });
    const [c] = await db.select().from(edrConnections).where(eq(edrConnections.id, r.connectionId));
    const d = deps();
    if ((event === "approve" || event === "approve_release") && !d) return noKey(reply);
    if (event === "approve" && (!c!.enabled || !c!.isolationEnabled)) return reply.status(409).send({ error: "isolation_off", detail: "isolation was turned off for this EDR connection" });
    const su =
      event === "approve" || event === "reject" ? await requireStepUp(db, req, reply, edrIsolationDecideStepUp(r.id, event)) : event === "approve_release" ? await requireStepUp(db, req, reply, edrReleaseStepUp(r.id)) : null;
    if (su && !su.ok) return reply;
    const set: Partial<typeof edrIsolationRequests.$inferInsert> =
      event === "approve" || event === "reject" ? { decidedBy: me } : event === "request_release" ? { releaseRequestedBy: me, releaseDecidedBy: null } : { releaseDecidedBy: me };
    // the transition and its audit row commit together
    const moved = await moveIsolationAudited(db, c!, r, event, set, { ruleId: `edr-isolation-${event.replace("_", "-")}`, reason: `EDR isolation request ${event} (ADR-0360)`, detail: su?.ok ? { stepUp: su.method } : {}, userId: me });
    if (!moved) return reply.status(409).send({ error: "changed_concurrently", detail: "the request changed while this was decided; read it again" });
    const out = event === "approve" ? await submitIsolation(db, c!, moved, "isolate", d!) : event === "approve_release" ? await submitIsolation(db, c!, moved, "release", d!) : moved;
    return reply.send({ isolation: isolationView(out, me) });
  });

  // ---- the vendor webhook: raw body, verified in-route, replay-protected ------------------------------------------
  app.register(async (scope) => {
    const keepRaw = (_req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => done(null, body);
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: EDR_WEBHOOK_MAX_BYTES }, keepRaw);
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: EDR_WEBHOOK_MAX_BYTES }, keepRaw);
    scope.post(EDR_WEBHOOK_PATH, async (req, reply) => {
      const id = idParam(req, "connectionId");
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      // one answer for every refusal, so the route does not say which connections exist
      const refuse = () => reply.status(401).send({ error: "invalid_signature" });
      if (!id || !opts.dataKey) return refuse();
      const [c] = await db.select().from(edrConnections).where(eq(edrConnections.id, id));
      if (!c || !c.enabled || !c.webhookSecretCiphertext) return refuse();
      const now = Math.floor((await db.execute<{ now: number }>(sql`select extract(epoch from now())::float8 as now`)).rows[0]!.now);
      const ev = EDR_ADAPTERS[c.vendor].verifyWebhook(req.headers as Record<string, string | string[] | undefined>, raw, decryptSecret(opts.dataKey, c.webhookSecretCiphertext), now);
      if (!ev) {
        await audit(db, NIL_UUID, c.sourceId, "edr-webhook-refused", `an EDR '${c.name}' webhook failed verification (ADR-0360)`, { connectionId: c.id, vendor: c.vendor }, "deny");
        return refuse();
      }
      const outcome = await ingestEdrWebhook(db, c, ev);
      return reply.send({ ok: true, ...(outcome === "duplicate" ? { duplicate: true } : {}) });
    });
  });
}

/** the scheduler jobs: signal sync, isolation polling and the replay-table prune */
export function edrJobDefinitions(opts: { dataKey?: string | undefined }): SchedulerJobDefinition[] {
  return [
    {
      name: "edr-sync",
      description: "ADR-0360: pull each enabled EDR connection's device risk and open alerts into the device signals (read-only at the vendor)",
      adr: "ADR-0360",
      defaultIntervalSeconds: 900,
      run: async (ctx) => {
        if (!opts.dataKey) return { itemsProcessed: 0, detail: { skipped: "data_key_unavailable" } };
        const conns = await ctx.db.select().from(edrConnections).where(eq(edrConnections.enabled, true)).limit(100);
        let matched = 0;
        for (const c of conns) matched += (await syncEdrConnection(ctx.db, c, { dataKey: opts.dataKey })).matched;
        return { itemsProcessed: conns.length, detail: { devicesMatched: matched } };
      },
    },
    {
      name: "edr-isolation-poll",
      description: "ADR-0360: settle submitted isolation and release requests from the EDR's action status",
      adr: "ADR-0360",
      defaultIntervalSeconds: 60,
      run: async (ctx) => {
        if (!opts.dataKey) return { itemsProcessed: 0, detail: { skipped: "data_key_unavailable" } };
        const pruned = await pruneEdrDeliveries(ctx.db);
        return { itemsProcessed: await pollEdrIsolations(ctx.db, { dataKey: opts.dataKey }), detail: { deliveriesPruned: pruned } };
      },
    },
  ];
}

