/**
 * ADR-0179 G14-FEED from the browser's side, every /v1 and /auth call answered
 * by an in-test mock shaped like `GET /v1/regulatory/updates`:
 *
 *  - a withdrawn entry says so, with its withdrawal date, and is not shown as a
 *    gap or counted as in force;
 *  - a voluntary standard is labelled published, never "in force";
 *  - a law with a later enforcement date shows both dates;
 *  - the status and instrument-kind filters reach the API;
 *  - axe (WCAG 2.x A/AA) over the page in BOTH themes.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const impact = (gaps: number) => ({
  scopeBasis: "all_live_use_cases",
  useCases: [],
  controlsMapped: 2,
  controlsEvidenced: 2 - gaps,
  controlGaps: gaps,
  frameworkGaps: 0,
});
const frameworks = [{ framework: "nist-ai-rmf", packActive: true, activeVersion: 3 }];
const controls = [{ controlRef: "nist-ai-rmf:GOVERN-2.1", title: "Roles and responsibilities", framework: "nist-ai-rmf", status: "satisfied" }];
const base = { frameworks, controls, verifiedOn: "2026-10-05", enforcementDate: null, withdrawnOn: null, daysUntilEnforcement: null };

const updates = [
  {
    ...base,
    key: "cfpb-adverse-action-ai",
    jurisdiction: "US",
    instrument: "CFPB Circular 2022-03",
    instrumentKind: "guidance",
    title: "CFPB Circular 2022-03 — Adverse-action notices for complex algorithms (withdrawn)",
    summary: "The CFPB withdrew this circular on 12 May 2025. How the underlying rules apply is pending legal review.",
    effectiveDate: "2022-05-26",
    withdrawnOn: "2025-05-12",
    status: "withdrawn",
    daysUntilEffective: -1593,
    sourceUrl: "https://www.consumerfinance.gov/compliance/guidance/withdrawn-guidance/",
    impact: impact(1),
  },
  {
    ...base,
    key: "nyc-local-law-144",
    jurisdiction: "US-NYC",
    instrument: "NYC Local Law 144 of 2021",
    instrumentKind: "law",
    title: "NYC Local Law 144 — Automated employment decision tool bias audits",
    summary: "Took effect on 1 January 2023; enforced from 5 July 2023.",
    effectiveDate: "2023-01-01",
    enforcementDate: "2023-07-05",
    daysUntilEnforcement: -1188,
    status: "in_force",
    daysUntilEffective: -1373,
    sourceUrl: "https://legistar.council.nyc.gov/LegislationDetail.aspx?ID=4344524&GUID=B051915D-A9AC-451E-81F8-6596032FA3F9",
    impact: impact(1),
  },
  {
    ...base,
    key: "nist-ai-rmf-1-0",
    jurisdiction: "US",
    instrument: "NIST AI Risk Management Framework 1.0 (NIST AI 100-1)",
    instrumentKind: "voluntary_standard",
    title: "NIST AI RMF 1.0 — Voluntary framework for managing AI risks",
    summary: "Published in January 2023; the framework describes itself as voluntary.",
    effectiveDate: "2023-01-26",
    status: "published",
    daysUntilEffective: -1348,
    sourceUrl: "https://doi.org/10.6028/NIST.AI.100-1",
    impact: impact(0),
  },
  {
    ...base,
    key: "colorado-ai-act-sb26-189",
    jurisdiction: "US-CO",
    instrument: "Colorado SB 26-189 (Automated Decision-Making Technology)",
    instrumentKind: "law",
    title: "Colorado SB 26-189 — Automated decision-making technology in consequential decisions",
    summary: "Developer documentation duties start on 1 January 2027.",
    effectiveDate: "2027-01-01",
    status: "upcoming",
    daysUntilEffective: 88,
    sourceUrl: "https://leg.colorado.gov/bills/sb26-189",
    impact: impact(1),
  },
];

const feed = {
  generatedAt: "2026-10-05T12:00:00.000Z",
  window: { days: 30 },
  summary: {
    total: 4,
    inForce: 1,
    upcoming: 1,
    proposed: 0,
    published: 1,
    withdrawn: 1,
    byKind: { law: 2, guidance: 1, voluntary_standard: 1 },
    withControlGaps: 2,
    nextEffective: "colorado-ai-act-sb26-189",
  },
  notes: {
    source: "Each entry is curated from the primary source linked on it.",
    evidence: "Satisfied or attested counts as evidenced.",
    scope: "Scope is a prompt for review, not a legal determination.",
    status: "Voluntary standards are published, never in force. A withdrawn entry stays listed with its withdrawal date.",
    applicability: "Whether an entry applies to this organisation has not had legal review.",
    feed: "4 curated entries.",
  },
};

async function mockApi(page: Page) {
  const queries: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } });
    if (p === "/v1/regulatory/updates") {
      queries.push(url.search);
      const status = url.searchParams.get("status");
      const kind = url.searchParams.get("kind");
      const framework = url.searchParams.get("framework");
      return json(route, {
        ...feed,
        updates: updates.filter((u) => (!status || u.status === status) && (!kind || u.instrumentKind === kind) && (!framework || u.frameworks.some((f) => f.framework === framework))),
        filter: { status, kind, framework },
      });
    }
    return json(route, {});
  });
  return queries;
}

const THEMES = ["light", "dark"] as const;
async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    // finite transitions only, capped at 1 s
    const finite = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
    const settled = Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
  await setTheme(page, "light");
}

const entry = (page: Page, title: string) => page.getByRole("listitem").filter({ has: page.getByText(title, { exact: true }) });

test.describe("ADR-0179 G14-FEED: regulatory intelligence statuses and kinds", () => {
  test("withdrawn, voluntary and enforcement-dated entries say what they are; axe-clean in both themes", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/governance/regulatory");
    await expect(page.getByRole("heading", { name: "Regulatory & policy intelligence" })).toBeVisible();

    // the counts keep withdrawn and voluntary entries apart from law in force
    // the KPI strip comes first on the page, so a label's first match is its stat tile
    const stat = (label: string) => page.getByText(label, { exact: true }).first().locator("..");
    await expect(stat("Withdrawn")).toHaveText(/^1\s*Withdrawn$/);
    await expect(stat("Voluntary standards")).toHaveText(/^1\s*Voluntary standards$/);
    await expect(stat("In force")).toHaveText(/^1\s*In force$/);

    const cfpb = entry(page, "CFPB Circular 2022-03 — Adverse-action notices for complex algorithms (withdrawn)");
    await expect(cfpb.getByText("Withdrawn", { exact: true })).toBeVisible();
    await expect(cfpb.getByText(/Withdrawn on May 12, 2025\./)).toBeVisible();
    await expect(cfpb.getByText("Not counted: withdrawn")).toBeVisible();
    await expect(cfpb.getByText(/\d+ gaps?$/)).toHaveCount(0);
    await expect(cfpb.getByText("Guidance", { exact: true })).toBeVisible();

    const nist = entry(page, "NIST AI RMF 1.0 — Voluntary framework for managing AI risks");
    await expect(nist.getByText("Voluntary standard", { exact: true })).toBeVisible();
    await expect(nist.getByText("Voluntary standard: published, not law in force.")).toBeVisible();
    await expect(nist.getByText("In force", { exact: true })).toHaveCount(0);
    await expect(nist.getByText(/^published .* ago$/)).toBeVisible();

    const nyc = entry(page, "NYC Local Law 144 — Automated employment decision tool bias audits");
    await expect(nyc.getByText("Effective Jan 1, 2023 · enforced from Jul 5, 2023")).toBeVisible();

    await expect(page.getByText("Whether an entry applies to this organisation has not had legal review.")).toBeVisible();
    await expectAxeClean(page, "regulatory intelligence");
  });

  test("the status and instrument-kind filters reach the API and narrow the list", async ({ page }) => {
    const queries = await mockApi(page);
    await page.goto("/ui/admin/governance/regulatory");
    await expect(page.getByRole("heading", { name: "Regulatory & policy intelligence" })).toBeVisible();

    await page.getByLabel("Status").selectOption("withdrawn");
    await expect(page.getByRole("list", { name: "Regulatory effective-date timeline" }).getByRole("listitem")).toHaveCount(1);
    await expect(page.getByText("CFPB Circular 2022-03 — Adverse-action notices for complex algorithms (withdrawn)")).toBeVisible();
    expect(queries).toContain("?status=withdrawn");

    await page.getByLabel("Status").selectOption("");
    await page.getByLabel("Instrument kind").selectOption("voluntary_standard");
    await expect(page.getByRole("list", { name: "Regulatory effective-date timeline" }).getByRole("listitem")).toHaveCount(1);
    await expect(page.getByText("NIST AI RMF 1.0 — Voluntary framework for managing AI risks")).toBeVisible();
    expect(queries).toContain("?kind=voluntary_standard");

    await page.getByLabel("Status").selectOption("in_force");
    await expect(page.getByText("No entries match these filters")).toBeVisible();
    await expectAxeClean(page, "regulatory intelligence, filtered to nothing");
  });
});
