/**
 * ADR-0208 (G7, #453 c6509969403): compliance profiles are edited through REVIEWED VERSIONS and can be RETIRED.
 *
 * - `POST /v1/compliance/profiles/:id/versions` mints the next version as a DRAFT (config_versions) and puts it in
 *   the one approval queue (objectType `compliance_profile`) for a named reviewer. Nothing applies until the reviewer
 *   approves; the decision activates the draft inside the decide transaction, and running workflow instances get the
 *   additive changes only (ADR-0027's reapply rule). A change that loosens a floor needs the author's
 *   `settings_relax` step-up when it is proposed, bound to the loosened values; the approval applies exactly that
 *   change or nothing (a draft whose base version moved is recorded stale and never applied).
 * - `POST /v1/compliance/profiles/:id/retire` always needs a step-up (it removes floors) and is refused while any
 *   project, pending project, team or infrastructure resource carries the tag. A retired profile is read-only and
 *   takes no new carrier; its versions, history and audit-retention floor are kept.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  and,
  approvals,
  auditLog,
  complianceProfiles,
  configVersions,
  eq,
  inArray,
  sql,
  users,
  workflowTemplates,
  type Db,
} from "@regulait/db";
import {
  proposeComplianceProfileVersionSchema,
  retireComplianceProfileSchema,
  VERSIONED_RULE_FIELDS,
} from "@regulait/shared";
import { z } from "zod";
import { activateVersion, loadVersions } from "./config-versions.js";
import { ruleEditLoosening } from "./rule-loosening.js";
import { currentEffectiveBody, proposeRuleVersion } from "./rule-writes.js";
import { requireStepUp } from "./step-up.js";

/** `approvals.stage_id` of a version review: the prefix, then the draft's config_versions id */
export const COMPLIANCE_VERSION_PREFIX = "compliance-profile-version:";

const idParam = z.object({ id: z.string().uuid() });

/** who carries a tag today, by name; capped per kind so one response stays bounded */
export interface ProfileCarriers {
  projects: string[];
  pendingProjects: string[];
  teams: string[];
  resources: string[];
}
const CARRIER_NAMES_MAX = 200;

const emptyCarriers = (): ProfileCarriers => ({ projects: [], pendingProjects: [], teams: [], resources: [] });

/**
 * Every carrier of each tag in `tags`, in four grouped queries (never one per profile). A pending project is a project
 * whose proposed reclassification (awaiting review) includes the tag.
 */
export async function carriersForTags(db: Pick<Db, "execute">, tags: string[]): Promise<Map<string, ProfileCarriers>> {
  const out = new Map<string, ProfileCarriers>(tags.map((t) => [t, emptyCarriers()]));
  if (tags.length === 0) return out;
  const list = sql.join(
    tags.map((t) => sql`${t}`),
    sql`, `,
  );
  const grouped = (table: string, column: string) =>
    sql`SELECT tg.tag AS tag, (array_agg(x.name ORDER BY x.name))[1:${CARRIER_NAMES_MAX}] AS names
          FROM ${sql.raw(`"${table}"`)} x, jsonb_array_elements_text(COALESCE(x.${sql.raw(`"${column}"`)}, '[]'::jsonb)) AS tg(tag)
         WHERE jsonb_typeof(COALESCE(x.${sql.raw(`"${column}"`)}, '[]'::jsonb)) = 'array' AND tg.tag IN (${list})
         GROUP BY tg.tag`;
  const kinds: Array<[keyof ProfileCarriers, string, string]> = [
    ["projects", "projects", "classifications"],
    ["pendingProjects", "projects", "pending_classifications"],
    ["teams", "teams", "default_classifications"],
    ["resources", "infra_resources", "classifications"],
  ];
  const results = await Promise.all(kinds.map(([, table, column]) => db.execute(grouped(table, column))));
  kinds.forEach(([kind], i) => {
    for (const row of results[i]!.rows as Array<{ tag: string; names: string[] | null }>) {
      out.get(row.tag)![kind] = row.names ?? [];
    }
  });
  return out;
}

