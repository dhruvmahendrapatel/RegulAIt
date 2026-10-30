import { describe, expect, it } from "vitest";
import { headerNameProblem, secretProblem, sentAs } from "./mcpUpstreamCredentialModel";

// the form's checks (the gateway refuses the reserved names itself, zz-adr0204-mcp-upstream-credential.test.ts)
describe("ADR-0204 upstream credential form checks", () => {
  it.each(["Authorization", "Bad Header", "-x", ""])(
    "refuses the header %j",
    (name) => {
      expect(headerNameProblem(name)).not.toBeNull();
    },
  );

  it("accepts an ordinary key header", () => {
    expect(headerNameProblem("X-API-Key")).toBeNull();
  });

  it("refuses a short key, a space or a line break, and accepts a long printable one", () => {
    expect(secretProblem("short")).not.toBeNull();
    expect(secretProblem("placeholder value with spaces")).not.toBeNull();
    expect(secretProblem("placeholder-0123456789\r\nX: 1")).not.toBeNull();
    expect(secretProblem("placeholder-0123456789")).toBeNull();
  });

  it("says how a stored credential is sent, by its last four characters only", () => {
    expect(sentAs({ set: false, scheme: null, headerName: null, last4: null, setBy: null, setAt: null })).toBe("Nothing is sent.");
    expect(sentAs({ set: true, scheme: "bearer", headerName: "authorization", last4: "a1b2", setBy: null, setAt: null })).toBe(
      "Sent as a bearer token in Authorization ending a1b2.",
    );
    expect(sentAs({ set: true, scheme: "header", headerName: "x-api-key", last4: "c3d4", setBy: null, setAt: null })).toBe(
      "Sent in the x-api-key header ending c3d4.",
    );
  });
});
