/**
 * ADR-0069 — CROSS-VENDOR COST CONSOLIDATION, the pure half.
 *
 *   THIS FILE                              the untrusted-file envelope, the
 *                                          adapter interface + registry, the
 *                                          five adapters, the identity-
 *                                          resolution rules and the
 *                                          consolidation math. Pure — no db,
 *                                          no clock, no Fastify, no network.
 *   `apps/gateway/src/cost-import.ts`      persistence, the PII/guardrail
 *                                          ingest gate, entitlement scoping,
 *                                          the admin API and the audit rows.
 *
 * THE ONE IDEA THIS MODULE EXISTS TO PROTECT
 * ------------------------------------------
 * Every cost figure in RegulAIt is one of exactly two things and must say which:
 *
 *   `metered`   RegulAIt saw the call, priced it, and wrote a `usage_events`
 *               row. We OBSERVED it.
 *   `imported`  a customer exported a number out of somebody else's console and
 *               handed it to us. We were TOLD it.
 *
 * These are not two grades of the same number. A metered figure is reproducible
 * from our own ledger; an imported figure is a restatement of a document we
 * cannot verify, whose account column may not resolve to a human, whose seat
 * price may have been typed in by an operator, and which may be denominated in
 * a currency we will not convert. Blending them into one total is the specific
 * dishonesty this whole slice exists to avoid — so `consolidate()` below has no
 * blended total to return, not as a policy but as a matter of type: there is no
 * field for it.
 *
 * WHAT AN IMPORT CAN DO, EXHAUSTIVELY
 * -----------------------------------
 * Produce `ParsedCostLine`s. That is the entire vocabulary. There is no field
 * in any adapter output that names a user to create, a role, a grant, an
 * entitlement, an agent, an approval, a project or a budget. `userId` is not an
 * adapter output at all — it is decided afterwards by `resolveVendorAccount`,
 * which can only ever return a user that ALREADY EXISTS or `null`. A file
 * cannot invent a person, and it cannot invent the mapping onto one either:
 * aliases and domain rules are admin-authored rows.
 *
 * NEVER TRUST THE FILE
 * --------------------
 *  - Bytes and rows are bounded before anything is walked.
 *  - Every malformed row is REFUSED WITH A REASON AND ITS FILE LINE NUMBER and
 *    counted. A silently dropped row is a wrong total presented confidently,
 *    which is worse than a refusal, so there is no code path that drops one.
 *  - Numbers and dates are parsed by CHARACTER SCAN, never by a regex evaluated
 *    over imported text (the ADR-0055 rule — see `packages/shared/src/shadow-ai.ts`'s
 *    "NO REGEX FROM DATA" note; the same reasoning applies verbatim here).
 *  - An ambiguous date (`07/08/2026` — is that August or July?) is refused
 *    rather than guessed. A guessed date silently moves spend between periods.
 *  - Unmapped columns are DISCARDED, not retained. A vendor export is full of
 *    free text nobody audited; keeping it "just in case" is how an invoice
 *    importer becomes a PII store.
 */
import { z } from "zod";
import { parseCsvRecords } from "./onboarding.js";

// ===========================================================================
// 1. BOUNDS — the untrusted-file envelope
// ===========================================================================

/** raw request bytes accepted before anything is parsed */
export const COST_IMPORT_MAX_BYTES = 4_000_000;
/** records in one file. A year of CUR is millions; a customer chunks it. */
export const COST_IMPORT_MAX_ROWS = 20_000;
/** columns in one header row — a bound on the mapping search, not on the file */
export const COST_IMPORT_MAX_COLUMNS = 200;
/** longest free-text value kept from any single cell */
export const COST_IMPORT_TEXT_MAX = 300;
/** the largest single line amount accepted. A cost file with a $10bn line item
 * is a units error (cents-as-dollars, or a stray column) far more often than it
 * is a real charge, and a units error that lands silently poisons every rollup
 * it touches for ever. Refused with the row number, like any other bad cell. */
export const COST_IMPORT_MAX_LINE_USD = 1_000_000_000;

// ===========================================================================
// 2. THE BASIS — the honesty spine, expressed as a type
// ===========================================================================

export const COST_BASES = ["metered", "imported"] as const;
export type CostBasis = (typeof COST_BASES)[number];

/** the sentence that must accompany any figure containing imported spend.
 * Exported so the gateway, the CSV and the ADR cannot drift from each other. */
export const IMPORTED_BASIS_STATEMENT =
  "`imported` figures are a customer-supplied export, restated. RegulAIt did not observe these calls, " +
  "did not price them, and cannot verify them. They are never added to `metered` spend to form a single " +
  "number: the split is the figure.";

export const COST_BILLING_KINDS = ["seat", "usage", "commit", "other"] as const;
export type CostBillingKind = (typeof COST_BILLING_KINDS)[number];

// ===========================================================================
// 3. THE ADAPTER INTERFACE — a new vendor is a new adapter, not a code path
// ===========================================================================

/** what an adapter produces. Note what is ABSENT: no userId, no projectId, no
 * grant, no role, no agent. Identity is decided afterwards, against rows an
 * admin authored. */
export interface ParsedCostLine {
  /** 1-based line number in the file this came from — the traceability anchor */
  sourceRow: number;
  /** the vendor account identifier EXACTLY as the file spelled it */
  accountRef: string;
  vendor: string;
  amount: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  billingKind: CostBillingKind;
  service: string | null;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  /** a cost centre the FILE asserted. The resolved user's own cost centre is a
   * separate, lower-precedence source and is applied by the gateway. */
  costCenter: string | null;
  /** bounded, adapter-authored structured notes. Never a dump of the row. */
  detail: Record<string, string | number> | null;
}

export interface CostRowRefusal {
  /** 1-based file line number. Always present — a refusal without a locus is
   * an apology, not a report. */
  row: number;
  reason: string;
  /** the column that caused it, when the failure is attributable to one */
  field?: string;
}

export interface CostImportParseResult {
  lines: ParsedCostLine[];
  refusals: CostRowRefusal[];
  /** data records seen, EXCLUDING the header. accepted + refused === parsed,
   * always — asserted in the unit suite, because that identity is the whole
   * claim that nothing was silently dropped. */
  rowsParsed: number;
  /** header columns the adapter recognised, for the operator's benefit */
  columnsUsed: string[];
}

/** a whole-file refusal: the adapter could not even establish a mapping. Kept
 * distinct from a per-row refusal so an operator is told "this is the wrong
 * file / the wrong adapter" instead of receiving 20,000 identical row errors. */
export class CostImportFormatError extends Error {
  readonly code = "unmappable_file";
  constructor(
    message: string,
    readonly detail: { adapter: string; missing?: string[]; headersFound?: string[] },
  ) {
    super(message);
    this.name = "CostImportFormatError";
  }
}

export interface CostImportAdapterCapabilities {
  /** does the format carry a per-account identifier at all? A `false` here
   * means every line lands unattributed unless an admin maps it. */
  accountIdentifier: boolean;
  /** is the account identifier an EMAIL (resolvable without an admin alias)? */
  accountIsEmail: boolean;
  perLinePeriod: boolean;
  quantity: boolean;
  service: boolean;
  currency: boolean;
  /** does the file itself carry the money, or does an operator assert it? */
  amountFromFile: boolean;
}

