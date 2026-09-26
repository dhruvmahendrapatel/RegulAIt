/**
 * THE RE-ENCRYPTION CLI (ADR-0063 §4's named follow-up, batch B4).
 *
 *     REGULAIT_DATA_KEY=<new key> REGULAIT_DATA_KEY_OLD=<old key> \
 *       pnpm --filter @regulait/gateway reencrypt
 *
 * Deliberately a CLI and not an HTTP mutation: the walk visits every ciphertext
 * row while holding two live keys, and running that inside a request invites a
 * proxy timeout mid-walk plus an operator retry racing the first attempt. The
 * admin surface gets a status-only endpoint instead
 * (`GET /v1/security/data-key/reencryption`).
 *
 * Exit codes:
 *   0  completed cleanly, or nothing to do (idempotent re-invocation)
 *   1  refused — missing/malformed keys, registry drift, conflicting pending run
 *   2  completed_with_failures — every reachable row is under the new key, but
 *      some rows decrypted under NEITHER key; they are enumerated in the run's
 *      failure record and in the output below. Nonzero on purpose: a script
 *      that treats this as success is a script that lies to its operator.
 *
 * A killed run (crash, ctrl-C) is safe: progress commits per batch, and the
 * next invocation with the same two keys resumes from the exact watermark.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "@regulait/db";
import { DATA_KEY_ENV } from "./data-key.js";
import { DATA_KEY_OLD_ENV, runReencryptionWalk } from "./data-key-reencrypt.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";

const db = createDb(connectionString);
(db.$client as { on: (ev: string, fn: (err: Error) => void) => void }).on("error", () => {});
await runMigrations(
  db,
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"),
);

const outcome = await runReencryptionWalk(db, {
  newKeyHex: process.env[DATA_KEY_ENV],
  oldKeyHex: process.env[DATA_KEY_OLD_ENV],
  log: console.log,
});

let exitCode: number;
switch (outcome.kind) {
  case "refused":
    console.error(`REFUSED: ${outcome.reason}`);
    exitCode = 1;
    break;
  case "nothing_to_do":
    console.log(outcome.message);
    exitCode = 0;
    break;
  default: {
    const totals = outcome.perColumn.reduce(
      (acc, c) => ({
        reencrypted: acc.reencrypted + c.reencrypted,
        alreadyCurrent: acc.alreadyCurrent + c.alreadyCurrent,
        failed: acc.failed + c.failed,
      }),
      { reencrypted: 0, alreadyCurrent: 0, failed: 0 },
    );
    console.log(
      `\n${outcome.kind === "completed" ? "COMPLETED" : "COMPLETED WITH FAILURES"} ` +
        `(run ${outcome.runId}${outcome.resumed ? ", resumed" : ""}): ` +
        `${outcome.fromFingerprint} -> ${outcome.toFingerprint} in ${outcome.durationMs}ms`,
    );
    for (const c of outcome.perColumn) {
      console.log(
        `  ${c.table}.${c.column}: ${c.reencrypted} re-encrypted, ${c.alreadyCurrent} already current` +
          (c.failed > 0 ? `, ${c.failed} FAILED` : ""),
      );
    }
    if (outcome.failures.length > 0) {
      console.error(
        `\n${outcome.failures.length} row(s) decrypted under NEITHER key — recorded, walked past, ` +
          `and unrecoverable without out-of-band action:`,
      );
      for (const f of outcome.failures) console.error(`  ${f.table}.${f.column} id=${f.rowId}`);
      exitCode = 2;
    } else {
      console.log(
        `\nEvery ciphertext row is now under ${outcome.toFingerprint}. The OLD key is no longer ` +
          `needed: destroy it per the custody runbook (docs/ops/DB_BACKUP.md), remove ` +
          `${DATA_KEY_OLD_ENV} from the environment, and attest the new key.`,
      );
      exitCode = 0;
    }
  }
}

await db.$client.end();
process.exit(exitCode);
