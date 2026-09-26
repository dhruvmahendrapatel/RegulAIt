/**
 * ADR-0091 amendment (batch B2c) — SoD selector depth: N-WAY toxic sets and
 * PATTERN selectors, at the same mint choke point.
 *
 * What this file makes impossible to fake:
 *
 *  1. AN N-WAY RULE THAT FIRES EARLY. The conflict is strict: an identity's
 *     effective holdings must contain ALL sides. The boundary is driven
 *     exactly — a user HOLDING N-1 of the sides mints the (N-1)th freely and
 *     is refused only on the mint that would complete the full set, with a
 *     one-side holder as the control. The role-grant and role-assignment
 *     mint paths reach the same N-way check (the existing matrix, extended —
 *     never a parallel evaluator).
 *  2. A PATTERN THAT IS SECRETLY A SNAPSHOT. Patterns resolve at CHECK time
 *     against current objects: an agent DEPRECATED after the rule exists —
 *     and an agent CREATED after the rule exists — are covered the moment
 *     they match, proven by minting them. Dimensions are ENUMERABLE only
 *     (agent lifecycle status, agent provider kind, connector mode); a
 *     free-text dimension or out-of-vocabulary value is refused by name —
 *     no regex anywhere (the ADR-0085 data-only-rules discipline).
 *  3. A SECOND SURFACE THAT FORKED. Violators for N-way and pattern rules
 *     ride the same computeRuleViolators the rules list, inventory and
 *     posture already read (never auto-revoked, disable-window proven), and
 *     the override path escalates and executes a pattern-rule refusal
 *     through the ONE approvals queue exactly like a concrete one.
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed sodx-, and every rule anchors at least one
 * CONCRETE side on a sodx- object no other file grants, so a pattern side
 * can never refuse another suite's mints. Org-wide numbers (audit counts,
 * posture) are deltas (M-008). No singleton is touched (M-012).
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentGrants, and, count, createDb, eq, roleAgentGrants, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "sodx-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;

type Auth = { authorization: string };
let adminAuth: Auth;
let approverId: string; // arm's-length approver for the override case
let approverAuth: Auth;
let u3Id: string; // the N-way subject: comes to hold sides A and B
let uCtlId: string; // control: holds ONE side only
let uRoleId: string; // the N-way role-path subject
let uLifeId: string; // lifecycle-pattern subject (holds the concrete anchor)
let uProvId: string; // provider-pattern subject (holds the connector anchor)
let uModeId: string; // connector-mode-pattern subject
let uModeReadId: string; // control: read-mode holding is NOT readwrite
let uOvrId: string; // the override case's subject

let agentA: string;
let agentB: string;
let agentC: string;
let agentW: string; // concrete anchor of the lifecycle-pattern rule
let agentQ: string; // concrete anchor of the mode-pattern rule
let agentActive: string; // stays active — the lifecycle control
let agentDep: string; // deprecated AFTER the rule exists
let agentM: string; // a mock agent minted against the provider pattern
let connectorP: string; // concrete anchor of the provider-pattern rule
let connectorM: string; // the connector held against the mode pattern
let rule3way: string;
let ruleLife: string;
let ruleMode: string;

async function makeUser(email: string, opts: { admin?: boolean } = {}) {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") },
  });
  expect(u.statusCode).toBe(201);
  const id = u.json().id as string;
  if (opts.admin) {
    const up = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${id}/admin`,
      payload: { isAdmin: true, reason: "sodx coverage" },
    });
    expect(up.statusCode).toBe(200);
  }
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${id}/keys`,
    payload: { name: "sodx-key" },
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

const grantAgent = (userId: string, agentId: string) =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId } });
const grantConnector = (userId: string, connectorId: string, mode: "read" | "readwrite") =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/connectors", payload: { userId, connectorId, mode } });
const createRule = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", headers: adminAuth, url: "/v1/sod/rules", payload });
const setLifecycle = (agentId: string, status: string, reason: string) =>
  app.inject({ method: "POST", headers: AUTH, url: `/v1/agents/${agentId}/lifecycle`, payload: { status, reason } });
const posture = async () => {
  const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/reports/posture" });
  expect(res.statusCode).toBe(200);
  return res.json();
};
async function agentGrantCount(userId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(agentGrants).where(eq(agentGrants.userId, userId));
  return row?.n ?? 0;
}

const selAgent = (id: string) => ({ kind: "agent", objectId: id });
const patLifecycle = (value: string) => ({ kind: "agent", pattern: { dimension: "lifecycle_status", value } });
const patProvider = (value: string) => ({ kind: "agent", pattern: { dimension: "provider", value } });
const patMode = (value: string) => ({ kind: "connector", pattern: { dimension: "mode", value } });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a1".repeat(32) });

  adminAuth = (await makeUser("sodx-admin@example.com", { admin: true })).auth;
  const approver = await makeUser("sodx-approver@example.com", { admin: true });
  approverId = approver.id;
  approverAuth = approver.auth;
  u3Id = (await makeUser("sodx-holder-nway@example.com")).id;
  uCtlId = (await makeUser("sodx-holder-control@example.com")).id;
  uRoleId = (await makeUser("sodx-holder-role@example.com")).id;
  uLifeId = (await makeUser("sodx-holder-life@example.com")).id;
  uProvId = (await makeUser("sodx-holder-prov@example.com")).id;
  uModeId = (await makeUser("sodx-holder-mode@example.com")).id;
  uModeReadId = (await makeUser("sodx-holder-mode-read@example.com")).id;
  uOvrId = (await makeUser("sodx-holder-ovr@example.com")).id;

  agentA = await mkAgent("sodx-agent-a");
  agentB = await mkAgent("sodx-agent-b");
  agentC = await mkAgent("sodx-agent-c");
  agentW = await mkAgent("sodx-agent-w");
  agentQ = await mkAgent("sodx-agent-q");
  agentActive = await mkAgent("sodx-agent-active");
  agentDep = await mkAgent("sodx-agent-dep");
  agentM = await mkAgent("sodx-agent-m");

  for (const [name, out] of [
    ["sodx-connector-p", (id: string) => (connectorP = id)],
    ["sodx-connector-m", (id: string) => (connectorM = id)],
  ] as const) {
    const c = await app.inject({ method: "POST", headers: AUTH, url: "/v1/connectors", payload: { name, kind: "data" } });
    expect(c.statusCode).toBe(201);
    out(c.json().id);
  }
});

afterAll(async () => {
  await app.close();
  await db.$client.end();
});

describe("authoring — sides are data over closed vocabularies, refused by name otherwise", () => {
  it("refuses malformed shapes: both a/b and sides, a lone side, pattern+object, qualifiers on a pattern, duplicates", async () => {
    const both = await createRule({
      name: "sodx-bad-both",
      reason: "x",
      a: selAgent(agentA),
      b: selAgent(agentB),
      sides: [selAgent(agentA), selAgent(agentB)],
    });
    expect(both.statusCode).toBe(422);
    expect(both.json().error).toBe("sides_or_pair");

    const lone = await createRule({ name: "sodx-bad-lone", reason: "x", a: selAgent(agentA) });
    expect(lone.statusCode).toBe(422);
    expect(lone.json().error).toBe("sides_or_pair");

    const hybrid = await createRule({
      name: "sodx-bad-hybrid",
      reason: "x",
      sides: [{ kind: "agent", objectId: agentA, pattern: { dimension: "lifecycle_status", value: "retired" } }, selAgent(agentB)],
    });
    expect(hybrid.statusCode).toBe(422);
    expect(hybrid.json().error).toBe("pattern_and_object_exclusive");

    const qualified = await createRule({
      name: "sodx-bad-qualified",
      reason: "x",
      sides: [{ kind: "connector", mode: "readwrite", pattern: { dimension: "mode", value: "readwrite" } }, selAgent(agentB)],
    });
    expect(qualified.statusCode).toBe(422);
    expect(qualified.json().error).toBe("pattern_carries_no_qualifiers");

    const bare = await createRule({ name: "sodx-bad-bare", reason: "x", sides: [{ kind: "agent" }, selAgent(agentB)] });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().error).toBe("object_or_pattern_required");

    const dup = await createRule({
      name: "sodx-bad-dup",
      reason: "x",
      sides: [selAgent(agentA), patLifecycle("retired"), patLifecycle("retired")],
    });
    expect(dup.statusCode).toBe(422);
    expect(dup.json().error).toBe("sod_rule_sides_identical");
  });

  it("refuses non-enumerable patterns by name — dimensions and values are CLOSED vocabularies, no regex anywhere", async () => {
    // an out-of-vocabulary value on a real dimension
    const badValue = await createRule({
      name: "sodx-bad-value",
      reason: "x",
      sides: [patLifecycle("bogus"), selAgent(agentB)],
    });
    expect(badValue.statusCode).toBe(422);
    expect(badValue.json().error).toBe("invalid_pattern_value");
    expect(badValue.json().detail).toMatch(/never free text/);

    const badProvider = await createRule({
      name: "sodx-bad-provider",
      reason: "x",
      sides: [patProvider("acme-llc"), selAgent(agentB)],
    });
    expect(badProvider.statusCode).toBe(422);
    expect(badProvider.json().error).toBe("invalid_pattern_value");

    // a real dimension on the wrong kind
    const wrongKind = await createRule({
      name: "sodx-bad-kind",
      reason: "x",
      sides: [{ kind: "connector", pattern: { dimension: "provider", value: "mock" } }, selAgent(agentB)],
    });
    expect(wrongKind.statusCode).toBe(422);
    expect(wrongKind.json().error).toBe("invalid_pattern_dimension");
    const modeOnAgent = await createRule({
      name: "sodx-bad-mode-kind",
      reason: "x",
      sides: [{ kind: "agent", pattern: { dimension: "mode", value: "readwrite" } }, selAgent(agentB)],
    });
    expect(modeOnAgent.statusCode).toBe(422);
    expect(modeOnAgent.json().error).toBe("invalid_pattern_dimension");

    // a dimension that is not in the enum at all — a regex has no door to
    // arrive through (schema-level refusal, not a permissive parse)
    const regex = await createRule({
      name: "sodx-bad-regex",
      reason: "x",
      sides: [{ kind: "agent", pattern: { dimension: "name_regex", value: "^payment-.*" } }, selAgent(agentB)],
    });
    expect(regex.statusCode).toBe(400);
  });
});

describe("N-way — refused only when the FULL set would be held (the exact boundary)", () => {
  it("creates a 3-way rule; holding any 2 of 3 mints freely; the completing mint is refused with every held side named", async () => {
    const res = await createRule({
      name: "sodx-three-way",
      reason: "initiate + approve + reconcile in one pair of hands defeats the control chain",
      sides: [selAgent(agentA), selAgent(agentB), selAgent(agentC)],
    });
    expect(res.statusCode, res.body).toBe(201);
    rule3way = res.json().id;
    expect(res.json().sides).toHaveLength(3);
    expect(res.json().currentViolators).toEqual([]);

    // THE BOUNDARY: side A alone, then A+B (an N-1 subset) — both mint freely
    expect((await grantAgent(u3Id, agentA)).statusCode).toBe(201);
    const secondOfThree = await grantAgent(u3Id, agentB);
    expect(secondOfThree.statusCode, secondOfThree.body).toBe(201);
    // a one-side holder takes a second side too (any N-1 subset is fine)
    expect((await grantAgent(uCtlId, agentC)).statusCode).toBe(201);

    // the COMPLETING mint is the refusal, naming both already-held sides
    const rows = await agentGrantCount(u3Id);
    const full = await grantAgent(u3Id, agentC);
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toBe("sod_conflict");
    expect(full.json().ruleId).toBe(rule3way);
    expect(full.json().detail).toMatch(/all 3 capabilities toxic together/);
    expect(full.json().detail).toMatch(/any 2 of them may be co-held/);
    const existingSides = full.json().conflict.existingSides as Array<{ side: string; via: string }>;
    expect(existingSides).toHaveLength(2);
    expect(existingSides.map((s) => s.side).sort()).toEqual(["agent 'sodx-agent-a'", "agent 'sodx-agent-b'"]);
    expect(await agentGrantCount(u3Id)).toBe(rows); // delta-0: nothing minted
  });

  it("the role-grant and role-assignment mint paths reach the same N-way check", async () => {
    // uRole holds A and B directly (N-1 — both mint freely)
    expect((await grantAgent(uRoleId, agentA)).statusCode).toBe(201);
    expect((await grantAgent(uRoleId, agentB)).statusCode).toBe(201);

    // role path: granting side C to a role uRole holds completes the set
    const role = await app.inject({ method: "POST", headers: AUTH, url: "/v1/roles", payload: { name: "sodx-role-nway" } });
    expect(role.statusCode).toBe(201);
    const roleId = role.json().id as string;
    const assign = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${uRoleId}/roles`, payload: { roleId } });
    expect(assign.statusCode).toBe(201);
    const [before] = await db.select({ n: count() }).from(roleAgentGrants).where(eq(roleAgentGrants.roleId, roleId));
    const rg = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/roles/${roleId}/grants/agents`,
      payload: { agentId: agentC },
    });
    expect(rg.statusCode).toBe(409);
    expect(rg.json().ruleId).toBe(rule3way);
    const [after] = await db.select({ n: count() }).from(roleAgentGrants).where(eq(roleAgentGrants.roleId, roleId));
    expect(after!.n).toBe(before!.n); // delta-0

    // assignment path: an EMPTY role may bundle side C (confers nothing yet);
    // assigning it to the A+B holder is where the completion lands
    const roleC = await app.inject({ method: "POST", headers: AUTH, url: "/v1/roles", payload: { name: "sodx-role-c" } });
    const roleCId = roleC.json().id as string;
    const rgc = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/roles/${roleCId}/grants/agents`,
      payload: { agentId: agentC },
    });
    expect(rgc.statusCode).toBe(201);
    const refused = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${uRoleId}/roles`,
      payload: { roleId: roleCId },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("sod_conflict");
    // control: the ONE-side holder takes the same role — 1 + 1 < 3
    const ok = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${uCtlId}/roles`,
      payload: { roleId: roleCId },
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });
});

describe("pattern selectors — resolved at CHECK time against current objects", () => {
  it("agent lifecycle pattern: an ACTIVE agent passes; an agent deprecated AFTER the rule exists is covered", async () => {
    const res = await createRule({
      name: "sodx-lifecycle-vs-w",
      reason: "deprecated agents plus the w capability re-opens a retired review path",
      sides: [patLifecycle("deprecated"), selAgent(agentW)],
    });
    expect(res.statusCode, res.body).toBe(201);
    ruleLife = res.json().id;
    expect(res.json().sides[0].pattern).toEqual({ dimension: "lifecycle_status", value: "deprecated" });
    expect(res.json().sides[0].label).toBe("agents with lifecycle status 'deprecated'");

    expect((await grantAgent(uLifeId, agentW)).statusCode).toBe(201); // the anchor side alone
    // an ACTIVE agent matches no pattern — mint proceeds (control)
    expect((await grantAgent(uLifeId, agentActive)).statusCode).toBe(201);

    // NOTHING about the rule changes; the AGENT changes — and the pattern
    // sees it at check time
    expect((await setLifecycle(agentDep, "deprecated", "sodx: migration pending")).statusCode).toBe(200);
    const refused = await grantAgent(uLifeId, agentDep);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().ruleId).toBe(ruleLife);
    expect(refused.json().conflict.existingSide).toBe("agent 'sodx-agent-w'");
  });

  it("an agent CREATED after the rule is covered the moment it matches — nothing was snapshotted", async () => {
    const late = await mkAgent("sodx-agent-late");
    expect((await setLifecycle(late, "deprecated", "sodx: born deprecated")).statusCode).toBe(200);
    const refused = await grantAgent(uLifeId, late);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().ruleId).toBe(ruleLife);
    // a user without the anchor side mints the same agent freely (control)
    expect((await grantAgent(uCtlId, late)).statusCode).toBe(201);
  });

  it("agent provider pattern: holding the anchor blocks minting ANY agent of that provider kind", async () => {
    const res = await createRule({
      name: "sodx-provider-vs-connector-p",
      reason: "write access to the p-connector plus any mock-provider agent is the exfil pair",
      sides: [patProvider("mock"), { kind: "connector", objectId: connectorP, mode: "readwrite" }],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((await grantConnector(uProvId, connectorP, "readwrite")).statusCode).toBe(201);
    const refused = await grantAgent(uProvId, agentM);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().conflict.existingSide).toBe("connector 'sodx-connector-p' (readwrite)");
    // an identity without the anchor mints the same mock agent freely — the
    // pattern side alone refuses nobody
    expect((await grantAgent(uCtlId, agentM)).statusCode).toBe(201);
    // retire the broad rule once proven — its concrete anchor kept it scoped,
    // and its job in this suite is done
    const del = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/sod/rules/${res.json().id}` });
    expect(del.statusCode).toBe(200);
  });

  it("connector mode pattern: a readwrite holding on ANY connector conflicts; a read holding does not", async () => {
    const res = await createRule({
      name: "sodx-any-rw-vs-q",
      reason: "any write-mode connector plus the q agent bypasses maker-checker",
      sides: [patMode("readwrite"), selAgent(agentQ)],
    });
    expect(res.statusCode, res.body).toBe(201);
    ruleMode = res.json().id;
    expect(res.json().sides[0].label).toBe("any connector (readwrite)");

    expect((await grantConnector(uModeId, connectorM, "readwrite")).statusCode).toBe(201);
    const refused = await grantAgent(uModeId, agentQ);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().ruleId).toBe(ruleMode);
    // the via names WHICH connector satisfied the pattern
    expect(refused.json().conflict.existingHolding).toBe(
      "a direct connector grant (readwrite) on connector 'sodx-connector-m'",
    );

    // read-mode is NOT readwrite — the same mint proceeds (containment)
    expect((await grantConnector(uModeReadId, connectorM, "read")).statusCode).toBe(201);
    expect((await grantAgent(uModeReadId, agentQ)).statusCode, "read holder must pass").toBe(201);
  });

  it("the override path escalates and executes a pattern-rule refusal through the ONE queue", async () => {
    expect((await grantConnector(uOvrId, connectorM, "readwrite")).statusCode).toBe(201);
    expect((await grantAgent(uOvrId, agentQ)).statusCode).toBe(409); // same pattern refusal
    const esc = await app.inject({
      method: "POST",
      headers: adminAuth,
      url: "/v1/sod/overrides",
      payload: {
        mintKind: "agent",
        payload: { userId: uOvrId, agentId: agentQ },
        approverUserId: approverId,
        justification: "sodx: quarter-end exception",
      },
    });
    expect(esc.statusCode, esc.body).toBe(201);
    expect(esc.json().ruleId).toBe(ruleMode); // server-derived, pattern rule and all
    const decided = await app.inject({
      method: "POST",
      headers: approverAuth,
      url: `/v1/approvals/${esc.json().approvalId}/decide`,
      payload: { decision: "approved" },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    const [grant] = await db
      .select()
      .from(agentGrants)
      .where(and(eq(agentGrants.userId, uOvrId), eq(agentGrants.agentId, agentQ)));
    expect(grant).toBeTruthy();
  });
});

describe("violators, inventory and posture handle both extensions — surfaced, never auto-revoked", () => {
  it("a disable-window violation of the 3-way rule surfaces with EVERY side's holding, and strips nobody", async () => {
    const postureBefore = await posture();
    const off = await app.inject({ method: "PATCH", headers: adminAuth, url: `/v1/sod/rules/${rule3way}`, payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    // with the rule disabled, the completing mint lands — u3 now holds A+B+C
    expect((await grantAgent(u3Id, agentC)).statusCode).toBe(201);
    const on = await app.inject({ method: "PATCH", headers: adminAuth, url: `/v1/sod/rules/${rule3way}`, payload: { enabled: true } });
    expect(on.statusCode).toBe(200);
    const violators = on.json().currentViolators as Array<{ userId: string; holdsA: string; holdsB: string; holds: string[] }>;
    const v = violators.find((x) => x.userId === u3Id);
    expect(v, "the full-set holder must surface").toBeTruthy();
    expect(v!.holds).toHaveLength(3); // one holding per side, all three named
    expect(v!.holdsA).toBe(v!.holds[0]);

    // the rules list, the inventory and posture carry the same computation
    const list = await app.inject({ method: "GET", headers: adminAuth, url: "/v1/sod/rules" });
    const listed = (list.json().rules as Array<{ id: string; sides: unknown[]; currentViolators: Array<{ userId: string }> }>).find(
      (r) => r.id === rule3way,
    )!;
    expect(listed.sides).toHaveLength(3);
    expect(listed.currentViolators.map((x) => x.userId)).toContain(u3Id);
    const inv = await app.inject({ method: "GET", headers: AUTH, url: "/v1/inventory/agents" });
    const invRule = (inv.json().sod.violations as Array<{ ruleId: string; violators: string[] }>).find(
      (x) => x.ruleId === rule3way,
    );
    expect(invRule, "inventory names the N-way rule's violators").toBeTruthy();
    const postureAfter = await posture();
    expect(postureAfter.sod.currentViolations).toBeGreaterThan(postureBefore.sod.currentViolations);

    // and NOTHING was stripped — all three grant rows survive
    const held = await agentGrantCount(u3Id);
    expect(held).toBeGreaterThanOrEqual(3);
  });
});
