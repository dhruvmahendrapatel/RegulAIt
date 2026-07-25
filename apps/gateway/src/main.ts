import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "@regulait/db";
import { buildApp } from "./app.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const port = Number(process.env.PORT ?? 3000);

const db = createDb(connectionString);
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const app = buildApp(db, {
  bootstrapToken: process.env.REGULAIT_BOOTSTRAP_TOKEN,
  dataKey: process.env.REGULAIT_DATA_KEY,
});

// migrations are idempotent — booting always converges the schema
await runMigrations(db, migrationsFolder);

app.listen({ port, host: "0.0.0.0" }).then((address) => {
  console.log(`regulait gateway listening on ${address}`);
  console.log(`  app UI:    ${address}/app`);
  console.log(`  admin UI:  ${address}/admin`);
});
