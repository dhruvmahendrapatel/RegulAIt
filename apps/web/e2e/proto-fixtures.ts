/** ADR-0208 (G7–G9): the shared mocked shell for the lifecycle mock specs (compliance profiles, infrastructure, libraries). */
import type { Page, Route } from "@playwright/test";

export const ISO = "2026-10-29T10:00:00.000Z";
export const ME = "11111111-1111-4111-8111-111111111111";
export const AVERY = "11111111-1111-4111-8111-111111111112";
export const MORGAN = "11111111-1111-4111-8111-111111111113";

export const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const user = (id: string, displayName: string, email: string) => ({
  id, email, displayName, isAdmin: true, disabledAt: null, createdAt: "2026-01-01T00:00:00Z", totpEnabled: true, hasPassword: true,
});
export const USERS = [user(ME, "Ada Admin", "ada@example.test"), user(AVERY, "Avery Approver", "avery@example.test"), user(MORGAN, "Morgan Reyes", "morgan@example.test")];

export type Handler = (p: string, method: string, body: any, route: Route) => Promise<unknown> | unknown | undefined;

/** /auth/me, /v1/me, /v1/users, /v1/projects, then `handler`, then {} for anything else */
export async function mockApi(page: Page, handler: Handler) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const me = { userId: ME, isAdmin: true, user: { id: ME, email: "ada@example.test", displayName: "Ada Admin" } };
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    if (req.method() !== "GET") calls.push({ method: req.method(), path: p, body });
    const out = handler(p, req.method(), body, route);
    if (out !== undefined) {
      await out;
      return;
    }
    if (p === "/v1/users") return json(route, { users: USERS });
    if (p === "/v1/projects")
      return json(route, { projects: [{ id: "p1", name: "Credit operations", costCenter: null, budgetUsd: null, spentUsd: 0 }] });
    return json(route, {});
  });
  return { calls };
}
