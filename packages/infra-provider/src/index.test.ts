import { describe, expect, it } from "vitest";
import {
  InfraProviderError,
  MockInfraProvider,
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

  it("rejects declared-but-unimplemented cloud kinds explicitly (no silent promise)", () => {
    for (const kind of ["aws", "azure", "gcp"] as const) {
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
