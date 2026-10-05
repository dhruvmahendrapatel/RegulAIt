/**
 * ADR-0180 §5 (A8) — the agent autonomy panel on the builder Configure panel,
 * against the mocked Builder API plus a mocked autonomy route:
 *
 *  - the observed class and the plain-language facts behind it;
 *  - the declared class, and the warning when it is lower than observed;
 *  - the floor checks with pass/fail and how to fix each;
 *  - declaring (a note is required) and withdrawing send the exact body;
 *  - a viewer who is not the steward never sees the panel;
 *  - axe (WCAG 2.x A/AA) in light and dark.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean, installBuilderMock } from "./builder-fixtures";

type Json = Record<string, any>;
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const FLOORS = [
  { id: "guardrails_warn", minClass: "supervised", label: "Prompt-injection and jailbreak guardrails at least warn", met: true, detail: "Guardrails: prompt-injection block, jailbreak block.", fix: "Ask an admin…" },
  { id: "guardrails_block", minClass: "delegated", label: "Prompt-injection and jailbreak guardrails block", met: true, detail: "Guardrails: prompt-injection block, jailbreak block.", fix: "Ask an admin…" },
  { id: "model_card_approved", minClass: "delegated", label: "The model has an approved model card", met: false, detail: "No live, approved model card for this agent's model.", fix: "Get the model card for this agent's model signed off (Model risk), or choose a model whose card is approved." },
  { id: "agentic_redteam_measured", minClass: "delegated", label: "Agentic red-team classes measured", met: true, detail: "All three agentic classes measured in the last 30 days.", fix: "Run a red-team test…" },
  { id: "monthly_limit_set", minClass: "autonomous", label: "A monthly spend limit is set", met: false, detail: "No monthly spend limit.", fix: "Set a monthly spend limit under Advanced." },
];

function view(agentId: string, declared: Json | null): Json {
  const observed = "autonomous";
  const below = !!declared && ["assist", "supervised", "delegated"].includes(declared.class);
  return {
    agentId,
    observed: {
      class: observed,
      reasons: [
        { ruleId: "enabled_schedule", class: "autonomous", basis: "setup", text: "It has 1 enabled schedule, so it starts work on its own timer." },
        { ruleId: "write_tool_without_ask_first", class: "delegated", basis: "setup", text: "1 tool that can change data does not ask a person first." },
      ],
      facts: { schedules: 1, writeToolsWithoutAskFirst: 1 },
      windowDays: 30,
    },
    declared,
    effective: observed,
    declaredBelowObserved: below,
    floors: FLOORS,
    useCases: [{ id: "uc-1", name: "Intake triage", status: "approved" }],
    scope: "Agents linked by project: a builder agent counts toward a use case when it bills to the use case's project.",
  };
}

async function mockAutonomy(page: Page, initial: Json | null) {
  const puts: unknown[] = [];
  let declared = initial;
  await page.route("**/v1/builder/agents/*/autonomy", async (route) => {
    const req = route.request();
    const agentId = new URL(req.url()).pathname.split("/")[4]!;
    if (req.method() === "PUT") {
      const body = req.postDataJSON() as { class: string | null; note?: string };
      puts.push(body);
      declared = body.class ? { class: body.class, note: body.note ?? null, declaredBy: { id: "me", name: "Avery Admin" }, declaredAt: new Date().toISOString() } : null;
      const v = view(agentId, declared);
      return json(route, { autonomy: v, ...(v.declaredBelowObserved ? { flag: { code: "declared_below_observed", detail: "x" } } : {}) });
    }
    return json(route, { autonomy: view(agentId, declared) });
  });
  return puts;
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Configure agent" });
/** the builder mock first, then the autonomy route (the LAST registered route wins in Playwright) */
async function openAutonomy(page: Page, initial: Json | null, name = "Intake reviewer") {
  const st = await installBuilderMock(page);
  const puts = await mockAutonomy(page, initial);
  const id = st.agents.find((a) => a.name === name)!.id;
  await page.goto(`/ui/builder/agents/${id}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return puts;
}

test.describe("ADR-0180 A8: agent autonomy class", () => {
  test("shows observed facts, the below-observed warning and the floors; axe in both themes", async ({ page }) => {
    await openAutonomy(page, { class: "supervised", note: "only drafts reports", declaredBy: { id: "me", name: "Avery Admin" }, declaredAt: new Date().toISOString() });
    await panel(page).getByRole("button", { name: /^Autonomy/ }).click();
    const region = panel(page).getByRole("region", { name: "Autonomy" });
    await expect(region.getByText("Observed class", { exact: true })).toBeVisible();
    await expect(region.getByText("It has 1 enabled schedule, so it starts work on its own timer.")).toBeVisible();
    await expect(region.getByText("1 tool that can change data does not ask a person first.")).toBeVisible();
    const warning = region.getByRole("status").filter({ hasText: "Declared lower than what it does" });
    await expect(warning).toContainText("You declared Supervised, but the agent is set up or seen acting as Autonomous.");
    await expect(region).toContainText("“only drafts reports”");

    const controls = region.getByRole("list", { name: "Autonomy controls" }).getByRole("listitem");
    await expect(controls).toHaveCount(5);
    await expect(region).toContainText("2 of 5 not in place.");
    const card = controls.filter({ hasText: "The model has an approved model card" });
    await expect(card.getByText("Missing")).toBeVisible();
    await expect(card).toContainText("How to fix: Get the model card for this agent's model signed off");
    await expect(controls.filter({ hasText: "guardrails block" }).getByText("In place")).toBeVisible();
    await expect(region).toContainText("Counts toward: Intake triage.");
    await expect(region).toContainText("Agents linked by project");
    await expectAxeClean(page, "autonomy panel with a below-observed declaration");
  });

  test("declares with a note (required), clears the warning, then withdraws", async ({ page }) => {
    const puts = await openAutonomy(page, null);
    await panel(page).getByRole("button", { name: /^Autonomy/ }).click();
    const region = panel(page).getByRole("region", { name: "Autonomy" });
    await expect(region).toContainText("Not declared, so the observed class applies.");

    await region.getByLabel("Declare a class").selectOption("supervised");
    await region.getByRole("button", { name: "Save declaration" }).click();
    await expect(region.getByText("Say why you declare this class.")).toBeVisible();
    expect(puts).toEqual([]);

    await region.getByLabel("Why this class").fill("reviewed with the team");
    await region.getByRole("button", { name: "Save declaration" }).click();
    await expect(region.getByRole("status").filter({ hasText: "Declared lower than what it does" })).toBeVisible();

    await region.getByLabel("Declare a class").selectOption("autonomous");
    await region.getByLabel("Why this class").fill("it runs on a timer");
    await region.getByRole("button", { name: "Save declaration" }).click();
    await expect(region.getByRole("status").filter({ hasText: "Declared lower than what it does" })).toHaveCount(0);

    await region.getByLabel("Declare a class").selectOption("");
    await region.getByRole("button", { name: "Save declaration" }).click();
    await expect(region).toContainText("Not declared, so the observed class applies.");
    expect(puts).toEqual([
      { class: "supervised", note: "reviewed with the team" },
      { class: "autonomous", note: "it runs on a timer" },
      { class: null },
    ]);
    await expectAxeClean(page, "autonomy panel after declaring");
  });

  test("a viewer who is not the agent's steward never sees the panel", async ({ page }) => {
    const puts = await openAutonomy(page, null, "Policy Q&A");
    await expect(panel(page)).toContainText("View only");
    await expect(panel(page).getByRole("button", { name: /^Autonomy/ })).toHaveCount(0);
    expect(puts).toEqual([]);
  });
});
