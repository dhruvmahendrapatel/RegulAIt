/**
 * ADR-0034 amendment #3 — THE DNS-REBIND SUITE.
 *
 * A test that asserts "https requests still work" proves nothing about the
 * window three consecutive security PRs disclosed. So this suite performs the
 * attack: a resolver stub that answers with a BENIGN, allow-listed address the
 * first time it is asked (the guard's check) and an ATTACKER address the second
 * time (the connect) — which is exactly the move a DNS rebind makes.
 *
 * It is end-to-end where that is possible. Two real TLS listeners with a real
 * certificate chain, bound to two different loopback addresses on the SAME
 * port, so "which address did the socket actually reach" is answered by the
 * SERVER that got the request, not by inspecting our own code:
 *
 *   127.0.0.1  the address the guard validates  — "benign"
 *   127.0.0.2  the address the second DNS answer names — "attacker"
 *
 * WHAT THE CONTROL PROVES. `unpinnedRequest` is the pre-amendment shape: check
 * the name, then let the connect path resolve it a SECOND time. Against the
 * identical stub it lands on 127.0.0.2 — the attacker's answer — while the
 * guard's verdict describes 127.0.0.1. That is the hole, reproduced, and it is
 * what makes the "after" assertions mean something.
 *
 * WHAT IT DOES NOT PROVE. The literal `169.254.169.254` case is asserted one
 * step short of the socket, because nothing can bind IMDS's address in a test.
 * For that one the proof is that the attacker's second answer is NEVER PRODUCED
 * AT ALL — the resolver stub is called exactly once — and the response comes
 * from the validated listener. The 127.0.0.2 tests are what carry the
 * socket-level claim; this one carries the "no second resolution happens"
 * claim. Both are stated as such below rather than blurred together.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import tls from "node:tls";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  checkEgress,
  createGuardedFetch,
  EgressBlockedError,
  EgressRedirectError,
  type EgressAllowEntry,
  type EgressResolver,
} from "./egress-guard.js";
import { pinnedLookup, resetPinnedAgents } from "./pinned-fetch.js";

const IMDS = "169.254.169.254";
const BENIGN = "127.0.0.1";
const ATTACKER = "127.0.0.2";

// ---------------------------------------------------------------------------
// a real certificate chain
// ---------------------------------------------------------------------------

interface Pki {
  caPem: string;
  cert: string;
  key: string;
  rogueCert: string;
  rogueKey: string;
}

function makePki(dir: string): Pki {
  const run = (args: string[]) =>
    execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });

  // a CA the test will teach the process to trust
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem",
    "-days", "2", "-subj", "/CN=RegulAIt Egress Test CA"]);
  // NOTE the omission: `mismatch.test` is deliberately NOT in here, because the
  // certificate-verification probe below asks for it and must be rejected.
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:pinned.test,DNS:multi.test\n");
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr",
    "-subj", "/CN=pinned.test"]);
  run(["x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
    "-out", "srv.pem", "-days", "2", "-extfile", "ext.cnf"]);

  // a certificate for `rogue.test` signed by a CA NOBODY trusts — the
  // rejectUnauthorized probe
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "rogue.key", "-out", "rogue.pem",
    "-days", "2", "-subj", "/CN=rogue.test", "-addext", "subjectAltName=DNS:rogue.test"]);

  return {
    caPem: readFileSync(join(dir, "ca.pem"), "utf8"),
    cert: readFileSync(join(dir, "srv.pem"), "utf8"),
    key: readFileSync(join(dir, "srv.key"), "utf8"),
    rogueCert: readFileSync(join(dir, "rogue.pem"), "utf8"),
    rogueKey: readFileSync(join(dir, "rogue.key"), "utf8"),
  };
}

// ---------------------------------------------------------------------------
// listeners
// ---------------------------------------------------------------------------

interface Hit {
  localAddress: string;
  servername: string | null;
  hostHeader: string;
  method: string;
  url: string;
  body: string;
}

const hits: Hit[] = [];

/** `TLSSocket.servername` is `string | false`; a plain http socket has none. */
function sniOf(socket: unknown): string | null {
  const name = (socket as tls.TLSSocket).servername;
  return typeof name === "string" ? name : null;
}

