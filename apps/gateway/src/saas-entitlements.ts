/**
 * ADR-0337 (lane E18): storing a SaaS entitlement read.
 *
 * An `entitlement_*` discovery source's scanner returns a `SaasEntitlementBatch`; the worker checks it
 * (`checkSaasEntitlementBatch`) and calls `persistEntitlementBatch` INSIDE the run's fenced completion transaction
 * (`applyDiscoveryRunObservations`'s `inCommit`), so the graph, the run's success and the audit row commit together or
 * not at all, and a worker that lost its lease writes nothing.
 *
 * Every row this transaction touches is stamped with the transaction's own `now()`, so "not seen by this run" is
 * exactly `last_seen_at < now()`:
 *  - a COMPLETE batch removes the source's grants (and user-consent principals) this run did not see: the vendor
 *    revoked them. Apps stay (an admin's agent link survives); an app with no grant left holds nothing.
 *  - a PARTIAL batch (a listing cut short, denied or capped) adds and refreshes only, and removes nothing it did not
 *    see, so a failed read can never look like a revocation. It applies the explicit revocations the reader saw.
 */
import {
  and,
  eq,
  inArray,
  sql,
  auditLog,
  discoveryPseudonyms,
  saasEntitlementApps,
  saasEntitlementGrantPrincipals,
  saasEntitlementGrants,
  saasEntitlementScopes,
  type Db,
  type SQL,
} from "@regulait/db";
import {
  SAAS_APP_AGENT_LINK_MACHINE,
  SAAS_ENTITLEMENT_SOURCE_PLATFORM,
  type SaasAppAgentLinkState,
  type SaasEntitlementBatch,
} from "@regulait/shared";
import { whereFrom } from "./state-transition.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
/** rows per INSERT, well under PostgreSQL's 65,535 bind parameters */
const CHUNK = 1000;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface EntitlementPersistOutcome {
  apps: number;
  scopes: number;
  grants: number;
  principals: number;
  grantsRemoved: number;
  principalsRemoved: number;
  /** principals named by the reader whose pseudonym row does not exist (never expected; counted, not stored) */
  principalsUnresolved: number;
  /** apps this run linked to an agent on an exact identifier match (each one audited) */
  autoLinked: number;
}

