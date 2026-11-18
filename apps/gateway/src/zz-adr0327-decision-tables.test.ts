import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, approvals, auditLog, createDb, decisionTables, decisionTableVersions, desc, eq, runMigrations, type Db } from "@regulait/db";
import { applyInducedRule, compileDecisionTable, type DecisionTableBody } from "@regulait/optimizer-kernel";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { DECISION_TABLE_VERSION_STATUSES } from "@regulait/db";
import { DECISION_TABLE_VERSION_MACHINE, STATE_MACHINES } from "@regulait/shared";
import { DECISION_TABLE_AUDIT_RULE_IDS, DECISION_TABLE_VERSION_INITIAL, decisionTableBodyDigest } from "./decision-tables.js";

/**
 * ADR-0327 addendum — business-authored decision tables. A table is validated by a schema, compiles to the exact-match
 * rule engine, and a version is published only when its named reviewer approves it through the one approvals decide
 * path. The author never decides their own version; a version approved after another was published is recorded
 * stale; a denial changes nothing. Admin-only (default gate). Every step is audited. Prefix dt-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `dt-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
type Person = { id: string; auth: { authorization: string } };
let author: Person;
let reviewer: Person;
let member: Person;
let agentId: string;
let tableId: string;
const restores: Array<() => Promise<void>> = [];

const triage = (onCall: string): DecisionTableBody => ({
  fields: ["severity", "source"],
  rows: [
    { when: { severity: "high", source: ["phone", "pager"] }, then: onCall },
    { when: { severity: "low", source: "email" }, then: "backlog" },
  ],
});

async function makeUser(name: string, isAdmin: boolean): Promise<Person> {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `${name}-${RUN}@example.com`, displayName: name, isAdmin } });
  expect(u.statusCode, u.body).toBe(201);
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "dt" } });
  expect(k.statusCode).toBe(201);
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

const propose = (who: Person, table: unknown, reviewerUserId = reviewer.id) =>
  app.inject({ method: "POST", headers: who.auth, url: `/v1/decision-tables/${tableId}/versions`, payload: { table, reviewerUserId, reason: "route high-severity phone tickets to on-call" } });

const decide = (who: Person, approvalId: string, decision: "approved" | "denied") =>
  relaxStepUpAround(db, () =>
    app.inject({ method: "POST", headers: who.auth, url: `/v1/approvals/${approvalId}/decide`, payload: { decision, reason: "reviewed the rows" } }),
  );

const detail = async () => {
  const r = await app.inject({ method: "GET", headers: author.auth, url: `/v1/decision-tables/${tableId}` });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};

const lastAudit = async (ruleId: string) =>
  (await db.select().from(auditLog).where(and(eq(auditLog.objectId, tableId), eq(auditLog.ruleId, ruleId))).orderBy(desc(auditLog.at)).limit(1))[0];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  author = await makeUser("dt-author", true);
  reviewer = await makeUser("dt-reviewer", true);
  member = await makeUser("dt-member", false);
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `dt-agent-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 1, model: "mock-balanced" },
  });
  expect(a.statusCode, a.body).toBe(201);
  agentId = a.json().id;
});

afterAll(async () => {
  if (agentId) await db.delete(decisionTables).where(eq(decisionTables.agentId, agentId));
  for (const r of restores.reverse()) await r();
  await app.close();
});

describe("decision tables (ADR-0327 addendum)", () => {
  it("the version lifecycle is the declared ADR-0348 machine: created in review, published or rejected or stale by the reviewer, superseded by the next", () => {
    const m = DECISION_TABLE_VERSION_MACHINE;
    expect([...m.def.states].sort()).toEqual([...DECISION_TABLE_VERSION_STATUSES].sort());
    expect(STATE_MACHINES[m.def.id]).toBe(m);
    expect(DECISION_TABLE_VERSION_INITIAL).toBe("pending_review");
    expect([...m.def.initial]).toEqual([DECISION_TABLE_VERSION_INITIAL]);
    expect(Object.fromEntries(Object.entries(m.def.transitions).map(([e, t]) => [e, { from: [...t.from], to: t.to }]))).toEqual({
      publish: { from: ["pending_review"], to: "published" },
      reject: { from: ["pending_review"], to: "rejected" },
      mark_stale: { from: ["pending_review"], to: "stale" },
      supersede: { from: ["published"], to: "superseded" },
    });
    expect([...m.def.terminal].sort()).toEqual(["rejected", "stale", "superseded"]);
  });

  it("is admin-only", async () => {
    const r = await app.inject({ method: "GET", headers: member.auth, url: "/v1/decision-tables" });
    expect(r.statusCode).toBe(403);
  });

  it("creates one table per AI step, with a unique name, audited", async () => {
    const r = await app.inject({ method: "POST", headers: author.auth, url: "/v1/decision-tables", payload: { name: `dt-triage-${RUN}`, agentId, stepName: "triage" } });
    expect(r.statusCode, r.body).toBe(201);
    tableId = r.json().id;
    expect(await lastAudit(DECISION_TABLE_AUDIT_RULE_IDS.created)).toBeTruthy();
    const sameStep = await app.inject({ method: "POST", headers: author.auth, url: "/v1/decision-tables", payload: { name: `dt-other-${RUN}`, agentId, stepName: "triage" } });
    expect(sameStep.statusCode).toBe(409);
    expect(sameStep.json().error).toBe("decision_table_exists_for_step");
    const sameName = await app.inject({ method: "POST", headers: author.auth, url: "/v1/decision-tables", payload: { name: `DT-TRIAGE-${RUN}`, agentId, stepName: "other" } });
    expect(sameName.json().error).toBe("decision_table_name_taken");
    const unknownAgent = await app.inject({ method: "POST", headers: author.auth, url: "/v1/decision-tables", payload: { name: `dt-x-${RUN}`, agentId: "00000000-0000-4000-8000-000000000000", stepName: "x" } });
    expect(unknownAgent.statusCode).toBe(404);
    const listed = await app.inject({ method: "GET", headers: author.auth, url: `/v1/decision-tables?agentId=${agentId}` });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items.map((t: { id: string }) => t.id)).toEqual([tableId]);
  });

  it("refuses a table that fails the schema or does not compile, naming every problem", async () => {
    const shape = await propose(author, { fields: ["severity"], rows: [{ when: { severity: { gt: 3 } }, then: "x" }] });
    expect(shape.statusCode).toBe(400);
    const overlap = await propose(author, {
      fields: ["severity"],
      rows: [
        { when: { severity: ["high", "low"] }, then: "a" },
        { when: { severity: "low" }, then: "b" },
      ],
    });
    expect(overlap.statusCode).toBe(422);
    expect(overlap.json().problems.map((p: { code: string }) => p.code)).toEqual(["conflicting_rows"]);
    const self = await propose(author, triage("on-call"), author.id);
    expect(self.json().error).toBe("reviewer_is_author");
    const notAdmin = await propose(author, triage("on-call"), member.id);
    expect(notAdmin.json().error).toBe("reviewer_not_eligible");
  });

  it("publishes a version only when its named reviewer approves it; the author cannot", async () => {
    const p = await propose(author, triage("on-call"));
    expect(p.statusCode, p.body).toBe(202);
    expect(p.json()).toMatchObject({ pending: true, version: 1, rows: 2, cells: 3 });
    const approvalId = p.json().approvalId as string;
    expect((await detail()).published).toBeNull();
    const again = await propose(author, triage("pager"));
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("decision_table_version_pending");

    const own = await decide(author, approvalId, "approved");
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toBe("cannot_approve_own_decision_table");
    expect((await detail()).published).toBeNull();

    const ok = await decide(reviewer, approvalId, "approved");
    expect(ok.statusCode, ok.body).toBe(200);
    const d = await detail();
    expect(d.published).toMatchObject({ version: 1, status: "published", decidedBy: reviewer.id, cells: 3 });
    expect(d.pending).toBeNull();
    // the view carries the machine's description, so the UI and agents read the allowed next events from one place
    expect(d.published.lifecycle).toMatchObject({ machine: "decision_table_version", state: "published", terminal: false });
    expect(Object.fromEntries(d.published.lifecycle.transitions.map((e: { event: string; allowed: boolean }) => [e.event, e.allowed]))).toEqual({
      publish: false,
      reject: false,
      mark_stale: false,
      supersede: true,
    });
    expect(d.published.lines.at(-1)).toBe("otherwise -> ask the AI (input not covered by this table)");
    // the published table runs on the existing exact-match engine, unchanged
    const compiled = compileDecisionTable(d.published.table);
    expect(compiled.ok && applyInducedRule(compiled.rule, { severity: "high", source: "pager" })).toEqual({ matched: true, output: "on-call" });
    expect(compiled.ok && applyInducedRule(compiled.rule, { severity: "medium", source: "pager" })).toEqual({ matched: false });
    expect(await lastAudit(DECISION_TABLE_AUDIT_RULE_IDS.published)).toBeTruthy();
  });

  it("refuses a version that changes nothing (same cells in another row order)", async () => {
    const t = triage("on-call");
    const r = await propose(author, { fields: [...t.fields].reverse(), rows: [...t.rows].reverse() });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("no_change");
  });

  it("a denial changes nothing; the next approval supersedes the published version", async () => {
    const denied = await propose(author, triage("escalate"));
    expect(denied.statusCode, denied.body).toBe(202);
    expect((await decide(reviewer, denied.json().approvalId, "denied")).statusCode).toBe(200);
    let d = await detail();
    expect(d.published.version).toBe(1);
    expect(d.history.find((v: { version: number }) => v.version === 2).status).toBe("rejected");
    expect(await lastAudit(DECISION_TABLE_AUDIT_RULE_IDS.rejected)).toBeTruthy();

    const next = await propose(author, triage("pager-duty"));
    expect(next.json().version).toBe(3);
    expect((await decide(reviewer, next.json().approvalId, "approved")).statusCode).toBe(200);
    d = await detail();
    expect(d.published).toMatchObject({ version: 3, baseVersion: 1 });
    expect(d.history.find((v: { version: number }) => v.version === 1).status).toBe("superseded");
  });

  it("records an approval stale when another version was published after it was proposed", async () => {
    const p = await propose(author, triage("stale-candidate"));
    expect(p.statusCode, p.body).toBe(202);
    // simulate the published version moving under the pending one (the only writer is the decide path, so the move
    // is made directly here): the pending version was proposed against version 3, version 3 is no longer published
    await db
      .update(decisionTableVersions)
      .set({ status: "superseded" })
      .where(and(eq(decisionTableVersions.tableId, tableId), eq(decisionTableVersions.status, "published")));
    expect((await decide(reviewer, p.json().approvalId, "approved")).statusCode).toBe(200);
    const d = await detail();
    expect(d.published).toBeNull();
    expect(d.history.find((v: { version: number }) => v.version === 4).status).toBe("stale");
    expect(await lastAudit(DECISION_TABLE_AUDIT_RULE_IDS.stale)).toBeTruthy();
  });

  // security review #1020 B1: a version is frozen once proposed, and its approval is bound to its body
  const versionRow = async (version: number) =>
    (await db.select().from(decisionTableVersions).where(and(eq(decisionTableVersions.tableId, tableId), eq(decisionTableVersions.version, version))))[0]!;
  const refused = async (change: Parameters<ReturnType<typeof db.update<typeof decisionTableVersions>>["set"]>[0], id: string) => {
    const err = await db.update(decisionTableVersions).set(change).where(eq(decisionTableVersions.id, id)).then(() => null, (e: unknown) => e);
    expect(err, JSON.stringify(change)).toBeTruthy();
    expect(String((err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code)).toBe("23514");
  };

  it("freezes what was proposed: body, digest, table, version, base and author cannot change after insert", async () => {
    const p = await propose(author, triage("frozen"));
    expect(p.statusCode, p.body).toBe(202);
    const v = await versionRow(p.json().version);
    await refused({ body: { fields: ["severity"], rows: [{ when: { severity: "high" }, then: "someone else" }] } }, v.id);
    await refused({ bodySha256: "0".repeat(64) }, v.id);
    await refused({ version: v.version + 100 }, v.id);
    await refused({ baseVersion: 99 }, v.id);
    await refused({ authorUserId: reviewer.id }, v.id);
    expect((await versionRow(v.version)).body).toEqual(v.body);
    // the decision columns still move, and the author may become NULL (the users FK's ON DELETE SET NULL)
    await db.update(decisionTableVersions).set({ authorUserId: null }).where(eq(decisionTableVersions.id, v.id));
    expect((await decide(reviewer, p.json().approvalId, "denied")).statusCode).toBe(200);
    expect((await versionRow(v.version)).status).toBe("rejected");
  });

  it("binds the approval to the body it shows, and refuses to publish when they no longer match", async () => {
    const table = triage("bound");
    const p = await propose(author, table);
    expect(p.statusCode, p.body).toBe(202);
    const v = await versionRow(p.json().version);
    const [a] = await db.select().from(approvals).where(eq(approvals.id, p.json().approvalId));
    expect(v.bodySha256).toBe(decisionTableBodyDigest(table));
    expect(a!.argumentsDigest).toBe(v.bodySha256);
    // a consent recorded for some other body: approving it must not publish this one
    await db.update(approvals).set({ argumentsDigest: decisionTableBodyDigest(triage("something else")) }).where(eq(approvals.id, a!.id));
    expect((await decide(reviewer, a!.id, "approved")).statusCode).toBe(200);
    const d = await detail();
    expect(d.published).toBeNull();
    expect((await versionRow(v.version)).status).toBe("stale");
    expect((await lastAudit(DECISION_TABLE_AUDIT_RULE_IDS.digestMismatch))?.detail).toMatchObject({ proposedSha256: v.bodySha256 });
  });
});
