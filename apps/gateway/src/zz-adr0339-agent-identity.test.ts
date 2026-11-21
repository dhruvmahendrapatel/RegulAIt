/**
 * ADR-0339 slice 2 — author vs runner, non-human identity links and ownership findings, on a real database.
 *
 * Pinned:
 *  - AUTHOR is recorded by the insert trigger in the creating transaction: the request's principal for a registry agent
 *    created through the API by a named admin, `unknown` with no principal (bootstrap), the owner for a builder agent;
 *    it is never rewritten (UPDATE refused) and goes with its agent.
 *  - RUNNER: the workload identity and the invokers the usage ledger saw in the window.
 *  - OWNERSHIP: unowned, orphaned (deactivated), inactive (not seen within the window) and owned, in the view, in the
 *    findings list and in the risk score's ownership factor.
 *  - LINKS: staged by an admin (audited, a bad identifier refused, a duplicate 409), decided only by a second named
 *    admin with an identity_manage step-up (four eyes, bootstrap refused, API key refused, double decision 409), audited
 *    in the same transaction; non-admins cannot stage, decide or list findings; the view is admin or owner only.
 *
 * Shares one DB with the other gateway suites (fileParallelism off): rows are prefixed r339i-.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentAuthorship,
  agentIdentityLinks,
  agents,
  auditLog,
  builderAgents,
  createDb,
  desc,
  eq,
  inArray,
  runMigrations,
  sql,
  usageEvents,
  users,
  type Db,
} from "@regulait/db";
import { AGENT_OWNER_INACTIVE_DAYS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { assessAgentRisk } from "./agent-risk.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `r339i-boot-${RUN}`;
const BOOTSTRAP = { authorization: `Bearer ${BOOT}` };
type Person = { id: string; auth: { authorization: string } };

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminA: Person;
let adminB: Person;
let plain: Person;
let restoreIdentity: (() => Promise<void>) | undefined;
const agentIds: string[] = [];
const builderIds: string[] = [];
const userIds: string[] = [];

async function mkUser(tag: string, admin = false): Promise<Person> {
  const u = await app.inject({ method: "POST", headers: BOOTSTRAP, url: "/v1/users", payload: { email: `r339i-${tag}-${RUN}@example.com`, displayName: `r339i ${tag}` } });
  expect(u.statusCode).toBe(201);
  const id = u.json().id as string;
  userIds.push(id);
  if (admin) {
    const up = await app.inject({ method: "POST", headers: BOOTSTRAP, url: `/v1/users/${id}/admin`, payload: { isAdmin: true, reason: "r339i" } });
    expect(up.statusCode).toBe(200);
  }
  const k = await app.inject({ method: "POST", headers: BOOTSTRAP, url: `/v1/users/${id}/keys`, payload: { name: `r339i-${tag}` } });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function mkAgentAs(headers: Record<string, string>, name: string) {
  const r = await app.inject({ method: "POST", headers, url: "/v1/agents", payload: { name: `${name}-${RUN}`, provider: "mock", tier: 1, model: "mock-balanced" } });
  expect(r.statusCode).toBe(201);
  agentIds.push(r.json().id);
  return r.json().id as string;
}

const view = (id: string, headers: Record<string, string> = BOOTSTRAP, kind = "agent") =>
  app.inject({ method: "GET", headers, url: `/v1/agent-identity/${kind}/${id}` });
const stage = (id: string, payload: Record<string, unknown>, headers: Record<string, string> = adminA.auth) =>
  app.inject({ method: "POST", headers, url: `/v1/agent-identity/agent/${id}/links`, payload });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT });
  adminA = await mkUser("admin-a", true);
  adminB = await mkUser("admin-b", true);
  plain = await mkUser("plain");
});

afterAll(async () => {
  if (builderIds.length) await db.delete(builderAgents).where(inArray(builderAgents.id, builderIds));
  if (agentIds.length) {
    await db.delete(usageEvents).where(inArray(usageEvents.agentId, agentIds));
    await db.delete(agents).where(inArray(agents.id, agentIds));
  }
  await restoreIdentity?.();
  await app.close();
});

describe("ADR-0339 slice 2: author and runner", () => {
  it("records the creating principal, unknown without one, and the owner of a builder agent; never rewritten", async () => {
    const byAdmin = await mkAgentAs(adminA.auth, "r339i-by-admin");
    const byBoot = await mkAgentAs(BOOTSTRAP, "r339i-by-boot");
    const [a] = await db.select().from(agentAuthorship).where(eq(agentAuthorship.agentId, byAdmin));
    expect(a).toMatchObject({ source: "principal", authorUserId: adminA.id });
    const [b] = await db.select().from(agentAuthorship).where(eq(agentAuthorship.agentId, byBoot));
    expect(b).toMatchObject({ source: "unknown", authorUserId: null });
    // never rewritten
    await expect(db.update(agentAuthorship).set({ authorUserId: adminB.id }).where(eq(agentAuthorship.id, a!.id))).rejects.toThrow();
    await expect(db.delete(agentAuthorship).where(eq(agentAuthorship.id, a!.id))).rejects.toThrow();

    const [ba] = await db.insert(builderAgents).values({ name: `r339i-b-${RUN}`, ownerUserId: plain.id, connectionFormat: "per_user" }).returning({ id: builderAgents.id });
    builderIds.push(ba!.id);
    const [c] = await db.select().from(agentAuthorship).where(eq(agentAuthorship.builderAgentId, ba!.id));
    expect(c).toMatchObject({ source: "builder_owner", authorUserId: plain.id });

    const v = await view(byAdmin);
    expect(v.statusCode).toBe(200);
    expect(v.json().author).toMatchObject({ source: "principal", userId: adminA.id, displayName: "r339i admin-a" });
    const vb = await view(ba!.id, plain.auth, "builder_agent");
    expect(vb.statusCode).toBe(200);
    expect(vb.json().runner).toMatchObject({ connections: "each caller's own connections" });
  });

  it("the runner lists who the usage ledger saw invoking it in the window, most active first", async () => {
    const id = await mkAgentAs(BOOTSTRAP, "r339i-runner");
    const old = new Date(Date.now() - 40 * 86_400_000);
    await db.insert(usageEvents).values([
      { userId: plain.id, agentId: id },
      { userId: plain.id, agentId: id },
      { userId: adminB.id, agentId: id },
      { userId: adminA.id, agentId: id, at: old },
    ]);
    const v = await view(id);
    expect(v.json().runner.invokers).toEqual([
      { userId: plain.id, displayName: "r339i plain", calls: 2 },
      { userId: adminB.id, displayName: "r339i admin-b", calls: 1 },
    ]);
    expect(v.json().runner.workloadIdentity).toBeNull();
  });
});

describe("ADR-0339 slice 2: ownership", () => {
  it("unowned, orphaned, inactive and owned: in the view, the findings and the risk score", async () => {
    const owner = await mkUser("quiet");
    const id = await mkAgentAs(BOOTSTRAP, "r339i-own");
    const flag = async () => (await view(id)).json().ownership.flag;
    expect(await flag()).toBe("unowned");

    await db.update(agents).set({ ownerUserId: owner.id }).where(eq(agents.id, id));
    // a brand-new account counts its creation as activity
    expect(await flag()).toBe("owned");

    // backdate the account and its key use past the window: inactive
    const past = new Date(Date.now() - (AGENT_OWNER_INACTIVE_DAYS + 5) * 86_400_000);
    await db.update(users).set({ createdAt: past }).where(eq(users.id, owner.id));
    await db.execute(sql`UPDATE api_keys SET last_used_at = ${past.toISOString()}::timestamptz WHERE user_id = ${owner.id}`);
    expect(await flag()).toBe("inactive");
    const inactive = await app.inject({ method: "GET", headers: adminA.auth, url: "/v1/agent-identity/ownership-findings?kind=agent&flag=inactive&limit=500" });
    expect((inactive.json().items as Array<{ id: string; flag: string }>).find((i) => i.id === id)?.flag).toBe("inactive");
    const risk = await assessAgentRisk(db, { kind: "agent", id });
    expect(risk!.factors.find((f) => f.id === "ownership")).toMatchObject({ present: true, points: 8 });

    // a recent sign-in through the key makes them active again
    await db.execute(sql`UPDATE api_keys SET last_used_at = now() WHERE user_id = ${owner.id}`);
    expect(await flag()).toBe("owned");

    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, owner.id));
    expect(await flag()).toBe("orphaned");

    // ADR-0226: the list is filtered in SQL before paging, so every item on a page is a finding (no sparse pages),
    // and the SQL flag agrees with the view's TypeScript flag for the same owner
    const findings = await app.inject({ method: "GET", headers: adminA.auth, url: "/v1/agent-identity/ownership-findings?kind=agent&flag=orphaned&limit=500&count=exact" });
    expect(findings.statusCode).toBe(200);
    const page = findings.json() as { kind: string; items: Array<{ id: string; flag: string }>; total: number; inactiveAfterDays: number };
    expect(page.kind).toBe("agent");
    expect(page.inactiveAfterDays).toBe(AGENT_OWNER_INACTIVE_DAYS);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((i) => i.flag === "orphaned")).toBe(true);
    expect(page.items.find((i) => i.id === id)?.flag).toBe("orphaned");
    expect(page.total).toBeGreaterThanOrEqual(page.items.length);
    // the default list never carries an owned agent
    const all = await app.inject({ method: "GET", headers: adminA.auth, url: "/v1/agent-identity/ownership-findings?limit=10" });
    expect(all.statusCode).toBe(200);
    expect((all.json().items as Array<{ flag: string }>).every((i) => i.flag !== "owned")).toBe(true);
    // the contract's limits and unknown filters are refused
    expect((await app.inject({ method: "GET", headers: adminA.auth, url: "/v1/agent-identity/ownership-findings?limit=200" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", headers: adminA.auth, url: "/v1/agent-identity/ownership-findings?flag=owned" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", headers: plain.auth, url: "/v1/agent-identity/ownership-findings" })).statusCode).toBe(403);
    // the same list as an Excel download (ADR-0226), admin only
    const xlsx = await app.inject({ method: "GET", headers: adminA.auth, url: "/v1/agent-identity/ownership-findings/export.xlsx?kind=agent&flag=orphaned&columns=name,flag,owner,lastActive" });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect((await app.inject({ method: "GET", headers: adminA.auth, url: "/v1/agent-identity/ownership-findings/export.xlsx?kind=user&columns=name" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", headers: plain.auth, url: "/v1/agent-identity/ownership-findings/export.xlsx" })).statusCode).toBe(403);
  });
});

describe("ADR-0339 slice 2: non-human identity links", () => {
  const ARN = "arn:aws:iam::123456789012:role/r339i-runtime";

  it("stage: admin only, audited, bad identifiers refused, duplicates 409; the view lists it as staged", async () => {
    const id = await mkAgentAs(BOOTSTRAP, "r339i-link");
    expect((await stage(id, { kind: "cloud_service_account", provider: "aws", externalId: ARN }, plain.auth)).statusCode).toBe(403);
    expect((await stage(id, { kind: "cloud_service_account", provider: "gcp", externalId: ARN })).statusCode).toBe(400);
    const r = await stage(id, { kind: "cloud_service_account", provider: "aws", externalId: ARN, note: "runtime role" });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: "staged", stagedByUserId: adminA.id, source: "admin" });
    expect((await stage(id, { kind: "cloud_service_account", provider: "aws", externalId: ARN })).statusCode).toBe(409);
    const audit = await db.select().from(auditLog).where(sql`${auditLog.objectId} = ${id} AND ${auditLog.ruleId} = 'agent-nhi-link-staged'`);
    expect(audit).toHaveLength(1);
    const v = await view(id);
    expect(v.json().nonHumanIdentities).toMatchObject([{ provider: "aws", externalId: ARN, status: "staged" }]);
  });

  it("decide: a second named admin with an identity_manage step-up; four eyes, bootstrap and API keys refused", async () => {
    const id = await mkAgentAs(BOOTSTRAP, "r339i-decide");
    const link = (await stage(id, { kind: "vendor_agent_identity", provider: "entra", externalId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" })).json();
    const url = `/v1/agent-identity/links/${link.id}/decision`;
    const payload = { decision: "confirmed" as const };

    expect((await app.inject({ method: "POST", headers: BOOTSTRAP, url, payload })).json().error).toBe("named_admin_required");
    expect((await app.inject({ method: "POST", headers: adminA.auth, url, payload })).json().error).toBe("four_eyes");
    expect((await app.inject({ method: "POST", headers: plain.auth, url, payload })).statusCode).toBe(403);
    // an API key cannot carry a step-up
    const byKey = await app.inject({ method: "POST", headers: adminB.auth, url, payload });
    expect(byKey.statusCode).toBe(403);
    expect(byKey.json().error).toBe("step_up_required");
    // a grant for the other decision does not authorise this one
    const wrong = await grantStepUpForTest(db, adminB.id, { kind: "identity_manage", facts: { op: "agent_nhi_link_decide", linkId: link.id, decision: "rejected" } });
    const refused = await app.inject({ method: "POST", url, payload, ...stepUpRequest(wrong) });
    // refused (403, or 422 when this admin has no step-up method enrolled), and nothing decided
    expect([403, 422]).toContain(refused.statusCode);
    expect(refused.json().error).toMatch(/^step_up_/);
    expect((await db.select().from(agentIdentityLinks).where(eq(agentIdentityLinks.id, link.id)))[0]!.status).toBe("staged");

    const g = await grantStepUpForTest(db, adminB.id, { kind: "identity_manage", facts: { op: "agent_nhi_link_decide", linkId: link.id, decision: "confirmed" } });
    const ok = await app.inject({ method: "POST", url, payload, ...stepUpRequest(g) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "confirmed", decidedByUserId: adminB.id, stagedByUserId: adminA.id });
    const [audit] = await db.select().from(auditLog).where(sql`${auditLog.objectId} = ${id} AND ${auditLog.ruleId} = 'agent-nhi-link-decided'`).orderBy(desc(auditLog.at));
    expect(audit!.userId).toBe(adminB.id);
    expect(audit!.detail).toMatchObject({ decision: "confirmed", stepUp: "totp" });

    const g2 = await grantStepUpForTest(db, adminB.id, { kind: "identity_manage", facts: { op: "agent_nhi_link_decide", linkId: link.id, decision: "confirmed" } });
    expect((await app.inject({ method: "POST", url, payload, ...stepUpRequest(g2) })).statusCode).toBe(409);
    // the database holds the four-eyes rule too
    await expect(db.update(agentIdentityLinks).set({ decidedByUserId: adminA.id }).where(eq(agentIdentityLinks.id, link.id))).rejects.toThrow();
  });

  it("the view is admin or owner only", async () => {
    const id = await mkAgentAs(BOOTSTRAP, "r339i-authz");
    expect((await view(id, plain.auth)).statusCode).toBe(404);
    await db.update(agents).set({ ownerUserId: plain.id }).where(eq(agents.id, id));
    expect((await view(id, plain.auth)).statusCode).toBe(200);
    expect((await view(id, plain.auth)).headers["cache-control"]).toBe("private, no-store");
  });
});
