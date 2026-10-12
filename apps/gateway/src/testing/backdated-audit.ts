/**
 * TEST FIXTURES ONLY — an audit row with a time the test chooses (a retention, window or replay fixture).
 *
 * The chained writer refuses a caller-named `at` (PR #377 review, secure by default: production rows are
 * stamped by the database clock). `backdated(db).insert(auditLog).values(...)` runs the same chained insert
 * inside `runWithCallerAuditAtForTest`, the one place a fixture may name `at`. It supports what the fixtures
 * use: awaiting the insert, and `.returning(...)`.
 */
import { auditLog, runWithCallerAuditAtForTest, type Db } from "@regulait/db";

type AuditInsert = typeof auditLog.$inferInsert;

export function backdated(db: Db) {
  return {
    insert: (table: typeof auditLog) => ({
      values: (values: AuditInsert | AuditInsert[]) => {
        const builder = db.insert(table).values(values as never) as unknown as PromiseLike<unknown> & {
          returning: (selection?: unknown) => PromiseLike<unknown>;
        };
        return {
          then<R1 = void, R2 = never>(onOk?: ((v: void) => R1 | PromiseLike<R1>) | null, onErr?: ((e: unknown) => R2 | PromiseLike<R2>) | null): Promise<R1 | R2> {
            return runWithCallerAuditAtForTest(() => builder).then(() => undefined).then(onOk, onErr);
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          returning(selection?: Record<string, unknown>): Promise<any[]> {
            return runWithCallerAuditAtForTest(() => (selection === undefined ? builder.returning() : builder.returning(selection))) as Promise<never[]>;
          },
        };
      },
    }),
  };
}
