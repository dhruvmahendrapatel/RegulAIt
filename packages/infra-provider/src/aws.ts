/**
 * @regulait/infra-provider — REAL AWS adapter (the ADR-0017 "still a 501"
 * deferred item, now built). Implements the `// REAL:` plan that sat at the
 * registry's aws 501: assume the customer's roleArn via STS AssumeRole
 * (short-lived creds, NEVER a static key — the same no-static-keys rule as
 * apps/gateway/src/deploy.ts AwsDeployProvider), then drive scan/remediate
 * (SSM patch, ACM rotate, AWS Backup start) in the target region.
 *
 * Injectable-client discipline (mirrors AwsDeployProvider / ADR-0015 A1):
 *  - The adapter NEVER touches the network itself. Every AWS call goes through
 *    an injected `AwsInfraLiveClient` — a fake in unit tests, a real
 *    @aws-sdk-backed implementation wired by the gateway in a genuinely live
 *    deployment (see the factory contract on `AwsInfraLiveClient` below).
 *  - The whole live path sits behind the OFF-by-default REGULAIT_INFRA_LIVE
 *    flag. Flag off, or flag on with nothing injected, is a STRUCTURED
 *    not-live failure (InfraProviderError, status 501) — never a fabricated
 *    finding, never a silent success. There is no dry-run scan on purpose:
 *    unlike deploy (where a dry-run is a deterministic *shape*), a dry-run
 *    scan would have to fabricate observations, which ADR-0017's honesty
 *    posture forbids.
 *
 * Every mapped field in a finding comes from a real AWS API response field
 * (provenance is annotated per field). Where the abstraction wants something
 * AWS cannot answer, the adapter says so structurally — an explicit error, an
 * explicit `severitySource`, or an explicit `unassessableKeys` list — instead
 * of inventing data. See the "honest gaps" notes throughout.
 */

import {
  InfraProviderError,
  certSeverity,
  compareDrift,
  cvssToSeverity,
  evaluateBackupSchedule,
  severityRank,
  type InfraFindingRef,
  type InfraFindingReport,
  type InfraProvider,
  type InfraRemediationResult,
  type InfraResourceRef,
  type InfraSeverity,
} from "./index.js";

/** Master switch for the real @aws-sdk infra path. OFF unless the env var is
 * explicitly "1"/"true" — same contract as deploy.ts's deployLiveEnabled. */
export function infraLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.REGULAIT_INFRA_LIVE;
  return v === "1" || v === "true";
}

// ---------------------------------------------------------------------------
// Response shapes — structural mirrors of the exact @aws-sdk output fields the
// adapter consumes (and ONLY those). This package deliberately has no @aws-sdk
// dependency; the real client (gateway-side, where @aws-sdk lives) maps the
// SDK response onto these shapes 1:1. Dates may arrive as the SDK's Date
// objects or as ISO strings.
// ---------------------------------------------------------------------------

/** REAL: ssm DescribeInstanceInformation → InstanceInformationList[] */
export interface AwsSsmInstanceInfo {
  /** InstanceInformation.InstanceId */
  instanceId: string;
  /** InstanceInformation.PingStatus — "Online" | "ConnectionLost" | "Inactive" */
  pingStatus?: string | null;
  /** InstanceInformation.AgentVersion */
  agentVersion?: string | null;
  /** InstanceInformation.IsLatestVersion */
  isLatestVersion?: boolean | null;
  /** InstanceInformation.AssociationStatus — "Success" | "Failed" | "Pending" */
  associationStatus?: string | null;
  /** InstanceInformation.PlatformName */
  platformName?: string | null;
  /** InstanceInformation.PlatformVersion */
  platformVersion?: string | null;
  /** InstanceInformation.LastPingDateTime */
  lastPingDateTime?: string | Date | null;
}

/** REAL: ssm DescribeInstancePatchStates → InstancePatchStates[] */
export interface AwsSsmInstancePatchState {
  /** InstancePatchState.InstanceId */
  instanceId: string;
  /** InstancePatchState.MissingCount */
  missingCount?: number | null;
  /** InstancePatchState.FailedCount */
  failedCount?: number | null;
  /** InstancePatchState.InstalledPendingRebootCount */
  installedPendingRebootCount?: number | null;
  /** InstancePatchState.CriticalNonCompliantCount */
  criticalNonCompliantCount?: number | null;
  /** InstancePatchState.SecurityNonCompliantCount */
  securityNonCompliantCount?: number | null;
  /** InstancePatchState.OperationEndTime */
  operationEndTime?: string | Date | null;
}

/** REAL: ssm DescribeInstancePatches (Filters: Key=State, Values=[Missing,Failed])
 * → Patches[] (PatchComplianceData). */
