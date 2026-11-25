/**
 * Codex review cards CXR-ADM-002, -005, -006, -007, -008, -009 and CXR-RUN-001:
 * admin and builder screens say what they actually did, against an in-test mock.
 *
 *  - External scorers: the copy separates eval use from inline trained-detector use and links to Guardrails.
 *  - Guardrails sample: labelled as local rules, sends the chosen phase, marks a result stale when the text
 *    changes, and shows a failed run inline in the card.
 *  - Credentials: no count before the inventory reads; a refused threshold save keeps the typed value.
 *  - Enforcement posture: the bulk harden asks first, listing the controls it would change.
 *  - Playground: a failed datasets or prompt read is an inline alert with Retry.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ME = { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };

type Handler = (route: Route, p: string, method: string, url: URL) => Promise<void> | void | "next";
async function mock(page: Page, handler: Handler) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me") return json(route, ME);
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user: ME.user });
    const out = await handler(route, p, method, url);
    if (out === "next") return json(route, {});
    return undefined;
  });
}

test("CXR-ADM-002: external scorers copy names both uses and links to the trained detectors", async ({ page }) => {
  await mock(page, (route, p) => {
    if (p === "/v1/external-scorers") return json(route, { scorers: [] });
    return "next";
  });
  await page.goto("/ui/admin/external-scorers");
  const main = page.locator("main");
  await expect(main.getByText("inline on live requests only when it backs a trained detector")).toBeVisible();
  await expect(main.getByRole("link", { name: "Guardrails" }).first()).toHaveAttribute("href", "/ui/admin/guardrails");
  await page.getByRole("button", { name: "What is an external score?" }).click();
  const note = page.getByRole("note");
  await expect(note).toContainText("Inline trained detectors (ADR-0220)");
  await expect(note).toContainText("the prompt or completion text of live requests is sent to that scorer");
  await expect(note).not.toContainText("stays local-detector only");
});

test.describe("CXR-ADM-005/006: the guardrails sample card", () => {
  async function guardrailsMock(page: Page, sample: (route: Route) => Promise<void> | void) {
    const posts: Array<Record<string, unknown>> = [];
    await mock(page, async (route, p, method) => {
      if (p === "/v1/guardrails/detectors") return json(route, { detectors: [], shippedDefaults: {}, note: "" });
      if (p === "/v1/guardrails/config") return json(route, { org: null, orgModes: {}, shippedDefaults: {}, overrides: [] });
      if (p.startsWith("/v1/guardrails/violations")) return json(route, { violations: [], totals: {}, note: "" });
      if (p === "/v1/guardrails/trained-detectors") return json(route, { detectors: [], scorers: [] });
      if (p === "/v1/guardrails/sample" && method === "POST") {
        posts.push(route.request().postDataJSON() as Record<string, unknown>);
        return sample(route);
      }
      return "next";
    });
    return posts;
  }

  test("labelled as local rules, sends the phase, and a changed text marks the result stale", async ({ page }) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const posts = await guardrailsMock(page, async (route) => {
      await gate;
      return json(route, { phase: "output", clean: false, findings: [{ detector: "pii", category: "email", count: 1 }], note: "" });
    });
    await page.goto("/ui/admin/guardrails");
    await page.getByRole("tab", { name: "Test local rules" }).click();
    const panel = page.locator("#guardrails-panel-sample");
    await expect(panel.getByText("Trained detectors, external scorers and per-agent overrides are not run here.")).toBeVisible();
    await panel.getByLabel("Phase").selectOption("output");
    await panel.getByLabel("Sample text").fill("mail me at a@example.test");
    await panel.getByRole("button", { name: "Test local rules", exact: true }).click();
    await expect(panel.getByRole("status").filter({ hasText: "Running the local rules" })).toBeVisible();
    release();
    await expect(panel.getByText("pii:email ×1")).toBeVisible();
    expect(posts).toEqual([{ text: "mail me at a@example.test", phase: "output" }]);
    await panel.getByLabel("Sample text").fill("something else");
    await expect(panel.getByText("pii:email ×1")).toHaveCount(0);
    await expect(panel.getByText(/Stale: the text or phase changed/)).toBeVisible();
  });

  test("a failed run is said inline in the card", async ({ page }) => {
    await guardrailsMock(page, (route) => json(route, { error: "internal", message: "detector store unavailable" }, 500));
    await page.goto("/ui/admin/guardrails");
    await page.getByRole("tab", { name: "Test local rules" }).click();
    const panel = page.locator("#guardrails-panel-sample");
    await panel.getByLabel("Sample text").fill("hello");
    await panel.getByRole("button", { name: "Test local rules", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("The test did not run");
  });
});

test.describe("CXR-ADM-007/008: credentials", () => {
  const inventory = {
    generatedAt: "2026-10-04T12:00:00.000Z",
    unusedDays: 90,
    alerting: false,
    linkWindowDays: 90,
    types: [],
    notStored: [],
    flagLabels: {},
    counts: { total: 3, flagged: 1, byFlag: {} },
    alertPreview: { episodes: 0, credentials: 0 },
    items: [],
    nextCursor: null,
    nextOffset: null,
    total: 0,
    totalIsEstimate: false,
  };

  test("a failed inventory read shows no count, not zero", async ({ page }) => {
    await mock(page, (route, p) => {
      if (p === "/v1/admin/credentials") return json(route, { error: "internal" }, 500);
      return "next";
    });
    await page.goto("/ui/admin/credentials");
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Inventory · —")).toBeVisible();
    await expect(page.getByText(/0 credentials, 0 flagged/)).toHaveCount(0);
  });

  test("a refused threshold save keeps the typed value", async ({ page }) => {
    const puts: unknown[] = [];
    await mock(page, (route, p, method) => {
      if (p === "/v1/admin/credentials") return json(route, inventory);
      if (p === "/v1/org/settings" && method === "PUT") {
        puts.push(route.request().postDataJSON());
        return json(route, { error: "validation", message: "refused" }, 422);
      }
      return "next";
    });
    await page.goto("/ui/admin/credentials");
    await expect(page.getByText("Inventory · 3 credentials, 1 flagged")).toBeVisible();
    const days = page.getByLabel("Unused threshold in days");
    await days.fill("45");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => puts.length).toBe(1);
    await page.waitForTimeout(300);
    await expect(days).toHaveValue("45");
  });
});

test("CXR-ADM-009: the bulk harden asks first and lists the controls it would change", async ({ page }) => {
  const posts: string[] = [];
  const controls = [
    { key: "mcpAdmissionMode", group: "enforcement", current: "off", hardened: "enforce", satisfied: false, settable: true, refuses: "connecting to an unscanned MCP server." },
    { key: "useCaseGateMode", group: "enforcement", current: "enforce", hardened: "enforce", satisfied: true, settable: true, refuses: "a dispatch with no approved use case." },
    { key: "schedulerEnabled", group: "enforcement", current: false, hardened: true, satisfied: false, settable: false, refuses: "nothing directly." },
  ];
  await mock(page, (route, p, method) => {
    if (p === "/v1/org/posture/harden" && method === "POST") {
      posts.push(p);
      return json(route, { ok: true });
    }
    if (p === "/v1/org/posture")
      return json(route, {
        hardened: false,
        summary: { enforcementSatisfied: 1, enforcementTotal: 3, optimisationSatisfied: 0, optimisationTotal: 0, blockedByEnvironment: ["schedulerEnabled"] },
        controls,
        execution: { mode: "normal", reason: null, setAt: null, restricted: false, note: "Executing normally." },
      });
    return "next";
  });
  await page.goto("/ui/admin/enforcement-posture");
  await page.getByRole("button", { name: "Harden enforcement controls" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const list = dialog.getByRole("list", { name: "Controls that would change" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("MCP admission scanning");
  expect(posts).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(posts).toEqual([]);
  await page.getByRole("button", { name: "Harden enforcement controls" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Harden 1 control" }).click();
  await expect.poll(() => posts.length).toBe(1);
});

test("CXR-RUN-001: the playground says a failed datasets read, with Retry", async ({ page }) => {
  let datasetsFail = true;
  await mock(page, (route, p) => {
    if (p === "/v1/evals/datasets")
      return datasetsFail ? json(route, { error: "internal" }, 503) : json(route, { datasets: [{ id: "d1", name: "Golden set", version: 2 }] });
    if (p === "/v1/agents" || p.endsWith("/agents")) return json(route, { agents: [] });
    return "next";
  });
  await page.goto("/ui/builder/playground");
  await page.getByRole("radio", { name: "Evaluate" }).or(page.getByRole("button", { name: "Evaluate" })).first().click();
  const alert = page.locator("main").getByRole("alert").filter({ hasText: "Couldn't load the evaluation datasets" });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  datasetsFail = false;
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByLabel("Rows from").locator("option", { hasText: "Golden set" })).toHaveCount(1);
});

test("CXR-RUN-001: the playground says a failed read of the prompt it was asked to open, with Retry", async ({ page }) => {
  let fail = true;
  await mock(page, (route, p) => {
    if (p === "/v1/prompts/p-missing") return fail ? json(route, { error: "internal" }, 503) : json(route, { error: "not_found" }, 404);
    return "next";
  });
  await page.goto("/ui/builder/playground?prompt=p-missing");
  const alert = page.locator("main").getByRole("alert").filter({ hasText: "Couldn't open this prompt" });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
});
