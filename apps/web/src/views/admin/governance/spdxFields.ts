/**
 * ADR-0189 slice B9 (OWNER DECISION 13, amendment R51): the browser half of the
 * supplier-declared SPDX 3.0.1 fields of a model card or a dataset version.
 *
 * The gateway is the authority: `@regulait/shared`'s `normaliseSpdxDeclaration`
 * refuses a bad value and the migration's CHECKs refuse it again. This file
 * repeats the same rules as HINTS so a person learns before sending that a
 * value will be refused, and it never accepts anything the gateway would
 * refuse. It cannot see the audit scrubber's credential patterns, so a
 * credential-shaped text still reaches the gateway and is refused there.
 *
 * Every message here names the property and the rule, NEVER the value: a value
 * that was refused may be exactly what should not be shown again (R51).
 *
 * Regexes are anchored and flat (M-074: linear on caller input).
 */
import { ApiError } from "../../../api/client";

export const SPDX_SUBJECT_KINDS = ["model_card", "training_dataset", "eval_dataset"] as const;
export type SpdxSubjectKind = (typeof SPDX_SUBJECT_KINDS)[number];

export const SPDX_PROPERTIES = ["releaseTime", "downloadLocation", "packageVersion", "builtTime", "originatedBy", "datasetType"] as const;
export type SpdxProperty = (typeof SPDX_PROPERTIES)[number];

export const SPDX_SOURCES = ["supplier_declared", "admin_entered"] as const;
export type SpdxSource = (typeof SPDX_SOURCES)[number];

/** R51: what each subject kind declares, in the order the gateway lists them */
export const SPDX_SUBJECT_PROPERTIES: Readonly<Record<SpdxSubjectKind, readonly SpdxProperty[]>> = {
  model_card: ["releaseTime", "downloadLocation", "packageVersion"],
  training_dataset: ["builtTime", "originatedBy", "releaseTime", "downloadLocation", "datasetType"],
  eval_dataset: ["builtTime", "originatedBy", "releaseTime", "downloadLocation", "datasetType"],
};

/** SPDX 3.0.1 `dataset_DatasetType` vocabulary (the gateway's SPDX_DATASET_TYPES) */
export const SPDX_DATASET_TYPES = [
  "audio", "categorical", "graph", "image", "noAssertion", "numeric", "other", "sensor", "structured", "syntactic", "text", "timeseries", "timestamp", "video",
] as const;

export const SPDX_TEXT_MAX_CHARS = 256;
export const SPDX_URL_MAX_CHARS = 2048;

export const PROPERTY_LABEL: Readonly<Record<SpdxProperty, string>> = {
  releaseTime: "Release time",
  downloadLocation: "Download location",
  packageVersion: "Package version",
  builtTime: "Built time",
  originatedBy: "Originated by",
  datasetType: "Dataset type",
};

export const SOURCE_LABEL: Readonly<Record<SpdxSource, string>> = {
  supplier_declared: "Supplier declared",
  admin_entered: "Admin entered",
};

export const SOURCE_HELP: Readonly<Record<SpdxSource, string>> = {
  supplier_declared: "the supplier published or stated this value, and you are recording it",
  admin_entered: "an administrator determined this value; no supplier statement backs it",
};

export const SUBJECT_LABEL: Readonly<Record<SpdxSubjectKind, string>> = {
  model_card: "model card",
  training_dataset: "training dataset version",
  eval_dataset: "evaluation dataset version",
};

/** the format hint shown under each input, the same rule the gateway applies */
export const PROPERTY_HINT: Readonly<Record<SpdxProperty, string>> = {
  releaseTime: "UTC, whole seconds: YYYY-MM-DDThh:mm:ssZ (for example 2026-01-31T09:30:00Z). No offset and no fractional seconds.",
  builtTime: "UTC, whole seconds: YYYY-MM-DDThh:mm:ssZ (for example 2026-01-31T09:30:00Z). No offset and no fractional seconds.",
  downloadLocation:
    "An https origin only: https://host or https://host:port. A path, query, fragment, user name or password, plain http, an upper-case or non-ASCII host, or the default port written out (:443) is refused, never cut down.",
  packageVersion: `Printable ASCII with no spaces, 1 to ${SPDX_TEXT_MAX_CHARS} characters. No URL, no @, no credential-shaped text.`,
  originatedBy: `The organisation or person that created the data, 1 to ${SPDX_TEXT_MAX_CHARS} characters with no leading or trailing space. No URL, no @, no control characters, no credential-shaped text.`,
  datasetType: "One or more SPDX 3.0.1 dataset types.",
};

