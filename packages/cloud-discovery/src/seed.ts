/**
 * ADR-0195 rule 5: seed rows for the admin catalogue (`ai_endpoint_signatures`) of signature kind
 * `cloud_ai_service`. A cloud observation becomes a finding only when an ENABLED row of this kind has a `value`
 * EQUAL to the observation's `serviceKey`; nothing here is a pattern and nothing is evaluated as a regex.
 *
 * These rows are this slice's own seed file. They are not part of the compiled shadow-AI catalogue (v1 stays
 * byte-identical; SD1 owns v2). SD0 owns the signature-kind and match-type enums; `matchType: "service_key"` is
 * the value this slice proposes for exact equality and is reconciled with SD0's enum when the scanners are
 * registered (Phase B).
 *
 * Provenance follows the existing seed convention ("regulait-seed"); an admin edit flips a row to "admin" and the
 * seeder leaves it alone from then on.
 */
import { AWS_SERVICE_KEYS } from "./aws.js";
import { AZURE_SERVICE_KEYS } from "./azure.js";
import { GCP_SERVICE_KEYS } from "./gcp.js";

export interface CloudAiServiceSeedRow {
  provider: string;
  kind: "cloud_ai_service";
  /** the exact `serviceKey` an observation carries */
  value: string;
  matchType: "service_key";
  provenance: "regulait-seed";
  enabled: true;
  /** where the service is documented, for the per-row staleness disclosure */
  reference: string;
  replacementNote: string;
}

const row = (provider: string, value: string, reference: string): CloudAiServiceSeedRow =>
  Object.freeze({
    provider,
    kind: "cloud_ai_service",
    value,
    matchType: "service_key",
    provenance: "regulait-seed",
    enabled: true,
    reference,
    replacementNote: "route this workload through a governed RegulAIt agent registration",
  });

export const CLOUD_AI_SERVICE_SEED: ReadonlyArray<CloudAiServiceSeedRow> = Object.freeze([
  row("aws-bedrock", AWS_SERVICE_KEYS.bedrock, "https://docs.aws.amazon.com/bedrock/latest/userguide/what-is-bedrock.html"),
  row("aws-sagemaker", AWS_SERVICE_KEYS.sagemaker, "https://docs.aws.amazon.com/sagemaker/latest/dg/whatis.html"),
  row("google-vertex", GCP_SERVICE_KEYS["aiplatform.googleapis.com"], "https://cloud.google.com/vertex-ai/docs"),
  row("google", GCP_SERVICE_KEYS["generativelanguage.googleapis.com"], "https://ai.google.dev/api"),
  row("azure-openai", AZURE_SERVICE_KEYS.openai, "https://learn.microsoft.com/azure/ai-services/openai/overview"),
  row("azure-ai-services", AZURE_SERVICE_KEYS.aiServices, "https://learn.microsoft.com/azure/ai-services/what-are-ai-services"),
  row("azure-ml", AZURE_SERVICE_KEYS.machineLearning, "https://learn.microsoft.com/azure/machine-learning/overview-what-is-azure-machine-learning"),
  row("azure-ai-foundry", AZURE_SERVICE_KEYS.aiFoundry, "https://learn.microsoft.com/azure/ai-foundry/what-is-azure-ai-foundry"),
]);
