/**
 * ADR-0071 — SHADOW-AI EVIDENCE FORMAT ADAPTERS, the pure half.
 *
 *   `packages/shared/src/shadow-ai.ts`      ADR-0055: the evidence KINDS, the
 *                                           strict row schemas, the catalogue,
 *                                           the matchers, correlation and the
 *                                           coverage scorecard. UNCHANGED.
 *   THIS FILE                               the layer BELOW that: raw vendor
 *                                           file in, ADR-0055 rows out.
 *   `apps/gateway/src/shadow-ai.ts`         the ONE import pipeline, which both
 *                                           the JSON route and the raw route
 *                                           now feed.
 *
 * WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT
 * --------------------------------------------------
 * ADR-0055 already ships the whole of shadow-AI discovery: four evidence kinds,
 * dry-run/apply, payload fingerprints, per-row provenance, forbidden-key
 * screening, correlation and an honest coverage statement. The ONE thing it did
 * not ship is the bottom step: it accepts rows ALREADY NORMALISED to its zod
 * schemas, so a customer had to reshape a CEF log or a Zscaler CSV into
 * RegulAIt's row shape by hand before RegulAIt would look at it.
 *
 * This file closes exactly that step and nothing else. It is an ADAPTER LAYER,
 * NOT A SUBSYSTEM: it owns no table, opens no route on its own, invents no
 * second pipeline and adds no new evidence kind. Every adapter's whole job is
 * to produce rows that the EXISTING `egressLogRowSchema` and its siblings
 * accept — and it proves that by validating each row against those very schemas
 * before returning it (see `finalizeRow`), so there is no way for an adapter's
 * idea of a row to drift from the pipeline's.
 *
 * THE HONESTY RULE THAT GOVERNS THIS FILE
 * ---------------------------------------
 * ADR-0069's vendor presets are built against DECLARED header sets that nobody
 * here has verified against a live console, and they say so in `limits`. The
 * same rule applies here with one important distinction that must NOT be
 * blurred:
 *
 *   "conforms to the published specification"  is a claim we can support for
 *                                              CEF, LEEF, W3C extended, Squid
 *                                              and NCSA common/combined, because
 *                                              those are published grammars and
 *                                              this file implements the grammar.
 *   "verified against a real Zscaler export"   is a claim NOBODY HERE CAN MAKE.
 *                                              No vendor export has been run
 *                                              through this code by this
 *                                              project.
 *
 * So every adapter carries a `formatBasis` and a `verification` sentence in
 * ADDITION to `limits`, all three are returned by the API, and none of them says
 * a vendor's name as if we had tested against that vendor's product.
 *
 * NEVER TRUST THE FILE
 * --------------------
 *  - Bytes and rows are bounded by the CALLER before anything is scanned; the
 *    row bound here is ADR-0055's `EVIDENCE_MAX_ROWS`, not a new one.
 *  - EVERY unparseable line is REFUSED WITH ITS 1-BASED FILE LINE NUMBER and the
 *    field that caused it. There is no code path that drops a line silently: a
 *    smaller result presented confidently is a wrong answer, and the caller
 *    additionally defaults to refusing the WHOLE file when any line refuses.
 *  - Parsing is CHARACTER-SCANNED. Not one regular expression is evaluated over
 *    file content anywhere in this file — the ADR-0055 "NO REGEX FROM DATA" rule
 *    (see `schema.ts`'s `ai_endpoint_signatures` note) applies verbatim, because
 *    a CEF extension is exactly the kind of attacker-shaped string that turns a
 *    lazy alternation into a ReDoS.
 *  - Escaping is honoured, because the naive split is the bug: `\|` inside a CEF
 *    header field and `\=` inside a CEF extension value both mean the literal
 *    character, and an adapter that splits on every separator silently produces
 *    a plausible-looking WRONG host.
 *  - Unmapped fields are DISCARDED, never retained. An adapter's output
 *    vocabulary is fixed by ADR-0055's row schemas, which is also why an
 *    evidence file still cannot mint governance: there is nowhere for a
 *    privilege word to land even before the escalation screen runs.
 *
 * WHAT AN ADAPTER CANNOT DO, EXHAUSTIVELY
 * ---------------------------------------
 * Produce `egress_log` / `code_scan` / `saas_export` / `self_reported` rows.
 * That is the entire vocabulary. No adapter output names a user, a role, a
 * grant, an entitlement, an agent, an approval or a severity — severity and
 * confidence are still computed by ADR-0055's analyzer against the ADMIN-owned
 * catalogue, and a file still cannot introduce a provider.
 *
 * COVERAGE HONESTY IS UNCHANGED. An adapter reads a file a human exported. It
 * observes nothing, discovers nothing and reaches no network. Coverage still
 * equals whatever the customer exported, and `GET /v1/shadow-ai/findings` still
 * returns that sentence with every number.
 */
import { z } from "zod";
import {
  CostImportFormatError,
  parseDateCell,
  readSourceTable,
  type CostImportAdapterInput,
} from "./cost-import.js";
import {
  EVIDENCE_KINDS,
  EVIDENCE_MAX_ROWS,
  codeScanRowSchema,
  egressLogRowSchema,
  saasExportRowSchema,
  selfReportedRowSchema,
  type EvidenceKind,
} from "./shadow-ai.js";

// ===========================================================================
// 1. THE ADAPTER CONTRACT
// ===========================================================================

/** the formats a file can arrive in. `text` is line-oriented log text. */
export const EVIDENCE_SOURCE_FORMATS = ["text", "csv", "json"] as const;
export type EvidenceSourceFormat = (typeof EVIDENCE_SOURCE_FORMATS)[number];

/**
 * WHERE THE ADAPTER'S KNOWLEDGE OF THE FORMAT CAME FROM. This is the field the
 * whole slice's honesty rule hangs on, and it is deliberately machine-readable
 * rather than buried in prose:
 *
 *   `published-spec`   the grammar is published and this file implements it.
 *                      CEF, LEEF, W3C extended, Squid native, NCSA common.
 *   `declared-format`  built from a vendor's documented column set that NOBODY
 *                      HERE HAS SEEN A REAL EXPORT OF. (No adapter in this file
 *                      currently claims this — see the ADR: a vendor preset we
 *                      cannot test is worse than `operator_mapped`, which asks.)
 *   `operator-mapped`  the operator declares the mapping; we assume nothing.
 */
export const EVIDENCE_FORMAT_BASES = ["published-spec", "declared-format", "operator-mapped"] as const;
export type EvidenceFormatBasis = (typeof EVIDENCE_FORMAT_BASES)[number];

export interface EvidenceAdapterCapabilities {
  /** can the format name the DESTINATION at all? Without it there is no
   * `egress_log` row to make, whatever else the file carries. */
  destinationHost: boolean;
  /** does it name WHO made the request (a user, a client host, an IP)? */
  sourceIdentity: boolean;
  perRowTimestamp: boolean;
  /** does a row carry an aggregate count, or is one line one request? */
  requestCount: boolean;
  /** does the FILE declare its own field list, so a vendor reordering columns
   * cannot silently change what every row means? */
  selfDescribing: boolean;
  /** which ADR-0055 evidence kinds this adapter can produce */
  kinds: readonly EvidenceKind[];
}

export interface EvidenceAdapterInput {
  /** the file, verbatim */
  content: string;
  format: EvidenceSourceFormat;
  /** adapter-specific configuration, zod-validated by the adapter itself */
  config?: unknown;
}

/** a refusal that names its locus. A refusal without a line number is an
 * apology, not a report — so `row` is required, always. */
export interface EvidenceRowRefusal {
  /** 1-based line number in the file the operator is looking at */
  row: number;
  reason: string;
  /** the field/key responsible, when the failure is attributable to one */
  field?: string;
}

export interface EvidenceParseResult {
  kind: EvidenceKind;
  /** rows already validated against ADR-0055's own row schema for `kind` */
  rows: Array<Record<string, unknown>>;
  refusals: EvidenceRowRefusal[];
  /** candidate data lines seen, EXCLUDING headers/directives/blank lines.
   * `rows.length + refusals.length === rowsParsed` always — asserted in the
   * suite, because that identity is the entire claim that nothing was dropped. */
  rowsParsed: number;
  /** the field/key names this adapter actually read, for the operator */
  fieldsUsed: string[];
  /** rows accepted with NO timestamp of their own. The pipeline stamps those
   * with the import time, and an operator is entitled to know how many. */
  rowsWithoutTimestamp: number;
}

