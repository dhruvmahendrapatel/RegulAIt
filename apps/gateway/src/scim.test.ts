/**
 * ADR-0037 e2e — SCIM 2.0 provisioning, proof-by-attack.
 *
 * The happy path here is small. Almost everything below is an attempt to make
 * the implementation break one of the four promises the ADR makes:
 *
 *  1. SCIM is a SEPARATE TRUST PATH — a user session cookie, a user's API key
 *     and the deploy-time bootstrap token are each tried against /scim/v2 and
 *     each must be refused. A provisioning surface reachable with a human
 *     credential is not a separate trust path, it is a privilege escalation.
 *  2. DEPROVISION IS DEACTIVATE — the load-bearing test in this file. A user is
 *     provisioned, given a live session AND a live API key, then deprovisioned
 *     through both SCIM signals (`active:false` and `DELETE`). Each must kill
 *     the session and the key while leaving the ROW in place (asserted with a
 *     direct DB select, not by asking the API), and reactivation must restore
 *     authentication with the SAME key.
 *  3. SCIM CANNOT ESCALATE — a payload that asserts admin, or a password, or a
 *     local username, gets none of them.
 *  4. IDEMPOTENCY — connectors retry aggressively; a double create, a double
 *     deactivate and a replayed full group sync must all converge.
 *
 * Plus: the equality-filter subset answers correctly and refuses what it does
 * not implement (a silently-ignored filter is a WRONG 200, which is how
 * duplicate accounts get created), the per-token rate limit answers 429 with
 * Retry-After, and every provisioning act is in the audit trail with the
 * acting token named as the actor.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  and,
  authSessions,
  auditLog,
  createDb,
  eq,
  isNull,
  roleAssignments,
  scimGroupMembers,
  scimGroups,
  scimTokens,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { hashToken } from "./auth.js";
import { parseScimFilter, scimErrorBody, SCIM_TOKEN_PREFIX } from "./scim.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "scim-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const SCIM_JSON = { "content-type": "application/scim+json" };

let db: Db;
let app: ReturnType<typeof buildApp>;
/** the plaintext of the suite's working SCIM token (shown once, then held) */
let TOKEN: string;
let TOKEN_ID: string;
const TOKEN_NAME = `okta-suite-${randomBytes(3).toString("hex")}`;
const SCIM = () => ({ authorization: `Bearer ${TOKEN}` });

const uniq = (label: string) => `${label}.${randomBytes(4).toString("hex")}@corp.example`;

// --- thin request helpers ---------------------------------------------------

const scimPost = (url: string, payload: unknown, headers: Record<string, string> = SCIM()) =>
  app.inject({ method: "POST", url, headers: { ...headers, ...SCIM_JSON }, payload: payload as object });
const scimPatch = (url: string, payload: unknown, headers: Record<string, string> = SCIM()) =>
  app.inject({ method: "PATCH", url, headers: { ...headers, ...SCIM_JSON }, payload: payload as object });
const scimPut = (url: string, payload: unknown, headers: Record<string, string> = SCIM()) =>
  app.inject({ method: "PUT", url, headers: { ...headers, ...SCIM_JSON }, payload: payload as object });
const scimGet = (url: string, headers: Record<string, string> = SCIM()) =>
  app.inject({ method: "GET", url, headers });
const scimDelete = (url: string, headers: Record<string, string> = SCIM()) =>
  app.inject({ method: "DELETE", url, headers });

/** create a user through SCIM and return the parsed resource */
async function provision(
  email: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; body: Record<string, unknown> }> {
  const res = await scimPost("/scim/v2/Users", {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: email,
    name: { formatted: "Provisioned Person" },
    emails: [{ value: email, primary: true, type: "work" }],
    active: true,
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  return { id: body.id as string, body };
}

const dbUser = async (id: string) => {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row ?? null;
};

/** exchange a user's API key for a browser session cookie */
async function sessionFor(apiKey: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login-with-key",
    headers: CSRF,
    payload: { apiKey },
  });
  expect(res.statusCode, res.body).toBe(200);
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
  return raw.slice(0, raw.indexOf(";"));
}

