/**
 * ADR-0361 — monitoring sanctioned AI SaaS (Microsoft 365 Copilot first) through the vendors' compliance APIs: the
 * engine, the scheduled sweep, the retention sweep and the admin routes.
 *
 * THREE SWITCHES before one byte leaves (§1), each OFF by default (ADR-0180):
 *   1. the org policy (`ai_saas_monitor_policy.enabled`), on = a `settings_relax` step-up, refused under `air_gapped`;
 *   2. the connector (`enabled`), on = a step-up and a live credential;
 *   3. the vendor hosts in the egress allow-list (ADR-0034), enforced by the guarded fetch on every request.
 *
 * WHAT A RUN DOES (§4). It reads the window's interactions through the connector, and for each NEW one (idempotent on
 * the vendor id) writes an append-only evidence row with the text's SHA-256 and length, runs the ADR-0042 guardrail
 * detectors and the ADR-0140 PII detector on the text in memory, writes one finding row per (detector, category) with
 * a count, and an audit row when anything matched. Counts only: matched text never reaches a row, a log or a response.
 * The text itself is kept only when the policy's content capture is `redacted`: then its ADR-0140-redacted form is
 * sealed under the data key, unless a blocking guardrail finding (a secret, say) means even the redacted text must not
 * be stored.
 *
 * RETENTION (§5) follows the compliance cascade: the composed audit floor, extended by the connector's compliance
 * tags' `auditRetentionDays`. No floor = keep everything. The database clock decides, and the guard trigger re-checks.
 *
 * NO VENDOR TEXT IN THE LEDGER. A failed run stores a fixed code and a sentence RegulAIt wrote.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  aiSaasInteractionFindings,
  aiSaasInteractions,
  aiSaasMonitorConnectors,
  aiSaasMonitorConnectorTags,
  aiSaasMonitorCredentials,
  aiSaasMonitorPolicy,
  aiSaasMonitorRuns,
  and,
  auditLog,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  sql,
  type AiSaasMonitorConnectorRow,
  type AiSaasMonitorRunRow,
  type Db,
} from "@regulait/db";
import {
  AI_SAAS_CONTENT_CAPTURE_MODES,
  AI_SAAS_MONITOR_BUILT_VENDORS,
  AI_SAAS_MONITOR_CATALOGUE,
  AI_SAAS_MONITOR_MAX_BACKFILL_DAYS,
  AI_SAAS_MONITOR_MAX_INTERACTIONS_PER_RUN,
  AI_SAAS_MONITOR_MAX_RESPONSE_BYTES,
  AI_SAAS_MONITOR_SETTLE_MS,
  AI_SAAS_MONITOR_STATEMENT,
  AI_SAAS_MONITOR_VENDORS,
  aiSaasMonitorConfigSchemas,
  aiSaasMonitorRunSources,
  configuredBackfillDays,
  detectPII,
  redactPII,
  type AiSaasContentCapture,
  type AiSaasFindingAction,
  type AiSaasMonitorErrorCode,
  type AiSaasMonitorRunStatus,
  type AiSaasMonitorVendor,
  type InternationalPiiCategory,
  type MonitoredInteraction,
} from "@regulait/shared";
import { AI_SAAS_CONNECTORS, ConnectorError, type ComplianceConnector, type ConnectorContext } from "./ai-saas-connectors.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { resolveDeployMode } from "./deploy-posture.js";
import { DISCOVERY_BACKOFF_MAX_MS, DISCOVERY_BACKOFF_MAX_TIMES, retryAfterMs, scrubRunText, spacingRateLimiter } from "./discovery-worker.js";
import { createGuardedFetch, egressRefusal, egressResponseTooLarge, type EgressResolver } from "./egress-guard.js";
import { resolveGuardrailPolicy, runGuardrails, type GuardrailPolicy } from "./guardrails.js";
import { loadOrgSettings, orgDefaultPiiMode, piiInternationalCategories, retentionFloor } from "./org-settings.js";
import { complianceProfilesForTags, effectiveCompliancePolicy } from "./projects.js";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { requireStepUp } from "./step-up.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
const DAY_MS = 24 * 3600 * 1000;
/** a run still `running` after this is a crashed process; the next run closes it so the connector is not stuck */
const RUN_LEASE_SECONDS = 2 * 3600;
/** a run stops itself well inside its lease */
const RUN_MAX_MS = 90 * 60 * 1000;
const RUNS_PAGE = 50;
const INTERACTIONS_PAGE = 100;
const RETENTION_BATCH = 2000;
const RETENTION_MAX_BATCHES = 10;
/** one request per connector at most every 250 ms, well under Graph's per-app export limits */
const MIN_SPACING_MS = 250;

export const AI_SAAS_MONITOR_JOB_NAME = "ai-saas-monitor-sweep";
export const AI_SAAS_RETENTION_JOB_NAME = "ai-saas-evidence-retention-sweep";

export const AI_SAAS_RULE_IDS = {
  policyChanged: "ai-saas-monitor-policy-changed",
  connectorCreated: "ai-saas-monitor-connector-created",
  connectorConfigured: "ai-saas-monitor-connector-configured",
  connectorEnabledChanged: "ai-saas-monitor-connector-enabled-changed",
  credentialStored: "ai-saas-monitor-credential-stored",
  credentialReplaced: "ai-saas-monitor-credential-replaced",
  credentialRevoked: "ai-saas-monitor-credential-revoked",
  credentialRefused: "ai-saas-monitor-credential-refused",
  runCompleted: "ai-saas-monitor-run-completed",
  runFailed: "ai-saas-monitor-run-failed",
  runRefused: "ai-saas-monitor-run-refused",
  interactionFinding: "ai-saas-interaction-finding",
  retentionPurged: "ai-saas-evidence-retention-purged",
} as const;

