/**
 * Who a system act is attributed to (ADR-0107 F01). One place, so every sweep names the same person for the same
 * kind of act.
 *
 * `is_admin` is not unique, so "an admin" would be arbitrary. The oldest active admin (the deployment's bootstrap
 * operator) is chosen deterministically. Where the record has no foreign key to `users` (the audit log), a deployment
 * with no admin falls back to the all-zero id that marks a system act with no human behind it, so the act is still
 * recorded. Where a foreign key to `users` makes the all-zero id impossible (`approvals.user_id`, a `run_as` column),
 * callers use `oldestActiveAdmin` and handle `null` themselves.
 */
import { and, asc, eq, isNull, ne, users, type Db } from "@regulait/db";

/** the all-zero id: a system act with no human behind it (the same value as the scheduler's system actor) */
export const SYSTEM_ATTRIBUTION_ID = "00000000-0000-0000-0000-000000000000";

/** the oldest active admin, optionally not `except`; null when there is none */
export async function oldestActiveAdmin(db: Db, except?: string | null): Promise<string | null> {
  const where = except
    ? and(eq(users.isAdmin, true), isNull(users.disabledAt), ne(users.id, except))
    : and(eq(users.isAdmin, true), isNull(users.disabledAt));
  const [admin] = await db.select({ id: users.id }).from(users).where(where).orderBy(asc(users.createdAt), asc(users.id)).limit(1);
  return admin?.id ?? null;
}

/**
 * The audit attribution for a system act: the oldest active admin, else the all-zero id. Never throws: an audit
 * helper that can fail is a failure path that can mask the failure it was written to report.
 */
export async function systemAttributionActor(db: Db): Promise<string> {
  try {
    return (await oldestActiveAdmin(db)) ?? SYSTEM_ATTRIBUTION_ID;
  } catch {
    return SYSTEM_ATTRIBUTION_ID;
  }
}
