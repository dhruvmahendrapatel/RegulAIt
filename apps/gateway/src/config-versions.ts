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
 * WHAT THE PARAGRAPH THAT USED TO END THIS HEADER SAID, AND WHY IT IS GONE:
 *   as shipped, rule/compliance versions were stored here and read by nothing
 *   — the kernels read their own tables and the shadow canary evaluated
 *   nothing. ADR-0073 (migration 0084) closed that: `governedEvaluate` and
 *   `profilesForTags` resolve the ACTIVE version of every loaded rule/profile
 *   through `rule-versions.ts`, and the candidate is genuinely evaluated in
 *   shadow. Batch B1 (2026-08-22) closed the last inert type the same way:
 *   `agent_config` resolves at the dispatch core (model + list price overlaid
 *   onto the agents row) with a shadow canary of its own. A stale disclaimer
 *   claiming none of this is wired would now be the opposite failure.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
  inArray,
  isNotNull,
  lt,
  orgSettings,
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
  assessCanaryBaseline,
  canaryIsLive,
  canaryModeNote,
  canaryModeOf,
  composeRuleBody,
  createConfigVersionSchema,
  evaluateBaselineFreshness,
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
  type BaselineBucket,
  type ResolvedVersion,
} from "@regulait/shared";
import { complianceProfilesForTags, effectiveCompliancePolicy } from "./projects.js";
import { agentEvidenceHoldRefused, EVIDENCE_HOLD_REFUSED, withAgentEvidenceHold } from "./agent-evidence-hold.js"; // D4 DFX2 (D4G-02): Art. 73(6) evidence hold

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
import { approvalRuleShape, assertApprovalRuleWritable } from "./approval-pool.js";

/**
 * A `Db` OR a transaction handle. Drizzle's transaction type is not assignable
 * to `NodePgDatabase`, so the helpers that must run in either context take the
 * structural subset they actually use.
 *
 * It exists for ADR-0074: `activateVersion` writes the read-model INSIDE its own
 * transaction now. Doing it afterwards — as ADR-0048 shipped it — meant a crash
 * between COMMIT and the row write left the row disagreeing with the active
 * version, which is precisely the divergence ADR-0074 exists to remove. A fix
 * that closed the application-code path while leaving a crash window open would
 * not have closed the class.
 */
export type DbOrTx = Pick<Db, "select" | "update" | "insert">;

/**
 * ADR-0074 AMENDMENT (2026-08-09) — the same structural trick, widened for the
 * helpers that must also OPEN a transaction: `newVersion` and `activateVersion`
 * now serialize on the artifact's own row, so they need `transaction`.
 *
 * Satisfied by the top-level `Db` and by a drizzle transaction handle alike.
 * `tx.transaction()` opens a SAVEPOINT rather than a second connection, so the
 * nesting `applyRuleEdit → newVersion → activateVersion` runs in ONE database
 * transaction, and ADR-0060's audit-chain wrapper propagates through every
 * level of it.
 */
export type DbOrTxDeep = Pick<Db, "select" | "update" | "insert" | "transaction">;

/**
 * AER-035 (2026-09-27) — the same structural trick for the helpers a caller
 * must be able to run INSIDE its own transaction, including the ones that
 * DELETE. The copilot's proposal applier now runs its consent check, its
 * mutation, its applied marker and its audit row as one transaction over a
 * locked proposal, and every choke point it calls has to be able to join that
 * transaction rather than opening a second connection beside it.
 */
export type DbOrTxWrite = Pick<Db, "select" | "update" | "insert" | "delete">;

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
  /** batch B1 — `agent_config` versions overlay the `agents` row (its
   * versionable fields: model + the two list-price columns), so the agents
   * table is its baseline source and read-model exactly as a rule's own table
   * is for a rule. `writeRuleReadModel` filters through
   * VERSIONED_RULE_FIELDS, so activation can never touch provider, tier,
   * lifecycle or any other governance/identity column. */
  agent_config: agents,
} as const;

type RuleArtifactType = keyof typeof RULE_TABLES;

/** the composite key an artifact is identified by — `artifact_id` alone is not
 * unique, because it is polymorphic across five types */
const key = (t: ConfigArtifactType, id: string) => `${t}:${id}`;

export function ruleTableFor(t: ConfigArtifactType) {
  return (RULE_TABLES as Record<string, (typeof RULE_TABLES)[RuleArtifactType] | undefined>)[t];
}

export async function loadRuleRow(
  db: DbOrTx,
  artifactType: ConfigArtifactType,
  artifactId: string,
  opts?: { forUpdate?: boolean },
): Promise<Record<string, unknown> | null> {
  const table = ruleTableFor(artifactType);
  if (!table) return null;
  const q = db.select().from(table).where(eq(table.id, artifactId));
  const [row] = await (opts?.forUpdate ? q.for("update") : q);
  return (row as Record<string, unknown> | undefined) ?? null;
}

/**
 * ADR-0074 AMENDMENT (2026-08-09) — SERIALIZE EVERY WRITER OF ONE ARTIFACT ON
 * THAT ARTIFACT'S OWN ROW.
 *
 * ADR-0074 as accepted closed the "a writer forgot to mint a version" class but
 * left every one of its own reads UNLOCKED, which reintroduced the same
 * end-state — an admin's edit silently discarded — through a narrower window:
 *
 *   T1 `applyRuleEdit` reads versions, finds NONE, and plans a plain row write
 *      (invariant 4).
 *   T2 `newVersion` for the same artifact captures the lazy v1 baseline from the
 *      row as T1 read it, and activates it.
 *   T1 writes the row. T2's `writeRuleReadModel` — or the next activation —
 *      overwrites it, and the minted v1 does not contain T1's edit either.
 *
 * The natural mutex is the artifact's OWN ROW, exactly as ADR-0064's scheduler
 * claim locks the job row: `SELECT … FOR UPDATE` on `config_versions` cannot
 * work here because the decisive case is `versions.length === 0`, and an empty
 * result set locks nothing. The rule row, by contrast, always exists — every one
 * of these paths 404s without it — so it is a lock that is there to take before
 * the first version ever is.
 *
 * BLOCKING, not `SKIP LOCKED`: the loser must apply its edit on top of the
 * winner's state, not decline to.
 *
 * LOCK ORDER, stated so it stays true: this lock is always taken BEFORE
 * ADR-0060's global audit-chain advisory lock, never after. Every path that
 * takes both (`applyRuleEdit`, `newVersion`) takes this one as its first
 * statement, so the two cannot form a cycle.
 *
 * `agent_system_prompt` has no rule row and is therefore NOT serialized here —
 * see the ADR amendment's residual list.
 */
export async function lockRuleArtifact(
  tx: DbOrTx,
  artifactType: ConfigArtifactType,
  artifactId: string,
): Promise<void> {
  if (!isRuleArtifact(artifactType)) return;
  await loadRuleRow(tx, artifactType, artifactId, { forUpdate: true });
}

