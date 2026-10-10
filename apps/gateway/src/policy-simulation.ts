/**
 * ADR-0059 — the GATEWAY half of POLICY SIMULATION / BLAST-RADIUS PREVIEW.
 *
 * This is the consumer ADR-0040 promised. ADR-0040 shipped the *hook* — one
 * `POST /v1/abac/simulate` that answers "what would this decide for this one
 * (user, server, tool) right now" — and said in as many words that the full
 * policy-simulation surface is ADR-0059's. This file is that surface: given a
 * PROPOSED policy version, dry-run it against RECORDED HISTORY and report what
 * it *would have* newly denied or newly sent to approval, before activation.
 *
 * Division of labour:
 *
 *   `packages/shared/src/policy-simulation.ts`  the replay classifier, the
 *                                               fidelity analysis, the
 *                                               entitlement-scope decision and
 *                                               the blast-radius summary. Pure.
 *   `apps/gateway/src/abac.ts`                  attribute assembly — reused
 *                                               VERBATIM, never re-implemented.
 *   THIS FILE                                   selects the recorded rows,
 *                                               drives the candidate through
 *                                               the same Cedar engine
 *                                               enforcement uses, persists the
 *                                               preview, and owns the surface.
 *
 * ZERO SIDE EFFECTS, STRUCTURALLY
 *
 *   Look at the imports. There is no `executeGovernedDispatch`, no
 *   `governedEvaluate`, no provider, no approvals write, no rate-counter write,
 *   no `usage_events` write, and no update to `abac_policies`. A dry run cannot
 *   dispatch because the dispatch core is not reachable from this module —
 *   which is a property of the dependency graph, not a promise in a comment,
 *   and the test proves it with a provider spy whose invocation count must be
 *   exactly zero.
 *
 *   The ONE side effect that does exist is deliberate and disclosed: a single
 *   `audit_log` row saying a simulation ran, under which entitlement scope, over
 *   which window. A preview reads other people's traffic; who previewed whose
 *   history has to be a record (this is also why refusals audit — ADR-0047's
 *   discipline, where "who was told no" is as much the record as what was
 *   produced).
 *
 * WHY THE CANDIDATE IS EVALUATED ALONE
 *
 *   The question is "what would THIS change do", so the replay evaluates the
 *   candidate version by itself rather than the active set plus the candidate.
 *   ABAC is subtractive (ADR-0040: a Cedar `permit` is not a grant), so a call
 *   the already-active set would have blocked anyway is *recorded as blocked in
 *   the history* and therefore never counted as a new denial — the recorded
 *   effect carries that information for free, without having to reconstruct the
 *   whole historical policy set.
 *
 * WHAT REPLAY CANNOT REACH, SAID ON THE ROW
 *
 *   `audit_log` records the DECISION, not the whole decision INPUT: no call
 *   arguments, no decision-time rate counters, no session facts, and no project
 *   attribution (the project rides the pillar-5 usage ledger instead). So
 *   project attribution here is RECONSTRUCTED from `usage_events` by
 *   (user, server, tool) inside the same window — good enough to name the
 *   projects in a blast radius, and honestly flagged as best-effort whenever the
 *   candidate policy actually reads a project-derived attribute.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { CHANGED_CONCURRENTLY, relaxedAgainst, requireRelaxStepUp } from "./step-up.js";
import {
  configVersions,
  abacPolicies,
  abacPolicyVersions,
  and,
  auditLog,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  mcpTools,
  policySimulationFlips,
  policySimulationSettings,
  policySimulations,
  projects,
  sql,
  teamMembers,
  usageEvents,
  users,
  type Db,
  type PolicySimulationRow,
  type PolicySimulationSettingsRow,
} from "@regulait/db";
import { abacEngine, type AbacPolicy, type AbacRequest } from "@regulait/policy-kernel/abac";
import {
  ABAC_CANNOT_GRANT_NOTE,
  AUDIT_ADVISORY_KEY,
  POLICY_SIMULATION_DEFAULT_DEADLINE_MS,
  POLICY_SIMULATION_DEFAULT_ROW_CAP,
  POLICY_SIMULATION_DEFAULT_WINDOW_DAYS,
  REPLAY_FIDELITY_DISCLOSURE,
  UNREPLAYABLE_ATTRIBUTES,
  analyzeReplayFidelity,
  classifyReplay,
  isFlip,
  policySimulationIncompleteNote,
  policySimulationSettingsSchema,
  resolvePolicySimulationRunLimits,
  resolvePolicySimulationScope,
  startPolicySimulationSchema,
  summarizeBlastRadius,
  type CandidateEffect,
  type PolicySimulationScopeDecision,
  type RecordedEffect,
  type ReplayedDecision,
} from "@regulait/shared";
import { assembleAbacRequest, loadActiveAbacPolicies } from "./abac.js";
import { loadComplianceProfileCanaryDivergence } from "./config-versions.js";
import { governedEvaluate, type ReplayCountQuery } from "./governed-evaluate.js";
import { settingTransitions } from "./setting-transitions.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const SINGLETON = "singleton";

/** how many flipped calls are persisted as the drill-down sample */
const SAMPLE_LIMIT = 50;

/** recorded-call ids per batched count statement */
const COUNT_CHUNK_SIZE = 5_000;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function loadPolicySimulationSettings(db: Db): Promise<PolicySimulationSettingsRow> {
  const [row] = await db
    .select()
    .from(policySimulationSettings)
    .where(eq(policySimulationSettings.id, SINGLETON));
  if (row) return row;
  const [created] = await db
    .insert(policySimulationSettings)
    .values({ id: SINGLETON })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db
    .select()
    .from(policySimulationSettings)
    .where(eq(policySimulationSettings.id, SINGLETON));
  return again!;
}

/**
 * ADR-0040's honest-risks note made operable: has this EXACT version ever been
 * previewed? Called by the ABAC activate route, which records the answer on the
 * activation audit row either way and refuses only when the deployment has
 * switched the friction on.
 */
export async function versionHasBlastRadiusPreview(
  db: Db,
  policyVersionId: string,
): Promise<{ previewed: boolean; latest: PolicySimulationRow | null }> {
  const [row] = await db
    .select()
    .from(policySimulations)
    .where(eq(policySimulations.policyVersionId, policyVersionId))
    .orderBy(desc(policySimulations.createdAt))
    .limit(1);
  return { previewed: Boolean(row), latest: row ?? null };
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** every user the caller can see: their teammates, plus themselves. The SAME
 * membership relation enforcement's `loadScopeMemberships` reads, so a preview
 * can never see further than the caller's own team boundary. */
export async function visibleSubjectsFor(db: Db, callerUserId: string): Promise<string[]> {
  const teams = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, callerUserId));
  if (teams.length === 0) return [callerUserId];
  const peers = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(
      inArray(
        teamMembers.teamId,
        teams.map((t) => t.teamId),
      ),
    );
  return [...new Set([callerUserId, ...peers.map((p) => p.userId)])];
}

// ---------------------------------------------------------------------------
// The dry run
// ---------------------------------------------------------------------------

export interface PolicySimulationOptions {
  policyVersionId: string;
  windowDays: number;
  rowCap: number;
  scope: PolicySimulationScopeDecision;
  requestedByUserId: string | null;
  note?: string | null | undefined;
  /** pins the window end; tests and a future async runner supply it */
  now?: Date;
  /** AER-016: how long the replay may run before it stops (default 20 s) */
  deadlineMs?: number;
  /** AER-016: the clock the deadline is read from; tests supply one */
  clock?: () => number;
  /** ADR-0179 review, finding 1: a deadline the caller armed when the request
   * arrived. Absent, the run arms its own before its first query. */
  deadline?: RunDeadline;
}

/**
 * AER-016 — WHAT A RUN THAT HIT ITS DEADLINE RETURNS. It is not a preview:
 * it carries no buckets, no names and no stored row, only how far it got. A
 * partial blast radius would read as the whole one, and an activation gate
 * that asks "was this version ever previewed?" must not be satisfied by a run
 * that stopped halfway.
 */
