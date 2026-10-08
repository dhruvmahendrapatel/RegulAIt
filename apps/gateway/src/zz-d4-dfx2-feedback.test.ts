/**
 * D4 review fix DFX2 — feedback (D4G-03, D4A-05, D4A-07b), through the real
 * app on a real database.
 *
 * Red proofs (each fails with its rule reverted):
 *  - D4G-03: the retention sweep keeps an item past the window while an
 *    incident that is not closed names it (its `incident_id`, or an
 *    `ai_incident_links` row), reports it as held, and purges it once the
 *    incident closes; lowering `feedback_retention_days` below 365 is audited
 *    as a relaxation, with its transition.
 *  - D4A-05: no log line, at any status, carries a public link token — the
 *    refusal lines (400, 404, 410, 503) and any other line written through
 *    the logger (captured from the same pino configuration boot resolves).
 *  - D4A-07b: a resolution note is stored as a data-key envelope (scrubbed of
 *    credential material first), read back only in the audited item read; a
 *    note left in the clear is never served as it was and is enveloped when
 *    an app becomes ready; with no data key a note is refused (503).
 *
 * Global state (M-040/M-068): the feedback settings this file changes are
 * restored in `finally` blocks and in afterAll; every row it creates is its own.
 */
import { Writable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { aiIncidents, aiUseCases, and, auditLog, createDb, desc, eq, inArray, runMigrations, sql, useCaseFeedback, type Db } from "@regulait/db";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { buildApp } from "./app.js";
import { FEEDBACK_RULE_IDS, envelopeLegacyResolutionNotes, runFeedbackRetentionSweep } from "./feedback.js";
import { requestLogFields, resolveGatewayLogger } from "./gateway-logger.js";
import { decryptSecret } from "./secrets.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `dfx2-fb-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "a".repeat(64);
const DAY = 86_400_000;
const ENVELOPE = /^[0-9a-f]{24}\.[0-9a-f]{32}\.[0-9a-f]*(\.[0-9a-f]+)?$/;
let db: Db;
let app: ReturnType<typeof buildApp>;
type Who = "admin" | "owner" | "member";
const users = {} as Record<Who, { id: string; auth: { authorization: string } }>;
const created = { useCases: [] as string[], incidents: [] as string[] };

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const injectOn = (a: ReturnType<typeof buildApp>) => (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  a.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) => injectOn(app)(method, url, headers, payload);

async function mkUseCase(label: string): Promise<string> {
  const [row] = await db
    .insert(aiUseCases)
    .values({ name: `dfx2 ${label} ${RUN}`, description: "synthetic D4 DFX2 fixture", ownerUserId: users.owner.id, businessContext: "synthetic", dataSensitivity: "internal" })
    .returning({ id: aiUseCases.id });
  created.useCases.push(row!.id);
  return row!.id;
}

async function submit(useCaseId: string, body: string): Promise<string> {
  const r = await inject("POST", `/v1/use-cases/${useCaseId}/feedback`, users.member.auth, { kind: "problem", body });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

async function lastAudit(ruleId: string, objectId?: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(objectId ? and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)) : eq(auditLog.ruleId, ruleId))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return row;
}

async function putSettings(patch: Record<string, unknown>) {
  const r = await inject("PUT", "/v1/org/settings", users.admin.auth, patch);
  expect(r.statusCode, r.body).toBe(200);
}

