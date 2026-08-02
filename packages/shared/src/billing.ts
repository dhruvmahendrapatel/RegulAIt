/**
 * ADR-0051 — the PURE half of METERING & BILLING.
 *
 *   THIS FILE                          the rate-card vocabulary, the rate
 *                                      lookup, the deterministic rating
 *                                      function, the statement assembly, the
 *                                      re-derivation comparison, the CSV round
 *                                      trip, and the `BillingProvider` port.
 *                                      Pure — no db, no clock, no Fastify.
 *   `apps/gateway/src/billing.ts`      the `usage_events` queries, the
 *                                      entitlement scoping, the append-only
 *                                      statement versions, the admin API and
 *                                      the audit rows.
 *
 * THE ONE PROPERTY THIS FILE EXISTS TO PROTECT
 *
 *   BILLING DERIVES FROM THE MEASURED LEDGER, AND ONLY FROM IT. `rateUsage`
 *   takes ledger rows and a pricing snapshot and returns money. It holds no
 *   counter, accumulates no running total and remembers nothing between calls,
 *   so the same rows and the same snapshot always produce the same number.
 *   That is what makes `reconcileStatement` meaningful: a statement can be
 *   RE-DERIVED from `usage_events` months later and checked against what was
 *   issued. A parallel billing counter incremented at dispatch time would be
 *   faster and would drift, and the drift would be discovered by a customer
 *   reading an invoice.
 *
 * THE ESTIMATED/RECONCILED SPLIT SURVIVES INTO THE MONEY (ADR-0051 §5)
 *
 *   `usage_events.cost_usd` is provider LIST PRICE applied to measured counts —
 *   an estimate, and `null` on purpose for self-hosted/unpriced models
 *   (ADR-0034). A rate card is a separate, COMMERCIAL number. This file keeps
 *   both on every line (`billedUsd` and `ledgerEstimatedUsd`) rather than
 *   flattening them, and an event the rate card does not price produces
 *   `billedUsd: null` with `unpriced: true` — NEVER a zero and never a
 *   fabricated price. A zero would silently under-bill and read as "free".
 *
 * WHAT THIS FILE DOES NOT DO
 *
 *   It does not talk to a payment processor. There is no Stripe, no Metronome,
 *   no Orb, no network call anywhere in this slice. `BillingProvider` is the
 *   port ADR-0051 §2 specifies and `NoopBilling` — export-only, the BYOC/
 *   air-gapped default of §6 — is the only implementation that exists. Tax,
 *   currency conversion, dunning and multi-entity billing are out of scope
 *   (ADR-0051 "Follow-up") and are absent rather than half-present.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/** what a rate-card entry prices. `seat` is the ADR-0052 seat count, which is
 * CONSUMED here and defined there — there is exactly one definition of "an
 * active seat" and billing does not fork a second one. */
export const BILLING_DIMENSIONS = ["model", "connector", "mcp_tool", "seat"] as const;
export type BillingDimension = (typeof BILLING_DIMENSIONS)[number];

export const RATE_UNITS = [
  "per_1k_input_tokens",
  "per_1k_output_tokens",
  "per_call",
  "per_seat_month",
] as const;
export type RateUnit = (typeof RATE_UNITS)[number];

/** ADR-0051 §5 — the honesty rung, kept in the data rather than in prose.
 * `estimated` is rated from a rate card over measured counts; `reconciled`
 * would be actuals imported from a provider's own invoice. Nothing imports
 * provider actuals today, so nothing is ever `reconciled` — see the amendment. */
export const RATING_MODES = ["estimated", "reconciled"] as const;
export type RatingMode = (typeof RATING_MODES)[number];

/** append-only, exactly like ADR-0040's audit versions and ADR-0048's config
 * versions: a statement is never edited in place. */
export const STATEMENT_STATUSES = ["draft", "issued", "superseded"] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

export const BILLING_SCOPE_KINDS = ["org", "initiative", "team", "project"] as const;
export type BillingScopeKind = (typeof BILLING_SCOPE_KINDS)[number];

/** the only backend that exists. See the file header. */
export const BILLING_BACKENDS = ["noop"] as const;
export type BillingBackend = (typeof BILLING_BACKENDS)[number];

/** the wildcard match key — one entry prices every key in its dimension */
export const RATE_WILDCARD = "*";

