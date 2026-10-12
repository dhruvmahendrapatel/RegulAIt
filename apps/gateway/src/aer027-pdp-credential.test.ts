/**
 * AER-027 — THE PDP CREDENTIAL IS NOT AN ADMINISTRATOR.
 *
 * `POST /v1/authz/check` is admin-gated, so before this the only credential a
 * data-plane proxy could hold to ask it was an ADMIN API KEY — one that reaches
 * every other admin route in the product. The most exposed component in a
 * deployment held the keys to the control plane, to do a job that is one
 * question wide.
 *
 * A 'pdp'-purpose virtual key (ADR-0066 mechanism, migration 0117) was the
 * first answer: never admin whatever its owner is, bound to one route.
 * ADR-0188 S7 (migration 0195) retired that bearer key: the PDP client is now a
 * `pdp` WORKLOAD IDENTITY holding its own key, which takes a DPoP-bound self
 * token (private_key_jwt at `/oauth/token`) whose audience is the check route.
 * Every assertion below is unchanged in meaning; only the credential moved.
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
import { TestWorkloadClient, useTestIssuerKey } from "./testing/workload-client.js";
import { deploymentEnvironment } from "./oauth/common.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
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
const ORIGIN = "http://localhost";
const DATA_KEY = "aer027-synthetic-data-key-".padEnd(64, "q");
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
// the issuer: the self token's audience and every DPoP proof's htu
process.env.REGULAIT_PUBLIC_URL = ORIGIN;

let db: Db;
let app: ReturnType<typeof buildApp>;
let subjectId: string;
let ownerId: string;
let serverId: string;
let pdp: TestWorkloadClient;
let pdpIdentityId: string;
let pdpCredentialId: string;
let dispatchToken: string;
let restoreIssuerKey: (() => Promise<void>) | undefined;

const TOOL = "aer027_read";

const mintKey = async (name: string, purpose: "dispatch") => {
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
  restoreIssuerKey = await useTestIssuerKey(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

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

  // the PDP client: a `pdp` workload identity, sponsored, scoped to this deployment's environment, holding a key
  pdp = new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "pdp" });
  // identity_manage needs a step-up: relaxed for these setup calls only (another suite on the shared database may
  // have left an admin with a step-up method, which closes the bootstrap credential's first-admin allowance)
  const created = await relaxStepUpAround(db, () =>
    app.inject({
      method: "POST",
      url: "/v1/workload-identities",
      headers: AUTH,
      payload: { kind: "pdp", sponsorUserIds: [ownerId], environments: [deploymentEnvironment()] },
    }),
  );
  expect(created.statusCode, created.body).toBe(201);
  pdpIdentityId = created.json().id as string;
  const bound = await relaxStepUpAround(db, () =>
    app.inject({
      method: "POST",
      url: `/v1/workload-identities/${pdpIdentityId}/credentials`,
      headers: AUTH,
      payload: { kind: "jwk", publicJwk: pdp.publicJwk },
    }),
  );
  expect(bound.statusCode, bound.body).toBe(201);
  pdpCredentialId = bound.json().id as string;
  dispatchToken = (await mintKey(`aer027-dispatch-${randomUUID()}`, "dispatch")).token;
}, 120_000);

afterAll(async () => {
  await restoreIssuerKey?.();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  await app.close();
  await db.$client.end();
});

/** the PDP client's headers: its self token and a fresh DPoP proof; a dispatch key's: its bearer value */
const credential = async (who: TestWorkloadClient | string, method: string, url: string) =>
  typeof who === "string" ? { authorization: `Bearer ${who}` } : await who.headers(method, url);
const ask = async (who: TestWorkloadClient | string) =>
  app.inject({
    method: "POST",
    url: "/v1/authz/check",
    headers: await credential(who, "POST", "/v1/authz/check"),
    payload: { userId: subjectId, serverId, toolName: TOOL },
  });

describe("AER-027 — the PDP client asks, and does nothing else", () => {
  it("can ask an authorization question", async () => {
    const res = await ask(pdp);
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
      const res = await app.inject({ method, url, headers: await credential(pdp, method, url) });
      expect(res.statusCode, `${method} ${url} -> ${res.body}`).toBe(403);
      expect(JSON.parse(res.body).error).toBe("workload_scope");
    }
  });

  it("CANNOT MINT ANOTHER KEY — the escalation a scoped credential must not have", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/virtual-keys",
      headers: await credential(pdp, "POST", "/v1/virtual-keys"),
      payload: { name: "escalation", userId: ownerId, purpose: "dispatch" },
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it("CANNOT REACH THE DISPATCH ALLOW-LIST — the scope must cut both ways", async () => {
    // `GET /v1/me` is on the DISPATCH allow-list, so the PDP client being refused it
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
      headers: await credential(pdp, "GET", "/v1/me"),
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(JSON.parse(res.body).error).toBe("workload_scope");
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

  it("a PDP client is admin-provisioned, because it asks about everybody; the retired pdp key is issued to no one", async () => {
    // a dispatch key cannot create a workload identity
    const ident = await app.inject({
      method: "POST",
      url: "/v1/workload-identities",
      headers: { authorization: `Bearer ${dispatchToken}` },
      payload: { kind: "pdp", sponsorUserIds: [ownerId] },
    });
    expect(ident.statusCode, ident.body).toBe(403);
    // ADR-0188 S7: a pdp virtual key is gone for everyone, an admin included
    const res = await app.inject({
      method: "POST",
      url: "/v1/virtual-keys",
      headers: AUTH,
      payload: { name: "retired-pdp", userId: ownerId, purpose: "pdp" },
    });
    expect(res.statusCode, res.body).toBe(410);
    expect(JSON.parse(res.body).error).toBe("pdp_key_retired");
  });

  it("a REVOKED PDP key stops asking: its live token is refused and no new one is issued", async () => {
    expect((await ask(pdp)).statusCode).toBe(200);
    const revoked = await relaxStepUpAround(db, () =>
      app.inject({
        method: "DELETE",
        url: `/v1/workload-identities/${pdpIdentityId}/credentials/${pdpCredentialId}`,
        headers: AUTH,
      }),
    );
    expect(revoked.statusCode, revoked.body).toBe(200);
    const res = await ask(pdp);
    expect(res.statusCode, res.body).toBe(401);
    pdp.reset();
    expect((await pdp.tokenRequest()).statusCode).toBe(401);
  });
});
