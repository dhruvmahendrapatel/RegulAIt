// P30 spike host: runs the vercel/workflow standalone bundle inside a fastify server on Postgres.
// Default off: refuses to start unless REGULAIT_WORKFLOW_DURABLE_P30=1. Throwaway research code;
// no workspace package imports it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import pg from "pg";
import { createWorld } from "@workflow/world-postgres";
import { setWorld } from "workflow/runtime";
import { start, resumeHook, getRun } from "workflow/api";

const here = dirname(fileURLToPath(import.meta.url));
const FLOW_PATH = "/.well-known/workflow/v1/flow";

export function spikeEnabled(env = process.env) {
  const raw = (env.REGULAIT_WORKFLOW_DURABLE_P30 ?? "").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  throw new Error(`REGULAIT_WORKFLOW_DURABLE_P30 must be 1/true/on or 0/false/off, got ${raw}`);
}

export const SPIKE_SCHEMA_SQL = `
create schema if not exists regulait_p30;
create table if not exists regulait_p30.step_decisions (
  id bigserial primary key, step text not null, effect text not null, at timestamptz not null default now());
create table if not exists regulait_p30.transition_audit (
  id bigserial primary key, run_id text, event_type text not null, correlation_id text,
  at timestamptz not null default now());
`;

/** Wraps a World so every event append (the only way state changes) also writes an audit row first. */
export function auditedWorld(world, pool) {
  const create = world.events.create.bind(world.events);
  const createBatch = world.events.createBatch?.bind(world.events);
  const audit = (runId, ev) =>
    pool.query(
      "insert into regulait_p30.transition_audit(run_id, event_type, correlation_id) values ($1,$2,$3)",
      [runId ?? null, ev?.eventType ?? "unknown", ev?.correlationId ?? null],
    );
  const events = Object.create(world.events);
  events.create = async (runId, ev, params) => {
    await audit(runId, ev);
    return create(runId, ev, params);
  };
  if (createBatch) {
    events.createBatch = async (runId, evs, params) => {
      for (const ev of evs) await audit(runId, ev);
      return createBatch(runId, evs, params);
    };
  }
  return new Proxy(world, { get: (t, k) => (k === "events" ? events : Reflect.get(t, k)) });
}

function jsonBody(req) {
  return Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString("utf8")) : req.body;
}

function toRequest(req) {
  const url = `http://${req.headers.host}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : req.body;
  return new Request(url, { method: req.method, headers, body });
}

async function sendResponse(reply, res) {
  reply.code(res.status);
  res.headers.forEach((v, k) => reply.header(k, v));
  return reply.send(Buffer.from(await res.arrayBuffer()));
}

export async function buildSpike({ databaseUrl, port, env = process.env }) {
  if (!spikeEnabled(env)) throw new Error("P30 durable-workflow spike is off (REGULAIT_WORKFLOW_DURABLE_P30)");
  process.env.P30_DATABASE_URL = databaseUrl; // read by the governed step wrapper in the step bundle
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
  pool.on("error", () => {});
  await pool.query(SPIKE_SCHEMA_SQL);
  const base = createWorld({ pool, jobPrefix: "regulait_p30_", queueConcurrency: 10, jobLockStaleSeconds: 30, applicationManagedShutdown: true });
  const world = auditedWorld(base, pool);
  setWorld(world); // pins the World: VERCEL_DEPLOYMENT_ID / WORKFLOW_TARGET_WORLD can no longer redirect it
  const manifest = JSON.parse(readFileSync(join(here, ".well-known/workflow/v1/manifest.json"), "utf8"));
  const workflowId = manifest.workflows["workflows/signoff-stage.ts"].signoffStageWorkflow.workflowId;
  const benchId = manifest.workflows["workflows/bench.ts"].benchWorkflow.workflowId;
  const flow = await import(join(here, ".well-known/workflow/v1/flow.mjs"));

  const app = Fastify({ bodyLimit: 4 * 1024 * 1024 });
  app.removeAllContentTypeParsers(); // the flow route needs the raw body bytes
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_r, body, done) => done(null, body));
  // The World delivers over unauthenticated loopback HTTP; refuse anything that is not loopback.
  app.all(FLOW_PATH, async (req, reply) => {
    const ra = req.socket.remoteAddress ?? "";
    if (!(ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1")) return reply.code(403).send();
    const res = await flow[req.method]?.(toRequest(req));
    return res ? sendResponse(reply, res) : reply.code(405).send();
  });
  // Product routes (spike auth stub: x-p30-actor). The gateway would run its real auth hooks here.
  app.post("/v1/p30/instances", async (req, reply) => {
    const actor = req.headers["x-p30-actor"];
    if (typeof actor !== "string" || actor === "") return reply.code(401).send();
    const body = jsonBody(req);
    const run = await start({ workflowId }, [{ instanceId: body.instanceId, actorId: actor, request: body.request }]);
    return { runId: run.runId };
  });
  app.post("/v1/p30/instances/:id/signoff", async (req, reply) => {
    const actor = req.headers["x-p30-actor"];
    if (typeof actor !== "string" || actor === "") return reply.code(401).send();
    const body = jsonBody(req);
    await resumeHook(`signoff:${req.params.id}`, { decision: body.decision, approverId: actor });
    return { ok: true };
  });
  app.get("/v1/p30/runs/:runId", async (req) => {
    const run = getRun(req.params.runId);
    return { status: await run.status };
  });
  await app.listen({ host: "127.0.0.1", port });
  process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${app.server.address().port}`;
  await base.start();
  return {
    app, pool, world, getRun,
    startBench: (n) => start({ workflowId: benchId }, [n]),
    async close() {
      await base.close();
      await app.close();
      const gov = globalThis[Symbol.for("regulait.p30.governancePool")];
      if (gov) {
        delete globalThis[Symbol.for("regulait.p30.governancePool")];
        await gov.end();
      }
      await pool.end();
    },
  };
}