/** store one checked batch for one source and run, in the caller's transaction, with its audit row */
export async function persistEntitlementBatch(
  t: Db,
  ctx: { runId: string; sourceId: string; sourceName: string },
  batch: SaasEntitlementBatch,
): Promise<EntitlementPersistOutcome> {
  const out: EntitlementPersistOutcome = { apps: 0, scopes: 0, grants: 0, principals: 0, grantsRemoved: 0, principalsRemoved: 0, principalsUnresolved: 0, autoLinked: 0 };

  // 1. apps (one row per source and vendor id)
  const appIdByExternal = new Map<string, string>();
  for (const part of chunks(batch.apps)) {
    const rows = await t
      .insert(saasEntitlementApps)
      .values(
        part.map((a) => ({
          sourceId: ctx.sourceId,
          externalId: a.externalId,
          appKind: a.appKind,
          displayName: a.displayName,
          publisher: a.publisher,
          publisherVerified: a.publisherVerified,
          firstSeenAt: sql`now()`,
          lastSeenAt: sql`now()`,
          lastSeenRunId: ctx.runId,
        })),
      )
      .onConflictDoUpdate({
        target: [saasEntitlementApps.sourceId, saasEntitlementApps.externalId],
        set: {
          appKind: sql`excluded.app_kind`,
          displayName: sql`excluded.display_name`,
          publisher: sql`excluded.publisher`,
          publisherVerified: sql`excluded.publisher_verified`,
          lastSeenAt: sql`excluded.last_seen_at`,
          lastSeenRunId: sql`excluded.last_seen_run_id`,
        },
      })
      .returning({ id: saasEntitlementApps.id, externalId: saasEntitlementApps.externalId });
    for (const r of rows) appIdByExternal.set(r.externalId, r.id);
  }
  out.apps = appIdByExternal.size;

  // 2. the scope dictionary (platform, resource, name), shared by every source of the platform
  const scopeKey = (resource: string, name: string) => `${resource}\u0000${name}`;
  const wanted = new Map<string, { resource: string; name: string }>();
  for (const a of batch.apps) for (const g of a.grants) wanted.set(scopeKey(g.resource, g.scope), { resource: g.resource, name: g.scope });
  const scopeIdByKey = new Map<string, string>();
  for (const part of chunks([...wanted.values()])) {
    const rows = await t
      .insert(saasEntitlementScopes)
      .values(part.map((s) => ({ platform: batch.platform, resource: s.resource, name: s.name })))
      // a no-op update, so RETURNING gives the id of an existing row too
      .onConflictDoUpdate({ target: [saasEntitlementScopes.platform, saasEntitlementScopes.resource, saasEntitlementScopes.name], set: { name: sql`excluded.name` } })
      .returning({ id: saasEntitlementScopes.id, resource: saasEntitlementScopes.resource, name: saasEntitlementScopes.name });
    for (const r of rows) scopeIdByKey.set(scopeKey(r.resource, r.name), r.id);
  }
  out.scopes = scopeIdByKey.size;

  // 3. grants (app x scope x grant type), and the principals of user consents
  const grantRows: Array<{ appId: string; scopeId: string; grantType: "delegated" | "application"; consent: "tenant" | "user"; principals: string[] }> = [];
  for (const a of batch.apps) {
    const appId = appIdByExternal.get(a.externalId)!;
    for (const g of a.grants) grantRows.push({ appId, scopeId: scopeIdByKey.get(scopeKey(g.resource, g.scope))!, grantType: g.grantType, consent: g.consent, principals: g.principals });
  }
  const grantKey = (appId: string, scopeId: string, grantType: string) => `${appId}\u0000${scopeId}\u0000${grantType}`;
  const grantIdByKey = new Map<string, string>();
  for (const part of chunks(grantRows)) {
    const rows = await t
      .insert(saasEntitlementGrants)
      .values(part.map((g) => ({ appId: g.appId, scopeId: g.scopeId, grantType: g.grantType, consent: g.consent, firstSeenAt: sql`now()`, lastSeenAt: sql`now()`, lastSeenRunId: ctx.runId })))
      .onConflictDoUpdate({
        target: [saasEntitlementGrants.appId, saasEntitlementGrants.scopeId, saasEntitlementGrants.grantType],
        set: { consent: sql`excluded.consent`, lastSeenAt: sql`excluded.last_seen_at`, lastSeenRunId: sql`excluded.last_seen_run_id` },
      })
      .returning({ id: saasEntitlementGrants.id, appId: saasEntitlementGrants.appId, scopeId: saasEntitlementGrants.scopeId, grantType: saasEntitlementGrants.grantType });
    for (const r of rows) grantIdByKey.set(grantKey(r.appId, r.scopeId, r.grantType), r.id);
  }
  out.grants = grantIdByKey.size;

  // pseudonyms are already recorded by the worker's pseudonymise hook; resolve them to their row ids
  const pseudonyms = new Set<string>();
  for (const g of grantRows) for (const p of g.principals) pseudonyms.add(p);
  for (const r of batch.revokedPrincipals ?? []) pseudonyms.add(r.principal);
  const pseudonymId = new Map<string, string>();
  for (const part of chunks([...pseudonyms])) {
    const rows = await t.select({ id: discoveryPseudonyms.id, pseudonym: discoveryPseudonyms.pseudonym }).from(discoveryPseudonyms).where(inArray(discoveryPseudonyms.pseudonym, part));
    for (const r of rows) pseudonymId.set(r.pseudonym, r.id);
  }
  const principalRows: Array<{ grantId: string; pseudonymId: string }> = [];
  const tenantGrantIds: string[] = [];
  for (const g of grantRows) {
    const grantId = grantIdByKey.get(grantKey(g.appId, g.scopeId, g.grantType))!;
    if (g.consent === "tenant") tenantGrantIds.push(grantId);
    for (const p of g.principals) {
      const id = pseudonymId.get(p);
      if (id) principalRows.push({ grantId, pseudonymId: id });
      else out.principalsUnresolved += 1;
    }
  }
  for (const part of chunks(principalRows)) {
    await t
      .insert(saasEntitlementGrantPrincipals)
      .values(part.map((p) => ({ ...p, firstSeenAt: sql`now()`, lastSeenAt: sql`now()` })))
      .onConflictDoUpdate({ target: [saasEntitlementGrantPrincipals.grantId, saasEntitlementGrantPrincipals.pseudonymId], set: { lastSeenAt: sql`excluded.last_seen_at` } });
  }
  out.principals = principalRows.length;
  // a grant that is now tenant-wide names nobody (its consent covers every user)
  for (const part of chunks(tenantGrantIds)) {
    const del = await t.delete(saasEntitlementGrantPrincipals).where(inArray(saasEntitlementGrantPrincipals.grantId, part)).returning({ g: saasEntitlementGrantPrincipals.grantId });
    out.principalsRemoved += del.length;
  }

  // 4. explicit revocations the reader saw (a user revoked an app): the user leaves every grant of that app
  for (const r of batch.revokedPrincipals ?? []) {
    const pid = pseudonymId.get(r.principal);
    if (!pid) continue;
    const del = await t.execute(sql`
      DELETE FROM saas_entitlement_grant_principals p
       USING saas_entitlement_grants g, saas_entitlement_apps a
       WHERE p.grant_id = g.id AND g.app_id = a.id AND a.source_id = ${ctx.sourceId} AND a.external_id = ${r.externalId}
         AND p.pseudonym_id = ${pid} AND p.last_seen_at < now()`);
    out.principalsRemoved += del.rowCount ?? 0;
  }

  // 5. a complete read removes what it did not see; a partial one never does
  if (batch.complete) {
    const p = await t.execute(sql`
      DELETE FROM saas_entitlement_grant_principals p
       USING saas_entitlement_grants g, saas_entitlement_apps a
       WHERE p.grant_id = g.id AND g.app_id = a.id AND a.source_id = ${ctx.sourceId} AND p.last_seen_at < now()`);
    out.principalsRemoved += p.rowCount ?? 0;
    const g = await t.execute(sql`
      DELETE FROM saas_entitlement_grants g
       USING saas_entitlement_apps a
       WHERE g.app_id = a.id AND a.source_id = ${ctx.sourceId} AND g.last_seen_at < now()`);
    out.grantsRemoved += g.rowCount ?? 0;
  }
  // a user-consent grant nobody holds any more is gone, complete read or not
  const empty = await t.execute(sql`
    DELETE FROM saas_entitlement_grants g
     USING saas_entitlement_apps a
     WHERE g.app_id = a.id AND a.source_id = ${ctx.sourceId} AND g.consent = 'user'
       AND NOT EXISTS (SELECT 1 FROM saas_entitlement_grant_principals p WHERE p.grant_id = g.id)`);
  out.grantsRemoved += empty.rowCount ?? 0;

  // 6. an app whose vendor id exactly equals an identifier an admin declared for an agent is linked to it (audited)
  out.autoLinked = (await autoLinkApps(t, { sourceId: ctx.sourceId }, NIL_UUID)).length;

  await t.insert(auditLog).values({
    userId: NIL_UUID,
    objectType: "discovery_run",
    objectId: ctx.runId,
    detail: { subsystem: "saas-entitlements", sourceId: ctx.sourceId, platform: batch.platform, complete: batch.complete, ...out },
    effect: "allow",
    ruleId: "saas-entitlements-recorded",
    ruleChain: [],
    reason:
      `entitlement read of '${ctx.sourceName}' (${batch.platform}, ${batch.complete ? "complete" : "partial: nothing unseen was removed"}): ` +
      `${out.apps} app(s), ${out.grants} grant(s), ${out.principals} consenting user(s); ${out.grantsRemoved} grant(s) and ${out.principalsRemoved} user consent(s) removed`,
  });
  return out;
}

