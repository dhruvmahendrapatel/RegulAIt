import { describe, expect, it } from "vitest";
import {
  InfraProviderError,
  MockInfraProvider,
  certSeverity,
  compareDrift,
  cvssToSeverity,
  evaluateBackupSchedule,
  isInfraProviderKind,
  resolveInfraProvider,
  severityRank,
  type InfraResourceRef,
} from "./index.js";

const ref = (kind: InfraResourceRef["kind"], config: Record<string, unknown> = {}): InfraResourceRef => ({
  id: `res-${kind}`,
  kind,
  name: kind,
  config,
});

describe("mock scan — shape per resource kind", () => {
  it("a control_plane yields a medium drift and a high cve", async () => {
    const mock = new MockInfraProvider();
    const findings = await mock.scan(ref("control_plane"));
    expect(findings.map((f) => [f.kind, f.severity])).toEqual([
      ["drift", "medium"],
      ["cve", "high"],
    ]);
  });

  it("an agent_runtime yields a low drift (the auto-remediate candidate)", async () => {
    const mock = new MockInfraProvider();
    const findings = await mock.scan(ref("agent_runtime"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("drift");
    expect(findings[0]!.severity).toBe("low");
  });

  it("a cert's severity is derived from days-until-expiry, expired => critical", async () => {
    const mock = new MockInfraProvider();
    expect((await mock.scan(ref("cert", { daysUntilExpiry: 90 })))[0]!.severity).toBe("low");
    expect((await mock.scan(ref("cert", { daysUntilExpiry: 20 })))[0]!.severity).toBe("medium");
    expect((await mock.scan(ref("cert", { daysUntilExpiry: 7 })))[0]!.severity).toBe("high");
    expect((await mock.scan(ref("cert", { daysUntilExpiry: 0 })))[0]!.severity).toBe("critical");
    expect((await mock.scan(ref("cert", { daysUntilExpiry: -3 })))[0]!.severity).toBe("critical");
  });

  it("a backup_target's severity is derived from hours since last backup", async () => {
    const mock = new MockInfraProvider();
    expect((await mock.scan(ref("backup_target", { hoursSinceLastBackup: 2 })))[0]!.severity).toBe("low");
    expect((await mock.scan(ref("backup_target", { hoursSinceLastBackup: 30 })))[0]!.severity).toBe("medium");
    expect((await mock.scan(ref("backup_target", { hoursSinceLastBackup: 100 })))[0]!.severity).toBe("high");
  });
});

describe("mock scan — idempotent signatures", () => {
  it("re-scanning yields identical signatures per finding (natural key stable)", async () => {
    const mock = new MockInfraProvider();
    const a = await mock.scan(ref("cert", { daysUntilExpiry: 5 }));
    const b = await mock.scan(ref("cert", { daysUntilExpiry: 5 }));
    expect(a.map((f) => f.signature)).toEqual(b.map((f) => f.signature));
    // every finding carries its signature in detail too (so the gateway can
    // upsert on detail->>'signature')
    for (const f of a) expect(f.detail.signature).toBe(f.signature);
  });
});

describe("mock remediate — records the call and succeeds", () => {
  it("pushes one remediation per call and returns ok:true with an action", async () => {
    const mock = new MockInfraProvider();
    const res = await mock.remediate({
      id: "f1",
      resourceId: "res-cert",
      kind: "cert_expiring",
      signature: "cert_expiring:api-gw",
    });
    expect(res.ok).toBe(true);
    expect(res.detail.action).toBe("rotated certificate");
    expect(mock.remediations).toEqual([
      { resourceId: "res-cert", kind: "cert_expiring", signature: "cert_expiring:api-gw" },
    ]);
  });
});

describe("severity ordering", () => {
  it("critical outranks high outranks medium outranks low", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("high"));
    expect(severityRank("high")).toBeGreaterThan(severityRank("medium"));
    expect(severityRank("medium")).toBeGreaterThan(severityRank("low"));
  });
});

