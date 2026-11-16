/**
 * ADR-0341 slice 2 — the visual pipeline builder against a mocked gateway: open a draft, edit it on the canvas and in
 * the Outline view, see the server's validation, undo, and save with the revision the edits were based on.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const TEMPLATE = "00000000-0000-4000-8000-0000000000b1";
const PAGE = `/ui/admin/workflow-templates/${TEMPLATE}/builder`;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

type Stage = { id: string; type: string } & Record<string, unknown>;
const live = (): { workflow: string; stages: Stage[] } => ({
  workflow: "standard",
  stages: [
    { id: "intake", type: "trigger" },
    { id: "plan", type: "planning" },
    { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
    { id: "build", type: "automated_build" },
  ],
});

/** the server's plan gate, as far as this spec needs it */
function issuesOf(def: { stages: Stage[] }) {
  const firstBuild = def.stages.findIndex((s) => s.type === "automated_build");
  if (firstBuild >= 0 && !def.stages.slice(0, firstBuild).some((s) => s.type === "planning")) {
    return [{ code: "plan_gate_missing", stageId: def.stages[firstBuild]!.id, path: [], message: "a planning stage must come before it (the forced plan gate)" }];
  }
  return [];
}

type Diff = { patch: unknown[]; stages: unknown; relaxations: unknown[] };
const NO_DIFF: Diff = { patch: [], stages: null, relaxations: [] };
const RELAXING: Diff = {
  patch: [{ op: "add", path: "/stages/2/quorum", value: "any" }],
  stages: { added: [], removed: [], changed: ["signoff"], moved: [], topLevel: [] },
  relaxations: [{ code: "quorum_relaxed", stageId: "signoff", message: "sign-off 'signoff' moves from every approver to any one" }],
};

function view(def: { workflow: string; stages: Stage[] }, revision: number, diff: Diff = NO_DIFF) {
  const issues = issuesOf(def);
  return {
    template: { id: TEMPLATE, name: "standard-change" },
    draft: { id: "d1", revision, definition: def, baseVersion: 1, createdBy: null, updatedBy: null, createdAt: "2026-11-16T10:00:00Z", updatedAt: "2026-11-16T10:00:00Z" },
    liveVersion: 1,
    stale: false,
    validation: { valid: issues.length === 0, issues, contentHash: issues.length ? null : "a".repeat(64) },
    diff,
  };
}

