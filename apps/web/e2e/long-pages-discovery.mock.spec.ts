/**
 * P3 (owner, #453 c6527514889) — the Discovery sources page keeps a short preview of each record list (recent runs,
 * enrolment tokens, endpoint devices: at most five rows and a count, anything needing attention counted in the
 * heading) and moves each full list to its own page under the parent's path, with the shared list control:
 *
 *  - the preview counts, and the attention counts in each heading;
 *  - "View all" opens the list's own page, where the control works (page size, sort, Excel);
 *  - the breadcrumb goes back to Discovery sources;
 *  - every warning the page showed before is still visible on the overview without a click;
 *  - axe (WCAG 2.x A/AA) clean on the overview and on each list page.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

type Json = Record<string, unknown>;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const NOW = Date.parse("2026-10-30T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const ahead = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const id = (p: string, i: number) => `${p}-0000-4000-8000-${String(i).padStart(12, "0")}`;
const ME = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "ada@example.test", displayName: "Ada Admin" } };

const SOURCE_REPO = id("51000000", 1);
const SOURCE_AGENT = id("51000000", 2);
const cred = (writeScope: string) => ({ id: `c-${writeScope}`, mode: "static", publicConfig: {}, hasSecret: true, writeScope, createdAt: ago(48), ageDays: 2, ageWarning: false });
const sources = [
  { id: SOURCE_REPO, name: "Demo GitLab group", kind: "repo_gitlab", target: { group: "acme-demo" }, scope: { orgLevel: true, include: [] }, enabled: true, scheduleIntervalSeconds: 86400, version: 1, nextRunAt: null, lastRunAt: ago(2), scannerBuilt: true, credential: cred("unverified"), lastRun: { status: "failed" } },
  { id: SOURCE_AGENT, name: "Fleet agent", kind: "endpoint_agent", target: {}, scope: { orgLevel: true, include: [] }, enabled: true, scheduleIntervalSeconds: 86400, version: 1, nextRunAt: null, lastRunAt: null, scannerBuilt: true, credential: null, lastRun: null },
];
const ref = (s: (typeof sources)[number]) => ({ sourceId: s.id, name: s.name, kind: s.kind });
const posture = {
  sourcesTotal: 2, sourcesEnabled: sources.map(ref), staticCredentials: [ref(sources[0]!)], staleCredentials: [], writeScopeUnverified: [ref(sources[0]!)],
  credentialsRefused: [], credentialWarningAgeDays: 90, endpointRetentionDays: 90, statement: "2 of 2 discovery sources are enabled.",
};

const RUNS = Array.from({ length: 23 }, (_, i) => ({
  id: id("52000000", i), sourceId: SOURCE_REPO, kind: "repo_gitlab", trigger: i % 2 ? "schedule" : "manual", requestedBy: null,
  status: i === 1 || i === 7 ? "failed" : "succeeded", attempt: 1, sourceVersion: 1, leaseExpiresAt: null, startedAt: ago(i + 1), finishedAt: ago(i + 1),
  observed: 10 + i, matched: i % 4, findingsCreated: i % 3, findingsUpdated: 1, catalogueGaps: i === 0 ? [{ kind: "ide_extension", value: "github.copilot" }] : [],
  readOutcomes: [{ read: "repos", status: i === 2 ? "denied" : "read" }], rawOutputSha256: null,
  errorCode: i === 1 || i === 7 ? "credential_refused" : null, errorDetail: i === 1 || i === 7 ? "The token grants write access." : null, createdAt: ago(i + 1),
}));
const TOKENS = Array.from({ length: 7 }, (_, i) => ({
  id: id("53000000", i), sourceId: SOURCE_AGENT, label: `MDM group ${i + 1}`, deviceCap: 50, devicesEnrolled: i * 3, createdAt: ago(100 + i),
  expiresAt: i === 6 ? ago(1) : ahead(200), revokedAt: i === 5 ? ago(2) : null, expiryRelaxed: false, devicesActive: i * 2,
}));
const DEVICES = Array.from({ length: 12 }, (_, i) => ({
  id: id("54000000", i), tokenId: TOKENS[0]!.id, devicePseudonym: `psn:dev${String(i).padStart(20, "0")}`, os: "linux", arch: "amd64", agentVersion: "1.2.0",
  createdAt: ago(50 + i), ticketExpiresAt: ahead(24), identitiesRegistered: 1, identityCap: 8, lastReportAt: ago(i), revokedAt: i === 11 ? ago(3) : null,
  identities: [{ identityId: id("55000000", i), deviceUserPseudonym: `psn:usr${String(i).padStart(20, "0")}`, keyProtection: i < 2 ? "software" : "hardware", keyProvider: "tpm", status: "active", lastReportAt: ago(i) }],
}));

/** the list contract over one array (offset paging, a bounded total) */
function page(rows: Json[], q: URLSearchParams, field: Record<string, string>, extra: Json = {}) {
  const sort = q.get("sort") ?? "";
  const dir = q.get("dir") === "asc" ? 1 : -1;
  const f = field[sort] ?? "createdAt";
  const all = [...rows].sort((a, b) => ((a[f] as string) < (b[f] as string) ? -1 : (a[f] as string) > (b[f] as string) ? 1 : 0) * dir);
  const limit = Number(q.get("limit") ?? 10);
  const start = Number(q.get("offset") ?? 0);
  return { items: all.slice(start, start + limit), nextCursor: null, nextOffset: start + limit < all.length ? start + limit : null, total: q.get("count") ? all.length : null, totalIsEstimate: false, ...extra };
}

