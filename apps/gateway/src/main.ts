import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@regulait/db";
import { startGateway } from "./boot.js";
import { DataKeyBootError } from "./data-key.js";
import { DevSecretsBootError } from "./dev-secrets.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const port = Number(process.env.PORT ?? 3000);

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
  await startGateway({
    db,
    migrationsFolder,
    port,
    bootstrapToken: process.env.REGULAIT_BOOTSTRAP_TOKEN,
    dataKey: process.env.REGULAIT_DATA_KEY,
  });
} catch (err) {
  if (err instanceof DataKeyBootError || err instanceof DevSecretsBootError) {
    // Not a stack trace. This is the message an operator reads at 3am in the
    // middle of a restore, and it is the only signal that arrives while the
    // correct key may still be recoverable from the source box. (ADR-0167: the
    // dev-secrets refusal reads the same way — one message, what to do next.)
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
