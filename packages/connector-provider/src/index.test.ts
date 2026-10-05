import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  ConnectorProviderError,
  ConnectorRateLimitError,
  GenericHttpConnectorProvider,
  GitHubConnectorProvider,
  JiraConnectorProvider,
  MockConnectorProvider,
  SlackConnectorProvider,
  SnowflakeConnectorProvider,
  TEAMS_DEFAULT_BASE_URL,
  TeamsConnectorProvider,
  OUTLOOK_DEFAULT_GRAPH_BASE_URL,
  OutlookConnectorProvider,
  parseOutlookCredential,
  WebhookConnectorProvider,
  buildSnowflakeJwt,
  connectorDefaultBaseUrl,
  isConnectorProviderKind,
  parseSnowflakeCredential,
  parseTeamsCredential,
  resolveConnectorProvider,
  reservedChatControl,
} from "./index.js";

// one RSA key pair for every snowflake test (2048-bit keeps the suite fast);
// a second, passphrase-encrypted export exercises the encrypted-PEM path
const SNOWFLAKE_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = SNOWFLAKE_KEYS.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const PUBLIC_KEY_PEM = SNOWFLAKE_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
const ENCRYPTED_PRIVATE_KEY_PEM = SNOWFLAKE_KEYS.privateKey
  .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "open-sesame" })
  .toString();

// ---------------------------------------------------------------------------
// Fake-upstream harness: a real node:http server per test, hit through the
// adapters' default (real) fetch — proving the exact method/path/headers/body
// each adapter puts on the wire, not just what it hands an injected stub.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface FakeUpstream {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

async function startFakeUpstream(
  handler: (req: CapturedRequest, res: ServerResponse) => void,
): Promise<FakeUpstream> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      };
      requests.push(captured);
      handler(captured, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function reply(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function withUpstream<T>(
  handler: (req: CapturedRequest, res: ServerResponse) => void,
  run: (upstream: FakeUpstream) => Promise<T>,
): Promise<T> {
  const upstream = await startFakeUpstream(handler);
  try {
    return await run(upstream);
  } finally {
    await upstream.close();
  }
}

describe("generic HTTP adapter (injectable fetch, no network)", () => {
  it("reads via GET {baseUrl}/{object} with a bearer token", async () => {
    const calls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
    const conn = new GenericHttpConnectorProvider("generic", {
      baseUrl: "https://api.example.com/v1/",
      token: "secret-token",
      fetchImpl: async (url, init) => {
        calls.push({ url, init: init ?? {} });
        return { status: 200, json: async () => ({}), text: async () => JSON.stringify({ ok: true, items: [1, 2] }) };
      },
    });
    const res = await conn.invoke({ operation: "read", object: "accounts" });
    expect(calls[0]!.url).toBe("https://api.example.com/v1/accounts");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.headers!.authorization).toBe("Bearer secret-token");
    expect(res).toEqual({ status: 200, body: { ok: true, items: [1, 2] } });
  });

  it("writes via POST {baseUrl}/{object} with the payload as a JSON body", async () => {
    let captured: { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } } | null = null;
    const conn = new GenericHttpConnectorProvider("http", {
      baseUrl: "https://api.example.com",
      fetchImpl: async (url, init) => {
        captured = { url, init: init ?? {} };
        return { status: 201, json: async () => ({}), text: async () => JSON.stringify({ id: "new-1" }) };
      },
    });
    const res = await conn.invoke({ operation: "write", object: "issues", payload: { title: "Bug" } });
    expect(captured!.url).toBe("https://api.example.com/issues");
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.headers!["content-type"]).toBe("application/json");
    // no token → no authorization header
    expect(captured!.init.headers!.authorization).toBeUndefined();
    expect(JSON.parse(captured!.init.body!)).toEqual({ title: "Bug" });
    expect(res).toEqual({ status: 201, body: { id: "new-1" } });
  });

  it("surfaces a non-2xx as a ConnectorProviderError carrying the status", async () => {
    const conn = new GenericHttpConnectorProvider("generic", {
      baseUrl: "https://api.example.com",
      fetchImpl: async () => ({ status: 403, json: async () => ({}), text: async () => "forbidden" }),
    });
    const err = (await conn.invoke({ operation: "read", object: "payroll" }).catch((e: unknown) => e)) as ConnectorProviderError;
    expect(err).toBeInstanceOf(ConnectorProviderError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("forbidden");
  });
});

describe("webhook adapter (injectable fetch, no network)", () => {
  it("POSTs a normalized envelope to the receiver, with a bearer token when present", async () => {
    let captured: { url: string; init: { headers?: Record<string, string>; body?: string } } | null = null;
    const conn = new WebhookConnectorProvider({
      baseUrl: "https://recv.example/hook",
      token: "shh",
      fetchImpl: async (url, init) => {
        captured = { url, init: init ?? {} };
        return { status: 200, json: async () => ({}), text: async () => "" };
      },
    });
    const res = await conn.invoke({ operation: "write", object: "event", payload: { a: 1 } });
    expect(captured!.url).toBe("https://recv.example/hook");
    expect(captured!.init.headers!.authorization).toBe("Bearer shh");
    const env = JSON.parse(captured!.init.body!);
    expect(env).toMatchObject({ operation: "write", object: "event", payload: { a: 1 } });
    expect(typeof env.timestamp).toBe("string");
    expect(res).toEqual({ status: 200, body: null });
  });
});

describe("mock adapter (deterministic, keyless)", () => {
  it("reads a canned object and records/echoes writes", async () => {
    const mock = new MockConnectorProvider();
    const read = await mock.invoke({ operation: "read", object: "accounts" });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      object: "accounts",
      records: [
        { id: "accounts-1", name: "mock accounts #1" },
        { id: "accounts-2", name: "mock accounts #2" },
      ],
      source: "mock-connector",
    });
    // determinism: the same read twice yields identical bodies
    const again = await mock.invoke({ operation: "read", object: "accounts" });
    expect(again.body).toEqual(read.body);

    const write = await mock.invoke({ operation: "write", object: "accounts", payload: { name: "x" } });
    expect(write.body).toMatchObject({ ok: true, operation: "write", object: "accounts", echoed: { name: "x" } });
    expect(mock.writes).toEqual([{ object: "accounts", payload: { name: "x" } }]);
  });
});

