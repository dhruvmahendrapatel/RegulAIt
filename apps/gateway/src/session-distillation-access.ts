/**
 * ADR-0316 — who may read a distilled Shared Project context revision.
 *
 * A distilled revision is derived from a person's governed agent session. The author shared it on purpose, but the
 * session can carry what only the author's entitlements let them see: the output of agents others may not use, and
 * shared context from other projects. So a reader sees a distilled revision only when they could already read every
 * input it was derived from:
 *
 *   - every agent whose output the distilled turns carry: the reader's own agent decision must allow it, evaluated
 *     now through the same `agentDecision` an ordinary chat turn takes (grants, revocations, tier ceiling, posture);
 *   - every shared context revision the author declared the session drew on: the reader must be a viewer of that
 *     revision's project (or an admin), and when that input is itself distilled, the same check applies to it.
 *
 * The author always reads their own revision. A request with no user (the bootstrap token) reads none. An input that
 * no longer exists (a deleted agent or project) fails the check closed: deleting something never widens who reads.
 * Everything else in the store (ordinary contributions) is untouched by this check.
 */
import {
  agents,
  and,
  eq,
  inArray,
  projectContextDistillationAgents,
  projectContextDistillationContextInputs,
  projectContextDistillations,
  projectContextItems,
  projectMembers,
  type Db,
} from "@regulait/db";
import { agentDecision } from "./copilot.js";
import type { AgentRow } from "./agents-connectors.js";
import type { ContextReader, ContextReadFilter } from "./projects.js";

/** a chain of distilled-from-distilled inputs deeper than this is withheld rather than walked further */
const MAX_INPUT_DEPTH = 4;

/** One reader's view of distilled revisions, with its agent and project lookups cached for the request. */
function readerScope(db: Db, reader: ContextReader) {
  const agentAllowed = new Map<string, Promise<boolean>>();
  const projectReadable = new Map<string, Promise<boolean>>();

  const mayUseAgent = (agentId: string): Promise<boolean> => {
    let p = agentAllowed.get(agentId);
    if (!p) {
      p = (async () => {
        if (!reader.userId) return false;
        const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
        if (!row) return false;
        return (await agentDecision(db, reader.userId, row as AgentRow)).effect === "allow";
      })();
      agentAllowed.set(agentId, p);
    }
    return p;
  };
  const mayReadProject = (projectId: string): Promise<boolean> => {
    let p = projectReadable.get(projectId);
    if (!p) {
      p = (async () => {
        if (reader.isAdmin) return true;
        if (!reader.userId) return false;
        const [m] = await db
          .select({ id: projectMembers.id })
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, reader.userId)));
        return Boolean(m);
      })();
      projectReadable.set(projectId, p);
    }
    return p;
  };

  /** may this reader read content derived from these agents' output and these context revisions? */
  async function mayReadInputs(
    agentIds: readonly string[],
    inputItemIds: readonly string[],
    depth: number,
  ): Promise<boolean> {
    // a distillation always records at least its session's agent; none recorded is malformed, so withhold it
    if (!reader.userId || agentIds.length === 0) return false;
    for (const agentId of agentIds) if (!(await mayUseAgent(agentId))) return false;
    if (inputItemIds.length === 0) return true;
    const items = await db
      .select({ id: projectContextItems.id, projectId: projectContextItems.projectId })
      .from(projectContextItems)
      .where(inArray(projectContextItems.id, [...inputItemIds]));
    if (items.length !== new Set(inputItemIds).size) return false;
    for (const item of items) if (!(await mayReadProject(item.projectId))) return false;
    const hiddenInputs = await hidden(items.map((i) => i.id), depth + 1);
    return hiddenInputs.size === 0;
  }

  async function hidden(ids: readonly string[], depth: number): Promise<Set<string>> {
    const out = new Set<string>();
    if (ids.length === 0) return out;
    const distilled = await db
      .select({
        id: projectContextDistillations.id,
        itemId: projectContextDistillations.contextItemId,
        authorId: projectContextItems.contributedByUserId,
      })
      .from(projectContextDistillations)
      .innerJoin(projectContextItems, eq(projectContextItems.id, projectContextDistillations.contextItemId))
      .where(inArray(projectContextDistillations.contextItemId, [...ids]));
    // the author always reads their own revision; the bootstrap token (no user) reads none
    const others = distilled.filter((d) => !reader.userId || d.authorId !== reader.userId);
    if (others.length === 0) return out;
    if (!reader.userId || depth > MAX_INPUT_DEPTH) {
      for (const d of others) out.add(d.itemId);
      return out;
    }
    const distillationIds = others.map((d) => d.id);
    const [agentRows, inputRows] = await Promise.all([
      db
        .select()
        .from(projectContextDistillationAgents)
        .where(inArray(projectContextDistillationAgents.distillationId, distillationIds)),
      db
        .select()
        .from(projectContextDistillationContextInputs)
        .where(inArray(projectContextDistillationContextInputs.distillationId, distillationIds)),
    ]);
    for (const d of others) {
      const agentIds = agentRows.filter((a) => a.distillationId === d.id).map((a) => a.agentId);
      const inputs = inputRows.filter((r) => r.distillationId === d.id).map((r) => r.contextItemId);
      if (!(await mayReadInputs(agentIds, inputs, depth))) out.add(d.itemId);
    }
    return out;
  }

  return { hidden, mayReadInputs };
}

/** Returns the ids among `itemIds` that `reader` may not see. Only distilled revisions can be in the result. */
export function hiddenDistilledItems(
  db: Db,
  reader: ContextReader,
  itemIds: readonly string[],
): Promise<ReadonlySet<string>> {
  return readerScope(db, reader).hidden(itemIds, 0);
}

/** Before a distillation is written: may `reader` read content derived from these inputs? Used for the author's
 * declared context inputs and for the named arbiter a conflicting distilled revision would be routed to. */
export function mayReadDerivedContent(
  db: Db,
  reader: ContextReader,
  inputs: { agentIds: readonly string[]; contextItemIds: readonly string[] },
): Promise<boolean> {
  return readerScope(db, reader).mayReadInputs(inputs.agentIds, inputs.contextItemIds, 0);
}

/** the filter app.ts hands to the project routes */
export function distilledContextReadFilter(db: Db): ContextReadFilter {
  return (reader, itemIds) => hiddenDistilledItems(db, reader, itemIds);
}
