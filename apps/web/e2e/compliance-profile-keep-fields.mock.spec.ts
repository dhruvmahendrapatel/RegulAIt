/**
 * #453 — the compliance profile form never clears a floor it does not show (against a mocked gateway).
 * ADR-0208 (G7) made the card create-only: a new profile starts at the strict defaults, and typing an existing tag
 * loads its stored values but never posts them (that profile changes through Edit profile, a reviewed version). The
 * list gating from #602 stays: nothing is created until the list has loaded without error.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const HIPAA = {
  id: "cp-1",
  tag: "hipaa",
  requiredTemplateIds: null,
  mcpDefaultMode: "read_only",
  auditRetentionDays: 2190,
  piiMode: "block",
  backupRetentionDays: 30,
  patchCadenceDays: 14,
  maxProjectBudgetUsd: 500,
  budgetEnforcement: "block",
  guardrailModes: { prompt_injection: "block" },
  redteamGatingClasses: ["prompt_injection"],
  redteamMinTrials: 3,
  redteamFailOnSeverity: "high",
  minIsolationClass: "microvm",
};

async function mockApi(page: Page, list: (route: Route) => Promise<void> = (route) => json(route, { profiles: [HIPAA] })) {
  const me = { userId: "u-ada", isAdmin: true, user: { id: "u-ada", email: "ada@example.test", displayName: "Ada Admin" } };
  const posts: Array<Record<string, unknown>> = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/compliance/profiles" && req.method() === "POST") {
      posts.push(req.postDataJSON());
      return json(route, { profile: HIPAA });
    }
    if (p === "/v1/compliance/profiles") return list(route);
    if (p === "/v1/workflows/templates") return json(route, { templates: [] });
    return json(route, {});
  });
  return { posts };
}

const form = (page: Page) => page.locator("section", { has: page.getByRole("button", { name: "Create profile" }) });

test("a new profile starts at the strict defaults", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/ui/admin/compliance");
  const card = form(page);
  await card.getByLabel("Tag", { exact: true }).fill("pci");
  await expect(card.getByLabel("MCP default mode")).toHaveValue("read_only");
  await expect(card.getByLabel("PII mode")).toHaveValue("block");
  await card.getByRole("button", { name: "Create profile" }).click();
  await expect.poll(() => api.posts.length).toBe(1);
  expect(api.posts[0]).toMatchObject({ tag: "pci", mcpDefaultMode: "read_only", piiMode: "block" });
  expect(api.posts[0]).not.toHaveProperty("guardrailModes");
});

test("an existing tag loads its stored values and is never posted from the create card", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/ui/admin/compliance");
  const card = form(page);
  await card.getByLabel("Tag", { exact: true }).fill("hipaa");
  await expect(card.getByLabel("Audit retention days (blank = none)")).toHaveValue("2190");
  await expect(card.getByRole("status")).toContainText("change it with Edit profile on its row");
  await expect(card.getByRole("button", { name: "Create profile" })).toBeDisabled();
  await card.getByLabel("Tag", { exact: true }).press("Enter");
  expect(api.posts).toHaveLength(0);
});

test("moving from an existing tag to a new one starts again from the strict defaults", async ({ page }) => {
  const api = await mockApi(page, (route) => json(route, { profiles: [{ ...HIPAA, mcpDefaultMode: "read_write", piiMode: "log" }] }));
  await page.goto("/ui/admin/compliance");
  const card = form(page);
  const tag = card.getByLabel("Tag", { exact: true });
  await tag.fill("hipaa");
  await expect(card.getByLabel("MCP default mode")).toHaveValue("read_write");
  await expect(card.getByLabel("Audit retention days (blank = none)")).toHaveValue("2190");
  await tag.pressSequentially("-eu");
  await expect(tag).toHaveValue("hipaa-eu");
  await expect(card.getByLabel("MCP default mode")).toHaveValue("read_only");
  await expect(card.getByLabel("PII mode")).toHaveValue("block");
  await expect(card.getByLabel("Audit retention days (blank = none)")).toHaveValue("");
  await expect(card.getByLabel("Backup retention days (infra floor)")).toHaveValue("");
  await expect(card.getByLabel("Patch cadence days (infra ceiling)")).toHaveValue("");
  await card.getByRole("button", { name: "Create profile" }).click();
  await expect.poll(() => api.posts.length).toBe(1);
  expect(api.posts[0]).toEqual({
    tag: "hipaa-eu",
    mcpDefaultMode: "read_only",
    piiMode: "block",
    auditRetentionDays: null,
    backupRetentionDays: null,
    patchCadenceDays: null,
  });
});

test("saving waits for the profiles list, then loads a tag typed before it arrived", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const api = await mockApi(page, async (route) => {
    await gate;
    await json(route, { profiles: [HIPAA] });
  });
  await page.goto("/ui/admin/compliance");
  const card = form(page);
  await card.getByLabel("Tag", { exact: true }).fill("hipaa");
  await expect(card.getByRole("button", { name: "Create profile" })).toBeDisabled();
  await expect(card.getByText("Loading the existing profiles")).toBeVisible();
  release();
  await expect(card.getByLabel("Audit retention days (blank = none)")).toHaveValue("2190");
  await expect(card.getByRole("button", { name: "Create profile" })).toBeDisabled();
  expect(api.posts).toHaveLength(0);
});

test("saving is off while the profiles list has failed to load", async ({ page }) => {
  const api = await mockApi(page, (route) => json(route, { error: "unavailable" }, 503));
  await page.goto("/ui/admin/compliance");
  const card = form(page);
  await card.getByLabel("Tag", { exact: true }).fill("hipaa");
  await expect(card.getByRole("alert")).toContainText("did not load");
  await expect(card.getByRole("button", { name: "Create profile" })).toBeDisabled();
  expect(api.posts).toHaveLength(0);
});

test("a retired template the stored profile requires is shown, disabled, as still required", async ({ page }) => {
  const api = await mockApi(page, (route) => json(route, { profiles: [{ ...HIPAA, requiredTemplateIds: ["tpl-old"] }] }));
  await page.route("**/v1/workflows/templates", (route) =>
    json(route, {
      templates: [
        { id: "tpl-old", name: "Old review", retiredAt: "2026-10-01T00:00:00Z" },
        { id: "tpl-new", name: "New review", retiredAt: null },
      ],
    }),
  );
  await page.goto("/ui/admin/compliance");
  const card = form(page);
  await card.getByLabel("Tag", { exact: true }).fill("hipaa");
  const select = card.getByLabel("Required workflow templates (ctrl/cmd-click)");
  await expect(select.locator("option", { hasText: "Old review" })).toBeDisabled();
  // the stored profile is shown read-only here (it changes through Edit profile), so nothing is posted
  await expect(card.getByRole("button", { name: "Create profile" })).toBeDisabled();
  expect(api.posts).toHaveLength(0);
});

test("saving stays off while the profiles query is paused offline", async ({ page }) => {
  // capture TanStack's offline listener so the test can take the app offline once it has signed in
  await page.addInitScript(() => {
    const add = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
      if (type === "offline") (window as unknown as { goOffline: () => void }).goOffline = () => window.dispatchEvent(new Event("offline"));
      return add(type, fn, opts);
    }) as typeof window.addEventListener;
  });
  const api = await mockApi(page);
  await page.goto("/ui/admin/compliance/__none");
  await page.waitForFunction(() => typeof (window as unknown as { goOffline?: () => void }).goOffline === "function");
  await page.evaluate(() => {
    (window as unknown as { goOffline: () => void }).goOffline();
    history.pushState({}, "", "/ui/admin/compliance");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const card = form(page);
  await card.getByLabel("Tag", { exact: true }).fill("hipaa");
  await expect(card.getByRole("button", { name: "Create profile" })).toBeDisabled();
  await expect(card.getByText("Loading the existing profiles")).toBeVisible();
  expect(api.posts).toHaveLength(0);
});
