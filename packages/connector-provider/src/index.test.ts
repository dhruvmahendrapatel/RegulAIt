import { describe, expect, it } from "vitest";
import {
  ConnectorProviderError,
  GenericHttpConnectorProvider,
  MockConnectorProvider,
  WebhookConnectorProvider,
  isConnectorProviderKind,
  resolveConnectorProvider,
} from "./index.js";

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

  it("rejects declared-but-unimplemented kinds explicitly (no silent promise)", () => {
    for (const kind of ["slack", "github", "jira", "snowflake"] as const) {
      const err = (() => {
        try {
          resolveConnectorProvider({ kind, baseUrl: "https://x.example", token: "t" });
          return null;
        } catch (e) {
          return e as ConnectorProviderError;
        }
      })();
      expect(err).toBeInstanceOf(ConnectorProviderError);
      expect(err!.status).toBe(501);
      expect(err!.message).toContain("not implemented yet");
    }
  });

  it("isConnectorProviderKind guards the kind union", () => {
    expect(isConnectorProviderKind("mock")).toBe(true);
    expect(isConnectorProviderKind("generic")).toBe(true);
    expect(isConnectorProviderKind("salesforce")).toBe(false);
  });
});
