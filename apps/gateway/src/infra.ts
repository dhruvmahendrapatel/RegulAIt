/**
 * PILLAR 3 (§8.2): the governed infrastructure-operations layer. Monitored
 * resources + operational policies + detected findings + governed remediation.
 *
 * THE INVARIANT. A remediation is a GOVERNED ACTION; findings are inert reports.
 * A new finding is either
 *   (a) AUTO-remediated immediately — iff its resource's effective policy permits
 *       auto-remediation AND the finding severity <= the policy's ceiling AND the
 *       severity is not 'critical'. Still AUDITED (governed automation, never
 *       ungoverned), never approval-gated.
 *   (b) APPROVAL-GATED for everything else — an approvals row (objectType
 *       'infra_operation') → decide → provider.remediate on approve.
 * ALL 'critical' findings are ALWAYS approval-gated regardless of policy (the
 * ceiling enum cannot even hold 'critical', and the auto branch double-checks).
 * Default-deny holds: a finding never changes infra state until either the
 * policy explicitly permits auto-fix or a human approves.
 *
 * Execution runs strictly after the governance decision, exactly like the
 * connector execution layer — this file never patches real infra; the keyless
 * MockInfraProvider makes the whole layer demoable and testable.
 */

import type { FastifyInstance } from "fastify";
import {
  and,
  approvals,
  auditLog,
  desc,
  eq,
  infraFindings,
  infraPolicies,
  infraResources,
  users,
  sql,
  type Db,
} from "@regulait/db";
import {
  createInfraPolicySchema,
  createInfraResourceSchema,
  proposeInfraRemediationSchema,
  scanInfraSchema,
} from "@regulait/shared";
import {
  resolveInfraProvider,
  severityRank,
  InfraProviderError,
  type InfraProviderConfig,
  type InfraFindingReport,
  type InfraSeverity,
} from "@regulait/infra-provider";
import { z } from "zod";
import { complianceProfilesForTags, effectiveCompliancePolicy } from "./projects.js";

type InfraResourceRow = typeof infraResources.$inferSelect;
type InfraPolicyRow = typeof infraPolicies.$inferSelect;
type InfraFindingRow = typeof infraFindings.$inferSelect;

/** §-sentinel: the remediation approval carries the finding id in stageId, so
 * infra remediations ride the one approvals queue with no schema change (same
 * trick projects.ts uses for context conflicts). */
const INFRA_REMEDIATION_PREFIX = "__infra_remediation__:";

const findingIdParam = z.object({ findingId: z.string().uuid() });

function maxNullable(...vals: Array<number | null | undefined>): number | null {
  const nums = vals.filter((v): v is number => typeof v === "number");
  return nums.length ? Math.max(...nums) : null;
}
function minNullable(...vals: Array<number | null | undefined>): number | null {
  const nums = vals.filter((v): v is number => typeof v === "number");
  return nums.length ? Math.min(...nums) : null;
}

function providerConfig(resource: InfraResourceRow): InfraProviderConfig {
  return { kind: resource.provider as InfraProviderConfig["kind"] };
}

/** The base policy for a resource: its own resource-scoped policy if any, else
 * the fleet-wide (null resourceId) default. */
function basePolicy(resource: InfraResourceRow, policies: InfraPolicyRow[]): InfraPolicyRow | null {
  return (
    policies.find((p) => p.resourceId === resource.id) ??
    policies.find((p) => p.resourceId == null) ??
    null
  );
}

/** §8.3 CASCADE CONSUMPTION: a classified resource's effective infra policy
 * DERIVES floors from the compliance cascade. This is what finally consumes the
 * formerly-dead auditRetentionDays — it feeds the backup-retention floor. */
async function effectiveInfraPolicy(db: Db, resource: InfraResourceRow, policies: InfraPolicyRow[]) {
  const base = basePolicy(resource, policies);
  const tags = (resource.classifications ?? []) as string[];
  const cascade = effectiveCompliancePolicy(await complianceProfilesForTags(db, tags));
  return {
    policyId: base?.id ?? null,
    autoRemediateMaxSeverity: base?.autoRemediateMaxSeverity ?? null,
    // longest retention wins: the resource's own floor, the cascade's backup
    // floor, and the cascade's audit-retention floor
    backupRetentionDaysFloor: maxNullable(
      base?.backupRetentionDays,
      cascade.backupRetentionDays,
      cascade.auditRetentionDays,
    ),
    // strictest cadence wins (smallest number of days between patches)
    patchCadenceDaysCeiling: minNullable(base?.patchCadenceDays, cascade.patchCadenceDays),
    cascade: {
      backupRetentionDays: cascade.backupRetentionDays,
      patchCadenceDays: cascade.patchCadenceDays,
      auditRetentionDays: cascade.auditRetentionDays,
    },
  };
}

