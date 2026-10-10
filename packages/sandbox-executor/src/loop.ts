/**
 * ADR-0190 I3 — THE EXECUTOR'S LIFE: an explicit state machine driven by the
 * gateway's one signal (`next`) and its stream, in the shape of ADR-0187's
 * runner loop (`packages/engine-runner/src/loop.ts`).
 *
 *   announcing   say what this executor is; learn its registration and the live profiles
 *   attesting    the self-test for every profile (a canary sandbox each); only a gateway
 *                `pass` makes a fresh attestation
 *   streaming    hold the outbound stream; take offers against fresh attestations; re-test
 *                on the cadence (hourly, under the 2 h freshness limit)
 *   quarantined  every sandbox killed, no offer taken; the stream is held to hear the
 *                admin's re-enable, which goes back through `attesting`
 *   stopped      revoked by an admin, or not registered: an admin must act
 *
 * Every refusal may carry `next` (`ok`, `quarantined`, `revoked`,
 * `reannounce_required`); the loop acts on that and on the stream's `status`
 * messages and nothing else. A network error, a 5xx, a timeout or a
 * malformed answer is transient: backed off and retried, never a state
 * change of its own.
 */
import type { AppliedIsolationKind, ExecutionOffer, ExecutorNext, ExecutorProfileRef, ExecutorView } from "@regulait/shared";
import type { SandboxBackend, SandboxHandle } from "./backend.js";
import type { ChannelCredential } from "./channel-credential.js";
import { ExecutorClient, ExecutorHttpError } from "./client.js";
import { handleOffer, type OfferOutcome } from "./offers.js";
import { Quarantine } from "./quarantine.js";
import { indexProfiles, runSelfTests, type FreshAttestation } from "./self-test.js";

export const EXECUTOR_STATES = ["announcing", "attesting", "streaming", "quarantined", "stopped"] as const;
export type ExecutorState = (typeof EXECUTOR_STATES)[number];

export type ExecutorEvent =
  | { kind: "next"; next: ExecutorNext }
  | { kind: "announced"; status: ExecutorView["status"] }
  | { kind: "attested" }
  | { kind: "window_over"; selfTestDue: boolean }
  | { kind: "status"; status: ExecutorView["status"] }
  | { kind: "transient" }
  | { kind: "not_registered" };

/** THE TABLE. Anything not named keeps the state. */
export function transition(state: ExecutorState, event: ExecutorEvent): ExecutorState {
  if (state === "stopped") return "stopped";
  switch (event.kind) {
    case "not_registered":
      return "stopped";
    case "announced":
      return event.status === "revoked" ? "stopped" : event.status === "quarantined" ? "quarantined" : "attesting";
    case "attested":
      return state === "attesting" ? "streaming" : state;
    case "window_over":
      return state === "streaming" && event.selfTestDue ? "attesting" : state;
    case "transient":
      return state;
    case "status":
      if (event.status === "revoked") return "stopped";
      if (event.status === "quarantined") return "quarantined";
      // re-enabled: a full self-test before any work
      return state === "quarantined" ? "attesting" : state;
    case "next":
      switch (event.next) {
        case "ok":
          return state;
        case "quarantined":
          return "quarantined";
        case "revoked":
          return "stopped";
        case "reannounce_required":
          return "announcing";
      }
  }
}

export class ExecutorFatalError extends Error {}

export interface ExecutorLoopOptions {
  client: ExecutorClient;
  backend: SandboxBackend;
  credential: ChannelCredential;
  /** the stream window the executor asks for (seconds, default 25) */
  streamWindowSeconds?: number;
  /** the self-test cadence (default 60 min; the gateway's freshness limit is 2 h at most) */
  selfTestIntervalMs?: number;
  capacity?: number;
  /** first wait after a transient failure, doubling up to maxBackoffMs (defaults 2 s and 5 min) */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** stop after this many stream windows (tests); unset = forever */
  maxWindows?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
  /** tests: every offer's outcome */
  onOffer?: (offer: ExecutionOffer, outcome: OfferOutcome) => void;
}

const MESSAGE_NOT_REGISTERED =
  "this executor's identity is not registered as an executor: register it on the Engines page (POST /v1/executors with its worker_runtime identity) and restart";
const MESSAGE_REVOKED = "the gateway revoked this executor: register a new executor (a new identity and key) and restart";

