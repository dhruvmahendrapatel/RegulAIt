/**
 * ADR-0226 P2 batch B — the shared list control on the identity-and-access lists (Teams, the agent catalog, the
 * credential inventory and the licence verification trail), against a mocked gateway that implements the list
 * contract and the Excel export route:
 *
 *  - the page starts at 10 rows with "1–10 of N", Next moves on, and 50 asks the server for 50;
 *  - a header click asks the server for that sort and direction;
 *  - the gear hides an optional column; a status or warning column cannot be hidden;
 *  - Download Excel asks for the columns on screen, in screen order, with the same filters and sort;
 *  - axe (WCAG 2.x A/AA) clean in light and dark, with the picker open too.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

type Json = Record<string, unknown>;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ME = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "ada@example.test", displayName: "Ada Admin" } };
const T0 = Date.parse("2026-10-01T00:00:00Z");
const at = (i: number) => new Date(T0 - i * 60_000).toISOString();
const uuid = (p: string, i: number) => `${p}-0000-4000-8000-${String(i).padStart(12, "0")}`;

const TEAMS = Array.from({ length: 37 }, (_, i) => ({
  id: uuid("33333333", i),
  name: `team-${String(i + 1).padStart(2, "0")}`,
  defaultClassifications: i % 3 ? null : ["pii"],
  createdAt: at(i),
  memberCount: i % 4,
  members: [{ userId: "u-1", name: "Morgan Reyes" }, { userId: "u-2", name: "Dana Developer" }, { userId: "u-3", name: "Avery Approver" }].slice(0, i % 4),
}));
const AGENTS = Array.from({ length: 31 }, (_, i) => ({
  id: uuid("44444444", i),
  name: i === 0 ? "Credit-limit-increase assistant" : `Agent ${String(i).padStart(2, "0")}`,
  provider: "mock",
  tier: (i % 3) + 1,
  model: `model-${i % 5}`,
  enabled: i % 6 !== 0,
  costPerMTokIn: i % 2 ? 1 : null,
  costPerMTokOut: i % 2 ? 2 : null,
  systemPrompt: null,
  createdAt: at(i),
}));
const CREDENTIALS = Array.from({ length: 28 }, (_, i) => ({
  id: `api_key:${uuid("55555555", i)}`,
  type: "api_key",
  typeLabel: "API key",
  name: `key-${String(i).padStart(2, "0")}`,
  manageAt: "/admin/users",
  ownerUserId: "u-1",
  ownerName: "Jordan Owner",
  ownerKind: "owner",
  ownerDisabled: false,
  scope: "the holder's entitlements",
  status: "active",
  createdAt: at(i),
  lastUsedAt: null,
  lastUsedSignal: "recorded",
  expiresAt: null,
  expirySignal: "recorded",
  secretSetAt: null,
  rotationSignal: "recorded",
  ageSinceRotationDays: i,
  linkedAgents: [],
  linkedProjects: [],
  flags: i % 2 ? ["never_expires"] : [],
  flagReasons: {},
}));
const INVENTORY = {
  generatedAt: at(0),
  unusedDays: 90,
  alerting: true,
  linkWindowDays: 90,
  ledgerWindowDays: 90,
  types: [{ type: "api_key", label: "API key", manageAt: "/admin/users", lastUsed: "recorded", lastUsedNote: "", overScoped: null, count: 28 }],
  notStored: [],
  flagLabels: { never_expires: "never expires", past_expiry: "past expiry", unused: "unused", owner_deactivated: "owner deactivated", over_scoped: "over-scoped" },
  counts: { total: 28, flagged: 14, byFlag: { never_expires: 14, past_expiry: 0, unused: 0, owner_deactivated: 0, over_scoped: 0 } },
  alertPreview: { episodes: 1, credentials: 14 },
};
const VERIFICATIONS = Array.from({ length: 45 }, (_, i) => ({
  id: uuid("66666666", i),
  at: at(i),
  trigger: "manual",
  ok: i % 4 !== 0,
  state: "valid",
  ruleId: `licence-rule-${String(i).padStart(2, "0")}`,
  reason: "checked",
  signingKeyId: null,
}));

const allow = { allowed: true, ruleId: "licence-valid", reason: "a valid licence" };
const LICENCE_STATUS = {
  licensed: true,
  state: "valid",
  reason: "a valid licence is installed",
  tenant: "team-17",
  tier: "enterprise",
  deploymentMode: "hosted",
  expiresAt: "2027-10-01T00:00:00.000Z",
  graceEndsAt: null,
  daysRemaining: 336,
  hardStopOnExpiry: false,
  seats: { active: 3, cap: 10, remaining: 7, canProvision: true, ruleId: "seat-cap", reason: "under the cap", definition: "active users" },
  features: {},
  actionClasses: { read: allow, governance: allow, expansion: allow },
  inventory: [],
  keyring: { dir: "/etc/regulait/licence-keys", pinnedKeyIds: [] },
  lastVerifiedAt: at(0),
  schedulerPresent: false,
  phoneHome: false,
  enforcementPointsWired: [],
  posture: "",
  note: "",
};

const LISTS: Record<string, { rows: Json[]; key: string; field: Record<string, string>; extra?: Json }> = {
  "/v1/teams": { rows: TEAMS, key: "teams", field: { name: "name", memberCount: "memberCount", created: "createdAt" } },
  "/v1/agents": { rows: AGENTS, key: "agents", field: { name: "name", provider: "provider", tier: "tier", model: "model", price: "costPerMTokIn", enabled: "enabled", created: "createdAt" } },
  "/v1/admin/credentials": { rows: CREDENTIALS, key: "credentials", field: { name: "name", created: "createdAt", rotation: "ageSinceRotationDays", flags: "flags.length", owner: "ownerName", type: "typeLabel", status: "status", scope: "scope", used: "lastUsedAt", expires: "expiresAt" }, extra: INVENTORY },
  "/v1/licenses/verifications": { rows: VERIFICATIONS, key: "verifications", field: { at: "at", trigger: "trigger", ok: "ok", state: "state", rule: "ruleId" }, extra: { schedulerPresent: false } },
};
const pick = (r: Json, p: string) => p.split(".").reduce<unknown>((v, k) => (v as Json | null)?.[k], r) as string | number | boolean | null;

function contract(endpoint: string, q: URLSearchParams) {
  const list = LISTS[endpoint]!;
  const sort = q.get("sort")!;
  const dir = q.get("dir") === "asc" ? 1 : -1;
  const f = list.field[sort];
  if (!f) throw new Error(`mock: no field for sort "${sort}" on ${endpoint}`);
  const rows = [...list.rows].sort((a, b) => {
    const x = pick(a, f);
    const y = pick(b, f);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * dir;
  });
  const limit = Number(q.get("limit"));
  const start = Number(q.get("offset") ?? 0);
  const more = start + limit < rows.length;
  return { ...list.extra, items: rows.slice(start, start + limit), nextCursor: null, nextOffset: more ? start + limit : null, total: q.get("count") ? rows.length : null, totalIsEstimate: false };
}

interface Capture {
  lists: URL[];
  exports: URL[];
}

async function mockApi(page: Page): Promise<Capture> {
  const cap: Capture = { lists: [], exports: [] };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    if (p.endsWith("/export.xlsx")) {
      cap.exports.push(url);
      return route.fulfill({
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x-regulait-export-truncated": "0", "x-regulait-export-row-limit": "100000" },
        body: Buffer.from("PK\u0003\u0004"),
      });
    }
    if (LISTS[p] && req.method() === "GET") {
      if (url.searchParams.get("sort")) {
        cap.lists.push(url);
        return json(route, contract(p, url.searchParams));
      }
      return json(route, { ...LISTS[p]!.extra, [LISTS[p]!.key]: LISTS[p]!.rows });
    }
    if (p === "/v1/licenses/status") return json(route, LICENCE_STATUS);
    if (p === "/v1/licenses") return json(route, { licenses: [] });
    if (p === "/v1/users") return json(route, { users: [] });
    if (p === "/v1/compliance-profiles") return json(route, { profiles: [] });
    return json(route, {});
  });
  return cap;
}

const PAGES = [
  { name: "Teams", path: "/ui/admin/teams", endpoint: "/v1/teams", listId: "teams", noun: "teams", total: 37, hide: "Member names", hideId: "members", optional: "Created", optionalId: "created", sortHeader: "Members", sortId: "memberCount", required: null },
  { name: "Agents", path: "/ui/admin/agents", endpoint: "/v1/agents", listId: "agents", noun: "agents", total: 31, hide: "Model", hideId: "model", optional: "System prompt", optionalId: "prompt", sortHeader: "Tier", sortId: "tier", required: "Status" },
  { name: "Credentials", path: "/ui/admin/credentials", endpoint: "/v1/admin/credentials", listId: "credentials", noun: "credentials", total: 28, hide: "Owner / creator", hideId: "owner", optional: "Scope", optionalId: "scope", sortHeader: "Credential", sortId: "name", required: "Flags" },
  { name: "Licensing", path: "/ui/admin/licensing", endpoint: "/v1/licenses/verifications", listId: "licence-verifications", noun: "verifications", total: 45, hide: "Reason", hideId: "reason", optional: null, optionalId: null, sortHeader: "Rule", sortId: "rule", required: "Status" },
] as const;

const lastList = (cap: Capture, endpoint: string) => [...cap.lists].reverse().find((u) => u.pathname === endpoint)!;

async function expectAxeClean(page: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 1000))]);
    }, theme);
    const results = await new AxeBuilder({ page }).include("[data-list]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

for (const P of PAGES) {
  test.describe(`list control on ${P.name}`, () => {
    test("page size, sort request, gear, Excel request and axe", async ({ page }) => {
      const cap = await mockApi(page);
      await page.goto(P.path);
      const list = page.locator(`[data-list="${P.listId}"]`);
      const status = list.getByTestId("list-status");
      await expect(status).toHaveText(`1–10 of ${P.total}`);
      expect(lastList(cap, P.endpoint).searchParams.get("limit")).toBe("10");
      await expect(list.locator("tbody tr")).toHaveCount(10);
      await list.getByRole("button", { name: "Next", exact: true }).click();
      await expect(status).toHaveText(`11–20 of ${P.total}`);
      expect(lastList(cap, P.endpoint).searchParams.get("offset")).toBe("10");
      await list.getByLabel("Rows per page").selectOption("50");
      await expect(status).toHaveText(`1–${P.total} of ${P.total}`);
      expect(lastList(cap, P.endpoint).searchParams.get("limit")).toBe("50");

      // a header click asks the server for the sort and direction
      const th = list.locator("thead th").filter({ has: page.getByRole("button", { name: P.sortHeader, exact: true }) });
      await th.getByRole("button", { name: P.sortHeader, exact: true }).click();
      await expect.poll(() => lastList(cap, P.endpoint).searchParams.get("sort")).toBe(P.sortId);
      const firstDir = lastList(cap, P.endpoint).searchParams.get("dir");
      await th.getByRole("button", { name: P.sortHeader, exact: true }).click();
      await expect.poll(() => lastList(cap, P.endpoint).searchParams.get("dir")).not.toBe(firstDir);

      await expectAxeClean(page, `${P.name} list`);

      // the gear: hide a column, show an optional one, a required one cannot be hidden
      const gear = list.getByRole("button", { name: `Choose columns for ${P.noun}` });
      await gear.click();
      const dialog = page.getByRole("dialog", { name: `Columns for ${P.noun}` });
      await expect(dialog).toBeVisible();
      if (P.required) {
        const req = dialog.getByRole("checkbox", { name: new RegExp(`^${P.required}`) });
        await expect(req).toBeDisabled();
        await expect(req).toBeChecked();
      }
      await dialog.getByRole("checkbox", { name: new RegExp(`^${P.hide.replace("/", "\\/")}`) }).uncheck();
      if (P.optional) await dialog.getByRole("checkbox", { name: new RegExp(`^${P.optional}`) }).check();
      await expectAxeClean(page, `${P.name} column picker`);
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(gear).toBeFocused();
      const heads = (await list.locator("thead th").allInnerTexts()).map((t) => t.replace(/[▲▼]/g, "").trim());
      expect(heads).not.toContain(P.hide);
      if (P.optional) expect(heads).toContain(P.optional);

      // Excel: the screen's columns in screen order, with the same sort
      await list.getByRole("button", { name: "Download Excel" }).click();
      await expect.poll(() => cap.exports.length).toBe(1);
      const ex = cap.exports[0]!;
      expect(ex.pathname).toBe(`${P.endpoint}/export.xlsx`);
      const cols = ex.searchParams.get("columns")!.split(",");
      expect(cols).not.toContain(P.hideId);
      if (P.optionalId) expect(cols).toContain(P.optionalId);
      expect(ex.searchParams.get("sort")).toBe(P.sortId);
      expect(ex.searchParams.get("dir")).toBe(lastList(cap, P.endpoint).searchParams.get("dir"));
      await expect(page.getByText("Excel file downloaded")).toBeVisible();
    });
  });
}
