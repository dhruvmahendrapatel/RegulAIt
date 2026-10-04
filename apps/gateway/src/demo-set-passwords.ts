/**
 * `pnpm --filter @regulait/gateway demo:set-passwords` (ADR-0174 §6).
 *
 * Sets the password of the demo personas (Ada / Dana / Avery) from
 * REGULAIT_DEMO_USER_PASSWORD or the file named by
 * REGULAIT_DEMO_USER_PASSWORD_FILE, and clears their one-time-password flag.
 * Refuses outside a demo deployment and refuses a password the org policy
 * refuses. Never prints the password. See demo-set-passwords-lib.ts.
 *
 * Exit 0 done, 1 refused by a rule, 2 setup problem. Environment: DATABASE_URL.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "@regulait/db";
import { setDemoPasswords } from "./demo-set-passwords-lib.js";

const connectionString = process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const db = createDb(connectionString);
let exitCode = 2;
try {
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  const result = await setDemoPasswords(db, process.env);
  (result.ok ? console.log : console.error)(result.lines.join("\n"));
  exitCode = result.exitCode;
} catch (err) {
  // the error names what failed; it never carries the password (which is only
  // ever handed to the scrypt hash)
  console.error(`demo:set-passwords failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await (db.$client as { end: () => Promise<void> }).end();
}
process.exit(exitCode);