export interface PolicySimulationIncomplete {
  ok: true;
  incomplete: true;
  /** recorded decisions re-decided before the deadline */
  evaluated: number;
  /** recorded decisions the run would have had to re-decide */
  total: number;
  capped: boolean;
  deadlineMs: number;
  windowStart: Date;
  windowEnd: Date;
}

export type PolicySimulationOutcome =
  | { ok: true; incomplete?: false; simulation: PolicySimulationRow; flips: number }
  | PolicySimulationIncomplete
  | { ok: false; status: number; error: string; detail?: string };

/** AER-016: a run's deadline. */
export interface RunDeadline {
  deadlineMs: number;
  /** read from the (injectable) clock between rows and between count chunks */
  passed: () => boolean;
  /** the real time left, for the database's statement_timeout; null under an
   * injected clock, whose virtual time cannot bound a real statement */
  statementTimeoutMs: () => number | null;
}

/** AER-016: the run's deadline, read from an injectable clock. The route arms
 * it when the request arrives (ADR-0179 review, finding 1), so nothing the
 * run does before its first row escapes it. */
export function runDeadline(opts: {
  deadlineMs?: number | undefined;
  clock?: (() => number) | undefined;
}): RunDeadline {
  const clock = opts.clock ?? Date.now;
  const deadlineMs = opts.deadlineMs ?? POLICY_SIMULATION_DEFAULT_DEADLINE_MS;
  const endsAt = clock() + deadlineMs;
  const wallEndsAt = Date.now() + deadlineMs;
  return {
    deadlineMs,
    passed: () => clock() >= endsAt,
    statementTimeoutMs: () =>
      opts.clock ? null : Math.max(1, Math.ceil(wallEndsAt - Date.now())),
  };
}

/** a count chunk the deadline stopped before it ran */
class SimulationDeadlineExceeded extends Error {
  constructor() {
    super("the policy simulation reached its deadline between count chunks");
    this.name = "SimulationDeadlineExceeded";
  }
}

/**
 * Did the run stop because of its deadline? Either our own between-chunk
 * check, or Postgres cancelling a statement under the run's statement_timeout
 * (SQLSTATE 57014 with the statement-timeout message; an operator's
 * pg_cancel_backend shares the code and is NOT this). The driver error may be
 * wrapped (the ORM's query error carries it as `cause`), so the chain is walked.
 */
function isSimulationTimeout(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 5; depth += 1) {
    if (e instanceof SimulationDeadlineExceeded) return true;
    const pg = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (pg.code === "57014" && typeof pg.message === "string" && /statement timeout/i.test(pg.message)) {
      return true;
    }
    e = pg.cause;
  }
  return false;
}

/**
 * ADR-0179 review, finding 1 — THE DEADLINE BOUNDS THE DATABASE TOO. A run's
 * reads happen in ONE transaction whose first statement is
 * `SET LOCAL statement_timeout` set to the time the deadline has left, so a
 * single slow statement (a lock wait, a cold scan of a large audit trail) is
 * cancelled by Postgres rather than outliving the deadline. LOCAL, and inside
 * the transaction: the setting ends with it and never leaks onto a pooled
 * connection. The transaction is not marked read-only because the helpers it
 * shares with enforcement may create their singleton settings rows on a fresh
 * install; the run itself writes nothing in it.
 */
