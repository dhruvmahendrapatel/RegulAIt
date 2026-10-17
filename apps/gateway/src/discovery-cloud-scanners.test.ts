/**
 * ADR-0195 SD2 phase B: the cloud scanners against SD0's Scanner contract, without a database. A fake cloud stands
 * behind `ctx.fetch`; the test checks the worker hooks (throttle before every request, back-off on 429, every body
 * digested, principals pseudonymised as `cloud_principal`), that the observations pass the worker's own
 * `checkObservations` for the source kind, and that federation and an all-unreachable run fail with a reason.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { captureSentSecrets } from "@regulait/cloud-discovery";
import { FEDERATION_AWS_PRINCIPAL_SUBJECT } from "@regulait/shared";
import { cloudScanner, capabilitySummary, dedupedSecretSink, digestBounded, scannerFetch } from "./discovery-cloud-scanners.js";
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

  it("a federated credential with no federation hook (federation off) fails with that reason, before any request", async () => {
    const cloud = fakeAws();
    const { ctx } = ctxFor({
      fetch: cloud.f,
      credential: { mode: "federated", publicConfig: { roleArn: `arn:aws:iam::${ACCOUNT}:role/r`, externalId: "regulait-x" }, secret: null },
    });
    await expect(cloudScanner("cloud_aws").run(ctx)).rejects.toThrow(/federation issuer/);
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
      if (h === "iamcredentials.googleapis.com") return json({ accessToken: token("gimp"), expireTime: new Date(Date.now() + 3_600_000).toISOString() });
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

  it("secret registration is deduplicated: past 64 requests a rotated token is still registered (round 2, finding 1)", async () => {
    // SD0's cap, as the worker applies it: at most 64 registered values
    const store: string[] = [];
    const capped = (v: string) => {
      if (store.length < 64) store.push(v);
    };
    const sink = dedupedSecretSink(capped);
    const sent: string[] = [];
    const f = captureSentSecrets((async (_u: string | URL | Request, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}");
    }) as typeof fetch, sink);
    const first = synthetic("tok-a");
    const rotated = synthetic("tok-b");
    for (let i = 0; i < 70; i++) await f("https://management.azure.com/x", { headers: { authorization: `Bearer ${first}` } });
    for (let i = 0; i < 5; i++) await f("https://management.azure.com/x", { headers: { authorization: `Bearer ${rotated}` } });
    expect(sent).toHaveLength(75);
    expect(store).toEqual([first, rotated]);

    // end to end: an Azure scan over 40 subscriptions sends one token on 80+ requests and registers it once
    const az = ctxFor({
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === "login.microsoftonline.com") {
          const base = `https://login.microsoftonline.com/${url.pathname.split("/")[1]}`;
          if (url.pathname.endsWith("/discovery/instance")) return json({ tenant_discovery_endpoint: `${base}/v2.0/.well-known/openid-configuration`, metadata: [] });
          if (url.pathname.endsWith("/openid-configuration")) return json({ token_endpoint: `${base}/oauth2/v2.0/token`, authorization_endpoint: `${base}/oauth2/v2.0/authorize`, issuer: `${base}/v2.0` });
          return json({ token_type: "Bearer", expires_in: 3600, access_token: synthetic("entra") });
        }
        return json({ totalRecords: 0, count: 0, resultTruncated: "false", data: [], value: [] });
      }) as typeof fetch,
      source: { id: "a", name: "az", kind: "cloud_azure", target: {}, scope: { orgLevel: false, include: Array.from({ length: 40 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) } },
      credential: { mode: "static", publicConfig: { tenantId: "00000000-0000-4000-8000-000000000001", clientId: "00000000-0000-4000-8000-000000000002" }, secret: synthetic("cs") },
    });
    await cloudScanner("cloud_azure").run(az.ctx).catch(() => undefined);
    expect(az.calls.throttle).toBeGreaterThan(80);
    expect(new Set(az.calls.secrets).size).toBe(az.calls.secrets.length);
  });

  it("capabilitySummary lists only reads that did not succeed", () => {
    expect(capabilitySummary([
      { capability: "a", scope: null, status: "read", items: 1 },
      { capability: "b", scope: "r", status: "denied", detail: "AccessDenied" },
    ])).toBe("b@r: denied (AccessDenied)");
  });
});

// ---------------------------------------------------------------------------
// ADR-0195 SD2b: federation (source tokens, RegulAIt's own AWS principal) and AWS Organizations
// ---------------------------------------------------------------------------

const MEMBER_A = "444455556666";
const MEMBER_B = "777788889999";
const SUSPENDED = "123412341234";

const bodyText = (init?: RequestInit): string => {
  const raw = init?.body;
  return typeof raw === "string" ? raw : raw ? new TextDecoder().decode(raw as ArrayBuffer) : "";
};
const stsCreds = (tag: string, accessKeyId: string) => {
  const exp = new Date(Date.now() + 3_600_000).toISOString();
  return new Response(
    `<${tag}Response><${tag}Result><Credentials><AccessKeyId>${accessKeyId}</AccessKeyId><SecretAccessKey>${synthetic("sk")}</SecretAccessKey><SessionToken>${synthetic("st")}</SessionToken><Expiration>${exp}</Expiration></Credentials></${tag}Result></${tag}Response>`,
    { headers: { "content-type": "text/xml" } },
  );
};

/**
 * A fake AWS for federated runs. STS answers AssumeRoleWithWebIdentity and AssumeRole with session credentials whose
 * access key id names the account they belong to (`ASIA<account>`), and GetCallerIdentity reads that id back from
 * the request's signature, so a member account's scanner sees its own account. Organizations answers ListAccounts in
 * two pages.
 */
