/**
 * ADR-0345 (lane E26) slice 1 — the agent risk proof tables, against a real database.
 *
 *  - a proof result is append-only evidence: UPDATE, DELETE and TRUNCATE are refused;
 *  - the shape CHECKs hold: the key format, a 64-hex content hash, signature and key id both or neither, the outcome
 *    vocabulary, an interval inside 1..168 hours;
 *  - NEGATIVE: all three tables are under forced row-level security. Results and follow-ups are READ by an admin and
 *    INSERTED only by the `system_task` / `migration` reasons, so not even an admin can fabricate a pass (#904
 *    security review); settings are admin-writable;
 *  - every control the catalogue binds to a setting column or a policy table exists in the migrated database (#904
 *    code review: an unknown name fails here).
 *
 * The suite disables the users it creates; evidence rows stay, by design.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDb, eq, inArray, runMigrations, sql, users, type Db } from "@regulait/db";
import { AGENT_RISKS, agentRiskControlColumns, agentRiskControlTables } from "@regulait/shared";
import { ORG_SETTING_STRICTNESS } from "./org-setting-strictness.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const HASH = "a".repeat(64);
let db: Db;
let adminId: string;
let memberId: string;
let resultId: string;

const failure = (p: Promise<unknown>) =>
  p.then(
    () => "no error",
    (e: { message?: string; cause?: { message?: string } }) => String(e?.cause?.message ?? e?.message),
  );

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const made = await db
    .insert(users)
    .values([
      { email: `e26-admin-${RUN}@example.test`, displayName: "e26 admin", isAdmin: true },
      { email: `e26-member-${RUN}@example.test`, displayName: "e26 member", isAdmin: false },
    ])
    .returning({ id: users.id });
  adminId = made[0]!.id;
  memberId = made[1]!.id;
  const r = await db.execute(sql`
    insert into agent_risk_proof_results (proof_key, catalog_version, trigger, outcome, run_as_user_id, audit_log_id,
      content_hash, detail, started_at)
    values ('access_control.approval_replay', 1, 'scheduled', 'pass', ${adminId}, ${randomUUID()}, ${HASH},
      '{"refusal":"approval_consumed"}', now())
    returning id`);
  resultId = (r.rows[0] as { id: string }).id;
});

afterAll(async () => {
  await db.update(users).set({ disabledAt: new Date() }).where(inArray(users.id, [adminId, memberId]));
});

describe("ADR-0345: proof results are append-only evidence", () => {
  it("refuses UPDATE, DELETE and TRUNCATE", async () => {
    expect(await failure(db.execute(sql`update agent_risk_proof_results set outcome = 'fail' where id = ${resultId}`))).not.toBe(
      "no error",
    );
    expect(await failure(db.execute(sql`delete from agent_risk_proof_results where id = ${resultId}`))).not.toBe("no error");
    expect(await failure(db.execute(sql`truncate agent_risk_proof_results cascade`))).not.toBe("no error");
    const still = await db.execute(sql`select outcome from agent_risk_proof_results where id = ${resultId}`);
    expect(still.rows).toEqual([{ outcome: "pass" }]);
  });

  it("enforces the evidence shape", async () => {
    const insert = (o: { key?: string; hash?: string; sig?: string | null; keyId?: string | null; outcome?: string }) =>
      failure(
        db.execute(sql`
          insert into agent_risk_proof_results (proof_key, catalog_version, trigger, outcome, audit_log_id, content_hash,
            signature, signing_key_id, detail, started_at)
          values (${o.key ?? "x.y"}, 1, 'manual', ${o.outcome ?? "fail"}, ${randomUUID()}, ${o.hash ?? HASH},
            ${o.sig ?? null}, ${o.keyId ?? null}, '{}', now())`),
      );
    expect(await insert({ key: "No Dot" })).toMatch(/agent_risk_proof_results_key_check/);
    expect(await insert({ hash: "short" })).toMatch(/agent_risk_proof_results_hash_check/);
    expect(await insert({ sig: "c2ln" })).toMatch(/agent_risk_proof_results_signature_check/);
    expect(await insert({ outcome: "skipped" })).toMatch(/agent_risk_proof_results_outcome_check/);
    // ADR-0180's vocabulary, not a second one: `error` is not a state, `insufficient` and `not_run` are
    expect(await insert({ outcome: "error" })).toMatch(/agent_risk_proof_results_outcome_check/);
    expect(await insert({ outcome: "insufficient" })).toBe("no error");
    expect(await insert({ outcome: "not_run" })).toBe("no error");
    expect(await insert({ sig: "c2ln", keyId: `k-${RUN}` })).toBe("no error");
  });

  it("bounds a relaxed schedule to 1..168 hours", async () => {
    const key = `e_${RUN.replace(/[0-9]/g, "x")}.relax`;
    expect(
      await failure(db.execute(sql`insert into agent_risk_proof_settings (proof_key, interval_hours) values (${key}, 169)`)),
    ).toMatch(/agent_risk_proof_settings_interval_check/);
    expect(
      await failure(db.execute(sql`insert into agent_risk_proof_settings (proof_key, interval_hours) values (${key}, 0)`)),
    ).toMatch(/agent_risk_proof_settings_interval_check/);
    expect(
      await failure(
        db.execute(sql`insert into agent_risk_proof_settings (proof_key, enabled, interval_hours, updated_by_user_id)
          values (${key}, false, 48, ${adminId})`),
      ),
    ).toBe("no error");
    await db.execute(sql`delete from agent_risk_proof_settings where proof_key = ${key}`);
  });
});

describe("ADR-0345: row-level security on the proof tables", () => {
  const TABLES = ["agent_risk_proof_followups", "agent_risk_proof_results", "agent_risk_proof_settings"];
  const countAs = async (opts: { userId?: string; reason?: string }) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('role', 'regulait_app', true)`);
      if (opts.userId) await tx.execute(sql`select set_config('regulait.user_id', ${opts.userId}, true)`);
      if (opts.reason) await tx.execute(sql`select set_config('regulait.system_context', ${opts.reason}, true)`);
      const r = await tx.execute(sql`select count(*)::int as n from agent_risk_proof_results`);
      return (r.rows[0] as { n: number }).n;
    });

  it("all three tables have row-level security ENABLED and FORCED", async () => {
    const r = await db.execute(sql`
      select relname, relrowsecurity as on, relforcerowsecurity as forced from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r' and relname like 'agent\_risk\_proof\_%' order by relname`);
    expect(r.rows).toEqual(TABLES.map((relname) => ({ relname, on: true, forced: true })));
  });

  it("NEGATIVE: a plain connection, a non-admin principal and another system reason see no result", async () => {
    const all = ((await db.execute(sql`select count(*)::int as n from agent_risk_proof_results`)).rows[0] as { n: number }).n;
    expect(all).toBeGreaterThan(0);
    expect(await countAs({})).toBe(0);
    expect(await countAs({ userId: memberId })).toBe(0);
    expect(await countAs({ reason: "public_ingest" })).toBe(0);
    expect(await countAs({ userId: adminId })).toBe(all);
    expect(await countAs({ reason: "system_task" })).toBe(all);
  });

  const writeAs = (opts: { userId?: string; reason?: string }, stmt: ReturnType<typeof sql>) =>
    failure(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('role', 'regulait_app', true)`);
        if (opts.userId) await tx.execute(sql`select set_config('regulait.user_id', ${opts.userId}, true)`);
        if (opts.reason) await tx.execute(sql`select set_config('regulait.system_context', ${opts.reason}, true)`);
        await tx.execute(stmt);
      }),
    );
  const insertResult = () => sql`
    insert into agent_risk_proof_results (proof_key, catalog_version, trigger, outcome, audit_log_id, content_hash,
      detail, started_at)
    values ('x.y', 1, 'manual', 'pass', ${randomUUID()}, ${HASH}, '{}', now())`;

  it("NEGATIVE: neither a member nor an ADMIN principal can insert a result or a follow-up", async () => {
    expect(await writeAs({ userId: memberId }, insertResult())).toMatch(/row-level security/);
    expect(await writeAs({ userId: adminId }, insertResult())).toMatch(/row-level security/);
    expect(await writeAs({ reason: "public_ingest" }, insertResult())).toMatch(/row-level security/);
    const followup = sql`insert into agent_risk_proof_followups (result_id) values (${resultId})`;
    expect(await writeAs({ userId: adminId }, followup)).toMatch(/row-level security/);
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, memberId));
    expect(u?.id).toBe(memberId);
  });

  it("the proof runner (system_task) inserts a result; an admin may still write settings", async () => {
    expect(await writeAs({ reason: "system_task" }, insertResult())).toBe("no error");
    const key = `s_${RUN.replace(/[0-9]/g, "x")}.admin`;
    expect(
      await writeAs({ userId: adminId }, sql`insert into agent_risk_proof_settings (proof_key, enabled) values (${key}, false)`),
    ).toBe("no error");
    await db.execute(sql`delete from agent_risk_proof_settings where proof_key = ${key}`);
  });
});

describe("ADR-0345: every catalogue control is bound to something that exists", () => {
  it("each setting column exists", async () => {
    const cols = agentRiskControlColumns();
    expect(cols.length).toBeGreaterThan(5);
    const r = await db.execute(sql`
      select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'public'`);
    const live = new Set((r.rows as { c: string }[]).map((x) => x.c));
    expect(cols.filter((c) => !live.has(c))).toEqual([]);
  });

  it("each policy table exists", async () => {
    const tables = agentRiskControlTables();
    const r = await db.execute(sql`select table_name as t from information_schema.tables where table_schema = 'public'`);
    const live = new Set((r.rows as { t: string }[]).map((x) => x.t));
    expect(tables.filter((t) => !live.has(t))).toEqual([]);
  });
});

describe("ADR-0345: an org_settings control's secure value IS the strictness registry's (#904 round 2)", () => {
  const camel = (snake: string) => snake.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  const orgControls = AGENT_RISKS.flatMap((r) =>
    r.controls.flatMap((c) => (c.kind === "setting" && c.column.startsWith("org_settings.") ? [{ risk: r.key, c }] : [])),
  );

  it("names at least the four org_settings controls", () => {
    expect(orgControls.map((x) => x.c.kind === "setting" && x.c.column).sort()).toEqual([
      "org_settings.approval_ttl_hours",
      "org_settings.budget_enforcement",
      "org_settings.mcp_admission_mode",
      "org_settings.mcp_definition_pin_mode",
    ]);
  });

  it("each one is a registry rule (never an exemption) whose strict value the catalogue calls secure", () => {
    for (const { risk, c } of orgControls) {
      if (c.kind !== "setting") continue;
      const key = camel(c.column.slice("org_settings.".length)) as keyof typeof ORG_SETTING_STRICTNESS;
      const entry = ORG_SETTING_STRICTNESS[key];
      expect(entry, `${risk}: ${c.column} is not in ORG_SETTING_STRICTNESS`).toBeDefined();
      expect(entry.kind, `${risk}: ${c.column} is exempt from the registry, so it is not a control`).toBe("rule");
      if (entry.kind !== "rule") continue;
      const s = c.secure;
      if ("oneOf" in s) {
        // the registry's strict value is secure, and every value the catalogue calls secure is not a relaxation
        expect(s.oneOf).toContain(entry.strict);
        for (const v of s.oneOf) expect(entry.relaxed(v), `${c.column}=${v}`).toBe(false);
      } else if ("atMost" in s) {
        expect(entry.strict).toBe(s.atMost);
        expect(entry.relaxed(s.atMost)).toBe(false);
        expect(entry.relaxed(s.atMost + 1)).toBe(true);
      } else {
        expect(entry.strict).toBe(s.atLeast);
        expect(entry.relaxed(s.atLeast)).toBe(false);
        expect(entry.relaxed(s.atLeast - 1)).toBe(true);
      }
    }
  });

  it("NEGATIVE: an exempt capacity key such as max_worker_turns would be refused as a control", () => {
    expect(ORG_SETTING_STRICTNESS.maxWorkerTurns.kind).toBe("exempt");
  });
});

