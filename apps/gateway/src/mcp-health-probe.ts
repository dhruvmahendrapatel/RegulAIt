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
 * ── WHY IT REUSES `breakerAdmits` RATHER THAN READING THE STATE ────────────
 * A probe against an OPEN breaker is the recovery path, and recovery has a
 * thundering-herd problem the breaker already solved with a one-winner election
 * (a conditional UPDATE on `breaker_opened_at`). Calling `breakerAdmits` means
 * this sweep enters that election like any other caller: it probes a half-open
 * upstream only if it wins, and fast-skips if a real request got there first.
 * Re-implementing the check here would have been a second copy of the one piece
 * of concurrency logic in that file.
 *
 * ── THE CAP, AND WHY IT DEGRADES TO TODAY ─────────────────────────────────
 * A pass is bounded, and broken upstreams are probed FIRST — recovery is the
 * time-critical half, since a still-open breaker is refusing live traffic while
 * a healthy-but-unprobed one is costing nobody anything. Servers past the cap
 * are simply discovered passively by the first user to call them, which is
 * exactly today's behaviour. The cap degrades to the status quo rather than to
 * something worse, which is the only kind of cap worth having here.
 */
import { asc, inArray, mcpServers, sql, type Db } from "@regulait/db";
import { McpAdmissionHeldError } from "./mcp-admission.js";
import { McpEgressBlockedError } from "./mcp-egress.js";
import { connectUpstream } from "./mcp-proxy.js";
import {
  breakerAdmits,
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
  /** every registered upstream */
  eligible: number;
  /** how many this pass actually attempted a connect against */
  probed: number;
  /** answered the handshake */
  healthy: number;
  /** a genuine upstream failure; the breaker was told */
  failed: number;
  /** in cooldown, or another caller won the half-open election */
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
}

type ProbeRow = BreakerRow & { url: string; allowPrivateRanges: boolean | null };

/**
 * Probe every registered upstream, broken ones first, and feed the result to
 * ADR-0126's breaker.
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

  const [{ n: eligible } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mcpServers);

  // BROKEN FIRST. `breaker_opened_at desc nulls last` puts every open breaker
  // ahead of every closed one, so a bounded pass spends its budget on recovery
  // before discovery. Stable tiebreak on name so two passes over unchanged data
  // examine the same set.
  const batch = (await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      url: mcpServers.url,
      allowPrivateRanges: mcpServers.allowPrivateRanges,
      breakerOpenedAt: mcpServers.breakerOpenedAt,
      breakerLastError: mcpServers.breakerLastError,
      breakerConsecutiveFailures: mcpServers.breakerConsecutiveFailures,
    })
    .from(mcpServers)
    .orderBy(sql`${mcpServers.breakerOpenedAt} desc nulls last`, asc(mcpServers.name))
    .limit(limit)) as ProbeRow[];

  const out: McpHealthProbeResult = {
    eligible,
    probed: 0,
    healthy: 0,
    failed: 0,
    skippedCircuitOpen: 0,
    skippedOurRefusal: 0,
    opened: [],
    recovered: [],
    capped: eligible > batch.length,
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
