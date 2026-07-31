/**
 * @regulait/infra-provider — REAL Azure adapter (Batch C breadth; the azure
 * registry 501, now built). Mirrors src/aws.ts EXACTLY in discipline:
 *
 *  - Injectable-client discipline: the adapter NEVER touches the network. Every
 *    Azure call goes through an injected `AzureInfraLiveClient` — a fake in
 *    unit tests, a real @azure/*-backed implementation wired by the gateway
 *    (see apps/gateway/src/infra-azure-client.ts) in a genuinely live
 *    deployment.
 *  - The whole live path sits behind the same OFF-by-default
 *    REGULAIT_INFRA_LIVE flag as aws. Flag off, or flag on with nothing
 *    injected, is a STRUCTURED not-live failure (InfraProviderError, 501) —
 *    never a fabricated finding, never a silent success. No dry-run scan on
 *    purpose (ADR-0017: a dry-run scan would have to fabricate observations).
 *  - Auth is Entra ID federated / service-principal via the injected client's
 *    `openSession` (DefaultAzureCredential in the real client) — NEVER a
 *    static key persisted here; credentials never pass through this package.
 *
 * Surfaces (every mapped field is a real Azure API response field, provenance
 * annotated per field; where Azure cannot answer, the adapter says so
 * structurally):
 *  - VM posture + patch posture: Azure Update Manager assessment data via
 *    Azure Resource Graph (`resources` for VM state, `patchassessmentresources`
 *    for patch assessments + per-patch softwarepatches rows).
 *  - Certificates: Azure Key Vault certificates (expiry banded through the
 *    SHARED certSeverity 0/14/30-day math).
 *  - Backups: Recovery Services recovery points (banded through the SHARED
 *    evaluateBackupSchedule interval multipliers).
 *
 * HONEST GAPS specific to Azure (stated structurally, never papered over):
 *  - Azure patch assessments carry NO CVSS score anywhere — severitySource is
 *    therefore never "cvss" on Azure; banding uses the Windows MSRC severity
 *    string when present, else the patch classification, else an explicit
 *    "default" medium. Nothing is invented.
 *  - A Recovery Services RECOVERY POINT has no Status field (unlike AWS
 *    Backup): an existing recovery point IS a completed backup by API
 *    contract, so every returned point counts — stated in the finding detail.
 *  - Key Vault cannot renew a cert whose issuer is "Unknown" (imported /
 *    externally-issued): remediation is a structured 501, mirroring the AWS
 *    INELIGIBLE branch.
 */

import {
  InfraProviderError,
  certSeverity,
  compareDrift,
  evaluateBackupSchedule,
  severityRank,
  type InfraFindingRef,
  type InfraFindingReport,
  type InfraProvider,
  type InfraRemediationResult,
  type InfraResourceRef,
  type InfraSeverity,
} from "./index.js";

// ---------------------------------------------------------------------------
// Response shapes — structural mirrors of the exact Azure API fields the
// adapter consumes (and ONLY those). This package deliberately has no @azure/*
// dependency; the real client (gateway-side) maps the SDK/Resource Graph
// response onto these shapes 1:1. Dates may arrive as Date objects or ISO
// strings.
// ---------------------------------------------------------------------------

/** REAL: Azure Resource Graph `resources` row for
 * type =~ 'microsoft.compute/virtualmachines' (instance-view extended props). */
export interface AzureVmInfo {
  /** the ARM resource id (`id` column) */
  vmId: string;
  /** the VM `name` column */
  name: string;
  /** `location` column */
  location?: string | null;
  /** properties.extended.instanceView.powerState.code — "PowerState/running" | "PowerState/deallocated" | ... */
  powerState?: string | null;
  /** properties.provisioningState — "Succeeded" | "Failed" | ... */
  provisioningState?: string | null;
  /** properties.hardwareProfile.vmSize */
  vmSize?: string | null;
  /** properties.storageProfile.osDisk.osType — "Windows" | "Linux" */
  osType?: string | null;
  /** properties.extended.instanceView.osName */
  osName?: string | null;
  /** properties.extended.instanceView.osVersion */
  osVersion?: string | null;
}

/** REAL: Resource Graph `patchassessmentresources` row of type
 * microsoft.compute/virtualmachines/patchassessmentresults (one per VM —
 * the Azure Update Manager latest assessment). Counts come from
 * properties.availablePatchCountByClassification (critical / security /
 * other buckets). */
export interface AzurePatchAssessment {
  /** the parent VM name (parsed from the assessment resource id by the client) */
  vmName: string;
  /** the parent VM ARM id */
  vmId?: string | null;
  /** properties.status — "Succeeded" | "Failed" | "InProgress" | ... */
  status?: string | null;
  /** properties.rebootPending */
  rebootPending?: boolean | null;
  /** properties.availablePatchCountByClassification.critical */
  criticalPatchCount?: number | null;
  /** properties.availablePatchCountByClassification.security */
  securityPatchCount?: number | null;
  /** properties.availablePatchCountByClassification.other (all remaining buckets summed by the client) */
  otherPatchCount?: number | null;
  /** properties.lastModifiedDateTime */
  lastModifiedDateTime?: string | Date | null;
}

