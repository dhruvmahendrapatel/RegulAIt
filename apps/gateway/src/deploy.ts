// §2 pillar-2 deploy adapter — the governed destination a `deployment` /
// `rollback` stage acts on. Provider-agnostic by design (the standing "never
// hard-lock to one vendor" principle): a mock provider runs everywhere with no
// credentials for the demo/tests; AWS/Azure/GCP/Kubernetes ship as deterministic
// dry-run SHAPES that model the real customer-owned-account flow (STS/OIDC/
// kubeconfig auth → deploy → rollback) with `// REAL:` markers at every SDK call
// site, but touch NO network — so CI and the demo run everywhere and no cloud
// resource is ever mutated without explicit sign-off. Deterministic and offline,
// mirroring the git-provider mock.
//
// ADR-0015 addendum (A1): the AWS adapter can run its `// REAL:` path for real
// behind the OFF-by-default REGULAIT_DEPLOY_LIVE flag, using an INJECTED STS/
// deploy client (never the network in tests) — see AwsDeployProvider below.
//
// Batch C breadth: azure/gcp/kubernetes now carry the SAME live-path semantics
// as AWS — behind the same flag, each with its own injected live client
// (AzureLiveDeployClient / GcpLiveDeployClient / KubernetesLiveDeployClient).
// Flag off = today's dry-run, byte-identical; flag on + injected client = a
// genuinely live call and ONLY then dryRun:false; flag on unwired = an
// explicit error. The ADR-0022 production gate (a dry-run may never satisfy a
// production deploy) keeps working unchanged off the honest dryRun flag.

import { AssumeRoleCommand } from "@aws-sdk/client-sts";

export type DeployProviderKind = "mock" | "aws" | "azure" | "gcp" | "kubernetes";

/** A1: master switch for the AWS adapter's real (@aws-sdk) path. OFF unless the
 * env var is explicitly "1"/"true". Off = today's deterministic dry-run,
 * byte-identical to before. On = the `// REAL:` STS AssumeRole + deploy driver,
 * but ONLY when a live client is injected — never a bare network call, never a
 * live mutation without an explicitly wired client. */
export function deployLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.REGULAIT_DEPLOY_LIVE;
  return v === "1" || v === "true";
}

export interface DeployResult {
  deployId: string;
  url: string;
  detail: string;
  /**
   * #79c honesty: true whenever this adapter did NOT actually mutate the
   * target it claims to have deployed to — i.e. every deterministic dry-run
   * SHAPE (aws without a live client, azure, gcp, kubernetes). The workflow
   * engine persists it in the stage context, the UI badges it, and a dry-run
   * may NEVER satisfy a production deploy gate. The mock provider reports
   * false on purpose: mock is the demo/test double whose deploys ARE its
   * (self-describing, mock:// -addressed) contract, not a pretend run of a
   * real one — see ADR-0022.
   */
  dryRun: boolean;
}
export interface RollbackResult {
  reverted: string; // the deployId that was reversed
  detail: string;
}

export class DeployProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployProviderError";
  }
}

export interface DeployProvider {
  readonly kind: DeployProviderKind;
  /** deploy the given change to this target; `seed` makes the ids deterministic
   * (the instance id) so a replay never mints a second deployment. */
  deploy(target: string, environment: string | null, seed: string): DeployResult;
  rollback(target: string, deployId: string): RollbackResult;
}

class MockDeployProvider implements DeployProvider {
  readonly kind = "mock" as const;
  deploy(target: string, environment: string | null, seed: string): DeployResult {
    const env = environment ?? "default";
    const deployId = `dep_${seed.slice(0, 8)}_${env}`;
    return {
      deployId,
      url: `mock://deploy/${target}/${env}/${deployId}`,
      detail: `mock deploy to ${target} (${env})`,
      dryRun: false, // the mock deploy IS the mock provider's real contract
    };
  }
  rollback(_target: string, deployId: string): RollbackResult {
    return { reverted: deployId, detail: `mock rollback of ${deployId}` };
  }
}

