/**
 * ADR-0195 SD0 — THE SCAN WORKER.
 *
 * One pass (the `discovery-scan-sweep` scheduler job, every minute):
 *
 *  1. ENQUEUE every enabled source whose schedule is due: one `queued` run per
 *     source (the partial unique index makes a second enqueue a no-op), and the
 *     source's `next_run_at` moves on by its interval. "Run now" enqueues the
 *     same way.
 *  2. FAIL every run whose lease lapsed on its last attempt (lease_expired).
 *  3. CLAIM runs one at a time (`FOR UPDATE SKIP LOCKED`): a queued run, or a
 *     running run whose lease lapsed with attempts left (REL-06: a crashed
 *     worker's run is re-taken, audited, never lost and never doubled). The
 *     lease uses the database clock (M-075).
 *  4. RUN the source's registered scanner with only the guarded fetch, the
 *     rate-limit hook, the raw-output digest, the pseudonymiser and a
 *     heartbeat. Its observations are checked (evidence and subject kinds its
 *     source kind allows, bounded sizes, key fragments cut to 8 characters),
 *     classified against this deployment's ENABLED admin catalogue (detection is
 *     data: an unmatched observation is a catalogue gap, never a finding), and
 *     merged into `shadow_ai_findings` through the same import path as an
 *     uploaded file: one `shadow_ai_imports` row per evidence kind, then
 *     `upsertFindings`. The run's completion is fenced on its lease, in the same
 *     transaction as the findings, so a worker that lost its lease writes
 *     nothing.
 *  5. RETENTION: device findings and device-user pseudonyms not seen within the
 *     endpoint evidence retention (90 days by default) are deleted, audited.
 *
 * Every outcome is audited with its source, scope, counts and outcome
 * (decision 1).
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  aiEndpointSignatures,
  and,
  auditLog,
  discoveryCredentials,
  discoveryPseudonymKeys,
  discoveryPseudonyms,
  discoveryRuns,
  discoverySources,
  eq,
  isNull,
  shadowAiImports,
  sql,
  type Db,
  type DiscoveryRunRow,
  type DiscoverySourceRow,
} from "@regulait/db";
import {
  classifyObservation,
  correlateObservations,
  DISCOVERY_KIND_SPECS,
  DISCOVERY_PSEUDONYM_PREFIX,
  DISCOVERY_RUN_MAX_ATTEMPTS,
  EVIDENCE_MAX_ROWS,
  isArtifactSignatureKind,
  redactKeyFragment,
  type AiSignature,
  type DiscoveryEvidenceKind,
  type DiscoveryPseudonymKind,
  type Observation,
} from "@regulait/shared";
import { loadEgressAllowList } from "./custom-providers.js";
import { createGuardedFetch, EgressBlockedError, EgressRedirectError, type EgressResolver } from "./egress-guard.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { upsertFindings } from "./shadow-ai.js";
import { loadDiscoverySettings } from "./discovery-posture.js";
import { DISCOVERY_SCANNERS, type ScanObservation, type ScannerRegistry, type ScanResult } from "./discovery-scanners.js";
import type { SchedulerJobDefinition } from "./scheduler.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export const DISCOVERY_SCAN_JOB_NAME = "discovery-scan-sweep";
/** how long a claimed run is held before another worker may re-take it */
export const DISCOVERY_LEASE_SECONDS = 15 * 60;
/** at most this many runs are processed per pass */
export const DISCOVERY_RUNS_PER_PASS = 5;
/** the longest a Retry-After is honoured, and how many times per run */
export const DISCOVERY_BACKOFF_MAX_MS = 60_000;
export const DISCOVERY_BACKOFF_MAX_TIMES = 5;
/** the default per-source spacing between outbound requests (about 10 per second) */
export const DISCOVERY_DEFAULT_MIN_SPACING_MS = 100;
/** bounds a scanner's observations are held to */
const SUBJECT_MAX = 512;
const VALUE_MAX = 512;
const DISPLAY_NAME_MAX = 256;
const GAPS_MAX = 50;

