/**
 * ADR-0322 slice 4a: read one billing period of an AWS Data Exports (CUR 2.0) export from S3, read-only.
 *
 * WHAT IT READS. `<prefix>/<exportName>/metadata/BILLING_PERIOD=YYYY-MM/` is listed for the period's manifest
 * (AWS names it `Manifest.json` or `<exportName>-Manifest.json`; both are accepted). The manifest's data files are read
 * only when every one of them lies under `<prefix>/<exportName>/data/BILLING_PERIOD=YYYY-MM/` in the same bucket, so a
 * planted manifest cannot steer a read elsewhere. Only gzip-compressed CSV is read; a Parquet export is refused.
 *
 * BOUNDS. At most AWS_CUR_MAX_FILES data files a period, each at most AWS_CUR_MAX_OBJECT_BYTES on the wire (checked
 * against the declared length and again while reading) and AWS_CUR_MAX_INFLATED_BYTES once decompressed (a gzip bomb
 * is refused, not read). Listing stops after AWS_CUR_MAX_LIST_PAGES pages.
 *
 * TRANSPORT. The S3 client is built on the caller's guarded fetch (`guardedAwsRequestHandler`) with the pinned
 * endpoint configuration, virtual-hosted addressing and no accelerate or ARN-region endpoints, so every request goes
 * to `<bucket>.s3.<region>.amazonaws.com` through the egress guard. Credentials come from the caller's provider
 * (`awsCredentialProvider`), never the default chain.
 *
 * No database, no normalisation: the caller gets the decompressed text of each file through `onFile` and turns it into
 * facts (`normalizeAwsCurCsv` in @regulait/shared).
 */
import { gunzipSync } from "node:zlib";
import type { AwsCredentialIdentityProvider } from "@smithy/types";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { AWS_PINNED_ENDPOINT_CONFIG } from "./aws.js";
import { BodyTooLargeError, guardedAwsRequestHandler, readBodyCapped, type GuardedFetch } from "./transport.js";

export const AWS_CUR_MAX_FILES = 20;
export const AWS_CUR_MAX_OBJECT_BYTES = 32 * 1024 * 1024;
export const AWS_CUR_MAX_INFLATED_BYTES = 128 * 1024 * 1024;
export const AWS_CUR_MAX_MANIFEST_BYTES = 1024 * 1024;
export const AWS_CUR_MAX_LIST_PAGES = 10;

export interface AwsCurTarget {
  bucket: string;
  region: string;
  /** "" for the bucket root */
  prefix: string;
  exportName: string;
}

/** why a period could not be read; the message is RegulAIt's own sentence, never S3 text */
export class AwsCurReadError extends Error {
  constructor(
    readonly reason: "unsupported_format" | "too_large" | "bad_manifest" | "outside_prefix" | "too_many_files",
    message: string,
  ) {
    super(message);
    this.name = "AwsCurReadError";
  }
}

export interface AwsCurReadDeps {
  fetch: GuardedFetch;
  credentials: AwsCredentialIdentityProvider;
  /** test seam: the parsed manifest's shape check, so the package does not depend on @regulait/shared */
  parseManifest: (raw: unknown) => { executionId?: string | undefined; dataFiles: string[] };
}

export interface AwsCurPeriodRead {
  period: string;
  /** false when AWS has not delivered this period yet (no manifest) */
  delivered: boolean;
  executionId: string | null;
  files: number;
}

function exportBase(t: AwsCurTarget): string {
  return t.prefix ? `${t.prefix}/${t.exportName}` : t.exportName;
}

/** a data file reference from the manifest to a key, or null when it is not under the period's data prefix */
function confinedKey(ref: string, t: AwsCurTarget, dataPrefix: string): string | null {
  let key: string;
  if (ref.startsWith("s3://")) {
    const rest = ref.slice("s3://".length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || rest.slice(0, slash) !== t.bucket) return null;
    key = rest.slice(slash + 1);
  } else {
    key = ref;
  }
  if (!key.startsWith(dataPrefix)) return null;
  if (key.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return key;
}

async function readObject(s3: S3Client, bucket: string, key: string, max: number): Promise<Uint8Array> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (obj.ContentLength !== undefined && obj.ContentLength > max) {
    await obj.Body?.transformToWebStream().cancel().catch(() => undefined);
    throw new AwsCurReadError("too_large", `an export object is larger than ${max} bytes; nothing was written`);
  }
  if (!obj.Body) return new Uint8Array(0);
  try {
    return await readBodyCapped(obj.Body.transformToWebStream() as ReadableStream<Uint8Array>, max);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw new AwsCurReadError("too_large", `an export object is larger than ${max} bytes; nothing was written`);
    throw err;
  }
}

