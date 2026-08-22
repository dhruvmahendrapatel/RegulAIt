import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { resolveDeployProvider, DeployProviderError, type AwsLiveDeployClient } from "./deploy.js";
import { buildApp } from "./app.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";

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
  // ADR-0052 §4: creating an air_gapped deploy target is now tier-gated on
  // `airgapped_mode` — run under a real signed license granting it (removed
  // in afterAll; the deployment ends UNLICENSED as it started).
  await installLicenseFixture(app, { features: ["airgapped_mode"], auth: AUTH });
  piaAuth = (await makeUser("by-pia@example.com")).auth;
  const ana = await makeUser("by-ana@example.com");
  anaId = ana.id; anaAuth = ana.auth;
});

afterAll(async () => {
  // `licenses` is an org singleton — leave the deployment UNLICENSED
  await removeLicenseFixture(db);
});

describe("AWS deploy adapter (assume-role shape, dry-run)", () => {
  it("models assume-role → deploy and rollback without a real key", async () => {
    const p = resolveDeployProvider({ provider: "aws", roleArn: ROLE, region: "us-east-1" });
    const res = await p.deploy("checkout", "production", "abcdef1234");
    expect(res.deployId).toMatch(/^aws_/);
    expect(res.url).toContain("us-east-1.console.aws.amazon.com");
    expect(res.url).toContain("123456789012");
    expect(res.detail).toContain("assume-role");
    const rb = await p.rollback("checkout", res.deployId);
    expect(rb.reverted).toBe(res.deployId);
  });
  it("an aws provider without roleArn/region is a clear error", async () => {
    const p = resolveDeployProvider({ provider: "aws", roleArn: "", region: "" });
    await expect(p.deploy("x", null, "seed")).rejects.toThrow(DeployProviderError);
  });
});

describe("A2 — azure/gcp/kubernetes deploy adapter shapes (deterministic dry-run)", () => {
  it("azure: deterministic dry-run deploy + rollback, config-missing throws", async () => {
    const p = resolveDeployProvider({ provider: "azure", roleArn: "sub-1234", region: "eastus" });
    const res = await p.deploy("web", "prod", "abcdef1234");
    expect(res.deployId).toMatch(/^azure_/);
    expect(res.url).toContain("portal.azure.com");
    expect(res.detail).toContain("[dry-run]");
    expect((await p.rollback("web", res.deployId)).reverted).toBe(res.deployId);
    await expect(
      resolveDeployProvider({ provider: "azure", roleArn: "", region: "" }).deploy("x", null, "s"),
    ).rejects.toThrow(DeployProviderError);
  });
  it("gcp: deterministic dry-run deploy + rollback, config-missing throws", async () => {
    const p = resolveDeployProvider({ provider: "gcp", roleArn: "proj-1234", region: "us-central1" });
    const res = await p.deploy("svc", "prod", "abcdef1234");
    expect(res.deployId).toMatch(/^gcp_/);
    expect(res.url).toContain("console.cloud.google.com");
    expect(res.detail).toContain("[dry-run]");
    expect((await p.rollback("svc", res.deployId)).reverted).toBe(res.deployId);
    await expect(
      resolveDeployProvider({ provider: "gcp", roleArn: "", region: "" }).deploy("x", null, "s"),
    ).rejects.toThrow(DeployProviderError);
  });
  it("kubernetes: deterministic dry-run deploy + rollback, missing kubeconfig throws", async () => {
    const p = resolveDeployProvider({ provider: "kubernetes", credential: "kubeconfig-yaml", region: "team-ns" });
    const res = await p.deploy("api", "prod", "abcdef1234");
    expect(res.deployId).toMatch(/^k8s_/);
    expect(res.url).toContain("k8s://team-ns/");
    expect(res.detail).toContain("[dry-run]");
    expect((await p.rollback("api", res.deployId)).reverted).toBe(res.deployId);
    await expect(
      resolveDeployProvider({ provider: "kubernetes", credential: "" }).deploy("x", null, "s"),
    ).rejects.toThrow(DeployProviderError);
  });
  it("resolveDeployProvider resolves all five provider kinds", () => {
    const kinds = ["mock", "aws", "azure", "gcp", "kubernetes"] as const;
    for (const kind of kinds) {
      const cfg =
        kind === "kubernetes"
          ? ({ provider: kind, credential: "kc" } as const)
          : ({ provider: kind, roleArn: ROLE, region: "us-east-1" } as const);
      expect(resolveDeployProvider(cfg).kind).toBe(kind);
    }
  });
});

describe("A1 — real @aws-sdk STS path behind REGULAIT_DEPLOY_LIVE (off by default)", () => {
  it("flag OFF: the aws adapter is a deterministic dry-run, no live client touched", async () => {
    delete process.env.REGULAIT_DEPLOY_LIVE;
    let touched = false;
    const fake: AwsLiveDeployClient = {
      async assumeRole() { touched = true; return { sessionId: "x" }; },
      async deploy() { touched = true; return { deployId: "x", url: "x" }; },
      async rollback() { touched = true; return { reverted: "x" }; },
    };
    const p = resolveDeployProvider({ provider: "aws", roleArn: ROLE, region: "us-east-1", awsLiveClient: fake });
    const res = await p.deploy("checkout", "production", "abcdef1234");
    expect(touched).toBe(false);
    expect(res.deployId).toMatch(/^aws_sess_/);
    expect(res.detail).toContain("[dry-run]");
  });

  it("flag ON: constructs a real AssumeRoleCommand (RoleArn/RoleSessionName/region) against the fake and captures a deploy id — never the network", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "true";
    try {
      const captured: Record<string, unknown> = {};
      const fake: AwsLiveDeployClient = {
        async assumeRole(command, region) {
          captured.roleArn = (command.input as { RoleArn?: string }).RoleArn;
          captured.sessionName = (command.input as { RoleSessionName?: string }).RoleSessionName;
          captured.duration = (command.input as { DurationSeconds?: number }).DurationSeconds;
          captured.region = region;
          return { sessionId: "live-sess-1" };
        },
        async deploy(params) { captured.deployParams = params; return { deployId: "live-dep-1", url: "https://live/checkout" }; },
        async rollback(params) { captured.rollbackParams = params; return { reverted: params.deployId }; },
      };
      const p = resolveDeployProvider({ provider: "aws", roleArn: ROLE, region: "eu-west-1", awsLiveClient: fake });
      const res = await p.deploy("checkout", "production", "seed1234abcd");
      expect(captured.roleArn).toBe(ROLE);
      expect(captured.sessionName).toMatch(/^regulait-/);
      expect(captured.duration).toBe(3600);
      expect(captured.region).toBe("eu-west-1");
      expect(res.deployId).toBe("live-dep-1");
      expect(res.url).toBe("https://live/checkout");
      expect(res.detail).toContain("[live]");
      const rb = await p.rollback("checkout", res.deployId);
      expect(rb.reverted).toBe("live-dep-1");
    } finally {
      delete process.env.REGULAIT_DEPLOY_LIVE;
    }
  });

  it("flag ON with NO injected client is an explicit error — no live path runs unwired", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    try {
      const p = resolveDeployProvider({ provider: "aws", roleArn: ROLE, region: "us-east-1" });
      await expect(p.deploy("checkout", "production", "seed")).rejects.toThrow(DeployProviderError);
    } finally {
      delete process.env.REGULAIT_DEPLOY_LIVE;
    }
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
