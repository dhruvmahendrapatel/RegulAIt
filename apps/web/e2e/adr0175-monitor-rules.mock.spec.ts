/**
 * ADR-0175 A4 / A9 — the alerts screen shows the two new rules' subjects and
 * the "register as use case" remediation as a link into the existing register
 * flow, prefilled from the alert. Mocked API; no screenshots.
 */
import { expect, test, type Route } from "@playwright/test";

const PROJECT = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";
const registerHref =
  "/admin/governance/intake?" +
  new URLSearchParams({
    source: "monitor",
    title: "AI use in project Claims triage",
    description: "Observed by the governance monitor: 12 model calls in 7 days attributed to project Claims triage, which no approved use case links.",
  }).toString();

const base = { firstDetectedAt: "2026-10-03T10:00:00Z", lastDetectedAt: "2026-10-03T12:00:00Z", acknowledgedAt: null, acknowledgedBy: null, ackNote: null, resolvedAt: null, status: "open" };
const alerts = {
  alerts: [
    {
      ...base,
      id: "traffic",
      ruleId: "unregistered_ai_traffic",
      ruleLabel: "AI traffic no approved use case covers",
      severity: "medium",
      subject: { key: `project:${PROJECT}`, type: "project", id: PROJECT, label: "Claims triage", context: null },
      title: "Project Claims triage: 12 model calls in 7 days, no approved use case links this project",
      detail: {},
    },
    {
      ...base,
      id: "drift",
      ruleId: "served_model_drift",
      ruleLabel: "Provider served a different model than configured",
      severity: "medium",
      subject: { key: `agent:${AGENT}`, type: "agent", id: AGENT, label: "Claims assistant", context: null },
      title: "Claims assistant was served model-b instead of its configured model-a on 3 calls",
      detail: {},
    },
  ],
  counts: { open: 2, acknowledged: 0, resolved: 0 },
  lastEvaluatedAt: "2026-10-03T12:00:00Z",
  rules: [],
};
const remediation = (id: string) =>
  id === "traffic"
    ? {
        alert: { id, ruleId: "unregistered_ai_traffic", status: "open", title: alerts.alerts[0]!.title },
        candidates: [
          {
            kind: "register_use_case",
            executable: false,
            title: "Register project Claims triage's AI use as a use case",
            rationale: "12 model calls ran outside every approved use case.",
            params: { projectId: PROJECT },
            steps: ["Open the register flow (prefilled from this alert) and describe what the traffic is for."],
            href: registerHref,
          },
        ],
        proposals: [],
        note: "Guidance only.",
      }
    : {
        alert: { id, ruleId: "served_model_drift", status: "open", title: alerts.alerts[1]!.title },
        candidates: [
          {
            kind: "review_served_model",
            executable: false,
            title: "Confirm why Claims assistant was served model-b",
            rationale: "The provider reported serving a different model than the agent is configured for.",
            params: { agentId: AGENT },
            steps: ["Compare the served and configured ids on the alert."],
          },
        ],
        proposals: [],
        note: "Guidance only.",
      };

async function mock(route: Route) {
  const p = new URL(route.request().url()).pathname;
  let body: unknown = {};
  if (p === "/auth/me") body = { userId: "u", isAdmin: true, via: "session", user: { id: "u", email: "admin@example.test", displayName: "Avery Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
  else if (p === "/v1/me") body = { userId: "u", isAdmin: true, user: { id: "u", email: "admin@example.test", displayName: "Avery Admin" } };
  else if (p === "/v1/users") body = { users: [{ id: "u", email: "admin@example.test", displayName: "Avery Admin" }] };
  else if (p === "/v1/governance/alerts") body = alerts;
  else if (p === "/v1/governance/alerts/traffic/remediation") body = remediation("traffic");
  else if (p === "/v1/governance/alerts/drift/remediation") body = remediation("drift");
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    return route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth")) ? route.continue() : mock(route);
  });
});

test("unregistered AI traffic: the project subject links to the project and the remediation opens the register flow, prefilled", async ({ page }) => {
  await page.goto("/ui/admin/governance/alerts");
  await page.getByRole("button", { name: /Project Claims triage: 12 model calls/ }).click();
  const detail = page.getByTestId("alert-detail");
  await expect(detail.getByRole("link", { name: "Open project" })).toHaveAttribute("href", `/ui/projects/${PROJECT}`);
  const register = detail.getByRole("link", { name: "Register as use case" });
  await expect(register).toBeVisible();
  const href = new URL((await register.getAttribute("href"))!, "http://x");
  expect(href.pathname).toBe("/ui/admin/governance/intake");
  expect(href.searchParams.get("source")).toBe("monitor");
  expect(href.searchParams.get("title")).toBe("AI use in project Claims triage");
});

test("served-model drift: guidance only, the agent subject links to the agent", async ({ page }) => {
  await page.goto("/ui/admin/governance/alerts");
  await page.getByRole("button", { name: /Claims assistant was served model-b/ }).click();
  const detail = page.getByTestId("alert-detail");
  await expect(detail.getByText("Confirm why Claims assistant was served model-b")).toBeVisible();
  await expect(detail.getByRole("link", { name: "Open agent" })).toHaveAttribute("href", `/ui/admin/agents#agent-${AGENT}`);
  await expect(detail.getByRole("link", { name: "Register as use case" })).toHaveCount(0);
});
