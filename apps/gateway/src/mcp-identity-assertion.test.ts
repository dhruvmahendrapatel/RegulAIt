/**
 * ADR-0188 S8 — the outbound identity assertion, without a database:
 *
 *  - the claim set is exactly the documented one (no email, no user id, `act` only for an agent);
 *  - the documented verification example (docs/api/MCP_IDENTITY_ASSERTION.md) is RUN, verbatim, against a live
 *    JWKS served in the real route's format (M-041: a procedure is not documentation until it has run), and it
 *    refuses a wrong audience, a replay, an expired assertion and one of our delegated access tokens;
 *  - the holder attaches an assertion only to a request message of the armed method, mints one per request,
 *    and refuses to send one to another origin;
 *  - the PATCH rules (`identityPropagationUpdate`): turning it on and moving the url while on are relaxations;
 *    a url move that says nothing turns it off.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import type { IdentitySigningKeyRow } from "@regulait/db";
import {
  canonicalMcpAudience,
  IDENTITY_ASSERTION_CLAIMS,
  IDENTITY_ASSERTION_HEADER,
  IDENTITY_ASSERTION_TTL_SECONDS,
  IDENTITY_ASSERTION_TYP,
} from "@regulait/shared";
import { jwksDocument } from "./identity-signing-keys.js";
import { pairwiseSubject } from "./delegated-token.js";
import {
  IdentityAssertionDestinationError,
  identityAssertionMiddleware,
  identityPropagationUpdate,
  jsonRpcRequestMethod,
  OutboundIdentity,
  outboundIdentityFor,
  refuseIdentityPropagationOnStdio,
  signIdentityAssertion,
} from "./mcp-identity-assertion.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.resolve(here, "../../../docs/api/MCP_IDENTITY_ASSERTION.md");
const AUD = "https://mcp.example.com/mcp";
const USER = "6f1c2c5e-6b7a-4c1e-9d55-1f0c0c0c0c01";
const CHAIN = [
  { identityId: "6f1c2c5e-6b7a-4c1e-9d55-1f0c0c0c0c02", identifier: "spiffe://regulait.internal/regulait/agent/lead" },
  { identityId: "6f1c2c5e-6b7a-4c1e-9d55-1f0c0c0c0c03", identifier: "spiffe://regulait.internal/regulait/agent/worker" },
];
const PAIRWISE_KEY = Buffer.alloc(32, 7); // synthetic

let privateKey: KeyObject;
let kid: string;
let jwksServer: http.Server;
let issuer: string;
let docDir: string;
let regulaitIdentityVerifier: (o: { issuer: string; audience: string }) => (a: string) => Promise<{ subject: string; actors: string[] }>;

const nowS = () => Math.floor(Date.now() / 1000);

/** the code block between the doc's verify-example markers, exactly as published */
function docVerifyExample(): string {
  const text = readFileSync(DOC, "utf8");
  const start = text.indexOf("<!-- verify-example:start -->");
  const end = text.indexOf("<!-- verify-example:end -->");
  if (start < 0 || end < start) throw new Error("the doc's verify-example markers are missing");
  const block = text.slice(start, end);
  const open = block.indexOf("```js\n");
  const close = block.lastIndexOf("```");
  return block.slice(open + "```js\n".length, close);
}

beforeAll(async () => {
  const pair = generateKeyPairSync("ed25519");
  privateKey = pair.privateKey;
  const j = pair.publicKey.export({ format: "jwk" });
  const publicJwk = { kty: "OKP" as const, crv: "Ed25519" as const, x: j.x! };
  kid = await calculateJwkThumbprint(publicJwk, "sha256");
  // the JWKS in the real route's format (the same function GET /.well-known/jwks.json serves)
  const row = { kid, publicJwk, activatedAt: new Date(), retiredAt: null, revokedAt: null, createdAt: new Date() } as unknown as IdentitySigningKeyRow;
  const body = JSON.stringify(jwksDocument([row]));
  jwksServer = http.createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") res.writeHead(200, { "content-type": "application/json" }).end(body);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => jwksServer.listen(0, "127.0.0.1", r));
  const addr = jwksServer.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  issuer = `http://127.0.0.1:${addr.port}`;
  // the doc's code, written verbatim beside the gateway's own dependencies so `import "jose"` resolves as it would
  // for an upstream that installed it
  docDir = mkdtempSync(path.resolve(here, "../node_modules/.s8-doc-example-"));
  const file = path.join(docDir, "verify.mjs");
  writeFileSync(file, docVerifyExample());
  ({ regulaitIdentityVerifier } = await import(pathToFileURL(file).href));
});

afterAll(async () => {
  await new Promise<void>((r) => jwksServer.close(() => r()));
  rmSync(docDir, { recursive: true, force: true });
});