/**
 * A WHOLE-FILE refusal: the adapter could not establish a reading at all
 * ("this is not a W3C log", "no `#Fields:` directive"). Kept distinct from a
 * per-row refusal so an operator is told "wrong adapter / wrong file" once
 * instead of receiving five thousand identical row errors.
 */
export class EvidenceFormatError extends Error {
  readonly code = "unreadable_evidence_file";
  constructor(
    message: string,
    readonly detail: { adapter: string; missing?: string[]; found?: string[] },
  ) {
    super(message);
    this.name = "EvidenceFormatError";
  }
}

export interface EvidenceAdapter {
  id: string;
  displayName: string;
  formats: readonly EvidenceSourceFormat[];
  capabilities: EvidenceAdapterCapabilities;
  formatBasis: EvidenceFormatBasis;
  /**
   * WHAT HAS AND HAS NOT BEEN CHECKED, in one sentence, returned by the API.
   * The distinction this slice exists to preserve: implementing a published
   * grammar and having tested a real vendor's export are different claims.
   */
  verification: string;
  /** WHAT THIS ADAPTER CANNOT DO, in plain words, returned by the API. A
   * capability list that only says yes is marketing. */
  limits: string;
  parse(input: EvidenceAdapterInput): EvidenceParseResult;
}

// ===========================================================================
// 2. ROW FINALISATION — the adapters and the pipeline share ONE row contract
// ===========================================================================

const ROW_SCHEMA: Record<EvidenceKind, z.ZodTypeAny> = {
  egress_log: egressLogRowSchema,
  code_scan: codeScanRowSchema,
  saas_export: saasExportRowSchema,
  self_reported: selfReportedRowSchema,
};

/**
 * Validate one candidate row against ADR-0055's OWN schema for its kind.
 *
 * This is the reuse that makes the slice an adapter layer rather than a second
 * pipeline: an adapter cannot invent a row shape, because the shape is checked
 * here against the exact schema `evidenceImportSchema` will check again at the
 * route. Doing it here as well is not redundancy — it is what turns a whole-file
 * zod error with a `rows.417.destinationHost` path into a refusal that names
 * LINE 418 OF THE FILE the operator actually has open.
 */
function finalizeRow(
  kind: EvidenceKind,
  candidate: Record<string, unknown>,
  line: number,
  rows: Array<Record<string, unknown>>,
  refusals: EvidenceRowRefusal[],
): void {
  const parsed = ROW_SCHEMA[kind].safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    refusals.push({
      row: line,
      reason: `the row this line produced is not a valid ${kind} row: ${issue?.message ?? "schema validation failed"}`,
      ...(issue && issue.path.length > 0 ? { field: issue.path.join(".") } : {}),
    });
    return;
  }
  rows.push(parsed.data as Record<string, unknown>);
}

// ===========================================================================
// 3. CHARACTER-SCANNED PRIMITIVES — not one regex touches file content
// ===========================================================================

/** Split into 1-based numbered lines. Blank lines keep their number and are
 * skipped as data — renumbering after a blank line turns a precise refusal into
 * a wrong one, which is the same reasoning `parseCsvRecords` documents. */
export function numberedLines(content: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let cur = "";
  let line = 1;
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i]!;
    if (c === "\n") {
      out.push({ line, text: cur });
      cur = "";
      line += 1;
      continue;
    }
    if (c === "\r") continue;
    cur += c;
  }
  if (cur.length > 0) out.push({ line, text: cur });
  return out;
}

const isDigits = (s: string) => s.length > 0 && [...s].every((c) => c >= "0" && c <= "9");

/**
 * A count cell. Digits only — deliberately NOT `parseAmountCell`, which accepts
 * `$`, thousands commas and accounting parentheses. A request count spelled
 * `(3)` is a corrupted log, not minus three requests.
 */
export function parseCountCell(raw: string): { ok: true; value: number } | { ok: false; reason: string } {
  const s = raw.trim();
  if (s.length === 0) return { ok: false, reason: "the count is empty — an absent count is not zero" };
  if (s.length > 12) return { ok: false, reason: `'${raw}' is implausibly long for a count` };
  const body = s[0] === "+" ? s.slice(1) : s;
  if (!isDigits(body)) return { ok: false, reason: `'${raw}' is not a whole number` };
  const value = Number(body);
  if (!Number.isSafeInteger(value) || value < 1) {
    return { ok: false, reason: `'${raw}' is not a positive whole number` };
  }
  return { ok: true, value };
}

/**
 * A timestamp, in the only two spellings that cannot be misread:
 *   - epoch SECONDS (10 digits) or MILLISECONDS (13 digits), optionally with a
 *     fractional part, as CEF's `rt` and Squid's first column use;
 *   - a year-first ISO-ish date, delegated to ADR-0069's `parseDateCell`, which
 *     refuses `07/08/2026` outright rather than guessing a field order.
 *
 * Anything else REFUSES. It does not fall back to `now`: silently stamping an
 * unparseable timestamp with the import time would move evidence between
 * reporting windows, which is the log-analysis version of the period-shifting
 * bug ADR-0069 refuses dates over.
 */
