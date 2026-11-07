/**
 * I-2 rollout F (owner, #453): the approved patterns on the platform pages deferred from #656/#657, against a mocked
 * gateway (the *.mock.spec.ts harness).
 *
 *  - regulAIt-LLM (stepper): backend, data, training and artifact as four steps; each step's button states its status
 *    (and its warnings); the stepper opens on the first unfinished step; one step's cards show at a time; opening an
 *    artifact from the jobs list takes you to its step; a failed read is an error with Retry, never an empty stepper.
 *  - Cost consolidation (expandable table): one row per subject in the consolidated view; a row opens from the keyboard
 *    (a button with aria-expanded and aria-controls), its detail takes focus as a named region, Esc closes it and
 *    returns focus; the unattributed warning and both bases stay on the closed row, and no total column exists.
 *  - Webhooks (one empty state): with nothing set up, one empty state and the add form first; a failed allow-list read
 *    is an error with Retry, never "the allow-list is empty".
 *  - axe (WCAG 2.x A/AA, light and dark) on each, through the shared helper.
 */
import { expect, test } from "@playwright/test";
import { expectAxeClean } from "./prompts-fixtures";
import { ERR, mockLlm, mockWebhooks } from "./i2-rollout-f.fixtures";
import { CONSOLIDATED, mockOps } from "./long-pages-ops.fixtures";

test.describe("I-2 rollout F: regulAIt-LLM as a stepper", () => {
  test("four steps, each stating its status; opens on the first unfinished one; one step at a time", async ({ page }) => {
    await mockLlm(page);
    await page.goto("/ui/admin/regulait-llm");
    await expect(page.getByRole("heading", { name: "regulAIt-LLM", level: 1 })).toBeVisible();
    const steps = page.getByRole("list", { name: "Custom-model steps" });
    const step = (label: string) => steps.getByRole("button", { name: new RegExp(`^${label}`) });
    await expect(steps.getByRole("button")).toHaveCount(4);

    // each step's button states its own status; the warnings are on the button, not behind it
    await expect(step("Backends")).toContainText("1 usable");
    await expect(step("Backends")).toContainText("1 will refuse");
    await expect(step("Training data")).toContainText("2 versions");
    await expect(step("Training data")).toContainText("1 flagged by the ingest scan");
    await expect(step("Training jobs")).toContainText("1 started");
    await expect(step("Model artifacts")).toContainText("1 artifact · 0 registered");

    // the page-wide state stays above the stepper
    await expect(page.getByText("Custom-model creation")).toBeVisible();
    await expect(page.getByText("Approval threshold (estimated cost)")).toBeVisible();

    // opens on the first unfinished step: nothing is registered for inference yet
    await expect(step("Model artifacts")).toHaveAttribute("aria-current", "step");
    await expect(page.getByText("Training backends, and what each one cannot do")).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "faq-index", exact: true })).toBeVisible();
    await expectAxeClean(page, "regulAIt-LLM, stepper");

    // a step chosen from the keyboard: the backends and their refusal warning
    await step("Backends").focus();
    await page.keyboard.press("Enter");
    await expect(step("Backends")).toHaveAttribute("aria-current", "step");
    await expect(step("Model artifacts")).not.toHaveAttribute("aria-current", "step");
    await expect(page.getByText("Training backends, and what each one cannot do")).toBeVisible();
    await expect(page.getByText("missing — will refuse")).toBeVisible();
    await expect(page.getByText("IT DOES NOT FINE-TUNE A LANGUAGE MODEL")).toBeVisible();

    // the data step: the upload form and the datasets
    await step("Training data").click();
    await expect(page.getByRole("button", { name: "Scan & create" })).toBeVisible();
    await expect(page.getByRole("link", { name: /^tickets v1/ })).toBeVisible();
    await expect(page.getByText("Training backends, and what each one cannot do")).toHaveCount(0);

    // the jobs step: the jobs list, its status always shown
    await step("Training jobs").click();
    await expect(page.getByRole("row").filter({ hasText: "faq-index" })).toContainText("succeeded");
    await expect(page.getByRole("button", { name: "Scan & create" })).toHaveCount(0);

    // the artifact step: an artifact opens its detail, with the bench
    await step("Model artifacts").click();
    await page.getByRole("cell", { name: "faq-index", exact: true }).click();
    await expect(page.getByText("Artifact — faq-index")).toBeVisible();
    await expect(page.getByText("Bench — ask the model something")).toBeVisible();
  });

  test("a failed read shows an error with Retry, never an empty stepper", async ({ page }) => {
    await mockLlm(page, { "GET /v1/llm/datasets": ERR });
    await page.goto("/ui/admin/regulait-llm");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Custom-model steps" })).toHaveCount(0);
  });
});

