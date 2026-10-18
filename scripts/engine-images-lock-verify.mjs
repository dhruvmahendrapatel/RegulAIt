#!/usr/bin/env node
/**
 * ENG-IMG Q2 (ADR-0197 owner decision Q2; ADR-0190 "As built: engine image signing") — VERIFY AN ENGINE IMAGE'S
 * KEYLESS SIGNATURE BEFORE IT IS USED.
 *
 * The publish job (`.github/workflows/engine-images.yml`, job `publish`) signs each pushed manifest digest with cosign
 * keyless (the job's GitHub OIDC token, a Fulcio certificate, a Rekor entry) and writes the Sigstore bundle cosign
 * returns. The signed statement's one subject is the manifest digest, and its annotations are the image id and the
 * source commit (`cosign sign -a imageId=... -a sourceCommit=...`), so the signature covers the whole lock entry
 * an executor relies on, not only the digest. `--apply` (`engine-images-lock.mjs`) commits each bundle as
 * `engines/signatures/<engine>.sigstore.json`, and the Sigstore trusted root it verified them with as
 * `engines/signatures/trusted_root.json`.
 *
 * A signature is accepted only when ALL of these hold:
 *   1. the bundle exists (an unsigned image is refused, never warned about: ADR-0180);
 *   2. its statement signs exactly the lock entry: subject sha256 = manifestDigest, annotations imageId and
 *      sourceCommit equal the entry's (a tampered digest or a swapped image id is refused here, before cosign runs);
 *   3. its Fulcio certificate names this repository's publish workflow on main
 *      (https://github.com/<owner>/<repo>/.github/workflows/engine-images.yml@refs/heads/main);
 *   4. cosign, pinned by SHA-256 (`COSIGN_SHA256`), verifies it against the trusted root FILE (offline: no network,
 *      so the same check runs air-gapped): the certificate chain to Fulcio, the Rekor inclusion, the expected
 *      identity, OIDC issuer, workflow repository and workflow ref, the predicate type and the digest.
 * Checks 2 and 3 read the bundle without cryptography and exist so that a refusal says why; check 4 is the proof.
 *
 *   node scripts/engine-images-lock-verify.mjs                     verify every published lock entry (exit 1 on any refusal)
 *   node scripts/engine-images-lock-verify.mjs --engine garak      verify one
 *   node scripts/engine-images-lock-verify.mjs --signed <engine.json> --bundle <file> --trusted-root <file>
 *        (the publish job) verify a fresh signature for <engine.json> and add its `signature` record to the file
 * env: COSIGN (the cosign binary; default the first `cosign` on PATH), checked against the pinned SHA-256.
 */
import { createHash, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SIGNATURES_DIR = path.join(ROOT, "engines/signatures");
export const TRUSTED_ROOT = path.join(SIGNATURES_DIR, "trusted_root.json");
export const bundlePath = (engine) => path.join(SIGNATURES_DIR, `${engine}.sigstore.json`);

export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const SIGN_PREDICATE = "https://sigstore.dev/cosign/sign/v1";
export const PUBLISH_WORKFLOW = ".github/workflows/engine-images.yml";
export const WORKFLOW_REF = "refs/heads/main";
/** cosign v3.1.3, from the release's cosign_checksums.txt (linux-amd64 is also publish-image.yml's pin) */
export const COSIGN_VERSION = "v3.1.3";
export const COSIGN_SHA256 = Object.freeze({
  "linux-amd64": "4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71",
  "linux-arm64": "c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a",
  "darwin-amd64": "2347488e5d5b25336644024dfeca5601b190e91197a71a917bda44744aff106c",
  "darwin-arm64": "5cf948c2f4dfe59687bdd0b8523709067383e03982cc543475c8a7dc70e92a76",
});
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export class VerifyError extends Error {}

/** `<owner>/<repo>` exactly as package.json `repository` names it: the Fulcio certificate keeps GitHub's case */
export function repositorySlug(pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))) {
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const m = /^(?:git\+)?https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(url ?? "");
  if (!m) throw new VerifyError("package.json must name this repository as a https://github.com/<owner>/<repo> URL (the signing identity is pinned to it)");
  return `${m[1]}/${m[2]}`;
}
export const REPO_SLUG = repositorySlug();

/** the only certificate identity an engine image signature may carry: this repository's publish workflow on main */
export const expectedIdentity = (slug = REPO_SLUG) => `https://github.com/${slug}/${PUBLISH_WORKFLOW}@${WORKFLOW_REF}`;

/**
 * Read a Sigstore bundle (no cryptography): the signed in-toto statement, the certificate's URI SAN and the first
 * Rekor entry. Throws VerifyError when it is not a keyless cosign image signature.
 */
