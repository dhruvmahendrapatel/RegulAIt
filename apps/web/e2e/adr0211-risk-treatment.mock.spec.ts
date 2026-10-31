/**
 * ADR-0211 (P17) — transferred and avoided treatments on the Risks page,
 * against a mocked gateway (the *.mock.spec.ts harness):
 *
 *  - with the organisation switch off, a live risk shows no treatment form;
 *  - with it on, an admin records a transfer: the evidence and the owner are
 *    asked for at the point of decision (the owner defaults to the admin), and
 *    the body posted is exactly the treatment, the trimmed evidence and the owner;
 *  - another owner is picked from the people list, for an avoidance;
 *  - a refusal from the gateway shows inline beside the action;
 *  - a treated risk shows its record and reopens through an audited transition;
 *  - an older gateway without the new fields still renders the page;
 *  - axe (WCAG 2.x A/AA) in light and dark.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const RISK_ID = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

interface State {
  enabled: boolean;
  status: "open" | "transferred";
  legacy: boolean;
  refuse: boolean;
}
interface Captured {
  treatments: Array<Record<string, unknown>>;
  transitions: Array<Record<string, unknown>>;
}

function riskRow(state: State) {
  return {
    id: RISK_ID,
    title: "Supplier model leaks claim data",
    description: "A hosted model provider retains prompts.",
    category: "third_party_ai",
    ownerUserId: OWNER,
    ownerName: "Olive Owner",
    projectId: null,
    agentId: null,
    useCaseId: null,
    status: state.status,
    likelihood: "medium",
    impact: "high",
    mitigation: null,
    acceptedByUserId: null,
    acceptedAt: null,
    acceptanceNote: null,
    createdAt: iso(-20),
    controls: [],
  };
}

async function mockApi(page: Page, state: State): Promise<Captured> {
  const cap: Captured = { treatments: [], transitions: [] };
  // the Risks page is in the admin console
  const me = { userId: OTHER, isAdmin: true, user: { id: OTHER, email: "avery@example.test", displayName: "Avery Admin" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/risks/library") return json(route, { library: [], disclaimer: "d" });
    if (p === "/v1/risks/scenarios") return json(route, { scenarios: [], note: "" });
    if (p === "/v1/risks") return json(route, { risks: [riskRow(state)], disclaimer: "d" });
    if (p === `/v1/risks/${RISK_ID}/treatment` && method === "POST") {
      cap.treatments.push(req.postDataJSON() as Record<string, unknown>);
      if (state.refuse) return json(route, { error: "risk_treatments_off", detail: "recording a risk as transferred or avoided is turned off for this organisation" }, 409);
      state.status = "transferred";
      return json(route, riskRow(state), 201);
    }
    if (p === `/v1/risks/${RISK_ID}/transition` && method === "POST") {
      cap.transitions.push(req.postDataJSON() as Record<string, unknown>);
      state.status = "open";
      return json(route, riskRow(state));
    }
    if (p === `/v1/risks/${RISK_ID}/acceptances`) {
      return json(route, {
        riskId: RISK_ID,
        position: { riskId: RISK_ID, band: "medium", tolerance: { band: "medium", source: "default" }, acceptance: null, aboveTolerance: false, maxAcceptanceMonths: 12, maxExpiresAt: iso(365) },
        canAccept: false,
        acceptRefusal: state.status === "transferred" ? "risk_treated" : "not_an_acceptor",
        acceptances: [],
      });
    }
    if (p === `/v1/risks/${RISK_ID}`) {
      const declared: Record<string, unknown> = { likelihood: "medium", impact: "high", residual: null, status: state.status, mitigation: null, acceptance: null, note: "n" };
      const body: Record<string, unknown> = {
        risk: riskRow(state),
        declared,
        evidence: { window: { start: iso(-90), end: iso(0), days: 90 }, scope: { projectId: null, agentId: null }, entries: [], computedAt: iso(0), note: "live", disclaimer: "d" },
      };
      if (!state.legacy) {
        declared.treatment =
          state.status === "transferred"
            ? { treatment: "transferred", evidence: "Cyber policy CY-2026-114, clause 7", ownerUserId: OWNER, ownerName: "Olive Owner", treatedByUserId: OWNER, treatedAt: iso(0) }
            : null;
        body.treatments = { enabled: state.enabled };
      }
      return json(route, body);
    }
    if (p === "/v1/users") {
      return json(route, {
        users: [
          { id: OWNER, email: "olive@example.test", displayName: "Olive Owner", isAdmin: false, disabledAt: null, createdAt: iso(-100), totpEnabled: true, hasPassword: true },
          { id: OTHER, email: "avery@example.test", displayName: "Avery Admin", isAdmin: true, disabledAt: null, createdAt: iso(-100), totpEnabled: true, hasPassword: true },
        ],
      });
    }
    if (p === "/v1/risk-tolerances") return json(route, { source: "default", strictDefault: { maxBand: "medium" }, tolerances: [], effective: { categories: {}, tiers: {} }, bands: ["none", "low", "medium", "high", "critical"] });
    if (p === "/v1/agents") return json(route, { agents: [] });
    if (p === "/v1/projects") return json(route, { projects: [] });
    return json(route, {});
  });
  return cap;
}

async function expectAxeClean(page: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([
        Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

const treatmentCard = (page: Page) => page.locator("section[data-rg-card]").filter({ hasText: "Transfer or avoid this risk" }).first();

test.describe("ADR-0211: transferred and avoided risk treatments", () => {
  test("with the switch off, a live risk offers no treatment", async ({ page }) => {
    await mockApi(page, { enabled: false, status: "open", legacy: false, refuse: false });
    await page.goto(`/ui/admin/risks?riskId=${RISK_ID}`);
    await expect(page.getByText("Supplier model leaks claim data").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Start mitigating" })).toBeVisible();
    await expect(treatmentCard(page)).toHaveCount(0);
  });

  test("an admin records a transfer with evidence; the record shows and the risk reopens by an audited move", async ({ page }) => {
    const cap = await mockApi(page, { enabled: true, status: "open", legacy: false, refuse: false });
    await page.goto(`/ui/admin/risks?riskId=${RISK_ID}`);
    const card = treatmentCard(page);
    await expect(card).toContainText("a contract moves who pays, not whether the harm can happen");
    await expect(card.getByLabel("Owner of the arrangement — required")).toHaveValue(OTHER);
    const record = card.getByRole("button", { name: "Record transfer" });
    await expect(record).toBeDisabled();
    await expectAxeClean(page, "treatment form");

    await card.getByLabel("Contract or policy reference — required").fill("  Cyber policy CY-2026-114, clause 7  ");
    await record.click();
    await expect.poll(() => cap.treatments.length).toBe(1);
    expect(cap.treatments[0]).toEqual({ treatment: "transferred", evidence: "Cyber policy CY-2026-114, clause 7", ownerUserId: OTHER });

    const recordCard = page.locator("section[data-rg-card]").filter({ hasText: "Transfer record" }).first();
    await expect(recordCard).toBeVisible();
    await expect(recordCard.getByLabel("Contract or policy reference")).toHaveValue("Cyber policy CY-2026-114, clause 7");
    await expect(recordCard.getByLabel("Owner")).toHaveValue("Olive Owner");
    await expect(page.getByRole("button", { name: "Start mitigating" })).toHaveCount(0);
    await expectAxeClean(page, "transfer record");

    const reopen = recordCard.getByRole("button", { name: "Reopen risk" });
    await expect(reopen).toBeDisabled();
    await recordCard.getByLabel("Reason — required and audited").fill("the policy lapsed on renewal");
    await reopen.click();
    await expect.poll(() => cap.transitions.length).toBe(1);
    expect(cap.transitions[0]).toEqual({ status: "open", reason: "the policy lapsed on renewal" });
  });

  test("an admin chooses another owner from the people list and can record an avoidance", async ({ page }) => {
    const cap = await mockApi(page, { enabled: true, status: "open", legacy: false, refuse: false });
    await page.goto(`/ui/admin/risks?riskId=${RISK_ID}`);
    const card = treatmentCard(page);
    await card.getByLabel("Treatment").selectOption("avoided");
    await expect(card).toContainText("The use that created the risk has stopped");
    await card.getByLabel("Owner of the arrangement — required").selectOption(OWNER);
    await card.getByLabel("The decision that stopped the use — required").fill("Change board withdrew the pilot");
    await card.getByRole("button", { name: "Record avoidance" }).click();
    await expect.poll(() => cap.treatments.length).toBe(1);
    expect(cap.treatments[0]).toEqual({ treatment: "avoided", evidence: "Change board withdrew the pilot", ownerUserId: OWNER });
  });

  test("a refusal shows inline beside the action", async ({ page }) => {
    await mockApi(page, { enabled: true, status: "open", legacy: false, refuse: true });
    await page.goto(`/ui/admin/risks?riskId=${RISK_ID}`);
    const card = treatmentCard(page);
    await card.getByLabel("Contract or policy reference — required").fill("Supplier contract SC-88");
    await card.getByRole("button", { name: "Record transfer" }).click();
    await expect(card.getByRole("alert")).toBeVisible();
  });

  test("a gateway without the new fields still renders the risk", async ({ page }) => {
    await mockApi(page, { enabled: true, status: "open", legacy: true, refuse: false });
    await page.goto(`/ui/admin/risks?riskId=${RISK_ID}`);
    await expect(page.getByRole("button", { name: "Start mitigating" })).toBeVisible();
    await expect(treatmentCard(page)).toHaveCount(0);
  });
});
