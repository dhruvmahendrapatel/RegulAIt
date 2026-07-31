/**
 * ADR-0021 — the ORG-SETTINGS configurability layer (migration 0038).
 *
 * The owner's mandate: "admins must have options to enable/disable features
 * whenever there is a functional or technical choice feasible." This module is
 * the single home for those org-wide functional defaults: the load helper the
 * hot paths call (the exact `interception_settings` pattern — one indexed
 * primary-key select per consultation, belt-and-braces singleton creation),
 * the admin-only GET/PUT endpoints (audited, partial update), the derived
 * "effective mode" helpers that hold the CEILING MODEL (org ≥ user — a
 * setting here only ever narrows what happens below it), and the audit-log
 * auto-prune scheduler.
 *
 * INVARIANT (held by migration 0038's defaults): a fresh org_settings row
 * changes NOTHING. Every default equals the pre-0038 behaviour, so the
 * migration is invisible until an admin acts.
 */

import type { FastifyInstance } from "fastify";
import {
  and,
  approvalRules,
  auditLog,
  complianceProfiles,
  dataScopeRules,
  eq,
  isNull,
  lt,
  ne,
  or,
  count,
  oidcProviders,
  orgSettings,
  ORG_SETTINGS_ID,
  rateLimits,
  users,
  type Db,
  type OrgSettingsRow,
  type SQL,
} from "@regulait/db";
import { ruleKindParamSchema, setRuleDeployModeSchema, updateOrgSettingsSchema } from "@regulait/shared";
import { z } from "zod";

export type { OrgSettingsRow };

/** The singleton row, created on first read if migration seeding was skipped
 * (belt-and-braces; 0038 inserts it) — byte-for-byte the
 * loadInterceptionSettings pattern. */
export async function loadOrgSettings(db: Db): Promise<OrgSettingsRow> {
  const [row] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  if (row) return row;
  const [created] = await db
    .insert(orgSettings)
    .values({ id: ORG_SETTINGS_ID })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  if (!again) throw new Error("org_settings singleton missing");
  return again;
}

// ---------------------------------------------------------------------------
// the ceiling model — effective routing mode per technique
// ---------------------------------------------------------------------------

export type EffectiveRoutingMode = "automatic" | "passthrough";

/**
 * The one composition rule for every pillar-6 technique:
 *   - org toggle OFF   -> "passthrough" (the org is the ceiling; no per-user
 *     setting can re-enable a technique the org turned off);
 *   - org toggle ON    -> the user's own routingMode when set (a user's
 *     passthrough always wins — narrowing only), else the ORG DEFAULT for
 *     new/unset users (defaultRoutingMode, 'automatic' = today).
 */
export function effectiveTechniqueMode(
  org: OrgSettingsRow,
  techniqueEnabled: boolean,
  userRoutingMode: string | null | undefined,
): EffectiveRoutingMode {
  if (!techniqueEnabled) return "passthrough";
  if (userRoutingMode === "passthrough") return "passthrough";
  if (userRoutingMode === "automatic") return "automatic";
  return org.defaultRoutingMode === "passthrough" ? "passthrough" : "automatic";
}

/** ADR-0021: the org default piiMode an UNCLASSIFIED (or profile-less)
 * project falls back to. 'none' (default) maps to null = today's
 * no-enforcement. */
export function orgDefaultPiiMode(org: OrgSettingsRow): "block" | "warn" | "log" | null {
  return org.defaultPiiMode === "none" ? null : org.defaultPiiMode;
}

/** ADR-0021: whether the platform-key ENV fallback may engage for `provider`.
 * Gate only — the caller still resolves the env var itself. */
export function envFallbackAllowed(org: OrgSettingsRow, provider: string): boolean {
  if (!org.envKeyFallbackEnabled) return false;
  return (org.envFallbackProviders ?? []).includes(provider);
}

// ---------------------------------------------------------------------------
// audit retention — the global floor, now composed with the org default
// ---------------------------------------------------------------------------

export interface RetentionFloor {
  retainedDays: number | null;
  /** the profile tags (or the marker 'org_default') that set the floor */
  floorSource: string[];
  cutoff: Date | null;
  prunable: number;
  /** A4: the EFFECTIVE per-mode overrides — only those exceeding the global
   * floor (an override at/below the floor is inert under MAX composition) */
  modeOverrides: Array<{ mode: string; retainedDays: number; cutoff: Date }>;
}

