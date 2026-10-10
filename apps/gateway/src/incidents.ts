/**
 * ADR-0182 (ADR-0175 batch D4) A12 — THE AI INCIDENT REGISTER.
 *
 * An incident involving an AI system: what happened, when the organisation
 * became aware (the notification clocks start there), how serious it is under
 * EU AI Act Art. 3(49) and whether it is a HIPAA PHI breach, what it is linked
 * to, the timeline, the corrective actions, the regulatory notification clocks
 * and, at the end, the root cause and lessons learned.
 *
 * Sources: Regulation (EU) 2024/1689 Art. 3(49), 26(5), 73; 45 CFR
 * 164.404–164.412 (the quotes and periods are in `incident-clocks.ts`); NIST AI
 * RMF GOVERN 4.3, MANAGE 2.3, 4.1, 4.3.
 *
 * RULES THIS MODULE HOLDS
 *  - Marking an incident serious, or listing `phi_breach`, creates the
 *    applicable clocks at once, under the org's `incident_clock_regimes`
 *    (strict default: both). A clock is NEVER deleted (a DB trigger refuses
 *    it too); an admin sets one aside as `not_required` or `tolled`, with a
 *    reason, audited. Art. 73(5): a clock may record an incomplete initial
 *    report before the complete one.
 *  - Closing needs a root cause, lessons learned (422 without; a DB CHECK
 *    holds it too), every clock in a terminal state (409) and every
 *    corrective action done or cancelled (409); cancelling an action needs a
 *    reason (422 without), audited and kept on the timeline.
 *  - Containment (admin) halts a linked agent through `haltAgentInTx`, in the
 *    same transaction as the `containment` timeline event. Lifting the halt
 *    stays on the execution-control page.
 *  - THE EVIDENCE HOLD (Art. 73(6), `incident_evidence_hold`, strict default
 *    on): while a serious incident has an Article 73 authority clock pending
 *    (or tolled), a configuration change to an agent linked to it, or in its
 *    use case's approved stack, is refused
 *    with 409 `incident_evidence_hold`, unless an ADMIN overrides that one
 *    change with a reason (header `x-regulait-evidence-hold-override`), which
 *    is audited and noted on the incident's timeline.
 *  - THE DEPLOY GATE (`incident_gate_mode`, strict default `enforce`): a
 *    serious, high or critical incident that is not CLOSED holds its use
 *    case's gate (`deploy-gate.ts` reads `incidentGateInputs`). `resolved`
 *    releases nothing (D4 review D4A-01 / D4G-01).
 *  - Changes that would RELEASE that gate or the hold — downgrading severity
 *    below high, un-marking serious, moving the incident off its use case,
 *    and CLOSING a serious, high or critical incident — are an admin's (403
 *    for anyone else), audited. The owner closes a low or medium incident
 *    that is not serious; the close conditions apply to everyone.
 *  - A report recorded as sent carries a `sentAt` within [the clock's start,
 *    now] (422 otherwise); more than an hour back it is BACKDATED: it needs a
 *    reason and is audited as such, with both times (D4G-06).
 *  - WHAT A REPORTER MAY NAME: only a use case, agent, alert, red-team run or
 *    feedback item they can already see (404 otherwise — the same answer as
 *    for an unknown id, so nothing leaks). A hold applies at once (safety
 *    first); an admin releases one change through the override (D4A-02).
 *  - THE MONITOR: `incident_notification_due` (a clock due within 24 hours or
 *    overdue) and `incident_action_overdue`. `incident-clock-sweep` writes one
 *    timeline event per clock when it first falls due soon and when it
 *    becomes overdue.
 *  - VISIBILITY: an admin sees every incident; anyone else sees those they
 *    own, those they reported (D4A-07a), those on a use case they own and
 *    those whose evidence hold covers an agent they steward — linked, or in
 *    the use case's approved stack, the same predicate the hold uses
 *    (D4A-02); the last three read-only. The 409 `incident_evidence_hold`
 *    names the incidents the caller can open (`youCanOpen`). A reader sees a linked agent's name or the use case's
 *    details only when they can see that agent or use case (D4A-06). Writes
 *    are the incident's owner's or an admin's (an action's owner may update
 *    that action). A read of an incident's narrative by anyone but its
 *    reporter is audited.
 *  - EXPORT (admin): a signed bundle (ADR-0116 `buildExportBundle`, subject
 *    kind `ai-incident`) with the full record and the timeline, or the
 *    timeline as CSV. No signing key = an audited 409 refusal, never an
 *    unsigned bundle.
 *
 * Every clock is a reminder computed from the recorded awareness time and the
 * cited text, not legal advice; the EU AI Act ones say "confirm with counsel".
 *
 * Open source considered (ADR-0176): the OASIS STIX 2.1 `incident` object and
 * CSAF 2.0 — neither models AI-harm criteria or regulatory clocks, so the
 * register is our own (a STIX export is a PF-14 follow-up). Signing and the
 * bundle reuse ADR-0116's code; CSV cells use the shared `csvRecord`
 * (csv-stringify, MIT); the clock arithmetic is native `Date` (none fits for
 * regulation-specific periods).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agentGrants,
  agents,
  aiIncidentActions,
  aiIncidentEvents,
  aiIncidentLinks,
  aiIncidentNotifications,
  aiIncidents,
  aiUseCases,
  and,
  asc,
  auditLog,
  builderAgents,
  conversations,
  desc,
  eq,
  governanceAlerts,
  inArray,
  lte,
  ne,
  or,
  redteamRuns,
  sql,
  useCaseFeedback,
  users,
  type AiIncidentRow,
  type Db,
  type SQL,
} from "@regulait/db";
import {
  ART_73_6_PARAGRAPH,
  ART_73_6_QUOTE,
  EU_AI_ACT_CLOCK_CAVEAT,
  INCIDENT_CLOCK_DISCLAIMER,
  INCIDENT_CLOCK_RECIPIENT,
  applicableIncidentClocks,
  closeIncidentSchema,
  containIncidentSchema,
  createIncidentActionSchema,
  createIncidentSchema,
  csvRecord,
  evidenceHoldBinds,
  hasEuSeriousCriterion,
  incidentClockById,
  incidentClockDueAt,
  incidentClockDueLabel,
  incidentClockUrgency,
  incidentCloseBlockers,
  incidentCloseNeedsAdmin,
  incidentHoldsGate,
  incidentSentAtVerdict,
  incidentLinkSchema,
  incidentNoteSchema,
  incidentNotificationReasonSchema,
  incidentNotificationSentSchema,
  nextNotificationStatus,
  severityRank,
  updateIncidentActionSchema,
  updateIncidentSchema,
  INCIDENT_CLOCK_DUE_SOON_MS,
  type AccountabilityGateMode,
  type AccountabilityMonitorRuleId,
  type CreateIncidentInput,
  type IncidentClockFacts,
  type IncidentClockRegime,
  type IncidentEventKind,
  type IncidentLinkObjectType,
  type IncidentNotificationMove,
  type IncidentSeverity,
  type IncidentStatus,
  type MonitorAssuranceInput,
  type MonitorAssuranceSubject,
} from "@regulait/shared";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { loadOrgSettings, type OrgSettingsRow } from "./org-settings.js";
import { haltAgentInTx } from "./execution-control.js";
// X15-H01: hold creation takes the evidence-hold lock exclusively (agent-evidence-hold.ts has no static edge back here)
import { lockEvidenceHoldsExclusive } from "./agent-evidence-hold.js";
import { settingTransitions } from "./setting-transitions.js";
import { stepUpRefusal } from "./step-up.js";
import { buildExportBundle, resolveExportSigningKey } from "./export-bundle.js";
import { resolveLicense } from "./licensing.js";
import { securityHeaders } from "./security-headers.js";
import { loadVisibleAgent } from "./builder-access.js";
import { loadAgentRevocations, loadRoleAgentGrants } from "./entitlements.js";
import { canReadUseCase } from "./use-cases.js";

export const INCIDENT_CLOCK_SWEEP_JOB_NAME = "incident-clock-sweep";

/** the audit `rule_id`s this module writes (objectType `ai_incident`, objectId = the incident) */
export const INCIDENT_RULE_IDS = {
  created: "ai-incident-created",
  updated: "ai-incident-updated",
  refused: "ai-incident-change-refused",
  read: "ai-incident-read",
  noteAdded: "ai-incident-note-added",
  linked: "ai-incident-linked",
  actionCreated: "ai-incident-action-created",
  actionUpdated: "ai-incident-action-updated",
  clocksStarted: "ai-incident-clocks-started",
  notificationSent: "ai-incident-notification-sent",
  notificationNotRequired: "ai-incident-notification-not-required",
  notificationTolled: "ai-incident-notification-tolled",
  notificationRefused: "ai-incident-notification-refused",
  closed: "ai-incident-closed",
  closeRefused: "ai-incident-close-refused",
  contained: "ai-incident-contained",
  exported: "ai-incident-exported",
  exportRefused: "ai-incident-export-refused",
  evidenceHoldRefused: "ai-incident-evidence-hold-refused",
  evidenceHoldOverridden: "ai-incident-evidence-hold-overridden",
  clockFlagged: "ai-incident-clock-flagged",
} as const;

/** the request header an ADMIN sends, with a reason, to override the evidence hold for one change */
export const EVIDENCE_HOLD_OVERRIDE_HEADER = "x-regulait-evidence-hold-override";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Writer = Pick<Db, "insert" | "update" | "select" | "execute">;

/** a refusal with an HTTP status and a fixed code */
export class IncidentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface IncidentActor {
  userId: string | null;
  isAdmin: boolean;
  via?: string | undefined;
}
const actorOf = (req: FastifyRequest): IncidentActor => ({
  userId: req.authCtx.userId ?? null,
  isAdmin: req.authCtx.isAdmin,
  via: req.authCtx.via,
});

async function audit(
  db: Writer,
  row: {
    userId: string | null;
    objectId: string | null;
    ruleId: string;
    reason: string;
    effect?: "allow" | "deny";
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: row.userId ?? NIL_USER,
    objectType: "ai_incident",
    objectId: row.objectId,
    detail: row.detail ?? {},
    effect: row.effect ?? "allow",
    ruleId: row.ruleId,
    ruleChain: [],
    reason: row.reason,
  });
}

async function addEvent(
  db: Writer,
  incidentId: string,
  kind: IncidentEventKind,
  actorUserId: string | null,
  detail: Record<string, unknown>,
  note?: string,
): Promise<void> {
  await db.insert(aiIncidentEvents).values({ incidentId, kind, actorUserId, detail, ...(note ? { note } : {}) });
}

// ---------------------------------------------------------------------------
// clocks
// ---------------------------------------------------------------------------

interface UseCaseFacts {
  id: string;
  name: string;
  ownerUserId: string;
  workflowInstanceId: string | null;
  euAiActTier: string | null;
  euAiActRole: "provider" | "deployer" | "both";
}

async function loadUseCase(db: Writer, id: string | null): Promise<UseCaseFacts | null> {
  if (!id) return null;
  const [uc] = await db
    .select({
      id: aiUseCases.id,
      name: aiUseCases.name,
      ownerUserId: aiUseCases.ownerUserId,
      workflowInstanceId: aiUseCases.workflowInstanceId,
      euAiActTier: aiUseCases.euAiActTier,
      euAiActRole: aiUseCases.euAiActRole,
    })
    .from(aiUseCases)
    .where(eq(aiUseCases.id, id));
  return uc ?? null;
}

