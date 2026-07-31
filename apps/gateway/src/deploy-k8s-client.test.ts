import { describe, expect, it } from "vitest";
import { buildK8sLiveDeployClient, type K8sDeploySdk } from "./deploy-k8s-client.js";
import { resolveDeployProvider } from "./deploy.js";

/**
 * The REAL Kubernetes deploy live client (@kubernetes/client-node branch of
 * the KubernetesLiveDeployClient contract), unblocked by the ASYNC-DEPLOY
 * refactor. Proves, with fully fake SDK modules and never the network:
 *   · the factory is LAZY — no SDK module is loaded at construction, only on
 *     the first actual call;
 *   · deploy = KubeConfig.loadFromString(the per-call kubeconfig credential —
 *     scoped, never held) → SERVER-SIDE APPLY (Content-Type
 *     application/apply-patch+yaml, fieldManager regulait-deploy, forced) of
 *     the rollout stamp onto the EXISTING Deployment named `target`, then the
 *     rollout is WATCHED to completion (observedGeneration caught up, every
 *     replica updated + available);
 *   · the reported deployId is the OBSERVED deployment.kubernetes.io/revision
 *     — the applied resource reported honestly;
 *   · ProgressDeadlineExceeded (a mid-rollout failure) or a timeout THROWS —
 *     never a success-shaped result — and surfaces through the (now async)
 *     KubernetesDeployProvider deploy path;
 *   · rollback = the rollout-undo: the prior OWNED ReplicaSet revision's pod
 *     template (pod-template-hash stripped) server-side applied back, rollout
 *     watched the same way.
 * Pure unit tests — no DB, no network, no real cluster.
 */

const KUBECONFIG = "apiVersion: v1\nkind: Config\nusers: []";
const NS = "team-ns";

interface Recorded {
  op: string;
  param: Record<string, unknown>;
  options?: Record<string, unknown>;
}

function makeFakeSdk(respond: (op: string, param: Record<string, unknown>, n: number) => unknown) {
  const calls: Recorded[] = [];
  const loadedConfigs: string[] = [];
  let readCount = 0;
  const api = {
    async readNamespacedDeployment(param: Record<string, unknown>) {
      calls.push({ op: "read", param });
      return respond("read", param, ++readCount);
    },
    async patchNamespacedDeployment(param: Record<string, unknown>, options?: Record<string, unknown>) {
      calls.push({ op: "patch", param, options });
      return respond("patch", param, 0);
    },
    async listNamespacedReplicaSet(param: Record<string, unknown>) {
      calls.push({ op: "listRs", param });
      return respond("listRs", param, 0);
    },
  };
  const AppsV1Api = class {};
  const sdk = {
    KubeConfig: class {
      loadFromString(config: string) {
        loadedConfigs.push(config);
      }
      makeApiClient(type: unknown) {
        if (type !== AppsV1Api) throw new Error("wrong api client type");
        return api;
      }
    },
    AppsV1Api,
    PatchStrategy: { ServerSideApply: "application/apply-patch+yaml" },
    setHeaderOptions: (key: string, value: string) => ({ headers: { [key]: value } }),
  } as unknown as K8sDeploySdk;
  return { sdk, calls, loadedConfigs };
}

function deployment(over: Record<string, unknown> = {}) {
  return {
    metadata: {
      name: "api",
      uid: "uid-1",
      generation: 3,
      annotations: { "deployment.kubernetes.io/revision": "7" },
    },
    spec: { replicas: 2, selector: { matchLabels: { app: "api" } }, template: {} },
    status: { observedGeneration: 3, replicas: 2, updatedReplicas: 2, availableReplicas: 2 },
    ...over,
  };
}

const ROLLING = {
  status: { observedGeneration: 2, replicas: 2, updatedReplicas: 1, availableReplicas: 1 },
};

