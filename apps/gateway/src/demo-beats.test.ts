/**
 * ADR-0202 decision 4 — the per-beat simulated fallback: live by default, admin-only, every change audited, and an
 * unknown beat id refused rather than guessed.
 *
 * Shares one database with the other gateway suites (fileParallelism is off). The fallback table is deployment-wide
 * state, so it is emptied before and after this file: every beat starts and ends live, which is the shipped default.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, demoBeatFallbacks, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { DEMO_BEAT_IDS, DEMO_BEAT_RULE_ID, isBeatSimulated, UnknownDemoBeatError } from "./demo-beats.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "demo-beats-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userAuth: { authorization: string };

const beatAudits = async (beatId: string) =>
  (await db.select().from(auditLog).where(and(eq(auditLog.ruleId, DEMO_BEAT_RULE_ID), eq(auditLog.objectType, "demo_beat")))).filter(
    (r) => (r.detail as { beatId?: string }).beatId === beatId,
  );

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  await db.delete(demoBeatFallbacks);
  app = buildApp(db, { bootstrapToken: BOOT });
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: `beats-${randomUUID()}@example.com`, displayName: "Beat Member" },
  });
  const key = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "cli" } });
  userAuth = { authorization: `Bearer ${key.json().token}` };
});

afterAll(async () => {
  await db.delete(demoBeatFallbacks);
  await app.close();
  await (db.$client as { end: () => Promise<void> }).end();
});

describe("demo beat fallback switch (ADR-0202 decision 4)", () => {
  it("defines the beats lane F and the demo script need", () => {
    for (const id of ["shadow-ai-discovery", "enforce-it", "pm-sync", "git-pr", "chatops-approval"]) {
      expect(DEMO_BEAT_IDS).toContain(id);
    }
  });

  it("every beat is live by default", async () => {
    for (const id of DEMO_BEAT_IDS) expect(await isBeatSimulated(db, id)).toBe(false);
    const res = await app.inject({ method: "GET", url: "/v1/demo/beats", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const beats = res.json().beats as Array<{ beatId: string; mode: string }>;
    expect(beats.map((b) => b.beatId)).toEqual([...DEMO_BEAT_IDS]);
    expect(beats.every((b) => b.mode === "live")).toBe(true);
  });

  it("an unknown beat id throws server side and is a 404 at the route", async () => {
    await expect(isBeatSimulated(db, "enforce_it")).rejects.toBeInstanceOf(UnknownDemoBeatError);
    const res = await app.inject({
      method: "PUT",
      url: "/v1/demo/beats/enforce_it",
      headers: AUTH,
      payload: { simulated: true, reason: "typo" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("a non-admin can neither read nor flip a beat", async () => {
    const before = (await beatAudits("enforce-it")).length;
    const get = await app.inject({ method: "GET", url: "/v1/demo/beats", headers: userAuth });
    expect(get.statusCode).toBe(403);
    const put = await app.inject({
      method: "PUT",
      url: "/v1/demo/beats/enforce-it",
      headers: userAuth,
      payload: { simulated: true, reason: "not mine to flip" },
    });
    expect(put.statusCode).toBe(403);
    expect(await isBeatSimulated(db, "enforce-it")).toBe(false);
    expect((await beatAudits("enforce-it")).length).toBe(before);
  });

  it("a write needs a reason", async () => {
    const res = await app.inject({ method: "PUT", url: "/v1/demo/beats/enforce-it", headers: AUTH, payload: { simulated: true } });
    expect(res.statusCode).toBe(400);
    expect(await isBeatSimulated(db, "enforce-it")).toBe(false);
  });

  it("an admin flips one beat to simulated and back, and each change is audited old -> new", async () => {
    const before = (await beatAudits("enforce-it")).length;
    const on = await app.inject({
      method: "PUT",
      url: "/v1/demo/beats/enforce-it",
      headers: AUTH,
      payload: { simulated: true, reason: "Slack outage at rehearsal" },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().beat).toMatchObject({ beatId: "enforce-it", mode: "simulated", reason: "Slack outage at rehearsal" });
    expect(await isBeatSimulated(db, "enforce-it")).toBe(true);
    // only that beat moved
    expect(await isBeatSimulated(db, "git-pr")).toBe(false);

    const off = await app.inject({
      method: "PUT",
      url: "/v1/demo/beats/enforce-it",
      headers: AUTH,
      payload: { simulated: false, reason: "Slack is back" },
    });
    expect(off.statusCode).toBe(200);
    expect(await isBeatSimulated(db, "enforce-it")).toBe(false);

    // the audit chain's seq orders rows written in the same millisecond; the query itself returns no order
    const rows = (await beatAudits("enforce-it")).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).slice(before);
    expect(rows.map((r) => (r.detail as { transition: unknown }).transition)).toEqual([
      { from: "live", to: "simulated" },
      { from: "simulated", to: "live" },
    ]);
    expect(rows[0]!.reason).toContain("Slack outage at rehearsal");
    expect((rows[0]!.detail as { via?: string }).via).toBe("bootstrap");
  });
});