export function parseEvidenceTimestamp(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const s = raw.trim();
  if (s.length === 0) return { ok: false, reason: "the timestamp is empty" };
  if (s.length > 60) return { ok: false, reason: `'${raw}' is implausibly long for a timestamp` };
  const dot = s.indexOf(".");
  const whole = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? "" : s.slice(dot + 1);
  if (isDigits(whole) && (frac === "" || isDigits(frac))) {
    let ms: number;
    if (whole.length === 13) ms = Number(whole);
    else if (whole.length === 10) ms = Number(whole) * 1000 + (frac === "" ? 0 : Math.round(Number(`0.${frac}`) * 1000));
    else {
      return {
        ok: false,
        reason:
          `'${raw}' is all digits but is neither 10 (epoch seconds) nor 13 (epoch milliseconds) digits long — ` +
          `RegulAIt will not guess the unit of an epoch timestamp`,
      };
    }
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return { ok: false, reason: `'${raw}' is not a representable instant` };
    return { ok: true, value: d.toISOString() };
  }
  const viaDate = parseDateCell(s);
  if (viaDate.ok) return { ok: true, value: viaDate.value.toISOString() };
  return { ok: false, reason: viaDate.reason };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

/**
 * The NCSA bracket timestamp: `07/Aug/2026:12:00:00 +0000`.
 *
 * This one IS unambiguous despite being day-first, because the month is spelled
 * with letters — which is precisely why `parseDateCell` can refuse `07/08/2026`
 * without also refusing this. The month table is fixed and twelve entries long;
 * an unknown month name refuses.
 */
export function parseClfTimestamp(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const s = raw.trim();
  if (s.length === 0 || s.length > 40) return { ok: false, reason: `'${raw}' is not an NCSA timestamp` };
  const spaceAt = s.indexOf(" ");
  const stamp = spaceAt === -1 ? s : s.slice(0, spaceAt);
  const offset = spaceAt === -1 ? "" : s.slice(spaceAt + 1).trim();
  const parts = stamp.split("/");
  if (parts.length !== 3) return { ok: false, reason: `'${raw}' is not dd/Mon/yyyy:hh:mm:ss` };
  const [dayRaw, monRaw, rest] = parts as [string, string, string];
  const restParts = rest.split(":");
  if (restParts.length !== 4) return { ok: false, reason: `'${raw}' is not dd/Mon/yyyy:hh:mm:ss` };
  const [yearRaw, hhRaw, mmRaw, ssRaw] = restParts as [string, string, string, string];
  if (!isDigits(dayRaw) || !isDigits(yearRaw) || !isDigits(hhRaw) || !isDigits(mmRaw) || !isDigits(ssRaw)) {
    return { ok: false, reason: `'${raw}' has a non-numeric component` };
  }
  const month = MONTHS.indexOf(monRaw.toLowerCase() as (typeof MONTHS)[number]);
  if (month === -1) return { ok: false, reason: `'${monRaw}' is not an English month abbreviation` };
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  const ss = Number(ssRaw);
  if (year < 1970 || year > 2200) return { ok: false, reason: `'${raw}' has an out-of-range year` };
  if (day < 1 || day > 31 || hh > 23 || mm > 59 || ss > 59) return { ok: false, reason: `'${raw}' is out of range` };
  let offsetMinutes = 0;
  if (offset.length > 0) {
    const sign = offset[0];
    if ((sign !== "+" && sign !== "-") || offset.length !== 5 || !isDigits(offset.slice(1))) {
      return { ok: false, reason: `'${offset}' is not a ±hhmm UTC offset` };
    }
    const oh = Number(offset.slice(1, 3));
    const om = Number(offset.slice(3, 5));
    if (oh > 23 || om > 59) return { ok: false, reason: `'${offset}' is an out-of-range UTC offset` };
    offsetMinutes = (sign === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const utc = Date.UTC(year, month, day, hh, mm, ss) - offsetMinutes * 60_000;
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return { ok: false, reason: `'${raw}' is not a representable instant` };
  if (d.getUTCFullYear() > 2200) return { ok: false, reason: `'${raw}' has an out-of-range year` };
  return { ok: true, value: d.toISOString() };
}

/**
 * Split on UNESCAPED occurrences of `sep`, keeping the backslash escapes intact
 * for a later `unescape` pass. `limit` caps the number of SPLITS, so the
 * remainder survives whole — which is how a CEF extension keeps its own pipes.
 *
 * THIS FUNCTION IS THE SLICE. A naive `split("|")` turns the vendor
 * `Acme\|Corp` into `Acme\` and shifts every subsequent header field by one,
 * producing a confident, plausible, wrong parse. Same for `\=` inside an
 * extension value.
 */
export function splitUnescaped(s: string, sep: string, limit = Number.POSITIVE_INFINITY): string[] {
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) {
      cur += c + s[i + 1]!;
      i += 1;
      continue;
    }
    if (c === sep && parts.length < limit) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** `\n` `\r` `\t` become the control character; every other `\x` becomes `x`
 * (which covers the specified `\\`, `\|` and `\=` without enumerating them). */
export function unescapeLogValue(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) {
      const n = s[i + 1]!;
      out += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n;
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** a case-insensitive attribute bag. Vendors disagree about `dhost`/`dHost`,
 * and a lookup that missed on case would refuse a file it could read. The exact
 * spelling wins if it is present; otherwise the first case-folded match does. */
export class AttributeBag {
  private readonly exact = new Map<string, string>();
  private readonly folded = new Map<string, string>();
  set(key: string, value: string): void {
    if (!this.exact.has(key)) this.exact.set(key, value);
    const f = key.toLowerCase();
    if (!this.folded.has(f)) this.folded.set(f, value);
  }
  get(key: string): string | undefined {
    return this.exact.get(key) ?? this.folded.get(key.toLowerCase());
  }
  /** the first key in `keys` that has a non-empty value */
  first(keys: readonly string[]): { key: string; value: string } | null {
    for (const k of keys) {
      const v = this.get(k);
      if (v !== undefined && v.trim().length > 0 && v.trim() !== "-") return { key: k, value: v.trim() };
    }
    return null;
  }
  keys(): string[] {
    return [...this.exact.keys()];
  }
  get size(): number {
    return this.exact.size;
  }
}

// ===========================================================================
// 4. CEF — ArcSight Common Event Format (published grammar)
// ===========================================================================

/**
 * `CEF:Version|Vendor|Product|Version|SignatureID|Name|Severity|Extension`
 *
 * A leading syslog prefix (`<134>Aug  7 12:00:00 gw `) is tolerated by locating
 * the `CEF:` marker rather than assuming the line starts with it — because a CEF
 * record almost never arrives without one.
 */
export interface CefRecord {
  version: string;
  vendor: string;
  product: string;
  deviceVersion: string;
  signatureId: string;
  name: string;
  severity: string;
  extension: AttributeBag;
}

export function parseCefLine(text: string): { ok: true; value: CefRecord } | { ok: false; reason: string } {
  const at = text.indexOf("CEF:");
  if (at === -1) return { ok: false, reason: "the line carries no 'CEF:' header marker" };
  const body = text.slice(at + 4);
  const seg = splitUnescaped(body, "|", 7);
  if (seg.length < 8) {
    return {
      ok: false,
      reason:
        `a CEF record is 'CEF:Version|Vendor|Product|Version|SignatureID|Name|Severity|Extension' — ` +
        `this line has ${seg.length - 1} unescaped pipe(s) after the marker, not 7. ` +
        `A literal pipe inside a header field must be escaped as '\\|'.`,
    };
  }
  const version = unescapeLogValue(seg[0]!).trim();
  if (!isDigits(version)) {
    return { ok: false, reason: `'${version}' is not a CEF version number` };
  }
  return {
    ok: true,
    value: {
      version,
      vendor: unescapeLogValue(seg[1]!),
      product: unescapeLogValue(seg[2]!),
      deviceVersion: unescapeLogValue(seg[3]!),
      signatureId: unescapeLogValue(seg[4]!),
      name: unescapeLogValue(seg[5]!),
      severity: unescapeLogValue(seg[6]!),
      extension: parseCefExtension(seg[7]!),
    },
  };
}

/**
 * The CEF extension: `key=value key2=value2`, where a value may contain SPACES
 * (so pairs cannot be split on whitespace) and an escaped `\=` is a literal
 * equals sign (so pairs cannot be split on every `=` either).
 *
 * The grammar that resolves both: an UNESCAPED `=` ends a key, and that key
 * began at the last space before it. Everything between one `=` and the start of
 * the NEXT key is the value, minus the single separating space.
 */
export function parseCefExtension(ext: string): AttributeBag {
  const bag = new AttributeBag();
  const eq: number[] = [];
  for (let i = 0; i < ext.length; i += 1) {
    const c = ext[i]!;
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === "=") eq.push(i);
  }
  const keyStart = eq.map((e) => {
    let s = e;
    while (s > 0 && ext[s - 1] !== " ") s -= 1;
    return s;
  });
  for (let k = 0; k < eq.length; k += 1) {
    const key = ext.slice(keyStart[k]!, eq[k]!).trim();
    if (key.length === 0) continue;
    const vStart = eq[k]! + 1;
    const vEnd = k + 1 < eq.length ? Math.max(vStart, keyStart[k + 1]! - 1) : ext.length;
    bag.set(key, unescapeLogValue(ext.slice(vStart, vEnd)));
  }
  return bag;
}

/** CEF standard keys, in the order a destination is looked for. */
const CEF_HOST_KEYS = ["dhost", "destinationDnsDomain", "request", "dst"] as const;
const CEF_IDENTITY_KEYS = ["suser", "sourceUserName", "shost", "src"] as const;
const CEF_TIME_KEYS = ["rt", "end", "start"] as const;
const CEF_COUNT_KEY = "cnt";

const textAdapterConfigSchema = z.object({}).strict();

export const cefAdapter: EvidenceAdapter = {
  id: "cef",
  displayName: "ArcSight CEF (Common Event Format) event log",
  formats: ["text"],
  formatBasis: "published-spec",
  capabilities: {
    destinationHost: true,
    sourceIdentity: true,
    perRowTimestamp: true,
    requestCount: true,
    selfDescribing: true,
    kinds: ["egress_log"],
  },
  verification:
    "Implements the PUBLISHED CEF grammar — the 7-field header, '\\|' and '\\\\' header escaping, and extension " +
    "key/value pairs with '\\=' escaping and space-bearing values. It has NOT been run against a real export from " +
    "any vendor's product by this project: 'conforms to the specification' and 'verified against a live Zscaler / " +
    "Netskope / ArcSight feed' are different claims and this is only the first one.",
  limits:
    "Reads the destination from the first present of dhost, destinationDnsDomain, request (URL) or dst, the actor " +
    "from suser, sourceUserName, shost or src, the time from rt/end/start and the count from cnt — EVERY OTHER " +
    "extension key is discarded, including custom cs1..cs6 label pairs, which a product may be using for the very " +
    "field you care about. A line with none of the destination keys is REFUSED naming the keys it looked for and the " +
    "keys the line actually carried; it is never guessed at from the event name. `dst` is an IP, so a row that " +
    "resolves only to `dst` is attributed to an address, not a hostname, and matches the catalogue only if a " +
    "signature names that address. Multi-line CEF records and syslog message reassembly are not supported: one " +
    "record must be one line.",
  parse(input) {
    textAdapterConfigSchema.parse(input.config ?? {});
    const rows: Array<Record<string, unknown>> = [];
    const refusals: EvidenceRowRefusal[] = [];
    const fieldsUsed = new Set<string>();
    let rowsParsed = 0;
    let rowsWithoutTimestamp = 0;

    const lines = numberedLines(input.content);
    const dataLines = lines.filter((l) => l.text.trim().length > 0);
    boundRows(dataLines.length, "cef");

    for (const { line, text } of dataLines) {
      rowsParsed += 1;
      const rec = parseCefLine(text);
      if (!rec.ok) {
        refusals.push({ row: line, reason: rec.reason });
        continue;
      }
      const ext = rec.value.extension;
      const host = ext.first(CEF_HOST_KEYS);
      if (!host) {
        refusals.push({
          row: line,
          reason:
            `this CEF record names no destination: none of ${CEF_HOST_KEYS.join(", ")} is present with a value. ` +
            `The extension carries [${ext.keys().slice(0, 12).join(", ")}]${ext.size > 12 ? ", …" : ""}. ` +
            `RegulAIt will not infer a destination from the event name.`,
          field: CEF_HOST_KEYS.join("|"),
        });
        continue;
      }
      fieldsUsed.add(host.key);

      const candidate: Record<string, unknown> = { destinationHost: host.value };

      const who = ext.first(CEF_IDENTITY_KEYS);
      if (who) {
        candidate.sourceIdentity = who.value;
        fieldsUsed.add(who.key);
      }

      const when = ext.first(CEF_TIME_KEYS);
      if (when) {
        const ts = parseEvidenceTimestamp(when.value);
        if (!ts.ok) {
          refusals.push({ row: line, reason: `the '${when.key}' timestamp could not be read: ${ts.reason}`, field: when.key });
          continue;
        }
        candidate.observedAt = ts.value;
        fieldsUsed.add(when.key);
      } else {
        rowsWithoutTimestamp += 1;
      }

      const cnt = ext.first([CEF_COUNT_KEY]);
      if (cnt) {
        const n = parseCountCell(cnt.value);
        if (!n.ok) {
          refusals.push({ row: line, reason: `the '${CEF_COUNT_KEY}' base-event count could not be read: ${n.reason}`, field: CEF_COUNT_KEY });
          continue;
        }
        candidate.requestCount = n.value;
        fieldsUsed.add(CEF_COUNT_KEY);
      }

      finalizeRow("egress_log", candidate, line, rows, refusals);
    }

    return { kind: "egress_log", rows, refusals, rowsParsed, fieldsUsed: [...fieldsUsed], rowsWithoutTimestamp };
  },
};

// ===========================================================================
// 5. LEEF — IBM QRadar Log Event Extended Format (published grammar)
// ===========================================================================

const LEEF_HOST_KEYS = ["dstHostName", "dstHost", "domain", "url", "dst"] as const;
const LEEF_IDENTITY_KEYS = ["usrName", "accountName", "srcHostName", "identSrc", "src"] as const;
const LEEF_COUNT_KEY = "cnt";

export const leefConfigSchema = z
  .object({
    /** LEEF 1.0 carries no delimiter field, so an operator whose producer used
     * something other than TAB says so here. A single character, or an `xHH`
     * hex spelling, or `\t`. */
    delimiter: z.string().min(1).max(4).optional(),
  })
  .strict();

/** `x09`, `0x09`, `\t`, or a literal single character. Anything else is refused
 * rather than assumed to be TAB — a wrong delimiter parses every attribute into
 * one key and produces a file-wide "no destination" refusal that would look like
 * the customer's file was wrong. */
export function resolveLeefDelimiter(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const s = raw.trim();
  if (s.length === 0) return { ok: false, reason: "the delimiter field is empty" };
  if (s === "\\t") return { ok: true, value: "\t" };
  if (s.length === 1) return { ok: true, value: s };
  const hex = s.length === 3 && (s[0] === "x" || s[0] === "X") ? s.slice(1) : s.length === 4 && s.slice(0, 2).toLowerCase() === "0x" ? s.slice(2) : null;
  if (hex !== null) {
    const isHex = [...hex].every((c) => (c >= "0" && c <= "9") || (c.toLowerCase() >= "a" && c.toLowerCase() <= "f"));
    if (isHex) return { ok: true, value: String.fromCharCode(Number.parseInt(hex, 16)) };
  }
  return {
    ok: false,
    reason: `'${raw}' is not a LEEF delimiter: expected a single character, an 'xHH' hex spelling, or '\\t'`,
  };
}

export function parseLeefLine(
  text: string,
  fallbackDelimiter: string,
): { ok: true; value: { version: string; vendor: string; product: string; deviceVersion: string; eventId: string; attributes: AttributeBag } } | { ok: false; reason: string } {
  const at = text.indexOf("LEEF:");
  if (at === -1) return { ok: false, reason: "the line carries no 'LEEF:' header marker" };
  const body = text.slice(at + 5);
  const isV2 = body.startsWith("2");
  const seg = splitUnescaped(body, "|", isV2 ? 6 : 5);
  // five pipes are mandatory in both versions; LEEF 2.0's delimiter field makes
  // a sixth OPTIONAL, which is why the bound is the same either way
  if (seg.length < 6) {
    return {
      ok: false,
      reason:
        `a LEEF record is 'LEEF:Version|Vendor|Product|Version|EventID|${isV2 ? "Delimiter|" : ""}Attributes' — ` +
        `this line has ${seg.length - 1} unescaped pipe(s) after the marker. ` +
        `A literal pipe inside a header field must be escaped as '\\|'.`,
    };
  }
  let delimiter = fallbackDelimiter;
  let attributesRaw: string;
  if (isV2 && seg.length === 7) {
    const d = resolveLeefDelimiter(seg[5]!);
    if (!d.ok) {
      return {
        ok: false,
        reason:
          `${d.reason}. A LEEF 2.0 record's sixth header field is the attribute delimiter; RegulAIt refuses the line ` +
          `rather than assuming TAB, because a wrong delimiter parses the whole record into one meaningless key.`,
      };
    }
    delimiter = d.value;
    attributesRaw = seg[6]!;
  } else {
    attributesRaw = seg[5]!;
  }

  const bag = new AttributeBag();
  for (const pair of splitUnescaped(attributesRaw, delimiter)) {
    if (pair.trim().length === 0) continue;
    const kv = splitUnescaped(pair, "=", 1);
    if (kv.length < 2) continue;
    const key = unescapeLogValue(kv[0]!).trim();
    if (key.length === 0) continue;
    bag.set(key, unescapeLogValue(kv[1]!));
  }

  return {
    ok: true,
    value: {
      version: unescapeLogValue(seg[0]!),
      vendor: unescapeLogValue(seg[1]!),
      product: unescapeLogValue(seg[2]!),
      deviceVersion: unescapeLogValue(seg[3]!),
      eventId: unescapeLogValue(seg[4]!),
      attributes: bag,
    },
  };
}

export const leefAdapter: EvidenceAdapter = {
  id: "leef",
  displayName: "IBM QRadar LEEF (Log Event Extended Format) event log",
  formats: ["text"],
  formatBasis: "published-spec",
  capabilities: {
    destinationHost: true,
    sourceIdentity: true,
    perRowTimestamp: true,
    requestCount: true,
    selfDescribing: true,
    kinds: ["egress_log"],
  },
  verification:
    "Implements the PUBLISHED LEEF 1.0 and 2.0 grammar — the pipe-delimited header with '\\|' escaping, the LEEF 2.0 " +
    "delimiter field (literal, 'xHH' or '\\t') and TAB-delimited attributes otherwise. It has NOT been run against a " +
    "real export from any vendor's product by this project.",
  limits:
    "Reads the destination from the first present of dstHostName, dstHost, domain, url or dst, the actor from " +
    "usrName, accountName, srcHostName, identSrc or src, and the time from devTime — every other attribute is " +
    "discarded. LEEF defines NO base-event-count attribute, so a non-standard `cnt` is read if the file happens to " +
    "carry one and otherwise each record counts as one request. `devTimeFormat` is NOT honoured: if it is present " +
    "and declares a pattern, the record is REFUSED rather than have RegulAIt guess a custom strftime layout, because " +
    "a misread timestamp moves evidence between reporting windows. A LEEF 1.0 producer that used a delimiter other " +
    "than TAB needs `config.delimiter`, and a LEEF 2.0 line whose sixth field is not a valid delimiter spelling is " +
    "refused rather than assumed.",
  parse(input) {
    const cfg = leefConfigSchema.parse(input.config ?? {});
    let fallbackDelimiter = "\t";
    if (cfg.delimiter !== undefined) {
      const d = resolveLeefDelimiter(cfg.delimiter);
      if (!d.ok) throw new EvidenceFormatError(`config.delimiter: ${d.reason}`, { adapter: "leef" });
      fallbackDelimiter = d.value;
    }

    const rows: Array<Record<string, unknown>> = [];
    const refusals: EvidenceRowRefusal[] = [];
    const fieldsUsed = new Set<string>();
    let rowsParsed = 0;
    let rowsWithoutTimestamp = 0;

    const dataLines = numberedLines(input.content).filter((l) => l.text.trim().length > 0);
    boundRows(dataLines.length, "leef");

    for (const { line, text } of dataLines) {
      rowsParsed += 1;
      const rec = parseLeefLine(text, fallbackDelimiter);
      if (!rec.ok) {
        refusals.push({ row: line, reason: rec.reason });
        continue;
      }
      const attrs = rec.value.attributes;
      const host = attrs.first(LEEF_HOST_KEYS);
      if (!host) {
        refusals.push({
          row: line,
          reason:
            `this LEEF record names no destination: none of ${LEEF_HOST_KEYS.join(", ")} is present with a value. ` +
            `The record carries [${attrs.keys().slice(0, 12).join(", ")}]${attrs.size > 12 ? ", …" : ""}.`,
          field: LEEF_HOST_KEYS.join("|"),
        });
        continue;
      }
      fieldsUsed.add(host.key);
      const candidate: Record<string, unknown> = { destinationHost: host.value };

      const who = attrs.first(LEEF_IDENTITY_KEYS);
      if (who) {
        candidate.sourceIdentity = who.value;
        fieldsUsed.add(who.key);
      }

      const format = attrs.first(["devTimeFormat"]);
      const when = attrs.first(["devTime"]);
      if (when) {
        if (format) {
          refusals.push({
            row: line,
            reason:
              `this record declares devTimeFormat='${format.value}'. RegulAIt reads only epoch seconds/milliseconds ` +
              `and year-first ISO timestamps, and refuses rather than guess a custom pattern — a misread timestamp ` +
              `silently moves evidence between reporting windows.`,
            field: "devTimeFormat",
          });
          continue;
        }
        const ts = parseEvidenceTimestamp(when.value);
        if (!ts.ok) {
          refusals.push({ row: line, reason: `the 'devTime' timestamp could not be read: ${ts.reason}`, field: "devTime" });
          continue;
        }
        candidate.observedAt = ts.value;
        fieldsUsed.add("devTime");
      } else {
        rowsWithoutTimestamp += 1;
      }

      const cnt = attrs.first([LEEF_COUNT_KEY]);
      if (cnt) {
        const n = parseCountCell(cnt.value);
        if (!n.ok) {
          refusals.push({ row: line, reason: `the non-standard '${LEEF_COUNT_KEY}' count could not be read: ${n.reason}`, field: LEEF_COUNT_KEY });
          continue;
        }
        candidate.requestCount = n.value;
        fieldsUsed.add(LEEF_COUNT_KEY);
      }

      finalizeRow("egress_log", candidate, line, rows, refusals);
    }

    return { kind: "egress_log", rows, refusals, rowsParsed, fieldsUsed: [...fieldsUsed], rowsWithoutTimestamp };
  },
};

// ===========================================================================
// 6. W3C EXTENDED — driven by the file's own `#Fields:` directive
// ===========================================================================

/** whitespace-separated with `"` quoting, per the W3C extended log format. */
export function tokenizeW3c(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        quoted = false;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      started = true;
      continue;
    }
    if (c === " " || c === "\t") {
      if (started || cur.length > 0) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += c;
  }
  if (started || cur.length > 0) out.push(cur);
  return out;
}

const W3C_HOST_FIELDS = ["cs-host", "cs(host)", "r-dns", "s-dns", "cs-uri", "x-cs-host"] as const;
const W3C_IDENTITY_FIELDS = ["cs-username", "cs-user", "c-ip"] as const;
const W3C_DATE_FIELD = "date";
const W3C_TIME_FIELD = "time";
const W3C_DATETIME_FIELDS = ["datetime", "date-time", "x-timestamp"] as const;

export const w3cExtendedAdapter: EvidenceAdapter = {
  id: "w3c_extended",
  displayName: "W3C extended log (proxy/gateway, driven by #Fields:)",
  formats: ["text"],
  formatBasis: "published-spec",
  capabilities: {
    destinationHost: true,
    sourceIdentity: true,
    perRowTimestamp: true,
    requestCount: false,
    selfDescribing: true,
    kinds: ["egress_log"],
  },
  verification:
    "Implements the PUBLISHED W3C extended log file format: the field list comes from the file's own '#Fields:' " +
    "directive (honoured again if it is redeclared mid-file), so column ORDER is never assumed. It has NOT been run " +
    "against a real export from any proxy or CASB product by this project.",
  limits:
    "REQUIRES a '#Fields:' directive — without one the whole file is refused rather than read positionally, because " +
    "guessing the column order of a proxy log is how a client IP becomes a destination. The destination is taken " +
    "from the first present of cs-host, cs(host), r-dns, s-dns or cs-uri; cs-uri-stem is deliberately NOT a " +
    "candidate, since a bare path names no destination and an origin-server log is not egress evidence. The actor " +
    "comes from cs-username, cs-user or c-ip. Every other field — status, bytes, user agent, category — is " +
    "discarded. Each line counts as ONE request: the format has no aggregate-count field, so a pre-aggregated " +
    "export will under-count unless you use `generic_mapped` and map the count column. A line whose token count " +
    "disagrees with '#Fields:' is refused naming both counts.",
  parse(input) {
    textAdapterConfigSchema.parse(input.config ?? {});
    const rows: Array<Record<string, unknown>> = [];
    const refusals: EvidenceRowRefusal[] = [];
    const fieldsUsed = new Set<string>();
    let rowsParsed = 0;
    let rowsWithoutTimestamp = 0;
    let fields: string[] | null = null;
    let sawAnyFields = false;

    const lines = numberedLines(input.content).filter((l) => l.text.trim().length > 0);
    boundRows(lines.length, "w3c_extended");

    for (const { line, text } of lines) {
      const trimmed = text.trim();
      if (trimmed.startsWith("#")) {
        const colon = trimmed.indexOf(":");
        const directive = (colon === -1 ? trimmed.slice(1) : trimmed.slice(1, colon)).trim().toLowerCase();
        if (directive === "fields" && colon !== -1) {
          const declaredFields = tokenizeW3c(trimmed.slice(colon + 1))
            .map((f) => f.trim().toLowerCase())
            .filter((f) => f.length > 0);
          // a `#Fields:` line that declares nothing leaves us with no reading,
          // which must stay indistinguishable from having no directive at all
          fields = declaredFields.length > 0 ? declaredFields : null;
          sawAnyFields = true;
        }
        continue;
      }
      if (fields === null) {
        throw new EvidenceFormatError(
          sawAnyFields
            ? "the '#Fields:' directive in this file declares no fields"
            : `this file carries no '#Fields:' directive before its first data line (line ${line}). A W3C extended log ` +
              `without it cannot be read without assuming a column order, which RegulAIt refuses to do — use ` +
              `'proxy_common' with a declared layout, or 'generic_mapped' with an explicit mapping.`,
          { adapter: "w3c_extended", missing: ["#Fields:"] },
        );
      }
      const declared = fields;
      rowsParsed += 1;
      const tokens = tokenizeW3c(text);
      if (tokens.length !== declared.length) {
        refusals.push({
          row: line,
          reason: `this line has ${tokens.length} field(s) but '#Fields:' declares ${declared.length} — refusing rather than aligning them by position`,
        });
        continue;
      }
      const bag = new AttributeBag();
      declared.forEach((name, i) => bag.set(name, tokens[i]!));

      const host = bag.first(W3C_HOST_FIELDS);
      if (!host) {
        refusals.push({
          row: line,
          reason:
            `this line names no destination: none of ${W3C_HOST_FIELDS.join(", ")} carries a value ` +
            `(the declared fields are [${declared.slice(0, 15).join(", ")}]).`,
          field: W3C_HOST_FIELDS.join("|"),
        });
        continue;
      }
      if (host.value.startsWith("/")) {
        refusals.push({
          row: line,
          reason:
            `'${host.key}' holds '${host.value.slice(0, 60)}', which is a PATH, not a destination. A log whose ` +
            `request target is a path came from an origin server, not a forward proxy, and names nothing to attribute ` +
            `egress to.`,
          field: host.key,
        });
        continue;
      }
      fieldsUsed.add(host.key);
      const candidate: Record<string, unknown> = { destinationHost: host.value };

      const who = bag.first(W3C_IDENTITY_FIELDS);
      if (who) {
        candidate.sourceIdentity = who.value;
        fieldsUsed.add(who.key);
      }

      const combined = bag.first(W3C_DATETIME_FIELDS);
      const date = bag.first([W3C_DATE_FIELD]);
      const time = bag.first([W3C_TIME_FIELD]);
      const stamp = combined ? combined.value : date ? (time ? `${date.value}T${time.value}` : date.value) : null;
      if (stamp !== null) {
        const ts = parseEvidenceTimestamp(stamp);
        if (!ts.ok) {
          refusals.push({
            row: line,
            reason: `the timestamp could not be read: ${ts.reason}`,
            field: combined ? combined.key : time ? `${W3C_DATE_FIELD}+${W3C_TIME_FIELD}` : W3C_DATE_FIELD,
          });
          continue;
        }
        candidate.observedAt = ts.value;
        fieldsUsed.add(combined ? combined.key : W3C_DATE_FIELD);
      } else {
        rowsWithoutTimestamp += 1;
      }

      finalizeRow("egress_log", candidate, line, rows, refusals);
    }

    if (fields === null) {
      throw new EvidenceFormatError(
        "this file carries no '#Fields:' directive and no data lines — nothing could be read",
        { adapter: "w3c_extended", missing: ["#Fields:"] },
      );
    }
    return { kind: "egress_log", rows, refusals, rowsParsed, fieldsUsed: [...fieldsUsed], rowsWithoutTimestamp };
  },
};

// ===========================================================================
// 7. PROXY COMMON — Squid native and NCSA common/combined, layout DECLARED
// ===========================================================================

export const PROXY_LAYOUTS = ["squid", "common", "combined"] as const;
export type ProxyLayout = (typeof PROXY_LAYOUTS)[number];

export const proxyCommonConfigSchema = z
  .object({
    /** REQUIRED. These formats are positional and carry no header, so the
     * layout is an operator assertion rather than something we sniff — a
     * mis-sniffed layout reads the client IP column as the destination. */
    layout: z.enum(PROXY_LAYOUTS),
  })
  .strict();

/** whitespace-separated, with `"…"` and `[…]` groups kept whole. */
export function tokenizeClf(line: string): { tokens: string[]; unterminated: boolean } {
  const out: string[] = [];
  let cur = "";
  let group: "" | "quote" | "bracket" = "";
  let started = false;
  const flush = () => {
    if (started || cur.length > 0) {
      out.push(cur);
      cur = "";
      started = false;
    }
  };
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (group === "quote") {
      if (c === '"') {
        group = "";
        flush();
      } else cur += c;
      continue;
    }
    if (group === "bracket") {
      if (c === "]") {
        group = "";
        flush();
      } else cur += c;
      continue;
    }
    if (c === '"') {
      flush();
      group = "quote";
      started = true;
      continue;
    }
    if (c === "[") {
      flush();
      group = "bracket";
      started = true;
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      continue;
    }
    cur += c;
  }
  flush();
  return { tokens: out, unterminated: group !== "" };
}

const SQUID_MIN_FIELDS = 7;

export const proxyCommonAdapter: EvidenceAdapter = {
  id: "proxy_common",
  displayName: "Squid native / NCSA common / NCSA combined proxy log",
  formats: ["text"],
  formatBasis: "published-spec",
  capabilities: {
    destinationHost: true,
    sourceIdentity: true,
    perRowTimestamp: true,
    requestCount: false,
    selfDescribing: false,
    kinds: ["egress_log"],
  },
  verification:
    "Implements the documented Squid `access.log` native layout and the NCSA common/combined layouts. These formats " +
    "carry NO header, so the layout is an OPERATOR ASSERTION (`config.layout`) and is never sniffed. It has NOT been " +
    "run against a real export from any deployment by this project.",
  limits:
    "`config.layout` is required and is not guessed — a mis-declared layout would read the client-IP column as the " +
    "destination, so there is no default. For the NCSA layouts the request target must be an ABSOLUTE URI, which is " +
    "what a FORWARD PROXY logs; a line whose target is a path is refused, because an origin-server access log is not " +
    "egress evidence about anybody. Squid's `%ul` ident column is used as the actor when present and the client " +
    "address otherwise, so many rows attribute to an IP rather than a person. Each line is ONE request — none of " +
    "these formats has an aggregate-count field. Only the standard column counts are accepted (>= 7 for Squid, " +
    "exactly 7 for common and 9 for combined): a custom `logformat` is refused naming the counts rather than " +
    "misaligned.",
  parse(input) {
    const cfg = proxyCommonConfigSchema.parse(input.config ?? {});
    const rows: Array<Record<string, unknown>> = [];
    const refusals: EvidenceRowRefusal[] = [];
    const fieldsUsed = new Set<string>();
    let rowsParsed = 0;
    let rowsWithoutTimestamp = 0;

    const lines = numberedLines(input.content).filter((l) => l.text.trim().length > 0 && !l.text.trim().startsWith("#"));
    boundRows(lines.length, "proxy_common");

    for (const { line, text } of lines) {
      rowsParsed += 1;
      if (cfg.layout === "squid") {
        const tokens = text.trim().split(" ").filter((t) => t.length > 0);
        if (tokens.length < SQUID_MIN_FIELDS) {
          refusals.push({
            row: line,
            reason: `a Squid native access.log line has at least ${SQUID_MIN_FIELDS} whitespace-separated columns; this line has ${tokens.length}`,
          });
          continue;
        }
        const ts = parseEvidenceTimestamp(tokens[0]!);
        if (!ts.ok) {
          refusals.push({ row: line, reason: `the Squid timestamp column could not be read: ${ts.reason}`, field: "time" });
          continue;
        }
        const url = tokens[6]!;
        if (url === "-" || url.length === 0) {
          refusals.push({ row: line, reason: "the Squid URL column is empty", field: "url" });
          continue;
        }
        const ident = tokens.length > 7 ? tokens[7]! : "-";
        const candidate: Record<string, unknown> = {
          destinationHost: url,
          sourceIdentity: ident !== "-" && ident.length > 0 ? ident : tokens[2]!,
          observedAt: ts.value,
        };
        fieldsUsed.add("time").add("url").add(ident !== "-" ? "rfc931" : "client");
        finalizeRow("egress_log", candidate, line, rows, refusals);
        continue;
      }

      const expected = cfg.layout === "combined" ? 9 : 7;
      const { tokens, unterminated } = tokenizeClf(text);
      if (unterminated) {
        refusals.push({ row: line, reason: "this line opens a quoted or bracketed field it never closes" });
        continue;
      }
      if (tokens.length !== expected) {
        refusals.push({
          row: line,
          reason: `an NCSA ${cfg.layout} line has ${expected} fields; this line has ${tokens.length} — refusing rather than aligning them by position`,
        });
        continue;
      }
      const [client, , authuser, stamp, request] = tokens as [string, string, string, string, string];
      const ts = parseClfTimestamp(stamp);
      if (!ts.ok) {
        refusals.push({ row: line, reason: `the bracketed timestamp could not be read: ${ts.reason}`, field: "time" });
        continue;
      }
      const requestParts = request.split(" ").filter((t) => t.length > 0);
      if (requestParts.length < 2) {
        refusals.push({ row: line, reason: `the request field '${request.slice(0, 60)}' is not 'METHOD target PROTO'`, field: "request" });
        continue;
      }
      const target = requestParts[1]!;
      if (!target.includes("://")) {
        refusals.push({
          row: line,
          reason:
            `the request target '${target.slice(0, 60)}' is a path, not an absolute URI. A common-log line from an ` +
            `ORIGIN server names no destination host, so it is not egress evidence — this adapter reads FORWARD-PROXY ` +
            `logs.`,
          field: "request",
        });
        continue;
      }
      fieldsUsed.add("time").add("request").add(authuser !== "-" ? "authuser" : "host");
      finalizeRow(
        "egress_log",
        {
          destinationHost: target,
          sourceIdentity: authuser !== "-" && authuser.length > 0 ? authuser : client,
          observedAt: ts.value,
        },
        line,
        rows,
        refusals,
      );
    }

    return { kind: "egress_log", rows, refusals, rowsParsed, fieldsUsed: [...fieldsUsed], rowsWithoutTimestamp };
  },
};

// ===========================================================================
// 8. GENERIC MAPPED — the one that will actually get used
// ===========================================================================

/** the mappable field name -> header candidates, per evidence kind. Used ONLY
 * for inference, which refuses on ambiguity; an explicit mapping never consults
 * this table. */
const EVIDENCE_ALIASES: Record<string, string[]> = {
  destinationHost: ["destination_host", "destination", "host", "hostname", "url", "domain", "fqdn", "dest_host", "dst_host", "server"],
  sourceIdentity: ["source_identity", "user", "username", "user_email", "email", "actor", "client_ip", "src_ip", "source", "device"],
  observedAt: ["observed_at", "timestamp", "time", "date", "datetime", "event_time", "occurred_at"],
  requestCount: ["request_count", "requests", "count", "hits", "sessions", "transactions"],
  repo: ["repo", "repository", "project", "codebase"],
  path: ["path", "file", "file_path", "filename"],
  packageName: ["package", "package_name", "dependency", "library", "module"],
  keyFragment: ["key_fragment", "secret_fragment", "match", "redacted_key"],
  keyLength: ["key_length", "secret_length"],
  appName: ["app", "app_name", "application", "application_name", "integration"],
  vendorHost: ["vendor_host", "publisher_host", "app_host", "url", "domain", "host"],
  grantedBy: ["granted_by", "authorized_by", "user", "user_email", "email", "owner"],
  installCount: ["install_count", "installs", "users", "user_count", "assignments"],
  owner: ["owner", "team", "owner_team", "department"],
  system: ["system", "service", "application", "workload"],
  provider: ["provider", "vendor", "model_provider"],
  note: ["note", "notes", "comment", "description"],
};

interface KindFieldSpec {
  required: readonly string[];
  optional: readonly string[];
  counts: readonly string[];
  timestamps: readonly string[];
}

/** exactly the fields ADR-0055's row schemas define — nothing else is mappable,
 * which is why an operator-authored mapping still cannot widen what an import
 * can say. */
export const EVIDENCE_KIND_FIELDS: Record<EvidenceKind, KindFieldSpec> = {
  egress_log: {
    required: ["destinationHost"],
    optional: ["sourceIdentity", "observedAt", "requestCount"],
    counts: ["requestCount"],
    timestamps: ["observedAt"],
  },
  code_scan: {
    required: ["repo"],
    optional: ["path", "packageName", "keyFragment", "keyLength", "observedAt"],
    counts: ["keyLength"],
    timestamps: ["observedAt"],
  },
  saas_export: {
    required: ["appName", "vendorHost"],
    optional: ["grantedBy", "installCount", "observedAt"],
    counts: ["installCount"],
    timestamps: ["observedAt"],
  },
  self_reported: {
    required: ["owner", "system", "provider"],
    optional: ["note", "observedAt"],
    counts: [],
    timestamps: ["observedAt"],
  },
};

export const genericEvidenceConfigSchema = z
  .object({
    kind: z.enum(EVIDENCE_KINDS),
    /** column name per evidence field. Omit to attempt inference. */
    mapping: z.record(z.string(), z.string().min(1).max(200)).optional(),
  })
  .strict();

const normalizeHeaderName = (h: string) => {
  let out = "";
  for (const c of h.trim().toLowerCase()) out += c === " " || c === "-" || c === "." ? "_" : c;
  return out;
};

/**
 * Infer a mapping from the headers, REFUSING ON AMBIGUITY for any required
 * field. ADR-0069's rule, and for the same reason: an importer that guesses
 * which of `host` and `url` is the destination is an importer that will one day
 * attribute a company's AI usage to the wrong system.
 */
export function inferEvidenceMapping(
  kind: EvidenceKind,
  headers: string[],
): { ok: true; mapping: Record<string, string> } | { ok: false; reason: string } {
  const byNorm = new Map<string, string>();
  for (const h of headers) {
    const n = normalizeHeaderName(h);
    if (!byNorm.has(n)) byNorm.set(n, h);
  }
  const spec = EVIDENCE_KIND_FIELDS[kind];
  const pick = (field: string) => {
    const candidates = (EVIDENCE_ALIASES[field] ?? []).filter((a) => byNorm.has(a)).map((a) => byNorm.get(a)!);
    return [...new Set(candidates)];
  };
  const mapping: Record<string, string> = {};
  for (const field of spec.required) {
    const candidates = pick(field);
    if (candidates.length === 0) {
      return {
        ok: false,
        reason:
          `no '${field}' column could be inferred for a ${kind} row from headers [${headers.join(", ")}] — ` +
          `supply an explicit \`config.mapping\``,
      };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        reason:
          `the '${field}' column is ambiguous for a ${kind} row (${candidates.join(", ")} all match) — ` +
          `supply an explicit \`config.mapping\` rather than have RegulAIt guess`,
      };
    }
    mapping[field] = candidates[0]!;
  }
  for (const field of spec.optional) {
    const candidates = pick(field);
    // an ambiguous OPTIONAL column is simply not mapped: the row still parses,
    // it just carries less. Only the required ones are worth refusing over.
    if (candidates.length === 1 && !Object.values(mapping).includes(candidates[0]!)) mapping[field] = candidates[0]!;
  }
  return { ok: true, mapping };
}

