/**
 * ADR-0182 (ADR-0175 batch D4) A12 — the AI incident register, against a
 * mocked gateway (the *.mock.spec.ts harness):
 *
 *  - the register lists incidents with their next clock (overdue shown), says
 *    the clock is a reminder and not legal advice, and an admin sees the three
 *    incident settings at their strict defaults; relaxing one PUTs it to
 *    /v1/org/settings and shows "relaxed";
 *  - "Report an incident" (pre-filled from `?new=1&detectionSource=…&sourceRef=…`)
 *    posts the facts, and ticking an Art. 3(49) criterion marks it serious;
 *  - the incident page shows each clock with its paragraph, period, the
 *    "confirm with counsel" caveat on EU clocks and the cited text; recording
 *    the initial report posts stage `initial` (Art. 73(5)); the evidence hold
 *    banner cites Art. 73(6);
 *  - D4 review: the gate banner says only closing releases it; an owner who is
 *    not an admin cannot close a high/serious incident (the dialog says why);
 *    a report recorded more than an hour back asks for a reason and sends it;
 *  - axe (WCAG 2.x A/AA) in light and dark on both pages and the dialogs.
 */
import { activate, escapeToTrigger, expectDialogTrap, typeAt } from "./keyboard-audit";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const INC = "11111111-1111-4111-8111-111111111111";
const UC = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const HOUR = 3_600_000;
const iso = (offsetHours: number) => new Date(Date.now() + offsetHours * HOUR).toISOString();
const DISCLAIMER = "Each clock is a reminder computed from the recorded awareness time and the cited text. It is not legal advice.";

const listRow = {
  id: INC,
  ref: "INC-00042",
  title: "Claims assistant denied valid claims",
  severity: "high",
  status: "open",
  serious: true,
  seriousCriteria: ["fundamental_rights"],
  detectionSource: "monitor_alert",
  awareAt: iso(-400),
  ownerUserId: "u-admin",
  ownerName: "Avery Admin",
  useCaseId: UC,
  useCaseName: "Claims triage",
  createdAt: iso(-400),
  closedAt: null,
  clocks: { total: 2, open: 2, overdue: 1, nextDue: { clockId: "art26-5-inform-provider", paragraph: "Regulation (EU) 2024/1689, Article 26(5)", dueAt: iso(-400), urgency: "overdue" } },
  actions: { open: 1, overdue: 1 },
};

const clock = (over: Record<string, unknown>) => ({
  regime: "eu-ai-act",
  sourceUrl: "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202401689",
  retrievedOn: "2026-10-06",
  caveat: "Statutory applicability depends on your role and the system's classification date — confirm with counsel.",
  clockStart: iso(-400),
  sentAt: null,
  sentByName: null,
  reference: null,
  reason: null,
  ...over,
});

const detail = {
  incident: {
    id: INC,
    ref: "INC-00042",
    title: "Claims assistant denied valid claims",
    summary: "The assistant refused claims from one postcode area.",
    severity: "high",
    status: "open",
    detectionSource: "monitor_alert",
    sourceRef: "44444444-4444-4444-8444-444444444444",
    occurredAt: null,
    awareAt: iso(-400),
    ownerUserId: "u-admin",
    ownerName: "Avery Admin",
    useCaseId: UC,
    serious: true,
    seriousCriteria: ["fundamental_rights"],
    phiIndividuals: null,
    rootCause: null,
    lessonsLearned: null,
    closedAt: null,
    closedByName: null,
    createdByName: "Avery Admin",
    createdAt: iso(-400),
  },
  useCase: { id: UC, name: "Claims triage", euAiActTier: "high", euAiActRole: "both" },
  links: [{ objectType: "agent", objectId: AGENT, label: "claims-assistant", agentKind: "registry", halted: false, createdAt: iso(-400) }],
  actions: [{ id: "act-1", title: "Retrain on the full postcode set", ownerUserId: null, ownerName: null, dueAt: iso(-2), status: "open", overdue: true, doneAt: null, evidenceRef: null }],
  notifications: [
    clock({
      id: "n-1",
      clockId: "art26-5-inform-provider",
      paragraph: "Regulation (EU) 2024/1689, Article 26(5)",
      quote: "Where deployers have identified a serious incident, they shall also immediately inform first the provider …",
      period: "immediately — no numeric limit in the text",
      immediately: true,
      allowsInitialReport: false,
      recipient: "the provider of the AI system",
      dueAt: iso(-400),
      status: "pending",
      urgency: "overdue",
    }),
    clock({
      id: "n-2",
      clockId: "art73-2-general",
      paragraph: "Regulation (EU) 2024/1689, Article 73(2)",
      quote: "…not later than 15 days after the provider or, where applicable, the deployer, becomes aware of the serious incident.",
      period: "15 days",
      immediately: false,
      allowsInitialReport: true,
      recipient: "the market surveillance authorities",
      dueAt: iso(-40),
      status: "pending",
      urgency: "overdue",
    }),
  ],
  events: [
    { id: "e1", kind: "status", at: iso(-400), actorName: "Avery Admin", note: null, detail: { to: "open", severity: "high", serious: true } },
    { id: "e2", kind: "notification", at: iso(-400), actorName: "Avery Admin", note: null, detail: { started: true, clockId: "art73-2-general", paragraph: "Regulation (EU) 2024/1689, Article 73(2)", dueAt: iso(-40) } },
    { id: "e3", kind: "note", at: iso(-300), actorName: "Avery Admin", note: "Provider contacted by phone; written notice to follow.", detail: {} },
  ],
  evidenceHold: {
    setting: true,
    binds: true,
    paragraph: "Regulation (EU) 2024/1689, Article 73(6)",
    quote: "…shall not perform any investigation which involves altering the AI system concerned …",
  },
  gate: { mode: "enforce", holds: "open_serious_incident" },
  permissions: { canEdit: true, canClose: true, closeNeedsAdmin: true, isAdmin: true },
  disclaimer: DISCLAIMER,
};

