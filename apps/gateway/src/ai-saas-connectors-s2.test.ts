/**
 * ADR-0361 slice 2 — the ChatGPT Enterprise and Claude Enterprise connectors against fake vendors (shapes from the
 * vendors' own OpenAPI and reference pages), and the guarded fetch's opt-in redirect return.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_COMPLIANCE_VERSION,
  CHATGPT_ENTERPRISE_CONNECTOR,
  CHATGPT_MAX_LOG_FILE_BYTES,
  CLAUDE_ENTERPRISE_CONNECTOR,
  type ConnectorContext,
} from "./ai-saas-connectors.js";
import { createGuardedFetch, EgressRedirectError } from "./egress-guard.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const window = { start: new Date("2026-11-16T00:00:00Z"), end: new Date("2026-11-17T00:00:00Z") };
const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];
const allow = (...hosts: string[]) => hosts.map((host) => ({ host, allowPrivateRanges: false, allowPlaintextHttp: false }));

function ctxFor(fetchImpl: typeof fetch, config: Record<string, unknown>, downloadFetch: typeof fetch | null = fetchImpl) {
  const secrets: string[] = [];
  const ctx: ConnectorContext = {
    config,
    credential: { secret: "sk-admin-test-key" },
    fetch: fetchImpl,
    ...(downloadFetch ? { downloadFetch } : {}),
    throttle: async () => undefined,
    backoff: async () => false,
    registerSecret: (v) => secrets.push(v),
    signal: new AbortController().signal,
  };
  return { ctx, secrets };
}

async function collect(it: AsyncIterable<{ interactions: Array<{ kind: string; text: string; vendorInteractionId: string; actorRef: string | null }>; unit: string }>) {
  const pages = [];
  for await (const p of it) pages.push(p);
  return pages;
}

const gptRecord = (id: string, author: "user" | "assistant", value: string) => ({
  event_id: id,
  type: "CONVERSATION_MESSAGE",
  timestamp: "2026-11-16T10:00:00.000Z",
  principal: { id: "ws-1", type: "CHATGPT_WORKSPACE" },
  actor: { type: "ACCOUNT_USER", user_id: "user-AbC", user_email: "someone@example.org" },
  message: { id: `msg-${id}`, created_at: "2026-11-16T10:00:00.000Z", author: { type: author }, content: { type: "text", value } },
  conversation: { id: "conv-1", title: "t" },
});

/** a fake ChatGPT: the log list, a 307 per file to a signed URL on a storage host, and the JSONL behind it */
function fakeChatGpt(
  jsonl: string | Uint8Array,
  opts: { sha?: string | null; storageHost?: string; location?: string; storageRedirects?: boolean; fileSize?: number } = {},
) {
  const calls: Array<{ url: URL; headers: Headers }> = [];
  const bytes = typeof jsonl === "string" ? new TextEncoder().encode(jsonl) : jsonl;
  const sha = opts.sha === undefined ? createHash("sha256").update(bytes).digest("hex") : opts.sha;
  const storage = opts.storageHost ?? "files.example-storage.net";
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push({ url, headers: new Headers(init?.headers) });
    if (url.hostname === "api.chatgpt.com" && url.pathname === "/v1/compliance/workspaces/ws-1/logs") {
      if (url.searchParams.get("limit") === "1") return json({ data: [], has_more: false, last_end_time: null });
      const file = { id: "log-1", event_type: "CONVERSATION_MESSAGE", end_time: "2026-11-16T10:10:00Z", file_name: "a.jsonl", file_size: opts.fileSize ?? bytes.length, ...(sha === null ? {} : { file_sha256: sha }) };
      return json({ data: [file], has_more: false, last_end_time: "2026-11-16T10:10:00Z" });
    }
    if (url.hostname === "api.chatgpt.com" && url.pathname === "/v1/compliance/workspaces/ws-1/logs/log-1") {
      return new Response(null, { status: 307, headers: { location: opts.location ?? `https://${storage}/log-1.jsonl?sig=SIGNED-SECRET` } });
    }
    if (url.hostname === storage && opts.storageRedirects) return new Response(null, { status: 302, headers: { location: `https://${storage}/again` } });
    if (url.hostname === storage) return new Response(bytes, { status: 200, headers: { "content-type": "application/jsonl" } });
    return json({ error: "unexpected" }, 599);
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe("ADR-0361 guarded fetch: returnRedirects is opt-in and still never follows", () => {
  const fetchImpl = (async () => new Response("x", { status: 307, headers: { location: "https://elsewhere.example/x?sig=1" } })) as typeof fetch;
  it("refuses a redirect by default, exactly as before", async () => {
    const guarded = createGuardedFetch({ allowList: allow("api.chatgpt.com"), resolve: publicResolver, fetchImpl });
    await expect(guarded("https://api.chatgpt.com/v1/x")).rejects.toBeInstanceOf(EgressRedirectError);
  });
  it("hands back only the Location when asked, and the target is checked like any other destination", async () => {
    const guarded = createGuardedFetch({ allowList: allow("api.chatgpt.com"), resolve: publicResolver, fetchImpl, returnRedirects: true });
    const res = await guarded("https://api.chatgpt.com/v1/x");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://elsewhere.example/x?sig=1");
    expect(await res.text()).toBe("");
    await expect(guarded("https://elsewhere.example/x?sig=1")).rejects.toThrow();
  });
});

describe("ADR-0361 ChatGPT Enterprise connector", () => {
  const config = { principal: "workspace", principalId: "ws-1", backfillDays: 7 };

  it("lists the window's conversation logs, follows the 307 itself without our key, and checks the file's SHA-256", async () => {
    const jsonl = [gptRecord("e1", "user", "Here is the customer list: jane@example.com"), { type: "AUTH_LOG", event_id: "x" }, gptRecord("e2", "assistant", "Done.")]
      .map((r) => JSON.stringify(r))
      .join("\n");
    const v = fakeChatGpt(jsonl);
    const { ctx, secrets } = ctxFor(v.fetch, config);
    const auth = await CHATGPT_ENTERPRISE_CONNECTOR.authorise(ctx);
    expect(auth).toMatchObject({ scope: "unverified", headers: { authorization: "Bearer sk-admin-test-key" } });
    const pages = await collect(CHATGPT_ENTERPRISE_CONNECTOR.listInteractions(ctx, auth, window));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.interactions.map((i) => [i.vendorInteractionId, i.kind, i.actorRef])).toEqual([["e1", "prompt", "user-AbC"], ["e2", "response", "user-AbC"]]);
    const list = v.calls.find((c) => c.url.pathname.endsWith("/logs") && c.url.searchParams.get("limit") === "100")!;
    expect(list.url.searchParams.get("event_type")).toBe("CONVERSATION_MESSAGE");
    expect(list.url.searchParams.get("after")).toBe(window.start.toISOString());
    expect(list.url.searchParams.get("before")).toBe(window.end.toISOString());
    const signed = v.calls.find((c) => c.url.hostname === "files.example-storage.net")!;
    expect(signed.headers.get("authorization")).toBeNull();
    expect(secrets.some((s) => s.includes("SIGNED-SECRET"))).toBe(true);
  });

  const run = async (v: ReturnType<typeof fakeChatGpt>, downloadFetch: typeof fetch | null = v.fetch) => {
    const { ctx } = ctxFor(v.fetch, config, downloadFetch);
    return collect(CHATGPT_ENTERPRISE_CONNECTOR.listInteractions(ctx, await CHATGPT_ENTERPRISE_CONNECTOR.authorise(ctx), window));
  };

  it("refuses a file whose SHA-256 does not match, and a non-JSON line", async () => {
    const jsonl = JSON.stringify(gptRecord("e1", "user", "x"));
    await expect(run(fakeChatGpt(jsonl, { sha: "0".repeat(64) }))).rejects.toMatchObject({ code: "bad_response", detail: expect.stringContaining("SHA-256") });
    await expect(run(fakeChatGpt("not json"))).rejects.toMatchObject({ code: "bad_response", detail: expect.stringContaining("not JSON") });
  });

  it("refuses a redirect to plaintext http or with credentials, and a second redirect, without following either (review #985 R2 [5])", async () => {
    const jsonl = JSON.stringify(gptRecord("e1", "user", "x"));
    const plain = fakeChatGpt(jsonl, { location: "http://files.example-storage.net/log-1.jsonl?sig=S" });
    await expect(run(plain)).rejects.toMatchObject({ code: "bad_response", detail: expect.stringContaining("plain https") });
    expect(plain.calls.some((c) => c.url.protocol === "http:")).toBe(false);
    const userinfo = fakeChatGpt(jsonl, { location: "https://u:p@files.example-storage.net/log-1.jsonl" });
    await expect(run(userinfo)).rejects.toMatchObject({ code: "bad_response" });
    const twice = fakeChatGpt(jsonl, { storageRedirects: true });
    await expect(run(twice)).rejects.toMatchObject({ code: "bad_response", detail: expect.stringContaining("redirected again") });
    expect(twice.calls.some((c) => c.url.pathname === "/again")).toBe(false);
  });

  it("reads a file the vendor listed without a SHA-256, and checks a listed one over the bytes, BOM included (review #985 R2 [4], [5])", async () => {
    const jsonl = JSON.stringify(gptRecord("e1", "user", "x"));
    expect((await run(fakeChatGpt(jsonl, { sha: null })))[0]!.interactions.map((i) => i.vendorInteractionId)).toEqual(["e1"]);
    // a UTF-8 BOM is part of the file the vendor hashed; decoding before hashing would drop it and fail every run
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(jsonl)]);
    expect((await run(fakeChatGpt(withBom)))[0]!.interactions.map((i) => i.vendorInteractionId)).toEqual(["e1"]);
  });

  it("refuses a file listed over the per-file limit before downloading it, with a sentence saying what to do (review #985 R2 [2])", async () => {
    const jsonl = JSON.stringify(gptRecord("e1", "user", "x"));
    const big = fakeChatGpt(jsonl, { fileSize: CHATGPT_MAX_LOG_FILE_BYTES + 1 });
    await expect(run(big)).rejects.toMatchObject({ code: "response_too_large", detail: expect.stringMatching(/log-1 .*per-file limit.*cannot split/) });
    expect(big.calls.some((c) => c.url.pathname.endsWith("/logs/log-1"))).toBe(false);
  });

  it("downloads only through the redirect-returning fetch it declares, and fails closed without it (review #985 R2 [1])", async () => {
    expect(CHATGPT_ENTERPRISE_CONNECTOR.signedRedirectDownload).toEqual({ maxBytes: CHATGPT_MAX_LOG_FILE_BYTES });
    await expect(run(fakeChatGpt(JSON.stringify(gptRecord("e1", "user", "x"))), null)).rejects.toMatchObject({ code: "internal" });
  });

  it("names the storage host when the egress guard refuses it", async () => {
    const jsonl = JSON.stringify(gptRecord("e1", "user", "x"));
    const v = fakeChatGpt(jsonl);
    const guarded = createGuardedFetch({ allowList: allow("api.chatgpt.com"), resolve: publicResolver, fetchImpl: v.fetch });
    const download = createGuardedFetch({ allowList: allow("api.chatgpt.com"), resolve: publicResolver, fetchImpl: v.fetch, returnRedirects: true });
    const { ctx } = ctxFor(guarded, config, download);
    const auth = await CHATGPT_ENTERPRISE_CONNECTOR.authorise(ctx);
    await expect(collect(CHATGPT_ENTERPRISE_CONNECTOR.listInteractions(ctx, auth, window))).rejects.toMatchObject({
      code: "egress_refused",
      detail: expect.stringContaining("files.example-storage.net"),
    });
  });

  it("uses the organization path for an API Platform organization and validates ids", () => {
    expect(CHATGPT_ENTERPRISE_CONNECTOR.validateConfig({ principal: "organization", principalId: "org-abc_1" })).toBeNull();
    expect(CHATGPT_ENTERPRISE_CONNECTOR.validateConfig({ principalId: "../x" })).not.toBeNull();
    expect(CHATGPT_ENTERPRISE_CONNECTOR.validateConfig({ principalId: "ws", extra: true })).not.toBeNull();
  });
});

