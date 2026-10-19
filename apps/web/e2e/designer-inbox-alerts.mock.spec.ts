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
  else if (p === "/v1/approvals") body = { approvals };
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

  const item = page.locator("div").filter({ hasText: /^Governance remediation/ }).filter({ has: page.getByRole("button", { name: "Approve" }) }).last();
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