interface Captured {
  creates: Array<Record<string, unknown>>;
  settings: Array<Record<string, unknown>>;
  sent: Array<Record<string, unknown>>;
}

async function mockApi(page: Page, opts: { asOwner?: boolean } = {}): Promise<Captured> {
  const cap: Captured = { creates: [], settings: [], sent: [] };
  const me = opts.asOwner
    ? { userId: "u-owner", isAdmin: false, user: { id: "u-owner", email: "olive@example.test", displayName: "Olive Owner" } }
    : { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "avery@example.test", displayName: "Avery Admin" } };
  const shown = opts.asOwner
    ? { ...detail, permissions: { canEdit: true, canClose: false, closeNeedsAdmin: true, isAdmin: false } }
    : detail;
  let settings = { incidentGateMode: "enforce", incidentEvidenceHold: true, incidentClockRegimes: ["eu-ai-act", "hipaa"] };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/org/settings" && method === "PUT") {
      const body = req.postDataJSON() as Record<string, unknown>;
      cap.settings.push(body);
      settings = { ...settings, ...body } as typeof settings;
      return json(route, { settings });
    }
    if (p === "/v1/org/settings") return json(route, { settings });
    if (p === "/v1/use-cases") return json(route, { useCases: [{ id: UC, name: "Claims triage" }] });
    if (p === "/v1/users/directory") return json(route, { users: [{ id: "u-admin", name: "Avery Admin" }] });
    if (p === "/v1/incidents" && method === "POST") {
      cap.creates.push(req.postDataJSON() as Record<string, unknown>);
      return json(route, detail, 201);
    }
    if (p === "/v1/incidents") return json(route, { incidents: [listRow], scope: "all", disclaimer: DISCLAIMER });
    if (p === `/v1/incidents/${INC}/notifications/n-2/sent`) {
      cap.sent.push(req.postDataJSON() as Record<string, unknown>);
      return json(route, { notification: { ...detail.notifications[1], status: "sent_initial" } });
    }
    if (p === `/v1/incidents/${INC}`) return json(route, shown);
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