/**
 * Is the property mandatory for an SPDX rendering of this subject? A dataset
 * with no declared type renders the standard's own `noAssertion` (R3); a model
 * card's pinned model version is used before a declared package version (B5).
 */
export function isMandatory(kind: SpdxSubjectKind, property: SpdxProperty, pinnedModelVersion?: string | null): boolean {
  if (property === "datasetType") return false;
  if (kind === "model_card" && property === "packageVersion" && pinnedModelVersion) return false;
  return true;
}

export interface SpdxDeclarationView {
  seq: number;
  property: SpdxProperty;
  withdrawn: boolean;
  value: string | string[] | null;
  source: SpdxSource;
  declaredByUserId: string;
  declaredAt: string;
}

export interface SpdxFieldsResponse {
  /** displayName: the gateway's presentation-scrubbed name of the record ("<model> · <intended use>", "<dataset> v<n>") */
  subject: { kind: SpdxSubjectKind; id: string; displayName?: string | null };
  declarable: SpdxProperty[];
  current: SpdxDeclarationView[];
  undeclared: SpdxProperty[];
  history: SpdxDeclarationView[];
  historyLimit: number;
}

const isProperty = (x: unknown): x is SpdxProperty => typeof x === "string" && (SPDX_PROPERTIES as readonly string[]).includes(x);
const isDeclaration = (x: unknown): x is SpdxDeclarationView => {
  const d = x as Partial<SpdxDeclarationView> | null;
  return (
    !!d &&
    typeof d === "object" &&
    typeof d.seq === "number" &&
    isProperty(d.property) &&
    typeof d.withdrawn === "boolean" &&
    (d.value === null || typeof d.value === "string" || (Array.isArray(d.value) && d.value.every((v) => typeof v === "string"))) &&
    (SPDX_SOURCES as readonly string[]).includes(String(d.source)) &&
    typeof d.declaredByUserId === "string" &&
    typeof d.declaredAt === "string"
  );
};

/**
 * The GET answer, checked before anything renders it. An answer in any other
 * shape (an older gateway, a proxy page, a partial body) is a load failure the
 * panel reports on its own; it must never throw during render and take the
 * rest of the record's page with it.
 */
export function parseSpdxFieldsResponse(raw: unknown): SpdxFieldsResponse {
  const r = raw as Partial<SpdxFieldsResponse> | null;
  const subject = r?.subject as Partial<SpdxFieldsResponse["subject"]> | undefined;
  const ok =
    !!r &&
    typeof r === "object" &&
    !!subject &&
    typeof subject === "object" &&
    typeof subject.id === "string" &&
    (subject.displayName === undefined || subject.displayName === null || typeof subject.displayName === "string") &&
    Array.isArray(r.declarable) && r.declarable.every(isProperty) &&
    Array.isArray(r.undeclared) && r.undeclared.every(isProperty) &&
    Array.isArray(r.current) && r.current.every(isDeclaration) &&
    Array.isArray(r.history) && r.history.every(isDeclaration) &&
    typeof r.historyLimit === "number";
  if (!ok) throw new Error("The gateway's SPDX fields answer was not in the expected shape, so nothing is shown. Retry, or check the gateway version.");
  return r as SpdxFieldsResponse;
}

/** the record's name for a confirmation, or null when the gateway gave none (the id is shown instead) */
export const subjectDisplayName = (data: Pick<SpdxFieldsResponse, "subject">): string | null => {
  const n = data.subject.displayName;
  return typeof n === "string" && n.trim() ? n : null;
};

/** what the banner says is still missing, split by whether it blocks the SPDX rendering */
export function undeclaredSummary(kind: SpdxSubjectKind, undeclared: readonly SpdxProperty[], pinnedModelVersion?: string | null) {
  return {
    blocking: undeclared.filter((p) => isMandatory(kind, p, pinnedModelVersion)),
    optional: undeclared.filter((p) => !isMandatory(kind, p, pinnedModelVersion)),
  };
}