/** A4 (migration 0044): the per-mode overrides that actually extend past the
 * global floor. MAX-only by construction: an override <= the floor changes
 * nothing (the floor already retains longer), so it is dropped here — and an
 * override can never shorten anything because it only ever EXCLUDES rows from
 * a prune the global floor would otherwise perform. */
export function effectiveModeOverrides(
  modeAuditRetention: Partial<Record<string, number>> | null | undefined,
  globalRetainedDays: number,
  now: number = Date.now(),
): Array<{ mode: string; retainedDays: number; cutoff: Date }> {
  return Object.entries(modeAuditRetention ?? {})
    .filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > globalRetainedDays)
    .map(([mode, days]) => ({
      mode,
      retainedDays: days,
      cutoff: new Date(now - days * 24 * 3600 * 1000),
    }));
}

/** the prune predicate under the composed floor: older than the global cutoff,
 * EXCEPT rows whose deploy mode has a longer override and are still inside
 * that override's window. Null-mode rows (unknown / pre-0044 / not
 * deploy-scoped) always follow the global floor alone. */
function prunableWhere(
  cutoff: Date,
  overrides: Array<{ mode: string; cutoff: Date }>,
): SQL {
  const conds: SQL[] = [lt(auditLog.at, cutoff)];
  for (const o of overrides) {
    // keep (i.e. exclude from prune) rows of this mode newer than the
    // override's cutoff. NULL-mode rows must NOT be protected — `ne` alone is
    // NULL-poisoned in SQL, hence the explicit isNull arm.
    conds.push(
      or(
        isNull(auditLog.deployMode),
        ne(auditLog.deployMode, o.mode as "hosted" | "byoc" | "air_gapped"),
        lt(auditLog.at, o.cutoff),
      )!,
    );
  }
  return and(...conds)!;
}

/**
 * The global retention floor + how many audit rows currently sit below it.
 * Composition rule (ADR-0021): a compliance-profile floor ALWAYS wins upward —
 * effective = max(profile floor, org defaultAuditRetentionDays). The org
 * default only ADDS a retention where no profile set one; it can never shorten
 * a framework's audit trail. Both null (the default) = nothing is ever
 * eligible for pruning (fail-safe: keep all) — unchanged behaviour.
 */
export async function retentionFloor(db: Db): Promise<RetentionFloor> {
  const [profiles, org] = await Promise.all([
    db.select().from(complianceProfiles),
    loadOrgSettings(db),
  ]);
  const withDays = profiles.filter(
    (p): p is typeof p & { auditRetentionDays: number } => p.auditRetentionDays != null,
  );
  const profileFloor = withDays.length
    ? withDays.reduce((m, p) => Math.max(m, p.auditRetentionDays), 0)
    : null;
  const orgDays = org.defaultAuditRetentionDays;
  const retainedDays =
    profileFloor != null && orgDays != null
      ? Math.max(profileFloor, orgDays)
      : (profileFloor ?? orgDays);
  if (retainedDays == null) {
    // no global floor = keep everything = nothing prunable. A4: per-mode
    // overrides are irrelevant here — they can only EXTEND retention, and
    // "keep all" is already the maximum (fail-safe unchanged).
    return { retainedDays: null, floorSource: [], cutoff: null, prunable: 0, modeOverrides: [] };
  }
  const floorSource = withDays
    .filter((p) => p.auditRetentionDays === retainedDays)
    .map((p) => p.tag);
  if (orgDays != null && orgDays === retainedDays) floorSource.push("org_default");
  const cutoff = new Date(Date.now() - retainedDays * 24 * 3600 * 1000);
  // A4: MAX-only per-mode overrides — rows of an overridden mode stay retained
  // for the longer window; everything else prunes under the global floor.
  const modeOverrides = effectiveModeOverrides(org.modeAuditRetention, retainedDays);
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(prunableWhere(cutoff, modeOverrides));
  return { retainedDays, floorSource, cutoff, prunable: row?.n ?? 0, modeOverrides };
}

/** One prune pass under the composed floor. Deletes nothing when no floor is
 * set. The prune is itself audited (a meta row newer than every cutoff), with
 * `auto` marking scheduler-driven passes apart from the admin's POST. */
