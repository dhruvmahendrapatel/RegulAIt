/**
 * ADR-0076 — ROSTER INGEST, the pure half.
 *
 * The pillar-5 wedge needs per-user attribution for IMPORTED (vendor-billed)
 * spend, and ADR-0069 already built the machinery: admin-asserted
 * vendor-account aliases and a person-level cost centre. What it did not build
 * is a way to assert two hundred of them at once — which is what a customer's
 * identity system already knows. This module parses a standard SCIM-style user
 * export (JSON) or a CSV roster into normalised entries; the GATEWAY then
 * feeds every entry through the EXISTING alias and cost-centre write paths.
 * Nothing here writes anything, and nothing here resolves anything: ambiguity
 * detection needs the user table, so it lives beside the write paths.
 *
 * WHAT A ROSTER ROW ASSERTS
 *
 *   "the vendor account <accountRef> is the RegulAIt user <userEmail>, and
 *    that person's chargeback cost centre is <costCenter>"
 *
 * with userEmail defaulting to the account itself when the roster carries no
 * separate mapping column (the common case: the vendor bills the same address
 * the directory uses).
 *
 * PII POSTURE — the same one ADR-0069 declares, restated for a roster: the
 * account and email columns are identity JOIN KEYS and are exempt from the PII
 * gate by construction; the ONLY other field retained is the cost centre,
 * which the gateway scans through the ADR-0042 detectors. Every unmapped
 * column — display names, titles, phone numbers, manager chains, everything
 * else a SCIM export drags along — is DISCARDED AT PARSE and never reaches the
 * gateway, let alone storage.
 */
import { z } from "zod";
import {
  ANY_VENDOR,
  COST_IMPORT_MAX_COLUMNS,
  CostImportFormatError,
  readSourceTable,
} from "./cost-import.js";

export const ROSTER_MAX_ROWS = 5_000;
export const ROSTER_TEXT_MAX = 300;

// ---------------------------------------------------------------------------
// request schema (the gateway's body)
// ---------------------------------------------------------------------------

export const rosterColumnMappingSchema = z
  .object({
    /** the vendor account column — the join key onto imported cost lines */
    account: z.string().min(1).max(200),
    /** the RegulAIt-email column, when the roster maps accounts to a DIFFERENT
     * directory address. Absent = the account itself is the email. */
    user: z.string().min(1).max(200).optional(),
    costCenter: z.string().min(1).max(200).optional(),
    vendor: z.string().min(1).max(200).optional(),
  })
  .strict();

export type RosterColumnMapping = z.infer<typeof rosterColumnMappingSchema>;

export const rosterIngestRequestSchema = z
  .object({
    format: z.enum(["csv", "json"]).default("csv"),
    mode: z.enum(["dry_run", "apply"]).default("dry_run"),
    /** the export, verbatim */
    content: z.string().min(1),
    /** a filename or a sentence about where it came from — provenance */
    source: z.string().min(1).max(300).optional(),
    /** the vendor every asserted alias is scoped to; '*' = any vendor */
    vendor: z.string().min(1).max(100).default(ANY_VENDOR),
    /** column mapping for CSV / plain-JSON-rows rosters. Ignored for SCIM. */
    mapping: rosterColumnMappingSchema.optional(),
    /** the audited justification stamped on every alias this roster asserts —
     * required because a bulk assertion nobody has to justify is two hundred
     * assertions nobody can review */
    reason: z.string().min(1).max(500),
    /** requested PII posture for the cost-centre scan; composed MAX with the
     * org/compliance floor, so it can only ever TIGHTEN */
    piiMode: z.enum(["off", "log", "warn", "block"]).optional(),
  })
  .strict();

export type RosterIngestRequest = z.infer<typeof rosterIngestRequestSchema>;

// ---------------------------------------------------------------------------
// parse result
// ---------------------------------------------------------------------------

export interface RosterEntry {
  /** 1-based row in the operator's file (SCIM: index in Resources, 1-based) */
  sourceRow: number;
  /** the vendor account exactly as the file spelled it */
  accountRef: string;
  /** the RegulAIt email this account maps to; null = the account itself */
  userEmail: string | null;
  costCenter: string | null;
  /** per-row vendor override (CSV only); null = the request-level vendor */
  vendor: string | null;
}

