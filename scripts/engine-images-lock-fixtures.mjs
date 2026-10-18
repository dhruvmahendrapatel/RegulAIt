/**
 * Test fixtures for the engine image signature checks: SYNTHETIC Sigstore bundles. The certificate is a throwaway
 * self-signed one made with openssl here (its URI SAN is the identity under test); nothing is signed by Sigstore, so
 * these exercise the structural checks and the cosign call, never cosign's cryptography.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectedIdentity, SIGN_PREDICATE } from "./engine-images-lock-verify.mjs";

const certs = new Map();
/** a DER certificate (base64) whose only URI SAN is `identity` */
export function certFor(identity = expectedIdentity()) {
  if (!certs.has(identity)) {
    const dir = mkdtempSync(path.join(tmpdir(), "engine-sig-cert-"));
    try {
      const der = path.join(dir, "c.der");
      execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "k.pem"), "-subj", "/O=synthetic-test", "-days", "1", "-addext", `subjectAltName=URI:${identity}`, "-outform", "DER", "-out", der], { stdio: "ignore" });
      certs.set(identity, readFileSync(der).toString("base64"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return certs.get(identity);
}

/** a keyless cosign image-signature bundle for `entry`, in the shape `cosign sign --bundle` writes (v0.3) */
export function bundleFor(entry, { identity = expectedIdentity(), digest = entry.manifestDigest, imageId = entry.imageId, sourceCommit = entry.sourceCommit, cert = true, tlog = true } = {}) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ digest: { sha256: digest.slice("sha256:".length) }, annotations: { imageId, sourceCommit } }],
    predicateType: SIGN_PREDICATE,
    predicate: {},
  };
  const verificationMaterial = {};
  if (cert) verificationMaterial.certificate = { rawBytes: certFor(identity) };
  else verificationMaterial.publicKey = { hint: "c3ludGhldGlj" };
  if (tlog) verificationMaterial.tlogEntries = [{ logIndex: "4242", logId: { keyId: "c3ludGhldGljLWxvZw==" }, kindVersion: { kind: "dsse", version: "0.0.1" }, integratedTime: "1760000000", inclusionPromise: { signedEntryTimestamp: "c3ludGhldGlj" }, inclusionProof: { logIndex: "4242", rootHash: "c3ludGhldGlj", treeSize: "4243", hashes: [], checkpoint: { envelope: "synthetic" } }, canonicalizedBody: "e30=" }];
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial,
    dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64"), payloadType: "application/vnd.in-toto+json", signatures: [{ sig: "c3ludGhldGlj" }] },
  };
}

/** write a bundle (and a placeholder trusted root) to a scratch dir; returns their paths and a cleanup */
export function scratch(bundle) {
  const dir = mkdtempSync(path.join(tmpdir(), "engine-sig-"));
  const bundleFile = path.join(dir, "e.sigstore.json");
  const trustedRoot = path.join(dir, "trusted_root.json");
  if (bundle !== undefined) writeFileSync(bundleFile, JSON.stringify(bundle));
  writeFileSync(trustedRoot, JSON.stringify({ mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1" }));
  return { dir, bundleFile, trustedRoot, done: () => rmSync(dir, { recursive: true, force: true }) };
}
