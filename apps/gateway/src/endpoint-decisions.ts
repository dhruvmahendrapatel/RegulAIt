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
import { and, desc, eq, inArray, lt, or, sql, type SQL } from "@regulait/db";
import {
  auditLog,
  endpointAgentIdentities,
  endpointCodingSessionModes,
  endpointCodingSessions,
  endpointDecisionBatches,
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

/** the audit effect and rule id of one decision */
export function auditOfDecision(d: NonNullable<EndpointDecisionEvent["decision"]>): { effect: Effect; ruleId: string } {
  if (d.verdict === "deny") return { effect: "deny", ruleId: "endpoint-hook-deny" };
  if (d.verdict === "ask") return { effect: "require_approval", ruleId: "endpoint-hook-ask" };
  if (d.verdict === "allow") return { effect: "allow", ruleId: d.wouldAsk ? "endpoint-hook-would-ask" : "endpoint-hook-allow" };
  return { effect: "allow", ruleId: d.wouldDeny ? "endpoint-hook-would-deny" : "endpoint-hook-would-ask" };
}

export type IngestOutcome = { duplicate: true } | { duplicate: false; audited: number; refused: number; sessions: number; bypassSessions: number; fileChanges: number };

/**
 * Record one verified batch in one transaction: the batch row (a duplicate stops here), the decision audit rows, the
 * session and mode read models, and the managed-file observations. `now` is the database clock.
 */
export async function ingestDecisionBatch(db: Db, agent: Agent, batch: EndpointDecisionBatch, bodySha256: string, now: Date): Promise<IngestOutcome> {
  const fresh = (e: EndpointDecisionEvent) => {
    const t = Date.parse(e.occurredAt);
    return t >= now.getTime() - ENDPOINT_DECISION_MAX_AGE_MS && t <= now.getTime() + ENDPOINT_DECISION_MAX_SKEW_MS;
  };
  const accepted = batch.events.filter(fresh);
  const refused = batch.events.length - accepted.length;
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [row] = await t
      .insert(endpointDecisionBatches)
      .values({ identityId: agent.identityId, batchId: batch.batchId, bodySha256, eventsReceived: batch.events.length, eventsRefused: refused, droppedEvents: batch.droppedEvents })
      .onConflictDoNothing({ target: [endpointDecisionBatches.identityId, endpointDecisionBatches.batchId] })
      .returning({ id: endpointDecisionBatches.id });
    if (!row) return { duplicate: true } as const;

    // sessions: one upsert per (agent, sessionRef) in this batch, with its counters and time span
    type Acc = { agent: EndpointDecisionEvent["agent"]; sessionRef: string | null; first: Date; last: Date; decisions: number; denies: number; asks: number; wouldDenies: number; wouldAsks: number; modes: Map<string, { first: Date; last: Date }> };
    const acc = new Map<string, Acc>();
    for (const e of accepted) {
      const key = `${e.agent}|${e.sessionRef ?? ""}`;
      const at = new Date(e.occurredAt);
      let a = acc.get(key);
      if (!a) acc.set(key, (a = { agent: e.agent, sessionRef: e.sessionRef, first: at, last: at, decisions: 0, denies: 0, asks: 0, wouldDenies: 0, wouldAsks: 0, modes: new Map() }));
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
    const bypassAudits: Array<typeof auditLog.$inferInsert> = [];
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
          bypassAudits.push({
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
    const decisionAudits: Array<typeof auditLog.$inferInsert> = [];
    for (const e of accepted) {
      if (!e.decision) continue;
      const { effect, ruleId } = auditOfDecision(e.decision);
      decisionAudits.push({
        userId: NIL_UUID,
        objectType: "endpoint_device",
        objectId: agent.deviceId,
        detail: {
          subsystem: "endpoint-decision-audit",
          eventId: e.eventId,
          occurredAt: e.occurredAt,
          batchId: batch.batchId,
          identityId: agent.identityId,
          sessionId: sessionIds.get(`${e.agent}|${e.sessionRef ?? ""}`) ?? null,
          agent: e.agent,
          permissionMode: e.permissionMode,
          ...e.decision,
        },
        effect,
        ruleId,
        ruleChain: e.decision.ruleId ? [e.decision.ruleId] : [],
        reason: `endpoint hook ${e.decision.verdict === "none" ? (e.decision.wouldDeny ? "would deny (audit mode)" : "would ask (audit mode)") : e.decision.verdict} on a ${e.decision.action} call by ${e.agent} (${e.decision.emitter})`,
      });
    }

    // managed-file observations: a state not seen before is a change (unless it is the first report for that file)
    let fileChanges = 0;
    const fileAudits: Array<typeof auditLog.$inferInsert> = [];
    for (const f of batch.integrity) {
      const before = await t
        .select({ n: sql<number>`count(*)::int` })
        .from(endpointManagedFileObservations)
        .where(and(eq(endpointManagedFileObservations.identityId, agent.identityId), eq(endpointManagedFileObservations.file, f.file)));
      const [o] = await t
        .insert(endpointManagedFileObservations)
        .values({ identityId: agent.identityId, file: f.file, state: f.state, sha256: f.sha256, hookStatus: f.hookStatus, firstSeenAt: now, lastSeenAt: now })
        .onConflictDoUpdate({
          target: [endpointManagedFileObservations.identityId, endpointManagedFileObservations.file, endpointManagedFileObservations.state, endpointManagedFileObservations.sha256, endpointManagedFileObservations.hookStatus],
          set: { lastSeenAt: sql`greatest(${endpointManagedFileObservations.lastSeenAt}, excluded.last_seen_at)` },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (o?.inserted && (before[0]?.n ?? 0) > 0) {
        fileChanges++;
        fileAudits.push({
          userId: NIL_UUID,
          objectType: "endpoint_device",
          objectId: agent.deviceId,
          detail: { subsystem: "endpoint-decision-audit", finding: "managed_file_changed", identityId: agent.identityId, file: f.file, state: f.state, sha256: f.sha256, hookStatus: f.hookStatus },
          effect: "deny",
          ruleId: "endpoint-managed-file-changed",
          ruleChain: [],
          reason: `a managed settings or hook file changed on an endpoint device: ${f.file} is now ${f.state}${f.hookStatus ? `, hook ${f.hookStatus}` : ""} (ADR-0310 addendum)`,
        });
      }
    }

    const all = [...decisionAudits, ...bypassAudits, ...fileAudits];
    all.push({
      userId: NIL_UUID,
      objectType: "endpoint_device",
      objectId: agent.deviceId,
      detail: { subsystem: "endpoint-decision-audit", batchId: batch.batchId, identityId: agent.identityId, eventsReceived: batch.events.length, eventsRefused: refused, droppedEvents: batch.droppedEvents, decisionsAudited: decisionAudits.length, bypassSessions, fileChanges, bodySha256 },
      effect: "allow",
      ruleId: "endpoint-decision-batch-accepted",
      ruleChain: [],
      reason: `an endpoint decision batch was accepted: ${decisionAudits.length} decision(s) audited, ${refused} stale event(s) refused, ${batch.droppedEvents} dropped on the device (ADR-0310 addendum)`,
    });
    await t.insert(auditLog).values(all);
    await t.update(endpointAgentIdentities).set({ lastReportAt: sql`now()` }).where(eq(endpointAgentIdentities.identityId, agent.identityId));
    return { duplicate: false, audited: decisionAudits.length, refused, sessions: acc.size, bypassSessions, fileChanges } as const;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------------------------------------------------

export const sessionsQuery = z
  .object({
    bypass: z.enum(["true", "false"]).optional(),
    agent: z.enum(ENDPOINT_HOOK_AGENTS).optional(),
    deviceId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** keyset cursor: the `next` of the previous page */
    before: z.string().regex(/^\d{13}_[0-9a-f-]{36}$/).optional(),
  })
  .strict();

const BYPASS_EXISTS = sql`EXISTS (SELECT 1 FROM ${endpointCodingSessionModes} m WHERE m.session_id = ${endpointCodingSessions.id} AND m.permission_mode = 'bypassPermissions' AND ${endpointCodingSessions.agent} IN ('claude-code', 'codex'))`;

/** coding-agent sessions, newest activity first, with their modes and whether each is a permission-bypass finding */
export async function listCodingSessions(db: Db, q: z.infer<typeof sessionsQuery>) {
  const conds: SQL[] = [];
  if (q.agent) conds.push(eq(endpointCodingSessions.agent, q.agent));
  if (q.deviceId) conds.push(eq(endpointAgentIdentities.deviceId, q.deviceId));
  if (q.bypass === "true") conds.push(BYPASS_EXISTS);
  if (q.bypass === "false") conds.push(sql`NOT ${BYPASS_EXISTS}`);
  if (q.before) {
    const [ms, id] = q.before.split("_") as [string, string];
    const at = new Date(Number(ms));
    conds.push(or(lt(endpointCodingSessions.lastSeenAt, at), and(eq(endpointCodingSessions.lastSeenAt, at), lt(endpointCodingSessions.id, id)))!);
  }
  const rows = await db
    .select({
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
    })
    .from(endpointCodingSessions)
    .innerJoin(endpointAgentIdentities, eq(endpointAgentIdentities.identityId, endpointCodingSessions.identityId))
    .innerJoin(endpointDevices, eq(endpointDevices.id, endpointAgentIdentities.deviceId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(endpointCodingSessions.lastSeenAt), desc(endpointCodingSessions.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const modes = page.length
    ? await db
        .select({ sessionId: endpointCodingSessionModes.sessionId, permissionMode: endpointCodingSessionModes.permissionMode, firstSeenAt: endpointCodingSessionModes.firstSeenAt, lastSeenAt: endpointCodingSessionModes.lastSeenAt })
        .from(endpointCodingSessionModes)
        .where(inArray(endpointCodingSessionModes.sessionId, page.map((r) => r.id)))
    : [];
  const sessions = page.map((r) => {
    const own = modes.filter((m) => m.sessionId === r.id).sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime());
    const reported = modeReported(r.agent);
    const bypass = reported && own.some((m) => m.permissionMode === PERMISSION_MODE_BYPASS[r.agent]);
    return {
      id: r.id,
      agent: r.agent,
      sessionIdentified: r.sessionRef !== null,
      device: { id: r.deviceId, pseudonym: r.devicePseudonym, userPseudonym: r.deviceUserPseudonym },
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      counts: { decisions: r.decisions, denies: r.denies, asks: r.asks, wouldDenies: r.wouldDenies, wouldAsks: r.wouldAsks },
      permissionModeReported: reported,
      permissionModes: own.map((m) => ({ mode: m.permissionMode, firstSeenAt: m.firstSeenAt.toISOString(), lastSeenAt: m.lastSeenAt.toISOString() })),
      // null when the agent does not report its mode: unknown, never "not bypassed" (ADR-0180)
      permissionBypass: reported ? bypass : null,
      finding: bypass ? "permission_bypass" : null,
    };
  });
  const last = page[page.length - 1];
  return {
    sessions,
    next: rows.length > q.limit && last ? `${last.lastSeenAt.getTime()}_${last.id}` : null,
    coverage: ENDPOINT_HOOK_AGENTS.map((a) => ({
      agent: a,
      permissionModeReported: modeReported(a),
      note: modeReported(a)
        ? `${a} reports its permission mode in every hook call; ${PERMISSION_MODE_BYPASS[a]} is a permission-bypass session`
        : `${a} does not report its permission mode to hooks, so a permission-bypass session cannot be seen; its hook decisions are still audited`,
    })),
  };
}

export const tamperQuery = z
  .object({
    deviceId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** keyset cursor over device user identities: the `next` of the previous page */
    before: z.string().uuid().optional(),
  })
  .strict();

/** the managed files whose bundle copy is delivered as a file, so the device's bytes can match an exported bundle */
const BUNDLE_FILE_OF: Partial<Record<(typeof ENDPOINT_MANAGED_FILES)[number], string>> = {
  "claude-code/managed-settings.json": "claude-code/managed-settings.json",
  "openai-codex/requirements.toml": "openai-codex/requirements.toml",
};

export type FileStatus = "intact" | "changed" | "hook_missing" | "hook_weakened" | "file_missing" | "unreadable" | "not_system_owned";

/**
 * Per device user, the latest state of each managed file and whether it changed. "changed" means the device has
 * reported more than one state for the file, and the latest is not the first. The hook is the control: a missing or
 * weakened hook registration is a finding of its own. Restore is a later step and needs admin approval.
 */
export async function managedSettingsTamper(db: Db, q: z.infer<typeof tamperQuery>) {
  const conds: SQL[] = [];
  if (q.deviceId) conds.push(eq(endpointAgentIdentities.deviceId, q.deviceId));
  if (q.before) conds.push(lt(endpointAgentIdentities.identityId, q.before));
  // identities that reported at least one managed-file observation
  conds.push(sql`EXISTS (SELECT 1 FROM ${endpointManagedFileObservations} o WHERE o.identity_id = ${endpointAgentIdentities.identityId})`);
  const ids = await db
    .select({ identityId: endpointAgentIdentities.identityId, deviceId: endpointAgentIdentities.deviceId, devicePseudonym: endpointDevices.devicePseudonym, deviceUserPseudonym: endpointAgentIdentities.deviceUserPseudonym })
    .from(endpointAgentIdentities)
    .innerJoin(endpointDevices, eq(endpointDevices.id, endpointAgentIdentities.deviceId))
    .where(and(...conds))
    .orderBy(desc(endpointAgentIdentities.identityId))
    .limit(q.limit + 1);
  const page = ids.slice(0, q.limit);
  const obs = page.length
    ? await db.select().from(endpointManagedFileObservations).where(inArray(endpointManagedFileObservations.identityId, page.map((r) => r.identityId)))
    : [];
  // the exported bundles' hashes per bundle file, newest version first
  const exported = await db
    .select({ path: managedSettingsBundleFiles.path, sha256: managedSettingsBundleFiles.sha256, bundleId: managedSettingsBundles.id, version: managedSettingsBundles.version, createdAt: managedSettingsBundles.createdAt })
    .from(managedSettingsBundleFiles)
    .innerJoin(managedSettingsBundles, eq(managedSettingsBundles.id, managedSettingsBundleFiles.bundleId))
    .where(inArray(managedSettingsBundleFiles.path, Object.values(BUNDLE_FILE_OF) as string[]));
  let findings = 0;
  const devices = page.map((d) => {
    const files = ENDPOINT_MANAGED_FILES.map((file) => {
      const mine = obs.filter((o) => o.identityId === d.identityId && o.file === file).sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime() || a.firstSeenAt.getTime() - b.firstSeenAt.getTime());
      if (mine.length === 0) return { file, status: "not_reported" as const, finding: false };
      const latest = mine[mine.length - 1]!;
      const first = mine.reduce((a, b) => (b.firstSeenAt < a.firstSeenAt ? b : a));
      const changed = mine.length > 1 && latest.id !== first.id;
      const status: FileStatus =
        latest.state === "missing" ? "file_missing"
        : latest.state === "unreadable" ? "unreadable"
        : latest.state === "not_system_owned" ? "not_system_owned"
        : latest.hookStatus === "absent" || latest.hookStatus === "unparseable" ? "hook_missing"
        : latest.hookStatus === "weakened" ? "hook_weakened"
        : changed ? "changed"
        : "intact";
      const bundlePath = BUNDLE_FILE_OF[file];
      const match = bundlePath && latest.sha256 ? exported.filter((x) => x.path === bundlePath && x.sha256 === latest.sha256).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] : undefined;
      // a missing file is a finding only once the device had reported it present (a vendor not deployed is not tamper)
      const finding = status !== "intact" && !(status === "file_missing" && !mine.some((m) => m.state === "present"));
      if (finding) findings++;
      return {
        file,
        status,
        finding,
        state: latest.state,
        sha256: latest.sha256,
        hookStatus: latest.hookStatus,
        firstSeenAt: latest.firstSeenAt.toISOString(),
        lastSeenAt: latest.lastSeenAt.toISOString(),
        statesSeen: mine.length,
        // compared only for the files a bundle delivers as a file; null when there is nothing to compare against
        bundleMatch: bundlePath ? (latest.sha256 ? (match ? { bundleId: match.bundleId, version: match.version } : "none") : null) : null,
      };
    });
    return { device: { id: d.deviceId, pseudonym: d.devicePseudonym, userPseudonym: d.deviceUserPseudonym }, identityId: d.identityId, files };
  });
  const last = page[page.length - 1];
  return {
    devices,
    findings,
    next: ids.length > q.limit && last ? last.identityId : null,
    note: "Tamper is measured from what each device reports: a device that stops reporting shows its last state. Restoring a changed file is a later step and needs admin approval.",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Routes (admin-only by the app-level default: neither is in NON_ADMIN_ROUTES)
// ---------------------------------------------------------------------------------------------------------------------

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

export function registerEndpointDecisionRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/endpoint-decisions/sessions", async (req, reply) => {
    const q = sessionsQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send({ error: "invalid_query", detail: issues(q.error) });
    return listCodingSessions(db, q.data);
  });
  app.get("/v1/endpoint-decisions/tamper", async (req, reply) => {
    const q = tamperQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send({ error: "invalid_query", detail: issues(q.error) });
    return managedSettingsTamper(db, q.data);
  });
}
