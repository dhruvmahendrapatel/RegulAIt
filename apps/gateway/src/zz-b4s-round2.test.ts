/**
 * B4S round 2 (ADR-0186 A / ADR-0180) — proof by attack for the second
 * security-fix round:
 *
 *  - B4S-07: a fresh SSO sign-in is a step-up method only on a SECURE request
 *    (https, or https at a trusted proxy). Over plain http it is neither listed
 *    in a refusal nor started by /options.
 *
 * Runs on its OWN scratch database (prefix `b4s2_`), dropped in afterAll
 * (M-068), so the global state it needs (which admins have a step-up method,
 * the strict settings) is its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  authSessions,
  createDb,
  eq,
  federatedIdentities,
  mcpServers,
  runMigrations,
  samlProviders,
  sql,
  ssoReauthRequests,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `b4s2_r2_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4s2-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "a".repeat(64);
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
/** the address the app trusts as its TLS-terminating proxy */
const PROXY = "10.20.30.40";
const SECURE = { remoteAddress: PROXY, headers: { "x-forwarded-proto": "https" } };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let adminDb: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
type Person = { id: string; email: string; key: { authorization: string }; token: string; auth: SoftAuthenticator };

/** a request as `p`'s browser session; `secure` arrives as https through the trusted proxy */
const as = (
  p: { token: string },
  method: Method,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  secure = false,
) =>
  app.inject({
    method,
    url,
    ...(secure ? { remoteAddress: SECURE.remoteAddress } : {}),
    headers: { ...CSRF, ...(secure ? SECURE.headers : {}), ...headers },
    cookies: { regulait_session: p.token },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const boot = (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...AUTH, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function mkSession(userId: string): Promise<string> {
  const token = "rgls_" + randomBytes(32).toString("hex");
  await db.insert(authSessions).values({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId,
    origin: "password",
    expiresAt: new Date(Date.now() + 3_600_000),
    idleExpiresAt: new Date(Date.now() + 3_600_000),
    idleMinutes: 60,
  });
  return token;
}

/** a person with a browser session and an API key; no step-up method until one is enrolled */
async function mkPerson(label: string, isAdmin: boolean): Promise<Person> {
  const email = `b4s2-${label}-${RUN}@example.com`;
  const u = await boot("POST", "/v1/users", { email, displayName: `b4s2 ${label}`, isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const key = await boot("POST", `/v1/users/${id}/keys`, { name: "b4s2" });
  expect(key.statusCode, key.body).toBe(201);
  return { id, email, key: { authorization: `Bearer ${key.json().token}` }, token: await mkSession(id), auth: new SoftAuthenticator({ origin: ORIGIN }) };
}

async function mkServer(label: string): Promise<string> {
  const [row] = await db
    .insert(mcpServers)
    .values({ name: `b4s2-${label}-${RUN}`, url: `https://mcp-${label}-${RUN}.example.com/mcp` })
    .returning({ id: mcpServers.id });
  return row!.id;
}

function makeSamlCert(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = mkdtempSync(path.join(tmpdir(), "regulait-b4s2-test-only-"));
  try {
    const keyFile = path.join(dir, "k.pem");
    const certFile = path.join(dir, "c.pem");
    writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    execFileSync("openssl", ["req", "-x509", "-new", "-sha256", "-days", "1", "-key", keyFile, "-out", certFile, "-subj", "/CN=b4s2-idp"]);
    return readFileSync(certFile, "utf8").trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  adminDb = createDb(DATABASE_URL);
  await adminDb.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await adminDb.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  // the MFA dial is not this suite's subject (its own database: nothing to restore)
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, trustProxy: [PROXY] });
  await app.ready();
}, 180_000);

afterAll(async () => {
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  await closeAll([
    async () => drainBackgroundWork(db),
    async () => app?.server.closeAllConnections(),
    async () => app?.close(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(adminDb, SCRATCH_DB),
    async () => adminDb?.$client.end(),
  ]);
});

// ---------------------------------------------------------------------------
// B4S-07 — SSO step-up only on a secure request
// ---------------------------------------------------------------------------

describe("B4S-07: a fresh SSO sign-in is a step-up method only over https", () => {
  let ssoAdmin: Person;
  let server: string;
  beforeAll(async () => {
    ssoAdmin = await mkPerson("sso-admin", true);
    // inserted directly: creating a SAML provider through the API is license-gated (ADR-0052), not this suite's subject
    const [sp] = await db
      .insert(samlProviders)
      .values({
        name: `b4s2-saml-${RUN}`,
        entityId: `https://idp.b4s2-${RUN}.example/metadata`,
        idpSsoUrl: `https://idp.b4s2-${RUN}.example/sso`,
        idpSigningCerts: [makeSamlCert()],
      })
      .returning({ id: samlProviders.id });
    await db.insert(federatedIdentities).values({
      userId: ssoAdmin.id,
      samlProviderId: sp!.id,
      issuer: `https://idp.b4s2-${RUN}.example/metadata`,
      subjectFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      subject: ssoAdmin.email,
      linkedVia: "jit",
    });
    server = await mkServer("sso");
  });

  const reauthRows = async () => db.select().from(ssoReauthRequests).where(eq(ssoReauthRequests.userId, ssoAdmin.id));

  it("over plain http a protected action does not offer sso: 422 step_up_unavailable naming https", async () => {
    const r = await as(ssoAdmin, "PUT", `/v1/servers/${server}/owner`, { ownerUserId: ssoAdmin.id });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json()).toMatchObject({ error: "step_up_unavailable", methods: [] });
    expect(r.json().detail).toContain("https");
  });

  it("over plain http /options neither offers nor STARTS an sso step-up (no reauth request is created)", async () => {
    const before = (await reauthRows()).length;
    const o = await as(ssoAdmin, "POST", "/v1/auth/step-up/options", {
      action: { kind: "owner_change", body: { objectType: "mcp_server", objectId: server, ownerUserId: ssoAdmin.id } },
    });
    expect(o.statusCode, o.body).toBe(422);
    expect(o.json()).toMatchObject({ error: "step_up_unavailable", methods: [] });
    expect(o.json().sso).toBeUndefined();
    expect((await reauthRows()).length).toBe(before);
  });

  it("over https through the trusted proxy the same person is offered sso and /options starts it (the control)", async () => {
    const r = await as(ssoAdmin, "PUT", `/v1/servers/${server}/owner`, { ownerUserId: ssoAdmin.id }, {}, true);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ error: "step_up_required", methods: ["sso"] });
    const before = (await reauthRows()).length;
    const o = await as(ssoAdmin, "POST", "/v1/auth/step-up/options", { action: r.json().action }, {}, true);
    expect(o.statusCode, o.body).toBe(200);
    expect(o.json().methods).toEqual(["sso"]);
    expect(o.json().sso.redirectUrl).toMatch(/^https:\/\/idp\.b4s2-/);
    expect((await reauthRows()).length).toBe(before + 1);
  });

  it("a forged x-forwarded-proto from an untrusted peer is still plain http", async () => {
    const o = await as(ssoAdmin, "POST", "/v1/auth/step-up/options", { action: { kind: "owner_change", body: { x: RUN } } }, {
      "x-forwarded-proto": "https",
    });
    expect(o.statusCode, o.body).toBe(422);
    expect(o.json().error).toBe("step_up_unavailable");
  });
});
