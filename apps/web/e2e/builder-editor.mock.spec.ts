/**
 * ADR-0172 — the agent editor's Configure panel, section by section, against
 * the mocked Builder API. Each change asserts the exact body the page sent.
 */
import { expect, test, type Page } from "@playwright/test";
import { CONN_DRIVE, CONN_JIRA, CORA, expectAxeClean, installBuilderMock, sent, TOOL_SEARCH, TOOL_UPDATE, MODEL_B, type MockState } from "./builder-fixtures";

async function openEditor(page: Page, name = "Intake reviewer"): Promise<{ st: MockState; id: string }> {
  const st = await installBuilderMock(page);
  const id = st.agents.find((a) => a.name === name)!.id;
  await page.goto(`/ui/builder/agents/${id}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return { st, id };
}
const panel = (page: Page) => page.getByRole("complementary", { name: "Configure agent" });
const section = (page: Page, title: string) => panel(page).getByRole("region", { name: title });
async function expand(page: Page, title: string) {
  const btn = panel(page).getByRole("button", { name: new RegExp(`^${title}`) });
  if ((await btn.getAttribute("aria-expanded")) === "false") await btn.click();
  await expect(section(page, title)).toBeVisible();
}

test.describe("ADR-0172: agent editor", () => {
  test("layout, a test conversation, and axe in both themes", async ({ page }) => {
    const { st, id } = await openEditor(page);
    await expect(page.getByRole("region", { name: "Conversation" }).getByText("Chatbot pilot questions")).toBeVisible();
    await expectAxeClean(page, "editor");
    await page.getByLabel("Message Intake reviewer").fill("What's new today?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/thread=th-/);
    await expect(page.getByText("Intake reviewer: Here is what I found about: What's new today?")).toBeVisible();
    expect(sent(st, "POST", `/v1/builder/agents/${id}/chat`)).toEqual([{ message: "What's new today?" }]);
    await page.getByRole("button", { name: "Hide settings" }).click();
    await expect(panel(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Configure" }).click();
    await expect(panel(page)).toBeVisible();
  });

  test("channels: Slack connects through the chat connection, Teams still needs setup, both removable", async ({ page }) => {
    const { st, id } = await openEditor(page);
    const ch = section(page, "Channels");
    await ch.getByRole("button", { name: "Set up Slack" }).click();
    await expect(ch.getByText("Connected")).toBeVisible();
    await expect(ch.getByText("Uses Governance Slack")).toBeVisible();
    await ch.getByRole("button", { name: "Set up Microsoft Teams" }).click();
    await expect(ch.getByText("Needs setup")).toBeVisible();
    expect(sent(st, "POST", `/v1/builder/agents/${id}/channels`)).toEqual([{ provider: "slack" }, { provider: "teams" }]);
    await ch.getByRole("button", { name: "Remove Microsoft Teams" }).click();
    await expect(ch.getByText("Needs setup")).toHaveCount(0);
  });

  test("sharing: workspace → specific people, add and remove a person", async ({ page }) => {
    const { st, id } = await openEditor(page);
    const sh = section(page, "Sharing");
    await expect(sh.getByRole("radio", { name: "Workspace" })).toBeChecked();
    await sh.getByRole("radio", { name: "Specific people" }).check();
    await expect(sh.getByText("Only the people below can use it")).toBeVisible();
    await sh.getByLabel("Person to share with").selectOption(CORA);
    await sh.getByRole("button", { name: "Add" }).click();
    await expect(sh.getByRole("button", { name: "Stop sharing with Cora Analyst" })).toBeVisible();
    await sh.getByRole("button", { name: "Stop sharing with Cora Analyst" }).click();
    await expect(sh.getByRole("button", { name: "Stop sharing with Cora Analyst" })).toHaveCount(0);
    expect(sent(st, "PATCH", `/v1/builder/agents/${id}`)).toEqual([
      { sharing: "people" },
      { sharing: "people", sharedUserIds: [CORA] },
      { sharing: "people", sharedUserIds: [] },
    ]);
    await sh.getByRole("radio", { name: "Private" }).check();
    await expect(sh.getByText("Only you (and admins) can see and use it.")).toBeVisible();
  });

  test("connections: format is locked; add a connector and an MCP tool, require approval, remove", async ({ page }) => {
    const { st, id } = await openEditor(page);
    const conn = section(page, "Connections");
    await expect(conn.getByText("Locked")).toBeVisible();
    await expect(conn.getByRole("list", { name: "Toolbox" }).getByRole("listitem")).toHaveCount(1);
    await conn.getByRole("button", { name: "Add connection" }).click();
    const dialog = page.getByRole("dialog", { name: "Add connection" });
    const cards = dialog.getByRole("list", { name: "Available connections" }).getByRole("listitem");
    await expect(cards).toHaveCount(4);
    await expect(dialog.getByRole("button", { name: "Jira (governance) added" })).toBeDisabled();
    await expectAxeClean(page, "add connection dialog");
    await dialog.getByRole("button", { name: "MCP tools" }).click();
    await expect(cards).toHaveCount(2);
    await dialog.getByRole("button", { name: "Add update_policy" }).click();
    await expect(dialog.getByRole("button", { name: "update_policy added" })).toBeVisible();
    await dialog.getByRole("button", { name: "All" }).click();
    await dialog.getByLabel("Search connections").fill("drive");
    await expect(cards).toHaveCount(1);
    await dialog.getByRole("button", { name: "Add Policy drive" }).click();
    await expect(dialog.getByRole("button", { name: "Policy drive added" })).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();

    const puts = sent(st, "PUT", `/v1/builder/agents/${id}/tools`);
    expect(puts[0]).toEqual({
      tools: [
        { kind: "connector", refId: CONN_JIRA, requiresApproval: false },
        { kind: "mcp_tool", refId: TOOL_UPDATE, requiresApproval: true },
      ],
    });
    expect(puts[1].tools).toHaveLength(3);
    expect(puts[1].tools[2]).toEqual({ kind: "connector", refId: CONN_DRIVE, requiresApproval: false });

    const toolbox = conn.getByRole("list", { name: "Toolbox" });
    await expect(toolbox.getByRole("listitem")).toHaveCount(3);
    await expect(toolbox.getByRole("switch", { name: "Ask before update_policy runs" })).toHaveAttribute("aria-checked", "true");
    await toolbox.getByRole("switch", { name: "Ask before Jira (governance) runs" }).click();
    await expect(toolbox.getByRole("switch", { name: "Ask before Jira (governance) runs" })).toHaveAttribute("aria-checked", "true");
    await toolbox.getByRole("button", { name: "Remove Policy drive" }).click();
    await expect(toolbox.getByRole("listitem")).toHaveCount(2);
    expect(sent(st, "PUT", `/v1/builder/agents/${id}/tools`).at(-1).tools.map((t: { refId: string }) => t.refId)).toEqual([CONN_JIRA, TOOL_UPDATE]);
    // the dialog listed only what GET /v1/builder/toolbox-options returned (never server:name ids)
    expect(st.calls.some((c) => c.method === "GET" && c.path === "/v1/builder/toolbox-options")).toBe(true);
    expect(sent(st, "PUT", `/v1/builder/agents/${id}/tools`).flatMap((b) => b.tools.map((t: { refId: string }) => t.refId))).not.toContain(TOOL_SEARCH);
  });

  test("knowledge: save instructions; add a skill from the library and remove one", async ({ page }) => {
    const { st, id } = await openEditor(page);
    const kn = section(page, "Knowledge");
    const save = kn.getByRole("button", { name: "Save instructions" });
    await expect(save).toBeDisabled();
    await kn.getByLabel("Instructions").fill("# Purpose\nReview intake requests.");
    await expect(kn.getByText("Unsaved changes")).toBeVisible();
    await save.click();
    await expect(save).toBeDisabled();
    expect(sent(st, "PATCH", `/v1/builder/agents/${id}`)).toEqual([{ instructions: "# Purpose\nReview intake requests." }]);

    await kn.getByRole("button", { name: "Add skill" }).click();
    const dialog = page.getByRole("dialog", { name: "Add skills" });
    await expect(dialog.getByRole("checkbox", { name: /Assess an AI use case/ })).toBeChecked();
    await dialog.getByRole("checkbox", { name: /Draft an audit finding/ }).check();
    await expectAxeClean(page, "add skills dialog");
    await dialog.getByRole("button", { name: "Save skills" }).click();
    await expect(dialog).toHaveCount(0);
    const skills = kn.getByRole("list", { name: "Attached skills" });
    await expect(skills.getByRole("listitem")).toHaveCount(2);
    await skills.getByRole("button", { name: "Remove skill Assess an AI use case" }).click();
    await expect(skills.getByRole("listitem")).toHaveCount(1);
    expect(sent(st, "PUT", `/v1/builder/agents/${id}/skills`)).toEqual([{ skillIds: ["sk-0001", "sk-0002"] }, { skillIds: ["sk-0002"] }]);
  });

  test("memory: add and remove", async ({ page }) => {
    const { st, id } = await openEditor(page);
    const mem = section(page, "Memory");
    await mem.getByLabel("Something to remember").fill("Escalate anything touching biometrics.");
    await mem.getByRole("button", { name: "Add to memory" }).click();
    const list = mem.getByRole("list", { name: "Memory" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByRole("listitem").first()).toContainText("Escalate anything touching biometrics.");
    expect(sent(st, "POST", `/v1/builder/agents/${id}/memory`)).toEqual([{ content: "Escalate anything touching biometrics." }]);
    await list.getByRole("button", { name: "Remove from memory" }).last().click();
    await expect(list.getByRole("listitem")).toHaveCount(1);
  });

  test("schedules: new schedule dialog, pause, remove", async ({ page }) => {
    const { st, id } = await openEditor(page);
    const sc = section(page, "Schedules");
    await expect(sc.getByText("Weekdays at 08:30 UTC")).toBeVisible();
    await sc.getByRole("button", { name: "New schedule" }).click();
    const dialog = page.getByRole("dialog", { name: "New schedule" });
    const add = dialog.getByRole("button", { name: "Add schedule" });
    await expect(add).toBeDisabled();
    await dialog.getByLabel("Name").fill("Friday brief");
    await dialog.getByRole("radio", { name: "Weekly" }).check();
    await dialog.getByLabel("Time (UTC)").fill("16:00");
    await expect(dialog.getByText(/Once a week at 16:00 UTC/)).toBeVisible();
    await dialog.getByLabel("What should the agent do?").fill("Summarize this week's intake decisions.");
    await expectAxeClean(page, "new schedule dialog");
    await add.click();
    await expect(dialog).toHaveCount(0);
    expect(sent(st, "POST", `/v1/builder/agents/${id}/schedules`)).toEqual([
      { name: "Friday brief", cadence: "weekly", timeUtc: "16:00", prompt: "Summarize this week's intake decisions.", enabled: true },
    ]);
    const list = sc.getByRole("list", { name: "Schedules" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await list.getByRole("switch", { name: "Friday brief on" }).click();
    await expect(list.getByText("Off", { exact: true })).toBeVisible();
    expect(sent(st, "PATCH", `/v1/builder/agents/${id}/schedules/${st.agents.find((a) => a.id === id)!.schedules[1].id}`)).toEqual([{ enabled: false }]);
    await list.getByRole("button", { name: "Remove schedule Morning sweep" }).click();
    await expect(list.getByRole("listitem")).toHaveCount(1);
  });

  test("sub-agents: add one; a cycle is refused by name", async ({ page }) => {
    const { st, id } = await openEditor(page);
    const vendor = st.agents.find((a) => a.name === "Vendor risk assessor")!;
    await expand(page, "Sub-agents");
    const sub = section(page, "Sub-agents");
    await sub.getByRole("button", { name: "New sub-agent" }).click();
    const dialog = page.getByRole("dialog", { name: "New sub-agent" });
    await dialog.getByLabel("Agent to hand work to").selectOption(vendor.id);
    await expect(dialog.getByLabel("Name")).toHaveValue("Vendor risk assessor");
    await dialog.getByLabel("Name").fill("Vendor check");
    await expectAxeClean(page, "new sub-agent dialog");
    await dialog.getByRole("button", { name: "Add sub-agent" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(sub.getByRole("list", { name: "Sub-agents" })).toContainText("Vendor check");
    expect(sent(st, "PUT", `/v1/builder/agents/${id}/subagents`)).toEqual([
      { subagents: [{ childId: vendor.id, name: "Vendor check", description: "Scores third-party AI vendors against the vendor policy." }] },
    ]);

    // the vendor agent now delegates back to intake → adding intake under vendor is a cycle
    await page.goto(`/ui/builder/agents/${vendor.id}`);
    vendor.subagents = [];
    st.agents.find((a) => a.id === id)!.subagents = [{ childId: vendor.id, name: "Vendor check", description: "x", childName: vendor.name }];
    await expand(page, "Sub-agents");
    await section(page, "Sub-agents").getByRole("button", { name: "New sub-agent" }).click();
    const d2 = page.getByRole("dialog", { name: "New sub-agent" });
    await d2.getByLabel("Agent to hand work to").selectOption(id);
    await d2.getByRole("button", { name: "Add sub-agent" }).click();
    await expect(d2.getByRole("alert")).toContainText("Subagent cycle");
    await expect(d2.getByRole("alert")).toContainText("Intake reviewer already hands work to Vendor risk assessor");
  });

  test("advanced: model, spend limit (validated), computer use, use in code, export, delete", async ({ page }) => {
    const { st, id } = await openEditor(page);
    await expand(page, "Advanced");
    const adv = section(page, "Advanced");
    // the shared ModelPicker: logo tiles with model id, tier and readiness
    await expect(adv.getByLabel("Model")).toHaveAccessibleName(/^Model claude-default/);
    await adv.getByLabel("Model").click();
    const models = page.getByRole("dialog", { name: "Choose a model" }).getByRole("listbox", { name: "Models" });
    await expect(models.getByRole("option")).toHaveCount(2);
    await expect(models.getByRole("option", { name: /gpt-review/ })).toContainText("Ready");
    await models.getByRole("option", { name: /gpt-review/ }).click();
    await expect(page.getByText("Model saved")).toBeVisible();
    await expect(adv.getByLabel("Model")).toHaveAccessibleName(/^Model gpt-review/);

    await adv.getByLabel("Monthly spend limit (USD)").fill("0");
    await adv.getByRole("button", { name: "Save limit" }).click();
    await expect(adv.getByText("The limit must be at least $0.01.")).toBeVisible();
    await adv.getByLabel("Monthly spend limit (USD)").fill("75");
    await adv.getByRole("button", { name: "Save limit" }).click();
    await expect(adv.getByText("$42.5 of $75")).toBeVisible();
    await adv.getByLabel("Monthly spend limit (USD)").fill("");
    await adv.getByRole("button", { name: "Save limit" }).click();
    await expect(page.getByText("Spend limit removed")).toBeVisible();
    await adv.getByRole("switch", { name: "Use a computer" }).click();
    await expect(adv.getByRole("switch", { name: "Use a computer" })).toHaveAttribute("aria-checked", "true");
    expect(sent(st, "PATCH", `/v1/builder/agents/${id}`)).toEqual([{ modelAgentId: MODEL_B }, { monthlyLimitUsd: 75 }, { monthlyLimitUsd: null }, { computerUse: true }]);
    await expectAxeClean(page, "editor, advanced open");

    await adv.getByRole("button", { name: "Use in code" }).click();
    const code = page.getByRole("dialog", { name: "Use this agent in code" });
    await expect(code.getByText(id, { exact: true })).toBeVisible();
    await expect(code.getByRole("tabpanel")).toContainText(`/v1/builder/agents/${id}/chat`);
    await expect(code.getByRole("tabpanel")).toContainText("$REGULAIT_API_KEY");
    await code.getByRole("tab", { name: "Python" }).click();
    await expect(code.getByRole("tabpanel")).toContainText("import requests");
    await expectAxeClean(page, "use in code dialog");
    await code.getByRole("button", { name: "Close" }).click();

    const download = page.waitForEvent("download");
    await adv.getByRole("button", { name: "Export" }).click();
    expect((await download).suggestedFilename()).toBe("intake-reviewer.agent.json");

    await adv.getByRole("button", { name: "Delete agent" }).click();
    await page.getByRole("dialog", { name: "Delete Intake reviewer?" }).getByRole("button", { name: "Delete agent" }).click();
    await expect(page).toHaveURL(/\/ui\/builder\/agents$/);
    expect(st.calls.some((c) => c.method === "DELETE" && c.path === `/v1/builder/agents/${id}`)).toBe(true);
    await expect(page.getByRole("link", { name: "Open Intake reviewer" })).toHaveCount(0);
  });

  test("an agent shared with you is view only, and flags tools you lack", async ({ page }) => {
    await openEditor(page, "Policy Q&A");
    await expect(panel(page).getByText("View only")).toBeVisible();
    await expect(section(page, "Connections").getByText("Not available to you")).toBeVisible();
    await expect(section(page, "Connections").getByRole("button", { name: "Add connection" })).toBeDisabled();
    await expect(section(page, "Sharing").getByRole("radio", { name: "Private" })).toBeDisabled();
    await expect(section(page, "Channels").getByRole("button", { name: "Set up Slack" })).toBeDisabled();
    await expectAxeClean(page, "editor, view only");
  });

  test("a missing agent says so and offers the way back", async ({ page }) => {
    await installBuilderMock(page);
    await page.goto("/ui/builder/agents/aaaaaaaa-9999-4000-8000-000000000000");
    await expect(page.getByText("No such agent")).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to your agents" })).toBeVisible();
  });
});
