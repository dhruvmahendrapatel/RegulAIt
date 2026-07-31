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
  backupRuns,
  certInventory,
  certRotations,
  deployTargets,
  desc,
  eq,
  infraFindings,
  infraPolicies,
  infraResources,
  patchRecords,
  users,
  sql,
  type Db,
} from "@regulait/db";
import {
  applyPatchSchema,
  createInfraPolicySchema,
  createInfraResourceSchema,
  proposeInfraRemediationSchema,
  restoreBackupSchema,
  rotateCertSchema,
  scanInfraSchema,
} from "@regulait/shared";
import {
  infraLiveEnabled,
  resolveInfraProvider,
  severityRank,
  InfraProviderError,
  type InfraProviderConfig,
  type InfraFindingReport,
  type InfraSeverity,
} from "@regulait/infra-provider";
import { z } from "zod";
import { buildAwsInfraLiveClient } from "./infra-aws-client.js";
import { buildAzureInfraLiveClient } from "./infra-azure-client.js";
import { buildGcpInfraLiveClient } from "./infra-gcp-client.js";
import { complianceProfilesForTags, effectiveCompliancePolicy } from "./projects.js";

type InfraResourceRow = typeof infraResources.$inferSelect;
type InfraPolicyRow = typeof infraPolicies.$inferSelect;
type InfraFindingRow = typeof infraFindings.$inferSelect;

/** §-sentinel: the remediation approval carries the finding id in stageId, so
 * infra remediations ride the one approvals queue with no schema change (same
 * trick projects.ts uses for context conflicts). */
const INFRA_REMEDIATION_PREFIX = "__infra_remediation__:";

/** ADR-0017 action sentinel: the three operator verbs (cert_rotate | patch_apply
 * | backup_restore) ride the SAME one approvals queue as a plain remediation.
 * stageId carries `__infra_action__:<action>:<ledgerRowId>` — /decide dispatches
 * on it exactly like the remediation prefix, so no new decision path exists. */
const INFRA_ACTION_PREFIX = "__infra_action__:";
type InfraAction = "cert_rotate" | "patch_apply" | "backup_restore";

const findingIdParam = z.object({ findingId: z.string().uuid() });
const certIdParam = z.object({ certId: z.string().uuid() });
const patchIdParam = z.object({ patchId: z.string().uuid() });
const backupIdParam = z.object({ backupId: z.string().uuid() });

/** ADR-0017 — after a finding is upserted on scan, upsert its durable ledger
 * row and stamp the finding's ref_table/ref_id back-link. Idempotent by
 * construction (patch via UNIQUE(resource,cve); cert by (resource,commonName);
 * backup by (finding, missed)), so a re-scan never duplicates a ledger row.
 * drift has no ledger — its ref stays null. */