/**
 * A1: the injectable live-AWS client (injectable-client discipline). When
 * REGULAIT_DEPLOY_LIVE is on, AwsDeployProvider drives this instead of the
 * dry-run — and it is ALWAYS supplied by the caller (a fake in unit tests, a
 * real @aws-sdk-backed impl in a genuinely live deployment). Methods are
 * synchronous to keep the DeployProvider interface synchronous; a real impl
 * wraps the async SDK behind them. There is no default network client, so
 * "flag on with nothing injected" is a clear error, never a silent mutation.
 */
export interface AwsLiveDeployClient {
  /** REAL: new STSClient({region}).send(command). Returns the assumed session
   * marker. The command is a genuine @aws-sdk AssumeRoleCommand. */
  assumeRole(command: AssumeRoleCommand, region: string): { sessionId: string };
  /** REAL: with the assumed-role creds, drive the deploy (CodeDeploy / ECS
   * update-service / CloudFormation deploy) in `region` and capture its id. */
  deploy(params: {
    target: string;
    environment: string;
    region: string;
    roleArn: string;
    sessionId: string;
  }): { deployId: string; url: string };
  /** REAL: assumed-role rollback (CodeDeploy StopDeployment + prior revision /
   * ECS update-service to the previous task-def) in `region`. */
  rollback(params: {
    target: string;
    deployId: string;
    region: string;
    roleArn: string;
    sessionId: string;
  }): { reverted: string };
}

/**
 * BYOC AWS deploy adapter. It models the real customer-owned-account flow: STS
 * AssumeRole into the customer's `roleArn` (short-lived credentials, NEVER a
 * long-lived key — the same no-static-keys rule as our own infra), then a
 * deploy in the customer's `region`.
 *
 * By default (REGULAIT_DEPLOY_LIVE off) this is a deterministic dry-run that
 * touches no network — byte-identical to the pre-A1 contract. With the flag ON
 * and a live client INJECTED, the `// REAL:` markers become a real @aws-sdk
 * AssumeRoleCommand + a deploy driver via that client. The flag on with no
 * injected client is an explicit error — no live path ever runs unwired.
 */
class AwsDeployProvider implements DeployProvider {
  readonly kind = "aws" as const;
  constructor(
    private readonly roleArn: string,
    private readonly region: string,
    /** A1 injectable-client discipline: present only when a caller wired one
     * (a fake in tests). Absent = pure dry-run regardless of the flag. */
    private readonly liveClient?: AwsLiveDeployClient,
    /** captured at construction so a test can flip it per-instance */
    private readonly live: boolean = deployLiveEnabled(),
  ) {}

  private requireConfig(): void {
    if (!this.roleArn || !this.region) {
      throw new DeployProviderError("aws deploy target needs a roleArn and region");
    }
  }

  /** true when the real @aws-sdk path is both enabled AND wired */
  private useLive(): boolean {
    return this.live && this.liveClient !== undefined;
  }

  private assumeReal(seed: string): { sessionId: string } {
    // REAL: a genuine @aws-sdk/client-sts AssumeRoleCommand handed to the
    // injected client (which, in a real deployment, sends it through an
    // STSClient({region})). Never constructed against the network here.
    const command = new AssumeRoleCommand({
      RoleArn: this.roleArn,
      RoleSessionName: `regulait-${seed.slice(0, 24)}`,
      DurationSeconds: 3600,
    });
    return this.liveClient!.assumeRole(command, this.region);
  }

