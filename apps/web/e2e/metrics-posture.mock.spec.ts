import { expect, test, type Page } from "@playwright/test";

async function mockPosture(page: Page, status: number, body: unknown) {
  let reply = { status, body };
  let metricsRequests = 0;
  let postureRequests = 0;
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/metrics") {
      metricsRequests++;
      // A reverse proxy can answer with an HTML success unrelated to metrics.
      return route.fulfill({ status: 200, contentType: "text/html", body: "proxy landing page" });
    }
    if (!path.startsWith("/v1") && !path.startsWith("/auth")) return route.continue();
    if (path === "/v1/org/posture") {
      postureRequests++;
      return route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) });
    }
    const body = path === "/auth/me" || path === "/v1/me"
      ? { userId: "metrics-admin", isAdmin: true, via: "session", user: { id: "metrics-admin", email: "admin@example.test", displayName: "Metrics Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false }
      : path === "/v1/org/settings" ? { settings: { semanticCacheTtlSeconds: 3600, conversationRetentionDays: 30 } }
      : path === "/v1/inventory/memory-stores" ? { stores: [] } : {};
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { set: (status: number, body: unknown) => { reply = { status, body }; }, counts: () => ({ metricsRequests, postureRequests }) };
}

for (const listener of ["off", "loopback", "non_loopback"] as const) {
  test(`R18-01: 200 reports ${listener} configuration without probing proxy /metrics`, async ({ page }) => {
    const gw = await mockPosture(page, 200, { metrics: { separateListener: listener, mainListener: false, tokenConfigured: true } });
    await page.goto("/ui/admin/retention");
    await expect(page.getByText(`Separate metrics listener: ${listener === "loopback" ? "loopback only" : listener === "non_loopback" ? "non-loopback" : "off"}.`, { exact: true })).toBeVisible();
    await expect(page.getByText("Main listener: no metrics endpoint served.", { exact: true })).toBeVisible();
    await expect(page.getByText("Bearer token configured: yes.", { exact: true })).toBeVisible();
    await expect(page.getByText(/accessible without a bearer token/)).toHaveCount(0);
    expect(gw.counts()).toEqual({ metricsRequests: 0, postureRequests: 1 });
  });
}

for (const status of [401, 404, 500]) {
  test(`R18-01: HTTP ${status} is unmeasured and Retry recovers`, async ({ page }) => {
    const gw = await mockPosture(page, status, { error: status === 401 ? "posture_refused" : status === 404 ? "not_found" : "internal" });
    await page.goto("/ui/admin/retention");
    await expect(page.getByText(/Metrics configuration is unmeasured because/)).toBeVisible();
    await expect(page.getByText("Separate metrics listener: off.", { exact: true })).toHaveCount(0);
    gw.set(200, { metrics: { separateListener: "loopback", mainListener: false, tokenConfigured: true } });
    await page.getByRole("button", { name: "Refresh metrics posture" }).click();
    await expect(page.getByText("Separate metrics listener: loopback only.", { exact: true })).toBeVisible();
    expect(gw.counts()).toEqual({ metricsRequests: 0, postureRequests: 2 });
  });
}

test("R18-01: a missing metrics block remains unmeasured, not disabled", async ({ page }) => {
  const gw = await mockPosture(page, 200, { data: "older gateway" });
  await page.goto("/ui/admin/retention");
  await expect(page.getByText(/Separate metrics listener: unmeasured/)).toBeVisible();
  await expect(page.getByText("Bearer token configured: no.", { exact: true })).toHaveCount(0);
  expect(gw.counts().metricsRequests).toBe(0);
});

test("R18-01: only reported enabled metrics without token configuration raises the operator warning", async ({ page }) => {
  await mockPosture(page, 200, { metrics: { separateListener: "non_loopback", mainListener: false, tokenConfigured: false } });
  await page.goto("/ui/admin/retention");
  await expect(page.getByRole("alert").filter({ hasText: "enabled metrics listener without a configured bearer token" })).toBeVisible();
});

test("R18-01: session-loss 401 routes back to sign-in without probing metrics", async ({ page }) => {
  const gw = await mockPosture(page, 401, { error: "unauthenticated" });
  await page.goto("/ui/admin/retention");
  await expect(page).toHaveURL(/\/login/);
  expect(gw.counts().metricsRequests).toBe(0);
});
