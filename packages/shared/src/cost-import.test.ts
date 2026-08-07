/**
 * ADR-0069 — the pure half, unit-tested.
 *
 * The adversarial suite is `cost-import-is-real.test.ts`; this file covers the
 * mechanics: cell parsing, the adapters, inference, identity resolution and the
 * consolidation math.
 */
import { describe, expect, it } from "vitest";
import {
  ANY_VENDOR,
  COST_IMPORT_MAX_LINE_USD,
  CostImportFormatError,
  awsCurAdapter,
  anthropicConsoleAdapter,
  consolidate,
  genericMappedAdapter,
  inferMapping,
  normalizeAccountKey,
  openAiConsoleAdapter,
  parseAmountCell,
  parseCsvRecords,
  parseDateCell,
  renderConsolidatedCsv,
  resolveVendorAccount,
  seatRosterAdapter,
} from "./index.js";

// ===========================================================================
// The line-number-preserving CSV reader
// ===========================================================================

describe("parseCsvRecords keeps real file line numbers", () => {
  it("does not renumber records after a blank line", () => {
    const recs = parseCsvRecords("a,b\n1,2\n\n3,4\n");
    expect(recs.map((r) => r.line)).toEqual([1, 2, 3, 4]);
    expect(recs[3]!.cells).toEqual(["3", "4"]);
  });

  it("counts a newline inside a quoted field", () => {
    const recs = parseCsvRecords('a,b\n"x\ny",2\n9,9\n');
    expect(recs.map((r) => r.line)).toEqual([1, 2, 4]);
  });
});

// ===========================================================================
// Cell parsing — refuse rather than guess
// ===========================================================================

describe("parseAmountCell", () => {
  it("reads plain, symbol-prefixed, comma-grouped and parenthesised amounts", () => {
    expect(parseAmountCell("12.34")).toEqual({ ok: true, value: 12.34 });
    expect(parseAmountCell("$1,234.56")).toEqual({ ok: true, value: 1234.56 });
    expect(parseAmountCell("(42.00)")).toEqual({ ok: true, value: -42 });
    expect(parseAmountCell("-7")).toEqual({ ok: true, value: -7 });
    expect(parseAmountCell("$-3.00")).toEqual({ ok: true, value: -3 });
  });

  it("refuses an EMPTY cell — an absent amount is not zero", () => {
    const r = parseAmountCell("   ");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/not zero/);
  });

  it("refuses text, double decimals and an unclosed parenthesis", () => {
    expect(parseAmountCell("n/a").ok).toBe(false);
    expect(parseAmountCell("1.2.3").ok).toBe(false);
    expect(parseAmountCell("(5.00").ok).toBe(false);
  });

  it("refuses an implausible magnitude rather than poisoning a rollup", () => {
    const r = parseAmountCell(String(COST_IMPORT_MAX_LINE_USD + 1));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/units error/);
  });
});

