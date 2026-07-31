/**
 * The REAL Azure infra adapter, driven end-to-end through a FAKE injected
 * AzureInfraLiveClient (injectable-client discipline — no network, ever).
 * Covers: VM drift detected/clean/unassessable, patch banding via MSRC
 * severity / classification / explicit default (Azure has NO CVSS — proven),
 * assessment-counter fallback, the unassessed-VM visibility finding, Key Vault
 * cert expiry banding at the SHARED 0/14/30-day bands, missed-backup interval
 * multipliers over statusless recovery points, Azure error surfacing, and the
 * not-live/unwired structured-501 honesty cases.
 */
import { describe, expect, it } from "vitest";
import {
  AzureInfraProvider,
  DEFAULT_AZURE_VM_BASELINE,
  InfraProviderError,
  azurePatchSeverityBand,
  classificationToBand,
  msrcSeverityToBand,
  resolveInfraProvider,
  type AzureInfraLiveClient,
  type AzureKeyVaultCertDetail,
  type AzurePatchAssessment,
  type AzureRecoveryPoint,
  type AzureSoftwarePatch,
  type AzureVmInfo,
  type InfraFindingRef,
  type InfraResourceRef,
} from "./index.js";

const NOW = new Date("2026-07-30T00:00:00Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const SUB = "00000000-1111-2222-3333-444444444444";
const VAULT_URL = "https://regulait-vault.vault.azure.net";

/** a fully-recording fake — every call is captured, every response is canned */
class FakeAzureInfraClient implements AzureInfraLiveClient {
  calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  vms: AzureVmInfo[] = [];
  assessments: AzurePatchAssessment[] = [];
  missingPatches: Record<string, AzureSoftwarePatch[]> = {};
  certs: AzureKeyVaultCertDetail[] = [];
  recoveryPoints: AzureRecoveryPoint[] = [];
  failOn: Record<string, { name?: string; code?: string; message: string; statusCode?: number }> = {};

  private hit(op: string, params: Record<string, unknown>): void {
    this.calls.push({ op, params });
    const f = this.failOn[op];
    if (f) {
      const err = new Error(f.message) as Error & { statusCode?: number; code?: string };
      if (f.name) err.name = f.name;
      if (f.code) err.code = f.code;
      if (f.statusCode !== undefined) err.statusCode = f.statusCode;
      throw err;
    }
  }

  async openSession(p: { subscriptionId: string }) {
    this.hit("openSession", p);
    return { sessionId: `az-sess:${p.subscriptionId}` };
  }
  async listVirtualMachines(p: { sessionId: string; subscriptionId: string; resourceGroup?: string }) {
    this.hit("listVirtualMachines", p);
    return this.vms;
  }
  async listPatchAssessments(p: { sessionId: string; subscriptionId: string; resourceGroup?: string }) {
    this.hit("listPatchAssessments", p);
    return this.assessments;
  }
  async listMissingPatches(p: { sessionId: string; subscriptionId: string; vmId: string }) {
    this.hit("listMissingPatches", p);
    return this.missingPatches[p.vmId] ?? [];
  }
  async listKeyVaultCertificates(p: { sessionId: string; vaultUrl: string }) {
    this.hit("listKeyVaultCertificates", p);
    return this.certs.map((c) => ({ name: c.name, id: c.id ?? null, enabled: c.enabled ?? null }));
  }
  async getKeyVaultCertificate(p: { sessionId: string; vaultUrl: string; name: string }) {
    this.hit("getKeyVaultCertificate", p);
    const cert = this.certs.find((c) => c.name === p.name);
    if (!cert) throw new Error(`no such cert ${p.name}`);
    return cert;
  }
  async listRecoveryPoints(p: Record<string, unknown> & { sessionId: string }) {
    this.hit("listRecoveryPoints", p);
    return this.recoveryPoints;
  }
  async installPatches(p: Record<string, unknown> & { vmName: string }) {
    this.hit("installPatches", p);
    return { installationActivityId: `act-${p.vmName}` };
  }
  async renewKeyVaultCertificate(p: { sessionId: string; vaultUrl: string; name: string }) {
    this.hit("renewKeyVaultCertificate", p);
  }
  async triggerBackup(p: Record<string, unknown>) {
    this.hit("triggerBackup", p);
    return { jobId: "azjob-42" };
  }
}

function provider(
  client?: FakeAzureInfraClient,
  opts: { live?: boolean; resourceGroup?: string } = {},
): AzureInfraProvider {
  return new AzureInfraProvider({
    subscriptionId: SUB,
    resourceGroup: opts.resourceGroup ?? "rg-prod",
    ...(client ? { client } : {}),
    live: opts.live ?? true,
    now: () => NOW,
  });
}

const res = (kind: InfraResourceRef["kind"], config: Record<string, unknown> = {}): InfraResourceRef => ({
  id: `res-${kind}`,
  kind,
  name: `azure-${kind}`,
  config,
});

const runningVm = (name: string): AzureVmInfo => ({
  vmId: `/subscriptions/${SUB}/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/${name}`,
  name,
  location: "eastus",
  powerState: "PowerState/running",
  provisioningState: "Succeeded",
  vmSize: "Standard_D2s_v5",
  osType: "Linux",
});

const cleanAssessment = (vmName: string): AzurePatchAssessment => ({
  vmName,
  vmId: runningVm(vmName).vmId,
  status: "Succeeded",
  criticalPatchCount: 0,
  securityPatchCount: 0,
  otherPatchCount: 0,
});

async function rejection(p: Promise<unknown>): Promise<InfraProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(InfraProviderError);
    return e as InfraProviderError;
  }
  throw new Error("expected rejection, got success");
}