export interface AwsSsmMissingPatch {
  /** PatchComplianceData.State — "Missing" | "Failed" | ... */
  state: string;
  /** PatchComplianceData.Title */
  title?: string | null;
  /** PatchComplianceData.KBId */
  kbId?: string | null;
  /** PatchComplianceData.Classification — "SecurityUpdates" | "Bugfix" | ... */
  classification?: string | null;
  /** PatchComplianceData.Severity — VENDOR severity ("Critical" | "Important" |
   * "Medium"/"Moderate" | "Low"). NOT a CVSS number — SSM does not return one. */
  severity?: string | null;
  /** PatchComplianceData.CVEIds, split on "," by the real client */
  cveIds?: string[] | null;
  /** HONEST GAP — NOT an SSM field. SSM patch compliance carries no CVSS
   * score. A real client MAY enrich this from Amazon Inspector2 ListFindings
   * (packageVulnerabilityDetails.cvss[].baseScore — a real API field) when
   * Inspector covers the instance. Absent = no CVSS is known; the adapter then
   * falls back to the vendor severity string, and says so in
   * `detail.severitySource`. It never invents a number. */
  cvssBaseScore?: number | null;
}

/** REAL: acm ListCertificates → CertificateSummaryList[] */
export interface AwsAcmCertificateSummary {
  /** CertificateSummary.CertificateArn */
  certificateArn: string;
  /** CertificateSummary.DomainName */
  domainName?: string | null;
  /** CertificateSummary.Status */
  status?: string | null;
}

/** REAL: acm DescribeCertificate → Certificate */
export interface AwsAcmCertificateDetail {
  /** Certificate.CertificateArn */
  certificateArn: string;
  /** Certificate.DomainName */
  domainName?: string | null;
  /** Certificate.Issuer */
  issuer?: string | null;
  /** Certificate.Serial */
  serial?: string | null;
  /** Certificate.NotAfter — absent while PENDING_VALIDATION / FAILED */
  notAfter?: string | Date | null;
  /** Certificate.Status — "ISSUED" | "PENDING_VALIDATION" | "EXPIRED" | ... */
  status?: string | null;
  /** Certificate.RenewalEligibility — "ELIGIBLE" | "INELIGIBLE" */
  renewalEligibility?: string | null;
  /** Certificate.Type — "AMAZON_ISSUED" | "IMPORTED" | "PRIVATE" */
  type?: string | null;
}

/** REAL: backup ListRecoveryPointsByBackupVault → RecoveryPoints[] */
export interface AwsBackupRecoveryPoint {
  /** RecoveryPointByBackupVault.RecoveryPointArn */
  recoveryPointArn: string;
  /** RecoveryPointByBackupVault.Status — "COMPLETED" | "PARTIAL" | "DELETING" | "EXPIRED" */
  status?: string | null;
  /** RecoveryPointByBackupVault.CreationDate */
  creationDate?: string | Date | null;
  /** RecoveryPointByBackupVault.CompletionDate */
  completionDate?: string | Date | null;
  /** RecoveryPointByBackupVault.ResourceArn */
  resourceArn?: string | null;
  /** RecoveryPointByBackupVault.BackupSizeInBytes */
  backupSizeInBytes?: number | null;
}

export interface AwsAssumedSession {
  /** an opaque marker for the assumed-role session the client is now holding
   * (e.g. the AssumedRoleUser.AssumedRoleId). The adapter threads it through
   * every subsequent call so the client can bind that call to the short-lived
   * credentials — credentials themselves NEVER pass through this package. */
  sessionId: string;
}

