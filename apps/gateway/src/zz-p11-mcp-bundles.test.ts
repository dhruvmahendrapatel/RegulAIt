/**
 * ADR-0236 (P11) — governed MCP bundles, end to end through the gateway.
 *
 * Pinned:
 *  - the org setting is off by default; while off every bundle write is refused and audited, and a bundle grant that
 *    already exists confers nothing; turning it on is a `settings_relax` relaxation (an API key is asked for a step-up);
 *  - bundle CRUD is admin-only and every write is audited in the same transaction;
 *  - enforcement at the existing interception point (governedEvaluate and tool visibility): a bundle grants exactly
 *    its tools, never a tool outside it on the same server, and never past the person's own revocation;
 *  - a bundle reaches a user directly, through an assigned role or through a team, and nobody else;
 *  - a change is a new immutable version (compare-and-set); adding a tool is a step-up, removing one is not;
 *  - revoking a grant and archiving a bundle take effect at the next evaluation.
 *  - scope tiers: a grant reaches read tools unless it says otherwise; a dangerous tool needs a dangerous-tier grant
 *    and pauses for the bundle's approver every time, and with no approver it is refused.
 * Scoped to the rows this file creates (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  inArray,
  mcpBundleVersions,
  mcpBundles,
  mcpServers,
  mcpTools,
  ORG_SETTINGS_ID,
  orgSettings,
  revocations,
  roleAssignments,
  roles,
  runMigrations,
  sql,
  teamMembers,
  teams,
  type Db,
} from "@regulait/db";
import { BUNDLE_DANGEROUS_RULE_ID, visibleTools, type ToolRef } from "@regulait/policy-kernel";
import { loadEntitlements } from "./entitlements.js";
import { buildApp } from "./app.js";
import { governedEvaluate } from "./governed-evaluate.js";
import { MCP_BUNDLE_RULE_IDS } from "./mcp-bundles.js";
import { checkSodFootprint } from "./sod.js";
import { randomUUID } from "node:crypto";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `p11-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
const restores: Array<() => Promise<void>> = [];
const bundleIds: string[] = [];
let serverId: string;
let roleId: string;
let teamId: string;
/** direct holder, role holder, team member, and somebody holding nothing */
let direct: string;
let viaRole: string;
let viaTeam: string;
let outsider: string;
let adminKey: Record<string, string>;
let adminId: string;
let tiered: string;
let userKey: Record<string, string>;

const READ: ToolRef = { serverId: "", name: `p11_read_${RUN}`, kind: "read" };
const WRITE: ToolRef = { serverId: "", name: `p11_write_${RUN}`, kind: "write" };
const OUTSIDE: ToolRef = { serverId: "", name: `p11_outside_${RUN}`, kind: "read" };
const tool = (t: ToolRef): ToolRef => ({ ...t, serverId });
const item = (t: ToolRef) => ({ serverId, toolName: t.name });

const req = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const setEnabled = (on: boolean) => db.update(orgSettings).set({ mcpBundlesEnabled: on }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
const lastAudit = async (ruleId: string, objectId?: string) =>
  (await db.select().from(auditLog).where(objectId ? and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)) : eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.seq)).limit(1))[0];
const decide = async (userId: string, t: ToolRef) =>
  (await governedEvaluate(db, userId, serverId, tool(t), undefined, null, null, undefined, undefined, undefined, undefined, { actor: null })).decision;
/** the discovery filter every MCP path applies (the HTTP preview also hides a not-yet-admitted server, so call it directly) */
const visible = async (userId: string) =>
  visibleTools(userId, serverId, [READ, WRITE, OUTSIDE].map(tool), await loadEntitlements(db, userId, serverId))
    .map((t) => t.name)
    .sort();
/** drizzle wraps the database error; the refusal text is on the cause */
const dbError = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
  }
  return "no error";
};

