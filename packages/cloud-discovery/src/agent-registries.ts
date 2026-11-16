/**
 * ADR-0314 (G6): read-only listings of the agents a cloud vendor's agent registry holds, for import into RegulAIt's
 * agent inventory. This module holds only the calls that need a cloud SDK (request signing); the gateway's registry
 * scanners (`apps/gateway/src/agent-registry-scanners.ts`) map what comes back to staged registry records.
 *
 *  - AWS Bedrock AgentCore: `ListAgentRuntimes` on the control plane (`bedrock-agentcore-control`), per region,
 *    paginated by `nextToken`. Read-only: a List call changes nothing. Signed with the source's credential
 *    (`awsCredentialProvider`: static keys, web identity or assume-role, never the default chain), sent through the
 *    guarded fetch, endpoints pinned (`AWS_PINNED_ENDPOINT_CONFIG`).
 *
 * Google Gemini Enterprise and Microsoft Entra Agent ID / Agent 365 are plain REST with a bearer token, so the
 * gateway reads them itself through the same guarded fetch (no SDK is needed for a GET).
 */
import { BedrockAgentCoreControlClient, ListAgentRuntimesCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import { AWS_PINNED_ENDPOINT_CONFIG, awsCredentialProvider, type AwsScannerDeps } from "./aws.js";
import { guardedAwsRequestHandler } from "./transport.js";
import { paginateBounded } from "./report.js";

/** one AgentCore runtime as listed: only the fields the import keeps */
export interface AgentCoreRuntimeListing {
  region: string;
  agentRuntimeArn: string;
  agentRuntimeId: string;
  agentRuntimeName: string;
  agentRuntimeVersion: string | null;
  description: string | null;
  status: string | null;
  lastUpdatedAt: string | null;
}

export interface AgentCoreListOutcome {
  runtimes: AgentCoreRuntimeListing[];
  /** per region: `ok`, or the error class name (never the message, which can echo request details) */
  regions: Array<{ region: string; status: "ok" | "denied" | "error"; detail?: string; /** stopped at a page or runtime cap: the listing is partial */ truncated?: boolean }>;
  /** true when every region was read to the end (no cap hit, no region failed) */
  complete: boolean;
}

/** at most this many pages per region and runtimes in all, per run */
export const AGENTCORE_MAX_PAGES = 50;
export const AGENTCORE_MAX_RUNTIMES = 5_000;

const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
export const isAwsRegion = (v: string): boolean => AWS_REGION.test(v);

const DENIED = new Set(["AccessDeniedException", "UnauthorizedOperation", "UnrecognizedClientException", "ExpiredTokenException"]);

/**
 * List the AgentCore runtimes of the named regions. A region that fails is reported and skipped (the others are still
 * read); the outcome says whether the listing is complete, so a caller never marks a record absent from a partial read.
 */
export async function listAgentCoreRuntimes(deps: AwsScannerDeps, regions: readonly string[], signal?: AbortSignal, stsRegion = "us-east-1"): Promise<AgentCoreListOutcome> {
  // one provider for every region: it caches the exchanged session and registers each credential with onSecret
  const credentials = awsCredentialProvider(deps, stsRegion);
  const out: AgentCoreListOutcome = { runtimes: [], regions: [], complete: true };
  for (const region of regions) {
    if (!isAwsRegion(region)) throw new Error(`agentcore: '${region.slice(0, 40)}' is not an AWS region`);
    const client = new BedrockAgentCoreControlClient({ region, credentials, requestHandler: guardedAwsRequestHandler(deps.fetch), maxAttempts: 3, ...AWS_PINNED_ENDPOINT_CONFIG });
    try {
      // the shared pager, bounded by pages and by the runtimes still allowed; `truncated` keeps the read partial
      const page = await paginateBounded(
        AGENTCORE_MAX_PAGES,
        (nextToken) => client.send(new ListAgentRuntimesCommand({ maxResults: 100, ...(nextToken ? { nextToken } : {}) }), signal ? { abortSignal: signal } : {}),
        (res) => (res.agentRuntimes ?? []).flatMap((r): AgentCoreRuntimeListing[] =>
          !r.agentRuntimeArn || !r.agentRuntimeId || !r.agentRuntimeName
            ? []
            : [{
                region,
                agentRuntimeArn: r.agentRuntimeArn.slice(0, 2048),
                agentRuntimeId: r.agentRuntimeId.slice(0, 256),
                agentRuntimeName: r.agentRuntimeName.slice(0, 256),
                agentRuntimeVersion: r.agentRuntimeVersion?.slice(0, 64) ?? null,
                description: r.description?.slice(0, 1000) ?? null,
                status: r.status?.slice(0, 64) ?? null,
                lastUpdatedAt: r.lastUpdatedAt instanceof Date && !Number.isNaN(r.lastUpdatedAt.getTime()) ? r.lastUpdatedAt.toISOString() : null,
              }],
        ),
        (res) => res.nextToken,
        AGENTCORE_MAX_RUNTIMES - out.runtimes.length,
      );
      out.runtimes.push(...page.items);
      if (page.truncated) {
        out.complete = false;
        out.regions.push({ region, status: "ok", truncated: true });
        continue;
      }
      out.regions.push({ region, status: "ok" });
    } catch (err) {
      if (signal?.aborted) throw err;
      const name = err instanceof Error ? err.name.slice(0, 80) : "Error";
      out.regions.push({ region, status: DENIED.has(name) ? "denied" : "error", detail: name });
      out.complete = false;
    } finally {
      client.destroy();
    }
  }
  return out;
}
