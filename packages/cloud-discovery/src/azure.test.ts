import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AzureCloudScanner } from "./azure.js";
import { fakeCloud, installNetworkTripwire, json, synthetic, testPseudonymise, type RecordedCall } from "./test-cloud.js";
import type { CloudScanContext } from "./types.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const CLIENT = "00000000-0000-4000-8000-000000000002";
const SUB = "00000000-0000-4000-8000-0000000000aa";
const WS = "00000000-0000-4000-8000-0000000000bb";
const NOW = new Date("2026-10-17T12:00:00Z");
const ACCOUNT_ID = `/subscriptions/${SUB}/resourceGroups/rg-ai/providers/Microsoft.CognitiveServices/accounts/acme-openai`;

const SPEECH_ID = `/subscriptions/${SUB}/resourceGroups/rg-ai/providers/Microsoft.CognitiveServices/accounts/acme-speech`;
const ctx = (): CloudScanContext => ({ now: NOW, auditLookbackDays: 30, pseudonymise: testPseudonymise, maxPagesPerCall: 5 });

function entraRoutes(c: RecordedCall): Response | undefined {
  if (c.url.hostname !== "login.microsoftonline.com") return undefined;
  if (c.url.pathname.endsWith("/discovery/instance")) {
    return json({
      tenant_discovery_endpoint: `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
      "api-version": "1.1",
      metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net"] }],
    });
  }
  if (c.url.pathname.endsWith("/.well-known/openid-configuration")) {
    return json({
      token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      end_session_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
      jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
    });
  }
  if (c.url.pathname.endsWith("/oauth2/v2.0/token")) return json({ token_type: "Bearer", expires_in: 3600, ext_expires_in: 3600, access_token: synthetic("at") });
  return undefined;
}

function armRoutes(opts: { graphDeployments: boolean }) {
  return [
    entraRoutes,
    (c: RecordedCall) => {
      if (c.url.hostname !== "management.azure.com" || !c.url.pathname.endsWith("/providers/Microsoft.ResourceGraph/resources")) return undefined;
      const q = (JSON.parse(c.body) as { query: string }).query;
      let data: unknown[] = [];
      if (q.includes("cognitiveservices/accounts'")) {
        data = [{ id: ACCOUNT_ID, name: "acme-openai", kind: "OpenAI", location: "eastus", subscriptionId: SUB, resourceGroup: "rg-ai", sku: "S0" }];
      } else if (q.includes("accounts/deployments") && opts.graphDeployments) {
        data = [{ id: `${ACCOUNT_ID}/deployments/chat`, name: "chat", location: "eastus", subscriptionId: SUB, resourceGroup: "rg-ai", sku: "Standard" }];
      } else if (q.includes("machinelearningservices/workspaces")) {
        data = [{ id: `/subscriptions/${SUB}/resourceGroups/rg-ai/providers/Microsoft.MachineLearningServices/workspaces/hub1`, name: "hub1", kind: "Hub", location: "eastus", subscriptionId: SUB, resourceGroup: "rg-ai" }];
      }
      return json({ totalRecords: data.length, count: data.length, resultTruncated: "false", data });
    },
    (c: RecordedCall) =>
      c.url.hostname === "management.azure.com" && c.url.pathname.endsWith("/accounts/acme-openai/deployments")
        ? json({ value: [{ id: `${ACCOUNT_ID}/deployments/embed`, name: "embed", sku: { name: "Standard" }, properties: {} }] })
        : undefined,
    (c: RecordedCall) => {
      if (c.url.hostname !== "management.azure.com" || !c.url.pathname.endsWith("/eventtypes/management/values")) return undefined;
      const filter = c.url.searchParams.get("$filter") ?? "";
      if (!filter.includes("Microsoft.CognitiveServices")) return json({ value: [] });
      return json({
        value: [
          { caller: "dev@acme.example", resourceId: `${ACCOUNT_ID}/deployments/chat`, operationName: { value: "Microsoft.CognitiveServices/accounts/deployments/write" }, eventTimestamp: "2026-10-11T09:00:00Z" },
          { caller: "dev@acme.example", resourceId: ACCOUNT_ID, operationName: { value: "Microsoft.CognitiveServices/accounts/listKeys/action" }, eventTimestamp: "2026-10-12T09:00:00Z" },
          // a Speech account: Cognitive Services, but not a discovered AI service (finding 4)
          { caller: "speech@acme.example", resourceId: SPEECH_ID, operationName: { value: "Microsoft.CognitiveServices/accounts/write" }, eventTimestamp: "2026-10-12T10:00:00Z" },
        ],
      });
    },
    (c: RecordedCall) =>
      c.url.hostname === "api.loganalytics.io"
        ? json({
            tables: [
              {
                name: "PrimaryResult",
                columns: [
                  { name: "ResourceId", type: "string" },
                  { name: "OperationName", type: "string" },
                  { name: "calls", type: "long" },
                  { name: "firstSeen", type: "datetime" },
                  { name: "lastSeen", type: "datetime" },
                ],
                rows: [
                  [ACCOUNT_ID.toUpperCase(), "ChatCompletions_Create", 1234, "2026-10-01T00:00:00Z", "2026-10-16T00:00:00Z"],
                  [SPEECH_ID, "Transcribe", 99, "2026-10-01T00:00:00Z", "2026-10-16T00:00:00Z"],
                ],
              },
            ],
          })
        : undefined,
  ];
}

describe("AzureCloudScanner through the real Azure SDKs and a fake cloud", () => {
  let wire: Awaited<ReturnType<typeof installNetworkTripwire>>;
  beforeAll(async () => {
    wire = await installNetworkTripwire();
  });
  afterEach(() => {
    const escaped = wire.escaped.splice(0);
    expect(escaped).toEqual([]);
  });
  afterAll(() => wire.restore());

  it("federated: Entra token via the RegulAIt assertion, OpenAI accounts, ARM deployments fallback, workspaces, activity log, diagnostics", async () => {
    const cloud = fakeCloud(armRoutes({ graphDeployments: false }));
    const audiences: string[] = [];
    const scanner = new AzureCloudScanner(
      { subscriptionIds: [SUB], logAnalyticsWorkspaceIds: [WS] },
      { fetch: cloud.fetch, credential: { mode: "azure_federated", tenantId: TENANT, clientId: CLIENT }, oidcToken: async (a) => (audiences.push(a), synthetic("oidc")) },
    );
    const res = await scanner.scan(ctx());
    expect(cloud.unrouted.map((c) => `${c.method} ${c.url.href}`)).toEqual([]);
    expect(audiences[0]).toBe("api://AzureADTokenExchange");
    const token = cloud.calls.find((c) => c.url.pathname.endsWith("/oauth2/v2.0/token"));
    const form = new URLSearchParams(token!.body);
    expect(form.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    expect(form.get("client_assertion")?.startsWith("oidc-")).toBe(true);

    const kinds = res.observations.map((o) => [o.subjectKind, o.serviceKey, o.resourceType, o.signalSource]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ["cloud_resource", "azure:cognitive-services:OpenAI", "cognitive_services.account", "cloud_inventory"],
        ["cloud_resource", "azure:cognitive-services:OpenAI", "cognitive_services.deployment", "cloud_inventory"],
        ["cloud_resource", "azure:ai-foundry", "machine_learning.workspace", "cloud_inventory"],
        ["cloud_principal", "azure:cognitive-services:OpenAI", "principal", "cloud_audit_log"],
        ["cloud_resource", "azure:cognitive-services:OpenAI", "cognitive_services.diagnostics", "cloud_audit_log"],
      ]),
    );
    expect(res.capabilities.find((x) => x.capability === "azure.arm.deployments")?.status).toBe("read");
    const principal = res.observations.find((o) => o.subjectKind === "cloud_principal")!;
    expect(principal.callCount).toBe(2);
    expect(JSON.stringify(res.observations)).not.toContain("acme.example");
    const diag = res.observations.filter((o) => o.resourceType === "cognitive_services.diagnostics");
    expect(diag.map((o) => o.callCount)).toEqual([1234]);
    // nothing about the Speech account is reported as an AI service
    expect(JSON.stringify(res.observations)).not.toContain("acme-speech");
    expect(res.observations.filter((o) => o.subjectKind === "cloud_principal")).toHaveLength(1);
    expect(res.capabilities.find((x) => x.capability === "azure.activity_log.Microsoft.CognitiveServices")?.detail).toContain("1 event(s) on resources that are not a discovered AI service");
  });

  it("uses Resource Graph deployments when present and skips diagnostics without a workspace", async () => {
    const cloud = fakeCloud(armRoutes({ graphDeployments: true }));
    const scanner = new AzureCloudScanner(
      { subscriptionIds: [SUB] },
      { fetch: cloud.fetch, credential: { mode: "azure_client_secret", tenantId: TENANT, clientId: CLIENT, clientSecret: synthetic("cs") } },
    );
    const res = await scanner.scan(ctx());
    expect(cloud.unrouted.map((c) => `${c.method} ${c.url.href}`)).toEqual([]);
    expect(cloud.calls.some((c) => c.url.pathname.endsWith("/deployments"))).toBe(false);
    expect(res.capabilities.find((x) => x.capability === "azure.log_analytics.diagnostics")?.status).toBe("skipped");
    expect(cloud.calls.some((c) => c.url.hostname === "api.loganalytics.io")).toBe(false);
  });
});
