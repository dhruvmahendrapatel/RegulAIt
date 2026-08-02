import { describe, expect, it } from "vitest";
import {
  BILLING_DISCLAIMER,
  EMPTY_PRICING_SNAPSHOT,
  NoopBilling,
  buildStatement,
  billingKeyFor,
  billingScopeKey,
  createRateCardSchema,
  parseStatementCsv,
  rateFor,
  rateUsage,
  reconcileStatement,
  renderStatementCsv,
  seatLine,
  type PricingSnapshot,
  type RatableEvent,
} from "./billing.js";

/**
 * ADR-0051's pure half, proved by attack.
 *
 * The three things this file is trying to make impossible:
 *
 *  1. AN UNPRICED EVENT BILLED AS ZERO. ADR-0034 leaves `costUsd` null on
 *     purpose for self-hosted models, and a rate card can simply not mention a
 *     model. Both must surface as UNPRICED with a null amount. A zero would be
 *     a silent under-bill that reads on an invoice as "we used it and it was
 *     free", which is a different — and false — claim.
 *  2. RATING THAT REMEMBERS SOMETHING. `rateUsage` is asserted to be
 *     order-independent and repeatable: the same rows in a different order
 *     produce the identical result. That is what makes a materialized
 *     statement re-derivable.
 *  3. A PRICE CHANGE REACHING BACKWARDS. Rating against a SNAPSHOT is asserted
 *     to ignore a newer card entirely.
 */

const snapshot: PricingSnapshot = {
  rateCardId: "11111111-1111-1111-1111-111111111111",
  name: "standard",
  version: 1,
  currency: "USD",
  entries: [
    { dimension: "model", matchKey: "gpt-mock", unit: "per_1k_input_tokens", unitPriceUsd: 2 },
    { dimension: "model", matchKey: "gpt-mock", unit: "per_1k_output_tokens", unitPriceUsd: 6 },
    { dimension: "model", matchKey: "*", unit: "per_1k_input_tokens", unitPriceUsd: 1 },
    { dimension: "model", matchKey: "*", unit: "per_1k_output_tokens", unitPriceUsd: 3 },
    { dimension: "connector", matchKey: "*", unit: "per_call", unitPriceUsd: 0.25 },
    { dimension: "seat", matchKey: "*", unit: "per_seat_month", unitPriceUsd: 40 },
  ],
};

function ev(over: Partial<RatableEvent> = {}): RatableEvent {
  return {
    objectType: "agent",
    model: "gpt-mock",
    connectorId: null,
    operation: null,
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.1,
    ...over,
  };
}

describe("rate lookup", () => {
  it("prefers an exact key over the wildcard, in either entry order", () => {
    expect(rateFor(snapshot, "model", "gpt-mock", "per_1k_input_tokens")).toBe(2);
    const reversed: PricingSnapshot = { ...snapshot, entries: [...snapshot.entries].reverse() };
    expect(rateFor(reversed, "model", "gpt-mock", "per_1k_input_tokens")).toBe(2);
  });

  it("falls back to the wildcard for an unlisted key", () => {
    expect(rateFor(snapshot, "model", "never-heard-of-it", "per_1k_input_tokens")).toBe(1);
  });

  it("returns NULL, not 0, when nothing matches", () => {
    expect(rateFor(EMPTY_PRICING_SNAPSHOT, "model", "gpt-mock", "per_1k_input_tokens")).toBeNull();
    expect(rateFor(snapshot, "mcp_tool", "anything", "per_call")).toBeNull();
  });
});

describe("billing key derivation", () => {
  it("routes each objectType to an explicit dimension", () => {
    expect(billingKeyFor(ev())).toEqual({ dimension: "model", matchKey: "gpt-mock" });
    expect(billingKeyFor(ev({ objectType: "mcp_tool", operation: "search" }))).toEqual({
      dimension: "mcp_tool",
      matchKey: "search",
    });
    expect(billingKeyFor(ev({ objectType: "connector", connectorId: "c-1" }))).toEqual({
      dimension: "connector",
      matchKey: "c-1",
    });
  });

  it("falls back to the wildcard rather than dropping a row from the bill", () => {
    expect(billingKeyFor(ev({ model: null })).matchKey).toBe("*");
  });
});

