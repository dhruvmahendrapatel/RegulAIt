import { describe, expect, it } from "vitest";
import { buildAzureLiveDeployClient, type AzureDeploySdk } from "./deploy-azure-client.js";
import { resolveDeployProvider } from "./deploy.js";

/**
 * The REAL Azure deploy live client (ARM deployments.beginCreateOrUpdate +
 * poll-to-terminal branch of the AzureLiveDeployClient contract), unblocked by
 * the ASYNC-DEPLOY refactor. Proves, with fully fake SDK modules and never
 * the network:
 *   · the factory is LAZY — no SDK module is loaded at construction, only on
 *     the first actual call; a CONFIG error even rejects before any SDK load;
 *   · deploy = ONE DefaultAzureCredential →
 *     ResourceManagementClient(cred, subscription).deployments
 *     .beginCreateOrUpdate(resourceGroup, name, {mode Incremental,
 *     templateLink}) with the poller POLLED TO ITS TERMINAL STATE
 *     (pollUntilDone) — success requires provisioningState 'Succeeded';
 *   · a terminal 'Failed' state or a mid-LRO poller rejection THROWS — never
 *     a success-shaped result — and surfaces through the (now async)
 *     AzureDeployProvider deploy path;
 *   · config comes from env (REGULAIT_DEPLOY_AZURE_RESOURCE_GROUP /
 *     _TEMPLATE_URI) and the subscription/region thread per call;
 *   · rollback exports the template of the newest PRIOR successful deployment
 *     of the same target and re-deploys it.
 * Pure unit tests — no DB, no network, no real Azure.
 */

const SUB = "00000000-1111-2222-3333-444444444444";
const ENV = {
  REGULAIT_DEPLOY_AZURE_RESOURCE_GROUP: "rg-app",
  REGULAIT_DEPLOY_AZURE_TEMPLATE_URI: "https://store.example/checkout.json",
} as NodeJS.ProcessEnv;

interface Recorded {
  op: string;
  args: unknown[];
}

function makeFakeSdk(respond: (op: string, args: unknown[]) => unknown) {
  const calls: Recorded[] = [];
  const credentials: number[] = [];
  const clients: { subscription: string }[] = [];
  const record = (op: string, args: unknown[]) => {
    calls.push({ op, args });
    return respond(op, args);
  };
  const sdk = {
    identity: {
      DefaultAzureCredential: class {
        constructor() {
          credentials.push(1);
        }
      },
    },
    armResources: {
      ResourceManagementClient: class {
        deployments = {
          beginCreateOrUpdate: async (rg: string, name: string, params: Record<string, unknown>) => ({
            pollUntilDone: async () => record("beginCreateOrUpdate", [rg, name, params]),
          }),
          listByResourceGroup: (rg: string) => {
            const rows = record("listByResourceGroup", [rg]) as Record<string, unknown>[];
            return (async function* () {
              yield* rows;
            })();
          },
          exportTemplate: async (rg: string, name: string) => record("exportTemplate", [rg, name]),
        };
        constructor(_credential: unknown, subscription: string) {
          clients.push({ subscription });
        }
      },
    },
  } as unknown as AzureDeploySdk;
  return { sdk, calls, credentials, clients };
}

const SUCCEEDED = (name: string) => ({
  id: `/subscriptions/${SUB}/resourceGroups/rg-app/providers/Microsoft.Resources/deployments/${name}`,
  name,
  properties: { provisioningState: "Succeeded" },
});

