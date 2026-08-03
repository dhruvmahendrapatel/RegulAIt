/**
 * ADR-0048 — the GATEWAY half of IMMUTABLE VERSIONING / CANARY / ROLLBACK.
 *
 *   `packages/shared/src/config-versions.ts`  the deterministic bucketing, the
 *                                             resolution, the promotion gate.
 *                                             Pure — no db, no clock, no crypto.
 *   THIS FILE                                 persistence, the admin API, the
 *                                             append-only activation ledger,
 *                                             the audit rows, and the
 *                                             dispatch-time resolver.
 *   `agents-connectors.ts`                    calls `resolveAgentPromptVersion`
 *                                             inside `executeGovernedDispatch`
 *                                             and STAMPS the result onto the
 *                                             `usage_events` row.
 *
 * FOUR PROPERTIES THIS FILE EXISTS TO GUARANTEE
 *
 *  1. NO IN-PLACE EDIT EVER LOSES A VERSION. `newVersion` INSERTs; the only
 *     column ever UPDATEd on an existing row is `status` (the pointer), and
 *     every such move is mirrored into `config_activation_events`, which is
 *     append-only. `POST /v1/agents/:id/system-prompt` — the endpoint that used
 *     to be a straight `UPDATE agents SET system_prompt` — now mints a version
 *     and activates it, so the pre-existing admin gesture keeps its behaviour
 *     and gains a history it did not have.
 *
 *  2. ROLLBACK IS A POINTER FLIP. The prior body is stored verbatim, so
 *     rollback re-activates it with nothing reconstructed and nothing
 *     recomputed. The rolled-back version's row still exists afterwards — it is
 *     marked `rolled_back`, not deleted — so a rollback can itself be rolled
 *     back.
 *
 *  3. RESOLUTION HAPPENS IN THE ONE DISPATCH CORE. `resolveAgentPromptVersion`
 *     is called from `executeGovernedDispatch`, so the direct-invoke path, the
 *     orchestration workers and both compat shims inherit it with zero
 *     reimplementation — exactly as ADR-0023's base-always-wins invariant
 *     already does, and that invariant is preserved unchanged: a canary base
 *     prompt still WINS over, and is still only APPENDED TO by, a
 *     caller-supplied `system`.
 *
 *  4. THE SERVED VERSION IS STAMPED ON THE LEDGER ROW. Not in a log line, not
 *     in a jsonb blob nobody indexes — three real columns on `usage_events`.
 *     "Which version served this dispatch" is a WHERE clause. Without that the
 *     canary would be a rollout mechanism with no way to attribute the
 *     regression it exists to catch.
 *
 * WHAT THIS FILE DOES NOT DO — stated here rather than only in the ADR:
 *   Restriction-rule (`approval_rule` / `rate_limit` / `data_scope_rule` /
 *   `compliance_profile`) versions are STORED, versioned, activatable and
 *   rollback-able through this same surface, but the rules engine does NOT yet
 *   read them: those kernels still read their own tables. §2's SHADOW canary
 *   for restriction rules is therefore not evaluated by anything. The
 *   substrate is real; the wiring for rule types is a follow-up, and
 *   `canaryIsLive` names the boundary in code so nobody mistakes a stored rule
 *   canary for an enforcing one.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  agents,
  and,
  asc,
  auditLog,
  configActivationEvents,
  configVersions,
  count,
  desc,
  eq,
  evalRuns,
  isNotNull,
  sql,
  usageEvents,
  type ConfigArtifactType,
  type ConfigVersionRow,
  type Db,
} from "@regulait/db";
import {
  CONFIG_ARTIFACT_TYPES,
  activateConfigVersionSchema,
  canaryIsLive,
  createConfigVersionSchema,
  evaluatePromotion,
  promoteCanarySchema,
  promptFromBody,
  resolveVersion,
  rollbackConfigSchema,
  startCanarySchema,
  stableKeyFor,
  type ResolvedVersion,
} from "@regulait/shared";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

const artifactParam = z.object({
  artifactType: z.enum(CONFIG_ARTIFACT_TYPES),
  artifactId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Loading + resolution
// ---------------------------------------------------------------------------

export async function loadVersions(
  db: Db,
  artifactType: ConfigArtifactType,
  artifactId: string,
): Promise<ConfigVersionRow[]> {
  return db
    .select()
    .from(configVersions)
    .where(and(eq(configVersions.artifactType, artifactType), eq(configVersions.artifactId, artifactId)))
    .orderBy(asc(configVersions.version));
}

export interface PromptResolution extends ResolvedVersion {
  systemPrompt: string | null;
}

/**
 * THE DISPATCH-TIME RESOLVER. Returns null when the agent has no version rows
 * at all — the caller then falls back to `agents.systemPrompt`, which is the
 * byte-identical pre-ADR-0048 behaviour for an agent nobody has versioned.
 *
 * `stableKey` is what makes the canary sticky: the same run (else the same
 * conversation, else the same user) lands on the same side of the split every
 * time, so a multi-turn conversation cannot change its base prompt halfway
 * through.
 */