async function setup(page: Page, opts: { draft?: boolean; diff?: Diff; stepUp?: boolean } = {}) {
  const state = { hasDraft: opts.draft ?? true, revision: 1, def: live(), saves: [] as unknown[], publishes: [] as unknown[] };
  const diff = opts.diff ?? NO_DIFF;
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (!p.startsWith("/v1") && !p.startsWith("/auth")) return route.continue();
    const me = { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } };
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    const draftPath = `/v1/workflows/builder/templates/${TEMPLATE}/draft`;
    if (p === draftPath && req.method() === "GET") {
      return state.hasDraft ? json(route, view(state.def, state.revision, diff)) : json(route, { error: "no_draft" }, 404);
    }
    if (p === draftPath && req.method() === "POST") {
      state.hasDraft = true;
      return json(route, view(state.def, state.revision), 201);
    }
    if (p === draftPath && req.method() === "PUT") {
      const body = req.postDataJSON() as { revision: number; definition: { workflow: string; stages: Stage[] } };
      state.saves.push(body);
      if (body.revision !== state.revision) return json(route, { error: "draft_revision_conflict", revision: state.revision }, 409);
      state.revision += 1;
      state.def = body.definition;
      return json(route, view(state.def, state.revision));
    }
    if (p === "/v1/auth/step-up/options") {
      return json(route, { stepUpId: "su1", methods: ["totp"], actionKind: "settings_relax", expiresAt: "2099-01-01T00:00:00Z" });
    }
    if (p === `/v1/workflows/builder/templates/${TEMPLATE}/publish`) {
      if (opts.stepUp && !req.headers()["x-regulait-step-up"]) {
        const action = { kind: "settings_relax", body: { op: "workflow_template_publish", templateId: TEMPLATE, fromVersion: 1, contentHash: "a".repeat(64) } };
        return json(route, { error: "step_up_required", actionKind: "settings_relax", methods: ["totp"], action }, 403);
      }
      state.publishes.push(req.postDataJSON());
      state.hasDraft = false;
      return json(route, { template: { id: TEMPLATE, name: "standard-change" }, version: { version: 2, contentHash: "a".repeat(64), origin: "builder", publishedAt: "2026-11-16T11:00:00Z" } }, 201);
    }
    if (p === `/v1/workflows/builder/templates/${TEMPLATE}/versions`) {
      return json(route, {
        template: { id: TEMPLATE, name: "standard-change" },
        liveVersion: 2,
        nextBefore: null,
        items: [
          { version: 2, contentHash: "c".repeat(64), origin: "builder", publishedBy: "ada", publishedByName: "Ada Admin", publishedAt: "2026-11-16T11:00:00Z", stageCount: 4, live: true },
          { version: 1, contentHash: "d".repeat(64), origin: "baseline", publishedBy: null, publishedByName: null, publishedAt: "2026-11-16T10:00:00Z", stageCount: 4, live: false },
        ],
      });
    }
    if (p === `/v1/workflows/builder/templates/${TEMPLATE}/versions/1`) {
      return json(route, { template: { id: TEMPLATE, name: "standard-change" }, version: { version: 1, definition: live() }, diff: RELAXING });
    }
    if (p === "/v1/workflows/builder/validate") {
      const body = req.postDataJSON() as { definition: { stages: Stage[] } };
      const issues = issuesOf(body.definition);
      return json(route, { valid: issues.length === 0, issues, contentHash: issues.length ? null : "b".repeat(64) });
    }
    return json(route, {});
  });
  await page.goto(PAGE);
  return state;
}

const outline = (page: Page) => page.getByRole("list", { name: "Stages in order" });
const seriousAxe = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze()).violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);

test("edits a draft in the Outline view, validates it on the server, undoes, and saves with the base revision", async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByRole("heading", { name: "Edit standard-change" })).toBeVisible();
  await expect(page.getByText(/No problems found/)).toBeVisible();

  // the canvas draws one node per stage
  await expect(page.locator(".react-flow__node")).toHaveCount(4);

  await page.getByRole("tab", { name: "Outline" }).click();
  await expect(outline(page).getByRole("listitem")).toHaveCount(4);

  // moving the plan stage after the build breaks the forced plan gate: the server says so
  await page.getByRole("button", { name: "Move plan later" }).click();
  await page.getByRole("button", { name: "Move plan later" }).click();
  await expect(page.getByText(/1 problem to fix before publishing/)).toBeVisible();
  await expect(page.getByRole("button", { name: "build", exact: true })).toBeVisible();
  await expect(page.getByText("All changes saved.", { exact: false })).toHaveCount(0);

  // undo puts it back
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText(/No problems found/)).toBeVisible();

  // add a check at the end, edit its checks in the property sheet, and save
  await page.getByLabel("Stage to add").selectOption("automated_check");
  await page.getByRole("button", { name: "Add stage" }).click();
  await expect(outline(page).getByRole("listitem")).toHaveCount(5);
  const checks = page.getByRole("textbox", { name: "Named checks" });
  await checks.fill("unit\nlint");
  await checks.blur();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved")).toBeVisible();
  expect(state.saves).toHaveLength(1);
  const saved = state.saves[0] as { revision: number; definition: { stages: Stage[] } };
  expect(saved.revision).toBe(1);
  expect(saved.definition.stages.at(-1)).toEqual({ id: "automated-check", type: "automated_check", checks: ["unit", "lint"] });
  // the untouched stages are sent exactly as they came
  expect(saved.definition.stages.slice(0, 4)).toEqual(live().stages);
  await expect(page.getByText(/Draft revision 2/)).toBeVisible();
});

