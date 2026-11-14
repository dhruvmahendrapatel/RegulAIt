// P30 spike suite. Needs a Postgres role allowed to create databases; P30_ADMIN_URL points at it.
// Each run creates and drops its own scratch database. See README.md.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import dns from "node:dns";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { getHookByToken } from "workflow/api";
import { buildSpike, spikeEnabled } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN = process.env.P30_ADMIN_URL;
assert.ok(ADMIN, "set P30_ADMIN_URL");
const dbName = `regulait_p30_${process.pid}_${Date.now()}`;
const dbUrl = (() => {
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  return u.toString();
})();
const ON = { REGULAIT_WORKFLOW_DURABLE_P30: "1" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Egress recorder: every TCP connect and DNS lookup the process makes is recorded.
const egress = [];
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = typeof args[0] === "object" && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
  egress.push(o.path ? `unix:${o.path}` : `${o.host ?? "localhost"}:${o.port}`);
  return origConnect.apply(this, args);
};
const origLookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  egress.push(`dns:${host}`);
  return origLookup.call(this, host, ...rest);
};
const LOCAL = /^(unix:|127\.0\.0\.1:|::1:|localhost:|dns:localhost$|dns:127\.0\.0\.1$)/;

let spike;
async function admin(sql) {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}
async function http(path, { method = "GET", actor, body } = {}) {
  const res = await fetch(process.env.WORKFLOW_LOCAL_BASE_URL + path, {
    method,
    headers: { "content-type": "application/json", ...(actor ? { "x-p30-actor": actor } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function waitForHook(token, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await getHookByToken(token);
    } catch (e) {
      if (Date.now() > end) throw e;
      await wait(100);
    }
  }
}

before(async () => {
  await admin(`create database ${dbName}`);
  // the World's own migrations, run by its bundled migrator into schemas workflow / workflow_drizzle / graphile_worker
  execFileSync(process.execPath, [join(here, "node_modules/@workflow/world-postgres/bin/setup.js")], {
    env: { ...process.env, WORKFLOW_POSTGRES_URL: dbUrl, DATABASE_URL: "" },
    stdio: "ignore",
  });
  spike = await buildSpike({ databaseUrl: dbUrl, port: 0, env: ON });
});

after(async () => {
  await spike?.close();
  await admin(`drop database if exists ${dbName} with (force)`);
});

test("the switch is off by default and strict about its value", async () => {
  assert.equal(spikeEnabled({}), false);
  assert.equal(spikeEnabled({ REGULAIT_WORKFLOW_DURABLE_P30: "0" }), false);
  assert.equal(spikeEnabled(ON), true);
  assert.throws(() => spikeEnabled({ REGULAIT_WORKFLOW_DURABLE_P30: "yes please" }));
  await assert.rejects(buildSpike({ databaseUrl: dbUrl, port: 0, env: {} }), /is off/);
});

test("the World's tables live in schemas it hard-codes", async () => {
  const { rows } = await spike.pool.query(
    "select table_schema, count(*)::int n from information_schema.tables where table_schema in ('workflow','workflow_drizzle','graphile_worker') group by 1 order by 1",
  );
  assert.deepEqual(rows.map((r) => r.table_schema), ["graphile_worker", "workflow", "workflow_drizzle"]);
  const rls = await spike.pool.query(
    "select count(*)::int n from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='workflow' and c.relkind='r' and c.relrowsecurity",
  );
  assert.equal(rls.rows[0].n, 0, "no RLS on the World's tables");
});

test("flow route refuses non-loopback callers", async () => {
  const res = await spike.app.inject({ method: "POST", url: "/.well-known/workflow/v1/flow", remoteAddress: "10.0.0.5", payload: "{}" });
  assert.equal(res.statusCode, 403);
});

test("sign-off stage: durable steps, pause on hook, resume after a restart, fan-out checks", async () => {
  const id = `inst-${Date.now()}`;
  const started = await http("/v1/p30/instances", { method: "POST", actor: "alice", body: { instanceId: id, request: "add audit export" } });
  assert.equal(started.status, 200);
  const { runId } = started.json;
  await waitForHook(`signoff:${id}`);
  assert.equal((await http(`/v1/p30/runs/${runId}`)).json.status, "running");

  // restart the whole host while the run is parked on the sign-off
  await spike.close();
  spike = await buildSpike({ databaseUrl: dbUrl, port: 0, env: ON });

  const signed = await http(`/v1/p30/instances/${id}/signoff`, { method: "POST", actor: "bob", body: { decision: "approve" } });
  assert.equal(signed.status, 200);
  const result = await spike.getRun(runId).returnValue;
  assert.equal(result.status, "completed"); // kernel state after checks stage
  assert.equal(result.approver, "bob");
  assert.deepEqual(result.checks.map((c) => c.name), ["ci", "code_review", "security_scan"]);

  // every event append was audited (state changes only happen through events.create)
  const audit = await spike.pool.query("select event_type, count(*)::int n from regulait_p30.transition_audit where run_id=$1 group by 1", [runId]);
  const byType = Object.fromEntries(audit.rows.map((r) => [r.event_type, r.n]));
  for (const t of ["run_started", "step_started", "step_completed", "hook_created", "hook_received", "run_completed"]) {
    assert.ok(byType[t] > 0, `audited ${t}`);
  }
  // every stored event type was audited at least as often as stored, except the World's synthetic
  // step_created, which it writes itself inside a step_started append (lazy step start).
  const stored = await spike.pool.query(
    "select type, count(*)::int n from workflow.workflow_events where run_id=$1 group by 1 order by 1", [runId]);
  console.log("P30 audit: stored", JSON.stringify(stored.rows), "audited", JSON.stringify(audit.rows));
  for (const { type, n } of stored.rows) {
    if (type === "step_created") assert.equal(n, byType.step_started, "one synthetic step_created per audited step_started");
    else assert.ok((byType[type] ?? 0) >= n, `audited ${type}`);
  }

  // fan-out: the three 300 ms check steps overlapped (every one started before any finished)
  const t = await spike.pool.query(
    `select max(started_at) last_start, min(completed_at) first_done from workflow.workflow_steps
      where run_id=$1 and step_name like '%runCheck'`, [runId]);
  assert.ok(t.rows[0].last_start < t.rows[0].first_done, JSON.stringify(t.rows[0]));
});

test("governance can refuse a step: the run fails and a deny decision is recorded", async () => {
  process.env.P30_DENY_STEPS = "check.security_scan";
  try {
    const id = `deny-${Date.now()}`;
    const { json } = await http("/v1/p30/instances", { method: "POST", actor: "alice", body: { instanceId: id, request: "x" } });
    await waitForHook(`signoff:${id}`);
    await http(`/v1/p30/instances/${id}/signoff`, { method: "POST", actor: "bob", body: { decision: "approve" } });
    await assert.rejects(spike.getRun(json.runId).returnValue, /denied/);
    const d = await spike.pool.query("select count(*)::int n from regulait_p30.step_decisions where step='check.security_scan' and effect='deny'");
    assert.ok(d.rows[0].n > 0);
  } finally {
    delete process.env.P30_DENY_STEPS;
  }
});

test("overhead per durable step (printed; recorded in ADR-0254)", async () => {
  const N = Number(process.env.P30_BENCH_STEPS ?? 50);
  const warm = await spike.startBench(2);
  await warm.returnValue;
  const t0 = performance.now();
  const run = await spike.startBench(N);
  assert.equal(await run.returnValue, (N * (N - 1)) / 2);
  const engineMs = (performance.now() - t0) / N;
  // baseline: the existing runner's per-transition write shape (lock + event row + audit row in one tx)
  await spike.pool.query("create table if not exists regulait_p30.base_inst(id int primary key, v int); insert into regulait_p30.base_inst values (1,0) on conflict do nothing; create table if not exists regulait_p30.base_ev(id bigserial primary key, k text, at timestamptz default now());");
  const b0 = performance.now();
  for (let i = 0; i < N; i++) {
    const c = await spike.pool.connect();
    try {
      await c.query("begin");
      await c.query("select v from regulait_p30.base_inst where id=1 for update");
      await c.query("update regulait_p30.base_inst set v=v+1 where id=1");
      await c.query("insert into regulait_p30.base_ev(k) values ('event'),('audit')");
      await c.query("commit");
    } finally {
      c.release();
    }
  }
  const baseMs = (performance.now() - b0) / N;
  const rows = await spike.pool.query("select count(*)::int n from workflow.workflow_events where run_id=$1", [run.runId]);
  console.log(`P30 overhead: ${N} steps, ${engineMs.toFixed(2)} ms/step on vercel/workflow (${rows.rows[0].n} events), ${baseMs.toFixed(2)} ms/transition baseline`);
});

test("egress: every connection and lookup the process made was local", () => {
  const remote = [...new Set(egress)].filter((e) => !LOCAL.test(e));
  assert.deepEqual(remote, [], `non-local egress: ${remote.join(", ")}`);
  assert.ok(egress.length > 0, "recorder saw traffic");
});