/** audit_log requires a non-null user; an admin-key call carries one, a
 * bootstrap-token call (the seeder) does not — fall back to a real admin. */
async function resolveActor(db: Db, userId: string | null): Promise<string> {
  if (userId) return userId;
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true)).limit(1);
  if (admin) return admin.id;
  const [any] = await db.select({ id: users.id }).from(users).limit(1);
  if (!any) throw new Error("no user to attribute the infra operation to");
  return any.id;
}

/** THE DECIDE HOOK (modeled on applyProjectApprovalDecision): approve →
 * provider.remediate + finding 'remediated' (audit allow); deny → finding
 * 'accepted_risk' (audit deny). Both outcomes audited — never a silent path. */
export async function applyInfraApprovalDecision(
  tx: Db,
  approvalRow: { stageId: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  if (!approvalRow.stageId?.startsWith(INFRA_REMEDIATION_PREFIX)) return;
  const findingId = approvalRow.stageId.slice(INFRA_REMEDIATION_PREFIX.length);
  const [finding] = await tx.select().from(infraFindings).where(eq(infraFindings.id, findingId));
  if (!finding) return;
  const [resource] = await tx
    .select()
    .from(infraResources)
    .where(eq(infraResources.id, finding.resourceId));
  const signature = String(finding.detail?.signature ?? "");
  if (decision === "approved") {
    if (resource) {
      const provider = resolveInfraProvider(providerConfig(resource));
      await provider.remediate({
        id: finding.id,
        resourceId: finding.resourceId,
        kind: finding.kind,
        signature,
        detail: finding.detail,
      });
    }
    await tx.update(infraFindings).set({ status: "remediated" }).where(eq(infraFindings.id, finding.id));
    await tx.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "infra_operation",
      objectId: finding.id,
      detail: { phase: "remediation-decision", decision, kind: finding.kind, severity: finding.severity, signature },
      effect: "allow",
      ruleId: "infra-remediated",
      ruleChain: [],
      reason: `governed remediation approved by the named approver; ${finding.kind}/${finding.severity} on ${resource?.name ?? finding.resourceId} remediated`,
    });
  } else {
    await tx.update(infraFindings).set({ status: "accepted_risk" }).where(eq(infraFindings.id, finding.id));
    await tx.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "infra_operation",
      objectId: finding.id,
      detail: { phase: "remediation-decision", decision, kind: finding.kind, severity: finding.severity, signature },
      effect: "deny",
      ruleId: "infra-remediation-denied",
      ruleChain: [],
      reason: `governed remediation denied; ${finding.kind}/${finding.severity} on ${resource?.name ?? finding.resourceId} logged as accepted risk`,
    });
  }
}

async function auditDetection(
  db: Db,
  actorId: string,
  resource: InfraResourceRow,
  report: InfraFindingReport,
  findingId: string,
): Promise<void> {
  await db.insert(auditLog).values({
    userId: actorId,
    objectType: "infra_operation",
    objectId: findingId,
    detail: {
      phase: "scan",
      resource: resource.name,
      kind: report.kind,
      severity: report.severity,
      signature: report.signature,
    },
    effect: "allow",
    ruleId: "infra-scan",
    ruleChain: [],
    reason: `scan detected ${report.kind}/${report.severity} on ${resource.name}`,
  });
}

/** Scan one resource: detect (idempotent by signature) then, for each NEW
 * finding, apply the auto-vs-gate decision. */
