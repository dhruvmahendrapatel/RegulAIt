/**
 * The REAL @kubernetes/client-node implementation of deploy.ts's
 * KubernetesLiveDeployClient factory contract — buildable only because the
 * ASYNC-DEPLOY refactor made the client interface Promise-returning.
 *
 * deploy   → KubeConfig.loadFromString(kubeconfig) (the decrypted deploy
 *            CREDENTIAL, scoped to this one call — never stored) →
 *            AppsV1Api.patchNamespacedDeployment as a SERVER-SIDE APPLY of
 *            the deploy manifest (a rollout-restart-style pod-template
 *            annotation stamp on the existing Deployment named `target`,
 *            field-managed by 'regulait-deploy'), then the rollout is WATCHED
 *            to completion by polling readNamespacedDeployment until the
 *            observed generation catches up and every replica is updated +
 *            available. A ProgressDeadlineExceeded condition or a timeout
 *            THROWS, so the caller can never record dryRun:false for a
 *            rollout that did not complete (ADR-0022 honesty). The reported
 *            deployId is the deployment's OBSERVED rollout revision
 *            (deployment.kubernetes.io/revision) — the applied resource
 *            reported honestly, never an invented id.
 * rollback → the `kubectl rollout undo` equivalent: find the prior
 *            ReplicaSet revision owned by the Deployment, server-side apply
 *            the Deployment's pod template back to that ReplicaSet's
 *            template, and watch that rollout to completion the same way.
 *
 * Discipline (mirrors the other deploy-*-client factories): the SDK module is
 * loaded via dynamic import on the FIRST actual call — never at module load
 * or factory construction, so flag-off boots SDK-free; the injectable
 * `loadSdk` seam lets unit tests drive fully fake modules and prove
 * lazy-loading — never the network.
 */

import type { KubernetesLiveDeployClient } from "./deploy.js";

export class K8sDeployClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "K8sDeployClientError";
  }
}

