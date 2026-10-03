/**
 * ADR-0168 items 1-3 from the browser's side, every /v1 and /auth call
 * answered by an in-test mock (the same harness as intake-a11y.mock.spec.ts):
 *
 *  - ONE entry point: the registry creates nothing itself; its split
 *    "Register AI use case" action (and the home page's link) open the intake
 *    wizard, and the menu also offers the existing agent registration;
 *  - the registry: headline tiles, status chips, tier/owner filters, search,
 *    the Valid until / Open conditions columns, and a row opening the right
 *    preview with "Open use case";
 *  - the registration's "Similar use cases" rail: lists existing use cases
 *    like the one being typed, links each, and never blocks submission;
 *  - axe (WCAG 2.x A/AA) over each screen in BOTH themes.
 *
 * Set GOV_SHOTS_DIR to also save light + dark screenshots of each screen.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SHOTS = process.env.GOV_SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const USE_CASE = "11111111-1111-4111-8111-111111111111";
const NEW_ID = "99999999-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const row = <T extends Record<string, unknown>>(over: T) => ({
  description: "", businessContext: "", ownerUserId: "u", ownerName: "Avery Admin", intendedAgentIds: [], dataSensitivity: "internal",
  complianceTags: [], projectId: null, workflowInstanceId: "instance", euAiActTier: null, euAiActReasons: null, euAiActRulesetVersion: null,
  decidedAt: null, retiredReason: null, approvedUntil: null, openConditions: 0, ...over,
});
const useCases = [
  row({ id: USE_CASE, name: "Credit-limit-increase assistant", description: "Recommends credit-limit increases with a human reviewing every recommendation.", status: "under_review", euAiActTier: "high", complianceTags: ["eu-ai-act"], dataSensitivity: "regulated", createdAt: "2026-10-01T09:00:00Z" }),
  row({ id: "22222222-1111-4111-8111-111111111111", name: "Support ticket summarizer", description: "Summarizes inbound support tickets for the service desk queue.", status: "approved", euAiActTier: "minimal", ownerUserId: "riley", ownerName: "Riley Reviewer", createdAt: "2026-08-12T09:00:00Z", decidedAt: "2026-08-20T09:00:00Z", approvedUntil: "2027-08-20T09:00:00Z", openConditions: 2 }),
  row({ id: "33333333-1111-4111-8111-111111111111", name: "Customer service chatbot", description: "Answers customer questions about card limits and statements.", status: "needs_info", euAiActTier: "limited", createdAt: "2026-09-21T09:00:00Z" }),
  row({ id: "44444444-1111-4111-8111-111111111111", name: "Fraud scoring model", description: "Scores card transactions for fraud review.", status: "approved", euAiActTier: "high", ownerUserId: "riley", ownerName: "Riley Reviewer", createdAt: "2026-02-02T09:00:00Z", decidedAt: "2026-03-01T09:00:00Z", approvedUntil: "2026-09-01T09:00:00Z" }),
  row({ id: "55555555-1111-4111-8111-111111111111", name: "Meeting notes drafter", description: "Drafts meeting notes from transcripts.", status: "proposed", createdAt: "2026-10-02T09:00:00Z" }),
];

const detail = {
  useCase: { ...useCases[1], approvedAt: "2026-08-20T09:00:00Z", approvalExpired: false },
  instance: { id: "instance", status: "completed", currentStageId: null, stages: [{ id: "plan", type: "plan" }, { id: "questionnaire", type: "artifact" }, { id: "signoff", type: "approval" }] },
  questionnaire: { version: 1, content: "## 1. Purpose\n\nSummarize tickets.", createdAt: "2026-08-13T09:00:00Z" },
  questionnaireTemplate: null,
  cascadeConsequences: { profiles: [], unrecognizedTags: [], combined: null, project: null, note: "" },
  euAiActScreening: { tier: "minimal", reasons: [], rulesetVersion: 1, disclaimer: "Screening, not legal advice.", enforcement: "", answersStatus: "ok", answersError: null, refusal: null, cascade: null },
  intendedVsGranted: { status: "no_intent_recorded", note: "" },
  conditions: [
    { id: "c1", approvalId: "ap", text: "Add a monthly accuracy sample", ownerUserId: "riley", ownerName: "Riley Reviewer", dueAt: "2026-11-01T00:00:00Z", blocking: false, status: "open", metAt: null, metByName: null, overdue: false },
    { id: "c2", approvalId: "ap", text: "Publish the user notice", ownerUserId: "u", ownerName: "Avery Admin", dueAt: "2026-10-20T00:00:00Z", blocking: true, status: "open", metAt: null, metByName: null, overdue: false },
  ],
};

const assist = {
  tier: { value: "limited", reasons: [{ ruleId: "art-50", tier: "limited", ref: "Art. 50", reason: "interacts directly with people" }], rulesetVersion: 1, source: "rules", disclaimer: "Screening, not legal advice." },
  frameworks: [{ framework: "eu-ai-act", title: "EU AI Act", why: "EU nexus", source: "rules" }],
  risks: [{ scenarioKey: "hallucination", title: "Wrong answers about card limits", description: "The assistant may state a limit that is not the customer's.", category: "reliability", dimension: "reliability", likelihood: "medium", impact: "medium", suggestedControls: [], why: "it answers customers directly", source: "model" }],
  euAiActBlock: "```eu-ai-act-answers\n{\"purposeDomain\":\"general-business\"}\n```",
  questionnaire: [{ id: "q1", heading: "1. Purpose and business context", text: "Draft answer", source: "mock" }],
  blocking: null,
  narrative: { status: "drafted", source: "mock" },
  disclaimer: "Suggestions only.",
};

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page: Page) {
  const created: unknown[] = [];
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me") return json(route, { userId: "u", isAdmin: true, via: "session", user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "u", isAdmin: true, user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" } });
    if (p === "/v1/use-cases" && method === "GET") return json(route, { useCases });
    if (p === "/v1/use-cases" && method === "POST") {
      created.push(route.request().postDataJSON());
      return json(route, { id: NEW_ID, instance: { id: "instance-new" } }, 201);
    }
    if (p === `/v1/use-cases/${useCases[1]!.id}`) return json(route, detail);
    if (p === "/v1/use-cases/intake/assist") return json(route, assist);
    if (p === "/v1/agents") return json(route, { agents: [{ id: AGENT, name: "Service assistant", provider: "mock", model: "mock-balanced" }] });
    if (p === "/v1/vendors") return json(route, { vendors: [] });
    if (p === "/v1/risks" && method === "POST") return json(route, { id: "risk" }, 201);
    return json(route, {});
  });
  return { created };
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  }, theme);
}

/** axe in both themes, and (with GOV_SHOTS_DIR) a full-page shot of each */
async function checkScreen(page: Page, label: string, shot?: string) {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `axe on "${label}" (${theme})`).toEqual([]);
    if (SHOTS && shot) await page.screenshot({ path: path.join(SHOTS, `after-${shot}-${theme}.png`), fullPage: true });
  }
  await setTheme(page, "light");
}

