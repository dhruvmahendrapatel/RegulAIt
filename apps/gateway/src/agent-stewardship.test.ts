/**
 * ADR-0168 amendment item 6 — agent stewardship (steward, successor, lifecycle,
 * review cadence) on the registry, end to end through the HTTP API.
 *
 * What this file makes impossible to fake:
 *
 *  1. AN ORPHAN FLAG THAT IS DECORATIVE. `orphaned` is read-time: a new agent
 *     (no steward) reads orphaned; naming a steward clears it; DEACTIVATING
 *     that steward flips it back with no write to the agent row.
 *  2. A SUCCESSOR WHO IS THE STEWARD. Refused by name (422), and the row does
 *     not move; the successor stepping up through either route clears the
 *     successor slot instead of tripping the DB CHECK.
 *  3. A STEWARD GATE THAT IS REALLY THE ADMIN GATE. A non-admin who is the
 *     CURRENT steward may write and record a review; a non-admin who is not
 *     (including the PREVIOUS steward after a hand-over) gets 403
 *     not_agent_steward on both routes.
 *  4. A CADENCE THAT IGNORES RISK. A recorded review schedules +12 months with
 *     no linked use case and with only a REJECTED high-tier one (control), and
 *     +6 months once a live high-tier use case names the agent.
 *  5. A LIFECYCLE THAT IS DECORATIVE. `suspended` refuses dispatch with a named
 *     409 (audited) while the grant still exists, and an ADMIN returning it to
 *     active dispatches again (control). Retired stays terminal on this route too.
 *  6. (ADR-0170 item 7) A STEWARD WHO CAN UNDO AN ADMIN. A non-admin steward may
 *     put an agent under review or suspend it, but lifting a suspension,
 *     retiring, leaving `proposed` and clearing the next review are refused
 *     (403 admin_required_for_lifecycle); a steward's next review is capped at
 *     the cadence (422 next_review_beyond_cadence); lifecycle writes are
 *     compare-and-swap (409 lifecycle_changed_concurrently, proven with a held
 *     row lock, not a timing race); and a request naming a suspended/retired
 *     agent is refused even when routing would downroute it to an active one.
 *
 * Shares one DB with the other gateway suites (fileParallelism off); every
 * object here is prefixed st-. Audit counts are deltas (M-008); no singleton is
 * touched (M-012).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agents, aiUseCases, and, auditLog, count, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "st-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
type Auth = { authorization: string };

let db: Db;
let app: ReturnType<typeof buildApp>;

let steward: { id: string; auth: Auth };
let successor: { id: string; auth: Auth };
let outsider: { id: string; auth: Auth };
let ucOwnerId: string;

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") },
  });
  expect(u.statusCode, u.body).toBe(201);
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "st-key" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function mkAgent(name: string) {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 1, costPerMTokOut: 2 },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

const patch = (agentId: string, payload: Record<string, unknown>, auth: Auth = AUTH) =>
  app.inject({ method: "PATCH", headers: auth, url: `/v1/agents/${agentId}/stewardship`, payload });
const review = (agentId: string, auth: Auth = AUTH) =>
  app.inject({ method: "POST", headers: auth, url: `/v1/agents/${agentId}/stewardship/review`, payload: {} });
const invoke = (auth: Auth, agentId: string) =>
  app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "execute", input: "st probe", dispatch: true },
  });

interface ListedAgent {
  id: string;
  ownerUserId: string | null;
  successorUserId: string | null;
  stewardUserId: string | null;
  stewardName: string | null;
  stewardDeactivated: boolean;
  successorName: string | null;
  orphaned: boolean;
  reviewOverdue: boolean;
  nextReviewAt: string | null;
  lastReviewedAt: string | null;
  lastReviewedByName: string | null;
  reviewCadenceMonths: number;
  highestUseCaseTier: string | null;
  lifecycleStatus: string;
  lifecycleReason: string | null;
}

async function listed(agentId: string): Promise<ListedAgent> {
  const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/agents?limit=5000" });
  expect(res.statusCode).toBe(200);
  const row = (res.json().agents as ListedAgent[]).find((a) => a.id === agentId);
  expect(row, `agent ${agentId} missing from GET /v1/agents`).toBeTruthy();
  return row!;
}

async function auditCount(ruleId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(auditLog).where(eq(auditLog.ruleId, ruleId));
  return row?.n ?? 0;
}

const monthsFromNow = (iso: string) => (Date.parse(iso) - Date.now()) / (30.44 * 86_400_000);

async function seedUseCase(name: string, status: "approved" | "rejected", tier: "high" | "minimal", agentIds: string[]) {
  const [row] = await db
    .insert(aiUseCases)
    .values({
      name,
      description: "st",
      ownerUserId: ucOwnerId,
      businessContext: "st",
      dataSensitivity: "internal",
      intendedAgentIds: agentIds,
      status,
      euAiActTier: tier,
      // the tier is only ever stored with its screening provenance (DB CHECK)
      euAiActReasons: [],
      euAiActRulesetVersion: 1,
    })
    .returning({ id: aiUseCases.id });
  return row!.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  steward = await makeUser("st-steward@example.com");
  successor = await makeUser("st-successor@example.com");
  outsider = await makeUser("st-outsider@example.com");
  ucOwnerId = (await makeUser("st-uc-owner@example.com")).id;
});

afterAll(async () => {
  await restoreSb2Gates();
  await app.close();
  await db.$client.end();
});

describe("stewardship — steward, successor and the orphan flag", () => {
  it("a new agent has no steward and reads orphaned; its review is not scheduled", async () => {
    const id = await mkAgent("st-new");
    const row = await listed(id);
    expect(row.stewardUserId).toBeNull();
    expect(row.orphaned).toBe(true);
    expect(row.reviewOverdue).toBe(false);
    expect(row.nextReviewAt).toBeNull();
    expect(row.reviewCadenceMonths).toBe(12);
  });

  it("naming a steward and a successor is one audited write; the flag clears", async () => {
    const id = await mkAgent("st-owned");
    const before = await auditCount("agent-stewardship-updated");
    const next = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const res = await patch(id, { stewardUserId: steward.id, successorUserId: successor.id, nextReviewAt: next });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().stewardName).toBe("st steward");
    expect(res.json().successorName).toBe("st successor");
    expect(res.json().orphaned).toBe(false);
    expect(await auditCount("agent-stewardship-updated")).toBe(before + 1);
    const [audit] = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, "agent-stewardship-updated")));
    expect((audit!.detail as { changes: Record<string, unknown> }).changes).toMatchObject({
      stewardUserId: { from: null, to: steward.id },
      successorUserId: { from: null, to: successor.id },
    });
    const row = await listed(id);
    expect(row.ownerUserId).toBe(steward.id); // the steward IS the ADR-0089 owner — one column
    expect(row.nextReviewAt).toBe(next);
    // repeating the same write changes nothing and audits nothing
    const again = await patch(id, { stewardUserId: steward.id });
    expect(again.statusCode).toBe(200);
    expect(again.json().unchanged).toBe(true);
    expect(await auditCount("agent-stewardship-updated")).toBe(before + 1);
  });

  it("a successor equal to the steward is refused by name and the row does not move", async () => {
    const id = await mkAgent("st-same-person");
    expect((await patch(id, { stewardUserId: steward.id })).statusCode).toBe(200);
    const refused = await patch(id, { successorUserId: steward.id });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("successor_is_steward");
    const both = await patch(id, { stewardUserId: successor.id, successorUserId: successor.id });
    expect(both.statusCode).toBe(422);
    expect((await listed(id)).successorUserId).toBeNull();
    expect((await listed(id)).ownerUserId).toBe(steward.id);
  });

  it("the successor stepping up clears the successor slot — through PATCH and through the owner route", async () => {
    const a = await mkAgent("st-promote-patch");
    expect((await patch(a, { stewardUserId: steward.id, successorUserId: successor.id })).statusCode).toBe(200);
    const up = await patch(a, { stewardUserId: successor.id });
    expect(up.statusCode, up.body).toBe(200);
    expect(up.json().stewardUserId).toBe(successor.id);
    expect(up.json().successorUserId).toBeNull();

    const b = await mkAgent("st-promote-owner");
    expect((await patch(b, { stewardUserId: steward.id, successorUserId: successor.id })).statusCode).toBe(200);
    const viaOwner = await app.inject({ method: "POST", headers: AUTH, url: `/v1/agents/${b}/owner`, payload: { ownerUserId: successor.id } });
    expect(viaOwner.statusCode, viaOwner.body).toBe(200);
    expect(viaOwner.json().ownerUserId).toBe(successor.id);
    expect(viaOwner.json().successorUserId).toBeNull();
  });

  it("people must be real and active", async () => {
    const id = await mkAgent("st-people");
    const unknown = await patch(id, { successorUserId: "00000000-0000-0000-0000-0000000000cd" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: "invalid_reference", field: "successorUserId" });
    const gone = await makeUser("st-gone@example.com");
    expect((await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${gone.id}/deactivate`, payload: {} })).statusCode).toBe(200);
    expect((await patch(id, { successorUserId: gone.id })).json().error).toBe("successor_deactivated");
    expect((await patch(id, { stewardUserId: gone.id })).json().error).toBe("steward_deactivated");
    expect((await patch(id, {})).statusCode).toBe(400); // nothing named
  });

  it("deactivating the steward orphans the agent at read time, with no write to the agent", async () => {
    const leaver = await makeUser("st-leaver@example.com");
    const id = await mkAgent("st-orphan-me");
    expect((await patch(id, { stewardUserId: leaver.id, successorUserId: successor.id })).statusCode).toBe(200);
    expect((await listed(id)).orphaned).toBe(false);
    expect((await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${leaver.id}/deactivate`, payload: {} })).statusCode).toBe(200);
    const row = await listed(id);
    expect(row.orphaned).toBe(true);
    expect(row.stewardDeactivated).toBe(true);
    expect(row.successorName).toBe("st successor"); // who should take over is still on the record
    // the agent card carries the same flag
    const card = await app.inject({ method: "GET", headers: AUTH, url: `/v1/agents/${id}/card` });
    expect(card.statusCode).toBe(200);
    expect(card.json().stewardship).toMatchObject({ orphaned: true, successorName: "st successor" });
  });
});

describe("who may act — an admin or the CURRENT steward", () => {
  it("a non-admin non-steward is refused on both routes; the current steward is not", async () => {
    const id = await mkAgent("st-gate");
    expect((await patch(id, { stewardUserId: steward.id, successorUserId: successor.id })).statusCode).toBe(200);

    const outsiderPatch = await patch(id, { successorUserId: outsider.id }, outsider.auth);
    expect(outsiderPatch.statusCode).toBe(403);
    expect(outsiderPatch.json().error).toBe("not_agent_steward");
    expect((await review(id, outsider.auth)).statusCode).toBe(403);
    // the successor is not the steward either
    expect((await review(id, successor.auth)).statusCode).toBe(403);

    expect((await review(id, steward.auth)).statusCode).toBe(200);
    // B4S-01: a hand-over is an owner change and needs an `owner_change` step-up,
    // which an API key can never give — the steward is refused by name, and the
    // hand-over goes through an admin (zz-b4s-stewardship-step-up proves the
    // steward's own stepped-up hand-over in a browser session)
    const keyHandOver = await patch(id, { stewardUserId: outsider.id, successorUserId: successor.id }, steward.auth);
    expect(keyHandOver.statusCode, keyHandOver.body).toBe(403);
    expect(keyHandOver.json()).toMatchObject({ error: "step_up_required", actionKind: "owner_change", methods: [] });
    const handOver = await patch(id, { stewardUserId: outsider.id, successorUserId: successor.id });
    expect(handOver.statusCode, handOver.body).toBe(200);
    // the PREVIOUS steward lost the right with the hand-over
    expect((await patch(id, { stewardUserId: steward.id }, steward.auth)).statusCode).toBe(403);
    expect((await review(id, outsider.auth)).statusCode).toBe(200);
  });

  it("the rest of the agent registry stays admin-only", async () => {
    const id = await mkAgent("st-admin-only");
    expect((await patch(id, { stewardUserId: steward.id })).statusCode).toBe(200);
    // being an agent's steward does not open the admin routes around it
    const owner = await app.inject({ method: "POST", headers: steward.auth, url: `/v1/agents/${id}/owner`, payload: { ownerUserId: null } });
    expect(owner.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", headers: steward.auth, url: "/v1/agents" })).statusCode).toBe(403);
  });
});

describe("review cadence — by the highest risk tier of the live use cases naming the agent", () => {
  it("+12 months with no use case and with only a REJECTED high-tier one; +6 once a live one is high", async () => {
    const id = await mkAgent("st-cadence");
    const before = await auditCount("agent-stewardship-reviewed");
    const first = await review(id);
    expect(first.statusCode, first.body).toBe(200);
    expect(monthsFromNow(first.json().nextReviewAt)).toBeGreaterThan(11.5);
    expect(first.json().lastReviewedAt).toBeTruthy();
    expect(first.json().lastReviewedByName).toBeNull(); // bootstrap token, no user
    expect(await auditCount("agent-stewardship-reviewed")).toBe(before + 1);

    await seedUseCase("st-uc-rejected-high", "rejected", "high", [id]);
    const control = await review(id);
    expect(control.json().highestUseCaseTier).toBeNull();
    expect(monthsFromNow(control.json().nextReviewAt)).toBeGreaterThan(11.5);

    await seedUseCase("st-uc-minimal", "approved", "minimal", [id]);
    expect(monthsFromNow((await review(id)).json().nextReviewAt)).toBeGreaterThan(11.5);

    await seedUseCase("st-uc-high", "approved", "high", [id]);
    const high = await review(id);
    expect(high.json().highestUseCaseTier).toBe("high");
    expect(high.json().reviewCadenceMonths).toBe(6);
    const months = monthsFromNow(high.json().nextReviewAt);
    expect(months).toBeGreaterThan(5.5);
    expect(months).toBeLessThan(6.5);
  });

  it("a past review date reads overdue; PATCH refuses to schedule one; recording a review clears it", async () => {
    const id = await mkAgent("st-overdue");
    expect((await patch(id, { stewardUserId: steward.id })).statusCode).toBe(200);
    const past = await patch(id, { nextReviewAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(past.statusCode).toBe(422);
    expect(past.json().error).toBe("next_review_in_past");
    expect((await listed(id)).reviewOverdue).toBe(false);

    // time passing is the only way a date becomes overdue — simulate it on the row
    await db.update(agents).set({ nextReviewAt: new Date(Date.now() - 86_400_000) }).where(eq(agents.id, id));
    expect((await listed(id)).reviewOverdue).toBe(true);
    expect((await review(id, steward.auth)).statusCode).toBe(200);
    const after = await listed(id);
    expect(after.reviewOverdue).toBe(false);
    expect(after.lastReviewedByName).toBe("st steward");
  });
});

describe("lifecycle on the stewardship route — suspended refuses dispatch, retired is terminal", () => {
  it("suspended needs a reason, refuses dispatch with a named 409 (audited) while the grant stays; active dispatches again", async () => {
    const id = await mkAgent("st-suspend-me");
    const invoker = await makeUser("st-suspend-invoker@example.com");
    expect((await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: invoker.id, agentId: id } })).statusCode).toBe(201);
    expect((await invoke(invoker.auth, id)).statusCode).toBe(200);

    const noReason = await patch(id, { lifecycleStatus: "suspended" });
    expect(noReason.statusCode).toBe(422);
    expect(noReason.json().error).toBe("lifecycle_reason_required");

    expect((await patch(id, { lifecycleStatus: "suspended", lifecycleReason: "st: incident under investigation" })).statusCode).toBe(200);
    const before = await auditCount("agent-suspended-dispatch-refused");
    const refused = await invoke(invoker.auth, id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("agent_suspended");
    expect(await auditCount("agent-suspended-dispatch-refused")).toBe(before + 1);

    const back = await patch(id, { lifecycleStatus: "active" });
    expect(back.statusCode).toBe(200);
    expect(back.json().lifecycleStatus).toBe("active");
    expect((await listed(id)).lifecycleReason).toBeNull();
    expect((await invoke(invoker.auth, id)).statusCode).toBe(200);
  });

  it("under review warns only — dispatch is not blocked", async () => {
    const id = await mkAgent("st-under-review");
    const invoker = await makeUser("st-review-invoker@example.com");
    expect((await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: invoker.id, agentId: id } })).statusCode).toBe(201);
    expect((await patch(id, { lifecycleStatus: "under_review", lifecycleReason: "st: quarterly check" })).statusCode).toBe(200);
    expect((await invoke(invoker.auth, id)).statusCode).toBe(200);
  });

  it("retired cannot be left through this route, and has nothing left to review", async () => {
    const id = await mkAgent("st-retire-me");
    expect((await patch(id, { lifecycleStatus: "retired", lifecycleReason: "st: replaced" })).statusCode).toBe(200);
    const out = await patch(id, { lifecycleStatus: "active" });
    expect(out.statusCode).toBe(409);
    expect(out.json().error).toBe("agent_retired_terminal");
    expect((await review(id)).statusCode).toBe(409);
    // stewardship of the record itself can still be named
    expect((await patch(id, { stewardUserId: steward.id })).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// ADR-0170 item 7 — a steward may TIGHTEN an agent's lifecycle, never loosen it;
// a steward's next review is capped at the cadence; lifecycle writes are CAS;
// and the dispatch gate judges the agent the request NAMED, not only the one
// routing chose to serve.
// ---------------------------------------------------------------------------

const lifecycle = (agentId: string, payload: Record<string, unknown>, auth: Auth = AUTH) =>
  app.inject({ method: "POST", headers: auth, url: `/v1/agents/${agentId}/lifecycle`, payload });
const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
async function statusOf(agentId: string) {
  const [row] = await db.select({ s: agents.lifecycleStatus, r: agents.lifecycleReason }).from(agents).where(eq(agents.id, agentId));
  return row!;
}

type Injected = Awaited<ReturnType<typeof patch>>;

/**
 * Deterministic race: a second connection holds an uncommitted UPDATE on the
 * agent row (as a concurrent request would), the request under test reads the
 * OLD committed status and then blocks on that row lock; the competing write
 * commits; the request's UPDATE re-checks its WHERE against the new row. With
 * compare-and-swap it matches nothing (409); without, it overwrites the
 * competing write.
 */
