import { expect, test, type Route } from "@playwright/test";

// Governed - Designer batch 4, G8 (owner-approved on #453, 2026-10-19): the audit log leads with the
// chain's state, scrolls its entries inside the card, and explains with (i) instead of hover-only titles.

const ME = "u";
const LONG = "Approved after Morgan Reyes confirmed the human-oversight control is linked to the source risk and the evidence pack was attached to the record.";
const entries = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", at: "2026-10-19T09:00:00.000Z", userId: ME, ruleId: "approval_decided", objectType: "approval", effect: "allow", deployMode: null, reason: LONG },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", at: "2026-10-19T08:00:00.000Z", userId: ME, ruleId: "workflow_deploy", objectType: "workflow", effect: "require_approval", deployMode: "byoc", reason: "Short reason." },
];

async function mock(route: Route) {
  const p = new URL(route.request().url()).pathname;
  let body: unknown = {};
  if (p === "/auth/me") body = { userId: ME, isAdmin: true, via: "session", user: { id: ME, email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
  else if (p === "/v1/me") body = { userId: ME, isAdmin: true, user: { id: ME, email: "ada@example.test", displayName: "Ada Admin" } };
  else if (p === "/v1/audit") body = { entries, pageSize: 100, hasMore: false, nextCursor: null };
  else if (p === "/v1/audit/retention") body = { retainedDays: null, prunable: 0, floorSource: [] };
  else if (p === "/v1/users") body = { users: [{ id: ME, email: "ada@example.test", displayName: "Ada Admin" }] };
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

test.beforeEach(async ({ page }) => {
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
  await expect(page.getByRole("region", { name: "Entries, scrollable" })).toBeVisible();

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
