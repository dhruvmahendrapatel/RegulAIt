/**
 * ADR-0074 — THE ONE DOOR EVERY RULE-TABLE EDIT GOES THROUGH.
 *
 * ============================ WHY THIS FILE EXISTS ==========================
 *
 * ADR-0073 made the ACTIVE `config_versions` row the thing that ENFORCES. The
 * load-bearing line is `rule-versions.ts`:
 *
 *     const servedRow = res.served ? applyRuleBody(type, row, res.served.body) : row;
 *
 * From that moment the four rule tables (`approval_rules`, `rate_limits`,
 * `data_scope_rules`, `compliance_profiles`) stopped being the source of truth
 * for their own ENFORCING columns and became a READ-MODEL. ADR-0073 disclosed
 * the consequence as its gap 10 and left it open: any writer that mutates a
 * versioned column WITHOUT minting a version produces SILENT DIVERGENCE — the
 * admin sees the edit in the row and in every list view, and enforcement never
 * changes. In a governance product that is worse than a refusal, because the
 * operator has no way to tell the two apart.
 *
 * Three live writers had exactly that shape:
 *   - `PATCH /v1/rules/:kind/:ruleId/deploy-mode`   (org-settings.ts)
 *   - `POST  /v1/compliance/profiles`               (projects.ts — an UPSERT on
 *                                                    `tag`, i.e. the only EDIT
 *                                                    path a compliance profile
 *                                                    has)
 *   - `POST  /v1/onboarding/compliance-pack`        (onboarding.ts — the same
 *                                                    upsert, and it computes
 *                                                    `plan.profile: "update"`,
 *                                                    so it KNEW)
 *
 * The point of putting the fix HERE rather than in those three handlers is that
 * a point fix leaves the fourth writer free to reintroduce the class. There is
 * now ONE function that may edit a rule, it decides for itself whether the edit
 * is a policy change, and `rule-write-guard.test.ts` fails the build when a new
 * un-audited `.insert`/`.update` against those four tables appears anywhere in
 * the gateway.
 *
 * ============================== THE SEMANTICS ===============================
 *
 * Decomposed by FIELD CLASS, and minted from the ACTIVE BODY rather than from
 * the row. `planRuleEdit` (pure, in `@regulait/shared`) makes the call; this
 * file executes it. Four outcomes:
 *
 *   row          the patch touches no ENFORCING field, or the artifact has no
 *                versions at all → plain row UPDATE, mint nothing. The second
 *                half is invariant 4 — an unversioned rule stays byte-identical
 *                to pre-ADR-0073 — and it is why the three `POST /v1/rules/*`
 *                CREATE routes are correctly not a defect.
 *   no_change    versioned, but the composed body equals what is already
 *                enforced → mint nothing. The onboarding pack is designed to be
 *                re-run; without this, every re-apply would mint a version and
 *                fill the activation ledger with moves that changed nothing.
 *   mint         versioned, one active, the composed body differs → mint AND
 *                ACTIVATE, atomically, through `newVersion(..., activate:true)`.
 *   unresolvable versions exist and NONE is active → REFUSE, 409, naming the
 *                activate route as the remedy.
 *
 * MINTED FROM THE ACTIVE BODY, NOT THE ROW. The row may already have drifted —
 * every artifact versioned before this ADR and then touched by one of the three
 * writers above is drifted right now. Minting `ruleBodyFrom(row-after-update)`
 * would promote that drift into an enforcing version, i.e. the fix would ratify
 * the bug. `composeRuleBody` layers row → active body → patch instead, so the
 * drift is CORRECTED and the audit diff states the true before/after.
 *
 * ATOMICITY IS STRUCTURAL, NOT A MATCHED PAIR OF WRITES. On the `mint` branch
 * this function NEVER writes the enforcing columns itself. It calls
 * `newVersion(activate: true)` and lets `activateVersion`'s own
 * `writeRuleReadModel` — inside its transaction, as of this ADR — produce the
 * row write. "The row and the served body agree" is therefore a property of the
 * code path rather than of two writes staying in step.
 *
 * ============================ WHAT WAS REJECTED =============================
 *
 * REFUSING every CRUD write on a versioned artifact (409, "use the versioning
 * API") is honest but makes versioning a ONE-WAY TRAP: versioning a rule once
 * would permanently break the ordinary admin surface for it. It would 409 the
 * onboarding compliance pack for any org that had ever versioned that profile,
 * breaking the pillar-3 fast-start path. Kept only for the two cases where
 * there is genuinely no right answer: `unresolvable`, and a composed body that
 * fails `validateRuleVersionBody`.
 *
 * SUPERSEDING the active version so the row serves again does not do what it
 * claims. `resolveForShadow` short-circuits only on `versions.length === 0`;
 * after a supersede the artifact still HAS versions and now has NO active one,
 * which is the fail-closed branch — it converts an ordinary admin edit into a
 * fleet-wide DENY.
 *
 * DOES AUTO-ACTIVATION BYPASS A GATE? No, and that is answerable from code
 * rather than opinion. `evaluatePromotion` gates PROMOTING A CANARY — taking a
 * shadow-measured candidate and making it enforce. Direct activation has never
 * been gated: `POST /v1/config-versions/:type/:id/activate` has no eval gate,
 * and `newVersion(activate: true)` is the shipped pattern
 * (`POST /v1/agents/:id/system-prompt`). An admin who can call the deploy-mode
 * PATCH could already reach the identical end state in two ungated calls. So
 * this restores pre-versioning semantics — an entitled admin changes policy
 * immediately — and ADDS history where there was none.
 */