  deploy(target: string, environment: string | null, seed: string): DeployResult {
    this.requireConfig();
    if (this.live && !this.liveClient) {
      throw new DeployProviderError(
        "REGULAIT_DEPLOY_LIVE is on but no live AWS deploy client was injected",
      );
    }
    const env = environment ?? "default";
    if (this.useLive()) {
      const session = this.assumeReal(seed);
      const out = this.liveClient!.deploy({
        target,
        environment: env,
        region: this.region,
        roleArn: this.roleArn,
        sessionId: session.sessionId,
      });
      return {
        deployId: out.deployId,
        url: out.url,
        detail: `assume-role ${this.roleArn} → deploy to ${target} (${env}) in ${this.region} [live]`,
        dryRun: false,
      };
    }
    // Dry-run: deterministic session marker, no credentials, no network.
    const sessionId = `sess_${seed.slice(0, 8)}`;
    const deployId = `aws_${sessionId}_${env}`;
    const acct = this.roleArn.split(":")[4] ?? "customer";
    return {
      deployId,
      url: `https://${this.region}.console.aws.amazon.com/deploy/${acct}/${target}/${deployId}`,
      detail: `assume-role ${this.roleArn} → deploy to ${target} (${env}) in ${this.region} [dry-run]`,
      dryRun: true,
    };
  }

  rollback(target: string, deployId: string): RollbackResult {
    this.requireConfig();
    if (this.live && !this.liveClient) {
      throw new DeployProviderError(
        "REGULAIT_DEPLOY_LIVE is on but no live AWS deploy client was injected",
      );
    }
    if (this.useLive()) {
      const session = this.assumeReal(deployId);
      const out = this.liveClient!.rollback({
        target,
        deployId,
        region: this.region,
        roleArn: this.roleArn,
        sessionId: session.sessionId,
      });
      return { reverted: out.reverted, detail: `assume-role rollback of ${deployId} on ${target} [live]` };
    }
    return { reverted: deployId, detail: `assume-role rollback of ${deployId} on ${target} [dry-run]` };
  }
}

/**
 * Batch C: the injectable live-Azure deploy client (identical discipline to
 * AwsLiveDeployClient — ALWAYS supplied by the caller, a fake in unit tests;
 * no default network client, so "flag on with nothing injected" is a clear
 * error, never a silent mutation). Methods are synchronous to keep the
 * DeployProvider interface synchronous; a real impl wraps the async SDK
 * behind them.
 *
 * FACTORY CONTRACT for a real impl (@azure/identity + @azure/arm-resources —
 * NOT added as deps: nothing here calls them yet, and the sync DeployProvider
 * interface means a genuinely-async real client needs the (documented,
 * deferred) async-deploy refactor in the workflow engine first):
 *   deploy   → new DefaultAzureCredential() (Entra ID federated — never a
 *              static key) → new ResourceManagementClient(cred, subscription)
 *              .deployments.beginCreateOrUpdate(resourceGroup, target, {
 *                properties: { mode: "Incremental", template/bicep... } })
 *              — an ARM/Bicep deployment trigger; capture the deployment
 *              name/id + portal URL.
 *   rollback → deployments.beginCreateOrUpdate again with the PREVIOUS
 *              deployment's template (deployments.exportTemplate of the prior
 *              successful deployment), reverting to the last known-good state.
 */
export interface AzureLiveDeployClient {
  /** REAL: ARM/Bicep deployment trigger in the customer's subscription. */
  deploy(params: {
    target: string;
    environment: string;
    region: string;
    subscription: string;
  }): { deployId: string; url: string };
  /** REAL: re-deploy the prior known-good ARM deployment (revert). */
  rollback(params: {
    target: string;
    deployId: string;
    region: string;
    subscription: string;
  }): { reverted: string };
}

/**
 * BYOC Azure deploy adapter. Models the real flow: an OIDC/service-principal
 * auth into the customer's subscription, then an ARM/Bicep deployment in the
 * target region.
 *
 * By default (REGULAIT_DEPLOY_LIVE off) this is a deterministic dry-run that
 * touches no network — byte-identical to the pre-Batch-C contract. With the
 * flag ON and a live client INJECTED, deploy/rollback run through that client
 * (AzureLiveDeployClient factory contract above) and the result honestly
 * reports dryRun:false. The flag on with no injected client is an explicit
 * error — no live path ever runs unwired (the AWS A1 semantics exactly).
 */