describe("buildK8sLiveDeployClient — lazy SDK loading + kubeconfig scoping", () => {
  it("never loads the SDK at factory construction, only on the first call, cached after", async () => {
    let loads = 0;
    const { sdk } = makeFakeSdk(() => deployment());
    const client = buildK8sLiveDeployClient(async () => {
      loads++;
      return sdk;
    }, { pollIntervalMs: 0 });
    expect(loads).toBe(0); // constructing the client touched nothing
    await client.deploy({ target: "api", environment: "prod", namespace: NS, kubeconfig: KUBECONFIG });
    expect(loads).toBe(1);
    await client.deploy({ target: "api", environment: "prod", namespace: NS, kubeconfig: KUBECONFIG });
    expect(loads).toBe(1); // loaded once, cached
  });

  it("the per-call kubeconfig credential is what loadFromString receives — threaded, not stored elsewhere", async () => {
    const { sdk, loadedConfigs } = makeFakeSdk(() => deployment());
    const client = buildK8sLiveDeployClient(async () => sdk, { pollIntervalMs: 0 });
    await client.deploy({ target: "api", environment: "prod", namespace: NS, kubeconfig: KUBECONFIG });
    expect(loadedConfigs).toEqual([KUBECONFIG]);
  });
});

describe("buildK8sLiveDeployClient — deploy (server-side apply + rollout watch)", () => {
  it("server-side applies the rollout stamp and watches to completion; deployId is the observed revision", async () => {
    const { sdk, calls } = makeFakeSdk((op, _param, n) => {
      if (op === "patch") return deployment();
      // read 1: existence check; read 2: still rolling; read 3: complete (rev bumped to 8)
      if (n <= 1) return deployment();
      if (n === 2) return deployment(ROLLING);
      return deployment({
        metadata: { name: "api", uid: "uid-1", generation: 3, annotations: { "deployment.kubernetes.io/revision": "8" } },
      });
    });
    const client = buildK8sLiveDeployClient(async () => sdk, { pollIntervalMs: 0 });
    const out = await client.deploy({ target: "api", environment: "prod", namespace: NS, kubeconfig: KUBECONFIG });
    expect(out.deployId).toBe("rev-8"); // the OBSERVED rollout revision
    expect(out.url).toBe(`k8s://${NS}/deployments/api#rev-8`);
    const patch = calls.find((c) => c.op === "patch")!;
    expect(patch.param).toMatchObject({ name: "api", namespace: NS, fieldManager: "regulait-deploy", force: true });
    // a genuine SERVER-SIDE APPLY: the apply-patch content type via setHeaderOptions
    expect(patch.options).toEqual({ headers: { "Content-Type": "application/apply-patch+yaml" } });
    const body = patch.param.body as Record<string, unknown>;
    expect(body).toMatchObject({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "api", namespace: NS } });
    const template = (body.spec as Record<string, unknown>).template as Record<string, unknown>;
    const annotations = (template.metadata as Record<string, unknown>).annotations as Record<string, string>;
    expect(annotations["regulait.dev/environment"]).toBe("prod");
    expect(annotations["regulait.dev/deployed-at"]).toBeTruthy();
  });

  it("a missing target Deployment is an explicit error — apply never creates into the void", async () => {
    const { sdk, calls } = makeFakeSdk((op) => {
      if (op === "read") throw new Error("HTTP 404 Not Found");
      return deployment();
    });
    const client = buildK8sLiveDeployClient(async () => sdk, { pollIntervalMs: 0 });
    await expect(
      client.deploy({ target: "api", environment: "prod", namespace: NS, kubeconfig: KUBECONFIG }),
    ).rejects.toThrow(/deployment 'api' not found in namespace 'team-ns'/);
    expect(calls.filter((c) => c.op === "patch")).toHaveLength(0);
  });

  it("ProgressDeadlineExceeded mid-rollout THROWS, and surfaces through the async KubernetesDeployProvider", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    try {
      const { sdk } = makeFakeSdk((op, _param, n) => {
        if (op === "patch") return deployment();
        if (n <= 2) return deployment(ROLLING);
        return deployment({
          status: {
            observedGeneration: 3,
            replicas: 2,
            updatedReplicas: 1,
            availableReplicas: 1,
            conditions: [
              { type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded", message: "rs api-x has timed out" },
            ],
          },
        });
      });
      const live = buildK8sLiveDeployClient(async () => sdk, { pollIntervalMs: 0 });
      const provider = resolveDeployProvider({
        provider: "kubernetes",
        credential: KUBECONFIG,
        region: NS,
        k8sLiveClient: live,
      });
      await expect(provider.deploy("api", "prod", "seed1234")).rejects.toThrow(
        /ProgressDeadlineExceeded — rs api-x has timed out/,
      );
    } finally {
      delete process.env.REGULAIT_DEPLOY_LIVE;
    }
  });

  it("a rollout that never completes times out and THROWS with the observed progress", async () => {
    const { sdk } = makeFakeSdk((op) => (op === "patch" ? deployment() : deployment(ROLLING)));
    const client = buildK8sLiveDeployClient(async () => sdk, { pollIntervalMs: 0, timeoutMs: 0 });
    await expect(
      client.deploy({ target: "api", environment: "prod", namespace: NS, kubeconfig: KUBECONFIG }),
    ).rejects.toThrow(/did not complete within 0ms/);
  });
});

