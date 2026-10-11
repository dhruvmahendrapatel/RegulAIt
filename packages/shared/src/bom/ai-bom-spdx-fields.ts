/**
 * ADR-0189 slice B9 (OWNER DECISION 13, amendment R51): the supplier-declared
 * SPDX 3.0.1 properties that no other table records, and their validation.
 *
 * One definition used by three readers: the admin write route (refuses a bad
 * value before it is stored), the AI BOM normaliser (re-checks every loaded
 * value, defence in depth) and the SPDX renderer (reads the current values).
 * The database repeats the shape checks in CHECK constraints (migration 0186).
 *
 * Rules (R51), each a refusal, never a repair:
 *  - a TIME is accepted ONLY as `YYYY-MM-DDThh:mm:ssZ`, a real instant in
 *    whole seconds in UTC: exactly what is stored and rendered. A minutes-only
 *    time, an offset (even `+00:00`) or fractional seconds is refused, never
 *    normalised (zod's ISO-8601 datetime check, then B5's `isSpdxDateTime`;
 *    ADR-0176: no hand-written date parser).
 *  - a DOWNLOAD LOCATION is an `https` ORIGIN only, exactly what B3's endpoint
 *    rule (R47, #280 4237493036) and B5's `isSpdxDownloadLocation` export. A
 *    path, query, fragment, userinfo, another scheme or a non-ASCII host is
 *    refused, never cut down: cutting would record a value nobody declared.
 *  - a VERSION and an ORIGINATOR are bounded plain text with no URL, no `@`
 *    (R10's email scan would refuse the snapshot), no control character and no
 *    credential-shaped material (the audit scrubber's own rules, ADR-0099),
 *    and they pass B7's name check (`assertAiBomName`: hidden, escaped and
 *    fullwidth URLs, `javascript:`/`data:` schemes).
 *  - a DATASET TYPE is a non-empty set of SPDX 3.0.1 `DatasetType` values.
 *
 * Refusal messages name the property and the rule, never the value.
 */
import { z } from "zod";
import { scrubAuditText } from "../audit-scrub.js";
import { AiBomRecordError, assertAiBomName } from "./ai-bom-records.js";
import { isSpdxDateTime, isSpdxDownloadLocation } from "./ai-bom-spdx.js";

/** the parents a declaration may belong to (one foreign key each, R36's rule) */
export const AI_BOM_SPDX_SUBJECT_KINDS = ["model_card", "training_dataset", "eval_dataset"] as const;
export type AiBomSpdxSubjectKind = (typeof AI_BOM_SPDX_SUBJECT_KINDS)[number];

export const AI_BOM_SPDX_PROPERTIES = ["releaseTime", "downloadLocation", "packageVersion", "builtTime", "originatedBy", "datasetType"] as const;
export type AiBomSpdxProperty = (typeof AI_BOM_SPDX_PROPERTIES)[number];

/** R51: which property each parent kind may declare */
export const AI_BOM_SPDX_SUBJECT_PROPERTIES: Readonly<Record<AiBomSpdxSubjectKind, readonly AiBomSpdxProperty[]>> = {
  model_card: ["releaseTime", "downloadLocation", "packageVersion"],
  training_dataset: ["builtTime", "originatedBy", "releaseTime", "downloadLocation", "datasetType"],
  eval_dataset: ["builtTime", "originatedBy", "releaseTime", "downloadLocation", "datasetType"],
};

export const AI_BOM_SPDX_SOURCES = ["supplier_declared", "admin_entered"] as const;
export type AiBomSpdxSource = (typeof AI_BOM_SPDX_SOURCES)[number];

/** SPDX 3.0.1 `dataset_DatasetType` vocabulary (spdx-model.ttl, bundled in scripts/spdx3) */
export const SPDX_DATASET_TYPES = [
  "audio", "categorical", "graph", "image", "noAssertion", "numeric", "other", "sensor", "structured", "syntactic", "text", "timeseries", "timestamp", "video",
] as const;

export const AI_BOM_SPDX_TEXT_MAX_CHARS = 256;
export const AI_BOM_SPDX_URL_MAX_CHARS = 2048;

const TIME_PROPERTIES: readonly AiBomSpdxProperty[] = ["releaseTime", "builtTime"];
export const isSpdxTimeProperty = (p: AiBomSpdxProperty): boolean => TIME_PROPERTIES.includes(p);

export class AiBomSpdxFieldError extends Error {
  constructor(readonly property: string, readonly rule: string, message: string) {
    super(`ai-bom spdx field ${property}: ${message}`);
    this.name = "AiBomSpdxFieldError";
  }
}
const refuse = (property: string, rule: string, message: string): never => {
  throw new AiBomSpdxFieldError(property, rule, message);
};