export async function runAuditPruneOnce(
  db: Db,
  actorUserId: string | null,
  auto: boolean,
): Promise<{ deleted: number; retainedDays: number | null; floorSource: string[] }> {
  const f = await retentionFloor(db);
  if (f.retainedDays == null || f.cutoff == null) {
    return { deleted: 0, retainedDays: null, floorSource: [] };
  }
  // A4: prune under the COMPOSED floor — the global cutoff, minus rows a
  // longer per-mode override still retains (MAX-only: never shortens).
  const deleted = await db
    .delete(auditLog)
    .where(prunableWhere(f.cutoff, f.modeOverrides))
    .returning({ id: auditLog.id });
  await db.insert(auditLog).values({
    userId: actorUserId ?? "00000000-0000-0000-0000-000000000000",
    objectType: "project",
    objectId: null,
    detail: {
      phase: "audit-retention-prune",
      deleted: deleted.length,
      retainedDays: f.retainedDays,
      floorSource: f.floorSource,
      cutoff: f.cutoff,
      ...(f.modeOverrides.length
        ? {
            modeOverrides: f.modeOverrides.map((o) => ({
              mode: o.mode,
              retainedDays: o.retainedDays,
            })),
          }
        : {}),
      ...(auto ? { auto: true } : {}),
    },
    effect: "allow",
    ruleId: "audit-log-pruned",
    ruleChain: [],
    reason: `pruned ${deleted.length} audit row(s) older than ${f.retainedDays}d (floor from [${f.floorSource.join(", ")}])${auto ? " — scheduled auto-prune" : ""}`,
  });
  return { deleted: deleted.length, retainedDays: f.retainedDays, floorSource: f.floorSource };
}

/**
 * Boot-scheduled auto-prune (ADR-0021). OFF by default (autoPruneEnabled=false
 * = today's manual-POST-only behaviour). The timer ticks hourly (unref'd so it
 * never keeps a test process alive), re-reads the settings each tick — so an
 * admin's change takes effect without a restart — and prunes when the
 * configured interval has elapsed since the last pass. Returns the stop
 * function the app's onClose hook calls.
 */