describe("buildK8sLiveDeployClient — rollback (rollout-undo to the prior ReplicaSet)", () => {
  const RS = (revision: string, owned: boolean, template: Record<string, unknown>) => ({
    metadata: {
      name: `api-${revision}`,
      annotations: { "deployment.kubernetes.io/revision": revision },
      ownerReferences: owned ? [{ uid: "uid-1" }] : [{ uid: "other" }],
    },
    spec: { template },
  });
  const PRIOR_TEMPLATE = {
    metadata: { labels: { app: "api", "pod-template-hash": "abc123" } },
    spec: { containers: [{ name: "api", image: "api:v6" }] },
  };

  it("re-applies the prior OWNED revision's template (pod-template-hash stripped) and watches the undo rollout", async () => {
    const { sdk, calls } = makeFakeSdk((op, _param, n) => {
      if (op === "listRs")
        return {
          items: [
            RS("7", true, { metadata: { labels: { app: "api" } }, spec: {} }), // current
            RS("6", true, PRIOR_TEMPLATE), // the undo target
            RS("5", true, { metadata: {}, spec: {} }),
            RS("9", false, { metadata: {}, spec: {} }), // not owned — ignored
          ],
        };
      if (op === "patch") return deployment();
      return n <= 2 ? deployment(ROLLING) : deployment();
    });
    const client = buildK8sLiveDeployClient(async () => sdk, { pollIntervalMs: 0 });
    const out = await client.rollback({ target: "api", deployId: "rev-7", namespace: NS, kubeconfig: KUBECONFIG });
    expect(out).toEqual({ reverted: "rev-7" });
    expect(calls.find((c) => c.op === "listRs")!.param).toEqual({ namespace: NS, labelSelector: "app=api" });
    const patch = calls.find((c) => c.op === "patch")!;
    const template = (patch.param.body as { spec: { template: Record<string, unknown> } }).spec.template;
    expect(template).toEqual({
      metadata: { labels: { app: "api" } }, // hash label stripped
      spec: { containers: [{ name: "api", image: "api:v6" }] },
    });
    expect(patch.options).toEqual({ headers: { "Content-Type": "application/apply-patch+yaml" } });
  });

  it("no prior owned ReplicaSet revision is an explicit error — nothing known-good to undo to", async () => {
    const { sdk } = makeFakeSdk((op) => {
      if (op === "listRs") return { items: [RS("7", true, PRIOR_TEMPLATE), RS("6", false, PRIOR_TEMPLATE)] };
      return deployment();
    });
    const client = buildK8sLiveDeployClient(async () => sdk, { pollIntervalMs: 0 });
    await expect(
      client.rollback({ target: "api", deployId: "rev-7", namespace: NS, kubeconfig: KUBECONFIG }),
    ).rejects.toThrow(/no prior ReplicaSet revision/);
  });

  it("a prior revision with no pod template refuses to undo", async () => {
    const { sdk } = makeFakeSdk((op) => {
      if (op === "listRs") return { items: [RS("7", true, PRIOR_TEMPLATE), { ...RS("6", true, PRIOR_TEMPLATE), spec: {} }] };
      return deployment();
    });
    const client = buildK8sLiveDeployClient(async () => sdk, { pollIntervalMs: 0 });
    await expect(
      client.rollback({ target: "api", deployId: "rev-7", namespace: NS, kubeconfig: KUBECONFIG }),
    ).rejects.toThrow(/carries no pod template/);
  });
});
