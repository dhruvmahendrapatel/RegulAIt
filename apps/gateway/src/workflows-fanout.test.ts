/**
 * ADR-0285 / ADR-0286 (P30, lane L5) — in-stage fan-out of named checks, and the concurrency limits.
 *
 *  - `fanOut` keeps the order of its input, never runs more than the caller's width, and never more than the
 *    process-wide limit across callers;
 *  - the limits are bounded and fall back to their defaults on a malformed value;
 *  - an automated_check stage's eval-bound checks run at once (up to `checkConcurrency`), and the verdicts still commit
 *    as ONE transition in declared order. The eval runner is a delayed fake that counts how many run at once.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, eq, runMigrations, workflowEvents, workflowInstances, type Db } from "@regulait/db";

const probe = vi.hoisted(() => {
  let inFlight = 0;
  let max = 0;
  return {
    reset() {
      inFlight = 0;
      max = 0;
    },
    get max() {
      return max;
    },
    async run<T>(fn: () => T, ms: number): Promise<T> {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return fn();
    },
  };
});

vi.mock("./evals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./evals.js")>();
  const runEvalSuite = (async (_db: unknown, _key: unknown, input: { workflow?: { checkName: string } }) =>
    probe.run(
      () => ({
        ok: true,
        run: { id: `run-${input.workflow?.checkName}`, costUsd: 0 },
        aggregate: { meanScore: 1, passRate: 1, cases: 1 },
        gate: { passed: true, regression: false, reason: "fake pass", scoreDelta: 0 },
        baseline: null,
      }),
      // a later-declared check finishes FIRST, so declared order cannot be finish order
      input.workflow?.checkName === "e1" ? 120 : 40,
    )) as unknown as typeof actual.runEvalSuite;
  return { ...actual, runEvalSuite };
});

import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import {
  CHECK_CONCURRENCY_ENV,
  CHECK_PROCESS_CONCURRENCY_ENV,
  RETRY_PROJECT_CONCURRENCY_ENV,
  concurrencyLimit,
  fanOut,
  stageCheckConcurrency,
  stageRetryGroup,
} from "./workflows-queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("fanOut — bounded, ordered (ADR-0285 / ADR-0286)", () => {
  const prior = process.env[CHECK_PROCESS_CONCURRENCY_ENV];
  afterEach(() => {
    if (prior === undefined) delete process.env[CHECK_PROCESS_CONCURRENCY_ENV];
    else process.env[CHECK_PROCESS_CONCURRENCY_ENV] = prior;
  });

  async function measure(width: number, n: number, callers = 1) {
    let inFlight = 0;
    let max = 0;
    const work = (caller: number) =>
      fanOut([...Array(n).keys()], width, async (i) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await sleep(n - i); // later items finish first
        inFlight--;
        return `${caller}:${i}`;
      });
    const out = await Promise.all([...Array(callers).keys()].map(work));
    return { out, max };
  }

  it("returns results in the order of the input, whatever order they finish in", async () => {
    const { out } = await measure(4, 6);
    expect(out[0]).toEqual(["0:0", "0:1", "0:2", "0:3", "0:4", "0:5"]);
  });

  it("never runs more than the caller's width", async () => {
    expect((await measure(1, 5)).max).toBe(1);
    expect((await measure(3, 8)).max).toBe(3);
  });

  it("never runs more than the process-wide limit across callers", async () => {
    process.env[CHECK_PROCESS_CONCURRENCY_ENV] = "3";
    const { max } = await measure(4, 6, 3);
    expect(max).toBe(3);
  });

  it("an empty input is an empty result", async () => {
    expect(await fanOut([], 4, async () => 1)).toEqual([]);
  });
});

describe("concurrency limits are bounded with defaults (ADR-0286)", () => {
  it.each([
    [undefined, 4],
    ["2", 2],
    ["16", 16],
    ["0", 4],
    ["17", 4],
    ["2.5", 4],
    ["lots", 4],
  ])("%s → %d", (raw, want) => {
    const env = raw === undefined ? {} : { [CHECK_CONCURRENCY_ENV]: raw };
    expect(concurrencyLimit(CHECK_CONCURRENCY_ENV, env as NodeJS.ProcessEnv)).toBe(want);
  });

  it("a stage's own checkConcurrency wins over the deployment default", () => {
    expect(stageCheckConcurrency({ checkConcurrency: 2 }, {} as NodeJS.ProcessEnv)).toBe(2);
    expect(stageCheckConcurrency({}, { [CHECK_CONCURRENCY_ENV]: "6" } as NodeJS.ProcessEnv)).toBe(6);
  });

  it("the per-project retry limit defaults to one at a time, and a job's group is its project", () => {
    expect(concurrencyLimit(RETRY_PROJECT_CONCURRENCY_ENV, {} as NodeJS.ProcessEnv)).toBe(1);
    expect(stageRetryGroup("p-1")).toEqual({ id: "p-1" });
    expect(stageRetryGroup(null)).toEqual({ id: "no-project" });
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const BOOT = "l5-fanout-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
let db: Db;
let app: ReturnType<typeof buildApp>;
let initiator: { authorization: string };
let restoreIdentity: (() => Promise<void>) | undefined;
let restoreGates: (() => Promise<void>) | undefined;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  const user = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: "l5-fan@example.com", displayName: "Fan" } });
  const key = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${user.json().id}/keys`, payload: { name: "t" } });
  initiator = { authorization: `Bearer ${key.json().token}` };
  const ds = await app.inject({ method: "POST", headers: AUTH, url: "/v1/evals/datasets", payload: { name: "l5-fan-ds", scorerKind: "contains", scorerConfig: {} } });
  expect(ds.statusCode).toBe(201);
  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name: "l5-fan-agent", provider: "mock", tier: 0, modes: ["execute"], costPerMTokIn: 1, costPerMTokOut: 1, model: "mock-fan" },
  });
  expect(agent.statusCode).toBe(201);
});

afterAll(async () => {
  await restoreGates?.();
  await restoreIdentity?.();
  await app.close();
});

async function runCheckStage(name: string, checkConcurrency: number) {
  const checks = ["e1", "e2", "e3", "e4"];
  const tpl = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: {
      name,
      definition: {
        workflow: name,
        stages: [
          { id: "intake", type: "trigger" },
          {
            id: "quality",
            type: "automated_check",
            checks,
            checkConcurrency,
            evals: checks.map((check) => ({ check, dataset: "l5-fan-ds", agent: "l5-fan-agent" })),
          },
        ],
      },
    },
  });
  expect(tpl.statusCode).toBe(201);
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules", payload: { templateId: tpl.json().id, changeType: name } });
  probe.reset();
  const started = await app.inject({
    method: "POST",
    headers: initiator,
    url: "/v1/workflows/instances",
    payload: { change: { description: "fan-out change", paths: ["src/x.ts"], changeType: name, environment: "staging" } },
  });
  expect(started.statusCode).toBe(201);
  const id = started.json().id as string;
  const [row] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, id));
  const events = await db.select().from(workflowEvents).where(eq(workflowEvents.instanceId, id));
  return { row: row!, events, max: probe.max };
}

describe("ADR-0285: an automated_check stage's named checks fan out and commit as one transition", () => {
  it("runs up to checkConcurrency eval checks at once; the verdicts are in declared order and commit once", async () => {
    const { row, events, max } = await runCheckStage("l5-fan-wide", 4);
    expect(max).toBe(4);
    expect(row.status).toBe("completed");
    const results = (row.context as Record<string, unknown>)["checks:quality"] as Array<{ check: string; status: string }>;
    expect(results.map((r) => r.check)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(results.every((r) => r.status === "passed")).toBe(true);
    // ONE transition for the whole stage
    expect(events.filter((e) => (e.event as { kind: string }).kind === "execution_succeeded")).toHaveLength(1);
  });

  it("checkConcurrency 1 runs them one after another, as before P30", async () => {
    const { row, max } = await runCheckStage("l5-fan-serial", 1);
    expect(max).toBe(1);
    expect(row.status).toBe("completed");
  });
});
