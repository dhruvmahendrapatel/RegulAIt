/**
 * ADR-0182 (ADR-0175 batch D4) S5 — ALERT OWNER, SLA AND TICKET (PathForward
 * PF-14 "owner, SLA, status"). OWNER: S5 (D4).
 *
 *   PUT  /v1/governance/alerts/:alertId/owner    user class: an admin OR the
 *                                                episode's current owner
 *                                                (in-handler, 403 otherwise,
 *                                                audited either way)
 *   POST /v1/governance/alerts/:alertId/ticket   admin (default gate): one PM
 *                                                work item per episode,
 *                                                idempotent
 *   job  alert-sla-sweep                         marks a past-due episode
 *                                                breached ONCE, escalates
 *                                                breached and unowned episodes
 *                                                to the admins, posts to chat
 *                                                with no personal data
 *
 * THE OWNER is decided when the monitor raises an episode
 * (`alertOwnershipAtRaise`): the accountable person already recorded for the
 * subject — the use case's owner, the agent's steward (its successor when the
 * steward is deactivated), the risk's owner, the vendor's owner, in that order
 * (`alertOwnerCandidates`). A deactivated person never owns anything. Nothing
 * found = unowned, which the sweep escalates. An admin or the current owner
 * may hand the episode to another active person (`owner_source = assigned`).
 *
 * THE SLA. `due_at` = the episode's creation + `alert_sla_hours` for its
 * severity (strict default 24/72/168 h). An episode is due until it RESOLVES:
 * acknowledging records who is responding and does not stop the clock. The
 * sweep NEVER resolves or acknowledges anything; it only marks
 * `sla_breached_at` (once — a conditional UPDATE) and tells people.
 *
 * THE TICKET. `alert_ticket_mode = manual` (strict) files a work item only when
 * an admin asks; `auto_high` files one for each NEW high episode, on the ONE
 * connection the admin named (`alert_ticket_connection_id`, required to relax
 * to auto_high). Never an implicit choice (ADR-0180): if that connection is
 * gone, automatic filing STOPS and the sweep records it; nothing falls back to
 * another connection. Either way one episode has at most one work item.
 *
 * NO PERSONAL DATA in a chat post or a ticket title (ADR-0175 D2 rule 12): the
 * texts come from `alertSlaChatText` / `alertTicketText`, where a person is "a
 * user (id …)".
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  agents,
  aiRisks,
  aiUseCases,
  aiVendors,
  and,
  asc,
  auditLog,
  eq,
  governanceAlerts,
  inArray,
  isNull,
  lte,
  ne,
  pmConnections,
  sql,
  users,
  type Db,
} from "@regulait/db";
import {
  ALERT_SLA_DEFAULTS,
  MONITOR_RULES,
  alertDueAt,
  alertOwnerCandidates,
  alertSlaChatText,
  alertSlaState,
  alertTicketText,
  createAlertTicketSchema,
  setAlertOwnerSchema,
  type AlertOwnerCandidate,
  type AlertOwnerSource,
  type AlertSlaHours,
  type AlertSlaState,
  type MonitorFinding,
} from "@regulait/shared";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { loadOrgSettings } from "./org-settings.js";
import { fileGovernanceAlertTicket, governanceAlertTicket, governanceAlertTickets } from "./pm.js";

export const ALERT_SLA_SWEEP_JOB_NAME = "alert-sla-sweep";

const NIL = "00000000-0000-0000-0000-000000000000";

/** stable rule ids — the strings an operator greps the audit log for */
export const ALERT_OWNERSHIP_RULE_IDS = {
  ownerDerived: "governance-alert-owner-derived",
  ownerAssigned: "governance-alert-owner-assigned",
  ownerAssignRefused: "governance-alert-owner-assign-refused",
  dueSet: "governance-alert-due-set",
  slaBreached: "governance-alert-sla-breached",
  escalated: "governance-alert-escalated",
  ticketFiled: "governance-alert-ticket-filed",
  ticketFailed: "governance-alert-ticket-failed",
  ticketConnectionMissing: "governance-alert-ticket-connection-missing",
} as const;

/** the connection `auto_high` files on: the one the admin named, if it still
 * exists. Never another one. (The column is migration 0167's; read through the
 * loaded row so this compiles before schema.ts names it.) */
