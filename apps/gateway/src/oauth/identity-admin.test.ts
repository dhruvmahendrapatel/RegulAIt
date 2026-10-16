/**
 * ADR-0188 S6 — credential registration, without a database: what
 * `prepareCredential` keeps of a public credential, and every refusal it
 * makes before anything could be stored. The routes, their step-up, audit and
 * revocation cascades are proved through the real app in
 * `zz-adr0188-s6-identity-admin.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { calculateJwkThumbprint } from "jose";
import { makeCert } from "../testing/x509-fixtures.js";
import { certificateThumbprint } from "./x509.js";
import {
  IdentityAdminError,
  identityCreateStepUp,
  credentialAddStepUp,
  NO_SPIFFE_TRUST_DOMAINS,
  prepareCredential,
  withProposals,
  type PreparedCredential,
} from "./identity-admin.js";

const NOW = new Date();
// ADR-0188 S9: the trust domains come from the bundle table; none here
const NO_ENV = NO_SPIFFE_TRUST_DOMAINS;

async function ok(p: Promise<PreparedCredential | IdentityAdminError>): Promise<PreparedCredential> {
  const out = await p;
  if (out instanceof IdentityAdminError) throw new Error(`refused ${out.code}: ${out.message}`);
  return out;
}
async function refused(p: Promise<PreparedCredential | IdentityAdminError>): Promise<string> {
  const out = await p;
  if (!(out instanceof IdentityAdminError)) throw new Error("accepted, expected a refusal");
  return out.code;
}

describe("a JWK credential", () => {
  it("keeps only the RFC 7638 members, with the RFC 7638 thumbprint (RFC 8037 A.3 vector)", async () => {
    const x = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const out = await ok(prepareCredential({ kind: "jwk", publicJwk: { kty: "OKP", crv: "Ed25519", x, kid: "caller-kid", use: "sig" } as never }, NOW, NO_ENV));
    expect(out.publicJwk).toEqual({ kty: "OKP", crv: "Ed25519", x });
    expect(out.jwkThumbprint).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
    expect(out).toMatchObject({ kind: "jwk", x5tS256: null, spiffeId: null, selfSigned: false, certificateNotAfter: null });
  });

  it("accepts a real P-256 public key", async () => {
    const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" }) as Record<string, string>;
    const out = await ok(prepareCredential({ kind: "jwk", publicJwk: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! } }, NOW, NO_ENV));
    expect(out.publicJwk).toEqual({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y });
    expect(out.jwkThumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses a P-256 point that is not on the curve (jose builds the key; nothing invalid is stored)", async () => {
    const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" }) as Record<string, string>;
    // flip a real bit of the decoded coordinate: editing the last base64url character can change only its two padding
    // bits, which decode to the same y, so the point stayed on the curve in about one run in eight
    const yBytes = Buffer.from(jwk.y!, "base64url");
    const last = yBytes.length - 1;
    yBytes[last] = yBytes[last]! ^ 0x01;
    const y = yBytes.toString("base64url");
    expect(await refused(prepareCredential({ kind: "jwk", publicJwk: { kty: "EC", crv: "P-256", x: jwk.x!, y } }, NOW, NO_ENV))).toBe("credential_invalid");
  });
});

describe("a certificate credential", () => {
  it("keeps the thumbprint, the one URI SAN and the subject; never outlives the certificate", async () => {
    const ca = await makeCert({ isCA: true, name: "s6-ca" });
    const leaf = await makeCert({ issuer: ca, name: "s6-leaf", uris: ["spiffe://example.org/worker/one"] });
    const out = await ok(prepareCredential({ kind: "x509", certificatePem: leaf.pem, selfSigned: false }, NOW, NO_ENV));
    expect(out.x5tS256).toBe(certificateThumbprint(leaf.der));
    expect(out.sanUri).toBe("spiffe://example.org/worker/one");
    expect(out.subjectDn).toContain("s6-leaf");
    expect(out.certificateNotAfter!.getTime()).toBe(leaf.cert.notAfter.value.getTime() - (leaf.cert.notAfter.value.getTime() % 1000));
    expect(out).toMatchObject({ kind: "x509", publicJwk: null, jwkThumbprint: null, selfSigned: false });
  });

  it("accepts a self-signed certificate only when it really is signed by its own key", async () => {
    const self = await makeCert({ name: "s6-self" });
    expect((await ok(prepareCredential({ kind: "x509", certificatePem: self.pem, selfSigned: true }, NOW, NO_ENV))).selfSigned).toBe(true);
    const ca = await makeCert({ isCA: true });
    const issued = await makeCert({ issuer: ca });
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: issued.pem, selfSigned: true }, NOW, NO_ENV))).toBe("certificate_not_self_signed");
  });

  it("refuses a PEM carrying a private key, before parsing anything", async () => {
    const self = await makeCert();
    const priv = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: self.pem + priv, selfSigned: true }, NOW, NO_ENV))).toBe("credential_private_material");
    const ecPriv = "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n";
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: ecPriv + self.pem, selfSigned: true }, NOW, NO_ENV))).toBe("credential_private_material");
  });

  it("refuses two certificates, garbage, a CA as a client certificate, and one outside its validity", async () => {
    const a = await makeCert();
    const b = await makeCert();
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: a.pem + b.pem, selfSigned: true }, NOW, NO_ENV))).toBe("credential_invalid");
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n", selfSigned: false }, NOW, NO_ENV))).toBe("credential_invalid");
    const ca = await makeCert({ isCA: true });
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: ca.pem, selfSigned: false }, NOW, NO_ENV))).toBe("certificate_leaf_ca");
    const old = await makeCert({ notBefore: new Date(Date.now() - 3 * 86_400_000), notAfter: new Date(Date.now() - 86_400_000) });
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: old.pem, selfSigned: true }, NOW, NO_ENV))).toBe("certificate_time");
    const future = await makeCert({ notBefore: new Date(Date.now() + 86_400_000), notAfter: new Date(Date.now() + 2 * 86_400_000) });
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: future.pem, selfSigned: true }, NOW, NO_ENV))).toBe("certificate_time");
  });
});

describe("a SPIFFE ID credential", () => {
  it("needs an uploaded trust bundle for its trust domain (SPIFFE is off by default)", async () => {
    const body = { kind: "spiffe_id" as const, spiffeId: "spiffe://example.org/worker/one" };
    expect(await refused(prepareCredential(body, NOW, NO_ENV))).toBe("spiffe_trust_domain_unknown");
    // ADR-0188 S9: the active bundles' domains (the route reads them from spiffe_trust_bundles)
    const uploaded = async (): Promise<ReadonlySet<string>> => new Set(["example.org"]);
    expect((await ok(prepareCredential(body, NOW, uploaded))).spiffeId).toBe(body.spiffeId);
    expect(await refused(prepareCredential({ ...body, spiffeId: "spiffe://other.org/worker/one" }, NOW, uploaded))).toBe("spiffe_trust_domain_unknown");
    // the bundle table cannot be read: fail closed, nothing stored
    const unreadable = async (): Promise<ReadonlySet<string>> => {
      throw new Error("database unavailable");
    };
    expect(await refused(prepareCredential(body, NOW, unreadable))).toBe("trust_config_invalid");
  });
});

describe("step-up facts bind exactly the write", () => {
  it("a different create body or credential is a different digest", () => {
    const a = identityCreateStepUp({ kind: "worker_runtime", sponsorUserIds: ["00000000-0000-4000-8000-000000000001"], environments: ["dev"] });
    const b = identityCreateStepUp({ kind: "worker_runtime", sponsorUserIds: ["00000000-0000-4000-8000-000000000001"], environments: ["prod"] });
    expect(a.kind).toBe("identity_manage");
    expect(a.facts.bodyDigest).not.toBe(b.facts.bodyDigest);
    const id = "00000000-0000-4000-8000-000000000009";
    const c1 = credentialAddStepUp(id, { kind: "spiffe_id", spiffeId: "spiffe://example.org/a" });
    const c2 = credentialAddStepUp(id, { kind: "spiffe_id", spiffeId: "spiffe://example.org/b" });
    expect(c1.facts).toMatchObject({ op: "credential_add", identityId: id });
    expect(c1.facts.credentialDigest).not.toBe(c2.facts.credentialDigest);
  });
});

describe("security review fixes (PR #368), without a database", () => {
  it("Low 5: a certificate credential carries its PUBLIC KEY's RFC 7638 thumbprint, the same value its JWK would", async () => {
    const cert = await makeCert({ name: "s6-spki" });
    const out = await ok(prepareCredential({ kind: "x509", certificatePem: cert.pem, selfSigned: true }, NOW, NO_ENV));
    const jwk = (await webcrypto.subtle.exportKey("jwk", cert.key.publicKey)) as { kty: string; crv: string; x: string; y: string };
    const asJwk = await ok(prepareCredential({ kind: "jwk", publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } }, NOW, NO_ENV));
    expect(out.spkiThumbprint).toBe(await calculateJwkThumbprint({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, "sha256"));
    expect(out.spkiThumbprint).toBe(asJwk.jwkThumbprint);
    expect(asJwk.spkiThumbprint).toBeNull();
  });

  it("Medium 3: proposals merge onto a set without changing it, per target", () => {
    const set = { tools: [], servers: [], agents: [{ agentId: "a", allowedModes: ["plan"] }], connectors: [], roleIds: [], revision: 3 };
    const out = withProposals(set, [
      { kind: "agent", agentId: "a", allowedModes: ["execute"] },
      { kind: "connector", connectorId: "c", mode: "read", allowedObjects: ["x"] },
      { kind: "connector", connectorId: "c", mode: "readwrite", allowedObjects: ["y"] },
    ]);
    expect(out.agents).toEqual([{ agentId: "a", allowedModes: ["plan", "execute"] }]);
    expect(out.connectors).toEqual([{ connectorId: "c", mode: "readwrite", allowedObjects: ["x", "y"] }]);
    expect(out.revision).toBe(3);
    expect(set.agents[0]!.allowedModes).toEqual(["plan"]);
  });

  it("Medium 2: migration 0193 is the next journal entry, its `when` strictly after the previous, and spells the query's index predicates", () => {
    const root = new URL("../../../../packages/db/migrations/", import.meta.url);
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", root), "utf8")) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === "0193_identity_s6_review");
    expect(at).toBeGreaterThan(0);
    const mine = journal.entries[at]!;
    expect(mine.idx).toBe(journal.entries[at - 1]!.idx + 1);
    for (const e of journal.entries.slice(0, at)) expect(mine.when).toBeGreaterThan(e.when);
    for (const e of journal.entries.slice(at + 1)) expect(e.when).toBeGreaterThan(mine.when);
    const migration = readFileSync(new URL("0193_identity_s6_review.sql", root), "utf8");
    const source = readFileSync(new URL("./identity-admin.ts", import.meta.url), "utf8");
    expect(migration).toContain(`WHERE "actor_identity_id" IS NOT NULL AND ("detail" ->> 'receiptClass') = 'decision'`);
    expect(migration).toContain(`WHERE "actor_identity_id" IS NULL AND "detail" ? 'delegation' AND ("detail" ->> 'receiptClass') = 'decision'`);
    expect(source).toContain("where actor_identity_id = ${identityId} and (detail ->> 'receiptClass') = 'decision' and at > ${since}");
    expect(source).toContain("where actor_identity_id is null and detail ? 'delegation' and (detail ->> 'receiptClass') = 'decision'");
    expect(source).toContain("set local statement_timeout");
  });
});
