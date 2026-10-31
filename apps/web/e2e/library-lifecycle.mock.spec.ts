/** ADR-0208 G9 — libraries on the real contracts (mocked): retire eval dataset (with refusal), retire red-team version, edit/delete engine schedule, cancel campaign. */
import { expect, test, type Page } from "@playwright/test";
import { ENGINE_AGENT, installEnginesMock } from "./engines-fixtures";
import { AVERY, ISO, ME, MORGAN, json, mockApi } from "./proto-fixtures";

const AGENTS = { agents: [{ id: ENGINE_AGENT, name: "Credit-limit-increase assistant", provider: "mock", tier: 1, model: "m1", enabled: true }] };

const DATASETS = [
  { id: "d1", name: "support-golden", version: 3, note: null, scorerKind: "contains", scorerConfig: {}, caseCount: 42, runCount: 18, frozen: true, createdAt: ISO, retiredAt: null, retiredReason: null, builtin: null, builtIn: false, status: "active" },
  { id: "d2", name: "builtin:safety-baseline", version: 1, note: null, scorerKind: "contains", scorerConfig: {}, caseCount: 120, runCount: 6, frozen: true, createdAt: ISO, retiredAt: null, retiredReason: null, builtin: { key: "safety", sensitivity: "offensive", current: true, measures: null }, builtIn: true, status: "active" },
  { id: "d3", name: "billing-faq", version: 2, note: null, scorerKind: "exact", scorerConfig: {}, caseCount: 15, runCount: 4, frozen: true, createdAt: ISO, retiredAt: ISO, retiredReason: "Folded into support-golden", builtin: null, builtIn: false, status: "retired" },
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
  const sent: unknown[] = [];
  await mockApi(page, (p, m, b, route) => {
    if (p === "/v1/evals/datasets/d1/retire" && m === "POST") {
      sent.push(b);
      return refuse
        ? json(
            route,
            {
              error: "eval_dataset_in_use",
              detail: "'support-golden' is still used by 1 workflow template quality gate(s) and 1 automation rule(s); remove it from those first",
              dataset: "support-golden",
              templates: ["Model change review"],
              automationRules: 1,
            },
            409,
          )
        : json(route, { retired: true, dataset: "support-golden", versions: 3, retiredAt: ISO });
    }
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
  expect(sent[0]).toEqual({ reason: "Superseded by support-golden-2026" });
  // the dialog stayed open with the typed reason: once the uses are removed, the retire goes through
  refuse = false;
  await dialog.getByRole("button", { name: "Retire dataset" }).click();
  await expect(dialog).toBeHidden();
  // shipped and retired datasets offer no retire button
  await expect(page.getByRole("button", { name: "Retire dataset builtin:safety-baseline" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retire dataset billing-faq" })).toHaveCount(0);
});

test("g9 red-team retire version", async ({ page }) => {
  const lib = {
    id: "l1", name: "Support jailbreak set", version: 2, note: null, status: "published", evalDatasetId: "d9", evalDatasetVersion: 1, probeCount: 24, frozen: true, createdAt: ISO,
    retiredAt: null, retiredReason: null, retiredByUserId: null,
  };
  let retireBody: unknown = null;
  await mockApi(page, (p, m, b, route) => {
    if (p === "/v1/redteam/libraries/l1/retire" && m === "POST") {
      retireBody = b;
      return json(route, { retired: true, library: { ...lib, status: "retired", retiredAt: ISO, retiredReason: "v3 replaces it once published", retiredByUserId: ME } });
    }
    if (p === "/v1/redteam/attack-classes")
      return json(route, { attackClasses: [], disclosure: "A green run means no probe in this library version succeeded.", scheduling: { schedulerEnabled: true, posture: "weekly sweep", note: "" } });
    if (p === "/v1/redteam/libraries")
      return json(route, {
        libraries: [
          lib,
          { ...lib, id: "l2", version: 3, status: "draft", frozen: false, probeCount: 26 },
          { ...lib, id: "l0", version: 1, status: "retired", probeCount: 20, retiredAt: ISO, retiredReason: "replaced by v2" },
        ],
        note: "",
      });
    if (p === "/v1/redteam/libraries/l1") return json(route, { library: lib, probes: [], versions: [{ id: "l1", version: 2, status: "published" }], frozen: true, coverage: [], disclosure: "" });
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
  await dialog.getByRole("button", { name: "Retire version" }).click();
  await expect(dialog).toBeHidden();
  expect(retireBody).toEqual({ reason: "v3 replaces it once published" });
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
    intervalHours: hours, nextRunAt: "2026-10-30T02:00:00.000Z", enabled, lastRunId: null, lastSkip: null, createdAt: ISO, updatedAt: ISO,
    deletedAt: null, deletedByUserId: null,
  });
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  await page.route(/\/v1\/engine-schedules(\/|\?|$)/, (route) => {
    const req = route.request();
    if (req.method() === "GET") return json(route, { schedules: [sched("s1", 24, true, ME), sched("s2", 168, false, AVERY), sched("s3", 6, true, MORGAN)] });
    calls.push({ method: req.method(), url: new URL(req.url()).pathname, body: req.postData() ? (JSON.parse(req.postData()!) as unknown) : null });
    if (req.method() === "PATCH") return json(route, { schedule: { ...sched("s1", 48, true, ME), nextRunAt: "2026-10-31T02:00:00.000Z" } });
    if (req.method() === "DELETE") return json(route, { deleted: true, schedule: { ...sched("s1", 24, false, ME), deletedAt: ISO, deletedByUserId: ME } });
    return json(route, { error: "unexpected" }, 500);
  });
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
  // only the person a schedule runs as edits it; an admin may still delete any
  await expect(page.getByRole("button", { name: "Edit schedule every 168 h" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete schedule every 168 h" })).toBeVisible();
  await page.getByRole("button", { name: "Edit schedule every 24 h" }).click();
  const edit = page.getByRole("dialog", { name: "Edit recurring run" });
  await expect(edit).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("g9-schedule-edit.png") });
  await edit.getByLabel("Every (hours)").fill("721");
  await edit.getByRole("button", { name: "Save schedule" }).click();
  await expect(edit.getByRole("alert")).toContainText("from 1 to 720");
  await edit.getByLabel("Every (hours)").fill("48");
  await edit.getByRole("button", { name: "Save schedule" }).click();
  await expect(edit).toBeHidden();
  expect(calls).toContainEqual({ method: "PATCH", url: "/v1/engine-schedules/s1", body: { intervalHours: 48 } });
  await page.getByRole("button", { name: "Delete schedule every 24 h" }).click();
  await page.getByRole("dialog", { name: /Delete the schedule/ }).getByRole("button", { name: "Delete schedule" }).click();
  await expect.poll(() => calls.some((c) => c.method === "DELETE" && c.url === "/v1/engine-schedules/s1")).toBe(true);
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
    id, name, scope: { kind: "all", value: null }, openedBy: { userId: ME, name: "Ada Admin" }, dueAt: "2026-11-15T00:00:00.000Z", status,
    storedStatus: status === "expired-incomplete" ? "open" : status, completedAt: status === "completed" ? ISO : null, createdAt: ISO,
    cancellation: status === "cancelled" ? { at: ISO, reason: "Scope was wrong; reopened", byUserId: ME } : null,
    items: { total: keep + revoke + undecided, keep, revoke, undecided },
  });
  let cancelBody: unknown = null;
  const listedStatuses: Array<string | null> = [];
  await mockApi(page, (p, m, b, route) => {
    if (p === "/v1/certification-campaigns/c1/cancel" && m === "POST") {
      cancelBody = b;
      return json(route, {
        cancelled: true, id: "c1", status: "cancelled", cancellation: { at: ISO, reason: "Scope was wrong; reopening with contractor grants only", byUserId: ME },
        items: 12, decided: 5, kept: 4, revoked: 1, undecided: 7, withdrawn: 7,
      });
    }
    if (p === "/v1/certification-campaigns") {
      const all = [
        row("c1", "Q4 grant re-attestation", "open", 4, 1, 7),
        row("c2", "Q3 grant re-attestation", "completed", 10, 2, 0),
        row("c3", "Q2 grant re-attestation", "expired-incomplete", 6, 0, 3),
        row("c4", "Contractor access sweep", "cancelled", 2, 1, 0),
      ];
      // the list control asks the server for one status; the counts on the buttons come back as `summary`
      const status = new URL(route.request().url()).searchParams.get("status");
      listedStatuses.push(status);
      const items = status ? all.filter((c) => c.status === status) : all;
      const statusCounts = { open: 0, completed: 0, "expired-incomplete": 0, cancelled: 0 } as Record<string, number>;
      for (const c of all) statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
      return json(route, { items, total: items.length, totalIsEstimate: false, nextCursor: null, nextOffset: null, summary: { statusCounts }, notes: { scope: "" } });
    }
    if (p === "/v1/certification-campaigns/c1")
      return json(route, {
        id: "c1", name: "Q4 grant re-attestation", scope: { kind: "all", value: null }, openedBy: { userId: ME, name: "Ada Admin" }, dueAt: "2026-11-15T00:00:00.000Z",
        status: "open", storedStatus: "open", completedAt: null, cancellation: null, createdAt: ISO, notes: { scope: "", snapshot: "", expiry: "" }, items: items(12, 5),
      });
    return undefined;
  });
  await page.goto("/ui/admin/certification");
  await expect(page.getByText("Q4 grant re-attestation")).toBeVisible({ timeout: 30_000 });
  // ADR-0208 G9: the status buttons count every campaign, and the list shows the chosen status (open first)
  const filters = page.getByRole("group", { name: "Filter by status" });
  for (const name of ["Open 1", "Completed 1", "Expired 1", "Cancelled 1"]) await expect(filters.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(filters.getByRole("button", { name: "Open 1", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(listedStatuses).toContain("open");
  await expect(page.getByText("Q3 grant re-attestation")).toHaveCount(0);
  await expect(page.getByText("Contractor access sweep")).toHaveCount(0);
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
  // the dismiss button says what is kept: the campaign
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Keep campaign" }).click();
  await expect(dialog).toBeHidden();
  expect(cancelBody).toBeNull();
  await page.getByRole("button", { name: "Cancel campaign" }).click();
  const again = page.getByRole("dialog", { name: /Cancel campaign/ });
  await again.getByLabel("Reason").fill("Scope was wrong; reopening with contractor grants only");
  await again.getByRole("button", { name: "Cancel campaign" }).click();
  await expect(again).toBeHidden();
  expect(cancelBody).toEqual({ reason: "Scope was wrong; reopening with contractor grants only" });
  await page.getByRole("button", { name: /^Cancelled/ }).click();
  await expect(filters.getByRole("button", { name: "Cancelled 1", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Contractor access sweep")).toBeVisible();
  expect(listedStatuses).toContain("cancelled");
  await expect(page.getByText("Q3 grant re-attestation")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("g9-campaigns-cancelled.png") });
});