/** the AppsV1Api surface we drive (client-node 1.x object-param API) */
interface K8sAppsApi {
  readNamespacedDeployment(param: { name: string; namespace: string }): Promise<Record<string, unknown>>;
  patchNamespacedDeployment(
    param: {
      name: string;
      namespace: string;
      body: Record<string, unknown>;
      fieldManager?: string;
      force?: boolean;
    },
    options?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  listNamespacedReplicaSet(param: {
    namespace: string;
    labelSelector?: string;
  }): Promise<Record<string, unknown>>;
}

interface K8sKubeConfigLike {
  loadFromString(config: string): void;
  makeApiClient(apiClientType: unknown): K8sAppsApi;
}

/** Structural view of the SDK module — what the real package provides and
 * exactly what a test fake must supply. */
export interface K8sDeploySdk {
  KubeConfig: new () => K8sKubeConfigLike;
  AppsV1Api: unknown;
  PatchStrategy: { ServerSideApply: string };
  setHeaderOptions(key: string, value: string): Record<string, unknown>;
}

/** REAL loader — a dynamic import so nothing under @kubernetes/client-node is
 * evaluated until the first live call. Cached so the Promise stays single. */
let realSdk: Promise<K8sDeploySdk> | undefined;
function loadRealSdk(): Promise<K8sDeploySdk> {
  realSdk ??= import("@kubernetes/client-node").then((m) => m as unknown as K8sDeploySdk);
  return realSdk;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0 && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REVISION_ANNOTATION = "deployment.kubernetes.io/revision";
const FIELD_MANAGER = "regulait-deploy";

function revisionOf(obj: Record<string, unknown>): string | null {
  return str(rec(rec(obj.metadata).annotations)[REVISION_ANNOTATION]);
}

export interface K8sDeployPollOptions {
  /** delay between rollout-status polls (default 2s; tests pass 0) */
  pollIntervalMs?: number;
  /** give up (and THROW) after this long (default 10 min) */
  timeoutMs?: number;
}

/**
 * Build the real KubernetesLiveDeployClient that deploy.ts's
 * liveDeployClients() wiring injects when REGULAIT_DEPLOY_LIVE is on and the
 * deploy target's provider is 'kubernetes'. `loadSdk` is the test seam
 * (defaults to the real lazy dynamic-import loader).
 */
export function buildK8sLiveDeployClient(
  loadSdk: () => Promise<K8sDeploySdk> = loadRealSdk,
  options: K8sDeployPollOptions = {},
): KubernetesLiveDeployClient {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 600_000;

  // lazy: nothing is loaded until the first method call on the returned client
  let sdkPromise: Promise<K8sDeploySdk> | undefined;
  const sdk = () => (sdkPromise ??= loadSdk());

  /** kubeconfig-SCOPED api client: built from the per-call credential, used
   * for that call, never held */
  async function appsApi(kubeconfig: string): Promise<{ api: K8sAppsApi; s: K8sDeploySdk }> {
    const s = await sdk();
    const kc = new s.KubeConfig();
    kc.loadFromString(kubeconfig);
    return { api: kc.makeApiClient(s.AppsV1Api), s };
  }

  /** REAL: server-side apply (Content-Type: application/apply-patch+yaml,
   * field-managed, forced) of a Deployment manifest fragment */
  async function serverSideApply(
    api: K8sAppsApi,
    s: K8sDeploySdk,
    name: string,
    namespace: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return api.patchNamespacedDeployment(
      { name, namespace, body, fieldManager: FIELD_MANAGER, force: true },
      s.setHeaderOptions("Content-Type", s.PatchStrategy.ServerSideApply),
    );
  }

  /** the `kubectl rollout status` equivalent: poll until the controller has
   * observed the new generation AND every replica is updated + available.
   * ProgressDeadlineExceeded or a timeout THROWS. Returns the final object. */
  async function watchRollout(
    api: K8sAppsApi,
    name: string,
    namespace: string,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const d = await api.readNamespacedDeployment({ name, namespace });
      const generation = num(rec(d.metadata).generation) ?? 0;
      const status = rec(d.status);
      const spec = rec(d.spec);
      const want = num(spec.replicas) ?? 1;
      const observed = num(status.observedGeneration) ?? 0;
      const updated = num(status.updatedReplicas) ?? 0;
      const available = num(status.availableReplicas) ?? 0;
      const total = num(status.replicas) ?? 0;
      const progressing = arr(status.conditions).find((c) => str(c.type) === "Progressing");
      if (
        progressing &&
        str(progressing.status) === "False" &&
        str(progressing.reason) === "ProgressDeadlineExceeded"
      ) {
        throw new K8sDeployClientError(
          `rollout of deployment '${name}' in namespace '${namespace}' FAILED: ProgressDeadlineExceeded — ` +
            (str(progressing.message) ?? "no message"),
        );
      }
      if (observed >= generation && updated === want && available === want && total === want) {
        return d;
      }
      if (Date.now() >= deadline) {
        throw new K8sDeployClientError(
          `rollout of deployment '${name}' in namespace '${namespace}' did not complete within ${timeoutMs}ms ` +
            `(observedGeneration ${observed}/${generation}, updated ${updated}/${want}, available ${available}/${want})`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  return {
    /** REAL: server-side apply the deploy stamp, then watch the rollout. */
    async deploy(params): Promise<{ deployId: string; url: string }> {
      const { api, s } = await appsApi(params.kubeconfig);
      // the target must exist — a deploy stage rolls out an existing
      // Deployment; applying into the void would silently create one
      await api.readNamespacedDeployment({ name: params.target, namespace: params.namespace }).catch((err) => {
        throw new K8sDeployClientError(
          `deployment '${params.target}' not found in namespace '${params.namespace}': ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      // the applied manifest: a pod-template annotation stamp (the rollout-
      // restart pattern) — server-side applied under our field manager
      await serverSideApply(api, s, params.target, params.namespace, {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: params.target, namespace: params.namespace },
        spec: {
          template: {
            metadata: {
              annotations: {
                "regulait.dev/deployed-at": new Date().toISOString(),
                "regulait.dev/environment": params.environment,
              },
            },
          },
        },
      });
      const done = await watchRollout(api, params.target, params.namespace);
      // honest deployId: the OBSERVED rollout revision of the completed apply
      const revision = revisionOf(done) ?? `gen-${num(rec(done.metadata).generation) ?? 0}`;
      return {
        deployId: `rev-${revision}`,
        url: `k8s://${params.namespace}/deployments/${params.target}#rev-${revision}`,
      };
    },

    /** REAL: rollout-undo — re-apply the prior ReplicaSet's pod template. */
    async rollback(params): Promise<{ reverted: string }> {
      const { api, s } = await appsApi(params.kubeconfig);
      const d = await api.readNamespacedDeployment({
        name: params.target,
        namespace: params.namespace,
      });
      const currentRevision = num(revisionOf(d));
      const uid = str(rec(d.metadata).uid);
      const matchLabels = rec(rec(rec(d.spec).selector).matchLabels);
      const labelSelector = Object.entries(matchLabels)
        .filter((e): e is [string, string] => typeof e[1] === "string")
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      const rsList = await api.listNamespacedReplicaSet({
        namespace: params.namespace,
        ...(labelSelector ? { labelSelector } : {}),
      });
      // ReplicaSets OWNED by this Deployment, keyed by rollout revision;
      // the undo target is the highest revision below the current one
      let prior: { revision: number; rs: Record<string, unknown> } | null = null;
      for (const rs of arr(rec(rsList).items)) {
        const owned = arr(rec(rs.metadata).ownerReferences).some(
          (o) => str(o.uid) !== null && str(o.uid) === uid,
        );
        if (!owned) continue;
        const revision = num(revisionOf(rs));
        if (revision === null) continue;
        if (currentRevision !== null && revision >= currentRevision) continue;
        if (!prior || revision > prior.revision) prior = { revision, rs };
      }
      if (!prior) {
        throw new K8sDeployClientError(
          `rollback of '${params.deployId}': deployment '${params.target}' in namespace '${params.namespace}' has no prior ReplicaSet revision — nothing known-good to undo to`,
        );
      }
      const template = rec(rec(prior.rs.spec).template);
      if (Object.keys(template).length === 0) {
        throw new K8sDeployClientError(
          `rollback of '${params.deployId}': prior ReplicaSet revision ${prior.revision} carries no pod template — cannot undo`,
        );
      }
      // strip the RS-only pod-template-hash label before re-applying
      const meta = rec(template.metadata);
      const labels = { ...rec(meta.labels) };
      delete labels["pod-template-hash"];
      const undoTemplate = {
        ...template,
        metadata: { ...meta, labels },
      };
      await serverSideApply(api, s, params.target, params.namespace, {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: params.target, namespace: params.namespace },
        spec: { template: undoTemplate },
      });
      await watchRollout(api, params.target, params.namespace);
      return { reverted: params.deployId };
    },
  };
}
