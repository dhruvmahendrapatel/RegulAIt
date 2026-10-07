import { expect, test, type Page, type Route } from "@playwright/test";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
async function setup(page: Page, state: "not_configured" | "failed" | "pending" | "granted", verified = state === "granted") {
  const calls = { retries: 0, downloads: 0 };
  const anchor = { id: "00000000-0000-4000-8000-000000000001", seq: 4, status: "flushed", timestamp: { status: state, genTime: state === "granted" ? "2026-10-07T12:00:00.000Z" : null, tsaUrl: null, serial: null, policyOid: null, verified } };
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (!p.startsWith("/v1") && !p.startsWith("/auth")) return route.continue();
    const me = { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } };
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/audit/anchors") return json(route, { anchors: [anchor] });
    if (p.endsWith("/timestamp")) { calls.retries++; return json(route, { error: "timestamp_configuration_invalid" }, 502); }
    if (p.endsWith("/timestamp.tsr")) { calls.downloads++; return route.fulfill({ status: 200, contentType: "application/timestamp-reply", body: Buffer.from([48, 1, 0]) }); }
    if (p === "/v1/audit") return json(route, { entries: [], pageSize: 100, hasMore: false, nextCursor: null });
    if (p === "/v1/users") return json(route, { users: [] });
    return json(route, {});
  });
  await page.goto("/ui/admin/audit");
  await expect(page.getByText("Anchor timestamps", { exact: true })).toBeVisible();
  return calls;
}
for (const [state, text] of [["not_configured", "Not timestamped: no authority configured"], ["pending", "Waiting for anchor storage or timestamp retry"], ["failed", "Timestamp attempt failed"]] as const) test(`${state} does not claim a verified timestamp`, async ({ page }) => {
  await setup(page, state);
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download timestamp for anchor 4" })).toBeDisabled();
  await expect(page.getByText(/Verified at issuance/)).toHaveCount(0);
});
test("a failed retry reports the refusal and retains a truthful failed state", async ({ page }) => {
  const calls = await setup(page, "failed");
  await page.getByRole("button", { name: "Retry timestamp for anchor 4" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(calls.retries).toBe(1);
  await expect(page.getByText("Timestamp attempt failed", { exact: true })).toBeVisible();
});
test("verified token offers DER download and explains independent verification limits", async ({ page }) => {
  const calls = await setup(page, "granted");
  await expect(page.getByText(/Verified at issuance:/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry timestamp for anchor 4" })).toBeDisabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download timestamp for anchor 4" }).click();
  expect((await download).suggestedFilename()).toBe("anchor-4.tsr");
  expect(calls.downloads).toBe(1);
  await expect(page.getByText(/independently trusted certificates/)).toBeVisible();
});
test("granted without a verification observation cannot download or claim verification", async ({ page }) => {
  await setup(page, "granted", false);
  await expect(page.getByText("Token present; verification not reported", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download timestamp for anchor 4" })).toBeDisabled();
});
