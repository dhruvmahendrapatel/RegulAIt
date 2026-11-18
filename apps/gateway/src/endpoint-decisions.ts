/**
 * ADR-0310 addendum (lane E1): endpoint decision audit and tamper reporting.
 *
 * The endpoint agent's hook (ADR-0298, ADR-0330, ADR-0350) decides on the device and, until now, told nobody. Each
 * decision is now spooled on the device and uploaded by the agent's run loop as a signed batch:
 *
 *   POST /v1/endpoint-agent/decisions    body regulait.endpoint-decisions/1
 *     - DPoP-bound endpoint-agent token (the reports route's channel, ADR-0195 SD4b);
 *     - `Content-Digest` (RFC 9530) over the exact bytes, and `Regulait-Decisions-Signature`: an ES256 compact JWS by
 *       the device key, typ regulait-endpoint-decisions+jwt, binding the digest, the batch id and this URL;
 *     - one use per signature (the replay store) and one copy per batch id (endpoint_decision_batches).
 *
 * THE ONE DECISION-EVENT INTERFACE. Every on-device rule set emits through the same event: the MCP rules (ADR-0330),
 * the command, file and package rules (ADR-0350, lane E31), and any later one. An emitter names itself in
 * `decision.emitter`; nothing else differs, so there is no second audit path (owner brief, 2026-11-18).
 *
 * Each decision becomes one hash-chained audit_log row (objectType endpoint_device, objectId the device): an allow,
 * a deny, an ask (require_approval), or an audit-mode would-deny / would-ask (allow, with the would-* flag). The
 * session and managed-file tables are read models beside it (see the migration header).
 *
 * Permission-bypass sessions: Claude Code and Codex put `permission_mode` in every hook input; `bypassPermissions`
 * is `--dangerously-skip-permissions` / `--yolo` (both vendors' hook docs, checked 2026-11-18). Cursor and Copilot CLI
 * report no mode, so their sessions say so instead of looking safe (ADR-0180: unknown is never reported as fine).
 *
 * Privacy: no tool argument, command, path or prompt is ever sent. A session is a device-keyed hash of the vendor's
 * session id; a rule is its id. The agent's pseudonymity guard checks the bytes before they leave.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, inArray, sql, type SQL } from "@regulait/db";
import type { ListSpec } from "./list-contract.js";
import { answerListPage, type ContractList } from "./list-contract-route.js";
import {
  auditLog,
  endpointAgentIdentities,
  endpointCodingSessionModes,
  endpointCodingSessions,
  endpointDecisionBatches,
  endpointDecisionEvents,
  endpointDevices,
  endpointManagedFileObservations,
  managedSettingsBundleFiles,
  managedSettingsBundles,
  ENDPOINT_HOOK_AGENTS,
  ENDPOINT_HOOK_STATUSES,
  ENDPOINT_MANAGED_FILES,
  ENDPOINT_MANAGED_FILE_STATES,
  type Db,
} from "@regulait/db";

// ---------------------------------------------------------------------------------------------------------------------
// The contract (mirrored by agents/endpoint/internal/contract; a fixture test on each side pins the same bytes)
// ---------------------------------------------------------------------------------------------------------------------

export const ENDPOINT_DECISIONS_SCHEMA = "regulait.endpoint-decisions/1";
export const ENDPOINT_DECISIONS_SIGNATURE_TYP = "regulait-endpoint-decisions+jwt";
export const ENDPOINT_DECISIONS_SIGNATURE_HEADER = "regulait-decisions-signature";
/** the strict bounds (ADR-0180: none is a setting) */
export const ENDPOINT_DECISIONS_MAX_EVENTS = 500;
export const ENDPOINT_DECISIONS_MAX_BYTES = 512 * 1024;
/** an event older than this, or further ahead than the skew, is counted as refused and not audited */
export const ENDPOINT_DECISION_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const ENDPOINT_DECISION_MAX_SKEW_MS = 5 * 60 * 1000;

/** the agents whose hook input carries the permission mode, and the value each uses for a permission bypass */
export const PERMISSION_MODE_BYPASS: Readonly<Record<(typeof ENDPOINT_HOOK_AGENTS)[number], string | null>> = {
  "claude-code": "bypassPermissions",
  codex: "bypassPermissions",
  cursor: null,
  "copilot-cli": null,
};
export const modeReported = (agent: (typeof ENDPOINT_HOOK_AGENTS)[number]) => PERMISSION_MODE_BYPASS[agent] !== null;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const permissionMode = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/);
export const DECISION_ACTIONS = ["mcp", "command", "file_read", "file_write", "package", "other"] as const;
export const DECISION_VERDICTS = ["allow", "deny", "ask", "none"] as const;

