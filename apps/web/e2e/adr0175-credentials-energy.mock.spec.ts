/**
 * ADR-0175 A7 / A15 from the browser's side, every /v1 and /auth call answered
 * by an in-test mock:
 *
 *  - Credentials (Identity & Access): the inventory table with owner, scope,
 *    last used ("not recorded" where nothing records it), expiry ("not
 *    tracked" for a held third-party secret), flags, filters by type and flag,
 *    links to where each credential is managed, and the observe-only toggle
 *    that turns `stale_credentials` alerts on (one PUT of org settings);
 *  - the cost dashboard's per-project energy estimate: labelled an estimate,
 *    "N of M calls estimated", an unknown model shown as unknown (never 0),
 *    each factor's source and version; and the factor table;
 *  - the use-case record's Stack tab carries the same estimate for its project;
 *  - axe (WCAG 2.x A/AA) over each screen in BOTH themes.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const PROJECT = "a1111111-1111-4111-8111-111111111111";
const UC = "c1111111-1111-4111-8111-111111111111";
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const flagLabels = {
  never_expires: "Never expires",
  past_expiry: "Past expiry",
  unused: "Unused",
  owner_deactivated: "Owner deactivated",
  over_scoped: "Over-scoped",
};
const cred = (over: Record<string, unknown>) => ({
  ownerUserId: null,
  ownerName: null,
  ownerKind: null,
  ownerDisabled: false,
  status: "active",
  createdAt: "2026-05-01T00:00:00.000Z",
  lastUsedAt: null,
  lastUsedSignal: "recorded",
  expiresAt: null,
  expirySignal: "recorded",
  secretSetAt: "2026-05-01T00:00:00.000Z",
  rotationSignal: "recorded",
  ageSinceRotationDays: 156,
  linkedAgents: [],
  linkedProjects: [],
  flags: [],
  flagReasons: {},
  revokedAt: null,
  overScoped: false,
  ...over,
});
const inventory = (alerting: boolean) => ({
  generatedAt: "2026-10-04T12:00:00.000Z",
  unusedDays: 90,
  alerting,
  linkWindowDays: 90,
  types: [
    { type: "api_key", label: "API key", manageAt: "/admin/users", lastUsed: "recorded", lastUsedNote: "the key's last_used_at", overScoped: "owner is an administrator", count: 2 },
    { type: "virtual_key", label: "Virtual key", manageAt: "/admin/virtual-keys", lastUsed: "recorded", lastUsedNote: "the key's last_used_at", overScoped: "no model list and no budget", count: 1 },
    { type: "git_token", label: "Git provider token", manageAt: "/admin/git-connections", lastUsed: "none", lastUsedNote: "git operations are not recorded per connection", overScoped: null, count: 1 },
  ],
  notStored: [{ what: "MCP server upstream auth", why: "MCP servers are registered by URL with no stored upstream credential" }],
  flagLabels,
  counts: { total: 4, flagged: 2, byFlag: { never_expires: 1, past_expiry: 0, unused: 1, owner_deactivated: 1, over_scoped: 1 } },
  credentials: [
    cred({
      id: "virtual_key:v1",
      type: "virtual_key",
      typeLabel: "Virtual key",
      name: "batch-jobs",
      manageAt: "/admin/virtual-keys",
      ownerUserId: "lee",
      ownerName: "Lee Leaver",
      ownerKind: "owner",
      ownerDisabled: true,
      scope: "any model its owner may use; no budget",
      linkedProjects: [{ id: PROJECT, name: "Claims triage" }],
      flags: ["never_expires", "owner_deactivated", "over_scoped"],
      flagReasons: { never_expires: "no expiry is set", owner_deactivated: "its owner is deactivated", over_scoped: "no model list and no budget" },
    }),
    cred({
      id: "api_key:k1",
      type: "api_key",
      typeLabel: "API key",
      name: "nightly-export",
      manageAt: "/admin/users",
      ownerUserId: "dana",
      ownerName: "Dana Developer",
      ownerKind: "owner",
      scope: "every entitlement of its owner",
      createdAt: "2026-01-02T00:00:00.000Z",
      expiresAt: "2027-01-02T00:00:00.000Z",
      flags: ["unused"],
      flagReasons: { unused: "never used in the 275 days since it was created" },
    }),
    cred({
      id: "api_key:k2",
      type: "api_key",
      typeLabel: "API key",
      name: "ci",
      manageAt: "/admin/users",
      ownerUserId: "dana",
      ownerName: "Dana Developer",
      ownerKind: "owner",
      scope: "every entitlement of its owner",
      lastUsedAt: "2026-10-04T10:00:00.000Z",
      expiresAt: "2027-01-02T00:00:00.000Z",
    }),
    cred({
      id: "git_token:g1",
      type: "git_token",
      typeLabel: "Git provider token",
      name: "demo-git",
      manageAt: "/admin/git-connections",
      scope: "mock repository operations in workflow stages that name this connection",
      lastUsedSignal: "none",
      expirySignal: "not_tracked",
      secretSetAt: null,
      rotationSignal: "since_created",
    }),
  ],
});

const estimate = {
  scope: { kind: "project", id: PROJECT, name: "Claims triage", projectId: PROJECT },
  estimate: {
    label: "Estimate: ledger tokens × admin-entered per-model energy factors × grid intensity. Not a measurement.",
    windowDays: 30,
    callsTotal: 12,
    callsEstimated: 9,
    callsUnknown: 3,
    coverage: "9 of 12 calls estimated",
    energyWh: 4.5,
    emissionsG: null,
    grid: null,
    byModel: [
      { model: "model-a", calls: 9, callsEstimated: 9, inputTokens: 9000, outputTokens: 3000, energyWh: 4.5, status: "estimated", factor: { whPer1kInput: 0.3, whPer1kOutput: 0.6, sourceNote: "provider disclosure 2026", version: "2026-09", demo: false } },
      { model: "model-b", calls: 3, callsEstimated: 0, inputTokens: 100, outputTokens: 100, energyWh: null, status: "no_factor", factor: null },
    ],
    unknownModels: ["model-b"],
    usesDemoFactors: false,
  },
  note: null,
};
const factors = {
  factors: [
    { id: "f1", kind: "model", subject: "model-a", whPer1kInput: 0.3, whPer1kOutput: 0.6, gCo2ePerKwh: null, sourceNote: "provider disclosure 2026", version: "2026-09", demo: false, updatedAt: "2026-10-01T00:00:00Z" },
  ],
  region: null,
  notes: { shipped: "RegulAIt ships no energy factor for any model and no grid intensity.", unknown: "A model with no factor is shown as unknown, never as zero." },
};
const overview = {
  useCase: { id: UC, name: "Claims triage assistant", description: "Sorts claims.", businessContext: "", status: "approved", euAiActTier: "limited", ownerName: "Dana Developer", complianceTags: [], projectId: PROJECT },
  screening: { tier: "limited", reasons: [], rulesetVersion: 1, screened: true },
  questionnaire: { submitted: true, artifactId: "a", version: 1, submittedAt: "2026-10-02T12:00:00Z" },
  risks: [],
  summary: { risks: 0, liveRisks: 0, liveWithoutControls: 0, agentsWithoutApprovedModelCard: 0, pendingApprovals: 0 },
  stack: { agents: [], vendors: [] },
  approvals: [],
  audit: [],
};

/** 146 more flag-free API keys, for paging */
const filler = Array.from({ length: 146 }, (_, i) =>
  cred({
    id: `api_key:f${i}`,
    type: "api_key",
    typeLabel: "API key",
    name: `filler-${String(i).padStart(3, "0")}`,
    manageAt: "/admin/users",
    scope: "every entitlement of its owner",
    expiresAt: "2027-01-02T00:00:00.000Z",
    lastUsedAt: "2026-10-04T10:00:00.000Z",
  }),
);

