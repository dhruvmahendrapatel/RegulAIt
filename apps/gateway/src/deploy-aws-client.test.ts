import { describe, expect, it } from "vitest";
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { buildAwsLiveDeployClient, type AwsDeploySdk } from "./deploy-aws-client.js";
import { resolveDeployProvider } from "./deploy.js";

/**
 * The REAL AWS deploy live client (ECS update-service branch of the
 * AwsLiveDeployClient contract), unblocked by the ASYNC-DEPLOY refactor.
 * Proves, with fully fake SDK modules and never the network:
 *   · the factory is LAZY — no SDK module is loaded at construction, only on
 *     the first actual call (flag-off gateways never touch @aws-sdk/client-ecs);
 *   · assumeRole sends the genuine AssumeRoleCommand through an
 *     STSClient({region}) and the short-lived credentials stay inside the
 *     module (threaded into the per-call ECS client, never returned);
 *   · deploy = UpdateService({cluster: environment, service: target,
 *     forceNewDeployment}) POLLED to the PRIMARY deployment's terminal
 *     rollout state — success only on COMPLETED;
 *   · a mid-LRO FAILED rollout (or timeout, or a superseded deployment)
 *     THROWS — never a success-shaped result — and that rejection surfaces
 *     through the (now async) AwsDeployProvider deploy path;
 *   · rollback re-points the service at task-definition revision N-1 on the
 *     configured cluster and polls that rollout the same way.
 * Pure unit tests — no DB, no network, no real AWS.
 */

const ROLE = "arn:aws:iam::123456789012:role/regulait-deploy";

interface Recorded {
  client: string;
  op: string;
  input: Record<string, unknown>;
}

function makeFakeSdk(respond: (op: string, input: Record<string, unknown>, n: number) => unknown) {
  const calls: Recorded[] = [];
  const constructed: Record<string, unknown>[] = [];
  let describeCount = 0;
  class FakeCommand {
    constructor(
      public readonly __op: string,
      public readonly input: Record<string, unknown>,
    ) {}
  }
  const sdk = {
    sts: {
      STSClient: class {
        constructor(public readonly config: { region: string }) {
          constructed.push({ client: "sts", ...config });
        }
        async send(command: unknown) {
          const input = (command as { input: Record<string, unknown> }).input;
          calls.push({ client: "sts", op: "AssumeRole", input });
          return respond("AssumeRole", input, 0);
        }
      },
    },
    ecs: {
      ECSClient: class {
        constructor(public readonly config: Record<string, unknown>) {
          constructed.push({ client: "ecs", ...config });
        }
        async send(command: unknown) {
          const c = command as FakeCommand;
          const n = c.__op === "DescribeServices" ? ++describeCount : 0;
          calls.push({ client: "ecs", op: c.__op, input: c.input });
          return respond(c.__op, c.input, n);
        }
      },
      UpdateServiceCommand: class extends FakeCommand {
        constructor(input: Record<string, unknown>) {
          super("UpdateService", input);
        }
      },
      DescribeServicesCommand: class extends FakeCommand {
        constructor(input: Record<string, unknown>) {
          super("DescribeServices", input);
        }
      },
    },
  } as unknown as AwsDeploySdk;
  return { sdk, calls, constructed };
}

const CREDS_RESPONSE = {
  Credentials: { AccessKeyId: "ASIAX", SecretAccessKey: "secret", SessionToken: "tok" },
  AssumedRoleUser: { AssumedRoleId: "AROAX:regulait-seed" },
};

function service(over: Record<string, unknown> = {}, deployment: Record<string, unknown> = {}) {
  return {
    services: [
      {
        taskDefinition: "arn:aws:ecs:eu-west-1:123456789012:task-definition/checkout:5",
        deployments: [{ id: "ecs-dep-1", status: "PRIMARY", rolloutState: "IN_PROGRESS", ...deployment }],
        ...over,
      },
    ],
    failures: [],
  };
}

describe("buildAwsLiveDeployClient — lazy SDK loading", () => {
  it("never loads the SDK at factory construction, only on the first call, cached after", async () => {
    let loads = 0;
    const { sdk } = makeFakeSdk(() => CREDS_RESPONSE);
    const client = buildAwsLiveDeployClient(async () => {
      loads++;
      return sdk;
    });
    expect(loads).toBe(0); // constructing the client touched nothing
    await client.assumeRole(new AssumeRoleCommand({ RoleArn: ROLE, RoleSessionName: "s" }), "eu-west-1");
    expect(loads).toBe(1);
    await client.assumeRole(new AssumeRoleCommand({ RoleArn: ROLE, RoleSessionName: "s" }), "eu-west-1");
    expect(loads).toBe(1); // loaded once, cached
  });
});

