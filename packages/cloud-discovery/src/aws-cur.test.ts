/**
 * ADR-0322 slice 4a: the CUR 2.0 period reader against a fake S3 and STS behind the injected fetch. The real SDK
 * builds and signs real requests; only the socket is replaced.
 */
import { gzipSync } from "node:zlib";
import { parquetWriteBuffer } from "hyparquet-writer";
import { describe, expect, it } from "vitest";
import { awsCredentialProvider } from "./aws.js";
import { AWS_CUR_MAX_INFLATED_BYTES, AwsCurReadError, readAwsCurPeriod, type AwsCurFile, type AwsCurTarget } from "./aws-cur.js";
import { awsSts, fakeCloud, synthetic, xml, type RecordedCall } from "./test-cloud.js";

const TARGET: AwsCurTarget = { bucket: "acme-cur", region: "us-east-1", prefix: "exports/ai", exportName: "bedrock" };
const META = "exports/ai/bedrock/metadata/BILLING_PERIOD=2026-11/";
const DATA = "exports/ai/bedrock/data/BILLING_PERIOD=2026-11/";
const parseManifest = (raw: unknown) => raw as { executionId?: string; dataFiles: string[] };
const parquetColumns = ["line_item_usage_start_date", "line_item_unblended_cost", "line_item_product_code", "line_item_iam_principal"];
const staticCreds = async () => ({ accessKeyId: synthetic("akid"), secretAccessKey: synthetic("sk") });

