/**
 * AER-029 — accessibility of the AI use-case intake wizard, from the browser's
 * side alone. Every /v1 and /auth call is answered by an in-test mock (the same
 * harness as ui-defects.mock.spec.ts), so no database, seed or session is
 * needed. Each stage of the wizard is reached the way an operator reaches it,
 * then:
 *   - axe-core (WCAG 2.x A/AA) runs over the whole page in BOTH themes;
 *   - every interactive control inside <main> must expose an accessible name
 *     (Chromium's own name computation, via the aria snapshot);
 *   - the Describe stage is walked with Tab and must land on each control in
 *     reading order (the order is read from the rendered form, so a control
 *     added later — a field's help button — is walked too), and Escape must
 *     close a help disclosure and hand focus back to its trigger;
 *   - a stage change made from the keyboard lands focus on the new stage's
 *     heading, never on <body>;
 *   - the blocking (prohibited) screening and the request-failure states are
 *     scanned as well as the happy path.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

type Persona = { id: string; email: string; displayName: string };
const USER_A: Persona = { id: "user-a", email: "avery@example.test", displayName: "Avery Admin" };
const AGENT = "22222222-2222-4222-8222-222222222222";
const USE_CASE = "11111111-1111-4111-8111-111111111111";
const RISK = "33333333-3333-4333-8333-333333333333";

const authMe = (u: Persona) => ({
  userId: u.id, isAdmin: true, via: "session", user: { id: u.id, email: u.email, displayName: u.displayName },
  mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false,
});

/** Route only the API (documents, assets and Vite's own requests pass through). */
async function routeApi(page: Page, handler: (route: Route, pathname: string, method: string) => Promise<void> | void) {
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    await handler(route, p, route.request().method());
  });
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** the assistant's suggestion set — two frameworks, two risks, eight questionnaire drafts, nothing blocking */
const assist = {
  tier: { value: "high", reasons: [{ ruleId: "annex-iii", tier: "high", ref: "Annex III", reason: "Essential service" }], rulesetVersion: 1, source: "rules", disclaimer: "Screening, not legal advice." },
  frameworks: [
    { framework: "eu-ai-act", title: "EU AI Act", why: "EU nexus and high-risk purpose", source: "rules" },
    { framework: "nist-ai-rmf", title: "NIST AI RMF", why: "agentic financial workflow", source: "rules" },
  ],
  risks: [
    { scenarioKey: "credit-bias", title: "Disparate credit recommendation outcomes", description: "Profiling data may produce materially different recommendations across protected groups.", category: "bias_fairness", dimension: "bias", likelihood: "medium", impact: "high", suggestedControls: ["eu-ai-act:art-14-human-oversight"], why: "profiles natural persons", source: "rules" },
    { scenarioKey: "prompt-injection", title: "Prompt injection through customer-supplied text", description: "Free-text input may steer the assistant away from its instructions.", category: "security", dimension: "security", likelihood: "medium", impact: "medium", suggestedControls: [], why: "the system interacts directly with people", source: "mock" },
  ],
  euAiActBlock: "```eu-ai-act-answers\n{\"purposeDomain\":\"essential-services\",\"profilesNaturalPersons\":true}\n```",
  questionnaire: Array.from({ length: 8 }, (_, i) => ({
    id: `q${i + 1}`,
    heading: `${i + 1}. ${["Purpose and business context", "Affected people", "Data", "Human oversight", "Operations", "Monitoring", "Security", "Accountability"][i]}`,
    text: `Draft answer ${i + 1}`,
    source: "rules",
  })),
  blocking: null,
  narrative: { status: "drafted", source: "mock" },
  disclaimer: "Suggestions only.",
};

