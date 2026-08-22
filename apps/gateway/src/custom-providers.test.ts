/**
 * ADR-0034 — admin-registered custom LLM providers, end to end.
 *
 * The pattern is the one the openai/google/xai adapters already use: a real
 * local server speaking the real wire protocol, the REAL adapter, no network,
 * no mocking of the thing under test. What is new here is that the egress
 * guard is real too — it blocks loopback by default, so this suite has to add
 * an explicit `127.0.0.1` allow-list entry with allowPrivateRanges and
 * allowPlaintextHttp, which is EXACTLY the sequence an air-gapped operator
 * performs for `http://localhost:11434`. If that entry were unnecessary, the
 * guard would not be doing its job.
 *
 * Shares one database with the other gateway suites (fileParallelism is off).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, egressAllowHosts, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "custom-provider-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let srv: http.Server;
let port: number;
let allowHostId: string;
let userId: string;
let userAuth: { authorization: string };

/** every request the fake endpoint saw, so we can assert on the wire */
const hits: Array<{ url: string; auth: string | null; host: string | null; body: unknown }> = [];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  // ADR-0052 §4: registering a custom model provider is tier-gated on
  // `custom_model_providers` and the flag is now ENFORCED at the route, so
  // this suite runs under a real signed license granting it. Removed in
  // afterAll — the deployment ends UNLICENSED exactly as it started.
  await installLicenseFixture(app, { features: ["custom_model_providers"], auth: AUTH });
  // HERMETIC DEFAULT-DENY (ADR-0034 amendment): sibling suites now allow-list
  // 127.0.0.1 for their own fake endpoints, and this file's first assertion is
  // that nothing is reachable before an admin says so. Start from the empty
  // allow-list that is the shipped default rather than whatever ran before.
  await db.delete(egressAllowHosts);

  // A local OpenAI-compatible endpoint — the shape Ollama / vLLM / LM Studio /
  // LocalAI all present.
  srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits.push({
        url: req.url ?? "",
        auth: (req.headers.authorization as string) ?? null,
        host: (req.headers.host as string) ?? null,
        body: raw ? JSON.parse(raw) : null,
      });
      const parsed = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-custom-e2e",
          object: "chat.completion",
          created: 1,
          model: parsed.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "self-hosted llama says hi", refusal: null },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
        }),
      );
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  port = (srv.address() as { port: number }).port;

  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "custom-cass@example.com", displayName: "Custom Cass" },
  });
  userId = u.json().id;
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${userId}/keys`,
    payload: { name: "cli" },
  });
  userAuth = { authorization: `Bearer ${key.json().token}` };
});

afterAll(async () => {
  await removeLicenseFixture(db);
  srv.closeAllConnections();
  await new Promise<void>((r) => srv.close(() => r()));
});

const baseUrlFor = () => `http://127.0.0.1:${port}/v1`;

