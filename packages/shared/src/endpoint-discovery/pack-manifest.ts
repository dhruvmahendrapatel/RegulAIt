/**
 * ADR-0195 decision 18 — the query pack's manifest and signing HOOK.
 *
 * The pack is to be signed; the mechanism is decided in the SD4 spike together
 * with the endpoint agent's release signing, and `infra/release-keys/` is not
 * reused without an owner decision. Until then the manifest carries the pack's
 * SHA-256 digest and size, and its `signature` says plainly that it is
 * unsigned. A `EndpointPackSigner` is the seam SD4 fills.
 */
import { createHash } from "node:crypto";
import { ENDPOINT_SIGNATURE_SEED, type EndpointSignatureSeed } from "./endpoint-signatures.js";
import { ENDPOINT_PACK_NAME, ENDPOINT_PACK_QUERIES, renderOsqueryPack, type EndpointPackQuery } from "./osquery-pack.js";

export const ENDPOINT_PACK_FILE = "regulait-ai-discovery.conf";
export const ENDPOINT_PACK_MANIFEST_SCHEMA = "regulait.endpoint-pack-manifest.v1";

export type EndpointPackSignature =
  | { status: "unsigned"; reason: string }
  | { status: "signed"; scheme: string; keyId: string; value: string };

export interface EndpointPackManifest {
  schema: typeof ENDPOINT_PACK_MANIFEST_SCHEMA;
  pack: string;
  packName: string;
  file: string;
  sha256: string;
  bytes: number;
  /** digest of the seed rows the pack was generated from (canonical JSON of id, matchType, value, os, ecosystem, enabled) */
  seedSha256: string;
  queries: Array<{ name: string; platform: string; tables: readonly string[] }>;
  osquery: { shipped: false; note: string };
  signature: EndpointPackSignature;
}

/** The seam SD4 fills. Signs the manifest's pack digest; must never see a private key it did not load itself. */
export interface EndpointPackSigner {
  sign(input: { sha256: string; file: string }): Promise<Exclude<EndpointPackSignature, { status: "unsigned" }>>;
}

export const ENDPOINT_PACK_UNSIGNED: EndpointPackSignature = Object.freeze({
  status: "unsigned",
  reason: "Pack signing is pending the ADR-0195 SD4 spike. Verify the file's SHA-256 against this manifest, obtained from your RegulAIt release, before deploying it.",
});

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export function endpointSeedDigest(seed: readonly EndpointSignatureSeed[] = ENDPOINT_SIGNATURE_SEED): string {
  const rows = seed.map((s) => ({ id: s.id, matchType: s.matchType, value: s.value, os: s.os, ecosystem: s.ecosystem, enabled: s.enabled }));
  return sha256(JSON.stringify(rows));
}

export function buildEndpointPackManifest(
  opts: { queries?: readonly EndpointPackQuery[]; seed?: readonly EndpointSignatureSeed[]; signature?: EndpointPackSignature } = {},
): { manifest: EndpointPackManifest; packText: string } {
  const queries = opts.queries ?? ENDPOINT_PACK_QUERIES;
  const packText = renderOsqueryPack(queries);
  const manifest: EndpointPackManifest = {
    schema: ENDPOINT_PACK_MANIFEST_SCHEMA,
    pack: "RegulAIt AI discovery query pack",
    packName: ENDPOINT_PACK_NAME,
    file: ENDPOINT_PACK_FILE,
    sha256: sha256(packText),
    bytes: Buffer.byteLength(packText, "utf8"),
    seedSha256: endpointSeedDigest(opts.seed),
    queries: queries.filter((q) => q.sql !== null).map((q) => ({ name: q.name, platform: q.platform, tables: q.tables })),
    osquery: { shipped: false, note: "RegulAIt ships queries only. osquery is installed and run by the customer through their MDM or EDR." },
    signature: opts.signature ?? ENDPOINT_PACK_UNSIGNED,
  };
  return { manifest, packText };
}

export function renderEndpointPackManifest(manifest: EndpointPackManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Sign a manifest with an SD4 signer. Returns a new manifest; the digest is recomputed, never trusted from input. */
export async function signEndpointPackManifest(packText: string, manifest: EndpointPackManifest, signer: EndpointPackSigner): Promise<EndpointPackManifest> {
  const digest = sha256(packText);
  if (digest !== manifest.sha256) throw new Error("the pack text does not match the manifest digest; refusing to sign");
  const signature = await signer.sign({ sha256: digest, file: manifest.file });
  return { ...manifest, signature };
}

/** Check a pack file against its manifest. `signed` is reported, not assumed. */
export function verifyEndpointPack(packText: string, manifest: EndpointPackManifest): { digestOk: boolean; bytesOk: boolean; signed: boolean } {
  return {
    digestOk: sha256(packText) === manifest.sha256,
    bytesOk: Buffer.byteLength(packText, "utf8") === manifest.bytes,
    signed: manifest.signature.status === "signed",
  };
}
