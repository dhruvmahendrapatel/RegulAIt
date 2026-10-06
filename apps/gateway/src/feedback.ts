/**
 * ADR-0182 (ADR-0175 batch D4) A13 — END-USER FEEDBACK AND APPEAL. OWNER: A13 (D4).
 *
 * NIST AI RMF GOVERN 5.1/5.2, MEASURE 3.3, MAP 5.2, MANAGE 4.1. A person who
 * uses, or is affected by, an AI use case can report a problem or appeal a
 * decision; the use case's owner answers within the org's response times; the
 * answers feed two measurable conditions (`user_report_rate`,
 * `appeal_overturn_rate`, measured in condition-metrics.ts).
 *
 * THE RULES (each pinned by zz-adr0182-a13-feedback.test.ts, red-proven):
 *   - any signed-in user may submit; a cited trace (and span) must belong to
 *     the use case — its project, or a span by one of its intended agents —
 *     else 422 `trace_not_in_use_case`, the same answer for "no such trace";
 *   - what a person wrote, and how to reach them, are REGULAIT_DATA_KEY
 *     envelopes (`encryptSecret`); with no data key the gateway refuses to
 *     store them (503) rather than store plaintext;
 *   - a body is read only by the item's owner or an admin, and every read
 *     (and every refused read) is audited. The queue lists metadata only;
 *   - an item is routed to the use case's owner with `ack_due_at` and
 *     `resolve_due_at` from `feedback_ack_sla_hours` / `_resolve_sla_days`.
 *     An appeal against the owner's own decision (the cited trace is theirs),
 *     or filed by the owner, is routed to the admins instead;
 *   - SEPARATION OF DUTIES: an appeal is never resolved by the person whose
 *     decision it contests, nor by the person who filed it (403, audited);
 *   - `feedback-sla-sweep` raises `feedback_sla_breached` for each breached
 *     phase (owner set to the item's owner; an unrouted item stays unowned so
 *     the alert-SLA escalation reaches the admins) and posts it to the ChatOps
 *     alert channels; the monitor loader reports the same subjects, so an
 *     episode resolves once the item is acknowledged or resolved;
 *   - `feedback-retention-sweep` deletes the body and contact of every item
 *     older than `feedback_retention_days`, sets `body_purged_at` and keeps the
 *     resolution record;
 *   - PUBLIC SIGNED LINKS (built, shipped OFF — owner decision 7): minted by
 *     the owner or an admin only while `feedback_signed_links_enabled`; an
 *     opaque `rglf_` token of 256 random bits, shown once, stored as its
 *     SHA-256 (`token-hash.ts`); at most 30 days (DB CHECK) and `max_uses`;
 *     revocable. The two public routes answer 404 while the setting is off,
 *     are rate-limited per address and then per link (`@fastify/rate-limit`
 *     through the gateway's shared store), accept at most 4000 characters and
 *     render nothing: JSON in, JSON out.
 *
 * OPEN SOURCE FIRST (ADR-0176). Considered: `jose` JWS links (MIT, in the
 * tree) — refused, because a stored opaque hash is revocable per link and a
 * signed token leaks its claims and cannot be revoked without a deny-list;
 * the rate limiter is `@fastify/rate-limit` (MIT, in the tree) through the
 * gateway's ADR-0125 shared store; encryption is node `crypto` AES-256-GCM via
 * the existing `secrets.ts` envelope. The SLA arithmetic is native `Date` in
 * UTC (whole hours and days; no date library needed). Nothing else fits a
 * governance-specific rule set, so the routing, SoD and sweeps are ours.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {} from "@fastify/rate-limit";
import { z } from "zod";
import {
  aiUseCases,
  and,
  asc,
  auditLog,
  desc,
  eq,
  governanceAlerts,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  traceSpans,
  traces,
  useCaseFeedback,
  useCaseFeedbackLinks,
  users,
  type Db,
  type UseCaseFeedbackRow,
} from "@regulait/db";
import {
  FEEDBACK_BODY_MAX_CHARS,
  FEEDBACK_KINDS,
  FEEDBACK_LINK_TOKEN_PREFIX,
  FEEDBACK_PUBLIC_RATE_LIMITS,
  FEEDBACK_STATUSES,
  MONITOR_RULES,
  appealSodConflict,
  createFeedbackLinkSchema,
  feedbackDueDates,
  feedbackRouteTo,
  feedbackSlaState,
  feedbackSubjectKey,
  feedbackTransitionProblem,
  isResolvedFeedbackStatus,
  openIncidentFromFeedbackSchema,
  publicFeedbackSchema,
  submitFeedbackSchema,
  updateFeedbackSchema,
  type AccountabilityMonitorRuleId,
  type FeedbackKind,
  type FeedbackStatus,
  type MonitorAssuranceInput,
  type MonitorAssuranceSubject,
} from "@regulait/shared";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { hashToken } from "./token-hash.js";
import { loadOrgSettings } from "./org-settings.js";
import { settingTransitions } from "./setting-transitions.js";
import { notifyGovernanceAlerts } from "./chatops.js";

export const FEEDBACK_SLA_SWEEP_JOB_NAME = "feedback-sla-sweep";
export const FEEDBACK_RETENTION_SWEEP_JOB_NAME = "feedback-retention-sweep";

export const FEEDBACK_RULE_IDS = {
  submitted: "feedback-submitted",
  submitRefused: "feedback-submit-refused",
  bodyRead: "feedback-body-read",
  readDenied: "feedback-read-denied",
  updated: "feedback-updated",
  updateRefused: "feedback-update-refused",
  sodRefused: "feedback-appeal-sod-refused",
  incidentOpened: "feedback-incident-opened",
  linkCreated: "feedback-link-created",
  linkRefused: "feedback-link-refused",
  linkRevoked: "feedback-link-revoked",
  slaBreached: "feedback-sla-breached",
  purged: "feedback-body-purged",
} as const;
/** the monitor's own "raised" rule id (governance-monitor.ts MONITOR_AUDIT_RULE_IDS.raised;
 * not imported, because governance-monitor.ts imports this module) */
export const ALERT_RAISED_RULE_ID = "governance-alert-raised";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** how many items one sweep pass handles (the next pass takes the rest) */
const SWEEP_BATCH = 500;
const LINK_TOKEN_RE = new RegExp(`^${FEEDBACK_LINK_TOKEN_PREFIX}[0-9a-f]{64}$`);

type Writer = Pick<Db, "insert" | "update" | "select" | "execute">;

async function audit(
  db: Writer,
  row: {
    userId: string | null;
    objectType: "use_case_feedback" | "feedback_link" | "governance_alert";
    objectId: string | null;
    ruleId: string;
    reason: string;
    effect?: "allow" | "deny";
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: row.userId ?? NO_IDENTITY,
    objectType: row.objectType,
    objectId: row.objectId,
    detail: row.detail ?? {},
    effect: row.effect ?? "allow",
    ruleId: row.ruleId,
    ruleChain: [],
    reason: row.reason,
  });
}

