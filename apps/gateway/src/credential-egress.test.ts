/**
 * ADR-0034 amendment — THE CREDENTIAL `baseUrl` OVERRIDES, ADVERSARIALLY.
 *
 * ADR-0034 shipped the egress guard and then said, in writing, that it had not
 * covered `model_credentials.baseUrl` / `user_model_credentials.baseUrl` — "an
 * equivalent primitive still outside the guard". This file is the proof that
 * it is inside the guard now, and it is written the way an attacker would try
 * it rather than the way a happy path reads:
 *
 *  - point a PLATFORM credential at IMDS and try to save it;
 *  - point a PER-USER credential at IMDS and try to save it (that table is the
 *    more exposed of the two — a non-admin may write their own row);
 *  - skip the endpoint entirely and INSERT THE ROW STRAIGHT INTO POSTGRES, the
 *    way every row written before this guard existed already sits there, then
 *    dispatch through it;
 *  - approve a hostname and re-point its DNS at link-local afterwards;
 *  - get an endpoint approved and then have it redirect to IMDS mid-flight;
 *  - and, last, prove the legitimate air-gapped case still works, because a
 *    guard that only ever says no is a guard nobody keeps switched on.
 *
 * The direct-INSERT cases are not a contrivance. Pre-guard rows exist in the
 * live database right now; refusing them at DISPATCH is the entire reason the
 * check does not stop at write time.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  createDb,
  desc,
  egressAllowHosts,
  eq,
  modelCredentials,
  runMigrations,
  userModelCredentials,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { encryptSecret } from "./secrets.js";
import { checkCredentialBaseUrl } from "./credential-egress.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "cred-egress-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

/** the destination this whole exercise exists to keep unreachable */
const IMDS = "http://169.254.169.254/latest/meta-data/iam/security-credentials/";

let db: Db;
let app: ReturnType<typeof buildApp>;
let srv: http.Server;
let port: number;
let redirectSrv: http.Server;
let redirectPort: number;
let userId: string;
let userAuth: { authorization: string };
let agentId: string;

/** requests the fake OpenAI-compatible endpoint actually received */
let hits: Array<{ auth: string | null; host: string | null }> = [];

async function makeUser(email: string): Promise<{ id: string; auth: { authorization: string } }> {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: "Cred Egress" },
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

const invoke = (auth: { authorization: string }, input = "probe") =>
  app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "execute", input, dispatch: true },
  });

/** wipe both credential tables for this suite's provider between cases */
async function clearCredentials() {
  await db.delete(modelCredentials).where(eq(modelCredentials.provider, "openai"));
  await db.delete(userModelCredentials).where(eq(userModelCredentials.provider, "openai"));
}

async function lastDeny(ruleId: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ruleId, ruleId))
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, keyCustodyEnforced: false });
  // HERMETIC DEFAULT-DENY. Every suite shares one database (fileParallelism is
  // off) and several of them now legitimately allow-list 127.0.0.1 for their
  // own fake endpoints. A file whose whole subject is "what is refused" cannot
  // inherit somebody else's allow entry, so it starts from the empty table
  // that is the product's real default.
  await db.delete(egressAllowHosts);
  // same reasoning for the credential tables: a sibling suite's leftover
  // openai row would make "nothing was stored" mean nothing
  await clearCredentials();

  // a local OpenAI-compatible endpoint — the real adapter, no network
  srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits.push({
        auth: (req.headers.authorization as string) ?? null,
        host: (req.headers.host as string) ?? null,
      });
      const parsed = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-cred-egress",
          object: "chat.completion",
          created: 1,
          model: parsed.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "allow-listed endpoint says hi", refusal: null },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        }),
      );
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  port = (srv.address() as { port: number }).port;

  // an allow-listed endpoint that answers 302 -> IMDS: the shortest path around
  // any pre-flight check, if redirects were followed
  redirectSrv = http.createServer((_req, res) => {
    res.writeHead(302, { location: IMDS });
    res.end();
  });
  await new Promise<void>((r) => redirectSrv.listen(0, "127.0.0.1", r));
  redirectPort = (redirectSrv.address() as { port: number }).port;

  const u = await makeUser("cred-egress-user@example.com");
  userId = u.id;
  userAuth = u.auth;

  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: "cred-egress-openai",
      provider: "openai",
      tier: 1,
      modes: ["execute"],
      costPerMTokIn: 2,
      costPerMTokOut: 8,
      model: "gpt-cred-egress",
    },
  });
  agentId = agent.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId, agentId },
  });
});

afterAll(async () => {
  await clearCredentials();
  srv.closeAllConnections();
  redirectSrv.closeAllConnections();
  await new Promise<void>((r) => srv.close(() => r()));
  await new Promise<void>((r) => redirectSrv.close(() => r()));
  await restoreSb2Gates();
});

