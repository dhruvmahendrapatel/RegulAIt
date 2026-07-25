import { createDb } from "@regulait/db";
import { buildApp } from "./app.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const port = Number(process.env.PORT ?? 3000);

const app = buildApp(createDb(connectionString), {
  bootstrapToken: process.env.REGULAIT_BOOTSTRAP_TOKEN,
});

app.listen({ port, host: "0.0.0.0" }).then((address) => {
  console.log(`regulait gateway listening on ${address}`);
});
