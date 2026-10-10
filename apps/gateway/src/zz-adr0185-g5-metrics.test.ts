/**
 * ADR-0185 G5 — `/metrics`: the red proofs.
 *
 *  - a scrape returns the series (separate listener and main listener);
 *  - no token / wrong token → 401 `metrics_unauthorized`, counted;
 *  - a listener (or the main-listener flag) without a usable token fails boot;
 *  - the main-listener path is 404 by default;
 *  - 10,000 distinct raw paths and uuid query strings add at most
 *    (templates hit + 1) route series;
 *  - after decision traffic no label value is an email or a user uuid;
 *  - breaker transitions, upstream operations and job runs are counted with
 *    fixed-vocabulary labels.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDb, eq, mcpServers, mcpTools, runMigrations, sql, toolGrants, users, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { startGateway } from "./boot.js";
import {
  MAX_SERVER_ID_LABELS,
  METRIC_CARDINALITY_LIMIT,
  MetricsBootError,
  describeMetricsPosture,
  observeUpstream,
  recordDecision,
  resolveMetricsConfig,
  safeLabel,
  scrapeMetricsText,
} from "./metrics.js";
import { recordUpstreamFailure, recordUpstreamSuccess, breakerAdmits, type BreakerConfig } from "./upstream-breaker.js";
import { withUpstreamRetry } from "./upstream-retry.js";
import { Scheduler, syncSchedulerJobs, toRegistry, type SchedulerJobDefinition } from "./scheduler.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const BOOT = "adr0185-g5-metrics-boot";
// Its OWN scratch database: the boot below runs the real data-key check
// (verifyDataKeyOnBoot), which refuses a database holding ciphertexts under
// another key and no recorded fingerprint. On the shared suite database that
// passed or failed depending on which files ran before this one; with the
// gateway suite sharded by `vitest --shard`, that order is no longer the
// unsharded one (measured 2026-10-10: shard 4/4 refused the boot).
const SCRATCH_DB = `regulait_g5_metrics_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
})();
const TOKEN = "m".repeat(20) + "synthetic-token-0185"; // 40 chars, synthetic
const DATA_KEY = "a".repeat(64);

// ports reserved for this agent (≥ 4310)
const PORT_GATEWAY = 4310;
const PORT_METRICS = 4311;
const PORT_REFUSED_GW = 4312;
const PORT_REFUSED_METRICS = 4313;

const EMAIL_RE = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** a minimal parse of the exposition text: every sample line */
function parseExposition(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m) throw new Error(`unparseable exposition line: ${line}`);
    const labels: Record<string, string> = {};
    const body = m[2] ?? "";
    const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
    let l: RegExpExecArray | null;
    while ((l = re.exec(body))) labels[l[1]!] = l[2]!;
    out.push({ name: m[1]!, labels, value: Number(m[3]) });
  }
  return out;
}

async function samples(): Promise<Sample[]> {
  return parseExposition(await scrapeMetricsText());
}

function value(all: Sample[], name: string, labels: Record<string, string>): number {
  return all
    .filter((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))
    .reduce((a, s) => a + s.value, 0);
}

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

async function get(port: number, urlPath: string, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { headers });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

function bootEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, VITEST: "1", REGULAIT_SCHEDULER: "off", ...extra } as NodeJS.ProcessEnv;
}

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(scratchUrl);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
}, 60_000);
afterAll(async () => {
  await closeAll([
    async () => app?.close(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH_DB),
    async () => admin.$client.end(),
  ]);
});