class AzureDeployProvider implements DeployProvider {
  readonly kind = "azure" as const;
  constructor(
    private readonly subscription: string,
    private readonly region: string,
    /** injectable-client discipline: present only when a caller wired one
     * (a fake in tests). Absent = pure dry-run regardless of the flag. */
    private readonly liveClient?: AzureLiveDeployClient,
    /** captured at construction so a test can flip it per-instance */
    private readonly live: boolean = deployLiveEnabled(),
  ) {}

  private requireConfig(): void {
    if (!this.subscription || !this.region) {
      throw new DeployProviderError("azure deploy target needs a subscription (roleArn) and region");
    }
  }

  /** true when the real @azure/* path is both enabled AND wired */
  private useLive(): boolean {
    return this.live && this.liveClient !== undefined;
  }

  private requireWiredIfLive(): void {
    if (this.live && !this.liveClient) {
      throw new DeployProviderError(
        "REGULAIT_DEPLOY_LIVE is on but no live Azure deploy client was injected",
      );
    }
  }

  deploy(target: string, environment: string | null, seed: string): DeployResult {
    this.requireConfig();
    this.requireWiredIfLive();
    const env = environment ?? "default";
    if (this.useLive()) {
      // REAL: DefaultAzureCredential → ARM/Bicep deployment via the injected
      // client (see the AzureLiveDeployClient factory contract). dryRun:false
      // ONLY here — a genuinely live call happened.
      const out = this.liveClient!.deploy({
        target,
        environment: env,
        region: this.region,
        subscription: this.subscription,
      });
      return {
        deployId: out.deployId,
        url: out.url,
        detail: `azure login sub ${this.subscription} → deploy to ${target} (${env}) in ${this.region} [live]`,
        dryRun: false,
      };
    }
    // Dry-run: deterministic, no credentials, no network — byte-identical to
    // the pre-Batch-C shape.
    const sessionId = `az_${seed.slice(0, 8)}`;
    const deployId = `azure_${sessionId}_${env}`;
    return {
      deployId,
      url: `https://portal.azure.com/#@/resource/subscriptions/${this.subscription}/deploy/${target}/${deployId}`,
      detail: `azure login sub ${this.subscription} → deploy to ${target} (${env}) in ${this.region} [dry-run]`,
      dryRun: true,
    };
  }

  rollback(target: string, deployId: string): RollbackResult {
    this.requireConfig();
    this.requireWiredIfLive();
    if (this.useLive()) {
      // REAL: re-deploy the prior known-good ARM deployment via the client.
      const out = this.liveClient!.rollback({
        target,
        deployId,
        region: this.region,
        subscription: this.subscription,
      });
      return { reverted: out.reverted, detail: `azure rollback of ${deployId} on ${target} [live]` };
    }
    return { reverted: deployId, detail: `azure rollback of ${deployId} on ${target} [dry-run]` };
  }
}

/**
 * Batch C: the injectable live-GCP deploy client (identical discipline to
 * AwsLiveDeployClient / AzureLiveDeployClient). Methods are synchronous to
 * keep the DeployProvider interface synchronous; a real impl wraps the async
 * SDK behind them.
 *
 * FACTORY CONTRACT for a real impl (@google-cloud/config — Infrastructure
 * Manager, Deployment Manager's successor — NOT added as a dep: nothing here
 * calls it yet; same sync-interface note as AzureLiveDeployClient):
 *   deploy   → ADC / workload identity federation (never a static SA key) →
 *              new ConfigClient().createDeployment/updateDeployment({parent:
 *              `projects/${project}/locations/${region}`, deploymentId:
 *              target, deployment: { terraformBlueprint... }}) — the
 *              infra-manager deployment trigger; capture the deployment name
 *              + console URL.
 *   rollback → updateDeployment back to the previous revision's blueprint
 *              (deployments/{d}/revisions list → prior revision).
 */
