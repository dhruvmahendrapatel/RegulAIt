/**
 * ADR-0182 (ADR-0175 batch D4) — D4 security review fix DFX1, migration 0168:
 * the accountability records survive the deletion of what they are about, and
 * the append-only rule admits only the referential actions it was written for.
 *
 * Red proofs (each fails with migration 0168 reverted):
 *  - deleting a use case KEEPS its decision records, with `use_case_id` null;
 *  - an UPDATE of a non-FK column of an append-only record, nested in another
 *    trigger, is refused (0162 admitted anything at trigger depth > 1);
 *  - a nested DELETE of an incident's event while the incident exists is refused;
 *  - an incident that is not closed cannot be deleted; a closed one goes with
 *    its events and clocks (the record's OWN parent);
 *  - the SET NULL path still works: deleting a user nulls the actor.
 *
 * Global state: the probe table and function this file creates are dropped in
 * `finally`; every row it creates is removed (or left closed) before it ends.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiIncidentEvents,
  aiIncidentNotifications,
  aiIncidents,
  aiUseCases,
  createDb,
  eq,
  runMigrations,
  sql,
  useCaseDecisionRecords,
  users,
  type Db,
} from "@regulait/db";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const PROBE = `a12_nested_probe_${RUN}`;
const PROBE_FN = `a12_nested_probe_fn_${RUN}`;
let db: Db;
const made = { users: [] as string[], useCases: [] as string[], incidents: [] as string[] };

/** the text of a refusal, including Postgres's own message (drizzle wraps it as `cause`) */
function refusalText(e: unknown): string {
  return `${String((e as Error)?.message ?? e)} ${String((e as { cause?: Error })?.cause?.message ?? "")}`;
}
async function expectRefused(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const e = await Promise.resolve(p).then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, "the statement must be refused").not.toBeNull();
  expect(refusalText(e)).toMatch(pattern);
}

async function mkUser(label: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `a12-integrity-${label}-${RUN}@example.com`, displayName: `a12 integrity ${label} ${RUN}` })
    .returning({ id: users.id });
  made.users.push(u!.id);
  return u!.id;
}
async function mkUseCase(owner: string): Promise<string> {
  const [row] = await db
    .insert(aiUseCases)
    .values({ name: `a12 integrity ${RUN}`, description: "synthetic fixture", ownerUserId: owner, businessContext: "synthetic", dataSensitivity: "internal" })
    .returning({ id: aiUseCases.id });
  made.useCases.push(row!.id);
  return row!.id;
}
async function mkIncident(): Promise<string> {
  const [row] = await db
    .insert(aiIncidents)
    .values({ title: `a12 integrity ${RUN}`, severity: "high", detectionSource: "manual", awareAt: new Date() })
    .returning({ id: aiIncidents.id });
  made.incidents.push(row!.id);
  return row!.id;
}
async function mkEvent(incidentId: string, actorUserId: string | null): Promise<string> {
  const [ev] = await db
    .insert(aiIncidentEvents)
    .values({ incidentId, kind: "note", note: `synthetic note ${RUN}`, actorUserId })
    .returning({ id: aiIncidentEvents.id });
  return ev!.id;
}
const closeSql = (id: string) =>
  sql`UPDATE ai_incidents SET status = 'closed', closed_at = now(), root_cause = 'synthetic root cause',
    lessons_learned = 'synthetic lesson' WHERE id = ${id} AND status <> 'closed'`;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
}, 120_000);

afterAll(async () => {
  try {
    for (const id of made.incidents) {
      await db.execute(closeSql(id));
      await db.delete(aiIncidents).where(eq(aiIncidents.id, id));
    }
    for (const id of made.useCases) await db.delete(aiUseCases).where(eq(aiUseCases.id, id));
    // decision records outlive both; a user is removed with its actor columns set null
    for (const id of made.users) await db.delete(users).where(eq(users.id, id));
  } finally {
    await db.$client.end();
  }
});