/**
 * The injected live-AWS client (injectable-client discipline, exactly like
 * deploy.ts's AwsLiveDeployClient). ALWAYS supplied by the caller — a fake in
 * unit tests, a real @aws-sdk-backed impl in a live deployment. There is no
 * default network client, so "flag on with nothing injected" is a clear
 * structured error, never a silent stub.
 *
 * FACTORY CONTRACT — what the gateway wires later (it owns the @aws-sdk deps;
 * this package deliberately has none). Requires @aws-sdk/client-sts (already a
 * gateway dep) plus NEW deps @aws-sdk/client-ssm, @aws-sdk/client-acm,
 * @aws-sdk/client-backup:
 *
 *   assumeRole            → new STSClient({region}).send(new AssumeRoleCommand({
 *                             RoleArn, RoleSessionName, DurationSeconds }));
 *                           hold response.Credentials internally, return
 *                           { sessionId: response.AssumedRoleUser.AssumedRoleId }.
 *   describeInstanceInformation → new SSMClient({region, credentials}).send(
 *                             new DescribeInstanceInformationCommand({})), paginated.
 *   describeInstancePatchStates → SSMClient.send(new
 *                             DescribeInstancePatchStatesCommand({InstanceIds})).
 *   describeInstanceMissingPatches → SSMClient.send(new DescribeInstancePatchesCommand({
 *                             InstanceId, Filters: [{Key: "State", Values: ["Missing", "Failed"]}]})),
 *                           paginated; CVEIds split on ",".
 *   listCertificates      → new ACMClient({region, credentials}).send(new
 *                             ListCertificatesCommand({})), paginated.
 *   describeCertificate   → ACMClient.send(new DescribeCertificateCommand({CertificateArn})).
 *   listRecoveryPoints    → new BackupClient({region, credentials}).send(new
 *                             ListRecoveryPointsByBackupVaultCommand({BackupVaultName,
 *                             ByResourceArn?})), paginated.
 *   runPatchBaseline      → SSMClient.send(new SendCommandCommand({InstanceIds,
 *                             DocumentName: "AWS-RunPatchBaseline",
 *                             Parameters: {Operation: ["Install"]}})) →
 *                           { commandId: response.Command.CommandId }.
 *   renewCertificate      → ACMClient.send(new RenewCertificateCommand({CertificateArn}))
 *                           (empty 200 response — success is the absence of a throw).
 *   startBackupJob        → BackupClient.send(new StartBackupJobCommand({BackupVaultName,
 *                             ResourceArn, IamRoleArn})) → { backupJobId: response.BackupJobId }.
 */
export interface AwsInfraLiveClient {
  /** REAL: sts:AssumeRole into the customer's role — short-lived creds only. */
  assumeRole(params: {
    roleArn: string;
    roleSessionName: string;
    durationSeconds: number;
    region: string;
  }): Promise<AwsAssumedSession>;
  /** REAL: ssm:DescribeInstanceInformation */
  describeInstanceInformation(params: {
    region: string;
    sessionId: string;
  }): Promise<AwsSsmInstanceInfo[]>;
  /** REAL: ssm:DescribeInstancePatchStates */
  describeInstancePatchStates(params: {
    region: string;
    sessionId: string;
    instanceIds: string[];
  }): Promise<AwsSsmInstancePatchState[]>;
  /** REAL: ssm:DescribeInstancePatches filtered to State in (Missing, Failed) */
  describeInstanceMissingPatches(params: {
    region: string;
    sessionId: string;
    instanceId: string;
  }): Promise<AwsSsmMissingPatch[]>;
  /** REAL: acm:ListCertificates */
  listCertificates(params: { region: string; sessionId: string }): Promise<AwsAcmCertificateSummary[]>;
  /** REAL: acm:DescribeCertificate */
  describeCertificate(params: {
    region: string;
    sessionId: string;
    certificateArn: string;
  }): Promise<AwsAcmCertificateDetail>;
  /** REAL: backup:ListRecoveryPointsByBackupVault */
  listRecoveryPoints(params: {
    region: string;
    sessionId: string;
    backupVaultName: string;
    resourceArn?: string;
  }): Promise<AwsBackupRecoveryPoint[]>;
  /** REAL: ssm:SendCommand AWS-RunPatchBaseline Operation=Install */
  runPatchBaseline(params: {
    region: string;
    sessionId: string;
    instanceIds: string[];
  }): Promise<{ commandId: string }>;
  /** REAL: acm:RenewCertificate (managed-renewal-eligible certs only) */
  renewCertificate(params: {
    region: string;
    sessionId: string;
    certificateArn: string;
  }): Promise<void>;
  /** REAL: backup:StartBackupJob (out-of-band backup) */
  startBackupJob(params: {
    region: string;
    sessionId: string;
    backupVaultName: string;
    resourceArn: string;
    iamRoleArn: string;
  }): Promise<{ backupJobId: string }>;
}

// ---------------------------------------------------------------------------
// Severity mapping — every band is either the shared ADR-0017 math
// (cvssToSeverity / certSeverity / evaluateBackupSchedule / compareDrift) or a
// DOCUMENTED, source-tagged policy over real AWS fields. `severitySource` in
// the finding detail always says which one was used.
// ---------------------------------------------------------------------------

/** Vendor patch-severity string (SSM PatchComplianceData.Severity) → our
 * ladder. Returns null for values it does not recognize — the caller decides
 * what an unknown means, out loud. */
export function vendorPatchSeverityToBand(vendor: string | null | undefined): InfraSeverity | null {
  switch ((vendor ?? "").trim().toLowerCase()) {
    case "critical":
      return "critical";
    case "important":
    case "high":
      return "high";
    case "medium":
    case "moderate":
      return "medium";
    case "low":
      return "low";
    default:
      return null;
  }
}

