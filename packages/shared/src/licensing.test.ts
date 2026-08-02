import { describe, expect, it } from "vitest";
import {
  LICENSE_ACTION_INVENTORY,
  LICENSE_SCHEMA_ID,
  canonicalLicenseBytes,
  classifyAction,
  evaluateLicenseWindow,
  evaluateLicensedAction,
  evaluateSeatGrant,
  featureEnabled,
  installLicenseSchema,
  licenseDocumentSchema,
  type LicenseDocument,
} from "./licensing.js";

/**
 * ADR-0052's pure half, proved by attack.
 *
 * The four things this file is trying to make impossible:
 *
 *  1. A MISCATEGORISED ACTION. §Consequences says plainly that every
 *     enforcement point must correctly classify itself and that a
 *     miscategorised path is a real bug. The inventory is asserted directly:
 *     audit and policy evaluation must be `governance`, provisioning must be
 *     `expansion`, and an UNKNOWN action must default to `expansion` — the safe
 *     direction, because a new expansion path that quietly defaulted to
 *     `governance` would be an unlicensed hole.
 *  2. AN EXPIRED LICENSE THAT BRICKS A DEPLOYMENT. Past grace, governance and
 *     reads are asserted to still work while expansion is refused.
 *  3. AN ABSENT LICENSE THAT SILENTLY GRANTS A TIER. Absence permits
 *     governance and does not cap seats, but every tier feature is asserted
 *     CLOSED.
 *  4. SEAT ENFORCEMENT THAT PUNISHES THE WRONG PEOPLE. Going over cap refuses
 *     the NEXT grant and is asserted to say so; nothing in the decision can
 *     revoke an existing seat.
 */

function doc(over: Partial<LicenseDocument> = {}): LicenseDocument {
  return licenseDocumentSchema.parse({
    schema: LICENSE_SCHEMA_ID,
    licenseId: "lic-1",
    tenant: "acme",
    tier: "enterprise",
    seatCap: 10,
    features: ["sso_saml", "airgapped_mode"],
    deploymentMode: "airgapped",
    issuedAt: "2026-01-01T00:00:00.000Z",
    notBefore: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-07-01T00:00:00.000Z",
    graceDays: 30,
    ...over,
  });
}

const BEFORE = new Date("2025-12-01T00:00:00.000Z");
const DURING = new Date("2026-03-01T00:00:00.000Z");
const IN_GRACE = new Date("2026-07-10T00:00:00.000Z");
const PAST_GRACE = new Date("2026-09-01T00:00:00.000Z");

describe("the action-class inventory", () => {
  it("classifies the safety layer as governance and growth as expansion", () => {
    expect(classifyAction("policy.evaluate")).toBe("governance");
    expect(classifyAction("audit.write")).toBe("governance");
    expect(classifyAction("approval.decide")).toBe("governance");
    expect(classifyAction("agent.dispatch")).toBe("governance");
    expect(classifyAction("user.deactivate")).toBe("governance");
    expect(classifyAction("user.provision")).toBe("expansion");
    expect(classifyAction("agent.create")).toBe("expansion");
    expect(classifyAction("feature.tier_gated")).toBe("expansion");
    expect(classifyAction("audit.read")).toBe("read");
  });

  it("defaults an UNKNOWN action to expansion — the safe direction", () => {
    expect(classifyAction("something.nobody.classified")).toBe("expansion");
  });

  it("every inventory entry carries a stated reason", () => {
    expect(LICENSE_ACTION_INVENTORY.length).toBeGreaterThan(10);
    for (const e of LICENSE_ACTION_INVENTORY) expect(e.why.length).toBeGreaterThan(10);
  });
});