/** REAL: Resource Graph `patchassessmentresources` row of type
 * .../patchassessmentresults/softwarepatches (one per available patch). */
export interface AzureSoftwarePatch {
  /** properties.patchName */
  patchName?: string | null;
  /** properties.version (Linux package version) */
  version?: string | null;
  /** properties.kbId (Windows only) */
  kbId?: string | null;
  /** properties.classifications — e.g. ["Critical"], ["Security"], ["Other"] */
  classifications?: string[] | null;
  /** properties.msrcSeverity (WINDOWS ONLY — "Critical" | "Important" |
   * "Moderate" | "Low"). Linux assessment rows carry none. */
  msrcSeverity?: string | null;
  /** properties.cveNumbers (Windows MSRC data, when Azure surfaces them —
   * Linux assessments generally carry none). HONEST GAP: Azure patch
   * assessment NEVER carries a CVSS score for either OS; the adapter bands
   * from msrcSeverity/classification and says so in detail.severitySource. */
  cveNumbers?: string[] | null;
  /** properties.publishedDate */
  publishedDate?: string | Date | null;
  /** properties.rebootBehavior — "NeverReboots" | "CanRequestReboot" | ... */
  rebootBehavior?: string | null;
}

/** REAL: Key Vault CertificateProperties (listPropertiesOfCertificates item). */
export interface AzureKeyVaultCertSummary {
  /** CertificateProperties.name */
  name: string;
  /** CertificateProperties.id (the full https://{vault}/certificates/{name} id) */
  id?: string | null;
  /** CertificateProperties.enabled */
  enabled?: boolean | null;
  /** CertificateProperties.expiresOn */
  expiresOn?: string | Date | null;
}

/** REAL: Key Vault getCertificate → KeyVaultCertificateWithPolicy. */
export interface AzureKeyVaultCertDetail {
  /** name */
  name: string;
  /** properties.id */
  id?: string | null;
  /** properties.enabled */
  enabled?: boolean | null;
  /** properties.expiresOn — absent while the cert is still being issued */
  expiresOn?: string | Date | null;
  /** policy.subject — the X.509 subject (CN=...) */
  subject?: string | null;
  /** policy.issuerName — "Self" | "Unknown" (imported/manual) | an integrated
   * CA name (e.g. "DigiCert"). "Unknown" certs CANNOT be renewed by Key Vault. */
  issuerName?: string | null;
  /** properties.x509Thumbprint rendered hex by the client */
  thumbprint?: string | null;
}

/** REAL: Recovery Services recoveryPoints.list → RecoveryPointResource.
 * HONEST GAP: no Status field exists on an Azure recovery point — an existing
 * point IS a completed backup by API contract (contrast AWS COMPLETED/PARTIAL). */
export interface AzureRecoveryPoint {
  /** RecoveryPointResource.name (the recovery point id) */
  recoveryPointId: string;
  /** properties.recoveryPointTime (IaasVMRecoveryPoint) */
  recoveryPointTime?: string | Date | null;
  /** properties.recoveryPointType — "AppConsistent" | "CrashConsistent" | ... */
  recoveryPointType?: string | null;
}

export interface AzureSession {
  /** an opaque marker for the credential session the client is holding
   * (DefaultAzureCredential in the real client). Credentials themselves NEVER
   * pass through this package — same rule as the AWS assumed session. */
  sessionId: string;
}

/**
 * The injected live-Azure client (injectable-client discipline, exactly like
 * AwsInfraLiveClient). ALWAYS supplied by the caller — a fake in unit tests, a
 * real @azure/*-backed impl in a live deployment. There is no default network
 * client, so "flag on with nothing injected" is a clear structured error.
 *
 * FACTORY CONTRACT — what the gateway wires (it owns the @azure/* deps; this
 * package deliberately has none). See apps/gateway/src/infra-azure-client.ts:
 *
 *   openSession           → new DefaultAzureCredential() (@azure/identity —
 *                           Entra ID federated/workload identity, NEVER a
 *                           static key); hold it internally keyed by an opaque
 *                           sessionId.
 *   listVirtualMachines   → ResourceGraphClient.resources({ query, subscriptions })
 *                           (@azure/arm-resourcegraph), $skipToken-paginated,
 *                           over `resources | where type =~ 'microsoft.compute/virtualmachines'`.
 *   listPatchAssessments  → same, over `patchassessmentresources | where type =~
 *                           'microsoft.compute/virtualmachines/patchassessmentresults'`.
 *   listMissingPatches    → same, over `.../patchassessmentresults/softwarepatches`
 *                           rows under the given VM id.
 *   listKeyVaultCertificates → new CertificateClient(vaultUrl, credential)
 *                           (@azure/keyvault-certificates).listPropertiesOfCertificates().
 *   getKeyVaultCertificate → CertificateClient.getCertificate(name) (+ policy).
 *   listRecoveryPoints    → RecoveryServicesBackupClient.recoveryPoints.list(
 *                           vault, rg, "Azure", container, protectedItem)
 *                           (@azure/arm-recoveryservicesbackup).
 *   installPatches        → ComputeManagementClient.virtualMachines
 *                           .beginInstallPatches(rg, vm, {maximumDuration,
 *                           rebootSetting, windows/linuxParameters}) (@azure/arm-compute)
 *                           → { installationActivityId }.
 *   renewKeyVaultCertificate → CertificateClient.getCertificatePolicy(name) then
 *                           beginCreateCertificate(name, policy) — re-issuing on
 *                           the existing policy IS Key Vault's renewal for
 *                           Self/integrated-CA certs.
 *   triggerBackup         → RecoveryServicesBackupClient.backups.trigger(...)
 *                           → { jobId } (the async-operation/job id from the
 *                           202 response headers — required; "accepted with no
 *                           id" must throw, never a silent success).
 */