/**
 * WRITE THE ACTIVE BODY BACK ONTO THE ARTIFACT'S OWN ROW — the read-model half,
 * and per ADR-0074 the ONLY thing in the codebase permitted to write an
 * enforcing column of a rule table. Every other would-be writer goes through
 * `applyRuleEdit` (`rule-writes.ts`), which mints a version and lets THIS
 * function produce the row write as a consequence. `rule-write-guard.test.ts`
 * enumerates the exceptions and fails when an un-audited one appears.
 *
 * Only versionable fields are ever written, so it can never touch a selection
 * or identity column.
 */
export async function writeRuleReadModel(
  db: DbOrTx,
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
  db: DbOrTx,
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
  db: Pick<Db, "insert">,
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
 *
 * ADR-0074 AMENDMENT (2026-08-09): the whole body now runs in ONE transaction,
 * opened here, whose first statement takes `lockRuleArtifact`. Two reasons, and
 * the second is the one that made it necessary:
 *
 *  - the LAZY v1 BASELINE reads the rule row and mints it as the artifact's
 *    first active version. Read unlocked, it races an `applyRuleEdit` that saw
 *    `versions.length === 0` and is about to write the row directly, and the
 *    admin's edit is discarded — the defect ADR-0074 exists to remove, arrived
 *    at through concurrency instead of through a forgetful writer;
 *  - "mint" and "activate" become atomic, so a crash between them can no longer
 *    leave an artifact with version rows and no active one, which
 *    `resolveForShadow` treats as unresolvable and DENIES fleet-wide.
 *
 * Called from inside `applyRuleEdit`'s transaction this opens a SAVEPOINT and
 * re-takes a row lock the enclosing transaction already holds — both are no-ops,
 * which is why the nesting is safe rather than merely tolerated.
 */
export async function newVersion(
  db: DbOrTxDeep,
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
  return db.transaction(async (tx) => mintVersionLocked(tx, args));
}

async function mintVersionLocked(
  db: DbOrTxDeep,
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
  // FIRST STATEMENT. Everything below reads state that a concurrent writer of
  // the same artifact could otherwise move underneath it.
  await lockRuleArtifact(db, args.artifactType, args.artifactId);
  // ADR-0186 A — THE ONE GUARD: an approval-rule version whose pool could never
  // reach its quorum is refused when it is written (draft or active)
  if (args.artifactType === "approval_rule") {
    const ruleRow = await loadRuleRow(db, args.artifactType, args.artifactId);
    if (ruleRow) await assertApprovalRuleWritable(db, approvalRuleShape({ ...ruleRow, ...args.body }));
  }
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
 *
 * ADR-0074 AMENDMENT (2026-08-09): the version set is now read INSIDE the
 * transaction, after `lockRuleArtifact`. Read outside it, the pointer move was
 * decided from a snapshot a concurrent activation could already have
 * invalidated — two activations could each demote the other's target, and an
 * `applyRuleEdit` that had just concluded "no versions, write the row" could
 * have its write overwritten by the read-model write below.
 */
export async function activateVersion(
  db: DbOrTxDeep,
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
  const outcome = await db.transaction(async (tx) => {
    // FIRST STATEMENT — see `lockRuleArtifact`. Everything read below is read
    // under it, so the pointer move is decided from state nobody else can move.
    await lockRuleArtifact(tx, args.artifactType, args.artifactId);
    const versions = await loadVersions(tx, args.artifactType, args.artifactId);
    const target = versions.find((v) => v.version === args.version);
    if (!target) throw new Error("unknown_version");
    // ADR-0186 A — THE ONE GUARD, again at activation (rollback and canary
    // promotion included): membership may have moved since the version was minted
    if (args.artifactType === "approval_rule") {
      const ruleRow = await loadRuleRow(tx, args.artifactType, args.artifactId);
      if (ruleRow) {
        await assertApprovalRuleWritable(tx, approvalRuleShape({ ...ruleRow, ...(target.body as Record<string, unknown>) }));
      }
    }
    const previous = versions.find((v) => v.status === "active") ?? null;
    const rollback = previous != null && previous.version > target.version;

    // ADR-0074 — THE BASELINE SEAM. If a shadow canary is running on this
    // artifact, moving the active version moves the baseline every observation
    // already collected was measured against. The canary is NOT invalidated and
    // the edit is NOT refused (a measurement may not veto a policy change); the
    // seam is RECORDED here, timestamped, so an operator reading the ledger can
    // see where the comparison changed meaning. The refusal lands on the
    // PROMOTION instead — see the stale-baseline gate on POST …/promote.
    const inFlightCanary = versions.find((v) => v.status === "canary" && v.id !== target.id) ?? null;
    const seamNote = inFlightCanary
      ? ` — activated while version ${inFlightCanary.version} was canarying at ${inFlightCanary.canaryPct ?? 0}%, ` +
        `so the shadow comparison baseline moved here`
      : "";

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
      reason: `${args.promotion?.reason ?? args.reason ?? ""}${seamNote}` || null,
      evalRunId: args.promotion?.evalRunId ?? null,
      override: args.promotion?.override ?? false,
    });

    // ADR-0023/0044/0045 COMPOSITION: `agents.systemPrompt` becomes a READ-MODEL
    // of the active version, refreshed here on every pointer move. It is what the
    // agents API returns, what the ADR-0044 eval harness hashes into
    // `eval_runs.system_prompt_hash`, and what an admin reads in the SPA — so a
    // new prompt version is visible to both of those without either learning
    // about this table. DISPATCH never trusts it: `resolveAgentPromptVersion`
    // reads `config_versions` whenever any version row exists, which is the only
    // way the canary can serve a different body than the active one.
    //
    // ADR-0074 moved BOTH read-model writes INSIDE this transaction. They used to
    // run after it committed, which meant a crash in that window left the row
    // disagreeing with the active version — the exact divergence ADR-0074 exists
    // to remove, reachable without any bad writer being involved.
    if (args.artifactType === "agent_system_prompt") {
      await tx
        .update(agents)
        .set({ systemPrompt: promptFromBody(row!.body) })
        .where(eq(agents.id, args.artifactId));
    }
    // ADR-0073: the SAME read-model discipline for rule/compliance artifacts. The
    // rule's own row is rewritten to the newly-active body, so every listing
    // surface shows what is enforced. This is a convenience for READERS — the
    // kernel resolves through `config_versions`, so a rollback would change
    // evaluation even if this write had never happened.
    await writeRuleReadModel(tx, args.artifactType, args.artifactId, row!.body);
    return { updated: row!, target, previous, rollback, inFlightCanary, seamNote };
  });

  const { updated, target, previous, rollback, inFlightCanary, seamNote } = outcome;

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
          (args.reason ? `: ${args.reason}` : "") +
          seamNote,
    {
      artifactType: args.artifactType,
      to: target.version,
      from: previous?.version ?? null,
      rollback,
      ...(inFlightCanary
        ? { canaryBaselineMoved: { candidateVersion: inFlightCanary.version, canaryPct: inFlightCanary.canaryPct } }
        : {}),
      ...(args.promotion
        ? { promotion: true, evalRunId: args.promotion.evalRunId, override: args.promotion.override }
        : {}),
    },
    rollback ? "deny" : "allow",
  );
  return { target: updated, previous, rollback };
}