/**
 * Read one billing period. Resolves `delivered: false` when the period has no manifest yet; throws AwsCurReadError for
 * a refused export and lets SDK errors (403, 404 on the bucket, network) propagate for the caller to classify.
 */
export async function readAwsCurPeriod(
  deps: AwsCurReadDeps,
  target: AwsCurTarget,
  period: string,
  onFile: (text: string, key: string) => void,
): Promise<AwsCurPeriodRead> {
  const s3 = new S3Client({
    region: target.region,
    credentials: deps.credentials,
    requestHandler: guardedAwsRequestHandler(deps.fetch),
    maxAttempts: 2,
    forcePathStyle: false,
    useAccelerateEndpoint: false,
    useArnRegion: false,
    ...AWS_PINNED_ENDPOINT_CONFIG,
  });
  const base = exportBase(target);
  const metaPrefix = `${base}/metadata/BILLING_PERIOD=${period}/`;
  const dataPrefix = `${base}/data/BILLING_PERIOD=${period}/`;

  // the manifest at the partition root (not in a per-execution subfolder), latest first if AWS left more than one
  const manifests: Array<{ key: string; at: number }> = [];
  let token: string | undefined;
  for (let page = 1; ; page++) {
    if (page > AWS_CUR_MAX_LIST_PAGES) throw new AwsCurReadError("too_many_files", "the export's metadata folder has too many objects; nothing was written");
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: target.bucket, Prefix: metaPrefix, ContinuationToken: token }));
    for (const o of listed.Contents ?? []) {
      const key = o.Key ?? "";
      const rest = key.slice(metaPrefix.length);
      if (!key.startsWith(metaPrefix) || rest.includes("/")) continue;
      if (rest === "Manifest.json" || rest === `${target.exportName}-Manifest.json`) {
        manifests.push({ key, at: o.LastModified?.getTime() ?? 0 });
      }
    }
    if (!listed.IsTruncated || !listed.NextContinuationToken) break;
    token = listed.NextContinuationToken;
  }
  if (manifests.length === 0) return { period, delivered: false, executionId: null, files: 0 };
  manifests.sort((a, b) => b.at - a.at);

  const raw = await readObject(s3, target.bucket, manifests[0]!.key, AWS_CUR_MAX_MANIFEST_BYTES);
  let manifest: { executionId?: string | undefined; dataFiles: string[] };
  try {
    manifest = deps.parseManifest(JSON.parse(Buffer.from(raw).toString("utf8")));
  } catch {
    throw new AwsCurReadError("bad_manifest", `the manifest for ${period} did not match the documented shape; nothing was written`);
  }
  if (manifest.dataFiles.length > AWS_CUR_MAX_FILES) {
    throw new AwsCurReadError("too_many_files", `the export for ${period} has more than ${AWS_CUR_MAX_FILES} data files; use a Bedrock-only export`);
  }
  // every reference is checked before the first data file is read, so a refused manifest reads nothing
  const keys = manifest.dataFiles.map((ref) => {
    const key = confinedKey(ref, target, dataPrefix);
    if (!key) throw new AwsCurReadError("outside_prefix", `the manifest for ${period} names a data file outside the export's data folder; nothing was written`);
    if (key.endsWith(".parquet")) throw new AwsCurReadError("unsupported_format", "this export is Parquet; recreate it as gzip-compressed CSV");
    if (!key.endsWith(".csv.gz")) throw new AwsCurReadError("unsupported_format", "an export data file is not gzip-compressed CSV");
    return key;
  });
  for (const key of keys) {
    const bytes = await readObject(s3, target.bucket, key, AWS_CUR_MAX_OBJECT_BYTES);
    let text: string;
    try {
      text = gunzipSync(bytes, { maxOutputLength: AWS_CUR_MAX_INFLATED_BYTES }).toString("utf8");
    } catch {
      throw new AwsCurReadError("too_large", `an export data file did not decompress within ${AWS_CUR_MAX_INFLATED_BYTES} bytes; nothing was written`);
    }
    onFile(text, key);
  }
  return { period, delivered: true, executionId: manifest.executionId ?? null, files: keys.length };
}
