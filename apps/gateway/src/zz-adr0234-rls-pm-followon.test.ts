/**
 * ADR-0234 PM follow-on (pending migration `rls_pm_tables_followon`, layered on `rls_pm_tables`).
 *
 * Against a scratch database migrated to the head, every statement below runs as the non-owner `regulait_app` role
 * (the scope helpers switch to it), with NO application filter, and proves:
 *   - the closed registry is the same in SQL and TypeScript (this batch adds no reason);
 *   - decisions has row-level security ENABLED and FORCED; no context sees no decision and no link;
 *   - bob under `pm_sync` cannot read, create, update or delete alice's links, nor read or record her decisions;
 *   - a pending approver reads and never writes, and loses the read once the approval is decided, except for a
 *     decision he made himself; the decide path's own scope (`approval_maintenance`) still mirrors for him;
 *   - alice under `pm_sync` reads and writes her own; the column grant keeps a link's identity immutable;
 *   - pm_sync_events is append-only for the app role, and an admin's connection delete still cascades;
 *   - an admin sees every link and decision;
 *   - the gateway's own PM helpers (asPmSync) still work for the principal whose rows they touch.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  approvals,
  createDb,
  decisions,
  eq,
  governanceAlerts,
  orchestrationRuns,
  pmConnections,
  pmLinks,
  pmSyncEvents,
  RLS_SYSTEM_REASONS,
  runMigrations,
  runWithRlsPrincipal,
  runWithRlsPrincipalStep,
  runWithRlsSystem,
  sql,
  users,
  workflowInstances,
  type Db,
} from "@regulait/db";
import { asPmSync, governanceAlertTicket, governanceAlertTickets } from "./pm.js";
import { dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `rls0234pmf_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

let admin: Db;
let db: Db; // the scratch database on the suite's (owner) login; every scope switches to regulait_app
const ids = {
  alice: randomUUID(),
  bob: randomUUID(),
  carol: randomUUID(), // an active admin
  conn: randomUUID(),
  run: randomUUID(), // alice's run
  bobRun: randomUUID(),
  instance: randomUUID(), // alice's workflow instance
  runLink: randomUUID(),
  nodeLink: randomUUID(),
  instanceLink: randomUUID(),
  decisionLink: randomUUID(),
  bobDecisionLink: randomUUID(),
  alertLink: randomUUID(),
  decision: randomUUID(), // alice's decision on her run
  bobDecision: randomUUID(), // a decision bob made on alice's run (seeded: e.g. while he was an admin)
  pendingApproval: randomUUID(), // bob is the named approver on alice's run and instance
  alert: randomUUID(), // owned by bob
};

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message ?? String(e);
  }
  return "(no error)";
}
const linkIds = async () => (await db.select({ id: pmLinks.id }).from(pmLinks)).map((r) => r.id).sort();
const decisionIds = async () => (await db.select({ id: decisions.id }).from(decisions)).map((r) => r.id).sort();
const asPmSyncFor = <T>(userId: string, fn: () => Promise<T>) => runWithRlsPrincipalStep({ userId }, "pm_sync", "test.pm-sync", fn);
const asAlice = <T>(fn: () => Promise<T>) => asPmSyncFor(ids.alice, fn);
const asBob = <T>(fn: () => Promise<T>) => asPmSyncFor(ids.bob, fn);
const asCarol = <T>(fn: () => Promise<T>) => runWithRlsPrincipal({ userId: ids.carol }, fn);
const link = (over: Partial<typeof pmLinks.$inferInsert> = {}) => ({
  connectionId: ids.conn,
  objectType: "run_node" as const,
  objectId: ids.run,
  nodeId: `n-${randomUUID().slice(0, 8)}`,
  externalId: `EXT-${randomUUID().slice(0, 8)}`,
  externalUrl: "https://pm.invalid/item",
  ...over,
});
/** with bob's pending approval decided for the duration of `fn` */
async function approvalDecided<T>(fn: () => Promise<T>): Promise<T> {
  await db.update(approvals).set({ status: "approved", decidedBy: ids.bob }).where(eq(approvals.id, ids.pendingApproval));
  try {
    return await fn();
  } finally {
    await db.update(approvals).set({ status: "pending", decidedBy: null }).where(eq(approvals.id, ids.pendingApproval));
  }
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  // seeded outside any scope (the scratch login is the owner, as the migrator is)
  await db.insert(users).values([
    { id: ids.alice, email: `alice-${ids.alice}@rls.test`, displayName: "Alice" },
    { id: ids.bob, email: `bob-${ids.bob}@rls.test`, displayName: "Bob" },
    { id: ids.carol, email: `carol-${ids.carol}@rls.test`, displayName: "Carol", isAdmin: true },
  ]);
  const state = { nodeStatuses: {} };
  await db.insert(orchestrationRuns).values([
    { id: ids.run, name: "alice run", initiatingUserId: ids.alice, graph: { nodes: [] }, state },
    { id: ids.bobRun, name: "bob run", initiatingUserId: ids.bob, graph: { nodes: [] }, state },
  ]);
  await db.insert(workflowInstances).values({
    id: ids.instance, templateIds: [], definition: {}, initiatorUserId: ids.alice, change: {}, state: {}, status: "running",
  });
  await db.insert(pmConnections).values({ id: ids.conn, name: `rlspmf-${ids.conn.slice(0, 8)}`, provider: "mock", project: "P", tokenCiphertext: "x" });
  await db.insert(decisions).values([
    { id: ids.decision, objectType: "run", objectId: ids.run, decision: "go", decisionMakerUserId: ids.alice },
    { id: ids.bobDecision, objectType: "run", objectId: ids.run, decision: "noted", decisionMakerUserId: ids.bob },
  ]);
  await db.insert(governanceAlerts).values({
    id: ids.alert, ruleId: "rls0234pmf", subjectKey: ids.alert, severity: "high", title: "t", ownerUserId: ids.bob,
  });
  await db.insert(pmLinks).values([
    link({ id: ids.runLink, objectType: "run", nodeId: null }),
    link({ id: ids.nodeLink }),
    link({ id: ids.instanceLink, objectType: "workflow_instance", objectId: ids.instance, nodeId: null }),
    link({ id: ids.decisionLink, objectType: "decision", objectId: ids.decision, nodeId: null }),
    link({ id: ids.bobDecisionLink, objectType: "decision", objectId: ids.bobDecision, nodeId: null }),
    link({ id: ids.alertLink, objectType: "governance_alert" as never, objectId: ids.alert, nodeId: null }),
  ]);
  await db.insert(pmSyncEvents).values({ connectionId: ids.conn, externalId: "EXT-1", kind: "updated" });
  await db.insert(approvals).values({
    id: ids.pendingApproval, userId: ids.alice, approverUserId: ids.bob, runId: ids.run, instanceId: ids.instance, status: "pending",
  });
}, 180_000);

