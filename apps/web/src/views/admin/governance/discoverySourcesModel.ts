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
  /** fed by uploads: no schedule */
  uploadFed?: boolean;
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
  writeScope: "unverified" | "read_only" | "refused";
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
  readOutcomes?: Array<{ read: string; status: string; detail?: string }>;
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
  credentialsRefused?: SourceRef[];
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

/** public config keys RegulAIt generates (never sent back: the gateway refuses them) */
export const SERVER_GENERATED_CONFIG_KEYS: readonly string[] = ["externalId"];

/** the public config a "replace credential" form starts from: the live one without the server-generated keys */
export function editablePublicConfig(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !SERVER_GENERATED_CONFIG_KEYS.includes(k)));
}

/** "could not read: …" for every read that did not succeed, or null when all were read */
export function couldNotRead(outcomes: ReadonlyArray<{ read: string; status: string; detail?: string }> | undefined): string | null {
  const missed = (outcomes ?? []).filter((o) => o.status !== "read");
  if (missed.length === 0) return null;
  return "could not read: " + missed.map((o) => `${o.read} (${o.status.replace("_", " ")}${o.detail ? `: ${o.detail}` : ""})`).join("; ");
}

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
  public_config_refused: "That public config field is not allowed for this kind, or is not well-formed. Secrets go in the secret field (static mode).",
  credential_target_mismatch: "The credential names a different account or tenant than the source's target.",
  credential_refused: "This source's credential grants write access and is refused. Replace it with a read-only one.",
  data_key_unavailable: "The data key is not configured, so secrets cannot be stored or read.",
};

/** one sighting on a finding, as the findings API returns it */
export interface SightingView {
  source: string;
  observedAt?: string;
  location?: { path: string; line?: number; commit?: string };
  /** an MCP server's command basename; never an environment-variable name (ADR-0195 lane A6) */
  names?: string[];
  /** ADR-0195 lane A6: presence signature ids (the env-variable or CLI name itself is never kept) */
  presence?: string[];
  actor?: string;
  signatureConfidence?: "high" | "medium" | "low";
}

/** the sightings in words: at most `max`, only those with a location, names, presence ids or an actor */
export function sightingLines(evidence: readonly SightingView[] | undefined, max = 3): Array<{ text: string; actor: string | null }> {
  const out: Array<{ text: string; actor: string | null }> = [];
  for (const e of evidence ?? []) {
    const lowConfidence = e.signatureConfidence === "low" || e.signatureConfidence === "medium";
    if (!e.location && !(e.names && e.names.length) && !(e.presence && e.presence.length) && !e.actor && !lowConfidence) continue;
    const parts: string[] = [];
    if (lowConfidence) parts.push(`${e.signatureConfidence}-confidence signature`);
    if (e.location) {
      parts.push(`${e.location.path}${e.location.line ? `:${e.location.line}` : ""}${e.location.commit ? ` @${e.location.commit.slice(0, 8)}` : ""}`);
    }
    if (e.names && e.names.length) parts.push(`names: ${e.names.slice(0, 10).join(", ")}${e.names.length > 10 ? ", …" : ""}`);
    if (e.presence && e.presence.length) parts.push(`presence signatures: ${e.presence.slice(0, 10).join(", ")}${e.presence.length > 10 ? ", …" : ""}`);
    out.push({ text: parts.join(" · ") || e.source, actor: e.actor ?? null });
    if (out.length >= max) break;
  }
  return out;
}
