import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * PILLAR 2 — automated checks that actually FAIL and route. Before this slice
 * every named check auto-passed; now a REPORTED failing result parks the
 * instance at `blocked_on_check` instead of advancing, and a recheck (after the
 * failing checks are remediated and fresh passing results reported) resumes the
 * pipeline. A check with no reported result still auto-passes (back-compat), so
 * existing templates are unchanged. This is the failure path the deploy/rollback
 * stages build on.
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

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });

  const pia = await makeUser("wc-pia@example.com");
  piaId = pia.id;
  piaAuth = pia.auth;
  const ana = await makeUser("wc-ana@example.com");
  anaId = ana.id;
  anaAuth = ana.auth;

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

async function startInstance() {
  const started = await app.inject({
    method: "POST",
    headers: piaAuth,
    url: "/v1/workflows/instances",
    payload: { change: { description: "wc change", paths: ["src/x.ts"], changeType: "wc-change", environment: "staging" } },
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
      payload: {
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
    // lint had no report → deterministic auto-pass (back-compat)
    expect(results.find((r: { check: string }) => r.check === "lint")).toMatchObject({ status: "passed" });
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
      payload: { stageId: "checks", results: [{ check: "security_scan", status: "failed" }] },
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
      payload: { stageId: "checks", results: [{ check: "security_scan", status: "passed" }], reason: "patched the two criticals" },
    });
    expect(remediated.statusCode).toBe(200);
    const good = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/recheck`,
      payload: { stageId: "checks" },
    });
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
      payload: { stageId: "checks", results: [{ check: "security_scan", status: "passed" }] },
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error).toBe("check_report_reason_required");
    // her own FAILING result needs none — that is the honest direction
    const ownFailure = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { stageId: "checks", results: [{ check: "lint", status: "failed" }] },
    });
    expect(ownFailure.statusCode).toBe(200);
    // with a reason: accepted, stamped, audited
    const attested = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: {
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
      payload: { stageId: "checks", results: [{ check: "unit_tests", status: "passed" }] },
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

  it("with NO reported results a check stage auto-passes (byte-identical to before)", async () => {
    const instanceId = await startInstance();
    await approve(instanceId, "gate");
    // no report was made → all three checks auto-pass → straight to the final gate
    const view = await instanceView(piaAuth, instanceId);
    expect(view.instance.status).toBe("blocked_on_approval");
    for (const r of view.instance.context["checks:checks"]) expect(r.status).toBe("passed");
  });

  it("rejects a report to a non-check stage and a report naming no declared check", async () => {
    const instanceId = await startInstance();
    const wrongStage = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { stageId: "gate", results: [{ check: "unit_tests", status: "passed" }] },
    });
    expect(wrongStage.statusCode).toBe(422);
    const unknownCheck = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/checks`,
      payload: { stageId: "checks", results: [{ check: "not_a_real_check", status: "failed" }] },
    });
    expect(unknownCheck.statusCode).toBe(422);
  });
});