describe("parseDateCell", () => {
  it("reads year-first dates, months and timestamps", () => {
    expect(parseDateCell("2026-07-15").ok).toBe(true);
    expect(parseDateCell("2026/07/15").ok).toBe(true);
    const month = parseDateCell("2026-07");
    expect(month.ok && month.value.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    const monthEnd = parseDateCell("2026-07", { endOfMonth: true });
    expect(monthEnd.ok && monthEnd.value.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    const dec = parseDateCell("2026-12", { endOfMonth: true });
    expect(dec.ok && dec.value.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(parseDateCell("2026-07-15T13:45:01Z").ok).toBe(true);
  });

  it("REFUSES an ambiguous day-first/month-first date rather than guessing", () => {
    const r = parseDateCell("07/08/2026");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/ambiguous/);
  });

  it("refuses a date that does not exist on the calendar", () => {
    expect(parseDateCell("2026-02-31").ok).toBe(false);
  });
});

// ===========================================================================
// The generic mapped adapter — the one that will actually get used
// ===========================================================================

const GENERIC_CSV =
  "who,spend,when,thing\n" +
  "Jane@Acme.com,12.50,2026-07,gpt-4o\n" +
  "bob@acme.com,$1;00,2026-07,gpt-4o\n" +
  "carol@acme.com,7.25,2026-07,claude\n";

describe("genericMappedAdapter", () => {
  const parse = () =>
    genericMappedAdapter.parse({
      content: GENERIC_CSV,
      format: "csv",
      config: {
        mapping: { account: "who", amount: "spend", period: "when", service: "thing" },
        defaults: { vendor: "openai", currency: "USD" },
      },
    });

  it("accepts the good rows, refuses the bad one BY LINE NUMBER, and the counts add up", () => {
    const r = parse();
    expect(r.rowsParsed).toBe(3);
    expect(r.lines).toHaveLength(2);
    expect(r.refusals).toHaveLength(1);
    // the identity that is the whole no-silent-drop claim
    expect(r.lines.length + r.refusals.length).toBe(r.rowsParsed);
    // line 3 of the file, which is bob — header is line 1
    expect(r.refusals[0]!.row).toBe(3);
    expect(r.refusals[0]!.field).toBe("spend");
    expect(r.refusals[0]!.reason).toContain("$1;00");
  });

  it("keeps the account EXACTLY as the file spelled it", () => {
    const r = parse();
    expect(r.lines[0]!.accountRef).toBe("Jane@Acme.com");
    expect(normalizeAccountKey(r.lines[0]!.accountRef)).toBe("jane@acme.com");
  });

  it("reads a JSON array through the same mapping", () => {
    const r = genericMappedAdapter.parse({
      content: JSON.stringify([{ who: "jane@acme.com", spend: "3.00", when: "2026-07" }]),
      format: "json",
      config: { mapping: { account: "who", amount: "spend", period: "when" }, defaults: { vendor: "openai" } },
    });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.amount).toBe(3);
  });

  it("refuses the whole file when a mapped column is absent", () => {
    expect(() =>
      genericMappedAdapter.parse({
        content: GENERIC_CSV,
        format: "csv",
        config: { mapping: { account: "nope", amount: "spend", period: "when" } },
      }),
    ).toThrow(CostImportFormatError);
  });

  it("refuses when no period can be established at all", () => {
    expect(() =>
      genericMappedAdapter.parse({
        content: "who,spend\njane@acme.com,1.00\n",
        format: "csv",
        config: { mapping: { account: "who", amount: "spend" } },
      }),
    ).toThrow(/period/);
  });
});

describe("inferMapping", () => {
  it("infers an unambiguous header set", () => {
    const r = inferMapping(["email", "cost", "period", "model"]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.mapping).toMatchObject({ account: "email", amount: "cost", period: "period", service: "model" });
  });

  it("REFUSES rather than guess which of two money columns is the money", () => {
    const r = inferMapping(["email", "cost", "total"]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/ambiguous/);
  });

  it("refuses when no account column is recognisable", () => {
    const r = inferMapping(["widget", "cost"]);
    expect(r.ok).toBe(false);
  });
});

// ===========================================================================
// The vendor presets
// ===========================================================================

describe("vendor preset adapters", () => {
  it("openai_console reads its declared header set", () => {
    const r = openAiConsoleAdapter.parse({
      content: "date,user,model,n_requests,amount\n2026-07-01,jane@acme.com,gpt-4o,12,3.50\n",
      format: "csv",
    });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ vendor: "openai", amount: 3.5, service: "gpt-4o", quantity: 12, billingKind: "usage" });
  });

  it("openai_console REFUSES a file whose columns were renamed, naming what is missing", () => {
    try {
      openAiConsoleAdapter.parse({ content: "day,member,cost\n2026-07-01,jane@acme.com,3.50\n", format: "csv" });
      throw new Error("should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(CostImportFormatError);
      expect((e as CostImportFormatError).detail.missing?.join(" ")).toContain("account");
      expect((e as CostImportFormatError).detail.headersFound).toContain("day");
    }
  });

  it("openai_console refuses an org-level row with no user rather than spreading it", () => {
    const r = openAiConsoleAdapter.parse({
      content: "date,user,model,n_requests,amount\n2026-07-01,,gpt-4o,12,3.50\n",
      format: "csv",
    });
    expect(r.lines).toHaveLength(0);
    expect(r.refusals[0]!.reason).toMatch(/cannot be attributed/);
  });

  it("anthropic_console reads a start/end window", () => {
    const r = anthropicConsoleAdapter.parse({
      content:
        "usage_start,usage_end,workspace_member,model,input_tokens,cost_usd\n" +
        "2026-07-01,2026-07-31,jane@acme.com,claude-x,1000,4.25\n",
      format: "csv",
    });
    expect(r.lines[0]).toMatchObject({ vendor: "anthropic", amount: 4.25, quantity: 1000 });
  });

  it("aws_cur carries its currency column and its account id (which is NOT an email)", () => {
    const r = awsCurAdapter.parse({
      content:
        "lineItem/UsageAccountId,lineItem/UsageStartDate,lineItem/UsageEndDate,lineItem/ProductCode,lineItem/UsageAmount,lineItem/UnblendedCost,lineItem/CurrencyCode\n" +
        "123456789012,2026-07-01,2026-07-02,AmazonBedrock,10,1.75,USD\n",
      format: "csv",
    });
    expect(r.lines[0]).toMatchObject({ accountRef: "123456789012", currency: "USD", amount: 1.75, vendor: "aws" });
    expect(awsCurAdapter.capabilities.accountIsEmail).toBe(false);
  });

  it("seat_roster stamps every line as DERIVED from an operator-asserted price", () => {
    const r = seatRosterAdapter.parse({
      content: "email,plan\njane@acme.com,business\nbob@acme.com,business\n",
      format: "csv",
      config: {
        seatPriceUsd: 19,
        vendor: "github-copilot",
        periodStart: "2026-07-01",
        periodEnd: "2026-08-01",
        planColumn: "plan",
      },
    });
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ amount: 19, billingKind: "seat", vendor: "github-copilot", service: "business" });
    expect(r.lines[0]!.detail).toMatchObject({ derivedFrom: "operator-asserted seat price", seatPriceUsd: 19 });
  });

  it("every adapter declares a non-trivial `limits` string", () => {
    for (const a of [genericMappedAdapter, openAiConsoleAdapter, anthropicConsoleAdapter, awsCurAdapter, seatRosterAdapter]) {
      expect(a.limits.length).toBeGreaterThan(80);
      expect(a.limits).toMatch(/not|no |cannot|does not/i);
    }
  });
});

