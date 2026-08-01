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
  asc,
  conversationMessages,
  conversations,
  createDb,
  eq,
  sql,
  users,
  workflowInstances,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const SCRATCH_DB = "regulait_seed_test";
const scratchUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
})();
const seedScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/seed.js");

let admin: Db;
let scratch: Db;
const seedRuns: Array<{ status: number | null; stderr: string }> = [];

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  for (let i = 0; i < 2; i++) {
    const r = spawnSync(process.execPath, [seedScript], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: scratchUrl },
      timeout: 180_000,
    });
    seedRuns.push({ status: r.status, stderr: r.stderr ?? "" });
  }
  scratch = createDb(scratchUrl);
}, 400_000);

afterAll(async () => {
  await scratch?.$client.end();
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.$client.end();
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
    // and the username is a real credential, not decoration: issue a fresh
    // one-time password through the API and sign in with the NAME alone
    const app = buildApp(scratch, { bootstrapToken: "seed-test-boot" });
    const admin = rows.find((u) => u.email === "admin@regulait.local")!;
    const issued = await app.inject({
      method: "POST",
      headers: { authorization: "Bearer seed-test-boot" },
      url: `/v1/users/${admin.id}/set-initial-password`,
      payload: { force: true },
    });
    expect(issued.statusCode).toBe(200);
    const signIn = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "x-regulait-csrf": "1" },
      payload: { identifier: "admin", password: issued.json().password },
    });
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json().userId).toBe(admin.id);
    await app.close();
  });
});