export const BILLING_DISCLAIMER =
  "This statement is RATED from the measured usage ledger (usage_events) against a commercial rate " +
  "card, not imported from a provider invoice. It is an ESTIMATE in ADR-0051 §5's sense: measured " +
  "token/call counts are authoritative, the money applied to them is our own rate card. Events the " +
  "rate card does not price are reported as UNPRICED with a null amount — never as zero. No payment " +
  "processor is integrated: nothing here charges anyone.";

// ---------------------------------------------------------------------------
// The pricing snapshot — what an issued statement froze
// ---------------------------------------------------------------------------

export interface RateEntry {
  dimension: BillingDimension;
  /** the model name / connector id / tool name this entry prices, or `*` */
  matchKey: string;
  unit: RateUnit;
  unitPriceUsd: number;
}

/**
 * The rate card AS IT WAS when a statement was cut, copied into the statement.
 * This is the whole mechanism behind "an issued invoice does not change when a
 * price does": re-derivation replays the SNAPSHOT, not the live card. Pointing
 * an issued invoice at a mutable rate card would make history editable by an
 * admin who changed a price for next quarter.
 */
export interface PricingSnapshot {
  rateCardId: string | null;
  name: string;
  version: number;
  currency: string;
  entries: RateEntry[];
}

/** an empty card prices nothing, so everything is UNPRICED and visibly so —
 * the correct behaviour when a deployment has never configured rates. */
export const EMPTY_PRICING_SNAPSHOT: PricingSnapshot = {
  rateCardId: null,
  name: "none",
  version: 0,
  currency: "USD",
  entries: [],
};

/**
 * Exact key beats wildcard, always. Returns null — never 0 — when nothing
 * matches, because "we do not price this" and "this is free" are different
 * facts and only one of them is true.
 */
export function rateFor(
  snapshot: PricingSnapshot,
  dimension: BillingDimension,
  matchKey: string,
  unit: RateUnit,
): number | null {
  let wildcard: number | null = null;
  for (const e of snapshot.entries) {
    if (e.dimension !== dimension || e.unit !== unit) continue;
    if (e.matchKey === matchKey) return e.unitPriceUsd;
    if (e.matchKey === RATE_WILDCARD) wildcard = e.unitPriceUsd;
  }
  return wildcard;
}

// ---------------------------------------------------------------------------
// Rating — the deterministic ledger -> money function
// ---------------------------------------------------------------------------

/** exactly the columns of `usage_events` rating reads. Nothing else is looked
 * at, so the gateway's SELECT and this function cannot disagree about inputs. */
export interface RatableEvent {
  objectType: string;
  model: string | null;
  connectorId: string | null;
  operation: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** the LIST-PRICE estimate the ledger already carries; null = unpriced model */
  costUsd: number | null;
}

export interface UsageLine {
  dimension: BillingDimension;
  matchKey: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  /** null = the rate card does not price this. NEVER zero-by-default. */
  billedUsd: number | null;
  unpriced: boolean;
  /** the ledger's own list-price estimate for the same rows, kept beside the
   * billed number so the two can never be confused for each other (§5) */
  ledgerEstimatedUsd: number | null;
  rateNote: string;
}

export interface RatedUsage {
  lines: UsageLine[];
  usageSubtotalUsd: number;
  measuredInputTokens: number;
  measuredOutputTokens: number;
  measuredCallCount: number;
  eventCount: number;
  unpricedEventCount: number;
  /** the sum of `usage_events.cost_usd` over the same rows — the reconciliation
   * anchor back to the cost dashboard and to ADR-0047's reports */
  ledgerEstimatedCostUsd: number;
}

export function round6(n: number): number {
  return Number(n.toFixed(6));
}

/** which rate-card dimension and key a ledger row is billed under. Derived
 * from the row, so a new `objectType` lands somewhere explicit rather than
 * silently vanishing from the bill. */
export function billingKeyFor(e: RatableEvent): { dimension: BillingDimension; matchKey: string } {
  if (e.objectType === "agent") return { dimension: "model", matchKey: e.model ?? RATE_WILDCARD };
  if (e.objectType === "mcp_tool") return { dimension: "mcp_tool", matchKey: e.operation ?? RATE_WILDCARD };
  return { dimension: "connector", matchKey: e.connectorId ?? e.operation ?? RATE_WILDCARD };
}

/**
 * THE rating function. Pure, total, and order-independent: it groups the rows,
 * applies the snapshot, and returns lines sorted deterministically so two
 * derivations of the same period are byte-comparable.
 *
 * A model line is priced per 1k input tokens plus per 1k output tokens; a
 * connector/MCP line per call. A line with neither rate present is UNPRICED and
 * contributes nothing to the subtotal — the subtotal is therefore a floor, and
 * `unpricedEventCount` is what stops that floor being mistaken for the total.
 */
