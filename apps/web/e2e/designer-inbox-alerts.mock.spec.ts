import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

// Governed - Designer batch 3 (owner-approved one item at a time on #453, 2026-10-19):
// G2 Inbox approval and G5 governance alert detail, with the (i) inventory rows for both.

const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const ME = "u";

const approvals = [
  { id: "A1", status: "pending", objectType: "governance_remediation", stageId: "__remediation__link_control", requestedAt: ago(2), userId: ME, approverUserId: ME, objectLabel: "Link the human-oversight control to the source risk", requestedByName: "Avery Approver", approverName: "Avery Approver", selfReview: true },
  { id: "A2", status: "pending", objectType: "project", stageId: "__project_budget__", requestedAt: ago(7), userId: "budget", approverUserId: "morgan", objectLabel: "team-17 support: monthly budget 112% used", requestedByName: "Budget monitor", approverName: "Morgan Reyes" },
  { id: "A3", status: "approved", objectType: "governance_remediation", stageId: "__remediation__link_control", requestedAt: ago(30), decidedAt: ago(24), userId: "ada", approverUserId: ME, objectLabel: "Retire a vendor link", requestedByName: "Ada Admin", decidedByName: "Avery Approver", decisionReason: "Vendor not in use." },
];

// intake sign-offs are decided in ReviewPanel, which owns their rules and copy (#457 review M1)
const INTAKE = "AI use-case intake: ";
const intakeOwn = { id: "I1", status: "pending", objectType: "workflow", stageId: "signoff", instanceId: "W1", useCaseId: "uc1", requestedAt: ago(20), userId: ME, approverUserId: "morgan", objectLabel: `${INTAKE}Credit-limit-increase assistant`, requestedByName: "Avery Approver", approverName: "Morgan Reyes", selfReview: true };
const intakeRole = { id: "I2", status: "pending", objectType: "workflow", stageId: "signoff", instanceId: "W2", useCaseId: "uc1", requestedAt: ago(20), userId: "jordan", approverUserId: "morgan", objectLabel: `${INTAKE}Support drafting assistant`, requestedByName: "Jordan Owner", approverName: "Morgan Reyes", reviewRole: { id: "risk", name: "Risk and compliance" } };
const dryRun = { id: "D1", status: "pending", objectType: "workflow", stageId: "merge_signoff", instanceId: "W3", requestedAt: ago(3), userId: "jordan", approverUserId: ME, objectLabel: "Rotate the payments API key", requestedByName: "Jordan Owner", approverName: "Avery Approver" };
const overview = {
  useCase: { id: "uc1", name: "Credit-limit-increase assistant", status: "under_review", complianceTags: [] },
  screening: { tier: "high", reasons: [{ reason: "Access to essential financial services." }], rulesetVersion: 1, screened: true },
  questionnaire: { submitted: true, artifactId: "a", version: 1, submittedAt: ago(20) },
  stack: { agents: [], vendors: [] }, risks: [], summary: {}, approvals: [], audit: [],
};
let shown: unknown[] = approvals;

const alert = {
  id: "al", ruleId: "use_case_inherited_high_risk", ruleLabel: "Approved use case carries a high rating", severity: "high", status: "open",
  subject: { key: "use_case:uc", type: "use_case", id: "uc", label: "Credit-limit assistant", context: null },
  title: "Credit-limit assistant inherits a high rating from Acme Model Services",
  detail: { sourceNodeKey: "vendor:v", sourceRiskId: "r1", pathLabels: ["Credit-limit assistant", "Credit assistant", "mock-balanced", "Acme Model Services"] },
  firstDetectedAt: ago(4), lastDetectedAt: ago(2), acknowledgedAt: null, acknowledgedBy: null, ackNote: null, resolvedAt: null,
};
const remediation = {
  alert: { id: "al", ruleId: alert.ruleId, status: "open", title: alert.title },
  candidates: [
    { kind: "link_control", executable: true, title: "Link the human-oversight control to the source risk", rationale: "The source risk has no current mitigating control.", params: {}, steps: [] },
    { kind: "assess_vendor", executable: false, title: "Reassess Acme Model Services", rationale: "Vendor assurance is an operator-led workflow.", params: {}, steps: ["Open the vendor assessment.", "Request current assurance evidence."] },
  ],
  proposals: [], note: "Executable changes are proposed into the one approvals queue.",
};

