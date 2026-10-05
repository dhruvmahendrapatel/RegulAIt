/**
 * ADR-0172 — builder templates, apps & tools, the skill library and usage,
 * against the mocked Builder API.
 */
import { expect, test } from "@playwright/test";
import { expectAxeClean, installBuilderMock, PROJECT, sent } from "./builder-fixtures";

test.describe("ADR-0172: templates", () => {
  test("cards by RegulAIt → detail explains the agent → Create agent seeds it from the template", async ({ page }) => {
    const st = await installBuilderMock(page);
    await page.goto("/ui/builder/templates");
    await expect(page.getByRole("heading", { level: 1, name: "Agent templates" })).toBeVisible();
    const cards = page.getByRole("list", { name: "Templates" });
    await expect(cards.getByRole("link")).toHaveCount(2);
    await expect(cards.getByText("by RegulAIt")).toHaveCount(2);
    await expect(cards.getByRole("link", { name: /AI intake reviewer/ }).getByRole("img", { name: "jira" })).toBeVisible();
    await page.getByRole("radio", { name: "Risk" }).check();
    await expect(cards.getByRole("link")).toHaveCount(1);
    await page.getByRole("radio", { name: "All" }).check();
    await expectAxeClean(page, "templates");

    await cards.getByRole("link", { name: /AI intake reviewer/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "AI intake reviewer" })).toBeVisible();
    await expect(page.getByText("Flags missing data-handling and ownership details")).toBeVisible();
    for (const name of ["Jira", "Slack", "Google Drive"]) await expect(page.getByRole("img", { name }).first()).toBeVisible();
    await expect(page.getByText("Gathers the documents a request refers to.")).toBeVisible();
    await expect(page.getByText("Weekdays at 08:30 UTC")).toBeVisible();
    await page.getByRole("button", { name: "Show the full instructions" }).click();
    await expect(page.getByText("Never approve or reject.")).toBeVisible();
    await expectAxeClean(page, "template detail");

    await page.getByRole("button", { name: "Create agent" }).click();
    const dialog = page.getByRole("dialog", { name: "New agent from AI intake reviewer" });
    await expect(dialog.getByLabel("Name your agent")).toHaveValue("AI intake reviewer");
    await dialog.getByRole("button", { name: "Create agent" }).click();
    await expect(page).toHaveURL(/\/ui\/builder\/agents\/aaaaaaaa-.*setup=1/);
    expect(sent(st, "POST", "/v1/builder/agents")).toEqual([
      { name: "AI intake reviewer", connectionFormat: "shared", computerUse: false, projectId: PROJECT, templateId: "ai-intake-reviewer" },
    ]);
    await expect(page.getByRole("group", { name: "Agent setup" }).getByText("Assess an AI use case")).toBeVisible();

    // the template's schedule arrives OFF (nothing spends until the owner turns it on)
    const schedules = page.getByRole("complementary", { name: "Configure agent" }).getByRole("region", { name: "Schedules" });
    const row = schedules.getByRole("listitem").filter({ hasText: "Morning sweep" });
    await expect(row.getByText("Off", { exact: true })).toBeVisible();
    await expect(row).toContainText("turn it on to start running");
    const toggle = row.getByRole("switch", { name: "Morning sweep on" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(row.getByText("Off", { exact: true })).toHaveCount(0);
    await expect(row).toContainText("next ");
    const created = st.agents.find((a) => a.templateId === "ai-intake-reviewer")!;
    expect(sent(st, "PATCH", `/v1/builder/agents/${created.id}/schedules/${created.schedules[0].id}`)).toEqual([{ enabled: true }]);
  });

  test("a missing template and a failed list", async ({ page }) => {
    await installBuilderMock(page);
    await page.goto("/ui/builder/templates/no-such-template");
    await expect(page.getByText("No such template")).toBeVisible();
    const page2 = await page.context().newPage();
    await installBuilderMock(page2, { fail: ["/templates"] });
    await page2.goto("/ui/builder/templates");
    await expect(page2.getByRole("alert").filter({ hasText: "Couldn't load templates" })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("ADR-0172: apps & tools", () => {
  test("vendor groups with logos; All / Connected, categories and search filter; custom MCP list", async ({ page }) => {
    await installBuilderMock(page);
    await page.goto("/ui/builder/integrations");
    await expect(page.getByRole("heading", { level: 1, name: "Apps & tools" })).toBeVisible();
    const groups = page.locator("section[aria-labelledby^='grp-']");
    await expect(groups).toHaveCount(4);
    await expect(page.getByRole("heading", { name: "Atlassian" })).toBeVisible();
    await expect(page.getByRole("img", { name: "Confluence" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Connect Confluence" })).toHaveAttribute("href", "/ui/admin/connectors");
    await expect(page.getByText("policy-docs")).toBeVisible();
    await expectAxeClean(page, "apps & tools");

    const filters = page.getByRole("navigation", { name: "Filter apps" });
    await filters.getByRole("button", { name: /Connected/ }).click();
    await expect(page.getByText("Connected", { exact: true }).filter({ hasNot: page.locator("button") })).toHaveCount(3);
    await expect(groups).toHaveCount(3);
    await filters.getByRole("button", { name: "Communication" }).click();
    await expect(groups).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();
    await filters.getByRole("button", { name: /^All/ }).click();
    await expect(groups).toHaveCount(2); // communication: Google (Gmail) and Chat (Slack)
    await filters.getByRole("button", { name: "Any category" }).click();
    await page.getByLabel("Search apps").fill("okta");
    await expect(groups).toHaveCount(1);
    await page.getByLabel("Search apps").fill("nothing at all");
    await expect(page.getByText("No matching apps")).toBeVisible();
  });

  test("people who aren't admins see what to ask for, not a connect link", async ({ page }) => {
    await installBuilderMock(page, { isAdmin: false });
    await page.goto("/ui/builder/integrations");
    await expect(page.getByRole("heading", { name: "Atlassian" })).toBeVisible();
    await expect(page.getByRole("link", { name: /^Connect / })).toHaveCount(0);
    await expect(page.getByText("Not connected").first()).toBeVisible();
  });
});

test.describe("ADR-0172: skill library", () => {
  test("create in the drawer, open and edit, import a SKILL.md, read-only skills", async ({ page }) => {
    const st = await installBuilderMock(page);
    await page.goto("/ui/builder/skills");
    await expect(page.getByRole("heading", { level: 1, name: "Skill library" })).toBeVisible();
    const list = page.getByRole("list", { name: "Skills" });
    await expect(list.getByRole("listitem")).toHaveCount(3);
    await page.getByRole("radio", { name: "Only mine" }).check();
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await page.getByRole("radio", { name: "All" }).check();
    await expectAxeClean(page, "skills");

    await page.getByRole("button", { name: "New skill" }).click();
    const drawer = page.getByRole("dialog", { name: "New skill" });
    await expect(drawer.getByLabel("Name")).toBeFocused();
    await drawer.getByLabel("Name").fill("Check a model card");
    await drawer.getByLabel("When to use it").fill("Use when a model card needs review.");
    await drawer.getByRole("radio", { name: /Only me/ }).check();
    await expectAxeClean(page, "skill drawer");
    await drawer.getByRole("button", { name: "Create skill" }).click();
    await expect(drawer).toHaveCount(0);
    const created = sent(st, "POST", "/v1/builder/skills")[0];
    expect(created).toMatchObject({ name: "Check a model card", description: "Use when a model card needs review.", visibility: "private" });
    expect(created.body).toContain("name:");
    await expect(list.getByRole("listitem")).toHaveCount(4);

    await list.getByRole("button", { name: "Open skill Assess an AI use case" }).click();
    const edit = page.getByRole("dialog", { name: "Edit skill" });
    await expect(edit.getByLabel("SKILL.md")).toHaveValue(/Read the request/);
    await edit.getByLabel("When to use it").fill("Use for every new AI use case.");
    await edit.getByRole("button", { name: "Save skill" }).click();
    await expect(edit).toHaveCount(0);
    expect(sent(st, "PATCH", "/v1/builder/skills/sk-0001")[0]).toMatchObject({ description: "Use for every new AI use case." });

    await list.getByRole("button", { name: "Open skill Draft an audit finding" }).click();
    const ro = page.getByRole("dialog", { name: "Draft an audit finding" });
    await expect(ro.getByText("only its owner can change it")).toBeVisible();
    await expect(ro.getByLabel("Name")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(ro).toHaveCount(0);

    const file = page.getByLabel("SKILL.md file");
    await file.setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# no frontmatter") });
    await expect(page.getByText("This file has no name in its frontmatter")).toBeVisible();
    expect(sent(st, "POST", "/v1/builder/skills/import")).toEqual([]);
    const md = "---\nname: Triage an incident\ndescription: Use when an AI incident is reported.\n---\n# Steps\n";
    await file.setInputFiles({ name: "SKILL.md", mimeType: "text/markdown", buffer: Buffer.from(md) });
    await expect(page.getByText("Imported Triage an incident")).toBeVisible();
    expect(sent(st, "POST", "/v1/builder/skills/import")).toEqual([{ markdown: md }]);
  });

  test("empty library and a failed load", async ({ page }) => {
    await installBuilderMock(page, { empty: true });
    await page.goto("/ui/builder/skills");
    await expect(page.getByText("No skills yet")).toBeVisible();
    const page2 = await page.context().newPage();
    await installBuilderMock(page2, { fail: ["/skills"] });
    await page2.goto("/ui/builder/skills");
    await expect(page2.getByRole("alert").filter({ hasText: "Couldn't load skills" })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("ADR-0172: agent usage", () => {
  test("totals, a zero-filled daily chart with a table view, breakdowns with limits, and the period switch", async ({ page }) => {
    const st = await installBuilderMock(page);
    await page.goto("/ui/builder/usage");
    await expect(page.getByRole("heading", { level: 1, name: "Agent usage" })).toBeVisible();
    const totals = page.getByRole("region", { name: "Totals" });
    await expect(totals).toContainText("$12.34");
    await expect(totals).toContainText("210");
    const bars = page.getByRole("list", { name: "Daily spend" }).getByRole("listitem");
    await expect(bars).toHaveCount(7);
    await expect(bars.last()).toHaveAttribute("aria-label", /\$2\.5/);
    await expect(bars.nth(4)).toHaveAttribute("aria-label", /\$0(\.00)?, 0 messages/);
    await expect(page.getByRole("link", { name: "Intake reviewer" })).toBeVisible();
    await expect(page.getByRole("meter", { name: "Intake reviewer spend against its limit" })).toBeVisible();
    await expectAxeClean(page, "usage");

    await page.getByRole("button", { name: "Show as table" }).click();
    await expect(page.getByRole("button", { name: "Show chart" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Show chart" }).click();

    await page.getByRole("tab", { name: "By model" }).click();
    await expect(page.getByRole("img", { name: "anthropic" })).toBeVisible();
    await expect(page.getByText("claude-sonnet")).toBeVisible();
    await page.getByRole("tab", { name: "By person" }).click();
    await expect(page.getByText("Drew Reviewer")).toBeVisible();

    await page.getByLabel("Period").selectOption("30");
    await expect(bars).toHaveCount(30);
    await expect(totals).toContainText("$49.36");
    expect(st.calls.filter((c) => c.path.startsWith("/v1/builder/usage")).map((c) => c.path)).toEqual(["/v1/builder/usage?days=7", "/v1/builder/usage?days=30"]);
  });

  test("no activity and a failed load", async ({ page }) => {
    await installBuilderMock(page, { empty: true });
    await page.goto("/ui/builder/usage");
    await expect(page.getByText("No spend in this period")).toBeVisible();
    await expect(page.getByText("No agent activity in this period")).toBeVisible();
    await expectAxeClean(page, "usage, empty");
    const page2 = await page.context().newPage();
    await installBuilderMock(page2, { fail: ["/usage"] });
    await page2.goto("/ui/builder/usage");
    await expect(page2.getByRole("alert").filter({ hasText: "Couldn't load usage" })).toBeVisible({ timeout: 15_000 });
  });
});