const decisionSchema = z
  .object({
    /** the rule set that decided: mcp-rules (ADR-0330), command-rules (ADR-0350, E31), … */
    emitter: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    action: z.enum(DECISION_ACTIONS),
    verdict: z.enum(DECISION_VERDICTS),
    wouldDeny: z.boolean(),
    wouldAsk: z.boolean(),
    mode: z.enum(["audit", "enforce", "no_policy"]),
    ruleId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).nullable(),
  })
  .strict()
  // `none` is only ever sent as an audit-mode would-deny or would-ask; a plain no-decision is not an event
  .refine((d) => d.verdict !== "none" || d.wouldDeny || d.wouldAsk, { message: "a none verdict is a would-deny or would-ask" })
  .refine((d) => !(d.wouldDeny && d.wouldAsk), { message: "would-deny and would-ask are exclusive" });

const eventSchema = z
  .object({
    eventId: z.string().uuid(),
    occurredAt: z.string().datetime({ offset: false }),
    kind: z.enum(["decision", "session"]),
    agent: z.enum(ENDPOINT_HOOK_AGENTS),
    sessionRef: hex64.nullable(),
    permissionMode: permissionMode.nullable(),
    decision: decisionSchema.optional(),
  })
  .strict()
  .refine((e) => (e.kind === "decision") === (e.decision !== undefined), { message: "a decision event, and only one, carries a decision" })
  // an agent that does not report its mode never claims one
  .refine((e) => modeReported(e.agent) || e.permissionMode === null, { message: "this agent reports no permission mode" });
export type EndpointDecisionEvent = z.infer<typeof eventSchema>;

const integritySchema = z
  .object({
    file: z.enum(ENDPOINT_MANAGED_FILES),
    state: z.enum(ENDPOINT_MANAGED_FILE_STATES),
    sha256: hex64.nullable(),
    hookStatus: z.enum(ENDPOINT_HOOK_STATUSES).nullable(),
  })
  .strict()
  .refine((f) => (f.state === "present") === (f.sha256 !== null), { message: "a present file, and only one, has a sha256" })
  .refine((f) => f.state === "present" || f.hookStatus === null, { message: "only a present file has a hook status" });

export const decisionBatchSchema = z
  .object({
    schema: z.literal(ENDPOINT_DECISIONS_SCHEMA),
    batchId: z.string().uuid(),
    sentAt: z.string().datetime({ offset: false }),
    agentVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
    /** events the device spool had to drop (full, or unreadable): reported, never hidden */
    droppedEvents: z.number().int().min(0).max(1_000_000),
    events: z.array(eventSchema).max(ENDPOINT_DECISIONS_MAX_EVENTS),
    /** one entry per managed file; empty when the agent did not check this cycle */
    integrity: z.array(integritySchema).max(ENDPOINT_MANAGED_FILES.length),
  })
  .strict()
  .refine((b) => new Set(b.events.map((e) => e.eventId)).size === b.events.length, { message: "event ids are unique" })
  .refine((b) => new Set(b.integrity.map((f) => f.file)).size === b.integrity.length, { message: "one entry per file" });
export type EndpointDecisionBatch = z.infer<typeof decisionBatchSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------------------------------------------------

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

type Agent = { identityId: string; deviceId: string; sourceId: string };
type Effect = "allow" | "deny" | "require_approval";
type AuditRow = typeof auditLog.$inferInsert;

/** the audit effect and rule id of one decision */
export function auditOfDecision(d: NonNullable<EndpointDecisionEvent["decision"]>): { effect: Effect; ruleId: string } {
  if (d.verdict === "deny") return { effect: "deny", ruleId: "endpoint-hook-deny" };
  if (d.verdict === "ask") return { effect: "require_approval", ruleId: "endpoint-hook-ask" };
  if (d.verdict === "allow") return { effect: "allow", ruleId: d.wouldAsk ? "endpoint-hook-would-ask" : "endpoint-hook-allow" };
  return { effect: "allow", ruleId: d.wouldDeny ? "endpoint-hook-would-deny" : "endpoint-hook-would-ask" };
}

/** a managed file's reported state, as compared between reports */
type FileState = { state: string; sha256: string | null; hookStatus: string | null };
const sameState = (a: FileState, b: FileState) => a.state === b.state && a.sha256 === b.sha256 && a.hookStatus === b.hookStatus;
/** the one state that is not itself a finding: present, with the hook registered */
const intactState = (f: FileState) => f.state === "present" && f.hookStatus === "registered";

export type IngestOutcome =
  | { outcome: "duplicate" }
  | { outcome: "conflict" }
  | { outcome: "accepted"; audited: number; stale: number; duplicateEvents: number; sessions: number; bypassSessions: number; fileChanges: number };

