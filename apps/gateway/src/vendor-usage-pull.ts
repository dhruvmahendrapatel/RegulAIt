/**
 * ADR-0322 — opt-in, per-tenant read-only pull of vendor usage and cost data: the gateway half.
 *
 * WHAT THIS DOES. A tenant admin may register a vendor account (Anthropic and OpenAI in this slice), store its key,
 * and let a scheduled or manual pull read the vendor's cost report into ADR-0069's imported ledger. The pulled lines
 * are ordinary imported lines (`basis = 'imported'`), never metered, never summed with metered spend.
 *
 * THREE SWITCHES before one byte leaves (ADR-0322 §1), each OFF by default (ADR-0180):
 *   1. the org policy (`vendor_usage_pull_policy`), on = a `settings_relax` step-up, refused under `air_gapped`;
 *   2. the connector (`enabled`), on = a step-up and a live credential;
 *   3. the vendor host in the egress allow-list (ADR-0034), enforced by the guarded fetch on every request.
 *
 * THE CREDENTIAL. Encrypted under the data key (`secrets.ts`), listed in CIPHERTEXT_COLUMNS, never returned, never
 * logged, never in an audit row, destroyed on revoke. Storing or replacing it is admin-only with a step-up and a
 * required reason. Anthropic and OpenAI document no read-only scope for their Admin keys, so the credential is
 * `write_capable` and needs an explicit acknowledgement (owner answer, 2026-11-15); only the read endpoints in the
 * catalogue are ever called with it.
 *
 * NO VENDOR TEXT IN THE LEDGER. A failed run stores a fixed error code and a sentence RegulAIt wrote, never the
 * vendor's response body, so an error that echoes the key cannot reach a run row, a log or a response.
 *
 * NO DOUBLE COUNTING (ADR-0322 §5). A line billed to a key, project or workspace the admin declared as the gateway's
 * own is marked `overlaps_metered`: kept, excluded from the imported side of the consolidated read, and disclosed.
 *
 * Open source first (ADR-0176): OpenAI's costs endpoint is called through the official `openai` SDK
 * (`client.admin.organization.usage.costs`, Apache-2.0) with the guarded fetch injected. `@anthropic-ai/sdk` has no
 * method for `/v1/organizations/cost_report` (checked against its api.md at 0.113.0 and main, 2026-11-15), so that
 * endpoint is called with the guarded fetch directly. GitHub's billing usage report is one unpaginated GET per day:
 * `@octokit/request` (MIT) was compared and not added, because it would be a new dependency whose fetch must be
 * replaced by the guarded one anyway, for a single GET. Cursor publishes no SDK for its Admin API (slice 3,
 * 2026-11-19).
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import OpenAiSdk from "openai";
import { z } from "zod";
import {
  and,
  auditLog,
  costImportBatches,
  desc,
  eq,
  gt,
  importedCostLines,
  inArray,
  isNull,
  sql,
  vendorUsageConnectors,
  vendorUsageCredentials,
  vendorUsagePullPolicy,
  vendorUsagePullRuns,
  type Db,
  type VendorUsageConnectorRow,
  type VendorUsagePullRunRow,
} from "@regulait/db";
import {
  anthropicCostReportSchema,
  cursorUsageEventsSchema,
  factOverlapsMetered,
  githubBillingUsageSchema,
  normalizeAccountKey,
  normalizeAnthropicCostReport,
  normalizeCursorUsageEvents,
  normalizeGithubCopilotUsage,
  normalizeOpenAiCosts,
  openAiCostsSchema,
  resolveVendorAccount,
  VENDOR_USAGE_CATALOGUE,
  VENDOR_USAGE_MAX_PAGES,
  VENDOR_USAGE_MAX_RESPONSE_BYTES,
  VENDOR_USAGE_MAX_WINDOW_DAYS,
  VENDOR_USAGE_PULL_STATEMENT,
  VENDOR_USAGE_PULL_VENDORS,
  vendorUsageFactKey,
  VENDOR_USAGE_PULL_RUN_MACHINE,
  vendorUsagePublicConfigSchemas,
  VendorUsageResponseError,
  type CursorUsageEvent,
  type GithubCopilotPublicConfig,
  type VendorUsageFact,
  type VendorUsagePublicConfig,
  type VendorUsagePullVendor,
} from "@regulait/shared";
import { loadResolutionContext, scanFreeTexts } from "./cost-import.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { resolveDeployMode } from "./deploy-posture.js";
import {
  createGuardedFetch,
  EgressBlockedError,
  EgressRedirectError,
  EgressResponseTooLargeError,
  type EgressResolver,
} from "./egress-guard.js";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { whereFrom } from "./state-transition.js";
import { lockConnectorAndFindRunningPull } from "./vendor-usage-lock.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { requireStepUp } from "./step-up.js";

/** a run's closing write; its status comes from the machine's event, never from the caller (ADR-0348) */
type RunFinishPatch = Omit<Partial<typeof vendorUsagePullRuns.$inferInsert>, "status">;
type RunFinishEvent = (typeof VENDOR_USAGE_PULL_RUN_MACHINE.events)[number];

const NIL_USER = "00000000-0000-0000-0000-000000000000";
const DAY_MS = 24 * 3600 * 1000;
/** the last two days are always re-pulled: both vendors restate the current and previous day as usage settles */
const RESTATE_DAYS = 2;
const REQUEST_TIMEOUT_MS = 30_000;
/** a run still `running` after this is treated as a crashed process, so it does not block the connector forever */
const RUNS_PAGE = 50;

export const VENDOR_USAGE_PULL_JOB_NAME = "vendor-usage-pull-sweep";

export const VENDOR_USAGE_RULE_IDS = {
  policyChanged: "vendor-usage-pull-policy-changed",
  connectorCreated: "vendor-usage-connector-created",
  connectorConfigured: "vendor-usage-connector-configured",
  connectorEnabledChanged: "vendor-usage-connector-enabled-changed",
  credentialStored: "vendor-usage-credential-stored",
  credentialReplaced: "vendor-usage-credential-replaced",
  credentialRevoked: "vendor-usage-credential-revoked",
  pullCompleted: "vendor-usage-pull-completed",
  pullFailed: "vendor-usage-pull-failed",
  pullRefused: "vendor-usage-pull-refused",
} as const;

/** test seams: the transport the guarded fetch sends through, and the DNS answer it pins */
export interface VendorUsageDeps {
  fetchImpl?: typeof fetch | undefined;
  resolve?: EgressResolver | undefined;
}

type PublicConfig = VendorUsagePublicConfig;

function isPullVendor(v: string): v is VendorUsagePullVendor {
  return (VENDOR_USAGE_PULL_VENDORS as readonly string[]).includes(v);
}

function parseConfig(vendor: VendorUsagePullVendor, raw: unknown): PublicConfig {
  return vendorUsagePublicConfigSchemas[vendor].parse(raw ?? {});
}

const floorDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** the window the next pull asks for: resume from `pulledThrough` (minus the restated days), never more than 31 days */
export function pullWindow(
  pulledThrough: Date | null,
  backfillDays: number,
  now: Date,
): { start: Date; end: Date } {
  const today = floorDay(now);
  const end0 = new Date(today.getTime() + DAY_MS);
  const earliest = new Date(today.getTime() - VENDOR_USAGE_MAX_WINDOW_DAYS * DAY_MS);
  let start = pulledThrough
    ? new Date(floorDay(pulledThrough).getTime() - RESTATE_DAYS * DAY_MS)
    : new Date(today.getTime() - backfillDays * DAY_MS);
  if (start < earliest) start = earliest;
  const end = new Date(Math.min(end0.getTime(), start.getTime() + VENDOR_USAGE_MAX_WINDOW_DAYS * DAY_MS));
  return { start, end };
}

// --------------------------------------------------------------------------------------------------------------------
// Fetching
// --------------------------------------------------------------------------------------------------------------------

type PullErrorCode =
  | "egress_refused"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "http_error"
  | "bad_response"
  | "response_too_large"
  | "network_error"
  | "page_limit";

class PullError extends Error {
  constructor(
    readonly code: PullErrorCode,
    /** written by RegulAIt; never vendor text */
    readonly detail: string,
  ) {
    super(detail);
    this.name = "PullError";
  }
}

function statusError(status: number, page: number): PullError {
  if (status === 401) return new PullError("unauthorized", `the vendor refused the credential (HTTP 401) on page ${page}`);
  if (status === 403) return new PullError("forbidden", `the vendor refused access (HTTP 403) on page ${page}`);
  if (status === 429) return new PullError("rate_limited", `the vendor rate-limited the pull (HTTP 429) on page ${page}`);
  return new PullError("http_error", `the vendor answered HTTP ${status} on page ${page}`);
}

/** map any thrown value (the guard's, the SDK's, the network's) to a code and a sentence RegulAIt wrote */
function classifyError(err: unknown, page: number): PullError {
  if (err instanceof PullError) return err;
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof EgressBlockedError) {
      return new PullError("egress_refused", "the egress guard refused the vendor host: add it to the egress allow-list");
    }
    if (e instanceof EgressRedirectError) return new PullError("egress_refused", "the vendor answered with a redirect, which is refused");
    if (e instanceof EgressResponseTooLargeError) {
      return new PullError("response_too_large", `a vendor response exceeded ${VENDOR_USAGE_MAX_RESPONSE_BYTES} bytes`);
    }
  }
  if (err instanceof OpenAiSdk.APIError && typeof err.status === "number") return statusError(err.status, page);
  if (err instanceof VendorUsageResponseError || err instanceof z.ZodError || err instanceof SyntaxError) {
    return new PullError("bad_response", `a vendor response did not match the documented shape on page ${page}`);
  }
  return new PullError("network_error", `the vendor could not be reached on page ${page}`);
}

function guardedFetch(allowList: Awaited<ReturnType<typeof loadEgressAllowList>>, deps: VendorUsageDeps): typeof fetch {
  return createGuardedFetch({
    allowList,
    maxResponseBytes: VENDOR_USAGE_MAX_RESPONSE_BYTES,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  });
}

/** a vendor that hands back a cursor it already returned would loop to the page cap; refuse it at once (#861 review) */
function repeatedCursor(page: number): PullError {
  return new PullError("bad_response", `the vendor returned page ${page} with a cursor it had already returned; nothing was written`);
}

async function fetchAnthropic(
  key: string,
  window: { start: Date; end: Date },
  fetcher: typeof fetch,
): Promise<{ facts: VendorUsageFact[]; pages: number }> {
  const facts: VendorUsageFact[] = [];
  let page: string | null = null;
  const cursors = new Set<string>();
  for (let n = 1; n <= VENDOR_USAGE_MAX_PAGES; n++) {
    const url = new URL(`https://${VENDOR_USAGE_CATALOGUE.anthropic.host}/v1/organizations/cost_report`);
    url.searchParams.set("starting_at", window.start.toISOString());
    url.searchParams.set("ending_at", window.end.toISOString());
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.append("group_by[]", "workspace_id");
    url.searchParams.append("group_by[]", "description");
    url.searchParams.set("limit", String(VENDOR_USAGE_MAX_WINDOW_DAYS));
    if (page) url.searchParams.set("page", page);
    let body: unknown;
    try {
      const res = await fetcher(url.toString(), {
        method: "GET",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.arrayBuffer().catch(() => undefined);
        throw statusError(res.status, n);
      }
      body = await res.json();
    } catch (err) {
      throw classifyError(err, n);
    }
    let parsed;
    try {
      parsed = anthropicCostReportSchema.parse(body);
      facts.push(...normalizeAnthropicCostReport(parsed));
    } catch (err) {
      throw classifyError(err, n);
    }
    if (!parsed.has_more || !parsed.next_page) return { facts, pages: n };
    if (cursors.has(parsed.next_page)) throw repeatedCursor(n);
    cursors.add(parsed.next_page);
    page = parsed.next_page;
  }
  throw new PullError("page_limit", `the vendor still had more pages after ${VENDOR_USAGE_MAX_PAGES}; nothing was written`);
}

async function fetchOpenAi(
  key: string,
  window: { start: Date; end: Date },
  fetcher: typeof fetch,
): Promise<{ facts: VendorUsageFact[]; pages: number }> {
  // every option that the SDK would otherwise read from the environment is set explicitly, so an environment
  // variable can neither redirect the base URL nor attach an organisation or project header
  const client = new OpenAiSdk({
    apiKey: "unused-admin-endpoint",
    adminAPIKey: key,
    organization: null,
    project: null,
    baseURL: `https://${VENDOR_USAGE_CATALOGUE.openai.host}/v1`,
    fetch: fetcher,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
  });
  const facts: VendorUsageFact[] = [];
  let page: string | undefined;
  const cursors = new Set<string>();
  for (let n = 1; n <= VENDOR_USAGE_MAX_PAGES; n++) {
    let parsed;
    try {
      const body = await client.admin.organization.usage.costs({
        start_time: Math.floor(window.start.getTime() / 1000),
        end_time: Math.floor(window.end.getTime() / 1000),
        bucket_width: "1d",
        group_by: ["project_id", "line_item", "api_key_id"],
        limit: VENDOR_USAGE_MAX_WINDOW_DAYS,
        ...(page ? { page } : {}),
      });
      parsed = openAiCostsSchema.parse(body);
      facts.push(...normalizeOpenAiCosts(parsed));
    } catch (err) {
      throw classifyError(err, n);
    }
    if (!parsed.has_more || !parsed.next_page) return { facts, pages: n };
    if (cursors.has(parsed.next_page)) throw repeatedCursor(n);
    cursors.add(parsed.next_page);
    page = parsed.next_page;
  }
  throw new PullError("page_limit", `the vendor still had more pages after ${VENDOR_USAGE_MAX_PAGES}; nothing was written`);
}

/** GitHub's REST API version the billing usage report is documented under (re-checked 2026-11-19) */
const GITHUB_API_VERSION = "2026-03-10";

/** a GET or POST through the guarded fetch that returns parsed JSON or throws a classified error */
async function fetchJson(fetcher: typeof fetch, url: string, init: RequestInit, page: number): Promise<unknown> {
  try {
    const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      throw statusError(res.status, page);
    }
    return await res.json();
  } catch (err) {
    throw classifyError(err, page);
  }
}