describe("the validity window", () => {
  it("resolves the four states off the host clock", () => {
    expect(evaluateLicenseWindow(doc(), BEFORE).state).toBe("not_yet_valid");
    expect(evaluateLicenseWindow(doc(), DURING).state).toBe("valid");
    expect(evaluateLicenseWindow(doc(), IN_GRACE).state).toBe("grace");
    expect(evaluateLicenseWindow(doc(), PAST_GRACE).state).toBe("expired");
  });

  it("a zero-day grace goes straight from valid to expired", () => {
    const d = doc({ graceDays: 0 });
    expect(evaluateLicenseWindow(d, new Date("2026-06-30T23:59:00.000Z")).state).toBe("valid");
    expect(evaluateLicenseWindow(d, new Date("2026-07-01T00:00:01.000Z")).state).toBe("expired");
  });

  it("names the grace end so a warning can be dated", () => {
    const w = evaluateLicenseWindow(doc(), IN_GRACE);
    expect(w.graceEndsAt).toBe("2026-07-31T00:00:00.000Z");
    expect(w.reason).toMatch(/grace window/);
  });
});

describe("the split posture on expiry", () => {
  const d = doc();

  it("READS are permitted in every state, including a hard stop", () => {
    for (const state of ["absent", "not_yet_valid", "valid", "grace", "expired"] as const) {
      expect(evaluateLicensedAction({ license: d, state, actionClass: "read" }).allowed, state).toBe(true);
    }
    expect(
      evaluateLicensedAction({
        license: doc({ hardStopOnExpiry: true }),
        state: "expired",
        actionClass: "read",
      }).allowed,
    ).toBe(true);
  });

  it("past grace, GOVERNANCE fails OPEN and EXPANSION fails CLOSED", () => {
    const gov = evaluateLicensedAction({ license: d, state: "expired", actionClass: "governance" });
    expect(gov.allowed).toBe(true);
    expect(gov.ruleId).toBe("license-expired-governance-fails-open");
    expect(gov.reason).toMatch(/never become an AI-governance outage/);

    const exp = evaluateLicensedAction({ license: d, state: "expired", actionClass: "expansion" });
    expect(exp.allowed).toBe(false);
    expect(exp.ruleId).toBe("license-expired-no-expansion");
    expect(exp.reason).toMatch(/frozen at its current committed footprint/);
  });

  it("inside the grace window everything still works", () => {
    expect(evaluateLicensedAction({ license: d, state: "grace", actionClass: "expansion" }).allowed).toBe(true);
    expect(evaluateLicensedAction({ license: d, state: "grace", actionClass: "governance" }).allowed).toBe(true);
  });

  it("a not-yet-valid license grants no expansion but does not stop governance", () => {
    expect(evaluateLicensedAction({ license: d, state: "not_yet_valid", actionClass: "expansion" }).allowed).toBe(false);
    expect(evaluateLicensedAction({ license: d, state: "not_yet_valid", actionClass: "governance" }).allowed).toBe(true);
  });

  it("hardStopOnExpiry is OPT-IN, refuses governance, and is never the default", () => {
    expect(doc().hardStopOnExpiry).toBe(false);
    const hard = doc({ hardStopOnExpiry: true });
    const gov = evaluateLicensedAction({ license: hard, state: "expired", actionClass: "governance" });
    expect(gov.allowed).toBe(false);
    expect(gov.ruleId).toBe("license-hard-stop");
    expect(gov.reason).toMatch(/never applied unless a customer asked for it/);
    // and it does nothing at all before the grace window runs out
    expect(evaluateLicensedAction({ license: hard, state: "grace", actionClass: "governance" }).allowed).toBe(true);
  });

  it("ABSENCE runs unlicensed: governance and expansion permitted, nothing capped", () => {
    const gov = evaluateLicensedAction({ license: null, state: "absent", actionClass: "governance" });
    expect(gov.allowed).toBe(true);
    expect(gov.ruleId).toBe("license-absent-unlicensed");
    expect(evaluateLicensedAction({ license: null, state: "absent", actionClass: "expansion" }).allowed).toBe(true);
  });
});