export interface GcpLiveDeployClient {
  /** REAL: infra-manager (Deployment Manager successor) deployment trigger. */
  deploy(params: {
    target: string;
    environment: string;
    region: string;
    project: string;
  }): { deployId: string; url: string };
  /** REAL: revert to the prior infra-manager deployment revision. */
  rollback(params: {
    target: string;
    deployId: string;
    region: string;
    project: string;
  }): { reverted: string };
}

/**
 * BYOC GCP deploy adapter. Models the real flow: workload-identity-federation
 * auth into the customer's project, then an Infrastructure Manager /
 * Deployment Manager deployment in the target region.
 *
 * By default (REGULAIT_DEPLOY_LIVE off) this is a deterministic dry-run that
 * touches no network — byte-identical to the pre-Batch-C contract. With the
 * flag ON and a live client INJECTED, deploy/rollback run through that client
 * and the result honestly reports dryRun:false. The flag on with no injected
 * client is an explicit error — no live path ever runs unwired.
 */
class GcpDeployProvider implements DeployProvider {
  readonly kind = "gcp" as const;
  constructor(
    private readonly project: string,
    private readonly region: string,
    /** injectable-client discipline: present only when a caller wired one
     * (a fake in tests). Absent = pure dry-run regardless of the flag. */
    private readonly liveClient?: GcpLiveDeployClient,
    /** captured at construction so a test can flip it per-instance */
    private readonly live: boolean = deployLiveEnabled(),
  ) {}

  private requireConfig(): void {
    if (!this.project || !this.region) {
      throw new DeployProviderError("gcp deploy target needs a project (roleArn) and region");
    }
  }

  /** true when the real @google-cloud/* path is both enabled AND wired */
  private useLive(): boolean {
    return this.live && this.liveClient !== undefined;
  }

  private requireWiredIfLive(): void {
    if (this.live && !this.liveClient) {
      throw new DeployProviderError(
        "REGULAIT_DEPLOY_LIVE is on but no live GCP deploy client was injected",
      );
    }
  }

  deploy(target: string, environment: string | null, seed: string): DeployResult {
    this.requireConfig();
    this.requireWiredIfLive();
    const env = environment ?? "default";
    if (this.useLive()) {
      // REAL: WIF auth → infra-manager deployment via the injected client (see
      // the GcpLiveDeployClient factory contract). dryRun:false ONLY here — a
      // genuinely live call happened.
      const out = this.liveClient!.deploy({
        target,
        environment: env,
        region: this.region,
        project: this.project,
      });
      return {
        deployId: out.deployId,
        url: out.url,
        detail: `gcp wif project ${this.project} → deploy to ${target} (${env}) in ${this.region} [live]`,
        dryRun: false,
      };
    }
    // Dry-run: deterministic, no credentials, no network — byte-identical to
    // the pre-Batch-C shape.
    const sessionId = `gc_${seed.slice(0, 8)}`;
    const deployId = `gcp_${sessionId}_${env}`;
    return {
      deployId,
      url: `https://console.cloud.google.com/deploy/${this.project}/${this.region}/${target}/${deployId}`,
      detail: `gcp wif project ${this.project} → deploy to ${target} (${env}) in ${this.region} [dry-run]`,
      dryRun: true,
    };
  }

  rollback(target: string, deployId: string): RollbackResult {
    this.requireConfig();
    this.requireWiredIfLive();
    if (this.useLive()) {
      // REAL: revert to the prior deployment revision via the client.
      const out = this.liveClient!.rollback({
        target,
        deployId,
        region: this.region,
        project: this.project,
      });
      return { reverted: out.reverted, detail: `gcp rollback of ${deployId} on ${target} [live]` };
    }
    return { reverted: deployId, detail: `gcp rollback of ${deployId} on ${target} [dry-run]` };
  }
}

