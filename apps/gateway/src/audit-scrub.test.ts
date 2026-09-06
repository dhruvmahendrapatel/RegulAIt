/**
 * ADR-0099 e2e — proof BY THE STORED ROW.
 *
 * The pure half of this feature is tested in `packages/shared` against the
 * function. That proves the RULE. It does not prove the rule is WIRED, and a
 * scrubber that is correct and unreachable protects nothing. So every assertion
 * in this file reads the row back OUT OF POSTGRES with a SELECT after the write
 * has committed — never the function's return value, never the HTTP response.
 *
 * Four things are proven here, in this order, because each one is the reason
 * the next one matters:
 *
 *  1. A credential driven through a REAL ROUTE is stored redacted.
 *  2. A RAW `db.insert(auditLog)` — no helper, no route, the thing a new module
 *     writes next month — is stored redacted too. That is what proves the scrub
 *     is sited at the chained-insert path and not at the ~30 call sites.
 *  3. ADR-0060's chain still VERIFIES over the redacted rows. The scrub runs
 *     before the hash; if it ran after, every row here would come back
 *     `content_mismatch` and this suite would be the alarm.
 *  4. ORDINARY detail is byte-identical afterwards. This is not a courtesy
 *     test — a ledger whose legitimate content gets mangled is a worse outcome
 *     than the risk being closed, so the negative case is asserted as hard as
 *     the positive one, on the bytes Postgres actually holds.
 *
 * Shares one DB with the other gateway suites (fileParallelism off); everything
 * here is prefixed `as-`. Chain verification is BOUNDED to the seq range this
 * file itself wrote (M-008: deltas, never absolutes) — earlier suites' rows are
 * their own business, and a bounded scan is exactly the shape ADR-0060 already
 * supports.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { and, auditLog, createDb, eq, runMigrations, sql, type Db } from "@regulait/db";
import { auditContentHash, auditRowHash } from "@regulait/shared";
import { buildApp } from "./app.js";
import { verifyAuditChain } from "./audit-chain.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "as-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

/** Credential fixtures. Every one is a SHAPE, not a live secret: the AWS id is
 * AWS's own published example, and the RegulAIt tokens are hex fill. */
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const RGL_KEY = `rgl_${"a1b2c3d4".repeat(6)}`;
const RGLV_KEY = `rglv_${"9f8e7d6c".repeat(6)}`;
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKASCRUBBODY\n-----END RSA PRIVATE KEY-----";

let db: Db;
let app: ReturnType<typeof buildApp>;
let ownerAuth: { authorization: string };

/** The seq the chain was at before this file wrote anything. Every chain
 * assertion is bounded to seq > this, so nothing here depends on what the rest
 * of the suite did. */
let seqFloor = 0;

