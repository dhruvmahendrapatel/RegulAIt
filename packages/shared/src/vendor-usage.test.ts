import { describe, expect, it } from "vitest";
import {
  anthropicCostReportSchema,
  centsDecimalToDollars,
  cursorUsageEventsSchema,
  factOverlapsMetered,
  githubBillingUsageSchema,
  normalizeAnthropicCostReport,
  normalizeCursorUsageEvents,
  normalizeGithubCopilotUsage,
  normalizeOpenAiCosts,
  openAiCostsSchema,
  vendorUsageFactKey,
  vendorUsagePublicConfigSchemas,
  VendorUsageResponseError,
} from "./vendor-usage.js";
import { STATE_MACHINES, VENDOR_USAGE_PULL_RUN_MACHINE as M } from "./state-machines.js";

describe("ADR-0322 vendor usage normalisers", () => {
  it("moves the decimal point for Anthropic cents strings instead of dividing a float", () => {
    expect(centsDecimalToDollars("123.78912")).toBe(1.2378912);
    expect(centsDecimalToDollars("5")).toBe(0.05);
    expect(centsDecimalToDollars("0.1")).toBe(0.001);
    expect(centsDecimalToDollars("100000")).toBe(1000);
    expect(centsDecimalToDollars("-250")).toBe(-2.5);
    for (const bad of ["", "1e3", "12,5", "NaN", "0x10", " 1 2"]) {
      expect(() => centsDecimalToDollars(bad)).toThrow(VendorUsageResponseError);
    }
  });

  it("normalises an Anthropic cost report page into workspace-level imported facts", () => {
    const page = anthropicCostReportSchema.parse({
      data: [
        {
          starting_at: "2026-11-01T00:00:00Z",
          ending_at: "2026-11-02T00:00:00Z",
          results: [
            { amount: "1234.5", currency: "USD", workspace_id: "wrkspc_01", description: "Input Tokens", cost_type: "tokens", model: "claude-x", token_type: "uncached_input_tokens" },
            { amount: "10", currency: "USD", workspace_id: null, description: "Web search", cost_type: "web_search" },
          ],
        },
        { starting_at: "2026-11-02T00:00:00Z", ending_at: "2026-11-03T00:00:00Z", results: [] },
      ],
      has_more: false,
      next_page: null,
    });
    const facts = normalizeAnthropicCostReport(page);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({ accountRef: "anthropic workspace wrkspc_01", accountKind: "workspace", accountId: "wrkspc_01", amount: 12.345, currency: "USD", periodStart: "2026-11-01T00:00:00.000Z" });
    expect(facts[1]).toMatchObject({ accountRef: "anthropic workspace default", accountId: null, amount: 0.1 });
    // the fact identity is stable across pulls and distinct across lines
    expect(vendorUsageFactKey(facts[0]!)).toBe(vendorUsageFactKey(normalizeAnthropicCostReport(page)[0]!));
    expect(vendorUsageFactKey(facts[0]!)).not.toBe(vendorUsageFactKey(facts[1]!));
    expect(vendorUsageFactKey(facts[0]!)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalises an OpenAI costs page, naming the API key when given and the project otherwise", () => {
    const page = openAiCostsSchema.parse({
      object: "page",
      data: [
        {
          object: "bucket",
          start_time: 1762214400,
          end_time: 1762300800,
          results: [
            { object: "organization.costs.result", amount: { value: 0.06, currency: "usd" }, line_item: "gpt-x, input", project_id: "proj_a", api_key_id: "key_1" },
            { object: "organization.costs.result", amount: { value: 1.5, currency: "usd" }, line_item: "file search", project_id: "proj_b", api_key_id: null },
            { object: "organization.costs.result", amount: { value: 2, currency: "usd" }, line_item: null, project_id: null, api_key_id: null },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    });
    const facts = normalizeOpenAiCosts(page);
    expect(facts.map((f) => [f.accountKind, f.accountRef, f.amount, f.currency])).toEqual([
      ["api_key", "openai api key key_1", 0.06, "USD"],
      ["project", "openai project proj_b", 1.5, "USD"],
      ["organisation", "openai organisation (no project)", 2, "USD"],
    ]);
    const cfg = vendorUsagePublicConfigSchemas.openai.parse({ gatewayApiKeyIds: ["key_1"], gatewayProjectIds: ["proj_b"] });
    expect(facts.map((f) => factOverlapsMetered("openai", f, cfg, f.detail.projectId as string | undefined))).toEqual([true, true, false]);
    // a key that is not the gateway's, inside a project that is, still overlaps: the project is the gateway's
    const cfg2 = vendorUsagePublicConfigSchemas.openai.parse({ gatewayProjectIds: ["proj_a"] });
    expect(factOverlapsMetered("openai", facts[0]!, cfg2, "proj_a")).toBe(true);
  });

  it("refuses a malformed vendor page rather than mapping fields it does not recognise", () => {
    expect(anthropicCostReportSchema.safeParse({ data: [{ starting_at: "x", ending_at: "y", results: [{ amount: 12 }] }], has_more: false }).success).toBe(false);
    expect(openAiCostsSchema.safeParse({ data: [{ start_time: 1, end_time: 2, results: [{ amount: "1" }] }], has_more: false }).success).toBe(false);
    const inverted = anthropicCostReportSchema.parse({ data: [{ starting_at: "2026-11-02T00:00:00Z", ending_at: "2026-11-01T00:00:00Z", results: [] }], has_more: false });
    expect(() => normalizeAnthropicCostReport(inverted)).toThrow(VendorUsageResponseError);
  });

  it("validates connector configuration strictly", () => {
    expect(vendorUsagePublicConfigSchemas.anthropic.parse({})).toEqual({ gatewayWorkspaceIds: [], backfillDays: 7 });
    expect(vendorUsagePublicConfigSchemas.anthropic.safeParse({ baseUrl: "https://evil.example" }).success).toBe(false);
    expect(vendorUsagePublicConfigSchemas.openai.safeParse({ backfillDays: 90 }).success).toBe(false);
  });
});

describe("ADR-0322 pull run lifecycle (ADR-0348 machine)", () => {
  it("opens running or refused, ends running in one terminal state, and never leaves a terminal state", () => {
    expect(M.def.initial).toEqual(["running", "refused"]);
    for (const e of ["succeed", "fail", "refuse"] as const) expect(M.sourcesOf(e)).toEqual(["running"]);
    expect(M.next("running", "succeed")).toBe("succeeded");
    expect(M.next("running", "fail")).toBe("failed");
    expect(M.next("running", "refuse")).toBe("refused");
    for (const s of ["succeeded", "failed", "refused"] as const) {
      expect(M.isTerminal(s)).toBe(true);
      expect(() => M.next(s, "fail")).toThrow(/not allowed/);
    }
    expect(STATE_MACHINES.vendor_usage_pull_run).toBe(M);
  });
});

describe("ADR-0322 slice 3: GitHub Copilot and Cursor normalisers", () => {
  it("keeps only Copilot lines of the GitHub billing usage report, per organisation, product, SKU and repository", () => {
    const page = githubBillingUsageSchema.parse({
      usageItems: [
        { date: "2026-11-17T00:00:00Z", product: "Copilot", sku: "Copilot Business", quantity: 3, unitType: "user-months", pricePerUnit: 19, grossAmount: 57, discountAmount: 0, netAmount: 57, organizationName: "acme-eng", repositoryName: null },
        { date: "2026-11-17", product: "copilot premium requests", sku: "Premium request", quantity: 10, unitType: "requests", netAmount: 0.4, organizationName: "acme-eng", repositoryName: "acme-eng/api" },
        { date: "2026-11-17T00:00:00Z", product: "Actions", sku: "Linux", quantity: 100, unitType: "minutes", netAmount: 0.8, organizationName: "acme-eng" },
      ],
    });
    const facts = normalizeGithubCopilotUsage(page, { kind: "organization", slug: "acme-eng" });
    expect(facts.map((f) => [f.accountRef, f.amount, f.currency, f.service, f.periodStart, f.periodEnd])).toEqual([
      ["github organization acme-eng", 57, "USD", "Copilot Business", "2026-11-17T00:00:00.000Z", "2026-11-18T00:00:00.000Z"],
      ["github organization acme-eng", 0.4, "USD", "Premium request", "2026-11-17T00:00:00.000Z", "2026-11-18T00:00:00.000Z"],
    ]);
    expect(facts[1]!.detail).toMatchObject({ repository: "acme-eng/api" });
    // the repository is part of the fact identity, so two repositories are two facts
    expect(vendorUsageFactKey(facts[0]!)).not.toBe(vendorUsageFactKey(facts[1]!));
    expect(factOverlapsMetered("github_copilot", facts[0]!, vendorUsagePublicConfigSchemas.github_copilot.parse({ account: "organization", slug: "acme-eng" }))).toBe(false);
  });

  it("sums two Copilot items with the same identity on one day instead of keeping only one (#1069 R4)", () => {
    const page = githubBillingUsageSchema.parse({
      usageItems: [
        { date: "2026-11-17", product: "Copilot", sku: "Premium request", quantity: 10, unitType: "requests", pricePerUnit: 0.04, grossAmount: 0.4, discountAmount: 0, netAmount: 0.4, organizationName: "acme-eng" },
        { date: "2026-11-17", product: "Copilot", sku: "Premium request", quantity: 5, unitType: "requests", pricePerUnit: 0.02, grossAmount: 0.1, discountAmount: 0, netAmount: 0.1, organizationName: "acme-eng" },
      ],
    });
    const facts = normalizeGithubCopilotUsage(page, { kind: "organization", slug: "acme-eng" });
    expect(facts).toHaveLength(1);
    expect([facts[0]!.amount, facts[0]!.quantity, facts[0]!.unit]).toEqual([0.5, 15, "requests"]);
    expect(facts[0]!.detail).toMatchObject({ grossAmount: 0.5, discountAmount: 0 });
  });

  it("refuses a usage item whose date is not a date", () => {
    const page = githubBillingUsageSchema.parse({ usageItems: [{ date: "yesterday", product: "Copilot", netAmount: 1 }] });
    expect(() => normalizeGithubCopilotUsage(page, { kind: "enterprise", slug: "acme" })).toThrow(VendorUsageResponseError);
  });

  it("accepts only a GitHub login or slug as the path segment", () => {
    const s = vendorUsagePublicConfigSchemas.github_copilot;
    expect(s.safeParse({ account: "enterprise", slug: "acme-corp" }).success).toBe(true);
    for (const bad of ["../x", "acme/eng", "-acme", "acme.example", "", "a".repeat(101)]) {
      expect(s.safeParse({ account: "organization", slug: bad }).success, bad).toBe(false);
    }
    expect(s.safeParse({ account: "user", slug: "acme" }).success).toBe(false);
  });

  it("sums Cursor charged cents per day, person, model, kind and product without float drift", () => {
    const day = Date.UTC(2026, 10, 17, 9);
    const page = cursorUsageEventsSchema.parse({
      usageEvents: [
        { timestamp: String(day), userEmail: "Dev@Example.com", model: "model-a", kind: "Usage-based", product: "agent", requestsCosts: 1, chargedCents: 0.1 },
        { timestamp: String(day + 3600_000), userEmail: "dev@example.com", model: "model-a", kind: "Usage-based", product: "agent", requestsCosts: 2, chargedCents: 0.2 },
        { timestamp: day, serviceAccountId: "sa_ci", model: "model-a", kind: "Usage-based", product: "agent", chargedCents: 150 },
        { timestamp: String(day + 86_400_000), userEmail: "dev@example.com", model: "model-a", kind: "Included", product: "agent", chargedCents: 0 },
      ],
      pagination: { currentPage: 1, hasNextPage: false },
    });
    const facts = normalizeCursorUsageEvents(page.usageEvents);
    expect(facts.map((f) => [f.accountRef, f.accountKind, f.amount, f.quantity, f.periodStart])).toEqual([
      ["dev@example.com", "user", 0.003, 3, "2026-11-17T00:00:00.000Z"],
      ["cursor service account sa_ci", "service_account", 1.5, 0, "2026-11-17T00:00:00.000Z"],
      ["dev@example.com", "user", 0, 0, "2026-11-18T00:00:00.000Z"],
    ]);
    expect(facts[0]!.detail).toEqual({ source: "cursor usage events", events: 2 });
    expect(factOverlapsMetered("cursor", facts[0]!, vendorUsagePublicConfigSchemas.cursor.parse({}))).toBe(false);
  });

  it("refuses a Cursor event without charged cents or with a timestamp that is not epoch milliseconds", () => {
    expect(cursorUsageEventsSchema.safeParse({ usageEvents: [{ timestamp: "1", userEmail: "a@b.c" }], pagination: { currentPage: 1, hasNextPage: false } }).success).toBe(false);
    expect(cursorUsageEventsSchema.safeParse({ usageEvents: [{ timestamp: "2026-11-17", chargedCents: 1 }], pagination: { currentPage: 1, hasNextPage: false } }).success).toBe(false);
    expect(() => normalizeCursorUsageEvents([{ timestamp: "9999999999999999", chargedCents: 1 }])).toThrow(VendorUsageResponseError);
    expect(() => normalizeCursorUsageEvents([{ timestamp: "9000000000000000", chargedCents: 1 }])).toThrow(VendorUsageResponseError);
  });
});
