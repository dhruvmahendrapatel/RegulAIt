import { describe, expect, it } from "vitest";
import {
  ACTION_KEY,
  MAX_SCOPES,
  SCOPE_TOKEN,
  TTL_CEILING,
  TTL_DEFAULT,
  TTL_FLOOR,
  bodyOf,
  formOf,
  formProblems,
  isHttps,
  refusalWords,
  type TokenExchangeView,
} from "./tokenExchangeModel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const shared = async (): Promise<Any> =>
  import(/* @vite-ignore */ new URL("../../../../../../packages/shared/src/identity/upstream-token-exchange.ts", import.meta.url).pathname);

const view: TokenExchangeView = {
  configured: true,
  enabled: true,
  tokenEndpoint: "https://auth.example.test/token",
  subjectTokenAudience: "https://auth.example.test",
  audience: "acme-docs",
  resource: null,
  clientId: "regulait-gw",
  clientSecretLast4: "wxyz",
  maxTokenTtlSeconds: 120,
  scopes: { search_docs: ["docs.read"], write_doc: ["docs.read", "docs.write"] },
  setBy: "ada",
  secretSetAt: "2026-11-10T09:00:00.000Z",
};

describe("token exchange model", () => {
  it("mirrors the shared bounds and patterns", async () => {
    const s = await shared();
    expect([TTL_FLOOR, TTL_CEILING, TTL_DEFAULT]).toEqual([s.UPSTREAM_EXCHANGE_TTL_FLOOR_SECONDS, s.UPSTREAM_EXCHANGE_TTL_CEILING_SECONDS, s.UPSTREAM_EXCHANGE_TTL_DEFAULT_SECONDS]);
    expect([256, MAX_SCOPES]).toEqual([s.UPSTREAM_EXCHANGE_MAX_ACTIONS, s.UPSTREAM_EXCHANGE_MAX_SCOPES_PER_ACTION]);
    expect(SCOPE_TOKEN.source).toBe(s.SCOPE_TOKEN_PATTERN.source);
    expect(ACTION_KEY.source).toBe(s.EXCHANGE_ACTION_PATTERN.source);
  });

  it("prefills the stored values but never the secret or the switch", () => {
    const f = formOf(view);
    expect(f.enabled).toBe(false);
    expect(f.clientSecret).toBe("");
    expect(f.ttl).toBe("120");
    expect(f.rows).toEqual([
      { action: "search_docs", scopes: "docs.read" },
      { action: "write_doc", scopes: "docs.read docs.write" },
    ]);
    expect(formOf(undefined)).toMatchObject({ ttl: String(TTL_DEFAULT), rows: [{ action: "", scopes: "" }], enabled: false });
  });

  it("accepts only https addresses with no credentials or fragment", () => {
    expect(isHttps("http://auth.example.test/token")).toBe(false);
    expect(isHttps("auth.example.test")).toBe(false);
    expect(isHttps("https://u:p@auth.example.test/")).toBe(false);
    expect(isHttps("https://auth.example.test/token#x")).toBe(false);
    expect(isHttps("https://auth.example.test/token")).toBe(true);
  });

  it("requires the secret only on first set, and checks the lifetime and the scope map", () => {
    const f = formOf(view);
    expect(formProblems(f, true)).toEqual({});
    expect(formProblems(f, false).clientSecret).toMatch(/16 to 512/);
    expect(formProblems({ ...f, clientSecret: "short" }, true).clientSecret).toMatch(/16 to 512/);
    expect(formProblems({ ...f, ttl: "29" }, true).ttl).toMatch(/30 to 900/);
    expect(formProblems({ ...f, ttl: "901" }, true).ttl).toBeDefined();
    const rows = [
      { action: "a", scopes: "" },
      { action: "bad key", scopes: "x" },
      { action: "a", scopes: "x" },
      { action: "c", scopes: 'say"hi' },
      { action: "", scopes: "" },
    ];
    const p = formProblems({ ...f, rows }, true);
    expect(p.row0).toMatch(/1 to 32 scopes/);
    expect(p.row1).toMatch(/letters, numbers/);
    expect(p.row2).toMatch(/twice/);
    expect(p.row3).toMatch(/no quotes/);
    expect(p.row4).toBeUndefined();
  });

  it("builds the body: the secret only when typed, blank rows dropped", () => {
    const f = { ...formOf(view), rows: [...formOf(view).rows, { action: " ", scopes: "" }] };
    const b = bodyOf(f);
    expect(b).not.toHaveProperty("clientSecret");
    expect(b).not.toHaveProperty("resource");
    expect(b).toMatchObject({ enabled: false, maxTokenTtlSeconds: 120, scopes: { search_docs: ["docs.read"], write_doc: ["docs.read", "docs.write"] } });
    expect(bodyOf({ ...f, clientSecret: "s3cret-s3cret-123", resource: "https://docs.example.test" })).toMatchObject({ clientSecret: "s3cret-s3cret-123", resource: "https://docs.example.test" });
  });

  it("puts each refusal code in words and passes other errors through", () => {
    const e = (payload: unknown) => ({ payload });
    expect(refusalWords(e({ error: "upstream_token_exchange_refused", code: "stdio" }))).toMatch(/stdio server/);
    expect(refusalWords(e({ error: "upstream_token_exchange_refused", code: "profile_conflict" }))).toMatch(/default header form/);
    expect(refusalWords(e({ error: "upstream_token_exchange_refused", code: "bearer_credential_conflict" }))).toMatch(/Upstream credential/);
    expect(refusalWords(e({ error: "upstream_token_exchange_refused", code: "new_code", detail: "a sentence" }))).toBe("a sentence");
    expect(refusalWords(e({ error: "invalid_request", detail: "expected { enabled }" }))).toBeNull();
    expect(refusalWords(e({ error: "step_up_required" }))).toBeNull();
    expect(refusalWords(new Error("offline"))).toBeNull();
  });
});