// ---------------------------------------------------------------------------
// Batch B1 (ADR-0073 residual) — DELETING a rule artifact through the ordinary
// CRUD surface, with the tombstone ADR-0074 §5 scoped.
// ---------------------------------------------------------------------------

export interface RuleDeleteRefusal {
  ok: false;
  status: 404;
  error: string;
  detail: string;
}

export interface RuleDeleteSuccess {
  ok: true;
  /** version pointers demoted out of the active/canary space */
  versionsRetired: number;
  /** total stored versions this artifact leaves behind (all kept) */
  versionCount: number;
  note: string;
}

/**
 * Delete ONE rule artifact, and leave its version history TRUE.
 *
 * THE SEMANTICS, decided here and pinned by tests (the brief's "an active
 * version pointing at nothing" question):
 *
 *  - The rule ROW is deleted. The next evaluation simply never loads it — the
 *    scoped SQL pre-filter is what makes a deleted rule unenforceable, with or
 *    without versions.
 *  - Every `config_versions` row is KEPT. They are the record of what governed
 *    the calls made while the rule existed (ADR-0048 property 1: immutable
 *    history), and deleting them to tidy a dashboard is ADR-0072 §4's rejected
 *    alternative.
 *  - The `active`/`canary` POINTERS are demoted to `retired` (canaryPct
 *    nulled), each demotion appended to the activation ledger as
 *    `artifact_deleted`. This is the tombstone ADR-0074 §5 named as the
 *    correct end state: after an explicit delete, no version claims to be
 *    active or canarying for an artifact that no longer exists, the canaries
 *    index stops listing a comparison that can never accumulate another
 *    observation, and `resolveForShadow`'s fail-closed branch stays reserved
 *    for corruption instead of firing on ordinary housekeeping.
 *  - NOT `superseded` (means "replaced by a newer active") and NOT
 *    `rolled_back` (means "an older version was re-activated") — either would
 *    misstate history, the same reasoning that keeps a displaced canary at
 *    `draft`.
 *
 * One transaction, behind the artifact's own row lock, exactly like
 * `applyRuleEdit`: a delete racing a mint must serialize, not interleave.
 *
 * SCOPE, disclosed: this covers the EXPLICIT route only. A rule that vanishes
 * through an FK cascade (deleting its user/server/role/team/approver) still
 * leaves its pointers intact — that path needs the per-table AFTER DELETE
 * trigger ADR-0074 §5 scoped as its own slice, and the read surfaces disclose
 * those orphans with `artifactDeleted: true` exactly as before.
 */
export async function deleteRuleArtifact(
  db: Db,
  args: {
    artifactType: ConfigArtifactType;
    artifactId: string;
    actorUserId: string | null;
    /** names the route in the ledger and the audit row */
    routeLabel: string;
  },
): Promise<RuleDeleteSuccess | RuleDeleteRefusal> {
  const table = ruleTableFor(args.artifactType);
  if (!table) {
    return {
      ok: false,
      status: 404,
      error: "not_a_rule_artifact",
      detail: `${args.artifactType} has no rule table, so there is nothing to delete here`,
    };
  }
  return db.transaction(async (tx) => {
    await lockRuleArtifact(tx, args.artifactType, args.artifactId);
    const row = await loadRuleRow(tx, args.artifactType, args.artifactId);
    if (!row) {
      return {
        ok: false as const,
        status: 404 as const,
        error: "unknown_rule",
        detail: `no ${args.artifactType} with id ${args.artifactId} exists`,
      };
    }
    const versions = await loadVersions(tx, args.artifactType, args.artifactId);
    const pointers = versions.filter((v) => v.status === "active" || v.status === "canary");
    for (const v of pointers) {
      await tx
        .update(configVersions)
        .set({ status: "retired", canaryPct: null })
        .where(eq(configVersions.id, v.id));
      await tx.insert(configActivationEvents).values({
        artifactType: args.artifactType,
        artifactId: args.artifactId,
        versionId: v.id,
        version: v.version,
        action: "artifact_deleted",
        actorUserId: args.actorUserId,
        reason:
          `${args.routeLabel}: the ${args.artifactType} this ` +
          `${v.status === "canary" ? `canary (at ${v.canaryPct}%)` : "active version"} belonged to was ` +
          `deleted — the version row is kept (status 'retired') as the record of what governed calls ` +
          `while the rule existed, and it can never enforce again`,
      });
    }
    await tx.delete(table).where(eq(table.id, args.artifactId));

    const note =
      versions.length === 0
        ? `${args.artifactType} deleted. It had no stored versions, so there is no history to keep.`
        : `${args.artifactType} deleted. Its ${versions.length} stored version(s) are KEPT — ` +
          `${pointers.length} pointer(s) demoted to 'retired' and ledgered as 'artifact_deleted' — because ` +
          `they are the record of what governed the calls made while the rule existed. Nothing about them ` +
          `can ever enforce again: a deleted rule is never loaded by any evaluation.`;

    await tx.insert(auditLog).values({
      userId: args.actorUserId ?? NO_IDENTITY,
      objectType: "restriction_rule",
      objectId: args.artifactId,
      detail: {
        phase: "rule-delete",
        artifactType: args.artifactType,
        versionCount: versions.length,
        versionsRetired: pointers.map((p) => ({ version: p.version, was: p.status })),
      },
      effect: "allow",
      ruleId: "rule-deleted",
      ruleChain: [],
      reason: `${args.routeLabel}: ${note}`,
    });

    return { ok: true as const, versionsRetired: pointers.length, versionCount: versions.length, note };
  });
}

// ---------------------------------------------------------------------------
// Batch B7c (ADR-0073 disclosure 5 — "no pruning") — the retention sweep over
// `config_canary_observations`, and NOTHING else.
// ---------------------------------------------------------------------------

export interface CanaryObservationPruneResult {
  pruned: number;
  retainedDays: number;
  /** ISO timestamp: rows recorded before this were eligible */
  cutoff: string;
  /** rows OLDER than the cutoff that were kept anyway, because their candidate
   * version is currently in CANARY status — an active canary's evidence is
   * live evidence, and pruning it would empty the divergence report an
   * operator is about to promote on */
  keptLiveCanary: number;
}

