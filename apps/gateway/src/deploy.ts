// §2 pillar-2 deploy adapter — the governed destination a `deployment` /
// `rollback` stage acts on. Provider-agnostic by design (the standing "never
// hard-lock to one vendor" principle): a mock provider runs everywhere with no
// credentials for the demo/tests; AWS/Azure/GCP/Kubernetes are declared but not
// yet integrated, so naming one is an honest, surfaced failure rather than a
// silent no-op. Deterministic and offline — no network — mirroring the
// git-provider mock.

export type DeployProviderKind = "mock" | "aws" | "azure" | "gcp" | "kubernetes";

export interface DeployResult {
  deployId: string;
  url: string;
  detail: string;
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
    };
  }
  rollback(_target: string, deployId: string): RollbackResult {
    return { reverted: deployId, detail: `mock rollback of ${deployId}` };
  }
}

/**
 * BYOC AWS deploy adapter — SHAPE ONLY (execution is a dry-run). It models the
 * real customer-owned-account flow: STS AssumeRole into the customer's
 * `roleArn` (short-lived credentials, NEVER a long-lived key — the same
 * no-static-keys rule as our own infra), then a deploy in the customer's
 * `region`. The two `// REAL:` markers are exactly where the `@aws-sdk` calls
 * go once a customer points a target at a live account; until then this returns
 * a deterministic result and touches no network, so CI and the demo run
 * everywhere and no cloud resource is ever created without explicit sign-off.
 */
class AwsDeployProvider implements DeployProvider {
  readonly kind = "aws" as const;
  constructor(
    private readonly roleArn: string,
    private readonly region: string,
  ) {}

  private assumeRole(seed: string): { accessKeyId: string; sessionId: string } {
    // REAL: new STSClient({region}).send(new AssumeRoleCommand({RoleArn: this.roleArn,
    //   RoleSessionName: `regulait-${seed}`, DurationSeconds: 3600})) → temp creds.
    // Dry-run: deterministic session marker, no credentials, no network.
    return { accessKeyId: "DRYRUN", sessionId: `sess_${seed.slice(0, 8)}` };
  }

  deploy(target: string, environment: string | null, seed: string): DeployResult {
    if (!this.roleArn || !this.region) {
      throw new DeployProviderError("aws deploy target needs a roleArn and region");
    }
    const env = environment ?? "default";
    const session = this.assumeRole(seed);
    // REAL: with the assumed-role creds, drive the deploy (CodeDeploy / ECS
    // update-service / CloudFormation deploy) in this.region and capture its id.
    const deployId = `aws_${session.sessionId}_${env}`;
    const acct = this.roleArn.split(":")[4] ?? "customer";
    return {
      deployId,
      url: `https://${this.region}.console.aws.amazon.com/deploy/${acct}/${target}/${deployId}`,
      detail: `assume-role ${this.roleArn} → deploy to ${target} (${env}) in ${this.region} [dry-run]`,
    };
  }

  rollback(target: string, deployId: string): RollbackResult {
    if (!this.roleArn || !this.region) {
      throw new DeployProviderError("aws deploy target needs a roleArn and region");
    }
    this.assumeRole(deployId);
    // REAL: assumed-role rollback (CodeDeploy StopDeployment + prior revision /
    // ECS update-service to the previous task-def) in this.region.
    return { reverted: deployId, detail: `assume-role rollback of ${deployId} on ${target} [dry-run]` };
  }
}

export interface ResolveDeployProviderConfig {
  provider: DeployProviderKind;
  /** decrypted deploy credential (unused by mock/AWS-assume-role); some real
   * providers (kubernetes kubeconfig, etc.) will need it */
  credential?: string;
  baseUrl?: string | null;
  /** aws: the customer IAM role to assume, and the region to deploy in */
  roleArn?: string | null;
  region?: string | null;
}

export function resolveDeployProvider(config: ResolveDeployProviderConfig): DeployProvider {
  if (config.provider === "mock") return new MockDeployProvider();
  if (config.provider === "aws") {
    return new AwsDeployProvider(config.roleArn ?? "", config.region ?? "");
  }
  // Declared-but-not-integrated: a template can reference these, but executing
  // one is a clear failure (→ manual handoff), never a pretend success.
  throw new DeployProviderError(
    `deploy provider '${config.provider}' is not integrated yet — use a mock/aws target or add the adapter`,
  );
}