test.describe("ADR-0182 A12: the AI incident register", () => {
  test("the register lists incidents with their next clock; an admin relaxes a setting and sees it called relaxed", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/incidents");
    const row = page.getByRole("row").filter({ hasText: "INC-00042" });
    await expect(row).toContainText("Claims assistant denied valid claims");
    await expect(row).toContainText("serious");
    await expect(row).toContainText("Article 26(5)");
    await expect(row).toContainText("overdue");
    await expect(page.getByText(DISCLAIMER).first()).toBeVisible();

    const settingsCard = page.locator("section[data-rg-card]").filter({ hasText: "Incident settings" }).first();
    await expect(settingsCard).toContainText("Strict default — Enforce");
    await expect(settingsCard.getByText("relaxed", { exact: true })).toHaveCount(0);
    await expectAxeClean(page, "incident register");

    await settingsCard.getByLabel("Incident deploy gate").selectOption("warn");
    await expect.poll(() => cap.settings.length).toBe(1);
    expect(cap.settings[0]).toEqual({ incidentGateMode: "warn" });
    await expect(settingsCard.getByText("relaxed", { exact: true })).toHaveCount(1);
  });

  test("report an incident, pre-filled from a monitor alert; an Art. 3(49) criterion marks it serious", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/incidents?new=1&detectionSource=monitor_alert&sourceRef=44444444-4444-4444-8444-444444444444");
    const dialog = page.getByRole("dialog", { name: "Report an AI incident" });
    await expect(dialog.getByLabel("Detected by")).toHaveValue("monitor_alert");
    await expect(dialog.getByRole("textbox", { name: "Source reference (optional)" })).toHaveValue("44444444-4444-4444-8444-444444444444");
    await expectAxeClean(page, "report an incident");
    await dialog.getByLabel("Title").fill("Claims assistant denied valid claims");
    await dialog.getByRole("combobox", { name: "Use case" }).selectOption(UC);
    await dialog.getByLabel("Infringement of obligations protecting fundamental rights · Art. 3(49)(c)").check();
    await expect(dialog.getByLabel(/Serious incident \(EU AI Act\)/)).toBeChecked();
    await dialog.getByRole("button", { name: "Open incident" }).click();
    await expect.poll(() => cap.creates.length).toBe(1);
    expect(cap.creates[0]).toMatchObject({
      title: "Claims assistant denied valid claims",
      detectionSource: "monitor_alert",
      sourceRef: "44444444-4444-4444-8444-444444444444",
      useCaseId: UC,
      serious: true,
      seriousCriteria: ["fundamental_rights"],
    });
    await expect(page).toHaveURL(new RegExp(`/ui/incidents/${INC}$`));
  });

  test("the incident page shows each clock with its text and caveat, the evidence hold, and records an initial report", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto(`/ui/incidents/${INC}`);
    await expect(page.getByRole("heading", { name: "INC-00042 · Claims assistant denied valid claims" })).toBeVisible();
    const hold = page.locator("section[data-rg-card]").filter({ hasText: "Evidence hold in force" }).first();
    await expect(hold).toContainText("Regulation (EU) 2024/1689, Article 73(6)");
    const general = page.getByTestId("clock-art73-2-general");
    await expect(general).toContainText("Regulation (EU) 2024/1689, Article 73(2)");
    await expect(general).toContainText("15 days");
    await expect(general).toContainText("confirm with counsel");
    await expect(page.getByTestId("clock-art26-5-inform-provider")).toContainText("immediately — no numeric limit in the text");
    await expect(page.getByTestId("clock-art26-5-inform-provider").getByRole("button", { name: /initial report/ })).toHaveCount(0);
    await expect(page.getByText("This incident holds the use case's deploy gate")).toBeVisible();
    await expect(page.getByText(/until it is closed by an admin; marking it resolved does not release it/)).toBeVisible();
    await expectAxeClean(page, "incident detail");

    await general.getByRole("button", { name: "Record the initial report for art73-2-general" }).click();
    const dialog = page.getByRole("dialog", { name: "Record the initial report" });
    await dialog.getByRole("textbox", { name: "Reference (optional)" }).fill("MSA-2026-118");
    await dialog.getByRole("button", { name: "Record" }).click();
    await expect.poll(() => cap.sent.length).toBe(1);
    expect(cap.sent[0]).toMatchObject({ stage: "initial", recipient: "the market surveillance authorities", reference: "MSA-2026-118" });
  });

  test("an owner who is not an admin cannot close a high, serious incident: the dialog says an admin closes it", async ({ page }) => {
    await mockApi(page, { asOwner: true });
    await page.goto(`/ui/incidents/${INC}`);
    await expect(page.getByRole("heading", { name: "INC-00042 · Claims assistant denied valid claims" })).toBeVisible();
    await page.getByRole("button", { name: "Close…" }).click();
    const dialog = page.getByRole("dialog", { name: "Close INC-00042" });
    await expect(dialog.getByText(/so an admin closes it/)).toBeVisible();
    await dialog.getByLabel("Root cause").fill("synthetic root cause");
    await dialog.getByLabel("Lessons learned").fill("synthetic lesson");
    await expect(dialog.getByRole("button", { name: "Close incident" })).toBeDisabled();
    await expectAxeClean(page, "close dialog (owner)");
  });

  test("a report recorded more than an hour after it was sent asks why, and sends the reason", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto(`/ui/incidents/${INC}`);
    await page.getByTestId("clock-art73-2-general").getByRole("button", { name: "Record the report for art73-2-general" }).click();
    const dialog = page.getByRole("dialog", { name: "Record the report as sent" });
    await expect(dialog.getByText(/Not before the clock started/)).toBeVisible();
    await expect(dialog.getByLabel(/Why is this recorded late/)).toHaveCount(0);
    const d = new Date(Date.now() - 3 * 24 * HOUR);
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    await dialog.getByLabel("Sent at (local time; empty = now)").fill(local);
    const why = dialog.getByLabel(/Why is this recorded late/);
    await expect(why).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Record" })).toBeDisabled();
    await expectAxeClean(page, "record a backdated report");
    await why.fill("sent by registered post; the receipt arrived today");
    await dialog.getByRole("button", { name: "Record" }).click();
    await expect.poll(() => cap.sent.length).toBe(1);
    expect(cap.sent[0]).toMatchObject({ stage: "complete", reason: "sent by registered post; the receipt arrived today" });
    expect(typeof cap.sent[0]!.sentAt).toBe("string");
  });
});


