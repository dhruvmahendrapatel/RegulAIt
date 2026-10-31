/**
 * ADR-0216 review (#614): the trusted signing keys table follows X7, and revoking a key is confirmed first.
 * Rendered with react-dom/server (no DOM); the click-through is the mock spec `adr0216-signing-keys.mock.spec.ts`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SigningKeyActions } from "./SupplyChainPanel";
import { revokeKeyConfirm, type SigningKey } from "./supplyChain";

const key = (over: Partial<SigningKey> = {}): SigningKey => ({
  id: "99999999-9999-4000-8000-000000000216",
  name: "release key",
  algorithm: "ecdsa_p256_sha256",
  keyHint: "a".repeat(64),
  createdAt: "2026-10-30T10:00:00.000Z",
  revokedAt: null,
  ...over,
});
/** the three X7 slots (primary, secondary, rest) of the one RowActions grid */
function slots(html: string): string[] {
  const grid = /^<div[^>]*>(.*)<\/div>$/s.exec(html);
  expect(grid, html).not.toBeNull();
  return [...grid![1]!.matchAll(/<span>(.*?)<\/span>/gs)].map((m) => m[1]!);
}

describe("ADR-0216 signing key row actions (X7)", () => {
  it("a trusted key: the primary slot is empty and Revoke sits in the last slot", () => {
    const s = slots(renderToStaticMarkup(<SigningKeyActions signingKey={key()} onRevoke={() => undefined} />));
    expect(s).toHaveLength(3);
    expect(s[0]).toBe("");
    expect(s[1]).toBe("");
    expect(s[2]).toContain('aria-label="Revoke release key"');
    expect(s[2]).toContain(">Revoke</button>");
  });

  it("a revoked key keeps the same three slots, all empty, so the column does not shift", () => {
    const html = renderToStaticMarkup(<SigningKeyActions signingKey={key({ revokedAt: "2026-10-31T00:00:00.000Z" })} onRevoke={() => undefined} />);
    expect(slots(html)).toEqual(["", "", ""]);
    expect(html).not.toContain("Revoke");
  });

  it("the confirmation names the key and the consequence", () => {
    expect(revokeKeyConfirm("release key")).toEqual({
      title: "Revoke signing key release key?",
      body: "Model files signed only by this key will be blocked at once, and the key can never be trusted again.",
    });
  });
});