/** the server filters by type and flag, then pages (ADR-0175 review fix) */
function inventoryPage(alerting: boolean, many: boolean, search: URLSearchParams) {
  const inv = inventory(alerting);
  const all = many ? [...inv.credentials, ...filler] : inv.credentials;
  const type = search.get("type");
  const flag = search.get("flag");
  const limit = Number(search.get("limit") ?? 100);
  const offset = Number(search.get("offset") ?? 0);
  const matched = all.filter(
    (c) =>
      (!type || c.type === type) &&
      (!flag || (flag === "none" ? (c.flags as string[]).length === 0 : (c.flags as string[]).includes(flag))),
  );
  return {
    ...inv,
    counts: { ...inv.counts, total: all.length },
    page: { total: matched.length, limit, offset },
    credentials: matched.slice(offset, offset + limit),
  };
}

async function mockApi(page: Page, opts: { many?: boolean } = {}) {
  const state = { alerting: false, puts: [] as unknown[], estimateQueries: [] as string[], credentialQueries: [] as string[] };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me") return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } });
    if (p === "/v1/admin/credentials") {
      state.credentialQueries.push(url.search);
      return json(route, inventoryPage(state.alerting, opts.many === true, url.searchParams));
    }
    if (p === "/v1/org/settings" && method === "PUT") {
      const body = route.request().postDataJSON() as { staleCredentialAlerts?: boolean };
      state.puts.push(body);
      if (typeof body.staleCredentialAlerts === "boolean") state.alerting = body.staleCredentialAlerts;
      return json(route, { settings: {} });
    }
    if (p === "/v1/projects") return json(route, { projects: [{ id: PROJECT, name: "Claims triage", costCenter: null, initiativeId: null, budgetUsd: null, spentUsd: 1.2, classifications: [] }] });
    if (p === `/v1/projects/${PROJECT}/costs`) return json(route, { measured: { costUsd: 1.2, events: 12, inputTokens: 9100, outputTokens: 3100 }, budget: {}, byUser: [], byTeam: [], byAgent: [], byConnector: [], byMcpTool: [], estimatedSavings: [] });
    if (p === "/v1/energy/estimate") {
      state.estimateQueries.push(url.search);
      return json(route, url.searchParams.get("useCaseId") ? { ...estimate, scope: { kind: "use_case", id: UC, name: "Claims triage assistant", projectId: PROJECT }, note: "A use case's estimate is its project's traffic." } : estimate);
    }
    if (p === "/v1/energy/factors") return json(route, factors);
    if (p === `/v1/use-cases/${UC}/overview`) return json(route, overview);
    return json(route, {});
  });
  return state;
}