let restoreMfa: (() => Promise<void>) | undefined;
// ADR-0186 A: this suite drives step-up actions through API keys, which can never step up (restored below, M-068)
let restoreStepUp: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreStepUp = await relaxStepUpForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  for (const [k, isAdmin] of [["admin", true], ["owner", false], ["member", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `dfx2-fb-${k}-${RUN}@example.com`, displayName: `dfx2 ${k} ${RUN}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "dfx2" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  await restoreStepUp?.();
  await db.execute(sql`UPDATE org_settings SET feedback_signed_links_enabled = false, feedback_retention_days = 365`);
  await restoreMfa?.();
  if (created.incidents.length) await db.delete(aiIncidents).where(inArray(aiIncidents.id, created.incidents));
  if (created.useCases.length) await db.delete(aiUseCases).where(inArray(aiUseCases.id, created.useCases));
  await db.execute(sql`delete from rate_limit_counters where bucket like 'fbl:%'`);
  app.server.closeAllConnections();
  await app.close();
});

// ---------------------------------------------------------------------------

describe("D4G-03: retention never purges evidence of an incident that is not closed", () => {
  it("held via incident_id and via ai_incident_links; reported as held; purged once the incidents close", async () => {
    const uc = await mkUseCase("hold");
    const byId = await submit(uc, "HELD-BY-INCIDENT-ID");
    const byLink = await submit(uc, "HELD-BY-LINK");
    const free = await submit(uc, "NOT-HELD");
    // incident 1: opened from the item (sets use_case_feedback.incident_id)
    const opened = await inject("POST", `/v1/feedback/${byId}/open-incident`, users.owner.auth, { title: `dfx2 from feedback ${RUN}`, severity: "low" });
    expect(opened.statusCode, opened.body).toBe(201);
    const [{ incidentId: inc1 }] = (await db.select({ incidentId: useCaseFeedback.incidentId }).from(useCaseFeedback).where(eq(useCaseFeedback.id, byId))) as [{ incidentId: string }];
    created.incidents.push(inc1);
    // incident 2: names the other item through ai_incident_links only
    const r2 = await inject("POST", "/v1/incidents", users.admin.auth, {
      title: `dfx2 linked ${RUN}`,
      severity: "low",
      detectionSource: "manual",
      links: [{ objectType: "feedback", objectId: byLink }],
    });
    expect(r2.statusCode, r2.body).toBe(201);
    const inc2 = r2.json().incident.id as string;
    created.incidents.push(inc2);
    const old = new Date(Date.now() - 400 * DAY);
    await db
      .update(useCaseFeedback)
      .set({ createdAt: old, ackDueAt: new Date(old.getTime() + DAY), resolveDueAt: new Date(old.getTime() + 2 * DAY) })
      .where(inArray(useCaseFeedback.id, [byId, byLink, free]));

    const first = await runFeedbackRetentionSweep(db, new Date());
    expect(first.heldIds).toEqual(expect.arrayContaining([byId, byLink]));
    expect(first.held).toBeGreaterThanOrEqual(2);
    const rows = async () =>
      new Map((await db.select().from(useCaseFeedback).where(inArray(useCaseFeedback.id, [byId, byLink, free]))).map((r) => [r.id, r]));
    let now = await rows();
    expect(now.get(byId)!.bodyCiphertext).not.toBeNull();
    expect(now.get(byId)!.bodyPurgedAt).toBeNull();
    expect(now.get(byLink)!.bodyCiphertext).not.toBeNull();
    expect(now.get(free)!.bodyCiphertext).toBeNull();
    expect(await lastAudit(FEEDBACK_RULE_IDS.purged, byId)).toBeUndefined();

    for (const id of [inc1, inc2]) {
      const c = await inject("POST", `/v1/incidents/${id}/close`, users.admin.auth, { rootCause: "synthetic root cause", lessonsLearned: "synthetic lessons" });
      expect(c.statusCode, c.body).toBe(200);
    }
    const second = await runFeedbackRetentionSweep(db, new Date());
    expect(second.heldIds).not.toContain(byId);
    now = await rows();
    expect(now.get(byId)!.bodyCiphertext).toBeNull();
    expect(now.get(byLink)!.bodyCiphertext).toBeNull();
    expect(now.get(byId)!.bodyPurgedAt).not.toBeNull();
  });

  it("lowering feedback_retention_days below 365 is audited as a relaxation, with its transition", async () => {
    try {
      await putSettings({ feedbackRetentionDays: 30 });
      const row = await lastAudit("org-settings-updated");
      expect(row!.userId).toBe(users.admin.id);
      expect(row!.detail).toMatchObject({ relaxed: ["feedbackRetentionDays"], transitions: { feedbackRetentionDays: { from: 365, to: 30 } } });
      expect(row!.reason).toContain("RELAXED from the strict default: feedbackRetentionDays");
    } finally {
      await putSettings({ feedbackRetentionDays: 365 });
    }
    const back = await lastAudit("org-settings-updated");
    expect((back!.detail as { relaxed?: unknown }).relaxed).toBeUndefined();
  });
});

describe("D4A-05: a public link token never reaches a log line, at any status", () => {
  it("requestLogFields redacts the token segment", () => {
    const token = `rglf_${"0123456789abcdef".repeat(4)}`;
    const req = { method: "POST", url: `/v1/feedback/l/${token}?x=1`, routeOptions: { url: "/v1/feedback/l/:token" }, ip: "203.0.113.9", headers: {} } as unknown as FastifyRequest;
    const fields = requestLogFields(req, 400);
    expect(JSON.stringify(fields)).not.toContain("rglf_0");
    expect(fields.path).toBe("/v1/feedback/l/[redacted]");
  });

  it("400, 404, 410 and 503 refusals, and any other line, are captured without the token", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        for (const raw of String(chunk).split("\n")) if (raw.trim()) lines.push(raw);
        cb();
      },
    });
    const logger = { ...(resolveGatewayLogger({ LOG_LEVEL: "info" } as NodeJS.ProcessEnv) as object), stream: sink } as never;
    const logged = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, logger });
    const noKey = buildApp(db, { bootstrapToken: BOOT, logger });
    const uc = await mkUseCase("links");
    const tokens: string[] = [];
    try {
      await putSettings({ feedbackSignedLinksEnabled: true });
      const mint = async () => {
        const m = await inject("POST", `/v1/use-cases/${uc}/feedback-links`, users.owner.auth, { expiresInDays: 7, maxUses: 5 });
        expect(m.statusCode, m.body).toBe(201);
        tokens.push(m.json().token as string);
        return m.json() as { token: string; link?: { id: string }; id?: string };
      };
      const a = await mint();
      const b = await mint();
      const pub = injectOn(logged);
      expect((await pub("POST", `/v1/feedback/l/${a.token}`, {}, { kind: "problem", body: "x".repeat(4001) })).statusCode).toBe(400);
      expect((await pub("POST", `/v1/feedback/l/${a.token}`, {}, { kind: "nonsense", body: "x" })).statusCode).toBe(400);
      expect((await injectOn(noKey)("POST", `/v1/feedback/l/${b.token}`, {}, { kind: "problem", body: "no key here" })).statusCode).toBe(503);
      const near = `${a.token.slice(0, -1)}`; // a near-miss of a real token is still credential material
      tokens.push(near);
      expect((await pub("GET", `/v1/feedback/l/${near}`, {})).statusCode).toBe(404);
      const list = (await inject("GET", `/v1/use-cases/${uc}/feedback-links`, users.owner.auth)).json();
      const linkIds = ((list.links ?? list.items ?? []) as Array<{ id: string }>).map((l) => l.id);
      for (const id of linkIds) expect((await inject("DELETE", `/v1/use-cases/${uc}/feedback-links/${id}`, users.owner.auth)).statusCode).toBeLessThan(300);
      expect((await pub("GET", `/v1/feedback/l/${a.token}`, {})).statusCode).toBe(410);
      await putSettings({ feedbackSignedLinksEnabled: false });
      expect((await pub("GET", `/v1/feedback/l/${a.token}`, {})).statusCode).toBe(404);
      // any other line through the same logger (the error handler logs `url`)
      logged.log.error({ url: `/v1/feedback/l/${a.token}?retry=1` }, `unhandled error at /v1/feedback/l/${a.token}`);
    } finally {
      await putSettings({ feedbackSignedLinksEnabled: false });
      await logged.close();
      await noKey.close();
    }
    const statuses = lines.map((l) => (JSON.parse(l) as { status?: number }).status).filter(Boolean);
    expect(statuses).toEqual(expect.arrayContaining([400, 503, 404, 410]));
    const all = lines.join("\n");
    for (const t of tokens) {
      expect(all).not.toContain(t);
      expect(all).not.toContain(t.slice(5, 40));
    }
    expect(all).toContain("/v1/feedback/l/[redacted]");
  });
});

describe("D4A-07b: resolution notes are encrypted at rest like bodies", () => {
  it("stored as a scrubbed envelope, read back in the audited item read; refused without a data key", async () => {
    const uc = await mkUseCase("note");
    const id = await submit(uc, "My account number appears in the answer.");
    const synthetic = `AKIA${"SYNTHETICFAKE123".slice(0, 16)}`;
    const note = `Resolved with the customer; their reference NOTE-${RUN}. Pasted by mistake: ${synthetic}`;
    const noKey = buildApp(db, { bootstrapToken: BOOT });
    try {
      const refused = await injectOn(noKey)("PATCH", `/v1/feedback/${id}`, users.owner.auth, { status: "no_change", resolutionNote: note });
      expect(refused.statusCode, refused.body).toBe(503);
      expect(refused.json().error).toBe("data_key_required");
    } finally {
      await noKey.close();
    }
    const ok = await inject("PATCH", `/v1/feedback/${id}`, users.owner.auth, { status: "no_change", resolutionNote: note });
    expect(ok.statusCode, ok.body).toBe(200);
    const [raw] = await db.select({ n: useCaseFeedback.resolutionNote }).from(useCaseFeedback).where(eq(useCaseFeedback.id, id));
    expect(raw!.n).toMatch(ENVELOPE);
    expect(raw!.n).not.toContain(`NOTE-${RUN}`);
    const opened = decryptSecret(DATA_KEY, raw!.n!);
    expect(opened).toContain(`NOTE-${RUN}`);
    expect(opened).not.toContain(synthetic);
    const view = await inject("GET", `/v1/feedback/${id}`, users.admin.auth);
    expect(view.json()).toMatchObject({ resolutionNote: opened, resolutionNoteUnavailable: null });
    expect((await lastAudit(FEEDBACK_RULE_IDS.bodyRead, id))!.detail).toMatchObject({ resolutionNoteRead: true });
    // the list never carries it
    const list = await inject("GET", `/v1/feedback?useCaseId=${uc}`, users.owner.auth);
    expect(list.body).not.toContain(`NOTE-${RUN}`);
    expect(list.body).not.toContain(raw!.n!);
  });

  it("a note left in the clear is never served as it was, and is enveloped when an app becomes ready", async () => {
    const uc = await mkUseCase("legacy");
    const id = await submit(uc, "legacy body");
    expect((await inject("PATCH", `/v1/feedback/${id}`, users.owner.auth, { status: "no_change", resolutionNote: "will be replaced" })).statusCode).toBe(200);
    // an earlier build's plaintext (raw SQL: no route writes this any more)
    await db.execute(sql`UPDATE use_case_feedback SET resolution_note = ${`LEGACY-PLAIN-${RUN}`} WHERE id = ${id}`);
    const served = (await inject("GET", `/v1/feedback/${id}`, users.owner.auth)).json();
    expect(served.resolutionNote).toBeNull();
    expect(served.resolutionNoteUnavailable).toBe("undecryptable");
    expect(JSON.stringify(served)).not.toContain(`LEGACY-PLAIN-${RUN}`);
    // a newly started app envelopes it before serving anything
    const fresh = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
    try {
      await fresh.ready();
      const [raw] = await db.select({ n: useCaseFeedback.resolutionNote }).from(useCaseFeedback).where(eq(useCaseFeedback.id, id));
      expect(raw!.n).toMatch(ENVELOPE);
      const read = (await injectOn(fresh)("GET", `/v1/feedback/${id}`, users.owner.auth)).json();
      expect(read.resolutionNote).toBe(`LEGACY-PLAIN-${RUN}`);
      const audit = await lastAudit(FEEDBACK_RULE_IDS.notesEnveloped);
      expect((audit!.detail as { feedbackIds: string[] }).feedbackIds).toContain(id);
    } finally {
      await fresh.close();
    }
    // idempotent: nothing left to envelope
    expect(await envelopeLegacyResolutionNotes(db, DATA_KEY)).toBe(0);
  });
});
