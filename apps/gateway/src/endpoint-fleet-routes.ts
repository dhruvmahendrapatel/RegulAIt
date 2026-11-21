/**
 * ADR-0360 slice 1a — ENDPOINT AGENT FLEET OPERATIONS, the admin routes (admin-only: none is in NON_ADMIN_ROUTES; every
 * write audited under the source).
 *
 *   (device groups     ADR-0350's org-wide groups, lane E31's table and routes, reused as the rollout stages; this file
 *                      adds no group concept of its own)
 *   fleet settings     self-update, OFF by default: turning it on is a `settings_relax` step-up bound to the source,
 *                      recorded on the row (a CHECK holds "on" to a recorded relaxation); turning it off is free
 *   update rollouts    one target version over ordered stages (one ADR-0350 group each; a device in several groups is
 *                      offered the update by the first stage that holds it); the lifecycle is the declared table in
 *                      `endpoint-fleet-lifecycle.ts`, and every state write is a guarded UPDATE over its source states,
 *                      so a stale or concurrent write matches no row and is refused (409), never overwriting
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
  endpointEnrolmentTokens,
  endpointFleetSettings,
  endpointUpdateRollouts,
  endpointUpdateRolloutStages,
  eq,
  inArray,
  sql,
  type Db,
  type DiscoverySourceRow,
  type EndpointUpdateRolloutRow,
  type EndpointUpdateRolloutStageRow,
} from "@regulait/db";
import { ENDPOINT_BULK_TOKEN_PREFIX, ENDPOINT_ENROL_FILE_SCHEMA } from "./endpoint-agent.js";
import { ROLLOUT_MACHINE, ROLLOUT_STAGE_MACHINE, describe, sourcesOf, type RolloutEvent, type RolloutState } from "./endpoint-fleet-lifecycle.js";
import { identityIssuer } from "./oauth/common.js";
import { requireStepUp, type StepUpCheckArgs } from "./step-up.js";
import { hashToken } from "./token-hash.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** bounds (secure by default, ADR-0180: each is the strict value, none is a setting) */
export const ROLLOUT_MAX_STAGES = 20;
export const ROLLOUTS_LISTED = 100;
export const ONE_LINE_TOKEN_DEFAULT_MINUTES = 15;
export const ONE_LINE_TOKEN_MAX_MINUTES = 60;

/** ADR-0360 §2: self-update's strict default, and the step-up that relaxes it for one source */
export const FLEET_SETTINGS_STRICT = Object.freeze({ selfUpdate: false });
export const selfUpdateRelaxStepUp = (sourceId: string): StepUpCheckArgs => ({
  kind: "settings_relax",
  facts: { op: "endpoint_fleet_self_update", sourceId, selfUpdate: true },
});

const uuid = z.string().uuid();
const settingsSchema = z.object({ selfUpdate: z.boolean() }).strict();
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

const ROLLOUT_ACTIONS = ["start", "advance", "complete", "pause", "resume", "abort"] as const satisfies readonly RolloutEvent[];
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

