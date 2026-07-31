import { afterEach, describe, expect, it } from "vitest";
import {
  DeployProviderError,
  resolveDeployProvider,
  type AzureLiveDeployClient,
  type GcpLiveDeployClient,
  type KubernetesLiveDeployClient,
} from "./deploy.js";

/**
 * Batch C — the azure/gcp/kubernetes REAL deploy paths behind
 * REGULAIT_DEPLOY_LIVE, mirroring the AWS A1 semantics exactly (see
 * deploy-byoc.test.ts for aws). Proves per cloud, with fake injected clients
 * and never the network:
 *   · flag OFF: the dry-run stays byte-identical to the pre-Batch-C shape and
 *     the injected client is NEVER touched — even when one is wired;
 *   · flag ON + injected client: the client is driven with the full BYOC
 *     params (subscription/project/kubeconfig threading) and the result
 *     honestly reports dryRun:false + [live];
 *   · flag ON with NO injected client: an explicit DeployProviderError — no
 *     live path ever runs unwired, and no silent dry-run pretends under a
 *     live flag;
 *   · rollback carries the same three-way semantics.
 * Pure unit tests — no DB, no network. (ASYNC-DEPLOY refactor: providers and
 * fakes are Promise-returning; assertions await — mechanically updated only.)
 */

const SUB = "00000000-1111-2222-3333-444444444444";

afterEach(() => {
  delete process.env.REGULAIT_DEPLOY_LIVE;
});

function fakeAzure() {
  const calls: Record<string, unknown>[] = [];
  const client: AzureLiveDeployClient = {
    async deploy(params) {
      calls.push({ op: "deploy", ...params });
      return { deployId: "arm-dep-1", url: "https://portal.azure.com/#live/arm-dep-1" };
    },
    async rollback(params) {
      calls.push({ op: "rollback", ...params });
      return { reverted: params.deployId };
    },
  };
  return { client, calls };
}

function fakeGcp() {
  const calls: Record<string, unknown>[] = [];
  const client: GcpLiveDeployClient = {
    async deploy(params) {
      calls.push({ op: "deploy", ...params });
      return { deployId: "im-dep-1", url: "https://console.cloud.google.com/live/im-dep-1" };
    },
    async rollback(params) {
      calls.push({ op: "rollback", ...params });
      return { reverted: params.deployId };
    },
  };
  return { client, calls };
}

function fakeK8s() {
  const calls: Record<string, unknown>[] = [];
  const client: KubernetesLiveDeployClient = {
    async deploy(params) {
      calls.push({ op: "deploy", ...params });
      return { deployId: "rollout-7", url: "k8s://live/rollout-7" };
    },
    async rollback(params) {
      calls.push({ op: "rollback", ...params });
      return { reverted: params.deployId };
    },
  };
  return { client, calls };
}

describe("azure — REGULAIT_DEPLOY_LIVE three-way semantics", () => {
  it("flag OFF: dry-run byte-identical to the pre-live shape, wired client never touched", async () => {
    delete process.env.REGULAIT_DEPLOY_LIVE;
    const { client, calls } = fakeAzure();
    const p = resolveDeployProvider({ provider: "azure", roleArn: SUB, region: "eastus", azureLiveClient: client });
    const res = await p.deploy("web", "prod", "abcdef1234");
    expect(calls).toHaveLength(0);
    expect(res).toEqual({
      deployId: "azure_az_abcdef12_prod",
      url: `https://portal.azure.com/#@/resource/subscriptions/${SUB}/deploy/web/azure_az_abcdef12_prod`,
      detail: `azure login sub ${SUB} → deploy to web (prod) in eastus [dry-run]`,
      dryRun: true,
    });
    const rb = await p.rollback("web", res.deployId);
    expect(calls).toHaveLength(0);
    expect(rb).toEqual({ reverted: res.deployId, detail: `azure rollback of ${res.deployId} on web [dry-run]` });
  });

  it("flag ON + injected client: ARM deployment driven with subscription/region threaded; dryRun honestly false", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "true";
    const { client, calls } = fakeAzure();
    const p = resolveDeployProvider({ provider: "azure", roleArn: SUB, region: "westeurope", azureLiveClient: client });
    const res = await p.deploy("web", "prod", "seed1234");
    expect(calls[0]).toEqual({
      op: "deploy",
      target: "web",
      environment: "prod",
      region: "westeurope",
      subscription: SUB,
    });
    expect(res.deployId).toBe("arm-dep-1");
    expect(res.url).toContain("live");
    expect(res.detail).toContain("[live]");
    expect(res.dryRun).toBe(false);
    const rb = await p.rollback("web", "arm-dep-1");
    expect(rb.reverted).toBe("arm-dep-1");
    expect(rb.detail).toContain("[live]");
    expect(calls[1]).toMatchObject({ op: "rollback", deployId: "arm-dep-1", subscription: SUB });
  });

  it("flag ON with NO injected client: explicit error for deploy AND rollback — never an unwired live run", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    const p = resolveDeployProvider({ provider: "azure", roleArn: SUB, region: "eastus" });
    await expect(p.deploy("web", "prod", "seed")).rejects.toThrow(/no live Azure deploy client was injected/);
    await expect(p.rollback("web", "dep-1")).rejects.toThrow(DeployProviderError);
  });

  it("flag ON still validates config first (missing subscription/region is the config error)", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    const { client } = fakeAzure();
    const p = resolveDeployProvider({ provider: "azure", roleArn: "", region: "", azureLiveClient: client });
    await expect(p.deploy("web", "prod", "seed")).rejects.toThrow(/needs a subscription/);
  });
});

