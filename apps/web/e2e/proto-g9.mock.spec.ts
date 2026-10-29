/** PROTOTYPE (#453 G9) — libraries: retire eval dataset (with refusal), retire red-team version, edit/delete engine schedule, cancel campaign. */
import { expect, test, type Page } from "@playwright/test";
import { ENGINE_AGENT, installEnginesMock } from "./engines-fixtures";
import { AVERY, ISO, ME, MORGAN, json, mockApi } from "./proto-fixtures";

const AGENTS = { agents: [{ id: ENGINE_AGENT, name: "Credit-limit-increase assistant", provider: "mock", tier: 1, model: "m1", enabled: true }] };

const DATASETS = [
  { id: "d1", name: "support-golden", version: 3, note: null, scorerKind: "contains", scorerConfig: {}, caseCount: 42, runCount: 18, frozen: true, createdAt: ISO, status: "active" },
  { id: "d2", name: "Shipped safety baseline", version: 1, note: null, scorerKind: "contains", scorerConfig: {}, caseCount: 120, runCount: 6, frozen: true, createdAt: ISO, builtIn: true, status: "active" },
  { id: "d3", name: "billing-faq", version: 2, note: null, scorerKind: "exact", scorerConfig: {}, caseCount: 15, runCount: 4, frozen: true, createdAt: ISO, status: "retired" },
];

const shell = (p: string, route: Parameters<typeof json>[0]) => {
  if (p === "/v1/agents") return json(route, AGENTS);
  if (p === "/v1/evals/datasets") return json(route, { datasets: DATASETS, note: "A dataset version is frozen once a run has scored against it." });
  if (p === "/v1/evals/scorers") return json(route, { scorers: [{ id: "contains" }], note: "" });
  if (p === "/v1/evals/runs") return json(route, { runs: [] });
  if (p === "/v1/evals/scoring-semantics") return json(route, { current: 2, versions: [], evalRuns: [], stalePinnedBaselines: [], note: "" });
  return undefined;
};

test("g9 eval dataset retire: refused, then confirm", async ({ page }) => {
  let refuse = true;
  await mockApi(page, (p, _m, _b, route) => {
    if (p === "/v1/evals/datasets/d1/retire")
      return refuse ? json(route, { error: "eval_dataset_in_use", templates: ["Model change review"], automationRules: 1 }, 409) : json(route, { retired: true });
    return shell(p, route);
  });
  await page.goto("/ui/admin/evals");
  const btn = page.getByRole("button", { name: "Retire dataset support-golden" });
  await expect(btn).toBeVisible({ timeout: 30_000 });
  await page.getByText("Golden datasets", { exact: true }).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.mouse.wheel(0, -120);
  await btn.click();
  const dialog = page.getByRole("dialog", { name: /Retire dataset “support-golden”/ });
  await expect(dialog).toContainText("No new runs or quality gates can use ‘support-golden’. Past runs and every version stay readable.");
  await dialog.getByLabel("Reason").fill("Superseded by support-golden-2026");
  await page.screenshot({ path: test.info().outputPath("g9-evals-retire-confirm.png") });
  await dialog.getByRole("button", { name: "Retire dataset" }).click();
  await expect(page.getByTestId("reasoned-refusal")).toContainText("Model change review");
  await expect(page.getByTestId("reasoned-refusal")).toContainText("1 automation rule");
  await page.screenshot({ path: test.info().outputPath("g9-evals-retire-refused.png") });
  refuse = false;
});