// ---------------------------------------------------------------------------
// drift
// ---------------------------------------------------------------------------

describe("azure scan — VM drift via Resource Graph", () => {
  it("detects drift: a deallocated, failed-provisioning VM → medium (2 keys), observed values are the real ARG fields", async () => {
    const client = new FakeAzureInfraClient();
    client.vms = [
      { ...runningVm("vm-bad"), powerState: "PowerState/deallocated", provisioningState: "Failed" },
    ];
    client.assessments = [cleanAssessment("vm-bad")];
    const findings = await provider(client).scan(res("control_plane"));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.kind).toBe("drift");
    expect(f.severity).toBe("medium");
    expect(f.signature).toBe("drift:vm-bad");
    expect(f.detail.drifted).toEqual(["power_state", "provisioning_state"]);
    expect((f.detail.observed as Record<string, unknown>).power_state).toBe("PowerState/deallocated");
  });

  it("clean fleet (running, succeeded, assessed compliant) → zero findings", async () => {
    const client = new FakeAzureInfraClient();
    client.vms = [runningVm("vm-1"), runningVm("vm-2")];
    client.assessments = [cleanAssessment("vm-1"), cleanAssessment("vm-2")];
    const findings = await provider(client).scan(res("agent_runtime"));
    expect(findings).toEqual([]);
  });

  it("declared-baseline keys the ARG VM row cannot observe are reported as unassessable, never counted as drift", async () => {
    const client = new FakeAzureInfraClient();
    client.vms = [runningVm("vm-1")];
    client.assessments = [cleanAssessment("vm-1")];
    const findings = await provider(client).scan(
      res("control_plane", { baseline: { ...DEFAULT_AZURE_VM_BASELINE, disk_encryption_set: "des-1" } }),
    );
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.kind).toBe("drift");
    expect(f.severity).toBe("low"); // a visibility gap, not an observed deviation
    expect(f.detail.drifted).toEqual([]);
    expect(f.detail.unassessableKeys).toEqual(["disk_encryption_set"]);
  });

  it("zero VMs is an honest error, never a fake clean scan", async () => {
    const client = new FakeAzureInfraClient();
    const err = await rejection(provider(client).scan(res("control_plane")));
    expect(err.message).toContain("no virtual machines");
    expect(err.message).toContain("not the same as clean");
  });
});

// ---------------------------------------------------------------------------
// patch posture + severity banding (Azure has NO CVSS — proven here)
// ---------------------------------------------------------------------------

function patchScanClient(patch: AzureSoftwarePatch): FakeAzureInfraClient {
  const client = new FakeAzureInfraClient();
  client.vms = [runningVm("vm-1")];
  client.assessments = [{ ...cleanAssessment("vm-1"), securityPatchCount: 1 }];
  client.missingPatches = { [runningVm("vm-1").vmId]: [patch] };
  return client;
}

