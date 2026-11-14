/**
 * ADR-0226 P2 batch D — the one list control on three more lists, against a mocked gateway that implements the list
 * contract (limit, offset or cursor, sort and dir, count) and each Excel export route:
 *
 *  - the Optimization page's usage events (GET /v1/usage-events);
 *  - the golden cases (GET /v1/governance/decision-regression/cases, built in memory on the server);
 *  - access recommendations' findings per rule (GET /v1/recommendations/access?rule=…, built in memory);
 *  - the Inbox's "Recently decided" (GET /v1/approvals with the decided statuses), which starts folded, is not read
 *    until it is opened, and folds again over the list's own controls (the kit's `listControl`, owner 2026-11-06);
 *  - the Optimization page's usage events card, which folds the same way, with its count and its unattributed and
 *    refused flags from the page's totals read, so nothing that warns is folded away.
 *
 * For each: rows per page 10, 50, 100 and All; a header click asks the server for the sort; the gear hides an
 * optional column and keeps a required one; Download Excel asks for the columns on screen, in order, with the same
 * filters and sort; Refresh refetches; axe (WCAG 2.x A/AA) clean in light and dark, with the picker open too.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

type Json = Record<string, unknown>;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ME = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "ada@example.test", displayName: "Ada Admin" } };
const T0 = Date.parse("2026-10-01T00:00:00Z");
const at = (i: number) => new Date(T0 - i * 60_000).toISOString();
const PEOPLE = ["Ada Admin", "Avery Approver", "Morgan Reyes", "Dana Developer", "Jordan Owner"];

const USAGE = Array.from({ length: 212 }, (_, i) => ({
  id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
  at: at(i),
  userId: "u-admin",
  userName: PEOPLE[i % 5],
  objectType: i % 4 === 0 ? "connector" : "agent",
  model: `model-${i % 3}`,
  agentName: `Agent ${i % 7}`,
  inputTokens: i * 10,
  outputTokens: i,
  costUsd: i % 9 === 0 ? null : i * 0.01,
  measuredCostSavedUsd: i % 3 ? 0.001 * i : null,
  projectId: i % 5 === 0 ? null : "p1",
  refusal: i % 17 === 0,
}));
// the totals read (limit=1) counts every row, flagged ones included
const USAGE_TOTALS = {
  events: USAGE.length,
  costUsd: 12.5,
  measuredCostSavedUsd: 0.4,
  unattributed: USAGE.filter((u) => u.projectId == null).length,
  refused: USAGE.filter((u) => u.refusal).length,
};
const outcome = (tier: string) => ({ tier, reasons: [], frameworks: [], requiredRoles: [], requiredTests: [], suggestedControls: [], approverRouting: "standard" });
const CASES = Array.from({ length: 64 }, (_, i) => ({
  id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
  source: i % 4 === 0 ? "override" : "shipped",
  label: `Golden case ${String(i).padStart(2, "0")}`,
  answers: {},
  expected: { tier: "high" },
  fromUseCaseId: null,
  createdAt: i % 4 === 0 ? at(i) : null,
  createdByName: i % 4 === 0 ? PEOPLE[i % 5] : null,
  outcome: outcome(["minimal", "limited", "high"][i % 3]!),
  unmetExpectation: i % 7 === 0 ? ["tier"] : [],
}));
const FINDINGS = Array.from({ length: 58 }, (_, i) => ({
  key: `unused-grant:${i}`,
  grantKind: "agent",
  grantId: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`,
  holder: { userId: `u-${i}`, roleId: null, label: `${PEOPLE[i % 5]} ${String(i).padStart(2, "0")}` },
  object: { kind: "agent", id: `a-${i}`, label: `Agent ${String(i).padStart(2, "0")}`, toolName: null },
  rationale: `No use in the window (${i})`,
  evidence: { daysSinceGrant: 90 + i, usesInWindow: 0 },
  action: { campaignScope: { kind: "from_recommendations", value: "unused-grant" }, revoke: null },
}));
const REPORT = {
  rulesVersion: 1,
  window: { days: 90, start: at(90 * 1440), end: at(0) },
  computedAt: at(0),
  notes: { what: "", action: "", observed: "Observed from this gateway's own ledgers.", window: "" },
  rules: [
    { id: "unused-grant", version: 1, severity: "review-suggested", title: "Grants not used in the window", limits: "Only what this gateway records.", findings: FINDINGS, notAssessable: [], counts: { findings: FINDINGS.length, notAssessable: 0 } },
    { id: "retired-agent-grants", version: 1, severity: "informational", title: "Grants on retired agents", limits: "Lifecycle only.", findings: [], notAssessable: [], counts: { findings: 0, notAssessable: 0 } },
  ],
  action: { openCampaign: { endpoint: "POST /v1/certification-campaigns", scope: { kind: "from_recommendations", value: "" }, note: "" } },
  judged: { enabled: false, note: "Model-judged annotations are off." },
};

const DECIDED_STATUS = "approved,denied,returned,consumed,superseded";
const OUTCOMES = ["approved", "denied", "returned", "consumed", "superseded"] as const;
const APPROVALS = [
  ...Array.from({ length: 37 }, (_, i) => ({
    id: `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`,
    status: OUTCOMES[i % 5]!,
    objectType: i % 3 ? "run" : "project",
    stageId: i % 3 ? "review" : "__project_budget__",
    requestedAt: at(i * 2 + 1),
    decidedAt: at(i * 2),
    userId: `u-${i % 5}`,
    approverUserId: "u-admin",
    requestedByName: `${PEOPLE[i % 5]} ${String(i).padStart(2, "0")}`,
    approverName: "Ada Admin",
    decidedByName: PEOPLE[(i + 2) % 5],
    decisionReason: `Checked against the policy (${i})`,
    objectLabel: `Decided item ${String(i).padStart(2, "0")}`,
  })),
  // pending rows the decided list must never show
  ...Array.from({ length: 3 }, (_, i) => ({
    id: `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`,
    status: "pending",
    objectType: "run",
    stageId: "review",
    requestedAt: at(i),
    decidedAt: null,
    userId: "u-1",
    approverUserId: "u-admin",
    requestedByName: "Pending requester",
    approverName: "Ada Admin",
    decidedByName: null,
    decisionReason: null,
    objectLabel: `Pending item ${i}`,
  })),
];

interface ListDef {
  rows: Json[];
  field: Record<string, string>;
  keysetSort?: string;
  filter?: (r: Json, q: URLSearchParams) => boolean;
  extra?: Json;
}
const LISTS: Record<string, ListDef> = {
  "/v1/usage-events": {
    rows: USAGE,
    keysetSort: "at",
    field: { at: "at", user: "userName", object: "objectType", agent: "agentName", model: "model", tokens: "inputTokens", cost: "costUsd", saved: "measuredCostSavedUsd", project: "projectId" },
  },
  "/v1/governance/decision-regression/cases": {
    rows: CASES,
    field: { label: "label", source: "source", tier: "outcome.tier", expect: "unmetExpectation.length", created: "createdAt", by: "createdByName" },
    extra: { versions: { euAiActRulesetVersion: 1, intakeAssistVersion: "2026-10-06.1" }, outcomeFields: [] },
  },
  "/v1/recommendations/access": {
    rows: FINDINGS,
    // the list pages the deterministic findings: no judged sort, and its verdicts come from the page's report read
    field: { holder: "holder.label", object: "object.label", why: "rationale" },
    filter: (_r, q) => q.get("rule") === "unused-grant",
    extra: { judgedFrom: "report" },
  },
  "/v1/approvals": {
    rows: APPROVALS,
    keysetSort: "requested",
    field: { requested: "requestedAt", decided: "decidedAt", status: "status", kind: "objectType", requester: "requestedByName", approver: "approverName", decider: "decidedByName" },
    filter: (r, q) => (q.get("status") ?? "").split(",").includes(String(r.status)),
  },
};
const pick = (r: Json, path: string) => path.split(".").reduce<unknown>((v, k) => (v as Json | null)?.[k], r) as string | number | null;

function contract(endpoint: string, q: URLSearchParams) {
  const list = LISTS[endpoint]!;
  const sort = q.get("sort")!;
  const dir = q.get("dir") === "asc" ? 1 : -1;
  const f = list.field[sort]!;
  const rows = list.rows
    .filter((r) => list.filter?.(r, q) ?? true)
    .sort((a, b) => {
      const x = pick(a, f) ?? null;
      const y = pick(b, f) ?? null;
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * dir;
    });
  const limit = Number(q.get("limit"));
  const start = q.get("cursor") ? Number(atob(q.get("cursor")!)) : Number(q.get("offset") ?? 0);
  const more = start + limit < rows.length;
  const keyset = sort === list.keysetSort;
  const count = q.get("count");
  return {
    items: rows.slice(start, start + limit),
    nextCursor: more && keyset ? btoa(String(start + limit)) : null,
    nextOffset: more && !keyset ? start + limit : null,
    total: count ? rows.length : null,
    totalIsEstimate: false,
    ...list.extra,
  };
}

interface Capture {
  lists: URL[];
  exports: URL[];
}

async function mockApi(page: Page): Promise<Capture> {
  const cap: Capture = { lists: [], exports: [] };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    if (p.endsWith("/export.xlsx")) {
      cap.exports.push(url);
      return route.fulfill({
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x-regulait-export-truncated": "0", "x-regulait-export-row-limit": "100000" },
        body: Buffer.from("PK\u0003\u0004"),
      });
    }
    if (LISTS[p] && req.method() === "GET" && url.searchParams.get("sort")) {
      cap.lists.push(url);
      return json(route, contract(p, url.searchParams));
    }
    // the legacy reads each page still makes beside its list
    if (p === "/v1/usage-events") return json(route, { events: USAGE.slice(0, 1), totals: USAGE_TOTALS });
    if (p === "/v1/cost-events") return json(route, { events: [], totals: [] });
    if (p === "/v1/recommendations/access") return json(route, REPORT);
    if (p === "/v1/governance/decision-regression/cases") return json(route, { cases: CASES, versions: { euAiActRulesetVersion: 1, intakeAssistVersion: "2026-10-06.1" }, outcomeFields: [] });
    if (p === "/v1/governance/decision-regression/runs") return json(route, { runs: [] });
    if (p === "/v1/annotations/inbox") return json(route, { items: [] });
    if (p === "/v1/users") return json(route, { users: [{ id: "u-admin", email: "ada@example.test", displayName: "Ada Admin" }] });
    if (p === "/v1/use-cases") return json(route, { useCases: [] });
    // the Inbox's pending queue (its own legacy read, oldest first): empty here
    if (p === "/v1/approvals") return json(route, { approvals: [], total: 0, hasMore: false, limit: 100 });
    return json(route, {});
  });
  return cap;
}

/** a secondary card folds only once its content is long enough to need it: open it when it is folded */
async function unfold(page: Page, title: string) {
  // a folded header carries its count and flags beside the title, so the title is matched as a prefix
  await expect(page.getByText(new RegExp(`^${title}`)).first()).toBeVisible();
  const fold = page.getByRole("button", { name: new RegExp(`^${title}`) });
  if ((await fold.count()) && (await fold.getAttribute("aria-expanded")) === "false") await fold.click();
}