async function mockIntake(page: Page, opts: { assist?: unknown; assistStatus?: number; createStatus?: number } = {}) {
  await routeApi(page, async (route, p, method) => {
    if (p === "/auth/me") return json(route, authMe(USER_A));
    if (p === "/v1/me") return json(route, { userId: USER_A.id, isAdmin: true, user: USER_A });
    if (p === "/v1/approvals") return json(route, { approvals: [] });
    if (p === "/v1/agents") return json(route, { agents: [{ id: AGENT, name: "Credit assistant", provider: "mock", model: "mock-balanced", enabled: true, modes: ["chat"] }] });
    if (p === "/v1/vendors") return json(route, { vendors: [{ id: "v", name: "Acme Model Services", category: "model_provider", status: "approved" }] });
    if (p === "/v1/use-cases/intake/assist" && method === "POST") {
      return opts.assistStatus ? json(route, { error: "internal", detail: "assistant unavailable" }, opts.assistStatus) : json(route, opts.assist ?? assist);
    }
    if (p === "/v1/use-cases" && method === "POST") {
      return opts.createStatus ? json(route, { error: "internal", detail: "database unavailable" }, opts.createStatus) : json(route, { id: USE_CASE, instance: { id: "instance" } }, 201);
    }
    if (p === "/v1/risks" && method === "POST") return json(route, { id: RISK }, 201);
    return json(route, {});
  });
}

const STAGES = ["Describe", "Suggestions", "Questionnaire", "Link stack", "Review"] as const;
type Stage = (typeof STAGES)[number];

/** open the wizard and walk it, the operator's way, up to the named stage */
async function reach(page: Page, stage: Stage) {
  await page.goto("/ui/admin/governance/intake");
  await expect(page.getByRole("heading", { level: 1, name: "AI use-case intake" })).toBeVisible();
  if (stage === "Describe") return;
  await page.getByRole("button", { name: "Fill in an example" }).click();
  await page.getByRole("button", { name: "Draft suggestions" }).click();
  await expect(page.getByText("Review assistant suggestions", { exact: true })).toBeVisible();
  if (stage === "Suggestions") return;
  await page.getByRole("button", { name: /Accept all remaining/ }).click();
  for (const next of ["Questionnaire", "Link stack", "Review"] as const) {
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator(`[aria-current="step"]`)).toContainText(next);
    if (stage === next) return;
  }
}

const THEMES = ["light", "dark"] as const;
/** flip the theme the way useTheme does, then wait for every colour transition it starts to finish:
 * axe reading a button mid-transition would judge a colour that is on screen for 120ms, not the theme's */
async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    // getAnimations() flushes style, so the transitions this flip starts are already listed
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length), "transitions still running").toBe(0);
}

/** WCAG 2.0/2.1/2.2 A + AA over the whole page, in both themes; a violation is reported with its first node */
async function expectNoAxeViolations(page: Page, label: string) {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const summary = results.violations.map((v) =>
      `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe violations on "${label}" in the ${theme} theme`).toEqual([]);
  }
}

/** every interactive control under <main>, as the browser names it: `- role "name"` lines of the aria
 * snapshot (a line whose name holds a colon is wrapped in single quotes by the YAML writer) */
const INTERACTIVE = new Set(["button", "textbox", "combobox", "checkbox", "radio", "link", "switch", "spinbutton", "searchbox", "menuitem", "tab", "slider"]);
type Control = { role: string; name: string; disabled: boolean };
async function controlNames(page: Page, within: Locator = page.getByRole("main")): Promise<Control[]> {
  const snapshot = await within.ariaSnapshot();
  const out: Control[] = [];
  for (const line of snapshot.split("\n")) {
    const m = /^\s*-\s+'?([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(line);
    const role = m?.[1] ?? "";
    if (!INTERACTIVE.has(role)) continue;
    out.push({ role, name: m?.[2] ?? "", disabled: /\[disabled\]/.test(line) });
  }
  return out;
}
async function expectEveryControlNamed(page: Page, label: string, atLeast: number) {
  const controls = await controlNames(page);
  expect(controls.length, `controls found on "${label}"`).toBeGreaterThanOrEqual(atLeast);
  const unnamed = controls.filter((c) => c.name.trim() === "");
  expect(unnamed, `controls without an accessible name on "${label}"`).toEqual([]);
  return controls;
}

