/**
 * ADR-0182 (ADR-0175 batch D4) S5 — the four accountability evidence
 * collectors: `incident_register`, `user_feedback_channel`,
 * `literacy_acknowledgements`, `decision_regression_runs`.
 *
 * Each counts ONLY rows created in the period [start, end) — a row a second
 * before the start or exactly at the end is not evidence — and each is scoped
 * like the ledgers beside it: incidents and feedback through their use case's
 * project, acknowledgements through the caller's project members, and
 * regression runs (organisation-wide, no project) only under an org scope.
 *
 * The period is a synthetic one in 2001, so rows other suites write today
 * cannot be counted; every row is removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiIncidents,
  aiPolicyAcknowledgements,
  aiPolicyDocuments,
  aiUseCases,
  createDb,
  decisionRegressionRuns,
  inArray,
  projects,
  runMigrations,
  sql,
  useCaseFeedback,
  users,
  type Db,
} from "@regulait/db";
import { runCollector, type CollectorContext } from "./compliance-packs.js";
import { encryptSecret } from "./secrets.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const START = new Date("2001-01-01T00:00:00Z");
const END = new Date("2001-02-01T00:00:00Z");
const IN = [new Date("2001-01-01T00:00:00Z"), new Date("2001-01-15T12:00:00Z"), new Date("2001-01-31T23:59:59Z")];
const OUT = [new Date("2000-12-31T23:59:59Z"), END];
const DIGEST = "a".repeat(64);

let db: Db;
const made = { users: [] as string[], projects: [] as string[], useCases: [] as string[], incidents: [] as string[], feedback: [] as string[], docs: [] as string[], runs: [] as string[] };
const fx = {} as { projA: string; projB: string; ucA: string; ucB: string; userA: string; userB: string };

const ctx = (over: Partial<CollectorContext> = {}): CollectorContext => ({
  periodStart: START,
  periodEnd: END,
  projectIds: null,
  memberIds: null,
  params: {},
  ...over,
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  for (const k of ["a", "b"] as const) {
    const [u] = await db.insert(users).values({ email: `s5c-${k}-${RUN}@example.com`, displayName: `s5c ${k}` }).returning({ id: users.id });
    made.users.push(u!.id);
    const [p] = await db.insert(projects).values({ name: `s5c-${k}-${RUN}` }).returning({ id: projects.id });
    made.projects.push(p!.id);
    const [uc] = await db
      .insert(aiUseCases)
      .values({ name: `s5c ${k} ${RUN}`, description: "synthetic", ownerUserId: u!.id, businessContext: "synthetic", dataSensitivity: "internal", projectId: p!.id })
      .returning({ id: aiUseCases.id });
    made.useCases.push(uc!.id);
    if (k === "a") Object.assign(fx, { userA: u!.id, projA: p!.id, ucA: uc!.id });
    else Object.assign(fx, { userB: u!.id, projB: p!.id, ucB: uc!.id });
  }
  // incidents: three in the period on use case A, one in the period on B,
  // one in the period with no use case, two just outside the period on A
  const incident = async (createdAt: Date, useCaseId: string | null) => {
    const [r] = await db
      .insert(aiIncidents)
      .values({ title: `s5c incident ${RUN}`, severity: "low", detectionSource: "manual", awareAt: createdAt, useCaseId, createdAt, updatedAt: createdAt })
      .returning({ id: aiIncidents.id });
    made.incidents.push(r!.id);
  };
  for (const t of IN) await incident(t, fx.ucA);
  await incident(IN[1]!, fx.ucB);
  await incident(IN[1]!, null);
  for (const t of OUT) await incident(t, fx.ucA);
  // feedback: the same shape (feedback always has a use case)
  const feedback = async (createdAt: Date, useCaseId: string) => {
    const [r] = await db
      .insert(useCaseFeedback)
      .values({
        useCaseId,
        kind: "problem",
        channel: "in_app",
        bodyCiphertext: encryptSecret("a".repeat(64), "synthetic feedback body"),
        createdAt,
        ackDueAt: new Date(createdAt.getTime() + 72 * 3_600_000),
        resolveDueAt: new Date(createdAt.getTime() + 30 * 86_400_000),
      })
      .returning({ id: useCaseFeedback.id });
    made.feedback.push(r!.id);
  };
  for (const t of IN) await feedback(t, fx.ucA);
  await feedback(IN[1]!, fx.ucB);
  for (const t of OUT) await feedback(t, fx.ucA);
  // acknowledgements: one row per (user, document), so one DRAFT document per
  // timestamp (a draft applies to nobody, so no literacy gate is touched)
  const ack = async (i: number, userId: string, acknowledgedAt: Date) => {
    const [d] = await db
      .insert(aiPolicyDocuments)
      .values({ key: `s5c-${RUN}-${i}`, kind: "acceptable_use", version: 1, title: "synthetic", url: "https://example.com/policy", contentDigest: DIGEST })
      .returning({ id: aiPolicyDocuments.id });
    made.docs.push(d!.id);
    await db.insert(aiPolicyAcknowledgements).values({
      userId,
      documentId: d!.id,
      version: 1,
      digest: DIGEST,
      method: "acknowledged",
      acknowledgedAt,
      expiresAt: new Date(acknowledgedAt.getTime() + 365 * 86_400_000),
    });
  };
  let i = 0;
  for (const t of IN) await ack(i++, fx.userA, t);
  await ack(i++, fx.userB, IN[1]!);
  for (const t of OUT) await ack(i++, fx.userA, t);
  // regression runs: three in, two out
  for (const t of [...IN, ...OUT]) {
    const [r] = await db
      .insert(decisionRegressionRuns)
      .values({ trigger: "preview", subject: "review_policy", candidateDigest: `s5c-${RUN}`, cases: 4, changed: 0, createdAt: t })
      .returning({ id: decisionRegressionRuns.id });
    made.runs.push(r!.id);
  }
}, 120_000);

afterAll(async () => {
  try {
    if (made.runs.length) await db.delete(decisionRegressionRuns).where(inArray(decisionRegressionRuns.id, made.runs));
    if (made.docs.length) await db.delete(aiPolicyDocuments).where(inArray(aiPolicyDocuments.id, made.docs)); // cascades the acks
    if (made.feedback.length) await db.delete(useCaseFeedback).where(inArray(useCaseFeedback.id, made.feedback));
    if (made.incidents.length) {
      // migration 0168: an incident that is not closed is never deleted — close the fixtures first (test-only)
      for (const id of made.incidents) {
        await db.execute(sql`UPDATE ai_incidents SET status = 'closed', closed_at = now(),
          root_cause = COALESCE(root_cause, 'fixture cleanup'), lessons_learned = COALESCE(lessons_learned, 'fixture cleanup')
          WHERE id = ${id} AND status <> 'closed'`);
      }
      await db.delete(aiIncidents).where(inArray(aiIncidents.id, made.incidents));
    }
    if (made.useCases.length) await db.delete(aiUseCases).where(inArray(aiUseCases.id, made.useCases));
    if (made.projects.length) await db.delete(projects).where(inArray(projects.id, made.projects));
    if (made.users.length) await db.delete(users).where(inArray(users.id, made.users));
  } finally {
    await db?.$client.end();
  }
});

describe("ADR-0182 S5 collectors count only rows in the period", () => {
  it("incident_register: in-period incidents only; scoped through the use case's project; un-attributed only org-wide", async () => {
    expect(await runCollector(db, "incident_register", ctx())).toBe(5); // 3 on A, 1 on B, 1 with no use case
    expect(await runCollector(db, "incident_register", ctx({ projectIds: [fx.projA], memberIds: [] }))).toBe(3);
    expect(await runCollector(db, "incident_register", ctx({ projectIds: [fx.projB], memberIds: [] }))).toBe(1);
    expect(await runCollector(db, "incident_register", ctx({ projectIds: [], memberIds: [] }))).toBe(0); // fail closed
  });

  it("user_feedback_channel: in-period reports and appeals only; scoped through the use case's project", async () => {
    expect(await runCollector(db, "user_feedback_channel", ctx())).toBe(4);
    expect(await runCollector(db, "user_feedback_channel", ctx({ projectIds: [fx.projA], memberIds: [] }))).toBe(3);
    expect(await runCollector(db, "user_feedback_channel", ctx({ projectIds: [], memberIds: [] }))).toBe(0);
  });

  it("literacy_acknowledgements: in-period acknowledgements only; scoped to the caller's project members", async () => {
    expect(await runCollector(db, "literacy_acknowledgements", ctx())).toBe(4);
    expect(await runCollector(db, "literacy_acknowledgements", ctx({ projectIds: [fx.projA], memberIds: [fx.userA] }))).toBe(3);
    expect(await runCollector(db, "literacy_acknowledgements", ctx({ projectIds: [fx.projB], memberIds: [fx.userB] }))).toBe(1);
    expect(await runCollector(db, "literacy_acknowledgements", ctx({ projectIds: [], memberIds: [] }))).toBe(0);
  });

  it("decision_regression_runs: in-period runs only, and only under an org-scoped report", async () => {
    expect(await runCollector(db, "decision_regression_runs", ctx())).toBe(3);
    expect(await runCollector(db, "decision_regression_runs", ctx({ projectIds: [fx.projA], memberIds: [fx.userA] }))).toBe(0);
  });
});
