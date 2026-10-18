/**
 * ADR-0197 Q2 — the engine image signature check every use runs (the lock tooling, the image bundle and the
 * air-gapped installer): a valid keyless signature is accepted; a wrong identity, a missing signature and a tampered
 * digest are refused, and cosign is always asked with the pinned identity, issuer, workflow and digest.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundleFor, scratch } from "./engine-images-lock-fixtures.mjs";
import { COSIGN_SHA256, cosignVerifyArgs, expectedIdentity, inspectBundle, OIDC_ISSUER, REPO_SLUG, repositorySlug, resolveCosign, SIGN_PREDICATE, verifyEntrySignature, VerifyError } from "./engine-images-lock-verify.mjs";

const hex = (c) => `sha256:${c.repeat(64)}`;
const entry = { repository: "ghcr.io/x/regulait-engine-garak", manifestDigest: hex("1"), imageId: hex("2"), sourceCommit: "a".repeat(40) };
/** a fake cosign that records its calls and answers `status` */
const fakeCosign = (status = 0, stderr = "") => {
  const calls = [];
  const run = (args) => (calls.push(args), { status, stdout: "", stderr });
  return Object.assign(run, { calls });
};
const verify = (bundle, e = entry, cosign = fakeCosign()) => {
  const s = scratch(bundle);
  try {
    return verifyEntrySignature("garak", e, { bundleFile: s.bundleFile, trustedRoot: s.trustedRoot, cosign });
  } finally {
    s.done();
  }
};