const listXml = (keys: string[]) =>
  xml(
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>acme-cur</Name><IsTruncated>false</IsTruncated>${keys
      .map((k) => `<Contents><Key>${k}</Key><LastModified>2026-11-19T00:00:00.000Z</LastModified><Size>10</Size></Contents>`)
      .join("")}</ListBucketResult>`,
  );

/** a fake bucket: `objects` maps keys to bodies; listing returns the keys under the asked prefix */
function bucket(objects: Record<string, Uint8Array | string>) {
  return (c: RecordedCall) => {
    if (c.url.hostname !== "acme-cur.s3.us-east-1.amazonaws.com") return undefined;
    if (c.url.searchParams.get("list-type") === "2") {
      const p = c.url.searchParams.get("prefix") ?? "";
      return listXml(Object.keys(objects).filter((k) => k.startsWith(p)));
    }
    const key = decodeURIComponent(c.url.pathname.slice(1));
    const body = objects[key];
    if (body === undefined) return xml("<Error><Code>NoSuchKey</Code></Error>", 404);
    const bytes = typeof body === "string" ? Buffer.from(body) : body;
    return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
  };
}

const manifest = (files: string[]) => JSON.stringify({ executionId: "exec-1", dataFiles: files });

describe("readAwsCurPeriod (ADR-0322 slice 4a)", () => {
  it("lists the period's manifest, reads every gzip CSV file it names, virtual-hosted through the injected fetch", async () => {
    const cloud = fakeCloud([
      bucket({
        [`${META}bedrock-Manifest.json`]: manifest([`s3://acme-cur/${DATA}bedrock-00001.csv.gz`, `${DATA}bedrock-00002.csv.gz`]),
        [`${META}per-execution/old-Manifest.json`]: manifest([]),
        [`${DATA}bedrock-00001.csv.gz`]: gzipSync(Buffer.from("a,b\n1,2\n")),
        [`${DATA}bedrock-00002.csv.gz`]: gzipSync(Buffer.from("a,b\n3,4\n")),
      }),
    ]);
    const texts: string[] = [];
    const read = await readAwsCurPeriod({ fetch: cloud.fetch, credentials: staticCreds, parseManifest, parquetColumns }, TARGET, "2026-11", (f) => {
      if (f.format === "csv") texts.push(f.text);
    });
    expect(read).toEqual({ period: "2026-11", delivered: true, executionId: "exec-1", files: 2 });
    expect(texts).toEqual(["a,b\n1,2\n", "a,b\n3,4\n"]);
    expect(cloud.unrouted).toHaveLength(0);
    expect(cloud.calls.every((c) => c.url.hostname === "acme-cur.s3.us-east-1.amazonaws.com" && c.method === "GET")).toBe(true);
    expect(cloud.calls.every((c) => (c.headers.get("authorization") ?? "").startsWith("AWS4-HMAC-SHA256"))).toBe(true);
  });

  it("reports a period AWS has not delivered yet instead of failing", async () => {
    const cloud = fakeCloud([bucket({})]);
    const read = await readAwsCurPeriod({ fetch: cloud.fetch, credentials: staticCreds, parseManifest, parquetColumns }, TARGET, "2026-11", () => undefined);
    expect(read).toMatchObject({ delivered: false, files: 0 });
  });

  it("refuses a manifest that names a file outside the period's data folder, before reading any data", async () => {
    for (const ref of [`s3://other-bucket/${DATA}x.csv.gz`, "exports/ai/bedrock/data/BILLING_PERIOD=2026-10/x.csv.gz", `${DATA}../../../secret.csv.gz`, "s3://acme-cur/elsewhere/x.csv.gz"]) {
      const cloud = fakeCloud([bucket({ [`${META}Manifest.json`]: manifest([ref]), [`${DATA}ok.csv.gz`]: gzipSync(Buffer.from("a\n")) })]);
      const err = await readAwsCurPeriod({ fetch: cloud.fetch, credentials: staticCreds, parseManifest, parquetColumns }, TARGET, "2026-11", () => undefined).catch((e: unknown) => e);
      expect(err, ref).toBeInstanceOf(AwsCurReadError);
      expect((err as AwsCurReadError).reason, ref).toBe("outside_prefix");
      expect(cloud.calls.filter((c) => c.url.pathname.includes("/data/"))).toHaveLength(0);
    }
  });

  // a Snappy Parquet file as AWS writes it, with one column RegulAIt never reads (projected away)
  const parquetFile = (extra: Parameters<typeof parquetWriteBuffer>[0]["columnData"] = []) =>
    new Uint8Array(
      parquetWriteBuffer({
        codec: "SNAPPY",
        columnData: [
          { name: "line_item_usage_start_date", data: [new Date("2026-11-03T00:00:00Z"), new Date("2026-11-04T05:00:00Z")], type: "TIMESTAMP" },
          { name: "line_item_unblended_cost", data: [0.125, 1e-7], type: "DOUBLE" },
          { name: "line_item_product_code", data: ["AmazonBedrock", "AmazonBedrock"], type: "STRING" },
          { name: "line_item_iam_principal", data: ["arn:aws:iam::123456789012:role/app", null], type: "STRING", nullable: true },
          { name: "line_item_resource_id", data: ["arn:aws:bedrock:secret-resource", "x"], type: "STRING" },
          ...extra,
        ],
      }),
    );

  it("reads a Snappy Parquet export, decoding only the requested columns into the cells the CSV path carries", async () => {
    const cloud = fakeCloud([bucket({ [`${META}Manifest.json`]: manifest([`${DATA}bedrock-00001.snappy.parquet`]), [`${DATA}bedrock-00001.snappy.parquet`]: parquetFile() })]);
    const files: AwsCurFile[] = [];
    const read = await readAwsCurPeriod({ fetch: cloud.fetch, credentials: staticCreds, parseManifest, parquetColumns }, TARGET, "2026-11", (f) => files.push(f));
    expect(read).toMatchObject({ delivered: true, files: 1 });
    expect(files).toEqual([
      {
        format: "parquet",
        header: parquetColumns,
        rows: [
          { line: 1, cells: ["2026-11-03T00:00:00.000Z", "0.125", "AmazonBedrock", "arn:aws:iam::123456789012:role/app"] },
          { line: 2, cells: ["2026-11-04T05:00:00.000Z", "1e-7", "AmazonBedrock", ""] },
        ],
      },
    ]);
    expect(JSON.stringify(files)).not.toContain("secret-resource");
  });

  it("refuses a DECIMAL cost column, a file that is not Parquet, and a data file of any other format", async () => {
    const run = async (name: string, body: Uint8Array) => {
      const cloud = fakeCloud([bucket({ [`${META}Manifest.json`]: manifest([`${DATA}${name}`]), [`${DATA}${name}`]: body })]);
      return (await readAwsCurPeriod({ fetch: cloud.fetch, credentials: staticCreds, parseManifest, parquetColumns }, TARGET, "2026-11", () => undefined).catch((e: unknown) => e)) as AwsCurReadError;
    };
    const decimal = new Uint8Array(
      parquetWriteBuffer({
        columnData: [{ name: "line_item_unblended_cost", data: [12345n] }],
        schema: [
          { name: "root", num_children: 1 },
          { name: "line_item_unblended_cost", type: "INT64", repetition_type: "REQUIRED", converted_type: "DECIMAL", scale: 2, precision: 18 },
        ],
      }),
    );
    expect([(await run("d.snappy.parquet", decimal)).reason, (await run("d.snappy.parquet", decimal)).message]).toEqual([
      "unsupported_format",
      "the export stores line_item_unblended_cost as DECIMAL, which RegulAIt does not read",
    ]);
    expect((await run("bad.snappy.parquet", new Uint8Array(Buffer.from("PAR1 not really parquet")))).reason).toBe("unsupported_format");
    expect((await run("x.csv.zip", new Uint8Array(1))).reason).toBe("unsupported_format");
  });

  it("refuses a gzip bomb rather than inflating it", async () => {
    const bomb = gzipSync(Buffer.alloc(AWS_CUR_MAX_INFLATED_BYTES + 1024));
    const cloud = fakeCloud([bucket({ [`${META}Manifest.json`]: manifest([`${DATA}bomb.csv.gz`]), [`${DATA}bomb.csv.gz`]: bomb })]);
    const err = (await readAwsCurPeriod({ fetch: cloud.fetch, credentials: staticCreds, parseManifest, parquetColumns }, TARGET, "2026-11", () => undefined).catch((e: unknown) => e)) as AwsCurReadError;
    expect(err.reason).toBe("too_large");
  });

  it("assumes the federated role through the same fetch, presenting the supplied OIDC token", async () => {
    const token = synthetic("oidc");
    const audiences: string[] = [];
    const cloud = fakeCloud([(c) => awsSts(c), bucket({})]);
    const credentials = awsCredentialProvider(
      {
        fetch: cloud.fetch,
        credential: { mode: "aws_web_identity", roleArn: "arn:aws:iam::123456789012:role/regulait-cur", roleSessionName: "regulait-vendor-usage" },
        oidcToken: async (aud) => {
          audiences.push(aud);
          return token;
        },
      },
      "us-east-1",
    );
    await readAwsCurPeriod({ fetch: cloud.fetch, credentials, parseManifest, parquetColumns }, TARGET, "2026-11", () => undefined);
    const sts = cloud.calls.find((c) => c.url.hostname.startsWith("sts."));
    const form = new URLSearchParams(sts?.body ?? "");
    expect([form.get("Action"), form.get("WebIdentityToken"), form.get("RoleSessionName")]).toEqual(["AssumeRoleWithWebIdentity", token, "regulait-vendor-usage"]);
    expect(audiences).toEqual(["sts.amazonaws.com"]);
    expect(cloud.unrouted).toHaveLength(0);
  });
});
