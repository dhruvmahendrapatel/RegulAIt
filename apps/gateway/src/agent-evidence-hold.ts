/**
 * ADR-0182 A12 (D4 review fix DFX2, D4G-02 / D4G-05) — THE Art. 73(6) EVIDENCE
 * HOLD AT EVERY AGENT-CONFIGURATION WRITE, including the agents a change
 * reaches indirectly.
 *
 * `incidentEvidenceHoldRefused` (incidents.ts) decides for ONE agent id: is a
 * serious incident whose authority report is still pending linked to it (or
 * to a use case whose approved stack names it)? It is keyed on that exact id,
 * so a change could alter a held agent through something it is built on:
 *
 *   - a registry agent is the model a builder agent runs on
 *     (`builder_agents.model_agent_id`): changing the registry agent's prompt,
 *     model or prices changes every builder agent on it;
 *   - a builder agent is a sub-agent its parents delegate to
 *     (`builder_agent_subagents`): changing the child changes every parent.
 *
 * THE RULE HERE: a change to agent X is held when X, or anything that
 * DEPENDS on X (transitively: the builder agents running on it, their parents,
 * and so on), is held. The refusal, the 409 `incident_evidence_hold`, the
 * admin-only override header and its audit rows and timeline notes are
 * exactly incidents.ts's — this file only widens WHICH ids are asked, so
 * there is one hold and one override path, not two.
 *
 * X15-H01 — THE CHECK AND THE WRITE ARE ONE TRANSACTION, SERIALISED WITH
 * HOLD CREATION. A check made outside the write's transaction let a write that
 * had passed it (and then waited, e.g. on the agent row's lock) commit after a
 * serious incident's hold began, with no refusal and no override record. Now:
 *
 *   - every protected write runs inside `withAgentEvidenceHold`, whose
 *     transaction FIRST takes `EVIDENCE_HOLD_LOCK_KEY` (shared), then re-asks
 *     the hold (this request's already-overridden incidents are not asked
 *     twice), then writes;
 *   - every transaction that can begin or widen a hold (opening an incident,
 *     linking an agent, marking it serious, containment, a clock move, a use
 *     case's intended agents, a new dependency edge) FIRST takes the same key
 *     exclusively (`lockEvidenceHoldsExclusive`).
 *
 * So a hold cannot commit while an admitted write is in flight (the write is
 * ordered before it), and a write waiting behind a hold-creating transaction
 * re-checks after it commits (and is refused, or overridden and audited in
 * the write's own transaction). One global key, like ADR-0060's audit chain:
 * shared holders never wait on each other, and hold creation is rare. LOCK
 * ORDER: this key is the FIRST lock of any transaction that takes it — before
 * row locks and before the audit-chain key — so it cannot form a cycle.
 *
 * OPEN SOURCE FIRST (ADR-0176): nothing to adopt — this is RegulAIt policy
 * (which agents a regulatory hold covers) over our own tables; the traversal
 * is one recursive CTE in Postgres and the serialisation is Postgres's own
 * transaction-scoped advisory lock.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { sql, type Db } from "@regulait/db";
// incidents.ts is imported LAZILY, at call time (FA10, ADR-0180). This module is imported by config-versions.ts,
// which sits on inventory.ts's own import chain (inventory → risks → … → rule-writes → config-versions); a static edge
// to incidents.ts (→ use-cases / builder-access → agents-connectors → mrm → mrm-autofill, which reads inventory's
// INVENTORY_WINDOW_DAYS at load) made `import "inventory.js"` first die with a TDZ ReferenceError
// (adr0180-load-order.test.ts).
const incidents = () => import("./incidents.js");
import { loadOrgSettings } from "./org-settings.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * X15-H01: the advisory-lock key hold creators (exclusive) and protected
 * writes (shared) serialise on. Distinct from the other production keys
 * (audit chain 6_000_000_060, health-probe claim 6_000_000_037, sign-in
 * invariant 6_000_000_174); 182 is the ADR number, and the value is outside int4 so it
 * cannot collide with a `hashtext(...)` key.
 */
export const EVIDENCE_HOLD_LOCK_KEY = 6_000_000_182;