async function raceAgainst(
  agentId: string,
  competing: { status: string; reason: string | null },
  request: () => PromiseLike<Injected>,
): Promise<Injected> {
  const client = await db.$client.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE agents SET lifecycle_status = $1, lifecycle_reason = $2 WHERE id = $3", [
      competing.status,
      competing.reason,
      agentId,
    ]);
    const pending = Promise.resolve().then(() => request());
    // wait until the request is parked on the row lock this transaction holds
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await db.$client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'update "agents"%'`,
      );
      if (rows[0]!.n > 0) break;
      if (Date.now() > deadline) throw new Error("the request never reached the agent row lock");
      await new Promise((r) => setTimeout(r, 20));
    }
    await client.query("COMMIT");
    return await pending;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

describe("ADR-0170 item 7 — a steward tightens the lifecycle, only an admin loosens it", () => {
  it("a steward cannot lift a suspension an admin imposed (not even to under review); the admin can", async () => {
    const id = await mkAgent("st-sod-suspended");
    const invoker = await makeUser("st-sod-invoker@example.com");
    expect((await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: invoker.id, agentId: id } })).statusCode).toBe(201);
    expect((await patch(id, { stewardUserId: steward.id })).statusCode).toBe(200);
    expect((await patch(id, { lifecycleStatus: "suspended", lifecycleReason: "st: admin incident hold" })).statusCode).toBe(200);

    const lift = await patch(id, { lifecycleStatus: "active" }, steward.auth);
    expect(lift.statusCode, lift.body).toBe(403);
    expect(lift.json().error).toBe("admin_required_for_lifecycle");
    // under_review dispatches again, so from suspended it is a loosening too
    const soften = await patch(id, { lifecycleStatus: "under_review", lifecycleReason: "st: looks fine to me" }, steward.auth);
    expect(soften.statusCode).toBe(403);
    expect(soften.json().error).toBe("admin_required_for_lifecycle");
    expect(await statusOf(id)).toEqual({ s: "suspended", r: "st: admin incident hold" });
    expect((await invoke(invoker.auth, id)).json().error).toBe("agent_suspended");

    const back = await patch(id, { lifecycleStatus: "active" });
    expect(back.statusCode, back.body).toBe(200);
    expect((await invoke(invoker.auth, id)).statusCode).toBe(200);
  });

  it("a steward may put the agent under review and suspend it, but may not retire it or move a proposed one", async () => {
    const id = await mkAgent("st-sod-tighten");
    expect((await patch(id, { stewardUserId: steward.id })).statusCode).toBe(200);
    const underReview = await patch(id, { lifecycleStatus: "under_review", lifecycleReason: "st: steward check" }, steward.auth);
    expect(underReview.statusCode, underReview.body).toBe(200);
    const suspend = await patch(id, { lifecycleStatus: "suspended", lifecycleReason: "st: steward pulls it" }, steward.auth);
    expect(suspend.statusCode, suspend.body).toBe(200);
    expect(suspend.json().lifecycleStatus).toBe("suspended");

    const other = await mkAgent("st-sod-retire");
    expect((await patch(other, { stewardUserId: steward.id })).statusCode).toBe(200);
    const retire = await patch(other, { lifecycleStatus: "retired", lifecycleReason: "st: steward retires" }, steward.auth);
    expect(retire.statusCode).toBe(403);
    expect(retire.json().error).toBe("admin_required_for_lifecycle");
    expect((await statusOf(other)).s).toBe("active");

    const proposed = await mkAgent("st-sod-proposed");
    expect((await patch(proposed, { stewardUserId: steward.id })).statusCode).toBe(200);
    expect((await lifecycle(proposed, { status: "proposed", reason: "st: not yet in service" })).statusCode).toBe(200);
    for (const target of ["active", "under_review", "suspended"]) {
      const out = await patch(proposed, { lifecycleStatus: target, lifecycleReason: "st: steward moves it" }, steward.auth);
      expect(out.statusCode, `${target}: ${out.body}`).toBe(403);
      expect(out.json().error).toBe("admin_required_for_lifecycle");
    }
    expect((await statusOf(proposed)).s).toBe("proposed");
    // the admin keeps every move
    expect((await patch(proposed, { lifecycleStatus: "active" })).statusCode).toBe(200);
  });

  it("a steward's next review is capped at the cadence and cannot be cleared; an admin's is not", async () => {
    const id = await mkAgent("st-sod-cadence");
    expect((await patch(id, { stewardUserId: steward.id })).statusCode).toBe(200);

    const far = await patch(id, { nextReviewAt: daysFromNow(400) }, steward.auth);
    expect(far.statusCode).toBe(422);
    expect(far.json()).toMatchObject({ error: "next_review_beyond_cadence", cadenceMonths: 12 });
    const ok = await patch(id, { nextReviewAt: daysFromNow(330) }, steward.auth);
    expect(ok.statusCode, ok.body).toBe(200);

    // a live high-risk use case shortens the cadence to 6 months
    await seedUseCase("st-sod-uc-high", "approved", "high", [id]);
    const sevenMonths = await patch(id, { nextReviewAt: daysFromNow(215) }, steward.auth);
    expect(sevenMonths.statusCode).toBe(422);
    expect(sevenMonths.json()).toMatchObject({ error: "next_review_beyond_cadence", cadenceMonths: 6 });
    expect((await patch(id, { nextReviewAt: daysFromNow(150) }, steward.auth)).statusCode).toBe(200);

    const clear = await patch(id, { nextReviewAt: null }, steward.auth);
    expect(clear.statusCode).toBe(403);
    expect(clear.json().error).toBe("admin_required_for_lifecycle");
    expect((await listed(id)).nextReviewAt).not.toBeNull();

    // the admin may schedule beyond the cadence ...
    const adminFar = daysFromNow(700);
    expect((await patch(id, { nextReviewAt: adminFar })).statusCode).toBe(200);
    // ... a steward re-sending that stored date (a form round-trip) is not refused ...
    const resend = await patch(id, { nextReviewAt: adminFar, successorUserId: successor.id }, steward.auth);
    expect(resend.statusCode, resend.body).toBe(200);
    // ... and the admin may clear it
    expect((await patch(id, { nextReviewAt: null })).statusCode).toBe(200);
    expect((await listed(id)).nextReviewAt).toBeNull();
  });
});

describe("ADR-0170 item 7 — lifecycle writes are compare-and-swap", () => {
  it("stewardship PATCH: a concurrent retirement is not overwritten by a set-active that read before it", async () => {
    const id = await mkAgent("st-cas-patch");
    expect((await patch(id, { lifecycleStatus: "suspended", lifecycleReason: "st: hold" })).statusCode).toBe(200);
    const res = await raceAgainst(id, { status: "retired", reason: "st: retired concurrently" }, () => patch(id, { lifecycleStatus: "active" }));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("lifecycle_changed_concurrently");
    expect(await statusOf(id)).toEqual({ s: "retired", r: "st: retired concurrently" });
  });

  it("stewardship PATCH that does not touch the status still cannot write a stale one back", async () => {
    const id = await mkAgent("st-cas-successor");
    expect((await patch(id, { stewardUserId: steward.id })).statusCode).toBe(200);
    const res = await raceAgainst(id, { status: "suspended", reason: "st: suspended concurrently" }, () =>
      patch(id, { successorUserId: successor.id }, steward.auth),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("lifecycle_changed_concurrently");
    expect(await statusOf(id)).toEqual({ s: "suspended", r: "st: suspended concurrently" });
  });

  it("POST /v1/agents/:id/lifecycle: a concurrent retirement is not un-retired", async () => {
    const id = await mkAgent("st-cas-lifecycle");
    expect((await lifecycle(id, { status: "suspended", reason: "st: hold" })).statusCode).toBe(200);
    const res = await raceAgainst(id, { status: "retired", reason: "st: retired concurrently" }, () => lifecycle(id, { status: "active" }));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("lifecycle_changed_concurrently");
    expect(await statusOf(id)).toEqual({ s: "retired", r: "st: retired concurrently" });
  });
});

describe("ADR-0170 item 7 — routing cannot serve a request for an out-of-service agent", () => {
  it("a request naming a suspended (or retired) agent is refused even when routing would downroute it to an active one", async () => {
    const mk = async (name: string, tier: number, cin: number, cout: number) => {
      const r = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/agents",
        payload: { name, provider: "mock", tier, model: "mock-balanced", costPerMTokIn: cin, costPerMTokOut: cout },
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().id as string;
    };
    const requested = await mk("st-route-requested", 2, 10, 40);
    const cheap = await mk("st-route-cheap", 1, 1, 2);
    const invoker = await makeUser("st-route-invoker@example.com");
    for (const agentId of [requested, cheap]) {
      expect((await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: invoker.id, agentId } })).statusCode).toBe(201);
    }
    // control: routing really does downroute this request onto the cheaper agent
    const routed = await invoke(invoker.auth, requested);
    expect(routed.statusCode, routed.body).toBe(200);
    expect(routed.json().routing.selectedAgentId).toBe(cheap);

    expect((await lifecycle(requested, { status: "suspended", reason: "st: requested agent pulled" })).statusCode).toBe(200);
    const before = await auditCount("agent-suspended-dispatch-refused");
    const refused = await invoke(invoker.auth, requested);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toBe("agent_suspended");
    expect(await auditCount("agent-suspended-dispatch-refused")).toBe(before + 1);
    const [audit] = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.objectId, requested), eq(auditLog.ruleId, "agent-suspended-dispatch-refused")));
    expect(audit!.detail).toMatchObject({ requestedAgent: true, servedAgentId: cheap });

    expect((await lifecycle(requested, { status: "retired", reason: "st: requested agent retired" })).statusCode).toBe(200);
    const retired = await invoke(invoker.auth, requested);
    expect(retired.statusCode, retired.body).toBe(409);
    expect(retired.json().error).toBe("agent_retired");
    // the cheaper agent itself still serves when it is the one asked for
    expect((await invoke(invoker.auth, cheap)).statusCode).toBe(200);
  });
});