function clockFacts(i: AiIncidentRow, uc: UseCaseFacts | null): IncidentClockFacts {
  return {
    incident: {
      serious: i.serious,
      seriousCriteria: i.seriousCriteria ?? [],
      phiIndividuals: i.phiIndividuals ?? null,
      severity: i.severity,
    },
    useCase: uc ? { tier: uc.euAiActTier, euAiActRole: uc.euAiActRole } : null,
  };
}

/**
 * Create every applicable clock this incident does not have yet. Existing
 * clocks are never touched (a clock is never deleted or restarted). Returns
 * the ids of the clocks created.
 */
async function startApplicableClocks(
  tx: Writer,
  incident: AiIncidentRow,
  uc: UseCaseFacts | null,
  regimes: readonly IncidentClockRegime[],
  actorUserId: string | null,
): Promise<string[]> {
  const defs = applicableIncidentClocks(clockFacts(incident, uc), regimes);
  if (defs.length === 0) return [];
  const existing = await tx
    .select({ clockId: aiIncidentNotifications.clockId })
    .from(aiIncidentNotifications)
    .where(eq(aiIncidentNotifications.incidentId, incident.id));
  const have = new Set(existing.map((e) => e.clockId));
  const created: string[] = [];
  for (const def of defs) {
    if (have.has(def.id)) continue;
    const start = def.start === "occurred_at" && incident.occurredAt ? incident.occurredAt : incident.awareAt;
    const dueAt = incidentClockDueAt(def.due, start);
    const rows = await tx
      .insert(aiIncidentNotifications)
      .values({
        incidentId: incident.id,
        regime: def.regime,
        clockId: def.id,
        recipient: INCIDENT_CLOCK_RECIPIENT[def.id] ?? null,
        clockStart: start,
        dueAt,
      })
      .onConflictDoNothing()
      .returning({ id: aiIncidentNotifications.id });
    if (rows.length === 0) continue;
    created.push(def.id);
    await addEvent(tx, incident.id, "notification", actorUserId, {
      clockId: def.id,
      started: true,
      paragraph: def.paragraph,
      dueAt: dueAt.toISOString(),
    });
  }
  if (created.length > 0) {
    await audit(tx, {
      userId: actorUserId,
      objectId: incident.id,
      ruleId: INCIDENT_RULE_IDS.clocksStarted,
      reason: `incident ${incident.ref}: ${created.length} notification clock(s) started (${created.join(", ")}) from the recorded awareness time`,
      detail: { clockIds: created, regimes: [...regimes] },
    });
  }
  return created;
}

// ---------------------------------------------------------------------------
// access
// ---------------------------------------------------------------------------

async function loadIncident(db: Writer, id: string): Promise<AiIncidentRow | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db.select().from(aiIncidents).where(eq(aiIncidents.id, id));
  return row ?? null;
}

interface Access {
  canRead: boolean;
  canWrite: boolean;
  useCase: UseCaseFacts | null;
}

/**
 * THE ONE PREDICATE for "the agents this incident's evidence hold covers"
 * (correlated to the `ai_incidents` row in scope): the agent is LINKED to the
 * incident, or is in its use case's approved stack (`intended_agent_ids`).
 * `incidentsHoldingAgent` (the hold) and the steward's read access both use
 * it, so who is frozen and who may see why cannot drift apart.
 * `agentIdText` is an SQL expression yielding the agent id as text.
 */
export function incidentCoversAgent(agentIdText: SQL): SQL {
  return sql`(EXISTS (SELECT 1 FROM ${aiIncidentLinks} WHERE ${aiIncidentLinks.incidentId} = ${aiIncidents.id}
      AND ${aiIncidentLinks.objectType} = 'agent' AND ${aiIncidentLinks.objectId} = (${agentIdText})::text)
    OR EXISTS (SELECT 1 FROM ${aiUseCases} WHERE ${aiUseCases.id} = ${aiIncidents.useCaseId}
      AND ${aiUseCases.intendedAgentIds} @> jsonb_build_array((${agentIdText})::text)))`;
}

/**
 * Does the incident in scope cover an agent this person stewards (a registry
 * agent's steward, or a builder agent's owner)? They may READ it: its
 * evidence hold may freeze their agent, so they see why (D4 review D4A-02).
 */
function incidentCoversAgentStewardedBy(userId: string): SQL {
  return sql`(EXISTS (SELECT 1 FROM ${agents} WHERE ${agents.ownerUserId} = ${userId} AND ${incidentCoversAgent(sql`${agents.id}`)})
    OR EXISTS (SELECT 1 FROM ${builderAgents} WHERE ${builderAgents.ownerUserId} = ${userId} AND ${incidentCoversAgent(sql`${builderAgents.id}`)}))`;
}

async function stewardsCoveredAgent(db: Writer, incidentId: string, userId: string): Promise<boolean> {
  const [hit] = await db
    .select({ id: aiIncidents.id })
    .from(aiIncidents)
    .where(and(eq(aiIncidents.id, incidentId), incidentCoversAgentStewardedBy(userId)))
    .limit(1);
  return Boolean(hit);
}

/**
 * WHO SEES AND CHANGES AN INCIDENT. Writes: its owner or an admin. Reads, as
 * well: whoever reported it (D4A-07a), the owner of its use case, and the
 * steward of any agent its evidence hold covers — linked, or in the use
 * case's approved stack (D4A-02) — all read-only.
 */
async function accessTo(db: Writer, actor: IncidentActor, i: AiIncidentRow): Promise<Access> {
  const useCase = await loadUseCase(db, i.useCaseId);
  const me = actor.userId;
  const isOwner = me !== null && me === i.ownerUserId;
  const canWrite = actor.isAdmin || isOwner;
  const canRead =
    canWrite ||
    (me !== null &&
      (me === i.createdBy || useCase?.ownerUserId === me || (await stewardsCoveredAgent(db, i.id, me))));
  return { canRead, canWrite, useCase };
}

/** load an incident the actor may WRITE, or throw the refusal (404 when they may not even see it) */
async function writable(db: Writer, actor: IncidentActor, id: string, what: string): Promise<{ incident: AiIncidentRow; access: Access }> {
  const incident = await loadIncident(db, id);
  if (!incident) throw new IncidentError(404, "not_found", "no such incident");
  const access = await accessTo(db, actor, incident);
  if (!access.canRead) throw new IncidentError(404, "not_found", "no such incident");
  if (!access.canWrite) {
    await audit(db, {
      userId: actor.userId,
      objectId: incident.id,
      ruleId: INCIDENT_RULE_IDS.refused,
      effect: "deny",
      reason: `incident ${incident.ref}: ${what} refused — only the incident's owner or an admin may change it`,
      detail: { what },
    });
    throw new IncidentError(403, "forbidden", `only the incident's owner or an admin may ${what}`);
  }
  if (incident.status === "closed") {
    throw new IncidentError(409, "incident_closed", `incident ${incident.ref} is closed; a closed incident is not changed`);
  }
  return { incident, access };
}

// ---------------------------------------------------------------------------
// creating an incident (also the entry point for "open incident" elsewhere)
// ---------------------------------------------------------------------------

async function userExists(db: Writer, id: string): Promise<boolean> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
  return Boolean(u);
}

/**
 * May this person see this registry or builder agent? The existing rules:
 * an admin; for a registry agent its steward or a person holding a grant to
 * it (direct or through a role, and not revoked); for a builder agent the
 * builder's own visibility (owner, workspace, named people). An unknown id is
 * `false`, so an unknown and an invisible agent answer the same.
 */
async function agentVisibleTo(db: Writer, actor: IncidentActor, agentId: string): Promise<boolean> {
  if (!UUID_RE.test(agentId)) return false;
  const [reg] = await db.select({ id: agents.id, ownerUserId: agents.ownerUserId }).from(agents).where(eq(agents.id, agentId));
  const me = actor.userId;
  if (reg) {
    if (actor.isAdmin) return true;
    if (!me) return false;
    if (reg.ownerUserId === me) return true;
    if ((await loadAgentRevocations(db as Db, me)).some((r) => r.agentId === agentId)) return false;
    const [direct] = await db
      .select({ id: agentGrants.id })
      .from(agentGrants)
      .where(and(eq(agentGrants.userId, me), eq(agentGrants.agentId, agentId)))
      .limit(1);
    if (direct) return true;
    return (await loadRoleAgentGrants(db as Db, me)).some((g) => g.agentId === agentId);
  }
  if (actor.isAdmin) {
    const [b] = await db.select({ id: builderAgents.id }).from(builderAgents).where(eq(builderAgents.id, agentId));
    return Boolean(b);
  }
  if (!me) return false;
  return (await loadVisibleAgent(db as Db, agentId, { userId: me, isAdmin: false })) !== null;
}

/**
 * May this person name this object on an incident (D4 review D4A-02 / D4A-06)?
 * Only what they can already see: an agent (above), a monitor alert they own,
 * a red-team run they started, a feedback item on a use case they own — or
 * anything, for an admin. Unknown and invisible answer the same (`false`), so
 * the refusal reveals nothing. The free-text link types (model, vendor, risk…)
 * name nothing a hold or a gate reads, and are accepted as given.
 */
async function linkTargetVisible(db: Writer, actor: IncidentActor, objectType: IncidentLinkObjectType, objectId: string): Promise<boolean> {
  const isUuid = UUID_RE.test(objectId);
  const me = actor.userId;
  switch (objectType) {
    case "agent":
      return agentVisibleTo(db, actor, objectId);
    case "governance_alert": {
      if (!isUuid) return false;
      const [g] = await db
        .select({ id: governanceAlerts.id, ownerUserId: governanceAlerts.ownerUserId })
        .from(governanceAlerts)
        .where(eq(governanceAlerts.id, objectId));
      return Boolean(g) && (actor.isAdmin || (me !== null && g!.ownerUserId === me));
    }
    case "redteam_run": {
      if (!isUuid) return false;
      const [r] = await db
        .select({ id: redteamRuns.id, by: redteamRuns.initiatedByUserId })
        .from(redteamRuns)
        .where(eq(redteamRuns.id, objectId));
      return Boolean(r) && (actor.isAdmin || (me !== null && r!.by === me));
    }
    case "feedback": {
      if (!isUuid) return false;
      const [f] = await db
        .select({ id: useCaseFeedback.id, ownerUserId: aiUseCases.ownerUserId })
        .from(useCaseFeedback)
        .innerJoin(aiUseCases, eq(aiUseCases.id, useCaseFeedback.useCaseId))
        .where(eq(useCaseFeedback.id, objectId));
      return Boolean(f) && (actor.isAdmin || (me !== null && f!.ownerUserId === me));
    }
    // ADR-0185 I3 (migration 0169): a conversation link holds it from the
    // retention sweep, so it must name a real conversation, and a non-admin
    // may hold only their own (conversations are strictly own-scoped)
    case "conversation": {
      if (!isUuid) return false;
      const [c] = await db
        .select({ id: conversations.id, userId: conversations.userId })
        .from(conversations)
        .where(eq(conversations.id, objectId));
      return Boolean(c) && (actor.isAdmin || (me !== null && c!.userId === me));
    }
    default:
      return true;
  }
}

/** does a link's target exist? (for the links a SOURCE implies — the source itself was checked for visibility) */
async function linkTargetExists(db: Writer, objectType: IncidentLinkObjectType, objectId: string): Promise<boolean> {
  return linkTargetVisible(db, { userId: null, isAdmin: true }, objectType, objectId);
}

/** a use case this person may name on an incident: one they can read (owner, admin, its intake reviewers) */
async function useCaseVisibleTo(db: Writer, actor: IncidentActor, uc: UseCaseFacts | null): Promise<boolean> {
  return uc !== null && (await canReadUseCase(db as Db, uc, actor));
}

