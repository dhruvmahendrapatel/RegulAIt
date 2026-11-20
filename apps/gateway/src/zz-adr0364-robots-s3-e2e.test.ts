/**
 * ADR-0364 S3 (lane E45) — ONE ROBOT RUN END TO END, on a real (scratch) database through the real app, driven by the
 * REAL executor package with its FAKE backend (the CI runners have no gVisor). The fake's `robotTask` stands in for the
 * sandbox's robot runner and speaks exactly what `packages/robot-runner/src/run.ts` speaks: `http` stdout frames to
 * the gateway channel (plan, heartbeat, evidence chunks, result), `http_res` stdin answers, then `{t:"end"}`.
 *
 *  - SUCCEEDED: the author's test run (the HTTP route) is placed by decision 7 on an executor whose backend attests
 *    gVisor; the runner reads the plan, opens its sealed secret with the run key the release carried, heartbeats,
 *    uploads one screenshot in two chunks and posts its result. The run row is `succeeded`, names its placement and
 *    binds the digest a submit would bind (so submit moves past `robot_test_run_required`). The executor built the
 *    run's egress (portal.example.com:443 only, an `enforce` ACL) and handed the sandbox the proxy URL; the
 *    executor's end carried the Smokescreen log, stored as the run's `egress_log` evidence.
 *  - CANARY: the test secret value is in no frame either way (only sealed), no audit row and no evidence row.
 *  - HALTED: the deployment is halted after the first heartbeat; the next heartbeat answers {cancel:true}; the runner
 *    posts `cancelled`/`halted`; the run ends `cancelled` with failure_code `halted`.
 *  - NO ROBOT-CAPABLE EXECUTOR: an executor that attests only hardened_container (runc) is never used; the run is
 *    refused `robot_run_placement_refused` and its row ends `refused`.
 *
 * Global state (M-068): the run owns its scratch database (dropped in afterAll); the runner image seam and the
 * execution mode are reset.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aiUseCases,
  auditLog,
  createDb,
  eq,
  executionPlacements,
  orgSettings,
  projects,
  robotRunEvidence,
  robotRuns,
  robotVersions,
  robots,
  runMigrations,
  sql,
  usageEvents,
  type Db,
} from "@regulait/db";
import {
  ExecutorClient,
  generateExecutorKey,
  ProofChannelCredential,
  runExecutorLoop,
  type ExecutorHttp,
  type ExecutorKey,
} from "@regulait/sandbox-executor";
import {
  FakeSandboxBackend,
  type FakeEgressRecord,
} from "@regulait/sandbox-executor/testing";
import { openRobotSecret, robotRunPlanSchema } from "@regulait/shared";
import { buildApp } from "./app.js";
import { artifactStorageKey, FileArtifactStore } from "./model-artifacts.js";
import { deploymentEnvironment } from "./oauth/common.js";
import { setRobotRunnerImageForTest, startRobotRun } from "./robot-runs.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `rbt3e-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ISSUER = "http://127.0.0.1:4420";
const DATA_KEY = "a".repeat(64);
const IMAGE = `sha256:${"5".repeat(64)}`;
const SITE = "https://portal.example.com";
const CANARY = "canary-E2E-Secret-9c1d";
const LIVE_VALUE = "live-E2E-Secret-4b7e";
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(300, 9),
]);
const JPEG_SHA = createHash("sha256").update(JPEG).digest("hex");

const draft = {
  source: "recorded",
  scriptFormat: "steps_v1",
  script: JSON.stringify({
    steps: [
      { op: "goto", url: `${SITE}/login` },
      { op: "fill", selector: "#user", input: "username" },
      { op: "fill", selector: "#pass", secret: "PORTAL_PASSWORD" },
      { op: "read", selector: "#balance", output: "balance" },
    ],
  }),
  inputSchema: {
    type: "object",
    properties: { username: { type: "string" } },
    required: ["username"],
    additionalProperties: false,
  },
  outputSchema: { type: "object", properties: { balance: { type: "string" } } },
  allowedSites: [SITE],
  secretBindings: [{ name: "PORTAL_PASSWORD", origin: SITE }],
};

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;

let scratchAdmin: Db | null = null;
let scratchName = "";
let db: Db;
let app: ReturnType<typeof buildApp>;
let storeDir = "";
let adminId = "";
let adminAuth = { authorization: "" };
let ownerId = "";
let ownerAuth = { authorization: "" };
let projectId = "";
let robotId = "";
const restores: Array<() => Promise<void>> = [];

const inject = (
  method: Method,
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const setMode = (mode: "normal" | "halted") =>
  db
    .update(orgSettings)
    .set({
      executionMode: mode,
      executionModeReason: mode === "normal" ? null : "ADR-0364 S3 e2e test",
    });

// --- the executor, over app.inject (the I4 pattern) --------------------------------------------------------------

function injectHttp(): ExecutorHttp {
  return async (url, init) => {
    const u = new URL(url);
    const res = await app.inject({
      method: init.method as Method,
      url: `${u.pathname}${u.search}`,
      headers: init.headers,
      ...(init.body !== undefined ? { payload: init.body } : {}),
    });
    return { status: res.statusCode, text: async () => res.body };
  };
}

async function newIdentity(
  name: string,
): Promise<{ id: string; identifier: string; key: ExecutorKey }> {
  const identifier = `spiffe://rbt3e.example.org/regulait/worker_runtime/${name}-${RUN}`;
  const id = rows<{ id: string }>(
    await db.execute(
      sql`insert into workload_identities (kind, identifier, sponsor_user_ids, environments) values ('worker_runtime', ${identifier}, ARRAY[${adminId}]::uuid[], ARRAY[${deploymentEnvironment()}]) returning id`,
    ),
  )[0]!.id;
  const key = await generateExecutorKey();
  await db.execute(sql`insert into workload_credentials (identity_id, kind, public_jwk, jwk_thumbprint, not_after)
    values (${id}, 'jwk', ${JSON.stringify(key.publicJwk)}::jsonb, ${key.thumbprint}, now() + interval '30 days')`);
  return { id, identifier, key };
}

async function rig(name: string, backend: FakeSandboxBackend) {
  const ident = await newIdentity(name);
  const d = backend.describe();
  const reg = await inject("POST", "/v1/executors", adminAuth, {
    workloadIdentityId: ident.id,
    name: `rbt3e-${RUN}-${name}`,
    backend: d.backend,
    runtimeVersion: d.runtimeVersion,
    classesDeclared: [...d.classes],
  });
  expect(reg.statusCode, reg.body).toBe(201);
  const credential = new ProofChannelCredential({
    identifier: ident.identifier,
    key: ident.key,
    issuer: ISSUER,
  });
  const client = new ExecutorClient({
    gatewayUrl: ISSUER,
    credential,
    http: injectHttp(),
  });
  const logs: string[] = [];
  const loop = (o: { maxWindows?: number; signal?: AbortSignal }) =>
    runExecutorLoop({
      client,
      backend,
      credential,
      streamWindowSeconds: 1,
      stdioWindowSeconds: 1,
      backoffMs: 5,
      maxBackoffMs: 10,
      log: (m) => logs.push(m),
      ...o,
    });
  return { executorId: reg.json().executorId as string, backend, loop, logs };
}

// --- the robot runner stand-in: run.ts's order of requests, frame for frame --------------------------------------

interface RunnerTrace {
  out: string[];
  in: string[];
  secretOpened: string | null;
  runKey: string | undefined;
  workload: { command: string; args: string[] } | null;
  egress: FakeEgressRecord | null;
  heartbeats: Array<{ cancel: boolean }>;
  planStatus: number | null;
  resultStatus: number | null;
  screenshots: string | null;
  evidenceStatus: number | null;
  /** called once, after the first heartbeat's answer (the abort scenario aborts the call here) */
  onFirstHeartbeat?: () => void;
}
const newTrace = (): RunnerTrace => ({
  out: [],
  in: [],
  secretOpened: null,
  runKey: undefined,
  workload: null,
  egress: null,
  heartbeats: [],
  planStatus: null,
  resultStatus: null,
  screenshots: null,
  evidenceStatus: null,
});

