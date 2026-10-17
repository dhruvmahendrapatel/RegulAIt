/**
 * Review of #404, finding 3: token-exchange responses carry credentials, so they go through `credentialFetch` (which
 * the gateway does not digest) and never through the scan `fetch` (which it does). API calls go the other way.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AwsCloudScanner } from "./aws.js";
import { AzureCloudScanner } from "./azure.js";
import { GcpCloudScanner, gcpTransportFetch } from "./gcp.js";
import { awsSts, fakeCloud, json, synthetic, testPseudonymise, type RecordedCall } from "./test-cloud.js";
import type { CloudScanContext } from "./types.js";

const ctx = (): CloudScanContext => ({ now: new Date("2026-10-17T12:00:00Z"), auditLookbackDays: 7, pseudonymise: testPseudonymise, maxPagesPerCall: 2 });

function routes(c: RecordedCall): Response {
  const h = c.url.hostname;
  const sts = awsSts(c);
  if (sts) return sts;
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

  it("GCP static key: no token exchange (a self-signed JWT), so nothing on credentialFetch and no credential host on fetch", async () => {
    const s = split();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyJson = JSON.stringify({ type: "service_account", client_email: "s@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    await new GcpCloudScanner({ projectIds: ["p"] }, { fetch: s.scan.fetch, credentialFetch: s.cred.fetch, credential: { mode: "gcp_service_account_key", keyJson } }).scan(ctx());
    expect(s.credHosts()).toEqual([]);
    expect(s.scanHosts().filter(isCredentialHost)).toEqual([]);
    expect(s.scanHosts()).toContain("serviceusage.googleapis.com");
  });

  it("the GCP transport routes every credential host, oauth2 included, to credentialFetch (recheck finding 1)", async () => {
    const s = split();
    const f = gcpTransportFetch({ fetch: s.scan.fetch, credentialFetch: s.cred.fetch });
    for (const h of ["oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"]) await f(`https://${h}/token`, { method: "POST" });
    await f("https://serviceusage.googleapis.com/v1/x");
    expect(s.credHosts()).toEqual(["iamcredentials.googleapis.com", "oauth2.googleapis.com", "sts.googleapis.com"]);
    expect(s.scanHosts()).toEqual(["serviceusage.googleapis.com"]);
  });
});

describe("every short-lived credential is registered with onSecret", () => {
  it("GCP federation: the OIDC assertion, the STS token and the impersonated token", async () => {
    const seen: string[] = [];
    const s = split();
    const oidc = synthetic("oidc");
    await new GcpCloudScanner(
      { projectIds: ["p"] },
      {
        fetch: s.scan.fetch,
        credentialFetch: s.cred.fetch,
        onSecret: (v) => seen.push(v),
        credential: { mode: "gcp_workload_identity", audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/a/providers/b", serviceAccountEmail: "s@p.iam.gserviceaccount.com" },
        oidcToken: async () => oidc,
      },
    ).scan(ctx());
    expect(seen).toContain(oidc);
    // two exchanges (STS, then IAM Credentials), each returning one token, both registered; and the bearer token
    // actually sent on the API calls is among them
    expect(s.cred.calls.length).toBe(2);
    expect(seen.filter((v) => v.startsWith("at-")).length).toBeGreaterThanOrEqual(2);
    const sent = s.scan.calls.map((c) => (c.headers.get("authorization") ?? "").slice(7));
    expect(sent.length).toBeGreaterThan(0);
    for (const t of sent) expect(seen).toContain(t);
  });

  it("Azure: the Entra access token returned and sent", async () => {
    const seen: string[] = [];
    const s = split();
    await new AzureCloudScanner(
      { subscriptionIds: ["00000000-0000-4000-8000-0000000000aa"] },
      { fetch: s.scan.fetch, credentialFetch: s.cred.fetch, onSecret: (v) => seen.push(v), credential: { mode: "azure_client_secret", tenantId: "00000000-0000-4000-8000-000000000001", clientId: "c", clientSecret: synthetic("cs") } },
    ).scan(ctx());
    const sent = [...new Set(s.scan.calls.map((c) => (c.headers.get("authorization") ?? "").slice(7)))];
    expect(sent.length).toBe(1);
    expect(seen).toContain(sent[0]);
  });
});