interface Capture {
  lists: URL[];
  exports: URL[];
}
async function mockApi(p: Page): Promise<Capture> {
  const cap: Capture = { lists: [], exports: [] };
  await p.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (req.resourceType() === "document" || (!path.startsWith("/v1") && !path.startsWith("/auth"))) return route.continue();
    if (path === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (path === "/v1/me") return json(route, ME);
    if (path.endsWith("/export.xlsx")) {
      cap.exports.push(url);
      return route.fulfill({ status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x-regulait-export-truncated": "0", "x-regulait-export-row-limit": "100000" }, body: Buffer.from("PK\u0003\u0004") });
    }
    const q = url.searchParams;
    if (req.method() === "POST" && /\/v1\/discovery\/enrolment-tokens\/[^/]+\/revoke$/.test(path)) {
      cap.lists.push(url);
      return json(route, { devicesRevoked: 0 });
    }
    if (path === "/v1/discovery/runs") {
      cap.lists.push(url);
      return json(route, page(RUNS, q, { when: "createdAt", status: "status", source: "sourceId" }, { failed: RUNS.filter((r) => r.status === "failed").length }));
    }
    if (path === `/v1/discovery/sources/${SOURCE_AGENT}/enrolment-tokens`) {
      cap.lists.push(url);
      const expired = TOKENS.filter((t) => !t.revokedAt && Date.parse(t.expiresAt) <= Date.now()).length;
      return json(route, page(TOKENS, q, { created: "createdAt", expires: "expiresAt", label: "label" }, { summary: { tokens: TOKENS.length, expired, revoked: TOKENS.filter((t) => t.revokedAt).length } }));
    }
    if (path === `/v1/discovery/sources/${SOURCE_AGENT}/endpoint-devices`) {
      cap.lists.push(url);
      const softwareKeys = DEVICES.filter((d) => d.identities.some((i) => i.keyProtection === "software")).length;
      return json(route, page(DEVICES, q, { created: "createdAt", last: "lastReportAt", device: "devicePseudonym" }, { summary: { devices: DEVICES.length, revoked: DEVICES.filter((d) => d.revokedAt).length, softwareKeys } }));
    }
    if (path === "/v1/discovery/scanners") return json(route, { kinds: [{ kind: "repo_gitlab", label: "GitLab group (repositories)", family: "repo", slice: "SD1", evidenceKinds: ["code_scan"], subjectKinds: ["repository"], built: true, requiresCredential: true }, { kind: "endpoint_agent", label: "Endpoint agent", family: "endpoint", slice: "SD4", evidenceKinds: ["endpoint_scan"], subjectKinds: ["device"], built: true, requiresCredential: false }] });
    if (path === "/v1/discovery/sources") return json(route, { sources, posture });
    if (path === "/v1/discovery/settings") return json(route, { credentialWarningAgeDays: 90, endpointRetentionDays: 90, version: 1 });
    if (path === "/v1/discovery/federation") return json(route, { enabled: false, issuer: null, jwksUri: null, tokenTtlSeconds: 900, keys: [], awsPrincipal: { configured: false, roleArn: null, subject: "" }, subjectFormat: "", audiences: {} });
    return json(route, {});
  });
  return cap;
}

const OVERVIEW = "/ui/admin/shadow-ai/discovery-sources";
/** a preview's card: its table carries the test id, its heading and its View all sit in the card around it */
const preview = (p: Page, testId: string) => p.getByTestId(testId).locator("xpath=ancestor::section[@data-rg-card][1]");
const pageHeight = (p: Page) => p.evaluate(() => Math.round(document.documentElement.scrollHeight));
async function axeClean(p: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await p.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")}`), `${label} (${theme})`).toEqual([]);
  }
}

