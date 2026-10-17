/**
 * ADR-0195 decision 16, Azure adapter. Lists only AI services, read-only:
 *
 *  - Azure Resource Graph: Cognitive Services accounts of kind `OpenAI` or `AIServices`, and Azure Machine Learning
 *    and AI Foundry hub and project workspaces (`Microsoft.MachineLearningServices/workspaces`, kinds Default, Hub,
 *    Project). Resource Graph takes subscriptions or a management group (decision 1: organisation-level scope);
 *  - deployments: from Resource Graph where present, otherwise the ARM list-deployments call per account;
 *  - the activity log for `Microsoft.CognitiveServices` and `Microsoft.MachineLearningServices`, grouped by caller;
 *  - diagnostic logs only when the customer routes them to a Log Analytics workspace the reader can query
 *    (`logAnalyticsWorkspaceIds`); otherwise reported as skipped.
 *
 * Every client and the credential itself are built with the guarded `HttpClient` (decision 8), so the Entra token
 * request and every ARM, Resource Graph and Log Analytics call go through the egress guard.
 */
import { CognitiveServicesManagementClient } from "@azure/arm-cognitiveservices";
import { MonitorClient } from "@azure/arm-monitor";
import { ResourceGraphClient } from "@azure/arm-resourcegraph";
import type { TokenCredential } from "@azure/core-auth";
import { ClientAssertionCredential, ClientSecretCredential } from "@azure/identity";
import { LogsQueryClient } from "@azure/monitor-query-logs";
import { AZURE_FEDERATED_AUDIENCE, azureCredentialSchema, type AzureCredentialInput, type OidcTokenSupplier } from "./credentials.js";
import { lookbackStart, PrincipalAggregator, ScanCollector, take } from "./report.js";
import { GuardedAzureHttpClient, type GuardedFetch } from "./transport.js";
import { MAX_AUDIT_LOOKBACK_DAYS, shouldStop, type CloudScanContext, type CloudScanner, type CloudScanResult } from "./types.js";

export const AZURE_SERVICE_KEYS = {
  openai: "azure:cognitive-services:OpenAI",
  aiServices: "azure:cognitive-services:AIServices",
  machineLearning: "azure:machine-learning",
  aiFoundry: "azure:ai-foundry",
} as const;

/** Resource Graph queries: fixed text, no caller input is interpolated */
const ACCOUNTS_QUERY =
  "resources | where type =~ 'microsoft.cognitiveservices/accounts' and kind in~ ('OpenAI','AIServices') " +
  "| project id, name, kind, location, subscriptionId, resourceGroup, sku = tostring(sku.name)";
const DEPLOYMENTS_QUERY =
  "resources | where type =~ 'microsoft.cognitiveservices/accounts/deployments' " +
  "| project id, name, location, subscriptionId, resourceGroup, sku = tostring(sku.name)";
const WORKSPACES_QUERY =
  "resources | where type =~ 'microsoft.machinelearningservices/workspaces' " +
  "| project id, name, kind, location, subscriptionId, resourceGroup";
/** Log Analytics: Cognitive Services diagnostic logs routed to a workspace; counts only, never content */
const DIAGNOSTICS_QUERY =
  "AzureDiagnostics | where ResourceProvider == 'MICROSOFT.COGNITIVESERVICES' " +
  "| summarize calls = count(), firstSeen = min(TimeGenerated), lastSeen = max(TimeGenerated) by ResourceId, OperationName";

const ACTIVITY_PROVIDERS = [
  { provider: "Microsoft.CognitiveServices", serviceKey: AZURE_SERVICE_KEYS.openai },
  { provider: "Microsoft.MachineLearningServices", serviceKey: AZURE_SERVICE_KEYS.machineLearning },
] as const;

export const AZURE_PUBLIC_AUTHORITY_HOST = "https://login.microsoftonline.com";

export interface AzureScanTarget {
  subscriptionIds: string[];
  /** optional management group scope for Resource Graph (organisation-level scope) */
  managementGroupId?: string;
  /** Log Analytics workspace ids (GUIDs) the reader may query for diagnostic logs */
  logAnalyticsWorkspaceIds?: string[];
  /** sovereign clouds or private endpoints: the Entra authority host (default https://login.microsoftonline.com) */
  authorityHost?: string;
}

export interface AzureScannerDeps {
  fetch: GuardedFetch;
  credential: AzureCredentialInput;
  oidcToken?: OidcTokenSupplier;
}

interface GraphRow {
  id?: string | undefined;
  name?: string | undefined;
  kind?: string | undefined;
  location?: string | undefined;
  subscriptionId?: string | undefined;
  resourceGroup?: string | undefined;
  sku?: string | undefined;
}

