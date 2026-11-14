/**
 * Batch I-2 rollout G (owner, #453, pattern 4): one empty state on Model risk, against a mocked gateway
 * (the *.mock.spec.ts harness). Deferred from #657/#692 while #628 changed the page.
 *
 *  - while no model card exists, exactly one empty state shows, inside the author form (the primary action), straight
 *    after the enforcement posture; the empty expiring list and the empty registry are not stacked under it;
 *  - every warning, step-up control, disabled state and (i) stays;
 *  - a failed posture read is never shown as empty: it says it failed, with Retry;
 *  - one card brings the full page back, and creating the first card from the empty state does too;
 *  - axe (WCAG 2.x A/AA, light and dark) on the empty state, through the shared helper.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./prompts-fixtures";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000a7`;
const T = "2026-10-20T12:00:00.000Z";
const ME_ID = U(99);
const ME = { userId: ME_ID, isAdmin: true, user: { id: ME_ID, email: "ada@example.test", displayName: "Ada Admin" } };
const AGENT = U(1);
const CARD = U(2);

const STATUS = (cards: number, over: Record<string, unknown> = {}) => ({
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
  ...over,
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
  /** the posture read's card count, or a failing status */
  status: { cards: number; over?: Record<string, unknown> } | { fail: number };
  cards: unknown[];
  posts: unknown[];
}

async function mockApi(page: Page, init: Partial<Scenario> = {}): Promise<Scenario> {
  const st: Scenario = { status: { cards: 0 }, cards: [], posts: [], ...init };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    if (p === "/v1/agents") return json(route, { agents: [{ id: AGENT, name: "Clause triage" }] });
    if (p === "/v1/mrm/status") {
      if ("fail" in st.status) return json(route, { error: "internal", detail: "the posture could not be read" }, st.status.fail);
      return json(route, STATUS(st.status.cards, st.status.over));
    }
    if (p === "/v1/mrm/expiring") return json(route, { warnDays: 30, items: [] });
    if (p === "/v1/mrm/cards" && req.method() === "POST") {
      st.posts.push(req.postDataJSON());
      st.cards = [CARD_ROW];
      st.status = { cards: 1 };
      return json(route, { card: CARD_ROW }, 201);
    }
    if (p === "/v1/mrm/cards") return json(route, { cards: st.cards });
    if (p === `/v1/mrm/cards/${CARD}`) return json(route, { card: { ...CARD_ROW, autofill: null, staleness: null } });
    // the gateway's answer for any other card id (the page's refresh also re-asks for the open card's detail)
    if (p.startsWith("/v1/mrm/cards/")) return json(route, { error: "not_found" }, 404);
    return json(route, {});
  });
  return st;
}

/** the page's empty-state headings in the main region */
const emptyTitles = (page: Page) =>
  page.locator("main").getByText(/^No .* yet$|^Nothing .* yet$|^No model cards$|^Nothing lapsing$/);
const card = (page: Page, title: string) =>
  page.locator("[data-rg-card]").filter({ has: page.getByText(title, { exact: true }) });

async function open(page: Page) {
  await page.goto("/ui/admin/model-risk");
  await expect(page.getByRole("heading", { name: "Model risk", level: 1 })).toBeVisible();
}