describe("buildAwsLiveDeployClient — assumeRole", () => {
  it("sends the genuine AssumeRoleCommand through STSClient({region}); credentials stay inside", async () => {
    const { sdk, calls, constructed } = makeFakeSdk(() => CREDS_RESPONSE);
    const client = buildAwsLiveDeployClient(async () => sdk);
    const out = await client.assumeRole(
      new AssumeRoleCommand({ RoleArn: ROLE, RoleSessionName: "regulait-abc", DurationSeconds: 3600 }),
      "eu-west-1",
    );
    expect(out).toEqual({ sessionId: "AROAX:regulait-seed" }); // ONLY the opaque marker crosses back
    expect(constructed[0]).toEqual({ client: "sts", region: "eu-west-1" });
    expect(calls[0]).toMatchObject({ client: "sts", op: "AssumeRole", input: { RoleArn: ROLE } });
  });

  it("an AssumeRole response with no credentials is an explicit error", async () => {
    const { sdk } = makeFakeSdk(() => ({ Credentials: {} }));
    const client = buildAwsLiveDeployClient(async () => sdk);
    await expect(
      client.assumeRole(new AssumeRoleCommand({ RoleArn: ROLE, RoleSessionName: "s" }), "eu-west-1"),
    ).rejects.toThrow(/no credentials/);
  });

  it("deploy with a never-opened sessionId is a clear error, no ECS call", async () => {
    const { sdk, calls } = makeFakeSdk(() => CREDS_RESPONSE);
    const client = buildAwsLiveDeployClient(async () => sdk);
    await expect(
      client.deploy({ target: "checkout", environment: "prod", region: "eu-west-1", roleArn: ROLE, sessionId: "nope" }),
    ).rejects.toThrow(/unknown credential session/);
    expect(calls.filter((c) => c.client === "ecs")).toHaveLength(0);
  });
});