export const genericMappedEvidenceAdapter: EvidenceAdapter = {
  id: "generic_mapped",
  displayName: "Generic mapped CSV/JSON evidence export",
  formats: ["csv", "json"],
  formatBasis: "operator-mapped",
  capabilities: {
    destinationHost: true,
    sourceIdentity: true,
    perRowTimestamp: true,
    requestCount: true,
    selfDescribing: true,
    kinds: EVIDENCE_KINDS,
  },
  verification:
    "Assumes nothing about your file: the operator names the columns, or header inference proposes them and REFUSES " +
    "on ambiguity. This is the adapter to reach for when a vendor's export does not match a published grammar — " +
    "including a CASB/SSO app-access export, which has no published format at all and which this project has " +
    "therefore deliberately NOT shipped a named preset for.",
  limits:
    "Maps columns you name; it does not understand your vendor's semantics. It cannot tell a blocked request from " +
    "an allowed one, cannot tell a pre-aggregated row from a single event beyond the count column you map, and does " +
    "not de-duplicate rows a vendor split across lines. Unmapped columns are DISCARDED rather than retained, so " +
    "anything you did not map is not stored anywhere. Header inference refuses on ambiguity, so an export carrying " +
    "both `host` and `url` needs an explicit mapping. A missing REQUIRED cell refuses that row naming the column; " +
    "it is never defaulted.",
  parse(input) {
    const cfg = genericEvidenceConfigSchema.parse(input.config ?? {});
    const kind = cfg.kind;
    const spec = EVIDENCE_KIND_FIELDS[kind];

    // ONE table reader for the whole codebase: ADR-0069's `readSourceTable`
    // already handles CSV (with real RFC-4180 quoting and true line numbers)
    // and JSON. Its whole-file error is re-thrown in this module's own type so
    // a caller has one error class to handle.
    if (input.format !== "csv" && input.format !== "json") {
      throw new EvidenceFormatError(
        `generic_mapped reads csv or json; '${input.format}' is line-oriented log text — use one of the log adapters`,
        { adapter: "generic_mapped" },
      );
    }
    const tableInput: CostImportAdapterInput = { content: input.content, format: input.format, config: input.config };
    let table;
    try {
      table = readSourceTable(tableInput, "generic_mapped");
    } catch (e) {
      if (e instanceof CostImportFormatError) {
        throw new EvidenceFormatError(e.message, {
          adapter: "generic_mapped",
          ...(e.detail.headersFound ? { found: e.detail.headersFound } : {}),
        });
      }
      throw e;
    }
    boundRows(table.records.length, "generic_mapped");

    const allowed = new Set<string>([...spec.required, ...spec.optional]);
    let mapping = cfg.mapping;
    if (mapping) {
      const unknown = Object.keys(mapping).filter((k) => !allowed.has(k));
      if (unknown.length > 0) {
        throw new EvidenceFormatError(
          `a ${kind} row has no field(s) ${unknown.join(", ")} — the mappable fields are ${[...allowed].join(", ")}. ` +
            `An evidence row's vocabulary is fixed by ADR-0055; a mapping cannot widen it.`,
          { adapter: "generic_mapped", found: [...allowed] },
        );
      }
      const known = new Set(table.headers.map((h) => h.trim().toLowerCase()));
      const missing = Object.entries(mapping)
        .filter(([, col]) => !known.has(col.trim().toLowerCase()))
        .map(([field, col]) => `${field} -> '${col}'`);
      if (missing.length > 0) {
        throw new EvidenceFormatError(`the file does not carry the mapped column(s) ${missing.join(", ")}`, {
          adapter: "generic_mapped",
          missing,
          found: table.headers,
        });
      }
    } else {
      const inferred = inferEvidenceMapping(kind, table.headers);
      if (!inferred.ok) {
        throw new EvidenceFormatError(inferred.reason, { adapter: "generic_mapped", found: table.headers });
      }
      mapping = inferred.mapping;
    }
    const map = mapping;

    const rows: Array<Record<string, unknown>> = [];
    const refusals: EvidenceRowRefusal[] = [];
    let rowsWithoutTimestamp = 0;

    for (const rec of table.records) {
      const candidate: Record<string, unknown> = {};
      let refused = false;
      for (const field of [...spec.required, ...spec.optional]) {
        const col = map[field];
        if (!col) continue;
        const raw = (rec.get(col) ?? "").trim();
        if (raw.length === 0 || raw === "-") {
          if (spec.required.includes(field)) {
            refusals.push({
              row: rec.line,
              reason: `the required '${field}' column '${col}' is empty on this row — an evidence row with no ${field} observes nothing, and defaulting it would invent an observation`,
              field: col,
            });
            refused = true;
            break;
          }
          continue;
        }
        if (spec.counts.includes(field)) {
          const n = parseCountCell(raw);
          if (!n.ok) {
            refusals.push({ row: rec.line, reason: `'${col}': ${n.reason}`, field: col });
            refused = true;
            break;
          }
          candidate[field] = n.value;
          continue;
        }
        if (spec.timestamps.includes(field)) {
          const ts = parseEvidenceTimestamp(raw);
          if (!ts.ok) {
            refusals.push({ row: rec.line, reason: `'${col}': ${ts.reason}`, field: col });
            refused = true;
            break;
          }
          candidate[field] = ts.value;
          continue;
        }
        candidate[field] = raw;
      }
      if (refused) continue;
      if (candidate.observedAt === undefined) rowsWithoutTimestamp += 1;
      finalizeRow(kind, candidate, rec.line, rows, refusals);
    }

    return {
      kind,
      rows,
      refusals,
      rowsParsed: table.records.length,
      fieldsUsed: Object.values(map),
      rowsWithoutTimestamp,
    };
  },
};

