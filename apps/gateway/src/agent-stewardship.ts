/**
 * ADR-0168 amendment item 6 — AGENT STEWARDSHIP.
 *
 * An agent is a non-human identity, and like any identity it needs a human who
 * answers for it (the steward), someone who takes over when that person leaves
 * (the successor), a lifecycle status, and a review cadence so it is looked at
 * again on time. This module is the write side (two audited routes) and the
 * read-time view the agent list renders.
 *
 *  - The STEWARD is the ADR-0089 accountable owner (`agents.owner_user_id`).
 *    The API calls it `stewardUserId`; storage stays ONE column, so the
 *    inventory, the posture page, the governance monitor's unowned-agent rule
 *    and the ADR-0159 remediation executor all keep reading the same fact.
 *  - ORPHANED (computed, never stored): no steward, or the steward's account is
 *    deactivated (`users.disabled_at`, the state SCIM deprovisioning writes).
 *  - REVIEW OVERDUE (computed): a next review date in the past on an agent that
 *    is not retired.
 *  - CADENCE: a recorded review schedules the next one 6 months out when any
 *    live use case naming the agent is high-risk (or prohibited) under the EU
 *    AI Act screening, 12 months otherwise. Rejected and retired use cases do
 *    not count: they are not a reason to run the agent.
 *
 * Authorization: an admin, or the agent's CURRENT steward (an active user).
 * Both routes are in NON_ADMIN_ROUTES for that reason and check in-handler.
 *
 * ADR-0170 item 7 — a steward may TIGHTEN an agent's lifecycle, never loosen
 * it. A non-admin steward may move an agent to `under_review` or `suspended`
 * (STEWARD_LIFECYCLE_MOVES); making it `active` again (which would lift a
 * suspension an admin imposed), retiring it, or moving it out of `proposed` is
 * an admin decision (403 admin_required_for_lifecycle). A steward's next review
 * date is capped at the agent's cadence (422 next_review_beyond_cadence) and
 * only an admin may clear it. The write is compare-and-swap on the lifecycle
 * status that was read (409 lifecycle_changed_concurrently), so a concurrent
 * retirement or suspension is never overwritten by a stale read.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { agents, aiUseCases, and, auditLog, eq, inArray, notInArray, sql, users, type Db } from "@regulait/db";
import { setAgentStewardshipSchema } from "@regulait/shared";
import { ownerChangeStepUpArgs, requireStepUps, type StepUpCheckArgs } from "./step-up.js";

const params = z.object({ agentId: z.string().uuid() });
const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

/** EU AI Act tiers that put an agent on the short (6-month) review cadence. */
const SHORT_CADENCE_TIERS = new Set(["high", "prohibited"]);
const TIER_RANK: Record<string, number> = { minimal: 1, limited: 2, high: 3, prohibited: 4 };
export const REVIEW_CADENCE_MONTHS = { short: 6, standard: 12 } as const;

type AgentRow = typeof agents.$inferSelect;

/**
 * ADR-0170 item 7: from each lifecycle status, the statuses a NON-ADMIN steward
 * may move an agent to. Only tightening moves: `under_review` and `suspended`
 * from a status that still dispatches. Leaving `suspended` (to anything —
 * `under_review` dispatches again), leaving `proposed`, retiring, and erasing a
 * `deprecated` marker are absent on purpose: they are an admin's call.
 */
export const STEWARD_LIFECYCLE_MOVES: Readonly<Record<string, readonly string[]>> = {
  active: ["under_review", "suspended"],
  under_review: ["suspended"],
  deprecated: ["suspended"],
};

function refuseAdminRequired(reply: FastifyReply, detail: string) {
  return reply.status(403).send({ error: "admin_required_for_lifecycle", detail });
}

/** the compare-and-swap miss on a lifecycle write — another write changed the status first */
export function refuseLifecycleChangedConcurrently(reply: FastifyReply, readStatus: string) {
  return reply.status(409).send({
    error: "lifecycle_changed_concurrently",
    detail: `the agent's status changed while this change was being made (it was '${readStatus}') — reload the agent and try again`,
  });
}

