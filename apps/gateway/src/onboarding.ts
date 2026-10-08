/**
 * ADR-0054 — THE FIRST-RUN WIZARD AND THE IMPORT TOOLING.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not the installer. ADR-0041's `scripts/install.sh` brings the DEPLOYMENT
 * up — containers, TLS, the data key, the first bootstrap token. By the time
 * anything here runs, that is done and an admin is looking at a console. This is
 * the IN-PRODUCT half: connect an IdP, import the people who already exist,
 * seed the roles, connect a model, choose a compliance posture. Nothing here
 * touches deployment concerns and nothing in the installer touches these.
 *
 * It is also not a second configuration path. Every route below writes into the
 * tables the existing console already writes into — `roles`,
 * `group_role_mappings`, `compliance_profiles`, `projects.classifications`,
 * `users`. That is ADR-0054 §4, and it is what makes the whole result
 * exportable as policy-as-code and replayable into the next BYOC deployment.
 * The only genuinely new state is "how far through are we" and "what did an
 * import do".
 *
 * THE TWO PROPERTIES THAT ARE LOAD-BEARING
 * ----------------------------------------
 * 1. IDEMPOTENT. Every write is an upsert keyed on the thing's natural key —
 *    the step key, the role name, the compliance tag, the user's email, the
 *    (source, group, role) triple. Running a step twice is running it once.
 *    ADR-0054 names a non-idempotent re-run during a piecemeal BYOC install as
 *    the failure it most fears, so this is not incidental.
 *
 * 2. RESUMABLE WITHOUT A HALF-CONFIGURED ORG. Two mechanisms, deliberately
 *    separate. The checklist records INTENT (`in_progress` with a `started_at`)
 *    and survives the admin closing the tab. The STATE is read live, from the
 *    objects that actually exist, and reported beside the recorded status — so
 *    a step interrupted halfway shows `in_progress` + `satisfied: false` + the
 *    real evidence, and re-running it reconciles rather than duplicates. The
 *    checklist is never the source of truth about the deployment; it is the
 *    record of what an admin decided to do about it.
 *
 * THE IMPORT PATH IS THE UNTRUSTED PATH
 * -------------------------------------
 * An import payload is a file someone else wrote. Four walls, in order:
 *
 *   1. `screenForEscalation` runs on the RAW body, before parsing, and refuses
 *      any payload carrying a privilege word at any depth — `isAdmin`,
 *      `is_admin`, `grants`, `permissions`, `superuser`. The refusal is a 422,
 *      an `audit_log` deny with a stable rule id, and an `onboarding_imports`
 *      row. A silent strip would be worse than a refusal: the importer would
 *      believe the administrators landed.
 *   2. The row schemas are `.strict()` and have no privilege field to parse
 *      into. Even if (1) were bypassed there is no code path that reads one.
 *   3. Provisioning goes through `refuseIfSeatCapReached` — the SAME function
 *      `POST /v1/users` calls. An import cannot outrun the licensed seat cap.
 *   4. `isAdmin` is never passed to the insert. It is not conditionally false;
 *      the column is simply not in the values object, so it takes its default.
 *      Platform admin is granted by `POST /v1/users/:userId/admin`, one
 *      explicit act at a time, and an import is not that act.
 *
 * And role membership is never named by the file. A row carries GROUPS; what a
 * group confers is decided by a mapping an admin authored. That indirection is
 * the point: an import can say "this person is in Engineering-EMEA" and cannot
 * say "this person has the Operator role".
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  complianceProfiles,
  count,
  desc,
  eq,
  groupRoleMappings,
  isNull,
  modelCredentials,
  oidcProviders,
  onboardingImports,
  onboardingSteps,
  projects,
  roles,
  samlProviders,
  sql,
  usageEvents,
  users,
  type Db,
  type GroupSource,
} from "@regulait/db";
import {
  COMPLIANCE_PACKS,
  ONBOARDING_STEPS,
  STARTER_ROLE_TEMPLATES,
  applyCompliancePackSchema,
  blockedBy,
  csvToUserRows,
  groupRoleImportSchema,
  planGroupRoleImport,
  planUserImport,
  screenForEscalation,
  transitionRefusal,
  updateOnboardingStepSchema,
  userImportSchema,
  type OnboardingStepStatus,
} from "@regulait/shared";
import { ENV_FALLBACK_PROVIDERS, platformEnvKey } from "./agents-connectors.js";
import { envFallbackAllowed, loadOrgSettings } from "./org-settings.js";
import { refuseIfSeatCapReached } from "./licensing.js";
import { reconcileGroupRoles } from "./group-roles.js";
import { isApproverRole, lockApproverRoles } from "./approval-pool.js";
import { approvalRuleStepUp, CHANGED_CONCURRENTLY, requireStepUp } from "./step-up.js";
// ADR-0074: a pack RE-APPLY over an existing profile is an edit of twelve
// versioned fields, so it goes through the one choke point.
import { applyRuleEdit, isRuleEditRefusal } from "./rule-writes.js";

type ComplianceProfileRow = typeof complianceProfiles.$inferSelect;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** stable rule ids — these are the strings an operator greps the audit log for,
 * so they are constants and not template literals built at the call site */
