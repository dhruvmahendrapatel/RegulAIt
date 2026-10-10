/**
 * ADR-0186 A — a mocked step-up in front of any protected write, for the
 * *.mock.spec.ts harness. Register it AFTER the spec's own mock (Playwright
 * runs the most recently registered matching route first):
 *
 *   const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/org/settings", kind: "settings_relax" });
 *   … drive the screen …
 *   await confirmStepUp(page);
 *   await su.expectResentOnce();
 *
 * The first matching request (no `x-regulait-step-up`) is refused 403
 * `step_up_required`; the dialog's `options` and `verify` are answered here
 * (an authenticator code); the retried request carries the grant and falls
 * through to the spec's own mock, which answers it as before.
 */
import { expect, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

export interface StepUpHarness {
  attempts: Array<{ header: string | null; body: unknown }>;
  optionsCalls: unknown[];
  verifies: unknown[];
  /** the protected request went out twice: refused without a grant, then resent once, unchanged, with it */
  expectResentOnce(): Promise<void>;
}

export async function requireStepUpOn(
  page: Page,
  opts: { method: string; path: string | RegExp; kind: string; facts?: (body: unknown) => Record<string, unknown> },
): Promise<StepUpHarness> {
  const h: StepUpHarness = {
    attempts: [],
    optionsCalls: [],
    verifies: [],
    async expectResentOnce() {
      await expect.poll(() => h.attempts.length, { message: "the protected request was resent with the grant" }).toBe(2);
      expect(h.attempts[0]!.header).toBeNull();
      expect(h.attempts[1]!.header).toBe("rgsu_1");
      expect(h.attempts[1]!.body).toEqual(h.attempts[0]!.body);
      expect(h.optionsCalls).toHaveLength(1);
      expect(h.verifies).toHaveLength(1);
      await expect(page.getByRole("dialog", { name: "Confirm it's you" })).toHaveCount(0);
    },
  };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === "/v1/auth/step-up/options" && req.method() === "POST") {
      h.optionsCalls.push(req.postDataJSON());
      const action = (req.postDataJSON() as { action: { kind: string } }).action;
      return json(route, {
        stepUpId: "33333333-3333-4333-8333-333333333333",
        actionKind: action.kind,
        methods: ["totp"],
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    if (p === "/v1/auth/step-up/verify" && req.method() === "POST") {
      h.verifies.push(req.postDataJSON());
      return json(route, { stepUpToken: `rgsu_${h.verifies.length}`, expiresAt: new Date(Date.now() + 120_000).toISOString() });
    }
    const matches = typeof opts.path === "string" ? p === opts.path : opts.path.test(p);
    if (!matches || req.method() !== opts.method) return route.fallback();
    const header = req.headers()["x-regulait-step-up"] ?? null;
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    h.attempts.push({ header, body });
    if (header) return route.fallback();
    return json(
      route,
      {
        error: "step_up_required",
        actionKind: opts.kind,
        methods: ["totp"],
        action: { kind: opts.kind, body: opts.facts ? opts.facts(body) : { values: body } },
        detail: "this action needs you to confirm it's you",
      },
      403,
    );
  });
  return h;
}

/** answer the open "Confirm it's you" dialog with an authenticator code */
export async function confirmStepUp(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await dialog.getByLabel("Authenticator code").fill("123456");
  await dialog.getByRole("button", { name: "Confirm with code" }).click();
}
