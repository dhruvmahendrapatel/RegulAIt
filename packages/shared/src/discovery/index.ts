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
import { federationUnsupportedReason } from "./federation.js";

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
  // ADR-0218 (P9): the wider sources, each family behind its own default-off org switch
  "saas_inventory_api",
  "idp_entra",
  "ml_mlflow",
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
  // ADR-0218: a SaaS app inventory read, an identity-provider app consent, a standalone ML platform's inventory
  "saas_inventory",
  "idp_app_grant",
  "ml_platform_inventory",
] as const;
export type DiscoveryEvidenceKind = (typeof DISCOVERY_EVIDENCE_KINDS)[number];

/** what a finding of each source family is about, in `shadow_ai_findings.subject_kind` terms */
export type DiscoverySubjectKind = "repo" | "cloud_resource" | "cloud_principal" | "device" | "saas_app" | "system";

export const DISCOVERY_SOURCE_FAMILIES = ["repo", "cloud", "endpoint", "saas", "identity", "ml_platform"] as const;
export type DiscoverySourceFamily = (typeof DISCOVERY_SOURCE_FAMILIES)[number];

/**
 * ADR-0218: the source families added after ADR-0195, each behind a default-off org switch
 * (`discovery_settings.<family>_sources_enabled`). Turning one on is a `settings_relax` step-up; turning it off is
 * free and stops every run of that family at once (the worker and the routes refuse it). The ADR-0195 families
 * (repo, cloud, endpoint) have no switch: each of their sources is already off until an admin enables it.
 */
export const DISCOVERY_GATED_FAMILIES = ["saas", "identity", "ml_platform"] as const;
export type DiscoveryGatedFamily = (typeof DISCOVERY_GATED_FAMILIES)[number];
export const isGatedFamily = (f: DiscoverySourceFamily): f is DiscoveryGatedFamily =>
  (DISCOVERY_GATED_FAMILIES as readonly string[]).includes(f);
/** the switch states, all off by default */
export type DiscoveryFamilySwitches = Readonly<Record<DiscoveryGatedFamily, boolean>>;
export const DISCOVERY_FAMILY_SWITCHES_DEFAULT: DiscoveryFamilySwitches = Object.freeze({ saas: false, identity: false, ml_platform: false });
export const DISCOVERY_FAMILY_LABELS: Readonly<Record<DiscoveryGatedFamily, string>> = Object.freeze({
  saas: "SaaS app inventories",
  identity: "Identity-provider app consents",
  ml_platform: "Standalone ML platforms",
});

/** null when a source of this kind may be created, enabled or run under these switches; else why not */
export function familySwitchProblem(kind: DiscoverySourceKind, switches: DiscoveryFamilySwitches): string | null {
  const family = DISCOVERY_KIND_SPECS[kind].family;
  if (!isGatedFamily(family) || switches[family]) return null;
  return `${DISCOVERY_FAMILY_LABELS[family]} are switched off for this organisation; an admin turns them on under Discovery sources, Settings (confirmed with a step-up)`;
}