/** the apps a source holds, with their grants, for a test or a read route (bounded; never across sources) */
export async function loadSourceEntitlements(db: Db, sourceId: string) {
  return db
    .select({
      externalId: saasEntitlementApps.externalId,
      appKind: saasEntitlementApps.appKind,
      displayName: saasEntitlementApps.displayName,
      resource: saasEntitlementScopes.resource,
      scope: saasEntitlementScopes.name,
      grantType: saasEntitlementGrants.grantType,
      consent: saasEntitlementGrants.consent,
      principals: sql<number>`(SELECT count(*)::int FROM saas_entitlement_grant_principals p WHERE p.grant_id = ${saasEntitlementGrants.id})`,
    })
    .from(saasEntitlementGrants)
    .innerJoin(saasEntitlementApps, eq(saasEntitlementApps.id, saasEntitlementGrants.appId))
    .innerJoin(saasEntitlementScopes, eq(saasEntitlementScopes.id, saasEntitlementGrants.scopeId))
    .where(and(eq(saasEntitlementApps.sourceId, sourceId)))
    .orderBy(saasEntitlementApps.externalId, saasEntitlementScopes.resource, saasEntitlementScopes.name, saasEntitlementGrants.grantType)
    .limit(10_000);
}

// ---------------------------------------------------------------------------
// The agent link (owner decision 2026-11-17; ADR-0348 machine SAAS_APP_AGENT_LINK_MACHINE)
// ---------------------------------------------------------------------------

