import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { transition, WorkflowStateError, type InstanceState, type WorkflowDefinition } from "@regulait/workflow-kernel";
import { CHECK_AUTO_PASSED_DETAIL, CHECK_PENDING_DETAIL, OFFLINE_CHECKS_ENV, offlineAutoPassRefusal } from "./workflows.js";

/**
 * PILLAR 2 — automated checks that actually FAIL and route. Before this slice
 * every named check auto-passed; now a REPORTED failing result parks the
 * instance at `blocked_on_check` instead of advancing, and a recheck (after the
 * failing checks are remediated and fresh passing results reported) resumes the
 * pipeline. This is the failure path the deploy/rollback stages build on.
 *
 * AER-047 / PENDING L1: a check with NO reported result is PENDING, never
 * passed — the instance waits at awaiting_execution until a result is posted,
 * with an audit row naming the missing checks. Only a template that sets the
 * typed stage field `offlineAutoPass: true` gets the old offline auto-pass,
 * and every such result is labelled (`autoPassed: true`, "auto-passed — no
 * report (offline mode)", its own audit row). The opt-in FAILS CLOSED: it is
 * honoured only in a process that declares REGULAIT_OFFLINE_CHECKS=1, and
 * never on a box that shows a sign of being deployed. A re-opened workflow
 * (artifact resubmitted) discards the previous round's check results.
 *
 * Driven through public endpoints only. An approval gate sits before the check
 * so the test can pre-report results while parked, then observe the check
 * evaluate on approval. Shares one DB with the other suites (fileParallelism
 * off); everything is prefixed wc-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "wc-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let piaAuth: { authorization: string };
let piaId: string;
let anaId: string;
let anaAuth: { authorization: string };
let templateId: string;
let ciAuth: { authorization: string };

// AER-047: the env vars the opt-in reads, saved so every test starts from the
// FAIL-CLOSED default (none of them set) and leaves the process as it found it
const OPT_IN_ENV = [OFFLINE_CHECKS_ENV, "REGULAIT_DEPLOY_MODE", "REGULAIT_HSTS"] as const;
// — and cleared up front, because the demo terminal (DEMO_SCRIPT §0) exports
// REGULAIT_OFFLINE_CHECKS=1 and a suite run from that shell must still see the default
const savedEnv = Object.fromEntries(OPT_IN_ENV.map((k) => [k, process.env[k]]));
for (const k of OPT_IN_ENV) delete process.env[k];
async function withEnv<T>(vars: Partial<Record<(typeof OPT_IN_ENV)[number], string>>, fn: () => Promise<T>): Promise<T> {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) delete process.env[k];
  }
}
afterAll(() => {
  for (const k of OPT_IN_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function makeUser(email: string) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  expect(user.statusCode).toBe(201);
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${user.json().id}/keys`,
    payload: { name: "test" },
  });
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

async function instanceView(auth: { authorization: string }, id: string) {
  const res = await app.inject({ method: "GET", headers: auth, url: `/v1/workflows/instances/${id}` });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function pendingFor(auth: { authorization: string }, instanceId: string, stageId: string) {
  const q = await app.inject({ method: "GET", headers: auth, url: "/v1/approvals?status=pending" });
  return (q.json().approvals ?? []).find(
    (a: { instanceId: string; stageId: string }) => a.instanceId === instanceId && a.stageId === stageId,
  );
}

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  for (const k of OPT_IN_ENV) delete process.env[k];
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });

  const pia = await makeUser("wc-pia@example.com");
  piaId = pia.id;
  piaAuth = pia.auth;
  const ana = await makeUser("wc-ana@example.com");
  anaId = ana.id;
  anaAuth = ana.auth;

  // an arm's-length ADMIN standing in for a CI system: it reports results
  // without the ADR-0167 self-report reason the initiator would need
  const ci = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "wc-ci-bot@example.com", displayName: "wc ci bot", isAdmin: true },
  });
  expect(ci.statusCode).toBe(201);
  const ciKey = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${ci.json().id}/keys`,
    payload: { name: "ci" },
  });
  ciAuth = { authorization: `Bearer ${ciKey.json().token}` };

  // the SAME shape with the explicit AER-047 opt-in
  const offline = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: {
      name: "wc-check-offline",
      definition: {
        workflow: "wc-check-offline",
        stages: [
          { id: "intake", type: "trigger" },
          { id: "gate", type: "human_approval", approvers: [anaId] },
          {
            id: "checks",
            type: "automated_check",
            checks: ["unit_tests", "lint", "security_scan"],
            offlineAutoPass: true,
          },
          { id: "done", type: "human_approval", approvers: [anaId] },
        ],
      },
    },
  });
  expect(offline.statusCode).toBe(201);
  expect(offline.json().definition.stages[2].offlineAutoPass).toBe(true);
  const offlineRule = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/assignment-rules",
    payload: { templateId: offline.json().id, changeType: "wc-offline" },
  });
  expect(offlineRule.statusCode).toBe(201);

  // a check stage DOWNSTREAM of an artifact, so a resubmitted artifact
  // re-opens the flow and the check stage runs a second round
  const reopen = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: {
      name: "wc-check-reopen",
      definition: {
        workflow: "wc-check-reopen",
        stages: [
          { id: "intake", type: "trigger" },
          { id: "req", type: "artifact_generation", output: "requirements_file" },
          { id: "gate", type: "human_approval", approvers: [anaId] },
          { id: "checks", type: "automated_check", checks: ["unit_tests"] },
          { id: "done", type: "human_approval", approvers: [anaId] },
        ],
      },
    },
  });
  expect(reopen.statusCode).toBe(201);
  const reopenRule = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/assignment-rules",
    payload: { templateId: reopen.json().id, changeType: "wc-reopen" },
  });
  expect(reopenRule.statusCode).toBe(201);

  const tpl = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: {
      name: "wc-check-flow",
      definition: {
        workflow: "wc-check-flow",
        stages: [
          { id: "intake", type: "trigger" },
          { id: "gate", type: "human_approval", approvers: [anaId] },
          { id: "checks", type: "automated_check", checks: ["unit_tests", "lint", "security_scan"] },
          { id: "done", type: "human_approval", approvers: [anaId] },
        ],
      },
    },
  });
  expect(tpl.statusCode).toBe(201);
  templateId = tpl.json().id;

  const rule = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/assignment-rules",
    payload: { templateId, changeType: "wc-change" },
  });
  expect(rule.statusCode).toBe(201);
});

async function startInstance(changeType = "wc-change") {
  const started = await app.inject({
    method: "POST",
    headers: piaAuth,
    url: "/v1/workflows/instances",
    payload: { change: { description: "wc change", paths: ["src/x.ts"], changeType, environment: "staging" } },
  });
  expect(started.statusCode).toBe(201);
  return started.json().id as string;
}

async function approve(instanceId: string, stageId: string) {
  const a = await pendingFor(anaAuth, instanceId, stageId);
  expect(a).toBeTruthy();
  const res = await app.inject({
    method: "POST",
    headers: anaAuth,
    url: `/v1/approvals/${a.id}/decide`,
    payload: { decision: "approved" },
  });
  expect(res.statusCode).toBe(200);
}

describe("automated checks: fail → block → remediate → recheck → advance", () => {
  it("a reported FAILING check parks the instance at blocked_on_check instead of advancing", async () => {
    const instanceId = await startInstance();
    // parks at the first approval gate (trigger auto-completes)
    expect((await instanceView(piaAuth, instanceId)).instance.status).toBe("blocked_on_approval");

    // pre-report a failing check while parked — stored, not yet evaluated.
    // (ADR-0167: pia initiated the change, so her `passed` needs a reason)
    const report = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0,
        stageId: "checks",
        results: [
          { check: "unit_tests", status: "passed" },
          { check: "security_scan", status: "failed", severity: "high", detail: "2 criticals" },
        ],
        reason: "unit suite green in CI run #1",
      },
    });
    expect(report.statusCode).toBe(200);
    // still parked on the approval — reporting did not advance anything
    expect(report.json().status).toBe("blocked_on_approval");

    // approve the gate → the check stage evaluates in the cascade → FAILS
    await approve(instanceId, "gate");
    const view = await instanceView(piaAuth, instanceId);
    expect(view.instance.status).toBe("blocked_on_check");
    const results = view.instance.context["checks:checks"];
    expect(results.find((r: { check: string }) => r.check === "security_scan")).toMatchObject({
      status: "failed",
      severity: "high",
    });
    // AER-047: lint had no report → PENDING, never a silent pass (the reported
    // failure is what parks the stage; a missing report never offsets it)
    expect(results.find((r: { check: string }) => r.check === "lint")).toMatchObject({
      status: "pending",
      detail: CHECK_PENDING_DETAIL,
    });
    expect(results.some((r: { autoPassed?: boolean }) => r.autoPassed)).toBe(false);
    // the failure is in the one audit trail
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)));
    expect(audit.some((a) => a.ruleId === "workflow:check_failed")).toBe(true);
  });

  it("recheck alone (still failing) stays blocked; passing results + recheck advances", async () => {
    const instanceId = await startInstance();
    await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0, stageId: "checks", results: [{ check: "security_scan", status: "failed" }] },
    });
    await approve(instanceId, "gate");
    expect((await instanceView(piaAuth, instanceId)).instance.status).toBe("blocked_on_check");

    // recheck without remediation → still failing → still blocked
    const stillBad = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/recheck`,
      payload: { stageId: "checks" },
    });
    expect(stillBad.json().status).toBe("blocked_on_check");

    // remediate: report the failing check as now passing, then recheck → advances
    // (ADR-0167: the initiator's own green needs a recorded reason)
    const remediated = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0, stageId: "checks", results: [{ check: "security_scan", status: "passed" }], reason: "patched the two criticals" },
    });
    expect(remediated.statusCode).toBe(200);
    const partial = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/recheck`,
      payload: { stageId: "checks" },
    });
    // AER-047: the failure is cleared, but unit_tests and lint were never
    // reported — the stage WAITS instead of advancing on their silence
    expect(partial.json().status).toBe("awaiting_execution");
    expect(
      (partial.json().context["checks:checks"] as Array<{ check: string; status: string }>)
        .filter((r) => r.status === "pending")
        .map((r) => r.check)
        .sort(),
    ).toEqual(["lint", "unit_tests"]);
    // CI reports the rest → the waiting stage re-evaluates on the report itself
    const good = await app.inject({
      method: "POST",
      headers: ciAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0,
        stageId: "checks",
        results: [
          { check: "unit_tests", status: "passed" },
          { check: "lint", status: "passed" },
        ],
      },
    });
    expect(good.statusCode).toBe(200);
    // checks cleared → the instance advances to the final approval gate
    expect(good.json().status).toBe("blocked_on_approval");
  });

  it("ADR-0167 (AUTHZ-06): a self-reported PASS needs a reason, is stamped as self-reported, and is an audit row; an arm's-length reporter is not stamped", async () => {
    const instanceId = await startInstance();
    // the initiator declaring her own check green with no reason: refused
    const bare = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0, stageId: "checks", results: [{ check: "security_scan", status: "passed" }] },
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error).toBe("check_report_reason_required");
    // her own FAILING result needs none — that is the honest direction
    const ownFailure = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0, stageId: "checks", results: [{ check: "lint", status: "failed" }] },
    });
    expect(ownFailure.statusCode).toBe(200);
    // with a reason: accepted, stamped, audited
    const attested = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0,
        stageId: "checks",
        results: [{ check: "security_scan", status: "passed" }],
        reason: "re-ran the scanner after the upgrade; run #77 green",
      },
    });
    expect(attested.statusCode).toBe(200);
    const stored = attested.json().context["reported:checks"] as Array<Record<string, unknown>>;
    expect(stored.find((r) => r.check === "security_scan")).toMatchObject({
      status: "passed",
      selfReported: true,
      reportedByUserId: piaId,
      reason: "re-ran the scanner after the upgrade; run #77 green",
    });
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)));
    const selfRow = audit.find((a) => a.ruleId === "workflow:checks-self-reported" && String(a.reason).includes("run #77"));
    expect(selfRow).toBeTruthy();
    expect(selfRow!.userId).toBe(piaId);

    // an arm's-length ADMIN reporting the same check: no reason needed, no stamp
    const ci = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: `wc-ci-${instanceId.slice(0, 8)}@example.com`, displayName: "wc ci", isAdmin: true },
    });
    expect(ci.statusCode).toBe(201);
    const ciKey = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${ci.json().id}/keys`,
      payload: { name: "ci" },
    });
    const armsLength = await app.inject({
      method: "POST",
      headers: { authorization: `Bearer ${ciKey.json().token}` },
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0, stageId: "checks", results: [{ check: "unit_tests", status: "passed" }] },
    });
    expect(armsLength.statusCode).toBe(200);
    const after = armsLength.json().context["reported:checks"] as Array<Record<string, unknown>>;
    expect(after.find((r) => r.check === "unit_tests")).toMatchObject({
      status: "passed",
      selfReported: false,
      reportedByUserId: ci.json().id,
    });

    // and once the stage evaluates, the stamp rides into the result the rail shows
    await approve(instanceId, "gate");
    const view = await instanceView(piaAuth, instanceId);
    const evaluated = view.instance.context["checks:checks"] as Array<Record<string, unknown>>;
    expect(evaluated.find((r) => r.check === "security_scan")).toMatchObject({ status: "passed", selfReported: true });
    expect(evaluated.find((r) => r.check === "unit_tests")?.selfReported).toBeUndefined();
  });

  it("AER-047: with NO reported results a check stage stays PENDING — it waits, names the missing checks in an audit row, and never advances", async () => {
    const instanceId = await startInstance();
    await approve(instanceId, "gate");
    const view = await instanceView(piaAuth, instanceId);
    // the instance WAITS on the check stage — it did not reach the final gate
    expect(view.instance.status).toBe("awaiting_execution");
    expect(view.instance.state.currentStageIndex).toBe(2);
    const results = view.instance.context["checks:checks"] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.status).toBe("pending");
      expect(r.detail).toBe(CHECK_PENDING_DETAIL);
      expect(r.autoPassed).toBeUndefined();
    }
    // the claim is released, so a later report can evaluate the stage
    expect(view.instance.context.executing).toBeUndefined();
    expect(await pendingFor(anaAuth, instanceId, "done")).toBeUndefined();
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)));
    const waiting = audit.filter((a) => a.ruleId === "workflow:checks-awaiting-report");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.detail).toMatchObject({
      stageId: "checks",
      missingChecks: ["unit_tests", "lint", "security_scan"],
    });
    expect(String(waiting[0]!.reason)).toContain("unit_tests, lint, security_scan");
    // and nothing was recorded as passed or auto-passed
    expect(audit.some((a) => a.ruleId === "workflow:checks-auto-passed")).toBe(false);
    expect(audit.some((a) => a.ruleId === "workflow:execution_succeeded")).toBe(false);

    // a retried executor (an operator's /advance after a timeout or a lost CI
    // callback) re-evaluates and STILL does not advance on silence
    const retried = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "checks" },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().status).toBe("awaiting_execution");
    expect(retried.json().state.currentStageIndex).toBe(2);
    // ...and the retry, waiting on the SAME missing checks, writes no second
    // waiting row (one row per distinct waiting state, not per re-evaluation)
    const again = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "checks" },
    });
    expect(again.json().status).toBe("awaiting_execution");
    const afterRetries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)));
    expect(afterRetries.filter((a) => a.ruleId === "workflow:checks-awaiting-report")).toHaveLength(1);

    // a human trigger can never wave the named checks through either. The
    // /advance route sends a check stage to the executor (above), so the
    // trigger itself is applied to the kernel against the instance's LIVE
    // definition and state: the kernel refuses it for a named-check stage.
    const live = (await instanceView(piaAuth, instanceId)).instance;
    expect(() =>
      transition(live.definition as WorkflowDefinition, live.state as InstanceState, {
        kind: "human_trigger",
        stageId: "checks",
      }),
    ).toThrow(WorkflowStateError);
    expect(() =>
      transition(live.definition as WorkflowDefinition, live.state as InstanceState, {
        kind: "human_trigger",
        stageId: "checks",
      }),
    ).toThrow(/runs named checks and cannot be human-triggered/);
    // and triggering past it (the next stage) is refused as a state error,
    // leaving the instance exactly where it was
    const skipAhead = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "done" },
    });
    expect(skipAhead.statusCode).toBe(409);
    expect(skipAhead.json()).toMatchObject({
      error: "invalid_workflow_state",
      detail: "instance is not waiting on stage 'done'",
    });
    const still = (await instanceView(piaAuth, instanceId)).instance;
    expect(still.status).toBe("awaiting_execution");
    expect(still.state.currentStageIndex).toBe(2);
  });

  it("AER-047: a PARTIAL report never advances — the still-missing check is named; an explicit pass of the last one advances", async () => {
    const instanceId = await startInstance();
    await approve(instanceId, "gate");
    const partial = await app.inject({
      method: "POST",
      headers: ciAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0,
        stageId: "checks",
        results: [
          { check: "unit_tests", status: "passed" },
          { check: "lint", status: "passed" },
        ],
      },
    });
    expect(partial.statusCode).toBe(200);
    expect(partial.json().status).toBe("awaiting_execution");
    const after = partial.json().context["checks:checks"] as Array<{ check: string; status: string }>;
    expect(after.find((r) => r.check === "security_scan")?.status).toBe("pending");
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)));
    const latest = audit
      .filter((a) => a.ruleId === "workflow:checks-awaiting-report")
      .map((a) => (a.detail as { missingChecks: string[] }).missingChecks);
    expect(latest).toContainEqual(["security_scan"]);

    // EXPLICIT PASS advances
    const last = await app.inject({
      method: "POST",
      headers: ciAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0, stageId: "checks", results: [{ check: "security_scan", status: "passed" }] },
    });
    expect(last.json().status).toBe("blocked_on_approval");
    for (const r of last.json().context["checks:checks"]) {
      expect(r.status).toBe("passed");
      expect(r.autoPassed).toBeUndefined();
    }
    expect(await pendingFor(anaAuth, instanceId, "done")).toBeTruthy();
  });

  it("AER-047: an EXPLICIT FAIL blocks even while the other checks are still unreported", async () => {
    const instanceId = await startInstance();
    await approve(instanceId, "gate");
    expect((await instanceView(piaAuth, instanceId)).instance.status).toBe("awaiting_execution");
    const failed = await app.inject({
      method: "POST",
      headers: ciAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0, stageId: "checks", results: [{ check: "lint", status: "failed", severity: "medium" }] },
    });
    expect(failed.json().status).toBe("blocked_on_check");
    const results = failed.json().context["checks:checks"] as Array<{ check: string; status: string }>;
    expect(results.find((r) => r.check === "lint")?.status).toBe("failed");
    expect(results.filter((r) => r.status === "pending").map((r) => r.check).sort()).toEqual([
      "security_scan",
      "unit_tests",
    ]);
  });

  it("AER-047 opt-in: offlineAutoPass:true passes unreported checks, LABELLED in the result and the audit trail; a reported result is never labelled", async () => {
    const instanceId = await startInstance("wc-offline");
    // the process DECLARES offline mode (the demo seed and the demo's gateway do)
    // CI reports ONE check before the gate opens
    const pre = await app.inject({
      method: "POST",
      headers: ciAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0, stageId: "checks", results: [{ check: "unit_tests", status: "passed" }] },
    });
    expect(pre.statusCode).toBe(200);
    await withEnv({ [OFFLINE_CHECKS_ENV]: "1" }, () => approve(instanceId, "gate"));
    const view = await instanceView(piaAuth, instanceId);
    // the opt-in is the old behaviour: straight through to the final gate
    expect(view.instance.status).toBe("blocked_on_approval");
    const results = view.instance.context["checks:checks"] as Array<Record<string, unknown>>;
    expect(results.find((r) => r.check === "unit_tests")).toMatchObject({ status: "passed" });
    expect(results.find((r) => r.check === "unit_tests")?.autoPassed).toBeUndefined();
    for (const name of ["lint", "security_scan"]) {
      expect(results.find((r) => r.check === name)).toMatchObject({
        status: "passed",
        autoPassed: true,
        detail: CHECK_AUTO_PASSED_DETAIL,
      });
    }
    expect(CHECK_AUTO_PASSED_DETAIL).toBe("auto-passed — no report (offline mode)");
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)));
    const auto = audit.filter((a) => a.ruleId === "workflow:checks-auto-passed");
    expect(auto).toHaveLength(1);
    expect(auto[0]!.detail).toMatchObject({ stageId: "checks", autoPassedChecks: ["lint", "security_scan"] });
    expect(String(auto[0]!.reason)).toContain("auto-passed — no report (offline mode)");
    expect(audit.some((a) => a.ruleId === "workflow:checks-awaiting-report")).toBe(false);
  });

  it("AER-047 opt-in: an explicit FAIL still blocks under offlineAutoPass", async () => {
    const instanceId = await startInstance("wc-offline");
    await app.inject({
      method: "POST",
      headers: ciAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0, stageId: "checks", results: [{ check: "security_scan", status: "failed", severity: "high" }] },
    });
    await withEnv({ [OFFLINE_CHECKS_ENV]: "1" }, () => approve(instanceId, "gate"));
    const view = await instanceView(piaAuth, instanceId);
    expect(view.instance.status).toBe("blocked_on_check");
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)));
    // a failing stage is not described as auto-passed, even if others were unreported
    expect(audit.some((a) => a.ruleId === "workflow:checks-auto-passed")).toBe(false);
  });

  it("AER-047: the offlineAutoPass opt-in FAILS CLOSED — a process that never declared offline mode (no REGULAIT_OFFLINE_CHECKS=1) leaves the checks pending, and the audit row says why", async () => {
    // the shape of a bare `docker compose --profile tls` on a public host:
    // no deploy-mode signal, no HSTS, and no offline declaration either
    const instanceId = await startInstance("wc-offline");
    await approve(instanceId, "gate");
    const view = await instanceView(piaAuth, instanceId);
    expect(view.instance.status).toBe("awaiting_execution");
    for (const r of view.instance.context["checks:checks"]) {
      expect(r.status).toBe("pending");
      expect(r.autoPassed).toBeUndefined();
    }
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)));
    expect(audit.some((a) => a.ruleId === "workflow:checks-auto-passed")).toBe(false);
    const waiting = audit.find((a) => a.ruleId === "workflow:checks-awaiting-report");
    expect(waiting?.detail).toMatchObject({
      offlineAutoPassRefused: true,
      refusedBecause: "this process never declared offline mode (REGULAIT_OFFLINE_CHECKS=1 is not set)",
    });
    expect((waiting?.detail as Record<string, unknown>).deployedSignal).toBeUndefined();
    // only the exact value 1 declares it
    expect(offlineAutoPassRefusal({ [OFFLINE_CHECKS_ENV]: "true" })).not.toBeNull();
    expect(offlineAutoPassRefusal({ [OFFLINE_CHECKS_ENV]: "0" })).not.toBeNull();
    expect(offlineAutoPassRefusal({})).not.toBeNull();
    expect(offlineAutoPassRefusal({ [OFFLINE_CHECKS_ENV]: "1" })).toBeNull();
  });

  for (const [signalEnv, value, expected] of [
    ["REGULAIT_DEPLOY_MODE", "hosted", "REGULAIT_DEPLOY_MODE=hosted"],
    ["REGULAIT_HSTS", "max-age=63072000; includeSubDomains", "REGULAIT_HSTS is set"],
  ] as const) {
    it(`AER-047: on a box that shows a sign of being DEPLOYED (${signalEnv}) the opt-in is ignored even when offline mode is declared — the checks stay pending and the audit row says why`, async () => {
      const instanceId = await startInstance("wc-offline");
      await withEnv({ [OFFLINE_CHECKS_ENV]: "1", [signalEnv]: value }, () => approve(instanceId, "gate"));
      const view = await instanceView(piaAuth, instanceId);
      expect(view.instance.status).toBe("awaiting_execution");
      for (const r of view.instance.context["checks:checks"]) {
        expect(r.status).toBe("pending");
        expect(r.autoPassed).toBeUndefined();
      }
      const audit = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)));
      const waiting = audit.find((a) => a.ruleId === "workflow:checks-awaiting-report");
      expect(waiting?.detail).toMatchObject({
        offlineAutoPassRefused: true,
        deployedSignal: expected,
      });
      expect(String(waiting?.reason)).toContain("ignored because this box is deployed");
    });
  }

  it("AER-047: a RE-OPENED workflow never reuses the previous round's check results — the re-run check stage waits for a report against the new artifact", async () => {
    const instanceId = await startInstance("wc-reopen");
    const submit = async (content: string) => {
      const res = await app.inject({
        method: "POST",
        headers: piaAuth,
        url: `/v1/workflows/instances/${instanceId}/artifacts`,
        payload: { stageId: "req", content },
      });
      expect(res.statusCode).toBe(201);
      return res.json();
    };
    // round 1: requirements v1, CI reports unit_tests green, the gate opens,
    // the check passes on that report and the instance reaches the final gate
    expect((await submit("v1 requirements")).version).toBe(1);
    const ci1 = await app.inject({
      method: "POST",
      headers: ciAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0, stageId: "checks", results: [{ check: "unit_tests", status: "passed", detail: "CI run #1 against v1" }] },
    });
    expect(ci1.statusCode).toBe(200);
    await approve(instanceId, "gate");
    let view = await instanceView(piaAuth, instanceId);
    expect(view.instance.status).toBe("blocked_on_approval");
    expect(view.instance.context["checks:checks"]).toEqual([
      expect.objectContaining({ check: "unit_tests", status: "passed", detail: "CI run #1 against v1" }),
    ]);

    // round 2: the initiator rewrites the requirements → the flow re-opens.
    // v1's report and evaluated result are discarded in the same transaction.
    expect((await submit("v2 requirements — a different change")).version).toBe(2);
    view = await instanceView(piaAuth, instanceId);
    expect(view.instance.context["reported:checks"]).toBeUndefined();
    expect(view.instance.context["checks:checks"]).toBeUndefined();
    let audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)));
    const reopened = audit.filter((a) => a.ruleId === "workflow:artifact_submitted");
    expect(reopened).toHaveLength(2);
    expect(reopened.map((a) => (a.detail as Record<string, unknown>).staleCheckResultsCleared)).toContainEqual(["checks"]);

    // the approver re-signs v2 → the check stage runs again and WAITS: nothing
    // has reported unit_tests against v2, and v1's green does not carry over
    await approve(instanceId, "gate");
    view = await instanceView(piaAuth, instanceId);
    expect(view.instance.status).toBe("awaiting_execution");
    expect(view.instance.context["checks:checks"]).toEqual([
      expect.objectContaining({ check: "unit_tests", status: "pending", detail: CHECK_PENDING_DETAIL }),
    ]);
    expect(await pendingFor(anaAuth, instanceId, "done")).toBeUndefined();
    audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)));
    expect(
      audit.filter((a) => a.ruleId === "workflow:checks-awaiting-report").map((a) => (a.detail as { missingChecks: string[] }).missingChecks),
    ).toEqual([["unit_tests"]]);

    // CI reports against v2 → the stage evaluates on that report and advances
    const ci2 = await app.inject({
      method: "POST",
      headers: ciAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 1, stageId: "checks", results: [{ check: "unit_tests", status: "passed", detail: "CI run #2 against v2" }] },
    });
    expect(ci2.json().status).toBe("blocked_on_approval");
    expect(ci2.json().context["checks:checks"]).toEqual([
      expect.objectContaining({ check: "unit_tests", status: "passed", detail: "CI run #2 against v2" }),
    ]);
    expect(ci2.json().context["awaitingReport:checks"]).toBeUndefined();
  });

  it("rejects a report to a non-check stage and a report naming no declared check", async () => {
    const instanceId = await startInstance();
    const wrongStage = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0, stageId: "gate", results: [{ check: "unit_tests", status: "passed" }] },
    });
    expect(wrongStage.statusCode).toBe(422);
    const unknownCheck = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { round: 0, stageId: "checks", results: [{ check: "not_a_real_check", status: "failed" }] },
    });
    expect(unknownCheck.statusCode).toBe(422);
  });
});

// ADR-0181 (FX2): hand the shared database back strict (M-068)
afterAll(async () => {
  await restoreAdminKeyMfa?.();
});
