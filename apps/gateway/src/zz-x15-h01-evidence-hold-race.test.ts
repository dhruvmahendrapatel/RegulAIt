/**
 * X15-H01 — the Art. 73(6) evidence hold cannot race a configuration write
 * that was admitted before the hold began (ADR-0182 A12, D4 DFX2).
 *
 * The hold used to be checked OUTSIDE the transaction that performs the
 * protected write. A write that passed the check and then waited (on the
 * agent row's lock, or anywhere else) committed after a serious incident's
 * hold had begun, with no refusal and no override record.
 *
 * Both orderings are driven deterministically on a real database — a lock
 * holder parks one side and the test releases it only after
 * `pg_stat_activity` shows the other side waiting (no timing assumptions):
 *
 *  1. the reviewer's ordering: the PATCH has passed the hold check and waits
 *     on the agent row; an incident linking the agent is opened meanwhile.
 *     The incident's hold may not begin while the admitted write is in
 *     flight — it waits for the write, so the write is ordered before the
 *     hold; the next write is refused.
 *  2. the reverse: a hold-creating transaction (a link to a serious incident)
 *     is in flight; a PATCH that passed the old pre-check waits for it, and
 *     once it commits the PATCH re-checks inside its own transaction and is
 *     refused 409 with nothing written.
 *  3. as 2, with an admin's override header: the change goes through and the
 *     override is audited in the same transaction as the write.
 *
 * Global state (M-040/M-068): the incidents this file opens are closed and
 * deleted, the use cases deleted; every id is this run's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, aiIncidentLinks, aiIncidents, aiUseCases, and, auditLog, desc, eq, inArray, ne, sql } from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { EVIDENCE_HOLD_OVERRIDE_HEADER, incidentsHoldingAgent } from "./incidents.js";

/** the advisory-lock key hold creators and protected writes serialise on
 * (`EVIDENCE_HOLD_LOCK_KEY` in agent-evidence-hold.ts); a literal here so this
 * file also runs against code that predates the key */
const HOLD_LOCK_KEY = 6_000_000_182;

let k: BuilderKit;
let admin: Person;
const created = { incidents: [] as string[], useCases: [] as string[] };

const lastAudit = async (ruleId: string, objectId: string) =>
  (
    await k.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)))
      .orderBy(desc(auditLog.seq))
      .limit(1)
  )[0];

/** a serious incident on a high-tier use case linking `agentIds`: its Art. 73 clock is pending, so the hold binds */
async function holdOn(...agentIds: string[]): Promise<{ id: string; ref: string }> {
  const [uc] = await k.db
    .insert(aiUseCases)
    .values({
      name: `x15h01 hold ${k.RUN} ${created.useCases.length}`,
      description: "synthetic X15-H01 fixture",
      ownerUserId: admin.id,
      businessContext: "synthetic",
      dataSensitivity: "internal",
      euAiActTier: "high",
      euAiActRulesetVersion: 1,
      euAiActReasons: [],
    })
    .returning({ id: aiUseCases.id });
  created.useCases.push(uc!.id);
  const r = await k.req("POST", "/v1/incidents", admin.auth, {
    title: `x15h01 incident ${k.RUN}`,
    severity: "high",
    detectionSource: "manual",
    useCaseId: uc!.id,
    serious: true,
    seriousCriteria: ["health"],
    links: agentIds.map((objectId) => ({ objectType: "agent", objectId })),
  });
  expect(r.statusCode, r.body).toBe(201);
  const inc = r.json().incident as { id: string; ref: string };
  created.incidents.push(inc.id);
  return inc;
}