/** test seams: the transport the guarded fetch sends through, its pinned DNS, and the connector registry */
export interface AiSaasMonitorDeps {
  fetchImpl?: typeof fetch | undefined;
  resolve?: EgressResolver | undefined;
  connectors?: ReadonlyMap<AiSaasMonitorVendor, ComplianceConnector> | undefined;
  /** spacing between requests (tests pass 0) */
  minSpacingMs?: number | undefined;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;
type AuditObject = "ai_saas_monitor_policy" | "ai_saas_monitor_connector" | "ai_saas_monitor_credential" | "ai_saas_monitor_run" | "ai_saas_interaction";

/** the audit row; callers pass the transaction that holds the state change, so neither lands without the other */
async function audit(
  db: DbOrTx,
  userId: string | null,
  objectType: AuditObject,
  objectId: string | null,
  ruleId: string,
  effect: "allow" | "deny",
  reason: string,
  detail: Record<string, unknown>,
): Promise<string> {
  const [row] = await db
    .insert(auditLog)
    .values({ userId: userId ?? NIL_USER, objectType, objectId, detail: { subsystem: "ai-saas-monitor", adr: "0361", ...detail }, effect, ruleId, ruleChain: [], reason })
    .returning({ id: auditLog.id });
  return row!.id;
}

// --------------------------------------------------------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------------------------------------------------------

export async function loadAiSaasPolicy(db: DbOrTx): Promise<{ enabled: boolean; contentCapture: AiSaasContentCapture }> {
  const [row] = await db.select().from(aiSaasMonitorPolicy).limit(1);
  return { enabled: row?.enabled === true, contentCapture: row?.contentCapture === "redacted" ? "redacted" : "none" };
}

async function liveCredential(db: DbOrTx, connectorId: string) {
  const [row] = await db
    .select()
    .from(aiSaasMonitorCredentials)
    .where(and(eq(aiSaasMonitorCredentials.connectorId, connectorId), isNull(aiSaasMonitorCredentials.revokedAt)))
    .limit(1);
  return row ?? null;
}

async function connectorTags(db: DbOrTx, connectorId: string): Promise<string[]> {
  const rows = await db
    .select({ tag: aiSaasMonitorConnectorTags.profileTag })
    .from(aiSaasMonitorConnectorTags)
    .where(eq(aiSaasMonitorConnectorTags.connectorId, connectorId));
  return rows.map((r) => r.tag).sort();
}

/**
 * The connector's slice of the §8.3 cascade: its PII mode (the strictest of its tags' profiles, else the org default,
 * exactly as `projectPiiMode` resolves it for a project) and the retention its tags ask for.
 */
export async function connectorCascade(db: Db, connectorId: string): Promise<{ tags: string[]; piiMode: "block" | "warn" | "log" | "redact" | null; auditRetentionDays: number | null }> {
  const tags = await connectorTags(db, connectorId);
  const profiles = tags.length ? await complianceProfilesForTags(db, tags) : [];
  if (profiles.length === 0) return { tags, piiMode: orgDefaultPiiMode(await loadOrgSettings(db)), auditRetentionDays: null };
  const eff = effectiveCompliancePolicy(profiles);
  return { tags, piiMode: eff.piiMode, auditRetentionDays: eff.auditRetentionDays };
}

// --------------------------------------------------------------------------------------------------------------------
// The scan (pure over its inputs)
// --------------------------------------------------------------------------------------------------------------------

export interface InteractionScan {
  findings: Array<{ detector: string; category: string; hitCount: number; action: AiSaasFindingAction }>;
  /** whether even the redacted text must not be stored (a blocking non-PII finding: a secret, an injection) */
  withholdContent: boolean;
}

/** the ADR-0042 guardrail detectors (heuristic, the org policy) and the ADR-0140 PII detector, counts only */
export function scanInteraction(
  interaction: MonitoredInteraction,
  policy: GuardrailPolicy,
  pii: { mode: "block" | "warn" | "log" | "redact" | null; international: readonly InternationalPiiCategory[] },
): InteractionScan {
  const findings: InteractionScan["findings"] = [];
  if (!interaction.text) return { findings, withholdContent: false };
  const phase = interaction.kind === "response" ? "output" : "input";
  const evaluation = runGuardrails(policy, phase, interaction.text);
  let withholdContent = false;
  for (const f of evaluation.findings) {
    if (f.action === "block") withholdContent = true;
    for (const h of f.hits) findings.push({ detector: f.detector, category: String(h.category).slice(0, 100), hitCount: Math.max(1, h.count ?? 1), action: f.action });
  }
  // PII has its own dedicated path (the guardrail wrapper excludes it); its action follows the cascade's mode
  const piiAction: AiSaasFindingAction = pii.mode === "block" ? "block" : pii.mode === "warn" || pii.mode === "redact" ? "warn" : "log";
  for (const h of detectPII(interaction.text, pii.international)) findings.push({ detector: "pii", category: h.category, hitCount: Math.max(1, h.count), action: piiAction });
  // one row per (detector, category): a detector reporting one category twice is summed
  const merged = new Map<string, InteractionScan["findings"][number]>();
  for (const f of findings) {
    const key = `${f.detector}\u0000${f.category}`;
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, hitCount: prev.hitCount + f.hitCount } : f);
  }
  return { findings: [...merged.values()], withholdContent };
}

// --------------------------------------------------------------------------------------------------------------------
// The run
// --------------------------------------------------------------------------------------------------------------------

/**
 * The window the next run asks for: it resumes exactly where the last success ended (never skipping a gap), else the
 * configured backfill; it spans at most AI_SAAS_MONITOR_MAX_BACKFILL_DAYS, so a connector that was off for a long time
 * catches up over several runs; and it never reaches closer to now than the settle time.
 */
export function monitorWindow(monitoredThrough: Date | null, backfillDays: number, now: Date): { start: Date; end: Date } {
  const settled = now.getTime() - AI_SAAS_MONITOR_SETTLE_MS;
  const start = monitoredThrough ?? new Date(settled - Math.min(backfillDays, AI_SAAS_MONITOR_MAX_BACKFILL_DAYS) * DAY_MS);
  const end = new Date(Math.min(settled, start.getTime() + AI_SAAS_MONITOR_MAX_BACKFILL_DAYS * DAY_MS));
  return { start, end };
}

class RunStop extends Error {
  constructor(
    readonly status: "failed" | "refused",
    readonly code: AiSaasMonitorErrorCode,
    readonly detail: string,
  ) {
    super(detail);
  }
}

function classifyRunError(err: unknown): RunStop {
  if (err instanceof RunStop) return err;
  if (err instanceof ConnectorError) return new RunStop("failed", err.code, err.detail);
  if (egressResponseTooLarge(err)) return new RunStop("failed", "response_too_large", `a vendor response exceeded ${AI_SAAS_MONITOR_MAX_RESPONSE_BYTES} bytes`);
  if (egressRefusal(err) !== null) return new RunStop("failed", "egress_refused", "the egress guard refused a vendor host: add the hosts the catalogue lists to the egress allow-list");
  const name = (err as { name?: unknown })?.name;
  if (name === "AbortError" || name === "TimeoutError") return new RunStop("failed", "network_error", "the run reached its time limit or the vendor stopped answering");
  if (name === "TypeError") return new RunStop("failed", "network_error", "the vendor could not be reached");
  return new RunStop("failed", "internal", "the run stopped on an unexpected error; nothing past the last stored page was written");
}

