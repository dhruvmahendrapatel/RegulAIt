/**
 * ADR-0124 — the operator's side of the kill switch.
 *
 * Six routes, three scopes, one idea: an emergency control is only worth
 * having if throwing it is fast, lifting it is possible, and both are on the
 * record.
 *
 *   GET  /v1/execution                          what is stopped right now
 *   PUT  /v1/execution/mode                     the deployment dial
 *   POST /v1/agents/:agentId/halt   + /unhalt   one agent
 *   POST /v1/servers/:serverId/tools/:toolName/halt + /unhalt   one tool
 *
 * FIVE RULES THIS FILE KEEPS, AND WHY.
 *
 * 1. A REASON IS REQUIRED TO RESTRICT, AND TO LIFT. Throwing a stop without
 *    saying why produces an outage of unknown cause; lifting one without
 *    saying why destroys the only record of why it was safe to resume. The
 *    database enforces the first (CHECK constraints in migration 0114); these
 *    routes enforce both.
 *
 * 2. THE READ IS UNGATED, ALWAYS. `GET /v1/execution` is the page an operator
 *    opens mid-incident, and it is not admin-only: anyone whose work is being
 *    refused deserves to see that the deployment is halted rather than
 *    guessing that their access was revoked.
 *
 * 3. LIFTING IS AUDITED AS LOUDLY AS THROWING, under its own rule id. An
 *    operator alerting on "somebody stopped the platform" and an auditor
 *    asking "who restarted it, and on what authority" are different questions,
 *    and one shared rule id would answer neither well.
 *
 * 4. NOTHING IS DESTROYED. A halt makes pending approvals unspendable; it does
 *    not supersede them, cancel runs, or delete queued work. When it lifts,
 *    the queue is where it was. A kill switch that also tidied up would be one
 *    an operator hesitates to use, and hesitation is the failure mode.
 *
 * 5. AN IDEMPOTENT CALL WRITES NOTHING. Re-throwing an existing halt does not
 *    mint a second audit row claiming a second incident.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  and,
  auditLog,
  eq,
  isNotNull,
  mcpTools,
  mcpServers,
  ORG_SETTINGS_ID,
  orgSettings,
  users,
  type Db,
} from "@regulait/db";
import { EXECUTION_MODES, type ExecutionMode } from "@regulait/policy-kernel";
import { loadOrgSettings } from "./org-settings.js";
import { EXECUTION_MODE_NOTES } from "./execution-posture.js";
import { checkStepUp, requireStepUp } from "./step-up.js";

/** how restrictive each mode is: normal < the two partial restrictions < halted */
const EXECUTION_MODE_RANK: Record<ExecutionMode, number> = { normal: 0, read_only: 1, require_approval: 1, halted: 2 };

/** ADR-0186 A: does moving from `from` to `to` lift any restriction? (a lateral move between the partial
 * restrictions lets through what the other refused, so it counts; entering a halt never does) */
export function executionModeLoosens(from: ExecutionMode, to: ExecutionMode): boolean {
  if (from === to || to === "halted") return false;
  return EXECUTION_MODE_RANK[to] <= EXECUTION_MODE_RANK[from];
}

/** Distinct rule ids per event: an operator alerts on each separately. */
export const EXECUTION_CONTROL_RULE_IDS = {
  modeSet: "execution-mode-set",
  modeCleared: "execution-mode-cleared",
  agentHalted: "execution-agent-halted",
  agentUnhalted: "execution-agent-unhalted",
  toolHalted: "execution-tool-halted",
  toolUnhalted: "execution-tool-unhalted",
} as const;

/** A reason is the point, so the floor is meaningful rather than non-empty. */
const reasonSchema = z
  .string()
  .trim()
  .min(10, "state why in at least a few words — this is the record of the incident")
  .max(2000);

const setModeSchema = z
  .object({
    mode: z.enum(EXECUTION_MODES),
    /** required for every mode except `normal`, matched to the DB CHECK */
    reason: reasonSchema.optional(),
    /**
     * REQUIRED for `require_approval`, and meaningless otherwise.
     *
     * "Nothing runs unattended" has to say who is attending: a queued approval
     * names a NOT NULL approver, and one nobody is named on is one nobody is
     * accountable for deciding.
     */
    approverUserId: z.string().uuid().optional(),
  })
  .strict();