export interface RosterRowRefusal {
  row: number;
  field: string;
  reason: string;
}

export interface RosterParseResult {
  /** which dialect actually parsed — reported, so an operator is told how
   * their file was read */
  dialect: "scim" | "rows";
  rowsParsed: number;
  entries: RosterEntry[];
  refusals: RosterRowRefusal[];
  /** the columns/attributes that were READ. Everything else was discarded. */
  columnsUsed: string[];
}

// ---------------------------------------------------------------------------
// SCIM
// ---------------------------------------------------------------------------

const SCIM_ENTERPRISE_URN = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

interface ScimEmail {
  value?: unknown;
  primary?: unknown;
}

const asString = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

const bounded = (s: string | null): string | null =>
  s === null ? null : s.length > ROSTER_TEXT_MAX ? s.slice(0, ROSTER_TEXT_MAX) : s;

/** a SCIM ListResponse (`{Resources: [...]}`) or a bare array of SCIM users */
function parseScim(resources: unknown[], refusals: RosterRowRefusal[]): RosterEntry[] {
  const entries: RosterEntry[] = [];
  resources.forEach((r, i) => {
    const row = i + 1;
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      refusals.push({ row, field: "resource", reason: "not an object" });
      return;
    }
    const u = r as Record<string, unknown>;
    const userName = asString(u.userName);
    if (!userName) {
      refusals.push({ row, field: "userName", reason: "SCIM resource carries no userName — there is no account to map" });
      return;
    }
    let email: string | null = null;
    if (Array.isArray(u.emails)) {
      const emails = u.emails as ScimEmail[];
      const primary = emails.find((e) => e.primary === true);
      email = asString((primary ?? emails[0])?.value);
    } else if (typeof u.emails === "string") {
      email = asString(u.emails);
    }
    let costCenter: string | null = null;
    const ext = u[SCIM_ENTERPRISE_URN];
    if (typeof ext === "object" && ext !== null && !Array.isArray(ext)) {
      costCenter = asString((ext as Record<string, unknown>).costCenter);
    }
    entries.push({
      sourceRow: row,
      accountRef: bounded(userName)!,
      // an email identical to the account adds nothing; keep it null so the
      // gateway reports "the account IS the directory address"
      userEmail: email !== null && email.toLowerCase() !== userName.toLowerCase() ? bounded(email) : null,
      costCenter: bounded(costCenter),
      vendor: null,
    });
  });
  return entries;
}

// ---------------------------------------------------------------------------
// CSV / plain JSON rows
// ---------------------------------------------------------------------------

/** header inference, refusing on ambiguity. Two headers that both look like
 * the account column is a file whose meaning is a guess, and a guessed join
 * key attributes one person's spend to another. */
const ROSTER_ALIASES: Record<keyof RosterColumnMapping, string[]> = {
  account: ["account", "email", "user_name", "username", "userprincipalname", "login", "member", "seat"],
  user: ["regulait_email", "user_email", "maps_to", "directory_email"],
  costCenter: ["cost_center", "costcenter", "cost_centre"],
  vendor: ["vendor"],
};

const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

export function inferRosterMapping(
  headers: string[],
): { ok: true; mapping: RosterColumnMapping } | { ok: false; reason: string } {
  const normalized = new Map<string, string>();
  for (const h of headers) {
    const k = normalizeHeader(h);
    if (!normalized.has(k)) normalized.set(k, h);
  }
  const found: Partial<Record<keyof RosterColumnMapping, string>> = {};
  for (const key of Object.keys(ROSTER_ALIASES) as Array<keyof RosterColumnMapping>) {
    const hits = ROSTER_ALIASES[key].filter((a) => normalized.has(a));
    if (hits.length > 1) {
      return {
        ok: false,
        reason:
          `the header row is ambiguous: both '${normalized.get(hits[0]!)}' and '${normalized.get(hits[1]!)}' ` +
          `could be the ${key} column. Supply an explicit mapping instead of letting regulAIt guess a join key.`,
      };
    }
    if (hits.length === 1) found[key] = normalized.get(hits[0]!)!;
  }
  if (!found.account) {
    return {
      ok: false,
      reason:
        `no account column could be inferred from the header row (looked for: ${ROSTER_ALIASES.account.join(", ")}). ` +
        `Supply an explicit mapping.`,
    };
  }
  return { ok: true, mapping: { account: found.account, ...(found.user ? { user: found.user } : {}), ...(found.costCenter ? { costCenter: found.costCenter } : {}), ...(found.vendor ? { vendor: found.vendor } : {}) } };
}