/** the platform a source kind reads, as SQL over discovery_sources.kind (the map is the shared vocabulary) */
const platformOfKindSql = (kind: SQL): SQL =>
  sql`CASE ${kind} ${sql.join(
    Object.entries(SAAS_ENTITLEMENT_SOURCE_PLATFORM).map(([k, p]) => sql`WHEN ${k} THEN ${p}`),
    sql` `,
  )} END`;

/** `state IN (...)`: the machine's guard for an event, so an out-of-order or concurrent write matches no row */
const inStates = (col: SQL, states: readonly SaasAppAgentLinkState[]): SQL => sql`${col} IN (${sql.join(states.map((x) => sql`${x}`), sql`, `)})`;

export interface AutoLink {
  appId: string;
  sourceId: string;
  externalId: string;
  agentId: string;
  identifierId: string;
}

/**
 * Link every unlinked (`none`) app whose vendor id EXACTLY (case-sensitive) equals an agent's declared identifier on
 * the app's platform, scoped to one source (after a read) or one identifier (when an admin declares it). An app an
 * admin unlinked is never auto-linked again. Each link writes its own audit row in the caller's transaction.
 */
export async function autoLinkApps(t: Db, scope: { sourceId: string } | { identifierId: string }, actorUserId: string): Promise<AutoLink[]> {
  const where = "sourceId" in scope ? sql`a.source_id = ${scope.sourceId}` : sql`i.id = ${scope.identifierId}`;
  const res = await t.execute(sql`
    UPDATE saas_entitlement_apps a
       SET agent_id = i.agent_id, agent_link_state = ${SAAS_APP_AGENT_LINK_MACHINE.next("none", "auto_link")}
      FROM agent_vendor_identifiers i, discovery_sources s, agents ag
     WHERE s.id = a.source_id AND i.external_id = a.external_id AND i.platform = ${platformOfKindSql(sql`s.kind`)}
       -- a retired agent is never linked (security review of #884, N4); its identifier stays, inert
       AND ag.id = i.agent_id AND ag.lifecycle_status <> 'retired'
       AND ${inStates(sql`a.agent_link_state`, SAAS_APP_AGENT_LINK_MACHINE.sourcesOf("auto_link"))}
       AND ${where}
    RETURNING a.id AS app_id, a.source_id, a.external_id, i.agent_id, i.id AS identifier_id`);
  const rows = ((res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[])) as Array<{
    app_id: string;
    source_id: string;
    external_id: string;
    agent_id: string;
    identifier_id: string;
  }>;
  const links = rows.map((r) => ({ appId: r.app_id, sourceId: r.source_id, externalId: r.external_id, agentId: r.agent_id, identifierId: r.identifier_id }));
  for (const part of chunks(links)) {
    await t.insert(auditLog).values(
      part.map((l) => ({
        userId: actorUserId,
        objectType: "saas_entitlement_app" as const,
        objectId: l.appId,
        detail: { subsystem: "saas-entitlements", sourceId: l.sourceId, externalId: l.externalId, agentId: l.agentId, identifierId: l.identifierId, from: "none", to: "auto" },
        effect: "allow" as const,
        ruleId: "saas-entitlement-agent-auto-linked",
        ruleChain: [],
        reason: `vendor app '${l.externalId}' auto-linked to agent ${l.agentId}: its id exactly equals an identifier declared for that agent`,
      })),
    );
  }
  return links;
}