describe("migration 0168: records outlive what they are about", () => {
  it("deleting a use case keeps its decision records, with use_case_id set null", async () => {
    const owner = await mkUser("owner");
    const uc = await mkUseCase(owner);
    const [rec] = await db
      .insert(useCaseDecisionRecords)
      .values({ useCaseId: uc, outcome: "approved", decidedAt: new Date(), decidedBy: owner })
      .returning({ id: useCaseDecisionRecords.id });
    await db.delete(aiUseCases).where(eq(aiUseCases.id, uc));
    const kept = await db.select().from(useCaseDecisionRecords).where(eq(useCaseDecisionRecords.id, rec!.id));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ useCaseId: null, outcome: "approved", decidedBy: owner });
    // still append-only, and still never deleted directly
    await expectRefused(db.delete(useCaseDecisionRecords).where(eq(useCaseDecisionRecords.id, rec!.id)), /append-only/);
  });

  it("an incident that is not closed cannot be deleted; a closed one goes with its own events and clocks", async () => {
    const inc = await mkIncident();
    const ev = await mkEvent(inc, null);
    const start = new Date();
    const [clock] = await db
      .insert(aiIncidentNotifications)
      .values({ incidentId: inc, regime: "eu-ai-act", clockId: "art73-2-general", clockStart: start, dueAt: new Date(start.getTime() + 86_400_000) })
      .returning({ id: aiIncidentNotifications.id });
    await expectRefused(db.delete(aiIncidents).where(eq(aiIncidents.id, inc)), /not closed cannot be deleted/);
    expect(await db.select().from(aiIncidents).where(eq(aiIncidents.id, inc))).toHaveLength(1);
    await db.execute(closeSql(inc));
    await db.delete(aiIncidents).where(eq(aiIncidents.id, inc));
    expect(await db.select().from(aiIncidentEvents).where(eq(aiIncidentEvents.id, ev))).toHaveLength(0);
    expect(await db.select().from(aiIncidentNotifications).where(eq(aiIncidentNotifications.id, clock!.id))).toHaveLength(0);
  });

  it("the SET NULL path still works: deleting a user nulls the actor on the timeline", async () => {
    const actor = await mkUser("actor");
    const inc = await mkIncident();
    const ev = await mkEvent(inc, actor);
    await db.delete(users).where(eq(users.id, actor));
    made.users.splice(made.users.indexOf(actor), 1);
    const [row] = await db.select().from(aiIncidentEvents).where(eq(aiIncidentEvents.id, ev));
    expect(row).toMatchObject({ actorUserId: null, note: `synthetic note ${RUN}` });
  });
});

describe("migration 0168: the append-only trigger admits only the referential actions", () => {
  it("an UPDATE of a non-FK column, or a DELETE while the incident exists, nested in another trigger, is refused", async () => {
    const inc = await mkIncident();
    const actor = await mkUser("nested");
    const ev = await mkEvent(inc, actor);
    // a probe: inserting into it runs a trigger that edits / deletes the event (trigger depth 2)
    await db.execute(sql.raw(`CREATE TABLE "${PROBE}" (event_id uuid NOT NULL, op text NOT NULL)`));
    try {
      await db.execute(
        sql.raw(`CREATE FUNCTION "${PROBE_FN}"() RETURNS trigger AS $$
          BEGIN
            IF NEW.op = 'edit' THEN UPDATE ai_incident_events SET note = 'rewritten' WHERE id = NEW.event_id; END IF;
            IF NEW.op = 'actor' THEN UPDATE ai_incident_events SET actor_user_id = NULL WHERE id = NEW.event_id; END IF;
            IF NEW.op = 'delete' THEN DELETE FROM ai_incident_events WHERE id = NEW.event_id; END IF;
            RETURN NEW;
          END; $$ LANGUAGE plpgsql`),
      );
      await db.execute(sql.raw(`CREATE TRIGGER "${PROBE}_t" AFTER INSERT ON "${PROBE}" FOR EACH ROW EXECUTE FUNCTION "${PROBE_FN}"()`));
      const probe = (op: string) => db.execute(sql`INSERT INTO ${sql.identifier(PROBE)} (event_id, op) VALUES (${ev}, ${op})`);
      await expectRefused(probe("edit"), /ai_incident_events is append-only: UPDATE refused/);
      await expectRefused(probe("delete"), /ai_incident_events is append-only: DELETE refused/);
      const [row] = await db.select().from(aiIncidentEvents).where(eq(aiIncidentEvents.id, ev));
      expect(row?.note).toBe(`synthetic note ${RUN}`);
      // only nulling an ON DELETE SET NULL column is admitted (the shape of the referential action)
      await probe("actor");
      expect((await db.select().from(aiIncidentEvents).where(eq(aiIncidentEvents.id, ev)))[0]).toMatchObject({
        actorUserId: null,
        note: `synthetic note ${RUN}`,
      });
    } finally {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "${PROBE}"`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS "${PROBE_FN}"()`));
    }
  });

  it("a direct UPDATE or DELETE is still refused", async () => {
    const inc = await mkIncident();
    const ev = await mkEvent(inc, null);
    await expectRefused(db.update(aiIncidentEvents).set({ note: "edited" }).where(eq(aiIncidentEvents.id, ev)), /append-only/);
    await expectRefused(db.update(aiIncidentEvents).set({ actorUserId: null }).where(eq(aiIncidentEvents.id, ev)), /append-only/);
    await expectRefused(db.delete(aiIncidentEvents).where(eq(aiIncidentEvents.id, ev)), /append-only/);
  });
});