let alertsShown: unknown[] = [alert];
// The Active tab lists every alert that is not resolved (governance-monitor.ts), so by default an acknowledgement
// keeps the alert listed with status "acknowledged"; the remove-from-list path opts in with ackRemoves
let ackRemoves = false;

async function mock(route: Route) {
  const p = new URL(route.request().url()).pathname;
  let body: unknown = {};
  const decided = route.request().method() === "POST" ? /^\/v1\/approvals\/([^/]+)\/decide$/.exec(p) : null;
  const acked = route.request().method() === "POST" ? /^\/v1\/governance\/alerts\/([^/]+)\/acknowledge$/.exec(p) : null;
  if (decided) shown = shown.filter((a) => (a as { id: string }).id !== decided[1]);
  else if (acked) alertsShown = ackRemoves
    ? alertsShown.filter((a) => (a as { id: string }).id !== acked[1])
    : alertsShown.map((a) => ((a as { id: string }).id === acked[1] ? { ...(a as object), status: "acknowledged", acknowledgedAt: ago(0), acknowledgedBy: "Avery Approver", ackNote: "acknowledged" } : a));
  else if (p === "/auth/me") body = { userId: ME, isAdmin: true, via: "session", user: { id: ME, email: "avery@example.test", displayName: "Avery Approver" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
  else if (p === "/v1/me") body = { userId: ME, isAdmin: true, user: { id: ME, email: "avery@example.test", displayName: "Avery Approver" } };
  else if (p === "/v1/approvals") body = { approvals: shown };
  else if (p === "/v1/use-cases/uc1/overview") body = overview;
  else if (p === "/v1/use-cases/uc1") body = { reviews: [] };
  else if (p === "/v1/governance/review-policy") body = { roles: [{ id: "risk", name: "Risk and compliance", memberUserIds: [ME] }], riskAcceptorUserIds: [] };
  else if (p === "/v1/users/directory") body = { users: [] };
  else if (p === "/v1/workflows/instances/W3") body = { instance: { id: "W3", context: { "deploy:prod": { dryRun: true } } }, artifacts: [] };
  else if (p.startsWith("/v1/workflows/instances/")) body = { instance: { id: "W", context: {} }, artifacts: [] };
  else if (p === "/v1/annotations/inbox") body = { items: [] };
  else if (p === "/v1/users") body = { users: [{ id: ME, email: "avery@example.test", displayName: "Avery Approver" }, { id: "morgan", email: "morgan@example.test", displayName: "Morgan Reyes" }] };
  else if (p === "/v1/governance/alerts") body = { alerts: alertsShown, counts: { open: alertsShown.length, acknowledged: 0, resolved: 0 }, lastEvaluatedAt: ago(1), rules: [] };
  else if (/^\/v1\/governance\/alerts\/[^/]+\/remediation$/.test(p)) body = remediation;
  else if (p === "/v1/governance/remediations") body = { proposals: [] };
  else if (p === "/v1/org/settings") body = { settings: {} };
  else if (p === "/v1/pm/connections") body = { connections: [] };
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

test.beforeEach(async ({ page }) => {
  shown = approvals;
  alertsShown = [alert];
  ackRemoves = false;
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    return route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth")) ? route.continue() : mock(route);
  });
});

test("Inbox: one item layout, visible reasons, and Approve waits for a required reason", async ({ page }) => {
  await page.goto("/ui/inbox");
  await expect(page.getByText("2 waiting on you")).toBeVisible();
  // X2: the self-review explanation is a real button now, not a hover-only title
  const own = page.getByRole("button", { name: "What is Your own request?" });
  await own.click();
  await expect(page.getByRole("note")).toContainText("A recorded reason is required.");
  await page.keyboard.press("Escape");
  // the admin override names itself and explains why a reason is needed
  await expect(page.getByText("Admin override", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "What is Admin override?" }).click();
  await expect(page.getByRole("note")).toContainText("You are not the named approver, so a reason is required.");
  await page.keyboard.press("Escape");

  const row = page.locator("div").filter({ hasText: /^Governance remediation/ }).filter({ has: page.getByRole("button", { name: /^Review / }) }).last();
  // the row already says a reason is required (a chip, the sentence in its (i)); the decision opens in the shared
  // detail drawer (owner decision on #453)
  await expect(row.getByText("Reason required", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "What is Reason required?" }).click();
  await expect(page.getByRole("note")).toContainText("Deciding this approves your own request, so a reason is required.");
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: /^Review / }).click();
  const item = page.getByTestId("inbox-item");
  await expect(item.getByRole("heading", { name: /Link the human-oversight control/ })).toBeFocused();
  await expect(item.getByText("Deciding this approves your own request, so a reason is required.")).toBeVisible();
  const approve = item.getByRole("button", { name: "Approve" });
  await expect(approve).toBeDisabled();
  await item.getByRole("textbox", { name: "Decision reason" }).fill("Ada confirmed the control mapping.");
  await expect(approve).toBeEnabled();
  // Deny is a real button with an edge, not ghost text
  await expect(item.getByRole("button", { name: "Deny" })).toBeEnabled();

  // one decided item fits, so the contained card is no scroll stop (the region role appears only while it scrolls)
  // X6b: "Recently decided" is a secondary section, so it starts folded
  const decided = page.getByRole("button", { name: /^Recently decided/ });
  await expect(decided).toHaveAttribute("aria-expanded", "false");
  await decided.click();
  await expect(page.locator("section[data-rg-card]").filter({ hasText: "Recently decided" }).getByText("Retire a vendor link")).toBeVisible();
  await expect(page.getByRole("region", { name: "Recently decided, scrollable" })).toHaveCount(0);
});