export interface DiscoveryKindSpec {
  family: DiscoverySourceFamily;
  /** the evidence kinds a scanner of this kind may report under; anything else is refused */
  evidenceKinds: readonly DiscoveryEvidenceKind[];
  /** the subject kinds a scanner of this kind may report; anything else is refused */
  subjectKinds: readonly DiscoverySubjectKind[];
  /** the slice that builds its scanner (ADR-0195 "Slices") */
  slice: "SD1" | "SD2" | "SD3" | "SD4" | "P9";
  label: string;
  /** fed by uploads, not by a schedule: the worker never queues a scheduled run for it, and the UI asks no schedule */
  uploadFed?: boolean;
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
  endpoint_osquery: { family: "endpoint", evidenceKinds: ["endpoint_osquery"], subjectKinds: ["device"], slice: "SD3", label: "osquery results (no agent)", uploadFed: true },
  endpoint_inventory: { family: "endpoint", evidenceKinds: ["endpoint_inventory"], subjectKinds: ["device"], slice: "SD3", label: "MDM or EDR inventory (no agent)", uploadFed: true },
  // SD4b: fed by the agents' signed uploads (endpoint-agent-routes.ts); RegulAIt never contacts a device, so never scheduled
  endpoint_agent: { family: "endpoint", evidenceKinds: ["endpoint_agent"], subjectKinds: ["device"], slice: "SD4", label: "regulAIt endpoint agent", uploadFed: true },
  // ADR-0218 (P9)
  saas_inventory_api: { family: "saas", evidenceKinds: ["saas_inventory"], subjectKinds: ["saas_app"], slice: "P9", label: "SaaS app inventory (JSON API)" },
  idp_entra: { family: "identity", evidenceKinds: ["idp_app_grant"], subjectKinds: ["saas_app"], slice: "P9", label: "Microsoft Entra ID app consents" },
  ml_mlflow: { family: "ml_platform", evidenceKinds: ["ml_platform_inventory"], subjectKinds: ["system"], slice: "P9", label: "MLflow-compatible ML platform" },
});

/** federated (short-lived, the default, free) or static (a stored secret: a `settings_relax` step-up) */
export const DISCOVERY_CREDENTIAL_MODES = ["federated", "static"] as const;
export type DiscoveryCredentialMode = (typeof DISCOVERY_CREDENTIAL_MODES)[number];

/**
 * The write-scope state of a source's credential (ADR-0195 decision 7). `refused`: a scanner found it grants write
 * access; it is never used again, and the source cannot be enabled or run until the credential is replaced.
 */
export const DISCOVERY_WRITE_SCOPE_STATES = ["unverified", "read_only", "refused"] as const;
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
export const DISCOVERY_PSEUDONYM_KINDS = ["device_user", "commit_author", "cloud_principal", "device", "idp_user"] as const;
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
  /** ADR-0218: turning a wider-source family on (bound to the families being turned on) */
  families: "discoveryWiderSourceFamilies",
});
// revealing a pseudonymised name is NOT a settings relaxation: it is the `pseudonym_reveal` step-up kind

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
    return "No active discovery source is enabled, so nothing is scanned: regulAIt reaches out to no repository, cloud account, identity provider, SaaS inventory, ML platform or device.";
  }
  const shown = active.slice(0, 20).map((a) => `${a.name} (${DISCOVERY_KIND_SPECS[a.kind].label})`);
  const more = active.length > shown.length ? `, and ${active.length - shown.length} more` : "";
  return (
    `Active discovery scans ${active.length} enabled ${active.length === 1 ? "source" : "sources"}, read-only: ${shown.join(", ")}${more}. ` +
    "Nothing outside those sources is scanned."
  );
}

// ---------------------------------------------------------------------------
// credential public config: a per-kind, per-mode ALLOWLIST (review of #403)
// ---------------------------------------------------------------------------

/**
 * The shape of one public config value. Each is a short, linear check (no
 * nested quantifier, bounded classes): public config is returned to admins, so
 * only identifiers of a known form are accepted, and anything that could carry
 * a secret is refused.
 */
export type PublicConfigShape = "numeric_id" | "guid" | "aws_role_arn" | "gcp_id" | "gcp_sa_email" | "https_url" | "header_name";

const SHAPE_PATTERNS: Readonly<Record<Exclude<PublicConfigShape, "https_url">, RegExp>> = {
  numeric_id: /^[0-9]{1,20}$/,
  guid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  aws_role_arn: /^arn:aws[a-z-]{0,20}:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/,
  gcp_id: /^[a-z][a-z0-9-]{3,62}$/,
  gcp_sa_email: /^[a-z][a-z0-9-]{4,29}@[a-z][a-z0-9-]{4,29}\.iam\.gserviceaccount\.com$/,
  // ADR-0218: the HTTP header a static API token is sent in (a header name, never a value)
  header_name: /^[A-Za-z][A-Za-z0-9-]{0,63}$/,
};

