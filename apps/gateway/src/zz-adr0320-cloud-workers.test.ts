/**
 * ADR-0320 (lane E5, slice 2) — third-party cloud coding agents as governed pillar-7 workers.
 *
 * Local fake Cursor and Devin servers (loopback, opted into private ranges) stand in for the vendors; no live call is
 * ever made. Pinned:
 *  - the org setting is off by default, and every refusal (org off, provider not configured / disabled / halted, the
 *    execution dial, no grant, plan not signed off, over budget, Copilot and Codex) writes one deny audit row and sends
 *    NOTHING upstream;
 *  - an allowed dispatch writes exactly one dispatch row, one `usage_events` row (object type cloud_worker, the
 *    reserved cap) and one allow audit row;
 *  - the credential is sent as Bearer only to the provider's own origin and never appears in an audit row or a read;
 *    the prompt text is never audited;
 *  - Devin's launch carries `max_acu_limit` from the reservation and an empty `secret_ids`;
 *  - a poll maps Cursor's FINISHED to succeeded with the PR URL, audited once on the change;
 *  - the halt cancels a live Cursor run (the fake server sees the cancel) and refuses new dispatches.
 * Scoped to the rows this file creates (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  CLOUD_WORKER_PROVIDER_IDS,
  cloudWorkerCredentials,
  cloudWorkerDispatches,
  cloudWorkerProviders,
  createDb,
  desc,
  eq,
  gitConnections,
  inArray,
  ORG_SETTINGS_ID,
  orgSettings,
  runMigrations,
  sql,
  usageEvents,
  workflowInstances,
  type Db,
} from "@regulait/db";
import { CLOUD_WORKER_PROVIDERS } from "@regulait/orchestration-kernel";
import { buildApp } from "./app.js";
import { CLOUD_WORKER_RULE_IDS, cloudWorkerDecisionRuleId, executeGovernedCloudWorkerDispatch, haltCloudWorkerProvider, instanceAtSignedOffBuild, pollCloudWorkerDispatch, type GovernedCloudWorkerDispatchArgs } from "./cloud-workers.js";
import { encryptSecret } from "./secrets.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `e5-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = randomBytes(32).toString("hex");
const CURSOR_SECRET = `e5-cursor-${randomBytes(12).toString("hex")}`;
const DEVIN_SECRET = `apk_e5devin${randomBytes(12).toString("hex")}`;
const PROMPT_MARKER = `e5-prompt-marker-${RUN}`;
const CONN = `e5-conn-${RUN}`;
const OWNER = "acme";
const REPO = `widgets-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
const restores: Array<() => Promise<void>> = [];
const instanceIds: string[] = [];
let userId: string;
let adminKey: Record<string, string>;
let adminId: string;
let signedInstance: string;

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** a fake provider: `route` answers a request, every request is recorded */
async function startFake(route: (method: string, url: string, body: string) => { status: number; json: unknown }) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", headers: { ...req.headers }, body });
      const out = route(req.method ?? "", req.url ?? "", body);
      res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  return {
    base: `http://127.0.0.1:${addr.port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

let cursorRunStatus = "RUNNING";
let cursorAgentSeq = 0;
let cursorUp: Awaited<ReturnType<typeof startFake>>;
let devinUp: Awaited<ReturnType<typeof startFake>>;

const req = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const setEnabled = (on: boolean) => db.update(orgSettings).set({ cloudWorkersEnabled: on }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
const lastAudit = async (ruleId: string) => (await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectType, "cloud_worker"))).orderBy(desc(auditLog.seq)).limit(1))[0];
const posts = (f: { seen: Seen[] }) => f.seen.filter((s) => s.method === "POST").length;
const allRequests = () => cursorUp.seen.length + devinUp.seen.length;

const STAGES = [
  { id: "intake", type: "trigger" },
  { id: "plan", type: "planning" },
  { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
  { id: "build", type: "automated_build" },
  { id: "pr", type: "git_operation", action: "open_pr", connection: CONN, repo: `${OWNER}/${REPO}`, base: "main" },
];

async function mkInstance(opts: { signed: boolean; projectId?: string | null }): Promise<string> {
  const state = opts.signed
    ? { status: "awaiting_execution", currentStageIndex: 3, stageStatuses: ["completed", "completed", "completed", "active", "pending"], artifactVersions: {} }
    : { status: "blocked_on_approval", currentStageIndex: 2, stageStatuses: ["completed", "completed", "active", "pending", "pending"], artifactVersions: {} };
  const [row] = await db
    .insert(workflowInstances)
    .values({ templateIds: [], definition: { workflow: `e5-${RUN}`, stages: STAGES }, initiatorUserId: userId, change: {}, state, status: state.status, projectId: opts.projectId ?? null })
    .returning({ id: workflowInstances.id });
  instanceIds.push(row!.id);
  return row!.id;
}

const dispatchArgs = (over: Partial<GovernedCloudWorkerDispatchArgs> = {}): GovernedCloudWorkerDispatchArgs => ({
  userId,
  provider: "cursor",
  workflowInstanceId: signedInstance,
  stageId: "build",
  repo: { host: "github.com", owner: OWNER, name: REPO },
  baseBranch: "main",
  prompt: `Add a CONTRIBUTING file. ${PROMPT_MARKER}`,
  budgetCapUsd: 10,
  ...over,
});

/** a refusal: one deny audit row with the rule id, and no request reached either fake provider */
async function expectDenied(args: GovernedCloudWorkerDispatchArgs, ruleId: string) {
  const before = allRequests();
  const out = await executeGovernedCloudWorkerDispatch(db, args);
  expect(out.kind, JSON.stringify(out)).toBe("denied");
  if (out.kind !== "denied") return out;
  expect(out.ruleId).toBe(ruleId);
  expect(allRequests()).toBe(before);
  const [row] = await db.select().from(auditLog).where(eq(auditLog.id, out.auditId));
  expect(row).toMatchObject({ effect: "deny", ruleId, objectType: "cloud_worker", userId: args.userId });
  expect(JSON.stringify(row)).not.toContain(PROMPT_MARKER);
  return out;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // the provider rows are one per provider per tenant: clear leftovers of an earlier, interrupted run of this file
  await db.delete(cloudWorkerDispatches);
  await db.delete(cloudWorkerProviders);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db.select({ on: orgSettings.cloudWorkersEnabled, mode: orgSettings.executionMode, reason: orgSettings.executionModeReason }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => void (await db.update(orgSettings).set({ cloudWorkersEnabled: before?.on ?? false, executionMode: before?.mode ?? "normal", executionModeReason: before?.reason ?? null }).where(eq(orgSettings.id, ORG_SETTINGS_ID))));
  await setEnabled(false);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();

  cursorUp = await startFake((method, url) => {
    if (method === "POST" && url === "/v1/agents") {
      cursorAgentSeq += 1;
      return { status: 201, json: { id: `bc-e5${RUN}${cursorAgentSeq}`, url: "https://cursor.com/agents/e5", run: { id: `run${cursorAgentSeq}` } } };
    }
    if (method === "GET" && /^\/v1\/agents\/[A-Za-z0-9_-]+\/runs\/[A-Za-z0-9_-]+$/.test(url)) {
      return cursorRunStatus === "FINISHED"
        ? { status: 200, json: { status: "FINISHED", git: { branches: [{ name: "cursor/e5-work", prUrl: `https://github.com/${OWNER}/${REPO}/pull/7` }] } } }
        : { status: 200, json: { status: cursorRunStatus } };
    }
    if (method === "POST" && url.endsWith("/cancel")) return { status: 200, json: {} };
    return { status: 404, json: {} };
  });
  devinUp = await startFake((method, url) => {
    if (method === "POST" && url === "/v1/sessions") return { status: 200, json: { session_id: `devin-e5${RUN}`, url: "https://app.devin.ai/sessions/e5" } };
    if (method === "GET" && url.startsWith("/v1/sessions/")) return { status: 200, json: { status_enum: "working" } };
    return { status: 404, json: {} };
  });

  const u = await req("POST", "/v1/users", { email: `e5-user-${RUN}@example.com`, displayName: `e5 user ${RUN}` });
  expect(u.statusCode, u.body).toBe(201);
  userId = u.json().id;
  const a = await req("POST", "/v1/users", { email: `e5-admin-${RUN}@example.com`, displayName: `e5 admin ${RUN}`, isAdmin: true });
  expect(a.statusCode, a.body).toBe(201);
  adminId = a.json().id;
  adminKey = { authorization: `Bearer ${(await req("POST", `/v1/users/${adminId}/keys`, { name: "e5" })).json().token}` };
  await db.insert(gitConnections).values({ name: CONN, provider: "github", tokenCiphertext: encryptSecret(DATA_KEY, "e5-git-token") });
  signedInstance = await mkInstance({ signed: true });
}, 120_000);

