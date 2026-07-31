/**
 * The REAL @azure/* implementation of deploy.ts's AzureLiveDeployClient
 * factory contract — buildable only because the ASYNC-DEPLOY refactor made
 * the client interface Promise-returning.
 *
 * deploy   → DefaultAzureCredential (Entra ID federated/workload identity —
 *            never a static key) → ResourceManagementClient(cred, subscription)
 *            .deployments.beginCreateOrUpdate(resourceGroup, name, {
 *              properties: { mode: "Incremental", templateLink } })
 *            and the returned poller is polled to its TERMINAL state
 *            (pollUntilDone). provisioningState must be 'Succeeded' —
 *            anything else (or a mid-LRO poller rejection) THROWS, so the
 *            caller can never record dryRun:false for an ARM deployment that
 *            did not complete (ADR-0022 honesty).
 * rollback → the contract's revert: exportTemplate of the PRIOR successful
 *            deployment of the same target and beginCreateOrUpdate again with
 *            that template, polled to terminal the same way.
 *
 * Config (threaded by deploy.ts's liveDeployClients() wiring from env):
 *  - REGULAIT_DEPLOY_AZURE_RESOURCE_GROUP — the resource group ARM deployments
 *    run in. REQUIRED for the live path: with no group configured the client
 *    throws an explicit config error instead of guessing.
 *  - REGULAIT_DEPLOY_AZURE_TEMPLATE_URI — the templateLink URI of the
 *    customer's published ARM/Bicep template for this target. REQUIRED for
 *    deploy: an ARM deployment with no template is not a deploy, and this
 *    client refuses to invent one.
 *
 * Discipline (mirrors infra-azure-client.ts exactly): SDK modules are loaded
 * via dynamic import on the FIRST actual call (never at module load or
 * factory construction — flag-off boots SDK-free); one DefaultAzureCredential
 * is built lazily inside the client and never leaves this module; the
 * injectable `loadSdk` seam lets unit tests drive fully fake modules and
 * prove lazy-loading — never the network.
 */

import type { AzureLiveDeployClient } from "./deploy.js";

export class AzureDeployClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AzureDeployClientError";
  }
}

/** the poller surface we drive — beginCreateOrUpdate's SimplePollerLike */
interface ArmPollerLike {
  pollUntilDone(): Promise<Record<string, unknown>>;
}

interface ArmDeploymentsOps {
  /** REAL: PUT .../deployments/{name} — returns the LRO poller */
  beginCreateOrUpdate(
    resourceGroupName: string,
    deploymentName: string,
    parameters: Record<string, unknown>,
  ): Promise<ArmPollerLike>;
  /** REAL: GET .../deployments (paged async iterator) */
  listByResourceGroup(resourceGroupName: string): AsyncIterable<Record<string, unknown>>;
  /** REAL: POST .../deployments/{name}/exportTemplate */
  exportTemplate(
    resourceGroupName: string,
    deploymentName: string,
  ): Promise<Record<string, unknown>>;
}

/** Structural view of the two SDK modules — what the real packages provide
 * and exactly what a test fake must supply. */
export interface AzureDeploySdk {
  identity: { DefaultAzureCredential: new () => unknown };
  armResources: {
    ResourceManagementClient: new (
      credential: unknown,
      subscriptionId: string,
    ) => { deployments: ArmDeploymentsOps };
  };
}

/** REAL loader — dynamic imports so nothing under @azure/* is evaluated until
 * the first live call. Cached so the Promise stays single. */
