/**
 * ADR-0190 I3 review fixes on the executor side, each with its negative control:
 *  - L1 / amendment V: the gateway URL is `https:`; plain `http:` only for a
 *    loopback host or behind the development flag (default off).
 *  - L2: the stream reader drops a line above 1 MiB, and a stream idle past
 *    its window plus slack.
 *  - L3: `release: true` with `next` other than `ok`, or with a quarantine in
 *    force, never releases input: the sandbox is killed and its end reported.
 */
import { describe, expect, it } from "vitest";
import { executionProfileDigest, SHIPPED_EXECUTION_PROFILES, type ExecutionOffer, type ExecutorStreamMessage } from "@regulait/shared";
import { ProofChannelCredential } from "./channel-credential.js";
import {
  checkGatewayUrl,
  EXECUTOR_STREAM_MAX_LINE_BYTES,
  ExecutorClient,
  ExecutorConfigError,
  ExecutorStreamLineTooLongError,
  ExecutorTimeoutError,
  fetchExecutorHttp,
  type ExecutorHttp,
} from "./client.js";
import { FakeSandboxBackend } from "./fake-backend.js";
import { probeGatewayReachable } from "./client.js";
import { generateExecutorKey } from "./keys.js";
import { handleOffer, type OfferContext } from "./offers.js";

const ID = "spiffe://test.example/regulait/worker_runtime/exec-1";
const restricted = SHIPPED_EXECUTION_PROFILES.restricted;
const RESTRICTED_DIGEST = executionProfileDigest(restricted);

async function credential(issuer = "https://gateway.test") {
  return new ProofChannelCredential({ identifier: ID, key: await generateExecutorKey(), issuer });
}

describe("the gateway URL (amendment V, review L1)", () => {
  it("https is accepted; plain http only on loopback or behind the development flag", () => {
    for (const ok of ["https://gateway.example.com", "https://10.0.0.5:8443/", "http://127.0.0.1:4419", "http://127.9.9.9", "http://localhost:3000", "http://[::1]:4419"]) {
      expect(() => checkGatewayUrl(ok), ok).not.toThrow();
    }
    for (const bad of ["http://gateway.example.com", "http://10.0.0.5:8080", "http://128.0.0.1", "http://localhost.evil.example", "ftp://gateway.example.com", "not a url", "https://user:pw@gateway.example.com"]) {
      expect(() => checkGatewayUrl(bad), bad).toThrow(ExecutorConfigError);
    }
    // the development flag opens plain http on any host (and nothing else)
    expect(() => checkGatewayUrl("http://gateway.example.com", true)).not.toThrow();
    expect(() => checkGatewayUrl("ftp://gateway.example.com", true)).toThrow(ExecutorConfigError);
  });

  it("the client refuses to be built against a plain-http remote gateway, unless the flag is set", async () => {
    const cred = await credential();
    expect(() => new ExecutorClient({ gatewayUrl: "http://gateway.example.com", credential: cred })).toThrow(ExecutorConfigError);
    expect(() => new ExecutorClient({ gatewayUrl: "http://gateway.example.com", credential: cred, allowInsecureHttp: true })).not.toThrow();
    expect(() => new ExecutorClient({ gatewayUrl: "https://gateway.example.com", credential: cred })).not.toThrow();
  });
});

describe("the stream reader's bounds (review L2)", () => {
  const hello = JSON.stringify({ type: "keepalive" });
  const seam =
    (lines: () => AsyncIterable<string>): ExecutorHttp =>
    async () => ({ status: 200, text: async () => "", lines });

  it("a line above 1 MiB drops the stream; the same stream with normal lines is read to its bye", async () => {
    const cred = await credential();
    const seen: ExecutorStreamMessage[] = [];
    const normal = new ExecutorClient({
      gatewayUrl: "https://gateway.test",
      credential: cred,
      http: seam(async function* () {
        yield hello;
        yield JSON.stringify({ type: "bye", reason: "window" });
      }),
    });
    await normal.stream(1, (m) => void seen.push(m));
    expect(seen.map((m) => m.type)).toEqual(["keepalive", "bye"]);

    const huge = new ExecutorClient({
      gatewayUrl: "https://gateway.test",
      credential: cred,
      http: seam(async function* () {
        yield hello;
        yield "x".repeat(EXECUTOR_STREAM_MAX_LINE_BYTES + 1);
        yield JSON.stringify({ type: "bye", reason: "window" });
      }),
    });
    const after: ExecutorStreamMessage[] = [];
    await expect(huge.stream(1, (m) => void after.push(m))).rejects.toThrow(ExecutorStreamLineTooLongError);
    expect(after.map((m) => m.type)).toEqual(["keepalive"]);
  });

  it("the fetch adapter refuses to buffer a line that never ends past 1 MiB", async () => {
    const chunk = new TextEncoder().encode("y".repeat(256 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ > 8) c.close();
        else c.enqueue(chunk);
      },
    });
    const http = fetchExecutorHttp((async () => new Response(body, { status: 200 })) as typeof fetch);
    const res = await http("https://gateway.test/x", { method: "GET", headers: {} });
    const read = async () => {
      for await (const _ of res.lines!()) void _;
    };
    await expect(read()).rejects.toThrow(ExecutorStreamLineTooLongError);
    // the negative control: lines under the cap are yielded
    const ok = fetchExecutorHttp((async () => new Response("a\nb\n", { status: 200 })) as typeof fetch);
    const out: string[] = [];
    for await (const l of (await ok("https://gateway.test/x", { method: "GET", headers: {} })).lines!()) out.push(l);
    expect(out).toEqual(["a", "b"]);
  });

  it("a stream silent past its window plus slack is dropped; one that keeps talking is not", async () => {
    const cred = await credential();
    let aborted = false;
    const silent = new ExecutorClient({
      gatewayUrl: "https://gateway.test",
      credential: cred,
      streamIdleSlackMs: 50,
      http: async (_url, init) => {
        init.signal?.addEventListener("abort", () => (aborted = true));
        return {
          status: 200,
          text: async () => "",
          lines: async function* () {
            yield hello;
            await new Promise(() => undefined); // never another line
          },
        };
      },
    });
    const t0 = Date.now();
    await expect(silent.stream(1, () => undefined)).rejects.toThrow(ExecutorTimeoutError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000);
    expect(aborted).toBe(true);
    // the negative control: lines every 300 ms for 1.5 s (longer than window + slack in total) are never "idle"
    const chatty = new ExecutorClient({
      gatewayUrl: "https://gateway.test",
      credential: cred,
      streamIdleSlackMs: 50,
      http: seam(async function* () {
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 300));
          yield hello;
        }
        yield JSON.stringify({ type: "bye", reason: "window" });
      }),
    });
    let n = 0;
    await chatty.stream(1, () => void n++);
    expect(n).toBe(6);
  });
});