/** a new signed-link token: 256 random bits, and the only thing stored, its SHA-256 */
export function generateFeedbackLinkToken(): { token: string; tokenHash: string } {
  const token = FEEDBACK_LINK_TOKEN_PREFIX + randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

const kindWord = (k: FeedbackKind) => (k === "appeal" ? "appeal" : "problem report");

// ---------------------------------------------------------------------------
// Reads shared by the routes, the sweeps and the monitor
// ---------------------------------------------------------------------------

type UseCaseRef = { id: string; name: string; ownerUserId: string | null; projectId: string | null; intendedAgentIds: string[] };

async function loadUseCase(db: Db, id: string): Promise<UseCaseRef | null> {
  const [uc] = await db
    .select({
      id: aiUseCases.id,
      name: aiUseCases.name,
      ownerUserId: aiUseCases.ownerUserId,
      projectId: aiUseCases.projectId,
      intendedAgentIds: aiUseCases.intendedAgentIds,
    })
    .from(aiUseCases)
    .where(eq(aiUseCases.id, id));
  return uc ? { ...uc, intendedAgentIds: uc.intendedAgentIds ?? [] } : null;
}

/**
 * Does the cited trace (and span) belong to this use case? Its project, or a
 * span run by one of the use case's intended agents. Returns the trace's
 * person (whose decision an appeal contests), or null when it does not belong
 * — including when there is no such trace, so the 422 is no existence oracle.
 */
export async function traceBelongsToUseCase(
  db: Db,
  uc: Pick<UseCaseRef, "projectId" | "intendedAgentIds">,
  traceId: string,
  spanId: string | undefined,
): Promise<{ contestedUserId: string } | null> {
  const [t] = await db
    .select({ id: traces.id, projectId: traces.projectId, userId: traces.userId })
    .from(traces)
    .where(eq(traces.id, traceId));
  if (!t) return null;
  if (spanId) {
    const [s] = await db
      .select({ id: traceSpans.id })
      .from(traceSpans)
      .where(and(eq(traceSpans.id, spanId), eq(traceSpans.traceId, traceId)));
    if (!s) return null;
  }
  let belongs = uc.projectId !== null && t.projectId === uc.projectId;
  if (!belongs && uc.intendedAgentIds.length > 0) {
    const [s] = await db
      .select({ id: traceSpans.id })
      .from(traceSpans)
      .where(and(eq(traceSpans.traceId, traceId), inArray(traceSpans.agentId, uc.intendedAgentIds)))
      .limit(1);
    belongs = !!s;
  }
  return belongs ? { contestedUserId: t.userId } : null;
}

/** the person whose decision an appeal contests: the cited trace's person, or null */
async function contestedUserOf(db: Db, item: Pick<UseCaseFeedbackRow, "kind" | "traceId">): Promise<string | null> {
  if (item.kind !== "appeal" || !item.traceId) return null;
  const [t] = await db.select({ userId: traces.userId }).from(traces).where(eq(traces.id, item.traceId));
  return t?.userId ?? null;
}

function slaView(row: Pick<UseCaseFeedbackRow, "ackDueAt" | "resolveDueAt" | "acknowledgedAt" | "resolvedAt">, now: Date) {
  const s = feedbackSlaState(row, now);
  return { phase: s.phase, chip: s.chip, dueAt: s.dueAt?.toISOString() ?? null, breached: s.breached };
}

/** the metadata of an item — never its body, contact or resolution note */
function listView(row: UseCaseFeedbackRow & { useCaseName: string | null }, now: Date) {
  return {
    id: row.id,
    useCaseId: row.useCaseId,
    useCaseName: row.useCaseName,
    kind: row.kind,
    channel: row.channel,
    status: row.status,
    ownerUserId: row.ownerUserId,
    traceId: row.traceId,
    spanId: row.spanId,
    incidentId: row.incidentId,
    ackDueAt: row.ackDueAt.toISOString(),
    resolveDueAt: row.resolveDueAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    bodyPurged: row.bodyPurgedAt !== null,
    sla: slaView(row, now),
  };
}

// ---------------------------------------------------------------------------
// SLA: the monitor loader and the sweep
// ---------------------------------------------------------------------------

interface BreachedItem {
  subject: MonitorAssuranceSubject;
  feedbackId: string;
  ownerUserId: string | null;
  phase: "acknowledge" | "resolve";
}

async function breachedItems(db: Db, now: Date): Promise<BreachedItem[]> {
  const rows = await db
    .select({ f: useCaseFeedback, useCaseName: aiUseCases.name })
    .from(useCaseFeedback)
    .innerJoin(aiUseCases, eq(aiUseCases.id, useCaseFeedback.useCaseId))
    .where(
      and(
        isNull(useCaseFeedback.resolvedAt),
        or(
          and(isNull(useCaseFeedback.acknowledgedAt), lte(useCaseFeedback.ackDueAt, now)),
          lte(useCaseFeedback.resolveDueAt, now),
        ),
      ),
    )
    .orderBy(asc(useCaseFeedback.ackDueAt));
  const out: BreachedItem[] = [];
  for (const { f, useCaseName } of rows) {
    for (const phase of feedbackSlaState(f, now).breached) {
      const due = phase === "acknowledge" ? f.ackDueAt : f.resolveDueAt;
      out.push({
        feedbackId: f.id,
        ownerUserId: f.ownerUserId,
        phase,
        subject: {
          subjectKey: feedbackSubjectKey(f.useCaseId, f.id, phase),
          // names and ids only: reaches ChatOps channels (no personal data, no body)
          title:
            `${useCaseName}: a ${kindWord(f.kind)} (feedback ${f.id.slice(0, 8)}) was not ` +
            `${phase === "acknowledge" ? "acknowledged" : "resolved"} by ${due.toISOString().slice(0, 16).replace("T", " ")} UTC`,
          detail: {
            useCaseId: f.useCaseId,
            feedbackId: f.id,
            kind: f.kind,
            phase,
            dueAt: due.toISOString(),
            ownerUserId: f.ownerUserId,
            routedTo: f.ownerUserId ? "owner" : "admins",
          },
        },
      });
    }
  }
  return out;
}

/** The monitor's loader for `feedback_sla_breached` (governance-monitor.ts). */
export async function feedbackMonitorInput(
  db: Db,
  now: Date,
): Promise<Partial<Record<AccountabilityMonitorRuleId, MonitorAssuranceInput>>> {
  const items = await breachedItems(db, now);
  return { feedback_sla_breached: { breaches: items.map((i) => i.subject) } };
}

/**
 * `feedback-sla-sweep`: raise one `feedback_sla_breached` episode per breached
 * phase that has none open, owned by the item's owner (unowned when it was
 * routed to the admins, so the alert-SLA escalation reaches them), audit it on
 * the alert and on the item, and post the new episodes to ChatOps.
 */
export async function runFeedbackSlaSweep(
  db: Db,
  now: Date,
  actorUserId: string | null = null,
): Promise<{ breached: number; raised: number; notified: { posted: number; failed: number } }> {
  const items = await breachedItems(db, now);
  if (items.length === 0) return { breached: 0, raised: 0, notified: { posted: 0, failed: 0 } };
  const settings = await loadOrgSettings(db);
  const severity = MONITOR_RULES.feedback_sla_breached.severity;
  const alertDueHours = settings.alertSlaHours?.[severity] ?? 72;
  const raised: string[] = [];
  for (const item of items.slice(0, SWEEP_BATCH)) {
    const id = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [alert] = await tx
        .insert(governanceAlerts)
        .values({
          ruleId: "feedback_sla_breached",
          subjectKey: item.subject.subjectKey,
          severity,
          title: item.subject.title,
          detail: { ...item.subject.detail, escalatedTo: item.ownerUserId ? ["owner", "admins"] : ["admins"] },
          firstDetectedAt: now,
          lastDetectedAt: now,
          ownerUserId: item.ownerUserId,
          ownerSource: item.ownerUserId ? "derived" : null,
          dueAt: new Date(now.getTime() + alertDueHours * HOUR_MS),
        })
        .onConflictDoNothing()
        .returning({ id: governanceAlerts.id });
      if (!alert) return null;
      await audit(tx, {
        userId: actorUserId,
        objectType: "governance_alert",
        objectId: alert.id,
        ruleId: ALERT_RAISED_RULE_ID,
        reason: `governance alert raised (${severity}): ${item.subject.title}`,
        detail: { ruleId: "feedback_sla_breached", subjectKey: item.subject.subjectKey, severity, via: FEEDBACK_SLA_SWEEP_JOB_NAME },
      });
      await audit(tx, {
        userId: actorUserId,
        objectType: "use_case_feedback",
        objectId: item.feedbackId,
        ruleId: FEEDBACK_RULE_IDS.slaBreached,
        reason:
          `feedback ${item.feedbackId}: not ${item.phase === "acknowledge" ? "acknowledged" : "resolved"} in time; ` +
          `alert ${alert.id} raised for ${item.ownerUserId ? "its owner and the admins" : "the admins"}`,
        detail: { phase: item.phase, alertId: alert.id, ownerUserId: item.ownerUserId, dueAt: item.subject.detail.dueAt },
      });
      return alert.id;
    });
    if (id) raised.push(id);
  }
  const notified = raised.length > 0 ? await notifyGovernanceAlerts(db, raised, actorUserId) : { posted: 0, failed: 0 };
  return { breached: items.length, raised: raised.length, notified };
}