export const spdxFieldsPath = (kind: SpdxSubjectKind, id: string) => `/v1/ai-bom/spdx-fields/${kind}/${encodeURIComponent(id)}`;
export const spdxFieldPath = (kind: SpdxSubjectKind, id: string, property: SpdxProperty) => `${spdxFieldsPath(kind, id)}/${property}`;

// ---------------------------------------------------------------------------
// client-side checks: the gateway's rules, as hints (never the value in a message)
// ---------------------------------------------------------------------------

/** a refusal: the property, the gateway's rule code, and a fixed sentence */
export interface SpdxCheck {
  ok: boolean;
  /** the value exactly as it will be recorded (times are already UTC whole seconds; types sorted) */
  value?: string | string[];
  rule?: string;
  message?: string;
}

const SPDX_DATETIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const ASCII_HOST = /^[A-Za-z0-9.-]+$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]{0,31}:/;
const VERSION = /^[!-~]+$/;

/** the fixed sentence for each gateway rule; the property is named by the caller */
export const RULE_SENTENCE: Readonly<Record<string, string>> = {
  spdx_time_invalid: "is not in the form YYYY-MM-DDThh:mm:ssZ: a real instant in UTC with Z and whole seconds. A minutes-only time, an offset (even +00:00) or fractional seconds is refused, never converted.",
  download_location_invalid: "is not an absolute URL of at most 2,048 characters.",
  download_location_credentials: "carries a user name or password. Only an https origin is recorded.",
  download_location_not_https: "is not https. Only an https origin is recorded; plain http is refused.",
  download_location_not_origin:
    "is not an https origin (https://host[:port]). A path, query or fragment, an upper-case or non-ASCII host, or the default port written out is refused, never cut down.",
  package_version_invalid: `must be printable ASCII with no spaces, 1 to ${SPDX_TEXT_MAX_CHARS} characters, with no URL and no @.`,
  originated_by_invalid: `must be 1 to ${SPDX_TEXT_MAX_CHARS} characters with no leading or trailing space, no control character, no URL and no @.`,
  credential_shaped: "holds credential-shaped material. It is refused, never redacted.",
  dataset_type_invalid: "must be one or more SPDX 3.0.1 dataset types, each listed once.",
  spdx_property_not_allowed: "is not a property this record declares.",
  spdx_subject_invalid: "belongs to an unknown kind of record.",
};

const refuse = (rule: string): SpdxCheck => ({ ok: false, rule, message: RULE_SENTENCE[rule] ?? "was refused." });

export function checkSpdxTime(v: string): SpdxCheck {
  if (v.length !== 20 || !SPDX_DATETIME.test(v)) return refuse("spdx_time_invalid");
  const t = Date.parse(v);
  if (!Number.isFinite(t) || new Date(t).toISOString() !== `${v.slice(0, 19)}.000Z`) return refuse("spdx_time_invalid");
  return { ok: true, value: v };
}

export function checkSpdxDownloadLocation(v: string): SpdxCheck {
  if (v.length === 0 || v.length > SPDX_URL_MAX_CHARS) return refuse("download_location_invalid");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return refuse("download_location_invalid");
  }
  // the gateway's order: userinfo, then the scheme, then the origin shape
  if (u.username || u.password) return refuse("download_location_credentials");
  if (u.protocol !== "https:") return refuse("download_location_not_https");
  if (!ASCII_HOST.test(u.hostname) || `${u.protocol}//${u.host}` !== v) return refuse("download_location_not_origin");
  return { ok: true, value: v };
}

function checkPlainText(v: string, rule: string): SpdxCheck {
  if (v.length === 0 || v.length > SPDX_TEXT_MAX_CHARS) return refuse(rule);
  if (v.trim() !== v) return refuse(rule);
  if (CONTROL.test(v)) return refuse(rule);
  if (v.includes("@")) return refuse(rule);
  if (SCHEME_PREFIX.test(v) || v.includes("://")) return refuse(rule);
  return { ok: true, value: v };
}