/** mint an API key for a user (admin route) */
async function keyFor(userId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/users/${userId}/keys`,
    headers: ADMIN,
    payload: { name: "scim-test" },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().token as string;
}

const auditRows = (ruleId: string, objectId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)));

beforeAll(async () => {
  const { runMigrations } = await import("@regulait/db");
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const issued = await app.inject({
    method: "POST",
    url: "/v1/scim/tokens",
    headers: ADMIN,
    payload: { name: TOKEN_NAME },
  });
  expect(issued.statusCode, issued.body).toBe(201);
  TOKEN = issued.json().token as string;
  TOKEN_ID = issued.json().id as string;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

// ===========================================================================

describe("ADR-0037 — the token is the ONLY credential", () => {
  it("issues a token whose plaintext is returned exactly once and stored as sha256", async () => {
    expect(TOKEN.startsWith(SCIM_TOKEN_PREFIX)).toBe(true);
    const [row] = await db.select().from(scimTokens).where(eq(scimTokens.id, TOKEN_ID));
    expect(row!.tokenHash).toBe(hashToken(TOKEN));
    // the secret itself is nowhere in the row, and the list endpoint never
    // returns it either
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    const list = await app.inject({ method: "GET", url: "/v1/scim/tokens", headers: ADMIN });
    expect(list.body).not.toContain(TOKEN);
  });

  it("no credential at all -> 401 with a SCIM error envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/scim/v2/Users" });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    expect(body.status).toBe("401");
  });

  it("a valid token -> 200", async () => {
    const res = await scimGet("/scim/v2/Users?filter=" + encodeURIComponent('userName eq "nobody@corp.example"'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:ListResponse"]);
  });

  it("a REVOKED token -> 401, and the revocation is immediate", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/scim/tokens",
      headers: ADMIN,
      payload: { name: `doomed-${randomBytes(3).toString("hex")}` },
    });
    const doomed = issued.json().token as string;
    const doomedId = issued.json().id as string;
    const before = await scimGet("/scim/v2/Users?filter=" + encodeURIComponent('userName eq "x@y.example"'), {
      authorization: `Bearer ${doomed}`,
    });
    expect(before.statusCode).toBe(200);

    const revoked = await app.inject({
      method: "POST",
      url: `/v1/scim/tokens/${doomedId}/revoke`,
      headers: ADMIN,
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);

    const after = await scimGet("/scim/v2/Users", { authorization: `Bearer ${doomed}` });
    expect(after.statusCode).toBe(401);
    // and a revoked token cannot be rotated back into service
    const rotate = await app.inject({
      method: "POST",
      url: `/v1/scim/tokens/${doomedId}/rotate`,
      headers: ADMIN,
      payload: {},
    });
    expect(rotate.statusCode).toBe(409);
  });

  it("ROTATION kills the previous secret immediately and mints a new working one", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/scim/tokens",
      headers: ADMIN,
      payload: { name: `rotating-${randomBytes(3).toString("hex")}` },
    });
    const oldSecret = issued.json().token as string;
    const id = issued.json().id as string;
    const rotated = await app.inject({
      method: "POST",
      url: `/v1/scim/tokens/${id}/rotate`,
      headers: ADMIN,
      payload: {},
    });
    expect(rotated.statusCode).toBe(200);
    const newSecret = rotated.json().token as string;
    expect(newSecret).not.toBe(oldSecret);
    expect((await scimGet("/scim/v2/Users", { authorization: `Bearer ${oldSecret}` })).statusCode).toBe(401);
    expect(
      (await scimGet("/scim/v2/Users?filter=" + encodeURIComponent('id eq "not-a-uuid"'), {
        authorization: `Bearer ${newSecret}`,
      })).statusCode,
    ).toBe(200);
  });

  // --- the escalation attempts ---------------------------------------------

  it("a USER's API key is refused at /scim/v2 (separate trust path)", async () => {
    const email = uniq("keyholder");
    const created = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: ADMIN,
      payload: { email, displayName: "Key Holder", isAdmin: true },
    });
    const userId = created.json().id as string;
    const key = await keyFor(userId);
    // the key is genuinely valid on the normal surface...
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${key}` } });
    expect(me.statusCode).toBe(200);
    // ...and worth nothing here, even though its holder is an ADMIN
    const res = await scimGet("/scim/v2/Users", { authorization: `Bearer ${key}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
  });

  it("a browser SESSION COOKIE is refused at /scim/v2", async () => {
    const email = uniq("cookie.admin");
    const created = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: ADMIN,
      payload: { email, displayName: "Cookie Admin", isAdmin: true },
    });
    const key = await keyFor(created.json().id as string);
    const cookie = await sessionFor(key);
    // the cookie works on the normal surface
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    // and not here — no Authorization header means no SCIM credential
    const res = await app.inject({ method: "GET", url: "/scim/v2/Users", headers: { cookie } });
    expect(res.statusCode).toBe(401);
    const write = await app.inject({
      method: "POST",
      url: "/scim/v2/Users",
      headers: { cookie, ...CSRF, ...SCIM_JSON },
      payload: { userName: uniq("via.cookie") },
    });
    expect(write.statusCode).toBe(401);
    // nothing was created by the refused write
    const [row] = await db.select().from(users).where(sql`${users.displayName} = 'via.cookie'`);
    expect(row).toBeUndefined();
  });

  it("the deploy-time BOOTSTRAP token is refused at /scim/v2", async () => {
    const res = await scimGet("/scim/v2/Users", ADMIN);
    expect(res.statusCode).toBe(401);
  });

  it("a valid token updates last_used_at (the sync-status signal)", async () => {
    const [before] = await db.select().from(scimTokens).where(eq(scimTokens.id, TOKEN_ID));
    expect(before!.lastUsedAt).not.toBeNull();
    const status = await app.inject({ method: "GET", url: "/v1/scim/status", headers: ADMIN });
    expect(status.statusCode).toBe(200);
    expect(status.json().unmappedGroupsGrantEntitlement).toBe(false);
    expect(status.json().isAdminGroupDerivable).toBe(false);
  });
});

// ===========================================================================

describe("ADR-0037 — /Users create", () => {
  it("maps userName/emails onto users.email, lowercased, with a SCIM envelope", async () => {
    const email = uniq("Mixed.Case");
    const res = await scimPost("/scim/v2/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: email.toUpperCase(),
      emails: [{ value: email.toUpperCase(), primary: true }],
      displayName: "Mixed Case",
      externalId: "idp-" + randomBytes(4).toString("hex"),
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers["content-type"]).toContain("application/scim+json");
    expect(res.headers.location).toBe(`/scim/v2/Users/${res.json().id}`);
    const body = res.json();
    expect(body.schemas).toEqual(["urn:ietf:params:scim:schemas:core:2.0:User"]);
    expect(body.userName).toBe(email.toLowerCase());
    expect(body.active).toBe(true);
    const row = await dbUser(body.id);
    expect(row!.email).toBe(email.toLowerCase());
    expect(row!.displayName).toBe("Mixed Case");
  });

  it("NEVER sets a password: the created user has none and cannot password-login", async () => {
    const email = uniq("nopassword");
    const { id } = await provision(email, { password: "Hunter2-Hunter2!" });
    const row = await dbUser(id);
    expect(row!.passwordHash).toBeNull();
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: CSRF,
      payload: { identifier: email, password: "Hunter2-Hunter2!" },
    });
    expect(login.statusCode).toBe(401);
  });

  it("NEVER makes an admin, however hard the payload asserts it", async () => {
    const email = uniq("wannabe.admin");
    const { id } = await provision(email, {
      isAdmin: true,
      admin: true,
      roles: [{ value: "admin", primary: true }],
      "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { department: "admins" },
    });
    const row = await dbUser(id);
    expect(row!.isAdmin).toBe(false);
    // and no role was assigned either — SCIM grants nothing
    const grants = await db.select().from(roleAssignments).where(eq(roleAssignments.userId, id));
    expect(grants).toHaveLength(0);
  });

  it("NEVER writes users.username (ADR-0030), even when the payload contains one", async () => {
    const email = uniq("has.username");
    const { id } = await provision(email, { username: "rootadmin", nickName: "rootadmin" });
    const row = await dbUser(id);
    expect(row!.username).toBeNull();
    // and a PATCH cannot reach it either
    const patched = await scimPatch(`/scim/v2/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "userName", value: uniq("renamed") }],
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await dbUser(id))!.username).toBeNull();
  });

  it("refuses a payload with no email-shaped mapping key", async () => {
    const res = await scimPost("/scim/v2/Users", { userName: "not-an-email", displayName: "X" });
    expect(res.statusCode).toBe(400);
    expect(res.json().scimType).toBe("invalidValue");
  });

  it("honours active:false at create time (born deprovisioned)", async () => {
    const email = uniq("born.inactive");
    const res = await scimPost("/scim/v2/Users", { userName: email, active: false });
    expect(res.statusCode).toBe(201);
    expect(res.json().active).toBe(false);
    expect((await dbUser(res.json().id))!.disabledAt).not.toBeNull();
  });
});

