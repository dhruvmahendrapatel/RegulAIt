/**
 * ADR-0301 — OTLP metrics push. No database: the allow-list, resolver and
 * receiver are injected, so each test pins one rule of the push path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOtlpMetricsPusher,
  describeOtlpMetricsPosture,
  OTLP_METRICS_LIMITS,
  resolveOtlpMetricsConfig,
  type OtlpMetricsConfig,
} from "./metrics-otlp.js";
import { MetricsBootError, otlpPushReaderRegistered, recordDecision, scrapeMetricsText } from "./metrics.js";
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