export type AwsPatchSeveritySource = "cvss" | "vendor" | "default";

/** Band a single missing patch. Preference order, each from a real field:
 * 1. a CVSS base score (Inspector enrichment) → the shared 9/7/4 ladder;
 * 2. the SSM vendor severity string → vendorPatchSeverityToBand;
 * 3. neither known → "medium", explicitly tagged severitySource:"default"
 *    (a documented conservative policy for an UNKNOWN severity — stated,
 *    never silent; deliberately not "low", which would under-alert on a
 *    missing security patch we know nothing about). */
export function patchSeverityBand(patch: AwsSsmMissingPatch): {
  severity: InfraSeverity;
  severitySource: AwsPatchSeveritySource;
} {
  if (typeof patch.cvssBaseScore === "number" && Number.isFinite(patch.cvssBaseScore)) {
    return { severity: cvssToSeverity(patch.cvssBaseScore), severitySource: "cvss" };
  }
  const vendor = vendorPatchSeverityToBand(patch.severity);
  if (vendor !== null) return { severity: vendor, severitySource: "vendor" };
  return { severity: "medium", severitySource: "default" };
}

/** The instance-baseline keys the adapter can actually OBSERVE via SSM
 * DescribeInstanceInformation, with the real source field of each. Any
 * declared-baseline key outside this set is reported in the finding's
 * `unassessableKeys` — an honest "AWS can't answer this" — and is never
 * counted as drift. */
const OBSERVABLE_INSTANCE_KEYS: Record<string, (i: AwsSsmInstanceInfo) => unknown> = {
  ping_status: (i) => i.pingStatus ?? null,
  agent_version: (i) => i.agentVersion ?? null,
  is_latest_agent: (i) => i.isLatestVersion ?? null,
  association_status: (i) => i.associationStatus ?? null,
  platform_name: (i) => i.platformName ?? null,
  platform_version: (i) => i.platformVersion ?? null,
};

/** The default declared baseline when the resource config carries none: a
 * managed instance should be reachable, on the latest agent, with its State
 * Manager associations applied. Overridable via resource.config.baseline. */
export const DEFAULT_INSTANCE_BASELINE: Record<string, unknown> = {
  ping_status: "Online",
  is_latest_agent: true,
  association_status: "Success",
};

