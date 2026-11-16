/**
 * ADR-0343 — run a plain boot timer on ONE replica of the cluster.
 *
 * Most periodic work already runs through the ADR-0064 Scheduler, whose row lease makes it cluster-safe. Three older
 * timers did not: the audit anchor capture (boot.ts), the audit auto-prune (org-settings.ts) and the backup
 * verification (infra.ts). With N replicas each ran N times per interval, and two anchor flushes could push the same
 * anchor to the sink twice.
 *
 * A `ClusterLeader` is a leader lease on a Postgres SESSION advisory lock, held on one pinned pool connection for as
 * long as this process leads:
 *  - each tick asks `isLeader()`. A follower tries `pg_try_advisory_lock` (never a blocking wait) and becomes leader
 *    if the key is free; a leader proves its session is alive with `select 1` before doing work.
 *  - a dead leader (crash, OOM kill, network partition, database failover) loses its session, so the server frees the
 *    lock and the next follower tick takes over. After a failover the new primary never saw the old lock at all.
 *  - `release()` unlocks and returns the connection. It is called from the app's onClose, before the pool ends.
 *
 * The connection is taken lazily, on the first tick, so building an app (about a hundred test files do) holds none.
 *
 * The work a leader does must still tolerate a second run: in the window between a leader's session dying and its
 * process noticing, both may act once. The three timers are idempotent at that grain (a prune deletes what is already
 * past retention; an anchor records the chain head it reads; a verification appends a ledger row).
 *
 * OPEN SOURCE FIRST (ADR-0176): leader election on Postgres advisory locks is the standard pattern; a library for it
 * (e.g. an etcd or Kubernetes Lease client) would add a second coordination service that BYOC and air-gapped installs
 * do not have. Nothing to adopt for a few lines over `pg`.
 */
import type { Db } from "@regulait/db";

interface PinnedClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: (err?: Error | boolean) => void;
}

/** the leader keys of the three boot timers; they differ from every key in SESSION_LOCK_KEYS and audit-chain.ts */
export const CLUSTER_LEADER_KEYS = {
  auditAnchor: 0x5245_4741_4c41_4e43n, // "REGALANC"
  auditPrune: 0x5245_4741_4c50_524en, // "REGALPRN"
  backupVerify: 0x5245_4741_4c42_4b56n, // "REGALBKV"
} as const;

export class ClusterLeader {
  private client: PinnedClient | null = null;
  private closed = false;

  constructor(
    private readonly db: Db,
    private readonly key: bigint,
  ) {}

  /** true when this process holds the lease now; never throws (a database error reads as "not leader") */
  async isLeader(): Promise<boolean> {
    if (this.closed) return false;
    if (this.client) {
      try {
        await this.client.query("select 1");
        return true;
      } catch (e) {
        // the session is gone, and the lock with it: drop the connection and try again below
        this.drop(e);
      }
    }
    let c: PinnedClient;
    try {
      c = await (this.db.$client as { connect: () => Promise<PinnedClient> }).connect();
    } catch {
      return false;
    }
    try {
      const r = await c.query("select pg_catalog.pg_try_advisory_lock($1::bigint) as ok", [this.key.toString()]);
      if ((r.rows[0] as { ok?: boolean } | undefined)?.ok) {
        if (this.closed) {
          // released while we were acquiring
          await c.query("select pg_catalog.pg_advisory_unlock($1::bigint)", [this.key.toString()]).catch(() => {});
          c.release(true);
          return false;
        }
        this.client = c;
        return true;
      }
      c.release();
      return false;
    } catch (e) {
      c.release(e instanceof Error ? e : true);
      return false;
    }
  }

  /** stop leading: unlock and return the connection (destroy it if the unlock fails, which frees the lock) */
  async release(): Promise<void> {
    this.closed = true;
    const c = this.client;
    this.client = null;
    if (!c) return;
    try {
      await c.query("select pg_catalog.pg_advisory_unlock($1::bigint)", [this.key.toString()]);
      c.release();
    } catch (e) {
      c.release(e instanceof Error ? e : true);
    }
  }

  private drop(e: unknown) {
    const c = this.client;
    this.client = null;
    c?.release(e instanceof Error ? e : true);
  }
}

/** wrap a tick so it runs only on the leader; a follower's tick is a cheap no-op */
export function leaderOnly(leader: ClusterLeader, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    if (await leader.isLeader()) await fn();
  };
}