/** the one refusal for an unknown OR invisible target: 404, the same words either way */
const notVisible = (what: "use case" | "link target" | "source", id: string) =>
  new IncidentError(
    404,
    what === "use case" ? "unknown_use_case" : what === "source" ? "unknown_source" : "unknown_link_target",
    `no ${what} '${id}' that you can see`,
  );

type LinkSpec = { objectType: IncidentLinkObjectType; objectId: string };

/**
 * What opening an incident FROM something pre-links: a monitor alert (the
 * alert, its agent, and its use case when none was named), a red-team run
 * (the run and its agent) or a feedback item (the item and its use case).
 */
async function sourceLinks(
  db: Writer,
  body: CreateIncidentInput,
  actor: IncidentActor,
): Promise<{ links: LinkSpec[]; useCaseId: string | null }> {
  const ref = body.sourceRef;
  if (!ref) return { links: [], useCaseId: null };
  // D4A-06: an unknown source and one the reporter cannot see answer the same 404
  const unknown = () => notVisible("source", ref);
  const kind: IncidentLinkObjectType | null =
    body.detectionSource === "monitor_alert"
      ? "governance_alert"
      : body.detectionSource === "red_team"
        ? "redteam_run"
        : body.detectionSource === "user_report" && UUID_RE.test(ref)
          ? "feedback"
          : null;
  if (kind && !(await linkTargetVisible(db, actor, kind, ref))) throw unknown();
  if (body.detectionSource === "monitor_alert") {
    if (!UUID_RE.test(ref)) throw unknown();
    const [al] = await db
      .select({ id: governanceAlerts.id, subjectKey: governanceAlerts.subjectKey })
      .from(governanceAlerts)
      .where(eq(governanceAlerts.id, ref));
    if (!al) throw unknown();
    const links: LinkSpec[] = [{ objectType: "governance_alert", objectId: al.id }];
    let useCaseId: string | null = null;
    for (const part of al.subjectKey.split(">")) {
      const [kind, id] = part.split(":");
      if (kind === "agent" && id && UUID_RE.test(id)) links.push({ objectType: "agent", objectId: id });
      if (kind === "use_case" && id && UUID_RE.test(id)) useCaseId = id;
    }
    return { links, useCaseId };
  }
  if (body.detectionSource === "red_team") {
    if (!UUID_RE.test(ref)) throw unknown();
    const [run] = await db.select({ id: redteamRuns.id, agentId: redteamRuns.agentId }).from(redteamRuns).where(eq(redteamRuns.id, ref));
    if (!run) throw unknown();
    const links: LinkSpec[] = [{ objectType: "redteam_run", objectId: run.id }];
    if (run.agentId) links.push({ objectType: "agent", objectId: run.agentId });
    return { links, useCaseId: null };
  }
  if (body.detectionSource === "user_report" && UUID_RE.test(ref)) {
    const [fb] = await db
      .select({ id: useCaseFeedback.id, useCaseId: useCaseFeedback.useCaseId })
      .from(useCaseFeedback)
      .where(eq(useCaseFeedback.id, ref));
    if (!fb) throw unknown();
    return { links: [{ objectType: "feedback", objectId: fb.id }], useCaseId: fb.useCaseId };
  }
  return { links: [], useCaseId: null };
}

function validTimes(body: Record<string, string | null | undefined>, now: Date) {
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string" && new Date(v).getTime() > now.getTime() + 60_000) {
      throw new IncidentError(422, "time_in_future", `${k} is in the future; record when it actually happened`);
    }
  }
}

/**
 * Open an incident: validates, pre-links what it was opened from, defaults
 * the owner (named owner, else the use case's owner, else the reporter),
 * starts the applicable clocks, writes the first timeline event and the audit
 * row — all in one transaction. Exported so another module (A13's "open
 * incident" from a feedback item) opens one through the same path.
 */