export interface StewardshipView {
  stewardUserId: string | null;
  stewardName: string | null;
  stewardDeactivated: boolean;
  successorUserId: string | null;
  successorName: string | null;
  successorDeactivated: boolean;
  orphaned: boolean;
  reviewOverdue: boolean;
  nextReviewAt: string | null;
  lastReviewedAt: string | null;
  lastReviewedByName: string | null;
  /** 6 or 12 — what the NEXT recorded review would schedule */
  reviewCadenceMonths: number;
  /** the highest EU AI Act tier among the live use cases naming this agent */
  highestUseCaseTier: string | null;
}

interface UserLite {
  id: string;
  name: string;
  disabled: boolean;
}

async function loadUsers(db: Db, ids: Array<string | null>): Promise<Map<string, UserLite>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email, disabledAt: users.disabledAt })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((u) => [u.id, { id: u.id, name: u.displayName || u.email, disabled: !!u.disabledAt }]));
}

/** agentId → highest tier among the live (not rejected/retired) use cases naming it */
async function highestTierByAgent(db: Db, agentIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (agentIds.length === 0) return out;
  const rows = await db
    .select({ intendedAgentIds: aiUseCases.intendedAgentIds, tier: aiUseCases.euAiActTier })
    .from(aiUseCases)
    .where(
      and(
        notInArray(aiUseCases.status, ["rejected", "retired"]),
        sql`${aiUseCases.intendedAgentIds} ?| array[${sql.join(
          agentIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[]`,
      ),
    );
  const wanted = new Set(agentIds);
  for (const r of rows) {
    if (!r.tier) continue;
    for (const id of r.intendedAgentIds ?? []) {
      if (!wanted.has(id)) continue;
      const cur = out.get(id);
      if (!cur || (TIER_RANK[r.tier] ?? 0) > (TIER_RANK[cur] ?? 0)) out.set(id, r.tier);
    }
  }
  return out;
}

export function cadenceMonthsFor(highestTier: string | null | undefined): number {
  return highestTier && SHORT_CADENCE_TIERS.has(highestTier) ? REVIEW_CADENCE_MONTHS.short : REVIEW_CADENCE_MONTHS.standard;
}

function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** The read-time stewardship view for a set of agent rows (one query per table). */
export async function stewardshipViews(db: Db, rows: AgentRow[], now = new Date()): Promise<Map<string, StewardshipView>> {
  const people = await loadUsers(db, rows.flatMap((a) => [a.ownerUserId, a.successorUserId, a.lastReviewedByUserId]));
  const tiers = await highestTierByAgent(db, rows.map((a) => a.id));
  const out = new Map<string, StewardshipView>();
  for (const a of rows) {
    const steward = a.ownerUserId ? people.get(a.ownerUserId) : undefined;
    const successor = a.successorUserId ? people.get(a.successorUserId) : undefined;
    const reviewer = a.lastReviewedByUserId ? people.get(a.lastReviewedByUserId) : undefined;
    const tier = tiers.get(a.id) ?? null;
    out.set(a.id, {
      stewardUserId: a.ownerUserId,
      stewardName: steward?.name ?? null,
      stewardDeactivated: !!steward?.disabled,
      successorUserId: a.successorUserId,
      successorName: successor?.name ?? null,
      successorDeactivated: !!successor?.disabled,
      orphaned: !steward || steward.disabled,
      reviewOverdue: a.lifecycleStatus !== "retired" && !!a.nextReviewAt && a.nextReviewAt.getTime() < now.getTime(),
      nextReviewAt: a.nextReviewAt ? a.nextReviewAt.toISOString() : null,
      lastReviewedAt: a.lastReviewedAt ? a.lastReviewedAt.toISOString() : null,
      lastReviewedByName: reviewer?.name ?? null,
      reviewCadenceMonths: cadenceMonthsFor(tier),
      highestUseCaseTier: tier,
    });
  }
  return out;
}

