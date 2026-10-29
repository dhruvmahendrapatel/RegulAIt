/**
 * #453 c6487334834: the AWS discovery step `aws.cloudtrail.data_events@<trail bucket>` failed live with "Checksum
 * mismatch ... x-amz-checksum-crc64nvme". CloudTrail stores its log objects with `Content-Encoding: gzip`, S3 returns
 * a checksum of those stored (gzip) bytes, and the pinned transport used to decompress every encoded body, so the
 * SDK checked the stored checksum against the inflated bytes.
 *
 * This suite runs the real cloud scanner through the real guarded fetch and pinned transport, against a local S3
 * stand-in that serves a gzip CloudTrail object exactly as S3 does. Checksum validation stays on throughout.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloudScanner } from "./discovery-cloud-scanners.js";
import type { ScanContext } from "./discovery-scanners.js";
import { createGuardedFetch, type EgressAllowEntry } from "./egress-guard.js";
import { resetPinnedAgents, type PinnedRequestInit } from "./pinned-fetch.js";

const ACCOUNT = "111122223333";
const BUCKET = "trail";
const PREFIX = `AWSLogs/${ACCOUNT}/CloudTrail/`;

// CRC-64/NVME (reflected poly 0x9a6c9329ac4bc9b5, init and xorout all ones), the algorithm S3 uses by default
const CRC64_NVME_POLY = 0x9a6c9329ac4bc9b5n;
const ALL_ONES = 0xffffffffffffffffn;
function crc64nvme(bytes: Uint8Array): bigint {
  let crc = ALL_ONES;
  for (const b of bytes) {
    crc ^= BigInt(b);
    for (let i = 0; i < 8; i++) crc = crc & 1n ? (crc >> 1n) ^ CRC64_NVME_POLY : crc >> 1n;
  }
  return crc ^ ALL_ONES;
}
function checksumHeader(bytes: Uint8Array): string {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(crc64nvme(bytes));
  return out.toString("base64");
}

const record = {
  Records: [
    {
      eventName: "InvokeModel",
      eventSource: "bedrock.amazonaws.com",
      eventTime: new Date().toISOString(),
      awsRegion: "us-east-1",
      recipientAccountId: ACCOUNT,
      userIdentity: { arn: `arn:aws:iam::${ACCOUNT}:role/agent-caller` },
      requestParameters: { modelId: "anthropic.model" },
    },
  ],
};
/** the object as CloudTrail stores it: gzip bytes, with `Content-Encoding: gzip` as object metadata */
const stored = gzipSync(Buffer.from(JSON.stringify(record)));

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
const listXml = (inner: string) =>
  xml(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET}</Name><IsTruncated>false</IsTruncated>${inner}</ListBucketResult>`);

const pad2 = (n: number) => String(n).padStart(2, "0");
const dayPrefix = (d: Date) => `${PREFIX}us-east-1/${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}/`;

let server: http.Server;
let port = 0;
const acceptEncodingOnGet: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0]!;
    const url = new URL(req.url ?? "/", "http://local");
    req.resume();
    if (host.startsWith("sts.")) {
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(`<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::${ACCOUNT}:user/u</Arn><UserId>U</UserId><Account>${ACCOUNT}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`);
      return;
    }
    if (host === `${BUCKET}.s3.us-east-1.amazonaws.com`) {
      const prefix = url.searchParams.get("prefix") ?? "";
      if (url.searchParams.get("list-type") === "2") {
        res.writeHead(200, { "content-type": "application/xml" });
        if (prefix === PREFIX) res.end(listXml(`<CommonPrefixes><Prefix>${PREFIX}us-east-1/</Prefix></CommonPrefixes>`));
        else {
          // today's or yesterday's day prefix (the scan walks back from now), built here: nothing from the request is echoed
          const day = [0, 1].map((back) => dayPrefix(new Date(Date.now() - back * 86_400_000))).find((p) => p === prefix);
          res.end(listXml(day ? `<Contents><Key>${day}${ACCOUNT}_CloudTrail_us-east-1_obj.json.gz</Key><Size>${stored.length}</Size></Contents>` : ""));
        }
        return;
      }
      // GetObject: S3 serves the stored bytes whatever the client accepts, and checksums those bytes
      acceptEncodingOnGet.push(String(req.headers["accept-encoding"] ?? ""));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(stored.length),
        "x-amz-checksum-crc64nvme": checksumHeader(stored),
        "x-amz-checksum-type": "FULL_OBJECT",
        etag: '"0123456789abcdef0123456789abcdef"',
      });
      res.end(stored);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  resetPinnedAgents();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * The real guarded fetch. Only the destination port changes (and https becomes http, so no test PKI is needed): the
 * request still goes through `checkEgress`, the pinned transport and its response decoding.
 */
function guardedToLocal(): typeof fetch {
  const hosts = ["sts.us-east-1.amazonaws.com", "sts.amazonaws.com", `${BUCKET}.s3.us-east-1.amazonaws.com`];
  const allowList: EgressAllowEntry[] = hosts.map((host) => ({ host, allowPrivateRanges: true, allowPlaintextHttp: true }));
  const guarded = createGuardedFetch({ allowList, resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    url.protocol = "http:";
    url.port = String(port);
    return guarded(url.toString(), init);
  }) as typeof fetch;
}

function ctxFor(fetchImpl: typeof fetch): ScanContext {
  return {
    source: {
      id: "s1",
      name: "aws",
      kind: "cloud_aws",
      target: { accountId: ACCOUNT, trailBucket: BUCKET, trailBucketRegion: "us-east-1" },
      scope: { orgLevel: false, include: ["us-east-1"] },
    },
    credential: { mode: "static", publicConfig: {}, secret: JSON.stringify({ accessKeyId: "AKIDTESTONLY", secretAccessKey: "test-only-secret" }) },
    fetch: fetchImpl,
    throttle: async () => undefined,
    backoff: async () => false,
    recordRaw: () => undefined,
    registerSecret: () => undefined,
    pseudonymise: async (_kind, name) => `psn:${Buffer.from(name).toString("hex").slice(0, 24).padEnd(24, "0")}`,
    heartbeat: async () => true,
    signal: new AbortController().signal,
    catalogue: { matches: () => true, rows: () => [] },
  };
}

const trailOutcome = (res: Awaited<ReturnType<ReturnType<typeof cloudScanner>["run"]>>) =>
  res.readOutcomes?.find((o) => o.read.startsWith("aws.cloudtrail.data_events@"));

describe("#453 c6487334834: cloud scans read the stored S3 bytes, so the stored checksum validates", () => {
  it("the test's CRC-64/NVME matches the published check value", () => {
    expect(crc64nvme(Buffer.from("123456789"))).toBe(0xae8b14860a799888n);
  });

  it("a gzip CloudTrail object with a correct crc64nvme checksum yields its records through the guarded, pinned path", async () => {
    acceptEncodingOnGet.length = 0;
    const res = await cloudScanner("cloud_aws").run(ctxFor(guardedToLocal()));
    const outcome = trailOutcome(res);
    expect(outcome, JSON.stringify(res.readOutcomes)).toMatchObject({ status: "read" });
    expect(outcome?.detail).toMatch(/1 calling principal/);
    expect(res.observations.some((o) => o.evidenceKind === "cloud_audit_log")).toBe(true);
    // the GET asked for the stored bytes, not a re-encoding
    expect(acceptEncodingOnGet.length).toBeGreaterThan(0);
    expect(acceptEncodingOnGet.every((v) => v === "identity")).toBe(true);
  });

  it("control: the same scan with the transport decoding the body fails the SDK's checksum check (the live bug)", async () => {
    const guarded = guardedToLocal();
    const decoding = (async (input: string | URL | Request, init?: PinnedRequestInit) =>
      guarded(input, { ...init, decodeContentEncoding: true } as PinnedRequestInit)) as typeof fetch;
    const res = await cloudScanner("cloud_aws").run(ctxFor(decoding));
    expect(trailOutcome(res)).toMatchObject({ status: "error", detail: expect.stringMatching(/checksum mismatch.*x-amz-checksum-crc64nvme/i) });
  });
});
