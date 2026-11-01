/**
 * I-2 rollout B (owner, #453): the approved stepper and expandable-table patterns on more pages, against a mocked
 * gateway (the *.mock.spec.ts harness).
 *
 *  - First-run setup (stepper): every step stays, in the gateway's order; each step's button states its status, drift
 *    and block; the stepper opens on the step to resume; one step's panel shows at a time; a failed read is an error
 *    with Retry.
 *  - Regulatory intelligence (expandable table): a timeline row opens from the keyboard (a button with aria-expanded
 *    and aria-controls), its detail takes focus as a named region, Esc closes it and returns focus; the warnings stay
 *    on the closed row.
 *  - Scheduled jobs (expandable table): the same, and a job's failure and "not in this gateway's code" warnings and
 *    its Run now / Disable stay on the closed row.
 *  - axe (WCAG 2.x A/AA, light and dark) on each, through the shared helper.
 */
import { expect, test } from "@playwright/test";
import { expectAxeClean } from "./prompts-fixtures";
import { FIRST_RUN_ROUTES, REG_ROUTES, SCHEDULER_ROUTES, WIZARD, mockApi } from "./i2-rollout-b.fixtures";

const ERR = { status: 500, body: { error: "upstream_unavailable" } };

test.describe("I-2 rollout B: First-run setup as a stepper", () => {
  test("every step in order, each stating its status; opens on the step to resume; one panel at a time", async ({ page }) => {
    const calls = await mockApi(page, FIRST_RUN_ROUTES);
    await page.goto("/ui/admin/first-run");
    await expect(page.getByRole("heading", { name: "First-run setup", level: 1 })).toBeVisible();
    const steps = page.getByRole("list", { name: "First-run steps" });
    const step = (title: string) => steps.getByRole("button", { name: new RegExp(`^${title}`) });

    // every step, in the gateway's order
    const buttons = steps.getByRole("button");
    await expect(buttons).toHaveCount(WIZARD.steps.length);
    for (const [i, s] of WIZARD.steps.entries()) await expect(buttons.nth(i)).toContainText(s.title);

    // each step's button states its own status; drift and a block are never hidden
    await expect(step("Connect your identity provider")).toContainText("DoneVerified live");
    await expect(step("Seed starter roles")).toContainText("Drift");
    await expect(step("Apply a compliance pack")).toContainText("Blocked");
    await expect(step("Connect a model provider")).toContainText("In progress");

    // the summary and its warnings stay above the stepper
    await expect(page.getByText("Resume at: Import your directory")).toBeVisible();

    // opens on the step to resume
    await expect(step("Import your directory")).toHaveAttribute("aria-current", "step");
    await expect(page.getByLabel("Directory CSV (email, displayName, username, groups)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Seed starter roles (safe to re-run)" })).toHaveCount(0);
    await expectAxeClean(page, "First-run setup, stepper");

    // the drifted step, chosen from the keyboard: its panel explains the drift
    await step("Seed starter roles").focus();
    await page.keyboard.press("Enter");
    await expect(step("Seed starter roles")).toHaveAttribute("aria-current", "step");
    await expect(step("Import your directory")).not.toHaveAttribute("aria-current", "step");
    await expect(page.getByRole("button", { name: "Seed starter roles (safe to re-run)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "What is drift?" })).toBeVisible();
    await expect(page.getByLabel("Directory CSV (email, displayName, username, groups)")).toHaveCount(0);

    // the blocked step keeps Mark done disabled and names what blocks it
    await step("Apply a compliance pack").click();
    await expect(page.getByText("Blocked by Connect a model provider", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark done" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Apply pack (safe to re-run)" })).toBeVisible();

    // a step's acts still reach the gateway
    await step("Make the first governed call").click();
    await page.getByRole("button", { name: "Mark in progress" }).click();
    await expect
      .poll(() => calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body]))
      .toEqual([["/v1/onboarding/steps/first_governed_call", { status: "in_progress" }]]);
  });

  test("a failed read shows an error with Retry, never an empty stepper", async ({ page }) => {
    await mockApi(page, { ...FIRST_RUN_ROUTES, "GET /v1/onboarding": ERR });
    await page.goto("/ui/admin/first-run");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("list", { name: "First-run steps" })).toHaveCount(0);
  });
});

