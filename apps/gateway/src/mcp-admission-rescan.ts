/**
 * ADR-0100 — THE SCHEDULED MCP ADMISSION RE-SCAN, closing ADR-0097's own
 * disclosed residue.
 *
 * ADR-0097 built the tool-poisoning gate and then said, in its own "what this
 * deliberately does NOT do":
 *
 *   > It does not re-scan on a schedule. Adjudication happens on manifest sync.
 *   > A server nobody touches is never re-examined, and a compromised server
 *   > that is never called is never caught.
 *
 * and, in its honest limits:
 *
 *   > Grandfathered servers are trusted until their next sync. On a deployment
 *   > where a server is registered and never re-synced, that is indefinite.
 *
 * Those are the same hole from two directions, and the hole sits exactly where
 * an attacker would want it: the rarely-used server, and the server that
 * predates the feature. This module is the sweep that walks into it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE ADJUDICATION, NOT TWO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The whole risk of a job like this is that it grows its own copy of "is this
 * manifest admissible" and then drifts from the live path — a different
 * threshold, a different state rule, a different idea of what a clearance
 * covers. So it has none. A pass over one server is literally:
 *
 *     connectUpstream(db, row)        // ADR-0097's gate, then ADR-0043's guard
 *     syncUpstreamTools(db, id, c, "rescan")   // → recordManifestScan(...)
 *
 * — the same two functions the MCP proxy route, the governed tool call and the
 * worker-node tool resolution all go through. `recordManifestScan` owns the
 * scan, the threshold (`MCP_ADMISSION_HOLD_AT`), the digest, the state
 * transition (`nextAdmissionState`) and the audit row. Nothing in this file
 * computes a verdict, compares a digest or decides a hold. It decides only
 * WHICH servers get looked at, in WHAT order, and HOW MANY per pass.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT FETCHES A FRESH MANIFEST — and the alternative was not merely weaker,
 * it was impossible
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Re-scanning the STORED manifest would cost nothing and make no outbound
 * call. It would also be a different, weaker adjudication than the live path's,
 * because `mcp_tools` stores `name`, `kind` and `description` and NOTHING else
 * — the `inputSchema` is not persisted anywhere. ADR-0097's headline finding is
 * that the payload does not live in the tool's own description (which a
 * reviewer skims) but in the NESTED per-property description inside that input
 * schema. A stored re-scan is therefore structurally blind to the exact class
 * of poisoning this gate exists for, and it would report `clean` on a manifest
 * the live path holds. That is the second-implementation defect, arrived at by
 * accident instead of on purpose.
 *
 * So the sweep connects. What that costs, honestly: a `tools/list` per eligible
 * server per pass, on a timer, from a deployment nobody is using. It is bounded
 * (§ MCP_RESCAN_MAX_PER_PASS), it is daily by default, and it goes through
 * ADR-0043's egress guard exactly like every other connect — an air-gapped or
 * allow-list-restricted install simply cannot reach most of them, and that is
 * reported as `unreachable`, never as a hold. A gate that held on
 * unreachability would take an entire air-gapped install offline on a network
 * blip; ADR-0097 holds on a SCAN VERDICT and nothing else, and so does this.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ELIGIBILITY, AND THE OPERATOR-FIGHTING GUARD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Four states are eligible, swept worst-known-provenance first so a bounded
 * pass spends its budget on the blind spot rather than on the servers already
 * best understood:
 *
 *   1. `grandfathered` — trusted only because it was already trusted. The
 *      ADR-0097 upgrade boundary; nobody has ever looked at this manifest.
 *   2. `unscanned`     — registered, never synced. Nobody has looked yet either,
 *                        but for a different reason, and the queue shows both.
 *   3. `clean`         — looked at once. The realistic compromise is the server
 *                        that TURNED, and this is where it turns.
 *   4. `cleared`       — an admin signed for a SPECIFIC manifest.
 *
 * Within a state, least-recently-scanned first (never-scanned first of all), so
 * a capped pass rotates through the estate instead of re-examining the same
 * servers forever.
 *
 * `cleared` is the interesting one, and the rule is not this module's to invent
 * — `nextAdmissionState` already has it, and driving the shared function is how
 * the sweep inherits it rather than re-deciding it:
 *
 *   - clearance is pinned to `admission_manifest_digest`. Same manifest ⇒ same
 *     digest ⇒ the server stays `cleared`. **The sweep does not re-hold a
 *     server on the manifest an admin already accepted.** Re-holding there
 *     would be the job fighting the operator, and an operator who has to
 *     re-clear the same server every night turns the feature off.
 *   - a CHANGED manifest is exactly what the clearance did not cover, so it is
 *     adjudicated from scratch and can re-hold, filing the same
 *     `mcp-admission-drift-reheld` row the live path files.
 *
 * `held` is NOT eligible, deliberately. It is already at the adverse terminal
 * state, it is already in the review queue, and under `enforce` the gate inside
 * `connectUpstream` would refuse the sweep's own connect anyway. More to the
 * point, the only thing re-scanning a held server could achieve is
 * AUTO-UN-HOLDING it when the upstream serves something clean — and ADR-0097 §6
 * is explicit that **nothing auto-clears**. A timer that silently readmits a
 * server an admin was reviewing is the same decision by the back door.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POSTURE — two knobs, and both must say yes
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. ADR-0064's scheduler is OFF by default, so a fresh install runs no pass at
 *    all until an operator opts in.
 * 2. `org_settings.mcp_admission_mode` is `off` by default, and with it off this
 *    function adjudicates NOTHING: no connect, no scan, no column write, no
 *    admission audit row. That is the only coherent behaviour — a knob that
 *    says "do not scan manifests" cannot mean "except on a timer" — and it
 *    mirrors ADR-0097's own `off` posture byte for byte. The pass still HAPPENS
 *    and the scheduler still writes its ordinary `scheduler-job-succeeded` row
 *    carrying `skipped: true` and the reason, so "it ran and did nothing on
 *    purpose" is never confused with "it never ran".
 */
