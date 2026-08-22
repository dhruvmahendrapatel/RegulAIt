/**
 * ADR-0058 — REGULATORY COMPLIANCE PACKS, the gateway half.
 *
 *   `packages/shared/src/compliance-packs.ts`  the vocabulary, the satisfaction
 *                                              rule, the scorecard arithmetic,
 *                                              the seed packs, the disclaimer.
 *                                              Pure — no db, no clock.
 *   THIS FILE                                  the EVIDENCE QUERIES (real
 *                                              SELECTs over real ledgers), the
 *                                              pack admin API, the entitlement
 *                                              decision, the report ledger and
 *                                              the audit rows.
 *
 * THE THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE
 * --------------------------------------------------
 *  1. EVIDENCE IS A QUERY, NEVER A TICK-BOX. `runCollector` is the only way a
 *     control gets a number, and every branch of it is a SELECT against a
 *     ledger this deployment already writes — `audit_log`, `approvals`,
 *     `model_card_approvals`, `eval_runs`, `guardrail_configs`,
 *     `abac_policies`, `lineage_edges`, `usage_events`, `compliance_profiles`.
 *     There is no column anywhere in migration 0073 that an admin could set to
 *     make a control green. Seed the evidence and the control goes green;
 *     delete it and the control goes red again, in the same period, with no
 *     other change.
 *
 *  2. A PACK REPORT NEVER EXCEEDS THE CALLER'S OWN VISIBILITY. It reuses
 *     ADR-0047's `evaluateReportAccess` VERBATIM rather than inventing a second
 *     entitlement rule — one decision function, one set of refusals, one thing
 *     to get right. The decision returns the exact project-id list, and every
 *     scoped collector builds its WHERE clause FROM that list at query
 *     construction. A team lead's HIPAA scorecard therefore cannot contain
 *     another team's audit rows, because those rows were never selected.
 *
 *  3. THE ARTIFACT NEVER CLAIMS COMPLIANCE. `buildPackScorecard` has no verdict
 *     field to fill in, and `COMPLIANCE_PACK_DISCLAIMER` is a property of every
 *     scorecard object and every stored report row. Producing an EU AI Act
 *     control-mapping report is not compliance with the EU AI Act and is not a
 *     certification of anything — the artifact says so on its face, not in a
 *     ToS.
 *
 * WHAT A PACK CANNOT DO, STATED PLAINLY. A pack cannot add a new evidence
 * SOURCE. `collector` names one of a fixed, parameterised vocabulary over
 * ledgers that already exist; a pack is analyst-authored data and one that
 * could carry SQL would be an injection primitive wearing a control mapping's
 * clothes. A control needing a ledger RegulAIt does not keep must be marked
 * attestation-required. Everything else — a new framework, a new control, a
 * revised mapping, a customer's own internal control set — is rows, no deploy.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  abacPolicies,
  and,
  approvals,
  auditLog,
  auditLog as auditLogTable,
  compliancePackAttestations,
  compliancePackControls,
  compliancePackReports,
  compliancePacks,
  complianceProfiles,
  count,
  desc,
  eq,
  evalRuns,
  guardrailConfigs,
  gte,
  inArray,
  isNotNull,
  lineageEdges,
  lt,
  modelCardApprovals,
  projectMembers,
  sql,
  usageEvents,
  type CompliancePackControlRow,
  type CompliancePackRow,
  type Db,
} from "@regulait/db";
import {
  COMPLIANCE_PACK_DISCLAIMER,
  COMPLIANCE_PACK_UPDATE_POLICY,
  DEFAULT_COMPLIANCE_PACKS,
  assessPackControl,
  buildPackScorecard,
  createCompliancePackSchema,
  evaluatePackSchema,
  diffCompliancePacks,
  evaluateReportAccess,
  packAttestationSchema,
  resolveReportPeriod,
  VERSIONED_RULE_FIELDS,
  type CollectorParams,
  type EvidenceCollectorId,
  type PackControlAssessment,
  type PackScorecard,
  type PackVersionSnapshot,
} from "@regulait/shared";
import { refuseIfFeatureNotLicensed } from "./licensing.js";
import { callerProjectIds, callerTeamIds, resolveScopeProjectIds } from "./reporting.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
/** a uuid that cannot exist, so an empty allow-list yields an empty result set
 * rather than an unconstrained query — fail CLOSED, never open */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const idParam = z.object({ id: z.string().uuid() });

/** stable rule ids — the strings an operator greps the audit log for */
export const COMPLIANCE_PACK_RULE_IDS = {
  packCreated: "compliance-pack-created",
  packSeeded: "compliance-pack-seeded",
  packActivated: "compliance-pack-activated",
  packRetired: "compliance-pack-retired",
  packDeleted: "compliance-pack-deleted",
  attestationRecorded: "compliance-pack-attestation-recorded",
  cascadeProfileCreated: "compliance-pack-cascade-profile-created",
  cascadeProfilePreserved: "compliance-pack-cascade-profile-preserved",
  evaluated: "compliance-pack-evaluated",
  diffComputed: "compliance-pack-diff-computed",
  evaluationDenied: "compliance-pack-evaluation-denied",
  reportReadDenied: "compliance-pack-report-read-denied",
} as const;

// ---------------------------------------------------------------------------
// THE EVIDENCE COLLECTORS — every one a real SELECT
// ---------------------------------------------------------------------------

export interface CollectorContext {
  periodStart: Date;
  periodEnd: Date;
  /** the EXACT project ids the caller may see. `null` = org-wide (admin under
   * an org-scoped request) and is the only way un-attributed rows are reached. */
  projectIds: string[] | null;
  /** the users who are members of `projectIds`, for ledgers with no project
   * column of their own (approvals). Null exactly when projectIds is null. */
  memberIds: string[] | null;
  params: CollectorParams;
}

/** the scoped id list, or the impossible uuid so an empty allow-list selects
 * nothing rather than everything */
const safeIds = (ids: string[]) => (ids.length ? ids : [ZERO_UUID]);

/**
 * The jsonb project predicate for `audit_log`, which carries no project column
 * — attribution rides `detail.projectId`, the key every governed path writes.
 * Built by interpolation, so every id is re-validated as a uuid on the way in:
 * a non-uuid here would be an injection primitive, and it throws instead.
 */
function auditProjectPredicate(projectIds: string[]) {
  const ids = safeIds(projectIds).map((p) => `'${assertUuid(p)}'`).join(",");
  return sql`${auditLogTable.detail} ->> 'projectId' = ANY(${sql.raw(`ARRAY[${ids}]::text[]`)})`;
}

function assertUuid(v: string): string {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) {
    throw new Error("non-uuid project id in compliance-pack scope");
  }
  return v;
}

const MODE_RANK: Record<string, number> = { off: 0, log: 1, warn: 2, block: 3 };