function toDate(v: string | Date | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strField(detail: Record<string, unknown>, key: string): string | null {
  const v = detail[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface AwsInfraProviderOptions {
  /** the customer IAM role the scan/remediation assumes (BYOC boundary) */
  roleArn: string;
  /** the customer region every call is driven in */
  region: string;
  /** injectable-client discipline: a fake in tests, a real @aws-sdk-backed
   * impl (see the AwsInfraLiveClient factory contract) in a live deployment.
   * Absent = every operation is a structured not-live error. */
  client?: AwsInfraLiveClient;
  /** captured at construction so a test can flip it per-instance; defaults to
   * the REGULAIT_INFRA_LIVE env flag. */
  live?: boolean;
  /** injectable clock for deterministic severity-band tests */
  now?: () => Date;
}

export class AwsInfraProvider implements InfraProvider {
  readonly kind = "aws" as const;
  private readonly roleArn: string;
  private readonly region: string;
  private readonly client: AwsInfraLiveClient | undefined;
  private readonly live: boolean;
  private readonly now: () => Date;

  constructor(opts: AwsInfraProviderOptions) {
    this.roleArn = opts.roleArn;
    this.region = opts.region;
    this.client = opts.client;
    this.live = opts.live ?? infraLiveEnabled();
    this.now = opts.now ?? (() => new Date());
  }

  /** The honesty gate. Not live, or live-but-unwired, is a STRUCTURED failure
   * (typed error, status 501) BEFORE any result could be shaped — a scan that
   * "succeeded" with fabricated findings, or an empty list pretending to be a
   * clean fleet, would be fake data (ADR-0017). */
  private requireLive(op: string): AwsInfraLiveClient {
    if (!this.roleArn || !this.region) {
      throw new InfraProviderError(
        `aws infra ${op} needs a roleArn and region on the monitored resource`,
      );
    }
    if (!this.live) {
      throw new InfraProviderError(
        `aws infra ${op} did not run: REGULAIT_INFRA_LIVE is off and this adapter has no dry-run — ` +
          `a fabricated scan result would be fake data (ADR-0017). Enable the flag AND inject a live client to go live.`,
        501,
      );
    }
    if (!this.client) {
      throw new InfraProviderError(
        `aws infra ${op} did not run: REGULAIT_INFRA_LIVE is on but no live AWS infra client was injected — ` +
          `wire an AwsInfraLiveClient (see the factory contract in @regulait/infra-provider aws.ts); never a silent stub`,
        501,
      );
    }
    return this.client;
  }

  /** Wrap every client call so an AWS failure (throttling, auth, network)
   * surfaces as a typed InfraProviderError naming the operation, carrying the
   * SDK's real $metadata.httpStatusCode when present. */
  private async call<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof InfraProviderError) throw err;
      const e = err as {
        name?: string;
        message?: string;
        $metadata?: { httpStatusCode?: number };
      };
      const prefix = typeof e?.name === "string" && e.name.length > 0 && e.name !== "Error" ? `${e.name}: ` : "";
      throw new InfraProviderError(
        `aws ${op} failed — ${prefix}${e?.message ?? String(err)}`,
        e?.$metadata?.httpStatusCode,
      );
    }
  }

  /** REAL: sts:AssumeRole with short-lived creds (DurationSeconds 3600), the
   * same no-static-keys rule as AwsDeployProvider. RoleSessionName is
   * sanitized to the STS charset. */
  private async assume(client: AwsInfraLiveClient, seed: string): Promise<AwsAssumedSession> {
    const session = `regulait-infra-${seed}`.replace(/[^\w+=,.@-]/g, "-").slice(0, 64);
    return this.call("sts:AssumeRole", () =>
      client.assumeRole({
        roleArn: this.roleArn,
        roleSessionName: session,
        durationSeconds: 3600,
        region: this.region,
      }),
    );
  }

  async scan(resource: InfraResourceRef): Promise<InfraFindingReport[]> {
    const client = this.requireLive("scan");
    const { sessionId } = await this.assume(client, resource.id);
    switch (resource.kind) {
      case "control_plane":
      case "agent_runtime":
        return this.scanInstances(client, sessionId, resource);
      case "cert":
        return this.scanCerts(client, sessionId, resource);
      case "backup_target":
        return this.scanBackups(client, sessionId, resource);
    }
  }

  /** SSM DescribeInstanceInformation (drift vs the declared baseline) +
   * DescribeInstancePatchStates / DescribeInstancePatches (CVE posture). */
  private async scanInstances(
    client: AwsInfraLiveClient,
    sessionId: string,
    resource: InfraResourceRef,
  ): Promise<InfraFindingReport[]> {
    const cfg = resource.config ?? {};
    const instances = await this.call("ssm:DescribeInstanceInformation", () =>
      client.describeInstanceInformation({ region: this.region, sessionId }),
    );
    if (instances.length === 0) {
      // HONEST GAP: zero managed instances is NOT a clean fleet — it means SSM
      // cannot see the resource at all, so drift/CVE posture is unanswerable.
      // An empty findings list here would be a fake "all clear".
      throw new InfraProviderError(
        `aws scan of '${resource.name}': ssm:DescribeInstanceInformation returned no managed instances in ${this.region} — ` +
          `drift/CVE posture cannot be assessed (nothing observed is not the same as clean); ` +
          `check the SSM agent / instance profile on the target fleet`,
      );
    }

    const declared = isRecord(cfg.baseline) ? cfg.baseline : DEFAULT_INSTANCE_BASELINE;
    const declaredObservable: Record<string, unknown> = {};
    const unassessableKeys: string[] = [];
    for (const key of Object.keys(declared)) {
      if (key in OBSERVABLE_INSTANCE_KEYS) declaredObservable[key] = declared[key];
      else unassessableKeys.push(key);
    }
    unassessableKeys.sort();

    const findings: InfraFindingReport[] = [];

    // ---- drift, per instance, every observed value a real SSM field --------
    for (const inst of [...instances].sort((a, b) => a.instanceId.localeCompare(b.instanceId))) {
      const observed: Record<string, unknown> = {};
      for (const key of Object.keys(declaredObservable)) {
        observed[key] = OBSERVABLE_INSTANCE_KEYS[key]!(inst);
      }
      const drift = compareDrift(declaredObservable, observed);
      if (drift.drifted.length === 0 && unassessableKeys.length === 0) continue;
      const signature = `drift:${inst.instanceId}`;
      findings.push({
        kind: "drift",
        // unassessable-only (no observable drift) stays "low": it is a
        // visibility gap to surface, not an observed deviation.
        severity: drift.drifted.length > 0 ? drift.severity : "low",
        signature,
        detail: {
          signature,
          instanceId: inst.instanceId,
          drifted: drift.drifted,
          declared: declaredObservable,
          observed,
          // declared-baseline keys SSM cannot observe — reported, never guessed
          unassessableKeys,
          summary:
            drift.drifted.length > 0
              ? `instance ${inst.instanceId} drifted from the declared baseline on: ${drift.drifted.join(", ")}`
              : `declared baseline key(s) ${unassessableKeys.join(", ")} cannot be assessed via ssm:DescribeInstanceInformation`,
        },
      });
    }

    // ---- CVE posture -------------------------------------------------------
    const instanceIds = instances.map((i) => i.instanceId).sort();
    const patchStates = await this.call("ssm:DescribeInstancePatchStates", () =>
      client.describeInstancePatchStates({ region: this.region, sessionId, instanceIds }),
    );
    // aggregate identical missing patches across the fleet into ONE finding
    // keyed by the patch's natural id (first CVE id, else KB id, else title) —
    // the same natural key the patch ledger upserts on (resource_id, cve).
    const byPatch = new Map<
      string,
      { patch: AwsSsmMissingPatch; severity: InfraSeverity; severitySource: AwsPatchSeveritySource; instanceIds: string[] }
    >();
    for (const state of patchStates) {
      const nonCompliant =
        num(state.missingCount) +
        num(state.failedCount) +
        num(state.criticalNonCompliantCount) +
        num(state.securityNonCompliantCount);
      if (nonCompliant === 0) continue;
      const missing = await this.call("ssm:DescribeInstancePatches", () =>
        client.describeInstanceMissingPatches({
          region: this.region,
          sessionId,
          instanceId: state.instanceId,
        }),
      );
      const relevant = missing.filter((p) => p.state === "Missing" || p.state === "Failed");
      if (relevant.length === 0) {
        // HONEST GAP: the patch state says the instance is non-compliant but
        // per-patch detail is unavailable (permissions, agent inventory lag).
        // Band from the InstancePatchState compliance COUNTERS — all real
        // fields — and say so via severitySource.
        const severity: InfraSeverity =
          num(state.criticalNonCompliantCount) > 0
            ? "critical"
            : num(state.securityNonCompliantCount) > 0
              ? "high"
              : "medium";
        const signature = `cve:patch-state:${state.instanceId}`;
        findings.push({
          kind: "cve",
          severity,
          signature,
          detail: {
            signature,
            instanceId: state.instanceId,
            missingCount: num(state.missingCount),
            failedCount: num(state.failedCount),
            criticalNonCompliantCount: num(state.criticalNonCompliantCount),
            securityNonCompliantCount: num(state.securityNonCompliantCount),
            severitySource: "patch-state-counters",
            summary:
              `instance ${state.instanceId} is patch non-compliant (${num(state.missingCount)} missing, ` +
              `${num(state.failedCount)} failed) but ssm:DescribeInstancePatches returned no per-patch detail — ` +
              `severity banded from the InstancePatchState compliance counters`,
          },
        });
        continue;
      }
      for (const patch of relevant) {
        const key = patch.cveIds?.[0] ?? patch.kbId ?? patch.title ?? "unidentified-patch";
        const band = patchSeverityBand(patch);
        const existing = byPatch.get(key);
        if (!existing) {
          byPatch.set(key, { patch, ...band, instanceIds: [state.instanceId] });
        } else {
          if (!existing.instanceIds.includes(state.instanceId)) existing.instanceIds.push(state.instanceId);
          if (severityRank(band.severity) > severityRank(existing.severity)) {
            existing.severity = band.severity;
            existing.severitySource = band.severitySource;
            existing.patch = patch;
          }
        }
      }
    }
    for (const [key, agg] of [...byPatch.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const signature = `cve:${key}`;
      findings.push({
        kind: "cve",
        severity: agg.severity,
        signature,
        detail: {
          signature,
          cve: key,
          cveIds: agg.patch.cveIds ?? [],
          title: agg.patch.title ?? null,
          kbId: agg.patch.kbId ?? null,
          classification: agg.patch.classification ?? null,
          vendorSeverity: agg.patch.severity ?? null,
          cvssBaseScore: agg.patch.cvssBaseScore ?? null,
          severitySource: agg.severitySource,
          state: agg.patch.state,
          instanceIds: [...agg.instanceIds].sort(),
          summary: `patch for ${key} is ${agg.patch.state.toLowerCase()} on ${agg.instanceIds.length} instance(s)`,
        },
      });
    }
    return findings;
  }

  /** ACM ListCertificates + DescribeCertificate → cert_expiring findings via
   * the shared certSeverity date math (0/14/30-day bands). */
  private async scanCerts(
    client: AwsInfraLiveClient,
    sessionId: string,
    resource: InfraResourceRef,
  ): Promise<InfraFindingReport[]> {
    const cfg = resource.config ?? {};
    const rotationWindowDays = Number(cfg.rotationWindowDays ?? 30);
    const now = this.now();
    const summaries = await this.call("acm:ListCertificates", () =>
      client.listCertificates({ region: this.region, sessionId }),
    );
    const findings: InfraFindingReport[] = [];
    for (const summary of summaries) {
      const cert = await this.call("acm:DescribeCertificate", () =>
        client.describeCertificate({
          region: this.region,
          sessionId,
          certificateArn: summary.certificateArn,
        }),
      );
      const notAfter = toDate(cert.notAfter);
      // HONEST GAP: a cert with no NotAfter (PENDING_VALIDATION / FAILED) has
      // no expiry to band — it is not "expiring", it was never issued. Skipped
      // rather than assigned an invented date/severity.
      if (!notAfter) continue;
      const { severity, daysUntilExpiry, shouldRotate } = certSeverity(notAfter, now, rotationWindowDays);
      if (!shouldRotate && severity === "low") continue; // healthy — no finding
      const commonName = cert.domainName ?? cert.certificateArn;
      const signature = `cert_expiring:${commonName}`;
      findings.push({
        kind: "cert_expiring",
        severity,
        signature,
        detail: {
          signature,
          daysUntilExpiry,
          commonName,
          issuer: cert.issuer ?? null,
          serial: cert.serial ?? null,
          notAfter: notAfter.toISOString(),
          certificateArn: cert.certificateArn,
          status: cert.status ?? null,
          // carried so remediate() can decide whether acm:RenewCertificate is
          // even possible for this cert (IMPORTED certs are INELIGIBLE)
          renewalEligibility: cert.renewalEligibility ?? null,
          type: cert.type ?? null,
          summary:
            daysUntilExpiry <= 0
              ? "certificate has ALREADY EXPIRED — service-affecting"
              : `certificate expires in ${daysUntilExpiry} day(s)`,
        },
      });
    }
    return findings;
  }

  /** AWS Backup ListRecoveryPointsByBackupVault → backup_missed findings via
   * the shared evaluateBackupSchedule interval multipliers (x1 due/medium,
   * x2 missed, x3 high). */
  private async scanBackups(
    client: AwsInfraLiveClient,
    sessionId: string,
    resource: InfraResourceRef,
  ): Promise<InfraFindingReport[]> {
    const cfg = resource.config ?? {};
    const backupVaultName = typeof cfg.backupVaultName === "string" ? cfg.backupVaultName : resource.name;
    const resourceArn = typeof cfg.resourceArn === "string" ? cfg.resourceArn : undefined;
    const schedule = String(cfg.backupSchedule ?? "daily");
    const retentionDays = Number(cfg.retentionDays ?? 30);
    const now = this.now();
    const points = await this.call("backup:ListRecoveryPointsByBackupVault", () =>
      client.listRecoveryPoints({
        region: this.region,
        sessionId,
        backupVaultName,
        ...(resourceArn !== undefined ? { resourceArn } : {}),
      }),
    );
    // only a COMPLETED recovery point with a real CompletionDate counts as a
    // successful backup — PARTIAL/EXPIRED/DELETING do not.
    let lastBackupAt: Date | null = null;
    let lastRecoveryPointArn: string | null = null;
    let completedCount = 0;
    for (const p of points) {
      if (p.status !== "COMPLETED") continue;
      const completed = toDate(p.completionDate);
      if (!completed) continue;
      completedCount += 1;
      if (!lastBackupAt || completed.getTime() > lastBackupAt.getTime()) {
        lastBackupAt = completed;
        lastRecoveryPointArn = p.recoveryPointArn;
      }
    }
    const { due, missed, severity, retentionUntil } = evaluateBackupSchedule(
      schedule,
      lastBackupAt,
      now,
      retentionDays,
    );
    if (!due) return []; // backups are on schedule — no finding
    const signature = `backup_missed:${resource.name}`;
    return [
      {
        kind: "backup_missed",
        severity,
        signature,
        detail: {
          signature,
          backupVaultName,
          resourceArn: resourceArn ?? null,
          schedule,
          due,
          missed,
          lastBackupAt: lastBackupAt ? lastBackupAt.toISOString() : null,
          lastRecoveryPointArn,
          recoveryPointCount: points.length,
          completedCount,
          retentionUntil: retentionUntil.toISOString(),
          // operator config (NOT an AWS response field) carried forward so a
          // governed remediation can backup:StartBackupJob without re-reading
          // the resource — StartBackupJob requires an IamRoleArn.
          iamRoleArn: typeof cfg.iamRoleArn === "string" ? cfg.iamRoleArn : null,
          summary: lastBackupAt
            ? `no successful backup since ${lastBackupAt.toISOString()} (schedule: ${schedule})`
            : `no successful recovery point exists in vault '${backupVaultName}' (schedule: ${schedule})`,
        },
      },
    ];
  }

  /** Governed remediation — reached only AFTER the gateway's approval
   * decision. One real AWS action per finding kind; anything AWS cannot do is
   * an explicit structured error, never a pretend success. */
  async remediate(finding: InfraFindingRef): Promise<InfraRemediationResult> {
    const client = this.requireLive("remediate");
    const detail = isRecord(finding.detail) ? finding.detail : {};
    const { sessionId } = await this.assume(client, finding.id);
    switch (finding.kind) {
      case "cve": {
        const raw = detail.instanceIds;
        const instanceIds = Array.isArray(raw)
          ? raw.filter((v): v is string => typeof v === "string" && v.length > 0)
          : strField(detail, "instanceId")
            ? [strField(detail, "instanceId")!]
            : [];
        if (instanceIds.length === 0) {
          throw new InfraProviderError(
            "aws patch remediation needs the scan finding's detail.instanceIds — refusing to run AWS-RunPatchBaseline against an unknown instance set",
          );
        }
        const { commandId } = await this.call("ssm:SendCommand(AWS-RunPatchBaseline)", () =>
          client.runPatchBaseline({ region: this.region, sessionId, instanceIds }),
        );
        return {
          ok: true,
          detail: {
            remediated: true,
            kind: finding.kind,
            signature: finding.signature,
            action: "applied vendor patch",
            via: "ssm:SendCommand AWS-RunPatchBaseline Operation=Install",
            commandId,
            instanceIds,
            live: true,
          },
        };
      }
      case "cert_expiring": {
        const certificateArn = strField(detail, "certificateArn");
        if (!certificateArn) {
          throw new InfraProviderError(
            "aws certificate rotation needs the scan finding's detail.certificateArn — refusing to guess which certificate to renew",
          );
        }
        // HONEST GAP: ACM managed renewal only works for ELIGIBLE (Amazon-
        // issued / private-CA) certs. An IMPORTED cert cannot be rotated by
        // acm:RenewCertificate — surfacing that beats a doomed API call.
        if (detail.renewalEligibility === "INELIGIBLE") {
          throw new InfraProviderError(
            `acm:RenewCertificate cannot rotate ${certificateArn}: RenewalEligibility=INELIGIBLE ` +
              `(imported / externally-issued certificate) — rotate at the issuing CA and re-import`,
            501,
          );
        }
        await this.call("acm:RenewCertificate", () =>
          client.renewCertificate({ region: this.region, sessionId, certificateArn }),
        );
        return {
          ok: true,
          detail: {
            remediated: true,
            kind: finding.kind,
            signature: finding.signature,
            action: "rotated certificate",
            via: "acm:RenewCertificate",
            certificateArn,
            live: true,
          },
        };
      }
      case "backup_missed": {
        const backupVaultName = strField(detail, "backupVaultName");
        const resourceArn = strField(detail, "resourceArn");
        const iamRoleArn = strField(detail, "iamRoleArn");
        const missing = [
          !backupVaultName && "backupVaultName",
          !resourceArn && "resourceArn",
          !iamRoleArn && "iamRoleArn",
        ].filter((v): v is string => typeof v === "string");
        if (missing.length > 0) {
          throw new InfraProviderError(
            `aws out-of-band backup needs ${missing.join(", ")} in the finding detail ` +
              `(backup:StartBackupJob requires all three) — set resourceArn/iamRoleArn on the monitored resource's config`,
          );
        }
        const { backupJobId } = await this.call("backup:StartBackupJob", () =>
          client.startBackupJob({
            region: this.region,
            sessionId,
            backupVaultName: backupVaultName!,
            resourceArn: resourceArn!,
            iamRoleArn: iamRoleArn!,
          }),
        );
        return {
          ok: true,
          detail: {
            remediated: true,
            kind: finding.kind,
            signature: finding.signature,
            action: "triggered out-of-band backup",
            via: "backup:StartBackupJob",
            backupJobId,
            backupVaultName,
            resourceArn,
            live: true,
          },
        };
      }
      case "drift":
        // HONEST GAP: "re-apply the configuration baseline" is the owning IaC
        // pipeline's job (Terraform / State Manager). No generic AWS API
        // reverses arbitrary drift, and this adapter will not guess at
        // mutations in a customer account — unsupported, said structurally.
        throw new InfraProviderError(
          "aws drift remediation is not supported by this adapter: re-applying a configuration baseline is the " +
            "owning IaC pipeline's job (Terraform / SSM State Manager) — the adapter does not guess at mutations " +
            "in a customer account",
          501,
        );
    }
  }
}
