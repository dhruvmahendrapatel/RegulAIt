/**
 * ADR-0180 A3 — the required AI tests editor on the review policy page,
 * against a mocked gateway (the *.mock.spec.ts harness):
 *
 *  - an empty stored policy reads as the STRICT DEFAULTS, tier by tier, with
 *    each OWASP id shown with its name;
 *  - an id nothing can measure is offered disabled, and the card says why;
 *  - editing a tier stores it (its badge changes) and saving sends the whole
 *    policy to its OWN route, never the review-policy PUT;
 *  - the gateway's 422 refusal is shown, not swallowed;
 *  - axe (WCAG 2.x A/AA) in light and dark.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const TIERS = ["minimal", "limited", "high", "prohibited", "unscreened"] as const;
const NAMES: Record<string, string> = {
  "owasp:llm:01": "Prompt Injection",
  "owasp:llm:02": "Sensitive Information Disclosure",
  "owasp:llm:03": "Supply Chain",
  "owasp:llm:04": "Data and Model Poisoning",
  "owasp:llm:06": "Excessive Agency",
  "owasp:llm:09": "Misinformation",
  "owasp:agentic:asi01": "ASI01: Agent Goal Hijack",
  "owasp:agentic:asi02": "ASI02: Tool Misuse and Exploitation",
  "owasp:agentic:asi06": "ASI06: Memory and Context Poisoning",
  "owasp:agentic:asi10": "ASI10: Rogue Agents",
};
const testClasses = Object.entries(NAMES).map(([id, name]) => ({
  id,
  name,
  list: id.includes("agentic") ? "owasp-agentic-top-10" : "owasp-llm-top-10",
  redteamClasses: ["owasp:llm:03", "owasp:llm:04", "owasp:llm:09"].includes(id) ? [] : ["prompt_injection"],
  scorerKinds: id === "owasp:llm:09" ? ["claim_support"] : [],
  measurable: !["owasp:llm:03", "owasp:llm:04"].includes(id),
}));
const HIGH = ["owasp:llm:01", "owasp:llm:02", "owasp:llm:06", "owasp:agentic:asi01", "owasp:agentic:asi02", "owasp:agentic:asi06", "owasp:agentic:asi10"];
const defaults = Object.fromEntries(
  TIERS.map((t) => [t, { classes: (t === "minimal" || t === "limited" ? ["owasp:llm:01"] : HIGH).map((testClass) => ({ testClass, maxAsr: 0 })), freshnessDays: 30 }]),
);
const viewOf = (policy: Record<string, { classes: Array<{ testClass: string; maxAsr?: number; minScore?: number }>; freshnessDays: number }>) => ({
  policy,
  effective: Object.fromEntries(
    TIERS.map((t) => {
      const src = policy[t] ?? defaults[t]!;
      return [t, { source: policy[t] ? "policy" : "default", freshnessDays: src.freshnessDays, classes: src.classes.map((c) => ({ ...c, name: NAMES[c.testClass], maxAsr: c.maxAsr ?? null, minScore: c.minScore ?? null })) }];
    }),
  ),
  defaults,
  defaultsNote: "Strict by default: every tier requires prompt injection (OWASP LLM01) with no successful attack.",
  freshness: { defaultDays: 30, maxDays: 90 },
  testClasses,
  unmeasurableExplanation: "No red-team attack class or eval scorer in this platform measures this OWASP class, so a requirement for it could never be satisfied by evidence.",
  updatedAt: null,
  updatedByName: null,
});

interface Captured {
  testPuts: unknown[];
  policyPuts: unknown[];
}

async function mockApi(page: Page, opts: { refuse?: boolean } = {}): Promise<Captured> {
  const cap: Captured = { testPuts: [], policyPuts: [] };
  let view = viewOf({});
  const me = { userId: "u", isAdmin: true, user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/users/directory") return json(route, { users: [{ id: "u", name: "Avery Admin" }] });
    if (p === "/v1/governance/review-policy/required-tests" && method === "PUT") {
      const body = req.postDataJSON() as Record<string, never>;
      cap.testPuts.push(body);
      if (opts.refuse) {
        return json(route, { error: "required_test_unmeasurable", testClass: "owasp:llm:04", detail: "owasp:llm:04 (Data and Model Poisoning) cannot be a required test" }, 422);
      }
      view = { ...viewOf(body), updatedAt: "2026-10-05T12:00:00.000Z", updatedByName: "Avery Admin" } as typeof view;
      return json(route, view);
    }
    if (p === "/v1/governance/review-policy/required-tests") return json(route, view);
    if (p === "/v1/governance/review-policy" && method === "PUT") {
      cap.policyPuts.push(req.postDataJSON());
      return json(route, {});
    }
    if (p === "/v1/governance/review-policy") return json(route, { roles: [], tiers: {}, riskAcceptorUserIds: [], updatedAt: null, updatedByName: null });
    if (p === "/v1/agents") return json(route, { agents: [] });
    return json(route, {});
  });
  return cap;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

const card = (page: Page) => page.locator("section[data-rg-card]").filter({ hasText: "Required AI tests by tier" }).first();
const tierRow = (page: Page, tier: string) => card(page).getByRole("listitem", { name: `Required AI tests, ${tier} tier` });

test.describe("ADR-0180 A3: required AI tests per tier", () => {
  test("shows the strict defaults with OWASP ids and names, and explains the unmeasurable ones", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/governance/review-policy");
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText("Strict by default");
    await expect(card(page)).toContainText("Not changed yet: every tier uses the strict default.");
    const high = tierRow(page, "high");
    await expect(high.getByText("Strict default")).toBeVisible();
    for (const id of ["LLM01", "LLM02", "LLM06", "ASI01", "ASI02", "ASI06", "ASI10"]) await expect(high.getByText(id, { exact: true })).toBeVisible();
    await expect(high.getByText("Excessive Agency", { exact: true })).toBeVisible();
    const limited = tierRow(page, "limited");
    await expect(limited.getByText("LLM01", { exact: true })).toBeVisible();
    await expect(limited.getByText("Prompt Injection", { exact: true })).toBeVisible();
    // an unmeasurable id is offered disabled, and the card says why
    const add = high.getByLabel("Add a required test class to the high tier");
    await expect(add.locator("option", { hasText: "LLM03 Supply Chain (cannot be measured)" })).toBeDisabled();
    await expect(card(page)).toContainText("Why some OWASP classes cannot be required");
    await expect(card(page)).toContainText("LLM03 Supply Chain, LLM04 Data and Model Poisoning: No red-team attack class");
    await expectAxeClean(page, "review policy with required AI tests");
  });

  test("an edited tier is stored; saving uses the required-tests route only", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/governance/review-policy");
    const limited = tierRow(page, "limited");
    await limited.getByLabel("Limited tier: LLM01 maximum attack success rate (%)").fill("5");
    await expect(limited.getByText("Set by policy")).toBeVisible();
    const high = tierRow(page, "high");
    await high.getByLabel("Add a required test class to the high tier").selectOption("owasp:llm:09");
    await expect(high.getByLabel("High tier: LLM09 minimum eval score (0 to 1)")).toHaveValue("0.8");
    await high.getByLabel("High tier: freshness in days (1 to 90)").fill("14");
    await card(page).getByRole("button", { name: "Save required tests" }).click();
    await expect.poll(() => cap.testPuts.length).toBe(1);
    const body = cap.testPuts[0] as Record<string, { classes: unknown[]; freshnessDays: number }>;
    expect(Object.keys(body).sort()).toEqual(["high", "limited"]);
    expect(body.limited).toEqual({ classes: [{ testClass: "owasp:llm:01", maxAsr: 5 }], freshnessDays: 30 });
    expect(body.high!.freshnessDays).toBe(14);
    expect(body.high!.classes).toContainEqual({ testClass: "owasp:llm:09", minScore: 0.8 });
    expect(cap.policyPuts).toEqual([]);
    await expect(card(page)).toContainText("by Avery Admin");
    await expectAxeClean(page, "review policy after saving required tests");
  });

  test("a bad freshness is caught before sending; the gateway's refusal is shown", async ({ page }) => {
    const cap = await mockApi(page, { refuse: true });
    await page.goto("/ui/admin/governance/review-policy");
    const minimal = tierRow(page, "minimal");
    await minimal.getByLabel("Minimal tier: freshness in days (1 to 90)").fill("120");
    await card(page).getByRole("button", { name: "Save required tests" }).click();
    await expect(minimal.getByRole("alert")).toContainText("Freshness must be a whole number of days from 1 to 90.");
    expect(cap.testPuts).toEqual([]);
    await minimal.getByLabel("Minimal tier: freshness in days (1 to 90)").fill("30");
    await card(page).getByRole("button", { name: "Save required tests" }).click();
    await expect(card(page).getByRole("alert")).toContainText("The required tests were not saved");
    await expect(card(page).getByRole("alert")).toContainText("Data and Model Poisoning");
    await expect(minimal.getByRole("button", { name: "Reset minimal tier to the strict default" })).toBeVisible();
    await minimal.getByRole("button", { name: "Reset minimal tier to the strict default" }).click();
    await expect(minimal.getByText("Strict default")).toBeVisible();
  });
});