test.use({ viewport: { width: 1440, height: 900 } });

test("the page's full height at 1440 px, with these mocks (reported in the PR body)", async ({ page: p }) => {
  await mockApi(p);
  await p.goto(OVERVIEW);
  await expect(p.getByRole("heading", { level: 1, name: "Discovery sources" })).toBeVisible();
  await expect(p.getByText("MDM group 1").first()).toBeVisible();
  await p.waitForLoadState("networkidle");
  console.log(`discovery-sources full-page height at 1440 px: ${await pageHeight(p)} px`);
});

test("the overview keeps a preview of each list: at most five rows, the count, and what needs attention in the heading", async ({ page: p }) => {
  await mockApi(p);
  await p.goto(OVERVIEW);
  const runs = preview(p, "preview-discovery-runs");
  await expect(runs.getByRole("heading", { level: 2 })).toHaveText("Recent runs 23 runs · 2 failed");
  await expect(runs.locator("tbody tr")).toHaveCount(5);
  const tokens = preview(p, "preview-enrolment-tokens");
  await expect(tokens.getByRole("heading", { level: 2 })).toHaveText("Enrolment tokens 7 tokens · 1 expired · 1 revoked");
  await expect(tokens.locator("tbody tr")).toHaveCount(5);
  const devices = preview(p, "preview-endpoint-devices");
  await expect(devices.getByRole("heading", { level: 2 })).toHaveText("Endpoint devices 12 devices · 2 software keys · 1 revoked");
  await expect(devices.locator("tbody tr")).toHaveCount(5);
  for (const [box, to] of [[runs, "/runs"], [tokens, `/tokens?source=${SOURCE_AGENT}`], [devices, `/devices?source=${SOURCE_AGENT}`]] as const) {
    await expect(box.getByRole("link", { name: /^View all/ })).toHaveAttribute("href", `${OVERVIEW}${to}`);
  }
  await axeClean(p, "discovery sources overview");
});

