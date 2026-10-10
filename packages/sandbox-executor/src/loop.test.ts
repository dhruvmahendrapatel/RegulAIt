/**
 * ADR-0190 I3 — the executor loop against the in-memory fake gateway (which
 * checks every request proof and evaluates every report as the gateway
 * does):
 *  - announce → self-test (one canary per live profile, each killed) →
 *    stream → an offer taken against a fresh attestation → the sandbox is
 *    probed, reported, input released only after `release: true`, ended;
 *  - an offer above the attested class, or with a stale attestation, is
 *    DECLINED with its reason and no sandbox starts (no fallback);
 *  - a backend that lies in one probe: the per-placement report is refused,
 *    the sandbox is killed, input is never released, the executor is
 *    quarantined and declines everything until an admin re-enables it, then
 *    re-attests before taking work;
 *  - a revoked executor stops with what the admin must do; an unregistered
 *    identity stops; a transient failure is retried; a replayed proof is
 *    refused by the gateway.
 * The state table is pinned row by row.
 */
import { describe, expect, it } from "vitest";
import { executionProfileDigest, SHIPPED_EXECUTION_PROFILES, type ExecutionOffer } from "@regulait/shared";
import { ProofChannelCredential } from "./channel-credential.js";
import { ExecutorClient, type ExecutorHttp } from "./client.js";
import { FakeSandboxBackend } from "./fake-backend.js";
import { FakeExecutorGateway } from "./fake-gateway.js";
import { generateExecutorKey } from "./keys.js";
import { ExecutorFatalError, runExecutorLoop, transition, type ExecutorEvent, type ExecutorState } from "./loop.js";
import type { OfferOutcome } from "./offers.js";

const ISSUER = "http://gateway.test";
const ID = "spiffe://test.example/regulait/worker_runtime/exec-1";
const restricted = executionProfileDigest(SHIPPED_EXECUTION_PROFILES.restricted);
const microvm = executionProfileDigest(SHIPPED_EXECUTION_PROFILES["restricted-microvm"]);

async function rig(opts: { backend?: FakeSandboxBackend; gateway?: Partial<ConstructorParameters<typeof FakeExecutorGateway>[0]>; now?: () => Date; http?: (inner: ExecutorHttp) => ExecutorHttp } = {}) {
  const key = await generateExecutorKey();
  const backend = opts.backend ?? new FakeSandboxBackend();
  const gateway = new FakeExecutorGateway({ issuer: ISSUER, identifier: ID, publicJwk: key.publicJwk, backend: backend.describe().backend, classesDeclared: [...backend.describe().classes], ...(opts.now ? { now: opts.now } : {}), ...opts.gateway });
  const credential = new ProofChannelCredential({ identifier: ID, key, issuer: ISSUER, ...(opts.now ? { nowSeconds: () => Math.floor(opts.now!().getTime() / 1000) } : {}) });
  const inner = gateway.http();
  /** a test hook run before every stream request (the count of stream requests so far, 1-based) */
  const hooks: { onStream: ((n: number) => void) | null; streams: number } = { onStream: null, streams: 0 };
  const hooked: ExecutorHttp = (url, init) => {
    if (url.includes("/stream")) hooks.onStream?.(++hooks.streams);
    return inner(url, init);
  };
  const client = new ExecutorClient({ gatewayUrl: ISSUER, credential, http: opts.http ? opts.http(hooked) : hooked });
  const outcomes: Array<{ offer: ExecutionOffer; outcome: OfferOutcome }> = [];
  const logs: string[] = [];
  const run = (maxWindows: number, extra: Partial<Parameters<typeof runExecutorLoop>[0]> = {}) =>
    runExecutorLoop({
      client,
      backend,
      credential,
      maxWindows,
      streamWindowSeconds: 1,
      backoffMs: 1,
      maxBackoffMs: 2,
      sleep: async () => undefined,
      log: (m) => logs.push(m),
      onOffer: (offer, outcome) => outcomes.push({ offer, outcome }),
      ...(opts.now ? { now: opts.now } : {}),
      ...extra,
    });
  return { key, backend, gateway, credential, client, outcomes, logs, run, hooks };
}

