/**
 * ADR-0226 (P2 batch A) — the one list control on the governance and Shadow AI lists, against a mocked gateway that
 * implements the list contract (limit, cursor or offset, sort and dir, count) and the Excel export route. Three lists
 * stand for the batch: the vendor registry, the SoD override requests and the decision-regression runs.
 *
 *  - page sizes: it starts at 10, says "1–10 of N", pages with Next and Previous, and a new size asks the server;
 *  - a header click asks the server for that sort and direction, and the header carries aria-sort;
 *  - the gear hides an optional column and shows another; the status column cannot be hidden;
 *  - Download Excel asks for the columns on screen, in screen order, with the same sort;
 *  - axe (WCAG 2.x A/AA) clean in light and dark.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

type Json = Record<string, unknown>;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ME = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "ada@example.test", displayName: "Ada Admin" } };
const T0 = Date.parse("2026-10-01T00:00:00Z");
const at = (i: number) => new Date(T0 - i * 3_600_000).toISOString();
const id = (prefix: string, i: number) => `${prefix}-0000-4000-8000-${String(i).padStart(12, "0")}`;

const VENDORS = Array.from({ length: 37 }, (_, i) => ({
  id: id("aaaaaaaa", i),
  name: `Vendor ${String((i * 7) % 37).padStart(2, "0")}`,
  description: "Credit-limit-increase assistant supplier",
  category: ["model_provider", "ai_feature_vendor", "data_processor", "integration"][i % 4],
  ownerUserId: "u-admin",
  ownerName: i % 2 ? "Ada Admin" : "Morgan Reyes",
  linkedCustomProviderIds: [],
  linkedAgentProviders: [],
  packAttestations: [],
  status: ["proposed", "under_assessment", "approved", "rejected"][i % 4],
  workflowInstanceId: null,
  decidedAt: null,
  retiredReason: null,
  createdAt: at(i),
}));
const OVERRIDES = Array.from({ length: 23 }, (_, i) => ({
  id: id("bbbbbbbb", i),
  ruleId: "r1",
  ruleName: "Approver cannot also deploy",
  mintKind: "agent_grant",
  label: `Request ${String((i * 5) % 23).padStart(2, "0")} for Dana Developer`,
  conflict: {},
  requestedBy: { userId: "u-admin", name: "Ada Admin" },
  approvalId: null,
  status: ["pending", "approved", "denied"][i % 3],
  decidedBy: null,
  decidedAt: null,
  minted: null,
  createdAt: at(i),
}));
const REG_RUNS = Array.from({ length: 52 }, (_, i) => ({
  id: id("cccccccc", i),
  trigger: ["ci", "preview", "activation"][i % 3],
  subject: ["review_policy", "required_tests", "intake_template"][i % 3],
  candidateDigest: `digest${i}`.padEnd(16, "0"),
  baselineDigest: null,
  cases: 12,
  changed: i % 5,
  entries: [],
  createdAt: at(i),
  createdByName: "Avery Approver",
  expiresAt: null,
}));

const LISTS: Record<string, { rows: Json[]; key: string; field: Record<string, string>; keyset: string }> = {
  "/v1/vendors": { rows: VENDORS, key: "vendors", keyset: "created", field: { name: "name", status: "status", category: "category", owner: "ownerName", created: "createdAt", decided: "decidedAt" } },
  "/v1/sod/overrides": { rows: OVERRIDES, key: "overrides", keyset: "when", field: { label: "label", rule: "ruleName", kind: "mintKind", status: "status", when: "createdAt" } },
  "/v1/governance/decision-regression/runs": { rows: REG_RUNS, key: "runs", keyset: "at", field: { at: "createdAt", subject: "subject", trigger: "trigger", changed: "changed", by: "createdByName" } },
};

function contract(endpoint: string, q: URLSearchParams) {
  const list = LISTS[endpoint]!;
  const sort = q.get("sort") ?? list.keyset;
  const dir = q.get("dir") === "asc" ? 1 : -1;
  const f = list.field[sort] ?? "createdAt";
  const rows = [...list.rows].sort((a, b) => {
    const x = a[f] as string | number | null;
    const y = b[f] as string | number | null;
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
      return json(route, { [LISTS[p]!.key]: LISTS[p]!.rows.slice(0, 200) });
    }
    if (p === "/v1/sod/rules") return json(route, { rules: [], notes: { enforcement: "" } });
    if (p === "/v1/compliance/packs") return json(route, { packs: [] });
    if (p === "/v1/custom-providers" || p === "/v1/model-providers/custom") return json(route, { providers: [] });
    if (p === "/v1/governance/decision-regression/cases") return json(route, { cases: [], versions: {}, outcomeFields: [] });
    if (p === "/v1/org/settings") return json(route, { settings: {} });
    if (p === "/v1/users") return json(route, { users: [] });
    if (p === "/v1/agents") return json(route, { agents: [] });
    return json(route, {});
  });
  return cap;
}

const PAGES = [
  { name: "the vendor registry", path: "/ui/admin/vendors", listId: "vendors", endpoint: "/v1/vendors", noun: "vendors", exact: 37, hide: "Owner", hideId: "owner", optional: "Decided", optionalId: "decided", required: "Status", sortHeader: "Vendor", sortId: "name" },
  { name: "the SoD override requests", path: "/ui/admin/sod", listId: "sod-overrides", endpoint: "/v1/sod/overrides", noun: "override requests", exact: 23, hide: "Mint", hideId: "kind", optional: "Requested by", optionalId: "requester", required: "Status", sortHeader: "Request", sortId: "label" },
  { name: "the decision-regression runs", path: "/ui/admin/governance/decision-regression", listId: "decision-regression-runs", endpoint: "/v1/governance/decision-regression/runs", noun: "regression runs", exact: 52, hide: "By", hideId: "by", optional: "Body digest", optionalId: "digest", required: "Changed outcomes", sortHeader: "Change to", sortId: "subject" },
] as const;

const lastList = (cap: Capture, endpoint: string) => [...cap.lists].reverse().find((u) => u.pathname === endpoint)!;

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
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
    const list = (page: Page) => page.locator(`[data-list="${P.listId}"]`);
    const status = (page: Page) => list(page).getByTestId("list-status");
    const headers = async (page: Page) =>
      (await list(page).locator("table thead th").allInnerTexts()).map((t) => t.replace(/[▲▼]/g, "").trim()).filter(Boolean);

    test("starts at 10 with the true total, pages on the server, and a new size asks for it", async ({ page }) => {
      const cap = await mockApi(page);
      await page.goto(P.path);
      await expect(status(page)).toHaveText(`1–10 of ${P.exact}`);
      expect(lastList(cap, P.endpoint).searchParams.get("limit")).toBe("10");
      expect(lastList(cap, P.endpoint).searchParams.get("count")).toBe("exact");
      await expect(list(page).locator("tbody tr")).toHaveCount(10);
      await list(page).getByRole("button", { name: "Next", exact: true }).click();
      await expect(status(page)).toHaveText(`11–20 of ${P.exact}`);
      expect(lastList(cap, P.endpoint).searchParams.get("cursor")).toBeTruthy();
      await list(page).getByRole("button", { name: "Previous", exact: true }).click();
      await expect(status(page)).toHaveText(`1–10 of ${P.exact}`);
      await list(page).getByLabel("Rows per page").selectOption("50");
      await expect(status(page)).toHaveText(`1–${Math.min(50, P.exact)} of ${P.exact}`);
      expect(lastList(cap, P.endpoint).searchParams.get("limit")).toBe("50");
    });

    test("a header click asks the server for the sort and direction", async ({ page }) => {
      const cap = await mockApi(page);
      await page.goto(P.path);
      await expect(status(page)).toContainText("1–10");
      const th = list(page).locator("thead th").filter({ has: page.getByRole("button", { name: P.sortHeader, exact: true }) });
      await th.getByRole("button", { name: P.sortHeader, exact: true }).click();
      await expect.poll(() => lastList(cap, P.endpoint).searchParams.get("sort")).toBe(P.sortId);
      expect(lastList(cap, P.endpoint).searchParams.get("dir")).toBe("asc");
      await expect(th).toHaveAttribute("aria-sort", "ascending");
      await th.getByRole("button", { name: P.sortHeader, exact: true }).click();
      await expect.poll(() => lastList(cap, P.endpoint).searchParams.get("dir")).toBe("desc");
      await expect(th).toHaveAttribute("aria-sort", "descending");
    });

    test("the gear hides and shows a column, the status column stays, and Excel asks for the screen's columns in order", async ({ page }) => {
      const cap = await mockApi(page);
      await page.goto(P.path);
      await expect(status(page)).toContainText("1–10");
      expect(await headers(page)).toContain(P.hide);
      expect(await headers(page)).not.toContain(P.optional);
      const gear = list(page).getByRole("button", { name: `Choose columns for ${P.noun}` });
      await gear.click();
      const dialog = page.getByRole("dialog", { name: `Columns for ${P.noun}` });
      await expect(dialog).toBeVisible();
      const required = dialog.getByRole("checkbox", { name: new RegExp(`^${P.required}`) });
      await expect(required).toBeDisabled();
      await expect(required).toBeChecked();
      await dialog.getByRole("checkbox", { name: new RegExp(`^${P.hide}`) }).uncheck();
      await dialog.getByRole("checkbox", { name: new RegExp(`^${P.optional}`) }).check();
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(gear).toBeFocused();
      const after = await headers(page);
      expect(after).toContain(P.optional);
      expect(after).not.toContain(P.hide);
      expect(after).toContain(P.required);

      await list(page).getByRole("button", { name: "Download Excel" }).click();
      await expect.poll(() => cap.exports.length).toBe(1);
      const ex = cap.exports[0]!;
      expect(ex.pathname).toBe(`${P.endpoint}/export.xlsx`);
      const cols = ex.searchParams.get("columns")!.split(",");
      expect(cols).toContain(P.optionalId);
      expect(cols).not.toContain(P.hideId);
      expect(cols).toHaveLength(after.filter((h) => h !== "").length);
      expect(ex.searchParams.get("sort")).toBe(lastList(cap, P.endpoint).searchParams.get("sort"));
      await expect(page.getByText("Excel file downloaded")).toBeVisible();
    });

    test("the list and its column picker are axe clean in light and dark", async ({ page }) => {
      await mockApi(page);
      await page.goto(P.path);
      await expect(status(page)).toContainText("1–10");
      await expectAxeClean(page, `${P.name}`);
      await list(page).getByRole("button", { name: `Choose columns for ${P.noun}` }).click();
      await expect(page.getByRole("dialog", { name: `Columns for ${P.noun}` })).toBeVisible();
      const results = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => v.id)).toEqual([]);
    });
  });
}
