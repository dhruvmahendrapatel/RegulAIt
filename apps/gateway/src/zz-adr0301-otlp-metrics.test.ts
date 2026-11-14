/**
 * ADR-0301 — OTLP metrics push. No database: the allow-list, resolver and
 * receiver are injected, so each test pins one rule of the push path.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createOtlpMetricsPusher,
  describeOtlpMetricsPosture,
  OTLP_METRICS_LIMITS,
  resolveOtlpMetricsConfig,
  type OtlpMetricsConfig,
} from "./metrics-otlp.js";
import {
  MetricsBootError,
  disablePrometheusReader,
  otlpPushReaderRegistered,
  prometheusReaderRegistered,
  recordDecision,
  resetMetricReadersForTest,
  scrapeMetricsText,
} from "./metrics.js";
import type { EgressAllowEntry } from "./egress-guard.js";

const ENDPOINT = "https://collector.example.com/v1/metrics";
const SECRET = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
const allow: EgressAllowEntry[] = [{ host: "collector.example.com", allowPrivateRanges: false, allowPlaintextHttp: false }];
const resolve = async () => [{ address: "93.184.216.34", family: 4 }];

function cfg(over: Partial<OtlpMetricsConfig> = {}): OtlpMetricsConfig {
  return { endpoint: ENDPOINT, intervalMs: 60_000, headers: { authorization: SECRET }, ...over };
}

interface Seen {
  url: string;
  headers: Headers;
  body: string;
}
function receiver(status = 200, seen: Seen[] = []): { fetchImpl: typeof fetch; seen: Seen[] } {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: new TextDecoder().decode(init?.body as Uint8Array),
    });
    return new Response("{}", { status });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function pushCount(text: string, outcome: string): number {
  const m = new RegExp(`^regulait_metrics_otlp_pushes_total\\{outcome="${outcome}"\\} (\\d+)`, "m").exec(text);
  return m ? Number(m[1]) : 0;
}

describe("ADR-0301 config: off by default, a bad setting refuses the boot", () => {
  it("no endpoint is the shipped state; ambient OTEL_* variables are not read", () => {
    expect(resolveOtlpMetricsConfig({})).toBeNull();
    expect(
      resolveOtlpMetricsConfig({
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: ENDPOINT,
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com",
      }),
    ).toBeNull();
    expect(describeOtlpMetricsPosture(null)).toMatch(/off/);
  });

  it("parses endpoint, interval and headers; the posture line names headers, never values", () => {
    const c = resolveOtlpMetricsConfig({
      REGULAIT_METRICS_OTLP_ENDPOINT: ENDPOINT,
      REGULAIT_METRICS_OTLP_INTERVAL_SECONDS: "30",
      REGULAIT_METRICS_OTLP_HEADERS: `Authorization=${SECRET},X-Tenant=a1`,
    })!;
    expect(c).toEqual({ endpoint: ENDPOINT, intervalMs: 30_000, headers: { authorization: SECRET, "x-tenant": "a1" } });
    const line = describeOtlpMetricsPosture(c);
    expect(line).toContain("authorization");
    expect(line).not.toContain("abcdefghij");
    expect(resolveOtlpMetricsConfig({ REGULAIT_METRICS_OTLP_ENDPOINT: ENDPOINT })!.intervalMs).toBe(
      OTLP_METRICS_LIMITS.defaultIntervalSeconds * 1000,
    );
  });

  it.each([
    [{ REGULAIT_METRICS_OTLP_INTERVAL_SECONDS: "30" }],
    [{ REGULAIT_METRICS_OTLP_ENDPOINT: "not a url" }],
    [{ REGULAIT_METRICS_OTLP_ENDPOINT: "ftp://collector.example.com/x" }],
    [{ REGULAIT_METRICS_OTLP_ENDPOINT: "https://user:pw@collector.example.com/v1/metrics" }],
    [{ REGULAIT_METRICS_OTLP_ENDPOINT: "https://collector.example.com/v1/metrics?api_key=secret" }],
    [{ REGULAIT_METRICS_OTLP_ENDPOINT: ENDPOINT, REGULAIT_METRICS_OTLP_INTERVAL_SECONDS: "5" }],
    [{ REGULAIT_METRICS_OTLP_ENDPOINT: ENDPOINT, REGULAIT_METRICS_OTLP_INTERVAL_SECONDS: "1e3" }],
    [{ REGULAIT_METRICS_OTLP_ENDPOINT: ENDPOINT, REGULAIT_METRICS_OTLP_HEADERS: "Host=evil" }],
    [{ REGULAIT_METRICS_OTLP_ENDPOINT: ENDPOINT, REGULAIT_METRICS_OTLP_HEADERS: "novalue" }],
    [{ REGULAIT_METRICS_OTLP_ENDPOINT: ENDPOINT, REGULAIT_METRICS_OTLP_HEADERS: "a=1,A=2" }],
  ])("refuses %o", (env) => {
    expect(() => resolveOtlpMetricsConfig(env)).toThrow(MetricsBootError);
  });

  it("a refusal never echoes a header value", () => {
    try {
      resolveOtlpMetricsConfig({
        REGULAIT_METRICS_OTLP_ENDPOINT: ENDPOINT,
        REGULAIT_METRICS_OTLP_HEADERS: `authorization=${SECRET}\u0007`,
      });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("abcdefghij");
    }
  });
});

// review item 1: runs FIRST in this file (module state is per file), before any pusher registers the reader
describe("ADR-0301 the push reader exists only when a push is configured", () => {
  it("with no pusher the meter has only the Prometheus reader, and repeated scrapes work", async () => {
    expect(otlpPushReaderRegistered()).toBe(false);
    for (let i = 0; i < 50; i += 1) {
      recordDecision({ surface: "agent", effect: "allow" });
      await scrapeMetricsText();
    }
    expect(otlpPushReaderRegistered()).toBe(false);
  });

  it("creating a pusher registers it (the meter is rebuilt once, empty), and recording and scraping still work", async () => {
    createOtlpMetricsPusher(null, cfg(), { loadAllowList: async () => [] });
    expect(otlpPushReaderRegistered()).toBe(true);
    recordDecision({ surface: "agent", effect: "allow" });
    expect(await scrapeMetricsText()).toContain("regulait_governance_decisions_total");
  });
});

describe("ADR-0301 push: the same series as /metrics, through the egress guard", () => {
  it("posts OTLP/JSON with the configured headers, carrying the meter's series and only service.name", async () => {
    recordDecision({ surface: "agent", effect: "deny" });
    const { fetchImpl, seen } = receiver(200);
    const p = createOtlpMetricsPusher(null, cfg(), { loadAllowList: async () => allow, resolve, fetchImpl });
    expect(await p.pushOnce()).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(ENDPOINT);
    expect(seen[0]!.headers.get("content-type")).toBe("application/json");
    expect(seen[0]!.headers.get("authorization")).toBe(SECRET);
    const body = JSON.parse(seen[0]!.body);
    const rm = body.resourceMetrics[0];
    expect(rm.resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "regulait-gateway" } }]);
    const names = rm.scopeMetrics.flatMap((s: { metrics: Array<{ name: string }> }) => s.metrics.map((m) => m.name));
    expect(names).toContain("regulait_governance_decisions_total");
    // second review, item 4: a real data point, cumulative, carrying only allow-listed attribute keys
    type Pt = { asInt?: string | number; asDouble?: number; attributes: Array<{ key: string; value: { stringValue?: string } }> };
    const decisions = rm.scopeMetrics
      .flatMap((s: { metrics: Array<{ name: string; sum?: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: Pt[] } }> }) => s.metrics)
      .find((m: { name: string }) => m.name === "regulait_governance_decisions_total")!;
    expect(decisions.sum!.aggregationTemporality).toBe(2); // AGGREGATION_TEMPORALITY_CUMULATIVE
    expect(decisions.sum!.isMonotonic).toBe(true);
    const deny = decisions.sum!.dataPoints.find((p: Pt) => p.attributes.some((a) => a.key === "effect" && a.value.stringValue === "deny"))!;
    expect(Number(deny.asInt ?? deny.asDouble)).toBeGreaterThanOrEqual(1);
    for (const p of decisions.sum!.dataPoints) {
      expect(p.attributes.map((a: { key: string }) => a.key).sort()).toEqual(["effect", "surface"]);
    }
    await p.stop();
  });

  it("an empty allow-list sends nothing (default-deny) and counts egress_blocked", async () => {
    const before = pushCount(await scrapeMetricsText(), "egress_blocked");
    const { fetchImpl, seen } = receiver(200);
    const p = createOtlpMetricsPusher(null, cfg(), { loadAllowList: async () => [], resolve, fetchImpl });
    expect(await p.pushOnce()).toBe("egress_blocked");
    expect(seen).toHaveLength(0);
    expect(pushCount(await scrapeMetricsText(), "egress_blocked")).toBe(before + 1);
  });

  it("plain http is refused unless the allow entry permits it", async () => {
    const { fetchImpl, seen } = receiver(200);
    const p = createOtlpMetricsPusher(null, cfg({ endpoint: "http://collector.example.com/v1/metrics" }), {
      loadAllowList: async () => allow,
      resolve,
      fetchImpl,
    });
    expect(await p.pushOnce()).toBe("egress_blocked");
    expect(seen).toHaveLength(0);
  });

  it("a non-2xx answer is 'rejected', a throw is 'failed', and neither throws", async () => {
    const lines: string[] = [];
    const p = createOtlpMetricsPusher(null, cfg(), {
      loadAllowList: async () => allow,
      resolve,
      fetchImpl: receiver(503).fetchImpl,
      log: (l) => lines.push(l),
    });
    expect(await p.pushOnce()).toBe("rejected");
    expect(await p.pushOnce()).toBe("rejected");
    // logged once per change of outcome, never with the header value
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("abcdefghij");

    const boom = createOtlpMetricsPusher(null, cfg(), {
      loadAllowList: async () => allow,
      resolve,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    expect(await boom.pushOnce()).toBe("failed");
    const noList = createOtlpMetricsPusher(null, cfg(), {
      loadAllowList: async () => {
        throw new Error("db down");
      },
    });
    expect(await noList.pushOnce()).toBe("failed");
  });

  it("one push at a time: a second call while one is in flight shares it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const p = createOtlpMetricsPusher(null, cfg(), {
      loadAllowList: async () => allow,
      resolve,
      fetchImpl: (async () => {
        calls++;
        await gate;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    const a = p.pushOnce();
    const b = p.pushOnce();
    release();
    expect(await a).toBe("ok");
    expect(await b).toBe("ok");
    expect(calls).toBe(1);
  });
});

describe("ADR-0301 the timer and a graceful stop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushes on each interval, and stop() sends one bounded final push", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { fetchImpl, seen } = receiver(200);
    const p = createOtlpMetricsPusher(null, cfg({ intervalMs: 10_000 }), { loadAllowList: async () => allow, resolve, fetchImpl, start: true });
    expect(seen).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    await p.stop();
    expect(seen).toHaveLength(3);
    // stopped: no more ticks, and a second stop() sends nothing
    await vi.advanceTimersByTimeAsync(30_000);
    await p.stop();
    expect(seen).toHaveLength(3);
  });

  it("a pusher that was never started sends no final push", async () => {
    const { fetchImpl, seen } = receiver(200);
    const p = createOtlpMetricsPusher(null, cfg(), { loadAllowList: async () => allow, resolve, fetchImpl });
    await p.stop();
    expect(seen).toHaveLength(0);
  });
});

describe("ADR-0301 second review: no reader that never collects, and a bounded shutdown", () => {
  afterAll(() => {
    vi.useRealTimers();
    // review item 5: the reader flags are process-wide; hand the next test file a clean meter
    resetMetricReadersForTest();
  });

  it("OTLP only: with no scrape surface the Prometheus reader is absent, however many pushes run", async () => {
    disablePrometheusReader();
    const { fetchImpl, seen } = receiver(200);
    const p = createOtlpMetricsPusher(null, cfg(), { loadAllowList: async () => allow, resolve, fetchImpl });
    for (let i = 0; i < 25; i += 1) {
      recordDecision({ surface: "agent", effect: "allow" });
      expect(await p.pushOnce()).toBe("ok");
    }
    expect(seen).toHaveLength(25);
    expect(prometheusReaderRegistered()).toBe(false);
    expect(otlpPushReaderRegistered()).toBe(true);
    await p.stop();
  });

  it("the meter is collected before the allow-list loads, so a database outage still drains the push reader", async () => {
    const order: string[] = [];
    const p = createOtlpMetricsPusher(null, cfg(), {
      loadAllowList: async () => {
        order.push("allow-list");
        throw new Error("db down");
      },
    });
    recordDecision({ surface: "agent", effect: "allow" });
    expect(await p.pushOnce()).toBe("failed");
    expect(order).toEqual(["allow-list"]);
  });

  it("a hung collector is cut off at the push deadline", async () => {
    const hang = (async (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)))) as typeof fetch;
    const p = createOtlpMetricsPusher(null, cfg(), { loadAllowList: async () => allow, resolve, fetchImpl: hang, timeoutMs: 50 });
    const t0 = Date.now();
    expect(await p.pushOnce()).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("stop() aborts a push in flight instead of waiting out its deadline, then sends the final push", async () => {
    let calls = 0;
    let atCollector!: () => void;
    const reached = new Promise<void>((r) => (atCollector = r));
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        atCollector();
        return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    // a 30 s deadline: without the abort, stop() would wait the whole of it
    const p = createOtlpMetricsPusher(null, cfg(), { loadAllowList: async () => allow, resolve, fetchImpl, timeoutMs: 30_000, start: true });
    const first = p.pushOnce();
    await reached; // the first push is at the (hung) collector
    const t0 = Date.now();
    await p.stop();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await first).toBe("failed");
    expect(calls).toBe(2);
  });

  it("the final push is bounded as a whole, including a hung allow-list load", async () => {
    let loads = 0;
    const p = createOtlpMetricsPusher(null, cfg(), {
      loadAllowList: () => {
        loads += 1;
        return loads === 1 ? Promise.resolve(allow) : new Promise<EgressAllowEntry[]>(() => {});
      },
      resolve,
      fetchImpl: receiver(200).fetchImpl,
      start: true,
    });
    expect(await p.pushOnce()).toBe("ok");
    // real time: AbortSignal.timeout runs on Node's own timers, which fake timers do not drive
    const t0 = Date.now();
    await p.stop();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(4_500);
    expect(took).toBeLessThan(7_000);
  }, 15_000);
});