test.describe("ADR-0168: one registry, one way in", () => {
  test("the registry: tiles, chips, filters, the new columns and the preview drawer", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/use-cases");
    await expect(page.getByRole("heading", { level: 1, name: "AI registry" })).toBeVisible();
    const table = page.getByRole("table");
    await expect(table.locator("thead th")).toHaveText(["Name", "Status", "Tier", "Owner", "Created", "Valid until", "Open conditions"]);
    // nothing on the registry creates a use case: no form, no propose button
    await expect(page.getByRole("button", { name: /Propose/ })).toHaveCount(0);
    await expect(page.getByRole("main").locator("form")).toHaveCount(0);

    // headline tiles
    const tiles = page.getByRole("group", { name: "Headline counts" });
    await expect(tiles.getByRole("button")).toHaveText(["Use cases 5", "Under review 3", "Approved 2", "High tier 2"]);
    // valid until: a date after approval, an expired approval called out, a dash before; open conditions counted
    const approved = table.getByRole("link", { name: /^Support ticket summarizer, Approved/ });
    await expect(approved).toContainText("20 Aug 2027");
    await expect(approved.getByRole("cell").last()).toHaveText("2");
    await expect(table.getByRole("link", { name: /^Fraud scoring model/ })).toContainText("Expired 1 Sept 2026");
    await expect(table.getByRole("link", { name: /^Meeting notes drafter/ }).getByRole("cell").nth(5)).toHaveText("—");
    await checkScreen(page, "Registry", "registry");

    // a tile filters; pressing it again clears
    await tiles.getByRole("button", { name: "Under review 3", exact: true }).click();
    await expect(table.getByRole("link")).toHaveCount(3);
    await expect(page.getByRole("group", { name: "Status" }).getByRole("button", { name: /In review/ })).toHaveAttribute("aria-pressed", "true");
    await tiles.getByRole("button", { name: "Under review 3", exact: true }).click();
    await expect(table.getByRole("link")).toHaveCount(5);
    // chips, tier, owner and search narrow together; "Clear all" resets
    await page.getByRole("group", { name: "Status" }).getByRole("button", { name: /^Approved/ }).click();
    await expect(table.getByRole("link")).toHaveCount(2);
    await page.getByLabel("Tier").selectOption("high");
    await expect(table.getByRole("link")).toHaveCount(1);
    await expect(table.getByRole("link")).toContainText("Fraud scoring model");
    await page.getByRole("button", { name: "Clear all" }).click();
    await page.getByLabel("Owner").selectOption({ label: "Riley Reviewer" });
    await expect(table.getByRole("link")).toHaveCount(2);
    await page.getByRole("button", { name: "Clear all" }).click();
    await page.getByLabel("Search use cases").fill("chatbot");
    await expect(table.getByRole("link")).toHaveCount(1);
    await page.getByLabel("Search use cases").fill("nothing like this");
    await expect(page.getByText("No use cases match these filters")).toBeVisible();
    await page.getByRole("button", { name: "Clear all" }).first().click();
    await expect(table.getByRole("link")).toHaveCount(5);

    // a row opens the right-hand preview; its primary action opens the record
    await approved.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Support ticket summarizer" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("heading", { name: "Support ticket summarizer" })).toBeFocused();
    await expect(drawer.getByRole("link", { name: "Open use case" })).toHaveAttribute("href", `/ui/admin/governance/use-cases/${useCases[1]!.id}`);
    await expect(drawer.getByText("Publish the user notice · due 20 Oct 2026 · Avery Admin")).toBeVisible();
    await expect(drawer.getByText("2 (1 before go-live)")).toBeVisible();
    // the questionnaire stays viewable, read-only — there is no fill-and-submit form
    await drawer.getByText(/^Questionnaire · version 1/).click();
    await expect(drawer.getByText("Summarize tickets.", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Submit questionnaire" })).toHaveCount(0);
    await checkScreen(page, "Registry (preview open)", "registry-preview");
    // Escape closes and hands focus back to the row
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(approved).toBeFocused();
  });

  test("every way in leads to the intake wizard; the split menu also registers an agent", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/use-cases");
    await page.getByRole("link", { name: "Register AI use case" }).click();
    await expect(page).toHaveURL(/\/ui\/admin\/governance\/intake$/);
    await expect(page.getByRole("heading", { level: 1, name: "Register AI use case" })).toBeVisible();

    await page.goto("/ui/admin/use-cases");
    const more = page.getByRole("button", { name: "More ways to register" });
    await more.click();
    const menu = page.getByRole("menu", { name: "Register" });
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await checkScreen(page, "Registry (register menu open)");
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: /Register an agent/ })).toBeFocused();
    await expect(menu.getByRole("menuitem", { name: /Register an agent/ })).toHaveAttribute("href", "/ui/admin/agents");
    await expect(menu.getByRole("menuitem", { name: /Register AI use case/ })).toHaveAttribute("href", "/ui/admin/governance/intake");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();

    // the home page's shortcut goes to the same place (a first-run dialog may
    // sit over the page under these mocks, so the link is found by its text)
    await page.goto("/ui/");
    await expect(page.locator("a", { hasText: "Register an AI use case" })).toHaveAttribute("href", "/ui/admin/governance/intake");
  });
});

