/**
 * @regulait/infra-provider — the detection + remediation layer behind pillar 3's
 * §8.2 infrastructure-operations (GOVERNANCE §8.2). Mirrors the
 * connector-provider/pm-provider/model-provider playbook EXACTLY: a neutral
 * interface, an in-memory mock for tests and air-gapped/keyless development, an
 * injectable fetch for the future cloud adapters, and a registry whose switch
 * stays exhaustive over the kind union — a future new kind forces a compile
 * error instead of a silent promise.
 *
 * IMPORTANT — this is a GOVERNED-OPERATIONS layer, NOT a real infra patcher.
 * `scan` returns inert FINDINGS (reports). `remediate` performs a single
 * already-authorized remediation and is only ever reached AFTER the gateway's
 * governance decision (auto-remediate under policy, or a human approval). This
 * package never decides whether a remediation is permitted — the gateway does,
 * at the same interception point that enforces pillar 1 and attributes pillar 5.
 *
 * "No silent promises" rule (same as connector-provider): kinds that are
 * interface-ready but not implemented (azure/gcp) throw an explicit "not
 * implemented yet" from the registry rather than pretending. The aws kind now
 * has a REAL adapter (src/aws.ts) behind the OFF-by-default REGULAIT_INFRA_LIVE
 * flag + an injected AwsInfraLiveClient; unflagged/unwired it stays a
 * structured 501 — never a fabricated scan.
 */

import { z } from "zod";
import { AwsInfraProvider, infraLiveEnabled, type AwsInfraLiveClient } from "./aws.js";

export const INFRA_PROVIDER_KINDS = ["mock", "aws", "azure", "gcp"] as const;
export type InfraProviderKind = (typeof INFRA_PROVIDER_KINDS)[number];

export function isInfraProviderKind(value: string): value is InfraProviderKind {
  return (INFRA_PROVIDER_KINDS as readonly string[]).includes(value);
}

export class InfraProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const INFRA_RESOURCE_KINDS = [
  "control_plane",
  "agent_runtime",
  "cert",
  "backup_target",
] as const;
export type InfraResourceKind = (typeof INFRA_RESOURCE_KINDS)[number];

export const INFRA_FINDING_KINDS = ["drift", "cve", "cert_expiring", "backup_missed"] as const;
export type InfraFindingKind = (typeof INFRA_FINDING_KINDS)[number];

export const INFRA_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type InfraSeverity = (typeof INFRA_SEVERITIES)[number];

/** Total order on severities — the gateway's auto-remediate ceiling compares
 * against this. `critical` is the top rank and is ALWAYS approval-gated. */
export function severityRank(s: InfraSeverity): number {
  return INFRA_SEVERITIES.indexOf(s);
}

// ---------------------------------------------------------------------------
// ADR-0017 — the pure detection math. These are the exported, unit-tested
// functions the mock (and, later, the real cloud adapters) call. Keeping the
// arithmetic out of the adapters means the ladder is provable in isolation and
// the mock is a thin, deterministic shell over it.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** deterministic stable stringify for scalar/array/object values */
function stableStr(v: unknown): string {
  return JSON.stringify(v ?? null);
}

/** Certain keys are security-critical: any drift on one raises the finding to
 * high regardless of count. Deliberately DISJOINT from the mock's demo keys so
 * the demo drift ladder (config-baseline=medium, runtime-labels=low) is stable. */
const CRITICAL_DRIFT_KEYS = new Set(["encryption", "iam", "network_exposure"]);

/** compareDrift — key-diff a declared baseline against the observed config.
 * Severity by count + criticality: any critical key drifted => high; else
 * >=3 keys => high, 2 => medium, 1 => low, 0 => low (no drift). */
export function compareDrift(
  baseline: Record<string, unknown> | null | undefined,
  observed: Record<string, unknown> | null | undefined,
): { drifted: string[]; severity: InfraSeverity } {
  const b = baseline ?? {};
  const o = observed ?? {};
  const keys = new Set([...Object.keys(b), ...Object.keys(o)]);
  const drifted: string[] = [];
  for (const k of keys) {
    if (stableStr(b[k]) !== stableStr(o[k])) drifted.push(k);
  }
  drifted.sort();
  let severity: InfraSeverity;
  if (drifted.length === 0) severity = "low";
  else if (drifted.some((k) => CRITICAL_DRIFT_KEYS.has(k))) severity = "high";
  else if (drifted.length >= 3) severity = "high";
  else if (drifted.length === 2) severity = "medium";
  else severity = "low";
  return { drifted, severity };
}