export function inspectBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || !String(bundle.mediaType ?? "").startsWith("application/vnd.dev.sigstore.bundle")) {
    throw new VerifyError("not a Sigstore bundle");
  }
  const env = bundle.dsseEnvelope;
  if (!env || env.payloadType !== "application/vnd.in-toto+json" || typeof env.payload !== "string") throw new VerifyError("the bundle carries no in-toto statement");
  let statement;
  try {
    statement = JSON.parse(Buffer.from(env.payload, "base64").toString("utf8"));
  } catch {
    throw new VerifyError("the bundle's statement is not JSON");
  }
  if (statement.predicateType !== SIGN_PREDICATE) throw new VerifyError(`the statement is not a cosign image signature (${statement.predicateType})`);
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) throw new VerifyError("the statement must sign exactly one image");
  const hex = statement.subject[0]?.digest?.sha256;
  if (!/^[0-9a-f]{64}$/.test(hex ?? "")) throw new VerifyError("the statement's subject names no sha256 digest");
  const vm = bundle.verificationMaterial ?? {};
  const raw = vm.certificate?.rawBytes ?? vm.x509CertificateChain?.certificates?.[0]?.rawBytes;
  if (typeof raw !== "string") throw new VerifyError("the bundle has no certificate: it is not a keyless signature");
  let san;
  try {
    san = new X509Certificate(Buffer.from(raw, "base64")).subjectAltName ?? "";
  } catch {
    throw new VerifyError("the bundle's certificate does not parse");
  }
  const uris = san.split(/,\s*/).filter((s) => s.startsWith("URI:")).map((s) => s.slice(4));
  if (uris.length !== 1) throw new VerifyError("the certificate must name exactly one URI identity");
  const t = Array.isArray(vm.tlogEntries) ? vm.tlogEntries[0] : undefined;
  if (!t || t.logIndex === undefined || !t.logId?.keyId) throw new VerifyError("the bundle has no Rekor entry");
  return {
    subjectDigest: `sha256:${hex}`,
    annotations: statement.subject[0].annotations ?? {},
    certificateIdentity: uris[0],
    rekor: { logIndex: String(t.logIndex), logId: t.logId.keyId, integratedTime: String(t.integratedTime ?? "") },
  };
}

/** checks 2 and 3: the bundle signs exactly this entry, by the expected identity */
export function checkBundleForEntry(bundle, entry, { identity = expectedIdentity() } = {}) {
  const got = inspectBundle(bundle);
  if (got.subjectDigest !== entry.manifestDigest) throw new VerifyError(`the signature is for ${got.subjectDigest}, not the manifest digest ${entry.manifestDigest} (tampered digest)`);
  if (got.annotations.imageId !== entry.imageId) throw new VerifyError(`the signature names image id ${got.annotations.imageId}, not ${entry.imageId}`);
  if (got.annotations.sourceCommit !== entry.sourceCommit) throw new VerifyError(`the signature names source commit ${got.annotations.sourceCommit}, not ${entry.sourceCommit}`);
  if (got.certificateIdentity !== identity) throw new VerifyError(`the signature's identity is ${got.certificateIdentity}, not ${identity} (wrong identity)`);
  return got;
}

/** the cosign arguments for check 4 (exported so the tests and the docs name the exact command) */
export function cosignVerifyArgs({ bundleFile, trustedRoot, digest, identity = expectedIdentity(), slug = REPO_SLUG }) {
  return [
    "verify-blob-attestation",
    "--bundle", bundleFile,
    "--trusted-root", trustedRoot,
    "--certificate-identity", identity,
    "--certificate-oidc-issuer", OIDC_ISSUER,
    "--certificate-github-workflow-repository", slug,
    "--certificate-github-workflow-ref", WORKFLOW_REF,
    "--type", SIGN_PREDICATE,
    "--digest", digest.slice("sha256:".length),
    "--digestAlg", "sha256",
  ];
}