test.describe("ADR-0168: registration shows similar use cases and never blocks on them", () => {
  test("the rail lists use cases like the one being typed, links each, and submission still goes through", async ({ page }) => {
    const store = await mockApi(page);
    await page.goto("/ui/admin/governance/intake");
    const rail = page.getByRole("complementary", { name: "Similar use cases" });
    await expect(rail).toContainText("Type a name and purpose");
    await page.getByLabel("Use-case name").fill("Customer support chatbot");
    await page.getByLabel("What will the system do?").fill("Answers customer questions about support tickets and card limits.");
    await expect(rail).toContainText(/We found \d similar use cases — review them to avoid a duplicate\./);
    const links = rail.getByRole("link");
    await expect(links.first()).toHaveText("Customer service chatbot");
    await expect(links.first()).toHaveAttribute("href", "/ui/admin/governance/use-cases/33333333-1111-4111-8111-111111111111");
    expect(await links.allTextContents()).toContain("Support ticket summarizer");
    expect(await links.allTextContents()).not.toContain("Meeting notes drafter");
    await expect(page.getByLabel("Owner")).toHaveCount(0);
    await expect(page.getByText("Avery Admin (you)")).toBeVisible();
    await checkScreen(page, "Register — Describe", "register-1-describe");

    // the duplicates are advice: Continue is enabled with them on screen
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator('[aria-current="step"]')).toContainText("Classify");
    await expect(rail.getByRole("link").first()).toBeVisible();
    for (const [label, value] of [
      ["Primary purpose domain", "general-business"], ["People affected", "customers"], ["Decision autonomy", "informs-human"],
      ["Biometric use", "none"], ["Deployment audience", "customer-facing"],
    ] as const) await page.getByLabel(label).selectOption(value);
    await page.getByLabel("Sectors: Financial services", { exact: true }).check();
    await page.getByLabel("Data categories: Personal", { exact: true }).check();
    for (const label of ["Emotion recognition", "Social scoring", "Manipulative techniques", "Profiles natural persons", "Safety component", "Generates synthetic content", "Can take autonomous actions", "Uses an external AI vendor"]) {
      await page.getByLabel(label).selectOption("no");
    }
    for (const label of ["Interacts directly with people", "Has an EU nexus"]) await page.getByLabel(label).selectOption("yes");
    await checkScreen(page, "Register — Classify", "register-2-classify");
    await page.getByRole("button", { name: "Draft suggestions" }).click();
    await expect(page.locator('[aria-current="step"]')).toContainText("Suggestions");
    await expect(page.getByText("Suggested by rules").first()).toBeVisible();
    await expect(page.getByText("Suggested by AI").first()).toBeVisible();
    await checkScreen(page, "Register — Suggestions", "register-3-suggestions");
    await page.getByRole("button", { name: /Accept all remaining/ }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator('[aria-current="step"]')).toContainText("Questionnaire");
    await checkScreen(page, "Register — Questionnaire", "register-4-questionnaire");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator('[aria-current="step"]')).toContainText("Link stack");
    await page.getByLabel("Model / agent").selectOption(AGENT);
    await checkScreen(page, "Register — Link stack", "register-5-stack");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator('[aria-current="step"]')).toContainText("Review");
    await checkScreen(page, "Register — Review", "register-6-review");
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Submitted for human review." })).toBeVisible();
    expect(store.created).toHaveLength(1);
    expect(store.created[0]).toMatchObject({ name: "Customer support chatbot", businessContext: "Answers customer questions about support tickets and card limits." });
    await checkScreen(page, "Register — submitted", "register-7-submitted");
  });

  test("Cancel returns to the registry without writing anything", async ({ page }) => {
    const store = await mockApi(page);
    await page.goto("/ui/admin/governance/intake");
    await page.getByLabel("Use-case name").fill("Something new");
    await page.getByRole("link", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/ui\/admin\/use-cases$/);
    expect(store.created).toEqual([]);
  });
});