afterAll(async () => {
  await db?.$client.end().catch(() => undefined);
  if (admin) {
    await dropScratchDatabase(admin, SCRATCH_DB);
    await admin.$client.end().catch(() => undefined);
  }
});

describe("the registry and the inventory", () => {
  it("the SQL registry is exactly the TypeScript one, in order", async () => {
    const def = await db.execute<{ d: string }>(sql`select pg_catalog.pg_get_functiondef('public.regulait_rls_system_reason()'::regprocedure) as d`);
    const list = /ARRAY\[([^\]]*)\]/.exec(def.rows[0]!.d)![1]!;
    expect([...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...RLS_SYSTEM_REASONS]);
  });

  it("decisions has row-level security ENABLED and FORCED", async () => {
    const r = await db.execute<{ on: boolean; forced: boolean }>(sql`
      select relrowsecurity as on, relforcerowsecurity as forced from pg_class
       where relnamespace = 'public'::regnamespace and relname = 'decisions'`);
    expect(r.rows).toEqual([{ on: true, forced: true }]);
  });

  it("the app role's privileges: link identity, the inbound log and decisions are not rewritable", async () => {
    const r = await db.execute<Record<string, boolean>>(sql`
      select has_column_privilege('regulait_app', 'pm_links', 'last_synced_at', 'UPDATE') as sync,
             has_column_privilege('regulait_app', 'pm_links', 'orphaned_at', 'UPDATE') as orphan,
             has_column_privilege('regulait_app', 'pm_links', 'inbound_state', 'UPDATE') as inbound,
             has_column_privilege('regulait_app', 'pm_links', 'inbound_at', 'UPDATE') as inbound_at,
             has_column_privilege('regulait_app', 'pm_links', 'adopted_state', 'UPDATE') as adopted,
             has_column_privilege('regulait_app', 'pm_links', 'external_id', 'UPDATE') as ext,
             has_column_privilege('regulait_app', 'pm_links', 'connection_id', 'UPDATE') as conn,
             has_column_privilege('regulait_app', 'pm_links', 'object_id', 'UPDATE') as obj,
             has_table_privilege('regulait_app', 'pm_sync_events', 'UPDATE') as ev_upd,
             has_table_privilege('regulait_app', 'pm_sync_events', 'DELETE') as ev_del,
             has_table_privilege('regulait_app', 'pm_sync_events', 'TRUNCATE') as ev_trunc,
             has_table_privilege('regulait_app', 'pm_sync_events', 'INSERT') as ev_ins,
             has_table_privilege('regulait_app', 'decisions', 'UPDATE') as d_upd,
             has_table_privilege('regulait_app', 'decisions', 'DELETE') as d_del,
             has_table_privilege('regulait_app', 'decisions', 'TRUNCATE') as d_trunc`);
    expect(r.rows[0]).toEqual({
      sync: true, orphan: true, inbound: true, inbound_at: true, adopted: true, ext: false, conn: false, obj: false,
      ev_upd: false, ev_del: false, ev_trunc: false, ev_ins: true, d_upd: false, d_del: false, d_trunc: false,
    });
  });
});