/**
 * Record one verified batch in one transaction: the batch row (a resend stops here; the same id with other bytes is a
 * conflict), the event ledger (an event already received in another batch is a duplicate), the decision audit rows,
 * the session and mode read models, and the managed-file observations. `now` is the database clock.
 */
export async function ingestDecisionBatch(db: Db, agent: Agent, batch: EndpointDecisionBatch, bodySha256: string, now: Date): Promise<IngestOutcome> {
  // an event far in the past or the future is still audited, flagged stale, but never moves a session's counters
  const isStale = (e: EndpointDecisionEvent) => {
    const at = Date.parse(e.occurredAt);
    return at < now.getTime() - ENDPOINT_DECISION_MAX_AGE_MS || at > now.getTime() + ENDPOINT_DECISION_MAX_SKEW_MS;
  };
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // event ids this identity already sent (the ledger below also refuses a racing insert)
    const seen = batch.events.length
      ? new Set(
          (
            await t
              .select({ eventId: endpointDecisionEvents.eventId })
              .from(endpointDecisionEvents)
              .where(and(eq(endpointDecisionEvents.identityId, agent.identityId), inArray(endpointDecisionEvents.eventId, batch.events.map((e) => e.eventId))))
          ).map((r) => r.eventId),
        )
      : new Set<string>();
    const refusedUpfront = batch.events.filter((e) => seen.has(e.eventId) || isStale(e)).length;
    const [row] = await t
      .insert(endpointDecisionBatches)
      .values({ identityId: agent.identityId, batchId: batch.batchId, bodySha256, eventsReceived: batch.events.length, eventsRefused: refusedUpfront, droppedEvents: batch.droppedEvents })
      .onConflictDoNothing({ target: [endpointDecisionBatches.identityId, endpointDecisionBatches.batchId] })
      .returning({ id: endpointDecisionBatches.id });
    if (!row) {
      const [prior] = await t
        .select({ bodySha256: endpointDecisionBatches.bodySha256 })
        .from(endpointDecisionBatches)
        .where(and(eq(endpointDecisionBatches.identityId, agent.identityId), eq(endpointDecisionBatches.batchId, batch.batchId)));
      return prior?.bodySha256 === bodySha256 ? ({ outcome: "duplicate" } as const) : ({ outcome: "conflict" } as const);
    }

    // the event ledger: only an event id this identity never sent before is recorded (#1044 review)
    const fresh = new Set<string>();
    if (batch.events.length) {
      const inserted = await t
        .insert(endpointDecisionEvents)
        .values(batch.events.map((e) => ({ identityId: agent.identityId, eventId: e.eventId, batchId: row.id })))
        .onConflictDoNothing({ target: [endpointDecisionEvents.identityId, endpointDecisionEvents.eventId] })
        .returning({ eventId: endpointDecisionEvents.eventId });
      for (const r of inserted) fresh.add(r.eventId);
    }
    const events = batch.events.filter((e) => fresh.has(e.eventId));
    const duplicateEvents = batch.events.length - events.length;
    const current = events.filter((e) => !isStale(e));
    const stale = events.length - current.length;

    // sessions: one upsert per (agent, sessionRef) in this batch, with its counters and time span
    type Acc = { agent: EndpointDecisionEvent["agent"]; sessionRef: string | null; first: Date; last: Date; decisions: number; denies: number; asks: number; wouldDenies: number; wouldAsks: number; modes: Map<string, { first: Date; last: Date }> };
    const acc = new Map<string, Acc>();
    const keyOf = (e: EndpointDecisionEvent) => `${e.agent}|${e.sessionRef ?? ""}`;
    for (const e of current) {
      const at = new Date(e.occurredAt);
      let a = acc.get(keyOf(e));
      if (!a) acc.set(keyOf(e), (a = { agent: e.agent, sessionRef: e.sessionRef, first: at, last: at, decisions: 0, denies: 0, asks: 0, wouldDenies: 0, wouldAsks: 0, modes: new Map() }));
      if (at < a.first) a.first = at;
      if (at > a.last) a.last = at;
      if (e.permissionMode !== null) {
        const m = a.modes.get(e.permissionMode);
        if (!m) a.modes.set(e.permissionMode, { first: at, last: at });
        else {
          if (at < m.first) m.first = at;
          if (at > m.last) m.last = at;
        }
      }
      const d = e.decision;
      if (!d) continue;
      a.decisions++;
      if (d.verdict === "deny") a.denies++;
      if (d.verdict === "ask") a.asks++;
      if (d.wouldDeny) a.wouldDenies++;
      if (d.wouldAsk) a.wouldAsks++;
    }
    const sessionIds = new Map<string, string>();
    let bypassSessions = 0;
    const findingAudits: AuditRow[] = [];
    for (const [key, a] of acc) {
      const [s] = await t
        .insert(endpointCodingSessions)
        .values({ identityId: agent.identityId, agent: a.agent, sessionRef: a.sessionRef, firstSeenAt: a.first, lastSeenAt: a.last, decisions: a.decisions, denies: a.denies, asks: a.asks, wouldDenies: a.wouldDenies, wouldAsks: a.wouldAsks })
        .onConflictDoUpdate({
          target: [endpointCodingSessions.identityId, endpointCodingSessions.agent, endpointCodingSessions.sessionRef],
          set: {
            firstSeenAt: sql`least(${endpointCodingSessions.firstSeenAt}, excluded.first_seen_at)`,
            lastSeenAt: sql`greatest(${endpointCodingSessions.lastSeenAt}, excluded.last_seen_at)`,
            decisions: sql`${endpointCodingSessions.decisions} + excluded.decisions`,
            denies: sql`${endpointCodingSessions.denies} + excluded.denies`,
            asks: sql`${endpointCodingSessions.asks} + excluded.asks`,
            wouldDenies: sql`${endpointCodingSessions.wouldDenies} + excluded.would_denies`,
            wouldAsks: sql`${endpointCodingSessions.wouldAsks} + excluded.would_asks`,
          },
        })
        .returning({ id: endpointCodingSessions.id });
      sessionIds.set(key, s!.id);
      const bypassValue = PERMISSION_MODE_BYPASS[a.agent];
      for (const [mode, span] of a.modes) {
        const [m] = await t
          .insert(endpointCodingSessionModes)
          .values({ sessionId: s!.id, permissionMode: mode, firstSeenAt: span.first, lastSeenAt: span.last })
          .onConflictDoUpdate({
            target: [endpointCodingSessionModes.sessionId, endpointCodingSessionModes.permissionMode],
            set: {
              firstSeenAt: sql`least(${endpointCodingSessionModes.firstSeenAt}, excluded.first_seen_at)`,
              lastSeenAt: sql`greatest(${endpointCodingSessionModes.lastSeenAt}, excluded.last_seen_at)`,
            },
          })
          // xmax = 0 only on a fresh insert: the first time this session is seen in this mode
          .returning({ inserted: sql<boolean>`(xmax = 0)` });
        if (mode === bypassValue && m?.inserted) {
          bypassSessions++;
          findingAudits.push({
            userId: NIL_UUID,
            objectType: "endpoint_device",
            objectId: agent.deviceId,
            detail: { subsystem: "endpoint-decision-audit", finding: "permission_bypass", sessionId: s!.id, agent: a.agent, permissionMode: mode, identityId: agent.identityId, firstSeenAt: span.first.toISOString() },
            effect: "deny",
            ruleId: "endpoint-permission-bypass-session",
            ruleChain: [],
            reason: `a ${a.agent} session on an endpoint device ran in permission-bypass mode (${mode}); the managed hook still decided its governed calls (ADR-0310 addendum)`,
          });
        }
      }
    }

    // one chained audit row per decision (the audit_log interceptor chains a multi-row insert in order)
    const decisionAudits: AuditRow[] = [];
    for (const e of events) {
      if (!e.decision) continue;
      const { effect, ruleId } = auditOfDecision(e.decision);
      const late = isStale(e);
      decisionAudits.push({
        userId: NIL_UUID,
        objectType: "endpoint_device",
        objectId: agent.deviceId,
        detail: {
          subsystem: "endpoint-decision-audit",
          eventId: e.eventId,
          occurredAt: e.occurredAt,
          stale: late,
          batchId: batch.batchId,
          identityId: agent.identityId,
          sessionId: late ? null : (sessionIds.get(keyOf(e)) ?? null),
          agent: e.agent,
          permissionMode: e.permissionMode,
          ...e.decision,
        },
        effect,
        ruleId,
        ruleChain: e.decision.ruleId ? [e.decision.ruleId] : [],
        reason: `endpoint hook ${e.decision.verdict === "none" ? (e.decision.wouldDeny ? "would deny (audit mode)" : "would ask (audit mode)") : e.decision.verdict} on a ${e.decision.action} call by ${e.agent} (${e.decision.emitter})${late ? "; its time is outside the accepted window, so it is flagged stale" : ""}`,
      });
    }

    // managed-file observations: every transition from the previous latest state is audited, a return included, and
    // a first report that is not intact is a finding at once (#1044 review)
    let fileChanges = 0;
    for (const f of batch.integrity) {
      const [prev] = await t
        .select({ state: endpointManagedFileObservations.state, sha256: endpointManagedFileObservations.sha256, hookStatus: endpointManagedFileObservations.hookStatus })
        .from(endpointManagedFileObservations)
        .where(and(eq(endpointManagedFileObservations.identityId, agent.identityId), eq(endpointManagedFileObservations.file, f.file)))
        .orderBy(desc(endpointManagedFileObservations.lastSeenAt), desc(endpointManagedFileObservations.id))
        .limit(1);
      await t
        .insert(endpointManagedFileObservations)
        .values({ identityId: agent.identityId, file: f.file, state: f.state, sha256: f.sha256, hookStatus: f.hookStatus, firstSeenAt: now, lastSeenAt: now })
        .onConflictDoUpdate({
          target: [endpointManagedFileObservations.identityId, endpointManagedFileObservations.file, endpointManagedFileObservations.state, endpointManagedFileObservations.sha256, endpointManagedFileObservations.hookStatus],
          set: { lastSeenAt: sql`greatest(${endpointManagedFileObservations.lastSeenAt}, excluded.last_seen_at)` },
        });
      const changed = prev ? !sameState(prev, f) : !intactState(f) && f.state !== "missing";
      if (!changed) continue;
      fileChanges++;
      findingAudits.push({
        userId: NIL_UUID,
        objectType: "endpoint_device",
        objectId: agent.deviceId,
        detail: { subsystem: "endpoint-decision-audit", finding: prev ? "managed_file_changed" : "managed_file_not_intact", identityId: agent.identityId, file: f.file, from: prev ?? null, to: { state: f.state, sha256: f.sha256, hookStatus: f.hookStatus } },
        effect: intactState(f) ? "allow" : "deny",
        ruleId: prev ? "endpoint-managed-file-changed" : "endpoint-managed-file-not-intact",
        ruleChain: [],
        reason: prev
          ? `a managed settings or hook file changed on an endpoint device: ${f.file} went from ${prev.state}${prev.hookStatus ? `, hook ${prev.hookStatus}` : ""} to ${f.state}${f.hookStatus ? `, hook ${f.hookStatus}` : ""} (ADR-0310 addendum)`
          : `a managed settings or hook file was first reported not intact on an endpoint device: ${f.file} is ${f.state}${f.hookStatus ? `, hook ${f.hookStatus}` : ""} (ADR-0310 addendum)`,
      });
    }

    const all: AuditRow[] = [...decisionAudits, ...findingAudits];
    all.push({
      userId: NIL_UUID,
      objectType: "endpoint_device",
      objectId: agent.deviceId,
      detail: { subsystem: "endpoint-decision-audit", batchId: batch.batchId, identityId: agent.identityId, eventsReceived: batch.events.length, duplicateEvents, staleEvents: stale, droppedEvents: batch.droppedEvents, decisionsAudited: decisionAudits.length, bypassSessions, fileChanges, bodySha256 },
      effect: "allow",
      ruleId: "endpoint-decision-batch-accepted",
      ruleChain: [],
      reason: `an endpoint decision batch was accepted: ${decisionAudits.length} decision(s) audited (${stale} stale), ${duplicateEvents} already-received event(s) skipped, ${batch.droppedEvents} dropped on the device (ADR-0310 addendum)`,
    });
    await t.insert(auditLog).values(all);
    return { outcome: "accepted", audited: decisionAudits.length, stale, duplicateEvents, sessions: acc.size, bypassSessions, fileChanges } as const;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Admin views, under the ADR-0226 list contract
// ---------------------------------------------------------------------------------------------------------------------

/** the agents whose hook reports a permission mode, and so whose sessions can be judged bypassed or not */
const MODE_REPORTING_AGENTS = ENDPOINT_HOOK_AGENTS.filter(modeReported);
/** "this session reported its agent's bypass mode", derived from PERMISSION_MODE_BYPASS so the two cannot drift */
const BYPASS_EXISTS = sql.join(
  MODE_REPORTING_AGENTS.map(
    (a) =>
      sql`(${endpointCodingSessions.agent} = ${a} AND EXISTS (SELECT 1 FROM ${endpointCodingSessionModes} m WHERE m.session_id = ${endpointCodingSessions.id} AND m.permission_mode = ${PERMISSION_MODE_BYPASS[a]}))`,
  ),
  sql` OR `,
);

export const sessionsFilters = z
  .object({
    bypass: z.enum(["true", "false"]).optional(),
    agent: z.enum(ENDPOINT_HOOK_AGENTS).optional(),
    deviceId: z.string().uuid().optional(),
  })
  .strict();

const sessionBase = {
  id: endpointCodingSessions.id,
  agent: endpointCodingSessions.agent,
  sessionRef: endpointCodingSessions.sessionRef,
  firstSeenAt: endpointCodingSessions.firstSeenAt,
  lastSeenAt: endpointCodingSessions.lastSeenAt,
  decisions: endpointCodingSessions.decisions,
  denies: endpointCodingSessions.denies,
  asks: endpointCodingSessions.asks,
  wouldDenies: endpointCodingSessions.wouldDenies,
  wouldAsks: endpointCodingSessions.wouldAsks,
  deviceId: endpointAgentIdentities.deviceId,
  devicePseudonym: endpointDevices.devicePseudonym,
  deviceUserPseudonym: endpointAgentIdentities.deviceUserPseudonym,
};

export type CodingSessionView = {
  id: string;
  agent: (typeof ENDPOINT_HOOK_AGENTS)[number];
  sessionIdentified: boolean;
  device: { id: string; pseudonym: string; userPseudonym: string };
  firstSeenAt: string;
  lastSeenAt: string;
  counts: { decisions: number; denies: number; asks: number; wouldDenies: number; wouldAsks: number };
  permissionModeReported: boolean;
  permissionModes: Array<{ mode: string; firstSeenAt: string; lastSeenAt: string }>;
  /** null when the agent does not report its mode: unknown, never "not bypassed" (ADR-0180) */
  permissionBypass: boolean | null;
  finding: "permission_bypass" | null;
};

/** at most this many modes are shown per session; the device controls how many it reports */
const MODES_SHOWN = 16;

export const CODING_SESSIONS_LIST: ListSpec<CodingSessionView> = {
  id: "endpoint-coding-sessions",
  sorts: {
    lastSeen: { expr: endpointCodingSessions.lastSeenAt, keysetAt: endpointCodingSessions.lastSeenAt },
    firstSeen: { expr: endpointCodingSessions.firstSeenAt, keysetAt: endpointCodingSessions.firstSeenAt },
    agent: { expr: endpointCodingSessions.agent },
    decisions: { expr: endpointCodingSessions.decisions },
    denies: { expr: endpointCodingSessions.denies },
  },
  columns: {
    agent: { label: "Agent", value: (r) => r.agent },
    device: { label: "Device", value: (r) => r.device.pseudonym },
    user: { label: "Device user", value: (r) => r.device.userPseudonym },
    bypass: { label: "Permission bypass", value: (r) => (r.permissionBypass === null ? "not reported" : r.permissionBypass) },
    decisions: { label: "Decisions", value: (r) => r.counts.decisions },
    denies: { label: "Denies", value: (r) => r.counts.denies },
    lastSeen: { label: "Last seen", value: (r) => r.lastSeenAt },
  },
  filters: ["bypass", "agent", "deviceId"],
  defaultSort: { col: "lastSeen", dir: "desc" },
  idCol: endpointCodingSessions.id,
};

function codingSessionsList(db: Db): ContractList<CodingSessionView, z.infer<typeof sessionsFilters>> {
  return {
    spec: CODING_SESSIONS_LIST,
    filters: sessionsFilters,
    where: (_req, f) => {
      const conds: SQL[] = [];
      if (f.agent) conds.push(eq(endpointCodingSessions.agent, f.agent));
      if (f.deviceId) conds.push(eq(endpointAgentIdentities.deviceId, f.deviceId));
      if (f.bypass === "true") conds.push(sql`(${BYPASS_EXISTS})`);
      // "not bypassed" only for agents that report a mode: the others are unknown, and never listed as safe
      if (f.bypass === "false") conds.push(sql`(${inArray(endpointCodingSessions.agent, MODE_REPORTING_AGENTS)} AND NOT (${BYPASS_EXISTS}))`);
      return conds.length ? and(...conds) : undefined;
    },
    reader: {
      fetch: async (q) => {
        const rows = await db
          .select({ ...sessionBase, _cursorAt: q.cursorAt })
          .from(endpointCodingSessions)
          .innerJoin(endpointAgentIdentities, eq(endpointAgentIdentities.identityId, endpointCodingSessions.identityId))
          .innerJoin(endpointDevices, eq(endpointDevices.id, endpointAgentIdentities.deviceId))
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)
          .offset(q.offset);
        const modes = rows.length
          ? await db
              .select({ sessionId: endpointCodingSessionModes.sessionId, permissionMode: endpointCodingSessionModes.permissionMode, firstSeenAt: endpointCodingSessionModes.firstSeenAt, lastSeenAt: endpointCodingSessionModes.lastSeenAt })
              .from(endpointCodingSessionModes)
              .where(inArray(endpointCodingSessionModes.sessionId, rows.map((r) => r.id)))
              .orderBy(asc(endpointCodingSessionModes.firstSeenAt))
              .limit(rows.length * MODES_SHOWN)
          : [];
        return rows.map((r) => {
          const own = modes.filter((m) => m.sessionId === r.id);
          const reported = modeReported(r.agent);
          const bypass = reported && own.some((m) => m.permissionMode === PERMISSION_MODE_BYPASS[r.agent]);
          return {
            _cursorAt: r._cursorAt,
            id: r.id,
            agent: r.agent,
            sessionIdentified: r.sessionRef !== null,
            device: { id: r.deviceId, pseudonym: r.devicePseudonym, userPseudonym: r.deviceUserPseudonym },
            firstSeenAt: r.firstSeenAt.toISOString(),
            lastSeenAt: r.lastSeenAt.toISOString(),
            counts: { decisions: r.decisions, denies: r.denies, asks: r.asks, wouldDenies: r.wouldDenies, wouldAsks: r.wouldAsks },
            permissionModeReported: reported,
            permissionModes: own.slice(0, MODES_SHOWN).map((m) => ({ mode: m.permissionMode, firstSeenAt: m.firstSeenAt.toISOString(), lastSeenAt: m.lastSeenAt.toISOString() })),
            permissionBypass: reported ? bypass : null,
            finding: bypass ? ("permission_bypass" as const) : null,
          };
        });
      },
      countable: (where) =>
        db
          .select({ one: sql`1` })
          .from(endpointCodingSessions)
          .innerJoin(endpointAgentIdentities, eq(endpointAgentIdentities.identityId, endpointCodingSessions.identityId))
          .where(where),
      idOf: (r) => r.id,
    },
    extra: () => ({
      coverage: ENDPOINT_HOOK_AGENTS.map((a) => ({
        agent: a,
        permissionModeReported: modeReported(a),
        note: modeReported(a)
          ? `${a} reports its permission mode in every hook call; ${PERMISSION_MODE_BYPASS[a]} is a permission-bypass session`
          : `${a} does not report its permission mode to hooks, so a permission-bypass session cannot be seen; its hook decisions are still audited`,
      })),
    }),
  };
}