export function startAuditPruneScheduler(db: Db): () => void {
  let lastRunAt = 0;
  const tick = async () => {
    try {
      const org = await loadOrgSettings(db);
      if (!org.autoPruneEnabled) return;
      const intervalMs = Math.max(1, org.pruneIntervalHours) * 3600 * 1000;
      if (Date.now() - lastRunAt < intervalMs) return;
      lastRunAt = Date.now();
      await runAuditPruneOnce(db, null, true);
    } catch {
      // a failed pass never crashes the gateway; the next tick retries
    }
  };
  const timer = setInterval(() => void tick(), 3600 * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// admin endpoints — GET/PUT /v1/org/settings
// ---------------------------------------------------------------------------

/** the providers the env fallback can ever resolve, mirroring
 * ENV_FALLBACK_PROVIDERS in agents-connectors (kept local to avoid an import
 * cycle — agents-connectors imports this module) */
const ENV_KEY_NAMES: ReadonlyArray<{ provider: string; envVar: string; aliases: string[] }> = [
  { provider: "anthropic", envVar: "ANTHROPIC_API_KEY", aliases: [] },
  { provider: "openai", envVar: "OPENAI_API_KEY", aliases: [] },
  { provider: "google", envVar: "GOOGLE_API_KEY", aliases: ["GEMINI_API_KEY"] },
  { provider: "xai", envVar: "XAI_API_KEY", aliases: [] },
];

/** which conventional platform-key env vars are currently PRESENT on this
 * server — names and booleans ONLY, never a value. The admin UI shows this so
 * "turn the env fallback off" is an informed decision. */
export function envKeyPresence(): Array<{ provider: string; envVar: string; present: boolean }> {
  return ENV_KEY_NAMES.map(({ provider, envVar, aliases }) => {
    const names = [envVar, ...aliases];
    const setName = names.find((n) => (process.env[n]?.length ?? 0) > 0);
    return { provider, envVar: setName ?? envVar, present: setName !== undefined };
  });
}

/** GET/PUT the org-wide functional defaults. ADMIN-ONLY — deliberately absent
 * from NON_ADMIN_ROUTES, exactly like the interception settings endpoints.
 * PUT is a partial update; every write is audited (objectType org_settings)
 * with the changed keys in the detail. */
export function registerOrgSettingsRoutes(app: FastifyInstance, db: Db) {
  app.get("/v1/org/settings", async () => {
    const settings = await loadOrgSettings(db);
    return { settings, envKeys: envKeyPresence() };
  });

  app.put("/v1/org/settings", async (req, reply) => {
    const body = updateOrgSettingsSchema.parse(req.body);
    // ADR-0022: the default infra-remediation approver must be a real, ACTIVE
    // user — a disabled or unknown default would silently dead-letter every
    // proposed remediation.
    if (body.infraApproverUserId) {
      const [approver] = await db
        .select({ id: users.id, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, body.infraApproverUserId));
      if (!approver) return reply.status(422).send({ error: "unknown_approver" });
      if (approver.disabledAt) {
        return reply.status(422).send({
          error: "approver_disabled",
          detail: "the chosen infra approver account is deactivated",
        });
      }
    }
    // ADR-0025 lockout guard: sso_only without a single enabled OIDC provider
    // would strand every human login behind a door that does not exist.
    if (body.ssoOnly === true) {
      const enabled = await db
        .select({ id: oidcProviders.id })
        .from(oidcProviders)
        .where(eq(oidcProviders.enabled, true));
      if (enabled.length === 0) {
        return reply.status(422).send({
          error: "sso_only_needs_a_provider",
          detail: "enable at least one OIDC provider before turning sso_only on — otherwise nobody can sign in",
        });
      }
    }
    const before = await loadOrgSettings(db);
    const [row] = await db
      .update(orgSettings)
      .set({
        ...body,
        updatedBy: req.authCtx.userId,
        updatedAt: new Date(),
      })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID))
      .returning();
    const after = row ?? before;
    const changed = Object.fromEntries(
      Object.entries(body).filter(
        ([k, v]) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify(v),
      ),
    );
    await db.insert(auditLog).values({
      // bootstrap has no user identity; the nil uuid marks a non-user actor,
      // as elsewhere in the codebase, and `via` records which it was.
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "org_settings",
      objectId: null,
      detail: { via: req.authCtx.via, changed, after },
      effect: "allow",
      ruleId: "org-settings-updated",
      ruleChain: [],
      reason:
        Object.keys(changed).length > 0
          ? `org settings updated: ${Object.keys(changed).join(", ")}`
          : "org settings written with no effective change",
    });
    return reply.send({ settings: after });
  });

  // -------------------------------------------------------------------------
  // A4 (ADR-0027) — deploy-mode scope on pillar-1 restriction rules.
  // Admin-only like everything in this module. Registered here (an existing
  // admin governance module) rather than beside the rule POSTs: setting the
  // mode scope is a policy-posture edit, and this keeps the rule-creation
  // endpoints byte-identical (default = mode-unscoped = today).
  // -------------------------------------------------------------------------
  const RULE_TABLES = {
    approvals: approvalRules,
    "rate-limits": rateLimits,
    "data-scopes": dataScopeRules,
  } as const;

  app.patch("/v1/rules/:kind/:ruleId/deploy-mode", async (req, reply) => {
    const { kind, ruleId } = z
      .object({ kind: ruleKindParamSchema, ruleId: z.string().uuid() })
      .parse(req.params);
    const body = setRuleDeployModeSchema.parse(req.body);
    const table = RULE_TABLES[kind];
    const [before] = await db.select().from(table).where(eq(table.id, ruleId));
    if (!before) return reply.status(404).send({ error: "unknown_rule" });
    const [row] = await db
      .update(table)
      .set({ deployMode: body.deployMode })
      .where(eq(table.id, ruleId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "restriction_rule",
      objectId: ruleId,
      detail: {
        phase: "rule-deploy-mode",
        ruleKind: kind,
        before: before.deployMode ?? null,
        after: body.deployMode,
      },
      effect: "allow",
      ruleId: "rule-deploy-mode-set",
      ruleChain: [],
      reason:
        body.deployMode == null
          ? `${kind} rule '${ruleId}' deploy-mode scope cleared (mode-unscoped — applies to every call)`
          : `${kind} rule '${ruleId}' scoped to deploy mode '${body.deployMode}' — it now binds only to calls whose attributed work lands on a ${body.deployMode} deploy target`,
    });
    return reply.send(row);
  });
}
