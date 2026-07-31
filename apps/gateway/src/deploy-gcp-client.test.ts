import { describe, expect, it } from "vitest";
import { buildGcpLiveDeployClient, type GcpDeploySdk } from "./deploy-gcp-client.js";
import { resolveDeployProvider } from "./deploy.js";

/**
 * The REAL GCP deploy live client (@google-cloud/config — Infrastructure
 * Manager — branch of the GcpLiveDeployClient contract), unblocked by the
 * ASYNC-DEPLOY refactor. Proves, with fully fake SDK modules and never the
 * network:
 *   · the factory is LAZY — no SDK module is loaded at construction, only on
 *     the first actual call; a CONFIG error even rejects before any SDK load;
 *   · deploy = create/apply of the Infra Manager deployment (createDeployment
 *     for a new target, updateDeployment when it already exists — routed by a
 *     real NOT_FOUND, nothing else) with the LRO AWAITED TO DONE
 *     (operation.promise()) — success requires a terminal state of ACTIVE;
 *   · a FAILED terminal state or a mid-LRO rejection THROWS — never a
 *     success-shaped result — and surfaces through the (now async)
 *     GcpDeployProvider deploy path;
 *   · config comes from env (REGULAIT_DEPLOY_GCP_BLUEPRINT_GCS) and the
 *     project/region thread into the documented parent/name strings;
 *   · rollback lists the deployment's revisions and updateDeployments back to
 *     the newest PRIOR revision's terraform blueprint.
 * Pure unit tests — no DB, no network, no real GCP.
 */

const PROJECT = "regulait-prod";
const REGION = "us-central1";
const PARENT = `projects/${PROJECT}/locations/${REGION}`;
const NAME = `${PARENT}/deployments/svc`;
const ENV = { REGULAIT_DEPLOY_GCP_BLUEPRINT_GCS: "gs://blueprints/svc.tar.gz" } as NodeJS.ProcessEnv;

interface Recorded {
  op: string;
  req: Record<string, unknown>;
}

function lro(result: unknown) {
  return [{ promise: async () => [result] }];
}

function makeFakeSdk(respond: (op: string, req: Record<string, unknown>) => unknown) {
  const calls: Recorded[] = [];
  const constructed: number[] = [];
  const record = (op: string, req: Record<string, unknown>) => {
    calls.push({ op, req });
    return respond(op, req);
  };
  const sdk = {
    config: {
      ConfigClient: class {
        constructor() {
          constructed.push(1);
        }
        async getDeployment(req: Record<string, unknown>) {
          return [record("getDeployment", req)];
        }
        async createDeployment(req: Record<string, unknown>) {
          return record("createDeployment", req);
        }
        async updateDeployment(req: Record<string, unknown>) {
          return record("updateDeployment", req);
        }
        async listRevisions(req: Record<string, unknown>) {
          return [record("listRevisions", req)];
        }
      },
    },
  } as unknown as GcpDeploySdk;
  return { sdk, calls, constructed };
}

const notFound = () => Object.assign(new Error("5 NOT_FOUND"), { code: 5 });

describe("buildGcpLiveDeployClient — lazy SDK loading + config errors", () => {
  it("never loads the SDK at factory construction, only on the first real call, cached after", async () => {
    let loads = 0;
    const { sdk } = makeFakeSdk((op) => {
      if (op === "getDeployment") return { name: NAME };
      return lro({ name: NAME, state: "ACTIVE" });
    });
    const client = buildGcpLiveDeployClient(async () => {
      loads++;
      return sdk;
    }, ENV);
    expect(loads).toBe(0); // constructing the client touched nothing
    await client.deploy({ target: "svc", environment: "prod", region: REGION, project: PROJECT });
    expect(loads).toBe(1);
    await client.deploy({ target: "svc", environment: "prod", region: REGION, project: PROJECT });
    expect(loads).toBe(1); // loaded once, cached
  });

  it("missing REGULAIT_DEPLOY_GCP_BLUEPRINT_GCS refuses to invent a blueprint, BEFORE any SDK load", async () => {
    let loads = 0;
    const { sdk } = makeFakeSdk(() => ({}));
    const client = buildGcpLiveDeployClient(async () => {
      loads++;
      return sdk;
    }, {} as NodeJS.ProcessEnv);
    await expect(
      client.deploy({ target: "svc", environment: "prod", region: REGION, project: PROJECT }),
    ).rejects.toThrow(/REGULAIT_DEPLOY_GCP_BLUEPRINT_GCS/);
    expect(loads).toBe(0); // config refused before touching @google-cloud/*
  });
});