import {
  asc,
  auditLog,
  inArray,
  mcpServers,
  sql,
  type Db,
} from "@regulait/db";
import type { McpAdmissionMode, McpAdmissionState, McpUpstreamTransport } from "@regulait/shared";
import { loadAdmissionMode, McpAdmissionHeldError } from "./mcp-admission.js";
import { connectUpstream, syncUpstreamTools } from "./mcp-proxy.js";
import { runSkillAdmissionRescan, type SkillRescanResult } from "./skill-admission.js";

/** the scheduler's own null actor — this sweep mints no identity and acts as
 * the deployment, exactly like the other reconcile-only jobs (ADR-0064 §8) */
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/**
 * BOUNDED WORK PER PASS, like every other sweep in ADR-0064. Each examined
 * server costs one outbound MCP session, and an estate of five hundred servers
 * must not turn one tick into a five-hundred-connection burst. The remainder is
 * not lost: ordering is least-recently-scanned-first, so the next pass picks up
 * where this one stopped, and the count of what was left is reported on the run
 * row rather than silently dropped.
 */
export const MCP_RESCAN_MAX_PER_PASS = 25;

/** the four states a re-scan can meaningfully change, in sweep priority order */
export const MCP_RESCAN_ELIGIBLE_STATES = [
  "grandfathered",
  "unscanned",
  "clean",
  "cleared",
] as const satisfies readonly McpAdmissionState[];

export interface McpAdmissionRescanResult {
  mode: McpAdmissionMode;
  /** true when the pass adjudicated nothing because `mcpAdmissionMode` is off */
  skipped: boolean;
  /** why the pass did what it did — carried onto the scheduler run row */
  reason: string;
  /** servers in an eligible state when the pass started */
  eligible: number;
  /** servers this pass actually attempted (≤ MCP_RESCAN_MAX_PER_PASS) */
  examined: number;
  /** eligible > examined: the cap truncated this pass */
  capped: boolean;
  /** examined servers whose manifest was fetched and adjudicated */
  adjudicated: number;
  /** transitions INTO `held` made by this pass */
  held: number;
  /** of those, ones that were previously `clean` or `cleared` (ADR-0097 drift) */
  reheld: number;
  /** adjudicated `clean` */
  clean: number;
  /** `cleared` servers left alone because the digest had not moved */
  clearedUnchanged: number;
  /** could not be reached — egress-refused, down, or serving garbage. State
   * UNTOUCHED: unreachable is not a verdict. */
  unreachable: number;
  heldServerIds: string[];
  unreachableServerIds: string[];
  /** ADR-0175 A6: the builder-skill part of the pass (library bodies and pinned
   * attachment bodies). Local and model-free, so it runs whatever
   * `mcp_admission_mode` says — that knob governs MCP manifests only. */
  skills: SkillRescanResult;
}

