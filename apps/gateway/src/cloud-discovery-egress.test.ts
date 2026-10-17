/**
 * ADR-0195 decision 8, proven by attack: every cloud SDK call made by `@regulait/cloud-discovery` leaves through
 * the gateway's REAL `createGuardedFetch`, and nothing else.
 *
 * Each case builds a scanner whose only network path is `createGuardedFetch` with a WILLING spy as its transport:
 * the spy would answer any request with a plausible cloud response. With an EMPTY allow list (the default-deny
 * posture; ADR-0195 ships no cloud host pre-allowed) the spy must record ZERO calls for all three clouds, global
 * fetch and node:http/https must record nothing either (a tripwire refuses and records them), and the scan must
 * report the refusal as `unreachable`, never as an empty inventory.
 *
 * The positive control allow-lists only some hosts: the spy then sees exactly those hosts and the matching reads
 * succeed, which proves the guard (not some other failure) is what stood in the way above.
 *
 * Pure, no database: runs without Postgres.
 */
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AwsCloudScanner,
  AzureCloudScanner,
  GcpCloudScanner,
  type CloudScanContext,
  type CloudScanResult,
} from "@regulait/cloud-discovery";
import { createGuardedFetch, type EgressAllowEntry, type EgressResolver } from "./egress-guard.js";

const publicResolver: EgressResolver = async () => [{ address: "93.184.216.34", family: 4 }];
const synthetic = (label: string) => `${label}-${randomBytes(12).toString("hex")}`;
const ctx = (): CloudScanContext => ({
  now: new Date("2026-10-17T12:00:00Z"),
  auditLookbackDays: 7,
  pseudonymise: async (p) => `pseudo:${p.provider}`,
  maxPagesPerCall: 2,
});
const allow = (...hosts: string[]): EgressAllowEntry[] => hosts.map((host) => ({ host, allowPrivateRanges: false, allowPlaintextHttp: false }));
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** a spy transport that would serve anything: the guard is the only thing that can stop a call */
function willingSpy() {
  const calls: string[] = [];
  const spy = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.hostname);
    if (url.hostname === "login.microsoftonline.com") {
      const tenant = url.pathname.split("/")[1];
      if (url.pathname.endsWith("/discovery/instance")) {
        return json({ tenant_discovery_endpoint: `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`, metadata: [] });
      }
      if (url.pathname.endsWith("/openid-configuration")) {
        return json({
          token_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
          authorization_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
          issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
        });
      }
      return json({ token_type: "Bearer", expires_in: 3600, access_token: synthetic("at") });
    }
    if (url.hostname === "management.azure.com") return json({ totalRecords: 0, count: 0, resultTruncated: "false", data: [], value: [] });
    return json({});
  }) as typeof fetch;
  return { spy, calls };
}

const guarded = (allowList: EgressAllowEntry[], spy: typeof fetch) => createGuardedFetch({ allowList, resolve: publicResolver, fetchImpl: spy });

const TENANT = "00000000-0000-4000-8000-000000000001";
const CLIENT = "00000000-0000-4000-8000-000000000002";
const SUB = "00000000-0000-4000-8000-0000000000aa";

