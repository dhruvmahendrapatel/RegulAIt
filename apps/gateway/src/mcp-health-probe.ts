/**
 * ACTIVE upstream health probing — the half of ADR-0126 that only learned from
 * traffic.
 *
 * ── THE GAP THIS CLOSES, PRECISELY ─────────────────────────────────────────
 * ADR-0126's breaker is *passive*: it learns an upstream is dead from real
 * requests failing. That is the right primary mechanism — it measures exactly
 * what users experience — but it has one consequence nobody chose: **the first
 * user after an outage always pays the full connect deadline.** On a quiet
 * deployment that "first user" can be the customer in a demo, and the breaker's
 * whole value (an immediate, named refusal) only starts on the *second* one.
 *
 * So this sweep makes the platform the first caller instead. Nothing else about
 * the breaker changes: this is a new way for it to LEARN, not a second
 * mechanism, and not a control.
 *
 * ── IT IS NOT A CONTROL, AND ENFORCEMENT DOES NOT DEPEND ON IT ─────────────
 * ADR-0064's rule for every sweep in this product. The breaker consulted on the
 * request path is the enforcement; with the scheduler off — which is the shipped
 * default — behaviour is byte-identical to before this file existed, because the
 * breaker still learns passively from traffic. This sweep only changes WHEN it
 * learns.
 *
 * ── THE DISTINCTION THAT MATTERS MOST HERE ─────────────────────────────────
 * **Our own refusals must never open a breaker.** `connectUpstream` runs two
 * gates before it opens a socket: ADR-0097 admission and ADR-0043 egress. Both
 * throw. Counting either as an upstream failure would be actively misleading:
 *
 *   - an AIR-GAPPED install refuses every outbound host by design, so a probe
 *     that treated egress refusals as failures would report **every** upstream
 *     as circuit-broken, on a deployment where nothing is wrong;
 *   - a HELD server (a dirty manifest under `enforce`) is an adjudication we
 *     made, and "circuit broken" would send an operator hunting a network fault
 *     instead of reading the manifest finding.
 *
 * A breaker must describe the UPSTREAM's health, never ours. Both are therefore
 * counted separately and the breaker is left untouched — the same distinction
 * `mcp-admission-rescan.ts` makes when it says unreachable is not a verdict.
 *
 * ── WHY IT STILL REUSES `breakerAdmits` AFTER FILTERING IN SQL ─────────────
 * A probe against an OPEN breaker is the recovery path, and recovery has a
 * thundering-herd problem the breaker already solved with a one-winner election
 * (a conditional UPDATE on `breaker_opened_at`). Calling `breakerAdmits` means
 * this sweep enters that election like any other caller: it probes a half-open
 * upstream only if it wins, and fast-skips if a real request got there first.
 * Re-implementing the check here would have been a second copy of the one piece
 * of concurrency logic in that file.
 *
 * The SQL filter above and this call are not redundant: the filter decides which
 * rows are worth SELECTING (a row in cooldown cannot be probed by anyone, so
 * selecting it would spend a bounded pass's budget on a certain skip), while
 * `breakerAdmits` decides whether THIS caller may probe a half-open one. Only
 * the second can settle a race, and only the first can stop the budget being
 * wasted.
 *
 * ── THE CAP NEEDS A CURSOR, AND THE FIRST VERSION DID NOT HAVE ONE ────────
 * A pass is bounded, and broken upstreams are probed FIRST — recovery is the
 * time-critical half, since a still-open breaker is refusing live traffic while
 * a healthy-but-unprobed one is costing nobody anything.
 *
 * **The first version of this file ordered the rest by NAME, and that was a
 * defect (AER-037).** With more than `limit` servers registered, the order was
 * CONSTANT, so every five-minute pass probed the same lexicographically first
 * cohort and the tail was never actively probed at all — retaining exactly the
 * "first user discovers the outage" behaviour this file exists to remove, on a
 * deployment whose scheduler page looked green. `capped: true` reported the
 * truncation honestly and said nothing about progress, which is the part that
 * mattered. The original note claimed the cap "degrades to the status quo": true
 * of any one server, false of the ESTATE, because the same servers degraded
 * every time.
 *
 * So the order is now the open-breaker cohort first, then LEAST RECENTLY
 * CONSIDERED (`last_health_probe_at asc nulls first`, migration 0118), which
 * makes the cap a fair round-robin: every registered upstream is reached within
 * ceil(n / limit) passes regardless of its name, and the recovery cohort still
 * jumps the queue.
 *
 * The cursor is stamped when a row is SELECTED, not after it answers — in the
 * same statement that selects it, and that statement runs only once an
 * advisory transaction lock shared by every claim is held
 * (`claimHealthProbeBatch`). Three things follow, and all three are wanted: a
 * row whose probe fails still moves to the back (its breaker, not this cursor,
 * is what keeps it urgent); two concurrent passes claim DISJOINT sets, because
 * a claim's snapshot is taken only after every earlier claim has committed its
 * stamps — `skip locked` alone did not give that, since a pass whose snapshot
 * predated the other's commit re-claimed its rows once their locks were gone
 * (the test file drives that exact interleaving); and a pass that dies half
 * way leaves its rows late rather than starved.
 */