async function inSimulationTransaction<T>(
  db: Db,
  deadline: RunDeadline,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const ms = deadline.statementTimeoutMs();
    if (ms != null) {
      // an integer we computed, never input: SET takes no bind parameters
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${Math.floor(ms)}`));
    }
    return fn(tx);
  });
}

function incompleteOutcome(
  progress: { evaluated: number; total: number; capped: boolean },
  deadline: RunDeadline,
  windowStart: Date,
  windowEnd: Date,
): PolicySimulationIncomplete {
  return {
    ok: true,
    incomplete: true,
    evaluated: progress.evaluated,
    total: progress.total,
    capped: progress.capped,
    deadlineMs: deadline.deadlineMs,
    windowStart,
    windowEnd,
  };
}

type ConfigVersionRow = typeof configVersions.$inferSelect;
type AbacPolicyVersionRow = typeof abacPolicyVersions.$inferSelect;
type AbacPolicyRow = typeof abacPolicies.$inferSelect;

/** AER-016: the incomplete run is still a read of other people's traffic, so
 * it is audited exactly like a finished one, saying how far it got. */
async function recordIncompleteRun(
  db: Db,
  args: {
    requestedByUserId: string | null;
    objectType: "abac_policy" | "restriction_rule";
    objectId: string | null;
    candidate: Record<string, unknown>;
    evaluated: number;
    total: number;
    capped: boolean;
    deadlineMs: number;
    windowDays: number;
    scope: PolicySimulationScopeDecision;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: args.requestedByUserId ?? NIL_UUID,
    objectType: args.objectType,
    objectId: args.objectId,
    detail: {
      phase: "blast-radius",
      ...args.candidate,
      status: "incomplete",
      evaluated: args.evaluated,
      total: args.total,
      capped: args.capped,
      deadlineMs: args.deadlineMs,
      windowDays: args.windowDays,
      scopeRuleId: args.scope.ruleId,
      scopeSubjects: args.scope.userIds ? args.scope.userIds.length : "org-wide",
      dryRun: true,
    },
    effect: "allow",
    ruleId: "policy-simulation-incomplete",
    ruleChain: [],
    reason: policySimulationIncompleteNote({
      evaluated: args.evaluated,
      total: args.total,
      deadlineMs: args.deadlineMs,
    }),
  });
}

/**
 * AER-014 — THE AUDIT TRAIL'S LOOKBACK HORIZON: the newest cutoff any
 * retention prune has applied (`runAuditPruneOnce` records it on its own meta
 * row). Rows older than it may have been deleted, so a replayed rate-limit
 * window that reaches back past it cannot be counted and is indeterminate.
 * Null = the trail has never been pruned, so every window is complete.
 *
 * Every prune counts, including one that deleted nothing: taking the newest
 * cutoff is the conservative reading — it can only make more replayed rows
 * indeterminate, never fewer.
 */
export async function loadAuditLookbackHorizon(db: Db): Promise<Date | null> {
  const [row] = await db
    .select({ cutoff: sql<string | Date | null>`max((${auditLog.detail} ->> 'cutoff')::timestamptz)` })
    .from(auditLog)
    .where(eq(auditLog.ruleId, "audit-log-pruned"));
  return row?.cutoff ? new Date(row.cutoff) : null;
}

/**
 * AER-016 — ONE QUERY PER LIMIT SHAPE, NOT ONE PER RECORDED CALL. For every
 * recorded decision in `auditLogIds`, how many allowed, non-advisory calls its
 * user made in the `windowSeconds` STRICTLY BEFORE it — the predicate
 * `governedEvaluate`'s `countFor` applies, evaluated against each recorded
 * row's own stored timestamp (microsecond precision, so a call never counts
 * itself and an earlier call in the same millisecond still does).
 */
async function batchedAllowCounts(
  db: Db,
  auditLogIds: readonly string[],
  spec: { serverId: string | null; toolName: string | null; windowSeconds: number },
  bounds: { deadline?: RunDeadline; chunkSize?: number | undefined } = {},
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const size = bounds.chunkSize ?? COUNT_CHUNK_SIZE;
  // one bound array parameter per statement, chunked so each stays modest
  for (let i = 0; i < auditLogIds.length; i += size) {
    // ADR-0179 review, finding 1: a busy subject's counts can be many chunks,
    // so the deadline is checked BETWEEN them (each chunk is itself bounded by
    // the transaction's statement_timeout)
    if (i > 0 && bounds.deadline?.passed()) throw new SimulationDeadlineExceeded();
    const chunk = auditLogIds.slice(i, i + size);
    const res = await db.execute(sql`
      SELECT r.id::text AS id, (
        SELECT count(*)::int FROM audit_log a
        WHERE a.user_id = r.user_id
          AND a.effect = 'allow'
          AND a.at >= r.at - (${spec.windowSeconds}::int * interval '1 second')
          AND a.at < r.at
          AND (a.detail ->> ${AUDIT_ADVISORY_KEY}) IS DISTINCT FROM 'true'
          ${spec.serverId ? sql`AND a.server_id = ${spec.serverId}` : sql``}
          ${spec.toolName ? sql`AND a.tool_name = ${spec.toolName}` : sql``}
      ) AS n
      FROM audit_log r
      WHERE r.id = ANY(${`{${chunk.join(",")}}`}::uuid[])
    `);
    for (const row of res.rows as Array<{ id: string; n: number | string }>) {
      out.set(row.id, Number(row.n));
    }
  }
  return out;
}

/**
 * ADR-0179 review, finding 8 — THE REPLAY COUNTER FOR ONE RECORDED ROW, for a
 * caller replaying a single decision through `governedEvaluate`. It runs the
 * same statement as the batched replay, so the two can never disagree (the
 * window ends at the row's STORED timestamp, not at a millisecond JS Date).
 */
export function replayCounterFor(
  db: Db,
  auditLogId: string,
): (q: ReplayCountQuery) => Promise<number> {
  return async (q) => (await batchedAllowCounts(db, [auditLogId], q)).get(auditLogId) ?? 0;
}

function candidateEffectOf(decision: { effect: string }): CandidateEffect {
  if (decision.effect === "forbid") return "forbid";
  if (decision.effect === "require_approval") return "require_approval";
  return "permit";
}

/**
 * RUN THE DRY RUN. Reads recorded decisions, re-decides each under the
 * candidate version alone, folds them into a named blast radius, and writes the
 * preview plus one audit row. It executes NOTHING.
 */
/**
 * THE RECORDED TRANSCRIPT — every governed MCP tool decision in the window that
 * names a server and a tool. Shared by both candidate kinds (ADR-0120) so the
 * two previews are always reading the SAME evidence; a candidate that appeared
 * to flip fewer calls because it replayed a different transcript would be worse
 * than no preview at all.
 */
export interface ReplayTranscriptRow {
  id: string;
  at: Date;
  userId: string;
  serverId: string | null;
  toolName: string | null;
  effect: string;
}

export async function loadReplayTranscript(
  db: Db,
  args: { windowStart: Date; now: Date; rowCap: number; scoped: string[] | null },
): Promise<{ capped: boolean; considered: ReplayTranscriptRow[] }> {
  const rows = await db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      userId: auditLog.userId,
      serverId: auditLog.serverId,
      toolName: auditLog.toolName,
      effect: auditLog.effect,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.objectType, "mcp_tool"),
        isNotNull(auditLog.serverId),
        isNotNull(auditLog.toolName),
        gte(auditLog.at, args.windowStart),
        lte(auditLog.at, args.now),
        args.scoped ? inArray(auditLog.userId, args.scoped) : undefined,
      ),
    )
    .orderBy(desc(auditLog.at))
    .limit(args.rowCap + 1);
  const capped = rows.length > args.rowCap;
  return { capped, considered: capped ? rows.slice(0, args.rowCap) : rows };
}

export interface RuleSimulationOptions {
  /** a `config_versions` row id — the proposed approval rule or rate limit */
  ruleVersionId: string;
  windowDays: number;
  rowCap: number;
  scope: PolicySimulationScopeDecision;
  requestedByUserId: string | null;
  note?: string | null | undefined;
  now?: Date;
  /** AER-016: how long the replay may run before it stops (default 20 s) */
  deadlineMs?: number;
  /** AER-016: the clock the deadline is read from; tests supply one */
  clock?: () => number;
  /** see `PolicySimulationOptions.deadline` */
  deadline?: RunDeadline;
  /** recorded-call ids per batched count statement (default 5,000). A test
   * seam: lowering it is how the between-chunk deadline check is exercised
   * without writing 5,000 rows. */
  countChunkSize?: number;
}

/** Decision.effect (the kernel's vocabulary) -> the replay vocabulary. */
function candidateEffectOfDecision(effect: string): CandidateEffect {
  if (effect === "deny") return "forbid";
  if (effect === "require_approval") return "require_approval";
  return "permit";
}

/**
 * ADR-0120 — THE DRY RUN FOR A PROPOSED APPROVAL RULE OR RATE LIMIT.
 *
 * Same transcript, same blast-radius vocabulary and same storage as the ABAC
 * preview; the only difference is WHAT is re-decided. Each recorded decision is
 * replayed through `governedEvaluate` in `simulate` mode, which forces the named
 * version as the candidate and returns what it would have decided — so the
 * preview is computed by the gate itself rather than by a copy of it.
 *
 * `data_scope_rule` is REFUSED rather than approximated: evaluating one needs
 * the call's arguments, and the MCP decision transcript records counts only by
 * design (§8.4). A number produced without the inputs is a guess, and a guess on
 * a compliance surface is worse than an honest refusal.
 */
export async function runRuleSimulation(
  db: Db,
  opts: RuleSimulationOptions,
): Promise<PolicySimulationOutcome> {
  // ADR-0179 review, finding 1: the deadline is armed BEFORE the first query,
  // so the version lookup, the transcript read and the lookback horizon all
  // count against it, and the whole read runs in one transaction whose
  // statement_timeout is the time left (`inSimulationTransaction`).
  const deadline = opts.deadline ?? runDeadline(opts);
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - opts.windowDays * 24 * 60 * 60 * 1000);
  const scoped = opts.scope.userIds;
  const progress = {
    evaluated: 0,
    total: 0,
    capped: false,
    version: null as ConfigVersionRow | null,
  };

  let read:
    | {
        version: ConfigVersionRow & { artifactType: "approval_rule" | "rate_limit" };
        capped: boolean;
        considered: ReplayTranscriptRow[];
        verdicts: Map<string, { candidate: CandidateEffect; ruleId: string | null }>;
        userLabel: Map<string, string>;
      }
    | { refused: PolicySimulationOutcome }
    | "timeout";
  try {
    read = await inSimulationTransaction(db, deadline, async (tx) => {
      const [version] = await tx
        .select()
        .from(configVersions)
        .where(eq(configVersions.id, opts.ruleVersionId));
      if (!version) {
        return { refused: { ok: false, status: 404, error: "unknown_rule_version" } as const };
      }
      if (version.artifactType !== "approval_rule" && version.artifactType !== "rate_limit") {
        return {
          refused: {
            ok: false,
            status: 422,
            error: "artifact_not_simulable",
            detail:
              `'${version.artifactType}' cannot be replayed against the recorded transcript. A data-scope ` +
              `rule is evaluated against the call's ARGUMENTS, and governed tool decisions record counts ` +
              `only — never the arguments themselves — so any answer here would be a guess rather than a ` +
              `preview. Nothing was simulated and nothing was stored.`,
          } as const,
        };
      }
      progress.version = version;

      if (scoped && scoped.length === 0) {
        return { refused: { ok: false, status: 403, error: "empty_simulation_scope" } as const };
      }

      const { capped, considered } = await loadReplayTranscript(tx, {
        windowStart,
        now,
        rowCap: opts.rowCap,
        scoped,
      });
      progress.total = considered.length;
      progress.capped = capped;

      const subjectIds = [...new Set(considered.map((r) => r.userId))];
      const userRows = subjectIds.length
        ? await tx
            .select({ id: users.id, email: users.email, displayName: users.displayName })
            .from(users)
            .where(inArray(users.id, subjectIds))
        : [];
      const userLabel = new Map(userRows.map((u) => [u.id, u.displayName || u.email]));

      const serverIds = [...new Set(considered.map((r) => r.serverId!).filter(Boolean))];
      const toolRows = serverIds.length
        ? await tx
            .select({ serverId: mcpTools.serverId, name: mcpTools.name, kind: mcpTools.kind })
            .from(mcpTools)
            .where(inArray(mcpTools.serverId, serverIds))
        : [];
      const toolKind = new Map(toolRows.map((t) => [`${t.serverId}|${t.name}`, t.kind]));

      // AER-014 — the replay clock's other half: how far back the audit trail is
      // still complete. Read once per run, not once per row (an index scan of
      // the prune markers since migration 0154).
      const lookbackHorizon = await loadAuditLookbackHorizon(tx);

      // AER-016 — BATCHED REPLAY. Each recorded call is re-decided AT ITS OWN
      // INSTANT (AER-014), so rate-limit counts differ row by row and the
      // evaluation cannot simply be cached per (user, server, tool). What CAN be
      // shared is everything else: within one (user, server, tool) group, two rows
      // whose limits see the same counts get the same decision, because the
      // evaluation is a function of the stored rules and those counts.
      //
      //  - counts are fetched ONE QUERY PER LIMIT SHAPE for the whole group
      //    (`batchedAllowCounts`), the first time an evaluation asks for that shape;
      //  - a row is evaluated only when its count signature is new to its group.
      //    A count at or above the highest ceiling that READS it is one value (the
      //    kernel only compares a count with its own limit's `maxCalls`; ABAC's
      //    usage percentage caps at 100), so a busy subject needs at most
      //    `ceiling + 1` evaluations per shape, not one per recorded call;
      //  - the signature also carries whether each shape's window is truncated by
      //    audit retention, because that alone turns a row indeterminate.
      type Shape = {
        key: string;
        serverId: string | null;
        toolName: string | null;
        windowSeconds: number;
        /** the highest ceiling any decision that matters compares this count with */
        ceiling: number;
      };
      // WHICH CEILINGS READ A COUNT. Only the CANDIDATE decision is kept, so the
      // served version of the limit under test reads its count only through ABAC's
      // usage percentage — and only when an active ABAC policy reads that
      // attribute at all (the same source test `analyzeReplayFidelity` applies).
      // Its served ceiling is otherwise irrelevant, and saturating at the
      // candidate's ceiling is what lets "tighten 1000/h to 1/h" replay in two
      // evaluations, not 1001.
      const abacReadsUsage = (await loadActiveAbacPolicies(tx)).some((p) =>
        p.source.includes("rateLimitUsagePct"),
      );
      const candidateBody = (version.body ?? {}) as { maxCalls?: unknown };
      const ceilingFor = (q: ReplayCountQuery): number => {
        if (version.artifactType !== "rate_limit" || q.limitId !== version.artifactId) return q.maxCalls;
        const candidateMax = typeof candidateBody.maxCalls === "number" ? candidateBody.maxCalls : q.maxCalls;
        return abacReadsUsage ? Math.max(candidateMax, q.maxCalls) : candidateMax;
      };
      const groups = new Map<string, typeof considered>();
      for (const row of considered) {
        const key = `${row.userId}|${row.serverId}|${row.toolName}`;
        const g = groups.get(key);
        if (g) g.push(row);
        else groups.set(key, [row]);
      }

      const verdicts = new Map<string, { candidate: CandidateEffect; ruleId: string | null }>();
      for (const group of groups.values()) {
        const first = group[0]!;
        const serverId = first.serverId!;
        const toolName = first.toolName!;
        const kind = toolKind.get(`${serverId}|${toolName}`);
        const groupIds = group.map((r) => r.id);
        const shapes = new Map<string, Shape>();
        const counts = new Map<string, Map<string, number>>();
        const memo = new Map<string, { candidate: CandidateEffect; ruleId: string | null }>();

        const countsFor = async (shape: Shape) => {
          let m = counts.get(shape.key);
          if (!m) {
            m = await batchedAllowCounts(tx, groupIds, shape, {
              deadline,
              chunkSize: opts.countChunkSize,
            });
            counts.set(shape.key, m);
          }
          return m;
        };
        const signatureOf = (row: (typeof group)[number]): string =>
          [...shapes.values()]
            .sort((a, b) => a.key.localeCompare(b.key))
            .map((sh) => {
              const n = counts.get(sh.key)?.get(row.id) ?? 0;
              const truncated =
                lookbackHorizon != null &&
                row.at.getTime() - sh.windowSeconds * 1000 < lookbackHorizon.getTime();
              return `${sh.key}=${Math.min(n, sh.ceiling)}${truncated ? "!" : ""}`;
            })
            .join(";");

        for (const row of group) {
          if (deadline.passed()) return "timeout" as const;
          if (!kind) {
            // A tool that has left the inventory cannot have its call rebuilt, so
            // that row stays INDETERMINATE rather than being guessed at.
            verdicts.set(row.id, { candidate: null, ruleId: null });
            progress.evaluated += 1;
            continue;
          }
          const known = memo.get(signatureOf(row));
          if (known) {
            verdicts.set(row.id, known);
            progress.evaluated += 1;
            continue;
          }
          let shapesChanged = false;
          const evaluation = await governedEvaluate(
            tx,
            row.userId,
            serverId,
            { serverId, name: toolName, kind },
            undefined,
            null,
            null,
            undefined,
            {
              versionId: version.id,
              replay: {
                asOf: row.at,
                lookbackHorizon,
                countAllowed: async (q: ReplayCountQuery) => {
                  const key = `${q.serverId ?? "*"}|${q.toolName ?? "*"}|${q.windowSeconds}`;
                  const ceiling = ceilingFor(q);
                  let shape = shapes.get(key);
                  if (!shape) {
                    shape = {
                      key,
                      serverId: q.serverId,
                      toolName: q.toolName,
                      windowSeconds: q.windowSeconds,
                      ceiling,
                    };
                    shapes.set(key, shape);
                    shapesChanged = true;
                  } else if (ceiling > shape.ceiling) {
                    shape.ceiling = ceiling;
                    shapesChanged = true;
                  }
                  return (await countsFor(shape)).get(row.id) ?? 0;
                },
              },
            },
            undefined,
            undefined,
            // a replay re-decides a RECORDED call; the actor chain is not on the audit row yet (S4 stamps it)
            { actor: null }, // ADR-0188 S4 replaces
          );
          const verdict = evaluation.candidateDecision
            ? {
                candidate: candidateEffectOfDecision(evaluation.candidateDecision.effect),
                ruleId: evaluation.candidateDecision.ruleId ?? null,
              }
            : { candidate: null, ruleId: null };
          verdicts.set(row.id, verdict);
          // counted once its decision exists: a row the deadline cut off
          // mid-evaluation was not evaluated
          progress.evaluated += 1;
          // a shape seen for the first time, or a ceiling raised, invalidates the
          // signatures computed before it, so they are dropped rather than trusted
          if (shapesChanged) memo.clear();
          memo.set(signatureOf(row), verdict);
        }
      }
      const simulable = version as ConfigVersionRow & { artifactType: "approval_rule" | "rate_limit" };
      return { version: simulable, capped, considered, verdicts, userLabel };
    });
  } catch (err) {
    // a statement the deadline cancelled, or a count chunk it stopped, is the
    // same honest INCOMPLETE as a deadline seen between rows, never a 500
    if (!isSimulationTimeout(err)) throw err;
    read = "timeout";
  }

  if (read === "timeout") {
    const v = progress.version;
    await recordIncompleteRun(db, {
      requestedByUserId: opts.requestedByUserId,
      objectType: "restriction_rule",
      objectId: null,
      candidate: v
        ? { candidateArtifactType: v.artifactType, candidateVersionId: v.id }
        : { candidateVersionId: opts.ruleVersionId },
      evaluated: progress.evaluated,
      total: progress.total,
      capped: progress.capped,
      deadlineMs: deadline.deadlineMs,
      windowDays: opts.windowDays,
      scope: opts.scope,
    });
    return incompleteOutcome(progress, deadline, windowStart, now);
  }
  if ("refused" in read) return read.refused;
  const { version, capped, considered, verdicts, userLabel } = read;

  const replayed: ReplayedDecision[] = [];
  for (const row of considered) {
    const serverId = row.serverId!;
    const toolName = row.toolName!;
    const { candidate, ruleId } = verdicts.get(row.id) ?? { candidate: null, ruleId: null };
    replayed.push({
      auditLogId: row.id,
      userId: row.userId,
      userLabel: userLabel.get(row.userId) ?? null,
      projectId: null,
      projectName: null,
      serverId,
      toolName,
      recorded: row.effect as RecordedEffect,
      candidate,
      bucket: classifyReplay({ recorded: row.effect as RecordedEffect, candidate }),
      // policy_id is an abac_policies reference and NOTHING else. A rule
      // candidate has no policy, and the kernel's rule id is not a uuid in
      // general — writing it here is what made this path 500 on any transcript
      // containing a decision the kernel reached without a stored row.
      policyId: null,
      decisionRuleId: ruleId,
      occurredAt: row.at.toISOString(),
    });
  }

  const radius = summarizeBlastRadius(replayed, {
    sampleLimit: SAMPLE_LIMIT,
    windowDays: opts.windowDays,
  });

  const [simulation] = await db
    .insert(policySimulations)
    .values({
      policyId: null,
      policyVersionId: null,
      candidateArtifactType: version.artifactType,
      candidateVersionId: version.id,
      policyName: `${version.artifactType} ${version.artifactId}`,
      policyVersion: version.version,
      requestedByUserId: opts.requestedByUserId,
      scopeUserIds: opts.scope.userIds,
      scopeRuleId: opts.scope.ruleId,
      windowDays: opts.windowDays,
      windowStart,
      windowEnd: now,
      rowCap: opts.rowCap,
      capped,
      considered: radius.considered,
      newlyDenied: radius.buckets.newly_denied,
      newlyApprovalRequired: radius.buckets.newly_approval_required,
      newlyAllowed: radius.buckets.newly_allowed,
      unchanged: radius.buckets.unchanged,
      indeterminate: radius.buckets.indeterminate,
      affectedUsers: radius.affectedUsers.length,
      affectedProjects: radius.affectedProjects.length,
      affectedTools: radius.affectedTools.length,
      blastRadius: {
        buckets: radius.buckets,
        affectedUsers: radius.affectedUsers,
        affectedProjects: radius.affectedProjects,
        affectedTools: radius.affectedTools,
        samples: radius.samples,
      },
      headline: radius.headline,
      note: opts.note ?? null,
    })
    .returning();

  // The sampled flips — "which calls, exactly" must be answerable for a rule
  // candidate for the same reason it is for an ABAC one.
  const samples = replayed.filter((r) => isFlip(r.bucket)).slice(0, SAMPLE_LIMIT);
  if (samples.length > 0) {
    await db.insert(policySimulationFlips).values(
      samples.map((sm) => ({
        simulationId: simulation!.id,
        auditLogId: sm.auditLogId,
        userId: sm.userId,
        userLabel: sm.userLabel ?? null,
        projectId: null,
        projectName: null,
        serverId: sm.serverId,
        toolName: sm.toolName,
        recordedEffect: sm.recorded,
        simulatedEffect: sm.candidate ?? "indeterminate",
        bucket: sm.bucket,
        policyId: sm.policyId ?? null,
        decisionRuleId: sm.decisionRuleId ?? null,
        occurredAt: new Date(sm.occurredAt),
      })),
    );
  }

  await db.insert(auditLog).values({
    userId: opts.requestedByUserId ?? "00000000-0000-0000-0000-000000000000",
    // ADR-0027's existing vocabulary: an approval rule and a rate limit are
    // both pillar-1 RESTRICTION RULES, so no new objectType is minted for a
    // preview of one. The ABAC preview audits as `abac_policy` for the same
    // reason — the candidate's own kind, not the simulation machinery's.
    objectType: "restriction_rule",
    objectId: simulation!.id,
    detail: {
      candidateArtifactType: version.artifactType,
      candidateVersionId: version.id,
      considered: radius.considered,
      buckets: radius.buckets,
      windowDays: opts.windowDays,
      capped,
    },
    effect: "allow",
    ruleId: "policy-simulation-run",
    ruleChain: [],
    reason:
      `dry run of ${version.artifactType} version ${version.version}: ` +
      `${radius.considered} recorded decisions replayed, ` +
      `${radius.buckets.newly_denied} newly denied, ` +
      `${radius.buckets.newly_approval_required} newly requiring approval, ` +
      `${radius.buckets.newly_allowed} newly allowed. Nothing was executed.`,
  });

  const flips =
    radius.buckets.newly_denied +
    radius.buckets.newly_approval_required +
    radius.buckets.newly_allowed;
  return { ok: true, simulation: simulation!, flips };
}

