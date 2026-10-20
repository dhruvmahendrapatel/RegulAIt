/**
 * ADR-0197 decision 7 — the FALLBACK Shadow-AI discovery dataset `demo:prepare` seeds, so a fresh demo database
 * tells the discovery story (repositories, two clouds, an endpoint agent and an MDM export, a remediation plan in
 * approval, content provenance) even when no live scan can run.
 *
 * Everything here is fictional and belongs to the demo company of `DEMO_INTAKE_FIXTURES` (Acme Bank). No person is
 * named: device users, commit authors and cloud principals are role or team labels, and the platform pseudonymises
 * each one before it is stored (ADR-0195 decision 20). Account, tenant and subscription ids are documentation-style
 * placeholders. Environment-variable and CLI names appear only where the platform's own matchers read them (the
 * recorded `.env.example` and the agent's facts); the platform keeps the presence signature id, never the name
 * (ADR-0195 lane A6). No value is secret-shaped (gitleaks): the GitLab token is minted at run time by the seeder.
 *
 * The data is replayed through the product's own paths (see `apps/gateway/src/demo-shadow-seed-lib.ts`):
 *  - the GitLab repositories through the real SD1 repo scanner, over a recorded read-only repository reader;
 *  - the AWS and Azure scans as the cloud adapters' recorded observations, committed by the real SD0 worker;
 *  - the MDM export through the SD3 import route; the endpoint agent through enrolment, registration and a signed
 *    report (SD4b).
 */

/** a repository file as the recorded reader serves it */
export interface DemoShadowRepoFile {
  path: string;
  content: string;
}

export interface DemoShadowRepo {
  /** `group/project` on the demo GitLab */
  fullName: string;
  /** the head commit (40 hex) the recorded tree is at */
  commitSha: string;
  /** a team label, never a person: pseudonymised as the commit author */
  author: string;
  files: DemoShadowRepoFile[];
}

/** a cloud adapter observation as `@regulait/cloud-discovery` reports it (structurally its `CloudObservation`) */
export interface DemoShadowCloudObservation {
  subjectKind: "cloud_resource" | "cloud_principal";
  /** a resource id; for a principal the RAW identifier, which the worker pseudonymises before anything is stored */
  subject: string;
  serviceKey: string;
  signalSource: "cloud_inventory" | "cloud_audit_log";
  resourceType: string;
  location: string;
  callCount?: number;
  operations?: string[];
}

/** what the recorded cloud scan says it read (structurally a `CapabilityReport`) */
export interface DemoShadowCapability {
  capability: string;
  scope: string | null;
  items: number;
}

/** one endpoint agent fact, in the SD4a report's terms */
export interface DemoShadowAgentFact {
  kind: "desktop_app" | "ide_extension" | "cli" | "env_name";
  signatureId: string;
  provider: string;
  matchedOn: "bundleId" | "extensionId" | "executable" | "envName";
  identifier: string;
  location: { root: "home" | "system_applications" | "path"; path: string };
}

export interface DemoShadowDiscoveryDataset {
  /** the demo company the dataset belongs to (matches DEMO_INTAKE_FIXTURES.company.name) */
  company: string;
  /** every source name ends with this, so a live source of the same account never collides with the fallback */
  sourceSuffix: string;
  gitlab: { name: string; namespace: string; repos: DemoShadowRepo[] };
  aws: {
    name: string;
    accountId: string;
    regions: string[];
    roleArn: string;
    observations: DemoShadowCloudObservation[];
    capabilities: DemoShadowCapability[];
  };
  azure: {
    name: string;
    tenantId: string;
    clientId: string;
    subscriptionId: string;
    observations: DemoShadowCloudObservation[];
    capabilities: DemoShadowCapability[];
  };
  inventory: { name: string; exporter: string; csv: string };
  agent: {
    name: string;
    fleet: string;
    tokenLabel: string;
    /** the enrolled laptop; the platform keeps only its pseudonym */
    hostname: string;
    deviceUser: string;
    os: "darwin";
    arch: "arm64";
    agentVersion: string;
    facts: DemoShadowAgentFact[];
  };
  /** the finding the remediation beat opens: the GitLab repository below */
  remediation: {
    repo: string;
    environment: string;
    deployTargetName: string;
    plan: string;
  };
  /** a keyless mock connector an admin marked trusted, read twice so the content-trust page has provenance records */
  contentTrust: { connectorName: string; connectorKind: string; objects: string[] };
  /**
   * the presence signature ids the repo scanner must report from the recorded `.env.example`: what is kept in place
   * of the names (ADR-0195 lane A6). demo:check fails when one is missing. The agent's CLI fact is not one: the
   * endpoint catalogue has no CLI row for it, so the gateway drops it as unmatched (counted, never stored).
   */
  presenceSignatures: string[];
  /**
   * the fictional provider the Shadow AI import example names (owner decision on #453): the seeder catalogues its host
   * so the example's dry run matches on the fallback stack. The SPA mirrors it (`shadowAiExample.ts`, pinned by its test).
   */
  importExample: { provider: string; host: string };
}

