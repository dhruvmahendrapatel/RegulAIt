/**
 * The REAL @google-cloud/config (Infrastructure Manager — Deployment
 * Manager's successor; package name verified: "Infrastructure Manager API
 * client for Node.js") implementation of deploy.ts's GcpLiveDeployClient
 * factory contract — buildable only because the ASYNC-DEPLOY refactor made
 * the client interface Promise-returning.
 *
 * deploy   → ADC / workload identity federation (never a static SA key) →
 *            ConfigClient.createDeployment (or updateDeployment when the
 *            deployment already exists) with the configured Terraform
 *            blueprint, and the returned LRO is AWAITED TO DONE
 *            (operation.promise()). The finished Deployment's state must be
 *            ACTIVE — a FAILED state (or a mid-LRO rejection, which is how a
 *            failed Infra Manager operation surfaces) THROWS, so the caller
 *            can never record dryRun:false for a deployment that did not
 *            complete (ADR-0022 honesty).
 * rollback → the contract's revert: list the deployment's revisions, take the
 *            newest PRIOR revision's blueprint, and updateDeployment back to
 *            it, LRO awaited to done the same way.
 *
 * Config (threaded by deploy.ts's liveDeployClients() wiring from env):
 *  - REGULAIT_DEPLOY_GCP_BLUEPRINT_GCS — the gs:// URI of the customer's
 *    Terraform blueprint for this target. REQUIRED for deploy: an Infra
 *    Manager deployment with no blueprint is not a deploy, and this client
 *    refuses to invent one.
 *
 * Discipline (mirrors infra-gcp-client.ts): the SDK module is loaded via
 * dynamic import on the FIRST actual call — never at module load or factory
 * construction, so flag-off boots SDK-free; the injectable `loadSdk` seam
 * lets unit tests drive fully fake modules and prove lazy-loading — never
 * the network.
 */

import type { GcpLiveDeployClient } from "./deploy.js";

export class GcpDeployClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GcpDeployClientError";
  }
}

/** the LRO surface we drive — gax's Operation */
interface GcpOperationLike {
  promise(): Promise<unknown[]>;
}

interface GcpConfigClientLike {
  /** REAL: GET .../deployments/{d} — used only to pick create vs update */
  getDeployment(request: { name: string }): Promise<unknown[]>;
  /** REAL: POST .../deployments — returns [LRO] */
  createDeployment(request: Record<string, unknown>): Promise<unknown[]>;
  /** REAL: PATCH .../deployments/{d} — returns [LRO] */
  updateDeployment(request: Record<string, unknown>): Promise<unknown[]>;
  /** REAL: GET .../deployments/{d}/revisions — returns [revisions[]] */
  listRevisions(request: { parent: string }): Promise<unknown[]>;
}

/** Structural view of the SDK module — what the real package provides and
 * exactly what a test fake must supply. */
export interface GcpDeploySdk {
  config: { ConfigClient: new () => GcpConfigClientLike };
}

/** REAL loader — a dynamic import so nothing under @google-cloud/* is
 * evaluated until the first live call. Cached so the Promise stays single. */
let realSdk: Promise<GcpDeploySdk> | undefined;
function loadRealSdk(): Promise<GcpDeploySdk> {
  realSdk ??= import("@google-cloud/config").then(
    (config) => ({ config }) as unknown as GcpDeploySdk,
  );
  return realSdk;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}

/** grpc NOT_FOUND — the one status that legitimately routes create-vs-update */
function isNotFound(err: unknown): boolean {
  return rec(err).code === 5;
}

/** a sortable key for a protobuf Timestamp ({seconds,nanos}) or ISO string */
function timeKey(v: unknown): number {
  const seconds = rec(v).seconds;
  if (typeof seconds === "number") return seconds;
  if (typeof seconds === "string" && seconds.length > 0) return Number(seconds);
  if (typeof v === "string" && v.length > 0) return Date.parse(v) || 0;
  return 0;
}

/**
 * Build the real GcpLiveDeployClient that deploy.ts's liveDeployClients()
 * wiring injects when REGULAIT_DEPLOY_LIVE is on and the deploy target's
 * provider is 'gcp'. `loadSdk` is the test seam (defaults to the real lazy
 * dynamic-import loader); `env` is where the blueprint config is read from.
 */