export async function runPolicySimulation(
  db: Db,
  opts: PolicySimulationOptions,
): Promise<PolicySimulationOutcome> {
  // ADR-0179 review, finding 1: armed before the first query, and every read
  // below runs in one transaction under a statement_timeout of the time left,
  // exactly as the rule replay does.
  const deadline = opts.deadline ?? runDeadline(opts);
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - opts.windowDays * 24 * 60 * 60 * 1000);
  const scoped = opts.scope.userIds;
  const progress = {
    evaluated: 0,
    total: 0,
    capped: false,
    candidate: null as { policyId: string | null; policyVersionId: string; policyVersion: number } | null,
  };

  let read:
    | {
        version: AbacPolicyVersionRow;
        policy: AbacPolicyRow | undefined;
        candidate: AbacPolicy;
        fidelity: ReturnType<typeof analyzeReplayFidelity>;
        capped: boolean;
        replayed: ReplayedDecision[];
      }
    | { refused: PolicySimulationOutcome }
    | "timeout";
  try {
    read = await inSimulationTransaction(db, deadline, async (tx) => {
      const [version] = await tx
        .select()
        .from(abacPolicyVersions)
        .where(eq(abacPolicyVersions.id, opts.policyVersionId));
      if (!version) {
        return { refused: { ok: false, status: 404, error: "unknown_policy_version" } as const };
      }
      const [policy] = await tx
        .select()
        .from(abacPolicies)
        .where(eq(abacPolicies.id, version.policyId));
      progress.candidate = {
        policyId: policy?.id ?? null,
        policyVersionId: version.id,
        policyVersion: version.version,
      };

      // THE CANDIDATE. Assembled in memory from the immutable version row and never
      // written anywhere — `abac_policies.active_version_id` is not touched by any
      // code path in this file.
      const candidate: AbacPolicy = {
        id: version.policyId,
        name: policy?.name ?? "candidate",
        source: version.source,
        mode: version.mode,
        timezone: version.timezone,
        schemaVersion: version.schemaVersion,
        version: version.version,
        approverUserId: version.approverUserId,
        description: policy?.description ?? null,
      };
      const fidelity = analyzeReplayFidelity(version.source);

      // The recorded transcript: every governed MCP tool DECISION in the window
      // that names a server and a tool. `audit_log` is append-only and FK-free by
      // design, which is exactly what makes it replayable — and what makes this
      // tool work unchanged in an air-gapped install (§8.5): it reads only local
      // rows, with no dependency on a hosted control plane.
      if (scoped && scoped.length === 0) {
        return { refused: { ok: false, status: 403, error: "empty_simulation_scope" } as const };
      }
      const { capped, considered } = await loadReplayTranscript(tx, {
        windowStart,
        now,
        rowCap: opts.rowCap,
        scoped,
      });
      progress.total = considered.length;
      progress.capped = capped;

      // Names for the blast radius. A preview that reports opaque uuids is not a
      // preview anyone can act on.
      const subjectIds = [...new Set(considered.map((r) => r.userId))];
      const userRows = subjectIds.length
        ? await tx
            .select({ id: users.id, email: users.email, displayName: users.displayName })
            .from(users)
            .where(inArray(users.id, subjectIds))
        : [];
      const userLabel = new Map(userRows.map((u) => [u.id, u.displayName || u.email]));

      // PROJECT ATTRIBUTION IS RECONSTRUCTED, NOT RECORDED. `audit_log` carries no
      // project column (its FK-free, deletion-surviving shape is deliberate — see
      // schema.ts), so the pillar-5 usage ledger is what knows which project paid
      // for a call. Keyed by (user, server, tool) inside the same window, which is
      // exact whenever a user drives one tool from one project and best-effort
      // otherwise — flagged by `analyzeReplayFidelity` if the candidate actually
      // reads a project-derived attribute.
      const usage = await tx
        .select({
          userId: usageEvents.userId,
          projectId: usageEvents.projectId,
          operation: usageEvents.operation,
          serverId: sql<string | null>`${usageEvents.detail} ->> 'serverId'`,
          n: sql<number>`count(*)::int`,
        })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.objectType, "mcp_tool"),
            gte(usageEvents.at, windowStart),
            lte(usageEvents.at, now),
            isNotNull(usageEvents.projectId),
            scoped ? inArray(usageEvents.userId, scoped) : undefined,
          ),
        )
        .groupBy(usageEvents.userId, usageEvents.projectId, usageEvents.operation, sql`${usageEvents.detail} ->> 'serverId'`);
      const projectByCall = new Map<string, { projectId: string; n: number }>();
      for (const u of usage) {
        if (!u.projectId || !u.serverId || !u.operation) continue;
        const key = `${u.userId}|${u.serverId}|${u.operation}`;
        const prev = projectByCall.get(key);
        if (!prev || u.n > prev.n) projectByCall.set(key, { projectId: u.projectId, n: u.n });
      }
      const projectIds = [...new Set([...projectByCall.values()].map((v) => v.projectId))];
      const projectRows = projectIds.length
        ? await tx
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(inArray(projects.id, projectIds))
        : [];
      const projectName = new Map(projectRows.map((p) => [p.id, p.name]));

      // tool kinds, loaded once — a tool that has left the inventory cannot have
      // its resource bag rebuilt, and that row is INDETERMINATE rather than guessed
      const serverIds = [...new Set(considered.map((r) => r.serverId!).filter(Boolean))];
      const toolRows = serverIds.length
        ? await tx
            .select({ serverId: mcpTools.serverId, name: mcpTools.name, kind: mcpTools.kind })
            .from(mcpTools)
            .where(inArray(mcpTools.serverId, serverIds))
        : [];
      const toolKind = new Map(toolRows.map((t) => [`${t.serverId}|${t.name}`, t.kind]));

      // ATTRIBUTE ASSEMBLY IS REUSED, NOT RE-IMPLEMENTED. `assembleAbacRequest` is
      // the very function enforcement calls — ADR-0024's discipline, so a preview
      // can never drift from what the gate actually does. Memoized per distinct
      // (user, server, tool, project) because replay repeats heavily and the
      // assembly is several queries.
      const requestCache = new Map<string, AbacRequest | null>();
      async function requestFor(
        userId: string,
        serverId: string,
        toolName: string,
        projectId: string | null,
      ): Promise<AbacRequest | null> {
        const key = `${userId}|${serverId}|${toolName}|${projectId ?? ""}`;
        if (requestCache.has(key)) return requestCache.get(key)!;
        const kind = toolKind.get(`${serverId}|${toolName}`);
        if (!kind) {
          requestCache.set(key, null);
          return null;
        }
        const req = await assembleAbacRequest(tx, {
          userId,
          serverId,
          toolName,
          toolKind: kind,
          projectId,
        });
        requestCache.set(key, req);
        return req;
      }

      // AER-016 — the same deadline as a rule replay. This loop is already
      // batched (attribute assembly is memoized per distinct call shape and the
      // Cedar evaluation is in memory), but a 20k-row transcript is still bounded.
      const replayed: ReplayedDecision[] = [];
      for (const row of considered) {
        if (deadline.passed()) return "timeout" as const;
        const serverId = row.serverId!;
        const toolName = row.toolName!;
        const attributed = projectByCall.get(`${row.userId}|${serverId}|${toolName}`) ?? null;
        const projectId = attributed?.projectId ?? null;
        const base = await requestFor(row.userId, serverId, toolName, projectId);
        let candidateEffect: CandidateEffect = null;
        let policyId: string | null = null;
        if (base) {
          // EVALUATED AT THE INSTANT IT HAPPENED, so a time-of-day policy is
          // replayed against the clock the call actually ran under rather than
          // against today's.
          const decision = abacEngine.evaluate([candidate], { ...base, at: row.at });
          candidateEffect = candidateEffectOf(decision);
          policyId = decision.policyId ?? null;
        }
        const bucket = classifyReplay({
          recorded: row.effect as RecordedEffect,
          candidate: candidateEffect,
        });
        replayed.push({
          auditLogId: row.id,
          userId: row.userId,
          userLabel: userLabel.get(row.userId) ?? null,
          projectId,
          projectName: projectId ? (projectName.get(projectId) ?? null) : null,
          serverId,
          toolName,
          recorded: row.effect as RecordedEffect,
          candidate: candidateEffect,
          bucket,
          policyId,
          occurredAt: row.at.toISOString(),
        });
        progress.evaluated = replayed.length;
      }
      return { version, policy, candidate, fidelity, capped, replayed };
    });
  } catch (err) {
    if (!isSimulationTimeout(err)) throw err;
    read = "timeout";
  }

  if (read === "timeout") {
    const c = progress.candidate;
    await recordIncompleteRun(db, {
      requestedByUserId: opts.requestedByUserId,
      objectType: "abac_policy",
      objectId: c?.policyId ?? null,
      candidate: c
        ? { policyVersionId: c.policyVersionId, policyVersion: c.policyVersion }
        : { policyVersionId: opts.policyVersionId },
      evaluated: progress.evaluated,
      total: progress.total,
      capped: progress.capped,
      deadlineMs: deadline.deadlineMs,
      windowDays: opts.windowDays,
      scope: opts.scope,
    });
    return incompleteOutcome(progress, deadline, windowStart, now);
  }
  if ("refused" in read) return read.refused;
  const { version, policy, candidate, fidelity, capped, replayed } = read;

  const radius = summarizeBlastRadius(replayed, {
    sampleLimit: SAMPLE_LIMIT,
    windowDays: opts.windowDays,
  });

  const [simulation] = await db
    .insert(policySimulations)
    .values({
      policyId: policy?.id ?? null,
      policyVersionId: version.id,
      policyName: candidate.name,
      policyVersion: version.version,
      requestedByUserId: opts.requestedByUserId,
      scopeUserIds: opts.scope.userIds,
      scopeRuleId: opts.scope.ruleId,
      windowDays: opts.windowDays,
      windowStart,
      windowEnd: now,
      rowCap: opts.rowCap,
      capped,
      considered: radius.considered,
      newlyDenied: radius.buckets.newly_denied,
      newlyApprovalRequired: radius.buckets.newly_approval_required,
      newlyAllowed: radius.buckets.newly_allowed,
      unchanged: radius.buckets.unchanged,
      indeterminate: radius.buckets.indeterminate,
      affectedUsers: radius.affectedUsers.length,
      affectedProjects: radius.affectedProjects.length,
      affectedTools: radius.affectedTools.length,
      blastRadius: {
        users: radius.affectedUsers,
        projects: radius.affectedProjects,
        tools: radius.affectedTools,
      },
      fidelityExact: fidelity.exact,
      fidelityCaveats: fidelity.caveats,
      headline: radius.headline,
      note: opts.note ?? null,
    })
    .returning();

  const samples = replayed.filter((r) => isFlip(r.bucket)).slice(0, SAMPLE_LIMIT);
  if (samples.length > 0) {
    await db.insert(policySimulationFlips).values(
      samples.map((s) => ({
        simulationId: simulation!.id,
        auditLogId: s.auditLogId,
        userId: s.userId,
        userLabel: s.userLabel ?? null,
        projectId: s.projectId ?? null,
        projectName: s.projectName ?? null,
        serverId: s.serverId,
        toolName: s.toolName,
        recordedEffect: s.recorded,
        simulatedEffect: s.candidate ?? "indeterminate",
        bucket: s.bucket,
        policyId: s.policyId ?? null,
        occurredAt: new Date(s.occurredAt),
      })),
    );
  }

  // THE ONE SIDE EFFECT. A preview reads other people's traffic, so who
  // previewed whose history under which scope is a record.
  await db.insert(auditLog).values({
    userId: opts.requestedByUserId ?? NIL_UUID,
    objectType: "abac_policy",
    objectId: policy?.id ?? null,
    detail: {
      phase: "blast-radius",
      simulationId: simulation!.id,
      policyName: candidate.name,
      policyVersion: version.version,
      policyVersionId: version.id,
      scopeRuleId: opts.scope.ruleId,
      scopeSubjects: opts.scope.userIds ? opts.scope.userIds.length : "org-wide",
      windowDays: opts.windowDays,
      considered: radius.considered,
      capped,
      newlyDenied: radius.buckets.newly_denied,
      newlyApprovalRequired: radius.buckets.newly_approval_required,
      indeterminate: radius.buckets.indeterminate,
      affectedUsers: radius.affectedUsers.length,
      fidelityExact: fidelity.exact,
      dryRun: true,
    },
    effect: "allow",
    ruleId: "policy-simulation-run",
    ruleChain: [],
    reason:
      `DRY RUN (nothing executed, nothing activated): blast radius previewed for '${candidate.name}' ` +
      `version ${version.version} — ${radius.headline}`,
  });

  return { ok: true, simulation: simulation!, flips: samples.length };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.string().uuid() });

