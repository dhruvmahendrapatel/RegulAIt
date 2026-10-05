/**
 * ADR-0179 (AER-028, AER-036) — the PDP side of the narrowed Kong claims.
 *
 * The Kong plugin derives a session origin only for key-auth (`api_key`) and
 * basic-auth (`password`); for OIDC and SAML it forwards the operator's
 * ASSERTION, and it refuses an assertion that contradicts a derived origin
 * before it asks (pinned in integrations/kong/test/handler_spec.lua). What the
 * PDP must do with each of those questions:
 *
 *  1. an OIDC (or SAML) asserted origin is ACCEPTED and labelled
 *     `principal.asserted`, with the exact value on the ledger;
 *  2. a derived one (key-auth's `api_key`, basic-auth's `password`) is labelled
 *     `principal.asserted` too — on this route the PDP cannot tell derived from
 *     asserted, and it must not claim to;
 *  3. an out-of-vocabulary origin (`sso`) is a 400, never a silent accept;
 *  4. AER-028: a Kong-shaped question (no `args`) about a tool carrying a
 *     data-scope rule is ALWAYS denied, on that rule, with `args` absent from
 *     `contextApplied` — the fact the plugin reads to tag its refusal — while
 *     the same principal WITH a conforming argument is allowed (so the deny is
 *     the missing argument, not the principal).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditLog,
  createDb,
  dataScopeRules,
  desc,
  eq,
  mcpServers,
  mcpTools,
  runMigrations,
  toolGrants,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "aer036-mixed-auth-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const OPEN_TOOL = "aer036_open";
const SCOPED_TOOL = "aer036_scoped";

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let serverId: string;
let scopeRuleId: string;

const ask = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/v1/authz/check", headers: AUTH, payload });

const latestRow = async () =>
  (
    await db
      .select({ detail: auditLog.detail, ruleId: auditLog.ruleId, reason: auditLog.reason })
      .from(auditLog)
      .where(eq(auditLog.userId, userId))
      .orderBy(desc(auditLog.at))
      .limit(1)
  )[0]!;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const [u] = await db
    .insert(users)
    .values({ email: `aer036-${randomUUID()}@mixed.example`, displayName: "AER036 mixed auth" })
    .returning({ id: users.id });
  userId = u!.id;
  const [s] = await db
    .insert(mcpServers)
    .values({ name: `aer036-${randomUUID()}`, url: "http://127.0.0.1:9/" })
    .returning({ id: mcpServers.id });
  serverId = s!.id;
  await db.insert(mcpTools).values([
    { serverId, name: OPEN_TOOL, kind: "read" },
    { serverId, name: SCOPED_TOOL, kind: "read" },
  ]);
  await db.insert(toolGrants).values([
    { userId, serverId, toolName: OPEN_TOOL },
    { userId, serverId, toolName: SCOPED_TOOL },
  ]);
  const [rule] = await db
    .insert(dataScopeRules)
    .values({ scope: "user", userId, serverScope: "server", serverId, toolName: SCOPED_TOOL, argPath: "schema", allowedValues: ["analytics"] })
    .returning({ id: dataScopeRules.id });
  scopeRuleId = rule!.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await db.$client.end();
});

describe("ADR-0179 AER-036 — mixed authentication at the PDP", () => {
  for (const origin of ["oidc", "saml"] as const) {
    it(`an ${origin} ASSERTED origin is accepted, labelled principal.asserted, and its value is on the ledger`, async () => {
      const res = await ask({ userId, serverId, toolName: OPEN_TOOL, principal: { sessionOrigin: origin } });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { decision: string; contextApplied: string[] };
      expect(body.decision).toBe("allow");
      expect(body.contextApplied).toEqual(expect.arrayContaining(["principal", "principal.asserted"]));
      expect(res.body).not.toContain(origin);
      const row = await latestRow();
      expect((row.detail as { assertedPrincipal?: { sessionOrigin?: string } }).assertedPrincipal?.sessionOrigin).toBe(origin);
    });
  }

  for (const origin of ["api_key", "password"] as const) {
    it(`a DERIVED origin (${origin}) is still labelled asserted — the PDP cannot tell the two apart`, async () => {
      const res = await ask({ userId, serverId, toolName: OPEN_TOOL, principal: { sessionOrigin: origin } });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { contextApplied: string[] }).contextApplied).toContain("principal.asserted");
    });
  }

  it("an out-of-vocabulary origin is refused (400), never accepted in silence", async () => {
    const res = await ask({ userId, serverId, toolName: OPEN_TOOL, principal: { sessionOrigin: "sso" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("ADR-0179 AER-028 — data-scope rules always deny a Kong-shaped question", () => {
  it("no args: deny on the data-scope rule, with args absent from contextApplied", async () => {
    const res = await ask({ userId, serverId, toolName: SCOPED_TOOL, principal: { sessionOrigin: "oidc" } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { decision: string; reason: string; contextApplied: string[] };
    expect(body.decision).toBe("deny");
    expect(body.reason).toBe(scopeRuleId);
    expect(body.contextApplied).not.toContain("args");
    const row = await latestRow();
    expect(row.ruleId).toBe(scopeRuleId);
    expect(row.reason).toMatch(/fails closed/);
  });

  it("control: the same principal WITH a conforming argument is allowed", async () => {
    const res = await ask({ userId, serverId, toolName: SCOPED_TOOL, args: { schema: "analytics" }, principal: { sessionOrigin: "oidc" } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { decision: string; contextApplied: string[] };
    expect(body.decision).toBe("allow");
    expect(body.contextApplied).toContain("args");
  });
});