/** build the Entra credential for one source, on the guarded HttpClient */
export function azureCredential(deps: AzureScannerDeps, authorityHost?: string): TokenCredential {
  const cred = azureCredentialSchema.parse(deps.credential);
  // finding 1: always name the authority host, so AZURE_AUTHORITY_HOST in the process environment cannot move the
  // token request (and the client assertion or secret it carries) to another host. @azure/identity also reads
  // AZURE_REGIONAL_AUTHORITY_NAME with no option to override it; that only selects a regional Microsoft host
  // (`<region>.login.microsoft.com`), which still has to be on the egress allow list.
  const options = { httpClient: new GuardedAzureHttpClient(deps.fetch), authorityHost: authorityHost ?? AZURE_PUBLIC_AUTHORITY_HOST };
  if (cred.mode === "azure_client_secret") return new ClientSecretCredential(cred.tenantId, cred.clientId, cred.clientSecret, options);
  const supplier = deps.oidcToken;
  if (!supplier) throw new Error("cloud-discovery: azure_federated needs an OIDC token supplier");
  return new ClientAssertionCredential(cred.tenantId, cred.clientId, () => supplier(AZURE_FEDERATED_AUDIENCE), options);
}

function accountServiceKey(kind: string | undefined): string | null {
  const k = (kind ?? "").toLowerCase();
  if (k === "openai") return AZURE_SERVICE_KEYS.openai;
  if (k === "aiservices") return AZURE_SERVICE_KEYS.aiServices;
  return null;
}

function workspaceServiceKey(kind: string | undefined): string {
  const k = (kind ?? "").toLowerCase();
  return k === "hub" || k === "project" ? AZURE_SERVICE_KEYS.aiFoundry : AZURE_SERVICE_KEYS.machineLearning;
}

export class AzureCloudScanner implements CloudScanner {
  readonly provider = "azure" as const;
  readonly #credential: TokenCredential;
  readonly #httpClient: GuardedAzureHttpClient;

  constructor(readonly target: AzureScanTarget, deps: AzureScannerDeps) {
    this.#httpClient = new GuardedAzureHttpClient(deps.fetch);
    this.#credential = azureCredential(deps, target.authorityHost);
  }