export const ONBOARDING_RULE_IDS = {
  stepUpdated: "onboarding-step-updated",
  stepBlocked: "onboarding-step-blocked",
  rolesSeeded: "onboarding-roles-seeded",
  packApplied: "onboarding-compliance-pack-applied",
  importPlanned: "onboarding-import-planned",
  importApplied: "onboarding-import-applied",
  importPrivilegeRefused: "onboarding-import-privilege-refused",
  importRejected: "onboarding-import-rejected",
  configExported: "onboarding-config-exported",
} as const;

type AuditObjectType = "onboarding_step" | "onboarding_import" | "role" | "project";

export function registerOnboardingRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { dataKey?: string } = {},
): void {
  const audit = (
    actorUserId: string | null,
    objectType: AuditObjectType,
    objectId: string | null,
    ruleId: string,
    effect: "allow" | "deny",
    reason: string,
    detail: Record<string, unknown>,
  ) =>
    db.insert(auditLog).values({
      userId: actorUserId ?? NIL_UUID,
      objectType,
      objectId,
      detail: { phase: "onboarding", ...detail },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });

  // -----------------------------------------------------------------------
  // LIVE READINESS — computed from the objects that actually exist.
  //
  // This is what makes the checklist honest. A recorded `done` says an admin
  // asserted the step; `satisfied` says the deployment currently agrees. They
  // are reported separately and never collapsed, because an operator who tore
  // down a provider after ticking the box deserves to see the disagreement
  // rather than a green checklist over a broken deployment.
  // -----------------------------------------------------------------------
  const liveSignals = async (): Promise<Record<string, { satisfied: boolean; evidence: Record<string, unknown> }>> => {
    const [org, oidc, saml, memberCount, roleRows, mappingCount, creds, profileRows, projectRows, [agentUse]] =
      await Promise.all([
        loadOrgSettings(db),
        db.select({ name: oidcProviders.name, enabled: oidcProviders.enabled }).from(oidcProviders),
        db.select({ name: samlProviders.name, enabled: samlProviders.enabled }).from(samlProviders),
        db
          .select({ n: count() })
          .from(users)
          .where(and(eq(users.isAdmin, false), isNull(users.disabledAt)))
          .then((r) => r[0]?.n ?? 0),
        db.select({ id: roles.id, name: roles.name }).from(roles),
        db.select({ n: count() }).from(groupRoleMappings).then((r) => r[0]?.n ?? 0),
        db.select({ provider: modelCredentials.provider }).from(modelCredentials),
        db.select({ tag: complianceProfiles.tag }).from(complianceProfiles),
        db.select({ name: projects.name, classifications: projects.classifications }).from(projects),
        db
          .select({ n: count() })
          .from(usageEvents)
          .where(eq(usageEvents.objectType, "agent")),
      ]);

    const enabledIdps = [
      ...oidc.filter((p) => p.enabled).map((p) => ({ kind: "oidc", name: p.name })),
      ...saml.filter((p) => p.enabled).map((p) => ({ kind: "saml", name: p.name })),
    ];

    // The SAME rule /v1/setup/status and the dispatcher apply: a stored
    // platform credential is only real when REGULAIT_DATA_KEY can decrypt it,
    // and an env fallback only counts when the org gate is open for that
    // provider. Counting a credential the gateway cannot decrypt would tick a
    // box that fails on the first dispatch.
    const providerSources: Array<{ provider: string; source: string }> = [];
    if (opts.dataKey) {
      for (const c of creds) providerSources.push({ provider: c.provider, source: "platform_credential" });
    }
    for (const p of ENV_FALLBACK_PROVIDERS) {
      if (envFallbackAllowed(org, p) && platformEnvKey(p) !== null && !providerSources.some((x) => x.provider === p)) {
        providerSources.push({ provider: p, source: "env" });
      }
    }

    const profileTags = new Set(profileRows.map((p) => p.tag));
    const classified = projectRows
      .map((p) => ({
        name: p.name,
        tags: ((p.classifications ?? []) as string[]).filter((t) => profileTags.has(t)),
      }))
      .filter((p) => p.tags.length > 0);

    const dispatches = Number(agentUse?.n ?? 0);
    return {
      connect_idp: {
        satisfied: enabledIdps.length > 0,
        evidence: { enabledProviders: enabledIdps, totalConfigured: oidc.length + saml.length },
      },
      import_users: {
        satisfied: memberCount > 0,
        evidence: { activeNonAdminUsers: memberCount },
      },
      seed_roles: {
        satisfied: roleRows.length > 0,
        evidence: {
          roles: roleRows.map((r) => r.name).slice(0, 20),
          roleCount: roleRows.length,
          groupRoleMappings: mappingCount,
          starterTemplatesPresent: STARTER_ROLE_TEMPLATES.filter((t) =>
            roleRows.some((r) => r.name.toLowerCase() === t.name.toLowerCase()),
          ).map((t) => t.name),
        },
      },
      connect_model_provider: {
        satisfied: providerSources.length > 0,
        evidence: {
          providers: providerSources,
          ...(creds.length > 0 && !opts.dataKey
            ? {
                note:
                  "a platform credential is stored but REGULAIT_DATA_KEY is not set — it cannot be decrypted at dispatch, so it does not count",
              }
            : {}),
        },
      },
      compliance_pack: {
        // the cascade is only LIVE when something CARRIES the tag; a profile
        // row nobody is classified with cascades nothing
        satisfied: classified.length > 0,
        evidence: { profilesDefined: [...profileTags], classifiedProjects: classified.slice(0, 5) },
      },
      first_governed_call: {
        satisfied: dispatches > 0,
        evidence: { agentDispatches: dispatches },
      },
    };
  };

  const recordedStatuses = async (): Promise<Record<string, OnboardingStepStatus>> => {
    const rows = await db.select().from(onboardingSteps);
    const out: Record<string, OnboardingStepStatus> = {};
    for (const s of ONBOARDING_STEPS) out[s.key] = "pending";
    for (const r of rows) out[r.stepKey] = r.status;
    return out;
  };

  // =======================================================================
  // GET /v1/onboarding — the resumable checklist
  // =======================================================================
  app.get("/v1/onboarding", async () => {
    const [rows, signals] = await Promise.all([db.select().from(onboardingSteps), liveSignals()]);
    const byKey = new Map(rows.map((r) => [r.stepKey, r]));
    const statuses: Record<string, OnboardingStepStatus> = {};
    for (const s of ONBOARDING_STEPS) statuses[s.key] = byKey.get(s.key)?.status ?? "pending";

    const steps = ONBOARDING_STEPS.map((def) => {
      const row = byKey.get(def.key);
      const live = signals[def.key] ?? { satisfied: false, evidence: {} };
      return {
        key: def.key,
        title: def.title,
        why: def.why,
        requires: def.requires,
        /** what the admin RECORDED */
        status: row?.status ?? ("pending" as OnboardingStepStatus),
        detail: row?.detail ?? null,
        startedAt: row?.startedAt ?? null,
        completedAt: row?.completedAt ?? null,
        completedByUserId: row?.completedByUserId ?? null,
        /** what the DEPLOYMENT currently says, read from real objects */
        satisfied: live.satisfied,
        evidence: live.evidence,
        /** true when a step RECORDED done is no longer satisfied by the
         * deployment — the honest signal a resumed wizard needs, and the one a
         * green checklist would hide. A pending step the deployment already
         * satisfies is not drift; it is a step nobody has ticked yet, and
         * `satisfied` says so on its own. */
        drift: row?.status === "done" && !live.satisfied,
        blockedBy: blockedBy(def.key, statuses),
      };
    });

    const inFlight = steps.find((s) => s.status === "in_progress") ?? null;
    return {
      steps,
      /** where to resume: the step that was in flight, else the first step that
       * is neither done nor skipped. An interrupted wizard is answered by a
       * query, not by asking the admin to remember. */
      resumeAt: inFlight?.key ?? steps.find((s) => s.status !== "done" && s.status !== "skipped")?.key ?? null,
      complete: steps.every((s) => s.status === "done" || s.status === "skipped"),
      doneCount: steps.filter((s) => s.status === "done").length,
      satisfiedCount: steps.filter((s) => s.satisfied).length,
      totalCount: steps.length,
      packs: COMPLIANCE_PACKS.map((p) => ({ tag: p.tag, label: p.label, summary: p.summary })),
      starterRoles: STARTER_ROLE_TEMPLATES.map((t) => ({ name: t.name, description: t.description })),
      /** said in the payload because the natural assumption is the opposite:
       * ticking a box confers nothing at all. */
      checklistGrantsNothing: true,
    };
  });

  // =======================================================================
  // POST /v1/onboarding/steps/:stepKey — the idempotent transition
  // =======================================================================
  const stepParam = z.object({ stepKey: z.string().min(1).max(64) });

  app.post("/v1/onboarding/steps/:stepKey", async (req, reply) => {
    const { stepKey } = stepParam.parse(req.params);
    const def = ONBOARDING_STEPS.find((s) => s.key === stepKey);
    if (!def) return reply.status(404).send({ error: "unknown_step" });
    const body = updateOnboardingStepSchema.parse(req.body ?? {});

    const statuses = await recordedStatuses();
    const refusal = transitionRefusal(stepKey, body.status, statuses);
    if (refusal) {
      await audit(req.authCtx.userId, "onboarding_step", null, ONBOARDING_RULE_IDS.stepBlocked, "deny",
        `step '${stepKey}' cannot be completed while ${refusal.blockedBy.join(", ")} ${refusal.blockedBy.length === 1 ? "is" : "are"} neither done nor skipped`,
        { stepKey, requested: body.status, blockedBy: refusal.blockedBy });
      return reply.status(409).send({
        error: "step_blocked",
        blockedBy: refusal.blockedBy,
        detail: "complete or explicitly skip the prerequisite steps first",
      });
    }

    const now = new Date();
    const isDone = body.status === "done";
    // ONE row per step, forever (step_key is the primary key), so this is the
    // only shape a write can take and running the step twice is running it once.
    const values = {
      stepKey,
      status: body.status,
      detail: body.detail ?? null,
      startedAt: body.status === "in_progress" ? now : null,
      completedAt: isDone ? now : null,
      completedByUserId: isDone ? req.authCtx.userId : null,
      updatedAt: now,
    };
    const existing = await db.select().from(onboardingSteps).where(eq(onboardingSteps.stepKey, stepKey));
    const prior = existing[0];
    const [row] = await db
      .insert(onboardingSteps)
      .values(values)
      .onConflictDoUpdate({
        target: onboardingSteps.stepKey,
        set: {
          status: body.status,
          detail: body.detail ?? null,
          // re-completing an already-done step KEEPS the original completion
          // time: idempotence means the second call is a no-op, not a fresh
          // event that rewrites when the org first got here.
          startedAt: body.status === "in_progress" ? (prior?.startedAt ?? now) : prior?.startedAt ?? null,
          completedAt: isDone ? (prior?.completedAt ?? now) : null,
          completedByUserId: isDone ? (prior?.completedByUserId ?? req.authCtx.userId) : null,
          updatedAt: now,
        },
      })
      .returning();

    const changed = prior?.status !== body.status;
    await audit(req.authCtx.userId, "onboarding_step", null, ONBOARDING_RULE_IDS.stepUpdated, "allow",
      changed
        ? `onboarding step '${stepKey}' moved from ${prior?.status ?? "pending"} to ${body.status}`
        : `onboarding step '${stepKey}' re-confirmed as ${body.status} (no change)`,
      { stepKey, from: prior?.status ?? "pending", to: body.status, changed });
    return { step: row, changed };
  });

  // =======================================================================
  // POST /v1/onboarding/roles/seed — starter role templates
  // =======================================================================
  app.post("/v1/onboarding/roles/seed", async (req) => {
    const body = z
      .object({ mode: z.enum(["dry_run", "apply"]).default("apply") })
      .strict()
      .parse(req.body ?? {});

    const existing = await db.select({ id: roles.id, name: roles.name }).from(roles);
    const byName = new Map(existing.map((r) => [r.name.toLowerCase(), r]));
    const plan = STARTER_ROLE_TEMPLATES.map((t) => ({
      name: t.name,
      description: t.description,
      action: byName.has(t.name.toLowerCase()) ? ("unchanged" as const) : ("create" as const),
    }));

    if (body.mode === "dry_run") {
      return { mode: "dry_run", plan, created: 0, unchanged: plan.filter((p) => p.action === "unchanged").length };
    }

    const created: string[] = [];
    for (const t of plan) {
      if (t.action === "unchanged") continue;
      // onConflictDoNothing on the unique name: two admins racing the wizard on
      // a shared BYOC console produce one role, not a 409 and a half-seeded org.
      const [row] = await db
        .insert(roles)
        .values({ name: t.name, description: t.description })
        .onConflictDoNothing({ target: roles.name })
        .returning();
      if (row) created.push(row.name);
    }
    await audit(req.authCtx.userId, "role", null, ONBOARDING_RULE_IDS.rolesSeeded, "allow",
      created.length > 0
        ? `seeded ${created.length} starter role(s): ${created.join(", ")}`
        : "starter roles already present — nothing created",
      { created, templates: STARTER_ROLE_TEMPLATES.map((t) => t.name) });
    return {
      mode: "apply",
      plan,
      created: created.length,
      createdNames: created,
      unchanged: plan.length - created.length,
      /** stated because the name "Admin" is conspicuously absent and an
       * operator will look for it */
      note:
        "starter roles carry NO grants — a governance product must not ship a default-allow. " +
        "Attach grants through the role builder. There is deliberately no 'Admin' template: " +
        "platform admin is a per-user flag no role can confer.",
    };
  });

  // =======================================================================
  // POST /v1/onboarding/compliance-pack — a cascade seed
  // =======================================================================
  app.post("/v1/onboarding/compliance-pack", async (req, reply) => {
    const body = applyCompliancePackSchema.parse(req.body);
    const pack = COMPLIANCE_PACKS.find((p) => p.tag === body.pack);
    if (!pack) return reply.status(422).send({ error: "unknown_pack" });

    let project: { id: string; name: string; classifications: string[] } | null = null;
    if (body.projectId) {
      const [row] = await db.select().from(projects).where(eq(projects.id, body.projectId));
      if (!row) return reply.status(404).send({ error: "unknown_project" });
      project = { id: row.id, name: row.name, classifications: (row.classifications ?? []) as string[] };
    }

    const [existingProfile] = await db
      .select()
      .from(complianceProfiles)
      .where(eq(complianceProfiles.tag, pack.tag));
    const alreadyClassified = project ? project.classifications.includes(pack.tag) : false;

    const plan = {
      profile: existingProfile ? ("update" as const) : ("create" as const),
      classification: project ? (alreadyClassified ? ("unchanged" as const) : ("add" as const)) : ("skipped" as const),
      cascades: pack.profile,
    };
    if (body.mode === "dry_run") return { mode: "dry_run", pack: pack.tag, plan };

    // A pack IS a compliance-profile upsert — the SAME row shape
    // `POST /v1/compliance/profiles` writes. There is no parallel path, so the
    // §8.3 cascade picks it up with no knowledge that a wizard was involved.
    //
    // ADR-0074: which means it inherited the SAME defect. This route computes
    // `plan.profile: 'update' | 'create'` above, so it knows perfectly well when
    // it is about to overwrite an existing profile — and it wrote the row bare,
    // so re-applying a pack over a profile somebody had versioned reported
    // `mode: 'apply'`, wrote an audit row saying the pack was applied, and left
    // enforcement on the old active version. It is now split the same way: a
    // genuine create is a plain insert, an update goes through the choke point.
    //
    // Note the deliberate asymmetry with `/v1/compliance/profiles`: this pack
    // does NOT name `redteamGatingClasses` / `redteamMinTrials` /
    // `redteamFailOnSeverity`, so those three are left ALONE — exactly as they
    // survived the old row-level upsert. Passing only the fields a route means
    // to write is what preserves each route's own semantics.
    const values = {
      tag: pack.tag,
      requiredTemplateIds: null,
      mcpDefaultMode: pack.profile.mcpDefaultMode,
      auditRetentionDays: pack.profile.auditRetentionDays,
      piiMode: pack.profile.piiMode,
      backupRetentionDays: pack.profile.backupRetentionDays,
      patchCadenceDays: pack.profile.patchCadenceDays,
      maxProjectBudgetUsd: null,
      budgetEnforcement: null,
      guardrailModes: pack.profile.guardrailModes as never,
    };
    let profile: ComplianceProfileRow | undefined;
    let versionMinted: number | null = null;
    const [created] = await db
      .insert(complianceProfiles)
      .values(values)
      .onConflictDoNothing({ target: complianceProfiles.tag })
      .returning();
    if (created) {
      profile = created;
    } else {
      const [row] = await db
        .select({ id: complianceProfiles.id })
        .from(complianceProfiles)
        .where(eq(complianceProfiles.tag, pack.tag));
      if (!row) return reply.status(409).send({ error: "compliance_profile_write_conflict" });
      const { tag: _tag, ...versioned } = values;
      const edit = await applyRuleEdit<ComplianceProfileRow>(db, {
        // ADR-0186 decision 29 (finding 52): re-applying a pack over a profile an admin tightened
        // is judged like any profile edit
        stepUp: approvalRuleStepUp(db, req),
        artifactType: "compliance_profile",
        artifactId: row.id,
        patch: versioned,
        actorUserId: req.authCtx.userId ?? null,
        label: `'${pack.label}' pack applied via POST /v1/onboarding/compliance-pack`,
        auditObjectType: "compliance_profile",
        auditRuleId: ONBOARDING_RULE_IDS.packApplied,
      });
      if (isRuleEditRefusal(edit)) {
        return reply.status(edit.status).send({ error: edit.error, detail: edit.detail });
      }
      profile = edit.row;
      versionMinted = edit.mintedVersion;
    }

    if (project && !alreadyClassified) {
      await db
        .update(projects)
        .set({ classifications: [...project.classifications, pack.tag] })
        .where(eq(projects.id, project.id));
    }

    await audit(req.authCtx.userId, "project", project?.id ?? null, ONBOARDING_RULE_IDS.packApplied, "allow",
      `applied the ${pack.label} compliance pack` +
        (project ? ` and classified project '${project.name}' with '${pack.tag}'` : " (profile only — no project classified yet, so the cascade is defined but inert)"),
      { pack: pack.tag, plan, projectId: project?.id ?? null });

    return {
      mode: "apply",
      pack: pack.tag,
      plan,
      profile,
      // ADR-0074 AMENDMENT (2026-08-09): `classifiedProject` was dropped when
      // `versionMinted` was added, which is an unannounced response-shape
      // change on a shipped route. No consumer reads it today — the wizard SPA
      // renders `plan.classification` — but "nobody uses it" is not a reason to
      // remove a field silently, and the ADR's change list did not mention it.
      // Restored; `versionMinted` is ADDITIVE beside it.
      classifiedProject: project && !alreadyClassified ? project.name : null,
      // ADR-0074: null on a create (nothing to version) and on a re-apply that
      // changed nothing; a version number when the pack genuinely moved an
      // enforcing field on a profile somebody had already versioned.
      versionMinted,
      note:
        "a pack is a STARTING POINT the cascade composes strictest-wins with your org and project settings — " +
        "it can only ever raise a floor, never relax one, and it is not a certification." +
        (versionMinted
          ? ` This profile is VERSIONED, so the pack was applied as version ${versionMinted} and activated — ` +
            `writing the row alone would have left enforcement on the previous version.`
          : ""),
    };
  });

  // =======================================================================
  // IMPORTS — the untrusted path
  // =======================================================================

  const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");

  /**
   * Wall 1. Runs on the RAW body before any parse. Returns a reply when the
   * payload tried to carry authority it was not given, having audited the
   * attempt and recorded it as a refused import — an operator must be able to
   * find "somebody uploaded a file that tried to mint administrators" months
   * later, and a browser error message is not findable.
   */
  const refuseEscalation = async (
    req: { authCtx: { userId: string | null } },
    kind: "users" | "group_roles",
    raw: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> } | null> => {
    const findings = screenForEscalation(raw);
    if (findings.length === 0) return null;
    const reason =
      `import refused: the payload carries ${findings.length} privilege-bearing field(s) ` +
      `(${findings.map((f) => f.path).slice(0, 5).join(", ")}). An import can never mint an ` +
      `administrator or name an entitlement directly — platform admin is granted one explicit ` +
      `act at a time, and role membership is decided by admin-authored group mappings.`;
    await db.insert(onboardingImports).values({
      kind,
      mode: "dry_run",
      status: "refused",
      payloadSha256: sha(raw),
      rowCount: 0,
      plan: { findings } as never,
      result: null,
      ruleId: ONBOARDING_RULE_IDS.importPrivilegeRefused,
      reason,
      requestedByUserId: req.authCtx.userId,
    });
    await audit(req.authCtx.userId, "onboarding_import", null, ONBOARDING_RULE_IDS.importPrivilegeRefused, "deny",
      reason, { kind, findings });
    return {
      status: 422,
      body: {
        error: "import_privilege_escalation_refused",
        ruleId: ONBOARDING_RULE_IDS.importPrivilegeRefused,
        findings,
        detail:
          "remove these fields and re-import. Administrators are granted through " +
          "POST /v1/users/:userId/admin; roles are conferred by group→role mappings you author.",
      },
    };
  };

  /** record a schema rejection the same way — malformed input is an event too */
  const recordRejection = async (
    actorUserId: string | null,
    kind: "users" | "group_roles",
    raw: unknown,
    reason: string,
    detail: Record<string, unknown>,
  ) => {
    await db.insert(onboardingImports).values({
      kind,
      mode: "dry_run",
      status: "refused",
      payloadSha256: sha(raw),
      rowCount: 0,
      plan: detail as never,
      result: null,
      ruleId: ONBOARDING_RULE_IDS.importRejected,
      reason,
      requestedByUserId: actorUserId,
    });
    await audit(actorUserId, "onboarding_import", null, ONBOARDING_RULE_IDS.importRejected, "deny", reason, {
      kind,
      ...detail,
    });
  };

  // ---- POST /v1/onboarding/imports/users --------------------------------
  app.post("/v1/onboarding/imports/users", async (req, reply) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const escalation = await refuseEscalation(req, "users", raw);
    if (escalation) return reply.status(escalation.status).send(escalation.body);

    // CSV and JSON converge on the SAME row objects, so both meet the same
    // strict schema and the same planner. A CSV with an `is_admin` column is a
    // loud refusal, not a quietly dropped column.
    let candidate: unknown = raw;
    if (typeof raw.csv === "string") {
      const rows = csvToUserRows(raw.csv);
      const reScreen = await refuseEscalation(req, "users", rows);
      if (reScreen) return reply.status(reScreen.status).send(reScreen.body);
      candidate = { mode: raw.mode, groupSource: raw.groupSource, rows };
    }

    const parsed = userImportSchema.safeParse(candidate);
    if (!parsed.success) {
      await recordRejection(req.authCtx.userId, "users", raw, "user import rejected: payload failed schema validation", {
        issues: parsed.error.issues.slice(0, 20),
      });
      return reply.status(422).send({
        error: "import_validation_failed",
        ruleId: ONBOARDING_RULE_IDS.importRejected,
        issues: parsed.error.issues,
      });
    }
    const body = parsed.data;

    const existing = await db
      .select({
        email: users.email,
        displayName: users.displayName,
        username: users.username,
        disabledAt: users.disabledAt,
      })
      .from(users);
    // ONE planner, called by the dry run and by the apply. A preview computed
    // differently from the thing it previews is not a preview.
    const plan = planUserImport(body.rows, existing);

    if (body.mode === "dry_run") {
      const [row] = await db
        .insert(onboardingImports)
        .values({
          kind: "users",
          mode: "dry_run",
          status: "planned",
          payloadSha256: sha(body.rows),
          rowCount: body.rows.length,
          plan: plan as never,
          result: null,
          ruleId: ONBOARDING_RULE_IDS.importPlanned,
          reason: `user import dry run: ${plan.counts.create} create, ${plan.counts.update} update, ${plan.counts.unchanged} unchanged`,
          requestedByUserId: req.authCtx.userId,
        })
        .returning();
      await audit(req.authCtx.userId, "onboarding_import", row!.id, ONBOARDING_RULE_IDS.importPlanned, "allow",
        `user import previewed (${body.rows.length} rows, nothing changed)`, { counts: plan.counts });
      return { mode: "dry_run", importId: row!.id, plan };
    }

    const applied = { created: [] as string[], updated: [] as string[], skipped: [] as Array<{ email: string; why: string }> };
    const groupSource = body.groupSource as GroupSource;
    const rowsByEmail = new Map(body.rows.map((r) => [r.email, r]));

    for (const entry of plan.entries) {
      const row = rowsByEmail.get(entry.email)!;
      if (entry.action === "reactivate_required") {
        applied.skipped.push({
          email: entry.email,
          why: "account is deactivated — reactivate it explicitly (ADR-0022 makes that a governed act an import must not perform)",
        });
        continue;
      }
      if (entry.action === "create") {
        // Wall 3: the SAME seat gate POST /v1/users applies. An import cannot
        // outrun the licensed cap by arriving in bulk.
        const seatRefusal = await refuseIfSeatCapReached(db, {
          actorUserId: req.authCtx.userId ?? null,
          email: entry.email,
        });
        if (seatRefusal) {
          applied.skipped.push({ email: entry.email, why: String(seatRefusal.body.detail ?? "seat cap reached") });
          continue;
        }
        // Wall 4: `isAdmin` is not in this values object. Not `false` —
        // ABSENT. There is no field for a payload to have influenced.
        const [created] = await db
          .insert(users)
          .values({
            email: entry.email,
            displayName: row.displayName,
            ...(row.username ? { username: row.username } : {}),
          })
          .onConflictDoNothing({ target: users.email })
          .returning();
        if (created) applied.created.push(entry.email);
      } else if (entry.action === "update") {
        await db
          .update(users)
          .set({
            displayName: row.displayName,
            ...(row.username ? { username: row.username } : {}),
          })
          .where(eq(users.email, entry.email));
        applied.updated.push(entry.email);
      }

      // Groups are recorded as ASSERTIONS and reconciled through the mappings
      // an admin authored. The file said "Engineering-EMEA"; whether that is
      // worth a role is not the file's call.
      if (entry.groups.length > 0) {
        const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, entry.email));
        if (u) {
          await reconcileGroupRoles(db, u.id, groupSource, entry.groups, {
            kind: "onboarding-user-import",
            actor: "onboarding import",
            actorUserId: req.authCtx.userId ?? null,
            detail: { source: groupSource },
          });
        }
      }
    }

    const [importRow] = await db
      .insert(onboardingImports)
      .values({
        kind: "users",
        mode: "apply",
        status: "applied",
        payloadSha256: sha(body.rows),
        rowCount: body.rows.length,
        plan: plan as never,
        result: applied as never,
        ruleId: ONBOARDING_RULE_IDS.importApplied,
        reason: `user import applied: ${applied.created.length} created, ${applied.updated.length} updated, ${applied.skipped.length} skipped`,
        requestedByUserId: req.authCtx.userId,
        appliedAt: new Date(),
      })
      .returning();
    await audit(req.authCtx.userId, "onboarding_import", importRow!.id, ONBOARDING_RULE_IDS.importApplied, "allow",
      `user import applied: ${applied.created.length} created, ${applied.updated.length} updated, ${applied.skipped.length} skipped — no imported account is an administrator`,
      { counts: plan.counts, created: applied.created.length, updated: applied.updated.length, skipped: applied.skipped });
    return { mode: "apply", importId: importRow!.id, plan, applied };
  });

  // ---- POST /v1/onboarding/imports/group-roles --------------------------
  app.post("/v1/onboarding/imports/group-roles", async (req, reply) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const escalation = await refuseEscalation(req, "group_roles", raw);
    if (escalation) return reply.status(escalation.status).send(escalation.body);

    const parsed = groupRoleImportSchema.safeParse(raw);
    if (!parsed.success) {
      await recordRejection(req.authCtx.userId, "group_roles", raw,
        "group→role import rejected: payload failed schema validation",
        { issues: parsed.error.issues.slice(0, 20) });
      return reply.status(422).send({
        error: "import_validation_failed",
        ruleId: ONBOARDING_RULE_IDS.importRejected,
        issues: parsed.error.issues,
      });
    }
    const body = parsed.data;

    const [knownRoles, existingMappings] = await Promise.all([
      db.select({ id: roles.id, name: roles.name }).from(roles),
      db
        .select({
          source: groupRoleMappings.source,
          externalGroup: groupRoleMappings.externalGroup,
          roleId: groupRoleMappings.roleId,
        })
        .from(groupRoleMappings),
    ]);
    const plan = planGroupRoleImport(body.rows, knownRoles, existingMappings);

    // An import that references a role nobody created is REFUSED WHOLE, not
    // partially applied. Creating the role would let a file define an
    // entitlement bundle no admin reviewed; applying the rest would leave the
    // org in a state the file does not describe.
    if (plan.counts.unknown_role > 0) {
      const reason =
        `group→role import refused: ${plan.counts.unknown_role} row(s) name roles that do not exist ` +
        `(${plan.unknownRoles.slice(0, 10).join(", ")}). An import never creates a role — a file that ` +
        `defines an entitlement bundle is a file defining policy, and policy is authored, not imported.`;
      await db.insert(onboardingImports).values({
        kind: "group_roles",
        mode: body.mode,
        status: "refused",
        payloadSha256: sha(body.rows),
        rowCount: body.rows.length,
        plan: plan as never,
        result: null,
        ruleId: ONBOARDING_RULE_IDS.importRejected,
        reason,
        requestedByUserId: req.authCtx.userId,
      });
      await audit(req.authCtx.userId, "onboarding_import", null, ONBOARDING_RULE_IDS.importRejected, "deny", reason, {
        unknownRoles: plan.unknownRoles,
      });
      return reply.status(422).send({
        error: "unknown_role",
        ruleId: ONBOARDING_RULE_IDS.importRejected,
        unknownRoles: plan.unknownRoles,
        plan,
      });
    }

    if (body.mode === "dry_run") {
      const [row] = await db
        .insert(onboardingImports)
        .values({
          kind: "group_roles",
          mode: "dry_run",
          status: "planned",
          payloadSha256: sha(body.rows),
          rowCount: body.rows.length,
          plan: plan as never,
          result: null,
          ruleId: ONBOARDING_RULE_IDS.importPlanned,
          reason: `group→role import dry run: ${plan.counts.create} create, ${plan.counts.unchanged} unchanged`,
          requestedByUserId: req.authCtx.userId,
        })
        .returning();
      await audit(req.authCtx.userId, "onboarding_import", row!.id, ONBOARDING_RULE_IDS.importPlanned, "allow",
        `group→role import previewed (${body.rows.length} rows, nothing changed)`, { counts: plan.counts });
      return { mode: "dry_run", importId: row!.id, plan };
    }

    const roleByName = new Map(knownRoles.map((r) => [r.name.toLowerCase(), r]));
    // B4S-02 / G1 (owner principle): a mapping to a role an approval rule names
    // as approver_role_id adds that group's holders to an approver pool — the
    // same settings_relax step-up as POST /v1/group-role-mappings, bound to
    // every such mapping this import creates (sorted, so the same file asks
    // for the same grant)
    const approverMappings: Array<{ source: string; externalGroup: string; roleId: string }> = [];
    for (const e of plan.entries) {
      if (e.action !== "create") continue;
      const role = roleByName.get(e.roleName.toLowerCase())!;
      if (await isApproverRole(db, role.id)) approverMappings.push({ source: e.source, externalGroup: e.externalGroup, roleId: role.id });
    }
    if (approverMappings.length > 0) {
      approverMappings.sort((a, b) =>
        `${a.source}\u0000${a.externalGroup}\u0000${a.roleId}`.localeCompare(`${b.source}\u0000${b.externalGroup}\u0000${b.roleId}`),
      );
      const facts = { values: { approverRoleGroups: approverMappings } };
      if (!(await requireStepUp(db, req, reply, { kind: "settings_relax", facts })).ok) return reply;
    }
    // ADR-0186 A (Class A): the mappings are written under the approver-role lock, and a
    // role that became an approver role since the step-up was decided refuses the import
    const createIds = plan.entries.filter((e) => e.action === "create").map((e) => roleByName.get(e.roleName.toLowerCase())!.id);
    const decidedApprover = new Set(approverMappings.map((m) => m.roleId));
    const created = await db.transaction(async (tx) => {
      const nowApprover = await lockApproverRoles(tx as unknown as Db, createIds);
      if ([...nowApprover].some((id) => !decidedApprover.has(id))) return null;
      let n = 0;
      for (const e of plan.entries) {
        if (e.action !== "create") continue;
        const role = roleByName.get(e.roleName.toLowerCase())!;
        const [row] = await tx
          .insert(groupRoleMappings)
          .values({ source: e.source as GroupSource, externalGroup: e.externalGroup, roleId: role.id })
          .onConflictDoNothing()
          .returning();
        if (row) n += 1;
      }
      return n;
    });
    if (created === null) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    const [importRow] = await db
      .insert(onboardingImports)
      .values({
        kind: "group_roles",
        mode: "apply",
        status: "applied",
        payloadSha256: sha(body.rows),
        rowCount: body.rows.length,
        plan: plan as never,
        result: { created } as never,
        ruleId: ONBOARDING_RULE_IDS.importApplied,
        reason: `group→role import applied: ${created} mapping(s) created`,
        requestedByUserId: req.authCtx.userId,
        appliedAt: new Date(),
      })
      .returning();
    await audit(req.authCtx.userId, "onboarding_import", importRow!.id, ONBOARDING_RULE_IDS.importApplied, "allow",
      `group→role import applied: ${created} mapping(s) created, all bound to roles that already existed`,
      { counts: plan.counts, created });
    return { mode: "apply", importId: importRow!.id, plan, created };
  });

  // ---- GET /v1/onboarding/imports ---------------------------------------
  app.get("/v1/onboarding/imports", async (req) => {
    const q = z
      .object({
        kind: z.enum(["users", "group_roles"]).optional(),
        status: z.enum(["planned", "applied", "refused"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query ?? {});
    const conds = [
      ...(q.kind ? [eq(onboardingImports.kind, q.kind)] : []),
      ...(q.status ? [eq(onboardingImports.status, q.status)] : []),
    ];
    const rows = await db
      .select()
      .from(onboardingImports)
      .where(conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds))
      .orderBy(desc(onboardingImports.createdAt))
      .limit(q.limit);
    return {
      imports: rows,
      /** the refusals are in here too, deliberately — a rejected privilege
       * escalation is exactly the row an operator is looking for */
      includesRefusals: true,
    };
  });

  // =======================================================================
  // GET /v1/onboarding/export — the wizard's output AS POLICY-AS-CODE
  // =======================================================================
  //
  // ADR-0054 §4: complete the wizard once, export the result, apply it to the
  // next sovereign deployment as code, without redoing the clicks. Everything
  // here is read out of the ORDINARY tables — there is no "wizard mode"
  // representation to export, which is the entire point.
  app.get("/v1/onboarding/export", async (req) => {
    const [roleRows, mappingRows, profileRows, projectRows, stepRows] = await Promise.all([
      db.select({ name: roles.name, description: roles.description }).from(roles),
      db
        .select({
          source: groupRoleMappings.source,
          externalGroup: groupRoleMappings.externalGroup,
          roleName: roles.name,
        })
        .from(groupRoleMappings)
        .innerJoin(roles, eq(roles.id, groupRoleMappings.roleId)),
      db.select().from(complianceProfiles),
      db.select({ name: projects.name, classifications: projects.classifications }).from(projects),
      db.select().from(onboardingSteps),
    ]);
    await audit(req.authCtx.userId, "onboarding_step", null, ONBOARDING_RULE_IDS.configExported, "allow",
      "onboarding configuration exported as policy-as-code",
      { roles: roleRows.length, mappings: mappingRows.length, profiles: profileRows.length });
    return {
      schema: "regulait.onboarding.export/v1",
      exportedAt: new Date().toISOString(),
      roles: roleRows,
      // group→role import consumes exactly this shape, so an export from one
      // deployment is a valid import into the next
      groupRoleMappings: mappingRows,
      complianceProfiles: profileRows,
      projectClassifications: projectRows.filter((p) => ((p.classifications ?? []) as string[]).length > 0),
      checklist: stepRows,
      notIncluded: [
        "users — import them from the customer's own directory, never from another deployment's export",
        "credentials and secrets of any kind",
        "platform-admin flags — admin is granted per user, deliberately, and is never replayed from a file",
      ],
    };
  });
}

/** exported for the seed/test paths that want the same live view */
export { sql as _sql };