function fakeFederatedAws() {
  const hosts: string[] = [];
  const sts: Array<Record<string, string>> = [];
  const orgPages: Array<string | null> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    hosts.push(url.hostname);
    if (url.hostname.startsWith("sts.")) {
      const form = Object.fromEntries(new URLSearchParams(bodyText(init)));
      sts.push(form);
      if (form.Action === "AssumeRoleWithWebIdentity") return stsCreds("AssumeRoleWithWebIdentity", `ASIA${form.RoleArn!.split(":")[4]}`);
      if (form.Action === "AssumeRole") return stsCreds("AssumeRole", `ASIA${form.RoleArn!.split(":")[4]}`);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const account = /Credential=ASIA([0-9]{12})\//.exec(auth)?.[1] ?? "000000000000";
      return new Response(`<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:sts::${account}:assumed-role/r/s</Arn><UserId>U</UserId><Account>${account}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`, { headers: { "content-type": "text/xml" } });
    }
    if (url.hostname.startsWith("organizations.")) {
      const body = JSON.parse(bodyText(init) || "{}") as { NextToken?: string };
      orgPages.push(body.NextToken ?? null);
      if (!body.NextToken) return json({ Accounts: [{ Id: ACCOUNT, State: "ACTIVE" }, { Id: MEMBER_A, State: "ACTIVE" }], NextToken: "page-2" });
      return json({ Accounts: [{ Id: MEMBER_B, Status: "ACTIVE" }, { Id: SUSPENDED, State: "SUSPENDED" }] });
    }
    if (url.hostname.startsWith("account.")) return json({ Regions: [{ RegionName: "us-east-1", RegionOptStatus: "ENABLED_BY_DEFAULT" }] });
    if (url.hostname.startsWith("cloudtrail.")) return json({ Events: [] });
    return json({});
  }) as typeof fetch;
  return { f, hosts, sts, orgPages };
}

function federationHook(minted: Array<{ subject: string; audience: string; token: string }>, principalRoleArn: string | null = null) {
  const mint = (subject: string, allowed: string[]) => async (audience: string) => {
    if (!allowed.includes(audience)) throw new Error(`audience refused: ${audience}`);
    const token = synthetic(`fed-${subject.length}`);
    minted.push({ subject, audience, token });
    return token;
  };
  return {
    sourceToken: mint("regulait:discovery-source:s1", ["sts.amazonaws.com"]),
    awsPrincipal: principalRoleArn ? { roleArn: principalRoleArn, token: mint(FEDERATION_AWS_PRINCIPAL_SUBJECT, ["sts.amazonaws.com"]) } : null,
  };
}