async function mkUser(tag: string, isAdmin = false): Promise<string> {
  const u = await req("POST", "/v1/users", { email: `p11-${tag}-${RUN}@example.com`, displayName: `p11 ${tag} ${RUN}`, ...(isAdmin ? { isAdmin: true } : {}) });
  expect(u.statusCode, u.body).toBe(201);
  return u.json().id as string;
}
async function keyFor(userId: string) {
  return { authorization: `Bearer ${(await req("POST", `/v1/users/${userId}/keys`, { name: "p11" })).json().token}` };
}
async function mkBundle(name: string, items: Array<{ serverId: string; toolName: string }>) {
  const r = await req("POST", "/v1/mcp-bundles", { name: `${name}-${RUN}`, items });
  if (r.statusCode === 201) bundleIds.push(r.json().id);
  return r;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db.select({ on: orgSettings.mcpBundlesEnabled }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => void (await setEnabled(before?.on ?? false)));
  await setEnabled(false);
  app = buildApp(db, { bootstrapToken: BOOT });
  await app.ready();

  const [s] = await db.insert(mcpServers).values({ name: `p11-${RUN}`, url: "http://127.0.0.1:9/" }).returning({ id: mcpServers.id });
  serverId = s!.id;
  await db.insert(mcpTools).values([READ, WRITE, OUTSIDE].map((t) => ({ serverId, name: t.name, kind: t.kind })));

  direct = await mkUser("direct");
  viaRole = await mkUser("role");
  viaTeam = await mkUser("team");
  outsider = await mkUser("outsider");
  userKey = await keyFor(direct);
  adminId = await mkUser("admin", true);
  adminKey = await keyFor(adminId);
  tiered = await mkUser("tiered");

  const [r] = await db.insert(roles).values({ name: `p11-role-${RUN}` }).returning({ id: roles.id });
  roleId = r!.id;
  await db.insert(roleAssignments).values({ userId: viaRole, roleId });
  const [t] = await db.insert(teams).values({ name: `p11-team-${RUN}` }).returning({ id: teams.id });
  teamId = t!.id;
  await db.insert(teamMembers).values({ teamId, userId: viaTeam });
}, 120_000);

afterAll(async () => {
  try {
    if (bundleIds.length > 0) await db.delete(mcpBundles).where(inArray(mcpBundles.id, bundleIds));
    if (serverId) await db.delete(mcpServers).where(eq(mcpServers.id, serverId));
    if (roleId) await db.delete(roles).where(eq(roles.id, roleId));
    if (teamId) await db.delete(teams).where(eq(teams.id, teamId));
    for (const r of restores.reverse()) await r();
  } finally {
    app.server.closeAllConnections();
    await app.close();
  }
});

let bundleId: string;
let directGrantId: string;

describe("MCP bundles: the org setting", () => {
  it("is off by default: a bundle write is refused and audited", async () => {
    const r = await mkBundle("p11-off", [item(READ)]);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "mcp_bundles_disabled" });
    expect((await lastAudit(MCP_BUNDLE_RULE_IDS.disabled))?.effect).toBe("deny");
    expect((await req("GET", "/v1/mcp-bundles")).json().enabled).toBe(false);
  });

  it("turning it on is a relaxation: an API key is asked for a step-up", async () => {
    const asked = await req("PUT", "/v1/org/settings", { mcpBundlesEnabled: true }, adminKey);
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const on = await req("PUT", "/v1/org/settings", { mcpBundlesEnabled: true });
    expect(on.statusCode, on.body).toBe(200);
    const row = (await db.select().from(auditLog).where(eq(auditLog.ruleId, "org-settings-updated")).orderBy(desc(auditLog.seq)).limit(1))[0];
    expect(JSON.stringify(row?.detail)).toContain("mcpBundlesEnabled");
  });
});

