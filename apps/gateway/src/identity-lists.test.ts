/**
 * ADR-0226 P2 batch B — the identity-and-access lists under the shared list contract, and their Excel exports:
 *
 *  - every row exactly once across pages, on the default sort (keyset where it is a date) and on another sort (offset);
 *  - the sort allow-list: an unknown column is a 400;
 *  - `count=exact` is the true total;
 *  - the export: the requested columns in order with screen labels, every matching row, audited, under the list's own
 *    authorisation (admin-only lists refuse a member; virtual keys show a member only their own);
 *  - no secret column: a key's token, hash or prefix is never a column, and asking for one is a 400;
 *  - callers that send none of the contract params get the response they always got.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import {
  agentRevocations,
  agents,
  auditLog,
  authSessions,
  chatIdentityLinks,
  chatopsConnections,
  connectorRevocations,
  connectors,
  createDb,
  desc,
  eq,
  federatedLinkRequests,
  licenseVerifications,
  mcpServers,
  oidcProviders,
  revocations,
  roleAssignments,
  roles,
  runMigrations,
  teamMembers,
  teams,
  usageEvents,
  users,
  virtualKeys,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `il-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const N = 23;

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreMfa: () => Promise<void>;
let restoreStepUp: () => Promise<void>;
const who = {} as Record<"a" | "b", { id: string; auth: { authorization: string } }>;
const seeded: Record<string, string[]> = {};
let roleId = "";
let keyA = "";
let chatConnectionId = "";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = (url: string, headers: Record<string, string> = AUTH) => app.inject({ method: "GET", url, headers });
const hex = () => randomBytes(16).toString("hex");
const at = (i: number) => new Date(Date.parse("2026-02-01T00:00:00Z") + (i < 3 ? 0 : i) * 60_000 + 0.5);

function readXlsx(buf: Buffer): Array<Array<string | number | null>> {
  const files = unzipSync(new Uint8Array(buf));
  const shared = files["xl/sharedStrings.xml"] ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>(.*?)<\/si>/gs)].map((m) => [...m[1]!.matchAll(/<t(?:\s[^>]*)?>(.*?)<\/t>/gs)].map((t) => t[1]!).join("").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")) : [];
  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
  return [...sheet.matchAll(/<row[^>]*>(.*?)<\/row>/gs)].map((row) => {
    const out: Array<string | number | null> = [];
    for (const c of row[1]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
      const col = c[1]!.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const v = /<v>(.*?)<\/v>/s.exec(c[3] ?? "")?.[1];
      while (out.length < col) out.push(null);
      out[col] = v === undefined ? null : /t="s"/.test(c[2]!) ? shared[Number(v)]! : Number(v);
    }
    return out;
  });
}

/** every page of a contract read, following whichever of nextCursor and nextOffset the server answers */
async function walk(url: string, headers: Record<string, string> = AUTH): Promise<Json[]> {
  const out: Json[] = [];
  let next = "";
  for (let guard = 0; guard < 100; guard++) {
    const res = await get(`${url}${next}`, headers);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Json;
    out.push(...body.items);
    if (body.nextCursor) next = `&cursor=${encodeURIComponent(body.nextCursor)}`;
    else if (body.nextOffset !== null) next = `&offset=${body.nextOffset}`;
    else return out;
  }
  throw new Error("paging did not end");
}

interface ListCase {
  name: string;
  /** the list route with its filters, ending in `?…` */
  url: string;
  ids: () => string[];
  idOf?: (r: Json) => string;
  /** a non-default sort column */
  other: string;
  exportUrl: string;
  columns: string;
  labels: string[];
  legacyKey: string;
  /** a member is refused (admin-only list) */
  adminOnly: boolean;
}