/**
 * Batch C: the injectable live-Kubernetes deploy client — kubeconfig-SCOPED:
 * the decrypted kubeconfig credential is handed to every call and never held
 * by the provider beyond its own constructor argument. Identical discipline to
 * the other live deploy clients (fake in tests, no default network client).
 * Methods are synchronous to keep the DeployProvider interface synchronous; a
 * real impl wraps the async SDK behind them.
 *
 * FACTORY CONTRACT for a real impl (@kubernetes/client-node — NOT added as a
 * dep: nothing here calls it yet; same sync-interface note as the azure/gcp
 * deploy clients):
 *   deploy   → const kc = new k8s.KubeConfig(); kc.loadFromString(kubeconfig);
 *              const api = kc.makeApiClient(k8s.AppsV1Api);
 *              await api.patchNamespacedDeployment({name: target, namespace,
 *              body: patch}) (an apply/patch of the Deployment) then watch the
 *              rollout; deployId = the observed metadata.generation /
 *              revision annotation.
 *   rollback → the `kubectl rollout undo` equivalent — patch the Deployment's
 *              template back to the prior ReplicaSet revision.
 */
export interface KubernetesLiveDeployClient {
  /** REAL: kubeconfig-scoped apply/patch of the Deployment + rollout watch. */
  deploy(params: {
    target: string;
    environment: string;
    namespace: string;
    kubeconfig: string;
  }): { deployId: string; url: string };
  /** REAL: rollout-undo to the prior ReplicaSet revision. */
  rollback(params: {
    target: string;
    deployId: string;
    namespace: string;
    kubeconfig: string;
  }): { reverted: string };
}

/**
 * Kubernetes deploy adapter. Models the real flow: load a kubeconfig (the
 * encrypted deploy CREDENTIAL), then apply/patch a Deployment and wait for the
 * rollout in the target namespace.
 *
 * By default (REGULAIT_DEPLOY_LIVE off) this is a deterministic dry-run that
 * touches no network — byte-identical to the pre-Batch-C contract. With the
 * flag ON and a live client INJECTED, deploy/rollback run through that
 * kubeconfig-scoped client and the result honestly reports dryRun:false. The
 * flag on with no injected client is an explicit error — no live path ever
 * runs unwired.
 */
class KubernetesDeployProvider implements DeployProvider {
  readonly kind = "kubernetes" as const;
  constructor(
    /** the kubeconfig (decrypted deploy credential); required */
    private readonly kubeconfig: string,
    /** the target namespace; environment doubles as it when unset */
    private readonly namespace: string | null,
    /** injectable-client discipline: present only when a caller wired one
     * (a fake in tests). Absent = pure dry-run regardless of the flag. */
    private readonly liveClient?: KubernetesLiveDeployClient,
    /** captured at construction so a test can flip it per-instance */
    private readonly live: boolean = deployLiveEnabled(),
  ) {}

  private requireConfig(): void {
    if (!this.kubeconfig) {
      throw new DeployProviderError("kubernetes deploy target needs a kubeconfig credential");
    }
  }

  /** true when the real @kubernetes/client-node path is both enabled AND wired */
  private useLive(): boolean {
    return this.live && this.liveClient !== undefined;
  }

  private requireWiredIfLive(): void {
    if (this.live && !this.liveClient) {
      throw new DeployProviderError(
        "REGULAIT_DEPLOY_LIVE is on but no live Kubernetes deploy client was injected",
      );
    }
  }

