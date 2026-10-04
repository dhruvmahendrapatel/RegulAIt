/**
 * ADR-0175 batch D2 remainder, pure half:
 *   A7  credential inventory flags and the `stale_credentials` monitor rule
 *   A15 the energy and emissions estimate (unknown is never zero)
 */
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_TYPES,
  credentialFlags,
  rotationAgeDays,
  type CredentialRecord,
} from "./credential-inventory.js";
import { MONITOR_RULES, evaluateMonitorRules, reconcileAlerts, type MonitorInput } from "./governance-monitor.js";
import { proposeRemediations } from "./remediation.js";
import { estimateEnergy, type EnergyFactorInput } from "./energy-estimate.js";

const NOW = new Date("2026-10-04T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const rec = (over: Partial<CredentialRecord> = {}): CredentialRecord => ({
  id: "api_key:k1",
  type: "api_key",
  name: "ci",
  ownerUserId: "u1",
  ownerKind: "owner",
  ownerDisabled: false,
  scope: "every entitlement of its owner",
  createdAt: daysAgo(10),
  lastUsedAt: daysAgo(1),
  expiresAt: daysAgo(-30),
  revokedAt: null,
  secretSetAt: daysAgo(10),
  overScoped: false,
  ...over,
});

describe("A7 credential flags", () => {
  it("a fresh, used, expiring, narrowly owned key carries no flag", () => {
    expect(credentialFlags(rec(), NOW, 90).flags).toEqual([]);
  });

  it("never_expires only for credentials issued here; a held third-party secret's expiry is not tracked", () => {
    expect(credentialFlags(rec({ expiresAt: null }), NOW, 90).flags).toEqual(["never_expires"]);
    expect(credentialFlags(rec({ type: "scim_token", expiresAt: null }), NOW, 90).flags).toEqual(["never_expires"]);
    for (const type of ["model_credential", "git_token", "connector_credential", "oidc_client_secret", "pm_webhook_secret"] as const) {
      expect(credentialFlags(rec({ type, expiresAt: null, lastUsedAt: null, createdAt: daysAgo(5) }), NOW, 90).flags).toEqual([]);
    }
  });

  it("past_expiry when a tracked expiry has passed and nobody revoked it", () => {
    const r = credentialFlags(rec({ expiresAt: daysAgo(2) }), NOW, 90);
    expect(r.flags).toEqual(["past_expiry"]);
    expect(r.reasons.past_expiry).toMatch(/never revoked/);
  });

  it("unused: older than N days with no use in N days; never for a type with no last-used signal", () => {
    expect(credentialFlags(rec({ createdAt: daysAgo(200), lastUsedAt: daysAgo(120) }), NOW, 90).flags).toEqual(["unused"]);
    expect(credentialFlags(rec({ createdAt: daysAgo(200), lastUsedAt: null }), NOW, 90).flags).toEqual(["unused"]);
    // younger than the threshold: not judged
    expect(credentialFlags(rec({ createdAt: daysAgo(30), lastUsedAt: null }), NOW, 90).flags).toEqual([]);
    // the threshold is the org's
    expect(credentialFlags(rec({ createdAt: daysAgo(40), lastUsedAt: daysAgo(35) }), NOW, 30).flags).toEqual(["unused"]);
    // unobservable is said, never counted as unused
    expect(CREDENTIAL_TYPES.model_credential.lastUsed).toBe("none");
    expect(credentialFlags(rec({ type: "model_credential", createdAt: daysAgo(400), lastUsedAt: null, expiresAt: null }), NOW, 90).flags).toEqual([]);
  });

  it("owner_deactivated names whether it was the owner or the creator", () => {
    expect(credentialFlags(rec({ ownerDisabled: true }), NOW, 90).reasons.owner_deactivated).toBe("its owner is deactivated");
    expect(
      credentialFlags(rec({ type: "custom_provider_key", ownerKind: "creator", ownerDisabled: true, expiresAt: null }), NOW, 90).reasons
        .owner_deactivated,
    ).toMatch(/created it/);
  });

  it("over_scoped only where the type defines it", () => {
    expect(credentialFlags(rec({ overScoped: true }), NOW, 90).flags).toEqual(["over_scoped"]);
    expect(credentialFlags(rec({ type: "virtual_key", overScoped: true }), NOW, 90).flags).toEqual(["over_scoped"]);
    // a type with no over-scope rule is never flagged, whatever the record says
    expect(credentialFlags(rec({ type: "scim_token", overScoped: true, expiresAt: daysAgo(-1) }), NOW, 90).flags).toEqual([]);
  });

  it("a revoked credential carries no flag", () => {
    expect(credentialFlags(rec({ revokedAt: daysAgo(1), expiresAt: null, ownerDisabled: true }), NOW, 90).flags).toEqual([]);
  });

  it("rotation age is from the last set date, else from creation", () => {
    expect(rotationAgeDays(rec({ createdAt: daysAgo(100), secretSetAt: daysAgo(7) }), NOW)).toBe(7);
    expect(rotationAgeDays(rec({ createdAt: daysAgo(100), secretSetAt: null }), NOW)).toBe(100);
  });
});

