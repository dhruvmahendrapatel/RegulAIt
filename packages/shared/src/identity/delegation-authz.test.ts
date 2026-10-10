/**
 * ADR-0188 decision 23 — the delegation body's one canonical form (RFC 8785
 * through `canonicalize`): the same meaning gives the same string whatever the
 * key order, every change of meaning changes it, and a body that is not a
 * valid delegation is refused rather than canonicalised.
 */
import { describe, expect, it } from "vitest";
import { canonicalDelegationBody, type DelegationBody } from "./delegation-authz.js";

const SERVER = "11111111-1111-4111-8111-111111111111";
const body = (over: Partial<DelegationBody> = {}): DelegationBody => ({
  authorization_details: [{ type: "mcp_tool", serverId: SERVER, toolNames: ["read_file"], kind: "read" }],
  resource: "https://gateway.example.test/mcp/x",
  project_id: null,
  env: "staging",
  cap_micros: 5_000_000,
  max_depth: 1,
  expires_at: 1_900_000_000,
  ...over,
});

describe("canonicalDelegationBody", () => {
  it("is independent of key order and sorts members (RFC 8785)", () => {
    const shuffled = JSON.parse(
      '{"max_depth":1,"env":"staging","expires_at":1900000000,"cap_micros":5000000,"project_id":null,' +
        `"resource":"https://gateway.example.test/mcp/x","authorization_details":[{"kind":"read","toolNames":["read_file"],"serverId":"${SERVER}","type":"mcp_tool"}]}`,
    ) as DelegationBody;
    expect(canonicalDelegationBody(shuffled)).toBe(canonicalDelegationBody(body()));
    expect(canonicalDelegationBody(body()).startsWith('{"authorization_details":[{"kind":"read","serverId":')).toBe(true);
  });

  it("every field is bound: changing any one changes the string", () => {
    const base = canonicalDelegationBody(body());
    const variants: Partial<DelegationBody>[] = [
      { authorization_details: [{ type: "mcp_tool", serverId: SERVER, toolNames: ["read_file"], kind: "write" }] },
      { resource: "https://gateway.example.test/mcp/y" },
      { project_id: "22222222-2222-4222-8222-222222222222" },
      { env: "production" },
      { cap_micros: 5_000_001 },
      { cap_micros: null },
      { max_depth: 2 },
      { expires_at: 1_900_000_001 },
    ];
    for (const v of variants) expect(canonicalDelegationBody(body(v)), JSON.stringify(v)).not.toBe(base);
  });

  it("refuses a body that is not a valid delegation (unknown member, missing member, empty scope, bad depth)", () => {
    expect(() => canonicalDelegationBody({ ...body(), extra: 1 } as unknown as DelegationBody)).toThrow();
    const { cap_micros: _omit, ...missing } = body();
    expect(() => canonicalDelegationBody(missing as unknown as DelegationBody)).toThrow();
    expect(() => canonicalDelegationBody(body({ authorization_details: [] }))).toThrow();
    expect(() => canonicalDelegationBody(body({ max_depth: 9 }))).toThrow();
  });
});