afterAll(async () => {
  try {
    await db.delete(cloudWorkerDispatches);
    await db.delete(cloudWorkerProviders);
    if (instanceIds.length) await db.delete(workflowInstances).where(inArray(workflowInstances.id, instanceIds));
    await db.delete(gitConnections).where(eq(gitConnections.name, CONN));
    for (const r of restores.reverse()) await r();
  } finally {
    await cursorUp?.close();
    await devinUp?.close();
    app.server.closeAllConnections();
    await app.close();
  }
});

describe("ADR-0320: the kernel and the db agree", () => {
  it("the db's provider ids are the kernel's", () => {
    expect([...CLOUD_WORKER_PROVIDER_IDS]).toEqual([...CLOUD_WORKER_PROVIDERS]);
  });
  it("a build stage counts as signed off only after a completed planning stage and a completed sign-off", () => {
    const def = { stages: STAGES };
    expect(instanceAtSignedOffBuild(def, { status: "awaiting_execution", currentStageIndex: 3, stageStatuses: ["completed", "completed", "completed", "active", "pending"] })).toBe(true);
    expect(instanceAtSignedOffBuild(def, { status: "awaiting_execution", currentStageIndex: 3, stageStatuses: ["completed", "completed", "reopened", "active", "pending"] })).toBe(false);
    expect(instanceAtSignedOffBuild({ stages: [STAGES[0], STAGES[1], STAGES[3]] }, { status: "awaiting_execution", currentStageIndex: 2, stageStatuses: ["completed", "completed", "active"] })).toBe(false);
    expect(instanceAtSignedOffBuild(def, { status: "aborted", currentStageIndex: 3, stageStatuses: ["completed", "completed", "completed", "active", "pending"] })).toBe(false);
    expect(instanceAtSignedOffBuild(def, { status: "awaiting_execution", currentStageIndex: 3, stageStatuses: ["completed", "completed", "completed", "active", "pending"] }, "pr")).toBe(false);
    expect(instanceAtSignedOffBuild("garbage", null)).toBe(false);
  });
});