describe("buildAzureLiveDeployClient — lazy SDK loading + config errors", () => {
  it("never loads the SDK at factory construction, only on the first real call", async () => {
    let loads = 0;
    const { sdk } = makeFakeSdk((op, args) => SUCCEEDED(String((args as string[])[1])));
    const client = buildAzureLiveDeployClient(async () => {
      loads++;
      return sdk;
    }, ENV);
    expect(loads).toBe(0); // constructing the client touched nothing
    await client.deploy({ target: "web", environment: "prod", region: "eastus", subscription: SUB });
    expect(loads).toBe(1);
    await client.deploy({ target: "web", environment: "prod", region: "eastus", subscription: SUB });
    expect(loads).toBe(1); // loaded once, cached
  });

  it("missing REGULAIT_DEPLOY_AZURE_RESOURCE_GROUP rejects explicitly BEFORE any SDK load", async () => {
    let loads = 0;
    const { sdk } = makeFakeSdk(() => ({}));
    const client = buildAzureLiveDeployClient(async () => {
      loads++;
      return sdk;
    }, {} as NodeJS.ProcessEnv);
    await expect(
      client.deploy({ target: "web", environment: "prod", region: "eastus", subscription: SUB }),
    ).rejects.toThrow(/REGULAIT_DEPLOY_AZURE_RESOURCE_GROUP/);
    await expect(
      client.rollback({ target: "web", deployId: "d", region: "eastus", subscription: SUB }),
    ).rejects.toThrow(/REGULAIT_DEPLOY_AZURE_RESOURCE_GROUP/);
    expect(loads).toBe(0); // config refused before touching @azure/*
  });

  it("missing REGULAIT_DEPLOY_AZURE_TEMPLATE_URI refuses to invent a template, no ARM call", async () => {
    const { sdk, calls } = makeFakeSdk(() => ({}));
    const client = buildAzureLiveDeployClient(async () => sdk, {
      REGULAIT_DEPLOY_AZURE_RESOURCE_GROUP: "rg-app",
    } as NodeJS.ProcessEnv);
    await expect(
      client.deploy({ target: "web", environment: "prod", region: "eastus", subscription: SUB }),
    ).rejects.toThrow(/REGULAIT_DEPLOY_AZURE_TEMPLATE_URI/);
    expect(calls).toHaveLength(0);
  });
});

describe("buildAzureLiveDeployClient — deploy (ARM LRO polled to terminal)", () => {
  it("beginCreateOrUpdate(rg, target-scoped name, Incremental templateLink) → pollUntilDone → Succeeded; one credential; subscription threaded", async () => {
    const { sdk, calls, credentials, clients } = makeFakeSdk((_op, args) =>
      SUCCEEDED(String((args as string[])[1])),
    );
    const client = buildAzureLiveDeployClient(async () => sdk, ENV);
    const out = await client.deploy({ target: "web", environment: "prod", region: "eastus", subscription: SUB });
    const call = calls[0]!;
    expect(call.op).toBe("beginCreateOrUpdate");
    expect(call.args[0]).toBe("rg-app"); // env-threaded resource group
    expect(String(call.args[1])).toMatch(/^web-/); // target-scoped deployment name
    expect(call.args[2]).toEqual({
      properties: { mode: "Incremental", templateLink: { uri: "https://store.example/checkout.json" } },
    });
    expect(out.deployId).toBe(String(call.args[1]));
    expect(out.url).toContain("/deployments/");
    expect(credentials).toHaveLength(1); // exactly one DefaultAzureCredential
    expect(clients[0]).toEqual({ subscription: SUB }); // per-call subscription threading
  });

  it("a terminal provisioningState !== Succeeded THROWS — never a success shape", async () => {
    const { sdk } = makeFakeSdk(() => ({ properties: { provisioningState: "Failed" } }));
    const client = buildAzureLiveDeployClient(async () => sdk, ENV);
    await expect(
      client.deploy({ target: "web", environment: "prod", region: "eastus", subscription: SUB }),
    ).rejects.toThrow(/provisioningState 'Failed' — not Succeeded/);
  });

  it("a mid-LRO poller rejection propagates as a throw, and surfaces through the async AzureDeployProvider", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    try {
      const { sdk } = makeFakeSdk(() => {
        throw new Error("ARM deployment quota exceeded mid-poll");
      });
      const live = buildAzureLiveDeployClient(async () => sdk, ENV);
      const provider = resolveDeployProvider({
        provider: "azure",
        roleArn: SUB,
        region: "eastus",
        azureLiveClient: live,
      });
      await expect(provider.deploy("web", "prod", "seed1234")).rejects.toThrow(/quota exceeded mid-poll/);
    } finally {
      delete process.env.REGULAIT_DEPLOY_LIVE;
    }
  });
});