interface PageDef {
  name: string;
  path: string;
  endpoint: string;
  noun: string;
  total: number;
  open: (page: Page) => Promise<void>;
  sortHeader: string;
  sortId: string;
  sortField: string;
  optional: string;
  optionalId: string;
  hide: string;
  hideId: string;
  required: string;
  filters?: Record<string, string>;
  /** the page holds more than one list: this one's `data-list` */
  listId?: string;
}
const PAGES: PageDef[] = [
  {
    name: "Optimization usage events",
    path: "/ui/admin/optimization",
    endpoint: "/v1/usage-events",
    noun: "usage events",
    total: USAGE.length,
    open: (page) => unfold(page, "Usage events — measured actuals"),
    sortHeader: "Model",
    sortId: "model",
    sortField: "model",
    optional: "User",
    optionalId: "user",
    hide: "Saved",
    hideId: "saved",
    required: "Project",
    // the cost events list sits above it on the same page
    listId: "usage-events",
  },
  {
    name: "golden cases",
    path: "/ui/admin/governance/decision-regression",
    endpoint: "/v1/governance/decision-regression/cases",
    noun: "golden cases",
    total: CASES.length,
    open: async (page) => {
      await page.getByRole("tab", { name: "Golden cases" }).click();
    },
    sortHeader: "Case",
    sortId: "label",
    sortField: "label",
    optional: "Added by",
    optionalId: "by",
    hide: "Tier now",
    hideId: "tier",
    required: "Expectation",
  },
  {
    name: "findings per rule",
    path: "/ui/admin/recommendations",
    endpoint: "/v1/recommendations/access",
    noun: "findings for unused-grant",
    total: FINDINGS.length,
    open: async () => {},
    sortHeader: "Holder",
    sortId: "holder",
    sortField: "holder.label",
    optional: "Evidence",
    optionalId: "evidence",
    hide: "Grant",
    hideId: "object",
    required: "",
    filters: { rule: "unused-grant" },
  },
  {
    name: "Inbox recently decided",
    path: "/ui/inbox",
    endpoint: "/v1/approvals",
    noun: "decisions",
    total: APPROVALS.filter((a) => a.status !== "pending").length,
    open: (page) => unfold(page, "Recently decided"),
    sortHeader: "Requested by",
    sortId: "requester",
    sortField: "requestedByName",
    optional: "Approver",
    optionalId: "approver",
    hide: "Reason",
    hideId: "reason",
    required: "Status",
    filters: { status: DECIDED_STATUS },
  },
];

