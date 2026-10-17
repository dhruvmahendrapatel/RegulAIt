import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { AWS_TRAIL_OBJECT_MAX_BYTES, AWS_TRAIL_OBJECT_MAX_INFLATED_BYTES, AwsCloudScanner } from "./aws.js";
import { fakeCloud, installNetworkTripwire, json, synthetic, testPseudonymise, xml, type RecordedCall } from "./test-cloud.js";
import type { CloudScanContext } from "./types.js";

const ACCOUNT = "111122223333";
const ROLE = `arn:aws:iam::${ACCOUNT}:role/regulait-discovery`;
const NOW = new Date("2026-10-17T12:00:00Z");

const ctx = (over: Partial<CloudScanContext> = {}): CloudScanContext => ({
  now: NOW,
  auditLookbackDays: 30,
  pseudonymise: testPseudonymise,
  maxPagesPerCall: 5,
  ...over,
});

const target = (call: RecordedCall) => call.headers.get("x-amz-target") ?? "";

function stsRoute(call: RecordedCall): Response | undefined {
  if (!call.url.hostname.startsWith("sts.")) return undefined;
  const params = new URLSearchParams(call.body);
  const action = params.get("Action");
  const result = `<Credentials><AccessKeyId>${synthetic("akid")}</AccessKeyId><SecretAccessKey>${synthetic("sk")}</SecretAccessKey><SessionToken>${synthetic("st")}</SessionToken><Expiration>2026-10-17T13:00:00Z</Expiration></Credentials>`;
  return xml(`<${action}Response xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><${action}Result>${result}</${action}Result></${action}Response>`);
}

const trailEvent = (eventName: string, roleArn: string, modelId: string) => ({
  EventId: synthetic("ev"),
  EventName: eventName,
  EventTime: Math.floor(new Date("2026-10-10T10:00:00Z").getTime() / 1000),
  EventSource: "bedrock.amazonaws.com",
  CloudTrailEvent: JSON.stringify({
    eventName,
    eventSource: "bedrock.amazonaws.com",
    eventTime: "2026-10-10T10:00:00Z",
    awsRegion: "us-east-1",
    userIdentity: { type: "AssumedRole", arn: `${roleArn}/session`, sessionContext: { sessionIssuer: { arn: roleArn } } },
    requestParameters: { modelId },
  }),
});

function awsRoutes(opts: { denyAgents?: boolean } = {}) {
  return [
    stsRoute,
    (c: RecordedCall) => (c.url.hostname.startsWith("account.") ? json({ Regions: [{ RegionName: "us-east-1", RegionOptStatus: "ENABLED_BY_DEFAULT" }, { RegionName: "eu-west-1", RegionOptStatus: "ENABLED" }] }) : undefined),
    (c: RecordedCall) => {
      if (!c.url.hostname.startsWith("bedrock.")) return undefined;
      const region = c.url.hostname.split(".")[1];
      switch (c.url.pathname) {
        case "/custom-models":
          return json({ modelSummaries: region === "us-east-1" ? [{ modelArn: `arn:aws:bedrock:us-east-1:${ACCOUNT}:custom-model/m1`, modelName: "m1", customizationType: "FINE_TUNING", creationTime: "2026-09-01T00:00:00Z" }] : [] });
        case "/imported-models":
          return json({ modelSummaries: [] });
        case "/provisioned-model-throughputs":
          return json({ provisionedModelSummaries: [] });
        case "/guardrails":
          return json({ guardrails: [] });
        case "/logging/modelinvocations":
          return json({ loggingConfig: region === "us-east-1" ? { s3Config: { bucketName: "logs" } } : undefined });
      }
      return undefined;
    },
    (c: RecordedCall) => {
      if (!c.url.hostname.startsWith("bedrock-agent.")) return undefined;
      if (opts.denyAgents) return json({ message: "not authorized" }, 403, { "x-amzn-errortype": "AccessDeniedException" });
      if (c.url.pathname.startsWith("/agents")) return json({ agentSummaries: [{ agentId: "AGENT1", agentName: "a", agentStatus: "PREPARED", updatedAt: "2026-09-01T00:00:00Z" }] });
      if (c.url.pathname.startsWith("/knowledgebases")) return json({ knowledgeBaseSummaries: [] });
      return undefined;
    },
    (c: RecordedCall) => {
      if (!c.url.hostname.startsWith("api.sagemaker.")) return undefined;
      if (target(c).endsWith("ListEndpoints")) return json({ Endpoints: [] });
      if (target(c).endsWith("ListModels")) return json({ Models: [] });
      return undefined;
    },
    (c: RecordedCall) => {
      if (!c.url.hostname.startsWith("cloudtrail.")) return undefined;
      const region = c.url.hostname.split(".")[1];
      const req = JSON.parse(c.body) as { LookupAttributes: Array<{ AttributeValue: string }> };
      const name = req.LookupAttributes[0]!.AttributeValue;
      if (region !== "us-east-1" || (name !== "InvokeModel" && name !== "Converse")) return json({ Events: [] });
      return json({ Events: [trailEvent(name, `arn:aws:iam::${ACCOUNT}:role/app-role`, "custom-model-a")] });
    },
  ];
}

