/**
 * ADR-0098 e2e — API-KEY EXPIRY, proved against a live app over real HTTP.
 *
 * THE PROPERTY EACH BLOCK EXISTS TO HOLD:
 *
 *  1. STRICT AT THE SHIPPED DEFAULTS (ADR-0181, migration 0156). A fresh org
 *     reads 90 / 365 days, a key issued with no `expiresAt` expires in 90
 *     days, and "never expires" is refused by the ceiling. An admin who
 *     clears both dials (audited, old -> new) gets the pre-0181 behaviour:
 *     no expiry, `state: "active"`.
 *  2. A KEY WITH A TTL AUTHENTICATES BEFORE AND FAILS AFTER. The clock is
 *     moved by writing `expires_at` directly rather than by sleeping — the
 *     test asserts the ENFORCEMENT, not the passage of time.
 *  3. EXPIRED ≠ REVOKED, in the error AND in the audit trail. Two dead keys,
 *     two different `error` codes, two different `ruleId`s. An operator
 *     debugging "my key stopped working" must be able to tell a lifetime that
 *     ran out from a credential somebody deliberately killed.
 *  4. THE CEILING REFUSES BY NAME. Over-long requests — and the explicit
 *     "never expires" request, which is the longest lifetime there is — are
 *     422s naming the knob and the longest expiry that WOULD be accepted.
 *     Nothing is silently clamped, and nothing is issued.
 *  5. THE ADR-0097 FRONT DOOR. An expired key presented to the MCP proxy
 *     produces the same RFC 6750 401 challenge with `error="invalid_token"`
 *     an invalid key does — the cross-check that expiry rides the door B9
 *     built rather than a private path of its own.
 *  6. THE LIFECYCLE READ shows all four states, so an admin sees what is about
 *     to break before it breaks.
 *
 * SHARED-STATE DISCIPLINE (M-068). This file mutates the `org_settings`
 * singleton's two API-key TTL dials and restores BOTH to the shipped strict
 * 90 / 365 in `afterAll`;
 * it deletes exactly the users it created (keys cascade); and every audit
 * count assertion is a DELTA over a timestamp taken inside the test, never an
 * absolute count.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  and,
  apiKeys,
  auditLog,
  createDb,
  eq,
  gte,
  inArray,
  runMigrations,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { API_KEY_EXPIRING_WINDOW_DAYS } from "./api-key-expiry.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "adr98-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "3".repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;

let db: Db;
let app: ReturnType<typeof buildApp>;
const createdUserIds: string[] = [];

async function makeUser(label: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: `adr98-${label}-${randomUUID()}@example.com`, displayName: `ADR98 ${label}` },
  });
  expect(res.statusCode).toBe(201);
  createdUserIds.push(res.json().id);
  return res.json().id;
}

async function issueKey(userId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${userId}/keys`,
    payload,
  });
}

/** the smallest authenticated call there is — `GET /v1/me` needs no grant */
async function callAs(token: string) {
  return app.inject({ method: "GET", headers: { authorization: `Bearer ${token}` }, url: "/v1/me" });
}

async function setTtlDials(patch: {
  apiKeyDefaultTtlDays?: number | null;
  apiKeyMaxTtlDays?: number | null;
}) {
  const res = await app.inject({
    method: "PUT",
    headers: AUTH,
    url: "/v1/org/settings",
    payload: patch,
  });
  expect(res.statusCode).toBe(200);
  return res;
}

/** the MCP proxy front door (ADR-0023/0097). The server id need not exist: the
 * auth hook runs first, and the test below proves it by showing a VALID key on
 * the same URL gets something other than a 401. */
async function proxyListTools(serverId: string, headers: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: `/mcp/${serverId}`,
    headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
});

/** ADR-0181: the shipped strict dials, which every block below restores */
const STRICT_TTL = { apiKeyDefaultTtlDays: 90, apiKeyMaxTtlDays: 365 } as const;
/** the pre-0181 posture an admin may still choose: no default, no ceiling */
const RELAXED_TTL = { apiKeyDefaultTtlDays: null, apiKeyMaxTtlDays: null } as const;

