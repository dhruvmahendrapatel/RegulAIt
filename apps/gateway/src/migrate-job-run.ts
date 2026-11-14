/**
 * ADR-0304: the migration step of a Kubernetes install, run as a Job (the operator) or a Helm hook before the
 * gateway's image moves to a new version. It connects, applies the migrations exactly as boot does, and exits.
 * It never falls back to a default database URL: a Job without one fails rather than migrating something else.
 */
export interface MigrateJobDeps {
  connect: (url: string) => { close: () => Promise<void> };
  migrate: (handle: unknown) => Promise<void>;
  log: (line: string) => void;
}

export async function runMigrateJob(env: NodeJS.ProcessEnv, deps: MigrateJobDeps): Promise<number> {
  const url = env.DATABASE_URL;
  if (!url) {
    deps.log("migrate-job: DATABASE_URL is not set; refusing to guess a database");
    return 2;
  }
  const handle = deps.connect(url);
  try {
    await deps.migrate(handle);
    deps.log("migrate-job: migrations applied");
    return 0;
  } catch (err) {
    // The cause carries the database's own reason (a TLS refusal, a lock timeout); drizzle's message is only the query.
    const cause = err instanceof Error && err.cause instanceof Error ? ` (cause: ${err.cause.message})` : "";
    deps.log(`migrate-job: migration failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
    return 1;
  } finally {
    await handle.close();
  }
}
