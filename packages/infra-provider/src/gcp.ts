/**
 * @regulait/infra-provider — REAL GCP adapter (Batch C breadth; the gcp
 * registry 501, now built). Mirrors src/aws.ts EXACTLY in discipline:
 *
 *  - Injectable-client discipline: the adapter NEVER touches the network.
 *    Every GCP call goes through an injected `GcpInfraLiveClient` — a fake in
 *    unit tests, a real @google-cloud/*-backed implementation wired by the
 *    gateway (see apps/gateway/src/infra-gcp-client.ts) in a live deployment.
 *  - The whole live path sits behind the same OFF-by-default
 *    REGULAIT_INFRA_LIVE flag. Flag off, or flag on with nothing injected, is
 *    a STRUCTURED not-live failure (InfraProviderError, 501) — never a
 *    fabricated finding, never a silent success. No dry-run scan (ADR-0017).
 *  - Auth is Application Default Credentials / workload identity federation
 *    via the injected client's `openSession` — NEVER a static service-account
 *    key persisted here; credentials never pass through this package.
 *
 * Surfaces (every mapped field is a real GCP API response field, provenance
 * annotated per field):
 *  - Instance posture: OS Config inventory (osInfo) for drift vs a DECLARED
 *    baseline; OS Config vulnerability reports for CVE posture — GCP's reports
 *    DO carry real CVSS v3 base scores, so the SHARED cvssToSeverity 9/7/4
 *    ladder applies first-class here (unlike Azure).
 *  - Certificates: Certificate Manager certificates (expiry banded through the
 *    SHARED certSeverity 0/14/30-day math).
 *  - Backups: Backup and DR backups per data source (banded through the
 *    SHARED evaluateBackupSchedule interval multipliers).
 *
 * HONEST GAPS specific to GCP (stated structurally, never papered over):
 *  - OS Config inventory carries NO health/agent-currency fields comparable to
 *    SSM PingStatus/IsLatestVersion — so GCP has NO default drift baseline; a
 *    drift check only runs against a baseline the operator DECLARES
 *    (config.baseline), and undeclared = no drift findings, said out loud in
 *    the adapter contract rather than fabricating a health check.
 *  - Certificate Manager has NO "renew now" API: Google-MANAGED certs renew
 *    automatically on Google's schedule and cannot be forced; SELF_MANAGED
 *    certs must be re-issued at the CA and re-uploaded. cert_expiring
 *    remediation is therefore ALWAYS a structured 501 on GCP, explaining
 *    which of the two situations applies.
 */