// ---------------------------------------------------------------------------
// write time
// ---------------------------------------------------------------------------

describe("write time: the endpoint refuses a destination before it is ever stored", () => {
  it("a PLATFORM credential pointed at IMDS is refused, audited, and stores nothing", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: { provider: "openai", apiKey: "sk-ssrf-attempt", baseUrl: IMDS },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().code).toBe("host_not_allowlisted");
    expect(res.json().detail).toContain("169.254.169.254");

    // nothing was written — a refused destination is not a stored destination
    const rows = await db
      .select()
      .from(modelCredentials)
      .where(eq(modelCredentials.provider, "openai"));
    expect(rows).toHaveLength(0);

    const audit = await lastDeny("model-credential-egress-blocked");
    expect(audit).toBeDefined();
    expect(audit!.effect).toBe("deny");
    expect(audit!.objectType).toBe("model_credential");
    expect((audit!.detail as { phase: string }).phase).toBe("platform_credential_write");
  });

  it("allow-listing the IMDS address does NOT make it reachable — the range check is separate", async () => {
    const allowed = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: {
        host: "169.254.169.254",
        // BOTH opt-ins, so nothing cheaper can be what refuses it: the only
        // thing left standing between this credential and the instance role is
        // the blocked-range check itself.
        allowPlaintextHttp: true,
        note: "deliberate SSRF attempt for the test",
      },
    });
    expect(allowed.statusCode).toBe(201);
    try {
      const res = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/model-credentials",
        payload: { provider: "openai", apiKey: "sk-ssrf-attempt-2", baseUrl: IMDS },
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

  it("a PER-USER credential pointed at IMDS is refused for the user's own row too", async () => {
    const res = await app.inject({
      method: "POST",
      headers: userAuth,
      url: `/v1/users/${userId}/model-credentials`,
      payload: { provider: "openai", apiKey: "sk-user-ssrf", baseUrl: IMDS },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("egress_blocked");
    const rows = await db
      .select()
      .from(userModelCredentials)
      .where(eq(userModelCredentials.userId, userId));
    expect(rows).toHaveLength(0);

    const audit = await lastDeny("model-credential-egress-blocked");
    expect((audit!.detail as { phase: string }).phase).toBe("user_credential_write");
    expect((audit!.detail as { subjectUserId: string }).subjectUserId).toBe(userId);
  });

  it("the internal-namespace and userinfo tricks are refused on this path as well", async () => {
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
        ["https://api.openai.com@169.254.169.254/v1", "userinfo_forbidden"],
        // Postgres on the compose network
        ["http://db:5432/", "host_not_allowlisted"],
        // not an HTTP destination at all
        ["file:///etc/passwd", "unsupported_scheme"],
      ] as const) {
        const res = await app.inject({
          method: "POST",
          headers: AUTH,
          url: "/v1/model-credentials",
          payload: { provider: "openai", apiKey: "sk-x", baseUrl },
        });
        // `file://` may be turned away by the request schema before the guard
        // sees it; either refusal is fine, a 201 is not.
        expect(res.statusCode).toBe(400);
        if (res.json().error === "egress_blocked") expect(res.json().code).toBe(code);
      }
    } finally {
      await app.inject({
        method: "DELETE",
        headers: AUTH,
        url: `/v1/egress-allow-hosts/${gcp.json().id}`,
      });
    }
    expect(
      await db.select().from(modelCredentials).where(eq(modelCredentials.provider, "openai")),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dispatch time — the rows that predate the guard
// ---------------------------------------------------------------------------

describe("dispatch time: a row that never went through the endpoint is still refused", () => {
  beforeAll(async () => {
    await clearCredentials();
    hits = [];
  });

  it("a PRE-EXISTING platform row pointed at IMDS is refused at dispatch, with nothing leaving the box", async () => {
    // written directly, exactly as every row created before this guard existed
    await db.insert(modelCredentials).values({
      provider: "openai",
      keyCiphertext: encryptSecret(DATA_KEY, "sk-legacy-row"),
      baseUrl: IMDS,
    });

    const res = await invoke(userAuth);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().detail).toContain("169.254.169.254");
    expect(res.json().detail).toContain("platform_credential");
    expect(hits).toHaveLength(0);

    const audit = await lastDeny("model-credential-egress-blocked");
    expect(audit!.effect).toBe("deny");
    expect((audit!.detail as { phase: string }).phase).toBe("dispatch");

    // AND IT IS NOT SILENTLY REPAIRED: the row keeps its baseUrl. Nulling
    // stored operator configuration behind their back would be a worse failure
    // mode than refusing it loudly, so the refusal is the migration story.
    const [row] = await db
      .select()
      .from(modelCredentials)
      .where(eq(modelCredentials.provider, "openai"));
    expect(row!.baseUrl).toBe(IMDS);
    await clearCredentials();
  });

  it("a PRE-EXISTING per-user row pointed at IMDS is refused at dispatch too", async () => {
    await db.insert(userModelCredentials).values({
      userId,
      provider: "openai",
      keyCiphertext: encryptSecret(DATA_KEY, "sk-legacy-user-row"),
      baseUrl: IMDS,
    });

    const res = await invoke(userAuth);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().detail).toContain("user_credential");
    expect(hits).toHaveLength(0);
    await clearCredentials();
  });

  it("a hostname that RESOLVES to link-local is refused, however innocent the name looks", async () => {
    // The literal is never trusted and neither is the name: what matters is
    // what it answers. Resolution is injected so the case is deterministic and
    // needs no network — the allow-list it is checked against is the real one.
    const allowed = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: { host: "models.corp-cdn.example", note: "looks like an ordinary vendor host" },
    });
    expect(allowed.statusCode).toBe(201);
    try {
      const rebound = await checkCredentialBaseUrl(db, "https://models.corp-cdn.example/v1", {
        resolve: async () => [{ address: "169.254.169.254", family: 4 }],
      });
      expect(rebound.decision.ok).toBe(false);
      expect(rebound.decision.ok === false && rebound.decision.code).toBe("blocked_address_range");

      // split DNS: one good answer does not launder the bad one
      const split = await checkCredentialBaseUrl(db, "https://models.corp-cdn.example/v1", {
        resolve: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.7", family: 4 },
        ],
      });
      expect(split.decision.ok).toBe(false);

      // and the ordinary answer is allowed, so this is a guard and not a wall
      const fine = await checkCredentialBaseUrl(db, "https://models.corp-cdn.example/v1", {
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

describe("the allow-listed loopback endpoint an air-gapped operator actually wants", () => {
  let allowHostId: string;

  beforeAll(async () => {
    await clearCredentials();
    hits = [];
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: {
        host: "127.0.0.1",
        allowPrivateRanges: true,
        allowPlaintextHttp: true,
        note: "local self-hosted model server",
      },
    });
    expect(res.statusCode).toBe(201);
    allowHostId = res.json().id;
  });

  afterAll(async () => {
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/egress-allow-hosts/${allowHostId}` });
    await clearCredentials();
  });

  it("stores the override and dispatches through it end to end", async () => {
    const stored = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: {
        provider: "openai",
        apiKey: "sk-local-endpoint",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      },
    });
    expect(stored.statusCode).toBe(201);

    const res = await invoke(userAuth, "hello local");
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch.outputText).toBe("allow-listed endpoint says hi");
    expect(res.json().dispatch.credentialSource).toBe("platform");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.auth).toBe("Bearer sk-local-endpoint");
    // plaintext http is PINNED to the validated address, and the original host
    // rides the Host header rather than a second DNS answer
    expect(hits[0]!.host).toBe(`127.0.0.1:${port}`);
  });

  it("WITHDRAWING the allow entry stops the very next dispatch — the verdict was never cached", async () => {
    const before = hits.length;
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/egress-allow-hosts/${allowHostId}` });
    try {
      const res = await invoke(userAuth, "hello again");
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("egress_blocked");
      expect(res.json().detail).toContain("not in the egress allow-list");
      expect(hits).toHaveLength(before);
    } finally {
      const re = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/egress-allow-hosts",
        payload: {
          host: "127.0.0.1",
          allowPrivateRanges: true,
          allowPlaintextHttp: true,
          note: "restored",
        },
      });
      allowHostId = re.json().id;
    }
  });

  it("an approved endpoint that REDIRECTS to IMDS is refused mid-flight, not followed", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: {
        provider: "openai",
        apiKey: "sk-redirector",
        baseUrl: `http://127.0.0.1:${redirectPort}/v1`,
      },
    });
    const res = await invoke(userAuth, "follow me");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().detail).toContain("redirect");

    // the refusal is a governance event, filed against the credential surface
    const audit = await lastDeny("model-credential-egress-blocked");
    expect(audit!.effect).toBe("deny");
    expect(audit!.objectType).toBe("model_credential");
  });

  it("a credential with NO baseUrl is untouched by any of this — the vendor default is not allow-listed", async () => {
    // The guard governs destinations a human can TYPE. With no override the
    // adapter uses its compiled vendor endpoint, so requiring an allow entry
    // for api.openai.com would be ceremony, not security. Proven by the fact
    // that storing a keyed credential with no baseUrl still succeeds while
    // 127.0.0.1 is the only allow-listed host in the table.
    await clearCredentials();
    const stored = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: { provider: "openai", apiKey: "sk-vendor-default" },
    });
    expect(stored.statusCode).toBe(201);
    expect(stored.json().baseUrl).toBeNull();
    await clearCredentials();
  });
});