export function publicConfigShapeOk(shape: PublicConfigShape, value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false;
  if (shape !== "https_url") return SHAPE_PATTERNS[shape].test(value);
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  // an audience: https, no credentials, no query or fragment (where a token could ride)
  return u.protocol === "https:" && u.username === "" && u.password === "" && u.search === "" && u.hash === "";
}

export interface PublicConfigField {
  shape: PublicConfigShape;
  required: boolean;
}
type ConfigSpec = Readonly<Record<string, PublicConfigField>>;

/**
 * Which public config keys each kind accepts, per credential mode. Everything
 * else is refused. A static credential's secret goes in `secret` only. The AWS
 * `externalId` is generated by RegulAIt and is never accepted from a request.
 */
export const DISCOVERY_PUBLIC_CONFIG: Readonly<Record<DiscoverySourceKind, Readonly<Record<DiscoveryCredentialMode, ConfigSpec>>>> = Object.freeze({
  repo_github: {
    federated: { appId: { shape: "numeric_id", required: true }, installationId: { shape: "numeric_id", required: true } },
    static: {},
  },
  // ADR-0195 A5: GitLab and Bitbucket take no external OIDC token, so a federated credential is refused for them
  // (`federationUnsupportedReason`); their stored read-only token is the explicit fallback
  repo_gitlab: { federated: {}, static: {} },
  repo_bitbucket: { federated: {}, static: {} },
  repo_azure_devops: {
    federated: { tenantId: { shape: "guid", required: true }, clientId: { shape: "guid", required: true } },
    static: {},
  },
  cloud_aws: { federated: { roleArn: { shape: "aws_role_arn", required: true } }, static: {} },
  cloud_gcp: {
    federated: {
      projectNumber: { shape: "numeric_id", required: true },
      workloadIdentityPool: { shape: "gcp_id", required: true },
      workloadIdentityProvider: { shape: "gcp_id", required: true },
      serviceAccountEmail: { shape: "gcp_sa_email", required: true },
    },
    static: {},
  },
  cloud_azure: {
    federated: { tenantId: { shape: "guid", required: true }, clientId: { shape: "guid", required: true } },
    static: { tenantId: { shape: "guid", required: true }, clientId: { shape: "guid", required: true } },
  },
  endpoint_osquery: { federated: {}, static: {} },
  endpoint_inventory: { federated: {}, static: {} },
  endpoint_agent: { federated: {}, static: {} },
  // ADR-0218: a SaaS inventory API and an MLflow-compatible platform take a stored read-only token only (neither
  // accepts an external OIDC token); `authHeader` names the header it goes in (default Authorization: Bearer)
  saas_inventory_api: { federated: {}, static: { authHeader: { shape: "header_name", required: false } } },
  idp_entra: {
    federated: { tenantId: { shape: "guid", required: true }, clientId: { shape: "guid", required: true } },
    static: { tenantId: { shape: "guid", required: true }, clientId: { shape: "guid", required: true } },
  },
  ml_mlflow: { federated: {}, static: { authHeader: { shape: "header_name", required: false } } },
});

/** null when `config` is exactly an allowed, well-formed public config for this kind and mode; else the problem */
export function publicConfigProblem(kind: DiscoverySourceKind, mode: DiscoveryCredentialMode, config: Readonly<Record<string, string>>): string | null {
  if (mode === "federated") {
    const unsupported = federationUnsupportedReason(kind);
    if (unsupported) return unsupported;
  }
  const spec = DISCOVERY_PUBLIC_CONFIG[kind][mode];
  for (const key of Object.keys(config)) {
    // own keys only: `constructor`, `__proto__` or `toString` are unknown fields, never the prototype's
    const field = Object.hasOwn(spec, key) ? spec[key] : undefined;
    if (!field) {
      const allowed = Object.keys(spec);
      return `'${key.slice(0, 40)}' is not a public config field of a ${mode} ${kind} credential (allowed: ${allowed.length ? allowed.join(", ") : "none"}); a secret belongs in the static credential's secret`;
    }
    if (!publicConfigShapeOk(field.shape, config[key]!)) return `'${key}' is not a valid ${field.shape}`;
  }
  for (const [key, field] of Object.entries(spec)) {
    if (field.required && !(key in config)) return `'${key}' is required for a ${mode} ${kind} credential`;
  }
  return null;
}

