/**
 * A SaaS entitlement source's guided read setup (ADR-0337 §4a, §5a; owner decision D-2026-11-22-06), from the
 * browser's side. Every /v1 and /auth call is answered by an in-test mock that follows
 * apps/gateway/src/saas-entitlement-routes.ts (the read-setup shapes for Microsoft 365 and Salesforce, 404 and 409) and
 * apps/gateway/src/discovery-routes.ts (the source PATCH with `version` and the whole `target`, the settings PUT with
 * `salesforceOrgTokens`, and `settings_relax` step-ups on widening only).
 *
 * Covered: the Read setup link on an entitlement source's row; Microsoft 365 off by default, the exact steps and the
 * consent link, "Not checked yet" after asking (never "Connected"), "Connected" only when the read says flowing;
 * Salesforce's sees/cannot-see, the two-key opt-in with its step-up, a declined step-up that changes nothing; 404;
 * a failed read with Retry; axe in light and dark. Synthetic names only.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./builder-fixtures";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const NOW = "2026-11-22T20:00:00.000Z";
const M365 = "11111111-1111-4111-8111-111111111111";
const SF = "44444444-4444-4444-8444-444444444444";
const MISSING = "55555555-5555-4555-8555-555555555555";
const CONSENT = "https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/adminconsent?client_id=33333333-3333-4333-8333-333333333333";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const STEPS = [
  { id: "add-permission", title: "Add the AuditLog.Read.All application permission", detail: "In Entra, open the app registration and add the permission." },
  { id: "grant-consent", title: "Grant admin consent", detail: "A Global Administrator grants consent for the tenant." },
  { id: "check-license", title: "Check the licence", detail: "The tenant needs Microsoft Entra ID P1 or P2." },
  { id: "turn-on", title: "Turn on the activity log for this source", detail: "Set the source's 'activityLogs' to 'on'." },
  { id: "run-and-confirm", title: "Run the source and confirm", detail: "Until the state is 'flowing', no app is judged unused." },
];

interface Opts {
  observed?: "not_enabled" | "flowing" | null;
  failSetup?: boolean;
}

async function mockApi(page: Page, opts: Opts = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const st = {
    failSetup: opts.failSetup === true,
    m365: { version: 3, target: { tenantId: "22222222-2222-4222-8222-222222222222", activityLogs: "off" } as Record<string, string> },
    sf: { version: 5, target: { instanceUrl: "https://sample.my.salesforce.com", orgId: "00D000000000001" } as Record<string, string> },
    settingsVersion: 1,
    sfSwitch: false,
  };
  const src = (id: string, name: string, kind: string, s: { version: number; target: Record<string, string> }) => ({
    id, name, kind, target: s.target, scope: { orgLevel: true, include: [] }, enabled: true, scheduleIntervalSeconds: 86400, version: s.version,
    nextRunAt: null, lastRunAt: NOW, scannerBuilt: true, credential: null, lastRun: null,
  });
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    let body: unknown = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    calls.push({ method, path: p, body });
    if (p === "/auth/me" || p === "/v1/me") {
      return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    }
    if (p === "/v1/discovery/sources" && method === "GET") {
      return json(route, {
        sources: [src(M365, "Sample tenant", "entitlement_m365", st.m365), src(SF, "Sample org", "entitlement_salesforce", st.sf)],
        posture: { sourcesTotal: 2, sourcesEnabled: [], staticCredentials: [], staleCredentials: [], writeScopeUnverified: [], credentialsRefused: [], credentialWarningAgeDays: 90, endpointRetentionDays: 90, statement: "Two sources." },
      });
    }
    const patch = p.match(/^\/v1\/discovery\/sources\/([^/]+)$/);
    if (patch && method === "PATCH") {
      const s = patch[1] === M365 ? st.m365 : st.sf;
      const b = body as { version: number; target: Record<string, string> };
      if (b.version !== s.version) return json(route, { error: "version_conflict" }, 409);
      if (patch[1] === SF && b.target.orgTokens === "on" && !st.sfSwitch) return json(route, { error: "salesforce_org_tokens_not_allowed", detail: "the org switch is off" }, 409);
      s.target = b.target;
      s.version += 1;
      return json(route, {});
    }
    if (p === "/v1/discovery/settings" && method === "PUT") {
      const b = body as { version: number; salesforceOrgTokens?: boolean };
      if (b.salesforceOrgTokens !== undefined) st.sfSwitch = b.salesforceOrgTokens;
      st.settingsVersion += 1;
    }
    if (p === "/v1/discovery/settings") return json(route, { credentialWarningAgeDays: 90, endpointRetentionDays: 90, families: { saas: true, identity: false, ml_platform: false }, salesforceOrgTokens: st.sfSwitch, version: st.settingsVersion });
    if (p === "/v1/discovery/scanners") return json(route, { kinds: [
      { kind: "entitlement_m365", label: "Microsoft 365", family: "saas", slice: "E18", evidenceKinds: ["saas_entitlement"], subjectKinds: ["app"], built: true, requiresCredential: true },
      { kind: "entitlement_salesforce", label: "Salesforce", family: "saas", slice: "E18", evidenceKinds: ["saas_entitlement"], subjectKinds: ["app"], built: true, requiresCredential: true },
    ] });
    if (p === "/v1/discovery/runs") return json(route, { items: [], nextCursor: null, nextOffset: null, total: 0, totalIsEstimate: false, failed: 0 });
    if (p === "/v1/discovery/federation") return json(route, { enabled: false, issuer: null, jwksUri: null, tokenTtlSeconds: 900, keys: [], awsPrincipal: { configured: false, roleArn: null, subject: "" }, subjectFormat: "", audiences: {} });
    const rs = p.match(/^\/v1\/discovery\/entitlements\/sources\/([^/]+)\/read-setup$/);
    if (rs) {
      if (st.failSetup) return json(route, { error: "internal_error" }, 500);
      if (rs[1] === M365) {
        const requested = st.m365.target.activityLogs === "on";
        const state = !requested ? "off" : opts.observed ? opts.observed : "not_checked";
        return json(route, {
          sourceId: M365, platform: "m365",
          activityLogs: { requested, state, permission: "AuditLog.Read.All", permissionType: "application", license: "Microsoft Entra ID P1 or P2", steps: STEPS, consentUrl: CONSENT },
          lastRead: { coverage: "app", note: "Read the tenant's app grants.", recordedAt: NOW, runId: "run-1" },
        });
      }
      if (rs[1] === SF) {
        const requested = st.sf.target.orgTokens === "on";
        const reading = requested && st.sfSwitch;
        return json(route, {
          sourceId: SF, platform: "salesforce",
          orgTokens: { requested, allowed: st.sfSwitch, permission: "Customize Application", tradeOff: "The integration user then needs Customize Application, a wide permission, and its credential is recorded as unverified, never read-only." },
          sees: ["which connected apps exist and their policies", ...(reading ? ["which users hold a token for each connected app, and when each app was last used"] : [])],
          cannotSee: reading ? ["the OAuth scopes each app was granted"] : ["which users hold a token for each connected app", "the OAuth scopes each app was granted"],
          lastRead: null,
        });
      }
      return json(route, { error: "not_found", detail: "no such discovery source" }, 404);
    }
    return json(route, {});
  });
  return { calls, st };
}

const card = (page: Page, title: string) => page.locator("[data-rg-card]").filter({ has: page.getByText(title, { exact: true }) });
const setupPath = (id: string) => `/ui/admin/shadow-ai/discovery-sources/read-setup/${id}`;

test.describe("SaaS read setup", () => {
  test("Microsoft 365: off by default, the exact steps and consent link, never connected until logs flow", async ({ page }) => {
    const { calls } = await mockApi(page);
    await page.goto("/ui/admin/shadow-ai/discovery-sources");
    await page.getByRole("row").filter({ hasText: "Sample tenant" }).getByRole("link", { name: "Read setup" }).click();
    await expect(page).toHaveURL(new RegExp(`read-setup/${M365}$`));
    await expect(page.getByRole("heading", { name: "Read setup: Sample tenant" })).toBeVisible();

    const log = card(page, "Activity log");
    await expect(log.getByText("Off", { exact: true })).toBeVisible();
    await expect(log).toContainText("AuditLog.Read.All");
    await expect(log).toContainText("Microsoft Entra ID P1 or P2");
    const checklist = card(page, "Setup checklist");
    for (const s of STEPS) await expect(checklist.getByText(s.title, { exact: true })).toBeVisible();
    const consent = checklist.getByRole("link", { name: /Open the admin consent page/ });
    await expect(consent).toHaveAttribute("href", CONSENT);
    await expect(consent).toHaveAttribute("target", "_blank");
    await expect(consent).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);
    await expectAxeClean(page, "read setup: Microsoft 365 off");

    const su = await requireStepUpOn(page, { method: "PATCH", path: `/v1/discovery/sources/${M365}`, kind: "settings_relax", when: (b) => (b as { target?: Record<string, string> })?.target?.activityLogs === "on" });
    await log.getByRole("button", { name: "Ask for the activity log" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Ask for the activity log" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ version: 3, target: { tenantId: "22222222-2222-4222-8222-222222222222", activityLogs: "on" } });
    await expect(log.getByText("Not checked yet", { exact: true })).toBeVisible();
    await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);
    expect(calls.some((c) => c.method !== "GET" && c.path.includes("read-setup"))).toBe(false);
  });

  test("Microsoft 365: not enabled while the tenant side is missing, connected only when the read saw logs flowing", async ({ page }) => {
    const first = await mockApi(page, { observed: "not_enabled" });
    first.st.m365.target.activityLogs = "on";
    await page.goto(setupPath(M365));
    await expect(card(page, "Activity log").getByText("Not enabled", { exact: true })).toBeVisible();
    await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    const second = await mockApi(page, { observed: "flowing" });
    second.st.m365.target.activityLogs = "on";
    await page.reload();
    await expect(card(page, "Activity log").getByText("Connected", { exact: true })).toBeVisible();
  });

  test("Salesforce: says what it cannot see, and the two-key opt-in is a step-up; a declined step-up changes nothing", async ({ page }) => {
    const { st } = await mockApi(page);
    await page.goto(setupPath(SF));
    await expect(page.getByRole("heading", { name: "Read setup: Sample org" })).toBeVisible();
    await expect(card(page, "What it cannot see")).toContainText("which users hold a token for each connected app");
    const tokens = card(page, "Org-wide token read");
    await expect(tokens).toContainText("recorded as unverified, never read-only");
    const perSource = tokens.getByRole("button", { name: "Read tokens for this source" });
    await expect(perSource).toHaveAttribute("aria-disabled", "true");
    await expect(tokens.getByText("Allow org-wide token reads first.")).toBeVisible();
    await expectAxeClean(page, "read setup: Salesforce default");

    // declined: nothing changes
    await requireStepUpOn(page, { method: "PUT", path: "/v1/discovery/settings", kind: "settings_relax", when: (b) => (b as { salesforceOrgTokens?: boolean })?.salesforceOrgTokens === true });
    await tokens.getByRole("button", { name: "Allow org-wide token reads" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Allow org-wide token reads" }).click();
    await page.getByRole("dialog", { name: "Confirm it's you" }).getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Nothing changed" })).toBeVisible();
    expect(st.sfSwitch).toBe(false);

    // confirmed: the switch, then the source's own request
    await page.getByRole("button", { name: "Try again" }).click();
    await confirmStepUp(page);
    await expect(tokens.getByText("allowed", { exact: true })).toBeVisible();
    expect(st.sfSwitch).toBe(true);
    await requireStepUpOn(page, { method: "PATCH", path: `/v1/discovery/sources/${SF}`, kind: "settings_relax", when: (b) => (b as { target?: Record<string, string> })?.target?.orgTokens === "on" });
    await perSource.click();
    await page.getByRole("dialog").getByRole("button", { name: "Read org-wide tokens" }).click();
    await confirmStepUp(page);
    await expect(tokens.getByText("On for this source", { exact: true })).toBeVisible();
    await expect(card(page, "What the default read sees")).toContainText("when each app was last used");
    expect(st.sf.target).toEqual({ instanceUrl: "https://sample.my.salesforce.com", orgId: "00D000000000001", orgTokens: "on" });
  });

  test("an unknown source says so, and a failed read is an error with Retry", async ({ page }) => {
    const { st } = await mockApi(page, { failSetup: true });
    await page.goto(setupPath(M365));
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Off", { exact: true })).toHaveCount(0);
    st.failSetup = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(card(page, "Activity log")).toBeVisible();

    await page.goto(setupPath(MISSING));
    await expect(page.getByText("No such source", { exact: true })).toBeVisible();
  });
});