describe("input is released only on release: true with next: ok and no quarantine (review L3)", () => {
  const offer: ExecutionOffer = {
    id: "4b0c1a3e-6a1e-4a4b-9a2c-0f4e5d6c7b8a",
    workloadKind: "mcp_stdio",
    requiredClass: "user_space_kernel",
    requiredBy: "workload_kind",
    enforcement: "enforce",
    profileDigest: RESTRICTED_DIGEST,
    imageDigest: `sha256:${"b".repeat(64)}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  async function run(o: { next: "ok" | "quarantined"; quarantineActive?: boolean }) {
    const backend = new FakeSandboxBackend();
    const ends: string[] = [];
    const signals: string[] = [];
    const client = {
      accept: async () => ({ offer, next: "ok" }),
      decline: async () => undefined,
      report: async () => ({ release: true, placementId: "7f0c1a3e-6a1e-4a4b-9a2c-0f4e5d6c7b8a", reportSha256: "a".repeat(64), next: o.next }),
      end: async (_id: string, outcome: string) => void ends.push(outcome),
    } as unknown as ExecutorClient;
    let quarantined = false;
    const ctx: OfferContext = {
      backend,
      credential: await credential(),
      client,
      profiles: new Map([[RESTRICTED_DIGEST, { digest: RESTRICTED_DIGEST, name: restricted.name, version: 1, minClass: "user_space_kernel", body: restricted }]]),
      attestations: new Map([[RESTRICTED_DIGEST, { profileDigest: RESTRICTED_DIGEST, cls: "user_space_kernel", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }]]),
      sandboxes: new Map(),
      quarantined: () => quarantined,
      // a quarantine arrives on the stream while the report is in flight
      quarantineActive: () => o.quarantineActive === true,
      onSignal: async (next) => {
        signals.push(next);
        quarantined = true;
      },
    };
    const outcome = await handleOffer(offer, ctx);
    return { outcome, sandbox: backend.sandboxes.find((s) => s.kind === "placement")!, ends, signals, ctx };
  }

  it("next: quarantined with release: true kills the sandbox and reports it killed; input never released", async () => {
    const r = await run({ next: "quarantined" });
    expect(r.outcome).toEqual({ kind: "unconfirmed", why: "next: quarantined" });
    expect(r.sandbox).toMatchObject({ released: false, killed: true });
    expect(r.ends).toEqual(["killed"]);
    expect(r.signals).toEqual(["quarantined"]);
    expect(r.ctx.sandboxes.size).toBe(0);
  });

  it("a quarantine in force when the answer arrives withholds input too", async () => {
    const r = await run({ next: "ok", quarantineActive: true });
    expect(r.outcome).toEqual({ kind: "unconfirmed", why: "quarantined" });
    expect(r.sandbox).toMatchObject({ released: false, killed: true });
    expect(r.ends).toEqual(["killed"]);
  });

  it("the negative control: next: ok and no quarantine releases input and reports the real end", async () => {
    const r = await run({ next: "ok" });
    expect(r.outcome).toMatchObject({ kind: "placed" });
    expect(r.sandbox).toMatchObject({ released: true });
    expect(r.ends).toEqual(["completed"]);
  });
});

describe("ADR-0190 I4 recheck: an unreachable gateway stops the executor at start, with the reason", () => {
  it("a TLS failure or no route is reported (main exits 2 on it); any HTTP answer is reachable", async () => {
    const tlsFailure = Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } });
    const seen: string[] = [];
    const failing = async (url: string) => {
      seen.push(url);
      throw tlsFailure;
    };
    expect(await probeGatewayReachable("https://gateway.example.test/base", failing)).toBe(
      "the gateway at https://gateway.example.test is not reachable over https from this executor (UNABLE_TO_VERIFY_LEAF_SIGNATURE)",
    );
    expect(seen).toEqual(["https://gateway.example.test/health"]);
    expect(await probeGatewayReachable("https://gateway.example.test", async () => ({ status: 503 }))).toBeNull();
    const noRoute = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    expect(await probeGatewayReachable("https://set-regulait-executor-gateway-url.invalid", async () => Promise.reject(noRoute))).toMatch(/not reachable over https .*ENOTFOUND/);
  });
});
