import { describe, expect, it } from "vitest";
import { credentialStatus, formatMicros, orderedDelegations, readPublicKey, remainingMicros, type DelegationNode, type WorkloadCredential } from "./workloadIdentityModel";

describe("identity view refusal and budget boundaries", () => {
  it("keeps each edge separate and preserves exact amounts above JS integer precision", () => {
    expect(remainingMicros({ capMicros: "100000000", settledMicros: "10000000", reservedMicros: "50000000" })).toBe("40000000");
    expect(remainingMicros({ capMicros: "60000000", settledMicros: "10000000", reservedMicros: "0" })).toBe("50000000");
    expect(formatMicros("9007199254740993")).toBe("$9007199254.740993");
    expect(formatMicros(remainingMicros({ capMicros: "1000000", settledMicros: "2000000", reservedMicros: "0" }))).toBe("−$1.00");
  });
  it.each([null, "", "NaN", "1e6", "-1"])("does not invent remaining capacity for unreadable input %s", capMicros => {
    expect(remainingMicros({ capMicros, settledMicros: "0", reservedMicros: "0" })).toBeNull();
    expect(formatMicros(remainingMicros({ capMicros, settledMicros: "0", reservedMicros: "0" }))).toBe("Unmeasured");
  });
  const publicKey = { kty: "OKP", crv: "Ed25519", x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
  it.each(["d", "p", "q", "dp", "dq", "qi", "oth", "k"])("refuses private/shared material %s before a write", field => {
    expect(() => readPublicKey(JSON.stringify({ ...publicKey, [field]: "SYNTHETIC_PRIVATE_MARKER" }))).toThrow("Private or shared");
  });
  it("only forwards whitelisted public material and refuses noncanonical encoding and key sets", () => {
    expect(readPublicKey(JSON.stringify({ ...publicKey, kid: "untrusted", extra: { d: "not-forwarded" } }))).toEqual(publicKey);
    expect(() => readPublicKey(JSON.stringify({ ...publicKey, x: publicKey.x.slice(0, -1) + "B" }))).toThrow("public JWK");
    expect(() => readPublicKey(JSON.stringify([publicKey]))).toThrow("one public JWK");
    expect(() => readPublicKey(JSON.stringify({ kty: "oct", k: "secret" }))).toThrow("Private or shared");
  });
  const node = (id: string, parentId: string | null) => ({ id, parentId } as DelegationNode);
  it("refuses action rows on incomplete, duplicate, cyclic or excessively deep chains", () => {
    for (const nodes of [[node("a", "missing")], [node("a", null), node("a", null)], [node("a", "b"), node("b", "a")],
      Array.from({ length: 66 }, (_, i) => node(String(i), i ? String(i - 1) : null))]) {
      expect(orderedDelegations(nodes).problem).toBeTruthy();
      expect(orderedDelegations(nodes).nodes).toEqual([]);
    }
    expect(orderedDelegations([node("child", "root"), node("root", null)]).nodes.map(n => [n.id, n.level])).toEqual([["root", 0], ["child", 1]]);
  });
  it("does not infer active credentials from invalid dates and gives revocation precedence", () => {
    const c = { notBefore: "invalid", notAfter: "invalid", revokedAt: null } as WorkloadCredential;
    expect(credentialStatus(c)).toBe("Validity unmeasured");
    expect(credentialStatus({ ...c, revokedAt: "recorded" })).toBe("Revoked");
    expect(credentialStatus({ ...c, notBefore: "2026-10-01T00:00:00Z", notAfter: "2026-10-02T00:00:00Z" }, Date.parse("2026-10-02T00:00:00Z"))).toBe("Expired");
  });
});
