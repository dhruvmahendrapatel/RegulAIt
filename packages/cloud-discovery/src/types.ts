/**
 * ADR-0195 SD2: the cloud scanner contract.
 *
 * One `CloudScanner` interface with an AWS, a GCP and an Azure adapter (decision 16). Every adapter lists AI
 * services only, reads nothing but inventory and audit metadata, and never writes to the scanned account
 * (decision 1). Each run returns two things:
 *
 *  - `observations`: what it saw, as subject kinds `cloud_resource` and `cloud_principal` (rule 5a). An observation
 *    is not a finding. It becomes one only when SD0's matcher finds an enabled `cloud_ai_service` signature whose
 *    value equals `serviceKey` (rule 5; equality, never a regex).
 *  - `capabilities`: one row per thing the adapter tried to read, saying whether it could. "Could not read" is
 *    reported as such, never as "found nothing" (decision 16: "the scanner reports which of these it could read").
 *
 * Data minimisation (rule 6): no prompt or response content, no request bodies and no secrets are kept. Calling
 * principals are pseudonymised through the injected `pseudonymise` hook (rule 20) before they reach an observation;
 * the raw identifier is handed only to that hook.
 */

export type CloudProvider = "aws" | "gcp" | "azure";

/** rule 5a signal sources a cloud scan can produce */
export type CloudSignalSource = "cloud_inventory" | "cloud_audit_log";

/** rule 5a subject kinds a cloud scan can produce */
export type CloudSubjectKind = "cloud_resource" | "cloud_principal";

/**
 * What happened when the adapter tried to read one thing.
 *
 * - `read`: the call succeeded (possibly with zero items).
 * - `denied`: the cloud refused the caller (missing permission). The published permission set fixes it.
 * - `not_enabled`: the data source exists but is switched off in the customer's account (for example GCP Data
 *   Access audit logs, or no trail bucket configured for AWS data events).
 * - `unreachable`: the egress guard refused the host, or the network failed. In air-gapped mode with no private
 *   endpoint this is the honest state (decision 10).
 * - `skipped`: not attempted, with the reason (for example "no Log Analytics workspace configured").
 * - `error`: anything else, with a redacted message.
 */
export type CapabilityStatus = "read" | "denied" | "not_enabled" | "unreachable" | "skipped" | "error";

export interface CapabilityReport {
  /** stable id, e.g. `aws.bedrock.custom_models` */
  capability: string;
  /** region, project, subscription or workspace the read was for; null for account-wide reads */
  scope: string | null;
  status: CapabilityStatus;
  /** number of items read (only for `read`) */
  items?: number;
  /** a short, secret-free explanation */
  detail?: string;
}

export interface CloudObservation {
  provider: CloudProvider;
  subjectKind: CloudSubjectKind;
  /**
   * The subject. For `cloud_resource`, the resource's cloud identifier (an ARN, a GCP resource name or an Azure
   * resource id). For `cloud_principal`, the PSEUDONYM returned by the hook, never the raw identifier.
   */
  subject: string;
  /** the `cloud_ai_service` signature value this observation would match, e.g. `aws:bedrock` */
  serviceKey: string;
  signalSource: CloudSignalSource;
  /** e.g. `bedrock.custom_model`, `vertex.endpoint`, `cognitive_services.deployment`, `principal` */
  resourceType: string;
  /** region, location or `global` */
  location: string | null;
  /** account id, project id or subscription id the subject lives in */
  container: string;
  /** audit-log observations: how many calls were seen in the window */
  callCount?: number;
  /** audit-log observations: which operations were called (event names, method names) */
  operations?: string[];
  firstSeen?: string;
  lastSeen?: string;
  /** a few non-secret attributes (kind, sku, model family). Never content, never a credential. */
  attributes?: Record<string, string>;
}

export interface CloudScanResult {
  provider: CloudProvider;
  observations: CloudObservation[];
  capabilities: CapabilityReport[];
  /** SHA-256 over the canonical observation list (rule 6: raw output is digested, then discarded) */
  digest: string;
  startedAt: string;
  finishedAt: string;
}

/** the identity a principal pseudonym is derived from; the hook stores the display name encrypted (rule 20) */
export interface PrincipalRef {
  provider: CloudProvider;
  /** e.g. an IAM role ARN, a service-account email, an Entra object id or UPN */
  rawIdentifier: string;
}

/** SD0 supplies this: keyed hash per tenant (ADR-0193 pattern); the raw identifier never leaves the hook */
export type PrincipalPseudonymiser = (principal: PrincipalRef) => Promise<string>;

export interface CloudScanContext {
  /** the clock the scan window is measured from (tests inject one) */
  now: Date;
  /** how far back audit logs are read; AWS LookupEvents itself stops at 90 days */
  auditLookbackDays: number;
  pseudonymise: PrincipalPseudonymiser;
  /** an upper bound on pages per list call, so one huge account cannot stall a run */
  maxPagesPerCall: number;
  signal?: AbortSignal;
}

export interface CloudScanner {
  readonly provider: CloudProvider;
  scan(ctx: CloudScanContext): Promise<CloudScanResult>;
}

export const DEFAULT_AUDIT_LOOKBACK_DAYS = 30;
export const MAX_AUDIT_LOOKBACK_DAYS = 90;
export const DEFAULT_MAX_PAGES_PER_CALL = 20;