/**
 * B8b — ADR-0073 disclosure 8's consumer, finally wired. ADR-0059's shipped
 * preview has no artifact-level candidate slot (its amendment: "the candidate
 * is an ABAC policy version only"), so the honest close is a NAMED FIELD on
 * the preview response rather than a parallel preview surface: when a
 * compliance-profile candidate has RECORDED divergence observations, the
 * preview read-outs carry them — count, the diverged projects, both sides'
 * effects — read from the STORED observations only, never recomputed here.
 *
 * Three boundaries, each pinned by test:
 *  - no profile candidate, or none with recorded divergence → the field is
 *    ABSENT and the response is byte-identical to pre-B8b;
 *  - ADMIN-ONLY: profile divergence names projects org-wide, while the preview
 *    itself is entitlement-scoped — a non-admin's response never gains the
 *    field, however much divergence is stored;
 *  - read-only REPORTING: the preview gains information, never enforcement —
 *    nothing here feeds the stored simulation row, the buckets, or any gate.
 */
const PROFILE_CANARY_PREVIEW_NOTE =
  "Concurrent pending compliance-profile change(s) with RECORDED divergence (ADR-0073 shadow " +
  "canary, stored history): the named projects' §8.3 cascade would change if the candidate were " +
  "promoted. Read from stored config_canary_observations — never recomputed in this path — and " +
  "reporting only: nothing here enforces, and this field is absent entirely when no " +
  "compliance-profile candidate has recorded divergence.";

