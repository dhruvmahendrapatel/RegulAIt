/** X20: real keyboard interactions against synthetic API fixtures; no assistive-technology session claimed. */
import { expect, test, type Page } from "@playwright/test";
import { activate, tabTo, typeAt, selectAt, expectDialogTrap, escapeToTrigger } from "./keyboard-audit";
import { expectAxeClean } from "./prompts-fixtures";

async function fixture(page: Page) {
  const calls: Array<{ path: string; body: unknown }> = [];
  let releaseRule!: () => void, releaseEvaluation!: () => void;
  const ruleGate = new Promise<void>(resolve => { releaseRule = resolve; });
  const evaluationGate = new Promise<void>(resolve => { releaseEvaluation = resolve; });
  const state = { refuseRule: true, holdRule: false, holdEvaluation: false, refuseEvaluation: false };
  const users = [
    { id: "u", email: "admin@example.test", displayName: "Ada Admin", isAdmin: true, totpEnabled: true, hasPassword: true, disabledAt: null },
    { id: "d", email: "dana@example.test", displayName: "Dana Developer", isAdmin: false, totpEnabled: true, hasPassword: true, disabledAt: null },
  ];
  const me = { userId: "u", isAdmin: true, user: users[0] };
  const gets: Record<string, unknown> = {
    "/v1/users": { users }, "/v1/roles": { roles: [{ id: "r", name: "Auditor", description: "Read access", createdAt: "2026-10-01T00:00:00Z" }] },
    "/v1/teams": { teams: [{ id: "t", name: "Research", members: [], defaultClassifications: [] }] },
    "/v1/servers": { servers: [{ id: "s", name: "Records", baseUrl: "https://records.example.test", enabled: true }] },
    "/v1/servers/s/tools": { tools: [{ name: "records.read", kind: "read" }] },
    "/v1/agents": { agents: [] }, "/v1/connectors": { connectors: [] }, "/v1/projects": { projects: [] },
    "/v1/compliance/profiles": { profiles: [{ tag: "internal" }, { tag: "restricted" }] }, "/v1/roles/r/assignments": { assignments: [] },
    "/v1/roles/r/grants": { agents: [], connectors: [], tools: [], servers: [] },
    "/v1/auth/oidc-providers": { providers: [{ id: "o", name: "Example SSO", issuerUrl: "https://id.example.test", clientId: "synthetic", enabled: true, allowedEmailDomains: null }] },
    "/v1/auth/saml-providers": { providers: [] }, "/v1/auth/link-requests": { requests: [] },
    "/v1/org/settings": { settings: { passwordMinLength: 12, passwordRequireClasses: 3, sessionLifetimeHours: 12, sessionIdleMinutes: 60, mfaRequired: "off", ssoOnly: false, loginLockoutThreshold: 5, loginLockoutWindowMinutes: 15, loginLockoutMinutes: 15, localSignIn: "enabled", breakGlassUserIds: [] } },
    "/v1/interception/settings": { settings: { anthropicCompatEnabled: true, openaiCompatEnabled: true, mcpInterceptionEnabled: true, resolutionMode: "map_by_model", enforcementPosture: "observe", requireProjectAttribution: false, requireMcpAttribution: false, keyCustodyEnforced: false, streamingOnBlockMode: "suppress", strictFieldRejection: false } },
    "/v1/interception/rules": { rules: [] },
    "/v1/rules/approvals": { rules: [] }, "/v1/rules/data-scopes": { rules: [] }, "/v1/rules/rate-limits": { rules: [] },
    "/v1/policy-simulations": { simulations: [], fidelity: "Synthetic fixture" },
    "/v1/approvals": { approvals: [{ id: "ap", objectType: "workflow", objectId: "wf", stageId: "Review", approverUserId: "d", approverName: "Dana Developer", requestedByName: "Synthetic Requester", status: "pending", requestedAt: "2026-10-01T00:00:00Z" }] },
    "/v1/approvals/views": { views: [] }, "/v1/delegations": { delegations: [] },
  };
  await page.route("**/*", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!path.startsWith("/v1") && !path.startsWith("/auth"))) return route.continue();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/auth/me") return json({ ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (path === "/v1/me") return json(me);
    if (path === "/v1/me/ai-literacy") return json({ required: false, current: true, documents: [], gateMode: "enforce", noticeDays: 14 });
    if (req.method() === "GET") {
      if (gets[path]) return json(gets[path]);
      if (path.endsWith("/sessions")) return json({ sessions: [] });
      if (path.includes("revocations")) return json({ revocations: [] });
      if (path === "/v1/keys") return json({ keys: [] });
      return json({});
    }
    calls.push({ path, body: req.postData() ? req.postDataJSON() : null });
    if (path === "/v1/rules/approvals") {
      if (state.holdRule) await ruleGate;
      if (state.refuseRule) return json({ error: "invalid_rule", detail: "Choose a different approver" }, 400);
    }
    if (path === "/v1/evaluate") {
      if (state.holdEvaluation) await evaluationGate;
      if (state.refuseEvaluation) return json({ error: "internal", detail: "Synthetic evaluation refusal" }, 500);
      return json({ effect: "deny", ruleId: null, ruleChain: [], reason: "No matching grant" });
    }
    return json({ ok: true, id: "synthetic" });
  });
  return { calls, state, releaseRule, releaseEvaluation };
}