export interface CostImportAdapterInput {
  /** the file, verbatim */
  content: string;
  format: "csv" | "json";
  /** adapter-specific configuration, already zod-validated by the adapter */
  config?: unknown;
}

export interface CostImportAdapter {
  id: string;
  displayName: string;
  /** the vendor label lines default to. An adapter may override per row. */
  vendor: string;
  formats: ReadonlyArray<"csv" | "json">;
  capabilities: CostImportAdapterCapabilities;
  /**
   * WHAT THIS ADAPTER CANNOT DO, in plain words, returned by the API. Mirrors
   * `packages/infra-provider`'s and `packages/model-provider`'s convention: a
   * capability list that only says yes is marketing.
   */
  limits: string;
  parse(input: CostImportAdapterInput): CostImportParseResult;
}

// ===========================================================================
// 4. CHARACTER-SCANNED PARSERS — no regex over imported text
// ===========================================================================

/**
 * Parse a money cell. Accepts an optional leading currency symbol, thousands
 * commas, and accounting parentheses for negatives (a credit line is real spend
 * data and must survive). Rejects anything else — including the empty cell,
 * because an empty amount is not zero, it is a missing measurement.
 */
export function parseAmountCell(raw: string): { ok: true; value: number } | { ok: false; reason: string } {
  const s = raw.trim();
  if (s.length === 0) return { ok: false, reason: "amount cell is empty — an absent amount is not zero" };
  if (s.length > 40) return { ok: false, reason: "amount cell is implausibly long" };
  let i = 0;
  let negative = false;
  let paren = false;
  if (s[i] === "(") {
    paren = true;
    negative = true;
    i += 1;
  }
  if (s[i] === "-") {
    negative = true;
    i += 1;
  } else if (s[i] === "+") {
    i += 1;
  }
  if (s[i] === "$" || s[i] === "€" || s[i] === "£" || s[i] === "¥") i += 1;
  // a second sign after the symbol ("$-3.00") is a real accounting spelling
  if (s[i] === "-") {
    negative = true;
    i += 1;
  }
  let digits = "";
  let seenDot = false;
  for (; i < s.length; i += 1) {
    const c = s[i]!;
    if (c >= "0" && c <= "9") {
      digits += c;
      continue;
    }
    if (c === ",") continue; // thousands separator, positional check below
    if (c === ".") {
      if (seenDot) return { ok: false, reason: `'${raw}' has more than one decimal point` };
      seenDot = true;
      digits += ".";
      continue;
    }
    if (c === ")" && paren && i === s.length - 1) break;
    return { ok: false, reason: `'${raw}' is not a number (unexpected character '${c}')` };
  }
  if (paren && s[s.length - 1] !== ")") return { ok: false, reason: `'${raw}' opens a parenthesis it never closes` };
  if (digits.length === 0 || digits === ".") return { ok: false, reason: `'${raw}' contains no digits` };
  const value = Number(digits);
  if (!Number.isFinite(value)) return { ok: false, reason: `'${raw}' is not a finite number` };
  const signed = negative ? -value : value;
  if (Math.abs(signed) > COST_IMPORT_MAX_LINE_USD) {
    return {
      ok: false,
      reason: `'${raw}' exceeds the ${COST_IMPORT_MAX_LINE_USD} per-line ceiling — this is far more often a units error than a real charge`,
    };
  }
  return { ok: true, value: signed };
}

const isDigits = (s: string) => s.length > 0 && [...s].every((c) => c >= "0" && c <= "9");

/**
 * Parse a date cell into a UTC instant. Accepts, and ONLY accepts, unambiguous
 * spellings: `YYYY-MM-DD`, `YYYY/MM/DD`, `YYYY-MM-DDThh:mm[:ss][Z|±hh:mm]`, and
 * `YYYY-MM` (a month, which yields its first instant).
 *
 * `07/08/2026` is REFUSED. There is no way to know whether a vendor's export
 * used the American or the international order, and a wrong guess silently
 * moves money between reporting periods — the exact failure an FP&A team would
 * discover only in a dispute.
 */
export function parseDateCell(
  raw: string,
  opts: { endOfMonth?: boolean } = {},
): { ok: true; value: Date } | { ok: false; reason: string } {
  const s = raw.trim();
  if (s.length === 0) return { ok: false, reason: "date cell is empty" };
  if (s.length > 40) return { ok: false, reason: "date cell is implausibly long" };
  const datePart = s.includes("T") ? s.slice(0, s.indexOf("T")) : s.includes(" ") ? s.slice(0, s.indexOf(" ")) : s;
  const sep = datePart.includes("-") ? "-" : datePart.includes("/") ? "/" : "";
  if (sep === "") return { ok: false, reason: `'${raw}' is not a recognised date` };
  const parts = datePart.split(sep);
  if (parts.length < 2 || parts.length > 3) return { ok: false, reason: `'${raw}' is not a recognised date` };
  if (!isDigits(parts[0] ?? "")) return { ok: false, reason: `'${raw}' is not a recognised date` };
  if (parts[0]!.length !== 4) {
    return {
      ok: false,
      reason:
        `'${raw}' is ambiguous — RegulAIt accepts only year-first dates (YYYY-MM-DD, YYYY/MM/DD, YYYY-MM). ` +
        `A day-first/month-first guess silently moves spend between periods, so it is refused instead.`,
    };
  }
  const year = Number(parts[0]);
  if (!isDigits(parts[1] ?? "")) return { ok: false, reason: `'${raw}' has a non-numeric month` };
  const month = Number(parts[1]);
  const dayRaw = parts[2];
  if (parts.length === 3 && !isDigits(dayRaw ?? "")) return { ok: false, reason: `'${raw}' has a non-numeric day` };
  if (year < 1970 || year > 2200) return { ok: false, reason: `'${raw}' has an out-of-range year` };
  if (month < 1 || month > 12) return { ok: false, reason: `'${raw}' has an out-of-range month` };
  if (parts.length === 2) {
    // a bare month: the start of it, or the start of the NEXT one when this is
    // the exclusive end of a period
    const d = opts.endOfMonth
      ? new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1))
      : new Date(Date.UTC(year, month - 1, 1));
    return { ok: true, value: d };
  }
  const day = Number(dayRaw);
  if (day < 1 || day > 31) return { ok: false, reason: `'${raw}' has an out-of-range day` };
  let hh = 0;
  let mm = 0;
  let ss = 0;
  const timePart = s.length > datePart.length ? s.slice(datePart.length + 1) : "";
  if (timePart.length > 0) {
    const clean = timePart.endsWith("Z") ? timePart.slice(0, -1) : timePart;
    const tparts = clean.split(":");
    if (tparts.length < 2 || tparts.length > 3) return { ok: false, reason: `'${raw}' has an unrecognised time` };
    if (!isDigits(tparts[0] ?? "") || !isDigits(tparts[1] ?? "")) {
      return { ok: false, reason: `'${raw}' has an unrecognised time` };
    }
    hh = Number(tparts[0]);
    mm = Number(tparts[1]);
    if (tparts.length === 3) {
      const secs = tparts[2]!.includes(".") ? tparts[2]!.slice(0, tparts[2]!.indexOf(".")) : tparts[2]!;
      if (!isDigits(secs)) return { ok: false, reason: `'${raw}' has an unrecognised time` };
      ss = Number(secs);
    }
    if (hh > 23 || mm > 59 || ss > 59) return { ok: false, reason: `'${raw}' has an out-of-range time` };
  }
  const d = new Date(Date.UTC(year, month - 1, day, hh, mm, ss));
  // Date.UTC rolls 2026-02-31 into March rather than failing; catch it.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return { ok: false, reason: `'${raw}' is not a real calendar date` };
  }
  return { ok: true, value: d };
}

