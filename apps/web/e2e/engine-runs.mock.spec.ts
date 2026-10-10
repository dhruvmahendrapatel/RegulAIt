/**
 * ADR-0187 (batch 5, X27) — engine runs on the Red-teaming and Evaluations
 * pages against the §4.10 mock fixtures (engines-fixtures.ts): the run form
 * (a basic set is queued; an agentic set without an approver is refused with
 * the server's reason, and with one it waits for approval — the page never
 * bypasses it), the run list in every status, run detail with the live
 * heartbeat and cancel, the not-run list with reasons, the provenance chip,
 * and two invariants: no `not_run`/`unknown` reads as pass, and no raw text
 * field reaches the page. Axe in light and dark.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { ENGINE_AGENT, ENGINE_JUDGE, ENGINE_PROJECT, RUNS, enginesList, installEnginesMock, itemsOf } from "./engines-fixtures";
import { expectAxeClean } from "./prompts-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ME = "11111111-1111-4111-8111-111111111111";
const APPROVER = "11111111-1111-4111-8111-111111111112";

/** everything the two pages read besides the engine routes */
async function mockShell(page: Page) {
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me")
      return json(route, { userId: ME, isAdmin: true, via: "session", user: { id: ME, email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: ME, isAdmin: true, user: { id: ME, email: "ada@example.test", displayName: "Ada Admin" } });
    if (p === "/v1/agents")
      return json(route, {
        agents: [
          { id: ENGINE_AGENT, name: "support-bot", provider: "mock", tier: 1, model: "m1", enabled: true },
          { id: ENGINE_JUDGE, name: "grader", provider: "mock", tier: 1, model: "m1", enabled: true },
        ],
      });
    if (p === "/v1/projects") return json(route, { projects: [{ id: ENGINE_PROJECT, name: "Support assistant", costCenter: null, budgetUsd: null, spentUsd: 0 }] });
    if (p === "/v1/users")
      return json(route, {
        users: [
          { id: ME, email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null, createdAt: "2026-01-01T00:00:00Z", totpEnabled: true, hasPassword: true },
          { id: APPROVER, email: "avery@example.test", displayName: "Avery Approver", isAdmin: true, disabledAt: null, createdAt: "2026-01-01T00:00:00Z", totpEnabled: true, hasPassword: true },
        ],
      });
    if (p === "/v1/redteam/attack-classes") return json(route, { attackClasses: [], disclosure: "A green run means no probe in this library version succeeded.", scheduling: { schedulerEnabled: false, posture: "off", note: "" } });
    if (p === "/v1/redteam/libraries") return json(route, { libraries: [], note: "" });
    if (p === "/v1/redteam/runs") return json(route, { runs: [] });
    if (p === "/v1/evals/runs") return json(route, { runs: [] });
    if (p === "/v1/evals/datasets") return json(route, { datasets: [], note: "" });
    if (p === "/v1/evals/scorers") return json(route, { scorers: [], note: "" });
    if (p === "/v1/evals/scoring-semantics") return json(route, { current: 2, versions: [], evalRuns: [], stalePinnedBaselines: [], note: "" });
    return json(route, {});
  });
}