test("g9 red-team retire version", async ({ page }) => {
  const lib = { id: "l1", name: "Support jailbreak set", version: 2, note: null, status: "published", evalDatasetId: "d9", probeCount: 24, frozen: true, createdAt: ISO };
  await mockApi(page, (p, _m, _b, route) => {
    if (p === "/v1/redteam/attack-classes")
      return json(route, { attackClasses: [], disclosure: "A green run means no probe in this library version succeeded.", scheduling: { schedulerEnabled: true, posture: "weekly sweep", note: "" } });
    if (p === "/v1/redteam/libraries")
      return json(route, {
        libraries: [
          lib,
          { ...lib, id: "l2", version: 3, status: "draft", frozen: false, probeCount: 26 },
          { ...lib, id: "l0", version: 1, status: "retired", probeCount: 20 },
        ],
        note: "",
      });
    if (p === "/v1/redteam/libraries/l1") return json(route, { library: lib, probes: [], frozen: true, disclosure: "" });
    if (p === "/v1/redteam/runs") return json(route, { runs: [] });
    return shell(p, route);
  });
  await page.goto("/ui/admin/redteam");
  await expect(page.getByRole("link", { name: /^Support jailbreak set v2/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: /^Support jailbreak set v2/ }).click();
  const retire = page.getByRole("button", { name: "Retire version" });
  await expect(retire).toBeVisible();
  await page.getByText("Attack libraries").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.mouse.wheel(0, -120);
  await page.screenshot({ path: test.info().outputPath("g9-redteam-list.png") });
  await retire.click();
  const dialog = page.getByRole("dialog", { name: /Retire Support jailbreak set v2/ });
  await expect(dialog).toContainText("Scheduled sweeps stop probing agents with this version.");
  await dialog.getByLabel("Reason").fill("v3 replaces it once published");
  await page.screenshot({ path: test.info().outputPath("g9-redteam-retire.png") });
});

test("g9 engine schedules edit and delete", async ({ page }) => {
  await mockApi(page, (p, _m, _b, route) => {
    if (p === "/v1/redteam/attack-classes") return json(route, { attackClasses: [], disclosure: "", scheduling: { schedulerEnabled: false, posture: "off", note: "" } });
    if (p === "/v1/redteam/libraries") return json(route, { libraries: [], note: "" });
    if (p === "/v1/redteam/runs") return json(route, { runs: [] });
    return shell(p, route);
  });
  await installEnginesMock(page);
  const sched = (id: string, hours: number, enabled: boolean, by: string) => ({
    id, engineId: "promptfoo", request: { target: { agentId: ENGINE_AGENT }, config: { sets: ["basic"] } }, configHash: "h", runAsUserId: by,
    intervalHours: hours, nextRunAt: "2026-10-30T02:00:00.000Z", enabled, lastRunId: null, lastSkip: enabled ? null : null, createdAt: ISO, updatedAt: ISO,
  });
  await page.route(/\/v1\/engine-schedules(\/|\?|$)/, (route) =>
    route.request().method() === "GET"
      ? json(route, { schedules: [sched("s1", 24, true, ME), sched("s2", 168, false, AVERY), sched("s3", 6, true, MORGAN)] })
      : json(route, { ok: true }),
  );
  await page.goto("/ui/admin/redteam");
  const card = page.getByText("Recurring runs", { exact: true });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(150);
  await page.screenshot({ path: test.info().outputPath("g9-schedules.png") });
  await page.getByRole("button", { name: "Delete schedule every 24 h" }).click();
  const dialog = page.getByRole("dialog", { name: /Delete the schedule/ });
  await expect(dialog).toContainText("No further runs start from this schedule. A run already in progress keeps going; cancel it from Runs.");
  await page.screenshot({ path: test.info().outputPath("g9-schedule-delete.png") });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Edit schedule every 24 h" }).click();
  await expect(page.getByRole("dialog", { name: "Edit recurring run" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("g9-schedule-edit.png") });
});

test("g9 campaign cancel", async ({ page }) => {
  const items = (n: number, decided: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `i${i}`, grantKind: "agent_grant", grantId: `g${i}`,
      holder: { userId: null, roleId: null, label: ["Dana Developer", "Jordan Owner", "team-17"][i % 3] },
      object: { id: null, label: "Credit-limit-increase assistant", toolName: null },
      reviewer: { userId: AVERY, name: i % 2 ? "Morgan Reyes" : "Avery Approver" }, approvalId: `a${i}`,
      decision: i < decided ? (i === 0 ? "revoke" : "keep") : null, decidedBy: i < decided ? { userId: AVERY, name: "Avery Approver" } : null,
      decidedAt: i < decided ? ISO : null, revocation: i === 0 ? { mechanism: "grant_row_delete", removed: true } : null,
    }));
  const row = (id: string, name: string, status: string, keep: number, revoke: number, undecided: number) => ({
    id, name, scope: { kind: "all", value: null }, openedBy: { userId: ME, name: "Ada Admin" }, dueAt: "2026-11-15T00:00:00.000Z", status, createdAt: ISO,
    items: { total: keep + revoke + undecided, keep, revoke, undecided },
  });
  await mockApi(page, (p, _m, _b, route) => {
    if (p === "/v1/certification-campaigns")
      return json(route, {
        campaigns: [
          row("c1", "Q4 grant re-attestation", "open", 4, 1, 7),
          row("c2", "Q3 grant re-attestation", "completed", 10, 2, 0),
          row("c3", "Q2 grant re-attestation", "expired-incomplete", 6, 0, 3),
          row("c4", "Contractor access sweep", "cancelled", 2, 1, 0),
        ],
        notes: { scope: "" },
      });
    if (p === "/v1/certification-campaigns/c1")
      return json(route, { id: "c1", name: "Q4 grant re-attestation", scope: { kind: "all", value: null }, dueAt: "2026-11-15T00:00:00.000Z", status: "open", completedAt: null, notes: { scope: "", snapshot: "", expiry: "" }, items: items(12, 5) });
    return undefined;
  });
  await page.goto("/ui/admin/certification");
  await expect(page.getByText("Q4 grant re-attestation")).toBeVisible({ timeout: 30_000 });
  await page.getByText("Q4 grant re-attestation").click();
  await expect(page.getByRole("button", { name: "Cancel campaign" })).toBeVisible();
  await page.getByText("Campaigns", { exact: true }).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.mouse.wheel(0, -120);
  await page.screenshot({ path: test.info().outputPath("g9-campaigns.png") });
  await page.getByRole("button", { name: "Cancel campaign" }).click();
  const dialog = page.getByRole("dialog", { name: /Cancel campaign/ });
  await expect(dialog).toContainText("The 7 undecided reviews are withdrawn from reviewers’ queues");
  await expect(dialog).toContainText("The 5 decisions already made, including revocations, stand.");
  await dialog.getByLabel("Reason").fill("Scope was wrong; reopening with contractor grants only");
  await page.screenshot({ path: test.info().outputPath("g9-campaign-cancel.png") });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: /^Cancelled/ }).click();
  await page.screenshot({ path: test.info().outputPath("g9-campaigns-cancelled.png") });
});
