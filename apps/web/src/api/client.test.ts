import { describe, expect, it } from "vitest";
import { errMessage, isSessionLoss, issueText } from "./client";

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

  it("never fires on the pre-session routes, whatever the code says — there is no session to lose", () => {
    expect(isSessionLoss("/auth/login", { error: "user_disabled" })).toBe(false);
    expect(isSessionLoss("/auth/login", { error: "ip_not_allowed" })).toBe(false);
    expect(isSessionLoss("/auth/login?next=%2Fui", { error: "unauthenticated" })).toBe(false);
    expect(isSessionLoss("/auth/mfa/verify", null)).toBe(false);
  });

  it("still fires on a session-bound self-service route when the SESSION died, not the input", () => {
    // a forced password change / MFA enrolment that idled out: the preHandler
    // refuses the credential before the route sees the body
    expect(isSessionLoss("/auth/change-password", { error: "unauthenticated" })).toBe(true);
    expect(isSessionLoss("/auth/change-password?x=1", { error: "user_disabled" })).toBe(true);
    expect(isSessionLoss("/auth/totp/enroll", { error: "unauthenticated" })).toBe(true);
    expect(isSessionLoss("/auth/totp/activate", { error: "ip_not_allowed" })).toBe(true);
    // and a code-less 401 on them reads the old way, like everywhere else
    expect(isSessionLoss("/auth/totp/activate", null)).toBe(true);
  });
});

describe("errMessage — a refusal reads as prose, never as a code or zod text (UIA-03, UIB-02, UXJ-04)", () => {
  it("turns zod issues into field sentences and drops the 'validation' head", () => {
    const msg = errMessage(400, {
      error: "validation",
      issues: [
        { path: ["name"], message: "String must contain at least 1 character(s)" },
        { path: ["connectorId"], message: "Invalid uuid" },
        { path: ["signingSecret"], message: "String must contain at least 8 character(s)" },
        { path: ["budgetUsd"], message: "Number must be greater than or equal to 0" },
        { path: "url", message: "Invalid url" },
        { path: ["rows"], message: "Array must contain at least 1 element(s)" },
        { path: [], message: "first stage must be a trigger" },
        { path: ["items", 2, "email"], message: "Invalid email" },
      ],
    });
    expect(msg).toBe(
      "Name is required; Connector ID is not a valid ID; Signing secret must be at least 8 characters; " +
        "Budget USD must be 0 or more; URL is not a valid URL; Rows needs at least one entry; " +
        "First stage must be a trigger; Email is not a valid email address",
    );
    expect(msg).not.toMatch(/validation|character\(s\)|uuid/);
    expect(issueText("kind", "Invalid enum value. Expected 'slack' | 'teams', received 'x'")).toBe("Kind must be one of slack, teams");
    expect(issueText("", "Required")).toBe("This request is required");
  });

  it("renders a bare gateway code as a sentence and keeps a detail after it", () => {
    expect(errMessage(401, { error: "unauthenticated" })).toBe("Your session has ended — sign in again");
    expect(errMessage(500, { error: "internal_error" })).toMatch(/^Something went wrong on the server/);
    expect(errMessage(409, { error: "conflict" })).toBe("This conflicts with a record that already exists");
    expect(errMessage(403, { error: "not_a_project_member" })).toBe("You're not a member of this project");
    expect(errMessage(404, { error: "unavailable" })).toMatch(/^This record isn't available/);
    expect(errMessage(404, { error: "not_found", detail: "no such workflow instance" })).toBe("no such workflow instance");
    expect(errMessage(500, { error: "internal", detail: "db unavailable" })).toMatch(/^Something went wrong on the server.* — db unavailable$/);
    // an unknown code is at least words
    expect(errMessage(502, { error: "post_failed", detail: "see the audit row" })).toBe("Post failed — see the audit row");
    expect(errMessage(409, { error: "role_held" })).toBe("Role held");
    expect(errMessage(502, null)).toBe("HTTP 502");
    expect(errMessage(502, { raw: "<html>bad gateway</html>" })).toBe("HTTP 502 — <html>bad gateway</html>");
  });
});