export interface AzureInfraLiveClient {
  /** REAL: DefaultAzureCredential (Entra ID federated) — never a static key. */
  openSession(params: { subscriptionId: string }): Promise<AzureSession>;
  /** REAL: Resource Graph query over microsoft.compute/virtualmachines */
  listVirtualMachines(params: {
    sessionId: string;
    subscriptionId: string;
    resourceGroup?: string;
  }): Promise<AzureVmInfo[]>;
  /** REAL: Resource Graph patchassessmentresources (assessment per VM) */
  listPatchAssessments(params: {
    sessionId: string;
    subscriptionId: string;
    resourceGroup?: string;
  }): Promise<AzurePatchAssessment[]>;
  /** REAL: Resource Graph softwarepatches rows for one VM's assessment */
  listMissingPatches(params: {
    sessionId: string;
    subscriptionId: string;
    vmId: string;
  }): Promise<AzureSoftwarePatch[]>;
  /** REAL: Key Vault listPropertiesOfCertificates */
  listKeyVaultCertificates(params: {
    sessionId: string;
    vaultUrl: string;
  }): Promise<AzureKeyVaultCertSummary[]>;
  /** REAL: Key Vault getCertificate (+ getCertificatePolicy for issuer/subject) */
  getKeyVaultCertificate(params: {
    sessionId: string;
    vaultUrl: string;
    name: string;
  }): Promise<AzureKeyVaultCertDetail>;
  /** REAL: Recovery Services recoveryPoints.list */
  listRecoveryPoints(params: {
    sessionId: string;
    subscriptionId: string;
    resourceGroup: string;
    vaultName: string;
    containerName: string;
    protectedItemName: string;
  }): Promise<AzureRecoveryPoint[]>;
  /** REAL: compute virtualMachines.beginInstallPatches (Critical+Security) */
  installPatches(params: {
    sessionId: string;
    subscriptionId: string;
    resourceGroup: string;
    vmName: string;
    osType?: string | null;
  }): Promise<{ installationActivityId: string }>;
  /** REAL: Key Vault re-issue on the existing policy (renewal). Only valid for
   * Self/integrated-CA issuers — the ADAPTER refuses "Unknown" before calling. */
  renewKeyVaultCertificate(params: {
    sessionId: string;
    vaultUrl: string;
    name: string;
  }): Promise<void>;
  /** REAL: Recovery Services backups.trigger (on-demand backup) */
  triggerBackup(params: {
    sessionId: string;
    subscriptionId: string;
    resourceGroup: string;
    vaultName: string;
    containerName: string;
    protectedItemName: string;
  }): Promise<{ jobId: string }>;
}

// ---------------------------------------------------------------------------
// Severity mapping — the SHARED ADR-0017 math (certSeverity /
// evaluateBackupSchedule / compareDrift) plus a documented, source-tagged
// policy over real Azure fields. `severitySource` always says which was used.
// ---------------------------------------------------------------------------

/** Windows MSRC severity string (softwarepatches properties.msrcSeverity) →
 * our ladder. Returns null for values it does not recognize. */
export function msrcSeverityToBand(msrc: string | null | undefined): InfraSeverity | null {
  switch ((msrc ?? "").trim().toLowerCase()) {
    case "critical":
      return "critical";
    case "important":
    case "high":
      return "high";
    case "moderate":
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return null;
  }
}

/** Patch classification list → our ladder ("Critical" → critical, "Security"
 * → high — an unpatched security update is at least high). Null when no
 * recognized classification is present. */
export function classificationToBand(
  classifications: string[] | null | undefined,
): InfraSeverity | null {
  const set = new Set((classifications ?? []).map((c) => c.trim().toLowerCase()));
  if (set.has("critical")) return "critical";
  if (set.has("security")) return "high";
  if (set.size > 0) return "low"; // known, non-security classification
  return null;
}

export type AzurePatchSeveritySource = "msrc" | "classification" | "default";

/** Band a single available patch. Preference order, each from a real field:
 * 1. Windows msrcSeverity → msrcSeverityToBand;
 * 2. classifications → classificationToBand;
 * 3. neither known → "medium", explicitly severitySource:"default" (the same
 *    documented conservative policy as the AWS adapter — never silent).
 * HONEST GAP: Azure patch assessment carries no CVSS anywhere, so unlike AWS
 * there is deliberately NO "cvss" source here. */
