/**
 * ADR-0190 decisions 4 and 6 — TAKING A PLACEMENT OFFER. The order is the
 * contract:
 *  1. only against a FRESH attestation for that profile at or above the
 *     required class (anything else is declined with its reason — never
 *     accepted and run lower: the no-fallback invariant);
 *  2. accept, start the sandbox, run the probes INSIDE IT;
 *  3. send the signed per-placement report and WAIT for the gateway;
 *  4. release the workload's input only on `release: true`. A mismatch kills
 *     the sandbox and quarantines this executor; a transient failure kills the
 *     sandbox too (an unconfirmed sandbox never gets input: fail closed).
 */
import { isolationClassRank, requiredReportProbes, stdioMacKey, type ExecutionOffer, type ExecutorProfileRef } from "@regulait/shared";
import type { SandboxBackend, SandboxHandle } from "./backend.js";
import type { SandboxTaskInput } from "./task-input.js";
import type { ChannelCredential } from "./channel-credential.js";
import { ExecutorClient, ExecutorHttpError } from "./client.js";
import { buildReport } from "./report.js";
import type { FreshAttestation } from "./self-test.js";
import { pumpStdio } from "./stdio-pump.js";

export interface OfferContext {
  backend: SandboxBackend;
  credential: ChannelCredential;
  client: ExecutorClient;
  profiles: ReadonlyMap<string, ExecutorProfileRef>;
  attestations: ReadonlyMap<string, FreshAttestation>;
  /** the sandboxes running now, by offer id (the handler adds and removes its own) */
  sandboxes: Map<string, SandboxHandle>;
  /** how many sandboxes may run at once (default 4) */
  capacity?: number;
  quarantined: () => boolean;
  /** a quarantine (or stop) is in force now: input is never released (review L3); defaults to `quarantined` */
  quarantineActive?: () => boolean;
  /** the gateway said `next: quarantined` (or `revoked`): the loop reacts */
  onSignal: (next: "quarantined" | "revoked" | "reannounce_required", why: string) => Promise<void>;
  now?: () => Date;
  log?: (m: string) => void;
  /** I4: the stdio session window (seconds; default 25) */
  stdioWindowSeconds?: number;
}

export type OfferOutcome =
  | { kind: "declined"; reason: "attestation_stale" | "class_below_required" | "capacity" | "quarantined" | "profile_unknown" }
  | { kind: "lost"; code: string | null }
  | { kind: "placed"; placementId: string; ended: "completed" | "failed" | "killed" | "limit_exceeded" }
  | { kind: "mismatch" }
  | { kind: "unconfirmed"; why: string };

/** the decision 4 check: which fresh attestation (if any) lets this executor take the offer */
export function admissibleAttestation(offer: ExecutionOffer, ctx: Pick<OfferContext, "attestations" | "now">): FreshAttestation | { reason: "attestation_stale" | "class_below_required" } {
  const a = ctx.attestations.get(offer.profileDigest);
  const now = (ctx.now ?? (() => new Date()))();
  if (!a || Date.parse(a.expiresAt) <= now.getTime()) return { reason: "attestation_stale" };
  if (a.cls !== "customer_declared" && isolationClassRank(a.cls) < isolationClassRank(offer.requiredClass)) return { reason: "class_below_required" };
  return a;
}

