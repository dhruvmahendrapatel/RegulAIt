/**
 * ADR-0202 lane E — the Resend courier adapter, against a stubbed transport.
 * Pure: no network, no db. The gateway half (registration, named-approver
 * recipients, the egress guard, the rate limit, audit rows) is
 * apps/gateway/src/adr0202-resend-courier.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ConnectorProviderError,
  RESEND_DEFAULT_BASE_URL,
  ResendConnectorProvider,
  connectorDefaultBaseUrl,
  isConnectorProviderKind,
  parseResendCredential,
  resolveConnectorProvider,
} from "./index.js";

type FetchLike = NonNullable<Parameters<typeof resolveConnectorProvider>[1]>;

const KEY = "re_SYNTHETIC_resend_key_for_tests_only";
const CRED = JSON.stringify({ apiKey: KEY, from: "Approvals@Mail.Example.com" });

type Call = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } };

function stub(status: number, body: string) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: Call["init"]) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as FetchLike;
  return { calls, fetchImpl };
}

const provider = (fetchImpl: FetchLike, baseUrl?: string) =>
  resolveConnectorProvider({ kind: "resend", token: CRED, baseUrl: baseUrl ?? null }, fetchImpl);

describe("the credential", () => {
  it("is a registered kind whose compiled destination is the Resend API", () => {
    expect(isConnectorProviderKind("resend")).toBe(true);
    expect(connectorDefaultBaseUrl("resend")).toBe(RESEND_DEFAULT_BASE_URL);
  });

  it("requires an explicit sender, and never echoes the key in a refusal", () => {
    for (const bad of ["re_plain_not_json", JSON.stringify({ apiKey: KEY }), JSON.stringify({ apiKey: KEY, from: "not-an-address" }),
      JSON.stringify({ apiKey: KEY, from: "a@mail.example.com", to: "x@example.com" }),
      JSON.stringify({ apiKey: KEY, from: "a@mail.example.com", fromName: "Evil <x@example.com>" })]) {
      let err: unknown;
      try {
        parseResendCredential(bad);
      } catch (e) {
        err = e;
      }
      expect(err, bad).toBeInstanceOf(ConnectorProviderError);
      expect(String((err as Error).message)).not.toContain(KEY);
    }
    expect(parseResendCredential(CRED).from).toBe("approvals@mail.example.com");
  });
});

describe("send", () => {
  it("POSTs one mail to /emails from the credential's sender to the governed object only", async () => {
    const { calls, fetchImpl } = stub(200, JSON.stringify({ id: "email-123" }));
    const out = await provider(fetchImpl).invoke({
      operation: "write",
      object: "Approver@Example.com",
      payload: {
        op: "sendEmail",
        subject: "RegulAIt: an approval needs you",
        html: "<p>hi</p>",
        // a crafted payload cannot add or redirect recipients, or change the sender
        to: ["attacker@example.net"],
        cc: ["attacker@example.net"],
        bcc: ["attacker@example.net"],
        reply_to: "attacker@example.net",
        from: "ceo@example.net",
        headers: { "x-evil": "1" },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${RESEND_DEFAULT_BASE_URL}/emails`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers!.authorization).toBe(`Bearer ${KEY}`);
    const sent = JSON.parse(calls[0]!.init.body!);
    expect(sent).toEqual({ from: "approvals@mail.example.com", to: ["approver@example.com"], subject: "RegulAIt: an approval needs you", html: "<p>hi</p>" });
    expect(out.body).toMatchObject({ accepted: true, recipient: "approver@example.com", id: "email-123" });
  });

  it("goes only through the injected fetch (the egress guard's), never the global one", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    try {
      const { calls, fetchImpl } = stub(200, "{}");
      await provider(fetchImpl, "https://resend.example.test/").invoke({ operation: "write", object: "a@example.com", payload: { subject: "s", text: "t" } });
      expect(calls[0]!.url).toBe("https://resend.example.test/emails");
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
  });

  it("refuses read, another op, a missing or multi recipient, a header-injecting or empty subject, and an empty body — before any request", async () => {
    const { calls, fetchImpl } = stub(200, "{}");
    const p = provider(fetchImpl);
    const ok = { subject: "s", html: "<p>x</p>" };
    const bad = [
      { operation: "read" as const, object: "a@example.com", payload: ok },
      { operation: "write" as const, object: "a@example.com", payload: { ...ok, op: "batch" } },
      { operation: "write" as const, object: null, payload: ok },
      { operation: "write" as const, object: "a@example.com, b@example.com", payload: ok },
      { operation: "write" as const, object: "a@example.com", payload: { subject: "", html: "<p>x</p>" } },
      { operation: "write" as const, object: "a@example.com", payload: { subject: "x".repeat(201), html: "<p>x</p>" } },
      { operation: "write" as const, object: "a@example.com", payload: { subject: "s" } },
    ];
    for (const inv of bad) {
      await expect(p.invoke(inv as never), JSON.stringify(inv)).rejects.toBeInstanceOf(ConnectorProviderError);
    }
    expect(calls).toHaveLength(0);
    // a CR/LF in a subject is flattened, never a second header line
    await p.invoke({ operation: "write", object: "a@example.com", payload: { subject: "a\r\nBcc: x@example.net", html: "<p>x</p>" } });
    expect(JSON.parse(calls[0]!.init.body!).subject).toBe("a Bcc: x@example.net");
  });

  it("an upstream refusal is a named error that carries no form of the key, in the message or the log", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    try {
      for (const status of [401, 422, 500]) {
        const { fetchImpl } = stub(status, JSON.stringify({ name: "validation_error", message: `bad key ${KEY}` }));
        let err: ConnectorProviderError | undefined;
        try {
          await provider(fetchImpl).invoke({ operation: "write", object: "a@example.com", payload: { subject: "s", text: "t" } });
        } catch (e) {
          err = e as ConnectorProviderError;
        }
        expect(err).toBeInstanceOf(ConnectorProviderError);
        expect(err!.status).toBe(status);
        expect(err!.message).toContain("validation_error");
        expect(err!.message).not.toContain(KEY);
      }
      const { fetchImpl } = stub(429, "{}");
      await expect(
        provider(fetchImpl).invoke({ operation: "write", object: "a@example.com", payload: { subject: "s", text: "t" } }),
      ).rejects.toMatchObject({ status: 429 });
      expect(errors.length).toBeGreaterThan(0);
      for (const line of errors) expect(line).not.toContain(KEY);
    } finally {
      spy.mockRestore();
    }
  });

  it("is constructed only from a parsed credential", () => {
    expect(() => resolveConnectorProvider({ kind: "resend", token: null, baseUrl: null })).toThrow(ConnectorProviderError);
    expect(new ResendConnectorProvider({ credential: parseResendCredential(CRED) }).kind).toBe("resend");
  });
});
