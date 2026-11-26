/**
 * UIS-04 (owner, 2026-11-22; Codex review slice 10): a clickable table row carries one real control in its primary
 * cell, a link where the row opens another page and a button where it selects in place. The <tr> has no role, no
 * tabindex and no key handler. A mouse click elsewhere on the row still activates the control, once, and a click on
 * another control in the row never does. Synthetic fixtures only.
 */
import { expect, test, type Page } from "@playwright/test";
import { expectAxeClean, installBuilderMock } from "./builder-fixtures";

const users = [
  { id: "u", email: "admin@example.test", displayName: "Ada Admin", isAdmin: true, totpEnabled: true, hasPassword: true, disabledAt: null },
  { id: "d", email: "dana@example.test", displayName: "Dana Developer", isAdmin: false, totpEnabled: true, hasPassword: true, disabledAt: null },
];

/** an admin API with one role, two users and one MCP server; every write is counted */
async function adminFixture(page: Page) {
  const writes: string[] = [];
  const me = { userId: "u", isAdmin: true, user: users[0] };
  const gets: Record<string, unknown> = {
    "/v1/users": { users },
    "/v1/roles": { roles: [{ id: "r", name: "Auditor", description: "Read access", createdAt: "2026-10-01T00:00:00Z" }] },
    "/v1/roles/r/assignments": { assignments: [] },
    "/v1/roles/r/grants": { agents: [], connectors: [], tools: [], servers: [] },
    "/v1/servers": { servers: [{ id: "s", name: "Records", baseUrl: "https://records.example.test", enabled: true }] },
    "/v1/servers/s/tools": { tools: [{ name: "records.read", kind: "read" }] },
    "/v1/teams": { teams: [] },
    "/v1/agents": { agents: [] },
    "/v1/connectors": { connectors: [] },
    "/v1/projects": { projects: [] },
  };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!path.startsWith("/v1") && !path.startsWith("/auth"))) return route.continue();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/auth/me") return json({ ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (path === "/v1/me") return json(me);
    if (path === "/v1/me/ai-literacy") return json({ required: false, current: true, documents: [], gateMode: "enforce", noticeDays: 14 });
    if (req.method() === "GET") return json(gets[path] ?? {});
    writes.push(`${req.method()} ${path}`);
    return json({ ok: true, id: "synthetic" });
  });
  return { writes };
}

const noRowRoles = async (page: Page, where: string) => {
  await expect(page.locator("tbody tr").first(), `${where}: rows rendered`).toBeVisible();
  await expect(page.locator("tr[role]"), `${where}: no <tr> carries a role`).toHaveCount(0);
  await expect(page.locator("tr[tabindex]"), `${where}: no <tr> is focusable`).toHaveCount(0);
};

test.describe("UIS-04: clickable rows carry a real link or button", () => {
  test("a navigating row exposes a named link; Enter and a click elsewhere on the row both navigate", async ({ page }) => {
    await installBuilderMock(page);
    await page.goto("/ui/builder/agents?view=list");
    const link = page.getByRole("link", { name: "Open Vendor risk assessor" });
    await expect(link).toBeVisible();
    // a real <a> with an href, inside the row's first cell
    expect(await link.evaluate((el) => el.tagName)).toBe("A");
    await expect(link).toHaveAttribute("href", /\/ui\/builder\/agents\/aaaaaaaa-/);
    await expect(page.locator("tbody tr td:first-child").getByRole("link", { name: "Open Vendor risk assessor" })).toHaveCount(1);
    await noRowRoles(page, "builder agents");
    await expectAxeClean(page, "agents list, row links");

    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/ui\/builder\/agents\/aaaaaaaa-/);

    await page.goBack();
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Open Vendor risk assessor" }) });
    // the row's owner cell holds no control of its own: a click there goes through to the row's link
    await row.getByRole("cell").nth(3).click();
    await expect(page).toHaveURL(/\/ui\/builder\/agents\/aaaaaaaa-/);
  });

  test("a selecting row exposes a button that opens in place, and a click on its own cell fires once", async ({ page }) => {
    await adminFixture(page);
    await page.goto("/ui/admin/roles");
    const select = page.getByRole("button", { name: "Open grants for Auditor" });
    await expect(select).toBeVisible();
    expect(await select.evaluate((el) => el.tagName)).toBe("BUTTON");
    await expect(page.getByRole("link", { name: "Open grants for Auditor" })).toHaveCount(0);
    await noRowRoles(page, "roles");

    // Enter on the button opens the grants in place: no navigation
    await select.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Held by", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/ui\/admin\/roles$/);
    // the roles page toggles on a second activation: one click on the button must toggle exactly once (closed again)
    await select.click();
    await expect(page.getByText("Select a role to view and edit its grants and holders", { exact: true })).toBeVisible();
    // a click on another cell of the row goes through to the button, once (open again)
    await page.getByRole("row").filter({ has: select }).getByRole("cell", { name: "Read access" }).click();
    await expect(page.getByText("Held by", { exact: true })).toBeVisible();
    await expect(select, "the row click leaves focus on the row's button").toBeFocused();
    await expectAxeClean(page, "roles, row buttons");
  });

  test("a click on an inner control does not trigger the row", async ({ page }) => {
    await adminFixture(page);
    await page.goto("/ui/admin/roles");
    await expect(page.getByText("Select a role to view and edit its grants and holders", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "delete", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Delete role “Auditor”?" });
    await expect(dialog).toBeVisible();
    // the row's own action opened its dialog, and the row did not also open the grants behind it
    await expect(page.getByText("Select a role to view and edit its grants and holders", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Held by", { exact: true })).toHaveCount(0);
  });

  test("no tr[role=link] remains on a sample of list pages", async ({ page }) => {
    await adminFixture(page);
    for (const [path, control] of [
      ["/ui/admin/users", "Manage Dana Developer"],
      ["/ui/admin/roles", "Open grants for Auditor"],
      ["/ui/admin/mcp-servers", "Show tools on Records"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("button", { name: control }), path).toBeVisible();
      await noRowRoles(page, path);
    }
  });
});
