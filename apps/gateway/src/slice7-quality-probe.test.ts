import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autoGrantCreatedAgentsForTest } from "./testing/agent-own-grants.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, eq, runMigrations, usageEvents, workflowInstances, auditLog, inArray, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

/**
 * SLICE-7 ADVERSARIAL PROBE — quality gates, at the SEAMS the existing suites
 * do not pin.
 *
 * What is deliberately NOT re-tested here (already pinned, by attack, elsewhere):
 *  - the 422 `eval_check_cannot_be_reported` refusal end-to-end through a real
 *    instance -> eval-harness.test.ts §7 ("a human cannot report an eval-bound
 *    check green"), and the machine decision routing through the ONE
 *    check_failed event ("a REGRESSION fails the check and parks the instance");
 *  - ADR-0044/0072 missing judge = missing instrument, never a 0 averaged into
 *    meanScore -> eval-harness.test.ts §6 ("an llm_as_judge case with NO judge
 *    REFUSES the run and writes NOTHING" + "no `no_judge_configured` result row
 *    exists anywhere") and groundedness-eval.test.ts ("a judge-backed metric
 *    REFUSES rather than degrading to a lexical proxy");
 *  - ADR-0055/0068/0072 red-team scoring: an unrun probe is not_run
 *    (redteam-depth.test.ts §4 "an unregistered target is NOT RUN — never
 *    quietly counted as resisted"), a guardrail-BLOCKED attack is a platform
 *    hold and never a defeat (scoring-semantics.test.ts §2), and unknown
 *    failure codes are excluded by the ALLOW-LIST classifier
 *    (scoring-semantics.test.ts §1 "a code no dispatch path emits is NOT a
 *    governance stop, however plausible");
 *  - MRM on the DIRECT invoke path, and sign-off through the ONE approvals
 *    endpoint unblocking it -> mrm.test.ts ("turning enforcement ON refuses the
 *    UNCARDED agent at dispatch with ZERO provider calls" / "the ONE decide
 *    endpoint records the risk acceptance" / "the CARDED, signed-off agent
 *    dispatches while enforcement is on"), plus regulait-llm.test.ts for the
 *    home-trained provider.
 *
 * The residual seams probed here:
 *  1. MRM (ADR-0045) on the ORCHESTRATION worker-dispatch path: pillar 7's
 *     worker loop calls the same executeGovernedDispatch, but no test drove the
 *     gate through /v1/runs/:id/nodes/:id/dispatch. If the gate moved out of
 *     dispatchAttempt into the invoke ROUTE, mrm.test.ts would still pass while
 *     every worker agent dispatched uncarded.
 *  2. MRM on the IDE-interception path (/v1/messages): same reasoning — the
 *     compat shim is its own route with its own error envelope.
 *  3. The recheck path cannot smuggle a human result into an eval-bound check:
 *     while an instance is PARKED at blocked_on_check on a machine-decided
 *     check, the report is still refused, a recheck re-runs the machine
 *     decision, and even a result smuggled straight into instance context
 *     (below the API, simulating a raced/compromised reporter) is shadowed by
 *     the eval outcome at the executor.
 *
 * Shares one DB (fileParallelism off); everything is prefixed s7p-. Both
 * singletons this file flips (org_settings.mrm_enforced, interception
 * anthropicCompatEnabled) are snapshotted in beforeAll and restored in
 * afterAll; every test that flips mrm_enforced also restores it in-test so a
 * mid-file failure cannot leak enforcement into a later describe. MRM-refusal
 * audit rows for this file's agents are deleted in afterAll because
 * mrm.test.ts asserts on the FIRST `mrm-approval-required` row in the table
 * (same discipline as regulait-llm.test.ts).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "s7p-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let runnerId: string;
let runnerAuth: { authorization: string };
let approverId: string;
let approverAuth: { authorization: string };
let agentId: string;
let priorMrmEnforced: boolean | null = null;
let priorAnthropicCompat: boolean | null = null;

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: email.split("@")[0]!.replace("-", " ") },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "s7" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function setMrmEnforcement(enforced: boolean) {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/mrm/enforcement", payload: { enforced },
  });
  expect(r.statusCode).toBe(200);
}

async function usageCountFor(theAgentId: string) {
  return (await db.select().from(usageEvents).where(eq(usageEvents.agentId, theAgentId))).length;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a1".repeat(32) });
  // ADR-0188 S4: agents created here act under the strict `own_grants` default with grants of their own
  autoGrantCreatedAgentsForTest(app, db, { mirrorTools: true });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, requireProjectAttribution: false });

  // snapshot both singletons this file will flip (M-012 discipline)
  const mrmStatus = await app.inject({ method: "GET", headers: AUTH, url: "/v1/mrm/status" });
  priorMrmEnforced = mrmStatus.json().enforced ?? false;
  const posture = await app.inject({ method: "GET", headers: AUTH, url: "/v1/interception/settings" });
  priorAnthropicCompat = posture.json().settings.anthropicCompatEnabled ?? false;

  const runner = await makeUser("s7p-runner@example.com");
  runnerId = runner.id;
  runnerAuth = runner.auth;
  const approver = await makeUser("s7p-approver@example.com");
  approverId = approver.id;
  approverAuth = approver.auth;

  // an UNCARDED agent with a model name unique to this file, so no other
  // suite's model card can accidentally satisfy the gate
  const a = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/agents",
    payload: {
      name: "s7p-worker", provider: "mock", tier: 1, modes: ["execute"],
      costPerMTokIn: 1, costPerMTokOut: 2, model: "s7p-mrm-model",
    },
  });
  expect(a.statusCode).toBe(201);
  agentId = a.json().id;
  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/grants/agents",
    payload: { userId: runnerId, agentId },
  });
});

afterAll(async () => {
  // restore both singletons exactly as found
  if (priorMrmEnforced !== null) await setMrmEnforcement(priorMrmEnforced);
  if (priorAnthropicCompat !== null) {
    await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/interception/settings",
      payload: { anthropicCompatEnabled: priorAnthropicCompat },
    });
  }
  // mrm.test.ts asserts on the FIRST mrm-approval-required row in the whole
  // table — remove the refusal rows this file's agents produced
  await db.delete(auditLog).where(inArray(auditLog.objectId, [agentId]));
  app.server.closeAllConnections();
  await restoreSb2Gates();
  await app.close();
});

// ===========================================================================
// (1) ADR-0045 seam — the MRM gate holds on the ORCHESTRATION worker path
// ===========================================================================

describe("MRM gate on the pillar-7 worker-dispatch path", () => {
  it("an uncarded worker is refused at node dispatch with enforcement ON, and dispatches with it OFF", async () => {
    const created = await app.inject({
      method: "POST", headers: runnerAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "s7p-mrm-run",
          escalationApproverUserId: approverId,
          nodes: [{ id: "n1", title: "s7 mrm probe", ownerAgentId: agentId, mode: "execute" }],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().id as string;
    const ev = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", headers: runnerAuth, url: `/v1/runs/${runId}/events`, payload });
    expect((await ev({ kind: "start" })).statusCode).toBe(200);
    expect((await ev({ kind: "node_started", nodeId: "n1" })).statusCode).toBe(200);

    // CONTROL (non-vacuity): with enforcement off, the same node dispatches
    const baseline = await app.inject({
      method: "POST", headers: runnerAuth, url: `/v1/runs/${runId}/nodes/n1/dispatch`, payload: {},
    });
    expect(baseline.statusCode, JSON.stringify(baseline.json())).toBe(200);

    await setMrmEnforcement(true);
    try {
      const before = await usageCountFor(agentId);
      const refused = await app.inject({
        method: "POST", headers: runnerAuth, url: `/v1/runs/${runId}/nodes/n1/dispatch`, payload: {},
      });
      // If the gate lived only in the invoke ROUTE, this would be 200 and the
      // worker would have dispatched an unreviewed model on the user's behalf.
      expect(refused.statusCode, "MRM must gate the worker-dispatch path, not only direct invoke").toBe(409);
      expect(refused.json().error).toBe("mrm_approval_required");
      // the refusal cost nothing — no usage row for the agent
      expect(await usageCountFor(agentId)).toBe(before);
    } finally {
      await setMrmEnforcement(false);
    }

    // reversible: the same node dispatches again once enforcement is off,
    // proving the 409 above was the gate and not some other regression
    const after = await app.inject({
      method: "POST", headers: runnerAuth, url: `/v1/runs/${runId}/nodes/n1/dispatch`, payload: {},
    });
    expect(after.statusCode).toBe(200);
  });
});

// ===========================================================================
// (2) ADR-0045 seam — the MRM gate holds on the IDE-interception path
// ===========================================================================

describe("MRM gate on the IDE-interception (/v1/messages) path", () => {
  const anthropicBody = {
    model: "s7p-mrm-model",
    max_tokens: 64,
    messages: [{ role: "user", content: "s7 interception probe" }],
  };

  beforeAll(async () => {
    const r = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/interception/settings",
      payload: { anthropicCompatEnabled: true },
    });
    expect(r.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/interception/settings",
      payload: { anthropicCompatEnabled: priorAnthropicCompat ?? false },
    });
  });

  it("an uncarded model is refused through the compat shim with enforcement ON, allowed with it OFF", async () => {
    // CONTROL (non-vacuity): the intercepted call succeeds with the gate off
    const baseline = await app.inject({
      method: "POST", headers: runnerAuth, url: "/v1/messages", payload: anthropicBody,
    });
    expect(baseline.statusCode, JSON.stringify(baseline.json())).toBe(200);

    await setMrmEnforcement(true);
    try {
      const before = await usageCountFor(agentId);
      const refused = await app.inject({
        method: "POST", headers: runnerAuth, url: "/v1/messages", payload: anthropicBody,
      });
      // If the gate lived only in the invoke ROUTE, the IDE side door would
      // dispatch an unreviewed model while /v1/agents/:id/invoke refused it.
      expect(refused.statusCode, "MRM must gate the interception path, not only direct invoke").toBe(409);
      // the RegulAIt code survives the Anthropic error envelope
      expect(refused.json().error.regulait_code).toBe("mrm_approval_required");
      expect(await usageCountFor(agentId)).toBe(before);
    } finally {
      await setMrmEnforcement(false);
    }

    const after = await app.inject({
      method: "POST", headers: runnerAuth, url: "/v1/messages", payload: anthropicBody,
    });
    expect(after.statusCode).toBe(200);
  });
});

// ===========================================================================
// (3) ADR-0044 seam — recheck cannot smuggle a human result into an
//     eval-bound check, even from the blocked state, even below the API
// ===========================================================================

describe("an eval-bound check stays machine-decided through the recheck path", () => {
  let instanceId: string;

  beforeAll(async () => {
    // A template whose eval-bound check FAILS deterministically (the dataset
    // does not exist — eval-harness.test.ts §7 pins that this fails rather
    // than passes), which parks a real instance at blocked_on_check without
    // needing a provider mock or a baseline run.
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "s7p-quality-flow",
        definition: {
          workflow: "s7p-quality-flow",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "gate", type: "human_approval", approvers: [approverId] },
            {
              id: "checks",
              type: "automated_check",
              checks: ["unit_tests", "agent_quality"],
              evals: [{ check: "agent_quality", dataset: "s7p-ghost-dataset", agent: "s7p-worker" }],
            },
            { id: "done", type: "human_approval", approvers: [approverId] },
          ],
        },
      },
    });
    expect(tpl.statusCode).toBe(201);
    const rule = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "s7p-quality" },
    });
    expect(rule.statusCode).toBe(201);

    const started = await app.inject({
      method: "POST", headers: runnerAuth, url: "/v1/workflows/instances",
      payload: {
        change: { description: "s7 change", paths: ["src/s7.ts"], changeType: "s7p-quality", environment: "staging" },
      },
    });
    expect(started.statusCode).toBe(201);
    instanceId = started.json().id;

    const q = await app.inject({ method: "GET", headers: approverAuth, url: "/v1/approvals?status=pending" });
    const a = (q.json().approvals ?? []).find(
      (r: { instanceId: string; stageId: string }) => r.instanceId === instanceId && r.stageId === "gate",
    );
    expect(a).toBeTruthy();
    const decided = await app.inject({
      method: "POST", headers: approverAuth, url: `/v1/approvals/${a.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(decided.statusCode).toBe(200);

    // the machine decision failed (ghost dataset) — parked exactly where a
    // regression would park it
    const view = await app.inject({
      method: "GET", headers: runnerAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    expect(view.json().instance.status).toBe("blocked_on_check");
  });

  it("SMUGGLE A: reporting the eval-bound check green FROM the blocked state is still 422", async () => {
    // eval-harness.test.ts pins this refusal while parked at the FIRST gate;
    // this is the same attack at the moment it actually pays off — the
    // instance is already blocked on the machine decision.
    const res = await app.inject({
      method: "POST", headers: runnerAuth, url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0, stageId: "checks", results: [{ check: "agent_quality", status: "passed" }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("eval_check_cannot_be_reported");
  });

  it("CONTROL: the same request shape for the co-declared NON-eval check is accepted", async () => {
    // proves the 422 above is about the eval binding, not a broken endpoint
    const res = await app.inject({
      method: "POST", headers: runnerAuth, url: `/v1/workflows/instances/${instanceId}/checks`,
      // (ADR-0167: the runner initiated this change, so its own green needs a reason)
      payload: { round: 0, stageId: "checks", results: [{ check: "unit_tests", status: "passed" }], reason: "suite green" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("SMUGGLE B: recheck re-runs the machine decision and stays blocked — the reported pass rescues nothing", async () => {
    const res = await app.inject({
      method: "POST", headers: runnerAuth, url: `/v1/workflows/instances/${instanceId}/recheck`,
      payload: { stageId: "checks" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("blocked_on_check");
    const checks = res.json().context["checks:checks"] as Array<{ check: string; status: string; detail: string }>;
    expect(checks.find((c) => c.check === "agent_quality")).toMatchObject({ status: "failed" });
    // the recheck-advance mechanics themselves are pinned in
    // workflow-checks.test.ts ("passing results + recheck advances"), so this
    // blocked state is the eval outcome, not a recheck that cannot advance.
    expect(checks.find((c) => c.check === "unit_tests")).toMatchObject({ status: "passed" });
  });

  it("SMUGGLE C: a result planted straight into instance context (below the API) is shadowed by the eval outcome", async () => {
    // Simulates a raced or compromised reporter that got a row into
    // context[`reported:checks`] without going through the 422 gate. The
    // executor must prefer the eval outcome (ADR-0044: decided by RUNNING it)
    // over any reported residue.
    const [row] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    const ctx = { ...(row!.context as Record<string, unknown>) };
    const reported = Array.isArray(ctx["reported:checks"]) ? (ctx["reported:checks"] as unknown[]) : [];
    ctx["reported:checks"] = [
      ...reported.filter((r) => (r as { check: string }).check !== "agent_quality"),
      { check: "agent_quality", status: "passed", severity: null, detail: "smuggled" },
    ];
    await db.update(workflowInstances).set({ context: ctx }).where(eq(workflowInstances.id, instanceId));

    const res = await app.inject({
      method: "POST", headers: runnerAuth, url: `/v1/workflows/instances/${instanceId}/recheck`,
      payload: { stageId: "checks" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status, "a smuggled context row must never outrank the machine decision").toBe("blocked_on_check");
    const quality = (res.json().context["checks:checks"] as Array<{ check: string; status: string }>).find(
      (c) => c.check === "agent_quality",
    );
    expect(quality).toMatchObject({ status: "failed" });
  });
});
