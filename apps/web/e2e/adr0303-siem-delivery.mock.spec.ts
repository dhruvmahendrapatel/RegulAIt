/**
 * ADR-0303 — the SIEM delivery page, against a mocked gateway:
 *
 *  - a new destination is created OFF and its signing secret is shown once (with the "stored encrypted" sentence, not
 *    the "only a hash" one);
 *  - turning it on is confirmed, then goes through the step-up prompt (settings_relax) and is resent once; turning it
 *    off is a plain PUT;
 *  - a dead-lettered destination shows the stored error in plain words and can be recovered (no step-up); recover is
 *    off, with its reason, while delivery is healthy;
 *  - a backing-off destination says when it tries next, read forwards ("next try in 1h"), never "just now";
 *  - rotating the secret is confirmed and step-up'd, and shows the new secret once; a syslog destination cannot rotate;
 *  - axe (WCAG 2.x A/AA) in light and dark on the page.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";
const RETRY = "44444444-4444-4444-8444-444444444444";
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

const base = {
  kind: "webhook",
  allowPlaintextHttp: false,
  cursorSeq: 100,
  consecutiveFailures: 0,
  nextAttemptAt: null,
  lastAttemptAt: "2026-11-20T03:00:00Z",
  lastSuccessAt: "2026-11-20T03:00:00Z",
  lastErrorCode: null,
  deliveredEvents: 100,
  secretRotatedAt: "2026-11-01T00:00:00Z",
  createdAt: "2026-11-01T00:00:00Z",
};

interface State {
  posts: unknown[];
  puts: Array<{ id: string; body: unknown; stepUp: string | null }>;
  recovers: string[];
}

async function mock(page: Page): Promise<State> {
  const state: State = { posts: [], puts: [], recovers: [] };
  const rows: Record<string, unknown>[] = [
    { ...base, id: A, name: "splunk-hec", url: "https://siem.example.test/in", enabled: true, state: "dead_letter", lag: 4200, consecutiveFailures: 12, lastErrorCode: "egress_blocked" },
    // backing off: its next try is 90 minutes away, so the row must not say "just now" (review #1108 [1])
    { ...base, id: RETRY, name: "sentinel-eu", enabled: true, state: "backoff", lag: 30, consecutiveFailures: 2, lastErrorCode: "http_5xx", nextAttemptAt: new Date(Date.now() + 90 * 60_000).toISOString() },
    { ...base, id: B, name: "syslog-dc", kind: "syslog_tls", url: "syslog+tls://logs.example.test:6514", enabled: true, state: "active", lag: 0, secretRotatedAt: null },
  ];
  const me = { id: "riley", email: "riley@example.test", displayName: "Riley Admin" };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const m = req.method();
    if (p === "/auth/me") return json(route, { userId: me.id, isAdmin: true, via: "session", user: me, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: me.id, isAdmin: true, user: me });
    if (p === "/v1/siem/destinations" && m === "GET") {
      return json(route, { destinations: rows, headSeq: 4300, envelope: { schema: "regulait.siem.audit.v1", fields: ["seq", "at", "action"], note: "" } });
    }
    if (p === "/v1/siem/destinations" && m === "POST") {
      const body = req.postDataJSON() as { name: string; url: string };
      state.posts.push(body);
      const d = { ...base, id: NEW, name: body.name, url: body.url, enabled: false, state: "active", lag: 0, lastSuccessAt: null, deliveredEvents: 0 };
      rows.push(d);
      return json(route, { destination: d, secret: "TESTONLY-not-a-secret-1" }, 201);
    }
    const en = /^\/v1\/siem\/destinations\/([^/]+)\/enabled$/.exec(p);
    if (en && m === "PUT") {
      const body = req.postDataJSON() as { enabled: boolean };
      state.puts.push({ id: en[1]!, body, stepUp: req.headers()["x-regulait-step-up"] ?? null });
      const row = rows.find((r) => r.id === en[1])!;
      row.enabled = body.enabled;
      return json(route, { destination: row });
    }
    const rec = /^\/v1\/siem\/destinations\/([^/]+)\/recover$/.exec(p);
    if (rec && m === "POST") {
      state.recovers.push(rec[1]!);
      const row = rows.find((r) => r.id === rec[1])!;
      row.state = "active";
      return json(route, { destination: row });
    }
    const rot = /^\/v1\/siem\/destinations\/([^/]+)\/rotate-secret$/.exec(p);
    if (rot && m === "POST") return json(route, { destination: rows.find((r) => r.id === rot[1]), secret: "TESTONLY-not-a-secret-2" });
    if (m === "GET") return json(route, {});
    return json(route, { error: "not_found" }, 404);
  });
  return state;
}

test.describe("ADR-0303: SIEM delivery", () => {
  test("shows state and lag, recovers a stopped destination, and explains what is off", async ({ page }) => {
    const state = await mock(page);
    await page.goto("/ui/admin/siem");
    await expect(page.getByRole("heading", { name: "SIEM delivery" })).toBeVisible();
    await expect(page.getByText("Stopped after failures")).toBeVisible();
    await expect(page.getByText("The host is not on this deployment's egress allow-list.")).toBeVisible();
    await expect(page.getByText("4,200")).toBeVisible();
    await expect(page.getByText("next try in 1h")).toBeVisible();
    await expect(page.getByText(/next try just now/)).toHaveCount(0);
    // healthy: nothing to recover; syslog: no secret to rotate
    await expect(page.getByRole("button", { name: "Recover syslog-dc" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Rotate the secret of syslog-dc" })).toBeDisabled();
    await expectAxeClean(page, "SIEM delivery");
    await page.getByRole("button", { name: "Recover splunk-hec" }).click();
    await expect.poll(() => state.recovers).toEqual([A]);
    await expect(page.getByText("splunk-hec is back to delivery now.").first()).toBeVisible();
  });

  test("adds a destination off, shows its secret once, and turns it on through the step-up prompt", async ({ page }) => {
    const state = await mock(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: `/v1/siem/destinations/${NEW}/enabled`, kind: "settings_relax", when: (b) => (b as { enabled?: boolean }).enabled === true });
    await page.goto("/ui/admin/siem");
    // the browser-side URL check
    await page.getByRole("textbox", { name: "Name" }).fill("sentinel");
    await page.getByRole("textbox", { name: "Receiver URL" }).fill("http://sentinel.internal/in");
    await page.getByRole("button", { name: "Add destination" }).click();
    await expect(page.getByText(/allow plain http below/)).toBeVisible();
    expect(state.posts).toEqual([]);
    await page.getByRole("textbox", { name: "Receiver URL" }).fill("https://sentinel.example.test/in");
    await page.getByRole("button", { name: "Add destination" }).click();
    await expect(page.getByTestId("revealed-secret")).toHaveText("TESTONLY-not-a-secret-1");
    await expect(page.getByText(/stored encrypted under this deployment's data key/)).toBeVisible();
    await expect(page.getByText(/keeps only a hash/)).toHaveCount(0);
    expect(state.posts).toEqual([{ name: "sentinel", url: "https://sentinel.example.test/in" }]);

    await page.getByRole("button", { name: "Turn on sentinel" }).click();
    await page.getByRole("dialog", { name: "Turn on sentinel?" }).getByRole("button", { name: "Turn on" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ enabled: true });

    // turning off needs no step-up
    await page.getByRole("button", { name: "Turn off splunk-hec" }).click();
    await expect.poll(() => state.puts.find((x) => x.id === A)).toEqual({ id: A, body: { enabled: false }, stepUp: null });
  });

  test("rotates a webhook destination's secret through the step-up prompt and shows it once", async ({ page }) => {
    await mock(page);
    const su = await requireStepUpOn(page, { method: "POST", path: `/v1/siem/destinations/${A}/rotate-secret`, kind: "settings_relax" });
    await page.goto("/ui/admin/siem");
    await page.getByRole("button", { name: "Rotate the secret of splunk-hec" }).click();
    await page.getByRole("dialog", { name: "Rotate the signing secret of splunk-hec?" }).getByRole("button", { name: "Rotate secret" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    await expect(page.getByTestId("revealed-secret")).toHaveText("TESTONLY-not-a-secret-2");
  });
});