/** run until stopped; throws `ExecutorFatalError` with what an admin must do */
export async function runExecutorLoop(opts: ExecutorLoopOptions): Promise<void> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => new Date());
  const base = opts.backoffMs ?? 2_000;
  const max = opts.maxBackoffMs ?? 300_000;
  const cadence = opts.selfTestIntervalMs ?? 60 * 60_000;
  const window = opts.streamWindowSeconds ?? 25;
  const log = opts.log;

  let state: ExecutorState = "announcing";
  let view: ExecutorView | null = null;
  let profiles: Map<string, ExecutorProfileRef> = new Map();
  let classesDeclared: readonly AppliedIsolationKind[] = [];
  const attestations = new Map<string, FreshAttestation>();
  const sandboxes = new Map<string, SandboxHandle>();
  const quarantine = new Quarantine(log);
  const inFlight = new Set<Promise<unknown>>();
  let lastSelfTestAt: number | null = null;
  let backoff = base;
  let windows = 0;
  let stopMessage = MESSAGE_NOT_REGISTERED;

  const current = (): ExecutorState => state;
  const go = async (event: ExecutorEvent, why?: string) => {
    const from = state;
    state = transition(state, event);
    if (from !== state) log?.(`state: ${from} -> ${state}${why ? ` (${why})` : ""}`);
    if (state === "quarantined" && !quarantine.active) {
      await quarantine.enter(view?.quarantineCode ?? "execution_profile_mismatch", sandboxes.entries());
      sandboxes.clear();
    }
    if (state === "stopped") {
      stopMessage = event.kind === "not_registered" ? MESSAGE_NOT_REGISTERED : MESSAGE_REVOKED;
      await quarantine.enter("admin", sandboxes.entries());
      sandboxes.clear();
    }
    if (from === "quarantined" && state !== "quarantined" && state !== "stopped") quarantine.clear();
  };
  const eventOf = (e: unknown): ExecutorEvent => {
    if (e instanceof ExecutorHttpError) {
      if (e.next) return { kind: "next", next: e.next };
      if (e.status === 401 && e.code === "executor_not_registered") return { kind: "not_registered" };
      if (e.status === 401 && e.code === "identity_revoked") return { kind: "next", next: "revoked" };
    }
    return { kind: "transient" };
  };
  const whyOf = (e: unknown) => (e instanceof ExecutorHttpError ? (e.code ?? String(e.status)) : (e as Error).message);
  const backOff = async () => {
    await sleep(backoff);
    backoff = Math.min(max, backoff * 2);
  };
  const applyView = (v: ExecutorView, refs: readonly ExecutorProfileRef[]) => {
    view = v;
    classesDeclared = v.classesDeclared;
    profiles = indexProfiles(refs, log);
  };
  const offerCtx = () => ({
    backend: opts.backend,
    credential: opts.credential,
    client: opts.client,
    profiles,
    attestations,
    sandboxes,
    ...(opts.capacity !== undefined ? { capacity: opts.capacity } : {}),
    quarantined: () => quarantine.active || current() !== "streaming",
    onSignal: async (next: "quarantined" | "revoked" | "reannounce_required", why: string) => go({ kind: "next", next }, why),
    now,
    ...(log ? { log } : {}),
  });

  while (current() !== "stopped") {
    switch (current()) {
      case "announcing": {
        try {
          const d = opts.backend.describe();
          const a = await opts.client.announce({ backend: d.backend, runtimeVersion: d.runtimeVersion, classesDeclared: [...d.classes] });
          applyView(a.executor, a.profiles);
          backoff = base;
          if (a.next !== "ok") await go({ kind: "next", next: a.next }, "announce");
          else await go({ kind: "announced", status: a.executor.status }, `registered as ${a.executor.name} (${a.executor.backend})`);
        } catch (e) {
          const ev = eventOf(e);
          await go(ev, whyOf(e));
          if (ev.kind === "transient") await backOff();
        }
        break;
      }
      case "attesting": {
        try {
          const r = await runSelfTests({ backend: opts.backend, credential: opts.credential, client: opts.client, profiles, classesDeclared, now, ...(log ? { log } : {}) });
          attestations.clear();
          for (const f of r.fresh) attestations.set(f.profileDigest, f);
          lastSelfTestAt = now().getTime();
          backoff = base;
          if (r.next !== "ok") await go({ kind: "next", next: r.next }, "self-test");
          else await go({ kind: "attested" }, `${r.fresh.length} fresh attestation(s)`);
        } catch (e) {
          const ev = eventOf(e);
          await go(ev, whyOf(e));
          if (ev.kind === "transient") await backOff();
        }
        break;
      }
      case "streaming":
      case "quarantined": {
        try {
          await opts.client.stream(window, async (m) => {
            switch (m.type) {
              case "hello":
                applyView(m.executor, m.profiles);
                // the hello restates the status: act on it only when it differs from what this loop believes
                if ((m.executor.status === "quarantined") !== quarantine.active || m.executor.status === "revoked") {
                  await go({ kind: "status", status: m.executor.status }, "hello");
                }
                break;
              case "offer": {
                const p = handleOffer(m.offer, offerCtx()).then((o) => opts.onOffer?.(m.offer, o));
                inFlight.add(p);
                void p.finally(() => inFlight.delete(p));
                break;
              }
              case "status":
                if (view) view = { ...view, status: m.status, quarantineCode: m.quarantineCode };
                await go({ kind: "status", status: m.status }, `status ${m.status}${m.quarantineCode ? ` (${m.quarantineCode})` : ""}`);
                break;
              case "keepalive":
              case "bye":
                break;
            }
          });
          backoff = base;
          windows += 1;
          const due = lastSelfTestAt === null || now().getTime() - lastSelfTestAt >= cadence;
          await go({ kind: "window_over", selfTestDue: due }, due ? "self-test due" : undefined);
        } catch (e) {
          const ev = eventOf(e);
          await go(ev, whyOf(e));
          if (ev.kind === "transient") await backOff();
        }
        if (opts.maxWindows !== undefined && windows >= opts.maxWindows) {
          await Promise.allSettled([...inFlight]);
          return;
        }
        break;
      }
    }
  }
  await Promise.allSettled([...inFlight]);
  throw new ExecutorFatalError(stopMessage);
}