let realSdk: Promise<AzureDeploySdk> | undefined;
function loadRealSdk(): Promise<AzureDeploySdk> {
  realSdk ??= Promise.all([import("@azure/identity"), import("@azure/arm-resources")]).then(
    ([identity, armResources]) => ({ identity, armResources }) as unknown as AzureDeploySdk,
  );
  return realSdk;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** the deployment-name prefix that scopes deployments to one target */
function targetPrefix(target: string): string {
  return `${target}-`;
}

/**
 * Build the real AzureLiveDeployClient that deploy.ts's liveDeployClients()
 * wiring injects when REGULAIT_DEPLOY_LIVE is on and the deploy target's
 * provider is 'azure'. `loadSdk` is the test seam (defaults to the real lazy
 * dynamic-import loader); `env` is where the resource-group/template config
 * is read from.
 */
export function buildAzureLiveDeployClient(
  loadSdk: () => Promise<AzureDeploySdk> = loadRealSdk,
  env: NodeJS.ProcessEnv = process.env,
): AzureLiveDeployClient {
  // lazy: nothing is loaded until the first method call on the returned client
  let sdkPromise: Promise<AzureDeploySdk> | undefined;
  const sdk = () => (sdkPromise ??= loadSdk());

  // one DefaultAzureCredential, built lazily, held inside this module only
  let credential: unknown;
  async function armClient(subscription: string): Promise<{ deployments: ArmDeploymentsOps }> {
    const s = await sdk();
    credential ??= new s.identity.DefaultAzureCredential();
    return new s.armResources.ResourceManagementClient(credential, subscription);
  }

  function requireResourceGroup(): string {
    const rg = str(env.REGULAIT_DEPLOY_AZURE_RESOURCE_GROUP);
    if (!rg) {
      throw new AzureDeployClientError(
        "azure live deploy needs REGULAIT_DEPLOY_AZURE_RESOURCE_GROUP — the resource group ARM deployments run in is not configured",
      );
    }
    return rg;
  }

  /** run one ARM deployment LRO to terminal and REQUIRE Succeeded */
  async function runDeployment(
    deployments: ArmDeploymentsOps,
    resourceGroup: string,
    name: string,
    properties: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // REAL: PUT the deployment, then poll the LRO to its terminal state. A
    // failed deployment surfaces either as a poller rejection or a terminal
    // provisioningState !== Succeeded — both THROW here.
    const poller = await deployments.beginCreateOrUpdate(resourceGroup, name, { properties });
    const result = rec(await poller.pollUntilDone());
    const state = str(rec(result.properties).provisioningState);
    if (state !== "Succeeded") {
      throw new AzureDeployClientError(
        `arm deployment '${name}' in resource group '${resourceGroup}' ended in provisioningState '${state ?? "unknown"}' — not Succeeded`,
      );
    }
    return result;
  }

  return {
    /** REAL: templateLink deployment of the target, polled to terminal. */
    async deploy(params): Promise<{ deployId: string; url: string }> {
      const resourceGroup = requireResourceGroup();
      const templateUri = str(env.REGULAIT_DEPLOY_AZURE_TEMPLATE_URI);
      if (!templateUri) {
        throw new AzureDeployClientError(
          "azure live deploy needs REGULAIT_DEPLOY_AZURE_TEMPLATE_URI — an ARM deployment with no template is not a deploy; refusing to invent one",
        );
      }
      const client = await armClient(params.subscription);
      // unique per attempt so every deploy is its own ARM deployment record —
      // that history is exactly what rollback's export-prior-template needs
      const name = `${targetPrefix(params.target)}${Date.now().toString(36)}`;
      const result = await runDeployment(client.deployments, resourceGroup, name, {
        mode: "Incremental",
        templateLink: { uri: templateUri },
      });
      const armId = str(result.id);
      return {
        deployId: name,
        url: armId
          ? `https://portal.azure.com/#@/resource${armId}`
          : `https://portal.azure.com/#@/resource/subscriptions/${params.subscription}/resourceGroups/${resourceGroup}/deployments/${name}`,
      };
    },

    /** REAL: find the newest PRIOR successful deployment of this target,
     * export its template, and re-deploy it (the contract's revert). */
    async rollback(params): Promise<{ reverted: string }> {
      const resourceGroup = requireResourceGroup();
      const client = await armClient(params.subscription);
      // the prior known-good state: newest Succeeded deployment of this
      // target that is NOT the one being reversed
      let prior: { name: string; timestamp: string } | null = null;
      for await (const d of client.deployments.listByResourceGroup(resourceGroup)) {
        const name = str(rec(d).name);
        if (!name || !name.startsWith(targetPrefix(params.target)) || name === params.deployId) continue;
        const props = rec(rec(d).properties);
        if (str(props.provisioningState) !== "Succeeded") continue;
        const timestamp = str(props.timestamp) ?? "";
        if (!prior || timestamp > prior.timestamp) prior = { name, timestamp };
      }
      if (!prior) {
        throw new AzureDeployClientError(
          `azure rollback of '${params.deployId}': no prior successful deployment of '${params.target}' exists in resource group '${resourceGroup}' — nothing known-good to revert to`,
        );
      }
      const exported = rec(await client.deployments.exportTemplate(resourceGroup, prior.name));
      const template = rec(exported.template);
      if (Object.keys(template).length === 0) {
        throw new AzureDeployClientError(
          `azure rollback of '${params.deployId}': exportTemplate of prior deployment '${prior.name}' returned no template — cannot revert`,
        );
      }
      await runDeployment(
        client.deployments,
        resourceGroup,
        `${targetPrefix(params.target)}rb${Date.now().toString(36)}`,
        { mode: "Incremental", template },
      );
      return { reverted: params.deployId };
    },
  };
}