const CASES: ListCase[] = [
  { name: "sessions", url: "", ids: () => seeded.sessions!, other: "ip", exportUrl: "", columns: "status,created,device", labels: ["Status", "Signed in", "Device"], legacyKey: "sessions", adminOnly: true },
  { name: "MCP revocations", url: "", ids: () => seeded.mcp!, other: "server", exportUrl: "", columns: "server,tool,scope", labels: ["Server", "Tool", "Scope"], legacyKey: "revocations", adminOnly: true },
  { name: "agent revocations", url: "", ids: () => seeded.agentRevs!, other: "agent", exportUrl: "", columns: "agent,reason", labels: ["Agent", "Reason"], legacyKey: "revocations", adminOnly: true },
  { name: "connector revocations", url: "", ids: () => seeded.connRevs!, other: "connector", exportUrl: "", columns: "connector,scope,created", labels: ["Connector", "Scope", "Created"], legacyKey: "revocations", adminOnly: true },
  { name: "API keys", url: "", ids: () => seeded.keys!, other: "name", exportUrl: "", columns: "name,user,status", labels: ["Name", "User", "Status"], legacyKey: "keys", adminOnly: true },
  { name: "role holders", url: "", ids: () => seeded.holders!, other: "email", exportUrl: "", columns: "email,account,origin", labels: ["Email", "Account", "Held through"], legacyKey: "assignments", adminOnly: true },
  { name: "teams", url: "", ids: () => seeded.teams!, other: "memberCount", exportUrl: "", columns: "name,memberCount,members", labels: ["Team", "Members", "Member names"], legacyKey: "teams", adminOnly: true },
  { name: "link requests", url: "", ids: () => seeded.links!, other: "email", exportUrl: "", columns: "account,email,status", labels: ["Existing account", "Asserted email", "Status"], legacyKey: "requests", adminOnly: true },
  { name: "chat identity links", url: "", ids: () => seeded.chat!, other: "chatuser", exportUrl: "", columns: "chatuser,verified,workspace", labels: ["Chat identity", "Email verification", "Workspace"], legacyKey: "links", adminOnly: true },
  { name: "agents", url: "", ids: () => seeded.agents!, other: "tier", exportUrl: "", columns: "name,tier,enabled,prompt,price", labels: ["Name", "Tier", "Status", "System prompt", "$/MTok in → out"], legacyKey: "agents", adminOnly: true },
  { name: "licence verifications", url: "", ids: () => seeded.verifications!, other: "rule", exportUrl: "", columns: "at,ok,rule", labels: ["When", "Status", "Rule"], legacyKey: "verifications", adminOnly: true },
  { name: "workload identities", url: "", ids: () => seeded.identities!, other: "identifier", exportUrl: "", columns: "identifier,status,stewards", labels: ["Identifier", "Status", "Stewards"], legacyKey: "items", adminOnly: true },
  { name: "credentials", url: "", ids: () => seeded.credentials!, other: "name", exportUrl: "", columns: "name,type,flags", labels: ["Credential", "Type", "Flags"], legacyKey: "credentials", adminOnly: true },
  { name: "virtual keys", url: "", ids: () => seeded.vks!, other: "spent", exportUrl: "", columns: "name,state,remaining", labels: ["Key", "State", "Remaining"], legacyKey: "keys", adminOnly: false },
  { name: "virtual key usage", url: "", ids: () => seeded.usage!, other: "cost", exportUrl: "", columns: "at,cost,model", labels: ["When", "Cost", "Model"], legacyKey: "events", adminOnly: false },
];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreStepUp = await relaxStepUpForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  for (const k of ["a", "b"] as const) {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `il-${k}-${RUN}@example.com`, displayName: `il ${k} ${RUN}` } });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const key = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: `il-${RUN}-seed` } });
    expect(key.statusCode, key.body).toBe(201);
    who[k] = { id, auth: { authorization: `Bearer ${key.json().token}` } };
  }
  const a = who.a.id;
  const range = Array.from({ length: N }, (_, i) => i);
  const name = (p: string, i: number) => `il-${RUN}-${p}-${String((i * 7) % N).padStart(2, "0")}`;

  seeded.sessions = (await db.insert(authSessions).values(range.map((i) => ({ tokenHash: hex(), userId: a, origin: "password" as const, createdAt: at(i), expiresAt: new Date(Date.now() + (i % 3 ? 3_600_000 : -3_600_000)), idleExpiresAt: new Date(Date.now() + 3_600_000), idleMinutes: 30, ip: `10.0.0.${i}`, userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0", revokedAt: i % 5 === 0 ? new Date() : null }))).returning({ id: authSessions.id })).map((r) => r.id);

  const servers = await db.insert(mcpServers).values(range.map((i) => ({ name: name("srv", i), url: `https://mcp.example.test/${RUN}/${i}` }))).returning({ id: mcpServers.id });
  seeded.mcp = (await db.insert(revocations).values(servers.map((s, i) => ({ userId: a, serverId: s.id, toolName: i % 2 ? null : `tool-${i}`, createdAt: at(i) }))).returning({ id: revocations.id })).map((r) => r.id);

  const agentRows = await db.insert(agents).values(range.map((i) => ({ name: name("agent", i), provider: "mock", tier: (i % 3) + 1, model: `m-${i}`, systemPrompt: i % 2 ? "be brief" : null, createdAt: at(i) }))).returning({ id: agents.id });
  seeded.agents = agentRows.map((r) => r.id);
  seeded.agentRevs = (await db.insert(agentRevocations).values(agentRows.map((g, i) => ({ userId: a, agentId: g.id, reason: i % 2 ? `why ${i}` : null, createdAt: at(i) }))).returning({ id: agentRevocations.id })).map((r) => r.id);

  const connRows = await db.insert(connectors).values(range.map((i) => ({ name: name("conn", i), kind: "crm" }))).returning({ id: connectors.id });
  seeded.connRevs = (await db.insert(connectorRevocations).values(connRows.map((c, i) => ({ userId: a, connectorId: c.id, scope: i % 2 ? ("read_only" as const) : ("full" as const), createdAt: at(i) }))).returning({ id: connectorRevocations.id })).map((r) => r.id);

  seeded.keys = [];
  for (const i of range) {
    const k = await app.inject({ method: "POST", url: `/v1/users/${a}/keys`, headers: AUTH, payload: { name: name("key", i) } });
    expect(k.statusCode, k.body).toBe(201);
    seeded.keys.push(k.json().id);
  }

  const people = await db.insert(users).values(range.map((i) => ({ email: `il-h${i}-${RUN}@example.com`, displayName: name("person", i), disabledAt: i % 4 ? null : new Date() }))).returning({ id: users.id });
  [{ id: roleId }] = await db.insert(roles).values({ name: `il-role-${RUN}` }).returning({ id: roles.id }) as [{ id: string }];
  seeded.holders = (await db.insert(roleAssignments).values(people.map((p, i) => ({ userId: p.id, roleId, origin: i % 3 ? ("direct" as const) : ("group" as const), createdAt: at(i) }))).returning({ id: roleAssignments.id })).map((r) => r.id);

  const teamRows = await db.insert(teams).values(range.map((i) => ({ name: name("team", i), createdAt: at(i) }))).returning({ id: teams.id });
  seeded.teams = teamRows.map((t) => t.id);
  await db.insert(teamMembers).values(teamRows.flatMap((t, i) => people.slice(0, i % 4).map((p) => ({ teamId: t.id, userId: p.id }))));

  const [idp] = await db.insert(oidcProviders).values({ name: `il-idp-${RUN}`, issuerUrl: `https://idp.example.test/${RUN}`, clientId: "c", clientSecretCiphertext: "x" }).returning({ id: oidcProviders.id });
  seeded.links = (await db.insert(federatedLinkRequests).values(people.map((p, i) => ({ userId: p.id, oidcProviderId: idp!.id, issuer: `https://idp.example.test/${RUN}`, subject: `sub-${i}`, email: `il-asserted-${RUN}-${(i * 7) % N}@example.com`, status: "pending" as const, expiresAt: new Date(Date.now() + 86_400_000), createdAt: at(i) }))).returning({ id: federatedLinkRequests.id })).map((r) => r.id);

  const [conn] = await db.insert(chatopsConnections).values({ name: `il-chat-${RUN}`, provider: "resend", connectorId: connRows[0]!.id, defaultChannel: "named-approvers" }).returning({ id: chatopsConnections.id });
  chatConnectionId = conn!.id;
  seeded.chat = (await db.insert(chatIdentityLinks).values(people.map((p, i) => ({ connectionId: conn!.id, chatUserId: `U${RUN}${String((i * 7) % N).padStart(2, "0")}`, chatUserEmail: `il-h${i}-${RUN}@example.com`, userId: p.id, emailVerifiedSource: i % 2 ? ("admin_asserted" as const) : ("idp" as const), createdAt: at(i) }))).returning({ id: chatIdentityLinks.id })).map((r) => r.id);

  seeded.verifications = (await db.insert(licenseVerifications).values(range.map((i) => ({ at: at(i), trigger: "manual" as const, ok: i % 3 !== 0, state: "absent" as const, ruleId: `il-${RUN}-rule-${(i * 7) % N}`, reason: "test" }))).returning({ id: licenseVerifications.id })).map((r) => r.id);

  seeded.identities = [];
  for (const i of range) {
    const r = await app.inject({ method: "POST", url: "/v1/workload-identities", headers: AUTH, payload: { kind: "agent", agentId: agentRows[i]!.id, sponsorUserIds: [a], environments: ["dev"] } });
    expect(r.statusCode, r.body).toBe(201);
    seeded.identities.push((r.json().id ?? r.json().identity?.id) as string);
  }

  seeded.vks = [];
  for (const i of range) {
    const r = await app.inject({ method: "POST", url: "/v1/virtual-keys", headers: i < 20 ? AUTH : who.b.auth, payload: { name: name("vk", i), ...(i < 20 ? { userId: a } : {}), budgetUsd: i } });
    expect(r.statusCode, r.body).toBe(201);
    seeded.vks.push(r.json().id);
  }
  keyA = seeded.vks[0]!;
  await db.update(virtualKeys).set({ spentUsd: 0.5 }).where(eq(virtualKeys.id, keyA));
  seeded.usage = (await db.insert(usageEvents).values(range.map((i) => ({ at: at(i), userId: a, virtualKeyId: keyA, provider: "mock", model: `m-${i % 4}`, inputTokens: i, outputTokens: i * 2, costUsd: i % 4 ? i / 100 : null }))).returning({ id: usageEvents.id })).map((r) => r.id);

  // the URLs, now the ids exist
  const set = (n: string, url: string, exportUrl: string) => Object.assign(CASES.find((c) => c.name === n)!, { url, exportUrl });
  set("sessions", `/v1/users/${a}/sessions?`, `/v1/users/${a}/sessions/export.xlsx?`);
  set("MCP revocations", `/v1/revocations?userId=${a}&`, `/v1/revocations/export.xlsx?userId=${a}&`);
  set("agent revocations", `/v1/users/${a}/revocations/agents?`, `/v1/users/${a}/revocations/agents/export.xlsx?`);
  set("connector revocations", `/v1/users/${a}/revocations/connectors?`, `/v1/users/${a}/revocations/connectors/export.xlsx?`);
  set("API keys", `/v1/keys?userId=${a}&`, `/v1/keys/export.xlsx?userId=${a}&`);
  set("role holders", `/v1/roles/${roleId}/assignments?`, `/v1/roles/${roleId}/assignments/export.xlsx?`);
  set("teams", `/v1/teams?q=il-${RUN}-team&`, `/v1/teams/export.xlsx?q=il-${RUN}-team&`);
  set("link requests", `/v1/auth/link-requests?status=all&`, `/v1/auth/link-requests/export.xlsx?status=all&`);
  set("chat identity links", `/v1/chatops/identity-links?connectionId=${conn!.id}&`, `/v1/chatops/identity-links/export.xlsx?connectionId=${conn!.id}&`);
  set("agents", `/v1/agents?q=il-${RUN}-agent&`, `/v1/agents/export.xlsx?q=il-${RUN}-agent&`);
  set("licence verifications", "/v1/licenses/verifications?", "/v1/licenses/verifications/export.xlsx?");
  set("workload identities", `/v1/workload-identities?sponsorUserId=${a}&`, `/v1/workload-identities/export.xlsx?sponsorUserId=${a}&`);
  set("credentials", "/v1/admin/credentials?type=api_key&", "/v1/admin/credentials/export.xlsx?type=api_key&");
  set("virtual keys", "/v1/virtual-keys?", "/v1/virtual-keys/export.xlsx?");
  set("virtual key usage", `/v1/virtual-keys/${keyA}/usage?`, `/v1/virtual-keys/${keyA}/usage/export.xlsx?`);
  // the credential inventory spans every API key: its seeded set is the ones this suite made
  seeded.credentials = seeded.keys.map((id) => `api_key:${id}`);
}, 180_000);

afterAll(async () => {
  // a ChatOps workspace is fleet-wide state other suites post through: take it (and its links) away again
  if (chatConnectionId) await db.delete(chatopsConnections).where(eq(chatopsConnections.id, chatConnectionId));
  await restoreStepUp?.();
  await restoreMfa?.();
});

const latestExportAudit = async () =>
  (await db.select().from(auditLog).where(eq(auditLog.ruleId, "list-export-xlsx")).orderBy(desc(auditLog.at)).limit(1))[0]!;

describe.each(CASES)("ADR-0226: $name", (c) => {
  const idOf = (r: Json) => (c.idOf ? c.idOf(r) : (r.id as string));

  it("pages every row exactly once on the default sort and on another, with a true total", async () => {
    for (const sort of ["", `&sort=${c.other}&dir=asc`, `&sort=${c.other}&dir=desc`]) {
      const items = await walk(`${c.url}limit=10&count=exact${sort}`);
      const ids = items.map(idOf);
      expect(new Set(ids).size, `duplicates on ${sort || "the default sort"}`).toBe(ids.length);
      for (const id of c.ids()) expect(ids, `${id} missing on ${sort || "the default sort"}`).toContain(id);
      const first = (await get(`${c.url}limit=10&count=exact${sort}`)).json();
      expect(first.total).toBe(ids.length);
      expect(first.items).toHaveLength(Math.min(10, ids.length));
      expect(first.items[0]).not.toHaveProperty("_cursorAt");
    }
  });

  it("refuses an unknown or injected sort column, and an unknown filter", async () => {
    for (const q of ["sort=nope", `sort=${encodeURIComponent("name; drop table users")}`, "sort=__proto__", "limit=25&sort=created"]) {
      expect((await get(`${c.url}limit=10&${q}`)).statusCode, q).toBe(400);
    }
    expect((await get(`${c.url}limit=10&count=exact&bogus=1`)).statusCode).toBe(400);
  });

  it("exports the requested columns in order, every matching row, audited", async () => {
    const total = (await get(`${c.url}limit=10&count=exact`)).json().total as number;
    const res = await get(`${c.exportUrl}columns=${c.columns}&sort=${c.other}&dir=asc`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    const rows = readXlsx(res.rawPayload);
    expect(rows[0]).toEqual(c.labels);
    expect(rows).toHaveLength(1 + total);
    const audit = await latestExportAudit();
    expect(audit.objectType).toBe("audit_export");
    expect(audit.detail).toMatchObject({ columns: c.columns.split(","), rows: total, sort: c.other, dir: "asc" });
    // a column the list does not have (a secret above all) is a 400
    for (const bad of ["tokenHash", "token", "secret", "keyCiphertext", "passwordHash"]) {
      expect((await get(`${c.exportUrl}columns=${c.columns},${bad}`)).statusCode, bad).toBe(400);
    }
  });

  it("keeps the list's own authorisation for the page and the export", async () => {
    if (c.adminOnly) {
      expect((await get(`${c.url}limit=10&count=exact`, who.b.auth)).statusCode).toBe(403);
      expect((await get(`${c.exportUrl}columns=${c.columns}`, who.b.auth)).statusCode).toBe(403);
    }
  });

  it("answers its old shape when none of the contract params is sent", async () => {
    const res = await get(c.url.replace(/[?&]$/, ""));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toHaveProperty(c.legacyKey);
    expect(res.json()).not.toHaveProperty("totalIsEstimate");
  });
});

describe("ADR-0226: list-specific rules", () => {
  it("virtual keys: a member pages and exports only their own keys; another's usage is a 404", async () => {
    const mine = await walk("/v1/virtual-keys?limit=10&count=exact", who.b.auth);
    expect(new Set(mine.map((k) => k.id))).toEqual(new Set(seeded.vks!.slice(20)));
    expect(mine.every((k) => !("tokenHash" in k) && !("token" in k))).toBe(true);
    const ex = readXlsx((await get("/v1/virtual-keys/export.xlsx?columns=name", who.b.auth)).rawPayload);
    expect(ex).toHaveLength(1 + 3);
    expect((await get(`/v1/virtual-keys/${keyA}/usage?limit=10&count=exact`, who.b.auth)).statusCode).toBe(404);
    expect((await get(`/v1/virtual-keys/${keyA}/usage/export.xlsx?columns=at`, who.b.auth)).statusCode).toBe(404);
  });

  it("virtual key usage: newest first by default, with the legacy totals unchanged", async () => {
    const items = await walk(`/v1/virtual-keys/${keyA}/usage?limit=10&count=exact`);
    const times = items.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    const legacy = (await get(`/v1/virtual-keys/${keyA}/usage`)).json();
    expect(legacy).toMatchObject({ events: N, unpricedEvents: 6 });
    expect(Object.keys(legacy).sort()).toEqual(["events", "key", "meteredUsd", "unpricedEvents"]);
  });

  it("API keys: the state sort and filter, and never a token or hash on the row", async () => {
    const items = await walk(`/v1/keys?userId=${who.a.id}&limit=50&sort=status&dir=desc`);
    expect(items.every((k) => !("tokenHash" in k) && k.state === "active" && k.userEmail === `il-a-${RUN}@example.com`)).toBe(true);
    const revoked = await app.inject({ method: "POST", url: `/v1/keys/${seeded.keys![0]}/revoke`, headers: AUTH, payload: {} });
    expect(revoked.statusCode).toBe(200);
    const only = (await get(`/v1/keys?userId=${who.a.id}&limit=10&count=exact&state=revoked`)).json();
    expect(only).toMatchObject({ total: 1 });
    expect(only.items[0].id).toBe(seeded.keys![0]);
    const first = (await get(`/v1/keys?userId=${who.a.id}&limit=10&sort=status&dir=desc`)).json();
    expect(first.items[0].state).toBe("revoked");
  });

  it("sessions: the status filter counts live ones on the server, and each page read is audited", async () => {
    const live = (await get(`/v1/users/${who.a.id}/sessions?limit=10&count=exact&status=live`)).json();
    const want = Array.from({ length: N }, (_, i) => i).filter((i) => i % 3 !== 0 && i % 5 !== 0).length;
    expect(live.total).toBe(want);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "session-list-viewed")).orderBy(desc(auditLog.at)).limit(1);
    expect(row?.detail).toMatchObject({ paged: true });
    expect(live.items.every((s: Json) => !("tokenHash" in s) && typeof s.deviceLabel === "string")).toBe(true);
  });

  it("teams: members sort by count and each team carries its members", async () => {
    const items = await walk(`/v1/teams?q=il-${RUN}-team&limit=10&sort=memberCount&dir=desc`);
    const counts = items.map((t) => t.memberCount as number);
    expect(counts).toEqual([...counts].sort((x, y) => y - x));
    expect(items.map((t) => [t.memberCount, t.members.length])).toEqual(items.map((t) => [t.memberCount, t.memberCount]));
  });

  it("agents: the system prompt is exported by its length only, and a deep link narrows to one agent", async () => {
    const rows = readXlsx((await get(`/v1/agents/export.xlsx?q=il-${RUN}-agent&columns=prompt&sort=name`)).rawPayload);
    expect(rows.slice(1).flat().every((v) => v === null || /^set \(\d+ chars\)$/.test(String(v)))).toBe(true);
    const one = (await get(`/v1/agents?id=${seeded.agents![4]}&limit=10&count=exact`)).json();
    expect(one).toMatchObject({ total: 1 });
    expect(one.items[0]).toHaveProperty("stewardName");
  });

  it("credentials: the legacy limit/offset read is unchanged; the contract keeps the inventory summary", async () => {
    const legacy = (await get("/v1/admin/credentials?limit=5&offset=5&type=api_key")).json();
    expect(legacy.page).toMatchObject({ limit: 5, offset: 5 });
    expect(legacy.credentials).toHaveLength(5);
    const page = (await get("/v1/admin/credentials?type=api_key&limit=10&count=exact&sort=flags&dir=desc")).json();
    expect(page).toHaveProperty("counts");
    expect(page).toHaveProperty("flagLabels");
    expect(page).not.toHaveProperty("credentials");
    expect((await get("/v1/admin/credentials?limit=10&sort=name&cursor=abc")).statusCode).toBe(400);
  });

  it("workload identities: the legacy id cursor still pages the old way", async () => {
    const first = (await get(`/v1/workload-identities?sponsorUserId=${who.a.id}&limit=5`)).json();
    expect(Object.keys(first).sort()).toEqual(["items", "nextCursor"]);
    const next = (await get(`/v1/workload-identities?sponsorUserId=${who.a.id}&limit=5&cursor=${first.nextCursor}`)).json();
    expect(next.items[0].id > first.items[4].id).toBe(true);
  });

  it("link requests: pending by default, past the old 200-row cap with an honest total", async () => {
    const pending = (await get("/v1/auth/link-requests?limit=10&count=exact")).json();
    expect(pending.total).toBeGreaterThanOrEqual(N);
    expect(pending.items.every((r: Json) => r.status === "pending" && !("proofTokenHash" in r))).toBe(true);
  });
});
