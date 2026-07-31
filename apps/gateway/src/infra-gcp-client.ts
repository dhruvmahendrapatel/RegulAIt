/**
 * The REAL @google-cloud/* implementation of @regulait/infra-provider's
 * GcpInfraLiveClient factory contract (see packages/infra-provider/src/
 * gcp.ts). The gateway owns the @google-cloud/* deps (@google-cloud/os-config,
 * @google-cloud/certificate-manager, @google-cloud/backupdr); the
 * infra-provider package deliberately has none, so this file is where each of
 * the 7 interface methods becomes its annotated SDK call.
 *
 * Discipline (mirrors infra-aws-client.ts / infra-azure-client.ts exactly):
 *  - LAZY: the SDK modules are loaded via dynamic import on the FIRST actual
 *    client call, never at module load or factory construction — the gateway
 *    boots (and every flag-off code path runs) without touching
 *    @google-cloud/* code.
 *  - Credential handling: the Google clients authenticate via Application
 *    Default Credentials / workload identity federation at construction —
 *    NEVER a static service-account key read here. openSession constructs the
 *    service clients once and holds them keyed by an opaque sessionId;
 *    credentials never leave this module.
 *  - Injectable SDK loader (`loadSdk`) so unit tests drive fully fake modules
 *    and prove lazy-loading — never the network.
 *  - gax list calls run with autoPaginate (the client default), so one call
 *    returns the fully-paginated array.
 */

import type {
  GcpBackup,
  GcpCertificate,
  GcpInfraLiveClient,
  GcpInstanceInventory,
  GcpSession,
  GcpVulnerability,
} from "@regulait/infra-provider";

/** Structural view of the three SDK modules — what the real packages provide
 * and exactly what a test fake must supply. gax paginated calls resolve to
 * `[items, ...]` tuples; LRO/unary calls to `[response, ...]`. */
export interface GcpInfraSdk {
  osConfig: {
    OsConfigZonalServiceClient: new () => {
      listInventories(req: { parent: string; view: string }): Promise<[unknown[], ...unknown[]]>;
      listVulnerabilityReports(req: { parent: string }): Promise<[unknown[], ...unknown[]]>;
    };
    OsConfigServiceClient: new () => {
      executePatchJob(req: {
        parent: string;
        description: string;
        instanceFilter: { instances: string[] };
      }): Promise<[Record<string, unknown>, ...unknown[]]>;
    };
  };
  certificateManager: {
    CertificateManagerClient: new () => {
      listCertificates(req: { parent: string }): Promise<[unknown[], ...unknown[]]>;
    };
  };
  backupDr: {
    BackupDRClient: new () => {
      listBackups(req: { parent: string }): Promise<[unknown[], ...unknown[]]>;
      triggerBackup(req: {
        name: string;
        ruleId: string;
      }): Promise<[Record<string, unknown>, ...unknown[]]>;
    };
  };
}

/** REAL loader — dynamic imports so nothing under @google-cloud/* is evaluated
 * until the first live call. Cached so the Promise stays single. */
let realSdk: Promise<GcpInfraSdk> | undefined;
function loadRealSdk(): Promise<GcpInfraSdk> {
  realSdk ??= Promise.all([
    import("@google-cloud/os-config"),
    import("@google-cloud/certificate-manager"),
    import("@google-cloud/backupdr"),
  ]).then(
    ([osConfig, certificateManager, backupDr]) =>
      ({ osConfig, certificateManager, backupDr }) as unknown as GcpInfraSdk,
  );
  return realSdk;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0 && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/** protobuf Timestamp ({seconds,nanos} — seconds may be number/string/Long),
 * Date, or ISO string → Date | null. Never an invented time. */
function tsToDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string" && v.length > 0) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const t = rec(v);
  const secondsRaw = t.seconds as unknown;
  const seconds =
    typeof secondsRaw === "number"
      ? secondsRaw
      : typeof secondsRaw === "string"
        ? Number(secondsRaw)
        : typeof secondsRaw === "object" && secondsRaw !== null
          ? Number(String(secondsRaw)) // protobufjs Long stringifies to its value
          : NaN;
  if (!Number.isFinite(seconds)) return null;
  const nanos = typeof t.nanos === "number" ? t.nanos : 0;
  return new Date(seconds * 1000 + Math.floor(nanos / 1e6));
}

/** proto enums may arrive as string names or numbers; only real string names
 * are passed through — a numeric enum we cannot name maps via the given table
 * or honestly stays null. */
function enumStr(v: unknown, byNumber?: Record<number, string>): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && byNumber && byNumber[v]) return byNumber[v]!;
  return null;
}

