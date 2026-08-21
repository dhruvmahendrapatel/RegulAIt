/**
 * ADR-0090 — grant certification campaigns (gap L22,
 * docs/product/GAP_ANALYSIS_SAVIYNT_2026-08.md).
 *
 * What this file makes impossible to fake:
 *
 *  1. A REVOKE THAT IS AN EXPORT. The revoke cases assert THE GRANT ROW IS
 *     GONE — from the grant table itself and from the holder's own
 *     access-preview endpoint — not that a decision field flipped. Three
 *     kinds are driven (direct agent, role-bundled agent, direct MCP tool)
 *     so the per-kind execution switch cannot rot silently, and the KEEP
 *     control asserts the grant SURVIVES an attestation.
 *  2. A SELF-CERTIFICATION. The own-grant bar is DECIDER-keyed (the ADR-0022
 *     lesson): an ADMIN holder deciding "their" item WITH an override reason
 *     — the strongest credential the decide path accepts — is still refused
 *     by name (`cannot_certify_own_grant`), for a direct grant and for a
 *     role-bundled grant the decider's role assignment enjoys.
 *  3. A SECOND DECIDE PATH. Decisions land through the ONE
 *     POST /v1/approvals/:id/decide; a reviewer touching a sibling item
 *     routed to someone else gets the queue's own `not_the_named_approver`
 *     while their own item proceeds — per-item semantics, not campaign-level.
 *  4. A SILENT EXPIRY. A backdated open campaign reads `expired-incomplete`
 *     ON READ (no scheduler), refuses late decisions by name
 *     (`campaign_expired`), leaves its items undecided, and moves the
 *     posture line by exactly one — an auto-keep or auto-revoke anywhere
 *     would fail the undecided assertions.
 *  5. CONTINUOUS-COVERAGE THEATRE. A grant created after open does NOT join
 *     the campaign (snapshot semantics), and a grant deleted between open
 *     and decide leaves the item decidable with the execution reporting the
 *     row was already gone.
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed gc-. Campaign rows are created only by this
 * file, so per-campaign numbers are absolute; anything org-wide (audit
 * counts, posture) is a delta (M-008). No singleton is touched (M-012).
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentGrants,
  auditLog,
  count,
  createDb,
  eq,
  grantCertificationCampaigns,
  grantCertificationItems,
  roleAgentGrants,
  runMigrations,
  toolGrants,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { certificationPostureSection } from "./grant-certification.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "gc-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;

type Auth = { authorization: string };
let openerId: string; // admin — opens every campaign, default reviewer fallback
let openerAuth: Auth;
let ownerId: string; // non-admin owner of agentOwned — the routed reviewer
let ownerAuth: Auth;
let holderAId: string; // holds the two agent grants under review
let holderBId: string; // holds the connector/tool/server grants
let holderAdminId: string; // ADMIN who holds a grant + a role — the bar's subject
let holderAdminAuth: Auth;
let emptyUserId: string; // holds nothing — the empty-scope refusal

let agentOwned: string; // owner = ownerId
let agentUnowned: string;
let agentAdminHeld: string;
let connectorId: string;
let serverId: string;
let roleId: string;

let grantOwnedDirect: string; // agentGrants row: agentOwned -> holderA
let grantUnownedDirect: string; // agentGrants row: agentUnowned -> holderA
let roleGrantOwned: string; // roleAgentGrants row: role -> agentOwned
let toolGrantB: string; // toolGrants row: gc_tool -> holderB

async function makeUser(email: string, opts: { admin?: boolean } = {}) {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    // no "@" in the display name — another suite asserts nothing
    // email-shaped leaks through the directory
    payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") },
  });
  expect(u.statusCode).toBe(201);
  const id = u.json().id as string;
  if (opts.admin) {
    const up = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${id}/admin`,
      payload: { isAdmin: true, reason: "gc coverage" },
    });
    expect(up.statusCode).toBe(200);
  }
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${id}/keys`,
    payload: { name: "gc-key" },
  });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
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

async function grantAgent(userId: string, agentId: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId, agentId },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

const preview = (scope: Record<string, unknown>) =>
  app.inject({ method: "POST", headers: openerAuth, url: "/v1/certification-campaigns/preview", payload: { scope } });
const openCampaign = (payload: Record<string, unknown>, auth: Auth = openerAuth) =>
  app.inject({ method: "POST", headers: auth, url: "/v1/certification-campaigns", payload });
const campaignDetail = async (campaignId: string) => {
  const res = await app.inject({ method: "GET", headers: openerAuth, url: `/v1/certification-campaigns/${campaignId}` });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    status: string;
    storedStatus: string;
    completedAt: string | null;
    items: Array<{
      id: string;
      grantKind: string;
      grantId: string;
      holder: { userId: string | null; roleId: string | null; label: string };
      object: { id: string | null; label: string; toolName: string | null };
      reviewer: { userId: string };
      approvalId: string;
      decision: string | null;
      decidedBy: { userId: string } | null;
      revocation: { mechanism: string; removed: boolean } | null;
    }>;
  };
};
const decide = (auth: Auth, approvalId: string, decision: "approved" | "denied", reason?: string) =>
  app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/approvals/${approvalId}/decide`,
    payload: { decision, ...(reason ? { reason } : {}) },
  });
const posture = async () => {
  const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/reports/posture" });
  expect(res.statusCode).toBe(200);
  return res.json();
};
async function auditCount(ruleId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(auditLog).where(eq(auditLog.ruleId, ruleId));
  return row?.n ?? 0;
}
const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });

  const opener = await makeUser("gc-opener@example.com", { admin: true });
  openerId = opener.id;
  openerAuth = opener.auth;
  const owner = await makeUser("gc-owner@example.com");
  ownerId = owner.id;
  ownerAuth = owner.auth;
  holderAId = (await makeUser("gc-holder-a@example.com")).id;
  holderBId = (await makeUser("gc-holder-b@example.com")).id;
  const holderAdmin = await makeUser("gc-holder-admin@example.com", { admin: true });
  holderAdminId = holderAdmin.id;
  holderAdminAuth = holderAdmin.auth;
  emptyUserId = (await makeUser("gc-empty@example.com")).id;

  agentOwned = await mkAgent("gc-agent-owned");
  agentUnowned = await mkAgent("gc-agent-unowned");
  agentAdminHeld = await mkAgent("gc-agent-admin-held");
  const setOwner = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/agents/${agentOwned}/owner`,
    payload: { ownerUserId: ownerId },
  });
  expect(setOwner.statusCode).toBe(200);

  grantOwnedDirect = await grantAgent(holderAId, agentOwned);
  grantUnownedDirect = await grantAgent(holderAId, agentUnowned);
  await grantAgent(holderAdminId, agentAdminHeld);

  const connector = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/connectors",
    payload: { name: "gc-connector", kind: "data" },
  });
  expect(connector.statusCode).toBe(201);
  connectorId = connector.json().id;
  const cg = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/connectors",
    payload: { userId: holderBId, connectorId, mode: "readwrite" },
  });
  expect(cg.statusCode).toBe(201);

  const server = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: "gc-server", url: "http://127.0.0.1:9" },
  });
  expect(server.statusCode).toBe(201);
  serverId = server.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/servers/${serverId}/tools`,
    payload: { name: "gc_tool", kind: "write" },
  });
  const tg = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/tools",
    payload: { userId: holderBId, serverId, toolName: "gc_tool" },
  });
  expect(tg.statusCode).toBe(201);
  toolGrantB = tg.json().id;
  const sg = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/servers",
    payload: { userId: holderBId, serverId, readOnlyAll: true },
  });
  expect(sg.statusCode).toBe(201);

  const role = await app.inject({ method: "POST", headers: AUTH, url: "/v1/roles", payload: { name: "gc-role" } });
  expect(role.statusCode).toBe(201);
  roleId = role.json().id;
  const rg = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/roles/${roleId}/grants/agents`,
    payload: { agentId: agentOwned },
  });
  expect(rg.statusCode).toBe(201);
  roleGrantOwned = rg.json().id;
  // the role's holder is the ADMIN — the role-bundled half of the bar test
  const assign = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${holderAdminId}/roles`,
    payload: { roleId },
  });
  expect(assign.statusCode).toBe(201);
});

afterAll(async () => {
  await app.close();
  await db.$client.end();
});

describe("scope preview + open-time refusals", () => {
  it("posture says outright that no campaign has ever been run — pinned in a rolled-back transaction, order-proof", async () => {
    // The suite shares one database and vitest orders files by SIZE, not name,
    // so another file (zz-access-recommendations opens campaigns through the
    // feed) can legitimately run first — a global total===0 here is an
    // ordering accident (M-008/M-018). The never-run statement is pinned
    // against a transaction that empties the campaign tables and rolls back,
    // touching nothing durable.
    const rollback = new Error("rollback");
    await db
      .transaction(async (tx) => {
        await tx.delete(grantCertificationItems);
        await tx.delete(grantCertificationCampaigns);
        const s = await certificationPostureSection(tx as unknown as Db, new Date());
        expect(s.total).toBe(0);
        expect(s.note).toMatch(/no certification campaign has ever been run/);
        throw rollback;
      })
      .catch((e) => {
        if (e !== rollback) throw e;
      });
    // and the live endpoint is consistent whichever way the shared DB leans
    const p = await posture();
    if (p.certificationCampaigns.total === 0) {
      expect(p.certificationCampaigns.note).toMatch(/no certification campaign has ever been run/);
    } else {
      expect(p.certificationCampaigns.note).not.toMatch(/never been run/);
    }
  });

  it("preview counts the snapshot a scope would take, by kind", async () => {
    const res = await preview({ kind: "user", value: holderAId });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(2);
    expect(res.json().byKind).toEqual({ agent: 2 });
    // gateway-grants-only is stated on the payload, not in a doc
    expect(res.json().notes.scope).toMatch(/gateway grants only/);

    const byOwner = await preview({ kind: "agent_owner", value: ownerId });
    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.json().byKind).toEqual({ agent: 1, role_agent: 1 });
  });

  it("an empty scope, a past due date, a bad scope value, and the bootstrap token are refused by name", async () => {
    const empty = await openCampaign({ name: "gc-empty", scope: { kind: "user", value: emptyUserId }, dueAt: inOneHour() });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error).toBe("no_grants_in_scope");

    const past = await openCampaign({
      name: "gc-past",
      scope: { kind: "user", value: holderAId },
      dueAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(past.statusCode).toBe(422);
    expect(past.json().error).toBe("due_date_past");

    const badLifecycle = await openCampaign({
      name: "gc-bad",
      scope: { kind: "agent_lifecycle", value: "bogus" },
      dueAt: inOneHour(),
    });
    expect(badLifecycle.statusCode).toBe(422);
    expect(badLifecycle.json().error).toBe("invalid_lifecycle_status");

    const missingValue = await openCampaign({ name: "gc-bad2", scope: { kind: "user" }, dueAt: inOneHour() });
    expect(missingValue.statusCode).toBe(422);
    expect(missingValue.json().error).toBe("scope_value_required");

    const extraValue = await openCampaign({ name: "gc-bad3", scope: { kind: "all", value: "x" }, dueAt: inOneHour() });
    expect(extraValue.statusCode).toBe(422);
    expect(extraValue.json().error).toBe("scope_value_not_allowed");

    const boot = await openCampaign({ name: "gc-boot", scope: { kind: "user", value: holderAId }, dueAt: inOneHour() }, AUTH);
    expect(boot.statusCode).toBe(403);
    expect(boot.json().error).toBe("bootstrap_cannot_open_campaign");
  });
});

describe("campaign 1 — routing, per-item refusal, keep and a real revoke", () => {
  let c1: string;
  let itemOwnedApproval: string; // reviewer = ownerId (the agent's owner)
  let itemUnownedApproval: string; // reviewer = openerId (fallback)

  it("opens over holderA's two agent grants, routing each item to the agent's owner where one exists", async () => {
    const openedBefore = await auditCount("certification-campaign-opened");
    const res = await openCampaign({ name: "gc-c1", scope: { kind: "user", value: holderAId }, dueAt: inOneHour() });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().items).toBe(2);
    c1 = res.json().id;
    expect(await auditCount("certification-campaign-opened")).toBe(openedBefore + 1);

    const detail = await campaignDetail(c1);
    expect(detail.status).toBe("open");
    const owned = detail.items.find((i) => i.object.id === agentOwned)!;
    const unowned = detail.items.find((i) => i.object.id === agentUnowned)!;
    // ADR-0089 ownership put to work: the owned agent's item routes to its
    // owner; the unowned agent's item falls back to the campaign opener
    expect(owned.reviewer.userId).toBe(ownerId);
    expect(unowned.reviewer.userId).toBe(openerId);
    expect(owned.grantKind).toBe("agent");
    expect(owned.grantId).toBe(grantOwnedDirect);
    expect(owned.decision).toBeNull();
    itemOwnedApproval = owned.approvalId;
    itemUnownedApproval = unowned.approvalId;
  });

  it("the reviewer's queue row says whose grant on what it reviews", async () => {
    const queue = await app.inject({ method: "GET", headers: ownerAuth, url: "/v1/approvals?status=pending" });
    expect(queue.statusCode).toBe(200);
    const row = (queue.json().approvals as Array<{ id: string; objectType: string; objectLabel: string | null }>).find(
      (a) => a.id === itemOwnedApproval,
    );
    expect(row, "the routed item must reach the reviewer's own queue").toBeTruthy();
    expect(row!.objectType).toBe("grant_certification");
    expect(row!.objectLabel).toBe("grant certification · gc holder a · gc-agent-owned");
  });

  it("a reviewer touching someone else's item gets the queue's own named refusal, then their own item proceeds", async () => {
    // ownerId is a NON-admin reviewer: the sibling routed to the opener
    // refuses through the one decide path's approver check — per item,
    // nothing campaign-level
    const wrong = await decide(ownerAuth, itemUnownedApproval, "approved");
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toBe("not_the_named_approver");

    const keepBefore = await auditCount("grant-cert-keep");
    const mine = await decide(ownerAuth, itemOwnedApproval, "approved");
    expect(mine.statusCode, mine.body).toBe(200);
    expect(await auditCount("grant-cert-keep")).toBe(keepBefore + 1);

    const detail = await campaignDetail(c1);
    const owned = detail.items.find((i) => i.object.id === agentOwned)!;
    expect(owned.decision).toBe("keep");
    expect(owned.decidedBy!.userId).toBe(ownerId);
    expect(owned.revocation).toBeNull();
    // KEEP is an attestation, not a write: the grant row survives
    const [row] = await db.select().from(agentGrants).where(eq(agentGrants.id, grantOwnedDirect));
    expect(row).toBeTruthy();
  });

  it("a revoke decision EXECUTES the revocation: the grant row is gone and the holder's access preview agrees", async () => {
    const revokeBefore = await auditCount("grant-cert-revoke");
    const completedBefore = await auditCount("certification-campaign-completed");
    const res = await decide(openerAuth, itemUnownedApproval, "denied", "no longer needed");
    expect(res.statusCode, res.body).toBe(200);

    // the row itself is gone from the grant table…
    const gone = await db.select().from(agentGrants).where(eq(agentGrants.id, grantUnownedDirect));
    expect(gone).toHaveLength(0);
    // …and from the holder's own access preview endpoint
    const access = await app.inject({ method: "GET", headers: AUTH, url: `/v1/users/${holderAId}/agents` });
    expect(access.statusCode).toBe(200);
    const grantedIds = (access.json().agents as Array<{ agentId: string }>).map((a) => a.agentId);
    expect(grantedIds).not.toContain(agentUnowned);
    expect(grantedIds).toContain(agentOwned); // the kept sibling survives

    expect(await auditCount("grant-cert-revoke")).toBe(revokeBefore + 1);

    // the last decided item completes the campaign, in the same transaction
    const detail = await campaignDetail(c1);
    expect(detail.storedStatus).toBe("completed");
    expect(detail.status).toBe("completed");
    expect(detail.completedAt).not.toBeNull();
    const unowned = detail.items.find((i) => i.object.id === agentUnowned)!;
    expect(unowned.decision).toBe("revoke");
    expect(unowned.revocation).toEqual({ mechanism: "agent_grant_deleted", removed: true });
    expect(await auditCount("certification-campaign-completed")).toBe(completedBefore + 1);
  });
});

describe("the own-grant bar is keyed on the DECIDER (an admin override cannot cross it)", () => {
  it("a direct holder — even an admin with an override reason — cannot certify their own grant", async () => {
    const res = await openCampaign({ name: "gc-c2", scope: { kind: "user", value: holderAdminId }, dueAt: inOneHour() });
    expect(res.statusCode, res.body).toBe(201);
    const detail = await campaignDetail(res.json().id);
    const item = detail.items.find((i) => i.object.id === agentAdminHeld)!;
    expect(item.reviewer.userId).toBe(openerId); // routed away from the holder

    // holderAdmin is an ADMIN deciding with a reason — the exact credentials
    // the generic override path accepts — and is still refused by name,
    // because the bar asks who SIGNS, not who was named
    const barred = await decide(holderAdminAuth, item.approvalId, "approved", "override: certifying my own access");
    expect(barred.statusCode).toBe(403);
    expect(barred.json().error).toBe("cannot_certify_own_grant");
    expect((await campaignDetail(res.json().id)).items[0]!.decision).toBeNull();

    // the named reviewer (who does not hold the grant) proceeds normally
    const ok = await decide(openerAuth, item.approvalId, "approved");
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe("campaign 3 — role-bundled grants: the role bar, a real role revoke, snapshot semantics", () => {
  let c3: string;
  let roleItemApproval: string;
  let directItemApproval: string;

  it("opens over the owner's agents, covering the role-bundled grant as a ROLE item (never expanded per holder)", async () => {
    const res = await openCampaign({ name: "gc-c3", scope: { kind: "agent_owner", value: ownerId }, dueAt: inOneHour() });
    expect(res.statusCode, res.body).toBe(201);
    c3 = res.json().id;
    const detail = await campaignDetail(c3);
    expect(detail.items).toHaveLength(2);
    const roleItem = detail.items.find((i) => i.grantKind === "role_agent")!;
    const directItem = detail.items.find((i) => i.grantKind === "agent")!;
    expect(roleItem.holder.roleId).toBe(roleId);
    expect(roleItem.holder.label).toBe("role: gc-role");
    expect(roleItem.grantId).toBe(roleGrantOwned);
    expect(directItem.grantId).toBe(grantOwnedDirect);
    // both items are on the OWNED agent — both route to its owner
    expect(roleItem.reviewer.userId).toBe(ownerId);
    roleItemApproval = roleItem.approvalId;
    directItemApproval = directItem.approvalId;
  });

  it("a grant created AFTER open does not join the campaign (snapshot, not continuous coverage)", async () => {
    await grantAgent(holderBId, agentOwned); // in scope had it existed at open
    const detail = await campaignDetail(c3);
    expect(detail.items).toHaveLength(2);
    expect(detail.items.some((i) => i.holder.userId === holderBId)).toBe(false);
  });

  it("a decider who merely HOLDS the role cannot certify the role's grant — same bar, role-bundled half", async () => {
    const barred = await decide(holderAdminAuth, roleItemApproval, "approved", "override: my role's access");
    expect(barred.statusCode).toBe(403);
    expect(barred.json().error).toBe("cannot_certify_own_grant");
  });

  it("revoking the role item deletes the role grant row through the shared removal path", async () => {
    const res = await decide(ownerAuth, roleItemApproval, "denied", "role should not bundle this agent");
    expect(res.statusCode, res.body).toBe(200);
    const gone = await db.select().from(roleAgentGrants).where(eq(roleAgentGrants.id, roleGrantOwned));
    expect(gone).toHaveLength(0);
    const detail = await campaignDetail(c3);
    const roleItem = detail.items.find((i) => i.grantKind === "role_agent")!;
    expect(roleItem.revocation).toEqual({ mechanism: "role_agent_grant_deleted", removed: true });
  });

  it("a grant deleted between open and decide leaves the item decidable — the execution says the row was already gone", async () => {
    // the ordinary admin delete endpoint removes the direct grant first…
    const del = await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/grants/agents/${grantOwnedDirect}` });
    expect(del.statusCode).toBe(200);
    // …and the campaign's revoke still records, reporting removed: false
    const res = await decide(ownerAuth, directItemApproval, "denied", "already removed out of band");
    expect(res.statusCode, res.body).toBe(200);
    const detail = await campaignDetail(c3);
    const directItem = detail.items.find((i) => i.grantKind === "agent")!;
    expect(directItem.decision).toBe("revoke");
    expect(directItem.revocation).toEqual({ mechanism: "agent_grant_deleted", removed: false });
    expect(detail.storedStatus).toBe("completed");
  });
});

describe("campaign 4 — MCP kinds: a tool revoke is a real row deletion", () => {
  it("revokes holderB's tool grant and keeps the connector and server grants", async () => {
    const res = await openCampaign({ name: "gc-c4", scope: { kind: "user", value: holderBId }, dueAt: inOneHour() });
    expect(res.statusCode, res.body).toBe(201);
    const detail = await campaignDetail(res.json().id);
    // holderB: connector + tool + server (+ the agentOwned grant added in
    // the snapshot test above)
    expect(detail.items).toHaveLength(4);
    const toolItem = detail.items.find((i) => i.grantKind === "tool")!;
    expect(toolItem.object.label).toBe("gc-server · gc_tool");
    expect(toolItem.object.toolName).toBe("gc_tool");

    const revoked = await decide(openerAuth, toolItem.approvalId, "denied", "tool no longer needed");
    expect(revoked.statusCode, revoked.body).toBe(200);
    const gone = await db.select().from(toolGrants).where(eq(toolGrants.id, toolGrantB));
    expect(gone).toHaveLength(0);

    for (const kind of ["connector", "server", "agent"] as const) {
      const item = detail.items.find((i) => i.grantKind === kind)!;
      // the agentOwned item routed to the agent's OWNER — each item is
      // decided by its own named reviewer
      const reviewerAuth = item.reviewer.userId === ownerId ? ownerAuth : openerAuth;
      const kept = await decide(reviewerAuth, item.approvalId, "approved");
      expect(kept.statusCode, kept.body).toBe(200);
    }
    expect((await campaignDetail(res.json().id)).storedStatus).toBe("completed");
  });
});

describe("expiry is a visible read-time fact, never a decision", () => {
  let c5: string;
  let pendingApproval: string;

  it("a past-due campaign with undecided items reads expired-incomplete ON READ", async () => {
    const before = await posture();
    const res = await openCampaign({ name: "gc-c5", scope: { kind: "user", value: holderBId }, dueAt: inOneHour() });
    expect(res.statusCode, res.body).toBe(201);
    c5 = res.json().id;
    const detail = await campaignDetail(c5);
    // an item whose NAMED reviewer is the opener, so the expiry refusal below
    // is measured on a clean decide (no override path in the way)
    pendingApproval = detail.items.find((i) => i.reviewer.userId === openerId)!.approvalId;

    // nothing but time passes: backdate the due date (the ADR-0046
    // breach-on-read idiom — deadlines are pure functions of stored state)
    await db
      .update(grantCertificationCampaigns)
      .set({ dueAt: new Date(Date.now() - 60 * 1000) })
      .where(eq(grantCertificationCampaigns.id, c5));

    const after = await campaignDetail(c5);
    expect(after.status).toBe("expired-incomplete");
    expect(after.storedStatus).toBe("open"); // no scheduler wrote anything

    // the posture line moves by exactly this campaign (M-008 delta)
    const p = await posture();
    expect(p.certificationCampaigns.expiredIncomplete).toBe(before.certificationCampaigns.expiredIncomplete + 1);
    expect(p.certificationCampaigns.total).toBe(before.certificationCampaigns.total + 1);
    expect(p.certificationCampaigns.note).toMatch(/expired-incomplete.*computed at read/);
  });

  it("deciding an item of an expired campaign is refused by name — undecided stays undecided forever", async () => {
    const res = await decide(openerAuth, pendingApproval, "approved");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("campaign_expired");
    const detail = await campaignDetail(c5);
    // no auto-keep, no auto-revoke, no late decision: still null
    for (const item of detail.items) expect(item.decision).toBeNull();
    expect(detail.status).toBe("expired-incomplete");
  });
});
