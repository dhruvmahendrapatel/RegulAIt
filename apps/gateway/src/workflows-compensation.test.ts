import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

/**
 * ADR-0340 — compensation (saga) stages, through the public routes. A cancel (`/abort`) or a denied sign-off runs
 * the compensations of the stages that ran, in reverse order, through the ordinary executors (claim, governance,
 * the external-effect barrier, the audit), and the instance then ends in the status the cancel or denial asked for.
 * Ending a compensation early is an admin's act. Shares one database; everything is prefixed wc- and run-scoped.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = "wc-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let pia: { id: string; auth: { authorization: string } };
let ana: { id: string; auth: { authorization: string } };
let admin: { id: string; auth: { authorization: string } };
let restoreAdminKeyMfa: (() => Promise<void>) | undefined;

const post = (url: string, payload: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });

async function makeUser(name: string, isAdmin = false) {
  const user = await post("/v1/users", { email: `wc-${name}-${RUN}@example.com`, displayName: name, ...(isAdmin ? { isAdmin: true } : {}) });
  expect(user.statusCode, user.body).toBe(201);
  const key = await post(`/v1/users/${user.json().id}/keys`, { name: "wc" });
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

async function view(id: string) {
  const res = await get(`/v1/workflows/instances/${id}`, pia.auth);
  expect(res.statusCode).toBe(200);
  return res.json().instance;
}
async function decideGate(instanceId: string, stageId: string, decision: "approved" | "denied") {
  const res = await get(`/v1/workflows/instances/${instanceId}`, ana.auth);
  const a = (res.json().pendingApprovals ?? []).find((p: { stageId: string }) => p.stageId === stageId);
  expect(a, `no pending approval for ${stageId}`).toBeTruthy();
  const d = await post(`/v1/approvals/${a.id}/decide`, { decision }, ana.auth);
  expect(d.statusCode, d.body).toBe(200);
}
async function registerTemplate(name: string, stages: object[]) {
  const tpl = await post("/v1/workflows/templates", { name, definition: { workflow: name, stages } });
  expect(tpl.statusCode, tpl.body).toBe(201);
  const rule = await post("/v1/workflows/assignment-rules", { templateId: tpl.json().id, changeType: name });
  expect(rule.statusCode, rule.body).toBe(201);
}
async function start(changeType: string) {
  const res = await post(
    "/v1/workflows/instances",
    { change: { description: `wc ${changeType}`, paths: ["src/x.ts"], changeType, environment: `wc-env-${RUN}` } },
    pia.auth,
  );
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
async function auditRules(instanceId: string): Promise<string[]> {
  const rows = await db
    .select({ ruleId: auditLog.ruleId })
    .from(auditLog)
    .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)))
    .orderBy(auditLog.at);
  return rows.map((r) => r.ruleId ?? "");
}

const conn = `wc-git-${RUN}`;
const target = `wc-dt-${RUN}`;
const repo = `wc-${RUN}/app`;
const g = { connection: conn, repo };

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  pia = await makeUser("pia");
  ana = await makeUser("ana");
  admin = await makeUser("admin", true);
  expect((await post("/v1/git/connections", { name: conn, provider: "mock", token: "not-a-real-token" })).statusCode).toBe(201);
  expect((await post("/v1/deploy/targets", { name: target, provider: "mock", environment: "staging" })).statusCode).toBe(201);
});
afterAll(async () => {
  await restoreAdminKeyMfa?.();
  await app.close();
});

describe("ADR-0340 compensation", () => {
  it("a denied sign-off rolls back the deploy, closes the PR and deletes the branch, in that order, then ends denied", async () => {
    const name = `wc-deny-${RUN}`;
    await registerTemplate(name, [
      { id: "intake", type: "trigger" },
      { id: "branch", type: "git_operation", action: "create_branch", ...g },
      { id: "pr", type: "git_operation", action: "open_pr", ...g },
      { id: "deploy", type: "deployment", connection: target, environment: "staging" },
      { id: "release", type: "human_approval", approvers: [ana.id] },
      { id: "undo_branch", type: "git_operation", action: "delete_branch", compensates: "branch", ...g },
      { id: "undo_pr", type: "git_operation", action: "close_pr", compensates: "pr", ...g },
      { id: "undo_deploy", type: "rollback", connection: target, compensates: "deploy" },
    ]);
    const id = await start(name);
    let inst = await view(id);
    expect(inst.status).toBe("blocked_on_approval");
    expect(inst.context["deploy:deploy"]).toBeDefined();
    await decideGate(id, "release", "denied");
    inst = await view(id);
    expect(inst.status).toBe("denied");
    expect(inst.state.compensation).toMatchObject({ cause: "denied", plan: ["undo_deploy", "undo_pr", "undo_branch"], outcome: "completed" });
    expect(inst.context["rollback:undo_deploy"]).toBeDefined();
    expect(inst.context["compensation:undo_pr"]).toMatchObject({ prId: String(inst.context.prId), changed: true });
    expect(inst.context["compensation:undo_branch"]).toMatchObject({ branch: inst.context.branch, changed: true });
    const rules = await auditRules(id);
    const order = ["workflow:approval_denied", "workflow:compensation-started", "external-effect:deploy.rollback", "external-effect:git.close_pull_request", "external-effect:git.delete_branch", "workflow:compensation-completed"];
    const at = order.map((r) => rules.indexOf(r));
    expect(at.every((i) => i >= 0), JSON.stringify(rules)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("a cancel before anything ran ends aborted at once (no compensation)", async () => {
    const name = `wc-early-${RUN}`;
    await registerTemplate(name, [
      { id: "intake", type: "trigger" },
      { id: "gate", type: "human_approval", approvers: [ana.id] },
      { id: "branch", type: "git_operation", action: "create_branch", ...g },
      { id: "undo_branch", type: "git_operation", action: "delete_branch", compensates: "branch", ...g },
    ]);
    const id = await start(name);
    const res = await post(`/v1/workflows/instances/${id}/abort`, {}, pia.auth);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe("aborted");
    expect((await view(id)).state.compensation).toBeUndefined();
    expect(await auditRules(id)).not.toContain("workflow:compensation-started");
  });

  it("a manual compensation waits for a person; only an admin may abandon it, and that is audited", async () => {
    const name = `wc-manual-${RUN}`;
    await registerTemplate(name, [
      { id: "intake", type: "trigger" },
      { id: "branch", type: "git_operation", action: "create_branch", ...g },
      { id: "pr", type: "git_operation", action: "open_pr", ...g },
      { id: "merge", type: "git_operation", action: "merge", ...g },
      { id: "release", type: "human_approval", approvers: [ana.id] },
      { id: "revert_merge", type: "automated_build", compensates: "merge" },
      { id: "undo_branch", type: "git_operation", action: "delete_branch", compensates: "branch", ...g },
    ]);
    const id = await start(name);
    expect((await view(id)).status).toBe("blocked_on_approval");
    const cancelled = await post(`/v1/workflows/instances/${id}/abort`, {}, pia.auth);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    let inst = await view(id);
    expect(inst.status).toBe("awaiting_trigger");
    expect(inst.state.compensation).toMatchObject({ plan: ["undo_branch", "revert_merge"].reverse() });
    // the initiator cannot end the undo early
    const refused = await post(`/v1/workflows/instances/${id}/abort`, {}, pia.auth);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("compensation_abandon_requires_admin");
    expect(await auditRules(id)).toContain("workflow:compensation-abandon-refused");
    // a person completes the manual revert; the branch delete then runs on the same request
    const done = await post(`/v1/workflows/instances/${id}/advance`, { stageId: "revert_merge" }, pia.auth);
    expect(done.statusCode, done.body).toBe(200);
    inst = await view(id);
    expect(inst.status).toBe("aborted");
    expect(inst.context["compensation:undo_branch"]).toMatchObject({ changed: true });

    // a second run: the admin abandons the rest, which is a deny row naming what never ran
    const id2 = await start(name);
    expect((await post(`/v1/workflows/instances/${id2}/abort`, {}, pia.auth)).statusCode).toBe(200);
    const abandoned = await post(`/v1/workflows/instances/${id2}/abort`, {}, admin.auth);
    expect(abandoned.statusCode, abandoned.body).toBe(200);
    inst = await view(id2);
    expect(inst.status).toBe("aborted");
    expect(inst.state.compensation).toMatchObject({ outcome: "abandoned" });
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, id2), eq(auditLog.ruleId, "workflow:compensation-abandoned")));
    expect(row?.effect).toBe("deny");
    expect(row?.detail).toMatchObject({ notRun: ["revert_merge", "undo_branch"] });
  });

  it("templates with a bad compensation are refused at creation", async () => {
    const res = await post("/v1/workflows/templates", {
      name: `wc-bad-${RUN}`,
      definition: {
        workflow: `wc-bad-${RUN}`,
        stages: [
          { id: "intake", type: "trigger" },
          { id: "branch", type: "git_operation", action: "create_branch", ...g },
          { id: "undo", type: "git_operation", action: "close_pr", compensates: "branch", ...g },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/cannot compensate 'branch'/);
  });
});
