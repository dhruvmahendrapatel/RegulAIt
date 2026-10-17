/**
 * N12 (ADR-0186 A): `PUT /v1/{servers,connectors}/:id/owner` claims its `owner_change` step-up grant inside the
 * write's own transaction, after the compare-and-set, never on the root handle before it. So:
 *
 *  - a compare-and-set lost to a concurrent owner change answers 409 `changed_concurrently` and leaves the grant
 *    UNSPENT (the same grant then completes the change once the owner is back where it was decided);
 *  - a successful change spends the grant exactly once (a replay of the same token is refused);
 *  - concurrent requests presenting one grant change the owner once, and the grant is spent at most once.
 *
 * Under the strict step-up values (owner_change on). Real tables: a browser session row and a grant row made for
 * exactly the change, as the step-up ceremony would leave them. Org-global state touched here (the admin's TOTP flag,
 * which ends the bootstrap credential's step-up) is undone in afterAll (M-040, M-068).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { FastifyRequest } from "fastify";
import {
  and,
  auditLog,
  authSessions,
  connectors,
  createDb,
  eq,
  inArray,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS, STEP_UP_HEADER, stepUpActionDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { changeOwner, ownerChangeGate, OWNERSHIP_RULE_IDS } from "./ownership.js";
import { ownerChangeStepUpArgs } from "./step-up.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { hashToken } from "./token-hash.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `n12-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
// synthetic, derived at runtime (gitleaks): never a secret-shaped literal
const DATA_KEY = createHash("sha256").update(`n12-data-key-${RUN}`).digest("hex");

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
const userIds: string[] = [];
const connectorIds: string[] = [];
const restores: Array<() => Promise<void>> = [];

async function mkUser(label: string): Promise<string> {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `n12-${label}-${RUN}@example.com`, displayName: `n12 ${label}` } });
  expect(u.statusCode, u.body).toBe(201);
  userIds.push(u.json().id);
  return u.json().id as string;
}

async function mkConnector(ownerUserId: string): Promise<string> {
  const [c] = await db.insert(connectors).values({ name: `n12-${RUN}-${connectorIds.length}`, kind: "chat", ownerUserId }).returning({ id: connectors.id });
  connectorIds.push(c!.id);
  return c!.id;
}

/** a browser session for the admin, and a grant made for exactly this owner change */
async function sessionWithGrant(connectorId: string, to: string) {
  const sessionToken = "rgls_" + randomBytes(32).toString("hex");
  const [s] = await db
    .insert(authSessions)
    .values({
      tokenHash: createHash("sha256").update(sessionToken).digest("hex"),
      userId: adminId,
      origin: "password",
      expiresAt: new Date(Date.now() + 3_600_000),
      idleExpiresAt: new Date(Date.now() + 3_600_000),
      idleMinutes: 60,
    })
    .returning({ id: authSessions.id });
  const args = ownerChangeStepUpArgs("connector", connectorId, to);
  const stepUpToken = "rgsu_" + randomBytes(24).toString("hex");
  const [g] = await db
    .insert(stepUpGrants)
    .values({
      tokenHash: hashToken(stepUpToken),
      userId: adminId,
      sessionId: s!.id,
      method: "totp",
      actionKind: args.kind,
      actionDigest: stepUpActionDigest(args.kind, args.facts),
      expiresAt: new Date(Date.now() + 120_000),
    })
    .returning({ id: stepUpGrants.id });
  const put = () =>
    app.inject({
      method: "PUT",
      url: `/v1/connectors/${connectorId}/owner`,
      headers: { ...CSRF, [STEP_UP_HEADER]: stepUpToken },
      cookies: { regulait_session: sessionToken },
      payload: { ownerUserId: to },
    });
  /** the request as the route sees it, for a direct `changeOwner` call */
  const req = {
    headers: { [STEP_UP_HEADER]: stepUpToken },
    authCtx: { userId: adminId, isAdmin: true, via: "session" },
    sessionAuth: { sessionId: s!.id, origin: "password" },
  } as unknown as FastifyRequest;
  const usedAt = async () => (await db.select({ usedAt: stepUpGrants.usedAt }).from(stepUpGrants).where(eq(stepUpGrants.id, g!.id)))[0]!.usedAt;
  return { put, req, usedAt };
}

