/**
 * Managed settings (lane UI-D, D1; ADR-0310, #850's contract): the pure part of the export page.
 *
 * A bundle compiles one user's or one role's effective MCP entitlements into vendor-native managed settings, signs
 * them, and stores a new version only when the compiled policy changed (an unchanged export answers the latest
 * version with `created: false`). Names are joined from the user and role reads, never copied onto the bundle.
 */

export type SubjectKind = "user" | "role";

export interface Bundle {
  id: string;
  subject: { kind: SubjectKind; id: string };
  version: number;
  policyDigest: string;
  keyId: string;
  serverCount: number;
  createdAt: string;
}
export interface BundlePage {
  bundles: Bundle[];
  next: string | null;
}
export type ExportResult = Bundle & { created: boolean };

/** the list's page size (the gateway caps it at 100) */
export const PAGE_SIZE = 50;

export function listPath(filter: SubjectFilter, before?: string | null): string {
  const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (filter) {
    q.set("subjectKind", filter.kind);
    q.set("subjectId", filter.id);
  }
  if (before) q.set("before", before);
  return `/v1/managed-settings/bundles?${q.toString()}`;
}
export type SubjectFilter = { kind: SubjectKind; id: string } | null;

/** "user:<id>" / "role:<id>" for one Select; "" is every subject */
export const filterValue = (f: SubjectFilter): string => (f ? `${f.kind}:${f.id}` : "");
export function parseFilter(raw: string): SubjectFilter {
  const [kind, id] = raw.split(":");
  return (kind === "user" || kind === "role") && id ? { kind, id } : null;
}

/** the archive's file name, as the gateway names it */
export const archiveName = (b: Pick<Bundle, "subject" | "version">): string =>
  `regulait-managed-settings-${b.subject.kind}-v${b.version}.tar.gz`;

/** the subject in words, from the user and role reads; a subject neither read returns is named by its kind only */
export function subjectWords(
  s: Bundle["subject"],
  names: { users: ReadonlyMap<string, string>; roles: ReadonlyMap<string, string> },
): string {
  const name = (s.kind === "user" ? names.users : names.roles).get(s.id);
  return name ? `${name} (${s.kind})` : s.kind === "user" ? "A user not in the directory" : "A role that no longer exists";
}

/** the optional Claude Code minimum version, checked as the gateway checks it. Null is valid. */
export function versionProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  return /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(v) ? null : "Use a version like 1.0.30.";
}

export function exportBody(kind: SubjectKind, id: string, minVersion: string) {
  const v = minVersion.trim();
  return { subject: { kind, id }, ...(v ? { claudeCodeMinimumVersion: v } : {}) };
}

/** the outcome line after an export */
export const resultWords = (r: Pick<ExportResult, "created" | "version">): string =>
  r.created
    ? `Version ${r.version} exported and signed.`
    : `The policy has not changed since version ${r.version}, so no new version was made. Download version ${r.version}.`;

/**
 * The export flow as one declared state (rule 12): closed → choosing → exporting → done (the result line) or back to
 * choosing on a refusal. Closing is not allowed while the request runs, so a result never arrives for a closed form.
 */
export type ExportFlow =
  | { step: "closed"; last: ExportResult | null }
  | { step: "choosing"; last: ExportResult | null }
  | { step: "exporting"; last: ExportResult | null };
export type ExportEvent = { type: "open" } | { type: "submit" } | { type: "ok"; result: ExportResult } | { type: "fail" } | { type: "close" };
export const EXPORT_IDLE: ExportFlow = { step: "closed", last: null };

export function exportReducer(s: ExportFlow, e: ExportEvent): ExportFlow {
  switch (e.type) {
    case "open":
      return s.step === "closed" ? { step: "choosing", last: s.last } : s;
    case "submit":
      return s.step === "choosing" ? { step: "exporting", last: s.last } : s;
    case "ok":
      return s.step === "exporting" ? { step: "closed", last: e.result } : s;
    case "fail":
      return s.step === "exporting" ? { step: "choosing", last: s.last } : s;
    case "close":
      return s.step === "choosing" ? { step: "closed", last: s.last } : s;
  }
}

/** why the form's buttons cannot be pressed now, or null when they can */
export const exportBlockedReason = (s: ExportFlow): string | null =>
  s.step === "exporting" ? "Exporting and signing the bundle; wait for it to finish." : null;
