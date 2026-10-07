/**
 * ADR-0182 (ADR-0175 batch D4) A14 — AI literacy, against a mocked gateway (the *.mock.spec.ts harness):
 *
 *  - the admin page lists every version, publishes an EDITORIAL version only with a reason, shows coverage over
 *    the audience and records a completion with its evidence reference, and shows the two literacy settings with
 *    their strict defaults; relaxing the gate asks for confirmation and saves through PUT /v1/org/settings;
 *  - a person to whom an unacknowledged policy applies meets the interstitial before the page; acknowledging posts
 *    the version and digest they saw, and the page follows; "Not now" leaves a banner;
 *  - the Account page carries the same list and is never interrupted;
 *  - copy uses the amended Article 4 wording ("support the development of AI literacy");
 *  - axe (WCAG 2.x A/AA) in light and dark on each screen.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const DIGEST2 = "b".repeat(64);
const DOC_V1 = "11111111-1111-4111-8111-111111111111";
const DOC_V2 = "22222222-2222-4222-8222-222222222222";
const DOC_V3 = "33333333-3333-4333-8333-333333333333";

const doc = (id: string, version: number, status: string, over: Record<string, unknown> = {}) => ({
  id,
  key: "acceptable-use",
  kind: "acceptable_use",
  version,
  title: "Acceptable use of AI",
  url: "https://policies.example.test/aup",
  attachmentId: null,
  contentDigest: version === 2 ? DIGEST2 : "c".repeat(64),
  audience: { all: true, teamIds: [], roleIds: [] },
  validityDays: null,
  status,
  editorial: false,
  editorialReason: null,
  publishedAt: status === "draft" ? null : iso(-30 + version),
  retiredAt: status === "retired" ? iso(-10) : null,
  createdAt: iso(-40 + version),
  ...over,
});

const coverage = {
  generatedAt: iso(0),
  noticeDays: 14,
  documents: [
    {
      documentId: DOC_V2,
      key: "acceptable-use",
      kind: "acceptable_use",
      version: 2,
      title: "Acceptable use of AI",
      editorial: false,
      publishedAt: iso(-20),
      audience: 2,
      current: 1,
      coveragePct: 50,
      people: [
        { userId: "u-ana", displayName: "Ana Analyst", email: "ana@example.test", state: "current", method: "acknowledged", acknowledgedVersion: 2, acknowledgedAt: iso(-5), expiresAt: iso(360), expiresSoon: false, evidenceRef: null },
        { userId: "u-ben", displayName: "Ben Builder", email: "ben@example.test", state: "missing", method: null, acknowledgedVersion: null, acknowledgedAt: null, expiresAt: null, expiresSoon: false, evidenceRef: null },
      ],
    },
  ],
};

function myLiteracy(current: boolean, url = "https://policies.example.test/aup") {
  return {
    required: true,
    current,
    gateMode: "enforce",
    exempt: null,
    noticeDays: 14,
    documents: [
      {
        documentId: DOC_V2,
        key: "acceptable-use",
        version: 2,
        kind: "acceptable_use",
        title: "Acceptable use of AI",
        state: current ? "current" : "superseded",
        acknowledgedAt: current ? iso(0) : iso(-100),
        expiresAt: current ? iso(365) : iso(265),
        method: "acknowledged",
        acknowledgedVersion: current ? 2 : 1,
        url,
        attachmentId: null,
        contentDigest: DIGEST2,
        validityDays: 365,
        editorial: false,
        expiresSoon: false,
      },
    ],
  };
}

interface Captured {
  publishes: Array<{ id: string; body: unknown }>;
  records: Array<{ id: string; body: unknown }>;
  settingsPuts: unknown[];
  acks: Array<{ id: string; body: unknown }>;
}

async function mockApi(page: Page, opts: { admin: boolean; docUrl?: string }): Promise<Captured> {
  const cap: Captured = { publishes: [], records: [], settingsPuts: [], acks: [] };
  let acknowledged = false;
  const me = opts.admin
    ? { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "avery@example.test", displayName: "Avery Admin" } }
    : { userId: "u-ben", isAdmin: false, user: { id: "u-ben", email: "ben@example.test", displayName: "Ben Builder" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/auth/sessions") return json(route, { sessions: [] });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/me/ai-literacy") return json(route, opts.admin ? { required: false, current: true, documents: [], gateMode: "enforce", exempt: null, noticeDays: 14 } : myLiteracy(acknowledged, opts.docUrl));
    if (p === "/v1/ai-policies" && method === "GET")
      return json(route, {
        scope: "all",
        documents: [
          doc(DOC_V3, 3, "draft", { title: "Acceptable use of AI (typo fixed)" }),
          doc(DOC_V2, 2, "published", opts.docUrl ? { url: opts.docUrl } : {}),
          doc(DOC_V1, 1, "retired"),
        ],
      });
    if (p === "/v1/ai-policies/coverage") return json(route, coverage);
    const pub = /^\/v1\/ai-policies\/([^/]+)\/publish$/.exec(p);
    if (pub && method === "POST") {
      cap.publishes.push({ id: pub[1]!, body: req.postDataJSON() });
      return json(route, { document: doc(pub[1]!, 3, "published", { editorial: true }) });
    }
    const rec = /^\/v1\/ai-policies\/([^/]+)\/records$/.exec(p);
    if (rec && method === "POST") {
      cap.records.push({ id: rec[1]!, body: req.postDataJSON() });
      return json(route, { acknowledgement: { id: "ack-1" } }, 201);
    }
    const ack = /^\/v1\/ai-policies\/([^/]+)\/acknowledge$/.exec(p);
    if (ack && method === "POST") {
      cap.acks.push({ id: ack[1]!, body: req.postDataJSON() });
      acknowledged = true;
      return json(route, { acknowledgement: { id: "ack-2" }, status: myLiteracy(true) });
    }
    if (p === "/v1/org/settings" && method === "PUT") {
      cap.settingsPuts.push(req.postDataJSON());
      return json(route, { settings: { literacyGateMode: "warn", literacyDefaultValidityDays: 365 } });
    }
    if (p === "/v1/org/settings") return json(route, { settings: { literacyGateMode: "enforce", literacyDefaultValidityDays: 365 } });
    if (p === "/v1/teams") return json(route, { teams: [] });
    if (p === "/v1/roles") return json(route, { roles: [] });
    if (p === "/v1/users") return json(route, { users: [] });
    return json(route, {});
  });
  return cap;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string, include?: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([
        Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }, theme);
    const builder = new AxeBuilder({ page });
    if (include) builder.include(include);
    const results = await builder.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

test.describe("ADR-0182 A14: AI literacy", () => {
  test("the admin page: versions, an editorial publish needs a reason, coverage, a recorded completion, the settings", async ({ page }) => {
    const cap = await mockApi(page, { admin: true });
    await page.goto("/ui/admin/governance/literacy");
    await expect(page.getByRole("heading", { name: "AI literacy" })).toBeVisible();

    const docs = page.locator("section[data-rg-card]").filter({ hasText: "Documents and versions" }).first();
    await expect(docs).toContainText("Acceptable use of AI (typo fixed)");
    await expect(docs).toContainText("draft");
    await expect(docs).toContainText("published");
    await expect(docs).toContainText("retired");
    await expect(docs).toContainText("everyone");

    const coverageCard = page.locator("section[data-rg-card]").filter({ hasText: "Coverage" }).first();
    await expect(coverageCard).toContainText("1 of 2 current (50%)");
    await expectAxeClean(page, "AI literacy admin page");

    // an editorial publish needs a reason
    await docs.getByRole("button", { name: "Publish" }).click();
    const dialog = page.getByRole("dialog", { name: /Publish/ });
    await expect(dialog).toContainText("no grace period");
    await dialog.getByLabel("This is an editorial change: keep the existing acknowledgements").check();
    await dialog.getByRole("button", { name: "Publish" }).click();
    await expect(dialog.getByRole("alert")).toContainText("at least 10 characters");
    expect(cap.publishes).toHaveLength(0);
    await dialog.getByLabel("Why does this change not need re-acknowledgement? (audited)").fill("Fixed a typo in section 2; no rule changed.");
    await expectAxeClean(page, "publish dialog");
    await dialog.getByRole("button", { name: "Publish" }).click();
    await expect.poll(() => cap.publishes.length).toBe(1);
    expect(cap.publishes[0]).toEqual({ id: DOC_V3, body: { editorial: true, editorialReason: "Fixed a typo in section 2; no rule changed." } });

    // coverage: who, and a recorded completion with its evidence reference
    await coverageCard.getByRole("button", { name: "Show people" }).click();
    await expect(coverageCard).toContainText("Ben Builder");
    await expect(coverageCard).toContainText("not yet acknowledged");
    await coverageCard.getByRole("row", { name: /Ben Builder/ }).getByRole("button", { name: "Record completion" }).click();
    const rec = page.getByRole("dialog", { name: /Record a completion for Ben Builder/ });
    await rec.getByLabel("Evidence reference").fill("LMS-COMPLETION-4711");
    await expectAxeClean(page, "record completion dialog");
    await rec.getByRole("button", { name: "Record" }).click();
    await expect.poll(() => cap.records.length).toBe(1);
    expect(cap.records[0]).toEqual({ id: DOC_V2, body: { userId: "u-ben", method: "training_completed", evidenceRef: "LMS-COMPLETION-4711" } });

    // settings: strict defaults shown; relaxing the gate asks first
    const settings = page.locator("section[data-rg-card]").filter({ hasText: "Settings (admin)" }).first();
    await expect(settings).toContainText("AI literacy gate");
    await expect(settings).toContainText("strict default");
    await settings.getByLabel("Gate mode").selectOption("warn");
    await settings.getByRole("button", { name: "Save literacy settings" }).click();
    const confirm = page.getByRole("dialog", { name: "Relax the AI literacy settings?" });
    await expect(confirm).toContainText("audit trail");
    await confirm.getByRole("button", { name: "Save relaxed settings" }).click();
    await expect.poll(() => cap.settingsPuts.length).toBe(1);
    expect(cap.settingsPuts[0]).toEqual({ literacyGateMode: "warn", literacyDefaultValidityDays: 365 });
  });

  test("the interstitial asks before the page; acknowledging posts the version and digest seen", async ({ page }) => {
    const cap = await mockApi(page, { admin: false });
    await page.goto("/ui/feedback");
    const gate = page.locator("section[data-rg-card]").filter({ hasText: "Before you continue" }).first();
    await expect(gate).toBeVisible();
    await expect(gate).toContainText("support the development of AI literacy");
    await expect(gate).not.toContainText("ensure");
    await expect(gate).toContainText("your AI tool calls through regulAIt are refused");
    await expect(gate).toContainText("new version to acknowledge");
    await expectAxeClean(page, "acknowledgement interstitial");

    const button = gate.getByRole("button", { name: "Acknowledge" });
    await expect(button).toBeDisabled();
    await gate.getByLabel("I have read version 2").check();
    await button.click();
    await expect.poll(() => cap.acks.length).toBe(1);
    expect(cap.acks[0]).toEqual({ id: DOC_V2, body: { version: 2, digest: DIGEST2 } });
    await expect(page.locator("section[data-rg-card]").filter({ hasText: "Before you continue" })).toHaveCount(0);
  });

  test("'Not now' leaves a banner; the Account page carries the list and is never interrupted", async ({ page }) => {
    await mockApi(page, { admin: false });
    await page.goto("/ui/feedback");
    await page.getByRole("button", { name: "Not now" }).click();
    await expect(page.getByRole("status").filter({ hasText: "to acknowledge" })).toContainText("AI tool calls through regulAIt are refused");
    await page.goto("/ui/account?section=ai-policies");
    await expect(page.locator("section[data-rg-card]").filter({ hasText: "Before you continue" })).toHaveCount(0);
    const card = page.locator("section[data-rg-card]").filter({ hasText: "AI policies" }).first();
    await expect(card).toContainText("Acceptable use of AI");
    await expect(card).toContainText("to acknowledge");
    // scoped to this slice's section: the rest of the Account page is not A14's
    await expectAxeClean(page, "account AI policies section", '[data-testid="account-ai-policies"]');
  });

  test("D4A-04: a stored link that is not an https address is shown as text, never as a link", async ({ page }) => {
    const UNSAFE = "javascript:alert(document.cookie)";
    await mockApi(page, { admin: false, docUrl: UNSAFE });
    await page.goto("/ui/account?section=ai-policies");
    const card = page.locator('[data-testid="account-ai-policies"]');
    await expect(card).toContainText("Acceptable use of AI");
    await expect(card.getByTestId("policy-link-unsafe")).toContainText("Link not shown");
    await expect(page.locator(`a[href^="javascript:"]`)).toHaveCount(0);
    await expect(card.getByRole("link", { name: /Open “Acceptable use of AI”/ })).toHaveCount(0);
  });

  test("D4A-04: the admin list shows no link for an unsafe stored address; retiring asks for a 10-character reason", async ({ page }) => {
    await mockApi(page, { admin: true, docUrl: "data:text/html,<script>alert(1)</script>" });
    await page.goto("/ui/admin/governance/literacy");
    await expect(page.getByTestId("policy-link-unsafe").first()).toContainText("link not shown");
    await expect(page.locator(`a[href^="data:"]`)).toHaveCount(0);
    // D4G-11: retiring the published version needs a reason of at least 10 characters before anything is sent
    let retires = 0;
    await page.route("**/v1/ai-policies/*/retire", (route) => {
      retires += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ document: {}, changed: true }) });
    });
    await page.getByRole("button", { name: "Retire" }).nth(1).click();
    const dialog = page.getByRole("dialog", { name: /Retire “Acceptable use of AI” version 2/ });
    await dialog.getByLabel("Reason").fill("old");
    await dialog.getByRole("button", { name: "Retire" }).click();
    await expect(dialog.getByRole("alert")).toContainText("at least 10 characters");
    expect(retires).toBe(0);
  });
});

for (const afterRefusal of [false, true]) {
  test(`X16: late literacy preserves ${afterRefusal ? "the notice after a 409" : "the key before submission"}`, async ({ page }, testInfo) => {
    await mockApi(page, { admin: false });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/v1/me/ai-literacy", async (route) => {
      await held;
      await json(route, { required: false, current: true, documents: [], gateMode: "enforce", exempt: null, noticeDays: 14 });
    });
    let saves = 0;
    await page.route("**/v1/users/*/model-credentials", async (route) => {
      if (route.request().method() !== "POST") return json(route, { credentials: [] });
      saves += 1;
      expect(route.request().postDataJSON().apiKey).toBe("synthetic-late-literacy-key");
      return json(route, { error: "key_custody_enforced" }, 409);
    });
    await page.goto("/ui/account?section=keys");
    const key = page.getByLabel("API key", { exact: true });
    await key.fill("synthetic-late-literacy-key");
    await expect(key).toHaveValue("synthetic-late-literacy-key");
    if (!afterRefusal) {
      release();
      await expect(page.getByText("Nothing to acknowledge", { exact: true })).toBeVisible();
      await expect(key, "receiving literacy posture must not remount the Account form").toHaveValue("synthetic-late-literacy-key");
    }
    await page.getByRole("button", { name: "Save key", exact: true }).click();
    await expect(page.getByText("This deployment enforces key custody.", { exact: true })).toBeVisible();
    if (afterRefusal) {
      release();
      await expect(page.getByText("Nothing to acknowledge", { exact: true })).toBeVisible();
      await expect(page.getByText("This deployment enforces key custody.", { exact: true }), "late posture must preserve the received 409 notice").toBeVisible();
    }
    expect(saves).toBe(1);
    await expect(key).toHaveCount(0);
    expect(await page.content()).not.toContain("synthetic-late-literacy-key");
    await page.screenshot({ path: testInfo.outputPath(`x16-late-literacy-${afterRefusal ? "after-409" : "before-save"}.png`) });
  });
}
