import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import type { Db } from "./index.js";
import { auditLog } from "./schema.js";

/** the identity a migration's audit rows are attributed to: the system itself */
export const MIGRATION_AUDIT_ACTOR = "00000000-0000-0000-0000-000000000000";

export async function runMigrations(db: Db, migrationsFolder: string) {
  await migrate(db, { migrationsFolder });
  await drainMigrationAuditOutbox(db);
}

type OutboxRow = {
  id: string;
  migration: string;
  object_type: string;
  object_id: string | null;
  rule_id: string;
  reason: string;
  detail: Record<string, unknown> | null;
  created_at: Date | string;
};

/**
 * ADR-0181 (FX2): move the audit rows a migration wrote into
 * `migration_audit_outbox` into `audit_log`, through the CHAINED insert path
 * (`db` comes from `createDb`, which chains every `insert(auditLog)`). The
 * claim (DELETE … RETURNING) and the inserts are one transaction, so a row is
 * either moved exactly once or not at all, and two processes booting together
 * cannot both move it. Returns how many rows were moved.
 */
export async function drainMigrationAuditOutbox(db: Db): Promise<number> {
  // a migrations folder that stops before 0160 has no outbox to drain
  const present = await db.execute(sql`select to_regclass('migration_audit_outbox') is not null as "present"`);
  if (!(present as unknown as { rows: Array<{ present: boolean }> }).rows[0]?.present) return 0;
  // the common case — nothing to move — opens no transaction at all
  const pending = await db.execute(sql`select 1 from "migration_audit_outbox" limit 1`);
  if ((pending as unknown as { rows: unknown[] }).rows.length === 0) return 0;
  return db.transaction(async (tx) => {
    const res = await tx.execute(sql`delete from "migration_audit_outbox" returning *`);
    const rows = ((res as unknown as { rows: OutboxRow[] }).rows ?? []).slice();
    if (rows.length === 0) return 0;
    rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
    for (const r of rows) {
      await tx.insert(auditLog).values({
        userId: MIGRATION_AUDIT_ACTOR,
        objectType: r.object_type as typeof auditLog.$inferInsert.objectType,
        objectId: r.object_id,
        detail: { ...(r.detail ?? {}), migration: r.migration },
        effect: "allow",
        ruleId: r.rule_id,
        ruleChain: [r.rule_id],
        reason: r.reason,
      });
    }
    return rows.length;
  });
}
