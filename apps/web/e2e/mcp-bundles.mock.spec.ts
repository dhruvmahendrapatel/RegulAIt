/**
 * Governed MCP bundles (#453), from the browser's side. Every /v1 and /auth call is answered by an in-test mock that
 * follows apps/gateway/src/mcp-bundles.ts: the list's `{ enabled, bundles[] }`, create from exact (server, tool) pairs,
 * a new version with `expectedVersion` (409 `version_conflict`; adding a tool is a `settings_relax` step-up), the
 * immutable version view, grants with exactly one subject and `maxTier` (400 `approver_required` for dangerous with
 * no approver), revoke, archive, naming an approver (a step-up), and a tool's dangerous flag (clearing is a step-up).
 * The default-off org setting is turned on through its row (a step-up). Axe in light and dark. Synthetic names only.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./builder-fixtures";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const ADA = "a0000000-0000-4000-8000-000000000001";
const BO = "a0000000-0000-4000-8000-000000000002";
const SRV = "b0000000-0000-4000-8000-000000000001";
const T_READ = "c0000000-0000-4000-8000-000000000001";
const T_DEL = "c0000000-0000-4000-8000-000000000002";
const T_LIST = "c0000000-0000-4000-8000-000000000003";
const ROLE = "d0000000-0000-4000-8000-000000000001";
const TEAM = "d0000000-0000-4000-8000-000000000002";
const B1 = "e0000000-0000-4000-8000-000000000001";
const NOW = "2026-11-10T09:00:00.000Z";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

interface Item {
  serverId: string;
  toolName: string;
}
interface Bundle {
  id: string;
  name: string;
  description: string | null;
  approverUserId: string | null;
  currentVersion: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  versions: Array<{ version: number; createdBy: string; createdAt: string; items: Item[] }>;
  grants: Array<{ id: string; userId: string | null; roleId: string | null; teamId: string | null; maxTier: string; grantedBy: string; createdAt: string }>;
}

interface Opts {
  enabled?: boolean;
  bundles?: boolean;
  failList?: number;
  /** the next PUT …/items is answered with a 409 version_conflict */
  conflict?: boolean;
}

