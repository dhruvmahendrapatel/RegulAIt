import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIGNING_KEY_REFUSALS, kidOk, signingKeyRefusal, signingKeyState } from "./signingKeyModel";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("issuer signing keys", () => {
  it("accepts exactly IDENTITY_SIGNING_KID_PATTERN's alphabet and length", () => {
    expect(kidOk("abc.DEF_123:-")).toBe(true);
    expect(kidOk("a".repeat(128))).toBe(true);
    for (const bad of ["", "a".repeat(129), "a b", "a/b", "kidé", "a?b"]) expect(kidOk(bad)).toBe(false);
    const contract = src("../../../../../../packages/shared/src/identity/contract.ts");
    expect(contract).toContain("export const IDENTITY_SIGNING_KID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;");
  });

  it("reads a key's state with revoked winning over retired over active", () => {
    expect(signingKeyState({ activatedAt: "t", retiredAt: null, revokedAt: null })).toBe("active");
    expect(signingKeyState({ activatedAt: "t", retiredAt: "t", revokedAt: null })).toBe("retired");
    expect(signingKeyState({ activatedAt: "t", retiredAt: "t", revokedAt: "t" })).toBe("revoked");
    expect(signingKeyState({ activatedAt: null, retiredAt: null, revokedAt: null })).toBe("recorded");
  });

  it("every refusal code named here is one the signing-key module raises", () => {
    const gateway = src("../../../../../gateway/src/identity-signing-keys.ts");
    expect(Object.keys(SIGNING_KEY_REFUSALS).filter((code) => !gateway.includes(`"${code}"`))).toEqual([]);
    expect(signingKeyRefusal("signing_key_ambiguous")).toMatch(/Name the one/);
    expect(signingKeyRefusal("step_up_required")).toBeNull();
  });
});
