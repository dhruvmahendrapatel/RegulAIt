/**
 * ADR-0187 X26 — the Engines page (`/admin/engines`) against the §4.10 mock
 * fixtures (`engines-fixtures.ts`):
 *
 *  - every state renders honestly: an enabled engine, one whose self-test
 *    failed on egress, one not built; nothing unmeasured reads as healthy and
 *    the detection-content stub (501) reads as "not available", never as empty;
 *  - enabling a build that does not isolate the runner credential (decision 79):
 *    the gateway's 409 opens an explicit acceptance that quotes its reason; the
 *    acceptance is sent only after it is ticked, and then still through step-up;
 *  - a refused enable (no passing self-test) is shown in that engine's card;
 *  - switching off, revoking a runner and running the self-test are confirmed,
 *    with their consequences, before anything is sent;
 *  - an enrolment token is shown once, inside the dialog that minted it, focused, then gone;
 *  - a self-test that expires while the page is open stops reading green on its own;
 *  - raising a limit steps up; lowering one does not;
 *  - axe is clean in both themes, with and without the acceptance dialog open.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { installBuilderMock } from "./builder-fixtures";
import { RUNNER_PF, enginesList, installEnginesMock, type EnginesMockState } from "./engines-fixtures";
import { expectAxeClean } from "./prompts-fixtures";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ISOLATION_DETAIL =
  "engine promptfoo's build runs the engine process as the runner's own user, so a compromised engine could read the runner token " +
  "(it can lease this engine's runs and post their results; it cannot reach any other route). " +
  "To enable it anyway, send acceptCredentialIsolationRisk: true with a step-up; the isolating build is ADR-0187 slice B5-P2.";

/** the fixture list with promptfoo switched off (its self-test still a fresh pass), so it can be enabled */
function enginesWithPromptfooOff(): Json {
  const list = enginesList();
  list.engines[0].enabled = false;
  return list;
}

async function open(page: Page, init: Partial<EnginesMockState> = {}): Promise<EnginesMockState> {
  await installBuilderMock(page, { isAdmin: true });
  const st = await installEnginesMock(page, init);
  await page.route("**/v1/detection-content", (route) => json(route, 501, { error: "not_built" }));
  await page.goto("/ui/admin/engines");
  await expect(page.getByRole("heading", { name: "Engines", level: 1 })).toBeVisible();
  return st;
}

const card = (page: Page, id: string) => page.getByTestId(`engine-${id}`);
const sent = (st: EnginesMockState, method: string, path: string) => st.calls.filter((c) => c.method === method && c.path === path);