describe("registry", () => {
  it("resolves mock as a shared, keyless instance", () => {
    const a = resolveInfraProvider({ kind: "mock" });
    const b = resolveInfraProvider({ kind: "mock" });
    expect(a).toBe(b); // shared instance, recorded state persists across resolutions
    expect(a.kind).toBe("mock");
  });

  it("aws stays a structured 501 while REGULAIT_INFRA_LIVE is off (implemented, but never silently live)", () => {
    const err = (() => {
      try {
        resolveInfraProvider({ kind: "aws", roleArn: "arn:aws:iam::123456789012:role/x", region: "us-east-1" });
        return null;
      } catch (e) {
        return e as InfraProviderError;
      }
    })();
    expect(err).toBeInstanceOf(InfraProviderError);
    expect(err!.status).toBe(501);
    expect(err!.message).toContain("not live-enabled");
  });

  it("rejects declared-but-unimplemented cloud kinds explicitly (no silent promise)", () => {
    for (const kind of ["azure", "gcp"] as const) {
      const err = (() => {
        try {
          resolveInfraProvider({ kind, endpoint: "https://x.example", token: "t" });
          return null;
        } catch (e) {
          return e as InfraProviderError;
        }
      })();
      expect(err).toBeInstanceOf(InfraProviderError);
      expect(err!.status).toBe(501);
      expect(err!.message).toContain("not implemented yet");
    }
  });

  it("isInfraProviderKind guards the kind union", () => {
    expect(isInfraProviderKind("mock")).toBe(true);
    expect(isInfraProviderKind("aws")).toBe(true);
    expect(isInfraProviderKind("heroku")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ADR-0017 — the extracted pure detection math.
// ---------------------------------------------------------------------------

describe("compareDrift", () => {
  it("no diff => empty drifted + low", () => {
    expect(compareDrift({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual({ drifted: [], severity: "low" });
  });
  it("one key diff => low (sorted keys)", () => {
    expect(compareDrift({ a: 1 }, { a: 2 })).toEqual({ drifted: ["a"], severity: "low" });
  });
  it("two key diff => medium", () => {
    const r = compareDrift({ a: 1, b: 1, c: 1 }, { a: 2, b: 2, c: 1 });
    expect(r.drifted).toEqual(["a", "b"]);
    expect(r.severity).toBe("medium");
  });
  it("three or more key diff => high", () => {
    expect(compareDrift({ a: 1, b: 1, c: 1 }, { a: 2, b: 2, c: 2 }).severity).toBe("high");
  });
  it("a security-critical key drifting => high regardless of count", () => {
    expect(compareDrift({ iam: "x" }, { iam: "y" }).severity).toBe("high");
  });
  it("added / removed keys count as drift", () => {
    expect(compareDrift({ a: 1 }, { a: 1, b: 2 }).drifted).toEqual(["b"]);
  });
});

describe("cvssToSeverity — band boundaries", () => {
  it.each([
    [3.9, "low"],
    [4.0, "medium"],
    [6.9, "medium"],
    [7.0, "high"],
    [8.9, "high"],
    [9.0, "critical"],
  ])("cvss %s => %s", (cvss, sev) => {
    expect(cvssToSeverity(cvss as number)).toBe(sev);
  });
});

describe("certSeverity — real date math", () => {
  const now = new Date("2026-07-30T00:00:00Z");
  const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);
  it("already expired => critical + shouldRotate", () => {
    const r = certSeverity(inDays(-3), now, 30);
    expect(r.severity).toBe("critical");
    expect(r.shouldRotate).toBe(true);
    expect(r.daysUntilExpiry).toBe(-3);
  });
  it("expiring today (0 days) => critical + shouldRotate", () => {
    expect(certSeverity(now, now, 30).severity).toBe("critical");
  });
  it("inside the rotation window (7 days) => high + shouldRotate", () => {
    const r = certSeverity(inDays(7), now, 30);
    expect(r.severity).toBe("high");
    expect(r.shouldRotate).toBe(true);
  });
  it("20 days => medium, and shouldRotate under a 30-day window", () => {
    const r = certSeverity(inDays(20), now, 30);
    expect(r.severity).toBe("medium");
    expect(r.shouldRotate).toBe(true);
  });
  it("comfortable (90 days) => low + not shouldRotate", () => {
    const r = certSeverity(inDays(90), now, 30);
    expect(r.severity).toBe("low");
    expect(r.shouldRotate).toBe(false);
  });
});

describe("evaluateBackupSchedule", () => {
  const now = new Date("2026-07-30T00:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  it("fresh (2h, daily) => not due, not missed, low", () => {
    const r = evaluateBackupSchedule("daily", hoursAgo(2), now, 30);
    expect(r).toMatchObject({ due: false, missed: false, severity: "low" });
  });
  it("stale (30h, daily) => due, not missed, medium", () => {
    const r = evaluateBackupSchedule("daily-0200", hoursAgo(30), now, 30);
    expect(r).toMatchObject({ due: true, missed: false, severity: "medium" });
  });
  it("missed (100h, daily) => due, missed, high", () => {
    const r = evaluateBackupSchedule("daily", hoursAgo(100), now, 30);
    expect(r).toMatchObject({ due: true, missed: true, severity: "high" });
  });
  it("never backed up => due, missed, high", () => {
    const r = evaluateBackupSchedule("daily", null, now, 30);
    expect(r).toMatchObject({ due: true, missed: true, severity: "high" });
  });
  it("retentionUntil = now + retentionDays", () => {
    const r = evaluateBackupSchedule("daily", hoursAgo(2), now, 10);
    expect(r.retentionUntil.getTime()).toBe(now.getTime() + 10 * 86_400_000);
  });
});
