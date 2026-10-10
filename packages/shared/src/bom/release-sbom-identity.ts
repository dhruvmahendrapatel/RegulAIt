/**
 * ADR-0189 slice B7, amendment R9 — the RELEASE SBOM IDENTITY FILE and the
 * CycloneDX BOM-Link to ADR-0184's SBOMs.
 *
 * ADR-0184's `security.yml` writes CycloneDX SBOMs of the workspace and the
 * image with Trivy, but only as CI artifacts, so nothing downstream has a
 * trusted source for their serials, versions and hashes. B7 has the release
 * step write, per release, one small identity file
 * (`regulait.release-sbom-identity.v1`: serialNumber, version, SHA-256 and kind
 * for each SBOM, plus the image digest and the release commit), signed by the
 * same keyless cosign identity that signs the scanned image.
 *
 * An install-scope AI BOM may cite those SBOMs ONLY from an identity whose
 * signature was verified (`verifiedReleaseSbomRecords` takes the verification
 * outcome as a typed argument; the signature itself is checked by cosign, in
 * CI, and at install time against the trust root of owner item 2). Without a
 * verified identity the builder omits the `externalReferences` and keeps the
 * subject in an `incomplete` composition (B3's
 * `release_sbom_identity_not_available` gap).
 *
 * Every shape check is a flat, anchored, length-capped character class
 * (CodeQL js/redos, M-074). Nothing here reads the network or a clock.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { bomDigestSchema, bomIntSchema } from "./contract.js";
import { bomSafeIssue } from "./ai-dev-stack.js";

export const RELEASE_SBOM_IDENTITY_VERSION = "regulait.release-sbom-identity.v1";
/** the two SBOMs ADR-0184's `image` job writes */
export const RELEASE_SBOM_KINDS = ["workspace", "image"] as const;
export type ReleaseSbomKind = (typeof RELEASE_SBOM_KINDS)[number];
/** how a release SBOM identity's signature was verified before use (owner item 2 picks the install-time trust root) */
export const RELEASE_SBOM_VERIFICATION_METHODS = ["sigstore_keyless_ci", "release_trust_root"] as const;
export type ReleaseSbomVerificationMethod = (typeof RELEASE_SBOM_VERIFICATION_METHODS)[number];
/** a release SBOM file larger than this is refused before it is parsed */
export const RELEASE_SBOM_MAX_BYTES = 256 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

const isSerial = (v: string) => v.length === 45 && v.startsWith("urn:uuid:") && UUID.test(v.slice(9));
export const releaseSbomSerialSchema = z.string().max(45).refine(isSerial, "urn:uuid:<lower-case uuid>");
export const releaseCommitSchema = z.string().max(40).refine((v) => COMMIT.test(v), "a 40-hex commit id");
export const releaseImageDigestSchema = z.string().max(71).refine((v) => IMAGE_DIGEST.test(v), "sha256:<64 hex>");

export const releaseSbomEntrySchema = z
  .object({
    kind: z.enum(RELEASE_SBOM_KINDS),
    serialNumber: releaseSbomSerialSchema,
    version: bomIntSchema.positive(),
    /** SHA-256 of the exact SBOM file bytes */
    sha256: bomDigestSchema,
  })
  .strict();
export type ReleaseSbomEntry = z.infer<typeof releaseSbomEntrySchema>;