test("Alert detail: path as chips, fix options labelled, acknowledgement at the bottom", async ({ page }) => {
  await page.goto("/ui/admin/governance/alerts");
  await page.getByRole("link", { name: /Credit-limit assistant inherits/ }).click();
  const detail = page.getByTestId("alert-detail");
  await expect(detail.getByRole("heading", { name: alert.title })).toBeVisible();
  await expect(detail.getByRole("list", { name: "Inherited-risk path" }).getByRole("listitem")).toHaveCount(4);
  await expect(detail.getByText("Needs approval", { exact: true })).toBeVisible();
  await expect(detail.getByText("Manual steps", { exact: true })).toBeVisible();
  const note = detail.getByLabel("Acknowledgement note — required and audited");
  await expect(note).toBeVisible();
  await expect(detail.getByRole("button", { name: "Acknowledge" })).toBeDisabled();
  await note.fill("Avery owns the response.");
  await expect(detail.getByRole("button", { name: "Acknowledge" })).toBeEnabled();
});

test("Inbox: an intake sign-off carries the tier pill and leaves its rules and copy to the review panel", async ({ page }) => {
  shown = [intakeOwn, intakeRole];
  await page.goto("/ui/inbox");
  // G2: the tier pill sits in the header of each intake item
  await expect(page.getByText("EU AI Act: high tier")).toHaveCount(2);
  // M1: no Inbox sentence that contradicts the review panel's refusal, and a role member is no admin override
  await expect(page.getByText("Deciding this approves your own request, so a reason is required.")).toHaveCount(0);
  await expect(page.getByText("You are not the named approver, so a reason is required.")).toHaveCount(0);
  await expect(page.getByText("Reason required", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Admin override", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "What is Your own request?" })).toHaveCount(0);

  await page.getByRole("button", { name: "Review sign-off for Credit-limit-increase assistant" }).click();
  await expect(page.getByText("You proposed this use case, so someone independent of it decides.")).toBeVisible();
  await page.keyboard.press("Escape");

  // the role member decides in the panel, which explains the outcomes with an (i) (L1)
  await page.getByRole("button", { name: "Review sign-off for Support drafting assistant" }).click();
  await page.getByRole("button", { name: "What is Decision outcomes?" }).click();
  await expect(page.getByRole("note")).toContainText("Your reason is stored with the decision.");
});

test("Inbox: the dry-run deploy badge explains itself with an (i), not a hover title", async ({ page }) => {
  shown = [dryRun];
  await page.goto("/ui/inbox");
  // the merge-gate evidence opens with the item in the shared detail drawer (owner decision on #453)
  await page.getByRole("button", { name: /^Review / }).first().click();
  const badge = page.getByTestId("inbox-item").getByText("deploy was a dry-run");
  await expect(badge).toBeVisible();
  await expect(badge).not.toHaveAttribute("title", /.+/);
  await page.getByRole("button", { name: "What is a dry-run deploy?" }).click();
  await expect(page.getByRole("note")).toContainText("The recorded deploy was a dry run. Nothing was actually changed.");
});

// #460 delta review (Low): pinned and the top hit at both widths, not just in the viewport at 390 px
for (const [label, size] of [["390 px", { width: 390, height: 844 }], ["1440 px", { width: 1440, height: 900 }]] as const) {
  test(`Inbox (${label}): a request with no evidence says so in the drawer, its decision row is pinned on top; one with evidence does not say so`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/ui/inbox");
    // the governance remediation carries no workflow, quorum or context conflict
    await page.locator("div").filter({ hasText: /^Governance remediation/ }).getByRole("button", { name: /^Review / }).last().click();
    const item = page.getByTestId("inbox-item");
    await expect(item.getByTestId("inbox-no-evidence")).toHaveText("No evidence attached to this request.");
    // the decision row stays pinned in the footer (ADR-0180) and nothing covers Approve
    const approve = item.getByTestId("inbox-decision").getByRole("button", { name: "Approve" });
    await expect(approve).toBeVisible();
    expect(await pinnedAfterScroll(item, approve)).toBe("pinned");
    await item.getByRole("button", { name: "Close review" }).click();

    shown = [dryRun];
    await page.goto("/ui/inbox");
    await page.getByRole("button", { name: /^Review / }).first().click();
    await expect(page.getByTestId("inbox-item").getByText("deploy was a dry-run")).toBeVisible();
    await expect(page.getByTestId("inbox-no-evidence")).toHaveCount(0);
  });
}

// #460 delta review (Low): the drawer body was blank whenever an item carried an instanceId but nothing rendered
const wfItem = (id: string, instanceId: string, objectLabel: string, objectType = "workflow") => ({ ...dryRun, id, instanceId, objectLabel, objectType });

test("Inbox: 'waiting on you' counts only the items this person can decide (D3 alerts-inbox-07)", async ({ page }) => {
  // a requester who is not an admin: their own request awaits Morgan, the remediation is theirs to decide
  for (const path of ["**/auth/me", "**/v1/me"]) {
    await page.route(path, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ userId: ME, isAdmin: false, via: "session", user: { id: ME, email: "avery@example.test", displayName: "Avery Approver" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false }) }));
  }
  shown = [approvals[0], { ...approvals[1], userId: ME, requestedByName: "Avery Approver" }];
  await page.goto("/ui/inbox");
  await expect(page.getByText("awaiting Morgan Reyes")).toBeVisible();
  await expect(page.getByText("1 waiting on you")).toBeVisible();
  await expect(page.getByText("2 waiting on you")).toHaveCount(0);
});

