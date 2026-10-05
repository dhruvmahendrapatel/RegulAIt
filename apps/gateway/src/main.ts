import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@regulait/db";
import { installShutdownHandlers, startGateway } from "./boot.js";
import { DataKeyBootError } from "./data-key.js";
import { DevSecretsBootError } from "./dev-secrets.js";
import { ManifestDigestRepinBootError } from "./manifest-digest-repin.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const port = Number(process.env.PORT ?? 3000);
// DEMO-01: WHERE to listen is an operator's choice, not a hard-coded 0.0.0.0.
// The compose stack keeps every interface (the container's, which is where
// Caddy and the loopback port publish reach it); a native `pnpm start` on a
// laptop — the documented demo path — sets HOST=127.0.0.1 so the plaintext
// gateway with its bootstrap token is not reachable from the conference Wi-Fi.
const host = process.env.HOST ?? process.env.REGULAIT_HOST ?? "0.0.0.0";

const db = createDb(connectionString);
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

// The whole sequence — build, migrate, ADR-0063 data-key gate, listen, print
// the posture block — lives in boot.ts so a test can drive the REAL start
// rather than a re-implementation of it. See that file for the ordering
// contract.
try {
  const started = await startGateway({
    db,
    migrationsFolder,
    port,
    host,
    bootstrapToken: process.env.REGULAIT_BOOTSTRAP_TOKEN,
    dataKey: process.env.REGULAIT_DATA_KEY,
  });
  // REL-02 / OPS-01: SIGTERM/SIGINT drain rather than sever; an unhandled
  // rejection or exception leaves a trace and a clean pool before exit 1.
  installShutdownHandlers(started, db);
} catch (err) {
  if (err instanceof DataKeyBootError || err instanceof DevSecretsBootError || err instanceof ManifestDigestRepinBootError) {
    // Not a stack trace. This is the message an operator reads at 3am in the
    // middle of a restore, and it is the only signal that arrives while the
    // correct key may still be recoverable from the source box. (ADR-0167: the
    // dev-secrets refusal reads the same way — one message, what to do next.)
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
