/**
 * UI gaps U2 — ABAC editing, simulation and the CI test runner (ADR-0040), and
 * the blast-radius settings and stored preview reads (ADR-0059), against a
 * mocked gateway:
 *
 *  - "Edit" adds version N+1 through POST /v1/abac/policies/:id/versions with
 *    exactly the schema's fields; an `invalid_policy` refusal shows the
 *    validator's own errors;
 *  - Simulate posts only what was stated and never reads a permit as an allow;
 *  - "Run all active tests" reports each active policy;
 *  - turning the preview requirement OFF is confirmed, then resent once through
 *    step-up; a stored preview opens from the history;
 *  - axe (WCAG 2.x A/AA) in light and dark.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ISO = "2026-10-07T10:00:00.000Z";
const POLICY = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SERVER = "33333333-3333-4333-8333-333333333333";
const SIM = "44444444-4444-4444-8444-444444444444";
const SOURCE_V1 = 'forbid (principal, action == RegulAIt::Action::"McpToolCall", resource) when { resource.kind == "write" };';

interface Captured {
  versionPosts: Array<Record<string, unknown>>;
  simulatePosts: Array<Record<string, unknown>>;
  suiteRuns: number;
  settingsPuts: Array<Record<string, unknown>>;
}

async function mockApi(page: Page): Promise<Captured> {
  const cap: Captured = { versionPosts: [], simulatePosts: [], suiteRuns: 0, settingsPuts: [] };
  const me = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "avery@example.test", displayName: "Avery Admin" } };
  const settings = { requirePreviewBeforeActivate: true, defaultWindowDays: 30, defaultRowCap: 5000, updatedByUserId: null, updatedAt: ISO };
  const simRow = {
    id: SIM,
    policyName: "no-night-writes",
    policyVersion: 2,
    considered: 120,
    newlyDenied: 3,
    newlyApprovalRequired: 0,
    newlyAllowed: 0,
    unchanged: 117,
    indeterminate: 0,
    affectedUsers: 1,
    affectedProjects: 1,
    affectedTools: 1,
    capped: false,
    fidelityExact: true,
    fidelityCaveats: [],
    headline: "3 recorded calls by 1 person would now be blocked",
    windowDays: 30,
    blastRadius: { users: [{ userId: USER, label: "Ada Analyst", calls: 3 }], projects: [], tools: [] },
    createdAt: ISO,
  };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/users") return json(route, { users: [{ id: USER, email: "ada@example.test", displayName: "Ada Analyst", isAdmin: false }] });
    if (p === "/v1/servers") return json(route, { servers: [{ id: SERVER, name: "records", transport: "http" }] });
    if (p === `/v1/servers/${SERVER}/tools`) return json(route, { tools: [{ id: "t1", name: "write_record", kind: "write" }] });
    if (p === "/v1/projects") return json(route, { projects: [] });
    if (p === "/v1/abac/schema") {
      return json(route, { engine: "cedar", versions: ["v3"], current: "v3", modes: ["forbid", "require_approval"], schemaText: "entity User;", abacCanGrant: false });
    }
    if (p === "/v1/abac/policies" && method === "GET") {
      return json(route, {
        engine: "cedar",
        activeCount: 1,
        policies: [{ id: POLICY, name: "no-night-writes", description: null, enabled: true, activeVersionId: "v1", createdAt: ISO, activeVersion: 1, mode: "forbid", timezone: "UTC" }],
      });
    }
    if (p === `/v1/abac/policies/${POLICY}` && method === "GET") {
      return json(route, {
        policy: { id: POLICY, name: "no-night-writes", enabled: true, activeVersionId: "v1", createdAt: ISO, activeVersion: 1, mode: "forbid", timezone: "UTC" },
        versions: [{ id: "v1", policyId: POLICY, version: 1, source: SOURCE_V1, schemaVersion: "v3", mode: "forbid", timezone: "UTC", approverUserId: null, testCases: null, authorUserId: null, createdAt: ISO }],
      });
    }
    if (p === `/v1/abac/policies/${POLICY}/versions` && method === "POST") {
      cap.versionPosts.push(req.postDataJSON() as Record<string, unknown>);
      if (cap.versionPosts.length === 1) {
        return json(route, { error: "invalid_policy", ok: false, errors: [{ message: "unknown attribute resource.colour", help: "declare it in the schema" }], warnings: [] }, 422);
      }
      return json(route, { version: { id: "v2", version: 2 }, validation: { ok: true, errors: [], warnings: [] } }, 201);
    }
    if (p === "/v1/abac/simulate" && method === "POST") {
      cap.simulatePosts.push(req.postDataJSON() as Record<string, unknown>);
      return json(route, {
        attributes: { principal: { id: USER }, resource: { toolName: "write_record", kind: "write" } },
        activePolicies: [{ id: POLICY, name: "no-night-writes", mode: "forbid", version: 1, timezone: "UTC" }],
        abacDecision: { effect: "forbid", policyName: "no-night-writes", policyVersion: 1, reason: "no write-capable tool overnight" },
        note: "an ABAC 'permit' means 'nothing forbade this'",
      });
    }
    if (p === "/v1/abac/test" && method === "POST") {
      cap.suiteRuns += 1;
      return json(route, {
        passed: 1,
        failed: 1,
        policies: [
          {
            policyId: POLICY,
            name: "no-night-writes",
            version: 1,
            passed: 1,
            failed: 1,
            results: [
              { name: "night write denied", expected: "match", actual: "match", passed: true },
              { name: "day read allowed", expected: "no_match", actual: "match", passed: false },
            ],
          },
        ],
      });
    }
    if (p === "/v1/policy-simulations/settings" && method === "GET") {
      return json(route, { settings, note: "When ON (the default), activating an un-previewed version is refused.", defaults: { windowDays: 30, rowCap: 5000 } });
    }
    if (p === "/v1/policy-simulations/settings" && method === "PUT") {
      const body = req.postDataJSON() as Record<string, unknown>;
      cap.settingsPuts.push(body);
      Object.assign(settings, body, { updatedAt: new Date().toISOString() });
      return json(route, { settings });
    }
    if (p === `/v1/policy-simulations/${SIM}`) {
      return json(route, { simulation: simRow, samples: [], fidelity: "Dry run over recorded history.", abacCannotGrant: "ABAC cannot grant.", unreplayableAttributes: [] });
    }
    if (p === "/v1/policy-simulations") {
      const { blastRadius: _b, ...summary } = simRow;
      return json(route, { simulations: [summary], fidelity: "Dry run over recorded history." });
    }
    return json(route, {});
  });
  return cap;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([
        Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

test.describe("U2: ABAC editing, simulation and tests", () => {
  test("edit adds a new version; an invalid policy shows the validator's errors", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/abac-policies");
    await page.getByRole("cell", { name: "no-night-writes" }).click();
    await page.getByRole("button", { name: "Edit — add a new version" }).click();
    const form = page.getByRole("form", { name: "Add a policy version" });
    await expect(form.getByLabel("Cedar policy (new version)")).toHaveValue(SOURCE_V1);
    await expectAxeClean(page, "ABAC version editor");

    await form.getByLabel("Timezone the policy reads times in").fill("Europe/London");
    await form.getByRole("button", { name: "Save as new version" }).click();
    await expect(page.getByTestId("abac-version-errors")).toContainText("unknown attribute resource.colour — declare it in the schema");

    await form.getByLabel("Stored test cases (JSON array, optional)").fill("{");
    await form.getByRole("button", { name: "Save as new version" }).click();
    await expect(form.getByRole("alert").first()).toContainText("not valid JSON");
    expect(cap.versionPosts).toHaveLength(1);

    await form.getByLabel("Stored test cases (JSON array, optional)").fill('[{"name":"t","principal":{},"resource":{"toolName":"write_record","kind":"write"},"expect":"match"}]');
    await form.getByRole("button", { name: "Save as new version" }).click();
    await expect.poll(() => cap.versionPosts.length).toBe(2);
    expect(cap.versionPosts[1]).toEqual({
      source: SOURCE_V1,
      mode: "forbid",
      timezone: "Europe/London",
      approverUserId: null,
      testCases: [{ name: "t", principal: {}, resource: { toolName: "write_record", kind: "write" }, expect: "match" }],
    });
    await expect(page.getByRole("form", { name: "Add a policy version" })).toHaveCount(0);
  });

  test("simulate posts only what was stated, and the suite reports failures", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/abac-policies");
    const sim = page.getByRole("form", { name: "Simulate an ABAC request" });
    await sim.getByRole("button", { name: "Simulate" }).click();
    expect(cap.simulatePosts).toHaveLength(0);
    await sim.getByLabel("As user").selectOption(USER);
    await sim.getByLabel("MCP server").selectOption(SERVER);
    await sim.getByLabel("Tool").selectOption("write_record");
    await sim.getByLabel("MFA completed").selectOption("no");
    await sim.getByRole("button", { name: "Simulate" }).click();
    await expect.poll(() => cap.simulatePosts.length).toBe(1);
    expect(cap.simulatePosts[0]).toEqual({ userId: USER, serverId: SERVER, toolName: "write_record", mfaCompleted: false });
    await expect(page.getByTestId("abac-simulation")).toContainText("Denied by 'no-night-writes' v1.");

    await page.getByRole("button", { name: "Run all active tests" }).click();
    await expect(page.getByTestId("abac-suite")).toContainText("1 passed · 1 failed");
    await expect(page.getByTestId("abac-suite")).toContainText("day read allowed");
    expect(cap.suiteRuns).toBe(1);
    await expectAxeClean(page, "ABAC simulate and suite");
  });
});

test.describe("U2: blast-radius settings and stored previews", () => {
  test("turning the preview requirement off is confirmed and resent once through step-up", async ({ page }) => {
    const cap = await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/policy-simulations/settings", kind: "settings_relax" });
    await page.goto("/ui/admin/simulation");
    const form = page.getByRole("form", { name: "Blast-radius settings" });
    await expect(form).toContainText("preview required before activation");
    await expectAxeClean(page, "blast-radius settings");

    await form.getByLabel("Default window (days)").fill("181");
    await form.getByRole("button", { name: "Save settings" }).click();
    await expect(form.getByRole("alert")).toContainText("whole number of days from 1 to 180");

    await form.getByLabel("Default window (days)").fill("30");
    await form.getByLabel(/Require a blast-radius preview/).uncheck();
    await form.getByRole("button", { name: "Save settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Stop requiring a preview before activation?" });
    await expect(dialog).toContainText("still recorded as un-previewed");
    await dialog.getByRole("button", { name: "Turn off the requirement" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(cap.settingsPuts).toEqual([{ requirePreviewBeforeActivate: false }]);
  });

  test("a stored preview opens from the history", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/simulation");
    await page.getByRole("button", { name: "Open the preview of no-night-writes v2" }).click();
    await expect(page.getByText("3 recorded calls by 1 person would now be blocked")).toBeVisible();
    await expect(page.getByText("newly blocked: 3")).toBeVisible();
  });
});