/**
 * `feedback-retention-sweep`: past `feedback_retention_days`, delete what the
 * person wrote and how to reach them, stamp `body_purged_at`, keep everything
 * else (kind, status, dates, owner, resolution). One audit row per item.
 */
export async function runFeedbackRetentionSweep(
  db: Db,
  now: Date,
  actorUserId: string | null = null,
): Promise<{ purged: number; retentionDays: number }> {
  const settings = await loadOrgSettings(db);
  const retentionDays = settings.feedbackRetentionDays;
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const due = await db
    .select({ id: useCaseFeedback.id })
    .from(useCaseFeedback)
    .where(and(isNull(useCaseFeedback.bodyPurgedAt), lt(useCaseFeedback.createdAt, cutoff)))
    .orderBy(asc(useCaseFeedback.createdAt))
    .limit(SWEEP_BATCH);
  if (due.length === 0) return { purged: 0, retentionDays };
  const purged = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const rows = await tx
      .update(useCaseFeedback)
      .set({ bodyCiphertext: null, contactCiphertext: null, bodyPurgedAt: now })
      .where(
        and(
          inArray(
            useCaseFeedback.id,
            due.map((d) => d.id),
          ),
          isNull(useCaseFeedback.bodyPurgedAt),
        ),
      )
      .returning({ id: useCaseFeedback.id, useCaseId: useCaseFeedback.useCaseId, createdAt: useCaseFeedback.createdAt });
    for (const r of rows) {
      await audit(tx, {
        userId: actorUserId,
        objectType: "use_case_feedback",
        objectId: r.id,
        ruleId: FEEDBACK_RULE_IDS.purged,
        reason: `feedback ${r.id}: body and contact deleted after ${retentionDays} days; the resolution record is kept`,
        detail: { useCaseId: r.useCaseId, retentionDays, receivedAt: r.createdAt.toISOString() },
      });
    }
    return rows.length;
  });
  return { purged, retentionDays };
}

