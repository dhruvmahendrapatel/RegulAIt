/**
 * The "Third-party evidence (DefenseClaw)" card on the Discovery sources page, from the browser's side. Every /v1 and
 * /auth call is answered by an in-test mock that follows apps/gateway/src/third-party-ingest-routes.ts: the source list
 * with its limits, create (201, 409 `source_name_taken`), the enabled switch (a `settings_relax` step-up to turn on,
 * none to turn off), the credential (step-up, 201 with the token shown once), revoke, and the records read (limit 1..200).
 *
 * Covered: loading then data, the empty state, create and its refusal inline, on with a step-up and off without,
 * issue / replace (confirmed) / revoke (confirmed), the token shown once and gone on Dismiss, the records with their
 * third-party marks and "Show 200", a failed read with Retry, a 403 read, and axe in light and dark. Synthetic names only.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./builder-fixtures";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ME = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "ada@example.test", displayName: "Ada Admin" } };
const SRC = "61000000-0000-4000-8000-000000000001";
const FINDING = "62000000-0000-4000-8000-000000000001";
const PATH = "/v1/third-party-ingest/defenseclaw/records";
const TOKEN = "rgti_" + "ab".repeat(32);
const LIMITS = { maxBodyBytes: 1_048_576, maxRecordsPerRequest: 512, maxRecordsPerHour: 100_000, maxAgeSeconds: 900, maxFutureSeconds: 300, schemaFamily: "v8" };

interface Src {
  id: string;
  name: string;
  enabled: boolean;
  issuedAt: string | null;
}
const view = (s: Src) => ({
  id: s.id, kind: "defenseclaw", name: s.name, schemaFamily: "v8", enabled: s.enabled, credential: s.issuedAt ? { issuedAt: s.issuedAt } : null,
  ingestPath: PATH, createdAt: "2026-11-10T09:00:00.000Z", updatedAt: "2026-11-10T09:00:00.000Z", attribution: "third_party",
});
const record = (i: number) => ({
  id: `63000000-0000-4000-8000-${String(i).padStart(12, "0")}`, recordId: `rec-${i}`, bucket: "enforcement.action", eventName: "hook.decision",
  severity: i === 0 ? "high" : "info", reportedAction: "block", connector: "acme-llm-sdk", devicePseudonym: "psn:0123456789abcdef01234567", attributes: {},
  observedAt: "2026-11-14T08:00:00.000Z", receivedAt: "2026-11-14T08:00:05.000Z", recordSha256: "c0".repeat(32), batchSha256: "d0".repeat(32),
  auditLogId: null, findingIds: i === 0 ? [FINDING] : [], attribution: "third_party", enforcedByRegulAIt: false,
});

interface Opts {
  sources?: Src[];
  /** answer the sources read with this status this many times first */
  failSources?: { status: number; times: number };
  /** hold the first sources read until released */
  hold?: Promise<void>;
  records?: number;
}

async function mockApi(page: Page, opts: Opts = {}) {
  const calls: Array<{ method: string; path: string; search: string; body: unknown }> = [];
  const sources = opts.sources ?? [];
  let fail = opts.failSources?.times ?? 0;
  let held = opts.hold;
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    calls.push({ method, path: p, search: url.search, body });
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    if (p === "/v1/discovery/scanners") return json(route, { kinds: [] });
    if (p === "/v1/discovery/sources") return json(route, { sources: [], posture: { sourcesTotal: 0, sourcesEnabled: [], staticCredentials: [], staleCredentials: [], writeScopeUnverified: [], credentialsRefused: [], credentialWarningAgeDays: 90, endpointRetentionDays: 90, statement: "No discovery source is enabled." } });
    if (p === "/v1/discovery/runs") return json(route, { items: [], nextCursor: null, nextOffset: null, total: 0, totalIsEstimate: false, failed: 0 });
    if (p === "/v1/discovery/settings") return json(route, { credentialWarningAgeDays: 90, endpointRetentionDays: 90, version: 1 });
    if (p === "/v1/discovery/federation") return json(route, { enabled: false, issuer: null, jwksUri: null, tokenTtlSeconds: 900, keys: [], awsPrincipal: { configured: false, roleArn: null, subject: "" }, subjectFormat: "", audiences: {} });
    if (p === "/v1/third-party-ingest/sources" && method === "GET") {
      if (held) {
        const h = held;
        held = undefined;
        await h;
      }
      if (fail > 0) {
        fail -= 1;
        return json(route, { error: opts.failSources!.status === 403 ? "forbidden" : "internal_error" }, opts.failSources!.status);
      }
      return json(route, { sources: sources.map(view), limits: LIMITS });
    }
    if (p === "/v1/third-party-ingest/sources" && method === "POST") {
      const name = (body as { name: string }).name;
      if (sources.some((s) => s.name.toLowerCase() === name.toLowerCase()) || name === "Taken") return json(route, { error: "source_name_taken" }, 409);
      const s = { id: `61000000-0000-4000-8000-00000000010${sources.length}`, name, enabled: false, issuedAt: null };
      sources.push(s);
      return json(route, { source: view(s) }, 201);
    }
    const m = p.match(/^\/v1\/third-party-ingest\/sources\/([^/]+)\/(enabled|credential|credential\/revoke|records)$/);
    const s = m && sources.find((x) => x.id === m[1]);
    if (m && !s) return json(route, { error: "unknown_source" }, 404);
    if (m && s) {
      if (m[2] === "enabled") {
        s.enabled = (body as { enabled: boolean }).enabled;
        return json(route, { source: view(s) });
      }
      if (m[2] === "credential") {
        s.issuedAt = "2026-11-14T09:30:00.000Z";
        return json(route, { source: view(s), credential: { token: TOKEN, header: "Authorization: Bearer <token>", path: PATH } }, 201);
      }
      if (m[2] === "credential/revoke") {
        s.issuedAt = null;
        return json(route, { source: view(s) });
      }
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json(route, { records: Array.from({ length: Math.min(limit, opts.records ?? 0) }, (_, i) => record(i)) });
    }
    return json(route, {});
  });
  return { calls, sources };
}