test("moves a stage on the canvas with the keyboard", async ({ page }) => {
  await setup(page);
  const signoff = page.locator('.react-flow__node[data-id="signoff"]');
  await expect(signoff).toBeVisible();
  await signoff.focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await page.getByRole("tab", { name: "Outline" }).click();
  await expect(outline(page).getByRole("listitem").nth(1)).toContainText("signoff");
});

test("a template with no draft offers to open one", async ({ page }) => {
  await setup(page, { draft: false });
  await expect(page.getByText("This template has no open draft")).toBeVisible();
  await page.getByRole("button", { name: "Open a draft" }).click();
  await expect(page.getByRole("heading", { name: "Edit standard-change" })).toBeVisible();
});

test("the editor has no serious or critical accessibility violation, on the canvas and in the Outline view", async ({ page }) => {
  await setup(page);
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await page.locator('.react-flow__node[data-id="plan"]').click();
  await expect(page.getByRole("textbox", { name: "Stage id" })).toHaveValue("plan");
  const scan = async () =>
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze()).violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(await scan()).toEqual([]);
  await page.getByRole("tab", { name: "Outline" }).click();
  expect(await scan()).toEqual([]);
});

test("publishes only after the relaxation is accepted with a reason, then says which version is live", async ({ page }) => {
  const state = await setup(page, { diff: RELAXING });
  await page.getByRole("button", { name: "Review and publish" }).click();
  const dialog = page.getByRole("dialog", { name: /Publish version 2 of standard-change/ });
  await expect(dialog.getByText(/This weakens the workflow in 1 way/)).toBeVisible();
  await expect(dialog.getByText(/moves from every approver to any one/)).toBeVisible();
  expect(await seriousAxe(page)).toEqual([]);
  const publish = dialog.getByRole("button", { name: "Publish version 2" });
  // nothing is pre-selected: the button refuses until the box is ticked and a reason is given
  await expect(publish).toHaveAttribute("aria-disabled", "true");
  await expect(dialog.getByText("Accept the relaxations to publish.")).toBeVisible();
  await dialog.getByLabel("I accept this relaxation").check();
  await expect(publish).toHaveAttribute("aria-disabled", "true"); // a reason is still owed
  await dialog.getByRole("textbox", { name: /Why the workflow is relaxed/ }).fill("one approver is enough for this flow");
  await expect(publish).toHaveAttribute("aria-disabled", "false");
  expect(state.publishes).toHaveLength(0);
  await publish.click();
  await expect(page.getByText("Version 2 published")).toBeVisible();
  expect(state.publishes).toEqual([{ revision: 1, acceptRelaxations: true, reason: "one approver is enough for this flow" }]);
  await expect(page.getByText("Version 2 is live")).toBeVisible();
});

test("lists versions and compares an older one with live", async ({ page }) => {
  await setup(page);
  await page.getByRole("tab", { name: "Versions" }).click();
  await expect(page.getByText("Before the builder")).toBeVisible();
  await page.getByRole("button", { name: "Compare version 1 with live" }).click();
  const cmp = page.getByRole("region", { name: "Version 1 against live" });
  await expect(cmp.getByText(/This weakens the workflow/)).toBeVisible();
  expect(await seriousAxe(page)).toEqual([]);
  await expect(page.getByRole("button", { name: "Start a draft from version 1" })).toBeVisible();
});

test("a publish the gateway answers with a step-up asks the person to confirm a publish, and cancelling publishes nothing", async ({ page }) => {
  const state = await setup(page, { diff: { ...RELAXING, relaxations: [] }, stepUp: true });
  await page.getByRole("button", { name: "Review and publish" }).click();
  await page.getByRole("dialog", { name: /Publish version 2/ }).getByRole("button", { name: "Publish version 2" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(confirm.getByText(/You're publishing a new version of a workflow template/)).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(state.publishes).toHaveLength(0);
});