/**
 * THE PER-SOURCE RATE-LIMIT HOOK. `acquire` resolves when the source may send
 * its next request. The default spaces requests per source in this process;
 * a scanner that knows its provider's published limits may wrap it. No library
 * was adopted (ADR-0176): the maintained candidates are concurrency limiters
 * (`p-limit`) rather than per-key spacing, and the widely used token bucket
 * (`bottleneck`) has had no release since 2019; the hook is a few lines.
 */
export interface DiscoveryRateLimiter {
  acquire(sourceId: string, signal: AbortSignal): Promise<void>;
}

export function spacingRateLimiter(minSpacingMs = DISCOVERY_DEFAULT_MIN_SPACING_MS): DiscoveryRateLimiter {
  const nextAt = new Map<string, number>();
  return {
    async acquire(sourceId, signal) {
      const now = Date.now();
      const at = Math.max(now, nextAt.get(sourceId) ?? 0);
      nextAt.set(sourceId, at + minSpacingMs);
      const wait = at - now;
      if (wait > 0) await sleep(wait, signal);
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry-After in ms (seconds or an HTTP date), bounded; null when absent or unreadable */
export function retryAfterMs(res: Response, now = Date.now()): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw.trim());
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - now;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, DISCOVERY_BACKOFF_MAX_MS);
}

export interface DiscoveryWorkerOptions {
  dataKey?: string | undefined;
  registry?: ScannerRegistry;
  rateLimiter?: DiscoveryRateLimiter;
  /** this worker's lease owner id (default: host and pid) */
  owner?: string;
  leaseSeconds?: number;
  limit?: number;
  /** TEST SEAMS for the guarded fetch (never set in production) */
  fetchImpl?: typeof fetch;
  resolve?: EgressResolver;
}

export interface DiscoveryPassOutcome {
  enqueued: number;
  leaseExpiredFailed: number;
  claimed: number;
  succeeded: number;
  failed: number;
  leaseLost: number;
  retained: { findingsDeleted: number; pseudonymsDeleted: number };
}

const audit = (
  db: Db,
  objectType: "discovery_run" | "discovery_source" | "discovery_settings",
  objectId: string | null,
  ruleId: string,
  effect: "allow" | "deny",
  reason: string,
  detail: Record<string, unknown>,
  userId: string | null = null,
) =>
  db.insert(auditLog).values({
    userId: userId ?? NIL_UUID,
    objectType,
    objectId,
    detail: { subsystem: "shadow-ai-discovery", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });

const scopeSummary = (s: Pick<DiscoverySourceRow, "kind" | "target" | "scope">) => ({
  kind: s.kind,
  target: s.target,
  scope: s.scope,
});

// ---------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------

/** enqueue a run for every enabled source whose schedule is due; returns the queued run ids */
export async function enqueueDueDiscoveryRuns(db: Db): Promise<Array<{ runId: string; sourceId: string }>> {
  const res = await db.execute<{ id: string; source_id: string }>(sql`
    WITH due AS (
      UPDATE discovery_sources
         SET next_run_at = now() + make_interval(secs => schedule_interval_seconds)
       WHERE enabled AND (next_run_at IS NULL OR next_run_at <= now())
       RETURNING id, version, kind
    )
    INSERT INTO discovery_runs (source_id, trigger, status, source_version, kind)
    SELECT id, 'schedule', 'queued', version, kind FROM due
    ON CONFLICT (source_id) WHERE status IN ('queued', 'running') DO NOTHING
    RETURNING id, source_id`);
  for (const r of res.rows) {
    await audit(db, "discovery_run", r.id, "discovery-run-queued", "allow", "a scheduled discovery run was queued", {
      sourceId: r.source_id,
      trigger: "schedule",
    });
  }
  return res.rows.map((r) => ({ runId: r.id, sourceId: r.source_id }));
}

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

async function failExhaustedLeases(db: Db): Promise<number> {
  const res = await db.execute<{ id: string; source_id: string; attempt: number }>(sql`
    UPDATE discovery_runs
       SET status = 'failed', error_code = 'lease_expired',
           error_detail = 'the worker holding this run stopped renewing its lease on the last attempt',
           finished_at = now(), lease_owner = NULL, lease_expires_at = NULL
     WHERE status = 'running' AND lease_expires_at < now() AND attempt >= ${DISCOVERY_RUN_MAX_ATTEMPTS}
     RETURNING id, source_id, attempt`);
  for (const r of res.rows) {
    await audit(db, "discovery_run", r.id, "discovery-run-failed", "deny", `discovery run failed: its lease lapsed on attempt ${r.attempt}`, {
      sourceId: r.source_id,
      errorCode: "lease_expired",
    });
  }
  return res.rows.length;
}

/** claim the oldest claimable run, or null */
export async function claimDiscoveryRun(db: Db, owner: string, leaseSeconds = DISCOVERY_LEASE_SECONDS): Promise<DiscoveryRunRow | null> {
  const res = await db.execute<{ id: string }>(sql`
    UPDATE discovery_runs
       SET status = 'running', attempt = attempt + 1, lease_owner = ${owner},
           lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           started_at = COALESCE(started_at, now())
     WHERE id = (
       SELECT id FROM discovery_runs
        WHERE status = 'queued'
           OR (status = 'running' AND lease_expires_at < now() AND attempt < ${DISCOVERY_RUN_MAX_ATTEMPTS})
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
     RETURNING id`);
  const id = res.rows[0]?.id;
  if (!id) return null;
  const [row] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, id));
  return row ?? null;
}

