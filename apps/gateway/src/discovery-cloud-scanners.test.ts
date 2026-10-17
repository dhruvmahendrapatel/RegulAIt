/**
 * ADR-0195 SD2 phase B: the cloud scanners against SD0's Scanner contract, without a database. A fake cloud stands
 * behind `ctx.fetch`; the test checks the worker hooks (throttle before every request, back-off on 429, every body
 * digested, principals pseudonymised as `cloud_principal`), that the observations pass the worker's own
 * `checkObservations` for the source kind, and that federation and an all-unreachable run fail with a reason.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cloudScanner, capabilitySummary, digestBounded } from "./discovery-cloud-scanners.js";
import type { ScanContext } from "./discovery-scanners.js";
import { checkObservations } from "./discovery-worker.js";

const ACCOUNT = "111122223333";
const synthetic = (label: string) => `${label}-${randomBytes(12).toString("hex")}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeAws(opts: { throttleOnce?: boolean } = {}) {
  let throttled = false;
  const hosts: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    hosts.push(url.hostname);
    if (opts.throttleOnce && !throttled && url.pathname === "/custom-models") {
      throttled = true;
      return json({ message: "slow down" }, 429);
    }
    if (url.hostname.startsWith("account.")) return json({ Regions: [{ RegionName: "us-east-1", RegionOptStatus: "ENABLED_BY_DEFAULT" }] });
    if (url.hostname.startsWith("bedrock.") && url.pathname === "/custom-models") {
      return json({ modelSummaries: [{ modelArn: `arn:aws:bedrock:us-east-1:${ACCOUNT}:custom-model/m1`, modelName: "m1", creationTime: "2026-09-01T00:00:00Z" }] });
    }
    if (url.hostname.startsWith("cloudtrail.")) {
      const raw = init?.body;
      const text = typeof raw === "string" ? raw : raw ? new TextDecoder().decode(raw as ArrayBuffer) : "{}";
      const body = JSON.parse(text) as { LookupAttributes?: Array<{ AttributeValue: string }> };
      if (body.LookupAttributes?.[0]?.AttributeValue !== "InvokeModel") return json({ Events: [] });
      return json({
        Events: [
          {
            EventName: "InvokeModel",
            EventTime: Math.floor(Date.parse("2026-10-10T10:00:00Z") / 1000),
            EventSource: "bedrock.amazonaws.com",
            CloudTrailEvent: JSON.stringify({ userIdentity: { arn: `arn:aws:iam::${ACCOUNT}:role/app-role` }, eventTime: "2026-10-10T10:00:00Z" }),
          },
        ],
      });
    }
    return json({});
  }) as typeof fetch;
  return { f, hosts };
}

function ctxFor(over: Partial<ScanContext> & { fetch: typeof fetch }) {
  const calls = { throttle: 0, backoff: 0, raw: 0, pseudonymise: [] as string[] };
  const ctx: ScanContext = {
    source: { id: "s1", name: "aws", kind: "cloud_aws", target: { accountId: ACCOUNT }, scope: { orgLevel: false, include: ["us-east-1"] } },
    credential: { mode: "static", publicConfig: {}, secret: JSON.stringify({ accessKeyId: synthetic("akid"), secretAccessKey: synthetic("sk") }) },
    throttle: async () => {
      calls.throttle += 1;
    },
    backoff: async (res) => {
      calls.backoff += 1;
      return res.status === 429 && calls.backoff <= 1;
    },
    recordRaw: () => {
      calls.raw += 1;
    },
    pseudonymise: async (kind, name) => {
      calls.pseudonymise.push(kind);
      return `psn:${Buffer.from(name).toString("hex").slice(0, 24).padEnd(24, "0")}`;
    },
    heartbeat: async () => true,
    signal: new AbortController().signal,
    ...over,
  };
  return { ctx, calls };
}

describe("ADR-0195 SD2 cloud scanners on the SD0 contract", () => {
  it("static AWS: hooks wired, observations valid for cloud_aws, principal pseudonymised, artifacts are cloud_ai_service", async () => {
    const cloud = fakeAws({ throttleOnce: true });
    const { ctx, calls } = ctxFor({ fetch: cloud.f });
    const res = await cloudScanner("cloud_aws").run(ctx);

    expect(calls.throttle).toBe(cloud.hosts.length); // one throttle per request, retries included
    expect(calls.backoff).toBe(1); // the 429 was retried once through ctx.backoff
    expect(calls.raw).toBe(cloud.hosts.length); // every body but the retried 429 digested, plus the capability summary
    expect(calls.pseudonymise).toEqual(["cloud_principal"]);

    const checked = checkObservations("cloud_aws", res.observations, "2026-10-17T00:00:00.000Z");
    expect(checked.length).toBe(res.observations.length);
    expect(res.observations.map((o) => [o.evidenceKind, o.subjectKind, o.artifact?.kind, o.artifact?.value])).toEqual([
      ["cloud_audit_log", "cloud_principal", "cloud_ai_service", "aws:bedrock"],
      ["cloud_inventory", "cloud_resource", "cloud_ai_service", "aws:bedrock"],
    ]);
    expect(JSON.stringify(res)).not.toContain("app-role");
  });

  it("a federated credential fails with the pending-federation reason, before any request", async () => {
    const cloud = fakeAws();
    const { ctx } = ctxFor({
      fetch: cloud.f,
      credential: { mode: "federated", publicConfig: { roleArn: `arn:aws:iam::${ACCOUNT}:role/r`, externalId: "regulait-x" }, secret: null },
    });
    await expect(cloudScanner("cloud_aws").run(ctx)).rejects.toThrow(/RS256 federation token/);
    expect(cloud.hosts).toEqual([]);
  });

  it("a malformed static secret is refused without echoing it", async () => {
    const cloud = fakeAws();
    const leaked = synthetic("not-json");
    const { ctx } = ctxFor({ fetch: cloud.f, credential: { mode: "static", publicConfig: {}, secret: leaked } });
    const err = await cloudScanner("cloud_aws").run(ctx).catch((e: Error) => e);
    expect(String(err)).toContain("must be a JSON object");
    expect(String(err)).not.toContain(leaked);
  });

  it("when no read succeeds the run fails with the per-read summary", async () => {
    const refused = (async () => {
      throw Object.assign(new Error("egress blocked (host_not_allowlisted): host not allowed"), { name: "EgressBlockedError" });
    }) as typeof fetch;
    const { ctx } = ctxFor({ fetch: refused });
    const err = await cloudScanner("cloud_aws").run(ctx).catch((e: Error) => e);
    expect(String(err)).toContain("no cloud read succeeded");
    expect(String(err)).toContain("unreachable");
  });

  it("digests at most the cap of a body: a declared oversize is a marker, a stream past the cap is cut (finding 2)", async () => {
    const chunks: Array<string | Uint8Array> = [];
    await digestBounded(new Response("x".repeat(10), { headers: { "content-length": "999999999" } }), (c) => chunks.push(c), 100);
    expect(chunks).toEqual(["[body of 999999999 bytes over the 100-byte digest cap: not digested]"]);
    chunks.length = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(60));
      },
    });
    const res = new Response(stream);
    await digestBounded(res, (c) => chunks.push(c), 100);
    expect(chunks.at(-1)).toBe("[body truncated at the 100-byte digest cap]");
    expect(chunks.filter((c) => typeof c !== "string").reduce((n, c) => n + (c as Uint8Array).byteLength, 0)).toBeLessThanOrEqual(100);
    chunks.length = 0;
    await digestBounded(new Response("small"), (c) => chunks.push(c), 100);
    expect(Buffer.concat(chunks.map((c) => Buffer.from(c as Uint8Array))).toString()).toBe("small");
  });

  it("capabilitySummary lists only reads that did not succeed", () => {
    expect(capabilitySummary([
      { capability: "a", scope: null, status: "read", items: 1 },
      { capability: "b", scope: "r", status: "denied", detail: "AccessDenied" },
    ])).toBe("b@r: denied (AccessDenied)");
  });
});