export const releaseSbomIdentitySchema = z
  .object({
    v: z.literal(RELEASE_SBOM_IDENTITY_VERSION),
    commit: releaseCommitSchema,
    imageDigest: releaseImageDigestSchema,
    sboms: z.array(releaseSbomEntrySchema).length(RELEASE_SBOM_KINDS.length),
  })
  .strict()
  .superRefine((f, ctx) => {
    const kinds = f.sboms.map((s) => s.kind);
    if (new Set(kinds).size !== kinds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sboms"], message: "one entry per SBOM kind" });
    if (f.sboms.some((s, i) => i > 0 && f.sboms[i - 1]!.kind > s.kind)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sboms"], message: "sorted by kind" });
  });
export type ReleaseSbomIdentity = z.infer<typeof releaseSbomIdentitySchema>;

export class ReleaseSbomIdentityError extends Error {
  constructor(message: string) {
    super(`release sbom identity refused: ${message}`);
    this.name = "ReleaseSbomIdentityError";
  }
}
const fail = (m: string): never => {
  throw new ReleaseSbomIdentityError(m);
};

/** read the identity of one CycloneDX SBOM file from its exact bytes */
export function releaseSbomEntryFromBytes(kind: ReleaseSbomKind, bytes: Uint8Array): ReleaseSbomEntry {
  if (bytes.byteLength > RELEASE_SBOM_MAX_BYTES) fail(`${kind} SBOM is larger than ${RELEASE_SBOM_MAX_BYTES} bytes`);
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return fail(`${kind} SBOM is not JSON`);
  }
  const d = (doc ?? {}) as Record<string, unknown>;
  if (d.bomFormat !== "CycloneDX") fail(`${kind} SBOM is not a CycloneDX document`);
  const serialNumber = typeof d.serialNumber === "string" ? d.serialNumber.toLowerCase() : "";
  if (!isSerial(serialNumber)) fail(`${kind} SBOM has no urn:uuid serialNumber (a BOM-Link needs one)`);
  const version = d.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) fail(`${kind} SBOM has no positive integer version`);
  return { kind, serialNumber, version: version as number, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** build the identity file for a release from the two SBOM files' bytes */
export function buildReleaseSbomIdentity(input: { commit: string; imageDigest: string; workspace: Uint8Array; image: Uint8Array }): ReleaseSbomIdentity {
  const candidate = {
    v: RELEASE_SBOM_IDENTITY_VERSION,
    commit: input.commit,
    imageDigest: input.imageDigest,
    sboms: [releaseSbomEntryFromBytes("image", input.image), releaseSbomEntryFromBytes("workspace", input.workspace)],
  };
  return parseReleaseSbomIdentity(candidate);
}

export function parseReleaseSbomIdentity(value: unknown): ReleaseSbomIdentity {
  const r = releaseSbomIdentitySchema.safeParse(value);
  if (!r.success) return fail(r.error.issues.map(bomSafeIssue).slice(0, 8).join("; "));
  return r.data;
}

/** does each SBOM file still hash to what the identity says? (a swapped SBOM is refused, never relinked) */
export function checkReleaseSbomBytes(identity: ReleaseSbomIdentity, files: Partial<Record<ReleaseSbomKind, Uint8Array>>): void {
  for (const s of identity.sboms) {
    const bytes = files[s.kind];
    if (!bytes) fail(`${s.kind} SBOM file is missing`);
    const again = releaseSbomEntryFromBytes(s.kind, bytes!);
    if (again.sha256 !== s.sha256 || again.serialNumber !== s.serialNumber || again.version !== s.version) fail(`${s.kind} SBOM does not match the signed identity`);
  }
}

/**
 * CycloneDX BOM-Link (CycloneDX 1.5+, "urn:cdx:<serial-uuid>/<version>[#bom-ref]"):
 * the reference an AI BOM uses to cite another BOM by identity, not by location.
 */
export function cycloneDxBomLink(serialNumber: string, version: number, bomRef?: string): string {
  if (!isSerial(serialNumber)) fail("a BOM-Link needs a urn:uuid serial number");
  if (!Number.isSafeInteger(version) || version < 1) fail("a BOM-Link needs a positive integer version");
  return `urn:cdx:${serialNumber.slice(9)}/${version}${bomRef === undefined ? "" : `#${encodeURIComponent(bomRef)}`}`;
}

/** one release SBOM as an AI BOM record (install subject only); only a VERIFIED identity yields these */
export interface ReleaseSbomRecord {
  kind: ReleaseSbomKind;
  serialNumber: string;
  version: number;
  sha256: string;
  /** the scanned image's digest (image kind only) */
  imageDigest: string | null;
  releaseCommit: string;
  signatureVerified: true;
  verifiedBy: ReleaseSbomVerificationMethod;
}

/**
 * R9: the ONLY way to turn an identity file into AI BOM records. The caller
 * passes the outcome of the signature check (cosign verify-blob against the
 * release's trust root); anything but `{ signatureVerified: true }` is refused,
 * so an unverified file can never be BOM-linked.
 */
export function verifiedReleaseSbomRecords(
  identity: unknown,
  verification: { signatureVerified: boolean; method: ReleaseSbomVerificationMethod },
): ReleaseSbomRecord[] {
  if (verification?.signatureVerified !== true) fail("the identity file's signature was not verified (R9); no BOM-Link is emitted");
  if (!(RELEASE_SBOM_VERIFICATION_METHODS as readonly string[]).includes(verification.method)) fail("unknown verification method");
  const f = parseReleaseSbomIdentity(identity);
  return f.sboms.map((s) => ({
    kind: s.kind,
    serialNumber: s.serialNumber,
    version: s.version,
    sha256: s.sha256,
    imageDigest: s.kind === "image" ? f.imageDigest : null,
    releaseCommit: f.commit,
    signatureVerified: true as const,
    verifiedBy: verification.method,
  }));
}
