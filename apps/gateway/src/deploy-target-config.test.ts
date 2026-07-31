import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import {
  deployClientEnvOverlay,
  liveDeployClients,
  resolveDeployProvider,
} from "./deploy.js";
import { buildApp } from "./app.js";

/**
 * Migration 0043 — per-provider-kind deploy-target config (the #64 flagged
 * gap). The AWS ARN grammar binds to aws only; azure/gcp carry their own
 * named account fields (subscriptionId / projectId) plus per-kind config
 * (cluster / resourceGroup / templateUri / blueprintGcs / namespace), all
 * validated per kind, stored on the row, and threaded ROW-FIRST into the
 * provider construction and the live-client wiring (env vars become the
 * fallback). Shares one DB (fileParallelism off); prefix dtc-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "dtc-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const ROLE = "arn:aws:iam::123456789012:role/regulait-deploy";

let db: Db;
let app: ReturnType<typeof buildApp>;
let anaId: string;
let anaAuth: { authorization: string };
let piaAuth: { authorization: string };

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

const postTarget = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/deploy/targets", payload });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  const ana = await makeUser("dtc-ana@example.com");
  anaId = ana.id;
  anaAuth = ana.auth;
  piaAuth = (await makeUser("dtc-pia@example.com")).auth;
});

describe("per-kind creation validation (#64: the ARN grammar binds to aws only)", () => {
  it("an azure target is creatable with a REAL subscription id — no AWS ARN grammar in the way", async () => {
    const r = await postTarget({
      name: "dtc-az",
      provider: "azure",
      subscriptionId: "3f2f7d5e-0000-4000-8000-24d1c4b2a111",
      resourceGroup: "rg-prod",
      templateUri: "https://example.com/deploy.json",
      region: "eastus",
      mode: "byoc",
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().providerConfig).toEqual({
      subscriptionId: "3f2f7d5e-0000-4000-8000-24d1c4b2a111",
      resourceGroup: "rg-prod",
      templateUri: "https://example.com/deploy.json",
    });
    expect(Object.keys(r.json())).not.toContain("credentialCiphertext");
  });

  it("azure legacy shape (roleArn as the account handle) still works — pre-0043 rows keep their meaning", async () => {
    const r = await postTarget({ name: "dtc-az-legacy", provider: "azure", roleArn: "sub-1234", region: "westeurope" });
    expect(r.statusCode).toBe(201);
    expect(r.json().providerConfig).toBeNull();
  });

  it("azure without a subscription (or legacy roleArn) or region is a loud 400", async () => {
    const r = await postTarget({ name: "dtc-az-bad", provider: "azure", region: "eastus" });
    expect(r.statusCode).toBe(400);
  });

  it("aws keeps the strict ARN grammar — a non-ARN roleArn is rejected for aws only", async () => {
    const bad = await postTarget({ name: "dtc-aws-bad", provider: "aws", roleArn: "sub-1234", region: "us-east-1" });
    expect(bad.statusCode).toBe(400);
    const ok = await postTarget({ name: "dtc-aws", provider: "aws", roleArn: ROLE, region: "us-east-1", cluster: "prod-cluster" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().providerConfig).toEqual({ cluster: "prod-cluster" });
  });

  it("gcp validates the project id and gs:// blueprint shapes", async () => {
    const badProject = await postTarget({ name: "dtc-gcp-bad1", provider: "gcp", projectId: "NOT VALID", region: "us-central1" });
    expect(badProject.statusCode).toBe(400);
    const badBlueprint = await postTarget({
      name: "dtc-gcp-bad2", provider: "gcp", projectId: "acme-prod-1234", blueprintGcs: "s3://wrong-cloud", region: "us-central1",
    });
    expect(badBlueprint.statusCode).toBe(400);
    const ok = await postTarget({
      name: "dtc-gcp", provider: "gcp", projectId: "acme-prod-1234", blueprintGcs: "gs://acme-blueprints/prod", region: "us-central1",
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().providerConfig).toEqual({ projectId: "acme-prod-1234", blueprintGcs: "gs://acme-blueprints/prod" });
  });

  it("a config field on the wrong kind is rejected loudly, never silently dropped", async () => {
    const r = await postTarget({
      name: "dtc-az-wrongkey", provider: "azure", subscriptionId: "sub-1", region: "eastus", blueprintGcs: "gs://x/y",
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toContain("not a config field of a azure deploy target");
  });

  it("kubernetes now requires its kubeconfig credential at creation and may name a namespace", async () => {
    const bad = await postTarget({ name: "dtc-k8s-bad", provider: "kubernetes" });
    expect(bad.statusCode).toBe(400);
    const ok = await postTarget({ name: "dtc-k8s", provider: "kubernetes", credential: "kubeconfig-yaml", namespace: "team-a" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().providerConfig).toEqual({ namespace: "team-a" });
    const badNs = await postTarget({ name: "dtc-k8s-bad2", provider: "kubernetes", credential: "kc", namespace: "Not_A_Namespace" });
    expect(badNs.statusCode).toBe(400);
  });

  it("mock stays a zero-config target", async () => {
    const r = await postTarget({ name: "dtc-mock", provider: "mock" });
    expect(r.statusCode).toBe(201);
    expect(r.json().providerConfig).toBeNull();
  });
});

describe("row-first provider construction (dry-run providers)", () => {
  it("azure: providerConfig.subscriptionId beats the legacy roleArn slot", async () => {
    const p = resolveDeployProvider({
      provider: "azure",
      roleArn: "legacy-handle",
      region: "eastus",
      providerConfig: { subscriptionId: "sub-row-wins" },
    });
    const res = await p.deploy("web", "staging", "seed1234");
    expect(res.dryRun).toBe(true);
    expect(res.detail).toContain("sub sub-row-wins");
    expect(res.url).toContain("sub-row-wins");
  });

  it("gcp: providerConfig.projectId beats the legacy roleArn slot", async () => {
    const p = resolveDeployProvider({
      provider: "gcp",
      roleArn: "legacy-handle",
      region: "us-central1",
      providerConfig: { projectId: "proj-row-wins" },
    });
    const res = await p.deploy("web", "staging", "seed1234");
    expect(res.detail).toContain("project proj-row-wins");
  });

  it("kubernetes: providerConfig.namespace beats the legacy region slot", async () => {
    const p = resolveDeployProvider({
      provider: "kubernetes",
      credential: "kubeconfig-yaml",
      region: "legacy-ns",
      providerConfig: { namespace: "row-ns" },
    });
    const res = await p.deploy("web", "staging", "seed1234");
    expect(res.detail).toContain("namespace row-ns");
  });

  it("no providerConfig = the legacy behaviour, byte-identical", async () => {
    const p = resolveDeployProvider({ provider: "azure", roleArn: "sub-legacy", region: "eastus" });
    const res = await p.deploy("web", null, "seed1234");
    expect(res.detail).toContain("sub sub-legacy");
  });
});

describe("row-first live-client wiring (env vars become the fallback)", () => {
  it("deployClientEnvOverlay: a row field beats the env var; an absent field falls through", () => {
    const env = { REGULAIT_DEPLOY_AZURE_RESOURCE_GROUP: "rg-env", REGULAIT_DEPLOY_AZURE_TEMPLATE_URI: "https://env/t.json" } as NodeJS.ProcessEnv;
    const merged = deployClientEnvOverlay("azure", env, { resourceGroup: "rg-row" });
    expect(merged.REGULAIT_DEPLOY_AZURE_RESOURCE_GROUP).toBe("rg-row");
    expect(merged.REGULAIT_DEPLOY_AZURE_TEMPLATE_URI).toBe("https://env/t.json");
    const gcp = deployClientEnvOverlay("gcp", {} as NodeJS.ProcessEnv, { blueprintGcs: "gs://row/bp" });
    expect(gcp.REGULAIT_DEPLOY_GCP_BLUEPRINT_GCS).toBe("gs://row/bp");
    // null config / non-config providers pass the env through untouched
    expect(deployClientEnvOverlay("azure", env, null)).toBe(env);
    expect(deployClientEnvOverlay("aws", env, { cluster: "c" })).toBe(env);
  });

  it("a row-carried resource group reaches the live azure client: the refusal moves PAST the rg to the next missing config", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    try {
      const p = resolveDeployProvider({
        provider: "azure",
        region: "eastus",
        providerConfig: { subscriptionId: "sub-1", resourceGroup: "rg-row" },
        ...liveDeployClients("azure", process.env, { subscriptionId: "sub-1", resourceGroup: "rg-row" }),
      });
      // rg is satisfied from the ROW; the client now refuses on the template
      // uri — proving the row config actually reached the live client
      await expect(p.deploy("web", "prod", "seed1234")).rejects.toThrow(
        /REGULAIT_DEPLOY_AZURE_TEMPLATE_URI/,
      );
    } finally {
      delete process.env.REGULAIT_DEPLOY_LIVE;
    }
  });
});

describe("workflow threading: the deploy executor hands the row config to the provider", () => {
  it("an azure target with only a named subscriptionId deploys (dry-run) through a workflow", async () => {
    const created = await postTarget({
      name: "dtc-wf-az", provider: "azure",
      subscriptionId: "sub-wf-1", region: "eastus", mode: "byoc",
    });
    expect(created.statusCode).toBe(201);
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: { name: "dtc-wf", definition: { workflow: "dtc-wf", stages: [
        { id: "intake", type: "trigger" },
        { id: "gate", type: "human_approval", approvers: [anaId] },
        { id: "deploy", type: "deployment", connection: "dtc-wf-az", environment: "staging" },
        { id: "done", type: "human_approval", approvers: [anaId] },
      ] } },
    });
    expect(tpl.statusCode).toBe(201);
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "dtc-wf-change" },
    });
    const started = await app.inject({
      method: "POST", headers: piaAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "row-config deploy", paths: ["x"], changeType: "dtc-wf-change", environment: "staging" } },
    });
    expect(started.statusCode).toBe(201);
    const id = started.json().id as string;
    const view = await app.inject({ method: "GET", headers: anaAuth, url: `/v1/workflows/instances/${id}` });
    const gate = (view.json().pendingApprovals ?? []).find((a: { stageId: string }) => a.stageId === "gate");
    expect(gate).toBeTruthy();
    await app.inject({ method: "POST", headers: anaAuth, url: `/v1/approvals/${gate.id}/decide`, payload: { decision: "approved" } });
    const after = await app.inject({ method: "GET", headers: piaAuth, url: `/v1/workflows/instances/${id}` });
    const instance = after.json().instance;
    const dep = instance.context["deploy:deploy"] as { detail?: string; dryRun?: boolean };
    expect(dep).toBeTruthy();
    expect(dep.dryRun).toBe(true);
    // the named subscription (not a roleArn) drove the provider
    expect(dep.detail).toContain("sub sub-wf-1");
  });
});
