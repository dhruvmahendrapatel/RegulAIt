/**
 * ADR-0188 decision 20 / R11 (S5) — the PINNED `oidc-provider` internals the
 * token endpoint depends on. Fails the build on an upgrade that changes them:
 *  - the exact version (the lockfile pins it; this re-checks what is installed);
 *  - the two helpers imported from the non-public `lib/helpers/grants.js`;
 *  - R11 rule 1: `assertJwtClientAuthClaimsAndHeader` is awaited AFTER the
 *    assertion's signature is verified and BEFORE `ReplayDetection.unique`
 *    claims its `jti` (the order the whole pre-claim design rests on);
 *  - `ReplayDetection.unique` keys its claim sha256(iss‖jti), the shape
 *    `token-admin.ts` reproduces so one assertion is single-use everywhere.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { buildTokenResponse, checkDpopReplay } from "oidc-provider/lib/helpers/grants.js";

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve("oidc-provider/package.json"));
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

describe("oidc-provider pinned contract (R11)", () => {
  it("is exactly 9.12.2", () => {
    expect(JSON.parse(read("package.json")).version).toBe("9.12.2");
  });

  it("exports the two grant helpers the exchange grant uses", () => {
    expect(typeof checkDpopReplay).toBe("function");
    expect(typeof buildTokenResponse).toBe("function");
  });

  it("runs the pre-claim hook after signature verification and before the replay claim", () => {
    const src = read("lib/shared/jwt_client_auth.js");
    const verify = src.indexOf("await JWT.verify(ctx.oidc.params.client_assertion");
    const hook = src.indexOf("await assertJwtClientAuthClaimsAndHeader(");
    const claim = src.indexOf("ReplayDetection.unique(");
    expect(verify).toBeGreaterThan(0);
    expect(hook).toBeGreaterThan(verify);
    expect(claim).toBeGreaterThan(hook);
  });

  it("keys a replay claim sha256(iss + jti) and checks uniqueness through find-then-save (which our adapter replaces)", () => {
    const src = read("lib/models/replay_detection.js");
    expect(src).toContain("crypto.hash('sha256', `${iss}${jti}`, 'base64url')");
    expect(src).toContain("await this.find(id)");
    expect(src).toContain("await inst.save(");
  });
});