async function makeUser(email: string) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  expect(user.statusCode).toBe(201);
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${user.json().id}/keys`,
    payload: { name: "as-key" },
  });
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

/** Register a risk and move it, which is a REAL audited route whose caller-
 * supplied `reason` lands in BOTH the `reason` column and `detail.reason`. */
async function transitionWithReason(reason: string, title: string) {
  const reg = await app.inject({
    method: "POST",
    headers: ownerAuth,
    url: "/v1/risks",
    payload: {
      title,
      description: "a named scenario for the register",
      category: "tool_misuse",
      likelihood: "medium",
      impact: "high",
    },
  });
  expect(reg.statusCode).toBe(201);
  const riskId = reg.json().id as string;
  const res = await app.inject({
    method: "POST",
    headers: ownerAuth,
    url: `/v1/risks/${riskId}/transition`,
    payload: { status: "mitigating", reason },
  });
  expect(res.statusCode).toBe(200);
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, riskId), eq(auditLog.ruleId, "risk-mitigating")));
  expect(rows.length).toBe(1);
  return rows[0]!;
}

/** Read one row back with raw SQL, so nothing in the ORM layer can be the
 * reason an assertion passes. */
async function rawRow(id: string): Promise<Record<string, any>> {
  const res = await db.execute(sql`select * from audit_log where id = ${id}`);
  const row = (res as unknown as { rows: Array<Record<string, any>> }).rows[0];
  if (!row) throw new Error(`no audit_log row ${id}`);
  return row;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  ownerAuth = (await makeUser("as-owner@example.com")).auth;
  const tip = await db.execute(sql`select coalesce(max(seq), 0)::int as s from audit_log`);
  seqFloor = (tip as unknown as { rows: Array<{ s: number }> }).rows[0]!.s;
});

afterAll(async () => {
  await app.close();
  await db.$client.end();
});

// ---------------------------------------------------------------------------

describe("1. a credential driven through a REAL route is stored redacted", () => {
  it("redacts an AWS key out of both the reason column and detail.reason", async () => {
    const row = await transitionWithReason(
      `rotating after ${AWS_KEY} was found in the connector config`,
      "as-real-path",
    );
    const stored = await rawRow(row.id);

    expect(stored.reason).not.toContain(AWS_KEY);
    expect(stored.reason).toMatch(/\[redacted:aws_key:20:[0-9a-f]{12}\]/);
    // the surrounding sentence — the evidentiary content — is still there
    expect(stored.reason).toContain("rotating after ");
    expect(stored.reason).toContain(" was found in the connector config");

    const detail = stored.detail as { phase: string; from: string; to: string; reason: string };
    expect(detail.reason).not.toContain(AWS_KEY);
    expect(detail.reason).toMatch(/\[redacted:aws_key:20:[0-9a-f]{12}\]/);
    // structure around it untouched
    expect(detail.phase).toBe("transition");
    expect(detail.from).toBe("open");
    expect(detail.to).toBe("mitigating");
  });

  it("redacts the credential shapes THIS product mints, including a whole PEM block", async () => {
    const r1 = await rawRow((await transitionWithReason(`key ${RGL_KEY} leaked`, "as-rgl")).id);
    expect(r1.reason).not.toContain(RGL_KEY);
    expect(r1.reason).toContain("[redacted:regulait_token:");

    const r2 = await rawRow((await transitionWithReason(`virtual ${RGLV_KEY} leaked`, "as-rglv")).id);
    expect(r2.reason).not.toContain(RGLV_KEY);

    const r3 = await rawRow((await transitionWithReason(`pasted:\n${PEM}`, "as-pem")).id);
    expect(r3.reason).not.toContain("SCRUBBODY");
    expect(r3.reason).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(r3.reason).toContain("pasted:\n");
  });

  it("CORRELATES across rows: the same key twice yields the same marker, a different key does not", async () => {
    const a = await rawRow((await transitionWithReason(`sighting one ${AWS_KEY}`, "as-corr-a")).id);
    const b = await rawRow((await transitionWithReason(`sighting two ${AWS_KEY}`, "as-corr-b")).id);
    const c = await rawRow((await transitionWithReason(`sighting three ${RGL_KEY}`, "as-corr-c")).id);
    const marker = (s: string) => /\[redacted:[^\]]+\]/.exec(s)?.[0];
    expect(marker(a.reason)).toBeTruthy();
    expect(marker(a.reason)).toBe(marker(b.reason));
    expect(marker(c.reason)).not.toBe(marker(a.reason));
  });
});

// ---------------------------------------------------------------------------

describe("2. a RAW db.insert(auditLog) — no helper, no route — is redacted too", () => {
  it("scrubs a raw insert, which is what proves the scrub is sited at the write path", async () => {
    const id = randomUUID();
    await db.insert(auditLog).values({
      id,
      userId: "00000000-0000-0000-0000-0000000000aa",
      objectType: "mcp_tool",
      objectId: null,
      toolName: "as-raw-tool",
      detail: {
        phase: "as-raw",
        // a shaped credential nested inside ordinary structure …
        note: `connector handshake used ${AWS_KEY}`,
        // … and a SHAPELESS one that only its field NAME gives away
        bootstrapToken: "seed-bootstrap",
        // … and ordinary content that must survive
        tokensIn: 1200,
        model: "claude-opus-4",
        nested: { deeper: [`bearer ${RGL_KEY}`, "untouched"] },
      },
      effect: "allow",
      ruleId: "as-raw-insert",
      ruleChain: ["as"],
      reason: `raw insert carrying ${AWS_KEY} straight into the ledger`,
    });

    const stored = await rawRow(id);
    expect(stored.reason).not.toContain(AWS_KEY);
    expect(stored.reason).toContain("raw insert carrying ");

    const d = stored.detail as Record<string, any>;
    expect(d.note).not.toContain(AWS_KEY);
    expect(d.note).toContain("connector handshake used ");
    expect(d.bootstrapToken).toMatch(/^\[redacted:field:\d+:[0-9a-f]{12}\]$/);
    expect(d.nested.deeper[0]).not.toContain(RGL_KEY);
    expect(d.nested.deeper[1]).toBe("untouched");
    // ordinary content in the SAME row is untouched
    expect(d.tokensIn).toBe(1200);
    expect(d.model).toBe("claude-opus-4");
    expect(d.phase).toBe("as-raw");
    // the row is fully chained despite being raw
    expect(stored.seq).not.toBeNull();
    expect(stored.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("scrubs a raw insert made INSIDE a caller's transaction", async () => {
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(auditLog).values({
        id,
        userId: "00000000-0000-0000-0000-0000000000aa",
        objectType: "mcp_tool",
        effect: "deny",
        ruleId: "as-raw-tx",
        ruleChain: [],
        reason: `inside a transaction: ${RGLV_KEY}`,
      });
    });
    const stored = await rawRow(id);
    expect(stored.reason).not.toContain(RGLV_KEY);
    expect(stored.reason).toContain("inside a transaction: ");
    expect(stored.seq).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("3. THE ORDERING PROOF — ADR-0060 still verifies over redacted rows", () => {
  it("recomputes each redacted row's own content_hash from the STORED (scrubbed) fields", async () => {
    const res = await db.execute(sql`
      select seq, id, at, user_id, object_type, object_id, detail, server_id, tool_name,
             effect, rule_id, rule_chain, reason, deploy_mode, content_hash, prev_hash, row_hash
      from audit_log where seq > ${seqFloor} and reason like '%[redacted:%' order by seq asc
    `);
    const rows = (res as unknown as { rows: Array<Record<string, any>> }).rows;
    // this file has already written several redacted rows by now
    expect(rows.length).toBeGreaterThan(0);

    for (const r of rows) {
      const recomputed = auditContentHash({
        id: r.id,
        at: r.at,
        userId: r.user_id,
        objectType: r.object_type,
        objectId: r.object_id,
        detail: r.detail,
        serverId: r.server_id,
        toolName: r.tool_name,
        effect: r.effect,
        ruleId: r.rule_id,
        ruleChain: r.rule_chain,
        reason: r.reason,
        deployMode: r.deploy_mode,
      });
      // The row that was HASHED is the row that was STORED — which is only true
      // because the scrub runs BEFORE auditContentHash. Scrub-after-hash would
      // fail exactly here, on every row.
      expect(recomputed, `content_hash at seq ${r.seq}`).toBe(r.content_hash);
      expect(auditRowHash(r.prev_hash, recomputed)).toBe(r.row_hash);
    }
  });

  it("verifies the chain over the range this file wrote, redacted rows and all", async () => {
    const report = await verifyAuditChain(db, null, { fromSeq: seqFloor + 1 });
    expect(report.firstBreak).toBeNull();
    expect(report.status).toBe("ok");
    expect(report.scanned.rows).toBeGreaterThan(0);
    expect(report.scanned.bounded).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("4. THE OVER-SCRUB GUARD — ordinary detail is byte-identical in the table", () => {
  it("stores an ordinary reason exactly as it was written", async () => {
    const reason =
      "moved to mitigating: owner 3f8a2b1c-0000-4444-8888-abcdefabcdef notified " +
      "dhruv@example.com, routed to claude-opus-4-20260101 under rule mcp.allow.default, " +
      "1200 input tokens at $12.4501 — the key insight is that caching dominates the cost";
    const row = await transitionWithReason(reason, "as-ordinary");
    const stored = await rawRow(row.id);
    // `detail.reason` is the caller's string verbatim — the strictest possible
    // form of the guard: same bytes in, same bytes out of Postgres.
    expect((stored.detail as { reason: string }).reason).toBe(reason);
    // the route composes the column from a template around the same string
    expect(stored.reason).toBe(`AI risk 'as-ordinary' moved open -> mitigating: ${reason}`);
    expect(stored.reason).not.toContain("[redacted:");
  });

  it("stores an ordinary raw-insert detail object with every value unchanged", async () => {
    const id = randomUUID();
    const detail = {
      phase: "dispatch",
      tokensIn: 1200,
      tokensOut: 340,
      tokenCount: 5,
      totalTokens: 1540,
      apiKeyId: "7f2c1e90-0000-4000-8000-000000000001",
      scimTokenName: "okta-prod",
      secretsScanned: 12,
      model: "claude-opus-4",
      email: "dhruv@example.com",
      ruleChain: ["org-default", "project-override"],
      flags: [true, false, null],
      note: "we store secrets in the encrypted vault, never in git",
      empty: "",
    };
    await db.insert(auditLog).values({
      id,
      userId: "00000000-0000-0000-0000-0000000000aa",
      objectType: "mcp_tool",
      toolName: "search_docs",
      detail,
      effect: "allow",
      ruleId: "as-ordinary-raw",
      ruleChain: ["as"],
      reason: "nothing sensitive in this row at all",
    });
    const stored = await rawRow(id);
    // jsonb round-trips key ORDER, not content — so compare as values
    expect(stored.detail).toEqual(detail);
    expect(stored.reason).toBe("nothing sensitive in this row at all");
    expect(stored.tool_name).toBe("search_docs");
  });
});
