/**
 * Seed e2e: the demo seeder must stay (a) runnable against a fresh database,
 * (b) idempotent — a second run converges instead of duplicating — and
 * (c) inclusive of the multi-turn demo conversation the Playground opens on
 * (Dana, 2 exchanges = 4 persisted messages, reply #2 visibly continuing
 * reply #1's topic).
 *
 * Runs the BUILT script (dist/seed.js — CI builds before testing) twice
 * against its own scratch database, so this suite can never pollute the
 * database the other gateway suites share.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  and,
  approvals,
  asc,
  auditLog,
  conversationMessages,
  conversations,
  createDb,
  eq,
  sql,
  users,
  workflowInstances,
  workflowTemplates,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

// Per-RUN unique name (pid + timestamp), not a fixed one: a fixed name is
// shared by every concurrent run on the host, and beforeAll's
// DROP ... WITH (FORCE) then terminates the other run's backends mid-suite —
// two concurrent runs destroy each other (PENDING §5). afterAll drops the
// database, so nothing accumulates on a normal exit; a run killed hard enough
// to skip afterAll leaves a uniquely-named orphan an operator can drop cold.
const SCRATCH_DB = `regulait_seed_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
})();
const seedScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/seed.js");

let admin: Db;
let scratch: Db;
// Owned by the suite, not by a single test: an assertion that throws part-way
// through a test must never be able to leave the app — and therefore the
// scratch database — pinned open past teardown.
let app: ReturnType<typeof buildApp> | undefined;
const seedRuns: Array<{ status: number | null; stderr: string; stdout: string }> = [];

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  for (let i = 0; i < 2; i++) {
    // ADR-0181 FX3: the seed runs only on an explicit demo signal
    const r = spawnSync(process.execPath, [seedScript, "--seed-demo"], {
      encoding: "utf8",
      // The seed enrols Ada's TOTP (ADR-0181 FX2), and the gateway refuses a TOTP enrolment
      // (409 data_key_required) without a data key: supply CI's 64-hex fixture key when the
      // invoking shell has none, so the result does not depend on the shell. Not a secret.
      env: { ...process.env, DATABASE_URL: scratchUrl, REGULAIT_DATA_KEY: process.env.REGULAIT_DATA_KEY || "a".repeat(64) },
      timeout: 180_000,
    });
    seedRuns.push({ status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" });
  }
  scratch = createDb(scratchUrl);
  // buildApp does NOT take ownership of the Db it is handed — it never ends the
  // pool, and `app.close()` only runs fastify's onClose hooks. Closing the app
  // and ending the pool are therefore two separate obligations of whoever
  // called createDb, and they have to happen in that order: fastify's onClose
  // can still touch the database.
  app = buildApp(scratch, { bootstrapToken: "seed-test-boot" });
}, 400_000);

afterAll(async () => {
  // Reverse order of construction, and every step runs even if an earlier one
  // throws. `dropScratchDatabase` waits for Postgres itself to report zero
  // backends on the scratch database before dropping it — see
  // ./testing/scratch-db.ts for why `await pool.end()` is not that guarantee.
  await closeAll([
    () => app?.close() ?? Promise.resolve(),
    () => scratch?.$client.end() ?? Promise.resolve(),
    () => dropScratchDatabase(admin, SCRATCH_DB),
    () => admin.$client.end(),
  ]);
});

describe("seed script", () => {
  it("runs clean twice against the same database", () => {
    expect(seedRuns).toHaveLength(2);
    for (const run of seedRuns) expect(run.status, run.stderr).toBe(0);
  });

  it("seeds Dana's demo conversation exactly once — no duplicate on re-run", async () => {
    const [dana] = await scratch
      .select()
      .from(users)
      .where(eq(users.email, "dana@regulait.local"));
    expect(dana).toBeDefined();
    const rows = await scratch
      .select()
      .from(conversations)
      .where(eq(conversations.userId, dana!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toMatch(/^Summarize the saved-payment-methods/);
    expect(rows[0]!.projectId).not.toBeNull();
  });

  it("the thread holds 4 ordered messages and reply #2 provably continues the topic", async () => {
    const [dana] = await scratch
      .select()
      .from(users)
      .where(eq(users.email, "dana@regulait.local"));
    const [convo] = await scratch
      .select()
      .from(conversations)
      .where(eq(conversations.userId, dana!.id));
    const msgs = await scratch
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, convo!.id))
      .orderBy(asc(conversationMessages.createdAt));
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // the terse follow-up's reply inherits the previous turn's topic — the
    // mock's visible proof that history flowed through the dispatch
    expect(msgs[2]!.content).toBe("Shorter — just the payment-methods bullets.");
    expect(msgs[3]!.content).toContain("Continuing from the previous");
    expect(msgs[3]!.content).toContain("saved-payment-methods"); // topic inherited from turn 1
    for (const assistant of [msgs[1]!, msgs[3]!]) {
      const detail = assistant.detail as {
        modelUsed?: string;
        costUsd?: number;
        refusal?: boolean;
      };
      expect(detail.modelUsed).toMatch(/^mock-/);
      expect(typeof detail.costUsd).toBe("number");
      expect(detail.refusal).toBe(false);
    }
  });

  it("seeds the deploy-verify pipeline resting at each newer workflow status", async () => {
    // ADR-0015 / C2: one instance apiece at blocked_on_check, blocked_on_deploy
    // and rolled_back — the three states the deploy tail introduced.
    const rows = await scratch.select().from(workflowInstances);
    const statuses = new Set(rows.map((r) => r.status));
    for (const want of ["blocked_on_check", "blocked_on_deploy", "rolled_back"]) {
      expect(statuses.has(want), `expected a seeded instance at ${want}`).toBe(true);
    }
    // the rolled_back instance actually recorded a deploy then reversed it
    const rolled = rows.find((r) => r.status === "rolled_back");
    expect(rolled).toBeDefined();
    const ctx = rolled!.context as Record<string, { reverted?: string; deployId?: string }>;
    expect(ctx["deploy:deploy"]?.deployId).toBeDefined();
    expect(ctx["rollback:undo"]?.reverted).toBe(ctx["deploy:deploy"]!.deployId);
  });

  it("AER-047: the demo templates' check stages opt in to the labelled offline auto-pass EXPLICITLY, and the auto-passed precheck is labelled", async () => {
    // The default is now "a check nobody reported is pending". The demo has no
    // CI, so every check stage it drives through unreported carries the typed
    // opt-in — nothing relies on a silent pass.
    const templates = await scratch.select().from(workflowTemplates);
    for (const name of ["complete-pipeline", "deploy-verify-pipeline"]) {
      const tpl = templates.find((t) => t.name === name);
      expect(tpl, `seeded template ${name}`).toBeDefined();
      const checkStages = (tpl!.definition as { stages: Array<{ id: string; type: string; offlineAutoPass?: boolean }> })
        .stages.filter((st) => st.type === "automated_check");
      expect(checkStages.length).toBeGreaterThan(0);
      for (const st of checkStages) expect(st.offlineAutoPass, `${name}.${st.id}`).toBe(true);
    }
    // the instance that sailed past an unreported precheck says so
    const rows = await scratch.select().from(workflowInstances);
    const parked = rows.find((r) => r.status === "blocked_on_deploy");
    const pre = (parked!.context as Record<string, unknown>)["checks:precheck"] as Array<Record<string, unknown>>;
    expect(pre).toEqual([
      expect.objectContaining({ check: "preflight", status: "passed", autoPassed: true, detail: "auto-passed — no report (offline mode)" }),
    ]);
  });

  // Item 4 (§8.3 headline): the cascade story must be live out of the box.
  it("parks ONE instance at the cascade-forced compliance-signoff, pending in Avery's inbox", async () => {
    const rows = (await scratch.select().from(workflowInstances)).filter(
      (i) => (i.change as { description?: string }).description ===
        "Redact and export the oncology cohort (PHI)",
    );
    // the seeder ran twice in beforeAll — a duplicate here is an idempotency bug
    expect(rows).toHaveLength(1);
    const inst = rows[0]!;
    expect(inst.status).toBe("blocked_on_approval");
    // the CURRENT stage is the one the tag cascaded in — no assignment rule
    // routes 'compliance-signoff'; it exists only because hipaa-project is
    // classified. That is the §8.3 headline in one row.
    const def = inst.definition as { stages: Array<{ id: string }> };
    const state = inst.state as { currentStageIndex: number };
    expect(def.stages[state.currentStageIndex]!.id).toBe("compliance-signoff");
    // and Avery can act on it: exactly one live approval row on that stage
    const [avery] = await scratch
      .select()
      .from(users)
      .where(eq(users.email, "avery@regulait.local"));
    const pending = await scratch
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.instanceId, inst.id),
          eq(approvals.stageId, "compliance-signoff"),
          eq(approvals.status, "pending"),
        ),
      );
    expect(pending).toHaveLength(1);
    expect(pending[0]!.approverUserId).toBe(avery!.id);
  });

  it("seeds the cascade's PII block exactly once — a deny before any model ran", async () => {
    // the same tag's piiMode 'block' half of the headline: one 'pii-blocked'
    // audit deny from the seeded SSN dispatch, not duplicated by the re-run
    const denies = await scratch
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "pii-blocked"), eq(auditLog.effect, "deny")));
    expect(denies).toHaveLength(1);
  });

  // ADR-0030: the owner must be able to sign in as `admin` straight out of the
  // seeder — and the seed path is what keeps the feature exercised.
  it("gives each persona a username (idempotently) that actually signs in", async () => {
    const rows = await scratch.select().from(users);
    for (const [email, username] of [
      ["admin@regulait.local", "admin"],
      ["dana@regulait.local", "dana"],
      ["avery@regulait.local", "avery"],
    ] as const) {
      const row = rows.find((u) => u.email === email);
      expect(row, email).toBeDefined();
      // re-running the seeder must not duplicate or clear it
      expect(row!.username).toBe(username);
    }
    // and the username is a real credential, not decoration: sign in with the
    // NAME alone and the one-time password the first seed run printed for her.
    // (B4S-06: issuing a fresh one with the bootstrap token is refused now —
    // the seed enrolled her authenticator, so an admin can step up and the
    // bootstrap credential no longer passes one.) The app is built in
    // beforeAll and closed in afterAll — closing it here would be skipped by
    // any assertion above that throws.
    const adminUser = rows.find((u) => u.email === "admin@regulait.local")!;
    const printed = /admin\s+admin@regulait\.local\s+(\S+)/.exec(seedRuns[0]!.stdout)?.[1];
    expect(printed, "the first seed run printed Ada's one-time password").toMatch(/^[^(]/);
    const signIn = await app!.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "x-regulait-csrf": "1" },
      payload: { identifier: "admin", password: printed },
    });
    expect(signIn.statusCode).toBe(200);
    // ADR-0181 (FX2): the seed enrolled the admin's TOTP (her API key answers
    // to the MFA requirement), so the name + password pass the FIRST factor
    // and the sign-in asks for the second
    expect(adminUser.totpEnabled).toBe(true);
    expect(signIn.json()).toMatchObject({ mfaRequired: true });
    expect(typeof signIn.json().pendingToken).toBe("string");
  });
});
