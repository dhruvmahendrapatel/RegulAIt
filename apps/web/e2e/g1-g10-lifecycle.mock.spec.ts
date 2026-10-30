/**
 * #453 prototype screenshots — G1 project archive and G10 rename roles/teams (mocked gateway, routes do not exist yet).
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ISO = "2026-10-20T10:00:00.000Z";

type Handler = (p: string, method: string, body: Record<string, unknown>) => { status?: number; body: unknown } | null;

async function mockApi(page: Page, extra: Handler) {
  const me = { userId: "u-ada", isAdmin: true, user: { id: "u-ada", email: "ada@example.test", displayName: "Ada Admin" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    let body: Record<string, unknown> = {};
    try {
      body = (req.postDataJSON() as Record<string, unknown>) ?? {};
    } catch {
      body = {};
    }
    const out = extra(p, req.method(), body);
    if (out) return json(route, out.body, out.status ?? 200);
    return json(route, {});
  });
}

// ---------------------------------------------------------------- G1

function projectsWorld(opts: { archiveReply?: { status: number; body: unknown }; startArchived?: boolean }) {
  const credit = {
    id: "p-credit",
    name: "Credit operations",
    budgetUsd: 1200,
    spentUsd: 412.5,
    classifications: ["internal"],
    archivedAt: opts.startArchived ? ISO : null,
    archivedReason: opts.startArchived ? "Pilot ended; spend moves to team-17 support from November." : null,
    archivedByName: opts.startArchived ? "Ada Admin" : null,
  };
  const support = { id: "p-support", name: "team-17 support", budgetUsd: 800, spentUsd: 120.25, classifications: ["customer-data"], archivedAt: null };
  const legacy = {
    id: "p-legacy",
    name: "Card disputes pilot",
    budgetUsd: 300,
    spentUsd: 288,
    classifications: [],
    archivedAt: "2026-09-02T09:00:00.000Z",
    archivedReason: "Pilot closed after the review in September.",
    archivedByName: "Jordan Owner",
  };
  const handler: Handler = (p, method, body) => {
    if (p === "/v1/projects" && method === "GET") return { body: { projects: [credit, support, legacy] } };
    if (p === "/v1/projects/p-credit/members")
      return {
        body: {
          members: [
            { userId: "u-jordan", userName: "Jordan Owner", role: "owner", teamName: "team-17", createdAt: ISO },
            { userId: "u-morgan", userName: "Morgan Reyes", role: "contributor", teamName: "team-17", createdAt: ISO },
            { userId: "u-dana", userName: "Dana Developer", role: "viewer", teamName: null, createdAt: ISO },
          ],
        },
      };
    if (p === "/v1/projects/p-credit/costs")
      return {
        body: {
          project: { name: "Credit operations" },
          measured: { costUsd: 412.5, events: 1830 },
          forecast: { projectedEomUsd: 690, basis: "linear, 29 days" },
          budget: { spentUsd: 412.5, budgetUsd: 1200, period: "monthly", periodKey: "2026-10", alertThresholdPct: 80, thresholdUsd: 960 },
          byUser: [
            { userId: "u-morgan", costUsd: 300 },
            { userId: "u-dana", costUsd: 112.5 },
          ],
          byTeam: [{ name: "team-17", costUsd: 412.5 }],
          byAgent: [{ agentId: "a1", model: "Credit-limit-increase assistant", costUsd: 412.5 }],
        },
      };
    if (p === "/v1/users/directory")
      return {
        body: {
          users: [
            { id: "u-jordan", name: "Jordan Owner", teams: [] },
            { id: "u-morgan", name: "Morgan Reyes", teams: [] },
            { id: "u-dana", name: "Dana Developer", teams: [] },
            { id: "u-avery", name: "Avery Approver", teams: [] },
          ],
        },
      };
    if (p === "/v1/projects/p-credit/archive" && method === "POST") {
      const r = opts.archiveReply ?? { status: 200, body: { archived: true } };
      if (r.status < 300) {
        credit.archivedAt = "2026-10-29T10:00:00.000Z";
        credit.archivedReason = String(body.reason ?? "");
        credit.archivedByName = "Ada Admin";
      }
      return r;
    }
    if (p === "/v1/projects/p-credit/unarchive" && method === "POST") {
      credit.archivedAt = null;
      return { body: { archived: false } };
    }
    return null;
  };
  return handler;
}

test.describe("G1 project archive", () => {
  test("projects list: Active and Archived chips", async ({ page }) => {
    await mockApi(page, projectsWorld({}));
    await page.goto("/ui/projects");
    await expect(page.getByRole("button", { name: /Active/ })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("g1-projects-active.png"), fullPage: true });
    await page.getByRole("button", { name: /^Archived/ }).click();
    await expect(page.getByText("Card disputes pilot")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("g1-projects-archived-filter.png"), fullPage: true });
  });

  test("header, confirm, archived state", async ({ page }) => {
    await mockApi(page, projectsWorld({}));
    await page.goto("/ui/projects/p-credit");
    await expect(page.getByRole("button", { name: "Archive project" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("g1-project-header.png") });
    await page.getByRole("button", { name: "Archive project" }).click();
    const dialog = page.getByRole("dialog", { name: "Archive project “Credit operations”?" });
    await dialog.getByLabel("Reason").fill("Pilot ended; spend moves to team-17 support from November.");
    await page.screenshot({ path: test.info().outputPath("g1-archive-confirm.png") });
    await dialog.getByRole("button", { name: "Archive project" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Why this project is archived" }).click();
    await page.screenshot({ path: test.info().outputPath("g1-project-archived.png"), fullPage: true });
    await page.getByRole("button", { name: "Why this project is archived" }).click();
    await page.getByRole("button", { name: "Unarchive" }).click();
    await expect(page.getByRole("dialog", { name: /Unarchive project/ })).toContainText("You will be asked to confirm it's you.");
    await page.screenshot({ path: test.info().outputPath("g1-unarchive-confirm.png") });
  });

  test("refusal: open approvals", async ({ page }) => {
    await mockApi(
      page,
      projectsWorld({
        archiveReply: {
          status: 409,
          body: { error: "project_has_open_approvals", approvals: [{ id: "apr_7Q2K9X" }, { id: "apr_7Q2KA4" }] },
        },
      }),
    );
    await page.goto("/ui/projects/p-credit");
    await page.getByRole("button", { name: "Archive project" }).click();
    const dialog = page.getByRole("dialog", { name: /Archive project/ });
    await dialog.getByLabel("Reason").fill("Pilot ended; spend moves to team-17 support.");
    await dialog.getByRole("button", { name: "Archive project" }).click();
    await expect(dialog.getByTestId("archive-refusal")).toContainText("This project still has 2 open approvals. Decide or withdraw them first.");
    await page.screenshot({ path: test.info().outputPath("g1-archive-refused.png") });
  });

  test("refusal: running work", async ({ page }) => {
    await mockApi(
      page,
      projectsWorld({ archiveReply: { status: 409, body: { error: "project_has_running_work", runs: [{ id: "run_3F81" }] } } }),
    );
    await page.goto("/ui/projects/p-credit");
    await page.getByRole("button", { name: "Archive project" }).click();
    const dialog = page.getByRole("dialog", { name: /Archive project/ });
    await dialog.getByLabel("Reason").fill("Pilot ended; spend moves to team-17 support.");
    await dialog.getByRole("button", { name: "Archive project" }).click();
    await expect(dialog.getByTestId("archive-refusal")).toContainText("1 workflow is still running");
    await page.screenshot({ path: test.info().outputPath("g1-archive-refused-running.png") });
  });
});

// ---------------------------------------------------------------- G10

function identityWorld() {
  const roles = [
    { id: "r1", name: "approvers", description: "Signs off credit-limit increases" },
    { id: "r2", name: "credit-analyst", description: "Reads credit-operations context" },
    { id: "r3", name: "support-agent", description: null },
  ];
  const teams = [
    { id: "t1", name: "team-17", defaultClassifications: ["customer-data"], members: [{ userId: "u-morgan", name: "Morgan Reyes" }, { userId: "u-avery", name: "Avery Approver" }] },
    { id: "t2", name: "team-17 support", defaultClassifications: [], members: [{ userId: "u-dana", name: "Dana Developer" }] },
  ];
  const handler: Handler = (p, method, body) => {
    if (p === "/v1/roles" && method === "GET") return { body: { roles } };
    if (p === "/v1/teams" && method === "GET") return { body: { teams } };
    if (p === "/v1/users") return { body: { users: [] } };
    if (p === "/v1/compliance/profiles") return { body: { profiles: [{ tag: "customer-data" }] } };
    const m = /^\/v1\/(roles|teams)\/(\w+)$/.exec(p);
    if (m && method === "PATCH") {
      const name = String(body.name ?? "");
      const list = m[1] === "roles" ? roles : teams;
      if (list.some((x) => x.name === name && x.id !== m[2])) return { status: 409, body: { error: "name_taken" } };
      if (m[2] === "r2" && !body.acknowledgeReferences)
        return {
          status: 409,
          body: {
            error: "role_name_referenced",
            policies: [
              { id: "pol_41", name: "Credit context read" },
              { id: "pol_57", name: "Limit increase over 10k" },
            ],
            rules: [{ id: "rr_12", name: "Route limit increases to approvers" }],
          },
        };
      const row = list.find((x) => x.id === m[2]);
      if (row) row.name = name;
      return { body: row ?? {} };
    }
    return null;
  };
  return handler;
}

test.describe("G10 rename roles and teams", () => {
  test("roles: list, dialog, name taken, referenced", async ({ page }) => {
    await mockApi(page, identityWorld());
    await page.goto("/ui/admin/roles");
    await expect(page.getByRole("button", { name: "Rename role approvers" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("g10-roles.png"), fullPage: true });

    await page.getByRole("button", { name: "Rename role support-agent" }).click();
    const dialog = page.getByRole("dialog", { name: /Rename role/ });
    await dialog.getByLabel("Name").fill("approvers");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toContainText("A role called “approvers” already exists.");
    await page.screenshot({ path: test.info().outputPath("g10-rename-dialog.png") });
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Rename role credit-analyst" }).click();
    const d2 = page.getByRole("dialog", { name: /Rename role/ });
    await d2.getByLabel("Name").fill("credit-reviewer");
    await d2.getByRole("button", { name: "Save" }).click();
    await expect(d2.getByTestId("rename-referenced")).toContainText("2 access policies and 1 routing rule");
    await d2.getByLabel("Reason (required, audited)").fill("Aligning names with the new credit review process.");
    await page.screenshot({ path: test.info().outputPath("g10-rename-referenced.png") });
  });

  test("teams: list with Rename", async ({ page }) => {
    await mockApi(page, identityWorld());
    await page.goto("/ui/admin/teams");
    await expect(page.getByRole("button", { name: "Rename team team-17", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("g10-teams.png"), fullPage: true });
    await page.getByRole("button", { name: "Rename team team-17 support" }).click();
    await page.getByRole("dialog", { name: /Rename team/ }).getByLabel("Name").fill("team-17 service desk");
    await page.screenshot({ path: test.info().outputPath("g10-teams-rename-dialog.png") });
    await page.getByRole("dialog", { name: /Rename team/ }).getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Team renamed")).toBeVisible();
  });
});