test("Inbox: a workflow item whose instance has nothing to show says it has no evidence", async ({ page }) => {
  // the default instance mock has no artifacts, PR, branch, checks or deploys
  shown = [wfItem("E1", "W9", "Merge the empty change")];
  await page.goto("/ui/inbox");
  await page.getByRole("button", { name: "Review Merge the empty change" }).click();
  await expect(page.getByTestId("inbox-item").getByTestId("inbox-no-evidence")).toHaveText("No evidence attached to this request.");
});

test("Inbox: an item with an instanceId the Inbox never fetches says it has no evidence", async ({ page }) => {
  shown = [wfItem("E2", "W3", "Budget overage on a workflow project", "project")];
  await page.goto("/ui/inbox");
  await page.getByRole("button", { name: "Review Budget overage on a workflow project" }).click();
  await expect(page.getByTestId("inbox-item").getByTestId("inbox-no-evidence")).toHaveText("No evidence attached to this request.");
});

test("Inbox: a failed instance read says the evidence could not be loaded, never that there is none", async ({ page }) => {
  shown = [wfItem("E3", "W8", "Merge with unreadable evidence")];
  await page.route("**/v1/workflows/instances/W8", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal" }) }));
  await page.goto("/ui/inbox");
  await page.getByRole("button", { name: "Review Merge with unreadable evidence" }).click();
  const item = page.getByTestId("inbox-item");
  // D3 alerts-inbox-08 (A15): an alert with a Retry, not a faint status line
  const failed = item.getByTestId("inbox-evidence-failed").getByRole("alert");
  await expect(failed).toContainText("Evidence could not be loaded");
  await expect(item.getByTestId("inbox-no-evidence")).toHaveCount(0);
  // Retry reads the instance again; the default mock then has nothing to show
  await page.unroute("**/v1/workflows/instances/W8");
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(item.getByTestId("inbox-no-evidence")).toHaveText("No evidence attached to this request.");
  await expect(item.getByTestId("inbox-evidence-failed")).toHaveCount(0);
});

test("Alerts: the list is a contained card with a count, and the acknowledgement stays in view beside long remediation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const many = Array.from({ length: 12 }, (_, i) => ({ kind: "assess_vendor", executable: false, title: `Manual option ${i + 1}`, rationale: "Operator-led.", params: {}, steps: ["Open the record.", "Record the evidence.", "Confirm with the owner."] }));
  await page.route("**/v1/governance/alerts/al/remediation", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...remediation, candidates: [...remediation.candidates, ...many] }) }));
  await page.goto("/ui/admin/governance/alerts");
  const list = page.locator("section[data-rg-card]").filter({ hasText: "Alerts" }).first();
  await expect(list).toContainText("1 alert");
  await page.getByRole("link", { name: /Credit-limit assistant inherits/ }).click();
  const detail = page.getByTestId("alert-detail");
  await expect(detail.getByText("Manual option 12")).toBeAttached();
  await detail.evaluate((el) => { el.scrollTop = 0; });
  // the sticky footer keeps the audited acknowledgement on screen while the options scroll beneath it
  await expect(detail.getByRole("button", { name: "Acknowledge" })).toBeInViewport();
});

