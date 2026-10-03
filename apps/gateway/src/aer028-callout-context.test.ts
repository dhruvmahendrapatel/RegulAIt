/**
 * AER-028 — THE CALLOUT ASKS THE SAME QUESTION THE DISPATCH WOULD.
 *
 * `/v1/authz/check` passed `args = undefined, projectId = null, principal =
 * undefined` into the kernel. The consequence was NOT that rules were skipped:
 * the kernel fails closed on a data-scope rule whose argument is absent, so any
 * deployment with one got `deny` from the PDP for calls that would really have
 * been allowed.
 *
 * That is wrong in the safe direction, which is the direction that gets a PDP
 * switched off — an operator whose proxy denies everything removes the proxy,
 * and then nothing is governed at all. "Fails closed" is not a defence when the
 * closure is indiscriminate.
 *
 * The fix is context, not a relaxation, and this file is written to tell those
 * two apart: the fail-closed behaviour with NO args must survive unchanged, and
 * only a call that actually supplies conforming arguments may be allowed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  runMigrations,
  users,
  mcpServers,
  mcpTools,
  toolGrants,
  dataScopeRules,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "aer028-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let serverId: string;

const TOOL = "aer028_query";

const ask = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/v1/authz/check", headers: AUTH, payload });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const [u] = await db
    .insert(users)
    .values({ email: `aer028-${randomUUID()}@ctx.example`, displayName: "AER028" })
    .returning({ id: users.id });
  userId = u!.id;

  const [s] = await db
    .insert(mcpServers)
    .values({ name: `aer028-${randomUUID()}`, url: "http://127.0.0.1:9/" })
    .returning({ id: mcpServers.id });
  serverId = s!.id;
  await db.insert(mcpTools).values({ serverId, name: TOOL, kind: "read" });
  await db.insert(toolGrants).values({ userId, serverId, toolName: TOOL });

  // THE RULE THAT MADE THE TWO QUESTIONS DIFFER: this tool may only be called
  // against the `analytics` schema. A dispatch carrying that argument is
  // allowed; the callout, which carried no arguments at all, was denied.
  await db.insert(dataScopeRules).values({
    scope: "user",
    userId,
    serverScope: "server",
    serverId,
    toolName: TOOL,
    argPath: "schema",
    allowedValues: ["analytics"],
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await db.$client.end();
});

describe("AER-028 — a data-scope rule is evaluated against the real arguments", () => {
  it("STILL FAILS CLOSED with no args — the behaviour that must not change", async () => {
    const res = await ask({ userId, serverId, toolName: TOOL });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.decision).toBe("deny");
    // and it reports that nothing was supplied, so an operator can tell this
    // refusal from a policy one
    expect(body.contextApplied).toEqual([]);
  });

  it("allows the call whose arguments CONFORM — the answer a dispatch would give", async () => {
    const res = await ask({ userId, serverId, toolName: TOOL, args: { schema: "analytics" } });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.decision).toBe("allow");
    expect(body.contextApplied).toContain("args");
  });

  it("denies the call whose arguments do NOT conform — context is not a bypass", async () => {
    const res = await ask({ userId, serverId, toolName: TOOL, args: { schema: "payroll" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).decision).toBe("deny");
  });

  it("denies when the argument is present but not a scalar, exactly as the kernel does", async () => {
    const res = await ask({ userId, serverId, toolName: TOOL, args: { schema: { nested: true } } });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).decision).toBe("deny");
  });
});

describe("AER-028 — the LEDGER records what the decision was computed on", () => {
  /**
   * The Kong harness asserts the adapter's context against this row rather than
   * against the plugin's source — reading the plugin would only restate the
   * code. That makes `detail.contextApplied` a contract between two test
   * suites, so it is pinned here, where it can be run without a container.
   */
  it("every callout row carries contextApplied, so a proxy's claim is checkable", async () => {
    const res = await ask({
      userId,
      serverId,
      toolName: TOOL,
      args: { schema: "analytics" },
      projectId: null,
      // AER-036: `sso` was this fixture's origin and it is no longer a value the
      // schema accepts — it is not in `SESSION_ORIGINS`, so a policy written
      // against the product's own vocabulary could never match it while a
      // "not an API key" policy was satisfied by it. `oidc` is what the adapter
      // should have been saying.
      principal: { sessionOrigin: "oidc", mfaCompleted: true },
    });
    expect(res.statusCode, res.body).toBe(200);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.toolName, TOOL), eq(auditLog.userId, userId)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(rows.length).toBe(1);
    const detail = rows[0]!.detail as { contextApplied?: string[]; credential?: string };
    expect(detail.contextApplied, "the names, on the row").toEqual(
      expect.arrayContaining(["args", "principal"]),
    );
    // a null projectId is ABSENT context, not supplied context — otherwise a
    // proxy sending `projectId: null` would read as having narrowed by project
    expect(detail.contextApplied).not.toContain("projectId");
    // and the row still records WHICH credential asked (AER-027)
    expect(detail.credential).toBeTruthy();
  });

  it("the values themselves never reach the ledger row's contextApplied", async () => {
    const res = await ask({ userId, serverId, toolName: TOOL, args: { schema: "analytics" } });
    expect(res.statusCode).toBe(200);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.toolName, TOOL), eq(auditLog.userId, userId)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    const applied = (rows[0]!.detail as { contextApplied?: string[] }).contextApplied ?? [];
    // AER-036 added `principal.asserted` — deliberately listed rather than
    // loosened, because the value of this assertion is that the set is closed.
    for (const name of applied) {
      expect(["args", "projectId", "principal", "principal.asserted"]).toContain(name);
    }
  });
});

describe("AER-028 — the response says what the decision was computed on", () => {
  it("names each supplied dimension, and never their values", async () => {
    const res = await ask({
      userId,
      serverId,
      toolName: TOOL,
      args: { schema: "analytics" },
      // AER-036: `sso` was this fixture's origin and it is no longer a value the
      // schema accepts — it is not in `SESSION_ORIGINS`, so a policy written
      // against the product's own vocabulary could never match it while a
      // "not an API key" policy was satisfied by it. `oidc` is what the adapter
      // should have been saying.
      principal: { sessionOrigin: "oidc", mfaCompleted: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.contextApplied).toEqual(expect.arrayContaining(["args", "principal"]));
    // The whole response crosses into a data plane, so it must carry no values
    // — not the argument, not the origin. A proxy may log this verbatim.
    expect(res.body).not.toContain("analytics");
    expect(res.body).not.toContain("oidc");
  });

  it("the contract still carries only decision, reason and contextApplied", async () => {
    const res = await ask({ userId, serverId, toolName: TOOL, args: { schema: "analytics" } });
    expect(Object.keys(JSON.parse(res.body)).sort()).toEqual(["contextApplied", "decision", "reason"]);
  });
});
