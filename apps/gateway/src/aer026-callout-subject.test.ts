/**
 * AER-026 — THE CALLOUT KEEPS THE PROXY'S IDENTITY BESIDE THE SUBJECT, AND
 * REFUSES A SUBJECT THAT IS NOT A USER ANY MORE.
 *
 * Two gaps on the PDP side of the Kong adapter, found by the review of what
 * the harness did NOT exercise:
 *
 *   1. The ledger row recorded only the RESULT of the proxy's mapping (the
 *      RegulAIt `userId` the consumer's `custom_id` named). When a mapping is
 *      wrong — and a wrong mapping is an authorization decision about the
 *      wrong person — "which Kong consumer was this?" was unanswerable from
 *      the one table this product asks people to trust. The proxy now sends
 *      the identity it mapped FROM, and the row keeps both.
 *
 *   2. The kernel decides from grants, roles and rules; it never asked whether
 *      the subject is still a user. On the dispatch path that is answered at
 *      authentication (401 `user_disabled`), before the kernel runs. On this
 *      route the subject arrives in the body and is believed, so nothing asked:
 *      a DEACTIVATED user whose grants survive (ADR-0022: deactivate is not
 *      delete) was still `allow` to a proxy, and a UUID nobody has was decided
 *      like anyone else. Offboarding that stops sign-in but not the gateway in
 *      front of the tools is not offboarding.
 *
 * `integrations/kong/test/verify.mjs` asserts the same facts through a real
 * Kong container; this file pins them where they can run without one.
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

const BOOT = "aer026-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const TOOL = "aer026_read";

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let serverId: string;

const ask = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/v1/authz/check", headers: AUTH, payload });

const latestRowFor = async (subject: string) => {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.toolName, TOOL), eq(auditLog.userId, subject)))
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row ?? null;
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const [u] = await db
    .insert(users)
    .values({ email: `aer026-${randomUUID()}@subject.example`, displayName: "AER026" })
    .returning({ id: users.id });
  userId = u!.id;

  const [s] = await db
    .insert(mcpServers)
    .values({ name: `aer026-${randomUUID()}`, url: "http://127.0.0.1:9/" })
    .returning({ id: mcpServers.id });
  serverId = s!.id;
  await db.insert(mcpTools).values({ serverId, name: TOOL, kind: "read" });
  await db.insert(toolGrants).values({ userId, serverId, toolName: TOOL });
}, 120_000);

afterAll(async () => {
  await app.close();
  await db.$client.end();
});

describe("AER-026 — the ledger keeps the proxy's consumer identity beside the resolved subject", () => {
  it("records proxyConsumer on the row, with the subject it resolved to", async () => {
    const kongConsumerId = randomUUID();
    const res = await ask({
      userId,
      serverId,
      toolName: TOOL,
      proxyConsumer: { id: kongConsumerId, username: "entitled" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).decision).toBe("allow");

    const row = await latestRowFor(userId);
    expect(row, "a callout row").not.toBeNull();
    // BOTH halves of the mapping, on one row: what the proxy saw and who it
    // said that was. Either alone cannot answer "was this the right person?".
    expect(row!.userId).toBe(userId);
    const detail = row!.detail as { proxyConsumer?: unknown; contextApplied?: string[] };
    expect(detail.proxyConsumer).toEqual({ id: kongConsumerId, username: "entitled" });
    // provenance, not a decision input — the closed vocabulary stays closed
    expect(detail.contextApplied ?? []).not.toContain("proxyConsumer");
  });

  it("a username is optional; a consumer known only by id is still recorded", async () => {
    const kongConsumerId = randomUUID();
    const res = await ask({ userId, serverId, toolName: TOOL, proxyConsumer: { id: kongConsumerId } });
    expect(res.statusCode, res.body).toBe(200);
    const detail = (await latestRowFor(userId))!.detail as { proxyConsumer?: { id: string; username: unknown } };
    expect(detail.proxyConsumer).toEqual({ id: kongConsumerId, username: null });
  });

  it("is absent from the row when the caller sent none — never invented", async () => {
    const res = await ask({ userId, serverId, toolName: TOOL });
    expect(res.statusCode, res.body).toBe(200);
    const detail = (await latestRowFor(userId))!.detail as Record<string, unknown>;
    expect(detail).not.toHaveProperty("proxyConsumer");
  });

  it("never crosses back into the response — the contract is unchanged", async () => {
    const res = await ask({
      userId,
      serverId,
      toolName: TOOL,
      proxyConsumer: { id: randomUUID(), username: "entitled" },
    });
    expect(Object.keys(JSON.parse(res.body)).sort()).toEqual(["contextApplied", "decision", "reason"]);
    expect(res.body).not.toContain("entitled");
  });

  it("refuses a malformed identity rather than storing it", async () => {
    const res = await ask({ userId, serverId, toolName: TOOL, proxyConsumer: { id: "" } });
    expect(res.statusCode).toBe(400);
    const tooLong = await ask({ userId, serverId, toolName: TOOL, proxyConsumer: { id: "x".repeat(129) } });
    expect(tooLong.statusCode).toBe(400);
  });
});

describe("AER-026 — a subject that is not a user is refused, grants or no grants", () => {
  it("a DEACTIVATED subject is denied with its own reason, and the row names the consumer", async () => {
    // control first: with the grant in place and the account active, allow
    const before = await ask({ userId, serverId, toolName: TOOL });
    expect(JSON.parse(before.body).decision).toBe("allow");

    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));
    try {
      const kongConsumerId = randomUUID();
      const res = await ask({
        userId,
        serverId,
        toolName: TOOL,
        proxyConsumer: { id: kongConsumerId, username: "disabled" },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.decision).toBe("deny");
      // its OWN reason: an operator reading `deny` with a grant in place would
      // otherwise go looking for a policy that does not exist
      expect(body.reason).toBe("subject_disabled");

      // and the attempt is on the ledger, attributable to the Kong consumer
      // that presented it — a deactivated account knocking is a fact worth
      // keeping, not a request to drop on the floor
      const row = await latestRowFor(userId);
      expect(row!.effect).toBe("deny");
      expect(row!.ruleId).toBe("subject_disabled");
      const detail = row!.detail as { proxyConsumer?: unknown; via?: string };
      expect(detail.via).toBe("authz_check");
      expect(detail.proxyConsumer).toEqual({ id: kongConsumerId, username: "disabled" });
    } finally {
      await db.update(users).set({ disabledAt: null }).where(eq(users.id, userId));
    }

    // NON-VACUITY: reactivation restores the decision, so the refusal above
    // was the deactivation and not a missing grant
    const after = await ask({ userId, serverId, toolName: TOOL });
    expect(JSON.parse(after.body).decision).toBe("allow");
  });

  it("a subject NOBODY has is a deny the proxy can route on, not a 404 and not a guess", async () => {
    // ADR-0022 has no hard delete, so the shape of a deleted identity is a
    // mapping whose UUID names nobody: a consumer pointed at an account that
    // never existed here, or one removed outside the product.
    const res = await ask({ userId: randomUUID(), serverId, toolName: TOOL });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.decision).toBe("deny");
    expect(body.reason).toBe("unknown_subject");
  });

  it("an unknown tool is still answered before the subject is looked at", async () => {
    // the pre-existing branch keeps its reason; the subject check sits after it
    const res = await ask({ userId: randomUUID(), serverId, toolName: "no_such_tool" });
    expect(JSON.parse(res.body).reason).toBe("unknown_tool");
  });
});