const carrierCount = (c: ProfileCarriers) => c.projects.length + c.pendingProjects.length + c.teams.length + c.resources.length;

/**
 * The retired tags among `tags`. A writer that puts tags on a project, team or resource refuses these
 * (`compliance_profile_retired`): a retired profile takes no new carrier. (A carrier that slipped in anyway is still
 * governed by the retired profile's floors — `profilesForTags` resolves retired profiles too — so the race fails closed.)
 */
export async function retiredTagsAmong(db: Pick<Db, "select">, tags: readonly string[]): Promise<string[]> {
  if (tags.length === 0) return [];
  const rows = await db
    .select({ tag: complianceProfiles.tag })
    .from(complianceProfiles)
    .where(and(inArray(complianceProfiles.tag, [...tags]), eq(complianceProfiles.status, "retired")));
  return rows.map((r) => r.tag).sort();
}

/** the refusal body for a write that names a retired tag */
export const retiredTagRefusal = (tags: string[]) => ({
  error: "compliance_profile_retired",
  detail: `compliance profile(s) ${tags.map((t) => `'${t}'`).join(", ")} are retired and take no new project, team or resource`,
  tags,
});

/** active version number of each profile (1 when it has never been versioned), and its pending review if any */
export async function profileVersionFacts(
  db: Pick<Db, "select">,
  profileIds: string[],
): Promise<Map<string, { version: number; pendingReview: { approvalId: string; version: number; reviewerUserId: string } | null }>> {
  const out = new Map(profileIds.map((id) => [id, { version: 1, pendingReview: null as null | { approvalId: string; version: number; reviewerUserId: string } }]));
  if (profileIds.length === 0) return out;
  const versions = await db
    .select({ id: configVersions.id, artifactId: configVersions.artifactId, version: configVersions.version, status: configVersions.status })
    .from(configVersions)
    .where(and(eq(configVersions.artifactType, "compliance_profile"), inArray(configVersions.artifactId, profileIds)));
  const drafts = new Map<string, { artifactId: string; version: number }>();
  for (const v of versions) {
    if (v.status === "active") out.get(v.artifactId)!.version = v.version;
    if (v.status === "draft") drafts.set(`${COMPLIANCE_VERSION_PREFIX}${v.id}`, { artifactId: v.artifactId, version: v.version });
  }
  if (drafts.size > 0) {
    const pending = await db
      .select({ id: approvals.id, stageId: approvals.stageId, approverUserId: approvals.approverUserId })
      .from(approvals)
      .where(
        and(
          eq(approvals.objectType, "compliance_profile"),
          eq(approvals.status, "pending"),
          inArray(approvals.stageId, [...drafts.keys()]),
        ),
      );
    for (const p of pending) {
      const d = drafts.get(p.stageId ?? "");
      if (d) out.get(d.artifactId)!.pendingReview = { approvalId: p.id, version: d.version, reviewerUserId: p.approverUserId };
    }
  }
  return out;
}

const VERSIONED = (): readonly string[] => VERSIONED_RULE_FIELDS["compliance_profile"] ?? [];

/** the versioned fields only, in a stable order */
const versionedBody = (b: Record<string, unknown>) => Object.fromEntries(VERSIONED().map((f) => [f, b[f] ?? null]));

/** the fields a proposal changes, with before and after */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const f of VERSIONED()) {
    if (JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null)) out.push({ field: f, from: before[f] ?? null, to: after[f] ?? null });
  }
  return out;
}

const actorOf = (req: FastifyRequest) => req.authCtx.userId ?? null;

