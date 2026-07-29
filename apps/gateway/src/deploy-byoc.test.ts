import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { resolveDeployProvider, DeployProviderError } from "./deploy.js";
import { buildApp } from "./app.js";

/**
 * PILLAR 3 BYOC — AWS deploy adapter (assume-role SHAPE, dry-run execution),
 * deployment modes, and the control-plane / agent-execution-plane data
 * boundary. An aws target assumes the customer's IAM role in their region
 * (no static keys); in AIR_GAPPED mode the control plane retains deploy
 * METADATA only (never the URL / provider detail that could carry
 * execution-plane data). Shares one DB (fileParallelism off); prefix by-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "by-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const ROLE = "arn:aws:iam::123456789012:role/regulait-deploy";

let db: Db;
let app: ReturnType<typeof buildApp>;
let piaAuth: { authorization: string };
let anaId: string;
let anaAuth: { authorization: string };

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}
async function pendingGate(instanceId: string) {
  const res = await app.inject({ method: "GET", headers: anaAuth, url: `/v1/workflows/instances/${instanceId}` });
  return (res.json().pendingApprovals ?? []).find((a: { stageId: string }) => a.stageId === "gate");
}
async function approveGate(instanceId: string) {
  const a = await pendingGate(instanceId);
  expect(a).toBeTruthy();
  await app.inject({ method: "POST", headers: anaAuth, url: `/v1/approvals/${a.id}/decide`, payload: { decision: "approved" } });
}
async function registerAndStart(name: string, changeType: string, target: string) {
  const tpl = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/workflows/templates",
    payload: { name, definition: { workflow: name, stages: [
      { id: "intake", type: "trigger" },
      { id: "gate", type: "human_approval", approvers: [anaId] },
      { id: "deploy", type: "deployment", connection: target, environment: "production" },
      { id: "verify", type: "automated_check", checks: ["smoke"], onFailure: "rollback", rollbackStageId: "undo" },
      { id: "undo", type: "rollback", connection: target },
      { id: "done", type: "human_approval", approvers: [anaId] },
    ] } },
  });
  expect(tpl.statusCode).toBe(201);
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules", payload: { templateId: tpl.json().id, changeType } });
  // suite-unique change environment ("by-env"), never "production", so another
  // suite's environment=production assignment rule can't merge its template in.
  const s = await app.inject({ method: "POST", headers: piaAuth, url: "/v1/workflows/instances",
    payload: { change: { description: "byoc change", paths: ["x"], changeType, environment: "by-env" } } });
  expect(s.statusCode).toBe(201);
  return s.json().id as string;
}
async function inst(id: string) {
  const r = await app.inject({ method: "GET", headers: piaAuth, url: `/v1/workflows/instances/${id}` });
  return r.json().instance;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });
  piaAuth = (await makeUser("by-pia@example.com")).auth;
  const ana = await makeUser("by-ana@example.com");
  anaId = ana.id; anaAuth = ana.auth;
});

describe("AWS deploy adapter (assume-role shape, dry-run)", () => {
  it("models assume-role → deploy and rollback without a real key", () => {
    const p = resolveDeployProvider({ provider: "aws", roleArn: ROLE, region: "us-east-1" });
    const res = p.deploy("checkout", "production", "abcdef1234");
    expect(res.deployId).toMatch(/^aws_/);
    expect(res.url).toContain("us-east-1.console.aws.amazon.com");
    expect(res.url).toContain("123456789012");
    expect(res.detail).toContain("assume-role");
    const rb = p.rollback("checkout", res.deployId);
    expect(rb.reverted).toBe(res.deployId);
  });
  it("an aws provider without roleArn/region is a clear error", () => {
    const p = resolveDeployProvider({ provider: "aws", roleArn: "", region: "" });
    expect(() => p.deploy("x", null, "seed")).toThrow(DeployProviderError);
  });
});

describe("deploy target CRUD (BYOC fields)", () => {
  it("rejects an aws target with no roleArn/region; accepts a valid one; view has mode/region, no credential", async () => {
    const bad = await app.inject({ method: "POST", headers: AUTH, url: "/v1/deploy/targets",
      payload: { name: "by-bad", provider: "aws" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", headers: AUTH, url: "/v1/deploy/targets",
      payload: { name: "by-aws", provider: "aws", roleArn: ROLE, region: "us-east-1", mode: "byoc", environment: "production" } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ mode: "byoc", region: "us-east-1", roleArn: ROLE });
    expect(Object.keys(ok.json())).not.toContain("credentialCiphertext");
  });
});

describe("deployment through a BYOC aws target + the air-gapped data boundary", () => {
  it("a byoc aws target deploys via the assume-role adapter and records the full deployment", async () => {
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/deploy/targets",
      payload: { name: "by-aws-run", provider: "aws", roleArn: ROLE, region: "eu-west-1", mode: "byoc" } });
    const id = await registerAndStart("by-run", "by-run-change", "by-aws-run");
    await approveGate(id);
    const i = await inst(id);
    expect(i.status).toBe("blocked_on_approval"); // deploy ok, verify auto-passed, at final gate
    const dep = i.context["deploy:deploy"];
    expect(dep).toMatchObject({ target: "by-aws-run", mode: "byoc" });
    expect(dep.deployId).toMatch(/^aws_/);
    expect(dep.url).toContain("eu-west-1"); // full record kept for byoc
  });

  it("an AIR_GAPPED target keeps METADATA ONLY in the control plane — no url/detail", async () => {
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/deploy/targets",
      payload: { name: "by-air", provider: "aws", roleArn: ROLE, region: "us-west-2", mode: "air_gapped" } });
    const id = await registerAndStart("by-air-run", "by-air-change", "by-air");
    await approveGate(id);
    const i = await inst(id);
    const dep = i.context["deploy:deploy"];
    expect(dep).toMatchObject({ mode: "air_gapped", target: "by-air" });
    expect(dep.deployId).toBeDefined();
    // the boundary: the execution-plane detail never crossed back
    expect(dep.url).toBeUndefined();
    expect(dep.detail).toBeUndefined();
    expect(i.context.deployUrl).toBeUndefined();
  });
});