/**
 * One retention pass over the shadow canary's output.
 *
 * THE BOUNDARY, stated as hard as it can be: this prunes
 * `config_canary_observations` rows ONLY. It NEVER touches `config_versions` —
 * version history is the audit substrate (rollback re-points at version rows,
 * the activation ledger references them, the usage stamp names them), and
 * pruning a version would break rollback and the ledger. There is no code path
 * from this function to that table except the read that PROTECTS observations
 * of a live canary.
 *
 * Two callers, one implementation (ADR-0064 §7's extract-don't-duplicate):
 * the `canary-observation-prune-sweep` scheduler job — which inherits the
 * scheduler's own off-by-default posture, so a fresh install prunes nothing
 * until an operator opts in — and `POST /v1/config-versions/observations/prune`,
 * the manual/cron door every other sweep also keeps.
 *
 * Every pass writes ONE audited fact of what it pruned (count + cutoff +
 * what was protected), in the `runAuditPruneOnce` style.
 */
export async function runCanaryObservationPrune(
  db: Db,
  opts: { actorUserId: string | null; now?: Date } = { actorUserId: null },
): Promise<CanaryObservationPruneResult> {
  const now = opts.now ?? new Date();
  // read the knob straight off the singleton row rather than through
  // org-settings.ts — that module reaches this one via rule-writes, and a
  // require cycle is not worth one helper call. Missing row = the column
  // default, so a pre-seed database still gets the generous 90 days.
  const [org] = await db
    .select({ days: orgSettings.canaryObservationRetentionDays })
    .from(orgSettings);
  const retainedDays = Math.max(1, org?.days ?? 90);
  const cutoff = new Date(now.getTime() - retainedDays * 24 * 3600 * 1000);

  // "belongs to a version currently in CANARY status" — checked at delete
  // time, inside the DELETE's own WHERE, so there is no window in which a
  // canary started mid-pass loses its old evidence.
  const liveCanaryGuard = sql`exists (select 1 from ${configVersions} where ${configVersions.id} = ${configCanaryObservations.candidateVersionId} and ${configVersions.status} = 'canary')`;

  const [protectedRow] = await db
    .select({ n: count() })
    .from(configCanaryObservations)
    .where(and(lt(configCanaryObservations.at, cutoff), liveCanaryGuard));
  const keptLiveCanary = Number(protectedRow?.n ?? 0);

  const deleted = await db
    .delete(configCanaryObservations)
    .where(and(lt(configCanaryObservations.at, cutoff), sql`not (${liveCanaryGuard})`))
    .returning({ id: configCanaryObservations.id });

  await db.insert(auditLog).values({
    userId: opts.actorUserId ?? NO_IDENTITY,
    objectType: "config_version",
    objectId: null,
    detail: {
      phase: "canary-observation-prune",
      pruned: deleted.length,
      retainedDays,
      cutoff: cutoff.toISOString(),
      keptLiveCanary,
    },
    effect: "allow",
    ruleId: "canary-observations-pruned",
    ruleChain: [],
    reason:
      `pruned ${deleted.length} shadow-canary observation row(s) older than ${retainedDays}d ` +
      `(cutoff ${cutoff.toISOString()}); ${keptLiveCanary} older row(s) kept because their candidate ` +
      `is a LIVE canary. config_versions themselves are never pruned — version history is the ` +
      `audit substrate.`,
  });

  return { pruned: deleted.length, retainedDays, cutoff: cutoff.toISOString(), keptLiveCanary };
}

// ---------------------------------------------------------------------------
// Batch B8b (ADR-0073 disclosures 6+7) — the compliance-profile shadow becomes
// STORED HISTORY, and the stored rows feed ADR-0059's blast-radius preview.
// ---------------------------------------------------------------------------

/**
 * ADR-0073 disclosure 6's cap — a DISCLOSED bound, deliberately unchanged by
 * B8b: the profile shadow examines the first 50 projects carrying the tag and
 * a 51st is not shown. What B8b changes is that the bound is now VISIBLE IN
 * DATA: every persisted observation records how many tagged projects existed,
 * how many were examined, and whether the cap truncated the examination.
 */
export const PROFILE_IMPACT_PROJECT_CAP = 50;

/** deterministic serialization (object keys sorted, recursively) so the same
 * comparison always fingerprints to the same value across page refreshes */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** the compact effect string a profile observation stores: the changed cascade
 * dimensions with that side's values, or a shared marker when nothing moved —
 * so `servedEffect !== candidateEffect` exactly when `diverged` */
function cascadeEffect(changed: string[], policy: Record<string, unknown>): string {
  return changed.length === 0
    ? "cascade-unchanged"
    : `cascade:{${changed.map((k) => `${k}=${JSON.stringify(policy[k])}`).join(",")}}`;
}

