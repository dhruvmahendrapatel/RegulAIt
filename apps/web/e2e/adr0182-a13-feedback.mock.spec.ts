/**
 * ADR-0182 (ADR-0175 batch D4) A13 — feedback and appeal, from the browser's
 * side against a mocked gateway (the *.mock.spec.ts harness):
 *
 *  - FeedbackPage: the owner's queue with SLA chips (on time, due soon,
 *    overdue); opening an item shows what the person wrote AS TEXT (an HTML
 *    string stays text); resolving needs a note and sends the exact body; the
 *    admin's feedback settings show the strict default and send only what
 *    changed;
 *  - FeedbackTab on the use case: the item list, a signed link minted and
 *    shown once, revoked through a confirmation (DELETE);
 *  - FeedbackFormPage: the signed-in form posts the exact body and shows the
 *    receipt; the PUBLIC /f/:token page has no app chrome, reads the use
 *    case's name, submits, and says plainly when a link cannot be used;
 *  - axe (WCAG 2.x A/AA) in light and dark on every page and dialog.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const UC = "11111111-1111-4111-8111-111111111111";
const INST = "44444444-4444-4444-8444-444444444444";
const F_ON_TIME = "aaaaaaaa-0000-4000-8000-000000000001";
const F_SOON = "aaaaaaaa-0000-4000-8000-000000000002";
const F_LATE = "aaaaaaaa-0000-4000-8000-000000000003";
const LINK = "bbbbbbbb-0000-4000-8000-000000000001";
const TOKEN = `rglf_${"c".repeat(64)}`;
const HTML_BODY = "<b>bold?</b> The claim was refused although every document was attached.";

type Persona = { id: string; isAdmin: boolean; displayName: string };
const ADA: Persona = { id: "ada", isAdmin: false, displayName: "Ada Owner" };
const RILEY: Persona = { id: "riley", isAdmin: true, displayName: "Riley Admin" };

const sla = (chip: string, phase = "acknowledge", breached: string[] = []) => ({ phase, chip, dueAt: "2026-10-09T09:00:00Z", breached });
const item = (id: string, kind: "problem" | "appeal", chip: string, extra: Record<string, unknown> = {}) => ({
  id,
  useCaseId: UC,
  useCaseName: "Claims triage assistant",
  kind,
  channel: "in_app",
  status: "received",
  ownerUserId: "ada",
  ownerName: "Ada Owner",
  traceId: null,
  spanId: null,
  incidentId: null,
  ackDueAt: "2026-10-09T09:00:00Z",
  resolveDueAt: "2026-11-05T09:00:00Z",
  acknowledgedAt: null,
  resolvedAt: null,
  createdAt: "2026-10-06T09:00:00Z",
  bodyPurged: false,
  sla: chip === "breached" ? sla("breached", "acknowledge", ["acknowledge"]) : sla(chip),
  ...extra,
});

interface MockState {
  me: Persona;
  patches: Array<{ path: string; body: unknown }>;
  settingsPuts: unknown[];
  feedbackPosts: Array<{ path: string; body: unknown }>;
  linkPosts: unknown[];
  linkDeletes: string[];
  linksEnabled: boolean;
  publicStatus: number;
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const overview = {
  useCase: { id: UC, name: "Claims triage assistant", description: "Routes insurance claims.", businessContext: "Faster claim handling.", status: "approved", euAiActTier: "limited", ownerName: "Ada Owner", ownerUserId: "ada", workflowInstanceId: INST, complianceTags: [] },
  screening: { tier: "limited", reasons: [], rulesetVersion: 1, screened: true },
  questionnaire: { submitted: true, artifactId: "art", version: 1, submittedAt: "2026-10-02T09:00:00Z" },
  stack: { agents: [], vendors: [] },
  risks: [],
  summary: { risks: 0, liveRisks: 0, liveWithoutControls: 0, agentsWithoutApprovedModelCard: 0, pendingApprovals: 0 },
  approvals: [],
  audit: [],
};

async function mockGateway(page: Page, patch: Partial<MockState> = {}): Promise<MockState> {
  const state: MockState = { me: ADA, patches: [], settingsPuts: [], feedbackPosts: [], linkPosts: [], linkDeletes: [], linksEnabled: true, publicStatus: 200, ...patch };
  const settings = { feedbackSignedLinksEnabled: false, feedbackAckSlaHours: 72, feedbackResolveSlaDays: 30, feedbackRetentionDays: 365 };
  const links = [
    { id: LINK, expiresAt: "2026-10-20T09:00:00Z", maxUses: 50, uses: 3, revokedAt: null as string | null, createdBy: "ada", createdAt: "2026-10-06T09:00:00Z", state: "active" },
  ];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    const me = state.me;
    if (p === "/auth/me") return json(route, { userId: me.id, isAdmin: me.isAdmin, via: "session", user: { id: me.id, email: `${me.id}@example.test`, displayName: me.displayName }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: me.id, isAdmin: me.isAdmin, user: { id: me.id, email: `${me.id}@example.test`, displayName: me.displayName } });
    if (p === "/v1/feedback" && method === "GET") {
      return json(route, { scope: "queue", items: [item(F_ON_TIME, "problem", "on_time"), item(F_SOON, "appeal", "due_soon"), item(F_LATE, "problem", "breached")] });
    }
    if (p === `/v1/feedback/${F_SOON}` && method === "GET") {
      return json(route, {
        ...item(F_SOON, "appeal", "due_soon"),
        submitterUserId: "sam",
        body: HTML_BODY,
        contact: "sam@example.test",
        bodyUnavailable: null,
        bodyPurgedAt: null,
        resolutionNote: null,
        resolvedBy: null,
        contestedUserId: null,
        youMayResolve: true,
        sodConflict: null,
      });
    }
    if (p.startsWith("/v1/feedback/") && method === "PATCH") {
      state.patches.push({ path: p, body: req.postDataJSON() });
      return json(route, { ...item(F_SOON, "appeal", "done"), status: "overturned", changed: true });
    }
    if (p === "/v1/org/settings" && method === "GET") return json(route, { settings });
    if (p === "/v1/org/settings" && method === "PUT") {
      const body = req.postDataJSON() as Record<string, unknown>;
      state.settingsPuts.push(body);
      Object.assign(settings, body);
      return json(route, { settings });
    }
    if (p === "/v1/users") return json(route, { users: [] });
    if (p === "/v1/users/directory") return json(route, { users: [{ id: "ada", name: "Ada Owner", teams: [] }] });
    if (p === `/v1/use-cases/${UC}/overview`) return json(route, overview);
    if (p === `/v1/use-cases/${UC}` && method === "GET") return json(route, { useCase: { id: UC, name: "Claims triage assistant", status: "approved", approvalExpired: false }, conditions: [] });
    if (p === `/v1/use-cases/${UC}/feedback` && method === "POST") {
      state.feedbackPosts.push({ path: p, body: req.postDataJSON() });
      return json(route, { ...item("aaaaaaaa-0000-4000-8000-000000000009", "appeal", "on_time") }, 201);
    }
    if (p === `/v1/use-cases/${UC}/feedback-links` && method === "GET") return json(route, { enabled: state.linksEnabled, links });
    if (p === `/v1/use-cases/${UC}/feedback-links` && method === "POST") {
      state.linkPosts.push(req.postDataJSON());
      return json(route, { id: "bbbbbbbb-0000-4000-8000-000000000002", useCaseId: UC, token: TOKEN, path: `/ui/f/${TOKEN}`, expiresAt: "2026-10-20T09:00:00Z", maxUses: 50, uses: 0, state: "active", shownOnce: true }, 201);
    }
    if (p === `/v1/use-cases/${UC}/feedback-links/${LINK}` && method === "DELETE") {
      state.linkDeletes.push(p);
      links[0]!.revokedAt = "2026-10-06T10:00:00Z";
      links[0]!.state = "revoked";
      return json(route, { id: LINK, revokedAt: "2026-10-06T10:00:00Z", changed: true });
    }
    if (p === `/v1/feedback/l/${TOKEN}` && method === "GET") {
      if (state.publicStatus === 404) return json(route, { error: "not_found" }, 404);
      if (state.publicStatus === 410) return json(route, { error: "link_expired", detail: "This feedback link has expired. Ask the organisation that sent it for a new one." }, 410);
      return json(route, { useCaseName: "Claims triage assistant", kinds: ["problem", "appeal"], bodyMaxChars: 4000, expiresAt: "2026-10-20T09:00:00Z" });
    }
    if (p === `/v1/feedback/l/${TOKEN}` && method === "POST") {
      state.feedbackPosts.push({ path: p, body: req.postDataJSON() });
      return json(route, { reference: "dddddddd-0000-4000-8000-000000000001", kind: "problem", ackDueAt: "2026-10-09T09:00:00Z", resolveDueAt: "2026-11-05T09:00:00Z" }, 201);
    }
    if (p === "/auth/sign-in-options") return json(route, {});
    return json(route, {});
  });
  return state;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string, include?: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
    if (include) builder = builder.include(include);
    const results = await builder.analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

test.describe("ADR-0182 A13: feedback and appeal", () => {
  test("the owner's queue shows SLA chips; an item opens as text; resolving needs a note and sends the exact body", async ({ page }) => {
    const state = await mockGateway(page);
    await page.goto("/ui/feedback");
    const table = page.getByRole("table");
    await expect(table.getByRole("row").filter({ hasText: "On time: acknowledge" })).toHaveCount(1);
    await expect(table.getByRole("row").filter({ hasText: "Due soon: acknowledge" })).toHaveCount(1);
    await expect(table.getByRole("row").filter({ hasText: "Overdue: acknowledgement" })).toHaveCount(1);
    await expect(page.getByRole("status")).toContainText("One item is past a response time.");
    // no admin settings for a non-admin
    await expect(page.getByText("Feedback settings (admin)")).toHaveCount(0);
    await expectAxeClean(page, "feedback queue");

    await table.getByRole("row").filter({ hasText: "Due soon" }).getByRole("button", { name: /^Open appeal/ }).click();
    const dialog = page.getByRole("dialog", { name: "Appeal on Claims triage assistant" });
    await expect(dialog).toBeVisible();
    // what the person wrote is shown as TEXT: the markup is visible, nothing is bolded
    await expect(dialog.getByTestId("feedback-body")).toHaveText(HTML_BODY);
    await expect(dialog.locator("[data-testid=feedback-body] b")).toHaveCount(0);
    await expect(dialog).toContainText("sam@example.test");
    await expect(dialog).toContainText("Opening an item is recorded in the audit trail");
    await expectAxeClean(page, "feedback item dialog", '[role="dialog"]');

    await dialog.getByLabel("Status").selectOption("overturned");
    const save = dialog.getByRole("button", { name: "Save answer" });
    await expect(save).toBeDisabled();
    expect(state.patches).toEqual([]);
    await dialog.getByLabel("Resolution (required)").fill("Reviewed by a person: the refusal is reversed.");
    await save.click();
    await expect.poll(() => state.patches.length).toBe(1);
    expect(state.patches[0]).toEqual({
      path: `/v1/feedback/${F_SOON}`,
      body: { status: "overturned", resolutionNote: "Reviewed by a person: the refusal is reversed." },
    });
  });

  test("an admin sees the feedback settings at their strict defaults and saves only what changed", async ({ page }) => {
    const state = await mockGateway(page, { me: RILEY });
    await page.goto("/ui/feedback");
    const card = page.locator("section", { has: page.getByText("Feedback settings (admin)", { exact: true }) });
    await expect(card).toContainText("Off: only signed-in users can report a problem or appeal a decision.");
    await expect(card.getByText("strict default", { exact: true })).toHaveCount(4);
    await expectAxeClean(page, "feedback settings (admin)");
    await card.getByLabel("Feedback acknowledgement time (hours)").fill("200");
    await expect(card.getByRole("alert")).toContainText("outside its allowed range");
    await expect(card.getByRole("button", { name: "Save feedback settings" })).toBeDisabled();
    await card.getByLabel("Feedback acknowledgement time (hours)").fill("96");
    await card.getByRole("button", { name: "Save feedback settings" }).click();
    await expect.poll(() => state.settingsPuts.length).toBe(1);
    expect(state.settingsPuts[0]).toEqual({ feedbackAckSlaHours: 96 });
    await expect(card.getByText("relaxed", { exact: true })).toHaveCount(1);
    await expect(card).toContainText("A longer time (up to 168 hours) lets a report wait longer before anyone is alerted.");
  });

  test("the use case's feedback tab mints a link shown once and revokes one through a confirmation", async ({ page }) => {
    // the use-case record lives under /admin (an admin reads it here)
    const state = await mockGateway(page, { me: RILEY });
    await page.goto(`/ui/admin/governance/use-cases/${UC}?tab=feedback`);
    const links = page.locator("section", { has: page.getByText("Public signed links", { exact: true }) });
    await expect(links).toContainText("on (relaxed)");
    await expect(links.getByRole("row").filter({ hasText: "3 of 50" })).toHaveCount(1);
    await expectAxeClean(page, "use-case feedback tab");

    await links.getByLabel("Days valid (1–30)").fill("14");
    await links.getByLabel("Uses (1–10000)").fill("50");
    await links.getByRole("button", { name: "Create link" }).click();
    await expect.poll(() => state.linkPosts.length).toBe(1);
    expect(state.linkPosts[0]).toEqual({ expiresInDays: 14, maxUses: 50 });
    await expect(links.getByRole("status")).toContainText("Copy this link now.");
    await expect(links).toContainText(`/ui/f/${TOKEN}`);

    await links.getByRole("button", { name: /^Revoke the link created/ }).click();
    const confirm = page.getByRole("dialog", { name: /^Remove the link created/ });
    await expect(confirm).toContainText("The link stops working at once.");
    await expectAxeClean(page, "revoke confirmation", '[role="dialog"]');
    await confirm.getByRole("button", { name: "Revoke" }).click();
    await expect.poll(() => state.linkDeletes).toEqual([`/v1/use-cases/${UC}/feedback-links/${LINK}`]);
  });

  test("the signed-in form posts the exact body and shows the receipt", async ({ page }) => {
    const state = await mockGateway(page);
    await page.goto(`/ui/feedback/${UC}`);
    await expect(page.getByRole("heading", { name: "Report a problem or appeal a decision" })).toBeVisible();
    await expect(page.getByText("About Claims triage assistant")).toBeVisible();
    await expectAxeClean(page, "feedback form (signed in)");
    await page.getByRole("radio", { name: /Appeal a decision/ }).check();
    await page.getByLabel("What decision, and why should it be reviewed?").fill("My claim was refused although every document was attached.");
    await page.getByLabel("How can we reach you? (optional)").fill("sam@example.test");
    await page.getByLabel("Trace ID (optional)").fill("abcdefab-0000-4000-8000-000000000001");
    await page.getByRole("button", { name: "Send appeal" }).click();
    await expect.poll(() => state.feedbackPosts.length).toBe(1);
    expect(state.feedbackPosts[0]).toEqual({
      path: `/v1/use-cases/${UC}/feedback`,
      body: {
        kind: "appeal",
        body: "My claim was refused although every document was attached.",
        contact: "sam@example.test",
        traceId: "abcdefab-0000-4000-8000-000000000001",
      },
    });
    await expect(page.getByRole("status")).toContainText("Reference aaaaaaaa");
  });

  test("the PUBLIC signed-link page has no app chrome, submits, and says when a link cannot be used", async ({ page }) => {
    const state = await mockGateway(page);
    await page.goto(`/ui/f/${TOKEN}`);
    await expect(page.getByRole("heading", { name: "Report a problem or appeal a decision" })).toBeVisible();
    await expect(page.getByText("Claims triage assistant", { exact: true })).toBeVisible();
    // no app chrome: no navigation landmark, no signed-in shell
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByText("Trace ID (optional)")).toHaveCount(0);
    await expectAxeClean(page, "public feedback form");
    await page.getByLabel("What happened?").fill("The chatbot told me my claim was closed. It was not.");
    await page.getByRole("button", { name: "Send report" }).click();
    await expect.poll(() => state.feedbackPosts.length).toBe(1);
    expect(state.feedbackPosts[0]).toEqual({ path: `/v1/feedback/l/${TOKEN}`, body: { kind: "problem", body: "The chatbot told me my claim was closed. It was not." } });
    await expect(page.getByRole("status")).toContainText("Reference dddddddd");
    await expectAxeClean(page, "public feedback receipt");

    state.publicStatus = 404;
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("This link is not valid, or public feedback links are turned off.");
    await expectAxeClean(page, "public feedback link refused");
    state.publicStatus = 410;
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("This feedback link has expired.");
  });
});