function robotRunner(trace: RunnerTrace, scenario: "succeed" | "halt" | "loop" | "download") {
  return async (ctx: {
    secret: string | undefined;
    workload: { command: string; args: string[] };
    stdin: AsyncIterable<string>;
    write: (line: string) => void;
    egress: FakeEgressRecord;
  }) => {
    trace.runKey = ctx.secret;
    trace.workload = ctx.workload;
    trace.egress = ctx.egress;
    const write = (frame: unknown) => {
      const line = JSON.stringify(frame);
      trace.out.push(line);
      ctx.write(line);
    };
    // the gateway channel: one `http` frame per request, answered by an `http_res` stdin frame with the same id
    const waiting = new Map<
      string,
      (r: { status: number; body: unknown }) => void
    >();
    void (async () => {
      for await (const line of ctx.stdin) {
        trace.in.push(line);
        const f = JSON.parse(line) as {
          t: string;
          id: string;
          status: number;
          body: string;
        };
        if (f.t !== "http_res") continue;
        const text = Buffer.from(f.body, "base64").toString("utf8");
        waiting.get(f.id)?.({
          status: f.status,
          body: text === "" ? null : JSON.parse(text),
        });
        waiting.delete(f.id);
      }
    })();
    let n = 0;
    const call = (method: "GET" | "POST", route: string, body?: unknown) =>
      new Promise<{ status: number; body: unknown }>((resolve) => {
        const id = String(++n);
        waiting.set(id, resolve);
        write({
          t: "http",
          id,
          method,
          path: `/v1/robot-runner/runs/${ctx.egress.runId}/${route}`,
          headers:
            method === "POST"
              ? {
                  "content-type": "application/json",
                  accept: "application/json",
                }
              : { accept: "application/json" },
          body: Buffer.from(
            body === undefined ? "" : JSON.stringify(body),
          ).toString("base64"),
        });
      });

    const planRes = await call("GET", "plan");
    trace.planStatus = planRes.status;
    const plan = robotRunPlanSchema.parse(planRes.body);
    trace.screenshots = plan.screenshots;
    const s = plan.secrets.find((x) => x.ref === "PORTAL_PASSWORD")!;
    trace.secretOpened = openRobotSecret(
      ctx.secret!,
      plan.runId,
      s.ref,
      s.sealed,
    );

    const hb1 = (await call("POST", "heartbeat", { step: 0 })).body as {
      cancel: boolean;
    };
    trace.heartbeats.push(hb1);
    trace.onFirstHeartbeat?.();
    if (scenario === "loop") {
      // as run.ts between steps: heartbeat until the gateway answers {cancel}, then report cancelled
      for (let i = 0; i < 400; i++) {
        const hb = (await call("POST", "heartbeat", { step: 1 })).body as { cancel: boolean };
        trace.heartbeats.push(hb);
        if (hb.cancel) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const res = await call("POST", "result", { status: "cancelled", failureCode: "halted", stepsCompleted: 1, outputs: {} });
      trace.resultStatus = res.status;
      write({ t: "end", code: 0 });
      return;
    }
    if (scenario === "download") {
      const bytes = Buffer.from("downloaded-statement-bytes-0001");
      const r = await call("POST", "evidence", {
        item: 0,
        kind: "download",
        step: 3,
        contentType: "application/octet-stream",
        chunk: 0,
        dataBase64: bytes.toString("base64"),
        last: true,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      trace.evidenceStatus = r.status;
      const res = await call("POST", "result", { status: "succeeded", stepsCompleted: plan.steps.length, outputs: { balance: "7" } });
      trace.resultStatus = res.status;
      write({ t: "end", code: 0 });
      return;
    }
    if (scenario === "halt") {
      await setMode("halted");
      const hb2 = (await call("POST", "heartbeat", { step: 1 })).body as {
        cancel: boolean;
      };
      trace.heartbeats.push(hb2);
      if (hb2.cancel)
        await call("POST", "result", {
          status: "cancelled",
          failureCode: "halted",
          stepsCompleted: 1,
          outputs: {},
        });
      write({ t: "end", code: 0 });
      return;
    }
    // one screenshot, in two chunks (the last names its size and sha256)
    const half = Math.ceil(JPEG.length / 2);
    const parts = [JPEG.subarray(0, half), JPEG.subarray(half)];
    for (let c = 0; c < parts.length; c++) {
      const last = c === parts.length - 1;
      const r = await call("POST", "evidence", {
        item: 0,
        kind: "screenshot",
        step: 1,
        contentType: "image/jpeg",
        chunk: c,
        dataBase64: parts[c]!.toString("base64"),
        last,
        ...(last ? { size: JPEG.length, sha256: JPEG_SHA } : {}),
      });
      expect(r.status).toBe(200);
    }
    // as run.ts: the result, then the `end` frame (a result whose answer never comes is bounded, as the runner's is)
    const res = await Promise.race([
      call("POST", "result", {
        status: "succeeded",
        stepsCompleted: plan.steps.length,
        outputs: { balance: "42" },
      }),
      new Promise<null>((r) => setTimeout(() => r(null), 3_000)),
    ]);
    trace.resultStatus = res?.status ?? null;
    write({ t: "end", code: res?.status === 200 ? 0 : 1 });
  };
}

const testRun = (inputs: Record<string, unknown> = { username: "alice" }) =>
  inject("POST", `/v1/robots/${robotId}/versions/1/test-runs`, ownerAuth, {
    projectId,
    inputs,
  });
const placementSandboxes = (b: FakeSandboxBackend) =>
  b.sandboxes.filter((s) => s.kind === "placement");

describe.skipIf(!DATABASE_URL)(
  "ADR-0364 S3 robot run end to end (real executor, fake backend)",
  () => {
    beforeAll(async () => {
      process.env.REGULAIT_PUBLIC_URL = ISSUER;
      scratchName = `rbt3e_${process.pid}_${RUN}`;
      scratchAdmin = createDb(DATABASE_URL!);
      await scratchAdmin.execute(
        sql.raw(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`),
      );
      await scratchAdmin.execute(sql.raw(`CREATE DATABASE ${scratchName}`));
      const u = new URL(DATABASE_URL!);
      u.pathname = "/" + scratchName;
      db = createDb(u.toString());
      await runMigrations(db, migrationsFolder);
      restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
      restores.push(await relaxStepUpForTest(db));
      restores.push(await relaxStrictAdmissionForTest(db));
      restores.push(
        await relaxGovernanceGatesForTest(db, {
          mrmEnforced: false,
          dispatchAttributionRequired: false,
        }),
      );
      storeDir = await mkdtemp(path.join(tmpdir(), "rbt3e-store-"));
      app = buildApp(db, {
        bootstrapToken: BOOT,
        dataKey: DATA_KEY,
        artifactStore: new FileArtifactStore(storeDir),
        executorChannel: { streamPollMs: 25, keepaliveMs: 200 },
      });
      await app.ready();

      const adm = await inject("POST", "/v1/users", AUTH, {
        email: `rbt3e-admin-${RUN}@example.com`,
        displayName: `admin ${RUN}`,
        isAdmin: true,
      });
      expect(adm.statusCode, adm.body).toBe(201);
      adminId = adm.json().id;
      adminAuth = {
        authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, AUTH, { name: "k" })).json().token}`,
      };
      const own = await inject("POST", "/v1/users", AUTH, {
        email: `rbt3e-owner-${RUN}@example.com`,
        displayName: `owner ${RUN}`,
      });
      expect(own.statusCode, own.body).toBe(201);
      ownerId = own.json().id;
      ownerAuth = {
        authorization: `Bearer ${(await inject("POST", `/v1/users/${ownerId}/keys`, AUTH, { name: "k" })).json().token}`,
      };
      const p = await inject("POST", "/v1/projects", AUTH, {
        name: `rbt3e-p-${RUN}`,
      });
      expect(p.statusCode, p.body).toBeLessThan(300);
      projectId = p.json().id;
      expect(
        (
          await inject("POST", `/v1/projects/${projectId}/members`, AUTH, {
            userId: ownerId,
            role: "contributor",
          })
        ).statusCode,
      ).toBeLessThan(300);
      await db
        .update(projects)
        .set({ budgetUsd: 50 })
        .where(eq(projects.id, projectId));
      // decision 7 reads the project's sensitivity from its AI use cases
      await db
        .insert(aiUseCases)
        .values({
          name: `rbt3e-uc-${RUN}`,
          description: "d",
          ownerUserId: adminId,
          businessContext: "b",
          dataSensitivity: "internal",
          projectId,
        });

      const r = await inject("POST", "/v1/robots", ownerAuth, {
        slug: `portal_${RUN}`,
        name: "Portal balance",
      });
      expect(r.statusCode, r.body).toBe(201);
      robotId = r.json().robot.id;
      const v = await inject(
        "POST",
        `/v1/robots/${robotId}/versions`,
        ownerAuth,
        draft,
      );
      expect(v.statusCode, v.body).toBe(201);
      for (const [scope, value] of [
        ["test", CANARY],
        ["live", LIVE_VALUE],
      ] as const) {
        const g = await grantStepUpForTest(db, ownerId, {
          kind: "settings_relax",
          facts: {
            op: "robot_secret_set",
            robotId,
            name: "PORTAL_PASSWORD",
            scope,
          },
        });
        const req = stepUpRequest(g);
        const s = await app.inject({
          method: "PUT",
          url: `/v1/robots/${robotId}/secrets/PORTAL_PASSWORD/${scope}`,
          headers: req.headers,
          cookies: req.cookies,
          payload: { value },
        });
        expect(s.statusCode, s.body).toBe(200);
      }
      setRobotRunnerImageForTest(IMAGE);
      // B2: the org PII floor ships `block` (no screenshots, downloads by digest only); the first runs use `warn`
      await db.update(orgSettings).set({ defaultPiiMode: "warn" });
    }, 180_000);

    afterAll(async () => {
      setRobotRunnerImageForTest(undefined);
      if (db) await setMode("normal").catch(() => undefined);
      for (const r of restores.reverse()) await r().catch(() => undefined);
      if (app) {
        app.server.closeAllConnections();
        await app.close();
      }
      if (storeDir) await rm(storeDir, { recursive: true, force: true });
      if (scratchAdmin) {
        const admin = scratchAdmin;
        await closeAll([
          async () => db?.$client.end(),
          async () => dropScratchDatabase(admin, scratchName),
          async () => admin.$client.end(),
        ]);
      }
    });

    const trace = newTrace();
    let runId = "";

    it("a test run is placed on a gVisor executor, runs the runner's requests over the stdio bridge and succeeds", async () => {
      const ex = await rig(
        "gvisor",
        new FakeSandboxBackend({
          backend: "gvisor",
          classes: ["hardened_container", "user_space_kernel"],
          robotTask: robotRunner(trace, "succeed"),
        }),
      );
      await ex.loop({ maxWindows: 1 }); // announce and self-test: a fresh attestation for the robot-browser profile
      const abort = new AbortController();
      const loop = ex.loop({ signal: abort.signal });
      const res = await testRun();
      abort.abort();
      await loop;
      expect(res.statusCode, `${res.body}\n${ex.logs.join("\n")}`).toBe(200);
      expect(res.json().run).toMatchObject({
        status: "succeeded",
        failureCode: null,
        outputs: { balance: "42" },
      });
      runId = res.json().run.id;
      expect(trace.planStatus).toBe(200);

      // the row: succeeded, its placement named, the digest a submit would bind
      const [row] = await db
        .select()
        .from(robotRuns)
        .where(eq(robotRuns.id, runId));
      expect(row).toMatchObject({
        status: "succeeded",
        kind: "test",
        stepCount: 4,
        failureCode: null,
      });
      expect(row!.executionPlacementId).toBeTruthy();
      const [placement] = await db
        .select()
        .from(executionPlacements)
        .where(eq(executionPlacements.id, row!.executionPlacementId!));
      expect(placement).toMatchObject({
        workloadKind: "robot_browser",
        executorId: ex.executorId,
        imageDigest: IMAGE,
      });
      const submit = await inject(
        "POST",
        `/v1/robots/${robotId}/versions/1/submit`,
        ownerAuth,
        {},
      );
      expect(submit.json().error, submit.body).not.toBe(
        "robot_test_run_required",
      );
      // S2: past the test-run check, the next gate is the approver (none named, none configured)
      expect(submit.statusCode, submit.body).toBe(422);
      expect(submit.json().error).toBe("robot_approver_required");

      // the run's egress, as the executor built it, and the sandbox's view of it
      const [sb] = placementSandboxes(ex.backend);
      // the runner got its result's answer and exited by itself (its `end` frame), so its sandbox was not stopped
      expect(sb).toMatchObject({
        cls: "user_space_kernel",
        probed: true,
        released: true,
        killed: false,
      });
      expect(trace.resultStatus).toBe(200);
      expect(JSON.parse(trace.out.at(-1)!)).toEqual({ t: "end", code: 0 });
      expect(sb!.egress).toMatchObject({
        runId,
        targets: [{ host: "portal.example.com", port: 443 }],
        removed: true,
      });
      expect(trace.egress).toBe(sb!.egress);
      expect(trace.egress!.proxyUrl).toMatch(
        /^http:\/\/[A-Za-z0-9.-]+:\d{1,5}$/,
      );
      const acl = sb!.egress!.acl;
      expect(acl).toMatch(/action:\s*["']?enforce/);
      expect(acl).toContain("portal.example.com");
      const hosts = [
        ...acl.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}/gi),
      ].map((m) => m[0]);
      expect(new Set(hosts)).toEqual(new Set(["portal.example.com"]));
      // N7: the argv the image runs (engines/robot-runner/Dockerfile: CMD ["node","/app/dist/main.js"])
      expect(trace.workload).toEqual({
        command: "/usr/local/bin/node",
        args: ["/app/dist/main.js"],
      });
      // B2: an unclassified project under the org default `warn` masks screenshots (and keeps them)
      expect(trace.screenshots).toBe("masked");

      // the run key (the session secret the release carried) is what opened the sealed secret
      expect(trace.runKey).toBeTruthy();
      expect(sb!.secretSha256).toBe(
        createHash("sha256").update(trace.runKey!).digest("hex"),
      );
      expect(trace.secretOpened).toBe(CANARY);
      expect(trace.heartbeats).toEqual([{ cancel: false }]);

      // evidence: the screenshot, reassembled and re-hashed; the Smokescreen log from the executor's end
      const ev = await db
        .select()
        .from(robotRunEvidence)
        .where(eq(robotRunEvidence.robotRunId, runId));
      const shot = ev.filter((e) => e.kind === "screenshot");
      expect(shot).toEqual([
        expect.objectContaining({
          item: 0,
          step: 1,
          contentType: "image/jpeg",
          sha256: JPEG_SHA,
          sizeBytes: JPEG.length,
        }),
      ]);
      const egressLog = ev.filter((e) => e.kind === "egress_log");
      expect(egressLog, ex.logs.join("\n")).toHaveLength(1);
      expect(egressLog[0]).toMatchObject({
        item: 1,
        contentType: "text/plain",
        step: null,
      });
      // the screenshot's bytes are kept (the store is configured)
      expect(shot[0]!.bytesWithheld).toBeNull();

      // Code 4: the end audit carries the ordered evidence list the run stored by then
      const [end] = await db
        .select({ detail: auditLog.detail })
        .from(auditLog)
        .where(eq(auditLog.ruleId, "robot-run-succeeded"));
      const listed = (end!.detail as { evidence: { item: number; kind: string; sha256: string }[] }).evidence;
      expect(listed[0]).toEqual({ item: 0, kind: "screenshot", sha256: JPEG_SHA });
      // Code 3: the run is on the usage ledger, attributed to its project, unpriced (NULL, never an invented figure)
      const usage = await db.select().from(usageEvents).where(eq(usageEvents.objectType, "robot_run"));
      expect(usage).toEqual([expect.objectContaining({ projectId, userId: ownerId, costUsd: null })]);
      expect((usage[0]!.detail as { robotRunId: string }).robotRunId).toBe(runId);
    }, 120_000);

    it("CANARY: the test secret value is in no frame (either way), no audit row and no evidence row", async () => {
      expect(trace.out.length).toBeGreaterThan(0);
      expect(trace.in.length).toBeGreaterThan(0);
      for (const v of [CANARY, LIVE_VALUE]) {
        expect(trace.out.join("\n")).not.toContain(v);
        expect(trace.in.join("\n")).not.toContain(v);
        // and not base64-encoded inside a frame body either (bodies travel as base64)
        const decoded = [...trace.out, ...trace.in].map((l) => {
          const f = JSON.parse(l) as { body?: string };
          return f.body ? Buffer.from(f.body, "base64").toString("utf8") : "";
        });
        expect(decoded.join("\n")).not.toContain(v);
      }
      // the secret travelled only sealed: the plan frame carries the sealed form, which opens to it
      expect(trace.in.some((l) => l.includes('"http_res"'))).toBe(true);
      const audits = await db
        .select({ detail: auditLog.detail, reason: auditLog.reason })
        .from(auditLog);
      expect(audits.length).toBeGreaterThan(0);
      for (const v of [CANARY, LIVE_VALUE])
        expect(JSON.stringify(audits)).not.toContain(v);
      const ev = await db.select().from(robotRunEvidence);
      for (const v of [CANARY, LIVE_VALUE])
        expect(JSON.stringify(ev)).not.toContain(v);
    });

    it("HALTED mid-run: the next heartbeat answers {cancel:true}; the run ends cancelled, failure_code halted", async () => {
      const t = newTrace();
      const ex = await rig(
        "gvisor-halt",
        new FakeSandboxBackend({
          backend: "gvisor",
          classes: ["hardened_container", "user_space_kernel"],
          robotTask: robotRunner(t, "halt"),
        }),
      );
      // only this executor (the first one's backend would run the succeeding stand-in)
      const { robot, version } = (
        await db
          .select({ robot: robots, version: robotVersions })
          .from(robotVersions)
          .innerJoin(robots, eq(robots.id, robotVersions.robotId))
          .where(eq(robots.id, robotId))
      )[0]!;
      await ex.loop({ maxWindows: 1 });
      const abort = new AbortController();
      const loop = ex.loop({ signal: abort.signal });
      try {
        const out = await startRobotRun(
          db,
          {
            robot,
            version,
            kind: "test",
            requestedBy: ownerId,
            projectId,
            inputs: { username: "alice" },
            contentDigest: "d".repeat(64),
          },
          { dataKey: DATA_KEY, store: null, onlyExecutorIds: [ex.executorId] },
        );
        expect(out, ex.logs.join("\n")).toMatchObject({
          kind: "finished",
          status: "cancelled",
          failureCode: "halted",
          outputs: null,
        });
        expect(t.heartbeats).toEqual([{ cancel: false }, { cancel: true }]);
        const [row] = await db
          .select()
          .from(robotRuns)
          .where(eq(robotRuns.id, (out as { runId: string }).runId));
        expect(row).toMatchObject({
          status: "cancelled",
          failureCode: "halted",
          stepCount: 1,
        });
      } finally {
        await setMode("normal");
        abort.abort();
        await loop;
      }
    }, 120_000);

    it("Code 1: aborting the call cancels the run (heartbeat {cancel}, run cancelled, sandbox released), and no second run starts", async () => {
      const t = newTrace();
      const call = new AbortController();
      // the caller gives up mid-run (a beat after the first heartbeat, once the run is `running`)
      t.onFirstHeartbeat = () => void setTimeout(() => call.abort(), 1_000);
      const ex = await rig(
        "gvisor-abort",
        new FakeSandboxBackend({
          backend: "gvisor",
          classes: ["hardened_container", "user_space_kernel"],
          robotTask: robotRunner(t, "loop"),
        }),
      );
      const { robot, version } = (
        await db
          .select({ robot: robots, version: robotVersions })
          .from(robotVersions)
          .innerJoin(robots, eq(robots.id, robotVersions.robotId))
          .where(eq(robots.id, robotId))
      )[0]!;
      const before = (await db.select({ id: robotRuns.id }).from(robotRuns)).length;
      await ex.loop({ maxWindows: 1 });
      const abort = new AbortController();
      const loop = ex.loop({ signal: abort.signal });
      try {
        const out = await startRobotRun(
          db,
          { robot, version, kind: "test", requestedBy: ownerId, projectId, inputs: { username: "alice" }, contentDigest: "f".repeat(64), signal: call.signal },
          { dataKey: DATA_KEY, store: null, onlyExecutorIds: [ex.executorId], abortGraceMs: 5_000 },
        );
        expect(out, ex.logs.join("\n")).toMatchObject({ kind: "finished", status: "cancelled", failureCode: "caller_aborted", outputs: null });
        expect(t.heartbeats[0]).toEqual({ cancel: false });
        expect(t.heartbeats.at(-1)).toEqual({ cancel: true });
        const [row] = await db.select().from(robotRuns).where(eq(robotRuns.id, (out as { runId: string }).runId));
        expect(row).toMatchObject({ status: "cancelled", failureCode: "caller_aborted" });
        // exactly one run row was written for the call: an aborted call is never retried into a second run
        expect((await db.select({ id: robotRuns.id }).from(robotRuns)).length).toBe(before + 1);
        const [sb] = placementSandboxes(ex.backend);
        expect(sb).toMatchObject({ released: true });
      } finally {
        abort.abort();
        await loop;
      }
    }, 120_000);

    it("B2: under PII mode block the plan turns screenshots off and a download is kept as its sha256 and size only", async () => {
      await db.update(orgSettings).set({ defaultPiiMode: "block" });
      const t = newTrace();
      const ex = await rig(
        "gvisor-block",
        new FakeSandboxBackend({
          backend: "gvisor",
          classes: ["hardened_container", "user_space_kernel"],
          robotTask: robotRunner(t, "download"),
        }),
      );
      const { robot, version } = (
        await db
          .select({ robot: robots, version: robotVersions })
          .from(robotVersions)
          .innerJoin(robots, eq(robots.id, robotVersions.robotId))
          .where(eq(robots.id, robotId))
      )[0]!;
      await ex.loop({ maxWindows: 1 });
      const abort = new AbortController();
      const loop = ex.loop({ signal: abort.signal });
      const store = new FileArtifactStore(storeDir);
      try {
        const out = await startRobotRun(
          db,
          { robot, version, kind: "test", requestedBy: ownerId, projectId, inputs: { username: "alice" }, contentDigest: "9".repeat(64) },
          { dataKey: DATA_KEY, store, onlyExecutorIds: [ex.executorId] },
        );
        expect(out, ex.logs.join("\n")).toMatchObject({ kind: "finished", status: "succeeded" });
        expect(t.screenshots).toBe("none");
        expect(t.evidenceStatus).toBe(200);
        const bytes = Buffer.from("downloaded-statement-bytes-0001");
        const sha = createHash("sha256").update(bytes).digest("hex");
        const ev = await db.select().from(robotRunEvidence).where(eq(robotRunEvidence.robotRunId, (out as { runId: string }).runId));
        expect(ev.filter((e) => e.kind === "download")).toEqual([
          expect.objectContaining({ item: 0, sha256: sha, sizeBytes: bytes.length, bytesWithheld: "pii_block" }),
        ]);
        expect(await store.has(artifactStorageKey(sha))).toBe(false);
      } finally {
        await db.update(orgSettings).set({ defaultPiiMode: "warn" });
        abort.abort();
        await loop;
      }
    }, 120_000);

    it("no executor that can run robot_browser (runc only): refused robot_run_placement_refused, the row ends refused", async () => {
      const ex = await rig(
        "runc",
        new FakeSandboxBackend({
          backend: "runc",
          classes: ["hardened_container"],
        }),
      );
      await ex.loop({ maxWindows: 1 });
      const { robot, version } = (
        await db
          .select({ robot: robots, version: robotVersions })
          .from(robotVersions)
          .innerJoin(robots, eq(robots.id, robotVersions.robotId))
          .where(eq(robots.id, robotId))
      )[0]!;
      const out = await startRobotRun(
        db,
        {
          robot,
          version,
          kind: "test",
          requestedBy: ownerId,
          projectId,
          inputs: { username: "alice" },
          contentDigest: "e".repeat(64),
        },
        {
          dataKey: DATA_KEY,
          store: null,
          onlyExecutorIds: [ex.executorId],
          placementTimeoutMs: 2_000,
        },
      );
      expect(out).toMatchObject({
        kind: "refused",
        code: "robot_run_placement_refused",
      });
      const [row] = await db
        .select()
        .from(robotRuns)
        .where(eq(robotRuns.id, (out as { runId: string }).runId));
      expect(row).toMatchObject({
        status: "refused",
        failureCode: "robot_run_placement_refused",
      });
      expect(placementSandboxes(ex.backend)).toHaveLength(0);
    }, 60_000);
  },
);