export type AgentLinkChange =
  | { ok: true; appId: string; from: SaasAppAgentLinkState; to: SaasAppAgentLinkState; agentId: string | null }
  | { ok: false; status: 404 | 409; error: "not_found" | "illegal_transition"; detail: string };

/**
 * An admin links an app to an agent (`link`, any match) or removes its link (`unlink`), checked against the declared
 * machine and guarded in SQL, with its audit row, in the caller's transaction.
 */
export async function changeAgentLink(
  t: Db,
  args: { appId: string; event: "link"; agentId: string; actorUserId: string } | { appId: string; event: "unlink"; actorUserId: string },
): Promise<AgentLinkChange> {
  const [app] = await t
    .select({ id: saasEntitlementApps.id, state: saasEntitlementApps.agentLinkState, agentId: saasEntitlementApps.agentId, externalId: saasEntitlementApps.externalId, sourceId: saasEntitlementApps.sourceId })
    .from(saasEntitlementApps)
    .where(eq(saasEntitlementApps.id, args.appId))
    .for("update");
  if (!app) return { ok: false, status: 404, error: "not_found", detail: "no such entitlement app" };
  const m = SAAS_APP_AGENT_LINK_MACHINE;
  if (!m.can(app.state, args.event)) {
    const v = m.describe(app.state).transitions.find((x) => x.event === args.event);
    return { ok: false, status: 409, error: "illegal_transition", detail: v?.reason ?? `'${args.event}' is not allowed from '${app.state}'` };
  }
  const to = m.next(app.state, args.event);
  const agentId = args.event === "link" ? args.agentId : null;
  const updated = await t
    .update(saasEntitlementApps)
    .set({ agentLinkState: to, agentId })
    .where(and(eq(saasEntitlementApps.id, app.id), whereFrom(saasEntitlementApps.agentLinkState, m, args.event)))
    .returning({ id: saasEntitlementApps.id });
  if (updated.length !== 1) return { ok: false, status: 409, error: "illegal_transition", detail: "the link changed while this request ran: reload and repeat" };
  await t.insert(auditLog).values({
    userId: args.actorUserId,
    objectType: "saas_entitlement_app",
    objectId: app.id,
    detail: { subsystem: "saas-entitlements", sourceId: app.sourceId, externalId: app.externalId, from: app.state, to, fromAgentId: app.agentId, toAgentId: agentId },
    effect: "allow",
    ruleId: args.event === "link" ? "saas-entitlement-agent-linked" : "saas-entitlement-agent-unlinked",
    ruleChain: [],
    reason:
      args.event === "link"
        ? `vendor app '${app.externalId}' linked to agent ${agentId} by an admin (was ${app.state})`
        : `vendor app '${app.externalId}' unlinked from agent ${app.agentId} by an admin; it is not auto-linked again`,
  });
  return { ok: true, appId: app.id, from: app.state, to, agentId };
}
