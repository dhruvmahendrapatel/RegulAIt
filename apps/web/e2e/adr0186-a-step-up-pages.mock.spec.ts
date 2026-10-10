/**
 * ADR-0186 A — the per-scope and halt-lifting writes go through withStepUp, on
 * every screen that makes them (against a mocked gateway): the execution mode
 * (resuming from a halt), lifting one agent's halt, a per-object guardrail
 * override, and a rule's deploy-mode scope. Each: the first request is refused
 * 403 `step_up_required`, the "Confirm it's you" dialog opens once, a mocked
 * verify returns a grant, and the SAME request is resent once with
 * `x-regulait-step-up` and succeeds (`e2e/step-up-harness.ts`).
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ISO = "2026-10-07T10:00:00.000Z";
const AGENT = { id: "11111111-1111-4111-8111-111111111111", name: "Claims bot", provider: "mock", tier: 1, enabled: true };

async function mockApi(page: Page) {
  const me = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "avery@example.test", displayName: "Avery Admin" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/agents") return json(route, { agents: [AGENT] });
    if (p === "/v1/connectors") return json(route, { connectors: [] });
    if (p === "/v1/projects") return json(route, { projects: [] });
    if (p === "/v1/users") return json(route, { users: [] });
    if (p === "/v1/servers") return json(route, { servers: [] });
    // execution control
    if (p === "/v1/execution") {
      return json(route, {
        mode: "halted",
        meaning: "Every governed call is refused.",
        reason: "incident drill",
        setAt: ISO,
        setByUserId: "u-admin",
        haltedAgents: [{ id: AGENT.id, name: AGENT.name, haltedAt: ISO, reason: "incident drill" }],
        haltedTools: [],
        summary: "Execution is halted",
        note: "",
        scheduledSweepsNote: "",
      });
    }
    if (p === "/v1/execution/mode" && method === "PUT") return json(route, { mode: "normal", changed: true });
    if (p === `/v1/agents/${AGENT.id}/unhalt` && method === "POST") return json(route, { agentId: AGENT.id, halted: false, changed: true });
    // guardrails
    if (p === "/v1/guardrails/detectors") {
      return json(route, {
        detectors: [{ id: "prompt_injection", tier: "rules", phases: ["input"], summary: "Prompt injection", limits: "", ruleCount: 1, configurable: true }],
        shippedDefaults: { prompt_injection: "block" },
        note: "",
      });
    }
    if (p === "/v1/guardrails/config" && method === "GET") {
      return json(route, { org: null, orgModes: { prompt_injection: "block" }, shippedDefaults: { prompt_injection: "block" }, overrides: [] });
    }
    if (p === `/v1/guardrails/config/agent/${AGENT.id}` && method === "PUT") return json(route, { config: {}, modes: { prompt_injection: "warn" } });
    if (p.startsWith("/v1/guardrails/violations")) return json(route, { violations: [], totals: {}, note: "" });
    // rules engine
    if (p === "/v1/rules/approvals" && method === "GET") {
      return json(route, {
        rules: [{ id: "r-approve", scope: "fleet", serverScope: "all", toolName: "deploy_prod", deployMode: null, createdAt: ISO, approverUserId: "u-admin" }],
      });
    }
    if (p === "/v1/rules/data-scopes" || p === "/v1/rules/rate-limits") return json(route, { rules: [] });
    if (p === "/v1/rules/approvals/r-approve/deploy-mode" && method === "PATCH") return json(route, { id: "r-approve", deployMode: "byoc", versionMinted: null });
    return json(route, {});
  });
}

test.describe("ADR-0186 A: per-scope and halt-lifting writes resend once through step-up", () => {
  test("execution control: resuming from a halt asks to confirm it's you and resends the same PUT once", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/execution/mode", kind: "settings_relax", facts: (b) => ({ values: { executionMode: (b as { mode: string }).mode } }) });
    await page.goto("/ui/admin/execution");
    await page.getByRole("button", { name: "Resume" }).first().click();
    const modal = page.getByRole("dialog", { name: "Resume normal execution" });
    await modal.getByLabel("Reason").fill("incident closed, verified safe to resume");
    await modal.getByRole("button", { name: "Resume" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toMatchObject({ mode: "normal" });
  });

  test("execution control: lifting one agent's halt asks to confirm it's you and resends the same POST once", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "POST", path: `/v1/agents/${AGENT.id}/unhalt`, kind: "settings_relax", facts: () => ({ agentId: AGENT.id, values: { halted: false } }) });
    await page.goto("/ui/admin/execution");
    await page.getByRole("button", { name: "Lift" }).first().click();
    const modal = page.getByRole("dialog", { name: `Lift the halt on ${AGENT.name}` });
    await modal.getByLabel("Reason").fill("root cause fixed and redeployed");
    await modal.getByRole("button", { name: "Lift halt" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
  });

  test("guardrails: a per-agent override below the org mode asks to confirm it's you and resends the same PUT once", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: `/v1/guardrails/config/agent/${AGENT.id}`, kind: "settings_relax", facts: (b) => ({ scope: "agent", scopeId: AGENT.id, values: (b as { modes: object }).modes as Record<string, unknown> }) });
    await page.goto("/ui/admin/guardrails");
    const form = page.locator("form", { has: page.getByRole("button", { name: "Save override" }) });
    await form.getByLabel("Target").selectOption(AGENT.id);
    await form.getByLabel("prompt injection").selectOption("warn");
    await form.getByRole("button", { name: "Save override" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ modes: { prompt_injection: "warn" } });
  });

  test("rules engine: narrowing a rule's deploy-mode scope asks to confirm it's you and resends the same PATCH once", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PATCH", path: "/v1/rules/approvals/r-approve/deploy-mode", kind: "settings_relax", facts: (b) => ({ ruleKind: "approvals", ruleId: "r-approve", values: b as Record<string, unknown> }) });
    await page.goto("/ui/admin/rules");
    await page.getByTestId("deploy-mode-r-approve").selectOption("byoc");
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ deployMode: "byoc" });
  });
});