/** Backup.State enum numbers (google.cloud.backupdr.v1.Backup.State) */
const BACKUP_STATE_BY_NUMBER: Record<number, string> = {
  1: "CREATING",
  2: "ACTIVE",
  3: "DELETING",
  4: "ERROR",
};

/** VulnerabilityReport severity enum numbers (osconfig v1 Severity is emitted
 * as strings by the Node client; the table covers the numeric fallback) */
const SEVERITY_BY_NUMBER: Record<number, string> = {
  1: "CRITICAL",
  2: "HIGH",
  3: "MEDIUM",
  4: "LOW",
  5: "MINIMAL",
};

/** parse the instance segment out of an osconfig resource name
 * (projects/{p}/locations/{zone}/instances/{instanceId}/...) */
function instanceFromName(name: string): string | null {
  const m = /\/instances\/([^/]+)/.exec(name);
  return m?.[1] ?? null;
}

/**
 * Build the real GcpInfraLiveClient the gateway injects when
 * REGULAIT_INFRA_LIVE is on and the monitored resource's provider is 'gcp'.
 * `loadSdk` is the test seam (defaults to the real lazy dynamic-import
 * loader).
 */
export function buildGcpInfraLiveClient(
  loadSdk: () => Promise<GcpInfraSdk> = loadRealSdk,
): GcpInfraLiveClient {
  // lazy: nothing is loaded until the first method call on the returned client
  let sdkPromise: Promise<GcpInfraSdk> | undefined;
  const sdk = () => (sdkPromise ??= loadSdk());

  interface SessionClients {
    zonal: InstanceType<GcpInfraSdk["osConfig"]["OsConfigZonalServiceClient"]>;
    osconfig: InstanceType<GcpInfraSdk["osConfig"]["OsConfigServiceClient"]>;
    certs: InstanceType<GcpInfraSdk["certificateManager"]["CertificateManagerClient"]>;
    backup: InstanceType<GcpInfraSdk["backupDr"]["BackupDRClient"]>;
  }
  // sessionId → the ADC-authenticated service clients (credentials never leave)
  const sessions = new Map<string, SessionClients>();
  let sessionCounter = 0;

  function clients(sessionId: string): SessionClients {
    const c = sessions.get(sessionId);
    if (!c) {
      throw new Error(
        `gcp infra live client: unknown credential session '${sessionId}' — call openSession first`,
      );
    }
    return c;
  }

  return {
    /** REAL: construct the ADC/workload-identity-authenticated clients once;
     * only the opaque session marker crosses back. */
    async openSession(params): Promise<GcpSession> {
      const s = await sdk();
      const sessionId = `gcp-${params.projectId}-${++sessionCounter}`;
      sessions.set(sessionId, {
        zonal: new s.osConfig.OsConfigZonalServiceClient(),
        osconfig: new s.osConfig.OsConfigServiceClient(),
        certs: new s.certificateManager.CertificateManagerClient(),
        backup: new s.backupDr.BackupDRClient(),
      });
      return { sessionId };
    },

    /** REAL: osconfig listInventories (view FULL) over the zone's instances;
     * instanceId parsed from Inventory.name, osInfo mapped 1:1. */
    async listInventories(params): Promise<GcpInstanceInventory[]> {
      const { zonal } = clients(params.sessionId);
      const [items] = await zonal.listInventories({
        parent: `projects/${params.projectId}/locations/${params.zone}/instances/-`,
        view: "FULL",
      });
      const out: GcpInstanceInventory[] = [];
      for (const item of arr(items)) {
        const name = str(item.name);
        const instanceId = name ? instanceFromName(name) : null;
        if (!instanceId) continue;
        const os = rec(item.osInfo);
        out.push({
          instanceId,
          hostname: str(os.hostname),
          osLongName: str(os.longName),
          osShortName: str(os.shortName),
          osVersion: str(os.version),
          kernelVersion: str(os.kernelVersion),
          architecture: str(os.architecture),
          osconfigAgentVersion: str(os.osconfigAgentVersion),
          updateTime: tsToDate(item.updateTime),
        });
      }
      return out;
    },

    /** REAL: osconfig listVulnerabilityReports, flattened to one row per
     * (instance, vulnerability). details.cvssV3.baseScore is the REAL CVSS
     * the adapter's shared 9/7/4 ladder runs on; fixAvailable is derived from
     * the availableInventoryItemIds / items[].availableInventoryItemId fields
     * being non-empty. */
    async listVulnerabilities(params): Promise<GcpVulnerability[]> {
      const { zonal } = clients(params.sessionId);
      const [reports] = await zonal.listVulnerabilityReports({
        parent: `projects/${params.projectId}/locations/${params.zone}/instances/-`,
      });
      const out: GcpVulnerability[] = [];
      for (const report of arr(reports)) {
        const name = str(report.name);
        const instanceId = name ? instanceFromName(name) : null;
        if (!instanceId) continue;
        for (const vuln of arr(report.vulnerabilities)) {
          const details = rec(vuln.details);
          const fixIds = strArr(vuln.availableInventoryItemIds);
          const itemFixes = arr(vuln.items).some(
            (i) => str(i.availableInventoryItemId) !== null,
          );
          out.push({
            instanceId,
            cve: str(details.cve),
            cvssBaseScore: numOrNull(rec(details.cvssV3).baseScore),
            severity: enumStr(details.severity, SEVERITY_BY_NUMBER),
            description: str(details.description),
            fixAvailable: fixIds.length > 0 || itemFixes,
            updateTime: tsToDate(vuln.updateTime),
          });
        }
      }
      return out;
    },

    /** REAL: certificatemanager listCertificates for the location; the
     * managed/selfManaged oneof becomes managementType so the adapter can
     * explain its structural renewal 501 precisely. */
    async listCertificates(params): Promise<GcpCertificate[]> {
      const { certs } = clients(params.sessionId);
      const [items] = await certs.listCertificates({
        parent: `projects/${params.projectId}/locations/${params.location}`,
      });
      const out: GcpCertificate[] = [];
      for (const item of arr(items)) {
        const name = str(item.name);
        if (!name) continue;
        const managed = item.managed != null ? rec(item.managed) : null;
        const selfManaged = item.selfManaged != null;
        out.push({
          name,
          expireTime: tsToDate(item.expireTime),
          sanDnsnames: strArr(item.sanDnsnames),
          managementType: managed ? "managed" : selfManaged ? "self_managed" : null,
          managedState: managed ? enumStr(managed.state, { 1: "PROVISIONING", 2: "FAILED", 3: "ACTIVE" }) : null,
        });
      }
      return out;
    },

    /** REAL: backupdr listBackups for the vault's data source; only real
     * Backup.state/consistencyTime fields cross back. */
    async listBackups(params): Promise<GcpBackup[]> {
      const { backup } = clients(params.sessionId);
      const [items] = await backup.listBackups({
        parent:
          `projects/${params.projectId}/locations/${params.location}` +
          `/backupVaults/${params.backupVault}/dataSources/${params.dataSource}`,
      });
      const out: GcpBackup[] = [];
      for (const item of arr(items)) {
        const name = str(item.name);
        if (!name) continue;
        out.push({
          name,
          state: enumStr(item.state, BACKUP_STATE_BY_NUMBER),
          consistencyTime: tsToDate(item.consistencyTime),
          enforcedRetentionEndTime: tsToDate(item.enforcedRetentionEndTime),
        });
      }
      return out;
    },

    /** REAL: osconfig executePatchJob against an EXPLICIT instance filter —
     * bare ids/names are expanded to the `zones/{zone}/instances/{id}` form
     * PatchInstanceFilter.instances requires (needs the zone); a full path is
     * passed through untouched. */
    async executePatchJob(params): Promise<{ patchJobName: string }> {
      const { osconfig } = clients(params.sessionId);
      const instances = params.instances.map((i) => {
        if (i.includes("/")) return i; // already a full instance path
        if (!params.zone) {
          throw new Error(
            `gcp executePatchJob: instance '${i}' is a bare id and no zone was provided — ` +
              `cannot build the zones/{zone}/instances/{id} URI PatchInstanceFilter requires`,
          );
        }
        return `zones/${params.zone}/instances/${i}`;
      });
      const [job] = await osconfig.executePatchJob({
        parent: `projects/${params.projectId}`,
        description: "RegulAIt governed patch remediation",
        instanceFilter: { instances },
      });
      const patchJobName = str(rec(job).name);
      if (!patchJobName) {
        throw new Error("gcp executePatchJob returned no PatchJob.name — patch run not confirmed");
      }
      return { patchJobName };
    },

    /** REAL: backupdr backupPlanAssociations.triggerBackup — the LRO operation
     * name is required back; "accepted with no operation" throws, never a
     * silent success. */
    async triggerBackup(params): Promise<{ operationName: string }> {
      const { backup } = clients(params.sessionId);
      const [operation] = await backup.triggerBackup({
        name:
          `projects/${params.projectId}/locations/${params.location}` +
          `/backupPlanAssociations/${params.backupPlanAssociation}`,
        ruleId: params.ruleId,
      });
      const operationName = str(rec(operation).name);
      if (!operationName) {
        throw new Error(
          "gcp triggerBackup returned no operation name — backup not confirmed",
        );
      }
      return { operationName };
    },
  };
}
