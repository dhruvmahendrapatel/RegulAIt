/**
 * The enterprise harness's mock API (ADR-0196). Every /v1 and /auth call is answered in the browser, so the
 * harness needs no gateway, database or seed, the same as the mocked UI suite.
 *
 * The signed-in person is an admin with MFA done, so every screen in the census renders. Beyond the session reads,
 * the harness does NOT invent per-page data: a page shows the state its own code shows for the mode below. Per-page
 * fixtures (populated tables, charts) come with the feature-baseline audit and go in FIXTURES.
 *
 *   "error"   (default) every call without a fixture answers 503, so each page renders its error state;
 *   "empty"   every call without a fixture answers 200 with `{}`;
 *   "loading" every call without a fixture is held open until the page is closed, so each page shows its loading
 *             state for as long as the test looks.
 */
import type { Page, Route } from "@playwright/test";

export type MockMode = "error" | "empty" | "loading";

const ADMIN = { id: "00000000-0000-4000-8000-0000000000ad", email: "avery@example.test", displayName: "Avery Admin" };

const authMe = {
  userId: ADMIN.id, isAdmin: true, via: "session", user: ADMIN,
  mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false,
};

/** `"METHOD /path"` → body, answered 200 in every mode */
export const FIXTURES: Record<string, unknown> = {
  "GET /auth/me": authMe,
  "GET /v1/me": { userId: ADMIN.id, isAdmin: true, user: ADMIN },
};

/** signed out: /auth/me answers 401, for the sign-in journey */
export async function mockApi(page: Page, opts: { mode?: MockMode; signedOut?: boolean; extra?: Record<string, unknown> } = {}) {
  const mode = opts.mode ?? "error";
  const fixtures = { ...FIXTURES, ...opts.extra };
  await page.route("**/*", async (route: Route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const key = `${req.method()} ${p}`;
    if (opts.signedOut && (p === "/auth/me" || p === "/v1/me")) return json(route, { error: "unauthorized" }, 401);
    if (key in fixtures) return json(route, fixtures[key]);
    if (mode === "loading") return; // never answered: the request stays pending until the page closes
    if (mode === "empty") return json(route, {});
    return json(route, { error: "unavailable", detail: "the enterprise harness mocks no data for this call" }, 503);
  });
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