async function cancelModal(page: Page, trigger: ReturnType<Page["getByRole"]>, title: string) {
  await activate(page, trigger);
  const dialog = page.getByRole("dialog", { name: title });
  await expectDialogTrap(page, dialog);
  await expectAxeClean(page, `${title} modal`);
  await escapeToTrigger(page, dialog, trigger);
}

test("users: row activation, MFA reason validation, trap and return focus", async ({ page }) => {
  const f = await fixture(page);
  await page.goto("/ui/admin/users");
  await activate(page, page.getByRole("link", { name: "Manage Dana Developer" }));
  const trigger = page.getByRole("button", { name: "Clear MFA", exact: true });
  await activate(page, trigger);
  const dialog = page.getByRole("dialog", { name: "Clear MFA (lost authenticator)" });
  await activate(page, dialog.getByRole("button", { name: "Clear MFA", exact: true }));
  await expect(dialog.getByRole("alert")).toContainText("A reason is required");
  await expectDialogTrap(page, dialog);
  await expectAxeClean(page, "user MFA validation");
  await escapeToTrigger(page, dialog, trigger);
  await activate(page, trigger);
  await typeAt(page, dialog.getByLabel("Reason", { exact: true }), "Synthetic lost authenticator");
  await activate(page, dialog.getByRole("button", { name: "Clear MFA", exact: true }));
  await expect.poll(() => f.calls.find(c => c.path === "/v1/users/d/mfa/clear")?.body).toEqual({ reason: "Synthetic lost authenticator" });
  await expectAxeClean(page, "users lifecycle");
});

test("roles: nested delete does not also open grants; row Enter still works", async ({ page }) => {
  await fixture(page); await page.goto("/ui/admin/roles");
  const trigger = page.getByRole("button", { name: "delete", exact: true });
  await activate(page, trigger);
  const dialog = page.getByRole("dialog", { name: "Delete role “Auditor”?" });
  await expect(dialog).toBeVisible();
  await expect(page.getByText("Select a role to view and edit its grants and holders", { exact: true })).toBeVisible();
  await expectDialogTrap(page, dialog); await expectAxeClean(page, "role deletion");
  await escapeToTrigger(page, dialog, trigger);
  await activate(page, page.getByRole("link", { name: "Open grants for Auditor" }));
  await expect(page.getByText("Held by", { exact: true })).toBeVisible();
  await expectAxeClean(page, "role grants");
});

test("teams: create controls and delete modal are keyboard reachable", async ({ page }) => {
  const f = await fixture(page); await page.goto("/ui/admin/teams");
  await typeAt(page, page.getByLabel("Team name"), "Synthetic team");
  await tabTo(page, page.getByRole("listbox"));
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByRole("listbox")).toHaveValues(["internal", "restricted"]);
  await activate(page, page.getByRole("button", { name: "Create team", exact: true }));
  await expect.poll(() => f.calls.find(c => c.path === "/v1/teams")?.body).toMatchObject({ name: "Synthetic team", defaultClassifications: ["internal", "restricted"] });
  await cancelModal(page, page.getByRole("button", { name: "delete team", exact: true }), "Delete team “Research”?");
  await expectAxeClean(page, "teams");
});

test("SSO: provider deletion traps and returns focus", async ({ page }) => {
  await fixture(page); await page.goto("/ui/admin/sso");
  await cancelModal(page, page.getByRole("button", { name: "delete", exact: true }), "Delete provider “Example SSO”?");
  await expectAxeClean(page, "SSO");
});