/** GitHub's daily billing usage report, one request per day of the window, Copilot lines only */
async function fetchGithubCopilot(
  key: string,
  window: { start: Date; end: Date },
  fetcher: typeof fetch,
  config: GithubCopilotPublicConfig,
): Promise<{ facts: VendorUsageFact[]; pages: number }> {
  const facts: VendorUsageFact[] = [];
  const base = config.account === "organization" ? "organizations" : "enterprises";
  let n = 0;
  for (let day = window.start.getTime(); day < window.end.getTime(); day += DAY_MS) {
    n += 1;
    if (n > VENDOR_USAGE_MAX_PAGES) {
      throw new PullError("page_limit", `the window needed more than ${VENDOR_USAGE_MAX_PAGES} requests; nothing was written`);
    }
    const d = new Date(day);
    const url = new URL(`https://${VENDOR_USAGE_CATALOGUE.github_copilot.host}/${base}/${encodeURIComponent(config.slug)}/settings/billing/usage`);
    url.searchParams.set("year", String(d.getUTCFullYear()));
    url.searchParams.set("month", String(d.getUTCMonth() + 1));
    url.searchParams.set("day", String(d.getUTCDate()));
    const body = await fetchJson(
      fetcher,
      url.toString(),
      {
        method: "GET",
        headers: { authorization: `Bearer ${key}`, accept: "application/vnd.github+json", "x-github-api-version": GITHUB_API_VERSION },
      },
      n,
    );
    try {
      facts.push(...normalizeGithubCopilotUsage(githubBillingUsageSchema.parse(body), { kind: config.account, slug: config.slug }));
    } catch (err) {
      throw classifyError(err, n);
    }
  }
  return { facts, pages: n };
}

/** Cursor's filtered usage events for the window (both bounds inclusive, epoch ms), 1000 a page */
async function fetchCursor(
  key: string,
  window: { start: Date; end: Date },
  fetcher: typeof fetch,
): Promise<{ facts: VendorUsageFact[]; pages: number }> {
  const events: CursorUsageEvent[] = [];
  const authorization = `Basic ${Buffer.from(`${key}:`, "utf8").toString("base64")}`;
  for (let n = 1; n <= VENDOR_USAGE_MAX_PAGES; n++) {
    const body = await fetchJson(
      fetcher,
      `https://${VENDOR_USAGE_CATALOGUE.cursor.host}/teams/filtered-usage-events`,
      {
        method: "POST",
        headers: { authorization, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ startDate: window.start.getTime(), endDate: window.end.getTime() - 1, page: n, pageSize: 1000 }),
      },
      n,
    );
    let parsed;
    try {
      parsed = cursorUsageEventsSchema.parse(body);
    } catch (err) {
      throw classifyError(err, n);
    }
    // a vendor that answers a different page than the one asked for would loop or skip pages; refuse it
    if (parsed.pagination.currentPage !== n) {
      throw new PullError("bad_response", `the vendor answered page ${parsed.pagination.currentPage} when page ${n} was asked for; nothing was written`);
    }
    events.push(...parsed.usageEvents);
    if (!parsed.pagination.hasNextPage) {
      try {
        return { facts: normalizeCursorUsageEvents(events), pages: n };
      } catch (err) {
        throw classifyError(err, n);
      }
    }
  }
  throw new PullError("page_limit", `the vendor still had more pages after ${VENDOR_USAGE_MAX_PAGES}; nothing was written`);
}

function fetchVendor(
  vendor: VendorUsagePullVendor,
  config: PublicConfig,
  key: string,
  window: { start: Date; end: Date },
  fetcher: typeof fetch,
): Promise<{ facts: VendorUsageFact[]; pages: number }> {
  switch (vendor) {
    case "anthropic":
      return fetchAnthropic(key, window, fetcher);
    case "openai":
      return fetchOpenAi(key, window, fetcher);
    case "github_copilot":
      return fetchGithubCopilot(key, window, fetcher, config as GithubCopilotPublicConfig);
    case "cursor":
      return fetchCursor(key, window, fetcher);
  }
}

// --------------------------------------------------------------------------------------------------------------------
// The pull
// --------------------------------------------------------------------------------------------------------------------

async function loadPolicyEnabled(db: Db): Promise<boolean> {
  const [row] = await db.select({ enabled: vendorUsagePullPolicy.enabled }).from(vendorUsagePullPolicy).limit(1);
  return row?.enabled === true;
}