const haltSchema = z.object({ reason: reasonSchema }).strict();

/** who is halting an agent, for the audit row */
export interface HaltActor {
  /** null = the deployment itself (no user identity) */
  userId: string | null;
  /** how the actor authenticated (`req.authCtx.via`), when a person did it */
  via?: string | undefined;
  /** extra audit detail, e.g. the incident or proposal the halt came from */
  detail?: Record<string, unknown>;
}

export type HaltAgentResult = { agentId: string; halted: true; changed: boolean; note: string };

/**
 * ADR-0124's agent halt, INSIDE the caller's transaction (ADR-0182 P0: a pure
 * extraction, so incident containment (A12) and an approved halt proposal (S5)
 * halt through the one implementation the route uses).
 *
 * Locks the agent row, writes nothing when it is already halted (idempotent,
 * principle 5), else sets `halted_at` / `halted_reason` / `halted_by_user_id`
 * and writes the `execution-agent-halted` audit row. Returns null for an
 * unknown agent. Unhalting stays on the execution-control route only.
 */
export async function haltAgentInTx(
  tx: Db,
  agentId: string,
  reason: string,
  actor: HaltActor,
): Promise<HaltAgentResult | null> {
  const [before] = await tx.select().from(agents).where(eq(agents.id, agentId)).for("update");
  if (!before) return null;
  if (before.haltedAt) {
    return {
      agentId, halted: true, changed: false,
      note: `already halted since ${before.haltedAt.toISOString()}: ${before.haltedReason}`,
    };
  }
  const now = new Date();
  await tx.update(agents)
    .set({ haltedAt: now, haltedReason: reason, haltedByUserId: actor.userId })
    .where(eq(agents.id, agentId));
  await tx.insert(auditLog).values({
    userId: actor.userId ?? "00000000-0000-0000-0000-000000000000",
    objectType: "agent",
    objectId: agentId,
    detail: { via: actor.via, ...actor.detail },
    effect: "deny",
    ruleId: EXECUTION_CONTROL_RULE_IDS.agentHalted,
    ruleChain: [],
    reason: `agent '${before.name}' HALTED: ${reason}`,
  });
  return {
    agentId, halted: true, changed: true,
    note: `every dispatch to '${before.name}' is now refused, and it can no longer be selected as a ` +
      "routing or fallback target. This is separate from `enabled`: lifting the halt will not " +
      "put a deliberately-disabled agent back into service.",
  };
}

