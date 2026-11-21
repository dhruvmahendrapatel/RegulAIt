/**
 * ADR-0315 slice 2 (E3, #1117): the "Issued credentials" tab on the Agent credentials page, against a mocked gateway.
 *
 *  - the tab reads nothing until it opens, then pages the ADR-0226 list (issued ones by default, newest first) with
 *    audience names joined from the registry;
 *  - the state filter and a whole grant id reach the route; a partial grant id is not sent;
 *  - Revoke asks for a reason and sends nothing without one, then POSTs `{ reason }` for that jti;
 *  - a 404 (already revoked) keeps the dialog open with the reason and says so in words;
 *  - a revoked row offers no Revoke; the Excel download asks for the export path with the same filters;
 *  - axe (WCAG 2.x A/AA) in light and dark on the tab and the dialog, and no sideways scroll at 390 px.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const A1 = "44444444-4444-4444-8444-444444444444";
const G1 = "77777777-7777-4777-8777-777777777777";
const THEMES = ["light", "dark"] as const;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

const cred = (jti: string, state: "issued" | "revoked") => ({
  jti,
  audienceId: A1,
  grantId: G1,
  statusIndex: 3,
  state,
  expired: false,
  issuedAt: "2026-11-20T10:00:00Z",
  expiresAt: "2026-11-20T10:05:00Z",
  revokedAt: state === "revoked" ? "2026-11-20T10:02:00Z" : null,
});

interface Calls {
  lists: URLSearchParams[];
  revokes: Array<{ jti: string; body: unknown }>;
  exports: URLSearchParams[];
}

async function mock(page: Page, opts: { revokeGone?: boolean } = {}): Promise<Calls> {
  const calls: Calls = { lists: [], revokes: [], exports: [] };
  const me = { id: "riley", email: "riley@example.test", displayName: "Riley Admin" };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const m = req.method();
    if (p === "/auth/me") return json(route, { userId: me.id, isAdmin: true, via: "session", user: me, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: me.id, isAdmin: true, user: me });
    if (p === "/v1/agent-credentials/audiences") {
      return json(route, {
        audiences: [
          { id: A1, audience: "https://api.example.test/payments", name: "payments-api", algorithm: "ES256", binding: "dpop", maxTtlSeconds: 300, state: "enabled", enabled: true, disabledAt: null, createdAt: "2026-11-19T00:00:00Z", scopes: [] },
        ],
      });
    }
    if (p === "/v1/agent-credentials/issued" && m === "GET") {
      calls.lists.push(url.searchParams);
      const st = url.searchParams.get("state");
      const items = st === "revoked" ? [cred("jti-revoked-000000000002", "revoked")] : [cred("jti-issued-0000000000001", "issued")];
      return json(route, { items, nextCursor: null, nextOffset: null, total: items.length, totalIsEstimate: false });
    }
    if (p === "/v1/agent-credentials/issued/export.xlsx") {
      calls.exports.push(url.searchParams);
      return route.fulfill({ status: 200, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: Buffer.from("PK") });
    }
    const rv = /^\/v1\/agent-credentials\/issued\/([^/]+)\/revoke$/.exec(p);
    if (rv && m === "POST") {
      calls.revokes.push({ jti: decodeURIComponent(rv[1]!), body: req.postDataJSON() });
      if (opts.revokeGone) return json(route, { error: "unknown_credential", detail: "no unrevoked credential with that jti" }, 404);
      return json(route, { jti: rv[1], state: "revoked", revokedAt: "2026-11-21T00:00:00Z" });
    }
    if (m === "GET") return json(route, {});
    return json(route, { error: "not_found" }, 404);
  });
  return calls;
}

async function openTab(page: Page) {
  await page.goto("/ui/admin/agent-credentials");
  await expect(page.getByRole("heading", { name: "Agent credentials" })).toBeVisible();
  await page.getByRole("tab", { name: "Issued credentials" }).click();
  return page.getByRole("tabpanel", { name: "Issued credentials" });
}

test.describe("ADR-0315 slice 2: issued agent credentials", () => {
  test("reads nothing until the tab opens, then lists issued credentials with names, filters and the export", async ({ page }) => {
    const calls = await mock(page);
    await page.goto("/ui/admin/agent-credentials");
    await expect(page.getByRole("tab", { name: "Audiences" })).toHaveAttribute("aria-selected", "true");
    expect(calls.lists).toEqual([]);

    const panel = await openTab(page);
    await expect(panel.getByText("jti-issued-0000000000001")).toBeVisible();
    await expect(panel.getByRole("cell", { name: "payments-api" })).toBeVisible();
    await expect(panel.getByText(/also stops working when its grant is revoked/)).toBeVisible();
    expect(calls.lists[0]!.get("state")).toBe("issued");
    await expectAxeClean(page, "issued credentials tab");

    await panel.getByRole("textbox", { name: "Grant id" }).fill("7777");
    await expect(panel.getByText(/Paste the grant's whole id/)).toBeVisible();
    await panel.getByRole("textbox", { name: "Grant id" }).fill(G1);
    await expect.poll(() => calls.lists.at(-1)?.get("grantId")).toBe(G1);
    expect(calls.lists.some((q) => q.get("grantId") === "7777")).toBe(false);

    await panel.getByRole("combobox", { name: "State" }).selectOption("revoked");
    await expect(panel.getByText("jti-revoked-000000000002")).toBeVisible();
    await expect(panel.getByRole("button", { name: /Revoke credential/ })).toHaveCount(0);

    await panel.getByRole("button", { name: "Download Excel" }).click();
    await expect.poll(() => calls.exports.length).toBe(1);
    expect(calls.exports[0]!.get("state")).toBe("revoked");
    expect(calls.exports[0]!.get("grantId")).toBe(G1);
  });

  test("revoking asks for a reason, then sends it for that jti", async ({ page }) => {
    const calls = await mock(page);
    const panel = await openTab(page);
    await panel.getByRole("button", { name: "Revoke credential jti-issued-0000000000001" }).click();
    const dialog = page.getByRole("dialog", { name: /Revoke credential/ });
    await expect(dialog.getByText(/cannot be undone/)).toBeVisible();
    await expect(dialog.getByText(/within about a minute/)).toBeVisible();
    await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(dialog.getByText(/Say why it is revoked/)).toBeVisible();
    expect(calls.revokes).toEqual([]);
    await expectAxeClean(page, "revoke dialog");

    await dialog.getByRole("textbox", { name: "Reason" }).fill("  key copied to a laptop  ");
    await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect.poll(() => calls.revokes).toEqual([{ jti: "jti-issued-0000000000001", body: { reason: "key copied to a laptop" } }]);
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/revoked\. Outside verifiers see it within about a minute/).first()).toBeVisible();
  });

  test("an already-revoked credential keeps the dialog and the reason, and says so", async ({ page }) => {
    const calls = await mock(page, { revokeGone: true });
    const panel = await openTab(page);
    await panel.getByRole("button", { name: "Revoke credential jti-issued-0000000000001" }).click();
    const dialog = page.getByRole("dialog", { name: /Revoke credential/ });
    await dialog.getByRole("textbox", { name: "Reason" }).fill("rotating");
    await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect.poll(() => calls.revokes.length).toBe(1);
    await expect(dialog.getByText("That credential is already revoked or no longer exists. The list has been refreshed.")).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Reason" })).toHaveValue("rotating");
  });

  test("no sideways scroll at 390 px", async ({ page }) => {
    await mock(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const panel = await openTab(page);
    await expect(panel.getByText("jti-issued-0000000000001")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