export async function createIncident(db: Db, input: CreateIncidentInput, actor: IncidentActor): Promise<AiIncidentRow> {
  const body = createIncidentSchema.parse(input);
  const now = new Date();
  validTimes({ occurredAt: body.occurredAt, awareAt: body.awareAt }, now);
  if (body.phiIndividuals !== undefined && !body.seriousCriteria.includes("phi_breach")) {
    throw new IncidentError(422, "phi_individuals_without_phi_breach", "a PHI head count is recorded only with the phi_breach criterion");
  }
  const fromSource = await sourceLinks(db, body, actor);
  const useCaseId = body.useCaseId ?? fromSource.useCaseId;
  const uc = await loadUseCase(db, useCaseId ?? null);
  // D4A-02: a reporter names only a use case they can see (one a source
  // implies came with a source they can see); unknown and invisible are one 404
  if (body.useCaseId && !(await useCaseVisibleTo(db, actor, uc))) throw notVisible("use case", body.useCaseId);
  if (useCaseId && !uc) throw notVisible("use case", useCaseId);
  if (body.ownerUserId && !(await userExists(db, body.ownerUserId))) {
    throw new IncidentError(422, "unknown_user", "the named owner is not a user of this deployment");
  }
  const links: LinkSpec[] = [];
  const seen = new Set<string>();
  // D4A-02: what the reporter names, they must be able to see; what the
  // (visible) source implies is linked as the source states it
  for (const [l, implied] of [...fromSource.links.map((x) => [x, true] as const), ...body.links.map((x) => [x, false] as const)]) {
    const k = `${l.objectType}:${l.objectId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const ok = implied ? await linkTargetExists(db, l.objectType, l.objectId) : await linkTargetVisible(db, actor, l.objectType, l.objectId);
    if (!ok) throw notVisible("link target", l.objectId);
    links.push(l);
  }
  // Art. 3(49): any of these criteria IS a serious incident
  const serious = body.serious || hasEuSeriousCriterion(body.seriousCriteria);
  const ownerUserId = body.ownerUserId ?? uc?.ownerUserId ?? actor.userId;
  const org = await loadOrgSettings(db);
  const regimes = (org.incidentClockRegimes ?? []) as IncidentClockRegime[];

  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await lockEvidenceHoldsExclusive(tx); // X15-H01: a new serious incident begins a hold — first lock of the transaction
    const [row] = await tx
      .insert(aiIncidents)
      .values({
        title: body.title,
        summary: body.summary,
        severity: body.severity,
        detectionSource: body.detectionSource,
        sourceRef: body.sourceRef ?? null,
        occurredAt: body.occurredAt ? new Date(body.occurredAt) : null,
        awareAt: body.awareAt ? new Date(body.awareAt) : now,
        ownerUserId,
        useCaseId: uc?.id ?? null,
        serious,
        seriousCriteria: [...new Set(body.seriousCriteria)],
        phiIndividuals: body.phiIndividuals ?? null,
        createdBy: actor.userId,
      })
      .returning();
    const incident = row!;
    await addEvent(tx, incident.id, "status", actor.userId, {
      to: "open",
      severity: incident.severity,
      serious: incident.serious,
      detectionSource: incident.detectionSource,
    });
    for (const l of links) {
      await tx.insert(aiIncidentLinks).values({ incidentId: incident.id, ...l, createdBy: actor.userId }).onConflictDoNothing();
      await addEvent(tx, incident.id, "link", actor.userId, { objectType: l.objectType, objectId: l.objectId, added: true });
    }
    await audit(tx, {
      userId: actor.userId,
      objectId: incident.id,
      ruleId: INCIDENT_RULE_IDS.created,
      reason:
        `incident ${incident.ref} opened (${incident.severity}${incident.serious ? ", serious" : ""}` +
        `${incident.seriousCriteria.length ? `: ${incident.seriousCriteria.join(", ")}` : ""}) from ${incident.detectionSource}` +
        (uc ? ` on use case ${uc.id}` : ""),
      detail: {
        via: actor.via ?? null,
        severity: incident.severity,
        serious: incident.serious,
        seriousCriteria: incident.seriousCriteria,
        detectionSource: incident.detectionSource,
        useCaseId: incident.useCaseId,
        ownerUserId: incident.ownerUserId,
        links,
        awareAt: incident.awareAt.toISOString(),
      },
    });
    await startApplicableClocks(tx, incident, uc, regimes, actor.userId);
    return incident;
  });
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

async function namesOf(db: Writer, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === "string"))];
  if (want.length === 0) return new Map();
  const rows = await db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(inArray(users.id, want));
  return new Map(rows.map((r) => [r.id, r.displayName || r.email]));
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function clockView(n: typeof aiIncidentNotifications.$inferSelect, now: Date) {
  const def = incidentClockById(n.clockId);
  return {
    id: n.id,
    regime: n.regime,
    clockId: n.clockId,
    paragraph: def?.paragraph ?? n.clockId,
    quote: def?.quote ?? null,
    sourceUrl: def?.sourceUrl ?? null,
    retrievedOn: def?.retrievedOn ?? null,
    period: def ? incidentClockDueLabel(def.due) : null,
    immediately: def?.due.kind === "immediately",
    allowsInitialReport: def?.allowsInitialReport ?? false,
    caveat: n.regime === "eu-ai-act" ? EU_AI_ACT_CLOCK_CAVEAT : null,
    recipient: n.recipient,
    clockStart: n.clockStart.toISOString(),
    dueAt: n.dueAt.toISOString(),
    status: n.status,
    urgency: incidentClockUrgency(n, now),
    sentAt: iso(n.sentAt),
    sentBy: n.sentBy,
    reference: n.reference,
    reason: n.reason,
  };
}

async function incidentDetail(db: Writer, incident: AiIncidentRow, access: Access, actor: IncidentActor, org: OrgSettingsRow) {
  const now = new Date();
  const [links, actions, notifications, events] = await Promise.all([
    db.select().from(aiIncidentLinks).where(eq(aiIncidentLinks.incidentId, incident.id)).orderBy(asc(aiIncidentLinks.createdAt)),
    db.select().from(aiIncidentActions).where(eq(aiIncidentActions.incidentId, incident.id)).orderBy(asc(aiIncidentActions.createdAt)),
    db.select().from(aiIncidentNotifications).where(eq(aiIncidentNotifications.incidentId, incident.id)).orderBy(asc(aiIncidentNotifications.dueAt)),
    db.select().from(aiIncidentEvents).where(eq(aiIncidentEvents.incidentId, incident.id)).orderBy(asc(aiIncidentEvents.at), asc(aiIncidentEvents.id)),
  ]);
  const names = await namesOf(db, [
    incident.ownerUserId,
    incident.createdBy,
    incident.closedBy,
    ...actions.map((a) => a.ownerUserId),
    ...events.map((e) => e.actorUserId),
    ...notifications.map((n) => n.sentBy),
  ]);
  const agentIds = links.filter((l) => l.objectType === "agent" && UUID_RE.test(l.objectId)).map((l) => l.objectId);
  const agentRows = agentIds.length
    ? await db.select({ id: agents.id, name: agents.name, haltedAt: agents.haltedAt }).from(agents).where(inArray(agents.id, agentIds))
    : [];
  const builderRows = agentIds.length
    ? await db.select({ id: builderAgents.id, name: builderAgents.name }).from(builderAgents).where(inArray(builderAgents.id, agentIds))
    : [];
  const agentInfo = new Map<string, { name: string; halted: boolean | null; kind: "registry" | "builder" }>([
    ...agentRows.map((a) => [a.id, { name: a.name, halted: a.haltedAt !== null, kind: "registry" as const }] as const),
    ...builderRows.map((b) => [b.id, { name: b.name, halted: null, kind: "builder" as const }] as const),
  ]);
  // D4A-06: a reader learns only what they can already see — a linked agent's
  // name and state only when that agent is visible to them, the use case's
  // details only when they may read the use case (or work the incident)
  const agentShown = new Map<string, boolean>();
  for (const id of agentIds) agentShown.set(id, actor.isAdmin || (await agentVisibleTo(db, actor, id)));
  const useCaseShown =
    access.useCase !== null && (actor.isAdmin || access.canWrite || (await useCaseVisibleTo(db, actor, access.useCase)));
  const shownAgent = (id: string) => (agentShown.get(id) ? agentInfo.get(id) : undefined);
  const mode = org.incidentGateMode as AccountabilityGateMode;
  const canEdit = access.canWrite && incident.status !== "closed";
  return {
    incident: {
      id: incident.id,
      ref: incident.ref,
      title: incident.title,
      summary: incident.summary,
      severity: incident.severity,
      status: incident.status,
      detectionSource: incident.detectionSource,
      sourceRef: incident.sourceRef,
      occurredAt: iso(incident.occurredAt),
      awareAt: incident.awareAt.toISOString(),
      ownerUserId: incident.ownerUserId,
      ownerName: incident.ownerUserId ? (names.get(incident.ownerUserId) ?? null) : null,
      useCaseId: incident.useCaseId,
      serious: incident.serious,
      seriousCriteria: incident.seriousCriteria,
      phiIndividuals: incident.phiIndividuals,
      rootCause: incident.rootCause,
      lessonsLearned: incident.lessonsLearned,
      closedAt: iso(incident.closedAt),
      closedBy: incident.closedBy,
      closedByName: incident.closedBy ? (names.get(incident.closedBy) ?? null) : null,
      createdBy: incident.createdBy,
      createdByName: incident.createdBy ? (names.get(incident.createdBy) ?? null) : null,
      createdAt: incident.createdAt.toISOString(),
      updatedAt: incident.updatedAt.toISOString(),
    },
    useCase:
      access.useCase && useCaseShown
        ? { id: access.useCase.id, name: access.useCase.name, euAiActTier: access.useCase.euAiActTier, euAiActRole: access.useCase.euAiActRole }
        : null,
    links: links.map((l) => ({
      objectType: l.objectType,
      objectId: l.objectId,
      label: l.objectType === "agent" ? (shownAgent(l.objectId)?.name ?? null) : null,
      agentKind: l.objectType === "agent" ? (shownAgent(l.objectId)?.kind ?? null) : null,
      halted: l.objectType === "agent" ? (shownAgent(l.objectId)?.halted ?? null) : null,
      createdAt: l.createdAt.toISOString(),
    })),
    actions: actions.map((a) => ({
      id: a.id,
      title: a.title,
      ownerUserId: a.ownerUserId,
      ownerName: a.ownerUserId ? (names.get(a.ownerUserId) ?? null) : null,
      dueAt: iso(a.dueAt),
      status: a.status,
      overdue: a.status === "open" && a.dueAt !== null && a.dueAt.getTime() < now.getTime(),
      doneAt: iso(a.doneAt),
      evidenceRef: a.evidenceRef,
    })),
    notifications: notifications.map((n) => ({ ...clockView(n, now), sentByName: n.sentBy ? (names.get(n.sentBy) ?? null) : null })),
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      at: e.at.toISOString(),
      actorUserId: e.actorUserId,
      actorName: e.actorUserId ? (names.get(e.actorUserId) ?? null) : null,
      note: e.note,
      detail: e.detail,
    })),
    evidenceHold: {
      setting: org.incidentEvidenceHold,
      binds: org.incidentEvidenceHold && evidenceHoldBinds(incident, notifications),
      paragraph: ART_73_6_PARAGRAPH,
      quote: ART_73_6_QUOTE,
    },
    gate: { mode, holds: mode === "off" ? null : incidentHoldsGate(incident) },
    permissions: {
      canEdit,
      // D4A-01: closing a serious, high or critical incident is an admin's
      closeNeedsAdmin: incidentCloseNeedsAdmin(incident),
      canClose: canEdit && (actor.isAdmin || !incidentCloseNeedsAdmin(incident)),
      isAdmin: actor.isAdmin,
    },
    disclaimer: INCIDENT_CLOCK_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// the deploy gate, the evidence hold, the monitor, the sweep
// ---------------------------------------------------------------------------

/** ADR-0182 A12: what `deploy-gate.ts` reads — the org's mode and the use case's incidents that are not closed */
export async function incidentGateInputs(
  db: Db,
  useCaseId: string,
  org: Pick<OrgSettingsRow, "incidentGateMode">,
): Promise<{
  mode: AccountabilityGateMode;
  incidents: Array<{ id: string; ref: string; status: IncidentStatus; severity: IncidentSeverity; serious: boolean }>;
}> {
  const mode = org.incidentGateMode as AccountabilityGateMode;
  if (mode === "off") return { mode, incidents: [] };
  const rows = await db
    .select({ id: aiIncidents.id, ref: aiIncidents.ref, status: aiIncidents.status, severity: aiIncidents.severity, serious: aiIncidents.serious })
    .from(aiIncidents)
    .where(and(eq(aiIncidents.useCaseId, useCaseId), ne(aiIncidents.status, "closed")))
    .orderBy(asc(aiIncidents.createdAt));
  return { mode, incidents: rows };
}

/**
 * The incidents whose Art. 73(6) evidence hold binds this agent right now
 * (empty when the setting is off): those the agent is LINKED to, and those on
 * a use case whose approved stack (`intended_agent_ids`) includes it
 * (main-session decision 2026-10-06, secure by default).
 */
export async function incidentsHoldingAgent(db: Db, agentId: string): Promise<Array<{ id: string; ref: string }>> {
  const org = await loadOrgSettings(db);
  if (!org.incidentEvidenceHold) return [];
  const linked = await db
    .select({ id: aiIncidents.id, ref: aiIncidents.ref, status: aiIncidents.status, serious: aiIncidents.serious })
    .from(aiIncidents)
    .where(and(ne(aiIncidents.status, "closed"), eq(aiIncidents.serious, true), incidentCoversAgent(sql`${agentId}`)));
  if (linked.length === 0) return [];
  const clocks = await db
    .select({ incidentId: aiIncidentNotifications.incidentId, clockId: aiIncidentNotifications.clockId, status: aiIncidentNotifications.status })
    .from(aiIncidentNotifications)
    .where(inArray(aiIncidentNotifications.incidentId, linked.map((l) => l.id)));
  return linked
    .filter((i) => evidenceHoldBinds(i, clocks.filter((c) => c.incidentId === i.id)))
    .map((i) => ({ id: i.id, ref: i.ref }));
}

/** X15-H01: the incidents each request has already overridden (keyed weakly on the request) */
const overriddenIn = new WeakMap<FastifyRequest, Set<string>>();

/**
 * THE EVIDENCE HOLD at an agent-configuration write path (Art. 73(6)). Call it
 * before the change is written; when it returns true it has already sent the
 * refusal and the handler returns `reply`:
 *
 *   if (await incidentEvidenceHoldRefused(db, req, reply, agentId, "system prompt")) return reply;
 *
 * Allowed silently when `incident_evidence_hold` is off or no serious incident
 * linked to the agent awaits its authority notification. Otherwise 409
 * `incident_evidence_hold` (audited), unless an ADMIN sends the override
 * header with a reason of at least 10 characters (URI-encoded if it is not
 * plain ASCII): the change then proceeds, and the override is audited and
 * noted on each holding incident's timeline. The header from anyone else is
 * refused 403 and audited.
 */
export async function incidentEvidenceHoldRefused(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  agentId: string,
  change: string,
): Promise<boolean> {
  // X15-H01: the hold is asked twice per protected write (the route's pre-check, then inside the write's own
  // transaction); an incident this request already overrode (and audited) is not asked again
  const answered = overriddenIn.get(req);
  const holding = (await incidentsHoldingAgent(db, agentId)).filter((h) => !answered?.has(h.id));
  if (holding.length === 0) return false;
  const actor = actorOf(req);
  const raw = req.headers[EVIDENCE_HOLD_OVERRIDE_HEADER];
  let override: string | null = null;
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      override = decodeURIComponent(raw).trim();
    } catch {
      override = raw.trim();
    }
  }
  const refs = holding.map((h) => h.ref).join(", ");
  // whoever the hold freezes can see why: the refusal names the incidents the
  // CALLER may open (the steward of a covered agent reads them)
  const holdingRows = await db.select().from(aiIncidents).where(inArray(aiIncidents.id, holding.map((h) => h.id)));
  const youCanOpen: Array<{ id: string; ref: string }> = [];
  for (const row of holdingRows) {
    if ((await accessTo(db, actor, row)).canRead) youCanOpen.push({ id: row.id, ref: row.ref });
  }
  const openable = youCanOpen.length ? ` You can open ${youCanOpen.map((y) => y.ref).join(", ")} to see why.` : "";
  const base = {
    citation: ART_73_6_PARAGRAPH,
    quote: ART_73_6_QUOTE,
    incidents: holding,
    agentId,
    change,
  };
  if (override !== null && actor.isAdmin && override.length >= 10 && override.length <= 2000) {
    // ADR-0186 A: an override needs an `evidence_hold_override` step-up bound
    // to this agent, this change, the incidents holding it and the reason
    const stepUp = await stepUpRefusal(db, req, {
      kind: "evidence_hold_override",
      facts: { agentId, change, incidents: holding.map((h) => h.id).sort(), reason: override },
    });
    if (stepUp) {
      reply.status(stepUp.status).send(stepUp.body);
      return true;
    }
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      for (const h of holding) {
        await addEvent(tx, h.id, "note", actor.userId, { evidenceHoldOverride: true, agentId, change }, `Evidence hold overridden for a change to agent ${agentId} (${change}): ${override}`);
        await audit(tx, {
          userId: actor.userId,
          objectId: h.id,
          ruleId: INCIDENT_RULE_IDS.evidenceHoldOverridden,
          reason: `incident ${h.ref}: Art. 73(6) evidence hold OVERRIDDEN by an admin for a change to agent ${agentId} (${change}): ${override}`,
          detail: { agentId, change, via: actor.via ?? null, citation: ART_73_6_PARAGRAPH },
        });
      }
    });
    const seen = overriddenIn.get(req) ?? new Set<string>();
    for (const h of holding) seen.add(h.id);
    overriddenIn.set(req, seen);
    return false;
  }
  const notAdmin = override !== null && !actor.isAdmin;
  await audit(db, {
    userId: actor.userId,
    objectId: holding[0]!.id,
    ruleId: INCIDENT_RULE_IDS.evidenceHoldRefused,
    effect: "deny",
    reason:
      `agent ${agentId}: ${change} change refused under the Art. 73(6) evidence hold of incident(s) ${refs}` +
      (notAdmin ? " — an override was offered by someone who is not an admin" : ""),
    detail: { ...base, overrideOffered: override !== null, overrideByNonAdmin: notAdmin },
  });
  if (notAdmin) {
    reply.status(403).send({
      error: "evidence_hold_override_admin_only",
      detail: "only an admin may override the incident evidence hold, and the override is recorded with its reason." + openable,
      ...base,
      youCanOpen,
    });
    return true;
  }
  if (override !== null) {
    reply.status(422).send({
      error: "evidence_hold_override_reason_required",
      detail: `an override states why the change cannot wait (10 to 2000 characters, in the ${EVIDENCE_HOLD_OVERRIDE_HEADER} header)`,
      ...base,
      youCanOpen,
    });
    return true;
  }
  reply.status(409).send({
    error: "incident_evidence_hold",
    detail:
      `This agent is linked to serious incident(s) ${refs}, whose report to the authority has not been sent. ` +
      `${ART_73_6_PARAGRAPH} forbids altering the AI system in a way that may affect the later evaluation of the ` +
      "incident's causes before the authority is informed. Record the report on the incident first, or an admin may " +
      `override this one change with a reason in the ${EVIDENCE_HOLD_OVERRIDE_HEADER} header (audited).` +
      openable,
    ...base,
    youCanOpen,
    override: { header: EVIDENCE_HOLD_OVERRIDE_HEADER, adminOnly: true, reasonMinLength: 10 },
  });
  return true;
}

/** The monitor's loader for the two incident rules (governance-monitor.ts). Titles carry refs and paragraphs, never typed text. */
export async function incidentMonitorInput(
  db: Db,
  now: Date,
): Promise<Partial<Record<AccountabilityMonitorRuleId, MonitorAssuranceInput>>> {
  const soon = new Date(now.getTime() + INCIDENT_CLOCK_DUE_SOON_MS);
  const clocks = await db
    .select({
      id: aiIncidentNotifications.id,
      incidentId: aiIncidentNotifications.incidentId,
      clockId: aiIncidentNotifications.clockId,
      regime: aiIncidentNotifications.regime,
      dueAt: aiIncidentNotifications.dueAt,
      status: aiIncidentNotifications.status,
      ref: aiIncidents.ref,
      useCaseId: aiIncidents.useCaseId,
    })
    .from(aiIncidentNotifications)
    .innerJoin(aiIncidents, eq(aiIncidents.id, aiIncidentNotifications.incidentId))
    .where(
      and(
        inArray(aiIncidentNotifications.status, ["pending", "sent_initial"]),
        lte(aiIncidentNotifications.dueAt, soon),
        ne(aiIncidents.status, "closed"),
      ),
    );
  const due: MonitorAssuranceSubject[] = clocks.map((c) => {
    const overdue = c.dueAt.getTime() <= now.getTime();
    const paragraph = incidentClockById(c.clockId)?.paragraph ?? c.clockId;
    return {
      subjectKey: `incident:${c.incidentId}>clock:${c.clockId}`,
      title: `${c.ref}: ${paragraph} notification ${overdue ? "overdue" : "due within 24 hours"}`,
      detail: {
        incidentId: c.incidentId,
        ref: c.ref,
        clockId: c.clockId,
        regime: c.regime,
        notificationId: c.id,
        dueAt: c.dueAt.toISOString(),
        status: c.status,
        overdue,
        useCaseId: c.useCaseId,
        note: INCIDENT_CLOCK_DISCLAIMER,
      },
    };
  });
  const actions = await db
    .select({ id: aiIncidentActions.id, incidentId: aiIncidentActions.incidentId, dueAt: aiIncidentActions.dueAt, ref: aiIncidents.ref })
    .from(aiIncidentActions)
    .innerJoin(aiIncidents, eq(aiIncidents.id, aiIncidentActions.incidentId))
    .where(and(eq(aiIncidentActions.status, "open"), lte(aiIncidentActions.dueAt, now), ne(aiIncidents.status, "closed")));
  const overdueActions: MonitorAssuranceSubject[] = actions.map((a) => ({
    subjectKey: `incident:${a.incidentId}>action:${a.id}`,
    title: `${a.ref}: corrective action overdue`,
    detail: { incidentId: a.incidentId, ref: a.ref, actionId: a.id, dueAt: a.dueAt ? a.dueAt.toISOString() : null },
  }));
  return { incident_notification_due: { breaches: due }, incident_action_overdue: { breaches: overdueActions } };
}

/**
 * `incident-clock-sweep`: one timeline event (and audit row) per clock when it
 * first falls due within 24 hours, and again when it becomes overdue. Never
 * changes a clock's state. Idempotent: a flag already on the timeline is not
 * written twice.
 */
export async function runIncidentClockSweep(db: Db, now: Date, actorUserId: string | null): Promise<{ flagged: number }> {
  const soon = new Date(now.getTime() + INCIDENT_CLOCK_DUE_SOON_MS);
  const clocks = await db
    .select({
      incidentId: aiIncidentNotifications.incidentId,
      clockId: aiIncidentNotifications.clockId,
      dueAt: aiIncidentNotifications.dueAt,
      ref: aiIncidents.ref,
    })
    .from(aiIncidentNotifications)
    .innerJoin(aiIncidents, eq(aiIncidents.id, aiIncidentNotifications.incidentId))
    .where(
      and(
        inArray(aiIncidentNotifications.status, ["pending", "sent_initial"]),
        lte(aiIncidentNotifications.dueAt, soon),
        ne(aiIncidents.status, "closed"),
      ),
    );
  if (clocks.length === 0) return { flagged: 0 };
  const prior = await db
    .select({ incidentId: aiIncidentEvents.incidentId, detail: aiIncidentEvents.detail })
    .from(aiIncidentEvents)
    .where(and(inArray(aiIncidentEvents.incidentId, [...new Set(clocks.map((c) => c.incidentId))]), eq(aiIncidentEvents.kind, "notification")));
  const flaggedAlready = new Set(
    prior
      .filter((p) => typeof p.detail?.flag === "string")
      .map((p) => `${p.incidentId}|${String(p.detail.clockId)}|${String(p.detail.flag)}`),
  );
  let flagged = 0;
  for (const c of clocks) {
    const flag = c.dueAt.getTime() <= now.getTime() ? "overdue" : "due_soon";
    if (flaggedAlready.has(`${c.incidentId}|${c.clockId}|${flag}`)) continue;
    const paragraph = incidentClockById(c.clockId)?.paragraph ?? c.clockId;
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await addEvent(tx, c.incidentId, "notification", actorUserId, { clockId: c.clockId, flag, dueAt: c.dueAt.toISOString(), sweep: true });
      await audit(tx, {
        userId: actorUserId,
        objectId: c.incidentId,
        ruleId: INCIDENT_RULE_IDS.clockFlagged,
        reason: `incident ${c.ref}: ${paragraph} notification ${flag === "overdue" ? "is OVERDUE" : "falls due within 24 hours"} (due ${c.dueAt.toISOString()})`,
        detail: { clockId: c.clockId, flag, dueAt: c.dueAt.toISOString() },
      });
    });
    flagged += 1;
  }
  return { flagged };
}

/** The scheduler jobs this slice owns (spread by scheduler-jobs.ts). */
export function incidentJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: INCIDENT_CLOCK_SWEEP_JOB_NAME,
      description:
        "Flags AI incident notification clocks that fall due within 24 hours or are overdue, once each, on the " +
        "incident's timeline (ADR-0182 A12). Never changes a clock; the monitor raises the alert.",
      adr: "ADR-0182",
      defaultIntervalSeconds: 15 * 60,
      run: async (ctx) => {
        const r = await runIncidentClockSweep(ctx.db, ctx.now, ctx.actorUserId);
        return { itemsProcessed: r.flagged, detail: { flagged: r.flagged } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

const TIMELINE_HEADER = ["at", "kind", "actor_user_id", "note", "detail"] as const;
function timelineCsv(events: Array<{ at: string; kind: string; actorUserId: string | null; note: string | null; detail: unknown }>): string {
  return [csvRecord([...TIMELINE_HEADER]), ...events.map((e) => csvRecord([e.at, e.kind, e.actorUserId ?? "", e.note ?? "", e.detail]))].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const idParam = z.object({ incidentId: z.string() });
const actionParam = z.object({ incidentId: z.string(), actionId: z.string() });
const notificationParam = z.object({ incidentId: z.string(), notificationId: z.string() });
const listQuery = z
  .object({
    status: z.enum(["open", "contained", "resolved", "closed", "active"]).optional(),
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
    serious: z.enum(["true", "false"]).optional(),
    useCaseId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();
const exportQuery = z.object({ format: z.enum(["bundle", "csv"]).default("bundle") }).strict();

function send(reply: FastifyReply, e: unknown) {
  if (e instanceof IncidentError) return reply.status(e.status).send({ error: e.code, detail: e.message, ...e.extra });
  throw e;
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A12 block):
 *   GET   /v1/incidents                                         user: filtered to what the caller may see
 *   POST  /v1/incidents                                         user: anyone may report an incident
 *   GET   /v1/incidents/:incidentId                             user: owner, reporter, use-case owner, covered agent's steward or admin
 *   PATCH /v1/incidents/:incidentId                             user: owner or admin
 *   POST  /v1/incidents/:incidentId/events                      user: owner or admin
 *   POST  /v1/incidents/:incidentId/links                       user: owner or admin
 *   POST  /v1/incidents/:incidentId/actions                     user: owner or admin
 *   PATCH /v1/incidents/:incidentId/actions/:actionId           user: owner, the action's owner or admin
 *   POST  /v1/incidents/:incidentId/notifications/:notificationId/sent          user: owner or admin
 *   POST  /v1/incidents/:incidentId/notifications/:notificationId/not-required  admin, reason required
 *   POST  /v1/incidents/:incidentId/notifications/:notificationId/toll          admin, reason required
 *   POST  /v1/incidents/:incidentId/close                       user: owner (low/medium, not serious) or admin
 *   POST  /v1/incidents/:incidentId/contain                     admin (halts a linked agent)
 *   GET   /v1/incidents/:incidentId/export                      admin (signed bundle, or the timeline as CSV)
 */
export function registerIncidentRoutes(app: FastifyInstance, db: Db, _opts: { dataKey?: string | undefined } = {}): void {
  // ---- list ---------------------------------------------------------------
  app.get("/v1/incidents", async (req, reply) => {
    const q = listQuery.parse(req.query ?? {});
    const actor = actorOf(req);
    const conds = [];
    if (!actor.isAdmin) {
      if (!actor.userId) return { incidents: [], scope: "none", disclaimer: INCIDENT_CLOCK_DISCLAIMER };
      const me = actor.userId;
      const ownedUseCases = db.select({ id: aiUseCases.id }).from(aiUseCases).where(eq(aiUseCases.ownerUserId, me));
      // the same readers as `accessTo`: owner, reporter (D4A-07a), use-case
      // owner, and the steward of an agent the hold covers (D4A-02)
      const stewarded = incidentCoversAgentStewardedBy(me);
      conds.push(or(eq(aiIncidents.ownerUserId, me), eq(aiIncidents.createdBy, me), inArray(aiIncidents.useCaseId, ownedUseCases), stewarded));
    }
    if (q.status === "active") conds.push(ne(aiIncidents.status, "closed"));
    else if (q.status) conds.push(eq(aiIncidents.status, q.status));
    if (q.severity) conds.push(eq(aiIncidents.severity, q.severity));
    if (q.serious) conds.push(eq(aiIncidents.serious, q.serious === "true"));
    if (q.useCaseId) conds.push(eq(aiIncidents.useCaseId, q.useCaseId));
    const rows = await db
      .select({
        id: aiIncidents.id,
        ref: aiIncidents.ref,
        title: aiIncidents.title,
        severity: aiIncidents.severity,
        status: aiIncidents.status,
        serious: aiIncidents.serious,
        seriousCriteria: aiIncidents.seriousCriteria,
        detectionSource: aiIncidents.detectionSource,
        awareAt: aiIncidents.awareAt,
        ownerUserId: aiIncidents.ownerUserId,
        useCaseId: aiIncidents.useCaseId,
        useCaseName: aiUseCases.name,
        createdAt: aiIncidents.createdAt,
        closedAt: aiIncidents.closedAt,
      })
      .from(aiIncidents)
      .leftJoin(aiUseCases, eq(aiUseCases.id, aiIncidents.useCaseId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(aiIncidents.createdAt))
      .limit(q.limit);
    const ids = rows.map((r) => r.id);
    const [clocks, actions] = ids.length
      ? await Promise.all([
          db
            .select({ incidentId: aiIncidentNotifications.incidentId, clockId: aiIncidentNotifications.clockId, status: aiIncidentNotifications.status, dueAt: aiIncidentNotifications.dueAt })
            .from(aiIncidentNotifications)
            .where(inArray(aiIncidentNotifications.incidentId, ids)),
          db
            .select({ incidentId: aiIncidentActions.incidentId, status: aiIncidentActions.status, dueAt: aiIncidentActions.dueAt })
            .from(aiIncidentActions)
            .where(inArray(aiIncidentActions.incidentId, ids)),
        ])
      : [[], []];
    const names = await namesOf(db, rows.map((r) => r.ownerUserId));
    const now = new Date();
    return {
      incidents: rows.map((r) => {
        const mine = clocks.filter((c) => c.incidentId === r.id);
        const open = mine.filter((c) => c.status === "pending" || c.status === "sent_initial").sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
        const next = open[0] ?? null;
        const acts = actions.filter((a) => a.incidentId === r.id && a.status === "open");
        return {
          ...r,
          awareAt: r.awareAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
          closedAt: iso(r.closedAt),
          ownerName: r.ownerUserId ? (names.get(r.ownerUserId) ?? null) : null,
          clocks: {
            total: mine.length,
            open: open.length,
            overdue: open.filter((c) => c.dueAt.getTime() <= now.getTime()).length,
            nextDue: next
              ? { clockId: next.clockId, paragraph: incidentClockById(next.clockId)?.paragraph ?? next.clockId, dueAt: next.dueAt.toISOString(), urgency: incidentClockUrgency(next, now) }
              : null,
          },
          actions: { open: acts.length, overdue: acts.filter((a) => a.dueAt !== null && a.dueAt.getTime() < now.getTime()).length },
        };
      }),
      scope: actor.isAdmin ? "all" : "visible",
      disclaimer: INCIDENT_CLOCK_DISCLAIMER,
    };
  });

  // ---- create -------------------------------------------------------------
  app.post("/v1/incidents", async (req, reply) => {
    const body = createIncidentSchema.parse(req.body ?? {});
    try {
      const actor = actorOf(req);
      const incident = await createIncident(db, body, actor);
      const org = await loadOrgSettings(db);
      // D4A-06: the response carries only what the caller may read (never a
      // forced read), and the detail itself shows only what they can see
      const access = await accessTo(db, actor, incident);
      if (!access.canRead) return reply.status(201).send({ incident: { id: incident.id, ref: incident.ref } });
      return reply.status(201).send(await incidentDetail(db, incident, access, actor, org));
    } catch (e) {
      return send(reply, e);
    }
  });

  // ---- read ---------------------------------------------------------------
  app.get("/v1/incidents/:incidentId", async (req, reply) => {
    const { incidentId } = idParam.parse(req.params);
    const actor = actorOf(req);
    const incident = await loadIncident(db, incidentId);
    if (!incident) return reply.status(404).send({ error: "not_found", detail: "no such incident" });
    const access = await accessTo(db, actor, incident);
    if (!access.canRead) return reply.status(404).send({ error: "not_found", detail: "no such incident" });
    // the narrative is someone else's free text unless the reader reported it
    if (actor.userId === null || actor.userId !== incident.createdBy) {
      await audit(db, {
        userId: actor.userId,
        objectId: incident.id,
        ruleId: INCIDENT_RULE_IDS.read,
        reason: `incident ${incident.ref} read (its narrative, timeline and clocks)`,
        detail: { via: actor.via ?? null, asAdmin: actor.isAdmin },
      });
    }
    return incidentDetail(db, incident, access, actor, await loadOrgSettings(db));
  });

  // ---- update -------------------------------------------------------------
  app.patch("/v1/incidents/:incidentId", async (req, reply) => {
    const { incidentId } = idParam.parse(req.params);
    const body = updateIncidentSchema.parse(req.body ?? {});
    const actor = actorOf(req);
    try {
      const { incident } = await writable(db, actor, incidentId, "change this incident");
      validTimes({ occurredAt: body.occurredAt }, new Date());
      // changes that would RELEASE the deploy gate or the evidence hold are an admin's
      const relaxations: string[] = [];
      if (body.severity && severityRank(incident.severity) >= severityRank("high") && severityRank(body.severity) < severityRank("high")) {
        relaxations.push(`severity ${incident.severity} -> ${body.severity}`);
      }
      if (body.serious === false && incident.serious) relaxations.push("no longer serious");
      if (body.useCaseId !== undefined && incident.useCaseId !== null && body.useCaseId !== incident.useCaseId) {
        relaxations.push("moved off its use case");
      }
      if (relaxations.length > 0 && !actor.isAdmin) {
        await audit(db, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId: INCIDENT_RULE_IDS.refused,
          effect: "deny",
          reason: `incident ${incident.ref}: ${relaxations.join("; ")} refused — only an admin may release the deploy gate or the evidence hold`,
          detail: { relaxations },
        });
        throw new IncidentError(
          403,
          "incident_relaxation_admin_only",
          "lowering the severity below high, un-marking an incident serious, or moving it off its use case releases " +
            "the use case's deploy gate (and possibly the evidence hold), so only an admin may do it",
          { relaxations },
        );
      }
      const criteria = body.seriousCriteria ? [...new Set(body.seriousCriteria)] : incident.seriousCriteria;
      const phiIndividuals = body.phiIndividuals !== undefined ? body.phiIndividuals : incident.phiIndividuals;
      if (phiIndividuals !== null && phiIndividuals !== undefined && !criteria.includes("phi_breach")) {
        throw new IncidentError(422, "phi_individuals_without_phi_breach", "a PHI head count is recorded only with the phi_breach criterion");
      }
      const serious = (body.serious ?? incident.serious) || hasEuSeriousCriterion(criteria);
      if (body.serious === false && hasEuSeriousCriterion(criteria)) {
        throw new IncidentError(422, "serious_criteria_listed", "an incident listing an Art. 3(49) criterion is serious; remove the criteria first");
      }
      let uc: UseCaseFacts | null = await loadUseCase(db, incident.useCaseId);
      if (body.useCaseId !== undefined && body.useCaseId !== incident.useCaseId) {
        uc = await loadUseCase(db, body.useCaseId);
        // D4A-02: putting the incident on a use case is like opening it there —
        // only on one the caller can see (unknown and invisible are one 404)
        if (body.useCaseId !== null && !(await useCaseVisibleTo(db, actor, uc))) throw notVisible("use case", body.useCaseId);
      }
      if (body.ownerUserId && !(await userExists(db, body.ownerUserId))) {
        throw new IncidentError(422, "unknown_user", "the named owner is not a user of this deployment");
      }
      const next = {
        title: body.title ?? incident.title,
        summary: body.summary ?? incident.summary,
        severity: body.severity ?? incident.severity,
        status: body.status ?? incident.status,
        occurredAt: body.occurredAt !== undefined ? (body.occurredAt ? new Date(body.occurredAt) : null) : incident.occurredAt,
        ownerUserId: body.ownerUserId !== undefined ? body.ownerUserId : incident.ownerUserId,
        useCaseId: body.useCaseId !== undefined ? body.useCaseId : incident.useCaseId,
        serious,
        seriousCriteria: criteria,
        phiIndividuals: phiIndividuals ?? null,
        rootCause: body.rootCause ?? incident.rootCause,
        lessonsLearned: body.lessonsLearned ?? incident.lessonsLearned,
      };
      const tracked = {
        severity: [incident.severity, next.severity],
        status: [incident.status, next.status],
        serious: [incident.serious, next.serious],
        seriousCriteria: [incident.seriousCriteria, next.seriousCriteria],
        phiIndividuals: [incident.phiIndividuals, next.phiIndividuals],
        ownerUserId: [incident.ownerUserId, next.ownerUserId],
        useCaseId: [incident.useCaseId, next.useCaseId],
        occurredAt: [iso(incident.occurredAt), iso(next.occurredAt)],
      } as const;
      const transitions = settingTransitions(
        Object.fromEntries(Object.entries(tracked).map(([k, v]) => [k, v[0]])),
        Object.fromEntries(Object.entries(tracked).map(([k, v]) => [k, v[1]])),
      );
      const textChanged = (["title", "summary", "rootCause", "lessonsLearned"] as const).filter(
        (k) => body[k] !== undefined && body[k] !== (incident[k] ?? undefined),
      );
      if (Object.keys(transitions).length === 0 && textChanged.length === 0) {
        return incidentDetail(db, incident, await accessTo(db, actor, incident), actor, await loadOrgSettings(db));
      }
      const org = await loadOrgSettings(db);
      const updated = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        await lockEvidenceHoldsExclusive(tx); // X15-H01: serious, status or use case may begin or widen the hold
        const [row] = await tx.update(aiIncidents).set({ ...next, updatedAt: new Date() }).where(eq(aiIncidents.id, incident.id)).returning();
        if (next.status !== incident.status) {
          await addEvent(tx, incident.id, "status", actor.userId, { from: incident.status, to: next.status });
        }
        const others = Object.keys(transitions).filter((k) => k !== "status");
        if (others.length > 0 || textChanged.length > 0) {
          await addEvent(tx, incident.id, "note", actor.userId, { changed: [...others, ...textChanged], transitions: Object.fromEntries(Object.entries(transitions).filter(([k]) => k !== "status")) });
        }
        await audit(tx, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId: INCIDENT_RULE_IDS.updated,
          reason:
            `incident ${incident.ref} updated (${[...Object.keys(transitions), ...textChanged].join(", ")})` +
            (relaxations.length ? ` — RELAXED by an admin: ${relaxations.join("; ")}` : ""),
          detail: { via: actor.via ?? null, transitions, textChanged, relaxed: relaxations.length > 0, ...(relaxations.length ? { relaxations } : {}) },
        });
        await startApplicableClocks(tx, row!, uc, (org.incidentClockRegimes ?? []) as IncidentClockRegime[], actor.userId);
        return row!;
      });
      return incidentDetail(db, updated, await accessTo(db, actor, updated), actor, org);
    } catch (e) {
      return send(reply, e);
    }
  });

  // ---- timeline note ------------------------------------------------------
  app.post("/v1/incidents/:incidentId/events", async (req, reply) => {
    const { incidentId } = idParam.parse(req.params);
    const body = incidentNoteSchema.parse(req.body ?? {});
    const actor = actorOf(req);
    try {
      const { incident } = await writable(db, actor, incidentId, "add to this incident's timeline");
      await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        await addEvent(tx, incident.id, "note", actor.userId, {}, body.note);
        await audit(tx, { userId: actor.userId, objectId: incident.id, ruleId: INCIDENT_RULE_IDS.noteAdded, reason: `incident ${incident.ref}: note added to the timeline` });
      });
      return reply.status(201).send({ ok: true });
    } catch (e) {
      return send(reply, e);
    }
  });

  // ---- links --------------------------------------------------------------
  app.post("/v1/incidents/:incidentId/links", async (req, reply) => {
    const { incidentId } = idParam.parse(req.params);
    const body = incidentLinkSchema.parse(req.body ?? {});
    const actor = actorOf(req);
    try {
      const { incident } = await writable(db, actor, incidentId, "link this incident");
      // D4A-02: only what the caller can see (unknown and invisible are one 404)
      if (!(await linkTargetVisible(db, actor, body.objectType, body.objectId))) throw notVisible("link target", body.objectId);
      const added = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        await lockEvidenceHoldsExclusive(tx); // X15-H01: a link widens the hold to the linked agent
        const rows = await tx
          .insert(aiIncidentLinks)
          .values({ incidentId: incident.id, objectType: body.objectType, objectId: body.objectId, createdBy: actor.userId })
          .onConflictDoNothing()
          .returning({ incidentId: aiIncidentLinks.incidentId });
        if (rows.length === 0) return false;
        await addEvent(tx, incident.id, "link", actor.userId, { objectType: body.objectType, objectId: body.objectId, added: true });
        await audit(tx, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId: INCIDENT_RULE_IDS.linked,
          reason: `incident ${incident.ref} linked to ${body.objectType} ${body.objectId}`,
          detail: { objectType: body.objectType, objectId: body.objectId },
        });
        return true;
      });
      return reply.status(added ? 201 : 200).send({ linked: true, changed: added });
    } catch (e) {
      return send(reply, e);
    }
  });

  // ---- corrective actions -------------------------------------------------
  app.post("/v1/incidents/:incidentId/actions", async (req, reply) => {
    const { incidentId } = idParam.parse(req.params);
    const body = createIncidentActionSchema.parse(req.body ?? {});
    const actor = actorOf(req);
    try {
      const { incident } = await writable(db, actor, incidentId, "add a corrective action");
      if (body.ownerUserId && !(await userExists(db, body.ownerUserId))) {
        throw new IncidentError(422, "unknown_user", "the named owner is not a user of this deployment");
      }
      const action = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [row] = await tx
          .insert(aiIncidentActions)
          .values({
            incidentId: incident.id,
            title: body.title,
            ownerUserId: body.ownerUserId ?? null,
            dueAt: body.dueAt ? new Date(body.dueAt) : null,
            createdBy: actor.userId,
          })
          .returning();
        await addEvent(tx, incident.id, "action", actor.userId, { actionId: row!.id, created: true, dueAt: iso(row!.dueAt), ownerUserId: row!.ownerUserId });
        await audit(tx, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId: INCIDENT_RULE_IDS.actionCreated,
          reason: `incident ${incident.ref}: corrective action ${row!.id} added`,
          detail: { actionId: row!.id, ownerUserId: row!.ownerUserId, dueAt: iso(row!.dueAt) },
        });
        return row!;
      });
      return reply.status(201).send({ action: { ...action, dueAt: iso(action.dueAt), doneAt: iso(action.doneAt) } });
    } catch (e) {
      return send(reply, e);
    }
  });

  app.patch("/v1/incidents/:incidentId/actions/:actionId", async (req, reply) => {
    const { incidentId, actionId } = actionParam.parse(req.params);
    const body = updateIncidentActionSchema.parse(req.body ?? {});
    const actor = actorOf(req);
    try {
      const incident = await loadIncident(db, incidentId);
      if (!incident || !UUID_RE.test(actionId)) throw new IncidentError(404, "not_found", "no such incident action");
      const [action] = await db
        .select()
        .from(aiIncidentActions)
        .where(and(eq(aiIncidentActions.id, actionId), eq(aiIncidentActions.incidentId, incident.id)));
      if (!action) throw new IncidentError(404, "not_found", "no such incident action");
      const access = await accessTo(db, actor, incident);
      const isActionOwner = actor.userId !== null && actor.userId === action.ownerUserId;
      if (!access.canRead && !isActionOwner) throw new IncidentError(404, "not_found", "no such incident action");
      if (!access.canWrite && !isActionOwner) {
        await audit(db, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId: INCIDENT_RULE_IDS.refused,
          effect: "deny",
          reason: `incident ${incident.ref}: change to action ${action.id} refused — the incident's owner, the action's owner or an admin`,
        });
        throw new IncidentError(403, "forbidden", "only the incident's owner, the action's owner or an admin may change this action");
      }
      if (incident.status === "closed") throw new IncidentError(409, "incident_closed", `incident ${incident.ref} is closed`);
      if (body.ownerUserId && !(await userExists(db, body.ownerUserId))) {
        throw new IncidentError(422, "unknown_user", "the named owner is not a user of this deployment");
      }
      const status = body.status ?? action.status;
      const cancelling = status === "cancelled" && action.status !== "cancelled";
      if (cancelling && !body.reason) {
        throw new IncidentError(422, "reason_required", "cancelling a corrective action needs a reason of 10 to 2000 characters; it is audited and kept on the timeline");
      }
      const set = {
        title: body.title ?? action.title,
        ownerUserId: body.ownerUserId !== undefined ? body.ownerUserId : action.ownerUserId,
        dueAt: body.dueAt !== undefined ? (body.dueAt ? new Date(body.dueAt) : null) : action.dueAt,
        status,
        doneAt: status === "done" ? (action.doneAt ?? new Date()) : null,
        evidenceRef: body.evidenceRef ?? action.evidenceRef,
        updatedAt: new Date(),
      };
      const transitions = settingTransitions(
        { status: action.status, ownerUserId: action.ownerUserId, dueAt: iso(action.dueAt) },
        { status: set.status, ownerUserId: set.ownerUserId, dueAt: iso(set.dueAt) },
      );
      const updated = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [row] = await tx.update(aiIncidentActions).set(set).where(eq(aiIncidentActions.id, action.id)).returning();
        await addEvent(
          tx,
          incident.id,
          "action",
          actor.userId,
          { actionId: action.id, transitions, evidenceRefSet: body.evidenceRef !== undefined, ...(cancelling ? { cancelled: true } : {}) },
          cancelling ? body.reason : undefined,
        );
        await audit(tx, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId: INCIDENT_RULE_IDS.actionUpdated,
          reason:
            `incident ${incident.ref}: corrective action ${action.id} updated${set.status !== action.status ? ` (${action.status} -> ${set.status})` : ""}` +
            (cancelling ? `: ${body.reason}` : ""),
          detail: { actionId: action.id, transitions },
        });
        return row!;
      });
      return { action: { ...updated, dueAt: iso(updated.dueAt), doneAt: iso(updated.doneAt) } };
    } catch (e) {
      return send(reply, e);
    }
  });

  // ---- notification clocks ------------------------------------------------
  const moveClock = async (
    req: FastifyRequest,
    reply: FastifyReply,
    move: IncidentNotificationMove,
    extra: { recipient?: string; reference?: string; sentAt?: string; reason?: string },
  ) => {
    const { incidentId, notificationId } = notificationParam.parse(req.params);
    const actor = actorOf(req);
    const verb = move.kind === "sent" ? `record the ${move.stage} report` : move.kind === "toll" ? "toll a clock" : "mark a clock not required";
    try {
      const { incident } = await writable(db, actor, incidentId, verb);
      if (move.kind !== "sent" && !actor.isAdmin) {
        // the route class already refuses a non-admin; this is the second lock
        throw new IncidentError(403, "forbidden", "only an admin may set a notification clock aside");
      }
      if (!UUID_RE.test(notificationId)) throw new IncidentError(404, "not_found", "no such notification clock");
      const [clock] = await db
        .select()
        .from(aiIncidentNotifications)
        .where(and(eq(aiIncidentNotifications.id, notificationId), eq(aiIncidentNotifications.incidentId, incident.id)));
      if (!clock) throw new IncidentError(404, "not_found", "no such notification clock");
      const next = nextNotificationStatus(clock.status, move, clock.clockId);
      if (!next.ok) {
        await audit(db, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId: INCIDENT_RULE_IDS.notificationRefused,
          effect: "deny",
          reason: `incident ${incident.ref}: clock ${clock.clockId} ${verb} refused — ${next.detail}`,
          detail: { clockId: clock.clockId, status: clock.status, code: next.code },
        });
        throw new IncidentError(409, next.code, next.detail);
      }
      const now = new Date();
      // D4G-06: a report's `sentAt` lies within [the clock's start, now]; one
      // recorded more than an hour after it was sent is BACKDATED — it needs a
      // reason, and the audit row and the timeline keep both times
      let backdated = false;
      if (move.kind === "sent" && extra.sentAt) {
        const verdict = incidentSentAtVerdict(new Date(extra.sentAt), clock.clockStart, now, extra.reason);
        if (!verdict.ok) {
          await audit(db, {
            userId: actor.userId,
            objectId: incident.id,
            ruleId: INCIDENT_RULE_IDS.notificationRefused,
            effect: "deny",
            reason: `incident ${incident.ref}: clock ${clock.clockId} ${verb} refused — ${verdict.detail}`,
            detail: { clockId: clock.clockId, code: verdict.code, sentAt: extra.sentAt, clockStart: clock.clockStart.toISOString(), recordedAt: now.toISOString() },
          });
          throw new IncidentError(422, verdict.code, verdict.detail, { clockStart: clock.clockStart.toISOString() });
        }
        backdated = verdict.backdated;
      }
      const ruleId =
        move.kind === "sent" ? INCIDENT_RULE_IDS.notificationSent : move.kind === "toll" ? INCIDENT_RULE_IDS.notificationTolled : INCIDENT_RULE_IDS.notificationNotRequired;
      const paragraph = incidentClockById(clock.clockId)?.paragraph ?? clock.clockId;
      const updated = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        await lockEvidenceHoldsExclusive(tx); // X15-H01: a clock's status decides whether the hold binds
        const [row] = await tx
          .update(aiIncidentNotifications)
          .set({
            status: next.status,
            ...(move.kind === "sent"
              ? {
                  sentAt: extra.sentAt ? new Date(extra.sentAt) : now,
                  sentBy: actor.userId,
                  recipient: extra.recipient ?? clock.recipient,
                  reference: extra.reference ?? clock.reference,
                }
              : { reason: extra.reason }),
            updatedAt: now,
          })
          .where(eq(aiIncidentNotifications.id, clock.id))
          .returning();
        await addEvent(
          tx,
          incident.id,
          "notification",
          actor.userId,
          {
            clockId: clock.clockId,
            from: clock.status,
            to: next.status,
            ...(move.kind === "sent"
              ? { stage: move.stage, sentAt: row!.sentAt?.toISOString() ?? null, recordedAt: now.toISOString(), ...(backdated ? { backdated: true } : {}) }
              : {}),
          },
          move.kind === "sent" ? (backdated ? `Recorded late (backdated): ${extra.reason}` : undefined) : extra.reason,
        );
        await audit(tx, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId,
          reason:
            `incident ${incident.ref}: ${paragraph} clock ${clock.status} -> ${next.status}` +
            (move.kind === "sent"
              ? ` (${move.stage} report to ${extra.recipient})` +
                (backdated ? ` — BACKDATED: sent ${row!.sentAt?.toISOString()}, recorded ${now.toISOString()}: ${extra.reason}` : "")
              : ` by an admin: ${extra.reason}`),
          detail: {
            clockId: clock.clockId,
            notificationId: clock.id,
            transitions: { status: { from: clock.status, to: next.status } },
            ...(move.kind === "sent"
              ? {
                  stage: move.stage,
                  sentAt: row!.sentAt?.toISOString() ?? null,
                  recordedAt: now.toISOString(),
                  backdated,
                  ...(backdated ? { backdateReason: extra.reason } : {}),
                }
              : { relaxed: true }),
          },
        });
        return row!;
      });
      return { notification: clockView(updated, now) };
    } catch (e) {
      return send(reply, e);
    }
  };

  app.post("/v1/incidents/:incidentId/notifications/:notificationId/sent", async (req, reply) => {
    const body = incidentNotificationSentSchema.parse(req.body ?? {});
    return moveClock(req, reply, { kind: "sent", stage: body.stage }, {
      recipient: body.recipient,
      ...(body.reference ? { reference: body.reference } : {}),
      ...(body.sentAt ? { sentAt: body.sentAt } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
    });
  });

  const reasonOr422 = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const parsed = incidentNotificationReasonSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      void reply.status(422).send({
        error: "reason_required",
        detail: "setting a notification clock aside needs a reason of 10 to 2000 characters; it is recorded with the clock and audited",
        issues: parsed.error.issues,
      });
      return null;
    }
    return parsed.data.reason;
  };
  app.post("/v1/incidents/:incidentId/notifications/:notificationId/not-required", async (req, reply) => {
    const reason = reasonOr422(req, reply);
    if (reason === null) return reply;
    return moveClock(req, reply, { kind: "not_required" }, { reason });
  });
  app.post("/v1/incidents/:incidentId/notifications/:notificationId/toll", async (req, reply) => {
    const reason = reasonOr422(req, reply);
    if (reason === null) return reply;
    return moveClock(req, reply, { kind: "toll" }, { reason });
  });

  // ---- close --------------------------------------------------------------
  app.post("/v1/incidents/:incidentId/close", async (req, reply) => {
    const { incidentId } = idParam.parse(req.params);
    const actor = actorOf(req);
    try {
      const { incident } = await writable(db, actor, incidentId, "close this incident");
      // D4A-01 / D4G-01: closing releases the deploy gate, so closing a serious,
      // high or critical incident is an admin's; the owner closes the rest
      if (incidentCloseNeedsAdmin(incident) && !actor.isAdmin) {
        await audit(db, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId: INCIDENT_RULE_IDS.closeRefused,
          effect: "deny",
          reason: `incident ${incident.ref}: close refused — closing a ${incident.serious ? "serious" : incident.severity} incident releases the deploy gate, so it is an admin's`,
          detail: { severity: incident.severity, serious: incident.serious, adminOnly: true },
        });
        throw new IncidentError(
          403,
          "incident_close_admin_only",
          "closing a serious, high or critical incident releases the use case's deploy gate, so only an admin may close it; " +
            "the owner may mark it resolved, which releases nothing",
        );
      }
      const parsed = closeIncidentSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        await audit(db, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId: INCIDENT_RULE_IDS.closeRefused,
          effect: "deny",
          reason: `incident ${incident.ref}: close refused — a root cause and lessons learned are required`,
          detail: { missing: parsed.error.issues.map((i) => i.path.join(".")) },
        });
        return reply.status(422).send({
          error: "close_requires_root_cause_and_lessons",
          detail: "closing an incident records its root cause and the lessons learned; both are required",
          issues: parsed.error.issues,
        });
      }
      const clocks = await db
        .select({ id: aiIncidentNotifications.id, clockId: aiIncidentNotifications.clockId, status: aiIncidentNotifications.status })
        .from(aiIncidentNotifications)
        .where(eq(aiIncidentNotifications.incidentId, incident.id));
      const actionRows = await db
        .select({ id: aiIncidentActions.id, status: aiIncidentActions.status })
        .from(aiIncidentActions)
        .where(eq(aiIncidentActions.incidentId, incident.id));
      const blockers = incidentCloseBlockers({ status: incident.status, ...parsed.data, notifications: clocks, actions: actionRows });
      if (blockers.openClocks.length > 0) {
        await audit(db, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId: INCIDENT_RULE_IDS.closeRefused,
          effect: "deny",
          reason: `incident ${incident.ref}: close refused — notification clock(s) not final: ${blockers.openClocks.join(", ")}`,
          detail: { openClocks: blockers.openClocks },
        });
        return reply.status(409).send({
          error: "incident_clocks_open",
          detail:
            "every notification clock must be final before the incident closes: record the complete report, or an " +
            "admin marks it not required or tolled with a reason",
          openClocks: blockers.openClocks,
        });
      }
      if (blockers.openActions.length > 0) {
        await audit(db, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId: INCIDENT_RULE_IDS.closeRefused,
          effect: "deny",
          reason: `incident ${incident.ref}: close refused — corrective action(s) still open: ${blockers.openActions.join(", ")}`,
          detail: { openActions: blockers.openActions },
        });
        return reply.status(409).send({
          error: "incident_actions_open",
          detail: "every corrective action must be done (with its evidence) or cancelled (with a reason) before the incident closes",
          openActions: blockers.openActions,
        });
      }
      const now = new Date();
      const closed = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [row] = await tx
          .update(aiIncidents)
          .set({ status: "closed", closedAt: now, closedBy: actor.userId, rootCause: parsed.data.rootCause, lessonsLearned: parsed.data.lessonsLearned, updatedAt: now })
          .where(eq(aiIncidents.id, incident.id))
          .returning();
        await addEvent(tx, incident.id, "status", actor.userId, { from: incident.status, to: "closed" });
        await audit(tx, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId: INCIDENT_RULE_IDS.closed,
          reason: `incident ${incident.ref} closed with its root cause and lessons learned recorded`,
          detail: { transitions: { status: { from: incident.status, to: "closed" } }, clocks: clocks.map((c) => ({ clockId: c.clockId, status: c.status })) },
        });
        return row!;
      });
      return incidentDetail(db, closed, await accessTo(db, actor, closed), actor, await loadOrgSettings(db));
    } catch (e) {
      return send(reply, e);
    }
  });

  // ---- containment (admin) ------------------------------------------------
  app.post("/v1/incidents/:incidentId/contain", async (req, reply) => {
    const { incidentId } = idParam.parse(req.params);
    const body = containIncidentSchema.parse(req.body ?? {});
    const actor = actorOf(req);
    try {
      const { incident } = await writable(db, actor, incidentId, "contain this incident");
      const result = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        await lockEvidenceHoldsExclusive(tx); // X15-H01: containment links the agent (widens the hold); before the halt's row lock
        const halt = await haltAgentInTx(tx, body.agentId, `incident ${incident.ref} containment: ${body.reason}`, {
          userId: actor.userId,
          via: actor.via,
          detail: { incidentId: incident.id, incidentRef: incident.ref },
        });
        if (!halt) return null;
        const linkRows = await tx
          .insert(aiIncidentLinks)
          .values({ incidentId: incident.id, objectType: "agent", objectId: body.agentId, createdBy: actor.userId })
          .onConflictDoNothing()
          .returning({ incidentId: aiIncidentLinks.incidentId });
        if (linkRows.length > 0) {
          await addEvent(tx, incident.id, "link", actor.userId, { objectType: "agent", objectId: body.agentId, added: true, byContainment: true });
        }
        await addEvent(tx, incident.id, "containment", actor.userId, { agentId: body.agentId, halted: true, changed: halt.changed }, body.reason);
        if (incident.status === "open") {
          await tx.update(aiIncidents).set({ status: "contained", updatedAt: new Date() }).where(eq(aiIncidents.id, incident.id));
          await addEvent(tx, incident.id, "status", actor.userId, { from: "open", to: "contained" });
        }
        await audit(tx, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId: INCIDENT_RULE_IDS.contained,
          reason: `incident ${incident.ref}: contained by halting agent ${body.agentId}${halt.changed ? "" : " (it was already halted)"}: ${body.reason}`,
          detail: { agentId: body.agentId, haltChanged: halt.changed, statusFrom: incident.status, statusTo: incident.status === "open" ? "contained" : incident.status },
        });
        return halt;
      });
      if (!result) return reply.status(404).send({ error: "unknown_agent", detail: "no registry agent with that id (a builder agent is paused from its own page)" });
      return { halt: result, note: "Lift the halt from the execution-control page once the incident allows it." };
    } catch (e) {
      return send(reply, e);
    }
  });

  // ---- export (admin) -----------------------------------------------------
  app.get("/v1/incidents/:incidentId/export", async (req, reply) => {
    const { incidentId } = idParam.parse(req.params);
    const q = exportQuery.parse(req.query ?? {});
    const actor = actorOf(req);
    const incident = await loadIncident(db, incidentId);
    if (!incident) return reply.status(404).send({ error: "not_found", detail: "no such incident" });
    const access = await accessTo(db, actor, incident);
    if (!actor.isAdmin) return reply.status(403).send({ error: "forbidden", detail: "the incident export is an admin's" });
    if (q.format === "bundle") {
      const key = resolveExportSigningKey();
      if (!key.ok) {
        await audit(db, {
          userId: actor.userId,
          objectId: incident.id,
          ruleId: INCIDENT_RULE_IDS.exportRefused,
          effect: "deny",
          reason: `incident ${incident.ref}: signed export REFUSED — the export signing key is not usable; no bundle was produced and no unsigned one is emitted`,
          detail: { ruleId: key.ruleId, format: q.format },
        });
        return reply.status(409).send({ error: key.ruleId, detail: key.reason });
      }
    }
    await audit(db, {
      userId: actor.userId,
      objectId: incident.id,
      ruleId: INCIDENT_RULE_IDS.exported,
      reason: `incident ${incident.ref} exported as ${q.format === "bundle" ? "a signed bundle" : "a timeline CSV"} — the record leaves the platform here`,
      detail: { format: q.format, via: actor.via ?? null },
    });
    const detail = await incidentDetail(db, incident, access, actor, await loadOrgSettings(db));
    const csv = timelineCsv(detail.events);
    if (q.format === "csv") {
      for (const [k, v] of Object.entries(securityHeaders("text/csv"))) reply.header(k, v);
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="incident-${incident.ref}-timeline.csv"`);
      return reply.send(csv);
    }
    const license = await resolveLicense(db);
    const bundle = await buildExportBundle({
      db,
      subject: {
        kind: "ai-incident",
        id: incident.id,
        descriptor: {
          ref: incident.ref,
          status: incident.status,
          severity: incident.severity,
          serious: incident.serious,
          seriousCriteria: incident.seriousCriteria,
          awareAt: incident.awareAt.toISOString(),
          useCaseId: incident.useCaseId,
          clocks: detail.notifications.map((n) => ({ clockId: n.clockId, status: n.status, dueAt: n.dueAt })),
          disclaimer: INCIDENT_CLOCK_DISCLAIMER,
        },
      },
      content: [
        {
          name: `incident-${incident.ref}.json`,
          contentType: "application/json",
          body: Buffer.from(`${JSON.stringify({ ...detail, permissions: undefined }, null, 2)}\n`, "utf8"),
        },
        { name: `incident-${incident.ref}-timeline.csv`, contentType: "text/csv", body: Buffer.from(csv, "utf8") },
      ],
      actor: { userId: actor.userId, via: actor.via ?? "unknown" },
      licenseId: license.document?.licenseId ?? null,
      auditPayloadScope: "subject",
    });
    if (!bundle.ok) {
      await audit(db, {
        userId: actor.userId,
        objectId: incident.id,
        ruleId: INCIDENT_RULE_IDS.exportRefused,
        effect: "deny",
        reason: `incident ${incident.ref}: the signed export recorded just before this row was NOT produced — building the bundle was refused`,
        detail: { ruleId: bundle.ruleId },
      });
      return reply.status(409).send({ error: bundle.ruleId, detail: bundle.reason });
    }
    for (const [k, v] of Object.entries(securityHeaders("application/gzip"))) reply.header(k, v);
    reply.header("content-type", "application/gzip");
    reply.header("content-disposition", `attachment; filename="${bundle.filename}"`);
    reply.header("x-regulait-export-signing-key-id", bundle.keyId);
    reply.header("x-regulait-export-signing-key-fingerprint", bundle.fingerprint);
    return reply.send(bundle.archive);
  });
}