describe("MCP bundles: admin CRUD", () => {
  it("is admin-only", async () => {
    expect((await req("GET", "/v1/mcp-bundles", undefined, userKey)).statusCode).toBe(403);
    expect((await req("POST", "/v1/mcp-bundles", { name: `p11-nope-${RUN}`, items: [] }, userKey)).statusCode).toBe(403);
  });

  it("refuses a tool that is not in the inventory (no wildcard, no invented names)", async () => {
    const r = await mkBundle("p11-bad", [item(READ), { serverId, toolName: "*" }]);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json()).toMatchObject({ error: "unknown_tools" });
  });

  it("creates version 1 and audits it in the same transaction", async () => {
    const r = await mkBundle("p11-kit", [item(READ), item(WRITE)]);
    expect(r.statusCode, r.body).toBe(201);
    bundleId = r.json().id;
    expect(r.json()).toMatchObject({ currentVersion: 1 });
    expect((await lastAudit(MCP_BUNDLE_RULE_IDS.created, bundleId))?.effect).toBe("allow");
    const got = (await req("GET", `/v1/mcp-bundles/${bundleId}`)).json();
    expect(got.items.map((i: { toolName: string }) => i.toolName).sort()).toEqual([READ.name, WRITE.name].sort());
    expect((await mkBundle("p11-kit", [])).statusCode).toBe(409);
  });
});

describe("MCP bundles: enforcement is bounded by each person's own entitlement", () => {
  it("before any grant the bundle gives nobody anything", async () => {
    expect((await decide(direct, READ)).effect).toBe("deny");
    expect(await visible(direct)).toEqual([]);
  });

  it("a user grant allows exactly the bundle's tools, never one outside it", async () => {
    const g = await req("POST", `/v1/mcp-bundles/${bundleId}/grants`, { userId: direct, maxTier: "write" });
    expect(g.statusCode, g.body).toBe(201);
    directGrantId = g.json().id;
    expect((await lastAudit(MCP_BUNDLE_RULE_IDS.granted, bundleId))?.effect).toBe("allow");
    const d = await decide(direct, READ);
    expect(d.effect).toBe("allow");
    expect(d.ruleChain.some((t) => t.rule === "bundle-tool-allow-list" && t.outcome === "allow")).toBe(true);
    expect((await decide(direct, WRITE)).effect).toBe("allow");
    expect((await decide(direct, OUTSIDE)).effect).toBe("deny");
    expect(await visible(direct)).toEqual([READ.name, WRITE.name].sort());
    expect((await decide(outsider, READ)).effect).toBe("deny");
    expect((await req("POST", `/v1/mcp-bundles/${bundleId}/grants`, { userId: direct })).statusCode).toBe(409);
  });

  it("the person's own revocation wins over the bundle", async () => {
    const [rev] = await db.insert(revocations).values({ userId: direct, serverId, toolName: WRITE.name }).returning({ id: revocations.id });
    try {
      const d = await decide(direct, WRITE);
      expect(d.effect).toBe("deny");
      expect(d.ruleChain.find((t) => t.rule === "bundle-tool-allow-list")?.outcome).toBe("revoked");
      expect(await visible(direct)).toEqual([READ.name]);
      expect((await decide(direct, READ)).effect).toBe("allow");
    } finally {
      await db.delete(revocations).where(eq(revocations.id, rev!.id));
    }
  });

  it("a role grant reaches the role's holders and a team grant reaches the team's members, and nobody else", async () => {
    expect((await req("POST", `/v1/mcp-bundles/${bundleId}/grants`, { roleId })).statusCode).toBe(201);
    expect((await req("POST", `/v1/mcp-bundles/${bundleId}/grants`, { teamId })).statusCode).toBe(201);
    expect((await decide(viaRole, READ)).effect).toBe("allow");
    expect((await decide(viaTeam, READ)).effect).toBe("allow");
    expect((await decide(outsider, READ)).effect).toBe("deny");
    expect((await req("POST", `/v1/mcp-bundles/${bundleId}/grants`, { userId: direct, teamId })).statusCode).toBe(400);
  });

  it("the override view lists the bundle as the source", async () => {
    const v = (await req("GET", `/v1/users/${viaTeam}/servers/${serverId}/entitlements`)).json();
    expect(v.entitlements.some((e: { source: string; via?: string }) => e.source === "bundle" && e.via === "team")).toBe(true);
  });
});