export function rateUsage(events: RatableEvent[], snapshot: PricingSnapshot): RatedUsage {
  const groups = new Map<
    string,
    { dimension: BillingDimension; matchKey: string; events: number; inTok: number; outTok: number; ledger: number; ledgerPriced: number }
  >();
  for (const e of events) {
    const { dimension, matchKey } = billingKeyFor(e);
    const k = `${dimension} ${matchKey}`;
    const g = groups.get(k) ?? { dimension, matchKey, events: 0, inTok: 0, outTok: 0, ledger: 0, ledgerPriced: 0 };
    g.events += 1;
    g.inTok += e.inputTokens ?? 0;
    g.outTok += e.outputTokens ?? 0;
    if (e.costUsd != null) {
      g.ledger += e.costUsd;
      g.ledgerPriced += 1;
    }
    groups.set(k, g);
  }

  const lines: UsageLine[] = [];
  let usageSubtotalUsd = 0;
  let unpricedEventCount = 0;
  for (const g of [...groups.values()].sort((a, b) =>
    a.dimension === b.dimension ? a.matchKey.localeCompare(b.matchKey) : a.dimension.localeCompare(b.dimension),
  )) {
    let billed: number | null = null;
    let note: string;
    if (g.dimension === "model") {
      const inRate = rateFor(snapshot, "model", g.matchKey, "per_1k_input_tokens");
      const outRate = rateFor(snapshot, "model", g.matchKey, "per_1k_output_tokens");
      if (inRate == null && outRate == null) {
        note = `no rate-card entry prices model '${g.matchKey}' — reported UNPRICED, not zero`;
      } else {
        billed = round6(((inRate ?? 0) * g.inTok) / 1000 + ((outRate ?? 0) * g.outTok) / 1000);
        note =
          `${g.inTok} input tokens @ $${inRate ?? 0}/1k + ${g.outTok} output tokens @ $${outRate ?? 0}/1k` +
          (inRate == null || outRate == null ? " (one side of the token rate is unset and priced at 0)" : "");
      }
    } else {
      const perCall = rateFor(snapshot, g.dimension, g.matchKey, "per_call");
      if (perCall == null) {
        note = `no rate-card entry prices ${g.dimension} '${g.matchKey}' — reported UNPRICED, not zero`;
      } else {
        billed = round6(perCall * g.events);
        note = `${g.events} call(s) @ $${perCall}/call`;
      }
    }
    if (billed == null) unpricedEventCount += g.events;
    else usageSubtotalUsd += billed;
    lines.push({
      dimension: g.dimension,
      matchKey: g.matchKey,
      events: g.events,
      inputTokens: g.inTok,
      outputTokens: g.outTok,
      calls: g.events,
      billedUsd: billed,
      unpriced: billed == null,
      ledgerEstimatedUsd: g.ledgerPriced > 0 ? round6(g.ledger) : null,
      rateNote: note,
    });
  }

  return {
    lines,
    usageSubtotalUsd: round6(usageSubtotalUsd),
    measuredInputTokens: events.reduce((a, e) => a + (e.inputTokens ?? 0), 0),
    measuredOutputTokens: events.reduce((a, e) => a + (e.outputTokens ?? 0), 0),
    measuredCallCount: events.length,
    eventCount: events.length,
    unpricedEventCount,
    ledgerEstimatedCostUsd: round6(events.reduce((a, e) => a + (e.costUsd ?? 0), 0)),
  };
}

// ---------------------------------------------------------------------------
// Seats — the OTHER source (ADR-0051 §3), consumed not redefined
// ---------------------------------------------------------------------------

export interface SeatLine {
  seatCount: number;
  unitPriceUsd: number | null;
  billedUsd: number | null;
  unpriced: boolean;
  note: string;
}

export function seatLine(seatCount: number, snapshot: PricingSnapshot): SeatLine {
  const price = rateFor(snapshot, "seat", RATE_WILDCARD, "per_seat_month");
  if (price == null) {
    return {
      seatCount,
      unitPriceUsd: null,
      billedUsd: null,
      unpriced: true,
      note:
        `${seatCount} active seat(s) counted, but the rate card carries no per_seat_month entry — ` +
        "reported UNPRICED rather than billed at zero",
    };
  }
  return {
    seatCount,
    unitPriceUsd: price,
    billedUsd: round6(price * seatCount),
    unpriced: false,
    note: `${seatCount} active seat(s) @ $${price}/seat/period (ADR-0052's seat definition, not a second one)`,
  };
}