describe("ADR-0320: the org setting", () => {
  it("is off by default: a dispatch is refused and audited, and nothing reaches a provider", async () => {
    await expectDenied(dispatchArgs(), CLOUD_WORKER_RULE_IDS.disabled);
    expect(allRequests()).toBe(0);
    expect((await req("GET", "/v1/cloud-workers/providers")).json().enabled).toBe(false);
  });

  it("turning it on is a relaxation: an API key is asked for a step-up", async () => {
    const asked = await req("PUT", "/v1/org/settings", { cloudWorkersEnabled: true }, adminKey);
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const on = await req("PUT", "/v1/org/settings", { cloudWorkersEnabled: true });
    expect(on.statusCode, on.body).toBe(200);
    const row = (await db.select().from(auditLog).where(eq(auditLog.ruleId, "org-settings-updated")).orderBy(desc(auditLog.seq)).limit(1))[0];
    expect(JSON.stringify(row?.detail)).toContain("cloudWorkersEnabled");
  });
});

describe("ADR-0320: providers", () => {
  it("a provider never configured is refused (default deny)", async () => {
    await expectDenied(dispatchArgs(), cloudWorkerDecisionRuleId("provider_not_configured"));
  });

  it("a provider is created disabled, and a disabled provider is refused", async () => {
    const r = await req("PUT", "/v1/cloud-workers/providers/cursor", { baseUrl: cursorUp.base, allowPrivateRanges: true });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ provider: "cursor", enabled: false, readiness: "fake_verified", credential: { set: false } });
    expect(r.json().scopeNote).toContain("pinned repositories only");
    await expectDenied(dispatchArgs(), cloudWorkerDecisionRuleId("provider_disabled"));
  });

  it("refuses a base URL with a path, and plain http without the private-range opt-in", async () => {
    const withPath = await req("PUT", "/v1/cloud-workers/providers/devin", { baseUrl: `${devinUp.base}/v1`, allowPrivateRanges: true });
    expect(withPath.statusCode, withPath.body).toBe(400);
    expect(withPath.json()).toMatchObject({ code: "base_url_refused" });
    const plain = await req("PUT", "/v1/cloud-workers/providers/devin", { baseUrl: devinUp.base });
    expect(plain.statusCode, plain.body).toBe(400);
    expect(plain.json()).toMatchObject({ code: "base_url_refused" });
  });

  it("enabling is a step-up and audited as a relaxation", async () => {
    const asked = await req("PUT", "/v1/cloud-workers/providers/cursor", { baseUrl: cursorUp.base, allowPrivateRanges: true, enabled: true }, adminKey);
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const on = await req("PUT", "/v1/cloud-workers/providers/cursor", { baseUrl: cursorUp.base, allowPrivateRanges: true, enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().enabled).toBe(true);
    expect((await lastAudit(CLOUD_WORKER_RULE_IDS.providerSaved))?.detail).toMatchObject({ relaxation: true });
  });

  it("is admin-only", async () => {
    const userKey = { authorization: `Bearer ${(await req("POST", `/v1/users/${userId}/keys`, { name: "e5u" })).json().token}` };
    expect((await req("GET", "/v1/cloud-workers/providers", undefined, userKey)).statusCode).toBe(403);
    expect((await req("PUT", "/v1/cloud-workers/providers/cursor", { baseUrl: cursorUp.base }, userKey)).statusCode).toBe(403);
  });

  it("GitHub Copilot and OpenAI Codex cannot be enabled or dispatched to (contract unverified)", async () => {
    const r = await req("PUT", "/v1/cloud-workers/providers/github_copilot", { baseUrl: "https://api.github.com", enabled: true });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json()).toMatchObject({ code: "provider_not_ready" });
    await expectDenied(dispatchArgs({ provider: "github_copilot" }), cloudWorkerDecisionRuleId("provider_not_ready"));
    await expectDenied(dispatchArgs({ provider: "openai_codex" }), cloudWorkerDecisionRuleId("provider_not_ready"));
  });

  it("the credential is stored encrypted and only its last four characters are ever returned", async () => {
    const asked = await req("PUT", "/v1/cloud-workers/providers/cursor/credential", { secret: CURSOR_SECRET }, adminKey);
    expect(asked.statusCode, asked.body).toBe(403);
    const set = await req("PUT", "/v1/cloud-workers/providers/cursor/credential", { secret: CURSOR_SECRET });
    expect(set.statusCode, set.body).toBe(201);
    expect(set.body).not.toContain(CURSOR_SECRET);
    expect(set.json().credential).toMatchObject({ set: true, last4: CURSOR_SECRET.slice(-4) });
    const [row] = await db.select().from(cloudWorkerCredentials);
    expect(row!.secretCiphertext).not.toContain(CURSOR_SECRET);
    expect((await req("GET", "/v1/cloud-workers/providers")).body).not.toContain(CURSOR_SECRET);
  });
});

