/**
 * ADR-0195 SD2 phase B: the cloud scanners against SD0's Scanner contract, without a database. A fake cloud stands
 * behind `ctx.fetch`; the test checks the worker hooks (throttle before every request, back-off on 429, every body
 * digested, principals pseudonymised as `cloud_principal`), that the observations pass the worker's own
 * `checkObservations` for the source kind, and that federation and an all-unreachable run fail with a reason.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cloudScanner, capabilitySummary, digestBounded, scannerFetch } from "./discovery-cloud-scanners.js";
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
    if (url.hostname.startsWith("sts.")) {
      return new Response(`<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::${ACCOUNT}:user/u</Arn><UserId>U</UserId><Account>${ACCOUNT}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`, { headers: { "content-type": "text/xml" } });
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
  const calls = { throttle: 0, backoff: 0, raw: 0, pseudonymise: [] as string[], secrets: [] as string[], chunks: [] as string[] };
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
    recordRaw: (chunk) => {
      calls.raw += 1;
      calls.chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    },
    registerSecret: (v) => {
      calls.secrets.push(v);
    },
    pseudonymise: async (kind, name) => {
      calls.pseudonymise.push(kind);
      return `psn:${Buffer.from(name).toString("hex").slice(0, 24).padEnd(24, "0")}`;
    },
    heartbeat: async () => true,
    signal: new AbortController().signal,
    catalogue: { matches: () => true, rows: () => [] },
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
    // every body digested except the retried 429 and the STS identity check (credential fetch), plus the summary
    expect(calls.raw).toBe(cloud.hosts.length - 1);
    // the static key's parts were registered for scrubbing
    const secret = JSON.parse(ctx.credential!.secret!) as { accessKeyId: string; secretAccessKey: string };
    expect(calls.secrets).toEqual(expect.arrayContaining([secret.accessKeyId, secret.secretAccessKey]));
    expect(calls.pseudonymise).toEqual(["cloud_principal"]);

    const checked = checkObservations("cloud_aws", res.observations, "2026-10-17T00:00:00.000Z");
    expect(checked.length).toBe(res.observations.length);
    expect(res.observations.map((o) => [o.evidenceKind, o.subjectKind, o.artifact?.kind, o.artifact?.value])).toEqual([
      ["cloud_audit_log", "cloud_principal", "cloud_ai_service", "aws:bedrock"],
      ["cloud_inventory", "cloud_resource", "cloud_ai_service", "aws:bedrock"],
    ]);
    expect(JSON.stringify(res)).not.toContain("app-role");
    // every read is reported to SD0 as a read outcome, problems first
    const outcomes = res.readOutcomes ?? [];
    expect(outcomes.some((o) => o.read === "aws.bedrock.custom_models@us-east-1" && o.status === "read")).toBe(true);
    expect(outcomes.find((o) => o.read === "aws.cloudtrail.data_events")?.status).toBe("not_enabled");
    const firstRead = outcomes.findIndex((o) => o.status === "read");
    expect(outcomes.slice(firstRead).every((o) => o.status === "read")).toBe(true);
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

  it("the credential fetch throttles and backs off like the scan fetch but never digests (finding 3)", async () => {
    let raw = 0;
    let throttled = 0;
    const f = scannerFetch(
      { fetch: (async () => new Response(`{"access_token":"${synthetic("at")}"}`)) as typeof fetch, throttle: async () => void (throttled += 1), backoff: async () => false, recordRaw: () => void (raw += 1) },
      { digest: false },
    );
    await f("https://sts.us-east-1.amazonaws.com/");
    expect({ raw, throttled }).toEqual({ raw: 0, throttled: 1 });
  });

  it("GCP federation and Azure static: token-exchange bodies never reach recordRaw, and the tokens are registered (recheck finding 1)", async () => {
    const markers: string[] = [];
    const token = (label: string) => {
      const t = synthetic(`tok-${label}`);
      markers.push(t);
      return t;
    };
    const cloud = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const h = url.hostname;
      if (h === "sts.googleapis.com") return json({ access_token: token("gsts"), issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3600 });
      if (h === "iamcredentials.googleapis.com") return json({ accessToken: token("gimp"), expireTime: "2026-10-17T13:00:00Z" });
      if (h === "login.microsoftonline.com") {
        const tenant = url.pathname.split("/")[1];
        const base = `https://login.microsoftonline.com/${tenant}`;
        if (url.pathname.endsWith("/discovery/instance")) return json({ tenant_discovery_endpoint: `${base}/v2.0/.well-known/openid-configuration`, metadata: [] });
        if (url.pathname.endsWith("/openid-configuration")) return json({ token_endpoint: `${base}/oauth2/v2.0/token`, authorization_endpoint: `${base}/oauth2/v2.0/authorize`, issuer: `${base}/v2.0` });
        return json({ token_type: "Bearer", expires_in: 3600, access_token: token("entra") });
      }
      return json({ totalRecords: 0, count: 0, resultTruncated: "false", data: [], value: [] });
    }) as typeof fetch;

    const gcp = ctxFor({
      fetch: cloud,
      source: { id: "g", name: "gcp", kind: "cloud_gcp", target: { projectId: "acme-ml" }, scope: { orgLevel: false, include: ["acme-ml"] } },
      credential: { mode: "federated", publicConfig: { projectNumber: "123", workloadIdentityPool: "regulait", workloadIdentityProvider: "regulait-oidc", serviceAccountEmail: "scanner@acme-ml.iam.gserviceaccount.com" }, secret: null },
    });
    const oidc = synthetic("oidc");
    await cloudScanner("cloud_gcp", { oidcToken: async () => oidc }).run(gcp.ctx);

    const az = ctxFor({
      fetch: cloud,
      source: { id: "a", name: "az", kind: "cloud_azure", target: { tenantId: "00000000-0000-4000-8000-000000000001" }, scope: { orgLevel: false, include: ["00000000-0000-4000-8000-0000000000aa"] } },
      credential: { mode: "static", publicConfig: { tenantId: "00000000-0000-4000-8000-000000000001", clientId: "00000000-0000-4000-8000-000000000002" }, secret: synthetic("cs") },
    });
    await cloudScanner("cloud_azure").run(az.ctx);

    expect(markers.length).toBeGreaterThanOrEqual(3); // GCP STS, IAM Credentials, Entra
    const digested = [...gcp.calls.chunks, ...az.calls.chunks].join("\n");
    for (const m of markers) expect(digested).not.toContain(m);
    const registered = [...gcp.calls.secrets, ...az.calls.secrets];
    for (const m of markers) expect(registered).toContain(m);
    expect(registered).toContain(oidc);
  });

  it("capabilitySummary lists only reads that did not succeed", () => {
    expect(capabilitySummary([
      { capability: "a", scope: null, status: "read", items: 1 },
      { capability: "b", scope: "r", status: "denied", detail: "AccessDenied" },
    ])).toBe("b@r: denied (AccessDenied)");
  });
});
