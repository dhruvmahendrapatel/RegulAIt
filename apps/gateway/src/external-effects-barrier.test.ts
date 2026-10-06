/**
 * AER-018 — THE BARRIER MATRIX: every wrapped adapter method × every non-normal
 * execution mode, through the real routes.
 *
 * `runExternalWrite` re-reads the kill-switch dial immediately before the
 * provider call. The unit test in external-effects.test.ts proves the function
 * refuses; this file proves the ROUTES hand their provider call to it last —
 * that nothing a route does between its own preparation and the adapter can
 * run ahead of a dial that flips in that window.
 *
 * Mechanics, per cell:
 *   1. ARM a gate for one operation. The gate is a wrapper over the REAL
 *      `runExternalWrite` (importOriginal) that, for the armed operation only,
 *      pauses at ENTRY — after the route has resolved its provider, loaded its
 *      rows and passed every earlier check under 'normal', and before the
 *      barrier's re-read.
 *   2. Drive the route. Wait until it reaches the gate.
 *   3. FLIP the dial (PUT /v1/execution/mode) while the route waits there.
 *   4. Release the gate. The real barrier re-reads the dial and refuses.
 *   5. The COUNTING FAKE for that adapter method — a proxy over the resolved
 *      provider, installed by wrapping each package's resolver the way
 *      mrm.test.ts wraps resolveModelProvider — must not have moved.
 *
 * Every row ends with a POSITIVE CONTROL: the same drive under 'normal' moves
 * the fake, so a zero above cannot be "the path never got there". A final
 * assertion checks the matrix covered every classified operation under every
 * mode, so an operation added to EXTERNAL_WRITE_OPERATIONS without a row here
 * fails.
 *
 * Rows: deploy.deploy, deploy.rollback (workflow deployment + rollback stages);
 * git.create_branch, git.open_pull_request, git.merge_pull_request
 * (git_operation stages); infra.remediate via ALL THREE sites — the finding
 * approval-decision, the scan auto-remediation and the cert_rotate operator
 * action-decision; pm.create_work_item, pm.update_fields
 * (run sync: create, then repair-in-place), pm.transition_state (node status
 * mirror on run events), pm.add_comment (decision mirror).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { EXTERNAL_WRITE_OPERATIONS, type ExternalWriteOperation } from "./external-effects.js";

// ---------------------------------------------------------------------------
// the probe — hoisted so the mock factories below can see it
// ---------------------------------------------------------------------------

const probe = vi.hoisted(() => {
  const counts = new Map<string, number>();
  const entries = new Map<string, number>(); // calls that went through the GATED runExternalWrite below
  let armed: { operation: string; reached: () => void; released: Promise<void> } | null = null;
  const bump = (op: string) => counts.set(op, (counts.get(op) ?? 0) + 1);
  return {
    count: (op: string) => counts.get(op) ?? 0,
    entries: (op: string) => entries.get(op) ?? 0,
    /** pause the NEXT runExternalWrite for `operation` at entry */
    arm(operation: string) {
      let reached!: () => void;
      let release!: () => void;
      const reachedAt = new Promise<void>((r) => (reached = r));
      const released = new Promise<void>((r) => (release = r));
      armed = { operation, reached, released };
      return { reached: reachedAt, release };
    },
    disarm() {
      armed = null;
    },
    async pause(operation: string) {
      entries.set(operation, (entries.get(operation) ?? 0) + 1);
      if (armed && armed.operation === operation) {
        const gate = armed;
        armed = null;
        gate.reached();
        await gate.released;
      }
    },
    /** a proxy over a resolved provider that counts the named methods, then delegates */
    counting<T extends object>(inner: T, ops: Record<string, string>): T {
      const wrapped = Object.create(inner) as T;
      for (const [method, operation] of Object.entries(ops)) {
        (wrapped as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
          bump(operation);
          return (inner as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args);
        };
      }
      return wrapped;
    },
  };
});

// the gate: the real barrier, entered through a pause for the armed operation
vi.mock("./external-effects.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./external-effects.js")>();
  const runExternalWrite: typeof actual.runExternalWrite = async (db, operation, call) => {
    await probe.pause(operation);
    return actual.runExternalWrite(db, operation, call);
  };
  return { ...actual, runExternalWrite };
});

