/**
 * Force-delete of a held role and of a team that owns shared context, against a mocked gateway.
 *
 * Both pages used to send the force-delete with a hand-written `fetch`; they now use the shared client's
 * `api.del(path, body)`. This pins the contract that change must keep: the first DELETE has no body; the 409 opens
 * the reason prompt; the second DELETE carries `{ force: true, reason }` as JSON, with the CSRF header.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const ROLE = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

interface Del {
  path: string;
  body: unknown;
  csrf: string | null;
  contentType: string | null;
}

async function mock(page: Page): Promise<Del[]> {
  const dels: Del[] = [];
  const me = { id: "riley", email: "riley@example.test", displayName: "Riley Admin" };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const m = req.method();
    if (p === "/auth/me") return json(route, { userId: me.id, isAdmin: true, via: "session", user: me, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: me.id, isAdmin: true, user: me });
    if (p === "/v1/roles" && m === "GET") return json(route, { roles: [{ id: ROLE, name: "reviewers", description: null }] });
    if (p === "/v1/teams" && m === "GET") {
      return json(route, { items: [{ id: TEAM, name: "platform", memberCount: 2, createdAt: "2026-11-01T00:00:00Z" }], nextCursor: null, nextOffset: null, total: 1, totalIsEstimate: false });
    }
    if (m === "DELETE" && (p === `/v1/roles/${ROLE}` || p === `/v1/teams/${TEAM}`)) {
      const raw = req.postData();
      const body = raw ? JSON.parse(raw) : null;
      const h = req.headers();
      dels.push({ path: p, body, csrf: h["x-regulait-csrf"] ?? null, contentType: h["content-type"] ?? null });
      if (!body) {
        return p.includes("/roles/")
          ? json(route, { error: "role_held", holders: ["sam@example.test"] }, 409)
          : json(route, { error: "team_owns_shared_context", contextItems: 3, projects: ["Atlas"] }, 409);
      }
      return json(route, { ok: true });
    }
    if (m === "GET") return json(route, {});
    return json(route, { error: "not_found" }, 404);
  });
  return dels;
}

test.describe("force-delete through the shared client", () => {
  test("a held role is force-deleted with a recorded reason", async ({ page }) => {
    const dels = await mock(page);
    await page.goto("/ui/admin/roles");
    await page.getByRole("button", { name: "delete", exact: true }).click();
    await page.getByRole("dialog", { name: "Delete role “reviewers”?" }).getByRole("button", { name: "Delete role" }).click();
    const prompt = page.getByRole("dialog", { name: "Role “reviewers” is still held" });
    await expect(prompt.getByText(/sam@example\.test/)).toBeVisible();
    await prompt.getByLabel("Reason").fill("Role retired with the old review flow");
    await prompt.getByRole("button", { name: "Force delete" }).click();
    await expect.poll(() => dels.length).toBe(2);
    expect(dels[0]).toMatchObject({ path: `/v1/roles/${ROLE}`, body: null, csrf: "1" });
    expect(dels[1]).toEqual({ path: `/v1/roles/${ROLE}`, body: { force: true, reason: "Role retired with the old review flow" }, csrf: "1", contentType: "application/json" });
    await expect(page.getByText("Role force-deleted — holders unassigned, reason audited").first()).toBeVisible();
  });

  test("a team that owns shared context is force-deleted with a recorded reason", async ({ page }) => {
    const dels = await mock(page);
    await page.goto("/ui/admin/teams");
    await page.getByRole("button", { name: "delete team" }).click();
    await page.getByRole("dialog", { name: /Delete team/ }).getByRole("button", { name: "Delete team" }).click();
    const prompt = page.getByRole("dialog", { name: "Team “platform” owns shared context" });
    await prompt.getByLabel("Reason").fill("Team merged into platform-core");
    await prompt.getByRole("button", { name: "Force delete" }).click();
    await expect.poll(() => dels.length).toBe(2);
    expect(dels[1]).toEqual({ path: `/v1/teams/${TEAM}`, body: { force: true, reason: "Team merged into platform-core" }, csrf: "1", contentType: "application/json" });
  });
});
