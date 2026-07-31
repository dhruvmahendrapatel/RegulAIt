/**
 * The REAL @aws-sdk implementation of deploy.ts's AwsLiveDeployClient factory
 * contract (ADR-0015 A1) — buildable only because the ASYNC-DEPLOY refactor
 * made the client interface Promise-returning. It drives the documented
 * "ECS update-service" branch of the contract: assume-role into the customer's
 * roleArn (short-lived credentials, never a static key), force a new
 * deployment of the ECS service named by `target` in the cluster named by
 * `environment`, and poll the service's PRIMARY deployment to a terminal
 * rollout state. Rollback is the contract's "update-service to the previous
 * task-def": re-point the service at revision N-1 of its task-definition
 * family and poll that rollout to terminal.
 *
 * Discipline (mirrors infra-aws-client.ts exactly):
 *  - LAZY: the SDK modules are loaded via dynamic import on the FIRST actual
 *    client call, never at module load or factory construction — the gateway
 *    boots (and every flag-off code path runs) without touching @aws-sdk/
 *    client-ecs code. Only `import type` appears at the top of this file.
 *  - Honesty (ADR-0022): a rollout that reaches FAILED, reports service
 *    failures, or times out THROWS — never a success-shaped result, so the
 *    caller can never record dryRun:false for a deploy that did not complete.
 *  - Short-lived credentials only: the AssumeRole response credentials are
 *    held INSIDE this client keyed by the opaque sessionId and threaded into
 *    the per-call ECS client. Credentials never leave this module.
 *  - Injectable SDK loader (`loadSdk`) + poll timing options so unit tests
 *    drive fully fake modules and prove lazy-loading — never the network.
 */

import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import type { AwsLiveDeployClient } from "./deploy.js";

export class AwsDeployClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsDeployClientError";
  }
}

/** short-lived assume-role credentials, held per sessionId — never exported */
interface AwsSessionCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface AwsSendClient {
  send(command: unknown): Promise<Record<string, unknown>>;
}

/** Structural view of the two SDK modules — what the real packages provide and
 * exactly what a test fake must supply. Kept structural so fakes stay tiny and
 * the modules load lazily. */
export interface AwsDeploySdk {
  sts: { STSClient: new (config: { region: string }) => AwsSendClient };
  ecs: {
    ECSClient: new (config: { region: string; credentials: AwsSessionCredentials }) => AwsSendClient;
    UpdateServiceCommand: new (input: Record<string, unknown>) => unknown;
    DescribeServicesCommand: new (input: Record<string, unknown>) => unknown;
  };
}

/** REAL loader — dynamic imports so nothing under @aws-sdk/* beyond the
 * already-present client-sts is evaluated until the first live call. */