export interface ProfileImpactProjectRow {
  projectId: string;
  projectName: string;
  classifications: string[];
  diverged: boolean;
  changed: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface ProfileImpactResult {
  tag: string;
  impact: ProfileImpactProjectRow[];
  taggedProjects: number;
  examinedProjects: number;
  capApplied: boolean;
  /** observation rows newly persisted by THIS computation */
  recorded: number;
  /** comparisons skipped because an identical observation already exists */
  deduplicated: number;
}

/**
 * B8b — CLOSE OF ADR-0073 DISCLOSURE 7. The per-project comparison the
 * divergence report used to compute at read time and throw away is now
 * PERSISTED at the same computation site (write-through on read — the
 * extract-don't-duplicate move: one implementation, called where the
 * computation already lived, not a second sweep that could drift from it).
 *
 * THE DEDUP KEY, stated: one observation per
 * (candidateVersionId, projectId, fingerprint), where the fingerprint is a
 * sha256 over the stable serialization of
 * { activeVersionId, classifications, before, after } — i.e. the IDENTITY OF
 * THE COMPARISON. Refreshing the page recomputes and matches the stored
 * fingerprint, so it writes nothing; the baseline moving (a new active
 * version), the project's tag set changing, or the cascade outcome changing
 * each produce a NEW fingerprint and a new row, with the old row KEPT — that
 * is precisely the history disclosure 7 said did not exist.
 *
 * NON-diverged comparisons are recorded too (diverged=false), exactly as the
 * rule shadow records non-diverged samples: the rows are the record of WHICH
 * projects were examined, which is what makes the 50-project cap visible in
 * data instead of only in prose.
 *
 * The INSERT is awaited and a failure propagates loudly (ADR-0073 §"the
 * shadow pass is INLINE" reasoning: a fire-and-forget measurement is one
 * whose failures nobody sees).
 */
export async function computeAndRecordProfileImpact(
  db: Db,
  args: { artifactId: string; canary: ConfigVersionRow; active: ConfigVersionRow | null },
): Promise<ProfileImpactResult | null> {
  const [profile] = await db
    .select()
    .from(complianceProfiles)
    .where(eq(complianceProfiles.id, args.artifactId));
  if (!profile) return null;
  const all = await db
    .select({ id: projects.id, name: projects.name, classifications: projects.classifications })
    .from(projects);
  const tagged = all.filter((p) => ((p.classifications ?? []) as string[]).includes(profile.tag));
  const affected = tagged.slice(0, PROFILE_IMPACT_PROJECT_CAP);

  const computed: Array<ProfileImpactProjectRow & { fingerprint: string }> = [];
  for (const p of affected) {
    const tags = (p.classifications ?? []) as string[];
    const activeSet = await complianceProfilesForTags(db, tags);
    const candidateSet = activeSet.map((row) =>
      row.id === args.artifactId ? applyRuleBody("compliance_profile", row, args.canary.body) : row,
    );
    const before = effectiveCompliancePolicy(activeSet) as Record<string, unknown>;
    const after = effectiveCompliancePolicy(candidateSet) as Record<string, unknown>;
    const changed = Object.keys(after).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    computed.push({
      projectId: p.id,
      projectName: p.name,
      classifications: tags,
      diverged: changed.length > 0,
      changed,
      before,
      after,
      fingerprint: createHash("sha256")
        .update(
          stableStringify({
            activeVersionId: args.active?.id ?? null,
            classifications: tags,
            before,
            after,
          }),
        )
        .digest("hex"),
    });
  }

  const existing = computed.length
    ? await db
        .select({
          projectId: configCanaryObservations.projectId,
          fingerprint: sql<string | null>`${configCanaryObservations.detail} ->> 'fingerprint'`,
        })
        .from(configCanaryObservations)
        .where(eq(configCanaryObservations.candidateVersionId, args.canary.id))
    : [];
  const seen = new Set(
    existing.filter((e) => e.projectId && e.fingerprint).map((e) => `${e.projectId}|${e.fingerprint}`),
  );
  const fresh = computed.filter((c) => !seen.has(`${c.projectId}|${c.fingerprint}`));
  if (fresh.length > 0) {
    await db.insert(configCanaryObservations).values(
      fresh.map((c) => ({
        artifactType: "compliance_profile" as const,
        artifactId: args.artifactId,
        candidateVersionId: args.canary.id,
        candidateVersion: args.canary.version,
        activeVersionId: args.active?.id ?? null,
        activeVersion: args.active?.version ?? null,
        // the pct in force when recorded, for provenance — the profile shadow
        // is EXHAUSTIVE over the examined projects, never sampled, so this is
        // not a sampling rate here and `bucket` is null
        canaryPct: args.canary.canaryPct,
        bucket: null,
        userId: null,
        serverId: null,
        toolName: null,
        projectId: c.projectId,
        servedEffect: cascadeEffect(c.changed, c.before),
        servedRuleId: "compliance-cascade",
        servedReason:
          `effective §8.3 cascade for project '${c.projectName}' under the ACTIVE profile set` +
          (c.diverged
            ? ` — differs from the candidate on ${c.changed.join(", ")}`
            : " — identical under the candidate"),
        candidateEffect: cascadeEffect(c.changed, c.after),
        candidateRuleId: "compliance-cascade",
        candidateReason:
          `effective §8.3 cascade for project '${c.projectName}' with candidate v${args.canary.version} ` +
          `of '${profile.tag}' overlaid` +
          (c.diverged ? ` — moves ${c.changed.join(", ")}` : " — identical to the served cascade"),
        diverged: c.diverged,
        failed: false,
        failureReason: null,
        detail: {
          source: "profile-shadow-read-through",
          fingerprint: c.fingerprint,
          projectName: c.projectName,
          classifications: c.classifications,
          changed: c.changed,
          before: c.before,
          after: c.after,
          taggedProjects: tagged.length,
          examinedProjects: affected.length,
          projectCap: PROFILE_IMPACT_PROJECT_CAP,
          capApplied: tagged.length > PROFILE_IMPACT_PROJECT_CAP,
        },
      })),
    );
  }

  return {
    tag: profile.tag,
    impact: computed.map(({ fingerprint: _fp, ...row }) => row),
    taggedProjects: tagged.length,
    examinedProjects: affected.length,
    capApplied: tagged.length > PROFILE_IMPACT_PROJECT_CAP,
    recorded: fresh.length,
    deduplicated: computed.length - fresh.length,
  };
}

export interface ProfileCanaryDivergenceReport {
  artifactId: string;
  tag: string | null;
  candidateVersionId: string;
  candidateVersion: number;
  /** the baseline the latest stored comparison was made against */
  activeVersion: number | null;
  canaryPct: number | null;
  /** distinct projects with a stored observation for this candidate */
  observedProjects: number;
  divergedCount: number;
  divergedProjects: Array<{
    projectId: string | null;
    projectName: string | null;
    changed: unknown;
    servedEffect: string | null;
    candidateEffect: string | null;
    before: unknown;
    after: unknown;
    recordedAt: string;
  }>;
}

/**
 * B8b — THE FEED ADR-0073 DISCLOSURE 8 NAMED AND NEVER WIRED. Read-only
 * reporting for ADR-0059's blast-radius preview: every compliance-profile
 * candidate whose STORED observations record at least one diverged project,
 * with the diverged projects and both sides' effects — read from
 * `config_canary_observations` ONLY, never recomputed in the preview path
 * (delete the stored rows and this reports nothing, however divergent a live
 * recomputation would be). One entry per project — the LATEST stored
 * comparison; superseded fingerprints stay in the table as history but do not
 * double-count here. Returns [] when no candidate has recorded divergence,
 * which is the signal to leave the preview response byte-identical.
 */
export async function loadComplianceProfileCanaryDivergence(
  db: Db,
): Promise<ProfileCanaryDivergenceReport[]> {
  const canaries = await db
    .select()
    .from(configVersions)
    .where(
      and(eq(configVersions.artifactType, "compliance_profile"), eq(configVersions.status, "canary")),
    )
    .orderBy(asc(configVersions.artifactId));
  if (canaries.length === 0) return [];
  const obs = await db
    .select()
    .from(configCanaryObservations)
    .where(
      inArray(
        configCanaryObservations.candidateVersionId,
        canaries.map((c) => c.id),
      ),
    )
    .orderBy(desc(configCanaryObservations.at));

  const reports: ProfileCanaryDivergenceReport[] = [];
  for (const c of canaries) {
    const mine = obs.filter((o) => o.candidateVersionId === c.id && o.projectId != null);
    const latestPerProject = new Map<string, (typeof mine)[number]>();
    for (const o of mine) if (!latestPerProject.has(o.projectId!)) latestPerProject.set(o.projectId!, o);
    const diverged = [...latestPerProject.values()].filter((o) => o.diverged);
    if (diverged.length === 0) continue;
    const [profile] = await db
      .select({ tag: complianceProfiles.tag })
      .from(complianceProfiles)
      .where(eq(complianceProfiles.id, c.artifactId));
    reports.push({
      artifactId: c.artifactId,
      tag: profile?.tag ?? null,
      candidateVersionId: c.id,
      candidateVersion: c.version,
      activeVersion: diverged[0]!.activeVersion ?? null,
      canaryPct: c.canaryPct,
      observedProjects: latestPerProject.size,
      divergedCount: diverged.length,
      divergedProjects: diverged.map((o) => ({
        projectId: o.projectId,
        projectName: (o.detail?.projectName as string | undefined) ?? null,
        changed: o.detail?.changed ?? null,
        servedEffect: o.servedEffect,
        candidateEffect: o.candidateEffect,
        before: o.detail?.before ?? null,
        after: o.detail?.after ?? null,
        recordedAt: o.at.toISOString(),
      })),
    });
  }
  return reports;
}

// ---------------------------------------------------------------------------
// Routes (admin-only via app.ts's DEFAULT gate)
// ---------------------------------------------------------------------------

export function registerConfigVersionRoutes(app: FastifyInstance, db: Db): void {
  /** D4 DFX2 (D4G-02) — the Art. 73(6) evidence hold on every write that
   * changes what an AGENT serves or is measured against: activating a new
   * version, activating or rolling back to another, starting, re-pointing or
   * abandoning a canary, promoting one. Rule artifacts are not agents and are
   * not held. Same 409 and audited admin override as the agents routes
   * (`agent-evidence-hold.ts` -> `incidentEvidenceHoldRefused`). */
  const agentHoldRefused = (
    req: FastifyRequest,
    reply: FastifyReply,
    artifactType: ConfigArtifactType,
    artifactId: string,
    verb: string,
  ): Promise<boolean> =>
    artifactType === "agent_system_prompt" || artifactType === "agent_config"
      ? agentEvidenceHoldRefused(db, req, reply, artifactId, `${verb} of ${artifactType} (config versions)`)
      : Promise.resolve(false);
  /** X15-H01 — the write a held route performs, in ONE transaction with the hold re-checked inside it and
   * serialised with hold creation (`withAgentEvidenceHold`); a rule artifact's write runs as before. */
  const agentHeldWrite = <T>(
    req: FastifyRequest,
    reply: FastifyReply,
    artifactType: ConfigArtifactType,
    artifactId: string,
    verb: string,
    write: (tx: Db) => Promise<T>,
  ): Promise<T | typeof EVIDENCE_HOLD_REFUSED> =>
    artifactType === "agent_system_prompt" || artifactType === "agent_config"
      ? withAgentEvidenceHold(db, req, reply, artifactId, `${verb} of ${artifactType} (config versions)`, write)
      : write(db);
  /** Batch B7c — the manual door for the observation-retention sweep, exactly
   * as every ADR-0064 sweep keeps one (POST /v1/mrm/expiry-sweep etc.). Calls
   * the SAME function the scheduler job calls. Static segment, so it can never
   * be captured by the :artifactType routes below (and "observations" is not a
   * legal artifactType anyway). */
  app.post("/v1/config-versions/observations/prune", async (req) => {
    const result = await runCanaryObservationPrune(db, {
      actorUserId: req.authCtx.userId ?? null,
    });
    return {
      ...result,
      note:
        "Prunes config_canary_observations ONLY, and never an observation whose candidate is a live " +
        "canary. config_versions are NEVER pruned — version history is the audit substrate. The " +
        "ADR-0064 scheduler job runs this same function when REGULAIT_SCHEDULER=on (off by default); " +
        "this endpoint stays the manual/cron door.",
    };
  });

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
    // ADR-0074 — DOES THE ARTIFACT STILL EXIST? `config_versions.artifact_id`
    // is polymorphic and therefore has no FK, while the rule tables cascade on
    // their subject columns — so deleting a user, server, role, team or approver
    // deletes the rule and leaves its versions behind, one of them still
    // `active`. Before this, GET on a deleted artifact returned a full lineage
    // with an active version and a canary mode: a 200 that reads as a live
    // governed artifact. The versions are deliberately NOT deleted (destroying
    // the record of what governed the calls made while the rule existed is not
    // something a governance product gets to do) — the surface says so instead.
    const artifactDeleted = isRuleArtifact(artifactType)
      ? (await loadRuleRow(db, artifactType, artifactId)) == null
      : (await db.select({ id: agents.id }).from(agents).where(eq(agents.id, artifactId))).length === 0;
    return {
      artifactType,
      artifactId,
      versions,
      active,
      canary,
      history: events,
      artifactDeleted,
      artifactDeletedNote: artifactDeleted
        ? "The artifact these versions describe NO LONGER EXISTS. The version rows and the activation ledger " +
          "are kept deliberately — they are the record of what governed the calls made while it existed — but " +
          "nothing here can ever enforce again, and a canary listed against it will never accumulate another " +
          "observation."
        : null,
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
    // a draft (activate: false) changes nothing that serves; activating it does
    if (body.activate && (await agentHoldRefused(req, reply, artifactType, artifactId, "create and activate a version"))) return reply;
    const create = (on: Db) =>
      newVersion(on, {
        artifactType,
        artifactId,
        body: body.body,
        label: body.label ?? null,
        authorUserId: req.authCtx.userId ?? null,
        activate: body.activate,
      });
    const res = body.activate ? await agentHeldWrite(req, reply, artifactType, artifactId, "create and activate a version", create) : await create(db);
    if (res === EVIDENCE_HOLD_REFUSED) return reply;
    return reply.status(201).send({ version: res.version, activated: res.activated });
  });

