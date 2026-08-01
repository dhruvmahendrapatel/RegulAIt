import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "@regulait/db";
import { buildApp } from "./app.js";
import { describeTrustProxy, resolveTrustProxy } from "./trusted-proxy.js";
import { describeHsts, resolveHsts } from "./hsts.js";

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
  // ADR-0031: say out loud whose X-Forwarded-* this deployment believes —
  // getting this wrong silently corrupts every client IP in the audit trail.
  console.log(`  proxy:     ${describeTrustProxy(resolveTrustProxy())}`);
  // ADR-0029 amendment: say out loud what this deployment pins browsers to.
  // HSTS is the one header we cannot take back from the server, so the value
  // belongs in the boot log next to the proxy posture rather than only in a
  // response an operator has to think to look at.
  console.log(`  hsts:      ${describeHsts(resolveHsts())}`);
});