// ===========================================================================
// THE security-critical suite
// ===========================================================================

describe("ADR-0037 — deprovision is DEACTIVATE, never delete", () => {
  it("PATCH active:false kills the session and the key, keeps the row, and reactivation restores both", async () => {
    const email = uniq("offboard.patch");
    const { id } = await provision(email);
    const key = await keyFor(id);
    const cookie = await sessionFor(key);

    // both credentials work before deprovisioning
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } })).statusCode).toBe(200);

    const res = await scimPatch(`/scim/v2/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().active).toBe(false);

    // 1. the flag is set, and 2. THE ROW STILL EXISTS — asserted straight
    // against the database, not by asking the API that just wrote it
    const row = await dbUser(id);
    expect(row).not.toBeNull();
    expect(row!.disabledAt).not.toBeNull();
    expect(row!.email).toBe(email);

    // 3. the session is dead on the very next request
    const withCookie = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(withCookie.statusCode).toBe(401);
    // the refusal is the GENERIC `unauthenticated`, not `user_disabled`, and
    // that is the stronger outcome: the row's `revoked_at` is set, so
    // resolveSession never gets as far as looking at the user's flag. The
    // session is not merely being refused — it no longer exists.
    expect(withCookie.json().error).toBe("unauthenticated");
    const live = await db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.userId, id), isNull(authSessions.revokedAt)));
    expect(live).toHaveLength(0);

    // 4. the API key no longer authenticates
    const withKey = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(withKey.statusCode).toBe(401);
    expect(withKey.json().error).toBe("user_disabled");

    // 5. reactivation restores the account — with the SAME key, untouched
    const back = await scimPatch(`/scim/v2/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().active).toBe(true);
    expect((await dbUser(id))!.disabledAt).toBeNull();
    const again = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(again.statusCode).toBe(200);
  });

  it("DELETE /Users/:id deactivates too — 204, row still present, credentials dead", async () => {
    const email = uniq("offboard.delete");
    const { id } = await provision(email);
    const key = await keyFor(id);
    const cookie = await sessionFor(key);

    const res = await scimDelete(`/scim/v2/Users/${id}`);
    expect(res.statusCode, res.body).toBe(204);

    // THE assertion: a direct DB read proves nothing was deleted
    const [row] = await db.select().from(users).where(eq(users.id, id));
    expect(row).toBeDefined();
    expect(row!.email).toBe(email);
    expect(row!.disabledAt).not.toBeNull();

    expect((await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${key}` } })).statusCode,
    ).toBe(401);

    // disclosed deviation from RFC 7644: the resource is still READABLE after
    // DELETE, reported as inactive rather than 404 — the record survives
    const after = await scimGet(`/scim/v2/Users/${id}`);
    expect(after.statusCode).toBe(200);
    expect(after.json().active).toBe(false);

    // and it is reversible, which a delete would not be
    const back = await scimPatch(`/scim/v2/Users/${id}`, {
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    expect(back.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${key}` } })).statusCode,
    ).toBe(200);
  });

  it("PUT with active:false deprovisions on the same path", async () => {
    const email = uniq("offboard.put");
    const { id } = await provision(email);
    const res = await scimPut(`/scim/v2/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: email,
      displayName: "Renamed By IdP",
      active: false,
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await dbUser(id);
    expect(row!.disabledAt).not.toBeNull();
    expect(row!.displayName).toBe("Renamed By IdP");
  });
});

// ===========================================================================

describe("ADR-0037 — idempotency", () => {
  it("a re-POST of an existing email is a 409 uniqueness and creates NO duplicate", async () => {
    const email = uniq("double.create");
    const first = await scimPost("/scim/v2/Users", { userName: email, displayName: "First" });
    expect(first.statusCode).toBe(201);
    const second = await scimPost("/scim/v2/Users", { userName: email, displayName: "Second" });
    expect(second.statusCode).toBe(409);
    expect(second.json().scimType).toBe("uniqueness");
    const rows = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe("First"); // the second attempt changed nothing
  });

  it("PATCH active:false twice answers 200 both times and audits the transition once", async () => {
    const email = uniq("double.disable");
    const { id } = await provision(email);
    const op = {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }],
    };
    const one = await scimPatch(`/scim/v2/Users/${id}`, op);
    const two = await scimPatch(`/scim/v2/Users/${id}`, op);
    expect(one.statusCode).toBe(200);
    expect(two.statusCode).toBe(200);
    expect(two.json().active).toBe(false);
    const rows = await auditRows("scim-user-deactivated", id);
    expect(rows).toHaveLength(1); // the no-op is a no-op, not a second event
  });

  it("DELETE on an already-deactivated user is still 204 (connectors retry)", async () => {
    const { id } = await provision(uniq("delete.twice"));
    expect((await scimDelete(`/scim/v2/Users/${id}`)).statusCode).toBe(204);
    expect((await scimDelete(`/scim/v2/Users/${id}`)).statusCode).toBe(204);
    expect(await dbUser(id)).not.toBeNull();
  });
});

// ===========================================================================

describe("ADR-0037 — the equality-filter subset", () => {
  it("parses only <attr> eq \"<value>\"", () => {
    expect(parseScimFilter('userName eq "a@b.example"')).toEqual({
      attribute: "userName",
      value: "a@b.example",
    });
    expect(parseScimFilter('userName co "a"')).toBeNull();
    expect(parseScimFilter('userName eq "a" and active eq true')).toBeNull();
    expect(parseScimFilter("userName pr")).toBeNull();
    expect(parseScimFilter('not (userName eq "a")')).toBeNull();
  });

  it("userName eq returns exactly the right user", async () => {
    const email = uniq("findable");
    const { id } = await provision(email);
    await provision(uniq("decoy"));
    const res = await scimGet("/scim/v2/Users?filter=" + encodeURIComponent(`userName eq "${email}"`));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.totalResults).toBe(1);
    expect(body.itemsPerPage).toBe(1);
    expect(body.startIndex).toBe(1);
    expect(body.Resources).toHaveLength(1);
    expect(body.Resources[0].id).toBe(id);
    // the same key, asked the two other ways a connector asks it
    for (const attr of ["emails", "emails.value"]) {
      const alt = await scimGet("/scim/v2/Users?filter=" + encodeURIComponent(`${attr} eq "${email}"`));
      expect(alt.json().Resources[0].id, attr).toBe(id);
    }
    // case-insensitive, because email is the case-insensitive mapping key
    const upper = await scimGet(
      "/scim/v2/Users?filter=" + encodeURIComponent(`userName eq "${email.toUpperCase()}"`),
    );
    expect(upper.json().totalResults).toBe(1);
  });

  it("externalId eq finds the user an IdP correlates by id after an email change", async () => {
    const externalId = "idp-" + randomBytes(6).toString("hex");
    const { id } = await provision(uniq("before.rename"), { externalId });
    const newEmail = uniq("after.rename");
    const patched = await scimPatch(`/scim/v2/Users/${id}`, {
      Operations: [{ op: "replace", path: "emails", value: [{ value: newEmail, primary: true }] }],
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await dbUser(id))!.email).toBe(newEmail);
    const res = await scimGet("/scim/v2/Users?filter=" + encodeURIComponent(`externalId eq "${externalId}"`));
    expect(res.json().totalResults).toBe(1);
    expect(res.json().Resources[0].id).toBe(id);
    // one account, not two — which is the whole point of persisting the id
    const rows = await db.select().from(users).where(eq(users.scimExternalId, externalId));
    expect(rows).toHaveLength(1);
  });

  it("an UNSUPPORTED filter is a SCIM error, never a wrong 200", async () => {
    for (const filter of [
      'userName co "corp"',
      'userName sw "a"',
      'userName eq "a@b.example" and active eq true',
      "userName pr",
      'displayName eq "x"', // a real attribute, but not one /Users filters on
      'meta.lastModified gt "2020-01-01T00:00:00Z"',
    ]) {
      const res = await scimGet("/scim/v2/Users?filter=" + encodeURIComponent(filter));
      expect(res.statusCode, filter).toBe(400);
      expect(res.json().scimType, filter).toBe("invalidFilter");
      expect(res.json().schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    }
  });

  it("GET /Users/:id 404s in a SCIM envelope for an unknown id", async () => {
    const res = await scimGet("/scim/v2/Users/00000000-0000-0000-0000-0000000000ff");
    expect(res.statusCode).toBe(404);
    expect(res.json().status).toBe("404");
  });

  it("an unsupported PATCH path is refused rather than silently ignored", async () => {
    const { id } = await provision(uniq("strict.patch"));
    const res = await scimPatch(`/scim/v2/Users/${id}`, {
      Operations: [{ op: "replace", path: "title", value: "CEO" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().scimType).toBe("invalidPath");
  });
});

// ===========================================================================

describe("ADR-0037 — /Groups records membership; an UNMAPPED group grants NOTHING", () => {
  /**
   * ADR-0038 landed the admin-defined group→role mapping this ADR deliberately
   * stopped short of, so the promise this test locks has moved by exactly one
   * word and not one inch further: a synced group grants nothing UNLESS an
   * admin mapped it. No mapping exists here, and the default-deny outcome is
   * unchanged — no role, no admin bit, nothing. (The mapped case, and the
   * proof that a mapping still cannot reach `isAdmin`, live in
   * group-role-mapping.test.ts.)
   */
  it("creates a group, reconciles members, and — unmapped — hands out no entitlement", async () => {
    const a = await provision(uniq("group.a"));
    const b = await provision(uniq("group.b"));
    const externalId = "grp-" + randomBytes(5).toString("hex");
    const res = await scimPost("/scim/v2/Groups", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "Platform Engineers",
      externalId,
      members: [{ value: a.id }, { value: b.id }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const groupId = res.json().id as string;
    expect(res.json().members).toHaveLength(2);

    const members = await db
      .select()
      .from(scimGroupMembers)
      .where(eq(scimGroupMembers.groupId, groupId));
    expect(members).toHaveLength(2);

    // THE default-deny point: nobody mapped this group, so membership in it
    // granted nothing — not a role, and certainly not the admin bit.
    for (const u of [a.id, b.id]) {
      expect(await db.select().from(roleAssignments).where(eq(roleAssignments.userId, u))).toHaveLength(0);
      expect((await dbUser(u))!.isAdmin).toBe(false);
    }
    const status = await app.inject({ method: "GET", url: "/v1/scim/status", headers: ADMIN });
    expect(status.json().unmappedGroupsGrantEntitlement).toBe(false);
    expect(status.json().isAdminGroupDerivable).toBe(false);
    // the count exists so "12 groups synced" and "2 grant anything" are
    // visibly different numbers; THIS group is not among the mapped ones
    expect(typeof status.json().counts.mappedGroups).toBe("number");
  });

  it("a REPLAYED full group PUT converges — identical membership, no duplicate rows", async () => {
    const a = await provision(uniq("replay.a"));
    const b = await provision(uniq("replay.b"));
    const c = await provision(uniq("replay.c"));
    const created = await scimPost("/scim/v2/Groups", {
      displayName: "Replay Squad",
      externalId: "grp-" + randomBytes(5).toString("hex"),
      members: [{ value: a.id }, { value: b.id }],
    });
    const groupId = created.json().id as string;

    const fullSync = {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "Replay Squad",
      members: [{ value: a.id }, { value: b.id }],
    };
    for (let i = 0; i < 3; i++) {
      const res = await scimPut(`/scim/v2/Groups/${groupId}`, fullSync);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().members).toHaveLength(2);
    }
    const rows = await db.select().from(scimGroupMembers).where(eq(scimGroupMembers.groupId, groupId));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([a.id, b.id]));
    // exactly two add events across four identical pushes — the replays wrote
    // nothing, which is what "converges" has to mean
    const added = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "scim-group-member-added"), eq(auditLog.objectId, groupId)));
    expect(added).toHaveLength(2);

    // now a real delta: swap b for c in one push
    const delta = await scimPut(`/scim/v2/Groups/${groupId}`, {
      displayName: "Replay Squad",
      members: [{ value: a.id }, { value: c.id }],
    });
    expect(delta.statusCode).toBe(200);
    const after = await db.select().from(scimGroupMembers).where(eq(scimGroupMembers.groupId, groupId));
    expect(new Set(after.map((r) => r.userId))).toEqual(new Set([a.id, c.id]));
  });

  it("PATCH add/remove members, including the members[value eq \"…\"] shape", async () => {
    const a = await provision(uniq("patch.a"));
    const b = await provision(uniq("patch.b"));
    const created = await scimPost("/scim/v2/Groups", {
      displayName: "Patch Crew",
      externalId: "grp-" + randomBytes(5).toString("hex"),
    });
    const groupId = created.json().id as string;

    const add = await scimPatch(`/scim/v2/Groups/${groupId}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "add", path: "members", value: [{ value: a.id }, { value: b.id }] }],
    });
    expect(add.statusCode, add.body).toBe(200);
    expect(add.json().members).toHaveLength(2);

    // re-adding the same member is a converging no-op, not a duplicate
    await scimPatch(`/scim/v2/Groups/${groupId}`, {
      Operations: [{ op: "add", path: "members", value: [{ value: a.id }] }],
    });
    expect(
      await db.select().from(scimGroupMembers).where(eq(scimGroupMembers.groupId, groupId)),
    ).toHaveLength(2);

    const remove = await scimPatch(`/scim/v2/Groups/${groupId}`, {
      Operations: [{ op: "remove", path: `members[value eq "${b.id}"]` }],
    });
    expect(remove.statusCode, remove.body).toBe(200);
    expect(remove.json().members).toHaveLength(1);
    expect(remove.json().members[0].value).toBe(a.id);
  });

  it("refuses a group whose members are not provisioned, loudly", async () => {
    const res = await scimPost("/scim/v2/Groups", {
      displayName: "Ghosts",
      members: [{ value: "00000000-0000-0000-0000-0000000000aa" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().scimType).toBe("invalidValue");
  });

  it("a duplicate externalId is a 409, and displayName eq finds the group", async () => {
    const externalId = "grp-" + randomBytes(5).toString("hex");
    const name = `Unique Squad ${randomBytes(3).toString("hex")}`;
    const first = await scimPost("/scim/v2/Groups", { displayName: name, externalId });
    expect(first.statusCode).toBe(201);
    const dup = await scimPost("/scim/v2/Groups", { displayName: name, externalId });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().scimType).toBe("uniqueness");
    expect(await db.select().from(scimGroups).where(eq(scimGroups.externalId, externalId))).toHaveLength(1);

    const found = await scimGet("/scim/v2/Groups?filter=" + encodeURIComponent(`displayName eq "${name}"`));
    expect(found.json().totalResults).toBe(1);
    const bad = await scimGet("/scim/v2/Groups?filter=" + encodeURIComponent('displayName co "Squad"'));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().scimType).toBe("invalidFilter");
  });

  it("deleting a group removes membership records and touches NO user account", async () => {
    const a = await provision(uniq("group.delete"));
    const created = await scimPost("/scim/v2/Groups", {
      displayName: `Doomed ${randomBytes(3).toString("hex")}`,
      externalId: "grp-" + randomBytes(5).toString("hex"),
      members: [{ value: a.id }],
    });
    const groupId = created.json().id as string;
    expect((await scimDelete(`/scim/v2/Groups/${groupId}`)).statusCode).toBe(204);
    expect(await db.select().from(scimGroups).where(eq(scimGroups.id, groupId))).toHaveLength(0);
    expect(
      await db.select().from(scimGroupMembers).where(eq(scimGroupMembers.groupId, groupId)),
    ).toHaveLength(0);
    // the human is untouched — a group is sync state, a user is an identity
    const row = await dbUser(a.id);
    expect(row).not.toBeNull();
    expect(row!.disabledAt).toBeNull();
  });
});

