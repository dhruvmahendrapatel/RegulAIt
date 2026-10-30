/**
 * ADR-0219 — the one list control on Runs, Incidents and Users, against a mocked gateway that implements the list
 * contract (limit, cursor or offset, sort and dir, count) and the Excel export route:
 *
 *  - page sizes 10, 50, 100 and All, with All loading 500-row chunks as the list scrolls (and by its button);
 *  - the size is remembered per list after a reload;
 *  - a header click asks the server for that sort (sort and dir), and the header carries aria-sort;
 *  - the gear hides and shows an optional column, a required column cannot be hidden, and the choice persists;
 *  - Download Excel asks for the columns on screen, in screen order, with the same filters and sort;
 *  - Refresh refetches the page;
 *  - all of it by keyboard alone, with focus back on the gear when the picker closes;
 *  - axe (WCAG 2.x A/AA) clean in light and dark, with the picker open too.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { activate, escapeToTrigger, tabTo } from "./keyboard-audit";

type Json = Record<string, unknown>;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ME = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "ada@example.test", displayName: "Ada Admin" } };
const T0 = Date.parse("2026-10-01T00:00:00Z");
const at = (i: number) => new Date(T0 - i * 60_000).toISOString();
const STATUSES = ["planned", "running", "completed", "aborted"];

const RUNS = Array.from({ length: 1_284 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  name: `Run ${String(i).padStart(4, "0")}`,
  status: STATUSES[i % 4],
  createdAt: at(i),
  projectId: null,
  state: { nodeStatuses: { a: "done", b: i % 2 ? "done" : "pending" } },
  budget: { measuredSpentUsd: (i % 7) * 0.5, capUsd: i % 3 ? 10 : null },
}));
const INCIDENTS = Array.from({ length: 64 }, (_, i) => ({
  id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
  ref: `INC-${String(i + 1).padStart(5, "0")}`,
  title: `Incident number ${i + 1}`,
  severity: ["low", "medium", "high", "critical"][i % 4],
  status: ["open", "contained", "resolved"][i % 3],
  serious: i % 5 === 0,
  seriousCriteria: [],
  detectionSource: "manual",
  awareAt: at(i),
  ownerUserId: "u-admin",
  ownerName: "Ada Admin",
  useCaseId: null,
  useCaseName: null,
  createdAt: at(i),
  closedAt: null,
  clocks: { total: 0, open: 0, overdue: 0, nextDue: null },
  actions: { open: i % 2, overdue: 0 },
}));
const USERS = Array.from({ length: 23 }, (_, i) => ({
  id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
  email: `person${String(i).padStart(2, "0")}@example.test`,
  displayName: `Person ${String(i).padStart(2, "0")}`,
  username: null,
  isAdmin: i < 2,
  disabledAt: i === 5 ? at(1) : null,
  createdAt: at(100 - i),
  totpEnabled: i % 2 === 0,
  hasPassword: true,
  mustChangePassword: false,
}));

/** the list contract, as the gateway answers it; the mock sorts by the column's own field */
const LISTS: Record<string, { rows: Json[]; key: string; field: Record<string, string>; filter?: (r: Json, q: URLSearchParams) => boolean }> = {
  "/v1/runs": { rows: RUNS, key: "runs", field: { name: "name", status: "status", created: "createdAt", spend: "budget.measuredSpentUsd", cap: "budget.capUsd", project: "projectId", id: "id" }, filter: (r, q) => !q.get("status") || r.status === q.get("status") },
  "/v1/incidents": { rows: INCIDENTS, key: "incidents", field: { ref: "ref", sev: "severity", status: "status", created: "createdAt", aware: "awareAt", uc: "useCaseName", owner: "ownerName", clock: "clocks.open", actions: "actions.open", detection: "detectionSource", closed: "closedAt" }, filter: (r, q) => q.get("status") !== "closed" || r.status === "closed" },
  "/v1/users": { rows: USERS, key: "users", field: { name: "displayName", email: "email", role: "isAdmin", mfa: "totpEnabled", status: "disabledAt", created: "createdAt", username: "username" }, filter: (r, q) => (!q.get("role") || (q.get("role") === "admin") === r.isAdmin) && (!q.get("status") || (q.get("status") === "active") === !r.disabledAt) },
};
const pick = (r: Json, path: string) => path.split(".").reduce<unknown>((v, k) => (v as Json | null)?.[k], r) as string | number | boolean | null;