describe("ADR-0195 SD2b: federated cloud credentials and AWS Organizations", () => {
  const roleArn = `arn:aws:iam::${ACCOUNT}:role/regulait-reader`;
  const externalId = "regulait-00000000-0000-4000-8000-000000000009";

  it("AWS oidc: AssumeRoleWithWebIdentity with a source token for sts.amazonaws.com, through ctx.fetch, the token registered", async () => {
    const cloud = fakeFederatedAws();
    const minted: Array<{ subject: string; audience: string; token: string }> = [];
    const { ctx, calls } = ctxFor({ fetch: cloud.f, credential: { mode: "federated", publicConfig: { roleArn, externalId }, secret: null }, federation: federationHook(minted) });
    const res = await cloudScanner("cloud_aws").run(ctx);
    expect(minted.map((m) => [m.subject, m.audience])).toEqual([["regulait:discovery-source:s1", "sts.amazonaws.com"]]);
    const exchange = cloud.sts.find((r) => r.Action === "AssumeRoleWithWebIdentity")!;
    expect(exchange).toMatchObject({ RoleArn: roleArn, WebIdentityToken: minted[0]!.token });
    expect(calls.secrets).toContain(minted[0]!.token);
    // the exchange response (it carries credentials) is never digested, and the token never is either
    expect(calls.chunks.join("\n")).not.toContain(minted[0]!.token);
    expect(calls.throttle).toBe(cloud.hosts.length); // every request, the exchange included, went through ctx.fetch
    expect(res.readOutcomes?.find((o) => o.read === "aws.sts.caller_identity")?.status).toBe("read");
  });

  it("AWS principal: RegulAIt's own principal by web identity, then AssumeRole into the customer's role with the external id", async () => {
    const cloud = fakeFederatedAws();
    const minted: Array<{ subject: string; audience: string; token: string }> = [];
    const principal = "arn:aws:iam::999999999999:role/regulait-principal";
    const { ctx } = ctxFor({
      fetch: cloud.f,
      source: { id: "s1", name: "aws", kind: "cloud_aws", target: { accountId: ACCOUNT, federation: "principal" }, scope: { orgLevel: false, include: ["us-east-1"] } },
      credential: { mode: "federated", publicConfig: { roleArn, externalId }, secret: null },
      federation: federationHook(minted, principal),
    });
    await cloudScanner("cloud_aws").run(ctx);
    expect(cloud.sts.filter((r) => r.Action !== "GetCallerIdentity").map((r) => [r.Action, r.RoleArn, r.ExternalId ?? null])).toEqual([
      ["AssumeRoleWithWebIdentity", principal, null],
      ["AssumeRole", roleArn, externalId],
    ]);
    expect(minted.map((m) => m.subject)).toEqual([FEDERATION_AWS_PRINCIPAL_SUBJECT]);
  });

  it("AWS principal without a configured principal is refused before any request", async () => {
    const cloud = fakeFederatedAws();
    const { ctx } = ctxFor({
      fetch: cloud.f,
      source: { id: "s1", name: "aws", kind: "cloud_aws", target: { accountId: ACCOUNT, federation: "principal" }, scope: { orgLevel: false, include: ["us-east-1"] } },
      credential: { mode: "federated", publicConfig: { roleArn, externalId }, secret: null },
      federation: federationHook([]),
    });
    await expect(cloudScanner("cloud_aws").run(ctx)).rejects.toThrow(/own AWS principal/);
    expect(cloud.hosts).toEqual([]);
  });

  it("Organizations: ListAccounts is paginated, active members are scanned through AssumeRole with the external id", async () => {
    const cloud = fakeFederatedAws();
    const { ctx } = ctxFor({
      fetch: cloud.f,
      source: { id: "s1", name: "aws", kind: "cloud_aws", target: { accountId: ACCOUNT, organizationAccounts: "true", memberRoleName: "RegulaitReader" }, scope: { orgLevel: false, include: ["us-east-1"] } },
      credential: { mode: "federated", publicConfig: { roleArn, externalId }, secret: null },
      federation: federationHook([]),
    });
    const res = await cloudScanner("cloud_aws").run(ctx);
    expect(cloud.orgPages).toEqual([null, "page-2"]);
    const assumed = cloud.sts.filter((r) => r.Action === "AssumeRole").map((r) => [r.RoleArn, r.ExternalId]);
    expect(assumed).toEqual([
      [`arn:aws:iam::${MEMBER_A}:role/RegulaitReader`, externalId],
      [`arn:aws:iam::${MEMBER_B}:role/RegulaitReader`, externalId],
    ]);
    const outcomes = res.readOutcomes ?? [];
    expect(outcomes.find((o) => o.read === "aws.organizations.accounts")).toMatchObject({ status: "read", detail: "4 account(s) listed, 3 active" });
    expect(outcomes.find((o) => o.read === `aws.sts.caller_identity@${MEMBER_A}:account`)?.status).toBe("read");
    expect(outcomes.some((o) => o.read.includes(SUSPENDED))).toBe(false);
    expect(cloud.hosts.filter((h) => h.startsWith("organizations."))).toHaveLength(2);
  });

  it("Organizations without a member role lists the accounts and says they were not scanned", async () => {
    const cloud = fakeFederatedAws();
    const { ctx } = ctxFor({
      fetch: cloud.f,
      source: { id: "s1", name: "aws", kind: "cloud_aws", target: { accountId: ACCOUNT, organizationAccounts: "true" }, scope: { orgLevel: false, include: ["us-east-1"] } },
      credential: { mode: "federated", publicConfig: { roleArn, externalId }, secret: null },
      federation: federationHook([]),
    });
    const res = await cloudScanner("cloud_aws").run(ctx);
    expect(res.readOutcomes?.find((o) => o.read === "aws.organizations.member_scan")).toMatchObject({ status: "skipped" });
    expect(cloud.sts.filter((r) => r.Action === "AssumeRole")).toEqual([]);
  });

  it("Organizations through the egress guard: a refused host is reported unreachable, the account scan still stands", async () => {
    const cloud = fakeFederatedAws();
    const guarded = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname.startsWith("organizations.")) throw Object.assign(new Error("egress blocked (host_not_allowlisted): host not allowed"), { name: "EgressBlockedError" });
      return cloud.f(input, init);
    }) as typeof fetch;
    const { ctx } = ctxFor({
      fetch: guarded,
      source: { id: "s1", name: "aws", kind: "cloud_aws", target: { accountId: ACCOUNT, organizationAccounts: "true", memberRoleName: "RegulaitReader" }, scope: { orgLevel: false, include: ["us-east-1"] } },
      credential: { mode: "federated", publicConfig: { roleArn, externalId }, secret: null },
      federation: federationHook([]),
    });
    const res = await cloudScanner("cloud_aws").run(ctx);
    expect(res.readOutcomes?.find((o) => o.read === "aws.organizations.accounts")?.status).toBe("unreachable");
    expect(cloud.sts.filter((r) => r.Action === "AssumeRole")).toEqual([]);
  });

  it("a malformed organisation target is refused before any request", async () => {
    for (const target of <Array<Record<string, string>>>[
      { accountId: ACCOUNT, organizationAccounts: "yes" },
      { accountId: ACCOUNT, organizationAccounts: "true", memberRoleName: "role/with/path" },
      { accountId: ACCOUNT, memberRoleName: "RegulaitReader" },
      { accountId: ACCOUNT, federation: "something" },
    ]) {
      const cloud = fakeFederatedAws();
      const { ctx } = ctxFor({
        fetch: cloud.f,
        source: { id: "s1", name: "aws", kind: "cloud_aws", target, scope: { orgLevel: false, include: ["us-east-1"] } },
        credential: { mode: "federated", publicConfig: { roleArn, externalId }, secret: null },
        federation: federationHook([]),
      });
      await expect(cloudScanner("cloud_aws").run(ctx), JSON.stringify(target)).rejects.toThrow(/cloud_aws/);
      expect(cloud.hosts).toEqual([]);
    }
  });
});
