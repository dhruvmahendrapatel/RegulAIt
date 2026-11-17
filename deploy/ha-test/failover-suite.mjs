#!/usr/bin/env node
/**
 * ADR-0343 slice 3: the control-plane FAILOVER SUITE.
 *
 * It runs two gateway replicas against a Postgres primary that has one SYNCHRONOUS standby. The replicas reach the
 * database through a writer endpoint (writer-proxy.mjs). While they serve governed decisions, the suite does three
 * things in turn:
 *   1. it kills a gateway replica (SIGKILL), and the other keeps serving;
 *   2. it kills the database primary (an immediate stop, the same as a crash), promotes the standby and repoints the
 *      writer endpoint; the replicas reconnect;
 *   3. it restarts the killed replica against the promoted database.
 * Then it asserts:
 *   - every decision a client saw COMMITTED (a 200 deny) is on the new primary, with exactly one audit row;
 *   - no audit row exists for a request the suite never sent;
 *   - the hash chain verifies end to end (`verifyAuditChain`, the offline verifier the product ships).
 *
 * The decision is `POST /v1/authz/check` for a subject id nobody has. The gateway answers `unknown_subject` and writes
 * the audited deny row in the same request, so each acknowledged answer names exactly one audit row, by its random
 * subject id.
 *
 *   pnpm -r build && node deploy/ha-test/failover-suite.mjs                # native backend (Postgres binaries)
 *   node deploy/ha-test/failover-suite.mjs --backend compose               # Docker Compose backend
 *
 * Exit 0 only when every assertion holds. A JSON report is printed and written to --report (default: stdout only).
 */
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startWriterProxy } from "./writer-proxy.mjs";
import { nativeBackend } from "./backends/native.mjs";
import { composeBackend } from "./backends/compose.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const repoRoot = path.resolve(arg("repo", path.join(here, "../..")));
const backendName = arg("backend", "native");
const PER_PHASE = Number(arg("per-phase", "150"));
const CONCURRENCY = Number(arg("concurrency", "8"));
const reportPath = arg("report", null);
const keep = process.argv.includes("--keep");
// NEGATIVE CONTROL ONLY: asynchronous replication. With the standby frozen before the primary dies, commits the
// clients saw are lost, and the suite must FAIL. It proves the suite can see a lost decision (M-002).
const asyncReplication = process.argv.includes("--async");
const FREEZE_MS = Number(arg("freeze-ms", "1500"));

// `pg` is a dependency of @regulait/db, so it is resolved from there
const pg = createRequire(path.join(repoRoot, "packages/db/package.json"))("pg");
const { createDb } = await import(pathToFileURL(path.join(repoRoot, "packages/db/dist/index.js")).href);
const { verifyAuditChain } = await import(pathToFileURL(path.join(repoRoot, "apps/gateway/dist/audit-chain.js")).href);

const DATA_KEY = randomBytes(32).toString("hex"); // generated per run, never reused
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const log = (line) => console.error(`[ha-suite ${new Date().toISOString().slice(11, 23)}] ${line}`);

const backend =
  backendName === "native"
    ? nativeBackend({ repoRoot, asyncReplication, log })
    : backendName === "compose"
      ? composeBackend({ repoRoot, here, asyncReplication, log })
      : (() => {
          throw new Error(`unknown --backend ${backendName} (native or compose)`);
        })();

const BOOT = backend.bootstrapToken ?? `ha-suite-${randomUUID()}`;

const report = {
  backend: backendName,
  replication: asyncReplication ? "async (negative control)" : "sync",
  startedAt: new Date().toISOString(),
  phases: [],
  acked: 0,
  failedRequests: 0,
  rtoMs: { gatewayKill: null, primaryFailover: null },
  checks: {},
  ok: false,
};

async function waitReady(url, ms = 120_000) {
  const until = now() + ms;
  while (now() < until) {
    try {
      const r = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(2_000) });
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`${url} never became ready`);
}

// ---------------------------------------------------------------------------------------------------------------
// traffic: CONCURRENCY workers, round-robin over the live gateways; every acknowledged subject id is recorded
// ---------------------------------------------------------------------------------------------------------------
const acked = new Set();
const sent = new Set();
let live = [];
let serverId = null;
let running = false;
let lastAckAt = 0;
let rr = 0;

