/**
 * Tests only — ADR-0190 slice I5 (review HIGH-1): an engine run's result is ingested only when the run names its task
 * placement and an executor reported that placement `placed`. The B5 engine suites post results from the real runner
 * core (or by hand) without a sandbox; this rig gives each such run a REAL placement first, through the product path:
 *
 *   - a real executor (the executor package's loop, its own workload identity and key, over `app.inject`) with the
 *     FAKE backend, whose engine task stand-in does nothing (the suite's runner side produces the result itself);
 *   - `place(runId)`: the gateway's own task start (`startEngineTask`: the decision, the engine_worker placement keyed
 *     to it, the offer, the held task) for a leased run, then waits for the executor's signed per-placement report;
 *   - `wrapHttp(http)`: a runner HTTP that places a run before its result POST, so `runOnce` / `runRunnerLoop` /
 *     `client.result` work unchanged.
 *
 * A run that is not leased (ended, timed out, never leased) is left alone: `place` returns null and the result POST
 * meets the gateway's own refusal, exactly as before. Placements are restricted to the rig's executor (the shared
 * database holds other suites' executors). Never imported by product code.
 */
import { createHash, randomUUID } from "node:crypto";
import { aiUseCases, engineRuns, eq, executionPlacementReports, sql, type Db } from "@regulait/db";
import type { EngineId, EngineManifestEntry } from "@regulait/shared";
import type { RunnerHttp } from "@regulait/engine-runner";
import { ExecutorClient, generateExecutorKey, ProofChannelCredential, runExecutorLoop, type ExecutorHttp } from "@regulait/sandbox-executor";
import { FakeSandboxBackend } from "@regulait/sandbox-executor/testing";
import { pickLinkedReport } from "../executor-channel.js";
import { setEngineTaskPlacementAffinityForTest, startEngineTask } from "../engine-tasks.js";
import type { ArtifactStore } from "../model-artifacts.js";
import { deploymentEnvironment } from "../oauth/common.js";

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
interface InjectApp {
  inject(opts: { method: Method; url: string; headers?: Record<string, string>; payload?: unknown }): Promise<{ statusCode: number; body: string; rawPayload: Buffer; json(): any }>;
}

export interface EngineTaskRigOptions {
  app: InjectApp;
  db: Db;
  /** the issuer the executor's proofs name (the suite's REGULAIT_PUBLIC_URL) */
  issuer: string;
  /** an admin who sponsors the executor's identity and registers it */
  admin: { id: string; key: { authorization: string } };
  /** the suite's manifest: each engine's task image is set here when it has none (the rig'"'"'s placement needs one) */
  manifest: Readonly<Record<EngineId, EngineManifestEntry>>;
  /** the app's artifact store (an artifact scan's task places the run'"'"'s artifact) */
  artifactStore?: () => ArtifactStore | null;
  name?: string;
}

export interface EngineTaskRig {
  executorId: string;
  /** give a LEASED run a placed task (idempotent); null when the run is not leased or cannot be placed */
  place(runId: string): Promise<string | null>;
  /** a runner HTTP that places a run before its result POST */
  wrapHttp(http: RunnerHttp): RunnerHttp;
  stop(): Promise<void>;
}

const RIG_TASK_IMAGE = `sha256:${"9".repeat(64)}`;
const RESULT_PATH = /^\/v1\/engine-runner\/runs\/([0-9a-f-]{36})\/result$/;