export interface RunOptions {
  trigger: "schedule" | "manual";
  dataKey?: string | undefined;
  deps?: AiSaasMonitorDeps | undefined;
  requestedBy?: string | null | undefined;
  now?: Date | undefined;
}

/**
 * One run for one connector. Opens a run row first (a row stuck at `running` is the diagnosis of a process that died),
 * refuses unless every switch is on, authorises (a credential that can write is refused and never used again), then
 * writes evidence page by page. A failed run leaves the connector's window where it was; the idempotent evidence key
 * makes the retry safe.
 */
export async function runAiSaasMonitor(db: Db, connectorId: string, opts: RunOptions): Promise<AiSaasMonitorRunRow> {
  const [connector] = await db.select().from(aiSaasMonitorConnectors).where(eq(aiSaasMonitorConnectors.id, connectorId)).limit(1);
  if (!connector) throw new Error("ai-saas-monitor: no such connector");
  const requestedBy = opts.requestedBy ?? null;

  // a crashed process's run is closed (running -> failed, the declared move) so the connector is not stuck behind it
  await db
    .update(aiSaasMonitorRuns)
    .set({ status: "failed", finishedAt: sql`now()`, errorCode: "internal", errorDetail: "the process running this run stopped before it finished" })
    .where(
      and(
        eq(aiSaasMonitorRuns.connectorId, connector.id),
        inArray(aiSaasMonitorRuns.status, aiSaasMonitorRunSources("failed")),
        lt(aiSaasMonitorRuns.startedAt, sql`now() - make_interval(secs => ${RUN_LEASE_SECONDS})`),
      ),
    );

  let run: AiSaasMonitorRunRow;
  try {
    const [opened] = await db.insert(aiSaasMonitorRuns).values({ connectorId: connector.id, trigger: opts.trigger, requestedBy }).returning();
    run = opened!;
  } catch (err) {
    if ((err as { code?: string })?.code !== "23505" && (err as { cause?: { code?: string } })?.cause?.code !== "23505") throw err;
    const [refused] = await db
      .insert(aiSaasMonitorRuns)
      .values({ connectorId: connector.id, trigger: opts.trigger, requestedBy, status: "refused", finishedAt: new Date(), errorCode: "in_progress", errorDetail: "another run of this connector is in progress" })
      .returning();
    return refused!;
  }

  const counters = { usersRead: 0, pages: 0, interactionsSeen: 0, interactionsNew: 0, findingsCreated: 0 };
  const units = new Set<string>();
  /** the decrypted secret and every short-lived token the connector registered: scrubbed from anything stored */
  const secrets: string[] = [];

  const finish = async (status: Exclude<AiSaasMonitorRunStatus, "running">, code: AiSaasMonitorErrorCode | null, detail: string | null, extra: { window?: { start: Date; end: Date } } = {}): Promise<AiSaasMonitorRunRow> => {
    return db.transaction(async (tx) => {
      const [closed] = await tx
        .update(aiSaasMonitorRuns)
        .set({
          status,
          finishedAt: sql`now()`,
          errorCode: code,
          errorDetail: detail ? scrubRunText(detail, secrets, 500) : null,
          ...counters,
          usersRead: units.size,
          ...(extra.window ? { windowStart: extra.window.start, windowEnd: extra.window.end } : {}),
        })
        .where(and(eq(aiSaasMonitorRuns.id, run.id), inArray(aiSaasMonitorRuns.status, aiSaasMonitorRunSources(status))))
        .returning();
      if (status === "succeeded" && extra.window) {
        await tx.update(aiSaasMonitorConnectors).set({ monitoredThrough: extra.window.end, updatedAt: sql`now()` }).where(eq(aiSaasMonitorConnectors.id, connector.id));
      }
      const ruleId = status === "succeeded" ? AI_SAAS_RULE_IDS.runCompleted : status === "refused" ? AI_SAAS_RULE_IDS.runRefused : AI_SAAS_RULE_IDS.runFailed;
      await audit(tx, requestedBy, "ai_saas_monitor_run", run.id, ruleId, status === "succeeded" ? "allow" : "deny",
        status === "succeeded"
          ? `AI SaaS monitor run for '${connector.name}' read ${counters.interactionsSeen} interaction(s), ${counters.interactionsNew} new, ${counters.findingsCreated} finding(s)`
          : `AI SaaS monitor run for '${connector.name}' ${status}: ${code} — ${scrubRunText(detail ?? "", secrets, 800)}`,
        { connectorId: connector.id, vendor: connector.vendor, trigger: opts.trigger, status, errorCode: code, ...counters, usersRead: units.size, window: extra.window ? { start: extra.window.start.toISOString(), end: extra.window.end.toISOString() } : null });
      return closed ?? run;
    });
  };

  try {
    if (resolveDeployMode() === "air_gapped") throw new RunStop("refused", "air_gapped", "this deployment is air-gapped; AI SaaS monitoring cannot run");
    const policy = await loadAiSaasPolicy(db);
    if (!policy.enabled) throw new RunStop("refused", "disabled", "AI SaaS monitoring is off for the organisation");
    if (!connector.enabled) throw new RunStop("refused", "disabled", "the connector is disabled");
    const impl = (opts.deps?.connectors ?? AI_SAAS_CONNECTORS).get(connector.vendor);
    if (!impl) throw new RunStop("refused", "disabled", `the ${connector.vendor} connector is not built yet`);
    const cred = await liveCredential(db, connector.id);
    if (!cred?.secretCiphertext) throw new RunStop("refused", "no_credential", "the connector has no live credential");
    if (cred.scopePosture === "refused") throw new RunStop("refused", "credential_refused", "the credential was refused because it can write; store a read-only one");
    if (!opts.dataKey) throw new RunStop("refused", "data_key_unavailable", "the data key is not configured, so the credential cannot be opened");
    const configProblem = impl.validateConfig(connector.publicConfig);
    if (configProblem) throw new RunStop("refused", "internal", `the stored configuration is invalid: ${configProblem}`);

    const secret = decryptSecret(opts.dataKey, cred.secretCiphertext);
    secrets.push(secret);
    const deadline = AbortSignal.timeout(RUN_MAX_MS);
    const limiter = spacingRateLimiter(opts.deps?.minSpacingMs ?? MIN_SPACING_MS);
    let backoffs = 0;
    const ctx: ConnectorContext = {
      config: connector.publicConfig,
      credential: { secret },
      fetch: createGuardedFetch({
        allowList: await loadEgressAllowList(db),
        maxResponseBytes: AI_SAAS_MONITOR_MAX_RESPONSE_BYTES,
        ...(opts.deps?.fetchImpl ? { fetchImpl: opts.deps.fetchImpl } : {}),
        ...(opts.deps?.resolve ? { resolve: opts.deps.resolve } : {}),
      }),
      throttle: () => limiter.acquire(connector.id, deadline),
      backoff: async (res) => {
        if (res.status !== 429 && res.status !== 503) return false;
        if (backoffs >= DISCOVERY_BACKOFF_MAX_TIMES) return false;
        backoffs += 1;
        await res.arrayBuffer().catch(() => undefined);
        const ms = retryAfterMs(res) ?? Math.min(1000 * 2 ** backoffs, DISCOVERY_BACKOFF_MAX_MS);
        await new Promise((r) => setTimeout(r, ms));
        return true;
      },
      registerSecret: (v) => {
        if (v && secrets.length < 64 && !secrets.includes(v)) secrets.push(v);
      },
      signal: deadline,
    };

    const auth = await impl.authorise(ctx);
    if (auth.scope === "write") {
      await db.transaction(async (tx) => {
        await tx.update(aiSaasMonitorCredentials).set({ scopePosture: "refused", verifiedAt: sql`now()` }).where(eq(aiSaasMonitorCredentials.id, cred.id));
        await tx.update(aiSaasMonitorConnectors).set({ enabled: false, updatedAt: sql`now()` }).where(eq(aiSaasMonitorConnectors.id, connector.id));
        await audit(tx, requestedBy, "ai_saas_monitor_credential", cred.id, AI_SAAS_RULE_IDS.credentialRefused, "deny",
          `the credential for '${connector.name}' holds more than read permissions; refused and the connector disabled`,
          { connectorId: connector.id, permissions: auth.permissions.slice(0, 50) });
      });
      throw new RunStop("failed", "credential_refused", `the credential holds more than read permissions (${auth.permissions.join(", ").slice(0, 300)}); it was refused and the connector disabled`);
    }
    await db.update(aiSaasMonitorCredentials).set({ scopePosture: auth.scope, verifiedAt: sql`now()` }).where(eq(aiSaasMonitorCredentials.id, cred.id));

    const window = monitorWindow(connector.monitoredThrough, configuredBackfillDays(connector.publicConfig), opts.now ?? new Date());
    if (window.start >= window.end) return await finish("succeeded", null, null, { window });

    const guardrails = await resolveGuardrailPolicy(db, {});
    const cascade = await connectorCascade(db, connector.id);
    const pii = { mode: cascade.piiMode, international: await piiInternationalCategories(db) };
    const capture = policy.contentCapture === "redacted";

    for await (const page of impl.listInteractions(ctx, auth, window)) {
      counters.pages += 1;
      units.add(page.unit);
      counters.interactionsSeen += page.interactions.length;
      if (counters.interactionsSeen > AI_SAAS_MONITOR_MAX_INTERACTIONS_PER_RUN) {
        throw new RunStop("failed", "interaction_limit", `the window held more than ${AI_SAAS_MONITOR_MAX_INTERACTIONS_PER_RUN} interactions; the pages read so far are kept and the window was not advanced`);
      }
      await writePage(db, connector, run.id, page.interactions, { guardrails, pii, capture, dataKey: opts.dataKey }, counters);
    }
    return await finish("succeeded", null, null, { window });
  } catch (err) {
    const stop = classifyRunError(err);
    return finish(stop.status, stop.code, stop.detail);
  }
}