/** The scheduler jobs this slice owns (spread by scheduler-jobs.ts). */
export function feedbackJobDefinitions(_opts: { dataKey?: string | undefined } = {}): SchedulerJobDefinition[] {
  return [
    {
      name: FEEDBACK_SLA_SWEEP_JOB_NAME,
      description:
        "Raises 'feedback past its response time' for each problem report or appeal not acknowledged, or not " +
        "resolved, within the org's response times, for its owner and the admins, and posts it to the alert channels.",
      adr: "ADR-0182",
      defaultIntervalSeconds: 15 * 60,
      run: async (ctx) => {
        const out = await runFeedbackSlaSweep(ctx.db, ctx.now, ctx.actorUserId);
        return { itemsProcessed: out.raised, detail: out };
      },
    },
    {
      name: FEEDBACK_RETENTION_SWEEP_JOB_NAME,
      description:
        "Deletes the text and contact details of feedback older than the org's retention, keeping the resolution record.",
      adr: "ADR-0182",
      defaultIntervalSeconds: 24 * 3600,
      run: async (ctx) => {
        const out = await runFeedbackRetentionSweep(ctx.db, ctx.now, ctx.actorUserId);
        return { itemsProcessed: out.purged, detail: out };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// The public routes' own rate limit (per address, then per link)
// ---------------------------------------------------------------------------

const publicBucket = new WeakMap<FastifyRequest, string>();
type Limiter = (req: FastifyRequest) => Promise<{ isAllowed: boolean; isExceeded: boolean; max: number; remaining: number; ttlInSeconds: number; timeWindow: number }>;

function publicLimiter(app: FastifyInstance): (req: FastifyRequest, reply: FastifyReply, bucket: string) => Promise<boolean> {
  let limiter: Limiter | null = null;
  const limits = (key: string) => (key.startsWith("fbl:link:") ? FEEDBACK_PUBLIC_RATE_LIMITS.perLink : FEEDBACK_PUBLIC_RATE_LIMITS.perAddress);
  return async (req, reply, bucket) => {
    // The operator's REGULAIT_RATE_LIMIT switch turns every HTTP limiter off at
    // once (tests run so); these buckets follow it rather than inventing a second switch.
    if (!app.hasDecorator("createRateLimit")) return false;
    limiter ??= app.createRateLimit({
      keyGenerator: (r: FastifyRequest) => publicBucket.get(r) ?? `fbl:addr:${r.ip}`,
      max: (_r: FastifyRequest, k: string) => limits(k).max,
      timeWindow: (_r: FastifyRequest, k: string) => limits(k).windowMs,
      allowList: () => false,
    }) as unknown as Limiter;
    publicBucket.set(req, bucket);
    const v = await limiter(req);
    if (!v.isExceeded) return false;
    await reply
      .status(429)
      .header("retry-after", String(v.ttlInSeconds))
      .send({
        error: "rate_limited",
        detail: `too many requests on this feedback link — limit ${v.max} per ${Math.round(v.timeWindow / 60_000)} minutes`,
        retryAfterSeconds: v.ttlInSeconds,
      });
    return true;
  };
}

type LinkState = "active" | "expired" | "revoked" | "used_up";
const linkState = (l: { revokedAt: Date | null; expiresAt: Date; uses: number; maxUses: number }, now: Date): LinkState =>
  l.revokedAt ? "revoked" : l.expiresAt.getTime() <= now.getTime() ? "expired" : l.uses >= l.maxUses ? "used_up" : "active";

const LINK_GONE: Record<Exclude<LinkState, "active">, string> = {
  expired: "This feedback link has expired. Ask the organisation that sent it for a new one.",
  revoked: "This feedback link was withdrawn. Ask the organisation that sent it for a new one.",
  used_up: "This feedback link has been used as many times as it allows. Ask the organisation that sent it for a new one.",
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const ucParams = z.object({ useCaseId: z.string().uuid() });
const idParams = z.object({ feedbackId: z.string().uuid() });
const linkParams = z.object({ useCaseId: z.string().uuid(), linkId: z.string().uuid() });
const tokenParams = z.object({ token: z.string().max(200) });
const listQuery = z
  .object({
    scope: z.enum(["queue", "submitted"]).default("queue"),
    useCaseId: z.string().uuid().optional(),
    status: z.union([z.enum(["open", "resolved", "all"]), z.enum(FEEDBACK_STATUSES)]).default("all"),
    kind: z.enum(FEEDBACK_KINDS).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

/** the credential headers an internal call on the caller's behalf carries */
const FORWARDED_HEADERS = ["authorization", "cookie", "x-api-key", "x-regulait-csrf"] as const;

export interface FeedbackRouteOptions {
  dataKey?: string | undefined;
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A13 block):
 *   POST   /v1/use-cases/:useCaseId/feedback                    user: any signed-in user
 *   GET    /v1/feedback                                         user: the caller's queue (admin: all), or what they submitted
 *   GET    /v1/feedback/:feedbackId                             user: owner or admin (a body read is audited)
 *   PATCH  /v1/feedback/:feedbackId                             user: owner or admin
 *   POST   /v1/feedback/:feedbackId/open-incident               user: owner or admin
 *   POST   /v1/use-cases/:useCaseId/feedback-links              user: the use case's owner or admin
 *   GET    /v1/use-cases/:useCaseId/feedback-links              user: the use case's owner or admin
 *   DELETE /v1/use-cases/:useCaseId/feedback-links/:linkId      user: the use case's owner or admin (revokes)
 *   POST   /v1/feedback/l/:token                                PUBLIC (signed link; 404 while the setting is off)
 *   GET    /v1/feedback/l/:token                                PUBLIC (the use case's public name only)
 */
export function registerFeedbackRoutes(app: FastifyInstance, db: Db, opts: FeedbackRouteOptions = {}): void {
  const dataKey = opts.dataKey;
  const limitPublic = publicLimiter(app);

  const noDataKey = (reply: FastifyReply) =>
    reply.status(503).send({
      error: "data_key_required",
      detail:
        "Feedback text and contact details are stored encrypted under the data key (REGULAIT_DATA_KEY), and this " +
        "gateway has none, so nothing was stored. Ask an administrator to configure it.",
    });

  /** the item, if the caller is its owner or an admin; otherwise the reply is sent (403/404, audited) */
  async function itemForOwnerOrAdmin(
    req: FastifyRequest,
    reply: FastifyReply,
    feedbackId: string,
    action: string,
  ): Promise<(UseCaseFeedbackRow & { useCaseName: string | null }) | null> {
    const [row] = await db
      .select({ f: useCaseFeedback, useCaseName: aiUseCases.name })
      .from(useCaseFeedback)
      .innerJoin(aiUseCases, eq(aiUseCases.id, useCaseFeedback.useCaseId))
      .where(eq(useCaseFeedback.id, feedbackId));
    if (!row) {
      await reply.status(404).send({ error: "not_found" });
      return null;
    }
    const me = req.authCtx.userId;
    if (!req.authCtx.isAdmin && (me === null || row.f.ownerUserId !== me)) {
      await audit(db, {
        userId: me,
        objectType: "use_case_feedback",
        objectId: feedbackId,
        ruleId: FEEDBACK_RULE_IDS.readDenied,
        effect: "deny",
        reason: `feedback ${feedbackId}: ${action} refused — only the item's owner or an admin`,
        detail: { action, useCaseId: row.f.useCaseId },
      });
      await reply.status(403).send({
        error: "forbidden",
        detail: "Only the person this feedback is routed to, or an admin, can open or answer it.",
      });
      return null;
    }
    return { ...row.f, useCaseName: row.useCaseName };
  }

  async function useCaseForOwnerOrAdmin(req: FastifyRequest, reply: FastifyReply, useCaseId: string): Promise<UseCaseRef | null> {
    const uc = await loadUseCase(db, useCaseId);
    if (!uc) {
      await reply.status(404).send({ error: "not_found" });
      return null;
    }
    const me = req.authCtx.userId;
    if (!req.authCtx.isAdmin && (me === null || uc.ownerUserId !== me)) {
      await reply.status(403).send({ error: "forbidden", detail: "Signed feedback links are managed by the use case's owner or an admin." });
      return null;
    }
    return uc;
  }

  // ---- submit (signed in) ----------------------------------------------------
  app.post("/v1/use-cases/:useCaseId/feedback", async (req, reply) => {
    const { useCaseId } = ucParams.parse(req.params);
    const body = submitFeedbackSchema.parse(req.body);
    const uc = await loadUseCase(db, useCaseId);
    if (!uc) return reply.status(404).send({ error: "not_found" });
    const me = req.authCtx.userId;
    let contestedUserId: string | null = null;
    if (body.traceId) {
      const owned = await traceBelongsToUseCase(db, uc, body.traceId, body.spanId);
      if (!owned) {
        await audit(db, {
          userId: me,
          objectType: "use_case_feedback",
          objectId: null,
          ruleId: FEEDBACK_RULE_IDS.submitRefused,
          effect: "deny",
          reason: `feedback on use case ${useCaseId} refused: the cited trace is not one of this use case's`,
          detail: { useCaseId, traceId: body.traceId, spanId: body.spanId ?? null, code: "trace_not_in_use_case" },
        });
        return reply.status(422).send({
          error: "trace_not_in_use_case",
          detail:
            "The cited trace (or span) is not one of this use case's: it must be in the use case's project, or " +
            "run by one of its agents. Submit without it, or cite the right one.",
        });
      }
      contestedUserId = body.kind === "appeal" ? owned.contestedUserId : null;
    }
    if (!dataKey) return noDataKey(reply);
    const settings = await loadOrgSettings(db);
    const now = new Date();
    const due = feedbackDueDates(now, { ackHours: settings.feedbackAckSlaHours, resolveDays: settings.feedbackResolveSlaDays });
    const ownerUserId = feedbackRouteTo({ kind: body.kind, useCaseOwnerUserId: uc.ownerUserId, submitterUserId: me, contestedUserId });
    const row = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [f] = await tx
        .insert(useCaseFeedback)
        .values({
          useCaseId,
          kind: body.kind,
          channel: "in_app",
          submitterUserId: me,
          bodyCiphertext: encryptSecret(dataKey, body.body),
          contactCiphertext: body.contact ? encryptSecret(dataKey, body.contact) : null,
          traceId: body.traceId ?? null,
          spanId: body.spanId ?? null,
          ownerUserId,
          ackDueAt: due.ackDueAt,
          resolveDueAt: due.resolveDueAt,
          createdAt: now,
        })
        .returning();
      await audit(tx, {
        userId: me,
        objectType: "use_case_feedback",
        objectId: f!.id,
        ruleId: FEEDBACK_RULE_IDS.submitted,
        reason: `${kindWord(body.kind)} on use case ${useCaseId} received in-app; routed to ${ownerUserId ? `its owner (user ${ownerUserId})` : "the admins"}`,
        detail: {
          useCaseId,
          kind: body.kind,
          channel: "in_app",
          traceId: body.traceId ?? null,
          spanId: body.spanId ?? null,
          ownerUserId,
          routedTo: ownerUserId ? "owner" : "admins",
          contactGiven: !!body.contact,
          ackDueAt: due.ackDueAt.toISOString(),
          resolveDueAt: due.resolveDueAt.toISOString(),
        },
      });
      return f!;
    });
    return reply.status(201).send({
      ...listView({ ...row, useCaseName: uc.name }, now),
      routedTo: ownerUserId ? "owner" : "admins",
    });
  });

  // ---- the queue -------------------------------------------------------------
  app.get("/v1/feedback", async (req, reply) => {
    const q = listQuery.parse(req.query);
    const me = req.authCtx.userId;
    const conds = [];
    if (q.scope === "submitted") {
      if (!me) return reply.send({ items: [], scope: q.scope });
      conds.push(eq(useCaseFeedback.submitterUserId, me));
    } else if (!req.authCtx.isAdmin) {
      if (!me) return reply.send({ items: [], scope: q.scope });
      conds.push(eq(useCaseFeedback.ownerUserId, me));
    }
    if (q.useCaseId) conds.push(eq(useCaseFeedback.useCaseId, q.useCaseId));
    if (q.kind) conds.push(eq(useCaseFeedback.kind, q.kind));
    if (q.status === "open") conds.push(isNull(useCaseFeedback.resolvedAt));
    else if (q.status === "resolved") conds.push(isNotNull(useCaseFeedback.resolvedAt));
    else if (q.status !== "all") conds.push(eq(useCaseFeedback.status, q.status));
    const rows = await db
      .select({ f: useCaseFeedback, useCaseName: aiUseCases.name, ownerName: users.displayName })
      .from(useCaseFeedback)
      .innerJoin(aiUseCases, eq(aiUseCases.id, useCaseFeedback.useCaseId))
      .leftJoin(users, eq(users.id, useCaseFeedback.ownerUserId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(sql`${useCaseFeedback.resolvedAt} is not null`, asc(useCaseFeedback.resolveDueAt), desc(useCaseFeedback.createdAt))
      .limit(q.limit);
    const now = new Date();
    return reply.send({
      scope: q.scope,
      items: rows.map((r) => ({ ...listView({ ...r.f, useCaseName: r.useCaseName }, now), ownerName: r.ownerName ?? null })),
    });
  });

  // ---- one item, with its body (audited) -------------------------------------
  app.get("/v1/feedback/:feedbackId", async (req, reply) => {
    const { feedbackId } = idParams.parse(req.params);
    const item = await itemForOwnerOrAdmin(req, reply, feedbackId, "read");
    if (!item) return reply;
    const me = req.authCtx.userId;
    let body: string | null = null;
    let contact: string | null = null;
    let bodyUnavailable: null | "purged" | "no_data_key" | "undecryptable" = null;
    if (item.bodyPurgedAt) bodyUnavailable = "purged";
    else if (!dataKey) bodyUnavailable = "no_data_key";
    else {
      try {
        body = item.bodyCiphertext ? decryptSecret(dataKey, item.bodyCiphertext) : null;
        contact = item.contactCiphertext ? decryptSecret(dataKey, item.contactCiphertext) : null;
      } catch {
        bodyUnavailable = "undecryptable";
      }
    }
    await audit(db, {
      userId: me,
      objectType: "use_case_feedback",
      objectId: feedbackId,
      ruleId: FEEDBACK_RULE_IDS.bodyRead,
      reason:
        `feedback ${feedbackId}: ${body !== null ? "body read" : `opened (body ${bodyUnavailable})`}` +
        `${contact !== null ? " with contact details" : ""} by ${req.authCtx.isAdmin ? "an admin" : "its owner"}`,
      detail: { useCaseId: item.useCaseId, bodyRead: body !== null, contactRead: contact !== null, bodyUnavailable, asAdmin: req.authCtx.isAdmin },
    });
    const contestedUserId = await contestedUserOf(db, item);
    const sod = me
      ? appealSodConflict({ kind: item.kind, resolverUserId: me, submitterUserId: item.submitterUserId, contestedUserId })
      : null;
    return reply.send({
      ...listView(item, new Date()),
      submitterUserId: item.submitterUserId,
      body,
      contact,
      bodyUnavailable,
      bodyPurgedAt: item.bodyPurgedAt?.toISOString() ?? null,
      resolutionNote: item.resolutionNote,
      resolvedBy: item.resolvedBy,
      contestedUserId,
      youMayResolve: !isResolvedFeedbackStatus(item.status) && sod === null,
      sodConflict: sod,
    });
  });

  // ---- answer: acknowledge, review, resolve, reassign -------------------------
  app.patch("/v1/feedback/:feedbackId", async (req, reply) => {
    const { feedbackId } = idParams.parse(req.params);
    const body = updateFeedbackSchema.parse(req.body);
    if (body.status === undefined && body.ownerUserId === undefined && body.resolutionNote === undefined) {
      return reply.status(400).send({ error: "validation", detail: "name a status, an owner or a resolution note" });
    }
    const pre = await itemForOwnerOrAdmin(req, reply, feedbackId, "update");
    if (!pre) return reply;
    const me = req.authCtx.userId;
    const refuse = async (status: number, code: string, detail: string, extra: Record<string, unknown> = {}) => {
      await audit(db, {
        userId: me,
        objectType: "use_case_feedback",
        objectId: feedbackId,
        ruleId: code === "appeal_separation_of_duties" ? FEEDBACK_RULE_IDS.sodRefused : FEEDBACK_RULE_IDS.updateRefused,
        effect: "deny",
        reason: `feedback ${feedbackId}: update refused (${code})`,
        detail: { code, ...extra, attempted: { status: body.status ?? null, ownerUserId: body.ownerUserId ?? null } },
      });
      return reply.status(status).send({ error: code, detail, ...extra });
    };

    const now = new Date();
    const contestedUserId = await contestedUserOf(db, pre);
    if (isResolvedFeedbackStatus(pre.status)) {
      return refuse(409, "feedback_already_resolved", "This item is resolved and its record is final. A new report is a new item.");
    }
    if (body.status !== undefined && body.status !== pre.status) {
      const problem = feedbackTransitionProblem(pre.kind, pre.status, body.status);
      if (problem === "appeal_outcome_on_problem") {
        return refuse(422, problem, "Upheld and overturned are an appeal's outcomes. Resolve a problem report as no change or rejected.");
      }
      if (problem) return refuse(409, problem, `A ${kindWord(pre.kind)} cannot move from ${pre.status} to ${body.status}.`);
      if (isResolvedFeedbackStatus(body.status)) {
        if (!body.resolutionNote) {
          return refuse(422, "resolution_note_required", "Say how it was resolved: the note is the answer on the record.");
        }
        const sod = me
          ? appealSodConflict({ kind: pre.kind, resolverUserId: me, submitterUserId: pre.submitterUserId, contestedUserId })
          : null;
        if (sod) {
          return refuse(
            403,
            "appeal_separation_of_duties",
            sod === "contested_decision_maker"
              ? "You made the decision this appeal contests, so someone else must decide it. Reassign it to another person or an admin."
              : "You filed this appeal, so someone else must decide it.",
            { conflict: sod },
          );
        }
      }
    }
    if (body.ownerUserId !== undefined && body.ownerUserId !== pre.ownerUserId) {
      const [target] = await db
        .select({ id: users.id, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, body.ownerUserId));
      if (!target || target.disabledAt) {
        return refuse(422, "owner_not_found", "The new owner must be an active user.");
      }
      const conflict = appealSodConflict({
        kind: pre.kind,
        resolverUserId: body.ownerUserId,
        submitterUserId: pre.submitterUserId,
        contestedUserId,
      });
      if (conflict) {
        return refuse(422, "owner_conflicted", "That person made the contested decision or filed the appeal, so they cannot own it.", {
          conflict,
        });
      }
    }

    const next: Partial<typeof useCaseFeedback.$inferInsert> = {};
    if (body.status !== undefined && body.status !== pre.status) {
      next.status = body.status;
      if (body.status !== "received" && !pre.acknowledgedAt) next.acknowledgedAt = now;
      if (isResolvedFeedbackStatus(body.status)) {
        next.resolvedAt = now;
        next.resolvedBy = me;
      }
    }
    if (body.ownerUserId !== undefined && body.ownerUserId !== pre.ownerUserId) next.ownerUserId = body.ownerUserId;
    if (body.resolutionNote !== undefined && body.resolutionNote !== pre.resolutionNote) next.resolutionNote = body.resolutionNote;
    if (Object.keys(next).length === 0) return reply.send({ ...listView(pre, now), changed: false });

    const transitions = settingTransitions(
      { status: pre.status, ownerUserId: pre.ownerUserId, acknowledged: pre.acknowledgedAt !== null },
      {
        ...(next.status ? { status: next.status } : {}),
        ...(next.ownerUserId !== undefined ? { ownerUserId: next.ownerUserId } : {}),
        ...(next.acknowledgedAt ? { acknowledged: true } : {}),
      },
    );
    const updated = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      // compare-and-swap on the status read above: a concurrent answer wins once
      const [u] = await tx
        .update(useCaseFeedback)
        .set(next)
        .where(and(eq(useCaseFeedback.id, feedbackId), eq(useCaseFeedback.status, pre.status), isNull(useCaseFeedback.resolvedAt)))
        .returning();
      if (!u) return null;
      await audit(tx, {
        userId: me,
        objectType: "use_case_feedback",
        objectId: feedbackId,
        ruleId: FEEDBACK_RULE_IDS.updated,
        reason:
          `feedback ${feedbackId} (${kindWord(pre.kind)}): ` +
          (Object.entries(transitions)
            .map(([k, t]) => `${k} ${String(t.from)} -> ${String(t.to)}`)
            .join(", ") || "resolution note updated"),
        detail: { useCaseId: pre.useCaseId, kind: pre.kind, transitions, resolutionNoteSet: next.resolutionNote !== undefined },
      });
      return u;
    });
    if (!updated) {
      return reply.status(409).send({ error: "feedback_changed", detail: "Someone else answered this item a moment ago. Reload it." });
    }
    return reply.send({ ...listView({ ...updated, useCaseName: pre.useCaseName }, now), changed: true });
  });

  // ---- open an A12 incident, pre-linked to this item ---------------------------
  app.post("/v1/feedback/:feedbackId/open-incident", async (req, reply) => {
    const { feedbackId } = idParams.parse(req.params);
    const body = openIncidentFromFeedbackSchema.parse(req.body);
    const item = await itemForOwnerOrAdmin(req, reply, feedbackId, "open-incident");
    if (!item) return reply;
    if (item.incidentId) {
      return reply.status(409).send({ error: "incident_already_linked", incidentId: item.incidentId, detail: "This item already has an incident." });
    }
    const out = await openIncidentFromFeedback(
      {
        createIncident: async (payload) => {
          // A12's own route contract (`POST /v1/incidents`), called as the caller:
          // the incident gets A12's rules, clocks and audit, and the caller's own
          // entitlements decide whether it may be created.
          const headers: Record<string, string> = { "content-type": "application/json" };
          for (const h of FORWARDED_HEADERS) {
            const v = req.headers[h];
            if (typeof v === "string") headers[h] = v;
          }
          const res = await app.inject({ method: "POST", url: "/v1/incidents", headers, payload, remoteAddress: req.ip });
          let json: Record<string, unknown> = {};
          try {
            json = res.json() as Record<string, unknown>;
          } catch {
            json = { error: "incident_create_failed" };
          }
          return { status: res.statusCode, body: json };
        },
        linkIncident: async (incidentId) => {
          return db.transaction(async (rawTx) => {
            const tx = rawTx as unknown as Db;
            const [u] = await tx
              .update(useCaseFeedback)
              .set({ incidentId })
              .where(and(eq(useCaseFeedback.id, feedbackId), isNull(useCaseFeedback.incidentId)))
              .returning({ id: useCaseFeedback.id });
            if (!u) return false;
            await audit(tx, {
              userId: req.authCtx.userId,
              objectType: "use_case_feedback",
              objectId: feedbackId,
              ruleId: FEEDBACK_RULE_IDS.incidentOpened,
              reason: `feedback ${feedbackId}: incident ${incidentId} opened from it and linked`,
              detail: { useCaseId: item.useCaseId, incidentId, severity: body.severity },
            });
            return true;
          });
        },
      },
      { feedbackId, useCaseId: item.useCaseId, kind: item.kind, title: body.title, severity: body.severity },
    );
    return reply.status(out.status).send(out.body);
  });

  // ---- signed links: mint, list, revoke (owner or admin) -----------------------
  app.post("/v1/use-cases/:useCaseId/feedback-links", async (req, reply) => {
    const { useCaseId } = ucParams.parse(req.params);
    const body = createFeedbackLinkSchema.parse(req.body);
    const uc = await useCaseForOwnerOrAdmin(req, reply, useCaseId);
    if (!uc) return reply;
    const settings = await loadOrgSettings(db);
    if (!settings.feedbackSignedLinksEnabled) {
      await audit(db, {
        userId: req.authCtx.userId,
        objectType: "feedback_link",
        objectId: null,
        ruleId: FEEDBACK_RULE_IDS.linkRefused,
        effect: "deny",
        reason: `signed feedback link for use case ${useCaseId} refused: public signed links are off (the strict default)`,
        detail: { useCaseId, code: "feedback_signed_links_disabled" },
      });
      return reply.status(409).send({
        error: "feedback_signed_links_disabled",
        detail:
          "Public signed feedback links are off, the strict default: only signed-in users can report a problem or " +
          "appeal. An admin can turn them on in the feedback settings (the change is audited).",
      });
    }
    const now = new Date();
    const { token, tokenHash } = generateFeedbackLinkToken();
    const expiresAt = new Date(now.getTime() + body.expiresInDays * DAY_MS);
    const link = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [l] = await tx
        .insert(useCaseFeedbackLinks)
        .values({ useCaseId, tokenHash, expiresAt, maxUses: body.maxUses, createdBy: req.authCtx.userId, createdAt: now })
        .returning();
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "feedback_link",
        objectId: l!.id,
        ruleId: FEEDBACK_RULE_IDS.linkCreated,
        reason: `signed feedback link for use case ${useCaseId} created: ${body.expiresInDays} days, ${body.maxUses} uses`,
        detail: { useCaseId, expiresAt: expiresAt.toISOString(), maxUses: body.maxUses },
      });
      return l!;
    });
    return reply.status(201).send({
      id: link.id,
      useCaseId,
      token,
      path: `/ui/f/${token}`,
      expiresAt: link.expiresAt.toISOString(),
      maxUses: link.maxUses,
      uses: 0,
      state: "active",
      shownOnce: true,
    });
  });

  app.get("/v1/use-cases/:useCaseId/feedback-links", async (req, reply) => {
    const { useCaseId } = ucParams.parse(req.params);
    const uc = await useCaseForOwnerOrAdmin(req, reply, useCaseId);
    if (!uc) return reply;
    const settings = await loadOrgSettings(db);
    const rows = await db
      .select()
      .from(useCaseFeedbackLinks)
      .where(eq(useCaseFeedbackLinks.useCaseId, useCaseId))
      .orderBy(desc(useCaseFeedbackLinks.createdAt));
    const now = new Date();
    return reply.send({
      enabled: settings.feedbackSignedLinksEnabled,
      links: rows.map((l) => ({
        id: l.id,
        expiresAt: l.expiresAt.toISOString(),
        maxUses: l.maxUses,
        uses: l.uses,
        revokedAt: l.revokedAt?.toISOString() ?? null,
        createdBy: l.createdBy,
        createdAt: l.createdAt.toISOString(),
        state: linkState(l, now),
      })),
    });
  });

  app.delete("/v1/use-cases/:useCaseId/feedback-links/:linkId", async (req, reply) => {
    const { useCaseId, linkId } = linkParams.parse(req.params);
    const uc = await useCaseForOwnerOrAdmin(req, reply, useCaseId);
    if (!uc) return reply;
    const [l] = await db
      .select()
      .from(useCaseFeedbackLinks)
      .where(and(eq(useCaseFeedbackLinks.id, linkId), eq(useCaseFeedbackLinks.useCaseId, useCaseId)));
    if (!l) return reply.status(404).send({ error: "not_found" });
    if (l.revokedAt) return reply.send({ id: linkId, revokedAt: l.revokedAt.toISOString(), changed: false });
    const now = new Date();
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx.update(useCaseFeedbackLinks).set({ revokedAt: now }).where(and(eq(useCaseFeedbackLinks.id, linkId), isNull(useCaseFeedbackLinks.revokedAt)));
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "feedback_link",
        objectId: linkId,
        ruleId: FEEDBACK_RULE_IDS.linkRevoked,
        reason: `signed feedback link ${linkId} for use case ${useCaseId} revoked (${l.uses} of ${l.maxUses} uses spent)`,
        detail: { useCaseId, uses: l.uses, maxUses: l.maxUses },
      });
    });
    return reply.send({ id: linkId, revokedAt: now.toISOString(), changed: true });
  });

  // ---- the PUBLIC signed-link routes (AUTH_EXEMPT; authenticated here on the token) ----
  /** the link a public request names, or null with the reply sent. Order is the
   * cheap-first, enumeration-proof one: setting, address bucket, shape, lookup,
   * link bucket, state. */
  async function publicLink(req: FastifyRequest, reply: FastifyReply) {
    const notFound = () => reply.status(404).send({ error: "not_found" });
    const settings = await loadOrgSettings(db);
    if (!settings.feedbackSignedLinksEnabled) {
      await notFound();
      return null;
    }
    if (await limitPublic(req, reply, `fbl:addr:${req.ip}`)) return null;
    const { token } = tokenParams.parse(req.params);
    if (!LINK_TOKEN_RE.test(token)) {
      await notFound();
      return null;
    }
    const [l] = await db
      .select({ link: useCaseFeedbackLinks, useCaseName: aiUseCases.name })
      .from(useCaseFeedbackLinks)
      .innerJoin(aiUseCases, eq(aiUseCases.id, useCaseFeedbackLinks.useCaseId))
      .where(eq(useCaseFeedbackLinks.tokenHash, hashToken(token)));
    if (!l) {
      await notFound();
      return null;
    }
    if (await limitPublic(req, reply, `fbl:link:${l.link.id}`)) return null;
    const state = linkState(l.link, new Date());
    if (state !== "active") {
      await reply.status(410).send({ error: `link_${state}`, detail: LINK_GONE[state] });
      return null;
    }
    return { ...l, settings };
  }

  app.get("/v1/feedback/l/:token", async (req, reply) => {
    const l = await publicLink(req, reply);
    if (!l) return reply;
    return reply.send({
      useCaseName: l.useCaseName,
      kinds: FEEDBACK_KINDS,
      bodyMaxChars: FEEDBACK_BODY_MAX_CHARS,
      expiresAt: l.link.expiresAt.toISOString(),
    });
  });

  // a small body limit on the one unauthenticated write: 4000 characters of
  // text plus a contact, never the gateway's general limit
  app.post("/v1/feedback/l/:token", { bodyLimit: 32 * 1024 }, async (req, reply) => {
    const l = await publicLink(req, reply);
    if (!l) return reply;
    const body = publicFeedbackSchema.parse(req.body);
    if (!dataKey) return noDataKey(reply);
    const [uc] = await db.select({ ownerUserId: aiUseCases.ownerUserId }).from(aiUseCases).where(eq(aiUseCases.id, l.link.useCaseId));
    const now = new Date();
    const due = feedbackDueDates(now, { ackHours: l.settings.feedbackAckSlaHours, resolveDays: l.settings.feedbackResolveSlaDays });
    const ownerUserId = feedbackRouteTo({ kind: body.kind, useCaseOwnerUserId: uc?.ownerUserId ?? null, submitterUserId: null, contestedUserId: null });
    const created = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      // spend one use, atomically: still live, still unexpired, still a use left
      const [spent] = await tx
        .update(useCaseFeedbackLinks)
        .set({ uses: sql`${useCaseFeedbackLinks.uses} + 1` })
        .where(
          and(
            eq(useCaseFeedbackLinks.id, l.link.id),
            isNull(useCaseFeedbackLinks.revokedAt),
            sql`${useCaseFeedbackLinks.expiresAt} > ${now}`,
            sql`${useCaseFeedbackLinks.uses} < ${useCaseFeedbackLinks.maxUses}`,
          ),
        )
        .returning({ uses: useCaseFeedbackLinks.uses });
      if (!spent) return null;
      const [f] = await tx
        .insert(useCaseFeedback)
        .values({
          useCaseId: l.link.useCaseId,
          kind: body.kind,
          channel: "signed_link",
          linkId: l.link.id,
          submitterUserId: null,
          bodyCiphertext: encryptSecret(dataKey, body.body),
          contactCiphertext: body.contact ? encryptSecret(dataKey, body.contact) : null,
          ownerUserId,
          ackDueAt: due.ackDueAt,
          resolveDueAt: due.resolveDueAt,
          createdAt: now,
        })
        .returning();
      await audit(tx, {
        userId: null,
        objectType: "use_case_feedback",
        objectId: f!.id,
        ruleId: FEEDBACK_RULE_IDS.submitted,
        reason: `${kindWord(body.kind)} on use case ${l.link.useCaseId} received through signed link ${l.link.id}`,
        detail: {
          useCaseId: l.link.useCaseId,
          kind: body.kind,
          channel: "signed_link",
          linkId: l.link.id,
          linkUses: spent.uses,
          ownerUserId,
          routedTo: ownerUserId ? "owner" : "admins",
          contactGiven: !!body.contact,
          ackDueAt: due.ackDueAt.toISOString(),
          resolveDueAt: due.resolveDueAt.toISOString(),
        },
      });
      return f!;
    });
    if (!created) {
      return reply.status(410).send({ error: "link_used_up", detail: LINK_GONE.used_up });
    }
    return reply.status(201).send({
      reference: created.id,
      kind: created.kind,
      ackDueAt: created.ackDueAt.toISOString(),
      resolveDueAt: created.resolveDueAt.toISOString(),
    });
  });
}