const SUFFIX = " (demo dataset)";
const ACCOUNT = "123456789012";
const SUBSCRIPTION = "00000000-0000-4000-8000-00000000a0b1";
const AZ_RG = `/subscriptions/${SUBSCRIPTION}/resourceGroups/acme-ai-eu`;

export const DEMO_SHADOW_DISCOVERY: DemoShadowDiscoveryDataset = {
  company: "Acme Bank",
  sourceSuffix: SUFFIX,
  gitlab: {
    name: `Acme Bank GitLab${SUFFIX}`,
    namespace: "acme-bank-demo",
    repos: [
      {
        fullName: "acme-bank-demo/credit-memo-assistant",
        commitSha: "3f1c2a9e8b7d6c5f4e3d2c1b0a99887766554433",
        author: "Credit Platform Team",
        files: [
          {
            path: "package.json",
            content: JSON.stringify(
              { name: "credit-memo-assistant", private: true, dependencies: { "@anthropic-ai/sdk": "0.30.0", express: "4.21.0" } },
              null,
              2,
            ),
          },
          {
            path: "src/memo.ts",
            content:
              'import Anthropic from "@anthropic-ai/sdk";\n\n' +
              "// drafts a credit memo from the analyst's notes\n" +
              "export const client = new Anthropic();\n",
          },
          // presence only: the analyser reduces these names to signature ids, and only the ids are kept
          { path: ".env.example", content: "ANTHROPIC_API_KEY=\nPORT=8080\n" },
          { path: ".vscode/extensions.json", content: JSON.stringify({ recommendations: ["GitHub.copilot"] }) },
        ],
      },
      {
        fullName: "acme-bank-demo/support-ticket-triage",
        commitSha: "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9",
        author: "Customer Care Engineering",
        files: [
          { path: "requirements.txt", content: "openai==1.51.0\nfastapi==0.115.0\n" },
          {
            path: "triage/classify.py",
            content: 'import openai\n\nMODEL_URL = "https://api.openai.com/v1"\n\n# routes inbound tickets to a queue\n',
          },
          { path: ".env.example", content: "OPENAI_API_KEY=\nQUEUE_URL=\n" },
        ],
      },
    ],
  },
  aws: {
    name: `Acme Bank AWS sandbox${SUFFIX}`,
    accountId: ACCOUNT,
    regions: ["us-east-1", "eu-west-1"],
    roleArn: `arn:aws:iam::${ACCOUNT}:role/regulait-discovery-readonly`,
    observations: [
      {
        subjectKind: "cloud_resource",
        subject: `arn:aws:bedrock:eu-west-1:${ACCOUNT}:custom-model/acme-complaints-summariser`,
        serviceKey: "aws:bedrock",
        signalSource: "cloud_inventory",
        resourceType: "bedrock.custom_model",
        location: "eu-west-1",
      },
      {
        subjectKind: "cloud_resource",
        subject: `arn:aws:sagemaker:us-east-1:${ACCOUNT}:endpoint/fraud-score-llm`,
        serviceKey: "aws:sagemaker",
        signalSource: "cloud_inventory",
        resourceType: "sagemaker.endpoint",
        location: "us-east-1",
      },
      {
        subjectKind: "cloud_principal",
        subject: `arn:aws:iam::${ACCOUNT}:role/marketing-analytics-batch`,
        serviceKey: "aws:bedrock",
        signalSource: "cloud_audit_log",
        resourceType: "principal",
        location: "eu-west-1",
        callCount: 412,
        operations: ["InvokeModel", "Converse"],
      },
    ],
    capabilities: [
      { capability: "aws.bedrock.custom_models", scope: "eu-west-1", items: 1 },
      { capability: "aws.sagemaker.endpoints", scope: "us-east-1", items: 1 },
      { capability: "aws.cloudtrail.lookup_events", scope: "eu-west-1", items: 412 },
    ],
  },
  azure: {
    name: `Acme Bank Azure${SUFFIX}`,
    tenantId: "00000000-0000-4000-8000-00000000a0a1",
    clientId: "00000000-0000-4000-8000-00000000a0c1",
    subscriptionId: SUBSCRIPTION,
    observations: [
      {
        subjectKind: "cloud_resource",
        subject: `${AZ_RG}/providers/Microsoft.CognitiveServices/accounts/acme-openai-eu`,
        serviceKey: "azure:cognitive-services:OpenAI",
        signalSource: "cloud_inventory",
        resourceType: "cognitive_services.account",
        location: "westeurope",
      },
      {
        subjectKind: "cloud_resource",
        subject: `${AZ_RG}/providers/Microsoft.CognitiveServices/accounts/acme-openai-eu/deployments/branch-faq-bot`,
        serviceKey: "azure:cognitive-services:OpenAI",
        signalSource: "cloud_inventory",
        resourceType: "cognitive_services.deployment",
        location: "westeurope",
      },
    ],
    capabilities: [
      { capability: "azure.resource_graph.cognitive_accounts", scope: SUBSCRIPTION, items: 1 },
      { capability: "azure.resource_graph.cognitive_deployments", scope: SUBSCRIPTION, items: 1 },
    ],
  },
  inventory: {
    name: `Acme Bank MDM inventory${SUFFIX}`,
    exporter: "acme-mdm",
    // device and user labels are pseudonymised by the importer; nothing here names a person
    csv: [
      "Computer Name,Software,Bundle ID,User,OS",
      "ACME-LT-0412,ChatGPT.app,com.openai.chat,trading-desk-07,macOS 15",
      "ACME-LT-0533,Claude.app,com.anthropic.claudefordesktop,risk-analyst-12,macOS 15",
      "ACME-LT-0587,Cursor.app,com.todesktop.230313mzl4w4u92,mobile-dev-03,macOS 14",
    ].join("\n"),
  },
  agent: {
    name: `Acme Bank laptops (endpoint agent)${SUFFIX}`,
    fleet: "acme-bank-laptops",
    tokenLabel: "Acme Bank pilot laptops",
    hostname: "ACME-LT-0618",
    deviceUser: "wealth-advisor-21",
    os: "darwin",
    arch: "arm64",
    agentVersion: "0.1.0",
    facts: [
      {
        kind: "desktop_app",
        signatureId: "atr.claude.bundle_id.com-anthropic-claudefordesktop",
        provider: "anthropic",
        matchedOn: "bundleId",
        identifier: "com.anthropic.claudefordesktop",
        location: { root: "system_applications", path: "Claude.app" },
      },
      // no endpoint catalogue row matches a CLI by executable, so the gateway drops this fact as unmatched (counted)
      {
        kind: "cli",
        signatureId: "cli.anthropic.claude",
        provider: "anthropic",
        matchedOn: "executable",
        identifier: "claude",
        location: { root: "path", path: "claude" },
      },
      // refused by the gateway and only counted: an env-variable name is never stored (ADR-0195 lane A6)
      {
        kind: "env_name",
        signatureId: "env.openai.api-key",
        provider: "openai",
        matchedOn: "envName",
        identifier: "OPENAI_API_KEY",
        location: { root: "home", path: ".zshrc" },
      },
    ],
  },
  remediation: {
    repo: "acme-bank-demo/credit-memo-assistant",
    environment: "staging",
    deployTargetName: "acme-staging",
    plan:
      "# Remediation plan: credit-memo-assistant\n\n" +
      "1. Register the credit-memo drafting use case and route it through the governed agent.\n" +
      "2. Replace the direct SDK client with the gateway endpoint; remove the provider key from the service.\n" +
      "3. Confirm the next call appears in the audit log and the usage ledger, then close the finding.",
  },
  contentTrust: {
    connectorName: "acme-policy-library",
    connectorKind: "knowledge-base",
    objects: ["lending-policy", "complaints-handling-policy"],
  },
  presenceSignatures: ["env.anthropic.api-key"],
  importExample: { provider: "Acme LLM", host: "api.acme-llm.example" },
};