export const tamperFilters = z.object({ deviceId: z.string().uuid().optional() }).strict();

/** the managed files whose bundle copy is delivered as a file, so the device's bytes can match an exported bundle */
const BUNDLE_FILE_OF: Partial<Record<(typeof ENDPOINT_MANAGED_FILES)[number], string>> = {
  "claude-code/managed-settings.json": "claude-code/managed-settings.json",
  "openai-codex/requirements.toml": "openai-codex/requirements.toml",
};

export type FileStatus = "intact" | "changed" | "hook_missing" | "hook_weakened" | "file_missing" | "unreadable" | "not_system_owned";

export type ManagedFilesView = {
  identityId: string;
  device: { id: string; pseudonym: string; userPseudonym: string };
  findings: number;
  files: Array<Record<string, unknown> & { file: string; status: FileStatus | "not_reported"; finding: boolean }>;
};

export const MANAGED_FILES_LIST: ListSpec<ManagedFilesView> = {
  id: "endpoint-managed-files",
  sorts: { registered: { expr: endpointAgentIdentities.registeredAt, keysetAt: endpointAgentIdentities.registeredAt } },
  columns: {
    device: { label: "Device", value: (r) => r.device.pseudonym },
    user: { label: "Device user", value: (r) => r.device.userPseudonym },
    findings: { label: "Findings", value: (r) => r.findings },
  },
  filters: ["deviceId"],
  defaultSort: { col: "registered", dir: "desc" },
  idCol: endpointAgentIdentities.identityId,
};