const THEMES = ["light", "dark"] as const;
async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    // finite transitions only, and capped: an infinite animation, or one on an
    // element that is not rendered, never finishes
    const finite = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
    const settled = Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
  await setTheme(page, "light");
}

test.describe("ADR-0175 A7: the credential inventory", () => {
  test("lists credentials with owner, scope, signals and flags; filters; links to where each is managed; axe-clean", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/credentials");
    await expect(page.getByRole("heading", { name: "Credentials", level: 1 })).toBeVisible();
    const table = page.getByRole("table").first();
    const vk = table.getByRole("row", { name: /batch-jobs/ });
    await expect(vk).toContainText("Lee Leaver");
    await expect(vk).toContainText("deactivated");
    await expect(vk).toContainText("project Claims triage");
    for (const f of ["Never expires", "Owner deactivated", "Over-scoped"]) await expect(vk.getByText(f, { exact: true })).toBeVisible();
    await expect(vk.getByRole("link", { name: "Manage Virtual key batch-jobs" })).toHaveAttribute("href", "/ui/admin/virtual-keys");
    const git = table.getByRole("row", { name: /demo-git/ });
    await expect(git).toContainText("integration (no person)");
    await expect(git).toContainText("not recorded");
    await expect(git).toContainText("not tracked");
    await expect(git.getByRole("link", { name: /demo-git/ })).toHaveAttribute("href", "/ui/admin/git-connections");
    await expect(page.getByText(/git operations are not recorded per connection/)).toBeVisible();
    await expect(page.getByText(/MCP server upstream auth/)).toBeVisible();
    // no secret-looking value anywhere on the page
    expect((await page.locator("main").innerText()).match(/[A-Za-z0-9+/=_]{24,}/g) ?? []).toEqual([]);
    await expectAxeClean(page, "Credentials");

    await page.getByLabel("Filter by flag").selectOption("unused");
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(table.getByRole("row", { name: /nightly-export/ })).toBeVisible();
    await page.getByLabel("Filter by flag").selectOption("__all__");
    await page.getByLabel("Filter by credential type").selectOption("api_key");
    await expect(table.locator("tbody tr")).toHaveCount(2);
  });

  test("pages through a large inventory, a hundred at a time, filtered on the server", async ({ page }) => {
    const state = await mockApi(page, { many: true });
    await page.goto("/ui/admin/credentials");
    const table = page.getByRole("table").first();
    await expect(page.getByText("Showing 1–100 of 150")).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(100);
    await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByText("Showing 101–150 of 150")).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(50);
    await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(state.credentialQueries.some((q) => q.includes("offset=100") && q.includes("limit=100"))).toBe(true);
    // a filter goes to the server and starts again at the first page
    await page.getByLabel("Filter by flag").selectOption("unused");
    await expect(page.getByText("Showing 1–1 of 1")).toBeVisible();
    expect(state.credentialQueries.at(-1)).toContain("flag=unused");
    expect(state.credentialQueries.at(-1)).toContain("offset=0");
  });

  test("alerts are observe-only until an admin turns them on", async ({ page }) => {
    const state = await mockApi(page);
    await page.goto("/ui/admin/credentials");
    await expect(page.getByText("observe only", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Turn alerts on" }).click();
    await expect.poll(() => state.puts).toEqual([{ staleCredentialAlerts: true }]);
    await expect(page.getByRole("button", { name: "Turn alerts off" })).toBeVisible();
    await expect(page.getByText(/opens one alert episode on the next monitor pass/)).toBeVisible();
  });
});