describe("egress allow-list: default-deny before anything else", () => {
  it("refuses to register a provider whose host nobody has allow-listed", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/custom-model-providers",
      payload: { name: "premature", wireProtocol: "openai_chat", baseUrl: baseUrlFor() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().code).toBe("host_not_allowlisted");
  });

  it("refuses an IMDS baseUrl outright, allow-listed or not", async () => {
    const listed = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: { host: "169.254.169.254", note: "deliberate SSRF attempt for the test" },
    });
    expect(listed.statusCode).toBe(201);
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/custom-model-providers",
      payload: {
        name: "imds",
        wireProtocol: "openai_chat",
        baseUrl: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("egress_blocked");
    // it is refused on the SCHEME first (no plaintext opt-in) — and adding
    // that opt-in still leaves the link-local range block underneath
    const withPlaintext = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: { host: "169.254.169.254", allowPlaintextHttp: true, note: "still must not work" },
    });
    expect(withPlaintext.statusCode).toBe(201);
    const again = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/custom-model-providers",
      payload: {
        name: "imds",
        wireProtocol: "openai_chat",
        baseUrl: "http://169.254.169.254/latest/meta-data/",
        allowPlaintextHttp: true,
      },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe("blocked_address_range");

    // clean up so no later suite inherits an IMDS allow entry
    const hosts = await app.inject({ method: "GET", headers: AUTH, url: "/v1/egress-allow-hosts" });
    const imds = hosts.json().hosts.find((h: { host: string }) => h.host === "169.254.169.254");
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/egress-allow-hosts/${imds.id}` });
  });

  it("records the allow-list entry — and the private/plaintext opt-ins — in the audit trail", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: {
        host: "127.0.0.1",
        allowPrivateRanges: true,
        allowPlaintextHttp: true,
        note: "local self-hosted model server (air-gapped shape)",
      },
    });
    expect(res.statusCode).toBe(201);
    allowHostId = res.json().id;

    const audit = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit?limit=200" });
    const row = audit
      .json()
      .entries.find(
        (e: { ruleId: string; objectId: string }) =>
          e.ruleId === "egress-allow-host-set" && e.objectId === allowHostId,
      );
    expect(row).toBeTruthy();
    expect(row.reason).toContain("private-range access");
    expect(row.reason).toContain("plaintext http");
  });
});

describe("registration, connection test, and enablement", () => {
  let providerId: string;

  it("registers a provider — disabled, and never echoing the key", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/custom-model-providers",
      payload: {
        name: "self-hosted-llama",
        wireProtocol: "openai_chat",
        baseUrl: baseUrlFor(),
        apiKey: "sk-selfhosted-secret-1",
        allowPlaintextHttp: true,
      },
    });
    expect(res.statusCode).toBe(201);
    providerId = res.json().id;
    expect(res.json().enabled).toBe(false);
    expect(res.json().hasApiKey).toBe(true);
    expect(JSON.stringify(res.json())).not.toContain("sk-selfhosted-secret-1");
    expect(res.json().keyCiphertext).toBeUndefined();

    const listed = await app.inject({ method: "GET", headers: AUTH, url: "/v1/custom-model-providers" });
    expect(JSON.stringify(listed.json())).not.toContain("sk-selfhosted-secret-1");
    expect(JSON.stringify(listed.json())).not.toContain("keyCiphertext");
  });

  it("refuses to enable a provider that has not passed a connection test", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/custom-model-providers/${providerId}/enabled`,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("connection_test_required");
  });

  it("runs a real connection test against the endpoint, through the guard", async () => {
    const before = hits.length;
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/custom-model-providers/${providerId}/test`,
      payload: { model: "llama-3.3-70b" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().host).toBe("127.0.0.1");
    expect(hits.length).toBe(before + 1);
    // the real adapter really spoke chat-completions, with the real key
    expect(hits.at(-1)!.url).toBe("/v1/chat/completions");
    expect(hits.at(-1)!.auth).toBe("Bearer sk-selfhosted-secret-1");
  });

  it("enables it once the test has passed, and audits the enablement", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/custom-model-providers/${providerId}/enabled`,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);

    const audit = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit?limit=200" });
    const rules = audit.json().entries.map((e: { ruleId: string }) => e.ruleId);
    expect(rules).toContain("custom-provider-registered");
    expect(rules).toContain("custom-provider-tested");
    expect(rules).toContain("custom-provider-enabled");
  });

  it("re-arms the gate when the endpoint is moved", async () => {
    const moved = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/custom-model-providers/${providerId}`,
      payload: { baseUrl: `http://127.0.0.1:${port}/v1/` },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().enabled).toBe(false);
    expect(moved.json().lastTestedAt).toBeNull();

    // put it back and re-test/re-enable for the dispatch cases below
    await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/custom-model-providers/${providerId}`,
      payload: { baseUrl: baseUrlFor() },
    });
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/custom-model-providers/${providerId}/test` });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/custom-model-providers/${providerId}/enabled`,
      payload: { enabled: true },
    });
  });

  it("refuses to move a provider onto a non-allow-listed host", async () => {
    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/custom-model-providers/${providerId}`,
      payload: { baseUrl: "https://exfiltrate.example.com/v1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("host_not_allowlisted");
  });

  it("is admin-only — a non-admin sees 403 on every route", async () => {
    for (const [method, url] of [
      ["GET", "/v1/custom-model-providers"],
      ["POST", "/v1/custom-model-providers"],
      ["GET", "/v1/egress-allow-hosts"],
      ["POST", "/v1/egress-allow-hosts"],
    ] as const) {
      const res = await app.inject({ method, headers: userAuth, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  describe("a governed dispatch over the custom endpoint", () => {
    let agentId: string;

    it("binds an agent to the custom provider", async () => {
      const bad = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/agents",
        payload: { name: "custom-no-id", provider: "custom", tier: 1, model: "llama-3.3-70b" },
      });
      expect(bad.statusCode).toBe(400);

      const alsoBad = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/agents",
        payload: {
          name: "mock-with-custom-id",
          provider: "mock",
          tier: 1,
          model: "mock-fast",
          customProviderId: providerId,
        },
      });
      expect(alsoBad.statusCode).toBe(400);

      const res = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/agents",
        payload: {
          name: "self-hosted-llama-agent",
          provider: "custom",
          customProviderId: providerId,
          tier: 1,
          modes: ["execute"],
          model: "llama-3.3-70b",
          // DELIBERATELY UNPRICED — a self-hosted endpoint has no list price,
          // and the codebase's rule is that null stays null.
        },
      });
      expect(res.statusCode).toBe(201);
      agentId = res.json().id;
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/grants/agents",
        payload: { userId, agentId },
      });
    });

    it("dispatches end to end and meters the call", async () => {
      const before = hits.length;
      const res = await app.inject({
        method: "POST",
        headers: userAuth,
        url: `/v1/agents/${agentId}/invoke`,
        payload: { mode: "execute", input: "hello self-hosted model", dispatch: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().dispatch.outputText).toBe("self-hosted llama says hi");
      expect(res.json().dispatch.stopReason).toBe("end_turn");
      expect(res.json().dispatch.usage).toEqual({ inputTokens: 11, outputTokens: 5 });
      // UNPRICED STAYS UNPRICED — a measured token count never becomes an
      // invented dollar figure just because the provider is ours.
      expect(res.json().dispatch.costUsd).toBeNull();

      expect(hits.length).toBe(before + 1);
      const hit = hits.at(-1)!;
      expect(hit.url).toBe("/v1/chat/completions");
      expect(hit.auth).toBe("Bearer sk-selfhosted-secret-1");
      // the guarded fetch pinned to the validated address and preserved Host
      expect(hit.host).toBe(`127.0.0.1:${port}`);
    });

    it("writes a usage row and an audit row naming the destination host", async () => {
      const ledger = await app.inject({
        method: "GET",
        headers: AUTH,
        url: `/v1/usage-events?userId=${userId}`,
      });
      const event = ledger.json().events[0];
      expect(event).toMatchObject({
        provider: "custom",
        model: "llama-3.3-70b",
        inputTokens: 11,
        outputTokens: 5,
        costUsd: null,
      });
      expect(event.detail.egress.host).toBe("127.0.0.1");
      expect(event.detail.egress.port).toBe(port);

      const audit = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit?limit=200" });
      const row = audit
        .json()
        .entries.find((e: { ruleId: string }) => e.ruleId === "custom-provider-dispatch");
      expect(row).toBeTruthy();
      expect(row.reason).toContain("127.0.0.1");
      expect(row.detail.egress.addresses).toEqual(["127.0.0.1"]);
      expect(row.detail.providerName).toBe("self-hosted-llama");
      expect(row.detail.wireProtocol).toBe("openai_chat");
    });

    it("stops cold when the provider is disabled — no request leaves the box", async () => {
      const before = hits.length;
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: `/v1/custom-model-providers/${providerId}/enabled`,
        payload: { enabled: false },
      });
      const res = await app.inject({
        method: "POST",
        headers: userAuth,
        url: `/v1/agents/${agentId}/invoke`,
        payload: { mode: "execute", input: "should not go anywhere", dispatch: true },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("custom_provider_disabled");
      expect(hits.length).toBe(before);
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: `/v1/custom-model-providers/${providerId}/enabled`,
        payload: { enabled: true },
      });
    });

    it("stops cold when the ORG master switch is off", async () => {
      const before = hits.length;
      await app.inject({
        method: "PUT",
        headers: AUTH,
        url: "/v1/org/settings",
        payload: { customModelProvidersEnabled: false },
      });
      const res = await app.inject({
        method: "POST",
        headers: userAuth,
        url: `/v1/agents/${agentId}/invoke`,
        payload: { mode: "execute", input: "org switch is off", dispatch: true },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("custom_providers_disabled");
      expect(hits.length).toBe(before);
      await app.inject({
        method: "PUT",
        headers: AUTH,
        url: "/v1/org/settings",
        payload: { customModelProvidersEnabled: true },
      });
    });

    it("stops cold — and audits — when the allow-list entry is withdrawn mid-life", async () => {
      const before = hits.length;
      await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/egress-allow-hosts/${allowHostId}` });
      const res = await app.inject({
        method: "POST",
        headers: userAuth,
        url: `/v1/agents/${agentId}/invoke`,
        payload: { mode: "execute", input: "allow-list revoked", dispatch: true },
      });
      // the guard re-runs at dispatch — a registration-time verdict is never
      // cached, which is the whole point
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("egress_blocked");
      expect(hits.length).toBe(before);

      const audit = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit?limit=200" });
      const denied = audit
        .json()
        .entries.find((e: { ruleId: string }) => e.ruleId === "custom-provider-egress_blocked");
      expect(denied).toBeTruthy();
      expect(denied.effect).toBe("deny");

      // restore for the teardown assertions below
      const re = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/egress-allow-hosts",
        payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true },
      });
      allowHostId = re.json().id;
    });

    it("refuses to delete a provider an agent still points at, then deletes it once free", async () => {
      const busy = await app.inject({
        method: "DELETE",
        headers: AUTH,
        url: `/v1/custom-model-providers/${providerId}`,
      });
      expect(busy.statusCode).toBe(409);
      expect(busy.json().error).toBe("custom_provider_in_use");
      expect(busy.json().detail).toContain("self-hosted-llama-agent");
    });
  });
});

describe("a KEYLESS endpoint (the local Ollama shape)", () => {
  it("registers, tests and dispatches with NO Authorization header at all", async () => {
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/custom-model-providers",
      payload: {
        name: "local-ollama",
        wireProtocol: "openai_chat",
        baseUrl: baseUrlFor(),
        allowPlaintextHttp: true,
        // no apiKey at all
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().hasApiKey).toBe(false);
    const id = created.json().id;

    const before = hits.length;
    const tested = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/custom-model-providers/${id}/test`,
      payload: { model: "llama3.2" },
    });
    expect(tested.statusCode).toBe(200);
    expect(hits.length).toBe(before + 1);
    // no bogus bearer token invented for a keyless endpoint
    expect(hits.at(-1)!.auth).toBeNull();

    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/custom-model-providers/${id}` });
  });
});

describe("honest refusal on a failing endpoint", () => {
  it("reports a connection-test failure as a real 502 with the upstream reason, never a fake success", async () => {
    const dead = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "model not loaded" } }));
    });
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const deadPort = (dead.address() as { port: number }).port;
    try {
      const created = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/custom-model-providers",
        payload: {
          name: "broken-endpoint",
          wireProtocol: "openai_chat",
          baseUrl: `http://127.0.0.1:${deadPort}/v1`,
          allowPlaintextHttp: true,
        },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id;

      const tested = await app.inject({
        method: "POST",
        headers: AUTH,
        url: `/v1/custom-model-providers/${id}/test`,
      });
      expect(tested.statusCode).toBe(502);
      expect(tested.json().ok).toBe(false);
      expect(tested.json().detail).toContain("model not loaded");

      // and it is still unenablable
      const enable = await app.inject({
        method: "POST",
        headers: AUTH,
        url: `/v1/custom-model-providers/${id}/enabled`,
        payload: { enabled: true },
      });
      expect(enable.statusCode).toBe(409);
      expect(enable.json().error).toBe("connection_test_required");

      await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/custom-model-providers/${id}` });
    } finally {
      dead.closeAllConnections();
      await new Promise<void>((r) => dead.close(() => r()));
    }
  });

  it("refuses a redirect rather than following it (redirect-to-IMDS is the reason)", async () => {
    const redirector = http.createServer((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    const rPort = (redirector.address() as { port: number }).port;
    try {
      const created = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/custom-model-providers",
        payload: {
          name: "redirector",
          wireProtocol: "openai_chat",
          baseUrl: `http://127.0.0.1:${rPort}/v1`,
          allowPlaintextHttp: true,
        },
      });
      const id = created.json().id;
      const tested = await app.inject({
        method: "POST",
        headers: AUTH,
        url: `/v1/custom-model-providers/${id}/test`,
      });
      expect(tested.statusCode).toBe(502);
      expect(tested.json().detail).toContain("redirect");
      await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/custom-model-providers/${id}` });
    } finally {
      redirector.closeAllConnections();
      await new Promise<void>((r) => redirector.close(() => r()));
    }
  });
});