const trimText = (raw: string | undefined): string | null => {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (s.length === 0) return null;
  return s.length > COST_IMPORT_TEXT_MAX ? s.slice(0, COST_IMPORT_TEXT_MAX) : s;
};

/** currency codes are 3 ASCII letters. Anything else is refused rather than
 * normalised — we do not know what "US$" means to this vendor's ledger. */
function parseCurrencyCell(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const s = raw.trim().toUpperCase();
  if (s.length !== 3 || ![...s].every((c) => c >= "A" && c <= "Z")) {
    return { ok: false, reason: `'${raw}' is not a 3-letter ISO currency code` };
  }
  return { ok: true, value: s };
}

// ===========================================================================
// 5. THE ROW SOURCE — CSV and JSON reduced to one shape, with line numbers
// ===========================================================================

interface SourceRecord {
  line: number;
  get(column: string): string | undefined;
}

interface SourceTable {
  headers: string[];
  records: SourceRecord[];
}

const headerKey = (h: string) => h.trim().toLowerCase();

/** Read the file into `{headers, records}`. Both formats end up here so the
 * mapping, the refusal reporting and the row counting have exactly one
 * implementation. */
export function readSourceTable(input: CostImportAdapterInput, adapterId: string): SourceTable {
  if (input.format === "json") {
    let doc: unknown;
    try {
      doc = JSON.parse(input.content);
    } catch (e) {
      throw new CostImportFormatError(`the payload is not valid JSON: ${(e as Error).message}`, { adapter: adapterId });
    }
    const rows = Array.isArray(doc)
      ? doc
      : typeof doc === "object" && doc !== null && Array.isArray((doc as { rows?: unknown }).rows)
        ? ((doc as { rows: unknown[] }).rows)
        : null;
    if (rows === null) {
      throw new CostImportFormatError(
        "a JSON cost export must be an array of row objects, or an object with a `rows` array",
        { adapter: adapterId },
      );
    }
    const headers = new Set<string>();
    const records: SourceRecord[] = rows.map((r, i) => {
      const flat = new Map<string, string>();
      if (typeof r === "object" && r !== null && !Array.isArray(r)) {
        for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
          if (headers.size < COST_IMPORT_MAX_COLUMNS) headers.add(k);
          if (v === null || v === undefined) continue;
          if (typeof v === "object") continue; // nested structures are not cells
          flat.set(headerKey(k), String(v));
        }
      }
      // JSON arrays have no line numbers; row 1 is the first element, and the
      // offset of 1 keeps "row N" meaning the same thing to an operator as it
      // does for a CSV with a header line.
      return { line: i + 1, get: (c: string) => flat.get(headerKey(c)) };
    });
    return { headers: [...headers], records };
  }

  const raw = parseCsvRecords(input.content);
  const nonEmpty = raw.filter((r) => r.cells.some((c) => c.trim().length > 0));
  const headerRow = nonEmpty[0];
  if (!headerRow) throw new CostImportFormatError("the file has no header row", { adapter: adapterId });
  const headers = headerRow.cells.slice(0, COST_IMPORT_MAX_COLUMNS).map((h) => h.trim());
  const index = new Map<string, number>();
  headers.forEach((h, i) => {
    const k = headerKey(h);
    if (!index.has(k)) index.set(k, i);
  });
  const records: SourceRecord[] = nonEmpty.slice(1).map((r) => ({
    line: r.line,
    get: (c: string) => {
      const i = index.get(headerKey(c));
      return i === undefined ? undefined : r.cells[i];
    },
  }));
  return { headers, records };
}

// ===========================================================================
// 6. THE MAPPED READER — the one engine every adapter is built on
// ===========================================================================

export const costColumnMappingSchema = z
  .object({
    account: z.string().min(1).max(200),
    amount: z.string().min(1).max(200),
    /** one column holding the whole period, e.g. `2026-07` or `2026-07-01` */
    period: z.string().min(1).max(200).optional(),
    periodStart: z.string().min(1).max(200).optional(),
    periodEnd: z.string().min(1).max(200).optional(),
    currency: z.string().min(1).max(200).optional(),
    service: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(200).optional(),
    quantity: z.string().min(1).max(200).optional(),
    unit: z.string().min(1).max(200).optional(),
    costCenter: z.string().min(1).max(200).optional(),
    vendor: z.string().min(1).max(200).optional(),
  })
  .strict();

export type CostColumnMapping = z.infer<typeof costColumnMappingSchema>;

export const costImportDefaultsSchema = z
  .object({
    vendor: z.string().min(1).max(100).optional(),
    currency: z.string().length(3).optional(),
    billingKind: z.enum(COST_BILLING_KINDS).optional(),
    /** used when the FILE carries no period at all */
    periodStart: z.string().min(4).max(40).optional(),
    periodEnd: z.string().min(4).max(40).optional(),
  })
  .strict();

export type CostImportDefaults = z.infer<typeof costImportDefaultsSchema>;

interface MappedReadOptions {
  adapterId: string;
  mapping: CostColumnMapping;
  defaults: CostImportDefaults;
  fallbackVendor: string;
  billingKind: CostBillingKind;
  /** a per-row hook for adapters that add structured detail */
  detailFor?: (rec: SourceRecord) => Record<string, string | number> | null;
  /** when set, the amount is asserted by the operator rather than read from a
   * cell — the `seat_roster` case. `mapping.amount` is then ignored. */
  assertedAmountUsd?: number;
}