async function open(page: Page, where: "redteam" | "evals", init?: Parameters<typeof installEnginesMock>[1]) {
  await mockShell(page);
  const state = await installEnginesMock(page, init);
  await page.goto(`/ui/admin/${where}`);
  // the first page load of a cold dev server compiles the admin views: allow it
  if (where === "evals") {
    await expect(page.getByRole("tab", { name: "Engine runs" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: "Engine runs" }).click();
  }
  await expect(page.getByText("Run an engine", { exact: true })).toBeVisible({ timeout: 30_000 });
  return state;
}

const runRow = (page: Page, id: string) => page.getByRole("link", { name: new RegExp(`^Engine run \\w+, .*, id ${id}$`) });
const form = (page: Page) => page.getByTestId("engine-run-form");

async function fillForm(page: Page, sets: string) {
  const f = form(page);
  await f.getByLabel("Engine", { exact: true }).selectOption("promptfoo");
  await f.getByLabel("Agent under test", { exact: true }).selectOption(ENGINE_AGENT);
  await f.getByLabel("Judge agent", { exact: true }).selectOption(ENGINE_JUDGE);
  await f.getByLabel("Bill to project", { exact: true }).selectOption(ENGINE_PROJECT);
  await f.getByLabel("Sets", { exact: true }).fill(sets);
}

test.describe("Engine runs — Red-teaming and Evaluations (ADR-0187 X27)", () => {
  test("a basic run is queued with the §4.10 body; only enabled engines are offered", async ({ page }) => {
    const state = await open(page, "redteam");
    const engineSelect = form(page).getByLabel("Engine", { exact: true });
    await expect(engineSelect.locator("option")).toHaveText(["Select an engine", "promptfoo 0.123.1"]);
    await expect(page.getByTestId("engines-off")).toContainText("garak 0.17.0");
    await expect(page.getByTestId("engines-off")).not.toContainText("modelscan");
    await expect(page.getByRole("button", { name: "Start engine run" })).toBeDisabled();
    await fillForm(page, "basic");
    await expectAxeClean(page, "engine run form");
    await page.getByRole("button", { name: "Start engine run" }).click();
    await expect(page.getByTestId("engine-run-started")).toContainText("Queued for a runner");
    const post = state.calls.find((c) => c.method === "POST" && c.path === "/v1/engine-runs");
    expect(post?.body).toEqual({ engineId: "promptfoo", target: { agentId: ENGINE_AGENT, judgeAgentId: ENGINE_JUDGE }, config: { sets: ["basic"], params: {} }, projectId: ENGINE_PROJECT, trials: 3 });
    await expect(page.getByTestId("engine-run-detail")).toBeVisible();
  });

  test("an agentic set is refused without an approver, and with one it waits for approval — never bypassed", async ({ page }) => {
    const state = await open(page, "redteam");
    await fillForm(page, "agentic");
    await page.getByRole("button", { name: "Start engine run" }).click();
    const refusal = page.getByTestId("engine-run-refusal");
    await expect(refusal).toContainText("engine_approver_required");
    await expect(refusal).toContainText("waits for approval");
    await expectAxeClean(page, "engine run refused for an approver");
    await form(page).getByLabel("Approver (if approval is needed)", { exact: true }).selectOption(APPROVER);
    await page.getByRole("button", { name: "Start engine run" }).click();
    const started = page.getByTestId("engine-run-started");
    await expect(started).toContainText("awaiting approval");
    await expect(started.getByRole("link", { name: "Approvals Queue" })).toHaveAttribute("href", "/ui/admin/approvals");
    const detail = page.getByTestId("engine-run-detail");
    await expect(detail.getByTestId("engine-run-awaiting-approval")).toContainText("does not start until an approver decides");
    await expect(detail.getByTestId("engine-run-status")).toHaveText("awaiting approval");
    // the page sent one request per click and nothing that approves
    const posts = state.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path)).toEqual(["/v1/engine-runs", "/v1/engine-runs"]);
    expect(posts[1]!.body.approverUserId).toBe(APPROVER);
    await expectAxeClean(page, "engine run awaiting approval");
  });

  test("the run list shows every status, and nothing but a completed pass reads as pass", async ({ page }) => {
    await open(page, "redteam");
    for (const r of Object.values(RUNS)) await expect(runRow(page, r.id)).toBeVisible();
    const passCells = page.getByTestId("engine-verdict").filter({ hasText: /^pass$/ });
    await expect(passCells).toHaveCount(1);
    await expect(runRow(page, RUNS.completedPass.id).getByTestId("engine-verdict")).toHaveText("pass");
    await expect(runRow(page, RUNS.failedUnknown.id).getByTestId("engine-verdict")).toHaveText("unknown (not a pass)");
    await expect(runRow(page, RUNS.timeout.id).getByTestId("engine-verdict")).toHaveText("unknown (not a pass)");
    await expect(runRow(page, RUNS.cancelled.id).getByTestId("engine-verdict")).toHaveText("unknown (not a pass)");
    await expect(runRow(page, RUNS.notRun.id).getByTestId("engine-verdict")).toHaveText("not run (not a pass)");
    await expect(runRow(page, RUNS.queued.id)).toContainText("no result yet");
    await expect(runRow(page, RUNS.leased.id).getByTestId("engine-run-status")).toHaveText("running");
    await expectAxeClean(page, "engine run list");
  });

  test("run detail: provenance chip, items, the not-run list with reasons, and the ledger links", async ({ page }) => {
    await open(page, "redteam");
    await runRow(page, RUNS.completedFail.id).click();
    const detail = page.getByTestId("engine-run-detail");
    const chip = detail.getByTestId("engine-provenance");
    await expect(chip).toContainText("engine: promptfoo 0.123.1");
    // the run records no runner it still knows, so no digest is claimed for it
    await expect(chip).toContainText("image digest not recorded on this run");
    // B5W-03: the current image's signature state is not this run's
    await expect(chip.getByTestId("engine-run-signature")).toHaveText("signature not recorded for this run");
    await expect(chip.getByTestId("engine-current-build")).toContainText("current engine build, not this run's: 0.123.1, signature unverified");
    await expect(detail.getByTestId("engine-run-counts")).toContainText("1 pass · 1 fail · 0 unknown · 2 not run");
    await expect(detail).toContainText("1 of 3 attempts defeated the target");
    await expect(detail).toContainText("Attack success rate 16.7%");
    const notRun = detail.getByTestId("engine-not-run-list");
    await expect(notRun).toContainText("Not run (2)");
    await expect(notRun.getByRole("row", { name: /pi-egress/ })).toContainText("egress_denied");
    await expect(notRun.getByRole("row", { name: /pi-egress/ })).toContainText("the sandbox denied it");
    await expect(notRun.getByRole("row", { name: /cloud-thing/ })).toContainText("cloud_only");
    await expect(detail).toContainText("unmapped");
    await expect(detail).toContainText("stored encrypted, not shown here");
    await expectAxeClean(page, "engine run detail");
  });

  test("a leased run shows its heartbeat and progress, and cancel posts the reason and ends it", async ({ page }) => {
    const state = await open(page, "redteam");
    await runRow(page, RUNS.leased.id).click();
    const detail = page.getByTestId("engine-run-detail");
    const chip = detail.getByTestId("engine-provenance");
    // the runner that leased it is registered: its reported digest is the run's provenance
    await expect(chip).toContainText("sha256:aaaaaaaaaaaa… (runner-reported)");
    await expect(detail.getByTestId("engine-heartbeat")).toContainText(/last heartbeat \d+s ago/);
    await expect(detail).toContainText("Phase: running");
    await expect(detail.getByRole("meter", { name: "engine run progress" })).toBeVisible();
    await expectAxeClean(page, "leased engine run");
    await detail.getByRole("button", { name: "Cancel run" }).click();
    const dialog = page.getByRole("dialog", { name: "Cancel this engine run?" });
    await expect(dialog).toContainText("its run-scoped key is revoked");
    await dialog.getByLabel("Reason (optional, audited)").fill("wrong target");
    await dialog.getByRole("button", { name: "Cancel the run" }).click();
    await expect(detail.getByTestId("engine-run-status")).toHaveText("cancelled");
    const cancel = state.calls.find((c) => c.method === "POST" && c.path === `/v1/engine-runs/${RUNS.leased.id}/cancel`);
    expect(cancel?.body).toEqual({ reason: "wrong target" });
    await expect(detail.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
  });

  test("Evaluations: the Engine runs tab shows failed, timed-out and not-run runs as not a pass", async ({ page }) => {
    await open(page, "evals");
    await runRow(page, RUNS.failedUnknown.id).click();
    let detail = page.getByTestId("engine-run-detail");
    await expect(detail.getByTestId("engine-run-status")).toHaveText("failed");
    await expect(detail.getByTestId("engine-verdict")).toHaveText("unknown (not a pass)");
    await expect(detail).toContainText("engine_crashed");
    await runRow(page, RUNS.notRun.id).click();
    detail = page.getByTestId("engine-run-detail");
    await expect(detail.getByTestId("engine-verdict")).toHaveText("not run (not a pass)");
    await expect(detail).toContainText("approval denied; nothing ran");
    await expect(detail.getByTestId("engine-not-run-list")).toContainText("The whole run did not run");
    await expectAxeClean(page, "evals engine runs");
  });

  test("no raw text field reaches the page, whatever the item carries", async ({ page }) => {
    await open(page, "redteam");
    const markers = ["RAW-MODEL-OUTPUT-4410", "RAW-PROMPT-4410", "RAW-REPORT-4410"];
    await page.route(`**/v1/engine-runs/${RUNS.completedFail.id}`, (route) =>
      json(route, {
        run: { ...RUNS.completedFail, rawReport: markers[2] },
        items: itemsOf(RUNS.completedFail.id).map((i: Json) => ({ ...i, output: markers[0], prompt: markers[1], response: markers[0], transcript: markers[1] })),
      }),
    );
    await runRow(page, RUNS.completedFail.id).click();
    await expect(page.getByTestId("engine-not-run-list")).toContainText("Not run (2)");
    const text = await page.locator("body").innerText();
    for (const m of markers) expect(text).not.toContain(m);
    expect(await page.content()).not.toContain("RAW-");
  });

  test("with no engine enabled the form is replaced by the way to enable one", async ({ page }) => {
    const engines = enginesList();
    for (const e of engines.engines) e.enabled = false;
    await open(page, "redteam", { engines, runs: [] });
    await expect(page.getByTestId("engine-run-form")).toHaveCount(0);
    await expect(page.getByText("No engine is enabled")).toBeVisible();
    await expect(page.getByRole("link", { name: "Engines page" }).first()).toHaveAttribute("href", "/ui/admin/engines");
    await expect(page.getByText("No engine runs yet")).toBeVisible();
    await expectAxeClean(page, "no engine enabled");
  });

  test("B5W-02: a failed, timed-out or cancelled run with no items never claims every item ran", async ({ page }) => {
    await open(page, "redteam");
    for (const r of [RUNS.failedUnknown, RUNS.timeout, RUNS.cancelled]) {
      await runRow(page, r.id).click();
      const coverage = page.getByTestId("engine-run-coverage");
      await expect(coverage).toHaveAttribute("data-coverage", "none");
      await expect(coverage).toContainText("No item measurements were recorded");
      await expect(page.getByTestId("engine-run-detail")).not.toContainText(/Every (recorded )?item ran/);
    }
  });

  test("B5W-05: the open run is in the URL — deep link, reload, Back/Forward, unrelated fields kept", async ({ page }) => {
    await mockShell(page);
    await installEnginesMock(page);
    await page.goto(`/ui/admin/redteam?keep=1&run=${RUNS.completedFail.id}`);
    const detail = page.getByTestId("engine-run-detail");
    await expect(detail.getByTestId("engine-run-counts")).toContainText("1 pass · 1 fail", { timeout: 30_000 });
    await page.reload();
    await expect(detail.getByTestId("engine-run-counts")).toContainText("1 pass · 1 fail", { timeout: 30_000 });
    await runRow(page, RUNS.notRun.id).click();
    await expect(detail.getByTestId("engine-run-status")).toHaveText("not run");
    expect(new URL(page.url()).searchParams.get("keep")).toBe("1");
    expect(new URL(page.url()).searchParams.get("run")).toBe(RUNS.notRun.id);
    await page.goBack();
    await expect(detail.getByTestId("engine-run-counts")).toContainText("1 pass · 1 fail");
    await page.goForward();
    await expect(detail.getByTestId("engine-run-status")).toHaveText("not run");
  });

  test("B5W-05: an Evaluations deep link opens on the Engine runs tab", async ({ page }) => {
    await mockShell(page);
    await installEnginesMock(page);
    await page.goto(`/ui/admin/evals?keep=1&run=${RUNS.failedUnknown.id}`);
    await expect(page.getByRole("tab", { name: "Engine runs" })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    await expect(page.getByTestId("engine-run-detail").getByTestId("engine-run-status")).toHaveText("failed");
    await page.getByRole("tab", { name: "Catalog" }).click();
    expect(new URL(page.url()).searchParams.get("run")).toBeNull();
    expect(new URL(page.url()).searchParams.get("keep")).toBe("1");
  });

  test("B5W-05: an invalid or unknown run id shows an explicit unavailable state", async ({ page }) => {
    await mockShell(page);
    await installEnginesMock(page);
    await page.goto("/ui/admin/redteam?run=not-a-run");
    const unavailable = page.getByTestId("engine-run-unavailable");
    await expect(unavailable).toContainText("the link does not name a valid run", { timeout: 30_000 });
    await page.goto("/ui/admin/redteam?run=99999999-1111-4000-8000-0000000000ff");
    await expect(unavailable).toContainText("it does not exist or you cannot see it");
    await expectAxeClean(page, "engine run unavailable");
    await unavailable.getByRole("button", { name: "Close" }).click();
    await expect(unavailable).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("run")).toBeNull();
  });
});