afterAll(async () => {
  // restore the singleton to the SHIPPED (strict) posture for whatever runs next
  await setTtlDials(STRICT_TTL);
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

// ===========================================================================
// 1. THE DEFAULTS CHANGE NOTHING
// ===========================================================================

describe("ADR-0181 — the shipped dials are strict, and an admin may relax them", () => {
  it("both TTL dials ship 90 / 365, and a key issued with no expiry expires in 90 days", async () => {
    const settings = (
      await app.inject({ method: "GET", headers: AUTH, url: "/v1/org/settings" })
    ).json().settings;
    expect(settings.apiKeyDefaultTtlDays).toBe(90);
    expect(settings.apiKeyMaxTtlDays).toBe(365);

    const userId = await makeUser("strict");
    const issued = await issueKey(userId, { name: "strict-default" });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().expirySource).toBe("org_default");
    const expiresAt = new Date(issued.json().expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now() + 89 * DAY_MS);
    expect(expiresAt).toBeLessThan(Date.now() + 91 * DAY_MS);
    // "never expires" is the longest lifetime there is: over the ceiling
    const forever = await issueKey(userId, { name: "forever", expiresAt: null });
    expect(forever.statusCode).toBe(422);
    expect(forever.json().error).toBe("api_key_expiry_exceeds_ceiling");
  });

  it("clearing both dials is audited old -> new, and then a key issued with no expiry never expires", async () => {
    const since = new Date(Date.now() - 1000);
    await setTtlDials(RELAXED_TTL);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "org-settings-updated"), gte(auditLog.at, since)));
    expect((audit!.detail as { transitions: unknown }).transitions).toEqual({
      apiKeyDefaultTtlDays: { from: 90, to: null },
      apiKeyMaxTtlDays: { from: 365, to: null },
    });

    const userId = await makeUser("default");
    const issued = await issueKey(userId, { name: "no-expiry" });
    expect(issued.statusCode).toBe(201);
    // the expiry is DISCLOSED on the response even when it is "never"
    expect(issued.json().expiresAt).toBeNull();
    expect(issued.json().expirySource).toBe("none");

    const used = await callAs(issued.json().token);
    expect(used.statusCode).toBe(200);
    expect(used.json().userId).toBe(userId);

    const listed = await app.inject({ method: "GET", headers: AUTH, url: `/v1/keys?userId=${userId}` });
    expect(listed.json().keys).toHaveLength(1);
    expect(listed.json().keys[0].expiresAt).toBeNull();
    expect(listed.json().keys[0].state).toBe("active");
    await setTtlDials(STRICT_TTL);
  });

  it("an EXISTING row (expires_at NULL, as migration 0104 leaves every one) still authenticates", async () => {
    const userId = await makeUser("grandfathered");
    const issued = await issueKey(userId, { name: "grandfathered" });
    // exactly the shape migration 0104 leaves behind on an upgraded install
    // (migration 0156 sets the dials, not the expiry of keys already issued)
    await db.update(apiKeys).set({ expiresAt: null }).where(eq(apiKeys.id, issued.json().id));
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, issued.json().id));
    expect(row!.expiresAt).toBeNull();
    expect((await callAs(issued.json().token)).statusCode).toBe(200);
  });
});

// ===========================================================================
// 2 + 3. ENFORCEMENT, AND THE EXPIRED/REVOKED DISTINCTION
// ===========================================================================