/**
 * Does a credential's own account or tenant match the source's target?
 * `match`/`mismatch` when both sides name it; `unverifiable` otherwise (then
 * storing or replacing a credential on an ENABLED source is the enable step-up).
 */
export function credentialTargetMatch(
  kind: DiscoverySourceKind,
  target: Readonly<Record<string, unknown>>,
  config: Readonly<Record<string, string>>,
): "match" | "mismatch" | "unverifiable" {
  const t = (k: string) => (typeof target[k] === "string" ? (target[k] as string).trim().toLowerCase() : null);
  if (kind === "cloud_aws" && config.roleArn) {
    const want = t("accountId");
    if (!want) return "unverifiable";
    return (config.roleArn.split(":")[4] ?? "") === want ? "match" : "mismatch";
  }
  if (kind === "cloud_gcp" && config.serviceAccountEmail) {
    // ADR-0195 SD2: the impersonated service account's home project (`name@<project>.iam.gserviceaccount.com`).
    // A match is certain; a different project is NOT a mismatch, because a central project may hold the service
    // account and the pool while it reads other projects. So: match, or unverifiable.
    const want = t("projectId");
    const SUFFIX = ".iam.gserviceaccount.com";
    const domain = config.serviceAccountEmail.toLowerCase().split("@")[1] ?? "";
    // only a real service-account address names a project: the domain must be exactly <project> + the suffix
    if (!domain.endsWith(SUFFIX)) return "unverifiable";
    const home = domain.slice(0, -SUFFIX.length);
    return want && home.length > 0 && !home.includes(".") && home === want ? "match" : "unverifiable";
  }
  if ((kind === "cloud_azure" || kind === "repo_azure_devops" || kind === "idp_entra") && config.tenantId) {
    const want = t("tenantId");
    if (!want) return "unverifiable";
    return config.tenantId.toLowerCase() === want ? "match" : "mismatch";
  }
  return "unverifiable";
}

/** a subject that names a person (or a device) must be a pseudonym (ADR-0195 decision 20) */
export const DISCOVERY_PSEUDONYM_PATTERN = /^psn:[0-9a-f]{24}$/;
/** the source kinds fed by uploads (no schedule) */
export const UPLOAD_FED_SOURCE_KINDS: readonly DiscoverySourceKind[] = DISCOVERY_SOURCE_KINDS.filter((k) => DISCOVERY_KIND_SPECS[k].uploadFed === true);
export const PSEUDONYMISED_SUBJECT_KINDS: readonly DiscoverySubjectKind[] = ["cloud_principal", "device"];

/** one read a scanner attempted (SD2: which logs or APIs it could read), shown per run */
export const DISCOVERY_READ_STATUSES = ["read", "denied", "not_enabled", "unreachable", "skipped", "error"] as const;
export type DiscoveryReadStatus = (typeof DISCOVERY_READ_STATUSES)[number];
export interface DiscoveryReadOutcome {
  read: string;
  status: DiscoveryReadStatus;
  detail?: string;
}
export const DISCOVERY_READ_OUTCOMES_MAX = 100;

// ADR-0195 SD2b: the cloud workload identity federation issuer (RS256 keys, JWKS, per-target audiences)
export * from "./federation.js";
// ADR-0195 lane A6: env-variable-name and CLI presence signatures (pending the admin-catalogue migration)
export * from "./presence-signatures.js";
