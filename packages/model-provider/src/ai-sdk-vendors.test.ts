/**
 * ADR-0352 (lane E33, slice 1): Bedrock, Vertex, Mistral, Cohere and Qwen adapters.
 * No network and no real key: every case injects a fetch and asserts what reached it.
 */
import { generateKeyPairSync } from "node:crypto";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_SDK_VENDOR_KINDS,
  COHERE_DEFAULT_BASE,
  MISTRAL_DEFAULT_BASE,
  ModelProviderError,
  QWEN_DEFAULT_BASE,
  VERTEX_EXPRESS_BASE,
  bedrockRegionFromBaseUrl,
  clearVertexTokenCache,
  defaultBaseUrlFor,
  isModelProviderKind,
  parseBedrockCredential,
  resolveModelProvider,
  validateVendorCredential,
} from "./index.js";

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recorder(respond: (s: Seen) => Response | Promise<Response>): { seen: Seen[]; fetch: typeof fetch } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      const s: Seen = {
        url: String(input instanceof Request ? input.url : input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : undefined,
      };
      seen.push(s);
      return respond(s);
    },
  };
}

const openAiChat = (model: string, extra: Record<string, unknown> = {}) => ({
  id: "cmpl-1",
  object: "chat.completion",
  created: 1,
  model,
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  ...extra,
});

const converse = (stopReason = "end_turn") => ({
  output: { message: { role: "assistant", content: [{ text: "hello" }] } },
  stopReason,
  usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
});

const gemini = () => ({
  responseId: "r-1",
  modelVersion: "gemini-2.5-pro-002",
  candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
});

const cohereChat = () => ({
  id: "co-1",
  finish_reason: "COMPLETE",
  message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  usage: { billed_units: { input_tokens: 11, output_tokens: 7 }, tokens: { input_tokens: 11, output_tokens: 7 } },
});

const BEDROCK_BASE = "https://bedrock-runtime.eu-west-1.amazonaws.com";
const SIGV4 = JSON.stringify({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearVertexTokenCache();
});

describe("ADR-0352 registry", () => {
  it("the five kinds are provider kinds, and their compiled defaults match what the SDK reaches", async () => {
    for (const k of AI_SDK_VENDOR_KINDS) expect(isModelProviderKind(k)).toBe(true);
    expect(defaultBaseUrlFor("bedrock")).toBeNull();
    expect(defaultBaseUrlFor("vertex")).toBe(VERTEX_EXPRESS_BASE);

    // drift: with no baseUrl override the adapter's first request goes to the constant
    const cases = [
      { kind: "mistral" as const, base: MISTRAL_DEFAULT_BASE, body: openAiChat("mistral-large-2411") },
      { kind: "cohere" as const, base: COHERE_DEFAULT_BASE, body: cohereChat() },
      { kind: "qwen" as const, base: QWEN_DEFAULT_BASE, body: openAiChat("qwen-plus") },
      { kind: "vertex" as const, base: VERTEX_EXPRESS_BASE, body: gemini() },
    ];
    for (const c of cases) {
      expect(defaultBaseUrlFor(c.kind)).toBe(c.base);
      const r = recorder(() => json(c.body));
      await resolveModelProvider({ provider: c.kind, apiKey: "k", baseUrl: null }, r.fetch).dispatch({ model: "m", input: "x" });
      expect(r.seen[0]!.url.startsWith(`${c.base}/`)).toBe(true);
    }
  });

  it("an empty key is refused for every kind", () => {
    for (const k of AI_SDK_VENDOR_KINDS) {
      expect(() => resolveModelProvider({ provider: k, apiKey: "", baseUrl: BEDROCK_BASE })).toThrow(ModelProviderError);
    }
  });
});

