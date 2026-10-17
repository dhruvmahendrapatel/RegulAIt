/**
 * ADR-0195 decision 16, GCP adapter. Lists only AI services, read-only:
 *
 *  - Service Usage: is `aiplatform.googleapis.com` or `generativelanguage.googleapis.com` enabled in the project
 *    (cheap and strong);
 *  - Cloud Asset Inventory: Vertex AI endpoints, models and index endpoints (`searchAllResources`, which also
 *    accepts an organization or folder scope);
 *  - Cloud Audit Logs: Admin Activity entries for both services (always on), and Data Access entries, where Vertex
 *    prediction calls appear. Data Access logs are off by default and need `roles/logging.privateLogViewer`; the
 *    adapter reads the project's audit configuration and says "not enabled" honestly when they are off.
 *
 * Transport (decision 8): the GAPIC clients run in REST fallback mode (`fallback: true`), where google-gax sends
 * every call through `authClient.fetch`; the auth client's transporter is a Gaxios whose `fetchImplementation` is
 * the guarded fetch, so token exchange, impersonation and API calls all go through the guard. gRPC is never used.
 *
 * Audit-log entries are read through the same auth client's `request` against the Logging REST API, not through the
 * Logging GAPIC client: its REST fallback must decode each entry's `protoPayload` (a protobuf `Any` holding a
 * `google.cloud.audit.AuditLog`) and the published Logging client bundles no AuditLog type, so decoding fails.
 * The JSON REST response needs no decoding beyond `JSON.parse`.
 */
import { AssetServiceClient } from "@google-cloud/asset";
import { ProjectsClient } from "@google-cloud/resource-manager";
import { ServiceUsageClient } from "@google-cloud/service-usage";
import { IdentityPoolClient, JWT, type AuthClient } from "google-auth-library";
import {
  GCP_READ_ONLY_SCOPE,
  GCP_STS_TOKEN_URL,
  gcpCredentialSchema,
  parseServiceAccountKey,
  type GcpCredentialInput,
  type OidcTokenSupplier,
} from "./credentials.js";
import { lookbackStart, PrincipalAggregator, ScanCollector } from "./report.js";
import { guardedGaxios, type GuardedFetch } from "./transport.js";
import { MAX_AUDIT_LOOKBACK_DAYS, type CloudScanContext, type CloudScanner, type CloudScanResult } from "./types.js";

export const GCP_AI_SERVICES = ["aiplatform.googleapis.com", "generativelanguage.googleapis.com"] as const;
export const GCP_SERVICE_KEYS = {
  "aiplatform.googleapis.com": "gcp:aiplatform.googleapis.com",
  "generativelanguage.googleapis.com": "gcp:generativelanguage.googleapis.com",
} as const;
export const GCP_VERTEX_ASSET_TYPES = [
  "aiplatform.googleapis.com/Endpoint",
  "aiplatform.googleapis.com/Model",
  "aiplatform.googleapis.com/IndexEndpoint",
] as const;

const VERTEX_RESOURCE_TYPES: Record<string, string> = {
  "aiplatform.googleapis.com/Endpoint": "vertex.endpoint",
  "aiplatform.googleapis.com/Model": "vertex.model",
  "aiplatform.googleapis.com/IndexEndpoint": "vertex.index_endpoint",
};

/**
 * google-gax reports a fetch that failed before any response (which includes an egress refusal) as UNAVAILABLE and
 * retries it with backoff for up to a minute. Two retries keep the backoff for a real transient failure (decision 9)
 * without stalling a run on a refusal that will never succeed.
 */
const CALL_OPTIONS = { maxRetries: 2 } as const;

const LOGGING_ENTRIES_URL = "https://logging.googleapis.com/v2/entries:list";

export interface GcpScanTarget {
  /** projects to scan; service usage and audit logs are per project */
  projectIds: string[];
  /** optional wider Asset Inventory scope: `organizations/N` or `folders/N` (decision 1: organisation-level scope) */
  assetScope?: string;
}

export interface GcpScannerDeps {
  fetch: GuardedFetch;
  credential: GcpCredentialInput;
  oidcToken?: OidcTokenSupplier;
}