function readMapped(input: CostImportAdapterInput, opts: MappedReadOptions): CostImportParseResult {
  const table = readSourceTable(input, opts.adapterId);
  if (table.records.length > COST_IMPORT_MAX_ROWS) {
    throw new CostImportFormatError(
      `the file carries ${table.records.length} data rows, over the ${COST_IMPORT_MAX_ROWS}-row import bound — split the export`,
      { adapter: opts.adapterId },
    );
  }

  const known = new Set(table.headers.map(headerKey));
  const missing: string[] = [];
  const required: Array<[string, string | undefined]> = [
    ["account", opts.mapping.account],
    ...(opts.assertedAmountUsd === undefined
      ? ([["amount", opts.mapping.amount]] as Array<[string, string | undefined]>)
      : []),
  ];
  for (const [field, col] of required) {
    if (col && !known.has(headerKey(col))) missing.push(`${field} -> '${col}'`);
  }
  // an OPTIONAL column that was explicitly named but is absent is still a
  // mapping error: the operator asked for it and would otherwise silently get
  // nulls
  for (const field of ["period", "periodStart", "periodEnd", "currency", "service", "description", "quantity", "unit", "costCenter", "vendor"] as const) {
    const col = opts.mapping[field];
    if (col && !known.has(headerKey(col))) missing.push(`${field} -> '${col}'`);
  }
  if (missing.length > 0) {
    throw new CostImportFormatError(
      `the file does not carry the mapped column(s) ${missing.join(", ")}`,
      { adapter: opts.adapterId, missing, headersFound: table.headers },
    );
  }

  const hasPeriodColumns = Boolean(opts.mapping.period ?? (opts.mapping.periodStart && opts.mapping.periodEnd));
  const defaultStart = opts.defaults.periodStart ? parseDateCell(opts.defaults.periodStart) : null;
  const defaultEnd = opts.defaults.periodEnd ? parseDateCell(opts.defaults.periodEnd, { endOfMonth: true }) : null;
  if (!hasPeriodColumns) {
    if (!defaultStart?.ok || !defaultEnd?.ok) {
      throw new CostImportFormatError(
        "no period could be established: map `period`, or both `periodStart` and `periodEnd`, or supply both in `defaults`. " +
          "Spend with no period cannot be charged back to a month.",
        { adapter: opts.adapterId, missing: ["period"], headersFound: table.headers },
      );
    }
    if (defaultEnd.value <= defaultStart.value) {
      throw new CostImportFormatError("the default period ends at or before it starts", { adapter: opts.adapterId });
    }
  }

  const lines: ParsedCostLine[] = [];
  const refusals: CostRowRefusal[] = [];
  const columnsUsed = Object.values(opts.mapping).filter((v): v is string => typeof v === "string");

  for (const rec of table.records) {
    const refuse = (reason: string, field?: string) => {
      refusals.push(field === undefined ? { row: rec.line, reason } : { row: rec.line, reason, field });
    };

    const accountRaw = rec.get(opts.mapping.account);
    const accountRef = trimText(accountRaw);
    if (accountRef === null) {
      refuse(
        `no value in the account column '${opts.mapping.account}' — a cost line with no account cannot be attributed to anyone, and dropping it would understate the total`,
        opts.mapping.account,
      );
      continue;
    }
    if (accountRef.length > 200) {
      refuse(`the account value is longer than 200 characters`, opts.mapping.account);
      continue;
    }

    let amount: number;
    if (opts.assertedAmountUsd !== undefined) {
      amount = opts.assertedAmountUsd;
    } else {
      const raw = rec.get(opts.mapping.amount);
      if (raw === undefined) {
        refuse(`the amount column '${opts.mapping.amount}' is missing on this row`, opts.mapping.amount);
        continue;
      }
      const parsed = parseAmountCell(raw);
      if (!parsed.ok) {
        refuse(parsed.reason, opts.mapping.amount);
        continue;
      }
      amount = parsed.value;
    }

    let start: Date;
    let end: Date;
    if (opts.mapping.period) {
      const raw = rec.get(opts.mapping.period) ?? "";
      const s = parseDateCell(raw);
      const e = parseDateCell(raw, { endOfMonth: true });
      if (!s.ok) {
        refuse(s.reason, opts.mapping.period);
        continue;
      }
      if (!e.ok) {
        refuse(e.reason, opts.mapping.period);
        continue;
      }
      start = s.value;
      // a single-date period column that is a full date (not a bare month)
      // yields a one-day window rather than a whole month — we will not widen
      // a day into a month on the operator's behalf
      end = e.value > s.value ? e.value : new Date(s.value.getTime() + 24 * 3600 * 1000);
    } else if (opts.mapping.periodStart && opts.mapping.periodEnd) {
      const s = parseDateCell(rec.get(opts.mapping.periodStart) ?? "");
      if (!s.ok) {
        refuse(s.reason, opts.mapping.periodStart);
        continue;
      }
      const e = parseDateCell(rec.get(opts.mapping.periodEnd) ?? "", { endOfMonth: true });
      if (!e.ok) {
        refuse(e.reason, opts.mapping.periodEnd);
        continue;
      }
      if (e.value <= s.value) {
        refuse(`the period ends at or before it starts`, opts.mapping.periodEnd);
        continue;
      }
      start = s.value;
      end = e.value;
    } else {
      start = (defaultStart as { ok: true; value: Date }).value;
      end = (defaultEnd as { ok: true; value: Date }).value;
    }

    let currency = opts.defaults.currency ?? "USD";
    if (opts.mapping.currency) {
      const raw = rec.get(opts.mapping.currency);
      const t = trimText(raw);
      if (t !== null) {
        const c = parseCurrencyCell(t);
        if (!c.ok) {
          refuse(c.reason, opts.mapping.currency);
          continue;
        }
        currency = c.value;
      }
    }

    let quantity: number | null = null;
    if (opts.mapping.quantity) {
      const t = trimText(rec.get(opts.mapping.quantity));
      if (t !== null) {
        const q = parseAmountCell(t);
        if (!q.ok) {
          refuse(q.reason, opts.mapping.quantity);
          continue;
        }
        quantity = q.value;
      }
    }

    const vendorCell = opts.mapping.vendor ? trimText(rec.get(opts.mapping.vendor)) : null;

    lines.push({
      sourceRow: rec.line,
      accountRef,
      vendor: vendorCell ?? opts.defaults.vendor ?? opts.fallbackVendor,
      amount,
      currency,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      billingKind: opts.defaults.billingKind ?? opts.billingKind,
      service: opts.mapping.service ? trimText(rec.get(opts.mapping.service)) : null,
      description: opts.mapping.description ? trimText(rec.get(opts.mapping.description)) : null,
      quantity,
      unit: opts.mapping.unit ? trimText(rec.get(opts.mapping.unit)) : null,
      costCenter: opts.mapping.costCenter ? trimText(rec.get(opts.mapping.costCenter)) : null,
      detail: opts.detailFor?.(rec) ?? null,
    });
  }

  return { lines, refusals, rowsParsed: table.records.length, columnsUsed };
}

// ===========================================================================
// 7. THE ADAPTERS
// ===========================================================================

/** header aliases the generic adapter will INFER from, when — and only when —
 * exactly one candidate is present for a required field. */
const INFERENCE_ALIASES: Record<keyof CostColumnMapping, string[]> = {
  account: ["user", "user_email", "email", "account", "account_email", "member", "principal", "owner"],
  amount: ["amount", "cost", "cost_usd", "amount_usd", "total", "spend", "charge"],
  period: ["period", "month", "billing_period", "invoice_month"],
  periodStart: ["period_start", "start_date", "usage_start", "start"],
  periodEnd: ["period_end", "end_date", "usage_end", "end"],
  currency: ["currency", "currency_code"],
  service: ["service", "product", "model", "sku"],
  description: ["description", "line_item", "notes"],
  quantity: ["quantity", "qty", "units", "tokens"],
  unit: ["unit", "uom"],
  costCenter: ["cost_center", "cost_centre", "costcenter", "department"],
  vendor: ["vendor", "provider", "supplier"],
};

const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Infer a mapping from the headers, refusing on ambiguity. An importer that
 * guesses which of `cost` and `total` is the money is an importer that will one
 * day double-count an invoice; when both are present it refuses and asks.
 */
