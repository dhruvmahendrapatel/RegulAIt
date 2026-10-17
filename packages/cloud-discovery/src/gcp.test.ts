import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GcpCloudScanner } from "./gcp.js";
import { fakeCloud, installNetworkTripwire, json, synthetic, testPseudonymise, type RecordedCall } from "./test-cloud.js";
import type { CloudScanContext } from "./types.js";

const PROJECT = "acme-ml";
const AUDIENCE = "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/regulait/providers/regulait-oidc";
const NOW = new Date("2026-10-17T12:00:00Z");

const ctx = (): CloudScanContext => ({ now: NOW, auditLookbackDays: 30, pseudonymise: testPseudonymise, maxPagesPerCall: 5 });

function gcpRoutes(opts: { dataAccess: boolean; denyAssets?: boolean }) {
  return [
    (c: RecordedCall) =>
      c.url.hostname === "sts.googleapis.com"
        ? json({ access_token: synthetic("at"), issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3600 })
        : undefined,
    (c: RecordedCall) => (c.url.hostname === "oauth2.googleapis.com" ? json({ access_token: synthetic("at"), token_type: "Bearer", expires_in: 3600 }) : undefined),
    (c: RecordedCall) =>
      c.url.hostname === "serviceusage.googleapis.com" && c.url.pathname.endsWith("services:batchGet")
        ? json({
            services: [
              { name: "projects/123456/services/aiplatform.googleapis.com", config: { name: "aiplatform.googleapis.com" }, state: "ENABLED" },
              { name: "projects/123456/services/generativelanguage.googleapis.com", config: { name: "generativelanguage.googleapis.com" }, state: "DISABLED" },
            ],
          })
        : undefined,
    (c: RecordedCall) => {
      if (c.url.hostname !== "cloudasset.googleapis.com") return undefined;
      if (opts.denyAssets) return json({ error: { code: 403, message: "Permission denied", status: "PERMISSION_DENIED" } }, 403);
      return json({
        results: [
          { name: "//aiplatform.googleapis.com/projects/123456/locations/us-central1/endpoints/42", assetType: "aiplatform.googleapis.com/Endpoint", location: "us-central1", project: "projects/123456" },
          { name: "//aiplatform.googleapis.com/projects/123456/locations/us-central1/indexEndpoints/7", assetType: "aiplatform.googleapis.com/IndexEndpoint", location: "us-central1", project: "projects/123456" },
        ],
      });
    },
    (c: RecordedCall) =>
      c.url.hostname === "cloudresourcemanager.googleapis.com" && c.url.pathname.endsWith(":getIamPolicy")
        ? json(opts.dataAccess ? { auditConfigs: [{ service: "allServices", auditLogConfigs: [{ logType: "DATA_READ" }] }] } : { bindings: [] })
        : undefined,
    (c: RecordedCall) => {
      if (c.url.hostname !== "logging.googleapis.com") return undefined;
      const body = JSON.parse(c.body) as { filter: string };
      const activity = body.filter.includes("%2Factivity");
      return json({
        entries: [
          {
            logName: `projects/${PROJECT}/logs/cloudaudit.googleapis.com%2F${activity ? "activity" : "data_access"}`,
            timestamp: "2026-10-12T08:00:00Z",
            resource: { labels: { location: "us-central1" } },
            protoPayload: {
              "@type": "type.googleapis.com/google.cloud.audit.AuditLog",
              serviceName: "aiplatform.googleapis.com",
              methodName: activity ? "google.cloud.aiplatform.v1.EndpointService.DeployModel" : "google.cloud.aiplatform.v1.PredictionService.Predict",
              authenticationInfo: { principalEmail: activity ? "ops@acme.example" : "batch-job@acme-ml.iam.gserviceaccount.com" },
            },
          },
        ],
      });
    },
  ];
}

