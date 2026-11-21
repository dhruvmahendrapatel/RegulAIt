import { describe, expect, it } from "vitest";
import {
  grantProblem,
  issuedFilters,
  NO_FILTERS,
  reasonProblem,
  REVOKE_CLOSED,
  revokeBlockedReason,
  revokeReducer,
  shortJti,
  stateWords,
  type IssuedCredential,
  type RevokeFlow,
} from "./issuedCredentialsModel";

const G = "3f2b8c1e-1111-4111-8111-111111111111";
const row = (over: Partial<IssuedCredential> = {}): IssuedCredential => ({
  jti: "jti-abcdef-0123456789",
  audienceId: "a1",
  grantId: G,
  statusIndex: 7,
  state: "issued",
  expired: false,
  issuedAt: "2026-11-20T10:00:00Z",
  expiresAt: "2026-11-20T10:05:00Z",
  revokedAt: null,
  ...over,
});

describe("issued credential filters", () => {
  it("defaults to the issued ones and sends only what is set", () => {
    expect(issuedFilters(NO_FILTERS)).toEqual({ state: "issued" });
    expect(issuedFilters({ audienceId: "a1", state: "", grantId: "" })).toEqual({ audienceId: "a1" });
  });
  it("sends a grant id only once it is a whole uuid", () => {
    expect(issuedFilters({ ...NO_FILTERS, grantId: "3f2b" })).toEqual({ state: "issued" });
    expect(grantProblem("3f2b")).toMatch(/whole id/);
    expect(issuedFilters({ ...NO_FILTERS, grantId: ` ${G.toUpperCase()} ` })).toEqual({ state: "issued", grantId: G });
    expect(grantProblem("")).toBeNull();
  });
});

describe("reason", () => {
  it("is required and at most 500 characters", () => {
    expect(reasonProblem("   ")).toMatch(/Say why/);
    expect(reasonProblem("x".repeat(501))).toMatch(/500/);
    expect(reasonProblem("x".repeat(500))).toBeNull();
  });
});

describe("state words", () => {
  it("shows only the stored revocation, and expiry", () => {
    expect(stateWords(row())).toEqual({ label: "Issued", tone: "ok" });
    expect(stateWords(row({ expired: true })).label).toBe("Expired");
    expect(stateWords(row({ state: "revoked", revokedAt: "2026-11-20T10:01:00Z" })).label).toBe("Revoked");
  });
});

describe("revoke flow (rule 12)", () => {
  const open = revokeReducer(REVOKE_CLOSED, { type: "open", jti: "j1" });
  it("opens with an empty reason and refuses to submit without one", () => {
    expect(open).toEqual({ kind: "asking", jti: "j1", reason: "", tried: false });
    expect(revokeReducer(open, { type: "submit" })).toEqual({ ...open, tried: true });
  });
  it("submits a trimmed reason, then closes on done", () => {
    const typed = revokeReducer(open, { type: "type", reason: "  key leaked " });
    const busy = revokeReducer(typed, { type: "submit" });
    expect(busy).toEqual({ kind: "revoking", jti: "j1", reason: "key leaked" });
    expect(revokeReducer(busy, { type: "done" })).toEqual(REVOKE_CLOSED);
  });
  it("keeps the reason when the revoke fails", () => {
    const busy: RevokeFlow = { kind: "revoking", jti: "j1", reason: "r" };
    expect(revokeReducer(busy, { type: "failed" })).toEqual({ kind: "asking", jti: "j1", reason: "r", tried: false });
  });
  it("ignores moves the state does not allow", () => {
    const busy: RevokeFlow = { kind: "revoking", jti: "j1", reason: "r" };
    expect(revokeReducer(busy, { type: "cancel" })).toBe(busy);
    expect(revokeReducer(busy, { type: "open", jti: "j2" })).toBe(busy);
    expect(revokeReducer(REVOKE_CLOSED, { type: "submit" })).toBe(REVOKE_CLOSED);
  });
  it("says why Revoke is not offered", () => {
    expect(revokeBlockedReason(row(), REVOKE_CLOSED)).toBeNull();
    expect(revokeBlockedReason(row({ state: "revoked" }), REVOKE_CLOSED)).toMatch(/Already/);
    expect(revokeBlockedReason(row(), { kind: "revoking", jti: "x", reason: "r" })).toMatch(/wait/);
  });
});

it("shortens a long jti for a sentence", () => {
  expect(shortJti("jti-abcdef-0123456789")).toBe("jti-ab…456789");
  expect(shortJti("short")).toBe("short");
});