export function inferMapping(headers: string[]): { ok: true; mapping: CostColumnMapping } | { ok: false; reason: string } {
  const byNorm = new Map<string, string>();
  for (const h of headers) {
    const n = normalizeHeader(h);
    if (!byNorm.has(n)) byNorm.set(n, h);
  }
  const pick = (field: keyof CostColumnMapping): { hit: string | undefined; candidates: string[] } => {
    const candidates = INFERENCE_ALIASES[field].filter((a) => byNorm.has(a)).map((a) => byNorm.get(a)!);
    return { hit: candidates[0], candidates };
  };
  const account = pick("account");
  const amount = pick("amount");
  if (!account.hit) {
    return {
      ok: false,
      reason: `no account column could be inferred from headers [${headers.join(", ")}] — supply an explicit \`mapping\``,
    };
  }
  if (account.candidates.length > 1) {
    return {
      ok: false,
      reason: `the account column is ambiguous (${account.candidates.join(", ")} all match) — supply an explicit \`mapping\` rather than have RegulAIt guess`,
    };
  }
  if (!amount.hit) {
    return {
      ok: false,
      reason: `no amount column could be inferred from headers [${headers.join(", ")}] — supply an explicit \`mapping\``,
    };
  }
  if (amount.candidates.length > 1) {
    return {
      ok: false,
      reason: `the amount column is ambiguous (${amount.candidates.join(", ")} all match) — supply an explicit \`mapping\` rather than have RegulAIt guess`,
    };
  }
  const mapping: CostColumnMapping = { account: account.hit, amount: amount.hit };
  for (const field of ["period", "periodStart", "periodEnd", "currency", "service", "description", "quantity", "unit", "costCenter", "vendor"] as const) {
    const p = pick(field);
    // an ambiguous OPTIONAL column is simply not mapped — the row still parses,
    // it just carries less. Only the required ones are worth refusing over.
    if (p.hit && p.candidates.length === 1) mapping[field] = p.hit;
  }
  if (mapping.period && mapping.periodStart && mapping.periodEnd) delete mapping.period;
  if (mapping.periodStart && !mapping.periodEnd) delete mapping.periodStart;
  if (mapping.periodEnd && !mapping.periodStart) delete mapping.periodEnd;
  return { ok: true, mapping };
}

export const genericCsvConfigSchema = z
  .object({
    mapping: costColumnMappingSchema.optional(),
    defaults: costImportDefaultsSchema.optional(),
    billingKind: z.enum(COST_BILLING_KINDS).optional(),
  })
  .strict();

/**
 * THE ONE THAT WILL ACTUALLY GET USED. The long tail of vendors is longer than
 * any preset list, so this adapter is the product: an explicit column mapping
 * over any CSV or JSON export, with header inference as a convenience that
 * refuses rather than guesses.
 */
export const genericMappedAdapter: CostImportAdapter = {
  id: "generic_mapped",
  displayName: "Generic mapped CSV/JSON",
  vendor: "unspecified",
  formats: ["csv", "json"],
  capabilities: {
    accountIdentifier: true,
    accountIsEmail: false,
    perLinePeriod: true,
    quantity: true,
    service: true,
    currency: true,
    amountFromFile: true,
  },
  limits:
    "Maps columns you name; it does not understand your vendor's semantics. It cannot tell a credit from a charge " +
    "beyond the sign in the cell, cannot tell an amortised figure from an unblended one, does not de-duplicate line " +
    "items that a vendor split across rows, and does not convert currency. Header inference refuses on ambiguity " +
    "rather than guessing, so an export with both `cost` and `total` columns needs an explicit mapping.",
  parse(input) {
    const cfg = genericCsvConfigSchema.parse(input.config ?? {});
    let mapping = cfg.mapping;
    if (!mapping) {
      const table = readSourceTable(input, "generic_mapped");
      const inferred = inferMapping(table.headers);
      if (!inferred.ok) {
        throw new CostImportFormatError(inferred.reason, { adapter: "generic_mapped", headersFound: table.headers });
      }
      mapping = inferred.mapping;
    }
    return readMapped(input, {
      adapterId: "generic_mapped",
      mapping,
      defaults: cfg.defaults ?? {},
      fallbackVendor: "unspecified",
      billingKind: cfg.billingKind ?? "usage",
    });
  },
};

/** a preset is a FIXED mapping plus a strict header requirement. It does real
 * work (it knows the vendor's column names) and refuses loudly when the vendor
 * changes them, instead of silently mapping the wrong column. */
function presetAdapter(spec: {
  id: string;
  displayName: string;
  vendor: string;
  mapping: CostColumnMapping;
  billingKind: CostBillingKind;
  capabilities: CostImportAdapterCapabilities;
  limits: string;
  formats?: ReadonlyArray<"csv" | "json">;
}): CostImportAdapter {
  const configSchema = z.object({ defaults: costImportDefaultsSchema.optional() }).strict();
  return {
    id: spec.id,
    displayName: spec.displayName,
    vendor: spec.vendor,
    formats: spec.formats ?? ["csv", "json"],
    capabilities: spec.capabilities,
    limits: spec.limits,
    parse(input) {
      const cfg = configSchema.parse(input.config ?? {});
      return readMapped(input, {
        adapterId: spec.id,
        mapping: spec.mapping,
        defaults: { vendor: spec.vendor, ...(cfg.defaults ?? {}) },
        fallbackVendor: spec.vendor,
        billingKind: spec.billingKind,
      });
    },
  };
}

const PRESET_LIMIT_PREAMBLE =
  "Built against a DECLARED header set, not a live export verified against the vendor's console by this project. " +
  "If the vendor renames a column this adapter REFUSES the file naming the missing column rather than mapping the " +
  "wrong one; `generic_mapped` is then the escape hatch. ";

export const openAiConsoleAdapter = presetAdapter({
  id: "openai_console",
  displayName: "OpenAI console usage export",
  vendor: "openai",
  mapping: {
    account: "user",
    amount: "amount",
    period: "date",
    service: "model",
    quantity: "n_requests",
  },
  billingKind: "usage",
  capabilities: {
    accountIdentifier: true,
    accountIsEmail: true,
    perLinePeriod: true,
    quantity: true,
    service: true,
    currency: false,
    amountFromFile: true,
  },
  limits:
    PRESET_LIMIT_PREAMBLE +
    "Expects columns `date`, `user`, `model`, `n_requests`, `amount`; amounts are assumed USD because the export " +
    "carries no currency column. Organisation-level rows with no `user` value are REFUSED with their row number, " +
    "not spread across members — RegulAIt will not invent an allocation key.",
});

export const anthropicConsoleAdapter = presetAdapter({
  id: "anthropic_console",
  displayName: "Anthropic console usage export",
  vendor: "anthropic",
  mapping: {
    account: "workspace_member",
    amount: "cost_usd",
    periodStart: "usage_start",
    periodEnd: "usage_end",
    service: "model",
    quantity: "input_tokens",
  },
  billingKind: "usage",
  capabilities: {
    accountIdentifier: true,
    accountIsEmail: true,
    perLinePeriod: true,
    quantity: true,
    service: true,
    currency: false,
    amountFromFile: true,
  },
  limits:
    PRESET_LIMIT_PREAMBLE +
    "Expects `usage_start`, `usage_end`, `workspace_member`, `model`, `input_tokens`, `cost_usd`; amounts are " +
    "assumed USD. `input_tokens` is carried as the quantity, so a row's quantity is INPUT tokens only and is not a " +
    "total token count. Per-SEAT charges (Claude Code seats) are not in this export at all — use `seat_roster`.",
});

