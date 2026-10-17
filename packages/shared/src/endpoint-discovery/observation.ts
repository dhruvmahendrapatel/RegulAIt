/**
 * ADR-0195 SD3 — the endpoint observation both importers produce.
 *
 * An observation is what a device reported, reduced to match keys, traits and
 * pseudonymous references. It is not a finding: SD0's pipeline matches it
 * against the enabled `ai_endpoint_signatures` rows (decision 5) and merges a
 * match into `shadow_ai_findings` (decision 5a).
 */
import type { EndpointObservationKey, EndpointOs, EndpointSignatureKind, EndpointTrait } from "./endpoint-signatures.js";

/** ADR-0195 decision 5a signal sources owned by SD3 */
export const ENDPOINT_IMPORT_SOURCES = ["endpoint_osquery", "endpoint_inventory"] as const;
export type EndpointImportSource = (typeof ENDPOINT_IMPORT_SOURCES)[number];

/** Byte and row bounds for one endpoint import. A larger fleet export is split. */
export const ENDPOINT_IMPORT_MAX_BYTES = 5_000_000;
export const ENDPOINT_IMPORT_MAX_ROWS = 20_000;
/** one osquery log line */
export const ENDPOINT_IMPORT_MAX_LINE_BYTES = 262_144;
/** one cell: SD0's observation value bound (VALUE_MAX), so a kept value always fits a run */
export const ENDPOINT_IMPORT_MAX_CELL = 512;

/** Column names whose presence means a pack was edited to collect values. Such a row is refused, never stored. */
export const ENDPOINT_FORBIDDEN_COLUMNS = [
  "value",
  "values",
  "data",
  "cmdline",
  "cmd",
  "command_line",
  "commandline",
  "args",
  "argv",
  "arguments",
  "environment",
  "environment_variables",
  "environ",
  "env",
  "env_value",
  "env_values",
  "envs",
  "content",
  "contents",
  "secret",
  "token",
  "password",
] as const;

/** a column name compared with the forbidden list: lower-cased, spaces, dashes and dots as `_` */
export function normaliseColumnName(h: string): string {
  let out = "";
  for (const c of h.trim().toLowerCase()) out += c === " " || c === "-" || c === "." ? "_" : c;
  return out;
}

export const isForbiddenColumn = (h: string): boolean => (ENDPOINT_FORBIDDEN_COLUMNS as readonly string[]).includes(normaliseColumnName(h));

/**
 * An environment variable NAME: a letter or `_`, then letters, digits or `_`,
 * at most 128 characters. Character-scanned. A "name" that fails this (a key,
 * a token, anything with a dash) is refused: it is likely a value.
 */
export function isEnvVarName(v: string): boolean {
  if (v.length === 0 || v.length > 128) return false;
  const first = v[0]!;
  const letter = (c: string) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
  if (!letter(first)) return false;
  return [...v].every((c) => letter(c) || (c >= "0" && c <= "9"));
}

export interface EndpointObservation {
  source: EndpointImportSource;
  /** 1-based line of the file the operator has open */
  line: number;
  /** position inside a snapshot or batch line (0-based), when the line carried several rows */
  item?: number;
  /** the pack query name (osquery), or null for an inventory row */
  query: string | null;
  kindHint: EndpointSignatureKind | null;
  /** device pseudonym */
  device: string;
  /** device-user pseudonym, when the row named a user or a home path */
  user: string | null;
  os: EndpointOs | null;
  /** ISO-8601 UTC, or null when the row carried no time (the pipeline stamps import time) */
  observedAt: string | null;
  keys: EndpointObservationKey[];
  traits: EndpointTrait[];
  /** a pseudonymised path or registry key */
  location: string | null;
  version: string | null;
  /** bounded informational columns the query allowlists (publisher, vendor, protocol, file type) */
  info: Record<string, string>;
}

export interface EndpointRowRefusal {
  line: number;
  item?: number;
  reason: string;
  field?: string;
}

export interface EndpointImportResult {
  source: EndpointImportSource;
  observations: EndpointObservation[];
  refusals: EndpointRowRefusal[];
  /** differential rows osquery reported as REMOVED: counted, not observed */
  removedRows: number;
  /** candidate rows seen. `observations + refusals + removedRows === rowsParsed`, always. */
  rowsParsed: number;
  rowsWithoutTimestamp: number;
  /** distinct device pseudonyms */
  devices: number;
}

/** A whole-file refusal: the importer could not establish a reading at all. */
export class EndpointImportFormatError extends Error {
  readonly code = "unreadable_endpoint_file";
  constructor(
    message: string,
    readonly detail: { importer: EndpointImportSource; missing?: string[] },
  ) {
    super(message);
    this.name = "EndpointImportFormatError";
  }
}

export const ENDPOINT_IMPORT_POSTURE =
  "Endpoint evidence is imported from files your own osquery or MDM/EDR produced. RegulAIt ships the query pack " +
  "only, never installs anything on a device, and stores no environment variable values, command lines or file " +
  "contents. Device users and device names are kept as per-tenant pseudonyms. Coverage is exactly the devices and " +
  "the facts your export contains.";