describe("ADR-0352 dispatch: text, usage, served model", () => {
  it("mistral: text, usage and the vendor-reported model", async () => {
    const r = recorder(() => json(openAiChat("mistral-large-2411")));
    const res = await resolveModelProvider({ provider: "mistral", apiKey: "mk", baseUrl: null }, r.fetch).dispatch({
      model: "mistral-large-latest",
      input: "hi",
    });
    expect(res).toMatchObject({
      outputText: "hello",
      stopReason: "end_turn",
      refusal: false,
      usage: { inputTokens: 11, outputTokens: 7 },
      servedModel: "mistral-large-2411",
      providerMessageId: "cmpl-1",
    });
    expect(r.seen[0]!.headers.get("authorization")).toBe("Bearer mk");
  });

  it("cohere: usage from the vendor, and no invented served model", async () => {
    const r = recorder(() => json(cohereChat()));
    const res = await resolveModelProvider({ provider: "cohere", apiKey: "ck", baseUrl: null }, r.fetch).dispatch({
      model: "command-a-03-2025",
      input: "hi",
    });
    expect(res).toMatchObject({ outputText: "hello", stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 7 } });
    expect(res.servedModel).toBeNull();
    expect(r.seen[0]!.url).toBe(`${COHERE_DEFAULT_BASE}/chat`);
  });

  it("qwen: OpenAI-compatible Model Studio endpoint", async () => {
    const r = recorder(() => json(openAiChat("qwen-plus-2025-09-11")));
    const res = await resolveModelProvider({ provider: "qwen", apiKey: "qk", baseUrl: null }, r.fetch).dispatch({
      model: "qwen-plus",
      input: "hi",
    });
    expect(res).toMatchObject({ outputText: "hello", servedModel: "qwen-plus-2025-09-11", usage: { inputTokens: 11, outputTokens: 7 } });
    expect(r.seen[0]!.url).toBe(`${QWEN_DEFAULT_BASE}/chat/completions`);
  });

  it("tool calls come back in the neutral shape", async () => {
    const r = recorder(() =>
      json(
        openAiChat("mistral-large-2411", {
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ),
    );
    const res = await resolveModelProvider({ provider: "mistral", apiKey: "mk", baseUrl: null }, r.fetch).dispatch({
      model: "m",
      input: "x",
      tools: [{ name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
    });
    expect(res.stopReason).toBe("tool_use");
    expect(res.toolCalls).toEqual([{ id: "call_1", name: "lookup", arguments: { q: "x" } }]);
  });

  it("streaming forwards deltas as they arrive and keeps usage", async () => {
    const events = [
      { id: "s1", model: "mistral-large-2411", choices: [{ index: 0, delta: { role: "assistant", content: "he" }, finish_reason: null }] },
      { id: "s1", model: "mistral-large-2411", choices: [{ index: 0, delta: { content: "llo" }, finish_reason: null }] },
      {
        id: "s1",
        model: "mistral-large-2411",
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ];
    const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
    const r = recorder(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const deltas: string[] = [];
    const res = await resolveModelProvider({ provider: "mistral", apiKey: "mk", baseUrl: null }, r.fetch).dispatch({
      model: "m",
      input: "x",
      onText: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(["he", "llo"]);
    expect(res).toMatchObject({ outputText: "hello", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 }, servedModel: "mistral-large-2411" });
  });

  it("a content-filter finish is a refusal whose text is never surfaced", async () => {
    const r = recorder(() => json(converse("content_filtered")));
    const res = await resolveModelProvider({ provider: "bedrock", apiKey: "brk", baseUrl: BEDROCK_BASE }, r.fetch).dispatch({
      model: "anthropic.claude-sonnet-4-5-v1:0",
      input: "x",
    });
    expect(res).toMatchObject({ refusal: true, stopReason: "refusal", outputText: "" });
  });

  it("'thinking' is refused loudly rather than dropped", async () => {
    const r = recorder(() => json(openAiChat("m")));
    await expect(
      resolveModelProvider({ provider: "cohere", apiKey: "ck", baseUrl: null }, r.fetch).dispatch({
        model: "m",
        input: "x",
        thinking: { budgetTokens: 1024 },
      }),
    ).rejects.toThrow(/does not support 'thinking'/);
    expect(r.seen).toEqual([]);
  });

  it("a vendor HTTP error keeps its status", async () => {
    const r = recorder(() => json({ message: "Unauthorized" }, 401));
    const err = (await resolveModelProvider({ provider: "mistral", apiKey: "bad", baseUrl: null }, r.fetch)
      .dispatch({ model: "m", input: "x" })
      .catch((e: unknown) => e)) as ModelProviderError;
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.status).toBe(401);
  });
});

describe("ADR-0352 Bedrock: SigV4 through the AWS SDK signer", () => {
  it("signs with SigV4 for the baseUrl region; the request sent is exactly the request signed", async () => {
    const r = recorder(() => json(converse()));
    const res = await resolveModelProvider({ provider: "bedrock", apiKey: SIGV4, baseUrl: BEDROCK_BASE }, r.fetch).dispatch({
      model: "anthropic.claude-sonnet-4-5-v1:0",
      input: "hi",
    });
    expect(res).toMatchObject({ outputText: "hello", usage: { inputTokens: 11, outputTokens: 7 }, servedModel: null });
    const s = r.seen[0]!;
    expect(new URL(s.url).host).toBe("bedrock-runtime.eu-west-1.amazonaws.com");
    const auth = s.headers.get("authorization")!;
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=/);
    expect(auth).not.toContain("regulait-credential-applied-by-fetch");

    // independent re-sign of what actually went on the wire, at the same instant
    const url = new URL(s.url);
    const amzDate = s.headers.get("x-amz-date")!;
    const headers: Record<string, string> = {};
    s.headers.forEach((v, k) => {
      if (k !== "authorization" && k !== "x-amz-date" && k !== "x-amz-content-sha256") headers[k] = v;
    });
    headers["host"] = url.host;
    const signer = new SignatureV4({
      service: "bedrock",
      region: "eu-west-1",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      sha256: Hash.bind(null, "sha256"),
    });
    const iso = `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`;
    const again = await signer.sign(
      { method: s.method, protocol: url.protocol, hostname: url.hostname, path: url.pathname, query: {}, headers, body: s.body },
      { signingDate: new Date(iso) },
    );
    expect(again.headers["authorization"]).toBe(auth);
  });

  it("carries a session token when the credential has one", async () => {
    const r = recorder(() => json(converse()));
    const cred = JSON.stringify({ accessKeyId: "ASIAEXAMPLE", secretAccessKey: "s", sessionToken: "tok" });
    await resolveModelProvider({ provider: "bedrock", apiKey: cred, baseUrl: BEDROCK_BASE }, r.fetch).dispatch({ model: "m", input: "x" });
    expect(r.seen[0]!.headers.get("x-amz-security-token")).toBe("tok");
  });

  it("a Bedrock API key is sent as a bearer token", async () => {
    const r = recorder(() => json(converse()));
    await resolveModelProvider({ provider: "bedrock", apiKey: "bedrock-api-key", baseUrl: BEDROCK_BASE }, r.fetch).dispatch({
      model: "m",
      input: "x",
    });
    expect(r.seen[0]!.headers.get("authorization")).toBe("Bearer bedrock-api-key");
  });

  it("never uses an ambient AWS credential, region or endpoint", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "ambient-bearer");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAAMBIENT");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret");
    vi.stubEnv("AWS_REGION", "us-west-2");
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "https://ambient.example");
    vi.stubGlobal("fetch", () => {
      throw new Error("reached the global fetch");
    });
    const r = recorder(() => json(converse()));
    await resolveModelProvider({ provider: "bedrock", apiKey: SIGV4, baseUrl: BEDROCK_BASE }, r.fetch).dispatch({ model: "m", input: "x" });
    const s = r.seen[0]!;
    expect(new URL(s.url).host).toBe("bedrock-runtime.eu-west-1.amazonaws.com");
    expect(s.headers.get("authorization")).toContain("Credential=AKIDEXAMPLE/");
    expect(s.headers.get("authorization")).toContain("/eu-west-1/bedrock/");
  });

  it("refuses without a baseUrl, on a region mismatch, and on a malformed key — without echoing it", () => {
    expect(() => resolveModelProvider({ provider: "bedrock", apiKey: SIGV4, baseUrl: null })).toThrow(/requires a baseUrl/);
    const wrongRegion = JSON.stringify({ accessKeyId: "a", secretAccessKey: "b", region: "us-east-1" });
    expect(() => resolveModelProvider({ provider: "bedrock", apiKey: wrongRegion, baseUrl: BEDROCK_BASE })).toThrow(/does not match/);
    expect(() => resolveModelProvider({ provider: "bedrock", apiKey: "k", baseUrl: "https://vpce-1.bedrock.internal" })).toThrow(
      /needs a region/,
    );
    let msg = "";
    try {
      parseBedrockCredential('{"accessKeyId":"AKIASECRETVALUE", oops');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/does not parse/);
    expect(msg).not.toContain("AKIASECRETVALUE");
  });

  it("a private endpoint takes its region from the credential", async () => {
    const r = recorder(() => json(converse()));
    const cred = JSON.stringify({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "s", region: "ap-south-1" });
    await resolveModelProvider({ provider: "bedrock", apiKey: cred, baseUrl: "https://bedrock.vpce.internal" }, r.fetch).dispatch({
      model: "m",
      input: "x",
    });
    expect(r.seen[0]!.url.startsWith("https://bedrock.vpce.internal/")).toBe(true);
    expect(r.seen[0]!.headers.get("authorization")).toContain("/ap-south-1/bedrock/");
  });

  it("parses the region out of regional, FIPS and China endpoints only", () => {
    expect(bedrockRegionFromBaseUrl("https://bedrock-runtime.us-east-1.amazonaws.com")).toBe("us-east-1");
    expect(bedrockRegionFromBaseUrl("https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com/")).toBe("us-gov-west-1");
    expect(bedrockRegionFromBaseUrl("https://bedrock-runtime.cn-north-1.amazonaws.com.cn")).toBe("cn-north-1");
    expect(bedrockRegionFromBaseUrl("https://bedrock-runtime.us-east-1.amazonaws.com.evil.example")).toBeNull();
  });
});