test("F36: on the flush Alerts card, the list's paging line takes the header's inset, not the card's edge", async ({ page }) => {
  alertsShown = Array.from({ length: 30 }, (_, i) => ({ ...alert, id: `al${i}`, title: `Assistant ${i + 1} inherits a high rating` }));
  await page.goto("/ui/admin/governance/alerts");
  const list = page.locator("section[data-rg-card]").filter({ hasText: "Alerts" }).first();
  // ADR-0219: the list pages on the server and says where you are, never a silent cap
  const line = list.getByTestId("list-status");
  await expect(line).toHaveText(/^1–\d+ of 30$/);
  const card = await list.boundingBox();
  const textX = await line.evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().left; });
  // the line starts inside the card's padding
  expect(textX - card!.x).toBeGreaterThan(4);
});

// ---- #460 review round: M1 (L2 / ADR-0180 pinned decision row), L1 (focus after a decision), L2 (passkey line) ----

const own = (id: string, label: string, over: Record<string, unknown> = {}) => ({ id, status: "pending", objectType: "governance_remediation", stageId: "__remediation__link_control", requestedAt: ago(2), userId: "jordan", approverUserId: ME, objectLabel: label, requestedByName: "Jordan Owner", approverName: "Avery Approver", ...over });
const longText = Array.from({ length: 40 }, (_, i) => `line ${i + 1}: retention window for synthetic records`).join("\n");
const conflicted = own("C1", "Context: retention policy wording", {
  selfReview: true,
  contextConflict: { key: "retention", current: { revision: 3, content: longText, byName: "Ada Admin" }, conflicting: { revision: 4, baseRevision: 3, content: longText, byName: "Jordan Owner" } },
});

/**
 * The drawer's scroll body is scrolled to its end; then the control must sit outside every scroll box inside the
 * drawer, inside the viewport, and be the top hit at its own centre. A row moved back into the body fails the first.
 */