describe("ADR-0320: the dispatch envelope", () => {
  it("no grant, no dispatch", async () => {
    await expectDenied(dispatchArgs(), cloudWorkerDecisionRuleId("no_grant"));
  });

  it("a build stage whose plan is not signed off is refused", async () => {
    const g = await req("POST", "/v1/cloud-workers/providers/cursor/grants", { userId });
    expect(g.statusCode, g.body).toBe(201);
    const unsigned = await mkInstance({ signed: false });
    await expectDenied(dispatchArgs({ workflowInstanceId: unsigned }), cloudWorkerDecisionRuleId("plan_not_signed_off"));
  });

  it("a dispatch outside the person's own workflow instance is refused", async () => {
    await expectDenied(dispatchArgs({ workflowInstanceId: randomUUID() }), cloudWorkerDecisionRuleId("not_in_workflow"));
    await expectDenied(dispatchArgs({ userId: adminId }), cloudWorkerDecisionRuleId("not_in_workflow"));
  });

  it("the execution dial's halt refuses", async () => {
    await db.update(orgSettings).set({ executionMode: "halted", executionModeReason: "e5 test halt" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      await expectDenied(dispatchArgs(), cloudWorkerDecisionRuleId("execution_halted"));
    } finally {
      await db.update(orgSettings).set({ executionMode: "normal", executionModeReason: null }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
  });

  it("the lead ceiling only narrows, and a repository the workflow does not target is refused", async () => {
    await expectDenied(dispatchArgs({ ceilingProviders: ["devin"] }), cloudWorkerDecisionRuleId("outside_ceiling"));
    await expectDenied(dispatchArgs({ repo: { host: "github.com", owner: OWNER, name: "other-repo" } }), cloudWorkerDecisionRuleId("repo_not_entitled"));
    await expectDenied(dispatchArgs({ baseBranch: "release" }), cloudWorkerDecisionRuleId("repo_not_entitled"));
  });

  it("over budget: the node ceiling, the run remainder and the project budget each refuse", async () => {
    await expectDenied(dispatchArgs({ budget: { nodeCeilingUsd: 5 } }), cloudWorkerDecisionRuleId("over_node_budget"));
    await expectDenied(dispatchArgs({ budget: { runRemainingUsd: 1 } }), cloudWorkerDecisionRuleId("over_run_budget"));
    const p = await req("POST", "/v1/projects", { name: `e5-proj-${RUN}`, budgetUsd: 0.01, budgetApproverUserId: adminId });
    expect(p.statusCode, p.body).toBe(201);
    const projectId = p.json().id as string;
    await db.insert(usageEvents).values({ userId, objectType: "agent", projectId, costUsd: 1 });
    const inProject = await mkInstance({ signed: true, projectId });
    const out = await expectDenied(dispatchArgs({ workflowInstanceId: inProject, callerIsAdmin: true }), CLOUD_WORKER_RULE_IDS.projectBudget);
    expect(out.status).toBe(409);
  });

  it("an invalid task (an unsafe branch) is refused without echoing the prompt", async () => {
    await expectDenied(dispatchArgs({ baseBranch: "main..evil" }), CLOUD_WORKER_RULE_IDS.invalidTask);
  });
});

describe("ADR-0320: an allowed dispatch", () => {
  let dispatchId: string;

  it("Cursor: one dispatch row, one usage row and one allow audit row; Bearer on the registered origin only", async () => {
    const before = posts(cursorUp);
    const out = await executeGovernedCloudWorkerDispatch(db, dispatchArgs());
    expect(out.kind, JSON.stringify(out)).toBe("dispatched");
    if (out.kind !== "dispatched") return;
    dispatchId = out.dispatchId;
    expect(posts(cursorUp)).toBe(before + 1);
    const launch = cursorUp.seen.filter((s) => s.method === "POST").at(-1)!;
    expect(launch.path).toBe("/v1/agents");
    expect(launch.headers.authorization).toBe(`Bearer ${CURSOR_SECRET}`);
    const body = JSON.parse(launch.body);
    expect(body).toMatchObject({ workOnCurrentBranch: false, autoCreatePR: true, agentId: `bc-${dispatchId}`, repos: [{ url: `https://github.com/${OWNER}/${REPO}`, startingRef: "main" }] });
    expect(body.prompt.text).toContain(PROMPT_MARKER);
    expect(body.prompt.text).toContain(`regulait/${signedInstance}/`);

    const dispatches = await db.select().from(cloudWorkerDispatches).where(eq(cloudWorkerDispatches.id, dispatchId));
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ state: "running", externalRunId: "run1", reservedUsd: 10, userId, workflowInstanceId: signedInstance, repoOwner: OWNER, repoName: REPO, usageEventId: out.usageEventId });
    const usage = await db.select().from(usageEvents).where(sql`${usageEvents.detail} ->> 'cloudWorkerDispatchId' = ${dispatchId}`);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ id: out.usageEventId, objectType: "cloud_worker", costUsd: 10, userId });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, CLOUD_WORKER_RULE_IDS.dispatched), sql`${auditLog.detail} ->> 'dispatchId' = ${dispatchId}`));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ id: out.auditId, effect: "allow", userId });
    expect(JSON.stringify(audits[0])).not.toContain(PROMPT_MARKER);
  });

  it("Devin: the launch carries max_acu_limit from the reservation and empty secret_ids, with Devin's own key", async () => {
    const r = await req("PUT", "/v1/cloud-workers/providers/devin", { baseUrl: devinUp.base, allowPrivateRanges: true, enabled: true, usdPerAcu: 2.25 });
    expect(r.statusCode, r.body).toBe(201);
    expect((await req("PUT", "/v1/cloud-workers/providers/devin/credential", { secret: DEVIN_SECRET })).statusCode).toBe(201);
    // the cap without a grant is still refused
    await expectDenied(dispatchArgs({ provider: "devin" }), cloudWorkerDecisionRuleId("no_grant"));
    expect((await req("POST", "/v1/cloud-workers/providers/devin/grants", { userId })).statusCode).toBe(201);
    const out = await executeGovernedCloudWorkerDispatch(db, dispatchArgs({ provider: "devin" }));
    expect(out.kind, JSON.stringify(out)).toBe("dispatched");
    const launch = devinUp.seen.filter((s) => s.method === "POST").at(-1)!;
    expect(launch.path).toBe("/v1/sessions");
    expect(launch.headers.authorization).toBe(`Bearer ${DEVIN_SECRET}`);
    expect(JSON.parse(launch.body)).toMatchObject({ max_acu_limit: 4, secret_ids: [], knowledge_ids: [], idempotent: true });
    // each provider saw only its own key
    expect(cursorUp.seen.some((s) => String(s.headers.authorization ?? "").includes(DEVIN_SECRET))).toBe(false);
    expect(devinUp.seen.some((s) => String(s.headers.authorization ?? "").includes(CURSOR_SECRET))).toBe(false);
  });

  it("a poll maps FINISHED to succeeded with the PR URL, and is audited on the change only", async () => {
    expect(await pollCloudWorkerDispatch(db, dispatchId)).toEqual({ kind: "unchanged", state: "running" });
    cursorRunStatus = "FINISHED";
    const out = await pollCloudWorkerDispatch(db, dispatchId);
    expect(out).toMatchObject({ kind: "changed", from: "running", state: "succeeded", prUrl: `https://github.com/${OWNER}/${REPO}/pull/7` });
    const [row] = await db.select().from(cloudWorkerDispatches).where(eq(cloudWorkerDispatches.id, dispatchId));
    expect(row).toMatchObject({ state: "succeeded", prUrl: `https://github.com/${OWNER}/${REPO}/pull/7` });
    const changes = () => db.select().from(auditLog).where(and(eq(auditLog.ruleId, CLOUD_WORKER_RULE_IDS.stateChanged), sql`${auditLog.detail} ->> 'dispatchId' = ${dispatchId}`));
    expect(await changes()).toHaveLength(1);
    expect(await pollCloudWorkerDispatch(db, dispatchId)).toEqual({ kind: "unchanged", state: "succeeded" });
    expect(await changes()).toHaveLength(1);
    cursorRunStatus = "RUNNING";
  });

  it("the dispatch list is admin-only and paginated", async () => {
    const r = await req("GET", "/v1/cloud-workers/dispatches?provider=cursor&limit=1");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().dispatches).toHaveLength(1);
    expect(r.body).not.toContain(CURSOR_SECRET);
  });
});

