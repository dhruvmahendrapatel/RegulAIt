import { expect, test } from "@playwright/test";

test("R18-12: stdio registration and update associate the no-secrets warning with argument inputs", async ({ page }) => {
  const server = { id: "stdio-fixture", name: "Fixture server", transport: "stdio", enabled: true, stdio: { command: "/fixture/mcp-server", args: ["safe argument"] }, stdioCommandDigest: "fixture-digest", admissionStatus: "unscanned", ownerUserId: null, scope: "org", privateRanges: "none" };
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/v1") && !path.startsWith("/auth")) return route.continue();
    const body = path === "/auth/me" || path === "/v1/me"
      ? { userId: "stdio-admin", isAdmin: true, via: "session", user: { id: "stdio-admin", email: "admin@example.test", displayName: "Stdio Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false }
      : path === "/v1/servers" ? { servers: [server] }
      : path === "/v1/users" ? { users: [] }
      : path === "/v1/org/settings" ? { settings: { mcpProtocolMethods: [], mcpUpstreamTransports: ["streamable_http", "stdio"] } } : {};
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/ui/admin/mcp-servers");
  await page.getByLabel("Upstream transport", { exact: true }).selectOption("stdio");
  const registration = page.getByRole("group", { name: "Command arguments" });
  await expect(registration).toHaveAccessibleDescription(/Arguments are audited and visible to admins.*Never put passwords/);
  await registration.getByRole("button", { name: "Add argument" }).click();
  await expect(registration.getByLabel("Argument 1", { exact: true })).toHaveAccessibleDescription(/Never put passwords, API keys or other secrets/);
  await page.getByLabel("Stdio server to update").selectOption(server.id);
  const groups = page.getByRole("group", { name: "Command arguments" });
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(1)).toHaveAccessibleDescription(/Arguments are audited and visible to admins/);
  await expect(groups.nth(1).getByLabel("Argument 1", { exact: true })).toHaveAccessibleDescription(/Never put passwords, API keys or other secrets/);
});
