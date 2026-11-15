/**
 * ADR-0314 (G6): staging what an `agent_registry_*` scanner listed, and importing a staged record into the agent
 * inventory. The scanners are in `agent-registry-scanners.ts`; the routes in `agent-registry-routes.ts`.
 *
 * Staging runs inside the discovery run's fenced commit (`applyDiscoveryRunObservations`' `inCommit`), so records
 * land exactly when the run succeeds and never from a run that lost its lease.
 */
import { AGENT_REGISTRIES_BY_KIND, DISCOVERY_PSEUDONYM_PREFIX, type AgentRegistry, type DiscoverySourceKind } from "@regulait/shared";
import { agentRegistryRecords, and, eq, inArray, sql, type Db } from "@regulait/db";
import type { RegistryAgentRecord } from "./discovery-scanners.js";

/** at most this many records one run may stage (the scanners cap at 5,000 per listing) */
export const REGISTRY_RECORDS_MAX = 10_000;
const ATTR_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const ATTR_KEYS_MAX = 16;
const ATTR_STRING_MAX = 512;
const ATTR_LIST_MAX = 20;
const PSEUDONYM = new RegExp(`^${DISCOVERY_PSEUDONYM_PREFIX}[0-9a-f]{24}$`);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export class RegistryRecordRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryRecordRefused";
  }
}

const text = (v: unknown, min: number, max: number, what: string): string => {
  if (typeof v !== "string" || v.length < min || v.length > max || CONTROL.test(v)) throw new RegistryRecordRefused(`${what} must be ${min} to ${max} characters of text`);
  return v;
};

/**
 * Shape-check a run's registry records against its source kind (the scanner contract, enforced): a registry the kind
 * may not report, an oversized field, an unbounded attribute or a person's name (owners must be pseudonyms) refuses
 * the whole run. Duplicates (same registry and id) keep the first.
 */
export function checkRegistryAgents(kind: DiscoverySourceKind, records: readonly RegistryAgentRecord[] | undefined, complete: readonly AgentRegistry[] | undefined): { records: RegistryAgentRecord[]; complete: AgentRegistry[] } {
  const allowed = AGENT_REGISTRIES_BY_KIND[kind] ?? [];
  const list = records ?? [];
  if (list.length && allowed.length === 0) throw new RegistryRecordRefused(`a ${kind} source does not report registry agents`);
  if (list.length > REGISTRY_RECORDS_MAX) throw new RegistryRecordRefused(`at most ${REGISTRY_RECORDS_MAX} registry agents per run`);
  const seen = new Set<string>();
  const out: RegistryAgentRecord[] = [];
  for (const r of list) {
    if (!allowed.includes(r.registry)) throw new RegistryRecordRefused(`a ${kind} source may not report registry '${String(r.registry).slice(0, 40)}'`);
    const externalId = text(r.externalId, 1, 2048, "a registry agent's id");
    const displayName = text(r.displayName, 1, 256, "a registry agent's name");
    const description = r.description == null ? null : text(r.description, 0, 1000, "a registry agent's description");
    const attributes: NonNullable<RegistryAgentRecord["attributes"]> = {};
    const entries = Object.entries(r.attributes ?? {});
    if (entries.length > ATTR_KEYS_MAX) throw new RegistryRecordRefused(`at most ${ATTR_KEYS_MAX} attributes per registry agent`);
    for (const [k, v] of entries) {
      if (!ATTR_KEY.test(k)) throw new RegistryRecordRefused(`'${k.slice(0, 40)}' is not an attribute name`);
      if (v === null || typeof v === "boolean") attributes[k] = v;
      else if (typeof v === "string") attributes[k] = text(v, 0, ATTR_STRING_MAX, `attribute '${k}'`);
      else if (Array.isArray(v) && v.length <= ATTR_LIST_MAX) attributes[k] = v.map((x) => text(x, 0, ATTR_STRING_MAX, `attribute '${k}'`));
      else throw new RegistryRecordRefused(`attribute '${k}' must be text, a boolean, null or a list of at most ${ATTR_LIST_MAX} texts`);
    }
    // ADR-0195 decision 20: people only as pseudonyms
    if (attributes.owners !== undefined && !(Array.isArray(attributes.owners) && attributes.owners.every((o) => PSEUDONYM.test(o)))) {
      throw new RegistryRecordRefused("a registry agent's owners must be pseudonyms from ctx.pseudonymise");
    }
    const key = `${r.registry}\u0000${externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ registry: r.registry, externalId, displayName, description, attributes });
  }
  const completeOut = [...new Set(complete ?? [])].filter((c) => allowed.includes(c));
  return { records: out, complete: completeOut };
}

/** upsert a run's records for its source, and mark absent what a COMPLETE read of a registry no longer lists */
export async function stageRegistryRecords(t: Db, sourceId: string, runId: string, records: readonly RegistryAgentRecord[], complete: readonly AgentRegistry[]): Promise<{ staged: number; absent: number }> {
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500);
    await t
      .insert(agentRegistryRecords)
      .values(
        chunk.map((r) => ({
          sourceId,
          registry: r.registry,
          externalId: r.externalId,
          displayName: r.displayName,
          description: r.description ?? null,
          vendorAttributes: r.attributes ?? {},
          lastRunId: runId,
        })),
      )
      .onConflictDoUpdate({
        target: [agentRegistryRecords.sourceId, agentRegistryRecords.registry, agentRegistryRecords.externalId],
        set: {
          displayName: sql`excluded.display_name`,
          description: sql`excluded.description`,
          vendorAttributes: sql`excluded.vendor_attributes`,
          lastSeenAt: sql`now()`,
          absentSince: null,
          lastRunId: sql`excluded.last_run_id`,
        },
      });
  }
  let absent = 0;
  if (complete.length) {
    const gone = await t
      .update(agentRegistryRecords)
      .set({ absentSince: sql`COALESCE(${agentRegistryRecords.absentSince}, now())` })
      .where(and(eq(agentRegistryRecords.sourceId, sourceId), inArray(agentRegistryRecords.registry, [...complete]), sql`${agentRegistryRecords.lastRunId} IS DISTINCT FROM ${runId}`))
      .returning({ id: agentRegistryRecords.id });
    absent = gone.length;
  }
  return { staged: records.length, absent };
}
