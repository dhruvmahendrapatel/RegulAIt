/**
 * ADR-0314 (G6): staging what an `agent_registry_*` scanner listed, and importing a staged record into the agent
 * inventory. The scanners are in `agent-registry-scanners.ts`; the routes in `agent-registry-routes.ts`.
 *
 * Staging runs inside the discovery run's fenced commit (`applyDiscoveryRunObservations`' `inCommit`), so records
 * land exactly when the run succeeds and never from a run that lost its lease.
 */
import { AGENT_REGISTRIES_BY_KIND, DISCOVERY_PSEUDONYM_PREFIX, REGISTRY_COMPONENT_KINDS, REGISTRY_COMPONENT_PROVIDERS, type AgentRegistry, type DiscoverySourceKind } from "@regulait/shared";
import { agentRegistryRecordComponents, agentRegistryRecords, and, eq, inArray, isNotNull, isNull, sql, type Db, type SQL } from "@regulait/db";
import type { RegistryAgentComponent, RegistryAgentRecord } from "./discovery-scanners.js";

/**
 * A staged record's lifecycle, declared once (owner build rule 12). The state is derived from the row, never stored:
 *  - `open`:     staged and listed by the latest complete read; importable
 *  - `absent`:   a complete read no longer lists it (`absent_since` set); still importable, the admin sees why
 *  - `imported`: an agent row exists for it (`agent_id` set). Terminal for the record: `absent_since` keeps tracking
 *                the vendor side, but the state stays `imported` and the inventory row is never touched (owner R2)
 * Every write that moves a record names its move here; `canMoveRegistryRecord` is the only check.
 */
export const REGISTRY_RECORD_STATES = ["open", "absent", "imported"] as const;
export type RegistryRecordState = (typeof REGISTRY_RECORD_STATES)[number];
export const REGISTRY_RECORD_TRANSITIONS: Readonly<Record<RegistryRecordState, readonly RegistryRecordState[]>> = Object.freeze({
  open: ["absent", "imported"], // a complete run that no longer lists it; POST …/import (step-up)
  absent: ["open", "imported"], // a run that lists it again; POST …/import (step-up)
  imported: [], // terminal
});
export function registryRecordState(r: { agentId: string | null; absentSince: Date | null }): RegistryRecordState {
  return r.agentId ? "imported" : r.absentSince ? "absent" : "open";
}
export function canMoveRegistryRecord(from: RegistryRecordState, to: RegistryRecordState): boolean {
  return REGISTRY_RECORD_TRANSITIONS[from].includes(to);
}
/** the SQL predicate for each state, the same derivation as `registryRecordState` */
export const REGISTRY_RECORD_STATE_WHERE: Readonly<Record<RegistryRecordState, () => SQL | undefined>> = Object.freeze({
  open: () => and(isNull(agentRegistryRecords.agentId), isNull(agentRegistryRecords.absentSince)),
  absent: () => and(isNull(agentRegistryRecords.agentId), isNotNull(agentRegistryRecords.absentSince)),
  imported: () => isNotNull(agentRegistryRecords.agentId),
});

/** at most this many records one run may stage (the scanners cap at 5,000 per listing) */
export const REGISTRY_RECORDS_MAX = 10_000;
const ATTR_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const ATTR_KEYS_MAX = 16;
const ATTR_STRING_MAX = 512;
const ATTR_LIST_MAX = 20;
/** ADR-0336 decision 3: at most this many components per staged agent, and per run */
export const REGISTRY_COMPONENTS_PER_RECORD_MAX = 200;
export const REGISTRY_COMPONENTS_PER_RUN_MAX = 50_000;
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
  let componentCount = 0;
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
    const components = r.components === undefined ? undefined : checkComponents(r.components);
    if (components) componentCount += components.length;
    if (componentCount > REGISTRY_COMPONENTS_PER_RUN_MAX) throw new RegistryRecordRefused(`at most ${REGISTRY_COMPONENTS_PER_RUN_MAX} registry agent components per run`);
    out.push({ registry: r.registry, externalId, displayName, description, attributes, ...(components ? { components } : {}) });
  }
  const completeOut = [...new Set(complete ?? [])].filter((c) => allowed.includes(c));
  return { records: out, complete: completeOut };
}

/** ADR-0336 decision 3: bound one agent's components; duplicates (same kind and reference) keep the first */
function checkComponents(list: readonly RegistryAgentComponent[]): RegistryAgentComponent[] {
  if (!Array.isArray(list) || list.length > REGISTRY_COMPONENTS_PER_RECORD_MAX) throw new RegistryRecordRefused(`at most ${REGISTRY_COMPONENTS_PER_RECORD_MAX} components per registry agent`);
  const seen = new Set<string>();
  const out: RegistryAgentComponent[] = [];
  for (const c of list) {
    if (!(REGISTRY_COMPONENT_KINDS as readonly string[]).includes(c.kind)) throw new RegistryRecordRefused(`'${String(c.kind).slice(0, 40)}' is not a component kind`);
    const vendorRef = text(c.vendorRef, 1, 512, "a component's reference");
    const displayName = text(c.displayName, 1, 256, "a component's name");
    if (c.enabled != null && typeof c.enabled !== "boolean") throw new RegistryRecordRefused("a component's enabled flag must be a boolean or null");
    if (c.providedBy != null && !(REGISTRY_COMPONENT_PROVIDERS as readonly string[]).includes(c.providedBy)) throw new RegistryRecordRefused("a component's provider must be maker or end_user");
    const key = `${c.kind}\u0000${vendorRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: c.kind, vendorRef, displayName, enabled: c.enabled ?? null, providedBy: c.providedBy ?? null });
  }
  return out;
}

/** upsert a run's records for its source, and mark absent what a COMPLETE read of a registry no longer lists */
export async function stageRegistryRecords(t: Db, sourceId: string, runId: string, records: readonly RegistryAgentRecord[], complete: readonly AgentRegistry[]): Promise<{ staged: number; absent: number }> {
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500);
    const ids = await t
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
      })
      .returning({ id: agentRegistryRecords.id, registry: agentRegistryRecords.registry, externalId: agentRegistryRecords.externalId });
    await replaceComponents(t, chunk, ids);
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

/**
 * ADR-0336 decision 3, inside the run's fenced commit: for each record whose components were read completely
 * (`components` set), the stored set becomes exactly that set; a record read partially (`components` undefined)
 * keeps its stored set untouched.
 */
async function replaceComponents(t: Db, chunk: readonly RegistryAgentRecord[], ids: ReadonlyArray<{ id: string; registry: string; externalId: string }>): Promise<void> {
  const idOf = new Map(ids.map((x) => [`${x.registry}\u0000${x.externalId}`, x.id]));
  const complete = chunk.flatMap((r) => {
    const id = idOf.get(`${r.registry}\u0000${r.externalId}`);
    return id && r.components !== undefined ? [{ id, components: r.components }] : [];
  });
  if (!complete.length) return;
  await t.delete(agentRegistryRecordComponents).where(inArray(agentRegistryRecordComponents.recordId, complete.map((c) => c.id)));
  const rows = complete.flatMap((c) =>
    c.components.map((x) => ({ recordId: c.id, kind: x.kind, vendorRef: x.vendorRef, displayName: x.displayName, enabled: x.enabled ?? null, providedBy: x.providedBy ?? null })),
  );
  for (let i = 0; i < rows.length; i += 1000) await t.insert(agentRegistryRecordComponents).values(rows.slice(i, i + 1000));
}