async function syncFindingLedger(
  db: Db,
  resource: InfraResourceRow,
  findingId: string,
  report: InfraFindingReport,
): Promise<void> {
  const d = report.detail ?? {};
  if (report.kind === "cve") {
    const cve = String(d.cve ?? report.signature.replace(/^cve:/, ""));
    const [row] = await db
      .insert(patchRecords)
      .values({
        resourceId: resource.id,
        findingId,
        cve,
        package: d.package != null ? String(d.package) : null,
        installedVersion: d.installedVersion != null ? String(d.installedVersion) : null,
        fixedVersion: d.fixedVersion != null ? String(d.fixedVersion) : null,
        cvss: d.cvss != null ? String(d.cvss) : null,
        severity: report.severity,
      })
      .onConflictDoUpdate({
        target: [patchRecords.resourceId, patchRecords.cve],
        set: {
          findingId,
          severity: report.severity,
          fixedVersion: d.fixedVersion != null ? String(d.fixedVersion) : null,
        },
      })
      .returning({ id: patchRecords.id });
    await db
      .update(infraFindings)
      .set({ refTable: "patch_records", refId: row!.id })
      .where(eq(infraFindings.id, findingId));
    return;
  }
  if (report.kind === "cert_expiring") {
    const commonName = String(d.commonName ?? resource.name);
    const notAfter = d.notAfter ? new Date(String(d.notAfter)) : new Date();
    const [existing] = await db
      .select()
      .from(certInventory)
      .where(and(eq(certInventory.resourceId, resource.id), eq(certInventory.commonName, commonName)));
    let certId: string;
    if (existing) {
      certId = existing.id;
      // never clobber a rotated cert's advanced not_after; only refresh an
      // active row's observed expiry.
      if (existing.status === "active") {
        await db
          .update(certInventory)
          .set({ notAfter, serial: d.serial != null ? String(d.serial) : existing.serial })
          .where(eq(certInventory.id, certId));
      }
    } else {
      const [row] = await db
        .insert(certInventory)
        .values({
          resourceId: resource.id,
          commonName,
          issuer: d.issuer != null ? String(d.issuer) : null,
          serial: d.serial != null ? String(d.serial) : null,
          notAfter,
          status: "active",
        })
        .returning({ id: certInventory.id });
      certId = row!.id;
    }
    await db
      .update(infraFindings)
      .set({ refTable: "cert_inventory", refId: certId })
      .where(eq(infraFindings.id, findingId));
    return;
  }
  if (report.kind === "backup_missed") {
    // one 'missed' run per finding — idempotent on re-scan.
    const [existing] = await db
      .select({ id: backupRuns.id })
      .from(backupRuns)
      .where(
        and(
          eq(backupRuns.findingId, findingId),
          eq(backupRuns.kind, "backup"),
          eq(backupRuns.status, "missed"),
        ),
      );
    let runId: string;
    if (existing) {
      runId = existing.id;
    } else {
      const [row] = await db
        .insert(backupRuns)
        .values({
          resourceId: resource.id,
          findingId,
          kind: "backup",
          status: "missed",
          retentionUntil: d.retentionUntil ? new Date(String(d.retentionUntil)) : null,
        })
        .returning({ id: backupRuns.id });
      runId = row!.id;
    }
    await db
      .update(infraFindings)
      .set({ refTable: "backup_runs", refId: runId })
      .where(eq(infraFindings.id, findingId));
    return;
  }
  // drift (and any future ledgerless kind): no back-link.
}

function maxNullable(...vals: Array<number | null | undefined>): number | null {
  const nums = vals.filter((v): v is number => typeof v === "number");
  return nums.length ? Math.max(...nums) : null;
}
function minNullable(...vals: Array<number | null | undefined>): number | null {
  const nums = vals.filter((v): v is number => typeof v === "number");
  return nums.length ? Math.min(...nums) : null;
}

/** first non-empty string wins (row config value, then env fallback) */
function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return null;
}

/**
 * Build the provider config for a monitored resource. Exported for tests.
 *
 * REGULAIT_INFRA_LIVE OFF (the default): returns the bare `{ kind }` —
 * byte-identical to the pre-live behavior; resolveInfraProvider's own 501 gate
 * stays the second lock and no AWS SDK code is ever touched.
 *
 * Flag ON for an aws/azure/gcp resource: threads the per-cloud config fields
 * the adapter reads and injects the real lazily-loading live client (see
 * ./infra-aws-client.ts / ./infra-azure-client.ts / ./infra-gcp-client.ts,
 * the factory contracts in @regulait/infra-provider aws.ts/azure.ts/gcp.ts —
 * the same injected-live-client discipline as deploy.ts's
 * REGULAIT_DEPLOY_LIVE/awsLiveClient). The factories are lazy, so injecting
 * one never loads an SDK module — that only happens on the first live call.
 *
 * Config-field source — the resource row's existing `config` jsonb, the same
 * provider-specific home each adapter already reads (baseline,
 * backupVaultName, resourceArn, iamRoleArn, vaultUrl, …), with env vars as
 * the fleet-wide fallback; a value on the resource row always overrides the
 * env (aws roleArn/region precedence, applied uniformly per cloud):
 *   aws   → `config.roleArn` / `config.region`
 *           (env REGULAIT_INFRA_ROLE_ARN / REGULAIT_INFRA_REGION)
 *   azure → `config.subscriptionId` / `config.resourceGroup`
 *           (env REGULAIT_INFRA_SUBSCRIPTION_ID / REGULAIT_INFRA_RESOURCE_GROUP)
 *   gcp   → `config.projectId` / `config.zone` / `config.location`
 *           (env REGULAIT_INFRA_PROJECT_ID / REGULAIT_INFRA_ZONE /
 *           REGULAIT_INFRA_LOCATION)
 * (An admin-UI field for setting these on a resource is deferred to the
 * UI-track agent — the API's free-form `config` object already accepts them
 * today via POST /v1/infra/resources.)
 */
