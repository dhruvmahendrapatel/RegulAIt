/**
 * Codex review cards UIS-05, UIS-06 and UIS-08 — the shared list control (DataList, ADR-0226) against a mocked gateway
 * that implements the list contract:
 *
 *  - UIS-05: after a filter change, while the new answer is on its way, the previous rows stay on screen but the list
 *    is aria-busy and its status says "Updating… showing previous results", not the old "1–10 of N";
 *  - UIS-06: the sort and the page live in the address, so opening a row and coming Back lands on the same sort and
 *    page; a restored cursor the server refuses falls back to the first page;
 *  - UIS-08: a page's fixed error sentence keeps the 403, so the list says it is an access refusal and offers no Retry.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

type Json = Record<string, unknown>;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ME = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "ada@example.test", displayName: "Ada Admin" } };
const AUTH_ME = { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
const T0 = Date.parse("2026-10-01T00:00:00Z");
const STATUSES = ["planned", "running", "completed", "aborted"];
const RUNS: Json[] = Array.from({ length: 64 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  name: `Run ${String(i).padStart(4, "0")}`,
  status: STATUSES[i % 4],
  createdAt: new Date(T0 - i * 60_000).toISOString(),
  projectId: null,
  state: { nodeStatuses: { a: "done" } },
  budget: { measuredSpentUsd: 0, capUsd: null },
}));
// the gateway's cursors are base64url without padding
const cursorOf = (n: number) => Buffer.from(`c${n}`).toString("base64url");
const cursorAt = (c: string) => {
  const s = Buffer.from(c, "base64url").toString();
  return /^c\d+$/.test(s) ? Number(s.slice(1)) : null;
};

/** /v1/runs under the list contract; `gate` holds a filtered answer back until the test releases it */
function runsPage(q: URLSearchParams) {
  const sort = q.get("sort") ?? "created";
  const dir = q.get("dir") === "asc" ? 1 : -1;
  const field = sort === "name" ? "name" : "createdAt";
  const rows = RUNS.filter((r) => !q.get("status") || r.status === q.get("status")).sort(
    (a, b) => (String(a[field]) < String(b[field]) ? -1 : String(a[field]) > String(b[field]) ? 1 : 0) * dir,
  );
  const limit = Number(q.get("limit"));
  const cursor = q.get("cursor");
  const start = cursor ? cursorAt(cursor) : Number(q.get("offset") ?? 0);
  if (start === null) return { status: 400, body: { error: "bad_cursor", detail: "the cursor is malformed" } };
  const more = start + limit < rows.length;
  const keyset = sort === "created" && !q.get("offset");
  return {
    status: 200,
    body: {
      items: rows.slice(start, start + limit),
      nextCursor: more && keyset ? cursorOf(start + limit) : null,
      nextOffset: more && !keyset ? start + limit : null,
      total: rows.length,
      totalIsEstimate: false,
    },
  };
}

async function mockApi(page: Page, opts: { gate?: Promise<void>; lists?: URL[] } = {}) {
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, AUTH_ME);
    if (p === "/v1/me") return json(route, ME);
    if (p === "/v1/runs" && req.method() === "GET") {
      if (!url.searchParams.get("sort")) return json(route, { runs: RUNS.slice(0, 200) });
      opts.lists?.push(url);
      if (url.searchParams.get("status") && opts.gate) await opts.gate;
      const out = runsPage(url.searchParams);
      return json(route, out.body, out.status);
    }
    if (p === "/v1/workload-identities") {
      return json(route, { error: "forbidden", detail: "internal policy detail that must not reach the screen" }, 403);
    }
    if (p === "/v1/projects") return json(route, { projects: [] });
    if (/^\/v1\/users\/[^/]+\/agents$/.test(p)) return json(route, { agents: [], defaultAgentId: null });
    return json(route, {});
  });
}

const list = (page: Page, id: string) => page.locator(`[data-list="${id}"]`);
const status = (page: Page, id: string) => list(page, id).getByTestId("list-status");