describe("ADR-0197 Q2: verifying an engine image signature", () => {
  it("the expected identity is this repository's publish workflow on main, with the GitHub OIDC issuer", () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(REPO_SLUG).toBe(/github\.com\/([^/]+\/[^/.]+)/.exec(pkg.repository.url)[1]);
    expect(expectedIdentity()).toBe(`https://github.com/${REPO_SLUG}/.github/workflows/engine-images.yml@refs/heads/main`);
    expect(OIDC_ISSUER).toBe("https://token.actions.githubusercontent.com");
    // the case is kept: the certificate names the repository as GitHub does
    expect(repositorySlug({ repository: { url: "git+https://github.com/Some-Owner/RegulAIt.git" } })).toBe("Some-Owner/RegulAIt");
    expect(() => repositorySlug({ repository: "https://gitlab.com/a/b" })).toThrow(VerifyError);
  });

  it("valid: a keyless signature of exactly this entry by the expected identity is accepted, and cosign is asked offline with every pin", () => {
    const cosign = fakeCosign();
    const s = scratch(bundleFor(entry));
    try {
      const got = verifyEntrySignature("garak", entry, { bundleFile: s.bundleFile, trustedRoot: s.trustedRoot, cosign });
      expect(got).toMatchObject({ subjectDigest: entry.manifestDigest, certificateIdentity: expectedIdentity(), rekor: { logIndex: "4242" } });
      expect(cosign.calls).toEqual([cosignVerifyArgs({ bundleFile: s.bundleFile, trustedRoot: s.trustedRoot, digest: entry.manifestDigest })]);
    } finally {
      s.done();
    }
    const args = cosign.calls[0];
    const flag = (f) => args[args.indexOf(f) + 1];
    expect(args[0]).toBe("verify-blob-attestation");
    expect(flag("--certificate-identity")).toBe(expectedIdentity());
    expect(flag("--certificate-oidc-issuer")).toBe(OIDC_ISSUER);
    expect(flag("--certificate-github-workflow-repository")).toBe(REPO_SLUG);
    expect(flag("--certificate-github-workflow-ref")).toBe("refs/heads/main");
    expect(flag("--type")).toBe(SIGN_PREDICATE);
    expect(flag("--digest")).toBe("1".repeat(64));
    expect(flag("--digestAlg")).toBe("sha256");
    // the trust root is always a file (offline, so the same check runs air-gapped), never a regexp identity
    expect(args).toContain("--trusted-root");
    expect(args.join(" ")).not.toMatch(/regexp|insecure|--key\b/);
  });

  it("wrong identity: another workflow, a branch, or another repository is refused before cosign runs", () => {
    for (const identity of [
      `https://github.com/${REPO_SLUG}/.github/workflows/publish-image.yml@refs/heads/main`,
      `https://github.com/${REPO_SLUG}/.github/workflows/engine-images.yml@refs/heads/feature`,
      "https://github.com/someone-else/RegulAIt/.github/workflows/engine-images.yml@refs/heads/main",
    ]) {
      const cosign = fakeCosign();
      expect(() => verify(bundleFor(entry, { identity }), entry, cosign)).toThrow(/wrong identity/);
      expect(cosign.calls).toHaveLength(0);
    }
    // and whatever cosign itself refuses (the chain, the Rekor proof, the issuer) is refused
    expect(() => verify(bundleFor(entry), entry, fakeCosign(1, "error: none of the expected identities matched"))).toThrow(/cosign refused the signature \(exit 1\): error: none of the expected identities matched/);
  });

  it("missing signature: no bundle, a key-signed bundle, a bundle with no Rekor entry, or not a bundle at all is refused", () => {
    expect(() => verify(undefined)).toThrow(/no signature .*an unsigned image is never used/);
    expect(() => verify(bundleFor(entry, { cert: false }))).toThrow(/not a keyless signature/);
    expect(() => verify(bundleFor(entry, { tlog: false }))).toThrow(/no Rekor entry/);
    expect(() => verify({ hello: "world" })).toThrow(/not a Sigstore bundle/);
    const s = scratch(bundleFor(entry));
    try {
      expect(() => verifyEntrySignature("garak", entry, { bundleFile: s.bundleFile, trustedRoot: path.join(s.dir, "absent.json"), cosign: fakeCosign() })).toThrow(/no Sigstore trusted root/);
    } finally {
      s.done();
    }
  });

  it("tampered digest: a signature of another digest, image id or commit is refused before cosign runs", () => {
    for (const tampered of [{ ...entry, manifestDigest: hex("3") }, { ...entry, imageId: hex("4") }, { ...entry, sourceCommit: "b".repeat(40) }]) {
      const cosign = fakeCosign();
      expect(() => verify(bundleFor(entry), tampered, cosign)).toThrow(VerifyError);
      expect(cosign.calls).toHaveLength(0);
    }
    expect(() => verify(bundleFor(entry), { ...entry, manifestDigest: hex("3") })).toThrow(/tampered digest/);
    // a statement with two subjects, or another predicate, is not an image signature
    const two = bundleFor(entry);
    const st = JSON.parse(Buffer.from(two.dsseEnvelope.payload, "base64").toString());
    st.subject.push(st.subject[0]);
    two.dsseEnvelope.payload = Buffer.from(JSON.stringify(st)).toString("base64");
    expect(() => inspectBundle(two)).toThrow(/exactly one image/);
    st.subject.pop();
    st.predicateType = "https://slsa.dev/provenance/v1";
    two.dsseEnvelope.payload = Buffer.from(JSON.stringify(st)).toString("base64");
    expect(() => inspectBundle(two)).toThrow(/not a cosign image signature/);
  });

  it("cosign is used only when its SHA-256 is the pinned release's", () => {
    const s = scratch(undefined);
    try {
      const bin = path.join(s.dir, "cosign");
      writeFileSync(bin, "not cosign");
      const sha = createHash("sha256").update("not cosign").digest("hex");
      expect(resolveCosign({ bin, pins: { "linux-amd64": sha }, plat: "linux-amd64" })).toBe(bin);
      expect(() => resolveCosign({ bin, plat: "linux-amd64" })).toThrow(/is not cosign v3\.1\.3/);
      // found on PATH by name, and refused when absent
      expect(resolveCosign({ bin: undefined, pathEnv: s.dir, pins: { "linux-amd64": sha }, plat: "linux-amd64" })).toBe(bin);
      expect(() => resolveCosign({ bin: undefined, pathEnv: path.join(s.dir, "none"), plat: "linux-amd64" })).toThrow(/not installed/);
      expect(() => resolveCosign({ bin, plat: "plan9-mips" })).toThrow(/no pinned cosign checksum/);
    } finally {
      s.done();
    }
  });

  it("the pinned linux-amd64 cosign is the one both signing workflows download", () => {
    for (const wf of ["engine-images.yml", "publish-image.yml"]) {
      const text = readFileSync(path.join(import.meta.dirname, "..", ".github", "workflows", wf), "utf8");
      expect(text).toContain("cosign/releases/download/v3.1.3/cosign-linux-amd64");
      expect(text).toContain(`${COSIGN_SHA256["linux-amd64"]}  $RUNNER_TEMP/bin/cosign`);
    }
  });
});