export const awsCurAdapter = presetAdapter({
  id: "aws_cur",
  displayName: "AWS Cost and Usage Report (CSV)",
  vendor: "aws",
  mapping: {
    account: "lineItem/UsageAccountId",
    amount: "lineItem/UnblendedCost",
    periodStart: "lineItem/UsageStartDate",
    periodEnd: "lineItem/UsageEndDate",
    service: "lineItem/ProductCode",
    quantity: "lineItem/UsageAmount",
    currency: "lineItem/CurrencyCode",
  },
  billingKind: "usage",
  capabilities: {
    accountIdentifier: true,
    // THE IMPORTANT `false` ON THIS PAGE. A CUR names an AWS account id, not a
    // human, so identity resolution CANNOT work by email for this adapter.
    accountIsEmail: false,
    perLinePeriod: true,
    quantity: true,
    service: true,
    currency: true,
    amountFromFile: true,
  },
  limits:
    PRESET_LIMIT_PREAMBLE +
    "The account identifier is an AWS ACCOUNT ID, not a person: every line lands UNATTRIBUTED until an admin creates " +
    "an alias mapping from that account id to a RegulAIt user, and a shared account maps to at most one user. Reads " +
    "`lineItem/UnblendedCost` only — amortised, blended and net-amortised columns are ignored, so a Savings-Plan or " +
    "RI-heavy account will not reconcile to the invoice. No cost-allocation-tag aggregation, no manifest handling, " +
    "no Parquet, and no filtering to AI services: the file is imported as given, so pointing this at a whole-estate " +
    "CUR imports the whole estate.",
});

export const seatRosterConfigSchema = z
  .object({
    /** the money. ASSERTED BY THE OPERATOR — the roster does not carry it. */
    seatPriceUsd: z.number().finite().min(0).max(1_000_000),
    vendor: z.string().min(1).max(100),
    periodStart: z.string().min(4).max(40),
    periodEnd: z.string().min(4).max(40),
    /** the column holding the seat holder's email */
    accountColumn: z.string().min(1).max(200).default("email"),
    planColumn: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * THE PER-SEAT SaaS CASE — Claude Code seats, Copilot seats, Cursor seats.
 *
 * This is the shape the whole slice exists for, and it is also the least
 * verifiable: a seat roster is a list of people, and the money lives on an
 * invoice the roster does not contain. So the price is an OPERATOR ASSERTION,
 * every line records that it was derived rather than observed, and the adapter
 * says so in `limits` and in each line's `detail`. Pretending we read it off
 * the file would be the lie.
 */
export const seatRosterAdapter: CostImportAdapter = {
  id: "seat_roster",
  displayName: "Per-seat SaaS roster + operator-asserted seat price",
  vendor: "unspecified",
  formats: ["csv", "json"],
  capabilities: {
    accountIdentifier: true,
    accountIsEmail: true,
    perLinePeriod: false,
    quantity: false,
    service: true,
    currency: false,
    amountFromFile: false,
  },
  limits:
    "The seat price is ASSERTED BY THE OPERATOR, not read from the file and not verified against any invoice — " +
    "every line it produces is stamped `derivedFrom: operator-asserted seat price`. It applies ONE price to EVERY " +
    "row, so a roster mixing plan tiers overstates the cheap seats and understates the expensive ones (import one " +
    "file per tier). It does not prorate a seat added or removed mid-period, does not read seat-assignment dates, " +
    "and cannot detect a seat that was paid for but never used.",
  parse(input) {
    const cfg = seatRosterConfigSchema.parse(input.config ?? {});
    return readMapped(input, {
      adapterId: "seat_roster",
      mapping: {
        account: cfg.accountColumn,
        // ignored: assertedAmountUsd supplies the money
        amount: cfg.accountColumn,
        ...(cfg.planColumn ? { service: cfg.planColumn } : {}),
      },
      defaults: {
        vendor: cfg.vendor,
        currency: "USD",
        billingKind: "seat",
        periodStart: cfg.periodStart,
        periodEnd: cfg.periodEnd,
      },
      fallbackVendor: cfg.vendor,
      billingKind: "seat",
      assertedAmountUsd: cfg.seatPriceUsd,
      detailFor: () => ({
        derivedFrom: "operator-asserted seat price",
        seatPriceUsd: cfg.seatPriceUsd,
      }),
    });
  },
};

export const COST_IMPORT_ADAPTERS: readonly CostImportAdapter[] = Object.freeze([
  genericMappedAdapter,
  openAiConsoleAdapter,
  anthropicConsoleAdapter,
  awsCurAdapter,
  seatRosterAdapter,
]);

export const COST_IMPORT_ADAPTER_IDS = COST_IMPORT_ADAPTERS.map((a) => a.id);

export function getCostImportAdapter(id: string): CostImportAdapter | undefined {
  return COST_IMPORT_ADAPTERS.find((a) => a.id === id);
}

/** the registry surface, for `GET /v1/cost-imports/adapters` */
export function describeCostImportAdapters(): Array<{
  id: string;
  displayName: string;
  vendor: string;
  formats: ReadonlyArray<"csv" | "json">;
  capabilities: CostImportAdapterCapabilities;
  limits: string;
}> {
  return COST_IMPORT_ADAPTERS.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    vendor: a.vendor,
    formats: a.formats,
    capabilities: a.capabilities,
    limits: a.limits,
  }));
}

// ===========================================================================
// 8. IDENTITY RESOLUTION — vendor account -> RegulAIt user
// ===========================================================================

export const ACCOUNT_RESOLUTION_METHODS = ["exact_email", "admin_alias", "domain_rule", "unresolved"] as const;
export type AccountResolutionMethod = (typeof ACCOUNT_RESOLUTION_METHODS)[number];

/** the sentinel vendor meaning "any vendor" on a mapping or a domain rule */
export const ANY_VENDOR = "*";

export interface VendorAliasRow {
  id: string;
  vendor: string;
  accountKey: string;
  userId: string;
}

export interface VendorDomainRuleRow {
  id: string;
  vendor: string;
  fromDomain: string;
  toDomain: string;
  enabled: boolean;
}

export interface AccountResolution {
  userId: string | null;
  method: AccountResolutionMethod;
  /** HOW the match was made, in words a disputed chargeback can be argued from */
  detail: string;
  /** the admin-authored row that made it, when one did */
  mappingId: string | null;
  domainRuleId: string | null;
}

/** lowercase + trim. Deliberately nothing else: plus-address stripping,
 * dot-folding and unicode confusable normalisation are all GUESSES about a
 * vendor's identity semantics, and a wrong guess attributes one person's spend
 * to another. */
export function normalizeAccountKey(raw: string): string {
  return raw.trim().toLowerCase();
}

function splitEmail(key: string): { local: string; domain: string } | null {
  const at = key.lastIndexOf("@");
  if (at <= 0 || at === key.length - 1) return null;
  return { local: key.slice(0, at), domain: key.slice(at + 1) };
}

