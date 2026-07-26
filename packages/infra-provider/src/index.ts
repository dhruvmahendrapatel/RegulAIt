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
 * interface-ready but not implemented (aws/azure/gcp) throw an explicit "not
 * implemented yet" from the registry rather than pretending.
 */

import { z } from "zod";

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
    switch (resource.kind) {
      case "control_plane":
        return [
          {
            kind: "drift",
            severity: "medium",
            signature: "drift:config-baseline",
            detail: {
              signature: "drift:config-baseline",
              summary: "runtime configuration has drifted from the declared baseline",
              drifted: ["log_retention", "tls_min_version"],
            },
          },
          {
            kind: "cve",
            severity: "high",
            signature: "cve:CVE-2026-0001",
            detail: {
              signature: "cve:CVE-2026-0001",
              cve: "CVE-2026-0001",
              summary: "a high-severity CVE affects a control-plane dependency",
              fixedIn: "1.4.2",
            },
          },
        ];
      case "agent_runtime":
        // a LOW drift — this is the finding a permissive policy auto-remediates
        return [
          {
            kind: "drift",
            severity: "low",
            signature: "drift:runtime-labels",
            detail: {
              signature: "drift:runtime-labels",
              summary: "agent-runtime pod labels drifted from the declared set",
              drifted: ["labels"],
            },
          },
        ];
      case "cert": {
        const days = Number(cfg.daysUntilExpiry ?? 30);
        const severity: InfraSeverity =
          days <= 0 ? "critical" : days < 14 ? "high" : days < 30 ? "medium" : "low";
        return [
          {
            kind: "cert_expiring",
            severity,
            signature: `cert_expiring:${resource.name}`,
            detail: {
              signature: `cert_expiring:${resource.name}`,
              daysUntilExpiry: days,
              summary:
                days <= 0
                  ? "certificate has ALREADY EXPIRED — service-affecting"
                  : `certificate expires in ${days} day(s)`,
            },
          },
        ];
      }
      case "backup_target": {
        const hours = Number(cfg.hoursSinceLastBackup ?? 48);
        const severity: InfraSeverity = hours >= 72 ? "high" : hours >= 24 ? "medium" : "low";
        return [
          {
            kind: "backup_missed",
            severity,
            signature: `backup_missed:${resource.name}`,
            detail: {
              signature: `backup_missed:${resource.name}`,
              hoursSinceLastBackup: hours,
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
}

/** validates the persisted provider config before an adapter is built */
export const infraProviderConfigSchema = z.object({
  kind: z.enum(INFRA_PROVIDER_KINDS),
  endpoint: z.string().min(1).nullable().optional(),
  token: z.string().min(1).nullable().optional(),
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
    // Declared, interface-ready, but not built yet — an explicit failure, never
    // a silent success (the connector/model-provider discipline). The real
    // adapters will take `_fetchImpl` + the cloud credential here.
    case "aws":
    case "azure":
    case "gcp":
      throw new InfraProviderError(
        `infra provider kind '${config.kind}' is not implemented yet`,
        501,
      );
  }
}