// ===========================================================================

describe("ADR-0037 — every provisioning act is audited, with the token as actor", () => {
  it("names the acting scim_token on create, deactivate and membership change", async () => {
    const email = uniq("audited");
    const { id } = await provision(email);
    const created = await auditRows("scim-user-created", id);
    expect(created).toHaveLength(1);
    const detail = created[0]!.detail as Record<string, any>;
    expect(detail.actor).toMatchObject({ type: "scim_token", id: TOKEN_ID, name: TOKEN_NAME });
    expect(detail.after).toMatchObject({ isAdmin: false, passwordSet: false });
    expect(created[0]!.reason).toContain(TOKEN_NAME);
    expect(created[0]!.objectType).toBe("user");

    await scimDelete(`/scim/v2/Users/${id}`);
    const deactivated = await auditRows("scim-user-deactivated", id);
    expect(deactivated).toHaveLength(1);
    const dd = deactivated[0]!.detail as Record<string, any>;
    expect(dd.actor.name).toBe(TOKEN_NAME);
    expect(dd.via).toBe("delete");
    expect(dd.before).toMatchObject({ active: true });
    expect(dd.after).toMatchObject({ active: false });
    // the reason a human reads must say it was not a delete
    expect(deactivated[0]!.reason).toContain("not deleted");

    const member = await provision(uniq("audited.member"));
    const group = await scimPost("/scim/v2/Groups", {
      displayName: `Audited ${randomBytes(3).toString("hex")}`,
      externalId: "grp-" + randomBytes(5).toString("hex"),
      members: [{ value: member.id }],
    });
    const groupId = group.json().id as string;
    const added = await auditRows("scim-group-member-added", groupId);
    expect(added).toHaveLength(1);
    expect(added[0]!.objectType).toBe("scim_group");
    expect((added[0]!.detail as Record<string, any>).actor.name).toBe(TOKEN_NAME);
    // ADR-0038: the membership row itself still confers nothing on its own —
    // the reason line says so, and says exactly what WOULD confer something.
    expect(added[0]!.reason).toContain("an unmapped group grants nothing");

    // and the whole trail is reachable through the ONE audit endpoint
    const trail = await app.inject({
      method: "GET",
      url: "/v1/audit?objectType=scim_group&limit=50",
      headers: ADMIN,
    });
    expect(trail.statusCode).toBe(200);
    expect(trail.json().entries.length).toBeGreaterThan(0);
  });

  it("a refused duplicate create is audited as a DENY", async () => {
    const email = uniq("audited.dup");
    const { id } = await provision(email);
    await scimPost("/scim/v2/Users", { userName: email });
    const rows = await auditRows("scim-user-create-conflict", id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.effect).toBe("deny");
  });

  it("token issue/rotate/revoke audit as scim_token", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/scim/tokens",
      headers: ADMIN,
      payload: { name: `audited-token-${randomBytes(3).toString("hex")}` },
    });
    const id = issued.json().id as string;
    const rows = await auditRows("scim-token-issued", id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.objectType).toBe("scim_token");
    expect(rows[0]!.reason).toContain("DEACTIVATE");
  });
});