async function scanResource(
  db: Db,
  resource: InfraResourceRow,
  policies: InfraPolicyRow[],
  actorId: string,
): Promise<{ created: number; autoRemediated: number; refreshed: number }> {
  const provider = resolveInfraProvider(providerConfig(resource));
  const reports = await provider.scan({
    id: resource.id,
    kind: resource.kind,
    name: resource.name,
    config: resource.config,
  });
  const eff = await effectiveInfraPolicy(db, resource, policies);
  const ceiling = eff.autoRemediateMaxSeverity; // 'low' | 'medium' | 'high' | null
  let created = 0;
  let autoRemediated = 0;
  let refreshed = 0;
  for (const report of reports) {
    const [existing] = await db
      .select()
      .from(infraFindings)
      .where(
        and(
          eq(infraFindings.resourceId, resource.id),
          eq(infraFindings.kind, report.kind),
          sql`${infraFindings.detail}->>'signature' = ${report.signature}`,
        ),
      );
    if (existing) {
      // idempotent re-scan: refresh detected_at + the report payload; status is
      // NEVER reset (a remediated/approved finding stays that way) and no new
      // remediation is triggered.
      await db
        .update(infraFindings)
        .set({ detectedAt: new Date(), detail: report.detail, severity: report.severity })
        .where(eq(infraFindings.id, existing.id));
      await auditDetection(db, actorId, resource, report, existing.id);
      refreshed++;
      continue;
    }
    const [inserted] = await db
      .insert(infraFindings)
      .values({
        resourceId: resource.id,
        kind: report.kind,
        severity: report.severity,
        detail: report.detail,
        status: "open",
      })
      .returning();
    created++;
    await auditDetection(db, actorId, resource, report, inserted!.id);

    // THE AUTO-VS-GATE DECISION on a NEW finding. critical is never auto (the
    // ceiling enum can't hold it, and this double-guards anyway).
    const auto =
      ceiling != null &&
      report.severity !== "critical" &&
      severityRank(report.severity) <= severityRank(ceiling as InfraSeverity);
    if (auto) {
      await provider.remediate({
        id: inserted!.id,
        resourceId: resource.id,
        kind: report.kind,
        signature: report.signature,
        detail: report.detail,
      });
      await db
        .update(infraFindings)
        .set({ status: "auto_remediated" })
        .where(eq(infraFindings.id, inserted!.id));
      await db.insert(auditLog).values({
        userId: actorId,
        objectType: "infra_operation",
        objectId: inserted!.id,
        detail: {
          phase: "auto-remediate",
          resource: resource.name,
          kind: report.kind,
          severity: report.severity,
          signature: report.signature,
          ceiling,
        },
        effect: "allow",
        ruleId: "infra-auto-remediate",
        ruleChain: [],
        reason: `finding ${report.kind}/${report.severity} on ${resource.name} auto-remediated: severity <= policy ceiling '${ceiling}' and not critical (governed automation, audited)`,
      });
      autoRemediated++;
    }
  }
  return { created, autoRemediated, refreshed };
}

const SEVERITY_ORDER: InfraSeverity[] = ["low", "medium", "high", "critical"];

