/**
 * The REAL AWS infra adapter, driven end-to-end through a FAKE injected
 * AwsInfraLiveClient (injectable-client discipline — no network, ever).
 * Covers: drift detected/clean, CVE banding at the CVSS 9/7/4 boundaries and
 * the vendor-string fallback, cert expiry banding at 0/14/30 days,
 * missed-backup interval multipliers, AWS error surfacing (throttling, auth),
 * and the not-live/unwired structured-501 honesty cases.
 */
import { describe, expect, it } from "vitest";
import {
  AwsInfraProvider,
  DEFAULT_INSTANCE_BASELINE,
  InfraProviderError,
  infraLiveEnabled,
  patchSeverityBand,
  resolveInfraProvider,
  vendorPatchSeverityToBand,
  type AwsAcmCertificateDetail,
  type AwsBackupRecoveryPoint,
  type AwsInfraLiveClient,
  type AwsSsmInstanceInfo,
  type AwsSsmInstancePatchState,
  type AwsSsmMissingPatch,
  type InfraFindingRef,
  type InfraResourceRef,
} from "./index.js";

const NOW = new Date("2026-07-30T00:00:00Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** a fully-recording fake — every call is captured, every response is canned */
class FakeAwsInfraClient implements AwsInfraLiveClient {
  calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  instances: AwsSsmInstanceInfo[] = [];
  patchStates: AwsSsmInstancePatchState[] = [];
  missingPatches: Record<string, AwsSsmMissingPatch[]> = {};
  certs: AwsAcmCertificateDetail[] = [];
  recoveryPoints: AwsBackupRecoveryPoint[] = [];
  /** op name → error to throw when that op is hit (SDK-shaped) */
  failOn: Record<string, { name?: string; message: string; statusCode?: number }> = {};

  private hit(op: string, params: Record<string, unknown>): void {
    this.calls.push({ op, params });
    const f = this.failOn[op];
    if (f) {
      const err = new Error(f.message) as Error & { $metadata?: { httpStatusCode?: number } };
      if (f.name) err.name = f.name;
      if (f.statusCode !== undefined) err.$metadata = { httpStatusCode: f.statusCode };
      throw err;
    }
  }

  async assumeRole(p: { roleArn: string; roleSessionName: string; durationSeconds: number; region: string }) {
    this.hit("assumeRole", p);
    return { sessionId: `AROA:${p.roleSessionName}` };
  }
  async describeInstanceInformation(p: { region: string; sessionId: string }) {
    this.hit("describeInstanceInformation", p);
    return this.instances;
  }
  async describeInstancePatchStates(p: { region: string; sessionId: string; instanceIds: string[] }) {
    this.hit("describeInstancePatchStates", p);
    return this.patchStates;
  }
  async describeInstanceMissingPatches(p: { region: string; sessionId: string; instanceId: string }) {
    this.hit("describeInstanceMissingPatches", p);
    return this.missingPatches[p.instanceId] ?? [];
  }
  async listCertificates(p: { region: string; sessionId: string }) {
    this.hit("listCertificates", p);
    return this.certs.map((c) => ({ certificateArn: c.certificateArn, domainName: c.domainName ?? null }));
  }
  async describeCertificate(p: { region: string; sessionId: string; certificateArn: string }) {
    this.hit("describeCertificate", p);
    const cert = this.certs.find((c) => c.certificateArn === p.certificateArn);
    if (!cert) throw new Error(`no such cert ${p.certificateArn}`);
    return cert;
  }
  async listRecoveryPoints(p: { region: string; sessionId: string; backupVaultName: string; resourceArn?: string }) {
    this.hit("listRecoveryPoints", p);
    return this.recoveryPoints;
  }
  async runPatchBaseline(p: { region: string; sessionId: string; instanceIds: string[] }) {
    this.hit("runPatchBaseline", p);
    return { commandId: "cmd-0123456789" };
  }
  async renewCertificate(p: { region: string; sessionId: string; certificateArn: string }) {
    this.hit("renewCertificate", p);
  }
  async startBackupJob(p: {
    region: string;
    sessionId: string;
    backupVaultName: string;
    resourceArn: string;
    iamRoleArn: string;
  }) {
    this.hit("startBackupJob", p);
    return { backupJobId: "bj-42" };
  }
}

const ROLE = "arn:aws:iam::123456789012:role/regulait-infra";

function provider(client?: FakeAwsInfraClient, opts: { live?: boolean } = {}): AwsInfraProvider {
  return new AwsInfraProvider({
    roleArn: ROLE,
    region: "us-east-1",
    ...(client ? { client } : {}),
    live: opts.live ?? true,
    now: () => NOW,
  });
}

const res = (kind: InfraResourceRef["kind"], config: Record<string, unknown> = {}): InfraResourceRef => ({
  id: `res-${kind}`,
  kind,
  name: `aws-${kind}`,
  config,
});

const onlineInstance = (id: string): AwsSsmInstanceInfo => ({
  instanceId: id,
  pingStatus: "Online",
  isLatestVersion: true,
  associationStatus: "Success",
  agentVersion: "3.3.0",
});

const cleanPatchState = (id: string): AwsSsmInstancePatchState => ({
  instanceId: id,
  missingCount: 0,
  failedCount: 0,
  criticalNonCompliantCount: 0,
  securityNonCompliantCount: 0,
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

describe("aws scan — drift via ssm:DescribeInstanceInformation", () => {
  it("detects drift: offline instance with a stale agent → medium (2 keys), observed values are the real SSM fields", async () => {
    const client = new FakeAwsInfraClient();
    client.instances = [
      { instanceId: "i-bad", pingStatus: "ConnectionLost", isLatestVersion: false, associationStatus: "Success" },
    ];
    client.patchStates = [cleanPatchState("i-bad")];
    const findings = await provider(client).scan(res("control_plane"));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.kind).toBe("drift");
    expect(f.severity).toBe("medium");
    expect(f.signature).toBe("drift:i-bad");
    expect(f.detail.drifted).toEqual(["is_latest_agent", "ping_status"]);
    expect((f.detail.observed as Record<string, unknown>).ping_status).toBe("ConnectionLost");
    expect((f.detail.observed as Record<string, unknown>).is_latest_agent).toBe(false);
  });

  it("clean fleet (online, latest agent, associations applied, patch-compliant) → zero findings", async () => {
    const client = new FakeAwsInfraClient();
    client.instances = [onlineInstance("i-1"), onlineInstance("i-2")];
    client.patchStates = [cleanPatchState("i-1"), cleanPatchState("i-2")];
    const findings = await provider(client).scan(res("agent_runtime"));
    expect(findings).toEqual([]);
  });

  it("declared-baseline keys SSM cannot observe are reported as unassessable, never counted as drift", async () => {
    const client = new FakeAwsInfraClient();
    client.instances = [onlineInstance("i-1")];
    client.patchStates = [cleanPatchState("i-1")];
    const findings = await provider(client).scan(
      res("control_plane", { baseline: { ...DEFAULT_INSTANCE_BASELINE, kernel_hardening: "cis-l2" } }),
    );
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.kind).toBe("drift");
    expect(f.severity).toBe("low"); // a visibility gap, not an observed deviation
    expect(f.detail.drifted).toEqual([]);
    expect(f.detail.unassessableKeys).toEqual(["kernel_hardening"]);
  });

  it("zero managed instances is an honest error, never a fake clean scan", async () => {
    const client = new FakeAwsInfraClient();
    client.instances = [];
    const err = await rejection(provider(client).scan(res("control_plane")));
    expect(err.message).toContain("no managed instances");
    expect(err.message).toContain("not the same as clean");
  });
});

// ---------------------------------------------------------------------------
// CVE posture + severity banding
// ---------------------------------------------------------------------------

function cveScanClient(patch: AwsSsmMissingPatch): FakeAwsInfraClient {
  const client = new FakeAwsInfraClient();
  client.instances = [onlineInstance("i-1")];
  client.patchStates = [{ ...cleanPatchState("i-1"), missingCount: 1 }];
  client.missingPatches = { "i-1": [patch] };
  return client;
}

describe("aws scan — CVE severity banding at the CVSS boundaries (9/7/4)", () => {
  it.each([
    [9.0, "critical"],
    [8.9, "high"],
    [7.0, "high"],
    [6.9, "medium"],
    [4.0, "medium"],
    [3.9, "low"],
  ])("cvssBaseScore %s → %s (severitySource: cvss)", async (cvss, expected) => {
    const client = cveScanClient({
      state: "Missing",
      title: "kernel security update",
      severity: "Low", // deliberately contradicts the CVSS — CVSS must win
      cveIds: ["CVE-2026-1111"],
      cvssBaseScore: cvss as number,
    });
    const findings = await provider(client).scan(res("control_plane"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("cve");
    expect(findings[0]!.signature).toBe("cve:CVE-2026-1111");
    expect(findings[0]!.severity).toBe(expected);
    expect(findings[0]!.detail.severitySource).toBe("cvss");
    expect(findings[0]!.detail.cvssBaseScore).toBe(cvss);
  });

  it.each([
    ["Critical", "critical"],
    ["Important", "high"],
    ["Moderate", "medium"],
    ["Low", "low"],
  ])("no CVSS available → vendor severity '%s' maps to %s (severitySource: vendor)", async (vendor, expected) => {
    const client = cveScanClient({
      state: "Missing",
      kbId: "KB5031234",
      severity: vendor as string,
      cveIds: ["CVE-2026-2222"],
    });
    const findings = await provider(client).scan(res("control_plane"));
    expect(findings[0]!.severity).toBe(expected);
    expect(findings[0]!.detail.severitySource).toBe("vendor");
    expect(findings[0]!.detail.vendorSeverity).toBe(vendor);
  });

  it("neither CVSS nor a recognizable vendor severity → medium, explicitly tagged severitySource:default", async () => {
    const client = cveScanClient({ state: "Missing", title: "mystery patch", cveIds: ["CVE-2026-3333"] });
    const findings = await provider(client).scan(res("control_plane"));
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.detail.severitySource).toBe("default");
    // and the pure helpers agree
    expect(vendorPatchSeverityToBand("Unspecified")).toBeNull();
    expect(patchSeverityBand({ state: "Missing" })).toEqual({ severity: "medium", severitySource: "default" });
  });

  it("the same CVE missing on two instances aggregates into ONE finding at the max severity", async () => {
    const client = new FakeAwsInfraClient();
    client.instances = [onlineInstance("i-1"), onlineInstance("i-2")];
    client.patchStates = [
      { ...cleanPatchState("i-1"), missingCount: 1 },
      { ...cleanPatchState("i-2"), missingCount: 1 },
    ];
    client.missingPatches = {
      "i-1": [{ state: "Missing", cveIds: ["CVE-2026-4444"], cvssBaseScore: 5.0 }],
      "i-2": [{ state: "Missing", cveIds: ["CVE-2026-4444"], cvssBaseScore: 7.5 }],
    };
    const findings = await provider(client).scan(res("agent_runtime"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.signature).toBe("cve:CVE-2026-4444");
    expect(findings[0]!.severity).toBe("high"); // max(5.0→medium, 7.5→high)
    expect(findings[0]!.detail.instanceIds).toEqual(["i-1", "i-2"]);
  });

  it.each([
    [{ criticalNonCompliantCount: 2 }, "critical"],
    [{ securityNonCompliantCount: 1 }, "high"],
    [{}, "medium"],
  ])(
    "non-compliant counters with no per-patch detail → honest counter-banded summary finding (%o → %s)",
    async (counters, expected) => {
      const client = new FakeAwsInfraClient();
      client.instances = [onlineInstance("i-1")];
      client.patchStates = [{ ...cleanPatchState("i-1"), missingCount: 3, ...(counters as object) }];
      client.missingPatches = {}; // DescribeInstancePatches has nothing
      const findings = await provider(client).scan(res("control_plane"));
      expect(findings).toHaveLength(1);
      expect(findings[0]!.signature).toBe("cve:patch-state:i-1");
      expect(findings[0]!.severity).toBe(expected);
      expect(findings[0]!.detail.severitySource).toBe("patch-state-counters");
      expect(findings[0]!.detail.summary).toContain("no per-patch detail");
    },
  );
});

// ---------------------------------------------------------------------------
// certs
// ---------------------------------------------------------------------------

function certClient(daysUntilExpiry: number | null, extra: Partial<AwsAcmCertificateDetail> = {}): FakeAwsInfraClient {
  const client = new FakeAwsInfraClient();
  client.certs = [
    {
      certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc",
      domainName: "api.example.com",
      issuer: "Amazon",
      serial: "01:23:45",
      status: daysUntilExpiry === null ? "PENDING_VALIDATION" : "ISSUED",
      renewalEligibility: "ELIGIBLE",
      ...(daysUntilExpiry !== null ? { notAfter: new Date(NOW.getTime() + daysUntilExpiry * DAY) } : {}),
      ...extra,
    },
  ];
  return client;
}

describe("aws scan — cert expiry banding via acm (0/14/30-day bands)", () => {
  it.each([
    [-1, "critical"],
    [0, "critical"],
    [7, "high"],
    [13, "high"],
    [14, "medium"],
    [29, "medium"],
    [30, "low"], // inside the default 30-day rotation window → still reported
  ])("notAfter in %s day(s) → %s", async (days, expected) => {
    const findings = await provider(certClient(days as number)).scan(res("cert"));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.kind).toBe("cert_expiring");
    expect(f.severity).toBe(expected);
    expect(f.signature).toBe("cert_expiring:api.example.com");
    expect(f.detail.daysUntilExpiry).toBe(days);
    // every mapped field is the real ACM response field
    expect(f.detail.commonName).toBe("api.example.com");
    expect(f.detail.issuer).toBe("Amazon");
    expect(f.detail.serial).toBe("01:23:45");
  });

  it("a comfortably-valid cert (90 days, 30-day window) yields no finding", async () => {
    expect(await provider(certClient(90)).scan(res("cert"))).toEqual([]);
  });

  it("a PENDING_VALIDATION cert with no NotAfter is skipped — no invented expiry, no finding", async () => {
    expect(await provider(certClient(null)).scan(res("cert"))).toEqual([]);
  });

  it("mixed inventory: only the expiring cert of two produces a finding", async () => {
    const client = certClient(5);
    client.certs.push({
      certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/healthy",
      domainName: "ok.example.com",
      notAfter: new Date(NOW.getTime() + 200 * DAY),
      status: "ISSUED",
    });
    const findings = await provider(client).scan(res("cert"));
    expect(findings.map((f) => f.signature)).toEqual(["cert_expiring:api.example.com"]);
  });
});

// ---------------------------------------------------------------------------
// backups
// ---------------------------------------------------------------------------

function backupClient(points: AwsBackupRecoveryPoint[]): FakeAwsInfraClient {
  const client = new FakeAwsInfraClient();
  client.recoveryPoints = points;
  return client;
}

const completedPoint = (hoursAgo: number, arn = `rp-${hoursAgo}h`): AwsBackupRecoveryPoint => ({
  recoveryPointArn: arn,
  status: "COMPLETED",
  completionDate: new Date(NOW.getTime() - hoursAgo * HOUR),
});

describe("aws scan — missed-backup interval multipliers via backup recovery points", () => {
  it.each([
    [2, null], // < 1 interval: on schedule, no finding
    [30, "medium"], // >= 1x daily interval: due
    [100, "high"], // >= 3x daily interval
  ])("daily schedule, last COMPLETED point %sh ago → %s", async (hours, expected) => {
    const findings = await provider(backupClient([completedPoint(hours as number)])).scan(
      res("backup_target", { backupSchedule: "daily" }),
    );
    if (expected === null) {
      expect(findings).toEqual([]);
    } else {
      expect(findings).toHaveLength(1);
      expect(findings[0]!.kind).toBe("backup_missed");
      expect(findings[0]!.severity).toBe(expected);
    }
  });

  it.each([
    [8, "medium", false], // 8d on weekly: due (>=1x), not missed (<2x)
    [22, "high", true], // 22d on weekly: >=3x → high, missed
  ])("weekly schedule multipliers: last backup %s day(s) ago → %s", async (days, expected, missed) => {
    const findings = await provider(backupClient([completedPoint((days as number) * 24)])).scan(
      res("backup_target", { backupSchedule: "weekly" }),
    );
    expect(findings[0]!.severity).toBe(expected);
    expect(findings[0]!.detail.missed).toBe(missed);
  });

  it("no COMPLETED recovery point at all (only PARTIAL) → high, lastBackupAt honestly null", async () => {
    const findings = await provider(
      backupClient([{ recoveryPointArn: "rp-partial", status: "PARTIAL", completionDate: NOW }]),
    ).scan(res("backup_target", {}));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.detail.lastBackupAt).toBeNull();
    expect(findings[0]!.detail.recoveryPointCount).toBe(1);
    expect(findings[0]!.detail.completedCount).toBe(0);
  });

  it("picks the NEWEST completed point and reports its real arn + retention window", async () => {
    const findings = await provider(
      backupClient([completedPoint(80, "rp-old"), completedPoint(40, "rp-new")]),
    ).scan(res("backup_target", { retentionDays: 10 }));
    expect(findings[0]!.detail.lastRecoveryPointArn).toBe("rp-new");
    expect(findings[0]!.detail.lastBackupAt).toBe(new Date(NOW.getTime() - 40 * HOUR).toISOString());
    expect(findings[0]!.detail.retentionUntil).toBe(new Date(NOW.getTime() + 10 * DAY).toISOString());
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

describe("aws remediate — one real governed action per finding kind", () => {
  it("cve → ssm:SendCommand AWS-RunPatchBaseline against the finding's instance set", async () => {
    const client = new FakeAwsInfraClient();
    const result = await provider(client).remediate(findingRef("cve", { instanceIds: ["i-1", "i-2"] }));
    expect(result.ok).toBe(true);
    expect(result.detail.action).toBe("applied vendor patch");
    expect(result.detail.commandId).toBe("cmd-0123456789");
    const call = client.calls.find((c) => c.op === "runPatchBaseline");
    expect(call?.params.instanceIds).toEqual(["i-1", "i-2"]);
  });

  it("cve without instanceIds in the finding detail refuses honestly (no guessing at a patch target)", async () => {
    const client = new FakeAwsInfraClient();
    const err = await rejection(provider(client).remediate(findingRef("cve", {})));
    expect(err.message).toContain("instanceIds");
    expect(client.calls.some((c) => c.op === "runPatchBaseline")).toBe(false);
  });

  it("cert_expiring (ELIGIBLE) → acm:RenewCertificate on the finding's certificateArn", async () => {
    const client = new FakeAwsInfraClient();
    const result = await provider(client).remediate(
      findingRef("cert_expiring", { certificateArn: "arn:cert/abc", renewalEligibility: "ELIGIBLE" }),
    );
    expect(result.ok).toBe(true);
    expect(result.detail.action).toBe("rotated certificate");
    expect(client.calls.find((c) => c.op === "renewCertificate")?.params.certificateArn).toBe("arn:cert/abc");
  });

  it("cert_expiring INELIGIBLE (imported cert) → structured 501, renewCertificate never called", async () => {
    const client = new FakeAwsInfraClient();
    const err = await rejection(
      provider(client).remediate(
        findingRef("cert_expiring", { certificateArn: "arn:cert/imp", renewalEligibility: "INELIGIBLE" }),
      ),
    );
    expect(err.status).toBe(501);
    expect(err.message).toContain("INELIGIBLE");
    expect(client.calls.some((c) => c.op === "renewCertificate")).toBe(false);
  });

  it("backup_missed → backup:StartBackupJob with vault/resource/iamRole from the finding", async () => {
    const client = new FakeAwsInfraClient();
    const result = await provider(client).remediate(
      findingRef("backup_missed", {
        backupVaultName: "vault-1",
        resourceArn: "arn:aws:rds:us-east-1:123456789012:db:main",
        iamRoleArn: "arn:aws:iam::123456789012:role/backup",
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.detail.action).toBe("triggered out-of-band backup");
    expect(result.detail.backupJobId).toBe("bj-42");
    expect(client.calls.find((c) => c.op === "startBackupJob")?.params.backupVaultName).toBe("vault-1");
  });

  it("backup_missed with no iamRoleArn refuses honestly and names the missing fields", async () => {
    const client = new FakeAwsInfraClient();
    const err = await rejection(
      provider(client).remediate(findingRef("backup_missed", { backupVaultName: "vault-1" })),
    );
    expect(err.message).toContain("resourceArn");
    expect(err.message).toContain("iamRoleArn");
    expect(client.calls.some((c) => c.op === "startBackupJob")).toBe(false);
  });

  it("drift remediation is honestly unsupported (IaC's job) — structured 501, no mutation attempted", async () => {
    const client = new FakeAwsInfraClient();
    const err = await rejection(provider(client).remediate(findingRef("drift", { instanceId: "i-1" })));
    expect(err.status).toBe(501);
    expect(err.message).toContain("not supported");
    // only the assume-role handshake happened — nothing was mutated
    expect(client.calls.map((c) => c.op)).toEqual(["assumeRole"]);
  });
});

// ---------------------------------------------------------------------------
// error surfacing + the not-live honesty gate
// ---------------------------------------------------------------------------

describe("aws — API errors surface as typed InfraProviderError with the real status", () => {
  it("throttling (429) on DescribeInstanceInformation surfaces name, message, and status", async () => {
    const client = new FakeAwsInfraClient();
    client.instances = [onlineInstance("i-1")];
    client.failOn.describeInstanceInformation = {
      name: "ThrottlingException",
      message: "Rate exceeded",
      statusCode: 429,
    };
    const err = await rejection(provider(client).scan(res("control_plane")));
    expect(err.status).toBe(429);
    expect(err.message).toContain("ThrottlingException");
    expect(err.message).toContain("ssm:DescribeInstanceInformation");
  });

  it("auth failure (403) on sts:AssumeRole surfaces before any scan call is made", async () => {
    const client = new FakeAwsInfraClient();
    client.failOn.assumeRole = {
      name: "AccessDenied",
      message: "User is not authorized to perform: sts:AssumeRole",
      statusCode: 403,
    };
    const err = await rejection(provider(client).scan(res("cert")));
    expect(err.status).toBe(403);
    expect(err.message).toContain("sts:AssumeRole");
    expect(client.calls).toHaveLength(1); // assumeRole only — nothing else ran
  });

  it("threads the assumed session id through every subsequent call (short-lived creds, never static keys)", async () => {
    const client = new FakeAwsInfraClient();
    client.certs = [];
    await provider(client).scan(res("cert"));
    const [assume, list] = client.calls;
    expect(assume!.op).toBe("assumeRole");
    expect(assume!.params.roleArn).toBe(ROLE);
    expect(assume!.params.durationSeconds).toBe(3600);
    expect(list!.params.sessionId).toBe(`AROA:${assume!.params.roleSessionName as string}`);
  });
});

describe("aws — structured not-live results, never fake success", () => {
  it("live flag off → scan is a structured 501 naming REGULAIT_INFRA_LIVE; the client is never touched", async () => {
    const client = new FakeAwsInfraClient();
    const err = await rejection(provider(client, { live: false }).scan(res("control_plane")));
    expect(err.status).toBe(501);
    expect(err.message).toContain("REGULAIT_INFRA_LIVE");
    expect(client.calls).toHaveLength(0);
  });

  it("live flag on but NO client injected → structured 501 (never a silent stub), for scan and remediate", async () => {
    const p = provider(undefined, { live: true });
    const scanErr = await rejection(p.scan(res("cert")));
    expect(scanErr.status).toBe(501);
    expect(scanErr.message).toContain("no live AWS infra client was injected");
    const remErr = await rejection(p.remediate(findingRef("cve", { instanceIds: ["i-1"] })));
    expect(remErr.status).toBe(501);
  });

  it("missing roleArn/region is rejected before anything runs", async () => {
    const p = new AwsInfraProvider({ roleArn: "", region: "", client: new FakeAwsInfraClient(), live: true });
    const err = await rejection(p.scan(res("cert")));
    expect(err.message).toContain("roleArn and region");
  });

  it("registry: flag on + injected client resolves a working aws adapter; flag on without a client stays 501", async () => {
    expect(infraLiveEnabled({})).toBe(false);
    expect(infraLiveEnabled({ REGULAIT_INFRA_LIVE: "1" })).toBe(true);
    const prev = process.env.REGULAIT_INFRA_LIVE;
    process.env.REGULAIT_INFRA_LIVE = "1";
    try {
      expect(() => resolveInfraProvider({ kind: "aws", roleArn: ROLE, region: "us-east-1" })).toThrowError(
        /no live AWS infra client was injected/,
      );
      const client = new FakeAwsInfraClient();
      client.certs = [];
      const p = resolveInfraProvider({
        kind: "aws",
        roleArn: ROLE,
        region: "us-east-1",
        awsLiveClient: client,
      });
      expect(p.kind).toBe("aws");
      expect(await p.scan(res("cert"))).toEqual([]);
      expect(client.calls.map((c) => c.op)).toEqual(["assumeRole", "listCertificates"]);
    } finally {
      if (prev === undefined) delete process.env.REGULAIT_INFRA_LIVE;
      else process.env.REGULAIT_INFRA_LIVE = prev;
    }
  });
});
