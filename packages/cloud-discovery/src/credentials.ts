/**
 * ADR-0195 decision 3: cloud credentials. Federated, short-lived credentials are the default; static keys are an
 * admin relaxation that SD0 stores (encrypted, step-up gated, never returned) and hands to this package as input
 * only. This package never persists, logs or returns a credential.
 *
 * Federated modes present an OIDC token minted by RegulAIt's own workload identity issuer (ADR-0188) to the
 * cloud's token exchange, through the guarded transport:
 *
 *  - AWS `AssumeRoleWithWebIdentity` (audience `sts.amazonaws.com` by default; the customer's IAM OIDC provider
 *    lists it as a client id). Where an AWS principal already exists, `AssumeRole` with an external id RegulAIt
 *    generates per source (`generateExternalId`); the admin never chooses it.
 *  - GCP workload identity federation: an STS token exchange at `sts.googleapis.com`, optionally followed by
 *    service-account impersonation (google-auth-library's `IdentityPoolClient` with a programmatic subject token
 *    supplier).
 *  - Azure: a federated credential on an Entra app registration (`ClientAssertionCredential`, audience
 *    `api://AzureADTokenExchange`).
 *
 * NOT here, deliberately: the AWS default credential chain, Azure managed identity and GCP metadata-server
 * credentials. All three read the instance metadata service (169.254.169.254 or metadata.google.internal), which the
 * egress guard refuses unconditionally, and none would name which principal a source runs as. A source always says
 * exactly which credential it uses.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";

/** mints a short-lived OIDC token for one audience from RegulAIt's workload identity issuer (ADR-0188) */
export type OidcTokenSupplier = (audience: string) => Promise<string>;

export const AWS_DEFAULT_WEB_IDENTITY_AUDIENCE = "sts.amazonaws.com";
export const AZURE_FEDERATED_AUDIENCE = "api://AzureADTokenExchange";
export const GCP_STS_TOKEN_URL = "https://sts.googleapis.com/v1/token";
/** read-only scope; the GCP permission set does the real limiting, this keeps the token from being reusable for writes */
export const GCP_READ_ONLY_SCOPE = "https://www.googleapis.com/auth/cloud-platform.read-only";

// Bounded strings, checked by parsers and prefix tests, never by a regex on caller input (M-074 rule).
const bounded = (max: number) => z.string().min(1).max(max);

const awsRoleArn = bounded(2048).refine((v) => {
  const parts = v.split(":");
  return parts.length >= 6 && parts[0] === "arn" && parts[1]!.startsWith("aws") && parts[2] === "iam" && parts[5]!.startsWith("role/");
}, "must be an IAM role ARN");

/** AWS external ids allow 2-1224 characters; ours are always generated (see generateExternalId) */
const awsExternalId = z.string().min(2).max(1224);

export const awsCredentialSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("aws_web_identity"),
    roleArn: awsRoleArn,
    audience: bounded(256).default(AWS_DEFAULT_WEB_IDENTITY_AUDIENCE),
    roleSessionName: bounded(64).optional(),
  }),
  z.object({
    mode: z.literal("aws_assume_role"),
    roleArn: awsRoleArn,
    externalId: awsExternalId,
    roleSessionName: bounded(64).optional(),
  }),
  z.object({
    mode: z.literal("aws_static"),
    accessKeyId: bounded(128),
    secretAccessKey: bounded(256),
    sessionToken: bounded(4096).optional(),
  }),
]);
export type AwsCredentialInput = z.input<typeof awsCredentialSchema>;
export type AwsCredential = z.output<typeof awsCredentialSchema>;

const gcpWifAudience = bounded(512).refine(
  (v) => v.startsWith("//iam.googleapis.com/") && v.includes("/workloadIdentityPools/") && v.includes("/providers/"),
  "must be a workload identity pool provider resource name (//iam.googleapis.com/...)",
);

export const gcpCredentialSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("gcp_workload_identity"),
    /** the pool provider resource name, e.g. //iam.googleapis.com/projects/N/locations/global/workloadIdentityPools/P/providers/X */
    audience: gcpWifAudience,
    /** optional service account to impersonate after the exchange */
    serviceAccountEmail: bounded(320).optional(),
  }),
  z.object({
    mode: z.literal("gcp_service_account_key"),
    /** the key file JSON, as SD0 decrypted it for this run */
    keyJson: bounded(16384),
  }),
]);
export type GcpCredentialInput = z.input<typeof gcpCredentialSchema>;
export type GcpCredential = z.output<typeof gcpCredentialSchema>;

export const azureCredentialSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("azure_federated"), tenantId: bounded(256), clientId: bounded(256) }),
  z.object({ mode: z.literal("azure_client_secret"), tenantId: bounded(256), clientId: bounded(256), clientSecret: bounded(1024) }),
]);
export type AzureCredentialInput = z.input<typeof azureCredentialSchema>;
export type AzureCredential = z.output<typeof azureCredentialSchema>;

export type CloudCredentialMode = AwsCredential["mode"] | GcpCredential["mode"] | AzureCredential["mode"];

/** the static modes: each is an ADR-0180 relaxation SD0 gates with a `settings_relax` step-up */
export const STATIC_CREDENTIAL_MODES: ReadonlySet<CloudCredentialMode> = new Set(["aws_static", "gcp_service_account_key", "azure_client_secret"]);

export function isStaticCredential(mode: CloudCredentialMode): boolean {
  return STATIC_CREDENTIAL_MODES.has(mode);
}

/**
 * A fresh external id for one AWS source (decision 3: RegulAIt generates it per source; the admin never chooses
 * it). 32 random bytes, base64url, so it is unguessable and inside AWS's allowed character set.
 */
export function generateExternalId(): string {
  return `regulait-${randomBytes(32).toString("base64url")}`;
}

/** the subject RegulAIt's issuer should put in a federation token for one discovery source */
export function federationSubject(sourceId: string): string {
  return `regulait:discovery-source:${sourceId}`;
}

/** parse a decrypted service-account key file and keep only the two fields the JWT client needs */
export function parseServiceAccountKey(keyJson: string): { clientEmail: string; privateKey: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(keyJson);
  } catch {
    throw new Error("cloud-discovery: the GCP service-account key is not valid JSON");
  }
  const key = z
    .object({ type: z.literal("service_account"), client_email: bounded(320), private_key: bounded(8192) })
    .safeParse(parsed);
  if (!key.success) throw new Error("cloud-discovery: the GCP service-account key is missing client_email or private_key");
  return { clientEmail: key.data.client_email, privateKey: key.data.private_key };
}
