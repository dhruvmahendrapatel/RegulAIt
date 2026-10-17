/**
 * ADR-0195 SD0 — the pure half of the Discovery sources page: the shapes the
 * gateway returns and the parsing of the page's simple text fields. No React,
 * no network, so it is unit-tested directly.
 */

export interface ScannerKindView {
  kind: string;
  label: string;
  family: "repo" | "cloud" | "endpoint";
  slice: string;
  evidenceKinds: string[];
  subjectKinds: string[];
  built: boolean;
  requiresCredential: boolean | null;
}

export interface DiscoveryCredentialView {
  id: string;
  mode: "federated" | "static";
  publicConfig: Record<string, string>;
  hasSecret: boolean;
  writeScope: "unverified" | "read_only";
  createdAt: string;
  ageDays: number;
  ageWarning: boolean;
}

export interface DiscoveryRunView {
  id: string;
  sourceId: string;
  kind: string;
  trigger: "schedule" | "manual";
  status: "queued" | "running" | "succeeded" | "failed";
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  observed: number;
  matched: number;
  findingsCreated: number;
  findingsUpdated: number;
  catalogueGaps: Array<{ kind: string; value: string }>;
  rawOutputSha256: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: string;
}

export interface DiscoveryScope {
  orgLevel: boolean;
  include: string[];
}

export interface DiscoverySourceView {
  id: string;
  name: string;
  kind: string;
  target: Record<string, string>;
  scope: DiscoveryScope;
  enabled: boolean;
  scheduleIntervalSeconds: number;
  version: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  scannerBuilt: boolean;
  credential: DiscoveryCredentialView | null;
  lastRun: DiscoveryRunView | null;
}

interface SourceRef {
  sourceId: string;
  name: string;
  kind: string;
}

export interface DiscoveryPostureView {
  sourcesTotal: number;
  sourcesEnabled: SourceRef[];
  staticCredentials: Array<SourceRef & { ageDays: number }>;
  staleCredentials: Array<SourceRef & { ageDays: number }>;
  writeScopeUnverified: SourceRef[];
  credentialWarningAgeDays: number;
  endpointRetentionDays: number;
  statement: string;
}

export interface DiscoverySettingsView {
  credentialWarningAgeDays: number;
  endpointRetentionDays: number;
  version: number;
}

/** `key=value` lines → an object; null with the first problem when a line is not one */
export function parseKeyValueLines(text: string): { value: Record<string, string> } | { error: string } {
  const out: Record<string, string> = {};
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  for (const line of lines) {
    const at = line.indexOf("=");
    if (at <= 0) return { error: `"${line.slice(0, 40)}" is not key=value` };
    const key = line.slice(0, at).trim();
    const val = line.slice(at + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) return { error: `"${key.slice(0, 40)}" is not a valid field name (letters, digits, _)` };
    if (!val) return { error: `${key} has no value` };
    if (key in out) return { error: `${key} is given twice` };
    out[key] = val;
  }
  return { value: out };
}

/** one name per line (or comma-separated) → the scope's include list, de-duplicated */
export function parseIncludeList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const item = raw.trim();
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    out.push(item);
  }
  return out;
}

export const formatKeyValues = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

/** the scope in words */
export function describeScope(scope: DiscoveryScope): string {
  if (scope.orgLevel) return "organisation-level (everything the target holds)";
  if (scope.include.length <= 3) return scope.include.join(", ");
  return `${scope.include.slice(0, 3).join(", ")} and ${scope.include.length - 3} more`;
}

/** does the new scope cover anything the old one did not? (mirrors the gateway's `scopeWidens`) */
export function scopeWidens(prev: DiscoveryScope, next: DiscoveryScope): boolean {
  if (next.orgLevel) return !prev.orgLevel;
  if (prev.orgLevel) return false;
  const had = new Set(prev.include.map((x) => x.trim().toLowerCase()));
  return next.include.some((x) => !had.has(x.trim().toLowerCase()));
}

/** the schedule in words */
export function describeSchedule(seconds: number): string {
  if (seconds % 86400 === 0) return seconds === 86400 ? "daily" : `every ${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "hourly" : `every ${seconds / 3600} hours`;
  return `every ${Math.round(seconds / 60)} minutes`;
}

/** the gateway's refusal codes in the page's words */
export const DISCOVERY_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  scanner_not_built: "No scanner is built for this kind yet.",
  version_conflict: "This changed since you loaded it. Reload and repeat the change.",
  credential_conflict: "The credential changed since you loaded it. Reload and try again.",
  credential_missing: "Store a credential for this source first.",
  disable_first: "Disable the source before deleting it.",
  run_in_progress: "A scan is still running. Delete the source once it finishes.",
  run_already_queued: "A scan of this source is already queued or running.",
  source_disabled: "Enable the source before running it.",
  name_taken: "Another source already has that name.",
  public_config_secret_shaped: "A public config field looks like a secret. Put secrets in the secret field (static mode).",
  data_key_unavailable: "The data key is not configured, so secrets cannot be stored or read.",
};
