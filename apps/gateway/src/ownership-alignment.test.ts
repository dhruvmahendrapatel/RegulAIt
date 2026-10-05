/**
 * ADR-0089 — agent ownership + lifecycle (gap L20) and intended-vs-granted
 * alignment (gap L21), docs/product/GAP_ANALYSIS_SAVIYNT_2026-08.md.
 *
 * What this file makes impossible to fake:
 *
 *  1. A LIFECYCLE THAT IS DECORATIVE. The retired case asserts THE DISPATCH
 *     OUTCOME — a named 409 (`agent_retired`) from `POST /v1/agents/:id/invoke`
 *     with the refusal audited — while the agent's GRANT still exists (grants
 *     keep evaluating; the refusal is a lifecycle decision layered after
 *     them). The deprecated control asserts dispatch still succeeds:
 *     deprecation warns in the inventory and blocks nothing.
 *  2. A TERMINAL STATE THAT ISN'T. Retired refuses every outbound transition
 *     by name (`agent_retired_terminal`) — the decommissioning record cannot
 *     be flipped back.
 *  3. AN ORPHAN FLAG THAT IS A DEFAULT. `unowned` (owner null) and `orphaned`
 *     (owner deactivated — the ADR-0022 state SCIM writes) are asserted as
 *     DISTINCT read-time flags on the ADR-0082 inventory, and the posture
 *     coverage moves by exactly the agents created (M-008 deltas).
 *  4. ALIGNMENT THAT BLENDS BLOCKS. The three flags compare GRANT ROWS
 *     against APPROVED intent only: a PROPOSED use case naming an agent must
 *     NOT clear its overreach flag (control), and a grant held by a
 *     NON-participant must NOT clear a use case's undershoot (control) —
 *     both proving the comparison is participants-vs-grants, never traffic.
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed oa-. Per-OUR-object numbers are absolute (no
 * other suite touches oa- objects); anything org-wide (audit counts, posture)
 * is a delta (M-008). No singleton is touched (M-012).
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiUseCases, auditLog, count, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "oa-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;

let ownerId: string; // active owner of the "owned" agent
let ucOwnerId: string; // proposes/owns the use cases (holds NO grants)
let memberId: string; // project member — the participant who holds grants
let memberAuth: { authorization: string };
let outsiderId: string; // holds grants but participates in NO use case
let projectId: string;
// ONE agent per invoking user, deliberately (the mrm.test.ts lesson): the
// lifecycle gate governs the agent that is actually SERVED, and pillar-6
// routing may serve a different entitled registry entry than the one named in
// the URL — a single-agent entitlement makes "which agent was served"
// deterministic, so the dispatch assertions are about the gate, not routing.
let retireInvokerAuth: { authorization: string };
let deprecateInvokerAuth: { authorization: string };

let agentAligned: string; // approved intent + participant grant → aligned
let agentUndershoot: string; // approved intent, only a NON-participant grant
let agentOverreach: string; // granted, named only by a PROPOSED use case
let agentInert: string; // no grants, no intent — all flags false
let agentRetire: string; // the dispatch-gate subject
let agentDeprecate: string; // the warns-never-blocks control

let ucAlignedId: string; // approved, names agentAligned only
let ucUndershootId: string; // approved, names agentAligned + agentUndershoot
let ucProposedId: string; // proposed, names agentOverreach (the control)
let ucNoIntentId: string; // approved, names nothing

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    // no "@" in the display name — another suite asserts across the whole
    // users table that nothing email-shaped leaks through the directory
    payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${u.json().id}/keys`,
    payload: { name: "oa-key" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function mkAgent(name: string) {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 1, costPerMTokOut: 2 },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

async function grantAgent(userId: string, agentId: string) {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId, agentId },
  });
  expect(r.statusCode).toBe(201);
}

/** an aiUseCases row in a chosen status — the register rows the read-time
 * comparison consumes; approved is normally reached only via the decide path,
 * which other suites already prove, so seeding the row directly keeps this
 * suite about the COMPARISON */