  #graphScope(): { subscriptions?: string[]; managementGroups?: string[] } {
    return this.target.managementGroupId ? { managementGroups: [this.target.managementGroupId] } : { subscriptions: this.target.subscriptionIds };
  }

  async #graph(ctx: CloudScanContext, graph: ResourceGraphClient, query: string): Promise<GraphRow[]> {
    const rows: GraphRow[] = [];
    let skipToken: string | undefined;
    for (let i = 0; i < ctx.maxPagesPerCall; i++) {
      const res = await graph.resources({ ...this.#graphScope(), query, options: { top: 1000, ...(skipToken ? { skipToken } : {}) } });
      const data: unknown = res.data;
      if (Array.isArray(data)) rows.push(...(data as GraphRow[]));
      skipToken = res.skipToken ?? undefined;
      if (!skipToken) break;
    }
    return rows;
  }

  async scan(ctx: CloudScanContext): Promise<CloudScanResult> {
    const c = new ScanCollector("azure", ctx);
    const scope = this.target.managementGroupId ? `managementGroups/${this.target.managementGroupId}` : this.target.subscriptionIds.join(",");
    const graph = new ResourceGraphClient(this.#credential, { httpClient: this.#httpClient });

    const resource = (row: GraphRow, serviceKey: string, resourceType: string) => {
      if (!row.id) return;
      const attributes: Record<string, string> = {};
      if (row.kind) attributes.kind = row.kind;
      if (row.sku) attributes.sku = row.sku;
      c.add({
        provider: "azure",
        subjectKind: "cloud_resource",
        // ARM ids are case-insensitive; one case so the same resource from Resource Graph, ARM and logs merges
        subject: row.id.toLowerCase(),
        serviceKey,
        signalSource: "cloud_inventory",
        resourceType,
        location: row.location ?? null,
        container: row.subscriptionId ?? "unknown",
        ...(Object.keys(attributes).length ? { attributes } : {}),
      });
    };

    const accounts = await c.attempt("azure.resource_graph.cognitive_accounts", scope, () => this.#graph(ctx, graph, ACCOUNTS_QUERY), (rows) => {
      for (const r of rows) {
        const key = accountServiceKey(r.kind);
        if (key) resource(r, key, "cognitive_services.account");
      }
    });

    // Deployments: Resource Graph first; the ARM list call for any account Resource Graph returned none for.
    const graphDeployments = await c.attempt("azure.resource_graph.deployments", scope, () => this.#graph(ctx, graph, DEPLOYMENTS_QUERY), () => undefined);
    const accountKind = new Map((accounts ?? []).map((a) => [(a.id ?? "").toLowerCase(), a.kind] as const));
    const covered = new Set<string>();
    for (const d of graphDeployments ?? []) {
      const parent = (d.id ?? "").toLowerCase().split("/deployments/")[0]!;
      covered.add(parent);
      resource(d, accountServiceKey(accountKind.get(parent)) ?? AZURE_SERVICE_KEYS.openai, "cognitive_services.deployment");
    }
    for (const a of accounts ?? []) {
      if (!a.id || !a.subscriptionId || !a.resourceGroup || !a.name || covered.has(a.id.toLowerCase())) continue;
      const arm = new CognitiveServicesManagementClient(this.#credential, a.subscriptionId, { httpClient: this.#httpClient });
      const key = accountServiceKey(a.kind) ?? AZURE_SERVICE_KEYS.openai;
      await c.attempt("azure.arm.deployments", a.id, () => take(arm.deployments.list(a.resourceGroup!, a.name!), ctx.maxPagesPerCall * 100), (items) => {
        for (const d of items) resource({ id: d.id, name: d.name, location: a.location, subscriptionId: a.subscriptionId, ...(d.sku?.name ? { sku: d.sku.name } : {}) }, key, "cognitive_services.deployment");
      });
    }

    await c.attempt("azure.resource_graph.ml_workspaces", scope, () => this.#graph(ctx, graph, WORKSPACES_QUERY), (rows) => {
      for (const r of rows) resource(r, workspaceServiceKey(r.kind), "machine_learning.workspace");
    });

    for (const subscriptionId of this.target.subscriptionIds) {
      if (await shouldStop(ctx)) break;
      await this.#activityLog(c, ctx, subscriptionId);
    }
    await this.#diagnostics(c, ctx);
    return c.finish();
  }

  async #activityLog(c: ScanCollector, ctx: CloudScanContext, subscriptionId: string): Promise<void> {
    // The activity log keeps 90 days.
    const start = lookbackStart(ctx, MAX_AUDIT_LOOKBACK_DAYS);
    const monitor = new MonitorClient(this.#credential, subscriptionId, { httpClient: this.#httpClient });
    for (const { provider, serviceKey } of ACTIVITY_PROVIDERS) {
      const agg = new PrincipalAggregator("azure");
      const filter = `eventTimestamp ge '${start.toISOString()}' and eventTimestamp le '${ctx.now.toISOString()}' and resourceProvider eq '${provider}'`;
      await c.attempt(`azure.activity_log.${provider}`, subscriptionId, () => take(monitor.activityLogs.list(filter), ctx.maxPagesPerCall * 200), (events) => {
        for (const e of events) {
          if (!e.caller) continue;
          agg.record({
            rawIdentifier: e.caller,
            container: subscriptionId,
            location: null,
            serviceKey,
            operation: e.operationName?.value ?? "unknown",
            at: e.eventTimestamp ? e.eventTimestamp.toISOString() : ctx.now.toISOString(),
          });
        }
      }, () => `${agg.size} caller(s) since ${start.toISOString()}`);
      await agg.flush(c);
    }
  }

  async #diagnostics(c: ScanCollector, ctx: CloudScanContext): Promise<void> {
    const workspaces = this.target.logAnalyticsWorkspaceIds ?? [];
    if (!workspaces.length) {
      c.report("azure.log_analytics.diagnostics", null, "skipped", "no Log Analytics workspace configured: diagnostic logs are read only from a workspace the reader can query");
      return;
    }
    const logs = new LogsQueryClient(this.#credential, { httpClient: this.#httpClient });
    const days = Math.max(1, Math.min(ctx.auditLookbackDays, MAX_AUDIT_LOOKBACK_DAYS));
    for (const ws of workspaces) {
      try {
        const res = await logs.queryWorkspace(ws, DIAGNOSTICS_QUERY, { duration: `P${days}D` });
        if (res.status !== "Success") {
          const message = "partialError" in res ? String(res.partialError?.message ?? "") : "";
          c.report("azure.log_analytics.diagnostics", ws, "error", `partial result: ${message.slice(0, 200)}`);
          continue;
        }
        const table = res.tables[0];
        const cols = table?.columnDescriptors.map((d) => d.name ?? "") ?? [];
        const idx = (n: string) => cols.indexOf(n);
        let rows = 0;
        for (const row of table?.rows ?? []) {
          const resourceId = row[idx("ResourceId")];
          if (typeof resourceId !== "string") continue;
          rows += 1;
          const op = row[idx("OperationName")];
          const first = row[idx("firstSeen")];
          const last = row[idx("lastSeen")];
          c.add({
            provider: "azure",
            subjectKind: "cloud_resource",
            subject: resourceId.toLowerCase(),
            serviceKey: AZURE_SERVICE_KEYS.openai,
            signalSource: "cloud_audit_log",
            resourceType: "cognitive_services.diagnostics",
            location: null,
            container: resourceId.split("/")[2] ?? "unknown",
            callCount: Number(row[idx("calls")] ?? 0),
            ...(typeof op === "string" ? { operations: [op] } : {}),
            ...(first instanceof Date ? { firstSeen: first.toISOString() } : {}),
            ...(last instanceof Date ? { lastSeen: last.toISOString() } : {}),
          });
        }
        c.ok("azure.log_analytics.diagnostics", ws, rows);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // a workspace without the table has no Cognitive Services diagnostics routed to it
        if (message.includes("AzureDiagnostics") && (message.includes("resolve") || message.includes("not found"))) {
          c.report("azure.log_analytics.diagnostics", ws, "not_enabled", "no Cognitive Services diagnostic logs are routed to this workspace");
        } else {
          c.failed("azure.log_analytics.diagnostics", ws, err);
        }
      }
    }
  }
}
