// Spike governance wrapper: a default-deny allow-list check before each step body,
// and a decision row in the spike audit table. Product code would call the gateway's
// policy decision point and chained audit writer instead.
import pg from "pg";
import { FatalError } from "workflow";

const ALLOWED = new Set([
  "kernel.transition",
  "requirements.generate",
  "check.ci",
  "check.code_review",
  "check.security_scan",
]);

const KEY = Symbol.for("regulait.p30.governancePool");
function db(): pg.Pool {
  const g = globalThis as Record<symbol, pg.Pool | undefined>;
  if (!g[KEY]) {
    const p = new pg.Pool({ connectionString: process.env.P30_DATABASE_URL, max: 4 });
    p.on("connect", (c) => c.on("error", () => {}));
    p.on("error", () => {});
    // the host ends this pool on shutdown (server.mjs close())
    g[KEY] = p;
  }
  return g[KEY]!;
}

export async function governedStep<T>(name: string, body: () => Promise<T>): Promise<T> {
  const denied = (process.env.P30_DENY_STEPS ?? "").split(",").includes(name);
  const allow = ALLOWED.has(name) && !denied;
  await db().query(
    "insert into regulait_p30.step_decisions(step, effect) values ($1, $2)",
    [name, allow ? "allow" : "deny"],
  );
  if (!allow) throw new FatalError(`governance: step ${name} denied`); // a refusal is final, never retried
  return body();
}
