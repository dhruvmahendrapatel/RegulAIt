import { describe, expect, it } from "vitest";
import {
  EMPTY_ATTESTATION,
  attestableControls,
  attestationBody,
  attestationLapsed,
  scopeWords,
  type PackControl,
} from "./packRecordsModel";

const control = (ref: string, attestationRequired: boolean): PackControl => ({
  id: ref,
  controlRef: ref,
  title: ref,
  description: null,
  coverage: attestationRequired ? "unaddressed" : "enforced",
  collector: attestationRequired ? "none" : "audit_decisions",
  collectorParams: {},
  minEvidenceCount: 1,
  attestationRequired,
  ownerNote: null,
});

describe("compliance pack attestations", () => {
  it("offers only organisational controls", () => {
    expect(attestableControls([control("a", false), control("b", true)]).map((c) => c.controlRef)).toEqual(["b"]);
  });

  it("builds the strict attestation body the gateway accepts", async () => {
    const shared = await import(new URL("../../../../../../packages/shared/src/compliance-packs.ts", import.meta.url).pathname);
    const built = attestationBody(
      { controlRef: "acme:9.9", statement: " Staff trained. ", evidenceRef: " LMS Q3 ", validUntil: "2027-01-31" },
      "2026-10-12",
    );
    expect(built).toEqual({
      ok: true,
      body: { controlRef: "acme:9.9", statement: "Staff trained.", evidenceRef: "LMS Q3", validUntil: "2027-01-31T23:59:59.000Z" },
    });
    expect(built.ok && shared.packAttestationSchema.safeParse(built.body).success).toBe(true);
    const bare = attestationBody({ ...EMPTY_ATTESTATION, controlRef: "x", statement: "y" });
    expect(bare).toEqual({ ok: true, body: { controlRef: "x", statement: "y" } });
    expect(bare.ok && shared.packAttestationSchema.safeParse(bare.body).success).toBe(true);
  });

  it("says what is missing or wrong", () => {
    expect(attestationBody(EMPTY_ATTESTATION)).toMatchObject({ ok: false });
    expect(attestationBody({ ...EMPTY_ATTESTATION, controlRef: "x" })).toMatchObject({ ok: false });
    expect(attestationBody({ ...EMPTY_ATTESTATION, controlRef: "x", statement: "s".repeat(4001) })).toMatchObject({ ok: false });
    expect(attestationBody({ ...EMPTY_ATTESTATION, controlRef: "x", statement: "y", validUntil: "2026-01-01" }, "2026-10-12")).toEqual({
      ok: false,
      problem: "The valid-until date is in the past.",
    });
  });

  it("an expired attestation reads as lapsed; one with no expiry never does", () => {
    const base = { id: "1", controlRef: "x", statement: "s", evidenceRef: null, attestedByUserId: null, attestedAt: "2026-01-01T00:00:00.000Z" };
    expect(attestationLapsed({ ...base, validUntil: "2026-02-01T00:00:00.000Z" }, Date.parse("2026-10-12T00:00:00Z"))).toBe(true);
    expect(attestationLapsed({ ...base, validUntil: null })).toBe(false);
  });

  it("names a report's scope", () => {
    expect(scopeWords({ entitlementScope: "org", effectiveProjectIds: null })).toBe("organisation-wide");
    expect(scopeWords({ entitlementScope: "team", effectiveProjectIds: ["a", "b"] })).toBe("2 projects (team)");
  });
});
