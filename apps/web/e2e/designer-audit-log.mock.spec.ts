import { expect, test, type Route } from "@playwright/test";

// Governed - Designer batch 4, G8 (owner-approved on #453, 2026-10-19): the audit log leads with the
// chain's state, scrolls its entries inside the card, and explains with (i) instead of hover-only titles.

const ME = "u";
const LONG = "Approved after Morgan Reyes confirmed the human-oversight control is linked to the source risk and the evidence pack was attached to the record.";
const entries = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", at: "2026-10-19T09:00:00.000Z", userId: ME, ruleId: "approval_decided", objectType: "approval", effect: "allow", deployMode: null, reason: LONG },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", at: "2026-10-19T08:00:00.000Z", userId: ME, ruleId: "workflow_deploy", objectType: "workflow", effect: "require_approval", deployMode: "byoc", reason: "Short reason." },
];

// per-test overrides: a full first page with older rows behind it (M2, L4) and evidence states for the folds
let auditPage: (cursor: string | null, q: URLSearchParams) => unknown = () => ({ entries, pageSize: 100, hasMore: false, nextCursor: null });
let extra: Record<string, unknown> = {};
const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({
  id: `bbbbbbbb-0000-4000-8000-${String(from + i).padStart(12, "0")}`,
  at: new Date(Date.UTC(2026, 9, 19, 9) - (from + i) * 60_000).toISOString(),
  userId: ME, ruleId: "tool_call", objectType: "tool", effect: "allow", deployMode: null, reason: `Row ${from + i}.`,
}));