describe("azure scan — patch banding via MSRC severity / classification (no CVSS exists)", () => {
  it.each([
    ["Critical", "critical"],
    ["Important", "high"],
    ["Moderate", "medium"],
    ["Low", "low"],
  ])("Windows msrcSeverity '%s' → %s (severitySource: msrc)", async (msrc, expected) => {
    const client = patchScanClient({
      patchName: "2026-07 Cumulative Update",
      kbId: "KB5044444",
      classifications: ["Security"], // deliberately contradicts MSRC — MSRC must win
      msrcSeverity: msrc as string,
      cveNumbers: ["CVE-2026-1111"],
    });
    const findings = await provider(client).scan(res("control_plane"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("cve");
    expect(findings[0]!.signature).toBe("cve:CVE-2026-1111");
    expect(findings[0]!.severity).toBe(expected);
    expect(findings[0]!.detail.severitySource).toBe("msrc");
    // the structural honest gap: Azure assessment carries no CVSS, ever
    expect(findings[0]!.detail.cvssBaseScore).toBeNull();
  });

  it.each([
    [["Critical"], "critical"],
    [["Security"], "high"],
    [["Other"], "low"],
  ])("no MSRC severity (Linux) → classifications %o map to %s (severitySource: classification)", async (cls, expected) => {
    const client = patchScanClient({
      patchName: "openssl",
      version: "3.0.15-1",
      classifications: cls as string[],
    });
    const findings = await provider(client).scan(res("control_plane"));
    expect(findings[0]!.severity).toBe(expected);
    expect(findings[0]!.detail.severitySource).toBe("classification");
  });

  it("neither MSRC nor a classification → medium, explicitly tagged severitySource:default", async () => {
    const client = patchScanClient({ patchName: "mystery-package" });
    const findings = await provider(client).scan(res("control_plane"));
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.detail.severitySource).toBe("default");
    // and the pure helpers agree
    expect(msrcSeverityToBand("Unspecified")).toBeNull();
    expect(classificationToBand([])).toBeNull();
    expect(azurePatchSeverityBand({})).toEqual({ severity: "medium", severitySource: "default" });
  });

  it("the same patch pending on two VMs aggregates into ONE finding at max severity with sorted vmNames", async () => {
    const client = new FakeAzureInfraClient();
    client.vms = [runningVm("vm-b"), runningVm("vm-a")];
    client.assessments = [
      { ...cleanAssessment("vm-b"), securityPatchCount: 1 },
      { ...cleanAssessment("vm-a"), securityPatchCount: 1 },
    ];
    client.missingPatches = {
      [runningVm("vm-b").vmId]: [{ kbId: "KB5099999", classifications: ["Other"] }],
      [runningVm("vm-a").vmId]: [{ kbId: "KB5099999", msrcSeverity: "Important" }],
    };
    const findings = await provider(client).scan(res("agent_runtime"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.signature).toBe("cve:KB5099999");
    expect(findings[0]!.severity).toBe("high"); // max(Other→low, Important→high)
    expect(findings[0]!.detail.vmNames).toEqual(["vm-a", "vm-b"]);
    expect(findings[0]!.detail.resourceGroup).toBe("rg-prod"); // carried for remediation
  });

  it.each([
    [{ criticalPatchCount: 2 }, "critical"],
    [{ securityPatchCount: 1 }, "high"],
    [{ otherPatchCount: 3 }, "medium"],
  ])(
    "pending counters with no per-patch rows → honest counter-banded finding (%o → %s)",
    async (counters, expected) => {
      const client = new FakeAzureInfraClient();
      client.vms = [runningVm("vm-1")];
      client.assessments = [{ ...cleanAssessment("vm-1"), ...(counters as object) }];
      client.missingPatches = {}; // softwarepatches rows unavailable
      const findings = await provider(client).scan(res("control_plane"));
      expect(findings).toHaveLength(1);
      expect(findings[0]!.signature).toBe("cve:patch-assessment:vm-1");
      expect(findings[0]!.severity).toBe(expected);
      expect(findings[0]!.detail.severitySource).toBe("assessment-counters");
      expect(findings[0]!.detail.summary).toContain("no per-patch softwarepatches rows");
    },
  );

  it("a VM with NO Update Manager assessment at all is an UNKNOWN-posture finding, not a silent pass", async () => {
    const client = new FakeAzureInfraClient();
    client.vms = [runningVm("vm-dark")];
    client.assessments = []; // never assessed
    const findings = await provider(client).scan(res("control_plane"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("cve");
    expect(findings[0]!.signature).toBe("cve:unassessed:vm-dark");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.detail.summary).toContain("not assessed is not the same as compliant");
  });
});

// ---------------------------------------------------------------------------
// certs
// ---------------------------------------------------------------------------

function certClient(daysUntilExpiry: number | null, extra: Partial<AzureKeyVaultCertDetail> = {}): FakeAzureInfraClient {
  const client = new FakeAzureInfraClient();
  client.certs = [
    {
      name: "api-tls",
      id: `${VAULT_URL}/certificates/api-tls`,
      enabled: true,
      subject: "CN=api.example.com",
      issuerName: "Self",
      thumbprint: "AB:CD:EF",
      ...(daysUntilExpiry !== null ? { expiresOn: new Date(NOW.getTime() + daysUntilExpiry * DAY) } : {}),
      ...extra,
    },
  ];
  return client;
}

describe("azure scan — Key Vault cert expiry via the SHARED 0/14/30-day bands", () => {
  it.each([
    [-1, "critical"],
    [0, "critical"],
    [13, "high"],
    [14, "medium"],
    [29, "medium"],
    [30, "low"], // inside the default 30-day rotation window → still reported
  ])("expiresOn in %s day(s) → %s", async (days, expected) => {
    const findings = await provider(certClient(days as number)).scan(res("cert", { vaultUrl: VAULT_URL }));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.kind).toBe("cert_expiring");
    expect(f.severity).toBe(expected);
    expect(f.signature).toBe("cert_expiring:CN=api.example.com");
    expect(f.detail.daysUntilExpiry).toBe(days);
    // every mapped field is the real Key Vault response field
    expect(f.detail.issuer).toBe("Self");
    expect(f.detail.serial).toBe("AB:CD:EF");
    expect(f.detail.vaultUrl).toBe(VAULT_URL);
  });

  it("a comfortably-valid cert (90 days) yields no finding; a cert still being issued (no expiresOn) is skipped", async () => {
    expect(await provider(certClient(90)).scan(res("cert", { vaultUrl: VAULT_URL }))).toEqual([]);
    expect(await provider(certClient(null)).scan(res("cert", { vaultUrl: VAULT_URL }))).toEqual([]);
  });

  it("a cert resource without config.vaultUrl is an honest config error, nothing is scanned", async () => {
    const client = certClient(5);
    const err = await rejection(provider(client).scan(res("cert")));
    expect(err.message).toContain("vaultUrl");
    expect(client.calls.filter((c) => c.op !== "openSession")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// backups (statusless recovery points)
// ---------------------------------------------------------------------------

const BACKUP_CFG = {
  vaultName: "rsv-prod",
  resourceGroup: "rg-prod",
  containerName: "iaasvmcontainer;vm-1",
  protectedItemName: "vm;vm-1",
};

const point = (hoursAgo: number, id = `rp-${hoursAgo}h`): AzureRecoveryPoint => ({
  recoveryPointId: id,
  recoveryPointTime: new Date(NOW.getTime() - hoursAgo * HOUR),
  recoveryPointType: "AppConsistent",
});

describe("azure scan — missed backups via the SHARED interval multipliers", () => {
  it.each([
    [2, null], // < 1 interval: on schedule, no finding
    [30, "medium"], // >= 1x daily interval: due
    [100, "high"], // >= 3x daily interval
  ])("daily schedule, newest recovery point %sh ago → %s", async (hours, expected) => {
    const client = new FakeAzureInfraClient();
    client.recoveryPoints = [point(hours as number)];
    const findings = await provider(client).scan(res("backup_target", { ...BACKUP_CFG, backupSchedule: "daily" }));
    if (expected === null) expect(findings).toEqual([]);
    else {
      expect(findings).toHaveLength(1);
      expect(findings[0]!.kind).toBe("backup_missed");
      expect(findings[0]!.severity).toBe(expected);
      // the honest structural note about statusless azure recovery points
      expect(findings[0]!.detail.statusNote).toContain("no status field");
    }
  });

  it("no recovery point at all → high, lastBackupAt honestly null, dated/total counts reported", async () => {
    const client = new FakeAzureInfraClient();
    client.recoveryPoints = [{ recoveryPointId: "rp-undated" }]; // no recoveryPointTime
    const findings = await provider(client).scan(res("backup_target", BACKUP_CFG));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.detail.lastBackupAt).toBeNull();
    expect(findings[0]!.detail.recoveryPointCount).toBe(1);
    expect(findings[0]!.detail.datedCount).toBe(0);
  });

  it("picks the NEWEST point and reports its real id + retention window", async () => {
    const client = new FakeAzureInfraClient();
    client.recoveryPoints = [point(80, "rp-old"), point(40, "rp-new")];
    const findings = await provider(client).scan(res("backup_target", { ...BACKUP_CFG, retentionDays: 10 }));
    expect(findings[0]!.detail.lastRecoveryPointId).toBe("rp-new");
    expect(findings[0]!.detail.retentionUntil).toBe(new Date(NOW.getTime() + 10 * DAY).toISOString());
  });

  it("missing container/protectedItem config is an honest error naming exactly the missing keys", async () => {
    const client = new FakeAzureInfraClient();
    const err = await rejection(provider(client).scan(res("backup_target", { vaultName: "rsv" })));
    expect(err.message).toContain("containerName");
    expect(err.message).toContain("protectedItemName");
    expect(client.calls.some((c) => c.op === "listRecoveryPoints")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// remediation
// ---------------------------------------------------------------------------

const findingRef = (
  kind: InfraFindingRef["kind"],
  detail: Record<string, unknown> | null,
): InfraFindingRef => ({
  id: "f-1",
  resourceId: "res-1",
  kind,
  signature: `${kind}:x`,
  detail,
});

describe("azure remediate — one real governed action per finding kind", () => {
  it("cve → compute installPatches once per VM in the finding's vmNames", async () => {
    const client = new FakeAzureInfraClient();
    const result = await provider(client).remediate(
      findingRef("cve", { vmNames: ["vm-1", "vm-2"], resourceGroup: "rg-x" }),
    );
    expect(result.ok).toBe(true);
    expect(result.detail.action).toBe("applied vendor patch");
    expect(result.detail.installations).toEqual([
      { vmName: "vm-1", installationActivityId: "act-vm-1" },
      { vmName: "vm-2", installationActivityId: "act-vm-2" },
    ]);
    const calls = client.calls.filter((c) => c.op === "installPatches");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.params.resourceGroup).toBe("rg-x"); // finding detail wins
  });

  it("cve without vmNames refuses honestly (no guessing at a patch target)", async () => {
    const client = new FakeAzureInfraClient();
    const err = await rejection(provider(client).remediate(findingRef("cve", {})));
    expect(err.message).toContain("vmNames");
    expect(client.calls.some((c) => c.op === "installPatches")).toBe(false);
  });

  it("cert_expiring (Self/integrated issuer) → Key Vault re-issue on the existing policy", async () => {
    const client = new FakeAzureInfraClient();
    const result = await provider(client).remediate(
      findingRef("cert_expiring", { vaultUrl: VAULT_URL, certName: "api-tls", issuer: "Self" }),
    );
    expect(result.ok).toBe(true);
    expect(result.detail.action).toBe("rotated certificate");
    const call = client.calls.find((c) => c.op === "renewKeyVaultCertificate");
    expect(call?.params).toMatchObject({ vaultUrl: VAULT_URL, name: "api-tls" });
  });

  it("cert_expiring with issuer 'Unknown' (imported) → structured 501, renew never called", async () => {
    const client = new FakeAzureInfraClient();
    const err = await rejection(
      provider(client).remediate(
        findingRef("cert_expiring", { vaultUrl: VAULT_URL, certName: "ext-tls", issuer: "Unknown" }),
      ),
    );
    expect(err.status).toBe(501);
    expect(err.message).toContain("Unknown");
    expect(client.calls.some((c) => c.op === "renewKeyVaultCertificate")).toBe(false);
  });

  it("backup_missed → recoveryservices backups.trigger with vault/container/item from the finding", async () => {
    const client = new FakeAzureInfraClient();
    const result = await provider(client).remediate(findingRef("backup_missed", { ...BACKUP_CFG }));
    expect(result.ok).toBe(true);
    expect(result.detail.action).toBe("triggered out-of-band backup");
    expect(result.detail.jobId).toBe("azjob-42");
    expect(client.calls.find((c) => c.op === "triggerBackup")?.params).toMatchObject({
      vaultName: "rsv-prod",
      protectedItemName: "vm;vm-1",
    });
  });

  it("backup_missed with missing detail refuses honestly and names the missing fields", async () => {
    const client = new FakeAzureInfraClient();
    const err = await rejection(
      provider(client).remediate(findingRef("backup_missed", { vaultName: "rsv-prod" })),
    );
    expect(err.message).toContain("resourceGroup");
    expect(err.message).toContain("containerName");
    expect(client.calls.some((c) => c.op === "triggerBackup")).toBe(false);
  });

  it("drift remediation is honestly unsupported (IaC's job) — structured 501, no mutation attempted", async () => {
    const client = new FakeAzureInfraClient();
    const err = await rejection(provider(client).remediate(findingRef("drift", { vmName: "vm-1" })));
    expect(err.status).toBe(501);
    expect(err.message).toContain("not supported");
    expect(client.calls.map((c) => c.op)).toEqual(["openSession"]);
  });
});

// ---------------------------------------------------------------------------
// error surfacing + the not-live honesty gate
// ---------------------------------------------------------------------------

describe("azure — API errors surface as typed InfraProviderError with the real status", () => {
  it("throttling (429) on the Resource Graph query surfaces code, message, and status", async () => {
    const client = new FakeAzureInfraClient();
    client.vms = [runningVm("vm-1")];
    client.failOn.listVirtualMachines = { code: "RateLimiting", message: "Too many requests", statusCode: 429 };
    const err = await rejection(provider(client).scan(res("control_plane")));
    expect(err.status).toBe(429);
    expect(err.message).toContain("RateLimiting");
    expect(err.message).toContain("resourcegraph:virtualMachines");
  });

  it("auth failure (401) on openSession surfaces before any scan call is made", async () => {
    const client = new FakeAzureInfraClient();
    client.failOn.openSession = { name: "CredentialUnavailableError", message: "DefaultAzureCredential failed", statusCode: 401 };
    const err = await rejection(provider(client).scan(res("cert", { vaultUrl: VAULT_URL })));
    expect(err.status).toBe(401);
    expect(err.message).toContain("identity:openSession");
    expect(client.calls).toHaveLength(1); // openSession only — nothing else ran
  });

  it("threads the credential session id through every subsequent call", async () => {
    const client = new FakeAzureInfraClient();
    await provider(client).scan(res("cert", { vaultUrl: VAULT_URL }));
    const [open, list] = client.calls;
    expect(open!.op).toBe("openSession");
    expect(open!.params.subscriptionId).toBe(SUB);
    expect(list!.params.sessionId).toBe(`az-sess:${SUB}`);
  });
});

describe("azure — structured not-live results, never fake success", () => {
  it("live flag off → scan is a structured 501 naming REGULAIT_INFRA_LIVE; the client is never touched", async () => {
    const client = new FakeAzureInfraClient();
    const err = await rejection(provider(client, { live: false }).scan(res("control_plane")));
    expect(err.status).toBe(501);
    expect(err.message).toContain("REGULAIT_INFRA_LIVE");
    expect(client.calls).toHaveLength(0);
  });

  it("live flag on but NO client injected → structured 501, for scan and remediate", async () => {
    const p = provider(undefined, { live: true });
    const scanErr = await rejection(p.scan(res("cert", { vaultUrl: VAULT_URL })));
    expect(scanErr.status).toBe(501);
    expect(scanErr.message).toContain("no live Azure infra client was injected");
    const remErr = await rejection(p.remediate(findingRef("cve", { vmNames: ["vm-1"] })));
    expect(remErr.status).toBe(501);
  });

  it("missing subscriptionId is rejected before anything runs", async () => {
    const p = new AzureInfraProvider({ subscriptionId: "", client: new FakeAzureInfraClient(), live: true });
    const err = await rejection(p.scan(res("cert", { vaultUrl: VAULT_URL })));
    expect(err.message).toContain("subscriptionId");
  });

  it("registry: flag on + injected client resolves a working azure adapter", async () => {
    const prev = process.env.REGULAIT_INFRA_LIVE;
    process.env.REGULAIT_INFRA_LIVE = "1";
    try {
      const client = new FakeAzureInfraClient();
      const p = resolveInfraProvider({ kind: "azure", subscriptionId: SUB, azureLiveClient: client });
      expect(p.kind).toBe("azure");
      expect(await p.scan(res("cert", { vaultUrl: VAULT_URL }))).toEqual([]);
      expect(client.calls.map((c) => c.op)).toEqual(["openSession", "listKeyVaultCertificates"]);
    } finally {
      if (prev === undefined) delete process.env.REGULAIT_INFRA_LIVE;
      else process.env.REGULAIT_INFRA_LIVE = prev;
    }
  });
});
