/**
 * U3 settings batch: the org settings that had no control, now a row each on
 * the page they belong to (OrgSettingsCard). Against a mocked gateway that
 * answers `GET/PUT /v1/org/settings` with the live shape.
 *
 * What these pin:
 *  - every card renders the stored value of each of its settings and the
 *    strict default beside it;
 *  - a save sends ONLY the edited key, exactly the value the dialog showed;
 *  - a relaxation says what gets weaker and that a step-up follows, and goes
 *    through the step-up (settings_relax) before it is resent once;
 *  - tightening asks for no step-up;
 *  - a refusal is shown under its row in the gateway's own words;
 *  - unreadable settings: no control is shown prefilled; a mistyped stored
 *    value is "unknown" and its control is disabled.
 * Axe (light and dark) on the card and on the dialog.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000c3`;
const AUTH = { userId: U(99), isAdmin: true, via: "session", user: { id: U(99), email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };

/** every setting these cards edit, at its strict default */
export const STRICT_SETTINGS: Record<string, unknown> = {
  approvalSignatureMode: "passkey",
  stepUpMode: "required",
  stepUpMaxAgeSeconds: 120,
  stepUpActions: ["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage", "pseudonym_reveal", "key_management"],
  toolApprovalSensitiveQuorum: 2,
  decisionReceiptsMode: "on",
  auditAnchorTimestampMode: "required",
  vendoredDetectionPacks: ["pipelock-secrets", "pipelock-normalise", "nemo-yara-injection", "agt-mcp-heuristics"],
  outboundCredentialAudience: "enforce",
  engineMaxRunTimeoutMinutes: 30,
  engineDefaultRunBudgetUsd: 2,
  engineRunApprovalThresholdUsd: 10,
  engineRawReportRetentionDays: 90,
  engineSensitiveSetApproval: true,
  modelArtifactUploaderQuotaMegabytes: 2048,
  modelArtifactUploaderQuotaCount: 20,
  modelArtifactOrgQuotaMegabytes: 20480,
  modelArtifactOrgQuotaCount: 200,
  agentEntitlementMode: "own_grants",
  delegatedTokenTtlSeconds: 300,
  delegationMaxDepth: 3,
  workloadClientAuthMethods: ["private_key_jwt", "tls_client_auth", "self_signed_tls_client_auth", "spiffe_svid"],
  dpopNonceRequired: true,
  workloadKeyMaxAgeDays: 90,
  delegationUncappedRootAllowed: false,
  delegationRootDefaultCapMicros: 0,
  delegationRootMaxLifetimeSeconds: 900,
  piiInternationalCategories: [],
  modeAuditRetention: {},
  canaryObservationRetentionDays: 90,
  backupVerifyEnabled: true,
  backupVerifyIntervalHours: 24,
  mcpAdmissionMode: "enforce",
  apiKeyDefaultTtlDays: 90,
  apiKeyMaxTtlDays: 365,
  approvalTtlHours: 72,
  approvalBulkMaxItems: 25,
  approvalBulkSensitiveBlocked: true,
  mrmExpiryWarnDays: 30,
};

interface Scenario {
  settings: Record<string, unknown> | null;
  /** answers to PUT /v1/org/settings, in order; default: merge and echo */
  putAnswers: Array<{ status: number; body: Json }>;
  calls: Array<{ method: string; path: string; body: Json }>;
}

async function mockApi(page: Page, over: Partial<Scenario> = {}): Promise<Scenario> {
  const st: Scenario = { settings: { ...STRICT_SETTINGS }, putAnswers: [], calls: [], ...over };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    let body: Json;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    st.calls.push({ method, path: p + url.search, body });
    if (p === "/auth/me" || p === "/v1/me") return json(route, AUTH);
    if (p === "/v1/org/settings" && method === "GET") {
      if (st.settings === null) return json(route, { error: "internal", detail: "the settings could not be read" }, 500);
      return json(route, { settings: st.settings });
    }
    if (p === "/v1/org/settings" && method === "PUT") {
      const next = st.putAnswers.shift();
      if (next && next.status !== 200) return json(route, next.body, next.status);
      Object.assign(st.settings ?? {}, body);
      return json(route, { settings: st.settings });
    }
    if (p === "/v1/users") return json(route, { users: [{ id: U(99), displayName: "Ada Admin", email: "ada@example.test", isAdmin: true, disabledAt: null, hasPassword: true, totpEnabled: true }] });
    if (p === "/v1/keys") return json(route, { keys: [] });
    if (p === "/v1/workload-identities") return json(route, { items: [], nextCursor: null });
    if (p === "/v1/org/posture") {
      return json(route, {
        hardened: true, summary: { enforcementSatisfied: 0, enforcementTotal: 0, optimisationSatisfied: 0, optimisationTotal: 0, blockedByEnvironment: [] }, controls: [],
        execution: { mode: "normal", reason: null, setAt: null, restricted: false, note: "Executing normally." },
        receiptSigningKey: { state: "install_generated", keyId: "receipt-2026", publicKeyFingerprint: "ab:cd", publicKeys: "/v1/receipts/keys", note: "Install-generated key." },
      });
    }
    return json(route, {});
  });
  return st;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string, include?: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      const finite = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
      await Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 1_000))]);
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
    if (include) builder = builder.include(include);
    const results = await builder.analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