async function pinnedAfterScroll(drawer: Locator, control: Locator) {
  await drawer.evaluate((dialog) => {
    for (const el of dialog.querySelectorAll<HTMLElement>("*")) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight;
    }
  });
  return control.evaluate((el) => {
    const dialog = el.closest("dialog")!;
    for (let n = el.parentElement; n && n !== dialog; n = n.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return "inside a scroll box";
    }
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) return "out of view";
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && el.contains(hit) ? "pinned" : `covered by ${hit?.tagName ?? "nothing"}`;
  });
}

for (const [label, size] of [["390 px", { width: 390, height: 640 }], ["1440 px", { width: 1440, height: 600 }]] as const) {
  test(`M1 (${label}): the Inbox decision row stays pinned and on top when the drawer body is scrolled to its end`, async ({ page }) => {
    shown = [conflicted];
    await page.setViewportSize(size);
    await page.goto("/ui/inbox");
    await page.getByRole("button", { name: "Review Context: retention policy wording" }).click();
    const drawer = page.getByTestId("inbox-item");
    await expect(drawer.getByRole("button", { name: "Approve" })).toBeVisible();
    for (const control of [
      drawer.getByRole("textbox", { name: "Decision reason" }),
      drawer.getByRole("button", { name: "Deny" }),
      drawer.getByRole("button", { name: "Approve" }),
      drawer.getByText("Deciding this approves your own request, so a reason is required."),
      drawer.getByText("Approve unlocks once a reason is entered"),
    ]) expect(await pinnedAfterScroll(drawer, control)).toBe("pinned");
    // the gate is unchanged: Approve waits for the required reason
    await expect(drawer.getByRole("button", { name: "Approve" })).toBeDisabled();
    await drawer.getByRole("textbox", { name: "Decision reason" }).fill("Checked the wording with the owner.");
    await expect(drawer.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  test(`M1 (${label}): the alert's required note and Acknowledge stay pinned and on top when the drawer body is scrolled to its end`, async ({ page }) => {
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: "assess_vendor", executable: false, title: `Manual option ${i + 1}`, rationale: "Operator-led.", params: {}, steps: ["Open the record.", "Record the evidence."] }));
    await page.route("**/v1/governance/alerts/al/remediation", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...remediation, candidates: [...remediation.candidates, ...many] }) }));
    await page.setViewportSize(size);
    await page.goto("/ui/admin/governance/alerts");
    await page.getByRole("link", { name: /Credit-limit assistant inherits/ }).click();
    const drawer = page.getByTestId("alert-detail");
    await expect(drawer.getByText("Manual option 12")).toBeAttached();
    const note = drawer.getByLabel("Acknowledgement note — required and audited");
    for (const control of [note, drawer.getByRole("button", { name: "Acknowledge" })]) expect(await pinnedAfterScroll(drawer, control)).toBe("pinned");
    await expect(drawer.getByRole("button", { name: "Acknowledge" })).toBeDisabled();
    await note.fill("Avery owns the response.");
    await expect(drawer.getByRole("button", { name: "Acknowledge" })).toBeEnabled();
  });
}

const focusIsOnBody = (page: Page) => page.evaluate(() => document.activeElement === document.body);

test("L1: after an Inbox decision, focus moves to the next item's Review button, then to the page heading", async ({ page }) => {
  shown = [own("X1", "Link the oversight control"), own("X2", "Retire the old vendor link")];
  await page.goto("/ui/inbox");
  await page.getByRole("button", { name: "Review Link the oversight control" }).click();
  await page.getByTestId("inbox-item").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("inbox-item")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review Retire the old vendor link" })).toBeFocused();

  await page.getByRole("button", { name: "Review Retire the old vendor link" }).click();
  await page.getByTestId("inbox-item").getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText("Nothing waiting on you")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeFocused();
  expect(await focusIsOnBody(page)).toBe(false);
});

