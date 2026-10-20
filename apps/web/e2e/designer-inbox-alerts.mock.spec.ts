import { expect, test, type Route } from "@playwright/test";

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

async function mock(route: Route) {
  const p = new URL(route.request().url()).pathname;
  let body: unknown = {};
  if (p === "/auth/me") body = { userId: ME, isAdmin: true, via: "session", user: { id: ME, email: "avery@example.test", displayName: "Avery Approver" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
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
  else if (p === "/v1/governance/alerts") body = { alerts: [alert], counts: { open: 1, acknowledged: 0, resolved: 0 }, lastEvaluatedAt: ago(1), rules: [] };
  else if (p === "/v1/governance/alerts/al/remediation") body = remediation;
  else if (p === "/v1/governance/remediations") body = { proposals: [] };
  else if (p === "/v1/org/settings") body = { settings: {} };
  else if (p === "/v1/pm/connections") body = { connections: [] };
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

test.beforeEach(async ({ page }) => {
  shown = approvals;
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

  const row = page.locator("div").filter({ hasText: /^Governance remediation/ }).filter({ has: page.getByRole("button", { name: /^Review / }) }).last();
  // the row already says a reason is required; the decision opens in the shared detail drawer (owner decision on #453)
  await expect(row.getByText("Deciding this approves your own request, so a reason is required.")).toBeVisible();
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

  // the admin override names itself and explains why a reason is needed
  await expect(page.getByText("You are not the named approver, so a reason is required.")).toBeVisible();
  // one decided item fits, so the contained card is no scroll stop (the region role appears only while it scrolls)
  await expect(page.locator("section[data-rg-card]").filter({ hasText: "Recently decided" })).toContainText("Retire a vendor link");
  await expect(page.getByRole("region", { name: "Recently decided, scrollable" })).toHaveCount(0);
});

test("Alert detail: path as chips, fix options labelled, acknowledgement at the bottom", async ({ page }) => {
  await page.goto("/ui/admin/governance/alerts");
  await page.getByRole("button", { name: /Credit-limit assistant inherits/ }).click();
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

test("Alerts: the list is a contained card with a count, and the acknowledgement stays in view beside long remediation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const many = Array.from({ length: 12 }, (_, i) => ({ kind: "assess_vendor", executable: false, title: `Manual option ${i + 1}`, rationale: "Operator-led.", params: {}, steps: ["Open the record.", "Record the evidence.", "Confirm with the owner."] }));
  await page.route("**/v1/governance/alerts/al/remediation", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...remediation, candidates: [...remediation.candidates, ...many] }) }));
  await page.goto("/ui/admin/governance/alerts");
  const list = page.locator("section[data-rg-card]").filter({ hasText: "Alerts" }).first();
  await expect(list).toContainText("1 alert");
  await page.getByRole("button", { name: /Credit-limit assistant inherits/ }).click();
  const detail = page.getByTestId("alert-detail");
  await expect(detail.getByText("Manual option 12")).toBeAttached();
  await detail.evaluate((el) => { el.scrollTop = 0; });
  // the sticky footer keeps the audited acknowledgement on screen while the options scroll beneath it
  await expect(detail.getByRole("button", { name: "Acknowledge" })).toBeInViewport();
});
