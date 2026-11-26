/**
 * Postgres error classification shared by every caller that turns a constraint violation into an answer. drizzle
 * wraps the driver error, so the code and the constraint name are read from the error or its `cause`.
 *
 * Several modules carry a private copy of this check (classical-drift, autonomy, evals, mrm, risk-tolerance,
 * condition-metrics). New code imports this one; the copies move here when their files are next touched.
 */
interface PgErrorShape {
  code?: string;
  constraint?: string;
  cause?: { code?: string; constraint?: string };
}

/** a unique violation (23505), of the named constraint or index when one is given */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as PgErrorShape | null | undefined;
  if ((e?.code ?? e?.cause?.code) !== "23505") return false;
  return constraint === undefined || (e?.constraint ?? e?.cause?.constraint) === constraint;
}