async function seedUseCase(args: {
  name: string;
  status: "proposed" | "approved";
  intendedAgentIds: string[];
  projectId?: string | null;
}) {
  const [row] = await db
    .insert(aiUseCases)
    .values({
      name: args.name,
      description: "oa",
      ownerUserId: ucOwnerId,
      businessContext: "oa",
      dataSensitivity: "internal",
      intendedAgentIds: args.intendedAgentIds,
      projectId: args.projectId ?? null,
      status: args.status,
    })
    .returning({ id: aiUseCases.id });
  return row!.id;
}

const setOwner = (agentId: string, ownerUserId: string | null, auth = AUTH) =>
  app.inject({ method: "POST", headers: auth, url: `/v1/agents/${agentId}/owner`, payload: { ownerUserId } });
const setLifecycle = (agentId: string, payload: Record<string, unknown>, auth = AUTH) =>
  app.inject({ method: "POST", headers: auth, url: `/v1/agents/${agentId}/lifecycle`, payload });
const invoke = (auth: { authorization: string }, agentId: string) =>
  app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "execute", input: "oa probe", dispatch: true },
  });
const detailOf = (agentId: string) =>
  app.inject({ method: "GET", headers: AUTH, url: `/v1/inventory/agents/${agentId}` });
const posture = async () => {
  const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/reports/posture" });
  expect(res.statusCode).toBe(200);
  return res.json();
};

async function auditCount(ruleId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(auditLog).where(eq(auditLog.ruleId, ruleId));
  return row?.n ?? 0;
}

