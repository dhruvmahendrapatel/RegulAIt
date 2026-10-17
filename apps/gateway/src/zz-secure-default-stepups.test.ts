/**
 * Secure-by-default server gaps (ADR-0180, ADR-0186 A): three relaxations the web UI confirmed but the server
 * did not enforce now need a `settings_relax` step-up, bound to `{op, ...}` facts, and leave an audited
 * relaxation record; tightening needs nothing. Plus the model-card writers' refusal of a presentation-scrub
 * marker (ADR-0115).
 *
 *  - MCP registry: enabling (create or update), allowing private ranges (create or update);
 *  - MCP server: allowing private ranges (create or update);
 *  - agent expected served model: setting or changing it (PUT, and at agent create);
 *  - egress allow entry: adding one (ADR-0034 owner amendment 2026-10-16) or turning an opt-in on;
 *  - PATCH and POST /v1/mrm/cards: a `[redacted:…]` marker in any text field → 400 `redacted_text_refused`.
 *
 * Under the strict step-up values; global state is put back strict in afterAll (M-068), and the admin's
 * passkey is removed (B4S-06).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import {
  agents,
  and,
  auditLog,
  authSessions,
  createDb,
  desc,
  eq,
  inArray,
  mcpRegistries,
  mcpRegistryEntries,
  mcpServers,
  egressAllowHosts,
  modelCards,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  stepUpGrants,
  webauthnChallenges,
  webauthnCredentials,
  type Db,
} from "@regulait/db";
import { scrubAuditText, STEP_UP_HEADER } from "@regulait/shared";
import { buildApp } from "./app.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { forgetStepUpMethodsForTest, relaxStepUpAround } from "./testing/step-up-posture.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { importRegistryEntry } from "./mcp-registry.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `sds-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
// a public address literal: the egress guard decides it without a DNS lookup, and nothing is ever fetched. A public
// MCP or registry destination needs an egress allow entry; this suite adds one for this host and removes it in afterAll
const PUBLIC_HOST = "93.184.216.34";
const REGISTRY_URL = `https://${PUBLIC_HOST}/`;
let allowHostId: string | undefined;
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreIdentity: (() => Promise<void>) | undefined;
const created = { users: [] as string[], sessions: [] as string[], registries: [] as string[], servers: [] as string[], agents: [] as string[], cards: [] as string[], allowHosts: [] as string[] };
let admin: { id: string; key: { authorization: string }; session: { token: string }; auth: SoftAuthenticator };

type Method = "GET" | "PUT" | "POST" | "PATCH";
const asAdmin = (method: Method, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...headers }, cookies: { regulait_session: admin.session.token }, payload: payload as object });
const viaKey = (method: Method, url: string, payload: unknown) => app.inject({ method, url, headers: admin.key, payload: payload as object });

async function grantFor(action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await asAdmin("POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await asAdmin("POST", "/v1/auth/step-up/verify", {
    stepUpId: o.json().stepUpId,
    method: "passkey",
    response: admin.auth.authenticate(o.json().passkey.options),
  });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** the same change's facts with a different value: a grant for it must be refused for `facts`, and not spent */
function differentValue(facts: Record<string, unknown>): Record<string, unknown> {
  if ("expectedServedModel" in facts) return { ...facts, expectedServedModel: `${String(facts.expectedServedModel)}-other` };
  if (facts.values && typeof facts.values === "object") return { ...facts, values: { ...(facts.values as object), otherValue: true } };
  return { ...facts, otherValue: true };
}

/** a relaxing write: refused to an API key; a prompt bound to exactly `facts` for a person; refused with a grant
 * for other facts; done with a grant for exactly these. Returns the successful response. */
async function relaxThroughStepUp(method: Method, url: string, payload: unknown, facts: Record<string, unknown>) {
  const key = await viaKey(method, url, payload);
  expect(key.statusCode, key.body).toBe(403);
  expect(key.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax", methods: [] });
  const asked = await asAdmin(method, url, payload);
  expect(asked.statusCode, asked.body).toBe(403);
  expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax", methods: ["passkey"] });
  expect(asked.json().action).toEqual({ kind: "settings_relax", body: facts });
  const other = await grantFor({ kind: "settings_relax", body: differentValue(facts) });
  expect((await asAdmin(method, url, payload, { [STEP_UP_HEADER]: other })).statusCode).toBe(403);
  // refused, and not spent: the grant made for other facts is still unused
  const [otherGrant] = await db.select({ usedAt: stepUpGrants.usedAt }).from(stepUpGrants).where(eq(stepUpGrants.tokenHash, createHash("sha256").update(other).digest("hex")));
  expect(otherGrant!.usedAt).toBeNull();
  const token = await grantFor(asked.json().action);
  return asAdmin(method, url, payload, { [STEP_UP_HEADER]: token });
}

async function lastAudit(ruleId: string, objectId: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return row;
}

const STRICT_SQL = sql`UPDATE org_settings SET step_up_mode = 'required',
  step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage"]'::jsonb
  WHERE id = ${ORG_SETTINGS_ID}`;

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  await db.execute(STRICT_SQL);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  // adding an entry is a stepped-up relaxation (ADR-0034 owner amendment 2026-10-16); this is suite setup, not the
  // case under test, and another suite on the shared database may already have an admin with a step-up method
  const allow = await relaxStepUpAround(db, () => app.inject({
    method: "POST",
    url: "/v1/egress-allow-hosts",
    headers: AUTH,
    payload: { host: PUBLIC_HOST, note: `sds ${RUN}: a public MCP/registry destination (never contacted)` },
  }));
  expect(allow.statusCode, allow.body).toBe(201);
  allowHostId = allow.json().id as string;
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `sds-${RUN}@example.com`, displayName: "sds admin", isAdmin: true } });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  created.users.push(id);
  const key = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "sds" } });
  const token = "rgls_" + randomBytes(32).toString("hex");
  const [s] = await db
    .insert(authSessions)
    .values({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId: id,
      origin: "password",
      expiresAt: new Date(Date.now() + 3_600_000),
      idleExpiresAt: new Date(Date.now() + 3_600_000),
      idleMinutes: 60,
    })
    .returning({ id: authSessions.id });
  created.sessions.push(s!.id);
  admin = { id, key: { authorization: `Bearer ${key.json().token}` }, session: { token }, auth: new SoftAuthenticator({ origin: ORIGIN }) };
  const opt = await asAdmin("POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const reg = await asAdmin("POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "sds" });
  expect(reg.statusCode, reg.body).toBe(201);
}, 120_000);

