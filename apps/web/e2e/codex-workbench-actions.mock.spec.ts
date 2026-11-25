/**
 * Codex review cards UIW-01, UIW-02, UIW-06, UIW-07 and UIW-08 — the workbench actions, against mocked gateways:
 *
 *  - UIW-01: the shared builder Composer keeps the written text until the send succeeds; a refused or failed send
 *    keeps it and shows why (builder chat, agent inbox);
 *  - UIW-02: the Enter that commits an IME candidate (isComposing) does not send;
 *  - UIW-06: in the Inbox, Deny waits for a required reason exactly as Approve does (the server refuses both
 *    without one: override_reason_required, self_review_reason_required);
 *  - UIW-07: the plan-only card says what the gateway enforces (plan-only.ts, ADR-0250): a project-attached
 *    instance blocks unnamed mutating calls too; a project-less one only calls that name it;
 *  - UIW-08: a workflow action button is disabled while its request is in flight, so it cannot be sent twice.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { installBuilderMock, sent } from "./builder-fixtures";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

test.describe("UIW-01 / UIW-02: the builder Composer", () => {
  test("UIW-01: a refused send keeps the text and shows the reason; a successful send clears it", async ({ page }) => {
    const st = await installBuilderMock(page);
    const intake = st.agents.find((a) => a.name === "Intake reviewer")!;
    intake.spentThisMonthUsd = 50; // at its limit → 402
    await page.goto("/ui/builder");
    const box = page.getByLabel("Message");
    await box.fill("Summarise the open intake requests");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("alert")).toContainText(/agent spend limit reached/i);
    await expect(box).toHaveValue("Summarise the open intake requests");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    // the limit lifts; the same draft is sent as written, then the box clears
    intake.spentThisMonthUsd = 0;
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/\?thread=th-/);
    await expect(page.getByText("Here is what I found about: Summarise the open intake requests")).toBeVisible();
    await expect(page.getByLabel("Message")).toHaveValue("");
  });

  test("UIW-01: a failed inbox reply keeps the reply text", async ({ page }) => {
    await installBuilderMock(page);
    await page.route("**/v1/builder/agents/*/chat", (route) => json(route, { error: "upstream_unavailable", detail: "the model provider did not answer" }, 503));
    await page.goto("/ui/builder/inbox?thread=th-0001");
    const box = page.getByLabel("Reply");
    await box.fill("Ask both owners to fill it in.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/did not answer|upstream/i).first()).toBeVisible();
    await expect(box).toHaveValue("Ask both owners to fill it in.");
  });

  test("UIW-02: Enter while an IME is composing does not send; a plain Enter does", async ({ page }) => {
    const st = await installBuilderMock(page);
    await page.goto("/ui/builder");
    const box = page.getByLabel("Message");
    await box.fill("東京の");
    await box.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    await expect(box).toHaveValue("東京の");
    expect(st.calls.filter((c) => c.method === "POST" && /\/chat$/.test(c.path))).toHaveLength(0);

    await box.press("Enter");
    await expect(page).toHaveURL(/\?thread=th-/);
    expect(st.calls.filter((c) => c.method === "POST" && /\/chat$/.test(c.path))).toHaveLength(1);
  });
});

// ---- the Inbox (UIW-06) ----------------------------------------------------------------------------------------

const NOW = Date.now();
const ME = "u";
const OWN = {
  id: "A1", status: "pending", objectType: "governance_remediation", stageId: "__remediation__link_control",
  requestedAt: new Date(NOW - 2 * 3600_000).toISOString(), userId: ME, approverUserId: ME,
  objectLabel: "Link the human-oversight control to the source risk", requestedByName: "Avery Approver", approverName: "Avery Approver", selfReview: true,
};

async function mockInbox(page: Page, decisions: unknown[]) {
  let shown: unknown[] = [OWN];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (req.method() === "POST" && /^\/v1\/approvals\/A1\/decide$/.test(p)) {
      decisions.push(req.postDataJSON());
      shown = [];
      return json(route, { status: "denied" });
    }
    if (p === "/auth/me") return json(route, { userId: ME, isAdmin: true, via: "session", user: { id: ME, email: "avery@example.test", displayName: "Avery Approver" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: ME, isAdmin: true, user: { id: ME, email: "avery@example.test", displayName: "Avery Approver" } });
    if (p === "/v1/approvals") return json(route, { approvals: shown });
    if (p === "/v1/annotations/inbox") return json(route, { items: [] });
    if (p === "/v1/users") return json(route, { users: [{ id: ME, email: "avery@example.test", displayName: "Avery Approver" }] });
    if (p === "/v1/users/directory") return json(route, { users: [] });
    if (p === "/v1/governance/alerts") return json(route, { alerts: [], counts: { open: 0, acknowledged: 0, resolved: 0 }, lastEvaluatedAt: null, rules: [] });
    if (p === "/v1/governance/remediations") return json(route, { proposals: [] });
    if (p === "/v1/org/settings") return json(route, { settings: {} });
    if (p === "/v1/pm/connections") return json(route, { connections: [] });
    return json(route, {});
  });
}

test("UIW-06: Deny waits for a required reason, with the same hint as Approve", async ({ page }) => {
  const decisions: unknown[] = [];
  await mockInbox(page, decisions);
  await page.goto("/ui/inbox");
  await page.getByRole("button", { name: /^Review Link the human-oversight control/ }).click();
  const item = page.getByTestId("inbox-item");
  const deny = item.getByRole("button", { name: "Deny" });
  const approve = item.getByRole("button", { name: "Approve" });
  await expect(deny).toBeDisabled();
  await expect(approve).toBeDisabled();
  await expect(item.getByText("Approve and Deny unlock once a reason is entered")).toBeVisible();

  await item.getByRole("textbox", { name: "Decision reason" }).fill("The control is already linked elsewhere.");
  await expect(deny).toBeEnabled();
  await expect(approve).toBeEnabled();
  await expect(item.getByText("Approve and Deny unlock once a reason is entered")).toHaveCount(0);
  await deny.click();
  await expect.poll(() => decisions).toEqual([{ decision: "denied", reason: "The control is already linked elsewhere." }]);
});

// ---- the workflow detail page (UIW-07, UIW-08) -----------------------------------------------------------------

const INSTANCE = "00000000-0000-4000-8000-000000000a01";
const PROJECT = "66666666-0000-4000-8000-000000000001";

function planningInstance(projectId: string | null) {
  return {
    instance: {
      id: INSTANCE,
      status: "blocked_on_plan",
      createdAt: new Date(NOW - 3600_000).toISOString(),
      projectId,
      initiatorUserId: ME,
      change: { description: "Rotate the payments API key", changeType: "standard", environment: "staging" },
      definition: { stages: [{ id: "plan", type: "plan_only" }, { id: "build", type: "agent_build" }] },
      state: { currentStageIndex: 0, stageStatuses: { 0: "active" } },
      context: {},
    },
    artifacts: [],
    pendingApprovals: [],
  };
}

async function mockWorkflow(page: Page, opts: { projectId: string | null; advance?: Promise<void>; advances?: unknown[] }) {
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { userId: ME, isAdmin: true, via: "session", user: { id: ME, email: "avery@example.test", displayName: "Avery Approver" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: ME, isAdmin: true, user: { id: ME, email: "avery@example.test", displayName: "Avery Approver" } });
    if (p === `/v1/workflows/instances/${INSTANCE}/advance` && req.method() === "POST") {
      opts.advances?.push(req.postDataJSON());
      if (opts.advance) await opts.advance;
      return json(route, { ok: true });
    }
    if (p === `/v1/workflows/instances/${INSTANCE}`) return json(route, planningInstance(opts.projectId));
    if (p === "/v1/pm/connections") return json(route, { connections: [] });
    return json(route, {});
  });
}

test("UIW-07: a project-attached planning instance says unnamed mutating calls are blocked too", async ({ page }) => {
  await mockWorkflow(page, { projectId: PROJECT });
  await page.goto(`/ui/workflows/${INSTANCE}`);
  const scope = page.getByTestId("plan-only-scope");
  await expect(scope).toContainText("attributed to this workflow's project is refused on every surface");
  await expect(scope).toContainText("whether or not it names this workflow");
  await expect(scope).toContainText("ADR-0250");
  await expect(scope).not.toContainText("not constrained");
});

test("UIW-07: a project-less planning instance keeps the names-this-workflow wording", async ({ page }) => {
  await mockWorkflow(page, { projectId: null });
  await page.goto(`/ui/workflows/${INSTANCE}`);
  const scope = page.getByTestId("plan-only-scope");
  await expect(scope).toContainText("an agent call that names this workflow");
  await expect(scope).toContainText("This workflow has no project, so a call that names no workflow is not constrained");
});

test("UIW-08: Finish planning is disabled while its request is in flight, so it is sent once", async ({ page }) => {
  let release!: () => void;
  const advance = new Promise<void>((r) => (release = r));
  const advances: unknown[] = [];
  await mockWorkflow(page, { projectId: PROJECT, advance, advances });
  await page.goto(`/ui/workflows/${INSTANCE}`);
  const finish = page.getByRole("button", { name: "Finish planning" });
  await finish.click();
  await expect(finish).toBeDisabled();
  await expect(finish).toHaveAttribute("aria-busy", "true");
  // a second click while pending does nothing
  await finish.click({ force: true });
  release();
  await expect(page.getByText("Planning finished — plan-only lifted")).toBeVisible();
  await expect(finish).toBeEnabled();
  expect(advances).toEqual([{ stageId: "plan" }]);
});