async function complianceProfileCanaryField(
  db: Db,
  isAdmin: boolean,
): Promise<Record<string, unknown>> {
  if (!isAdmin) return {};
  const canaries = await loadComplianceProfileCanaryDivergence(db);
  if (canaries.length === 0) return {};
  return { complianceProfileCanaryDivergence: { canaries, note: PROFILE_CANARY_PREVIEW_NOTE } };
}

// ---------------------------------------------------------------------------
// AER-016 — concurrency bounds
// ---------------------------------------------------------------------------

/**
 * Runs in flight on THIS replica: per caller and in total. A run is a read of
 * up to 20k recorded decisions, reachable by a non-admin, so without a bound a
 * handful of callers could keep the database busy indefinitely. A caller who
 * already has a run in flight, or a replica already running its maximum, is
 * refused with 429 and a Retry-After of the deadline (no run lasts longer).
 *
 * In-process by design: the bound protects this replica's pool, and with N
 * replicas the global ceiling is N times this one. Moving the run to a
 * background job (a shared queue) is the deferred redesign ADR-0179 names.
 * A non-blocking try-acquire with a refusal is what is needed here, not a
 * queue that would hold requests open, so no queueing library fits.
 */
const inFlightByCaller = new Map<string, number>();
let inFlightGlobal = 0;