test.describe("ADR-0175 A15: the energy estimate", () => {
  test("the cost dashboard labels it an estimate, says N of M, shows unknown (never 0) and each factor's source; axe-clean", async ({ page }) => {
    const state = await mockApi(page);
    await page.goto("/ui/admin/cost");
    await page.getByRole("link", { name: "Open cost rollup for Claims triage" }).click();
    const panel = page.getByRole("region", { name: "Estimated energy and emissions" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("estimate", { exact: true })).toBeVisible();
    await expect(panel).toContainText("4.5 Wh");
    await expect(panel).toContainText("9 of 12 calls estimated");
    await expect(panel).toContainText("no grid intensity set");
    await expect(panel).toContainText("3 calls are unknown, not zero: no factor for model-b");
    const b = panel.getByRole("row", { name: /model-b/ });
    await expect(b).toContainText("unknown");
    await expect(b).not.toContainText("0 Wh");
    await expect(panel.getByRole("row", { name: /model-a/ })).toContainText("provider disclosure 2026 · v2026-09");
    expect(state.estimateQueries[0]).toContain(`projectId=${PROJECT}`);
    const factorsCard = page.locator("section").filter({ has: page.getByText("Energy factors", { exact: true }) }).first();
    await expect(factorsCard).toContainText("ships no energy factor");
    await expect(factorsCard.getByRole("row", { name: /model-a/ })).toContainText("0.3 / 0.6 Wh per 1k tokens in/out");
    await expectAxeClean(page, "Cost dashboard with energy estimate");
  });

  test("the use-case record's Stack tab shows its project's estimate; axe-clean", async ({ page }) => {
    const state = await mockApi(page);
    await page.goto(`/ui/admin/governance/use-cases/${UC}?tab=stack`);
    const panel = page.getByRole("region", { name: "Estimated energy and emissions" });
    await expect(panel).toContainText("9 of 12 calls estimated");
    await expect(panel).toContainText("A use case's estimate is its project's traffic.");
    expect(state.estimateQueries.some((q) => q.includes(`useCaseId=${UC}`))).toBe(true);
    await expectAxeClean(page, "Use case stack tab with energy estimate");
  });
});
