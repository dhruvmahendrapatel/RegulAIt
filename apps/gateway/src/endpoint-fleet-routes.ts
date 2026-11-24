/**
 * ADR-0360 slice 1a — ENDPOINT AGENT FLEET OPERATIONS, the admin routes (admin-only: none is in NON_ADMIN_ROUTES; every
 * write audited under the source, or under the device group for its fleet settings).
 *
 *   (device groups     ADR-0350's org-wide groups, lane E31's table and routes, reused as the rollout stages; this file
 *                      adds no group concept of its own)
 *   fleet settings     self-update per ADR-0350 device group (owner decision D-2026-11-22-04), OFF by default:
 *                      turning it on is a `settings_relax` step-up bound to the group, recorded on the row (a CHECK
 *                      holds "on" to a recorded relaxation); turning it off is free. A rollout starts or resumes only
 *                      when every stage's group has it on
 *   halt threshold     the failed installs or rollbacks that halt a rollout (D-2026-11-22-04): strict default 1,
 *                      bounded 1 to 10; lowering it is free, raising it is a `settings_relax` step-up; both audited
 *   update rollouts    one target version over ordered stages (one ADR-0350 group each; a device in several groups is
 *                      offered the update by the first stage that holds it); the lifecycles are ADR-0348 machines
 *                      (ENDPOINT_ROLLOUT_MACHINE, ENDPOINT_ROLLOUT_STAGE_MACHINE in @regulait/shared, registered in
 *                      STATE_MACHINES), and every state write is guarded with `whereFrom`, so a stale or concurrent
 *                      write matches no row and is refused (409), never overwriting
 *   one-line enrolment a single-use (device cap 1), short-lived (15 minutes by default, at most 60), source-scoped
 *                      enrolment token, optionally placing the device in one ADR-0350 group (a group only narrows a
 *                      device's policy, so joining one is never a relaxation). Only its SHA-256 is kept; no audit
 *                      row, log line or later read carries the secret
 *
 * The device side (the signed directive, the release download route, update results) is slice 1c.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  and,
  auditLog,
  desc,
  discoverySources,
  endpointDeviceGroups,
  endpointDeviceGroupFleetSettings,
  endpointEnrolmentTokens,
  endpointUpdateRollouts,
  endpointUpdateRolloutStages,
  eq,
  inArray,
  sql,
  type Db,
  type DiscoverySourceRow,
  type EndpointDeviceGroupRow,
  type EndpointUpdateRolloutRow,
  type EndpointUpdateRolloutStageRow,
} from "@regulait/db";
import { ENDPOINT_BULK_TOKEN_PREFIX, ENDPOINT_ENROL_FILE_SCHEMA } from "./endpoint-agent.js";
import {
  ENDPOINT_ROLLOUT_HALT_THRESHOLD as HALT_THRESHOLD,
  ENDPOINT_ROLLOUT_MACHINE as ROLLOUT_MACHINE,
  ENDPOINT_ROLLOUT_STAGE_MACHINE as ROLLOUT_STAGE_MACHINE,
  type EndpointRolloutEvent as RolloutEvent,
  type EndpointRolloutState as RolloutState,
} from "@regulait/shared";
import type { ListSpec } from "./list-contract.js";
import { answerListPage, type ContractList } from "./list-contract-route.js";
import { whereFrom } from "./state-transition.js";
import { identityIssuer } from "./oauth/common.js";
import { requireStepUp, type StepUpCheckArgs } from "./step-up.js";
import { hashToken } from "./token-hash.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** bounds (secure by default, ADR-0180: each is the strict value, none is a setting) */
export const ROLLOUT_MAX_STAGES = 20;
export const ONE_LINE_TOKEN_DEFAULT_MINUTES = 15;
export const ONE_LINE_TOKEN_MAX_MINUTES = 60;

/** ADR-0360 §2: self-update's strict default, and the step-up that relaxes it for one device group */
export const FLEET_SETTINGS_STRICT = Object.freeze({ selfUpdate: false });
export const selfUpdateRelaxStepUp = (groupId: string): StepUpCheckArgs => ({
  kind: "settings_relax",
  facts: { op: "endpoint_fleet_self_update", groupId, selfUpdate: true },
});
/** ADR-0360 §3: raising one rollout's halt threshold is a relaxation, bound to the rollout and the new value */
export const haltThresholdRelaxStepUp = (rolloutId: string, haltThreshold: number): StepUpCheckArgs => ({
  kind: "settings_relax",
  facts: { op: "endpoint_rollout_halt_threshold", rolloutId, haltThreshold },
});