import { asc, eq, inArray, mcpServers, sql, type Db, type SQL } from "@regulait/db";
import type { McpUpstreamTransport } from "@regulait/shared";
import { McpAdmissionHeldError } from "./mcp-admission.js";
import { McpEgressBlockedError } from "./mcp-egress.js";
import { connectUpstream } from "./mcp-proxy.js";
import { timeouts } from "./timeouts.js";
import {
  breakerAdmits,
  breakerConfig,
  breakerStateOf,
  recordUpstreamFailure,
  recordUpstreamSuccess,
  type BreakerRow,
} from "./upstream-breaker.js";

/** How many upstreams one pass will probe. A connect is cheap next to the
 *  rescan's manifest fetch, so this is generous; it exists to bound the pass,
 *  not to ration it. */
export const HEALTH_PROBE_BATCH_LIMIT = 50;

export interface McpHealthProbeResult {
  /**
   * upstreams a probe could actually be attempted against right now — i.e. the
   * breaker is closed, or it is open and the cooldown has elapsed.
   *
   * NOT "every registered upstream". A server whose breaker is open and still
   * inside its cooldown cannot be probed by anybody (that is what the cooldown
   * is), so selecting it would spend a bounded pass's budget on a row that can
   * only be skipped — a second way to starve the tail, on top of AER-037's. They
   * are excluded from selection and counted as `inCooldown` instead.
   */
  eligible: number;
  /** open breakers still inside their cooldown: not probed by anyone, by design,
   *  and deliberately not counted against the pass's budget */
  inCooldown: number;
  /** how many this pass actually attempted a connect against */
  probed: number;
  /** answered the handshake AND a real `tools/list` — AER-022: a handshake alone
   *  is not health, and accepting one as health let this sweep close a breaker
   *  that tool failures had opened */
  healthy: number;
  /** a genuine upstream failure; the breaker was told */
  failed: number;
  /** selected, but the breaker refused at the moment of probing — in practice
   *  only the half-open race (a real request won the election first), since rows
   *  still inside their cooldown are no longer selected at all */
  skippedCircuitOpen: number;
  /** OUR refusal (admission-held or egress-blocked). The breaker was NOT told:
   *  these say nothing about the upstream's health. */
  skippedOurRefusal: number;
  /** names of upstreams whose breaker this pass OPENED */
  opened: string[];
  /** names of upstreams whose breaker this pass CLOSED */
  recovered: string[];
  /** true when more upstreams were eligible than the cap allowed */
  capped: boolean;
  /** how many eligible upstreams this pass did NOT reach. With the rotation
   *  below they are the ones the NEXT passes take first, so this is a backlog
   *  and no longer a permanently starved tail — but an operator still wants the
   *  number, because a backlog that never shrinks means the cap is too low for
   *  the estate and the interval. */
  backlog: number;
  /** eligible upstreams that have never been actively probed at all. Distinct
   *  from `backlog`: a steady backlog on a fully-rotated estate is fine, while a
   *  `neverProbed` that does not fall is the AER-037 symptom returning. */
  neverProbed: number;
  /** the oldest rotation cursor among eligible upstreams BEFORE this pass — i.e.
   *  how stale the least-recently-considered upstream had become. null when at
   *  least one has never been probed (`neverProbed` says how many). */
  oldestProbeAt: Date | null;
}