/** extend a lease this owner still holds; false = lost */
async function renewLease(db: Db, runId: string, owner: string, leaseSeconds: number): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE discovery_runs SET lease_expires_at = now() + make_interval(secs => ${leaseSeconds})
     WHERE id = ${runId} AND status = 'running' AND lease_owner = ${owner}
     RETURNING id`);
  return res.rows.length === 1;
}

/** fail a run this owner holds (fenced); false when the lease was lost */
export async function failRun(db: Db, run: DiscoveryRunRow, owner: string, code: string, detail: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE discovery_runs
       SET status = 'failed', error_code = ${code}, error_detail = ${detail.slice(0, 1000)}, finished_at = now(),
           lease_owner = NULL, lease_expires_at = NULL
     WHERE id = ${run.id} AND status = 'running' AND lease_owner = ${owner}
     RETURNING id`);
  if (res.rows.length !== 1) return false;
  await audit(db, "discovery_run", run.id, "discovery-run-failed", "deny", `discovery run failed (${code}): ${detail.slice(0, 300)}`, {
    sourceId: run.sourceId,
    kind: run.kind,
    attempt: run.attempt,
    errorCode: code,
    ...extra,
  });
  return true;
}

// ---------------------------------------------------------------------------
// pseudonyms (ADR-0195 decision 20)
// ---------------------------------------------------------------------------

async function pseudonymKey(db: Db, dataKey: string): Promise<Buffer> {
  const read = async () => (await db.select().from(discoveryPseudonymKeys).limit(1))[0];
  let row = await read();
  if (!row) {
    await db
      .insert(discoveryPseudonymKeys)
      .values({ keyCiphertext: encryptSecret(dataKey, randomBytes(32).toString("hex")) })
      .onConflictDoNothing();
    row = await read();
  }
  if (!row) throw new Error("the pseudonym key could not be created");
  return Buffer.from(decryptSecret(dataKey, row.keyCiphertext), "hex");
}

/** the pseudonym of one person; stores the display name enveloped (first sight) and stamps last seen */
export async function pseudonymise(db: Db, dataKey: string, kind: DiscoveryPseudonymKind, displayName: string): Promise<string> {
  const name = displayName.trim().slice(0, DISPLAY_NAME_MAX);
  if (!name) throw new Error("a pseudonym needs a display name");
  const key = await pseudonymKey(db, dataKey);
  const pseudonym = DISCOVERY_PSEUDONYM_PREFIX + createHmac("sha256", key).update(`${kind}\u0000${name}`).digest("hex").slice(0, 24);
  await db
    .insert(discoveryPseudonyms)
    .values({ kind, pseudonym, displayNameCiphertext: encryptSecret(dataKey, name) })
    .onConflictDoUpdate({ target: discoveryPseudonyms.pseudonym, set: { lastSeenAt: sql`now()` } });
  return pseudonym;
}