/**
 * Per device user, the latest state of each managed file and whether it changed. The hook is the control: a missing
 * or weakened registration is a finding of its own. Every read is bounded by the page: the latest observation per
 * file, a count per file, and only the bundle files whose hash a latest observation carries. Restore is a later
 * step and needs admin approval.
 */
function managedFilesList(db: Db): ContractList<ManagedFilesView, z.infer<typeof tamperFilters>> {
  return {
    spec: MANAGED_FILES_LIST,
    filters: tamperFilters,
    where: (_req, f) => {
      const conds: SQL[] = [sql`EXISTS (SELECT 1 FROM ${endpointManagedFileObservations} o WHERE o.identity_id = ${endpointAgentIdentities.identityId})`];
      if (f.deviceId) conds.push(eq(endpointAgentIdentities.deviceId, f.deviceId));
      return and(...conds);
    },
    reader: {
      fetch: async (q) => {
        const rows = await db
          .select({ identityId: endpointAgentIdentities.identityId, deviceId: endpointAgentIdentities.deviceId, devicePseudonym: endpointDevices.devicePseudonym, deviceUserPseudonym: endpointAgentIdentities.deviceUserPseudonym, _cursorAt: q.cursorAt })
          .from(endpointAgentIdentities)
          .innerJoin(endpointDevices, eq(endpointDevices.id, endpointAgentIdentities.deviceId))
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)
          .offset(q.offset);
        if (!rows.length) return [];
        const ids = rows.map((r) => r.identityId);
        const o = endpointManagedFileObservations;
        // the latest observation per (identity, file), and per file how many states it has had and whether it was ever present
        const latest = (await db
          .selectDistinctOn([o.identityId, o.file], { identityId: o.identityId, file: o.file, state: o.state, sha256: o.sha256, hookStatus: o.hookStatus, lastSeenAt: o.lastSeenAt })
          .from(o)
          .where(inArray(o.identityId, ids))
          .orderBy(o.identityId, o.file, desc(o.lastSeenAt), desc(o.id))) as Array<{ identityId: string; file: string; state: string; sha256: string | null; hookStatus: string | null; lastSeenAt: Date }>;
        const stats = await db
          .select({ identityId: o.identityId, file: o.file, states: sql<number>`count(*)::int`, everPresent: sql<boolean>`bool_or(${o.state} = 'present')`, firstSeenAt: sql<Date>`min(${o.firstSeenAt})` })
          .from(o)
          .where(inArray(o.identityId, ids))
          .groupBy(o.identityId, o.file);
        const hashes = [...new Set(latest.filter((l) => BUNDLE_FILE_OF[l.file as keyof typeof BUNDLE_FILE_OF] && l.sha256).map((l) => l.sha256!))];
        const exported = hashes.length
          ? await db
              .selectDistinctOn([managedSettingsBundleFiles.path, managedSettingsBundleFiles.sha256], { path: managedSettingsBundleFiles.path, sha256: managedSettingsBundleFiles.sha256, bundleId: managedSettingsBundles.id, version: managedSettingsBundles.version })
              .from(managedSettingsBundleFiles)
              .innerJoin(managedSettingsBundles, eq(managedSettingsBundles.id, managedSettingsBundleFiles.bundleId))
              .where(and(inArray(managedSettingsBundleFiles.path, Object.values(BUNDLE_FILE_OF) as string[]), inArray(managedSettingsBundleFiles.sha256, hashes)))
              .orderBy(managedSettingsBundleFiles.path, managedSettingsBundleFiles.sha256, desc(managedSettingsBundles.createdAt))
          : [];
        return rows.map((d) => {
          let findings = 0;
          const files = ENDPOINT_MANAGED_FILES.map((file) => {
            const l = latest.find((x) => x.identityId === d.identityId && x.file === file);
            const st = stats.find((x) => x.identityId === d.identityId && x.file === file);
            if (!l || !st) return { file, status: "not_reported" as const, finding: false };
            const status: FileStatus =
              l.state === "missing" ? "file_missing"
              : l.state === "unreadable" ? "unreadable"
              : l.state === "not_system_owned" ? "not_system_owned"
              : l.hookStatus === "absent" || l.hookStatus === "unparseable" ? "hook_missing"
              : l.hookStatus === "weakened" ? "hook_weakened"
              : st.states > 1 ? "changed"
              : "intact";
            const bundlePath = BUNDLE_FILE_OF[file];
            const match = bundlePath && l.sha256 ? exported.find((x) => x.path === bundlePath && x.sha256 === l.sha256) : undefined;
            // a file never present on this device is a vendor not deployed there, which is not tamper
            const finding = status !== "intact" && !(status === "file_missing" && !st.everPresent);
            if (finding) findings++;
            return {
              file,
              status,
              finding,
              state: l.state,
              sha256: l.sha256,
              hookStatus: l.hookStatus,
              lastSeenAt: l.lastSeenAt.toISOString(),
              firstReportedAt: new Date(st.firstSeenAt).toISOString(),
              statesSeen: st.states,
              // compared only for the files a bundle delivers as a file; null when there is nothing to compare against
              bundleMatch: bundlePath ? (l.sha256 ? (match ? { bundleId: match.bundleId, version: match.version } : "none") : null) : null,
            };
          });
          return { _cursorAt: d._cursorAt, identityId: d.identityId, device: { id: d.deviceId, pseudonym: d.devicePseudonym, userPseudonym: d.deviceUserPseudonym }, findings, files };
        });
      },
      countable: (where) => db.select({ one: sql`1` }).from(endpointAgentIdentities).where(where),
      idOf: (r) => r.identityId,
    },
    extra: () => ({
      note: "Tamper is measured from what each device reports: a device that stops reporting shows its last state. Every change is in the audit log. Restoring a changed file is a later step and needs admin approval.",
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Routes (admin-only by the app-level default: neither is in NON_ADMIN_ROUTES)
// ---------------------------------------------------------------------------------------------------------------------

export function registerEndpointDecisionRoutes(app: FastifyInstance, db: Db): void {
  const sessions = codingSessionsList(db);
  const files = managedFilesList(db);
  app.get("/v1/endpoint-decisions/sessions", async (req, reply) => answerListPage(db, req, reply, sessions));
  app.get("/v1/endpoint-decisions/tamper", async (req, reply) => answerListPage(db, req, reply, files));
}