/**
 * ONE FUNCTION, ONE NUMBER, ALWAYS FROM A LEDGER.
 *
 * Returns `null` only for the `none` collector — the attestation/unaddressed
 * case, which never produces a count because there is nothing to count.
 */
export async function runCollector(
  db: Db,
  collector: EvidenceCollectorId,
  ctx: CollectorContext,
): Promise<number | null> {
  const { periodStart, periodEnd, projectIds, memberIds, params } = ctx;

  switch (collector) {
    case "none":
      return null;

    case "audit_decisions": {
      const where = and(
        gte(auditLog.at, periodStart),
        lt(auditLog.at, periodEnd),
        ...(params.effect ? [eq(auditLog.effect, params.effect)] : []),
        ...(params.objectType
          ? [eq(auditLog.objectType, params.objectType as (typeof auditLog.objectType)["_"]["data"])]
          : []),
        ...(params.ruleIdPrefix ? [sql`${auditLog.ruleId} LIKE ${params.ruleIdPrefix + "%"}`] : []),
        // SCOPING AT QUERY CONSTRUCTION, never a filter over an aggregate
        ...(projectIds === null ? [] : [auditProjectPredicate(projectIds)]),
      );
      const [row] = await db.select({ n: count() }).from(auditLog).where(where);
      return row?.n ?? 0;
    }

    case "approvals": {
      // `approvals` has a nullable project column and predates it, so scope by
      // BOTH the project column and the requesting user's membership — an
      // approval belonging to a member of the caller's projects counts, one
      // belonging to a stranger does not.
      const where = and(
        gte(approvals.requestedAt, periodStart),
        lt(approvals.requestedAt, periodEnd),
        ...(params.status ? [eq(approvals.status, params.status)] : []),
        ...(params.approvalObjectType
          ? [eq(approvals.objectType, params.approvalObjectType as "mcp_tool")]
          : []),
        ...(memberIds === null ? [] : [inArray(approvals.userId, safeIds(memberIds))]),
      );
      const [row] = await db.select({ n: count() }).from(approvals).where(where);
      return row?.n ?? 0;
    }

    case "model_cards_approved": {
      // CONFIGURATION evidence, not period evidence: an unexpired sign-off is a
      // state, and expiry is recomputed here rather than trusting `status`,
      // exactly as ADR-0045's dispatch gate does.
      const [row] = await db
        .select({ n: count() })
        .from(modelCardApprovals)
        .where(
          and(
            eq(modelCardApprovals.status, "approved"),
            sql`(${modelCardApprovals.validUntil} IS NULL OR ${modelCardApprovals.validUntil} > ${periodEnd})`,
          ),
        );
      return row?.n ?? 0;
    }

    case "eval_runs": {
      const [row] = await db
        .select({ n: count() })
        .from(evalRuns)
        .where(and(gte(evalRuns.startedAt, periodStart), lt(evalRuns.startedAt, periodEnd)));
      return row?.n ?? 0;
    }

    case "guardrail_configs": {
      // CONFIGURATION evidence. A quiet period is not proof a runtime control
      // exists, so this counts configs at or above the required mode rather
      // than counting violations.
      const detector = params.detector ?? "prompt_injection";
      const minMode = params.minMode ?? "warn";
      const col =
        detector === "jailbreak"
          ? guardrailConfigs.jailbreakMode
          : detector === "toxicity"
            ? guardrailConfigs.toxicityMode
            : detector === "semantic_dlp"
              ? guardrailConfigs.semanticDlpMode
              : guardrailConfigs.promptInjectionMode;
      const atOrAbove = Object.entries(MODE_RANK)
        .filter(([, rank]) => rank >= (MODE_RANK[minMode] ?? 2))
        .map(([m]) => m);
      const [row] = await db
        .select({ n: count() })
        .from(guardrailConfigs)
        .where(inArray(col, atOrAbove as Array<"off" | "log" | "warn" | "block">));
      return row?.n ?? 0;
    }

    case "abac_policies_active": {
      const [row] = await db
        .select({ n: count() })
        .from(abacPolicies)
        .where(and(eq(abacPolicies.enabled, true), isNotNull(abacPolicies.activeVersionId)));
      return row?.n ?? 0;
    }

    case "lineage_edges": {
      const where = and(
        gte(lineageEdges.at, periodStart),
        lt(lineageEdges.at, periodEnd),
        ...(params.edgeKind
          ? [eq(lineageEdges.kind, params.edgeKind as (typeof lineageEdges.kind)["_"]["data"])]
          : []),
        ...(projectIds === null ? [] : [inArray(lineageEdges.projectId, safeIds(projectIds))]),
      );
      const [row] = await db.select({ n: count() }).from(lineageEdges).where(where);
      return row?.n ?? 0;
    }

    case "attributed_usage": {
      const where = and(
        gte(usageEvents.at, periodStart),
        lt(usageEvents.at, periodEnd),
        isNotNull(usageEvents.projectId),
        ...(projectIds === null ? [] : [inArray(usageEvents.projectId, safeIds(projectIds))]),
      );
      const [row] = await db.select({ n: count() }).from(usageEvents).where(where);
      return row?.n ?? 0;
    }

    case "compliance_profile_cascade": {
      // Evidence that the §8.3 cascade is CONFIGURED to force something, not
      // merely that the feature exists. Each aspect maps to the column the
      // cascade actually composes.
      const aspect = params.cascadeAspect ?? "pii_block";
      const predicate =
        aspect === "retention"
          ? isNotNull(complianceProfiles.auditRetentionDays)
          : aspect === "guardrail_floor"
            ? sql`${complianceProfiles.guardrailModes} IS NOT NULL AND ${complianceProfiles.guardrailModes}::text <> '{}'`
            : aspect === "budget_ceiling"
              ? isNotNull(complianceProfiles.maxProjectBudgetUsd)
              : eq(complianceProfiles.piiMode, "block");
      const [row] = await db.select({ n: count() }).from(complianceProfiles).where(predicate);
      return row?.n ?? 0;
    }

    default: {
      // an unknown collector is NOT silently zero-and-green: it is a hard
      // failure, because a pack referencing a collector this build does not
      // have would otherwise report every one of its controls as unsatisfied
      // for a reason nobody could see.
      throw new Error(`unknown evidence collector '${collector as string}'`);
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EvaluatePackArgs {
  pack: CompliancePackRow;
  controls: CompliancePackControlRow[];
  projectIds: string[] | null;
  periodStart: Date;
  periodEnd: Date;
  period: string;
  periodLabel: string;
  scopeKind: string;
  scopeId: string | null;
  now: Date;
}

export async function evaluatePack(db: Db, args: EvaluatePackArgs): Promise<PackScorecard> {
  const memberIds =
    args.projectIds === null
      ? null
      : (
          await db
            .selectDistinct({ userId: projectMembers.userId })
            .from(projectMembers)
            .where(inArray(projectMembers.projectId, safeIds(args.projectIds)))
        ).map((r) => r.userId);

  // the live attestations for this pack, newest first — read ONCE, matched per
  // control, so an attestation for a control the pack does not declare is
  // simply never consulted
  const attestations = await db
    .select()
    .from(compliancePackAttestations)
    .where(eq(compliancePackAttestations.packId, args.pack.id))
    .orderBy(desc(compliancePackAttestations.attestedAt));

  const assessments: PackControlAssessment[] = [];
  for (const c of args.controls) {
    const evidenceCount = await runCollector(db, c.collector as EvidenceCollectorId, {
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      projectIds: args.projectIds,
      memberIds,
      params: (c.collectorParams ?? {}) as CollectorParams,
    });
    const att = attestations.find((a) => a.controlRef === c.controlRef);
    assessments.push(
      assessPackControl(
        {
          controlRef: c.controlRef,
          title: c.title,
          coverage: c.coverage,
          collector: c.collector as EvidenceCollectorId,
          minEvidenceCount: c.minEvidenceCount,
          attestationRequired: c.attestationRequired,
          ownerNote: c.ownerNote,
        },
        evidenceCount,
        att
          ? {
              statement: att.statement,
              attestedBy: att.attestedByUserId,
              attestedAt: att.attestedAt.toISOString(),
              validUntil: att.validUntil ? att.validUntil.toISOString() : null,
            }
          : null,
        args.now,
      ),
    );
  }

  return buildPackScorecard({
    framework: args.pack.framework,
    packVersion: args.pack.version,
    packTitle: args.pack.title,
    cascadeTag: args.pack.cascadeTag,
    scope: { kind: args.scopeKind, id: args.scopeId, projectIds: args.projectIds },
    period: {
      period: args.period,
      label: args.periodLabel,
      start: args.periodStart.toISOString(),
      end: args.periodEnd.toISOString(),
    },
    generatedAt: args.now.toISOString(),
    controls: assessments,
  });
}

/**
 * The controls section of an ADR-0047 report, computed from a pack. This is
 * what RETIRES ADR-0047's placeholder five-control catalogue: a report
 * definition naming a pack gets the pack's real, ledger-evidenced assessment,
 * stamped with the pack version, instead of the built-in stand-in.
 */
export async function packControlsSection(
  db: Db,
  args: {
    packId: string;
    projectIds: string[] | null;
    periodStart: Date;
    periodEnd: Date;
    now: Date;
  },
): Promise<{
  framework: string;
  catalogueSource: "pack";
  packId: string;
  packVersion: number;
  /** `id` mirrors `controlRef` so ADR-0047's CSV renderer keys a pack-sourced
   * control exactly as it keys a built-in one — one export format, not two */
  controls: Array<PackControlAssessment & { id: string }>;
  met: number;
  gaps: number;
  attestationRequired: number;
  attested: number;
  unaddressed: number;
  note: string;
} | null> {
  const [pack] = await db.select().from(compliancePacks).where(eq(compliancePacks.id, args.packId));
  if (!pack) return null;
  const controls = await db
    .select()
    .from(compliancePackControls)
    .where(eq(compliancePackControls.packId, pack.id))
    .orderBy(compliancePackControls.controlRef);
  const scorecard = await evaluatePack(db, {
    pack,
    controls,
    projectIds: args.projectIds,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    period: "custom",
    periodLabel: "report period",
    scopeKind: "report",
    scopeId: null,
    now: args.now,
  });
  return {
    framework: pack.framework,
    catalogueSource: "pack",
    packId: pack.id,
    packVersion: pack.version,
    controls: scorecard.controls.map((c) => ({ ...c, id: c.controlRef })),
    met: scorecard.totals.satisfied,
    gaps: scorecard.totals.unsatisfied,
    attestationRequired: scorecard.totals.attestationRequired,
    attested: scorecard.totals.attested,
    unaddressed: scorecard.totals.unaddressed,
    note:
      `Control catalogue is compliance pack '${pack.framework}' v${pack.version} (ADR-0058). ` +
      COMPLIANCE_PACK_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function insertPack(
  db: Db,
  input: z.infer<typeof createCompliancePackSchema>,
  createdByUserId: string | null,
): Promise<CompliancePackRow> {
  const [pack] = await db
    .insert(compliancePacks)
    .values({
      framework: input.framework,
      version: input.version,
      title: input.title,
      description: input.description ?? null,
      provenance: input.provenance as Record<string, unknown>,
      cascadeTag: input.cascadeTag ?? null,
      cascadePreset: input.cascadePreset ?? null,
      status: "draft",
      createdByUserId,
    })
    .returning();
  await db.insert(compliancePackControls).values(
    input.controls.map((c) => ({
      packId: pack!.id,
      controlRef: c.controlRef,
      title: c.title,
      description: c.description ?? null,
      coverage: c.coverage,
      collector: c.collector,
      collectorParams: c.collectorParams as Record<string, unknown>,
      minEvidenceCount: c.minEvidenceCount,
      attestationRequired: c.attestationRequired,
      ownerNote: c.ownerNote ?? null,
    })),
  );
  return pack!;
}

// ---------------------------------------------------------------------------
// Batch B1 (ADR-0058 §2's preset half) — pack activation seeds its cascade
// profile.
// ---------------------------------------------------------------------------

export type CascadeProfileAction = "created" | "exists_preserved" | "no_preset" | "none";

export interface CascadeProfileOutcome {
  action: CascadeProfileAction;
  tag: string | null;
  profileId: string | null;
  note: string;
}

/**
 * FIND-OR-CREATE the `compliance_profiles` row a pack's cascade tag keys on,
 * from the pack's own stored preset. The four cases, each honest in the
 * response AND on the audit ledger:
 *
 *   none              cascadeTag is null (SOC 2): the framework forces no
 *                     data-sensitivity cascade, so nothing is seeded and the
 *                     response says why.
 *   no_preset         the pack names a tag but carries no preset (every pack
 *                     row that predates migration 0096, and any admin pack
 *                     authored without one): behaviour is exactly pre-B1 — the
 *                     admin authors the profile — but the activation now SAYS
 *                     that instead of leaving the §8.3 half silently unwired.
 *   created           no profile exists for the tag: one is created from the
 *                     preset. A create cannot have `config_versions` rows at
 *                     the instant it is written (the same invariant-4
 *                     reasoning as every other create in this codebase), so
 *                     no version is minted.
 *   exists_preserved  a profile already exists: it is NEVER overwritten — an
 *                     admin may have tuned it, and a pack activation quietly
 *                     replacing tuned floors would be ADR-0074's silent-write
 *                     class arriving through a wizard. The response and the
 *                     ledger both carry the "presets not applied" note.
 *
 * IDEMPOTENT by construction: re-activation finds the profile it created and
 * lands in `exists_preserved`; a concurrent activation loses the
 * `onConflictDoNothing` race and lands there too.
 *
 * DEACTIVATION/RETIREMENT/DELETION OF A PACK NEVER DELETES THE PROFILE. The
 * profile is live enforcement over every project carrying the tag; removing
 * enforcement as a side effect of housekeeping on a REPORTING artifact is the
 * silent-revocation class this project refuses (the same reason ADR-0019
 * revocations are explicit acts). An admin who wants the floors gone deletes
 * the profile deliberately.
 */
export async function ensureCascadeProfile(
  db: Db,
  pack: CompliancePackRow,
  actorUserId: string | null,
): Promise<CascadeProfileOutcome> {
  if (!pack.cascadeTag) {
    return {
      action: "none",
      tag: null,
      profileId: null,
      note:
        "This framework forces no §8.3 cascade (cascadeTag is null) — it is an attestation framework " +
        "about the organisation, not a data-sensitivity regime — so no compliance profile is seeded.",
    };
  }
  const tag = pack.cascadeTag;
  const [existing] = await db
    .select({ id: complianceProfiles.id })
    .from(complianceProfiles)
    .where(eq(complianceProfiles.tag, tag));

  const preset = (pack.cascadePreset ?? null) as Record<string, unknown> | null;
  if (!preset) {
    return {
      action: "no_preset",
      tag,
      profileId: existing?.id ?? null,
      note: existing
        ? `This pack carries no cascade preset; the existing compliance profile '${tag}' is untouched.`
        : `This pack names cascade tag '${tag}' but carries no preset, so no profile was created — ` +
          `author one via POST /v1/compliance/profiles or classifying with '${tag}' will enforce nothing.`,
    };
  }

  const preserved = (profileId: string): CascadeProfileOutcome => ({
    action: "exists_preserved",
    tag,
    profileId,
    note:
      `Compliance profile '${tag}' already exists — the pack's presets were NOT applied over it. A ` +
      `profile an admin may have tuned is never overwritten by pack activation; apply changes ` +
      `deliberately via POST /v1/compliance/profiles, which versions them when the profile is versioned.`,
  });

  if (existing) {
    await db.insert(auditLogTable).values({
      userId: actorUserId ?? NO_IDENTITY,
      objectType: "compliance_profile",
      objectId: existing.id,
      detail: { phase: "pack-cascade-profile", packId: pack.id, framework: pack.framework, packVersion: pack.version, tag },
      effect: "allow",
      ruleId: COMPLIANCE_PACK_RULE_IDS.cascadeProfilePreserved,
      ruleChain: [],
      reason:
        `activation of compliance pack '${pack.framework}' v${pack.version} found an existing compliance ` +
        `profile for '${tag}' and left it untouched — a pack activation never overwrites a profile an ` +
        `admin may have tuned`,
    });
    return preserved(existing.id);
  }

  // Only the versionable profile columns can come from a preset — the create
  // schema already validated that, and filtering here means a pre-validation
  // row (or a hand-edited one) still cannot smuggle `tag`/identity columns.
  const values: Record<string, unknown> = { tag };
  for (const f of VERSIONED_RULE_FIELDS["compliance_profile"] ?? []) {
    if (Object.prototype.hasOwnProperty.call(preset, f)) values[f] = preset[f];
  }
  const [created] = await db
    .insert(complianceProfiles)
    .values(values as typeof complianceProfiles.$inferInsert)
    .onConflictDoNothing({ target: complianceProfiles.tag })
    .returning({ id: complianceProfiles.id });
  if (!created) {
    // lost a concurrent-create race — the winner's profile stands, unedited
    const [row] = await db
      .select({ id: complianceProfiles.id })
      .from(complianceProfiles)
      .where(eq(complianceProfiles.tag, tag));
    return preserved(row?.id ?? "");
  }
  await db.insert(auditLogTable).values({
    userId: actorUserId ?? NO_IDENTITY,
    objectType: "compliance_profile",
    objectId: created.id,
    detail: {
      phase: "pack-cascade-profile",
      packId: pack.id,
      framework: pack.framework,
      packVersion: pack.version,
      tag,
      preset,
    },
    effect: "allow",
    ruleId: COMPLIANCE_PACK_RULE_IDS.cascadeProfileCreated,
    ruleChain: [],
    reason:
      `activation of compliance pack '${pack.framework}' v${pack.version} created compliance profile ` +
      `'${tag}' from the pack's preset — every Initiative/project classified '${tag}' now inherits its ` +
      `floors through the existing §8.3 cascade (strictest-wins: a preset can only ever raise a floor)`,
  });
  return {
    action: "created",
    tag,
    profileId: created.id,
    note:
      `Compliance profile '${tag}' was created from the pack's preset. Classifying an Initiative/project ` +
      `with '${tag}' now drives the existing §8.3 cascade — PII mode, MCP default, retention and the other ` +
      `floors the preset states. A preset is a starting point the cascade composes strictest-wins with your ` +
      `org and project settings; it can only ever raise a floor, and it is not a certification.`,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerCompliancePackRoutes(app: FastifyInstance, db: Db): void {
  async function audit(
    actor: string | null,
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
    effect: "allow" | "deny" = "allow",
  ) {
    await db.insert(auditLog).values({
      userId: actor ?? NO_IDENTITY,
      objectType: "compliance_pack",
      objectId,
      detail,
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  }

  // --- the catalogue, as DATA (admin-only via the global gate) -------------

  /** THE PROOF THAT PACKS ARE DATA: this is how a framework nobody shipped
   * becomes evaluable, with no code change and no deploy. */
  app.post("/v1/compliance/packs", async (req, reply) => {
    const body = createCompliancePackSchema.parse(req.body);
    const pack = await insertPack(db, body, req.authCtx.userId ?? null);
    await audit(
      req.authCtx.userId ?? null,
      pack.id,
      COMPLIANCE_PACK_RULE_IDS.packCreated,
      `admin authored compliance pack '${body.framework}' v${body.version} with ${body.controls.length} ` +
        `control mapping(s) — it is DRAFT and evaluates nothing until activated. A pack CONFIGURES and ` +
        `EVIDENCES; it does not certify compliance`,
      {
        framework: body.framework,
        version: body.version,
        controls: body.controls.length,
        attestationRequired: body.controls.filter((c) => c.attestationRequired).length,
      },
    );
    return reply.status(201).send({
      pack,
      controls: body.controls.length,
      updatePolicy: COMPLIANCE_PACK_UPDATE_POLICY,
      disclaimer: COMPLIANCE_PACK_DISCLAIMER,
    });
  });

  /** install the six launch packs as ORDINARY ROWS. Idempotent per
   * (framework, version) — a re-seed skips what already exists rather than
   * duplicating or overwriting an admin's edits. */
  app.post("/v1/compliance/packs/seed", async (req, reply) => {
    const existing = await db
      .select({ framework: compliancePacks.framework, version: compliancePacks.version })
      .from(compliancePacks);
    const have = new Set(existing.map((e) => `${e.framework}@${e.version}`));
    const created: Array<{ id: string; framework: string; version: number; controls: number }> = [];
    const skipped: string[] = [];
    for (const seed of DEFAULT_COMPLIANCE_PACKS) {
      const key = `${seed.framework}@${seed.version}`;
      if (have.has(key)) {
        skipped.push(key);
        continue;
      }
      const parsed = createCompliancePackSchema.parse(seed);
      const pack = await insertPack(db, parsed, req.authCtx.userId ?? null);
      created.push({
        id: pack.id,
        framework: pack.framework,
        version: pack.version,
        controls: parsed.controls.length,
      });
    }
    await audit(
      req.authCtx.userId ?? null,
      null,
      COMPLIANCE_PACK_RULE_IDS.packSeeded,
      `seeded ${created.length} launch compliance pack(s) as ROWS (${skipped.length} already present) — ` +
        `these are a well-informed STARTING POINT authored from public framework catalogues, not legal ` +
        `advice and not reviewed by counsel`,
      { created: created.length, skipped: skipped.length },
    );
    return reply.status(201).send({
      created,
      skipped,
      note:
        "Seeded packs are DRAFT. Activate the one you intend to report against. Every mapping is a " +
        "starting point subject to your own review — provenance.reviewedBy is null on all six.",
      disclaimer: COMPLIANCE_PACK_DISCLAIMER,
    });
  });

  app.get("/v1/compliance/packs", async (req) => {
    const q = z
      .object({ framework: z.string().max(64).optional(), status: z.enum(["draft", "active", "retired"]).optional() })
      .parse(req.query ?? {});
    const rows = await db
      .select()
      .from(compliancePacks)
      .where(
        and(
          ...(q.framework ? [eq(compliancePacks.framework, q.framework)] : []),
          ...(q.status ? [eq(compliancePacks.status, q.status)] : []),
        ),
      )
      .orderBy(compliancePacks.framework, desc(compliancePacks.version));
    const counts = await db
      .select({ packId: compliancePackControls.packId, n: count() })
      .from(compliancePackControls)
      .groupBy(compliancePackControls.packId);
    const byPack = new Map(counts.map((c) => [c.packId, c.n]));
    return {
      packs: rows.map((p) => ({ ...p, controlCount: byPack.get(p.id) ?? 0 })),
      updatePolicy: COMPLIANCE_PACK_UPDATE_POLICY,
      disclaimer: COMPLIANCE_PACK_DISCLAIMER,
    };
  });

  app.get("/v1/compliance/packs/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [pack] = await db.select().from(compliancePacks).where(eq(compliancePacks.id, id));
    if (!pack) return reply.status(404).send({ error: "unknown_compliance_pack" });
    const controls = await db
      .select()
      .from(compliancePackControls)
      .where(eq(compliancePackControls.packId, id))
      .orderBy(compliancePackControls.controlRef);
    const attestations = await db
      .select()
      .from(compliancePackAttestations)
      .where(eq(compliancePackAttestations.packId, id))
      .orderBy(desc(compliancePackAttestations.attestedAt));
    return { pack, controls, attestations, disclaimer: COMPLIANCE_PACK_DISCLAIMER };
  });

  // --- ADR-0087: the version diff + impact preview -------------------------

  /**
   * WHAT A FRAMEWORK REVISION CHANGES, REVIEWABLE BEFORE IT ACTIVATES.
   *
   * Two halves, deliberately distinct in kind:
   *  - `diff` — the STRUCTURED DIFF of the two versions as authored
   *    (shared `diffCompliancePacks`). Declared coverage classes are the
   *    mapping author's CLAIMS, so this half diffs claims against claims.
   *  - `impact` — the MEASURED half: both versions run through the SAME
   *    evaluation machinery (`evaluatePack`, which is `runCollector` over the
   *    real ledgers) against THIS deployment's CURRENT ledgers, and every
   *    control whose computed status would move is reported ("CC6.6
   *    satisfied→unsatisfied under v2's higher threshold"). If the two
   *    versions evaluate identically, the response SAYS so rather than
   *    implying change.
   *
   * READ-ONLY BY DESIGN: nothing activates, no report row is stored, no pack
   * state moves. The ONE write is an append-only audit row
   * (`compliance-pack-diff-computed`) — that row is what lets the activation
   * audit later record honestly whether a diff was computed for its from→to
   * pair, and an unrecorded read could not do that. Viewing the diff is NOT
   * a precondition for activation — that would be ceremony, not control.
   *
   * Admin-only via the default gate. The impact preview is therefore always
   * the org-wide (admin) view of the ledgers; it reflects the ledgers AT
   * REQUEST TIME and predicts nothing about future evidence.
   */
  app.get("/v1/compliance-packs/:framework/diff", async (req, reply) => {
    const { framework } = z.object({ framework: z.string().min(1).max(64) }).parse(req.params);
    const q = z
      .object({
        from: z.coerce.number().int().min(1).max(10_000),
        to: z.coerce.number().int().min(1).max(10_000),
        period: z
          .enum(["current_month", "last_month", "current_quarter", "last_quarter", "last_30_days"])
          .default("current_quarter"),
      })
      .parse(req.query ?? {});

    const loadVersion = async (version: number) => {
      const [pack] = await db
        .select()
        .from(compliancePacks)
        .where(and(eq(compliancePacks.framework, framework), eq(compliancePacks.version, version)));
      if (!pack) return null;
      const controls = await db
        .select()
        .from(compliancePackControls)
        .where(eq(compliancePackControls.packId, pack.id))
        .orderBy(compliancePackControls.controlRef);
      return { pack, controls };
    };

    const fromV = await loadVersion(q.from);
    if (!fromV) {
      return reply
        .status(404)
        .send({ error: "invalid_reference", detail: `no '${framework}' pack at version ${q.from}` });
    }
    const toV = await loadVersion(q.to);
    if (!toV) {
      return reply
        .status(404)
        .send({ error: "invalid_reference", detail: `no '${framework}' pack at version ${q.to}` });
    }

    const snapshot = (v: NonNullable<typeof fromV>): PackVersionSnapshot => ({
      title: v.pack.title,
      description: v.pack.description,
      provenance: v.pack.provenance,
      cascadeTag: v.pack.cascadeTag,
      controls: v.controls.map((c) => ({
        controlRef: c.controlRef,
        title: c.title,
        description: c.description,
        coverage: c.coverage,
        collector: c.collector,
        collectorParams: c.collectorParams,
        minEvidenceCount: c.minEvidenceCount,
        attestationRequired: c.attestationRequired,
        ownerNote: c.ownerNote,
      })),
    });

    const diff = diffCompliancePacks(snapshot(fromV), snapshot(toV));

    // THE IMPACT PREVIEW — both versions through the SAME machinery, against
    // the CURRENT ledgers. Reused, never reimplemented: two `evaluatePack`
    // calls are the whole computation.
    const now = new Date();
    const resolved = resolveReportPeriod(q.period, now);
    const evaluate = (v: NonNullable<typeof fromV>) =>
      evaluatePack(db, {
        pack: v.pack,
        controls: v.controls,
        projectIds: null, // admin-only route: the org-wide view
        periodStart: resolved.start,
        periodEnd: resolved.end,
        period: q.period,
        periodLabel: resolved.label,
        scopeKind: "org",
        scopeId: null,
        now,
      });
    const fromCard = await evaluate(fromV);
    const toCard = await evaluate(toV);

    const fromByRef = new Map(fromCard.controls.map((c) => [c.controlRef, c]));
    const toByRef = new Map(toCard.controls.map((c) => [c.controlRef, c]));
    const changedRefs = new Set(diff.controlsChanged.map((c) => c.controlRef));
    const addedRefs = new Set(diff.controlsAdded.map((c) => c.controlRef));
    const removedRefs = new Set(diff.controlsRemoved.map((c) => c.controlRef));
    const refs = [...new Set([...fromByRef.keys(), ...toByRef.keys()])].sort();

    const controls = refs.map((ref) => {
      const f = fromByRef.get(ref) ?? null;
      const t = toByRef.get(ref) ?? null;
      const definitionChange = addedRefs.has(ref)
        ? ("added" as const)
        : removedRefs.has(ref)
          ? ("removed" as const)
          : changedRefs.has(ref)
            ? ("changed" as const)
            : ("unchanged" as const);
      const moved = (f?.status ?? null) !== (t?.status ?? null);
      return {
        controlRef: ref,
        title: t?.title ?? f?.title ?? ref,
        definitionChange,
        fromStatus: f?.status ?? null,
        toStatus: t?.status ?? null,
        fromEvidenceCount: f?.evidenceCount ?? null,
        toEvidenceCount: t?.evidenceCount ?? null,
        moved,
        detail: moved
          ? t === null
            ? `'${ref}' (${f!.status} under v${q.from}) is REMOVED in v${q.to} — its coverage claim disappears from the scorecard`
            : f === null
              ? `'${ref}' is NEW in v${q.to} and computes ${t.status} against the current ledgers`
              : `'${ref}' ${f.status} under v${q.from} → ${t.status} under v${q.to} against the same current ledgers`
          : null,
      };
    });
    const moved = controls.filter((c) => c.moved);
    const evaluationIdentical = moved.length === 0;

    // The one write: an append-only audit row. It records that THIS from→to
    // diff was computed, which is what the activation audit later consults.
    await audit(
      req.authCtx.userId ?? null,
      toV.pack.id,
      COMPLIANCE_PACK_RULE_IDS.diffComputed,
      `pack diff computed for '${framework}' v${q.from} → v${q.to}: ${diff.summary.controlsAdded} ` +
        `control(s) added, ${diff.summary.controlsRemoved} removed, ${diff.summary.controlsChanged} ` +
        `changed${diff.summary.cascadeTagChanged ? ", CASCADE TAG CHANGED (high consequence)" : ""}; ` +
        `impact preview against the current ledgers: ${moved.length} computed status(es) would move. ` +
        `Read-only — nothing was activated`,
      {
        framework,
        fromVersion: q.from,
        toVersion: q.to,
        summary: diff.summary,
        statusesMoved: moved.length,
      },
    );

    return {
      framework,
      from: { id: fromV.pack.id, version: fromV.pack.version, title: fromV.pack.title, status: fromV.pack.status },
      to: { id: toV.pack.id, version: toV.pack.version, title: toV.pack.title, status: toV.pack.status },
      diff,
      impact: {
        period: { period: q.period, label: resolved.label, start: resolved.start.toISOString(), end: resolved.end.toISOString() },
        scope: "org",
        fromTotals: fromCard.totals,
        toTotals: toCard.totals,
        controls,
        statusesMoved: moved.length,
        evaluationIdentical,
        note: evaluationIdentical
          ? `Both versions evaluate IDENTICALLY against this deployment's current ledgers for ` +
            `${resolved.label} — the revision changes no computed status today. That is a statement ` +
            `about the ledgers at request time, not a guarantee about any future period.`
          : `${moved.length} control status(es) would move under v${q.to}, computed by running both ` +
            `versions through the same evaluator against this deployment's CURRENT ledgers for ` +
            `${resolved.label}. This reflects the ledgers at request time, not the future. ` +
            `Attestations are recorded per pack version and do not carry over to a new version.`,
      },
      disclaimer: COMPLIANCE_PACK_DISCLAIMER,
    };
  });

  /** ACTIVATION IS THE VERSION SWITCH. Retiring the previous active version of
   * the same framework happens HERE, in the same request, because the partial
   * unique index would otherwise refuse the second active row — the database
   * enforces "one answer to which mapping evidenced this report". */
  app.post("/v1/compliance/packs/:id/activate", async (req, reply) => {
    // ADR-0052 §4: compliance packs are a TIER FEATURE, enforced where the
    // capability is ENABLED. ACTIVATION is the enabling act — it makes the
    // pack the mapping reports use AND seeds the §8.3 cascade profile.
    // Authoring stays open on purpose: POST /v1/compliance/packs and /seed
    // produce DRAFT rows that "evaluate nothing until activated" (their own
    // audit rows say so), and a pack already active keeps working (committed
    // footprint, §5) — as do retire/delete, which only ever narrow.
    const flagRefusal = await refuseIfFeatureNotLicensed(db, {
      actorUserId: req.authCtx.userId,
      feature: "compliance_packs",
      what: "activating a compliance pack",
    });
    if (flagRefusal) return reply.status(flagRefusal.status).send(flagRefusal.body);
    const { id } = idParam.parse(req.params);
    const [pack] = await db.select().from(compliancePacks).where(eq(compliancePacks.id, id));
    if (!pack) return reply.status(404).send({ error: "unknown_compliance_pack" });
    if (pack.status === "active") {
      // batch B1 — re-activation is IDEMPOTENT including its cascade half: the
      // profile is found-or-created here too, so re-running the gesture
      // repairs a missing profile and never duplicates or overwrites one.
      const cascadeProfile = await ensureCascadeProfile(db, pack, req.authCtx.userId ?? null);
      return { pack, retired: null, cascadeProfile, note: "already active" };
    }
    const now = new Date();
    const [previous] = await db
      .select()
      .from(compliancePacks)
      .where(and(eq(compliancePacks.framework, pack.framework), eq(compliancePacks.status, "active")));
    if (previous) {
      await db
        .update(compliancePacks)
        .set({ status: "retired", retiredAt: now })
        .where(eq(compliancePacks.id, previous.id));
      await audit(
        req.authCtx.userId ?? null,
        previous.id,
        COMPLIANCE_PACK_RULE_IDS.packRetired,
        `compliance pack '${previous.framework}' v${previous.version} retired by the activation of ` +
          `v${pack.version} — reports already generated KEEP the version that produced them, so a ` +
          `framework revision never rewrites an artifact an auditor was handed`,
        { framework: previous.framework, retiredVersion: previous.version, newVersion: pack.version },
      );
    }
    const [activated] = await db
      .update(compliancePacks)
      .set({ status: "active", activatedAt: now })
      .where(eq(compliancePacks.id, id))
      .returning();
    // ADR-0087, honest and NULLABLE: did anyone compute the v(previous)→v(new)
    // diff before this activation? Recorded as a fact on the audit row — never
    // as a gate. Requiring the diff to be VIEWED would be ceremony, not
    // control; recording whether it was computed keeps the review story
    // auditable without pretending a page-load is diligence. Null when there
    // was no previous active version, because then there was nothing to diff.
    let diffComputed: boolean | null = null;
    if (previous) {
      const [d] = await db
        .select({ n: count() })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.ruleId, COMPLIANCE_PACK_RULE_IDS.diffComputed),
            sql`${auditLog.detail} ->> 'framework' = ${pack.framework}`,
            sql`(${auditLog.detail} ->> 'fromVersion')::int = ${previous.version}`,
            sql`(${auditLog.detail} ->> 'toVersion')::int = ${pack.version}`,
          ),
        );
      diffComputed = (d?.n ?? 0) > 0;
    }
    // batch B1 — the §8.3 preset half. Runs AFTER the pack is active so the
    // ledger reads in cause→effect order, and its outcome rides both the
    // response and the activation audit row.
    const cascadeProfile = await ensureCascadeProfile(db, activated!, req.authCtx.userId ?? null);
    await audit(
      req.authCtx.userId ?? null,
      id,
      COMPLIANCE_PACK_RULE_IDS.packActivated,
      `compliance pack '${pack.framework}' v${pack.version} activated${previous ? `, superseding v${previous.version}` : ""} ` +
        `— activation makes it the mapping REPORTS use. Enforcement comes from the §8.3 cascade: ` +
        `${cascadeProfile.note}`,
      {
        framework: pack.framework,
        version: pack.version,
        supersededVersion: previous?.version ?? null,
        diffComputed,
        cascadeProfile: { action: cascadeProfile.action, tag: cascadeProfile.tag, profileId: cascadeProfile.profileId },
      },
    );
    return {
      pack: activated,
      retired: previous ? { id: previous.id, version: previous.version } : null,
      cascadeProfile,
    };
  });

  app.delete("/v1/compliance/packs/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [pack] = await db.select().from(compliancePacks).where(eq(compliancePacks.id, id));
    if (!pack) return reply.status(404).send({ error: "unknown_compliance_pack" });
    await db.delete(compliancePacks).where(eq(compliancePacks.id, id));
    // batch B1 — deleting a pack NEVER deletes the compliance profile its tag
    // seeded. The profile is live enforcement over every project carrying the
    // tag; removing enforcement as a side effect of withdrawing a REPORTING
    // artifact is the silent-revocation class this project refuses. The
    // response says so instead of leaving the admin to wonder.
    const profileNote = pack.cascadeTag
      ? ` The compliance profile for '${pack.cascadeTag}' (if one exists) is deliberately KEPT — it is ` +
        `live enforcement, and withdrawing a mapping must not silently relax floors. Delete the profile ` +
        `deliberately if that is what you intend.`
      : "";
    await audit(
      req.authCtx.userId ?? null,
      id,
      COMPLIANCE_PACK_RULE_IDS.packDeleted,
      `admin deleted compliance pack '${pack.framework}' v${pack.version} — its controls and ` +
        `attestations cascade with it; already-generated pack REPORTS survive, because an artifact an ` +
        `auditor holds must not vanish when the mapping is withdrawn.${profileNote}`,
      { framework: pack.framework, version: pack.version, cascadeTag: pack.cascadeTag },
      "deny",
    );
    return {
      deleted: true,
      note:
        `Already-generated reports survive; controls and attestations cascade with the pack.${profileNote}`,
    };
  });

  /** the ONLY human-recordable input — and it is `attested`, never `satisfied` */
  app.post("/v1/compliance/packs/:id/attestations", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = packAttestationSchema.parse(req.body);
    const [pack] = await db.select().from(compliancePacks).where(eq(compliancePacks.id, id));
    if (!pack) return reply.status(404).send({ error: "unknown_compliance_pack" });
    const [control] = await db
      .select()
      .from(compliancePackControls)
      .where(
        and(eq(compliancePackControls.packId, id), eq(compliancePackControls.controlRef, body.controlRef)),
      );
    if (!control) return reply.status(404).send({ error: "unknown_pack_control" });
    if (!control.attestationRequired) {
      // REFUSED, and audited. An attestation on an auto-evidenced control would
      // be exactly the tick-box this feature refuses to have.
      await audit(
        req.authCtx.userId ?? null,
        id,
        COMPLIANCE_PACK_RULE_IDS.attestationRecorded,
        `refused an attestation on '${body.controlRef}': that control is AUTO-EVIDENCED from the ` +
          `'${control.collector}' collector. Attesting to it would let a human statement stand in for ` +
          `ledger evidence, which is the tick-box this feature exists to not have`,
        { controlRef: body.controlRef, collector: control.collector },
        "deny",
      );
      return reply.status(409).send({
        error: "control_is_auto_evidenced",
        detail:
          `control '${body.controlRef}' is evidenced by the '${control.collector}' collector. Its ` +
          `status is computed from the ledger and cannot be attested.`,
      });
    }
    const [row] = await db
      .insert(compliancePackAttestations)
      .values({
        packId: id,
        controlRef: body.controlRef,
        statement: body.statement,
        evidenceRef: body.evidenceRef ?? null,
        validUntil: body.validUntil ? new Date(body.validUntil) : null,
        attestedByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    await audit(
      req.authCtx.userId ?? null,
      id,
      COMPLIANCE_PACK_RULE_IDS.attestationRecorded,
      `attestation recorded for '${body.controlRef}' on pack '${pack.framework}' v${pack.version} — this ` +
        `is the CUSTOMER'S OWN statement about an organisational control, attributed to a named human. ` +
        `It is reported as 'attested', which is a distinct status from 'satisfied': RegulAIt collected ` +
        `no evidence for it and does not claim to have`,
      {
        controlRef: body.controlRef,
        validUntil: body.validUntil ?? null,
        framework: pack.framework,
        version: pack.version,
      },
    );
    return reply.status(201).send({
      attestation: row,
      note:
        "Recorded as an ATTESTATION, not as evidence. The scorecard will report this control as " +
        "'attested' — never as 'satisfied'.",
    });
  });

  // --- evaluation (NON-ADMIN reachable, entitlement-scoped) ----------------

  /**
   * THE SELLABLE ARTIFACT — and the guardrail against overclaim.
   *
   * Entitlement is ADR-0047's own decision function, unchanged: one rule, one
   * set of refusals. The decision yields the exact project-id list, and every
   * scoped collector builds its WHERE from that list. A team lead's report
   * cannot contain another team's evidence because those rows are never
   * selected.
   */
  app.post("/v1/compliance/packs/:id/evaluate", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = evaluatePackSchema.parse(req.body ?? {});
    const [pack] = await db.select().from(compliancePacks).where(eq(compliancePacks.id, id));
    if (!pack) return reply.status(404).send({ error: "unknown_compliance_pack" });

    const scopeProjectIds = await resolveScopeProjectIds(db, {
      scopeKind: body.scopeKind,
      scopeId: body.scopeId ?? null,
    });
    const decision = evaluateReportAccess({
      isAdmin: req.authCtx.isAdmin,
      userId: req.authCtx.userId ?? null,
      definition: {
        kind: "compliance",
        scopeKind: body.scopeKind,
        scopeId: body.scopeId ?? null,
        entitlementScope: body.entitlementScope,
      },
      scopeProjectIds,
      callerProjectIds: await callerProjectIds(db, req.authCtx.userId ?? null),
      callerTeamIds: await callerTeamIds(db, req.authCtx.userId ?? null),
    });

    if (!decision.allowed) {
      await audit(
        req.authCtx.userId ?? null,
        id,
        COMPLIANCE_PACK_RULE_IDS.evaluationDenied,
        `refused a compliance-pack evaluation: ${decision.reason}`,
        {
          framework: pack.framework,
          version: pack.version,
          scopeKind: body.scopeKind,
          entitlementScope: body.entitlementScope,
          accessRuleId: decision.ruleId,
        },
        "deny",
      );
      return reply.status(403).send({ error: "pack_scope_not_entitled", detail: decision.reason });
    }

    const now = new Date();
    const resolved = resolveReportPeriod(body.period, now);
    const controls = await db
      .select()
      .from(compliancePackControls)
      .where(eq(compliancePackControls.packId, id))
      .orderBy(compliancePackControls.controlRef);
    const scorecard = await evaluatePack(db, {
      pack,
      controls,
      projectIds: decision.projectIds,
      periodStart: resolved.start,
      periodEnd: resolved.end,
      period: body.period,
      periodLabel: resolved.label,
      scopeKind: body.scopeKind,
      scopeId: body.scopeId ?? null,
      now,
    });

    const [report] = await db
      .insert(compliancePackReports)
      .values({
        packId: pack.id,
        framework: pack.framework,
        packVersion: pack.version,
        requestedByUserId: req.authCtx.userId ?? null,
        scopeKind: body.scopeKind,
        scopeId: body.scopeId ?? null,
        entitlementScope: body.entitlementScope,
        effectiveProjectIds: decision.projectIds,
        periodStart: resolved.start,
        periodEnd: resolved.end,
        payload: scorecard as unknown as Record<string, unknown>,
      })
      .returning();

    await audit(
      req.authCtx.userId ?? null,
      report!.id,
      COMPLIANCE_PACK_RULE_IDS.evaluated,
      `compliance pack '${pack.framework}' v${pack.version} evaluated for ${resolved.label} over ` +
        (decision.projectIds === null
          ? "the whole organization (admin, org-scoped request)"
          : `${decision.projectIds.length} entitled project(s)`) +
        ` — ${scorecard.totals.satisfied}/${scorecard.totals.controls} controls evidenced, ` +
        `${scorecard.totals.attestationRequired} attestation(s) outstanding. This is a CONTROL-MAPPING ` +
        `report, not a certification`,
      {
        framework: pack.framework,
        packVersion: pack.version,
        effectiveProjectIds: decision.projectIds,
        totals: scorecard.totals,
      },
    );

    return reply.status(201).send({
      report: { ...report, payload: undefined },
      scorecard,
      scope: {
        entitlementScope: body.entitlementScope,
        effectiveProjectIds: decision.projectIds,
        reason: decision.reason,
      },
    });
  });

  app.get("/v1/compliance/pack-reports", async (req) => {
    const q = z
      .object({
        packId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query ?? {});
    const rows = await db
      .select({
        id: compliancePackReports.id,
        packId: compliancePackReports.packId,
        framework: compliancePackReports.framework,
        packVersion: compliancePackReports.packVersion,
        requestedByUserId: compliancePackReports.requestedByUserId,
        scopeKind: compliancePackReports.scopeKind,
        entitlementScope: compliancePackReports.entitlementScope,
        effectiveProjectIds: compliancePackReports.effectiveProjectIds,
        periodStart: compliancePackReports.periodStart,
        periodEnd: compliancePackReports.periodEnd,
        generatedAt: compliancePackReports.generatedAt,
      })
      .from(compliancePackReports)
      .where(q.packId ? eq(compliancePackReports.packId, q.packId) : undefined)
      .orderBy(desc(compliancePackReports.generatedAt))
      .limit(q.limit);
    if (req.authCtx.isAdmin) return { reports: rows, disclaimer: COMPLIANCE_PACK_DISCLAIMER };
    // a non-admin sees only artifacts they could regenerate themselves — the
    // same rule ADR-0047 applies to report runs
    const mine = new Set(await callerProjectIds(db, req.authCtx.userId ?? null));
    return {
      reports: rows.filter(
        (r) =>
          r.entitlementScope !== "org" &&
          r.effectiveProjectIds !== null &&
          (r.effectiveProjectIds as string[]).every((p) => mine.has(p)),
      ),
      disclaimer: COMPLIANCE_PACK_DISCLAIMER,
    };
  });

  app.get("/v1/compliance/pack-reports/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(compliancePackReports).where(eq(compliancePackReports.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_pack_report" });
    if (!req.authCtx.isAdmin) {
      const mine = new Set(await callerProjectIds(db, req.authCtx.userId ?? null));
      const readable =
        row.entitlementScope !== "org" &&
        row.effectiveProjectIds !== null &&
        (row.effectiveProjectIds as string[]).every((p) => mine.has(p));
      if (!readable) {
        await audit(
          req.authCtx.userId ?? null,
          id,
          COMPLIANCE_PACK_RULE_IDS.reportReadDenied,
          "a caller without the artifact's entitlement scope tried to read a compliance-pack report",
          { entitlementScope: row.entitlementScope },
          "deny",
        );
        return reply.status(403).send({ error: "pack_scope_not_entitled" });
      }
    }
    return { report: row };
  });
}
