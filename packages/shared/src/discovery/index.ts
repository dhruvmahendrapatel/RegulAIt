/**
 * ADR-0195 SD0: the shadow-AI active discovery vocabulary, shared by the
 * migration's CHECKs (through `packages/db/src/schema.ts`), the gateway and
 * the web app. Pure constants and functions: no database, no network.
 *
 * A DISCOVERY SOURCE is one admin-configured place RegulAIt may scan
 * read-only (a source-control organisation, a cloud account, an endpoint
 * fleet). It is off until an admin enables it (a `settings_relax` step-up).
 * A scanner for its kind must be registered in the gateway (SD1 to SD4 add
 * them). An observation becomes a finding only when it matches an enabled
 * admin catalogue row (detection is data, ADR-0083 §3), and matched
 * observations go into `shadow_ai_findings` through the same merge-by-usage
 * path as evidence imports, under one of the evidence kinds below.
 */

/** every kind of discovery source (migration 0202 `discovery_sources_kind_check`) */
export const DISCOVERY_SOURCE_KINDS = [
  "repo_github",
  "repo_gitlab",
  "repo_bitbucket",
  "repo_azure_devops",
  "cloud_aws",
  "cloud_gcp",
  "cloud_azure",
  "endpoint_osquery",
  "endpoint_inventory",
  "endpoint_agent",
] as const;
export type DiscoverySourceKind = (typeof DISCOVERY_SOURCE_KINDS)[number];

/** the evidence kinds a scanner may report under (ADR-0195 decision 5a); also values of `shadow_ai_imports.kind` */
export const DISCOVERY_EVIDENCE_KINDS = [
  "repo_scan",
  "cloud_inventory",
  "cloud_audit_log",
  "endpoint_osquery",
  "endpoint_inventory",
  "endpoint_agent",
] as const;
export type DiscoveryEvidenceKind = (typeof DISCOVERY_EVIDENCE_KINDS)[number];

/** what a finding of each source family is about, in `shadow_ai_findings.subject_kind` terms */
export type DiscoverySubjectKind = "repo" | "cloud_resource" | "cloud_principal" | "device";

export interface DiscoveryKindSpec {
  family: "repo" | "cloud" | "endpoint";
  /** the evidence kinds a scanner of this kind may report under; anything else is refused */
  evidenceKinds: readonly DiscoveryEvidenceKind[];
  /** the subject kinds a scanner of this kind may report; anything else is refused */
  subjectKinds: readonly DiscoverySubjectKind[];
  /** the slice that builds its scanner (ADR-0195 "Slices") */
  slice: "SD1" | "SD2" | "SD3" | "SD4";
  label: string;
}

const REPO: Pick<DiscoveryKindSpec, "family" | "evidenceKinds" | "subjectKinds" | "slice"> = {
  family: "repo",
  evidenceKinds: ["repo_scan"],
  subjectKinds: ["repo"],
  slice: "SD1",
};
const CLOUD: Pick<DiscoveryKindSpec, "family" | "evidenceKinds" | "subjectKinds" | "slice"> = {
  family: "cloud",
  evidenceKinds: ["cloud_inventory", "cloud_audit_log"],
  subjectKinds: ["cloud_resource", "cloud_principal"],
  slice: "SD2",
};

export const DISCOVERY_KIND_SPECS: Readonly<Record<DiscoverySourceKind, DiscoveryKindSpec>> = Object.freeze({
  repo_github: { ...REPO, label: "GitHub repositories" },
  repo_gitlab: { ...REPO, label: "GitLab repositories" },
  repo_bitbucket: { ...REPO, label: "Bitbucket repositories" },
  repo_azure_devops: { ...REPO, label: "Azure DevOps repositories" },
  cloud_aws: { ...CLOUD, label: "AWS" },
  cloud_gcp: { ...CLOUD, label: "GCP" },
  cloud_azure: { ...CLOUD, label: "Azure" },
  endpoint_osquery: { family: "endpoint", evidenceKinds: ["endpoint_osquery"], subjectKinds: ["device"], slice: "SD3", label: "osquery results (no agent)" },
  endpoint_inventory: { family: "endpoint", evidenceKinds: ["endpoint_inventory"], subjectKinds: ["device"], slice: "SD3", label: "MDM or EDR inventory (no agent)" },
  endpoint_agent: { family: "endpoint", evidenceKinds: ["endpoint_agent"], subjectKinds: ["device"], slice: "SD4", label: "RegulAIt endpoint agent" },
});

/** federated (short-lived, the default, free) or static (a stored secret: a `settings_relax` step-up) */
export const DISCOVERY_CREDENTIAL_MODES = ["federated", "static"] as const;
export type DiscoveryCredentialMode = (typeof DISCOVERY_CREDENTIAL_MODES)[number];

