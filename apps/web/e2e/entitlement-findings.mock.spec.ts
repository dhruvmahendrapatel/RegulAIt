/**
 * SaaS entitlement findings (ADR-0337 §5), from the browser's side. Every /v1 and /auth call is answered by an
 * in-test mock that follows apps/gateway/src/saas-entitlement-routes.ts and saas-finding-reviews.ts: the strict report
 * query (windowDays), rules with limits, findings, not-assessable sources and each finding's latest review; the
 * raise body {key, approverUserId, reason, windowDays} with 422 approver_is_requester; the review list with
 * lifecycle.transitions; withdraw only from pending.
 *
 * Covered: the link from Discovery sources; findings with "none recorded" evidence; not-assessable sources kept apart
 * from findings; an accepted risk still listed and marked; raising with an approver (never yourself) and a reason; a
 * refusal kept in the dialog with Try again; a review whose subject the vendor removed; withdraw; the window
 * re-reading with only windowDays; a failed read with Retry; axe in light and dark. Synthetic names only.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./builder-fixtures";

const NOW = "2026-11-23T02:00:00.000Z";
const ME = "00000000-0000-4000-8000-0000000000aa";
const BEA = "00000000-0000-4000-8000-0000000000bb";
const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const finding = (key: string, display: string, scope: string, review: unknown = null) => ({
  key, ruleId: key.split(":")[0], ruleVersion: 1, rationale: `${display} has not used ${scope} in the window.`,
  source: { id: "s1", name: "Sample tenant", platform: "m365", kind: "entitlement_m365" },
  app: { id: `app-${display}`, externalId: `${display.toLowerCase().replace(/ /g, "-")}-id`, displayName: display, agentId: null },
  grant: { id: key.split(":")[2], scope, resource: null, access: "write", accessReason: "", grantType: "application", consent: "admin" },
  agentRecord: null,
  evidence: { usageCoverage: "app", windowDays: 90, lastUseAt: null },
  action: { kind: "vendor-console", note: "RegulAIt never revokes a vendor-side grant: review it with the app's owner, then remove or narrow it in the vendor's admin console.", raise: { method: "POST", path: "/v1/discovery/entitlements/findings/reviews", key } },
  review,
});

async function mockApi(page: Page, opts: { failReport?: boolean } = {}) {
  const st = {
    failReport: opts.failReport === true,
    reviews: [] as Array<Record<string, unknown>>,
    calls: [] as Array<{ method: string; path: string; body: unknown; query: URLSearchParams }>,
  };
  const reviewView = (id: string, key: string, status: string, subjectGone = false) => ({
    id, findingKey: key, ruleId: "unused-grant", ruleVersion: 1, sourceId: "s1", grantId: subjectGone ? null : G1, agentRecordId: null, subjectGone,
    rationale: "Idle app has not used Mail.Send in the window.", evidence: {}, status, reason: "the agent was retired", requestedBy: ME, approvalId: `ap-${id}`, decidedBy: null, decidedAt: null, createdAt: NOW,
    lifecycle: { machine: "saas_finding_review", state: status, terminal: status !== "pending", transitions: [{ event: "withdraw", to: "withdrawn", allowed: status === "pending", by: ["admin"], summary: "", ...(status === "pending" ? {} : { reason: `a ${status} review cannot be withdrawn` }) }] },
  });
  st.reviews.push(reviewView("r-old", `unused-grant:grant:${G2}`, "accepted", true));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    let body: unknown = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    st.calls.push({ method, path: p, body, query: url.searchParams });
    if (p === "/auth/me" || p === "/v1/me") {
      return json(route, { userId: ME, isAdmin: true, via: "session", user: { id: ME, email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    }
    if (p === "/v1/users") return json(route, { users: [{ id: ME, email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null }, { id: BEA, email: "bea@example.test", displayName: "Bea Admin", isAdmin: true, disabledAt: null }, { id: "00000000-0000-4000-8000-0000000000cc", email: "cy@example.test", displayName: "Cy Member", isAdmin: false, disabledAt: null }] });
    if (p === "/v1/discovery/sources") return json(route, { sources: [], posture: { sourcesTotal: 0, sourcesEnabled: [], staticCredentials: [], staleCredentials: [], writeScopeUnverified: [], credentialsRefused: [], credentialWarningAgeDays: 90, endpointRetentionDays: 90, statement: "No source." } });
    if (p === "/v1/discovery/scanners") return json(route, { kinds: [] });
    if (p === "/v1/discovery/settings") return json(route, { credentialWarningAgeDays: 90, endpointRetentionDays: 90, families: { saas: true, identity: false, ml_platform: false }, version: 1 });
    if (p === "/v1/discovery/runs") return json(route, { items: [], nextCursor: null, nextOffset: null, total: 0, totalIsEstimate: false, failed: 0 });
    if (p === "/v1/discovery/federation") return json(route, { enabled: false, issuer: null, jwksUri: null, tokenTtlSeconds: 900, keys: [], awsPrincipal: { configured: false, roleArn: null, subject: "" }, subjectFormat: "", audiences: {} });
    if (p === "/v1/discovery/entitlements/findings") {
      for (const k of url.searchParams.keys()) if (!["windowDays", "limit"].includes(k)) return json(route, { error: "invalid_request" }, 400);
      if (st.failReport) return json(route, { error: "internal_error" }, 500);
      const pending = st.reviews.find((r) => r.findingKey === `unused-grant:grant:${G1}` && r.status === "pending");
      return json(route, {
        rulesVersion: "2026-11-1", classifierVersion: "1", windowDays: Number(url.searchParams.get("windowDays") ?? 90), computedAt: NOW, scanTruncated: false,
        rules: [
          {
            id: "unused-grant", title: "Unused grants", severity: "review-suggested", limits: "Judged only where a source records use, and only for grants older than the window.", count: 2, truncated: false,
            findings: [
              finding(`unused-grant:grant:${G1}`, "Idle app", "Mail.Send", pending ? { id: pending.id, status: "pending", decidedAt: null } : null),
              finding(`unused-grant:grant:${G2}`, "Quiet app", "Files.Read", { id: "r-old", status: "accepted", decidedAt: NOW }),
            ],
            notAssessable: [{ source: { id: "s2", name: "Sample org" }, reason: "no read of this source has recorded usage yet" }],
          },
          { id: "oversharing", title: "Oversharing", severity: "review-suggested", limits: "Asks for a decision; it does not say the consent is wrong.", count: 0, truncated: false, findings: [], notAssessable: [] },
        ],
      });
    }
    if (p === "/v1/discovery/entitlements/findings/reviews" && method === "GET") {
      for (const k of url.searchParams.keys()) if (!["status", "findingKey", "after", "limit"].includes(k)) return json(route, { error: "invalid_request" }, 400);
      return json(route, { reviews: st.reviews, next: null });
    }
    if (p === "/v1/discovery/entitlements/findings/reviews" && method === "POST") {
      const b = body as { key: string; approverUserId: string; reason: string; windowDays?: string };
      if (b.approverUserId === ME) return json(route, { error: "approver_is_requester", detail: "you cannot name yourself to decide your own review" }, 422);
      if (b.approverUserId === "00000000-0000-4000-8000-0000000000cc") return json(route, { error: "approver_not_eligible", detail: "that person is not an active administrator" }, 422);
      const r = reviewView(`r${st.reviews.length + 1}`, b.key, "pending");
      st.reviews.push(r);
      return json(route, { review: r }, 201);
    }
    const wd = p.match(/^\/v1\/discovery\/entitlements\/findings\/reviews\/([^/]+)\/withdraw$/);
    if (wd && method === "POST") {
      const r = st.reviews.find((x) => x.id === wd[1]);
      if (!r) return json(route, { error: "review_not_found" }, 404);
      if (r.status !== "pending") return json(route, { error: "invalid_transition", detail: `a ${String(r.status)} review cannot be withdrawn` }, 409);
      Object.assign(r, reviewView(String(r.id), String(r.findingKey), "withdrawn"));
      return json(route, { review: r });
    }
    return json(route, {});
  });
  return st;
}

const card = (page: Page, title: string) => page.locator("[data-rg-card]").filter({ has: page.getByText(title, { exact: true }) });

test.describe("SaaS entitlement findings", () => {
  test("shows findings, keeps not-assessable sources apart, and an accepted risk stays listed", async ({ page }) => {
    const st = await mockApi(page);
    await page.goto("/ui/admin/shadow-ai/discovery-sources");
    await page.getByRole("link", { name: "SaaS entitlement findings" }).click();
    await expect(page.getByRole("heading", { name: "SaaS entitlement findings" })).toBeVisible();
    const unused = card(page, "Unused grants");
    await expect(unused).toContainText("Judged only where a source records use");
    const idle = unused.getByRole("row").filter({ hasText: "Idle app" });
    await expect(idle).toContainText("Mail.Send");
    await idle.getByText("Evidence").click();
    await expect(idle).toContainText("none recorded");
    await expect(idle).toContainText("never revokes a vendor-side grant");
    await expect(unused.getByRole("row").filter({ hasText: "Quiet app" })).toContainText("Risk accepted");
    await expect(unused).toContainText("Sample org: no read of this source has recorded usage yet");
    await expect(unused).toContainText("That is not the same as having no findings.");
    await expect(card(page, "Oversharing").getByText("No findings for this rule")).toBeVisible();
    await expectAxeClean(page, "entitlement findings");

    await page.getByLabel("Usage window", { exact: true }).selectOption({ label: "30 days" });
    await expect.poll(() => st.calls.filter((c) => c.path === "/v1/discovery/entitlements/findings").at(-1)?.query.toString()).toBe("windowDays=30");
  });

  test("raise for review: the picker offers neither yourself nor a non-administrator, and names a second administrator", async ({ page }) => {
    const st = await mockApi(page);
    await page.goto("/ui/admin/shadow-ai/entitlement-findings");
    const idle = card(page, "Unused grants").getByRole("row").filter({ hasText: "Idle app" });
    await idle.getByRole("button", { name: "Raise Idle app for review" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("You cannot decide your own review. Nothing executes");
    await expect(dialog.getByRole("option", { name: "Ada Admin" })).toHaveCount(0);
    await expect(dialog.getByRole("option", { name: "Cy Member" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Raise for review", exact: true })).toHaveAttribute("aria-disabled", "true");
    await dialog.getByLabel("Administrator who decides").selectOption({ label: "Bea Admin" });
    await dialog.getByLabel("Why it should be reviewed").fill("  the agent was retired  ");
    await dialog.getByRole("button", { name: "Raise for review", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Raised for review." })).toBeVisible();
    expect(st.calls.find((c) => c.method === "POST")!.body).toEqual({ key: `unused-grant:grant:${G1}`, approverUserId: BEA, reason: "the agent was retired", windowDays: "90" });
    await expect(idle).toContainText("Waiting for a second administrator");
    await expect(idle.getByRole("button", { name: /Raise/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open in Approvals" })).toHaveAttribute("href", /\/admin\/approvals\?objectType=saas_finding_review$/);
  });

  test("a refused raise keeps the form, with the server's reason and Try again", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/shadow-ai/entitlement-findings");
    // the picker leaves out the caller; a server refusal for another reason is still shown in the dialog
    await page.route("**/v1/discovery/entitlements/findings/reviews", (route) =>
      route.request().method() === "POST" ? json(route, { error: "approver_not_eligible", detail: "that administrator is linked to you by a delegation" }, 422) : route.fallback(),
    );
    await card(page, "Unused grants").getByRole("row").filter({ hasText: "Idle app" }).getByRole("button", { name: "Raise Idle app for review" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Administrator who decides").selectOption({ label: "Bea Admin" });
    await dialog.getByLabel("Why it should be reviewed").fill("retired");
    await dialog.getByRole("button", { name: "Raise for review", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Nothing changed");
    await expect(dialog.getByLabel("Why it should be reviewed")).toHaveValue("retired");
    await expect(dialog.getByRole("button", { name: "Try again: Raise for review" })).toBeVisible();
  });

  test("raised reviews: the vendor removed the subject, and only a pending review can be withdrawn", async ({ page }) => {
    const st = await mockApi(page);
    await page.goto("/ui/admin/shadow-ai/entitlement-findings");
    const raised = card(page, "Raised reviews");
    const old = raised.getByRole("row").filter({ hasText: "The vendor has since removed the subject." });
    await expect(old).toContainText("Risk accepted");
    await expect(old.getByRole("button", { name: /Withdraw/ })).toHaveCount(0);

    await card(page, "Unused grants").getByRole("row").filter({ hasText: "Idle app" }).getByRole("button", { name: "Raise Idle app for review" }).click();
    await page.getByRole("dialog").getByLabel("Administrator who decides").selectOption({ label: "Bea Admin" });
    await page.getByRole("dialog").getByLabel("Why it should be reviewed").fill("retired");
    await page.getByRole("dialog").getByRole("button", { name: "Raise for review", exact: true }).click();
    const pending = raised.getByRole("row").filter({ hasText: "Waiting for a second administrator" });
    await pending.getByRole("button", { name: /Withdraw/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Withdraw", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "The review is withdrawn." })).toBeVisible();
    await expect(raised.getByRole("row").filter({ hasText: "Withdrawn" })).toBeVisible();
    expect(st.calls.some((c) => c.method === "POST" && c.path.endsWith("/withdraw"))).toBe(true);
    await expectAxeClean(page, "entitlement findings: reviews");
  });

  test("a failed report read is an error with Retry, never an empty report", async ({ page }) => {
    const st = await mockApi(page, { failReport: true });
    await page.goto("/ui/admin/shadow-ai/entitlement-findings");
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("No findings for this rule")).toHaveCount(0);
    st.failReport = false;
    await page.getByRole("button", { name: "Retry" }).first().click();
    await expect(card(page, "Unused grants")).toBeVisible();
  });
});