describe("ADR-0098 — enforcement in authenticate()", () => {
  it("a key with a TTL authenticates BEFORE its expiry and fails AFTER it", async () => {
    const userId = await makeUser("ttl");
    const issued = await issueKey(userId, {
      name: "ttl",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().expirySource).toBe("caller");
    const token = issued.json().token;

    // BEFORE
    expect((await callAs(token)).statusCode).toBe(200);

    // move the clock by writing the column, not by sleeping: the subject is
    // the enforcement, not the passage of time
    const since = new Date();
    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, issued.json().id));

    // AFTER
    const dead = await callAs(token);
    expect(dead.statusCode).toBe(401);
    expect(dead.json().error).toBe("api_key_expired");
    expect(dead.json().detail).toContain("expired");

    // and the refusal is IN THE AUDIT TRAIL with its own discriminating ruleId
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, issued.json().id), gte(auditLog.at, since)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ruleId).toBe("api-key-refused-expired");
    expect(rows[0]!.effect).toBe("deny");
    expect(rows[0]!.objectType).toBe("api_key");
    expect(rows[0]!.userId).toBe(userId);

    // a refused presentation is NOT a use — lastUsedAt is left where the last
    // successful call put it
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, issued.json().id));
    expect(row!.lastUsedAt!.getTime()).toBeLessThan(since.getTime());
  });

  it("EXPIRED and REVOKED are different answers and different audit rows", async () => {
    const userId = await makeUser("distinct");
    const expiring = await issueKey(userId, {
      name: "will-expire",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const revoking = await issueKey(userId, { name: "will-be-revoked" });

    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, expiring.json().id));
    const revoked = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/keys/${revoking.json().id}/revoke`,
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);

    const since = new Date();
    const expiredRes = await callAs(expiring.json().token);
    const revokedRes = await callAs(revoking.json().token);

    // both are 401 — but they say DIFFERENT things
    expect(expiredRes.statusCode).toBe(401);
    expect(revokedRes.statusCode).toBe(401);
    expect(expiredRes.json().error).toBe("api_key_expired");
    expect(revokedRes.json().error).toBe("api_key_revoked");
    expect(expiredRes.json().error).not.toBe(revokedRes.json().error);
    expect(expiredRes.json().detail).not.toBe(revokedRes.json().detail);

    // ...and so do their audit rows
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          inArray(auditLog.objectId, [expiring.json().id, revoking.json().id]),
          gte(auditLog.at, since),
        ),
      );
    expect(rows).toHaveLength(2);
    const byKey = new Map(rows.map((r) => [r.objectId, r]));
    expect(byKey.get(expiring.json().id)!.ruleId).toBe("api-key-refused-expired");
    expect(byKey.get(revoking.json().id)!.ruleId).toBe("api-key-refused-revoked");
    expect((byKey.get(expiring.json().id)!.detail as { refusal: string }).refusal).toBe("expired");
    expect((byKey.get(revoking.json().id)!.detail as { refusal: string }).refusal).toBe("revoked");
  });

  it("expiry cannot be bypassed on the key-exchange path either", async () => {
    // `POST /auth/login-with-key` trades a key for a browser SESSION — the
    // owner's full identity. It runs through the same `authenticate()`, so an
    // expired key cannot buy here what it cannot buy anywhere else.
    const userId = await makeUser("exchange");
    const issued = await issueKey(userId, {
      name: "exchange",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const ok = await app.inject({
      method: "POST",
      url: "/auth/login-with-key",
      headers: { "x-regulait-csrf": "1" },
      payload: { apiKey: issued.json().token },
    });
    expect(ok.statusCode).toBe(200);

    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, issued.json().id));

    const refused = await app.inject({
      method: "POST",
      url: "/auth/login-with-key",
      headers: { "x-regulait-csrf": "1" },
      payload: { apiKey: issued.json().token },
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error).toBe("api_key_expired");
  });

  it("the bootstrap token is untouched — an install can never be locked out of its own bootstrap", async () => {
    // it is not an api_keys row at all, so no expiry can ever be attached to it
    expect((await app.inject({ method: "GET", headers: AUTH, url: "/v1/me" })).statusCode).toBe(200);
  });
});

// ===========================================================================
// 4. THE TWO DIALS
// ===========================================================================

describe("ADR-0098 — the org default and the ceiling", () => {
  // each case below sets the one dial it is about, from the relaxed posture
  // (no default, no ceiling); the strict dials come back afterwards (M-068)
  beforeAll(async () => {
    await setTtlDials(RELAXED_TTL);
  });
  afterAll(async () => {
    await setTtlDials(STRICT_TTL);
  });

  it("a DEFAULT TTL applies when the caller supplies nothing, and is disclosed", async () => {
    await setTtlDials({ apiKeyDefaultTtlDays: 30 });
    const userId = await makeUser("orgdefault");
    const issued = await issueKey(userId, { name: "defaulted" });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().expirySource).toBe("org_default");
    const expiresAt = new Date(issued.json().expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now() + 29 * DAY_MS);
    expect(expiresAt).toBeLessThan(Date.now() + 31 * DAY_MS);
    // and it really is enforced, not merely recorded
    expect((await callAs(issued.json().token)).statusCode).toBe(200);
    await setTtlDials({ apiKeyDefaultTtlDays: null });
  });

  it("the CEILING refuses an over-long request BY NAME, and issues nothing", async () => {
    await setTtlDials({ apiKeyMaxTtlDays: 7 });
    const userId = await makeUser("ceiling");
    const before = await app.inject({ method: "GET", headers: AUTH, url: `/v1/keys?userId=${userId}` });

    const refused = await issueKey(userId, {
      name: "too-long",
      expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("api_key_expiry_exceeds_ceiling");
    // the refusal EXPLAINS: the knob, the cap, and the longest expiry that
    // would have been accepted — not a bare code
    expect(refused.json().detail).toContain("apiKeyMaxTtlDays");
    expect(refused.json().detail).toContain("7-day");
    expect(refused.json().detail).toContain("NOT silently shortened");
    expect(refused.json().token).toBeUndefined();

    // NOTHING was issued — a delta, not an absolute count
    const after = await app.inject({ method: "GET", headers: AUTH, url: `/v1/keys?userId=${userId}` });
    expect(after.json().keys.length).toBe(before.json().keys.length);
    await setTtlDials({ apiKeyMaxTtlDays: null });
  });

  it("an EXPLICIT 'never expires' request is refused by the SAME ceiling", async () => {
    // the hole this closes: a ceiling a caller steps over by asking for
    // infinity is not a ceiling
    await setTtlDials({ apiKeyMaxTtlDays: 7 });
    const userId = await makeUser("infinity");
    const refused = await issueKey(userId, { name: "forever", expiresAt: null });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("api_key_expiry_exceeds_ceiling");
    expect(refused.json().detail).toContain("never expires");
    await setTtlDials({ apiKeyMaxTtlDays: null });
  });

  it("with a ceiling and no default, an OMITTED expiry takes the ceiling and says so", async () => {
    await setTtlDials({ apiKeyMaxTtlDays: 7 });
    const userId = await makeUser("omitted");
    const issued = await issueKey(userId, { name: "omitted" });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().expirySource).toBe("org_ceiling");
    expect(new Date(issued.json().expiresAt).getTime()).toBeLessThan(Date.now() + 8 * DAY_MS);
    await setTtlDials({ apiKeyMaxTtlDays: null });
  });

  it("a past expiry is refused before the ceiling is even consulted", async () => {
    const userId = await makeUser("past");
    const refused = await issueKey(userId, {
      name: "past",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("expiry_in_the_past");
  });

  it("a default above the ceiling is refused — the pair must stay coherent", async () => {
    await setTtlDials({ apiKeyMaxTtlDays: 30 });
    const bad = await app.inject({
      method: "PUT",
      headers: AUTH,
      url: "/v1/org/settings",
      payload: { apiKeyDefaultTtlDays: 90 },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe("api_key_ttl_ordering");
    // and nothing was saved
    const settings = (
      await app.inject({ method: "GET", headers: AUTH, url: "/v1/org/settings" })
    ).json().settings;
    expect(settings.apiKeyDefaultTtlDays).toBeNull();
    expect(settings.apiKeyMaxTtlDays).toBe(30);
    await setTtlDials({ apiKeyMaxTtlDays: null });
  });
});

// ===========================================================================
// 5. THE ADR-0097 FRONT DOOR
// ===========================================================================

describe("ADR-0098 × ADR-0097 — an expired key at the MCP proxy", () => {
  it("answers 401 with the RFC 6750 challenge, exactly as an invalid key does", async () => {
    const serverId = randomUUID();
    const userId = await makeUser("mcp");
    const issued = await issueKey(userId, {
      name: "mcp",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const token = issued.json().token;

    // the auth hook really does run before the route: a LIVE key on the same
    // URL gets something other than a 401
    const live = await proxyListTools(serverId, { authorization: `Bearer ${token}` });
    expect(live.statusCode).not.toBe(401);

    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, issued.json().id));

    const expired = await proxyListTools(serverId, { authorization: `Bearer ${token}` });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error).toBe("api_key_expired");
    const challenge = expired.headers["www-authenticate"] as string;
    expect(challenge).toBeTruthy();
    expect(challenge.startsWith("Bearer ")).toBe(true);
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain("resource_metadata=");

    // ...and it is the SAME challenge an invalid key gets, which is the point:
    // expiry rides the door ADR-0097 built rather than a path of its own
    const invalid = await proxyListTools(serverId, { authorization: "Bearer rgl_not-a-real-key" });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.headers["www-authenticate"]).toBe(challenge);

    // and the metadata URL the challenge names really serves the document
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    const meta = await app.inject({ method: "GET", url: new URL(metadataUrl!).pathname });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().resource.endsWith(`/mcp/${serverId}`)).toBe(true);
  });
});

// ===========================================================================
// 6. THE LIFECYCLE READ
// ===========================================================================

describe("ADR-0098 — GET /v1/keys shows what is about to break", () => {
  it("reports all four states, with revoked winning over expired", async () => {
    const userId = await makeUser("states");
    const active = await issueKey(userId, { name: "active" });
    const expiring = await issueKey(userId, { name: "expiring" });
    const expired = await issueKey(userId, { name: "expired" });
    const revoked = await issueKey(userId, { name: "revoked" });

    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() + (API_KEY_EXPIRING_WINDOW_DAYS - 1) * DAY_MS) })
      .where(eq(apiKeys.id, expiring.json().id));
    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, expired.json().id));
    // the revoked one ALSO carries an expiry in the past, so the precedence is
    // actually exercised rather than assumed
    await db
      .update(apiKeys)
      .set({ revokedAt: new Date(), expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, revoked.json().id));

    const listed = await app.inject({ method: "GET", headers: AUTH, url: `/v1/keys?userId=${userId}` });
    const byName = new Map(
      (listed.json().keys as Array<{ name: string; state: string }>).map((k) => [k.name, k.state]),
    );
    expect(byName.get("active")).toBe("active");
    expect(byName.get("expiring")).toBe("expiring");
    expect(byName.get("expired")).toBe("expired");
    expect(byName.get("revoked")).toBe("revoked");
    // the token is never in a listing, expiry or not
    expect(listed.body).not.toContain(active.json().token);
  });
});