// ===========================================================================
// Identity resolution
// ===========================================================================

const USERS = new Map([
  ["jane@acme.com", "u-jane"],
  ["bob@acme.com", "u-bob"],
]);

describe("resolveVendorAccount", () => {
  it("matches an exact email case-insensitively", () => {
    const r = resolveVendorAccount("Jane@ACME.com", "openai", { userIdByEmail: USERS, aliases: [], domainRules: [] });
    expect(r).toMatchObject({ userId: "u-jane", method: "exact_email" });
  });

  it("an ADMIN ALIAS beats an exact email — otherwise a correction is not a correction", () => {
    const r = resolveVendorAccount("jane@acme.com", "openai", {
      userIdByEmail: USERS,
      aliases: [{ id: "a1", vendor: ANY_VENDOR, accountKey: "jane@acme.com", userId: "u-bob" }],
      domainRules: [],
    });
    expect(r).toMatchObject({ userId: "u-bob", method: "admin_alias", mappingId: "a1" });
  });

  it("a vendor-specific alias beats an all-vendor one", () => {
    const r = resolveVendorAccount("x@vendor.io", "openai", {
      userIdByEmail: USERS,
      aliases: [
        { id: "any", vendor: ANY_VENDOR, accountKey: "x@vendor.io", userId: "u-bob" },
        { id: "specific", vendor: "openai", accountKey: "x@vendor.io", userId: "u-jane" },
      ],
      domainRules: [],
    });
    expect(r).toMatchObject({ userId: "u-jane", mappingId: "specific" });
  });

  it("a domain rule rewrites and then requires an exact match", () => {
    const r = resolveVendorAccount("jane@acme-corp.com", "openai", {
      userIdByEmail: USERS,
      aliases: [],
      domainRules: [{ id: "d1", vendor: ANY_VENDOR, fromDomain: "acme-corp.com", toDomain: "acme.com", enabled: true }],
    });
    expect(r).toMatchObject({ userId: "u-jane", method: "domain_rule", domainRuleId: "d1" });
  });

  it("two rules that disagree resolve to NOBODY", () => {
    const r = resolveVendorAccount("jane@old.com", "openai", {
      userIdByEmail: new Map([...USERS, ["jane@other.com", "u-other"]]),
      aliases: [],
      domainRules: [
        { id: "d1", vendor: ANY_VENDOR, fromDomain: "old.com", toDomain: "acme.com", enabled: true },
        { id: "d2", vendor: ANY_VENDOR, fromDomain: "old.com", toDomain: "other.com", enabled: true },
      ],
    });
    expect(r.userId).toBeNull();
    expect(r.method).toBe("unresolved");
    expect(r.detail).toMatch(/ambiguous/);
  });

  it("a disabled rule does nothing", () => {
    const r = resolveVendorAccount("jane@acme-corp.com", "openai", {
      userIdByEmail: USERS,
      aliases: [],
      domainRules: [{ id: "d1", vendor: ANY_VENDOR, fromDomain: "acme-corp.com", toDomain: "acme.com", enabled: false }],
    });
    expect(r.userId).toBeNull();
  });

  it("a non-email account is unresolved with a reason naming the only fix", () => {
    const r = resolveVendorAccount("123456789012", "aws", { userIdByEmail: USERS, aliases: [], domainRules: [] });
    expect(r.userId).toBeNull();
    expect(r.detail).toMatch(/alias/);
  });
});

