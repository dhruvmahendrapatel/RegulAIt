/**
 * ADR-0173 batch 2c (K) — the Monitoring page (KRI tiles, thresholds, series
 * charts on recharts, dashboards) and the Traces page's Automations tab
 * (rules, create with the bounds explained, pause, explicit backfill, match
 * log) against a mocked gateway. Axe in light and dark on each state.
 *
 * Mocked: nothing global is created, so there is nothing to remove (M-068).
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { MODEL_A, MODEL_B, PROJECT, installBuilderMock } from "./builder-fixtures";
import { expectAxeClean, sentTo } from "./prompts-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const KRI_ERR = "77771111-0000-4000-8000-000000000001";
const KRI_P99 = "77771111-0000-4000-8000-000000000002";
const ALERT = "77772222-0000-4000-8000-000000000001";
const DASH = "77773333-0000-4000-8000-000000000001";
const RULE_A = "77774444-0000-4000-8000-000000000001";
const RULE_B = "77774444-0000-4000-8000-000000000002";
const QUEUE = "77775555-0000-4000-8000-000000000001";
const DATASET = "77776666-0000-4000-8000-000000000001";
const HOOK = "77777777-0000-4000-8000-000000000001";
const TRACE = "77778888-0000-4000-8000-000000000001";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function kri(id: string, extra: Json) {
  return {
    id,
    name: "Error rate",
    metric: "error_rate",
    metricLabel: "Error rate",
    unit: "%",
    scope: "fleet",
    scopeId: null,
    scopeLabel: null,
    windowDays: 7,
    comparator: "above",
    threshold: 5,
    minSamples: 20,
    severity: "high",
    scoreName: null,
    enabled: true,
    measurement: { value: 12.5, samples: 240, state: "breached" },
    alert: { id: ALERT, status: "open" },
    ...extra,
  };
}

function series(groupBy: string) {
  const groups =
    groupBy === "agent"
      ? [
          ...Array.from({ length: 7 }, (_, i) => ({ key: `aaaa0000-0000-4000-8000-00000000000${i}`, label: `Agent ${i + 1}` })),
          { key: "other", label: "Other" },
        ]
      : [{ key: "all", label: "All traces" }];
  const buckets = ["2026-09-29T00:00:00Z", "2026-09-30T00:00:00Z", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"];
  return {
    metric: "trace_volume",
    unit: "traces",
    bucket: "day",
    bucketMs: 86_400_000,
    groupBy,
    groups,
    points: buckets.flatMap((b, bi) => groups.map((g, gi) => ({ bucket: b, group: g.key, value: 10 + bi * 3 + gi, samples: 10 + bi * 3 + gi }))),
    folded: groupBy === "agent" ? 3 : 0,
    otherIsApproximate: false,
  };
}

async function installMonitoringMock(page: Page) {
  const base = await installBuilderMock(page, { isAdmin: true });
  const st = {
    calls: base.calls as Array<{ method: string; path: string; body: Json }>,
    kris: [
      kri(KRI_ERR, {}),
      kri(KRI_P99, {
        name: "Support p99",
        metric: "latency_p99",
        metricLabel: "Latency p99",
        unit: "ms",
        scope: "agent",
        scopeId: MODEL_A,
        scopeLabel: "Main model",
        threshold: 4000,
        severity: "medium",
        measurement: { value: 5100, samples: 6, state: "insufficient" },
        alert: null,
      }),
    ] as Json[],
    dashboards: [] as Json[],
    rules: [
      {
        id: RULE_A,
        name: "Low helpfulness to review",
        filter: { scoreName: "helpfulness", scoreMax: 2 },
        samplingRate: 0.25,
        actions: [{ type: "queue", queueId: QUEUE }],
        status: "active",
        pausedReason: null,
        pausedAt: null,
        author: { id: MODEL_A, name: "Avery Admin" },
        dailyActionCap: 500,
        cursorEndedAt: new Date().toISOString(),
        backfillUntil: null,
        stats: { today: 4, total: 31, retrying: 0, failed: 1, lastMatchedAt: new Date().toISOString() },
      },
      {
        id: RULE_B,
        name: "Hold refused exports",
        filter: { deniedOnly: true },
        samplingRate: 1,
        actions: [{ type: "retention", days: 120 }],
        status: "paused",
        pausedReason: "author_not_admin",
        pausedAt: new Date().toISOString(),
        author: { id: MODEL_B, name: "Drew Former" },
        dailyActionCap: 100,
        cursorEndedAt: new Date().toISOString(),
        backfillUntil: null,
        stats: { today: 0, total: 3, retrying: 0, failed: 0, lastMatchedAt: null },
      },
    ] as Json[],
  };
  await page.route(
    /\/v1\/(kris|monitoring|agents|automation-rules|annotation-queues|evals\/datasets|webhooks|traces|sessions|tracing)(\/|\?|$)/,
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const p = url.pathname;
      const method = req.method();
      let body: Json;
      try {
        body = req.postDataJSON();
      } catch {
        body = undefined;
      }
      st.calls.push({ method, path: p + url.search, body });
      let m: RegExpExecArray | null;
      if (p === "/v1/agents") return json(route, { agents: [{ id: MODEL_A, name: "Main model", provider: "mock", tier: 1 }, { id: MODEL_B, name: "Review model", provider: "mock", tier: 2 }] });
      if (p === "/v1/kris" && method === "GET")
        return json(route, { kris: st.kris, measuredAt: new Date().toISOString(), note: "A KRI is evaluated on every governance-monitor pass." });
      if (p === "/v1/kris" && method === "POST") {
        const row = kri("77771111-0000-4000-8000-000000000009", { ...body, metricLabel: "Error rate", measurement: null, alert: null });
        st.kris.push(row);
        return json(route, row, 201);
      }
      if ((m = /^\/v1\/kris\/([^/]+)$/.exec(p))) {
        if (method === "DELETE") {
          st.kris = st.kris.filter((k) => k.id !== m![1]);
          return json(route, { deleted: true, resolvedEpisodes: 1 });
        }
        return json(route, st.kris.find((k) => k.id === m![1]));
      }
      if (p === "/v1/monitoring/series") return json(route, series(url.searchParams.get("groupBy") ?? "none"));
      if (p === "/v1/monitoring/dashboards" && method === "GET") return json(route, { dashboards: st.dashboards });
      if (p === "/v1/monitoring/dashboards" && method === "POST") {
        const d = { id: DASH, name: body.name, panels: body.panels };
        st.dashboards.push(d);
        return json(route, d, 201);
      }
      if ((m = /^\/v1\/monitoring\/dashboards\/([^/]+)$/.exec(p)) && method === "PATCH") {
        const d = st.dashboards.find((x) => x.id === m![1]);
        Object.assign(d, body);
        return json(route, d);
      }
      // the automations tab
      if (p === "/v1/automation-rules" && method === "GET") return json(route, { rules: st.rules, retention: { floorDays: 90, maxHoldDays: 180 } });
      if (p === "/v1/automation-rules" && method === "POST") {
        const r = { ...st.rules[0], ...body, id: "77774444-0000-4000-8000-000000000009", status: "active", stats: undefined };
        st.rules.push(r);
        return json(route, r, 201);
      }
      if (p === "/v1/automation-rules/sweep") return json(route, { matched: 2, examined: 40 });
      if ((m = /^\/v1\/automation-rules\/([^/]+)\/backfill$/.exec(p)))
        return json(route, { ruleId: m[1], days: body.days, from: new Date().toISOString(), until: new Date().toISOString(), rewound: true, note: "Traces that ended in this window are matched on the next pass." });
      if ((m = /^\/v1\/automation-rules\/([^/]+)\/matches$/.exec(p)))
        return json(route, {
          matches: [
            { id: "m1", traceId: TRACE, traceName: "release-notes summary", matchedAt: new Date().toISOString(), backfill: true, status: "done", attempts: 1, actionResults: [{ type: "queue", status: "ok", reason: null, attempts: 1 }] },
            { id: "m2", traceId: TRACE, traceName: "support reply draft", matchedAt: new Date().toISOString(), backfill: false, status: "failed", attempts: 2, actionResults: [{ type: "queue", status: "failed", reason: "target_not_found", attempts: 2 }] },
          ],
        });
      if ((m = /^\/v1\/automation-rules\/([^/]+)$/.exec(p)) && method === "PATCH") {
        const r = st.rules.find((x) => x.id === m![1]);
        Object.assign(r, body);
        return json(route, r);
      }
      if (p === "/v1/annotation-queues") return json(route, { queues: [{ id: QUEUE, name: "Release review" }] });
      if (p === "/v1/evals/datasets") return json(route, { datasets: [{ id: DATASET, name: "regressions", version: 2, frozen: false }] });
      if (p === "/v1/webhooks") return json(route, { subscriptions: [{ id: HOOK, name: "SIEM", active: true }] });
      if (p === "/v1/traces") return json(route, { traces: [], total: 0, scope: "fleet", note: "" });
      if (p === "/v1/sessions") return json(route, { sessions: [], scope: "fleet" });
      if (p === "/v1/tracing/config")
        return json(route, {
          enabled: true,
          captureContent: false,
          previewMaxChars: 4000,
          otlp: { configured: false, endpoint: null, serviceName: "regulait-gateway", headerNames: [] },
          limits: "",
          retention: "",
          note: "",
          profiles: ["otel_genai", "openinference"],
          defaultProfile: "otel_genai",
          standards: { otelSemanticConventions: "1.43.0", openInferenceGenai: "0.4.0", openInferenceSemanticConventions: "2.14.0" },
        });
      return route.fallback();
    },
  );
  return st;
}

test.describe("ADR-0173 2c: monitoring and automations", () => {
  test("KRI tiles → threshold editor → series chart and table → dashboard", async ({ page }) => {
    const st = await installMonitoringMock(page);
    await page.goto("/ui/admin/monitoring");
    await expect(page.getByRole("heading", { level: 1, name: "Monitoring" })).toBeVisible();
    const tiles = page.getByRole("list", { name: "Key risk indicators" });
    await expect(tiles.getByRole("listitem", { name: "KRI Error rate" })).toContainText("Past threshold");
    await expect(tiles.getByRole("listitem", { name: "KRI Error rate" })).toContainText("12.5%");
    await expect(tiles.getByRole("listitem", { name: "KRI Support p99" })).toContainText("Too few samples");
    await expect(tiles.getByRole("listitem", { name: "KRI Support p99" })).toContainText("6 of 20 samples needed");
    await expect(page.getByRole("figure", { name: /Trace volume over last 7 days/ })).toBeVisible();
    await expectAxeClean(page, "monitoring, tiles and series");

    // a new KRI: the 90-day window is explained, then sent
    await page.getByRole("button", { name: "New KRI" }).click();
    await page.getByLabel("KRI name").fill("Cost watch");
    await page.getByLabel("Window (days, at most 90)").fill("91");
    await page.getByLabel("Threshold").fill("50");
    await expect(page.getByRole("alert").filter({ hasText: "The window is 1 to 90 days." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create KRI" })).toBeDisabled();
    await page.getByLabel("Window (days, at most 90)").fill("30");
    await page.getByLabel("Scope").selectOption("project");
    await expect(page.getByRole("button", { name: "Create KRI" })).toBeDisabled();
    await page.getByLabel("Project").selectOption(PROJECT);
    await expectAxeClean(page, "monitoring, KRI editor");
    await page.getByRole("button", { name: "Create KRI" }).click();
    await expect.poll(() => sentTo(st, "POST", "/v1/kris")).toEqual([
      { name: "Cost watch", metric: "error_rate", scope: "project", scopeId: PROJECT, windowDays: 30, comparator: "above", threshold: 50, minSamples: 20, severity: "medium", scoreName: null },
    ]);
    await expect(tiles.getByRole("listitem", { name: "KRI Cost watch" })).toBeVisible();

    // per-agent series: the chart draws six, the table lists every group
    await page.getByLabel("Group by").selectOption("agent");
    await expect.poll(() => st.calls.some((c) => c.path.startsWith("/v1/monitoring/series?") && c.path.includes("groupBy=agent"))).toBe(true);
    await expect(page.getByText("The chart draws the first 6 of 8 groups; the table lists them all.")).toBeVisible();
    await page.getByRole("button", { name: "Show table" }).first().click();
    await expect(page.getByRole("cell", { name: "Other" }).first()).toBeVisible();
    await expectAxeClean(page, "monitoring, grouped series with table");

    // a dashboard with one series panel
    await page.getByLabel("New dashboard name").fill("Ops");
    await page.getByRole("button", { name: "Create dashboard" }).click();
    await expect.poll(() => sentTo(st, "POST", "/v1/monitoring/dashboards")).toEqual([{ name: "Ops", panels: [] }]);
    await page.getByLabel("Dashboard", { exact: true }).selectOption(DASH);
    await page.getByLabel("Panel metric").selectOption("cost_usd");
    await page.getByRole("button", { name: "Add panel" }).click();
    await expect
      .poll(() => sentTo(st, "PATCH", `/v1/monitoring/dashboards/${DASH}`))
      .toEqual([{ panels: [{ kind: "series", title: "Cost, last 7 days", metric: "cost_usd", groupBy: "none", bucket: "day", rangeDays: 7 }] }]);
    await expect(page.getByRole("list", { name: "Panels of Ops" }).getByRole("figure", { name: "Cost, last 7 days" })).toBeVisible();
    await expectAxeClean(page, "monitoring, dashboard with a panel");
  });

  test("Automations tab: rules, bounds, create, pause, backfill, match log", async ({ page }) => {
    const st = await installMonitoringMock(page);
    await page.goto("/ui/admin/traces");
    await page.getByRole("tab", { name: "Automations" }).click();
    await expect(page.getByRole("cell", { name: /^Low helpfulness to review/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: /author not admin/ })).toBeVisible();
    await expect(page.getByText("score helpfulness ≤ 2")).toBeVisible();
    await expectAxeClean(page, "automations, rule list");

    // create: the tag-key shape and the hold bound are explained before sending
    await page.getByRole("button", { name: "New rule" }).click();
    await page.getByLabel("Rule name").fill("Slow and costly");
    await page.getByLabel("Rule tag key").fill("Bad Key");
    await expect(page.getByRole("alert").filter({ hasText: "A tag key is lowercase" })).toBeVisible();
    await page.getByLabel("Rule tag key").fill("team");
    await page.getByLabel("Rule tag value").fill("payments");
    await page.getByLabel("Rule latency at least (ms)").fill("5000");
    await page.getByLabel("Sampling (%)").fill("10");
    await page.getByLabel("Extend retention (days, at most 180)").fill("181");
    await expect(page.getByRole("alert").filter({ hasText: "A hold is 1 to 180 days" })).toBeVisible();
    await page.getByLabel("Extend retention (days, at most 180)").fill("120");
    await page.getByLabel("Send to annotation queue").selectOption(QUEUE);
    await expect(page.getByText("at most twice the 90-day floor")).toBeVisible();
    await expectAxeClean(page, "automations, rule editor");
    await page.getByRole("button", { name: "Create rule" }).click();
    await expect.poll(() => sentTo(st, "POST", "/v1/automation-rules")).toEqual([
      {
        name: "Slow and costly",
        filter: { tagKey: "team", tagValue: "payments", minLatencyMs: 5000 },
        samplingRate: 0.1,
        actions: [{ type: "queue", queueId: QUEUE }, { type: "retention", days: 120 }],
        dailyActionCap: 500,
      },
    ]);

    // pause, then an explicit backfill (at most 7 days)
    await page.getByRole("button", { name: "Pause rule Low helpfulness to review" }).click();
    await expect.poll(() => sentTo(st, "PATCH", `/v1/automation-rules/${RULE_A}`)).toEqual([{ status: "paused" }]);
    await page.getByLabel("Backfill days for Hold refused exports").fill("8");
    await expect(page.getByRole("button", { name: "Backfill Hold refused exports" })).toBeDisabled();
    await page.getByLabel("Backfill days for Hold refused exports").fill("3");
    await page.getByRole("button", { name: "Backfill Hold refused exports" }).click();
    await expect.poll(() => sentTo(st, "POST", `/v1/automation-rules/${RULE_B}/backfill`)).toEqual([{ days: 3 }]);
    await expect(page.getByRole("status").filter({ hasText: "matched on the next pass" }).first()).toBeVisible();

    // the match log: backfill marked, failures with their reason code in words
    await page.getByRole("button", { name: "Match log of Hold refused exports" }).click();
    await expect(page.getByRole("cell", { name: "Backfill", exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Actions for support reply draft" })).toContainText("failed (target not found), 2 attempts");
    await expectAxeClean(page, "automations, match log");
  });
});