function handler(bind: string) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      hits.push({
        localAddress: bind,
        servername: sniOf(req.socket),
        hostHeader: req.headers.host ?? "",
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/redirect") {
        res.writeHead(302, { location: `http://${IMDS}/latest/meta-data/` });
        res.end();
        return;
      }
      if (path === "/gzip") {
        const payload = gzipSync(Buffer.from(JSON.stringify({ served_by: bind, gz: true })));
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        res.end(payload);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          served_by: bind,
          sni: sniOf(req.socket),
          host: req.headers.host ?? null,
          echo: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
  };
}

/** Bind the same port on several addresses — the shape the rebind test needs. */
async function listenAll(
  make: (bind: string) => http.Server,
  binds: string[],
): Promise<{ port: number; servers: http.Server[] }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = http.createServer();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, BENIGN, () => resolve((probe.address() as { port: number }).port));
    });
    await new Promise<void>((r) => probe.close(() => r()));
    const servers: http.Server[] = [];
    try {
      for (const bind of binds) {
        const s = make(bind);
        await new Promise<void>((resolve, reject) => {
          s.once("error", reject);
          s.listen(port, bind, () => resolve());
        });
        servers.push(s);
      }
      return { port, servers };
    } catch {
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    }
  }
  throw new Error("could not bind the same port on every loopback address");
}

// ---------------------------------------------------------------------------
// resolvers
// ---------------------------------------------------------------------------

/** THE ATTACK. Answer #1 is what the guard validates; answer #2 is what an
 * unpinned connect would use. `calls` is load-bearing: with pinning, answer #2
 * is never even asked for. */
function rebindingResolver(first: string, second: string) {
  const state = { calls: 0 };
  const resolve: EgressResolver = async () => {
    state.calls += 1;
    const address = state.calls === 1 ? first : second;
    return [{ address, family: 4 }];
  };
  return { resolve, state };
}

function fixedResolver(...addresses: string[]): EgressResolver {
  return async () => addresses.map((address) => ({ address, family: 4 }));
}

function allow(host: string, over: Partial<EgressAllowEntry> = {}): EgressAllowEntry {
  return { host, allowPrivateRanges: true, allowPlaintextHttp: true, ...over };
}

/**
 * THE CONTROL — the pre-amendment behaviour, reproduced exactly: validate the
 * NAME, then hand the connect path a resolver that runs again. Nothing here
 * touches `pinned-fetch.ts`; it exists so the "after" assertions are measured
 * against a harness that demonstrably reproduces the attack.
 */