describe("buildAzureLiveDeployClient — rollback (export prior template, re-deploy)", () => {
  const HISTORY = [
    { name: "web-old1", properties: { provisioningState: "Succeeded", timestamp: "2026-07-01T00:00:00Z" } },
    { name: "web-old2", properties: { provisioningState: "Succeeded", timestamp: "2026-07-20T00:00:00Z" } },
    { name: "web-broken", properties: { provisioningState: "Failed", timestamp: "2026-07-25T00:00:00Z" } },
    { name: "api-newer", properties: { provisioningState: "Succeeded", timestamp: "2026-07-29T00:00:00Z" } },
    { name: "web-current", properties: { provisioningState: "Succeeded", timestamp: "2026-07-30T00:00:00Z" } },
  ];

  it("picks the newest PRIOR successful deployment of the SAME target, exports its template, re-deploys, polls to Succeeded", async () => {
    const { sdk, calls } = makeFakeSdk((op, args) => {
      if (op === "listByResourceGroup") return HISTORY;
      if (op === "exportTemplate") return { template: { resources: [{ prior: true }] } };
      return SUCCEEDED(String((args as string[])[1]));
    });
    const client = buildAzureLiveDeployClient(async () => sdk, ENV);
    const out = await client.rollback({ target: "web", deployId: "web-current", region: "eastus", subscription: SUB });
    expect(out).toEqual({ reverted: "web-current" });
    // web-old2 wins: newest Succeeded web-* that is not the reverted deploy
    // (web-broken Failed and api-newer other-target are both skipped)
    expect(calls.find((c) => c.op === "exportTemplate")!.args).toEqual(["rg-app", "web-old2"]);
    const redeploy = calls.find((c) => c.op === "beginCreateOrUpdate")!;
    expect(String(redeploy.args[1])).toMatch(/^web-rb/);
    expect(redeploy.args[2]).toEqual({
      properties: { mode: "Incremental", template: { resources: [{ prior: true }] } },
    });
  });

  it("no prior successful deployment of the target is an explicit error", async () => {
    const { sdk } = makeFakeSdk((op) =>
      op === "listByResourceGroup"
        ? [{ name: "web-current", properties: { provisioningState: "Succeeded", timestamp: "2026-07-30T00:00:00Z" } }]
        : {},
    );
    const client = buildAzureLiveDeployClient(async () => sdk, ENV);
    await expect(
      client.rollback({ target: "web", deployId: "web-current", region: "eastus", subscription: SUB }),
    ).rejects.toThrow(/nothing known-good to revert to/);
  });

  it("an exportTemplate response with no template refuses to revert", async () => {
    const { sdk } = makeFakeSdk((op) => {
      if (op === "listByResourceGroup") return HISTORY;
      if (op === "exportTemplate") return {};
      return {};
    });
    const client = buildAzureLiveDeployClient(async () => sdk, ENV);
    await expect(
      client.rollback({ target: "web", deployId: "web-current", region: "eastus", subscription: SUB }),
    ).rejects.toThrow(/returned no template/);
  });

  it("a rollback re-deploy that ends non-Succeeded THROWS", async () => {
    const { sdk } = makeFakeSdk((op) => {
      if (op === "listByResourceGroup") return HISTORY;
      if (op === "exportTemplate") return { template: { resources: [] } };
      return { properties: { provisioningState: "Canceled" } };
    });
    const client = buildAzureLiveDeployClient(async () => sdk, ENV);
    await expect(
      client.rollback({ target: "web", deployId: "web-current", region: "eastus", subscription: SUB }),
    ).rejects.toThrow(/provisioningState 'Canceled'/);
  });
});
