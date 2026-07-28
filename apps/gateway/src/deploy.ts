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

export interface ResolveDeployProviderConfig {
  provider: DeployProviderKind;
  /** decrypted deploy credential (unused by mock); real providers will need it */
  credential?: string;
  baseUrl?: string | null;
}

export function resolveDeployProvider(config: ResolveDeployProviderConfig): DeployProvider {
  if (config.provider === "mock") return new MockDeployProvider();
  // Declared-but-not-integrated: a template can reference these, but executing
  // one is a clear failure (→ manual handoff), never a pretend success.
  throw new DeployProviderError(
    `deploy provider '${config.provider}' is not integrated yet — use a mock target or add the adapter`,
  );
}