function contract(endpoint: string, q: URLSearchParams) {
  const list = LISTS[endpoint]!;
  const sort = q.get("sort") ?? "created";
  const dir = q.get("dir") === "asc" ? 1 : -1;
  const f = list.field[sort]!;
  const rows = list.rows
    .filter((r) => list.filter?.(r, q) ?? true)
    .sort((a, b) => {
      const x = pick(a, f);
      const y = pick(b, f);
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * dir;
    });
  const limit = Number(q.get("limit"));
  const start = q.get("cursor") ? Number(atob(q.get("cursor")!)) : Number(q.get("offset") ?? 0);
  const items = rows.slice(start, start + limit);
  const more = start + limit < rows.length;
  const keyset = sort === "created";
  const count = q.get("count");
  const estimate = count === "estimate" && rows.length > 1000;
  return {
    items,
    nextCursor: more && keyset ? btoa(String(start + limit)) : null,
    nextOffset: more && !keyset ? start + limit : null,
    total: count ? (estimate ? 1000 : rows.length) : null,
    totalIsEstimate: estimate,
    ...(endpoint === "/v1/incidents" ? { scope: "all", disclaimer: "" } : {}),
  };
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
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x-regulait-export-truncated": "0", "x-regulait-export-row-limit": "500000" },
        body: Buffer.from("PK\u0003\u0004"),
      });
    }
    if (LISTS[p] && req.method() === "GET") {
      if (url.searchParams.get("sort") || url.searchParams.get("count")) {
        if (!(url.searchParams.get("role") === "admin" && url.searchParams.get("status") === "active")) cap.lists.push(url);
        return json(route, contract(p, url.searchParams));
      }
      return json(route, { [LISTS[p]!.key]: LISTS[p]!.rows.slice(0, 200) });
    }
    if (p === "/v1/projects") return json(route, { projects: [] });
    if (/^\/v1\/users\/[^/]+\/agents$/.test(p)) return json(route, { agents: [], defaultAgentId: null });
    if (p === "/v1/org/settings") return json(route, { settings: { incidentGateMode: "enforce", incidentEvidenceHold: true, incidentClockRegimes: ["eu-ai-act"] } });
    return json(route, {});
  });
  return cap;
}

const PAGES = [
  { name: "Runs", path: "/ui/runs", endpoint: "/v1/runs", noun: "runs", total: "1,000+", exact: 1_284, optional: "Budget cap", optionalId: "cap", hide: "Progress", hideId: "progress", required: "Status", sortHeader: "Run", sortId: "name" },
  { name: "Incidents", path: "/ui/incidents", endpoint: "/v1/incidents", noun: "incidents", total: "64", exact: 64, optional: "Reported", optionalId: "created", hide: "Owner", hideId: "owner", required: "Next clock", sortHeader: "Incident", sortId: "ref" },
  { name: "Users", path: "/ui/admin/users", endpoint: "/v1/users", noun: "users", total: "23", exact: 23, optional: "Username", optionalId: "username", hide: "Sign-in", hideId: "signIn", required: "Status", sortHeader: "Email", sortId: "email" },
] as const;

const status = (page: Page) => page.getByTestId("list-status");
const lastList = (cap: Capture, endpoint: string) => [...cap.lists].reverse().find((u) => u.pathname === endpoint)!;
const headers = async (page: Page) =>
  (await page.locator("[data-list] table thead th").allInnerTexts()).map((t) => t.replace(/[▲▼]/g, "").trim()).filter(Boolean);

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 1000))]);
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