// ===========================================================================
// 9. THE REGISTRY
// ===========================================================================

function boundRows(count: number, adapter: string): void {
  if (count > EVIDENCE_MAX_ROWS) {
    throw new EvidenceFormatError(
      `the file carries ${count} candidate row(s), over the ${EVIDENCE_MAX_ROWS}-row evidence import bound — split the export`,
      { adapter },
    );
  }
}

export const EVIDENCE_ADAPTERS: readonly EvidenceAdapter[] = Object.freeze([
  cefAdapter,
  leefAdapter,
  w3cExtendedAdapter,
  proxyCommonAdapter,
  genericMappedEvidenceAdapter,
]);

export const EVIDENCE_ADAPTER_IDS = EVIDENCE_ADAPTERS.map((a) => a.id);

export function getEvidenceAdapter(id: string): EvidenceAdapter | undefined {
  return EVIDENCE_ADAPTERS.find((a) => a.id === id);
}

/** the registry surface, for `GET /v1/shadow-ai/adapters` */
export function describeEvidenceAdapters(): Array<{
  id: string;
  displayName: string;
  formats: readonly EvidenceSourceFormat[];
  capabilities: EvidenceAdapterCapabilities;
  formatBasis: EvidenceFormatBasis;
  verification: string;
  limits: string;
}> {
  return EVIDENCE_ADAPTERS.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    formats: a.formats,
    capabilities: a.capabilities,
    formatBasis: a.formatBasis,
    verification: a.verification,
    limits: a.limits,
  }));
}

