import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * PILLAR 2 — the pipeline tail: a governed DEPLOY, a post-deploy VERIFY, and an
 * automatic ROLLBACK. A deploy runs via a governed (mock) deploy target; a
 * verify is an automated_check with onFailure:"rollback" that, on failure,
 * routes straight to the rollback stage and reverses the deployment (terminal
 * `rolled_back`). A verify that PASSES skips the rollback and advances. A deploy
 * whose target is missing (or whose condition is unmet) parks at
 * `blocked_on_deploy` for a manual-handoff override.
 *
 * Driven through public endpoints only, with an approval gate before the deploy
 * so the test controls when the tail cascades. Shares one DB (fileParallelism
 * off); everything is prefixed wd-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "wd-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let piaAuth: { authorization: string };
let anaId: string;
let anaAuth: { authorization: string };

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

async function view(id: string) {
  const res = await app.inject({ method: "GET", headers: piaAuth, url: `/v1/workflows/instances/${id}` });
  expect(res.statusCode).toBe(200);
  return res.json().instance;
}

// instance-scoped pending approvals (not the global, 100-capped /v1/approvals
// list, which other suites crowd out in the shared DB).
async function pendingFor(instanceId: string, stageId: string) {
  const res = await app.inject({ method: "GET", headers: anaAuth, url: `/v1/workflows/instances/${instanceId}` });
  expect(res.statusCode).toBe(200);
  return (res.json().pendingApprovals ?? []).find(
    (a: { stageId: string }) => a.stageId === stageId,
  );
}
async function approveGate(instanceId: string) {
  const a = await pendingFor(instanceId, "gate");
  expect(a).toBeTruthy();
  const res = await app.inject({
    method: "POST",
    headers: anaAuth,
    url: `/v1/approvals/${a.id}/decide`,
    payload: { decision: "approved" },
  });
  expect(res.statusCode).toBe(200);
}

// change-type per test so each start routes to its own template
async function registerTemplate(name: string, changeType: string, deployTarget: string, condition?: object) {
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
          { id: "gate", type: "human_approval", approvers: [anaId] },
          { id: "deploy", type: "deployment", connection: deployTarget, environment: "production", ...(condition ? { condition } : {}) },
          { id: "verify", type: "automated_check", checks: ["smoke"], onFailure: "rollback", rollbackStageId: "undo" },
          { id: "undo", type: "rollback", connection: deployTarget },
          { id: "done", type: "human_approval", approvers: [anaId] },
        ],
      },
    },
  });
  expect(tpl.statusCode).toBe(201);
  const rule = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/assignment-rules",
    payload: { templateId: tpl.json().id, changeType },
  });
  expect(rule.statusCode).toBe(201);
}

// NB: a suite-unique change environment ("wd-env"), never the shared
// "production", so a leftover assignment rule keyed on environment=production
// in another suite (mcp-proxy) can't merge its template into these instances.
async function start(changeType: string, environment = "wd-env") {
  const res = await app.inject({
    method: "POST",
    headers: piaAuth,
    url: "/v1/workflows/instances",
    payload: { change: { description: "wd change", paths: ["src/x.ts"], changeType, environment } },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });
  piaAuth = (await makeUser("wd-pia@example.com")).auth;
  const ana = await makeUser("wd-ana@example.com");
  anaId = ana.id;
  anaAuth = ana.auth;
  // a governed mock deploy target
  const t = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/deploy/targets",
    payload: { name: "wd-prod", provider: "mock", environment: "production" },
  });
  expect(t.statusCode).toBe(201);
});

describe("deploy target CRUD (admin)", () => {
  it("creates, lists (no credential leak), and the target is usable", async () => {
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/deploy/targets" });
    expect(list.statusCode).toBe(200);
    const names = list.json().targets.map((t: { name: string }) => t.name);
    expect(names).toContain("wd-prod");
    // the shape never carries a credential field
    for (const t of list.json().targets) expect(Object.keys(t)).not.toContain("credentialCiphertext");
  });
});