describe("rating", () => {
  it("prices a model line from measured tokens", () => {
    const r = rateUsage([ev(), ev()], snapshot);
    // 2000 in @ $2/1k = 4 ; 1000 out @ $6/1k = 6
    expect(r.usageSubtotalUsd).toBe(10);
    expect(r.measuredInputTokens).toBe(2000);
    expect(r.measuredOutputTokens).toBe(1000);
    expect(r.unpricedEventCount).toBe(0);
  });

  it("keeps the LEDGER estimate beside the billed number without mixing them", () => {
    const r = rateUsage([ev({ costUsd: 0.1 }), ev({ costUsd: 0.4 })], snapshot);
    expect(r.ledgerEstimatedCostUsd).toBe(0.5);
    expect(r.lines[0]!.ledgerEstimatedUsd).toBe(0.5);
    expect(r.lines[0]!.billedUsd).toBe(10);
    expect(r.usageSubtotalUsd).not.toBe(r.ledgerEstimatedCostUsd);
  });

  it("reports an event the card does not price as UNPRICED, never as zero", () => {
    const r = rateUsage([ev({ objectType: "mcp_tool", operation: "search" })], snapshot);
    expect(r.lines[0]!.unpriced).toBe(true);
    expect(r.lines[0]!.billedUsd).toBeNull();
    expect(r.lines[0]!.billedUsd).not.toBe(0);
    expect(r.unpricedEventCount).toBe(1);
    expect(r.usageSubtotalUsd).toBe(0);
    expect(r.lines[0]!.rateNote).toMatch(/UNPRICED/);
  });

  it("carries a null-cost (self-hosted, ADR-0034) row as measured usage with no ledger estimate", () => {
    const r = rateUsage([ev({ costUsd: null })], snapshot);
    expect(r.measuredInputTokens).toBe(1000);
    expect(r.ledgerEstimatedCostUsd).toBe(0);
    expect(r.lines[0]!.ledgerEstimatedUsd).toBeNull();
    // it is still BILLABLE on our own rate card — that is the §5 distinction
    expect(r.lines[0]!.billedUsd).toBe(5);
  });

  it("is order-independent — the property a re-derivation depends on", () => {
    const rows = [ev(), ev({ model: "other", inputTokens: 300, outputTokens: 100 }), ev({ objectType: "connector", connectorId: "c-1" })];
    const a = rateUsage(rows, snapshot);
    const b = rateUsage([...rows].reverse(), snapshot);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("prices connector rows per call", () => {
    const r = rateUsage([ev({ objectType: "connector", connectorId: "c-1" }), ev({ objectType: "connector", connectorId: "c-1" })], snapshot);
    const line = r.lines.find((l) => l.dimension === "connector")!;
    expect(line.billedUsd).toBe(0.5);
  });

  it("an EMPTY card prices nothing and says so", () => {
    const r = rateUsage([ev(), ev({ objectType: "connector", connectorId: "c" })], EMPTY_PRICING_SNAPSHOT);
    expect(r.usageSubtotalUsd).toBe(0);
    expect(r.unpricedEventCount).toBe(2);
    expect(r.lines.every((l) => l.unpriced)).toBe(true);
  });
});

describe("seats", () => {
  it("bills the counted seats at the card's per-seat price", () => {
    expect(seatLine(3, snapshot).billedUsd).toBe(120);
  });
  it("reports UNPRICED when the card carries no seat entry", () => {
    const s = seatLine(3, EMPTY_PRICING_SNAPSHOT);
    expect(s.billedUsd).toBeNull();
    expect(s.unpriced).toBe(true);
  });
});

describe("statement assembly + re-derivation", () => {
  const args = {
    periodLabel: "2026-07",
    periodStart: new Date("2026-07-01T00:00:00Z"),
    periodEnd: new Date("2026-08-01T00:00:00Z"),
    scopeKind: "project" as const,
    scopeId: "22222222-2222-2222-2222-222222222222",
    projectIds: ["22222222-2222-2222-2222-222222222222"],
    snapshot,
    events: [ev(), ev({ objectType: "connector", connectorId: "c-1" })],
    seatCount: 2,
    derivedThroughAt: new Date("2026-08-01T00:00:00Z"),
  };

  it("totals usage + seats and carries the disclaimer on its face", () => {
    const p = buildStatement(args);
    expect(p.usageSubtotalUsd).toBe(5.25);
    expect(p.seatSubtotalUsd).toBe(80);
    expect(p.totalUsd).toBe(85.25);
    expect(p.disclaimer).toBe(BILLING_DISCLAIMER);
    expect(p.ratingMode).toBe("estimated");
  });

  it("re-derives EXACTLY from the same rows and snapshot", () => {
    const a = buildStatement(args);
    const b = buildStatement({ ...args, events: [...args.events].reverse() });
    expect(reconcileStatement(a, b).matches).toBe(true);
  });

  it("a NEWER rate card does not move a statement rated against the frozen snapshot", () => {
    const issued = buildStatement(args);
    const newer: PricingSnapshot = {
      ...snapshot,
      version: 2,
      entries: snapshot.entries.map((e) => ({ ...e, unitPriceUsd: e.unitPriceUsd * 10 })),
    };
    const atNewPrices = buildStatement({ ...args, snapshot: newer });
    expect(atNewPrices.totalUsd).not.toBe(issued.totalUsd);
    // replaying the ISSUED statement's own snapshot still yields the issued number
    const replay = buildStatement({ ...args, snapshot: issued.pricing });
    expect(replay.totalUsd).toBe(issued.totalUsd);
    expect(reconcileStatement(issued, replay).matches).toBe(true);
  });

  it("reports a LATE-ARRIVING ledger row as a diff rather than resolving it", () => {
    const issued = buildStatement(args);
    const late = buildStatement({ ...args, events: [...args.events, ev()] });
    const r = reconcileStatement(issued, late);
    expect(r.matches).toBe(false);
    expect(r.diffs.map((d) => d.field)).toContain("totalUsd");
    expect(r.diffs.map((d) => d.field)).toContain("usage.eventCount");
    expect(r.note).toMatch(/is NOT altered/);
  });
});

describe("CSV interchange", () => {
  it("round-trips the totals a finance team allocates against", () => {
    const p = buildStatement({
      periodLabel: "2026-07",
      periodStart: new Date("2026-07-01T00:00:00Z"),
      periodEnd: new Date("2026-08-01T00:00:00Z"),
      scopeKind: "org",
      scopeId: null,
      projectIds: null,
      snapshot,
      events: [ev(), ev({ objectType: "mcp_tool", operation: "search" })],
      seatCount: 1,
      derivedThroughAt: new Date("2026-08-01T00:00:00Z"),
    });
    const rows = parseStatementCsv(renderStatementCsv(p));
    const cell = (s: string, k: string, m: string) =>
      rows.find((r) => r.section === s && r.key === k && r.metric === m)?.value;
    expect(Number(cell("total", "statement", "total_usd"))).toBe(p.totalUsd);
    expect(cell("meta", "statement", "rating_mode")).toBe("estimated");
    // the unpriced line is visible AS unpriced in the export, not as 0
    expect(cell("usage", "mcp_tool:search", "billed_usd")).toBe("UNPRICED");
    expect(cell("total", "statement", "unpriced_events")).toBe("1");
  });
});

describe("write shapes", () => {
  it("refuses two prices for the same key", () => {
    const bad = createRateCardSchema.safeParse({
      name: "dup",
      entries: [
        { dimension: "model", matchKey: "m", unit: "per_1k_input_tokens", unitPriceUsd: 1 },
        { dimension: "model", matchKey: "m", unit: "per_1k_input_tokens", unitPriceUsd: 2 },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it("refuses a seat entry priced by anything but per_seat_month", () => {
    expect(
      createRateCardSchema.safeParse({
        name: "s",
        entries: [{ dimension: "seat", matchKey: "*", unit: "per_call", unitPriceUsd: 1 }],
      }).success,
    ).toBe(false);
  });

  it("gives a null scope id a concrete key so a UNIQUE index can hold", () => {
    expect(billingScopeKey(null)).toBe("org");
    expect(billingScopeKey("abc")).toBe("abc");
  });
});

describe("the billing port", () => {
  it("NoopBilling requires no network and returns no invoice", async () => {
    const b = new NoopBilling();
    expect(b.capabilities().requiresNetwork).toBe(false);
    expect(b.capabilities().fetchInvoice).toBe(false);
    expect(await b.fetchInvoice("2026-07")).toBeNull();
    const r = await b.pushUsage([]);
    expect(r.backend).toBe("noop");
    expect(r.note).toMatch(/no network call/i);
  });
});
