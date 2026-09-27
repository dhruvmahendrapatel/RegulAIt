/**
 * ADR-0127 — a decision nobody acted on must not count as a thing that
 * happened.
 *
 * WHAT WAS WRONG. The kernel's rate limits are `count(audit_log)` over rows
 * with `effect = 'allow'` for a user in a window. Every governed execution
 * writes one, correctly. So did `POST /v1/evaluate`, which EXECUTES NOTHING —
 * so asking "what would you decide" spent the subject's budget on traffic that
 * never ran, and asking before doing counted twice.
 *
 * It was survivable while that route was an occasional admin preview. ROADMAP
 * G9 makes it a correctness problem: the entire premise of a PDP callout is
 * that a proxy asks this on EVERY request it handles, so adopting the topology
 * we recommend would have made the product mis-count its own limits in
 * proportion to how much the customer used it.
 *
 * These tests drive the arithmetic directly rather than asserting on the flag,
 * because the flag is a means: what matters is whether a budget is consumed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvalRules,
  auditLog,
  createDb,
  desc,
  eq,
  mcpServers,
  mcpTools,
  rateLimits,
  runMigrations,
  toolGrants,
  users,
  type Db,
} from "@regulait/db";
import { advisoryDetail, isAdvisoryDetail } from "@regulait/shared";
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

const BOOT = "adr0127-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let serverId: string;
let limitId: string;

const TOOL = "adr0127_read";
const MAX_CALLS = 3;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const [u] = await db
    .insert(users)
    .values({ email: `adr0127-${randomUUID()}@advisory.example`, displayName: "ADR0127" })
    .returning({ id: users.id });
  userId = u!.id;

  const [s] = await db
    .insert(mcpServers)
    .values({ name: `adr0127-${randomUUID()}`, url: "http://127.0.0.1:9/" })
    .returning({ id: mcpServers.id });
  serverId = s!.id;

  await db.insert(mcpTools).values({ serverId, name: TOOL, kind: "read" });
  // an explicit grant, so the decision is `allow` and therefore counted
  await db.insert(toolGrants).values({ userId, serverId, toolName: TOOL });
  const [limit] = await db
    .insert(rateLimits)
    .values({
      scope: "user",
      userId,
      serverScope: "server",
      serverId,
      maxCalls: MAX_CALLS,
      windowSeconds: 3600,
    })
    .returning({ id: rateLimits.id });
  limitId = limit!.id;
}, 120_000);

afterAll(async () => {
  await app.close();
});

const evaluate = () =>
  app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/evaluate",
    payload: { userId, serverId, toolName: TOOL },
  });

/** an EXECUTION-shaped row: exactly what a governed call writes */
const recordExecution = async () =>
  db.insert(auditLog).values({
    userId,
    serverId,
    toolName: TOOL,
    effect: "allow",
    ruleId: "test-execution",
    ruleChain: [],
    reason: "a real call, counted",
  });

describe("asking is not doing", () => {
  it("THE FIX: previews never exhaust the budget, however many are asked", async () => {
    // Far past the ceiling of 3. Before ADR-0127 the fourth of these came back
    // `rate_limited`, because each preview had written a countable allow row.
    for (let i = 0; i < MAX_CALLS * 4; i += 1) {
      const res = await evaluate();
      expect(res.statusCode).toBe(200);
      expect(res.json().effect).toBe("allow");
    }
  });

  it("but real executions still do — the limit is not simply switched off", async () => {
    // GUARD AGAINST A VACUOUS PASS. The test above would also pass if the fix
    // had broken rate limiting outright, which is the dangerous way to get it
    // wrong: the failure would look like success.
    for (let i = 0; i < MAX_CALLS; i += 1) await recordExecution();

    const res = await evaluate();
    expect(res.statusCode).toBe(200);
    expect(res.json().effect).toBe("deny");
    // the refusal names THE limit that refused it — a rate-limited decision
    // carries the limit row's id, not a symbolic string (M-039's lesson about
    // what a `ruleId` actually holds)
    expect(res.json().ruleId).toBe(limitId);
  });

  it("an execution whose detail is NULL is still counted", async () => {
    // The three-valued-logic trap: `detail` is nullable, `NULL ->> 'advisory'`
    // is NULL, and `NOT (NULL = 'true')` is NULL — which would have filtered
    // the row OUT and quietly stopped counting every execution that wrote no
    // detail. `recordExecution` above writes none, and the deny it produced in
    // the previous test is the proof.
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "test-execution"))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(row!.detail).toBeNull();
    expect(isAdvisoryDetail(row!.detail)).toBe(false);
  });
});