// ---------------------------------------------------------------------------
// observations → findings
// ---------------------------------------------------------------------------

export class ObservationRefused extends Error {}

/** hold a scanner's observations to its source kind's contract (decision 5a, 6) */
export function checkObservations(kind: DiscoverySourceRow["kind"], observations: readonly ScanObservation[], nowIso: string): Observation[] {
  const spec = DISCOVERY_KIND_SPECS[kind];
  if (observations.length > EVIDENCE_MAX_ROWS) {
    throw new ObservationRefused(`the scanner reported ${observations.length} observations; at most ${EVIDENCE_MAX_ROWS} are accepted per run`);
  }
  return observations.map((o, i) => {
    if (!spec.evidenceKinds.includes(o.evidenceKind)) {
      throw new ObservationRefused(`observation ${i}: evidence kind '${String(o.evidenceKind)}' is not one a ${kind} source reports`);
    }
    if (!spec.subjectKinds.includes(o.subjectKind)) {
      throw new ObservationRefused(`observation ${i}: subject kind '${String(o.subjectKind)}' is not one a ${kind} source reports`);
    }
    const subject = typeof o.subject === "string" ? o.subject.trim() : "";
    if (!subject || subject.length > SUBJECT_MAX) throw new ObservationRefused(`observation ${i}: the subject must be 1 to ${SUBJECT_MAX} characters`);
    const bounded = (v: string | undefined, what: string) => {
      if (v === undefined) return null;
      if (typeof v !== "string" || v.length === 0 || v.length > VALUE_MAX) throw new ObservationRefused(`observation ${i}: ${what} must be 1 to ${VALUE_MAX} characters`);
      return v;
    };
    let artifact: Observation["artifact"] = null;
    if (o.artifact !== undefined) {
      if (!isArtifactSignatureKind(o.artifact.kind)) throw new ObservationRefused(`observation ${i}: '${String(o.artifact.kind)}' is not an artifact kind`);
      artifact = { kind: o.artifact.kind, value: bounded(o.artifact.value, "the artifact value")! };
    }
    const observedAt = o.observedAt && Number.isFinite(Date.parse(o.observedAt)) ? new Date(o.observedAt).toISOString() : nowIso;
    const count = Number.isInteger(o.count) && (o.count as number) > 0 ? Math.min(o.count as number, 1_000_000_000) : 1;
    return {
      subjectKind: o.subjectKind,
      subject,
      signalSource: o.evidenceKind,
      observedAt,
      count,
      host: bounded(o.host, "the host"),
      packageName: bounded(o.packageName, "the package name"),
      // decision 6: a key is never kept beyond its 8-character prefix, whatever the scanner sent
      keyFragment: o.keyFragment ? redactKeyFragment(o.keyFragment) : null,
      keyLength: o.keyFragment && Number.isInteger(o.keyLength) ? (o.keyLength as number) : null,
      artifact,
    };
  });
}

/** an unmatched observation as a catalogue gap: never a key fragment */
function gapOf(o: Observation): { kind: string; value: string } | null {
  if (o.artifact) return { kind: o.artifact.kind, value: o.artifact.value };
  if (o.host) return { kind: "hostname", value: o.host };
  if (o.packageName) return { kind: "sdk_package", value: o.packageName };
  return null;
}

export const loadEnabledCatalogue = async (db: Db): Promise<AiSignature[]> =>
  (await db.select().from(aiEndpointSignatures).where(eq(aiEndpointSignatures.enabled, true))).map((r) => ({
    provider: r.provider,
    kind: r.kind,
    value: r.value,
    matchType: r.matchType,
    minLength: r.minLength,
    replacementAgentId: r.replacementAgentId,
    replacementNote: r.replacementNote,
    provenance: r.provenance,
    enabled: r.enabled,
  }));

// ---------------------------------------------------------------------------
// one run
// ---------------------------------------------------------------------------

export type RunVerdict = "succeeded" | "failed" | "lease_lost";