const list = (page: Page, P?: PageDef): Locator => page.locator(P?.listId ? `[data-list="${P.listId}"]` : "[data-list]").first();
const status = (page: Page, P?: PageDef) => list(page, P).getByTestId("list-status");
const lastList = (cap: Capture, endpoint: string) => [...cap.lists].reverse().find((u) => u.pathname === endpoint)!;
const headers = async (page: Page, P?: PageDef) => (await list(page, P).locator("table thead th").allInnerTexts()).map((t) => t.replace(/[▲▼]/g, "").trim()).filter(Boolean);
const n = (x: number) => x.toLocaleString("en-GB");

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 1000))]);
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((x) => x.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

async function openList(page: Page, P: PageDef) {
  await page.goto(P.path);
  await P.open(page);
  await expect(status(page, P)).toHaveText(`1–10 of ${n(P.total)}`);
}

for (const P of PAGES) {
  test.describe(`list control on ${P.name}`, () => {
    test("page sizes 10, 50, 100 and All, Previous and Next, with the page's filters", async ({ page }) => {
      const cap = await mockApi(page);
      await openList(page, P);
      const first = lastList(cap, P.endpoint);
      expect(first.searchParams.get("limit")).toBe("10");
      for (const [k, v] of Object.entries(P.filters ?? {})) expect(first.searchParams.get(k)).toBe(v);
      await expect(list(page, P).locator("tbody tr")).toHaveCount(10);
      await list(page, P).getByRole("button", { name: "Next", exact: true }).click();
      await expect(status(page, P)).toHaveText(`11–20 of ${n(P.total)}`);
      await list(page, P).getByRole("button", { name: "Previous", exact: true }).click();
      await expect(status(page, P)).toHaveText(`1–10 of ${n(P.total)}`);
      const size = list(page, P).getByLabel("Rows per page");
      for (const s of [50, 100]) {
        await size.selectOption(String(s));
        const shown = Math.min(s, P.total);
        await expect(status(page, P)).toHaveText(`1–${shown} of ${n(P.total)}`);
        expect(lastList(cap, P.endpoint).searchParams.get("limit")).toBe(String(s));
      }
      await size.selectOption("all");
      await expect(status(page, P)).toHaveText(`Loaded ${n(P.total)} of ${n(P.total)}`);
      expect(lastList(cap, P.endpoint).searchParams.get("limit")).toBe("500");
      await expect(list(page, P).locator("tbody tr")).toHaveCount(P.total);
    });

    test("a header click asks the server for the sort and direction; Refresh refetches", async ({ page }) => {
      const cap = await mockApi(page);
      await openList(page, P);
      const th = list(page, P).locator("thead th").filter({ has: page.getByRole("button", { name: P.sortHeader, exact: true }) });
      const button = th.getByRole("button", { name: P.sortHeader, exact: true });
      const firstDir = lastList(cap, P.endpoint).searchParams.get("sort") === P.sortId ? (lastList(cap, P.endpoint).searchParams.get("dir") === "asc" ? "desc" : "asc") : "asc";
      await button.click();
      await expect.poll(() => lastList(cap, P.endpoint).searchParams.get("sort")).toBe(P.sortId);
      await expect.poll(() => lastList(cap, P.endpoint).searchParams.get("dir")).toBe(firstDir);
      await expect(th).toHaveAttribute("aria-sort", firstDir === "asc" ? "ascending" : "descending");
      await button.click();
      const second = firstDir === "asc" ? "desc" : "asc";
      // the second direction may already be cached (it can be the default), so the header says which one is on screen
      await expect(th).toHaveAttribute("aria-sort", second === "asc" ? "ascending" : "descending");
      // the first row is the server's answer over every row, not a re-sort of the page on screen
      const top = contract(P.endpoint, new URLSearchParams({ ...P.filters, limit: "10", sort: P.sortId, dir: second })).items[0]!;
      await expect(list(page, P).locator("tbody tr").first()).toContainText(String(pick(top, P.sortField)));
      const before = cap.lists.filter((u) => u.pathname === P.endpoint).length;
      await list(page, P).getByRole("button", { name: `Refresh ${P.noun}` }).click();
      await expect.poll(() => cap.lists.filter((u) => u.pathname === P.endpoint).length).toBe(before + 1);
      // Refresh asks again for exactly the page on screen
      expect(lastList(cap, P.endpoint).searchParams.get("sort")).toBe(P.sortId);
      expect(lastList(cap, P.endpoint).searchParams.get("dir")).toBe(second);
      expect(lastList(cap, P.endpoint).searchParams.get("limit")).toBe("10");
    });

    test("the gear hides and shows a column, a required one stays, and Excel asks for the screen's columns in order", async ({ page }) => {
      const cap = await mockApi(page);
      await openList(page, P);
      expect(await headers(page, P)).toContain(P.hide);
      expect(await headers(page, P)).not.toContain(P.optional);
      const gear = list(page, P).getByRole("button", { name: `Choose columns for ${P.noun}` });
      await gear.click();
      const dialog = page.getByRole("dialog", { name: `Columns for ${P.noun}` });
      await expect(dialog).toBeVisible();
      if (P.required) {
        const required = dialog.getByRole("checkbox", { name: new RegExp(`^${P.required}`) });
        await expect(required).toBeDisabled();
        await expect(required).toBeChecked();
        await expect(dialog.getByText(/always shown/).first()).toBeVisible();
      }
      await expectAxeClean(page, `${P.name} column picker`);
      await dialog.getByRole("checkbox", { name: new RegExp(`^${P.hide}`) }).uncheck();
      await dialog.getByRole("checkbox", { name: new RegExp(`^${P.optional}`) }).check();
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(gear).toBeFocused();
      const after = await headers(page, P);
      expect(after).toContain(P.optional);
      expect(after).not.toContain(P.hide);
      if (P.required) expect(after).toContain(P.required);

      await list(page, P).getByRole("button", { name: "Download Excel" }).click();
      await expect.poll(() => cap.exports.length).toBe(1);
      const ex = cap.exports[0]!;
      expect(ex.pathname).toBe(`${P.endpoint}/export.xlsx`);
      const cols = ex.searchParams.get("columns")!.split(",");
      expect(cols).toContain(P.optionalId);
      expect(cols).not.toContain(P.hideId);
      // action columns are never exported
      expect(cols).not.toContain("act");
      expect(cols).toHaveLength(after.length);
      for (const [k, v] of Object.entries(P.filters ?? {})) expect(ex.searchParams.get(k)).toBe(v);
      expect(ex.searchParams.get("sort")).toBe(lastList(cap, P.endpoint).searchParams.get("sort"));
      expect(ex.searchParams.get("dir")).toBe(lastList(cap, P.endpoint).searchParams.get("dir"));
      await expect(page.getByText("Excel file downloaded")).toBeVisible();
    });

    test("the list is axe clean in light and dark", async ({ page }) => {
      await mockApi(page);
      await openList(page, P);
      await expectAxeClean(page, `${P.name} list`);
    });
  });
}

test.describe("access recommendations: a rule's list shows the report's verdicts, never its own (#681 review)", () => {
  test("the verdict on a row comes from the one report read, by key; the list read carries none", async ({ page }) => {
    const cap = await mockApi(page);
    const judged = { method: "model-judged", verdict: "agree", note: "the evidence supports this", judge: "test:judge", judgedAt: at(0) };
    const key = FINDINGS[0]!.key;
    // registered after mockApi, so it wins: only the report read is judged
    await page.route(
      (u) => u.pathname === "/v1/recommendations/access" && !u.searchParams.get("sort"),
      (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ...REPORT,
            rules: REPORT.rules.map((r) => ({ ...r, findings: r.findings.map((f) => (f.key === key ? { ...f, judged } : f)) })),
            judged: { enabled: true, status: "judged", judge: "test:judge", annotated: 1, note: "One finding carries a model-judged annotation." },
          }),
        }),
    );
    await page.goto("/ui/admin/recommendations");
    const list = page.locator('[data-list="access-recommendation-findings"]');
    await expect(list.getByRole("row", { name: new RegExp(FINDINGS[0]!.holder.label) }).getByText("model-judged: agree").first()).toBeVisible();
    expect(cap.lists.filter((u) => u.pathname === "/v1/recommendations/access").length).toBeGreaterThan(0);
    // the judged column is not a server sort any more
    await expect(list.getByRole("button", { name: /Model-judged/ })).toHaveCount(0);
  });
});