describe("GcpCloudScanner through the real Google clients (REST fallback) and a fake cloud", () => {
  let wire: Awaited<ReturnType<typeof installNetworkTripwire>>;
  beforeAll(async () => {
    wire = await installNetworkTripwire();
  });
  afterEach(() => {
    const escaped = wire.escaped.splice(0);
    expect(escaped).toEqual([]);
  });
  afterAll(() => wire.restore());

  it("federated: STS exchange, enabled services, Vertex assets and audit principals; nothing over gRPC", async () => {
    const cloud = fakeCloud(gcpRoutes({ dataAccess: true }));
    const audiences: string[] = [];
    const scanner = new GcpCloudScanner(
      { projectIds: [PROJECT] },
      { fetch: cloud.fetch, credential: { mode: "gcp_workload_identity", audience: AUDIENCE }, oidcToken: async (a) => (audiences.push(a), synthetic("oidc")) },
    );
    const res = await scanner.scan(ctx());
    expect(cloud.unrouted.map((c) => `${c.method} ${c.url.href}`)).toEqual([]);
    expect(audiences[0]).toBe(`https:${AUDIENCE}`);
    expect(cloud.calls[0]!.url.hostname).toBe("sts.googleapis.com");
    // every API call carried the exchanged token
    for (const call of cloud.calls.filter((c) => c.url.hostname !== "sts.googleapis.com")) {
      expect(call.headers.get("authorization")?.startsWith("Bearer at-")).toBe(true);
    }

    expect(res.observations.filter((o) => o.subjectKind === "cloud_resource").map((o) => [o.serviceKey, o.resourceType])).toEqual([
      ["gcp:aiplatform.googleapis.com", "vertex.endpoint"],
      ["gcp:aiplatform.googleapis.com", "vertex.index_endpoint"],
      ["gcp:aiplatform.googleapis.com", "service_usage.enabled_service"],
    ]);
    const principals = res.observations.filter((o) => o.subjectKind === "cloud_principal");
    expect(principals).toHaveLength(2);
    expect(JSON.stringify(res.observations)).not.toContain("acme.example");
    expect(res.capabilities.find((x) => x.capability === "gcp.audit_logs.data_access")?.status).toBe("read");
  });

  it("federated with impersonation: the generateAccessToken call goes through the injected fetch", async () => {
    const cloud = fakeCloud([
      (c: RecordedCall) =>
        c.url.hostname === "iamcredentials.googleapis.com" ? json({ accessToken: synthetic("at"), expireTime: new Date(Date.now() + 3_600_000).toISOString() }) : undefined,
      ...gcpRoutes({ dataAccess: true }),
    ]);
    const scanner = new GcpCloudScanner(
      { projectIds: [PROJECT] },
      { fetch: cloud.fetch, credential: { mode: "gcp_workload_identity", audience: AUDIENCE, serviceAccountEmail: "scanner@acme-ml.iam.gserviceaccount.com" }, oidcToken: async () => synthetic("oidc") },
    );
    await scanner.scan(ctx());
    expect(cloud.unrouted).toEqual([]);
    expect(cloud.calls.slice(0, 2).map((c) => c.url.hostname)).toEqual(["sts.googleapis.com", "iamcredentials.googleapis.com"]);
  });

  it("says Data Access logs are not enabled rather than reporting zero predictions", async () => {
    const cloud = fakeCloud(gcpRoutes({ dataAccess: false, denyAssets: true }));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyJson = JSON.stringify({ type: "service_account", client_email: "scanner@acme-ml.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    const scanner = new GcpCloudScanner({ projectIds: [PROJECT] }, { fetch: cloud.fetch, credential: { mode: "gcp_service_account_key", keyJson } });
    const res = await scanner.scan(ctx());
    expect(cloud.unrouted.map((c) => `${c.method} ${c.url.href}`)).toEqual([]);
    // google-gax signs a self-signed JWT for a service-account key (no token exchange); every call still carries it,
    // and the tripwire proves no token request left around the injected fetch
    for (const call of cloud.calls) expect(call.headers.get("authorization")?.startsWith("Bearer ")).toBe(true);
    const da =res.capabilities.find((x) => x.capability === "gcp.audit_logs.data_access");
    expect(da?.status).toBe("not_enabled");
    expect(da?.detail).toContain("Data Access audit logs not enabled");
    expect(cloud.calls.filter((c) => c.url.hostname === "logging.googleapis.com")).toHaveLength(1);
    expect(res.capabilities.find((x) => x.capability === "gcp.asset_inventory.vertex")?.status).toBe("denied");
  });
});
