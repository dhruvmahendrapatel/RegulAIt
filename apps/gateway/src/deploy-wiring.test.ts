import { afterEach, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { liveDeployClients, resolveDeployProvider } from "./deploy.js";
import { buildApp } from "./app.js";

/**
 * The REGULAIT_DEPLOY_LIVE → real-factory WIRING (liveDeployClients, mirrored
 * on infra.ts's providerConfig), per cloud:
 *   · flag OFF: {} — the provider config carries no client, every adapter's
 *     dry-run result stays DEEP-EQUAL to the unwired shape, and no SDK module
 *     is ever evaluated (factory construction itself is lazy);
 *   · flag ON: exactly the matching real client key is injected (aws → the
 *     AwsLiveDeployClient built by deploy-aws-client.ts, azure/gcp/k8s
 *     likewise); mock and unknown kinds get {} and keep their own semantics;
 *   · flag ON with the wiring BYPASSED (a config with no client) keeps the
 *     adapters' explicit unwired error — the wiring adds a live path, it
 *     never removes the guard;
 *   · end-to-end through the workflow engine: with the flag on, a deploy
 *     stage drives the REAL (lazily-built) client via the awaited async path,
 *     and a client failure is recorded HONESTLY — context.lastError + a
 *     blocked_on_deploy handoff, never a success, never a dryRun:false.
 * The integration case uses the azure client's config-validation error, which
 * rejects BEFORE any SDK load or network call — so it proves the awaited
 * stage failure path with zero cloud traffic.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "wi-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const ROLE = "arn:aws:iam::123456789012:role/regulait-deploy";
const SUB = "00000000-1111-2222-3333-444444444444";

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

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  piaAuth = (await makeUser("wi-pia@example.com")).auth;
  const ana = await makeUser("wi-ana@example.com");
  anaId = ana.id;
  anaAuth = ana.auth;
});

afterEach(() => {
  delete process.env.REGULAIT_DEPLOY_LIVE;
  delete process.env.REGULAIT_DEPLOY_AZURE_RESOURCE_GROUP;
  delete process.env.REGULAIT_DEPLOY_AZURE_TEMPLATE_URI;
});

describe("liveDeployClients — flag OFF", () => {
  it("returns {} for every provider kind — configs stay byte-identical to the unwired shape", () => {
    delete process.env.REGULAIT_DEPLOY_LIVE;
    for (const kind of ["mock", "aws", "azure", "gcp", "kubernetes", "someday"]) {
      expect(liveDeployClients(kind)).toEqual({});
    }
  });

  it("dry-run results with the wiring spread in are DEEP-EQUAL to the unwired results", async () => {
    delete process.env.REGULAIT_DEPLOY_LIVE;
    const cases = [
      { provider: "aws" as const, roleArn: ROLE, region: "us-east-1" },
      { provider: "azure" as const, roleArn: SUB, region: "eastus" },
      { provider: "gcp" as const, roleArn: "proj-1", region: "us-central1" },
      { provider: "kubernetes" as const, credential: "kc", region: "ns" },
    ];
    for (const cfg of cases) {
      const unwired = await resolveDeployProvider(cfg).deploy("t", "prod", "abcdef1234");
      const wired = await resolveDeployProvider({ ...cfg, ...liveDeployClients(cfg.provider) }).deploy(
        "t",
        "prod",
        "abcdef1234",
      );
      expect(wired).toEqual(unwired);
      expect(wired.dryRun).toBe(true);
    }
  });
});

describe("liveDeployClients — flag ON", () => {
  it("injects exactly the matching real client key per cloud; mock/unknown stay {}", () => {
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    const aws = liveDeployClients("aws");
    expect(Object.keys(aws)).toEqual(["awsLiveClient"]);
    expect(typeof aws.awsLiveClient!.assumeRole).toBe("function");
    expect(typeof aws.awsLiveClient!.deploy).toBe("function");
    expect(typeof aws.awsLiveClient!.rollback).toBe("function");
    const azure = liveDeployClients("azure");
    expect(Object.keys(azure)).toEqual(["azureLiveClient"]);
    expect(typeof azure.azureLiveClient!.deploy).toBe("function");
    const gcp = liveDeployClients("gcp");
    expect(Object.keys(gcp)).toEqual(["gcpLiveClient"]);
    expect(typeof gcp.gcpLiveClient!.deploy).toBe("function");
    const k8s = liveDeployClients("kubernetes");
    expect(Object.keys(k8s)).toEqual(["k8sLiveClient"]);
    expect(typeof k8s.k8sLiveClient!.deploy).toBe("function");
    expect(liveDeployClients("mock")).toEqual({});
    expect(liveDeployClients("someday")).toEqual({});
  });

  it("the injected azure client threads env config: its first call rejects on the MISSING config, before any SDK load or network", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    const provider = resolveDeployProvider({
      provider: "azure",
      roleArn: SUB,
      region: "eastus",
      ...liveDeployClients("azure"),
    });
    // wired → the unwired-error branch is NOT taken; the real client runs and
    // honestly refuses on its missing config (no resource group configured)
    await expect(provider.deploy("web", "prod", "seed1234")).rejects.toThrow(
      /REGULAIT_DEPLOY_AZURE_RESOURCE_GROUP/,
    );
  });

  it("bypassing the wiring keeps the adapters' explicit unwired error (flag on, no client injected)", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    const provider = resolveDeployProvider({ provider: "azure", roleArn: SUB, region: "eastus" });
    await expect(provider.deploy("web", "prod", "seed")).rejects.toThrow(
      /no live Azure deploy client was injected/,
    );
  });
});

describe("flag ON end-to-end: the awaited async live path records failure honestly in the stage", () => {
  it("a live-client failure lands in context.lastError + blocked_on_deploy — never a success, never dryRun:false", async () => {
    // an azure BYOC target; the live azure client will reject on its missing
    // resource-group config BEFORE any SDK/network touch. (The shared target
    // schema validates roleArn against the AWS ARN grammar for every
    // provider, so the subscription handle is ARN-shaped here — the azure
    // adapter treats roleArn as an opaque account handle either way.)
    const created = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/deploy/targets",
      payload: { name: "wi-az", provider: "azure", roleArn: ROLE, region: "eastus", mode: "byoc" },
    });
    expect(created.statusCode).toBe(201);
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: { name: "wi-live-fail", definition: { workflow: "wi-live-fail", stages: [
        { id: "intake", type: "trigger" },
        { id: "gate", type: "human_approval", approvers: [anaId] },
        { id: "deploy", type: "deployment", connection: "wi-az", environment: "staging" },
        { id: "done", type: "human_approval", approvers: [anaId] },
      ] } },
    });
    expect(tpl.statusCode).toBe(201);
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "wi-live-change" },
    });
    const started = await app.inject({
      method: "POST", headers: piaAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "wiring live failure", paths: ["x"], changeType: "wi-live-change", environment: "wi-env" } },
    });
    expect(started.statusCode).toBe(201);
    const id = started.json().id as string;

    // flip the flag ON for the approval-triggered advance that executes the
    // deploy stage through the real wiring
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    try {
      const view = await app.inject({ method: "GET", headers: anaAuth, url: `/v1/workflows/instances/${id}` });
      const gate = (view.json().pendingApprovals ?? []).find((a: { stageId: string }) => a.stageId === "gate");
      expect(gate).toBeTruthy();
      await app.inject({ method: "POST", headers: anaAuth, url: `/v1/approvals/${gate.id}/decide`, payload: { decision: "approved" } });
    } finally {
      delete process.env.REGULAIT_DEPLOY_LIVE;
    }

    const after = await app.inject({ method: "GET", headers: piaAuth, url: `/v1/workflows/instances/${id}` });
    const instance = after.json().instance;
    // the awaited rejection took the SAME catch → deploy_blocked path a sync
    // throw used to take: an honest manual handoff, not a pretend success
    expect(instance.status).toBe("blocked_on_deploy");
    expect(instance.context.lastError).toContain("deploy:");
    expect(instance.context.lastError).toContain("REGULAIT_DEPLOY_AZURE_RESOURCE_GROUP");
    // nothing was recorded as a completed deployment
    expect(instance.context["deploy:deploy"]).toBeUndefined();
    expect(instance.context.deployUrl).toBeUndefined();
  });
});
