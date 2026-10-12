import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../../api/client";
import {
  EXECUTOR_REFUSALS,
  attestationRecordText,
  declaredClassBody,
  executorActs,
  executorRefusal,
  parseAttestationHistory,
  parseExecutor,
} from "./isolationModel";

const now = Date.parse("2026-10-12T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const record = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  profileDigest: "a".repeat(64),
  class: "user_space_kernel",
  verdict: "pass",
  reportSha256: "b".repeat(64),
  report: { probes: [] },
  observedAt: iso(now - 60_000),
  expiresAt: iso(now + 3_600_000),
  ...over,
});

describe("executor detail", () => {
  it("reads the single-executor view the same way as a list row", () => {
    const e = parseExecutor({
      executorId: "e1",
      name: "gvisor-a",
      backend: "gvisor",
      status: "quarantined",
      quarantineCode: "admin",
      classesDeclared: ["user_space_kernel"],
      attestations: [],
      runtimeVersion: "runsc",
      openOffers: 2,
    });
    expect(e).toMatchObject({ id: "e1", status: "quarantined", quarantineCode: "admin", openOffers: 2 });
    expect(parseExecutor({ executorId: "e1", name: "x", backend: "docker", status: "active", classesDeclared: [], attestations: [] })).toBeNull();
  });

  it("parses the attestation history and keeps an unreadable row as unreadable", () => {
    const out = parseAttestationHistory({ attestations: [record(), record({ verdict: "maybe" }), record({ id: "a3", verdict: "fail" })], attestationStrength: "software_attested" });
    expect(out).toHaveLength(3);
    expect(out![0]).toMatchObject({ id: "a1", isolationClass: "user_space_kernel", verdict: "pass" });
    expect(out![1]).toEqual({ unreadable: true, index: 1 });
    expect(out![2]).toMatchObject({ verdict: "fail" });
    expect(parseAttestationHistory({ items: [] })).toBeNull();
    expect(parseAttestationHistory({ attestations: "nope" })).toBeNull();
  });

  it("a pass counts only for a class the backend can attest, and only until it expires", () => {
    const parsed = parseAttestationHistory({ attestations: [record(), record({ id: "x", class: "microvm" }), record({ id: "y", expiresAt: iso(now - 1) })] })!;
    const [fresh, wrongClass, expired] = parsed as Array<Exclude<(typeof parsed)[number], { unreadable: true }>>;
    expect(attestationRecordText(fresh!, "gvisor", now)).toEqual({ label: "Passed", tone: "ok" });
    expect(attestationRecordText(wrongClass!, "gvisor", now).label).toBe("Not evidence for this backend");
    expect(attestationRecordText(expired!, "gvisor", now).label).toBe("Passed, expired");
    expect(attestationRecordText({ ...fresh!, verdict: "fail" }, "gvisor", now)).toEqual({ label: "Failed", tone: "danger" });
  });
});

describe("executor acts", () => {
  it("offers each act only where the gateway would accept it", () => {
    const active = executorActs({ status: "active", backend: "gvisor" });
    expect(active.quarantine.ok).toBe(true);
    expect(active.reenable.ok).toBe(false);
    expect(active.revoke.ok).toBe(true);
    expect(active.declared_class).toMatchObject({ ok: false, reason: expect.stringContaining("customer plane") });

    const quarantined = executorActs({ status: "quarantined", backend: "customer" });
    expect(quarantined.quarantine.ok).toBe(false);
    expect(quarantined.reenable.ok).toBe(true);
    expect(quarantined.revoke.ok).toBe(true);
    expect(quarantined.declared_class.ok).toBe(true);

    const revoked = executorActs({ status: "revoked", backend: "customer" });
    for (const act of Object.values(revoked)) expect(act).toMatchObject({ ok: false, reason: expect.stringContaining("terminal") });
  });

  it("the declared-class body is a requirable class or null, never anything else", () => {
    expect(declaredClassBody("")).toEqual({ class: null });
    expect(declaredClassBody("microvm")).toEqual({ class: "microvm" });
    expect(declaredClassBody("customer_declared")).toBeNull();
    expect(declaredClassBody("in_gateway")).toBeNull();
  });

  it("names the gateway's own refusal codes, and nothing it does not send", () => {
    const gateway = readFileSync(new URL("../../../../../../gateway/src/isolation-routes.ts", import.meta.url), "utf8");
    expect(Object.keys(EXECUTOR_REFUSALS).filter((code) => !gateway.includes(`error: "${code}"`))).toEqual([]);
    expect(executorRefusal(new ApiError(409, { error: "executor_not_quarantined", status: "active" }))).toMatch(/not quarantined/);
    expect(executorRefusal(new ApiError(500, { error: "internal" }))).toBeNull();
  });
});