test.describe("AER-029: the intake wizard is accessible at every stage, in both themes", () => {
  test.beforeEach(async ({ page }) => { await mockIntake(page); });

  test("Describe — blank, and with the worked example loaded", async ({ page }) => {
    await reach(page, "Describe");
    await expectNoAxeViolations(page, "Describe (blank)");
    const blank = await expectEveryControlNamed(page, "Describe (blank)", 30);
    // the form's own fields, by the names a screen reader announces
    const names = blank.map((c) => `${c.role}:${c.name}`);
    for (const expected of [
      "button:Fill in an example", "textbox:Use-case name", "textbox:What will the system do?",
      "combobox:Primary purpose domain", "combobox:People affected", "combobox:Decision autonomy", "combobox:Biometric use",
      "checkbox:Sectors: Financial services", "checkbox:Data categories: Payment card", "combobox:Deployment audience",
      "combobox:Emotion recognition", "combobox:Social scoring", "combobox:Uses an external AI vendor", "button:Draft suggestions",
    ]) expect(names, `"${expected}" is announced on the Describe stage`).toContain(expected);
    // the two multi-select groups are announced as groups, not as a bare pile of boxes
    await expect(page.getByRole("group", { name: "Sectors — select all that apply" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Data categories — select all that apply" })).toBeVisible();

    await page.getByRole("button", { name: "Fill in an example" }).click();
    await expect(page.getByLabel("Use-case name")).toHaveValue("Credit-limit-increase assistant");
    await expectNoAxeViolations(page, "Describe (example loaded)");
    await expectEveryControlNamed(page, "Describe (example loaded)", 30);

    // a field's help panel open — the panel is page content too, in both themes
    await page.getByRole("button", { name: "What is the inventory identifier created here?" }).click();
    await expect(page.getByRole("note").filter({ hasText: "primary label for this proposed system" })).toBeVisible();
    await expectNoAxeViolations(page, "Describe (field help open)");
  });

  test("Describe — the assistant request fails", async ({ page }) => {
    await mockIntake(page, { assistStatus: 500 });
    await reach(page, "Describe");
    await page.getByRole("button", { name: "Fill in an example" }).click();
    await page.getByRole("button", { name: "Draft suggestions" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await expectNoAxeViolations(page, "Describe (assist failed)");
    await expectEveryControlNamed(page, "Describe (assist failed)", 30);
  });

  test("Describe — prefilled from a shadow-AI finding", async ({ page }) => {
    await page.goto("/ui/admin/governance/intake?source=shadow-ai&title=Unregistered%20assistant&description=Observed%20on%20team-17%20egress");
    await expect(page.getByRole("status")).toContainText("Prefilled from a shadow-AI finding");
    await expect(page.getByLabel("Use-case name")).toHaveValue("Unregistered assistant");
    await expectNoAxeViolations(page, "Describe (shadow-AI prefill)");
    await expectEveryControlNamed(page, "Describe (shadow-AI prefill)", 29);
  });

  test("Suggestions — undecided, then with one suggestion open for editing", async ({ page }) => {
    await reach(page, "Suggestions");
    await expectNoAxeViolations(page, "Suggestions");
    const controls = await expectEveryControlNamed(page, "Suggestions", 14);
    const names = controls.map((c) => `${c.role}:${c.name}`);
    // four suggestions, each with its own Accept / Edit / Reject
    expect(names.filter((n) => n === "button:Accept")).toHaveLength(4);
    expect(names.filter((n) => n === "button:Edit")).toHaveLength(4);
    expect(names.filter((n) => n === "button:Reject")).toHaveLength(4);
    expect(names).toContain("button:Accept all remaining (4)");
    expect(names).toContain("button:Back");
    // every suggestion's decision badge is readable text beside its title
    await expect(page.getByText("not reviewed")).toHaveCount(4);

    // editing opens a labelled textarea named after the suggestion it edits
    await page.getByRole("button", { name: "Edit" }).first().click();
    await expect(page.getByLabel("Edit EU AI Act")).toBeVisible();
    await expectNoAxeViolations(page, "Suggestions (editing)");
    await expectEveryControlNamed(page, "Suggestions (editing)", 15);
  });

  test("Questionnaire — with one section rejected", async ({ page }) => {
    await reach(page, "Questionnaire");
    await expectNoAxeViolations(page, "Questionnaire");
    const controls = await expectEveryControlNamed(page, "Questionnaire", 26);
    const names = controls.map((c) => `${c.role}:${c.name}`);
    for (let i = 1; i <= 8; i += 1) {
      const heading = `${i}. ${["Purpose and business context", "Affected people", "Data", "Human oversight", "Operations", "Monitoring", "Security", "Accountability"][i - 1]}`;
      expect(names, `answer ${i} is announced by its section heading`).toContain(`textbox:${heading} answer`);
    }
    expect(names).toContain("textbox:9. EU AI Act risk screening (rule-generated)");

    // every section's decision is stated: in words in its header, and as the pressed one of its Accept / Reject pair
    await expect(page.getByText("accepted", { exact: true })).toHaveCount(8);
    await page.getByRole("button", { name: "Reject" }).nth(2).click();
    await expect(page.getByLabel("3. Data answer")).toHaveCount(0);
    await expect(page.getByText("rejected", { exact: true })).toHaveCount(1);
    await expect(page.getByText("accepted", { exact: true })).toHaveCount(7);
    await expect(page.getByRole("button", { name: "Reject" }).nth(2)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Accept" }).nth(2)).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "Reject" }).nth(1)).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "Accept" }).nth(1)).toHaveAttribute("aria-pressed", "true");
    await expectNoAxeViolations(page, "Questionnaire (one rejected)");
    await expectEveryControlNamed(page, "Questionnaire (one rejected)", 25);
  });

  test("Link stack", async ({ page }) => {
    await reach(page, "Link stack");
    await expectNoAxeViolations(page, "Link stack");
    const controls = await expectEveryControlNamed(page, "Link stack", 4);
    const names = controls.map((c) => `${c.role}:${c.name}`);
    expect(names).toContain("combobox:Model / agent");
    expect(names).toContain("combobox:Vendor");
    expect(names).toContain("button:Back");
    expect(names).toContain("button:Continue");
    await page.getByLabel("Model / agent").selectOption(AGENT);
    await page.getByLabel("Vendor").selectOption("v");
  });

  test("Review — before and after submission", async ({ page }) => {
    await reach(page, "Review");
    await expectNoAxeViolations(page, "Review");
    const controls = await expectEveryControlNamed(page, "Review", 3);
    const names = controls.map((c) => `${c.role}:${c.name}`);
    expect(names).toContain("button:Submit for human review");
    expect(names).toContain("link:Open the classic register");
    expect(names).toContain("button:Back");

    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Submitted for human review." })).toBeVisible();
    await expectNoAxeViolations(page, "Review (submitted)");
    const after = await expectEveryControlNamed(page, "Review (submitted)", 2);
    expect(after.map((c) => `${c.role}:${c.name}`)).toContain("link:Open the use-case workspace");
  });

  test("Review — submission fails", async ({ page }) => {
    await mockIntake(page, { createStatus: 500 });
    await reach(page, "Review");
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "retry to resume" })).toBeVisible();
    await expectNoAxeViolations(page, "Review (submission failed)");
    await expectEveryControlNamed(page, "Review (submission failed)", 3);
  });

  test("a PROHIBITED screening — the blocking alert on Suggestions and Review", async ({ page }) => {
    await mockIntake(page, { assist: { ...assist, tier: { ...assist.tier, value: "prohibited" }, blocking: { reason: "Social scoring of natural persons (Art. 5(1)(c))." } } });
    await reach(page, "Suggestions");
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("Screened PROHIBITED (Art. 5)");
    await expect(alert).toContainText("Social scoring of natural persons");
    await expectNoAxeViolations(page, "Suggestions (blocking)");
    await expectEveryControlNamed(page, "Suggestions (blocking)", 14);
    await page.getByRole("button", { name: /Accept all remaining/ }).click();
    for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator(`[aria-current="step"]`)).toContainText("Review");
    await expect(alert).toContainText("Screened PROHIBITED (Art. 5)");
    await expectNoAxeViolations(page, "Review (blocking)");
    await expectEveryControlNamed(page, "Review (blocking)", 3);
  });

  test("keyboard: a stage change lands focus on the new stage's heading, not on <body>", async ({ page }) => {
    await reach(page, "Describe");
    const heading = (name: string) => page.getByRole("heading", { level: 2, name, exact: true });
    // opening the page does not steal focus
    await expect(heading("Describe the proposed AI system")).not.toBeFocused();
    await page.getByRole("button", { name: "Fill in an example" }).click();

    // Enter on "Draft suggestions" unmounts the button it was pressed on
    await page.getByRole("button", { name: "Draft suggestions" }).focus();
    await page.keyboard.press("Enter");
    await expect(heading("Review assistant suggestions")).toBeFocused();
    // and Tab continues from the top of the new stage, not from the top of the page
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Accept all remaining (4)" })).toBeFocused();
    await page.keyboard.press("Enter");

    for (const [step, name] of [["Questionnaire", "Questionnaire — edit the accepted draft"], ["Link stack", "Link the governed stack"], ["Review", "Review before submission"]] as const) {
      await page.getByRole("button", { name: "Continue" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(`[aria-current="step"]`)).toContainText(step);
      await expect(heading(name), `focus moves to "${name}"`).toBeFocused();
    }
    // Back, too, is a stage change
    await page.getByRole("button", { name: "Back" }).focus();
    await page.keyboard.press("Enter");
    await expect(heading("Link the governed stack")).toBeFocused();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  });

  test("keyboard: Tab walks the Describe stage in reading order and Escape closes a help panel", async ({ page }) => {
    await reach(page, "Describe");
    await page.getByRole("button", { name: "Fill in an example" }).click();
    // The expected order is read from the rendered form — every enabled control in document
    // (reading) order, as the browser names it — so a control added later (a field's help
    // button, a new screening question) is walked too instead of silently breaking a fixed list.
    const form = page.getByRole("main").locator("form");
    const order = (await controlNames(page, form)).filter((c) => !c.disabled);
    const names = order.map((c) => `${c.role}:${c.name}`);
    // the derived order is not vacuous: it opens with the example button, closes with the
    // submit, and each field's help button sits just before the field it explains
    expect(order.length, "Tab stops on the Describe stage").toBeGreaterThanOrEqual(34);
    expect(names[0]).toBe("button:Fill in an example");
    expect(names.at(-1)).toBe("button:Draft suggestions");
    expect(names.slice(1, 5)).toEqual([
      "button:What is the inventory identifier created here?", "textbox:Use-case name",
      "button:What is the proposed system description recorded here?", "textbox:What will the system do?",
    ]);
    for (const expected of ["checkbox:Sectors: Financial services", "checkbox:Data categories: Public", "combobox:Uses an external AI vendor"]) {
      expect(names).toContain(expected);
    }

    await page.getByRole("button", { name: "Fill in an example" }).focus();
    for (const [i, { role, name }] of order.entries()) {
      if (i > 0) await page.keyboard.press("Tab");
      await expect(page.getByRole(role as Parameters<Page["getByRole"]>[0], { name, exact: true }), `Tab stop ${i + 1} is ${role} "${name}"`).toBeFocused();
    }

    // Escape closes a help panel and hands focus BACK to its trigger, from wherever it went:
    // open the page's help, Tab away from the trigger, then Escape
    const help = page.getByRole("button", { name: "What is the AI use-case intake page?" });
    await help.click();
    const note = page.getByRole("note");
    await expect(note).toContainText("The assistant is suggestion-only.");
    const open = page.getByRole("button", { name: "Hide help for the AI use-case intake page" });
    await expect(open).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Tab");
    await expect(open).not.toBeFocused();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    await page.keyboard.press("Escape");
    await expect(note).toHaveCount(0);
    await expect(help).toBeFocused();
    await expect(help).toHaveAttribute("aria-expanded", "false");
  });
});