async function liveCredential(db: Db, connectorId: string) {
  const [row] = await db
    .select()
    .from(vendorUsageCredentials)
    .where(and(eq(vendorUsageCredentials.connectorId, connectorId), isNull(vendorUsageCredentials.revokedAt)))
    .limit(1);
  return row ?? null;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

/** the audit row; callers pass the transaction that holds the state change, so neither lands without the other */
async function audit(
  db: DbOrTx,
  userId: string | null,
  objectType: "vendor_usage_pull_policy" | "vendor_usage_connector" | "vendor_usage_credential" | "vendor_usage_pull_run",
  objectId: string | null,
  ruleId: string,
  effect: "allow" | "deny",
  reason: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({
    userId: userId ?? NIL_USER,
    objectType,
    objectId,
    detail: { subsystem: "vendor-usage-pull", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

export interface PullOutcome {
  run: VendorUsagePullRunRow;
}

/**
 * One pull for one connector. Opens a run row first (a row stuck at `running` is the diagnosis of a process that
 * died mid-pull), refuses unless all three switches are on, fetches every page before writing anything, and then
 * writes the batch and upserts the lines in one transaction. A failure writes nothing but the run row.
 */
export async function runVendorUsagePull(
  db: Db,
  connectorId: string,
  opts: {
    trigger: "schedule" | "manual";
    dataKey?: string | undefined;
    deps?: VendorUsageDeps | undefined;
    requestedBy?: string | null | undefined;
    now?: Date | undefined;
  },
): Promise<PullOutcome> {
  const now = opts.now ?? new Date();
  const [connector] = await db.select().from(vendorUsageConnectors).where(eq(vendorUsageConnectors.id, connectorId)).limit(1);
  if (!connector) throw new Error(`vendor usage connector ${connectorId} not found`);
  // one pull per connector at a time (#861 review): the open step is serialised on the connector, and a run another
  // caller opened inside the lease refuses this one, so the vendor is not called twice and no second batch is written
  const opening = await db.transaction(async (tx) => {
    const busy = await lockConnectorAndFindRunningPull(tx, connectorId);
    if (!busy) {
      const [row] = await tx.insert(vendorUsagePullRuns).values({ connectorId, trigger: opts.trigger, requestedBy: opts.requestedBy ?? null }).returning();
      return { run: row!, busy: false as const };
    }
    const detail = `another pull of this connector (run ${busy.id}) is still running; this one was not started`;
    const [row] = await tx
      .insert(vendorUsagePullRuns)
      .values({
        connectorId,
        trigger: opts.trigger,
        requestedBy: opts.requestedBy ?? null,
        status: "refused",
        errorCode: "in_progress",
        errorDetail: detail,
        finishedAt: sql`now()`,
      })
      .returning();
    await audit(tx, opts.requestedBy ?? null, "vendor_usage_pull_run", row!.id, VENDOR_USAGE_RULE_IDS.pullRefused, "deny", detail, {
      connectorId,
      vendor: connector.vendor,
      trigger: opts.trigger,
      status: "refused",
      errorCode: "in_progress",
      runningRunId: busy.id,
    });
    return { run: row!, busy: true as const };
  });
  if (opening.busy) return { run: opening.run };
  const runId = opening.run.id;

  // the run row's outcome and its audit row are written in the same transaction (#861 review)
  const finishIn = async (
    tx: DbOrTx,
    event: RunFinishEvent,
    patch: RunFinishPatch,
    ruleId: string,
    effect: "allow" | "deny",
    reason: string,
  ): Promise<PullOutcome> => {
    // the status moves only along VENDOR_USAGE_PULL_RUN_TRANSITIONS: a compare-and-set on the states that may reach
    // the target, so a run that already ended is never rewritten
    const to = VENDOR_USAGE_PULL_RUN_MACHINE.def.transitions[event].to;
    const [run] = await tx
      .update(vendorUsagePullRuns)
      .set({ ...patch, status: to, finishedAt: sql`now()` })
      .where(and(eq(vendorUsagePullRuns.id, runId), whereFrom(vendorUsagePullRuns.status, VENDOR_USAGE_PULL_RUN_MACHINE, event)))
      .returning();
    if (!run) throw new Error(`vendor usage pull run ${runId} cannot move to ${to}: it has already ended`);
    await audit(tx, opts.requestedBy ?? null, "vendor_usage_pull_run", runId, ruleId, effect, reason, {
      connectorId,
      vendor: connector.vendor,
      trigger: opts.trigger,
      status: run.status,
      errorCode: run.errorCode,
      linesUpserted: run.linesUpserted,
      overlapLines: run.overlapLines,
      ...(patch.batchId ? { batchId: patch.batchId } : {}),
    });
    return { run };
  };
  const finish = (event: RunFinishEvent, patch: RunFinishPatch, ruleId: string, effect: "allow" | "deny", reason: string) =>
    db.transaction((tx) => finishIn(tx, event, patch, ruleId, effect, reason));
  const refuse = (code: "disabled" | "air_gapped" | "no_credential" | "data_key_unavailable", detail: string) =>
    finish("refuse", { errorCode: code, errorDetail: detail }, VENDOR_USAGE_RULE_IDS.pullRefused, "deny", detail);

  if (resolveDeployMode() === "air_gapped") {
    return refuse("air_gapped", "this deployment is air-gapped; vendor usage pull is refused and file import stays available");
  }
  if (!(await loadPolicyEnabled(db))) return refuse("disabled", "vendor usage pull is turned off for this organisation");
  if (!connector.enabled) return refuse("disabled", "this connector is disabled");
  if (!isPullVendor(connector.vendor)) return refuse("disabled", `pulling from ${connector.vendor} is not built yet`);
  const cred = await liveCredential(db, connectorId);
  if (!cred || !cred.secretCiphertext) return refuse("no_credential", "this connector has no live credential");
  if (!opts.dataKey) return refuse("data_key_unavailable", "the data key is not configured, so the credential cannot be read");

  const vendor = connector.vendor;
  const config = parseConfig(vendor, connector.publicConfig);
  const window = pullWindow(connector.pulledThrough, config.backfillDays, now);
  await db
    .update(vendorUsagePullRuns)
    .set({ windowStart: window.start, windowEnd: window.end })
    .where(eq(vendorUsagePullRuns.id, runId));

  let key: string;
  try {
    key = decryptSecret(opts.dataKey, cred.secretCiphertext);
  } catch {
    return refuse("data_key_unavailable", "the stored credential could not be decrypted with the configured data key");
  }

  let fetched: { facts: VendorUsageFact[]; pages: number };
  try {
    const fetcher = guardedFetch(await loadEgressAllowList(db), opts.deps ?? {});
    fetched = await fetchVendor(vendor, config, key, window, fetcher);
  } catch (err) {
    const e = classifyError(err, 0);
    return finish("fail", {errorCode: e.code, errorDetail: e.detail }, VENDOR_USAGE_RULE_IDS.pullFailed, "deny", e.detail);
  }

  // ADR-0042 posture over the only free text a pull keeps (vendor product names); counts only
  const scan = await scanFreeTexts(
    db,
    fetched.facts.flatMap((f) => [f.description ?? "", f.service ?? ""]).filter((t) => t.length > 0),
    undefined,
  );
  if (scan.verdict === "blocked") {
    const detail = "the ingest scan blocked text in the vendor response under the organisation's PII posture; nothing was written";
    return finish("fail", {errorCode: "scan_blocked", errorDetail: detail, pages: fetched.pages }, VENDOR_USAGE_RULE_IDS.pullFailed, "deny", detail);
  }

  const ctx = await loadResolutionContext(db);
  // a fact key the vendor returned twice is one fact: the later bucket wins, so one statement never touches a row twice
  const byKey = new Map<string, { fact: VendorUsageFact; i: number; factKey: string }>();
  fetched.facts.forEach((fact, i) => {
    const factKey = vendorUsageFactKey(fact);
    byKey.set(factKey, { fact, i, factKey });
  });
  const lines = [...byKey.values()].map(({ fact, i, factKey }) => {
    const resolution = resolveVendorAccount(fact.accountRef, vendor, ctx);
    const overlaps = factOverlapsMetered(vendor, fact, config, (fact.detail.projectId as string | undefined) ?? null);
    return { fact, i, resolution, overlaps, factKey };
  });
  const currencies = [...new Set(lines.map((l) => l.fact.currency))];
  const totalUsd =
    currencies.length === 1 && currencies[0] === "USD"
      ? Math.round(lines.filter((l) => !l.overlaps).reduce((s, l) => s + l.fact.amount, 0) * 1e6) / 1e6
      : null;
  const overlapLines = lines.filter((l) => l.overlaps).length;
  const periodStart = lines.length ? new Date(Math.min(...lines.map((l) => Date.parse(l.fact.periodStart)))) : null;
  const periodEnd = lines.length ? new Date(Math.max(...lines.map((l) => Date.parse(l.fact.periodEnd)))) : null;
  const fingerprint = createHash("sha256")
    .update(`vendor-usage-pull|${runId}|`)
    .update(lines.map((l) => `${l.factKey}:${l.fact.amount}`).join(","))
    .digest("hex");
  const adapter = `pull:${vendor}`;
  const reason =
    `pulled ${lines.length} line(s) from ${vendor} for ${window.start.toISOString().slice(0, 10)} to ` +
    `${window.end.toISOString().slice(0, 10)}; ${overlapLines} billed to the gateway's own keys and excluded as already metered`;

  try {
  return await db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(costImportBatches)
      .values({
        adapter,
        vendor,
        format: "json",
        mode: "apply",
        status: "applied",
        origin: "pull",
        source: `vendor usage pull run ${runId} (connector ${connector.name})`,
        payloadSha256: fingerprint,
        rowsParsed: lines.length,
        rowsAccepted: lines.length,
        rowsRefused: 0,
        periodStart,
        periodEnd,
        totalUsd,
        refusals: [],
        summary: { origin: "pull", connectorId, runId, vendors: [vendor], overlapLines, pages: fetched.pages },
        piiMode: scan.mode,
        scanVerdict: scan.verdict,
        scanFindings: scan.findings,
        ruleId: VENDOR_USAGE_RULE_IDS.pullCompleted,
        reason,
        requestedByUserId: opts.requestedBy ?? null,
        appliedAt: new Date(),
      })
      .returning({ id: costImportBatches.id });
    const CHUNK = 500;
    let newLines = 0;
    for (let i = 0; i < lines.length; i += CHUNK) {
      const values = lines.slice(i, i + CHUNK).map(({ fact, i: idx, resolution, overlaps, factKey }) => ({
        batchId: batch!.id,
        basis: "imported" as const,
        vendor,
        adapter,
        sourceRow: idx + 1,
        accountRef: fact.accountRef,
        accountKey: normalizeAccountKey(fact.accountRef),
        resolvedUserId: resolution.userId,
        resolutionMethod: resolution.method,
        resolutionDetail: resolution.detail,
        resolutionMappingId: resolution.mappingId,
        resolutionDomainRuleId: resolution.domainRuleId,
        periodStart: new Date(fact.periodStart),
        periodEnd: new Date(fact.periodEnd),
        amount: fact.amount,
        currency: fact.currency,
        billingKind: "usage" as const,
        service: fact.service?.slice(0, 300) ?? null,
        description: fact.description?.slice(0, 300) ?? null,
        quantity: fact.quantity,
        unit: fact.unit,
        detail: { ...fact.detail, accountKind: fact.accountKind, accountId: fact.accountId },
        pullConnectorId: connectorId,
        factKey,
        overlapsMetered: overlaps,
      }));
      // a restated line keeps the batch that first brought it in (#861 review): revoking a later pull batch then
      // withdraws only the lines that batch introduced, never the spend an earlier pull stored
      const written = await tx
        .insert(importedCostLines)
        .values(values)
        .onConflictDoUpdate({
          target: [importedCostLines.pullConnectorId, importedCostLines.factKey],
          targetWhere: sql`${importedCostLines.pullConnectorId} IS NOT NULL`,
          set: {
            amount: sql`excluded.amount`,
            currency: sql`excluded.currency`,
            quantity: sql`excluded.quantity`,
            unit: sql`excluded.unit`,
            service: sql`excluded.service`,
            description: sql`excluded.description`,
            detail: sql`excluded.detail`,
            overlapsMetered: sql`excluded.overlaps_metered`,
            accountRef: sql`excluded.account_ref`,
            accountKey: sql`excluded.account_key`,
            resolvedUserId: sql`excluded.resolved_user_id`,
            resolutionMethod: sql`excluded.resolution_method`,
            resolutionDetail: sql`excluded.resolution_detail`,
            resolutionMappingId: sql`excluded.resolution_mapping_id`,
            resolutionDomainRuleId: sql`excluded.resolution_domain_rule_id`,
          },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      newLines += written.filter((w) => w.inserted).length;
    }
    await tx
      .update(costImportBatches)
      .set({ summary: { origin: "pull", connectorId, runId, vendors: [vendor], overlapLines, pages: fetched.pages, newLines, restatedLines: lines.length - newLines } })
      .where(eq(costImportBatches.id, batch!.id));
    const through = new Date(Math.min(window.end.getTime(), now.getTime()));
    await tx
      .update(vendorUsageConnectors)
      .set({ pulledThrough: through, updatedAt: sql`now()` })
      .where(eq(vendorUsageConnectors.id, connectorId));
    // the success outcome and its audit row commit with the batch, or not at all
    return finishIn(
      tx,
      "succeed",
      { batchId: batch!.id, pages: fetched.pages, linesUpserted: lines.length, overlapLines },
      VENDOR_USAGE_RULE_IDS.pullCompleted,
      "allow",
      reason,
    );
  });
  } catch {
    // the batch rolled back; the run is closed as failed with RegulAIt's own sentence, never the driver's text
    const detail = "writing the pulled lines failed and was rolled back; nothing was written";
    return finish("fail", {errorCode: "internal", errorDetail: detail, pages: fetched.pages }, VENDOR_USAGE_RULE_IDS.pullFailed, "deny", detail);
  }
}

/** the scheduled sweep: one pull per enabled connector, only while the policy is on */
export async function runVendorUsagePullSweep(
  db: Db,
  opts: { dataKey?: string | undefined; deps?: VendorUsageDeps | undefined; now?: Date | undefined } = {},
): Promise<{ connectors: number; linesUpserted: number; failed: number }> {
  if (resolveDeployMode() === "air_gapped" || !(await loadPolicyEnabled(db))) return { connectors: 0, linesUpserted: 0, failed: 0 };
  const due = await db.select({ id: vendorUsageConnectors.id }).from(vendorUsageConnectors).where(eq(vendorUsageConnectors.enabled, true));
  let linesUpserted = 0;
  let failed = 0;
  for (const c of due) {
    try {
      const { run } = await runVendorUsagePull(db, c.id, { trigger: "schedule", dataKey: opts.dataKey, deps: opts.deps, now: opts.now });
      linesUpserted += run.linesUpserted;
      if (run.status !== "succeeded") failed++;
    } catch {
      // a connector that throws before its run row exists (deleted mid-sweep) is counted and the sweep moves on
      failed++;
    }
  }
  return { connectors: due.length, linesUpserted, failed };
}

export function vendorUsageJobDefinitions(opts: { dataKey?: string | undefined } = {}): SchedulerJobDefinition[] {
  return [
    {
      name: VENDOR_USAGE_PULL_JOB_NAME,
      description:
        "Pull usage and cost from each enabled vendor connector (ADR-0322) into the imported ledger as basis " +
        "'imported'. Runs nothing while the org policy is off, which is the default, and nothing when air-gapped.",
      adr: "ADR-0322",
      defaultIntervalSeconds: 6 * 3600,
      run: async (ctx) => {
        const out = await runVendorUsagePullSweep(ctx.db, { dataKey: opts.dataKey, now: ctx.now });
        return { itemsProcessed: out.linesUpserted, detail: out };
      },
    },
  ];
}

/**
 * Re-mark every stored line of a connector after its gateway-id lists change, so the exclusion always reflects the
 * current declaration rather than the one in force when each line was pulled.
 */
async function remarkOverlap(db: DbOrTx, connector: VendorUsageConnectorRow, config: PublicConfig): Promise<number> {
  if (!isPullVendor(connector.vendor)) return 0;
  const vendor = connector.vendor;
  // read in keyset pages and flip in set-based updates (#861 review): bounded memory, one statement per page and value
  const PAGE = 1000;
  let changed = 0;
  let after: string | null = null;
  for (;;) {
    const rows: Array<{ id: string; detail: unknown; overlapsMetered: boolean }> = await db
      .select({ id: importedCostLines.id, detail: importedCostLines.detail, overlapsMetered: importedCostLines.overlapsMetered })
      .from(importedCostLines)
      .where(and(eq(importedCostLines.pullConnectorId, connector.id), after ? gt(importedCostLines.id, after) : undefined))
      .orderBy(importedCostLines.id)
      .limit(PAGE);
    if (rows.length === 0) break;
    const flip: Record<"true" | "false", string[]> = { true: [], false: [] };
  for (const r of rows) {
    const d = (r.detail ?? {}) as Record<string, unknown>;
    const kind = d.accountKind as VendorUsageFact["accountKind"] | undefined;
    if (!kind) continue;
    const overlaps = factOverlapsMetered(
      vendor,
      { accountKind: kind, accountId: (d.accountId as string | null | undefined) ?? null },
      config,
      (d.projectId as string | undefined) ?? null,
    );
    if (overlaps !== r.overlapsMetered) flip[overlaps ? "true" : "false"].push(r.id);
  }
    for (const value of [true, false] as const) {
      const ids = flip[value ? "true" : "false"];
      if (ids.length) await db.update(importedCostLines).set({ overlapsMetered: value }).where(inArray(importedCostLines.id, ids));
      changed += ids.length;
    }
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1]!.id;
  }
  return changed;
}

// --------------------------------------------------------------------------------------------------------------------
// Routes (admin-only through the default gate; none is in NON_ADMIN_ROUTES)
// --------------------------------------------------------------------------------------------------------------------

const reasonField = z.string().trim().min(3).max(500);
const policyBody = z.object({ enabled: z.boolean(), reason: reasonField }).strict();
const createBody = z
  .object({
    vendor: z.enum(VENDOR_USAGE_PULL_VENDORS),
    name: z.string().trim().min(1).max(120),
    config: z.record(z.string(), z.unknown()).default({}),
    reason: reasonField,
  })
  .strict();
const configBody = z.object({ config: z.record(z.string(), z.unknown()), reason: reasonField }).strict();
const enabledBody = z.object({ enabled: z.boolean(), reason: reasonField }).strict();
const credentialBody = z
  .object({
    secret: z.string().min(8).max(4096),
    replacesCredentialId: z.string().uuid().nullable(),
    acknowledgeWriteCapable: z.boolean().default(false),
    /** the admin attests the token carries read permissions only, where RegulAIt cannot check its scope (#1069 S4) */
    acknowledgeUnverifiedScope: z.boolean().default(false),
    reason: reasonField,
  })
  .strict();
const revokeBody = z.object({ reason: reasonField }).strict();
const idParam = z.object({ connectorId: z.string().uuid() });

/** how many gateway-owned vendor ids a connector declares for the metered-overlap exclusion */
function declaredGatewayIds(cfg: PublicConfig): number {
  if ("gatewayWorkspaceIds" in cfg) return cfg.gatewayWorkspaceIds.length;
  if ("gatewayApiKeyIds" in cfg) return cfg.gatewayApiKeyIds.length + cfg.gatewayProjectIds.length;
  return 0;
}

/** what the admin attests when storing a token whose scope RegulAIt cannot check (#1069 S4) */
const UNVERIFIED_SCOPE_ATTESTATION =
  "the administrator attested that this token carries read permissions only; RegulAIt cannot verify its scope";

type CredentialViewRow = { id: string; scopePosture: string; createdAt: Date; writeCapableAcknowledgedAt: Date | null };

function credentialView(cred: CredentialViewRow) {
  return {
    id: cred.id,
    scopePosture: cred.scopePosture,
    storedAt: cred.createdAt.toISOString(),
    scopeAcknowledgedAt: cred.writeCapableAcknowledgedAt?.toISOString() ?? null,
    ...(cred.scopePosture === "unverified" ? { scopeAttestation: UNVERIFIED_SCOPE_ATTESTATION } : {}),
  };
}

function connectorView(c: VendorUsageConnectorRow, cred: CredentialViewRow | null) {
  return {
    id: c.id,
    vendor: c.vendor,
    name: c.name,
    enabled: c.enabled,
    config: c.publicConfig,
    pulledThrough: c.pulledThrough?.toISOString() ?? null,
    credential: cred ? credentialView(cred) : null,
    createdAt: c.createdAt.toISOString(),
  };
}

function runView(r: VendorUsagePullRunRow) {
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    window: r.windowStart && r.windowEnd ? { from: r.windowStart.toISOString(), to: r.windowEnd.toISOString() } : null,
    batchId: r.batchId,
    pages: r.pages,
    linesUpserted: r.linesUpserted,
    overlapLines: r.overlapLines,
    errorCode: r.errorCode,
    errorDetail: r.errorDetail,
  };
}

export function registerVendorUsagePullRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { dataKey?: string | undefined; deps?: VendorUsageDeps | undefined } = {},
): void {
  const actor = (req: FastifyRequest): string | null => req.authCtx.userId ?? null;
  const bad = (detail: string) => ({ error: "invalid_body", detail });

  const loadConnector = async (id: string) => {
    const [c] = await db.select().from(vendorUsageConnectors).where(eq(vendorUsageConnectors.id, id)).limit(1);
    return c ?? null;
  };

  app.get("/v1/vendor-usage", async () => {
    const enabled = await loadPolicyEnabled(db);
    const deployMode = resolveDeployMode();
    const connectors = await db.select().from(vendorUsageConnectors).orderBy(vendorUsageConnectors.createdAt);
    const creds = await db.select().from(vendorUsageCredentials).where(isNull(vendorUsageCredentials.revokedAt));
    const credBy = new Map(creds.map((c) => [c.connectorId, c]));
    return {
      policy: { enabled, deployMode, airGapped: deployMode === "air_gapped" },
      statement: VENDOR_USAGE_PULL_STATEMENT,
      catalogue: Object.values(VENDOR_USAGE_CATALOGUE),
      connectors: connectors.map((c) => {
        const cfg = isPullVendor(c.vendor) ? parseConfig(c.vendor, c.publicConfig) : null;
        const declared = cfg ? declaredGatewayIds(cfg) : 0;
        const unmetered = c.vendor === "github_copilot" || c.vendor === "cursor";
        return {
          ...connectorView(c, credBy.get(c.id) ?? null),
          meteredOverlap: unmetered
            ? "the gateway does not meter this vendor, so no line is excluded as already metered"
            : declared > 0
              ? "lines billed to the declared gateway keys, projects or workspaces are excluded as already metered"
              : "no gateway key, project or workspace is declared, so spend the gateway metered cannot be excluded for this connector",
        };
      }),
    };
  });

  app.put("/v1/vendor-usage/policy", async (req, reply) => {
    const parsed = policyBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(bad("expected { enabled: boolean, reason: string (3-500 characters) }"));
    const { enabled, reason } = parsed.data;
    if (enabled && resolveDeployMode() === "air_gapped") {
      return reply.status(409).send({
        error: "vendor_usage_air_gapped",
        detail: "this deployment is air-gapped; vendor usage pull cannot be turned on, and file import stays available",
      });
    }
    if (enabled && !(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { vendorUsagePull: true, values: { enabled: true } } })).ok) {
      return reply;
    }
    const before = await loadPolicyEnabled(db);
    await db.transaction(async (tx) => {
      await tx
        .insert(vendorUsagePullPolicy)
        .values({ id: "singleton", enabled, updatedBy: actor(req) })
        .onConflictDoUpdate({ target: vendorUsagePullPolicy.id, set: { enabled, updatedBy: actor(req), updatedAt: sql`now()` } });
      await audit(tx, actor(req), "vendor_usage_pull_policy", null, VENDOR_USAGE_RULE_IDS.policyChanged, "allow",
        `vendor usage pull ${before ? "on" : "off"} -> ${enabled ? "on" : "off"}: ${reason}`,
        { transition: { from: before, to: enabled }, reason, receiptClass: "configuration" });
    });
    return reply.send({ policy: { enabled } });
  });

  app.post("/v1/vendor-usage/connectors", async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(bad("expected { vendor, name, config?, reason }"));
    const { vendor, name, reason } = parsed.data;
    const cfg = vendorUsagePublicConfigSchemas[vendor].safeParse(parsed.data.config);
    if (!cfg.success) return reply.status(400).send(bad(`config does not match the ${vendor} connector's schema`));
    const exists = await db
      .select({ id: vendorUsageConnectors.id })
      .from(vendorUsageConnectors)
      .where(sql`lower(${vendorUsageConnectors.name}) = lower(${name})`)
      .limit(1);
    if (exists.length) return reply.status(409).send({ error: "connector_name_taken" });
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(vendorUsageConnectors)
        .values({ vendor, name, publicConfig: cfg.data as Record<string, unknown>, createdBy: actor(req) })
        .returning();
      await audit(tx, actor(req), "vendor_usage_connector", created!.id, VENDOR_USAGE_RULE_IDS.connectorCreated, "allow",
        `vendor usage connector '${name}' (${vendor}) created, disabled: ${reason}`, { vendor, name, reason });
      return created!;
    });
    return reply.status(201).send({ connector: connectorView(row, null) });
  });

  app.put("/v1/vendor-usage/connectors/:connectorId/config", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const connector = await loadConnector(p.data.connectorId);
    if (!connector || !isPullVendor(connector.vendor)) return reply.status(404).send({ error: "not_found" });
    const parsed = configBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(bad("expected { config, reason }"));
    const cfg = vendorUsagePublicConfigSchemas[connector.vendor].safeParse(parsed.data.config);
    if (!cfg.success) return reply.status(400).send(bad(`config does not match the ${connector.vendor} connector's schema`));
    const { row, remarked } = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(vendorUsageConnectors)
        .set({ publicConfig: cfg.data as Record<string, unknown>, updatedAt: sql`now()` })
        .where(eq(vendorUsageConnectors.id, connector.id))
        .returning();
      const n = await remarkOverlap(tx, updated!, cfg.data);
      await audit(tx, actor(req), "vendor_usage_connector", connector.id, VENDOR_USAGE_RULE_IDS.connectorConfigured, "allow",
        `vendor usage connector '${connector.name}' configuration changed; ${n} stored line(s) re-marked: ${parsed.data.reason}`,
        { reason: parsed.data.reason, linesRemarked: n, configKeys: Object.keys(cfg.data) });
      return { row: updated!, remarked: n };
    });
    const cred = await liveCredential(db, connector.id);
    return reply.send({ connector: connectorView(row, cred), linesRemarked: remarked });
  });

  app.put("/v1/vendor-usage/connectors/:connectorId/credential", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const connector = await loadConnector(p.data.connectorId);
    if (!connector || !isPullVendor(connector.vendor)) return reply.status(404).send({ error: "not_found" });
    const parsed = credentialBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(bad("expected { secret, replacesCredentialId: uuid | null, acknowledgeWriteCapable?, acknowledgeUnverifiedScope?, reason }"));
    }
    if (resolveDeployMode() === "air_gapped") {
      return reply.status(409).send({ error: "vendor_usage_air_gapped", detail: "this deployment is air-gapped; no vendor credential can be stored" });
    }
    if (!(await loadPolicyEnabled(db))) {
      return reply.status(409).send({ error: "vendor_usage_disabled", detail: "turn vendor usage pull on for the organisation first" });
    }
    if (!opts.dataKey) return reply.status(503).send({ error: "data_key_unavailable" });
    const posture = VENDOR_USAGE_CATALOGUE[connector.vendor].scopePosture;
    if (posture === "write_capable" && !parsed.data.acknowledgeWriteCapable) {
      return reply.status(409).send({
        error: "write_capable_acknowledgement_required",
        detail: VENDOR_USAGE_CATALOGUE[connector.vendor].scopeNote + " Send acknowledgeWriteCapable: true to store it.",
      });
    }
    // secure by default (ADR-0180): a scope RegulAIt cannot check is held at least as strictly as one it knows can
    // write, so storing it needs the admin's own attestation, recorded with the credential and in the audit row
    if (posture === "unverified" && !parsed.data.acknowledgeUnverifiedScope) {
      return reply.status(409).send({
        error: "unverified_scope_acknowledgement_required",
        detail:
          VENDOR_USAGE_CATALOGUE[connector.vendor].scopeNote +
          " Send acknowledgeUnverifiedScope: true to attest that the token carries read permissions only.",
      });
    }
    if (!(await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { vendorUsageConnector: connector.id, values: { credential: "store", scopePosture: posture } },
    })).ok) {
      return reply;
    }
    const existing = await liveCredential(db, connector.id);
    if ((existing?.id ?? null) !== parsed.data.replacesCredentialId) {
      return reply.status(409).send({
        error: "credential_conflict",
        detail: "replacesCredentialId must name the connector's live credential (null when it has none)",
        liveCredentialId: existing?.id ?? null,
      });
    }
    const ciphertext = encryptSecret(opts.dataKey, parsed.data.secret);
    const stored = await db.transaction(async (tx) => {
      if (existing) {
        await tx
          .update(vendorUsageCredentials)
          .set({ revokedAt: sql`now()`, revokedBy: actor(req), secretCiphertext: null })
          .where(eq(vendorUsageCredentials.id, existing.id));
      }
      const [row] = await tx
        .insert(vendorUsageCredentials)
        .values({
          connectorId: connector.id,
          secretCiphertext: ciphertext,
          scopePosture: posture,
          // the acknowledgement of any scope RegulAIt cannot hold to read-only: write_capable or unverified
          writeCapableAcknowledgedAt: posture === "read_only" ? null : new Date(),
          createdBy: actor(req),
        })
        .returning();
      const ruleId = existing ? VENDOR_USAGE_RULE_IDS.credentialReplaced : VENDOR_USAGE_RULE_IDS.credentialStored;
      await audit(tx, actor(req), "vendor_usage_credential", row!.id, ruleId, "allow",
        `vendor usage credential ${existing ? "replaced" : "stored"} for '${connector.name}' (${posture}): ${parsed.data.reason}`,
        {
          connectorId: connector.id,
          replacedCredentialId: existing?.id ?? null,
          scopePosture: posture,
          writeCapableAcknowledged: posture === "write_capable",
          ...(posture === "unverified" ? { scopeAttestation: UNVERIFIED_SCOPE_ATTESTATION } : {}),
          reason: parsed.data.reason,
        });
      return row!;
    });
    return reply.status(existing ? 200 : 201).send({ credential: credentialView(stored) });
  });

  // revoking is never harder than granting: no step-up (ADR-0322 §2)
  app.delete("/v1/vendor-usage/connectors/:connectorId/credential", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const connector = await loadConnector(p.data.connectorId);
    if (!connector) return reply.status(404).send({ error: "not_found" });
    const parsed = revokeBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(bad("expected { reason }"));
    const existing = await liveCredential(db, connector.id);
    if (!existing) return reply.status(404).send({ error: "no_live_credential" });
    await db.transaction(async (tx) => {
      await tx
        .update(vendorUsageCredentials)
        .set({ revokedAt: sql`now()`, revokedBy: actor(req), secretCiphertext: null })
        .where(eq(vendorUsageCredentials.id, existing.id));
      // a connector without a credential cannot pull; disabling it keeps the state honest
      await tx.update(vendorUsageConnectors).set({ enabled: false, updatedAt: sql`now()` }).where(eq(vendorUsageConnectors.id, connector.id));
      await audit(tx, actor(req), "vendor_usage_credential", existing.id, VENDOR_USAGE_RULE_IDS.credentialRevoked, "allow",
        `vendor usage credential revoked for '${connector.name}', connector disabled: ${parsed.data.reason}`,
        { connectorId: connector.id, reason: parsed.data.reason });
    });
    return reply.send({ revoked: existing.id });
  });

  app.put("/v1/vendor-usage/connectors/:connectorId/enabled", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const connector = await loadConnector(p.data.connectorId);
    if (!connector) return reply.status(404).send({ error: "not_found" });
    const parsed = enabledBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(bad("expected { enabled: boolean, reason: string (3-500 characters) }"));
    const { enabled, reason } = parsed.data;
    if (enabled) {
      if (resolveDeployMode() === "air_gapped") {
        return reply.status(409).send({ error: "vendor_usage_air_gapped", detail: "this deployment is air-gapped; no connector can be enabled" });
      }
      if (!(await loadPolicyEnabled(db))) {
        return reply.status(409).send({ error: "vendor_usage_disabled", detail: "turn vendor usage pull on for the organisation first" });
      }
      if (!isPullVendor(connector.vendor)) return reply.status(409).send({ error: "vendor_not_built" });
      if (!(await liveCredential(db, connector.id))) {
        return reply.status(409).send({ error: "no_live_credential", detail: "store a credential before enabling the connector" });
      }
      if (!(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { vendorUsageConnector: connector.id, values: { enabled: true } } })).ok) {
        return reply;
      }
    }
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(vendorUsageConnectors)
        .set({ enabled, updatedAt: sql`now()` })
        .where(eq(vendorUsageConnectors.id, connector.id))
        .returning();
      await audit(tx, actor(req), "vendor_usage_connector", connector.id, VENDOR_USAGE_RULE_IDS.connectorEnabledChanged, "allow",
        `vendor usage connector '${connector.name}' ${connector.enabled ? "enabled" : "disabled"} -> ${enabled ? "enabled" : "disabled"}: ${reason}`,
        { transition: { from: connector.enabled, to: enabled }, reason, receiptClass: "configuration" });
      return updated!;
    });
    return reply.send({ connector: connectorView(row, await liveCredential(db, connector.id)) });
  });

  app.post("/v1/vendor-usage/connectors/:connectorId/pull", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const connector = await loadConnector(p.data.connectorId);
    if (!connector) return reply.status(404).send({ error: "not_found" });
    const { run } = await runVendorUsagePull(db, connector.id, { trigger: "manual", dataKey: opts.dataKey, deps: opts.deps, requestedBy: actor(req) });
    const status = run.status === "succeeded" ? 200 : run.status === "refused" ? 409 : 502;
    return reply.status(status).send({ run: runView(run), statement: VENDOR_USAGE_PULL_STATEMENT });
  });

  app.get("/v1/vendor-usage/connectors/:connectorId/runs", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const connector = await loadConnector(p.data.connectorId);
    if (!connector) return reply.status(404).send({ error: "not_found" });
    // keyset pagination on (started_at, id) (#861 review): `before` is the last run id of the previous page
    const q = z.object({ before: z.string().uuid().optional() }).strict().safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send(bad("expected ?before=<run id>"));
    let cursor: { startedAt: Date; id: string } | null = null;
    if (q.data.before) {
      const [c] = await db
        .select({ startedAt: vendorUsagePullRuns.startedAt, id: vendorUsagePullRuns.id })
        .from(vendorUsagePullRuns)
        .where(and(eq(vendorUsagePullRuns.id, q.data.before), eq(vendorUsagePullRuns.connectorId, connector.id)));
      if (!c) return reply.status(400).send(bad("before must name a run of this connector"));
      cursor = c;
    }
    const runs = await db
      .select()
      .from(vendorUsagePullRuns)
      .where(
        and(
          eq(vendorUsagePullRuns.connectorId, connector.id),
          cursor
            ? sql`(${vendorUsagePullRuns.startedAt}, ${vendorUsagePullRuns.id}) < (${cursor.startedAt}, ${cursor.id})`
            : undefined,
        ),
      )
      .orderBy(desc(vendorUsagePullRuns.startedAt), desc(vendorUsagePullRuns.id))
      .limit(RUNS_PAGE);
    return reply.send({ runs: runs.map(runView), nextBefore: runs.length === RUNS_PAGE ? runs[runs.length - 1]!.id : null });
  });
}
