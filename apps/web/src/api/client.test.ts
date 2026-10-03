import { describe, expect, it } from "vitest";
import { isSessionLoss } from "./client";

describe("isSessionLoss — which 401s send the shell to /login (UIW-01)", () => {
  it("fires for the preHandler's credential refusals on an ordinary route", () => {
    for (const error of [
      "unauthenticated", "user_disabled", "ip_not_allowed",
      "disabled", "virtual_key_revoked", "virtual_key_expired", "api_key_expired", "api_key_revoked",
    ]) {
      expect(isSessionLoss("/v1/approvals", { error }), error).toBe(true);
    }
    expect(isSessionLoss("/auth/me", { error: "unauthenticated" })).toBe(true);
    // a 401 with no code is not something the gateway sends — read it the old way
    expect(isSessionLoss("/v1/users", null)).toBe(true);
    expect(isSessionLoss("/v1/users", { raw: "<html>" })).toBe(true);
  });

  it("stays quiet when a route refused what was typed, not who typed it", () => {
    expect(isSessionLoss("/auth/totp/activate", { error: "invalid_code" })).toBe(false);
    expect(isSessionLoss("/auth/totp/disable", { error: "invalid_password_or_code" })).toBe(false);
    expect(isSessionLoss("/auth/change-password", { error: "current_password_incorrect" })).toBe(false);
    expect(isSessionLoss("/auth/change-password", { error: "current_password_required" })).toBe(false);
    expect(isSessionLoss("/auth/login", { error: "invalid_credentials" })).toBe(false);
    expect(isSessionLoss("/auth/login-with-key", { error: "invalid_key" })).toBe(false);
    expect(isSessionLoss("/auth/mfa/verify", { error: "invalid_code" })).toBe(false);
    expect(isSessionLoss("/auth/mfa/verify", { error: "invalid_or_expired_pending_token" })).toBe(false);
  });

  it("never fires on the self-service auth routes, whatever the code says", () => {
    expect(isSessionLoss("/auth/login", { error: "user_disabled" })).toBe(false);
    expect(isSessionLoss("/auth/login", { error: "ip_not_allowed" })).toBe(false);
    expect(isSessionLoss("/auth/totp/activate", null)).toBe(false);
    expect(isSessionLoss("/auth/change-password?x=1", { error: "unauthenticated" })).toBe(false);
  });
});