afterAll(async () => {
  // M-068: the allow entry goes first, while the app is open; its outcome is asserted after every other restore
  const allowRemoval = await removeEgressAllowEntry(app, admin?.key ?? AUTH, { id: allowHostId });
  // the entries the egress-step-up cases created (tightening a removal needs no step-up)
  const extraRemovals = [];
  for (const id of created.allowHosts) extraRemovals.push(await removeEgressAllowEntry(app, admin?.key ?? AUTH, { id }));
  try {
    await restoreAll();
  } finally {
    allowRemoval.assertRemoved();
    for (const r of extraRemovals) r.assertRemoved();
  }
});

async function restoreAll() {
  await db.execute(STRICT_SQL);
  await restoreIdentity?.();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  if (created.cards.length > 0) await db.delete(modelCards).where(inArray(modelCards.id, created.cards));
  if (created.agents.length > 0) await db.delete(agents).where(inArray(agents.id, created.agents));
  if (created.servers.length > 0) await db.delete(mcpServers).where(inArray(mcpServers.id, created.servers));
  if (created.registries.length > 0) await db.delete(mcpRegistries).where(inArray(mcpRegistries.id, created.registries));
  await db.delete(stepUpGrants).where(inArray(stepUpGrants.userId, created.users));
  await db.delete(webauthnChallenges).where(inArray(webauthnChallenges.userId, created.users));
  await forgetStepUpMethodsForTest(db, created.users);
  await db.delete(webauthnCredentials).where(inArray(webauthnCredentials.userId, created.users));
  await db.delete(authSessions).where(inArray(authSessions.id, created.sessions));
  app.server.closeAllConnections();
  await app.close();
}

describe("MCP registry: enabling and private ranges are relaxations", () => {
  it("create: the strict defaults need nothing; enabled or private ranges allowed needs a bound step-up, audited", async () => {
    const plain = await asAdmin("POST", "/v1/mcp-registries", { name: `sds-plain-${RUN}`, url: REGISTRY_URL });
    expect(plain.statusCode, plain.body).toBe(201);
    created.registries.push(plain.json().id);
    expect(plain.json()).toMatchObject({ enabled: false, allowPrivateRanges: null });
    // an explicit deny is tightening, not a relaxation
    const denied = await asAdmin("POST", "/v1/mcp-registries", { name: `sds-deny-${RUN}`, url: REGISTRY_URL, allowPrivateRanges: false });
    expect(denied.statusCode, denied.body).toBe(201);
    created.registries.push(denied.json().id);

    const name = `sds-relaxed-${RUN}`;
    const payload = { name, url: REGISTRY_URL, enabled: true, allowPrivateRanges: true };
    const before = (await db.select({ id: mcpRegistries.id }).from(mcpRegistries).where(eq(mcpRegistries.name, name))).length;
    const ok = await relaxThroughStepUp("POST", "/v1/mcp-registries", payload, {
      op: "mcp_registry_create",
      name,
      url: REGISTRY_URL,
      values: { enabled: true, allowPrivateRanges: true },
    });
    expect(before).toBe(0); // nothing was written by the refused attempts
    expect(ok.statusCode, ok.body).toBe(201);
    created.registries.push(ok.json().id);
    expect(ok.json()).toMatchObject({ enabled: true, allowPrivateRanges: true });
    const row = await lastAudit("mcp-registry-configured", ok.json().id);
    expect(row!.detail).toMatchObject({ action: "create", relaxation: true, relaxed: { enabled: true, allowPrivateRanges: true }, stepUp: "passkey" });
    const plainRow = await lastAudit("mcp-registry-configured", plain.json().id);
    expect(plainRow!.detail).toMatchObject({ relaxation: false });
  });

  it("update: enabling and opening private ranges need a step-up; disabling and closing them do not", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/mcp-registries", headers: AUTH, payload: { name: `sds-upd-${RUN}`, url: REGISTRY_URL } });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    created.registries.push(id);
    const url = `/v1/mcp-registries/${id}`;

    const enabled = await relaxThroughStepUp("PATCH", url, { enabled: true }, { op: "mcp_registry_update", registryId: id, values: { enabled: true } });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().enabled).toBe(true);
    expect((await lastAudit("mcp-registry-configured", id))!.detail).toMatchObject({
      action: "update",
      relaxation: true,
      relaxed: { enabled: true },
      stepUp: "passkey",
      from: { enabled: false },
      to: { enabled: true },
    });

    const opened = await relaxThroughStepUp("PATCH", url, { allowPrivateRanges: true }, { op: "mcp_registry_update", registryId: id, values: { allowPrivateRanges: true } });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json().allowPrivateRanges).toBe(true);

    // tightening: no grant, and an API key may do it
    const closed = await viaKey("PATCH", url, { allowPrivateRanges: false });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().allowPrivateRanges).toBe(false);
    const disabled = await asAdmin("PATCH", url, { enabled: false });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json().enabled).toBe(false);
    expect((await lastAudit("mcp-registry-configured", id))!.detail).toMatchObject({ relaxation: false });
  });
});