describe("no context: zero rows, and no write", () => {
  it("as regulait_app with neither a principal nor a reason, decisions and pm_links are empty and inserts fail", async () => {
    const out = await db
      .transaction(async (tx) => {
        await tx.execute(sql`select set_config('role', 'regulait_app', true)`);
        const counts: Record<string, number> = {};
        for (const t of ["decisions", "pm_links"]) counts[t] = (await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${t}`))).rows[0]!.n;
        throw Object.assign(new Error("rollback"), { counts });
      })
      .catch((e: { counts?: Record<string, number> }) => e.counts);
    expect(out).toEqual({ decisions: 0, pm_links: 0 });
    const attempt = (stmt: string) =>
      pgError(
        db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('role', 'regulait_app', true)`);
          await tx.execute(sql.raw(stmt));
        }),
      );
    expect(await attempt(`insert into pm_links (connection_id, object_type, object_id, external_id, external_url) values ('${ids.conn}', 'run', '${ids.run}', 'E', 'u')`)).toMatch(/row-level security/);
    expect(await attempt(`insert into decisions (object_type, object_id, decision, decision_maker_user_id) values ('run', '${ids.run}', 'x', '${ids.alice}')`)).toMatch(/row-level security/);
  });

  it("a principal with no reason still sees no link (rls_pm_tables), but sees its own decisions", async () => {
    await runWithRlsPrincipal({ userId: ids.alice }, async () => {
      expect(await linkIds()).toEqual([]);
      expect(await decisionIds()).toEqual([ids.decision, ids.bobDecision].sort());
    });
  });
});