export function providerConfig(
  resource: InfraResourceRow,
  env: NodeJS.ProcessEnv = process.env,
): InfraProviderConfig {
  const kind = resource.provider as InfraProviderConfig["kind"];
  if (!infraLiveEnabled(env)) return { kind };
  const cfg = resource.config ?? {};
  if (kind === "aws") {
    const roleArn = firstString(cfg.roleArn, env.REGULAIT_INFRA_ROLE_ARN);
    const region = firstString(cfg.region, env.REGULAIT_INFRA_REGION);
    return {
      kind,
      roleArn,
      region,
      awsLiveClient: buildAwsInfraLiveClient(region ?? undefined),
    };
  }
  if (kind === "azure") {
    return {
      kind,
      subscriptionId: firstString(cfg.subscriptionId, env.REGULAIT_INFRA_SUBSCRIPTION_ID),
      resourceGroup: firstString(cfg.resourceGroup, env.REGULAIT_INFRA_RESOURCE_GROUP),
      azureLiveClient: buildAzureInfraLiveClient(),
    };
  }
  if (kind === "gcp") {
    return {
      kind,
      projectId: firstString(cfg.projectId, env.REGULAIT_INFRA_PROJECT_ID),
      zone: firstString(cfg.zone, env.REGULAIT_INFRA_ZONE),
      location: firstString(cfg.location, env.REGULAIT_INFRA_LOCATION),
      gcpLiveClient: buildGcpInfraLiveClient(),
    };
  }
  // mock (and any future keyless kind): the bare { kind }, live flag or not.
  return { kind };
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
  approvalRow: { id?: string; stageId: string | null; decisionReason?: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  const stageId = approvalRow.stageId ?? "";
  // ADR-0017: the three operator verbs share this same hook via a distinct
  // sentinel — dispatched to applyInfraActionDecision, still one decision path.
  if (stageId.startsWith(INFRA_ACTION_PREFIX)) {
    await applyInfraActionDecision(tx, approvalRow, decision, deciderUserId);
    return;
  }
  if (!stageId.startsWith(INFRA_REMEDIATION_PREFIX)) return;
  const findingId = stageId.slice(INFRA_REMEDIATION_PREFIX.length);
  const [finding] = await tx.select().from(infraFindings).where(eq(infraFindings.id, findingId));
  if (!finding) return;
  const [resource] = await tx
    .select()
    .from(infraResources)
    .where(eq(infraResources.id, finding.resourceId));
  const signature = String(finding.detail?.signature ?? "");
  // A4: stamp the target-pinned resource's mode onto the decision audit rows
  const deployMode = await resourceDeployMode(tx, resource?.deployTargetId ?? null);
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
      deployMode, // A4
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
      deployMode, // A4
    });
  }
}

/** A4 (migration 0044): the deploy mode of the target a resource is pinned to
 * — stamped onto the audit rows of governed infra mutations so the mode
 * dimension (and per-mode retention) covers infra operations too. Null = the
 * resource is not target-pinned (not a deploy-scoped action). */
async function resourceDeployMode(
  tx: Db,
  deployTargetId: string | null,
): Promise<"hosted" | "byoc" | "air_gapped" | null> {
  if (!deployTargetId) return null;
  const [t] = await tx
    .select({ mode: deployTargets.mode })
    .from(deployTargets)
    .where(eq(deployTargets.id, deployTargetId));
  return t?.mode ?? null;
}

/** ADR-0015 boundary check: is this resource pinned to a customer-hosted,
 * air-gapped deploy target? If so, no execution-plane detail (provider result
 * strings/URLs) may be retained in the control plane — only metadata. */