async function mockApi(page: Page, opts: Opts = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const settings: Record<string, unknown> = { mcpBundlesEnabled: opts.enabled ?? true };
  let failList = opts.failList ?? 0;
  let conflict = opts.conflict ?? false;
  const tools = [
    { id: T_READ, serverId: SRV, name: "read_file", kind: "read", description: null, pricePerCallUsd: null, dangerous: false },
    { id: T_LIST, serverId: SRV, name: "list_branches", kind: "read", description: null, pricePerCallUsd: null, dangerous: false },
    { id: T_DEL, serverId: SRV, name: "delete_branch", kind: "write", description: null, pricePerCallUsd: null, dangerous: true },
  ];
  const bundles: Bundle[] =
    opts.bundles === false
      ? []
      : [
          {
            id: B1,
            name: "repo-readers",
            description: "Read the repositories",
            approverUserId: null,
            currentVersion: 2,
            archivedAt: null,
            createdAt: "2026-11-01T09:00:00.000Z",
            updatedAt: "2026-11-02T09:00:00.000Z",
            versions: [
              { version: 1, createdBy: ADA, createdAt: "2026-11-01T09:00:00.000Z", items: [{ serverId: SRV, toolName: "read_file" }, { serverId: SRV, toolName: "list_branches" }] },
              { version: 2, createdBy: ADA, createdAt: "2026-11-02T09:00:00.000Z", items: [{ serverId: SRV, toolName: "read_file" }] },
            ],
            grants: [{ id: "f0000000-0000-4000-8000-000000000001", userId: BO, roleId: null, teamId: null, maxTier: "read", grantedBy: ADA, createdAt: "2026-11-02T10:00:00.000Z" }],
          },
        ];
  const users = [
    { id: ADA, email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null, createdAt: NOW },
    { id: BO, email: "bo@example.test", displayName: "Bo Builder", isAdmin: false, disabledAt: null, createdAt: NOW },
  ];
  const view = (b: Bundle) => ({ id: b.id, name: b.name, description: b.description, approverUserId: b.approverUserId, currentVersion: b.currentVersion, archivedAt: b.archivedAt, createdAt: b.createdAt, updatedAt: b.updatedAt });
  const withNames = (items: Item[]) => items.map((i) => ({ ...i, serverName: "repo-tools" }));
  const current = (b: Bundle) => b.versions.find((x) => x.version === b.currentVersion)!.items;
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    calls.push({ method, path: p, body });
    const me = { userId: ADA, isAdmin: true, user: { id: ADA, email: "ada@example.test", displayName: "Ada Admin" } };
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/users") return json(route, { users });
    if (p === "/v1/roles") return json(route, { roles: [{ id: ROLE, name: "Reviewers" }] });
    if (p === "/v1/teams") return json(route, { teams: [{ id: TEAM, name: "Platform" }] });
    if (p === "/v1/servers") return json(route, { servers: [{ id: SRV, name: "repo-tools", url: "https://mcp.example.test/repo", transport: "streamable_http" }] });
    if (p === `/v1/servers/${SRV}/tools`) return json(route, { tools });
    if (p === "/v1/org/settings") {
      if (method === "PUT") Object.assign(settings, body as object);
      return json(route, { settings });
    }
    let m = p.match(/^\/v1\/mcp-tools\/([^/]+)\/dangerous$/);
    if (m && method === "PUT") {
      const t = tools.find((x) => x.id === m![1])!;
      t.dangerous = (body as { dangerous: boolean }).dangerous;
      return json(route, { id: t.id, serverId: t.serverId, name: t.name, kind: t.kind, dangerous: t.dangerous });
    }
    if (p === "/v1/mcp-bundles") {
      if (method === "GET") {
        if (failList > 0) {
          failList -= 1;
          return json(route, { error: "internal_error" }, 500);
        }
        return json(route, { enabled: settings.mcpBundlesEnabled, bundles: bundles.map((b) => ({ ...view(b), grantCount: b.grants.length })) });
      }
      const nb = body as { name: string; approverUserId: string | null; items: Item[] };
      const b: Bundle = { id: "e0000000-0000-4000-8000-000000000002", name: nb.name, description: null, approverUserId: nb.approverUserId, currentVersion: 1, archivedAt: null, createdAt: NOW, updatedAt: NOW, versions: [{ version: 1, createdBy: ADA, createdAt: NOW, items: nb.items }], grants: [] };
      bundles.push(b);
      return json(route, { ...view(b), items: nb.items }, 201);
    }
    m = p.match(/^\/v1\/mcp-bundles\/([^/]+)(?:\/(items|versions|grants)(?:\/([^/]+))?)?$/);
    if (m) {
      const [, id, sub, rest] = m;
      const b = bundles.find((x) => x.id === id);
      if (!b) return json(route, { error: "unknown_bundle" }, 404);
      if (!sub && method === "GET") return json(route, { ...view(b), items: withNames(current(b)), versions: [...b.versions].reverse().map(({ version, createdBy, createdAt }) => ({ version, createdBy, createdAt })) });
      if (!sub && method === "PATCH") {
        Object.assign(b, body as object, { updatedAt: "2026-11-10T10:00:00.000Z" });
        return json(route, view(b));
      }
      if (!sub && method === "DELETE") {
        b.archivedAt = NOW;
        return json(route, view(b));
      }
      if (sub === "items") {
        const { expectedVersion, items } = body as { expectedVersion: number; items: Item[] };
        if (conflict || expectedVersion !== b.currentVersion) {
          conflict = false;
          const was = current(b);
          b.currentVersion += 1;
          b.versions.push({ version: b.currentVersion, createdBy: BO, createdAt: NOW, items: was });
          return json(route, { error: "version_conflict", detail: `the bundle is at version ${b.currentVersion}, not ${expectedVersion}. Nothing was saved.`, currentVersion: b.currentVersion }, 409);
        }
        b.currentVersion += 1;
        b.updatedAt = NOW;
        b.versions.push({ version: b.currentVersion, createdBy: ADA, createdAt: NOW, items });
        return json(route, { ...view(b), items, added: [], removed: [] });
      }
      if (sub === "versions") {
        const v = b.versions.find((x) => x.version === Number(rest));
        return v ? json(route, { bundleId: b.id, version: v.version, createdBy: v.createdBy, createdAt: v.createdAt, items: withNames(v.items) }) : json(route, { error: "unknown_version" }, 404);
      }
      if (sub === "grants" && method === "GET") {
        return json(route, {
          grants: b.grants.map((g) => ({ ...g, userEmail: users.find((u) => u.id === g.userId)?.email ?? null, roleName: g.roleId ? "Reviewers" : null, teamName: g.teamId ? "Platform" : null })),
        });
      }
      if (sub === "grants" && method === "POST") {
        const g = body as { userId?: string; roleId?: string; teamId?: string; maxTier?: string };
        if (g.maxTier === "dangerous" && !b.approverUserId) {
          return json(route, { error: "approver_required", detail: "a grant that reaches dangerous tools needs the bundle to name an approver (every such call pauses for them). Nothing was saved." }, 400);
        }
        const row = { id: `f0000000-0000-4000-8000-00000000000${b.grants.length + 2}`, userId: g.userId ?? null, roleId: g.roleId ?? null, teamId: g.teamId ?? null, maxTier: g.maxTier ?? "read", grantedBy: ADA, createdAt: NOW };
        b.grants.push(row);
        return json(route, { ...row, bundleId: b.id }, 201);
      }
      if (sub === "grants" && method === "DELETE") {
        b.grants = b.grants.filter((g) => g.id !== rest);
        return route.fulfill({ status: 204 });
      }
    }
    return json(route, {});
  });
  return { calls, bundles, tools, settings };
}