export function azurePatchSeverityBand(patch: AzureSoftwarePatch): {
  severity: InfraSeverity;
  severitySource: AzurePatchSeveritySource;
} {
  const msrc = msrcSeverityToBand(patch.msrcSeverity);
  if (msrc !== null) return { severity: msrc, severitySource: "msrc" };
  const cls = classificationToBand(patch.classifications);
  if (cls !== null) return { severity: cls, severitySource: "classification" };
  return { severity: "medium", severitySource: "default" };
}

/** The VM keys the adapter can actually OBSERVE via the Resource Graph VM row,
 * with the real source field of each. Any declared-baseline key outside this
 * set is reported in `unassessableKeys` — never counted as drift. */
const OBSERVABLE_VM_KEYS: Record<string, (v: AzureVmInfo) => unknown> = {
  power_state: (v) => v.powerState ?? null,
  provisioning_state: (v) => v.provisioningState ?? null,
  vm_size: (v) => v.vmSize ?? null,
  os_type: (v) => v.osType ?? null,
  os_name: (v) => v.osName ?? null,
  os_version: (v) => v.osVersion ?? null,
  location: (v) => v.location ?? null,
};

/** Default declared baseline when the resource config carries none: a managed
 * VM should be running and successfully provisioned. Overridable via
 * resource.config.baseline. */
export const DEFAULT_AZURE_VM_BASELINE: Record<string, unknown> = {
  power_state: "PowerState/running",
  provisioning_state: "Succeeded",
};