describe("configuration — a metrics setting without a usable token refuses", () => {
  it("off by default; a listener or the main-listener flag needs a ≥ 32-char token", () => {
    expect(resolveMetricsConfig({})).toEqual({ listen: null, onMainListener: false, token: null });
    expect(() => resolveMetricsConfig({ REGULAIT_METRICS_LISTEN: "127.0.0.1:9464" })).toThrow(MetricsBootError);
    expect(() => resolveMetricsConfig({ REGULAIT_METRICS_LISTEN: "127.0.0.1:9464" })).toThrow(/REGULAIT_METRICS_TOKEN is not set/);
    expect(() =>
      resolveMetricsConfig({ REGULAIT_METRICS_LISTEN: "9464", REGULAIT_METRICS_TOKEN: "x".repeat(31) }),
    ).toThrow(/31 characters; at least 32/);
    expect(() => resolveMetricsConfig({ REGULAIT_METRICS_ON_MAIN_LISTENER: "1" })).toThrow(MetricsBootError);
    expect(() => resolveMetricsConfig({ REGULAIT_METRICS_ON_MAIN_LISTENER: "enabled" })).toThrow(/must be one of/);
    expect(() =>
      resolveMetricsConfig({ REGULAIT_METRICS_LISTEN: "host:99999", REGULAIT_METRICS_TOKEN: TOKEN }),
    ).toThrow(/host:port/);
    const ok = resolveMetricsConfig({ REGULAIT_METRICS_LISTEN: "9464", REGULAIT_METRICS_TOKEN: TOKEN });
    // a bare port binds loopback, never every interface
    expect(ok.listen).toEqual({ host: "127.0.0.1", port: 9464 });
    expect(describeMetricsPosture(ok, null)).toBe(
      "separate listener on 127.0.0.1:9464/metrics (bearer token); main listener /metrics: off (404)",
    );
    expect(describeMetricsPosture(resolveMetricsConfig({}), null)).toBe(
      "off (REGULAIT_METRICS_LISTEN unset); main listener /metrics: off (404)",
    );
  });

  it("safeLabel folds anything outside a label's vocabulary", () => {
    expect(safeLabel("surface", "mcp_tool")).toBe("mcp_tool");
    expect(safeLabel("surface", "alice@corp.example")).toBe("other");
    expect(safeLabel("effect", "deny")).toBe("deny");
    expect(safeLabel("effect", "user:1234")).toBe("other");
    expect(safeLabel("server_id", randomUUID())).toMatch(UUID_ANY);
    expect(safeLabel("server_id", "https://upstream.example/mcp")).toBe("invalid");
    expect(safeLabel("transport", "ws")).toBe("unknown");
    expect(safeLabel("job", "a-job-nobody-registered")).toBe("other");
    expect(safeLabel("method", "PROPFIND")).toBe("OTHER");
  });
});