const base = (over: Partial<MonitorInput> = {}): MonitorInput => ({
  useCases: [],
  agents: new Map(),
  vendors: new Map(),
  risks: [],
  dimensions: [],
  ...over,
});
const flagged = {
  id: "virtual_key:v1",
  typeLabel: "Virtual key",
  name: "batch-jobs",
  flags: ["never_expires", "unused"],
  reasons: { never_expires: "no expiry", unused: "never used" },
  manageAt: "/admin/virtual-keys",
};

describe("A7 stale_credentials rule", () => {
  it("is medium, and raises one episode per flagged credential when alerting is on", () => {
    expect(MONITOR_RULES.stale_credentials.severity).toBe("medium");
    const f = evaluateMonitorRules(
      base({
        credentials: {
          alerting: true,
          credentials: [flagged, { ...flagged, id: "api_key:k2", typeLabel: "API key", name: "ci" }, { ...flagged, id: "api_key:k3", flags: [] }],
        },
      }),
    ).filter((x) => x.ruleId === "stale_credentials");
    expect(f.map((x) => x.subjectKey).sort()).toEqual(["credential:api_key:k2", "credential:virtual_key:v1"]);
    expect(f.find((x) => x.subjectKey === "credential:virtual_key:v1")).toMatchObject({
      severity: "medium",
      title: "Virtual key 'batch-jobs': never expires, unused",
      detail: { flags: ["never_expires", "unused"], manageAt: "/admin/virtual-keys" },
    });
  });

  it("observe-only (the default) raises nothing, and an open episode resolves", () => {
    const findings = evaluateMonitorRules(base({ credentials: { alerting: false, credentials: [flagged] } }));
    expect(findings.filter((x) => x.ruleId === "stale_credentials")).toEqual([]);
    const plan = reconcileAlerts([{ id: "a1", ruleId: "stale_credentials", subjectKey: "credential:virtual_key:v1" }], findings);
    expect(plan.resolve).toEqual(["a1"]);
  });

  it("proposes a guidance remediation that opens the credential's own page", () => {
    const [c] = proposeRemediations({
      alert: { ruleId: "stale_credentials", subjectKey: "credential:virtual_key:v1", detail: { credentialId: "virtual_key:v1", ...flagged } },
      risks: new Map(),
      activeControls: new Map(),
    });
    expect(c).toMatchObject({ kind: "review_credential", executable: false, href: "/admin/virtual-keys" });
    expect(c!.steps.join(" ")).toMatch(/never expires/);
  });
});

