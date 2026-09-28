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
 * The cursor is stamped when a row is SELECTED, not after it answers. Three
 * things follow, and all three are wanted: a row whose probe fails still moves
 * to the back (its breaker, not this cursor, is what keeps it urgent); two
 * concurrent passes pick DISJOINT sets rather than racing over the same head;
 * and a pass that dies half way leaves its rows late rather than starved.
 */
import { asc, inArray, mcpServers, sql, type Db } from "@regulait/db";
import { McpAdmissionHeldError } from "./mcp-admission.js";
import { McpEgressBlockedError } from "./mcp-egress.js";
import { connectUpstream } from "./mcp-proxy.js";
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
  /** answered the handshake */
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
  lastHealthProbeAt: Date | null;
};

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
  const cooldown = sql`make_interval(secs => ${breakerConfig().cooldownMs / 1000})`;
  const probable = sql`(${mcpServers.breakerOpenedAt} is null or now() - ${mcpServers.breakerOpenedAt} >= ${cooldown})`;

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

  // BROKEN FIRST, THEN LEAST RECENTLY CONSIDERED.
  //
  // `(breaker_opened_at is null) asc` puts false (a breaker IS open) ahead of
  // true, so the recovery cohort keeps jumping the queue — recovery is the
  // time-critical half, since a still-open breaker is refusing live traffic.
  // Within each cohort, `last_health_probe_at asc nulls first` is the rotation
  // that AER-037 was missing: never-probed rows first, then the longest
  // neglected. Name remains only as a deterministic tiebreak between rows whose
  // cursors are equal (every row on a fresh install), so a pass over unchanged
  // data is reproducible.
  const batch = (await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      url: mcpServers.url,
      allowPrivateRanges: mcpServers.allowPrivateRanges,
      breakerOpenedAt: mcpServers.breakerOpenedAt,
      breakerLastError: mcpServers.breakerLastError,
      breakerConsecutiveFailures: mcpServers.breakerConsecutiveFailures,
      lastHealthProbeAt: mcpServers.lastHealthProbeAt,
    })
    .from(mcpServers)
    .where(probable)
    .orderBy(
      sql`(${mcpServers.breakerOpenedAt} is null) asc`,
      sql`${mcpServers.lastHealthProbeAt} asc nulls first`,
      asc(mcpServers.name),
    )
    .limit(limit)) as ProbeRow[];

  // CLAIM THE BATCH BEFORE PROBING IT. One UPDATE, and it is what turns the cap
  // into a rotation: a row is "considered" the moment it is selected, so a probe
  // that fails, hangs or is refused by our own gates still moves to the back of
  // the queue and cannot monopolise every pass. It also means two concurrent
  // passes select disjoint sets instead of racing over the same head — and a
  // pass that dies half way leaves its rows late rather than starved.
  if (batch.length > 0) {
    await db
      .update(mcpServers)
      .set({ lastHealthProbeAt: new Date() })
      .where(inArray(mcpServers.id, batch.map((r) => r.id)));
  }

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
