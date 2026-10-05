/**
 * ADR-0167 (SEC-01) — a host NAMED BY A CREDENTIAL is a typed destination.
 *
 * Three connector kinds reach a host that an admin typed into the credential
 * JSON rather than into `baseUrl`: the Entra login host (`loginBaseUrl`) for
 * teams and outlook, and `https://<account>.snowflakecomputing.com` for
 * snowflake. With no `baseUrl` override the invoke path handed those adapters
 * the GLOBAL fetch, so `{"loginBaseUrl":"http://169.254.169.254/latest"}` sent
 * the app password to the metadata service with no allow-list, no
 * private-range check, no DNS pin and no audit row — and the non-admin invoke
 * route reflected the upstream body back as `detail`.
 *
 * What this file makes impossible to fake:
 *   1. A typed login host that is NOT allow-listed is refused BEFORE a socket
 *      opens — a counting loopback server sees zero requests — and the refusal
 *      is an audit row, not a 500 and not a quiet success.
 *   2. The snowflake account host is adjudicated the same way, and an account
 *      that is not a hostname label (`evil.example/?`) never gets stored.
 *   3. A `loginBaseUrl` carrying credentials, a query or a fragment is refused
 *      at credential-write time.
 *   4. Once the host IS allow-listed the call reaches it (so the guard is a
 *      gate, not a wall), and the upstream body is still NOT echoed: a
 *      non-JSON body is withheld, a JSON `error_description` is relayed.
 *
 * The fake login host listens on 127.0.0.3, deliberately not 127.0.0.1:
 * sibling suites allow-list 127.0.0.1 and the whole suite shares one
 * database (M-048), so "not allow-listed" has to be an address nobody else
 * lists. Its allow entry is removed in afterAll.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, createDb, desc, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "cde-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);
const FAKE_HOST = "127.0.0.3";
const RUN = randomUUID().slice(0, 8);

let db: Db;
let app: ReturnType<typeof buildApp>;
let userAuth: { authorization: string };
let userId: string;
let loginServer: http.Server;
let loginBase: string;
/** every request the fake login host ever received */
const loginHits: Array<{ url: string; body: string }> = [];
/** what the fake answers next */
let loginReply: { status: number; body: string } = { status: 500, body: "INTERNAL-SECRET-PAGE" };
let allowEntryId: string | null = null;

const post = async (url: string, payload: Record<string, unknown>, headers: Record<string, string> = AUTH) =>
  app.inject({ method: "POST", url, headers, payload });

async function makeConnector(kind: "teams" | "outlook" | "snowflake", token: string) {
  const c = await post("/v1/connectors", {
    name: `cde-${kind}-${RUN}-${randomUUID().slice(0, 6)}`,
    kind: kind === "snowflake" ? "warehouse" : "chat",
    providerKind: kind,
    pricePerCallUsd: 0.01,
  });
  expect(c.statusCode, c.body).toBe(201);
  const id = c.json().id as string;
  const cred = await post(`/v1/connectors/${id}/credential`, { token });
  const g = await post("/v1/grants/connectors", { userId, connectorId: id, mode: "readwrite" });
  expect(g.statusCode, g.body).toBeLessThan(300);
  return { id, name: c.json().name as string, cred };
}

const invokeTeams = (connectorId: string) =>
  post(
    `/v1/connectors/${connectorId}/invoke`,
    {
      operation: "write",
      object: "19:conversation@thread.tacv2",
      payload: { op: "conversations.sendToConversation", text: "hello" },
    },
    userAuth,
  );

const invokeSnowflake = (connectorId: string) =>
  post(
    `/v1/connectors/${connectorId}/invoke`,
    { operation: "read", object: "ANALYTICS.PUBLIC", payload: { statement: "select 1" } },
    userAuth,
  );

async function latestAudit(ruleId: string) {
  const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.at)).limit(1);
  return row ?? null;
}

let restoreSb1Posture: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181: the org PII floor ships at block. This file pins egress adjudication of a
  // connector's login host, not PII handling, so it sets the floor off explicitly.
  restoreSb1Posture = await relaxDataPostureForTest(db, { org: { defaultPiiMode: "none" }, interception: false, guardrails: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  loginServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      loginHits.push({ url: req.url ?? "", body });
      res.writeHead(loginReply.status, { "content-type": "application/json" });
      res.end(loginReply.body);
    });
  });
  await new Promise<void>((r) => loginServer.listen(0, FAKE_HOST, r));
  const addr = loginServer.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  loginBase = `http://${FAKE_HOST}:${addr.port}`;

  const u = await post("/v1/users", { email: `cde-${RUN}@example.com`, displayName: "cde requester" });
  expect(u.statusCode).toBe(201);
  userId = u.json().id;
  const k = await post(`/v1/users/${userId}/keys`, { name: "cde" });
  userAuth = { authorization: `Bearer ${k.json().token}` };
});

