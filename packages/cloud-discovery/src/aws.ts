/**
 * ADR-0195 decision 16, AWS adapter. Lists only AI services, read-only:
 *
 *  - regions: Account `ListRegions` (enabled and enabled-by-default), intersected with the source's region scope;
 *  - per region: Bedrock custom and imported models, provisioned throughput, guardrails and the model-invocation
 *    logging setting; Bedrock agents and knowledge bases; SageMaker endpoints and models;
 *  - per region: CloudTrail `LookupEvents` for `InvokeModel`, `InvokeModelWithResponseStream`, `Converse` and
 *    `ConverseStream`, grouped by calling principal. LookupEvents returns management events only and at most 90
 *    days of them;
 *  - optional: the trail's S3 bucket, read for the data events LookupEvents cannot return (`InvokeAgent`,
 *    `Retrieve`, `RetrieveAndGenerate`). Only when the customer configured data-event selectors and granted read on
 *    the bucket; otherwise reported `not_enabled`.
 *
 * Every client is built with the guarded request handler (decision 8) and explicit credentials; nothing reads the
 * default credential chain or instance metadata.
 */
import { gunzipSync } from "node:zlib";
import { AccountClient, ListRegionsCommand, type Region } from "@aws-sdk/client-account";
import {
  BedrockClient,
  GetModelInvocationLoggingConfigurationCommand,
  ListCustomModelsCommand,
  ListGuardrailsCommand,
  ListImportedModelsCommand,
  ListProvisionedModelThroughputsCommand,
} from "@aws-sdk/client-bedrock";
import { BedrockAgentClient, ListAgentsCommand, ListKnowledgeBasesCommand } from "@aws-sdk/client-bedrock-agent";
import { CloudTrailClient, LookupEventsCommand, type Event as TrailEvent } from "@aws-sdk/client-cloudtrail";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { ListEndpointsCommand, ListModelsCommand, SageMakerClient } from "@aws-sdk/client-sagemaker";
import { fromTemporaryCredentials, fromWebToken } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";
import { awsCredentialSchema, type AwsCredentialInput, type OidcTokenSupplier } from "./credentials.js";
import { lookbackStart, paginate, PrincipalAggregator, ScanCollector } from "./report.js";
import { BodyTooLargeError, guardedAwsRequestHandler, readBodyCapped, type GuardedFetch } from "./transport.js";
import { MAX_AUDIT_LOOKBACK_DAYS, shouldStop, type CloudScanContext, type CloudScanner, type CloudScanResult } from "./types.js";

export const AWS_SERVICE_KEYS = { bedrock: "aws:bedrock", sagemaker: "aws:sagemaker" } as const;

/** management events LookupEvents can return (decision 16) */
export const AWS_LOOKUP_EVENT_NAMES = ["InvokeModel", "InvokeModelWithResponseStream", "Converse", "ConverseStream"] as const;
/** data events only the trail bucket holds */
export const AWS_DATA_EVENT_NAMES = new Set(["InvokeAgent", "Retrieve", "RetrieveAndGenerate", "InvokeModel", "InvokeModelWithResponseStream", "Converse", "ConverseStream"]);

/** a CloudTrail log object is at most a few hundred KB; anything over this is skipped unread (review of #404, finding 2) */
export const AWS_TRAIL_OBJECT_MAX_BYTES = 8 * 1024 * 1024;
/** and no object may inflate past this (gzip bomb guard) */
export const AWS_TRAIL_OBJECT_MAX_INFLATED_BYTES = 64 * 1024 * 1024;

export interface AwsTrailBucket {
  bucket: string;
  /** the trail's key prefix, if any (without the trailing `AWSLogs/`) */
  prefix?: string;
  /** the bucket's region */
  region: string;
  /** cap on log objects read per run (default 200) */
  maxObjects?: number;
}

export interface AwsScanTarget {
  accountId: string;
  /** region scope; omitted means every region the account has enabled */
  regions?: string[];
  /** region of the STS endpoint used for the credential exchange (default us-east-1) */
  stsRegion?: string;
  trailBucket?: AwsTrailBucket;
}

