/**
 * AER-027 — THE PDP CREDENTIAL IS NOT AN ADMINISTRATOR.
 *
 * `POST /v1/authz/check` is admin-gated, so before this the only credential a
 * data-plane proxy could hold to ask it was an ADMIN API KEY — one that reaches
 * every other admin route in the product. The most exposed component in a
 * deployment held the keys to the control plane, to do a job that is one
 * question wide.
 *
 * A 'pdp'-purpose virtual key (ADR-0066 mechanism, migration 0117) is the
 * answer: never admin whatever its owner is, bound to one route, with the
 * expiry and revocation virtual keys already have.
 *
 * WHAT THIS FILE ASSERTS, and why the obvious half is not enough:
 *
 *   - a pdp key CAN ask (otherwise the feature does not exist);
 *   - a pdp key cannot reach admin routes, cannot mint another key, and cannot
 *     DISPATCH — the last one matters because both credentials share a
 *     mechanism, and "scoped" must mean scoped in both directions or it is just
 *     a label;
 *   - a DISPATCH key cannot ask an authorization question about anyone — the
 *     other half of that separation, and the one a single-direction test
 *     silently misses;
 *   - an admin key still works, so this narrowed rather than broke the contract;
 *   - a REVOKED pdp key stops asking, because a credential you cannot take back
 *     is not a credential.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, users, mcpServers, mcpTools, toolGrants, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "aer027-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let subjectId: string;
let ownerId: string;
let serverId: string;
let pdpToken: string;
let dispatchToken: string;
let pdpKeyId: string;

const TOOL = "aer027_read";

const mintKey = async (name: string, purpose: "dispatch" | "pdp") => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/virtual-keys",
    headers: AUTH,
    payload: { name, userId: ownerId, purpose },
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = JSON.parse(res.body) as { id: string; token?: string; key?: string };
  return { id: body.id, token: (body.token ?? body.key)! };
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  // The OWNER is deliberately an admin: a virtual key issued by an admin must
  // not carry admin, and making the owner an ordinary user would let that pass
  // by accident.
  const [o] = await db
    .insert(users)
    .values({ email: `aer027-owner-${randomUUID()}@pdp.example`, displayName: "AER027 owner", isAdmin: true })
    .returning({ id: users.id });
  ownerId = o!.id;

  const [u] = await db
    .insert(users)
    .values({ email: `aer027-subject-${randomUUID()}@pdp.example`, displayName: "AER027 subject" })
    .returning({ id: users.id });
  subjectId = u!.id;

  const [s] = await db
    .insert(mcpServers)
    .values({ name: `aer027-${randomUUID()}`, url: "http://127.0.0.1:9/" })
    .returning({ id: mcpServers.id });
  serverId = s!.id;
  await db.insert(mcpTools).values({ serverId, name: TOOL, kind: "read" });
  await db.insert(toolGrants).values({ userId: subjectId, serverId, toolName: TOOL });

  const pdp = await mintKey(`aer027-pdp-${randomUUID()}`, "pdp");
  pdpToken = pdp.token;
  pdpKeyId = pdp.id;
  dispatchToken = (await mintKey(`aer027-dispatch-${randomUUID()}`, "dispatch")).token;
}, 120_000);

afterAll(async () => {
  await app.close();
  await db.$client.end();
});

const ask = (token: string) =>
  app.inject({
    method: "POST",
    url: "/v1/authz/check",
    headers: { authorization: `Bearer ${token}` },
    payload: { userId: subjectId, serverId, toolName: TOOL },
  });

describe("AER-027 — a pdp virtual key asks, and does nothing else", () => {
  it("can ask an authorization question", async () => {
    const res = await ask(pdpToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).decision).toBe("allow");
  });

  it("is refused on every other route, including admin ones", async () => {
    for (const [method, url] of [
      ["GET", "/v1/users"],
      ["GET", "/v1/audit"],
      ["GET", "/v1/keys"],
      ["GET", "/v1/virtual-keys"],
    ] as const) {
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${pdpToken}` } });
      expect(res.statusCode, `${method} ${url} -> ${res.body}`).toBe(403);
    }
  });

  it("CANNOT MINT ANOTHER KEY — the escalation a scoped credential must not have", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/virtual-keys",
      headers: { authorization: `Bearer ${pdpToken}` },
      payload: { name: "escalation", userId: ownerId, purpose: "pdp" },
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it("CANNOT REACH THE DISPATCH ALLOW-LIST — the scope must cut both ways", async () => {
    // `GET /v1/me` is on the DISPATCH allow-list, so a pdp key being refused it
    // is the precise assertion: not "this route happens to be closed", but
    // "this credential is bound to a different set than the other kind".
    //
    // The first draft used POST /v1/chat/completions and got a 404 — that route
    // is not registered in this app's configuration, so the test was asserting
    // 403 against a route that does not exist and would have passed for the
    // wrong reason had the expectation been `not 200`.
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${pdpToken}` },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(JSON.parse(res.body).error).toBe("virtual_key_scope");
  });

  it("and a dispatch key CAN reach it, so the refusal above is about purpose", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${dispatchToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe("AER-027 — the separation runs the other way too", () => {
  it("a DISPATCH key cannot ask an authorization question about anyone", async () => {
    const res = await ask(dispatchToken);
    expect(res.statusCode, res.body).toBe(403);
    expect(JSON.parse(res.body).error).toBe("virtual_key_scope");
  });
});

describe("AER-027 — the credential is still a credential", () => {
  it("an admin key can still ask, so the contract narrowed rather than broke", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/authz/check",
      headers: AUTH,
      payload: { userId: subjectId, serverId, toolName: TOOL },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("issuing a pdp key is admin-only, because it asks about everybody", async () => {
    // a plain (non-admin) user's own session cannot mint one even for themselves
    const res = await app.inject({
      method: "POST",
      url: "/v1/virtual-keys",
      headers: { authorization: `Bearer ${dispatchToken}` },
      payload: { name: "self-issued-pdp", purpose: "pdp" },
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it("a REVOKED pdp key stops asking", async () => {
    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/virtual-keys/${pdpKeyId}`,
      headers: AUTH,
    });
    expect([200, 204]).toContain(revoked.statusCode);
    const res = await ask(pdpToken);
    expect(res.statusCode, res.body).toBe(401);
  });
});
