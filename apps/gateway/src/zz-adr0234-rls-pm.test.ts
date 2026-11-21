/**
 * ADR-0234 PM batch (#828 review; owner decision 2026-11-15: row-level security on ALL PM tables).
 *
 * Against a scratch database migrated to the head (including the pending `rls_pm_tables` migration), with no
 * application filter, these prove:
 *   - every PM table has row-level security ENABLED and FORCED;
 *   - a non-admin principal reads, inserts, updates and deletes nothing in any PM table;
 *   - an admin principal reaches every PM table;
 *   - `pm_sync` (a principal step) reaches connections, the links of objects the principal may see (narrowed by
 *     `rls_pm_tables_followon`) and the inbound log, never the webhook delivery
 *     records or the import linkage;
 *   - the PM webhook's reason (`approval_maintenance`) records and releases deliveries and appends the inbound log;
 *   - `system_task` prunes deliveries; `public_ingest` and `credential_request` reach no PM table;
 *   - the gateway's own entry points (the mirror and alert-ticket helpers, the delivery prune) work under those scopes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  createDb,
  eq,
  governanceAlerts,
  initiatives,
  pmConnections,
  pmImportedWorkItems,
  pmLinks,
  pmProjectInitiatives,
  pmSyncEvents,
  pmWebhookDeliveries,
  runMigrations,
  runWithRlsPrincipal,
  runWithRlsPrincipalStep,
  runWithRlsSystem,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { governanceAlertTicket, prunePmWebhookDeliveries } from "./pm.js";
import { computeCredentialInventory } from "./credential-inventory.js";
import { dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `rls0234pm_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const PM_TABLES = [
  "pm_connections",
  "pm_imported_work_items",
  "pm_links",
  "pm_project_initiatives",
  "pm_sync_events",
  "pm_webhook_deliveries",
] as const;

let admin: Db;
let db: Db;
const ids = {
  alice: randomUUID(),
  root: randomUUID(),
  conn: randomUUID(),
  link: randomUUID(),
  alert: randomUUID(),
  initiative: randomUUID(),
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

/** how many rows of each PM table the current scope sees */
async function visible(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of PM_TABLES) {
    const r = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${t}`));
    out[t] = r.rows[0]!.n;
  }
  return out;
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  // seeded outside any scope (the scratch login is the owner/superuser, as the migrator is)
  await db.insert(users).values([
    { id: ids.alice, email: `alice-${ids.alice}@rls.test`, displayName: "Alice" },
    { id: ids.root, email: `root-${ids.root}@rls.test`, displayName: "Root", isAdmin: true },
  ]);
  // the alert the link points at is alice's: under pm_sync a non-admin reaches only the links of objects it may see
  // (rls_pm_tables_followon), and a governance alert's owner may read its ticket
  await db.insert(governanceAlerts).values({ id: ids.alert, ruleId: "rls0234pm", subjectKey: ids.alert, severity: "high", title: "t", ownerUserId: ids.alice });
  await db.insert(pmConnections).values({ id: ids.conn, name: `rlspm-${ids.conn}`, provider: "mock", project: "P", tokenCiphertext: "x" });
  await db.insert(pmLinks).values({
    id: ids.link,
    connectionId: ids.conn,
    objectType: "governance_alert",
    objectId: ids.alert,
    externalId: "1",
    externalUrl: "mock-pm://P/items/1",
  });
  await db.insert(pmSyncEvents).values({ connectionId: ids.conn, externalId: "1", kind: "updated", payload: {} });
  await db.insert(pmWebhookDeliveries).values([
    { connectionId: ids.conn, contentSha256: "a".repeat(64) },
    { connectionId: ids.conn, contentSha256: "b".repeat(64), receivedAt: new Date(Date.now() - 90 * 86_400_000) },
  ]);
  await db.insert(initiatives).values({ id: ids.initiative, name: `rlspm-${ids.initiative}` });
  await db.insert(pmProjectInitiatives).values({ connectionId: ids.conn, initiativeId: ids.initiative });
  await db.insert(pmImportedWorkItems).values({ connectionId: ids.conn, externalId: "1", externalUrl: "https://pm.example/1", itemType: "Task" });
}, 180_000);

afterAll(async () => {
  await db?.$client.end().catch(() => undefined);
  if (admin) {
    await dropScratchDatabase(admin, SCRATCH_DB);
    await admin.$client.end().catch(() => undefined);
  }
});

describe("the PM tables are under forced row-level security", () => {
  it("every PM table has row-level security ENABLED and FORCED", async () => {
    const r = await db.execute<{ relname: string; on: boolean; forced: boolean }>(sql`
      select relname, relrowsecurity as on, relforcerowsecurity as forced from pg_class
       where relnamespace = 'public'::regnamespace and relname like 'pm\\_%' and relkind = 'r' order by relname`);
    expect(r.rows.map((x) => x.relname)).toEqual([...PM_TABLES]);
    for (const row of r.rows) expect([row.relname, row.on, row.forced]).toEqual([row.relname, true, true]);
  });
});

describe("what each scope reaches, with no application filter", () => {
  it("a non-admin principal reads, writes, changes and deletes nothing in any PM table", async () => {
    await runWithRlsPrincipal({ userId: ids.alice }, async () => {
      expect(await visible()).toEqual(Object.fromEntries(PM_TABLES.map((t) => [t, 0])));
      expect(await pgError(db.insert(pmConnections).values({ name: `rlspm-x-${randomUUID()}`, provider: "mock", project: "P", tokenCiphertext: "x" }))).toMatch(
        /row-level security/,
      );
      expect(
        await pgError(db.insert(pmLinks).values({ connectionId: ids.conn, objectType: "run", objectId: randomUUID(), externalId: "2", externalUrl: "u" })),
      ).toMatch(/row-level security/);
      expect(await pgError(db.insert(pmWebhookDeliveries).values({ connectionId: ids.conn, contentSha256: "c".repeat(64) }))).toMatch(/row-level security/);
      expect(await pgError(db.insert(pmImportedWorkItems).values({ connectionId: ids.conn, externalId: "9", externalUrl: "https://x", itemType: "T" }))).toMatch(
        /row-level security/,
      );
      expect(await db.update(pmConnections).set({ project: "Q" }).where(eq(pmConnections.id, ids.conn)).returning({ id: pmConnections.id })).toEqual([]);
      expect(await db.delete(pmLinks).where(eq(pmLinks.id, ids.link)).returning({ id: pmLinks.id })).toEqual([]);
    });
    expect(await visible()).toMatchObject({ pm_connections: 1, pm_links: 1 });
  });

  it("an admin principal reaches every PM table", async () => {
    await runWithRlsPrincipal({ userId: ids.root }, async () => {
      const v = await visible();
      for (const t of PM_TABLES) expect([t, v[t]! > 0]).toEqual([t, true]);
    });
  });

  it("pm_sync reaches connections, links and the inbound log, never the deliveries or the import linkage", async () => {
    await runWithRlsPrincipalStep({ userId: ids.alice }, "pm_sync", "test.pm-sync", async () => {
      expect(await visible()).toEqual({
        pm_connections: 1,
        pm_imported_work_items: 0,
        pm_links: 1,
        pm_project_initiatives: 0,
        pm_sync_events: 1,
        pm_webhook_deliveries: 0,
      });
      const [ev] = await db.insert(pmSyncEvents).values({ connectionId: ids.conn, externalId: "1", kind: "commented", payload: {} }).returning({ id: pmSyncEvents.id });
      expect(ev?.id).toBeTruthy();
      // an alert's ticket link is read-only to its owner (rls_pm_tables_followon: only an admin, a job or the decide
      // path writes it); the per-row write rules are proved in zz-adr0234-rls-pm-followon.test.ts
      const upd = await db.update(pmLinks).set({ lastSyncedAt: new Date() }).where(eq(pmLinks.id, ids.link)).returning({ id: pmLinks.id });
      expect(upd).toEqual([]);
      // the connection itself is admin-managed
      expect(await db.update(pmConnections).set({ project: "Q" }).where(eq(pmConnections.id, ids.conn)).returning({ id: pmConnections.id })).toEqual([]);
      expect(await pgError(db.insert(pmWebhookDeliveries).values({ connectionId: ids.conn, contentSha256: "d".repeat(64) }))).toMatch(/row-level security/);
    });
  });

  it("the PM webhook's reason records and releases deliveries and appends the inbound log; not the import linkage", async () => {
    await runWithRlsSystem("approval_maintenance", "test.pm-webhook", async () => {
      const v = await visible();
      expect(v).toMatchObject({ pm_connections: 1, pm_links: 1, pm_webhook_deliveries: 2, pm_imported_work_items: 0, pm_project_initiatives: 0 });
      const [d] = await db.insert(pmWebhookDeliveries).values({ connectionId: ids.conn, contentSha256: "e".repeat(64) }).returning({ id: pmWebhookDeliveries.id });
      expect(await db.delete(pmWebhookDeliveries).where(eq(pmWebhookDeliveries.id, d!.id)).returning({ id: pmWebhookDeliveries.id })).toEqual([{ id: d!.id }]);
      const [ev] = await db.insert(pmSyncEvents).values({ connectionId: ids.conn, externalId: "1", kind: "updated", payload: {} }).returning({ id: pmSyncEvents.id });
      expect(ev?.id).toBeTruthy();
    });
  });

  it("public_ingest and credential_request reach no PM table", async () => {
    for (const reason of ["public_ingest", "credential_request"] as const) {
      await runWithRlsSystem(reason, "test.pm-narrow", async () => {
        expect(await visible()).toEqual(Object.fromEntries(PM_TABLES.map((t) => [t, 0])));
      });
    }
  });
});

describe("the gateway's own entry points under those scopes", () => {
  it("a PM helper called for a non-admin principal enters pm_sync itself", async () => {
    await runWithRlsPrincipal({ userId: ids.alice }, async () => {
      expect(await db.select({ id: pmLinks.id }).from(pmLinks)).toEqual([]);
      const ticket = await governanceAlertTicket(db, ids.alert);
      expect(ticket?.externalId).toBe("1");
    });
  });

  it("the stale-credential inventory still sees PM credentials when a non-admin decision re-runs the monitor", async () => {
    // #828 re-review: a remediation decided by a non-admin approver re-runs the governance monitor in that approver's
    // scope; the inventory's pm_connections read must not come back empty there, or open PM episodes would clear.
    const asAdmin = await runWithRlsPrincipal({ userId: ids.root }, () => computeCredentialInventory(db));
    const asApprover = await runWithRlsPrincipal({ userId: ids.alice }, () => computeCredentialInventory(db));
    const pmCount = (inv: Awaited<ReturnType<typeof computeCredentialInventory>>) =>
      inv.types.find((t) => t.type === "pm_token")?.count ?? 0;
    expect(pmCount(asAdmin)).toBe(1);
    expect(pmCount(asApprover)).toBe(pmCount(asAdmin));
  });

  it("the delivery prune deletes old records as system_task, and nothing outside its window", async () => {
    await runWithRlsSystem("system_task", "boot.pm-delivery-prune", () => prunePmWebhookDeliveries(db));
    const left = await db.select({ sha: pmWebhookDeliveries.contentSha256 }).from(pmWebhookDeliveries);
    expect(left.map((r) => r.sha)).toEqual(["a".repeat(64)]);
  });
});