export interface AwsScannerDeps {
  fetch: GuardedFetch;
  /**
   * The guarded fetch for credential exchanges, whose responses carry credentials (review of #404, finding 3).
   * Defaults to `fetch`. A caller that digests `fetch` responses passes an undigested one here.
   */
  credentialFetch?: GuardedFetch;
  credential: AwsCredentialInput;
  /** federated mode: mints the OIDC token RegulAIt presents to AssumeRoleWithWebIdentity */
  oidcToken?: OidcTokenSupplier;
  /** aws_assume_role mode: the existing principal's credentials (never the default chain) */
  sourceCredentials?: AwsCredentialIdentityProvider;
  roleSessionName?: string;
}

const DEFAULT_SESSION_NAME = "regulait-discovery";

/**
 * Pinned endpoint resolution (review of #404, finding 1). The AWS SDK otherwise honours ambient configuration that
 * can move a signed request to another host: AWS_ENDPOINT_URL and AWS_ENDPOINT_URL_<SERVICE>, `endpoint_url` in a
 * shared config profile (AWS_PROFILE / AWS_CONFIG_FILE), and the FIPS and dual-stack switches. Every client and every
 * STS client sets these explicitly, so only the region decides the host and the egress allow list decides whether
 * it is reachable.
 */
export const AWS_PINNED_ENDPOINT_CONFIG = Object.freeze({
  ignoreConfiguredEndpointUrls: true,
  useFipsEndpoint: false,
  useDualstackEndpoint: false,
});
const FALLBACK_REGION = "us-east-1";

/** share one set of short-lived credentials across every regional client; refresh five minutes before expiry */
function memoizeCredentials(provider: AwsCredentialIdentityProvider): AwsCredentialIdentityProvider {
  let current: Promise<AwsCredentialIdentity> | null = null;
  let expiresAt = 0;
  return async () => {
    if (!current || (expiresAt && Date.now() > expiresAt - 300_000)) {
      current = provider().then((c) => {
        expiresAt = c.expiration ? c.expiration.getTime() : 0;
        return c;
      });
      current.catch(() => {
        current = null;
      });
    }
    return current;
  };
}

/** build the credential provider for one source; every STS call goes through the guarded handler */
export function awsCredentialProvider(deps: AwsScannerDeps, stsRegion: string): AwsCredentialIdentityProvider {
  const cred = awsCredentialSchema.parse(deps.credential);
  const clientConfig = { region: stsRegion, requestHandler: guardedAwsRequestHandler(deps.credentialFetch ?? deps.fetch), ...AWS_PINNED_ENDPOINT_CONFIG };
  const sessionName = deps.roleSessionName ?? DEFAULT_SESSION_NAME;
  switch (cred.mode) {
    case "aws_static": {
      const identity: AwsCredentialIdentity = {
        accessKeyId: cred.accessKeyId,
        secretAccessKey: cred.secretAccessKey,
        ...(cred.sessionToken ? { sessionToken: cred.sessionToken } : {}),
      };
      return async () => identity;
    }
    case "aws_web_identity": {
      const supplier = deps.oidcToken;
      if (!supplier) throw new Error("cloud-discovery: aws_web_identity needs an OIDC token supplier");
      return memoizeCredentials(async () =>
        fromWebToken({
          roleArn: cred.roleArn,
          webIdentityToken: await supplier(cred.audience),
          roleSessionName: cred.roleSessionName ?? sessionName,
          durationSeconds: 3600,
          clientConfig,
        })(),
      );
    }
    case "aws_assume_role": {
      if (!deps.sourceCredentials) throw new Error("cloud-discovery: aws_assume_role needs the source principal's credentials");
      return memoizeCredentials(
        fromTemporaryCredentials({
          params: { RoleArn: cred.roleArn, ExternalId: cred.externalId, RoleSessionName: cred.roleSessionName ?? sessionName, DurationSeconds: 3600 },
          masterCredentials: deps.sourceCredentials,
          clientConfig,
        }),
      );
    }
  }
}

