/**
 * #453 G2 — an admin creates a project from Projects and edits one from its own page (against a mocked gateway).
 * Both reuse the Cost dashboard's forms, so the budget-approver rule holds here too; a non-admin sees neither door.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const PROJECT = { id: "p1", name: "team-17 support", budgetUsd: null, spentUsd: 0, classifications: [] };

async function mockApi(page: Page, opts: { admin: boolean }) {
  const me = { userId: "u-ada", isAdmin: opts.admin, user: { id: "u-ada", email: "ada@example.test", displayName: "Ada Admin" } };
  const posts: unknown[] = [];
  const patches: Array<{ path: string; body: unknown }> = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/projects" && req.method() === "POST") {
      posts.push(req.postDataJSON());
      return json(route, { project: { ...PROJECT, id: "p2", name: "Credit operations" } }, 201);
    }
    if (p === "/v1/projects") return json(route, { projects: [PROJECT] });
    if (p === "/v1/projects/p1" && req.method() === "PATCH") {
      patches.push({ path: p, body: req.postDataJSON() });
      return json(route, { project: PROJECT });
    }
    if (p === "/v1/projects/p1/members") return json(route, { members: [{ userId: "u-ada", userName: "Ada Admin", role: "owner", createdAt: "2026-10-01T00:00:00.000Z" }] });
    if (p === "/v1/users") return json(route, { users: [{ id: "u-avery", email: "avery@example.test", displayName: "Avery Approver", isAdmin: false }] });
    if (p === "/v1/initiatives") return json(route, { initiatives: [] });
    return json(route, {});
  });
  return { posts, patches };
}

test("an admin creates a project from Projects; the budget still needs a named approver", async ({ page }) => {
  const api = await mockApi(page, { admin: true });
  await page.goto("/ui/projects");
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill("Credit operations");
  await dialog.getByLabel("Budget USD").fill("25");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog.getByRole("alert")).toContainText("requires a named budget approver");
  expect(api.posts).toEqual([]);
  await dialog.getByLabel("Budget USD").fill("");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog).toBeHidden();
  expect(api.posts).toEqual([{ name: "Credit operations" }]);
});

test("an admin edits a project's settings from its own page, with no project picker", async ({ page }) => {
  const api = await mockApi(page, { admin: true });
  await page.goto("/ui/projects/p1");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: /Settings — team-17 support/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Project")).toHaveCount(0);
  await dialog.getByLabel("Cost centre").fill("CC-0042");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  expect(api.patches).toEqual([{ path: "/v1/projects/p1", body: { costCenter: "CC-0042" } }]);
});

test("Cancel closes the dialog without a write", async ({ page }) => {
  const api = await mockApi(page, { admin: true });
  await page.goto("/ui/projects");
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(api.posts).toEqual([]);
});

test("a member who is not an admin sees neither New project nor Settings", async ({ page }) => {
  await mockApi(page, { admin: false });
  await page.goto("/ui/projects");
  await expect(page.getByRole("button", { name: /Open project team-17 support/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "New project" })).toHaveCount(0);
  await page.goto("/ui/projects/p1");
  await expect(page.getByRole("button", { name: "Download CSV" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" })).toHaveCount(0);
});
