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
  approvalRules,
  asc,
  auditLog,
  complianceProfiles,
  configActivationEvents,
  configCanaryObservations,
  configVersions,
  count,
  dataScopeRules,
  desc,
  eq,
  evalRuns,
  isNotNull,
  projects,
  rateLimits,
  sql,
  usageEvents,
  type ConfigArtifactType,
  type ConfigVersionRow,
  type Db,
} from "@regulait/db";
import {
  CONFIG_ARTIFACT_TYPES,
  VERSIONED_RULE_FIELDS,
  activateConfigVersionSchema,
  applyRuleBody,
  canaryIsLive,
  canaryModeNote,
  canaryModeOf,
  createConfigVersionSchema,
  evaluatePromotion,
  isRuleArtifact,
  promoteCanarySchema,
  promptFromBody,
  resolveVersion,
  rollbackConfigSchema,
  ruleBodyFrom,
  startCanarySchema,
  stableKeyFor,
  validateRuleVersionBody,
  type ResolvedVersion,
} from "@regulait/shared";
import { complianceProfilesForTags, effectiveCompliancePolicy } from "./projects.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

const artifactParam = z.object({
  artifactType: z.enum(CONFIG_ARTIFACT_TYPES),
  artifactId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Loading + resolution
// ---------------------------------------------------------------------------

/**
 * ADR-0073 — the table each rule/profile artifact type versions.
 *
 * Two jobs, both load-bearing:
 *   - the BASELINE: the first version of an artifact is minted FROM this row,
 *     so ADR-0048 §7's behaviour-preserving default holds without a migration
 *     that would have flipped every existing rule onto the version path at once;
 *   - the READ-MODEL: `activateVersion` writes the newly-active body back here,
 *     exactly as it already does for `agents.systemPrompt`, so every surface
 *     that lists rules (the admin API, the SPA, ADR-0059's simulation) shows
 *     what is actually enforced without learning about `config_versions`.
 *     DISPATCH never trusts it — `applyRuleVersions` reads `config_versions`
 *     whenever a version row exists.
 */
const RULE_TABLES = {
  approval_rule: approvalRules,
  rate_limit: rateLimits,
  data_scope_rule: dataScopeRules,
  compliance_profile: complianceProfiles,
} as const;

type RuleArtifactType = keyof typeof RULE_TABLES;

function ruleTableFor(t: ConfigArtifactType) {
  return (RULE_TABLES as Record<string, (typeof RULE_TABLES)[RuleArtifactType] | undefined>)[t];
}

async function loadRuleRow(
  db: Db,
  artifactType: ConfigArtifactType,
  artifactId: string,
): Promise<Record<string, unknown> | null> {
  const table = ruleTableFor(artifactType);
  if (!table) return null;
  const [row] = await db.select().from(table).where(eq(table.id, artifactId));
  return (row as Record<string, unknown> | undefined) ?? null;
}

/** write the active body back onto the artifact's own row — the read-model
 * half. Only versionable fields are ever written. */
async function writeRuleReadModel(
  db: Db,
  artifactType: ConfigArtifactType,
  artifactId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const table = ruleTableFor(artifactType);
  if (!table) return;
  const allowed = VERSIONED_RULE_FIELDS[artifactType] ?? [];
  const patch: Record<string, unknown> = {};
  for (const f of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, f)) patch[f] = body[f];
  }
  if (Object.keys(patch).length === 0) return;
  await db
    .update(table)
    .set(patch as never)
    .where(eq(table.id, artifactId));
}

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
  let existing = await loadVersions(db, args.artifactType, args.artifactId);

  // ADR-0073 — THE LAZY BASELINE (ADR-0048 §7's behaviour-preserving default,
  // applied at the moment versioning starts for THIS artifact).
  //
  // Migration 0060 backfilled agent prompts; rules were never backfilled,
  // because a migration-time backfill would have moved every existing rule onto
  // the version path in one step. So the first version an admin creates for a
  // rule mints v1 = the rule EXACTLY AS IT STANDS RIGHT NOW, active, and the
  // requested body becomes v2.
  //
  // Without this, creating a draft v1 would leave the artifact with version rows
  // and no active version — which `resolveForShadow` correctly treats as
  // unresolvable and DENIES. Minting the baseline is what keeps that fail-closed
  // branch reserved for genuine corruption instead of firing on an admin's first
  // ever edit.
  if (existing.length === 0 && isRuleArtifact(args.artifactType)) {
    const row = await loadRuleRow(db, args.artifactType, args.artifactId);
    if (row) {
      const [baseline] = await db
        .insert(configVersions)
        .values({
          artifactType: args.artifactType,
          artifactId: args.artifactId,
          version: 1,
          body: ruleBodyFrom(args.artifactType, row),
          label: "v1 (pre-versioning baseline)",
          parentVersion: null,
          status: "active",
          authorUserId: args.authorUserId,
        })
        .returning();
      await db.insert(configActivationEvents).values({
        artifactType: args.artifactType,
        artifactId: args.artifactId,
        versionId: baseline!.id,
        version: 1,
        action: "activated",
        actorUserId: args.authorUserId,
        reason:
          "v1 baseline captured from the live rule at the moment it was first versioned — " +
          "behaviour is unchanged by its creation",
      });
      await auditConfig(
        db,
        args.authorUserId,
        args.artifactId,
        "config-version-baseline-captured",
        `version 1 of ${args.artifactType} was captured from the live rule because this artifact was ` +
          `versioned for the first time — nothing about the rule changed, and it is now the ACTIVE version ` +
          `the kernel resolves`,
        { artifactType: args.artifactType, version: 1 },
      );
      existing = await loadVersions(db, args.artifactType, args.artifactId);
    }
  }

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
  // ADR-0073: the SAME read-model discipline for rule/compliance artifacts. The
  // rule's own row is rewritten to the newly-active body, so every listing
  // surface shows what is enforced. This is a convenience for READERS — the
  // kernel resolves through `config_versions`, so a rollback would change
  // evaluation even if this write had never happened.
  await writeRuleReadModel(db, args.artifactType, args.artifactId, updated.body);

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
      // ADR-0073 — THREE modes, not two, because "live" and "shadow" were being
      // asked to carry a third meaning they cannot: `agent_config` is neither
      // served nor shadowed, and calling it "shadow" claimed a measurement that
      // did not exist. `canaryIsLive` keeps its meaning (does the canary SERVE)
      // and stays false for every rule type for ever — flipping it would make a
      // rule canary ENFORCE a partial deny, which §2 forbids.
      canaryMode: canaryModeOf(artifactType),
      canaryIsLive: canaryIsLive(artifactType),
      canaryIsEvaluated: canaryModeOf(artifactType) !== "inert",
      note: canaryModeNote(artifactType),
    };
  });

  app.post("/v1/config-versions/:artifactType/:artifactId", async (req, reply) => {
    const { artifactType, artifactId } = artifactParam.parse(req.params);
    const body = createConfigVersionSchema.parse(req.body);
    if (artifactType === "agent_system_prompt") {
      const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, artifactId));
      if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    }
    // ADR-0073 — a rule version must name a REAL rule and may only carry
    // ENFORCING fields. Both are real refusals rather than a stored version
    // that would be silently ignored at evaluation time.
    if (isRuleArtifact(artifactType)) {
      const row = await loadRuleRow(db, artifactType, artifactId);
      if (!row) {
        return reply.status(404).send({
          error: "unknown_artifact",
          detail: `no ${artifactType} with id ${artifactId} exists; a version of a rule that does not exist would ` +
            `never be loaded by any evaluation`,
        });
      }
      const rejection = validateRuleVersionBody(artifactType, body.body);
      if (rejection) return reply.status(422).send({ error: rejection.error, detail: rejection.reason });
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
        canaryModeNote(artifactType),
      {
        artifactType,
        version: target.version,
        pct: body.pct,
        live: canaryIsLive(artifactType),
        canaryMode: canaryModeOf(artifactType),
      },
    );
    return {
      canaryVersion: row!.version,
      pct: row!.canaryPct,
      live: canaryIsLive(artifactType),
      canaryMode: canaryModeOf(artifactType),
      note: canaryModeNote(artifactType),
    };
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

  // -------------------------------------------------------------------------
  // ADR-0073 — WHAT WOULD CHANGE IF I PROMOTED THIS.
  //
  // The question an operator has to answer before promoting a rule canary, and
  // the one ADR-0048 could not answer at all because nothing evaluated the
  // candidate. Read straight off `config_canary_observations`.
  // -------------------------------------------------------------------------

  /** every artifact currently carrying a canary, with its divergence counts —
   * the index the SPA needs to show "there is something waiting on you" */
  app.get("/v1/config-versions/canaries", async () => {
    const canaries = await db
      .select()
      .from(configVersions)
      .where(eq(configVersions.status, "canary"))
      .orderBy(asc(configVersions.artifactType), asc(configVersions.artifactId));
    const counts = canaries.length
      ? await db
          .select({
            candidateVersionId: configCanaryObservations.candidateVersionId,
            observed: count(),
            diverged: sql<number>`coalesce(sum(CASE WHEN ${configCanaryObservations.diverged} THEN 1 ELSE 0 END), 0)::int`,
            failed: sql<number>`coalesce(sum(CASE WHEN ${configCanaryObservations.failed} THEN 1 ELSE 0 END), 0)::int`,
          })
          .from(configCanaryObservations)
          .groupBy(configCanaryObservations.candidateVersionId)
      : [];
    const byId = new Map(counts.map((c) => [c.candidateVersionId, c]));
    return {
      canaries: canaries.map((c) => {
        const seen = byId.get(c.id);
        return {
          artifactType: c.artifactType,
          artifactId: c.artifactId,
          version: c.version,
          label: c.label,
          canaryPct: c.canaryPct,
          canaryMode: canaryModeOf(c.artifactType),
          observed: Number(seen?.observed ?? 0),
          diverged: Number(seen?.diverged ?? 0),
          failed: Number(seen?.failed ?? 0),
        };
      }),
      note:
        "`observed` counts SAMPLED decisions only — canaryPct is the shadow sampling rate, so a divergence " +
        "count is a count within the sample and never a fleet-wide total. An `inert` canaryMode means " +
        "nothing evaluates this artifact type at all and every count will stay zero.",
    };
  });

  app.get("/v1/config-versions/:artifactType/:artifactId/divergence", async (req) => {
    const { artifactType, artifactId } = artifactParam.parse(req.params);
    const versions = await loadVersions(db, artifactType, artifactId);
    const canary = versions.find((v) => v.status === "canary") ?? null;
    const active = versions.find((v) => v.status === "active") ?? null;

    const rows = canary
      ? await db
          .select()
          .from(configCanaryObservations)
          .where(eq(configCanaryObservations.candidateVersionId, canary.id))
          .orderBy(desc(configCanaryObservations.at))
          .limit(200)
      : [];
    const [totals] = canary
      ? await db
          .select({
            observed: count(),
            diverged: sql<number>`coalesce(sum(CASE WHEN ${configCanaryObservations.diverged} THEN 1 ELSE 0 END), 0)::int`,
            failed: sql<number>`coalesce(sum(CASE WHEN ${configCanaryObservations.failed} THEN 1 ELSE 0 END), 0)::int`,
          })
          .from(configCanaryObservations)
          .where(eq(configCanaryObservations.candidateVersionId, canary.id))
      : [{ observed: 0, diverged: 0, failed: 0 }];

    // The compliance cascade's candidate effect does NOT vary per request — it
    // is a pure function of the profile bodies and a project's tags — so it is
    // computed HERE, over the real projects, rather than written once per call
    // into an observation table as N identical rows.
    let projectImpact: Array<Record<string, unknown>> | null = null;
    let projectImpactNote: string | null = null;
    if (artifactType === "compliance_profile" && canary) {
      const [profile] = await db
        .select()
        .from(complianceProfiles)
        .where(eq(complianceProfiles.id, artifactId));
      if (profile) {
        const all = await db
          .select({ id: projects.id, name: projects.name, classifications: projects.classifications })
          .from(projects);
        const affected = all
          .filter((p) => ((p.classifications ?? []) as string[]).includes(profile.tag))
          .slice(0, 50);
        projectImpact = [];
        for (const p of affected) {
          const tags = (p.classifications ?? []) as string[];
          const activeSet = await complianceProfilesForTags(db, tags);
          const candidateSet = activeSet.map((row) =>
            row.id === artifactId ? applyRuleBody("compliance_profile", row, canary.body) : row,
          );
          const before = effectiveCompliancePolicy(activeSet) as Record<string, unknown>;
          const after = effectiveCompliancePolicy(candidateSet) as Record<string, unknown>;
          const changed = Object.keys(after).filter(
            (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
          );
          projectImpact.push({
            projectId: p.id,
            projectName: p.name,
            classifications: tags,
            diverged: changed.length > 0,
            changed,
            before,
            after,
          });
        }
        projectImpactNote =
          `Computed live from the candidate body against every project carrying '${profile.tag}' ` +
          `(first 50). This is NOT sampled and NOT stored — a compliance profile's effect does not vary ` +
          `per request, so recording one observation row per call would store the same answer repeatedly.`;
      }
    }

    return {
      artifactType,
      artifactId,
      canaryMode: canaryModeOf(artifactType),
      activeVersion: active?.version ?? null,
      candidateVersion: canary?.version ?? null,
      canaryPct: canary?.canaryPct ?? null,
      totals: {
        observed: Number(totals?.observed ?? 0),
        diverged: Number(totals?.diverged ?? 0),
        failed: Number(totals?.failed ?? 0),
      },
      observations: rows,
      projectImpact,
      projectImpactNote,
      note: canary
        ? canaryModeNote(artifactType) +
          " `observed` is the number of SAMPLED decisions, not the number of decisions — at " +
          `${canary.canaryPct}% roughly that share of callers are shadowed. A non-zero \`failed\` means the ` +
          "candidate's evaluation THREW on that decision: the served answer was unaffected, and the " +
          "comparison for that call did not happen — do not read `diverged` as complete while `failed` > 0."
        : "there is no canary on this artifact, so there is nothing to compare against the active version",
    };
  });
}