/** take a slot, or say why not. Exported for the tests that hold one. */
export function tryAcquireSimulationSlot(
  callerKey: string,
  limits: { maxPerCaller: number; maxGlobal: number },
): { ok: true; release: () => void } | { ok: false; reason: "caller_busy" | "global_busy" } {
  const mine = inFlightByCaller.get(callerKey) ?? 0;
  if (mine >= limits.maxPerCaller) return { ok: false, reason: "caller_busy" };
  if (inFlightGlobal >= limits.maxGlobal) return { ok: false, reason: "global_busy" };
  inFlightByCaller.set(callerKey, mine + 1);
  inFlightGlobal += 1;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      inFlightGlobal -= 1;
      const left = (inFlightByCaller.get(callerKey) ?? 1) - 1;
      if (left <= 0) inFlightByCaller.delete(callerKey);
      else inFlightByCaller.set(callerKey, left);
    },
  };
}

export function registerPolicySimulationRoutes(app: FastifyInstance, db: Db): void {
  const refuse = (
    actorUserId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
  ) =>
    db.insert(auditLog).values({
      userId: actorUserId ?? NIL_UUID,
      objectType: "abac_policy",
      objectId: null,
      detail: { phase: "blast-radius", refused: true, ...detail },
      effect: "deny",
      ruleId,
      ruleChain: [],
      reason,
    });

  /**
   * RUN A BLAST-RADIUS PREVIEW. Reachable by a non-admin (it is in
   * NON_ADMIN_ROUTES) and ENTITLEMENT-SCOPED inside, exactly as ADR-0047 made
   * report generation reachable-but-scoped: a team lead should be able to ask
   * "would this rule break my team", and must not be able to use the same
   * question to read another team's traffic.
   */
  app.post("/v1/policy-simulations", async (req, reply) => {
    // ADR-0179 review, finding 1: the deadline is armed when the request
    // arrives, so the scope lookup and everything after it count against it
    const limits = resolvePolicySimulationRunLimits(process.env);
    const deadline = runDeadline({ deadlineMs: limits.deadlineMs });
    const body = startPolicySimulationSchema.parse(req.body);
    const callerId = req.authCtx.userId ?? null;
    const visible = callerId ? await visibleSubjectsFor(db, callerId) : [];
    const scope = resolvePolicySimulationScope({
      isAdmin: req.authCtx.isAdmin,
      callerUserId: callerId,
      visibleUserIds: visible,
      requestedUserIds: body.userIds ?? null,
    });
    if (!scope.allowed) {
      // THE REFUSAL IS A RECORD. Repeated attempts to preview outside one's own
      // visibility are exactly the signal an operator needs.
      await refuse(callerId, scope.ruleId, scope.reason, {
        policyVersionId: body.policyVersionId ?? null,
        ruleVersionId: body.ruleVersionId ?? null,
        requestedUserIds: body.userIds?.length ?? 0,
      });
      return reply.status(403).send({ error: "simulation_scope_denied", detail: scope.reason });
    }
    // AER-016: bounded runs. The slot is taken after the scope check (a refused
    // caller holds nothing) and released however the run ends.
    const slot = tryAcquireSimulationSlot(callerId ?? "bootstrap", limits);
    if (!slot.ok) {
      return reply
        .status(429)
        .header("retry-after", String(Math.max(1, Math.ceil(limits.deadlineMs / 1000))))
        .send({
          error: "simulation_busy",
          detail:
            slot.reason === "caller_busy"
              ? `you already have ${limits.maxPerCaller} simulation run(s) in flight; wait for it to finish`
              : `this gateway is already running ${limits.maxGlobal} simulation run(s); try again shortly`,
        });
    }
    // ADR-0120: the same surface, the same scope check and the same stored
    // shape for both candidate kinds — only the re-decision differs.
    let outcome: PolicySimulationOutcome;
    try {
      outcome = body.ruleVersionId
        ? await runRuleSimulation(db, {
            ruleVersionId: body.ruleVersionId,
            windowDays: body.windowDays,
            rowCap: body.rowCap,
            scope,
            requestedByUserId: callerId,
            note: body.note ?? null,
            deadline,
          })
        : await runPolicySimulation(db, {
            policyVersionId: body.policyVersionId!,
            windowDays: body.windowDays,
            rowCap: body.rowCap,
            scope,
            requestedByUserId: callerId,
            note: body.note ?? null,
            deadline,
          });
    } finally {
      slot.release();
    }
    if (outcome.ok && outcome.incomplete) {
      // AER-016: an HONEST incomplete result. 200, not 201: nothing was
      // created. No buckets, no names, no simulation row — only how far the
      // run got, so it can never be read as a finished preview.
      return reply.status(200).send({
        status: "incomplete",
        evaluated: outcome.evaluated,
        total: outcome.total,
        capped: outcome.capped,
        deadlineMs: outcome.deadlineMs,
        windowStart: outcome.windowStart,
        windowEnd: outcome.windowEnd,
        detail: policySimulationIncompleteNote(outcome),
        scope: { ruleId: scope.ruleId, reason: scope.reason, orgWide: scope.userIds === null },
        fidelity: REPLAY_FIDELITY_DISCLOSURE,
        dryRun: true,
      });
    }
    if (!outcome.ok) {
      return reply
        .status(outcome.status)
        .send({ error: outcome.error, ...(outcome.detail ? { detail: outcome.detail } : {}) });
    }
    const flips = await db
      .select()
      .from(policySimulationFlips)
      .where(eq(policySimulationFlips.simulationId, outcome.simulation.id))
      .orderBy(desc(policySimulationFlips.occurredAt));
    return reply.status(201).send({
      status: "complete",
      simulation: outcome.simulation,
      /** the SPECIFIC calls that would flip — a preview names them */
      samples: flips,
      scope: { ruleId: scope.ruleId, reason: scope.reason, orgWide: scope.userIds === null },
      fidelity: REPLAY_FIDELITY_DISCLOSURE,
      abacCannotGrant: ABAC_CANNOT_GRANT_NOTE,
      dryRun: true,
      ...(await complianceProfileCanaryField(db, req.authCtx.isAdmin)),
    });
  });

  /**
   * ADR-0167 (AUTHZ-02): the LIST is scoped exactly as the detail route below
   * is. It used to return every stored row to any authenticated caller — the
   * named blast radius of an admin's org-wide preview included — so a plain
   * non-admin could read out of the archive, via the list, the very thing the
   * detail route refused them. Two rules now: a non-admin sees a run only when
   * they REQUESTED it or its stored scope lies entirely inside their own team
   * visibility; and the list is a SUMMARY (counts, headline, fidelity) — the
   * named users/projects/tools and the scope itself stay on the detail route,
   * where the scope check guards them.
   */
  app.get("/v1/policy-simulations", async (req, reply) => {
    const q = z
      .object({
        policyVersionId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const callerId = req.authCtx.userId ?? null;
    if (!req.authCtx.isAdmin && !callerId) {
      return reply.status(403).send({ error: "simulation_scope_denied" });
    }
    // a non-admin's visible rows are filtered AFTER the read (the scope is
    // jsonb), so the window is widened and cut back to `limit` afterwards —
    // a narrow caller must not get a short page merely because wider runs
    // happen to be newer
    const window = req.authCtx.isAdmin ? q.limit : Math.min(q.limit * 4, 800);
    const rows = await db
      .select()
      .from(policySimulations)
      .where(q.policyVersionId ? eq(policySimulations.policyVersionId, q.policyVersionId) : undefined)
      .orderBy(desc(policySimulations.createdAt))
      .limit(window);
    let visibleRows = rows;
    if (!req.authCtx.isAdmin) {
      const visible = new Set(await visibleSubjectsFor(db, callerId!));
      visibleRows = rows
        .filter(
          (row) =>
            row.requestedByUserId === callerId ||
            (row.scopeUserIds !== null && (row.scopeUserIds ?? []).every((u) => visible.has(u))),
        )
        .slice(0, q.limit);
    }
    const summaries = visibleRows.map(({ blastRadius: _radius, scopeUserIds: _scope, ...summary }) => summary);
    return { simulations: summaries, fidelity: REPLAY_FIDELITY_DISCLOSURE };
  });

  app.get("/v1/policy-simulations/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(policySimulations).where(eq(policySimulations.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_simulation" });
    // A stored preview is readable only by someone whose visibility covers the
    // scope it was run under — a narrower caller must not read a wider run's
    // named users back out of the archive.
    if (!req.authCtx.isAdmin) {
      const callerId = req.authCtx.userId ?? null;
      if (!callerId) return reply.status(403).send({ error: "simulation_scope_denied" });
      const visible = new Set(await visibleSubjectsFor(db, callerId));
      const outside =
        row.scopeUserIds === null || (row.scopeUserIds ?? []).some((u) => !visible.has(u));
      if (outside) {
        await refuse(
          callerId,
          "policy-simulation-read-denied",
          "a caller without the preview's entitlement scope tried to read a stored blast radius",
          { simulationId: row.id },
        );
        return reply.status(403).send({ error: "simulation_scope_denied" });
      }
    }
    const flips = await db
      .select()
      .from(policySimulationFlips)
      .where(eq(policySimulationFlips.simulationId, row.id))
      .orderBy(desc(policySimulationFlips.occurredAt));
    return {
      simulation: row,
      samples: flips,
      fidelity: REPLAY_FIDELITY_DISCLOSURE,
      abacCannotGrant: ABAC_CANNOT_GRANT_NOTE,
      unreplayableAttributes: UNREPLAYABLE_ATTRIBUTES,
      ...(await complianceProfileCanaryField(db, req.authCtx.isAdmin)),
    };
  });

  /** the friction dial, and what it does when it is off (admin-only) */
  app.get("/v1/policy-simulations/settings", async () => {
    const row = await loadPolicySimulationSettings(db);
    return {
      settings: row,
      note:
        "When ON (the default), activating a policy version that no blast-radius preview has examined is " +
        "refused. When OFF (an audited admin relaxation), that activation succeeds — but the activation audit " +
        "row permanently records that no preview existed. Either way the omission is legible; the dial decides " +
        "whether it is also blocking.",
      defaults: {
        windowDays: POLICY_SIMULATION_DEFAULT_WINDOW_DAYS,
        rowCap: POLICY_SIMULATION_DEFAULT_ROW_CAP,
      },
    };
  });

  app.put("/v1/policy-simulations/settings", async (req, reply) => {
    const body = policySimulationSettingsSchema.parse(req.body ?? {});
    const before = await loadPolicySimulationSettings(db);
    // ADR-0186 A: activating without a preview is a relaxation (strict: preview required)
    const relaxed = relaxedAgainst(
      { requirePreviewBeforeActivate: body.requirePreviewBeforeActivate },
      before as unknown as Record<string, unknown>,
      { requirePreviewBeforeActivate: true },
      "policySimulation.",
    );
    if (!(await requireRelaxStepUp(db, req, reply, relaxed))) return reply;
    const [row] = await db
      .update(policySimulationSettings)
      .set({
        ...(body.requirePreviewBeforeActivate !== undefined
          ? { requirePreviewBeforeActivate: body.requirePreviewBeforeActivate }
          : {}),
        ...(body.defaultWindowDays !== undefined ? { defaultWindowDays: body.defaultWindowDays } : {}),
        ...(body.defaultRowCap !== undefined ? { defaultRowCap: body.defaultRowCap } : {}),
        updatedByUserId: req.authCtx.userId ?? null,
        updatedAt: new Date(),
      })
      // ADR-0186 A (Class A): compare-and-set on the dial the step-up was decided on
      .where(
        and(
          eq(policySimulationSettings.id, SINGLETON),
          eq(policySimulationSettings.requirePreviewBeforeActivate, before.requirePreviewBeforeActivate),
        ),
      )
      .returning();
    if (!row) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL_UUID,
      objectType: "abac_policy",
      objectId: null,
      // ADR-0181: old -> new for the preview dial (on by default)
      detail: {
        phase: "blast-radius-settings",
        ...body,
        transitions: settingTransitions(before, body),
      },
      effect: "allow",
      ruleId: "policy-simulation-settings-changed",
      ruleChain: [],
      reason: row!.requirePreviewBeforeActivate
        ? "activating an ABAC policy version now REQUIRES a completed blast-radius preview of that exact version"
        : "activating an ABAC policy version no longer requires a blast-radius preview — the omission is still recorded on every activation",
    });
    return { settings: row };
  });
}
