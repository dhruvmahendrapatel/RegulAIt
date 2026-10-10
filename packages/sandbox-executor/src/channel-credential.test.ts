/**
 * ADR-0190 I3 — the channel credential: the one-use request proof binds the
 * method, the route, the moment and the exact body; the report signature is
 * a detached JWS over the canonical text that fails on any change.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { decodeProtectedHeader, flattenedVerify, importJWK, jwtVerify } from "jose";
import { canonicalExecutorReport, EXECUTOR_PROOF_HEADER, EXECUTOR_PROOF_TYP, RESTRICTED_EXECUTION_PROFILE, executionProfileDigest } from "@regulait/shared";
import { bodyHash, ProofChannelCredential } from "./channel-credential.js";
import { generateExecutorKey } from "./keys.js";
import { buildReport } from "./report.js";
import { FakeSandboxBackend } from "./fake-backend.js";

const ISSUER = "https://gateway.test";
const ID = "spiffe://test.example/regulait/worker_runtime/exec-1";

describe("ProofChannelCredential", () => {
  it("signs a one-use proof binding method, route (no query), body hash, issuer/subject/audience, iat and jti", async () => {
    const key = await generateExecutorKey();
    const cred = new ProofChannelCredential({ identifier: ID, key, issuer: ISSUER, nowSeconds: () => 1_800_000_000 });
    const body = JSON.stringify({ hello: "world" });
    const headers = await cred.authorizeRequest("post", `${ISSUER}/v1/executor-channel/announce?window=3`, body);
    const proof = headers[EXECUTOR_PROOF_HEADER]!;
    expect(decodeProtectedHeader(proof)).toMatchObject({ alg: "EdDSA", typ: EXECUTOR_PROOF_TYP, kid: key.thumbprint });
    const { payload } = await jwtVerify(proof, await importJWK(key.publicJwk, "EdDSA"), { issuer: ID, subject: ID, audience: ISSUER, typ: EXECUTOR_PROOF_TYP });
    expect(payload.htm).toBe("POST");
    expect(payload.htu).toBe(`${ISSUER}/v1/executor-channel/announce`);
    expect(payload.bh).toBe(createHash("sha256").update(body).digest("base64url"));
    expect(payload.iat).toBe(1_800_000_000);
    expect(typeof payload.jti).toBe("string");
    // a second proof for the same request is a different proof (fresh jti): nothing is reusable
    const again = await cred.authorizeRequest("POST", `${ISSUER}/v1/executor-channel/announce`, body);
    expect(again[EXECUTOR_PROOF_HEADER]).not.toBe(proof);
  });

  it("the body hash covers the exact bytes (an empty hash for no body)", () => {
    expect(bodyHash(undefined)).toBe(createHash("sha256").update("").digest("base64url"));
    expect(bodyHash('{"a":1}')).not.toBe(bodyHash('{"a":1 }'));
  });

  it("a proof from another key does not verify under the registered key", async () => {
    const registered = await generateExecutorKey();
    const other = await generateExecutorKey();
    const cred = new ProofChannelCredential({ identifier: ID, key: other, issuer: ISSUER });
    const proof = (await cred.authorizeRequest("GET", `${ISSUER}/v1/executor-channel/stream`, undefined))[EXECUTOR_PROOF_HEADER]!;
    await expect(jwtVerify(proof, await importJWK(registered.publicJwk, "EdDSA"))).rejects.toThrow();
  });

  it("signs a report as a detached JWS over the canonical text; any change breaks it", async () => {
    const key = await generateExecutorKey();
    const cred = new ProofChannelCredential({ identifier: ID, key, issuer: ISSUER });
    const backend = new FakeSandboxBackend();
    const canary = await backend.startCanary(RESTRICTED_EXECUTION_PROFILE, "user_space_kernel");
    const probes = await canary.probe(RESTRICTED_EXECUTION_PROFILE.attestation.probes);
    const report = buildReport({ kind: "self_test", identifier: ID, backend: backend.describe(), profileDigest: executionProfileDigest(RESTRICTED_EXECUTION_PROFILE), cls: "user_space_kernel", probes });
    const signed = await cred.signReport(report);
    const pub = await importJWK(key.publicJwk, "EdDSA");
    const header = decodeProtectedHeader({ protected: signed.signature.protected, signature: signed.signature.signature, payload: "" } as never);
    expect(header).toMatchObject({ alg: "EdDSA", kid: key.thumbprint, b64: false, crit: ["b64"] });
    await expect(flattenedVerify({ ...signed.signature, payload: canonicalExecutorReport(signed.report) }, pub)).resolves.toBeTruthy();
    // the same body re-serialised in another key order is the same canonical text: still verifies
    const reordered = Object.fromEntries(Object.entries(signed.report).reverse()) as typeof signed.report;
    await expect(flattenedVerify({ ...signed.signature, payload: canonicalExecutorReport(reordered) }, pub)).resolves.toBeTruthy();
    // one probe value changed: the signature no longer covers it
    const tampered = structuredClone(signed.report);
    (tampered.probes.proc_status as { observed: { capEff: string } }).observed.capEff = "0000000000000001";
    await expect(flattenedVerify({ ...signed.signature, payload: canonicalExecutorReport(tampered) }, pub)).rejects.toThrow();
  });
});