async function processRun(db: Db, run: DiscoveryRunRow, owner: string, opts: Required<Pick<DiscoveryWorkerOptions, "registry" | "rateLimiter" | "leaseSeconds">> & DiscoveryWorkerOptions): Promise<RunVerdict> {
  const fail = async (code: string, detail: string, extra: Record<string, unknown> = {}): Promise<RunVerdict> =>
    (await failRun(db, run, owner, code, detail, extra)) ? "failed" : "lease_lost";

  if (run.attempt > 1) {
    await audit(db, "discovery_run", run.id, "discovery-run-lease-retaken", "allow", `discovery run re-taken on attempt ${run.attempt} after its lease lapsed`, {
      sourceId: run.sourceId,
      attempt: run.attempt,
    });
  }
  const [source] = await db.select().from(discoverySources).where(eq(discoverySources.id, run.sourceId));
  if (!source) return fail("source_missing", "the source was deleted");
  if (!source.enabled) return fail("source_disabled", "the source was disabled before the run started");
  const scanner = opts.registry.get(source.kind);
  if (!scanner) return fail("scanner_not_built", `no scanner is built for ${source.kind} yet (ADR-0195 ${DISCOVERY_KIND_SPECS[source.kind].slice})`);

  const [cred] = await db
    .select()
    .from(discoveryCredentials)
    .where(and(eq(discoveryCredentials.sourceId, source.id), isNull(discoveryCredentials.revokedAt)));
  if (scanner.requiresCredential && !cred) return fail("credential_missing", "this source has no live credential");
  let secret: string | null = null;
  if (cred?.secretCiphertext) {
    if (!opts.dataKey) return fail("data_key_unavailable", "the data key is not configured, so the credential cannot be read");
    try {
      secret = decryptSecret(opts.dataKey, cred.secretCiphertext);
    } catch {
      return fail("credential_unreadable", "the credential does not decrypt under the current data key");
    }
  }

  const hash = createHash("sha256");
  let rawSeen = false;
  const deadline = AbortSignal.timeout(opts.leaseSeconds * 1000);
  const guarded = createGuardedFetch({
    allowList: await loadEgressAllowList(db),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.resolve ? { resolve: opts.resolve } : {}),
  });
  let backoffs = 0;
  let result: ScanResult;
  try {
    result = await scanner.run({
      source: {
        id: source.id,
        name: source.name,
        kind: source.kind,
        target: Object.fromEntries(Object.entries(source.target).map(([k, v]) => [k, String(v)])),
        scope: { orgLevel: source.scope.orgLevel === true, include: [...(source.scope.include ?? [])] },
      },
      credential: cred ? { mode: cred.credentialMode, publicConfig: { ...cred.publicConfig }, secret } : null,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        guarded(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline })) as typeof fetch,
      throttle: () => opts.rateLimiter.acquire(source.id, deadline),
      backoff: async (res) => {
        if (res.status !== 429 && res.status !== 503) return false;
        if (backoffs >= DISCOVERY_BACKOFF_MAX_TIMES) return false;
        backoffs += 1;
        await sleep(retryAfterMs(res) ?? Math.min(1000 * 2 ** backoffs, DISCOVERY_BACKOFF_MAX_MS), deadline);
        return true;
      },
      recordRaw: (chunk) => {
        rawSeen = true;
        hash.update(chunk);
      },
      pseudonymise: async (kind, displayName) => {
        if (!opts.dataKey) throw new Error("the data key is not configured, so a display name cannot be pseudonymised");
        return pseudonymise(db, opts.dataKey, kind, displayName);
      },
      heartbeat: () => renewLease(db, run.id, owner, opts.leaseSeconds),
      signal: deadline,
    });
  } catch (err) {
    if (err instanceof EgressBlockedError || err instanceof EgressRedirectError) return fail("egress_blocked", err.message);
    if (deadline.aborted) return fail("timed_out", `the scan did not finish within its ${opts.leaseSeconds} s lease`);
    // a scanner's error text is bounded and kept as a record; it must never carry a secret (scanner contract)
    return fail("scanner_error", err instanceof Error ? err.message : String(err));
  }

  if (result.credentialWriteScope === "write") {
    return fail("credential_has_write_scope", "the credential grants write access; a discovery credential must be read-only (ADR-0195 decision 7). Replace it.");
  }
  if (result.credentialWriteScope === "read_only" && cred && cred.writeScope !== "read_only") {
    await db.update(discoveryCredentials).set({ writeScope: "read_only" }).where(eq(discoveryCredentials.id, cred.id));
  }

  const nowIso = new Date().toISOString();
  let observations: Observation[];
  try {
    observations = checkObservations(source.kind, result.observations ?? [], nowIso);
  } catch (err) {
    if (err instanceof ObservationRefused) return fail("observation_refused", err.message);
    throw err;
  }
  const digest = rawSeen ? hash.digest("hex") : createHash("sha256").update(JSON.stringify(observations)).digest("hex");
  return applyDiscoveryRunObservations(db, run, owner, source, observations, digest);
}