/**
 * The sentence that must accompany any adapter listing or raw import. Exported
 * so the gateway, the tests and the ADR cannot drift from each other.
 */
export const EVIDENCE_ADAPTER_POSTURE =
  "An adapter reads a file you exported. regulAIt ships no collector, sits on no network path, and " +
  "discovers nothing on its own: these adapters remove the manual reshaping step between your export and " +
  "regulAIt's evidence model, and change nothing about coverage. Coverage remains exactly what you exported. " +
  "Each adapter states whether it implements a published format or was mapped by you — and none of " +
  "them has been verified against a live export from any vendor's product by this project.";

// ===========================================================================
// 10. THE REQUEST SHAPE
// ===========================================================================

export const RAW_EVIDENCE_MALFORMED_POLICIES = ["refuse_file", "report_and_continue"] as const;
export type RawEvidenceMalformedPolicy = (typeof RAW_EVIDENCE_MALFORMED_POLICIES)[number];

export const rawEvidenceImportRequestSchema = z
  .object({
    adapter: z.string().min(1).max(60),
    format: z.enum(EVIDENCE_SOURCE_FORMATS).default("text"),
    mode: z.enum(["dry_run", "apply"]).default("dry_run"),
    /** the file, verbatim */
    content: z.string().min(1),
    /** a filename or a sentence about where it came from — provenance */
    source: z.string().min(1).max(200).optional(),
    /** adapter-specific configuration */
    config: z.unknown().optional(),
    /**
     * WHAT TO DO WITH A LINE THAT WILL NOT PARSE. The default REFUSES THE WHOLE
     * FILE, because the failure this slice most needs to prevent is a quietly
     * smaller inventory that looks complete. `report_and_continue` is the opt-in
     * for a genuinely ragged 5,000-line proxy export — and it still returns every
     * refusal with its line number and still records the counts on the import row.
     */
    onMalformedRow: z.enum(RAW_EVIDENCE_MALFORMED_POLICIES).default("refuse_file"),
  })
  .strict();

export type RawEvidenceImportRequest = z.infer<typeof rawEvidenceImportRequestSchema>;