for (const P of PAGES) {
  test.describe(`list control on ${P.name}`, () => {
    test("page sizes 10, 50, 100 and All; All loads 500 at a time; Previous and Next", async ({ page }) => {
      const cap = await mockApi(page);
      await page.goto(P.path);
      await expect(status(page)).toHaveText(`1–10 of ${P.total}`);
      expect(lastList(cap, P.endpoint).searchParams.get("limit")).toBe("10");
      await expect(page.locator("[data-list] tbody tr")).toHaveCount(10);
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(status(page)).toHaveText(`11–20 of ${P.total}`);
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await expect(status(page)).toHaveText(`1–10 of ${P.total}`);
      const size = page.getByLabel("Rows per page");
      for (const n of [50, 100]) {
        await size.selectOption(String(n));
        const shown = Math.min(n, P.exact);
        await expect(status(page)).toHaveText(`1–${shown} of ${shown === P.exact ? P.exact.toLocaleString("en-GB") : P.total}`);
        expect(lastList(cap, P.endpoint).searchParams.get("limit")).toBe(String(n));
      }
      await size.selectOption("all");
      if (P.exact > 500) {
        await expect(status(page)).toHaveText(`Loaded 500 of ${P.total}`);
        expect(lastList(cap, P.endpoint).searchParams.get("limit")).toBe("500");
        // scrolling the end of the list into view loads the next chunk
        await page.getByRole("button", { name: "Load next 500" }).scrollIntoViewIfNeeded();
        await expect(status(page)).toHaveText(`Loaded 1,000 of ${P.total}`);
        // the visible button is the fallback
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.getByRole("button", { name: "Load next 500" }).click();
        await expect(status(page)).toHaveText("Loaded 1,284 of 1,284");
        await expect(page.locator("[data-list] tbody tr")).toHaveCount(1_284);
        const chunks = cap.lists.filter((u) => u.pathname === P.endpoint && u.searchParams.get("limit") === "500");
        expect(chunks.length).toBeGreaterThanOrEqual(3);
        expect(chunks.some((u) => u.searchParams.get("cursor"))).toBe(true);
      } else {
        await expect(status(page)).toHaveText(`Loaded ${P.exact} of ${P.exact}`);
      }
      await expect(page.getByRole("button", { name: "Load next 500" })).toHaveCount(0);
    });

    test("the size is remembered in this browser after a reload", async ({ page }) => {
      const cap = await mockApi(page);
      await page.goto(P.path);
      await page.getByLabel("Rows per page").selectOption("50");
      await expect(status(page)).toContainText("1–");
      expect(await page.evaluate((k) => localStorage.getItem(k), `regulait.list.${P.noun}.size`)).toBe("50");
      await page.reload();
      await expect(page.getByLabel("Rows per page")).toHaveValue("50");
      await expect(status(page)).toContainText("1–");
      expect(lastList(cap, P.endpoint).searchParams.get("limit")).toBe("50");
    });

    test("a header click asks the server for the sort and direction", async ({ page }) => {
      const cap = await mockApi(page);
      await page.goto(P.path);
      await expect(status(page)).toContainText("1–10");
      const th = page.locator("[data-list] thead th").filter({ has: page.getByRole("button", { name: P.sortHeader, exact: true }) });
      await th.getByRole("button", { name: P.sortHeader, exact: true }).click();
      await expect.poll(() => lastList(cap, P.endpoint).searchParams.get("sort")).toBe(P.sortId);
      expect(lastList(cap, P.endpoint).searchParams.get("dir")).toBe("asc");
      await expect(th).toHaveAttribute("aria-sort", "ascending");
      await th.getByRole("button", { name: P.sortHeader, exact: true }).click();
      await expect.poll(() => lastList(cap, P.endpoint).searchParams.get("dir")).toBe("desc");
      await expect(th).toHaveAttribute("aria-sort", "descending");
      // the first row is the server's answer for the whole list, not a re-sort of the page
      const first = contract(P.endpoint, new URLSearchParams({ limit: "10", sort: P.sortId, dir: "desc" })).items[0]!;
      await expect(page.locator("[data-list] tbody tr").first()).toContainText(String(pick(first, LISTS[P.endpoint]!.field[P.sortId]!)));
    });

    test("the gear hides and shows a column; a required one stays; the choice persists; Excel asks for the screen's columns in order", async ({ page }) => {
      const cap = await mockApi(page);
      await page.goto(P.path);
      await expect(status(page)).toContainText("1–10");
      expect(await headers(page)).toContain(P.hide);
      expect(await headers(page)).not.toContain(P.optional);
      const gear = page.getByRole("button", { name: `Choose columns for ${P.noun}` });
      await gear.click();
      const dialog = page.getByRole("dialog", { name: `Columns for ${P.noun}` });
      await expect(dialog).toBeVisible();
      const required = dialog.getByRole("checkbox", { name: new RegExp(`^${P.required}`) });
      await expect(required).toBeDisabled();
      await expect(required).toBeChecked();
      await expect(dialog.getByText(/always shown/).first()).toBeVisible();
      await dialog.getByRole("checkbox", { name: new RegExp(`^${P.hide}`) }).uncheck();
      await dialog.getByRole("checkbox", { name: new RegExp(`^${P.optional}`) }).check();
      // move the optional column to the top
      for (let i = 0; i < 20; i++) {
        const up = dialog.getByRole("button", { name: `Move ${P.optional} up` });
        if ((await up.getAttribute("aria-disabled")) === "true") break;
        await up.click();
      }
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(gear).toBeFocused();
      const after = await headers(page);
      expect(after[0]).toBe(P.optional);
      expect(after).not.toContain(P.hide);
      expect(after).toContain(P.required);

      await page.reload();
      await expect(status(page)).toContainText("1–10");
      expect(await headers(page)).toEqual(after);

      await page.getByRole("button", { name: "Download Excel" }).click();
      await expect.poll(() => cap.exports.length).toBe(1);
      const ex = cap.exports[0]!;
      expect(ex.pathname).toBe(`${P.endpoint}/export.xlsx`);
      const cols = ex.searchParams.get("columns")!.split(",");
      expect(cols[0]).toBe(P.optionalId);
      expect(cols).not.toContain(P.hideId);
      expect(cols).toHaveLength(after.length);
      expect(ex.searchParams.get("sort")).toBe(lastList(cap, P.endpoint).searchParams.get("sort"));
      expect(ex.searchParams.get("dir")).toBe(lastList(cap, P.endpoint).searchParams.get("dir"));
      await expect(page.getByText("Excel file downloaded")).toBeVisible();
    });

    test("Refresh refetches the page", async ({ page }) => {
      const cap = await mockApi(page);
      await page.goto(P.path);
      await expect(status(page)).toContainText("1–10");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(status(page)).toContainText("11–20");
      const before = cap.lists.filter((u) => u.pathname === P.endpoint).length;
      const last = lastList(cap, P.endpoint).search;
      await page.getByRole("button", { name: `Refresh ${P.noun}` }).click();
      await expect.poll(() => cap.lists.filter((u) => u.pathname === P.endpoint).length).toBe(before + 1);
      expect(lastList(cap, P.endpoint).search).toBe(last);
      await expect(status(page)).toContainText("11–20");
    });

    test("every control works from the keyboard alone, and the page is axe clean", async ({ page }) => {
      const cap = await mockApi(page);
      await page.goto(P.path);
      await expect(status(page)).toContainText("1–10");
      await expectAxeClean(page, `${P.name} list`);
      // page size
      const size = page.getByLabel("Rows per page");
      await tabTo(page, size);
      await page.keyboard.press("ArrowDown");
      await expect(size).toHaveValue("50");
      await expect.poll(() => lastList(cap, P.endpoint).searchParams.get("limit")).toBe("50");
      // refresh, with its tip shown on focus
      const refresh = page.getByRole("button", { name: `Refresh ${P.noun}` });
      const n = cap.lists.length;
      await activate(page, refresh);
      await expect(page.getByRole("tooltip", { name: `Refresh ${P.noun}` })).toBeVisible();
      await expect.poll(() => cap.lists.length).toBeGreaterThan(n);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("tooltip", { name: `Refresh ${P.noun}` })).toBeHidden();
      await expect(refresh).toBeFocused();
      // the column picker: Space toggles, Escape closes, focus returns to the gear
      const gear = page.getByRole("button", { name: `Choose columns for ${P.noun}` });
      await activate(page, gear);
      const dialog = page.getByRole("dialog", { name: `Columns for ${P.noun}` });
      await expect(dialog).toBeVisible();
      await expectAxeClean(page, `${P.name} column picker`);
      const optional = dialog.getByRole("checkbox", { name: new RegExp(`^${P.optional}`) });
      await tabTo(page, optional);
      await page.keyboard.press("Space");
      await expect(optional).toBeChecked();
      const up = dialog.getByRole("button", { name: `Move ${P.optional} up` });
      await tabTo(page, up);
      await page.keyboard.press("Enter");
      await expect(up).toBeFocused();
      await escapeToTrigger(page, dialog, gear);
      expect(await headers(page)).toContain(P.optional);
      // sort from the header button
      const sortBtn = page.locator("[data-list] thead").getByRole("button", { name: P.sortHeader, exact: true });
      await activate(page, sortBtn);
      await expect.poll(() => lastList(cap, P.endpoint).searchParams.get("sort")).toBe(P.sortId);
      // Next, then the download
      if (P.exact > 50) {
        await activate(page, page.getByRole("button", { name: "Next", exact: true }));
        await expect(status(page)).toContainText("51–");
      }
      await activate(page, page.getByRole("button", { name: "Download Excel" }));
      await expect.poll(() => cap.exports.length).toBe(1);
      expect(cap.exports[0]!.searchParams.get("columns")!.split(",")).toContain(P.optionalId);
    });
  });
}
