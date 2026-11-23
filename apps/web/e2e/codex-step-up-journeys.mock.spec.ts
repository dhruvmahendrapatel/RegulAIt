/**
 * Codex review CXR-ADM-001, CXR-INT-001 and CXR-ACC-001 (PR #1186), against a
 * mocked gateway. The server already refuses these writes with 403
 * `step_up_required`; before this fix the pages called the plain client, so no
 * "Confirm it's you" dialog opened and the admin was left at the refusal.
 *
 *  1. enabling an external scorer: refused, dialog, proof, the SAME POST resent once;
 *  2. editing an external scorer: the same for its PATCH;
 *  3. changing an MCP server's owner: the same for its PUT (owner_change);
 *  4. the step-up options read fails: the dialog offers "Try again" instead of an
 *     endless "Getting ready…", and the retry completes the proof.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ME = { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
const SCORER = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Judge one",
  baseUrl: "https://judge.example.test",
  scorerKinds: ["llm_judge"],
  allowPlaintextHttp: false,
  enabled: false,
  lastTestedAt: null,
  lastTestError: null,
  hasApiKey: true,
  createdBy: "ada",
  createdAt: "2026-11-01T00:00:00Z",
};
const PERSON = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", displayName: "Olive Owner", isAdmin: false, disabledAt: null, createdAt: "2026-10-01T00:00:00Z", totpEnabled: true, hasPassword: true, mustChangePassword: false };
const SERVER = { id: "s1", name: "Fixture server", url: "https://mcp.example.test/mcp", transport: "streamable_http", enabled: true, stdio: null, stdioCommandDigest: null, admissionState: "admitted", ownerUserId: null, ownership: "unowned" };

async function mockApi(page: Page) {
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me" || p === "/v1/me") return json(route, ME);
    if (p === "/v1/external-scorers" && method === "GET") return json(route, { scorers: [SCORER] });
    if (p === `/v1/external-scorers/${SCORER.id}/enabled` && method === "POST") return json(route, { ...SCORER, enabled: true });
    if (p === `/v1/external-scorers/${SCORER.id}` && method === "PATCH") return json(route, { ...SCORER, name: "Judge renamed" });
    if (p === "/v1/egress/allow-hosts") return json(route, { hosts: [{ id: "h1", host: "judge.example.test", allowPrivateRanges: false }] });
    if (p === "/v1/servers") return json(route, { servers: [SERVER] });
    if (p === "/v1/servers/s1/owner" && method === "PUT") return json(route, { ...SERVER, ownerUserId: PERSON.id, ownership: "owned" });
    if (p === "/v1/users") return json(route, { users: [PERSON] });
    if (p === "/v1/org/settings") return json(route, { settings: { mcpProtocolMethods: [], mcpUpstreamTransports: ["streamable_http"] } });
    return json(route, {});
  });
}

test.describe("Codex review: protected integration writes complete through step-up", () => {
  test("ADM-001: enabling an external scorer asks to confirm it's you and resends the same POST once", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "POST", path: `/v1/external-scorers/${SCORER.id}/enabled`, kind: "settings_relax" });
    await page.goto("/ui/admin/external-scorers");
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ enabled: true });
  });

  test("ADM-001: editing an external scorer asks to confirm it's you and resends the same PATCH once", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PATCH", path: `/v1/external-scorers/${SCORER.id}`, kind: "settings_relax" });
    await page.goto("/ui/admin/external-scorers");
    await page.getByRole("button", { name: `Edit external scorer ${SCORER.name}` }).click();
    const dialog = page.getByRole("dialog", { name: `Edit external scorer ${SCORER.name}` });
    await dialog.getByLabel("Name").fill("Judge renamed");
    await dialog.getByRole("button", { name: /^Save/ }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toMatchObject({ name: "Judge renamed" });
  });

  test("INT-001: changing an MCP server's owner asks to confirm it's you and resends the same PUT once", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/servers/s1/owner", kind: "owner_change" });
    await page.goto("/ui/admin/mcp-servers");
    await page.getByLabel("Server to assign").selectOption("s1");
    await page.getByLabel("Owner for Fixture server").selectOption(PERSON.id);
    await page.getByRole("button", { name: "Save owner", exact: true }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ ownerUserId: PERSON.id });
  });

  // The step-up audit for this slice: identity deletes refused with a settings_relax "approver-pool takeover" step-up.
  // Two of them used a raw fetch, so no prompt could ever answer them.
  const ROLES = [{ id: "r1", name: "approvers", description: null }];
  const TEAMS = [{ id: "t1", name: "team-17", defaultClassifications: [], members: [{ userId: "u-m", name: "Morgan Reyes" }] }];
  const MAPPINGS = [{ id: "m1", source: "oidc", externalGroup: "eng-leads", roleId: "r1", roleName: "approvers", createdAt: "2026-11-01T00:00:00Z" }];
  async function mockIdentity(page: Page, opts: { roleHeld?: boolean; teamOwnsContext?: boolean } = {}) {
    await page.route("**/*", async (route) => {
      const req = route.request();
      const p = new URL(req.url()).pathname;
      if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
      const method = req.method();
      let body: Record<string, unknown> = {};
      try {
        body = (req.postDataJSON() as Record<string, unknown>) ?? {};
      } catch {
        body = {};
      }
      if (p === "/auth/me" || p === "/v1/me") return json(route, ME);
      if (p === "/v1/roles" && method === "GET") return json(route, { roles: ROLES });
      if (p === "/v1/teams" && method === "GET") return json(route, { teams: TEAMS });
      if (p === "/v1/group-role-mappings" && method === "GET") return json(route, { mappings: MAPPINGS });
      if (p.startsWith("/v1/identity/asserted-groups") || p.startsWith("/v1/group-role-mappings/asserted")) return json(route, { assertedGroups: [], unmappedCount: 0 });
      if (p === "/v1/roles/r1" && method === "DELETE") {
        if (opts.roleHeld && !body.force) return json(route, { error: "role_held", holders: ["Morgan Reyes"] }, 409);
        return json(route, { deleted: true });
      }
      if (p === "/v1/teams/t1" && method === "DELETE") {
        if (opts.teamOwnsContext && !body.force) return json(route, { error: "team_owns_shared_context", items: 3 }, 409);
        return json(route, { deleted: true });
      }
      if (p === "/v1/group-role-mappings/m1" && method === "DELETE") return json(route, { deleted: true });
      if (p === "/v1/users") return json(route, { users: [] });
      return json(route, {});
    });
  }

  test("audit: deleting a role completes through step-up", async ({ page }) => {
    await mockIdentity(page);
    const su = await requireStepUpOn(page, { method: "DELETE", path: "/v1/roles/r1", kind: "settings_relax" });
    await page.goto("/ui/admin/roles");
    await page.getByRole("button", { name: "delete", exact: true }).click();
    await page.getByRole("dialog", { name: /Delete role/ }).getByRole("button", { name: "Delete role" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
  });

  test("audit: force-deleting a held role goes through the shared client and step-up", async ({ page }) => {
    await mockIdentity(page, { roleHeld: true });
    const su = await requireStepUpOn(page, { method: "DELETE", path: "/v1/roles/r1", kind: "settings_relax", when: (b) => (b as { force?: boolean } | null)?.force === true });
    await page.goto("/ui/admin/roles");
    await page.getByRole("button", { name: "delete", exact: true }).click();
    await page.getByRole("dialog", { name: /Delete role/ }).getByRole("button", { name: "Delete role" }).click();
    const force = page.getByRole("dialog", { name: /is still held/ });
    await force.getByLabel("Reason").fill("Retiring the role after the approver pool moved to the new team.");
    await force.getByRole("button", { name: "Force delete" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toMatchObject({ force: true });
  });

  test("audit: force-deleting a team that owns shared context completes through step-up", async ({ page }) => {
    await mockIdentity(page, { teamOwnsContext: true });
    const su = await requireStepUpOn(page, { method: "DELETE", path: "/v1/teams/t1", kind: "settings_relax", when: (b) => (b as { force?: boolean } | null)?.force === true });
    await page.goto("/ui/admin/teams");
    await page.getByRole("button", { name: "delete team", exact: true }).click();
    await page.getByRole("dialog", { name: /Delete team/ }).getByRole("button", { name: "Delete team" }).click();
    const force = page.getByRole("dialog", { name: /owns shared context/ });
    await force.getByLabel("Reason").fill("The team is merged into team-18; its context moves with it.");
    await force.getByRole("button", { name: "Force delete" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
  });

  test("audit: removing a group-to-role mapping completes through step-up", async ({ page }) => {
    await mockIdentity(page);
    const su = await requireStepUpOn(page, { method: "DELETE", path: "/v1/group-role-mappings/m1", kind: "settings_relax" });
    await page.goto("/ui/admin/group-mappings");
    await page.getByRole("button", { name: "remove", exact: true }).click();
    await page.getByRole("dialog", { name: /Remove the mapping/ }).getByRole("button", { name: "Remove mapping" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
  });

  test("ACC-001: a failed options read offers Try again, and the retry completes the proof", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "POST", path: `/v1/external-scorers/${SCORER.id}/enabled`, kind: "settings_relax" });
    // registered last, so it runs first: the FIRST options read fails, later ones fall through to the harness
    let optionsFailures = 0;
    await page.route("**/v1/auth/step-up/options", async (route) => {
      if (optionsFailures === 0) {
        optionsFailures += 1;
        return json(route, { error: "unavailable", detail: "the gateway is busy" }, 503);
      }
      return route.fallback();
    });
    await page.goto("/ui/admin/external-scorers");
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
    const again = dialog.getByRole("button", { name: "Try again" });
    await expect(again).toBeVisible();
    await expect(dialog.getByText("Getting ready…")).toHaveCount(0);
    // nothing was resent while the proof was unavailable
    expect(su.attempts).toHaveLength(1);
    await again.click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(optionsFailures).toBe(1);
  });

  test("R3 #1205: activating an ABAC version that relaxes the live one (block back to advise) completes through step-up", async ({ page }) => {
    await mockApi(page);
    const POLICY = "33333333-3333-4333-8333-333333333333";
    const ISO = "2026-11-01T00:00:00Z";
    const version = (n: number, mode: string) => ({ id: `v${n}`, policyId: POLICY, version: n, source: "forbid (principal, action, resource);", schemaVersion: "v3", mode, timezone: "UTC", approverUserId: null, testCases: null, authorUserId: null, createdAt: ISO });
    const policy = { id: POLICY, name: "no-night-writes", description: null, enabled: true, activeVersionId: "v2", createdAt: ISO, activeVersion: 2, mode: "forbid", timezone: "UTC" };
    await page.route("**/v1/abac/**", async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (p === "/v1/abac/schema") return json(route, { engine: "cedar", versions: ["v3"], current: "v3", modes: ["forbid", "require_approval"], schemaText: "entity User;", abacCanGrant: false });
      if (p === "/v1/abac/policies" && method === "GET") return json(route, { engine: "cedar", activeCount: 1, policies: [policy] });
      if (p === `/v1/abac/policies/${POLICY}` && method === "GET") return json(route, { policy, versions: [version(2, "forbid"), version(1, "require_approval")] });
      return route.fallback();
    });
    const su = await requireStepUpOn(page, { method: "POST", path: `/v1/abac/policies/${POLICY}/activate`, kind: "settings_relax" });
    await page.goto("/ui/admin/abac-policies");
    await page.getByRole("cell", { name: "no-night-writes" }).click();
    await page.getByRole("button", { name: "Activate", exact: true }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ version: 1 });
  });
});