describe("the marker itself", () => {
  it("is written into the ledger, so the row still records that the question was asked", async () => {
    const before = await db.select().from(auditLog).where(eq(auditLog.userId, userId));
    await evaluate();
    const after = await db.select().from(auditLog).where(eq(auditLog.userId, userId));
    // NOT suppressed — a question about someone's entitlements is worth keeping
    expect(after.length).toBe(before.length + 1);

    const [latest] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, userId))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(isAdvisoryDetail(latest!.detail)).toBe(true);
  });

  it("rides inside the CONTENT HASH, so it cannot be flipped without breaking the chain", () => {
    // This is why the marker is a key in `detail` rather than a new column:
    // `content_hash` is taken over an enumerated field list that includes
    // `detail`, so the flag is tamper-evident for free. A column would have sat
    // outside the hash unless the payload version were bumped — and a flag
    // outside the hash, in the one table this product asks people to trust,
    // could be flipped on an executed row to change what the limiter counts.
    const executed = { some: "context" };
    const asked = advisoryDetail(executed);
    expect(isAdvisoryDetail(executed)).toBe(false);
    expect(isAdvisoryDetail(asked)).toBe(true);
    // the caller's own context survives alongside the marker
    expect(asked.some).toBe("context");
  });

  it("defaults to COUNTED, so a future producer that forgets is not silently exempt", () => {
    expect(isAdvisoryDetail(null)).toBe(false);
    expect(isAdvisoryDetail({})).toBe(false);
    expect(isAdvisoryDetail({ advisory: false })).toBe(false);
    expect(isAdvisoryDetail("advisory")).toBe(false);
    expect(isAdvisoryDetail([{ advisory: true }])).toBe(false);
  });
});

// ===========================================================================
// ADR-0127 §2 — the authorization callout
// ===========================================================================
//
// The contract here is a COMPATIBILITY SURFACE: a proxy routes on these codes,
// so changing what one means breaks somebody's routing table silently. These
// tests exist to make that change loud.