/** ISO-8601 with `Z` or an offset, whole seconds only (`precision: 0`) */
/** ISO-8601 with `Z` only (no offset) and whole seconds only (`precision: 0`) */
const isoUtcWholeSeconds = z.string().max(20).datetime({ precision: 0 });
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]{0,31}:/;
const VERSION = /^[!-~]+$/;

/** a time value, accepted only when it is already a UTC SPDX DateTime (`YYYY-MM-DDThh:mm:ssZ`); never rewritten */
export function normaliseSpdxTime(property: string, v: unknown): string {
  if (typeof v !== "string" || !isoUtcWholeSeconds.safeParse(v).success || !isSpdxDateTime(v)) {
    return refuse(property, "spdx_time_invalid", "only YYYY-MM-DDThh:mm:ssZ is accepted: a real instant, whole seconds, UTC with Z (no offset, no fractional seconds)");
  }
  return v;
}

/** a download location -> unchanged when it is already an https origin, else refused */
export function normaliseSpdxDownloadLocation(property: string, v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > AI_BOM_SPDX_URL_MAX_CHARS) return refuse(property, "download_location_invalid", "not a URL of bounded length");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return refuse(property, "download_location_invalid", "not an absolute URL");
  }
  if (u.username || u.password) return refuse(property, "download_location_credentials", "carries userinfo (R47)");
  if (u.protocol !== "https:") return refuse(property, "download_location_not_https", "only an https origin is exported (R47, R51)");
  if (!isSpdxDownloadLocation(v)) {
    return refuse(property, "download_location_not_origin", "must be an https origin (https://host[:port]) with no path, query or fragment (R47, #280 4237493036); it is refused, never cut down");
  }
  return v;
}

function plainText(property: string, v: unknown, rule: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > AI_BOM_SPDX_TEXT_MAX_CHARS) return refuse(property, rule, `not text of 1 to ${AI_BOM_SPDX_TEXT_MAX_CHARS} characters`);
  if (v.trim() !== v) return refuse(property, rule, "leading or trailing whitespace");
  if (CONTROL.test(v)) return refuse(property, rule, "holds a control character");
  if (v.includes("@")) return refuse(property, rule, "holds an @ (R10: no email shape in a BOM)");
  if (SCHEME_PREFIX.test(v) || v.includes("://")) return refuse(property, rule, "holds a URL");
  if (scrubAuditText(v) !== v) return refuse(property, "credential_shaped", "holds credential-shaped material (refused, never redacted)");
  // B7's name check on top (one definition for every BOM name): hidden, escaped or fullwidth URLs and script schemes
  try {
    assertAiBomName(property, v);
  } catch (e) {
    if (e instanceof AiBomRecordError) return refuse(property, "name_check_refused", "refused by the AI BOM name check (a URL in any form, a script or data scheme, or credential-shaped material)");
    throw e;
  }
  return v;
}

export function normaliseSpdxPackageVersion(property: string, v: unknown): string {
  const t = plainText(property, v, "package_version_invalid");
  if (!VERSION.test(t)) return refuse(property, "package_version_invalid", "only printable ASCII with no spaces");
  return t;
}

export const normaliseSpdxOriginator = (property: string, v: unknown): string => plainText(property, v, "originated_by_invalid");

export function normaliseSpdxDatasetType(property: string, v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > SPDX_DATASET_TYPES.length) return refuse(property, "dataset_type_invalid", "not a non-empty list of SPDX DatasetType values");
  for (const x of v) if (typeof x !== "string" || !(SPDX_DATASET_TYPES as readonly string[]).includes(x)) return refuse(property, "dataset_type_invalid", `a value is not one of ${SPDX_DATASET_TYPES.join(" | ")}`);
  const set = [...new Set(v as string[])].sort();
  if (set.length !== v.length) return refuse(property, "dataset_type_invalid", "a value is listed twice");
  return set;
}

export type AiBomSpdxValue = string | string[];

/** validate one declared value for one property of one parent kind */
export function normaliseSpdxDeclaration(kind: AiBomSpdxSubjectKind, property: string, value: unknown): AiBomSpdxValue {
  if (!(AI_BOM_SPDX_SUBJECT_KINDS as readonly string[]).includes(kind)) return refuse(property, "spdx_subject_invalid", "unknown subject kind");
  if (!(AI_BOM_SPDX_SUBJECT_PROPERTIES[kind] as readonly string[]).includes(property)) return refuse(property, "spdx_property_not_allowed", `not a property a ${kind} declares`);
  switch (property as AiBomSpdxProperty) {
    case "releaseTime":
    case "builtTime":
      return normaliseSpdxTime(property, value);
    case "downloadLocation":
      return normaliseSpdxDownloadLocation(property, value);
    case "packageVersion":
      return normaliseSpdxPackageVersion(property, value);
    case "originatedBy":
      return normaliseSpdxOriginator(property, value);
    case "datasetType":
      return normaliseSpdxDatasetType(property, value);
  }
  return refuse(property, "spdx_property_not_allowed", "unknown property");
}