function scanners(fetchImpl: typeof fetch) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyJson = JSON.stringify({ type: "service_account", client_email: "scanner@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  const oidcToken = async () => synthetic("oidc");
  return {
    awsFederated: new AwsCloudScanner({ accountId: "111122223333", regions: ["us-east-1"] }, { fetch: fetchImpl, credential: { mode: "aws_web_identity", roleArn: "arn:aws:iam::111122223333:role/r" }, oidcToken }),
    awsStatic: new AwsCloudScanner({ accountId: "111122223333", regions: ["us-east-1"] }, { fetch: fetchImpl, credential: { mode: "aws_static", accessKeyId: synthetic("akid"), secretAccessKey: synthetic("sk") } }),
    gcpFederated: new GcpCloudScanner({ projectIds: ["p"] }, { fetch: fetchImpl, credential: { mode: "gcp_workload_identity", audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/a/providers/b" }, oidcToken }),
    gcpStatic: new GcpCloudScanner({ projectIds: ["p"] }, { fetch: fetchImpl, credential: { mode: "gcp_service_account_key", keyJson } }),
    azureFederated: new AzureCloudScanner({ subscriptionIds: [SUB] }, { fetch: fetchImpl, credential: { mode: "azure_federated", tenantId: TENANT, clientId: CLIENT }, oidcToken }),
    azureStatic: new AzureCloudScanner({ subscriptionIds: [SUB] }, { fetch: fetchImpl, credential: { mode: "azure_client_secret", tenantId: TENANT, clientId: CLIENT, clientSecret: synthetic("cs") } }),
  };
}

const networkReads = (r: CloudScanResult) => r.capabilities.filter((c) => c.status !== "skipped" && c.status !== "not_enabled");

describe("cloud discovery: the guarded fetch is the only network path (ADR-0195 decision 8)", () => {
  const escaped: string[] = [];
  // every way out of the process a client could take without the guarded fetch
  const mods = { global: globalThis, http, https, net, tls, http2 } as unknown as Record<string, Record<string, unknown>>;
  const targets: Array<[string, string]> = [
    ["global", "fetch"], ["http", "request"], ["http", "get"], ["https", "request"], ["https", "get"],
    ["net", "connect"], ["net", "createConnection"], ["tls", "connect"], ["http2", "connect"],
  ];
  const saved = targets.map(([m, k]) => [m, k, mods[m]![k]] as const);
  beforeAll(() => {
    for (const [m, k] of targets) {
      mods[m]![k] = (...args: unknown[]) => {
        const a = args[0];
        escaped.push(`${m}.${k} ${a instanceof Request ? a.url : a instanceof URL ? a.href : typeof a === "string" ? a : String((a as { host?: unknown } | undefined)?.host)}`);
        throw new Error(`tripwire: ${m}.${k}`);
      };
    }
  });
  afterEach(() => {
    expect(escaped.splice(0)).toEqual([]);
  });
  afterAll(() => {
    for (const [m, k, v] of saved) mods[m]![k] = v;
  });

  it("tripwire positive control: an AWS client on its default handler is recorded", async () => {
    const client = new STSClient({ region: "us-east-1", credentials: { accessKeyId: synthetic("a"), secretAccessKey: synthetic("s") }, maxAttempts: 1 });
    await expect(client.send(new GetCallerIdentityCommand({}))).rejects.toThrow();
    expect(escaped.splice(0).some((e) => e.includes("sts.us-east-1.amazonaws.com"))).toBe(true);
  });

  for (const name of ["awsFederated", "awsStatic", "gcpFederated", "gcpStatic", "azureFederated", "azureStatic"] as const) {
    it(`${name}: with no host allow-listed, a willing spy records zero calls and every read is unreachable`, async () => {
      const { spy, calls } = willingSpy();
      const res = await scanners(guarded([], spy))[name].scan(ctx());
      expect(calls).toEqual([]);
      const reads = networkReads(res);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.filter((c) => c.status !== "unreachable")).toEqual([]);
      expect(res.observations).toEqual([]);
    });
  }

  it("positive control: allow-listed hosts are reached through the guard, and only those", async () => {
    const aws = willingSpy();
    const a = await scanners(guarded(allow("bedrock.us-east-1.amazonaws.com"), aws.spy)).awsStatic.scan(ctx());
    expect(new Set(aws.calls)).toEqual(new Set(["bedrock.us-east-1.amazonaws.com"]));
    expect(a.capabilities.find((c) => c.capability === "aws.bedrock.custom_models")?.status).toBe("read");
    expect(a.capabilities.find((c) => c.capability === "aws.sagemaker.endpoints")?.status).toBe("unreachable");

    const gcp = willingSpy();
    const g = await scanners(guarded(allow("serviceusage.googleapis.com"), gcp.spy)).gcpStatic.scan(ctx());
    expect(new Set(gcp.calls)).toEqual(new Set(["serviceusage.googleapis.com"]));
    expect(g.capabilities.find((c) => c.capability === "gcp.service_usage.ai_services")?.status).toBe("read");

    // token exchanges are guarded one hop at a time: Google STS allowed, IAM Credentials (impersonation) not
    const imp = willingSpy();
    const impScanner = new GcpCloudScanner(
      { projectIds: ["p"] },
      {
        fetch: guarded(allow("sts.googleapis.com"), imp.spy),
        credential: { mode: "gcp_workload_identity", audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/a/providers/b", serviceAccountEmail: "scanner@p.iam.gserviceaccount.com" },
        oidcToken: async () => synthetic("oidc"),
      },
    );
    const i = await impScanner.scan(ctx());
    expect(new Set(imp.calls)).toEqual(new Set(["sts.googleapis.com"]));
    expect(i.capabilities.filter((c) => c.status === "read")).toEqual([]);

    const az = willingSpy();
    const z = await scanners(guarded(allow("login.microsoftonline.com", "management.azure.com"), az.spy)).azureStatic.scan(ctx());
    expect(new Set(az.calls)).toEqual(new Set(["login.microsoftonline.com", "management.azure.com"]));
    expect(z.capabilities.find((c) => c.capability === "azure.resource_graph.cognitive_accounts")?.status).toBe("read");
  });
});
