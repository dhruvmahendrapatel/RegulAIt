/**
 * @regulait/cloud-discovery — ADR-0195 slice SD2: read-only AI-service discovery in AWS, GCP and Azure.
 *
 * The package holds the cloud SDK dependencies, the guarded transports, the credential builders and the three
 * `CloudScanner` adapters. It has no database access: SD0's scan worker supplies the credential (decrypted for the
 * run), the guarded fetch, the OIDC token supplier and the principal pseudonymiser, and stores what comes back.
 */
export * from "./types.js";
export * from "./credentials.js";
export * from "./transport.js";
export { classifyError, digestObservations } from "./report.js";
export { AwsCloudScanner, awsCredentialProvider, listOrganizationAccounts, AWS_ORG_MAX_MEMBER_ACCOUNTS, AWS_SERVICE_KEYS, AWS_LOOKUP_EVENT_NAMES, type AwsOrganizationScan, type AwsScanTarget, type AwsScannerDeps, type AwsTrailBucket } from "./aws.js";
export { GcpCloudScanner, gcpAuthClient, GCP_AI_SERVICES, GCP_SERVICE_KEYS, GCP_VERTEX_ASSET_TYPES, type GcpScanTarget, type GcpScannerDeps } from "./gcp.js";
export { AzureCloudScanner, azureCredential, AZURE_SERVICE_KEYS, type AzureScanTarget, type AzureScannerDeps } from "./azure.js";
export { CLOUD_AI_SERVICE_SEED, type CloudAiServiceSeedRow } from "./seed.js";