test.describe("I-2 rollout G: Model risk", () => {
  test("no model card: one empty state inside the author form, straight after the posture, warnings and (i)s kept", async ({ page }) => {
    await mockApi(page);
    await open(page);
    await expect(page.getByText("No model cards yet", { exact: true })).toBeVisible();
    await expect(emptyTitles(page)).toHaveCount(1);
    // the registry's warning travels into the one empty state
    await expect(page.getByText(/An empty registry enforces nothing, whatever the toggle says/)).toBeVisible();

    // the stacked empty lists are gone while nothing exists
    await expect(page.getByText("Expiring and lapsed sign-offs", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Model cards", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download Excel" })).toHaveCount(0);

    // order: posture (the warning) first, then the primary action, then the settings cards
    const titles = await page.locator("[data-rg-card]").evaluateAll((els) =>
      els.map((el) => el.textContent ?? ""),
    );
    const idx = (t: string) => titles.findIndex((x) => x.includes(t));
    expect(idx("Enforcement posture")).toBe(0);
    expect(idx("Author a model card")).toBe(1);
    expect(idx("Expiry warning window")).toBeGreaterThan(1);
    expect(idx("Re-test after a model change")).toBeGreaterThan(1);

    // the author form is the primary action: its first control is the agent, and Create card stays disabled until filled
    const author = card(page, "Author a model card");
    await expect(author.getByRole("combobox").first()).toHaveAccessibleName("Agent");
    await expect(author.getByRole("button", { name: "Create card" })).toBeDisabled();
    await expect(author.getByText("Mapping, not certification", { exact: true })).toBeVisible();

    // the posture warnings and controls stay, with their step-up writes and disabled state
    const posture = card(page, "Enforcement posture");
    await expect(posture.getByText(/ENFORCED by this deployment/)).toBeVisible();
    await expect(page.getByLabel("Refuse dispatch of an unreviewed or lapsed model")).toHaveValue("on");
    await expect(page.getByLabel("Staleness forces recertification")).toHaveValue("on");
    await expect(page.getByRole("button", { name: "Save threshold" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Expiry sweep" })).toHaveText("Run sweep");

    // every (i) stays and opens
    await expect(page.getByRole("button", { name: /^What is .*\?$/ }).first()).toBeVisible();
    await page.getByRole("button", { name: "What is how recertification works?" }).click();
    await expect(page.getByRole("note").getByText(/deepens that gate, it creates none of its own/)).toBeVisible();
    await page.keyboard.press("Escape");
    await author.getByRole("button", { name: /^What is Standard refs/ }).click();
    await expect(page.getByRole("note").getByText(/does not make this deployment, or its customer, certified/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(posture.getByRole("button", { name: /^What is / }).first()).toBeVisible();

    await expectAxeClean(page, "Model risk, nothing yet");
  });

  test("the declared-only posture with no card keeps its warning above the one empty state", async ({ page }) => {
    await mockApi(page, {
      status: {
        cards: 0,
        over: { enforced: false, posture: "absent", label: "No model cards exist. An empty registry enforces nothing, whatever the toggle says." },
      },
    });
    await open(page);
    await expect(card(page, "Enforcement posture").getByText("No model cards exist. An empty registry enforces nothing, whatever the toggle says.")).toBeVisible();
    await expect(page.getByLabel("Refuse dispatch of an unreviewed or lapsed model")).toHaveValue("off");
    await expect(emptyTitles(page)).toHaveCount(1);
  });

  test("the primary action: creating the first card brings the full page back", async ({ page }) => {
    const st = await mockApi(page);
    await open(page);
    await page.getByLabel("Agent").selectOption(AGENT);
    await page.getByLabel("Intended use").fill("Contract clause triage");
    await page.getByRole("button", { name: "Create card" }).click();
    await expect.poll(() => st.posts.length).toBe(1);
    expect(st.posts[0]).toMatchObject({ agentId: AGENT, intendedUse: "Contract clause triage" });
    await expect(page.getByRole("cell", { name: "Contract clause triage" })).toBeVisible();
    await expect(page.getByText("No model cards yet", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Expiring and lapsed sign-offs", { exact: true })).toBeVisible();
  });

  test("a failed posture read shows the error with Retry, never the empty state", async ({ page }) => {
    const st = await mockApi(page, { status: { fail: 500 } });
    await open(page);
    const retry = page.getByRole("button", { name: "Retry" });
    await expect(retry).toBeVisible();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByText("No model cards yet")).toHaveCount(0);
    await expect(page.getByText("Author a model card", { exact: true })).toHaveCount(0);
    await page.waitForTimeout(2500);
    await expect(retry).toBeVisible();
    await expect(page.getByText("No model cards yet")).toHaveCount(0);
    // Retry reads again; an answered zero then shows the one empty state
    st.status = { cards: 0 };
    await retry.click();
    await expect(page.getByText("No model cards yet", { exact: true })).toBeVisible();
  });

  test("a posture read that omits the count is never read as zero", async ({ page }) => {
    await mockApi(page, { status: { cards: 0, over: { cards: undefined } }, cards: [CARD_ROW] });
    await open(page);
    await expect(page.getByRole("cell", { name: "Contract clause triage" })).toBeVisible();
    await expect(page.getByText("No model cards yet")).toHaveCount(0);
  });

  test("one card is something: the page renders its sections as before", async ({ page }) => {
    await mockApi(page, { status: { cards: 1 }, cards: [CARD_ROW] });
    await open(page);
    await expect(page.getByText("No model cards yet")).toHaveCount(0);
    const titles = await page.locator("[data-rg-card]").evaluateAll((els) => els.map((el) => el.textContent ?? ""));
    const idx = (t: string) => titles.findIndex((x) => x.includes(t));
    expect(idx("Enforcement posture")).toBe(0);
    expect(idx("Expiry warning window")).toBeLessThan(idx("Expiring and lapsed sign-offs"));
    expect(idx("Expiring and lapsed sign-offs")).toBeLessThan(idx("Author a model card"));
    expect(idx("Author a model card")).toBeLessThan(idx("Model cards"));
    await expect(page.getByText("Nothing lapsing", { exact: true })).toBeVisible();
    await page.getByRole("row").filter({ hasText: "Contract clause triage" }).getByRole("button", { name: "Open" }).click();
    await expect(page.getByRole("tab", { name: "Model card" })).toBeVisible();
  });
});