afterAll(async () => {
  await restoreSb1Posture?.();
  if (allowEntryId) {
    await app.inject({ method: "DELETE", url: `/v1/egress-allow-hosts/${allowEntryId}`, headers: AUTH });
  }
  await new Promise<void>((r) => loginServer.close(() => r()));
  await app.close();
});

describe("a typed login host is adjudicated like a typed baseUrl", () => {
  it("teams: an unlisted loginBaseUrl is refused before any socket opens, and the refusal is a record", async () => {
    const conn = await makeConnector(
      "teams",
      JSON.stringify({ appId: "app", appPassword: "SECRET-APP-PASSWORD", loginBaseUrl: loginBase }),
    );
    expect([200, 201]).toContain(conn.cred.statusCode);
    const before = loginHits.length;
    const res = await invokeTeams(conn.id);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().code).toBe("host_not_allowlisted");
    expect(String(res.json().detail)).toContain("Entra login host");
    expect(loginHits.length).toBe(before);
    const row = await latestAudit("connector-egress-blocked");
    expect(row).toBeTruthy();
    expect((row!.detail as { baseUrl?: string }).baseUrl).toBe(loginBase);
    expect((row!.detail as { source?: string }).source).toBe("connector_credential");
  });

  it("snowflake: the account host is adjudicated the same way, and an account that is not a label is never stored", async () => {
    const bad = await makeConnector(
      "snowflake",
      JSON.stringify({ account: "evil.example/?", user: "svc", privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n" }),
    );
    expect(bad.cred.statusCode).toBe(400);
    expect(bad.cred.json().error).toBe("invalid_connector_credential");
    expect(String(bad.cred.json().detail)).toContain("hostname label");

    const good = await makeConnector(
      "snowflake",
      JSON.stringify({ account: `cde-${RUN}`, user: "svc", privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n" }),
    );
    expect([200, 201]).toContain(good.cred.statusCode);
    const res = await invokeSnowflake(good.id);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().code).toBe("host_not_allowlisted");
    expect(String(res.json().detail)).toContain(`cde-${RUN}.snowflakecomputing.com`);
  });

  it("outlook: a loginBaseUrl that could choose more than a host is refused at write time", async () => {
    const cases = [
      `http://user:pw@${FAKE_HOST}:9/tenant`,
      "https://login.example/path?x=1",
      "https://login.example/#frag",
      "ftp://login.example",
    ];
    for (const loginBaseUrl of cases) {
      const conn = await makeConnector(
        "outlook",
        JSON.stringify({ appId: "a", appPassword: "b", tenantId: "t", senderUpn: "x@y.z", loginBaseUrl }),
      );
      expect(conn.cred.statusCode, loginBaseUrl).toBe(400);
      expect(conn.cred.json().error).toBe("invalid_connector_credential");
    }
  });
});

describe("once the host is allow-listed the gate opens — and the upstream body is still not relayed", () => {
  it("the login host is reached, a non-JSON upstream body is withheld, a JSON error is relayed", async () => {
    const allow = await post("/v1/egress-allow-hosts", {
      host: FAKE_HOST,
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
      note: "cde suite: local fake Entra login host",
    });
    expect([200, 201]).toContain(allow.statusCode);
    allowEntryId = allow.json().id ?? allow.json().host?.id ?? null;

    const conn = await makeConnector(
      "teams",
      JSON.stringify({ appId: "app", appPassword: "SECRET-APP-PASSWORD", loginBaseUrl: loginBase }),
    );
    expect([200, 201]).toContain(conn.cred.statusCode);

    // POSITIVE CONTROL: the guarded fetch admits the listed host — the token
    // exchange arrives at the fake, carrying the client_secret it exists to send
    loginReply = { status: 500, body: "INTERNAL-SECRET-PAGE" };
    const before = loginHits.length;
    const withheld = await invokeTeams(conn.id);
    expect(withheld.statusCode, withheld.body).toBe(502);
    expect(withheld.json().error).toBe("connector_invoke_failed");
    expect(loginHits.length).toBe(before + 1);
    expect(loginHits[before]!.url).toContain("/oauth2/v2.0/token");
    expect(loginHits[before]!.body).toContain("client_secret=SECRET-APP-PASSWORD");
    expect(String(withheld.json().detail)).not.toContain("INTERNAL-SECRET-PAGE");
    expect(String(withheld.json().detail)).toContain("withheld");

    loginReply = { status: 401, body: JSON.stringify({ error: "invalid_client", error_description: "AADSTS7000215: bad secret" }) };
    const relayed = await invokeTeams(conn.id);
    expect(relayed.statusCode).toBe(502);
    expect(String(relayed.json().detail)).toContain("invalid_client");
    expect(String(relayed.json().detail)).toContain("AADSTS7000215");
    // the destination-host record every guarded outbound call writes
    const call = await latestAudit("connector-egress-call");
    expect(call).toBeTruthy();
    expect((call!.detail as { baseUrl?: string }).baseUrl).toBe(loginBase);
  });
});