/** cvssToSeverity — CVSS v3 band → our severity ladder.
 * >=9 critical, >=7 high, >=4 medium, else low. */
export function cvssToSeverity(cvss: number): InfraSeverity {
  if (cvss >= 9) return "critical";
  if (cvss >= 7) return "high";
  if (cvss >= 4) return "medium";
  return "low";
}

/** certSeverity — real date math on a cert's not-after.
 * expired (<=0 days) => critical + shouldRotate; <14 => high; <30 => medium;
 * else low. shouldRotate is true whenever inside the rotation window. */
export function certSeverity(
  notAfter: Date,
  now: Date,
  rotationWindowDays: number,
): { daysUntilExpiry: number; severity: InfraSeverity; shouldRotate: boolean } {
  const daysUntilExpiry = Math.floor((notAfter.getTime() - now.getTime()) / MS_PER_DAY);
  let severity: InfraSeverity;
  if (daysUntilExpiry <= 0) severity = "critical";
  else if (daysUntilExpiry < 14) severity = "high";
  else if (daysUntilExpiry < 30) severity = "medium";
  else severity = "low";
  const shouldRotate = daysUntilExpiry <= rotationWindowDays;
  return { daysUntilExpiry, severity, shouldRotate };
}

/** Parse a backup schedule string ("daily-0200", "weekly", "hourly", …) into a
 * cadence expressed in days. Unknown/blank defaults to daily. */
export function scheduleIntervalDays(schedule: string | null | undefined): number {
  const cadence = String(schedule ?? "daily").toLowerCase().split(/[-_ ]/)[0];
  switch (cadence) {
    case "hourly":
      return 1 / 24;
    case "weekly":
      return 7;
    case "monthly":
      return 30;
    case "daily":
    default:
      return 1;
  }
}

/** evaluateBackupSchedule — is a backup due/missed given the last successful
 * run? due at >=1 interval since last; missed at >=2 intervals; severity high
 * at >=3 intervals (or never-backed-up), medium at >=1, else low. retentionUntil
 * is now + retentionDays (the floor the §8.3 cascade may raise). */
export function evaluateBackupSchedule(
  schedule: string | null | undefined,
  lastBackupAt: Date | null | undefined,
  now: Date,
  retentionDays: number,
): { due: boolean; missed: boolean; severity: InfraSeverity; retentionUntil: Date } {
  const intervalDays = scheduleIntervalDays(schedule);
  const daysSince = lastBackupAt
    ? (now.getTime() - lastBackupAt.getTime()) / MS_PER_DAY
    : Number.POSITIVE_INFINITY;
  const due = daysSince >= intervalDays;
  const missed = daysSince >= intervalDays * 2;
  let severity: InfraSeverity;
  if (daysSince >= intervalDays * 3) severity = "high";
  else if (daysSince >= intervalDays) severity = "medium";
  else severity = "low";
  const retentionUntil = new Date(now.getTime() + retentionDays * MS_PER_DAY);
  return { due, missed, severity, retentionUntil };
}

/** What the gateway hands `scan`: an already-persisted monitored resource. */
export interface InfraResourceRef {
  id: string;
  kind: InfraResourceKind;
  name: string;
  config?: Record<string, unknown> | null;
}

/** A single inert report `scan` returns. `signature` is a STABLE natural key
 * within (resource, kind) so re-scanning is idempotent — the gateway upserts on
 * it and refreshes detected_at rather than duplicating an open finding. */
export interface InfraFindingReport {
  kind: InfraFindingKind;
  severity: InfraSeverity;
  signature: string;
  detail: Record<string, unknown>;
}

/** What the gateway hands `remediate`: an already-authorized finding. */
export interface InfraFindingRef {
  id: string;
  resourceId: string;
  kind: InfraFindingKind;
  signature: string;
  detail?: Record<string, unknown> | null;
}

/** The neutral result every remediation returns. A FAILED remediation surfaces
 * as an InfraProviderError; the gateway leaves the finding un-remediated. */
export interface InfraRemediationResult {
  ok: boolean;
  detail: Record<string, unknown>;
}

export interface InfraProvider {
  readonly kind: InfraProviderKind;
  scan(resource: InfraResourceRef): Promise<InfraFindingReport[]>;
  remediate(finding: InfraFindingRef): Promise<InfraRemediationResult>;
}

// The same injectable-fetch shape the connector/pm adapters use, so the future
// cloud adapters never touch the network in a unit test.
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