const factor = (subject: string, inW = 0.5, outW = 1.5, demo = false): EnergyFactorInput => ({
  subject,
  whPer1kInput: inW,
  whPer1kOutput: outW,
  sourceNote: "vendor sustainability report 2026",
  version: "2026-09",
  demo,
});

describe("A15 energy estimate", () => {
  it("multiplies ledger tokens by the model factor and the grid intensity, with its sources", () => {
    const e = estimateEnergy({
      windowDays: 30,
      usage: [{ model: "model-a", calls: 4, callsWithTokens: 4, inputTokens: 2000, outputTokens: 1000 }],
      factors: [factor("MODEL-A")],
      grid: { subject: "default", region: null, gCo2ePerKwh: 400, sourceNote: "grid operator 2025", version: "2025", demo: false },
    });
    // 2 × 0.5 + 1 × 1.5 = 2.5 Wh; 0.0025 kWh × 400 = 1 g
    expect(e).toMatchObject({ energyWh: 2.5, emissionsG: 1, callsEstimated: 4, callsTotal: 4, coverage: "4 of 4 calls estimated" });
    expect(e.label).toMatch(/^Estimate/);
    expect(e.byModel[0]!.factor).toMatchObject({ sourceNote: "vendor sustainability report 2026", version: "2026-09" });
  });

  it("a model with no factor is unknown, never zero, and the totals say how many calls were estimated", () => {
    const e = estimateEnergy({
      windowDays: 7,
      usage: [
        { model: "model-a", calls: 3, callsWithTokens: 3, inputTokens: 1000, outputTokens: 1000 },
        { model: "model-b", calls: 5, callsWithTokens: 5, inputTokens: 9000, outputTokens: 9000 },
      ],
      factors: [factor("model-a")],
      grid: null,
    });
    expect(e.coverage).toBe("3 of 8 calls estimated");
    expect(e.unknownModels).toEqual(["model-b"]);
    expect(e.byModel.find((m) => m.model === "model-b")).toMatchObject({ energyWh: null, status: "no_factor" });
    expect(e.energyWh).toBe(2);
    // no grid intensity: energy known, emissions unknown
    expect(e.emissionsG).toBeNull();
  });

  it("with no estimated call the totals are null, not 0", () => {
    const e = estimateEnergy({
      windowDays: 7,
      usage: [
        { model: "model-b", calls: 5, callsWithTokens: 5, inputTokens: 10, outputTokens: 10 },
        { model: "model-a", calls: 2, callsWithTokens: 0, inputTokens: 0, outputTokens: 0 },
      ],
      factors: [factor("model-a")],
      grid: { subject: "default", region: null, gCo2ePerKwh: 400, sourceNote: "s", version: "v", demo: false },
    });
    expect(e.energyWh).toBeNull();
    expect(e.emissionsG).toBeNull();
    expect(e.coverage).toBe("0 of 7 calls estimated");
    expect(e.byModel.find((m) => m.model === "model-a")!.status).toBe("no_tokens");
    // an empty window is unknown too
    expect(estimateEnergy({ windowDays: 7, usage: [], factors: [], grid: null }).energyWh).toBeNull();
  });

  it("a call whose tokens were not recorded is unknown even when its model has a factor", () => {
    const e = estimateEnergy({
      windowDays: 7,
      usage: [{ model: "model-a", calls: 3, callsWithTokens: 2, inputTokens: 2000, outputTokens: 0 }],
      factors: [factor("model-a")],
      grid: null,
    });
    expect(e).toMatchObject({ callsEstimated: 2, callsUnknown: 1, coverage: "2 of 3 calls estimated", energyWh: 1 });
  });

  it("says when a demo factor was used", () => {
    const e = estimateEnergy({
      windowDays: 7,
      usage: [{ model: "mock-fast", calls: 1, callsWithTokens: 1, inputTokens: 1000, outputTokens: 0 }],
      factors: [factor("mock-fast", 1, 1, true)],
      grid: null,
    });
    expect(e.usesDemoFactors).toBe(true);
  });
});
