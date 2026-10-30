import { expect, test } from "@playwright/test";

// Owner 2026-10-30, "adding MCP servers should be working": a new server is unreachable until its host is on the
// egress allow-list, its release-age cooldown is over (or overridden) and someone is granted. The register form says
// so where the admin is looking, with a way to each step.
test("the MCP register form names what stands between a new server and its first call, with links", async ({ page }) => {
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/v1") && !path.startsWith("/auth")) return route.continue();
    const body = path === "/auth/me" || path === "/v1/me"
      ? { userId: "mcp-admin", isAdmin: true, via: "session", user: { id: "mcp-admin", email: "admin@example.test", displayName: "Mcp Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false }
      : path === "/v1/servers" ? { servers: [] }
      : path === "/v1/users" ? { users: [] }
      : path === "/v1/org/settings" ? { settings: { mcpProtocolMethods: [], mcpUpstreamTransports: ["streamable_http"] } } : {};
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/ui/admin/mcp-servers");
  const steps = page.getByTestId("mcp-next-steps");
  await expect(steps).toContainText("release-age cooldown");
  await expect(steps.getByRole("link", { name: "egress allow-list" })).toHaveAttribute("href", "/ui/admin/custom-providers");
  await expect(steps.getByRole("link", { name: "Admission review" })).toHaveAttribute("href", "/ui/admin/admission");
  await page.getByLabel("Upstream transport", { exact: true }).selectOption("stdio");
  await expect(page.getByText("Stdio must first be enabled below, under MCP protocol coverage.")).toBeVisible();
  // the card the copy points at is on the same page
  await expect(page.getByText("MCP protocol coverage", { exact: true })).toBeVisible();
});