const card = (page: Page) => page.locator("[data-rg-card]").filter({ has: page.getByText("Third-party evidence (DefenseClaw)", { exact: true }) });
const open = async (page: Page) => {
  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  return card(page);
};
const row = (page: Page, name: string) => card(page).getByRole("row").filter({ hasText: name });

test.describe("third-party evidence (DefenseClaw) ingest sources", () => {
  test("loading then the empty state; create refuses a taken name inline; a new source starts off", async ({ page }) => {
    let release!: () => void;
    const { calls } = await mockApi(page, { hold: new Promise<void>((r) => (release = r)) });
    const c = await open(page);
    await expect(c.getByRole("status", { name: "Loading" })).toBeVisible();
    release();
    await expect(c.getByText("No DefenseClaw source")).toBeVisible();
    await expectAxeClean(page, "DefenseClaw: empty");

    await c.getByLabel("Source name").fill("Taken");
    await c.getByRole("button", { name: "Add DefenseClaw source" }).click();
    await expect(c.getByRole("alert")).toContainText(/source name taken/i);

    await c.getByLabel("Source name").fill("Edge fleet");
    await c.getByRole("button", { name: "Add DefenseClaw source" }).click();
    await expect(row(page, "Edge fleet")).toContainText("Off");
    await expect(row(page, "Edge fleet")).toContainText("No credential");
    expect(calls.filter((x) => x.method === "POST" && x.path === "/v1/third-party-ingest/sources").map((x) => x.body)).toEqual([
      { kind: "defenseclaw", name: "Taken" },
      { kind: "defenseclaw", name: "Edge fleet" },
    ]);
  });

  test("turning a source on asks for a step-up; turning it off does not", async ({ page }) => {
    const { calls } = await mockApi(page, { sources: [{ id: SRC, name: "Edge fleet", enabled: false, issuedAt: null }] });
    const c = await open(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: `/v1/third-party-ingest/sources/${SRC}/enabled`, kind: "settings_relax", when: (b) => (b as { enabled?: boolean })?.enabled === true });
    await c.getByRole("button", { name: "Turn on Edge fleet" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[0]!.body).toEqual({ enabled: true });
    await expect(row(page, "Edge fleet")).toContainText("On");

    await c.getByRole("button", { name: "Turn off Edge fleet" }).click();
    await expect(row(page, "Edge fleet")).toContainText("Off");
    expect(su.attempts).toHaveLength(2);
    expect(calls.filter((x) => x.method === "PUT").at(-1)!.body).toEqual({ enabled: false });
  });

  test("a token is issued with a step-up and shown once; replacing and revoking are confirmed", async ({ page }) => {
    const { calls } = await mockApi(page, { sources: [{ id: SRC, name: "Edge fleet", enabled: true, issuedAt: null }] });
    const c = await open(page);
    const su = await requireStepUpOn(page, { method: "POST", path: `/v1/third-party-ingest/sources/${SRC}/credential`, kind: "settings_relax" });
    await c.getByRole("button", { name: "Issue token for Edge fleet" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    await expect(c.getByTestId("revealed-secret")).toHaveText(TOKEN);
    await expect(c.getByText("shown once")).toBeVisible();
    await expect(c.getByText(/Send it as "Authorization: Bearer <token>" to \/v1\/third-party-ingest\/defenseclaw\/records/)).toContainText("batch.max_export_batch_bytes at 1,048,576 or less, and turn redaction on");
    await expect(row(page, "Edge fleet")).toContainText("Issued 14 Nov 2026");
    await expectAxeClean(page, "DefenseClaw: token shown once");
    // never stored in the browser
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain("rgti_");
    await c.getByRole("button", { name: "Dismiss" }).click();
    await expect(c.getByTestId("revealed-secret")).toHaveCount(0);

    // replacing asks first; Cancel sends nothing
    await c.getByRole("button", { name: "Replace token for Edge fleet" }).click();
    const dlg = page.getByRole("dialog", { name: "Replace the token for 'Edge fleet'?" });
    await expect(dlg).toContainText("The current token stops working");
    await expectAxeClean(page, "DefenseClaw: replace confirm");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    // the step-up harness answered the first, refused attempt; this mock saw only the one resent with the grant
    expect(calls.filter((x) => x.method === "POST" && x.path.endsWith("/credential"))).toHaveLength(1);
    await c.getByRole("button", { name: "Replace token for Edge fleet" }).click();
    await page.getByRole("dialog", { name: "Replace the token for 'Edge fleet'?" }).getByRole("button", { name: "Replace token" }).click();
    await confirmStepUp(page);
    await expect(c.getByTestId("revealed-secret")).toHaveText(TOKEN);

    // revoking asks first, and clears the token on screen
    await c.getByRole("button", { name: "Revoke token for Edge fleet" }).click();
    await page.getByRole("dialog", { name: "Revoke the token for 'Edge fleet'?" }).getByRole("button", { name: "Revoke token" }).click();
    await expect(row(page, "Edge fleet")).toContainText("No credential");
    await expect(c.getByTestId("revealed-secret")).toHaveCount(0);
    expect(calls.some((x) => x.method === "POST" && x.path === `/v1/third-party-ingest/sources/${SRC}/credential/revoke`)).toBe(true);
  });

  test("the records: third-party marks, the reported action, findings and hash, and Show 200", async ({ page }) => {
    const { calls } = await mockApi(page, { sources: [{ id: SRC, name: "Edge fleet", enabled: true, issuedAt: "2026-11-14T09:30:00.000Z" }], records: 60 });
    const c = await open(page);
    await expect(c.getByText("Every row is third-party evidence. The action is reported by DefenseClaw, not a RegulAIt decision.")).toBeVisible();
    const first = c.getByRole("row").filter({ hasText: "High" }).first();
    await expect(first).toContainText("Hook decision");
    await expect(first).toContainText("Third-party");
    await expect(first).toContainText("Block");
    await expect(first).toContainText("psn:0123456789abcdef01234567");
    await expect(first.getByRole("button", { name: new RegExp(`copy the full ID ${FINDING}`) })).toBeVisible();
    await expect(c.getByTestId("newest-note")).toContainText("Showing the newest 50 records");
    expect(calls.filter((x) => x.path.endsWith("/records")).at(-1)!.search).toBe("?limit=50");
    await expectAxeClean(page, "DefenseClaw: records");
    await c.getByRole("button", { name: "Show 200" }).click();
    await expect.poll(() => calls.filter((x) => x.path.endsWith("/records")).at(-1)!.search).toBe("?limit=200");
    await expect(c.getByTestId("newest-note")).toHaveCount(0);
  });

  test("a failed read shows the error with Retry; a 403 says so", async ({ page }) => {
    // two: the app retries a failed read once before it shows the error
    await mockApi(page, { sources: [{ id: SRC, name: "Edge fleet", enabled: false, issuedAt: null }], failSources: { status: 500, times: 2 } });
    const c = await open(page);
    const alert = c.getByRole("alert");
    await expect(alert).toBeVisible();
    await expectAxeClean(page, "DefenseClaw: failed read");
    await c.getByRole("button", { name: "Retry" }).click();
    await expect(row(page, "Edge fleet")).toContainText("Off");

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockApi(page, { failSources: { status: 403, times: 99 } });
    const d = await open(page);
    await expect(d.getByRole("alert")).toBeVisible();
    await expect(d.getByRole("row").filter({ hasText: "Edge fleet" })).toHaveCount(0);
  });
});