/** build the google-auth-library client for one source, on the guarded transporter */
export function gcpAuthClient(deps: GcpScannerDeps): AuthClient {
  const cred = gcpCredentialSchema.parse(deps.credential);
  const transporter = guardedGaxios(deps.fetch);
  if (cred.mode === "gcp_service_account_key") {
    const key = parseServiceAccountKey(cred.keyJson);
    return new JWT({ email: key.clientEmail, key: key.privateKey, scopes: [GCP_READ_ONLY_SCOPE], transporter });
  }
  const supplier = deps.oidcToken;
  if (!supplier) throw new Error("cloud-discovery: gcp_workload_identity needs an OIDC token supplier");
  // GCP accepts, by default, the provider's full resource name with an https: prefix as the token audience.
  const tokenAudience = `https:${cred.audience}`;
  const client = new IdentityPoolClient({
    type: "external_account",
    audience: cred.audience,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: GCP_STS_TOKEN_URL,
    subject_token_supplier: { getSubjectToken: () => supplier(tokenAudience) },
    scopes: [GCP_READ_ONLY_SCOPE],
    ...(cred.serviceAccountEmail
      ? {
          service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(cred.serviceAccountEmail)}:generateAccessToken`,
        }
      : {}),
    transporter,
  });
  // google-auth-library 11.3.1 constructs the external account client's StsCredentials WITHOUT the transporter it
  // was given (baseexternalclient.js: `new StsCredentials({ tokenExchangeEndpoint, clientAuthentication })`), so the
  // token exchange would leave on a default Gaxios over global fetch, around the egress guard. Found by this
  // package's fake-cloud test, which saw a real STS response. Re-point it, and fail closed if the internal shape
  // ever changes so a library upgrade cannot silently reopen the bypass.
  const sts = (client as unknown as { stsCredential?: { transporter?: unknown } }).stsCredential;
  if (!sts || !("transporter" in sts)) {
    throw new Error("cloud-discovery: google-auth-library's STS client shape changed; refusing to build an unguarded token exchange");
  }
  sts.transporter = transporter;
  return client;
}

interface LogEntry {
  logName?: string;
  timestamp?: string;
  resource?: { labels?: Record<string, string> };
  protoPayload?: {
    serviceName?: string;
    methodName?: string;
    resourceName?: string;
    authenticationInfo?: { principalEmail?: string; principalSubject?: string };
  };
}

interface AuditLogConfig {
  logType?: string | null;
}
interface AuditConfig {
  service?: string | null;
  auditLogConfigs?: AuditLogConfig[] | null;
}

export class GcpCloudScanner implements CloudScanner {
  readonly provider = "gcp" as const;
  readonly #auth: AuthClient;
  readonly #serviceUsage: ServiceUsageClient;
  readonly #asset: AssetServiceClient;
  readonly #projects: ProjectsClient;

  constructor(readonly target: GcpScanTarget, deps: GcpScannerDeps) {
    this.#auth = gcpAuthClient(deps);
    // fallback: true is REST over authClient.fetch; never gRPC (decision 8)
    const opts = { fallback: true as const, authClient: this.#auth };
    this.#serviceUsage = new ServiceUsageClient(opts);
    this.#asset = new AssetServiceClient(opts);
    this.#projects = new ProjectsClient(opts);
  }

  async scan(ctx: CloudScanContext): Promise<CloudScanResult> {
    const c = new ScanCollector("gcp", ctx);
    for (const projectId of this.target.projectIds) {
      if (ctx.signal?.aborted) break;
      await this.#enabledServices(c, projectId);
      if (!this.target.assetScope) await this.#assets(c, ctx, `projects/${projectId}`);
      const dataAccess = await this.#dataAccessConfigured(c, projectId);
      await this.#auditLogs(c, ctx, projectId, "activity");
      await this.#auditLogs(c, ctx, projectId, "data_access", dataAccess);
    }
    if (this.target.assetScope) await this.#assets(c, ctx, this.target.assetScope);
    return c.finish();
  }

  async #enabledServices(c: ScanCollector, projectId: string): Promise<void> {
    const parent = `projects/${projectId}`;
    try {
      const [res] = await this.#serviceUsage.batchGetServices({ parent, names: GCP_AI_SERVICES.map((s) => `${parent}/services/${s}`) }, CALL_OPTIONS);
      const services = res.services ?? [];
      let enabled = 0;
      for (const s of services) {
        const name = s.config?.name ?? s.name?.split("/services/")[1];
        if (s.state !== "ENABLED" || !name || !(name in GCP_SERVICE_KEYS)) continue;
        enabled += 1;
        c.add({
          provider: "gcp",
          subjectKind: "cloud_resource",
          subject: `${parent}/services/${name}`,
          serviceKey: GCP_SERVICE_KEYS[name as keyof typeof GCP_SERVICE_KEYS],
          signalSource: "cloud_inventory",
          resourceType: "service_usage.enabled_service",
          location: "global",
          container: projectId,
        });
      }
      c.ok("gcp.service_usage.ai_services", projectId, enabled, `${enabled} of ${GCP_AI_SERVICES.length} AI services enabled`);
    } catch (err) {
      c.failed("gcp.service_usage.ai_services", projectId, err);
    }
  }

  async #assets(c: ScanCollector, ctx: CloudScanContext, scope: string): Promise<void> {
    try {
      const out: Array<{ name?: string | null; assetType?: string | null; location?: string | null; project?: string | null }> = [];
      let pageToken: string | undefined;
      for (let i = 0; i < ctx.maxPagesPerCall; i++) {
        const [items, , raw] = await this.#asset.searchAllResources(
          { scope, assetTypes: [...GCP_VERTEX_ASSET_TYPES], pageSize: 500, ...(pageToken ? { pageToken } : {}) },
          { ...CALL_OPTIONS, autoPaginate: false },
        );
        out.push(...items);
        pageToken = raw?.nextPageToken ?? undefined;
        if (!pageToken) break;
      }
      for (const r of out) {
        if (!r.name || !r.assetType) continue;
        c.add({
          provider: "gcp",
          subjectKind: "cloud_resource",
          subject: r.name,
          serviceKey: GCP_SERVICE_KEYS["aiplatform.googleapis.com"],
          signalSource: "cloud_inventory",
          resourceType: VERTEX_RESOURCE_TYPES[r.assetType] ?? "vertex.resource",
          location: r.location ?? null,
          // `project` is `projects/<number>`; fall back to the scope for org-level searches
          container: r.project ?? scope,
        });
      }
      c.ok("gcp.asset_inventory.vertex", scope, out.length);
    } catch (err) {
      c.failed("gcp.asset_inventory.vertex", scope, err);
    }
  }

  /** true / false when the audit configuration was readable, null when it was not */
  async #dataAccessConfigured(c: ScanCollector, projectId: string): Promise<boolean | null> {
    try {
      const [policy] = await this.#projects.getIamPolicy({ resource: `projects/${projectId}` }, CALL_OPTIONS);
      const configs = (policy.auditConfigs ?? []) as AuditConfig[];
      const on = configs.some(
        (cfg) =>
          (cfg.service === "allServices" || cfg.service === "aiplatform.googleapis.com") &&
          (cfg.auditLogConfigs ?? []).some((l) => l.logType === "DATA_READ" || l.logType === "DATA_WRITE"),
      );
      c.ok("gcp.audit_config.data_access", projectId, on ? 1 : 0, on ? "Data Access audit logs are enabled for Vertex AI" : "Data Access audit logs are not enabled for Vertex AI");
      return on;
    } catch (err) {
      c.failed("gcp.audit_config.data_access", projectId, err);
      return null;
    }
  }

  async #auditLogs(c: ScanCollector, ctx: CloudScanContext, projectId: string, kind: "activity" | "data_access", configured?: boolean | null): Promise<void> {
    const capability = `gcp.audit_logs.${kind}`;
    if (kind === "data_access" && configured === false) {
      c.report(capability, projectId, "not_enabled", "Data Access audit logs not enabled: Vertex AI prediction calls are recorded only there, so they cannot be seen");
      return;
    }
    const start = lookbackStart(ctx, MAX_AUDIT_LOOKBACK_DAYS);
    const services = GCP_AI_SERVICES.map((s) => `"${s}"`).join(" OR ");
    const filter = [
      `logName="projects/${projectId}/logs/cloudaudit.googleapis.com%2F${kind}"`,
      `protoPayload.serviceName=(${services})`,
      `timestamp>="${start.toISOString()}"`,
    ].join(" AND ");
    const agg = new PrincipalAggregator("gcp");
    let entries = 0;
    try {
      let pageToken: string | undefined;
      for (let i = 0; i < ctx.maxPagesPerCall; i++) {
        const res = await this.#auth.request<{ entries?: LogEntry[]; nextPageToken?: string }>({
          url: LOGGING_ENTRIES_URL,
          method: "POST",
          data: { resourceNames: [`projects/${projectId}`], filter, orderBy: "timestamp desc", pageSize: 1000, ...(pageToken ? { pageToken } : {}) },
        });
        for (const e of res.data.entries ?? []) {
          const p = e.protoPayload;
          const principal = p?.authenticationInfo?.principalEmail ?? p?.authenticationInfo?.principalSubject;
          const service = p?.serviceName;
          if (!principal || !service || !(service in GCP_SERVICE_KEYS)) continue;
          entries += 1;
          agg.record({
            rawIdentifier: principal,
            container: projectId,
            location: e.resource?.labels?.location ?? null,
            serviceKey: GCP_SERVICE_KEYS[service as keyof typeof GCP_SERVICE_KEYS],
            operation: p?.methodName ?? "unknown",
            at: e.timestamp ?? ctx.now.toISOString(),
          });
        }
        pageToken = res.data.nextPageToken;
        if (!pageToken) break;
      }
      const detail =
        kind === "data_access" && configured === null && entries === 0
          ? "no Data Access entries found; the audit configuration was unreadable, so Data Access logs may simply not be enabled"
          : `${agg.size} calling principal(s) since ${start.toISOString()}`;
      c.ok(capability, projectId, entries, detail);
      await agg.flush(c);
    } catch (err) {
      c.failed(capability, projectId, err);
    }
  }
}