describe("MCP server: opening private ranges is a relaxation", () => {
  it("POST /v1/servers: inherit and deny need nothing; allow needs a bound step-up and is audited", async () => {
    const plain = await asAdmin("POST", "/v1/servers", { name: `sds-srv-plain-${RUN}`, url: `${REGISTRY_URL}mcp` });
    expect(plain.statusCode, plain.body).toBe(201);
    created.servers.push(plain.json().id);
    const denied = await asAdmin("POST", "/v1/servers", { name: `sds-srv-deny-${RUN}`, url: `${REGISTRY_URL}mcp`, allowPrivateRanges: false });
    expect(denied.statusCode, denied.body).toBe(201);
    created.servers.push(denied.json().id);

    const name = `sds-srv-open-${RUN}`;
    const ok = await relaxThroughStepUp("POST", "/v1/servers", { name, url: `${REGISTRY_URL}mcp`, allowPrivateRanges: true }, {
      op: "mcp_server_create",
      name,
      url: `${REGISTRY_URL}mcp`,
      values: { allowPrivateRanges: true },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    created.servers.push(ok.json().id);
    expect(ok.json().allowPrivateRanges).toBe(true);
    expect((await db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.name, name))).length).toBe(1);
    expect((await lastAudit("mcp-server-registered", ok.json().id))!.detail).toMatchObject({
      relaxation: true,
      relaxed: { allowPrivateRanges: true },
      stepUp: "passkey",
    });
    expect((await lastAudit("mcp-server-registered", plain.json().id))!.detail).toMatchObject({ relaxation: false });
  });

  it("PATCH /v1/servers/:id: allowing needs a bound step-up; denying and inheriting a closed default do not; each change is audited", async () => {
    const r = await asAdmin("POST", "/v1/servers", { name: `sds-srv-upd-${RUN}`, url: `${REGISTRY_URL}mcp` });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    created.servers.push(id);
    const url = `/v1/servers/${id}`;

    const opened = await relaxThroughStepUp("PATCH", url, { allowPrivateRanges: true }, { op: "mcp_server_update", serverId: id, values: { allowPrivateRanges: true } });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json().allowPrivateRanges).toBe(true);
    expect((await lastAudit("mcp-server-private-ranges-changed", id))!.detail).toMatchObject({
      from: { allowPrivateRanges: null },
      to: { allowPrivateRanges: true },
      relaxation: true,
      stepUp: "passkey",
    });

    // tightening, even through an API key
    const closed = await viaKey("PATCH", url, { allowPrivateRanges: false });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().allowPrivateRanges).toBe(false);
    expect((await lastAudit("mcp-server-private-ranges-changed", id))!.detail).toMatchObject({ to: { allowPrivateRanges: false }, relaxation: false });
    // back to inherit while the org default is closed (the strict value): not a relaxation
    const [org] = await db.execute(sql`SELECT mcp_private_ranges_default AS d FROM org_settings WHERE id = ${ORG_SETTINGS_ID}`).then((x) => (x as unknown as { rows: Array<{ d: boolean }> }).rows);
    expect(org!.d).toBe(false);
    const inherit = await viaKey("PATCH", url, { allowPrivateRanges: null });
    expect(inherit.statusCode, inherit.body).toBe(200);
    expect(inherit.json().allowPrivateRanges).toBeNull();
  });
});