async function isAirGapped(tx: Db, deployTargetId: string | null): Promise<boolean> {
  return (await resourceDeployMode(tx, deployTargetId)) === "air_gapped";
}

const ACTION_TO_KIND: Record<InfraAction, InfraFindingRow["kind"]> = {
  cert_rotate: "cert_expiring",
  patch_apply: "cve",
  backup_restore: "backup_missed",
};

/** ADR-0017 — apply an approved/denied operator VERB (cert_rotate | patch_apply
 * | backup_restore) inside the /decide txn. On approve: run the provider action
 * then write the ledger OUTCOME (cert_rotations row + advanced cert; patch
 * patched; backup restore row) and flip the linked finding to 'remediated'. On
 * deny: revert the proposed state and log accepted_risk. Both audited. In
 * air_gapped mode only metadata is retained — no provider detail crosses back. */
async function applyInfraActionDecision(
  tx: Db,
  approvalRow: { id?: string; stageId: string | null; decisionReason?: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  const rest = (approvalRow.stageId ?? "").slice(INFRA_ACTION_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) return;
  const action = rest.slice(0, sep) as InfraAction;
  const ledgerId = rest.slice(sep + 1);
  if (!ACTION_TO_KIND[action]) return;
  const now = new Date();

  // resolve the ledger row (for provider + boundary) and the linked finding.
  let certRow: typeof certInventory.$inferSelect | undefined;
  let patchRow: typeof patchRecords.$inferSelect | undefined;
  let backupRow: typeof backupRuns.$inferSelect | undefined;
  let resourceId: string | null = null;
  if (action === "cert_rotate") {
    [certRow] = await tx.select().from(certInventory).where(eq(certInventory.id, ledgerId));
    if (!certRow) return;
    resourceId = certRow.resourceId;
  } else if (action === "patch_apply") {
    [patchRow] = await tx.select().from(patchRecords).where(eq(patchRecords.id, ledgerId));
    if (!patchRow) return;
    resourceId = patchRow.resourceId;
  } else {
    [backupRow] = await tx.select().from(backupRuns).where(eq(backupRuns.id, ledgerId));
    if (!backupRow) return;
    resourceId = backupRow.resourceId;
  }
  const [resource] = await tx.select().from(infraResources).where(eq(infraResources.id, resourceId!));
  const refTable =
    action === "cert_rotate" ? "cert_inventory" : action === "patch_apply" ? "patch_records" : "backup_runs";
  const [finding] = await tx
    .select()
    .from(infraFindings)
    .where(and(eq(infraFindings.refTable, refTable), eq(infraFindings.refId, ledgerId)));
  // A4: one lookup serves both the boundary check and the audit-mode stamp
  const deployMode = await resourceDeployMode(tx, resource?.deployTargetId ?? null);
  const airGapped = deployMode === "air_gapped";
  const signature = String(finding?.detail?.signature ?? `${action}:${ledgerId}`);

  // O6 (ADR-0027): the newest PROPOSED rotation-attempt ledger row — created
  // by the rotate endpoint at propose time, advanced here to its terminal
  // state (rotated / denied / failed). Pre-O6 proposals have none; the
  // approve path falls back to inserting one so old in-flight approvals
  // still land a durable record.
  const [proposedRotation] =
    action === "cert_rotate"
      ? await tx
          .select()
          .from(certRotations)
          .where(and(eq(certRotations.certId, ledgerId), eq(certRotations.status, "proposed")))
          .orderBy(desc(certRotations.createdAt))
          .limit(1)
      : [];

  if (decision === "approved") {
    // O6 STATE-MACHINE GUARD: a rotation approval only acts on a cert that is
    // still rotation_proposed — anything else (already rotated, re-proposed
    // and denied elsewhere, expired) is a stale decision that must not mutate
    // the lifecycle. Audited, never silent.
    if (action === "cert_rotate" && certRow!.status !== "rotation_proposed") {
      await tx.insert(auditLog).values({
        userId: deciderUserId,
        objectType: "infra_operation",
        objectId: finding?.id ?? null,
        detail: { phase: "action-decision", action, decision, ledgerId, certStatus: certRow!.status },
        effect: "deny",
        ruleId: "infra-action-stale",
        ruleChain: [],
        reason: `stale cert_rotate approval ignored: cert is '${certRow!.status}', not rotation_proposed — lifecycle unchanged`,
        deployMode,
      });
      return;
    }
    let providerDetail: Record<string, unknown> = {};
    let providerError: string | null = null;
    if (resource) {
      const provider = resolveInfraProvider(providerConfig(resource));
      try {
        // O6: conceptually the cert enters "rotating" here — the provider call
        // runs inside this txn (no async boundary to persist it across), and
        // the durable checkpoint is the terminal state below.
        const res = await provider.remediate({
          id: finding?.id ?? ledgerId,
          resourceId: resource.id,
          kind: ACTION_TO_KIND[action],
          signature,
          detail: finding?.detail ?? null,
        });
        providerDetail = res.detail;
      } catch (err) {
        // O6: a cert rotation the provider fails lands in the FAILED terminal
        // state (attempt row 'failed' + reason, cert 'rotation_failed',
        // finding re-opened for re-proposal) instead of aborting the decide.
        // patch/backup keep the pre-O6 contract: a provider throw propagates.
        if (action !== "cert_rotate") throw err;
        providerError = err instanceof Error ? err.message : String(err);
      }
    }
    if (action === "cert_rotate" && providerError !== null) {
      if (proposedRotation) {
        await tx
          .update(certRotations)
          .set({
            status: "failed",
            reason: providerError,
            approvalId: approvalRow.id ?? proposedRotation.approvalId,
            findingId: finding?.id ?? proposedRotation.findingId,
          })
          .where(eq(certRotations.id, proposedRotation.id));
      } else {
        await tx.insert(certRotations).values({
          certId: certRow!.id,
          findingId: finding?.id ?? null,
          approvalId: approvalRow.id ?? null,
          oldSerial: certRow!.serial ?? null,
          status: "failed",
          reason: providerError,
        });
      }
      await tx
        .update(certInventory)
        .set({ status: "rotation_failed" })
        .where(eq(certInventory.id, certRow!.id));
      if (finding) {
        // re-proposable: the finding goes back to open, never silently closed
        await tx.update(infraFindings).set({ status: "open" }).where(eq(infraFindings.id, finding.id));
      }
      await tx.insert(auditLog).values({
        userId: deciderUserId,
        objectType: "infra_operation",
        objectId: finding?.id ?? null,
        detail: { phase: "action-decision", action, decision, ledgerId, signature, providerError },
        effect: "deny",
        ruleId: "infra-cert-rotation-failed",
        ruleChain: [],
        reason: `approved cert rotation FAILED at the provider on ${resource?.name ?? resourceId}: ${providerError} — cert marked rotation_failed, finding re-opened, re-proposable`,
        deployMode,
      });
      return;
    }
    // write the durable OUTCOME per action
    if (action === "cert_rotate") {
      const newSerial = `SER-rot-${now.getTime()}`;
      const newNotAfter = new Date(now.getTime() + 365 * 86_400_000);
      if (proposedRotation) {
        await tx
          .update(certRotations)
          .set({
            findingId: finding?.id ?? proposedRotation.findingId,
            approvalId: approvalRow.id ?? proposedRotation.approvalId,
            newSerial,
            newNotAfter,
            status: "rotated",
            rotatedAt: now,
          })
          .where(eq(certRotations.id, proposedRotation.id));
      } else {
        await tx.insert(certRotations).values({
          certId: certRow!.id,
          findingId: finding?.id ?? null,
          approvalId: approvalRow.id ?? null,
          oldSerial: certRow!.serial ?? null,
          newSerial,
          newNotAfter,
          status: "rotated",
          rotatedAt: now,
        });
      }
      await tx
        .update(certInventory)
        .set({ notAfter: newNotAfter, lastRotatedAt: now, serial: newSerial, status: "rotated" })
        .where(eq(certInventory.id, certRow!.id));
    } else if (action === "patch_apply") {
      await tx
        .update(patchRecords)
        .set({ status: "patched", patchedAt: now })
        .where(eq(patchRecords.id, patchRow!.id));
    } else {
      await tx.insert(backupRuns).values({
        resourceId: resource!.id,
        findingId: finding?.id ?? null,
        kind: "restore",
        status: "restored",
        startedAt: now,
        finishedAt: now,
        retentionUntil: backupRow!.retentionUntil ?? null,
      });
    }
    if (finding) {
      await tx.update(infraFindings).set({ status: "remediated" }).where(eq(infraFindings.id, finding.id));
    }
    await tx.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "infra_operation",
      objectId: finding?.id ?? null,
      detail: {
        phase: "action-decision",
        action,
        decision,
        ledgerId,
        signature,
        // §3 data boundary: never retain execution-plane detail for an
        // air-gapped resource — only metadata crosses back.
        ...(airGapped ? { boundary: "air_gapped", metadataOnly: true } : { providerDetail }),
      },
      effect: "allow",
      ruleId: "infra-action-applied",
      ruleChain: [],
      reason: `governed ${action} approved by the named approver on ${resource?.name ?? resourceId}${airGapped ? " (air-gapped: metadata-only record retained)" : ""}`,
      deployMode, // A4: null when the resource is not target-pinned
    });
  } else {
    // deny — the finding is the single accepted-risk surface.
    if (action === "cert_rotate") {
      // O6: a denied rotation KEEPS its denied marker — the cert lands in
      // rotation_denied (re-proposable via the rotate endpoint) and the
      // attempt's ledger row records who-said-no's reason. Pre-O6 this reset
      // to 'active', erasing that a rotation was ever refused.
      const deniedReason = approvalRow.decisionReason ?? "denied by the named approver";
      await tx
        .update(certInventory)
        .set({ status: "rotation_denied" })
        .where(eq(certInventory.id, certRow!.id));
      if (proposedRotation) {
        await tx
          .update(certRotations)
          .set({
            status: "denied",
            reason: deniedReason,
            approvalId: approvalRow.id ?? proposedRotation.approvalId,
            findingId: finding?.id ?? proposedRotation.findingId,
          })
          .where(eq(certRotations.id, proposedRotation.id));
      } else {
        await tx.insert(certRotations).values({
          certId: certRow!.id,
          findingId: finding?.id ?? null,
          approvalId: approvalRow.id ?? null,
          oldSerial: certRow!.serial ?? null,
          status: "denied",
          reason: deniedReason,
        });
      }
    } else if (action === "patch_apply") {
      await tx.update(patchRecords).set({ status: "accepted_risk" }).where(eq(patchRecords.id, patchRow!.id));
    } else {
      await tx.update(backupRuns).set({ status: "missed" }).where(eq(backupRuns.id, backupRow!.id));
    }
    if (finding) {
      await tx.update(infraFindings).set({ status: "accepted_risk" }).where(eq(infraFindings.id, finding.id));
    }
    await tx.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "infra_operation",
      objectId: finding?.id ?? null,
      detail: { phase: "action-decision", action, decision, ledgerId, signature },
      effect: "deny",
      ruleId: "infra-action-denied",
      ruleChain: [],
      reason:
        action === "cert_rotate"
          ? `governed cert_rotate denied on ${resource?.name ?? resourceId}; cert marked rotation_denied (re-proposable), denial reason recorded on the rotation ledger, finding logged as accepted risk`
          : `governed ${action} denied on ${resource?.name ?? resourceId}; logged as accepted risk, infra state unchanged`,
      deployMode, // A4
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
      // keep the durable ledger + back-link current (idempotent — no dup rows)
      await syncFindingLedger(db, resource, existing.id, report);
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
    // materialize the durable ledger row + stamp the finding's ref back-link
    await syncFindingLedger(db, resource, inserted!.id, report);
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

/** ADR-0017 — the shared propose path for the three operator verbs. Mirrors the
 * finding/:id/remediate propose EXACTLY: a named approver gates it, the linked
 * finding flips to 'remediation_proposed', and a require_approval audit row is
 * written. The only difference is the action-tagged sentinel on the approval. */
async function proposeInfraAction(
  db: Db,
  action: InfraAction,
  ledger: { id: string; resourceId: string; refTable: string },
  approverUserId: string,
  actorId: string,
): Promise<string> {
  const [finding] = await db
    .select()
    .from(infraFindings)
    .where(and(eq(infraFindings.refTable, ledger.refTable), eq(infraFindings.refId, ledger.id)));
  const [resource] = await db
    .select()
    .from(infraResources)
    .where(eq(infraResources.id, ledger.resourceId));
  const [approval] = await db
    .insert(approvals)
    .values({
      userId: actorId,
      objectType: "infra_operation",
      stageId: `${INFRA_ACTION_PREFIX}${action}:${ledger.id}`,
      approverUserId,
    })
    .returning({ id: approvals.id });
  if (finding && finding.status === "open") {
    await db
      .update(infraFindings)
      .set({ status: "remediation_proposed" })
      .where(eq(infraFindings.id, finding.id));
  }
  await db.insert(auditLog).values({
    userId: actorId,
    objectType: "infra_operation",
    objectId: finding?.id ?? ledger.id,
    detail: {
      phase: "action-proposed",
      action,
      ledgerId: ledger.id,
      approverUserId,
      resource: resource?.name ?? ledger.resourceId,
    },
    effect: "require_approval",
    ruleId: "infra-action-proposed",
    ruleChain: [],
    reason: `governed ${action} on ${resource?.name ?? ledger.resourceId} pends the named approver — infra state unchanged until approval`,
    // A4: proposals on a target-pinned resource carry the target's mode too
    deployMode: await resourceDeployMode(db, resource?.deployTargetId ?? null),
  });
  return approval!.id;
}

async function requireApprover(db: Db, approverUserId: string): Promise<boolean> {
  const [approver] = await db.select({ id: users.id }).from(users).where(eq(users.id, approverUserId));
  return Boolean(approver);
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

  // === ADR-0017 automation ledgers ======================================
  // All read + verb routes below are admin-only (NOT in NON_ADMIN_ROUTES); the
  // shared /decide route stays the one non-admin touchpoint. The verb POSTs are
  // thin wrappers funnelling into the ONE governed approval path above.

  // --- certificates -----------------------------------------------------
  app.get("/v1/infra/certs", async () => {
    const [certs, resources] = await Promise.all([
      db.select().from(certInventory).orderBy(desc(certInventory.createdAt)),
      db.select({ id: infraResources.id, name: infraResources.name }).from(infraResources),
    ]);
    const nameOf = new Map(resources.map((r) => [r.id, r.name]));
    return { certs: certs.map((c) => ({ ...c, resourceName: nameOf.get(c.resourceId) ?? null })) };
  });

  app.get("/v1/infra/certs/:certId/rotations", async (req, reply) => {
    const { certId } = certIdParam.parse(req.params);
    const [cert] = await db.select({ id: certInventory.id }).from(certInventory).where(eq(certInventory.id, certId));
    if (!cert) return reply.status(404).send({ error: "unknown_cert" });
    return {
      rotations: await db
        .select()
        .from(certRotations)
        .where(eq(certRotations.certId, certId))
        .orderBy(desc(certRotations.createdAt)),
    };
  });

  app.post("/v1/infra/certs/:certId/rotate", async (req, reply) => {
    const { certId } = certIdParam.parse(req.params);
    const body = rotateCertSchema.parse(req.body);
    const [cert] = await db.select().from(certInventory).where(eq(certInventory.id, certId));
    if (!cert) return reply.status(404).send({ error: "unknown_cert" });
    // O6 lifecycle guard: a rotation may be proposed from active AND from the
    // two re-proposable terminal states (a denied or failed attempt is a
    // recorded outcome, not a dead end). rotation_proposed (already pending),
    // rotated and expired stay 409s.
    const REPROPOSABLE = ["active", "rotation_denied", "rotation_failed"];
    if (!REPROPOSABLE.includes(cert.status)) {
      return reply.status(409).send({
        error: "not_rotatable",
        detail: `cert is '${cert.status}' — a rotation can be proposed from ${REPROPOSABLE.join("/")} only`,
      });
    }
    if (!(await requireApprover(db, body.approverUserId))) return reply.status(422).send({ error: "unknown_approver" });
    const actorId = await resolveActor(db, req.authCtx.userId);
    await db.update(certInventory).set({ status: "rotation_proposed" }).where(eq(certInventory.id, certId));
    // O6: the attempt's own ledger row, created AT PROPOSE (status
    // 'proposed'); the /decide hook advances it to rotated/denied/failed —
    // every attempt leaves a durable, reasoned record.
    const [linkedFinding] = await db
      .select({ id: infraFindings.id })
      .from(infraFindings)
      .where(and(eq(infraFindings.refTable, "cert_inventory"), eq(infraFindings.refId, certId)));
    await db.insert(certRotations).values({
      certId,
      findingId: linkedFinding?.id ?? null,
      oldSerial: cert.serial ?? null,
      status: "proposed",
    });
    const approvalId = await proposeInfraAction(
      db,
      "cert_rotate",
      { id: certId, resourceId: cert.resourceId, refTable: "cert_inventory" },
      body.approverUserId,
      actorId,
    );
    return reply.status(202).send({ pending: true, approvalId });
  });

  // --- CVE patches ------------------------------------------------------
  app.get("/v1/infra/patches", async () => {
    const [patches, resources] = await Promise.all([
      db.select().from(patchRecords).orderBy(desc(patchRecords.createdAt)),
      db.select({ id: infraResources.id, name: infraResources.name }).from(infraResources),
    ]);
    const nameOf = new Map(resources.map((r) => [r.id, r.name]));
    return { patches: patches.map((p) => ({ ...p, resourceName: nameOf.get(p.resourceId) ?? null })) };
  });

  app.post("/v1/infra/patches/:patchId/apply", async (req, reply) => {
    const { patchId } = patchIdParam.parse(req.params);
    const body = applyPatchSchema.parse(req.body);
    const [patch] = await db.select().from(patchRecords).where(eq(patchRecords.id, patchId));
    if (!patch) return reply.status(404).send({ error: "unknown_patch" });
    if (patch.status !== "open") {
      return reply.status(409).send({ error: "not_applicable", detail: `patch is '${patch.status}'` });
    }
    if (!(await requireApprover(db, body.approverUserId))) return reply.status(422).send({ error: "unknown_approver" });
    const actorId = await resolveActor(db, req.authCtx.userId);
    await db.update(patchRecords).set({ status: "patch_proposed" }).where(eq(patchRecords.id, patchId));
    const approvalId = await proposeInfraAction(
      db,
      "patch_apply",
      { id: patchId, resourceId: patch.resourceId, refTable: "patch_records" },
      body.approverUserId,
      actorId,
    );
    return reply.status(202).send({ pending: true, approvalId });
  });

  // --- backups ----------------------------------------------------------
  app.get("/v1/infra/backups", async () => {
    const [runs, resources] = await Promise.all([
      db.select().from(backupRuns).orderBy(desc(backupRuns.createdAt)),
      db.select({ id: infraResources.id, name: infraResources.name }).from(infraResources),
    ]);
    const nameOf = new Map(resources.map((r) => [r.id, r.name]));
    return { backups: runs.map((r) => ({ ...r, resourceName: nameOf.get(r.resourceId) ?? null })) };
  });

  app.post("/v1/infra/backups/:backupId/restore", async (req, reply) => {
    const { backupId } = backupIdParam.parse(req.params);
    const body = restoreBackupSchema.parse(req.body);
    const [run] = await db.select().from(backupRuns).where(eq(backupRuns.id, backupId));
    if (!run) return reply.status(404).send({ error: "unknown_backup" });
    if (run.status !== "missed") {
      return reply.status(409).send({ error: "not_restorable", detail: `backup run is '${run.status}'` });
    }
    if (!(await requireApprover(db, body.approverUserId))) return reply.status(422).send({ error: "unknown_approver" });
    const actorId = await resolveActor(db, req.authCtx.userId);
    await db.update(backupRuns).set({ status: "restore_proposed" }).where(eq(backupRuns.id, backupId));
    const approvalId = await proposeInfraAction(
      db,
      "backup_restore",
      { id: backupId, resourceId: run.resourceId, refTable: "backup_runs" },
      body.approverUserId,
      actorId,
    );
    return reply.status(202).send({ pending: true, approvalId });
  });
}