// ---------------------------------------------------------------------------
// "Open incident" (A12), separated from the transport so it can be tested alone
// ---------------------------------------------------------------------------

export interface OpenIncidentDeps {
  /** create the incident through A12's `POST /v1/incidents` contract */
  createIncident: (payload: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** set the item's `incident_id` if still unset (audited); false if another incident won */
  linkIncident: (incidentId: string) => Promise<boolean>;
}

/**
 * Open an incident pre-linked to a feedback item: `detection_source =
 * user_report`, the use case, and a `feedback` link to the item. The incident
 * carries NO copy of what the person wrote: its summary names the item, and a
 * reader opens the item (an audited read) for the text.
 */
export async function openIncidentFromFeedback(
  deps: OpenIncidentDeps,
  item: { feedbackId: string; useCaseId: string; kind: FeedbackKind; title: string; severity: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = {
    title: item.title,
    summary: `Opened from ${item.kind === "appeal" ? "an appeal" : "a problem report"} (feedback ${item.feedbackId}).`,
    severity: item.severity,
    detectionSource: "user_report",
    sourceRef: `feedback:${item.feedbackId}`,
    useCaseId: item.useCaseId,
    links: [{ objectType: "feedback", objectId: item.feedbackId }],
  };
  const res = await deps.createIncident(payload);
  if (res.status !== 201 && res.status !== 200) {
    return { status: res.status, body: { ...res.body, error: String(res.body.error ?? "incident_create_failed") } };
  }
  const nested = res.body.incident as { id?: unknown } | undefined;
  const incidentId = typeof res.body.id === "string" ? res.body.id : typeof nested?.id === "string" ? nested.id : null;
  if (!incidentId) return { status: 502, body: { error: "incident_create_failed", detail: "the incident service returned no id" } };
  const linked = await deps.linkIncident(incidentId);
  if (!linked) {
    return {
      status: 409,
      body: {
        error: "incident_already_linked",
        incidentId,
        detail: "Another incident was linked to this item at the same moment; the new incident exists unlinked.",
      },
    };
  }
  return { status: 201, body: { feedbackId: item.feedbackId, incidentId } };
}

export type { FeedbackStatus };