/** ADR-0226: a source's rollouts, newest first (the keyset cursor on created_at) */
const ROLLOUTS_LIST: ListSpec<{ id: string; targetVersion: string; state: string; createdAt: string }> = {
  id: "endpoint-update-rollouts",
  sorts: { created: { expr: endpointUpdateRollouts.createdAt, keysetAt: endpointUpdateRollouts.createdAt } },
  columns: {
    targetVersion: { label: "Target version", value: (r) => r.targetVersion },
    state: { label: "State", value: (r) => r.state },
    created: { label: "Created", value: (r) => r.createdAt },
  },
  filters: [],
  defaultSort: { col: "created", dir: "desc" },
  idCol: endpointUpdateRollouts.id,
};

const uuid = z.string().uuid();
const settingsSchema = z.object({ selfUpdate: z.boolean() }).strict();
const haltThresholdSchema = z.object({ haltThreshold: z.number().int().min(HALT_THRESHOLD.min).max(HALT_THRESHOLD.max) }).strict();
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]{1,32})?$/;
const rolloutSchema = z
  .object({
    targetVersion: z.string().regex(SEMVER),
    stages: z.array(uuid).min(1).max(ROLLOUT_MAX_STAGES),
  })
  .strict()
  .refine((b) => new Set(b.stages).size === b.stages.length, { message: "a group is named twice" });
const oneLineSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    expiresInMinutes: z.number().int().min(1).max(ONE_LINE_TOKEN_MAX_MINUTES).default(ONE_LINE_TOKEN_DEFAULT_MINUTES),
    deviceGroupId: uuid.optional(),
  })
  .strict();

/** every admin event of the rollout machine; the system's (halt, expire_start, expire_resume) are never a route */
const ROLLOUT_ACTIONS = ["request_start", "approve_start", "reject_start", "advance", "complete", "pause", "request_resume", "approve_resume", "reject_resume", "abort"] as const satisfies readonly RolloutEvent[];
const ROLLOUT_DECISIONS: readonly RolloutAction[] = ["approve_start", "reject_start", "approve_resume", "reject_resume"];
/** slice 1c (review lessons of #979): a start or resume is decided by a second admin with a step-up bound to it */
export const rolloutDecisionStepUp = (rolloutId: string, decision: "approve_start" | "reject_start" | "approve_resume" | "reject_resume"): StepUpCheckArgs => ({
  kind: "approval_decide",
  facts: { op: "endpoint_update_rollout", rolloutId, decision },
});
type RolloutAction = (typeof ROLLOUT_ACTIONS)[number];

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(code);
  }
}

type AuditObject = { type: "discovery_source" | "endpoint_device_group"; id: string };