export function registerComplianceProfileLifecycleRoutes(app: FastifyInstance, db: Db): void {
  // ---- propose the next version (reviewed) -------------------------------------------------------------------
  app.post("/v1/compliance/profiles/:id/versions", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = proposeComplianceProfileVersionSchema.parse(req.body);
    const actor = actorOf(req);
    const [profile] = await db.select().from(complianceProfiles).where(eq(complianceProfiles.id, id));
    if (!profile) return reply.status(404).send({ error: "unknown_compliance_profile" });
    if (profile.status === "retired") {
      return reply.status(409).send({ error: "compliance_profile_retired", detail: `profile '${profile.tag}' is retired and read-only` });
    }
    if (actor !== null && body.reviewerUserId === actor) {
      return reply.status(422).send({ error: "reviewer_is_author", detail: "a profile change is reviewed by someone other than its author" });
    }
    const [reviewer] = await db
      .select({ id: users.id, isAdmin: users.isAdmin, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, body.reviewerUserId));
    if (!reviewer || reviewer.disabledAt !== null || !reviewer.isAdmin) {
      return reply.status(422).send({ error: "reviewer_not_eligible", detail: "the reviewer must be an active administrator" });
    }
    if (body.requiredTemplateIds?.length) {
      const known = await db
        .select({ id: workflowTemplates.id })
        .from(workflowTemplates)
        .where(inArray(workflowTemplates.id, body.requiredTemplateIds));
      if (known.length !== new Set(body.requiredTemplateIds).size) return reply.status(422).send({ error: "unknown_template" });
    }
    const facts = await profileVersionFacts(db, [id]);
    const pending = facts.get(id)!.pendingReview;
    if (pending) {
      return reply.status(409).send({
        error: "compliance_profile_version_pending",
        detail: `version ${pending.version} of '${profile.tag}' is waiting for review; decide it before proposing another`,
        approvalId: pending.approvalId,
      });
    }

    const current = await currentEffectiveBody(db, "compliance_profile", id);
    if (!current) return reply.status(404).send({ error: "unknown_compliance_profile" });
    const before = versionedBody(current);
    // an omitted field keeps its current value; an explicit null removes it
    const after = { ...before };
    for (const f of VERSIONED()) {
      if (Object.prototype.hasOwnProperty.call(body, f)) after[f] = (body as Record<string, unknown>)[f] ?? null;
    }
    const changes = changedFields(before, after);
    if (changes.length === 0) return reply.status(422).send({ error: "no_change", detail: "the proposed version equals the current one" });

    // a loosening needs the author's step-up NOW, bound to the profile and the loosened values (ADR-0186 decision 29)
    const loosened = await ruleEditLoosening(db, "compliance_profile", { ...current, ...before }, { ...current, ...after });
    if (loosened) {
      const ok = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { ruleId: id, values: loosened } });
      if (!ok.ok) return reply;
    }
    const carriers = (await carriersForTags(db, [profile.tag])).get(profile.tag)!;

    const out = await db.transaction(async (tx) => {
      const minted = await proposeRuleVersion(tx, {
        artifactType: "compliance_profile",
        artifactId: id,
        body: after,
        label: `compliance profile '${profile.tag}' change proposed for review`,
        authorUserId: actor,
        reason: body.reason,
      });
      const [approval] = await tx
        .insert(approvals)
        .values({
          userId: actor ?? body.reviewerUserId,
          objectType: "compliance_profile",
          stageId: `${COMPLIANCE_VERSION_PREFIX}${minted.version.id}`,
          approverUserId: body.reviewerUserId,
        })
        .returning({ id: approvals.id });
      await tx.insert(auditLog).values({
        userId: actor ?? body.reviewerUserId,
        objectType: "compliance_profile",
        objectId: id,
        detail: {
          phase: "version-proposed",
          tag: profile.tag,
          version: minted.version.version,
          parentVersion: minted.version.parentVersion,
          approvalId: approval!.id,
          reviewerUserId: body.reviewerUserId,
          changes,
          loosens: loosened ? Object.keys(loosened) : [],
          reach: {
            projects: carriers.projects.length,
            pendingProjects: carriers.pendingProjects.length,
            teams: carriers.teams.length,
            resources: carriers.resources.length,
          },
        },
        effect: "require_approval",
        ruleId: "compliance-profile-version-proposed",
        ruleChain: [],
        reason: body.reason,
      });
      return { approvalId: approval!.id, version: minted.version.version };
    });
    return reply.status(202).send({
      pending: true,
      approvalId: out.approvalId,
      version: out.version,
      changes,
      loosens: loosened ? Object.keys(loosened) : [],
      reach: carriers,
    });
  });

  // ---- retire ------------------------------------------------------------------------------------------------
  app.post("/v1/compliance/profiles/:id/retire", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = retireComplianceProfileSchema.parse(req.body);
    const actor = actorOf(req);
    const [profile] = await db.select().from(complianceProfiles).where(eq(complianceProfiles.id, id));
    if (!profile) return reply.status(404).send({ error: "unknown_compliance_profile" });
    if (profile.status === "retired") return reply.status(409).send({ error: "compliance_profile_already_retired" });
    // refusals that need no step-up come first, so a refused retire never spends a grant
    const carriers = (await carriersForTags(db, [profile.tag])).get(profile.tag)!;
    if (carrierCount(carriers) > 0) {
      return reply.status(409).send({
        error: "compliance_profile_in_use",
        detail: `'${profile.tag}' is still carried; reclassify these first, then retire it`,
        ...carriers,
      });
    }
    const pending = (await profileVersionFacts(db, [id])).get(id)!.pendingReview;
    if (pending) {
      return reply.status(409).send({
        error: "compliance_profile_version_pending",
        detail: `version ${pending.version} of '${profile.tag}' is waiting for review; decide it before retiring`,
        approvalId: pending.approvalId,
      });
    }
    const ok = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { ruleId: id, values: { status: "retired" } } });
    if (!ok.ok) return reply;

    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(complianceProfiles).where(eq(complianceProfiles.id, id)).for("update");
      if (!locked || locked.status === "retired") return { refusal: { status: 409, body: { error: "compliance_profile_already_retired" } } };
      // re-checked under the profile's row lock: a carrier added since the first look still refuses
      const again = (await carriersForTags(tx as unknown as Db, [locked.tag])).get(locked.tag)!;
      if (carrierCount(again) > 0) {
        return { refusal: { status: 409, body: { error: "compliance_profile_in_use", detail: `'${locked.tag}' is still carried`, ...again } } };
      }
      const [row] = await tx
        .update(complianceProfiles)
        .set({ status: "retired", retiredAt: sql`now()`, retiredReason: body.reason, retiredByUserId: actor })
        .where(eq(complianceProfiles.id, id))
        .returning();
      await tx.insert(auditLog).values({
        userId: actor ?? id,
        objectType: "compliance_profile",
        objectId: id,
        detail: { phase: "retired", tag: locked.tag, auditRetentionDaysKept: locked.auditRetentionDays },
        effect: "deny",
        ruleId: "compliance-profile-retired",
        ruleChain: [],
        reason: body.reason,
      });
      return { refusal: null, row: row! };
    });
    if (result.refusal) return reply.status(result.refusal.status).send(result.refusal.body);
    return reply.status(200).send({ ...result.row, carriers: emptyCarriers() });
  });
}