export function registerExecutionControlRoutes(app: FastifyInstance, db: Db) {
  const audit = async (
    writer: Pick<Db, "insert">,
    userId: string | null,
    objectType: "org_settings" | "agent" | "mcp_tool",
    objectId: string | null,
    ruleId: string,
    /** `deny` when this call RESTRICTS, `allow` when it RESUMES — the effect
     * follows the consequence, as every other governance write here does. */
    effect: "allow" | "deny",
    reason: string,
    detail: Record<string, unknown>,
  ) => {
    await writer.insert(auditLog).values({
      userId: userId ?? "00000000-0000-0000-0000-000000000000",
      objectType,
      objectId,
      detail,
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  };

  // ── the read ────────────────────────────────────────────────────────────
  //
  // Deliberately not admin-only. See rule 2.
  app.get("/v1/execution", async () => {
    const org = await loadOrgSettings(db);
    const haltedAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        haltedAt: agents.haltedAt,
        reason: agents.haltedReason,
      })
      .from(agents)
      .where(isNotNull(agents.haltedAt));
    const haltedTools = await db
      .select({
        serverId: mcpTools.serverId,
        name: mcpTools.name,
        haltedAt: mcpTools.haltedAt,
        reason: mcpTools.haltedReason,
      })
      .from(mcpTools)
      .where(isNotNull(mcpTools.haltedAt));

    const mode = org.executionMode as ExecutionMode;
    return {
      mode,
      meaning: EXECUTION_MODE_NOTES[mode],
      reason: org.executionModeReason,
      setAt: org.executionModeSetAt,
      setByUserId: org.executionModeSetByUserId,
      haltedAgents,
      haltedTools,
      /** the whole point, in one sentence a human can read out */
      summary:
        mode === "normal" && haltedAgents.length === 0 && haltedTools.length === 0
          ? "Nothing is stopped. Every governed call is decided by the ordinary rules."
          : [
              mode === "normal" ? null : `the deployment is in ${mode.replace("_", "-")} mode`,
              haltedAgents.length > 0 ? `${haltedAgents.length} agent(s) halted` : null,
              haltedTools.length > 0 ? `${haltedTools.length} tool(s) halted` : null,
            ]
              .filter(Boolean)
              .join("; "),
      note:
        "A halt stops EXECUTION. Reading the audit trail, the approvals queue and this endpoint is " +
        "never gated by it, or the halt could not be investigated or lifted. Pending approvals are " +
        "left exactly where they are — a halt makes them unspendable, it does not cancel them.",
      scheduledSweepsNote:
        "The platform's own governance sweeps (model-card expiry, MCP admission re-scan, red-team, " +
        "SLA timers) keep running while halted, on purpose: they dispatch nothing on a user's " +
        "behalf, and going blind during an incident is the opposite of what a halt is for.",
    };
  });

  // ── the deployment dial ─────────────────────────────────────────────────
  app.put("/v1/execution/mode", async (req, reply) => {
    const body = setModeSchema.parse(req.body);
    if (body.mode !== "normal" && !body.reason) {
      return reply.status(400).send({
        error: "reason_required",
        detail:
          `setting execution mode '${body.mode}' restricts what this deployment will run, so it ` +
          "requires a reason. The reason is the record of the incident, and whoever lifts this " +
          "later is usually not you.",
      });
    }
    // Returning to normal is ALSO an intervention and ALSO wants its reason —
    // "why was it safe to resume?" is the harder question of the two.
    if (body.mode === "normal" && !body.reason) {
      return reply.status(400).send({
        error: "reason_required",
        detail:
          "resuming normal execution requires a reason too: it is the record of why it was safe " +
          "to resume, which is the question an auditor asks afterwards.",
      });
    }

    if (body.mode === "require_approval" && !body.approverUserId) {
      return reply.status(400).send({
        error: "approver_required",
        detail:
          "require_approval mode queues work for human sign-off, so it must name the human. " +
          "Pass approverUserId. (MCP tool calls and connector writes queue; model dispatch and " +
          "connector reads are refused under this mode, because they have no per-call approval queue.)",
      });
    }
    if (body.approverUserId) {
      const [approver] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, body.approverUserId));
      if (!approver) {
        return reply
          .status(400)
          .send({ error: "invalid_reference", detail: "approverUserId names no user" });
      }
    }

    const current = (await loadOrgSettings(db)).executionMode as ExecutionMode;
    // ADR-0186 A: LIFTING a restriction (a move to a less restrictive mode, or
    // across between the two partial restrictions) needs a settings_relax
    // step-up bound to the new mode; entering a halt or tightening never does.
    // B4S-08: a move into require_approval binds the approver it names too, so
    // a grant made for one approver cannot route every queued call to another
    const facts = {
      values: {
        executionMode: body.mode,
        ...(body.mode === "require_approval" ? { approverUserId: body.approverUserId ?? null } : {}),
      },
    };
    let cleared = false;
    if (executionModeLoosens(current, body.mode)) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts });
      if (!su.ok) return reply;
      cleared = true;
    }
    return db.transaction(async (tx) => {
      const [before] = await tx.select().from(orgSettings)
        .where(eq(orgSettings.id, ORG_SETTINGS_ID)).for("update");
      const wasMode = before!.executionMode as ExecutionMode;
      // the step-up was decided against `current`: when the mode changed meanwhile so
      // that this write now lifts a restriction, it is decided again on the mode it replaces
      if (!cleared && executionModeLoosens(wasMode, body.mode)) {
        const again = await checkStepUp(db, req, { kind: "settings_relax", facts });
        if (!again.ok) return reply.status(again.status).send(again.body);
      }
      if (wasMode === body.mode) {
        return {
          mode: wasMode,
          changed: false,
          note: `already in '${wasMode}' mode since ${before!.executionModeSetAt?.toISOString() ?? "install"} — nothing was written`,
        };
      }

      const now = new Date();
      const [updated] = await tx.update(orgSettings).set({
        executionMode: body.mode,
        executionModeReason: body.mode === "normal" ? null : body.reason!,
        executionModeApproverUserId: body.mode === "require_approval" ? body.approverUserId! : null,
        executionModeSetByUserId: req.authCtx.userId ?? null,
        executionModeSetAt: now,
        updatedBy: req.authCtx.userId,
        updatedAt: now,
      }).where(eq(orgSettings.id, ORG_SETTINGS_ID)).returning();

      const restricting = body.mode !== "normal";
      await audit(
        tx, req.authCtx.userId ?? null, "org_settings", null,
        restricting ? EXECUTION_CONTROL_RULE_IDS.modeSet : EXECUTION_CONTROL_RULE_IDS.modeCleared,
        restricting ? "deny" : "allow",
        restricting
          ? `execution mode ${wasMode} -> ${body.mode}: ${body.reason}`
          : `execution resumed (${wasMode} -> normal): ${body.reason}`,
        { from: wasMode, to: body.mode, via: req.authCtx.via },
      );

      return {
        mode: updated!.executionMode,
        changed: true,
        previousMode: wasMode,
        meaning: EXECUTION_MODE_NOTES[body.mode],
        effectiveImmediately: true,
        note: body.mode === "halted"
          ? "Every governed call is now refused. Nothing in flight was cancelled and no queued " +
            "approval was destroyed; when this lifts, the queue is where you left it."
          : EXECUTION_MODE_NOTES[body.mode],
      };
    });
  });

  // ── one agent ───────────────────────────────────────────────────────────
  const agentParam = z.object({ agentId: z.string().uuid() });

  app.post("/v1/agents/:agentId/halt", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    const body = haltSchema.parse(req.body);
    const result = await db.transaction((tx) =>
      haltAgentInTx(tx as unknown as Db, agentId, body.reason, { userId: req.authCtx.userId ?? null, via: req.authCtx.via }),
    );
    return result ?? reply.status(404).send({ error: "unknown_agent" });
  });

  app.post("/v1/agents/:agentId/unhalt", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    const body = haltSchema.parse(req.body);
    // ADR-0186 A: lifting a halt loosens a protection: a settings_relax step-up bound to this agent
    const stepUp = { kind: "settings_relax" as const, facts: { agentId, values: { halted: false } } };
    const [held] = await db.select({ haltedAt: agents.haltedAt }).from(agents).where(eq(agents.id, agentId));
    let cleared = false;
    if (held?.haltedAt) {
      const su = await requireStepUp(db, req, reply, stepUp);
      if (!su.ok) return reply;
      cleared = true;
    }
    const result = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(agents).where(eq(agents.id, agentId)).for("update");
      if (!before) return null;
      if (!before.haltedAt) {
        return { agentId, halted: false, changed: false, note: "not halted — nothing was written" };
      }
      // the step-up was decided on the unlocked read: a halt that landed before the lock is decided
      // again on the locked row, so a halt is never lifted without one
      if (!cleared) {
        const again = await checkStepUp(db, req, stepUp);
        if (!again.ok) return { refused: again };
      }
      await tx.update(agents).set({ haltedAt: null, haltedReason: null, haltedByUserId: null })
        .where(eq(agents.id, agentId));
      await audit(
        tx, req.authCtx.userId ?? null, "agent", agentId,
        EXECUTION_CONTROL_RULE_IDS.agentUnhalted, "allow",
        `agent '${before.name}' halt LIFTED: ${body.reason} (was halted for: ${before.haltedReason})`,
        { via: req.authCtx.via, previousReason: before.haltedReason },
      );
      return {
        agentId, halted: false, changed: true,
        note: before.enabled
          ? `'${before.name}' is dispatchable again for anyone already granted it`
          : `'${before.name}' halt lifted, but it remains DISABLED in the registry — a separate ` +
            "decision, and lifting a halt deliberately does not reverse it",
      };
    });
    if (result && "refused" in result && result.refused) return reply.status(result.refused.status).send(result.refused.body);
    return result ?? reply.status(404).send({ error: "unknown_agent" });
  });

  // ── one tool ────────────────────────────────────────────────────────────
  const toolParam = z.object({
    serverId: z.string().uuid(),
    toolName: z.string().min(1).max(200),
  });

  app.post("/v1/servers/:serverId/tools/:toolName/halt", async (req, reply) => {
    const { serverId, toolName } = toolParam.parse(req.params);
    const body = haltSchema.parse(req.body);
    const result = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(mcpTools)
        .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName))).for("update");
      if (!before) return null;
      if (before.haltedAt) {
        return {
          serverId, toolName, halted: true, changed: false,
          note: `already halted since ${before.haltedAt.toISOString()}: ${before.haltedReason}`,
        };
      }
      const [server] = await tx.select({ name: mcpServers.name }).from(mcpServers)
        .where(eq(mcpServers.id, serverId));
      await tx.update(mcpTools).set({
        haltedAt: new Date(), haltedReason: body.reason,
        haltedByUserId: req.authCtx.userId ?? null,
      }).where(eq(mcpTools.id, before.id));
      await audit(
        tx, req.authCtx.userId ?? null, "mcp_tool", before.id,
        EXECUTION_CONTROL_RULE_IDS.toolHalted, "deny",
        `tool '${toolName}' on server '${server?.name ?? serverId}' HALTED: ${body.reason}`,
        { serverId, toolName, via: req.authCtx.via },
      );
      return {
        serverId, toolName, halted: true, changed: true,
        note: `every call to '${toolName}' is now refused. Its server, its sibling tools and every other ` +
          "agent are unaffected — this is the scope that lets you stop one bad tool without " +
          "stopping the business.",
      };
    });
    return result ?? reply.status(404).send({ error: "unknown_tool" });
  });

  app.post("/v1/servers/:serverId/tools/:toolName/unhalt", async (req, reply) => {
    const { serverId, toolName } = toolParam.parse(req.params);
    const body = haltSchema.parse(req.body);
    // ADR-0186 A: lifting a halt loosens a protection: a settings_relax step-up bound to this tool
    const [held] = await db
      .select({ haltedAt: mcpTools.haltedAt })
      .from(mcpTools)
      .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)));
    const stepUp = { kind: "settings_relax" as const, facts: { serverId, toolName, values: { halted: false } } };
    let cleared = false;
    if (held?.haltedAt) {
      const su = await requireStepUp(db, req, reply, stepUp);
      if (!su.ok) return reply;
      cleared = true;
    }
    const result = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(mcpTools)
        .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName))).for("update");
      if (!before) return null;
      if (!before.haltedAt) {
        return { serverId, toolName, halted: false, changed: false, note: "not halted — nothing was written" };
      }
      // decided again on the locked row (see the agent unhalt above)
      if (!cleared) {
        const again = await checkStepUp(db, req, stepUp);
        if (!again.ok) return { refused: again };
      }
      await tx.update(mcpTools).set({ haltedAt: null, haltedReason: null, haltedByUserId: null })
        .where(eq(mcpTools.id, before.id));
      await audit(
        tx, req.authCtx.userId ?? null, "mcp_tool", before.id,
        EXECUTION_CONTROL_RULE_IDS.toolUnhalted, "allow",
        `tool '${toolName}' halt LIFTED: ${body.reason} (was halted for: ${before.haltedReason})`,
        { serverId, toolName, via: req.authCtx.via, previousReason: before.haltedReason },
      );
      return {
        serverId, toolName, halted: false, changed: true,
        note: `'${toolName}' is callable again by anyone already granted it`,
      };
    });
    if (result && "refused" in result && result.refused) return reply.status(result.refused.status).send(result.refused.body);
    return result ?? reply.status(404).send({ error: "unknown_tool" });
  });
}
