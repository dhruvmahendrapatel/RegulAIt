import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import { mappingText } from "../admin/identity/UserRoleProvenancePanel";
import { normaliseUsername, USERNAME_PATTERN, usernameRefusal } from "./username";

const sharedSource = () => readFileSync(new URL("../../../../../packages/shared/src/index.ts", import.meta.url).pathname, "utf8");

describe("the username rule mirrors @regulait/shared", () => {
  it("the same pattern as USERNAME_PATTERN", () => {
    const m = /export const USERNAME_PATTERN = \/(.+)\/;/.exec(sharedSource());
    expect(m?.[1]).toBe(USERNAME_PATTERN.source);
  });
  it("trims and lower-cases, then checks the shape", () => {
    expect(normaliseUsername("  Ada.Lovelace ")).toEqual({ ok: true, value: "ada.lovelace" });
    expect(normaliseUsername("x".repeat(63)).ok).toBe(true);
    for (const bad of ["", "a", "x".repeat(64), "ada@example.com", "has space", "_lead", "-lead"]) expect(normaliseUsername(bad).ok, bad).toBe(false);
  });
});

describe("refusals in words", () => {
  it("a taken username uses the gateway's detail; self-service off says who manages it", () => {
    expect(usernameRefusal(new ApiError(409, { error: "username_taken", detail: "username 'ada' is already taken" }))).toBe("username 'ada' is already taken");
    expect(usernameRefusal(new ApiError(403, { error: "username_self_service_disabled" }))).toContain("managed by an administrator");
    expect(usernameRefusal(new ApiError(404, { error: "unknown_user" }))).toBe("This account no longer exists.");
  });
});

describe("role provenance", () => {
  it("names the group, its source, and whether SCIM asserts it now", () => {
    expect(mappingText({ mappingId: "m", source: "scim", externalGroup: "eng", currentlyAssertedViaScim: true })).toBe("SCIM group “eng” (SCIM asserts this membership now)");
    expect(mappingText({ mappingId: "m", source: "scim", externalGroup: "eng", currentlyAssertedViaScim: false })).toContain("does not assert");
    expect(mappingText({ mappingId: "m", source: "oidc", externalGroup: "eng", currentlyAssertedViaScim: false })).toBe("OIDC group “eng” (asserted per sign-in; see the audit log)");
  });
});