describe("ADR-0320: the kill switch", () => {
  it("halting cancels a live Cursor run (the fake server sees the cancel) and refuses new dispatches", async () => {
    const live = await executeGovernedCloudWorkerDispatch(db, dispatchArgs());
    expect(live.kind, JSON.stringify(live)).toBe("dispatched");
    if (live.kind !== "dispatched") return;
    const cancelsBefore = cursorUp.seen.filter((s) => s.path.endsWith("/cancel")).length;
    const r = await req("POST", "/v1/cloud-workers/providers/cursor/halt", { reason: "e5 incident drill" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().cancelled).toEqual([{ dispatchId: live.dispatchId, cancelSent: true, reason: "provider_halted" }]);
    const cancels = cursorUp.seen.filter((s) => s.path.endsWith("/cancel"));
    expect(cancels.length).toBe(cancelsBefore + 1);
    expect(cancels.at(-1)!.path).toMatch(/^\/v1\/agents\/bc-[A-Za-z0-9_-]+\/runs\/run\d+\/cancel$/);
    expect(cancels.at(-1)!.headers.authorization).toBe(`Bearer ${CURSOR_SECRET}`);
    const [row] = await db.select().from(cloudWorkerDispatches).where(eq(cloudWorkerDispatches.id, live.dispatchId));
    expect(row).toMatchObject({ state: "cancelled", reason: "provider_halted" });
    expect((await lastAudit(CLOUD_WORKER_RULE_IDS.halted))?.reason).toContain("e5 incident drill");
    await expectDenied(dispatchArgs(), cloudWorkerDecisionRuleId("provider_halted"));
  });

  it("halting Devin stops a live session it cannot cancel (no verified endpoint)", async () => {
    const out = await haltCloudWorkerProvider(db, "devin", "e5 devin drill", adminId);
    expect(out.kind).toBe("halted");
    if (out.kind !== "halted") return;
    expect(out.cancelled).toHaveLength(1);
    expect(out.cancelled[0]).toMatchObject({ cancelSent: false, reason: "provider_halted_no_cancel_endpoint" });
  });

  it("lifting the halt is a step-up", async () => {
    const asked = await req("POST", "/v1/cloud-workers/providers/cursor/unhalt", undefined, adminKey);
    expect(asked.statusCode, asked.body).toBe(403);
    const lifted = await req("POST", "/v1/cloud-workers/providers/cursor/unhalt");
    expect(lifted.statusCode, lifted.body).toBe(200);
    expect(lifted.json()).toMatchObject({ halted: false });
  });

  it("no audit row this file wrote carries a credential or the prompt text", async () => {
    const rows = await db.select().from(auditLog).where(eq(auditLog.objectType, "cloud_worker"));
    expect(rows.length).toBeGreaterThan(10);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(CURSOR_SECRET);
    expect(text).not.toContain(DEVIN_SECRET);
    expect(text).not.toContain(PROMPT_MARKER);
  });
});