/** GET /v1/agents row = the registry row + its stewardship view. */
export async function withStewardship(db: Db, rows: AgentRow[]) {
  const views = await stewardshipViews(db, rows);
  return rows.map((a) => ({ ...a, ...views.get(a.id)! }));
}

/**
 * ADR-0180 / ADR-0186 A (B4S-01): moving an agent OUT of `suspended` to any
 * status that dispatches again (everything but `retired`, which is tighter)
 * lifts a protection, so it needs a `settings_relax` step-up bound to the
 * agent and the status it moves to — through either writer (POST
 * /v1/agents/:id/lifecycle or the stewardship PATCH). Null = no step-up.
 */
export function agentUnsuspendStepUp(agentId: string, from: string, to: string): StepUpCheckArgs | null {
  if (from !== "suspended" || to === "suspended" || to === "retired") return null;
  return { kind: "settings_relax", facts: { agentId, values: { lifecycleStatus: to } } };
}

/** admin, or the agent's current steward — anyone else is refused by name */
function mayActAsSteward(req: FastifyRequest, agent: AgentRow): boolean {
  if (req.authCtx.isAdmin) return true;
  return !!req.authCtx.userId && agent.ownerUserId === req.authCtx.userId;
}

function refuseNotSteward(reply: FastifyReply) {
  return reply.status(403).send({
    error: "not_agent_steward",
    detail: "only an admin or this agent's current steward can change its stewardship or record a review",
  });
}