/**
 * ADR-0195: classify a run's CHECKED observations against the enabled admin
 * catalogue and commit the findings with the run's completion, fenced on the
 * run's lease. Shared by the scan worker and by SD3's endpoint upload route
 * (which holds the lease of the run it opened for the upload).
 */
export async function applyDiscoveryRunObservations(
  db: Db,
  run: DiscoveryRunRow,
  owner: string,
  source: DiscoverySourceRow,
  observations: Observation[],
  digest: string,
): Promise<RunVerdict> {
  const catalogue = await loadEnabledCatalogue(db);
  const pairs = observations.map((observation) => ({ observation, classification: classifyObservation(observation, catalogue) }));
  const matched = pairs.filter((p) => p.classification.matched);
  const gapKeys = new Set<string>();
  const gaps: Array<{ kind: string; value: string }> = [];
  for (const p of pairs) {
    if (p.classification.matched || gaps.length >= GAPS_MAX) continue;
    const g = gapOf(p.observation);
    if (!g) continue;
    const k = `${g.kind}\u0000${g.value.toLowerCase()}`;
    if (gapKeys.has(k)) continue;
    gapKeys.add(k);
    gaps.push(g);
  }
  const byEvidence = new Map<DiscoveryEvidenceKind, typeof matched>();
  for (const p of matched) {
    const k = p.observation.signalSource as DiscoveryEvidenceKind;
    byEvidence.set(k, [...(byEvidence.get(k) ?? []), p]);
  }

  // the completion and the findings commit together, fenced on the lease
  const outcome = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    let created = 0;
    let updated = 0;
    const fence = await t.execute(sql`
      SELECT id FROM discovery_runs WHERE id = ${run.id} AND status = 'running' AND lease_owner = ${owner} FOR UPDATE`);
    if (fence.rows.length !== 1) return null;
    for (const [kind, group] of byEvidence) {
      const findings = correlateObservations(group);
      const [imp] = await t
        .insert(shadowAiImports)
        .values({
          kind,
          mode: "apply",
          status: "applied",
          source: `discovery:${source.name}`.slice(0, 200),
          payloadSha256: digest,
          rowCount: group.length,
          summary: { discoveryRunId: run.id, sourceId: source.id, observed: group.length, findings: findings.length },
          ruleId: "discovery-scan-applied",
          reason: `discovery run ${run.id} (${source.kind}): ${group.length} matched ${kind} observation(s), ${findings.length} correlated finding(s)`,
          requestedByUserId: null,
          appliedAt: new Date(),
          discoveryRunId: run.id,
        })
        .returning({ id: shadowAiImports.id });
      const r = await upsertFindings(t, findings, imp!.id);
      created += r.created;
      updated += r.updated;
    }
    await t
      .update(discoveryRuns)
      .set({
        status: "succeeded",
        finishedAt: sql`now()`,
        leaseOwner: null,
        leaseExpiresAt: null,
        observed: observations.length,
        matched: matched.length,
        findingsCreated: created,
        findingsUpdated: updated,
        catalogueGaps: gaps,
        rawOutputSha256: digest,
      })
      .where(eq(discoveryRuns.id, run.id));
    await t.update(discoverySources).set({ lastRunAt: sql`now()` }).where(eq(discoverySources.id, source.id));
    await audit(
      t,
      "discovery_run",
      run.id,
      "discovery-run-succeeded",
      "allow",
      `discovery run of '${source.name}' finished: ${observations.length} observation(s), ${matched.length} matched the catalogue, ${created} finding(s) created, ${updated} updated, ${gaps.length} catalogue gap(s)`,
      { sourceId: source.id, ...scopeSummary(source), attempt: run.attempt, observed: observations.length, matched: matched.length, created, updated, gaps: gaps.length, rawOutputSha256: digest },
    );
    return { created, updated };
  });
  return outcome ? "succeeded" : "lease_lost";
}