describe("bob under pm_sync against alice's rows, with no application filter", () => {
  it("cannot see alice's links or decisions (only the alert he owns, and the decision he made)", async () => {
    await approvalDecided(() =>
      asBob(async () => {
        expect(await linkIds()).toEqual([ids.alertLink, ids.bobDecisionLink].sort());
        expect(await decisionIds()).toEqual([ids.bobDecision]);
      }),
    );
  });

  it("cannot insert a link or a decision on alice's run, nor a decision in alice's name", async () => {
    await asBob(async () => {
      expect(await pgError(db.insert(pmLinks).values(link()))).toMatch(/row-level security/);
      expect(await pgError(db.insert(pmLinks).values(link({ objectType: "workflow_instance", objectId: ids.instance, nodeId: null })))).toMatch(/row-level security/);
      expect(await pgError(db.insert(pmLinks).values(link({ objectType: "decision", objectId: ids.decision, nodeId: null })))).toMatch(/row-level security/);
      expect(await pgError(db.insert(decisions).values({ objectType: "run", objectId: ids.run, decision: "x", decisionMakerUserId: ids.bob }))).toMatch(/row-level security/);
      expect(await pgError(db.insert(decisions).values({ objectType: "workflow_instance", objectId: ids.instance, decision: "x", decisionMakerUserId: ids.bob }))).toMatch(/row-level security/);
      expect(await pgError(db.insert(decisions).values({ objectType: "run", objectId: ids.bobRun, decision: "x", decisionMakerUserId: ids.alice }))).toMatch(/row-level security/);
      // the alert he owns is read-only to him (an admin, the scheduler or the decide path files its ticket)
      expect(await pgError(db.insert(pmLinks).values(link({ objectType: "governance_alert" as never, objectId: ids.alert, nodeId: null })))).toMatch(/row-level security/);
      // his own run is his to link and decide on
      const [own] = await db.insert(pmLinks).values(link({ objectId: ids.bobRun })).returning({ id: pmLinks.id });
      expect(own?.id).toBeTruthy();
      const [d] = await db.insert(decisions).values({ objectType: "run", objectId: ids.bobRun, decision: "ok", decisionMakerUserId: ids.bob }).returning({ id: decisions.id });
      expect(d?.id).toBeTruthy();
    });
  });

  it("cannot update or delete alice's link", async () => {
    await approvalDecided(() =>
      asBob(async () => {
        expect(await db.update(pmLinks).set({ lastSyncedAt: new Date() }).where(eq(pmLinks.id, ids.nodeLink)).returning({ id: pmLinks.id })).toEqual([]);
        expect(await db.delete(pmLinks).where(eq(pmLinks.id, ids.nodeLink)).returning({ id: pmLinks.id })).toEqual([]);
      }),
    );
    expect((await db.select({ id: pmLinks.id }).from(pmLinks).where(eq(pmLinks.id, ids.nodeLink))).length).toBe(1);
  });
});

describe("bob as the named approver of a pending approval on alice's run and instance", () => {
  it("reads the run's and the instance's links and decisions, and writes none of them", async () => {
    await asBob(async () => {
      expect(await linkIds()).toEqual(expect.arrayContaining([ids.runLink, ids.nodeLink, ids.instanceLink, ids.decisionLink]));
      expect(await decisionIds()).toEqual(expect.arrayContaining([ids.decision, ids.bobDecision]));
      expect(await db.update(pmLinks).set({ lastSyncedAt: new Date() }).where(eq(pmLinks.id, ids.nodeLink)).returning({ id: pmLinks.id })).toEqual([]);
      expect(await db.update(pmLinks).set({ lastSyncedAt: new Date() }).where(eq(pmLinks.id, ids.instanceLink)).returning({ id: pmLinks.id })).toEqual([]);
      expect(await db.delete(pmLinks).where(eq(pmLinks.id, ids.nodeLink)).returning({ id: pmLinks.id })).toEqual([]);
      expect(await pgError(db.insert(pmLinks).values(link()))).toMatch(/row-level security/);
      expect(await pgError(db.insert(decisions).values({ objectType: "run", objectId: ids.run, decision: "x", decisionMakerUserId: ids.bob }))).toMatch(/row-level security/);
    });
  });

  it("loses the read once the approval is decided, except for the decision he made", async () => {
    await approvalDecided(() =>
      asBob(async () => {
        const seen = await linkIds();
        for (const id of [ids.runLink, ids.nodeLink, ids.instanceLink, ids.decisionLink]) expect(seen).not.toContain(id);
        expect(seen).toContain(ids.bobDecisionLink);
        expect(await decisionIds()).not.toContain(ids.decision);
        expect(await decisionIds()).toContain(ids.bobDecision);
      }),
    );
  });

  it("the decide path's own scope (approval_maintenance as the decider) still mirrors a decided approval", async () => {
    // app.ts decideOneApproval runs the whole decision, the PM mirror included, as the decider under
    // approval_maintenance, so a decider who is not the initiator still updates the link's sync state
    await approvalDecided(() =>
      runWithRlsPrincipalStep({ userId: ids.bob }, "approval_maintenance", "test.decide-mirror", async () => {
        expect(await linkIds()).toEqual(expect.arrayContaining([ids.nodeLink, ids.instanceLink]));
        const upd = await db.update(pmLinks).set({ lastSyncedAt: new Date() }).where(eq(pmLinks.id, ids.nodeLink)).returning({ id: pmLinks.id });
        expect(upd).toEqual([{ id: ids.nodeLink }]);
      }),
    );
  });
});