const ownerOf = async (id: string) => (await db.select({ o: connectors.ownerUserId }).from(connectors).where(eq(connectors.id, id)))[0]!.o;
const changedRows = (id: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, OWNERSHIP_RULE_IDS.changed.connector)));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  // the strict values: owner_change needs a step-up
  await db
    .update(orgSettings)
    .set({ stepUpMode: BATCH4_STRICT_DEFAULTS.stepUpMode, stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  adminId = await mkUser("admin");
  await db.update(users).set({ isAdmin: true, totpEnabled: true }).where(eq(users.id, adminId));
}, 120_000);

afterAll(async () => {
  if (adminId) await db.update(users).set({ totpEnabled: false }).where(eq(users.id, adminId));
  if (connectorIds.length) await db.delete(connectors).where(inArray(connectors.id, connectorIds));
  for (const r of restores.reverse()) await r();
  await app?.close();
});

describe("N12: the owner_change grant is claimed inside the owner write's transaction", () => {
  it("a compare-and-set lost to a concurrent change is a 409 and leaves the grant unspent", async () => {
    const a = await mkUser("a1");
    const b = await mkUser("b1");
    const c = await mkUser("c1");
    const id = await mkConnector(a);
    const s = await sessionWithGrant(id, b);
    const inner = ownerChangeGate(db, s.req, "connector", id);
    // a concurrent admin moves the owner to C after this request decided its step-up on A, before its write
    const out = await changeOwner(db, {
      kind: "connector",
      id,
      ownerUserId: b,
      actorUserId: adminId,
      gate: async (change, opts) => {
        if (opts && !opts.spend) await db.update(connectors).set({ ownerUserId: c }).where(eq(connectors.id, id));
        return inner(change, opts);
      },
    });
    expect(out).toMatchObject({ ok: false, status: 409, body: { error: "changed_concurrently" } });
    expect(await ownerOf(id)).toBe(c);
    expect(await s.usedAt()).toBeNull();
    expect(await changedRows(id)).toHaveLength(0);
    // the unspent grant still completes the change it was made for, once the owner is back where it was decided
    await db.update(connectors).set({ ownerUserId: a }).where(eq(connectors.id, id));
    const done = await s.put();
    expect(done.statusCode, done.body).toBe(200);
    expect(await ownerOf(id)).toBe(b);
    expect(await s.usedAt()).not.toBeNull();
  });

  it("a successful change spends the grant exactly once", async () => {
    const a = await mkUser("a2");
    const b = await mkUser("b2");
    const id = await mkConnector(a);
    const s = await sessionWithGrant(id, b);
    const done = await s.put();
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ id, ownerUserId: b, ownership: "owned" });
    expect(await s.usedAt()).not.toBeNull();
    const rows = await changedRows(id);
    expect(rows).toHaveLength(1);
    // the same token again, for the same change from the same starting owner: refused, nothing written
    await db.update(connectors).set({ ownerUserId: a }).where(eq(connectors.id, id));
    const replay = await s.put();
    expect(replay.statusCode, replay.body).toBe(403);
    expect(replay.json()).toMatchObject({ error: "step_up_required", actionKind: "owner_change" });
    expect(await ownerOf(id)).toBe(a);
    expect(await changedRows(id)).toHaveLength(1);
  });

  it("concurrent requests presenting one grant change the owner once and spend it at most once", async () => {
    const a = await mkUser("a3");
    const b = await mkUser("b3");
    const id = await mkConnector(a);
    const s = await sessionWithGrant(id, b);
    const outs = await Promise.all(Array.from({ length: 4 }, () => s.put()));
    for (const o of outs) expect([200, 403, 409], o.body).toContain(o.statusCode);
    expect(await ownerOf(id)).toBe(b);
    expect(await s.usedAt()).not.toBeNull();
    // exactly one A → B transition was written; any later 200 is a re-statement (B → B), which needs no grant
    const transitions = (await changedRows(id)).map((r) => (r.detail as { transitions: { ownerUserId: { from: string | null; to: string | null } } }).transitions.ownerUserId);
    expect(transitions.filter((t) => t.from === a && t.to === b)).toHaveLength(1);
  });
});