import { auditLog, eq, type ConfigArtifactType, type Db } from "@regulait/db";
import {
  effectiveRuleBody,
  planRuleEdit,
  validateRuleVersionBody,
  type RuleEditPlan,
} from "@regulait/shared";
import {
  loadRuleRow,
  loadVersions,
  lockRuleArtifact,
  newVersion,
  ruleTableFor,
  writeRuleReadModel,
  type DbOrTxDeep,
} from "./config-versions.js";
import { settingTransitions } from "./setting-transitions.js";
import { approvalRuleShape, assertApprovalRuleWritable } from "./approval-pool.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/** the audit_log object_type union, taken from the table rather than restated */
type AuditObjectType = NonNullable<(typeof auditLog.$inferInsert)["objectType"]> & string;

export interface RuleEditRefusal {
  ok: false;
  status: 404 | 409 | 422;
  error: string;
  detail: string;
}

export interface RuleEditSuccess<T> {
  ok: true;
  /** the artifact's row AFTER the edit — always re-read, never reconstructed */
  row: T;
  plan: RuleEditPlan;
  /** the version number this edit minted and activated, or null when the edit
   * was a plain row write or an effective no-op */
  mintedVersion: number | null;
  /** the sentence the API and the audit row both use, so a caller can never be
   * told something different from what was recorded */
  note: string;
}

export type RuleEditResult<T> = RuleEditSuccess<T> | RuleEditRefusal;

export function isRuleEditRefusal<T>(r: RuleEditResult<T>): r is RuleEditRefusal {
  return r.ok === false;
}

/**
 * What the artifact ENFORCES right now, totalised — the active version's body
 * layered over the row, or the row alone when nothing is versioned.
 *
 * Callers that want a before/after pair in their own audit row must read it
 * from HERE and not from the table row: the row is a read-model that may be
 * drifted, and an audit trail whose "before" is the drifted value records a
 * change that did not happen. Returns null when the artifact does not exist.
 */
export async function currentEffectiveBody(
  db: Db,
  artifactType: ConfigArtifactType,
  artifactId: string,
): Promise<Record<string, unknown> | null> {
  const row = await loadRuleRow(db, artifactType, artifactId);
  if (!row) return null;
  const active = (await loadVersions(db, artifactType, artifactId)).find((v) => v.status === "active");
  return effectiveRuleBody(artifactType, row, active?.body ?? {});
}

/**
 * Edit ONE rule/compliance artifact. `patch` is the columns the caller wants
 * written, exactly as it would have passed them to `db.update(...).set(...)`.
 *
 * Callers pass ONLY the columns they actually mean to write. That distinction
 * is load-bearing for the two compliance-profile writers: `POST
 * /v1/compliance/profiles` sends all twelve versioned fields (including
 * explicit nulls), so it keeps its total-replace semantics; the onboarding pack
 * sends nine and the three `redteam*` fields are left alone — which is exactly
 * what those two routes did to the ROW before this ADR, now expressed as a
 * version.
 */
