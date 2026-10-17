/**
 * ADR-0190 owner decisions C and D in the admin console (mocked gateway):
 *  - D: the Engines page's "Project isolation" card shows each project's sensitivity from its use cases, the
 *    admin-set field and the one in force (a project with neither is unresolved and its calls refused). Raising it
 *    is sent once without and once with the `settings_relax` step-up; the screen says when a value has no effect.
 *  - C: "a person's own calls" are L3 by default; allowing L2 for a project or a stdio server is confirmed, then
 *    resent once with the step-up; restoring L3 asks for none. An unreadable answer shows nothing and offers no
 *    control.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installBuilderMock } from "./builder-fixtures";
import { installEnginesMock } from "./engines-fixtures";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

interface Mock {
  projects: Array<Record<string, unknown>>;
  relaxations: Array<Record<string, unknown>>;
  sensitivityWrites: Array<{ path: string; body: unknown }>;
  relaxationWrites: Array<{ path: string; body: unknown; stepUp: string | null }>;
  /** a body other than the state for the relaxation list (a malformed answer) */
  relaxationsBody?: unknown;
  projectsBody?: unknown;
}

const RANK = ["public", "internal", "confidential", "regulated"];
const max = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : RANK.indexOf(a) >= RANK.indexOf(b) ? a : b);

async function setup(page: Page): Promise<Mock> {
  await installBuilderMock(page, { isAdmin: true });
  await installEnginesMock(page);
  const m: Mock = {
    projects: [
      { projectId: "p-claims", name: "Claims", useCaseCount: 1, useCaseSensitivity: "internal", adminSensitivity: null, effectiveSensitivity: "internal", personStdioRelaxationId: null },
      { projectId: "p-sandbox", name: "Sandbox", useCaseCount: 0, useCaseSensitivity: null, adminSensitivity: null, effectiveSensitivity: null, personStdioRelaxationId: null },
    ],
    relaxations: [],
    sensitivityWrites: [],
    relaxationWrites: [],
  };
  await page.route(/\/v1\/execution-project-sensitivities(\/|\?|$)/, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === "/v1/execution-project-sensitivities" && req.method() === "GET") return json(route, m.projectsBody ?? { projects: m.projects });
    const one = /^\/v1\/execution-project-sensitivities\/([^/]+)$/.exec(p);
    if (one && req.method() === "PUT") {
      const body = req.postDataJSON() as { sensitivity: string | null };
      m.sensitivityWrites.push({ path: p, body });
      const row = m.projects.find((x) => x.projectId === decodeURIComponent(one[1]!))!;
      row.adminSensitivity = body.sensitivity;
      row.effectiveSensitivity = max(row.useCaseSensitivity as string | null, body.sensitivity);
      return json(route, { project: row, changed: true });
    }
    return json(route, { error: "not_found" }, 404);
  });
  await page.route(/\/v1\/execution-person-stdio-relaxations(\/|\?|$)/, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === "/v1/execution-person-stdio-relaxations" && req.method() === "GET") {
      return json(route, m.relaxationsBody ?? { relaxations: m.relaxations, default: "microvm", relaxedTo: "user_space_kernel" });
    }
    const one = /^\/v1\/execution-person-stdio-relaxations\/(mcp_server|project)\/([^/]+)$/.exec(p);
    if (one && req.method() === "PUT") {
      const body = req.postDataJSON() as { relaxed: boolean };
      m.relaxationWrites.push({ path: p, body, stepUp: req.headers()["x-regulait-step-up"] ?? null });
      const scopeKind = one[1]!;
      const scopeId = decodeURIComponent(one[2]!);
      m.relaxations = m.relaxations.filter((r) => !(r.scopeKind === scopeKind && r.scopeId === scopeId));
      if (body.relaxed) {
        const row = { id: `r-${scopeId}`, kind: "person_stdio_l2", subjectKind: "interactive_person", scopeKind, scopeId, scopeName: null, from: "microvm", to: "user_space_kernel", createdByUserId: "u1", createdAt: new Date().toISOString() };
        m.relaxations.push(row);
        return json(route, { relaxation: row, changed: true });
      }
      return json(route, { relaxation: null, changed: true });
    }
    return json(route, { error: "not_found" }, 404);
  });
  return m;
}

async function axe(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  });
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations).toEqual([]);
}

async function openEngines(page: Page) {
  await page.goto("/ui/admin/engines");
  await expect(page.getByRole("heading", { name: "Engines", exact: true, level: 1 })).toBeVisible();
}

const projectRow = (page: Page, name: string) => page.getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) });