/** one page, in one transaction: evidence rows (new ones only), their findings, and an audit row per matched one */
async function writePage(
  db: Db,
  connector: AiSaasMonitorConnectorRow,
  runId: string,
  interactions: readonly MonitoredInteraction[],
  scanCtx: { guardrails: GuardrailPolicy; pii: Parameters<typeof scanInteraction>[2]; capture: boolean; dataKey: string },
  counters: { interactionsNew: number; findingsCreated: number },
): Promise<void> {
  if (interactions.length === 0) return;
  await db.transaction(async (tx) => {
    for (const i of interactions) {
      const scan = scanInteraction(i, scanCtx.guardrails, scanCtx.pii);
      const contentCiphertext = scanCtx.capture && i.text && !scan.withholdContent ? encryptSecret(scanCtx.dataKey, redactPII(i.text, scanCtx.pii.international).text) : null;
      const [row] = await tx
        .insert(aiSaasInteractions)
        .values({
          connectorId: connector.id,
          runId,
          vendorInteractionId: i.vendorInteractionId.slice(0, 200),
          conversationRef: i.conversationRef ? i.conversationRef.slice(0, 500) : null,
          kind: i.kind,
          occurredAt: i.occurredAt,
          actorRef: i.actorRef ? i.actorRef.slice(0, 100) : null,
          appRef: i.appRef ? i.appRef.slice(0, 200) : null,
          contentSha256: createHash("sha256").update(i.text, "utf8").digest("hex"),
          contentChars: Math.min(i.text.length, 65536),
          truncated: i.truncated,
          contentCiphertext,
        })
        .onConflictDoNothing({ target: [aiSaasInteractions.connectorId, aiSaasInteractions.vendorInteractionId] })
        .returning({ id: aiSaasInteractions.id });
      if (!row) continue;
      counters.interactionsNew += 1;
      if (scan.findings.length === 0) continue;
      await tx.insert(aiSaasInteractionFindings).values(scan.findings.map((f) => ({ interactionId: row.id, ...f })));
      counters.findingsCreated += scan.findings.length;
      const worst: AiSaasFindingAction = scan.findings.some((f) => f.action === "block") ? "block" : scan.findings.some((f) => f.action === "warn") ? "warn" : "log";
      await audit(tx, null, "ai_saas_interaction", row.id, AI_SAAS_RULE_IDS.interactionFinding, worst === "log" ? "allow" : "deny",
        `${connector.vendor} ${i.kind} matched ${scan.findings.map((f) => `${f.detector}:${f.category}`).join(", ")}`.slice(0, 1000),
        {
          connectorId: connector.id,
          vendor: connector.vendor,
          runId,
          vendorInteractionId: i.vendorInteractionId.slice(0, 200),
          kind: i.kind,
          occurredAt: i.occurredAt.toISOString(),
          action: worst,
          findings: scan.findings,
          attribution: "third_party",
        });
    }
  });
}