async function audit(db: Db, actor: string, object: AuditObject, ruleId: string, reason: string, detail: Record<string, unknown>, effect: "allow" | "deny" = "allow", id?: string) {
  await db.insert(auditLog).values({
    ...(id ? { id } : {}),
    userId: actor,
    objectType: object.type,
    objectId: object.id,
    detail: { subsystem: "endpoint-fleet", adr: "0360", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

/** the group ids among `groupIds` whose self-update is on (an absent row is the strict default, off) */
async function selfUpdateOnGroups(db: Db, groupIds: readonly (string | null)[]): Promise<Set<string>> {
  const ids = [...new Set(groupIds.filter((g): g is string => g !== null))];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: endpointDeviceGroupFleetSettings.groupId })
    .from(endpointDeviceGroupFleetSettings)
    .where(and(inArray(endpointDeviceGroupFleetSettings.groupId, ids), eq(endpointDeviceGroupFleetSettings.selfUpdate, true)));
  return new Set(rows.map((x) => x.id));
}

/**
 * `viewer`: the calling admin's user id, null for a caller with no person behind it (the bootstrap credential, a key),
 * or undefined where the view is not answered to one caller (the list's shared reader shows no person-based block).
 */
function rolloutView(r: EndpointUpdateRolloutRow, stages: EndpointUpdateRolloutStageRow[], onGroups: Set<string>, viewer?: string | null) {
  const sorted = [...stages].sort((a, b) => a.ordinal - b.ordinal);
  const active = sorted.find((s) => s.state === "active");
  const last = sorted[sorted.length - 1];
  const blocked: Partial<Record<RolloutEvent, string>> = {};
  // a stage whose group was deleted offers the update to no device, so only live groups must have self-update on
  const off = sorted.filter((s) => s.groupId !== null && !onGroups.has(s.groupId)).map((s) => `'${s.groupName}'`);
  if (off.length > 0) {
    const why = `self-update is off for device group${off.length > 1 ? "s" : ""} ${off.join(", ")}; turn it on for each first (that asks you to confirm it's you, and is audited)`;
    blocked.request_start = blocked.approve_start = blocked.request_resume = blocked.approve_resume = why;
  }
  if (active && last && active.ordinal === last.ordinal) blocked.advance = "the active stage is the last one; complete the rollout instead";
  else blocked.complete = "stages remain; advance to the next stage first";
  // `halt` is the system's (failed installs reaching the halt threshold); an admin pauses instead
  blocked.halt = "only failed installs or rollbacks reaching the halt threshold halt a rollout; pause it instead";
  blocked.expire_start = blocked.expire_resume = "a start or resume nobody decides expires on its own";
  // two people (review lessons of #979): a person asks, a different person decides
  if (!r.approvalRequestedBy) for (const e of ROLLOUT_DECISIONS) blocked[e] = "the request has no named requester";
  if (viewer && viewer === r.approvalRequestedBy) for (const e of ROLLOUT_DECISIONS) blocked[e] = "the requester cannot decide their own request";
  if (viewer === null) for (const e of ROLLOUT_ACTIONS) blocked[e] = "this needs a signed-in admin";
  return {
    id: r.id,
    sourceId: r.sourceId,
    targetVersion: r.targetVersion,
    state: r.state,
    haltThreshold: { value: r.haltThreshold, ...HALT_THRESHOLD },
    approval: { requestedBy: r.approvalRequestedBy, requestedAt: r.approvalRequestedAt?.toISOString() ?? null, decidedBy: r.approvalDecidedBy },
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    stages: sorted.map((s) => ({
      ordinal: s.ordinal,
      // null once the ADR-0350 group was deleted: the stage then offers the update to no device
      groupId: s.groupId,
      groupName: s.groupName,
      state: s.state,
      startedAt: s.startedAt?.toISOString() ?? null,
      completedAt: s.completedAt?.toISOString() ?? null,
    })),
    lifecycle: ROLLOUT_MACHINE.describe(r.state as RolloutState, blocked),
  };
}

export function registerEndpointFleetRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;
  const send = (reply: FastifyReply, e: Refusal) => reply.status(e.status).send({ error: e.code, detail: e.detail });
  const param = (req: FastifyRequest, name: string): string | null => {
    const v = (req.params as Record<string, unknown>)[name];
    return uuid.safeParse(v).success ? (v as string) : null;
  };
  /** the endpoint-agent source the route names, or the refusal already sent */
  const agentSource = async (reply: FastifyReply, sourceId: string | null): Promise<DiscoverySourceRow | null> => {
    if (!sourceId) {
      await reply.status(400).send({ error: "invalid_request", detail: "sourceId must be a uuid" });
      return null;
    }
    const [source] = await db.select().from(discoverySources).where(eq(discoverySources.id, sourceId));
    if (!source) {
      await reply.status(404).send({ error: "not_found", detail: "no such discovery source" });
      return null;
    }
    if (source.kind !== "endpoint_agent") {
      await reply.status(409).send({ error: "not_an_agent_source", detail: "fleet settings, rollouts and one-line enrolments belong to an endpoint agent source" });
      return null;
    }
    return source;
  };

  // ---- fleet settings (self-update, per ADR-0350 device group) ---------------------------------------------------
  /** the device group the route names, or the refusal already sent */
  const deviceGroup = async (reply: FastifyReply, groupId: string | null): Promise<EndpointDeviceGroupRow | null> => {
    if (!groupId) {
      await reply.status(400).send({ error: "invalid_request", detail: "groupId must be a uuid" });
      return null;
    }
    const [group] = await db.select().from(endpointDeviceGroups).where(eq(endpointDeviceGroups.id, groupId));
    if (!group) {
      await reply.status(404).send({ error: "not_found", detail: "no such device group" });
      return null;
    }
    return group;
  };
  const settingsView = async (group: EndpointDeviceGroupRow) => {
    const [row] = await db.select().from(endpointDeviceGroupFleetSettings).where(eq(endpointDeviceGroupFleetSettings.groupId, group.id));
    return { groupId: group.id, groupName: group.name, selfUpdate: row?.selfUpdate ?? FLEET_SETTINGS_STRICT.selfUpdate, strict: FLEET_SETTINGS_STRICT, updatedAt: row?.updatedAt.toISOString() ?? null };
  };

  app.get("/v1/endpoint-device-groups/:groupId/fleet-settings", async (req, reply) => {
    const group = await deviceGroup(reply, param(req, "groupId"));
    if (!group) return reply;
    return reply.send(await settingsView(group));
  });

  app.put("/v1/endpoint-device-groups/:groupId/fleet-settings", async (req, reply) => {
    const group = await deviceGroup(reply, param(req, "groupId"));
    if (!group) return reply;
    const b = settingsSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_request", detail: "send {selfUpdate: boolean}" });
    const current = (await selfUpdateOnGroups(db, [group.id])).has(group.id);
    if (current === b.data.selfUpdate) return reply.send(await settingsView(group));
    const object: AuditObject = { type: "endpoint_device_group", id: group.id };
    if (b.data.selfUpdate) {
      // ADR-0360 §2: turning self-update on relaxes the strict default: a fresh step-up bound to this group
      const su = await requireStepUp(db, req, reply, selfUpdateRelaxStepUp(group.id));
      if (!su.ok) return reply;
      await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const auditId = randomUUID();
        await audit(tx, actor(req), object, "endpoint-fleet-self-update-relaxed", `self-update turned on for endpoint device group '${group.name}' (step-up ${su.method}) (ADR-0360)`, { groupId: group.id, selfUpdate: true, strict: false, relaxation: true, stepUp: su.method }, "allow", auditId);
        const values = { selfUpdate: true, selfUpdateRelaxedBy: req.authCtx.userId ?? null, selfUpdateStepUp: su.method, selfUpdateAuditId: auditId, updatedAt: sql`now()` };
        await tx.insert(endpointDeviceGroupFleetSettings).values({ groupId: group.id, ...values }).onConflictDoUpdate({ target: endpointDeviceGroupFleetSettings.groupId, set: values });
      });
    } else {
      // tightening back to the strict default needs no step-up; directives stop at once (slice 1c reads this row)
      await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        await tx
          .update(endpointDeviceGroupFleetSettings)
          .set({ selfUpdate: false, selfUpdateRelaxedBy: null, selfUpdateStepUp: null, selfUpdateAuditId: null, updatedAt: sql`now()` })
          .where(eq(endpointDeviceGroupFleetSettings.groupId, group.id));
        await audit(tx, actor(req), object, "endpoint-fleet-self-update-off", `self-update turned off for endpoint device group '${group.name}' (ADR-0360)`, { groupId: group.id, selfUpdate: false });
      });
    }
    return reply.send(await settingsView(group));
  });

  // ---- update rollouts ------------------------------------------------------------------------------------------
  const loadRollout = async (id: string) => {
    const [r] = await db.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, id));
    if (!r) return null;
    const stages = await db.select().from(endpointUpdateRolloutStages).where(eq(endpointUpdateRolloutStages.rolloutId, id));
    return { r, stages };
  };

  // ADR-0226: the rollouts are evidence, so the list pages (keyset on created_at) rather than stopping at a fixed count
  const rolloutsList: ContractList<ReturnType<typeof rolloutView> & { _cursorAt?: unknown }, Record<string, never>> = {
    spec: ROLLOUTS_LIST,
    filters: z.object({}).strict(),
    reader: {
      fetch: async (q) => {
        const rows = await db.select({ r: endpointUpdateRollouts, _cursorAt: q.cursorAt }).from(endpointUpdateRollouts).where(q.where).orderBy(...q.orderBy).limit(q.limit).offset(q.offset);
        if (rows.length === 0) return [];
        const ids = rows.map((x) => x.r.id);
        const stages = await db.select().from(endpointUpdateRolloutStages).where(inArray(endpointUpdateRolloutStages.rolloutId, ids));
        const on = await selfUpdateOnGroups(db, stages.map((st) => st.groupId));
        return rows.map((x) => ({ ...rolloutView(x.r, stages.filter((st) => st.rolloutId === x.r.id), on), _cursorAt: x._cursorAt }));
      },
      countable: (where) => db.select({ one: sql`1` }).from(endpointUpdateRollouts).where(where),
      idOf: (r) => r.id,
    },
    where: (req) => eq(endpointUpdateRollouts.sourceId, (req.params as { sourceId: string }).sourceId),
  };

  app.get("/v1/discovery/sources/:sourceId/update-rollouts", async (req, reply) => {
    const source = await agentSource(reply, param(req, "sourceId"));
    if (!source) return reply;
    return answerListPage(db, req, reply, rolloutsList);
  });

  app.post("/v1/discovery/sources/:sourceId/update-rollouts", async (req, reply) => {
    const source = await agentSource(reply, param(req, "sourceId"));
    if (!source) return reply;
    const b = rolloutSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_request", detail: `send {targetVersion (x.y.z), stages: [groupId] (1 to ${ROLLOUT_MAX_STAGES}, each once)}` });
    try {
      const created = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        // ADR-0350 groups are org-wide; a stage offers the update to the members that are this source's devices
        const groups = await tx.select({ id: endpointDeviceGroups.id, name: endpointDeviceGroups.name }).from(endpointDeviceGroups).where(inArray(endpointDeviceGroups.id, b.data.stages));
        if (groups.length !== b.data.stages.length) throw new Refusal(409, "group_not_found", "every stage must name an existing device group");
        const nameOf = new Map(groups.map((g) => [g.id, g.name]));
        const [open] = await tx.select({ id: endpointUpdateRollouts.id }).from(endpointUpdateRollouts).where(and(eq(endpointUpdateRollouts.sourceId, source.id), sql`${endpointUpdateRollouts.state} NOT IN ('completed', 'aborted')`));
        if (open) throw new Refusal(409, "rollout_open", "this source already has an open rollout; complete or abort it first");
        const inserted = await tx
          .insert(endpointUpdateRollouts)
          .values({ sourceId: source.id, targetVersion: b.data.targetVersion, createdBy: req.authCtx.userId ?? null })
          .onConflictDoNothing()
          .returning();
        // the partial unique index is the backstop for two concurrent creates
        if (inserted.length === 0) throw new Refusal(409, "rollout_open", "this source already has an open rollout; complete or abort it first");
        const r = inserted[0]!;
        const stages = await tx
          .insert(endpointUpdateRolloutStages)
          .values(b.data.stages.map((groupId, i) => ({ rolloutId: r.id, ordinal: i + 1, groupId, groupName: nameOf.get(groupId)! })))
          .returning();
        await audit(tx, actor(req), { type: "discovery_source", id: source.id }, "endpoint-update-rollout-created", `update rollout to ${r.targetVersion} created over ${stages.length} stage(s) (ADR-0360)`, { rolloutId: r.id, targetVersion: r.targetVersion, stages: b.data.stages });
        return { r, stages };
      });
      return reply.status(201).send({ rollout: rolloutView(created.r, created.stages, await selfUpdateOnGroups(db, created.stages.map((st) => st.groupId)), req.authCtx.userId ?? null) });
    } catch (e) {
      if (e instanceof Refusal) return send(reply, e);
      throw e;
    }
  });

  app.get("/v1/discovery/update-rollouts/:rolloutId", async (req, reply) => {
    const id = param(req, "rolloutId");
    if (!id) return reply.status(400).send({ error: "invalid_request", detail: "rolloutId must be a uuid" });
    const found = await loadRollout(id);
    if (!found) return reply.status(404).send({ error: "not_found", detail: "no such rollout" });
    return reply.send({ rollout: rolloutView(found.r, found.stages, await selfUpdateOnGroups(db, found.stages.map((st) => st.groupId)), req.authCtx.userId ?? null) });
  });

  app.post("/v1/discovery/update-rollouts/:rolloutId/:action", async (req, reply) => {
    const id = param(req, "rolloutId");
    const action = (req.params as Record<string, string>).action as RolloutAction;
    if (!id || !ROLLOUT_ACTIONS.includes(action)) {
      return reply.status(400).send({ error: "invalid_request", detail: `rolloutId must be a uuid and the action one of ${ROLLOUT_ACTIONS.join(", ")}` });
    }
    // two people (review lessons of #979): every rollout action is a person's, so a request and its decision can be
    // compared; the bootstrap credential and keys have no person behind them
    const me = req.authCtx.userId ?? null;
    if (!me) return reply.status(403).send({ error: "user_required", detail: "a rollout is driven by signed-in admins; the bootstrap credential and keys cannot" });
    const decision = ROLLOUT_DECISIONS.includes(action) ? (action as "approve_start" | "reject_start" | "approve_resume" | "reject_resume") : null;
    if (decision) {
      // the requester cannot decide, checked before the step-up is spent (and again under the row lock below)
      const pre = await loadRollout(id);
      if (!pre) return reply.status(404).send({ error: "not_found", detail: "no such rollout" });
      const preView = rolloutView(pre.r, pre.stages, await selfUpdateOnGroups(db, pre.stages.map((st) => st.groupId)), me).lifecycle.transitions.find((t) => t.event === action)!;
      if (!preView.allowed) {
        const legal = ROLLOUT_MACHINE.can(pre.r.state as RolloutState, action);
        return reply.status(legal ? (pre.r.approvalRequestedBy === me ? 403 : 409) : 409).send({ error: legal ? (pre.r.approvalRequestedBy === me ? "caller_cannot_decide" : "transition_blocked") : "illegal_transition", detail: preView.reason ?? "not allowed now" });
      }
      const su = await requireStepUp(db, req, reply, rolloutDecisionStepUp(id, decision));
      if (!su.ok) return reply;
    }
    try {
      await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [r] = await tx.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, id)).for("update");
        if (!r) throw new Refusal(404, "not_found", "no such rollout");
        const stages = (await tx.select().from(endpointUpdateRolloutStages).where(eq(endpointUpdateRolloutStages.rolloutId, id)).for("update")).sort((a, b) => a.ordinal - b.ordinal);
        // start and resume need every live stage group's self-update on; slice 1c also reads the group's setting each time
        // it offers the update, so a group turned off afterwards stops being offered it at once
        const on = await selfUpdateOnGroups(tx, stages.map((st) => st.groupId));
        const view = rolloutView(r, stages, on, me).lifecycle.transitions.find((t) => t.event === action)!;
        if (!view.allowed) throw new Refusal(409, ROLLOUT_MACHINE.can(r.state as RolloutState, action) ? "transition_blocked" : "illegal_transition", view.reason ?? "not allowed now");
        const to = ROLLOUT_MACHINE.next(r.state as RolloutState, action);
        // the guarded write: only from the declared source states (a concurrent write matches no row)
        const people =
          action === "request_start" || action === "request_resume"
            ? { approvalRequestedBy: me, approvalRequestedAt: sql`now()`, approvalDecidedBy: null }
            : decision
              ? { approvalDecidedBy: me }
              : {};
        const moved = await tx
          .update(endpointUpdateRollouts)
          .set({ state: to, ...people, updatedAt: sql`now()` })
          .where(and(eq(endpointUpdateRollouts.id, id), whereFrom(endpointUpdateRollouts.state, ROLLOUT_MACHINE, action)))
          .returning();
        if (moved.length === 0) throw new Refusal(409, "changed_concurrently", "the rollout changed while this was decided; read it again");
        const stageMove = async (ordinal: number, event: "activate" | "finish") => {
          const to = ROLLOUT_STAGE_MACHINE.def.transitions[event].to;
          const rows = await tx
            .update(endpointUpdateRolloutStages)
            .set(to === "active" ? { state: to, startedAt: sql`now()` } : { state: to, completedAt: sql`now()` })
            .where(and(eq(endpointUpdateRolloutStages.rolloutId, id), eq(endpointUpdateRolloutStages.ordinal, ordinal), whereFrom(endpointUpdateRolloutStages.state, ROLLOUT_STAGE_MACHINE, event)))
            .returning({ ordinal: endpointUpdateRolloutStages.ordinal });
          // the stage rows are locked FOR UPDATE above, so a miss is a broken invariant: roll the whole move back
          if (rows.length === 0) throw new Refusal(409, "changed_concurrently", "a stage changed while this was decided; read the rollout again");
        };
        const active = stages.find((s) => s.state === "active");
        if (action === "approve_start") await stageMove(stages[0]!.ordinal, "activate");
        if (action === "advance" && active) {
          await stageMove(active.ordinal, "finish");
          await stageMove(stages.find((s) => s.ordinal > active.ordinal)!.ordinal, "activate");
        }
        if (action === "complete" && active) await stageMove(active.ordinal, "finish");
        await audit(tx, actor(req), { type: "discovery_source", id: r.sourceId }, `endpoint-update-rollout-${action.replaceAll("_", "-")}`, `update rollout to ${r.targetVersion}: ${action} (${r.state} → ${to}) (ADR-0360)`, { rolloutId: id, event: action, from: r.state, to, activeStage: active?.ordinal ?? null, ...(decision ? { requestedBy: r.approvalRequestedBy } : {}) });
      });
      const found = await loadRollout(id);
      return reply.send({ rollout: rolloutView(found!.r, found!.stages, await selfUpdateOnGroups(db, found!.stages.map((st) => st.groupId)), req.authCtx.userId ?? null) });
    } catch (e) {
      if (e instanceof Refusal) return send(reply, e);
      throw e;
    }
  });

  // ---- halt threshold (D-2026-11-22-04: configurable but bounded) ----------------------------------------------
  app.put("/v1/discovery/update-rollouts/:rolloutId/halt-threshold", async (req, reply) => {
    const id = param(req, "rolloutId");
    if (!id) return reply.status(400).send({ error: "invalid_request", detail: "rolloutId must be a uuid" });
    const b = haltThresholdSchema.safeParse(req.body ?? {});
    if (!b.success) {
      return reply.status(400).send({ error: "invalid_request", detail: `send {haltThreshold}: a whole number from ${HALT_THRESHOLD.min} to ${HALT_THRESHOLD.max} (strict default ${HALT_THRESHOLD.strict})` });
    }
    const want = b.data.haltThreshold;
    const [current] = await db.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, id));
    if (!current) return reply.status(404).send({ error: "not_found", detail: "no such rollout" });
    const terminal = ROLLOUT_MACHINE.def.terminal as readonly string[];
    if (terminal.includes(current.state)) return reply.status(409).send({ error: "rollout_closed", detail: `the rollout is ${current.state}; its halt threshold no longer applies` });
    // raising the threshold lets more devices fail before the update stops: a relaxation, so a fresh step-up bound to
    // this rollout and the new value; lowering it is a tightening and needs none
    const loosening = want > current.haltThreshold;
    let stepUp: string | null = null;
    if (loosening) {
      const su = await requireStepUp(db, req, reply, haltThresholdRelaxStepUp(id, want));
      if (!su.ok) return reply;
      stepUp = su.method;
    }
    try {
      await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [r] = await tx.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, id)).for("update");
        if (!r) throw new Refusal(404, "not_found", "no such rollout");
        if (terminal.includes(r.state)) throw new Refusal(409, "rollout_closed", `the rollout is ${r.state}; its halt threshold no longer applies`);
        // the step-up was bound to the value read before the lock: a concurrent change makes it a different decision
        if (r.haltThreshold !== current.haltThreshold) throw new Refusal(409, "changed_concurrently", "the halt threshold changed while this was decided; read the rollout again");
        if (r.haltThreshold === want) return;
        const auditId = randomUUID();
        await audit(
          tx,
          actor(req),
          { type: "discovery_source", id: r.sourceId },
          loosening ? "endpoint-update-rollout-halt-threshold-relaxed" : "endpoint-update-rollout-halt-threshold-tightened",
          `update rollout to ${r.targetVersion}: halt threshold ${r.haltThreshold} → ${want}${loosening ? ` (step-up ${stepUp})` : ""} (ADR-0360)`,
          { rolloutId: id, from: r.haltThreshold, to: want, strict: HALT_THRESHOLD.strict, max: HALT_THRESHOLD.max, relaxation: loosening, ...(stepUp ? { stepUp } : {}) },
          "allow",
          auditId,
        );
        // back at the strict default the relaxation evidence is cleared; a tightening that stays above it keeps the
        // evidence of the loosening it narrows
        const evidence =
          want === HALT_THRESHOLD.strict
            ? { haltThresholdStepUp: null, haltThresholdAuditId: null }
            : loosening
              ? { haltThresholdStepUp: stepUp, haltThresholdAuditId: auditId }
              : {};
        await tx.update(endpointUpdateRollouts).set({ haltThreshold: want, ...evidence, updatedAt: sql`now()` }).where(eq(endpointUpdateRollouts.id, id));
      });
    } catch (e) {
      if (e instanceof Refusal) return send(reply, e);
      throw e;
    }
    const found = await loadRollout(id);
    return reply.send({ rollout: rolloutView(found!.r, found!.stages, await selfUpdateOnGroups(db, found!.stages.map((st) => st.groupId)), req.authCtx.userId ?? null) });
  });

  // ---- one-line enrolment ---------------------------------------------------------------------------------------
  app.post("/v1/discovery/sources/:sourceId/one-line-enrolments", async (req, reply) => {
    const source = await agentSource(reply, param(req, "sourceId"));
    if (!source) return reply;
    if (!source.enabled) return reply.status(409).send({ error: "source_disabled", detail: "enable this source first (that asks you to confirm it's you, and is audited)" });
    const b = oneLineSchema.safeParse(req.body ?? {});
    if (!b.success) {
      return reply.status(400).send({ error: "invalid_request", detail: `send {label, expiresInMinutes (1 to ${ONE_LINE_TOKEN_MAX_MINUTES}, default ${ONE_LINE_TOKEN_DEFAULT_MINUTES}), deviceGroupId?}` });
    }
    const issuer = identityIssuer();
    if (!issuer) return reply.status(503).send({ error: "issuer_not_configured", detail: "the gateway's public URL is not configured, so agents could not reach it" });
    if (b.data.deviceGroupId) {
      const [g] = await db.select({ id: endpointDeviceGroups.id }).from(endpointDeviceGroups).where(eq(endpointDeviceGroups.id, b.data.deviceGroupId));
      if (!g) return reply.status(409).send({ error: "group_not_found", detail: "no such device group" });
    }
    const secret = ENDPOINT_BULK_TOKEN_PREFIX + randomBytes(32).toString("hex");
    const row = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [inserted] = await tx
        .insert(endpointEnrolmentTokens)
        .values({
          sourceId: source.id,
          label: b.data.label,
          tokenHash: hashToken(secret),
          deviceCap: 1,
          singleUse: true,
          deviceGroupId: b.data.deviceGroupId ?? null,
          createdBy: req.authCtx.userId ?? null,
          expiresAt: sql`now() + make_interval(mins => ${b.data.expiresInMinutes})`,
        })
        .returning();
      // the token id only: the secret is in no audit row, log line or later read
      await audit(tx, actor(req), { type: "discovery_source", id: source.id }, "endpoint-one-line-enrolment-issued", `one-line enrolment token '${inserted!.label}' issued for one device until ${inserted!.expiresAt.toISOString()} (ADR-0360)`, {
        tokenId: inserted!.id,
        deviceGroupId: inserted!.deviceGroupId,
        expiresAt: inserted!.expiresAt.toISOString(),
      });
      return inserted!;
    });
    reply.header("cache-control", "no-store");
    return reply.status(201).send({
      token: { id: row.id, label: row.label, singleUse: true, deviceGroupId: row.deviceGroupId, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() },
      enrolment: {
        schema: ENDPOINT_ENROL_FILE_SCHEMA,
        issuer,
        token: secret,
        expiresAt: row.expiresAt.toISOString(),
        // the token goes on standard input (`printf` is a shell builtin, so it is in no process list); run as root
        command: `printf '%s\\n' '${secret}' | sudo regulait-agent enrol`,
      },
    });
  });
}