test.describe("ADR-0187 X26: the Engines page", () => {
  test("renders every engine state honestly, and is axe-clean", async ({ page }) => {
    await open(page);
    const pf = card(page, "promptfoo");
    await expect(pf.getByText("On — self-test passed")).toBeVisible();
    await expect(pf.getByRole("cell", { name: "promptfoo-runner-1", exact: true })).toBeVisible();
    // a run status is never shown as a verdict
    await expect(pf.getByText(/^completed, /)).toBeVisible();
    await expect(pf.getByRole("link", { name: "Red-teaming" })).toHaveAttribute("href", "/ui/admin/redteam");

    const gk = card(page, "garak");
    await expect(gk.getByText("Off — self-test failed")).toBeVisible();
    const egress = gk.getByRole("list", { name: "Last egress probe" });
    await expect(egress.getByRole("listitem").filter({ hasText: "DNS for example.com" })).toContainText("resolved");
    await expect(gk.getByRole("list", { name: "Self-test failures" })).toContainText("egress_dns_resolved");
    await expect(gk.getByText("not counted (unverified)")).toBeVisible();

    const ms = card(page, "modelscan");
    await expect(ms.getByText("Off — not built")).toBeVisible();
    await expect(ms.getByText("none (not built)")).toBeVisible();
    await expect(ms.getByText("No self-test is recorded.", { exact: false })).toBeVisible();
    await expect(ms.getByText("No egress probe is recorded", { exact: false })).toBeVisible();
    await expect(ms.getByRole("heading", { name: "Runners (0)" })).toBeVisible();
    await expect(ms.getByRole("link", { name: "Admission review (model artifacts)" })).toBeVisible();
    // nothing about the unbuilt engine reads as passing
    await expect(ms.getByText("passed", { exact: true })).toHaveCount(0);

    await expect(page.getByText("Not available on this gateway yet")).toBeVisible();
    await expectAxeClean(page, "engines page");
  });

  test("decision 79: the credential-isolation refusal opens an explicit, stepped-up acceptance", async ({ page }) => {
    const st = await open(page, { engines: enginesWithPromptfooOff() });
    const su = await requireStepUpOn(page, {
      method: "PATCH",
      path: "/v1/engines/promptfoo",
      kind: "settings_relax",
      facts: () => ({ values: { "engine.promptfoo.enabled": true, "engine.promptfoo.acceptCredentialIsolationRisk": true } }),
    });
    // the gateway decides isolation BEFORE the step-up (engines.ts), so this answers first
    await page.route("**/v1/engines/promptfoo", (route) => {
      const req = route.request();
      const body = req.method() === "PATCH" ? (req.postDataJSON() as Json) : null;
      if (body?.enabled === true && body.acceptCredentialIsolationRisk !== true) {
        st.calls.push({ method: "PATCH", path: "/v1/engines/promptfoo", body, headers: req.headers() });
        return json(route, 409, { error: "engine_credential_isolation_missing", detail: ISOLATION_DETAIL });
      }
      return route.fallback();
    });

    await card(page, "promptfoo").getByRole("button", { name: "Enable…" }).click();
    const confirm = page.getByRole("dialog", { name: "Enable promptfoo?" });
    await expect(confirm).toContainText("confirm it's you");
    await confirm.getByRole("button", { name: "Enable" }).click();

    const accept = page.getByRole("dialog", { name: "Accept the credential-isolation risk for promptfoo?" });
    await expect(accept.getByTestId("credential-isolation-reason")).toHaveText(ISOLATION_DETAIL);
    await expect(accept).toContainText("engine-credential-isolation-risk-accepted");
    const go = accept.getByRole("button", { name: "Accept risk and enable" });
    await expect(go).toBeDisabled();
    // the first request never carried the acceptance
    expect(sent(st, "PATCH", "/v1/engines/promptfoo")).toHaveLength(1);
    expect(sent(st, "PATCH", "/v1/engines/promptfoo")[0]!.body).toEqual({ enabled: true });
    await expectAxeClean(page, "credential-isolation acceptance");

    await accept.getByRole("checkbox").check();
    await go.click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ enabled: true, acceptCredentialIsolationRisk: true });
    await expect(card(page, "promptfoo").getByText("On — self-test passed")).toBeVisible();
  });

  test("keeping it off sends nothing more after the refusal", async ({ page }) => {
    const st = await open(page, { engines: enginesWithPromptfooOff() });
    await page.route("**/v1/engines/promptfoo", (route) =>
      route.request().method() === "PATCH" ? json(route, 409, { error: "engine_credential_isolation_missing", detail: ISOLATION_DETAIL }) : route.fallback(),
    );
    await card(page, "promptfoo").getByRole("button", { name: "Enable…" }).click();
    await page.getByRole("dialog", { name: "Enable promptfoo?" }).getByRole("button", { name: "Enable" }).click();
    await page.getByRole("dialog", { name: /Accept the credential-isolation risk/ }).getByRole("button", { name: "Keep it off" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(st.calls.filter((c) => c.method === "PATCH")).toHaveLength(0); // the override answered; the fixture saw nothing
    await expect(card(page, "promptfoo").getByText("Off — ready to enable")).toBeVisible();
  });

  test("a refused enable (no passing self-test) is shown in that engine's card", async ({ page }) => {
    const st = await open(page);
    await card(page, "garak").getByRole("button", { name: "Enable…" }).click();
    await page.getByRole("dialog", { name: "Enable garak?" }).getByRole("button", { name: "Enable" }).click();
    await expect(card(page, "garak").getByRole("alert")).toContainText("no passing runner self-test is recorded");
    expect(sent(st, "PATCH", "/v1/engines/garak").map((c) => c.body)).toEqual([{ enabled: true }]);
  });

  test("switching off is confirmed with its consequences and needs no step-up", async ({ page }) => {
    const st = await open(page);
    await card(page, "promptfoo").getByRole("button", { name: "Switch off" }).click();
    const dialog = page.getByRole("dialog", { name: "Switch promptfoo off?" });
    await expect(dialog).toContainText("run-scoped keys are revoked");
    await expect(dialog).toContainText("engine-updated");
    expect(sent(st, "PATCH", "/v1/engines/promptfoo")).toHaveLength(0);
    await dialog.getByRole("button", { name: "Switch off" }).click();
    await expect(card(page, "promptfoo").getByText("Off — ready to enable")).toBeVisible();
    const patches = sent(st, "PATCH", "/v1/engines/promptfoo");
    expect(patches.map((c) => c.body)).toEqual([{ enabled: false }]);
    expect(patches[0]!.headers["x-regulait-step-up"]).toBeUndefined();
  });

  test("an enrolment token is shown once, in the dialog that minted it, with focus on it; then gone", async ({ page }) => {
    const st = await open(page);
    // garak is the LAST card: the reveal must not land screens away from it (PR #230 review)
    await card(page, "garak").getByRole("button", { name: "Mint enrolment token…" }).click();
    const dialog = page.getByRole("dialog", { name: "Mint an enrolment token for garak" });
    await dialog.getByLabel("Label (optional)").fill("rack-2");
    await dialog.getByRole("button", { name: "Mint token" }).click();
    // the dialog stays open and holds the token; focus moves to it for screen readers
    const secret = dialog.getByTestId("revealed-secret");
    await expect(secret).toHaveText(`rgee_${"f".repeat(64)}`);
    await expect(dialog.getByRole("region", { name: "Enrolment token, shown once" })).toBeFocused();
    await expect(dialog).toContainText("shown once");
    await expect(page.getByTestId("revealed-secret")).toHaveCount(1); // nowhere else on the page
    expect(sent(st, "POST", "/v1/engines/garak/enrollment-tokens").map((c) => c.body)).toEqual([{ label: "rack-2", ttlMinutes: 15 }]);
    await expectAxeClean(page, "enrolment token reveal");
    await dialog.getByRole("button", { name: "I've copied it — close" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("revealed-secret")).toHaveCount(0);
    await expect(page.getByText(/rgee_/)).toHaveCount(0);
  });

  test("closing the token dialog with Escape discards the token too", async ({ page }) => {
    await open(page);
    await card(page, "promptfoo").getByRole("button", { name: "Mint enrolment token…" }).click();
    const dialog = page.getByRole("dialog", { name: "Mint an enrolment token for promptfoo" });
    await dialog.getByRole("button", { name: "Mint token" }).click();
    await expect(dialog.getByTestId("revealed-secret")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(/rgee_/)).toHaveCount(0);
  });

  test("a self-test passing as the page was opened stops reading green at its 24 h expiry, with no user action", async ({ page }) => {
    await page.clock.install();
    await open(page);
    const pf = card(page, "promptfoo");
    // the fixture's promptfoo self-test passed 30 minutes ago: green until 23 h 30 min from now
    await expect(pf.getByText("On — self-test passed")).toBeVisible();
    await page.clock.fastForward("23:29:00");
    await expect(pf.getByText("On — self-test passed")).toBeVisible();
    await page.clock.fastForward("00:02:00");
    await expect(pf.getByText("On — self-test not current")).toBeVisible();
    await expect(pf.getByText("On — self-test passed")).toHaveCount(0);
  });

  test("revoking a runner asks for a reason, states the consequence, and sends the DELETE", async ({ page }) => {
    const st = await open(page);
    await card(page, "promptfoo").getByRole("button", { name: "Revoke runner promptfoo-runner-1" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke runner promptfoo-runner-1?" });
    await expect(dialog).toContainText("Runs it holds end as cancelled");
    await dialog.getByRole("button", { name: "Revoke runner" }).click();
    await expect(dialog.getByRole("alert")).toContainText("A reason is required");
    expect(sent(st, "DELETE", `/v1/engine-runners/${RUNNER_PF}`)).toHaveLength(0);
    await dialog.getByLabel("Reason").fill("host decommissioned");
    await dialog.getByRole("button", { name: "Revoke runner" }).click();
    await expect(card(page, "promptfoo").getByRole("heading", { name: "Runners (0)" })).toBeVisible();
    // the DELETE carries a JSON body, so the fixture records it
    expect(sent(st, "DELETE", `/v1/engine-runners/${RUNNER_PF}`).map((c) => c.body)).toEqual([{ reason: "host decommissioned" }]);
  });

  test("the self-test is confirmed first and its verdict is shown, a failure as a failure", async ({ page }) => {
    const st = await open(page);
    await card(page, "garak").getByRole("button", { name: "Run self-test…" }).click();
    const dialog = page.getByRole("dialog", { name: "Run garak's self-test?" });
    await expect(dialog).toContainText("If it fails, the engine is switched off");
    expect(sent(st, "POST", "/v1/engines/garak/self-test")).toHaveLength(0);
    await dialog.getByRole("button", { name: "Run self-test" }).click();
    await expect(card(page, "garak").getByRole("status").filter({ hasText: "Self-test just run" })).toContainText("failed");
    expect(sent(st, "POST", "/v1/engines/garak/self-test")).toHaveLength(1);
  });

  test("raising a limit steps up; lowering one does not", async ({ page }) => {
    const st = await open(page);
    // lower: no step-up
    await card(page, "promptfoo").getByRole("button", { name: "Change limits…" }).click();
    let dialog = page.getByRole("dialog", { name: "Change promptfoo's limits" });
    await dialog.getByLabel("Budget ceiling (USD)").fill("2");
    await expect(dialog).toContainText("Lowering a limit asks nothing more");
    await dialog.getByRole("button", { name: "Save limits" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => sent(st, "PATCH", "/v1/engines/promptfoo").length).toBe(1);
    expect(sent(st, "PATCH", "/v1/engines/promptfoo")[0]!.body).toEqual({ maxBudgetUsd: 2 });

    // raise: out of range first, then a step-up
    const su = await requireStepUpOn(page, { method: "PATCH", path: "/v1/engines/promptfoo", kind: "settings_relax", facts: () => ({ values: { "engine.promptfoo.timeoutSeconds": 3600 } }) });
    await card(page, "promptfoo").getByRole("button", { name: "Change limits…" }).click();
    dialog = page.getByRole("dialog", { name: "Change promptfoo's limits" });
    await dialog.getByLabel("Timeout (seconds)").fill("9000");
    await expect(dialog.getByRole("alert")).toContainText("between 60 and 7200");
    await expect(dialog.getByRole("button", { name: "Save limits" })).toBeDisabled();
    await dialog.getByLabel("Timeout (seconds)").fill("3600");
    await expect(dialog).toContainText("you will be asked to confirm it's you");
    await dialog.getByRole("button", { name: "Save limits" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ timeoutSeconds: 3600 });
  });

  test("the revocation reason is bounded like the gateway's, and a refusal keeps the dialog and its text", async ({ page }) => {
    const st = await open(page);
    await page.route(`**/v1/engine-runners/${RUNNER_PF}`, (route) =>
      route.request().method() === "DELETE"
        ? json(route, 422, { error: "validation", issues: [{ path: "reason", message: "String must contain at most 500 character(s)" }] })
        : route.fallback(),
    );
    await card(page, "promptfoo").getByRole("button", { name: "Revoke runner promptfoo-runner-1" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke runner promptfoo-runner-1?" });
    const reason = dialog.getByLabel("Reason");
    const submit = dialog.getByRole("button", { name: "Revoke runner" });
    await reason.fill("x".repeat(501));
    await expect(dialog.getByText("501 / 500 characters")).toBeVisible();
    await expect(submit).toBeDisabled();
    await reason.fill("host decommissioned");
    await expect(dialog.getByText("19 / 500 characters")).toBeVisible();
    await submit.click();
    // the gateway refused: the dialog stays, with the text and the refusal in it
    await expect(dialog.getByRole("alert")).toContainText("Reason must be at most 500 characters");
    await expect(reason).toHaveValue("host decommissioned");
    await expect(card(page, "promptfoo").getByRole("heading", { name: "Runners (1)" })).toBeVisible();
    expect(sent(st, "DELETE", `/v1/engine-runners/${RUNNER_PF}`)).toHaveLength(0); // the override answered
    await expectAxeClean(page, "revoke dialog with a refusal");
  });

  test("a runner's passing report older than 24 h reads stale, never passed", async ({ page }) => {
    const list = enginesList();
    list.engines[0].runners[0].selfTestReportedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    await open(page, { engines: list });
    const row = card(page, "promptfoo").getByRole("row", { name: /promptfoo-runner-1/ });
    await expect(row.getByText("self-test report stale")).toBeVisible();
    await expect(row.getByText("passed", { exact: true })).toHaveCount(0);
  });

  test("a runner report that expires while the page is open stops reading passed, with no user action", async ({ page }) => {
    await page.clock.install();
    const list = enginesList();
    list.engines[0].runners[0].selfTestReportedAt = new Date(Date.now() - 23.5 * 3600_000).toISOString();
    await open(page, { engines: list });
    const row = card(page, "promptfoo").getByRole("row", { name: /promptfoo-runner-1/ });
    await expect(row.getByText("passed", { exact: true })).toBeVisible();
    await page.clock.fastForward("00:31:00");
    await expect(row.getByText("self-test report stale")).toBeVisible();
    await expect(row.getByText("passed", { exact: true })).toHaveCount(0);
  });

  test("enabling modelscan explains the artifact-only path; only a model-access engine claims run-scoped keys", async ({ page }) => {
    await open(page);
    await card(page, "modelscan").getByRole("button", { name: "Enable…" }).click();
    const ms = page.getByRole("dialog", { name: "Enable modelscan?" });
    await expect(ms).toContainText("scans an uploaded model artifact");
    await expect(ms).toContainText("no model credentials");
    await expect(ms).not.toContainText("run-scoped key");
    await ms.getByRole("button", { name: "Cancel" }).click();
    await card(page, "garak").getByRole("button", { name: "Enable…" }).click();
    await expect(page.getByRole("dialog", { name: "Enable garak?" })).toContainText("run-scoped key");
  });

  test("a failed engine list is an error with a retry, never an empty page", async ({ page }) => {
    await installBuilderMock(page, { isAdmin: true });
    await page.route("**/v1/engines", (route) => json(route, 500, { error: "internal" }));
    await page.route("**/v1/detection-content", (route) => json(route, 501, { error: "not_built" }));
    await page.goto("/ui/admin/engines");
    await expect(page.getByRole("alert")).toContainText("Something went wrong on the server");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("No engines are registered")).toHaveCount(0);
  });
});