const sent = (calls: Array<{ method: string; path: string; body: unknown }>, method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);
const card = (page: Page, title: string) => page.locator("[data-rg-card]").filter({ has: page.getByText(title, { exact: true }) });

test.describe("MCP bundles (#453)", () => {
  test("reached from the MCP servers page; off by default: says so, offers no create, and turning on is a step-up", async ({ page }) => {
    await mockApi(page, { enabled: false });
    await page.goto("/ui/admin/mcp-servers");
    await page.getByRole("link", { name: "MCP bundles" }).click();
    await expect(page).toHaveURL(/\/ui\/admin\/mcp-servers\/bundles$/);
    await expect(page.getByTestId("bundles-off")).toContainText("MCP bundles are off");
    await expect(page.getByRole("form", { name: "New bundle" })).toHaveCount(0);
    await expect(card(page, "Bundles").getByRole("link", { name: "repo-readers" })).toBeVisible();
    await expectAxeClean(page, "MCP bundles: off");

    const row = page.getByTestId("org-setting-mcpBundlesEnabled");
    await expect(row.getByText("strict", { exact: true })).toBeVisible();
    const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/org/settings", kind: "settings_relax" });
    await row.getByLabel("Tool bundles", { exact: true }).selectOption("true");
    await row.getByRole("button", { name: "Review change" }).click();
    await page.getByRole("dialog", { name: "Change tool bundles?" }).getByRole("button", { name: "Relax setting" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ mcpBundlesEnabled: true });
    await expect(page.getByTestId("bundles-off")).toHaveCount(0);
    await expect(page.getByRole("form", { name: "New bundle" })).toBeVisible();
  });

  test("loading then a failed read with Retry, then the list; an empty list says so", async ({ page }) => {
    // the app retries a transient failure once, so two failures reach the error state
    await mockApi(page, { failList: 2 });
    await page.goto("/ui/admin/mcp-servers/bundles");
    // the skeleton announces itself while the read (and its one retry) is in flight
    await expect(page.getByRole("status").first()).toBeVisible();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();
    const row = card(page, "Bundles").getByRole("row").filter({ hasText: "repo-readers" });
    await expect(row).toContainText("Read the repositories");
    await expect(row).toContainText("1 grant");
    await expect(row).toContainText("Active");
    await expect(row).toContainText("2 Nov 2026");

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockApi(page, { bundles: false });
    await page.reload();
    await expect(page.getByText("No bundles yet")).toBeVisible();
  });

  test("create from exact inventory tools; the dangerous flag: flagging asks nothing, clearing is a step-up", async ({ page }) => {
    const { calls, tools } = await mockApi(page);
    await page.goto("/ui/admin/mcp-servers/bundles");
    const form = page.getByRole("form", { name: "New bundle" });
    await form.getByLabel("Name", { exact: true }).fill("branch-tools");
    await form.getByLabel("Approver for dangerous tools", { exact: true }).selectOption(ADA);
    await form.getByLabel("Add tools from server", { exact: true }).selectOption(SRV);
    const del = form.getByRole("row").filter({ hasText: "delete_branch" });
    await expect(del.getByText("Dangerous", { exact: true })).toBeVisible();
    await form.getByLabel("Include read_file").check();
    await form.getByLabel("Include delete_branch").check();
    await expect(form.getByText("2 tools chosen, at most 200.")).toBeVisible();
    await expectAxeClean(page, "MCP bundles: new bundle");

    // flagging tightens: no step-up
    await form.getByRole("button", { name: "Flag dangerous: read_file" }).click();
    await expect(form.getByRole("row").filter({ hasText: "read_file" }).first().getByText("Dangerous", { exact: true })).toBeVisible();
    expect(sent(calls, "PUT", `/v1/mcp-tools/${T_READ}/dangerous`)).toEqual([{ dangerous: true }]);
    // clearing relaxes: a step-up
    const su = await requireStepUpOn(page, { method: "PUT", path: `/v1/mcp-tools/${T_DEL}/dangerous`, kind: "settings_relax" });
    await form.getByRole("button", { name: "Clear dangerous flag: delete_branch" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ dangerous: false });
    expect(tools.find((t) => t.id === T_DEL)!.dangerous).toBe(false);

    await form.getByRole("button", { name: "Create bundle" }).click();
    await expect(page).toHaveURL(/\/bundles\/e0000000-0000-4000-8000-000000000002$/);
    expect(sent(calls, "POST", "/v1/mcp-bundles")).toEqual([
      { name: "branch-tools", approverUserId: ADA, items: [{ serverId: SRV, toolName: "read_file" }, { serverId: SRV, toolName: "delete_branch" }] },
    ]);
  });

  test("change tools: adding is a step-up, a stale version is refused inline with a reload; history shows each version", async ({ page }) => {
    const { calls } = await mockApi(page, { conflict: true });
    await page.goto(`/ui/admin/mcp-servers/bundles/${B1}`);
    await expect(page.getByRole("heading", { name: "Bundle: repo-readers" })).toBeVisible();
    const tools = card(page, "Tools in version 2");
    await expect(tools.getByRole("row").filter({ hasText: "read_file" })).toContainText("repo-tools");
    await expect(page.getByText("Audited", { exact: true })).toBeVisible();

    await tools.getByRole("button", { name: "Change tools" }).click();
    const edit = page.getByRole("form", { name: "Change tools" });
    await edit.getByLabel("Add tools from server", { exact: true }).selectOption(SRV);
    await edit.getByLabel("Include list_branches").check();
    await expect(edit.getByTestId("bundle-diff")).toContainText("Version 3, for every holder: 1 added, 0 removed. Adding asks for a step-up.");
    // the mock refuses the first save with a 409 before any step-up, as the gateway checks the version first
    await edit.getByRole("button", { name: "Save version 3" }).click();
    const refused = edit.getByRole("alert");
    await expect(refused).toContainText("the bundle is at version 3, not 2");
    await expect(refused).toContainText("Reload the bundle and make your change again.");
    await expectAxeClean(page, "MCP bundles: a stale version");
    await refused.getByRole("button", { name: "Reload the bundle" }).click();
    const t3 = card(page, "Tools in version 3");
    await expect(t3).toBeVisible();

    await t3.getByRole("button", { name: "Change tools" }).click();
    const edit2 = page.getByRole("form", { name: "Change tools" });
    await edit2.getByLabel("Add tools from server", { exact: true }).selectOption(SRV);
    await edit2.getByLabel("Include list_branches").check();
    // only the widening save (two tools) needs the step-up
    const su = await requireStepUpOn(page, { method: "PUT", path: `/v1/mcp-bundles/${B1}/items`, kind: "settings_relax", when: (b) => (b as { items: Item[] }).items.length === 2 });
    await edit2.getByRole("button", { name: "Save version 4" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ expectedVersion: 3, items: [{ serverId: SRV, toolName: "read_file" }, { serverId: SRV, toolName: "list_branches" }] });
    await expect(card(page, "Tools in version 4")).toBeVisible();

    // removing only narrows: the mock asks no step-up, and the harness sees no new attempt
    await card(page, "Tools in version 4").getByRole("button", { name: "Change tools" }).click();
    await page.getByRole("form", { name: "Change tools" }).getByRole("button", { name: "Take out list_branches" }).click();
    await page.getByRole("button", { name: "Save version 5" }).click();
    await expect(card(page, "Tools in version 5")).toBeVisible();
    expect(sent(calls, "PUT", `/v1/mcp-bundles/${B1}/items`).at(-1)).toEqual({ expectedVersion: 4, items: [{ serverId: SRV, toolName: "read_file" }] });

    // history: who and when, and an immutable version view
    const history = card(page, "Version history");
    await expect(history.getByRole("row").filter({ hasText: "5 (current)" })).toContainText("Ada Admin");
    await history.getByRole("button", { name: "View version 1" }).click();
    const v1 = page.getByRole("region", { name: "Version 1" });
    await expect(v1.getByRole("row").filter({ hasText: "list_branches" })).toBeVisible();
    expect(calls.some((c) => c.path === `/v1/mcp-bundles/${B1}/versions/1`)).toBe(true);
  });

  test("grants: read preselected, dangerous refused inline until an approver is named (a step-up), revoke and archive confirm", async ({ page }) => {
    const { calls } = await mockApi(page);
    await page.goto(`/ui/admin/mcp-servers/bundles/${B1}`);
    const held = card(page, "Held by");
    await expect(held.getByRole("row").filter({ hasText: "bo@example.test (person)" })).toContainText("Read tools only");
    const form = page.getByRole("form", { name: "Grant this bundle" });
    await expect(form.getByLabel("Up to", { exact: true })).toHaveValue("read");

    await form.getByLabel("Grant to", { exact: true }).selectOption("role");
    await form.getByLabel("Role", { exact: true }).selectOption(ROLE);
    await form.getByLabel("Up to", { exact: true }).selectOption("dangerous");
    await form.getByRole("button", { name: "Grant" }).click();
    await expect(form.getByRole("alert")).toContainText("needs the bundle to name an approver");
    await expect(form.getByRole("alert")).toContainText("Name an approver under Details first.");
    await expectAxeClean(page, "MCP bundles: approver required");

    const su = await requireStepUpOn(page, { method: "PATCH", path: `/v1/mcp-bundles/${B1}`, kind: "settings_relax" });
    const details = page.getByRole("form", { name: "Bundle details" });
    await details.getByLabel("Approver for dangerous tools", { exact: true }).selectOption(ADA);
    await details.getByRole("button", { name: "Save details" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ description: "Read the repositories", approverUserId: ADA });

    await form.getByLabel("Grant to", { exact: true }).selectOption("role");
    await form.getByLabel("Role", { exact: true }).selectOption(ROLE);
    await form.getByLabel("Up to", { exact: true }).selectOption("dangerous");
    await form.getByRole("button", { name: "Grant" }).click();
    await expect(held.getByRole("row").filter({ hasText: "Reviewers (role)" })).toContainText("All tools, dangerous ones with approval");
    expect(sent(calls, "POST", `/v1/mcp-bundles/${B1}/grants`).at(-1)).toEqual({ roleId: ROLE, maxTier: "dangerous" });

    // revoke: the confirmation names the grantee and what they lose
    await held.getByRole("button", { name: "Revoke bo@example.test's grant of repo-readers" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke bo@example.test's grant of repo-readers?" });
    await expect(dialog).toContainText("bo@example.test loses these tools from their next call");
    await expectAxeClean(page, "MCP bundles: revoke dialog");
    await dialog.getByRole("button", { name: "Revoke" }).click();
    await expect(held.getByRole("row").filter({ hasText: "bo@example.test" })).toHaveCount(0);
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/v1/mcp-bundles/${B1}/grants/f0000000-0000-4000-8000-000000000001`)).toBe(true);

    // archive: every grant confers nothing from then on
    await page.getByRole("button", { name: "Archive bundle repo-readers" }).click();
    const archive = page.getByRole("dialog", { name: "Archive bundle repo-readers?" });
    await expect(archive).toContainText("Every grant of it confers nothing from then on.");
    await archive.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText(/^Archived /).first()).toBeVisible();
    await expect(page.getByRole("form", { name: "Grant this bundle" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Change tools" })).toHaveCount(0);
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/v1/mcp-bundles/${B1}`)).toBe(true);
  });
});