describe("AwsCloudScanner through the real AWS SDK and a fake cloud", () => {
  let wire: Awaited<ReturnType<typeof installNetworkTripwire>>;
  beforeAll(async () => {
    wire = await installNetworkTripwire();
  });
  afterEach(() => {
    const escaped = wire.escaped.splice(0);
    expect(escaped).toEqual([]);
  });
  afterAll(() => wire.restore());

  it("federated: exchanges the RegulAIt OIDC token, lists Bedrock resources per region and groups CloudTrail calls by principal", async () => {
    const cloud = fakeCloud(awsRoutes());
    const audiences: string[] = [];
    const scanner = new AwsCloudScanner(
      { accountId: ACCOUNT },
      { fetch: cloud.fetch, credential: { mode: "aws_web_identity", roleArn: ROLE }, oidcToken: async (aud) => (audiences.push(aud), synthetic("oidc")) },
    );
    const res = await scanner.scan(ctx());
    expect(cloud.unrouted.map((c) => `${c.method} ${c.url.href}`)).toEqual([]);

    // one exchange, shared by every regional client
    const sts = cloud.calls.filter((c) => c.url.hostname.startsWith("sts."));
    expect(sts).toHaveLength(1);
    expect(new URLSearchParams(sts[0]!.body).get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(audiences).toEqual(["sts.amazonaws.com"]);

    const resources = res.observations.filter((o) => o.subjectKind === "cloud_resource");
    expect(resources.map((o) => [o.serviceKey, o.resourceType, o.location])).toEqual([
      ["aws:bedrock", "bedrock.agent", "eu-west-1"],
      ["aws:bedrock", "bedrock.agent", "us-east-1"],
      ["aws:bedrock", "bedrock.custom_model", "us-east-1"],
    ]);

    const principals = res.observations.filter((o) => o.subjectKind === "cloud_principal");
    expect(principals).toHaveLength(1);
    const p = principals[0]!;
    expect(p.signalSource).toBe("cloud_audit_log");
    expect(p.callCount).toBe(2);
    expect(p.operations).toEqual(["Converse", "InvokeModel"]);
    // rule 20: the raw ARN never reaches an observation
    expect(JSON.stringify(res.observations)).not.toContain("app-role");
    expect(p.subject.startsWith("pseudo:aws:")).toBe(true);

    const cap = (id: string, scope: string | null) => res.capabilities.find((x) => x.capability === id && x.scope === scope);
    expect(cap("aws.bedrock.invocation_logging", "us-east-1")?.detail).toBe("model-invocation logging is enabled");
    expect(cap("aws.bedrock.invocation_logging", "eu-west-1")?.detail).toBe("model-invocation logging is not enabled");
    expect(cap("aws.cloudtrail.data_events", null)?.status).toBe("not_enabled");
    expect(res.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a refused read as denied instead of as an empty result", async () => {
    const cloud = fakeCloud(awsRoutes({ denyAgents: true }));
    const scanner = new AwsCloudScanner(
      { accountId: ACCOUNT, regions: ["us-east-1"] },
      { fetch: cloud.fetch, credential: { mode: "aws_static", accessKeyId: synthetic("akid"), secretAccessKey: synthetic("sk") } },
    );
    const res = await scanner.scan(ctx());
    const agents = res.capabilities.find((x) => x.capability === "aws.bedrock.agents");
    expect(agents?.status).toBe("denied");
    expect(res.observations.some((o) => o.resourceType === "bedrock.agent")).toBe(false);
    // static mode makes no STS call
    expect(cloud.calls.some((c) => c.url.hostname.startsWith("sts."))).toBe(false);
  });

  it("trail bucket: skips objects over the size cap and gzip bombs, still reads the rest (review finding 2)", async () => {
    const prefix = `AWSLogs/${ACCOUNT}/CloudTrail/`;
    const day = "2026/10/17/";
    const record = { Records: [{ eventName: "InvokeAgent", eventSource: "bedrock.amazonaws.com", eventTime: "2026-10-17T08:00:00Z", awsRegion: "us-east-1", userIdentity: { arn: `arn:aws:iam::${ACCOUNT}:role/agent-caller` } }] };
    const okBody = gzipSync(Buffer.from(JSON.stringify(record)));
    const bombBody = gzipSync(Buffer.alloc(AWS_TRAIL_OBJECT_MAX_INFLATED_BYTES + 1024));
    const listXml = (contents: string, prefixes = "") =>
      xml(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>trail</Name><IsTruncated>false</IsTruncated>${contents}${prefixes}</ListBucketResult>`);
    const got: string[] = [];
    const cloud = fakeCloud([
      (c) => {
        if (!c.url.hostname.startsWith("trail.s3.")) return undefined;
        const p = c.url.searchParams.get("prefix");
        if (c.url.searchParams.get("list-type") === "2" && p === prefix) return listXml("", `<CommonPrefixes><Prefix>${prefix}us-east-1/</Prefix></CommonPrefixes>`);
        if (c.url.searchParams.get("list-type") === "2" && p === `${prefix}us-east-1/${day}`) {
          const k = (key: string, size: number) => `<Contents><Key>${prefix}us-east-1/${day}${key}</Key><Size>${size}</Size></Contents>`;
          return listXml(k("big.json.gz", AWS_TRAIL_OBJECT_MAX_BYTES + 1) + k("bomb.json.gz", bombBody.length) + k("nolen.json.gz", 10) + k("ok.json.gz", okBody.length));
        }
        if (c.url.searchParams.get("list-type") === "2") return listXml("");
        got.push(c.url.pathname);
        if (c.url.pathname.endsWith("bomb.json.gz")) return new Response(bombBody, { headers: { "content-length": String(bombBody.length) } });
        if (c.url.pathname.endsWith("ok.json.gz")) return new Response(okBody, { headers: { "content-length": String(okBody.length) } });
        if (c.url.pathname.endsWith("nolen.json.gz")) {
          // listed as tiny, served with no Content-Length and far over the cap: the running cap must stop it
          let sent = 0;
          const chunk = new Uint8Array(1024 * 1024);
          return new Response(new ReadableStream<Uint8Array>({
            pull(ctrl) {
              if (sent > AWS_TRAIL_OBJECT_MAX_BYTES * 2) return ctrl.close();
              sent += chunk.byteLength;
              ctrl.enqueue(chunk);
            },
          }));
        }
        return undefined;
      },
      ...awsRoutes(),
    ]);
    const scanner = new AwsCloudScanner(
      { accountId: ACCOUNT, regions: ["us-east-1"], trailBucket: { bucket: "trail", region: "us-east-1" } },
      { fetch: cloud.fetch, credential: { mode: "aws_static", accessKeyId: synthetic("akid"), secretAccessKey: synthetic("sk") } },
    );
    const res = await scanner.scan({ ...ctx(), auditLookbackDays: 1 });
    expect(cloud.unrouted.map((c) => `${c.method} ${c.url.href}`)).toEqual([]);
    expect(got.some((p) => p.endsWith("big.json.gz"))).toBe(false); // never fetched
    const cap = res.capabilities.find((x) => x.capability === "aws.cloudtrail.data_events");
    expect(cap?.status).toBe("read");
    expect(cap?.items).toBe(1);
    expect(cap?.detail).toContain("3 object(s) skipped");
  });

  it("assume-role mode sends the per-source external id", async () => {
    const cloud = fakeCloud(awsRoutes());
    const scanner = new AwsCloudScanner(
      { accountId: ACCOUNT, regions: ["us-east-1"] },
      {
        fetch: cloud.fetch,
        credential: { mode: "aws_assume_role", roleArn: ROLE, externalId: "regulait-test-external-id" },
        sourceCredentials: async () => ({ accessKeyId: synthetic("akid"), secretAccessKey: synthetic("sk") }),
      },
    );
    await scanner.scan(ctx());
    const sts = cloud.calls.find((c) => c.url.hostname.startsWith("sts."));
    const params = new URLSearchParams(sts!.body);
    expect(params.get("Action")).toBe("AssumeRole");
    expect(params.get("ExternalId")).toBe("regulait-test-external-id");
  });
});
