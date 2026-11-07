/**
 * ADR-0226 P2 batch C — the one list control on three of the workflows, engines, cost and operations lists
 * (Change requests, Cost events, Data-key attestation history), against a mocked gateway that implements the list
 * contract and the Excel export route:
 *
 *  - page size 10 by default, then 50, remembered per list;
 *  - a header click asks the server for that sort and direction;
 *  - the gear hides an optional column, a required one cannot be hidden;
 *  - Download Excel asks for the columns on screen, in screen order, with the same sort;
 *  - axe (WCAG 2.x A/AA) clean in light and dark.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

type Json = Record<string, unknown>;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ME = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "ada@example.test", displayName: "Ada Admin" } };
const T0 = Date.parse("2026-10-01T00:00:00Z");
const at = (i: number) => new Date(T0 - i * 60_000).toISOString();
const id = (prefix: string, i: number) => `${prefix}-0000-4000-8000-${String(i).padStart(12, "0")}`;

const WORKFLOWS = Array.from({ length: 73 }, (_, i) => ({
  id: id("33333333", i),
  status: ["running", "completed", "aborted"][i % 3],
  createdAt: at(i),
  updatedAt: at(i),
  projectId: null,
  change: { description: `Change request ${String(i).padStart(3, "0")}`, changeType: "feature", environment: "staging" },
}));
const COST_EVENTS = Array.from({ length: 64 }, (_, i) => ({
  id: id("44444444", i),
  at: at(i),
  userId: "u-admin",
  userName: "Ada Admin",
  technique: ["model_routing", "prompt_caching"][i % 2],
  objectType: "agent",
  estimationBasis: "estimated",
  estimatedTokensSaved: i * 10,
  estimatedCostSavedUsd: i / 100,
}));
const ATTESTATIONS = Array.from({ length: 23 }, (_, i) => ({
  id: id("55555555", i),
  fingerprint: "fp-demo",
  attestedByUserId: "u-admin",
  attestedByLabel: i % 2 ? "Ada Admin" : "Avery Approver",
  method: "paper_copy",
  locationHint: i % 3 ? `Safe ${i}` : null,
  note: null,
  attestedAt: at(i),
}));

const LISTS: Record<string, { rows: Json[]; key: string; field: Record<string, string>; keyset: string }> = {
  "/v1/workflows/instances": { rows: WORKFLOWS, key: "instances", keyset: "created", field: { change: "change.description", status: "status", type: "change.changeType", created: "createdAt", updated: "updatedAt" } },
  "/v1/cost-events": { rows: COST_EVENTS, key: "events", keyset: "at", field: { at: "at", user: "userName", technique: "technique", tokens: "estimatedTokensSaved", usd: "estimatedCostSavedUsd" } },
  "/v1/security/data-key/attestations": { rows: ATTESTATIONS, key: "attestations", keyset: "at", field: { at: "attestedAt", who: "attestedByLabel", how: "method", where: "locationHint", fp: "fingerprint" } },
};
const pick = (r: Json, path: string) => path.split(".").reduce<unknown>((v, k) => (v as Json | null)?.[k], r) as string | number | null;

function contract(endpoint: string, q: URLSearchParams) {
  const list = LISTS[endpoint]!;
  const sort = q.get("sort") ?? list.keyset;
  const dir = q.get("dir") === "asc" ? 1 : -1;
  const f = list.field[sort] ?? list.field[list.keyset]!;
  const rows = [...list.rows].sort((a, b) => {
    const x = pick(a, f);
    const y = pick(b, f);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * dir;
  });
  const limit = Number(q.get("limit"));
  const start = q.get("cursor") ? Number(atob(q.get("cursor")!)) : Number(q.get("offset") ?? 0);
  const more = start + limit < rows.length;
  const keyset = sort === list.keyset;
  return {
    items: rows.slice(start, start + limit),
    nextCursor: more && keyset ? btoa(String(start + limit)) : null,
    nextOffset: more && !keyset ? start + limit : null,
    total: q.get("count") ? rows.length : null,
    totalIsEstimate: false,
    ...(endpoint === "/v1/workflows/instances" ? { changeTypes: ["feature"], routes: [{ changeType: "feature", templates: ["Standard change"] }] } : {}),
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
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x-regulait-export-truncated": "0", "x-regulait-export-row-limit": "100000" },
        body: Buffer.from("PK\u0003\u0004"),
      });
    }
    if (LISTS[p] && req.method() === "GET") {
      if (url.searchParams.get("sort") || url.searchParams.get("count")) {
        cap.lists.push(url);
        return json(route, contract(p, url.searchParams));
      }
      return json(route, { [LISTS[p]!.key]: LISTS[p]!.rows.slice(0, 100), totals: [] });
    }
    if (p === "/v1/projects") return json(route, { projects: [] });
    if (p === "/v1/users") return json(route, { users: [{ id: "u-admin", email: "ada@example.test", displayName: "Ada Admin", isAdmin: true }] });
    if (p === "/v1/usage-events") return json(route, { events: [], totals: {} });
    if (p === "/v1/security/data-key") return json(route, { configured: true, fingerprint: "fp-demo", recordedFingerprint: "fp-demo", attested: true });
    return json(route, {});
  });
  return cap;
}

const PAGES = [
  { name: "Change requests", path: "/ui/workflows", endpoint: "/v1/workflows/instances", listId: "workflows", noun: "change requests", total: 73, required: "Status", hide: "Type", hideId: "type", sortHeader: "Change", sortId: "change" },
  { name: "Cost events", path: "/ui/admin/optimization", endpoint: "/v1/cost-events", listId: "cost-events", noun: "cost events", total: 64, required: "", hide: "User", hideId: "user", sortHeader: "Technique", sortId: "technique" },
  { name: "Data-key attestations", path: "/ui/admin/data-key", endpoint: "/v1/security/data-key/attestations", listId: "data-key-attestations", noun: "attestations", total: 23, required: "", hide: "Pointer", hideId: "where", sortHeader: "Who", sortId: "who" },
] as const;

const status = (page: Page, listId: string) => page.locator(`[data-list="${listId}"]`).getByTestId("list-status");
const lastList = (cap: Capture, endpoint: string) => [...cap.lists].reverse().find((u) => u.pathname === endpoint)!;
const headers = async (page: Page, listId: string) =>
  (await page.locator(`[data-list="${listId}"] table thead th`).allInnerTexts()).map((t) => t.replace(/[▲▼]/g, "").trim()).filter(Boolean);

async function expectAxeClean(page: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 1000))]);
    }, theme);
    const results = await new AxeBuilder({ page }).include(`[data-list]`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

for (const P of PAGES) {
  test.describe(`list control on ${P.name}`, () => {
    test("starts at 10 rows with a total, pages, and remembers a new size", async ({ page }) => {
      const cap = await mockApi(page);
      await page.goto(P.path);
      await expect(status(page, P.listId)).toHaveText(`1–10 of ${P.total}`);
      expect(lastList(cap, P.endpoint).searchParams.get("limit")).toBe("10");
      await expect(page.locator(`[data-list="${P.listId}"] tbody tr`)).toHaveCount(10);
      await page.locator(`[data-list="${P.listId}"]`).getByRole("button", { name: "Next", exact: true }).click();
      await expect(status(page, P.listId)).toHaveText(`11–20 of ${P.total}`);
      await page.locator(`[data-list="${P.listId}"]`).getByLabel("Rows per page").selectOption("50");
      await expect(status(page, P.listId)).toHaveText(`1–${Math.min(50, P.total)} of ${P.total}`);
      expect(lastList(cap, P.endpoint).searchParams.get("limit")).toBe("50");
      await page.reload();
      await expect(page.locator(`[data-list="${P.listId}"]`).getByLabel("Rows per page")).toHaveValue("50");
    });

    test("a header click asks the server for the sort and direction", async ({ page }) => {
      const cap = await mockApi(page);
      await page.goto(P.path);
      await expect(status(page, P.listId)).toContainText("1–10");
      const th = page.locator(`[data-list="${P.listId}"] thead th`).filter({ has: page.getByRole("button", { name: P.sortHeader, exact: true }) });
      await th.getByRole("button", { name: P.sortHeader, exact: true }).click();
      await expect.poll(() => lastList(cap, P.endpoint).searchParams.get("sort")).toBe(P.sortId);
      expect(lastList(cap, P.endpoint).searchParams.get("dir")).toBe("asc");
      await expect(th).toHaveAttribute("aria-sort", "ascending");
      await th.getByRole("button", { name: P.sortHeader, exact: true }).click();
      await expect.poll(() => lastList(cap, P.endpoint).searchParams.get("dir")).toBe("desc");
    });

    test("the gear hides a column, a required one stays, and Excel asks for the screen's columns in order", async ({ page }) => {
      const cap = await mockApi(page);
      await page.goto(P.path);
      await expect(status(page, P.listId)).toContainText("1–10");
      expect(await headers(page, P.listId)).toContain(P.hide);
      const gear = page.getByRole("button", { name: `Choose columns for ${P.noun}` });
      await gear.click();
      const dialog = page.getByRole("dialog", { name: `Columns for ${P.noun}` });
      await expect(dialog).toBeVisible();
      if (P.required) {
        const required = dialog.getByRole("checkbox", { name: new RegExp(`^${P.required}`) });
        await expect(required).toBeDisabled();
        await expect(required).toBeChecked();
      }
      await dialog.getByRole("checkbox", { name: new RegExp(`^${P.hide}`) }).uncheck();
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(gear).toBeFocused();
      const after = await headers(page, P.listId);
      expect(after).not.toContain(P.hide);

      await page.locator(`[data-list="${P.listId}"]`).getByRole("button", { name: "Download Excel" }).click();
      await expect.poll(() => cap.exports.length).toBe(1);
      const ex = cap.exports[0]!;
      expect(ex.pathname).toBe(`${P.endpoint}/export.xlsx`);
      const cols = ex.searchParams.get("columns")!.split(",");
      expect(cols).not.toContain(P.hideId);
      expect(cols).toHaveLength(after.length);
      expect(ex.searchParams.get("sort")).toBe(lastList(cap, P.endpoint).searchParams.get("sort"));
      await expect(page.getByText("Excel file downloaded")).toBeVisible();
    });

    test("the list and its column picker are axe clean in light and dark", async ({ page }) => {
      await mockApi(page);
      await page.goto(P.path);
      await expect(status(page, P.listId)).toContainText("1–10");
      await expectAxeClean(page, `${P.name} list`);
      await page.getByRole("button", { name: `Choose columns for ${P.noun}` }).click();
      await expect(page.getByRole("dialog", { name: `Columns for ${P.noun}` })).toBeVisible();
      const results = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => v.id)).toEqual([]);
    });
  });
}
