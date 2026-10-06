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
 * OPEN SOURCE FIRST (ADR-0176): nothing to adopt — this is RegulAIt policy
 * (which agents a regulatory hold covers) over our own tables; the traversal
 * is one recursive CTE in Postgres.
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
