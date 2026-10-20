/**
 * ADR-0195 SD2b: RegulAIt's cloud workload identity FEDERATION issuer. Pure constants and view types shared by the
 * gateway and the web app (no database, no network).
 *
 * A federated cloud discovery credential (AWS AssumeRoleWithWebIdentity, GCP workload identity federation, an Entra
 * federated credential) needs a short-lived OIDC token signed by an issuer the customer's cloud trusts. That issuer
 * is `<REGULAIT_PUBLIC_URL>/federation`, a separate issuer from the Ed25519 workload identity issuer of ADR-0188:
 * its keys are RS256 (the one algorithm all three clouds verify), generated in the product, and published at their
 * own JWKS, so a token of one issuer is never verifiable at the other.
 *
 * OFF BY DEFAULT (ADR-0180): federation is on only while an admin-activated key exists. Turning it on is a
 * `settings_relax` step-up; rotating and revoking are `key_management` step-ups bound to `{op, keyId}`; turning it
 * off is free. Every change is audited.
 */

/** the federation issuer's path under REGULAIT_PUBLIC_URL */
export const FEDERATION_ISSUER_PATH = "/federation";
/** OIDC discovery for the issuer `<origin>/federation` (OpenID Connect Discovery 1.0 §4) */
export const FEDERATION_DISCOVERY_PATH = "/federation/.well-known/openid-configuration";
/** the federation issuer's public keys (RS256 only) */
export const FEDERATION_JWKS_PATH = "/federation/.well-known/jwks.json";

/** a federation token lives at most this long (ADR-0195 SD2b: at most 5 minutes) */
export const FEDERATION_TOKEN_TTL_SECONDS = 300;
/** a retired key stays published this long: a token's lifetime plus a clock-skew margin */
export const FEDERATION_KEY_OVERLAP_SECONDS = 600;

/** the token subject for one discovery source: the customer's trust policy names it exactly */
export const federationSourceSubject = (sourceId: string): string => `regulait:discovery-source:${sourceId}`;
/** the token subject of RegulAIt's own AWS principal (the role it assumes customer roles from, with an external id) */
export const FEDERATION_AWS_PRINCIPAL_SUBJECT = "regulait:aws-principal";
/** the deployment variable naming RegulAIt's own AWS principal (an IAM role ARN trusting the federation issuer) */
export const AWS_PRINCIPAL_ROLE_ENV = "REGULAIT_AWS_PRINCIPAL_ROLE_ARN";

/** per-target audiences (a token is minted for exactly one) */
export const FEDERATION_AUDIENCES = Object.freeze({
  aws: "sts.amazonaws.com",
  azure: "api://AzureADTokenExchange",
  /** GCP: `https:` + the workload identity pool provider's resource name, per source */
  gcpPrefix: "https://iam.googleapis.com/projects/",
});

/** how a `cloud_aws` source's federated credential reaches the customer's role (target key `federation`) */
export const AWS_FEDERATION_TRUST_MODES = ["oidc", "principal"] as const;
export type AwsFederationTrustMode = (typeof AWS_FEDERATION_TRUST_MODES)[number];

export type FederationKeyState = "pending" | "active" | "retired" | "revoked";

export interface FederationKeyView {
  kid: string;
  algorithm: "RS256";
  state: FederationKeyState;
  /** in the federation JWKS now (active, or retired inside the overlap) */
  published: boolean;
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  revokedAt: string | null;
}

export interface FederationStatusView {
  /** on while an activated key exists */
  enabled: boolean;
  /** `<REGULAIT_PUBLIC_URL>/federation`, or null when the public URL is unset (then nothing can be minted) */
  issuer: string | null;
  jwksUri: string | null;
  tokenTtlSeconds: number;
  keys: FederationKeyView[];
  awsPrincipal: { configured: boolean; roleArn: string | null; subject: string };
  /** what a customer's trust policy must name, per cloud */
  subjectFormat: string;
  audiences: { aws: string; azure: string; gcp: string };
}

/** the key's state from its stamps */
export function federationKeyState(k: { activatedAt: unknown; retiredAt: unknown; revokedAt: unknown }): FederationKeyState {
  if (k.revokedAt) return "revoked";
  if (k.retiredAt) return "retired";
  if (k.activatedAt) return "active";
  return "pending";
}

// ---------------------------------------------------------------------------
// ADR-0195 A5: federated git-provider credentials
// ---------------------------------------------------------------------------

/**
 * How each repo source kind is reached without a stored per-source token (checked against the providers' documentation
 * on 2026-10-18; see ADR-0195 "As built: A5"):
 *  - `entra_workload_identity` (Azure DevOps): a federation token (aud `api://AzureADTokenExchange`) is exchanged at
 *    Entra for an access token to Azure DevOps. Fully keyless.
 *  - `github_app_installation` (GitHub): GitHub accepts no external OIDC token for its API. The deployment's GitHub App
 *    key (a deploy-time file, never in the database) signs a short JWT that is exchanged for a 1-hour installation
 *    token, downscoped to read-only contents and metadata.
 *  - null (GitLab, Bitbucket): no inbound federation exists; a stored read-only token is the explicit fallback.
 */
export type RepoFederationMechanism = "entra_workload_identity" | "github_app_installation";
export const REPO_FEDERATION_MECHANISM = Object.freeze({
  repo_github: "github_app_installation",
  repo_gitlab: null,
  repo_bitbucket: null,
  repo_azure_devops: "entra_workload_identity",
} as const satisfies Record<string, RepoFederationMechanism | null>);

/** null when the kind can use a federated credential; otherwise why not (shown to the admin) */
export function federationUnsupportedReason(kind: string): string | null {
  if (kind === "repo_gitlab" || kind === "repo_bitbucket") {
    const name = kind === "repo_gitlab" ? "GitLab" : "Bitbucket";
    return `${name} accepts no external OIDC token for its API, so a federated credential cannot work; store a read-only access token in static mode (a relaxation, confirmed with a step-up)`;
  }
  return null;
}

/** secure by default (ADR-0180): federated wherever the provider supports it, a stored token only where it does not */
export function defaultCredentialMode(kind: string): "federated" | "static" {
  return federationUnsupportedReason(kind) ? "static" : "federated";
}

/** the Azure DevOps resource an Entra access token is requested for (the `.default` scope of its application id) */
export const AZURE_DEVOPS_ENTRA_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";

/** the deployment variables naming RegulAIt's GitHub App: its numeric App id and the path of its private key PEM */
export const GITHUB_APP_ID_ENV = "REGULAIT_GITHUB_APP_ID";
export const GITHUB_APP_PRIVATE_KEY_FILE_ENV = "REGULAIT_GITHUB_APP_PRIVATE_KEY_FILE";
/** the deployment's GitHub API, where the App JWT is sent (a source's own `baseUrl` never decides that) */
export const GITHUB_APP_API_URL_ENV = "REGULAIT_GITHUB_APP_API_URL";
export const GITHUB_APP_API_URL_DEFAULT = "https://api.github.com";
/** the only permissions an installation token is requested with; any other granted permission is refused */
export const GITHUB_APP_READ_PERMISSIONS = Object.freeze({ contents: "read", metadata: "read" } as const);