const iso = (d: Date | undefined): string | undefined => (d ? d.toISOString() : undefined);

interface TrailRecord {
  eventName?: string;
  eventSource?: string;
  eventTime?: string;
  awsRegion?: string;
  recipientAccountId?: string;
  userIdentity?: { arn?: string; principalId?: string; type?: string; sessionContext?: { sessionIssuer?: { arn?: string } } };
  requestParameters?: { modelId?: string } | null;
}

/** the calling principal: the role behind an assumed-role session where present, else the caller's ARN */
function principalOf(r: TrailRecord): string | null {
  const id = r.userIdentity;
  if (!id) return null;
  return id.sessionContext?.sessionIssuer?.arn ?? id.arn ?? (id.principalId ? `${id.type ?? "principal"}:${id.principalId}` : null);
}

export class AwsCloudScanner implements CloudScanner {
  readonly provider = "aws" as const;
  readonly #credentials: AwsCredentialIdentityProvider;
  readonly #fetch: GuardedFetch;

  constructor(readonly target: AwsScanTarget, deps: AwsScannerDeps) {
    this.#fetch = deps.fetch;
    this.#credentials = awsCredentialProvider(deps, target.stsRegion ?? FALLBACK_REGION);
  }

  #config(region: string) {
    return { region, credentials: this.#credentials, requestHandler: guardedAwsRequestHandler(this.#fetch), maxAttempts: 3, ...AWS_PINNED_ENDPOINT_CONFIG };
  }

  async scan(ctx: CloudScanContext): Promise<CloudScanResult> {
    const c = new ScanCollector("aws", ctx);
    const regions = await this.#regions(c, ctx);
    for (const region of regions) {
      if (await shouldStop(ctx)) break;
      await this.#inventory(c, ctx, region);
      await this.#lookupEvents(c, ctx, region);
    }
    await this.#trailBucket(c, ctx);
    return c.finish();
  }

  async #regions(c: ScanCollector, ctx: CloudScanContext): Promise<string[]> {
    const account = new AccountClient(this.#config(this.target.stsRegion ?? FALLBACK_REGION));
    const listed = await c.attempt<Region>(
      "aws.account.regions",
      null,
      () =>
        paginate(
          ctx.maxPagesPerCall,
          (NextToken) => account.send(new ListRegionsCommand({ RegionOptStatusContains: ["ENABLED", "ENABLED_BY_DEFAULT"], NextToken })),
          (p) => p.Regions,
          (p) => p.NextToken,
        ),
      () => undefined,
    );
    const enabled = listed?.map((r) => r.RegionName).filter((r): r is string => !!r) ?? null;
    if (this.target.regions?.length) {
      if (!enabled) return [...this.target.regions];
      const scoped = this.target.regions.filter((r) => enabled.includes(r));
      const outside = this.target.regions.filter((r) => !enabled.includes(r));
      if (outside.length) c.report("aws.account.regions", null, "skipped", `not enabled in the account, not scanned: ${outside.join(", ")}`);
      return scoped;
    }
    if (enabled) return enabled;
    const fallback = this.target.stsRegion ?? FALLBACK_REGION;
    c.report("aws.account.regions", null, "skipped", `region list unreadable and no region scope set; scanning ${fallback} only`);
    return [fallback];
  }

