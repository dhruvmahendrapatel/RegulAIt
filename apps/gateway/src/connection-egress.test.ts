/**
 * ADR-0034 amendment #2 — THE CONNECTOR, GIT AND PM `baseUrl` FIELDS,
 * ADVERSARIALLY.
 *
 * ADR-0034 and its first amendment both closed with the same written admission:
 * `connectors.baseUrl` / `connector_credentials.baseUrl`, `git_connections.baseUrl`
 * and `pm_connections.baseUrl` were still outside the guard, and the connector
 * one was named the highest-priority follow-up because the `webhook` kind does
 * not merely READ the URL — it **POSTs the caller's payload to it**. This file
 * is the proof that all three are inside the guard now, written the way an
 * attacker would try them:
 *
 *  - point each of the three at IMDS and try to save it;
 *  - allow-list the IMDS address itself, so nothing cheaper than the blocked-
 *    range check is what refuses it;
 *  - skip the endpoints entirely and INSERT THE ROWS STRAIGHT INTO POSTGRES,
 *    the way every row written before this guard existed already sits there,
 *    then drive a real governed call through each of them;
 *  - and, the case this whole amendment is named after, stand up a LIVE
 *    collector on loopback, point a `webhook` connector at it WITHOUT
 *    allow-listing it, invoke with a payload full of customer data, and prove
 *    the collector received nothing at all;
 *  - approve a hostname and re-point its DNS at link-local afterwards;
 *  - get an endpoint approved and then have it redirect to IMDS mid-flight;
 *  - and last, prove the legitimate air-gapped case still works, because a
 *    guard that only ever says no is a guard nobody keeps switched on.
 *
 * The direct-INSERT cases are not a contrivance. Pre-guard rows exist in the
 * live database right now; refusing them at CALL time is the entire reason the
 * check does not stop at write time.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  connectorCredentials,
  connectors,
  createDb,
  desc,
  egressAllowHosts,
  eq,
  gitConnections,
  pmConnections,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { encryptSecret } from "./secrets.js";
import { checkConnectionBaseUrl } from "./connection-egress.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "conn-egress-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);

/** the destination this whole exercise exists to keep unreachable */
const IMDS = "http://169.254.169.254/latest/meta-data/iam/security-credentials/";
/** the string that must never appear in the collector's log */
const CANARY = "PATIENT-SSN-078-05-1120";

let db: Db;
let app: ReturnType<typeof buildApp>;
/** the attacker's collector: a REAL, LISTENING, willing receiver */
let collector: http.Server;
let collectorPort: number;
let collectorHits: Array<{ body: string; host: string | null; auth: string | null }> = [];
let redirectSrv: http.Server;
let redirectPort: number;
let userId: string;
let userAuth: { authorization: string };
let approverId: string;
let workerAgentId: string;

const uniq = () => Math.random().toString(36).slice(2, 8);