async function listedAgent(agentId: string) {
  const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/inventory/agents" });
  expect(res.statusCode).toBe(200);
  const row = (res.json().agents as Array<{ id: string }>).find((a) => a.id === agentId);
  expect(row, `agent ${agentId} missing from the inventory`).toBeTruthy();
  return row! as {
    id: string;
    owner: { userId: string; name: string | null; deactivated: boolean } | null;
    ownership: string;
    lifecycle: { status: string; reason: string | null; changedAt: string | null; warning?: string; note?: string };
    alignment: { approvedUseCases: number; aligned: boolean; overreach: boolean; undershoot: boolean };
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" });

  ownerId = (await makeUser("oa-owner@example.com")).id;
  ucOwnerId = (await makeUser("oa-uc-owner@example.com")).id;
  const member = await makeUser("oa-member@example.com");
  memberId = member.id;
  memberAuth = member.auth;
  outsiderId = (await makeUser("oa-outsider@example.com")).id;

  agentAligned = await mkAgent("oa-aligned");
  agentUndershoot = await mkAgent("oa-undershoot");
  agentOverreach = await mkAgent("oa-overreach");
  agentInert = await mkAgent("oa-inert");
  agentRetire = await mkAgent("oa-retire-me");
  agentDeprecate = await mkAgent("oa-deprecate-me");

  // the participant grant (member), the non-participant grants (outsider),
  // and the dispatch subjects' grants for the member who will invoke them
  await grantAgent(memberId, agentAligned);
  await grantAgent(outsiderId, agentUndershoot); // control: granted, but not to a participant
  await grantAgent(outsiderId, agentOverreach);
  const retireInvoker = await makeUser("oa-retire-invoker@example.com");
  retireInvokerAuth = retireInvoker.auth;
  await grantAgent(retireInvoker.id, agentRetire);
  const deprecateInvoker = await makeUser("oa-deprecate-invoker@example.com");
  deprecateInvokerAuth = deprecateInvoker.auth;
  await grantAgent(deprecateInvoker.id, agentDeprecate);

  const project = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: "oa-project" },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().id;
  const added = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/projects/${projectId}/members`,
    payload: { userId: memberId, role: "contributor" },
  });
  expect(added.statusCode, added.body).toBe(201);

  ucAlignedId = await seedUseCase({ name: "oa-uc-aligned", status: "approved", intendedAgentIds: [agentAligned], projectId });
  ucUndershootId = await seedUseCase({
    name: "oa-uc-undershoot",
    status: "approved",
    intendedAgentIds: [agentAligned, agentUndershoot],
    projectId,
  });
  ucProposedId = await seedUseCase({ name: "oa-uc-proposed", status: "proposed", intendedAgentIds: [agentOverreach] });
  ucNoIntentId = await seedUseCase({ name: "oa-uc-no-intent", status: "approved", intendedAgentIds: [] });
});

afterAll(async () => {
  await restoreSb2Gates();
  await app.close();
  await db.$client.end();
});

// ---------------------------------------------------------------------------
// L20 — ownership endpoints
// ---------------------------------------------------------------------------

describe("ownership — an audited governance record, never a default", () => {
  it("both write endpoints are admin-only via the default gate; unknown agent is a 404", async () => {
    expect((await setOwner(agentAligned, ownerId, memberAuth)).statusCode).toBe(403);
    expect((await setLifecycle(agentAligned, { status: "deprecated", reason: "x" }, memberAuth)).statusCode).toBe(403);
    expect((await setOwner("00000000-0000-0000-0000-0000000000ab", ownerId)).statusCode).toBe(404);
    expect((await setLifecycle("00000000-0000-0000-0000-0000000000ab", { status: "deprecated", reason: "x" })).statusCode).toBe(404);
  });

  it("owner must be a real, active user — an unknown id is refused, a deactivated one would mint an orphan", async () => {
    const unknown = await setOwner(agentAligned, "00000000-0000-0000-0000-0000000000cd");
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe("invalid_reference");

    const dead = await makeUser("oa-dead-owner@example.com");
    const deact = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${dead.id}/deactivate`, payload: {} });
    expect(deact.statusCode, deact.body).toBe(200);
    const refused = await setOwner(agentAligned, dead.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("owner_deactivated");
  });

  it("set and clear are audited acts, and the row moves exactly as asked", async () => {
    const setBefore = await auditCount("agent-owner-set");
    const clearBefore = await auditCount("agent-owner-cleared");

    const set = await setOwner(agentAligned, ownerId);
    expect(set.statusCode).toBe(200);
    expect(set.json().ownerUserId).toBe(ownerId);
    expect(await auditCount("agent-owner-set")).toBe(setBefore + 1);

    const cleared = await setOwner(agentAligned, null);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().ownerUserId).toBeNull();
    expect(await auditCount("agent-owner-cleared")).toBe(clearBefore + 1);

    // leave the owner SET — the inventory cases below read it
    expect((await setOwner(agentAligned, ownerId)).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// L20 — lifecycle transitions and the dispatch gate
// ---------------------------------------------------------------------------

describe("lifecycle — deprecated warns, retired refuses, and retired is terminal", () => {
  it("a non-active target requires a reason, by name", async () => {
    const res = await setLifecycle(agentDeprecate, { status: "deprecated" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("lifecycle_reason_required");
  });

  it("deprecate stores the reason and audits; repeating the state is a 409", async () => {
    const before = await auditCount("agent-lifecycle-deprecated");
    const res = await setLifecycle(agentDeprecate, { status: "deprecated", reason: "oa: superseded by oa-aligned" });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycleStatus).toBe("deprecated");
    expect(res.json().lifecycleReason).toBe("oa: superseded by oa-aligned");
    expect(res.json().lifecycleChangedAt).toBeTruthy();
    expect(await auditCount("agent-lifecycle-deprecated")).toBe(before + 1);
    const again = await setLifecycle(agentDeprecate, { status: "deprecated", reason: "again" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("lifecycle_unchanged");
  });

  it("retired refuses dispatch with a named 409 (audited) while the grant still exists; deprecated does NOT block", async () => {
    // CONTROL first: the deprecated agent still serves — a warning, not a gate
    const dep = await invoke(deprecateInvokerAuth, agentDeprecate);
    expect(dep.statusCode, dep.body).toBe(200);

    const retire = await setLifecycle(agentRetire, { status: "retired", reason: "oa: decommissioned model line" });
    expect(retire.statusCode).toBe(200);
    expect(retire.json().lifecycleStatus).toBe("retired");

    const before = await auditCount("agent-retired-dispatch-refused");
    const refused = await invoke(retireInvokerAuth, agentRetire);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("agent_retired");
    expect(refused.json().detail).toMatch(/decommissioned model line/);
    expect(await auditCount("agent-retired-dispatch-refused")).toBe(before + 1);
  });

  it("retired is terminal: every outbound transition is refused by name", async () => {
    for (const status of ["active", "deprecated"] as const) {
      const res = await setLifecycle(agentRetire, { status, reason: "trying to undo" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("agent_retired_terminal");
    }
  });
});

// ---------------------------------------------------------------------------
// L20 — the inventory's ownership flag and the posture coverage
// ---------------------------------------------------------------------------

describe("inventory ownership — owned / unowned / orphaned, computed at read time", () => {
  it("owner null is an explicit 'unowned' flag; a recorded owner is 'owned' with a name", async () => {
    const inert = await listedAgent(agentInert);
    expect(inert.ownership).toBe("unowned");
    expect(inert.owner).toBeNull();

    const owned = await listedAgent(agentAligned);
    expect(owned.ownership).toBe("owned");
    expect(owned.owner).toMatchObject({ userId: ownerId, deactivated: false });
    expect(owned.owner!.name).toBeTruthy();
  });

  it("deactivating the owner flips the SAME agent to 'orphaned' — no write to the agent row", async () => {
    const orphanOwner = await makeUser("oa-orphan-owner@example.com");
    const agentOrphan = await mkAgent("oa-orphaned");
    expect((await setOwner(agentOrphan, orphanOwner.id)).statusCode).toBe(200);
    expect((await listedAgent(agentOrphan)).ownership).toBe("owned");

    const deact = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${orphanOwner.id}/deactivate`,
      payload: {},
    });
    expect(deact.statusCode).toBe(200);

    const row = await listedAgent(agentOrphan);
    expect(row.ownership).toBe("orphaned");
    expect(row.owner).toMatchObject({ userId: orphanOwner.id, deactivated: true });

    const detail = await detailOf(agentOrphan);
    expect(detail.json().ownership.flag).toBe("orphaned");
    expect(detail.json().ownership.note).toMatch(/never a default/);
  });

  it("lifecycle rides the inventory: deprecated carries a WARNING, retired says dispatch refuses", async () => {
    const dep = await listedAgent(agentDeprecate);
    expect(dep.lifecycle.status).toBe("deprecated");
    expect(dep.lifecycle.warning).toMatch(/not a control/);
    const ret = await listedAgent(agentRetire);
    expect(ret.lifecycle.status).toBe("retired");
    expect(ret.lifecycle.note).toMatch(/agent_retired/);
    const detail = await detailOf(agentDeprecate);
    expect(detail.json().ownership.lifecycle.warning).toMatch(/dispatch still allowed/);
  });

  it("posture ownership coverage moves by exactly the agents created (deltas, M-008)", async () => {
    const before = await posture();
    const activeOwner = await makeUser("oa-posture-owner@example.com");
    const goneOwner = await makeUser("oa-posture-gone@example.com");
    const p1 = await mkAgent("oa-posture-unowned");
    const p2 = await mkAgent("oa-posture-owned");
    const p3 = await mkAgent("oa-posture-orphaned");
    expect((await setOwner(p2, activeOwner.id)).statusCode).toBe(200);
    expect((await setOwner(p3, goneOwner.id)).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${goneOwner.id}/deactivate`, payload: {} }))
        .statusCode,
    ).toBe(200);
    expect((await setLifecycle(p1, { status: "deprecated", reason: "oa posture delta" })).statusCode).toBe(200);

    const after = await posture();
    expect(after.agentOwnership.total).toBe(before.agentOwnership.total + 3);
    expect(after.agentOwnership.owned).toBe(before.agentOwnership.owned + 1);
    expect(after.agentOwnership.unowned).toBe(before.agentOwnership.unowned + 1);
    expect(after.agentOwnership.orphaned).toBe(before.agentOwnership.orphaned + 1);
    expect(after.agentOwnership.lifecycle.active).toBe(before.agentOwnership.lifecycle.active + 2);
    expect(after.agentOwnership.lifecycle.deprecated).toBe(before.agentOwnership.lifecycle.deprecated + 1);
    expect(after.agentOwnership.note).toMatch(/governance record, not authentication/);
  });
});

// ---------------------------------------------------------------------------
// L21 — intended vs granted, three flags, never traffic
// ---------------------------------------------------------------------------

describe("alignment — grants vs APPROVED intent, with both blend-controls", () => {
  it("aligned: every approved use case naming the agent has a participant with a grant path", async () => {
    const detail = await detailOf(agentAligned);
    const alignment = detail.json().alignment;
    expect(alignment.approvedUseCases).toBe(2); // oa-uc-aligned + oa-uc-undershoot
    expect(alignment.aligned).toBe(true);
    expect(alignment.overreach).toBe(false);
    expect(alignment.undershoot).toBe(false);
    expect(alignment.gaps).toEqual([]);
    expect(alignment.note).toMatch(/never about observed traffic/);
  });

  it("undershoot: a NON-participant's grant does not provision an approved intent (control), and the gap names the use case", async () => {
    const detail = await detailOf(agentUndershoot);
    const alignment = detail.json().alignment;
    expect(alignment.approvedUseCases).toBe(1);
    expect(alignment.undershoot).toBe(true);
    expect(alignment.aligned).toBe(false);
    expect(alignment.overreach).toBe(false); // approved intent exists — this is a provisioning gap, not overreach
    expect(alignment.gaps).toEqual([
      expect.objectContaining({ useCaseId: ucUndershootId, name: "oa-uc-undershoot" }),
    ]);
  });

  it("overreach: granted yet named by NO approved use case — a PROPOSED one does not count (control)", async () => {
    const detail = await detailOf(agentOverreach);
    const alignment = detail.json().alignment;
    expect(alignment.approvedUseCases).toBe(0); // oa-uc-proposed is not approved intent
    expect(alignment.overreach).toBe(true);
    expect(alignment.aligned).toBe(false);
    expect(alignment.undershoot).toBe(false);
  });

  it("no grants and no approved intent is NEITHER flag — nothing to align, said as such", async () => {
    const detail = await detailOf(agentInert);
    const alignment = detail.json().alignment;
    expect(alignment).toMatchObject({ approvedUseCases: 0, aligned: false, overreach: false, undershoot: false });
    // and the list carries the same compact flags
    const row = await listedAgent(agentOverreach);
    expect(row.alignment).toMatchObject({ overreach: true, aligned: false, undershoot: false });
  });

  it("the use-case detail tells the same story from the use case's side", async () => {
    const aligned = await app.inject({ method: "GET", headers: AUTH, url: `/v1/use-cases/${ucAlignedId}` });
    expect(aligned.statusCode).toBe(200);
    expect(aligned.json().intendedVsGranted.status).toBe("aligned");
    expect(aligned.json().intendedVsGranted.agents).toEqual([
      expect.objectContaining({ agentId: agentAligned, grantedToParticipants: true, registered: true }),
    ]);

    const under = await app.inject({ method: "GET", headers: AUTH, url: `/v1/use-cases/${ucUndershootId}` });
    const ivg = under.json().intendedVsGranted;
    expect(ivg.status).toBe("undershoot");
    expect(ivg.agents.find((a: { agentId: string }) => a.agentId === agentAligned)?.grantedToParticipants).toBe(true);
    expect(ivg.agents.find((a: { agentId: string }) => a.agentId === agentUndershoot)?.grantedToParticipants).toBe(
      false,
    );
    expect(ivg.participants).toBeGreaterThanOrEqual(2); // the proposing owner + the project member
  });

  it("a non-approved use case gets no alignment, and an approved one naming nothing says 'no intent recorded'", async () => {
    const proposed = await app.inject({ method: "GET", headers: AUTH, url: `/v1/use-cases/${ucProposedId}` });
    expect(proposed.json().intendedVsGranted.status).toBe("not_approved");
    const noIntent = await app.inject({ method: "GET", headers: AUTH, url: `/v1/use-cases/${ucNoIntentId}` });
    expect(noIntent.json().intendedVsGranted.status).toBe("no_intent_recorded");
    expect(noIntent.json().intendedVsGranted.note).toMatch(/never a guessed alignment/);
  });
});