describe("egress allow entries: adding one, and turning an opt-in on, are relaxations", () => {
  it("adding a plain entry needs a step-up bound to the host (ADR-0034 owner amendment 2026-10-16); a note edit and removal need nothing", async () => {
    const host = `sds-add-${RUN}.example.test`;
    const payload = { host, note: "sds: plain entry" };
    const rows = async () => (await db.select({ id: egressAllowHosts.id }).from(egressAllowHosts).where(eq(egressAllowHosts.host, host))).length;
    // egress-allow-cleanup: refused — an API key can never step up, so nothing is written
    const byKey = await viaKey("POST", "/v1/egress-allow-hosts", payload);
    expect(byKey.statusCode, byKey.body).toBe(403);
    expect(byKey.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax", methods: [] });
    // egress-allow-cleanup: refused — a person without a grant is prompted, and nothing is written
    const ungranted = await asAdmin("POST", "/v1/egress-allow-hosts", payload);
    expect(ungranted.statusCode, ungranted.body).toBe(403);
    expect(ungranted.json().action).toEqual({ kind: "settings_relax", body: { op: "egress_allow_host", host, values: { added: true } } });
    expect(await rows()).toBe(0);
    // egress-allow-cleanup: afterAll — the id lands in created.allowHosts, which afterAll removes
    const added = await asAdmin("POST", "/v1/egress-allow-hosts", payload, { [STEP_UP_HEADER]: await grantFor(ungranted.json().action) });
    expect(added.statusCode, added.body).toBe(201);
    created.allowHosts.push(added.json().id);
    expect(added.json()).toMatchObject({ host, allowPrivateRanges: false, allowPlaintextHttp: false });
    const row = await lastAudit("egress-allow-host-set", added.json().id);
    expect(row!.detail).toMatchObject({ relaxation: true, relaxed: { added: true }, stepUp: "passkey" });
    expect(row!.reason).toContain("added");

    // an upsert of the same host that turns nothing on names no new destination: no step-up, even via an API key
    // egress-allow-cleanup: afterAll — the same host (an upsert), removed in afterAll
    const noted = await viaKey("POST", "/v1/egress-allow-hosts", { host, note: "sds: note edited" });
    expect(noted.statusCode, noted.body).toBe(201);
    expect((await lastAudit("egress-allow-host-set", noted.json().id))!.detail).toMatchObject({ relaxation: false, note: "sds: note edited" });

    // removing it tightens: no step-up, through an API key, audited
    const removed = await app.inject({ method: "DELETE", url: `/v1/egress-allow-hosts/${added.json().id}`, headers: admin.key });
    expect(removed.statusCode, removed.body).toBe(200);
    created.allowHosts.splice(created.allowHosts.indexOf(added.json().id), 1); // removed here, not in afterAll
    expect((await lastAudit("egress-allow-host-removed", added.json().id))!.detail).toMatchObject({ removed: host });
  });

  it("a new entry with opt-ins presents ONE step-up bound to the addition and the opt-ins together", async () => {
    const host = `sds-addopen-${RUN}.lan.example.test`;
    // egress-allow-cleanup: afterAll — the id lands in created.allowHosts, which afterAll removes
    const ok = await relaxThroughStepUp("POST", "/v1/egress-allow-hosts", { host, allowPrivateRanges: true, allowPlaintextHttp: true }, {
      op: "egress_allow_host",
      host,
      values: { added: true, allowPrivateRanges: true, allowPlaintextHttp: true },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    created.allowHosts.push(ok.json().id);
    expect((await lastAudit("egress-allow-host-set", ok.json().id))!.detail).toMatchObject({
      relaxation: true,
      relaxed: { added: true, allowPrivateRanges: true, allowPlaintextHttp: true },
      stepUp: "passkey",
    });
  });

  it("turning an opt-in on needs a step-up bound to the host and the opt-ins; turning them off needs nothing", async () => {
    const host = `sds-${RUN}.lan.example.test`;
    // egress-allow-cleanup: afterAll — every id lands in created.allowHosts, which afterAll removes
    const plain = await relaxThroughStepUp("POST", "/v1/egress-allow-hosts", { host, note: "sds: plain entry" }, {
      op: "egress_allow_host",
      host,
      values: { added: true },
    });
    expect(plain.statusCode, plain.body).toBe(201);
    created.allowHosts.push(plain.json().id);

    // egress-allow-cleanup: afterAll — the same host (an upsert), removed in afterAll
    const opened = await relaxThroughStepUp("POST", "/v1/egress-allow-hosts", { host, allowPrivateRanges: true }, {
      op: "egress_allow_host",
      host,
      values: { allowPrivateRanges: true },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    expect(opened.json()).toMatchObject({ host, allowPrivateRanges: true, allowPlaintextHttp: false });
    expect((await lastAudit("egress-allow-host-set", opened.json().id))!.detail).toMatchObject({
      relaxation: true,
      relaxed: { allowPrivateRanges: true },
      stepUp: "passkey",
      from: { allowPrivateRanges: false, allowPlaintextHttp: false },
    });

    // re-sending what is stored, and turning plaintext on: only the NEW opt-in is bound
    // egress-allow-cleanup: afterAll — the same host (an upsert), removed in afterAll
    const plaintext = await relaxThroughStepUp("POST", "/v1/egress-allow-hosts", { host, allowPrivateRanges: true, allowPlaintextHttp: true }, {
      op: "egress_allow_host",
      host,
      values: { allowPlaintextHttp: true },
    });
    expect(plaintext.statusCode, plaintext.body).toBe(201);

    // tightening: both opt-ins off, through an API key, no step-up
    // egress-allow-cleanup: afterAll — the same host (an upsert), removed in afterAll
    const closed = await viaKey("POST", "/v1/egress-allow-hosts", { host });
    expect(closed.statusCode, closed.body).toBe(201);
    expect(closed.json()).toMatchObject({ allowPrivateRanges: false, allowPlaintextHttp: false });
    expect((await lastAudit("egress-allow-host-set", closed.json().id))!.detail).toMatchObject({ relaxation: false });
    expect((await db.select({ id: egressAllowHosts.id }).from(egressAllowHosts).where(eq(egressAllowHosts.host, host))).length).toBe(1);
  });
});

describe("MCP registry import: inheriting a registry's open private ranges is a relaxation", () => {
  it("an import from a registry that allows private ranges needs a bound step-up; the audit row records the posture", async () => {
    const name = `sds-open-reg-${RUN}`;
    const reg = await relaxThroughStepUp("POST", "/v1/mcp-registries", { name, url: REGISTRY_URL, allowPrivateRanges: true }, {
      op: "mcp_registry_create",
      name,
      url: REGISTRY_URL,
      values: { allowPrivateRanges: true },
    });
    expect(reg.statusCode, reg.body).toBe(201);
    const registryId = reg.json().id as string;
    created.registries.push(registryId);
    const [entry] = await db
      .insert(mcpRegistryEntries)
      .values({
        registryId,
        upstreamName: `io.example.test/sds-${RUN}`,
        upstreamVersion: "1.0.0",
        kind: "remote",
        remoteUrl: `${REGISTRY_URL}sds-mcp`,
        remoteTransport: "streamable-http",
      })
      .returning();
    const url = `/v1/mcp-registries/entries/${entry!.id}/import`;
    const ok = await relaxThroughStepUp("POST", url, {}, {
      op: "mcp_registry_import",
      registryId,
      entryId: entry!.id,
      url: `${REGISTRY_URL}sds-mcp`,
      values: { allowPrivateRanges: true },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    created.servers.push(ok.json().serverId);
    const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, ok.json().serverId));
    expect(server!.allowPrivateRanges).toBe(true);
    expect((await lastAudit("mcp-registry-entry-imported", ok.json().serverId))!.detail).toMatchObject({
      allowPrivateRanges: true,
      relaxation: true,
      relaxed: { allowPrivateRanges: true },
      stepUp: "passkey",
    });
  });

  it("an import from a registry that inherits the org default asks nothing and records no relaxation", async () => {
    const r = await asAdmin("POST", "/v1/mcp-registries", { name: `sds-inherit-reg-${RUN}`, url: REGISTRY_URL });
    expect(r.statusCode, r.body).toBe(201);
    const registryId = r.json().id as string;
    created.registries.push(registryId);
    const [entry] = await db
      .insert(mcpRegistryEntries)
      .values({
        registryId,
        upstreamName: `io.example.test/sds-inherit-${RUN}`,
        upstreamVersion: "1.0.0",
        kind: "remote",
        remoteUrl: `${REGISTRY_URL}sds-inherit-mcp`,
        remoteTransport: "streamable-http",
      })
      .returning();
    const imported = await viaKey("POST", `/v1/mcp-registries/entries/${entry!.id}/import`, {});
    expect(imported.statusCode, imported.body).toBe(201);
    created.servers.push(imported.json().serverId);
    expect((await lastAudit("mcp-registry-entry-imported", imported.json().serverId))!.detail).toMatchObject({
      allowPrivateRanges: null,
      relaxation: false,
    });
  });
});

describe("agent expected served model: setting it relaxes the served-model drift check", () => {
  it("PUT: setting or changing it needs a bound step-up and is audited; clearing and re-sending need nothing", async () => {
    const a = await app.inject({ method: "POST", url: "/v1/agents", headers: AUTH, payload: { name: `sds-agent-${RUN}`, provider: "mock", tier: 1, model: `sds-deploy-${RUN}` } });
    expect(a.statusCode, a.body).toBe(201);
    const agentId = a.json().id as string;
    created.agents.push(agentId);
    const url = `/v1/agents/${agentId}/expected-served-model`;

    const set = await relaxThroughStepUp("PUT", url, { expectedServedModel: `sds-real-${RUN}` }, {
      op: "agent_expected_served_model",
      agentId,
      expectedServedModel: `sds-real-${RUN}`,
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().expectedServedModel).toBe(`sds-real-${RUN}`);
    expect((await lastAudit("agent-expected-served-model-set", agentId))!.detail).toMatchObject({
      from: null,
      to: `sds-real-${RUN}`,
      relaxation: true,
      stepUp: "passkey",
    });

    // the same value again changes nothing and asks nothing
    const same = await asAdmin("PUT", url, { expectedServedModel: `sds-real-${RUN}` });
    expect(same.statusCode, same.body).toBe(200);
    // a different value is a new relaxation, bound to the new value
    const changed = await relaxThroughStepUp("PUT", url, { expectedServedModel: `sds-other-${RUN}` }, {
      op: "agent_expected_served_model",
      agentId,
      expectedServedModel: `sds-other-${RUN}`,
    });
    expect(changed.statusCode, changed.body).toBe(200);

    // clearing restores the strict default: no step-up, even through an API key
    const cleared = await viaKey("PUT", url, { expectedServedModel: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().expectedServedModel).toBeNull();
    expect((await lastAudit("agent-expected-served-model-set", agentId))!.detail).toMatchObject({ to: null, relaxation: false });
  });

  it("POST /v1/agents with an expected served model is the same relaxation", async () => {
    const name = `sds-agent-new-${RUN}`;
    const payload = { name, provider: "mock", tier: 1, model: `sds-deploy-${RUN}`, expectedServedModel: `sds-real-${RUN}` };
    const ok = await relaxThroughStepUp("POST", "/v1/agents", payload, {
      op: "agent_create_expected_served_model",
      name,
      expectedServedModel: `sds-real-${RUN}`,
    });
    expect(ok.statusCode, ok.body).toBe(201);
    created.agents.push(ok.json().id);
    expect((await db.select({ id: agents.id }).from(agents).where(eq(agents.name, name))).length).toBe(1);
    expect((await lastAudit("agent-expected-served-model-set", ok.json().id))!.detail).toMatchObject({
      action: "create",
      to: `sds-real-${RUN}`,
      relaxation: true,
      stepUp: "passkey",
    });
  });
});

describe("model cards refuse a presentation-scrub marker", () => {
  it("POST and PATCH answer 400 redacted_text_refused naming the fields, and write nothing", async () => {
    const a = await app.inject({ method: "POST", url: "/v1/agents", headers: AUTH, payload: { name: `sds-card-agent-${RUN}`, provider: "mock", tier: 1, model: `sds-card-${RUN}` } });
    expect(a.statusCode, a.body).toBe(201);
    const agentId = a.json().id as string;
    created.agents.push(agentId);
    const masked = scrubAuditText("key AKIAIOSFODNN7EXAMPLE");
    expect(masked).toMatch(/\[redacted:/);

    const refusedCreate = await asAdmin("POST", "/v1/mrm/cards", { agentId, intendedUse: `sds use ${RUN}`, limitations: masked });
    expect(refusedCreate.statusCode, refusedCreate.body).toBe(400);
    expect(refusedCreate.json()).toMatchObject({ error: "redacted_text_refused", fields: ["limitations"] });
    expect((await db.select({ id: modelCards.id }).from(modelCards).where(eq(modelCards.agentId, agentId))).length).toBe(0);

    const ok = await asAdmin("POST", "/v1/mrm/cards", { agentId, intendedUse: `sds use ${RUN}`, limitations: "English only" });
    expect(ok.statusCode, ok.body).toBe(201);
    const cardId = ok.json().card.id as string;
    created.cards.push(cardId);

    const refusedEdit = await asAdmin("PATCH", `/v1/mrm/cards/${cardId}`, { limitations: masked, standardRefs: ["nist-ai-rmf:MAP-1.1"] });
    expect(refusedEdit.statusCode, refusedEdit.body).toBe(400);
    expect(refusedEdit.json()).toMatchObject({ error: "redacted_text_refused", fields: ["limitations"] });
    const [row] = await db.select().from(modelCards).where(eq(modelCards.id, cardId));
    expect(row!.limitations).toBe("English only");
    expect(row!.standardRefs).toEqual([]);

    // the same edit without the mask is saved
    const edited = await asAdmin("PATCH", `/v1/mrm/cards/${cardId}`, { limitations: "English and French" });
    expect(edited.statusCode, edited.body).toBe(200);
  });
});

describe("recheck: spellings, fail-closed import, concurrency and url binding", () => {
  it("a host is bound in its normalised spelling: a grant made for one spelling serves another of the same host", async () => {
    const host = `sds-spell-${RUN}.lan.example.test`;
    // egress-allow-cleanup: afterAll — the id lands in created.allowHosts, which afterAll removes
    const asked = await asAdmin("POST", "/v1/egress-allow-hosts", { host: `${host.toUpperCase()}.`, allowPrivateRanges: true });
    expect(asked.statusCode, asked.body).toBe(403);
    // the facts carry the normalised host (lower case, no trailing dot): by design, the gateway's one spelling
    expect(asked.json().action).toEqual({ kind: "settings_relax", body: { op: "egress_allow_host", host, values: { added: true, allowPrivateRanges: true } } });
    const token = await grantFor(asked.json().action);
    // egress-allow-cleanup: afterAll — the same host, removed in afterAll
    const ok = await asAdmin("POST", "/v1/egress-allow-hosts", { host, allowPrivateRanges: true }, { [STEP_UP_HEADER]: token });
    expect(ok.statusCode, ok.body).toBe(201);
    created.allowHosts.push(ok.json().id);
    // a different host is a different binding
    const other = await grantFor({ kind: "settings_relax", body: { op: "egress_allow_host", host, values: { added: true, allowPrivateRanges: true } } });
    // egress-allow-cleanup: refused — a grant for another host never writes
    const wrong = await asAdmin("POST", "/v1/egress-allow-hosts", { host: `x${host}`, allowPrivateRanges: true }, { [STEP_UP_HEADER]: other });
    expect(wrong.statusCode, wrong.body).toBe(403);
  });

  it("a re-send decided as no relaxation is refused 409 when a concurrent admin turned the opt-in off meanwhile", async () => {
    const host = `sds-race-${RUN}.lan.example.test`;
    // egress-allow-cleanup: afterAll — the id lands in created.allowHosts, which afterAll removes
    const opened = await relaxThroughStepUp("POST", "/v1/egress-allow-hosts", { host, allowPrivateRanges: true }, {
      op: "egress_allow_host",
      host,
      values: { added: true, allowPrivateRanges: true },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    created.allowHosts.push(opened.json().id);
    // another admin's write, held open: it turns the opt-in off but has not committed
    const other = await db.$client.connect();
    try {
      await other.query("begin");
      await other.query("update egress_allow_hosts set allow_private_ranges = false where host = $1", [host]);
      // a note edit re-sending the opt-in as on: decided on the committed row (on), so no step-up is asked for…
      // egress-allow-cleanup: afterAll — the same host, removed in afterAll
      const pending = asAdmin("POST", "/v1/egress-allow-hosts", { host, allowPrivateRanges: true, note: "edited" });
      // …and it waits on the row lock the write takes before re-deciding
      for (let i = 0; i < 100; i += 1) {
        const r = await db.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%egress_allow_hosts%'`);
        if ((r as unknown as { rows: Array<{ n: number }> }).rows[0]!.n > 0) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      await other.query("commit");
      const res = await pending;
      // under the lock the write is now a relaxation it was not stepped up for: nothing is written
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toBe("changed_concurrently");
    } finally {
      await other.query("rollback").catch(() => undefined);
      other.release();
    }
    const [row] = await db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, host));
    expect(row!.allowPrivateRanges).toBe(false);
  });

  it("two writers adding the same new host: the second waits on the per-host lock and is refused 409, its grant unspent", async () => {
    const host = `sds-addrace-${RUN}.example.test`;
    const action = { kind: "settings_relax", body: { op: "egress_allow_host", host, values: { added: true } } };
    const token = await grantFor(action);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    // the other writer: holds the same per-host lock the route takes and adds the host, not yet committed
    const other = await db.$client.connect();
    try {
      await other.query("begin");
      await other.query("select pg_advisory_xact_lock(hashtext($1))", [`egress_allow_host:${host}`]);
      await other.query("insert into egress_allow_hosts (host, allow_private_ranges, allow_plaintext_http, note) values ($1, false, false, $2)", [host, "the other writer"]);
      // egress-allow-cleanup: refused — the row the other writer committed is removed below
      const pending = asAdmin("POST", "/v1/egress-allow-hosts", { host, note: "mine" }, { [STEP_UP_HEADER]: token });
      for (let i = 0; i < 100; i += 1) {
        const r = await db.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%pg_advisory_xact_lock%'`);
        if ((r as unknown as { rows: Array<{ n: number }> }).rows[0]!.n > 0) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      await other.query("commit");
      const res = await pending;
      // decided "added" before the lock; under it the host exists, so nothing is overwritten and nothing is spent
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toBe("changed_concurrently");
    } finally {
      await other.query("rollback").catch(() => undefined);
      other.release();
    }
    const [row] = await db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, host));
    expect(row).toMatchObject({ note: "the other writer", allowPrivateRanges: false });
    created.allowHosts.push(row!.id);
    const [grant] = await db.select().from(stepUpGrants).where(eq(stepUpGrants.tokenHash, tokenHash));
    expect(grant!.usedAt).toBeNull();
  });

  it("a writer outside the route adds the host after the re-decision: the insert-conflict 409 leaves the grant unspent", async () => {
    const host = `sds-outside-${RUN}.example.test`;
    const action = { kind: "settings_relax", body: { op: "egress_allow_host", host, values: { added: true } } };
    const token = await grantFor(action);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    // the other writer takes NO per-host lock (as a writer outside this route would not): its uncommitted row is
    // invisible to the route's re-decision ("added" still holds), and the route's insert waits on it
    const other = await db.$client.connect();
    try {
      await other.query("begin");
      await other.query("insert into egress_allow_hosts (host, allow_private_ranges, allow_plaintext_http, note) values ($1, false, false, $2)", [host, "outside the route"]);
      // egress-allow-cleanup: refused — the row the other writer committed is removed below
      const pending = asAdmin("POST", "/v1/egress-allow-hosts", { host, note: "mine" }, { [STEP_UP_HEADER]: token });
      for (let i = 0; i < 100; i += 1) {
        const r = await db.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%insert into "egress_allow_hosts"%'`);
        if ((r as unknown as { rows: Array<{ n: number }> }).rows[0]!.n > 0) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      await other.query("commit");
      const res = await pending;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toBe("changed_concurrently");
    } finally {
      await other.query("rollback").catch(() => undefined);
      other.release();
    }
    const [row] = await db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, host));
    expect(row).toMatchObject({ note: "outside the route" });
    created.allowHosts.push(row!.id);
    // insert first, then spend: the grant is still good
    const [grant] = await db.select().from(stepUpGrants).where(eq(stepUpGrants.tokenHash, tokenHash));
    expect(grant!.usedAt).toBeNull();
  });

  it("importRegistryEntry with no step-up check refuses an import that opens private ranges", async () => {
    const name = `sds-noop-reg-${RUN}`;
    const reg = await relaxThroughStepUp("POST", "/v1/mcp-registries", { name, url: REGISTRY_URL, allowPrivateRanges: true }, {
      op: "mcp_registry_create",
      name,
      url: REGISTRY_URL,
      values: { allowPrivateRanges: true },
    });
    expect(reg.statusCode, reg.body).toBe(201);
    created.registries.push(reg.json().id);
    const [entry] = await db
      .insert(mcpRegistryEntries)
      .values({ registryId: reg.json().id, upstreamName: `io.example.test/sds-noop-${RUN}`, upstreamVersion: "1.0.0", kind: "remote", remoteUrl: `${REGISTRY_URL}sds-noop`, remoteTransport: "streamable-http" })
      .returning();
    const out = await importRegistryEntry(db, entry!.id, {});
    expect(out.ok).toBe(false);
    expect(out.ok ? null : out.refusal).toMatchObject({ status: 403, body: { error: "step_up_required", actionKind: "settings_relax" } });
    expect((await db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.url, `${REGISTRY_URL}sds-noop`))).length).toBe(0);
  });

  it("a server or registry PATCH that moves the url binds it: a grant without the url is refused", async () => {
    const srv = await asAdmin("POST", "/v1/servers", { name: `sds-srv-url-${RUN}`, url: `${REGISTRY_URL}url-a` });
    expect(srv.statusCode, srv.body).toBe(201);
    const serverId = srv.json().id as string;
    created.servers.push(serverId);
    const body = { url: `${REGISTRY_URL}url-b`, allowPrivateRanges: true };
    const noUrl = await grantFor({ kind: "settings_relax", body: { op: "mcp_server_update", serverId, values: { allowPrivateRanges: true } } });
    expect((await asAdmin("PATCH", `/v1/servers/${serverId}`, body, { [STEP_UP_HEADER]: noUrl })).statusCode).toBe(403);
    const ok = await relaxThroughStepUp("PATCH", `/v1/servers/${serverId}`, body, { op: "mcp_server_update", serverId, url: body.url, values: { allowPrivateRanges: true } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ url: body.url, allowPrivateRanges: true });

    const r = await asAdmin("POST", "/v1/mcp-registries", { name: `sds-reg-url-${RUN}`, url: REGISTRY_URL });
    expect(r.statusCode, r.body).toBe(201);
    const registryId = r.json().id as string;
    created.registries.push(registryId);
    const rbody = { url: `${REGISTRY_URL}moved`, enabled: true };
    const rNoUrl = await grantFor({ kind: "settings_relax", body: { op: "mcp_registry_update", registryId, values: { enabled: true } } });
    expect((await asAdmin("PATCH", `/v1/mcp-registries/${registryId}`, rbody, { [STEP_UP_HEADER]: rNoUrl })).statusCode).toBe(403);
    const rok = await relaxThroughStepUp("PATCH", `/v1/mcp-registries/${registryId}`, rbody, { op: "mcp_registry_update", registryId, url: rbody.url, values: { enabled: true } });
    expect(rok.statusCode, rok.body).toBe(200);
  });

  it("a refused server PATCH changes nothing: no grant, or an unknown owner, leaves name, owner and ranges as they were", async () => {
    const srv = await asAdmin("POST", "/v1/servers", { name: `sds-srv-atomic-${RUN}`, url: `${REGISTRY_URL}atomic` });
    expect(srv.statusCode, srv.body).toBe(201);
    const serverId = srv.json().id as string;
    created.servers.push(serverId);
    const [before] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    const noGrant = await asAdmin("PATCH", `/v1/servers/${serverId}`, { name: `sds-srv-atomic-renamed-${RUN}`, allowPrivateRanges: true, ownerUserId: admin.id });
    expect(noGrant.statusCode, noGrant.body).toBe(403);
    const unknownOwner = await asAdmin("PATCH", `/v1/servers/${serverId}`, { name: `sds-srv-atomic-renamed-${RUN}`, ownerUserId: "00000000-0000-4000-8000-00000000dead" });
    expect(unknownOwner.statusCode, unknownOwner.body).toBe(422);
    const [after] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    expect({ name: after!.name, ownerUserId: after!.ownerUserId, allowPrivateRanges: after!.allowPrivateRanges }).toEqual({
      name: before!.name,
      ownerUserId: before!.ownerUserId,
      allowPrivateRanges: before!.allowPrivateRanges,
    });
  });
});

describe("PATCH /v1/servers/:serverId: the columns and the owner are one conditional write", () => {
  it("an owner changed concurrently between the check and the write: 409, no column written, the grant unspent", async () => {
    const srv = await asAdmin("POST", "/v1/servers", { name: `sds-srv-cas-${RUN}`, url: `${REGISTRY_URL}cas`, ownerUserId: null });
    expect(srv.statusCode, srv.body).toBe(201);
    const serverId = srv.json().id as string;
    created.servers.push(serverId);
    const [before] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    expect(before!.ownerUserId).toBeNull();
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `sds-cas-${RUN}@example.com`, displayName: "sds cas owner" } });
    expect(u.statusCode, u.body).toBe(201);
    const otherOwner = u.json().id as string;
    created.users.push(otherOwner);
    const token = await grantFor({ kind: "owner_change", body: { objectType: "mcp_server", objectId: serverId, ownerUserId: admin.id } });
    // another admin's owner change, held open: the PATCH reads the old owner, then waits on the row lock
    const other = await db.$client.connect();
    try {
      await other.query("begin");
      await other.query("update mcp_servers set owner_user_id = $1 where id = $2", [otherOwner, serverId]);
      const pending = asAdmin("PATCH", `/v1/servers/${serverId}`, { name: `sds-srv-cas-renamed-${RUN}`, ownerUserId: admin.id }, { [STEP_UP_HEADER]: token });
      for (let i = 0; i < 100; i += 1) {
        const r = await db.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%update "mcp_servers"%'`);
        if ((r as unknown as { rows: Array<{ n: number }> }).rows[0]!.n > 0) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      await other.query("commit");
      const res = await pending;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toBe("changed_concurrently");
    } finally {
      await other.query("rollback").catch(() => undefined);
      other.release();
    }
    const [after] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    // the rename was NOT written without the owner change: the other writer's owner stands, the name is unchanged
    expect({ name: after!.name, ownerUserId: after!.ownerUserId }).toEqual({ name: before!.name, ownerUserId: otherOwner });
    const [grant] = await db.select().from(stepUpGrants).where(eq(stepUpGrants.tokenHash, createHash("sha256").update(token).digest("hex")));
    expect(grant!.usedAt).toBeNull();
    // positive control: with the owner it was decided on, the rename and the owner change land together, audited
    await db.update(mcpServers).set({ ownerUserId: null }).where(eq(mcpServers.id, serverId));
    const ok = await asAdmin("PATCH", `/v1/servers/${serverId}`, { name: `sds-srv-cas-renamed-${RUN}`, ownerUserId: admin.id }, { [STEP_UP_HEADER]: token });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ name: `sds-srv-cas-renamed-${RUN}`, ownerUserId: admin.id });
    expect((await lastAudit("mcp-server-owner-changed", serverId))!.detail).toMatchObject({ transitions: { ownerUserId: { from: null, to: admin.id } } });
    const [spent] = await db.select().from(stepUpGrants).where(eq(stepUpGrants.tokenHash, createHash("sha256").update(token).digest("hex")));
    expect(spent!.usedAt).not.toBeNull();
  });
});

describe("PATCH /v1/servers/:serverId: an owner id in another case is the same owner", () => {
  it("an uppercase owner id asks for and accepts the grant of the stored (lowercase) id; restating it is no change", async () => {
    const srv = await asAdmin("POST", "/v1/servers", { name: `sds-srv-case-${RUN}`, url: `${REGISTRY_URL}case`, ownerUserId: null });
    expect(srv.statusCode, srv.body).toBe(201);
    const serverId = srv.json().id as string;
    created.servers.push(serverId);
    const upper = admin.id.toUpperCase();
    expect(upper).not.toBe(admin.id);
    // the prompt's facts name the id as the database returns it, so a grant for them is the one the claim accepts
    const asked = await asAdmin("PATCH", `/v1/servers/${serverId}`, { ownerUserId: upper });
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required" });
    expect(asked.json().action).toEqual({ kind: "owner_change", body: { objectType: "mcp_server", objectId: serverId, ownerUserId: admin.id } });
    const token = await grantFor(asked.json().action);
    const ok = await asAdmin("PATCH", `/v1/servers/${serverId}`, { ownerUserId: upper }, { [STEP_UP_HEADER]: token });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ ownerUserId: admin.id });
    expect((await lastAudit("mcp-server-owner-changed", serverId))!.detail).toMatchObject({ transitions: { ownerUserId: { from: null, to: admin.id } } });
    const [spent] = await db.select().from(stepUpGrants).where(eq(stepUpGrants.tokenHash, createHash("sha256").update(token).digest("hex")));
    expect(spent!.usedAt).not.toBeNull();
    // the current owner in uppercase: no change, so no step-up is asked and the owner stays as stored
    const again = await asAdmin("PATCH", `/v1/servers/${serverId}`, { ownerUserId: upper });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ ownerUserId: admin.id });
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    expect(row!.ownerUserId).toBe(admin.id);
    // the restatement names the stored id on both sides (the same row an exact spelling writes), never a case change
    expect((await lastAudit("mcp-server-owner-changed", serverId))!.detail).toMatchObject({ transitions: { ownerUserId: { from: admin.id, to: admin.id } } });
  });
});

describe("a duplicate name is refused before a grant is asked for", () => {
  it("relaxing creates of an agent, a registry and a server answer 409, not a step-up prompt", async () => {
    const reg = await asAdmin("POST", "/v1/mcp-registries", { name: `sds-plain-${RUN}`, url: REGISTRY_URL, enabled: true });
    expect(reg.statusCode, reg.body).toBe(409);
    expect(reg.json().error).toBe("conflict");
    const srv = await asAdmin("POST", "/v1/servers", { name: `sds-srv-plain-${RUN}`, url: `${REGISTRY_URL}mcp`, allowPrivateRanges: true });
    expect(srv.statusCode, srv.body).toBe(409);
    expect(srv.json().error).toBe("conflict");
    const agent = await asAdmin("POST", "/v1/agents", { name: `sds-agent-${RUN}`, provider: "mock", tier: 1, model: "m", expectedServedModel: "x" });
    expect(agent.statusCode, agent.body).toBe(409);
    expect(agent.json().error).toBe("conflict");
  });
});
