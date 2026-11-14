/**
 * ADR-0255 (P31) — the clean-room catalogue pieces. No network: every request goes through a recording fake fetch,
 * which is also how the gateway's egress-guarded fetch reaches the adapter.
 */
import { describe, expect, it } from "vitest";
import {
  AVAILABLE_PIECES,
  AVAILABLE_PIECES_SOURCE,
  CONNECTOR_PROVIDER_KINDS,
  CREDENTIAL_HOST_CONNECTOR_KINDS,
  CURATED_PIECES,
  ConnectorProviderError,
  ConnectorRateLimitError,
  EXCLUDED_PIECES,
  PIECE_PROVIDER_KINDS,
  connectorCredentialHosts,
  parsePieceCredentialShape,
  resolveConnectorProvider,
} from "./index.js";

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: string };
function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, ...init });
    const r = responses.shift() ?? { status: 200, body: {} };
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return {
      status: r.status,
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };
  return { calls, fetchImpl };
}

const GOOGLE = JSON.stringify({ clientId: "cid", clientSecret: "csecret-xyz", refreshToken: "rtok-abc" });
const JIRA = JSON.stringify({ siteUrl: "https://acme.atlassian.net", email: "bot@acme.example", apiToken: "fake" });

describe("catalogue pieces (ADR-0255)", () => {
  it("every curated piece is a provider kind, takes the guarded-fetch branch, and lists upstream community code", () => {
    expect(CURATED_PIECES.map((p) => p.kind)).toEqual([...PIECE_PROVIDER_KINDS]);
    for (const k of PIECE_PROVIDER_KINDS) {
      expect(CONNECTOR_PROVIDER_KINDS).toContain(k);
      expect(CREDENTIAL_HOST_CONNECTOR_KINDS.has(k)).toBe(true);
    }
    for (const p of CURATED_PIECES) {
      expect(p.upstream.path).toBe(`packages/pieces/community/${p.key}`);
      expect(p.upstream.npm).toBe(`@activepieces/piece-${p.key}`);
      expect(new Set(p.actions.map((a) => a.name)).size).toBe(p.actions.length);
    }
  });

  it("the available list excludes the curated pieces and every excluded piece", () => {
    const keys = new Set(AVAILABLE_PIECES.map(([k]) => k));
    for (const p of CURATED_PIECES) expect(keys.has(p.key)).toBe(false);
    for (const k of Object.keys(EXCLUDED_PIECES)) expect(keys.has(k)).toBe(false);
    for (const k of ["http", "webhook", "graphql", "smtp"]) expect(EXCLUDED_PIECES[k]).toBeTruthy();
    expect(AVAILABLE_PIECES.length).toBeGreaterThan(100);
    // every row names its verified upstream path; names with no community source are not listed (#753 review)
    for (const [key, , upstreamPath] of AVAILABLE_PIECES) expect(upstreamPath).toBe(`packages/pieces/community/${key}`);
    for (const k of ["agent", "activity", "csv", "pdf"]) expect(keys.has(k), k).toBe(false);
    expect(AVAILABLE_PIECES_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses to run without the injected (guarded) fetch", () => {
    expect(() => resolveConnectorProvider({ kind: "piece_slack", token: "xoxb-1" })).toThrow(/egress-guarded fetch/);
    expect(() => resolveConnectorProvider({ kind: "piece_slack", token: null }, fakeFetch([]).fetchImpl)).toThrow(/credential/);
  });

  it("slack: send_channel_message posts through the injected fetch with the bearer token", async () => {
    const f = fakeFetch([{ status: 200, body: { ok: true, ts: "1.2" } }]);
    const p = resolveConnectorProvider({ kind: "piece_slack", token: "xoxb-secret" }, f.fetchImpl);
    const r = await p.invoke({ operation: "write", object: "send_channel_message", payload: { channel: "C123", text: "hi" } });
    expect(r.status).toBe(200);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(f.calls[0]!.method).toBe("POST");
    expect(f.calls[0]!.headers?.authorization).toBe("Bearer xoxb-secret");
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ channel: "C123", text: "hi" });
  });

  it("an action runs only under its own classification, and unknown actions and props are refused before any request", async () => {
    const f = fakeFetch([]);
    const p = resolveConnectorProvider({ kind: "piece_slack", token: "xoxb-1" }, f.fetchImpl);
    await expect(p.invoke({ operation: "read", object: "send_channel_message", payload: { channel: "C1", text: "x" } })).rejects.toThrow(/write action/);
    await expect(p.invoke({ operation: "write", object: "custom_api_call", payload: {} })).rejects.toThrow(/unknown action/);
    await expect(p.invoke({ operation: "write", object: "send_channel_message", payload: { channel: "C1", text: "x", url: "http://169.254.169.254" } })).rejects.toBeInstanceOf(ConnectorProviderError);
    await expect(p.invoke({ operation: "write", object: "send_channel_message", payload: { channel: "../x", text: "x" } })).rejects.toThrow(/invalid props/);
    expect(f.calls).toHaveLength(0);
  });

  it("slack ok:false is a provider error, ratelimited is a 429", async () => {
    const f = fakeFetch([{ status: 200, body: { ok: false, error: "channel_not_found" } }, { status: 200, body: { ok: false, error: "ratelimited" } }]);
    const p = resolveConnectorProvider({ kind: "piece_slack", token: "xoxb-1" }, f.fetchImpl);
    const args = { operation: "write" as const, object: "send_channel_message", payload: { channel: "C1", text: "x" } };
    await expect(p.invoke(args)).rejects.toThrow(/channel_not_found/);
    await expect(p.invoke(args)).rejects.toBeInstanceOf(ConnectorRateLimitError);
  });

  it("github: path segments are encoded, the API headers are set, upstream errors are scrubbed of the token", async () => {
    const f = fakeFetch([{ status: 200, body: { id: 1 } }, { status: 401, body: "bad credentials for ghp_secret" }]);
    const p = resolveConnectorProvider({ kind: "piece_github", token: "ghp_secret" }, f.fetchImpl);
    await p.invoke({ operation: "read", object: "get_pull_request", payload: { owner: "acme", repo: "a b", pullNumber: 7 } });
    expect(f.calls[0]!.url).toBe("https://api.github.com/repos/acme/a%20b/pulls/7");
    expect(f.calls[0]!.headers?.["x-github-api-version"]).toBe("2022-11-28");
    const err = await p.invoke({ operation: "read", object: "get_repository", payload: { owner: "acme", repo: "r" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorProviderError);
    expect((err as Error).message).not.toContain("ghp_secret");
    expect((err as ConnectorProviderError).status).toBe(401);
  });

  it("jira-cloud: the credential names the site host, adjudicated as a TYPED destination", async () => {
    expect(connectorCredentialHosts("piece_jira_cloud", JIRA)).toEqual({ typed: "https://acme.atlassian.net", compiled: [] });
    for (const site of ["http://acme.atlassian.net", "https://evil.example", "https://acme.atlassian.net/x", "https://u:p@acme.atlassian.net", "https://a.b.atlassian.net"]) {
      expect(() => parsePieceCredentialShape("piece_jira_cloud", JSON.stringify({ siteUrl: site, email: "a@b.example", apiToken: "t" })), site).toThrow(ConnectorProviderError);
    }
    const f = fakeFetch([{ status: 201, body: { id: "10" } }]);
    const p = resolveConnectorProvider({ kind: "piece_jira_cloud", token: JIRA }, f.fetchImpl);
    await p.invoke({ operation: "write", object: "add_comment", payload: { issueIdOrKey: "PLAT-1", comment: "done" } });
    expect(f.calls[0]!.url).toBe("https://acme.atlassian.net/rest/api/3/issue/PLAT-1/comment");
    expect(f.calls[0]!.headers?.authorization).toBe(`Basic ${Buffer.from("bot@acme.example:fake").toString("base64")}`);
  });

  it("google: the token exchange and the API call both go through the injected fetch; both hosts are compiled", async () => {
    expect(connectorCredentialHosts("piece_google_sheets", GOOGLE)).toEqual({
      typed: null,
      compiled: ["https://sheets.googleapis.com", "https://oauth2.googleapis.com/token"],
    });
    const f = fakeFetch([{ status: 200, body: { access_token: "ya29.at" } }, { status: 200, body: { updates: {} } }]);
    const p = resolveConnectorProvider({ kind: "piece_google_sheets", token: GOOGLE }, f.fetchImpl);
    await p.invoke({ operation: "write", object: "sheets_append_values", payload: { spreadsheetId: "S1", range: "A1:B2", values: [["a", 1]] } });
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://sheets.googleapis.com/v4/spreadsheets/S1/values/A1%3AB2:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS",
    ]);
    expect(f.calls[1]!.headers?.authorization).toBe("Bearer ya29.at");
  });

  it("google: a failed exchange is a 401 that names no secret", async () => {
    const f = fakeFetch([{ status: 400, body: { error: "invalid_grant", detail: "rtok-abc csecret-xyz" } }]);
    const p = resolveConnectorProvider({ kind: "piece_gmail", token: GOOGLE }, f.fetchImpl);
    const err = (await p.invoke({ operation: "read", object: "gmail_get_profile", payload: {} }).catch((e: unknown) => e)) as ConnectorProviderError;
    expect(err.status).toBe(401);
    expect(err.message).not.toMatch(/rtok-abc|csecret-xyz/);
    expect(f.calls).toHaveLength(1);
  });

  it("gmail: a header-injecting subject is refused; a valid send is base64url RFC 822", async () => {
    const f = fakeFetch([{ status: 200, body: { access_token: "at" } }, { status: 200, body: { id: "m1" } }]);
    const p = resolveConnectorProvider({ kind: "piece_gmail", token: GOOGLE }, f.fetchImpl);
    await expect(
      p.invoke({ operation: "write", object: "gmail_send_email", payload: { to: ["a@b.example"], subject: "x\r\nBcc: c@d.example", body: "b" } }),
    ).rejects.toThrow(/invalid props/);
    expect(f.calls).toHaveLength(0);
    await p.invoke({ operation: "write", object: "gmail_send_email", payload: { to: ["a@b.example"], subject: "Hello", body: "Body" } });
    const raw = Buffer.from((JSON.parse(f.calls[1]!.body!) as { raw: string }).raw, "base64url").toString("utf8");
    expect(raw).toContain("To: a@b.example\r\n");
    expect(raw.split("\r\n\r\n")[0]).not.toMatch(/Bcc/i);
  });
});