describe("ADR-0361 Claude Enterprise connector", () => {
  const config = { organizationIds: ["org_abc123"], backfillDays: 7 };
  const chat = (id: string) => ({ id, name: "n", created_at: "2026-11-16T08:00:00Z", updated_at: "2026-11-16T09:00:00Z", user: { id: "user_xyz", email_address: "u@example.com" } });

  it("polls org-wide by updated_at with after_id paging, reads each chat's messages, and keeps the window's end", async () => {
    const calls: Array<{ url: URL; headers: Headers }> = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.pathname === "/v1/compliance/apps/chats") {
        if (url.searchParams.get("limit") === "1") return json({ data: [], has_more: false, last_id: null });
        if (!url.searchParams.get("after_id")) return json({ data: [chat("claude_chat_1")], has_more: true, last_id: "c1" });
        return json({ data: [chat("claude_chat_2")], has_more: false, last_id: "c2" });
      }
      if (url.pathname === "/v1/compliance/apps/chats/claude_chat_1/messages") {
        if (!url.searchParams.get("after_id")) {
          return json({ id: "claude_chat_1", user: { id: "user_xyz" }, chat_messages: [{ id: "m1", role: "user", created_at: "2026-11-16T08:00:00Z", content: [{ type: "text", text: "draft" }] }], has_more: true, last_id: "p1" });
        }
        return json({
          id: "claude_chat_1",
          user: { id: "user_xyz" },
          chat_messages: [
            { id: "m2", role: "assistant", created_at: "2026-11-16T08:00:01Z", content: [{ type: "tool_result", content: [{ type: "text", text: "ticket for jane@example.com" }] }, { type: "text", text: "two tickets" }] },
            { id: "m3", role: "user", created_at: "2026-11-17T00:00:01Z", content: [{ type: "text", text: "after the window" }] },
          ],
          has_more: false,
          last_id: "p2",
        });
      }
      if (url.pathname === "/v1/compliance/apps/chats/claude_chat_2/messages") return json({ id: "claude_chat_2", chat_messages: [], has_more: false, last_id: null });
      return json({ error: "unexpected" }, 599);
    }) as typeof fetch;
    const { ctx } = ctxFor(f, config);
    const auth = await CLAUDE_ENTERPRISE_CONNECTOR.authorise(ctx);
    expect(auth.headers).toEqual({ "x-api-key": "sk-admin-test-key", "anthropic-version": ANTHROPIC_COMPLIANCE_VERSION });
    const pages = await collect(CLAUDE_ENTERPRISE_CONNECTOR.listInteractions(ctx, auth, window));
    const all = pages.flatMap((p) => p.interactions);
    expect(all.map((i) => i.vendorInteractionId)).toEqual(["m1", "m2"]);
    expect(all[1]).toMatchObject({ kind: "response", actorRef: "user_xyz", text: "ticket for jane@example.com\ntwo tickets" });
    const list = calls.find((c) => c.url.pathname === "/v1/compliance/apps/chats" && c.url.searchParams.get("limit") === "100")!;
    expect(list.url.searchParams.get("order_by")).toBe("updated_at");
    expect(list.url.searchParams.get("updated_at.gte")).toBe(window.start.toISOString());
    expect(list.url.searchParams.get("updated_at.lt")).toBe(window.end.toISOString());
    expect(list.url.searchParams.getAll("organization_ids[]")).toEqual(["org_abc123"]);
    expect(list.url.searchParams.has("user_ids[]")).toBe(false);
  });

  it("refuses a repeated cursor and maps a 403 to a fixed code", async () => {
    const loop = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.searchParams.get("limit") === "1") return json({ data: [], has_more: false, last_id: null });
      return json({ data: [], has_more: true, last_id: "same" });
    }) as typeof fetch;
    const c1 = ctxFor(loop, config).ctx;
    await expect(collect(CLAUDE_ENTERPRISE_CONNECTOR.listInteractions(c1, await CLAUDE_ENTERPRISE_CONNECTOR.authorise(c1), window))).rejects.toMatchObject({ code: "bad_response" });
    const denied = (async () => json({ error: { message: "scopes: read:compliance_activities" } }, 403)) as typeof fetch;
    await expect(CLAUDE_ENTERPRISE_CONNECTOR.authorise(ctxFor(denied, config).ctx)).rejects.toMatchObject({ code: "forbidden" });
  });

  /** one chat updated in the window whose messages come `pages` pages deep, oldest or newest first */
  function longChat(order: "oldest_first" | "newest_first", oldPages: number) {
    const msg = (id: string, at: string) => ({ id, role: "user", created_at: at, content: [{ type: "text", text: id }] });
    const old = Array.from({ length: oldPages }, (_, p) => [msg(`old-${p}-a`, "2026-11-01T00:00:00Z"), msg(`old-${p}-b`, "2026-11-01T00:00:01Z")]);
    const fresh = [msg("new-1", "2026-11-16T09:00:00Z"), msg("new-2", "2026-11-16T09:00:01Z")];
    const pages = order === "oldest_first" ? [...old, fresh] : [[...fresh].reverse(), ...old.map((p) => [...p].reverse())];
    const calls: URL[] = [];
    const f = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      calls.push(url);
      if (url.pathname === "/v1/compliance/apps/chats") {
        if (url.searchParams.get("limit") === "1") return json({ data: [], has_more: false, last_id: null });
        return json({ data: [chat("long_chat")], has_more: false, last_id: "c1" });
      }
      const i = Number(url.searchParams.get("after_id")?.slice(1) ?? "0");
      return json({ id: "long_chat", user: { id: "user_xyz" }, chat_messages: pages[i], has_more: i + 1 < pages.length, last_id: `p${i + 1}` });
    }) as typeof fetch;
    return { fetch: f, calls };
  }

  it("keeps only the window's messages of a long chat, and its older pages do not exhaust the in-window cap (review #985 R2 [3])", async () => {
    // 60 pages of history from before the window, then the window's two messages: more pages than the in-window cap of 50
    const v = longChat("oldest_first", 60);
    const { ctx } = ctxFor(v.fetch, config);
    const pages = await collect(CLAUDE_ENTERPRISE_CONNECTOR.listInteractions(ctx, await CLAUDE_ENTERPRISE_CONNECTOR.authorise(ctx), window));
    expect(pages.flatMap((p) => p.interactions.map((i) => i.vendorInteractionId))).toEqual(["new-1", "new-2"]);
    expect(pages).toHaveLength(1); // a page wholly before the window yields nothing, so nothing old is counted as seen
  });

  it("stops paging a newest-first chat once a page reaches back before the window", async () => {
    const v = longChat("newest_first", 60);
    const { ctx } = ctxFor(v.fetch, config);
    const pages = await collect(CLAUDE_ENTERPRISE_CONNECTOR.listInteractions(ctx, await CLAUDE_ENTERPRISE_CONNECTOR.authorise(ctx), window));
    expect(pages.flatMap((p) => p.interactions.map((i) => i.vendorInteractionId))).toEqual(["new-2", "new-1"]);
    expect(v.calls.filter((u) => u.pathname.endsWith("/messages")).length).toBe(2); // the window's page and the first older one
  });

  it("still bounds a chat whose history outside the window is endless", async () => {
    const v = longChat("oldest_first", 600);
    const { ctx } = ctxFor(v.fetch, config);
    await expect(collect(CLAUDE_ENTERPRISE_CONNECTOR.listInteractions(ctx, await CLAUDE_ENTERPRISE_CONNECTOR.authorise(ctx), window))).rejects.toMatchObject({
      code: "page_limit",
      detail: expect.stringContaining("outside the window"),
    });
  });

  it("skips a null or non-object nested content block instead of failing the run (review #985 R2 [4])", async () => {
    const f = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/v1/compliance/apps/chats") {
        if (url.searchParams.get("limit") === "1") return json({ data: [], has_more: false, last_id: null });
        return json({ data: [chat("c_null")], has_more: false, last_id: "c1" });
      }
      return json({
        id: "c_null",
        chat_messages: [{ id: "m1", role: "assistant", created_at: "2026-11-16T09:00:00Z", content: [{ type: "tool_result", content: [null, 7, { type: "text", text: "kept" }] }] }],
        has_more: false,
        last_id: null,
      });
    }) as typeof fetch;
    const { ctx } = ctxFor(f, config);
    const pages = await collect(CLAUDE_ENTERPRISE_CONNECTOR.listInteractions(ctx, await CLAUDE_ENTERPRISE_CONNECTOR.authorise(ctx), window));
    expect(pages[0]!.interactions[0]!.text).toBe("kept");
  });
});