export async function applyRuleEdit<T = Record<string, unknown>>(
  // AER-035: `DbOrTxDeep` rather than `Db`, so a caller can run this inside its
  // own transaction. `tx.transaction()` opens a SAVEPOINT rather than a second
  // connection (see that type's own note), so the nesting stays ONE transaction.
  db: DbOrTxDeep,
  args: {
    artifactType: ConfigArtifactType;
    artifactId: string;
    patch: Record<string, unknown>;
    actorUserId: string | null;
    /** what to label the minted version with — name the route, so the lineage
     * says where a version came from */
    label: string;
    /** the operator-facing reason recorded on the activation ledger row */
    reason?: string | null;
    /** audit_log.objectType for the row this helper writes */
    auditObjectType: AuditObjectType;
    auditRuleId: string;
    /** route-specific fields merged into the audit row's `detail`. The choke
     * point owns the versioning half of the record (`decision`, `changed`,
     * `beforeBody`, `afterBody`, `mintedVersion`); a route that already wrote a
     * meaningful detail shape keeps it rather than having it replaced. */
    auditDetail?: Record<string, unknown>;
  },
): Promise<RuleEditResult<T>> {
  const table = ruleTableFor(args.artifactType);
  if (!table) {
    return {
      ok: false,
      status: 422,
      error: "not_a_rule_artifact",
      detail: `${args.artifactType} has no rule table, so there is no read-model to edit`,
    };
  }

  // ADR-0074 AMENDMENT (2026-08-09) — ONE TRANSACTION, TAKEN BEHIND THE
  // ARTIFACT'S OWN ROW LOCK.
  //
  // As accepted, this function read the row and the version set with no lock and
  // then wrote based on what it had read. That reintroduced the ADR's own defect
  // through a narrower window: an edit that observed `versions.length === 0` and
  // planned a plain row write (invariant 4) could be running concurrently with a
  // `newVersion` capturing the lazy v1 baseline from the same pre-edit row — and
  // whichever committed second silently discarded the other. Nothing about that
  // outcome is distinguishable, afterwards, from the bug this ADR exists to
  // remove.
  //
  // `lockRuleArtifact` is `SELECT … FOR UPDATE` on the rule's own row, in the
  // style of ADR-0064's scheduler claim. It is the rule ROW rather than the
  // version set because the decisive case is that the version set is EMPTY, and
  // `FOR UPDATE` over an empty result locks nothing at all.
  //
  // Everything from the lock to the audit row is now one transaction, so a
  // failure part-way leaves no half-applied edit either.
  return db.transaction(async (tx) => applyRuleEditLocked<T>(tx, table, args));
}