test("client access: config generation and copy outcomes are announced", async ({ page }) => {
  await fixture(page);
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Synthetic clipboard refusal"); } } }));
  await page.goto("/ui/admin/client-access");
  await selectAt(page, page.getByLabel("MCP server", { exact: true }), "s");
  await activate(page, page.getByRole("button", { name: "Generate", exact: true }));
  await expect(page.locator('[aria-live="polite"]')).toContainText("Client configuration generated");
  await expect(page.getByTestId("client-config")).toContainText("s");
  await activate(page, page.getByRole("button", { name: "Copy", exact: true }));
  await expect(page.locator('[aria-live="polite"]')).toContainText("Clipboard unavailable");
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } }));
  await activate(page, page.getByRole("button", { name: "Copy", exact: true }));
  await expect(page.locator('[aria-live="polite"]')).toContainText("Client configuration copied");
  await expectAxeClean(page, "client access");
});

test("rules engine: native selections and server validation announce errors", async ({ page }) => {
  const f = await fixture(page); await page.goto("/ui/admin/rules");
  const card = page.locator("section[data-rg-card]").filter({ hasText: "Approval rules — pause the call for a named approver" });
  await selectAt(page, card.getByLabel("Scope", { exact: true }), "fleet");
  await selectAt(page, card.getByLabel("Servers", { exact: true }), "all");
  await selectAt(page, card.getByLabel("Approver", { exact: true }), "d");
  const submit = card.getByRole("button", { name: "Add approval rule" });
  f.state.holdRule = true;
  await activate(page, submit);
  await expect(submit).toHaveAttribute("aria-disabled", "true");
  await expect(submit).toBeFocused();
  await page.keyboard.press("Enter");
  f.releaseRule();
  await expect(card.getByRole("alert")).toContainText("Choose a different approver");
  await expect(submit).toBeFocused();
  f.state.refuseRule = false; f.state.holdRule = false; await activate(page, submit);
  await expect.poll(() => f.calls.filter(c => c.path === "/v1/rules/approvals").length).toBe(2);
  await expectAxeClean(page, "rules engine");
});

test("simulation: evaluation announces outcome while retaining keyboard focus", async ({ page }) => {
  const f = await fixture(page); await page.goto("/ui/admin/simulation");
  await selectAt(page, page.getByLabel("User", { exact: true }), "d");
  await selectAt(page, page.getByLabel("Server", { exact: true }), "s");
  await selectAt(page, page.getByLabel("Tool", { exact: true }), "records.read");
  const submit = page.getByRole("button", { name: "Evaluate", exact: true });
  f.state.holdEvaluation = true;
  await activate(page, submit);
  await expect(submit).toHaveAttribute("aria-disabled", "true");
  await expect(submit).toBeFocused();
  await page.keyboard.press("Enter");
  f.releaseEvaluation();
  await expect(page.getByRole("status").filter({ hasText: "Access preview" })).toContainText("denied");
  await expect(page.getByRole("status").filter({ hasText: "Access preview" })).toContainText("No matching grant");
  await expect(submit).toBeFocused();
  expect(f.calls.find(c => c.path === "/v1/evaluate")?.body).toEqual({ userId: "d", serverId: "s", toolName: "records.read" });
  expect(f.calls.filter(c => c.path === "/v1/evaluate")).toHaveLength(1);
  await expectAxeClean(page, "simulation");
  f.state.holdEvaluation = false; f.state.refuseEvaluation = true;
  await activate(page, submit);
  await expect(page.getByRole("alert")).toContainText("Synthetic evaluation refusal");
  await expect(page.getByRole("status").filter({ hasText: "Access preview" })).toHaveCount(0);
  await expect(submit).toBeFocused();
  await expectAxeClean(page, "simulation refusal");
});

test("approvals queue: admin override validation is announced and reason is recorded", async ({ page }) => {
  const f = await fixture(page); await page.goto("/ui/admin/approvals");
  const approve = page.getByRole("button", { name: "approve", exact: true });
  await activate(page, approve);
  await expect(page.getByRole("alert")).toContainText("override requires a recorded reason");
  await expect(approve).toBeFocused();
  await typeAt(page, page.getByLabel("Reason for Review"), "Synthetic admin override");
  await activate(page, approve);
  await expect.poll(() => f.calls.find(c => c.path.includes("/v1/approvals/ap"))?.body).toMatchObject({ reason: "Synthetic admin override" });
  await expectAxeClean(page, "approvals queue");
});
