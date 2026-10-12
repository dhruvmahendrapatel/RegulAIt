/**
 * `node apps/gateway/dist/first-admin.js` (ADR-0194) — run by
 * scripts/install.sh inside the gateway container:
 *
 *   docker compose ... exec -T gateway node apps/gateway/dist/first-admin.js --status
 *   docker compose ... exec -T gateway node apps/gateway/dist/first-admin.js \
 *       --username admin --email admin@acme.example   < (password on stdin)
 *
 * The password is read from STDIN only — never an argument (process list,
 * shell history) and never an environment variable. One trailing newline is
 * the pipe's, not the password's. It is never printed. See first-admin-lib.ts.
 *
 * Exit: 0 created (or, with --status, no admin yet) · 1 refused by a rule ·
 * 2 setup problem · 3 an active admin already exists (nothing changed) ·
 * 4 password refused by the org policy · 5 username/email invalid or taken.
 * Environment: DATABASE_URL (the gateway container's own).
 */
import { createDb } from "@regulait/db";
import { createFirstAdmin, FIRST_ADMIN_PASSWORD_MAX, firstAdminStatus } from "./first-admin-lib.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readStdin(limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > limit) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("first-admin: DATABASE_URL is not set (run this inside the gateway container)");
  process.exit(2);
}
const status = process.argv.includes("--status");
const username = arg("--username");
const email = arg("--email");
if (!status && (!username || !email)) {
  console.error("usage: first-admin.js --status | --username <name> --email <addr>  (password on stdin)");
  process.exit(2);
}

let exitCode = 2;
const db = createDb(connectionString);
try {
  if (status) {
    const s = await firstAdminStatus(db);
    console.log(s.line);
    exitCode = s.exitCode;
  } else {
    // 4 bytes per character is the UTF-8 worst case; anything longer is refused by the lib's length rule
    const password = await readStdin(FIRST_ADMIN_PASSWORD_MAX * 4 + 2);
    if (password === null || password === "") {
      console.error(
        password === null
          ? `first-admin refused: the password is longer than ${FIRST_ADMIN_PASSWORD_MAX} characters. Nothing was changed.`
          : "first-admin refused: no password on stdin. Nothing was changed.",
      );
      exitCode = password === null ? 4 : 2;
    } else {
      const result = await createFirstAdmin(db, { username: username!, email: email!, password });
      (result.exitCode === 0 || result.exitCode === 3 ? console.log : console.error)(result.lines.join("\n"));
      exitCode = result.exitCode;
    }
  }
} catch (err) {
  // the error names what failed; it never carries the password (which is only
  // ever handed to the policy check and the scrypt hash)
  console.error(`first-admin failed: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 2;
} finally {
  await (db.$client as { end: () => Promise<void> }).end();
}
process.exit(exitCode);