// ---- the one decide path's hooks (app.ts) -----------------------------------------------------------------------

/** separation of duties: the author of a profile change never approves it, through delegation or admin override */
export async function precheckComplianceProfileDecision(
  db: Pick<Db, "select">,
  approval: { stageId: string | null },
  deciderUserId: string,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const versionId = approval.stageId?.startsWith(COMPLIANCE_VERSION_PREFIX) ? approval.stageId.slice(COMPLIANCE_VERSION_PREFIX.length) : null;
  if (!versionId) return null;
  const [v] = await db.select({ authorUserId: configVersions.authorUserId }).from(configVersions).where(eq(configVersions.id, versionId));
  if (v?.authorUserId === deciderUserId) {
    return {
      status: 403,
      body: {
        error: "cannot_approve_own_compliance_profile_change",
        detail: "the decider proposed this profile change — approving one's own change is not a review; the named reviewer decides it",
      },
    };
  }
  return null;
}

/**
 * Runs inside the decision's transaction. Approved: the draft becomes the active version ONLY if the profile is still
 * active and the version it was proposed against is still the active one; anything else is recorded `stale` and nothing
 * changes. Running workflow instances of every project carrying the tag then get the additive changes only. Denied:
 * nothing changes. Every outcome is audited.
 */
export async function applyComplianceProfileDecision(
  tx: Db,
  approval: { id: string; stageId: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
  reapply: (db: Db, projectId: string, oldRequired: string[], deciderUserId: string) => Promise<unknown>,
  requiredFor: (db: Db, projectId: string) => Promise<string[]>,
): Promise<void> {
  const versionId = approval.stageId?.startsWith(COMPLIANCE_VERSION_PREFIX) ? approval.stageId.slice(COMPLIANCE_VERSION_PREFIX.length) : null;
  if (!versionId) return;
  const [draft] = await tx.select().from(configVersions).where(eq(configVersions.id, versionId));
  if (!draft) return;
  const [profile] = await tx.select().from(complianceProfiles).where(eq(complianceProfiles.id, draft.artifactId)).for("update");
  const audit = async (ruleId: string, effect: "allow" | "deny", reason: string, extra: Record<string, unknown> = {}) =>
    tx.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "compliance_profile",
      objectId: draft.artifactId,
      detail: { phase: "version-decision", decision, tag: profile?.tag ?? null, version: draft.version, approvalId: approval.id, ...extra },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  if (decision === "denied") {
    await audit("compliance-profile-version-rejected", "deny", `version ${draft.version} of '${profile?.tag ?? draft.artifactId}' rejected; the current version stays in force`);
    return;
  }
  const versions = await loadVersions(tx, "compliance_profile", draft.artifactId);
  const active = versions.find((v) => v.status === "active") ?? null;
  const stale =
    !profile ? "profile_missing"
    : profile.status === "retired" ? "profile_retired"
    : draft.status !== "draft" ? "version_not_draft"
    : (active?.version ?? null) !== draft.parentVersion ? "base_version_moved"
    : null;
  if (stale) {
    await audit(
      "compliance-profile-version-stale",
      "deny",
      `version ${draft.version} of '${profile?.tag ?? draft.artifactId}' approved but not applied (${stale}); propose it again against the current version`,
      { stale },
    );
    return;
  }
  // what each carrying project required before, so running instances get the additive changes only
  const carrierProjects = (
    await tx.execute(
      sql`SELECT id FROM projects WHERE jsonb_typeof(classifications) = 'array' AND classifications ? ${profile!.tag} ORDER BY id`,
    )
  ).rows as Array<{ id: string }>;
  const oldRequired = new Map<string, string[]>();
  for (const p of carrierProjects) oldRequired.set(p.id, await requiredFor(tx, p.id));
  // the author's step-up was spent when the change was proposed, bound to these exact values against this exact base
  // version (checked above), so the activation's loosening guard is satisfied by that grant
  await activateVersion(tx, {
    artifactType: "compliance_profile",
    artifactId: draft.artifactId,
    version: draft.version,
    actorUserId: deciderUserId,
    reason: `approved by the named reviewer (approval ${approval.id})`,
    stepUp: async () => {},
  });
  for (const p of carrierProjects) await reapply(tx, p.id, oldRequired.get(p.id) ?? [], deciderUserId);
  await audit(
    "compliance-profile-version-approved",
    "allow",
    `version ${draft.version} of '${profile!.tag}' approved and now in force for ${carrierProjects.length} project(s)`,
    { from: active?.version ?? null, projects: carrierProjects.length },
  );
}