function toDate(v: string | Date | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strField(detail: Record<string, unknown>, key: string): string | null {
  const v = detail[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface AzureInfraProviderOptions {
  /** the customer subscription every call is scoped to (BYOC boundary) */
  subscriptionId: string;
  /** optional resource-group scoping for VM/patch queries */
  resourceGroup?: string | null;
  /** injectable-client discipline: a fake in tests, a real @azure/*-backed
   * impl (see the AzureInfraLiveClient factory contract) in a live deployment.
   * Absent = every operation is a structured not-live error. */
  client?: AzureInfraLiveClient;
  /** captured at construction so a test can flip it per-instance; defaults to
   * the REGULAIT_INFRA_LIVE env flag (shared with the aws adapter). */
  live?: boolean;
  /** injectable clock for deterministic severity-band tests */
  now?: () => Date;
}

export class AzureInfraProvider implements InfraProvider {
  readonly kind = "azure" as const;
  private readonly subscriptionId: string;
  private readonly resourceGroup: string | null;
  private readonly client: AzureInfraLiveClient | undefined;
  private readonly live: boolean;
  private readonly now: () => Date;

  constructor(opts: AzureInfraProviderOptions) {
    this.subscriptionId = opts.subscriptionId;
    this.resourceGroup = opts.resourceGroup ?? null;
    this.client = opts.client;
    this.live = opts.live ?? infraLiveEnabledLocal();
    this.now = opts.now ?? (() => new Date());
  }

  /** The honesty gate — identical semantics to the aws adapter's requireLive. */
  private requireLive(op: string): AzureInfraLiveClient {
    if (!this.subscriptionId) {
      throw new InfraProviderError(
        `azure infra ${op} needs a subscriptionId on the monitored resource`,
      );
    }
    if (!this.live) {
      throw new InfraProviderError(
        `azure infra ${op} did not run: REGULAIT_INFRA_LIVE is off and this adapter has no dry-run — ` +
          `a fabricated scan result would be fake data (ADR-0017). Enable the flag AND inject a live client to go live.`,
        501,
      );
    }
    if (!this.client) {
      throw new InfraProviderError(
        `azure infra ${op} did not run: REGULAIT_INFRA_LIVE is on but no live Azure infra client was injected — ` +
          `wire an AzureInfraLiveClient (see the factory contract in @regulait/infra-provider azure.ts); never a silent stub`,
        501,
      );
    }
    return this.client;
  }

  /** Wrap every client call so an Azure failure (throttling, auth, network)
   * surfaces as a typed InfraProviderError naming the operation, carrying the
   * SDK's real RestError.statusCode when present. */
  private async call<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof InfraProviderError) throw err;
      const e = err as { name?: string; message?: string; statusCode?: number; code?: string };
      const label =
        typeof e?.code === "string" && e.code.length > 0
          ? `${e.code}: `
          : typeof e?.name === "string" && e.name.length > 0 && e.name !== "Error"
            ? `${e.name}: `
            : "";
      throw new InfraProviderError(
        `azure ${op} failed — ${label}${e?.message ?? String(err)}`,
        typeof e?.statusCode === "number" ? e.statusCode : undefined,
      );
    }
  }

  /** REAL: open the Entra ID credential session (DefaultAzureCredential in the
   * real client) — never a static key through this package. */
  private async open(client: AzureInfraLiveClient): Promise<AzureSession> {
    return this.call("identity:openSession", () =>
      client.openSession({ subscriptionId: this.subscriptionId }),
    );
  }

  async scan(resource: InfraResourceRef): Promise<InfraFindingReport[]> {
    const client = this.requireLive("scan");
    const { sessionId } = await this.open(client);
    switch (resource.kind) {
      case "control_plane":
      case "agent_runtime":
        return this.scanVms(client, sessionId, resource);
      case "cert":
        return this.scanCerts(client, sessionId, resource);
      case "backup_target":
        return this.scanBackups(client, sessionId, resource);
    }
  }

  /** Resource Graph VMs (drift vs the declared baseline) + Update Manager
   * patch assessments (patch/CVE posture). */
  private async scanVms(
    client: AzureInfraLiveClient,
    sessionId: string,
    resource: InfraResourceRef,
  ): Promise<InfraFindingReport[]> {
    const cfg = resource.config ?? {};
    const scope = {
      sessionId,
      subscriptionId: this.subscriptionId,
      ...(this.resourceGroup ? { resourceGroup: this.resourceGroup } : {}),
    };
    const vms = await this.call("resourcegraph:virtualMachines", () =>
      client.listVirtualMachines(scope),
    );
    if (vms.length === 0) {
      // HONEST GAP: zero VMs is NOT a clean fleet — Resource Graph cannot see
      // the resource at all, so drift/patch posture is unanswerable. An empty
      // findings list would be a fake "all clear" (same rule as aws).
      throw new InfraProviderError(
        `azure scan of '${resource.name}': Resource Graph returned no virtual machines in subscription ` +
          `${this.subscriptionId}${this.resourceGroup ? ` (resource group ${this.resourceGroup})` : ""} — ` +
          `drift/patch posture cannot be assessed (nothing observed is not the same as clean); ` +
          `check the subscription/resource-group scoping and the Reader role assignment`,
      );
    }

    const declared = isRecord(cfg.baseline) ? cfg.baseline : DEFAULT_AZURE_VM_BASELINE;
    const declaredObservable: Record<string, unknown> = {};
    const unassessableKeys: string[] = [];
    for (const key of Object.keys(declared)) {
      if (key in OBSERVABLE_VM_KEYS) declaredObservable[key] = declared[key];
      else unassessableKeys.push(key);
    }
    unassessableKeys.sort();

    const findings: InfraFindingReport[] = [];

    // ---- drift, per VM, every observed value a real Resource Graph field ---
    for (const vm of [...vms].sort((a, b) => a.name.localeCompare(b.name))) {
      const observed: Record<string, unknown> = {};
      for (const key of Object.keys(declaredObservable)) {
        observed[key] = OBSERVABLE_VM_KEYS[key]!(vm);
      }
      const drift = compareDrift(declaredObservable, observed);
      if (drift.drifted.length === 0 && unassessableKeys.length === 0) continue;
      const signature = `drift:${vm.name}`;
      findings.push({
        kind: "drift",
        // unassessable-only stays "low": a visibility gap, not a deviation.
        severity: drift.drifted.length > 0 ? drift.severity : "low",
        signature,
        detail: {
          signature,
          vmName: vm.name,
          vmId: vm.vmId,
          drifted: drift.drifted,
          declared: declaredObservable,
          observed,
          unassessableKeys,
          summary:
            drift.drifted.length > 0
              ? `VM ${vm.name} drifted from the declared baseline on: ${drift.drifted.join(", ")}`
              : `declared baseline key(s) ${unassessableKeys.join(", ")} cannot be assessed via the Resource Graph VM row`,
        },
      });
    }

    // ---- patch posture -----------------------------------------------------
    const assessments = await this.call("resourcegraph:patchAssessments", () =>
      client.listPatchAssessments(scope),
    );
    const vmByName = new Map(vms.map((v) => [v.name, v]));
    const assessedVmNames = new Set(assessments.map((a) => a.vmName));
    // HONEST GAP: a VM with NO Update Manager assessment at all has an
    // UNKNOWN patch posture — that is a finding (visibility gap), not a pass.
    for (const vm of vms) {
      if (assessedVmNames.has(vm.name)) continue;
      const signature = `cve:unassessed:${vm.name}`;
      findings.push({
        kind: "cve",
        severity: "medium",
        signature,
        detail: {
          signature,
          vmName: vm.name,
          vmId: vm.vmId,
          severitySource: "default",
          summary:
            `VM ${vm.name} has no Azure Update Manager patch assessment — patch posture is UNKNOWN ` +
            `(not assessed is not the same as compliant); enable periodic assessment on the VM`,
        },
      });
    }

    // aggregate identical patches across the fleet into ONE finding keyed by
    // the patch's natural id (first CVE number, else KB id, else patch name) —
    // the same natural-key shape the aws adapter and patch ledger use.
    const byPatch = new Map<
      string,
      {
        patch: AzureSoftwarePatch;
        severity: InfraSeverity;
        severitySource: AzurePatchSeveritySource;
        vmNames: string[];
        osTypes: Array<string | null>;
      }
    >();
    for (const assessment of assessments) {
      const pending =
        num(assessment.criticalPatchCount) +
        num(assessment.securityPatchCount) +
        num(assessment.otherPatchCount);
      if (pending === 0) continue;
      const vm = vmByName.get(assessment.vmName);
      const vmId = assessment.vmId ?? vm?.vmId ?? null;
      const patches = vmId
        ? await this.call("resourcegraph:softwarePatches", () =>
            client.listMissingPatches({ sessionId, subscriptionId: this.subscriptionId, vmId }),
          )
        : [];
      if (patches.length === 0) {
        // HONEST GAP: the assessment says patches are pending but per-patch
        // rows are unavailable (ARG ingestion lag / permissions). Band from
        // the assessment's classification COUNTERS — all real fields — and say
        // so via severitySource.
        const severity: InfraSeverity =
          num(assessment.criticalPatchCount) > 0
            ? "critical"
            : num(assessment.securityPatchCount) > 0
              ? "high"
              : "medium";
        const signature = `cve:patch-assessment:${assessment.vmName}`;
        findings.push({
          kind: "cve",
          severity,
          signature,
          detail: {
            signature,
            vmName: assessment.vmName,
            vmId,
            criticalPatchCount: num(assessment.criticalPatchCount),
            securityPatchCount: num(assessment.securityPatchCount),
            otherPatchCount: num(assessment.otherPatchCount),
            severitySource: "assessment-counters",
            summary:
              `VM ${assessment.vmName} has ${pending} pending patch(es) per its Update Manager assessment ` +
              `but no per-patch softwarepatches rows were returned — severity banded from the ` +
              `availablePatchCountByClassification counters`,
          },
        });
        continue;
      }
      for (const patch of patches) {
        const key = patch.cveNumbers?.[0] ?? patch.kbId ?? patch.patchName ?? "unidentified-patch";
        const band = azurePatchSeverityBand(patch);
        const existing = byPatch.get(key);
        if (!existing) {
          byPatch.set(key, {
            patch,
            ...band,
            vmNames: [assessment.vmName],
            osTypes: [vm?.osType ?? null],
          });
        } else {
          if (!existing.vmNames.includes(assessment.vmName)) {
            existing.vmNames.push(assessment.vmName);
            existing.osTypes.push(vm?.osType ?? null);
          }
          if (severityRank(band.severity) > severityRank(existing.severity)) {
            existing.severity = band.severity;
            existing.severitySource = band.severitySource;
            existing.patch = patch;
          }
        }
      }
    }
    const resourceGroup =
      typeof cfg.resourceGroup === "string" ? cfg.resourceGroup : (this.resourceGroup ?? null);
    for (const [key, agg] of [...byPatch.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const signature = `cve:${key}`;
      findings.push({
        kind: "cve",
        severity: agg.severity,
        signature,
        detail: {
          signature,
          cve: key,
          cveNumbers: agg.patch.cveNumbers ?? [],
          patchName: agg.patch.patchName ?? null,
          kbId: agg.patch.kbId ?? null,
          version: agg.patch.version ?? null,
          classifications: agg.patch.classifications ?? [],
          msrcSeverity: agg.patch.msrcSeverity ?? null,
          // HONEST GAP stated in-band: Azure patch assessment has no CVSS.
          cvssBaseScore: null,
          severitySource: agg.severitySource,
          rebootBehavior: agg.patch.rebootBehavior ?? null,
          vmNames: [...agg.vmNames].sort(),
          // operator config carried forward so a governed remediation can
          // installPatches without re-reading the resource (needs the rg).
          resourceGroup,
          summary: `patch ${key} is pending on ${agg.vmNames.length} VM(s)`,
        },
      });
    }
    return findings;
  }

  /** Key Vault certificates → cert_expiring findings via the SHARED
   * certSeverity date math (0/14/30-day bands). */
  private async scanCerts(
    client: AzureInfraLiveClient,
    sessionId: string,
    resource: InfraResourceRef,
  ): Promise<InfraFindingReport[]> {
    const cfg = resource.config ?? {};
    const vaultUrl = typeof cfg.vaultUrl === "string" ? cfg.vaultUrl : null;
    if (!vaultUrl) {
      throw new InfraProviderError(
        `azure cert scan of '${resource.name}' needs config.vaultUrl (the Key Vault URL, ` +
          `e.g. https://my-vault.vault.azure.net) on the monitored resource`,
      );
    }
    const rotationWindowDays = Number(cfg.rotationWindowDays ?? 30);
    const now = this.now();
    const summaries = await this.call("keyvault:listCertificates", () =>
      client.listKeyVaultCertificates({ sessionId, vaultUrl }),
    );
    const findings: InfraFindingReport[] = [];
    for (const summary of summaries) {
      const cert = await this.call("keyvault:getCertificate", () =>
        client.getKeyVaultCertificate({ sessionId, vaultUrl, name: summary.name }),
      );
      const expiresOn = toDate(cert.expiresOn);
      // HONEST GAP: a cert with no expiresOn (still being issued / creation
      // failed) has no expiry to band — skipped, never assigned an invented
      // date/severity (same rule as the aws PENDING_VALIDATION branch).
      if (!expiresOn) continue;
      const { severity, daysUntilExpiry, shouldRotate } = certSeverity(
        expiresOn,
        now,
        rotationWindowDays,
      );
      if (!shouldRotate && severity === "low") continue; // healthy — no finding
      const commonName = cert.subject ?? cert.name;
      const signature = `cert_expiring:${commonName}`;
      findings.push({
        kind: "cert_expiring",
        severity,
        signature,
        detail: {
          signature,
          daysUntilExpiry,
          commonName,
          certName: cert.name,
          issuer: cert.issuerName ?? null,
          serial: cert.thumbprint ?? null,
          notAfter: expiresOn.toISOString(),
          enabled: cert.enabled ?? null,
          // carried so remediate() can decide whether a Key Vault re-issue is
          // even possible (issuer "Unknown" = imported/manual — it is not)
          vaultUrl,
          summary:
            daysUntilExpiry <= 0
              ? "certificate has ALREADY EXPIRED — service-affecting"
              : `certificate expires in ${daysUntilExpiry} day(s)`,
        },
      });
    }
    return findings;
  }

  /** Recovery Services recovery points → backup_missed findings via the SHARED
   * evaluateBackupSchedule interval multipliers. */
  private async scanBackups(
    client: AzureInfraLiveClient,
    sessionId: string,
    resource: InfraResourceRef,
  ): Promise<InfraFindingReport[]> {
    const cfg = resource.config ?? {};
    const vaultName = typeof cfg.vaultName === "string" ? cfg.vaultName : resource.name;
    const resourceGroup =
      typeof cfg.resourceGroup === "string" ? cfg.resourceGroup : (this.resourceGroup ?? null);
    const containerName = typeof cfg.containerName === "string" ? cfg.containerName : null;
    const protectedItemName =
      typeof cfg.protectedItemName === "string" ? cfg.protectedItemName : null;
    const missing = [
      !resourceGroup && "resourceGroup",
      !containerName && "containerName",
      !protectedItemName && "protectedItemName",
    ].filter((v): v is string => typeof v === "string");
    if (missing.length > 0) {
      // Recovery Services recovery points are per protected item — without the
      // item there is nothing real to observe. Saying which config is missing
      // beats inventing an unanchored result.
      throw new InfraProviderError(
        `azure backup scan of '${resource.name}' needs ${missing.join(", ")} in the resource config ` +
          `(Recovery Services recovery points are listed per vault/container/protected item)`,
      );
    }
    const schedule = String(cfg.backupSchedule ?? "daily");
    const retentionDays = Number(cfg.retentionDays ?? 30);
    const now = this.now();
    const points = await this.call("recoveryservices:listRecoveryPoints", () =>
      client.listRecoveryPoints({
        sessionId,
        subscriptionId: this.subscriptionId,
        resourceGroup: resourceGroup!,
        vaultName,
        containerName: containerName!,
        protectedItemName: protectedItemName!,
      }),
    );
    // HONEST GAP: Azure recovery points carry NO status — an existing point IS
    // a completed backup by API contract, so every point with a real
    // recoveryPointTime counts (stated in the detail, contrast AWS COMPLETED).
    let lastBackupAt: Date | null = null;
    let lastRecoveryPointId: string | null = null;
    let datedCount = 0;
    for (const p of points) {
      const t = toDate(p.recoveryPointTime);
      if (!t) continue;
      datedCount += 1;
      if (!lastBackupAt || t.getTime() > lastBackupAt.getTime()) {
        lastBackupAt = t;
        lastRecoveryPointId = p.recoveryPointId;
      }
    }
    const { due, missed, severity, retentionUntil } = evaluateBackupSchedule(
      schedule,
      lastBackupAt,
      now,
      retentionDays,
    );
    if (!due) return []; // backups are on schedule — no finding
    const signature = `backup_missed:${resource.name}`;
    return [
      {
        kind: "backup_missed",
        severity,
        signature,
        detail: {
          signature,
          vaultName,
          resourceGroup,
          containerName,
          protectedItemName,
          schedule,
          due,
          missed,
          lastBackupAt: lastBackupAt ? lastBackupAt.toISOString() : null,
          lastRecoveryPointId,
          recoveryPointCount: points.length,
          datedCount,
          statusNote:
            "azure recovery points carry no status field — an existing point is a completed backup by API contract",
          retentionUntil: retentionUntil.toISOString(),
          summary: lastBackupAt
            ? `no recovery point since ${lastBackupAt.toISOString()} (schedule: ${schedule})`
            : `no recovery point exists for protected item '${protectedItemName}' in vault '${vaultName}' (schedule: ${schedule})`,
        },
      },
    ];
  }

  /** Governed remediation — reached only AFTER the gateway's approval
   * decision. One real Azure action per finding kind; anything Azure cannot do
   * is an explicit structured error, never a pretend success. */
  async remediate(finding: InfraFindingRef): Promise<InfraRemediationResult> {
    const client = this.requireLive("remediate");
    const detail = isRecord(finding.detail) ? finding.detail : {};
    const { sessionId } = await this.open(client);
    switch (finding.kind) {
      case "cve": {
        const raw = detail.vmNames;
        const vmNames = Array.isArray(raw)
          ? raw.filter((v): v is string => typeof v === "string" && v.length > 0)
          : strField(detail, "vmName")
            ? [strField(detail, "vmName")!]
            : [];
        const resourceGroup = strField(detail, "resourceGroup") ?? this.resourceGroup;
        if (vmNames.length === 0 || !resourceGroup) {
          throw new InfraProviderError(
            "azure patch remediation needs the scan finding's detail.vmNames and a resourceGroup — " +
              "refusing to run installPatches against an unknown VM set",
          );
        }
        // installPatches is a per-VM operation — one real call per VM.
        const installations: Array<{ vmName: string; installationActivityId: string }> = [];
        for (const vmName of vmNames) {
          const { installationActivityId } = await this.call(
            `compute:installPatches(${vmName})`,
            () =>
              client.installPatches({
                sessionId,
                subscriptionId: this.subscriptionId,
                resourceGroup,
                vmName,
                osType: null,
              }),
          );
          installations.push({ vmName, installationActivityId });
        }
        return {
          ok: true,
          detail: {
            remediated: true,
            kind: finding.kind,
            signature: finding.signature,
            action: "applied vendor patch",
            via: "compute virtualMachines.installPatches (Critical+Security classifications)",
            installations,
            vmNames,
            live: true,
          },
        };
      }
      case "cert_expiring": {
        const vaultUrl = strField(detail, "vaultUrl");
        const certName = strField(detail, "certName");
        if (!vaultUrl || !certName) {
          throw new InfraProviderError(
            "azure certificate rotation needs the scan finding's detail.vaultUrl and detail.certName — " +
              "refusing to guess which Key Vault certificate to renew",
          );
        }
        // HONEST GAP: Key Vault can only re-issue a cert whose issuer is Self
        // or an integrated CA. An "Unknown"-issuer (imported / externally
        // issued) cert cannot be renewed by Key Vault — surfacing that beats a
        // doomed API call (the exact parallel of AWS acm INELIGIBLE).
        if (detail.issuer === "Unknown") {
          throw new InfraProviderError(
            `Key Vault cannot renew certificate '${certName}': issuer is "Unknown" ` +
              `(imported / externally-issued) — rotate at the issuing CA and re-import into the vault`,
            501,
          );
        }
        await this.call("keyvault:renewCertificate", () =>
          client.renewKeyVaultCertificate({ sessionId, vaultUrl, name: certName }),
        );
        return {
          ok: true,
          detail: {
            remediated: true,
            kind: finding.kind,
            signature: finding.signature,
            action: "rotated certificate",
            via: "keyvault beginCreateCertificate on the existing policy (managed re-issue)",
            vaultUrl,
            certName,
            live: true,
          },
        };
      }
      case "backup_missed": {
        const vaultName = strField(detail, "vaultName");
        const resourceGroup = strField(detail, "resourceGroup");
        const containerName = strField(detail, "containerName");
        const protectedItemName = strField(detail, "protectedItemName");
        const missing = [
          !vaultName && "vaultName",
          !resourceGroup && "resourceGroup",
          !containerName && "containerName",
          !protectedItemName && "protectedItemName",
        ].filter((v): v is string => typeof v === "string");
        if (missing.length > 0) {
          throw new InfraProviderError(
            `azure out-of-band backup needs ${missing.join(", ")} in the finding detail ` +
              `(Recovery Services backups.trigger requires all four) — set them on the monitored resource's config`,
          );
        }
        const { jobId } = await this.call("recoveryservices:triggerBackup", () =>
          client.triggerBackup({
            sessionId,
            subscriptionId: this.subscriptionId,
            resourceGroup: resourceGroup!,
            vaultName: vaultName!,
            containerName: containerName!,
            protectedItemName: protectedItemName!,
          }),
        );
        return {
          ok: true,
          detail: {
            remediated: true,
            kind: finding.kind,
            signature: finding.signature,
            action: "triggered out-of-band backup",
            via: "recoveryservices backups.trigger",
            jobId,
            vaultName,
            protectedItemName,
            live: true,
          },
        };
      }
      case "drift":
        // HONEST GAP: same rule as aws — re-applying a configuration baseline
        // is the owning IaC pipeline's job (Terraform / Bicep / Azure Policy
        // remediation tasks). This adapter will not guess at mutations in a
        // customer subscription.
        throw new InfraProviderError(
          "azure drift remediation is not supported by this adapter: re-applying a configuration baseline is the " +
            "owning IaC pipeline's job (Terraform / Bicep / Azure Policy) — the adapter does not guess at mutations " +
            "in a customer subscription",
          501,
        );
    }
  }
}

/** local re-read of the shared flag (kept here to avoid an import cycle with
 * aws.ts; identical contract to aws.infraLiveEnabled). */
function infraLiveEnabledLocal(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.REGULAIT_INFRA_LIVE;
  return v === "1" || v === "true";
}