interface EligibleRow {
  id: string;
  name: string;
  url: string;
  allowPrivateRanges: boolean | null;
  admissionState: McpAdmissionState;
  /** ADR-0185 G4: the connect opens the row's own transport (a stdio server is
   * re-scanned by starting its pinned command, through every stdio rule) */
  transport: McpUpstreamTransport;
  stdioCommand: string | null;
  stdioArgs: string[] | null;
  stdioCommandDigest: string | null;
}

/**
 * ONE PASS. Called by the ADR-0064 scheduler job `mcp-admission-rescan-sweep`
 * and by that job's `POST /v1/scheduler/jobs/:name/run` manual door — the same
 * function through the same claim and the same lease, so a hand-run and a
 * timed run are the same code path by construction.
 */
export async function runMcpAdmissionRescan(
  db: Db,
  opts: { actorUserId: string | null; now?: Date; limit?: number } = { actorUserId: null },
): Promise<McpAdmissionRescanResult> {
  const now = opts.now ?? new Date();
  const limit = Math.max(1, opts.limit ?? MCP_RESCAN_MAX_PER_PASS);
  const mode = await loadAdmissionMode(db);
  // ADR-0175 A6 — skills first: no outbound call, no posture knob
  const skills = await runSkillAdmissionRescan(db);

  const empty = {
    eligible: 0,
    examined: 0,
    capped: false,
    adjudicated: 0,
    held: 0,
    reheld: 0,
    clean: 0,
    clearedUnchanged: 0,
    unreachable: 0,
    heldServerIds: [] as string[],
    unreachableServerIds: [] as string[],
  };

  // POSTURE GATE. `off` means off, including for the timer. Returns BEFORE any
  // row is read, any socket is opened or any audit row is written — the same
  // short-circuit `recordManifestScan` makes, for the same reason.
  if (mode === "off") {
    return {
      mode,
      skipped: true,
      reason:
        "org_settings.mcp_admission_mode='off' — the admission scanner is disabled, so the " +
        "scheduled re-scan adjudicated nothing: no upstream was contacted, no manifest was " +
        "scanned and no admission column or audit row was written. Set the mode to 'log' or " +
        "'enforce' to give this sweep something to do.",
      ...empty,
      skills,
    };
  }

  // ELIGIBILITY + ORDER. Worst-known-provenance first, then least-recently
  // scanned (never-scanned first of all), so a capped pass rotates through the
  // estate rather than re-reading the same servers every night.
  const priority = sql`case ${mcpServers.admissionState}
      when 'grandfathered' then 0
      when 'unscanned' then 1
      when 'clean' then 2
      else 3 end`;
  const candidates = (await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      url: mcpServers.url,
      allowPrivateRanges: mcpServers.allowPrivateRanges,
      admissionState: mcpServers.admissionState,
      transport: mcpServers.transport,
      stdioCommand: mcpServers.stdioCommand,
      stdioArgs: mcpServers.stdioArgs,
      stdioCommandDigest: mcpServers.stdioCommandDigest,
    })
    .from(mcpServers)
    .where(inArray(mcpServers.admissionState, [...MCP_RESCAN_ELIGIBLE_STATES]))
    .orderBy(priority, sql`${mcpServers.admissionScannedAt} asc nulls first`, asc(mcpServers.id))) as EligibleRow[];

  const eligible = candidates.length;
  const batch = candidates.slice(0, limit);

  const out = {
    ...empty,
    eligible,
    examined: batch.length,
    capped: eligible > batch.length,
    heldServerIds: [] as string[],
    unreachableServerIds: [] as string[],
  };

  for (const row of batch) {
    const previous = row.admissionState;
    let reachedManifest = false;
    try {
      // THE LIVE PATH, verbatim. `connectUpstream` runs ADR-0097's gate and
      // then ADR-0043's egress guard; `syncUpstreamTools` fetches the manifest
      // and hands it to `recordManifestScan`, which owns every part of the
      // verdict. `"rescan"` labels the audit row and changes nothing else.
      const client = await connectUpstream(db, row);
      try {
        await syncUpstreamTools(db, row.id, client, "rescan", row.transport);
        reachedManifest = true;
      } finally {
        await client.close().catch(() => {});
      }
    } catch (err) {
      if (err instanceof McpAdmissionHeldError) {
        // Under `enforce` a dirty manifest makes `syncUpstreamTools` throw
        // AFTER `recordManifestScan` has already persisted the hold. That is
        // an adjudication, not a failure — the whole point of the pass.
        reachedManifest = true;
      } else {
        // Egress-refused (including every air-gapped host), upstream down,
        // protocol garbage. NOT a verdict: the admission columns are left
        // exactly as they were. The egress guard audits its own refusal.
        out.unreachable += 1;
        out.unreachableServerIds.push(row.id);
        continue;
      }
    }
    if (!reachedManifest) continue;

    // Classify from the ROW, not from a return value: the state that matters is
    // the one `recordManifestScan` actually persisted.
    const [after] = await db
      .select({ admissionState: mcpServers.admissionState })
      .from(mcpServers)
      .where(inArray(mcpServers.id, [row.id]));
    const state = after?.admissionState ?? previous;
    out.adjudicated += 1;
    if (state === "held") {
      out.held += 1;
      out.heldServerIds.push(row.id);
      if (previous === "clean" || previous === "cleared") out.reheld += 1;
    } else if (state === "cleared") {
      // `nextAdmissionState` kept the clearance because the digest had not
      // moved — the operator-fighting guard, inherited rather than re-decided.
      out.clearedUnchanged += 1;
    } else if (state === "clean") {
      out.clean += 1;
    }
  }

  const reason =
    `MCP admission re-scan swept ${out.examined} of ${eligible} eligible server(s)` +
    (out.capped ? ` (capped at ${limit} per pass; the remainder is swept next pass)` : "") +
    ` in mode '${mode}': ${out.held} held (${out.reheld} of them re-held after drift), ` +
    `${out.clean} clean, ${out.clearedUnchanged} left cleared on an unchanged manifest, ` +
    `${out.unreachable} unreachable (state untouched — unreachable is not a verdict). ` +
    `Eligible states are ${MCP_RESCAN_ELIGIBLE_STATES.join("/")}; an already-held server is ` +
    `never re-examined, because nothing auto-clears.`;

  // ONE AUDITED FACT PER PASS, in the shape B7c's `canary-observations-pruned`
  // established. `effect: 'allow'` deliberately: each individual hold this pass
  // made already filed its own `mcp-admission-held` /
  // `mcp-admission-drift-reheld` row carrying the real effect, and duplicating
  // that deny here would double-count a refusal on the admin's filtered view.
  await db.insert(auditLog).values({
    userId: opts.actorUserId ?? NO_IDENTITY,
    objectType: "mcp_server",
    objectId: null,
    detail: {
      phase: "admission-rescan-sweep",
      mode,
      at: now.toISOString(),
      eligible,
      examined: out.examined,
      capped: out.capped,
      limit,
      adjudicated: out.adjudicated,
      held: out.held,
      reheld: out.reheld,
      clean: out.clean,
      clearedUnchanged: out.clearedUnchanged,
      unreachable: out.unreachable,
      heldServerIds: out.heldServerIds,
      unreachableServerIds: out.unreachableServerIds,
      eligibleStates: [...MCP_RESCAN_ELIGIBLE_STATES],
      skills,
    },
    effect: "allow",
    ruleId: "mcp-admission-rescan-swept",
    ruleChain: [],
    reason,
  });

  return { mode, skipped: false, reason, ...out, skills };
}