describe("alice under pm_sync on her own", () => {
  it("reads and creates her own links and decisions, and updates sync state", async () => {
    await asAlice(async () => {
      expect(await linkIds()).toEqual(expect.arrayContaining([ids.runLink, ids.nodeLink, ids.instanceLink, ids.decisionLink, ids.bobDecisionLink]));
      expect(await linkIds()).not.toContain(ids.alertLink);
      const [l] = await db.insert(pmLinks).values(link()).returning({ id: pmLinks.id });
      expect(l?.id).toBeTruthy();
      const [d] = await db.insert(decisions).values({ objectType: "workflow_instance", objectId: ids.instance, decision: "ship", decisionMakerUserId: ids.alice }).returning({ id: decisions.id });
      expect(d?.id).toBeTruthy();
      // the decision's own mirror link, as POST /v1/decisions writes it
      const [dl] = await db.insert(pmLinks).values(link({ objectType: "decision", objectId: d!.id, nodeId: null })).returning({ id: pmLinks.id });
      expect(dl?.id).toBeTruthy();
      expect(await decisionIds()).toEqual(expect.arrayContaining([ids.decision, d!.id]));
      const upd = await db
        .update(pmLinks)
        .set({ lastSyncedAt: new Date(), orphanedAt: null, inboundState: "Active", inboundAt: new Date(), adoptedState: null })
        .where(eq(pmLinks.id, ids.nodeLink))
        .returning({ id: pmLinks.id });
      expect(upd.map((r) => r.id)).toEqual([ids.nodeLink]);
      // pm_sync deletes no link, even her own
      expect(await db.delete(pmLinks).where(eq(pmLinks.id, ids.nodeLink)).returning({ id: pmLinks.id })).toEqual([]);
    });
  });

  it("the column grant refuses an update of a link's external id or connection; a decision is never rewritten", async () => {
    await asAlice(async () => {
      expect(await pgError(db.update(pmLinks).set({ externalId: "HIJACK" }).where(eq(pmLinks.id, ids.nodeLink)))).toMatch(/permission denied/);
      expect(await pgError(db.update(pmLinks).set({ connectionId: randomUUID() }).where(eq(pmLinks.id, ids.nodeLink)))).toMatch(/permission denied/);
      expect(await pgError(db.update(decisions).set({ decision: "rewritten" }).where(eq(decisions.id, ids.decision)))).toMatch(/permission denied/);
      expect(await pgError(db.delete(decisions).where(eq(decisions.id, ids.decision)))).toMatch(/permission denied/);
    });
    // the same holds for an admin request: the grant is the app role's, whatever the policies admit
    await asCarol(async () => {
      expect(await pgError(db.update(pmLinks).set({ externalId: "HIJACK" }).where(eq(pmLinks.id, ids.nodeLink)))).toMatch(/permission denied/);
    });
  });
});