const puts = (st: Scenario) => st.calls.filter((c) => c.method === "PUT" && c.path === "/v1/org/settings").map((c) => c.body);

test.describe("U3: approval safeguards on Organization", () => {
  test("relaxing the approval lifetime to never says what is weaker, steps up, and sends only that key", async ({ page }) => {
    const st = await mockApi(page);
    await page.goto("/ui/admin/organization");
    const card = page.getByTestId("org-approval-safeguards");
    const row = card.getByTestId("org-setting-approvalTtlHours");
    await expect(row.getByLabel("Approved tool-call lifetime (hours)")).toHaveValue("72");
    await expect(row.getByText("strict", { exact: true })).toBeVisible();
    await expectAxeClean(page, "approval safeguards", '[data-testid="org-approval-safeguards"]');
    const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/org/settings", kind: "settings_relax" });
    await row.getByLabel("Never expires").check();
    await row.getByRole("button", { name: "Review change" }).click();
    const dialog = page.getByRole("dialog", { name: "Change approved tool-call lifetime (hours)?" });
    await expect(dialog).toContainText("72 hours → Never expires");
    await expect(dialog).toContainText("This is weaker than the strict default.");
    await expect(dialog).toContainText("you will be asked to confirm it's you");
    await expectAxeClean(page, "relax dialog");
    await dialog.getByRole("button", { name: "Relax setting" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    await expect(dialog).toBeHidden();
    // the refused attempt is answered by the step-up harness; the mock sees the one resend
    expect(puts(st)).toEqual([{ approvalTtlHours: null }]);
    await expect(row.getByText("relaxed (audited)")).toBeVisible();
  });

  test("tightening the bulk cap asks for no step-up and sends only that key", async ({ page }) => {
    const st = await mockApi(page);
    await page.goto("/ui/admin/organization");
    const row = page.getByTestId("org-setting-approvalBulkMaxItems");
    await row.getByLabel("Most approvals in one bulk action").fill("10");
    await row.getByRole("button", { name: "Review change" }).click();
    const dialog = page.getByRole("dialog", { name: "Change most approvals in one bulk action?" });
    await expect(dialog).toContainText("25 approvals → 10 approvals");
    await expect(dialog).toContainText("10 approvals is at least as strict as the strict default (25 approvals).");
    await expect(dialog).not.toContainText("confirm it's you");
    await dialog.getByRole("button", { name: "Save setting" }).click();
    await expect(dialog).toBeHidden();
    expect(puts(st)).toEqual([{ approvalBulkMaxItems: 10 }]);
  });

  test("an out-of-range value cannot be submitted and says why", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/organization");
    const row = page.getByTestId("org-setting-toolApprovalSensitiveQuorum");
    const input = row.getByLabel("Approvers for calls on sensitive data");
    await input.fill("9");
    await expect(row.getByText("Enter a whole number from 1 to 5.")).toBeVisible();
    await expect(input).toHaveAttribute("aria-describedby", /org-setting-toolApprovalSensitiveQuorum-problem/);
    await expect(row.getByRole("button", { name: "Review change" })).toBeDisabled();
  });
});

test.describe("U3: unreadable settings are never prefilled", () => {
  test("a failed read shows the error and no control", async ({ page }) => {
    await mockApi(page, { settings: null });
    await page.goto("/ui/admin/retention");
    const card = page.getByTestId("audit-evidence-retention");
    await expect(card.getByText("the settings could not be read").first()).toBeVisible();
    await expect(card.getByLabel("Shadow-canary evidence retention (days)")).toHaveCount(0);
  });

  test("a mistyped stored value is unknown, and its control is disabled", async ({ page }) => {
    await mockApi(page, { settings: { ...STRICT_SETTINGS, canaryObservationRetentionDays: "90" } });
    await page.goto("/ui/admin/retention");
    const row = page.getByTestId("org-setting-canaryObservationRetentionDays");
    await expect(row.getByText("unknown", { exact: true })).toBeVisible();
    await expect(row.getByLabel("Shadow-canary evidence retention (days)")).toBeDisabled();
    await expect(row.getByLabel("Shadow-canary evidence retention (days)")).toHaveValue("");
    await expect(row.getByRole("button", { name: "Review change" })).toBeDisabled();
  });
});

test.describe("U3: each page carries its settings", () => {
  const PAGES: Array<{ path: string; card: string; keys: string[] }> = [
    { path: "/ui/admin/organization", card: "org-pii-international", keys: ["piiInternationalCategories"] },
    { path: "/ui/admin/sso", card: "sso-step-up-settings", keys: ["stepUpMode", "stepUpMaxAgeSeconds", "stepUpActions"] },
    { path: "/ui/admin/enforcement-posture", card: "evidence-detection-settings", keys: ["decisionReceiptsMode", "auditAnchorTimestampMode", "vendoredDetectionPacks", "outboundCredentialAudience"] },
    { path: "/ui/admin/retention", card: "audit-evidence-retention", keys: ["modeAuditRetention", "canaryObservationRetentionDays"] },
    { path: "/ui/admin/admission", card: "mcp-admission-mode", keys: ["mcpAdmissionMode"] },
    { path: "/ui/admin/infrastructure", card: "backup-verify-settings", keys: ["backupVerifyEnabled", "backupVerifyIntervalHours"] },
    { path: "/ui/admin/users", card: "api-key-lifetimes", keys: ["apiKeyDefaultTtlDays", "apiKeyMaxTtlDays"] },
    { path: "/ui/admin/engines", card: "engine-run-limits", keys: ["engineMaxRunTimeoutMinutes", "engineDefaultRunBudgetUsd", "engineRunApprovalThresholdUsd", "engineRawReportRetentionDays", "engineSensitiveSetApproval"] },
    { path: "/ui/admin/engines", card: "model-artifact-quotas", keys: ["modelArtifactUploaderQuotaMegabytes", "modelArtifactUploaderQuotaCount", "modelArtifactOrgQuotaMegabytes", "modelArtifactOrgQuotaCount"] },
    {
      path: "/ui/admin/workload-identities",
      card: "identity-delegation-settings",
      keys: ["agentEntitlementMode", "delegatedTokenTtlSeconds", "delegationMaxDepth", "workloadClientAuthMethods", "dpopNonceRequired", "workloadKeyMaxAgeDays", "delegationUncappedRootAllowed", "delegationRootDefaultCapMicros", "delegationRootMaxLifetimeSeconds"],
    },
    { path: "/ui/admin/model-risk", card: "mrm-expiry-warn", keys: ["mrmExpiryWarnDays"] },
  ];
  for (const pg of PAGES) {
    test(`${pg.path}: ${pg.card}`, async ({ page }) => {
      await mockApi(page);
      await page.goto(pg.path);
      const card = page.getByTestId(pg.card);
      for (const key of pg.keys) {
        const row = card.getByTestId(`org-setting-${key}`);
        await expect(row, key).toBeVisible();
        await expect(row.getByText("strict", { exact: true }), key).toBeVisible();
      }
      await expectAxeClean(page, pg.card, `[data-testid="${pg.card}"]`);
    });
  }

  test("API key lifetimes: a refusal is shown under its row in the gateway's words", async ({ page }) => {
    const st = await mockApi(page, {
      putAnswers: [
        {
          status: 422,
          body: {
            error: "api_key_ttl_ordering",
            detail: "apiKeyDefaultTtlDays (400) cannot exceed apiKeyMaxTtlDays (365) — every key issued with no explicit expiry would be refused by the ceiling it was given. Nothing was saved.",
          },
        },
      ],
    });
    await page.goto("/ui/admin/users");
    const row = page.getByTestId("org-setting-apiKeyDefaultTtlDays");
    await row.getByLabel("Default API key lifetime (days)").fill("400");
    await row.getByRole("button", { name: "Review change" }).click();
    await page.getByRole("dialog", { name: "Change default api key lifetime (days)?" }).getByRole("button", { name: "Relax setting" }).click();
    await expect(row.getByRole("alert")).toContainText("cannot exceed apiKeyMaxTtlDays");
    expect(puts(st)).toEqual([{ apiKeyDefaultTtlDays: 400 }]);
  });

  test("step-up actions: unticking one is a relaxation; the list is sent in vocabulary order", async ({ page }) => {
    const st = await mockApi(page);
    await page.goto("/ui/admin/sso");
    const row = page.getByTestId("org-setting-stepUpActions");
    await row.getByLabel("Managing passkeys").uncheck();
    await row.getByRole("button", { name: "Review change" }).click();
    const dialog = page.getByRole("dialog", { name: "Change actions that need a step-up?" });
    await expect(dialog).toContainText("Each action removed from the list can be done with the session alone.");
    await dialog.getByRole("button", { name: "Relax setting" }).click();
    await expect(dialog).toBeHidden();
    expect(puts(st)).toEqual([{ stepUpActions: ["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "owner_change", "identity_manage", "pseudonym_reveal", "key_management"] }]);
  });

  test("audit retention per mode: an override is sent as a map; empty modes are left out", async ({ page }) => {
    const st = await mockApi(page);
    await page.goto("/ui/admin/retention");
    const row = page.getByTestId("org-setting-modeAuditRetention");
    await row.getByLabel("Air-gapped (days, empty = follow the floor)").fill("730");
    await row.getByRole("button", { name: "Review change" }).click();
    const dialog = page.getByRole("dialog", { name: "Change audit retention per deploy mode (days)?" });
    await expect(dialog).toContainText("no overrides → Air-gapped: 730 days");
    await dialog.getByRole("button", { name: "Save setting" }).click();
    await expect(dialog).toBeHidden();
    expect(puts(st)).toEqual([{ modeAuditRetention: { air_gapped: 730 } }]);
  });
});