export async function resolveAgentPromptVersion(
  db: Db,
  args: { agentId: string; runId?: string | null; conversationId?: string | null; userId: string },
): Promise<PromptResolution | null> {
  const versions = await loadVersions(db, "agent_system_prompt", args.agentId);
  if (versions.length === 0) return null;
  const resolved = resolveVersion({
    artifactType: "agent_system_prompt",
    artifactId: args.agentId,
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      status: v.status,
      canaryPct: v.canaryPct,
      body: v.body,
    })),
    stableKey: stableKeyFor({
      runId: args.runId ?? null,
      conversationId: args.conversationId ?? null,
      userId: args.userId,
    }),
  });
  if (!resolved) return null;
  return { ...resolved, systemPrompt: promptFromBody(resolved.body) };
}

// ---------------------------------------------------------------------------
// Mutations — every one of them INSERTs, and every one is ledgered
// ---------------------------------------------------------------------------

async function auditConfig(
  db: Db,
  actor: string | null,
  artifactId: string,
  ruleId: string,
  reason: string,
  detail: Record<string, unknown>,
  effect: "allow" | "deny" = "allow",
) {
  await db.insert(auditLog).values({
    userId: actor ?? NO_IDENTITY,
    objectType: "config_version",
    objectId: artifactId,
    detail,
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

/**
 * Create the next immutable version. NEVER touches the previous row: the whole
 * point is that "editing" a governance artifact is an append.
 */
export async function newVersion(
  db: Db,
  args: {
    artifactType: ConfigArtifactType;
    artifactId: string;
    body: Record<string, unknown>;
    label?: string | null;
    authorUserId: string | null;
    activate?: boolean;
    reason?: string | null;
  },
): Promise<{ version: ConfigVersionRow; activated: boolean }> {
  const existing = await loadVersions(db, args.artifactType, args.artifactId);
  const next = existing.reduce((m, v) => Math.max(m, v.version), 0) + 1;
  const parent = existing.find((v) => v.status === "active")?.version ?? null;
  const [row] = await db
    .insert(configVersions)
    .values({
      artifactType: args.artifactType,
      artifactId: args.artifactId,
      version: next,
      body: args.body,
      label: args.label ?? null,
      parentVersion: parent,
      status: "draft",
      authorUserId: args.authorUserId,
    })
    .returning();
  await db.insert(configActivationEvents).values({
    artifactType: args.artifactType,
    artifactId: args.artifactId,
    versionId: row!.id,
    version: next,
    action: "created",
    actorUserId: args.authorUserId,
    reason: args.reason ?? null,
  });
  await auditConfig(
    db,
    args.authorUserId,
    args.artifactId,
    "config-version-created",
    `admin created version ${next} of ${args.artifactType} — the previous version row is untouched and still ` +
      `serves until this one is explicitly activated or canaried`,
    { artifactType: args.artifactType, version: next, parentVersion: parent, label: args.label ?? null },
  );
  if (!args.activate) return { version: row!, activated: false };
  const activated = await activateVersion(db, {
    artifactType: args.artifactType,
    artifactId: args.artifactId,
    version: next,
    actorUserId: args.authorUserId,
    reason: args.reason ?? null,
  });
  return { version: activated.target, activated: true };
}

/**
 * ACTIVATE a version — and therefore also ROLL BACK, because rolling back IS
 * activating an older version. One audited operation, one shape; the rollback
 * case differs only in the ruleId and the reason string, exactly as ADR-0040's
 * ABAC surface already does it.
 *
 * The previous active becomes `superseded` (moved forward) or `rolled_back`
 * (moved backward). Either way ITS ROW SURVIVES and can be re-activated.
 */
export async function activateVersion(
  db: Db,
  args: {
    artifactType: ConfigArtifactType;
    artifactId: string;
    version: number;
    actorUserId: string | null;
    reason?: string | null;
    /** set when this activation is a promotion of the canary */
    promotion?: { ruleId: string; evalRunId: string | null; override: boolean; reason: string } | null;
  },
): Promise<{ target: ConfigVersionRow; previous: ConfigVersionRow | null; rollback: boolean }> {
  const versions = await loadVersions(db, args.artifactType, args.artifactId);
  const target = versions.find((v) => v.version === args.version);
  if (!target) throw new Error("unknown_version");
  const previous = versions.find((v) => v.status === "active") ?? null;
  const rollback = previous != null && previous.version > target.version;

  const updated = await db.transaction(async (tx) => {
    // clear the old pointers FIRST — the partial unique indexes admit exactly
    // one active and one canary row per artifact, so a "set new then clear old"
    // ordering would violate them.
    if (previous && previous.id !== target.id) {
      await tx
        .update(configVersions)
        .set({ status: rollback ? "rolled_back" : "superseded", canaryPct: null })
        .where(eq(configVersions.id, previous.id));
    }
    const [row] = await tx
      .update(configVersions)
      .set({ status: "active", canaryPct: null })
      .where(eq(configVersions.id, target.id))
      .returning();
    await tx.insert(configActivationEvents).values({
      artifactType: args.artifactType,
      artifactId: args.artifactId,
      versionId: target.id,
      version: target.version,
      fromVersionId: previous?.id ?? null,
      fromVersion: previous?.version ?? null,
      action: args.promotion ? "promoted" : rollback ? "rolled_back" : "activated",
      actorUserId: args.actorUserId,
      reason: args.promotion?.reason ?? args.reason ?? null,
      evalRunId: args.promotion?.evalRunId ?? null,
      override: args.promotion?.override ?? false,
    });
    return row!;
  });

  // ADR-0023/0044/0045 COMPOSITION: `agents.systemPrompt` becomes a READ-MODEL
  // of the active version, refreshed here on every pointer move. It is what the
  // agents API returns, what the ADR-0044 eval harness hashes into
  // `eval_runs.system_prompt_hash`, and what an admin reads in the SPA — so a
  // new prompt version is visible to both of those without either learning
  // about this table. DISPATCH never trusts it: `resolveAgentPromptVersion`
  // reads `config_versions` whenever any version row exists, which is the only
  // way the canary can serve a different body than the active one.
  if (args.artifactType === "agent_system_prompt") {
    await db
      .update(agents)
      .set({ systemPrompt: promptFromBody(updated.body) })
      .where(eq(agents.id, args.artifactId));
  }

  await auditConfig(
    db,
    args.actorUserId,
    args.artifactId,
    args.promotion ? args.promotion.ruleId : rollback ? "config-version-rolled-back" : "config-version-activated",
    args.promotion
      ? `canary version ${target.version} of ${args.artifactType} PROMOTED to active — ${args.promotion.reason}`
      : rollback
        ? `admin rolled ${args.artifactType} back from version ${previous!.version} to version ${target.version} — ` +
          `version ${previous!.version} still exists and can be re-activated; nothing was rewritten` +
          (args.reason ? `: ${args.reason}` : "")
        : `admin activated version ${target.version} of ${args.artifactType} — every subsequent dispatch resolves ` +
          `to it, and the ledger row of each such dispatch records which version served it` +
          (args.reason ? `: ${args.reason}` : ""),
    {
      artifactType: args.artifactType,
      to: target.version,
      from: previous?.version ?? null,
      rollback,
      ...(args.promotion
        ? { promotion: true, evalRunId: args.promotion.evalRunId, override: args.promotion.override }
        : {}),
    },
    rollback ? "deny" : "allow",
  );
  return { target: updated, previous, rollback };
}

// ---------------------------------------------------------------------------
// Routes (admin-only via app.ts's DEFAULT gate)
// ---------------------------------------------------------------------------

export function registerConfigVersionRoutes(app: FastifyInstance, db: Db): void {
  /** the lineage: every version, the active/canary pointers, and the
   * append-only activation history that answers "what was active when" */
  app.get("/v1/config-versions/:artifactType/:artifactId", async (req) => {
    const { artifactType, artifactId } = artifactParam.parse(req.params);
    const versions = await loadVersions(db, artifactType, artifactId);
    const events = await db
      .select()
      .from(configActivationEvents)
      .where(
        and(
          eq(configActivationEvents.artifactType, artifactType),
          eq(configActivationEvents.artifactId, artifactId),
        ),
      )
      .orderBy(desc(configActivationEvents.at));
    const active = versions.find((v) => v.status === "active") ?? null;
    const canary = versions.find((v) => v.status === "canary") ?? null;
    return {
      artifactType,
      artifactId,
      versions,
      active,
      canary,
      history: events,
      canaryMode: canaryIsLive(artifactType) ? "live" : "shadow",
      note: canaryIsLive(artifactType)
        ? "Canary traffic is served LIVE and stamped onto usage_events.config_version_id."
        : "This artifact type canaries in SHADOW per ADR-0048 §2 — a partially-enforced deny would " +
          "non-deterministically block real work. NOTE: shadow evaluation for rule types is NOT yet " +
          "wired into the rules engine; a stored rule canary changes nothing at all today.",
    };
  });

  app.post("/v1/config-versions/:artifactType/:artifactId", async (req, reply) => {
    const { artifactType, artifactId } = artifactParam.parse(req.params);
    const body = createConfigVersionSchema.parse(req.body);
    if (artifactType === "agent_system_prompt") {
      const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, artifactId));
      if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    }
    const res = await newVersion(db, {
      artifactType,
      artifactId,
      body: body.body,
      label: body.label ?? null,
      authorUserId: req.authCtx.userId ?? null,
      activate: body.activate,
    });
    return reply.status(201).send({ version: res.version, activated: res.activated });
  });

  app.post("/v1/config-versions/:artifactType/:artifactId/activate", async (req, reply) => {
    const { artifactType, artifactId } = artifactParam.parse(req.params);
    const body = activateConfigVersionSchema.parse(req.body);
    const versions = await loadVersions(db, artifactType, artifactId);
    if (!versions.some((v) => v.version === body.version)) {
      return reply.status(404).send({ error: "unknown_version" });
    }
    const res = await activateVersion(db, {
      artifactType,
      artifactId,
      version: body.version,
      actorUserId: req.authCtx.userId ?? null,
      reason: body.reason ?? null,
    });
    return {
      activeVersion: res.target.version,
      previousVersion: res.previous?.version ?? null,
      rollback: res.rollback,
    };
  });

  /** ROLLBACK — re-activates the immediately-prior active version. A separate
   * verb from `activate` only because ADR-0048 §5 promises ONE CLICK: the admin
   * should not have to know which number to type in an incident. */
  app.post("/v1/config-versions/:artifactType/:artifactId/rollback", async (req, reply) => {
    const { artifactType, artifactId } = artifactParam.parse(req.params);
    const body = rollbackConfigSchema.parse(req.body);
    const events = await db
      .select()
      .from(configActivationEvents)
      .where(
        and(
          eq(configActivationEvents.artifactType, artifactType),
          eq(configActivationEvents.artifactId, artifactId),
        ),
      )
      .orderBy(desc(configActivationEvents.at));
    // the version that was active immediately before the current one, read out
    // of the APPEND-ONLY ledger rather than guessed from version arithmetic —
    // "the previous active" and "the version below this one" are not the same
    // thing once a rollback has already happened.
    const lastMove = events.find((e) => e.action === "activated" || e.action === "promoted" || e.action === "rolled_back");
    if (!lastMove?.fromVersion) {
      return reply.status(409).send({
        error: "no_prior_version",
        detail: "this artifact has never had a previous active version to roll back to",
      });
    }
    const res = await activateVersion(db, {
      artifactType,
      artifactId,
      version: lastMove.fromVersion,
      actorUserId: req.authCtx.userId ?? null,
      reason: body.reason,
    });
    return {
      activeVersion: res.target.version,
      rolledBackFrom: res.previous?.version ?? null,
      note: "the rolled-back version's row still exists and can be re-activated — nothing was rewritten",
    };
  });

  /** start (or re-point / re-ramp) a CANARY */
  app.post("/v1/config-versions/:artifactType/:artifactId/canary", async (req, reply) => {
    const { artifactType, artifactId } = artifactParam.parse(req.params);
    const body = startCanarySchema.parse(req.body);
    const versions = await loadVersions(db, artifactType, artifactId);
    const target = versions.find((v) => v.version === body.version);
    if (!target) return reply.status(404).send({ error: "unknown_version" });
    if (target.status === "active") {
      return reply.status(409).send({
        error: "already_active",
        detail: "the active version serves 100% of traffic; canarying it would be a no-op with a percentage on it",
      });
    }
    const current = versions.find((v) => v.status === "canary") ?? null;
    const adjust = current?.id === target.id;
    const [row] = await db.transaction(async (tx) => {
      if (current && current.id !== target.id) {
        await tx
          .update(configVersions)
          // the displaced canary returns to `draft` — it was never active, so
          // calling it `rolled_back` would misstate its history
          .set({ status: "draft", canaryPct: null })
          .where(eq(configVersions.id, current.id));
      }
      const r = await tx
        .update(configVersions)
        .set({ status: "canary", canaryPct: body.pct })
        .where(eq(configVersions.id, target.id))
        .returning();
      await tx.insert(configActivationEvents).values({
        artifactType,
        artifactId,
        versionId: target.id,
        version: target.version,
        action: adjust ? "canary_adjusted" : "canary_started",
        canaryPct: body.pct,
        actorUserId: req.authCtx.userId ?? null,
        reason: body.reason ?? null,
      });
      return r;
    });
    await auditConfig(
      db,
      req.authCtx.userId ?? null,
      artifactId,
      adjust ? "config-canary-adjusted" : "config-canary-started",
      `version ${target.version} of ${artifactType} is now the canary at ${body.pct}% — ` +
        (canaryIsLive(artifactType)
          ? "routing is deterministic on a stable key (run, else conversation, else user), so a multi-turn " +
            "conversation cannot flip mid-run, and every dispatch records which version served it"
          : "this artifact type canaries in SHADOW and enforces nothing; rule-type shadow evaluation is not yet wired"),
      { artifactType, version: target.version, pct: body.pct, live: canaryIsLive(artifactType) },
    );
    return { canaryVersion: row!.version, pct: row!.canaryPct, live: canaryIsLive(artifactType) };
  });

  /** abandon the canary WITHOUT touching the active version (§5) */
  app.delete("/v1/config-versions/:artifactType/:artifactId/canary", async (req, reply) => {
    const { artifactType, artifactId } = artifactParam.parse(req.params);
    const versions = await loadVersions(db, artifactType, artifactId);
    const canary = versions.find((v) => v.status === "canary");
    if (!canary) return reply.status(409).send({ error: "no_canary" });
    await db
      .update(configVersions)
      .set({ status: "rolled_back", canaryPct: null })
      .where(eq(configVersions.id, canary.id));
    await db.insert(configActivationEvents).values({
      artifactType,
      artifactId,
      versionId: canary.id,
      version: canary.version,
      action: "abandoned",
      actorUserId: req.authCtx.userId ?? null,
      reason: "canary abandoned",
    });
    await auditConfig(
      db,
      req.authCtx.userId ?? null,
      artifactId,
      "config-canary-abandoned",
      `the canary (version ${canary.version}) of ${artifactType} was abandoned — the ACTIVE version is untouched ` +
        `and 100% of traffic returns to it immediately`,
      { artifactType, version: canary.version },
      "deny",
    );
    return { abandoned: canary.version };
  });

  /**
   * PROMOTE the canary to active. ADR-0044 is the gate: a run against a version
   * created no earlier than the canary must have PASSED, otherwise promotion is
   * only possible as an explicit override WITH A REASON, audited under
   * `canary-promote-override`.
   */
  app.post("/v1/config-versions/:artifactType/:artifactId/promote", async (req, reply) => {
    const { artifactType, artifactId } = artifactParam.parse(req.params);
    const body = promoteCanarySchema.parse(req.body);
    const versions = await loadVersions(db, artifactType, artifactId);
    const canary = versions.find((v) => v.status === "canary");
    if (!canary) return reply.status(409).send({ error: "no_canary", detail: "there is no canary to promote" });

    let evidence = null;
    if (body.evalRunId) {
      const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, body.evalRunId));
      if (!run) return reply.status(404).send({ error: "unknown_eval_run" });
      evidence = {
        id: run.id,
        status: run.status,
        gatePassed: run.gatePassed,
        regression: run.regression,
        startedAt: run.startedAt,
      };
    }
    const decision = evaluatePromotion({
      canaryCreatedAt: canary.createdAt,
      evidence,
      override: body.override,
      reason: body.reason ?? null,
    });
    if (!decision.allowed) {
      await auditConfig(
        db,
        req.authCtx.userId ?? null,
        artifactId,
        decision.ruleId,
        `promotion of ${artifactType} version ${canary.version} REFUSED: ${decision.reason}`,
        { artifactType, version: canary.version, evalRunId: decision.evalRunId },
        "deny",
      );
      return reply.status(409).send({ error: decision.ruleId, detail: decision.reason });
    }
    const res = await activateVersion(db, {
      artifactType,
      artifactId,
      version: canary.version,
      actorUserId: req.authCtx.userId ?? null,
      promotion: {
        ruleId: decision.ruleId,
        evalRunId: decision.evalRunId,
        override: decision.override,
        reason: decision.reason,
      },
    });
    return {
      activeVersion: res.target.version,
      gate: decision.ruleId,
      evalRunId: decision.evalRunId,
      override: decision.override,
      reason: decision.reason,
    };
  });

  /**
   * THE TRACE — the query ADR-0048 §3 exists to make possible: which version
   * served, how much traffic each version took, and how each performed. Read
   * straight off `usage_events`, the ONE ledger, with no second store.
   */
  app.get("/v1/config-versions/:artifactType/:artifactId/traffic", async (req) => {
    const { artifactType, artifactId } = artifactParam.parse(req.params);
    const byVersion = await db
      .select({
        version: usageEvents.configVersion,
        versionId: usageEvents.configVersionId,
        canary: usageEvents.configCanary,
        dispatches: count(),
        costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
        refusals: sql<number>`coalesce(sum(CASE WHEN ${usageEvents.refusal} THEN 1 ELSE 0 END), 0)::int`,
      })
      .from(usageEvents)
      .where(and(eq(usageEvents.agentId, artifactId), isNotNull(usageEvents.configVersionId)))
      .groupBy(usageEvents.configVersion, usageEvents.configVersionId, usageEvents.configCanary)
      .orderBy(asc(usageEvents.configVersion));
    return {
      artifactType,
      artifactId,
      byVersion,
      note:
        "Read from usage_events — the ONE spend ledger. Every dispatch carries the version that served it, " +
        "so a regression in these numbers is attributable to a specific version rather than to a time window.",
    };
  });
}
