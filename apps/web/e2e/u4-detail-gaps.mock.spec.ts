/**
 * Batch U4 — the detail and history views for the last backend reads with no
 * screen, against a mocked gateway answering with the live route shapes:
 * decision receipts (list + one decision), an imported cost batch, editing a
 * model card, red-team posture / findings / per-trial record / attach as
 * evidence, one prompt commit, an initiative, a training job, billing rate
 * card / statement / full history, report definition / run / run history,
 * the boot schedulers' health, and the spend monitor's full lists.
 *
 * Each pins the request it sends (path and query, or the exact body), a
 * refusal in words, and axe (light and dark) on the new surface.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { installPromptsMock, H1, P1 } from "./prompts-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000d4`;
const T = "2026-10-11T12:00:00.000Z";
const ME = U(99);

type Handler = (body: Json, url: URL) => { status?: number; body: unknown } | unknown;
interface Mock {
  calls: Array<{ method: string; path: string; search: string; body: Json; headers: Record<string, string> }>;
}

const AUTH_ME = {
  userId: ME,
  isAdmin: true,
  via: "session",
  user: { id: ME, email: "ada@example.test", username: null, displayName: "Ada Admin" },
  mustChangePassword: false,
  totpEnabled: true,
  passwordSet: true,
  mfaSetupRequired: false,
};
const USERS = { users: [{ id: ME, email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null, createdAt: T, totpEnabled: true, hasPassword: true }] };

async function mockApi(page: Page, routes: Record<string, Handler | unknown>): Promise<Mock> {
  const table = new Map<string, Handler | unknown>(Object.entries(routes));
  const m: Mock = { calls: [] };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    let body: Json;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    m.calls.push({ method: req.method(), path: p, search: url.search, body, headers: req.headers() });
    const h = table.get(`${req.method()} ${p}`);
    if (h === undefined) {
      if (p === "/auth/me" || p === "/v1/me") return json(route, AUTH_ME);
      if (p === "/v1/users") return json(route, USERS);
      if (p === "/v1/me/ai-literacy") return json(route, { required: false, current: true, documents: [], gateMode: "enforce", exempt: null, noticeDays: 14 });
      if (p === "/v1/approvals") return json(route, { approvals: [] });
      if (p === "/v1/projects") return json(route, { projects: [{ id: U(30), name: "Atlas" }, { id: U(31), name: "Beacon" }] });
      return json(route, {});
    }
    const out = typeof h === "function" ? (h as Handler)(body, url) : h;
    if (out && typeof out === "object" && "status" in (out as object) && "body" in (out as object)) {
      const o = out as { status: number; body: unknown };
      return json(route, o.body, o.status);
    }
    return json(route, out);
  });
  return m;
}
const calls = (m: Mock, method: string, path: string) => m.calls.filter((c) => c.method === method && c.path === path);

async function expectAxeClean(page: Page, label: string, scope?: string | Locator) {
  let include = typeof scope === "string" ? scope : undefined;
  if (scope && typeof scope !== "string") {
    await page.evaluate(() => document.querySelectorAll("[data-axe-scope]").forEach((el) => el.removeAttribute("data-axe-scope")));
    await scope.evaluate((el) => el.setAttribute("data-axe-scope", ""));
    include = "[data-axe-scope]";
  }
  for (const theme of ["light", "dark"] as const) {
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

// ---------------------------------------------------------------------------
// 1-2: decision receipts
// ---------------------------------------------------------------------------

const AUDIT_ID = U(7);
const envelope = (seq: number) => ({
  receiptSeq: seq,
  payload: {
    v: 1,
    receiptSeq: seq,
    audit: { id: seq === 2 ? AUDIT_ID : U(100 + seq), seq: 40 + seq, rowHash: "r".repeat(8), contentHash: "c".repeat(8) },
    decision: { at: T, userId: ME, objectType: "agent", objectId: U(8), serverId: null, toolName: null, effect: seq % 2 ? "allow" : "deny", ruleId: "default-deny" },
    prev: "p".repeat(64),
    keyId: "receipt-key-1",
  },
  signature: "s".repeat(86),
  keyId: "receipt-key-1",
});

test.describe("U4: decision receipts", () => {
  test("lists a page on request, pages on, opens one decision's receipt, and names a refusal", async ({ page }) => {
    const m = await mockApi(page, {
      "GET /v1/receipts/status": { state: "signing", lastSeq: 27, lagRows: 0 },
      "GET /v1/audit": { entries: [], pageSize: 100, hasMore: false, nextCursor: null },
      "GET /v1/audit/retention": { days: 365, oldestAt: null, count: 0 },
      // ADR-0219: the receipts list under the shared list contract (fromSeq stays a filter; offset paging by seq)
      "GET /v1/receipts": (_b: Json, url: URL) => {
        const from = Number(url.searchParams.get("fromSeq") ?? 1);
        const limit = Number(url.searchParams.get("limit"));
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const all = Array.from({ length: Math.max(0, 27 - from + 1) }, (_, i) => envelope(from + i));
        const more = offset + limit < all.length;
        return { items: all.slice(offset, offset + limit), nextCursor: null, nextOffset: more ? offset + limit : null, total: url.searchParams.get("count") ? all.length : null, totalIsEstimate: false };
      },
      [`GET /v1/receipts/${AUDIT_ID}`]: { receipts: [envelope(2)] },
      [`GET /v1/receipts/${U(9)}`]: { receipts: [] },
    });
    await page.goto("/ui/admin/audit");
    await page.locator("summary", { hasText: "Signed decision receipts" }).click();
    await expect(page.getByText("Signed decision receipts", { exact: true })).toBeVisible();
    // audited reads: nothing listed until asked
    expect(calls(m, "GET", "/v1/receipts")).toHaveLength(0);
    await page.getByRole("button", { name: "Show receipts" }).click();
    const receipts = page.locator('[data-list="decision-receipts"]');
    await expect(receipts.getByTestId("list-status")).toHaveText("1–10 of 27");
    const asked = () => calls(m, "GET", "/v1/receipts").map((c) => new URLSearchParams(c.search));
    expect(asked()).toHaveLength(1);
    expect(Object.fromEntries(asked()[0]!)).toMatchObject({ fromSeq: "1", limit: "10", sort: "seq", dir: "asc" });
    await receipts.getByRole("button", { name: "Next", exact: true }).click();
    await expect(receipts.getByTestId("list-status")).toHaveText("11–20 of 27");
    expect(asked().at(-1)!.get("offset")).toBe("10");
    await receipts.getByRole("button", { name: "Next", exact: true }).click();
    await expect(receipts.getByTestId("list-status")).toHaveText("21–27 of 27");
    await expect(receipts.getByRole("button", { name: "Next", exact: true })).toHaveAttribute("aria-disabled", "true");
    // a later start is a filter on the server
    await page.getByLabel("Start at receipt sequence").fill("26");
    await page.getByRole("button", { name: "Show receipts" }).click();
    await expect(receipts.getByTestId("list-status")).toHaveText("1–2 of 2");
    expect(asked().at(-1)!.get("fromSeq")).toBe("26");
    await page.getByLabel("Start at receipt sequence").fill("1");
    await page.getByRole("button", { name: "Show receipts" }).click();
    await expect(receipts.getByTestId("list-status")).toHaveText("1–10 of 27");

    await page.getByRole("button", { name: "Open receipt 2", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Decision receipt" });
    await expect(dialog.getByText("receipt-key-1", { exact: true })).toBeVisible();
    await expect(dialog.getByText("default-deny", { exact: true })).toBeVisible();
    await expectAxeClean(page, "decision receipt dialog", '[role="dialog"]');
    await dialog.getByRole("button", { name: "Close" }).click();

    // a malformed id never leaves the page; an unsigned decision says so
    await page.getByLabel("Audit row ID for a decision receipt").fill("42");
    await page.getByRole("button", { name: "Open receipt", exact: true }).click();
    await expect(page.getByText("Enter the decision's audit row ID (a UUID). It is not the receipt sequence.")).toBeVisible();
    await page.getByLabel("Audit row ID for a decision receipt").fill(U(9));
    await page.getByRole("button", { name: "Open receipt", exact: true }).click();
    await expect(page.getByText("No signed receipt for this decision")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await expectAxeClean(page, "receipt browser", page.locator("[data-rg-card]").filter({ hasText: "Browse signed receipts" }).first());
  });

  test("a refused page is said as an error, never as an empty list", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/receipts/status": { state: "signing", lastSeq: 3, lagRows: 0 },
      "GET /v1/audit": { entries: [], pageSize: 100, hasMore: false, nextCursor: null },
      "GET /v1/receipts": { status: 400, body: { error: "invalid_receipt_range" } },
    });
    await page.goto("/ui/admin/audit");
    await page.locator("summary", { hasText: "Signed decision receipts" }).click();
    await page.getByRole("button", { name: "Show receipts" }).click();
    await expect(page.locator('[data-list="decision-receipts"]').getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText(/^No receipts from sequence/)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 3: an imported cost batch
// ---------------------------------------------------------------------------

test.describe("U4: imported cost batch", () => {
  test("opens a batch with its lines; a missing batch is named", async ({ page }) => {
    const batch = { id: U(40), adapter: "generic_mapped", vendor: "acme-ai", format: "csv", mode: "apply", status: "applied", source: "invoice-2026-09.csv", rowsParsed: 2, rowsAccepted: 2, rowsRefused: 0, totalUsd: 30, reason: "applied", createdAt: T };
    await mockApi(page, {
      "GET /v1/cost-imports/adapters": { adapters: [], basisStatement: "Imported, not metered." },
      "GET /v1/cost-imports": { imports: [batch, { ...batch, id: U(41), status: "revoked" }], basisStatement: "Imported, not metered." },
      "GET /v1/cost-imports/mappings": { aliases: [], domainRules: [], posture: "" },
      "GET /v1/cost-consolidated": { status: 500, body: { error: "internal" } },
      "GET /v1/cost-imports/reconciliation": { status: 500, body: { error: "internal" } },
      [`GET /v1/cost-imports/${U(40)}`]: {
        import: { ...batch, payloadSha256: "a".repeat(64), periodStart: T, periodEnd: T, appliedAt: T, revokedAt: null },
        lines: [
          { id: U(42), sourceRow: 2, accountRef: "ada@example.test", resolvedUserId: ME, resolutionMethod: "exact_email", resolutionDetail: "exact", costCenter: "CC-1", periodStart: T, periodEnd: T, amount: 20, currency: "USD", billingKind: "seat", service: "chat seats", description: null, quantity: 1 },
          { id: U(43), sourceRow: 3, accountRef: "ghost@vendor.test", resolvedUserId: null, resolutionMethod: "unresolved", resolutionDetail: "no match", costCenter: null, periodStart: T, periodEnd: T, amount: 10, currency: "USD", billingKind: "usage", service: null, description: "api", quantity: null },
        ],
        linesTruncated: false,
        basisStatement: "IMPORTED cost is what a vendor file says.",
      },
      [`GET /v1/cost-imports/${U(41)}`]: { status: 404, body: { error: "unknown_import" } },
    });
    await page.goto("/ui/admin/cost-consolidation");
    await page.getByRole("button", { name: /Open the acme-ai import/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Imported cost batch" });
    await expect(dialog.getByText("IMPORTED cost is what a vendor file says.")).toBeVisible();
    await expect(dialog.getByText("ghost@vendor.test")).toBeVisible();
    await expect(dialog.getByText("unattributed")).toBeVisible();
    await expectAxeClean(page, "import batch dialog", '[role="dialog"]');
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: /Open the acme-ai import/ }).nth(1).click();
    await expect(page.getByRole("dialog").getByText("No such import batch")).toBeVisible();
    await expect(page.getByRole("dialog").getByText(/There is no import batch with this ID/)).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Retry" })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 4: edit a model card
// ---------------------------------------------------------------------------

const CARD = U(50);
const card = {
  id: CARD,
  agentId: U(51),
  customProviderId: null,
  intendedUse: "Contract clause triage",
  limitations: "English only",
  note: null,
  dataClaims: { retention: "30 days" },
  biasFairness: [],
  standardRefs: ["nist-ai-rmf:MAP-1.1"],
  pinnedModelVersion: null,
  state: "unsigned",
  daysUntilExpiry: null,
  subjectKind: "agent",
  subjectName: "Clause triage",
  subjectModel: null,
  approvals: [],
  evidence: [],
  completeness: { complete: false, missing: ["sign_off"], bias: { declared: 0, assessed: 0, waived: 0, unevidenced: 0, complete: false, disclaimer: "declared, not measured" } },
  createdAt: T,
};
const MRM = {
  "GET /v1/mrm/status": { enforced: false, warnDays: 30, stalenessRecertEnabled: true, stalenessRecertThreshold: 1, posture: "declared", label: "declared", cards: 1, approved: 0, expiring: 0, expired: 0, pending: 0, unsigned: 1, revoked: 0, note: "" },
  "GET /v1/mrm/expiring": { warnDays: 30, items: [] },
  "GET /v1/mrm/cards": { cards: [card], enforced: false },
  [`GET /v1/mrm/cards/${CARD}`]: { card: { ...card, autofill: null, staleness: null } },
};

test.describe("U4: edit a model card", () => {
  test("sends only the edited fields, after listing them; a refusal is named", async ({ page }) => {
    let patches = 0;
    const m = await mockApi(page, {
      ...MRM,
      [`PATCH /v1/mrm/cards/${CARD}`]: (b: Json) => {
        patches += 1;
        if (patches === 1) return { status: 422, body: { error: "pinned_version_invalid", detail: "the agent serves model-a" } };
        return { card: { ...card, ...b } };
      },
    });
    await page.goto("/ui/admin/model-risk");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByRole("button", { name: "Edit card" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit the model card for Clause triage" });
    await expect(dialog.getByRole("button", { name: "Nothing to save" })).toBeDisabled();
    await dialog.getByLabel("Intended use").fill("Contract clause triage and routing");
    await dialog.getByLabel("Known limitations").fill("");
    await dialog.getByLabel("Pinned model version (blank = not pinned)").fill("model-x-2026");
    await expect(dialog.getByText("This save changes:")).toContainText("Intended use, Known limitations, Pinned model version");
    await expectAxeClean(page, "model card edit dialog", '[role="dialog"]');
    await dialog.getByRole("button", { name: "Save 3 changes" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "does not match the model this card's agent serves" })).toBeVisible();
    await dialog.getByLabel("Pinned model version (blank = not pinned)").fill("");
    await dialog.getByRole("button", { name: "Save 2 changes" }).click();
    await expect(dialog).toHaveCount(0);
    expect(calls(m, "PATCH", `/v1/mrm/cards/${CARD}`).map((c) => c.body)).toEqual([
      { intendedUse: "Contract clause triage and routing", limitations: null, pinnedModelVersion: "model-x-2026" },
      { intendedUse: "Contract clause triage and routing", limitations: null },
    ]);
  });

  test("bad JSON in data claims blocks the save with a reason", async ({ page }) => {
    await mockApi(page, MRM);
    await page.goto("/ui/admin/model-risk");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByRole("button", { name: "Edit card" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit the model card for Clause triage" });
    await dialog.getByLabel("Provider data claims (JSON)").fill("{");
    await expect(dialog.getByRole("alert")).toContainText("Provider data claims are not valid JSON.");
  });
});

// ---------------------------------------------------------------------------
// 5-8: red-teaming
// ---------------------------------------------------------------------------

const RUN = U(60);
const RUN_ROW = {
  id: RUN, libraryName: "core", libraryVersion: 1, agentName: "Clause triage", trigger: "manual", probes: 4, resisted: 3, defeated: 1, resistRate: 0.75,
  gatePassed: false, regression: false, gateReason: "1 probe got through", classSummary: [], startedAt: T,
};
function redteamRoutes(extra: Record<string, unknown> = {}) {
  return {
    "GET /v1/redteam/attack-classes": { attackClasses: [{ id: "jailbreak", summary: "s", limits: "l" }, { id: "prompt_injection", summary: "s", limits: "l" }], disclosure: "Green never means safe.", scheduling: { schedulerEnabled: false, posture: "off", note: "n" } },
    "GET /v1/redteam/libraries": { libraries: [], note: "" },
    "GET /v1/redteam/runs": { runs: [RUN_ROW] },
    "GET /v1/redteam/summary": {
      runs: 1, regressions: 0, failed: 1, findings: 1, bySeverity: { low: 0, medium: 0, high: 1, critical: 0 }, byClass: { jailbreak: 1 }, totalCostUsd: 0.12,
      recent: [{ id: RUN, agentName: "Clause triage", libraryName: "core", libraryVersion: 1, trigger: "manual", probes: 4, defeated: 1, resistRate: 0.75, gatePassed: false, regression: false, startedAt: T, by: "ada@example.test" }],
      disclosure: "Green never means safe.",
    },
    "GET /v1/redteam/findings": {
      findings: [{ finding: { id: U(61), runId: RUN, probeKey: "jb-roleplay", attackClass: "jailbreak", severity: "high", score: 0, outputSnippet: "Sure, here is" }, agentName: "Clause triage", libraryName: "core", libraryVersion: 1, startedAt: T }],
      disclosure: "Green never means safe.",
    },
    [`GET /v1/redteam/runs/${RUN}`]: { run: RUN_ROW, classes: [], findings: [], evalRun: null, baseline: null, modelCardEvidence: [], disclosure: "d" },
    [`GET /v1/redteam/runs/${RUN}/trials`]: {
      run: { id: RUN, trials: 2, measurementQuality: "multi-trial", asr: 0.25, asrTrials: 8, asrLower: 0.07, asrUpper: 0.59, notRunProbes: 0, platformHeld: 0, corpusVersion: 1, presetTightened: [] },
      trials: [{ id: U(62), trial: 1, probes: 4, defeated: 1, errored: 0, costUsd: 0.06, startedAt: T }, { id: U(63), trial: 2, probes: 4, defeated: 1, errored: 0, costUsd: 0.06, startedAt: T }],
      probeTrials: [
        { probeKey: "jb-roleplay", attackClass: "jailbreak", severity: "high", trial: 1, defeated: true, error: null },
        { probeKey: "jb-roleplay", attackClass: "jailbreak", severity: "high", trial: 2, defeated: false, error: null },
        { probeKey: "pi-basic", attackClass: "prompt_injection", severity: "medium", trial: 1, defeated: false, error: null },
        { probeKey: "pi-basic", attackClass: "prompt_injection", severity: "medium", trial: 2, defeated: false, error: null },
      ],
      probeStats: [],
      asrDisclosure: "An ASR is a rate over these trials only.",
      disclosure: "d",
    },
    "GET /v1/mrm/cards": { cards: [card], enforced: false },
    ...extra,
  };
}

test.describe("U4: red-teaming", () => {
  test("posture and standing findings, filtered with the route's own query", async ({ page }) => {
    const m = await mockApi(page, redteamRoutes());
    await page.goto("/ui/admin/redteam");
    await expect(page.getByText("Posture — what got through recently")).toBeVisible();
    await expect(page.getByText("By attack class: jailbreak 1")).toBeVisible();
    await expect(page.getByRole("cell", { name: "jb-roleplay", exact: true })).toBeVisible();
    await page.getByLabel("Severity", { exact: true }).selectOption("high");
    await page.getByLabel("Attack class", { exact: true }).selectOption("jailbreak");
    await expect.poll(() => calls(m, "GET", "/v1/redteam/findings").at(-1)?.search).toBe("?limit=100&attackClass=jailbreak&severity=high");
    await expectAxeClean(page, "red-team posture and findings", page.locator("[data-rg-card]").filter({ hasText: "Posture — what got through recently" }).first());
    await expectAxeClean(page, "red-team findings", page.locator("[data-rg-card]").filter({ hasText: "Standing findings" }).first());
  });

  test("a run's per-trial record shows the flap; attaching it as evidence confirms, sends, and names a refusal", async ({ page }) => {
    let n = 0;
    const m = await mockApi(
      page,
      redteamRoutes({
        [`POST /v1/redteam/runs/${RUN}/evidence`]: () => {
          n += 1;
          if (n === 1) return { status: 409, body: { error: "evidence_already_attached" } };
          return { status: 201, body: { evidence: { id: U(64) } } };
        },
      }),
    );
    await page.goto("/ui/admin/redteam");
    await page.getByRole("button", { name: "Open the run of core against Clause triage" }).click();
    await expect(page.getByText("25.0% (95% CI 7.0%–59.0%) over 8 trials")).toBeVisible();
    await expect(page.getByText("flapped between trials")).toBeVisible();
    await page.getByLabel("Model card", { exact: true }).selectOption(CARD);
    await page.getByLabel("Label (optional)").fill("Sept red-team");
    await page.getByRole("button", { name: "Attach as evidence" }).click();
    const confirm = page.getByRole("dialog", { name: "Attach this run to the model card?" });
    await expectAxeClean(page, "attach confirmation", '[role="dialog"]');
    await confirm.getByRole("button", { name: "Attach evidence" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "already cited on that model card" })).toBeVisible();
    await page.getByRole("button", { name: "Attach as evidence" }).click();
    await page.getByRole("dialog", { name: "Attach this run to the model card?" }).getByRole("button", { name: "Attach evidence" }).click();
    await expect.poll(() => calls(m, "POST", `/v1/redteam/runs/${RUN}/evidence`).length).toBe(2);
    expect(calls(m, "POST", `/v1/redteam/runs/${RUN}/evidence`).map((c) => c.body)).toEqual([
      { cardId: CARD, label: "Sept red-team" },
      { cardId: CARD, label: "Sept red-team" },
    ]);
    await expectAxeClean(page, "run detail with trials and evidence", page.locator("[data-rg-card]").filter({ hasText: "Run detail" }).first());
  });
});

// ---------------------------------------------------------------------------
// 9: one prompt commit
// ---------------------------------------------------------------------------

test.describe("U4: prompt commit by hash", () => {
  test("viewing a commit reads it on its own; an unknown hash is named", async ({ page }) => {
    await installPromptsMock(page);
    const seen: string[] = [];
    page.on("request", (r) => {
      if (/\/commits\/[0-9a-f]{64}$/.test(new URL(r.url()).pathname)) seen.push(new URL(r.url()).pathname);
    });
    await page.goto(`/ui/builder/prompts/${P1}`);
    await page.getByRole("button", { name: `View commit ${H1.slice(0, 12)}` }).click();
    await expect(page.getByRole("region", { name: `Commit ${H1.slice(0, 12)}` })).toBeVisible();
    expect(seen).toContain(`/v1/prompts/${P1}/commits/${H1}`);
    await page.getByLabel("Open a commit by its full hash").fill("abc");
    await page.getByRole("button", { name: "Open commit" }).click();
    await expect(page.getByText("Enter a full commit hash: 64 hexadecimal characters.")).toBeVisible();
    await page.getByLabel("Open a commit by its full hash").fill("3c".repeat(32));
    await page.getByRole("button", { name: "Open commit" }).click();
    await expect(page.getByText("This prompt has no commit with that hash.", { exact: false })).toBeVisible();
    await expectAxeClean(page, "prompt detail with commit lookup", "main");
  });
});

// ---------------------------------------------------------------------------
// 10: an initiative
// ---------------------------------------------------------------------------

test.describe("U4: initiative detail", () => {
  test("opens an initiative with its child projects and spend", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/initiatives": { initiatives: [{ id: U(20), name: "Platform", costCenter: "CC-1", projectCount: 2, spentUsd: 12.5 }] },
      "GET /v1/energy/factors": { factors: [], region: null, notes: { shipped: "none shipped", unknown: "unknown" } },
      [`GET /v1/initiatives/${U(20)}`]: { initiative: { id: U(20), name: "Platform", costCenter: "CC-1", createdAt: T }, projects: [{ id: U(30), name: "Atlas", spentUsd: 0 }, { id: U(31), name: "Beacon", spentUsd: 12.5 }], projectCount: 2, spentUsd: 12.5 },
    });
    await page.goto("/ui/admin/cost");
    await page.getByRole("button", { name: "Open initiative Platform" }).click();
    const dialog = page.getByRole("dialog", { name: "Initiative — Platform" });
    await expect(dialog.getByRole("link", { name: "Beacon" })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Atlas" })).toBeVisible();
    await expectAxeClean(page, "initiative dialog", '[role="dialog"]');
  });
});

// ---------------------------------------------------------------------------
// 11: a training job
// ---------------------------------------------------------------------------

test.describe("U4: training job detail", () => {
  test("shows the pinned dataset version and the artifact; refused is not failed", async ({ page }) => {
    const job = { id: U(70), name: "triage-lora", datasetId: U(71), datasetName: "tickets", datasetVersion: 3, backend: "local", method: "text_classifier", baseModel: null, status: "refused", progress: 0, error: "backend not configured", estimatedCostUsd: 0, costUsd: null, projectId: null, approvalId: null, createdAt: T, durationMs: null };
    await mockApi(page, {
      "GET /v1/llm/backends": { enabled: true, approvalThresholdUsd: 10, backends: [], note: "" },
      "GET /v1/llm/datasets": { datasets: [], note: "" },
      "GET /v1/llm/jobs": { jobs: [job] },
      "GET /v1/llm/artifacts": { artifacts: [], note: "" },
      [`GET /v1/llm/jobs/${U(70)}`]: {
        job: { ...job, hyperparameters: { epochs: 2 }, externalJobId: null, startedAt: null, finishedAt: null },
        trainedOn: { id: U(71), name: "tickets", version: 3, format: "classification", rowCount: 120, checksum: "b".repeat(64), piiVerdict: "clean" },
        artifact: null,
        inProcess: true,
      },
    });
    await page.goto("/ui/admin/regulait-llm");
    await page.getByRole("button", { name: "Details of training job triage-lora" }).click();
    const dialog = page.getByRole("dialog", { name: "Training job — triage-lora" });
    await expect(dialog.getByText("Refused — the backend declined before any work happened; nothing was attempted.", { exact: false })).toBeVisible();
    await expect(dialog.getByText("tickets v3")).toBeVisible();
    await expectAxeClean(page, "training job dialog", '[role="dialog"]');
  });
});

// ---------------------------------------------------------------------------
// 12-13 + full history: billing
// ---------------------------------------------------------------------------

test.describe("U4: billing details and history", () => {
  const ST = { id: U(80), periodId: U(81), version: 2, status: "draft", ratingMode: "estimated", totalUsd: 120, seatCount: 3, unpricedEventCount: 1, generatedAt: T, issuedAt: null };
  const RC = { id: U(82), name: "standard", version: 1, currency: "USD", status: "active", createdAt: T };
  const OVERVIEW = {
    rateCards: [RC], periods: [], statements: [ST, { ...ST, id: U(83), version: 1 }], exports: [], activeSeats: 3,
    backend: { name: "noop", capabilities: {} }, ledger: { totalEvents: 0, totalListPriceUsd: 0 },
    schedulerPresent: false, paymentProcessorIntegrated: false, reconciledRatingAvailable: false, disclaimer: "", note: "",
  };
  test("rate card and statement open; an out-of-scope statement is refused in words", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/billing/overview": OVERVIEW,
      [`GET /v1/billing/rate-cards/${U(82)}`]: { rateCard: { ...RC, description: null, entries: [{ id: U(84), dimension: "model", matchKey: "*", unit: "per_1m_input_tokens", unitPriceUsd: 3 }] } },
      [`GET /v1/billing/statements/${U(80)}`]: {
        statement: { ...ST, rateCardName: "standard", rateCardVersion: 1, entitlementScope: "org", effectiveProjectIds: null, coversFullScope: true, derivedThroughAt: T, sourceUsageEventCount: 9, ledgerEstimatedCostUsd: 100, usageSubtotalUsd: 0, seatSubtotalUsd: 120, payload: { periodLabel: "2026-09", usage: { lines: [{ dimension: "tool_call", matchKey: "*", events: 2, inputTokens: 0, outputTokens: 0, billedUsd: null, unpriced: true, rateNote: "no rate" }] } } },
        disclaimer: "Not a tax invoice.",
      },
      [`GET /v1/billing/statements/${U(83)}`]: { status: 403, body: { error: "billing_scope_not_entitled" } },
    });
    await page.goto("/ui/admin/billing");
    await page.getByRole("button", { name: "Open rate card standard v1" }).first().click();
    let dialog = page.getByRole("dialog", { name: "Rate card standard v1" });
    await expect(dialog.getByRole("cell", { name: "per_1m_input_tokens" })).toBeVisible();
    await expectAxeClean(page, "rate card dialog", '[role="dialog"]');
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Open statement v2" }).click();
    dialog = page.getByRole("dialog", { name: "Statement v2" });
    await expect(dialog.getByText("Not a tax invoice.")).toBeVisible();
    await expect(dialog.getByText("unpriced", { exact: true })).toBeVisible();
    await expectAxeClean(page, "statement dialog", '[role="dialog"]');
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Open statement v1" }).click();
    await expect(page.getByRole("dialog").getByText("You don't have access to this statement")).toBeVisible();
    await expect(page.getByRole("dialog").getByText(/outside what you can see/)).toBeVisible();
  });

  test("full history: statements by period with the route's limit, periods, every rate card", async ({ page }) => {
    const m = await mockApi(page, {
      "GET /v1/billing/overview": OVERVIEW,
      "GET /v1/billing/periods": { periods: [{ id: U(81), scopeKind: "org", scopeKey: "org", periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z", status: "open", closedAt: null }], note: "" },
      "GET /v1/billing/statements": { statements: [{ ...ST, rateCardName: "standard", rateCardVersion: 1, coversFullScope: true }], disclaimer: "" },
      "GET /v1/billing/rate-cards": { rateCards: [{ ...RC, description: null, entries: [] }], note: "" },
    });
    await page.goto("/ui/admin/billing");
    await expect(page.getByText("Full billing history")).toBeVisible();
    await expect.poll(() => calls(m, "GET", "/v1/billing/statements").at(-1)?.search).toBe("?limit=50");
    await page.getByRole("tab", { name: "Periods" }).click();
    await page.getByRole("button", { name: "Statements for 2026-09-01 – 2026-10-01 (org)" }).click();
    await expect.poll(() => calls(m, "GET", "/v1/billing/statements").at(-1)?.search).toBe(`?limit=50&periodId=${U(81)}`);
    await page.getByLabel("Show at most").selectOption("200");
    await expect.poll(() => calls(m, "GET", "/v1/billing/statements").at(-1)?.search).toBe(`?limit=200&periodId=${U(81)}`);
    await page.getByRole("tab", { name: "Rate cards" }).click();
    await expect.poll(() => calls(m, "GET", "/v1/billing/rate-cards").length).toBe(1);
    await expectAxeClean(page, "billing history", page.locator("[data-rg-card]").filter({ hasText: "Full billing history" }).first());
  });
});

// ---------------------------------------------------------------------------
// 14-15 + run history: reports
// ---------------------------------------------------------------------------

test.describe("U4: report definition, run and run history", () => {
  const DEF = U(90);
  const RUN_ID = U(91);
  const run = { id: RUN_ID, definitionId: DEF, scheduleId: null, requestedByUserId: ME, trigger: "manual", period: "current_month", periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", entitlementScope: "org", effectiveProjectIds: null, format: "json", rowCount: 4, generatedAt: T };
  test("definition detail resolves scope and opens the last run; history filters by definition; a refusal is named", async ({ page }) => {
    const m = await mockApi(page, {
      "GET /v1/reports/overview": {
        definitions: [{ id: DEF, name: "Exec summary", kind: "exec_summary", scopeKind: "team", scopeId: U(92), period: "current_month", format: "json", entitlementScope: "team", description: null, lastGeneratedAt: T, runCount: 1, schedules: [{ id: U(93), definitionId: DEF, cadence: "monthly", enabled: true, recipientUserIds: null, lastGeneratedAt: T, lastRunId: RUN_ID }] }],
        schedulerPresent: false,
        note: "",
      },
      [`GET /v1/reports/definitions/${DEF}`]: {
        definition: { id: DEF, name: "Exec summary", kind: "exec_summary", scopeKind: "team", scopeId: U(92), period: "current_month", sections: null, format: "json", entitlementScope: "team", description: null, createdAt: T },
        scopeProjectIds: [U(30), U(31)],
        schedules: [{ id: U(93), cadence: "monthly", enabled: true, lastGeneratedAt: T, lastRunId: RUN_ID }],
      },
      [`GET /v1/reports/runs/${RUN_ID}`]: { run: { ...run, payload: { disclaimer: "Spend is an estimate.", spend: { totalCostUsd: 42, totalEvents: 7, lines: [{ projectId: U(30), projectName: "Atlas", costUsd: 42, events: 7 }] } } } },
      "GET /v1/reports/runs": (_b: Json, url: URL) => (url.searchParams.get("definitionId") === U(94) ? { status: 400, body: { error: "validation" } } : { runs: [run] }),
    });
    await page.goto("/ui/admin/reports");
    await page.getByRole("button", { name: "Details of Exec summary" }).click();
    const dialog = page.getByRole("dialog", { name: "Report definition — Exec summary" });
    await expect(dialog.getByRole("list", { name: "Projects in scope" })).toContainText("Atlas");
    await expectAxeClean(page, "report definition dialog", '[role="dialog"]');
    await dialog.getByRole("button", { name: "Open last run (monthly)" }).click();
    const runDialog = page.getByRole("dialog", { name: "Report run" });
    await expect(runDialog.getByText("Spend is an estimate.")).toBeVisible();
    await expect(runDialog.getByRole("cell", { name: "Atlas" })).toBeVisible();
    await expectAxeClean(page, "report run dialog", '[role="dialog"]');
    await runDialog.getByRole("button", { name: "Close" }).click();
    // the definition dialog it replaced is gone: focus returns to the button that opened it
    await expect(page.getByRole("button", { name: "Details of Exec summary" })).toBeFocused();

    await expect(page.getByText("Run history")).toBeVisible();
    await expect.poll(() => calls(m, "GET", "/v1/reports/runs").at(-1)?.search).toBe("?limit=50");
    await page.getByLabel("Definition", { exact: true }).last().selectOption(DEF);
    await expect.poll(() => calls(m, "GET", "/v1/reports/runs").at(-1)?.search).toBe(`?limit=50&definitionId=${DEF}`);
    await expectAxeClean(page, "run history", page.locator("[data-rg-card]").filter({ hasText: "Run history" }).first());
  });

  test("an out-of-scope run is refused in words", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/reports/overview": { definitions: [], schedulerPresent: false, note: "" },
      "GET /v1/reports/runs": { runs: [run] },
      [`GET /v1/reports/runs/${RUN_ID}`]: { status: 403, body: { error: "report_scope_not_entitled" } },
    });
    await page.goto("/ui/admin/reports");
    await page.getByRole("button", { name: /Open the report run from/ }).click();
    await expect(page.getByRole("dialog").getByText("You don't have access to this report run")).toBeVisible();
    await expect(page.getByRole("dialog").getByText(/outside what you can see/)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// boot scheduler health + spend monitor history
// ---------------------------------------------------------------------------

test.describe("U4: boot schedulers and spend history", () => {
  test("a failing boot scheduler is shown with its error", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/scheduler": { enabled: true, posture: "on", tickMs: 30000, leaseSeconds: 300, instanceId: "gw-1", stuckRuns: [], note: "n", jobs: [] },
      "GET /v1/health/schedulers": {
        schedulers: [
          { name: "audit-retention-prune", lastRunAt: T, lastSuccessAt: null, lastFailureAt: T, lastError: "database unreachable", runs: 3, failures: 3, consecutiveFailures: 3, healthy: false },
          { name: "backup-verify", lastRunAt: T, lastSuccessAt: T, lastFailureAt: null, lastError: null, runs: 1, failures: 0, consecutiveFailures: 0, healthy: true },
        ],
        healthy: false,
        note: "in-memory, per-process",
      },
    });
    await page.goto("/ui/admin/scheduler");
    await expect(page.getByText("At least one scheduler's latest tick failed.")).toBeVisible();
    await expect(page.getByText("database unreachable")).toBeVisible();
    await expect(page.getByText("failing (3 in a row)")).toBeVisible();
    await expectAxeClean(page, "boot scheduler health", page.locator("[data-rg-card]").filter({ hasText: "Boot schedulers" }).first());
  });

  test("never-ticked boot schedulers say absence, not success", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/scheduler": { enabled: false, posture: "off", tickMs: 30000, leaseSeconds: 300, instanceId: "gw-1", stuckRuns: [], note: "n", jobs: [] },
      "GET /v1/health/schedulers": { schedulers: [], healthy: true, note: "n" },
    });
    await page.goto("/ui/admin/scheduler");
    await expect(page.getByText("Neither boot scheduler has run in this gateway process")).toBeVisible();
  });

  test("spend monitor: all signals and all decided changes load on request with the route's filters", async ({ page }) => {
    const m = await mockApi(page, {
      "GET /v1/spend/monitor-overview": { policies: [], openAnomalies: 0, recentAnomalies: [], scheduledChanges: [], schedulerPresent: false, minBaselineSamples: 7, note: "" },
      "GET /v1/spend/anomalies": {
        anomalies: [{ id: U(95), projectId: U(30), signal: "daily_spend", method: "mad", observed: 90, score: 6.1, threshold: 3.5, explanation: "x", approvalId: null, status: "acknowledged", decisionReason: "known launch", detectedAt: T }],
        note: "A signal for human review.",
      },
      "GET /v1/spend/scheduled-changes": { scheduledChanges: [{ id: U(96), projectId: U(31), deltaUsd: 250, effectiveAt: T, reason: "new team onboards" }] },
    });
    await page.goto("/ui/admin/spend-monitor");
    expect(calls(m, "GET", "/v1/spend/anomalies")).toHaveLength(0);
    await page.getByRole("button", { name: "Show all signals" }).click();
    await expect(page.getByText("A signal for human review.")).toBeVisible();
    await page.getByLabel("Signal status").selectOption("acknowledged");
    await page.getByLabel("Signal project").selectOption(U(30));
    await expect.poll(() => calls(m, "GET", "/v1/spend/anomalies").at(-1)?.search).toBe(`?limit=50&projectId=${U(30)}&status=acknowledged`);
    await page.getByRole("button", { name: "Show all changes" }).click();
    await expect(page.getByText("new team onboards")).toBeVisible();
    await page.getByLabel("Change project").selectOption(U(31));
    await expect.poll(() => calls(m, "GET", "/v1/spend/scheduled-changes").at(-1)?.search).toBe(`?projectId=${U(31)}`);
    await expectAxeClean(page, "spend history", "main");
  });
});