describe("pm_sync_events is append-only", () => {
  it("UPDATE and DELETE are denied to every scope, an admin's included; INSERT still works", async () => {
    for (const run of [asAlice, asCarol]) {
      await run(async () => {
        expect(await pgError(db.update(pmSyncEvents).set({ kind: "deleted" }))).toMatch(/permission denied/);
        expect(await pgError(db.delete(pmSyncEvents))).toMatch(/permission denied/);
      });
    }
    await runWithRlsSystem("approval_maintenance", "test.pm-webhook", async () => {
      const [ev] = await db.insert(pmSyncEvents).values({ connectionId: ids.conn, externalId: "EXT-2", kind: "commented" }).returning({ id: pmSyncEvents.id });
      expect(ev?.id).toBeTruthy();
    });
  });

  it("an admin's connection delete still cascades to its links and inbound log", async () => {
    const c2 = randomUUID();
    await asCarol(async () => {
      await db.insert(pmConnections).values({ id: c2, name: `rlspmf-c2-${c2.slice(0, 8)}`, provider: "mock", project: "P", tokenCiphertext: "x" });
    });
    await runWithRlsSystem("approval_maintenance", "test.pm-webhook", async () => {
      await db.insert(pmSyncEvents).values({ connectionId: c2, externalId: "E2", kind: "updated" });
    });
    await asAlice(async () => db.insert(pmLinks).values(link({ connectionId: c2 })));
    const left = async () => {
      const r = await db.execute<{ l: number; e: number }>(sql`
        select (select count(*) from pm_links where connection_id = ${c2})::int as l,
               (select count(*) from pm_sync_events where connection_id = ${c2})::int as e`);
      return r.rows[0];
    };
    expect(await left()).toEqual({ l: 1, e: 1 });
    await asCarol(async () => {
      expect(await db.delete(pmConnections).where(eq(pmConnections.id, c2)).returning({ id: pmConnections.id })).toEqual([{ id: c2 }]);
    });
    expect(await left()).toEqual({ l: 0, e: 0 });
  });
});

describe("an admin", () => {
  it("sees every link and every decision, and records a decision on another user's run", async () => {
    await asCarol(async () => {
      expect(await linkIds()).toEqual(expect.arrayContaining([ids.runLink, ids.nodeLink, ids.instanceLink, ids.decisionLink, ids.bobDecisionLink, ids.alertLink]));
      expect(await decisionIds()).toEqual(expect.arrayContaining([ids.decision, ids.bobDecision]));
      const [d] = await db.insert(decisions).values({ objectType: "run", objectId: ids.run, decision: "admin", decisionMakerUserId: ids.carol }).returning({ id: decisions.id });
      expect(d?.id).toBeTruthy();
      // never in someone else's name
      expect(await pgError(db.insert(decisions).values({ objectType: "run", objectId: ids.run, decision: "x", decisionMakerUserId: ids.alice }))).toMatch(/row-level security/);
    });
  });

  it("and so does an admin under pm_sync", async () => {
    await asPmSyncFor(ids.carol, async () => {
      expect(await linkIds()).toEqual(expect.arrayContaining([ids.runLink, ids.alertLink]));
    });
  });
});

describe("the gateway's own entry points (asPmSync) for the principal whose rows they touch", () => {
  it("the alert owner reads the episode's ticket; another non-admin does not", async () => {
    await runWithRlsPrincipal({ userId: ids.bob }, async () => {
      expect((await governanceAlertTicket(db, ids.alert))?.externalId).toBeTruthy();
      expect((await governanceAlertTickets(db, [ids.alert])).size).toBe(1);
    });
    await runWithRlsPrincipal({ userId: ids.alice }, async () => {
      expect(await governanceAlertTicket(db, ids.alert)).toBeNull();
    });
  });

  it("a request's pm_sync step sees exactly the principal's links", async () => {
    await runWithRlsPrincipal({ userId: ids.alice }, async () => {
      const seen = await asPmSync("test.links", () => linkIds());
      expect(seen).toEqual(expect.arrayContaining([ids.runLink, ids.nodeLink, ids.instanceLink]));
      expect(seen).not.toContain(ids.alertLink);
    });
  });
});
