/**
 * Review of #404, finding 3: token-exchange responses carry credentials, so they go through `credentialFetch` (which
 * the gateway does not digest) and never through the scan `fetch` (which it does). API calls go the other way.
 */
import { describe, expect, it } from "vitest";
import { AwsCloudScanner } from "./aws.js";
import { AzureCloudScanner } from "./azure.js";
import { GcpCloudScanner } from "./gcp.js";
import { fakeCloud, json, synthetic, testPseudonymise, xml, type RecordedCall } from "./test-cloud.js";
import type { CloudScanContext } from "./types.js";

const ctx = (): CloudScanContext => ({ now: new Date("2026-10-17T12:00:00Z"), auditLookbackDays: 7, pseudonymise: testPseudonymise, maxPagesPerCall: 2 });

function routes(c: RecordedCall): Response {
  const h = c.url.hostname;
  if (h.startsWith("sts.") && h.endsWith("amazonaws.com")) {
    return xml(`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>${synthetic("a")}</AccessKeyId><SecretAccessKey>${synthetic("s")}</SecretAccessKey><SessionToken>${synthetic("t")}</SessionToken><Expiration>2026-10-17T13:00:00Z</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`);
  }
  if (h.startsWith("account.")) return json({ Regions: [{ RegionName: "us-east-1", RegionOptStatus: "ENABLED_BY_DEFAULT" }] });
  if (h === "sts.googleapis.com") return json({ access_token: synthetic("at"), issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3600 });
  if (h === "iamcredentials.googleapis.com") return json({ accessToken: synthetic("at"), expireTime: "2026-10-17T13:00:00Z" });
  if (h === "login.microsoftonline.com") {
    const tenant = c.url.pathname.split("/")[1];
    const base = `https://login.microsoftonline.com/${tenant}`;
    if (c.url.pathname.endsWith("/discovery/instance")) return json({ tenant_discovery_endpoint: `${base}/v2.0/.well-known/openid-configuration`, metadata: [] });
    if (c.url.pathname.endsWith("/openid-configuration")) return json({ token_endpoint: `${base}/oauth2/v2.0/token`, authorization_endpoint: `${base}/oauth2/v2.0/authorize`, issuer: `${base}/v2.0` });
    return json({ token_type: "Bearer", expires_in: 3600, access_token: synthetic("at") });
  }
  return json({ totalRecords: 0, count: 0, resultTruncated: "false", data: [], value: [] });
}

function split() {
  const scan = fakeCloud([routes]);
  const cred = fakeCloud([routes]);
  const hosts = (f: ReturnType<typeof fakeCloud>) => [...new Set(f.calls.map((c) => c.url.hostname))].sort();
  return { scan, cred, scanHosts: () => hosts(scan), credHosts: () => hosts(cred) };
}

const isCredentialHost = (h: string) =>
  (h.startsWith("sts.") && h.endsWith(".amazonaws.com")) || ["sts.googleapis.com", "iamcredentials.googleapis.com", "oauth2.googleapis.com", "login.microsoftonline.com"].includes(h);

describe("credential exchanges use credentialFetch, API calls use fetch (finding 3)", () => {
  it("AWS web identity: STS only on credentialFetch", async () => {
    const s = split();
    await new AwsCloudScanner(
      { accountId: "111122223333", regions: ["us-east-1"] },
      { fetch: s.scan.fetch, credentialFetch: s.cred.fetch, credential: { mode: "aws_web_identity", roleArn: "arn:aws:iam::111122223333:role/r" }, oidcToken: async () => synthetic("oidc") },
    ).scan(ctx());
    expect(s.credHosts()).toEqual(["sts.us-east-1.amazonaws.com"]);
    expect(s.scanHosts().filter(isCredentialHost)).toEqual([]);
    expect(s.scanHosts()).toContain("bedrock.us-east-1.amazonaws.com");
  });

  it("GCP federation with impersonation: STS and IAM Credentials only on credentialFetch", async () => {
    const s = split();
    await new GcpCloudScanner(
      { projectIds: ["p"] },
      {
        fetch: s.scan.fetch,
        credentialFetch: s.cred.fetch,
        credential: { mode: "gcp_workload_identity", audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/a/providers/b", serviceAccountEmail: "s@p.iam.gserviceaccount.com" },
        oidcToken: async () => synthetic("oidc"),
      },
    ).scan(ctx());
    expect(s.credHosts()).toEqual(["iamcredentials.googleapis.com", "sts.googleapis.com"]);
    expect(s.scanHosts().filter(isCredentialHost)).toEqual([]);
    expect(s.scanHosts()).toContain("serviceusage.googleapis.com");
  });

  it("Azure: the Entra authority only on credentialFetch", async () => {
    const s = split();
    await new AzureCloudScanner(
      { subscriptionIds: ["00000000-0000-4000-8000-0000000000aa"] },
      { fetch: s.scan.fetch, credentialFetch: s.cred.fetch, credential: { mode: "azure_client_secret", tenantId: "00000000-0000-4000-8000-000000000001", clientId: "c", clientSecret: synthetic("cs") } },
    ).scan(ctx());
    expect(s.credHosts()).toEqual(["login.microsoftonline.com"]);
    expect(s.scanHosts()).toEqual(["management.azure.com"]);
  });
});