test("X14 keyboard: incident register report traps focus, announces refusal and restores its trigger", async ({ page }, testInfo) => {
  await mockApi(page);
  await page.route("**/v1/incidents", (route) => route.request().method() === "POST"
    ? json(route, { error: "internal" }, 500) : route.fallback());
  await page.goto("/ui/incidents");
  const trigger = page.getByRole("button", { name: "Report an incident", exact: true });
  await activate(page, trigger);
  const dialog = page.getByRole("dialog", { name: "Report an AI incident" });
  await expectDialogTrap(page, dialog);
  await typeAt(page, dialog.getByLabel("Title", { exact: true }), "Keyboard incident report");
  await activate(page, dialog.getByRole("button", { name: "Open incident", exact: true }));
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expectAxeClean(page, "keyboard report refusal");
  await page.screenshot({ path: testInfo.outputPath("x14-incidents.png") });
  await escapeToTrigger(page, dialog, trigger);
});

test("X14 keyboard: incident detail report dialog traps focus, announces refusal and restores its trigger", async ({ page }, testInfo) => {
  await mockApi(page);
  await page.route(`**/v1/incidents/${INC}/notifications/n-2/sent`, (route) => json(route, { error: "internal" }, 500));
  await page.goto(`/ui/incidents/${INC}`);
  for (const [action, title] of [["Edit", "Edit INC-00042"], ["Contain…", "Contain INC-00042"], ["Close…", "Close INC-00042"]]) {
    const actionTrigger = page.getByRole("button", { name: action, exact: true });
    await activate(page, actionTrigger);
    const actionDialog = page.getByRole("dialog", { name: title, exact: true });
    await expectDialogTrap(page, actionDialog);
    await escapeToTrigger(page, actionDialog, actionTrigger);
  }
  const trigger = page.getByTestId("clock-art73-2-general").getByRole("button", { name: "Record the initial report for art73-2-general" });
  await activate(page, trigger);
  const dialog = page.getByRole("dialog", { name: "Record the initial report", exact: true });
  await expectDialogTrap(page, dialog);
  await typeAt(page, dialog.getByRole("textbox", { name: "Reference (optional)", exact: true }), "KEYBOARD-REPORT-42");
  await activate(page, dialog.getByRole("button", { name: "Record", exact: true }));
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expectAxeClean(page, "keyboard incident detail refusal");
  await page.screenshot({ path: testInfo.outputPath("x14-incident-detail.png") });
  await escapeToTrigger(page, dialog, trigger);
});

// ADR-0186 A: the write goes through withStepUp — refused, confirmed in the dialog, the SAME PUT resent once
test("ADR-0186 A: relaxing an incident setting asks to confirm it's you and resends the same PUT once", async ({ page }) => {
  const cap = await mockApi(page);
  const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/org/settings", kind: "settings_relax" });
  await page.goto("/ui/incidents");
  const settingsCard = page.locator("section[data-rg-card]").filter({ hasText: "Incident settings" }).first();
  await settingsCard.getByLabel("Incident deploy gate").selectOption("warn");
  await confirmStepUp(page);
  await su.expectResentOnce();
  expect(su.attempts[0]!.body).toEqual({ incidentGateMode: "warn" });
  expect(cap.settings).toEqual([{ incidentGateMode: "warn" }]);
});