// the counting fakes: each package's resolver, wrapped the way mrm.test.ts
// wraps resolveModelProvider — the real adapter underneath, every write counted
vi.mock("./deploy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./deploy.js")>();
  return {
    ...actual,
    resolveDeployProvider: (...args: Parameters<typeof actual.resolveDeployProvider>) =>
      probe.counting(actual.resolveDeployProvider(...args), { deploy: "deploy.deploy", rollback: "deploy.rollback" }),
  };
});
vi.mock("@regulait/git-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/git-provider")>();
  return {
    ...actual,
    resolveProvider: (...args: Parameters<typeof actual.resolveProvider>) =>
      probe.counting(actual.resolveProvider(...args), {
        createBranch: "git.create_branch",
        openPullRequest: "git.open_pull_request",
        mergePullRequest: "git.merge_pull_request",
      }),
  };
});
vi.mock("@regulait/infra-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/infra-provider")>();
  return {
    ...actual,
    resolveInfraProvider: (...args: Parameters<typeof actual.resolveInfraProvider>) =>
      probe.counting(actual.resolveInfraProvider(...args), { remediate: "infra.remediate" }),
  };
});
vi.mock("@regulait/pm-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/pm-provider")>();
  return {
    ...actual,
    resolvePmProvider: (...args: Parameters<typeof actual.resolvePmProvider>) =>
      probe.counting(actual.resolvePmProvider(...args), {
        createWorkItem: "pm.create_work_item",
        updateFields: "pm.update_fields",
        transitionState: "pm.transition_state",
        addComment: "pm.add_comment",
      }),
  };
});

const { buildApp } = await import("./app.js");
const { resolvePmProvider } = await import("@regulait/pm-provider");
type MockPmProvider = import("@regulait/pm-provider").MockPmProvider;

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "barrier-matrix-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Math.random().toString(36).slice(2, 8);
const MODES = ["halted", "read_only", "require_approval"] as const;
type FlippedMode = (typeof MODES)[number];

let db: Db;
let app: ReturnType<typeof buildApp>;
let piaAuth: { authorization: string }; // the initiator
let piaId: string;
let anaAuth: { authorization: string }; // the approver (gates, infra proposals, require_approval)
let anaId: string;
let workerAgentId: string;

/** which (operation, mode) cells the matrix actually exercised */
const covered = new Map<string, Set<string>>();
const mark = (operation: string, mode: string) => {
  if (!covered.has(operation)) covered.set(operation, new Set());
  covered.get(operation)!.add(mode);
};

type Injected = Awaited<ReturnType<typeof app.inject>>;
const post = (url: string, payload: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers: Record<string, string> = AUTH) => app.inject({ method: "GET", url, headers });

