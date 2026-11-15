import { describe, expect, it } from "vitest";
import { oidcEmailVerifiedVia } from "./oidc-email-verified.js";

const tid = "11111111-2222-4333-8444-555555555555";
const iss = `https://login.microsoftonline.com/${tid}/v2.0`;

describe("ADR-0326: which OIDC claims make an email verified", () => {
  it("the standard claim is accepted from any issuer", () => {
    expect(oidcEmailVerifiedVia({ iss: "https://idp.example", email_verified: true })).toBe("email_verified");
  });
  it("a non-boolean email_verified is not verified", () => {
    expect(oidcEmailVerifiedVia({ iss: "https://idp.example", email_verified: "true" })).toBeNull();
  });
  it("Entra's xms_edov is accepted from the tenant's own v2.0 issuer", () => {
    expect(oidcEmailVerifiedVia({ iss, tid, xms_edov: true })).toBe("entra_xms_edov");
  });
  it("xms_edov false, missing or a string is refused", () => {
    expect(oidcEmailVerifiedVia({ iss, tid, xms_edov: false })).toBeNull();
    expect(oidcEmailVerifiedVia({ iss, tid })).toBeNull();
    expect(oidcEmailVerifiedVia({ iss, tid, xms_edov: "true" })).toBeNull();
  });
  it("xms_edov from any other issuer is ignored", () => {
    expect(oidcEmailVerifiedVia({ iss: "https://idp.example", tid, xms_edov: true })).toBeNull();
    expect(oidcEmailVerifiedVia({ iss: `https://login.microsoftonline.com/${tid}/v2.0/evil`, tid, xms_edov: true })).toBeNull();
    expect(oidcEmailVerifiedVia({ iss: `https://sts.windows.net/${tid}/`, tid, xms_edov: true })).toBeNull();
    expect(oidcEmailVerifiedVia({ iss: "https://login.microsoftonline.com/common/v2.0", tid, xms_edov: true })).toBeNull();
  });
  it("a tid that does not match the issuer's tenant is refused", () => {
    expect(oidcEmailVerifiedVia({ iss, tid: "99999999-2222-4333-8444-555555555555", xms_edov: true })).toBeNull();
  });
});