// ---------------------------------------------------------------------------
// retention (ADR-0195 decision 20)
// ---------------------------------------------------------------------------

export async function runEndpointRetention(db: Db): Promise<{ findingsDeleted: number; pseudonymsDeleted: number }> {
  const { endpointRetentionDays } = await loadDiscoverySettings(db);
  const findings = await db.execute(sql`
    DELETE FROM shadow_ai_findings
     WHERE subject_kind = 'device' AND last_seen_at < now() - make_interval(days => ${endpointRetentionDays})
     RETURNING id`);
  const pseudonyms = await db.execute(sql`
    DELETE FROM discovery_pseudonyms
     WHERE kind = 'device_user' AND last_seen_at < now() - make_interval(days => ${endpointRetentionDays})
     RETURNING id`);
  const out = { findingsDeleted: findings.rows.length, pseudonymsDeleted: pseudonyms.rows.length };
  if (out.findingsDeleted + out.pseudonymsDeleted > 0) {
    await audit(db, "discovery_settings", null, "discovery-endpoint-retention", "allow",
      `endpoint evidence past the ${endpointRetentionDays}-day retention deleted: ${out.findingsDeleted} device finding(s), ${out.pseudonymsDeleted} device-user pseudonym(s)`,
      { endpointRetentionDays, ...out });
  }
  return out;
}

// ---------------------------------------------------------------------------
// one pass
// ---------------------------------------------------------------------------

const defaultLimiter = spacingRateLimiter();

export async function runDiscoveryPass(db: Db, opts: DiscoveryWorkerOptions = {}): Promise<DiscoveryPassOutcome> {
  const owner = opts.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const full = {
    ...opts,
    registry: opts.registry ?? DISCOVERY_SCANNERS,
    rateLimiter: opts.rateLimiter ?? defaultLimiter,
    leaseSeconds: opts.leaseSeconds ?? DISCOVERY_LEASE_SECONDS,
  };
  const out: DiscoveryPassOutcome = {
    enqueued: (await enqueueDueDiscoveryRuns(db)).length,
    leaseExpiredFailed: await failExhaustedLeases(db),
    claimed: 0,
    succeeded: 0,
    failed: 0,
    leaseLost: 0,
    retained: { findingsDeleted: 0, pseudonymsDeleted: 0 },
  };
  const limit = opts.limit ?? DISCOVERY_RUNS_PER_PASS;
  for (let i = 0; i < limit; i++) {
    const run = await claimDiscoveryRun(db, owner, full.leaseSeconds);
    if (!run) break;
    out.claimed += 1;
    const verdict = await processRun(db, run, owner, full);
    if (verdict === "succeeded") out.succeeded += 1;
    else if (verdict === "failed") out.failed += 1;
    else out.leaseLost += 1;
  }
  out.retained = await runEndpointRetention(db);
  return out;
}

export function discoveryJobDefinitions(opts: { dataKey?: string | undefined } = {}): SchedulerJobDefinition[] {
  return [
    {
      name: DISCOVERY_SCAN_JOB_NAME,
      description:
        "Queue a scan for every enabled discovery source whose schedule is due, run up to 5 queued scans (leased; a " +
        "crashed worker's scan is re-taken after its lease lapses), merge matched observations into the shadow-AI " +
        "findings, and delete endpoint evidence past its retention. With no source enabled it scans nothing.",
      adr: "ADR-0195",
      defaultIntervalSeconds: 60,
      run: async (ctx) => {
        const out = await runDiscoveryPass(ctx.db, { dataKey: opts.dataKey });
        return { itemsProcessed: out.claimed, detail: { ...out } };
      },
    },
  ];
}