describe("buildGcpLiveDeployClient — deploy (Infra Manager LRO awaited to done)", () => {
  it("existing deployment → updateDeployment with the blueprint; parent/name strings exact; LRO awaited; ACTIVE required", async () => {
    const { sdk, calls, constructed } = makeFakeSdk((op) => {
      if (op === "getDeployment") return { name: NAME };
      return lro({ name: NAME, state: "ACTIVE" });
    });
    const client = buildGcpLiveDeployClient(async () => sdk, ENV);
    const out = await client.deploy({ target: "svc", environment: "prod", region: REGION, project: PROJECT });
    expect(calls[0]).toEqual({ op: "getDeployment", req: { name: NAME } });
    expect(calls[1]).toEqual({
      op: "updateDeployment",
      req: { deployment: { name: NAME, terraformBlueprint: { gcsSource: "gs://blueprints/svc.tar.gz" } } },
    });
    expect(out.deployId).toBe(NAME);
    expect(out.url).toContain(`${REGION}/svc`);
    expect(out.url).toContain(`project=${PROJECT}`);
    expect(constructed).toHaveLength(1); // one ADC/WIF ConfigClient, reused
  });

  it("new deployment (real NOT_FOUND) → createDeployment({parent, deploymentId, blueprint})", async () => {
    const { sdk, calls } = makeFakeSdk((op) => {
      if (op === "getDeployment") throw notFound();
      return lro({ name: NAME, state: "ACTIVE" });
    });
    const client = buildGcpLiveDeployClient(async () => sdk, ENV);
    const out = await client.deploy({ target: "svc", environment: "prod", region: REGION, project: PROJECT });
    expect(calls[1]).toEqual({
      op: "createDeployment",
      req: {
        parent: PARENT,
        deploymentId: "svc",
        deployment: { terraformBlueprint: { gcsSource: "gs://blueprints/svc.tar.gz" } },
      },
    });
    expect(out.deployId).toBe(NAME);
  });

  it("a non-NOT_FOUND getDeployment error propagates — never silently rerouted to create", async () => {
    const { sdk, calls } = makeFakeSdk((op) => {
      if (op === "getDeployment") throw Object.assign(new Error("7 PERMISSION_DENIED"), { code: 7 });
      return lro({ name: NAME, state: "ACTIVE" });
    });
    const client = buildGcpLiveDeployClient(async () => sdk, ENV);
    await expect(
      client.deploy({ target: "svc", environment: "prod", region: REGION, project: PROJECT }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(calls.map((c) => c.op)).toEqual(["getDeployment"]);
  });

  it("a done-but-FAILED deployment state THROWS with the detail — never a success shape", async () => {
    const { sdk } = makeFakeSdk((op) => {
      if (op === "getDeployment") return { name: NAME };
      return lro({ name: NAME, state: "FAILED", stateDetail: "terraform apply error" });
    });
    const client = buildGcpLiveDeployClient(async () => sdk, ENV);
    await expect(
      client.deploy({ target: "svc", environment: "prod", region: REGION, project: PROJECT }),
    ).rejects.toThrow(/state 'FAILED' \(terraform apply error\)/);
  });

  it("a mid-LRO rejection (operation.promise() rejects) propagates through the async GcpDeployProvider", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    try {
      const { sdk } = makeFakeSdk((op) => {
        if (op === "getDeployment") return { name: NAME };
        return [{ promise: async () => Promise.reject(new Error("operation failed: quota")) }];
      });
      const live = buildGcpLiveDeployClient(async () => sdk, ENV);
      const provider = resolveDeployProvider({
        provider: "gcp",
        roleArn: PROJECT,
        region: REGION,
        gcpLiveClient: live,
      });
      await expect(provider.deploy("svc", "prod", "seed1234")).rejects.toThrow(/operation failed: quota/);
    } finally {
      delete process.env.REGULAIT_DEPLOY_LIVE;
    }
  });

  it("a response with no LRO is an explicit error — an unconfirmed deploy never succeeds", async () => {
    const { sdk } = makeFakeSdk((op) => {
      if (op === "getDeployment") return { name: NAME };
      return [];
    });
    const client = buildGcpLiveDeployClient(async () => sdk, ENV);
    await expect(
      client.deploy({ target: "svc", environment: "prod", region: REGION, project: PROJECT }),
    ).rejects.toThrow(/no long-running operation/);
  });
});

describe("buildGcpLiveDeployClient — rollback (prior revision's blueprint)", () => {
  const REVISIONS = [
    {
      name: `${NAME}/revisions/r-2`,
      createTime: { seconds: "1753900000" },
      terraformBlueprint: { gcsSource: "gs://blueprints/svc-v2.tar.gz" },
    },
    {
      name: `${NAME}/revisions/r-3`,
      createTime: { seconds: "1753990000" },
      terraformBlueprint: { gcsSource: "gs://blueprints/svc-v3.tar.gz" },
    },
    {
      name: `${NAME}/revisions/r-1`,
      createTime: { seconds: "1753800000" },
      terraformBlueprint: { gcsSource: "gs://blueprints/svc-v1.tar.gz" },
    },
  ];

  it("updateDeployment back to the newest PRIOR revision's blueprint, LRO awaited to done", async () => {
    const { sdk, calls } = makeFakeSdk((op) => {
      if (op === "listRevisions") return REVISIONS;
      return lro({ name: NAME, state: "ACTIVE" });
    });
    const client = buildGcpLiveDeployClient(async () => sdk, ENV);
    const out = await client.rollback({ target: "svc", deployId: NAME, region: REGION, project: PROJECT });
    expect(out).toEqual({ reverted: NAME });
    expect(calls[0]).toEqual({ op: "listRevisions", req: { parent: NAME } });
    // r-3 is the current (newest) revision; r-2 is the revert target
    expect(calls[1]).toEqual({
      op: "updateDeployment",
      req: { deployment: { name: NAME, terraformBlueprint: { gcsSource: "gs://blueprints/svc-v2.tar.gz" } } },
    });
  });

  it("a single-revision deployment has nothing to revert to — explicit error", async () => {
    const { sdk } = makeFakeSdk((op) => {
      if (op === "listRevisions") return [REVISIONS[1]];
      return lro({ name: NAME, state: "ACTIVE" });
    });
    const client = buildGcpLiveDeployClient(async () => sdk, ENV);
    await expect(
      client.rollback({ target: "svc", deployId: NAME, region: REGION, project: PROJECT }),
    ).rejects.toThrow(/no prior revision/);
  });

  it("a rollback whose LRO ends FAILED throws", async () => {
    const { sdk } = makeFakeSdk((op) => {
      if (op === "listRevisions") return REVISIONS;
      return lro({ name: NAME, state: "FAILED", errorCode: "REVISION_FAILED" });
    });
    const client = buildGcpLiveDeployClient(async () => sdk, ENV);
    await expect(
      client.rollback({ target: "svc", deployId: NAME, region: REGION, project: PROJECT }),
    ).rejects.toThrow(/REVISION_FAILED/);
  });
});