async function namedTicketConnection(
  db: Db,
  settings: Awaited<ReturnType<typeof loadOrgSettings>>,
): Promise<{ named: string | null; id: string | null }> {
  const named = (settings as { alertTicketConnectionId?: string | null }).alertTicketConnectionId ?? null;
  if (!named) return { named: null, id: null };
  const [conn] = await db.select({ id: pmConnections.id }).from(pmConnections).where(eq(pmConnections.id, named));
  return { named, id: conn?.id ?? null };
}

/** where the console shows an episode (relative; chat and tickets carry it) */
export const alertPortalPath = (alertId: string) => `/admin/governance/alerts?alert=${alertId}`;

const ruleLabel = (ruleId: string) => (MONITOR_RULES as Record<string, { label: string }>)[ruleId]?.label ?? ruleId;

type AlertRow = typeof governanceAlerts.$inferSelect;

function audit(
  db: Pick<Db, "insert">,
  userId: string | null,
  alertId: string,
  ruleId: string,
  reason: string,
  detail: Record<string, unknown>,
  effect: "allow" | "deny" = "allow",
) {
  return db.insert(auditLog).values({
    userId: userId ?? NIL,
    objectType: "governance_alert",
    objectId: alertId,
    detail: { subsystem: "alert-ownership", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

async function slaHours(db: Db): Promise<AlertSlaHours> {
  const s = await loadOrgSettings(db);
  return (s.alertSlaHours as AlertSlaHours | null) ?? { ...ALERT_SLA_DEFAULTS };
}

// ---------------------------------------------------------------------------
// owner derivation
// ---------------------------------------------------------------------------

/** the active owner recorded on one candidate record, or null */
async function ownerOf(db: Db, c: AlertOwnerCandidate): Promise<string | null> {
  const active = async (id: string | null | undefined) => {
    if (!id) return null;
    const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, id), isNull(users.disabledAt)));
    return u?.id ?? null;
  };
  switch (c.kind) {
    case "use_case": {
      const [r] = await db.select({ o: aiUseCases.ownerUserId }).from(aiUseCases).where(eq(aiUseCases.id, c.id));
      return active(r?.o);
    }
    case "agent": {
      // the steward; their named successor when the steward has left
      const [r] = await db.select({ o: agents.ownerUserId, s: agents.successorUserId }).from(agents).where(eq(agents.id, c.id));
      return (await active(r?.o)) ?? (await active(r?.s));
    }
    case "risk": {
      const [r] = await db.select({ o: aiRisks.ownerUserId }).from(aiRisks).where(eq(aiRisks.id, c.id));
      return active(r?.o);
    }
    case "vendor": {
      const [r] = await db.select({ o: aiVendors.ownerUserId }).from(aiVendors).where(eq(aiVendors.id, c.id));
      return active(r?.o);
    }
  }
}

/** the accountable person for a subject, and which record named them */
export async function deriveAlertOwner(
  db: Db,
  subjectKey: string,
  detail: Record<string, unknown> | null | undefined,
): Promise<{ ownerUserId: string; from: AlertOwnerCandidate } | null> {
  for (const c of alertOwnerCandidates(subjectKey, detail)) {
    const owner = await ownerOf(db, c);
    if (owner) return { ownerUserId: owner, from: c };
  }
  return null;
}

export interface AlertOwnershipAtRaise {
  ownerUserId: string | null;
  ownerSource: AlertOwnerSource | null;
  dueAt: Date | null;
}

/** Owner and due time for an episode the monitor is about to raise. */
export async function alertOwnershipAtRaise(db: Db, finding: MonitorFinding, now: Date): Promise<AlertOwnershipAtRaise> {
  const owner = await deriveAlertOwner(db, finding.subjectKey, finding.detail as Record<string, unknown>);
  return {
    ownerUserId: owner?.ownerUserId ?? null,
    ownerSource: owner ? "derived" : null,
    dueAt: alertDueAt(finding.severity, now, await slaHours(db)),
  };
}

// ---------------------------------------------------------------------------
// after a monitor pass: record the derived owners, and auto-file tickets
// ---------------------------------------------------------------------------

/** the dataKey the routes were registered with, per database handle (the PM
 * token is encrypted with it); the monitor reaches it without a new parameter */
const ticketKeys = new WeakMap<object, string>();

/** Called once per monitor pass with the ids it raised (best effort: a
 * failure here never fails the pass). */
export async function afterAlertsRaised(db: Db, raisedIds: readonly string[], actorUserId: string | null): Promise<void> {
  if (raisedIds.length === 0) return;
  const raised = await db.select().from(governanceAlerts).where(inArray(governanceAlerts.id, [...raisedIds]));
  for (const a of raised) {
    await audit(
      db,
      actorUserId,
      a.id,
      ALERT_OWNERSHIP_RULE_IDS.ownerDerived,
      a.ownerUserId
        ? `governance alert ${a.id} owned by a user (id ${a.ownerUserId}), derived from its subject; due ${a.dueAt?.toISOString() ?? "never"}`
        : `governance alert ${a.id} has no owner on record for its subject; the SLA sweep escalates it to the admins`,
      { ownerUserId: a.ownerUserId, ownerSource: a.ownerSource, dueAt: a.dueAt?.toISOString() ?? null, ruleId: a.ruleId, severity: a.severity },
    );
  }
  const settings = await loadOrgSettings(db);
  if (settings.alertTicketMode !== "auto_high") return; // `manual` (strict): files nothing on its own
  const high = raised.filter((a) => a.severity === "high");
  if (high.length === 0) return;
  const dataKey = ticketKeys.get(db as object);
  const conn = await namedTicketConnection(db, settings);
  for (const a of high) {
    if (!dataKey || !conn.id) {
      const error = !conn.id ? "ticket_connection_missing" : "no_data_key";
      await audit(
        db,
        actorUserId,
        a.id,
        ALERT_OWNERSHIP_RULE_IDS.ticketFailed,
        `governance alert ${a.id}: no work item filed automatically — ${
          !conn.id ? "the PM connection named for automatic tickets no longer exists (no other connection is used)" : "no data key to open the PM connection"
        }`,
        { trigger: "auto_high", error, namedConnectionId: conn.named },
        "deny",
      );
      continue;
    }
    await fileTicket(db, dataKey, a, conn.id, actorUserId, "auto_high");
  }
}

async function fileTicket(
  db: Db,
  dataKey: string,
  a: AlertRow,
  connectionId: string,
  actorUserId: string | null,
  trigger: "manual" | "auto_high",
) {
  const text = alertTicketText({
    alertId: a.id,
    ruleLabel: ruleLabel(a.ruleId),
    severity: a.severity,
    title: a.title,
    subjectKey: a.subjectKey,
    dueAt: a.dueAt,
    portalPath: alertPortalPath(a.id),
  });
  let out: Awaited<ReturnType<typeof fileGovernanceAlertTicket>>;
  try {
    out = await fileGovernanceAlertTicket(db, dataKey, { alertId: a.id, connectionId, actorUserId, trigger, text });
  } catch (err) {
    out = { outcome: "refused", status: 502, error: "pm_provider_failed", detail: err instanceof Error ? err.message : String(err) };
  }
  if (out.outcome === "created") {
    await audit(db, actorUserId, a.id, ALERT_OWNERSHIP_RULE_IDS.ticketFiled,
      `governance alert ${a.id} filed as work item '${out.externalId}' on PM connection '${out.connectionName}' (${trigger === "manual" ? "by a person" : "automatically: alert_ticket_mode = auto_high"})`,
      { trigger, connectionId: out.connectionId, externalId: out.externalId });
  } else if (out.outcome === "refused") {
    await audit(db, actorUserId, a.id, ALERT_OWNERSHIP_RULE_IDS.ticketFailed,
      `governance alert ${a.id}: work item NOT filed — ${out.error}`, { trigger, connectionId, error: out.error, status: out.status, why: out.detail.slice(0, 500) }, "deny");
  }
  return out;
}

// ---------------------------------------------------------------------------
// the SLA sweep
// ---------------------------------------------------------------------------

/** a message for chat: ids, severity, rule label and words only */
export interface AlertSlaChatMessage {
  alertId: string;
  severity: "low" | "medium" | "high";
  ruleLabel: string;
  text: string;
}
export type AlertSlaCourier = (message: AlertSlaChatMessage, actorUserId: string | null) => Promise<{ posted: number; failed: number }>;
const slaCouriers = new WeakMap<object, AlertSlaCourier>();
/** chatops.ts registers the guarded chat courier for a database handle (as it
 * does for raised alerts); a deployment without ChatOps posts nothing */
export function registerAlertSlaCourier(db: Db, courier: AlertSlaCourier): void {
  slaCouriers.set(db as object, courier);
}

export interface AlertSlaSweepResult {
  dueSet: number;
  breached: number;
  escalatedUnowned: number;
  chat: { posted: number; failed: number; courier: boolean };
  /** `auto_high` whose named connection is gone: filing has stopped */
  ticketConnectionMissing: boolean;
}

async function adminIds(db: Db): Promise<string[]> {
  return (
    await db.select({ id: users.id }).from(users).where(and(eq(users.isAdmin, true), isNull(users.disabledAt))).orderBy(asc(users.id))
  ).map((u) => u.id);
}

/**
 * One pass. NEVER resolves or acknowledges an episode.
 *  1. An open episode with no due time (raised before this slice) gets one,
 *     from its first detection — as for a first load.
 *  2. An open episode past its due time is marked breached ONCE (the UPDATE
 *     matches only `sla_breached_at IS NULL`), audited, escalated to the
 *     admins and posted to chat.
 *  3. An open episode with no owner is escalated to the admins once (an
 *     escalation audit row for the episode, for either reason, is the marker).
 */
export async function runAlertSlaSweep(db: Db, now: Date, actorUserId: string | null = null): Promise<AlertSlaSweepResult> {
  const hours = await slaHours(db);
  const out: AlertSlaSweepResult = { dueSet: 0, breached: 0, escalatedUnowned: 0, chat: { posted: 0, failed: 0, courier: false }, ticketConnectionMissing: false };
  const courier = slaCouriers.get(db as object);
  out.chat.courier = Boolean(courier);
  const post = async (a: AlertRow, kind: "breached" | "unowned") => {
    if (!courier) return;
    try {
      const r = await courier(
        {
          alertId: a.id,
          severity: a.severity,
          ruleLabel: ruleLabel(a.ruleId),
          text: alertSlaChatText({ kind, ruleLabel: ruleLabel(a.ruleId), severity: a.severity, dueAt: a.dueAt, ownerUserId: a.ownerUserId }),
        },
        actorUserId,
      );
      out.chat.posted += r.posted;
      out.chat.failed += r.failed;
    } catch {
      out.chat.failed += 1; // the courier audits its own failures
    }
  };

  // 1. a due time for every open episode that lacks one
  for (const a of await db
    .select()
    .from(governanceAlerts)
    .where(and(ne(governanceAlerts.status, "resolved"), isNull(governanceAlerts.dueAt)))) {
    const dueAt = alertDueAt(a.severity, a.firstDetectedAt, hours);
    const [set] = await db
      .update(governanceAlerts)
      .set({ dueAt })
      .where(and(eq(governanceAlerts.id, a.id), isNull(governanceAlerts.dueAt)))
      .returning({ id: governanceAlerts.id });
    if (set) {
      out.dueSet += 1;
      await audit(db, actorUserId, a.id, ALERT_OWNERSHIP_RULE_IDS.dueSet,
        `governance alert ${a.id} given its due time ${dueAt.toISOString()} (${a.severity}: ${hours[a.severity]} h from first detection)`,
        { dueAt: dueAt.toISOString(), slaHours: hours[a.severity] });
    }
  }

  const admins = await adminIds(db);

  // 0. automatic tickets whose named connection is gone have STOPPED (no
  //    fallback): recorded once per settings change, for the admins
  const settings = await loadOrgSettings(db);
  if (settings.alertTicketMode === "auto_high" && !(await namedTicketConnection(db, settings)).id) {
    out.ticketConnectionMissing = true;
    const since = settings.updatedAt ?? new Date(0);
    const [already] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, ALERT_OWNERSHIP_RULE_IDS.ticketConnectionMissing), sql`${auditLog.at} >= ${since}`))
      .limit(1);
    if (!already) {
      await db.insert(auditLog).values({
        userId: actorUserId ?? NIL,
        objectType: "org_settings",
        objectId: null,
        detail: {
          subsystem: "alert-ownership",
          alertTicketMode: "auto_high",
          namedConnectionId: (settings as { alertTicketConnectionId?: string | null }).alertTicketConnectionId ?? null,
          recipients: admins,
        },
        effect: "deny",
        ruleId: ALERT_OWNERSHIP_RULE_IDS.ticketConnectionMissing,
        ruleChain: [],
        reason:
          "automatic alert tickets have STOPPED: alert_ticket_mode is auto_high but the PM connection named for them no " +
          "longer exists. No other connection is used. An admin names a connection, or sets the mode back to manual.",
      });
    }
  }

  // 2. breached, once
  const breached = await db
    .update(governanceAlerts)
    .set({ slaBreachedAt: now })
    .where(
      and(
        ne(governanceAlerts.status, "resolved"),
        isNull(governanceAlerts.slaBreachedAt),
        lte(governanceAlerts.dueAt, now),
      ),
    )
    .returning();
  for (const a of breached) {
    out.breached += 1;
    const recipients = [...new Set([...(a.ownerUserId ? [a.ownerUserId] : []), ...admins])];
    await audit(db, actorUserId, a.id, ALERT_OWNERSHIP_RULE_IDS.slaBreached,
      `governance alert ${a.id} (${a.severity}) is past its due time ${a.dueAt?.toISOString()}; it stays ${a.status} until its condition clears`,
      { dueAt: a.dueAt?.toISOString() ?? null, ownerUserId: a.ownerUserId, status: a.status }, "deny");
    await audit(db, actorUserId, a.id, ALERT_OWNERSHIP_RULE_IDS.escalated,
      `governance alert ${a.id} escalated to the admins: past its due time`,
      { reason: "sla_breached", recipients, ownerUserId: a.ownerUserId });
    await post(a, "breached");
  }

  // 3. unowned, escalated once (the audit row is the marker)
  const unowned = await db
    .select()
    .from(governanceAlerts)
    .where(
      and(
        ne(governanceAlerts.status, "resolved"),
        isNull(governanceAlerts.ownerUserId),
        // escalated already, for either reason (a breached unowned episode's
        // breach escalation says it has no owner)
        sql`NOT EXISTS (SELECT 1 FROM ${auditLog} WHERE ${auditLog.ruleId} = ${ALERT_OWNERSHIP_RULE_IDS.escalated}
              AND ${auditLog.objectId} = ${governanceAlerts.id})`,
      ),
    );
  for (const a of unowned) {
    out.escalatedUnowned += 1;
    await audit(db, actorUserId, a.id, ALERT_OWNERSHIP_RULE_IDS.escalated,
      `governance alert ${a.id} escalated to the admins: no owner on record for its subject`,
      { reason: "unowned", recipients: admins });
    await post(a, "unowned");
  }
  return out;
}

