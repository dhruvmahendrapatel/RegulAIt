import { expect, test, type Route } from "@playwright/test";

// X1 / A4 (Governed - Designer, owner-approved 2026-10-19): the (i) panel lives in
// the top layer, so no card or table scroll box can clip it, and it closes the way
// a keyboard, a finger and a mouse each expect.

async function mock(route: Route) {
  const p = new URL(route.request().url()).pathname;
  let body: unknown = {};
  if (p === "/auth/me") body = { userId: "u", isAdmin: true, via: "session", user: { id: "u", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
  else if (p === "/v1/me") body = { userId: "u", isAdmin: true, user: { id: "u", email: "ada@example.test", displayName: "Ada Admin" } };
  else if (p === "/v1/governance/alerts") body = { alerts: [], counts: { open: 0, acknowledged: 0, resolved: 0 }, lastEvaluatedAt: null, rules: [] };
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    return route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth")) ? route.continue() : mock(route);
  });
  await page.goto("/ui/admin/governance/alerts");
});

test("the (i) panel opens in the top layer, inside the viewport, and Escape returns focus", async ({ page }) => {
  // its name flips to "Hide help for …" while open, so match both
  const trigger = page.getByRole("button", { name: /^(What is|Hide help for) the .+ page\??$/ });
  await trigger.click();
  const panel = page.getByRole("note");
  await expect(panel).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  // the top layer: no ancestor's overflow can clip it
  expect(await panel.evaluate((el) => el.matches(":popover-open"))).toBe(true);
  const box = await panel.boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("tabbing away closes the panel, so it never trails behind focus", async ({ page }) => {
  const trigger = page.getByRole("button", { name: /^What is the .+ page\?$/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("note")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("note")).toBeHidden();
});

test("the trigger has a 44px touch target while it draws at 24px", async ({ page }) => {
  const trigger = page.getByRole("button", { name: /^What is the .+ page\?$/ });
  const box = (await trigger.boundingBox())!;
  expect(Math.round(box.width)).toBe(24);
  // 9px outside the drawn button still lands on it (the ::before extends 10px)
  const hit = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x!, y!);
    return el?.closest("button")?.getAttribute("aria-label") ?? null;
  }, [box.x - 9, box.y + box.height / 2]);
  expect(hit).toMatch(/^What is the .+ page\?$/);
});