export async function startEngineTaskRig(o: EngineTaskRigOptions): Promise<EngineTaskRig> {
  const tag = `${o.name ?? "rig"}-${randomUUID().slice(0, 8)}`;
  const identifier = `spiffe://rig.example.org/regulait/worker_runtime/${tag}`;
  const env = deploymentEnvironment();
  const idRows = (await o.db.execute(
    sql`insert into workload_identities (kind, identifier, sponsor_user_ids, environments) values ('worker_runtime', ${identifier}, ARRAY[${o.admin.id}]::uuid[], ARRAY[${env}]) returning id`,
  )) as unknown as { rows: Array<{ id: string }> };
  const identityId = idRows.rows[0]!.id;
  const key = await generateExecutorKey();
  await o.db.execute(sql`insert into workload_credentials (identity_id, kind, public_jwk, jwk_thumbprint, not_after)
    values (${identityId}, 'jwk', ${JSON.stringify(key.publicJwk)}::jsonb, ${key.thumbprint}, now() + interval '30 days')`);
  // the engine task stand-in: the suite's runner produces the result; the sandbox only has to be placed
  const backend = new FakeSandboxBackend({ backend: "gvisor", classes: ["user_space_kernel"], engineTask: async () => undefined });
  const d = backend.describe();
  const reg = await o.app.inject({
    method: "POST",
    url: "/v1/executors",
    headers: o.admin.key,
    payload: { workloadIdentityId: identityId, name: `rig-${tag}`, backend: d.backend, runtimeVersion: d.runtimeVersion, classesDeclared: [...d.classes] },
  });
  if (reg.statusCode !== 201) throw new Error(`engine task rig: executor registration refused (${reg.statusCode} ${reg.body})`);
  const executorId = reg.json().executorId as string;
  const http: ExecutorHttp = async (url, init) => {
    const u = new URL(url);
    const res = await o.app.inject({ method: init.method as Method, url: `${u.pathname}${u.search}`, headers: init.headers, ...(init.body !== undefined ? { payload: init.body } : {}) });
    return {
      status: res.statusCode,
      text: async () => res.body,
      bytes: async function* () {
        yield new Uint8Array(res.rawPayload);
      },
    };
  };
  const credential = new ProofChannelCredential({ identifier, key, issuer: o.issuer });
  const client = new ExecutorClient({ gatewayUrl: o.issuer, credential, http });
  const loopOpts = { client, backend, credential, streamWindowSeconds: 1, stdioWindowSeconds: 1, backoffMs: 5, maxBackoffMs: 10 };
  // announce and self-test first (a fresh L2 attestation of the engine-worker profile), then serve in the background
  await runExecutorLoop({ ...loopOpts, maxWindows: 1 });
  const abort = new AbortController();
  const loop = runExecutorLoop({ ...loopOpts, signal: abort.signal }).catch(() => undefined);

  const manifest = (): Readonly<Record<EngineId, EngineManifestEntry>> =>
    Object.fromEntries(Object.entries(o.manifest).map(([id, m]) => [id, { ...m, taskImage: m.taskImage ?? RIG_TASK_IMAGE }])) as Record<EngineId, EngineManifestEntry>;

  /** the run's project must resolve a sensitivity (decision 7): one with an AI use case */
  async function ensureProject(run: { id: string; projectId: string | null; runAsUserId: string | null }): Promise<void> {
    if (run.projectId) {
      const [uc] = await o.db.select({ id: aiUseCases.id }).from(aiUseCases).where(eq(aiUseCases.projectId, run.projectId)).limit(1);
      if (uc) return;
      await o.db.insert(aiUseCases).values({ name: `rig-uc-${tag}-${run.id.slice(0, 8)}`, description: "d", ownerUserId: o.admin.id, businessContext: "b", dataSensitivity: "internal", projectId: run.projectId });
      return;
    }
    const pid = ((await o.db.execute(sql`insert into projects (name) values (${`rig-p-${tag}-${run.id.slice(0, 8)}`}) returning id`)) as unknown as { rows: Array<{ id: string }> }).rows[0]!.id;
    await o.db.insert(aiUseCases).values({ name: `rig-uc-${tag}-${run.id.slice(0, 8)}`, description: "d", ownerUserId: o.admin.id, businessContext: "b", dataSensitivity: "internal", projectId: pid });
    await o.db.update(engineRuns).set({ projectId: pid }).where(eq(engineRuns.id, run.id));
  }

  async function place(runId: string): Promise<string | null> {
    const [run] = await o.db.select().from(engineRuns).where(eq(engineRuns.id, runId));
    if (!run || run.status !== "leased" || !run.runnerId) return null;
    if (run.taskPlacementId) return run.taskPlacementId;
    await ensureProject(run);
    const m = manifest()[run.engineId as EngineId];
    const body = {
      files: [{ path: `${runId}/job.json`, data: Buffer.from(JSON.stringify({ runId })).toString("base64") }],
      artifact: run.targetKind === "artifact" ? { path: `${runId}/artifact.pkl` } : null,
      secret: m.needsModelAccess ? `rig-${createHash("sha256").update(runId).digest("hex").slice(0, 24)}` : null,
    };
    setEngineTaskPlacementAffinityForTest([executorId]);
    let out;
    try {
      out = await startEngineTask(
        o.db,
        {
          manifest,
          artifactStore: o.artifactStore ?? (() => null),
          // a refusal here leaves the run to the suite (the rig never ends a run itself)
          endRunTx: async () => null,
          notifyEnded: async () => undefined,
        },
        run.runnerId,
        runId,
        body,
      );
    } finally {
      setEngineTaskPlacementAffinityForTest(null);
    }
    if (out.kind !== "offered") return null;
    const placementId = out.task.placementId;
    for (let i = 0; i < 400; i++) {
      const r = pickLinkedReport(await o.db.select().from(executionPlacementReports).where(eq(executionPlacementReports.placementId, placementId)));
      if (r?.outcome === "placed") return placementId;
      if (r) {
        console.warn(`engine task rig: run ${runId}'s placement was reported ${r.outcome} (${r.refusalCode ?? r.endCode ?? ""})`);
        return null;
      }
      await new Promise((res) => setTimeout(res, 25));
    }
    console.warn(`engine task rig: run ${runId}'s placement was never reported`);
    return null;
  }

  return {
    executorId,
    place,
    wrapHttp: (inner) => async (url, init) => {
      const m = init.method === "POST" ? RESULT_PATH.exec(new URL(url).pathname) : null;
      if (m) await place(m[1]!);
      return inner(url, init);
    },
    stop: async () => {
      abort.abort();
      await loop;
    },
  };
}