async function audit(db: Db, actor: string, sourceId: string, ruleId: string, reason: string, detail: Record<string, unknown>, effect: "allow" | "deny" = "allow", id?: string) {
  await db.insert(auditLog).values({
    ...(id ? { id } : {}),
    userId: actor,
    objectType: "discovery_source",
    objectId: sourceId,
    detail: { subsystem: "endpoint-fleet", adr: "0360", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

/** the source's self-update setting: an absent row is the strict default (off) */
async function selfUpdateOn(db: Db, sourceId: string): Promise<boolean> {
  const [row] = await db.select({ on: endpointFleetSettings.selfUpdate }).from(endpointFleetSettings).where(eq(endpointFleetSettings.sourceId, sourceId));
  return row?.on ?? FLEET_SETTINGS_STRICT.selfUpdate;
}

function rolloutView(r: EndpointUpdateRolloutRow, stages: EndpointUpdateRolloutStageRow[], selfUpdate: boolean) {
  const sorted = [...stages].sort((a, b) => a.ordinal - b.ordinal);
  const active = sorted.find((s) => s.state === "active");
  const last = sorted[sorted.length - 1];
  const blocked: Partial<Record<RolloutEvent, string>> = {};
  if (!selfUpdate) {
    blocked.start = "self-update is off for this source; turn it on first (that asks you to confirm it's you, and is audited)";
    blocked.resume = blocked.start;
  }
  if (active && last && active.ordinal === last.ordinal) blocked.advance = "the active stage is the last one; complete the rollout instead";
  else blocked.complete = "stages remain; advance to the next stage first";
  // `halt` is the system's (a device's failed install); an admin pauses instead
  blocked.halt = "only a device's failed install or rollback halts a rollout; pause it instead";
  return {
    id: r.id,
    sourceId: r.sourceId,
    targetVersion: r.targetVersion,
    state: r.state,
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
    lifecycle: describe(ROLLOUT_MACHINE, r.state as RolloutState, blocked),
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

  // ---- fleet settings (self-update) -----------------------------------------------------------------------------
  const settingsView = async (sourceId: string) => {
    const [row] = await db.select().from(endpointFleetSettings).where(eq(endpointFleetSettings.sourceId, sourceId));
    return { sourceId, selfUpdate: row?.selfUpdate ?? FLEET_SETTINGS_STRICT.selfUpdate, strict: FLEET_SETTINGS_STRICT, updatedAt: row?.updatedAt.toISOString() ?? null };
  };

  app.get("/v1/discovery/sources/:sourceId/fleet-settings", async (req, reply) => {
    const source = await agentSource(reply, param(req, "sourceId"));
    if (!source) return reply;
    return reply.send(await settingsView(source.id));
  });

  app.put("/v1/discovery/sources/:sourceId/fleet-settings", async (req, reply) => {
    const source = await agentSource(reply, param(req, "sourceId"));
    if (!source) return reply;
    const b = settingsSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_request", detail: "send {selfUpdate: boolean}" });
    const current = await selfUpdateOn(db, source.id);
    if (current === b.data.selfUpdate) return reply.send(await settingsView(source.id));
    if (b.data.selfUpdate) {
      // ADR-0360 §2: turning self-update on relaxes the strict default: a fresh step-up bound to this source
      const su = await requireStepUp(db, req, reply, selfUpdateRelaxStepUp(source.id));
      if (!su.ok) return reply;
      await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const auditId = randomUUID();
        await audit(tx, actor(req), source.id, "endpoint-fleet-self-update-relaxed", `self-update turned on for endpoint agent source '${source.id}' (step-up ${su.method}) (ADR-0360)`, { selfUpdate: true, strict: false, relaxation: true, stepUp: su.method }, "allow", auditId);
        const values = { selfUpdate: true, selfUpdateRelaxedBy: req.authCtx.userId ?? null, selfUpdateStepUp: su.method, selfUpdateAuditId: auditId, updatedAt: sql`now()` };
        await tx.insert(endpointFleetSettings).values({ sourceId: source.id, ...values }).onConflictDoUpdate({ target: endpointFleetSettings.sourceId, set: values });
      });
    } else {
      // tightening back to the strict default needs no step-up; directives stop at once (slice 1c reads this row)
      await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        await tx
          .update(endpointFleetSettings)
          .set({ selfUpdate: false, selfUpdateRelaxedBy: null, selfUpdateStepUp: null, selfUpdateAuditId: null, updatedAt: sql`now()` })
          .where(eq(endpointFleetSettings.sourceId, source.id));
        await audit(tx, actor(req), source.id, "endpoint-fleet-self-update-off", `self-update turned off for endpoint agent source '${source.id}' (ADR-0360)`, { selfUpdate: false });
      });
    }
    return reply.send(await settingsView(source.id));
  });

  // ---- update rollouts ------------------------------------------------------------------------------------------
  const loadRollout = async (id: string) => {
    const [r] = await db.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, id));
    if (!r) return null;
    const stages = await db.select().from(endpointUpdateRolloutStages).where(eq(endpointUpdateRolloutStages.rolloutId, id));
    return { r, stages };
  };

  app.get("/v1/discovery/sources/:sourceId/update-rollouts", async (req, reply) => {
    const source = await agentSource(reply, param(req, "sourceId"));
    if (!source) return reply;
    const rows = await db.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.sourceId, source.id)).orderBy(desc(endpointUpdateRollouts.createdAt), desc(endpointUpdateRollouts.id)).limit(ROLLOUTS_LISTED);
    const stages = rows.length ? await db.select().from(endpointUpdateRolloutStages).where(inArray(endpointUpdateRolloutStages.rolloutId, rows.map((r) => r.id))) : [];
    const on = await selfUpdateOn(db, source.id);
    return reply.send({ rollouts: rows.map((r) => rolloutView(r, stages.filter((s) => s.rolloutId === r.id), on)), limit: ROLLOUTS_LISTED });
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
        await audit(tx, actor(req), source.id, "endpoint-update-rollout-created", `update rollout to ${r.targetVersion} created over ${stages.length} stage(s) (ADR-0360)`, { rolloutId: r.id, targetVersion: r.targetVersion, stages: b.data.stages });
        return { r, stages };
      });
      return reply.status(201).send({ rollout: rolloutView(created.r, created.stages, await selfUpdateOn(db, source.id)) });
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
    return reply.send({ rollout: rolloutView(found.r, found.stages, await selfUpdateOn(db, found.r.sourceId)) });
  });

  app.post("/v1/discovery/update-rollouts/:rolloutId/:action", async (req, reply) => {
    const id = param(req, "rolloutId");
    const action = (req.params as Record<string, string>).action as RolloutAction;
    if (!id || !ROLLOUT_ACTIONS.includes(action)) {
      return reply.status(400).send({ error: "invalid_request", detail: `rolloutId must be a uuid and the action one of ${ROLLOUT_ACTIONS.join(", ")}` });
    }
    try {
      const done = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [r] = await tx.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, id)).for("update");
        if (!r) throw new Refusal(404, "not_found", "no such rollout");
        const stages = (await tx.select().from(endpointUpdateRolloutStages).where(eq(endpointUpdateRolloutStages.rolloutId, id)).for("update")).sort((a, b) => a.ordinal - b.ordinal);
        const on = await selfUpdateOn(tx, r.sourceId);
        const view = rolloutView(r, stages, on).lifecycle.transitions.find((t) => t.event === action)!;
        if (!view.allowed) throw new Refusal(409, ROLLOUT_MACHINE.transitions[action].from.includes(r.state as RolloutState) ? "transition_blocked" : "illegal_transition", view.reason ?? "not allowed now");
        const to = ROLLOUT_MACHINE.transitions[action].to;
        // the guarded write: only from the declared source states (a concurrent write matches no row)
        const moved = await tx
          .update(endpointUpdateRollouts)
          .set({ state: to, updatedAt: sql`now()` })
          .where(and(eq(endpointUpdateRollouts.id, id), inArray(endpointUpdateRollouts.state, sourcesOf(ROLLOUT_MACHINE, action))))
          .returning();
        if (moved.length === 0) throw new Refusal(409, "changed_concurrently", "the rollout changed while this was decided; read it again");
        const stageMove = async (ordinal: number, event: "activate" | "finish") =>
          tx
            .update(endpointUpdateRolloutStages)
            .set(event === "activate" ? { state: "active", startedAt: sql`now()` } : { state: "done", completedAt: sql`now()` })
            .where(and(eq(endpointUpdateRolloutStages.rolloutId, id), eq(endpointUpdateRolloutStages.ordinal, ordinal), inArray(endpointUpdateRolloutStages.state, sourcesOf(ROLLOUT_STAGE_MACHINE, event))));
        const active = stages.find((s) => s.state === "active");
        if (action === "start") await stageMove(stages[0]!.ordinal, "activate");
        if (action === "advance" && active) {
          await stageMove(active.ordinal, "finish");
          await stageMove(stages.find((s) => s.ordinal > active.ordinal)!.ordinal, "activate");
        }
        if (action === "complete" && active) await stageMove(active.ordinal, "finish");
        await audit(tx, actor(req), r.sourceId, `endpoint-update-rollout-${action}`, `update rollout to ${r.targetVersion}: ${action} (${r.state} → ${to}) (ADR-0360)`, { rolloutId: id, event: action, from: r.state, to, activeStage: active?.ordinal ?? null });
        return r.sourceId;
      });
      const found = await loadRollout(id);
      return reply.send({ rollout: rolloutView(found!.r, found!.stages, await selfUpdateOn(db, done)) });
    } catch (e) {
      if (e instanceof Refusal) return send(reply, e);
      throw e;
    }
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
      await audit(tx, actor(req), source.id, "endpoint-one-line-enrolment-issued", `one-line enrolment token '${inserted!.label}' issued for one device until ${inserted!.expiresAt.toISOString()} (ADR-0360)`, {
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