  app.post("/v1/config-versions/:artifactType/:artifactId/activate", async (req, reply) => {
    const { artifactType, artifactId } = artifactParam.parse(req.params);
    const body = activateConfigVersionSchema.parse(req.body);
    const versions = await loadVersions(db, artifactType, artifactId);
    if (!versions.some((v) => v.version === body.version)) {
      return reply.status(404).send({ error: "unknown_version" });
    }
    if (await agentHoldRefused(req, reply, artifactType, artifactId, `activate version ${body.version}`)) return reply;
    const res = await agentHeldWrite(req, reply, artifactType, artifactId, `activate version ${body.version}`, (on) =>
      activateVersion(on, {
        artifactType,
        artifactId,
        version: body.version,
        actorUserId: req.authCtx.userId ?? null,
        reason: body.reason ?? null,
      }),
    );
    if (res === EVIDENCE_HOLD_REFUSED) return reply;
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
    if (await agentHoldRefused(req, reply, artifactType, artifactId, `roll back to version ${lastMove.fromVersion}`)) return reply;
    const res = await agentHeldWrite(req, reply, artifactType, artifactId, `roll back to version ${lastMove.fromVersion}`, (on) =>
      activateVersion(on, {
        artifactType,
        artifactId,
        version: lastMove.fromVersion!,
        actorUserId: req.authCtx.userId ?? null,
        reason: body.reason,
      }),
    );
    if (res === EVIDENCE_HOLD_REFUSED) return reply;
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
    if (await agentHoldRefused(req, reply, artifactType, artifactId, `canary of version ${target.version} at ${body.pct}%`)) return reply;
    const row = await agentHeldWrite(req, reply, artifactType, artifactId, `canary of version ${target.version} at ${body.pct}%`, async (db) => {
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
      return row;
    });
    if (row === EVIDENCE_HOLD_REFUSED) return reply;
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
    if (await agentHoldRefused(req, reply, artifactType, artifactId, `abandon the canary (version ${canary.version})`)) return reply;
    const done = await agentHeldWrite(req, reply, artifactType, artifactId, `abandon the canary (version ${canary.version})`, async (db) => {
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
    });
    if (done === EVIDENCE_HOLD_REFUSED) return reply;
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
    if (await agentHoldRefused(req, reply, artifactType, artifactId, `promote the canary (version ${canary.version})`)) return reply;

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
    // ADR-0074 — THE STALE-BASELINE GATE, ahead of the eval gate.
    //
    // ADR-0074 lets an ordinary admin edit mint and activate a version, which
    // MOVES the baseline a running shadow canary is being compared against. The
    // canary is deliberately not invalidated and the edit is deliberately not
    // refused — a measurement may not veto a policy change. The refusal lands
    // here instead, on ACTING on a sample that is not one comparison.
    //
    // It does NOT silently re-scope the promotion to the post-seam observations:
    // a human chose this comparison, and substituting a different one is an
    // answer to a question nobody asked (ADR-0072 §3.2 case 3, same reasoning).
    const active = versions.find((v) => v.status === "active") ?? null;
    const baselineBuckets = (
      await db
        .select({
          activeVersionId: configCanaryObservations.activeVersionId,
          observed: count(),
          diverged: sql<number>`coalesce(sum(CASE WHEN ${configCanaryObservations.diverged} THEN 1 ELSE 0 END), 0)::int`,
          failed: sql<number>`coalesce(sum(CASE WHEN ${configCanaryObservations.failed} THEN 1 ELSE 0 END), 0)::int`,
        })
        .from(configCanaryObservations)
        .where(eq(configCanaryObservations.candidateVersionId, canary.id))
        .groupBy(configCanaryObservations.activeVersionId)
    ).map((b) => ({
      activeVersionId: b.activeVersionId,
      observed: Number(b.observed),
      diverged: Number(b.diverged),
      failed: Number(b.failed),
    }));
    const freshness = evaluateBaselineFreshness({
      assessment: assessCanaryBaseline({ activeVersionId: active?.id ?? null, buckets: baselineBuckets }),
      override: body.override,
      reason: body.reason ?? null,
    });
    if (!freshness.allowed) {
      await auditConfig(
        db,
        req.authCtx.userId ?? null,
        artifactId,
        freshness.ruleId,
        `promotion of ${artifactType} version ${canary.version} REFUSED: ${freshness.reason}`,
        { artifactType, version: canary.version, activeVersionId: active?.id ?? null },
        "deny",
      );
      return reply.status(409).send({ error: freshness.ruleId, detail: freshness.reason });
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
    const res = await agentHeldWrite(req, reply, artifactType, artifactId, `promote the canary (version ${canary.version})`, (db) => activateVersion(db, {
      artifactType,
      artifactId,
      version: canary.version,
      actorUserId: req.authCtx.userId ?? null,
      promotion: {
        ruleId: decision.ruleId,
        evalRunId: decision.evalRunId,
        override: decision.override,
        reason:
          freshness.ruleId === "canary-baseline-current"
            ? decision.reason
            : `${decision.reason} [${freshness.reason}]`,
      },
    }));
    if (res === EVIDENCE_HOLD_REFUSED) return reply;
    return {
      activeVersion: res.target.version,
      gate: decision.ruleId,
      baselineGate: freshness.ruleId,
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
    // ADR-0074 — KEYED ON THE (candidate, active) PAIR, not on the candidate
    // alone. An observation records BOTH sides; grouping on the candidate only
    // pooled comparisons made against DIFFERENT baselines into one `diverged`
    // count, unchanged in shape and changed in meaning. Since this ADR lets an
    // ordinary admin edit move the baseline, that seam is now routine.
    const counts = canaries.length
      ? await db
          .select({
            candidateVersionId: configCanaryObservations.candidateVersionId,
            activeVersionId: configCanaryObservations.activeVersionId,
            observed: count(),
            diverged: sql<number>`coalesce(sum(CASE WHEN ${configCanaryObservations.diverged} THEN 1 ELSE 0 END), 0)::int`,
            failed: sql<number>`coalesce(sum(CASE WHEN ${configCanaryObservations.failed} THEN 1 ELSE 0 END), 0)::int`,
          })
          .from(configCanaryObservations)
          .groupBy(configCanaryObservations.candidateVersionId, configCanaryObservations.activeVersionId)
      : [];
    const byCandidate = new Map<string, BaselineBucket[]>();
    for (const c of counts) {
      const list = byCandidate.get(c.candidateVersionId) ?? [];
      list.push({
        activeVersionId: c.activeVersionId,
        observed: Number(c.observed),
        diverged: Number(c.diverged),
        failed: Number(c.failed),
      });
      byCandidate.set(c.candidateVersionId, list);
    }
    // the artifact each canary points at may have been DELETED — `artifact_id`
    // is polymorphic across five types and therefore carries no FK, so a rule
    // row cascading away (deleting a user, server, role, team or approver does
    // it) leaves its versions behind with the pointers intact. Labelled rather
    // than hidden: an orphan can never enforce, but it CAN sit in the operator's
    // "there is something waiting on you" index for ever with counts that will
    // never move.
    const liveIds = new Set<string>();
    for (const type of new Set(canaries.map((c) => c.artifactType))) {
      const ids = canaries.filter((c) => c.artifactType === type).map((c) => c.artifactId);
      for (const id of ids) {
        if (!isRuleArtifact(type)) {
          const [a] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, id));
          if (a) liveIds.add(key(type, id));
        } else if (await loadRuleRow(db, type, id)) {
          liveIds.add(key(type, id));
        }
      }
    }
    const activeRows = canaries.length
      ? await db
          .select({
            id: configVersions.id,
            artifactType: configVersions.artifactType,
            artifactId: configVersions.artifactId,
          })
          .from(configVersions)
          .where(
            and(
              eq(configVersions.status, "active"),
              inArray(configVersions.artifactId, [...new Set(canaries.map((c) => c.artifactId))]),
            ),
          )
      : [];
    const activeByArtifact = new Map(activeRows.map((r) => [key(r.artifactType, r.artifactId), r.id]));

    const rendered = canaries.map((c) => {
      const assessment = assessCanaryBaseline({
        activeVersionId: activeByArtifact.get(key(c.artifactType, c.artifactId)) ?? null,
        buckets: byCandidate.get(c.id) ?? [],
      });
      return {
        artifactType: c.artifactType,
        artifactId: c.artifactId,
        version: c.version,
        label: c.label,
        canaryPct: c.canaryPct,
        canaryMode: canaryModeOf(c.artifactType),
        observed: assessment.current.observed,
        diverged: assessment.current.diverged,
        failed: assessment.current.failed,
        staleBaselineObservations: assessment.strandedObserved,
        baselineMoved: assessment.stale,
        artifactDeleted: !liveIds.has(key(c.artifactType, c.artifactId)),
      };
    });
    return {
      canaries: rendered,
      note:
        "`observed` counts SAMPLED decisions only — canaryPct is the shadow sampling rate, so a divergence " +
        "count is a count within the sample and never a fleet-wide total. An `inert` canaryMode means " +
        "nothing evaluates this artifact type at all and every count will stay zero. ADR-0074: the counts " +
        "cover ONLY the observations measured against the version that is active NOW; " +
        "`staleBaselineObservations` counts the ones whose baseline has since moved, which are reported " +
        "separately rather than averaged in. `artifactDeleted` marks a canary whose artifact no longer " +
        "exists — it can never enforce, and its counts will never move again.",
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
    // ADR-0074 — TOTALS PER (candidate, active) PAIR. ADR-0073 summed over the
    // whole candidate set, so observations taken against a baseline that has
    // since moved were averaged into the same `diverged` number an operator
    // promotes on. They are now separated: the CURRENT pair leads, the stranded
    // set is disclosed with its count and the reason, and neither is silently
    // folded into the other. ADR-0072 §3.2 case 1, same posture — "you have no
    // history" and "your history predates the correction" must never be the
    // same sentence.
    const buckets: BaselineBucket[] = canary
      ? (
          await db
            .select({
              activeVersionId: configCanaryObservations.activeVersionId,
              observed: count(),
              diverged: sql<number>`coalesce(sum(CASE WHEN ${configCanaryObservations.diverged} THEN 1 ELSE 0 END), 0)::int`,
              failed: sql<number>`coalesce(sum(CASE WHEN ${configCanaryObservations.failed} THEN 1 ELSE 0 END), 0)::int`,
            })
            .from(configCanaryObservations)
            .where(eq(configCanaryObservations.candidateVersionId, canary.id))
            .groupBy(configCanaryObservations.activeVersionId)
        ).map((b) => ({
          activeVersionId: b.activeVersionId,
          observed: Number(b.observed),
          diverged: Number(b.diverged),
          failed: Number(b.failed),
        }))
      : [];
    const assessment = assessCanaryBaseline({ activeVersionId: active?.id ?? null, buckets });
    const versionNumberById = new Map(versions.map((v) => [v.id, v.version]));
    const totals = assessment.current;

    // The compliance cascade's candidate effect does NOT vary per request — it
    // is a pure function of the profile bodies and a project's tags — so it is
    // computed HERE, over the real projects, rather than written once per call
    // into an observation table as N identical rows. B8b (ADR-0073 disclosure
    // 7): the computation now PERSISTS each per-project comparison at this same
    // site, deduplicated by (candidate, project, fingerprint), so the history
    // survives a page refresh and ADR-0059's preview can read it back.
    let projectImpact: ProfileImpactProjectRow[] | null = null;
    let projectImpactNote: string | null = null;
    if (artifactType === "compliance_profile" && canary) {
      const result = await computeAndRecordProfileImpact(db, {
        artifactId,
        canary,
        active: active ?? null,
      });
      if (result) {
        projectImpact = result.impact;
        projectImpactNote =
          `Computed from the candidate body against every project carrying '${result.tag}' ` +
          `(${result.examinedProjects} of ${result.taggedProjects} examined — the first ` +
          `${PROFILE_IMPACT_PROJECT_CAP} is a disclosed cap` +
          (result.capApplied ? ", and it truncated this list" : "") +
          `). NOT sampled — a compliance profile's effect does not vary per request — and, since ` +
          `batch B8b, STORED: each per-project comparison is persisted into ` +
          `config_canary_observations (${result.recorded} recorded by this read, ` +
          `${result.deduplicated} identical to an already-stored observation and skipped), so ` +
          `refreshing this page never duplicates history, and ADR-0059's blast-radius preview ` +
          `reads the stored rows rather than recomputing.`;
      }
    }

    // ADR-0074 — A CANDIDATE BODY MAY BE PARTIAL. `RULE_BODY_SCHEMAS` make every
    // field optional and `applyRuleBody` copies only the fields a body HAS, so a
    // hand-authored candidate inherits the rest from the row. That means the
    // STORED body is not necessarily what was evaluated. Render the EFFECTIVE
    // body — active overlaid on the row, candidate overlaid on that — and name
    // the inherited fields, so an operator never compares against a body that
    // was never the comparison.
    let candidateEffectiveBody: Record<string, unknown> | null = null;
    let candidateInheritedFields: string[] = [];
    if (canary && isRuleArtifact(artifactType)) {
      const row = await loadRuleRow(db, artifactType, artifactId);
      if (row) {
        candidateEffectiveBody = composeRuleBody(artifactType, row, active?.body ?? {}, canary.body);
        candidateInheritedFields = (VERSIONED_RULE_FIELDS[artifactType] ?? []).filter(
          (f) => !Object.prototype.hasOwnProperty.call(canary.body, f),
        );
      }
    }

    return {
      artifactType,
      artifactId,
      canaryMode: canaryModeOf(artifactType),
      activeVersion: active?.version ?? null,
      candidateVersion: canary?.version ?? null,
      canaryPct: canary?.canaryPct ?? null,
      /** ADR-0074: exists on this route so a reader can tell "this artifact was
       * deleted and its versions were left behind" from "this artifact is fine" */
      artifactDeleted:
        isRuleArtifact(artifactType) && (await loadRuleRow(db, artifactType, artifactId)) == null,
      totals: {
        observed: totals.observed,
        diverged: totals.diverged,
        failed: totals.failed,
      },
      /** the observations whose baseline has since moved — REPORTED, never
       * folded into `totals` and never deleted */
      staleBaseline: {
        observed: assessment.strandedObserved,
        buckets: assessment.stranded.map((b) => ({
          ...b,
          activeVersion: b.activeVersionId ? (versionNumberById.get(b.activeVersionId) ?? null) : null,
        })),
        unattributed: assessment.unattributed?.observed ?? 0,
        note: assessment.note,
      },
      candidateEffectiveBody,
      candidateInheritedFields,
      observations: rows,
      projectImpact,
      projectImpactNote,
      note: canary
        ? canaryModeNote(artifactType) +
          " `observed` is the number of SAMPLED decisions, not the number of decisions — at " +
          `${canary.canaryPct}% roughly that share of callers are shadowed. A non-zero \`failed\` means the ` +
          "candidate's evaluation THREW on that decision: the served answer was unaffected, and the " +
          "comparison for that call did not happen — do not read `diverged` as complete while `failed` > 0." +
          (assessment.note ? ` ADR-0074: ${assessment.note}.` : "") +
          (candidateInheritedFields.length > 0
            ? ` The candidate body does not name ${candidateInheritedFields.join(", ")}; those are inherited, ` +
              `so \`candidateEffectiveBody\` — not the stored body — is what was evaluated.`
            : "")
        : "there is no canary on this artifact, so there is nothing to compare against the active version",
    };
  });
}