test("L1: after an acknowledgement removes the alert, focus moves to the alert in its place, then to the page heading", async ({ page }) => {
  alertsShown = [alert, { ...alert, id: "al2", title: "Support assistant inherits a medium rating" }];
  ackRemoves = true;
  await page.goto("/ui/admin/governance/alerts");
  await page.getByRole("link", { name: /Credit-limit assistant inherits/ }).click();
  await page.getByTestId("alert-detail").getByLabel("Acknowledgement note — required and audited").fill("Avery owns the response.");
  await page.getByTestId("alert-detail").getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByRole("link", { name: /Credit-limit assistant inherits/ })).toHaveCount(0);
  await expect(page.getByTestId("alert-detail")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Support assistant inherits/ })).toBeFocused();

  await page.getByRole("link", { name: /Support assistant inherits/ }).click();
  await page.getByTestId("alert-detail").getByLabel("Acknowledgement note — required and audited").fill("Avery owns this one too.");
  await page.getByTestId("alert-detail").getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByTestId("alert-detail")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Governance alerts" })).toBeFocused();
  expect(await focusIsOnBody(page)).toBe(false);
});

test("X6b M2: acknowledge with the drawer open: focus moves to the alert in its place, never to <body>", async ({ page }) => {
  alertsShown = [alert, { ...alert, id: "al2", title: "Support assistant inherits a medium rating" }];
  ackRemoves = true;
  await page.goto("/ui/admin/governance/alerts");
  await page.getByRole("link", { name: /Credit-limit assistant inherits/ }).click();
  // ADR-0219: the Alerts card pages on the server instead of folding, and its header still counts every alert
  await expect(page.locator("section[data-rg-card]").filter({ hasText: "Alerts" }).first()).toContainText("2 alerts");
  await page.getByTestId("alert-detail").getByLabel("Acknowledgement note — required and audited").fill("Avery owns the response.");
  await page.getByTestId("alert-detail").getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByTestId("alert-detail")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Support assistant inherits/ })).toBeFocused();
  expect(await focusIsOnBody(page)).toBe(false);
});

test("M2: an acknowledgement on the Active tab keeps the alert listed and moves focus to the drawer heading", async ({ page }) => {
  await page.goto("/ui/admin/governance/alerts");
  await page.getByRole("link", { name: /Credit-limit assistant inherits/ }).click();
  const detail = page.getByTestId("alert-detail");
  await expect(detail.getByRole("button", { name: "Acknowledge" })).toBeDisabled();
  await detail.getByLabel("Acknowledgement note — required and audited").fill("Avery owns the response.");
  await detail.getByRole("button", { name: "Acknowledge" }).click();
  await expect(detail.getByRole("button", { name: "Acknowledge" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Credit-limit assistant inherits/ })).toHaveCount(1);
  await expect(detail.getByText("Acknowledged", { exact: true })).toBeVisible();
  await expect(detail.getByRole("heading", { level: 2, name: /Credit-limit assistant inherits/ })).toBeFocused();
  expect(await focusIsOnBody(page)).toBe(false);
});

test("L2: a tool-call decision row says it signs with your passkey, next to the reason and Approve", async ({ page }) => {
  // a tool call is always a bound action, so its decision row renders in its own review dialog, not the drawer
  shown = [{
    id: "T1", status: "pending", objectType: "mcp_tool", stageId: null, requestedAt: ago(1), userId: "dana", approverUserId: ME,
    toolName: "write_file", serverId: "s-repo", serverName: "repo", requestedByName: "Dana Developer", approverName: "Avery Approver",
    argumentsDigest: "a".repeat(64), argumentsPreview: { path: "README.md", content: "hello" }, argumentsPreviewKind: "arguments_v1",
    approvalScope: "action", contextDigest: "b".repeat(64), expiresAt: new Date(NOW + 3 * 3600_000).toISOString(),
    boundTarget: { host: "repo.example.test", allowPrivateRanges: false, admissionManifestDigest: null },
    quorum: 2, signatureMode: "passkey", approvalsCount: 0, myDecision: null, decisions: [],
  }];
  await page.goto("/ui/inbox");
  await page.getByRole("button", { name: "Review action write_file" }).click();
  const dialog = page.getByRole("dialog", { name: "Review MCP action" });
  const row = dialog.locator("div").filter({ has: page.getByRole("textbox", { name: "Decision reason" }) }).filter({ has: page.getByRole("button", { name: "Approve" }) }).last();
  await expect(row.getByText("Signs with your passkey")).toBeVisible();
});