const platform = () => `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;

/** the cosign binary (env COSIGN, else the first on PATH), refused unless its SHA-256 is the pinned one */
export function resolveCosign({ bin = process.env.COSIGN, pathEnv = process.env.PATH ?? "", pins = COSIGN_SHA256, plat = platform() } = {}) {
  let file = bin;
  if (!file || !file.includes(path.sep)) {
    const name = file || "cosign";
    file = pathEnv.split(path.delimiter).map((d) => path.join(d, name)).find((p) => existsSync(p));
    if (!file) throw new VerifyError(`cosign ${COSIGN_VERSION} is not installed (set COSIGN to its path); an engine image is never used unverified`);
  }
  if (!existsSync(file)) throw new VerifyError(`cosign not found at ${file}`);
  const want = pins[plat];
  if (!want) throw new VerifyError(`no pinned cosign checksum for ${plat}`);
  const got = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (got !== want) throw new VerifyError(`${file} is not cosign ${COSIGN_VERSION} for ${plat} (sha256 ${got}, pinned ${want})`);
  return file;
}

const defaultCosign = (args) => {
  const r = spawnSync(resolveCosign(), args, { encoding: "utf8" });
  if (r.error) throw new VerifyError(`cosign did not run: ${r.error.message}`);
  return r;
};

/**
 * Verify one lock entry's signature (checks 1 to 4). `cosign` is injectable for tests: it gets the argument list and
 * returns `{ status, stdout, stderr }`.
 */
export function verifyEntrySignature(engine, entry, { bundleFile = bundlePath(engine), trustedRoot = TRUSTED_ROOT, identity = expectedIdentity(), cosign = defaultCosign } = {}) {
  if (!entry || !DIGEST.test(entry.manifestDigest ?? "")) throw new VerifyError(`${engine}: no published image to verify`);
  if (!existsSync(bundleFile)) throw new VerifyError(`${engine}: no signature (${path.relative(ROOT, bundleFile)} is missing): an unsigned image is never used`);
  if (!existsSync(trustedRoot)) throw new VerifyError(`${engine}: no Sigstore trusted root at ${trustedRoot}`);
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(bundleFile, "utf8"));
  } catch {
    throw new VerifyError(`${engine}: ${bundleFile} is not JSON`);
  }
  let got;
  try {
    got = checkBundleForEntry(bundle, entry, { identity });
  } catch (e) {
    throw new VerifyError(`${engine}: ${e.message}`);
  }
  const r = cosign(cosignVerifyArgs({ bundleFile, trustedRoot, digest: entry.manifestDigest, identity }));
  if (r.status !== 0) {
    const why = `${r.stderr ?? ""}`.trim().split("\n").slice(-2).join(" ");
    throw new VerifyError(`${engine}: cosign refused the signature (exit ${r.status}): ${why}`);
  }
  return got;
}

/** the record the publish artifact carries for one signed image (ADR-0197 Q2: identity and Rekor entry) */
export function signatureRecord(bundle, got) {
  return {
    bundle,
    certificateIdentity: got.certificateIdentity,
    certificateOidcIssuer: OIDC_ISSUER,
    workflowRepository: REPO_SLUG,
    workflowRef: WORKFLOW_REF,
    rekor: got.rekor,
  };
}

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  if (argv.includes("--signed")) {
    // the publish job: <engine.json> is build-engine-image.sh's output, the bundle is what `cosign sign --bundle` wrote
    const file = opt("--signed");
    const bundleFile = opt("--bundle");
    const trustedRoot = opt("--trusted-root");
    const sourceCommit = opt("--source-commit");
    if (!file || !bundleFile || !trustedRoot || !sourceCommit) throw new VerifyError("--signed needs <engine.json> --bundle <file> --trusted-root <file> --source-commit <sha>");
    const e = JSON.parse(readFileSync(file, "utf8"));
    const got = verifyEntrySignature(e.engine, { ...e, sourceCommit }, { bundleFile, trustedRoot });
    writeFileSync(file, `${JSON.stringify({ ...e, signature: signatureRecord(JSON.parse(readFileSync(bundleFile, "utf8")), got) })}\n`);
    console.log(`${e.engine}: signed by ${got.certificateIdentity}; Rekor log index ${got.rekor.logIndex}`);
    return 0;
  }
  const lock = JSON.parse(readFileSync(path.join(ROOT, "engines/images.lock.json"), "utf8"));
  const trustedRoot = opt("--trusted-root") ?? TRUSTED_ROOT;
  const only = opt("--engine");
  const ids = only ? [only] : Object.keys(lock.engines);
  let failed = 0;
  for (const id of ids) {
    const entry = lock.engines[id];
    if (!entry) throw new VerifyError(`unknown engine: ${id}`);
    if (entry.manifestDigest === null) {
      console.log(`${id}: never published (nothing to verify; placement refuses it)`);
      continue;
    }
    try {
      const got = verifyEntrySignature(id, entry, { trustedRoot });
      console.log(`${id}: verified ${entry.repository}@${entry.manifestDigest}, signed by ${got.certificateIdentity} (Rekor log index ${got.rekor.logIndex})`);
    } catch (e) {
      failed += 1;
      console.error(`engine image signature: ${e.message}`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`engine image signature: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