describe("seats", () => {
  it("does not cap when nothing is installed, and says why", () => {
    const d = evaluateSeatGrant({ license: null, state: "absent", activeSeats: 500 });
    expect(d.allowed).toBe(true);
    expect(d.seatCap).toBeNull();
    expect(d.ruleId).toBe("license-absent-seat-cap-unenforced");
  });

  it("allows within the cap and reports the remainder", () => {
    const d = evaluateSeatGrant({ license: doc({ seatCap: 5 }), state: "valid", activeSeats: 3 });
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(2);
  });

  it("refuses AT the cap with the documented seat_cap_reached and does not touch existing users", () => {
    const d = evaluateSeatGrant({ license: doc({ seatCap: 5 }), state: "valid", activeSeats: 5 });
    expect(d.allowed).toBe(false);
    expect(d.ruleId).toBe("seat_cap_reached");
    expect(d.reason).toMatch(/every existing user is untouched/);
  });

  it("refuses OVER the cap — the legitimate case where a smaller license lands on a bigger deployment", () => {
    const d = evaluateSeatGrant({ license: doc({ seatCap: 2 }), state: "valid", activeSeats: 9 });
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(-7);
    // a growth gate, not a service gate: the decision refuses the NEXT grant
    // and carries no instruction to revoke anyone
    expect(d.ruleId).toBe("seat_cap_reached");
  });

  it("expiry beats headroom — a seat is expansion", () => {
    const d = evaluateSeatGrant({ license: doc({ seatCap: 100 }), state: "expired", activeSeats: 1 });
    expect(d.allowed).toBe(false);
    expect(d.ruleId).toBe("license-expired-no-expansion");
  });
});

describe("tier features", () => {
  it("grants only what the license lists", () => {
    expect(featureEnabled(doc(), "sso_saml", "valid").enabled).toBe(true);
    expect(featureEnabled(doc(), "compliance_packs", "valid").enabled).toBe(false);
  });

  it("defaults CLOSED for a flag an older license never heard of", () => {
    const d = featureEnabled(doc(), "a_feature_invented_next_year", "valid");
    expect(d.enabled).toBe(false);
    expect(d.ruleId).toBe("license-feature-not-granted");
  });

  it("closes every flag when nothing is installed", () => {
    expect(featureEnabled(null, "sso_saml", "absent").enabled).toBe(false);
    expect(featureEnabled(null, "sso_saml", "absent").ruleId).toBe("license-absent-feature-closed");
  });

  it("closes granted flags past grace — a tier flag is exactly what is paid for", () => {
    const d = featureEnabled(doc(), "sso_saml", "expired");
    expect(d.enabled).toBe(false);
    expect(d.ruleId).toBe("license-expired-no-expansion");
  });

  it("keeps granted flags open inside the grace window", () => {
    expect(featureEnabled(doc(), "sso_saml", "grace").enabled).toBe(true);
  });
});

describe("document shape", () => {
  it("refuses an expiry that precedes the start", () => {
    expect(
      licenseDocumentSchema.safeParse({
        schema: LICENSE_SCHEMA_ID,
        licenseId: "x",
        tenant: "t",
        tier: "e",
        seatCap: 1,
        deploymentMode: "hosted",
        issuedAt: "2026-01-01T00:00:00.000Z",
        notBefore: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:00:00.000Z",
        graceDays: 0,
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown schema id", () => {
    expect(licenseDocumentSchema.safeParse({ ...doc(), schema: "something-else" }).success).toBe(false);
  });

  it("refuses a signingKeyId that could escape the keyring directory", () => {
    for (const bad of ["../../etc/passwd", "key/../../x", "key with space", ""]) {
      expect(
        installLicenseSchema.safeParse({ documentBase64: "e30=", signature: "AA==", signingKeyId: bad }).success,
        bad,
      ).toBe(false);
    }
    expect(
      installLicenseSchema.safeParse({
        documentBase64: "e30=",
        signature: "AA==",
        signingKeyId: "regulait-license-dev-2026-08",
      }).success,
    ).toBe(true);
  });

  it("canonical bytes are stable regardless of key or feature order", () => {
    const a = canonicalLicenseBytes(doc({ features: ["sso_saml", "airgapped_mode"] }));
    const b = canonicalLicenseBytes(doc({ features: ["airgapped_mode", "sso_saml"] }));
    expect(a).toBe(b);
  });
});