describe("buildAwsLiveDeployClient — deploy (LRO poll-to-terminal)", () => {
  async function assumedClient(respond: (op: string, input: Record<string, unknown>, n: number) => unknown) {
    const fake = makeFakeSdk(respond);
    const client = buildAwsLiveDeployClient(async () => fake.sdk, { pollIntervalMs: 0 });
    const { sessionId } = await client.assumeRole(
      new AssumeRoleCommand({ RoleArn: ROLE, RoleSessionName: "s" }),
      "eu-west-1",
    );
    return { ...fake, client, sessionId };
  }

  it("UpdateService(cluster=environment, service=target, forceNewDeployment) then polls to COMPLETED; creds threaded into the ECS client", async () => {
    const { client, sessionId, calls, constructed } = await assumedClient((op, _input, n) => {
      if (op === "AssumeRole") return CREDS_RESPONSE;
      if (op === "UpdateService") return { service: service().services[0] };
      // poll 1: still rolling, poll 2: terminal
      return n < 2 ? service() : service({}, { rolloutState: "COMPLETED" });
    });
    const out = await client.deploy({
      target: "checkout",
      environment: "prod-cluster",
      region: "eu-west-1",
      roleArn: ROLE,
      sessionId,
    });
    expect(out.deployId).toBe("ecs-dep-1");
    expect(out.url).toContain("eu-west-1");
    expect(out.url).toContain("prod-cluster/services/checkout");
    const update = calls.find((c) => c.op === "UpdateService")!;
    expect(update.input).toEqual({ cluster: "prod-cluster", service: "checkout", forceNewDeployment: true });
    // polled DescribeServices until terminal (2 polls)
    expect(calls.filter((c) => c.op === "DescribeServices")).toHaveLength(2);
    // the assumed-role credentials were threaded into the ECS client, and
    // never appear in any returned value
    const ecs = constructed.find((c) => c.client === "ecs")!;
    expect(ecs.credentials).toMatchObject({ accessKeyId: "ASIAX", secretAccessKey: "secret", sessionToken: "tok" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("a mid-LRO FAILED rollout THROWS with the reason — never a success shape", async () => {
    const { client, sessionId } = await assumedClient((op, _input, n) => {
      if (op === "AssumeRole") return CREDS_RESPONSE;
      if (op === "UpdateService") return { service: service().services[0] };
      return n < 2
        ? service()
        : service({}, { rolloutState: "FAILED", rolloutStateReason: "tasks failed to start" });
    });
    await expect(
      client.deploy({ target: "checkout", environment: "prod", region: "eu-west-1", roleArn: ROLE, sessionId }),
    ).rejects.toThrow(/FAILED: tasks failed to start/);
  });

  it("a deployment superseded mid-rollout (no longer PRIMARY) THROWS", async () => {
    const { client, sessionId } = await assumedClient((op, _input, n) => {
      if (op === "AssumeRole") return CREDS_RESPONSE;
      if (op === "UpdateService") return { service: service().services[0] };
      return n < 2 ? service() : service({}, { id: "ecs-dep-2" });
    });
    await expect(
      client.deploy({ target: "checkout", environment: "prod", region: "eu-west-1", roleArn: ROLE, sessionId }),
    ).rejects.toThrow(/superseded/);
  });

  it("a rollout that never turns terminal times out and THROWS", async () => {
    // timeoutMs 0 → the first non-terminal poll trips the deadline
    const fake = makeFakeSdk((op) => {
      if (op === "AssumeRole") return CREDS_RESPONSE;
      if (op === "UpdateService") return { service: service().services[0] };
      return service(); // forever IN_PROGRESS
    });
    const client = buildAwsLiveDeployClient(async () => fake.sdk, { pollIntervalMs: 0, timeoutMs: 0 });
    const { sessionId } = await client.assumeRole(
      new AssumeRoleCommand({ RoleArn: ROLE, RoleSessionName: "s" }),
      "eu-west-1",
    );
    await expect(
      client.deploy({ target: "checkout", environment: "prod", region: "eu-west-1", roleArn: ROLE, sessionId }),
    ).rejects.toThrow(/did not reach a terminal state/);
  });

  it("the rejection surfaces through the async AwsDeployProvider — the stage failure path sees a thrown error, not a success", async () => {
    process.env.REGULAIT_DEPLOY_LIVE = "1";
    try {
      const { sdk } = makeFakeSdk((op, _input, n) => {
        if (op === "AssumeRole") return CREDS_RESPONSE;
        if (op === "UpdateService") return { service: service().services[0] };
        return n < 1 ? service() : service({}, { rolloutState: "FAILED", rolloutStateReason: "boom" });
      });
      const live = buildAwsLiveDeployClient(async () => sdk, { pollIntervalMs: 0 });
      const provider = resolveDeployProvider({
        provider: "aws",
        roleArn: ROLE,
        region: "eu-west-1",
        awsLiveClient: live,
      });
      await expect(provider.deploy("checkout", "prod", "seed1234")).rejects.toThrow(/FAILED: boom/);
    } finally {
      delete process.env.REGULAIT_DEPLOY_LIVE;
    }
  });
});

describe("buildAwsLiveDeployClient — rollback (previous task-def revision)", () => {
  async function assumedClient(respond: (op: string, input: Record<string, unknown>, n: number) => unknown) {
    const fake = makeFakeSdk(respond);
    const client = buildAwsLiveDeployClient(async () => fake.sdk, {
      pollIntervalMs: 0,
      cluster: "prod-cluster",
    });
    const { sessionId } = await client.assumeRole(
      new AssumeRoleCommand({ RoleArn: ROLE, RoleSessionName: "s" }),
      "eu-west-1",
    );
    return { ...fake, client, sessionId };
  }

  it("re-points the service at revision N-1 on the configured cluster and polls to COMPLETED", async () => {
    const { client, sessionId, calls } = await assumedClient((op, _input, n) => {
      if (op === "AssumeRole") return CREDS_RESPONSE;
      if (op === "UpdateService")
        return { service: { deployments: [{ id: "ecs-dep-rb", status: "PRIMARY", rolloutState: "IN_PROGRESS" }] } };
      // n=1: the pre-rollback describe; n>=2: the rollout polls
      return n < 2 ? service() : service({}, { id: "ecs-dep-rb", rolloutState: "COMPLETED" });
    });
    const out = await client.rollback({
      target: "checkout",
      deployId: "ecs-dep-1",
      region: "eu-west-1",
      roleArn: ROLE,
      sessionId,
    });
    expect(out).toEqual({ reverted: "ecs-dep-1" });
    const update = calls.find((c) => c.op === "UpdateService")!;
    expect(update.input).toEqual({
      cluster: "prod-cluster",
      service: "checkout",
      taskDefinition: "arn:aws:ecs:eu-west-1:123456789012:task-definition/checkout:4",
    });
  });

  it("revision 1 (no prior) is an explicit error — nothing to roll back to", async () => {
    const { client, sessionId } = await assumedClient((op) => {
      if (op === "AssumeRole") return CREDS_RESPONSE;
      return service({ taskDefinition: "arn:aws:ecs:eu-west-1:123456789012:task-definition/checkout:1" });
    });
    await expect(
      client.rollback({ target: "checkout", deployId: "d", region: "eu-west-1", roleArn: ROLE, sessionId }),
    ).rejects.toThrow(/no prior revision/);
  });
});
