/**
 * ADR-0339 slice 2 — the non-human identity vocabulary: each provider accepts the identifiers it issues and refuses the
 * others; the stage schema is strict and bounded.
 */
import { describe, expect, it } from "vitest";
import { AGENT_NHI_PROVIDERS, stageAgentNhiLinkSchema, validNhiExternalId } from "./agent-identity.js";

const GOOD: Record<(typeof AGENT_NHI_PROVIDERS)[number], string[]> = {
  aws: ["arn:aws:iam::123456789012:role/agent-runtime", "arn:aws-us-gov:bedrock-agentcore:us-gov-west-1:123456789012:runtime/abc-123"],
  azure: ["3f2504e0-4f89-11d3-9a0c-0305e82c3301", "/subscriptions/3f2504e0-4f89-11d3-9a0c-0305e82c3301/resourceGroups/rg1/providers/Microsoft.ManagedIdentity/userAssignedIdentities/agent"],
  gcp: ["agent-runner@my-project-01.iam.gserviceaccount.com", "projects/my-project/locations/global/agents/a1"],
  entra: ["3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
  okta: ["0oa1b2c3d4e5f6g7h8i9"],
  other: ["svc:agent-runner/1"],
};
const BAD: Record<(typeof AGENT_NHI_PROVIDERS)[number], string[]> = {
  aws: ["arn:aws:iam::12345:role/x", "role/agent", "arn:aws:iam::123456789012:"],
  azure: ["not-a-guid", "/subscriptions/x/resourceGroups/rg/providers/p"],
  gcp: ["someone@example.com", "agent@project.iam.gserviceaccount.com.evil"],
  entra: ["arn:aws:iam::123456789012:role/x"],
  okta: ["0oa1", "client-id"],
  other: ["has space", "", "x".repeat(257)],
};

describe("ADR-0339 non-human identity vocabulary", () => {
  it.each(AGENT_NHI_PROVIDERS)("%s accepts its own identifiers and refuses others", (p) => {
    for (const id of GOOD[p]) expect(validNhiExternalId(p, id), id).toBe(true);
    for (const id of BAD[p]) expect(validNhiExternalId(p, id), id).toBe(false);
  });

  it("the stage body is strict and checks the identifier against the provider", () => {
    expect(stageAgentNhiLinkSchema.safeParse({ kind: "cloud_service_account", provider: "aws", externalId: GOOD.aws[0] }).success).toBe(true);
    expect(stageAgentNhiLinkSchema.safeParse({ kind: "cloud_service_account", provider: "gcp", externalId: GOOD.aws[0] }).success).toBe(false);
    expect(stageAgentNhiLinkSchema.safeParse({ kind: "cloud_service_account", provider: "aws", externalId: GOOD.aws[0], extra: 1 }).success).toBe(false);
    expect(stageAgentNhiLinkSchema.safeParse({ kind: "human", provider: "aws", externalId: GOOD.aws[0] }).success).toBe(false);
  });
});
