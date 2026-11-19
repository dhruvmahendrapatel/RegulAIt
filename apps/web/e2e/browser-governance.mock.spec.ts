/**
 * ADR-0334 (lane E16, D5; owner-approved on #453) — the Browser governance page against a mocked gateway:
 *
 *  - every section renders (mode, governed sites, enrolment tokens, enrolled browsers, breach events);
 *  - a relaxing mode change asks to confirm it's you and resends the same PUT once; allowing a site does too, and
 *    denying one goes straight through;
 *  - an enrolment token and its managed-storage config are shown once, and gone when the dialog closes;
 *  - revealing a captured prompt goes through the `pseudonym_reveal` step-up;
 *  - axe (WCAG 2.x A/AA) clean in light and dark.
 *
 * Synthetic data only: neutral site labels, `.example` hosts, pseudonyms.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

type Json = Record<string, unknown>;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const ahead = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const id = (p: string, i: number) => `${p}-0000-4000-8000-${String(i).padStart(12, "0")}`;
const ME = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "ada@example.test", displayName: "Ada Admin" } };

const SETTINGS = {
  enabled: true,
  mode: "enforce",
  promptCaptureEnabled: false,
  promptCaptureRetentionDays: 30,
  updatedAt: ago(5),
  policySigner: { state: "ok", source: "install_generated", activeKeyId: "device-policy-0123456789abcdef01234567", publishedKeys: [{ keyId: "device-policy-0123456789abcdef01234567", x: "Qm3xSyntheticPublicKeyValue9Kp2" }] },
};
const SITES = [
  { siteId: "ep-site-a", host: "chat.site-a.example", provider: "provider-a", decision: "allow", effective: "allow", accountDomains: ["corp.example"] },
  { siteId: "ep-site-b", host: "code.site-b.example", provider: "provider-b", decision: "allow", effective: "allow", accountDomains: [] },
  { siteId: "ep-site-c", host: "img.site-c.example", provider: "provider-c", decision: null, effective: "deny", accountDomains: [] },
];
const TOKENS = [
  { tokenId: id("61000000", 1), label: "Finance laptops", deviceCap: 50, devicesEnrolled: 38, devicesActive: 37, expiresAt: ahead(24 * 20), revokedAt: null, createdAt: ago(48) },
  { tokenId: id("61000000", 2), label: "Pilot group", deviceCap: 10, devicesEnrolled: 9, devicesActive: 9, expiresAt: ahead(24 * 5), revokedAt: ago(10), createdAt: ago(96) },
];
const DEVICES = [
  { deviceId: id("62000000", 1), tokenId: TOKENS[0]!.tokenId, os: "win", browserMajor: 131, extensionVersion: "0.9.2", bound: true, boundSubject: "psn:usr00000000000000000031", boundAt: ago(40), registeredAt: ago(40), lastSeenAt: ago(1), revokedAt: null },
  { deviceId: id("62000000", 2), tokenId: TOKENS[0]!.tokenId, os: "mac", browserMajor: 131, extensionVersion: "0.9.2", bound: false, boundSubject: null, boundAt: null, registeredAt: ago(30), lastSeenAt: null, revokedAt: null },
];
const EVENTS = [
  { id: id("63000000", 1), deviceId: DEVICES[0]!.deviceId, kind: "account_blocked", outcome: "blocked", code: "account_not_allowed", siteId: "ep-site-a", ruleIds: [], subject: "psn:usr00000000000000000031", attribution: "device_asserted", conversationRef: null, occurredAt: ago(2), receivedAt: ago(2), auditId: id("64000000", 1) },
  { id: id("63000000", 2), deviceId: DEVICES[0]!.deviceId, kind: "dlp_blocked", outcome: "would_block", code: "dlp_match", siteId: "ep-site-b", ruleIds: ["dlp.secret.aws_key"], subject: "psn:usr00000000000000000012", attribution: "device_asserted", conversationRef: "cnv:0000", occurredAt: ago(3), receivedAt: ago(3), auditId: id("64000000", 2) },
  { id: id("63000000", 3), deviceId: DEVICES[0]!.deviceId, kind: "site_blocked", outcome: "blocked", code: "no_site_rule", siteId: "ep-site-c", ruleIds: [], subject: "psn:usr00000000000000000044", attribution: "device_asserted", conversationRef: null, occurredAt: ago(4), receivedAt: ago(4), auditId: id("64000000", 3) },
];
const CAPTURE_ID = id("65000000", 1);
const SECRET = `rgbe_${"ab".repeat(32)}`;

function page(rows: Json[], q: URLSearchParams) {
  const limit = Number(q.get("limit") ?? 10);
  const start = Number(q.get("offset") ?? 0);
  return { items: rows.slice(start, start + limit), nextCursor: null, nextOffset: start + limit < rows.length ? start + limit : null, total: rows.length, totalIsEstimate: false };
}

async function mockApi(p: Page) {
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  await p.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (req.resourceType() === "document" || (!path.startsWith("/v1") && !path.startsWith("/auth"))) return route.continue();
    if (path === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (path === "/v1/me") return json(route, ME);
    const method = req.method();
    if (method !== "GET") {
      let body: unknown = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = null;
      }
      writes.push({ method, path, body });
    }
    if (path === "/v1/browser-governance") return json(route, SETTINGS);
    if (path === "/v1/browser-governance/settings" && method === "PUT") return json(route, { ...SETTINGS, ...(req.postDataJSON() as Json), changed: true });
    if (path === "/v1/browser-governance/sites") return json(route, { sites: SITES });
    const site = /^\/v1\/browser-governance\/sites\/([^/]+)$/.exec(path);
    if (site && method === "PUT") return json(route, { siteId: site[1], ...(req.postDataJSON() as Json) });
    if (path === "/v1/browser-governance/enrolment-tokens" && method === "POST") {
      const b = req.postDataJSON() as { label: string; deviceCap: number };
      return json(route, { token: { ...TOKENS[0], tokenId: id("61000000", 9), label: b.label, deviceCap: b.deviceCap, devicesEnrolled: 0, devicesActive: 0 }, managedConfig: { gatewayUrl: "https://gateway.example", enrolmentToken: SECRET, policyKeys: SETTINGS.policySigner.publishedKeys } }, 201);
    }
    if (path === "/v1/browser-governance/enrolment-tokens") return json(route, page(TOKENS, url.searchParams));
    if (path === "/v1/browser-governance/devices") return json(route, page(DEVICES, url.searchParams));
    if (path === "/v1/browser-governance/events") return json(route, page(EVENTS, url.searchParams));
    if (/\/revoke$/.test(path) && method === "POST") return json(route, { revoked: true });
    if (path === `/v1/browser-governance/prompt-captures/${CAPTURE_ID}`) {
      return json(route, { id: CAPTURE_ID, deviceId: DEVICES[0]!.deviceId, siteId: "ep-site-b", userId: null, subject: "psn:usr00000000000000000012", conversationRef: "cnv:0000", text: "Summarise the synthetic quarterly notes.", capturedAt: ago(3), receivedAt: ago(3) });
    }
    return json(route, {});
  });
  return writes;
}

const URL_PAGE = "/ui/admin/browser-governance";
async function axeClean(p: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await p.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")}`), `${label} (${theme})`).toEqual([]);
  }
}

test.describe("ADR-0334 D5: Browser governance", () => {
  test("renders every section, its warnings and step-up notes, and is axe clean in both themes", async ({ page }) => {
    await mockApi(page);
    await page.goto(URL_PAGE);
    await expect(page.getByRole("heading", { level: 1, name: "Browser governance" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Enforce" })).toBeChecked();
    await expect(page.getByText("Audit only asks you to confirm it's you")).toBeVisible();
    await expect(page.getByTestId("policy-key")).toContainText("device-policy-0123456789abcdef01234567");
    const sites = page.getByTestId("browser-sites");
    await expect(sites).toContainText("chat.site-a.example");
    await expect(sites).toContainText("corp.example");
    await expect(sites).toContainText("Denied (no rule)");
    await expect(page.getByText("3 · 2 allowed · 1 denied")).toBeVisible();
    await expect(page.getByRole("cell", { name: "Finance laptops", exact: true })).toBeVisible();
    await expect(page.getByText("not bound yet")).toBeVisible();
    await expect(page.getByText("Signed in with an account outside the required domains")).toBeVisible();
    await expect(page.getByText("audit only: not blocked")).toBeVisible();
    await expect(page.getByText("Reveal prompt asks you to confirm it's you")).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke token Pilot group" })).toHaveCount(0);
    await axeClean(page, "browser governance");
  });

  test("switching to audit only asks to confirm it's you and resends the same PUT once", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/browser-governance/settings", kind: "settings_relax", facts: (b) => ({ op: "browser_governance_settings", ...(b as Json) }) });
    await page.goto(URL_PAGE);
    await page.getByRole("radio", { name: "Audit only" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ enabled: true, mode: "audit" });
  });

  test("turning it off is confirmed in words and needs no step-up", async ({ page }) => {
    const writes = await mockApi(page);
    await page.goto(URL_PAGE);
    await page.getByRole("radio", { name: "Off" }).click();
    const dialog = page.getByRole("dialog", { name: "Turn browser governance off?" });
    await expect(dialog).toContainText("every enrolled browser blocks every governed site");
    await dialog.getByRole("button", { name: "Turn off" }).click();
    await expect.poll(() => writes.filter((w) => w.path === "/v1/browser-governance/settings").map((w) => w.body)).toEqual([{ enabled: false }]);
  });

  test("allowing a site asks to confirm it's you; denying one does not", async ({ page }) => {
    const writes = await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/browser-governance/sites/ep-site-c", kind: "settings_relax", facts: (b) => ({ op: "browser_site_allow", siteId: "ep-site-c", ...(b as Json) }) });
    await page.goto(URL_PAGE);
    await page.getByRole("button", { name: "Allow img.site-c.example" }).click();
    const dialog = page.getByRole("dialog", { name: "Rule for img.site-c.example" });
    await expect(dialog.getByText("Allowing asks you to confirm it's you")).toBeVisible();
    await dialog.getByLabel(/Required account domains/).fill("Corp.Example");
    await dialog.getByRole("button", { name: "Allow site" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ decision: "allow", accountDomains: ["corp.example"] });
    await page.getByRole("button", { name: "Edit chat.site-a.example" }).click();
    const deny = page.getByRole("dialog", { name: "Rule for chat.site-a.example" });
    await deny.getByRole("button", { name: "Deny site" }).click();
    await expect.poll(() => writes.filter((w) => w.path === "/v1/browser-governance/sites/ep-site-a").map((w) => w.body)).toEqual([{ decision: "deny", accountDomains: [] }]);
  });

  test("an enrolment token is issued through a step-up and shown once", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "POST", path: "/v1/browser-governance/enrolment-tokens", kind: "settings_relax", facts: (b) => ({ op: "browser_enrolment_token_issue", ...(b as Json) }) });
    await page.goto(URL_PAGE);
    await page.getByRole("button", { name: "Issue token" }).click();
    const form = page.getByRole("dialog", { name: "Issue an enrolment token" });
    await form.getByLabel("Label").fill("Engineering");
    await form.getByLabel(/Device cap/).fill("200");
    await form.getByRole("button", { name: "Issue token" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ label: "Engineering", deviceCap: 200, expiresInDays: 30 });
    const shown = page.getByRole("dialog", { name: "Enrolment token issued" });
    await expect(shown.getByText("Shown once")).toBeVisible();
    await expect(shown.getByTestId("issued-secret")).toHaveText(SECRET);
    await expect(shown).toContainText("https://gateway.example");
    await axeClean(page, "token shown once");
    await shown.getByRole("button", { name: "I have copied it" }).click();
    await expect(page.getByRole("dialog", { name: "Enrolment token issued" })).toHaveCount(0);
    await expect(page.getByText(SECRET)).toHaveCount(0);
    expect(await page.evaluate((s) => JSON.stringify({ ...localStorage }).includes(s) || JSON.stringify({ ...sessionStorage }).includes(s), SECRET)).toBe(false);
  });

  test("revealing a captured prompt goes through the pseudonym-reveal step-up", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "GET", path: `/v1/browser-governance/prompt-captures/${CAPTURE_ID}`, kind: "pseudonym_reveal", facts: () => ({ op: "browser_prompt_capture_read", captureId: CAPTURE_ID }) });
    await page.goto(URL_PAGE);
    const reveal = page.getByTestId("reveal-prompt");
    await reveal.getByRole("button", { name: "Reveal prompt…" }).click();
    await expect(reveal.getByText("Enter the capture id from its audit log entry.")).toBeVisible();
    await reveal.getByLabel("Capture id").fill(CAPTURE_ID);
    await reveal.getByRole("button", { name: "Reveal prompt…" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    const shown = page.getByRole("dialog", { name: "Captured prompt" });
    await expect(shown).toContainText("Summarise the synthetic quarterly notes.");
    await expect(shown).toContainText("This view was audited.");
    await axeClean(page, "captured prompt");
  });
});