// ===========================================================================

describe("ADR-0037 — the SCIM surface is admin-gated where it should be", () => {
  it("token management is admin-only and refuses a non-admin user", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: ADMIN,
      payload: { email: uniq("plain.user"), displayName: "Plain User", isAdmin: false },
    });
    const key = await keyFor(created.json().id as string);
    for (const url of ["/v1/scim/tokens", "/v1/scim/status"]) {
      const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });
      expect(res.statusCode, url).toBe(403);
    }
    const issue = await app.inject({
      method: "POST",
      url: "/v1/scim/tokens",
      headers: { authorization: `Bearer ${key}` },
      payload: { name: "self-issued" },
    });
    expect(issue.statusCode).toBe(403);
  });

  it("the ServiceProviderConfig states what is NOT supported", async () => {
    const res = await scimGet("/scim/v2/ServiceProviderConfig");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.patch.supported).toBe(true);
    expect(body.bulk.supported).toBe(false);
    // SCIM never sets a password in RegulAIt, and the discovery document says so
    expect(body.changePassword.supported).toBe(false);
    // it is behind the token like everything else
    expect((await app.inject({ method: "GET", url: "/scim/v2/ServiceProviderConfig" })).statusCode).toBe(401);
  });

  it("the error envelope shape is RFC 7644 (status is a STRING)", () => {
    const body = scimErrorBody(404, "gone", "invalidValue");
    expect(body.status).toBe("404");
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    expect(body.scimType).toBe("invalidValue");
  });
});