let realSdk: Promise<AwsDeploySdk> | undefined;
function loadRealSdk(): Promise<AwsDeploySdk> {
  realSdk ??= Promise.all([import("@aws-sdk/client-sts"), import("@aws-sdk/client-ecs")]).then(
    ([sts, ecs]) => ({ sts, ecs }) as unknown as AwsDeploySdk,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AwsDeployPollOptions {
  /** delay between DescribeServices polls (default 5s; tests pass 0) */
  pollIntervalMs?: number;
  /** give up (and THROW) after this long (default 10 min) */
  timeoutMs?: number;
  /** the ECS cluster a ROLLBACK acts on. The deploy path gets its cluster from
   * the stage's `environment`, but the DeployProvider rollback surface carries
   * no environment — so the cluster comes from here (wiring threads env
   * REGULAIT_DEPLOY_AWS_CLUSTER), falling back to ECS's 'default' cluster. */
  cluster?: string;
}

/** the service's PRIMARY deployment (the one an update-service rolls out) */
function primaryDeployment(service: Record<string, unknown>): Record<string, unknown> | null {
  return arr(service.deployments).find((d) => str(d.status) === "PRIMARY") ?? null;
}

/**
 * Build the real AwsLiveDeployClient that deploy.ts's liveDeployClients()
 * wiring injects when REGULAIT_DEPLOY_LIVE is on and the deploy target's
 * provider is 'aws'. `loadSdk` is the test seam (defaults to the real lazy
 * dynamic-import loader).
 */
export function buildAwsLiveDeployClient(
  loadSdk: () => Promise<AwsDeploySdk> = loadRealSdk,
  options: AwsDeployPollOptions = {},
): AwsLiveDeployClient {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 600_000;

  // lazy: nothing is loaded until the first method call on the returned client
  let sdkPromise: Promise<AwsDeploySdk> | undefined;
  const sdk = () => (sdkPromise ??= loadSdk());

  // sessionId → the held short-lived credentials (never exposed)
  const sessions = new Map<string, AwsSessionCredentials>();
  let sessionCounter = 0;

  function credentials(sessionId: string): AwsSessionCredentials {
    const creds = sessions.get(sessionId);
    if (!creds) {
      throw new AwsDeployClientError(
        `aws deploy live client: unknown credential session '${sessionId}' — call assumeRole first`,
      );
    }
    return creds;
  }

  async function ecsClient(region: string, sessionId: string): Promise<AwsSendClient> {
    const s = await sdk();
    return new s.ecs.ECSClient({ region, credentials: credentials(sessionId) });
  }

  /** one DescribeServices call → the service record (or a thrown miss) */
  async function describeService(
    client: AwsSendClient,
    s: AwsDeploySdk,
    cluster: string,
    serviceName: string,
  ): Promise<Record<string, unknown>> {
    const resp = await client.send(
      new s.ecs.DescribeServicesCommand({ cluster, services: [serviceName] }),
    );
    const failures = arr(resp.failures);
    if (failures.length > 0) {
      throw new AwsDeployClientError(
        `ecs DescribeServices failed for '${serviceName}' in cluster '${cluster}': ` +
          failures.map((f) => `${str(f.arn) ?? "?"} ${str(f.reason) ?? "unknown"}`).join("; "),
      );
    }
    const service = arr(resp.services)[0];
    if (!service) {
      throw new AwsDeployClientError(
        `ecs service '${serviceName}' not found in cluster '${cluster}'`,
      );
    }
    return service;
  }

  /** poll the PRIMARY deployment to a terminal rollout state. COMPLETED
   * returns; FAILED or a timeout THROWS — never a success-shaped result. */
  async function pollRolloutToTerminal(
    client: AwsSendClient,
    s: AwsDeploySdk,
    cluster: string,
    serviceName: string,
    deployId: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // first check immediately, then on the interval
    for (;;) {
      const service = await describeService(client, s, cluster, serviceName);
      const primary = primaryDeployment(service);
      if (!primary || str(primary.id) !== deployId) {
        throw new AwsDeployClientError(
          `ecs deployment '${deployId}' is no longer the PRIMARY deployment of '${serviceName}' — ` +
            `superseded before completing; not reporting success`,
        );
      }
      const rolloutState = str(primary.rolloutState);
      if (rolloutState === "COMPLETED") return;
      if (rolloutState === "FAILED") {
        throw new AwsDeployClientError(
          `ecs deployment '${deployId}' of '${serviceName}' FAILED: ` +
            (str(primary.rolloutStateReason) ?? "no reason reported"),
        );
      }
      if (Date.now() >= deadline) {
        throw new AwsDeployClientError(
          `ecs deployment '${deployId}' of '${serviceName}' did not reach a terminal state within ${timeoutMs}ms ` +
            `(last rolloutState: ${rolloutState ?? "unknown"})`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  return {
    /** REAL: new STSClient({region}).send(command) — the command is the
     * genuine AssumeRoleCommand deploy.ts constructed. Only the opaque session
     * marker crosses back; the credentials stay in this module. */
    async assumeRole(command: AssumeRoleCommand, region: string): Promise<{ sessionId: string }> {
      const s = await sdk();
      const client = new s.sts.STSClient({ region });
      const resp = await client.send(command);
      const c = rec(resp.Credentials);
      const accessKeyId = str(c.AccessKeyId);
      const secretAccessKey = str(c.SecretAccessKey);
      if (!accessKeyId || !secretAccessKey) {
        throw new AwsDeployClientError(
          "sts AssumeRole returned no credentials — session not established",
        );
      }
      const sessionId =
        str(rec(resp.AssumedRoleUser).AssumedRoleId) ?? `aws-deploy-${++sessionCounter}`;
      sessions.set(sessionId, {
        accessKeyId,
        secretAccessKey,
        sessionToken: str(c.SessionToken) ?? undefined,
      });
      return { sessionId };
    },

    /** REAL: ecs UpdateService({cluster: environment, service: target,
     * forceNewDeployment}) then DescribeServices-poll the PRIMARY deployment
     * to COMPLETED. deployId is the ECS deployment id — captured from a
     * genuinely completed rollout only. */
    async deploy(params): Promise<{ deployId: string; url: string }> {
      const s = await sdk();
      const client = await ecsClient(params.region, params.sessionId);
      const resp = await client.send(
        new s.ecs.UpdateServiceCommand({
          cluster: params.environment,
          service: params.target,
          forceNewDeployment: true,
        }),
      );
      const primary = primaryDeployment(rec(resp.service));
      const deployId = str(rec(primary ?? {}).id);
      if (!deployId) {
        throw new AwsDeployClientError(
          `ecs UpdateService for '${params.target}' returned no PRIMARY deployment id — deploy not confirmed`,
        );
      }
      await pollRolloutToTerminal(client, s, params.environment, params.target, deployId);
      return {
        deployId,
        url:
          `https://${params.region}.console.aws.amazon.com/ecs/v2/clusters/` +
          `${params.environment}/services/${params.target}/deployments`,
      };
    },

    /** REAL: the contract's "ECS update-service to the previous task-def" —
     * revision N-1 of the service's current task-definition family, rolled out
     * and polled to COMPLETED. No prior revision = an explicit error. */
    async rollback(params): Promise<{ reverted: string }> {
      const s = await sdk();
      const client = await ecsClient(params.region, params.sessionId);
      const rollbackCluster = options.cluster ?? "default";
      const service = await describeService(client, s, rollbackCluster, params.target);
      const taskDefArn = str(service.taskDefinition);
      const m = taskDefArn ? /^(.*):(\d+)$/.exec(taskDefArn) : null;
      if (!m) {
        throw new AwsDeployClientError(
          `ecs service '${params.target}' has no parseable task-definition revision (${taskDefArn ?? "none"}) — cannot roll back`,
        );
      }
      const revision = Number(m[2]);
      if (revision <= 1) {
        throw new AwsDeployClientError(
          `ecs service '${params.target}' is on task-definition revision ${revision} — no prior revision to roll back to`,
        );
      }
      const resp = await client.send(
        new s.ecs.UpdateServiceCommand({
          cluster: rollbackCluster,
          service: params.target,
          taskDefinition: `${m[1]}:${revision - 1}`,
        }),
      );
      const primary = primaryDeployment(rec(resp.service));
      const rollbackDeployId = str(rec(primary ?? {}).id);
      if (!rollbackDeployId) {
        throw new AwsDeployClientError(
          `ecs rollback UpdateService for '${params.target}' returned no PRIMARY deployment id — rollback not confirmed`,
        );
      }
      await pollRolloutToTerminal(client, s, rollbackCluster, params.target, rollbackDeployId);
      return { reverted: params.deployId };
    },
  };
}
