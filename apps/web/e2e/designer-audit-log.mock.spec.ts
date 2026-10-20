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
let auditPage: (cursor: string | null) => unknown = () => ({ entries, pageSize: 100, hasMore: false, nextCursor: null });
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
  else if (p === "/v1/audit") body = auditPage(new URL(route.request().url()).searchParams.get("cursor"));
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

test("Audit log at 1440×900 with a full page: rows above the fold, the partial trail said in view, paging outside the scroll box (M2, L4)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  auditPage = (cursor) => cursor
    ? { entries: many(100, 3), pageSize: 100, hasMore: false, nextCursor: null }
    : { entries: many(0, 100), pageSize: 100, hasMore: true, nextCursor: "c1" };
  await page.goto("/ui/admin/audit");
  const card = page.locator("section[data-rg-card]").filter({ hasText: "Entries" });
  await expect(card.locator("tbody tr")).toHaveCount(100);
  // the first row is on screen without scrolling
  await expect(card.locator("tbody tr").first()).toBeInViewport();
  // the header says the trail is partial, in view, while older rows exist
  const cue = card.getByText("100 newest rows loaded, older rows exist", { exact: true });
  await expect(cue).toBeInViewport();
  // the entries scroll inside the card, and the paging line and Load older are never inside that scroll box
  const region = card.getByRole("region", { name: "Entries, scrollable" });
  await expect(region).toBeVisible();
  await expect(region.getByTestId("audit-paging")).toHaveCount(0);
  await expect(region.getByRole("button", { name: "Load older" })).toHaveCount(0);
  const paging = card.getByTestId("audit-paging");
  await expect(paging).toContainText("older rows exist");
  await paging.getByRole("button", { name: "Load older" }).click();
  await expect(card.locator("tbody tr")).toHaveCount(103);
  await expect(card.getByText("103 rows", { exact: true })).toBeVisible();
  await expect(paging).toContainText("Showing all 103 rows");
});

test("Audit log at 1440×900, Expand: the dialog keeps the partial-trail notice, the count and Load older (M2b)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  auditPage = (cursor) => cursor
    ? { entries: many(100, 3), pageSize: 100, hasMore: false, nextCursor: null }
    : { entries: many(0, 100), pageSize: 100, hasMore: true, nextCursor: "c1" };
  await page.goto("/ui/admin/audit");
  const card = page.locator("section[data-rg-card]").filter({ hasText: "Entries" });
  await expect(card.locator("tbody tr")).toHaveCount(100);
  await card.getByRole("button", { name: "Expand" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("tbody tr")).toHaveCount(100);
  // the count cue rides in the dialog title, and the paging line follows the body in, rendered once
  await expect(dialog).toContainText("100 newest rows loaded, older rows exist");
  await expect(page.getByTestId("audit-paging")).toHaveCount(1);
  const paging = dialog.getByTestId("audit-paging");
  await expect(paging).toContainText("older rows exist");
  await paging.getByRole("button", { name: "Load older" }).click();
  await expect(dialog.locator("tbody tr")).toHaveCount(103);
  await expect(paging).toContainText("Showing all 103 rows");
  await expect(dialog.getByRole("button", { name: "Load older" })).toHaveCount(0);
  // closing hands the footer back to the card, still once
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("audit-paging")).toHaveCount(1);
  await expect(card.getByTestId("audit-paging")).toContainText("Showing all 103 rows");
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