/** how many backends of this database wait on a lock matching `extra` */
async function waiting(extra: ReturnType<typeof sql>): Promise<number> {
  const res = await k.db.execute(
    sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and ${extra}`,
  );
  return Number(((res as unknown as { rows: Array<{ n: number }> }).rows ?? [])[0]?.n ?? 0);
}

/** resolves once `cond` holds (polled), rejects after 15 s — a condition wait, not a sleep */
async function until(cond: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** a transaction that runs `body`, then stays open until `release()` */
function parked(body: (tx: Parameters<Parameters<BuilderKit["db"]["transaction"]>[0]>[0]) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  const done = k.db.transaction(async (tx) => {
    await body(tx);
    ready();
    await gate;
  });
  return { release, isReady, done };
}

const priceOf = async (id: string) =>
  Number((await k.db.select({ p: agents.costPerMTokIn }).from(agents).where(eq(agents.id, id)))[0]!.p);

beforeAll(async () => {
  k = await builderKit("x15h01");
  admin = await k.person("admin", { admin: true });
}, 120_000);

afterAll(async () => {
  // migration 0168 (DFX1): an incident that is not closed is never deleted, so the fixtures are closed first
  // (a test-only shortcut past the API's close rules), then deleted (their events, links and clocks cascade)
  if (created.incidents.length) {
    await k.db
      .update(aiIncidents)
      .set({ status: "closed", closedAt: new Date(), rootCause: "x15h01 fixture cleanup", lessonsLearned: "x15h01 fixture cleanup" })
      .where(and(inArray(aiIncidents.id, created.incidents), ne(aiIncidents.status, "closed")));
    await k.db.delete(aiIncidents).where(inArray(aiIncidents.id, created.incidents));
  }
  if (created.useCases.length) await k.db.delete(aiUseCases).where(inArray(aiUseCases.id, created.useCases));
  await k.close();
});

describe("X15-H01: a write admitted before an evidence hold cannot commit after it", () => {
  it("the reviewer's ordering: an incident opened while an admitted PATCH waits on the agent row does not begin its hold under it", async () => {
    const a = await k.model("rowlock", { price: 1 });
    // another session holds the agent row (exactly the reviewer's `SELECT … FOR UPDATE`)
    const locker = parked(async (tx) => {
      await tx.execute(sql`select id from agents where id = ${a} for update`);
    });
    await locker.isReady;
    const patch = k.req("PATCH", `/v1/agents/${a}`, admin.auth, { costPerMTokIn: 123 });
    // the PATCH has passed the hold check and its SQL now waits for the row lock
    await until(async () => (await waiting(sql`query ilike '%"agents"%for update%'`)) > 0, "the PATCH waiting on the agent row lock");
    // while it waits, a serious incident linking the agent is opened
    const incident = holdOn(a);
    // either the incident commits now, or it waits for the admitted write (on the hold lock)
    const order = await Promise.race([
      incident.then(() => "incident committed while the PATCH was pending" as const),
      until(async () => (await waiting(sql`wait_event = 'advisory'`)) > 0, "the incident waiting on the hold lock").then(
        () => "incident waited for the admitted PATCH" as const,
      ),
    ]);
    locker.release();
    await locker.done;
    const r = await patch;
    const inc = await incident;
    const price = await priceOf(a);
    const overrides = await k.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "ai-incident-evidence-hold-overridden"), eq(auditLog.objectId, inc.id)));

    // THE INVARIANT (Art. 73(6)): a change may not commit after the hold began unless an override was audited
    if (order === "incident committed while the PATCH was pending") {
      expect(
        { status: r.statusCode, price, overrides: overrides.length },
        `the PATCH admitted before incident ${inc.ref} committed AFTER its evidence hold began, with no override: ${r.body}`,
      ).toEqual({ status: 409, price: 1, overrides: 0 });
    }
    // and how the fix keeps it: hold creation and protected writes serialise, so the write is ordered first
    expect(order).toBe("incident waited for the admitted PATCH");
    expect(r.statusCode, r.body).toBe(200);
    expect(price).toBe(123);
    // the hold is active now, and the next change is refused
    expect((await incidentsHoldingAgent(k.db, a)).map((h) => h.id)).toContain(inc.id);
    const next = await k.req("PATCH", `/v1/agents/${a}`, admin.auth, { costPerMTokIn: 456 });
    expect(next.statusCode, next.body).toBe(409);
    expect(next.json().error).toBe("incident_evidence_hold");
    expect(await priceOf(a)).toBe(123);
  });

  it("the reverse ordering: a hold that commits while an admitted PATCH waits refuses it, nothing written", async () => {
    const b = await k.model("held-b");
    const inc = await holdOn(b);
    const a = await k.model("linked-late", { price: 2 });
    // a hold-creating transaction in flight: it links agent A to the serious incident, not yet committed
    const creator = parked(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${HOLD_LOCK_KEY}::bigint)`);
      await tx.insert(aiIncidentLinks).values({ incidentId: inc.id, objectType: "agent", objectId: a, createdBy: admin.id });
    });
    await creator.isReady;
    // the PATCH's pre-check reads committed state — no hold on A yet — and proceeds to its write
    const patch = k.req("PATCH", `/v1/agents/${a}`, admin.auth, { costPerMTokIn: 77 });
    const order = await Promise.race([
      patch.then(() => "PATCH finished before the hold committed" as const),
      until(async () => (await waiting(sql`wait_event = 'advisory'`)) > 0, "the PATCH waiting on the hold lock").then(
        () => "PATCH waited for the hold" as const,
      ),
    ]);
    creator.release();
    await creator.done;
    const r = await patch;
    expect({ status: r.statusCode, price: await priceOf(a) }, `the PATCH committed under the hold (${order}): ${r.body}`).toEqual({
      status: 409,
      price: 2,
    });
    expect(r.json().error).toBe("incident_evidence_hold");
    expect((await lastAudit("ai-incident-evidence-hold-refused", inc.id))?.detail).toMatchObject({ agentId: a });
  });

  it("the reverse ordering with an admin override: the change goes through and the override is audited with it", async () => {
    const b = await k.model("held-c");
    const inc = await holdOn(b);
    const a = await k.model("override-late", { price: 3 });
    const creator = parked(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${HOLD_LOCK_KEY}::bigint)`);
      await tx.insert(aiIncidentLinks).values({ incidentId: inc.id, objectType: "agent", objectId: a, createdBy: admin.id });
    });
    await creator.isReady;
    const reason = "patient harm continues, the price must change now";
    const patch = k.req("PATCH", `/v1/agents/${a}`, { ...admin.auth, [EVIDENCE_HOLD_OVERRIDE_HEADER]: reason }, { costPerMTokIn: 88 });
    await Promise.race([patch, until(async () => (await waiting(sql`wait_event = 'advisory'`)) > 0, "the PATCH waiting on the hold lock")]);
    creator.release();
    await creator.done;
    const r = await patch;
    expect(r.statusCode, r.body).toBe(200);
    expect(await priceOf(a)).toBe(88);
    const over = await lastAudit("ai-incident-evidence-hold-overridden", inc.id);
    expect(over, "the override that let the change through is audited on the incident").toBeDefined();
    expect(over!.userId).toBe(admin.id);
    expect(over!.reason).toContain(reason);
    expect(over!.detail).toMatchObject({ agentId: a, change: "model and prices" });
  });
});