/** the write-scope state of a source's credential (ADR-0195 decision 7); a credential WITH write scope is refused */
export const DISCOVERY_WRITE_SCOPE_STATES = ["unverified", "read_only"] as const;
export type DiscoveryWriteScopeState = (typeof DISCOVERY_WRITE_SCOPE_STATES)[number];

export const DISCOVERY_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type DiscoveryRunStatus = (typeof DISCOVERY_RUN_STATUSES)[number];

export const DISCOVERY_RUN_TRIGGERS = ["schedule", "manual"] as const;
export type DiscoveryRunTrigger = (typeof DISCOVERY_RUN_TRIGGERS)[number];

/** schedule bounds in seconds: hourly at the shortest, 30 days at the longest; default daily (ADR-0195 decision 9) */
export const DISCOVERY_SCHEDULE_MIN_SECONDS = 3600;
export const DISCOVERY_SCHEDULE_MAX_SECONDS = 30 * 86400;
export const DISCOVERY_SCHEDULE_DEFAULT_SECONDS = 86400;

/** the static-credential age warning (ADR-0195 decision 3): 90 days by default; a longer age is a relaxation */
export const DISCOVERY_CREDENTIAL_WARNING_DEFAULT_DAYS = 90;
export const DISCOVERY_CREDENTIAL_WARNING_MIN_DAYS = 1;
export const DISCOVERY_CREDENTIAL_WARNING_MAX_DAYS = 365;

/** the endpoint evidence retention (ADR-0195 decision 20): 90 days by default; a longer retention is a relaxation */
export const DISCOVERY_ENDPOINT_RETENTION_DEFAULT_DAYS = 90;
export const DISCOVERY_ENDPOINT_RETENTION_MIN_DAYS = 1;
export const DISCOVERY_ENDPOINT_RETENTION_MAX_DAYS = 3650;

/** a run is attempted at most this many times; a lease that lapses on the last attempt fails the run */
export const DISCOVERY_RUN_MAX_ATTEMPTS = 3;

/** the pseudonymised kinds of person a scanner may name (ADR-0195 decision 20) */
export const DISCOVERY_PSEUDONYM_KINDS = ["device_user", "commit_author", "cloud_principal"] as const;
export type DiscoveryPseudonymKind = (typeof DISCOVERY_PSEUDONYM_KINDS)[number];
/** a pseudonym as shown in findings: `psn:` + 24 hex characters of the per-tenant HMAC */
export const DISCOVERY_PSEUDONYM_PREFIX = "psn:";

/** the `settings_relax` step-up facts keys this feature binds */
export const DISCOVERY_STEP_UP_KEYS = Object.freeze({
  /** enabling a source, or widening an enabled source's target or scope (bound to kind, target and scope) */
  enable: "discoverySourceEnabled",
  /** storing a static credential */
  staticCredential: "discoveryStaticCredential",
  /** lengthening the static-credential warning age */
  warningAge: "discoveryCredentialWarningAgeDays",
  /** lengthening the endpoint evidence retention */
  retention: "discoveryEndpointRetentionDays",
  /** revealing a pseudonymised display name */
  reveal: "discoveryPseudonymReveal",
});

/**
 * A source's scope (ADR-0195 decision 1): an organisation-level scope (everything
 * the target holds: an AWS Organization, a GCP organization or folder, an Azure
 * management group, a whole source-control organisation), or a named list (repos,
 * accounts, projects, subscriptions, regions). Widening it is a step-up;
 * narrowing it is free.
 */
export interface DiscoveryScope {
  orgLevel: boolean;
  include: string[];
}

/** does `next` cover anything `prev` did not? (org-level is wider than any list; a new name widens) */
export function scopeWidens(prev: DiscoveryScope, next: DiscoveryScope): boolean {
  if (next.orgLevel) return !prev.orgLevel;
  if (prev.orgLevel) return false;
  const had = new Set(prev.include.map((x) => x.trim().toLowerCase()));
  return next.include.some((x) => !had.has(x.trim().toLowerCase()));
}

/** an enabled active discovery source, as the posture sentences name it */
export interface ActiveDiscoverySource {
  name: string;
  kind: DiscoverySourceKind;
}

/**
 * ADR-0195 decision 5b: the posture sentence about active discovery that every
 * shadow-AI and MCP-discovery posture carries. With no source enabled it says
 * nothing is scanned; otherwise it names each enabled source.
 */
export function activeDiscoveryPosture(active: readonly ActiveDiscoverySource[]): string {
  if (active.length === 0) {
    return "No active discovery source is enabled, so nothing is scanned: regulAIt reaches out to no repository, cloud account or device.";
  }
  const shown = active.slice(0, 20).map((a) => `${a.name} (${DISCOVERY_KIND_SPECS[a.kind].label})`);
  const more = active.length > shown.length ? `, and ${active.length - shown.length} more` : "";
  return (
    `Active discovery scans ${active.length} enabled source(s), read-only: ${shown.join(", ")}${more}. ` +
    "Nothing outside those sources is scanned."
  );
}