describe("MCP bundles: versions are governed", () => {
  it("removing a tool is a new version, needs no step-up, and takes effect for every holder", async () => {
    const r = await req("PUT", `/v1/mcp-bundles/${bundleId}/items`, { expectedVersion: 1, items: [item(READ)] }, adminKey);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ currentVersion: 2, added: [], removed: [item(WRITE)] });
    expect((await lastAudit(MCP_BUNDLE_RULE_IDS.versioned, bundleId))?.detail).toMatchObject({ fromVersion: 1, version: 2 });
    expect((await decide(direct, WRITE)).effect).toBe("deny");
    expect((await decide(viaTeam, WRITE)).effect).toBe("deny");
    expect((await decide(viaTeam, READ)).effect).toBe("allow");
  });

  it("a stale expectedVersion is refused", async () => {
    const r = await req("PUT", `/v1/mcp-bundles/${bundleId}/items`, { expectedVersion: 1, items: [] });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "version_conflict", currentVersion: 2 });
  });

  it("adding a tool widens every holder at once, so an API key is asked for a step-up", async () => {
    const asked = await req("PUT", `/v1/mcp-bundles/${bundleId}/items`, { expectedVersion: 2, items: [item(READ), item(OUTSIDE)] }, adminKey);
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect((await decide(viaRole, OUTSIDE)).effect).toBe("deny");
    const ok = await req("PUT", `/v1/mcp-bundles/${bundleId}/items`, { expectedVersion: 2, items: [item(READ), item(OUTSIDE)] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await decide(viaRole, OUTSIDE)).effect).toBe("allow");
    const old = (await req("GET", `/v1/mcp-bundles/${bundleId}/versions/1`)).json();
    expect(old.items.map((i: { toolName: string }) => i.toolName).sort()).toEqual([READ.name, WRITE.name].sort());
  });

  it("a version row is append-only in the database", async () => {
    expect(await dbError(db.update(mcpBundleVersions).set({ version: 99 }).where(eq(mcpBundleVersions.bundleId, bundleId)))).toMatch(/append-only/);
    expect(await dbError(db.execute(sql`truncate table mcp_bundle_version_items`))).toMatch(/TRUNCATE refused/);
  });
});