test.describe("I-2 rollout F: the consolidated view expands in place", () => {
  const UNATTRIBUTED = "Unattributed — vendor accounts that resolved to nobody";

  test("a subject opens from the keyboard as a named region, Esc closes it; the warning and both bases stay on the row", async ({ page }) => {
    await mockOps(page);
    // this test answers with no superseded lines so the axe run below covers the table it is about; the note that
    // superseded lines bring, and its in-text link, have their own test below
    await page.route(
      (u) => u.pathname === "/v1/cost-consolidated",
      (route) => route.fulfill({ json: { ...CONSOLIDATED, reconciliation: { ...CONSOLIDATED.reconciliation, supersededLinesExcluded: 0 } } }),
    );
    await page.goto("/ui/admin/cost-consolidation?tab=consolidated");
    const view = page.getByTestId("cc-subjects");
    await expect(view.getByRole("button", { name: /^Details: / })).toHaveCount(5);

    // two bases in two columns, each naming its basis; no column adds them
    const headers = view.locator("thead th");
    await expect(headers).toHaveText(["", "Person", "Metered — observed and priced", "Imported — customer-supplied"]);

    // the unattributed warning is on the closed row
    const row = view.getByRole("row").filter({ hasText: UNATTRIBUTED });
    await expect(row.getByText("unattributed", { exact: true })).toBeVisible();
    await expect(row).toContainText("metered · 304 call(s)");
    await expect(row).toContainText("imported · 8 line(s)");

    // open from the keyboard: the detail takes focus as a named region
    const toggle = view.getByRole("button", { name: `Details: ${UNATTRIBUTED}` });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const controls = await toggle.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    await expect(page.locator(`[id="${controls}"]`)).toBeAttached();
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const region = page.getByRole("region", { name: `Details: ${UNATTRIBUTED}` });
    await expect(region).toBeFocused();
    await expect(region).toContainText("metered — regulAIt observed and priced these calls");
    await expect(region).toContainText("imported — restated from a file you supplied");
    await expect(region).toContainText("Metered and imported figures are shown side by side and never added.");
    await expect(region).toContainText("Imported by kind: seat 96.00 USD");
    await expectAxeClean(page, "consolidated view, a subject open");

    // Esc closes it and returns focus to its button
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
    await expect(region).toHaveCount(0);
  });

  test("the superseded-lines note: its in-text link is underlined, so it is not told apart by colour alone", async ({ page }) => {
    await mockOps(page);
    await page.goto("/ui/admin/cost-consolidation?tab=consolidated");
    const note = page.getByTestId("cc-reconciliation-note");
    await expect(note).toContainText(`${CONSOLIDATED.reconciliation.supersededLinesExcluded} superseded duplicate line(s) are excluded`);
    const link = note.getByRole("link", { name: "Reconciliation tab", exact: true });
    await expect(link).toHaveAttribute("href", /\?tab=reconciliation$/);
    expect(await link.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain("underline");
    await expectAxeClean(page, "consolidated view, superseded-lines note");

    // the link still goes where it said
    await link.click();
    await expect(page).toHaveURL(/[?&]tab=reconciliation/);
    await expect(page.getByText("Superseded lines (marked, never deleted)")).toBeVisible();
  });

  test("a failed consolidated read is an error with Retry, never an empty view", async ({ page }) => {
    await mockOps(page);
    await page.route(
      (u) => u.pathname === "/v1/cost-consolidated",
      (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal" }) }),
    );
    await page.goto("/ui/admin/cost-consolidation?tab=consolidated");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("No spend of either basis in this window")).toHaveCount(0);
  });
});

test.describe("I-2 rollout F: Webhooks, one empty state", () => {
  test("nothing set up: one empty state, with the add form first", async ({ page }) => {
    const st = await mockWebhooks(page);
    await page.goto("/ui/admin/webhooks");
    await expect(page.getByRole("heading", { level: 1, name: "Webhooks" })).toBeVisible();
    await expect(page.getByText("No webhooks", { exact: true })).toHaveCount(1);
    await expect(page.getByText("The allow-list is empty", { exact: false })).toHaveCount(0);
    // the primary action comes first
    const add = page.getByRole("button", { name: "Add webhook" });
    const empty = page.getByText("No webhooks", { exact: true });
    const [addBox, emptyBox] = await Promise.all([add.boundingBox(), empty.boundingBox()]);
    expect(addBox!.y).toBeLessThan(emptyBox!.y);
    await expectAxeClean(page, "webhooks, nothing set up");

    await page.getByLabel("Name").fill("release-notifier");
    await page.getByLabel("Endpoint URL").fill("https://hooks.example.test/regulait");
    await page.getByLabel("Every prompt event, including ones added later").check();
    await add.click();
    await expect(page.getByTestId("webhook-secret")).toBeVisible();
    expect(st.posts).toEqual([{ name: "release-notifier", url: "https://hooks.example.test/regulait", events: ["prompt.*"] }]);
    await expect(page.getByText("No webhooks", { exact: true })).toHaveCount(0);
  });

  test("an empty allow-list says so; a failed allow-list read is an error with Retry, never \"empty\"", async ({ page }) => {
    await mockWebhooks(page, { hosts: [] });
    await page.goto("/ui/admin/webhooks");
    await expect(page.getByText("The allow-list is empty, so no endpoint is reachable yet.")).toBeVisible();

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockWebhooks(page, { overrides: { "GET /v1/egress-allow-hosts": ERR } });
    await page.goto("/ui/admin/webhooks");
    await expect(page.getByText("Couldn't load the egress allow-list")).toBeVisible();
    await expect(page.getByText("The allow-list is empty", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: "Couldn't load the egress allow-list" }).getByRole("button", { name: "Retry" })).toBeVisible();
    await expectAxeClean(page, "webhooks, allow-list read failed");
  });

  test("a failed webhooks read is an error with Retry, never \"No webhooks\"", async ({ page }) => {
    await mockWebhooks(page, { overrides: { "GET /v1/webhooks": ERR } });
    await page.goto("/ui/admin/webhooks");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("No webhooks", { exact: true })).toHaveCount(0);
  });
});
