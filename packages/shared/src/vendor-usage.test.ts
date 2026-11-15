import { describe, expect, it } from "vitest";
import {
  anthropicCostReportSchema,
  centsDecimalToDollars,
  factOverlapsMetered,
  normalizeAnthropicCostReport,
  normalizeOpenAiCosts,
  openAiCostsSchema,
  vendorUsageFactKey,
  vendorUsagePublicConfigSchemas,
  VendorUsageResponseError,
} from "./vendor-usage.js";

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