describe("gcp — REGULAIT_DEPLOY_LIVE three-way semantics", () => {
  it("flag OFF: dry-run byte-identical to the pre-live shape, wired client never touched", async () => {
    delete process.env.REGULAIT_DEPLOY_LIVE;
    const { client, calls } = fakeGcp();
    const p = resolveDeployProvider({ provider: "gcp", roleArn: "proj-1", region: "us-central1", gcpLiveClient: client });
    const res = await p.deploy("svc", "prod", "abcdef1234");
    expect(calls).toHaveLength(0);
    expect(res).toEqual({
      deployId: "gcp_gc_abcdef12_prod",
      url: "https://console.cloud.google.com/deploy/proj-1/us-central1/svc/gcp_gc_abcdef12_prod",
      detail: "gcp wif project proj-1 → deploy to svc (prod) in us-central1 [dry-run]",
      dryRun: true,
    });
    const rb = await p.rollback("svc", res.deployId);
    expect(calls).toHaveLength(0);
    expect(rb.detail).toContain("[dry-run]");
  });

  it("flag ON + injected client: infra-manager deployment driven with project/region threaded; dryRun honestly false", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "true";
    const { client, calls } = fakeGcp();
    const p = resolveDeployProvider({ provider: "gcp", roleArn: "proj-1", region: "europe-west1", gcpLiveClient: client });
    const res = await p.deploy("svc", "prod", "seed1234");
    expect(calls[0]).toEqual({
      op: "deploy",
      target: "svc",
      environment: "prod",
      region: "europe-west1",
      project: "proj-1",
    });
    expect(res.deployId).toBe("im-dep-1");
    expect(res.detail).toContain("[live]");
    expect(res.dryRun).toBe(false);
    const rb = await p.rollback("svc", "im-dep-1");
    expect(rb.reverted).toBe("im-dep-1");
    expect(rb.detail).toContain("[live]");
  });

  it("flag ON with NO injected client: explicit error for deploy AND rollback", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    const p = resolveDeployProvider({ provider: "gcp", roleArn: "proj-1", region: "us-central1" });
    await expect(p.deploy("svc", "prod", "seed")).rejects.toThrow(/no live GCP deploy client was injected/);
    await expect(p.rollback("svc", "dep-1")).rejects.toThrow(DeployProviderError);
  });
});