export function registerAgentStewardshipRoutes(app: FastifyInstance, db: Db): void {
  app.patch("/v1/agents/:agentId/stewardship", async (req, reply) => {
    const { agentId } = params.parse(req.params);
    const parsed = setAgentStewardshipSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", issues: parsed.error.issues });
    }
    const body = parsed.data;
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    if (!mayActAsSteward(req, agent)) return refuseNotSteward(reply);
    const isAdmin = !!req.authCtx.isAdmin;

    // --- people: must exist and be active -------------------------------------------------
    const named = await loadUsers(db, [body.stewardUserId ?? null, body.successorUserId ?? null]);
    for (const [field, id] of [
      ["stewardUserId", body.stewardUserId],
      ["successorUserId", body.successorUserId],
    ] as const) {
      if (!id) continue;
      const u = named.get(id);
      if (!u) return reply.status(400).send({ error: "invalid_reference", field });
      if (u.disabled) {
        return reply.status(409).send({
          error: field === "stewardUserId" ? "steward_deactivated" : "successor_deactivated",
          detail: `this account is deactivated — a ${field === "stewardUserId" ? "steward" : "successor"} must be an active user (reactivate them first)`,
        });
      }
    }

    const nextSteward = body.stewardUserId !== undefined ? body.stewardUserId : agent.ownerUserId;
    let nextSuccessor = body.successorUserId !== undefined ? body.successorUserId : agent.successorUserId;
    // the successor stepping up: naming the current successor as steward, without
    // naming a new successor, promotes them and leaves the successor slot empty
    const promoted =
      body.stewardUserId !== undefined &&
      body.successorUserId === undefined &&
      !!nextSteward &&
      nextSteward === agent.successorUserId;
    if (promoted) nextSuccessor = null;
    if (nextSteward && nextSuccessor && nextSteward === nextSuccessor) {
      return reply.status(422).send({
        error: "successor_is_steward",
        detail: "the successor must be a different person from the steward — otherwise nobody takes over when the steward leaves",
      });
    }

    // --- lifecycle -------------------------------------------------------------------------
    const nextStatus = body.lifecycleStatus ?? agent.lifecycleStatus;
    const statusChanges = nextStatus !== agent.lifecycleStatus;
    if (agent.lifecycleStatus === "retired" && statusChanges) {
      return reply.status(409).send({
        error: "agent_retired_terminal",
        detail:
          "retirement is terminal for governance purposes — the decommissioning record cannot be flipped back; register a new agent instead",
      });
    }
    // ADR-0170 item 7: a steward tightens, an admin loosens
    if (!isAdmin && statusChanges && !(STEWARD_LIFECYCLE_MOVES[agent.lifecycleStatus] ?? []).includes(nextStatus)) {
      return refuseAdminRequired(
        reply,
        `a steward can put an agent under review or suspend it; moving it from '${agent.lifecycleStatus}' to '${nextStatus}' needs an admin`,
      );
    }
    let nextReason: string | null;
    if (nextStatus === "active") nextReason = null;
    else if (body.lifecycleReason) nextReason = body.lifecycleReason;
    else if (!statusChanges) nextReason = agent.lifecycleReason;
    else {
      return reply.status(422).send({
        error: "lifecycle_reason_required",
        detail: `moving an agent to '${nextStatus}' requires a reason — it becomes part of the governance record`,
      });
    }

    // --- next review -----------------------------------------------------------------------
    let nextReviewAt = agent.nextReviewAt;
    if (body.nextReviewAt !== undefined) {
      nextReviewAt = body.nextReviewAt === null ? null : new Date(body.nextReviewAt);
      // only a CHANGE is judged: a form re-sending the stored date (an admin may
      // have set it beyond the cadence) is not a steward scheduling it
      const reviewChanges = (nextReviewAt?.getTime() ?? null) !== (agent.nextReviewAt?.getTime() ?? null);
      if (!isAdmin && reviewChanges && nextReviewAt === null) {
        return refuseAdminRequired(reply, "only an admin can clear an agent's next review date");
      }
      if (nextReviewAt && nextReviewAt.getTime() <= Date.now()) {
        return reply.status(422).send({
          error: "next_review_in_past",
          detail: "the next review must be in the future — to record a review that happened, use Record review",
        });
      }
      // ADR-0170 item 7: a steward cannot push the next review past the cadence
      // the agent's riskiest live use case sets (the same cadence the view shows)
      if (!isAdmin && reviewChanges && nextReviewAt) {
        const months = cadenceMonthsFor((await highestTierByAgent(db, [agentId])).get(agentId) ?? null);
        const latest = addMonths(new Date(), months);
        if (nextReviewAt.getTime() > latest.getTime()) {
          return reply.status(422).send({
            error: "next_review_beyond_cadence",
            detail: `this agent is reviewed every ${months} months — a steward can schedule its next review no later than ${latest.toISOString().slice(0, 10)}`,
            cadenceMonths: months,
            latest: latest.toISOString(),
          });
        }
      }
    }

    // --- diff, write, audit ----------------------------------------------------------------
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (nextSteward !== agent.ownerUserId) changes.stewardUserId = { from: agent.ownerUserId, to: nextSteward };
    if (nextSuccessor !== agent.successorUserId) changes.successorUserId = { from: agent.successorUserId, to: nextSuccessor };
    if (statusChanges) changes.lifecycleStatus = { from: agent.lifecycleStatus, to: nextStatus };
    if (nextReason !== agent.lifecycleReason) changes.lifecycleReason = { from: agent.lifecycleReason, to: nextReason };
    if (iso(nextReviewAt) !== iso(agent.nextReviewAt)) {
      changes.nextReviewAt = { from: iso(agent.nextReviewAt), to: iso(nextReviewAt) };
    }
    if (Object.keys(changes).length === 0) {
      const [view] = await withStewardship(db, [agent]);
      return reply.send({ ...view, unchanged: true });
    }

    // ADR-0186 A (B4S-01): a new steward is a new accountable owner — the same
    // `owner_change` step-up POST /v1/agents/:id/owner asks for — and lifting a
    // suspension is a relaxation (`settings_relax`); asked after every refusal
    // above, so a refused request spends no grant
    const stepUps: StepUpCheckArgs[] = [];
    if (changes.stewardUserId) stepUps.push(ownerChangeStepUpArgs("agent", agentId, nextSteward));
    const unsuspend = statusChanges ? agentUnsuspendStepUp(agentId, agent.lifecycleStatus, nextStatus) : null;
    if (unsuspend) stepUps.push(unsuspend);
    if (stepUps.length > 0 && !(await requireStepUps(db, req, reply, stepUps))) return reply;

    const [row] = await db
      .update(agents)
      .set({
        ownerUserId: nextSteward,
        successorUserId: nextSuccessor,
        lifecycleStatus: nextStatus,
        lifecycleReason: nextReason,
        ...(statusChanges ? { lifecycleChangedAt: new Date() } : {}),
        nextReviewAt,
      })
      // ADR-0170 item 7: compare-and-swap on the status this request read — a
      // concurrent retirement or suspension is never overwritten by a stale read
      .where(and(eq(agents.id, agentId), eq(agents.lifecycleStatus, agent.lifecycleStatus)))
      .returning();
    if (!row) return refuseLifecycleChangedConcurrently(reply, agent.lifecycleStatus);
    const people = await loadUsers(db, [nextSteward, nextSuccessor]);
    const label = (id: string | null) => (id ? (people.get(id)?.name ?? id) : "nobody");
    const parts: string[] = [];
    if (changes.stewardUserId) parts.push(`steward ${label(nextSteward)}${promoted ? " (the successor stepped up)" : ""}`);
    if (changes.successorUserId && !promoted) parts.push(`successor ${label(nextSuccessor)}`);
    if (changes.lifecycleStatus) parts.push(`status ${nextStatus}${nextReason ? ` (${nextReason})` : ""}`);
    if (changes.nextReviewAt) parts.push(`next review ${iso(nextReviewAt)?.slice(0, 10) ?? "not scheduled"}`);
    if (parts.length === 0 && changes.lifecycleReason) parts.push(`status reason updated`);
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? SYSTEM_USER,
      objectType: "agent",
      objectId: agentId,
      detail: { phase: "stewardship", changes, actingAs: req.authCtx.isAdmin ? "admin" : "steward", ...(promoted ? { promotedSuccessor: true } : {}) },
      effect: "allow",
      ruleId: "agent-stewardship-updated",
      ruleChain: [],
      reason:
        `agent '${agent.name}' stewardship updated: ${parts.join("; ")}` +
        (nextStatus === "suspended" && statusChanges ? " — dispatch now refuses with 409 agent_suspended" : "") +
        (nextStatus === "retired" && statusChanges ? " — dispatch now refuses with 409 agent_retired; retirement is terminal" : ""),
    });
    const [view] = await withStewardship(db, [row!]);
    return reply.send(view);
  });

  app.post("/v1/agents/:agentId/stewardship/review", async (req, reply) => {
    const { agentId } = params.parse(req.params);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    if (!mayActAsSteward(req, agent)) return refuseNotSteward(reply);
    if (agent.lifecycleStatus === "retired") {
      return reply.status(409).send({
        error: "agent_retired_terminal",
        detail: "a retired agent is out of service for good — there is nothing left to review",
      });
    }
    const now = new Date();
    const tier = (await highestTierByAgent(db, [agentId])).get(agentId) ?? null;
    const months = cadenceMonthsFor(tier);
    const next = addMonths(now, months);
    const [row] = await db
      .update(agents)
      .set({ lastReviewedAt: now, lastReviewedByUserId: req.authCtx.userId ?? null, nextReviewAt: next })
      .where(eq(agents.id, agentId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? SYSTEM_USER,
      objectType: "agent",
      objectId: agentId,
      detail: {
        phase: "stewardship-review",
        reviewedAt: now.toISOString(),
        previousNextReviewAt: agent.nextReviewAt ? agent.nextReviewAt.toISOString() : null,
        nextReviewAt: next.toISOString(),
        cadenceMonths: months,
        highestUseCaseTier: tier,
        actingAs: req.authCtx.isAdmin ? "admin" : "steward",
      },
      effect: "allow",
      ruleId: "agent-stewardship-reviewed",
      ruleChain: [],
      reason:
        `agent '${agent.name}' lifecycle review recorded — next review ${next.toISOString().slice(0, 10)} ` +
        `(every ${months} months: ${tier ? `highest linked use-case tier is ${tier}` : "no screened use case names it"})`,
    });
    const [view] = await withStewardship(db, [row!]);
    return reply.send(view);
  });
}