async function unpinnedRequest(
  url: string,
  allowList: EgressAllowEntry[],
  resolve: EgressResolver,
): Promise<{ status: number; body: string; remoteAddress: string | undefined; validated: string[] }> {
  const decision = await checkEgress(url, { allowList, resolve });
  if (!decision.ok) throw new EgressBlockedError(decision);
  const u = new URL(decision.url);
  return await new Promise((resolveP, reject) => {
    const req = https.request(
      {
        host: decision.host,
        port: decision.port,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        agent: new https.Agent({ keepAlive: false }),
        // the second resolution — the whole bug, in one option
        lookup: ((hostname: string, options: { all?: boolean }, cb: (...a: never[]) => void) => {
          resolve(hostname).then(
            (rows) => {
              const done = cb as unknown as (e: null, a: unknown, f?: number) => void;
              if (options?.all) done(null, rows.map((r) => ({ address: r.address, family: r.family })));
              else done(null, rows[0]!.address, rows[0]!.family);
            },
            (err) => (cb as unknown as (e: unknown) => void)(err),
          );
        }) as unknown as https.RequestOptions["lookup"],
      },
      (res) => {
        const remoteAddress = res.socket.remoteAddress;
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () =>
          resolveP({ status: res.statusCode ?? 0, body, remoteAddress, validated: decision.addresses }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------

let dir: string;
let pki: Pki;
let tlsPort = 0;
let httpPort = 0;
let roguePort = 0;
let servers: http.Server[] = [];
let originalCa: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "regulait-egress-pki-"));
  pki = makePki(dir);

  // trust the test CA process-wide — no production code path is given a `ca`
  // override, precisely so this suite exercises the SAME trust configuration a
  // real deployment uses
  originalCa = tls.getCACertificates();
  tls.setDefaultCACertificates([...originalCa, pki.caPem]);

  const tlsServers = await listenAll(
    (bind) => https.createServer({ cert: pki.cert, key: pki.key }, handler(bind)) as unknown as http.Server,
    [BENIGN, ATTACKER],
  );
  tlsPort = tlsServers.port;

  const plain = await listenAll((bind) => http.createServer(handler(bind)), [BENIGN, ATTACKER]);
  httpPort = plain.port;

  const rogue = await listenAll(
    (bind) =>
      https.createServer({ cert: pki.rogueCert, key: pki.rogueKey }, handler(bind)) as unknown as http.Server,
    [BENIGN],
  );
  roguePort = rogue.port;

  servers = [...tlsServers.servers, ...plain.servers, ...rogue.servers];
});

afterAll(async () => {
  resetPinnedAgents();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  tls.setDefaultCACertificates(originalCa);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  hits.length = 0;
  // pooled sockets are keyed on the validated address set, but a fresh pool per
  // test keeps "which listener got the connection" unambiguous
  resetPinnedAgents();
});

const served = async (res: Response) => (await res.json()) as { served_by: string; sni: string | null; host: string | null; echo?: string };

// ---------------------------------------------------------------------------
// THE REBIND
// ---------------------------------------------------------------------------

describe("the DNS-rebind window, before and after", () => {
  it("CONTROL (unpinned): the connection follows the SECOND DNS answer, not the validated one", async () => {
    const { resolve, state } = rebindingResolver(BENIGN, ATTACKER);
    const out = await unpinnedRequest(
      `https://pinned.test:${tlsPort}/v1/models`,
      [allow("pinned.test")],
      resolve,
    );

    // the guard's verdict says one thing …
    expect(out.validated).toEqual([BENIGN]);
    // … and the socket went somewhere else entirely
    expect(out.remoteAddress).toBe(ATTACKER);
    expect(JSON.parse(out.body).served_by).toBe(ATTACKER);
    expect(hits.map((h) => h.localAddress)).toEqual([ATTACKER]);
    expect(state.calls).toBe(2);
  });

  it("PINNED: the connection follows the VALIDATED address and the rebind never lands", async () => {
    const { resolve, state } = rebindingResolver(BENIGN, ATTACKER);
    const guarded = createGuardedFetch({ allowList: [allow("pinned.test")], resolve });

    const res = await guarded(`https://pinned.test:${tlsPort}/v1/models`);
    const body = await served(res);

    expect(res.status).toBe(200);
    expect(body.served_by).toBe(BENIGN);
    expect(hits.map((h) => h.localAddress)).toEqual([BENIGN]);
    // the attacker's listener saw nothing at all
    expect(hits.some((h) => h.localAddress === ATTACKER)).toBe(false);
    // and the second answer was never even asked for — one resolution, total
    expect(state.calls).toBe(1);
  });

  it("PINNED: the rebind's second answer is IMDS — never produced, never dialled", async () => {
    // ONE STEP SHORT OF THE SOCKET, deliberately: nothing can bind 169.254.169.254
    // in a test. What is asserted is that the attacker's second answer is never
    // generated, so there is no address for a connect to use.
    const { resolve, state } = rebindingResolver(BENIGN, IMDS);
    const guarded = createGuardedFetch({ allowList: [allow("pinned.test")], resolve });

    const res = await guarded(`https://pinned.test:${tlsPort}/v1/chat/completions`);
    expect((await served(res)).served_by).toBe(BENIGN);
    expect(state.calls).toBe(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.localAddress).toBe(BENIGN);
  });

  it("PINNED (http): the plaintext path is not regressed — same pin, hostname still in Host", async () => {
    const { resolve, state } = rebindingResolver(BENIGN, ATTACKER);
    const guarded = createGuardedFetch({ allowList: [allow("pinned.test")], resolve });

    const res = await guarded(`http://pinned.test:${httpPort}/v1/models`);
    const body = await served(res);

    expect(body.served_by).toBe(BENIGN);
    expect(body.host).toBe(`pinned.test:${httpPort}`);
    expect(state.calls).toBe(1);
    expect(hits.some((h) => h.localAddress === ATTACKER)).toBe(false);
  });

  it("a pooled socket from an earlier pin is never reused for a different pin", async () => {
    // Node's Agent keys sockets on host:port and does NOT include `lookup`, so a
    // single shared agent would hand the second request the socket opened to
    // 127.0.0.1 — silently undoing the pin. This is the regression test for that.
    const first = createGuardedFetch({
      allowList: [allow("pinned.test")],
      resolve: fixedResolver(BENIGN),
    });
    const second = createGuardedFetch({
      allowList: [allow("pinned.test")],
      resolve: fixedResolver(ATTACKER),
    });

    expect((await served(await first(`https://pinned.test:${tlsPort}/a`))).served_by).toBe(BENIGN);
    expect((await served(await second(`https://pinned.test:${tlsPort}/b`))).served_by).toBe(ATTACKER);
    expect(hits.map((h) => h.localAddress)).toEqual([BENIGN, ATTACKER]);
  });
});

// ---------------------------------------------------------------------------
// still refused / still working
// ---------------------------------------------------------------------------

describe("the guard's existing verdicts still hold on the pinned transport", () => {
  it("a host whose ONLY addresses are blocked is still refused", async () => {
    const guarded = createGuardedFetch({
      allowList: [allow("metadata.evil.test", { allowPrivateRanges: false })],
      resolve: fixedResolver(IMDS),
    });
    await expect(guarded(`https://metadata.evil.test/latest/meta-data/`)).rejects.toThrow(
      EgressBlockedError,
    );
    expect(hits).toHaveLength(0);
  });

  it("split DNS: one good answer does not launder a blocked one", async () => {
    const guarded = createGuardedFetch({
      allowList: [allow("split.evil.test", { allowPrivateRanges: false })],
      resolve: fixedResolver("93.184.216.34", IMDS),
    });
    await expect(guarded("https://split.evil.test/v1")).rejects.toMatchObject({
      decision: { code: "blocked_address_range" },
    });
  });

  it("a host that is not allow-listed is still refused before any socket opens", async () => {
    const guarded = createGuardedFetch({ allowList: [], resolve: fixedResolver(BENIGN) });
    await expect(guarded(`https://pinned.test:${tlsPort}/v1`)).rejects.toMatchObject({
      decision: { code: "host_not_allowlisted" },
    });
    expect(hits).toHaveLength(0);
  });

  it("the allow-listed loopback endpoint still works end to end, over real TLS", async () => {
    const guarded = createGuardedFetch({
      allowList: [allow("pinned.test")],
      resolve: fixedResolver(BENIGN),
    });
    const res = await guarded(`https://pinned.test:${tlsPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    const body = await served(res);
    expect(res.status).toBe(200);
    expect(body.served_by).toBe(BENIGN);
    // SNI carried the HOSTNAME, not the pinned address
    expect(body.sni).toBe("pinned.test");
    expect(body.host).toBe(`pinned.test:${tlsPort}`);
    expect(body.echo).toBe(JSON.stringify({ model: "m", messages: [] }));
    expect(hits[0]!.method).toBe("POST");
    expect(hits[0]!.url).toBe("/v1/chat/completions");
  });

  it("redirects are still refused outright", async () => {
    const guarded = createGuardedFetch({
      allowList: [allow("pinned.test")],
      resolve: fixedResolver(BENIGN),
    });
    await expect(guarded(`https://pinned.test:${tlsPort}/redirect`)).rejects.toThrow(
      EgressRedirectError,
    );
  });

  it("a compressed response is still decoded, as it was under global fetch", async () => {
    const guarded = createGuardedFetch({
      allowList: [allow("pinned.test")],
      resolve: fixedResolver(BENIGN),
    });
    const res = await guarded(`https://pinned.test:${tlsPort}/gzip`);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual({ served_by: BENIGN, gz: true });
  });
});

// ---------------------------------------------------------------------------
// TLS identity — the thing the pin must NOT have bought itself out of
// ---------------------------------------------------------------------------

describe("certificate verification is still genuinely enforced", () => {
  it("a certificate that does not match the hostname still fails the connection", async () => {
    // the listener presents a cert for `pinned.test`; we ask for `mismatch.test`
    const guarded = createGuardedFetch({
      allowList: [allow("mismatch.test")],
      resolve: fixedResolver(BENIGN),
    });
    await expect(guarded(`https://mismatch.test:${tlsPort}/v1`)).rejects.toMatchObject({
      cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
    });
    // the TLS handshake failed, so the request never reached the application
    expect(hits).toHaveLength(0);
  });

  it("a certificate from an untrusted issuer still fails the connection", async () => {
    const guarded = createGuardedFetch({
      allowList: [allow("rogue.test")],
      resolve: fixedResolver(BENIGN),
    });
    await expect(guarded(`https://rogue.test:${roguePort}/v1`)).rejects.toMatchObject({
      cause: { code: expect.stringMatching(/SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT/) },
    });
    expect(hits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// multi-address semantics
// ---------------------------------------------------------------------------

describe("multi-address hosts pin to the whole validated set", () => {
  it("fails over to the second validated address when the first is unreachable", async () => {
    // 127.0.0.3 has nothing listening on this port; 127.0.0.1 does. Both were
    // validated, so both are legitimate connect candidates.
    const guarded = createGuardedFetch({
      allowList: [allow("multi.test")],
      resolve: fixedResolver("127.0.0.3", BENIGN),
    });
    const res = await guarded(`https://multi.test:${tlsPort}/v1`);
    expect((await served(res)).served_by).toBe(BENIGN);
  });

  it("fails closed when every validated address is unreachable — it does not fall back to DNS", async () => {
    const guarded = createGuardedFetch({
      allowList: [allow("multi.test")],
      resolve: fixedResolver("127.0.0.3", "127.0.0.4"),
    });
    await expect(guarded(`https://multi.test:${tlsPort}/v1`)).rejects.toThrow(/fetch failed/);
    expect(hits).toHaveLength(0);
  });

  it("pinnedLookup answers with every validated address when node asks for all", () => {
    const lookup = pinnedLookup(["203.0.113.7", "2001:db8::1"]);
    let out: unknown;
    lookup("whatever.test", { all: true }, (err: unknown, addrs: unknown) => {
      out = [err, addrs];
    });
    expect(out).toEqual([
      null,
      [
        { address: "203.0.113.7", family: 4 },
        { address: "2001:db8::1", family: 6 },
      ],
    ]);
  });

  it("pinnedLookup answers with the first validated address when node asks for one", () => {
    const lookup = pinnedLookup(["203.0.113.7", "203.0.113.8"]);
    let out: unknown;
    lookup("whatever.test", {}, (err: unknown, address: unknown, family: unknown) => {
      out = [err, address, family];
    });
    expect(out).toEqual([null, "203.0.113.7", 4]);
  });

  it("pinnedLookup honours the family filter and never invents an address", () => {
    const lookup = pinnedLookup(["203.0.113.7"]);
    let v6: unknown;
    lookup("whatever.test", { family: 6, all: true }, (err: unknown) => {
      v6 = err;
    });
    expect(v6).toMatchObject({ code: "ENOTFOUND" });

    let v4: unknown;
    lookup("whatever.test", { family: 4, all: true }, (err: unknown, addrs: unknown) => {
      v4 = [err, addrs];
    });
    expect(v4).toEqual([null, [{ address: "203.0.113.7", family: 4 }]]);
  });
});