  deploy(target: string, environment: string | null, seed: string): DeployResult {
    this.requireConfig();
    this.requireWiredIfLive();
    const env = environment ?? "default";
    const ns = this.namespace ?? env;
    if (this.useLive()) {
      // REAL: kubeconfig-scoped apply + rollout watch via the injected client
      // (see the KubernetesLiveDeployClient factory contract). dryRun:false
      // ONLY here — a genuinely live call happened.
      const out = this.liveClient!.deploy({
        target,
        environment: env,
        namespace: ns,
        kubeconfig: this.kubeconfig,
      });
      return {
        deployId: out.deployId,
        url: out.url,
        detail: `kubeconfig apply → rollout ${target} in namespace ${ns} (${env}) [live]`,
        dryRun: false,
      };
    }
    // Dry-run: deterministic, no credentials used, no network — byte-identical
    // to the pre-Batch-C shape.
    const sessionId = `k8s_${seed.slice(0, 8)}`;
    const deployId = `k8s_${sessionId}_${env}`;
    return {
      deployId,
      url: `k8s://${ns}/deployments/${target}#${deployId}`,
      detail: `kubeconfig apply → rollout ${target} in namespace ${ns} (${env}) [dry-run]`,
      dryRun: true,
    };
  }

  rollback(target: string, deployId: string): RollbackResult {
    this.requireConfig();
    this.requireWiredIfLive();
    if (this.useLive()) {
      // REAL: rollout-undo via the kubeconfig-scoped client. The namespace of
      // the original deploy is carried in the recorded deployId's context by
      // the workflow engine; the provider's own namespace (or the recorded
      // environment at rollback time) scopes the undo.
      const out = this.liveClient!.rollback({
        target,
        deployId,
        namespace: this.namespace ?? "default",
        kubeconfig: this.kubeconfig,
      });
      return { reverted: out.reverted, detail: `kubernetes rollout undo of ${deployId} on ${target} [live]` };
    }
    return { reverted: deployId, detail: `kubernetes rollout undo of ${deployId} on ${target} [dry-run]` };
  }
}

export interface ResolveDeployProviderConfig {
  provider: DeployProviderKind;
  /** decrypted deploy credential (unused by mock/AWS-assume-role); some real
   * providers (kubernetes kubeconfig, etc.) will need it */
  credential?: string;
  baseUrl?: string | null;
  /** aws: the customer IAM role to assume / azure subscription / gcp project;
   * the field is reused as the provider's account handle. */
  roleArn?: string | null;
  region?: string | null;
  /** A1: an injected live-AWS client (fake in tests). Present + REGULAIT_DEPLOY_LIVE
   * on = the real @aws-sdk path; absent = dry-run regardless of the flag. */
  awsLiveClient?: AwsLiveDeployClient;
  /** Batch C: injected live-Azure deploy client — same semantics as awsLiveClient. */
  azureLiveClient?: AzureLiveDeployClient;
  /** Batch C: injected live-GCP deploy client — same semantics as awsLiveClient. */
  gcpLiveClient?: GcpLiveDeployClient;
  /** Batch C: injected kubeconfig-scoped live-Kubernetes deploy client — same
   * semantics as awsLiveClient. */
  k8sLiveClient?: KubernetesLiveDeployClient;
}

export function resolveDeployProvider(config: ResolveDeployProviderConfig): DeployProvider {
  if (config.provider === "mock") return new MockDeployProvider();
  if (config.provider === "aws") {
    return new AwsDeployProvider(
      config.roleArn ?? "",
      config.region ?? "",
      config.awsLiveClient,
    );
  }
  if (config.provider === "azure") {
    return new AzureDeployProvider(
      config.roleArn ?? "",
      config.region ?? "",
      config.azureLiveClient,
    );
  }
  if (config.provider === "gcp") {
    return new GcpDeployProvider(
      config.roleArn ?? "",
      config.region ?? "",
      config.gcpLiveClient,
    );
  }
  if (config.provider === "kubernetes") {
    return new KubernetesDeployProvider(
      config.credential ?? "",
      config.region ?? null,
      config.k8sLiveClient,
    );
  }
  // Any future provider that isn't wired stays an honest, surfaced failure
  // (→ manual handoff), never a pretend success.
  throw new DeployProviderError(
    `deploy provider '${config.provider}' is not integrated yet — add the adapter`,
  );
}
