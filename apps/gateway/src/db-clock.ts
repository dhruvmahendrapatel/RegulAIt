/**
 * THE database clock (M-075), for any timestamp written to, or compared with, a database row. A replica's process
 * clock running ahead or behind then changes nothing. Kept free of other gateway imports so any module can use it
 * without an import cycle; `delegation.ts` re-exports both for the ADR-0188 S3 call sites.
 */
import { sql, type SQL } from "@regulait/db";

type ClockExec = { execute: (query: SQL) => PromiseLike<{ rows: Array<Record<string, unknown>> }> };

/** the database's `now()`: inside a transaction, that transaction's start */
export async function databaseNow(db: ClockExec): Promise<Date> {
  const r = await db.execute(sql`select (extract(epoch from now()) * 1000)::float8 as ms`);
  return new Date(Number(r.rows[0]!.ms));
}

/**
 * The database's WALL clock (`clock_timestamp()`), for a decision taken after waiting on a row lock
 * (X43 I7S3-01): `now()` is the transaction's START, so a transaction that waited on a lock would judge by a
 * time from before it waited. Sampled once the locks are held.
 */
export async function databaseWallNow(db: ClockExec): Promise<Date> {
  const r = await db.execute(sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms`);
  return new Date(Number(r.rows[0]!.ms));
}