export async function handleOffer(offer: ExecutionOffer, ctx: OfferContext): Promise<OfferOutcome> {
  const decline = async (reason: Extract<OfferOutcome, { kind: "declined" }>["reason"]): Promise<OfferOutcome> => {
    try {
      await ctx.client.decline(offer.id, reason);
    } catch (e) {
      ctx.log?.(`offer ${offer.id}: decline (${reason}) not delivered: ${(e as Error).message}`);
    }
    return { kind: "declined", reason };
  };
  if (ctx.quarantined()) return decline("quarantined");
  const profile = ctx.profiles.get(offer.profileDigest);
  if (!profile) return decline("profile_unknown");
  const admissible = admissibleAttestation(offer, ctx);
  if ("reason" in admissible) return decline(admissible.reason);
  if (ctx.sandboxes.size >= (ctx.capacity ?? 4)) return decline("capacity");

  try {
    await ctx.client.accept(offer.id);
  } catch (e) {
    if (e instanceof ExecutorHttpError && e.next && e.next !== "ok") await ctx.onSignal(e.next, `accept ${offer.id}`);
    const code = e instanceof ExecutorHttpError ? e.code : null;
    ctx.log?.(`offer ${offer.id}: not accepted (${code ?? (e as Error).message})`);
    return { kind: "lost", code };
  }

  const desc = ctx.backend.describe();
  // I5: a profile with declared inputs (an engine task) starts only on its input: the manifest is fetched now, and the
  // backend writes and verifies every file before the sandbox exists (its digest goes into the report below)
  let task: SandboxTaskInput | undefined;
  if (profile.body.filesystem.inputs.length > 0) {
    try {
      const manifest = await ctx.client.inputManifest(offer.id);
      task = { manifest, open: (n) => ctx.client.inputFile(offer.id, n) };
    } catch (e) {
      const why = e instanceof ExecutorHttpError ? (e.code ?? String(e.status)) : (e as Error).message;
      ctx.log?.(`offer ${offer.id}: the task's input could not be read (${why}); nothing was started`);
      return { kind: "unconfirmed", why: `input:${why}` };
    }
  }
  let handle: SandboxHandle;
  try {
    handle = await ctx.backend.start(offer, profile.body, admissible.cls, task);
  } catch (e) {
    ctx.log?.(`offer ${offer.id}: the sandbox did not start (${(e as Error).message})`);
    return { kind: "unconfirmed", why: (e as Error).message };
  }
  ctx.sandboxes.set(offer.id, handle);
  try {
    const probes = await handle.probe(requiredReportProbes(profile.body, desc.backend, admissible.cls));
    const report = buildReport({
      kind: "placement",
      identifier: ctx.credential.identifier,
      backend: desc,
      profileDigest: offer.profileDigest,
      cls: admissible.cls,
      probes,
      offerId: offer.id,
      imageDigest: handle.imageDigest,
      ...(handle.inputSha256 !== undefined ? { inputSha256: handle.inputSha256 } : {}),
      ...(ctx.now ? { now: ctx.now } : {}),
    });
    let answer;
    try {
      answer = await ctx.client.report(offer.id, await ctx.credential.signReport(report));
    } catch (e) {
      // the gateway did not accept the report: the sandbox never receives input
      await handle.kill();
      ctx.sandboxes.delete(offer.id);
      if (e instanceof ExecutorHttpError && e.code === "execution_profile_mismatch") {
        ctx.log?.(`offer ${offer.id}: the gateway refused the per-placement report (${e.failures.map((f) => `${f.probe}:${f.code}`).join(", ") || "mismatch"}); sandbox killed`);
        await ctx.onSignal("quarantined", `report ${offer.id}: execution_profile_mismatch`);
        return { kind: "mismatch" };
      }
      if (e instanceof ExecutorHttpError && e.next && e.next !== "ok") await ctx.onSignal(e.next, `report ${offer.id}`);
      const why = e instanceof ExecutorHttpError ? (e.code ?? String(e.status)) : (e as Error).message;
      ctx.log?.(`offer ${offer.id}: report unconfirmed (${why}); sandbox killed`);
      return { kind: "unconfirmed", why };
    }
    if (answer.next !== "ok") await ctx.onSignal(answer.next, `report ${offer.id}`);
    // review L3: `release: true` alone is not enough. A gateway that also says this executor is no longer `ok`, or a
    // quarantine entered meanwhile, means the input is never released: the sandbox is killed and the end reported.
    if (answer.next !== "ok" || (ctx.quarantineActive ?? ctx.quarantined)()) {
      await handle.kill();
      ctx.sandboxes.delete(offer.id);
      try {
        await ctx.client.end(offer.id, "killed");
      } catch (e) {
        ctx.log?.(`offer ${offer.id}: end (killed) not delivered: ${(e as Error).message}`);
      }
      const why = answer.next !== "ok" ? `next: ${answer.next}` : "quarantined";
      ctx.log?.(`offer ${offer.id}: placed but input withheld (${why}); sandbox killed`);
      return { kind: "unconfirmed", why };
    }
    // I5: an engine task is an I4 stdio session (its `start` carries the task secret); one without stdio never runs
    const session = (offer.workloadKind === "mcp_stdio" && handle.stdio) || offer.workloadKind === "engine_worker";
    if (offer.workloadKind === "engine_worker" && !handle.stdio) {
      await handle.kill();
      ctx.sandboxes.delete(offer.id);
      try {
        await ctx.client.end(offer.id, "killed");
      } catch (e) {
        ctx.log?.(`offer ${offer.id}: end (killed) not delivered: ${(e as Error).message}`);
      }
      ctx.log?.(`offer ${offer.id}: an engine task's sandbox has no stdio channel; sandbox killed`);
      return { kind: "unconfirmed", why: "engine_task_no_stdio" };
    }
    if (session && !answer.stdioSecret) {
      // review M4: no session secret, no session: an unMACed window is never acted on (fail closed)
      await handle.kill();
      ctx.sandboxes.delete(offer.id);
      try {
        await ctx.client.end(offer.id, "killed");
      } catch (e) {
        ctx.log?.(`offer ${offer.id}: end (killed) not delivered: ${(e as Error).message}`);
      }
      ctx.log?.(`offer ${offer.id}: the gateway sent no stdio session secret; sandbox killed`);
      return { kind: "unconfirmed", why: "stdio_unkeyed" };
    }
    if (session) {
      // I4: the input is released by the stdio session, with the registered argv, once the gateway's `start` arrives.
      // Every real backend gives an mcp_stdio sandbox its stdio (the runsc backend always does); only the I3 fake
      // backend without a stdio responder has none, and is released as before.
      const how = await pumpStdio({ client: ctx.client, offerId: offer.id, handle, macKey: stdioMacKey(answer.stdioSecret!, offer.id), ...(ctx.stdioWindowSeconds !== undefined ? { windowSeconds: ctx.stdioWindowSeconds } : {}), ...(ctx.log ? { log: ctx.log } : {}) });
      ctx.log?.(`offer ${offer.id}: stdio session ended (${how})`);
    } else {
      await handle.releaseInput();
    }
    const ended = await handle.ended;
    ctx.sandboxes.delete(offer.id);
    try {
      await ctx.client.end(offer.id, ended);
    } catch (e) {
      ctx.log?.(`offer ${offer.id}: end (${ended}) not delivered: ${(e as Error).message}`);
    }
    return { kind: "placed", placementId: answer.placementId, ended };
  } catch (e) {
    // a probe or start failure after acceptance: nothing reaches the sandbox
    if (ctx.sandboxes.has(offer.id)) {
      await handle.kill().catch(() => undefined);
      ctx.sandboxes.delete(offer.id);
    }
    ctx.log?.(`offer ${offer.id}: ${(e as Error).message}; sandbox killed`);
    return { kind: "unconfirmed", why: (e as Error).message };
  }
}