type ProbeRow = BreakerRow & {
  url: string;
  allowPrivateRanges: boolean | null;
  /** ADR-0185 G4: so an SSE upstream is probed over SSE */
  transport: McpUpstreamTransport;
  lastHealthProbeAt: Date | null;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The advisory-lock key every health-probe CLAIM serializes on. One global key,
 * because the rotation is one global queue. Arbitrary but fixed, and distinct
 * from the audit chain's `AUDIT_CHAIN_LOCK_KEY` (6_000_000_060); the `037` is
 * the finding.
 */
export const HEALTH_PROBE_CLAIM_LOCK_KEY = 6_000_000_037;

/**
 * Which rows a probe is POSSIBLE against right now: the breaker is closed, or
 * it is open and its cooldown has elapsed — the same rule `breakerStateOf`
 * applies, expressed in SQL so a pass can exclude the rest rather than select
 * and skip them.
 */
export function healthProbeEligibility(): SQL {
  const cooldown = sql`make_interval(secs => ${breakerConfig().cooldownMs / 1000})`;
  // ADR-0185 G4 — A STDIO UPSTREAM IS NEVER PROBED. A probe of one is not a
  // look at a remote server's health: it STARTS a local process, on a timer,
  // with nobody having asked for it, and takes one of the host's few stdio
  // process slots from a real request. Its breaker still learns passively
  // from real traffic, which is the enforcement anyway (this sweep only
  // changes when the breaker learns).
  return sql`(${mcpServers.transport} <> 'stdio' and (${mcpServers.breakerOpenedAt} is null or now() - ${mcpServers.breakerOpenedAt} >= ${cooldown}))`;
}

/**
 * CLAIM up to `limit` rows matching `eligible` for one pass: select them in
 * probe order and stamp their rotation cursor, so the next pass — concurrent
 * or later — takes the rows behind them. Returns the claimed rows as they were
 * BEFORE the stamp, in probe order (the loop wants `breakerOpenedAt` for the
 * election and the old cursor for the order).
 *
 * ── WHY A TRANSACTION AND AN ADVISORY LOCK, AND NOT JUST `skip locked` ──────
 * The first fix (AER-037) stamped the batch with a second UPDATE after the
 * SELECT, and a pass arriving in the gap took the same head. The second fix
 * folded both into one statement under `for update skip locked` and claimed
 * that two concurrent passes therefore claim disjoint sets. That held only for
 * a pass that reaches a row while the other's claim is still IN PROGRESS (the
 * row is locked, so it is skipped). It did not hold for this interleaving:
 * pass B takes its statement snapshot while pass A's claim is uncommitted, A
 * commits, and only then does B try to lock A's rows. They are no longer
 * locked, so B locks them; Postgres re-checks the row against the WHERE clause
 * — which does not look at the cursor — and B claims A's rows again, sorted by
 * the cursors its stale snapshot still shows. Same rows probed twice, the rows
 * behind them reached by neither.
 *
 * So every claim now runs in a short transaction whose FIRST statement takes
 * `pg_advisory_xact_lock(HEALTH_PROBE_CLAIM_LOCK_KEY)`, and whose SECOND is the
 * claim. Under READ COMMITTED each statement takes a fresh snapshot, so the
 * claim's snapshot is taken only after the lock is granted — i.e. after any
 * earlier claim has COMMITTED its stamps (the xact lock is released at commit,
 * never before). Every claim therefore sorts over the cursors every earlier
 * claim wrote, and two claims cannot pick the same row. A cursor predicate in
 * the WHERE clause (which the lock re-check does re-evaluate) was the
 * alternative, and was rejected: it needs a minimum-gap constant, and no value
 * is right — too small and a slow claim still slips through it, too large and
 * a legitimate back-to-back pass (a manual run straight after a scheduled one,
 * on an estate smaller than the cap) finds nothing to probe.
 *
 * The lock is held for one indexed SELECT-and-UPDATE of at most `limit` rows,
 * never across the probes (those run after this returns, on no transaction),
 * so a second pass waits milliseconds, not a sweep. `for update skip locked`
 * stays, now only for rows a NON-claim writer holds at that instant — a live
 * request's breaker update: such a row is left for the next pass rather than
 * waited on, and since it is not stamped it stays at the front of the queue.
 *
 * The returned batch is read through the stamp's RETURNING (an inner join of
 * `picked` to `claimed`), so it is exactly the rows whose cursor this claim
 * moved — not merely the rows it selected.
 *
 * `eligible` is a parameter rather than computed here so the caller's counts
 * and its claim use the same predicate; the sweep passes
 * `healthProbeEligibility()`.
 */
export async function claimHealthProbeBatch(db: Db | Tx, limit: number, eligible: SQL): Promise<ProbeRow[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${HEALTH_PROBE_CLAIM_LOCK_KEY})`);
    const picked = tx.$with("picked").as(
      tx
        .select({
          id: mcpServers.id,
          name: mcpServers.name,
          url: mcpServers.url,
          allowPrivateRanges: mcpServers.allowPrivateRanges,
          transport: mcpServers.transport,
          breakerOpenedAt: mcpServers.breakerOpenedAt,
          breakerLastError: mcpServers.breakerLastError,
          breakerConsecutiveFailures: mcpServers.breakerConsecutiveFailures,
          lastHealthProbeAt: mcpServers.lastHealthProbeAt,
        })
        .from(mcpServers)
        .where(eligible)
        .orderBy(
          sql`(${mcpServers.breakerOpenedAt} is null) asc`,
          sql`${mcpServers.lastHealthProbeAt} asc nulls first`,
          asc(mcpServers.name),
        )
        .limit(limit)
        .for("update", { skipLocked: true }),
    );
    const claimed = tx.$with("claimed").as(
      tx
        .update(mcpServers)
        .set({ lastHealthProbeAt: new Date() })
        .from(picked)
        .where(eq(mcpServers.id, picked.id))
        .returning({ claimedId: mcpServers.id }),
    );
    return (await tx
      .with(picked, claimed)
      .select({
        id: picked.id,
        name: picked.name,
        url: picked.url,
        allowPrivateRanges: picked.allowPrivateRanges,
        transport: picked.transport,
        breakerOpenedAt: picked.breakerOpenedAt,
        breakerLastError: picked.breakerLastError,
        breakerConsecutiveFailures: picked.breakerConsecutiveFailures,
        lastHealthProbeAt: picked.lastHealthProbeAt,
      })
      .from(picked)
      .innerJoin(claimed, eq(claimed.claimedId, picked.id))
      .orderBy(
        sql`(${picked.breakerOpenedAt} is null) asc`,
        sql`${picked.lastHealthProbeAt} asc nulls first`,
        asc(picked.name),
      )) as ProbeRow[];
  });
}

/**
 * Probe UP TO `limit` upstreams — circuit-broken ones first, then the least
 * recently considered — and feed the result to ADR-0126's breaker.
 *
 * "Up to" rather than "every", deliberately: one pass is bounded, and saying
 * "every registered upstream" was the wording that made AER-037's starved tail
 * invisible. Complete coverage of the estate is a property of the ROTATION
 * across passes (ceil(n / limit) of them), not of any single pass.
 *
 * Returns counts an operator can read without a database client. `opened` and
 * `recovered` are computed by RE-READING the breaker state of the rows this
 * pass touched rather than by re-deriving the threshold logic here — the
 * breaker owns when it opens, and a second copy of that arithmetic would be one
 * more thing to keep in step.
 */
export async function runMcpHealthProbeSweep(
  db: Db,
  opts: { limit?: number } = {},
): Promise<McpHealthProbeResult> {
  const limit = opts.limit ?? HEALTH_PROBE_BATCH_LIMIT;

  // A probe is POSSIBLE only when the breaker is closed or its cooldown has
  // elapsed — the same rule `breakerStateOf` applies, expressed in SQL so the
  // selection can exclude the rest rather than select and skip them.
  //
  // Postgres's clock decides here and Node's decides inside `breakerAdmits`. A
  // row the two disagree about (skew of milliseconds, at a boundary) is selected
  // and then fast-skipped, which is the pre-existing `skippedCircuitOpen` path —
  // so the disagreement costs one row of budget and never a wrong outcome.
  const probable = healthProbeEligibility();

  const [{ n: eligible, cooling: inCooldown, never: neverProbed, oldest: oldestProbeAt } = {
    n: 0,
    cooling: 0,
    never: 0,
    oldest: null,
  }] = await db
    .select({
      n: sql<number>`count(*) filter (where ${probable})::int`,
      cooling: sql<number>`count(*) filter (where not ${probable})::int`,
      never: sql<number>`count(*) filter (where ${probable} and ${mcpServers.lastHealthProbeAt} is null)::int`,
      // `min` ignores nulls, so this is the oldest STAMP; the never-probed rows
      // are counted separately rather than folded into it, because "stale" and
      // "never looked at" are different problems.
      oldest: sql<Date | null>`min(${mcpServers.lastHealthProbeAt}) filter (where ${probable})`,
    })
    .from(mcpServers);

  // BROKEN FIRST, THEN LEAST RECENTLY CONSIDERED — AND THE SELECTION IS THE
  // CLAIM, in ONE statement.
  //
  // `(breaker_opened_at is null) asc` puts false (a breaker IS open) ahead of
  // true, so the recovery cohort keeps jumping the queue — recovery is the
  // time-critical half, since a still-open breaker is refusing live traffic.
  // Within each cohort, `last_health_probe_at asc nulls first` is the rotation
  // that AER-037 was missing: never-probed rows first, then the longest
  // neglected. Name remains only as a deterministic tiebreak between rows whose
  // cursors are equal (every row on a fresh install), so a pass over unchanged
  // data is reproducible.
  //
  // THE CLAIM — selection and cursor stamp in one statement, serialized
  // against every other pass's claim. `claimHealthProbeBatch` says how and why.
  const batch = await claimHealthProbeBatch(db, limit, probable);

  const out: McpHealthProbeResult = {
    eligible,
    inCooldown,
    probed: 0,
    healthy: 0,
    failed: 0,
    skippedCircuitOpen: 0,
    skippedOurRefusal: 0,
    opened: [],
    recovered: [],
    capped: eligible > batch.length,
    backlog: Math.max(0, eligible - batch.length),
    neverProbed,
    oldestProbeAt: oldestProbeAt === null ? null : new Date(oldestProbeAt),
  };

  /** state before the probe, for the touched rows, so open/close transitions can
   *  be reported from the breaker's own after-state rather than inferred */
  const before = new Map<string, { name: string; wasOpen: boolean }>();

  for (const row of batch) {
    // Enter the breaker's OWN election. A refusal here means either the cooldown
    // has not elapsed or a real request is already probing — both are reasons to
    // leave this upstream alone rather than add to the herd.
    const refusal = await breakerAdmits(db, row);
    if (refusal) {
      out.skippedCircuitOpen += 1;
      continue;
    }

    before.set(row.id, { name: row.name, wasOpen: row.breakerOpenedAt !== null });
    out.probed += 1;

    try {
      // THE LIVE PATH, verbatim — the same function the proxy and the admission
      // rescan use, so the probe cannot become an egress bypass. It runs
      // ADR-0097 admission and then ADR-0043's guarded connect; nothing here
      // opens a socket by itself.
      const client = await connectUpstream(db, row);
      try {
        // AER-022 — AND THEN A REAL OPERATION. The first version of this file
        // stopped at the connect and called that health, which is the same
        // mistake the proxy route made: `initialize` is a protocol formality an
        // upstream can satisfy while hanging every `tools/list` that follows. A
        // probe that accepted a handshake as recovery could CLOSE a breaker that
        // real tool failures had opened, handing the next user the outage the
        // breaker was holding back — worse than not probing at all, because the
        // sweep would report `recovered` while the upstream stayed broken.
        //
        // `tools/list` is the cheapest operation the protocol defines that
        // actually exercises the server's own handler, it is read-only on every
        // upstream by definition, and it is the same call the proxy makes to sync
        // a manifest — so "the probe passed" now means what a user needs it to.
        // Bounded by G2's list deadline: an upstream that answers `initialize`
        // and then hangs is precisely the case, so an unbounded await here would
        // hang the whole sweep on its first sick server.
        await client.listTools(undefined, { timeout: timeouts().mcpListToolsMs });
        out.healthy += 1;
      } finally {
        await client.close().catch(() => {});
      }
      await recordUpstreamSuccess(db, row);
    } catch (err) {
      // OUR refusal, not the upstream's fault. Counted, never charged to the
      // breaker — see the header: an air-gapped install would otherwise report
      // every upstream as broken.
      if (err instanceof McpAdmissionHeldError || err instanceof McpEgressBlockedError) {
        out.skippedOurRefusal += 1;
        out.probed -= 1;
        before.delete(row.id);
        continue;
      }
      out.failed += 1;
      await recordUpstreamFailure(db, row, err instanceof Error ? err.message : String(err));
    }
  }

  // ONE query for the after-state of everything touched. The breaker decides
  // when it opens and closes; this only reports what it did.
  if (before.size > 0) {
    const after = await db
      .select({
        id: mcpServers.id,
        name: mcpServers.name,
        breakerOpenedAt: mcpServers.breakerOpenedAt,
      })
      .from(mcpServers)
      .where(inArray(mcpServers.id, [...before.keys()]));
    for (const row of after) {
      const prior = before.get(row.id);
      if (!prior) continue;
      const isOpen = breakerStateOf({ breakerOpenedAt: row.breakerOpenedAt }) !== "closed";
      if (!prior.wasOpen && isOpen) out.opened.push(row.name);
      if (prior.wasOpen && !isOpen) out.recovered.push(row.name);
    }
  }

  return out;
}