describe("deploy → verify → rollback", () => {
  it("a deployment halted after approval stays unexecuted and retryable", async () => {
    await registerTemplate("wd-halt", "wd-halt-change", "wd-prod");
    const id = await start("wd-halt-change");
    const stopped = await app.inject({
      method: "PUT", url: "/v1/execution/mode", headers: AUTH,
      payload: { mode: "halted", reason: "test final-call deploy stop" },
    });
    expect(stopped.statusCode).toBe(200);
    try {
      await approveGate(id);
      const paused = await view(id);
      expect(paused.status).toBe("awaiting_execution");
      expect(paused.context["deploy:deploy"]).toBeUndefined();
      expect(paused.context.lastError).toContain("execution mode is 'halted'");
    } finally {
      const resumed = await app.inject({
        method: "PUT", url: "/v1/execution/mode", headers: AUTH,
        payload: { mode: "normal", reason: "test final-call deploy resume" },
      });
      expect(resumed.statusCode).toBe(200);
    }
    const retry = await app.inject({
      method: "POST", url: `/v1/workflows/instances/${id}/advance`, headers: piaAuth,
      payload: { stageId: "deploy" },
    });
    expect(retry.statusCode).toBe(200);
    expect((await view(id)).context["deploy:deploy"]).toBeDefined();
  });

  it("a passing post-deploy verify deploys, skips rollback, and advances to the final gate", async () => {
    await registerTemplate("wd-ok", "wd-ok-change", "wd-prod");
    const id = await start("wd-ok-change");
    await approveGate(id);
    // no verify failure reported → deploy succeeds, verify auto-passes, rollback
    // is skipped, and the instance parks at the final approval gate
    const inst = await view(id);
    expect(inst.status).toBe("blocked_on_approval");
    expect(inst.context["deploy:deploy"]).toMatchObject({ target: "wd-prod", environment: "production" });
    expect(inst.context["rollback:undo"]).toBeUndefined();
  });

  it("a FAILED post-deploy verify auto-rolls-back to the terminal rolled_back", async () => {
    await registerTemplate("wd-rb", "wd-rb-change", "wd-prod");
    const id = await start("wd-rb-change");
    // pre-report a failing smoke check for the verify stage
    await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${id}/checks`,
      payload: { stageId: "verify", results: [{ check: "smoke", status: "failed", severity: "critical" }] },
    });
    await approveGate(id);
    const inst = await view(id);
    // deploy ran, verify failed, rollback reversed it — terminal
    expect(inst.status).toBe("rolled_back");
    expect(inst.context["deploy:deploy"]).toBeDefined();
    expect(inst.context["rollback:undo"]).toMatchObject({ reverted: inst.context["deploy:deploy"].deployId });
    // the failure is in the one audit trail
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, id)));
    expect(audit.some((a) => a.ruleId === "workflow:check_failed")).toBe(true);
    expect(audit.some((a) => a.ruleId === "workflow:rolled_back")).toBe(true);
  });

  it("a deploy to a missing target parks at blocked_on_deploy; an override advances", async () => {
    await registerTemplate("wd-miss", "wd-miss-change", "wd-nonexistent");
    const id = await start("wd-miss-change");
    await approveGate(id);
    let inst = await view(id);
    expect(inst.status).toBe("blocked_on_deploy");
    // pia INITIATED this instance, so clearing its own deploy gate is a
    // self-attestation: refused outright until a reason is on the record
    const bare = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${id}/deploy-override`,
      payload: { stageId: "deploy" },
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error).toBe("deploy_override_reason_required");
    expect((await view(id)).status).toBe("blocked_on_deploy"); // nothing moved
    // with the reason recorded it advances
    const ov = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${id}/deploy-override`,
      payload: { stageId: "deploy", reason: "released by hand from the ops runbook; ticket OPS-411" },
    });
    expect(ov.statusCode).toBe(200);
    inst = await view(id);
    // advanced past deploy → verify auto-passes → final gate
    expect(inst.status).toBe("blocked_on_approval");
    // and the trail says who attested, and that it was their own change
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, id)));
    const attested = audit.find((a) => a.ruleId === "workflow:deploy-override-attested");
    expect(attested).toBeTruthy();
    expect((attested!.detail as { selfAttested: boolean }).selfAttested).toBe(true);
    expect(attested!.reason).toContain("OPS-411");
  });

  it("an arm's-length admin clears someone else's parked deploy without a reason", async () => {
    await registerTemplate("wd-adm", "wd-adm-change", "wd-nonexistent2");
    const id = await start("wd-adm-change"); // initiated by pia
    await approveGate(id);
    expect((await view(id)).status).toBe("blocked_on_deploy");
    // an admin who is NOT the initiator — no self-attestation, so the reason
    // stays optional and the one-click operator path is unchanged
    const opsUser = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "wd-ops@example.com", displayName: "WD Ops", isAdmin: true },
    });
    expect(opsUser.statusCode).toBe(201);
    const opsKey = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${opsUser.json().id}/keys`,
      payload: { name: "ops" },
    });
    const ov = await app.inject({
      method: "POST",
      headers: { authorization: `Bearer ${opsKey.json().token}` },
      url: `/v1/workflows/instances/${id}/deploy-override`,
      payload: { stageId: "deploy" },
    });
    expect(ov.statusCode).toBe(200);
    expect((await view(id)).status).toBe("blocked_on_approval");
  });

  it("a deploy whose condition is unmet parks at blocked_on_deploy", async () => {
    await registerTemplate("wd-cond", "wd-cond-change", "wd-prod", { field: "environment", equals: "production" });
    // start with a STAGING change — condition (environment==production) is unmet
    const id = await start("wd-cond-change", "staging");
    await approveGate(id);
    const inst = await view(id);
    expect(inst.status).toBe("blocked_on_deploy");
  });
});