/**
 * Resolve one vendor account onto a RegulAIt user.
 *
 * PRECEDENCE, and the reason for it:
 *   1. an ADMIN ALIAS — a human asserted this, and a human's correction must
 *      beat a mechanical match or the "an admin can fix a mapping" requirement
 *      is not real. A vendor-specific alias beats an all-vendor one.
 *   2. EXACT EMAIL, case-insensitively.
 *   3. a DOMAIN RULE, which rewrites the account's domain and then requires an
 *      exact match on the result. Two rules that disagree produce NO match.
 *   4. UNRESOLVED — which is a first-class outcome, kept visible as
 *      unattributed spend. It is never dropped and never assigned to anyone.
 */
export function resolveVendorAccount(
  accountRef: string,
  vendor: string,
  ctx: {
    userIdByEmail: ReadonlyMap<string, string>;
    aliases: readonly VendorAliasRow[];
    domainRules: readonly VendorDomainRuleRow[];
  },
): AccountResolution {
  const key = normalizeAccountKey(accountRef);
  const v = vendor.trim().toLowerCase();

  const exactAlias = ctx.aliases.find((a) => a.accountKey === key && a.vendor.toLowerCase() === v);
  const anyAlias = ctx.aliases.find((a) => a.accountKey === key && a.vendor === ANY_VENDOR);
  const alias = exactAlias ?? anyAlias;
  if (alias) {
    return {
      userId: alias.userId,
      method: "admin_alias",
      detail: `an administrator asserted that '${accountRef}' on vendor '${alias.vendor}' is this user (mapping ${alias.id})`,
      mappingId: alias.id,
      domainRuleId: null,
    };
  }

  const direct = ctx.userIdByEmail.get(key);
  if (direct) {
    return {
      userId: direct,
      method: "exact_email",
      detail: `the vendor account '${accountRef}' matches this user's RegulAIt email exactly (case-insensitive)`,
      mappingId: null,
      domainRuleId: null,
    };
  }

  const parts = splitEmail(key);
  if (parts) {
    const applicable = ctx.domainRules.filter(
      (r) => r.enabled && r.fromDomain.toLowerCase() === parts.domain && (r.vendor === ANY_VENDOR || r.vendor.toLowerCase() === v),
    );
    const hits = applicable
      .map((r) => ({ rule: r, userId: ctx.userIdByEmail.get(`${parts.local}@${r.toDomain.toLowerCase()}`) }))
      .filter((h): h is { rule: VendorDomainRuleRow; userId: string } => Boolean(h.userId));
    const distinct = new Set(hits.map((h) => h.userId));
    if (distinct.size === 1) {
      const hit = hits[0]!;
      return {
        userId: hit.userId,
        method: "domain_rule",
        detail: `domain rule ${hit.rule.id} rewrote '${parts.domain}' to '${hit.rule.toDomain}', and '${parts.local}@${hit.rule.toDomain}' is this user's RegulAIt email`,
        mappingId: null,
        domainRuleId: hit.rule.id,
      };
    }
    if (distinct.size > 1) {
      return {
        userId: null,
        method: "unresolved",
        detail: `${distinct.size} domain rules resolve '${accountRef}' to DIFFERENT users — the mapping is ambiguous and is left unattributed rather than guessed. Add an explicit alias for this account.`,
        mappingId: null,
        domainRuleId: null,
      };
    }
    if (applicable.length > 0) {
      return {
        userId: null,
        method: "unresolved",
        detail: `a domain rule matched '${parts.domain}' but no RegulAIt user has the rewritten address — the spend stays visible as unattributed`,
        mappingId: null,
        domainRuleId: null,
      };
    }
  }

  return {
    userId: null,
    method: "unresolved",
    detail: parts
      ? `no RegulAIt user has the email '${key}', and no alias or domain rule covers it — the spend stays visible as unattributed`
      : `'${accountRef}' is not an email address, so it can only be resolved by an administrator-authored alias — the spend stays visible as unattributed`,
    mappingId: null,
    domainRuleId: null,
  };
}

// ===========================================================================
// 9. CONSOLIDATION — and the total that does not exist
// ===========================================================================

export interface MeteredInput {
  userId: string | null;
  costCenter: string | null;
  costUsd: number | null;
}

export interface ImportedInput {
  userId: string | null;
  costCenter: string | null;
  vendor: string;
  amount: number;
  currency: string;
  billingKind: CostBillingKind;
}

export interface MeteredSide {
  basis: "metered";
  usd: number;
  events: number;
  /** ADR-0051's rule, carried through: an unpriced event is unpriced, not zero */
  unpricedEvents: number;
}

export interface ImportedSide {
  basis: "imported";
  /** null when the subject carries non-USD lines: RegulAIt performs NO FX
   * conversion, so there is no honest single-currency figure to give. */
  usd: number | null;
  lines: number;
  byCurrency: Array<{ currency: string; amount: number; lines: number }>;
  byVendor: Array<{ vendor: string; currency: string; amount: number; lines: number }>;
  byBillingKind: Array<{ billingKind: CostBillingKind; currency: string; amount: number; lines: number }>;
  /** stated whenever `usd` is null, so a consumer cannot render a blank cell
   * without also being handed the reason */
  usdNote: string | null;
}

/**
 * The consolidated row. THERE IS DELIBERATELY NO `total`, `combined`,
 * `grandTotal` OR `allUsd` FIELD, and adding one would be the bug: a consumer
 * that wants a single number must decide, in the open, which basis it is
 * willing to assert. The two sides are reported beside each other and the
 * `coverage` string states the split in words.
 */
export interface ConsolidatedSubject {
  subjectKind: "user" | "cost_center";
  subjectId: string | null;
  label: string;
  attributed: boolean;
  metered: MeteredSide;
  imported: ImportedSide;
  coverage: string;
}

const FX_NOTE =
  "no single-currency figure is given because this subject carries lines in more than one currency and RegulAIt " +
  "performs no FX conversion — see `byCurrency`";

function emptyMetered(): MeteredSide {
  return { basis: "metered", usd: 0, events: 0, unpricedEvents: 0 };
}