export function checkSpdxPackageVersion(v: string): SpdxCheck {
  const c = checkPlainText(v, "package_version_invalid");
  if (!c.ok) return c;
  return VERSION.test(v) ? c : refuse("package_version_invalid");
}

export const checkSpdxOriginator = (v: string): SpdxCheck => checkPlainText(v, "originated_by_invalid");

export function checkSpdxDatasetType(v: readonly string[]): SpdxCheck {
  if (v.length === 0 || v.length > SPDX_DATASET_TYPES.length) return refuse("dataset_type_invalid");
  if (v.some((x) => !(SPDX_DATASET_TYPES as readonly string[]).includes(x))) return refuse("dataset_type_invalid");
  const set = [...new Set(v)].sort();
  if (set.length !== v.length) return refuse("dataset_type_invalid");
  return { ok: true, value: set };
}

/** check one value for one property of one subject kind, as the gateway will */
export function checkSpdxValue(kind: SpdxSubjectKind, property: SpdxProperty, value: string | readonly string[]): SpdxCheck {
  if (!SPDX_SUBJECT_PROPERTIES[kind].includes(property)) return refuse("spdx_property_not_allowed");
  if (property === "datasetType") return Array.isArray(value) ? checkSpdxDatasetType(value) : refuse("dataset_type_invalid");
  if (typeof value !== "string") return refuse("spdx_property_not_allowed");
  switch (property) {
    case "releaseTime":
    case "builtTime":
      return checkSpdxTime(value);
    case "downloadLocation":
      return checkSpdxDownloadLocation(value);
    case "packageVersion":
      return checkSpdxPackageVersion(value);
    case "originatedBy":
      return checkSpdxOriginator(value);
  }
  return refuse("spdx_property_not_allowed");
}

/** a stored value as text (a type list joined, a withdrawal said in words) */
export function valueText(d: Pick<SpdxDeclarationView, "withdrawn" | "value">): string {
  if (d.withdrawn) return "withdrawn (no value)";
  if (Array.isArray(d.value)) return d.value.join(", ");
  return d.value ?? "—";
}

/** a gateway time as UTC whole seconds, the form the record is shown in */
export function utcSeconds(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 19)}Z` : iso;
}

// ---------------------------------------------------------------------------
// the gateway's refusals, as sentences (never the value)
// ---------------------------------------------------------------------------

const ROUTE_SENTENCE: Readonly<Record<string, string>> = {
  invalid_spdx_subject: "This record cannot carry SPDX fields.",
  spdx_subject_not_found: "This record no longer exists, so nothing was recorded.",
  spdx_property_not_allowed: "This record does not declare that property.",
  spdx_field_not_declared: "There is no current value to withdraw; it may have been withdrawn already.",
  admin_only: "Only an administrator may read or change SPDX fields.",
};

/**
 * One refusal as a sentence: the property and the rule, never the value. A
 * refusal the gateway explains with a rule gets that rule's fixed sentence;
 * anything else gets the shared client's message, which carries no value
 * either (these routes never echo one).
 */
export function refusalSentence(property: SpdxProperty, e: unknown): { code: string | null; rule: string | null; text: string } {
  const label = PROPERTY_LABEL[property];
  if (e instanceof ApiError) {
    const code = typeof e.payload.error === "string" ? e.payload.error : null;
    const rule = typeof (e.payload as { rule?: unknown }).rule === "string" ? ((e.payload as { rule: string }).rule) : null;
    if (code === "invalid_spdx_declaration" && rule) return { code, rule, text: `${label} ${RULE_SENTENCE[rule] ?? "was refused by the gateway."} Nothing was recorded.` };
    if (code === "invalid_spdx_declaration") return { code, rule, text: `${label}: the request was not in the shape the gateway accepts (a value and a source). Nothing was recorded.` };
    if (code && ROUTE_SENTENCE[code]) return { code, rule, text: `${label}: ${ROUTE_SENTENCE[code]}` };
    return { code, rule, text: `${label}: ${e.message}` };
  }
  return { code: null, rule: null, text: `${label}: the request did not complete. Nothing is known to have been recorded; reload to check.` };
}
