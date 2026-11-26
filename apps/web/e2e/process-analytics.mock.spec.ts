/**
 * Process analytics (ADR-0342), from the browser's side. Every /v1 and /auth call is answered by an in-test mock that
 * follows apps/gateway/src/process-analytics.ts: the four reads' shapes and shared envelope (window, excluded,
 * lastProjectedAt, basis), their strict queries (from, to, templateId, plus limit/offset on the tables and bucket on
 * the heatmap and throughput), null for what was not measured, sparse heatmap cells and throughput periods, and the
 * refresh POST with no body.
 *
 * Covered: the link from Workflow templates, the four cards with "Not measured" and "No visits" for unknowns (never 0),
 * paging the templates table, the never-projected state, a failed read with Retry, a 403, a refresh pass with more to
 * do, filters re-reading with only accepted params, and axe in light and dark. Synthetic names only.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./builder-fixtures";

const NOW = "2026-11-22T12:00:00.000Z";
const BASE = "/v1/process-analytics";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ALLOWED: Record<string, string[]> = {
  templates: ["from", "to", "templateId", "limit", "offset"],
  stages: ["from", "to", "templateId", "limit", "offset"],
  heatmap: ["from", "to", "templateId", "bucket", "limit"],
  throughput: ["from", "to", "templateId", "bucket"],
};

const template = (i: number, ended: boolean) => ({
  templateId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  name: `Sample template ${String(i).padStart(2, "0")}`,
  started: 5,
  ended: ended ? { total: 4, completed: 3, aborted: 1, denied: 0, rolledBack: 0 } : { total: 0, completed: 0, aborted: 0, denied: 0, rolledBack: 0 },
  open: ended ? 1 : 5,
  cycleTimeMs: ended ? { p50: 3_600_000, p90: 7_200_000, mean: 4_000_000 } : { p50: null, p90: null, mean: null },
  reworkRate: ended ? 0.25 : null,
});
// 55 templates, so the table pages; the first has ended instances, the second none
const TEMPLATES = Array.from({ length: 55 }, (_, i) => template(i + 1, i !== 1));

interface Opts {
  neverProjected?: boolean;
  failTemplates?: boolean;
  forbidden?: boolean;
}

async function mockApi(page: Page, opts: Opts = {}) {
  const calls: Array<{ method: string; path: string; query: URLSearchParams; body: string | null }> = [];
  const st = { lastProjectedAt: opts.neverProjected ? null : NOW, failTemplates: opts.failTemplates === true };
  const env = (q: URLSearchParams) => ({
    window: { from: q.get("from"), to: q.get("to") },
    scope: { kind: "org", id: null, templateId: q.get("templateId") },
    excluded: { diverged: 2, tooLong: 1 },
    lastProjectedAt: st.lastProjectedAt,
    basis: "Projected from the workflow event history; periods are UTC.",
  });
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    calls.push({ method, path: p, query: url.searchParams, body: req.postData() });
    if (p === "/auth/me" || p === "/v1/me") {
      return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    }
    if (p === "/v1/workflows/templates") {
      const definition = { workflow: "sample", stages: [{ id: "plan", type: "planning" }, { id: "approval", type: "human_approval", approvers: ["requesting_user"] }] };
      return json(route, { templates: TEMPLATES.slice(0, 2).map((t) => ({ id: t.templateId, name: t.name, definition, retiredAt: null, retiredReason: null, createdAt: NOW })) });
    }
    if (p === "/v1/workflows/assignment-rules") return json(route, { rules: [] });
    if (p === "/v1/git/connections") return json(route, { connections: [] });
    if (p === "/v1/compliance/profiles") return json(route, { profiles: [] });
    if (p === "/v1/workflows/template-gallery") return json(route, { entries: [], profiles: [] });
    const m = p.match(/^\/v1\/process-analytics\/(templates|stages|heatmap|throughput)$/);
    if (m && method === "GET") {
      const kind = m[1]!;
      for (const k of url.searchParams.keys()) if (!ALLOWED[kind]!.includes(k)) return json(route, { error: "invalid_query", detail: k }, 400);
      if (opts.forbidden) return json(route, { error: "forbidden", detail: "only an administrator may read org-wide process analytics" }, 403);
      const q = url.searchParams;
      if (kind === "templates") {
        // fails until the test flips it, so the client's own retries cannot turn the failure into data
        if (st.failTemplates) return json(route, { error: "internal_error" }, 500);
        const rows = opts.neverProjected ? [] : TEMPLATES;
        const limit = Number(q.get("limit") ?? 50);
        const offset = Number(q.get("offset") ?? 0);
        return json(route, { ...env(q), total: rows.length, limit, offset, templates: rows.slice(offset, offset + limit) });
      }
      if (kind === "stages") {
        const stages = opts.neverProjected
          ? []
          : [
              { rank: 1, stageId: "approval", stageType: "approval", visits: 6, durationMs: { p50: 1_800_000, p90: 5_400_000 }, waitMs: { total: 9_000_000, mean: 1_500_000 }, workMs: { total: 600_000, mean: 100_000 }, waitShare: 0.9, reworked: 1, reworkRate: 1 / 6, open: 2, oldestOpenSince: "2026-11-20T08:00:00.000Z" },
              { rank: 2, stageId: "plan", stageType: "plan", visits: 0, durationMs: { p50: null, p90: null }, waitMs: { total: 0, mean: null }, workMs: { total: 0, mean: null }, waitShare: null, reworked: 0, reworkRate: null, open: 0, oldestOpenSince: null },
            ];
        return json(route, { ...env(q), rankedBy: "wait_total", total: stages.length, limit: 50, offset: 0, stages });
      }
      if (kind === "heatmap") {
        const periods = opts.neverProjected ? [] : ["2026-11-09T00:00:00.000Z", "2026-11-16T00:00:00.000Z"];
        const stages = opts.neverProjected ? [] : [{ stageId: "approval", cells: [{ period: "2026-11-16T00:00:00.000Z", visits: 6, medianDurationMs: 1_800_000, waitMs: 9_000_000 }] }];
        return json(route, { ...env(q), bucket: q.get("bucket") ?? "week", periods, stages });
      }
      const periods = opts.neverProjected ? [] : [{ period: "2026-11-16T00:00:00.000Z", started: 5, completed: 3, aborted: 1, denied: 0, rolledBack: 0 }];
      return json(route, { ...env(q), bucket: q.get("bucket") ?? "week", periods });
    }
    if (p === `${BASE}/refresh` && method === "POST") {
      st.lastProjectedAt = NOW;
      return json(route, { projected: 500, diverged: 2, tooLong: 1, remaining: true });
    }
    return json(route, {});
  });
  return { calls, st };
}

const card = (page: Page, title: string) => page.locator("[data-rg-card]").filter({ has: page.getByText(title, { exact: true }) });
const reads = (calls: Array<{ method: string; path: string; query: URLSearchParams }>, kind: string) => calls.filter((c) => c.method === "GET" && c.path === `${BASE}/${kind}`);

test.describe("process analytics", () => {
  test("is reached from Workflow templates and shows unknowns as not measured, never zero", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/workflow-templates");
    await page.getByRole("link", { name: "Process analytics" }).click();
    await expect(page).toHaveURL(/\/ui\/admin\/process-analytics$/);
    await expect(page.getByRole("heading", { name: "Process analytics" })).toBeVisible();

    await expect(page.getByText(/Figures as of/)).toBeVisible();
    await expect(page.getByText("3 instances left out: 2 whose history diverged, 1 too long to project.", { exact: false })).toBeVisible();

    const templates = card(page, "Templates");
    const ended = templates.getByRole("row").filter({ hasText: "Sample template 01" });
    await expect(ended).toContainText("4: 3 completed, 1 aborted, 0 denied, 0 rolled back");
    await expect(ended).toContainText("median 1h 0m, p90 2h 0m");
    await expect(ended).toContainText("25%");
    const none = templates.getByRole("row").filter({ hasText: "Sample template 02" });
    await expect(none).toContainText("None ended");
    await expect(none.getByText("Not measured")).toHaveCount(2);

    const stages = card(page, "Bottlenecks");
    await expect(stages.getByRole("row").filter({ hasText: "approval" }).first()).toContainText("(90% of all wait)");
    const plan = stages.getByRole("row").filter({ hasText: "plan" });
    await expect(plan.getByText("Not measured")).toHaveCount(2);
    await expect(plan).not.toContainText("0%");

    const heat = card(page, "Wait by stage and period");
    await expect(heat.getByRole("cell", { name: "No visits" })).toBeVisible();
    await expect(heat.getByRole("cell", { name: /2h 30m wait/ })).toContainText("6 visits, median 30m 0s");

    await expect(card(page, "Throughput").getByRole("row").filter({ hasText: "16 Nov 2026" })).toContainText("5");
    await expectAxeClean(page, "process analytics");
  });

  test("pages the templates table and re-reads with only accepted params when a filter changes", async ({ page }) => {
    const { calls } = await mockApi(page);
    await page.goto("/ui/admin/process-analytics");
    const templates = card(page, "Templates");
    await expect(templates.getByText("1–50 of 55")).toBeVisible();
    await templates.getByRole("button", { name: "Next templates" }).click();
    await expect(templates.getByText("51–55 of 55")).toBeVisible();
    await expect(templates.getByRole("row").filter({ hasText: "Sample template 55" })).toBeVisible();
    expect(reads(calls, "templates").at(-1)!.query.get("offset")).toBe("50");

    await page.getByLabel("Template", { exact: true }).selectOption({ label: "Sample template 01" });
    await page.getByLabel("Period", { exact: true }).selectOption({ label: "Day" });
    await expect(templates.getByText("1–50 of 55")).toBeVisible();
    const last = reads(calls, "templates").at(-1)!;
    expect(last.query.get("templateId")).toBe(TEMPLATES[0]!.templateId);
    expect(last.query.get("offset")).toBe("0");
    await expect.poll(() => reads(calls, "heatmap").at(-1)?.query.get("bucket")).toBe("day");
    await page.getByLabel("Window", { exact: true }).selectOption({ label: "Last 7 days" });
    await expect.poll(() => {
      const q = reads(calls, "throughput").at(-1)!.query;
      return new Date(q.get("to")!).getTime() - new Date(q.get("from")!).getTime();
    }).toBe(7 * 86_400_000);
  });

  test("says when nothing has been projected yet, and a refresh pass reports that more remain", async ({ page }) => {
    const { calls } = await mockApi(page, { neverProjected: true });
    await page.goto("/ui/admin/process-analytics");
    await expect(page.getByText("Not projected yet", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Nothing here means zero/)).toBeVisible();
    await expectAxeClean(page, "process analytics: never projected");

    await page.getByRole("button", { name: "Refresh now" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Projected 500 instances" })).toContainText("More remain: run Refresh now again");
    const post = calls.find((c) => c.method === "POST" && c.path === `${BASE}/refresh`)!;
    expect(post.body === null || post.body === "{}" || post.body === "").toBe(true);
  });

  test("a failed read is an error with Retry, not an empty table", async ({ page }) => {
    const { st } = await mockApi(page, { failTemplates: true });
    await page.goto("/ui/admin/process-analytics");
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("No workflow instances in this window")).toHaveCount(0);
    st.failTemplates = false;
    await page.getByRole("button", { name: "Retry" }).first().click();
    await expect(card(page, "Templates").getByRole("row").filter({ hasText: "Sample template 01" })).toBeVisible();
  });

  test("a refused read says so", async ({ page }) => {
    await mockApi(page, { forbidden: true });
    await page.goto("/ui/admin/process-analytics");
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Not measured|No visits/)).toHaveCount(0);
  });
});