// ---------------------------------------------------------------------------
// Mock adapter — deterministic, keyless: for tests and air-gapped development.
// `scan` returns canned findings shaped by the resource kind, each carrying a
// stable signature so a re-scan is idempotent. Severity for cert/backup is
// DERIVED from the resource config so a demo can dial in the whole ladder —
// including an already-expired cert, whose `critical` finding exercises the
// always-approval-gated branch. `remediate` deterministically "succeeds" and
// records the call (like MockConnectorProvider.writes), so a test can assert
// the governed automation actually reached the provider.
// ---------------------------------------------------------------------------

const REMEDIATION_ACTION: Record<InfraFindingKind, string> = {
  drift: "re-applied configuration baseline",
  cve: "applied vendor patch",
  cert_expiring: "rotated certificate",
  backup_missed: "triggered out-of-band backup",
};

export class MockInfraProvider implements InfraProvider {
  readonly kind = "mock" as const;
  /** every remediation, in order — inspectable by tests */
  readonly remediations: Array<{ resourceId: string; kind: InfraFindingKind; signature: string }> = [];

  async scan(resource: InfraResourceRef): Promise<InfraFindingReport[]> {
    const cfg = resource.config ?? {};
    const now = new Date();
    switch (resource.kind) {
      case "control_plane": {
        // drift severity via compareDrift (a 2-key diff => medium); cve severity
        // via cvssToSeverity (7.8 => high). Both derived, never hardcoded.
        const drift = compareDrift(
          { log_retention: "30d", tls_min_version: "1.2", region: "us-east-1" },
          { log_retention: "7d", tls_min_version: "1.0", region: "us-east-1" },
        );
        const cvss = 7.8;
        return [
          {
            kind: "drift",
            severity: drift.severity,
            signature: "drift:config-baseline",
            detail: {
              signature: "drift:config-baseline",
              summary: "runtime configuration has drifted from the declared baseline",
              drifted: drift.drifted,
            },
          },
          {
            kind: "cve",
            severity: cvssToSeverity(cvss),
            signature: "cve:CVE-2026-0001",
            detail: {
              signature: "cve:CVE-2026-0001",
              cve: "CVE-2026-0001",
              summary: "a high-severity CVE affects a control-plane dependency",
              package: "libregul-core",
              installedVersion: "1.4.1",
              fixedVersion: "1.4.2",
              fixedIn: "1.4.2",
              cvss,
            },
          },
        ];
      }
      case "agent_runtime": {
        // a LOW drift (single-key diff) — the finding a permissive policy auto-remediates
        const drift = compareDrift({ labels: "declared" }, { labels: "observed" });
        return [
          {
            kind: "drift",
            severity: drift.severity,
            signature: "drift:runtime-labels",
            detail: {
              signature: "drift:runtime-labels",
              summary: "agent-runtime pod labels drifted from the declared set",
              drifted: drift.drifted,
            },
          },
        ];
      }
      case "cert": {
        const days = Number(cfg.daysUntilExpiry ?? 30);
        const notAfter = new Date(now.getTime() + days * 86_400_000);
        const rotationWindowDays = Number(cfg.rotationWindowDays ?? 30);
        const { severity, daysUntilExpiry } = certSeverity(notAfter, now, rotationWindowDays);
        const serial = `SER-${Math.abs(days)}-${resource.name}`;
        return [
          {
            kind: "cert_expiring",
            severity,
            signature: `cert_expiring:${resource.name}`,
            detail: {
              signature: `cert_expiring:${resource.name}`,
              daysUntilExpiry,
              commonName: resource.name,
              issuer: "RegulAIt-CA",
              serial,
              notAfter: notAfter.toISOString(),
              summary:
                daysUntilExpiry <= 0
                  ? "certificate has ALREADY EXPIRED — service-affecting"
                  : `certificate expires in ${daysUntilExpiry} day(s)`,
            },
          },
        ];
      }
      case "backup_target": {
        const hours = Number(cfg.hoursSinceLastBackup ?? 48);
        const lastBackupAt = new Date(now.getTime() - hours * 3_600_000);
        const retentionDays = Number(cfg.retentionDays ?? 30);
        const { severity, retentionUntil } = evaluateBackupSchedule(
          String(cfg.backupSchedule ?? "daily"),
          lastBackupAt,
          now,
          retentionDays,
        );
        return [
          {
            kind: "backup_missed",
            severity,
            signature: `backup_missed:${resource.name}`,
            detail: {
              signature: `backup_missed:${resource.name}`,
              hoursSinceLastBackup: hours,
              lastBackupAt: lastBackupAt.toISOString(),
              retentionUntil: retentionUntil.toISOString(),
              summary: `no successful backup in ${hours} hour(s)`,
            },
          },
        ];
      }
    }
  }