describe("ADR-0352 Vertex", () => {
  const VERTEX_BASE = "https://europe-west4-aiplatform.googleapis.com/v1/projects/p1/locations/europe-west4/publishers/google";
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccount = JSON.stringify({
    type: "service_account",
    client_email: "svc@p1.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    token_uri: "https://attacker.example/token",
  });

  it("a service account mints its token through the injected fetch, and the token is reused", async () => {
    vi.stubEnv("GOOGLE_VERTEX_API_KEY", "ambient-key");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/nonexistent/adc.json");
    vi.stubGlobal("fetch", () => {
      throw new Error("reached the global fetch");
    });
    const r = recorder((s) =>
      s.url.startsWith("https://oauth2.googleapis.com/") ? json({ access_token: "ya29.minted", expires_in: 3600, token_type: "Bearer" }) : json(gemini()),
    );
    const p = resolveModelProvider({ provider: "vertex", apiKey: serviceAccount, baseUrl: VERTEX_BASE }, r.fetch);
    const res = await p.dispatch({ model: "gemini-2.5-pro", input: "hi" });
    await p.dispatch({ model: "gemini-2.5-pro", input: "again" });
    expect(res).toMatchObject({ outputText: "hello", usage: { inputTokens: 11, outputTokens: 7 }, servedModel: "gemini-2.5-pro-002" });
    const hosts = r.seen.map((s) => new URL(s.url).host);
    // one token request (to Google's own endpoint, never the key's token_uri), two model calls
    expect(hosts).toEqual(["oauth2.googleapis.com", "europe-west4-aiplatform.googleapis.com", "europe-west4-aiplatform.googleapis.com"]);
    for (const s of r.seen.slice(1)) {
      expect(s.headers.get("authorization")).toBe("Bearer ya29.minted");
      expect(s.headers.get("x-goog-api-key")).toBeNull();
    }
  });

  it("an express-mode API key goes in x-goog-api-key, never an ambient one", async () => {
    vi.stubEnv("GOOGLE_VERTEX_API_KEY", "ambient-key");
    const r = recorder(() => json(gemini()));
    await resolveModelProvider({ provider: "vertex", apiKey: "agent-key", baseUrl: null }, r.fetch).dispatch({ model: "gemini-2.5-pro", input: "x" });
    expect(r.seen[0]!.headers.get("x-goog-api-key")).toBe("agent-key");
    expect(r.seen[0]!.url).toBe(`${VERTEX_EXPRESS_BASE}/models/gemini-2.5-pro:generateContent`);
  });

  it("a service account needs an explicit baseUrl", () => {
    expect(() => resolveModelProvider({ provider: "vertex", apiKey: serviceAccount, baseUrl: null })).toThrow(/requires a baseUrl/);
  });
});

describe("ADR-0352 store-time validation", () => {
  it("names the problem for bad Bedrock and Vertex secrets, and accepts the good forms", () => {
    expect(validateVendorCredential("bedrock", SIGV4, BEDROCK_BASE)).toBeNull();
    expect(validateVendorCredential("bedrock", "api-key", BEDROCK_BASE)).toBeNull();
    expect(validateVendorCredential("bedrock", SIGV4, null)).toMatch(/requires a baseUrl/);
    expect(validateVendorCredential("bedrock", '{"accessKeyId":"a"}', BEDROCK_BASE)).toMatch(/secretAccessKey/);
    expect(validateVendorCredential("vertex", '{"type":"authorized_user"}', null)).toMatch(/service-account/);
    expect(validateVendorCredential("vertex", "express-key", null)).toBeNull();
    expect(validateVendorCredential("mistral", "k", null)).toBeNull();
  });
});
