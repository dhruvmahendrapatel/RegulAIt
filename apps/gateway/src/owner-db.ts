/**
 * ADR-0234 batch 7b: which OWNER (migrator) handle stands behind a runtime handle.
 *
 * Requests are served on the runtime login, which has no DELETE on `audit_log` (the ledger is append-only for
 * `regulait_app`). The one path that deletes from the ledger, the retention prune, runs on the owner connection. Boot
 * registers the pair; anything that was not registered (a test's single handle, a script) is its own owner, exactly
 * as before batch 7b.
 */
import type { Db } from "@regulait/db";

const owners = new WeakMap<object, Db>();

/** record that `owner` is the owner connection behind the runtime handle `runtime` (boot calls this once) */
export function registerOwnerDb(runtime: Db, owner: Db): void {
  if (runtime !== owner) owners.set(runtime as object, owner);
}

/** the owner handle behind `db`, or `db` itself when none was registered */
export function ownerDbFor(db: Db): Db {
  return owners.get(db as object) ?? db;
}
