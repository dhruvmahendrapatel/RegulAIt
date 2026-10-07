import { describe, expect, it } from "vitest";
import { ApiError, errMessage } from "./client";
import { guidanceOf, REFUSAL_GUIDANCE, refusalGuidance } from "./refusals";

describe("refusalGuidance (ADR-0183 2.3)", () => {
  it("403 mfa_enrollment_required on an API key: the key's owner must enrol", () => {
    expect(refusalGuidance(403, { error: "mfa_enrollment_required", credential: "api_key", detail: "x" })).toBe(REFUSAL_GUIDANCE.apiKeyMfa);
  });

  it("403 mfa_enrollment_required from the session gate: your account must enrol", () => {
    expect(refusalGuidance(403, { error: "mfa_enrollment_required", detail: "enroll via POST /auth/totp/enroll" })).toBe(REFUSAL_GUIDANCE.sessionMfa);
  });

  it("409 mfa_enrollment_required on key issue: no key until the person enrols", () => {
    expect(refusalGuidance(409, { error: "mfa_enrollment_required", detail: "x" })).toBe(REFUSAL_GUIDANCE.keyIssueMfa);
  });

  it("ai-literacy-not-current as a run-start error or a governed call's decision", () => {
    expect(refusalGuidance(403, { error: "ai-literacy-not-current", detail: "x" })).toBe(REFUSAL_GUIDANCE.literacy);
    expect(refusalGuidance(403, { decision: { reason: "x", ruleId: "ai-literacy-not-current" } as never })).toBe(REFUSAL_GUIDANCE.literacy);
  });

  it("409 custom_provider_disabled (registration or dispatch): an admin enables the endpoint", () => {
    expect(refusalGuidance(409, { error: "custom_provider_disabled", detail: "x" })).toBe(REFUSAL_GUIDANCE.customProviderDisabled);
    expect(refusalGuidance(500, { error: "custom_provider_disabled" })).toBeNull();
  });

  it("anything else is not guided", () => {
    expect(refusalGuidance(403, { error: "forbidden" })).toBeNull();
    expect(refusalGuidance(403, { decision: { reason: "x", ruleId: "no-grant" } as never })).toBeNull();
    expect(refusalGuidance(500, { error: "mfa_enrollment_required" })).toBeNull();
    expect(refusalGuidance(403, null)).toBeNull();
  });

  it("every guidance links to an Account section or admin page that exists", () => {
    for (const g of Object.values(REFUSAL_GUIDANCE)) {
      expect(g.to).toMatch(/^(\/account\?section=(mfa|ai-policies)|\/admin\/custom-providers)$/);
    }
  });
});

describe("the generic sentence no longer appears for these refusals", () => {
  it("errMessage and ApiError carry the guidance, not the code as words or the API route", () => {
    const payload = { error: "mfa_enrollment_required", credential: "api_key", detail: "… (POST /auth/totp/enroll) …" };
    expect(errMessage(403, payload)).toBe(REFUSAL_GUIDANCE.apiKeyMfa.message);
    const e = new ApiError(403, payload);
    expect(e.message).not.toContain("Mfa enrollment required");
    expect(e.message).not.toContain("/auth/totp/enroll");
    expect(guidanceOf(e)).toBe(REFUSAL_GUIDANCE.apiKeyMfa);
    expect(new ApiError(403, { decision: { reason: "r", ruleId: "ai-literacy-not-current" } as never }).message).toBe(REFUSAL_GUIDANCE.literacy.message);
  });

  it("an unrelated refusal keeps its generic sentence and has no guidance", () => {
    const e = new ApiError(403, { error: "admin_only" });
    expect(e.message).toBe("Only an administrator can do this");
    expect(guidanceOf(e)).toBeNull();
    expect(guidanceOf(new Error("x"))).toBeNull();
  });
});
