/**
 * ADR-0173 §1 — governed tool use in the builder's thread panes, against the
 * mocked Builder API: tool steps as collapsible rows, the "Ask first"
 * confirmation card (a confirmation, not an approval), and the organisation
 * approval wait (no buttons — the approvals queue decides).
 */
import { expect, test } from "@playwright/test";
import { expectAxeClean, installBuilderMock, sent, toolStep } from "./builder-fixtures";

test.describe("ADR-0173: tool steps in a thread", () => {
  test("a tool call renders as a collapsible step with its logo, status, redacted arguments, result and cost", async ({ page }) => {
    const st = await installBuilderMock(page, { toolMode: "plain" });
    await page.goto("/ui/builder");
    await page.getByLabel("Message").fill("Which policies cover vendor risk?");
    await page.getByLabel("Message").press("Enter");
    await expect(page).toHaveURL(/\?thread=th-/);
    await expect(page.getByText("Three policies cover vendor risk.")).toBeVisible();
    const steps = page.getByRole("list", { name: "Tool calls" });
    const row = steps.getByRole("listitem");
    await expect(row).toHaveCount(1);
    const head = row.getByRole("button", { name: /policy-docs \/ search_policies/ });
    await expect(head).toHaveAttribute("aria-expanded", "false");
    await expect(head).toContainText("Done");
    await expect(head).toContainText("$0.01");
    await expect(row.getByRole("img", { name: "policy-docs" })).toBeVisible();
    // collapsed: no arguments on screen
    await expect(page.getByText('"vendor risk"')).toHaveCount(0);
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    await expect(row.getByText('"query": "vendor risk"')).toBeVisible();
    // the stored preview is redacted by the gateway — the page shows it as it came
    await expect(row.getByText('"apiKey": "[REDACTED]"')).toBeVisible();
    await expect(row.getByText("3 policies matched: Vendor risk, Data retention, AI use")).toBeVisible();
    await expectAxeClean(page, "thread with a tool step");
    expect(st.calls.some((c) => c.path.includes("/confirm"))).toBe(false);
  });

  test("a withheld result says so instead of showing it", async ({ page }) => {
    const st = await installBuilderMock(page);
    const th = st.threads[0]!;
    st.messages[th.id] = [
      { id: "m-w1", role: "user", content: "Look up the customer", model: null, costUsd: null, latencyMs: null, createdAt: new Date().toISOString(), steps: [] },
      {
        id: "m-w2",
        role: "agent",
        content: "I looked the customer up.",
        model: "claude-sonnet",
        costUsd: 0.002,
        latencyMs: 900,
        createdAt: new Date().toISOString(),
        steps: [toolStep({ messageId: "m-w2", resultPreview: null, resultWithheld: true })],
      },
    ];
    await page.goto(`/ui/builder?thread=${th.id}`);
    const row = page.getByRole("list", { name: "Tool calls" }).getByRole("listitem");
    await row.getByRole("button").click();
    await expect(row.getByText(/Withheld by your organisation's data policy/)).toBeVisible();
  });
});

test.describe("ADR-0173: Ask first is a confirmation in the thread", () => {
  test("the card shows the exact call; Approve runs it and the turn continues; the composer waits meanwhile", async ({ page }) => {
    const st = await installBuilderMock(page, { toolMode: "ask_first" });
    await page.goto("/ui/builder");
    await page.getByLabel("Message").fill("Search our policies for vendor risk");
    await page.getByLabel("Message").press("Enter");
    await expect(page).toHaveURL(/\?thread=th-/);
    const card = page.getByRole("group", { name: "Allow policy-docs / search_policies?" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("It will run as you, with exactly these arguments");
    await expect(card.getByText('"query": "vendor risk"')).toBeVisible();
    await expect(page.getByRole("list", { name: "Tool calls" }).getByRole("button")).toContainText("Needs your OK");
    // no new message until it is answered
    await expect(page.getByLabel("Message")).toBeDisabled();
    await expect(page.getByLabel("Message")).toHaveAttribute("placeholder", "Answer the tool request above first");
    await expectAxeClean(page, "ask-first confirmation");

    await card.getByRole("button", { name: "Approve" }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByText("The tool found three policies: Vendor risk, Data retention and AI use.")).toBeVisible();
    await expect(page.getByRole("list", { name: "Tool calls" }).getByRole("button")).toContainText("Done");
    await expect(page.getByLabel("Message")).toBeEnabled();
    const th = st.threads[0]!;
    const confirms = st.calls.filter((c) => c.method === "POST" && /\/steps\/[^/]+\/confirm$/.test(c.path));
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.path).toContain(`/v1/builder/threads/${th.id}/steps/`);
    expect(confirms[0]!.body).toEqual({ decision: "approve" });
  });

  test("Deny records the refusal and the agent carries on without the tool", async ({ page }) => {
    const st = await installBuilderMock(page, { toolMode: "ask_first" });
    await page.goto("/ui/builder");
    await page.getByLabel("Message").fill("Search our policies");
    await page.getByLabel("Message").press("Enter");
    const card = page.getByRole("group", { name: /^Allow / });
    await card.getByRole("button", { name: "Deny" }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByText("Understood — I won't search the policies.")).toBeVisible();
    const head = page.getByRole("list", { name: "Tool calls" }).getByRole("button");
    await expect(head).toContainText("Denied");
    await head.click();
    await expect(page.getByText("the person declined this call")).toBeVisible();
    const bodies = st.calls.filter((c) => /\/confirm$/.test(c.path)).map((c) => c.body);
    expect(bodies).toEqual([{ decision: "deny" }]);
  });
});

test.describe("ADR-0173: an organisation approval waits in the approvals queue", () => {
  test("the thread says who it waits on and offers no approve button; the inbox flags it", async ({ page }) => {
    const st = await installBuilderMock(page, { toolMode: "approval" });
    await page.goto("/ui/builder");
    await page.getByLabel("Message").fill("Update the vendor policy");
    await page.getByLabel("Message").press("Enter");
    await expect(page).toHaveURL(/\?thread=th-/);
    const wait = page.getByRole("status").filter({ hasText: "Waiting for approval by Riley Reviewer" });
    await expect(wait).toBeVisible();
    await expect(wait).toContainText("continues on its own");
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Tool calls" }).getByRole("button")).toContainText("Waiting for approval");
    await expectAxeClean(page, "approval wait");

    await page.goto("/ui/builder/inbox");
    const th = st.threads[0]!;
    const row = page.getByRole("list", { name: "Threads" }).getByRole("button", { name: new RegExp(th.title) });
    await expect(row).toContainText("Awaiting approval");
    await row.click();
    await expect(page.getByRole("status").filter({ hasText: "Waiting for approval by Riley Reviewer" })).toBeVisible();
    await expect(page.getByLabel("Reply")).toBeDisabled();
    expect(sent(st, "POST", `/v1/builder/threads/${th.id}/steps/x/confirm`)).toEqual([]);
  });
});

test.describe("ADR-0173 review: a pause can always be cancelled by the thread's person", () => {
  test("Cancel on an Ask-first card: nothing runs, a note says so, and the composer is free", async ({ page }) => {
    const st = await installBuilderMock(page, { toolMode: "ask_first" });
    await page.goto("/ui/builder");
    await page.getByLabel("Message").fill("Search our policies");
    await page.getByLabel("Message").press("Enter");
    const card = page.getByRole("group", { name: /^Allow / });
    await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(page.getByLabel("Message")).toBeDisabled();
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByText(/Cancelled by you: 'policy-docs \/ search_policies' did not run/)).toBeVisible();
    await expect(page.getByLabel("Message")).toBeEnabled();
    const th = st.threads[0]!;
    const cancels = st.calls.filter((c) => c.method === "POST" && /\/steps\/[^/]+\/cancel$/.test(c.path));
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.path).toContain(`/v1/builder/threads/${th.id}/steps/`);
    // a cancel is not a confirmation: nothing was approved or denied
    expect(st.calls.filter((c) => /\/confirm$/.test(c.path))).toEqual([]);
  });

  test("Cancel on an approval wait: the person stops waiting for an approver who never decides", async ({ page }) => {
    const st = await installBuilderMock(page, { toolMode: "approval" });
    await page.goto("/ui/builder");
    await page.getByLabel("Message").fill("Update the vendor policy");
    await page.getByLabel("Message").press("Enter");
    const wait = page.getByRole("status").filter({ hasText: "Waiting for approval by Riley Reviewer" });
    await expect(wait).toBeVisible();
    await expect(wait.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expectAxeClean(page, "approval wait with cancel");
    await wait.getByRole("button", { name: "Cancel" }).click();
    await expect(wait).toHaveCount(0);
    await expect(page.getByText(/Cancelled by you/)).toBeVisible();
    await expect(page.getByLabel("Message")).toBeEnabled();
    const th = st.threads[0]!;
    expect(st.calls.filter((c) => c.method === "POST" && c.path.startsWith(`/v1/builder/threads/${th.id}/steps/`) && c.path.endsWith("/cancel"))).toHaveLength(1);
  });
});

test.describe("ADR-0173: the toolbox copy", () => {
  test("the editor no longer says tools are only described", async ({ page }) => {
    const st = await installBuilderMock(page);
    const a = st.agents[0]!;
    await page.goto(`/ui/builder/agents/${a.id}`);
    await expect(page.getByText(/calls these tools on its own during a conversation/)).toBeVisible();
    await expect(page.getByText(/comes in a later release/).filter({ hasText: "calling them on its own" })).toHaveCount(0);
  });
});