describe("kubernetes — REGULAIT_DEPLOY_LIVE three-way semantics", () => {
  it("flag OFF: dry-run byte-identical to the pre-live shape, wired client never touched", async () => {
    delete process.env.REGULAIT_DEPLOY_LIVE;
    const { client, calls } = fakeK8s();
    const p = resolveDeployProvider({
      provider: "kubernetes",
      credential: "kubeconfig-yaml",
      region: "team-ns",
      k8sLiveClient: client,
    });
    const res = await p.deploy("api", "prod", "abcdef1234");
    expect(calls).toHaveLength(0);
    expect(res).toEqual({
      deployId: "k8s_k8s_abcdef12_prod",
      url: "k8s://team-ns/deployments/api#k8s_k8s_abcdef12_prod",
      detail: "kubeconfig apply → rollout api in namespace team-ns (prod) [dry-run]",
      dryRun: true,
    });
    expect((await p.rollback("api", res.deployId)).detail).toContain("[dry-run]");
    expect(calls).toHaveLength(0);
  });

  it("flag ON + injected client: the kubeconfig credential + namespace are threaded; dryRun honestly false", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "true";
    const { client, calls } = fakeK8s();
    const p = resolveDeployProvider({
      provider: "kubernetes",
      credential: "kubeconfig-yaml",
      region: "team-ns",
      k8sLiveClient: client,
    });
    const res = await p.deploy("api", "prod", "seed1234");
    expect(calls[0]).toEqual({
      op: "deploy",
      target: "api",
      environment: "prod",
      namespace: "team-ns",
      kubeconfig: "kubeconfig-yaml",
    });
    expect(res.deployId).toBe("rollout-7");
    expect(res.detail).toContain("[live]");
    expect(res.dryRun).toBe(false);
    const rb = await p.rollback("api", "rollout-7");
    expect(rb.reverted).toBe("rollout-7");
    expect(calls[1]).toMatchObject({ op: "rollback", kubeconfig: "kubeconfig-yaml", namespace: "team-ns" });
  });

  it("flag ON + injected client with no namespace configured: the environment doubles as the namespace", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    const { client, calls } = fakeK8s();
    const p = resolveDeployProvider({ provider: "kubernetes", credential: "kc", k8sLiveClient: client });
    await p.deploy("api", "staging", "seed1234");
    expect(calls[0]).toMatchObject({ namespace: "staging", environment: "staging" });
  });

  it("flag ON with NO injected client: explicit error; missing kubeconfig stays the config error", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    const p = resolveDeployProvider({ provider: "kubernetes", credential: "kc", region: "ns" });
    await expect(p.deploy("api", "prod", "seed")).rejects.toThrow(/no live Kubernetes deploy client was injected/);
    await expect(p.rollback("api", "dep-1")).rejects.toThrow(DeployProviderError);
    const { client } = fakeK8s();
    const bare = resolveDeployProvider({ provider: "kubernetes", credential: "", k8sLiveClient: client });
    await expect(bare.deploy("api", "prod", "seed")).rejects.toThrow(/needs a kubeconfig credential/);
  });
});

describe("cross-cloud honesty invariants", () => {
  it("dryRun:false is ONLY ever reported when a live client call actually happened", async () => {
    // flag off, all three clouds, wired or not → dryRun:true always
    delete process.env.REGULAIT_DEPLOY_LIVE;
    for (const cfg of [
      { provider: "azure" as const, roleArn: SUB, region: "eastus", azureLiveClient: fakeAzure().client },
      { provider: "gcp" as const, roleArn: "proj-1", region: "us-central1", gcpLiveClient: fakeGcp().client },
      { provider: "kubernetes" as const, credential: "kc", region: "ns", k8sLiveClient: fakeK8s().client },
      { provider: "azure" as const, roleArn: SUB, region: "eastus" },
      { provider: "gcp" as const, roleArn: "proj-1", region: "us-central1" },
      { provider: "kubernetes" as const, credential: "kc", region: "ns" },
    ]) {
      expect((await resolveDeployProvider(cfg).deploy("t", "production", "seed1234")).dryRun).toBe(true);
    }
  });

  it("the production-gate contract survives: a dry-run result still carries dryRun:true for prod targets", async () => {
    // ADR-0022: workflows.ts blocks a production deploy gate on dryRun:true —
    // the flag-off adapters keep reporting it so that refusal keeps working.
    delete process.env.REGULAIT_DEPLOY_LIVE;
    const res = await resolveDeployProvider({ provider: "azure", roleArn: SUB, region: "eastus" }).deploy(
      "web",
      "production",
      "abcdef1234",
    );
    expect(res.dryRun).toBe(true);
    expect(res.detail).toContain("[dry-run]");
  });
});
