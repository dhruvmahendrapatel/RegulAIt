/**
 * AER-016 (ADR-0179) — a blast-radius preview that reaches its deadline is
 * shown as INCOMPLETE, never as a preview. Against a mocked gateway: the run
 * answers `status: "incomplete"` with how many recorded calls it evaluated,
 * and the page says so instead of rendering any counts or names. A finished
 * run still renders its buckets, including the indeterminate one. Axe in light
 * and dark.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./prompts-fixtures";

const VERSION = "e3333333-3333-4333-8333-333333333333";
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const FIDELITY = "A dry run re-decides RECORDED decisions under a proposed policy version.";

const incomplete = {
  status: "incomplete",
  evaluated: 1234,
  total: 5000,
  capped: false,
  deadlineMs: 20000,
  windowStart: "2026-09-05T10:00:00Z",
  windowEnd: "2026-10-05T10:00:00Z",
  detail:
    "INCOMPLETE: the run reached its 20000 ms deadline after evaluating 1234 of 5000 recorded decision(s). " +
    "No blast radius is reported and no preview was stored, because counts over part of the transcript would " +
    "read as the whole of it. Narrow the window, the subjects or the row cap and run it again.",
  scope: { ruleId: "policy-simulation-scope-org", reason: "admin", orgWide: true },
  fidelity: FIDELITY,
  dryRun: true,
};

const complete = {
  status: "complete",
  simulation: {
    id: "f4444444-4444-4444-8444-444444444444",
    policyName: "after-hours",
    policyVersion: 2,
    windowDays: 30,
    considered: 40,
    capped: false,
    newlyDenied: 3,
    newlyApprovalRequired: 0,
    newlyAllowed: 0,
    unchanged: 35,
    indeterminate: 2,
    affectedUsers: 1,
    affectedProjects: 1,
    affectedTools: 1,
    headline: "this change BLOCKS 3 call(s) that succeeded across 1 user(s), 1 tool(s) and 1 project(s)",
    fidelityExact: true,
    fidelityCaveats: [],
    blastRadius: {
      users: [{ userId: "u1", label: "Grace", calls: 3 }],
      projects: [{ projectId: null, name: null, calls: 3 }],
      tools: [{ serverId: "s1", toolName: "search", calls: 3 }],
    },
    createdAt: "2026-10-05T10:00:00Z",
  },
  samples: [],
  fidelity: FIDELITY,
  abacCannotGrant: "newly_allowed is structurally always zero for an ABAC candidate.",
  dryRun: true,
};

async function mockApi(page: Page, run: () => unknown) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me")
      return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } });
    if (p === "/v1/users") return json(route, { users: [] });
    if (p === "/v1/servers") return json(route, { servers: [] });
    if (p === "/v1/policy-simulations" && route.request().method() === "POST") return json(route, run(), 200);
    if (p === "/v1/policy-simulations") return json(route, { simulations: [], fidelity: FIDELITY });
    return json(route, {});
  });
}

test("a run that hit its deadline is shown as incomplete — no counts, no names", async ({ page }) => {
  await mockApi(page, () => incomplete);
  await page.goto("/ui/admin/simulation");
  await page.getByLabel("Proposed policy version id").fill(VERSION);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const notice = page.getByTestId("simulation-incomplete");
  await expect(notice).toContainText("Incomplete: 1234 of 5000 recorded calls evaluated");
  await expect(notice).toContainText("no preview was stored");
  // nothing that would read as a finished preview
  await expect(page.getByText(/newly blocked:/)).toHaveCount(0);
  await expect(page.getByText("Who — named, not counted")).toHaveCount(0);
  await expectAxeClean(page, "policy simulation incomplete");
});

test("a finished run still renders its buckets, the indeterminate one included", async ({ page }) => {
  await mockApi(page, () => complete);
  await page.goto("/ui/admin/simulation");
  await page.getByLabel("Proposed policy version id").fill(VERSION);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByText("newly blocked: 3")).toBeVisible();
  await expect(page.getByText("could not be replayed exactly: 2")).toBeVisible();
  await expect(page.getByTestId("simulation-incomplete")).toHaveCount(0);
  await expectAxeClean(page, "policy simulation complete");
});
