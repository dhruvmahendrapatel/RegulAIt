/**
 * ADR-0172 — builder agents list, the New agent dialog and import, against the
 * mocked Builder API (builder-fixtures.ts).
 */
import { expect, test } from "@playwright/test";
import { expectAxeClean, installBuilderMock, MODEL_B, sent } from "./builder-fixtures";

test.describe("ADR-0172: your agents", () => {
  test("cards show colour, model, sharing and spend against the limit; list view and search", async ({ page }) => {
    await installBuilderMock(page);
    await page.goto("/ui/builder/agents");
    await expect(page.getByRole("heading", { level: 1, name: "Your agents" })).toBeVisible();
    const cards = page.getByRole("list", { name: "Agents" }).getByRole("listitem");
    await expect(cards).toHaveCount(3);
    const intake = page.getByRole("link", { name: "Open Intake reviewer" });
    await expect(intake).toContainText("Workspace");
    await expect(intake).toContainText("claude-default");
    await expect(intake).toContainText("$42.5 of $50");
    await expect(intake.getByRole("img", { name: "anthropic" })).toBeVisible();
    await expect(intake.getByRole("meter")).toHaveAttribute("aria-valuemax", "50");
    await expect(page.getByRole("link", { name: "Open Policy Q&A" })).toContainText("Shared");
    await expect(page.getByRole("link", { name: "Open Vendor risk assessor" }).getByRole("img", { name: "openai" })).toBeVisible();
    await expectAxeClean(page, "agents, cards");

    await page.getByLabel("Search agents").fill("vendor");
    await expect(cards).toHaveCount(1);
    await page.getByLabel("Search agents").fill("nothing like this");
    await expect(page.getByText("No matching agents")).toBeVisible();
    await page.getByLabel("Search agents").fill("");

    await page.getByRole("radio", { name: "List" }).check();
    await expect(page).toHaveURL(/view=list/);
    const row = page.getByRole("link", { name: "Open Vendor risk assessor" });
    await expect(row).toContainText("gpt-review");
    await expectAxeClean(page, "agents, list");
    await row.click();
    await expect(page).toHaveURL(/\/ui\/builder\/agents\/aaaaaaaa-/);
  });

  test("empty and error states", async ({ page }) => {
    await installBuilderMock(page, { empty: true });
    await page.goto("/ui/builder/agents");
    await expect(page.getByText("No agents yet")).toBeVisible();
    await expectAxeClean(page, "agents, empty");

    const page2 = await page.context().newPage();
    await installBuilderMock(page2, { fail: ["/agents"] });
    await page2.goto("/ui/builder/agents");
    await expect(page2.getByRole("alert").filter({ hasText: "Couldn't load agents" })).toBeVisible({ timeout: 15_000 });
    await expect(page2.getByRole("alert")).toContainText("builder store unavailable");
  });

  test("new agent dialog: name, description, advanced choices, then the editor's setup steps", async ({ page }) => {
    const st = await installBuilderMock(page);
    await page.goto("/ui/builder/agents");
    await page.getByRole("button", { name: "New agent" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New agent" });
    await expect(dialog).toBeVisible();
    const create = dialog.getByRole("button", { name: "Create agent" });
    await expect(create).toBeDisabled();
    await dialog.getByLabel("Name your agent").fill("Evidence collector");
    await dialog.getByLabel("Describe what it should do").fill("Gathers evidence for controls due this month.");
    await expect(dialog.getByRole("group", { name: "Connection format" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Advanced" }).click();
    await expect(dialog.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "true");
    await expect(dialog.getByRole("radio", { name: /Shared/ })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: /^No/ })).toBeChecked();
    await dialog.getByRole("radio", { name: /Per person/ }).check();
    await dialog.getByRole("radio", { name: /^Yes/ }).check();
    await dialog.getByLabel("Model").selectOption(MODEL_B);
    await expect(dialog.getByText("isn't available in this workspace yet")).toBeVisible();
    await expectAxeClean(page, "new agent dialog, advanced open");
    await create.click();

    await expect(page).toHaveURL(/\/ui\/builder\/agents\/aaaaaaaa-.*\?setup=1/);
    expect(sent(st, "POST", "/v1/builder/agents")).toEqual([
      { name: "Evidence collector", description: "Gathers evidence for controls due this month.", modelAgentId: MODEL_B, connectionFormat: "per_user", computerUse: true },
    ]);
    await expect(page.getByRole("heading", { level: 1, name: "Evidence collector" })).toBeVisible();
    const setup = page.getByRole("group", { name: "Agent setup" });
    await expect(setup.getByText("Instructions", { exact: true })).toBeVisible();
    await setup.getByRole("button", { name: "Save and continue" }).click();
    await expect(page).not.toHaveURL(/setup=1/);
    await expect(page.getByText("No conversations yet")).toBeVisible();
  });

  test("import: a valid bundle creates the agent and reports dropped tools; a bad file is refused before sending", async ({ page }) => {
    const st = await installBuilderMock(page);
    await page.goto("/ui/builder/agents");
    const file = page.getByLabel("Agent export file");
    await file.setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{not json") });
    await expect(page.getByText("This file isn't valid JSON")).toBeVisible();
    expect(sent(st, "POST", "/v1/builder/agents/import")).toEqual([]);

    const bundle = { version: 1, agent: { name: "Imported reviewer", description: "From another workspace" }, skills: [] };
    await file.setInputFiles({ name: "imported.agent.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bundle)) });
    await expect(page.getByText(/Imported Imported reviewer\. Left out 1 tool you don't have access to: Payroll export/)).toBeVisible();
    expect(sent(st, "POST", "/v1/builder/agents/import")).toEqual([{ bundle }]);
    await expect(page.getByRole("heading", { level: 1, name: "Imported reviewer" })).toBeVisible();
  });
});
