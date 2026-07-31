/**
 * The REAL @azure/* implementation of @regulait/infra-provider's
 * AzureInfraLiveClient factory contract (see packages/infra-provider/src/
 * azure.ts). The gateway owns the @azure/* deps (@azure/identity,
 * @azure/arm-resourcegraph, @azure/keyvault-certificates,
 * @azure/arm-recoveryservicesbackup, @azure/arm-compute); the infra-provider
 * package deliberately has none, so this file is where each of the 10
 * interface methods becomes its annotated SDK call.
 *
 * Discipline (mirrors infra-aws-client.ts exactly):
 *  - LAZY: the SDK modules are loaded via dynamic import on the FIRST actual
 *    client call, never at module load or factory construction — the gateway
 *    boots (and every flag-off code path runs) without touching @azure/* code.
 *  - Credential handling: openSession builds ONE DefaultAzureCredential
 *    (Entra ID federated/workload identity — NEVER a static key read here)
 *    held INSIDE this client keyed by an opaque sessionId; every per-call
 *    service client is constructed against it. Credentials never leave this
 *    module.
 *  - Injectable SDK loader (`loadSdk`) so unit tests drive fully fake modules
 *    and prove lazy-loading — never the network, matching the repo's
 *    injectable-client convention.
 */

import type {
  AzureInfraLiveClient,
  AzureKeyVaultCertDetail,
  AzureKeyVaultCertSummary,
  AzurePatchAssessment,
  AzureRecoveryPoint,
  AzureSession,
  AzureSoftwarePatch,
  AzureVmInfo,
} from "@regulait/infra-provider";

/** the raw-response surface we read the backup-trigger job id from */
interface AzureRawResponseLike {
  headers: { get(name: string): string | null | undefined };
}

/** Structural view of the five SDK modules — what the real packages provide
 * and exactly what a test fake must supply. Kept structural (not the SDKs' own
 * types) so fakes stay tiny and the modules load lazily. */
export interface AzureInfraSdk {
  identity: { DefaultAzureCredential: new () => unknown };
  resourceGraph: {
    ResourceGraphClient: new (credential: unknown) => {
      /** REAL: POST providers/Microsoft.ResourceGraph/resources */
      resources(query: {
        subscriptions: string[];
        query: string;
        options?: { skipToken?: string };
      }): Promise<{ data?: unknown; skipToken?: string | null }>;
    };
  };
  keyvaultCertificates: {
    CertificateClient: new (
      vaultUrl: string,
      credential: unknown,
    ) => {
      listPropertiesOfCertificates(): AsyncIterable<Record<string, unknown>>;
      getCertificate(name: string): Promise<Record<string, unknown>>;
      getCertificatePolicy(name: string): Promise<Record<string, unknown>>;
      beginCreateCertificate(name: string, policy: Record<string, unknown>): Promise<unknown>;
    };
  };
  recoveryServicesBackup: {
    RecoveryServicesBackupClient: new (
      credential: unknown,
      subscriptionId: string,
    ) => {
      recoveryPoints: {
        list(
          vaultName: string,
          resourceGroupName: string,
          fabricName: string,
          containerName: string,
          protectedItemName: string,
        ): AsyncIterable<Record<string, unknown>>;
      };
      backups: {
        trigger(
          vaultName: string,
          resourceGroupName: string,
          fabricName: string,
          containerName: string,
          protectedItemName: string,
          parameters: Record<string, unknown>,
          options?: { onResponse?: (raw: AzureRawResponseLike) => void },
        ): Promise<unknown>;
      };
    };
  };
  compute: {
    ComputeManagementClient: new (
      credential: unknown,
      subscriptionId: string,
    ) => {
      virtualMachines: {
        get(resourceGroupName: string, vmName: string): Promise<Record<string, unknown>>;
        beginInstallPatches(
          resourceGroupName: string,
          vmName: string,
          installPatchesInput: Record<string, unknown>,
        ): Promise<{ pollUntilDone(): Promise<Record<string, unknown>> }>;
      };
    };
  };
}

/** REAL loader — dynamic imports so nothing under @azure/* is evaluated until
 * the first live call. Cached so the Promise stays single. */
let realSdk: Promise<AzureInfraSdk> | undefined;
function loadRealSdk(): Promise<AzureInfraSdk> {
  realSdk ??= Promise.all([
    import("@azure/identity"),
    import("@azure/arm-resourcegraph"),
    import("@azure/keyvault-certificates"),
    import("@azure/arm-recoveryservicesbackup"),
    import("@azure/arm-compute"),
  ]).then(
    ([identity, resourceGraph, keyvaultCertificates, recoveryServicesBackup, compute]) =>
      ({
        identity,
        resourceGraph,
        keyvaultCertificates,
        recoveryServicesBackup,
        compute,
      }) as unknown as AzureInfraSdk,
  );
  return realSdk;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0 && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function dateOrNull(v: unknown): string | Date | null {
  if (v instanceof Date) return v;
  return typeof v === "string" && v.length > 0 ? v : null;
}
function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}
function strArr(v: unknown): string[] | null {
  if (typeof v === "string" && v.length > 0) return [v];
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length > 0 ? out : null;
}

