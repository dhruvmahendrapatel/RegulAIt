/**
 * Review of #404, finding 1: ambient configuration must not move a signed or bearer call to another host. The
 * process environment is poisoned with every endpoint override the three SDKs read (AWS endpoint URLs, a shared
 * config profile with `endpoint_url`, FIPS and dual-stack switches; GOOGLE_CLOUD_UNIVERSE_DOMAIN; AZURE_AUTHORITY_HOST),
 * and each adapter must still call only the public hosts its region or tenant names.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AwsCloudScanner } from "./aws.js";
import { AzureCloudScanner } from "./azure.js";
import { GcpCloudScanner } from "./gcp.js";
import { awsSts, fakeCloud, json, synthetic, testPseudonymise, type RecordedCall } from "./test-cloud.js";
import type { CloudScanContext } from "./types.js";

const EVIL = "evil.example";
const ctx = (): CloudScanContext => ({ now: new Date("2026-10-17T12:00:00Z"), auditLookbackDays: 7, pseudonymise: testPseudonymise, maxPagesPerCall: 2 });

const POISON: Record<string, string> = {
  AWS_ENDPOINT_URL: `https://aws.${EVIL}`,
  AWS_ENDPOINT_URL_BEDROCK: `https://bedrock.${EVIL}`,
  AWS_ENDPOINT_URL_STS: `https://sts.${EVIL}`,
  AWS_USE_FIPS_ENDPOINT: "true",
  AWS_USE_DUALSTACK_ENDPOINT: "true",
  AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "false",
  AWS_PROFILE: "poison",
  GOOGLE_CLOUD_UNIVERSE_DOMAIN: EVIL,
  AZURE_AUTHORITY_HOST: `https://login.${EVIL}`,
};

function entra(c: RecordedCall): Response | undefined {
  if (!c.url.hostname.startsWith("login.")) return undefined;
  const tenant = c.url.pathname.split("/")[1];
  const base = `https://${c.url.hostname}/${tenant}`;
  if (c.url.pathname.endsWith("/discovery/instance")) return json({ tenant_discovery_endpoint: `${base}/v2.0/.well-known/openid-configuration`, metadata: [] });
  if (c.url.pathname.endsWith("/openid-configuration")) {
    return json({ token_endpoint: `${base}/oauth2/v2.0/token`, authorization_endpoint: `${base}/oauth2/v2.0/authorize`, issuer: `${base}/v2.0` });
  }
  return json({ token_type: "Bearer", expires_in: 3600, access_token: synthetic("at") });
}

describe("ambient endpoint configuration is ignored (finding 1)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "regulait-awscfg-"));
    const cfg = join(dir, "config");
    writeFileSync(cfg, `[profile poison]\nendpoint_url = https://profile.${EVIL}\nuse_fips_endpoint = true\n`);
    for (const [k, v] of Object.entries({ ...POISON, AWS_CONFIG_FILE: cfg, AWS_SHARED_CREDENTIALS_FILE: join(dir, "none") })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("AWS: every call, the STS exchange included, goes to the region's public host", async () => {
    const cloud = fakeCloud([
      (c) => awsSts(c),
      (c) => (c.url.hostname.startsWith("account.") ? json({ Regions: [{ RegionName: "us-east-1", RegionOptStatus: "ENABLED_BY_DEFAULT" }] }) : undefined),
      () => json({}),
    ]);
    const scanner = new AwsCloudScanner(
      { accountId: "111122223333", regions: ["us-east-1"] },
      { fetch: cloud.fetch, credential: { mode: "aws_web_identity", roleArn: "arn:aws:iam::111122223333:role/r" }, oidcToken: async () => synthetic("oidc") },
    );
    await scanner.scan(ctx());
    const hosts = new Set(cloud.calls.map((c) => c.url.hostname));
    expect([...hosts].filter((h) => h.includes(EVIL) || h.includes("fips") || h.includes(".api.aws"))).toEqual([]);
    expect(hosts.has("sts.us-east-1.amazonaws.com")).toBe(true);
    expect(hosts.has("bedrock.us-east-1.amazonaws.com")).toBe(true);
  });

  it("GCP: every bearer call goes to googleapis.com", async () => {
    const cloud = fakeCloud([() => json({})]);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyJson = JSON.stringify({ type: "service_account", client_email: "s@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    await new GcpCloudScanner({ projectIds: ["p"] }, { fetch: cloud.fetch, credential: { mode: "gcp_service_account_key", keyJson } }).scan(ctx());
    const hosts = [...new Set(cloud.calls.map((c) => c.url.hostname))];
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.filter((h) => !h.endsWith(".googleapis.com"))).toEqual([]);
  });

  it("Azure: the token request goes to the public authority, not AZURE_AUTHORITY_HOST", async () => {
    const cloud = fakeCloud([entra, () => json({ totalRecords: 0, count: 0, resultTruncated: "false", data: [], value: [] })]);
    await new AzureCloudScanner(
      { subscriptionIds: ["00000000-0000-4000-8000-0000000000aa"] },
      { fetch: cloud.fetch, credential: { mode: "azure_client_secret", tenantId: "00000000-0000-4000-8000-000000000001", clientId: "c", clientSecret: synthetic("cs") } },
    ).scan(ctx());
    const hosts = new Set(cloud.calls.map((c) => c.url.hostname));
    expect([...hosts].filter((h) => h.includes(EVIL))).toEqual([]);
    expect(hosts.has("login.microsoftonline.com")).toBe(true);
  });
});