test("D: each project's sensitivity is shown honestly; raising it is resent once with step-up", async ({ page }) => {
  const m = await setup(page);
  await openEngines(page);
  await expect(projectRow(page, "Claims").getByRole("cell", { name: "Internal", exact: true }).first()).toBeVisible();
  await expect(projectRow(page, "Sandbox").getByText("Unresolved · calls refused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Manage isolation for project Claims", exact: true }).click();
  const editor = page.getByTestId("project-isolation-editor");
  const field = editor.getByLabel("Sensitivity set by an admin", { exact: true });
  await field.selectOption("public");
  await expect(editor.getByText(/This is not above the use cases, so it has no effect\./)).toBeVisible();
  await field.selectOption("regulated");
  await expect(editor.getByText(/This raises it\./)).toBeVisible();
  await axe(page);

  const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/execution-project-sensitivities/p-claims", kind: "settings_relax" });
  await editor.getByRole("button", { name: "Save project sensitivity", exact: true }).click();
  await confirmStepUp(page);
  await su.expectResentOnce();
  expect(su.attempts[0]!.body).toEqual({ sensitivity: "regulated" });
  expect(m.sensitivityWrites).toEqual([{ path: "/v1/execution-project-sensitivities/p-claims", body: { sensitivity: "regulated" } }]);
  await expect(projectRow(page, "Claims").getByRole("cell", { name: "Regulated", exact: true }).first()).toBeVisible();
});

test("C: a project's person's own calls are L3 by default; allowing L2 is confirmed and stepped up, restoring L3 is not", async ({ page }) => {
  const m = await setup(page);
  await openEngines(page);
  await page.getByRole("button", { name: "Manage isolation for project Claims", exact: true }).click();
  const control = page.getByTestId("project-isolation-editor").getByTestId("person-stdio-relaxation");
  await expect(control.getByText("L3 · MicroVM sandbox (strict default)", { exact: true })).toBeVisible();
  await expect(control.getByText(/never to an API key, an agent or an engine/)).toBeVisible();

  // as the gateway does: only allowing L2 needs the step-up; restoring L3 (a tightening) does not
  const su = await requireStepUpOn(page, {
    method: "PUT",
    path: "/v1/execution-person-stdio-relaxations/project/p-claims",
    kind: "settings_relax",
    when: (body) => (body as { relaxed?: unknown } | null)?.relaxed === true,
  });
  await control.getByRole("button", { name: "Allow L2 for a person's own calls", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Allow L2 for a person's own calls?" });
  await expect(dialog).toContainText("API keys, agents and engines keep the L3 floor.");
  await axe(page);
  await dialog.getByRole("button", { name: "Allow L2 (audited)", exact: true }).click();
  await confirmStepUp(page);
  await su.expectResentOnce();
  expect(su.attempts[0]!.body).toEqual({ relaxed: true });
  await expect(control.getByText("L2 allowed · audited", { exact: true })).toBeVisible();

  await control.getByRole("button", { name: "Restore the L3 default", exact: true }).click();
  await expect(control.getByText("L3 · MicroVM sandbox (strict default)", { exact: true })).toBeVisible();
  const restore = m.relaxationWrites.at(-1)!;
  expect(restore).toEqual({ path: "/v1/execution-person-stdio-relaxations/project/p-claims", body: { relaxed: false }, stepUp: null });
});

test("C and D: unreadable answers show nothing and offer no control", async ({ page }) => {
  const m = await setup(page);
  m.relaxationsBody = { relaxations: [], default: "user_space_kernel", relaxedTo: "hardened_container" };
  await openEngines(page);
  await page.getByRole("button", { name: "Manage isolation for project Claims", exact: true }).click();
  const control = page.getByTestId("person-stdio-relaxation");
  await expect(control.getByText("Not reported", { exact: true })).toBeVisible();
  await expect(control.getByRole("button")).toHaveCount(0);
  m.projectsBody = { projects: [{ projectId: "p-x", name: "X", useCaseCount: 0, useCaseSensitivity: null, adminSensitivity: "secret", effectiveSensitivity: null, personStdioRelaxationId: null }] };
  await openEngines(page);
  await expect(page.getByText("Project isolation settings unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("No projects yet", { exact: true })).toHaveCount(0);
});

test("C on a stdio MCP server: the control sits under its execution profile and is stepped up", async ({ page }) => {
  await setup(page);
  await page.route("**/v1/servers", (route) =>
    json(route, {
      servers: [{ id: "ocd-stdio", name: "Synthetic stdio", url: "", transport: "stdio", stdio: { command: "synthetic", args: [] }, allowPrivateRanges: null }],
    }),
  );
  await page.route("**/v1/users", (route) => json(route, { users: [] }));
  await page.goto("/ui/admin/mcp-servers");
  await expect(page.getByRole("heading", { level: 1, name: "MCP servers", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Show tools on Synthetic stdio" }).click();
  const control = page.getByTestId("person-stdio-relaxation");
  await expect(control.getByText(/A person's own calls · Synthetic stdio/)).toBeVisible();
  const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/execution-person-stdio-relaxations/mcp_server/ocd-stdio", kind: "settings_relax" });
  await control.getByRole("button", { name: "Allow L2 for a person's own calls", exact: true }).click();
  await page.getByRole("dialog", { name: "Allow L2 for a person's own calls?" }).getByRole("button", { name: "Allow L2 (audited)", exact: true }).click();
  await confirmStepUp(page);
  await su.expectResentOnce();
  await expect(control.getByText("L2 allowed · audited", { exact: true })).toBeVisible();
  await axe(page);
});