test("UIS-05: a slow filtered answer shows the previous rows as updating, not as the new result", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await mockApi(page, { gate });
  await page.goto("/ui/runs");
  await expect(status(page, "runs")).toHaveText("1–10 of 64");
  await expect(list(page, "runs")).not.toHaveAttribute("aria-busy", "true");

  await page.getByLabel("Status").selectOption("completed");
  await expect(status(page, "runs")).toHaveText("Updating… showing previous results");
  await expect(list(page, "runs")).toHaveAttribute("aria-busy", "true");
  // the previous rows stay (no empty state flashes), dimmed
  await expect(list(page, "runs").getByText("Run 0001", { exact: true })).toBeVisible();
  await expect(list(page, "runs").getByText(/No runs/)).toHaveCount(0);
  expect(Number(await list(page, "runs").locator("tbody").evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);

  release();
  await expect(status(page, "runs")).toHaveText("1–10 of 16");
  await expect(list(page, "runs")).not.toHaveAttribute("aria-busy", "true");
  await expect(list(page, "runs").getByText("Run 0001", { exact: true })).toHaveCount(0);
  await expect(list(page, "runs").getByText("Run 0002", { exact: true })).toBeVisible();
});

test("UIS-06: Back from a run's detail restores the sort and the page, beside the page's own parameters", async ({ page }) => {
  const lists: URL[] = [];
  await mockApi(page, { lists });
  await page.goto("/ui/runs?keep=me");
  await expect(status(page, "runs")).toHaveText("1–10 of 64");
  await list(page, "runs").getByRole("button", { name: "Run", exact: true }).click();
  await expect(list(page, "runs").locator('th[aria-sort="ascending"]')).toContainText("Run");
  await list(page, "runs").getByRole("button", { name: "Next" }).click();
  await expect(status(page, "runs")).toHaveText("11–20 of 64");
  await expect(page).toHaveURL(/keep=me/);
  await expect(page).toHaveURL(/runs\.sort=name/);
  await expect(page).toHaveURL(/runs\.offset=10/);

  await list(page, "runs").getByRole("link", { name: "Open run Run 0012" }).click();
  await expect(page).toHaveURL(/\/runs\/00000000-0000-4000-8000-000000000012/);
  await page.goBack();

  await expect(status(page, "runs")).toHaveText("11–20 of 64");
  await expect(list(page, "runs").locator('th[aria-sort="ascending"]')).toContainText("Run");
  await expect(list(page, "runs").getByRole("link", { name: "Open run Run 0010" })).toBeVisible();
  const last = lists.at(-1)!;
  expect([last.searchParams.get("sort"), last.searchParams.get("dir"), last.searchParams.get("offset")]).toEqual(["name", "asc", "10"]);
  await expect(page).toHaveURL(/keep=me/);
});

test("UIS-06: a keyset page comes back by its cursor, and a stale cursor falls back to the first page", async ({ page }) => {
  const lists: URL[] = [];
  await mockApi(page, { lists });
  await page.goto("/ui/runs");
  await expect(status(page, "runs")).toHaveText("1–10 of 64");
  await list(page, "runs").getByRole("button", { name: "Next" }).click();
  await expect(status(page, "runs")).toHaveText("11–20 of 64");
  await expect(page).toHaveURL(new RegExp(`runs\\.cursor=${cursorOf(10)}`));
  await list(page, "runs").getByRole("link", { name: "Open run Run 0010" }).click();
  await page.goBack();
  await expect(status(page, "runs")).toHaveText("11–20 of 64");
  expect(lists.at(-1)!.searchParams.get("cursor")).toBe(cursorOf(10));

  // a cursor the server no longer accepts: the first page, and the address forgets the place
  await page.goto(`/ui/runs?runs.offset=10&runs.cursor=${Buffer.from("gone").toString("base64url")}`);
  await expect(status(page, "runs")).toHaveText("1–10 of 64");
  await expect(list(page, "runs").getByRole("link", { name: "Open run Run 0000" })).toBeVisible();
  await expect(page).not.toHaveURL(/runs\.offset/);
});

test("UIS-08: a 403 under the page's own error sentence reads as an access refusal, without Retry", async ({ page }) => {
  await mockApi(page);
  await page.goto("/ui/admin/workload-identities/identities");
  const alert = list(page, "workload-identities").getByRole("alert");
  await expect(alert).toContainText("You don't have access to this view");
  await expect(alert).toContainText("Workload identities could not be read. No empty or active state is inferred.");
  await expect(alert).not.toContainText("internal policy detail");
  await expect(alert.getByRole("button", { name: "Retry" })).toHaveCount(0);
});
