/**
 * ADR-0172 — builder Chat and Inbox against the mocked Builder API.
 */
import { expect, test } from "@playwright/test";
import { expectAxeClean, installBuilderMock, sent } from "./builder-fixtures";

test.describe("ADR-0172: agent chat", () => {
  test("ask anything: connected-app logos, agent picker, send opens the thread with the reply", async ({ page }) => {
    const st = await installBuilderMock(page);
    await page.goto("/ui/builder");
    await expect(page.getByRole("heading", { level: 1, name: "Agent chat" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ask anything" })).toBeVisible();
    const strip = page.getByRole("group", { name: "Connected integrations" });
    for (const name of ["Jira", "Google Drive", "Slack"]) await expect(strip.getByRole("img", { name })).toBeVisible();
    await expect(strip.getByRole("img", { name: "Gmail" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Morning sweep — 3 new requests/ })).toBeVisible();
    await expectAxeClean(page, "chat start");

    const vendor = st.agents.find((a) => a.name === "Vendor risk assessor")!;
    // the shared picker, as agent tiles showing the model each one runs on
    await page.getByLabel("Agent").click();
    const agentList = page.getByRole("dialog", { name: "Choose an agent" }).getByRole("listbox", { name: "Agents" });
    await expect(agentList.getByRole("option")).toHaveCount(3);
    await expect(agentList.getByRole("option", { name: /Vendor risk assessor/ })).toContainText("gpt-review");
    await agentList.getByRole("option", { name: /Vendor risk assessor/ }).click();
    await expect(page.getByLabel("Agent")).toHaveAccessibleName(/^Agent Vendor risk assessor/);
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await page.getByLabel("Message").fill("Which vendors are high risk?");
    await page.getByLabel("Message").press("Enter");
    await expect(page).toHaveURL(/\?thread=th-/);
    expect(sent(st, "POST", `/v1/builder/agents/${vendor.id}/chat`)).toEqual([{ message: "Which vendors are high risk?" }]);
    await expect(page.getByText("Here is what I found about: Which vendors are high risk?")).toBeVisible();
    await expect(page.getByRole("link", { name: "Vendor risk assessor" })).toBeVisible();

    // a follow-up continues the same thread
    await page.getByLabel("Message").fill("And the cheapest?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Here is what I found about: And the cheapest?")).toBeVisible();
    const bodies = sent(st, "POST", `/v1/builder/agents/${vendor.id}/chat`);
    expect(bodies[1]).toMatchObject({ message: "And the cheapest?", threadId: expect.stringMatching(/^th-/) });
    await expectAxeClean(page, "chat thread");
  });

  test("a refused send shows the reason and keeps the page usable", async ({ page }) => {
    const st = await installBuilderMock(page);
    const intake = st.agents.find((a) => a.name === "Intake reviewer")!;
    intake.spentThisMonthUsd = 50; // at its limit → 402
    await page.goto("/ui/builder");
    await page.getByLabel("Message").fill("hello");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("alert")).toContainText(/agent spend limit reached/i);
    await expect(page.getByRole("alert")).toContainText("monthly limit");
    await expect(page.getByLabel("Message")).toBeEnabled();
    // the limit is checked before anything is recorded: no thread was opened
    await expect(page).not.toHaveURL(/thread=/);
  });

  test("a refusal recorded in a thread opens that thread with the refusal note", async ({ page }) => {
    await installBuilderMock(page, { denyModel: true });
    await page.goto("/ui/builder");
    await page.getByLabel("Message").fill("Summarise today");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/\?thread=th-/);
    await expect(page.getByRole("alert")).toContainText("no grant for agent 'claude-default'");
    await expect(page.getByText("Refused (agent_denied): no grant for agent 'claude-default'")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Summarise today" })).toBeVisible();
  });

  test("no agents: the start page offers New agent and templates", async ({ page }) => {
    await installBuilderMock(page, { empty: true });
    await page.goto("/ui/builder");
    await expect(page.getByText("Create your first agent")).toBeVisible();
    await expect(page.getByText("No threads yet")).toBeVisible();
    await expectAxeClean(page, "chat empty");
    await page.getByRole("button", { name: "New agent" }).click();
    await expect(page.getByRole("dialog", { name: "New agent" })).toBeVisible();
  });
});

test.describe("ADR-0172: agent inbox", () => {
  test("tabs, search, read a thread, reply, mark done", async ({ page }) => {
    const st = await installBuilderMock(page);
    await page.goto("/ui/builder/inbox");
    await expect(page.getByRole("heading", { level: 1, name: "Agent inbox" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Needs attention" })).toHaveAttribute("aria-selected", "true");
    const list = page.getByRole("list", { name: "Threads" });
    await expect(list.getByRole("button")).toHaveCount(1);
    await expect(page.getByText("Choose a thread")).toBeVisible();
    await expectAxeClean(page, "inbox");

    await list.getByRole("button", { name: /Morning sweep/ }).click();
    await expect(page).toHaveURL(/thread=th-0001/);
    await expect(page.getByText("Two are missing a data owner")).toBeVisible();
    await expect(page.getByText("Scheduled run: Morning sweep")).toBeVisible();
    await expectAxeClean(page, "inbox, thread open");

    await page.getByLabel("Reply").fill("Ask both owners to fill it in.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Intake reviewer: Here is what I found about: Ask both owners to fill it in.")).toBeVisible();

    await page.getByRole("button", { name: "Mark as done" }).click();
    expect(sent(st, "PATCH", "/v1/builder/threads/th-0001")).toEqual([{ status: "completed" }]);
    await expect(page.getByText("Nothing needs you right now")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();

    await page.getByRole("tab", { name: "All" }).click();
    await expect(list.getByRole("button")).toHaveCount(3);
    await page.getByLabel("Search threads").fill("vendor");
    await expect(list.getByRole("button")).toHaveCount(1);
    await page.getByLabel("Search threads").fill("zzz");
    await expect(page.getByText("No matching threads")).toBeVisible();
  });

  test("empty and error states", async ({ page }) => {
    await installBuilderMock(page, { empty: true });
    await page.goto("/ui/builder/inbox?tab=completed");
    await expect(page.getByText("No completed threads yet")).toBeVisible();

    const page2 = await page.context().newPage();
    await installBuilderMock(page2, { fail: ["/threads"] });
    await page2.goto("/ui/builder/inbox");
    await expect(page2.getByRole("alert").filter({ hasText: "Couldn't load threads" })).toBeVisible({ timeout: 15_000 });
  });
});