test.describe("the Inbox's Recently decided folds over the list control (X6b, listControl)", () => {
  const decidedReads = (cap: Capture) => cap.lists.filter((u) => u.pathname === "/v1/approvals");
  const card = (page: Page) => page.locator("section[data-rg-card]").filter({ hasText: "Recently decided" });

  test("starts folded and unread, opens to the list, folds again with its page size kept, and is axe clean", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/inbox");
    const fold = page.getByRole("button", { name: /^Recently decided/ });
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    // the first load does not pay for the decided list: nothing is read, and no list or count is on the page
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    expect(decidedReads(cap)).toEqual([]);
    await expect(page.locator("[data-list]")).toHaveCount(0);
    await expect(fold).not.toContainText(/\d+ decisions?/);
    await expectAxeClean(page, "Inbox, Recently decided folded");

    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    const total = APPROVALS.filter((a) => a.status !== "pending").length;
    await expect(status(page)).toHaveText(`1–10 of ${n(total)}`);
    expect(decidedReads(cap).every((u) => u.searchParams.get("status") === DECIDED_STATUS)).toBe(true);
    await expect(card(page).getByText("Pending item", { exact: false })).toHaveCount(0);
    // once read, the folded header keeps the server's count
    await expect(fold).toContainText(`${total} decisions`);

    // the page-size select does not stop the fold: change it, fold, reopen, and the choice is kept
    await list(page).getByLabel("Rows per page").selectOption("50");
    await expect(status(page)).toHaveText(`1–${total} of ${n(total)}`);
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(list(page)).toBeHidden();
    await expect(fold).toContainText(`${total} decisions`);
    await fold.click();
    await expect(list(page).getByLabel("Rows per page")).toHaveValue("50");
    await expect(status(page)).toHaveText(`1–${total} of ${n(total)}`);

    // sort on the server, then the download asks for the same sort and filters
    await list(page).getByRole("button", { name: "Decided by", exact: true }).click();
    await expect.poll(() => lastList(cap, "/v1/approvals").searchParams.get("sort")).toBe("decider");
    await list(page).getByRole("button", { name: "Download Excel" }).click();
    await expect.poll(() => cap.exports.length).toBe(1);
    const ex = cap.exports[0]!;
    expect(ex.pathname).toBe("/v1/approvals/export.xlsx");
    expect(ex.searchParams.get("status")).toBe(DECIDED_STATUS);
    expect(ex.searchParams.get("sort")).toBe("decider");
    expect(ex.searchParams.get("columns")!.split(",")).toEqual(["item", "status", "requester", "decider", "decided", "reason"]);
    await expect(page.getByText("Excel file downloaded")).toBeVisible();
    await expectAxeClean(page, "Inbox, Recently decided open");
  });

  test("a failed read shows the list's error with Retry, and the section stays open", async ({ page }) => {
    let fail = true;
    const cap = await mockApi(page);
    await page.route(/\/v1\/approvals\?.*sort=/, async (route) => {
      if (!fail) return route.fallback();
      return json(route, { error: "unavailable" }, 503);
    });
    await page.goto("/ui/inbox");
    await page.getByRole("button", { name: /^Recently decided/ }).click();
    const alert = card(page).getByRole("alert");
    await expect(alert).toContainText("Couldn't load this list");
    // an error is never folded away: the section has no fold while it shows one
    await expect(page.getByRole("button", { name: /^Recently decided/ })).toHaveCount(0);
    fail = false;
    await alert.getByRole("button", { name: "Retry" }).click();
    await expect(status(page)).toHaveText(/^1–10 of /);
    expect(decidedReads(cap).length).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: /^Recently decided/ })).toHaveAttribute("aria-expanded", "true");
  });
});

