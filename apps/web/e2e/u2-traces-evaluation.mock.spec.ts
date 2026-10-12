/**
 * UI gaps U2 — the Traces page's Evaluation tab and retention holds, against a
 * mocked gateway:
 *
 *  - content evaluation of model calls (ADR-0160): the per-agent summary, the
 *    window, and "Evaluate new model calls now" reporting what the sweep did;
 *  - the deterministic trace scorer (ADR-0173): spans loaded from a trace,
 *    the strict body POST /v1/evals/traces/evaluate accepts, a result per
 *    span with the reason a span was not scored, and a refusal in words;
 *  - retention holds: the list, and a release that is confirmed with its
 *    consequence and then resent once through step-up
 *    (`evidence_hold_override`);
 *  - axe (WCAG 2.x A/AA) in light and dark.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ISO = "2026-10-07T10:00:00.000Z";
const TRACE = "55555555-5555-4555-8555-555555555555";
const SPAN_A = "66666666-6666-4666-8666-666666666661";
const SPAN_B = "66666666-6666-4666-8666-666666666662";
const HELD_A = "77777777-7777-4777-8777-777777777771";
const HELD_B = "77777777-7777-4777-8777-777777777772";
const USER = "22222222-2222-4222-8222-222222222222";

interface Captured {
  sweeps: number;
  evaluatePosts: Array<Record<string, unknown>>;
  releases: Array<Record<string, unknown>>;
  summaryDays: string[];
}

async function mockApi(page: Page, opts: { refuseScorer?: boolean } = {}): Promise<Captured> {
  const cap: Captured = { sweeps: 0, evaluatePosts: [], releases: [], summaryDays: [] };
  const me = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "avery@example.test", displayName: "Avery Admin" } };
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/users") return json(route, { users: [{ id: USER, email: "ada@example.test", displayName: "Ada Analyst", isAdmin: false }] });
    if (p === "/v1/agents") return json(route, { agents: [] });
    if (p === "/v1/traces") return json(route, { traces: [], total: 0, scope: "admin", note: "" });
    if (p === `/v1/traces/${TRACE}`) {
      return json(route, {
        trace: { id: TRACE },
        tree: [{ id: "root", kind: "orchestration", children: [{ id: SPAN_A, kind: "llm", children: [] }, { id: "tool-1", kind: "tool", children: [] }] }],
      });
    }
    if (p === "/v1/sessions") return json(route, { sessions: [], scope: "admin" });
    if (p === "/v1/tracing/config") return json(route, { enabled: true, captureContent: true, previewMaxChars: 2000, otlp: { configured: false, endpoint: null, serviceName: "regulait", headerNames: [] }, limits: "l", retention: "r", note: "n", profiles: ["otel_genai"] });
    if (p === "/v1/automation-rules") return json(route, { rules: [], retention: { floorDays: 30, maxHoldDays: 60 } });
    if (p === "/v1/governance/trace-evaluations" && method === "GET") {
      cap.summaryDays.push(url.searchParams.get("days") ?? "");
      return json(route, {
        window: { days: Number(url.searchParams.get("days") ?? 7) },
        lastEvaluatedAt: ISO,
        totals: { spans: 40, evaluated: 36, flagged: 2, withheld: 3, noContent: 1 },
        agents: [
          { agentId: "a1", agentName: "Claims bot", spans: 40, evaluated: 36, withheld: 3, noContent: 1, flagged: 2, leaksByDetector: { pii: 2 }, attemptsByDetector: { prompt_injection: 1 }, coveragePct: 90 },
        ],
        notes: { method: "Shipped detectors re-run over stored previews.", leaks: "Output hits left the platform.", coverage: "Withheld spans are not evaluated." },
      });
    }
    if (p === "/v1/governance/trace-evaluations/run" && method === "POST") {
      cap.sweeps += 1;
      return json(route, { scanned: 5, evaluated: 4, flagged: 1, withheld: 1, noContent: 0, capped: false });
    }
    if (p === "/v1/evals/traces/evaluate" && method === "POST") {
      cap.evaluatePosts.push(req.postDataJSON() as Record<string, unknown>);
      if (opts.refuseScorer) {
        return json(route, { error: "unusable_scorer_config", detail: "contains scorer needs at least one needle" }, 422);
      }
      return json(route, {
        ok: true,
        evaluated: 1,
        notEvaluated: 1,
        scoreName: "evaluator.contains",
        runRef: "r1",
        results: [
          { spanId: SPAN_A, traceId: TRACE, outcome: "evaluated", score: 1, passed: true, traceScoreId: "s1" },
          { spanId: SPAN_B, outcome: "not_evaluated", reason: "content_withheld" },
        ],
      });
    }
    if (p === "/v1/retention-holds" && method === "GET") {
      return json(route, {
        holds: [
          { traceId: HELD_A, traceUserId: USER, holdUntil: future, ruleId: "rule-hold", createdByUserId: null, releasedAt: null, releaseReason: null },
          { traceId: HELD_B, traceUserId: USER, holdUntil: future, ruleId: "rule-hold", createdByUserId: null, releasedAt: ISO, releaseReason: "admin" },
        ],
        retention: { floorDays: 30, maxHoldDays: 60 },
      });
    }
    if (p === "/v1/retention-holds/release" && method === "POST") {
      cap.releases.push(req.postDataJSON() as Record<string, unknown>);
      return json(route, { released: 1, traceIds: [HELD_A] });
    }
    return json(route, {});
  });
  return cap;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([
        Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

test.describe("U2: Traces evaluation tab", () => {
  test("summary, window and sweep; the scorer posts the strict body and explains skipped spans", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/traces");
    await page.getByRole("tab", { name: "Evaluation" }).click();
    const summary = page.getByTestId("trace-evaluation-summary");
    await expect(summary).toContainText("Claims bot");
    await expect(summary).toContainText("pii 2");
    await expect(summary).toContainText("90%");
    await page.getByLabel("Window").selectOption("30");
    await expect.poll(() => cap.summaryDays.at(-1)).toBe("30");

    await page.getByRole("button", { name: "Evaluate new model calls now" }).click();
    await expect(page.getByRole("status").filter({ hasText: "5 model calls examined" })).toContainText("4 evaluated, 1 flagged, 1 withheld (a block fired).");
    expect(cap.sweeps).toBe(1);
    await expectAxeClean(page, "trace evaluation tab");

    await page.getByLabel("Trace id (optional helper)").fill(TRACE);
    await page.getByRole("button", { name: "Add its model-call spans" }).click();
    const scorer = page.getByRole("form", { name: "Score trace spans" });
    await expect(scorer.getByLabel("Span ids")).toHaveValue(SPAN_A);
    await scorer.getByLabel("Span ids").fill(`${SPAN_A}\n${SPAN_B}`);
    await scorer.getByLabel("Score name (optional)").fill("refund.mention");
    await scorer.getByRole("button", { name: "Score spans" }).click();
    await expect.poll(() => cap.evaluatePosts.length).toBe(1);
    expect(cap.evaluatePosts[0]).toEqual({
      scorerKind: "contains",
      scorerConfig: { needles: ["refund"] },
      spanIds: [SPAN_A, SPAN_B],
      scoreName: "refund.mention",
    });
    const results = page.getByTestId("trace-scorer-results");
    await expect(results).toContainText("pass · 1.00");
    await expect(results).toContainText("not scored: content withheld (a block fired)");
    await expectAxeClean(page, "trace scorer results");
  });

  test("a bad span id is refused before sending, and a scorer refusal is said in words", async ({ page }) => {
    const cap = await mockApi(page, { refuseScorer: true });
    await page.goto("/ui/admin/traces");
    await page.getByRole("tab", { name: "Evaluation" }).click();
    const scorer = page.getByRole("form", { name: "Score trace spans" });
    await scorer.getByLabel("Span ids").fill("not-a-span");
    await scorer.getByRole("button", { name: "Score spans" }).click();
    await expect(scorer.getByRole("alert")).toContainText("Not a span id: not-a-span.");
    expect(cap.evaluatePosts).toHaveLength(0);
    await scorer.getByLabel("Span ids").fill(SPAN_A);
    await scorer.getByRole("button", { name: "Score spans" }).click();
    await expect(scorer.getByRole("alert")).toContainText("cannot tell a good output from a bad one");
    await expect(scorer.getByRole("alert")).toContainText("needs at least one needle");
  });
});

test.describe("U2: retention holds", () => {
  test("releasing a selected hold is confirmed, then resent once through step-up", async ({ page }) => {
    const cap = await mockApi(page);
    const su = await requireStepUpOn(page, { method: "POST", path: "/v1/retention-holds/release", kind: "evidence_hold_override" });
    await page.goto("/ui/admin/traces");
    await page.getByRole("tab", { name: "Automations" }).click();
    const card = page.locator("section[data-rg-card]").filter({ hasText: "Retention holds" }).first();
    await expect(card).toContainText("a hold lasts at most 60 days");
    await expect(card.getByRole("checkbox", { name: `Select the hold on trace ${HELD_B}` })).toHaveCount(0);
    await expectAxeClean(page, "retention holds");

    const form = page.getByRole("form", { name: "Release retention holds" });
    await form.getByRole("button", { name: "Release holds…" }).click();
    await expect(form.getByRole("alert")).toContainText("reference");
    await form.getByLabel("Reference (ticket or erasure request)").fill("TCK-42");
    await form.getByRole("button", { name: "Release holds…" }).click();
    await expect(form.getByRole("alert")).toContainText("Select the held traces");

    await card.getByRole("checkbox", { name: `Select the hold on trace ${HELD_A}` }).check();
    await form.getByRole("button", { name: "Release holds…" }).click();
    const dialog = page.getByRole("dialog", { name: "Release these retention holds?" });
    await expect(dialog).toContainText("The hold on 1 trace ends now");
    await dialog.getByRole("button", { name: "Release" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(cap.releases).toEqual([{ reason: "admin", traceIds: [HELD_A], reference: "TCK-42" }]);
    await expect(form.getByRole("status")).toContainText("1 hold released.");
  });

  test("an erasure release names the person and is scoped to them", async ({ page }) => {
    const cap = await mockApi(page);
    await requireStepUpOn(page, { method: "POST", path: "/v1/retention-holds/release", kind: "evidence_hold_override" });
    await page.goto("/ui/admin/traces");
    await page.getByRole("tab", { name: "Automations" }).click();
    const form = page.getByRole("form", { name: "Release retention holds" });
    await form.getByLabel("What to release").selectOption("person");
    await form.getByLabel("Person").selectOption(USER);
    await form.getByLabel("Why").selectOption("erasure");
    await form.getByLabel("Reference (ticket or erasure request)").fill("DSR-7");
    await form.getByRole("button", { name: "Release holds…" }).click();
    const dialog = page.getByRole("dialog", { name: "Release these retention holds?" });
    await expect(dialog).toContainText("Every retention hold on Ada Analyst's traces ends now, for their erasure request.");
    await dialog.getByRole("button", { name: "Release" }).click();
    await confirmStepUp(page);
    await expect.poll(() => cap.releases.length).toBe(1);
    expect(cap.releases[0]).toEqual({ reason: "erasure", userId: USER, reference: "DSR-7" });
  });
});