export function registerInfraRoutes(app: FastifyInstance, db: Db, _dataKey?: string) {
  // --- resources ---------------------------------------------------------
  app.get("/v1/infra/resources", async () => {
    const [resources, policies] = await Promise.all([
      db.select().from(infraResources).orderBy(desc(infraResources.createdAt)),
      db.select().from(infraPolicies),
    ]);
    const enriched = await Promise.all(
      resources.map(async (r) => ({ ...r, effectivePolicy: await effectiveInfraPolicy(db, r, policies) })),
    );
    return { resources: enriched };
  });

  app.post("/v1/infra/resources", async (req, reply) => {
    const body = createInfraResourceSchema.parse(req.body);
    const [row] = await db
      .insert(infraResources)
      .values({
        kind: body.kind,
        name: body.name,
        provider: body.provider,
        config: body.config ?? null,
        classifications: body.classifications ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  // --- policies ----------------------------------------------------------
  app.get("/v1/infra/policies", async () => ({
    policies: await db.select().from(infraPolicies).orderBy(desc(infraPolicies.createdAt)),
  }));

  app.post("/v1/infra/policies", async (req, reply) => {
    const body = createInfraPolicySchema.parse(req.body);
    if (body.resourceId) {
      const [res] = await db.select({ id: infraResources.id }).from(infraResources).where(eq(infraResources.id, body.resourceId));
      if (!res) return reply.status(422).send({ error: "unknown_resource" });
    }
    const [row] = await db
      .insert(infraPolicies)
      .values({
        resourceId: body.resourceId ?? null,
        patchCadenceDays: body.patchCadenceDays ?? null,
        certRotationDaysBeforeExpiry: body.certRotationDaysBeforeExpiry ?? null,
        backupSchedule: body.backupSchedule ?? null,
        backupRetentionDays: body.backupRetentionDays ?? null,
        driftBaseline: body.driftBaseline ?? null,
        autoRemediateMaxSeverity: body.autoRemediateMaxSeverity ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  // --- findings (posture inbox) -----------------------------------------
  app.get("/v1/infra/findings", async () => {
    const [findings, resources] = await Promise.all([
      db.select().from(infraFindings),
      db.select({ id: infraResources.id, name: infraResources.name, kind: infraResources.kind }).from(infraResources),
    ]);
    const nameOf = new Map(resources.map((r) => [r.id, r.name]));
    const kindOf = new Map(resources.map((r) => [r.id, r.kind]));
    // severity-sorted (worst first), then most-recent detection first
    const sorted = [...findings].sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) ||
        b.detectedAt.getTime() - a.detectedAt.getTime(),
    );
    return {
      findings: sorted.map((f) => ({
        ...f,
        resourceName: nameOf.get(f.resourceId) ?? null,
        resourceKind: kindOf.get(f.resourceId) ?? null,
      })),
    };
  });

  // --- posture summary ---------------------------------------------------
  app.get("/v1/infra/posture", async () => {
    const [findings, resources] = await Promise.all([
      db.select().from(infraFindings),
      db.select().from(infraResources),
    ]);
    const byKind: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const f of findings) {
      byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    }
    const openStatuses = new Set(["open", "remediation_proposed"]);
    const open = findings.filter((f) => openStatuses.has(f.status));
    const backupTargets = resources.filter((r) => r.kind === "backup_target").length;
    const backupsMissed = open.filter((f) => f.kind === "backup_missed").length;
    return {
      resources: resources.length,
      findings: findings.length,
      open: open.length,
      byKind,
      bySeverity,
      byStatus,
      backup: { targets: backupTargets, missed: backupsMissed },
    };
  });

  // --- scan --------------------------------------------------------------
  app.post("/v1/infra/scan", async (req, reply) => {
    const body = scanInfraSchema.parse(req.body ?? {});
    const actorId = await resolveActor(db, req.authCtx.userId);
    const policies = await db.select().from(infraPolicies);
    const resources = body.resourceId
      ? await db.select().from(infraResources).where(eq(infraResources.id, body.resourceId))
      : await db.select().from(infraResources);
    if (body.resourceId && resources.length === 0) {
      return reply.status(404).send({ error: "unknown_resource" });
    }
    let created = 0;
    let autoRemediated = 0;
    let refreshed = 0;
    const skipped: Array<{ resource: string; reason: string }> = [];
    for (const resource of resources) {
      try {
        const r = await scanResource(db, resource, policies, actorId);
        created += r.created;
        autoRemediated += r.autoRemediated;
        refreshed += r.refreshed;
      } catch (err) {
        // an un-built cloud provider (501) or a provider error must not fail the
        // whole fleet scan — record it and move on
        if (err instanceof InfraProviderError) {
          skipped.push({ resource: resource.name, reason: err.message });
        } else {
          throw err;
        }
      }
    }
    return reply.status(200).send({
      scanned: resources.length,
      created,
      autoRemediated,
      refreshed,
      ...(skipped.length ? { skipped } : {}),
    });
  });

  // --- propose a governed remediation for an OPEN finding ---------------
  app.post("/v1/infra/findings/:findingId/remediate", async (req, reply) => {
    const { findingId } = findingIdParam.parse(req.params);
    const body = proposeInfraRemediationSchema.parse(req.body);
    const [finding] = await db.select().from(infraFindings).where(eq(infraFindings.id, findingId));
    if (!finding) return reply.status(404).send({ error: "unknown_finding" });
    if (finding.status !== "open") {
      return reply.status(409).send({
        error: "not_open",
        detail: `finding is '${finding.status}', only an 'open' finding can be proposed for remediation`,
      });
    }
    const [approver] = await db.select({ id: users.id }).from(users).where(eq(users.id, body.approverUserId));
    if (!approver) return reply.status(422).send({ error: "unknown_approver" });
    const actorId = await resolveActor(db, req.authCtx.userId);
    const [resource] = await db.select().from(infraResources).where(eq(infraResources.id, finding.resourceId));

    const [approval] = await db
      .insert(approvals)
      .values({
        userId: actorId,
        objectType: "infra_operation",
        stageId: `${INFRA_REMEDIATION_PREFIX}${finding.id}`,
        approverUserId: body.approverUserId,
      })
      .returning({ id: approvals.id });
    await db
      .update(infraFindings)
      .set({ status: "remediation_proposed" })
      .where(eq(infraFindings.id, finding.id));
    await db.insert(auditLog).values({
      userId: actorId,
      objectType: "infra_operation",
      objectId: finding.id,
      detail: {
        phase: "remediation-proposed",
        kind: finding.kind,
        severity: finding.severity,
        resource: resource?.name ?? finding.resourceId,
        approverUserId: body.approverUserId,
      },
      effect: "require_approval",
      ruleId: "infra-remediation-proposed",
      ruleChain: [],
      reason: `governed remediation for ${finding.kind}/${finding.severity} on ${resource?.name ?? finding.resourceId} pends the named approver — infra state unchanged until approval`,
    });
    return reply.status(202).send({ pending: true, approvalId: approval!.id });
  });
}