describe("the executor loop", () => {
  it("announces, self-tests every profile it can serve (canaries killed), streams, and places an offer end to end", async () => {
    const r = await rig();
    r.gateway.offer({ requiredClass: "user_space_kernel", profileDigest: restricted });
    await r.run(1);
    expect(r.gateway.announced).toBe(true);
    // gvisor serves restricted and engine-worker (L2) but not restricted-microvm (L3)
    expect([...r.gateway.attestations.keys()].sort()).toEqual([restricted, executionProfileDigest(SHIPPED_EXECUTION_PROFILES["engine-worker"])].sort());
    const canaries = r.backend.sandboxes.filter((s) => s.kind === "canary");
    expect(canaries).toHaveLength(2);
    expect(canaries.every((c) => c.probed && c.killed && !c.released)).toBe(true);
    expect(r.outcomes).toHaveLength(1);
    expect(r.outcomes[0]!.outcome).toMatchObject({ kind: "placed", ended: "completed" });
    const placement = r.backend.sandboxes.find((s) => s.kind === "placement")!;
    expect(placement).toMatchObject({ probed: true, released: true, killed: false });
    const rec = [...r.gateway.offers.values()][0]!;
    expect(rec.status).toBe("ended");
    expect(rec.endOutcome).toBe("completed");
    expect(r.gateway.log.audit).toEqual(expect.arrayContaining(["executor-announced", "execution-placed"]));
    // the order the contract demands: accept, then report, then end; input released only after the 200
    expect(r.gateway.log.requests.filter((q) => q.path.startsWith("/offers")).map((q) => q.path.split("/")[3])).toEqual(["accept", "report", "end"]);
  });

  it("declines an offer above its attested class and one for a profile it has no fresh attestation for; no sandbox starts", async () => {
    const r = await rig();
    r.gateway.offer({ requiredClass: "microvm", profileDigest: restricted });
    r.gateway.offer({ requiredClass: "microvm", profileDigest: microvm });
    await r.run(1);
    expect(r.outcomes.map((o) => o.outcome)).toEqual(expect.arrayContaining([{ kind: "declined", reason: "class_below_required" }, { kind: "declined", reason: "attestation_stale" }]));
    expect(r.backend.sandboxes.filter((s) => s.kind === "placement")).toHaveLength(0);
    expect([...r.gateway.offers.values()].map((o) => o.status)).toEqual(["declined", "declined"]);
  });

  it("declines when its attestation has expired on the gateway's clock (never runs on a stale one)", async () => {
    let t = Date.parse("2026-10-10T10:00:00Z");
    const now = () => new Date(t);
    let streams = 0;
    const r = await rig({
      now,
      gateway: { attestationMaxAgeMinutes: 60 },
      // between the first and the second stream window three hours pass (the cadence is 24 h, so no re-test),
      // and an offer arrives: every attestation the executor holds has expired on the gateway's clock
      http: (inner) => (url, init) => {
        if (url.includes("/stream") && ++streams === 2) {
          t += 3 * 3600_000;
          r.gateway.offer({ requiredClass: "user_space_kernel", profileDigest: restricted });
        }
        return inner(url, init);
      },
    });
    await r.run(2, { selfTestIntervalMs: 24 * 3600_000 });
    expect(r.outcomes).toHaveLength(1);
    expect(r.outcomes[0]!.outcome).toEqual({ kind: "declined", reason: "attestation_stale" });
    expect(r.backend.sandboxes.filter((s) => s.kind === "placement")).toHaveLength(0);
    expect(r.gateway.log.audit.filter((a) => a.startsWith("executor-attestation-passed"))).toHaveLength(2);
  });

  it("a backend lying in one probe: report refused, sandbox killed, input never released, executor quarantined, re-enable re-attests", async () => {
    const backend = new FakeSandboxBackend();
    const r = await rig({ backend });
    // the self-test canaries are honest; the workload's own sandbox is not (the case decision 6's per-placement report exists for)
    backend.lie("egress_literal_address", (o) => ({ ...o, connected: true }), "placement");
    const bad = r.gateway.offer({ requiredClass: "user_space_kernel", profileDigest: restricted });
    await r.run(2, { selfTestIntervalMs: 24 * 3600_000 });
    const sandbox = backend.sandboxes.find((s) => s.offerId === bad.id)!;
    expect(sandbox).toMatchObject({ probed: true, released: false, killed: true });
    expect(r.gateway.offers.get(bad.id)!.status).toBe("mismatch");
    expect(r.gateway.offers.get(bad.id)!.failures).toContainEqual({ probe: "egress_literal_address", code: "egress_reached" });
    expect(r.gateway.status).toBe("quarantined");
    expect(r.gateway.log.audit).toContain("execution-profile-mismatch");
    expect(r.gateway.log.audit).toContain("executor-quarantined:execution_profile_mismatch");
    expect(r.outcomes.find((o) => o.offer.id === bad.id)!.outcome).toEqual({ kind: "mismatch" });
    expect(r.logs.some((l) => l.includes("state: streaming -> quarantined"))).toBe(true);

    // while quarantined: an offer (the gateway would not make one, but if it did) is declined `quarantined`
    r.gateway.status = "active";
    const during = r.gateway.offer({ requiredClass: "user_space_kernel", profileDigest: restricted });
    r.gateway.status = "quarantined";
    await r.run(1, { selfTestIntervalMs: 24 * 3600_000 });
    expect(r.outcomes.find((o) => o.offer.id === during.id)!.outcome).toEqual({ kind: "declined", reason: "quarantined" });

    // the admin re-enables while the executor holds its stream in quarantine; the backend is honest again: a full
    // self-test precedes any work, then work resumes
    backend.truthful();
    const before = backend.sandboxes.filter((s) => s.kind === "canary").length;
    let after: ExecutionOffer | null = null;
    r.hooks.streams = 0;
    let declinedBeforeRetest: ExecutionOffer | null = null;
    r.hooks.onStream = (n) => {
      if (n === 2) {
        r.gateway.reenable();
        // an offer in the same window as the re-enable: declined, because the self-test has not run yet
        declinedBeforeRetest = r.gateway.offer({ requiredClass: "user_space_kernel", profileDigest: restricted });
      }
      if (n === 3) after = r.gateway.offer({ requiredClass: "user_space_kernel", profileDigest: restricted });
    };
    await r.run(3, { selfTestIntervalMs: 24 * 3600_000 });
    expect(r.outcomes.find((o) => o.offer.id === declinedBeforeRetest!.id)!.outcome).toEqual({ kind: "declined", reason: "quarantined" });
    expect(r.logs.some((l) => l.includes("state: quarantined -> attesting"))).toBe(true);
    expect(backend.sandboxes.filter((s) => s.kind === "canary").length).toBeGreaterThan(before);
    expect(r.outcomes.find((o) => o.offer.id === after!.id)!.outcome).toMatchObject({ kind: "placed" });
  });

  it("a self-test that fails on this host is reported, recorded as failed, and the profile is not served", async () => {
    const backend = new FakeSandboxBackend().lie("proc_status", (o) => ({ ...o, seccomp: 0 }));
    const r = await rig({ backend });
    r.gateway.offer({ requiredClass: "user_space_kernel", profileDigest: restricted });
    await r.run(1);
    expect(r.gateway.attestations.size).toBe(0);
    expect(r.gateway.log.audit.filter((a) => a.startsWith("executor-attestation-failed"))).toHaveLength(2);
    expect(r.outcomes[0]!.outcome).toEqual({ kind: "declined", reason: "attestation_stale" });
    expect(r.logs.some((l) => l.includes("proc_status:seccomp_not_filtering"))).toBe(true);
  });

  it("stops with the admin's instruction when revoked, and when the identity is not registered as an executor", async () => {
    const r = await rig();
    r.gateway.revoke();
    await expect(r.run(5)).rejects.toThrow(ExecutorFatalError);
    await expect(r.run(5)).rejects.toThrow(/revoked/);
    const u = await rig();
    u.gateway.registered = false;
    await expect(u.run(5)).rejects.toThrow(/not registered/);
  });

  it("a transient failure is retried without a state change; the gateway refuses a replayed proof", async () => {
    const r = await rig();
    r.gateway.failNext = 2;
    await r.run(1);
    expect(r.gateway.announced).toBe(true);
    expect(r.logs.filter((l) => l.includes("->")).map((l) => l.split(" ")[1])).toEqual(["announcing", "attesting"]);
    expect(r.gateway.log.requests.filter((q) => q.status === 503)).toHaveLength(2);
    // replay: the same proof presented twice is refused the second time
    const url = `${ISSUER}/v1/executor-channel/stream`;
    const headers = await r.credential.authorizeRequest("GET", url, undefined);
    const first = await r.gateway.http()(url, { method: "GET", headers });
    const second = await r.gateway.http()(url, { method: "GET", headers });
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(JSON.parse(await second.text())).toEqual({ error: "proof_replayed" });
    // a proof for another body is refused
    const body = JSON.stringify({ reason: "capacity" });
    const h2 = await r.credential.authorizeRequest("POST", `${ISSUER}/v1/executor-channel/offers/00000000-0000-4000-8000-000000000009/decline`, body);
    const forged = await r.gateway.http()(`${ISSUER}/v1/executor-channel/offers/00000000-0000-4000-8000-000000000009/decline`, { method: "POST", headers: h2, body: JSON.stringify({ reason: "quarantined" }) });
    expect(JSON.parse(await forged.text())).toEqual({ error: "proof_body" });
  });

  it("the state table", () => {
    const rows: Array<[ExecutorState, ExecutorEvent, ExecutorState]> = [
      ["announcing", { kind: "announced", status: "active" }, "attesting"],
      ["announcing", { kind: "announced", status: "quarantined" }, "quarantined"],
      ["announcing", { kind: "announced", status: "revoked" }, "stopped"],
      ["announcing", { kind: "not_registered" }, "stopped"],
      ["announcing", { kind: "transient" }, "announcing"],
      ["attesting", { kind: "attested" }, "streaming"],
      ["attesting", { kind: "transient" }, "attesting"],
      ["attesting", { kind: "next", next: "quarantined" }, "quarantined"],
      ["streaming", { kind: "window_over", selfTestDue: false }, "streaming"],
      ["streaming", { kind: "window_over", selfTestDue: true }, "attesting"],
      ["streaming", { kind: "status", status: "quarantined" }, "quarantined"],
      ["streaming", { kind: "status", status: "revoked" }, "stopped"],
      ["streaming", { kind: "status", status: "active" }, "streaming"],
      ["streaming", { kind: "next", next: "reannounce_required" }, "announcing"],
      ["streaming", { kind: "next", next: "revoked" }, "stopped"],
      ["streaming", { kind: "next", next: "ok" }, "streaming"],
      ["quarantined", { kind: "status", status: "active" }, "attesting"],
      ["quarantined", { kind: "status", status: "quarantined" }, "quarantined"],
      ["quarantined", { kind: "window_over", selfTestDue: true }, "quarantined"],
      ["quarantined", { kind: "next", next: "revoked" }, "stopped"],
      ["stopped", { kind: "status", status: "active" }, "stopped"],
    ];
    for (const [from, event, to] of rows) expect(transition(from, event), `${from} + ${JSON.stringify(event)}`).toBe(to);
  });
});
