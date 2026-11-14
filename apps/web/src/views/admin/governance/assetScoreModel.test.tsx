/**
 * Per-asset posture scores: the paths follow the gateway's query schema, an unmeasured objective never shows its zero,
 * a not-applicable objective shows its reason and no score, and the figure is labelled an estimate.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AssetScoreView } from "./AssetScore";
import { assetDetailPath, assetListPath, objectiveScoreText, parseAssetPage, parseAssetScore, pointsText, shareText, type AssetScoreDoc } from "./assetScoreModel";

const doc: AssetScoreDoc = {
  estimate: true,
  asset: { kind: "use_case", id: "11111111-1111-4111-8111-111111111111", name: "Claims triage" },
  score: 50,
  scale: { min: 0, max: 100 },
  method: "The weighted mean of the 2 objectives that apply to a use case.",
  disclaimer: "An estimate computed from this deployment's own records. It is not a compliance verdict.",
  weights: [
    { objective: "risk", title: "Risk treatment", weight: 20, sharePct: 57.1 },
    { objective: "access", title: "Access hygiene", weight: 15, sharePct: 42.9 },
  ],
  notApplicable: [{ objective: "spend", title: "Spend control", why: "budgets are set on projects, not on use cases" }],
  objectives: [
    {
      id: "risk",
      title: "Risk treatment",
      outcome: "Every AI risk registered against this use case has a treatment.",
      metric: { label: "Registered risks with a treatment", value: "unmeasured" },
      weight: 20,
      measured: false,
      score: 0,
      contribution: 0,
      inputs: [{ label: "Risks naming this use case", value: "0" }],
      formula: "None registered scores 0.",
      link: { to: "/admin/governance/use-cases/1", label: "Open the use case" },
    },
    {
      id: "access",
      title: "Access hygiene",
      outcome: "This use case has an accountable owner whose account is active.",
      metric: { label: "Owner", value: "active owner" },
      weight: 15,
      measured: true,
      score: 100,
      contribution: 15,
      inputs: [{ label: "Ownership", value: "active owner" }],
      formula: "100 when the owner is active.",
      link: { to: "/admin/governance/use-cases/1", label: "Open the use case" },
    },
  ],
  actions: [
    { key: "risk:register", rank: 1, objective: "risk", title: "Register the AI risks this use case carries", points: 57.1, reason: "no risk names this use case", link: { to: "/admin/governance/use-cases/1", label: "Open the use case" } },
  ],
};

describe("asset score model", () => {
  it("builds the list path with the kind, the page ceiling and the cursor", () => {
    expect(assetListPath("agent", null)).toBe("/v1/reports/posture/assets?kind=agent&limit=100");
    expect(assetListPath("use_case", "abc")).toBe("/v1/reports/posture/assets?kind=use_case&limit=100&cursor=abc");
  });
  it("builds the detail path", () => {
    expect(assetDetailPath("agent", "a/b")).toBe("/v1/reports/posture/assets/agent/a%2Fb");
  });
  it("never shows an unmeasured objective's zero", () => {
    expect(objectiveScoreText({ measured: false, score: 0 })).toBe("Unmeasured");
    expect(objectiveScoreText({ measured: true, score: 0 })).toBe("0 of 100");
  });
  it("refuses a response that is not a score, so it shows as a failed read", () => {
    expect(parseAssetScore(doc)).toBe(doc);
    expect(() => parseAssetScore({})).toThrow();
    expect(parseAssetPage({ items: [doc], nextCursor: null }).items).toHaveLength(1);
    expect(() => parseAssetPage({})).toThrow();
    expect(() => parseAssetPage({ items: [{}] })).toThrow();
  });
  it("reads shares and points from the server", () => {
    expect(shareText(doc, "risk")).toBe("57.1%");
    expect(shareText(doc, "coverage")).toBe("—");
    expect(pointsText(1)).toBe("1 point");
    expect(pointsText(2.5)).toBe("2.5 points");
  });
});

describe("AssetScoreView", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <AssetScoreView doc={doc} />
    </MemoryRouter>,
  );
  it("labels the figure an estimate and shows the disclaimer", () => {
    expect(html).toContain("Estimate");
    expect(html).toContain("It is not a compliance verdict.");
    expect(html.toLowerCase()).not.toMatch(/\bcompliant\b|\bcertified\b/);
  });
  it("says unmeasured instead of a zero", () => {
    expect(html).toContain("Unmeasured");
    expect(html).not.toMatch(/>0 of 100</);
    expect(html).toContain("100 of 100");
  });
  it("lists a not-applicable objective with its reason and no score", () => {
    expect(html).toContain("Spend control: not applicable, budgets are set on projects, not on use cases.");
  });
  it("ranks actions with their links", () => {
    expect(html).toContain("Register the AI risks this use case carries");
    expect(html).toContain("+57.1 points");
    expect(html).toContain('href="/admin/governance/use-cases/1"');
  });
});