import {
  InfraProviderError,
  certSeverity,
  compareDrift,
  cvssToSeverity,
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
// Response shapes — structural mirrors of the exact GCP API fields the adapter
// consumes (and ONLY those). This package deliberately has no @google-cloud/*
// dependency; the real client (gateway-side) maps the SDK response onto these
// shapes 1:1. Timestamps may arrive as Date objects or ISO strings.
// ---------------------------------------------------------------------------

/** REAL: osconfig projects.locations.instances.inventories → Inventory
 * (view FULL). instanceId is parsed from Inventory.name by the client. */
export interface GcpInstanceInventory {
  /** parsed from Inventory.name (.../instances/{instanceId}/inventory) */
  instanceId: string;
  /** Inventory.osInfo.hostname */
  hostname?: string | null;
  /** Inventory.osInfo.longName — e.g. "Debian GNU/Linux 12 (bookworm)" */
  osLongName?: string | null;
  /** Inventory.osInfo.shortName — e.g. "debian" */
  osShortName?: string | null;
  /** Inventory.osInfo.version */
  osVersion?: string | null;
  /** Inventory.osInfo.kernelVersion */
  kernelVersion?: string | null;
  /** Inventory.osInfo.architecture */
  architecture?: string | null;
  /** Inventory.osInfo.osconfigAgentVersion */
  osconfigAgentVersion?: string | null;
  /** Inventory.updateTime */
  updateTime?: string | Date | null;
}

/** REAL: osconfig projects.locations.instances.vulnerabilityReports →
 * VulnerabilityReport.vulnerabilities[] (flattened per instance by the
 * client). */
export interface GcpVulnerability {
  /** VulnerabilityReport name's instance segment (which instance this is on) */
  instanceId: string;
  /** vulnerability.details.cve — e.g. "CVE-2026-1234" */
  cve?: string | null;
  /** vulnerability.details.cvssV3.baseScore — a REAL CVSS v3 base score */
  cvssBaseScore?: number | null;
  /** vulnerability.details.severity — "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" |
   * "MINIMAL" | "SEVERITY_UNSPECIFIED" */
  severity?: string | null;
  /** vulnerability.details.description */
  description?: string | null;
  /** whether availableInventoryItemIds / items[].availableInventoryItemId is
   * non-empty — i.e. an upgradable package fixing this vuln exists */
  fixAvailable?: boolean | null;
  /** vulnerability.updateTime */
  updateTime?: string | Date | null;
}

/** REAL: certificatemanager projects.locations.certificates → Certificate. */
export interface GcpCertificate {
  /** Certificate.name — projects/{p}/locations/{l}/certificates/{id} */
  name: string;
  /** Certificate.expireTime — absent while a managed cert is provisioning */
  expireTime?: string | Date | null;
  /** Certificate.sanDnsnames */
  sanDnsnames?: string[] | null;
  /** which oneof is set: Certificate.managed vs Certificate.selfManaged */
  managementType?: "managed" | "self_managed" | null;
  /** Certificate.managed.state — "PROVISIONING" | "ACTIVE" | "FAILED" */
  managedState?: string | null;
}

/** REAL: backupdr projects.locations.backupVaults.dataSources.backups →
 * Backup. */
export interface GcpBackup {
  /** Backup.name */
  name: string;
  /** Backup.state — "CREATING" | "ACTIVE" | "DELETING" | "ERROR" */
  state?: string | null;
  /** Backup.consistencyTime — the point in time the backup is consistent to */
  consistencyTime?: string | Date | null;
  /** Backup.enforcedRetentionEndTime */
  enforcedRetentionEndTime?: string | Date | null;
}

export interface GcpSession {
  /** an opaque marker for the ADC/workload-identity credential session the
   * client is holding. Credentials themselves NEVER pass through this package. */
  sessionId: string;
}

/**
 * The injected live-GCP client (injectable-client discipline, exactly like
 * AwsInfraLiveClient). ALWAYS supplied by the caller — a fake in unit tests, a
 * real @google-cloud/*-backed impl in a live deployment. No default network
 * client, so "flag on with nothing injected" is a clear structured error.
 *
 * FACTORY CONTRACT — what the gateway wires (it owns the @google-cloud/* deps;
 * this package deliberately has none). See apps/gateway/src/infra-gcp-client.ts:
 *
 *   openSession        → Application Default Credentials / workload identity
 *                        federation (never a static SA key); hold the
 *                        authenticated clients keyed by an opaque sessionId.
 *   listInventories    → OsConfigZonalServiceClient.listInventories({parent:
 *                        `projects/{p}/locations/{zone}/instances/-`, view:"FULL"})
 *                        (@google-cloud/os-config), paginated.
 *   listVulnerabilities→ OsConfigZonalServiceClient.listVulnerabilityReports(
 *                        {parent: same}), flattened to one row per
 *                        (instance, vulnerability), paginated.
 *   listCertificates   → CertificateManagerClient.listCertificates({parent:
 *                        `projects/{p}/locations/{location}`})
 *                        (@google-cloud/certificate-manager), paginated.
 *   listBackups        → BackupDRClient.listBackups({parent: `projects/{p}/
 *                        locations/{l}/backupVaults/{v}/dataSources/{d}`})
 *                        (@google-cloud/backupdr), paginated.
 *   executePatchJob    → OsConfigServiceClient.executePatchJob({parent:
 *                        `projects/{p}`, instanceFilter:{instances:[...]}}) →
 *                        { patchJobName: PatchJob.name }.
 *   triggerBackup      → BackupDRClient.triggerBackup({name: `.../
 *                        backupPlanAssociations/{bpa}`, ruleId}) → the LRO
 *                        operation name (required back — "accepted with no
 *                        operation" must throw, never a silent success).
 */
export interface GcpInfraLiveClient {
  /** REAL: ADC / workload identity federation — never a static SA key. */
  openSession(params: { projectId: string }): Promise<GcpSession>;
  /** REAL: osconfig listInventories (view FULL) for a zone's instances */
  listInventories(params: {
    sessionId: string;
    projectId: string;
    zone: string;
  }): Promise<GcpInstanceInventory[]>;
  /** REAL: osconfig listVulnerabilityReports, flattened per (instance, vuln) */
  listVulnerabilities(params: {
    sessionId: string;
    projectId: string;
    zone: string;
  }): Promise<GcpVulnerability[]>;
  /** REAL: certificatemanager listCertificates for a location */
  listCertificates(params: {
    sessionId: string;
    projectId: string;
    location: string;
  }): Promise<GcpCertificate[]>;
  /** REAL: backupdr listBackups for a backup vault's data source */
  listBackups(params: {
    sessionId: string;
    projectId: string;
    location: string;
    backupVault: string;
    dataSource: string;
  }): Promise<GcpBackup[]>;
  /** REAL: osconfig executePatchJob against an explicit instance list */
  executePatchJob(params: {
    sessionId: string;
    projectId: string;
    instances: string[];
  }): Promise<{ patchJobName: string }>;
  /** REAL: backupdr backupPlanAssociations.triggerBackup (on-demand backup) */
  triggerBackup(params: {
    sessionId: string;
    projectId: string;
    location: string;
    backupPlanAssociation: string;
    ruleId: string;
  }): Promise<{ operationName: string }>;
}

// ---------------------------------------------------------------------------
// Severity mapping — the SHARED ADR-0017 math first (GCP vulnerability
// reports carry REAL CVSS v3 base scores → cvssToSeverity 9/7/4), then the
// report's own severity enum, then an explicit default. `severitySource`
// always says which was used.
// ---------------------------------------------------------------------------

/** OS Config vulnerability severity enum → our ladder. Returns null for
 * values it does not recognize (incl. SEVERITY_UNSPECIFIED). */
export function gcpSeverityToBand(severity: string | null | undefined): InfraSeverity | null {
  switch ((severity ?? "").trim().toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MEDIUM":
    case "MODERATE":
      return "medium";
    case "LOW":
    case "MINIMAL":
      return "low";
    default:
      return null;
  }
}

export type GcpVulnSeveritySource = "cvss" | "vendor" | "default";

/** Band a single vulnerability. Preference order, each from a real field:
 * 1. details.cvssV3.baseScore → the SHARED 9/7/4 cvssToSeverity ladder;
 * 2. details.severity enum → gcpSeverityToBand;
 * 3. neither known → "medium", explicitly severitySource:"default" (the same
 *    documented conservative policy as the aws/azure adapters). */
export function gcpVulnSeverityBand(vuln: GcpVulnerability): {
  severity: InfraSeverity;
  severitySource: GcpVulnSeveritySource;
} {
  if (typeof vuln.cvssBaseScore === "number" && Number.isFinite(vuln.cvssBaseScore)) {
    return { severity: cvssToSeverity(vuln.cvssBaseScore), severitySource: "cvss" };
  }
  const vendor = gcpSeverityToBand(vuln.severity);
  if (vendor !== null) return { severity: vendor, severitySource: "vendor" };
  return { severity: "medium", severitySource: "default" };
}

/** The inventory keys the adapter can actually OBSERVE via OS Config
 * Inventory.osInfo, with the real source field of each. Any declared-baseline
 * key outside this set is reported in `unassessableKeys` — never counted as
 * drift. */
const OBSERVABLE_INVENTORY_KEYS: Record<string, (i: GcpInstanceInventory) => unknown> = {
  hostname: (i) => i.hostname ?? null,
  os_long_name: (i) => i.osLongName ?? null,
  os_short_name: (i) => i.osShortName ?? null,
  os_version: (i) => i.osVersion ?? null,
  kernel_version: (i) => i.kernelVersion ?? null,
  architecture: (i) => i.architecture ?? null,
  osconfig_agent_version: (i) => i.osconfigAgentVersion ?? null,
};

function toDate(v: string | Date | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
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

export interface GcpInfraProviderOptions {
  /** the customer project every call is scoped to (BYOC boundary) */
  projectId: string;
  /** the zone OS Config inventory/vulnerability calls are driven in */
  zone?: string | null;
  /** the Certificate Manager / Backup and DR location (default "global" for
   * certs; backups usually a region) */
  location?: string | null;
  /** injectable-client discipline: a fake in tests, a real
   * @google-cloud/*-backed impl (see the GcpInfraLiveClient factory contract)
   * in a live deployment. Absent = structured not-live error. */
  client?: GcpInfraLiveClient;
  /** captured at construction so a test can flip it per-instance; defaults to
   * the REGULAIT_INFRA_LIVE env flag (shared with the aws adapter). */
  live?: boolean;
  /** injectable clock for deterministic severity-band tests */
  now?: () => Date;
}

export class GcpInfraProvider implements InfraProvider {
  readonly kind = "gcp" as const;
  private readonly projectId: string;
  private readonly zone: string | null;
  private readonly location: string | null;
  private readonly client: GcpInfraLiveClient | undefined;
  private readonly live: boolean;
  private readonly now: () => Date;

  constructor(opts: GcpInfraProviderOptions) {
    this.projectId = opts.projectId;
    this.zone = opts.zone ?? null;
    this.location = opts.location ?? null;
    this.client = opts.client;
    this.live = opts.live ?? infraLiveEnabledLocal();
    this.now = opts.now ?? (() => new Date());
  }

  /** The honesty gate — identical semantics to the aws adapter's requireLive. */
  private requireLive(op: string): GcpInfraLiveClient {
    if (!this.projectId) {
      throw new InfraProviderError(`gcp infra ${op} needs a projectId on the monitored resource`);
    }
    if (!this.live) {
      throw new InfraProviderError(
        `gcp infra ${op} did not run: REGULAIT_INFRA_LIVE is off and this adapter has no dry-run — ` +
          `a fabricated scan result would be fake data (ADR-0017). Enable the flag AND inject a live client to go live.`,
        501,
      );
    }
    if (!this.client) {
      throw new InfraProviderError(
        `gcp infra ${op} did not run: REGULAIT_INFRA_LIVE is on but no live GCP infra client was injected — ` +
          `wire a GcpInfraLiveClient (see the factory contract in @regulait/infra-provider gcp.ts); never a silent stub`,
        501,
      );
    }
    return this.client;
  }

  /** Wrap every client call so a GCP failure (quota, auth, network) surfaces
   * as a typed InfraProviderError naming the operation, mapping the gax gRPC
   * code to an HTTP-ish status when present. */
  private async call<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof InfraProviderError) throw err;
      const e = err as { name?: string; message?: string; code?: number };
      const status =
        typeof e?.code === "number" ? (GRPC_TO_HTTP[e.code] ?? undefined) : undefined;
      const prefix =
        typeof e?.name === "string" && e.name.length > 0 && e.name !== "Error" ? `${e.name}: ` : "";
      throw new InfraProviderError(
        `gcp ${op} failed — ${prefix}${e?.message ?? String(err)}`,
        status,
      );
    }
  }

  private requireZone(op: string): string {
    if (!this.zone) {
      throw new InfraProviderError(
        `gcp infra ${op} needs a zone (config.zone, e.g. us-central1-a) — OS Config inventory and ` +
          `vulnerability reports are listed per zone`,
      );
    }
    return this.zone;
  }

  /** REAL: ADC / workload identity — never a static key through this package. */
  private async open(client: GcpInfraLiveClient): Promise<GcpSession> {
    return this.call("auth:openSession", () => client.openSession({ projectId: this.projectId }));
  }

  async scan(resource: InfraResourceRef): Promise<InfraFindingReport[]> {
    const client = this.requireLive("scan");
    const { sessionId } = await this.open(client);
    switch (resource.kind) {
      case "control_plane":
      case "agent_runtime":
        return this.scanInstances(client, sessionId, resource);
      case "cert":
        return this.scanCerts(client, sessionId, resource);
      case "backup_target":
        return this.scanBackups(client, sessionId, resource);
    }
  }

  /** OS Config inventories (drift vs a DECLARED baseline) + vulnerability
   * reports (CVE posture with real CVSS). */
  private async scanInstances(
    client: GcpInfraLiveClient,
    sessionId: string,
    resource: InfraResourceRef,
  ): Promise<InfraFindingReport[]> {
    const cfg = resource.config ?? {};
    const zone = this.requireZone("scan");
    const inventories = await this.call("osconfig:listInventories", () =>
      client.listInventories({ sessionId, projectId: this.projectId, zone }),
    );
    if (inventories.length === 0) {
      // HONEST GAP: zero inventories is NOT a clean fleet — the OS Config
      // agent is not reporting, so drift/CVE posture is unanswerable. An empty
      // findings list would be a fake "all clear" (same rule as aws/azure).
      throw new InfraProviderError(
        `gcp scan of '${resource.name}': OS Config returned no instance inventories in ` +
          `${this.projectId}/${zone} — drift/CVE posture cannot be assessed (nothing observed is ` +
          `not the same as clean); check the OS Config agent / API enablement on the target fleet`,
      );
    }

    const findings: InfraFindingReport[] = [];

    // ---- drift — ONLY against a DECLARED baseline --------------------------
    // HONEST GAP: OS Config inventory has no health/agent-currency fields
    // comparable to SSM PingStatus/IsLatestVersion, so GCP has NO default
    // baseline. No declared baseline = no drift findings (stated in the
    // adapter contract), never a fabricated health check.
    const declared = isRecord(cfg.baseline) ? cfg.baseline : {};
    const declaredObservable: Record<string, unknown> = {};
    const unassessableKeys: string[] = [];
    for (const key of Object.keys(declared)) {
      if (key in OBSERVABLE_INVENTORY_KEYS) declaredObservable[key] = declared[key];
      else unassessableKeys.push(key);
    }
    unassessableKeys.sort();
    if (Object.keys(declaredObservable).length > 0 || unassessableKeys.length > 0) {
      for (const inv of [...inventories].sort((a, b) => a.instanceId.localeCompare(b.instanceId))) {
        const observed: Record<string, unknown> = {};
        for (const key of Object.keys(declaredObservable)) {
          observed[key] = OBSERVABLE_INVENTORY_KEYS[key]!(inv);
        }
        const drift = compareDrift(declaredObservable, observed);
        if (drift.drifted.length === 0 && unassessableKeys.length === 0) continue;
        const signature = `drift:${inv.instanceId}`;
        findings.push({
          kind: "drift",
          severity: drift.drifted.length > 0 ? drift.severity : "low",
          signature,
          detail: {
            signature,
            instanceId: inv.instanceId,
            drifted: drift.drifted,
            declared: declaredObservable,
            observed,
            unassessableKeys,
            summary:
              drift.drifted.length > 0
                ? `instance ${inv.instanceId} drifted from the declared baseline on: ${drift.drifted.join(", ")}`
                : `declared baseline key(s) ${unassessableKeys.join(", ")} cannot be assessed via OS Config inventory osInfo`,
          },
        });
      }
    }

    // ---- CVE posture — real CVSS from vulnerability reports ----------------
    const vulns = await this.call("osconfig:listVulnerabilityReports", () =>
      client.listVulnerabilities({ sessionId, projectId: this.projectId, zone }),
    );
    // aggregate the same CVE across the fleet into ONE finding at max severity
    // (the same natural-key shape as the aws adapter / patch ledger).
    const byCve = new Map<
      string,
      {
        vuln: GcpVulnerability;
        severity: InfraSeverity;
        severitySource: GcpVulnSeveritySource;
        instanceIds: string[];
      }
    >();
    for (const vuln of vulns) {
      const key = vuln.cve ?? "unidentified-vulnerability";
      const band = gcpVulnSeverityBand(vuln);
      const existing = byCve.get(key);
      if (!existing) {
        byCve.set(key, { vuln, ...band, instanceIds: [vuln.instanceId] });
      } else {
        if (!existing.instanceIds.includes(vuln.instanceId)) existing.instanceIds.push(vuln.instanceId);
        if (severityRank(band.severity) > severityRank(existing.severity)) {
          existing.severity = band.severity;
          existing.severitySource = band.severitySource;
          existing.vuln = vuln;
        }
      }
    }
    for (const [key, agg] of [...byCve.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const signature = `cve:${key}`;
      findings.push({
        kind: "cve",
        severity: agg.severity,
        signature,
        detail: {
          signature,
          cve: key,
          cvssBaseScore: agg.vuln.cvssBaseScore ?? null,
          vendorSeverity: agg.vuln.severity ?? null,
          severitySource: agg.severitySource,
          description: agg.vuln.description ?? null,
          fixAvailable: agg.vuln.fixAvailable ?? null,
          instanceIds: [...agg.instanceIds].sort(),
          // operator scope carried forward so a governed remediation can
          // executePatchJob without re-reading the resource
          zone,
          summary: `${key} affects ${agg.instanceIds.length} instance(s)${agg.vuln.fixAvailable ? " — a fixed package is available" : ""}`,
        },
      });
    }
    return findings;
  }

  /** Certificate Manager certificates → cert_expiring findings via the SHARED
   * certSeverity date math (0/14/30-day bands). */
  private async scanCerts(
    client: GcpInfraLiveClient,
    sessionId: string,
    resource: InfraResourceRef,
  ): Promise<InfraFindingReport[]> {
    const cfg = resource.config ?? {};
    const location =
      typeof cfg.location === "string" ? cfg.location : (this.location ?? "global");
    const rotationWindowDays = Number(cfg.rotationWindowDays ?? 30);
    const now = this.now();
    const certs = await this.call("certificatemanager:listCertificates", () =>
      client.listCertificates({ sessionId, projectId: this.projectId, location }),
    );
    const findings: InfraFindingReport[] = [];
    for (const cert of certs) {
      const expireTime = toDate(cert.expireTime);
      // HONEST GAP: a cert with no expireTime (a managed cert still
      // PROVISIONING, or FAILED) has no expiry to band — skipped, never
      // assigned an invented date/severity (same rule as aws/azure).
      if (!expireTime) continue;
      const { severity, daysUntilExpiry, shouldRotate } = certSeverity(
        expireTime,
        now,
        rotationWindowDays,
      );
      if (!shouldRotate && severity === "low") continue; // healthy — no finding
      const commonName = cert.sanDnsnames?.[0] ?? cert.name;
      const signature = `cert_expiring:${commonName}`;
      findings.push({
        kind: "cert_expiring",
        severity,
        signature,
        detail: {
          signature,
          daysUntilExpiry,
          commonName,
          certificateName: cert.name,
          sanDnsnames: cert.sanDnsnames ?? [],
          notAfter: expireTime.toISOString(),
          // carried so remediate() can explain the structural 501 precisely
          managementType: cert.managementType ?? null,
          managedState: cert.managedState ?? null,
          location,
          summary:
            daysUntilExpiry <= 0
              ? "certificate has ALREADY EXPIRED — service-affecting"
              : `certificate expires in ${daysUntilExpiry} day(s)`,
        },
      });
    }
    return findings;
  }

  /** Backup and DR backups → backup_missed findings via the SHARED
   * evaluateBackupSchedule interval multipliers. */
  private async scanBackups(
    client: GcpInfraLiveClient,
    sessionId: string,
    resource: InfraResourceRef,
  ): Promise<InfraFindingReport[]> {
    const cfg = resource.config ?? {};
    const location = typeof cfg.location === "string" ? cfg.location : (this.location ?? null);
    const backupVault = typeof cfg.backupVault === "string" ? cfg.backupVault : null;
    const dataSource = typeof cfg.dataSource === "string" ? cfg.dataSource : null;
    const missing = [
      !location && "location",
      !backupVault && "backupVault",
      !dataSource && "dataSource",
    ].filter((v): v is string => typeof v === "string");
    if (missing.length > 0) {
      throw new InfraProviderError(
        `gcp backup scan of '${resource.name}' needs ${missing.join(", ")} in the resource config ` +
          `(Backup and DR backups are listed per backupVault/dataSource in a location)`,
      );
    }
    const schedule = String(cfg.backupSchedule ?? "daily");
    const retentionDays = Number(cfg.retentionDays ?? 30);
    const now = this.now();
    const backups = await this.call("backupdr:listBackups", () =>
      client.listBackups({
        sessionId,
        projectId: this.projectId,
        location: location!,
        backupVault: backupVault!,
        dataSource: dataSource!,
      }),
    );
    // only an ACTIVE backup with a real consistencyTime counts as a successful
    // backup — CREATING/DELETING/ERROR do not (Backup.state, a real field).
    let lastBackupAt: Date | null = null;
    let lastBackupName: string | null = null;
    let activeCount = 0;
    for (const b of backups) {
      if (b.state !== "ACTIVE") continue;
      const t = toDate(b.consistencyTime);
      if (!t) continue;
      activeCount += 1;
      if (!lastBackupAt || t.getTime() > lastBackupAt.getTime()) {
        lastBackupAt = t;
        lastBackupName = b.name;
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
          backupVault,
          dataSource,
          location,
          schedule,
          due,
          missed,
          lastBackupAt: lastBackupAt ? lastBackupAt.toISOString() : null,
          lastBackupName,
          backupCount: backups.length,
          activeCount,
          retentionUntil: retentionUntil.toISOString(),
          // operator config (NOT a GCP response field) carried forward so a
          // governed remediation can triggerBackup without re-reading the
          // resource — triggerBackup needs the plan association + rule id.
          backupPlanAssociation:
            typeof cfg.backupPlanAssociation === "string" ? cfg.backupPlanAssociation : null,
          ruleId: typeof cfg.ruleId === "string" ? cfg.ruleId : null,
          summary: lastBackupAt
            ? `no ACTIVE backup since ${lastBackupAt.toISOString()} (schedule: ${schedule})`
            : `no ACTIVE backup exists for data source '${dataSource}' in vault '${backupVault}' (schedule: ${schedule})`,
        },
      },
    ];
  }

  /** Governed remediation — reached only AFTER the gateway's approval
   * decision. One real GCP action per finding kind; anything GCP cannot do is
   * an explicit structured error, never a pretend success. */
  async remediate(finding: InfraFindingRef): Promise<InfraRemediationResult> {
    const client = this.requireLive("remediate");
    const detail = isRecord(finding.detail) ? finding.detail : {};
    const { sessionId } = await this.open(client);
    switch (finding.kind) {
      case "cve": {
        const raw = detail.instanceIds;
        const instances = Array.isArray(raw)
          ? raw.filter((v): v is string => typeof v === "string" && v.length > 0)
          : strField(detail, "instanceId")
            ? [strField(detail, "instanceId")!]
            : [];
        if (instances.length === 0) {
          throw new InfraProviderError(
            "gcp patch remediation needs the scan finding's detail.instanceIds — refusing to " +
              "executePatchJob against an unknown instance set",
          );
        }
        const { patchJobName } = await this.call("osconfig:executePatchJob", () =>
          client.executePatchJob({ sessionId, projectId: this.projectId, instances }),
        );
        return {
          ok: true,
          detail: {
            remediated: true,
            kind: finding.kind,
            signature: finding.signature,
            action: "applied vendor patch",
            via: "osconfig executePatchJob (explicit instance filter)",
            patchJobName,
            instanceIds: instances,
            live: true,
          },
        };
      }
      case "cert_expiring": {
        // HONEST GAP — STRUCTURAL: Certificate Manager has NO "renew now" API.
        // A Google-MANAGED cert renews automatically on Google's schedule and
        // cannot be forced; a SELF_MANAGED cert must be re-issued at the CA
        // and re-uploaded. Either way there is no real API call to make here —
        // a stub that "rotated" the cert would be fake success (ADR-0017).
        const managementType = strField(detail, "managementType");
        const certificateName = strField(detail, "certificateName") ?? "the certificate";
        throw new InfraProviderError(
          managementType === "managed"
            ? `gcp certificate rotation is not possible via API for ${certificateName}: it is a ` +
              `Google-MANAGED certificate — Google renews it automatically before expiry and ` +
              `Certificate Manager has no "renew now" endpoint to force it; if it is close to expiry, ` +
              `check the managed.state/provisioning issues instead`
            : `gcp certificate rotation is not possible via API for ${certificateName}: it is a ` +
              `SELF_MANAGED certificate — re-issue it at the issuing CA and update the certificate ` +
              `with the new PEM (Certificate Manager has no renewal endpoint)`,
          501,
        );
      }
      case "backup_missed": {
        const location = strField(detail, "location");
        const backupPlanAssociation = strField(detail, "backupPlanAssociation");
        const ruleId = strField(detail, "ruleId");
        const missing = [
          !location && "location",
          !backupPlanAssociation && "backupPlanAssociation",
          !ruleId && "ruleId",
        ].filter((v): v is string => typeof v === "string");
        if (missing.length > 0) {
          throw new InfraProviderError(
            `gcp out-of-band backup needs ${missing.join(", ")} in the finding detail ` +
              `(backupdr triggerBackup runs against a backup plan association's rule) — set ` +
              `backupPlanAssociation/ruleId on the monitored resource's config`,
          );
        }
        const { operationName } = await this.call("backupdr:triggerBackup", () =>
          client.triggerBackup({
            sessionId,
            projectId: this.projectId,
            location: location!,
            backupPlanAssociation: backupPlanAssociation!,
            ruleId: ruleId!,
          }),
        );
        return {
          ok: true,
          detail: {
            remediated: true,
            kind: finding.kind,
            signature: finding.signature,
            action: "triggered out-of-band backup",
            via: "backupdr backupPlanAssociations.triggerBackup",
            operationName,
            backupPlanAssociation,
            ruleId,
            live: true,
          },
        };
      }
      case "drift":
        // HONEST GAP: same rule as aws/azure — the owning IaC pipeline's job.
        throw new InfraProviderError(
          "gcp drift remediation is not supported by this adapter: re-applying a configuration baseline is the " +
            "owning IaC pipeline's job (Terraform / OS Config guest policies) — the adapter does not guess at " +
            "mutations in a customer project",
          501,
        );
    }
  }
}

/** gax gRPC status code → the nearest HTTP status, for InfraProviderError. */
const GRPC_TO_HTTP: Record<number, number> = {
  1: 499, // CANCELLED
  3: 400, // INVALID_ARGUMENT
  4: 504, // DEADLINE_EXCEEDED
  5: 404, // NOT_FOUND
  7: 403, // PERMISSION_DENIED
  8: 429, // RESOURCE_EXHAUSTED
  13: 500, // INTERNAL
  14: 503, // UNAVAILABLE
  16: 401, // UNAUTHENTICATED
};

/** local re-read of the shared flag (kept here to avoid an import cycle with
 * aws.ts; identical contract to aws.infraLiveEnabled). */
function infraLiveEnabledLocal(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.REGULAIT_INFRA_LIVE;
  return v === "1" || v === "true";
}