// ===========================================================================
// Consolidation
// ===========================================================================

describe("consolidate", () => {
  const base = {
    by: "user" as const,
    metered: [
      { userId: "u-jane", costCenter: "CC-1", costUsd: 10 },
      { userId: "u-jane", costCenter: "CC-1", costUsd: null },
    ],
    imported: [
      { userId: "u-jane", costCenter: "CC-1", vendor: "github-copilot", amount: 19, currency: "USD", billingKind: "seat" as const },
      { userId: null, costCenter: null, vendor: "aws", amount: 5, currency: "USD", billingKind: "usage" as const },
    ],
  };

  it("keeps the two bases separate and never emits their sum", () => {
    const { subjects } = consolidate(base);
    const jane = subjects.find((s) => s.subjectId === "u-jane")!;
    expect(jane.metered.usd).toBe(10);
    expect(jane.imported.usd).toBe(19);
    expect(JSON.stringify(jane)).not.toContain("29");
    expect(Object.keys(jane)).not.toContain("total");
  });

  it("an unpriced metered event is unpriced, not zero", () => {
    const { subjects } = consolidate(base);
    const jane = subjects.find((s) => s.subjectId === "u-jane")!;
    expect(jane.metered.events).toBe(2);
    expect(jane.metered.unpricedEvents).toBe(1);
  });

  it("unattributed spend gets its own row rather than being dropped or spread", () => {
    const { subjects } = consolidate(base);
    const un = subjects.find((s) => s.subjectId === null)!;
    expect(un.attributed).toBe(false);
    expect(un.imported.usd).toBe(5);
    expect(un.label).toMatch(/unattributed/);
    // and it sorts LAST so it cannot be mistaken for a person
    expect(subjects[subjects.length - 1]!.attributed).toBe(false);
  });

  it("refuses a single-currency figure for a mixed-currency subject", () => {
    const { subjects } = consolidate({
      by: "user",
      metered: [],
      imported: [
        { userId: "u-jane", costCenter: null, vendor: "v", amount: 10, currency: "USD", billingKind: "usage" },
        { userId: "u-jane", costCenter: null, vendor: "v", amount: 10, currency: "EUR", billingKind: "usage" },
      ],
    });
    const jane = subjects[0]!;
    expect(jane.imported.usd).toBeNull();
    expect(jane.imported.usdNote).toMatch(/no FX conversion/);
    expect(jane.imported.byCurrency).toHaveLength(2);
  });

  it("groups by cost centre using the same machinery", () => {
    const { subjects } = consolidate({ ...base, by: "cost_center" });
    const cc = subjects.find((s) => s.subjectId === "CC-1")!;
    expect(cc.metered.usd).toBe(10);
    expect(cc.imported.usd).toBe(19);
  });

  it("the CSV has two money columns and no combined one", () => {
    const csv = renderConsolidatedCsv(consolidate(base).subjects);
    const header = csv.split("\n")[0]!;
    expect(header).toContain("metered_usd");
    expect(header).toContain("imported_usd");
    expect(header).not.toMatch(/total|combined|grand/);
    expect(csv).not.toContain("29.00");
  });
});