/** the scheduled sweep: one run per enabled connector, only while the policy is on */
export async function runAiSaasMonitorSweep(db: Db, opts: { dataKey?: string | undefined; deps?: AiSaasMonitorDeps | undefined; now?: Date | undefined } = {}) {
  if (resolveDeployMode() === "air_gapped" || !(await loadAiSaasPolicy(db)).enabled) return { connectors: 0, interactionsNew: 0, failed: 0 };
  const due = await db.select({ id: aiSaasMonitorConnectors.id }).from(aiSaasMonitorConnectors).where(eq(aiSaasMonitorConnectors.enabled, true));
  let interactionsNew = 0;
  let failed = 0;
  for (const c of due) {
    try {
      const run = await runAiSaasMonitor(db, c.id, { trigger: "schedule", dataKey: opts.dataKey, deps: opts.deps, now: opts.now });
      interactionsNew += run.interactionsNew;
      if (run.status !== "succeeded") failed++;
    } catch {
      failed++;
    }
  }
  return { connectors: due.length, interactionsNew, failed };
}

// --------------------------------------------------------------------------------------------------------------------
// Retention (§5): the audit floor, extended by the connector's compliance tags
// --------------------------------------------------------------------------------------------------------------------

export async function runAiSaasEvidenceRetentionSweep(db: Db, opts: { actorUserId?: string | null } = {}) {
  const f = await retentionFloor(db);
  if (f.retainedDays == null || f.cutoff == null) return { deleted: 0, retainedDays: null as number | null, connectors: 0 };
  const floorDays = Math.max(f.retainedDays, ...f.modeOverrides.map((o) => o.retainedDays));
  const connectors = await db.select({ id: aiSaasMonitorConnectors.id, name: aiSaasMonitorConnectors.name }).from(aiSaasMonitorConnectors);
  let deleted = 0;
  for (const c of connectors) {
    const cascade = await connectorCascade(db, c.id);
    const days = Math.max(floorDays, cascade.auditRetentionDays ?? 0);
    // f.cutoff came from the database clock for f.retainedDays; move it back by any extension
    const cutoff = new Date(f.cutoff.getTime() - (days - f.retainedDays) * DAY_MS);
    for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
      const n = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('regulait.ai_saas_retention_cutoff', ${cutoff.toISOString()}, true)`);
        const due = await tx
          .select({ id: aiSaasInteractions.id })
          .from(aiSaasInteractions)
          .where(and(eq(aiSaasInteractions.connectorId, c.id), lt(aiSaasInteractions.receivedAt, cutoff)))
          .orderBy(aiSaasInteractions.receivedAt)
          .limit(RETENTION_BATCH);
        if (due.length === 0) return 0;
        const removed = await tx
          .delete(aiSaasInteractions)
          .where(and(inArray(aiSaasInteractions.id, due.map((d) => d.id)), lt(aiSaasInteractions.receivedAt, cutoff)))
          .returning({ id: aiSaasInteractions.id });
        await audit(tx, opts.actorUserId ?? null, "ai_saas_monitor_connector", c.id, AI_SAAS_RULE_IDS.retentionPurged, "allow",
          `deleted ${removed.length} AI SaaS interaction record(s) of '${c.name}' received before ${cutoff.toISOString()} (retention ${days}d) (ADR-0361)`,
          { phase: "evidence-retention", deleted: removed.length, retainedDays: days, floorSource: f.floorSource, tags: cascade.tags, cutoff: cutoff.toISOString() });
        return removed.length;
      });
      deleted += n;
      if (n < RETENTION_BATCH) break;
    }
  }
  return { deleted, retainedDays: floorDays, connectors: connectors.length };
}

export function aiSaasMonitorJobDefinitions(opts: { dataKey?: string | undefined } = {}): SchedulerJobDefinition[] {
  return [
    {
      name: AI_SAAS_MONITOR_JOB_NAME,
      description:
        "Read each enabled AI SaaS connector's compliance export (ADR-0361), record each interaction as evidence and scan it " +
        "with the guardrail and PII detectors. Runs nothing while the org policy is off, which is the default, and nothing when air-gapped.",
      adr: "ADR-0361",
      defaultIntervalSeconds: 3600,
      run: async (ctx) => {
        const out = await runAiSaasMonitorSweep(ctx.db, { dataKey: opts.dataKey, now: ctx.now });
        return { itemsProcessed: out.interactionsNew, detail: out };
      },
    },
    {
      name: AI_SAAS_RETENTION_JOB_NAME,
      description:
        "Delete AI SaaS interaction evidence (ADR-0361) past the composed audit floor, extended by each connector's compliance " +
        "tags. With no floor configured nothing is deleted.",
      adr: "ADR-0361",
      defaultIntervalSeconds: 24 * 3600,
      run: async (ctx) => {
        const out = await runAiSaasEvidenceRetentionSweep(ctx.db);
        return { itemsProcessed: out.deleted, detail: out };
      },
    },
  ];
}

// --------------------------------------------------------------------------------------------------------------------
// Routes (admin-only by the default gate: none is in NON_ADMIN_ROUTES)
// --------------------------------------------------------------------------------------------------------------------

const reason = z.string().trim().min(3).max(500);
const idParam = z.object({ connectorId: z.string().uuid() }).strict();
const tagList = z.array(z.string().trim().min(1).max(64)).max(20).default([]);
const policyBody = z.object({ enabled: z.boolean(), contentCapture: z.enum(AI_SAAS_CONTENT_CAPTURE_MODES).default("none"), reason }).strict();
const createBody = z.object({ vendor: z.enum(AI_SAAS_MONITOR_VENDORS), name: z.string().trim().min(1).max(120), config: z.unknown(), complianceTags: tagList, reason }).strict();
const configBody = z.object({ config: z.unknown(), complianceTags: tagList, reason }).strict();
const credentialBody = z.object({ secret: z.string().min(8).max(4096), replacesCredentialId: z.string().uuid().nullable(), reason }).strict();
const revokeBody = z.object({ reason }).strict();
const enabledBody = z.object({ enabled: z.boolean(), reason }).strict();

function connectorView(c: AiSaasMonitorConnectorRow, cred: { id: string; scopePosture: string; createdAt: Date; verifiedAt: Date | null } | null, tags: string[]) {
  return {
    id: c.id,
    vendor: c.vendor,
    name: c.name,
    enabled: c.enabled,
    config: c.publicConfig,
    complianceTags: tags,
    monitoredThrough: c.monitoredThrough?.toISOString() ?? null,
    credential: cred ? { id: cred.id, scopePosture: cred.scopePosture, storedAt: cred.createdAt.toISOString(), verifiedAt: cred.verifiedAt?.toISOString() ?? null } : null,
    remediation: AI_SAAS_MONITOR_CATALOGUE[c.vendor].remediation,
    createdAt: c.createdAt.toISOString(),
  };
}

function runView(r: AiSaasMonitorRunRow) {
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    window: r.windowStart && r.windowEnd ? { start: r.windowStart.toISOString(), end: r.windowEnd.toISOString() } : null,
    usersRead: r.usersRead,
    pages: r.pages,
    interactionsSeen: r.interactionsSeen,
    interactionsNew: r.interactionsNew,
    findingsCreated: r.findingsCreated,
    errorCode: r.errorCode,
    errorDetail: r.errorDetail,
  };
}

/** the tags must name existing compliance profiles; null = all known, else the unknown ones */
async function unknownTags(db: Db, tags: readonly string[]): Promise<string[]> {
  if (tags.length === 0) return [];
  const known = new Set((await complianceProfilesForTags(db, [...tags])).map((p) => p.tag));
  return tags.filter((t) => !known.has(t));
}

async function replaceTags(tx: Tx, connectorId: string, tags: readonly string[]): Promise<void> {
  await tx.delete(aiSaasMonitorConnectorTags).where(eq(aiSaasMonitorConnectorTags.connectorId, connectorId));
  const unique = [...new Set(tags)];
  if (unique.length) await tx.insert(aiSaasMonitorConnectorTags).values(unique.map((profileTag) => ({ connectorId, profileTag })));
}

export function registerAiSaasMonitorRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined; deps?: AiSaasMonitorDeps | undefined } = {}): void {
  const actor = (req: FastifyRequest): string | null => req.authCtx.userId ?? null;
  const bad = (detail: string) => ({ error: "invalid_body", detail });
  const airGapped = { error: "ai_saas_monitor_air_gapped", detail: "this deployment is air-gapped; AI SaaS monitoring cannot be turned on" };
  const policyOff = { error: "ai_saas_monitor_disabled", detail: "turn AI SaaS monitoring on for the organisation first" };

  const loadConnector = async (id: string) => {
    const [c] = await db.select().from(aiSaasMonitorConnectors).where(eq(aiSaasMonitorConnectors.id, id)).limit(1);
    return c ?? null;
  };
  const viewOf = async (c: AiSaasMonitorConnectorRow) => connectorView(c, await liveCredential(db, c.id), await connectorTags(db, c.id));

  app.get("/v1/ai-saas-monitoring", async () => {
    const policy = await loadAiSaasPolicy(db);
    const deployMode = resolveDeployMode();
    const connectors = await db.select().from(aiSaasMonitorConnectors).orderBy(aiSaasMonitorConnectors.createdAt);
    return {
      policy: { ...policy, deployMode, airGapped: deployMode === "air_gapped" },
      statement: AI_SAAS_MONITOR_STATEMENT,
      catalogue: Object.values(AI_SAAS_MONITOR_CATALOGUE),
      connectors: await Promise.all(connectors.map(viewOf)),
    };
  });

  app.put("/v1/ai-saas-monitoring/policy", async (req, reply) => {
    const parsed = policyBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(bad("expected { enabled: boolean, contentCapture?: 'none' | 'redacted', reason: string (3-500 characters) }"));
    const { enabled, contentCapture } = parsed.data;
    if (enabled && resolveDeployMode() === "air_gapped") return reply.status(409).send(airGapped);
    const before = await loadAiSaasPolicy(db);
    // each relaxation is its own step-up: turning monitoring on, and keeping (redacted) text
    const relaxes: Record<string, unknown> = {};
    if (enabled && !before.enabled) relaxes.enabled = true;
    if (contentCapture === "redacted" && before.contentCapture !== "redacted") relaxes.contentCapture = "redacted";
    if (Object.keys(relaxes).length && !(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { aiSaasMonitoring: true, values: relaxes } })).ok) return reply;
    await db.transaction(async (tx) => {
      await tx
        .insert(aiSaasMonitorPolicy)
        .values({ id: "singleton", enabled, contentCapture, updatedBy: actor(req) })
        .onConflictDoUpdate({ target: aiSaasMonitorPolicy.id, set: { enabled, contentCapture, updatedBy: actor(req), updatedAt: sql`now()` } });
      await audit(tx, actor(req), "ai_saas_monitor_policy", null, AI_SAAS_RULE_IDS.policyChanged, "allow",
        `AI SaaS monitoring ${before.enabled ? "on" : "off"} -> ${enabled ? "on" : "off"}, content capture ${before.contentCapture} -> ${contentCapture}: ${parsed.data.reason}`,
        { transition: { from: before, to: { enabled, contentCapture } }, reason: parsed.data.reason, receiptClass: "configuration" });
    });
    return reply.send({ policy: { enabled, contentCapture } });
  });

  app.post("/v1/ai-saas-monitoring/connectors", async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(bad("expected { vendor, name, config, complianceTags?, reason }"));
    const { vendor, name, complianceTags } = parsed.data;
    if (!AI_SAAS_MONITOR_BUILT_VENDORS.includes(vendor)) return reply.status(409).send({ error: "vendor_not_built", detail: `the ${vendor} connector is not built yet (ADR-0361 §8)` });
    const impl = (opts.deps?.connectors ?? AI_SAAS_CONNECTORS).get(vendor);
    const problem = impl ? impl.validateConfig(parsed.data.config) : "not built";
    if (problem) return reply.status(400).send(bad(`config does not match the ${vendor} connector's schema: ${problem}`));
    const unknown = await unknownTags(db, complianceTags);
    if (unknown.length) return reply.status(400).send({ error: "unknown_compliance_tag", detail: `no compliance profile named ${unknown.join(", ")}` });
    const exists = await db.select({ id: aiSaasMonitorConnectors.id }).from(aiSaasMonitorConnectors).where(sql`lower(${aiSaasMonitorConnectors.name}) = lower(${name})`).limit(1);
    if (exists.length) return reply.status(409).send({ error: "connector_name_taken" });
    // the validated form is stored (lower-cased GUIDs, defaults filled), never the raw body
    const config = aiSaasMonitorConfigSchemas[vendor]!.parse(parsed.data.config);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.insert(aiSaasMonitorConnectors).values({ vendor, name, publicConfig: config, createdBy: actor(req) }).returning();
      await replaceTags(tx, created!.id, complianceTags);
      await audit(tx, actor(req), "ai_saas_monitor_connector", created!.id, AI_SAAS_RULE_IDS.connectorCreated, "allow",
        `AI SaaS monitor connector '${name}' (${vendor}) created, disabled: ${parsed.data.reason}`,
        { vendor, name, complianceTags, configKeys: Object.keys(config), reason: parsed.data.reason });
      return created!;
    });
    return reply.status(201).send({ connector: await viewOf(row) });
  });

  app.put("/v1/ai-saas-monitoring/connectors/:connectorId/config", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const connector = await loadConnector(p.data.connectorId);
    if (!connector) return reply.status(404).send({ error: "not_found" });
    const parsed = configBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(bad("expected { config, complianceTags?, reason }"));
    const schema = aiSaasMonitorConfigSchemas[connector.vendor];
    const cfg = schema?.safeParse(parsed.data.config);
    if (!cfg?.success) return reply.status(400).send(bad(`config does not match the ${connector.vendor} connector's schema`));
    const unknown = await unknownTags(db, parsed.data.complianceTags);
    if (unknown.length) return reply.status(400).send({ error: "unknown_compliance_tag", detail: `no compliance profile named ${unknown.join(", ")}` });
    const beforeTags = await connectorTags(db, connector.id);
    const widens = configWidens(connector.publicConfig, cfg.data);
    // widening who is read (more users, every user, fewer app filters) on an enabled connector is a relaxation
    if (connector.enabled && widens && !(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { aiSaasConnector: connector.id, values: { config: "widened" } } })).ok) return reply;
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(aiSaasMonitorConnectors).set({ publicConfig: cfg.data, updatedAt: sql`now()` }).where(eq(aiSaasMonitorConnectors.id, connector.id)).returning();
      await replaceTags(tx, connector.id, parsed.data.complianceTags);
      await audit(tx, actor(req), "ai_saas_monitor_connector", connector.id, AI_SAAS_RULE_IDS.connectorConfigured, "allow",
        `AI SaaS monitor connector '${connector.name}' configuration changed${widens ? " (scope widened)" : ""}: ${parsed.data.reason}`,
        { reason: parsed.data.reason, widened: widens, configKeys: Object.keys(cfg.data), tags: { from: beforeTags, to: [...new Set(parsed.data.complianceTags)].sort() } });
      return updated!;
    });
    return reply.send({ connector: await viewOf(row) });
  });

  app.put("/v1/ai-saas-monitoring/connectors/:connectorId/credential", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const connector = await loadConnector(p.data.connectorId);
    if (!connector) return reply.status(404).send({ error: "not_found" });
    const parsed = credentialBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(bad("expected { secret, replacesCredentialId: uuid | null, reason }"));
    if (resolveDeployMode() === "air_gapped") return reply.status(409).send(airGapped);
    if (!(await loadAiSaasPolicy(db)).enabled) return reply.status(409).send(policyOff);
    if (!opts.dataKey) return reply.status(503).send({ error: "data_key_unavailable" });
    if (!(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { aiSaasConnector: connector.id, values: { credential: "store" } } })).ok) return reply;
    const existing = await liveCredential(db, connector.id);
    if ((existing?.id ?? null) !== parsed.data.replacesCredentialId) {
      return reply.status(409).send({ error: "credential_conflict", detail: "replacesCredentialId must name the connector's live credential (null when it has none)", liveCredentialId: existing?.id ?? null });
    }
    const ciphertext = encryptSecret(opts.dataKey, parsed.data.secret);
    const stored = await db.transaction(async (tx) => {
      if (existing) await tx.update(aiSaasMonitorCredentials).set({ revokedAt: sql`now()`, revokedBy: actor(req), secretCiphertext: null }).where(eq(aiSaasMonitorCredentials.id, existing.id));
      const [row] = await tx.insert(aiSaasMonitorCredentials).values({ connectorId: connector.id, secretCiphertext: ciphertext, createdBy: actor(req) }).returning();
      await audit(tx, actor(req), "ai_saas_monitor_credential", row!.id, existing ? AI_SAAS_RULE_IDS.credentialReplaced : AI_SAAS_RULE_IDS.credentialStored, "allow",
        `AI SaaS monitor credential ${existing ? "replaced" : "stored"} for '${connector.name}': ${parsed.data.reason}`,
        { connectorId: connector.id, replacedCredentialId: existing?.id ?? null, reason: parsed.data.reason });
      return row!;
    });
    return reply.status(existing ? 200 : 201).send({ credential: { id: stored.id, scopePosture: stored.scopePosture, storedAt: stored.createdAt.toISOString() } });
  });

  // revoking is never harder than granting: no step-up (ADR-0361 §6)
  app.delete("/v1/ai-saas-monitoring/connectors/:connectorId/credential", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const connector = await loadConnector(p.data.connectorId);
    if (!connector) return reply.status(404).send({ error: "not_found" });
    const parsed = revokeBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(bad("expected { reason }"));
    const existing = await liveCredential(db, connector.id);
    if (!existing) return reply.status(404).send({ error: "no_live_credential" });
    await db.transaction(async (tx) => {
      await tx.update(aiSaasMonitorCredentials).set({ revokedAt: sql`now()`, revokedBy: actor(req), secretCiphertext: null }).where(eq(aiSaasMonitorCredentials.id, existing.id));
      await tx.update(aiSaasMonitorConnectors).set({ enabled: false, updatedAt: sql`now()` }).where(eq(aiSaasMonitorConnectors.id, connector.id));
      await audit(tx, actor(req), "ai_saas_monitor_credential", existing.id, AI_SAAS_RULE_IDS.credentialRevoked, "allow",
        `AI SaaS monitor credential revoked for '${connector.name}', connector disabled: ${parsed.data.reason}`, { connectorId: connector.id, reason: parsed.data.reason });
    });
    return reply.send({ revoked: existing.id });
  });

  app.put("/v1/ai-saas-monitoring/connectors/:connectorId/enabled", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const connector = await loadConnector(p.data.connectorId);
    if (!connector) return reply.status(404).send({ error: "not_found" });
    const parsed = enabledBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(bad("expected { enabled: boolean, reason: string (3-500 characters) }"));
    const { enabled } = parsed.data;
    if (enabled) {
      if (resolveDeployMode() === "air_gapped") return reply.status(409).send(airGapped);
      if (!(await loadAiSaasPolicy(db)).enabled) return reply.status(409).send(policyOff);
      if (!(opts.deps?.connectors ?? AI_SAAS_CONNECTORS).has(connector.vendor)) return reply.status(409).send({ error: "vendor_not_built" });
      const cred = await liveCredential(db, connector.id);
      if (!cred) return reply.status(409).send({ error: "no_live_credential", detail: "store a credential before enabling the connector" });
      if (cred.scopePosture === "refused") return reply.status(409).send({ error: "credential_refused", detail: "the live credential was refused because it can write; store a read-only one" });
      if (!(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { aiSaasConnector: connector.id, values: { enabled: true } } })).ok) return reply;
    }
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(aiSaasMonitorConnectors).set({ enabled, updatedAt: sql`now()` }).where(eq(aiSaasMonitorConnectors.id, connector.id)).returning();
      await audit(tx, actor(req), "ai_saas_monitor_connector", connector.id, AI_SAAS_RULE_IDS.connectorEnabledChanged, "allow",
        `AI SaaS monitor connector '${connector.name}' ${connector.enabled ? "enabled" : "disabled"} -> ${enabled ? "enabled" : "disabled"}: ${parsed.data.reason}`,
        { transition: { from: connector.enabled, to: enabled }, reason: parsed.data.reason, receiptClass: "configuration" });
      return updated!;
    });
    return reply.send({ connector: await viewOf(row) });
  });

  app.post("/v1/ai-saas-monitoring/connectors/:connectorId/runs", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const connector = await loadConnector(p.data.connectorId);
    if (!connector) return reply.status(404).send({ error: "not_found" });
    const run = await runAiSaasMonitor(db, connector.id, { trigger: "manual", dataKey: opts.dataKey, deps: opts.deps, requestedBy: actor(req) });
    const status = run.status === "succeeded" ? 200 : run.status === "refused" ? 409 : 502;
    return reply.status(status).send({ run: runView(run), statement: AI_SAAS_MONITOR_STATEMENT });
  });

  app.get("/v1/ai-saas-monitoring/connectors/:connectorId/runs", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const connector = await loadConnector(p.data.connectorId);
    if (!connector) return reply.status(404).send({ error: "not_found" });
    const q = z.object({ before: z.string().uuid().optional() }).strict().safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send(bad("expected ?before=<run id>"));
    let cursor: { startedAt: Date; id: string } | null = null;
    if (q.data.before) {
      const [c] = await db
        .select({ startedAt: aiSaasMonitorRuns.startedAt, id: aiSaasMonitorRuns.id })
        .from(aiSaasMonitorRuns)
        .where(and(eq(aiSaasMonitorRuns.id, q.data.before), eq(aiSaasMonitorRuns.connectorId, connector.id)));
      if (!c) return reply.status(400).send(bad("before must name a run of this connector"));
      cursor = c;
    }
    const runs = await db
      .select()
      .from(aiSaasMonitorRuns)
      .where(and(eq(aiSaasMonitorRuns.connectorId, connector.id), cursor ? sql`(${aiSaasMonitorRuns.startedAt}, ${aiSaasMonitorRuns.id}) < (${cursor.startedAt}, ${cursor.id})` : undefined))
      .orderBy(desc(aiSaasMonitorRuns.startedAt), desc(aiSaasMonitorRuns.id))
      .limit(RUNS_PAGE);
    return reply.send({ runs: runs.map(runView), nextBefore: runs.length === RUNS_PAGE ? runs[runs.length - 1]!.id : null });
  });

  app.get("/v1/ai-saas-monitoring/connectors/:connectorId/interactions", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const connector = await loadConnector(p.data.connectorId);
    if (!connector) return reply.status(404).send({ error: "not_found" });
    const q = z
      .object({ before: z.string().uuid().optional(), withFindings: z.enum(["true", "false"]).optional() })
      .strict()
      .safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send(bad("expected ?before=<interaction id>&withFindings=true|false"));
    let cursor: { occurredAt: Date; id: string } | null = null;
    if (q.data.before) {
      const [c] = await db
        .select({ occurredAt: aiSaasInteractions.occurredAt, id: aiSaasInteractions.id })
        .from(aiSaasInteractions)
        .where(and(eq(aiSaasInteractions.id, q.data.before), eq(aiSaasInteractions.connectorId, connector.id)));
      if (!c) return reply.status(400).send(bad("before must name an interaction of this connector"));
      cursor = c;
    }
    const rows = await db
      .select()
      .from(aiSaasInteractions)
      .where(
        and(
          eq(aiSaasInteractions.connectorId, connector.id),
          cursor ? sql`(${aiSaasInteractions.occurredAt}, ${aiSaasInteractions.id}) < (${cursor.occurredAt}, ${cursor.id})` : undefined,
          q.data.withFindings === "true"
            ? sql`EXISTS (SELECT 1 FROM ${aiSaasInteractionFindings} f WHERE f.interaction_id = ${aiSaasInteractions.id})`
            : undefined,
        ),
      )
      .orderBy(desc(aiSaasInteractions.occurredAt), desc(aiSaasInteractions.id))
      .limit(INTERACTIONS_PAGE);
    const findings = rows.length
      ? await db.select().from(aiSaasInteractionFindings).where(inArray(aiSaasInteractionFindings.interactionId, rows.map((r) => r.id)))
      : [];
    const byInteraction = new Map<string, Array<{ detector: string; category: string; hitCount: number; action: string }>>();
    for (const f of findings) {
      const list = byInteraction.get(f.interactionId) ?? [];
      list.push({ detector: f.detector, category: f.category, hitCount: f.hitCount, action: f.action });
      byInteraction.set(f.interactionId, list);
    }
    return reply.send({
      interactions: rows.map((r) => ({
        id: r.id,
        vendorInteractionId: r.vendorInteractionId,
        conversationRef: r.conversationRef,
        kind: r.kind,
        occurredAt: r.occurredAt.toISOString(),
        actorRef: r.actorRef,
        appRef: r.appRef,
        contentSha256: r.contentSha256,
        contentChars: r.contentChars,
        truncated: r.truncated,
        // the redacted copy, only when captured, and only to an admin (this route is admin-only)
        redactedContent: r.contentCiphertext && opts.dataKey ? decryptSecret(opts.dataKey, r.contentCiphertext) : null,
        findings: byInteraction.get(r.id) ?? [],
        receivedAt: r.receivedAt.toISOString(),
      })),
      nextBefore: rows.length === INTERACTIONS_PAGE ? rows[rows.length - 1]!.id : null,
    });
  });
}

/** does a configuration change read MORE than before (every user, more users, fewer app-class filters, more backfill)? */
export function configWidens(before: unknown, after: unknown): boolean {
  const b = (before ?? {}) as { users?: { mode?: string; ids?: string[] }; appClasses?: string[]; backfillDays?: number };
  const a = (after ?? {}) as typeof b;
  if (a.users?.mode === "all" && b.users?.mode !== "all") return true;
  if (a.users?.mode === "listed" && b.users?.mode === "listed") {
    const prev = new Set(b.users.ids ?? []);
    if ((a.users.ids ?? []).some((id) => !prev.has(id))) return true;
  }
  const bc = b.appClasses ?? [];
  const ac = a.appClasses ?? [];
  if (bc.length > 0 && (ac.length === 0 || ac.some((c) => !bc.includes(c)))) return true;
  if ((a.backfillDays ?? 0) > (b.backfillDays ?? 0)) return true;
  return false;
}