/** take the hold lock as the FIRST statement of a transaction that can begin or widen an evidence hold */
export async function lockEvidenceHoldsExclusive(tx: Db): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${EVIDENCE_HOLD_LOCK_KEY}::bigint)`);
}

/** what `withAgentEvidenceHold` returns when the hold refused the change (the reply is sent) */
export const EVIDENCE_HOLD_REFUSED: unique symbol = Symbol("evidence-hold-refused");

/**
 * `agentId` and every agent that depends on it, transitively: builder agents
 * whose model is it, and builder agents that use it as a sub-agent. Ids are
 * `agents.id` or `builder_agents.id` (an incident link names either). The
 * requested id comes first.
 */
export async function agentAndDependents(db: Db, agentId: string): Promise<string[]> {
  if (!UUID_RE.test(agentId)) return [agentId];
  const res = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE dep(id) AS (
      SELECT ${agentId}::uuid
      UNION
      SELECT x.id FROM dep d
      JOIN LATERAL (
        SELECT b.id FROM builder_agents b WHERE b.model_agent_id = d.id
        UNION ALL
        SELECT s.parent_id FROM builder_agent_subagents s WHERE s.child_id = d.id
      ) x ON true
    )
    SELECT id::text AS id FROM dep
  `);
  const ids = res.rows.map((r) => r.id);
  return [agentId, ...ids.filter((i) => i !== agentId)];
}

/**
 * The evidence hold for a change to one or more agents. Call it BEFORE the
 * change is written; when it returns true the refusal has been sent and the
 * handler returns `reply`:
 *
 *   if (await agentEvidenceHoldRefused(db, req, reply, agent.id, "sub-agents")) return reply;
 *
 * `includeSelf: false` asks only about the dependents (archiving an agent is
 * containment for the agent itself, but it removes it from its parents).
 */
export async function agentEvidenceHoldRefused(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  agentIds: string | readonly string[],
  change: string,
  opts: { includeSelf?: boolean } = {},
): Promise<boolean> {
  const roots = [...new Set(typeof agentIds === "string" ? [agentIds] : agentIds)];
  if (roots.length === 0) return false;
  const org = await loadOrgSettings(db);
  if (!org.incidentEvidenceHold) return false;
  const includeSelf = opts.includeSelf ?? true;
  const covered = new Set<string>();
  const asked = new Set<string>();
  for (const root of roots) {
    const ids = await agentAndDependents(db, root);
    for (const id of ids) {
      if (id === root && !includeSelf) continue;
      if (asked.has(id)) continue;
      asked.add(id);
      const { incidentEvidenceHoldRefused, incidentsHoldingAgent } = await incidents();
      const holding = await incidentsHoldingAgent(db, id);
      // an incident already answered (refused or overridden) for another id is not asked twice
      if (holding.length === 0 || holding.every((h) => covered.has(h.id))) continue;
      const what = id === root ? change : `${change} of agent ${root}, which agent ${id} is built on (its model or a sub-agent)`;
      if (await incidentEvidenceHoldRefused(db, req, reply, id, what)) return true;
      for (const h of holding) covered.add(h.id);
    }
  }
  return false;
}

/**
 * X15-H01 — run a protected write under the evidence hold, in ONE transaction:
 * the hold lock (shared, or exclusive when the write adds a dependency edge
 * that widens who a hold covers), the hold re-checked inside the transaction,
 * then `write(tx)`. Returns `EVIDENCE_HOLD_REFUSED` when the hold refused (its
 * audit row has committed, then the 409/403/422 is sent); the handler returns `reply`.
 * The route's own `agentEvidenceHoldRefused` pre-check stays where it is (its
 * refusal comes before validation); this closes the window between it and the
 * commit. `write` must use the `tx` it is given for EVERY statement — a write
 * on another connection could wait on a lock this transaction holds.
 */
export async function withAgentEvidenceHold<T>(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  agentIds: string | readonly string[],
  change: string,
  write: (tx: Db) => Promise<T>,
  opts: { includeSelf?: boolean; widensHolds?: boolean } = {},
): Promise<T | typeof EVIDENCE_HOLD_REFUSED> {
  // The refusal is decided (and its deny audit row written) INSIDE the transaction, but SENT only after the
  // transaction commits: a refusal sent from inside it reached the caller before its audit row was durable
  // (or at all, had the commit failed), and a reader acting on the 409 could not see the row yet.
  let refusal: { status: number; body: unknown } | null = null;
  const deferred = {
    status: (status: number) => ({
      send: (body: unknown) => {
        refusal = { status, body };
      },
    }),
  } as unknown as FastifyReply;
  const out = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    if (opts.widensHolds) await lockEvidenceHoldsExclusive(tx);
    else await tx.execute(sql`select pg_advisory_xact_lock_shared(${EVIDENCE_HOLD_LOCK_KEY}::bigint)`);
    if (await agentEvidenceHoldRefused(tx, req, deferred, agentIds, change, { includeSelf: opts.includeSelf ?? true })) {
      return EVIDENCE_HOLD_REFUSED;
    }
    return write(tx);
  });
  if (out === EVIDENCE_HOLD_REFUSED) {
    const sent = refusal as { status: number; body: unknown } | null;
    if (!sent) throw new Error("evidence hold refused without a response");
    void reply.status(sent.status).send(sent.body);
  }
  return out;
}