/** The scheduler jobs this slice owns (spread by scheduler-jobs.ts). */
export function alertSlaJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: ALERT_SLA_SWEEP_JOB_NAME,
      description:
        "ADR-0182 S5 (PF-14): marks a governance alert episode past its due time (alert_sla_hours) as breached, once, " +
        "and escalates breached and unowned episodes to the admins, posting to chat with no personal data. Never " +
        "resolves or acknowledges an episode.",
      adr: "ADR-0182",
      defaultIntervalSeconds: 15 * 60,
      run: async (ctx) => {
        const r = await runAlertSlaSweep(ctx.db, ctx.now, ctx.actorUserId);
        return { itemsProcessed: r.dueSet + r.breached + r.escalatedUnowned, detail: { ...r } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// the console's view of an episode's owner, SLA and ticket
// ---------------------------------------------------------------------------

export interface AlertOwnershipView {
  owner: { id: string; name: string | null; source: AlertOwnerSource | null } | null;
  dueAt: string | null;
  slaBreachedAt: string | null;
  sla: AlertSlaState;
  ticket: { connectionId: string; connectionName: string; externalId: string; externalUrl: string } | null;
}

/** for `GET /v1/governance/alerts` (admin-only) and the two routes below */
export async function alertOwnershipViews(db: Db, alerts: readonly AlertRow[], now: Date = new Date()): Promise<Map<string, AlertOwnershipView>> {
  const out = new Map<string, AlertOwnershipView>();
  if (alerts.length === 0) return out;
  const ownerIds = [...new Set(alerts.flatMap((a) => (a.ownerUserId ? [a.ownerUserId] : [])))];
  const names = new Map<string, string | null>();
  if (ownerIds.length) {
    for (const u of await db.select({ id: users.id, name: users.displayName, email: users.email }).from(users).where(inArray(users.id, ownerIds))) {
      names.set(u.id, u.name || u.email || null);
    }
  }
  const tickets = await governanceAlertTickets(db, alerts.map((a) => a.id));
  for (const a of alerts) {
    const ticket = tickets.get(a.id);
    out.set(a.id, {
      owner: a.ownerUserId ? { id: a.ownerUserId, name: names.get(a.ownerUserId) ?? null, source: a.ownerSource } : null,
      dueAt: a.dueAt?.toISOString() ?? null,
      slaBreachedAt: a.slaBreachedAt?.toISOString() ?? null,
      sla: alertSlaState(a, now),
      ticket: ticket
        ? { connectionId: ticket.connectionId, connectionName: ticket.connectionName, externalId: ticket.externalId, externalUrl: ticket.externalUrl }
        : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const alertParam = z.object({ alertId: z.string().uuid() });

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, S5 block):
 *   PUT  /v1/governance/alerts/:alertId/owner    user: an admin or the episode's current owner, in-handler
 *   POST /v1/governance/alerts/:alertId/ticket   admin (files one PM work item per episode, idempotent)
 */
export function registerAlertOwnershipRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  if (opts.dataKey) ticketKeys.set(db as object, opts.dataKey);

  app.put("/v1/governance/alerts/:alertId/owner", async (req, reply: FastifyReply) => {
    const { alertId } = alertParam.parse(req.params);
    const body = setAlertOwnerSchema.parse(req.body);
    const caller = req.authCtx.userId ?? null;
    const [a] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, alertId));
    if (!a) return reply.status(404).send({ error: "not_found" });
    const isOwner = caller !== null && a.ownerUserId === caller;
    if (!req.authCtx.isAdmin && !isOwner) {
      await audit(db, caller, alertId, ALERT_OWNERSHIP_RULE_IDS.ownerAssignRefused,
        `governance alert ${alertId}: owner change refused — only an admin or the episode's current owner may reassign it`,
        { to: body.userId, currentOwnerUserId: a.ownerUserId }, "deny");
      return reply.status(403).send({ error: "not_owner_or_admin", detail: "only an admin or the episode's current owner may reassign it" });
    }
    if (a.status === "resolved") return reply.status(409).send({ error: "alert_resolved" });
    const [target] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, body.userId), isNull(users.disabledAt)));
    if (!target) return reply.status(422).send({ error: "unknown_or_inactive_user", detail: "the new owner must be an active user" });
    const [updated] = await db
      .update(governanceAlerts)
      .set({ ownerUserId: body.userId, ownerSource: "assigned" })
      .where(and(eq(governanceAlerts.id, alertId), ne(governanceAlerts.status, "resolved")))
      .returning();
    if (!updated) return reply.status(409).send({ error: "alert_resolved" });
    await audit(db, caller, alertId, ALERT_OWNERSHIP_RULE_IDS.ownerAssigned,
      `governance alert ${alertId} assigned to a user (id ${body.userId}) by ${req.authCtx.isAdmin ? "an admin" : "its owner"}`,
      {
        transitions: {
          ownerUserId: { from: a.ownerUserId, to: body.userId },
          ownerSource: { from: a.ownerSource, to: "assigned" },
        },
        by: req.authCtx.isAdmin ? "admin" : "owner",
      });
    const view = (await alertOwnershipViews(db, [updated])).get(alertId)!;
    return { id: alertId, ...view };
  });

  app.post("/v1/governance/alerts/:alertId/ticket", async (req, reply: FastifyReply) => {
    const { alertId } = alertParam.parse(req.params);
    const body = createAlertTicketSchema.parse(req.body);
    const caller = req.authCtx.userId ?? null;
    if (!caller) {
      return reply.status(403).send({ error: "identity_required", detail: "filing a work item in a third-party tool is a person's act" });
    }
    if (!opts.dataKey) return reply.status(503).send({ error: "pm_connections_require_data_key" });
    const [a] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, alertId));
    if (!a) return reply.status(404).send({ error: "not_found" });
    const existing = await governanceAlertTicket(db, alertId);
    if (!existing && a.status === "resolved") return reply.status(409).send({ error: "alert_resolved" });
    const out = await fileTicket(db, opts.dataKey, a, body.connectionId, caller, "manual");
    if (out.outcome === "refused") return reply.status(out.status).send({ error: out.error, detail: out.detail });
    const ticket = { connectionId: out.connectionId, connectionName: out.connectionName, externalId: out.externalId, externalUrl: out.externalUrl };
    return reply.status(out.outcome === "created" ? 201 : 200).send({ alertId, created: out.outcome === "created", idempotent: out.outcome === "existing", ticket });
  });
}