test("every warning the page showed before is still on the overview, without a click", async ({ page: p }) => {
  await mockApi(p);
  await p.goto(OVERVIEW);
  // the source warnings, outside every card
  await expect(p.getByRole("list", { name: "Sources that need attention" })).toContainText("write scope unverified");
  // a failed scan, in words, with its code as secondary text, and a catalogue gap
  const runs = preview(p, "preview-discovery-runs");
  await expect(runs).toContainText("2 failed");
  await expect(runs).toContainText("Credential refused: The token grants write access.");
  await expect(runs.getByTestId("catalogue-gap")).toContainText("github.copilot");
  // a source the scan could not read
  await expect(runs).toContainText(/could not read/i);
  // a software key is a warning, and a revoked token or device says so
  await expect(preview(p, "preview-endpoint-devices")).toContainText("2 software keys");
  await expect(preview(p, "preview-endpoint-devices").getByText("software key").first()).toBeVisible();
  // a revoked or expired token past the newest five is still counted in the heading
  await expect(preview(p, "preview-enrolment-tokens").getByRole("heading", { level: 2 })).toContainText("1 expired · 1 revoked");
  await expect(preview(p, "preview-endpoint-devices").getByRole("heading", { level: 2 })).toContainText("1 revoked");
  // the pseudonym reveal still says it is audited and asks to confirm it's you
  await expect(p.getByText("Audited · step-up")).toBeVisible();
});

for (const L of [
  { name: "recent runs", testId: "preview-discovery-runs", path: "/runs", title: "Recent runs", listId: "discovery-runs", total: 23, sortHeader: "Status", sortId: "status" },
  { name: "enrolment tokens", testId: "preview-enrolment-tokens", path: `/tokens?source=${SOURCE_AGENT}`, title: "Enrolment tokens", listId: "enrolment-tokens", total: 7, sortHeader: "Token", sortId: "label" },
  { name: "endpoint devices", testId: "preview-endpoint-devices", path: `/devices?source=${SOURCE_AGENT}`, title: "Endpoint devices", listId: "endpoint-devices", total: 12, sortHeader: "Device", sortId: "devicePseudonym" },
] as const) {
  test(`View all opens the ${L.name} page: the list control works there, and the breadcrumb goes back`, async ({ page: p }) => {
    const cap = await mockApi(p);
    await p.goto(OVERVIEW);
    await preview(p, L.testId).getByRole("link", { name: /^View all/ }).click();
    await expect(p).toHaveURL(`${OVERVIEW}${L.path}`);
    await expect(p.getByRole("heading", { level: 1, name: L.title })).toBeVisible();
    const list = p.locator(`[data-list="${L.listId}"]`);
    await expect(list.getByTestId("list-status")).toHaveText(`1–${Math.min(10, L.total)} of ${L.total}`);
    await list.getByLabel("Rows per page").selectOption("50");
    await expect(list.getByTestId("list-status")).toHaveText(`1–${L.total} of ${L.total}`);
    const th = list.locator("thead th").filter({ has: p.getByRole("button", { name: L.sortHeader, exact: true }) });
    await th.getByRole("button", { name: L.sortHeader, exact: true }).click();
    await expect(th).toHaveAttribute("aria-sort", "ascending");
    await list.getByRole("button", { name: "Download Excel" }).click();
    await expect.poll(() => cap.exports.length).toBe(1);
    expect(cap.exports[0]!.pathname).toContain("/export.xlsx");
    await axeClean(p, `${L.name} page`);
    const crumbs = p.getByRole("navigation", { name: "Breadcrumb" });
    await crumbs.getByRole("link", { name: "Discovery sources" }).click();
    await expect(p).toHaveURL(OVERVIEW);
    await expect(p.getByRole("heading", { level: 1, name: "Discovery sources" })).toBeVisible();
  });
}

test("a token is revoked from its own page, with the devices it enrolled a separate, unchecked choice", async ({ page: p }) => {
  const cap = await mockApi(p);
  await p.goto(`${OVERVIEW}/tokens?source=${SOURCE_AGENT}`);
  const list = p.locator('[data-list="enrolment-tokens"]');
  // an expired token can still be revoked; a revoked one says so
  await expect(list.locator("tbody tr").filter({ hasText: "MDM group 6" })).toContainText("revoked");
  await list.getByRole("button", { name: "Revoke token MDM group 1" }).click();
  const dialog = p.getByRole("dialog", { name: "Revoke this enrolment token?" });
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect.poll(() => cap.lists.some((u) => u.pathname.endsWith(`${TOKENS[0]!.id}/revoke`))).toBe(true);
});
