/**
 * The REAL GCP infra adapter, driven end-to-end through a FAKE injected
 * GcpInfraLiveClient (injectable-client discipline — no network, ever).
 * Covers: declared-baseline-only drift (GCP has NO default baseline —
 * structural), CVE banding at the SHARED CVSS 9/7/4 boundaries + the severity
 * enum fallback + the explicit default, per-CVE fleet aggregation, Certificate
 * Manager expiry banding at the SHARED 0/14/30-day bands, missed-backup
 * interval multipliers over Backup-and-DR states, the ALWAYS-501 cert
 * remediation (no renew-now API — structural), GCP error surfacing (gRPC code
 * → HTTP status), and the not-live/unwired structured-501 honesty cases.
 */
import { describe, expect, it } from "vitest";
import {
  GcpInfraProvider,
  InfraProviderError,
  gcpSeverityToBand,
  gcpVulnSeverityBand,
  resolveInfraProvider,
  type GcpBackup,
  type GcpCertificate,
  type GcpInfraLiveClient,
  type GcpInstanceInventory,
  type GcpVulnerability,
  type InfraFindingRef,
  type InfraResourceRef,
} from "./index.js";

const NOW = new Date("2026-07-30T00:00:00Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const PROJECT = "regulait-prod";
const ZONE = "us-central1-a";

/** a fully-recording fake — every call is captured, every response is canned */
class FakeGcpInfraClient implements GcpInfraLiveClient {
  calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  inventories: GcpInstanceInventory[] = [];
  vulnerabilities: GcpVulnerability[] = [];
  certs: GcpCertificate[] = [];
  backups: GcpBackup[] = [];
  failOn: Record<string, { name?: string; message: string; code?: number }> = {};

  private hit(op: string, params: Record<string, unknown>): void {
    this.calls.push({ op, params });
    const f = this.failOn[op];
    if (f) {
      const err = new Error(f.message) as Error & { code?: number };
      if (f.name) err.name = f.name;
      if (f.code !== undefined) err.code = f.code;
      throw err;
    }
  }

  async openSession(p: { projectId: string }) {
    this.hit("openSession", p);
    return { sessionId: `gcp-sess:${p.projectId}` };
  }
  async listInventories(p: { sessionId: string; projectId: string; zone: string }) {
    this.hit("listInventories", p);
    return this.inventories;
  }
  async listVulnerabilities(p: { sessionId: string; projectId: string; zone: string }) {
    this.hit("listVulnerabilities", p);
    return this.vulnerabilities;
  }
  async listCertificates(p: { sessionId: string; projectId: string; location: string }) {
    this.hit("listCertificates", p);
    return this.certs;
  }
  async listBackups(p: Record<string, unknown>) {
    this.hit("listBackups", p);
    return this.backups;
  }
  async executePatchJob(p: { sessionId: string; projectId: string; instances: string[] }) {
    this.hit("executePatchJob", p);
    return { patchJobName: `projects/${p.projectId}/patchJobs/pj-1` };
  }
  async triggerBackup(p: Record<string, unknown>) {
    this.hit("triggerBackup", p);
    return { operationName: "operations/op-backup-1" };
  }
}

function provider(client?: FakeGcpInfraClient, opts: { live?: boolean } = {}): GcpInfraProvider {
  return new GcpInfraProvider({
    projectId: PROJECT,
    zone: ZONE,
    location: "us-central1",
    ...(client ? { client } : {}),
    live: opts.live ?? true,
    now: () => NOW,
  });
}

const res = (kind: InfraResourceRef["kind"], config: Record<string, unknown> = {}): InfraResourceRef => ({
  id: `res-${kind}`,
  kind,
  name: `gcp-${kind}`,
  config,
});

const inv = (instanceId: string, extra: Partial<GcpInstanceInventory> = {}): GcpInstanceInventory => ({
  instanceId,
  hostname: instanceId,
  osShortName: "debian",
  osVersion: "12",
  kernelVersion: "6.1.0-25",
  architecture: "x86_64",
  osconfigAgentVersion: "20260601.00",
  ...extra,
});

const vuln = (instanceId: string, extra: Partial<GcpVulnerability> = {}): GcpVulnerability => ({
  instanceId,
  cve: "CVE-2026-1111",
  ...extra,
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
// drift (declared baseline ONLY — structural)
// ---------------------------------------------------------------------------

describe("gcp scan — drift ONLY against a DECLARED baseline (no default exists — structural)", () => {
  it("no declared baseline → no drift findings (OS Config has no health fields to default on), CVEs still scanned", async () => {
    const client = new FakeGcpInfraClient();
    client.inventories = [inv("i-1")];
    client.vulnerabilities = [];
    const findings = await provider(client).scan(res("control_plane"));
    expect(findings).toEqual([]);
  });

  it("declared kernel/os baseline drifts → banded by the SHARED compareDrift count math, observed values are real osInfo fields", async () => {
    const client = new FakeGcpInfraClient();
    client.inventories = [inv("i-bad", { kernelVersion: "5.10.0-old", osVersion: "11" })];
    const findings = await provider(client).scan(
      res("control_plane", { baseline: { kernel_version: "6.1.0-25", os_version: "12" } }),
    );
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.kind).toBe("drift");
    expect(f.severity).toBe("medium"); // 2 keys
    expect(f.signature).toBe("drift:i-bad");
    expect(f.detail.drifted).toEqual(["kernel_version", "os_version"]);
    expect((f.detail.observed as Record<string, unknown>).kernel_version).toBe("5.10.0-old");
  });

  it("declared-baseline keys osInfo cannot observe are reported as unassessable, never counted as drift", async () => {
    const client = new FakeGcpInfraClient();
    client.inventories = [inv("i-1")];
    const findings = await provider(client).scan(
      res("control_plane", { baseline: { architecture: "x86_64", shielded_vm: true } }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("low"); // a visibility gap only
    expect(findings[0]!.detail.drifted).toEqual([]);
    expect(findings[0]!.detail.unassessableKeys).toEqual(["shielded_vm"]);
  });

  it("zero inventories is an honest error, never a fake clean scan", async () => {
    const client = new FakeGcpInfraClient();
    const err = await rejection(provider(client).scan(res("control_plane")));
    expect(err.message).toContain("no instance inventories");
    expect(err.message).toContain("not the same as clean");
  });

  it("a missing zone is an honest config error before anything runs", async () => {
    const client = new FakeGcpInfraClient();
    const p = new GcpInfraProvider({ projectId: PROJECT, client, live: true, now: () => NOW });
    const err = await rejection(p.scan(res("control_plane")));
    expect(err.message).toContain("zone");
    expect(client.calls.map((c) => c.op)).toEqual(["openSession"]);
  });
});

// ---------------------------------------------------------------------------
// CVE posture — real CVSS via the SHARED 9/7/4 ladder
// ---------------------------------------------------------------------------

describe("gcp scan — CVE banding at the SHARED CVSS boundaries (9/7/4)", () => {
  it.each([
    [9.0, "critical"],
    [8.9, "high"],
    [7.0, "high"],
    [6.9, "medium"],
    [4.0, "medium"],
    [3.9, "low"],
  ])("cvssV3.baseScore %s → %s (severitySource: cvss)", async (cvss, expected) => {
    const client = new FakeGcpInfraClient();
    client.inventories = [inv("i-1")];
    client.vulnerabilities = [
      vuln("i-1", { cvssBaseScore: cvss as number, severity: "LOW" }), // enum contradicts — CVSS must win
    ];
    const findings = await provider(client).scan(res("control_plane"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("cve");
    expect(findings[0]!.signature).toBe("cve:CVE-2026-1111");
    expect(findings[0]!.severity).toBe(expected);
    expect(findings[0]!.detail.severitySource).toBe("cvss");
    expect(findings[0]!.detail.cvssBaseScore).toBe(cvss);
  });

  it.each([
    ["CRITICAL", "critical"],
    ["HIGH", "high"],
    ["MEDIUM", "medium"],
    ["MINIMAL", "low"],
  ])("no CVSS → severity enum '%s' maps to %s (severitySource: vendor)", async (enumSev, expected) => {
    const client = new FakeGcpInfraClient();
    client.inventories = [inv("i-1")];
    client.vulnerabilities = [vuln("i-1", { severity: enumSev as string })];
    const findings = await provider(client).scan(res("control_plane"));
    expect(findings[0]!.severity).toBe(expected);
    expect(findings[0]!.detail.severitySource).toBe("vendor");
    expect(findings[0]!.detail.vendorSeverity).toBe(enumSev);
  });

  it("neither CVSS nor a recognizable enum → medium, explicitly tagged severitySource:default", async () => {
    const client = new FakeGcpInfraClient();
    client.inventories = [inv("i-1")];
    client.vulnerabilities = [vuln("i-1", { severity: "SEVERITY_UNSPECIFIED" })];
    const findings = await provider(client).scan(res("control_plane"));
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.detail.severitySource).toBe("default");
    // and the pure helpers agree
    expect(gcpSeverityToBand("SEVERITY_UNSPECIFIED")).toBeNull();
    expect(gcpVulnSeverityBand({ instanceId: "i" })).toEqual({ severity: "medium", severitySource: "default" });
  });

  it("the same CVE on two instances aggregates into ONE finding at max severity with sorted instanceIds + zone carried", async () => {
    const client = new FakeGcpInfraClient();
    client.inventories = [inv("i-1"), inv("i-2")];
    client.vulnerabilities = [
      vuln("i-2", { cvssBaseScore: 5.0 }),
      vuln("i-1", { cvssBaseScore: 7.5, fixAvailable: true }),
    ];
    const findings = await provider(client).scan(res("agent_runtime"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high"); // max(5.0→medium, 7.5→high)
    expect(findings[0]!.detail.instanceIds).toEqual(["i-1", "i-2"]);
    expect(findings[0]!.detail.zone).toBe(ZONE); // carried for remediation
    expect(findings[0]!.detail.fixAvailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// certs
// ---------------------------------------------------------------------------

function certClient(daysUntilExpiry: number | null, extra: Partial<GcpCertificate> = {}): FakeGcpInfraClient {
  const client = new FakeGcpInfraClient();
  client.certs = [
    {
      name: `projects/${PROJECT}/locations/global/certificates/api-tls`,
      sanDnsnames: ["api.example.com"],
      managementType: "managed",
      managedState: "ACTIVE",
      ...(daysUntilExpiry !== null ? { expireTime: new Date(NOW.getTime() + daysUntilExpiry * DAY) } : {}),
      ...extra,
    },
  ];
  return client;
}

describe("gcp scan — Certificate Manager expiry via the SHARED 0/14/30-day bands", () => {
  it.each([
    [-1, "critical"],
    [0, "critical"],
    [13, "high"],
    [14, "medium"],
    [29, "medium"],
    [30, "low"], // inside the default 30-day rotation window → still reported
  ])("expireTime in %s day(s) → %s", async (days, expected) => {
    const findings = await provider(certClient(days as number)).scan(res("cert"));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.kind).toBe("cert_expiring");
    expect(f.severity).toBe(expected);
    expect(f.signature).toBe("cert_expiring:api.example.com");
    expect(f.detail.daysUntilExpiry).toBe(days);
    // carried so remediate() can explain the structural 501 precisely
    expect(f.detail.managementType).toBe("managed");
  });

  it("a comfortably-valid cert (90 days) yields no finding; a PROVISIONING managed cert (no expireTime) is skipped", async () => {
    expect(await provider(certClient(90)).scan(res("cert"))).toEqual([]);
    expect(
      await provider(certClient(null, { managedState: "PROVISIONING" })).scan(res("cert")),
    ).toEqual([]);
  });

  it("config.location overrides the provider default and reaches the client", async () => {
    const client = certClient(5);
    await provider(client).scan(res("cert", { location: "europe-west1" }));
    expect(client.calls.find((c) => c.op === "listCertificates")?.params.location).toBe("europe-west1");
  });
});

// ---------------------------------------------------------------------------
// backups
// ---------------------------------------------------------------------------

const BACKUP_CFG = {
  location: "us-central1",
  backupVault: "bv-prod",
  dataSource: "ds-vm-1",
  backupPlanAssociation: "bpa-vm-1",
  ruleId: "daily-rule",
};

const backup = (hoursAgo: number, state = "ACTIVE", name = `b-${hoursAgo}h`): GcpBackup => ({
  name,
  state,
  consistencyTime: new Date(NOW.getTime() - hoursAgo * HOUR),
});

describe("gcp scan — missed backups via the SHARED interval multipliers", () => {
  it.each([
    [2, null], // < 1 interval: on schedule, no finding
    [30, "medium"], // >= 1x daily interval: due
    [100, "high"], // >= 3x daily interval
  ])("daily schedule, newest ACTIVE backup %sh ago → %s", async (hours, expected) => {
    const client = new FakeGcpInfraClient();
    client.backups = [backup(hours as number)];
    const findings = await provider(client).scan(res("backup_target", { ...BACKUP_CFG, backupSchedule: "daily" }));
    if (expected === null) expect(findings).toEqual([]);
    else {
      expect(findings).toHaveLength(1);
      expect(findings[0]!.kind).toBe("backup_missed");
      expect(findings[0]!.severity).toBe(expected);
    }
  });

  it("only ACTIVE backups count — an ERROR backup is honestly not a backup", async () => {
    const client = new FakeGcpInfraClient();
    client.backups = [backup(2, "ERROR"), backup(1, "CREATING")];
    const findings = await provider(client).scan(res("backup_target", BACKUP_CFG));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high"); // never successfully backed up
    expect(findings[0]!.detail.lastBackupAt).toBeNull();
    expect(findings[0]!.detail.backupCount).toBe(2);
    expect(findings[0]!.detail.activeCount).toBe(0);
  });

  it("picks the NEWEST ACTIVE backup, reports retention, and carries the trigger config for remediation", async () => {
    const client = new FakeGcpInfraClient();
    client.backups = [backup(80, "ACTIVE", "b-old"), backup(40, "ACTIVE", "b-new")];
    const findings = await provider(client).scan(res("backup_target", { ...BACKUP_CFG, retentionDays: 10 }));
    expect(findings[0]!.detail.lastBackupName).toBe("b-new");
    expect(findings[0]!.detail.retentionUntil).toBe(new Date(NOW.getTime() + 10 * DAY).toISOString());
    expect(findings[0]!.detail.backupPlanAssociation).toBe("bpa-vm-1");
    expect(findings[0]!.detail.ruleId).toBe("daily-rule");
  });

  it("missing backupVault/dataSource config is an honest error naming exactly the missing keys", async () => {
    const client = new FakeGcpInfraClient();
    const err = await rejection(provider(client).scan(res("backup_target", { location: "us-central1" })));
    expect(err.message).toContain("backupVault");
    expect(err.message).toContain("dataSource");
    expect(client.calls.some((c) => c.op === "listBackups")).toBe(false);
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

describe("gcp remediate — one real governed action per finding kind", () => {
  it("cve → osconfig executePatchJob against the finding's instance set", async () => {
    const client = new FakeGcpInfraClient();
    const result = await provider(client).remediate(findingRef("cve", { instanceIds: ["i-1", "i-2"] }));
    expect(result.ok).toBe(true);
    expect(result.detail.action).toBe("applied vendor patch");
    expect(result.detail.patchJobName).toBe(`projects/${PROJECT}/patchJobs/pj-1`);
    expect(client.calls.find((c) => c.op === "executePatchJob")?.params.instances).toEqual(["i-1", "i-2"]);
  });

  it("cve without instanceIds refuses honestly (no guessing at a patch target)", async () => {
    const client = new FakeGcpInfraClient();
    const err = await rejection(provider(client).remediate(findingRef("cve", {})));
    expect(err.message).toContain("instanceIds");
    expect(client.calls.some((c) => c.op === "executePatchJob")).toBe(false);
  });

  it("cert_expiring on a Google-MANAGED cert → ALWAYS a structured 501 (no renew-now API exists), nothing called", async () => {
    const client = new FakeGcpInfraClient();
    const err = await rejection(
      provider(client).remediate(
        findingRef("cert_expiring", { certificateName: "projects/p/locations/global/certificates/c", managementType: "managed" }),
      ),
    );
    expect(err.status).toBe(501);
    expect(err.message).toContain("Google-MANAGED");
    expect(client.calls.map((c) => c.op)).toEqual(["openSession"]);
  });

  it("cert_expiring on a SELF_MANAGED cert → structured 501 pointing at the CA re-issue path", async () => {
    const client = new FakeGcpInfraClient();
    const err = await rejection(
      provider(client).remediate(findingRef("cert_expiring", { managementType: "self_managed" })),
    );
    expect(err.status).toBe(501);
    expect(err.message).toContain("SELF_MANAGED");
    expect(err.message).toContain("re-issue");
  });

  it("backup_missed → backupdr triggerBackup with the plan association + rule from the finding", async () => {
    const client = new FakeGcpInfraClient();
    const result = await provider(client).remediate(
      findingRef("backup_missed", {
        location: "us-central1",
        backupPlanAssociation: "bpa-vm-1",
        ruleId: "daily-rule",
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.detail.action).toBe("triggered out-of-band backup");
    expect(result.detail.operationName).toBe("operations/op-backup-1");
    expect(client.calls.find((c) => c.op === "triggerBackup")?.params).toMatchObject({
      backupPlanAssociation: "bpa-vm-1",
      ruleId: "daily-rule",
    });
  });

  it("backup_missed with no plan association refuses honestly and names the missing fields", async () => {
    const client = new FakeGcpInfraClient();
    const err = await rejection(
      provider(client).remediate(findingRef("backup_missed", { location: "us-central1" })),
    );
    expect(err.message).toContain("backupPlanAssociation");
    expect(err.message).toContain("ruleId");
    expect(client.calls.some((c) => c.op === "triggerBackup")).toBe(false);
  });

  it("drift remediation is honestly unsupported (IaC's job) — structured 501, no mutation attempted", async () => {
    const client = new FakeGcpInfraClient();
    const err = await rejection(provider(client).remediate(findingRef("drift", { instanceId: "i-1" })));
    expect(err.status).toBe(501);
    expect(err.message).toContain("not supported");
    expect(client.calls.map((c) => c.op)).toEqual(["openSession"]);
  });
});

// ---------------------------------------------------------------------------
// error surfacing + the not-live honesty gate
// ---------------------------------------------------------------------------

describe("gcp — API errors surface as typed InfraProviderError with the gRPC→HTTP status", () => {
  it("RESOURCE_EXHAUSTED (gRPC 8) on listInventories surfaces as 429", async () => {
    const client = new FakeGcpInfraClient();
    client.inventories = [inv("i-1")];
    client.failOn.listInventories = { message: "Quota exceeded", code: 8 };
    const err = await rejection(provider(client).scan(res("control_plane")));
    expect(err.status).toBe(429);
    expect(err.message).toContain("osconfig:listInventories");
  });

  it("PERMISSION_DENIED (gRPC 7) on openSession surfaces as 403 before any scan call", async () => {
    const client = new FakeGcpInfraClient();
    client.failOn.openSession = { message: "The caller does not have permission", code: 7 };
    const err = await rejection(provider(client).scan(res("cert")));
    expect(err.status).toBe(403);
    expect(err.message).toContain("auth:openSession");
    expect(client.calls).toHaveLength(1); // openSession only — nothing else ran
  });

  it("threads the credential session id through every subsequent call", async () => {
    const client = new FakeGcpInfraClient();
    await provider(client).scan(res("cert"));
    const [open, list] = client.calls;
    expect(open!.op).toBe("openSession");
    expect(open!.params.projectId).toBe(PROJECT);
    expect(list!.params.sessionId).toBe(`gcp-sess:${PROJECT}`);
  });
});

describe("gcp — structured not-live results, never fake success", () => {
  it("live flag off → scan is a structured 501 naming REGULAIT_INFRA_LIVE; the client is never touched", async () => {
    const client = new FakeGcpInfraClient();
    const err = await rejection(provider(client, { live: false }).scan(res("control_plane")));
    expect(err.status).toBe(501);
    expect(err.message).toContain("REGULAIT_INFRA_LIVE");
    expect(client.calls).toHaveLength(0);
  });

  it("live flag on but NO client injected → structured 501, for scan and remediate", async () => {
    const p = provider(undefined, { live: true });
    const scanErr = await rejection(p.scan(res("cert")));
    expect(scanErr.status).toBe(501);
    expect(scanErr.message).toContain("no live GCP infra client was injected");
    const remErr = await rejection(p.remediate(findingRef("cve", { instanceIds: ["i-1"] })));
    expect(remErr.status).toBe(501);
  });

  it("missing projectId is rejected before anything runs", async () => {
    const p = new GcpInfraProvider({ projectId: "", client: new FakeGcpInfraClient(), live: true });
    const err = await rejection(p.scan(res("cert")));
    expect(err.message).toContain("projectId");
  });

  it("registry: flag on + injected client resolves a working gcp adapter", async () => {
    const prev = process.env.REGULAIT_INFRA_LIVE;
    process.env.REGULAIT_INFRA_LIVE = "1";
    try {
      const client = new FakeGcpInfraClient();
      const p = resolveInfraProvider({
        kind: "gcp",
        projectId: PROJECT,
        zone: ZONE,
        location: "us-central1",
        gcpLiveClient: client,
      });
      expect(p.kind).toBe("gcp");
      expect(await p.scan(res("cert"))).toEqual([]);
      expect(client.calls.map((c) => c.op)).toEqual(["openSession", "listCertificates"]);
    } finally {
      if (prev === undefined) delete process.env.REGULAIT_INFRA_LIVE;
      else process.env.REGULAIT_INFRA_LIVE = prev;
    }
  });
});
