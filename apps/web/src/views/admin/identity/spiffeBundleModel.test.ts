import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bundleDraftError,
  earliestAuthorityExpiry,
  isBundleList,
  SPIFFE_BUNDLE_MAX_BYTES,
  SPIFFE_BUNDLE_REFUSALS,
  spiffeBundleRefusal,
  trustDomainOk,
} from "./spiffeBundleModel";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const PEM = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";

describe("ADR-0188 S9 — SPIFFE trust bundles in the browser", () => {
  it("accepts exactly SPIFFE_TRUST_DOMAIN_PATTERN's alphabet and length", () => {
    for (const ok of ["example.org", "a", "s9-x_y.example.org", "a".repeat(255)]) expect(trustDomainOk(ok), ok).toBe(true);
    for (const bad of ["", "a".repeat(256), "Example.org", "spiffe://example.org", "example.org/x", "exa mple", "exämple.org", "example.org:443"]) {
      expect(trustDomainOk(bad), bad).toBe(false);
    }
    const contract = src("../../../../../../packages/shared/src/identity/contract.ts");
    expect(contract).toContain("export const SPIFFE_TRUST_DOMAIN_PATTERN = /^[a-z0-9._-]{1,255}$/;");
    expect(contract).toContain(`export const SPIFFE_BUNDLE_MAX_BYTES = 256 * 1024;`);
    expect(SPIFFE_BUNDLE_MAX_BYTES).toBe(256 * 1024);
  });

  it("refuses in the browser, before anything is sent: a bad domain, nothing pasted, a private key, something that is no bundle", () => {
    expect(bundleDraftError({ trustDomain: "example.org", bundle: PEM })).toBeNull();
    expect(bundleDraftError({ trustDomain: "example.org", bundle: '{"keys": []}' })).toBeNull();
    expect(bundleDraftError({ trustDomain: "spiffe://example.org", bundle: PEM })).toMatch(/no spiffe:\/\/ prefix/);
    expect(bundleDraftError({ trustDomain: "example.org", bundle: "  " })).toMatch(/Paste the bundle/);
    // assembled at runtime: no key-shaped literal in the repository
    const marker = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    expect(bundleDraftError({ trustDomain: "example.org", bundle: `${PEM}${marker}\n` })).toMatch(/private key/);
    expect(bundleDraftError({ trustDomain: "example.org", bundle: "hello" })).toMatch(/neither PEM/);
    expect(bundleDraftError({ trustDomain: "example.org", bundle: PEM + "x".repeat(SPIFFE_BUNDLE_MAX_BYTES) })).toMatch(/256 KB/);
  });

  it("a list it cannot trust is never read as 'no bundles'", () => {
    expect(isBundleList({ items: [], legacyEnvironmentIgnored: false })).toBe(true);
    for (const bad of [{}, null, { items: [] }, { items: "x", legacyEnvironmentIgnored: false }]) expect(isBundleList(bad)).toBe(false);
  });

  it("names the earliest authority expiry", () => {
    const a = (notAfter: string) => ({ thumbprint: "t", subject: "s", notBefore: "2026-01-01T00:00:00.000Z", notAfter });
    expect(earliestAuthorityExpiry({ authorities: [a("2027-01-01T00:00:00.000Z"), a("2026-11-01T00:00:00.000Z")] })).toBe("2026-11-01T00:00:00.000Z");
    expect(earliestAuthorityExpiry({ authorities: [] })).toBeNull();
  });

  it("every refusal code named here is one the bundle module raises", () => {
    const gateway = src("../../../../../gateway/src/oauth/spiffe-bundles.ts");
    expect(Object.keys(SPIFFE_BUNDLE_REFUSALS).filter((code) => !gateway.includes(`"${code}"`))).toEqual([]);
    expect(spiffeBundleRefusal("spiffe_bundle_conflict")).toMatch(/Refresh/);
    expect(spiffeBundleRefusal("step_up_required")).toBeNull();
  });
});
