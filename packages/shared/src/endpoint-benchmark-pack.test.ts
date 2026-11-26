/**
 * ADR-0351 slice 3 — the CIS-style AI coding-agent endpoint benchmark pack.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COMPLIANCE_PACK_FRAMEWORKS,
  DEFAULT_COMPLIANCE_PACKS,
  ENDPOINT_BENCHMARK_CHECKS,
  EVIDENCE_COLLECTORS,
  createCompliancePackSchema,
  packControlSchema,
} from "./compliance-packs.js";
import { ENDPOINT_BENCHMARK_CONTROLS, ENDPOINT_BENCHMARK_FRAMEWORK, ENDPOINT_BENCHMARK_PACK, ENDPOINT_BENCHMARK_PACKS } from "./endpoint-benchmark-pack.js";
import { CONTROL_DIMENSION_OVERRIDES, dimensionForControl } from "./trust-dimensions.js";

const digest = (p: unknown) => createHash("sha256").update(JSON.stringify(p)).digest("hex");

describe("the pack", () => {
  it("parses, is seeded once, is in the picker vocabulary, and does not present itself as a CIS Benchmark", () => {
    createCompliancePackSchema.parse(ENDPOINT_BENCHMARK_PACK);
    expect(DEFAULT_COMPLIANCE_PACKS.filter((p) => p.framework === ENDPOINT_BENCHMARK_FRAMEWORK)).toHaveLength(1);
    expect(COMPLIANCE_PACK_FRAMEWORKS as readonly string[]).toContain(ENDPOINT_BENCHMARK_FRAMEWORK);
    expect(ENDPOINT_BENCHMARK_PACK.provenance.reviewedBy).toBeNull();
    expect(ENDPOINT_BENCHMARK_PACK.description).toMatch(/Not a CIS Benchmark/);
    expect(JSON.stringify(ENDPOINT_BENCHMARK_PACK.controls)).not.toMatch(/\b(compliant|conformant|certified)\b/i);
  });

  it("is laid out as numbered recommendations, each with a profile level", () => {
    for (const c of ENDPOINT_BENCHMARK_CONTROLS) {
      expect(c.controlRef).toMatch(new RegExp(`^${ENDPOINT_BENCHMARK_FRAMEWORK}:\\d\\.\\d-[a-z0-9-]+$`));
      expect(c.title).toMatch(/^\d\.\d \((L1|L2)\) — /);
    }
    expect(new Set(ENDPOINT_BENCHMARK_CONTROLS.map((c) => c.controlRef)).size).toBe(ENDPOINT_BENCHMARK_CONTROLS.length);
  });

  it("maps every recommendation to a real check, or says what to attest", () => {
    const checks = ENDPOINT_BENCHMARK_CONTROLS.filter((c) => c.collector === "endpoint_benchmark_check").map((c) => c.collectorParams?.endpointCheck);
    // every declared endpoint check is used, once
    expect([...checks].sort()).toEqual([...ENDPOINT_BENCHMARK_CHECKS].sort());
    for (const c of ENDPOINT_BENCHMARK_CONTROLS) {
      expect(EVIDENCE_COLLECTORS as readonly string[]).toContain(c.collector);
      if (c.collector === "none") {
        expect(c.attestationRequired).toBe(true);
        expect(c.ownerNote, c.controlRef).toMatch(/Attest/);
        expect(CONTROL_DIMENSION_OVERRIDES[c.controlRef]).toBe("security");
      } else {
        expect(c.attestationRequired).toBe(false);
        expect(c.coverage).not.toBe("unaddressed");
      }
    }
    expect(dimensionForControl({ controlRef: "x", collector: "endpoint_benchmark_check", collectorParams: { endpointCheck: "agent_keys_hardware" } })).toBe("security");
  });

  it("is pinned: a published version is never edited (ADR-0058)", () => {
    expect(Object.fromEntries(ENDPOINT_BENCHMARK_PACKS.map((p) => [`${p.framework}@${p.version}`, digest(p)]))).toEqual({
      // re-pinned before first release (R3 review on #961 changed the evidence text); @1 has never reached main
      "ai-coding-endpoint-benchmark@1": "c982bb51522c0d9eea365861bf1fb193a2adaa29d6d01d6f15cc4433c30926ed",
    });
  });
});

describe("the endpoint collector's params", () => {
  const base = { controlRef: "x:1", title: "t", coverage: "evidenced" as const, minEvidenceCount: 1, attestationRequired: false };
  it("needs a named check, from the closed list, and no other collector takes one", () => {
    expect(packControlSchema.safeParse({ ...base, collector: "endpoint_benchmark_check", collectorParams: { endpointCheck: "devices_reporting_7d" } }).success).toBe(true);
    expect(packControlSchema.safeParse({ ...base, collector: "endpoint_benchmark_check", collectorParams: {} }).success).toBe(false);
    expect(packControlSchema.safeParse({ ...base, collector: "endpoint_benchmark_check", collectorParams: { endpointCheck: "drop table" } }).success).toBe(false);
    expect(packControlSchema.safeParse({ ...base, collector: "audit_decisions", collectorParams: { endpointCheck: "devices_reporting_7d" } }).success).toBe(false);
  });
});