const sign = (o: { actors?: typeof CHAIN | null; iat?: number; audience?: string; jti?: string } = {}) =>
  signIdentityAssertion({
    signer: { kid, privateKey },
    issuer,
    audience: o.audience ?? AUD,
    subject: pairwiseSubject(PAIRWISE_KEY, o.audience ?? AUD, USER),
    actors: o.actors === undefined ? CHAIN : o.actors,
    iat: o.iat ?? nowS(),
    ...(o.jti ? { jti: o.jti } : {}),
  });

describe("S8 — the claim set", () => {
  it("has exactly the documented claims; sub is pairwise; act nests root-first chain with the actor outermost", async () => {
    const { assertion, jti, exp, iat } = await sign();
    const header = decodeProtectedHeader(assertion);
    expect(header).toEqual({ alg: "EdDSA", typ: IDENTITY_ASSERTION_TYP, kid });
    const claims = decodeJwt(assertion);
    expect(Object.keys(claims).sort()).toEqual([...IDENTITY_ASSERTION_CLAIMS].sort());
    expect(claims).toMatchObject({ iss: issuer, aud: AUD, jti, iat, exp });
    expect(exp - iat).toBe(IDENTITY_ASSERTION_TTL_SECONDS);
    expect(claims.sub).toBe(pairwiseSubject(PAIRWISE_KEY, AUD, USER));
    expect(claims.sub).not.toBe(USER);
    expect(JSON.stringify(claims)).not.toContain(USER);
    expect(JSON.stringify(claims)).not.toContain("@");
    expect(claims.act).toEqual({ sub: CHAIN[1]!.identifier, act: { sub: CHAIN[0]!.identifier } });
    // the same person at another server is another subject (unlinkable)
    expect(pairwiseSubject(PAIRWISE_KEY, "https://other.example.com/mcp", USER)).not.toBe(claims.sub);
  });

  it("a person calling directly sends no act claim", async () => {
    const claims = decodeJwt((await sign({ actors: null })).assertion);
    expect(claims.act).toBeUndefined();
    expect(Object.keys(claims).sort()).toEqual(IDENTITY_ASSERTION_CLAIMS.filter((c) => c !== "act").sort());
  });

  it("the audience is the canonical server URI: no query, fragment or credentials, lower-case host, no default port", () => {
    expect(canonicalMcpAudience("https://MCP.Example.com:443/mcp?key=s3cret#x")).toBe("https://mcp.example.com/mcp");
    expect(canonicalMcpAudience("https://user:pw@mcp.example.com/a/b")).toBe("https://mcp.example.com/a/b");
    expect(canonicalMcpAudience("http://127.0.0.1:8123/")).toBe("http://127.0.0.1:8123/");
    expect(canonicalMcpAudience("stdio:files")).toBeNull();
    expect(canonicalMcpAudience("not a url")).toBeNull();
  });
});

describe("S8 — the documented verification example, run verbatim against a live JWKS", () => {
  it("accepts a fresh assertion and returns the pairwise subject and the chain, root first", async () => {
    const verify = regulaitIdentityVerifier({ issuer, audience: AUD });
    const { assertion } = await sign();
    await expect(verify(assertion)).resolves.toEqual({
      subject: pairwiseSubject(PAIRWISE_KEY, AUD, USER),
      actors: CHAIN.map((c) => c.identifier),
    });
  });

  it("refuses a replay, another audience, an expired assertion and a delegated access token", async () => {
    const verify = regulaitIdentityVerifier({ issuer, audience: AUD });
    const { assertion } = await sign();
    await verify(assertion);
    await expect(verify(assertion)).rejects.toThrow(/replayed/);
    await expect(verify((await sign({ audience: "https://other.example.com/mcp" })).assertion)).rejects.toThrow();
    await expect(verify((await sign({ iat: nowS() - 600 })).assertion)).rejects.toThrow();
    // one of our RFC 9068 access tokens, same key, same audience: refused by its typ
    const accessToken = await new SignJWT({ client_id: CHAIN[1]!.identifier, cnf: { jkt: "x" } })
      .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid })
      .setIssuer(issuer)
      .setAudience(AUD)
      .setSubject("pairwise")
      .setJti("j")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(privateKey);
    await expect(verify(accessToken)).rejects.toThrow();
  });
});