describe("MCP bundles: revocation", () => {
  it("revoking a grant takes effect at the next evaluation and is audited", async () => {
    const r = await req("DELETE", `/v1/mcp-bundles/${bundleId}/grants/${directGrantId}`);
    expect(r.statusCode, r.body).toBe(204);
    expect((await lastAudit(MCP_BUNDLE_RULE_IDS.grantRemoved, bundleId))?.detail).toMatchObject({ subjectKind: "user", subjectId: direct });
    expect((await decide(direct, READ)).effect).toBe("deny");
    expect((await req("DELETE", `/v1/mcp-bundles/${bundleId}/grants/${directGrantId}`)).statusCode).toBe(404);
  });

  it("switching the feature off makes every bundle confer nothing", async () => {
    await setEnabled(false);
    try {
      expect((await decide(viaTeam, READ)).effect).toBe("deny");
      expect(await visible(viaTeam)).toEqual([]);
    } finally {
      await setEnabled(true);
    }
    expect((await decide(viaTeam, READ)).effect).toBe("allow");
  });

  it("archiving the bundle revokes it for every holder; an archived bundle cannot be granted or changed", async () => {
    const r = await req("DELETE", `/v1/mcp-bundles/${bundleId}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().archivedAt).not.toBeNull();
    expect((await lastAudit(MCP_BUNDLE_RULE_IDS.archived, bundleId))?.effect).toBe("allow");
    expect((await decide(viaTeam, READ)).effect).toBe("deny");
    expect((await decide(viaRole, READ)).effect).toBe("deny");
    expect((await req("POST", `/v1/mcp-bundles/${bundleId}/grants`, { userId: direct })).statusCode).toBe(409);
    expect((await req("PUT", `/v1/mcp-bundles/${bundleId}/items`, { expectedVersion: 3, items: [] })).statusCode).toBe(409);
  });
});

describe("MCP bundles: scope tiers (read < write < dangerous)", () => {
  let tiersId: string;
  let writeToolId: string;
  let grantId: string;

  it("a grant reaches read tools only, unless it names a higher tier", async () => {
    const r = await mkBundle("p11-tiers", [item(READ), item(WRITE)]);
    expect(r.statusCode, r.body).toBe(201);
    tiersId = r.json().id;
    const g = await req("POST", `/v1/mcp-bundles/${tiersId}/grants`, { userId: tiered });
    expect(g.statusCode, g.body).toBe(201);
    expect(g.json().maxTier).toBe("read");
    grantId = g.json().id;
    expect((await decide(tiered, READ)).effect).toBe("allow");
    expect((await decide(tiered, WRITE)).effect).toBe("deny");
    expect(await visible(tiered)).toEqual([READ.name]);
  });

  it("flagging a tool dangerous is audited and needs no step-up; a write-tier grant then no longer reaches it", async () => {
    const [t] = await db.select({ id: mcpTools.id }).from(mcpTools).where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, WRITE.name)));
    writeToolId = t!.id;
    const f = await req("PUT", `/v1/mcp-tools/${writeToolId}/dangerous`, { dangerous: true }, adminKey);
    expect(f.statusCode, f.body).toBe(200);
    expect(f.json().dangerous).toBe(true);
    expect((await lastAudit(MCP_BUNDLE_RULE_IDS.toolTierChanged, serverId))?.detail).toMatchObject({ dangerous: true });
    expect((await req("DELETE", `/v1/mcp-bundles/${tiersId}/grants/${grantId}`)).statusCode).toBe(204);
    const g = await req("POST", `/v1/mcp-bundles/${tiersId}/grants`, { userId: tiered, maxTier: "write" });
    expect(g.statusCode, g.body).toBe(201);
    grantId = g.json().id;
    expect((await decide(tiered, WRITE)).effect).toBe("deny");
  });

  it("a dangerous-tier grant needs the bundle to name an approver, and every call then pauses for them", async () => {
    expect((await req("DELETE", `/v1/mcp-bundles/${tiersId}/grants/${grantId}`)).statusCode).toBe(204);
    const refused = await req("POST", `/v1/mcp-bundles/${tiersId}/grants`, { userId: tiered, maxTier: "dangerous" });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json()).toMatchObject({ error: "approver_required" });
    expect((await req("PATCH", `/v1/mcp-bundles/${tiersId}`, { approverUserId: outsider.replace(/./g, "0") })).statusCode).toBe(400);
    const p = await req("PATCH", `/v1/mcp-bundles/${tiersId}`, { approverUserId: adminId });
    expect(p.statusCode, p.body).toBe(200);
    expect((await lastAudit(MCP_BUNDLE_RULE_IDS.updated, tiersId))?.detail).toMatchObject({ approverAfter: adminId });
    const g = await req("POST", `/v1/mcp-bundles/${tiersId}/grants`, { userId: tiered, maxTier: "dangerous" });
    expect(g.statusCode, g.body).toBe(201);
    const d = await decide(tiered, WRITE);
    expect(d.effect).toBe("require_approval");
    expect(d.ruleId).toBe(BUNDLE_DANGEROUS_RULE_ID);
    expect(d.approverUserId).toBe(adminId);
    expect(await visible(tiered)).toEqual([READ.name, WRITE.name].sort());
  });

  it("with the approver removed, a dangerous call is refused (fail closed)", async () => {
    expect((await req("PATCH", `/v1/mcp-bundles/${tiersId}`, { approverUserId: null })).statusCode).toBe(200);
    const d = await decide(tiered, WRITE);
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(BUNDLE_DANGEROUS_RULE_ID);
  });

  it("naming an approver is a relaxation (step-up), and an approver can never sign off their own dangerous call", async () => {
    const asked = await req("PATCH", `/v1/mcp-bundles/${tiersId}`, { approverUserId: adminId }, adminKey);
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    // the holder is named approver of their own dangerous tool: four eyes, so the call fails closed
    expect((await req("PATCH", `/v1/mcp-bundles/${tiersId}`, { approverUserId: tiered })).statusCode).toBe(200);
    const own = await decide(tiered, WRITE);
    expect(own.effect).toBe("deny");
    expect(own.ruleId).toBe(BUNDLE_DANGEROUS_RULE_ID);
    expect(own.reason).toContain("different person");
    // another approver: the call pauses for them again
    expect((await req("PATCH", `/v1/mcp-bundles/${tiersId}`, { approverUserId: adminId })).statusCode).toBe(200);
    const held = await decide(tiered, WRITE);
    expect(held.effect).toBe("require_approval");
    expect(held.approverUserId).toBe(adminId);
  });

  it("clearing the dangerous flag is a relaxation: an API key is asked for a step-up", async () => {
    const asked = await req("PUT", `/v1/mcp-tools/${writeToolId}/dangerous`, { dangerous: false }, adminKey);
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const ok = await req("PUT", `/v1/mcp-tools/${writeToolId}/dangerous`, { dangerous: false });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await decide(tiered, WRITE)).effect).toBe("allow");
  });
});

describe("MCP bundles: the SoD gate is one batched check (review of #697)", () => {
  let ruleId: string;

  it("a bundle that would confer both sides of a rule by itself is refused, for a team as for a user", async () => {
    const rule = await req("POST", "/v1/sod/rules", {
      name: `p11-sod-${RUN}`,
      reason: "reading and writing the same ledger is maker-checker",
      a: { kind: "mcp_tool", objectId: serverId, toolName: READ.name },
      b: { kind: "mcp_tool", objectId: serverId, toolName: WRITE.name },
    });
    expect(rule.statusCode, rule.body).toBe(201);
    ruleId = rule.json().id;
    const r = await mkBundle("p11-sod", [item(READ), item(WRITE)]);
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    const toUser = await req("POST", `/v1/mcp-bundles/${id}/grants`, { userId: outsider });
    expect(toUser.statusCode, toUser.body).toBe(409);
    expect(toUser.json()).toMatchObject({ error: "sod_conflict", ruleId });
    const toTeam = await req("POST", `/v1/mcp-bundles/${id}/grants`, { teamId });
    expect(toTeam.statusCode, toTeam.body).toBe(409);
    const [refusal] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "sod-conflict-refused"), eq(auditLog.objectId, ruleId)))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect(refusal?.detail).toMatchObject({ mintKind: "mcp_bundle", mint: { bundleId: id, toolCount: 2 } });
  });

  it("the number of queries does not grow with the tools or the people a grant reaches", async () => {
    const counting = (n: { calls: number }) =>
      new Proxy(db, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          if (typeof v === "function" && ["select", "selectDistinct", "execute", "insert", "update", "delete"].includes(String(prop))) {
            return (...args: unknown[]) => {
              n.calls++;
              return (v as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return v;
        },
      }) as Db;
    const caps = (names: string[]) => names.map((toolName) => ({ kind: "mcp_tool" as const, objectId: serverId, toolName, mode: null }));
    const small = { calls: 0 };
    await checkSodFootprint(counting(small), { capabilities: caps([READ.name]), userIds: [outsider] });
    const big = { calls: 0 };
    const manyTools = Array.from({ length: 200 }, (_, i) => `p11_many_${i}_${RUN}`);
    const manyPeople = Array.from({ length: 5_000 }, () => randomUUID());
    await checkSodFootprint(counting(big), { capabilities: caps([READ.name, ...manyTools]), userIds: [outsider, ...manyPeople] });
    expect(small.calls).toBeGreaterThan(0);
    expect(big.calls).toBe(small.calls);
  });

  afterAll(async () => {
    if (ruleId) await req("DELETE", `/v1/sod/rules/${ruleId}`);
  });
});