describe("boot", () => {
  it("REGULAIT_METRICS_LISTEN without a token fails the boot, and nothing listens", async () => {
    await expect(
      startGateway({
        db,
        migrationsFolder,
        port: PORT_REFUSED_GW,
        host: "127.0.0.1",
        bootstrapToken: BOOT,
        dataKey: DATA_KEY,
        log: () => {},
        env: bootEnv({ REGULAIT_METRICS_LISTEN: `127.0.0.1:${PORT_REFUSED_METRICS}` }),
      }),
    ).rejects.toBeInstanceOf(MetricsBootError);
    expect(await listening(PORT_REFUSED_GW)).toBe(false);
    expect(await listening(PORT_REFUSED_METRICS)).toBe(false);
  });

  it("the separate listener: 401 without or with a wrong token (counted), the series with the right one", async () => {
    const lines: string[] = [];
    const started = await startGateway({
      db,
      migrationsFolder,
      port: PORT_GATEWAY,
      host: "127.0.0.1",
      bootstrapToken: BOOT,
      dataKey: DATA_KEY,
      log: (l) => lines.push(l),
      env: bootEnv({ REGULAIT_METRICS_LISTEN: `127.0.0.1:${PORT_METRICS}`, REGULAIT_METRICS_TOKEN: TOKEN }),
    });
    try {
      expect(started.metricsAddress).toBe(`127.0.0.1:${PORT_METRICS}`);
      expect(lines).toContain(
        `  metrics:   separate listener on 127.0.0.1:${PORT_METRICS}/metrics (bearer token); main listener /metrics: off (404)`,
      );
      // some traffic on the public listener, so the HTTP series exist
      expect((await get(PORT_GATEWAY, "/health")).status).toBe(200);

      const before = value(await samples(), "regulait_metrics_unauthorized_total", { listener: "separate" });
      const none = await get(PORT_METRICS, "/metrics");
      expect(none.status).toBe(401);
      expect(JSON.parse(none.text)).toEqual({ error: "metrics_unauthorized" });
      expect(none.headers.get("www-authenticate")).toMatch(/^Bearer/);
      const wrong = await get(PORT_METRICS, "/metrics", { authorization: `Bearer ${TOKEN.slice(0, -1)}x` });
      expect(wrong.status).toBe(401);
      const basic = await get(PORT_METRICS, "/metrics", { authorization: `Basic ${TOKEN}` });
      expect(basic.status).toBe(401);
      expect(value(await samples(), "regulait_metrics_unauthorized_total", { listener: "separate" })).toBe(before + 3);

      const ok = await get(PORT_METRICS, "/metrics", { authorization: `Bearer ${TOKEN}` });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toMatch(/^text\/plain/);
      expect(ok.text).toMatch(/^regulait_http_requests_total\{method="GET",route="\/health",status_class="2xx"\} \d+/m);
      expect(ok.text).toContain("# TYPE regulait_http_request_duration_seconds histogram");
      expect(ok.text).toMatch(/^regulait_http_request_duration_seconds_bucket\{method="GET",route="\/health",status_class="2xx",le="0\.005"\}/m);
      // no resource or scope labels ride along
      expect(ok.text).not.toMatch(/target_info|otel_scope_name|service_name|host_name/);

      // the listener serves /metrics and nothing else
      expect((await get(PORT_METRICS, "/health", { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
      // the public listener has no /metrics by default
      expect((await get(PORT_GATEWAY, "/metrics", { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
    } finally {
      await started.app.close();
    }
    // closing the gateway closes the metrics listener too
    expect(await listening(PORT_METRICS)).toBe(false);
  });
});

describe("the main listener", () => {
  it("GET /metrics is 404 by default, with or without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(404);
    const anon = await app.inject({ method: "GET", url: "/metrics" });
    expect(anon.statusCode).toBe(404);
  });

  it("REGULAIT_METRICS_ON_MAIN_LISTENER mounts it behind the same token check", async () => {
    const prior = { on: process.env.REGULAIT_METRICS_ON_MAIN_LISTENER, tok: process.env.REGULAIT_METRICS_TOKEN };
    process.env.REGULAIT_METRICS_ON_MAIN_LISTENER = "1";
    process.env.REGULAIT_METRICS_TOKEN = TOKEN;
    const mainApp = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
    try {
      const before = value(await samples(), "regulait_metrics_unauthorized_total", { listener: "main" });
      const none = await mainApp.inject({ method: "GET", url: "/metrics" });
      expect(none.statusCode).toBe(401);
      expect(none.json()).toEqual({ error: "metrics_unauthorized" });
      // the bootstrap admin token is NOT the metrics token
      const admin = await mainApp.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${BOOT}` } });
      expect(admin.statusCode).toBe(401);
      expect(value(await samples(), "regulait_metrics_unauthorized_total", { listener: "main" })).toBe(before + 2);
      const ok = await mainApp.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${TOKEN}` } });
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toContain('regulait_http_requests_total{method="GET",route="/metrics",status_class="4xx"}');
    } finally {
      await mainApp.close();
      if (prior.on === undefined) delete process.env.REGULAIT_METRICS_ON_MAIN_LISTENER;
      else process.env.REGULAIT_METRICS_ON_MAIN_LISTENER = prior.on;
      if (prior.tok === undefined) delete process.env.REGULAIT_METRICS_TOKEN;
      else process.env.REGULAIT_METRICS_TOKEN = prior.tok;
    }
  });
});

describe("cardinality", () => {
  it("10,000 distinct raw paths and uuid query strings add at most (templates hit + 1) route series", async () => {
    const routesBefore = new Set(
      (await samples()).filter((s) => s.name === "regulait_http_requests_total").map((s) => s.labels.route!),
    );
    const N = 10_000;
    const batch = 200;
    for (let i = 0; i < N; i += batch) {
      await Promise.all(
        Array.from({ length: batch }, (_, j) => {
          const n = i + j;
          const id = randomUUID();
          const url =
            n % 4 === 0
              ? `/no-such-route/${id}/${n}` // unmatched
              : n % 4 === 1
                ? `/health?user=${id}&email=u${n}@corp.example` // matched, query differs
                : n % 4 === 2
                  ? `/v1/servers/${id}/tools` // a parameterised template
                  : `/ui-${id}?q=${n}`; // unmatched again
          return app.inject({ method: "GET", url });
        }),
      );
    }
    const all = (await samples()).filter((s) => s.name === "regulait_http_requests_total");
    const routes = new Set(all.map((s) => s.labels.route!));
    const added = [...routes].filter((r) => !routesBefore.has(r));
    // the three templates this flood can hit, plus "unmatched"
    const allowed = new Set(["/health", "/v1/servers/:serverId/tools", "unmatched"]);
    for (const r of added) expect(allowed.has(r), `unexpected route series ${r}`).toBe(true);
    expect(added.length).toBeLessThanOrEqual(3);
    for (const r of routes) {
      expect(r).not.toMatch(UUID_ANY);
      expect(r).not.toContain("?");
      expect(r).not.toMatch(EMAIL_RE);
    }
    expect(value(all, "regulait_http_requests_total", { route: "unmatched" })).toBeGreaterThanOrEqual(N / 2);
    // the matched requests keep their TEMPLATE (not folded into "unmatched")
    expect(value(all, "regulait_http_requests_total", { route: "/v1/servers/:serverId/tools" })).toBeGreaterThanOrEqual(N / 4);
    expect(value(all, "regulait_http_requests_total", { route: "/health" })).toBeGreaterThanOrEqual(N / 4);
  }, 120_000);
});

describe("labels never carry a person", () => {
  it("after decision traffic no label value is an email or a user uuid", async () => {
    const email = `metrics-${randomUUID()}@people.example`;
    const [u] = await db.insert(users).values({ email, displayName: "Metrics Person" }).returning({ id: users.id });
    const userId = u!.id;
    const [s] = await db
      .insert(mcpServers)
      .values({ name: `g5-metrics-${randomUUID()}`, url: "http://127.0.0.1:9/" })
      .returning({ id: mcpServers.id });
    const serverId = s!.id;
    const TOOL = "g5_read_tool";
    await db.insert(mcpTools).values({ serverId, name: TOOL, kind: "read" });
    await db.insert(toolGrants).values({ userId, serverId, toolName: TOOL });

    const before = value(await samples(), "regulait_governance_decisions_total", { surface: "mcp_tool" });
    const auth = { authorization: `Bearer ${BOOT}` };
    for (const toolName of [TOOL, "g5_unregistered_tool"]) {
      const res = await app.inject({ method: "POST", url: "/v1/evaluate", headers: auth, payload: { userId, serverId, toolName } });
      expect([200, 404]).toContain(res.statusCode);
    }
    // a caller that tries to smuggle a person into a label gets the fallback
    recordDecision({ surface: email as never, effect: userId as never });

    const all = await samples();
    expect(value(all, "regulait_governance_decisions_total", { surface: "mcp_tool" })).toBeGreaterThan(before);
    expect(value(all, "regulait_governance_decisions_total", { surface: "other", effect: "other" })).toBeGreaterThanOrEqual(1);
    for (const sample of all) {
      for (const [k, v] of Object.entries(sample.labels)) {
        expect(v, `${sample.name}{${k}}`).not.toMatch(EMAIL_RE);
        expect(v, `${sample.name}{${k}}`).not.toContain(userId);
        // the only uuid-shaped label is an upstream server id
        if (UUID_ANY.test(v)) expect(k, `${sample.name}{${k}="${v}"}`).toBe("server_id");
        expect(v).not.toContain(TOOL);
      }
    }
  });
});

describe("upstream, breaker and scheduler series", () => {
  it("breaker transitions, the state gauge, upstream outcomes and job runs", async () => {
    const [s] = await db
      .insert(mcpServers)
      .values({ name: `g5-breaker-${randomUUID()}`, url: "http://127.0.0.1:9/" })
      .returning();
    const serverId = s!.id;
    const cfg: BreakerConfig = { failureThreshold: 2, cooldownMs: 60_000 } as BreakerConfig;
    const row = () =>
      db.select().from(mcpServers).where(eq(mcpServers.id, serverId)).then((r) => r[0]!);

    const t0 = await samples();
    const openedBefore = value(t0, "regulait_mcp_breaker_transitions_total", { to: "open" });
    const closedBefore = value(t0, "regulait_mcp_breaker_transitions_total", { to: "closed" });

    await recordUpstreamFailure(db, await row(), "synthetic failure 1", cfg);
    await recordUpstreamFailure(db, await row(), "synthetic failure 2", cfg);
    let all = await samples();
    expect(value(all, "regulait_mcp_breaker_transitions_total", { to: "open" })).toBe(openedBefore + 1);
    expect(value(all, "regulait_mcp_breaker_state", { server_id: serverId })).toBe(1);

    // a fast-fail is a circuit_open upstream operation
    expect(await breakerAdmits(db, await row(), cfg)).not.toBeNull();
    all = await samples();
    expect(
      value(all, "regulait_mcp_upstream_requests_total", { server_id: serverId, transport: "streamable_http", outcome: "circuit_open" }),
    ).toBe(1);

    await recordUpstreamSuccess(db, await row());
    all = await samples();
    expect(value(all, "regulait_mcp_breaker_transitions_total", { to: "closed" })).toBe(closedBefore + 1);
    expect(value(all, "regulait_mcp_breaker_state", { server_id: serverId })).toBe(0);

    // one observed retry sequence = one operation, whatever the attempts
    await withUpstreamRetry(async () => "ok", { budgetMs: 1000, observe: { serverId, transport: "streamable_http" } });
    await expect(
      withUpstreamRetry(
        async () => {
          throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        },
        { budgetMs: 1000, maxAttempts: 3, sleep: async () => {}, observe: { serverId, transport: "sse" } },
      ),
    ).rejects.toThrow("reset");
    all = await samples();
    expect(value(all, "regulait_mcp_upstream_requests_total", { server_id: serverId, outcome: "ok" })).toBe(1);
    expect(value(all, "regulait_mcp_upstream_requests_total", { server_id: serverId, transport: "sse", outcome: "error" })).toBe(1);
    expect(value(all, "regulait_mcp_upstream_duration_seconds_count", { transport: "sse" })).toBeGreaterThanOrEqual(1);

    // a scheduler run, by its registered name
    const job: SchedulerJobDefinition = {
      name: "g5-metrics-test-job",
      description: "counts one run",
      adr: "ADR-0185",
      defaultIntervalSeconds: 3600,
      run: async () => ({ itemsProcessed: 0 }),
    };
    const registry = toRegistry([job]);
    await syncSchedulerJobs(db, registry);
    const sched = new Scheduler(db, { registry });
    const out = await sched.runNow(job.name, null);
    expect(out.outcome).toBe("ok");
    all = await samples();
    expect(value(all, "regulait_scheduler_job_runs_total", { job: job.name, outcome: "ok" })).toBe(1);
  });
});

// LAST on purpose: it fills the server-id label cap, after which a new id
// reads "overflow" (the breaker test above needs its own id to be a label).
describe("cardinality backstops", () => {
  it("the SDK limit caps one scrape interval at 500 series; the server-id cap bounds the lifetime", async () => {
    // a uuid IS a well-formed server_id, so the allow-list's shape check lets
    // each one through; the two caps are what bound them
    const prior = (await samples()).filter((s) => s.name === "regulait_mcp_upstream_requests_total").length;
    // 200 ids × 3 transports × 5 outcomes = 3,000 combinations in ONE interval
    const outcomes = ["ok", "error", "timeout", "refused", "circuit_open"] as const;
    for (let i = 0; i < 200; i += 1) {
      const serverId = randomUUID();
      for (const transport of ["streamable_http", "sse", "stdio"] as const) {
        for (const outcome of outcomes) observeUpstream({ serverId, transport, outcome }, 1);
      }
    }
    let series = (await samples()).filter((s) => s.name === "regulait_mcp_upstream_requests_total");
    // (the series earlier scrapes already exported stay; this interval adds ≤ 500)
    expect(series.length).toBeLessThanOrEqual(prior + METRIC_CARDINALITY_LIMIT);
    expect(series.some((s) => s.labels.otel_metric_overflow === "true")).toBe(true);
    // a second interval, after a scrape reset the SDK's per-cycle map
    for (let i = 0; i < 1_000; i += 1) {
      observeUpstream({ serverId: randomUUID(), transport: "stdio", outcome: "refused" }, 0);
    }
    series = (await samples()).filter((s) => s.name === "regulait_mcp_upstream_requests_total");
    const ids = new Set(series.map((s) => s.labels.server_id).filter((v) => v !== undefined));
    expect(ids.size).toBeLessThanOrEqual(MAX_SERVER_ID_LABELS + 1);
    expect(ids.has("overflow")).toBe(true);
  });
});