describe("S8 — the holder and the middleware", () => {
  const body = (method: string, id: number | null = 1) =>
    JSON.stringify(id === null ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", id, method, params: {} });

  it("recognises one JSON-RPC request message only", () => {
    expect(jsonRpcRequestMethod(body("tools/call"))).toBe("tools/call");
    expect(jsonRpcRequestMethod(body("notifications/initialized", null))).toBeNull();
    expect(jsonRpcRequestMethod(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/call" }]))).toBeNull();
    expect(jsonRpcRequestMethod("not json")).toBeNull();
    expect(jsonRpcRequestMethod(undefined)).toBeNull();
  });

  it("is created only for an opted-in server", () => {
    expect(outboundIdentityFor({ url: AUD, identityPropagation: "none" })).toBeNull();
    expect(outboundIdentityFor({ url: AUD })).toBeNull();
    expect(outboundIdentityFor({ url: `${AUD}?k=v`, identityPropagation: "signed_assertion" })!.audience).toBe(AUD);
  });

  it("sends nothing unarmed; once armed, one fresh assertion per request of that method only; strips a forged header", async () => {
    const seen: Array<{ url: string; method: string | null; header: string | null }> = [];
    const inner = async (input: string | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen.push({ url: String(input), method: jsonRpcRequestMethod(init?.body), header: h.get(IDENTITY_ASSERTION_HEADER) });
      return new Response("{}", { status: 200 });
    };
    const id = new OutboundIdentity(AUD);
    const fetch = identityAssertionMiddleware(id)(inner);
    const post = (b: string, headers: Record<string, string> = {}) => fetch(AUD, { method: "POST", body: b, headers });
    // unarmed: the pre-decision connect (initialize, a manifest sync) carries nothing, and a forged header is removed
    await post(body("initialize"), { [IDENTITY_ASSERTION_HEADER]: "forged" });
    await post(body("tools/list"));
    let n = 0;
    id.arm("tools/call", async () => `assertion-${++n}`);
    await post(body("notifications/initialized", null));
    await post(body("tools/call"));
    await post(body("tools/call", 2));
    await post(body("resources/read", 3));
    await fetch(AUD, { method: "GET" });
    expect(seen.map((s) => [s.method, s.header])).toEqual([
      ["initialize", null],
      ["tools/list", null],
      [null, null],
      ["tools/call", "assertion-1"],
      ["tools/call", "assertion-2"],
      ["resources/read", null],
      [null, null],
    ]);
    expect(id.sent).toBe(2);
    id.disarm();
    await post(body("tools/call", 4));
    expect(seen.at(-1)!.header).toBeNull();
  });

  it("never sends an assertion to another origin: the request is refused before it leaves", async () => {
    let calls = 0;
    const id = new OutboundIdentity(AUD);
    id.arm("tools/call", async () => "assertion");
    const fetch = identityAssertionMiddleware(id)(async () => {
      calls += 1;
      return new Response("{}");
    });
    await expect(fetch("https://elsewhere.example.com/mcp", { method: "POST", body: body("tools/call") })).rejects.toBeInstanceOf(
      IdentityAssertionDestinationError,
    );
    expect(calls).toBe(0);
  });
});

describe("S8 — the PATCH rules", () => {
  const on = { identityPropagation: "signed_assertion", url: AUD };
  const off = { identityPropagation: "none", url: AUD };
  it("turning it on is a relaxation; turning it off and unchanged values are not", () => {
    expect(identityPropagationUpdate(off, { identityPropagation: "signed_assertion" })).toEqual({
      write: "signed_assertion",
      relaxed: { identityPropagation: "signed_assertion" },
      resetByUrlMove: false,
    });
    expect(identityPropagationUpdate(on, { identityPropagation: "none" })).toEqual({ write: "none", relaxed: null, resetByUrlMove: false });
    expect(identityPropagationUpdate(on, { identityPropagation: "signed_assertion" })).toEqual({ write: null, relaxed: null, resetByUrlMove: false });
    expect(identityPropagationUpdate(off, {})).toEqual({ write: null, relaxed: null, resetByUrlMove: false });
  });

  it("the opt-in does not follow a url move: silent → off; kept on → a relaxation bound to the new url", () => {
    const moved = "https://new.example.com/mcp";
    expect(identityPropagationUpdate(on, { url: moved })).toEqual({ write: "none", relaxed: null, resetByUrlMove: true });
    expect(identityPropagationUpdate(on, { url: moved, identityPropagation: "signed_assertion" })).toEqual({
      write: null,
      relaxed: { identityPropagation: "signed_assertion" },
      resetByUrlMove: false,
    });
    expect(identityPropagationUpdate(off, { url: moved })).toEqual({ write: null, relaxed: null, resetByUrlMove: false });
    expect(identityPropagationUpdate(on, { url: AUD })).toEqual({ write: null, relaxed: null, resetByUrlMove: false });
  });

  it("a stdio server refuses it (409), and may still be set to none", () => {
    expect(refuseIdentityPropagationOnStdio(true, "signed_assertion")).toMatchObject({ status: 409, body: { error: "identity_propagation_unsupported" } });
    expect(refuseIdentityPropagationOnStdio(true, "none")).toBeNull();
    expect(refuseIdentityPropagationOnStdio(false, "signed_assertion")).toBeNull();
  });
});