async function mock(route: Route) {
  const p = new URL(route.request().url()).pathname;
  let body: unknown = {};
  if (p in extra) body = extra[p];
  else if (p === "/auth/me") body = { userId: ME, isAdmin: true, via: "session", user: { id: ME, email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
  else if (p === "/v1/me") body = { userId: ME, isAdmin: true, user: { id: ME, email: "ada@example.test", displayName: "Ada Admin" } };
  else if (p === "/v1/audit") body = auditPage(new URL(route.request().url()).searchParams.get("cursor"), new URL(route.request().url()).searchParams);
  else if (p === "/v1/audit/retention") body = { retainedDays: null, prunable: 0, floorSource: [] };
  else if (p === "/v1/users") body = { users: [{ id: ME, email: "ada@example.test", displayName: "Ada Admin" }] };
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

test.beforeEach(async ({ page }) => {
  auditPage = () => ({ entries, pageSize: 100, hasMore: false, nextCursor: null });
  extra = {};
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    return route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth")) ? route.continue() : mock(route);
  });
});

test("Audit log: chain state first and never green unasked, entries contained, reasons expand in place", async ({ page }) => {
  await page.goto("/ui/admin/audit");
  const cards = page.locator("section[data-rg-card]");
  await expect(cards.first()).toContainText("Chain integrity");
  await expect(cards.first().getByText("Not verified yet", { exact: true })).toBeVisible();
  // two rows fit, so the contained entries card is no scroll stop (the region role appears only while it scrolls)
  await expect(cards.filter({ hasText: "Entries" }).locator("tbody tr")).toHaveCount(2);

  // the filters sit in the entries header and keep their labels
  await expect(page.getByLabel("Filter by deploy mode")).toBeVisible();

  // a long reason is cut with an explicit, keyboard-reachable Show more
  const more = page.getByRole("button", { name: "Show more" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(page.getByText(LONG)).toBeVisible();
  await expect(page.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");

  // no hover-only titles on the downloads or the unrecorded deploy mode
  await expect(page.getByRole("button", { name: "Download CSV" })).not.toHaveAttribute("title", /.+/);
  await page.getByRole("button", { name: "What is the signed bundle?" }).click();
  await expect(page.getByRole("note")).toContainText("verify offline");
  await page.keyboard.press("Escape");
  // phase2.spec (real stack) counts these cells by their exact name
  await expect(page.getByRole("cell", { name: "Not recorded", exact: true })).toHaveCount(1);
});

/** ADR-0226: the trail under the list contract, keyset-paged on its default (at DESC, id DESC) sort */
const contractTrail = (rows: ReturnType<typeof many>) => (cursor: string | null, q: URLSearchParams) => {
  const limit = Number(q.get("limit"));
  const start = cursor ? Number(cursor) : 0;
  const more = start + limit < rows.length;
  return { items: rows.slice(start, start + limit), nextCursor: more ? String(start + limit) : null, nextOffset: null, total: rows.length, totalIsEstimate: false };
};

test("Audit log at 1440×900 with older rows: rows above the fold, where you are said in view, and paging walks the trail's cursor (M2, L4)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  auditPage = contractTrail(many(0, 103));
  await page.goto("/ui/admin/audit");
  const card = page.locator("section[data-rg-card]").filter({ hasText: "Entries" });
  await expect(card.locator("tbody tr")).toHaveCount(10);
  // the first row is on screen without scrolling
  await expect(card.locator("tbody tr").first()).toBeInViewport();
  // the list says how much of the trail this is, in view
  const status = card.getByTestId("list-status");
  await expect(status).toHaveText("1–10 of 103");
  await expect(status).toBeInViewport();
  await card.getByLabel("Rows per page").selectOption("100");
  await expect(status).toHaveText("1–100 of 103");
  await card.getByRole("button", { name: "Next", exact: true }).click();
  await expect(status).toHaveText("101–103 of 103");
  await expect(card.locator("tbody tr")).toHaveCount(3);
  await expect(card.getByRole("button", { name: "Next", exact: true })).toHaveAttribute("aria-disabled", "true");
});

test("Audit log, All: older rows load 500 at a time and the count says how many are loaded (M2b)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  auditPage = contractTrail(many(0, 103));
  await page.goto("/ui/admin/audit");
  const card = page.locator("section[data-rg-card]").filter({ hasText: "Entries" });
  await card.getByLabel("Rows per page").selectOption("all");
  await expect(card.getByTestId("list-status")).toHaveText("Loaded 103 of 103");
  await expect(card.locator("tbody tr")).toHaveCount(103);
  await expect(card.getByRole("button", { name: "Load next 500" })).toHaveCount(0);
});

test("Audit log folds keep each warning in the closed summary (G8 f)", async ({ page }) => {
  extra = {
    "/v1/receipts/status": { state: "no_key" },
    "/v1/audit/anchors": { anchors: [{ id: "a1", seq: 4, status: "flushed", timestamp: { status: "failed", genTime: null, tsaUrl: null, serial: null, policyOid: null, verified: false } }] },
  };
  await page.goto("/ui/admin/audit");
  for (const [title, warning] of [["Signed decision receipts", "Unsigned: no signing key"], ["Anchor timestamps", "1 timestamp failed"]] as const) {
    const fold = page.locator("details").filter({ hasText: title });
    await expect(fold).not.toHaveAttribute("open", /.*/);
    await expect(fold.locator("summary").getByText(warning, { exact: true })).toBeVisible();
  }
});

test("D4 trust-audit-01/07/08: a failed retention read alerts with Retry; the deploy-mode bucket and rows carry no hover-only text", async ({ page }) => {
  let failRetention = true;
  await page.route((url) => url.pathname === "/v1/audit/retention", (route) => failRetention
    ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) })
    : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ retainedDays: 30, prunable: 2, floorSource: [] }) }));
  await page.goto("/ui/admin/audit");
  // trust-audit-07: the filter names the null bucket the way the column does
  await expect(page.getByLabel("Filter by deploy mode").locator("option", { hasText: "Not recorded" })).toHaveCount(1);
  await expect(page.getByLabel("Filter by deploy mode").locator("option", { hasText: "None recorded" })).toHaveCount(0);
  // trust-audit-08: no raw ISO timestamp or rule id behind a hover title on a row
  await expect(page.locator("table [title]")).toHaveCount(0);
  // trust-audit-01 (A15): never "Loading retention…" forever
  const fold = page.locator("details").filter({ hasText: "Retention" });
  await fold.locator("summary").click();
  const failed = fold.getByRole("alert");
  await expect(failed).toContainText("Retention could not be read");
  await expect(fold.getByText("Loading retention…")).toHaveCount(0);
  failRetention = false;
  await fold.getByRole("button", { name: "Retry" }).click();
  await expect(fold).toContainText("30 days");
  await expect(fold.getByRole("alert")).toHaveCount(0);
});
