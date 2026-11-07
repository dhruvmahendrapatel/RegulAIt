/**
 * Model risk never reads /v1/mrm/cards/null (follow-up to #694), against a mocked gateway.
 *
 *  - with no card open, the page's refresh (after a write, or Retry) makes no card-detail read at all;
 *  - a detail read that answers 200 without its card shows the error with Retry, not a crash, and Retry reads again;
 *  - with a card open, the detail read and its refresh are unchanged;
 *  - axe (WCAG 2.x A/AA, light and dark) on the error state, through the shared helper.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./prompts-fixtures";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000b8`;
const T = "2026-10-20T12:00:00.000Z";
const ME_ID = U(99);
const ME = { userId: ME_ID, isAdmin: true, user: { id: ME_ID, email: "ada@example.test", displayName: "Ada Admin" } };
const AGENT = U(1);
const CARD = U(2);

const STATUS = (cards: number) => ({
  enforced: true,
  warnDays: 30,
  stalenessRecertEnabled: true,
  stalenessRecertThreshold: 1,
  fairness: { enabled: false, blockOnFail: false },
  posture: "enforced",
  label: "ENFORCED by this deployment — a dispatch of a model with no unexpired approved card is refused (409)",
  cards,
  approved: 0,
  expiring: 0,
  expired: 0,
  pending: 0,
  unsigned: cards,
  revoked: 0,
  note: "Bias/fairness here is a RECORDED DECLARATION, not a measurement — regulAIt does not run fairness tests.",
});

const CARD_ROW = {
  id: CARD,
  agentId: AGENT,
  customProviderId: null,
  intendedUse: "Contract clause triage",
  limitations: null,
  dataClaims: {},
  biasFairness: [],
  standardRefs: [],
  state: "unsigned",
  daysUntilExpiry: null,
  subjectKind: "agent",
  subjectName: "Clause triage",
  approvals: [],
  evidence: [],
  completeness: { complete: false, missing: ["sign_off"], bias: { declared: 0, assessed: 0, waived: 0, unevidenced: 0, complete: false, disclaimer: "declared, not measured" } },
  createdAt: T,
};

interface Scenario {
  cards: unknown[];
  /** what the open card's detail read answers: the card, or a 200 body with no card */
  detail: "card" | "no-card";
  /** every /v1/mrm/cards/<id> GET the page made, by id */
  detailReads: string[];
}

async function mockApi(page: Page, init: Partial<Scenario> = {}): Promise<Scenario> {
  const st: Scenario = { cards: [], detail: "card", detailReads: [], ...init };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    if (p === "/v1/agents") return json(route, { agents: [{ id: AGENT, name: "Clause triage" }] });
    if (p === "/v1/mrm/status") return json(route, STATUS(st.cards.length));
    if (p === "/v1/mrm/expiring") return json(route, { warnDays: 30, items: [] });
    if (p === "/v1/mrm/cards" && req.method() === "POST") {
      st.cards = [CARD_ROW];
      return json(route, { card: CARD_ROW }, 201);
    }
    if (p === "/v1/mrm/cards") return json(route, { cards: st.cards });
    const m = /^\/v1\/mrm\/cards\/([^/]+)$/.exec(p);
    if (m && req.method() === "GET") {
      st.detailReads.push(m[1]!);
      if (m[1] !== CARD) return json(route, { error: "not_found" }, 404);
      if (st.detail === "no-card") return json(route, {});
      return json(route, { card: { ...CARD_ROW, autofill: null, staleness: null } });
    }
    return json(route, {});
  });
  return st;
}

async function open(page: Page) {
  await page.goto("/ui/admin/model-risk");
  await expect(page.getByRole("heading", { name: "Model risk", level: 1 })).toBeVisible();
}

const openRow = (page: Page) =>
  page.getByRole("row").filter({ hasText: "Contract clause triage" }).getByRole("button", { name: "Open" });

test.describe("Model risk: no card-detail read without an open card", () => {
  test("no card open: the refresh after creating a card reads no card detail, so never /v1/mrm/cards/null", async ({ page }) => {
    const st = await mockApi(page);
    await open(page);
    await page.getByLabel("Agent").selectOption(AGENT);
    await page.getByLabel("Intended use").fill("Contract clause triage");
    await page.getByRole("button", { name: "Create card" }).click();
    // the refresh ran: the new card is listed
    await expect(page.getByRole("cell", { name: "Contract clause triage" })).toBeVisible();
    await page.waitForTimeout(500);
    expect(st.detailReads).not.toContain("null");
    expect(st.detailReads).toEqual([]);
  });

  test("a detail read that answers 200 without its card shows the error with Retry, not a crash", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const st = await mockApi(page, { cards: [CARD_ROW], detail: "no-card" });
    await open(page);
    await openRow(page).click();
    const alert = page.getByRole("alert").filter({ hasText: "Couldn't load this model card" });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
    // the rest of the page and the card itself still render
    await expect(page.getByRole("heading", { name: "Model risk", level: 1 })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Model card" })).toBeVisible();
    expect(errors).toEqual([]);

    await expectAxeClean(page, "Model risk, card detail missing");

    // Retry reads the open card again; a full answer clears the error
    const before = st.detailReads.length;
    st.detail = "card";
    await alert.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("Couldn't load this model card")).toHaveCount(0);
    expect(st.detailReads.length).toBeGreaterThan(before);
    expect(st.detailReads.every((id) => id === CARD)).toBe(true);
  });

  test("a card open: its detail is read, and closing it stops the reads", async ({ page }) => {
    const st = await mockApi(page, { cards: [CARD_ROW] });
    await open(page);
    expect(st.detailReads).toEqual([]);
    await openRow(page).click();
    await expect(page.getByRole("tab", { name: "Model card" })).toBeVisible();
    await expect.poll(() => st.detailReads).toEqual([CARD]);
    await expect(page.getByText("Couldn't load this model card")).toHaveCount(0);
    await page.getByRole("row").filter({ hasText: "Contract clause triage" }).getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("tab", { name: "Model card" })).toHaveCount(0);
    expect(st.detailReads.every((id) => id === CARD)).toBe(true);
  });
});