describe("registry", () => {
  it("resolves mock (keyless, shared instance) and generic/http/webhook (baseUrl required)", () => {
    const a = resolveConnectorProvider({ kind: "mock" });
    const b = resolveConnectorProvider({ kind: "mock" });
    expect(a).toBe(b); // shared instance, state persists across resolutions
    expect(a.kind).toBe("mock");

    expect(resolveConnectorProvider({ kind: "generic", baseUrl: "https://x.example" }).kind).toBe("generic");
    expect(resolveConnectorProvider({ kind: "http", baseUrl: "https://x.example" }).kind).toBe("http");
    expect(resolveConnectorProvider({ kind: "webhook", baseUrl: "https://x.example" }).kind).toBe("webhook");

    expect(() => resolveConnectorProvider({ kind: "generic" })).toThrow(/baseUrl/);
    expect(() => resolveConnectorProvider({ kind: "http" })).toThrow(/baseUrl/);
    expect(() => resolveConnectorProvider({ kind: "webhook" })).toThrow(/baseUrl/);
  });

  it("resolves snowflake (ADR-0023: token = the JSON credential; malformed token fails actionable)", () => {
    // The ROADMAP Batch B deferral is CLOSED: the credential rides ADR-0023's
    // structured-JSON convention inside the one token. A non-JSON token must
    // fail with the convention spelled out, never an opaque parse error.
    expect(
      resolveConnectorProvider({
        kind: "snowflake",
        token: JSON.stringify({ account: "acme-x1", user: "svc", privateKey: PRIVATE_KEY_PEM }),
      }).kind,
    ).toBe("snowflake");
    const err = (() => {
      try {
        resolveConnectorProvider({ kind: "snowflake", baseUrl: "https://x.example", token: "t" });
        return null;
      } catch (e) {
        return e as ConnectorProviderError;
      }
    })();
    expect(err).toBeInstanceOf(ConnectorProviderError);
    expect(err!.status).toBe(400);
    expect(err!.message).toContain("{account, user, privateKey, passphrase?}");
    expect(() => resolveConnectorProvider({ kind: "snowflake" })).toThrow(/token/);
  });

  it("resolves slack/github/jira with their per-kind config requirements", () => {
    // slack + github: token required, baseUrl optional (has a public default)
    expect(resolveConnectorProvider({ kind: "slack", token: "xoxb-1" }).kind).toBe("slack");
    expect(resolveConnectorProvider({ kind: "github", token: "ghp_x" }).kind).toBe("github");
    expect(() => resolveConnectorProvider({ kind: "slack" })).toThrow(/token/);
    expect(() => resolveConnectorProvider({ kind: "github" })).toThrow(/token/);
    // jira: baseUrl AND an "email:api_token" credential are both required
    expect(
      resolveConnectorProvider({
        kind: "jira",
        baseUrl: "https://x.atlassian.net",
        token: "jane@corp.com:tok",
      }).kind,
    ).toBe("jira");
    expect(() => resolveConnectorProvider({ kind: "jira", token: "a:b" })).toThrow(/baseUrl/);
    expect(() =>
      resolveConnectorProvider({ kind: "jira", baseUrl: "https://x.atlassian.net" }),
    ).toThrow(/token/);
  });

  it("isConnectorProviderKind guards the kind union", () => {
    expect(isConnectorProviderKind("mock")).toBe(true);
    expect(isConnectorProviderKind("generic")).toBe(true);
    expect(isConnectorProviderKind("salesforce")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Slack adapter — object = channel ID; Slack's ok:false envelope → typed errors
// ---------------------------------------------------------------------------

describe("slack adapter (fake upstream)", () => {
  it("bare read (object=null) hits conversations.list with the bearer bot token", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { ok: true, channels: [{ id: "C1", name: "general" }] }),
      async (up) => {
        const slack = new SlackConnectorProvider({ token: "xoxb-abc", baseUrl: up.url });
        const res = await slack.invoke({ operation: "read" });
        expect(up.requests[0]!.method).toBe("GET");
        expect(up.requests[0]!.url).toBe("/conversations.list");
        expect(up.requests[0]!.headers.authorization).toBe("Bearer xoxb-abc");
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, channels: [{ id: "C1" }] });
      },
    );
  });

  it("read with an object hits conversations.history for THAT channel, passing params", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { ok: true, messages: [{ ts: "1.0", text: "hi" }] }),
      async (up) => {
        const slack = new SlackConnectorProvider({ token: "xoxb-abc", baseUrl: up.url });
        const res = await slack.invoke({
          operation: "read",
          object: "C0123456789",
          payload: { limit: 5 },
        });
        const u = new URL(up.requests[0]!.url, up.url);
        expect(u.pathname).toBe("/conversations.history");
        expect(u.searchParams.get("channel")).toBe("C0123456789");
        expect(u.searchParams.get("limit")).toBe("5");
        expect(res.body).toMatchObject({ ok: true });
      },
    );
  });

  it("read op users.lookupByEmail sends the email as a query param", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { ok: true, user: { id: "U9", name: "jane" } }),
      async (up) => {
        const slack = new SlackConnectorProvider({ token: "xoxb-abc", baseUrl: up.url });
        const res = await slack.invoke({
          operation: "read",
          payload: { op: "users.lookupByEmail", email: "jane@corp.com" },
        });
        const u = new URL(up.requests[0]!.url, up.url);
        expect(u.pathname).toBe("/users.lookupByEmail");
        expect(u.searchParams.get("email")).toBe("jane@corp.com");
        expect(res.body).toMatchObject({ user: { id: "U9" } });
      },
    );
  });

  it("write POSTs chat.postMessage with the channel taken from the governed object — a payload channel cannot override it", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { ok: true, ts: "12.34", channel: "C_OK" }),
      async (up) => {
        const slack = new SlackConnectorProvider({ token: "xoxb-abc", baseUrl: up.url });
        const res = await slack.invoke({
          operation: "write",
          object: "C_OK",
          payload: { text: "deployed", channel: "C_EVIL" },
        });
        const sent = up.requests[0]!;
        expect(sent.method).toBe("POST");
        expect(sent.url).toBe("/chat.postMessage");
        expect(sent.headers["content-type"]).toContain("application/json");
        const body = JSON.parse(sent.body);
        expect(body.channel).toBe("C_OK"); // object wins, always
        expect(body.text).toBe("deployed");
        expect(res.body).toMatchObject({ ok: true, ts: "12.34" });
      },
    );
  });

  it("chat.update is internal-only: invoke() refuses it with no upstream call; updateOwnMessage rewrites one message (ADR-0173 2b)", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { ok: true, ts: "12.34", channel: "C_OK" }),
      async (up) => {
        const slack = new SlackConnectorProvider({ token: "xoxb-abc", baseUrl: up.url });
        // the governed surface: a write grant (or an agent) cannot rewrite a message
        const viaInvoke = (await slack
          .invoke({ operation: "write", object: "C_OK", payload: { op: "chat.update", ts: "12.34", text: "Approved" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(viaInvoke).toBeInstanceOf(ConnectorProviderError);
        expect(viaInvoke.status).toBe(400);
        expect(viaInvoke.message).toContain("internal-only");
        const other = (await slack
          .invoke({ operation: "write", object: "C_OK", payload: { op: "chat.delete", ts: "1" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(other.status).toBe(400);
        expect(up.requests.length).toBe(0);
        // the courier's own method
        await slack.updateOwnMessage({ channel: "C_OK", ts: "12.34", text: "answered" });
        const sent = up.requests[0]!;
        expect(sent.url).toBe("/chat.update");
        expect(JSON.parse(sent.body)).toEqual({ channel: "C_OK", ts: "12.34", text: "answered" });
        const noTs = (await slack.updateOwnMessage({ channel: "C_OK", ts: "", text: "x" }).catch((e: unknown) => e)) as ConnectorProviderError;
        expect(noTs.status).toBe(400);
        expect(up.requests.length).toBe(1);
      },
    );
  });

  it("write without an object fails locally (channel required) — no upstream call", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { ok: true }),
      async (up) => {
        const slack = new SlackConnectorProvider({ token: "xoxb-abc", baseUrl: up.url });
        const err = (await slack
          .invoke({ operation: "write", payload: { text: "x" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err).toBeInstanceOf(ConnectorProviderError);
        expect(err.status).toBe(400);
        expect(err.message).toContain("channel");
        expect(up.requests.length).toBe(0);
      },
    );
  });

  it("ok:false invalid_auth maps to a typed 401 (auth failure, not a generic error)", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { ok: false, error: "invalid_auth" }),
      async (up) => {
        const slack = new SlackConnectorProvider({ token: "xoxb-bad", baseUrl: up.url });
        const err = (await slack.invoke({ operation: "read" }).catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err).toBeInstanceOf(ConnectorProviderError);
        expect(err.status).toBe(401);
        expect(err.message).toContain("invalid_auth");
      },
    );
  });

  it("ok:false channel_not_found maps to 404 — how a scope-denied/hidden channel surfaces from Slack", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { ok: false, error: "channel_not_found" }),
      async (up) => {
        const slack = new SlackConnectorProvider({ token: "xoxb-abc", baseUrl: up.url });
        const err = (await slack
          .invoke({ operation: "read", object: "C_HIDDEN" })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(404);
        expect(err.message).toContain("channel_not_found");
      },
    );
  });

  it("ok:false missing_scope maps to 403", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { ok: false, error: "missing_scope" }),
      async (up) => {
        const slack = new SlackConnectorProvider({ token: "xoxb-abc", baseUrl: up.url });
        const err = (await slack
          .invoke({ operation: "write", object: "C1", payload: { text: "x" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(403);
        expect(err.message).toContain("missing_scope");
      },
    );
  });

  it("HTTP 429 + Retry-After surfaces as ConnectorRateLimitError with the wait, not a generic failure", async () => {
    await withUpstream(
      (_req, res) => reply(res, 429, { ok: false, error: "ratelimited" }, { "retry-after": "30" }),
      async (up) => {
        const slack = new SlackConnectorProvider({ token: "xoxb-abc", baseUrl: up.url });
        const err = (await slack
          .invoke({ operation: "write", object: "C1", payload: { text: "x" } })
          .catch((e: unknown) => e)) as ConnectorRateLimitError;
        expect(err).toBeInstanceOf(ConnectorRateLimitError);
        expect(err.status).toBe(429); // canonical
        expect(err.retryAfterSeconds).toBe(30);
        expect(err.upstreamStatus).toBe(429);
      },
    );
  });

  it("ok:false ratelimited inside an HTTP 200 is STILL the typed rate-limit error", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { ok: false, error: "ratelimited" }, { "retry-after": "7" }),
      async (up) => {
        const slack = new SlackConnectorProvider({ token: "xoxb-abc", baseUrl: up.url });
        const err = (await slack.invoke({ operation: "read" }).catch((e: unknown) => e)) as ConnectorRateLimitError;
        expect(err).toBeInstanceOf(ConnectorRateLimitError);
        expect(err.status).toBe(429);
        expect(err.retryAfterSeconds).toBe(7);
        expect(err.upstreamStatus).toBe(200);
      },
    );
  });

  it("an unknown read op fails locally, listing the supported surface", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { ok: true }),
      async (up) => {
        const slack = new SlackConnectorProvider({ token: "xoxb-abc", baseUrl: up.url });
        const err = (await slack
          .invoke({ operation: "read", payload: { op: "files.upload" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(400);
        expect(err.message).toContain("conversations.list");
        expect(up.requests.length).toBe(0);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// GitHub adapter — object = "owner/repo"; 403+rate-limit headers → typed 429;
// baseUrl override = GHE
// ---------------------------------------------------------------------------

describe("github adapter (fake upstream)", () => {
  it("bare read (object=null) lists the token's repos with GitHub headers", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, [{ full_name: "acme/billing" }]),
      async (up) => {
        const gh = new GitHubConnectorProvider({ token: "ghp_abc", baseUrl: up.url });
        const res = await gh.invoke({ operation: "read" });
        const sent = up.requests[0]!;
        expect(sent.method).toBe("GET");
        expect(sent.url).toBe("/user/repos");
        expect(sent.headers.authorization).toBe("Bearer ghp_abc");
        expect(sent.headers.accept).toBe("application/vnd.github+json");
        expect(sent.headers["x-github-api-version"]).toBe("2022-11-28");
        expect(res.body).toEqual([{ full_name: "acme/billing" }]);
      },
    );
  });

  it("read with an object fetches that repo", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { full_name: "acme/billing", private: true }),
      async (up) => {
        const gh = new GitHubConnectorProvider({ token: "ghp_abc", baseUrl: up.url });
        const res = await gh.invoke({ operation: "read", object: "acme/billing" });
        expect(up.requests[0]!.url).toBe("/repos/acme/billing");
        expect(res.body).toMatchObject({ full_name: "acme/billing" });
      },
    );
  });

  it("read op issues.list scopes to the object repo and passes list params", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, [{ number: 1, title: "bug" }]),
      async (up) => {
        const gh = new GitHubConnectorProvider({ token: "ghp_abc", baseUrl: up.url });
        await gh.invoke({
          operation: "read",
          object: "acme/billing",
          payload: { op: "issues.list", state: "open", per_page: 10 },
        });
        const u = new URL(up.requests[0]!.url, up.url);
        expect(u.pathname).toBe("/repos/acme/billing/issues");
        expect(u.searchParams.get("state")).toBe("open");
        expect(u.searchParams.get("per_page")).toBe("10");
      },
    );
  });

  it("read ops issues.get and pulls.list address the numbered/PR endpoints", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { ok: true }),
      async (up) => {
        const gh = new GitHubConnectorProvider({ token: "ghp_abc", baseUrl: up.url });
        await gh.invoke({ operation: "read", object: "acme/billing", payload: { op: "issues.get", number: 42 } });
        await gh.invoke({ operation: "read", object: "acme/billing", payload: { op: "pulls.list" } });
        expect(up.requests[0]!.url).toBe("/repos/acme/billing/issues/42");
        expect(up.requests[1]!.url).toBe("/repos/acme/billing/pulls");
      },
    );
  });

  it("write defaults to issues.create: POST /repos/{object}/issues with title/body", async () => {
    await withUpstream(
      (_req, res) => reply(res, 201, { number: 7, title: "Broken invoice" }),
      async (up) => {
        const gh = new GitHubConnectorProvider({ token: "ghp_abc", baseUrl: up.url });
        const res = await gh.invoke({
          operation: "write",
          object: "acme/billing",
          payload: { title: "Broken invoice", body: "steps…", labels: ["bug"] },
        });
        const sent = up.requests[0]!;
        expect(sent.method).toBe("POST");
        expect(sent.url).toBe("/repos/acme/billing/issues");
        expect(JSON.parse(sent.body)).toEqual({ title: "Broken invoice", body: "steps…", labels: ["bug"] });
        expect(res).toEqual({ status: 201, body: { number: 7, title: "Broken invoice" } });
      },
    );
  });

  it("write op issues.comment POSTs to the issue's comments", async () => {
    await withUpstream(
      (_req, res) => reply(res, 201, { id: 900 }),
      async (up) => {
        const gh = new GitHubConnectorProvider({ token: "ghp_abc", baseUrl: up.url });
        await gh.invoke({
          operation: "write",
          object: "acme/billing",
          payload: { op: "issues.comment", number: 7, body: "on it" },
        });
        expect(up.requests[0]!.url).toBe("/repos/acme/billing/issues/7/comments");
        expect(JSON.parse(up.requests[0]!.body)).toEqual({ body: "on it" });
      },
    );
  });

  it("401 surfaces GitHub's own message as a typed auth failure", async () => {
    await withUpstream(
      (_req, res) => reply(res, 401, { message: "Bad credentials" }),
      async (up) => {
        const gh = new GitHubConnectorProvider({ token: "ghp_bad", baseUrl: up.url });
        const err = (await gh.invoke({ operation: "read" }).catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err).toBeInstanceOf(ConnectorProviderError);
        expect(err.status).toBe(401);
        expect(err.message).toContain("Bad credentials");
      },
    );
  });

  it("403 with x-ratelimit-remaining: 0 is the typed rate-limit error, not a generic 403", async () => {
    await withUpstream(
      (_req, res) =>
        reply(res, 403, { message: "API rate limit exceeded" }, {
          "x-ratelimit-remaining": "0",
          "retry-after": "120",
        }),
      async (up) => {
        const gh = new GitHubConnectorProvider({ token: "ghp_abc", baseUrl: up.url });
        const err = (await gh
          .invoke({ operation: "read", object: "acme/billing" })
          .catch((e: unknown) => e)) as ConnectorRateLimitError;
        expect(err).toBeInstanceOf(ConnectorRateLimitError);
        expect(err.status).toBe(429); // canonical, even though GitHub said 403
        expect(err.upstreamStatus).toBe(403);
        expect(err.retryAfterSeconds).toBe(120);
      },
    );
  });

  it("a plain 403 (permissions, remaining > 0) stays a normal typed failure", async () => {
    await withUpstream(
      (_req, res) =>
        reply(res, 403, { message: "Resource not accessible by integration" }, {
          "x-ratelimit-remaining": "55",
        }),
      async (up) => {
        const gh = new GitHubConnectorProvider({ token: "ghp_abc", baseUrl: up.url });
        const err = (await gh
          .invoke({ operation: "write", object: "acme/billing", payload: { title: "x" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err).toBeInstanceOf(ConnectorProviderError);
        expect(err).not.toBeInstanceOf(ConnectorRateLimitError);
        expect(err.status).toBe(403);
        expect(err.message).toContain("Resource not accessible");
      },
    );
  });

  it("404 on a repo the token cannot see (GitHub hides existence) surfaces as a typed 404", async () => {
    await withUpstream(
      (_req, res) => reply(res, 404, { message: "Not Found" }),
      async (up) => {
        const gh = new GitHubConnectorProvider({ token: "ghp_abc", baseUrl: up.url });
        const err = (await gh
          .invoke({ operation: "read", object: "acme/secret-repo" })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(404);
        expect(err.message).toContain("Not Found");
      },
    );
  });

  it("GHE baseUrl override: paths append under the …/api/v3 root", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { full_name: "acme/billing" }),
      async (up) => {
        const gh = new GitHubConnectorProvider({ token: "ghp_abc", baseUrl: `${up.url}/api/v3` });
        await gh.invoke({ operation: "read", object: "acme/billing" });
        expect(up.requests[0]!.url).toBe("/api/v3/repos/acme/billing");
      },
    );
  });

  it("a malformed object (not owner/repo) fails locally — no upstream call", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, {}),
      async (up) => {
        const gh = new GitHubConnectorProvider({ token: "ghp_abc", baseUrl: up.url });
        const err = (await gh
          .invoke({ operation: "write", object: "just-a-name", payload: { title: "x" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(400);
        expect(err.message).toContain("owner/repo");
        expect(up.requests.length).toBe(0);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Jira adapter — object = project key; Basic "email:api_token"; error
// collection → actionable message; baseUrl is inherently the site override
// ---------------------------------------------------------------------------

describe("jira adapter (fake upstream)", () => {
  const TOKEN = "jane@corp.com:ATATT-secret";
  const BASIC = `Basic ${Buffer.from(TOKEN).toString("base64")}`;

  it("bare read (object=null) lists projects with the Basic email:api_token credential", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, [{ key: "PLAT" }, { key: "OPS" }]),
      async (up) => {
        const jira = new JiraConnectorProvider({ baseUrl: up.url, token: TOKEN });
        const res = await jira.invoke({ operation: "read" });
        expect(up.requests[0]!.method).toBe("GET");
        expect(up.requests[0]!.url).toBe("/rest/api/2/project");
        expect(up.requests[0]!.headers.authorization).toBe(BASIC);
        expect(res.body).toEqual([{ key: "PLAT" }, { key: "OPS" }]);
      },
    );
  });

  it("read with an object searches JQL forced to that project", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { issues: [{ key: "PLAT-1" }], total: 1 }),
      async (up) => {
        const jira = new JiraConnectorProvider({ baseUrl: up.url, token: TOKEN });
        const res = await jira.invoke({ operation: "read", object: "PLAT", payload: { maxResults: 25 } });
        const u = new URL(up.requests[0]!.url, up.url);
        expect(u.pathname).toBe("/rest/api/2/search");
        expect(u.searchParams.get("jql")).toBe('project = "PLAT"');
        expect(u.searchParams.get("maxResults")).toBe("25");
        expect(res.body).toMatchObject({ total: 1 });
      },
    );
  });

  it("caller JQL narrows WITHIN the project scope (parenthesized AND), never replaces it", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { issues: [] }),
      async (up) => {
        const jira = new JiraConnectorProvider({ baseUrl: up.url, token: TOKEN });
        await jira.invoke({
          operation: "read",
          object: "PLAT",
          payload: { jql: "status = Done ORDER BY created" },
        });
        const u = new URL(up.requests[0]!.url, up.url);
        expect(u.searchParams.get("jql")).toBe('project = "PLAT" AND (status = Done ORDER BY created)');
      },
    );
  });

  it("read op issue.get fetches the issue by key", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { key: "PLAT-42", fields: { summary: "s" } }),
      async (up) => {
        const jira = new JiraConnectorProvider({ baseUrl: up.url, token: TOKEN });
        const res = await jira.invoke({
          operation: "read",
          object: "PLAT",
          payload: { op: "issue.get", key: "PLAT-42" },
        });
        expect(up.requests[0]!.url).toBe("/rest/api/2/issue/PLAT-42");
        expect(res.body).toMatchObject({ key: "PLAT-42" });
      },
    );
  });

  it("issue.get for ANOTHER project's key under a scoped object is refused locally — no upstream call", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, {}),
      async (up) => {
        const jira = new JiraConnectorProvider({ baseUrl: up.url, token: TOKEN });
        const err = (await jira
          .invoke({ operation: "read", object: "PLAT", payload: { op: "issue.get", key: "OPS-9" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err).toBeInstanceOf(ConnectorProviderError);
        expect(err.status).toBe(403);
        expect(err.message).toContain("outside the authorized project");
        expect(up.requests.length).toBe(0);
      },
    );
  });

  it("write defaults to issue.create with fields.project.key forced from the object", async () => {
    await withUpstream(
      (_req, res) => reply(res, 201, { key: "PLAT-43" }),
      async (up) => {
        const jira = new JiraConnectorProvider({ baseUrl: up.url, token: TOKEN });
        const res = await jira.invoke({
          operation: "write",
          object: "PLAT",
          payload: { summary: "Fix the audit gap", description: "details" },
        });
        const sent = up.requests[0]!;
        expect(sent.method).toBe("POST");
        expect(sent.url).toBe("/rest/api/2/issue");
        expect(JSON.parse(sent.body)).toEqual({
          fields: {
            project: { key: "PLAT" },
            summary: "Fix the audit gap",
            issuetype: { name: "Task" },
            description: "details",
          },
        });
        expect(res).toEqual({ status: 201, body: { key: "PLAT-43" } });
      },
    );
  });

  it("write op issue.comment POSTs to the issue's comment endpoint (key prefix-checked)", async () => {
    await withUpstream(
      (_req, res) => reply(res, 201, { id: "5001" }),
      async (up) => {
        const jira = new JiraConnectorProvider({ baseUrl: up.url, token: TOKEN });
        await jira.invoke({
          operation: "write",
          object: "PLAT",
          payload: { op: "issue.comment", key: "PLAT-42", body: "done" },
        });
        expect(up.requests[0]!.url).toBe("/rest/api/2/issue/PLAT-42/comment");
        expect(JSON.parse(up.requests[0]!.body)).toEqual({ body: "done" });
      },
    );
  });

  it("401 surfaces as a typed auth failure", async () => {
    await withUpstream(
      (_req, res) => reply(res, 401, { errorMessages: ["Authentication failed"], errors: {} }),
      async (up) => {
        const jira = new JiraConnectorProvider({ baseUrl: up.url, token: "jane@corp.com:wrong" });
        const err = (await jira.invoke({ operation: "read" }).catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(401);
        expect(err.message).toContain("Authentication failed");
      },
    );
  });

  it("Jira's error-collection body flattens into one actionable message", async () => {
    await withUpstream(
      (_req, res) =>
        reply(res, 400, {
          errorMessages: ["Field 'priority' cannot be set."],
          errors: { summary: "You must specify a summary of the issue." },
        }),
      async (up) => {
        const jira = new JiraConnectorProvider({ baseUrl: up.url, token: TOKEN });
        const err = (await jira
          .invoke({ operation: "write", object: "PLAT", payload: { summary: "x" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(400);
        expect(err.message).toContain("Field 'priority' cannot be set.");
        expect(err.message).toContain("summary: You must specify a summary of the issue.");
      },
    );
  });

  it("429 + Retry-After surfaces as the typed rate-limit error", async () => {
    await withUpstream(
      (_req, res) => reply(res, 429, { errorMessages: ["Rate limit exceeded"] }, { "retry-after": "13" }),
      async (up) => {
        const jira = new JiraConnectorProvider({ baseUrl: up.url, token: TOKEN });
        const err = (await jira
          .invoke({ operation: "read", object: "PLAT" })
          .catch((e: unknown) => e)) as ConnectorRateLimitError;
        expect(err).toBeInstanceOf(ConnectorRateLimitError);
        expect(err.status).toBe(429);
        expect(err.retryAfterSeconds).toBe(13);
      },
    );
  });

  it("a token without ':' is rejected at construction with the expected-format message", () => {
    const err = (() => {
      try {
        new JiraConnectorProvider({ baseUrl: "https://x.atlassian.net", token: "just-an-api-token" });
        return null;
      } catch (e) {
        return e as ConnectorProviderError;
      }
    })();
    expect(err).toBeInstanceOf(ConnectorProviderError);
    expect(err!.message).toContain("email:api_token");
  });

  it("write without an object (project key) fails locally", async () => {
    await withUpstream(
      (_req, res) => reply(res, 201, {}),
      async (up) => {
        const jira = new JiraConnectorProvider({ baseUrl: up.url, token: TOKEN });
        const err = (await jira
          .invoke({ operation: "write", payload: { summary: "x" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(400);
        expect(err.message).toContain("project key");
        expect(up.requests.length).toBe(0);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Snowflake adapter — object = "DATABASE.SCHEMA"; key-pair JWT; SQL API v2
// (ADR-0023). ≥10 fake-upstream tests per the wave convention.
// ---------------------------------------------------------------------------

describe("snowflake adapter (fake upstream)", () => {
  const CRED = { account: "acme-x1", user: "svc_regulait", privateKey: PRIVATE_KEY_PEM };

  it("read submits POST /api/v2/statements with database/schema taken from the governed object", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { data: [["1"]], resultSetMetaData: { numRows: 1 } }),
      async (up) => {
        const sf = new SnowflakeConnectorProvider({ credential: CRED, baseUrl: up.url });
        const res = await sf.invoke({
          operation: "read",
          object: "ANALYTICS.PUBLIC",
          payload: { statement: "SELECT count(*) FROM orders" },
        });
        const req = up.requests[0]!;
        expect(req.method).toBe("POST");
        expect(req.url).toBe("/api/v2/statements");
        const body = JSON.parse(req.body);
        expect(body).toMatchObject({
          statement: "SELECT count(*) FROM orders",
          database: "ANALYTICS",
          schema: "PUBLIC",
        });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ data: [["1"]] });
      },
    );
  });

  it("sends the key-pair JWT headers, and the JWT carries Snowflake's fingerprint claims + a valid RS256 signature", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { data: [] }),
      async (up) => {
        const sf = new SnowflakeConnectorProvider({ credential: CRED, baseUrl: up.url });
        await sf.invoke({
          operation: "read",
          object: "ANALYTICS.PUBLIC",
          payload: { statement: "SELECT 1" },
        });
        const req = up.requests[0]!;
        expect(req.headers["x-snowflake-authorization-token-type"]).toBe("KEYPAIR_JWT");
        const auth = String(req.headers.authorization);
        expect(auth.startsWith("Bearer ")).toBe(true);
        const [h, p, sig] = auth.slice("Bearer ".length).split(".");
        expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({
          alg: "RS256",
          typ: "JWT",
        });
        const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
        // Snowflake's convention: sub = UPPER(account).UPPER(user); iss adds
        // the SHA256 public-key fingerprint
        expect(claims.sub).toBe("ACME-X1.SVC_REGULAIT");
        expect(String(claims.iss).startsWith("ACME-X1.SVC_REGULAIT.SHA256:")).toBe(true);
        expect(claims.exp - claims.iat).toBe(300);
        // the signature verifies against the real public key
        const verified = createVerify("RSA-SHA256")
          .update(`${h}.${p}`)
          .verify(PUBLIC_KEY_PEM, Buffer.from(sig!, "base64url"));
        expect(verified).toBe(true);
      },
    );
  });

  it("a passphrase-encrypted private key signs an equally valid JWT", () => {
    const jwt = buildSnowflakeJwt(
      {
        account: "acme-x1",
        user: "svc",
        privateKey: ENCRYPTED_PRIVATE_KEY_PEM,
        passphrase: "open-sesame",
      },
      1_784_976_000_000,
    );
    const [h, p, sig] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(claims.iat).toBe(1_784_976_000);
    expect(
      createVerify("RSA-SHA256").update(`${h}.${p}`).verify(PUBLIC_KEY_PEM, Buffer.from(sig!, "base64url")),
    ).toBe(true);
    // wrong/missing passphrase fails actionable, not opaque
    const err = (() => {
      try {
        buildSnowflakeJwt({ account: "a", user: "u", privateKey: ENCRYPTED_PRIVATE_KEY_PEM });
        return null;
      } catch (e) {
        return e as ConnectorProviderError;
      }
    })();
    expect(err).toBeInstanceOf(ConnectorProviderError);
    expect(err!.status).toBe(400);
    expect(err!.message).toContain("passphrase");
  });

  it("bare read (object=null) is the connection-root read: SHOW DATABASES, no database/schema fields", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { data: [["ANALYTICS"], ["RAW"]] }),
      async (up) => {
        const sf = new SnowflakeConnectorProvider({ credential: CRED, baseUrl: up.url });
        const res = await sf.invoke({ operation: "read" });
        const body = JSON.parse(up.requests[0]!.body);
        expect(body).toEqual({ statement: "SHOW DATABASES" });
        expect(res.body).toMatchObject({ data: [["ANALYTICS"], ["RAW"]] });
      },
    );
  });

  it("write submits a mutating statement (INSERT) under the object's database/schema, forwarding warehouse", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, { statementHandle: "01b2-…", message: "Statement executed successfully." }),
      async (up) => {
        const sf = new SnowflakeConnectorProvider({ credential: CRED, baseUrl: up.url });
        const res = await sf.invoke({
          operation: "write",
          object: "ANALYTICS.PUBLIC",
          payload: {
            statement: "INSERT INTO audit_notes (note) VALUES ('governed')",
            warehouse: "WH_SMALL",
          },
        });
        const body = JSON.parse(up.requests[0]!.body);
        expect(body).toMatchObject({
          statement: "INSERT INTO audit_notes (note) VALUES ('governed')",
          database: "ANALYTICS",
          schema: "PUBLIC",
          warehouse: "WH_SMALL",
        });
        expect(res.status).toBe(200);
      },
    );
  });

  it("op/verb mismatch hard-fails BEFORE any network call: a mutating statement on operation:'read'", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, {}),
      async (up) => {
        const sf = new SnowflakeConnectorProvider({ credential: CRED, baseUrl: up.url });
        const err = (await sf
          .invoke({
            operation: "read",
            object: "ANALYTICS.PUBLIC",
            payload: { statement: "DELETE FROM orders" },
          })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err).toBeInstanceOf(ConnectorProviderError);
        expect(err.status).toBe(400);
        expect(err.message).toContain("SELECT/WITH/SHOW/DESCRIBE");
        expect(up.requests.length).toBe(0);
      },
    );
  });

  it("op/verb mismatch hard-fails the other way too: a SELECT on operation:'write'", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, {}),
      async (up) => {
        const sf = new SnowflakeConnectorProvider({ credential: CRED, baseUrl: up.url });
        const err = (await sf
          .invoke({
            operation: "write",
            object: "ANALYTICS.PUBLIC",
            payload: { statement: "SELECT * FROM orders" },
          })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(400);
        expect(err.message).toContain("INSERT/UPDATE");
        expect(up.requests.length).toBe(0);
      },
    );
  });

  it("multi-statement submissions are rejected locally (defense-in-depth, not a SQL parser)", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, {}),
      async (up) => {
        const sf = new SnowflakeConnectorProvider({ credential: CRED, baseUrl: up.url });
        const err = (await sf
          .invoke({
            operation: "read",
            object: "ANALYTICS.PUBLIC",
            payload: { statement: "SELECT 1; DELETE FROM orders" },
          })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(400);
        expect(err.message).toContain("multi-statement");
        expect(up.requests.length).toBe(0);
        // a single trailing semicolon is fine (stripped, not rejected)
        await sf.invoke({
          operation: "read",
          object: "ANALYTICS.PUBLIC",
          payload: { statement: "SELECT 1;" },
        });
        expect(JSON.parse(up.requests[0]!.body).statement).toBe("SELECT 1");
      },
    );
  });

  it("the object must be a DATABASE.SCHEMA pair — anything else fails locally", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, {}),
      async (up) => {
        const sf = new SnowflakeConnectorProvider({ credential: CRED, baseUrl: up.url });
        for (const object of ["ANALYTICS", "a.b.c", "bad name.schema"]) {
          const err = (await sf
            .invoke({ operation: "read", object, payload: { statement: "SELECT 1" } })
            .catch((e: unknown) => e)) as ConnectorProviderError;
          expect(err.status).toBe(400);
          expect(err.message).toContain('"DATABASE.SCHEMA"');
        }
        // write with NO object is refused too — the object is the governed scope
        const err = (await sf
          .invoke({ operation: "write", payload: { statement: "INSERT INTO t VALUES (1)" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(400);
        expect(up.requests.length).toBe(0);
      },
    );
  });

  it("a read WITH a statement but NO object is refused — caller SQL never runs unscoped", async () => {
    await withUpstream(
      (_req, res) => reply(res, 200, {}),
      async (up) => {
        const sf = new SnowflakeConnectorProvider({ credential: CRED, baseUrl: up.url });
        const err = (await sf
          .invoke({ operation: "read", payload: { statement: "SELECT * FROM secrets" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(400);
        expect(err.message).toContain("requires an object");
        expect(up.requests.length).toBe(0);
      },
    );
  });

  it("HTTP 429 + Retry-After surfaces as the typed rate-limit error", async () => {
    await withUpstream(
      (_req, res) => reply(res, 429, { message: "Too many requests" }, { "retry-after": "7" }),
      async (up) => {
        const sf = new SnowflakeConnectorProvider({ credential: CRED, baseUrl: up.url });
        const err = (await sf
          .invoke({ operation: "read", object: "ANALYTICS.PUBLIC", payload: { statement: "SELECT 1" } })
          .catch((e: unknown) => e)) as ConnectorRateLimitError;
        expect(err).toBeInstanceOf(ConnectorRateLimitError);
        expect(err.status).toBe(429);
        expect(err.retryAfterSeconds).toBe(7);
        expect(err.upstreamStatus).toBe(429);
      },
    );
  });

  it("a non-2xx SQL API error body {message, code} flattens into one actionable line", async () => {
    await withUpstream(
      (_req, res) =>
        reply(res, 422, { message: "SQL compilation error: Object 'ORDERS' does not exist.", code: "002003" }),
      async (up) => {
        const sf = new SnowflakeConnectorProvider({ credential: CRED, baseUrl: up.url });
        const err = (await sf
          .invoke({ operation: "read", object: "ANALYTICS.PUBLIC", payload: { statement: "SELECT * FROM orders" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(422);
        expect(err.message).toContain("SQL compilation error");
        expect(err.message).toContain("code 002003");
      },
    );
  });

  it("parseSnowflakeCredential: valid JSON parses; non-JSON / wrong-shape / extra fields fail actionable", () => {
    expect(parseSnowflakeCredential(JSON.stringify(CRED))).toEqual(CRED);
    for (const [token, fragment] of [
      ["not json", "non-JSON token"],
      [JSON.stringify({ account: "a", user: "u" }), "privateKey"],
      [JSON.stringify({ ...CRED, extra: "field" }), "extra"],
      [JSON.stringify({ account: "", user: "u", privateKey: "k" }), "account"],
    ] as const) {
      const err = (() => {
        try {
          parseSnowflakeCredential(token);
          return null;
        } catch (e) {
          return e as ConnectorProviderError;
        }
      })();
      expect(err).toBeInstanceOf(ConnectorProviderError);
      expect(err!.status).toBe(400);
      expect(err!.message).toContain(fragment);
    }
  });

  it("default base URL is https://<account>.snowflakecomputing.com (lowercased); baseUrl overrides", () => {
    const sf = new SnowflakeConnectorProvider({
      credential: { account: "Acme-X1", user: "u", privateKey: PRIVATE_KEY_PEM },
    });
    expect((sf as unknown as { base: string }).base).toBe("https://acme-x1.snowflakecomputing.com");
    const overridden = new SnowflakeConnectorProvider({ credential: CRED, baseUrl: "http://127.0.0.1:9/" });
    expect((overridden as unknown as { base: string }).base).toBe("http://127.0.0.1:9");
  });
});

// ---------------------------------------------------------------------------
// ADR-0113 — Microsoft Teams adapter (Bot Framework Connector REST API)
//
// The fake upstream plays BOTH roles a Teams post needs: the Microsoft Entra
// login service (`/{tenant}/oauth2/v2.0/token`) and the Bot Connector service
// (`/v3/conversations/…`). That is the point — Teams is the first adapter here
// that touches two hosts, and these tests assert both requests go out, in
// order, with the right method/path/headers/body.
// ---------------------------------------------------------------------------

const TEAMS_CRED = JSON.stringify({ appId: "app-1111", appPassword: "pw-2222" });
const CONV = "19:abc123@thread.tacv2";

/** the two-role handler: token first, then the connector call */
function teamsUpstream(connectorReply: (req: CapturedRequest, res: ServerResponse) => void) {
  return (req: CapturedRequest, res: ServerResponse) => {
    if (req.url.includes("/oauth2/v2.0/token")) {
      reply(res, 200, { token_type: "Bearer", expires_in: 3600, access_token: "minted-jwt" });
      return;
    }
    connectorReply(req, res);
  };
}

describe("teams adapter (fake upstream: login service + Bot Connector)", () => {
  it("mints an app-only token, THEN sends the Activity to the governed conversation", async () => {
    await withUpstream(
      teamsUpstream((_req, res) => reply(res, 201, { id: "1785000000123" })),
      async (up) => {
        const teams = new TeamsConnectorProvider({
          credential: parseTeamsCredential(JSON.stringify({ appId: "app-1111", appPassword: "pw-2222", loginBaseUrl: up.url })),
          baseUrl: up.url,
        });
        const res = await teams.invoke({
          operation: "write",
          object: CONV,
          payload: { text: "deploy approved", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { type: "AdaptiveCard" } }] },
        });

        // TWO requests, in order — the token exchange is not optional
        expect(up.requests).toHaveLength(2);

        const tok = up.requests[0]!;
        expect(tok.method).toBe("POST");
        // multi-tenant default: the documented `botframework.com` segment
        expect(tok.url).toBe("/botframework.com/oauth2/v2.0/token");
        expect(String(tok.headers["content-type"])).toContain("application/x-www-form-urlencoded");
        const form = new URLSearchParams(tok.body);
        expect(form.get("grant_type")).toBe("client_credentials");
        expect(form.get("client_id")).toBe("app-1111");
        expect(form.get("client_secret")).toBe("pw-2222");
        expect(form.get("scope")).toBe("https://api.botframework.com/.default");

        const post = up.requests[1]!;
        expect(post.method).toBe("POST");
        expect(post.url).toBe(`/v3/conversations/${encodeURIComponent(CONV)}/activities`);
        // the MINTED token, not the app password
        expect(post.headers.authorization).toBe("Bearer minted-jwt");
        expect(String(post.headers.authorization)).not.toContain("pw-2222");
        const activity = JSON.parse(post.body) as Record<string, unknown>;
        expect(activity.type).toBe("message");
        expect(activity.text).toBe("deploy approved");
        expect(activity.conversation).toEqual({ id: CONV });

        // the ResourceResponse id is what comes back
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ id: "1785000000123" });
      },
    );
  });

  it("a single-tenant credential uses the DIRECTORY tenant segment, not botframework.com", async () => {
    await withUpstream(
      teamsUpstream((_req, res) => reply(res, 201, { id: "x" })),
      async (up) => {
        const teams = new TeamsConnectorProvider({
          credential: parseTeamsCredential(
            JSON.stringify({ appId: "a", appPassword: "b", tenantId: "contoso-tenant-id", loginBaseUrl: up.url }),
          ),
          baseUrl: up.url,
        });
        await teams.invoke({ operation: "write", object: CONV, payload: { text: "hi" } });
        expect(up.requests[0]!.url).toBe("/contoso-tenant-id/oauth2/v2.0/token");
      },
    );
  });

  it("the conversation comes from the GOVERNED OBJECT — a payload conversation cannot redirect it", async () => {
    await withUpstream(
      teamsUpstream((_req, res) => reply(res, 201, { id: "x" })),
      async (up) => {
        const teams = new TeamsConnectorProvider({
          credential: parseTeamsCredential(JSON.stringify({ appId: "a", appPassword: "b", loginBaseUrl: up.url })),
          baseUrl: up.url,
        });
        await teams.invoke({
          operation: "write",
          object: CONV,
          payload: { text: "hi", conversation: { id: "19:EVIL@thread.tacv2" } },
        });
        const post = up.requests[1]!;
        expect(post.url).toBe(`/v3/conversations/${encodeURIComponent(CONV)}/activities`);
        expect(post.url).not.toContain("EVIL");
        expect((JSON.parse(post.body) as Record<string, unknown>).conversation).toEqual({ id: CONV });
      },
    );
  });

  it("replyToActivity posts to the reply endpoint for that activity", async () => {
    await withUpstream(
      teamsUpstream((_req, res) => reply(res, 200, { id: "y" })),
      async (up) => {
        const teams = new TeamsConnectorProvider({
          credential: parseTeamsCredential(JSON.stringify({ appId: "a", appPassword: "b", loginBaseUrl: up.url })),
          baseUrl: up.url,
        });
        await teams.invoke({
          operation: "write",
          object: CONV,
          payload: { op: "conversations.replyToActivity", replyToId: "act-77", text: "retired" },
        });
        expect(up.requests[1]!.url).toBe(`/v3/conversations/${encodeURIComponent(CONV)}/activities/act-77`);
      },
    );
  });

  it("read with an object GETs the conversation members", async () => {
    await withUpstream(
      teamsUpstream((_req, res) => reply(res, 200, [{ id: "29:u1", name: "Dana" }])),
      async (up) => {
        const teams = new TeamsConnectorProvider({
          credential: parseTeamsCredential(JSON.stringify({ appId: "a", appPassword: "b", loginBaseUrl: up.url })),
          baseUrl: up.url,
        });
        const res = await teams.invoke({ operation: "read", object: CONV });
        expect(up.requests[1]!.method).toBe("GET");
        expect(up.requests[1]!.url).toBe(`/v3/conversations/${encodeURIComponent(CONV)}/members`);
        expect(res.body).toMatchObject([{ id: "29:u1" }]);
      },
    );
  });

  it("the BARE read is REFUSED rather than guessed — Teams has no get-conversations endpoint", async () => {
    await withUpstream(
      teamsUpstream((_req, res) => reply(res, 200, {})),
      async (up) => {
        const teams = new TeamsConnectorProvider({
          credential: parseTeamsCredential(JSON.stringify({ appId: "a", appPassword: "b", loginBaseUrl: up.url })),
          baseUrl: up.url,
        });
        const err = (await teams.invoke({ operation: "read" }).catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err).toBeInstanceOf(ConnectorProviderError);
        expect(err.status).toBe(400);
        expect(err.message).toMatch(/Direct Line and Web Chat/);
        // M-033: pair the negative with a positive — the SAME adapter against
        // the SAME upstream DOES reach it when given an object, so "no request"
        // is about the refusal and not about a dead harness
        expect(up.requests).toHaveLength(0);
        await teams.invoke({ operation: "read", object: CONV });
        expect(up.requests.length).toBeGreaterThan(0);
      },
    );
  });

  it("a write with no object is refused before any socket is opened", async () => {
    await withUpstream(
      teamsUpstream((_req, res) => reply(res, 201, { id: "x" })),
      async (up) => {
        const teams = new TeamsConnectorProvider({
          credential: parseTeamsCredential(JSON.stringify({ appId: "a", appPassword: "b", loginBaseUrl: up.url })),
          baseUrl: up.url,
        });
        const err = (await teams
          .invoke({ operation: "write", payload: { text: "hi" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(400);
        expect(up.requests).toHaveLength(0);
        // positive pair: the same call WITH an object does open sockets
        await teams.invoke({ operation: "write", object: CONV, payload: { text: "hi" } });
        expect(up.requests).toHaveLength(2);
      },
    );
  });

  it("a FAILED token exchange never opens a socket to the service host", async () => {
    await withUpstream(
      (req, res) => {
        if (req.url.includes("/oauth2/v2.0/token")) {
          reply(res, 401, { error: "invalid_client", error_description: "bad secret" });
          return;
        }
        reply(res, 201, { id: "should-never-happen" });
      },
      async (up) => {
        const teams = new TeamsConnectorProvider({
          credential: parseTeamsCredential(JSON.stringify({ appId: "a", appPassword: "wrong", loginBaseUrl: up.url })),
          baseUrl: up.url,
        });
        const err = (await teams
          .invoke({ operation: "write", object: CONV, payload: { text: "hi" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err).toBeInstanceOf(ConnectorProviderError);
        expect(err.status).toBe(401);
        // exactly ONE request — the token attempt. Nothing reached the
        // connector path. (Positive half: the one request IS the token call.)
        expect(up.requests).toHaveLength(1);
        expect(up.requests[0]!.url).toContain("/oauth2/v2.0/token");
      },
    );
  });

  it("an ErrorResponse from the connector surfaces its code and the real HTTP status", async () => {
    await withUpstream(
      teamsUpstream((_req, res) => reply(res, 403, { error: { code: "BotNotInConversationRoster", message: "no" } })),
      async (up) => {
        const teams = new TeamsConnectorProvider({
          credential: parseTeamsCredential(JSON.stringify({ appId: "a", appPassword: "b", loginBaseUrl: up.url })),
          baseUrl: up.url,
        });
        const err = (await teams
          .invoke({ operation: "write", object: CONV, payload: { text: "hi" } })
          .catch((e: unknown) => e)) as ConnectorProviderError;
        expect(err.status).toBe(403);
        expect(err.message).toContain("BotNotInConversationRoster");
      },
    );
  });

  it("HTTP 429 from the connector becomes the typed rate-limit error with Retry-After", async () => {
    await withUpstream(
      teamsUpstream((_req, res) => reply(res, 429, { error: { code: "Throttled" } }, { "retry-after": "17" })),
      async (up) => {
        const teams = new TeamsConnectorProvider({
          credential: parseTeamsCredential(JSON.stringify({ appId: "a", appPassword: "b", loginBaseUrl: up.url })),
          baseUrl: up.url,
        });
        const err = (await teams
          .invoke({ operation: "write", object: CONV, payload: { text: "hi" } })
          .catch((e: unknown) => e)) as ConnectorRateLimitError;
        expect(err).toBeInstanceOf(ConnectorRateLimitError);
        expect(err.status).toBe(429);
        expect(err.retryAfterSeconds).toBe(17);
      },
    );
  });

  it("REFUSES a raw bearer token as the credential — it would work once and then rot", () => {
    expect(() => parseTeamsCredential("eyJhbGciOiJIUzI1Ni.some.jwt")).toThrow(/non-JSON token/);
    expect(() => parseTeamsCredential(JSON.stringify({ appId: "a" }))).toThrow(/appPassword/);
    // positive pair: a well-formed credential parses
    expect(parseTeamsCredential(TEAMS_CRED).appId).toBe("app-1111");
  });

  it("the registry resolves kind=teams and refuses it with no credential", () => {
    expect(resolveConnectorProvider({ kind: "teams", token: TEAMS_CRED }).kind).toBe("teams");
    expect(() => resolveConnectorProvider({ kind: "teams" })).toThrow(/token/);
    expect(isConnectorProviderKind("teams")).toBe(true);
    // teams has a COMPILED destination, so ADR-0062's posture gate can
    // adjudicate it — it is not an exempt `undefined`
    expect(connectorDefaultBaseUrl("teams")).toBe(TEAMS_DEFAULT_BASE_URL);
  });
});

const OUTLOOK_CRED = JSON.stringify({
  appId: "app-3333",
  appPassword: "pw-4444",
  tenantId: "contoso.onmicrosoft.com",
  senderUpn: "regulait-approvals@contoso.com",
});

describe("outlook adapter (fake upstream: Entra login + Microsoft Graph)", () => {
  it("the registry resolves kind=outlook, refuses it with no credential, and NAMES its compiled destination", () => {
    expect(resolveConnectorProvider({ kind: "outlook", token: OUTLOOK_CRED }).kind).toBe("outlook");
    expect(() => resolveConnectorProvider({ kind: "outlook" })).toThrow(/credential/);
    expect(isConnectorProviderKind("outlook")).toBe(true);
    // AER-015: with no baseUrl the adapter reaches Graph, so ADR-0062's strict
    // posture must be able to adjudicate that host — an `undefined` here is
    // "cannot say where it goes", which strict refuses outright
    expect(connectorDefaultBaseUrl("outlook")).toBe(OUTLOOK_DEFAULT_GRAPH_BASE_URL);
  });

  it("mints an app-only token, THEN sends to the governed recipient", async () => {
    await withUpstream(
      teamsUpstream((_req, res) => reply(res, 202, {})),
      async (up) => {
        const outlook = new OutlookConnectorProvider({
          credential: parseOutlookCredential(
            JSON.stringify({ ...JSON.parse(OUTLOOK_CRED), loginBaseUrl: up.url }),
          ),
          baseUrl: up.url,
        });
        const res = await outlook.invoke({
          operation: "write",
          object: "ana@acme.com",
          payload: { subject: "Approval needed", body: { contentType: "HTML", content: "<p>hi</p>" } },
        });
        expect(res.status).toBe(202);

        const token = up.requests.find((r) => r.url.includes("/oauth2/v2.0/token"));
        const send = up.requests.find((r) => r.url.includes("/sendMail"));
        expect(token).toBeTruthy();
        expect(send).toBeTruthy();
        // the token is minted BEFORE the Graph call, so a bad credential never
        // opens a socket to the mail service
        expect(up.requests.indexOf(token!)).toBeLessThan(up.requests.indexOf(send!));
        // app-only client credentials against the named tenant, Graph scope
        expect(token!.body).toContain("grant_type=client_credentials");
        expect(token!.body).toContain(encodeURIComponent("https://graph.microsoft.com/.default"));
        expect(token!.url).toContain(encodeURIComponent("contoso.onmicrosoft.com"));
        // sent FROM the credential's mailbox
        expect(send!.url).toContain(encodeURIComponent("regulait-approvals@contoso.com"));
        expect(send!.headers.authorization).toBe("Bearer minted-jwt");
      },
    );
  });

  it("takes the recipient from the GOVERNED OBJECT — a crafted payload cannot redirect it", async () => {
    await withUpstream(
      teamsUpstream((_req, res) => reply(res, 202, {})),
      async (up) => {
        const outlook = new OutlookConnectorProvider({
          credential: parseOutlookCredential(
            JSON.stringify({ ...JSON.parse(OUTLOOK_CRED), loginBaseUrl: up.url }),
          ),
          baseUrl: up.url,
        });
        await outlook.invoke({
          operation: "write",
          object: "ana@acme.com",
          payload: {
            subject: "Approval needed",
            toRecipients: [{ emailAddress: { address: "attacker@evil.test" } }],
            ccRecipients: [{ emailAddress: { address: "cc@evil.test" } }],
            bccRecipients: [{ emailAddress: { address: "bcc@evil.test" } }],
          },
        });
        const send = up.requests.find((r) => r.url.includes("/sendMail"))!;
        const sent = JSON.parse(send.body) as {
          message: { toRecipients: Array<{ emailAddress: { address: string } }> };
        };
        // the governed object won, and the crafted recipients are GONE rather
        // than merely outranked — a cc would have delivered just as well
        expect(sent.message.toRecipients).toEqual([{ emailAddress: { address: "ana@acme.com" } }]);
        expect(send.body).not.toContain("evil.test");
      },
    );
  });

  it("REFUSES read outright — a mailbox read is not what delivering an approval needs", async () => {
    const outlook = new OutlookConnectorProvider({
      credential: parseOutlookCredential(OUTLOOK_CRED),
    });
    await expect(
      outlook.invoke({ operation: "read", object: "ana@acme.com" }),
    ).rejects.toThrow(/send-only/i);
  });

  it("refuses a write with no recipient, and an unknown op", async () => {
    const outlook = new OutlookConnectorProvider({
      credential: parseOutlookCredential(OUTLOOK_CRED),
    });
    await expect(outlook.invoke({ operation: "write", object: null })).rejects.toThrow(/recipient/i);
    await expect(
      outlook.invoke({ operation: "write", object: "ana@acme.com", payload: { op: "deleteMail" } }),
    ).rejects.toThrow(/sendMail/);
  });

  it("refuses a credential that is not the app registration JSON, and one missing the tenant", () => {
    expect(() => parseOutlookCredential("a-raw-bearer-token")).toThrow(/non-JSON token/);
    // tenantId is required here even though Teams allows a multi-tenant bot:
    // Graph app-only mints for ONE tenant and there is nothing to guess
    expect(() =>
      parseOutlookCredential(
        JSON.stringify({ appId: "a", appPassword: "b", senderUpn: "x@y.com" }),
      ),
    ).toThrow(/tenantId/);
    expect(() =>
      parseOutlookCredential(JSON.stringify({ appId: "a", appPassword: "b", tenantId: "t" })),
    ).toThrow(/senderUpn/);
  });

  it("reports Graph's empty 202 honestly — accepted for delivery is not delivered", async () => {
    await withUpstream(
      teamsUpstream((_req, res) => reply(res, 202, {})),
      async (up) => {
        const outlook = new OutlookConnectorProvider({
          credential: parseOutlookCredential(
            JSON.stringify({ ...JSON.parse(OUTLOOK_CRED), loginBaseUrl: up.url }),
          ),
          baseUrl: up.url,
        });
        const res = await outlook.invoke({
          operation: "write",
          object: "ana@acme.com",
          payload: { subject: "s" },
        });
        expect(res.status).toBe(202);
        expect(JSON.stringify(res.body)).not.toMatch(/delivered/i);
      },
    );
  });
});

// ADR-0173 batch 2b review — the product's own chat controls are not a
// connector write's to use (the gateway refuses on this before the kernel)
describe("reservedChatControl", () => {
  const card = (actionId: string) => ({
    text: "Approval needed",
    blocks: [{ type: "actions", elements: [{ type: "button", action_id: actionId, value: "00000000-0000-4000-8000-000000000001" }] }],
  });

  it("slack: chat.update is internal-only", () => {
    expect(reservedChatControl("slack", "write", { op: "chat.update", ts: "1.2", text: "Approved" })?.code).toBe("chat_update_internal_only");
  });

  it("slack: a reserved action/block/callback id anywhere is refused — nested, in attachments, as a JSON string, any case", () => {
    for (const id of ["regulait_approve", "regulait_reject", "regulait_step_approve", "regulait_step_deny", "REGULAIT_anything", " regulait_x"]) {
      expect(reservedChatControl("slack", "write", card(id))?.code, id).toBe("reserved_chat_control");
    }
    expect(reservedChatControl("slack", "write", { attachments: [{ callback_id: "regulait_approve" }] })?.code).toBe("reserved_chat_control");
    expect(reservedChatControl("slack", "write", { blocks: [{ type: "actions", block_id: "regulait_step", elements: [] }] })?.code).toBe("reserved_chat_control");
    expect(reservedChatControl("slack", "write", { blocks: JSON.stringify(card("regulait_step_approve").blocks) })?.code).toBe("reserved_chat_control");
  });

  it("slack: ordinary messages and interactive blocks with other ids pass; reads are not checked", () => {
    expect(reservedChatControl("slack", "write", { text: "deployed regulait_approve is just words" })).toBeNull();
    expect(reservedChatControl("slack", "write", card("my_app_button"))).toBeNull();
    expect(reservedChatControl("slack", "read", { op: "conversations.history" })).toBeNull();
    expect(reservedChatControl("slack", "write", null)).toBeNull();
  });

  it("teams: a submit action carrying approvalId is refused; other kinds are untouched", () => {
    const adaptive = { attachments: [{ content: { actions: [{ type: "Action.Submit", data: { approvalId: "x", action: "approve" } }] } }] };
    expect(reservedChatControl("teams", "write", adaptive)?.code).toBe("reserved_chat_control");
    expect(reservedChatControl("teams", "write", { text: "hello" })).toBeNull();
    expect(reservedChatControl("webhook", "write", card("regulait_approve"))).toBeNull();
  });

  it("past its depth bound nothing is assumed safe", () => {
    let deep: unknown = { text: "x" };
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    expect(reservedChatControl("slack", "write", deep)?.code).toBe("reserved_chat_control");
  });
});