// ---------------------------------------------------------------------------
// the one entry point
// ---------------------------------------------------------------------------

export function parseRosterExport(input: {
  content: string;
  format: "csv" | "json";
  mapping?: RosterColumnMapping | undefined;
}): RosterParseResult {
  const refusals: RosterRowRefusal[] = [];

  // SCIM detection first: a JSON object with a Resources array (a SCIM
  // ListResponse), or a bare array whose members carry userName.
  if (input.format === "json") {
    let doc: unknown;
    try {
      doc = JSON.parse(input.content);
    } catch (e) {
      throw new CostImportFormatError(`the payload is not valid JSON: ${(e as Error).message}`, {
        adapter: "roster",
      });
    }
    const resources =
      typeof doc === "object" && doc !== null && !Array.isArray(doc) && Array.isArray((doc as { Resources?: unknown }).Resources)
        ? ((doc as { Resources: unknown[] }).Resources)
        : Array.isArray(doc) && doc.some((r) => typeof r === "object" && r !== null && "userName" in (r as object))
          ? doc
          : null;
    if (resources !== null) {
      if (resources.length > ROSTER_MAX_ROWS) {
        throw new CostImportFormatError(
          `the roster carries ${resources.length} resources; the bound is ${ROSTER_MAX_ROWS}. Chunk the export.`,
          { adapter: "roster" },
        );
      }
      const entries = parseScim(resources, refusals);
      return {
        dialect: "scim",
        rowsParsed: resources.length,
        entries,
        refusals,
        columnsUsed: ["userName", "emails", `${SCIM_ENTERPRISE_URN}:costCenter`],
      };
    }
    // otherwise fall through: a plain array of row objects reads like a CSV
  }

  const table = readSourceTable({ content: input.content, format: input.format }, "roster");
  if (table.records.length > ROSTER_MAX_ROWS) {
    throw new CostImportFormatError(
      `the roster carries ${table.records.length} rows; the bound is ${ROSTER_MAX_ROWS}. Chunk the export.`,
      { adapter: "roster" },
    );
  }
  if (table.headers.length > COST_IMPORT_MAX_COLUMNS) {
    throw new CostImportFormatError(`more than ${COST_IMPORT_MAX_COLUMNS} columns`, { adapter: "roster" });
  }

  let mapping = input.mapping;
  if (!mapping) {
    const inferred = inferRosterMapping(table.headers);
    if (!inferred.ok) throw new CostImportFormatError(inferred.reason, { adapter: "roster" });
    mapping = inferred.mapping;
  }

  const entries: RosterEntry[] = [];
  for (const rec of table.records) {
    const account = asString(rec.get(mapping.account));
    if (!account) {
      refusals.push({
        row: rec.line,
        field: mapping.account,
        reason: `the '${mapping.account}' cell is empty — there is no account to map`,
      });
      continue;
    }
    const userEmail = mapping.user ? asString(rec.get(mapping.user)) : null;
    entries.push({
      sourceRow: rec.line,
      accountRef: bounded(account)!,
      userEmail: userEmail !== null && userEmail.toLowerCase() !== account.toLowerCase() ? bounded(userEmail) : null,
      costCenter: mapping.costCenter ? bounded(asString(rec.get(mapping.costCenter))) : null,
      vendor: mapping.vendor ? bounded(asString(rec.get(mapping.vendor))) : null,
    });
  }
  const columnsUsed = [mapping.account, mapping.user, mapping.costCenter, mapping.vendor].filter(
    (c): c is string => Boolean(c),
  );
  return { dialect: "rows", rowsParsed: table.records.length, entries, refusals, columnsUsed };
}