test.describe("Optimization's usage events fold over the list control (X6b, listControl)", () => {
  const TITLE = "Usage events — measured actuals";
  const usageReads = (cap: Capture) => cap.lists.filter((u) => u.pathname === "/v1/usage-events");
  const fold = (page: Page) => page.getByRole("button", { name: new RegExp(`^${TITLE}`) });

  test("starts folded with the totals' count and flags, reads nothing until opened, and is axe clean", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/optimization");
    await expect(fold(page)).toHaveAttribute("aria-expanded", "false");
    // the count and the flags come from the totals read, which covers every row: nothing that warns is folded away
    await expect(fold(page)).toContainText(`${USAGE_TOTALS.events} events`);
    await expect(fold(page)).toContainText(`${USAGE_TOTALS.unattributed} unattributed`);
    await expect(fold(page)).toContainText(`${USAGE_TOTALS.refused} refused`);
    // the cost events list beside it loads; the usage events list is never read while folded
    await expect(page.locator('[data-list="cost-events"]')).toBeVisible();
    expect(usageReads(cap)).toEqual([]);
    await expect(page.locator('[data-list="usage-events"]')).toHaveCount(0);
    await expectAxeClean(page, "Optimization, usage events folded");

    await fold(page).click();
    await expect(fold(page)).toHaveAttribute("aria-expanded", "true");
    const usage = page.locator('[data-list="usage-events"]');
    await expect(usage.getByTestId("list-status")).toHaveText(`1–10 of ${n(USAGE.length)}`);
    expect(usageReads(cap).length).toBeGreaterThan(0);
    // the row-level badges are still there once open
    await expect(usage.getByText("unattributed", { exact: true }).first()).toBeVisible();
    await expectAxeClean(page, "Optimization, usage events open");
  });

  test("the fold is remembered across navigation, and a folded return reads nothing", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/optimization");
    await fold(page).click();
    await expect(page.locator('[data-list="usage-events"]').getByTestId("list-status")).toHaveText(/^1–10 of /);
    await page.goto("/ui/inbox");
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await page.goto("/ui/admin/optimization");
    await expect(fold(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-list="usage-events"]').getByTestId("list-status")).toHaveText(/^1–10 of /);

    await fold(page).click();
    await expect(fold(page)).toHaveAttribute("aria-expanded", "false");
    await page.goto("/ui/inbox");
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    const before = usageReads(cap).length;
    await page.goto("/ui/admin/optimization");
    await expect(fold(page)).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator('[data-list="cost-events"]')).toBeVisible();
    expect(usageReads(cap).length).toBe(before);
  });

  test("a failed totals read is said outside the fold with Retry, and the count is unknown, never 0", async ({ page }) => {
    let fail = true;
    await mockApi(page);
    await page.route(
      (u) => u.pathname === "/v1/usage-events" && !u.searchParams.get("sort") && u.searchParams.get("format") !== "csv",
      (route) => (fail ? json(route, { error: "unavailable" }, 503) : route.fallback()),
    );
    await page.goto("/ui/admin/optimization");
    const alert = page.getByRole("alert").filter({ hasText: "Couldn't load the usage totals" });
    await expect(alert).toBeVisible({ timeout: 15_000 });
    await expect(fold(page)).toHaveAttribute("aria-expanded", "false");
    await expect(fold(page)).not.toContainText(/\d+ events?/);
    await expectAxeClean(page, "Optimization, usage totals failed");
    fail = false;
    await alert.getByRole("button", { name: "Retry" }).click();
    await expect(fold(page)).toContainText(`${USAGE_TOTALS.events} events`);
    await expect(alert).toHaveCount(0);
  });
});