async function makeUser(email: string) {
  const user = await post("/v1/users", { email, displayName: email.split("@")[0] });
  expect(user.statusCode).toBe(201);
  const key = await post(`/v1/users/${user.json().id}/keys`, { name: "barrier" });
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

async function setMode(mode: FlippedMode | "normal") {
  const res = await app.inject({
    method: "PUT",
    url: "/v1/execution/mode",
    headers: AUTH,
    payload: {
      mode,
      reason: `barrier matrix ${mode}`,
      ...(mode === "require_approval" ? { approverUserId: anaId } : {}),
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/**
 * ONE CELL. Drive the route to the barrier for `operation`, flip the dial to
 * `mode` while it waits there, resume — and the counting fake must not move.
 * A drive that finishes without ever reaching the barrier fails by name
 * instead of hanging.
 */
async function refusedAtBarrier(operation: ExternalWriteOperation, mode: FlippedMode, drive: () => Promise<Injected>): Promise<Injected> {
  const before = probe.count(operation);
  const enteredBefore = probe.entries(operation);
  const gate = probe.arm(operation);
  const inflight = drive();
  const outcome = await Promise.race([
    gate.reached.then(() => "reached" as const),
    inflight.then(() => "finished" as const, () => "finished" as const),
  ]);
  if (outcome !== "reached") {
    probe.disarm();
    const res = await inflight;
    if (probe.count(operation) > before && probe.entries(operation) === enteredBefore) {
      // The provider WAS called, but never through the gated wrapper: the calling module is bound to the REAL
      // external-effects.js. Vitest serves the original module to every import made while a mock factory is still
      // evaluating (its importOriginal), so any static import chain from external-effects.ts that reaches a caller
      // (workflows.ts, pm.ts, infra.ts) silently unmocks the barrier for that caller. It happened once: D4's
      // external-effects → execution-posture → org-settings → rule-writes → config-versions → agent-evidence-hold →
      // incidents → use-cases → workflows → orchestration → pm, broken by a lazy import in agent-evidence-hold.ts.
      throw new Error(
        `${operation}: the provider was called but the gated runExternalWrite never ran — the caller bound the real ` +
          `external-effects.js, not this file's mock. Look for a static import path from external-effects.ts to the ` +
          `caller and make one edge on it lazy. (${res.statusCode} ${res.body.slice(0, 120)})`,
      );
    }
    throw new Error(`${operation}: the drive finished (${res.statusCode} ${res.body.slice(0, 200)}) without reaching the barrier`);
  }
  // the route has done ALL its preparation under 'normal' and is one re-read
  // away from the provider: flip the dial in exactly that window
  await setMode(mode);
  gate.release();
  const res = await inflight;
  await setMode("normal");
  expect(probe.count(operation), `${operation} under '${mode}': the provider was called`).toBe(before);
  mark(operation, mode);
  return res;
}

/** the row's POSITIVE CONTROL: the same drive under 'normal' reaches the fake */
async function admitted(operation: ExternalWriteOperation, drive: () => Promise<Injected>, calls = 1): Promise<Injected> {
  const before = probe.count(operation);
  const res = await drive();
  expect(probe.count(operation), `${operation} under 'normal': the provider was not reached`).toBe(before + calls);
  mark(operation, "normal");
  return res;
}

// --- workflow helpers --------------------------------------------------------

async function view(id: string) {
  const res = await get(`/v1/workflows/instances/${id}`, piaAuth);
  expect(res.statusCode).toBe(200);
  return res.json().instance;
}
async function pendingApproval(instanceId: string, stageId: string) {
  const res = await get(`/v1/workflows/instances/${instanceId}`, anaAuth);
  expect(res.statusCode).toBe(200);
  const a = (res.json().pendingApprovals ?? []).find((p: { stageId: string }) => p.stageId === stageId);
  expect(a, `no pending approval for ${stageId}`).toBeTruthy();
  return a.id as string;
}
const decide = (approvalId: string, auth = anaAuth) =>
  post(`/v1/approvals/${approvalId}/decide`, { decision: "approved" }, auth);
const advance = (instanceId: string, stageId: string) =>
  post(`/v1/workflows/instances/${instanceId}/advance`, { stageId }, piaAuth);

async function registerTemplate(name: string, changeType: string, stages: object[]) {
  const tpl = await post("/v1/workflows/templates", { name, definition: { workflow: name, stages } });
  expect(tpl.statusCode, tpl.body).toBe(201);
  const rule = await post("/v1/workflows/assignment-rules", { templateId: tpl.json().id, changeType });
  expect(rule.statusCode, rule.body).toBe(201);
}
async function start(changeType: string) {
  const res = await post(
    "/v1/workflows/instances",
    { change: { description: `barrier ${changeType}`, paths: ["src/x.ts"], changeType, environment: `bm-env-${RUN}` } },
    piaAuth,
  );
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
/** park the instance at the stage after `gate` WITHOUT executing it: a gate
 * approval under 'halted' is an ordinary refusal, leaving the stage retryable */
async function parkAfterGate(instanceId: string) {
  await setMode("halted");
  try {
    expect((await decide(await pendingApproval(instanceId, "gate"))).statusCode).toBe(200);
  } finally {
    await setMode("normal");
  }
  expect((await view(instanceId)).status).toBe("awaiting_execution");
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  const pia = await makeUser(`bm-pia-${RUN}@example.com`);
  piaId = pia.id;
  piaAuth = pia.auth;
  const ana = await makeUser(`bm-ana-${RUN}@example.com`);
  anaId = ana.id;
  anaAuth = ana.auth;
  const agent = await post("/v1/agents", {
    name: `bm-worker-${RUN}`, provider: "mock", tier: 0, modes: ["execute"], costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-bm",
  });
  expect(agent.statusCode, agent.body).toBe(201);
  workerAgentId = agent.json().id;
  expect((await post("/v1/grants/agents", { userId: piaId, agentId: workerAgentId })).statusCode).toBeLessThan(300);
  await setMode("normal");
});

afterAll(async () => {
  await setMode("normal");
  await app.close();
});

// ---------------------------------------------------------------------------
// the matrix
// ---------------------------------------------------------------------------

describe("AER-018 — the barrier matrix: flip the dial while the route waits one re-read from the provider", () => {
  it("deploy.deploy and deploy.rollback (workflow deployment + rollback stages)", async () => {
    const target = await post("/v1/deploy/targets", { name: `bm-prod-${RUN}`, provider: "mock", environment: "production" });
    expect(target.statusCode, target.body).toBe(201);
    await registerTemplate(`bm-deploy-${RUN}`, `bm-deploy-${RUN}`, [
      { id: "intake", type: "trigger" },
      { id: "gate", type: "human_approval", approvers: [anaId] },
      { id: "deploy", type: "deployment", connection: `bm-prod-${RUN}`, environment: "production" },
      { id: "verify", type: "automated_check", checks: ["smoke"], onFailure: "rollback", rollbackStageId: "undo" },
      { id: "undo", type: "rollback", connection: `bm-prod-${RUN}` },
      { id: "done", type: "human_approval", approvers: [anaId] },
    ]);
    const id = await start(`bm-deploy-${RUN}`);
    // a failing smoke check, pre-reported, routes the verify stage into the rollback
    expect((await post(`/v1/workflows/instances/${id}/checks`, { round: 0, stageId: "verify", results: [{ check: "smoke", status: "failed", severity: "critical" }] }, piaAuth)).statusCode).toBeLessThan(300);
    await parkAfterGate(id);

    for (const mode of MODES) {
      await refusedAtBarrier("deploy.deploy", mode, () => advance(id, "deploy"));
      const inst = await view(id);
      expect(inst.status).toBe("awaiting_execution");
      expect(inst.context["deploy:deploy"]).toBeUndefined();
      expect(inst.context.lastError).toContain(`execution mode is '${mode}'`);
    }
    // positive for the deploy, with the ROLLBACK's gate armed: the deploy runs,
    // the failed verify routes to the rollback, which pauses at its own barrier
    const deploysBefore = probe.count("deploy.deploy");
    await refusedAtBarrier("deploy.rollback", "halted", () => advance(id, "deploy"));
    expect(probe.count("deploy.deploy")).toBe(deploysBefore + 1);
    mark("deploy.deploy", "normal");
    let inst = await view(id);
    expect(inst.context["deploy:deploy"]).toBeDefined();
    expect(inst.context["rollback:undo"]).toBeUndefined();
    expect(inst.status).toBe("awaiting_execution");
    for (const mode of ["read_only", "require_approval"] as const) {
      await refusedAtBarrier("deploy.rollback", mode, () => advance(id, "undo"));
      inst = await view(id);
      expect(inst.context["rollback:undo"]).toBeUndefined();
      expect(inst.context.lastError).toContain(`execution mode is '${mode}'`);
    }
    await admitted("deploy.rollback", () => advance(id, "undo"));
    inst = await view(id);
    expect(inst.status).toBe("rolled_back");
    expect(inst.context["rollback:undo"]).toMatchObject({ reverted: inst.context["deploy:deploy"].deployId });
  });

  it("git.create_branch, git.open_pull_request, git.merge_pull_request (git_operation stages)", async () => {
    const conn = await post("/v1/git/connections", { name: `bm-git-${RUN}`, provider: "mock", token: "not-a-real-token" });
    expect(conn.statusCode, conn.body).toBe(201);
    const repo = `bm-${RUN}/app`;
    await registerTemplate(`bm-git-${RUN}`, `bm-git-${RUN}`, [
      { id: "intake", type: "trigger" },
      { id: "gate", type: "human_approval", approvers: [anaId] },
      { id: "branch", type: "git_operation", action: "create_branch", connection: `bm-git-${RUN}`, repo },
      { id: "open_pr", type: "git_operation", action: "open_pr", connection: `bm-git-${RUN}`, repo },
      { id: "merge_gate", type: "human_approval", approvers: [anaId] },
      { id: "merge", type: "git_operation", action: "merge", connection: `bm-git-${RUN}`, repo, strategy: "squash" },
    ]);
    const id = await start(`bm-git-${RUN}`);
    await parkAfterGate(id);

    for (const mode of MODES) {
      await refusedAtBarrier("git.create_branch", mode, () => advance(id, "branch"));
      const inst = await view(id);
      expect(inst.context.branch).toBeUndefined();
      expect(inst.context.lastError).toContain(`execution mode is '${mode}'`);
    }
    // positive for the branch, with open_pr's gate armed: the cascade creates
    // the branch and pauses at the PR's barrier
    const branchesBefore = probe.count("git.create_branch");
    await refusedAtBarrier("git.open_pull_request", "halted", () => advance(id, "branch"));
    expect(probe.count("git.create_branch")).toBe(branchesBefore + 1);
    mark("git.create_branch", "normal");
    let inst = await view(id);
    expect(inst.context.branch).toBe(`regulait/${id.slice(0, 8)}`);
    expect(inst.context.prId).toBeUndefined();
    for (const mode of ["read_only", "require_approval"] as const) {
      await refusedAtBarrier("git.open_pull_request", mode, () => advance(id, "open_pr"));
      inst = await view(id);
      expect(inst.context.prId).toBeUndefined();
      expect(inst.context.lastError).toContain(`execution mode is '${mode}'`);
    }
    await admitted("git.open_pull_request", () => advance(id, "open_pr"));
    inst = await view(id);
    expect(inst.context.prId).toBe("1");
    expect(inst.status).toBe("blocked_on_approval");

    // the merge: the gate's approval is the drive that reaches the barrier
    const mergeGate = await pendingApproval(id, "merge_gate");
    const approved = await refusedAtBarrier("git.merge_pull_request", "halted", () => decide(mergeGate));
    expect(approved.statusCode).toBe(200);
    inst = await view(id);
    expect(inst.context.mergeSha).toBeUndefined();
    expect(inst.status).toBe("awaiting_execution");
    for (const mode of ["read_only", "require_approval"] as const) {
      await refusedAtBarrier("git.merge_pull_request", mode, () => advance(id, "merge"));
      inst = await view(id);
      expect(inst.context.mergeSha).toBeUndefined();
      expect(inst.context.lastError).toContain(`execution mode is '${mode}'`);
    }
    await admitted("git.merge_pull_request", () => advance(id, "merge"));
    inst = await view(id);
    expect(inst.status).toBe("completed");
    expect(inst.context.mergeSha).toBe("sha-merge-1");
  });

  it("infra.remediate — the approval-decision site, the scan auto-remediation site and the cert_rotate action-decision site", async () => {
    // (a) a proposed remediation approved by a human, inside the decide transaction
    const cp = await post("/v1/infra/resources", { name: `bm-control-plane-${RUN}`, kind: "control_plane" });
    expect(cp.statusCode, cp.body).toBe(201);
    const cpId = cp.json().id as string;
    const scanned = await post("/v1/infra/scan", { resourceId: cpId });
    expect(scanned.statusCode, scanned.body).toBe(200);
    const findingsOf = async (resourceId: string) =>
      ((await get("/v1/infra/findings")).json().findings as Array<{ id: string; resourceId: string; kind: string; status: string }>)
        .filter((f) => f.resourceId === resourceId);
    const drift = (await findingsOf(cpId)).find((f) => f.kind === "drift");
    expect(drift?.status).toBe("open");
    const proposed = await post(`/v1/infra/findings/${drift!.id}/remediate`, { approverUserId: anaId });
    expect(proposed.statusCode, proposed.body).toBe(202);
    const approvalId = proposed.json().approvalId as string;
    for (const mode of MODES) {
      const res = await refusedAtBarrier("infra.remediate", mode, () => decide(approvalId));
      expect(res.statusCode, res.body).toBe(409);
      expect((await findingsOf(cpId)).find((f) => f.id === drift!.id)?.status).toBe("remediation_proposed");
    }
    const ok = await admitted("infra.remediate", () => decide(approvalId));
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await findingsOf(cpId)).find((f) => f.id === drift!.id)?.status).toBe("remediated");

    // (b) governed automation: a policy ceiling that auto-remediates the low drift during the scan
    const rt = await post("/v1/infra/resources", { name: `bm-runtime-${RUN}`, kind: "agent_runtime" });
    expect(rt.statusCode, rt.body).toBe(201);
    const rtId = rt.json().id as string;
    expect((await post("/v1/infra/policies", { resourceId: rtId, autoRemediateMaxSeverity: "low" })).statusCode).toBe(201);
    for (const mode of MODES) {
      const res = await refusedAtBarrier("infra.remediate", mode, () => post("/v1/infra/scan", { resourceId: rtId }));
      expect(res.statusCode, res.body).toBe(409);
      expect((await findingsOf(rtId))[0]?.status).toBe("open");
    }
    const resumed = await admitted("infra.remediate", () => post("/v1/infra/scan", { resourceId: rtId }));
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json().autoRemediated).toBe(1);

    // (c) the THIRD site: an operator verb (cert_rotate) approved through the
    // ADR-0017 action-decision hook inside the decide transaction
    const certRes = await post("/v1/infra/resources", { name: `bm-cert-${RUN}`, kind: "cert", config: { daysUntilExpiry: 7 } });
    expect(certRes.statusCode, certRes.body).toBe(201);
    expect((await post("/v1/infra/scan", { resourceId: certRes.json().id })).statusCode).toBe(200);
    const certOf = async () =>
      ((await get("/v1/infra/certs")).json().certs as Array<{ id: string; resourceName: string; status: string; serial: string | null }>)
        .find((c) => c.resourceName === `bm-cert-${RUN}`)!;
    const certId = (await certOf()).id;
    const rotationsOf = async () =>
      (await get(`/v1/infra/certs/${certId}/rotations`)).json().rotations as Array<{ approvalId: string | null; status: string; reason: string | null }>;
    const proposeRotation = async () => {
      const r = await post(`/v1/infra/certs/${certId}/rotate`, { approverUserId: anaId });
      expect(r.statusCode, r.body).toBe(202);
      return r.json().approvalId as string;
    };
    const originalSerial = (await certOf()).serial;
    for (const mode of MODES) {
      const approval = await proposeRotation();
      const res = await refusedAtBarrier("infra.remediate", mode, () => decide(approval));
      // UNLIKE (a): the O6 contract keeps a cert_rotate provider throw inside
      // the decide (a recorded terminal state, not an aborted transaction), so
      // the barrier's refusal lands as a FAILED attempt — decided, re-proposable,
      // the refusal named as the reason, and the cert untouched at the provider
      expect(res.statusCode, res.body).toBe(200);
      const cert = await certOf();
      expect(cert.status).toBe("rotation_failed");
      expect(cert.serial).toBe(originalSerial);
      const attempt = (await rotationsOf()).find((r) => r.approvalId === approval);
      expect(attempt?.status).toBe("failed");
      expect(attempt?.reason).toContain(`refused while execution mode is '${mode}'`);
    }
    const rotateApproval = await proposeRotation();
    const rotated = await admitted("infra.remediate", () => decide(rotateApproval));
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect((await certOf()).status).toBe("rotated");
    expect((await certOf()).serial).not.toBe(originalSerial);
    expect((await rotationsOf()).find((r) => r.approvalId === rotateApproval)?.status).toBe("rotated");
  });

  it("pm.create_work_item, pm.update_fields, pm.transition_state, pm.add_comment (sync, repair, status mirror, decision mirror)", async () => {
    const project = `BM-${RUN.toUpperCase()}`;
    expect((await post("/v1/pm/connections", { name: `bm-pm-${RUN}`, provider: "mock", project, token: "not-a-real-token" })).statusCode).toBe(201);
    const node = (id: string, extra: Record<string, unknown> = {}) =>
      ({ id, title: `task ${id}`, ownerAgentId: workerAgentId, mode: "execute", estimate: { in: 10, out: 20 }, ...extra });
    const created = await post(
      "/v1/runs",
      { graph: { run: `bm-run-${RUN}`, escalationApproverUserId: anaId, nodes: [node("api"), node("docs", { dependsOn: ["api"] })] } },
      piaAuth,
    );
    expect(created.statusCode, created.body).toBe(201);
    const runId = created.json().id as string;
    const sync = () => post(`/v1/runs/${runId}/pm-sync`, { connectionName: `bm-pm-${RUN}` }, piaAuth);
    const links = async () => (await get(`/v1/pm/links?runId=${runId}`, piaAuth)).json().links as Array<{ objectType: string; externalId: string }>;

    // create: the first sync mints the run parent and one item per node
    for (const mode of MODES) {
      const res = await refusedAtBarrier("pm.create_work_item", mode, sync);
      expect(res.statusCode, res.body).toBe(409);
      expect(await links()).toHaveLength(0);
    }
    const synced = await admitted("pm.create_work_item", sync, 3);
    expect(synced.statusCode, synced.body).toBe(201);
    expect(synced.json().created).toHaveLength(2);
    const parent = (await links()).find((l) => l.objectType === "run");
    expect(parent).toBeTruthy();

    // update: the run parent vanishes at the provider (not tombstoned), so the
    // next honest sync repairs it in place with updateFields
    const store = resolvePmProvider({ provider: "mock", token: "" }) as unknown as MockPmProvider;
    expect(store.projects.get(project)?.delete(parent!.externalId)).toBe(true);
    for (const mode of MODES) {
      const res = await refusedAtBarrier("pm.update_fields", mode, sync);
      expect(res.statusCode, res.body).toBe(409);
      expect(store.projects.get(project)?.has(parent!.externalId)).toBe(false);
    }
    const repaired = await admitted("pm.update_fields", sync);
    expect(repaired.statusCode, repaired.body).toBe(201);
    expect(repaired.json().repaired).toEqual([{ nodeId: null, externalId: parent!.externalId }]);

    // transition: every node status change mirrors outbound; the event itself
    // still applies, the mirror's refusal is surfaced, never swallowed
    const ev = (payload: Record<string, unknown>) => post(`/v1/runs/${runId}/events`, payload, piaAuth);
    expect((await ev({ kind: "start" })).statusCode).toBe(200);
    const steps: Array<[FlippedMode, Record<string, unknown>]> = [
      ["halted", { kind: "node_started", nodeId: "api" }],
      ["read_only", { kind: "node_submitted", nodeId: "api" }],
      ["require_approval", { kind: "node_accepted", nodeId: "api" }],
    ];
    for (const [mode, event] of steps) {
      const res = await refusedAtBarrier("pm.transition_state", mode, () => ev(event));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().pmSync).toMatchObject({ ok: false });
      expect(String(res.json().pmSync.error)).toContain(`execution mode is '${mode}'`);
    }
    const mirrored = await admitted("pm.transition_state", () => ev({ kind: "node_started", nodeId: "docs" }));
    expect(mirrored.statusCode, mirrored.body).toBe(200);
    expect(mirrored.json().pmSync).toEqual({ ok: true, state: "Doing" });

    // comment: a decision on the run mirrors as a comment on the parent item
    const decision = (label: string) =>
      post("/v1/decisions", { objectType: "run", objectId: runId, decision: `barrier ${label}` }, piaAuth);
    for (const mode of MODES) {
      const res = await refusedAtBarrier("pm.add_comment", mode, () => decision(mode));
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().pmMirror).toMatchObject({ ok: false });
      expect(String(res.json().pmMirror.error)).toContain(`execution mode is '${mode}'`);
    }
    const commented = await admitted("pm.add_comment", () => decision("normal"));
    expect(commented.statusCode, commented.body).toBe(201);
    expect(commented.json().pmMirror).toEqual({ ok: true, action: "comment" });
  });

  it("covered every classified operation under every mode, plus its positive control", () => {
    const expected = [...MODES, "normal"].sort();
    for (const operation of EXTERNAL_WRITE_OPERATIONS) {
      expect([...(covered.get(operation) ?? [])].sort(), `matrix row missing for ${operation}`).toEqual(expected);
    }
    expect([...covered.keys()].sort()).toEqual([...EXTERNAL_WRITE_OPERATIONS].sort());
  });
});
