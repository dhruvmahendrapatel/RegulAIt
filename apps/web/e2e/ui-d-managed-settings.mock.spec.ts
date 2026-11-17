/**
 * Lane UI-D, D1 slice 1: managed settings (ADR-0310, #850's contract), against a mocked gateway.
 *
 *  - the list reads one keyset page and "Load more" sends the contract's `before` cursor;
 *  - names are joined from the directory and role reads; a subject neither returns is named by its kind;
 *  - exporting checks inline first, then POSTs exactly the contract's body, and an unchanged policy says no new
 *    version was made;
 *  - a version's archive downloads under the gateway's file name;
 *  - a failed list read is an error with Retry, never "No bundles yet";
 *  - axe (WCAG 2.x A/AA) in light and dark, and no sideways scroll at 390 px.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const ME = { id: "aaaaaaaa-0000-4000-8000-000000000001", displayName: "Ada Admin" };
const AVERY = "bbbbbbbb-0000-4000-8000-000000000002";
const DEVS = "dddddddd-0000-4000-8000-000000000004";
const GONE = "eeeeeeee-0000-4000-8000-000000000005";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const bundle = (id: string, kind: "user" | "role", subjectId: string, version: number) => ({
  id, subject: { kind, id: subjectId }, version, policyDigest: "d".repeat(64), keyId: "ms-2026-11", serverCount: 2,
  createdAt: "2026-11-16T09:00:00Z",
});
const B1 = "10000000-0000-4000-8000-000000000001";
const B2 = "10000000-0000-4000-8000-000000000002";
const B3 = "10000000-0000-4000-8000-000000000003";

interface Calls { lists: string[]; posts: unknown[]; archives: string[] }

async function mockGateway(page: Page, opts: { listFails?: boolean; unchanged?: boolean } = {}): Promise<Calls> {
  const calls: Calls = { lists: [], posts: [], archives: [] };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me")
      return json(route, {
        userId: ME.id, isAdmin: true, via: "session",
        user: { id: ME.id, email: "ada@example.test", displayName: ME.displayName },
        mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false,
      });
    if (p === "/v1/me") return json(route, { userId: ME.id, isAdmin: true, user: { id: ME.id, email: "ada@example.test", displayName: ME.displayName } });
    if (p === "/v1/managed-settings/bundles" && req.method() === "GET") {
      calls.lists.push(url.search);
      if (opts.listFails) return json(route, { error: "internal" }, 500);
      if (url.searchParams.get("before") === B2) return json(route, { bundles: [bundle(B3, "role", GONE, 1)], next: null });
      return json(route, { bundles: [bundle(B1, "user", AVERY, 2), bundle(B2, "role", DEVS, 1)], next: B2 });
    }
    if (p === "/v1/managed-settings/bundles" && req.method() === "POST") {
      calls.posts.push(req.postDataJSON());
      return opts.unchanged
        ? json(route, { ...bundle(B1, "user", AVERY, 2), created: false })
        : json(route, { ...bundle(B3, "role", DEVS, 2), created: true }, 201);
    }
    if (p.endsWith("/archive")) {
      calls.archives.push(p);
      return route.fulfill({ status: 200, contentType: "application/gzip", body: Buffer.from([0x1f, 0x8b, 0x08, 0x00]) });
    }
    if (p === "/v1/users")
      return json(route, {
        users: [
          { id: ME.id, email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null },
          { id: AVERY, email: "avery@example.test", displayName: "Avery Approver", isAdmin: false, disabledAt: null },
        ],
      });
    if (p === "/v1/roles") return json(route, { roles: [{ id: DEVS, name: "Developers", description: null }] });
    return json(route, {});
  });
  return calls;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}


test.describe("UI-D D1: managed settings", () => {
  test("lists one page, joins names, and Load more sends the cursor", async ({ page }) => {
    const calls = await mockGateway(page);
    await page.goto("/ui/admin/managed-settings");
    await expect(page.getByRole("heading", { name: "Managed settings", level: 1 })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Avery Approver (user)", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Developers (role)", exact: true })).toBeVisible();
    expect(calls.lists).toEqual(["?limit=50"]);
    await expectAxeClean(page, "managed settings");

    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByRole("cell", { name: "A role that no longer exists", exact: true })).toBeVisible();
    expect(calls.lists).toEqual(["?limit=50", `?limit=50&before=${B2}`]);
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  });

  test("exporting checks inline first, then sends exactly the contract's body", async ({ page }) => {
    const calls = await mockGateway(page);
    await page.goto("/ui/admin/managed-settings");
    await page.getByRole("button", { name: "Export a bundle" }).click();
    const dialog = page.getByRole("dialog", { name: "Export a managed-settings bundle" });
    await dialog.getByLabel("Claude Code minimum version (optional)").fill("1.0");
    await dialog.getByRole("button", { name: "Export and sign" }).click();
    await expect(dialog).toContainText("Choose a person or a role.");
    await expect(dialog).toContainText("Use a version like 1.0.30.");
    expect(calls.posts).toEqual([]);
    await expectAxeClean(page, "export dialog");

    await dialog.getByLabel("For").selectOption({ label: "Developers" });
    await dialog.getByLabel("Claude Code minimum version (optional)").fill("1.0.30");
    await dialog.getByRole("button", { name: "Export and sign" }).click();
    await expect(dialog).toBeHidden();
    expect(calls.posts).toEqual([{ subject: { kind: "role", id: DEVS }, claudeCodeMinimumVersion: "1.0.30" }]);
    await expect(page.getByRole("status").filter({ hasText: "Developers (role): Version 2 exported and signed." })).toBeVisible();
  });

  test("an unchanged policy says no new version was made, and the archive downloads by its name", async ({ page }) => {
    const calls = await mockGateway(page, { unchanged: true });
    await page.goto("/ui/admin/managed-settings");
    await page.getByRole("button", { name: "Export a bundle" }).click();
    const dialog = page.getByRole("dialog", { name: "Export a managed-settings bundle" });
    await dialog.getByLabel("For").selectOption({ label: "Avery Approver" });
    await dialog.getByRole("button", { name: "Export and sign" }).click();
    await expect(page.getByRole("status").filter({ hasText: "no new version was made" })).toBeVisible();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download version 2 for Avery Approver (user)" }).click();
    expect((await download).suggestedFilename()).toBe("regulait-managed-settings-user-v2.tar.gz");
    expect(calls.archives).toEqual([`/v1/managed-settings/bundles/${B1}/archive`]);
  });

  test("a failed list read is an error with Retry, never an empty list", async ({ page }) => {
    await mockGateway(page, { listFails: true });
    await page.goto("/ui/admin/managed-settings");
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByText("No bundles yet")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("no sideways scroll at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockGateway(page);
    await page.goto("/ui/admin/managed-settings");
    await expect(page.getByRole("heading", { name: "Managed settings", level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