async function decideOnce() {
  const gw = live[rr++ % live.length];
  if (!gw) return;
  const subject = randomUUID();
  sent.add(subject);
  try {
    const r = await fetch(`${gw.url}/v1/authz/check`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOOT}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: subject, serverId, toolName: "ha_probe" }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 200 && body.reason === "unknown_subject") {
      acked.add(subject);
      lastAckAt = now();
    } else {
      report.failedRequests++;
    }
  } catch {
    report.failedRequests++;
  }
}

function startTraffic() {
  running = true;
  return Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (running) await decideOnce();
    }),
  );
}

async function untilAcked(n, label, ms = 180_000) {
  const target = acked.size + n;
  const until = now() + ms;
  while (acked.size < target) {
    if (now() > until) throw new Error(`${label}: only ${acked.size}/${target} decisions acknowledged in ${ms} ms`);
    await sleep(50);
  }
  report.phases.push({ phase: label, ackedTotal: acked.size, failedTotal: report.failedRequests });
  log(`${label}: ${acked.size} decisions acknowledged, ${report.failedRequests} requests failed so far`);
}

// ---------------------------------------------------------------------------------------------------------------
let proxy = null;
let traffic = null;
let exitCode = 1;
try {
  log(`backend ${backend.name}: starting Postgres primary + synchronous standby`);
  await backend.up();

  const proxyPort = 15432;
  if (backend.name === "native") {
    proxy = await startWriterProxy({
      listen: { host: "127.0.0.1", port: proxyPort },
      control: { host: "127.0.0.1", port: 15499 },
      target: backend.primary,
    });
  }
  const writerUrl = backend.writerUrl ?? `postgres://regulait@127.0.0.1:${proxyPort}/regulait`;
  const repoint = backend.repointWriter ?? (async (t) => {
    const r = await fetch("http://127.0.0.1:15499/target", { method: "PUT", body: `${t.host}:${t.port}` });
    if (!r.ok) throw new Error(`repoint failed: ${r.status}`);
  });

  const gatewayEnv = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    DATABASE_URL: writerUrl,
    REGULAIT_DATABASE_SSL: "disable",
    REGULAIT_DATA_KEY: DATA_KEY,
    REGULAIT_BOOTSTRAP_TOKEN: BOOT,
    // the suite's login is the cluster superuser; the runtime-login path is covered by its own tests
    REGULAIT_DEV_PRIVILEGED_DB_LOGIN: "1",
    REGULAIT_MIGRATIONS_UNASSIGNED: "apply",
    REGULAIT_INSTALL_SECRETS_DIR: path.join(backend.root ?? here, "install-secrets"),
    REGULAIT_RATE_LIMIT: "off",
    REGULAIT_DRAIN_DELAY_MS: "0",
  };

  // both replicas boot AT ONCE against an empty database: the migration lock makes them take turns
  log("starting gateway replicas a and b together (concurrent boot migrations)");
  const [a, b] = await Promise.all([
    backend.startGateway("gw-a", { port: 13101, env: gatewayEnv }),
    backend.startGateway("gw-b", { port: 13102, env: gatewayEnv }),
  ]);
  await Promise.all([waitReady(a.url, 300_000), waitReady(b.url, 300_000)]);
  live = [a, b];

  // the one tool every decision names (a fixture row, as the gateway tests insert it)
  const setup = new pg.Client({ connectionString: writerUrl });
  await setup.connect();
  const srv = await setup.query("insert into mcp_servers (name, url) values ($1, 'http://127.0.0.1:9/') returning id", [`ha-suite-${randomUUID()}`]);
  serverId = srv.rows[0].id;
  await setup.query("insert into mcp_tools (server_id, name, kind) values ($1, 'ha_probe', 'read')", [serverId]);
  await setup.end();

  traffic = startTraffic();
  await untilAcked(PER_PHASE, "baseline, two replicas");

  // ---- 1. a gateway replica dies ----
  const killAt = now();
  await backend.killGateway("gw-a");
  live = [b];
  const ackedBefore = acked.size;
  while (acked.size === ackedBefore) await sleep(10);
  report.rtoMs.gatewayKill = now() - killAt;
  log(`gw-a killed; first acknowledged decision ${report.rtoMs.gatewayKill} ms later`);
  await untilAcked(PER_PHASE, "after gateway kill, one replica");

  // ---- 2. the database primary dies, mid-traffic ----
  // First the standby is taken down for FREEZE_MS, so it is behind when the primary dies. With synchronous replication
  // no commit can return in that window (the clients wait, then fail), so nothing they saw is lost. With asynchronous
  // replication the clients keep getting answers the standby never receives.
  const resume = await backend.pauseStandby();
  const ackedBeforeFreeze = acked.size;
  await sleep(FREEZE_MS);
  report.ackedWhileStandbyFrozen = acked.size - ackedBeforeFreeze;
  const failAt = now();
  await backend.killPrimary();
  await resume();
  log("primary killed (immediate stop); promoting the standby");
  await backend.promoteStandby();
  await repoint(backend.standby);
  const ackedAtFailover = acked.size;
  while (acked.size === ackedAtFailover) {
    if (now() - failAt > 120_000) throw new Error("no decision was acknowledged within 120 s of the failover");
    await sleep(10);
  }
  report.rtoMs.primaryFailover = now() - failAt;
  log(`failover complete; first acknowledged decision ${report.rtoMs.primaryFailover} ms after the primary died`);
  await untilAcked(PER_PHASE, "after primary failover");

  // ---- 3. the killed replica comes back against the promoted database ----
  const a2 = await backend.startGateway("gw-a", { port: 13101, env: gatewayEnv });
  await waitReady(a2.url, 300_000);
  live = [a2, b];
  await untilAcked(PER_PHASE, "replica restarted, two replicas");

  running = false;
  await traffic;
  traffic = null;

  // ---- assertions, read from the promoted primary ----
  // the suite's clusters have no TLS (loopback or a private compose network), as REGULAIT_DATABASE_SSL says for the gateways
  process.env.REGULAIT_DATABASE_SSL = "disable";
  const db = createDb(writerUrl);
  try {
    const ids = [...acked];
    const r = await db.$client.query(
      "select user_id::text as id, count(*)::int as n from audit_log where rule_id = 'unknown_subject' and server_id = $1 group by user_id",
      [serverId],
    );
    const counts = new Map(r.rows.map((x) => [x.id, x.n]));
    const missing = ids.filter((id) => !counts.has(id));
    const duplicated = [...counts].filter(([, n]) => n !== 1).map(([id]) => id);
    const neverSent = [...counts.keys()].filter((id) => !sent.has(id));
    const unackedButCommitted = [...counts.keys()].filter((id) => sent.has(id) && !acked.has(id)).length;
    const chain = await verifyAuditChain(db, null);
    report.acked = ids.length;
    report.checks = {
      everyAcknowledgedDecisionIsCommitted: { ok: missing.length === 0, missing: missing.slice(0, 20), missingCount: missing.length },
      noDuplicateAuditRows: { ok: duplicated.length === 0, duplicated: duplicated.slice(0, 20) },
      noRowForAnUnsentRequest: { ok: neverSent.length === 0, count: neverSent.length },
      hashChainVerifies: { ok: chain.status === "ok", status: chain.status, rows: chain.scanned.rows, firstBreak: chain.firstBreak },
      // informational: requests that failed at the client but whose transaction had committed (in flight at a kill)
      inFlightCommittedButUnacknowledged: unackedButCommitted,
    };
  } finally {
    await db.$client.end();
  }
  report.ok = Object.values(report.checks).every((c) => typeof c !== "object" || c.ok !== false);
  exitCode = report.ok ? 0 : 1;
} catch (err) {
  report.error = String(err?.stack ?? err);
  log(`FAILED: ${err?.message ?? err}`);
} finally {
  running = false;
  if (traffic) await traffic.catch(() => {});
  await backend.down({ keep }).catch((e) => log(`teardown: ${e.message}`));
  if (proxy) await proxy.close();
  report.finishedAt = new Date().toISOString();
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (reportPath) writeFileSync(reportPath, text);
  log(report.ok ? "PASS" : "FAIL");
  process.exit(exitCode);
}