// ---------------------------------------------------------------------------
// The statement payload
// ---------------------------------------------------------------------------

export interface StatementPayload {
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  scope: { kind: BillingScopeKind; id: string | null; projectIds: string[] | null };
  ratingMode: RatingMode;
  pricing: PricingSnapshot;
  usage: RatedUsage;
  seats: SeatLine;
  usageSubtotalUsd: number;
  seatSubtotalUsd: number;
  totalUsd: number;
  /** the cut instant — re-derivation replays the ledger AS OF this moment */
  derivedThroughAt: string;
  disclaimer: string;
}

export function buildStatement(input: {
  periodLabel: string;
  periodStart: Date;
  periodEnd: Date;
  scopeKind: BillingScopeKind;
  scopeId: string | null;
  projectIds: string[] | null;
  snapshot: PricingSnapshot;
  events: RatableEvent[];
  seatCount: number;
  derivedThroughAt: Date;
}): StatementPayload {
  const usage = rateUsage(input.events, input.snapshot);
  const seats = seatLine(input.seatCount, input.snapshot);
  const usageSubtotalUsd = usage.usageSubtotalUsd;
  const seatSubtotalUsd = seats.billedUsd ?? 0;
  return {
    periodLabel: input.periodLabel,
    periodStart: input.periodStart.toISOString(),
    periodEnd: input.periodEnd.toISOString(),
    scope: { kind: input.scopeKind, id: input.scopeId, projectIds: input.projectIds },
    ratingMode: "estimated",
    pricing: input.snapshot,
    usage,
    seats,
    usageSubtotalUsd,
    seatSubtotalUsd: round6(seatSubtotalUsd),
    totalUsd: round6(usageSubtotalUsd + seatSubtotalUsd),
    derivedThroughAt: input.derivedThroughAt.toISOString(),
    disclaimer: BILLING_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// Re-derivation — the check that a materialized statement did not drift
// ---------------------------------------------------------------------------

export interface ReconcileDiff {
  field: string;
  issued: number;
  rederived: number;
}

export interface ReconcileResult {
  matches: boolean;
  diffs: ReconcileDiff[];
  note: string;
}

/**
 * Compare a stored statement against a fresh derivation from the ledger using
 * the SAME pricing snapshot and the SAME window. Materializing a period is
 * defensible only if it stays reproducible; this is the function that proves it
 * rather than asserting it in a comment.
 *
 * A mismatch is NOT automatically a bug in the rating: a late-arriving
 * `usage_events` row inside an already-cut window will move the re-derivation
 * and not the issued statement. That is exactly the situation an operator must
 * see, so the diff is reported with both numbers rather than resolved silently
 * in either direction.
 */
export function reconcileStatement(
  issued: Pick<
    StatementPayload,
    "usageSubtotalUsd" | "seatSubtotalUsd" | "totalUsd"
  > & { usage: Pick<RatedUsage, "eventCount" | "measuredInputTokens" | "measuredOutputTokens" | "ledgerEstimatedCostUsd"> },
  rederived: Pick<
    StatementPayload,
    "usageSubtotalUsd" | "seatSubtotalUsd" | "totalUsd"
  > & { usage: Pick<RatedUsage, "eventCount" | "measuredInputTokens" | "measuredOutputTokens" | "ledgerEstimatedCostUsd"> },
): ReconcileResult {
  const pairs: Array<[string, number, number]> = [
    ["usageSubtotalUsd", issued.usageSubtotalUsd, rederived.usageSubtotalUsd],
    ["seatSubtotalUsd", issued.seatSubtotalUsd, rederived.seatSubtotalUsd],
    ["totalUsd", issued.totalUsd, rederived.totalUsd],
    ["usage.eventCount", issued.usage.eventCount, rederived.usage.eventCount],
    ["usage.measuredInputTokens", issued.usage.measuredInputTokens, rederived.usage.measuredInputTokens],
    ["usage.measuredOutputTokens", issued.usage.measuredOutputTokens, rederived.usage.measuredOutputTokens],
    ["usage.ledgerEstimatedCostUsd", issued.usage.ledgerEstimatedCostUsd, rederived.usage.ledgerEstimatedCostUsd],
  ];
  const diffs = pairs
    .filter(([, a, b]) => a !== b)
    .map(([field, a, b]) => ({ field, issued: a, rederived: b }));
  return {
    matches: diffs.length === 0,
    diffs,
    note:
      diffs.length === 0
        ? "the statement re-derives EXACTLY from usage_events under its own frozen pricing snapshot"
        : "the statement does NOT re-derive from the ledger under its own snapshot — most often a " +
          "usage_events row that landed inside an already-cut window. The issued figure is NOT " +
          "altered; both numbers are reported so an operator decides.",
  };
}

// ---------------------------------------------------------------------------
// CSV — the chargeback/showback interchange (ADR-0051 §4), no backend needed
// ---------------------------------------------------------------------------

export interface StatementCsvRow {
  section: string;
  key: string;
  metric: string;
  value: string;
}

export function statementCsvRows(p: StatementPayload): StatementCsvRow[] {
  const rows: StatementCsvRow[] = [
    { section: "meta", key: "statement", metric: "period", value: p.periodLabel },
    { section: "meta", key: "statement", metric: "period_start", value: p.periodStart },
    { section: "meta", key: "statement", metric: "period_end", value: p.periodEnd },
    { section: "meta", key: "statement", metric: "rating_mode", value: p.ratingMode },
    { section: "meta", key: "statement", metric: "basis", value: "rate-card-over-measured-ledger" },
    { section: "meta", key: "pricing", metric: "rate_card", value: `${p.pricing.name} v${p.pricing.version}` },
    { section: "meta", key: "pricing", metric: "currency", value: p.pricing.currency },
  ];
  for (const l of p.usage.lines) {
    const key = `${l.dimension}:${l.matchKey}`;
    rows.push({ section: "usage", key, metric: "events", value: String(l.events) });
    rows.push({ section: "usage", key, metric: "input_tokens", value: String(l.inputTokens) });
    rows.push({ section: "usage", key, metric: "output_tokens", value: String(l.outputTokens) });
    rows.push({ section: "usage", key, metric: "billed_usd", value: l.billedUsd == null ? "UNPRICED" : String(l.billedUsd) });
    rows.push({
      section: "usage",
      key,
      metric: "ledger_estimated_usd",
      value: l.ledgerEstimatedUsd == null ? "UNPRICED" : String(l.ledgerEstimatedUsd),
    });
  }
  rows.push({ section: "seats", key: "active", metric: "count", value: String(p.seats.seatCount) });
  rows.push({
    section: "seats",
    key: "active",
    metric: "billed_usd",
    value: p.seats.billedUsd == null ? "UNPRICED" : String(p.seats.billedUsd),
  });
  rows.push({ section: "total", key: "usage", metric: "subtotal_usd", value: String(p.usageSubtotalUsd) });
  rows.push({ section: "total", key: "seats", metric: "subtotal_usd", value: String(p.seatSubtotalUsd) });
  rows.push({ section: "total", key: "statement", metric: "total_usd", value: String(p.totalUsd) });
  rows.push({ section: "total", key: "statement", metric: "unpriced_events", value: String(p.usage.unpricedEventCount) });
  return rows;
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function renderStatementCsv(p: StatementPayload): string {
  const rows = statementCsvRows(p);
  const head = "section,key,metric,value";
  return [head, ...rows.map((r) => [r.section, r.key, r.metric, r.value].map(csvCell).join(","))].join("\n") + "\n";
}

export function parseStatementCsv(csv: string): StatementCsvRow[] {
  const out: StatementCsvRow[] = [];
  const lines = csv.split(/\r?\n/).filter((l) => l.length > 0);
  for (const line of lines.slice(1)) {
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    out.push({ section: cells[0] ?? "", key: cells[1] ?? "", metric: cells[2] ?? "", value: cells[3] ?? "" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The provider-agnostic port (ADR-0051 §2)
// ---------------------------------------------------------------------------

export interface BillingCapabilities {
  /** can the backend accept raw metered usage? */
  pushUsage: boolean;
  /** can the backend hold a seat count? */
  syncSeats: boolean;
  /** can the backend return an invoice we can render? */
  fetchInvoice: boolean;
  /** does reaching the backend require network egress? */
  requiresNetwork: boolean;
}

export interface MeteredUsage {
  periodStart: string;
  periodEnd: string;
  dimension: BillingDimension;
  matchKey: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  billedUsd: number | null;
}

export interface PushResult {
  accepted: number;
  backend: BillingBackend;
  note: string;
}

/**
 * The port ADR-0051 §2 specifies. It exists so that no name of a billing vendor
 * ever appears above this boundary — the same reason `packages/model-provider`
 * and the PM/git adapters exist.
 *
 * Only `NoopBilling` is implemented. That is not a placeholder: §6 makes it the
 * DEFAULT for the BYOC/air-gapped primary motion, where there is no outbound
 * path to a hosted billing backend at all.
 */
export interface BillingProvider {
  readonly backend: BillingBackend;
  capabilities(): BillingCapabilities;
  pushUsage(events: MeteredUsage[]): Promise<PushResult>;
  syncSeats(tenant: string, seatCount: number, tier: string): Promise<void>;
  fetchInvoice(periodLabel: string): Promise<null>;
}

/**
 * Export-only. Makes NO network call of any kind — that is the point, not an
 * omission: an air-gapped control plane settles billing by handing over an
 * exported statement, exactly as it hands over an offline audit sync.
 */
export class NoopBilling implements BillingProvider {
  readonly backend: BillingBackend = "noop";
  capabilities(): BillingCapabilities {
    return { pushUsage: true, syncSeats: true, fetchInvoice: false, requiresNetwork: false };
  }
  async pushUsage(events: MeteredUsage[]): Promise<PushResult> {
    return {
      accepted: events.length,
      backend: "noop",
      note:
        "recorded locally in billing_exports. NO external billing system is contacted — this backend " +
        "makes no network call, which is what makes it the ADR-0051 §6 air-gapped default.",
    };
  }
  async syncSeats(_tenant: string, _seatCount: number, _tier: string): Promise<void> {
    /* nothing external to sync to; the seat count lives in the statement */
  }
  async fetchInvoice(_periodLabel: string): Promise<null> {
    // no external system of record exists, so there is no invoice to read back.
    // Returning null rather than synthesising one keeps §4's split honest.
    return null;
  }
}

export const billingProviders: Record<BillingBackend, () => BillingProvider> = {
  noop: () => new NoopBilling(),
};

// ---------------------------------------------------------------------------
// Write shapes
// ---------------------------------------------------------------------------

export const rateEntrySchema = z
  .object({
    dimension: z.enum(BILLING_DIMENSIONS),
    matchKey: z.string().min(1).max(200).default(RATE_WILDCARD),
    unit: z.enum(RATE_UNITS),
    unitPriceUsd: z.number().min(0),
  })
  .strict();

export const createRateCardSchema = z
  .object({
    name: z.string().min(1).max(120),
    currency: z.string().length(3).default("USD"),
    description: z.string().max(2000).nullish(),
    entries: z.array(rateEntrySchema).min(1).max(500),
  })
  .strict()
  .refine(
    (c) =>
      new Set(c.entries.map((e) => `${e.dimension} ${e.matchKey} ${e.unit}`)).size ===
      c.entries.length,
    { message: "duplicate (dimension, matchKey, unit) entry — one price per key, or the bill is ambiguous" },
  )
  .refine((c) => c.entries.every((e) => e.dimension !== "seat" || e.unit === "per_seat_month"), {
    message: "a seat entry must be priced per_seat_month",
  })
  .refine((c) => c.entries.every((e) => e.dimension === "seat" || e.unit !== "per_seat_month"), {
    message: "per_seat_month only applies to the seat dimension",
  });
export type CreateRateCard = z.infer<typeof createRateCardSchema>;

export const createBillingPeriodSchema = z
  .object({
    scopeKind: z.enum(BILLING_SCOPE_KINDS).default("org"),
    scopeId: z.string().uuid().nullish(),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    rateCardId: z.string().uuid().nullish(),
  })
  .strict()
  .refine((d) => (d.scopeKind === "org") === (d.scopeId == null), {
    message: "scopeKind 'org' takes no scopeId; every other scopeKind requires one",
  })
  .refine((d) => new Date(d.periodEnd).getTime() > new Date(d.periodStart).getTime(), {
    message: "periodEnd must be after periodStart",
  });
export type CreateBillingPeriod = z.infer<typeof createBillingPeriodSchema>;

export const generateStatementSchema = z
  .object({ rateCardId: z.string().uuid().nullish() })
  .strict();

export const issueStatementSchema = z
  .object({ reason: z.string().min(1).max(2000) })
  .strict();

/** the scope key that makes a nullable scopeId participate in a UNIQUE index —
 * Postgres treats NULLs as distinct, so an org period could otherwise be opened
 * twice for the same window and cut two "the" invoices. */
export function billingScopeKey(scopeId: string | null): string {
  return scopeId ?? "org";
}