  #resource(c: ScanCollector, region: string, serviceKey: string, resourceType: string, subject: string | undefined, attributes?: Record<string, string | undefined>) {
    if (!subject) return;
    const attrs = Object.fromEntries(Object.entries(attributes ?? {}).filter((e): e is [string, string] => !!e[1]));
    c.add({
      provider: "aws",
      subjectKind: "cloud_resource",
      subject,
      serviceKey,
      signalSource: "cloud_inventory",
      resourceType,
      location: region,
      container: this.target.accountId,
      ...(Object.keys(attrs).length ? { attributes: attrs } : {}),
    });
  }

  async #inventory(c: ScanCollector, ctx: CloudScanContext, region: string): Promise<void> {
    const cfg = this.#config(region);
    const bedrock = new BedrockClient(cfg);
    const agent = new BedrockAgentClient(cfg);
    const sagemaker = new SageMakerClient(cfg);
    const max = ctx.maxPagesPerCall;
    const B = AWS_SERVICE_KEYS.bedrock;
    const S = AWS_SERVICE_KEYS.sagemaker;

    await c.attempt("aws.bedrock.custom_models", region,
      () => paginate(max, (nextToken) => bedrock.send(new ListCustomModelsCommand({ nextToken })), (p) => p.modelSummaries, (p) => p.nextToken),
      (items) => items.forEach((m) => this.#resource(c, region, B, "bedrock.custom_model", m.modelArn, { customizationType: m.customizationType })));
    await c.attempt("aws.bedrock.imported_models", region,
      () => paginate(max, (nextToken) => bedrock.send(new ListImportedModelsCommand({ nextToken })), (p) => p.modelSummaries, (p) => p.nextToken),
      (items) => items.forEach((m) => this.#resource(c, region, B, "bedrock.imported_model", m.modelArn, { architecture: m.modelArchitecture })));
    await c.attempt("aws.bedrock.provisioned_throughput", region,
      () => paginate(max, (nextToken) => bedrock.send(new ListProvisionedModelThroughputsCommand({ nextToken })), (p) => p.provisionedModelSummaries, (p) => p.nextToken),
      (items) => items.forEach((m) => this.#resource(c, region, B, "bedrock.provisioned_throughput", m.provisionedModelArn, { status: m.status })));
    await c.attempt("aws.bedrock.guardrails", region,
      () => paginate(max, (nextToken) => bedrock.send(new ListGuardrailsCommand({ nextToken })), (p) => p.guardrails, (p) => p.nextToken),
      (items) => items.forEach((g) => this.#resource(c, region, B, "bedrock.guardrail", g.arn, { status: g.status })));
    try {
      const res = await bedrock.send(new GetModelInvocationLoggingConfigurationCommand({}));
      const cfgLog = res.loggingConfig;
      const on = !!(cfgLog?.cloudWatchConfig || cfgLog?.s3Config);
      c.ok("aws.bedrock.invocation_logging", region, on ? 1 : 0, on ? "model-invocation logging is enabled" : "model-invocation logging is not enabled");
    } catch (err) {
      c.failed("aws.bedrock.invocation_logging", region, err);
    }
    const agentArn = (kind: string, id: string | undefined) => (id ? `arn:aws:bedrock:${region}:${this.target.accountId}:${kind}/${id}` : undefined);
    await c.attempt("aws.bedrock.agents", region,
      () => paginate(max, (nextToken) => agent.send(new ListAgentsCommand({ nextToken })), (p) => p.agentSummaries, (p) => p.nextToken),
      (items) => items.forEach((a) => this.#resource(c, region, B, "bedrock.agent", agentArn("agent", a.agentId), { status: a.agentStatus })));
    await c.attempt("aws.bedrock.knowledge_bases", region,
      () => paginate(max, (nextToken) => agent.send(new ListKnowledgeBasesCommand({ nextToken })), (p) => p.knowledgeBaseSummaries, (p) => p.nextToken),
      (items) => items.forEach((k) => this.#resource(c, region, B, "bedrock.knowledge_base", agentArn("knowledge-base", k.knowledgeBaseId), { status: k.status })));
    await c.attempt("aws.sagemaker.endpoints", region,
      () => paginate(max, (NextToken) => sagemaker.send(new ListEndpointsCommand({ NextToken })), (p) => p.Endpoints, (p) => p.NextToken),
      (items) => items.forEach((e) => this.#resource(c, region, S, "sagemaker.endpoint", e.EndpointArn, { status: e.EndpointStatus })));
    await c.attempt("aws.sagemaker.models", region,
      () => paginate(max, (NextToken) => sagemaker.send(new ListModelsCommand({ NextToken })), (p) => p.Models, (p) => p.NextToken),
      (items) => items.forEach((m) => this.#resource(c, region, S, "sagemaker.model", m.ModelArn)));
  }

  async #lookupEvents(c: ScanCollector, ctx: CloudScanContext, region: string): Promise<void> {
    const trail = new CloudTrailClient(this.#config(region));
    const start = lookbackStart(ctx, MAX_AUDIT_LOOKBACK_DAYS);
    const agg = new PrincipalAggregator("aws");
    let read = 0;
    try {
      for (const name of AWS_LOOKUP_EVENT_NAMES) {
        const events = await paginate<{ Events?: TrailEvent[] | undefined; NextToken?: string | undefined }, TrailEvent>(
          ctx.maxPagesPerCall,
          (NextToken) =>
            trail.send(new LookupEventsCommand({
              LookupAttributes: [{ AttributeKey: "EventName", AttributeValue: name }],
              StartTime: start,
              EndTime: ctx.now,
              MaxResults: 50,
              NextToken,
            })),
          (p) => p.Events,
          (p) => p.NextToken,
        );
        for (const e of events) {
          if (e.EventSource && e.EventSource !== "bedrock.amazonaws.com") continue;
          let rec: TrailRecord = {};
          try {
            rec = e.CloudTrailEvent ? (JSON.parse(e.CloudTrailEvent) as TrailRecord) : {};
          } catch {
            rec = {};
          }
          const principal = principalOf(rec) ?? (e.Username ? `user:${e.Username}` : null);
          if (!principal) continue;
          read += 1;
          agg.record({
            rawIdentifier: principal,
            container: this.target.accountId,
            location: region,
            serviceKey: AWS_SERVICE_KEYS.bedrock,
            operation: e.EventName ?? name,
            at: iso(e.EventTime) ?? rec.eventTime ?? ctx.now.toISOString(),
            attributes: { model: rec.requestParameters?.modelId },
          });
        }
      }
      c.ok("aws.cloudtrail.lookup_events", region, read, `management events since ${start.toISOString()}; ${agg.size} calling principal(s)`);
      await agg.flush(c);
    } catch (err) {
      c.failed("aws.cloudtrail.lookup_events", region, err);
    }
  }

  async #trailBucket(c: ScanCollector, ctx: CloudScanContext): Promise<void> {
    const tb = this.target.trailBucket;
    if (!tb) {
      c.report("aws.cloudtrail.data_events", null, "not_enabled",
        "no trail bucket configured: agent and knowledge-base calls (InvokeAgent, Retrieve, RetrieveAndGenerate) are data events that LookupEvents cannot return");
      return;
    }
    const s3 = new S3Client({ ...this.#config(tb.region), forcePathStyle: false, useAccelerateEndpoint: false, useArnRegion: false });
    const maxObjects = Math.min(tb.maxObjects ?? 200, 2000);
    const start = lookbackStart(ctx, MAX_AUDIT_LOOKBACK_DAYS);
    const agg = new PrincipalAggregator("aws");
    let prefix = tb.prefix ?? "";
    while (prefix.endsWith("/")) prefix = prefix.slice(0, -1);
    const base = `${prefix ? `${prefix}/` : ""}AWSLogs/${this.target.accountId}/CloudTrail/`;
    let objects = 0;
    let records = 0;
    let skippedObjects = 0;
    try {
      // newest first: walk days backwards from now, per region prefix discovered under the account
      const regionPrefixes = await paginate(ctx.maxPagesPerCall,
        (ContinuationToken) => s3.send(new ListObjectsV2Command({ Bucket: tb.bucket, Prefix: base, Delimiter: "/", ContinuationToken })),
        (p) => p.CommonPrefixes?.map((x) => x.Prefix).filter((x): x is string => !!x),
        (p) => p.NextContinuationToken);
      outer: for (let day = new Date(ctx.now); day >= start; day = new Date(day.getTime() - 86_400_000)) {
        const ymd = `${day.getUTCFullYear()}/${String(day.getUTCMonth() + 1).padStart(2, "0")}/${String(day.getUTCDate()).padStart(2, "0")}/`;
        for (const rp of regionPrefixes) {
          const keys = await paginate(ctx.maxPagesPerCall,
            (ContinuationToken) => s3.send(new ListObjectsV2Command({ Bucket: tb.bucket, Prefix: `${rp}${ymd}`, ContinuationToken })),
            (p) => p.Contents?.filter((o) => {
              // never fetch a log object over the cap: CloudTrail files are small, a huge one is not a trail file
              if (o.Size !== undefined && o.Size > AWS_TRAIL_OBJECT_MAX_BYTES) {
                skippedObjects += 1;
                return false;
              }
              return true;
            }).map((o) => o.Key).filter((k): k is string => !!k),
            (p) => p.NextContinuationToken);
          for (const key of keys) {
            if (objects >= maxObjects) break outer;
            objects += 1;
            const obj = await s3.send(new GetObjectCommand({ Bucket: tb.bucket, Key: key }));
            if (obj.ContentLength !== undefined && obj.ContentLength > AWS_TRAIL_OBJECT_MAX_BYTES) {
              skippedObjects += 1;
              await obj.Body?.transformToWebStream().cancel().catch(() => undefined);
              continue;
            }
            if (!obj.Body) continue;
            let bytes: Uint8Array;
            try {
              // a running cap, whether or not the object declared its length (recheck finding 3)
              bytes = await readBodyCapped(obj.Body.transformToWebStream() as ReadableStream<Uint8Array>, AWS_TRAIL_OBJECT_MAX_BYTES);
            } catch (err) {
              if (!(err instanceof BodyTooLargeError)) throw err;
              skippedObjects += 1;
              continue;
            }
            let text: string;
            try {
              text = key.endsWith(".gz")
                ? gunzipSync(bytes, { maxOutputLength: AWS_TRAIL_OBJECT_MAX_INFLATED_BYTES }).toString("utf8")
                : Buffer.from(bytes).toString("utf8");
            } catch {
              // a gzip bomb (inflates past the cap) or a corrupt object: skip it, count it, keep scanning
              skippedObjects += 1;
              continue;
            }
            let parsed: { Records?: TrailRecord[] };
            try {
              parsed = JSON.parse(text) as { Records?: TrailRecord[] };
            } catch {
              continue;
            }
            for (const r of parsed.Records ?? []) {
              if (r.eventSource !== "bedrock.amazonaws.com" || !r.eventName || !AWS_DATA_EVENT_NAMES.has(r.eventName)) continue;
              const principal = principalOf(r);
              if (!principal) continue;
              records += 1;
              agg.record({
                rawIdentifier: principal,
                container: r.recipientAccountId ?? this.target.accountId,
                location: r.awsRegion ?? null,
                serviceKey: AWS_SERVICE_KEYS.bedrock,
                operation: r.eventName,
                at: r.eventTime ?? ctx.now.toISOString(),
                attributes: { model: r.requestParameters?.modelId },
              });
            }
          }
        }
      }
      // A bucket with log objects but no Bedrock data events usually means no data-event selector: say so.
      const skipped = skippedObjects ? `; ${skippedObjects} object(s) skipped: over the size cap or not valid gzip` : "";
      const detail = records === 0
        ? `${objects} log object(s) read, no Bedrock data events found: data-event selectors for Bedrock may not be enabled on the trail${skipped}`
        : `${objects} log object(s) read; ${agg.size} calling principal(s)${skipped}`;
      c.ok("aws.cloudtrail.data_events", tb.bucket, records, detail);
      await agg.flush(c);
    } catch (err) {
      c.failed("aws.cloudtrail.data_events", tb.bucket, err);
    }
  }
}