/** KQL string literal — single quotes doubled per KQL escaping rules */
function kqlLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** parse .../virtualMachines/{name}[/...] out of an ARM id (case-insensitive) */
function vmNameFromId(id: string): string | null {
  const m = /\/virtualmachines\/([^/]+)/i.exec(id);
  return m?.[1] ?? null;
}

/** the ARM id of the parent VM for a patchassessmentresults(+children) id */
function vmIdFromAssessmentId(id: string): string | null {
  const idx = id.toLowerCase().indexOf("/patchassessmentresults");
  return idx > 0 ? id.slice(0, idx) : null;
}

/** hex-render a Key Vault x509Thumbprint (Uint8Array) */
function thumbprintHex(v: unknown): string | null {
  if (v instanceof Uint8Array && v.length > 0) {
    return Array.from(v)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }
  return str(v);
}

/** Azure Backup's fixed fabric name for IaaS/Azure workloads */
const AZURE_FABRIC = "Azure";

/**
 * Build the real AzureInfraLiveClient the gateway injects when
 * REGULAIT_INFRA_LIVE is on and the monitored resource's provider is 'azure'.
 * `loadSdk` is the test seam (defaults to the real lazy dynamic-import
 * loader).
 */
export function buildAzureInfraLiveClient(
  loadSdk: () => Promise<AzureInfraSdk> = loadRealSdk,
): AzureInfraLiveClient {
  // lazy: nothing is loaded until the first method call on the returned client
  let sdkPromise: Promise<AzureInfraSdk> | undefined;
  const sdk = () => (sdkPromise ??= loadSdk());

  // sessionId → the held DefaultAzureCredential (never exposed, never a key)
  const sessions = new Map<string, unknown>();
  let sessionCounter = 0;

  function credential(sessionId: string): unknown {
    if (!sessions.has(sessionId)) {
      throw new Error(
        `azure infra live client: unknown credential session '${sessionId}' — call openSession first`,
      );
    }
    return sessions.get(sessionId);
  }

  /** drive a Resource Graph query through every skipToken page */
  async function queryAll(
    sessionId: string,
    subscriptionId: string,
    query: string,
  ): Promise<Record<string, unknown>[]> {
    const s = await sdk();
    const client = new s.resourceGraph.ResourceGraphClient(credential(sessionId));
    const rows: Record<string, unknown>[] = [];
    let skipToken: string | undefined;
    do {
      const resp = await client.resources({
        subscriptions: [subscriptionId],
        query,
        ...(skipToken ? { options: { skipToken } } : {}),
      });
      rows.push(...arr(resp.data));
      skipToken = str(resp.skipToken) ?? undefined;
    } while (skipToken);
    return rows;
  }

  return {
    /** REAL: new DefaultAzureCredential() — Entra ID federated/workload
     * identity; only the opaque session marker crosses back. */
    async openSession(params): Promise<AzureSession> {
      const s = await sdk();
      const cred = new s.identity.DefaultAzureCredential();
      const sessionId = `az-${params.subscriptionId}-${++sessionCounter}`;
      sessions.set(sessionId, cred);
      return { sessionId };
    },

    /** REAL: Resource Graph over microsoft.compute/virtualmachines (instance
     * view extended props), skipToken-paginated. Every mapped field is the
     * projected ARG column. */
    async listVirtualMachines(params): Promise<AzureVmInfo[]> {
      const scope = params.resourceGroup
        ? `| where resourceGroup =~ ${kqlLiteral(params.resourceGroup)} `
        : "";
      const rows = await queryAll(
        params.sessionId,
        params.subscriptionId,
        `Resources | where type =~ 'microsoft.compute/virtualmachines' ${scope}` +
          `| project id, name, location, ` +
          `powerState = properties.extended.instanceView.powerState.code, ` +
          `provisioningState = properties.provisioningState, ` +
          `vmSize = properties.hardwareProfile.vmSize, ` +
          `osType = properties.storageProfile.osDisk.osType, ` +
          `osName = properties.extended.instanceView.osName, ` +
          `osVersion = properties.extended.instanceView.osVersion`,
      );
      return rows
        .filter((r) => str(r.id) !== null && str(r.name) !== null)
        .map((r) => ({
          vmId: str(r.id)!,
          name: str(r.name)!,
          location: str(r.location),
          powerState: str(r.powerState),
          provisioningState: str(r.provisioningState),
          vmSize: str(r.vmSize),
          osType: str(r.osType),
          osName: str(r.osName),
          osVersion: str(r.osVersion),
        }));
    },

    /** REAL: Resource Graph patchassessmentresources (Azure Update Manager's
     * latest assessment per VM). Windows rows expose the merged
     * criticalAndSecurityPatchCount — when the per-classification split is
     * unavailable it is mapped into the security bucket (documented, never
     * both). */
    async listPatchAssessments(params): Promise<AzurePatchAssessment[]> {
      const scope = params.resourceGroup
        ? `| where resourceGroup =~ ${kqlLiteral(params.resourceGroup)} `
        : "";
      const rows = await queryAll(
        params.sessionId,
        params.subscriptionId,
        `patchassessmentresources | where type =~ 'microsoft.compute/virtualmachines/patchassessmentresults' ${scope}` +
          `| project id, properties`,
      );
      const out: AzurePatchAssessment[] = [];
      for (const row of rows) {
        const id = str(row.id);
        if (!id) continue;
        const vmName = vmNameFromId(id);
        if (!vmName) continue;
        const p = rec(row.properties);
        const counts = rec(p.availablePatchCountByClassification);
        out.push({
          vmName,
          vmId: vmIdFromAssessmentId(id),
          status: str(p.status),
          rebootPending: bool(p.rebootPending),
          criticalPatchCount: numOrNull(counts.critical),
          securityPatchCount:
            numOrNull(counts.security) ?? numOrNull(p.criticalAndSecurityPatchCount),
          otherPatchCount: numOrNull(counts.other) ?? numOrNull(p.otherPatchCount),
          lastModifiedDateTime: dateOrNull(p.lastModifiedDateTime),
        });
      }
      return out;
    },

    /** REAL: Resource Graph softwarepatches child rows of one VM's latest
     * assessment. classifications may arrive as a string or array — both are
     * normalized; cveNumbers likewise. */
    async listMissingPatches(params): Promise<AzureSoftwarePatch[]> {
      const rows = await queryAll(
        params.sessionId,
        params.subscriptionId,
        `patchassessmentresources | where type =~ 'microsoft.compute/virtualmachines/patchassessmentresults/softwarepatches' ` +
          `| where tolower(id) startswith tolower(${kqlLiteral(params.vmId)}) ` +
          `| project id, properties`,
      );
      return rows.map((row) => {
        const p = rec(row.properties);
        return {
          patchName: str(p.patchName),
          version: str(p.version),
          kbId: str(p.kbId),
          classifications: strArr(p.classifications),
          msrcSeverity: str(p.msrcSeverity),
          cveNumbers: strArr(p.cveNumbers),
          publishedDate: dateOrNull(p.publishedDate),
          rebootBehavior: str(p.rebootBehavior),
        };
      });
    },

    /** REAL: Key Vault listPropertiesOfCertificates (paged async iterator) */
    async listKeyVaultCertificates(params): Promise<AzureKeyVaultCertSummary[]> {
      const s = await sdk();
      const client = new s.keyvaultCertificates.CertificateClient(
        params.vaultUrl,
        credential(params.sessionId),
      );
      const out: AzureKeyVaultCertSummary[] = [];
      for await (const props of client.listPropertiesOfCertificates()) {
        const name = str(props.name);
        if (!name) continue;
        out.push({
          name,
          id: str(props.id),
          enabled: bool(props.enabled),
          expiresOn: dateOrNull(props.expiresOn),
        });
      }
      return out;
    },

    /** REAL: Key Vault getCertificate (KeyVaultCertificateWithPolicy —
     * properties + policy in one call) */
    async getKeyVaultCertificate(params): Promise<AzureKeyVaultCertDetail> {
      const s = await sdk();
      const client = new s.keyvaultCertificates.CertificateClient(
        params.vaultUrl,
        credential(params.sessionId),
      );
      const cert = rec(await client.getCertificate(params.name));
      const props = rec(cert.properties);
      const policy = rec(cert.policy);
      return {
        name: str(cert.name) ?? params.name,
        id: str(props.id),
        enabled: bool(props.enabled),
        expiresOn: dateOrNull(props.expiresOn),
        subject: str(policy.subject),
        issuerName: str(policy.issuerName),
        thumbprint: thumbprintHex(props.x509Thumbprint),
      };
    },

    /** REAL: Recovery Services recoveryPoints.list (fabric 'Azure'), paged
     * async iterator. HONEST GAP carried through: recovery points have no
     * Status field — nothing is invented here. */
    async listRecoveryPoints(params): Promise<AzureRecoveryPoint[]> {
      const s = await sdk();
      const client = new s.recoveryServicesBackup.RecoveryServicesBackupClient(
        credential(params.sessionId),
        params.subscriptionId,
      );
      const out: AzureRecoveryPoint[] = [];
      for await (const point of client.recoveryPoints.list(
        params.vaultName,
        params.resourceGroup,
        AZURE_FABRIC,
        params.containerName,
        params.protectedItemName,
      )) {
        const p = rec(point);
        const name = str(p.name);
        if (!name) continue;
        const props = rec(p.properties);
        out.push({
          recoveryPointId: name,
          recoveryPointTime: dateOrNull(props.recoveryPointTime),
          recoveryPointType: str(props.recoveryPointType),
        });
      }
      return out;
    },

    /** REAL: compute virtualMachines.beginInstallPatches restricted to
     * Critical+Security classifications, IfRequired reboot. The right
     * windows/linuxParameters oneof is chosen from the given osType — looked
     * up via virtualMachines.get (a real call) when the caller has none.
     * Blocks until the LRO completes and requires the result's
     * installationActivityId — never an unconfirmed success. */
    async installPatches(params): Promise<{ installationActivityId: string }> {
      const s = await sdk();
      const client = new s.compute.ComputeManagementClient(
        credential(params.sessionId),
        params.subscriptionId,
      );
      let osType = str(params.osType);
      if (!osType) {
        const vm = rec(await client.virtualMachines.get(params.resourceGroup, params.vmName));
        osType = str(rec(rec(rec(vm.storageProfile).osDisk)).osType);
      }
      if (osType !== "Windows" && osType !== "Linux") {
        throw new Error(
          `azure installPatches: cannot determine the OS of VM '${params.vmName}' (osType '${osType ?? "unknown"}') — ` +
            `the InstallPatches API requires the matching windows/linuxParameters oneof; refusing to guess`,
        );
      }
      const classifications = { classificationsToInclude: ["Critical", "Security"] };
      const poller = await client.virtualMachines.beginInstallPatches(
        params.resourceGroup,
        params.vmName,
        {
          maximumDuration: "PT2H",
          rebootSetting: "IfRequired",
          ...(osType === "Windows"
            ? { windowsParameters: classifications }
            : { linuxParameters: classifications }),
        },
      );
      const result = rec(await poller.pollUntilDone());
      const installationActivityId = str(result.installationActivityId);
      if (!installationActivityId) {
        throw new Error(
          "azure installPatches returned no installationActivityId — patch run not confirmed",
        );
      }
      return { installationActivityId };
    },

    /** REAL: Key Vault renewal = re-issue on the EXISTING policy
     * (getCertificatePolicy → beginCreateCertificate). Submitting the create
     * IS the renewal trigger for Self/integrated-CA certs; issuance runs
     * asynchronously in the vault. The adapter refuses issuer 'Unknown'
     * before ever calling this. */
    async renewKeyVaultCertificate(params): Promise<void> {
      const s = await sdk();
      const client = new s.keyvaultCertificates.CertificateClient(
        params.vaultUrl,
        credential(params.sessionId),
      );
      const policy = rec(await client.getCertificatePolicy(params.name));
      await client.beginCreateCertificate(params.name, policy);
    },

    /** REAL: Recovery Services backups.trigger (202). The job/operation id is
     * read from the Azure-AsyncOperation/Location response header — "accepted
     * with no id" throws, never a silent success. */
    async triggerBackup(params): Promise<{ jobId: string }> {
      const s = await sdk();
      const client = new s.recoveryServicesBackup.RecoveryServicesBackupClient(
        credential(params.sessionId),
        params.subscriptionId,
      );
      let opUrl: string | null = null;
      await client.backups.trigger(
        params.vaultName,
        params.resourceGroup,
        AZURE_FABRIC,
        params.containerName,
        params.protectedItemName,
        { properties: { objectType: "IaasVMBackupRequest" } },
        {
          onResponse: (raw) => {
            opUrl =
              str(raw.headers.get("azure-asyncoperation")) ??
              str(raw.headers.get("location")) ??
              null;
          },
        },
      );
      if (!opUrl) {
        throw new Error(
          "azure backups.trigger was accepted but returned no Azure-AsyncOperation/Location header — " +
            "backup job not confirmed",
        );
      }
      // the operation id is the last path segment of the operation URL
      const path = (opUrl as string).split("?")[0]!;
      const jobId = path.split("/").filter(Boolean).pop();
      if (!jobId) {
        throw new Error("azure backups.trigger operation URL carried no operation id — backup job not confirmed");
      }
      return { jobId };
    },
  };
}