test.describe("I-2 rollout B: the Regulatory timeline expands in place", () => {
  const TITLE = "Circular 2022-03 — Adverse-action notices (withdrawn)";

  test("a row opens from the keyboard as a named region, Esc closes it; warnings stay on the closed row", async ({ page }) => {
    await mockApi(page, REG_ROUTES);
    await page.goto("/ui/admin/governance/regulatory");
    await expect(page.getByRole("heading", { name: "Regulatory & policy intelligence", level: 1 })).toBeVisible();
    const timeline = page.getByRole("region", { name: "Regulatory effective-date timeline" });
    await expect(timeline.getByRole("button", { name: /^Details: / })).toHaveCount(4);

    // closed rows still say withdrawn, voluntary, not-counted and every gap
    await expect(timeline.getByText("Withdrawn", { exact: true })).toBeVisible();
    await expect(timeline.getByText("Not counted: withdrawn")).toBeVisible();
    await expect(timeline.getByText("Voluntary standard", { exact: true })).toBeVisible();
    await expect(timeline.getByText("EU AI Act · pack not active (gap)")).toBeVisible();
    await expect(timeline.getByText("1 gap", { exact: true })).toHaveCount(2);

    const toggle = page.getByRole("button", { name: `Details: ${TITLE}` });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const controls = await toggle.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    await expect(page.locator(`[id="${controls}"]`)).toBeHidden();

    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const region = page.getByRole("region", { name: `Details: ${TITLE}` });
    await expect(region).toBeFocused();
    await expect(page.locator(`[id="${controls}"]`)).toContainText("Withdrawn on 12 May 2025.");
    await expect(region).toContainText("Mapped controls and impacted use cases");
    await expect(region.getByRole("link", { name: "Primary source" })).toBeVisible();
    await expectAxeClean(page, "Regulatory intelligence, an expanded timeline row");

    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
    await expect(region).toHaveCount(0);

    await page.keyboard.press(" ");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  test("a failed read shows an error with Retry, never an empty timeline", async ({ page }) => {
    await mockApi(page, { "GET /v1/regulatory/updates": ERR });
    await page.goto("/ui/admin/governance/regulatory");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("No regulatory entries are available")).toHaveCount(0);
  });
});

test.describe("I-2 rollout B: Scheduled jobs expand in place", () => {
  test("a job opens from the keyboard as a named region, Esc closes it; warnings and actions stay on the row", async ({ page }) => {
    await mockApi(page, SCHEDULER_ROUTES);
    await page.goto("/ui/admin/scheduler");
    await expect(page.getByRole("heading", { name: "Scheduled jobs", level: 1 })).toBeVisible();

    const row = (name: string) => page.getByRole("row").filter({ has: page.getByText(name, { exact: true }) });
    await expect(row("approval-sla").getByText("2 consecutive failure(s)")).toBeVisible();
    await expect(row("legacy-sweep").getByText("not in this gateway's code")).toBeVisible();
    await expect(row("report-generation").getByText("— (not scheduled)")).toBeVisible();
    await expect(row("eval-drift").getByRole("button", { name: "Run now" })).toBeDisabled();
    await expect(row("report-generation").getByRole("button", { name: "Enable" })).toBeVisible();

    const toggle = page.getByRole("button", { name: "Details: approval-sla" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const controls = await toggle.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    await expect(page.locator(`[id="${controls}"]`)).toBeHidden();

    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const region = page.getByRole("region", { name: "Details: approval-sla" });
    await expect(region).toBeFocused();
    await expect(region.getByText("2 consecutive failure(s)")).toBeVisible();
    await expect(region.getByText("database unreachable").first()).toBeVisible();
    await expect(region.getByRole("button", { name: "Show the full run history of approval-sla" })).toBeVisible();
    await expectAxeClean(page, "Scheduled jobs, an expanded job row");

    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
    await expect(region).toHaveCount(0);

    await page.keyboard.press(" ");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  test("a failed read shows an error with Retry, never an empty job list", async ({ page }) => {
    await mockApi(page, { ...SCHEDULER_ROUTES, "GET /v1/scheduler": ERR });
    await page.goto("/ui/admin/scheduler");
    await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible();
    await expect(page.getByText("No jobs registered")).toHaveCount(0);
  });
});