function buildImportedSide(rows: readonly ImportedInput[]): ImportedSide {
  const byCurrency = new Map<string, { currency: string; amount: number; lines: number }>();
  const byVendor = new Map<string, { vendor: string; currency: string; amount: number; lines: number }>();
  const byKind = new Map<string, { billingKind: CostBillingKind; currency: string; amount: number; lines: number }>();
  for (const r of rows) {
    const cur = byCurrency.get(r.currency) ?? { currency: r.currency, amount: 0, lines: 0 };
    cur.amount += r.amount;
    cur.lines += 1;
    byCurrency.set(r.currency, cur);

    const vk = `${r.vendor} ${r.currency}`;
    const v = byVendor.get(vk) ?? { vendor: r.vendor, currency: r.currency, amount: 0, lines: 0 };
    v.amount += r.amount;
    v.lines += 1;
    byVendor.set(vk, v);

    const kk = `${r.billingKind} ${r.currency}`;
    const k = byKind.get(kk) ?? { billingKind: r.billingKind, currency: r.currency, amount: 0, lines: 0 };
    k.amount += r.amount;
    k.lines += 1;
    byKind.set(kk, k);
  }
  const currencies = [...byCurrency.keys()];
  const onlyUsd = currencies.length === 0 || (currencies.length === 1 && currencies[0] === "USD");
  return {
    basis: "imported",
    usd: onlyUsd ? round2(byCurrency.get("USD")?.amount ?? 0) : null,
    lines: rows.length,
    byCurrency: [...byCurrency.values()].map((c) => ({ ...c, amount: round2(c.amount) })).sort((a, b) => a.currency.localeCompare(b.currency)),
    byVendor: [...byVendor.values()].map((c) => ({ ...c, amount: round2(c.amount) })).sort((a, b) => b.amount - a.amount),
    byBillingKind: [...byKind.values()].map((c) => ({ ...c, amount: round2(c.amount) })).sort((a, b) => b.amount - a.amount),
    usdNote: onlyUsd ? null : FX_NOTE,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function coverageSentence(metered: MeteredSide, imported: ImportedSide): string {
  const m = `${metered.usd.toFixed(2)} USD metered across ${metered.events} call(s)`;
  const i =
    imported.lines === 0
      ? "no imported lines"
      : imported.usd === null
        ? `${imported.lines} imported line(s) in ${imported.byCurrency.length} currencies`
        : `${imported.usd.toFixed(2)} USD imported across ${imported.lines} line(s)`;
  if (metered.events === 0 && imported.lines === 0) return "no spend of either basis in this period";
  if (imported.lines === 0) return `${m}; ${i}. Every figure here was observed by RegulAIt.`;
  if (metered.events === 0) {
    return `${m}; ${i}. Every figure here was restated from a customer-supplied export and was NOT observed by RegulAIt.`;
  }
  return `${m} and ${i}. These are two different kinds of number and are not added together.`;
}

/**
 * Roll metered and imported spend up onto one subject axis.
 *
 * Unattributed spend gets its own row (`subjectId: null`) rather than being
 * dropped or spread: an import whose account column resolved to nobody is a
 * real, known cost that a chargeback report must show as unallocated.
 */
export function consolidate(input: {
  by: "user" | "cost_center";
  metered: readonly MeteredInput[];
  imported: readonly ImportedInput[];
  /** display labels for user ids / cost-centre codes */
  labels?: ReadonlyMap<string, string>;
}): { subjects: ConsolidatedSubject[]; basisStatement: string } {
  const keyOf = (r: { userId: string | null; costCenter: string | null }) =>
    input.by === "user" ? r.userId : r.costCenter;

  const meteredByKey = new Map<string | null, MeteredInput[]>();
  for (const r of input.metered) {
    const k = keyOf(r);
    const arr = meteredByKey.get(k) ?? [];
    arr.push(r);
    meteredByKey.set(k, arr);
  }
  const importedByKey = new Map<string | null, ImportedInput[]>();
  for (const r of input.imported) {
    const k = keyOf(r);
    const arr = importedByKey.get(k) ?? [];
    arr.push(r);
    importedByKey.set(k, arr);
  }

  const keys = new Set<string | null>([...meteredByKey.keys(), ...importedByKey.keys()]);
  const subjects: ConsolidatedSubject[] = [];
  for (const k of keys) {
    const mrows = meteredByKey.get(k) ?? [];
    const metered = emptyMetered();
    for (const r of mrows) {
      metered.events += 1;
      if (r.costUsd === null || r.costUsd === undefined) metered.unpricedEvents += 1;
      else metered.usd += r.costUsd;
    }
    metered.usd = round2(metered.usd);
    const imported = buildImportedSide(importedByKey.get(k) ?? []);
    subjects.push({
      subjectKind: input.by,
      subjectId: k,
      label:
        k === null
          ? input.by === "user"
            ? "(unattributed — no RegulAIt user resolved)"
            : "(no cost centre)"
          : (input.labels?.get(k) ?? k),
      attributed: k !== null,
      metered,
      imported,
      coverage: coverageSentence(metered, imported),
    });
  }

  subjects.sort((a, b) => {
    // unattributed last, then by imported line count then metered spend —
    // deliberately NOT by a combined figure, which does not exist
    if (a.attributed !== b.attributed) return a.attributed ? -1 : 1;
    return b.imported.lines - a.imported.lines || b.metered.usd - a.metered.usd || a.label.localeCompare(b.label);
  });

  return { subjects, basisStatement: IMPORTED_BASIS_STATEMENT };
}

/** the consolidated view as RFC-4180 CSV. Two money columns, never one. */
export function renderConsolidatedCsv(subjects: readonly ConsolidatedSubject[]): string {
  const esc = (v: string | number | null) => {
    if (v === null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    "subject_kind",
    "subject_id",
    "label",
    "metered_usd",
    "metered_events",
    "metered_unpriced_events",
    "imported_usd",
    "imported_lines",
    "imported_currencies",
    "basis",
  ].join(",");
  const rows = subjects.map((s) =>
    [
      esc(s.subjectKind),
      esc(s.subjectId),
      esc(s.label),
      esc(s.metered.usd.toFixed(2)),
      esc(s.metered.events),
      esc(s.metered.unpricedEvents),
      esc(s.imported.usd === null ? "" : s.imported.usd.toFixed(2)),
      esc(s.imported.lines),
      esc(s.imported.byCurrency.map((c) => `${c.currency}:${c.amount.toFixed(2)}`).join(" ")),
      esc(
        s.metered.events > 0 && s.imported.lines > 0
          ? "metered+imported"
          : s.imported.lines > 0
            ? "imported"
            : "metered",
      ),
    ].join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

// ===========================================================================
// 10. REQUEST SCHEMAS
// ===========================================================================

export const costImportRequestSchema = z
  .object({
    adapter: z.string().min(1).max(60),
    format: z.enum(["csv", "json"]).default("csv"),
    mode: z.enum(["dry_run", "apply"]).default("dry_run"),
    /** the file, verbatim */
    content: z.string().min(1),
    /** a filename or a sentence about where it came from — provenance */
    source: z.string().min(1).max(300).optional(),
    /** adapter-specific configuration */
    config: z.unknown().optional(),
    /** requested PII posture for the ingest scan; composed MAX with the
     * org/compliance floor, so it can only ever TIGHTEN */
    piiMode: z.enum(["off", "log", "warn", "block"]).optional(),
  })
  .strict();

export const vendorAliasRequestSchema = z
  .object({
    vendor: z.string().min(1).max(100).default(ANY_VENDOR),
    accountRef: z.string().min(1).max(200),
    userId: z.string().uuid(),
    reason: z.string().min(1).max(500),
  })
  .strict();

export const vendorDomainRuleRequestSchema = z
  .object({
    vendor: z.string().min(1).max(100).default(ANY_VENDOR),
    fromDomain: z.string().min(3).max(253),
    toDomain: z.string().min(3).max(253),
    reason: z.string().min(1).max(500),
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((r) => r.fromDomain.toLowerCase() !== r.toDomain.toLowerCase(), {
    message: "a domain rule that rewrites a domain to itself is exact-email matching, which already happens",
  })
  .refine((r) => !r.fromDomain.includes("@") && !r.toDomain.includes("@"), {
    message: "a domain rule names bare domains, not addresses",
  });