describe("POST /v1/authz/check", () => {
  /**
   * ITS OWN SUBJECT, and the reason is worth keeping. The block above
   * deliberately drives the rate limit to exhaustion to prove executions still
   * count — so a callout test sharing that user inherits a genuinely
   * rate-limited subject and fails for a reason that has nothing to do with the
   * callout. The first draft of this file did exactly that (M-042's family: an
   * assertion resting on state another block created). A run-unique subject
   * cannot be reached by it.
   */
  let subjectId: string;

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `callout-${randomUUID()}@advisory.example`, displayName: "Callout" })
      .returning({ id: users.id });
    subjectId = u!.id;
    await db.insert(toolGrants).values({ userId: subjectId, serverId, toolName: TOOL });
  });

  const check = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", headers: AUTH, url: "/v1/authz/check", payload });

  it("answers with a closed set of codes and NOTHING else", async () => {
    const res = await check({ userId: subjectId, serverId, toolName: TOOL });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.decision).toBe("allow");

    // THE LEAK TEST, and the reason this endpoint exists rather than the
    // adapters pointing at /v1/evaluate. `Decision.reason` and `ruleChain`
    // carry rule ids, grant ids, role names and approver DISPLAY NAMES AND
    // EMAILS. A data-plane proxy may log, forward or render whatever it gets.
    //
    // AER-028 widened this set by exactly one field: `contextApplied`, the
    // NAMES of the dimensions the decision was computed on. It is listed here
    // rather than exempted, because the value of this assertion is that the set
    // is closed — a new field must be added deliberately, by someone who has
    // read the paragraph above and decided it carries nothing.
    expect(Object.keys(body).sort()).toEqual(["contextApplied", "decision", "reason"]);
    expect(body).not.toHaveProperty("ruleChain");
    expect(body).not.toHaveProperty("approverName");
    expect(body).not.toHaveProperty("effect");

    // and `contextApplied` is itself a closed vocabulary of DIMENSION NAMES.
    // An implementation that put the argument values in here would satisfy the
    // key check above and leak the very thing that check exists to prevent.
    expect(Array.isArray(body.contextApplied)).toBe(true);
    for (const name of body.contextApplied as string[]) {
      expect(["args", "projectId", "principal"]).toContain(name);
    }
  });

  it("an unknown tool is a DENY, not a 404", async () => {
    // A proxy needs an answer it can route on. A 404 invites a fail-open
    // `catch` in somebody's Lua — the request sails through because the
    // adapter could not parse a refusal.
    const res = await check({ userId: subjectId, serverId, toolName: "no_such_tool" });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision).toBe("deny");
    expect(res.json().reason).toBe("unknown_tool");
  });

  it("a subject with no grant is denied", async () => {
    const [stranger] = await db
      .insert(users)
      .values({ email: `stranger-${randomUUID()}@advisory.example`, displayName: "Stranger" })
      .returning({ id: users.id });
    const res = await check({ userId: stranger!.id, serverId, toolName: TOOL });
    expect(res.json().decision).toBe("deny");
  });

  it("require_approval maps to its OWN code, never a flat deny", async () => {
    // The distinction the approvals queue exists to make: "a human can unblock
    // this" versus "never". Envoy has two outcomes and no third, so this must
    // be a denial at the proxy — but if it arrived indistinguishable from a
    // policy refusal, the caller could not tell a recoverable hold from a hard
    // no, and the queue would be invisible to everyone behind the gateway.
    const [approver] = await db
      .insert(users)
      .values({ email: `approver-${randomUUID()}@advisory.example`, displayName: "Approver" })
      .returning({ id: users.id });
    const writeTool = "adr0127_write";
    await db.insert(mcpTools).values({ serverId, name: writeTool, kind: "write" });
    await db.insert(toolGrants).values({ userId: subjectId, serverId, toolName: writeTool });
    await db.insert(approvalRules).values({
      scope: "user",
      userId: subjectId,
      serverScope: "server",
      serverId,
      toolName: writeTool,
      writeOnly: false,
      approverUserId: approver!.id,
    });

    const res = await check({ userId: subjectId, serverId, toolName: writeTool });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision).toBe("approval_required");
    expect(res.json().decision).not.toBe("deny");
  });

  it("is ADVISORY: a proxy asking on every request cannot exhaust the subject's budget", async () => {
    // The whole premise of the callout topology. Without ADR-0127 §1 this is
    // the test that would have failed, and it would have failed in production
    // in proportion to how much the customer used the product.
    for (let i = 0; i < MAX_CALLS * 4; i += 1) {
      const res = await check({ userId: subjectId, serverId, toolName: TOOL });
      expect(res.json().decision).not.toBe("deny");
    }
    const [latest] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.toolName, TOOL))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(isAdvisoryDetail(latest!.detail)).toBe(true);
  });

  it("still files every question in the ledger, with the full chain the response withheld", async () => {
    // Minimal to the proxy, complete to the auditor. The chain is not lost —
    // it is kept where entitlement to read it is enforced.
    await check({ userId: subjectId, serverId, toolName: TOOL });
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.toolName, TOOL))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(row!.ruleChain).toBeDefined();
    expect((row!.detail as { via?: string }).via).toBe("authz_check");
  });
});