export function buildGcpLiveDeployClient(
  loadSdk: () => Promise<GcpDeploySdk> = loadRealSdk,
  env: NodeJS.ProcessEnv = process.env,
): GcpLiveDeployClient {
  // lazy: nothing is loaded until the first method call on the returned client
  let sdkPromise: Promise<GcpDeploySdk> | undefined;
  const sdk = () => (sdkPromise ??= loadSdk());

  // one ConfigClient, built lazily on first use (ADC/WIF happens inside it)
  let client: GcpConfigClientLike | undefined;
  async function configClient(): Promise<GcpConfigClientLike> {
    const s = await sdk();
    client ??= new s.config.ConfigClient();
    return client;
  }

  /** await an [operation] response's LRO to done and REQUIRE an ACTIVE
   * deployment. A failed operation REJECTS from promise(); a done-but-FAILED
   * deployment state THROWS here. Either way: never a success shape. */
  async function awaitDeploymentLro(
    response: unknown[],
    what: string,
  ): Promise<Record<string, unknown>> {
    const operation = response[0] as GcpOperationLike | undefined;
    if (!operation || typeof operation.promise !== "function") {
      throw new GcpDeployClientError(`${what} returned no long-running operation — not confirmed`);
    }
    // REAL: the Infra Manager LRO awaited to done — this is the poll-to-
    // terminal step; a mid-LRO failure rejects and propagates as a throw.
    const [deployment] = await operation.promise();
    const d = rec(deployment);
    const state = str(d.state);
    if (state !== "ACTIVE") {
      const detail =
        str(d.stateDetail) ?? str(d.errorCode) ?? "no detail reported";
      throw new GcpDeployClientError(
        `${what} finished in state '${state ?? "unknown"}' (${detail}) — not ACTIVE`,
      );
    }
    return d;
  }

  return {
    /** REAL: create/apply the Infra Manager deployment, LRO awaited to done. */
    async deploy(params): Promise<{ deployId: string; url: string }> {
      const blueprintGcs = str(env.REGULAIT_DEPLOY_GCP_BLUEPRINT_GCS);
      if (!blueprintGcs) {
        throw new GcpDeployClientError(
          "gcp live deploy needs REGULAIT_DEPLOY_GCP_BLUEPRINT_GCS — an Infra Manager deployment with no Terraform blueprint is not a deploy; refusing to invent one",
        );
      }
      const c = await configClient();
      const parent = `projects/${params.project}/locations/${params.region}`;
      const name = `${parent}/deployments/${params.target}`;
      const blueprint = { terraformBlueprint: { gcsSource: blueprintGcs } };
      let response: unknown[];
      try {
        await c.getDeployment({ name });
        // exists → apply as an update (a new revision of the same deployment)
        response = await c.updateDeployment({ deployment: { name, ...blueprint } });
      } catch (err) {
        if (!isNotFound(err)) throw err;
        response = await c.createDeployment({
          parent,
          deploymentId: params.target,
          deployment: blueprint,
        });
      }
      const done = await awaitDeploymentLro(
        response,
        `infra-manager deployment of '${params.target}'`,
      );
      return {
        deployId: str(done.name) ?? name,
        url: `https://console.cloud.google.com/config/deployments/${params.region}/${params.target}?project=${params.project}`,
      };
    },

    /** REAL: revert to the newest PRIOR revision's blueprint via
     * updateDeployment, LRO awaited to done. */
    async rollback(params): Promise<{ reverted: string }> {
      const c = await configClient();
      const name = `projects/${params.project}/locations/${params.region}/deployments/${params.target}`;
      const [revisionList] = await c.listRevisions({ parent: name });
      // newest first by createTime; the deployment's current state is the
      // newest revision — the revert target is the one before it
      const revisions = arr(revisionList).sort(
        (a, b) => timeKey(b.createTime) - timeKey(a.createTime),
      );
      const prior = revisions[1];
      if (!prior) {
        throw new GcpDeployClientError(
          `gcp rollback of '${params.deployId}': deployment '${params.target}' has no prior revision — nothing known-good to revert to`,
        );
      }
      const priorBlueprint = rec(prior.terraformBlueprint);
      if (Object.keys(priorBlueprint).length === 0) {
        throw new GcpDeployClientError(
          `gcp rollback of '${params.deployId}': prior revision '${str(prior.name) ?? "?"}' carries no terraform blueprint — cannot revert`,
        );
      }
      const response = await c.updateDeployment({
        deployment: { name, terraformBlueprint: priorBlueprint },
      });
      await awaitDeploymentLro(response, `infra-manager rollback of '${params.target}'`);
      return { reverted: params.deployId };
    },
  };
}
