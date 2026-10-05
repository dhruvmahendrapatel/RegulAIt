/**
 * ADR-0173 batch 2c — the Traces page against a mocked gateway: the shared
 * filters, tag chips, multi-select actions (add to dataset, send to an
 * annotation queue, tag) with their added/skipped outcome, the tree's tag
 * editor and scores, the export profile, and the Automations slot. Axe in
 * light and dark on each state.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { MODEL_A, MODEL_B, installBuilderMock } from "./builder-fixtures";
import { expectAxeClean, sentTo } from "./prompts-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const T1 = "aaaa1111-0000-4000-8000-000000000001";
const T2 = "aaaa1111-0000-4000-8000-000000000002";
const T3 = "aaaa1111-0000-4000-8000-000000000003";
const SPAN = "bbbb1111-0000-4000-8000-000000000001";
const DS_OPEN = "cccc1111-0000-4000-8000-000000000001";
const DS_FROZEN = "cccc1111-0000-4000-8000-000000000002";
const QUEUE = "dddd1111-0000-4000-8000-000000000001";
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function trace(id: string, name: string, tags: Array<{ key: string; value: string }>, extra: Json = {}) {
  return {
    id,
    sessionId: null,
    kind: "dispatch",
    rootRefId: null,
    name,
    userId: MODEL_A,
    projectId: null,
    status: "ok",
    startedAt: iso(10),
    endedAt: iso(9),
    durationMs: 1200,
    spanCount: 1,
    deniedSpanCount: 0,
    inputTokens: 40,
    outputTokens: 12,
    costUsd: 0.0021,
    tags,
    ...extra,
  };
}

async function installTracesMock(page: Page) {
  const base = await installBuilderMock(page, { isAdmin: true });
  const st = {
    calls: base.calls as Array<{ method: string; path: string; body: Json }>,
    traces: [
      trace(T1, "release-notes summary", [{ key: "release", value: "2026.10" }]),
      trace(T2, "support reply draft", []),
      trace(T3, "refused export", [], { status: "denied", deniedSpanCount: 1 }),
    ] as Json[],
    tags: { [T1]: [{ key: "release", value: "2026.10" }] } as Record<string, Array<{ key: string; value: string }>>,
  };
  await page.route(/\/v1\/(traces|sessions|tracing|agents|evals\/datasets|annotation-queues)(\/|\?|$)/, async (route) => {
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
    if (p === "/v1/agents") return json(route, { agents: [{ id: MODEL_A, name: "Main model" }, { id: MODEL_B, name: "Review model" }] });
    if (p === "/v1/sessions") return json(route, { sessions: [], scope: "fleet" });
    if (p === "/v1/tracing/config")
      return json(route, {
        enabled: true,
        captureContent: false,
        previewMaxChars: 4000,
        otlp: { configured: true, endpoint: "https://otel.example.test/v1/traces", serviceName: "regulait-gateway", headerNames: [] },
        limits: "Export is a pull over a bounded window.",
        retention: "Traces follow the audit retention floor.",
        note: "",
        profiles: ["otel_genai", "openinference"],
        defaultProfile: "otel_genai",
        standards: { otelSemanticConventions: "1.43.0", openInferenceGenai: "0.4.0", openInferenceSemanticConventions: "2.14.0" },
      });
    if (p === "/v1/tracing/export") return json(route, { dryRun: true, endpoint: "https://otel.example.test/v1/traces", profile: body?.profile ?? "otel_genai", traceCount: 3, spanCount: 3, body: {}, limits: "" });
    if (p === "/v1/traces" && method === "GET") {
      const tagKey = url.searchParams.get("tagKey");
      const tagValue = url.searchParams.get("tagValue");
      const rows = st.traces
        .map((t) => ({ ...t, tags: st.tags[t.id] ?? [] }))
        .filter((t) => !tagKey || t.tags.some((g: Json) => g.key === tagKey && (tagValue === null || g.value === tagValue)));
      return json(route, { traces: rows, total: rows.length, scope: "fleet", note: "A trace shows what the gateway mediated." });
    }
    if (p === "/v1/traces/tags" && method === "POST") {
      const added: string[] = [];
      for (const id of body.traceIds) {
        st.tags[id] = [...(st.tags[id] ?? []).filter((g) => g.key !== body.key), { key: body.key, value: body.value }];
        added.push(id);
      }
      return json(route, { added: added.length, addedIds: added, skipped: [] });
    }
    if ((m = /^\/v1\/traces\/([^/]+)\/tags\/([^/]+)$/.exec(p))) {
      const id = m[1]!;
      const key = decodeURIComponent(m[2]!);
      if (method === "PUT") {
        st.tags[id] = [...(st.tags[id] ?? []).filter((g) => g.key !== key), { key, value: body.value }];
        return json(route, { traceId: id, key, value: body.value });
      }
      if (method === "DELETE") {
        st.tags[id] = (st.tags[id] ?? []).filter((g) => g.key !== key);
        return json(route, { traceId: id, key, removed: true });
      }
    }
    if ((m = /^\/v1\/traces\/([^/]+)$/.exec(p))) {
      const t = st.traces.find((x) => x.id === m![1]);
      if (!t) return json(route, { error: "not_found" }, 404);
      return json(route, {
        trace: t,
        tree: [
          {
            id: SPAN,
            traceId: t.id,
            parentSpanId: null,
            seq: 1,
            depth: 0,
            kind: "llm",
            name: "Main model",
            status: "ok",
            statusReason: null,
            startedAt: t.startedAt,
            endedAt: t.endedAt,
            durationMs: 1100,
            usageEventId: null,
            auditLogId: null,
            runId: null,
            nodeId: null,
            agentId: MODEL_A,
            mcpServerId: null,
            provider: "mock",
            model: "mock-balanced",
            inputTokens: 40,
            outputTokens: 12,
            costUsd: 0.0021,
            inputPreview: null,
            outputPreview: null,
            contentWithheld: false,
            attributes: null,
            children: [],
          },
        ],
        totals: { spans: 1, denied: 0, errors: 0, inputTokens: 40, outputTokens: 12, costUsd: 0.0021, maxDepth: 0 },
        partial: false,
        truncated: false,
        note: "",
        tags: st.tags[t.id] ?? [],
        scores: [{ spanId: SPAN, source: "annotation", name: "helpfulness", value: 4, label: "good" }],
      });
    }
    if (p === "/v1/evals/datasets" && method === "GET")
      return json(route, {
        datasets: [
          { id: DS_OPEN, name: "release regressions", version: 2, frozen: false },
          { id: DS_FROZEN, name: "baseline", version: 1, frozen: true },
        ],
      });
    if ((m = /^\/v1\/evals\/datasets\/([^/]+)\/from-traces$/.exec(p)))
      return json(route, { added: body.traceIds.length - 1, skipped: [{ id: body.traceIds[body.traceIds.length - 1], reason: "content_withheld" }] });
    if (p === "/v1/annotation-queues" && method === "GET") return json(route, { queues: [{ id: QUEUE, name: "Release review" }] });
    if ((m = /^\/v1\/annotation-queues\/([^/]+)\/items$/.exec(p))) return json(route, { added: body.subjects.length, skipped: [] });
    return route.fallback();
  });
  return st;
}

test.describe("ADR-0173 2c: traces as the evidence spine", () => {
  test("filters → tag chips → multi-select actions → tree tags and scores → export profile → automations slot", async ({ page }) => {
    const st = await installTracesMock(page);
    await page.goto("/ui/admin/traces");
    await expect(page.getByRole("heading", { level: 1, name: "Traces" })).toBeVisible();
    await expect(page.getByRole("button", { name: "release-notes summary" })).toBeVisible();
    await expect(page.getByText("Showing 3 of 3 matching traces.")).toBeVisible();
    await expectAxeClean(page, "traces, list");

    // the shared filters reach the query string
    await page.getByLabel("Model").fill("mock-balanced");
    await page.getByLabel("Cost at least (USD)").fill("0.001");
    await page.getByLabel("Agent").selectOption(MODEL_B);
    await expect
      .poll(() => st.calls.some((c) => c.method === "GET" && c.path.startsWith("/v1/traces?") && c.path.includes("model=mock-balanced") && c.path.includes("minCostUsd=0.001") && c.path.includes(`agentId=${MODEL_B}`)))
      .toBe(true);
    // a half-typed filter is explained, not sent
    await page.getByLabel("Score from").fill("3");
    await expect(page.getByRole("alert").filter({ hasText: "A score range needs a score name" })).toBeVisible();
    await page.getByRole("button", { name: /Clear filters/ }).click();

    // a tag chip filters by its tag
    await page.getByRole("button", { name: "Filter by tag release=2026.10" }).click();
    await expect(page.getByLabel("Tag key")).toHaveValue("release");
    await expect(page.getByRole("button", { name: "support reply draft" })).toHaveCount(0);
    await page.getByRole("button", { name: /Clear filters/ }).click();
    await expect(page.getByRole("button", { name: "support reply draft" })).toBeVisible();

    // multi-select and the three bulk actions
    await page.getByLabel("Select trace release-notes summary").check();
    await page.getByLabel("Select trace support reply draft").check();
    const bar = page.getByRole("region", { name: "Selected traces" });
    await expect(bar).toContainText("2 selected");
    await expect(bar.getByRole("option", { name: "baseline v1 (frozen)" })).toBeDisabled();
    await expectAxeClean(page, "traces, two selected");

    await bar.getByLabel("Dataset").selectOption(DS_OPEN);
    await bar.getByRole("button", { name: "Add to dataset" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Added 1 trace to release regressions; 1 skipped." })).toBeVisible();
    await expect(page.getByRole("list", { name: "Skipped traces" })).toContainText("content withheld");
    expect(sentTo(st, "POST", `/v1/evals/datasets/${DS_OPEN}/from-traces`)).toEqual([{ traceIds: [T1, T2] }]);

    await bar.getByLabel("Annotation queue").selectOption(QUEUE);
    await bar.getByRole("button", { name: "Send to annotation queue" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sent 2 traces to Release review." })).toBeVisible();
    expect(sentTo(st, "POST", `/v1/annotation-queues/${QUEUE}/items`)).toEqual([
      { subjects: [{ kind: "trace", id: T1 }, { kind: "trace", id: T2 }] },
    ]);

    await bar.getByLabel("Tag key").fill("Bad Key");
    await expect(bar.getByRole("button", { name: "Tag selected" })).toBeDisabled();
    await bar.getByLabel("Tag key").fill("team");
    await bar.getByLabel("Tag value").fill("payments");
    await bar.getByRole("button", { name: "Tag selected" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Tagged 2 traces team=payments." })).toBeVisible();
    expect(sentTo(st, "POST", "/v1/traces/tags")).toEqual([{ traceIds: [T1, T2], key: "team", value: "payments" }]);
    await expect(page.getByRole("button", { name: "Filter by tag team=payments" })).toHaveCount(2);
    await bar.getByRole("button", { name: "Clear selection" }).click();
    await expect(bar).toHaveCount(0);

    // the tree: tags edited in place, scores listed
    await page.getByRole("button", { name: "release-notes summary" }).click();
    const tags = page.getByRole("list", { name: "Trace tags" });
    await expect(tags).toContainText("release=2026.10");
    await expect(page.getByRole("cell", { name: "helpfulness" })).toBeVisible();
    await page.getByLabel("New tag key").fill("reviewed");
    await page.getByLabel("New tag value").fill("yes");
    await page.getByRole("button", { name: "Add tag" }).click();
    await expect(tags).toContainText("reviewed=yes");
    expect(sentTo(st, "PUT", `/v1/traces/${T1}/tags/reviewed`)).toEqual([{ value: "yes" }]);
    await expectAxeClean(page, "trace tree with tags and scores");
    await tags.getByRole("button", { name: "Remove tag release" }).click();
    await expect(tags).not.toContainText("release=2026.10");
    expect(sentTo(st, "DELETE", `/v1/traces/${T1}/tags/release`)).toHaveLength(1);

    // the export profile rides the export call
    await page.getByLabel("Export profile", { exact: true }).selectOption("openinference");
    await page.getByRole("button", { name: "Dry run" }).click();
    await expect.poll(() => sentTo(st, "POST", "/v1/tracing/export")).toEqual([{ dryRun: true, limit: 25, profile: "openinference" }]);
    await expect(page.getByText("Pinned conventions: OpenTelemetry semantic conventions 1.43.0")).toBeVisible();

    // the Automations slot
    await page.getByRole("tab", { name: "Automations" }).click();
    await expect(page.getByText("Automation rules are set up by an admin.")).toBeVisible();
    await expectAxeClean(page, "traces, automations tab");
  });
});
