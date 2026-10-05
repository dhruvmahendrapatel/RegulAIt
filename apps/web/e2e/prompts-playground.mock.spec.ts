/**
 * ADR-0173 batch 2b — the Agent Builder's Prompts and Playground screens
 * against the mocked registry and playground API (prompts-fixtures.ts).
 */
import { expect, test } from "@playwright/test";
import { CORA, DREW, MODEL_A, MODEL_B } from "./builder-fixtures";
import { DATASET, expectAxeClean, H1, H2, installPromptsMock, P1, sentTo, TEMPLATE_1 } from "./prompts-fixtures";

test.describe("ADR-0173 2b: prompts", () => {
  test("list → create (named people) → detail: history, tags, diff, sharing", async ({ page }) => {
    const st = await installPromptsMock(page, { isAdmin: false });
    await page.goto("/ui/builder/prompts");
    await expect(page.getByRole("heading", { level: 1, name: "Prompts" })).toBeVisible();
    const list = page.getByRole("list", { name: "Prompts" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByRole("link", { name: "Open prompt use-case-summary" })).toContainText("prod");
    await page.getByRole("radio", { name: "Only mine" }).check();
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await page.getByRole("radio", { name: "All I can see" }).check();
    await expectAxeClean(page, "prompts list");

    await page.getByRole("button", { name: "New prompt" }).click();
    const dialog = page.getByRole("dialog", { name: "New prompt" });
    await dialog.getByLabel("Name").fill("risk-digest");
    await dialog.getByLabel("Description").fill("Weekly risk digest");
    await dialog.getByRole("radio", { name: /Specific people/ }).check();
    await dialog.getByLabel("Person to share with").selectOption(CORA);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog.getByRole("list", { name: "Shared with" })).toContainText("Cora Analyst");
    await expectAxeClean(page, "new prompt dialog");
    await dialog.getByRole("button", { name: "Create prompt" }).click();
    expect(sentTo(st, "POST", "/v1/prompts")).toEqual([
      { name: "risk-digest", description: "Weekly risk digest", visibility: "people", sharedUserIds: [CORA], projectId: null },
    ]);
    await expect(page.getByRole("heading", { level: 1, name: "risk-digest" })).toBeVisible();
    await expect(page.getByText("No commits yet")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the playground" })).toHaveAttribute("href", /\/ui\/builder\/playground\?prompt=/);

    await page.goto(`/ui/builder/prompts/${P1}`);
    await expect(page.getByRole("heading", { level: 1, name: "use-case-summary" })).toBeVisible();
    const commits = page.getByRole("list", { name: "Commits" });
    await expect(commits.getByRole("listitem")).toHaveCount(2);
    await expect(commits.getByRole("listitem").first()).toContainText("three bullets");
    // the diff of the two commits, line by line, with + / − announced in words
    const diff = page.getByRole("list", { name: "Template changes" });
    await expect(diff.getByRole("listitem")).toHaveCount(2);
    await expect(diff.getByRole("listitem").nth(1)).toContainText("Added: Use three bullet points.");
    await expect(page.getByTestId("diff-stats")).toHaveText("Template: 1 line added, 0 removed");
    expect(st.calls.some((c) => c.path === `/v1/prompts/${P1}/diff?from=${H1}&to=${H2}`)).toBe(true);
    await expectAxeClean(page, "prompt detail");

    // view an older commit
    await commits.getByRole("button", { name: `View commit ${H1.slice(0, 12)}` }).click();
    await expect(page.getByRole("region", { name: `Commit ${H1.slice(0, 12)}` }).getByLabel("Template")).toHaveText(TEMPLATE_1);

    // sharing
    const sharing = page.getByRole("region", { name: "Sharing" });
    await sharing.getByRole("radio", { name: /Only me/ }).check();
    await sharing.getByRole("button", { name: "Save sharing" }).click();
    await expect(page.getByText("Sharing saved")).toBeVisible();
    expect(sentTo(st, "PATCH", `/v1/prompts/${P1}`)).toEqual([{ visibility: "private", sharedUserIds: [] }]);
  });

  test("a non-prod tag moves at once; prod goes to an approver who is neither me nor the author", async ({ page }) => {
    const st = await installPromptsMock(page, { isAdmin: false });
    await page.goto(`/ui/builder/prompts/${P1}`);
    const commits = page.getByRole("list", { name: "Commits" });

    await commits.getByRole("button", { name: `Move a tag to commit ${H1.slice(0, 12)}` }).click();
    let dialog = page.getByRole("dialog", { name: `Move a tag to ${H1.slice(0, 12)}` });
    await expect(dialog.getByLabel("Tag")).toHaveValue("staging");
    await dialog.getByRole("button", { name: "Move tag" }).click();
    await expect(page.getByText(`staging now points at ${H1.slice(0, 12)}`)).toBeVisible();
    expect(sentTo(st, "PUT", `/v1/prompts/${P1}/tags/staging`)).toEqual([{ commitHash: H1 }]);

    // H2 was written by Drew: the approver list offers neither me nor Drew
    await commits.getByRole("button", { name: `Move a tag to commit ${H2.slice(0, 12)}` }).click();
    dialog = page.getByRole("dialog", { name: `Move a tag to ${H2.slice(0, 12)}` });
    await dialog.getByLabel("Tag").fill("prod");
    await expect(dialog.getByTestId("prod-note")).toContainText("approvals queue");
    const approver = dialog.getByLabel("Approver");
    await expect(approver.locator("option")).toHaveText(["Choose an approver", "Cora Analyst"]);
    await expect(dialog.getByRole("button", { name: "Request promotion" })).toBeDisabled();
    await expectAxeClean(page, "move prod dialog");
    await approver.selectOption(CORA);
    await dialog.getByRole("button", { name: "Request promotion" }).click();
    await expect(page.getByText("Sent to Cora Analyst for approval")).toBeVisible();
    expect(sentTo(st, "PUT", `/v1/prompts/${P1}/tags/prod`)).toEqual([{ commitHash: H2, approverUserId: CORA }]);
    const promotions = page.getByRole("list", { name: "Promotions" });
    await expect(promotions).toContainText("waiting for approval");
    await expect(promotions).toContainText("approver Cora Analyst");
    // prod itself did not move
    await expect(page.getByRole("list", { name: "Tags" }).getByRole("listitem").filter({ hasText: "prod" })).toContainText(H1.slice(0, 12));
    void DREW;

    // archiving waits while a promotion is pending — the gateway's words are shown
    await page.getByRole("button", { name: "Archive" }).click();
    await page.getByRole("dialog", { name: "Archive use-case-summary?" }).getByRole("button", { name: "Archive prompt" }).click();
    await expect(page.getByText(/waiting on the approvals queue/).first()).toBeVisible();
    expect(sentTo(st, "DELETE", `/v1/prompts/${P1}`)).toHaveLength(1);
  });

  test("someone else's prompt is read-only, and archiving my own returns to the list", async ({ page }) => {
    const st = await installPromptsMock(page, { isAdmin: false });
    await page.goto("/ui/builder/prompts");
    await page.getByRole("link", { name: "Open prompt vendor-brief" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "vendor-brief" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Move a tag/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);
    await expect(page.getByText("Only the owner or an admin can change who sees it.")).toBeVisible();

    await page.goto(`/ui/builder/prompts/${P1}`);
    await page.getByRole("button", { name: "Archive" }).click();
    await page.getByRole("dialog", { name: "Archive use-case-summary?" }).getByRole("button", { name: "Archive prompt" }).click();
    await expect(page).toHaveURL(/\/ui\/builder\/prompts$/);
    await expect(page.getByRole("list", { name: "Prompts" }).getByRole("listitem")).toHaveCount(1);
    expect(sentTo(st, "DELETE", `/v1/prompts/${P1}`)).toHaveLength(1);
  });
});

test.describe("ADR-0173 2b: playground", () => {
  test("opens a commit, builds inputs from variables, runs with Ctrl+Enter as a governed call, saves a commit", async ({ page }) => {
    const st = await installPromptsMock(page, { isAdmin: false });
    await page.goto(`/ui/builder/playground?prompt=${P1}&commit=${H1}`);
    await expect(page.getByRole("heading", { level: 1, name: "Playground" })).toBeVisible();
    await expect(page.getByLabel("Template")).toHaveValue(TEMPLATE_1);
    await expect(page.getByRole("list", { name: "Detected variables" }).getByRole("listitem")).toHaveText(["document", "audience"]);
    await expect(page.getByLabel("Model")).toHaveAccessibleName(/^Model claude-default/);
    await expect(page.getByTestId("tools-not-executed")).toContainText("it is not run in the playground");
    await expectAxeClean(page, "playground");

    // a new variable in the template adds an input
    await page.getByLabel("Template").fill(`${TEMPLATE_1} Tone: {{tone}}`);
    await expect(page.getByRole("list", { name: "Detected variables" }).getByRole("listitem")).toHaveText(["document", "audience", "tone"]);
    await page.getByLabel("document", { exact: true }).fill("the intake form");
    await page.getByLabel("audience", { exact: true }).fill("reviewers");
    await page.getByLabel("tone", { exact: true }).fill("plain");
    await page.getByLabel("tone", { exact: true }).press("Control+Enter");
    const out = page.getByTestId("run-output");
    await expect(out.getByLabel("Model output")).toHaveText("Summary for reviewers: fine.");
    await expect(out).toContainText("$0.0021");
    expect(sentTo(st, "POST", "/v1/playground/run")).toEqual([
      {
        template: `${TEMPLATE_1} Tone: {{tone}}`,
        variables: { document: "the intake form", audience: "reviewers", tone: "plain" },
        modelAgentId: MODEL_A,
        outputSchema: null,
        tools: [],
        projectId: null,
      },
    ]);

    // an output schema and a tool: the schema verdict and the un-run tool call are shown
    await page.getByLabel("JSON Schema").fill('{"type":"object","properties":{"summary":{"type":"string"}}}');
    await page.getByRole("button", { name: "Add a tool" }).click();
    const tool = page.getByRole("group", { name: "Tool 1" });
    await tool.getByLabel("Name").fill("search_policies");
    await tool.getByLabel("Description").fill("Search policy pages");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(out.getByRole("status")).toContainText("Matches the output schema");
    await expect(out.getByRole("list", { name: "Tool calls" })).toContainText("search_policies");
    await expect(out.getByRole("list", { name: "Tool calls" })).toContainText("not executed");
    const second = sentTo(st, "POST", "/v1/playground/run")[1];
    expect(second.outputSchema).toEqual({ type: "object", properties: { summary: { type: "string" } } });
    expect(second.tools).toEqual([{ name: "search_policies", description: "Search policy pages", inputSchema: { type: "object", properties: {} } }]);
    await expectAxeClean(page, "playground with output");

    // a refusal is shown in the gateway's words, with its code
    await page.getByLabel("document", { exact: true }).fill("over budget");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const refusal = page.getByTestId("playground-refusal");
    await expect(refusal).toContainText("Not run.");
    await expect(refusal).toContainText("project_budget_exceeded");

    // save as a commit on the prompt it came from: the parent is the opened commit
    await page.getByRole("button", { name: "Save as commit" }).click();
    const dialog = page.getByRole("dialog", { name: "Save as commit" });
    await expect(dialog.getByLabel("Prompt")).toHaveValue(P1);
    await expect(dialog.getByTestId("commit-parent")).toContainText(`Edited from ${H1.slice(0, 12)}`);
    await dialog.getByLabel("What changed").fill("Add a tone");
    await expectAxeClean(page, "save as commit");
    await dialog.getByRole("button", { name: "Save commit" }).click();
    await expect(dialog).toHaveCount(0);
    const [saved] = sentTo(st, "POST", `/v1/prompts/${P1}/commits`);
    expect(saved).toEqual({
      template: `${TEMPLATE_1} Tone: {{tone}}`,
      modelConfig: { agentId: MODEL_A, maxTokens: null },
      outputSchema: { type: "object", properties: { summary: { type: "string" } } },
      tools: [{ name: "search_policies", description: "Search policy pages", inputSchema: { type: "object", properties: {} } }],
      parentHash: H1,
      message: "Add a tone",
    });
    await expect(page).toHaveURL(new RegExp(`prompt=${P1}&commit=[0-9a-f]{64}`));
    await expect(page.getByRole("link", { name: /use-case-summary @/ })).toBeVisible();
  });

  test("a model the org's policy forbids for the playground is shown as not allowed", async ({ page }) => {
    await installPromptsMock(page, {
      isAdmin: false,
      policyRules: [{ feature: "playground", dataClass: null, restricted: true, allowedAgentIds: [MODEL_A], allowedProviders: [], defaultAgentId: MODEL_A }],
    });
    await page.goto("/ui/builder/playground");
    await page.getByLabel("Model").click();
    const listbox = page.getByRole("listbox", { name: "Models" });
    const forbidden = listbox.getByRole("option", { name: /gpt-review/ });
    await expect(forbidden).toHaveAttribute("aria-disabled", "true");
    await expect(forbidden).toContainText("Not allowed here");
    await expect(forbidden).toHaveAccessibleDescription(/does not allow this model for Prompt playground/);
    void MODEL_B;
  });

  test("evaluate mode: inline rows, one governed call each, with the total cost; admins can use a dataset", async ({ page }) => {
    const st = await installPromptsMock(page, { isAdmin: true });
    await page.goto("/ui/builder/playground");
    await page.getByLabel("Template").fill("Classify {{document}}.");
    await page.getByRole("radio", { name: "Evaluate" }).check();
    const rows = page.getByRole("table", { name: "Evaluation rows" });
    await expect(rows.getByRole("row")).toHaveCount(2); // header + one row
    await page.getByLabel("Row 1 document").fill("first");
    await page.getByLabel("Row 1 reference").fill("out 1");
    await page.getByRole("button", { name: /Add a row/ }).click();
    await page.getByLabel("Row 2 document").fill("second");
    await expectAxeClean(page, "evaluate rows");
    await page.getByRole("button", { name: "Run 2 rows" }).click();
    const out = page.getByTestId("evaluate-output");
    await expect(out.getByRole("status")).toContainText("2 of 2 rows ran. Total cost $0.02.");
    await expect(out.getByRole("status")).toContainText("1 of 1 matched their reference.");
    await expect(out.getByRole("table", { name: "Evaluation results" }).getByRole("row")).toHaveCount(3);
    expect(sentTo(st, "POST", "/v1/playground/evaluate")[0]).toMatchObject({
      template: "Classify {{document}}.",
      modelAgentId: MODEL_A,
      rows: [
        { inputs: { document: "first" }, reference: "out 1" },
        { inputs: { document: "second" }, reference: null },
      ],
    });
    await expectAxeClean(page, "evaluate results");

    await page.getByLabel("Rows from").selectOption(DATASET);
    await page.getByRole("button", { name: "Run the dataset" }).click();
    await expect(out.getByRole("status")).toContainText("2 of 2 rows ran");
    expect(sentTo(st, "POST", "/v1/playground/evaluate")[1]).toMatchObject({ datasetId: DATASET });
    expect(sentTo(st, "POST", "/v1/playground/evaluate")[1].rows).toBeUndefined();
  });
});