  async remediate(finding: InfraFindingRef): Promise<InfraRemediationResult> {
    this.remediations.push({
      resourceId: finding.resourceId,
      kind: finding.kind,
      signature: finding.signature,
    });
    return {
      ok: true,
      detail: {
        remediated: true,
        kind: finding.kind,
        signature: finding.signature,
        action: REMEDIATION_ACTION[finding.kind],
      },
    };
  }

  /** test helper: forget every recorded remediation */
  reset(): void {
    this.remediations.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface InfraProviderConfig {
  kind: InfraProviderKind;
  /** cloud endpoint / account handle; the future cloud adapters need it */
  endpoint?: string | null;
  /** bearer/credential handle; keyless kinds (mock) omit it */
  token?: string | null;
  /** aws: the customer IAM role scan/remediation assumes (BYOC boundary) */
  roleArn?: string | null;
  /** aws: the customer region every call is driven in */
  region?: string | null;
  /** aws, NEVER persisted — the injected live client (injectable-client
   * discipline, same as deploy.ts's awsLiveClient): a fake in tests, a real
   * @aws-sdk-backed impl built per the AwsInfraLiveClient factory contract in
   * a live deployment. Absent (or REGULAIT_INFRA_LIVE off) = structured 501. */
  awsLiveClient?: AwsInfraLiveClient;
}

/** validates the persisted provider config before an adapter is built
 * (awsLiveClient is injected at resolve time, never persisted — not here) */
export const infraProviderConfigSchema = z.object({
  kind: z.enum(INFRA_PROVIDER_KINDS),
  endpoint: z.string().min(1).nullable().optional(),
  token: z.string().min(1).nullable().optional(),
  roleArn: z.string().min(1).nullable().optional(),
  region: z.string().min(1).nullable().optional(),
});

/** shared mock instance so recorded remediations persist across resolutions in
 * one process (mirrors connector-provider's sharedMock) */
const sharedMock = new MockInfraProvider();

export function resolveInfraProvider(
  config: InfraProviderConfig,
  _fetchImpl?: FetchLike,
): InfraProvider {
  switch (config.kind) {
    case "mock":
      return sharedMock;
    case "aws": {
      // REAL adapter (src/aws.ts): STS AssumeRole into the customer's roleArn
      // (short-lived creds, NEVER a static key — the same no-static-keys rule
      // as apps/gateway/src/deploy.ts AwsDeployProvider), then SSM
      // DescribeInstanceInformation / patch states for drift+CVE posture, ACM
      // List/DescribeCertificate for cert expiry, AWS Backup recovery points
      // for backup verification, and governed SSM-patch / ACM-rotate /
      // Backup-start remediations in the target region. Gated twice: the
      // OFF-by-default REGULAIT_INFRA_LIVE flag AND an injected
      // AwsInfraLiveClient — either missing is a structured 501, because this
      // adapter has no dry-run (a fabricated scan would be fake data,
      // ADR-0017). Never a silent success.
      if (!infraLiveEnabled()) {
        throw new InfraProviderError(
          `infra provider kind 'aws' is implemented but not live-enabled: REGULAIT_INFRA_LIVE is off ` +
            `and the adapter has no dry-run — enable the flag and inject an AwsInfraLiveClient to go live`,
          501,
        );
      }
      if (!config.awsLiveClient) {
        throw new InfraProviderError(
          `REGULAIT_INFRA_LIVE is on but no live AWS infra client was injected — wire an AwsInfraLiveClient ` +
            `(see the factory contract in @regulait/infra-provider aws.ts) and pass it as config.awsLiveClient`,
          501,
        );
      }
      return new AwsInfraProvider({
        roleArn: config.roleArn ?? "",
        region: config.region ?? "",
        client: config.awsLiveClient,
        live: true,
      });
    }
    // Declared, interface-ready, but not built yet — an explicit failure,
    // never a silent success (the connector/model-provider discipline).
    case "azure":
    case "gcp":
      throw new InfraProviderError(
        `infra provider kind '${config.kind}' is not implemented yet`,
        501,
      );
  }
}

// The real AWS adapter + its injectable-client contract (ADR-0017 follow-through).
export * from "./aws.js";
