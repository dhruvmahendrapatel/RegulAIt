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
  WebhookConnectorProvider,
  isConnectorProviderKind,
  resolveConnectorProvider,
} from "./index.js";

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

  it("rejects declared-but-unimplemented kinds explicitly (no silent promise) — snowflake stays deferred", () => {
    // Snowflake is DEFERRED: its key-pair credential shape needs a schema
    // decision owned elsewhere (ROADMAP Batch B) — it must keep 501ing.
    const err = (() => {
      try {
        resolveConnectorProvider({ kind: "snowflake", baseUrl: "https://x.example", token: "t" });
        return null;
      } catch (e) {
        return e as ConnectorProviderError;
      }
    })();
    expect(err).toBeInstanceOf(ConnectorProviderError);
    expect(err!.status).toBe(501);
    expect(err!.message).toContain("not implemented yet");
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