async function makeUser(email: string): Promise<{ id: string; auth: { authorization: string } }> {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: "Conn Egress" },
  });
  const id = u.json().id as string;
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${id}/keys`,
    payload: { name: "cli" },
  });
  return { id, auth: { authorization: `Bearer ${key.json().token}` } };
}

async function lastAudit(ruleId: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ruleId, ruleId))
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row;
}

/** a connector row written the way a PRE-GUARD row was: straight into Postgres */
async function insertLegacyConnector(
  name: string,
  providerKind: string,
  baseUrl: string,
): Promise<string> {
  const [row] = await db
    .insert(connectors)
    .values({ name, kind: "exfil-test", providerKind, baseUrl, pricePerCallUsd: 0.01 })
    .returning();
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/connectors",
    payload: { userId, connectorId: row!.id, mode: "readwrite" },
  });
  return row!.id;
}

const invokeConnector = (connectorId: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    headers: userAuth,
    url: `/v1/connectors/${connectorId}/invoke`,
    payload: { operation: "write", object: "customer-records", payload },
  });

async function allowLoopback(note: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/egress-allow-hosts",
    payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

let restoreSb1Posture: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181: the org PII floor ships at block. This file pins behaviour unrelated to
  // PII handling, so it sets the floor off explicitly; restored in afterAll.
  restoreSb1Posture = await relaxDataPostureForTest(db, { org: { defaultPiiMode: "none" }, interception: false, guardrails: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  // HERMETIC DEFAULT-DENY. Every suite shares one database (fileParallelism is
  // off) and several of them legitimately allow-list 127.0.0.1 for their own
  // fake endpoints. A file whose whole subject is "what is refused" cannot
  // inherit somebody else's allow entry, so it starts from the empty table that
  // is the product's real default. (credential-egress.test.ts and
  // custom-providers.test.ts set exactly this precedent.)
  await db.delete(egressAllowHosts);

  // THE COLLECTOR. Deliberately real and deliberately willing: it answers 200
  // to anything. If a single request reaches it while its host is not
  // allow-listed, the guard has failed — the assertion is not "the request
  // errored", it is "the receiver saw nothing".
  collector = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      collectorHits.push({
        body: raw,
        host: (req.headers.host as string) ?? null,
        auth: (req.headers.authorization as string) ?? null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: true }));
    });
  });
  await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
  collectorPort = (collector.address() as { port: number }).port;

  // an allow-listed endpoint that answers 302 -> IMDS
  redirectSrv = http.createServer((_req, res) => {
    res.writeHead(302, { location: IMDS });
    res.end();
  });
  await new Promise<void>((r) => redirectSrv.listen(0, "127.0.0.1", r));
  redirectPort = (redirectSrv.address() as { port: number }).port;

  const u = await makeUser(`conn-egress-${uniq()}@example.com`);
  userId = u.id;
  userAuth = u.auth;
  const approver = await makeUser(`conn-egress-approver-${uniq()}@example.com`);
  approverId = approver.id;

  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: `conn-egress-worker-${uniq()}`,
      provider: "mock",
      tier: 1,
      modes: ["execute"],
      costPerMTokIn: 1,
      costPerMTokOut: 2,
      model: "mock-conn-egress",
    },
  });
  workerAgentId = agent.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId, agentId: workerAgentId },
  });
});

afterAll(async () => {
  await restoreSb1Posture?.();
  await db.delete(egressAllowHosts);
  collector.closeAllConnections();
  redirectSrv.closeAllConnections();
  await new Promise<void>((r) => collector.close(() => r()));
  await new Promise<void>((r) => redirectSrv.close(() => r()));
  await app.close();
});

// ---------------------------------------------------------------------------
// write time
// ---------------------------------------------------------------------------

describe("write time: the endpoints refuse a destination before it is ever stored", () => {
  it("a CONNECTOR pointed at IMDS is refused, audited, and stores nothing", async () => {
    const name = `ce-imds-${uniq()}`;
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/connectors",
      payload: { name, kind: "rest-api", providerKind: "http", baseUrl: IMDS },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().code).toBe("host_not_allowlisted");
    expect(res.json().detail).toContain("169.254.169.254");

    expect(await db.select().from(connectors).where(eq(connectors.name, name))).toHaveLength(0);

    const audit = await lastAudit("connector-egress-blocked");
    expect(audit).toBeDefined();
    expect(audit!.effect).toBe("deny");
    expect(audit!.objectType).toBe("connector");
    expect((audit!.detail as { phase: string }).phase).toBe("connector_write");
  });

  it("a connector CREDENTIAL baseUrl at IMDS is refused too — the override is the same primitive", async () => {
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/connectors",
      payload: { name: `ce-cred-${uniq()}`, kind: "rest-api", providerKind: "http" },
    });
    expect(created.statusCode).toBe(201);
    const connectorId = created.json().id as string;

    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/connectors/${connectorId}/credential`,
      payload: { token: "super-secret-token", baseUrl: IMDS },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("egress_blocked");
    expect(
      await db
        .select()
        .from(connectorCredentials)
        .where(eq(connectorCredentials.connectorId, connectorId)),
    ).toHaveLength(0);
    const audit = await lastAudit("connector-egress-blocked");
    expect((audit!.detail as { phase: string }).phase).toBe("connector_credential_write");
  });

  it("a GIT connection pointed at IMDS is refused, audited, and stores nothing", async () => {
    const name = `ce-git-imds-${uniq()}`;
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/git/connections",
      payload: { name, provider: "github", token: "ghp_x", baseUrl: IMDS },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("egress_blocked");
    expect(await db.select().from(gitConnections).where(eq(gitConnections.name, name))).toHaveLength(0);

    const audit = await lastAudit("git-connection-egress-blocked");
    expect(audit!.effect).toBe("deny");
    expect(audit!.objectType).toBe("git_connection");
    expect((audit!.detail as { phase: string }).phase).toBe("git_connection_write");
  });

  it("a PM connection pointed at IMDS is refused, audited, and stores nothing", async () => {
    const name = `ce-pm-imds-${uniq()}`;
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/connections",
      payload: { name, provider: "jira", project: "REG", token: "bot@example.com:tok", baseUrl: IMDS },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("egress_blocked");
    expect(await db.select().from(pmConnections).where(eq(pmConnections.name, name))).toHaveLength(0);

    const audit = await lastAudit("pm-connection-egress-blocked");
    expect(audit!.effect).toBe("deny");
    expect(audit!.objectType).toBe("pm_connection");
    expect((audit!.detail as { phase: string }).phase).toBe("pm_connection_write");
  });

  it("allow-listing the IMDS address does NOT make it reachable — the range check is separate", async () => {
    const allowed = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      // the plaintext opt-in too, so nothing cheaper can be what refuses it:
      // the only thing left standing is the blocked-range check itself
      payload: { host: "169.254.169.254", allowPlaintextHttp: true, note: "deliberate SSRF test" },
    });
    expect(allowed.statusCode).toBe(201);
    try {
      const res = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/connectors",
        payload: { name: `ce-imds2-${uniq()}`, kind: "rest-api", providerKind: "webhook", baseUrl: IMDS },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("blocked_address_range");
      expect(res.json().detail).toContain("link-local");
    } finally {
      await app.inject({
        method: "DELETE",
        headers: AUTH,
        url: `/v1/egress-allow-hosts/${allowed.json().id}`,
      });
    }
  });

  it("the internal-namespace, userinfo and compose-network tricks are refused on these paths too", async () => {
    // `.internal` is where GCP/Azure park their metadata services. Allow-list
    // the exact host first, so the refusal is the SUFFIX rule doing its job
    // rather than default-deny answering before it gets a turn.
    const gcp = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: { host: "metadata.google.internal", allowPlaintextHttp: true, note: "test" },
    });
    expect(gcp.statusCode).toBe(201);
    try {
      for (const [baseUrl, code] of [
        ["http://metadata.google.internal/computeMetadata/v1/", "blocked_host_suffix"],
        // which side of the `@` is the real host? — refused rather than guessed
        ["https://api.example.com@169.254.169.254/v1", "userinfo_forbidden"],
        // Postgres on the compose network
        ["http://db:5432/", "host_not_allowlisted"],
      ] as const) {
        const name = `ce-trick-${uniq()}`;
        const res = await app.inject({
          method: "POST",
          headers: AUTH,
          url: "/v1/connectors",
          payload: { name, kind: "rest-api", providerKind: "webhook", baseUrl },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("egress_blocked");
        expect(res.json().code).toBe(code);
        expect(await db.select().from(connectors).where(eq(connectors.name, name))).toHaveLength(0);
      }
    } finally {
      await app.inject({
        method: "DELETE",
        headers: AUTH,
        url: `/v1/egress-allow-hosts/${gcp.json().id}`,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// THE EXFILTRATION CASE — the reason this surface was the highest priority
// ---------------------------------------------------------------------------

describe("exfiltration: a webhook connector cannot POST a payload to a blocked destination", () => {
  beforeAll(() => {
    collectorHits = [];
  });

  it("a PRE-EXISTING webhook connector aimed at a LIVE collector delivers NOTHING", async () => {
    // The row is written straight into Postgres — no endpoint, no validation,
    // exactly like every connector created before this guard existed. Its
    // baseUrl is a real HTTP server that is listening right now and will
    // happily 200 anything it receives. 127.0.0.1 is NOT allow-listed.
    const connectorId = await insertLegacyConnector(
      `ce-exfil-${uniq()}`,
      "webhook",
      `http://127.0.0.1:${collectorPort}/collect`,
    );

    const res = await invokeConnector(connectorId, {
      note: "quarterly customer export",
      ssn: CANARY,
      rows: [{ email: "victim@example.com", balance: 4210.55 }],
    });

    // refused at the gateway, as a governance decision with a reason
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().code).toBe("host_not_allowlisted");
    expect(res.json().detail).toContain("egress allow-list");

    // AND — the assertion that actually matters — the receiver got nothing.
    expect(collectorHits).toHaveLength(0);
    expect(JSON.stringify(collectorHits)).not.toContain(CANARY);

    // the refusal is filed, naming the connector and the destination host
    const audit = await lastAudit("connector-egress-blocked");
    expect(audit!.effect).toBe("deny");
    expect(audit!.objectType).toBe("connector");
    expect(audit!.objectId).toBe(connectorId);
    expect((audit!.detail as { phase: string }).phase).toBe("call");
    expect((audit!.detail as { host: string }).host).toBe("127.0.0.1");

    // and the row is NOT silently repaired: it keeps its baseUrl. Nulling
    // stored operator configuration behind their back would be a worse failure
    // mode than refusing it loudly, so the refusal IS the migration story.
    const [row] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(row!.baseUrl).toBe(`http://127.0.0.1:${collectorPort}/collect`);
  });

  it("nor via the CREDENTIAL baseUrl, which overrides the connector's", async () => {
    // connector points somewhere harmless; the credential row — the field that
    // actually wins at dispatch — points at the collector.
    const [row] = await db
      .insert(connectors)
      .values({
        name: `ce-exfil-cred-${uniq()}`,
        kind: "exfil-test",
        providerKind: "webhook",
        baseUrl: "https://receiver.example/hook",
      })
      .returning();
    await db.insert(connectorCredentials).values({
      connectorId: row!.id,
      tokenCiphertext: encryptSecret(DATA_KEY, "bridge-token"),
      baseUrl: `http://127.0.0.1:${collectorPort}/collect`,
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/connectors",
      payload: { userId, connectorId: row!.id, mode: "readwrite" },
    });

    const res = await invokeConnector(row!.id, { ssn: CANARY });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("egress_blocked");
    expect(collectorHits).toHaveLength(0);
    expect(JSON.stringify(collectorHits)).not.toContain(CANARY);
  });
});

// ---------------------------------------------------------------------------
// call time — the rows that predate the guard
// ---------------------------------------------------------------------------

describe("call time: rows that never went through an endpoint are still refused", () => {
  it("a PRE-EXISTING http connector pointed at IMDS is refused at invoke", async () => {
    const connectorId = await insertLegacyConnector(`ce-legacy-http-${uniq()}`, "http", IMDS);
    const res = await invokeConnector(connectorId, { q: "creds" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().detail).toContain("169.254.169.254");

    const [row] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(row!.baseUrl).toBe(IMDS);
  });

  it("a PRE-EXISTING pm_connections row pointed at IMDS is a real 403 at pm-sync", async () => {
    const name = `ce-pm-legacy-${uniq()}`;
    await db.insert(pmConnections).values({
      name,
      provider: "jira",
      baseUrl: IMDS,
      project: "REG",
      tokenCiphertext: encryptSecret(DATA_KEY, "bot@example.com:tok"),
      webhookSecretHash: "unused",
    });

    const created = await app.inject({
      method: "POST",
      headers: userAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: `ce-pm-run-${uniq()}`,
          escalationApproverUserId: approverId,
          nodes: [
            {
              id: "task",
              title: "Do the thing",
              ownerAgentId: workerAgentId,
              mode: "execute",
              estimate: { in: 5, out: 10 },
            },
          ],
        },
      },
    });
    expect(created.statusCode).toBe(201);

    const synced = await app.inject({
      method: "POST",
      headers: userAuth,
      url: `/v1/runs/${created.json().id}/pm-sync`,
      payload: { connectionName: name },
    });
    expect(synced.statusCode).toBe(403);
    expect(synced.json().error).toBe("egress_blocked");
    expect(synced.json().detail).toContain("169.254.169.254");

    const audit = await lastAudit("pm-connection-egress-blocked");
    expect(audit!.effect).toBe("deny");
    expect((audit!.detail as { phase: string }).phase).toBe("call");

    // not silently repaired
    const [row] = await db.select().from(pmConnections).where(eq(pmConnections.name, name));
    expect(row!.baseUrl).toBe(IMDS);
  });

  it("a PRE-EXISTING git_connections row pointed at IMDS never reaches the provider", async () => {
    const connName = `ce-git-legacy-${uniq()}`;
    await db.insert(gitConnections).values({
      name: connName,
      provider: "github",
      baseUrl: IMDS,
      tokenCiphertext: encryptSecret(DATA_KEY, "ghp_legacy"),
    });

    const changeType = `ce-git-change-${uniq()}`;
    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: `ce-git-tpl-${uniq()}`,
        definition: {
          workflow: "ce-git",
          stages: [
            { id: "intake", type: "trigger" },
            {
              id: "branch",
              type: "git_operation",
              action: "create_branch",
              connection: connName,
              repo: "acme/app",
            },
          ],
        },
      },
    });
    expect(tpl.statusCode).toBe(201);
    const rule = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType },
    });
    expect(rule.statusCode).toBe(201);

    const started = await app.inject({
      method: "POST",
      headers: userAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "egress-guarded git stage",
          paths: ["src/x.ts"],
          changeType,
          environment: "staging",
        },
      },
    });
    expect(started.statusCode).toBe(201);

    // the stage FAILED CLOSED rather than reaching GitHub-at-169.254.169.254:
    // there is no per-git-call HTTP boundary to 403 from, so the refusal
    // surfaces the way every other git execution failure does — visibly, with
    // the reason, and with nothing having left the box.
    const view = await app.inject({
      method: "GET",
      headers: userAuth,
      url: `/v1/workflows/instances/${started.json().id}`,
    });
    const ctx = view.json().instance.context as { lastError?: string };
    expect(ctx.lastError).toContain("egress blocked");
    expect(ctx.lastError).toContain("169.254.169.254");

    const audit = await lastAudit("git-connection-egress-blocked");
    expect(audit!.effect).toBe("deny");
    expect((audit!.detail as { phase: string }).phase).toBe("call");
  });

  it("a hostname that RESOLVES to link-local is refused, however innocent the name looks", async () => {
    // The literal is never trusted and neither is the name: what matters is
    // what it answers. Resolution is injected so the case is deterministic and
    // needs no network — the allow-list it is checked against is the real one.
    const allowed = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: { host: "hooks.partner-cdn.example", note: "looks like an ordinary SaaS receiver" },
    });
    expect(allowed.statusCode).toBe(201);
    try {
      const rebound = await checkConnectionBaseUrl(db, "https://hooks.partner-cdn.example/hook", {
        resolve: async () => [{ address: "169.254.169.254", family: 4 }],
      });
      expect(rebound.decision.ok).toBe(false);
      expect(rebound.decision.ok === false && rebound.decision.code).toBe("blocked_address_range");

      // split DNS: one good answer does not launder the bad one
      const split = await checkConnectionBaseUrl(db, "https://hooks.partner-cdn.example/hook", {
        resolve: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.7", family: 4 },
        ],
      });
      expect(split.decision.ok).toBe(false);

      // and the ordinary answer is allowed, so this is a guard and not a wall
      const fine = await checkConnectionBaseUrl(db, "https://hooks.partner-cdn.example/hook", {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      });
      expect(fine.decision.ok).toBe(true);
    } finally {
      await app.inject({
        method: "DELETE",
        headers: AUTH,
        url: `/v1/egress-allow-hosts/${allowed.json().id}`,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// the legitimate air-gapped case, and what still stops it
// ---------------------------------------------------------------------------

describe("the allow-listed loopback receiver an air-gapped operator actually wants", () => {
  let allowHostId: string;
  let webhookConnectorId: string;

  beforeAll(async () => {
    collectorHits = [];
    allowHostId = await allowLoopback("connection-egress suite: local receiver");
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/connectors",
      payload: {
        name: `ce-ok-${uniq()}`,
        kind: "notifications",
        providerKind: "webhook",
        baseUrl: `http://127.0.0.1:${collectorPort}/collect`,
        pricePerCallUsd: 0.01,
      },
    });
    expect(created.statusCode).toBe(201);
    webhookConnectorId = created.json().id;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/connectors",
      payload: { userId, connectorId: webhookConnectorId, mode: "readwrite" },
    });
  });

  afterAll(async () => {
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/egress-allow-hosts/${allowHostId}` });
  });

  it("stores the endpoint and delivers the payload end to end, with the Host header pinned", async () => {
    const res = await invokeConnector(webhookConnectorId, { note: "legitimate delivery" });
    expect(res.statusCode).toBe(200);
    expect(collectorHits).toHaveLength(1);
    expect(collectorHits[0]!.body).toContain("legitimate delivery");
    // plaintext http is PINNED to the validated address, and the original host
    // rides the Host header rather than a second DNS answer
    expect(collectorHits[0]!.host).toBe(`127.0.0.1:${collectorPort}`);

    // the destination-host record: "which endpoint did this connector reach"
    const audit = await lastAudit("connector-egress-call");
    expect(audit!.effect).toBe("allow");
    expect(audit!.objectType).toBe("connector");
    expect((audit!.detail as { egress: { host: string; port: number } }).egress.host).toBe("127.0.0.1");
    expect((audit!.detail as { egress: { host: string; port: number } }).egress.port).toBe(collectorPort);
  });

  it("WITHDRAWING the allow entry stops the very next call — the verdict was never cached", async () => {
    const before = collectorHits.length;
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/egress-allow-hosts/${allowHostId}` });
    try {
      const res = await invokeConnector(webhookConnectorId, { note: "should not arrive", ssn: CANARY });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("egress_blocked");
      expect(res.json().detail).toContain("not in the egress allow-list");
      expect(collectorHits).toHaveLength(before);
      expect(JSON.stringify(collectorHits)).not.toContain(CANARY);
    } finally {
      allowHostId = await allowLoopback("restored");
    }
  });

  it("an approved endpoint that REDIRECTS to IMDS is refused mid-flight, not followed", async () => {
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/connectors",
      payload: {
        name: `ce-redirect-${uniq()}`,
        kind: "notifications",
        providerKind: "webhook",
        baseUrl: `http://127.0.0.1:${redirectPort}/hook`,
      },
    });
    expect(created.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/connectors",
      payload: { userId, connectorId: created.json().id, mode: "readwrite" },
    });

    const res = await invokeConnector(created.json().id, { note: "follow me", ssn: CANARY });
    // The guarded fetch throws mid-flight, and the refusal is dug back out of
    // whatever the adapter wrapped it in: it surfaces as the GOVERNANCE
    // decision it is (403 egress_blocked, audited), not as an opaque 500 or a
    // laundered 502 "the connector broke".
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().detail).toContain("redirect");
    const audit = await lastAudit("connector-egress-blocked");
    expect(audit!.effect).toBe("deny");
    expect((audit!.detail as { phase: string }).phase).toBe("call");
  });

  it("a connector with NO baseUrl is untouched by any of this", async () => {
    // The guard governs destinations a human can TYPE. A mock connector has no
    // endpoint at all; requiring an allow entry for it would be ceremony.
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/connectors",
      payload: { name: `ce-mock-${uniq()}`, kind: "data-warehouse", providerKind: "mock" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().baseUrl).toBeNull();
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/connectors",
      payload: { userId, connectorId: created.json().id, mode: "readwrite" },
    });
    const res = await invokeConnector(created.json().id, { note: "no endpoint to guard" });
    expect(res.statusCode).toBe(200);
  });
});
