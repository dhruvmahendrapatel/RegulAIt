/**
 * Work that runs AFTER a response is sent, tracked per database handle so a
 * closing app (and a test) can wait for all of it.
 *
 * Used where a request must answer quickly but its consequence can take long:
 * an inbound Slack/Teams message (the platform wants an ack within seconds,
 * the governed turn can take minutes) and an approval decision a paused
 * builder turn was waiting on (the approver's request must not carry the
 * resumed turn — ADR-0173 review). A failure is logged; the work itself is
 * expected to audit its own outcome.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "@regulait/db";

const inflight = new WeakMap<object, Set<Promise<void>>>();

/** run `fn` after the current request completes (on a later tick), tracked */
export function scheduleBackgroundWork(db: Db, fn: () => Promise<void>, log?: FastifyBaseLogger): void {
  let set = inflight.get(db as object);
  if (!set) {
    set = new Set();
    inflight.set(db as object, set);
  }
  const tracked = set;
  const p: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
    .then(fn)
    .catch((err: unknown) => {
      log?.error({ err }, "background work failed");
    })
    .finally(() => tracked.delete(p));
  tracked.add(p);
}

/** wait until no tracked work is in flight for this database handle (work
 * scheduled by work that is draining is waited for too) */
export async function drainBackgroundWork(db: Db): Promise<void> {
  const set = inflight.get(db as object);
  while (set && set.size > 0) await Promise.allSettled([...set]);
}

/** how much tracked work is in flight (a response that returned while this is
 * non-zero is the proof the work runs after it) */
export function backgroundWorkInFlight(db: Db): number {
  return inflight.get(db as object)?.size ?? 0;
}