// ===========================================================================

describe("ADR-0037 — per-token rate limiting", () => {
  it("exceeding the per-token limit answers 429 with Retry-After", async () => {
    // the suite runs with REGULAIT_RATE_LIMIT=off (vitest.config.ts), so this
    // builds its own app with a deliberately tiny SCIM bucket
    const limited = buildApp(db, {
      bootstrapToken: BOOT,
      trustProxy: false,
      rateLimit: { enabled: true, globalMax: 1000, apiKeyMax: 1000, scimMax: 3, scimWindowMs: 60_000 },
    });
    try {
      const issued = await limited.inject({
        method: "POST",
        url: "/v1/scim/tokens",
        headers: ADMIN,
        payload: { name: `limited-${randomBytes(3).toString("hex")}` },
      });
      const token = issued.json().token as string;
      const headers = { authorization: `Bearer ${token}` };
      const url = "/scim/v2/Users?filter=" + encodeURIComponent('userName eq "nobody@corp.example"');
      for (let i = 0; i < 3; i++) {
        expect((await limited.inject({ method: "GET", url, headers })).statusCode).toBe(200);
      }
      const blocked = await limited.inject({ method: "GET", url, headers });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBeDefined();
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

      // the bucket is PER TOKEN: a second integration is unaffected by the
      // first one running away
      const other = await limited.inject({
        method: "POST",
        url: "/v1/scim/tokens",
        headers: ADMIN,
        payload: { name: `limited-b-${randomBytes(3).toString("hex")}` },
      });
      const otherRes = await limited.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${other.json().token}` },
      });
      expect(otherRes.statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