async function applyRuleEditLocked<T>(
  db: DbOrTxDeep,
  table: NonNullable<ReturnType<typeof ruleTableFor>>,
  args: {
    artifactType: ConfigArtifactType;
    artifactId: string;
    patch: Record<string, unknown>;
    actorUserId: string | null;
    label: string;
    reason?: string | null;
    auditObjectType: AuditObjectType;
    auditRuleId: string;
    auditDetail?: Record<string, unknown>;
  },
): Promise<RuleEditResult<T>> {
  // FIRST STATEMENT. Both reads below happen under it.
  await lockRuleArtifact(db, args.artifactType, args.artifactId);

  const row = await loadRuleRow(db, args.artifactType, args.artifactId);
  if (!row) {
    return {
      ok: false,
      status: 404,
      error: "unknown_rule",
      detail: `no ${args.artifactType} with id ${args.artifactId} exists`,
    };
  }

  const versions = await loadVersions(db, args.artifactType, args.artifactId);
  const plan = planRuleEdit({
    artifactType: args.artifactType,
    row,
    patch: args.patch,
    versions: versions.map((v) => ({ status: v.status, body: v.body })),
  });

  if (plan.unknownFields.length > 0) {
    // Unreachable from today's zod-typed routes, and refused rather than
    // dropped anyway: a silently-ignored column looks like a change that did
    // not happen, which is the whole failure mode this ADR removes.
    return {
      ok: false,
      status: 422,
      error: "unknown_rule_field",
      detail:
        `'${plan.unknownFields.join("', '")}' is not a column of ${args.artifactType}. Refused rather than ` +
        `ignored — a silently-dropped field looks like an edit that took effect and did not.`,
    };
  }

  if (plan.kind === "unresolvable") {
    return { ok: false, status: 409, error: "config_version_unresolvable", detail: plan.reason };
  }

  // ADR-0186 A — THE ONE GUARD on a plain row write of an approval rule (a minted
  // version is guarded where every version is: `newVersion` / `activateVersion`)
  if (args.artifactType === "approval_rule" && plan.kind === "row") {
    await assertApprovalRuleWritable(db, approvalRuleShape({ ...row, ...plan.rowPatch }));
  }

  if (plan.kind === "mint") {
    // A body that cannot legally BE a version cannot legally be an edit either.
    // Storing it would move a bad edit onto the SERVED path as an outage — the
    // exact reasoning `validateRuleVersionBody` already carries for the
    // authoring surface.
    const rejection = validateRuleVersionBody(args.artifactType, plan.body!);
    if (rejection) {
      return { ok: false, status: 422, error: rejection.error, detail: rejection.reason };
    }
  }

  let mintedVersion: number | null = null;

  if (plan.kind === "mint") {
    const res = await newVersion(db, {
      artifactType: args.artifactType,
      artifactId: args.artifactId,
      body: plan.body!,
      label: args.label,
      authorUserId: args.actorUserId,
      activate: true,
      reason: args.reason ?? plan.reason,
    });
    mintedVersion = res.version.version;
    // `activateVersion` wrote the enforcing columns as the read-model, inside
    // its transaction. Anything left in `rowPatch` is a SELECTION column, which
    // no version may carry, so it is written separately and only here.
    if (Object.keys(plan.rowPatch).length > 0) {
      await db
        .update(table)
        .set(plan.rowPatch as never)
        .where(eq(table.id, args.artifactId));
    }
  } else if (plan.kind === "no_change") {
    // No version to mint — but the ROW may still be drifted from what is
    // enforced (that is the pre-0074 damage). Re-assert the read-model from the
    // active body so the surfaces stop lying, and write any selection columns.
    await writeRuleReadModel(db, args.artifactType, args.artifactId, plan.before ?? {});
    if (Object.keys(plan.rowPatch).length > 0) {
      await db
        .update(table)
        .set(plan.rowPatch as never)
        .where(eq(table.id, args.artifactId));
    }
  } else {
    // `row`: no versions, or nothing enforcing touched. A plain write, exactly
    // as before ADR-0073.
    if (Object.keys(plan.rowPatch).length > 0) {
      await db
        .update(table)
        .set(plan.rowPatch as never)
        .where(eq(table.id, args.artifactId));
    }
  }

  const after = (await loadRuleRow(db, args.artifactType, args.artifactId)) as T;

  const note =
    plan.kind === "mint"
      ? `This edit changed an ENFORCING field of a VERSIONED ${args.artifactType}, so it was minted as ` +
        `version ${mintedVersion} and activated. Dispatch resolves the active version, so writing the row ` +
        `alone would have changed nothing about what is enforced.`
      : plan.kind === "no_change"
        ? `No version was minted: the composed body is identical to what version ` +
          `${versions.find((v) => v.status === "active")?.version ?? "?"} already enforces.`
        : versions.length === 0
          ? `No version was minted: this ${args.artifactType} has no stored versions, so its own row is what ` +
            `the kernel resolves.`
          : `No version was minted: this edit touches no enforcing field.`;

  await db.insert(auditLog).values({
    userId: args.actorUserId ?? NO_IDENTITY,
    objectType: args.auditObjectType,
    objectId: args.artifactId,
    detail: {
      ...(args.auditDetail ?? {}),
      artifactType: args.artifactType,
      decision: plan.kind,
      changed: plan.changed,
      beforeBody: plan.before,
      afterBody: plan.body,
      // ADR-0181: an UNVERSIONED rule is a plain row write with no before
      // body, so the written columns' old -> new rides here — every
      // relaxation is audited old -> new
      ...(plan.kind === "row" ? { transitions: settingTransitions(row as object, plan.rowPatch) } : {}),
      mintedVersion,
    },
    effect: "allow",
    ruleId: args.auditRuleId,
    ruleChain: [],
    reason: `${args.label}: ${plan.reason}`,
  });

  return { ok: true, row: after, plan, mintedVersion, note };
}
