/**
 * ADR-0043 — `mcp_servers.url`, BEHIND THE SAME EGRESS GUARD, WITH ITS OWN
 * POSTURE.
 *
 * WHY THIS EXISTS. ADR-0034 and both of its follow-up amendments each ended by
 * naming `mcp_servers.url` as EXPOSED — `connectUpstream(serverRow.url)`
 * fetches it on four paths — and each said the same thing: do NOT bolt the
 * blanket default-deny check on, because an internal/self-hosted MCP server is
 * the LEGITIMATE, ORDINARY deployment (that is the entire point of a
 * self-hosted tool server), so the model/connector posture would make the
 * guard fire on the normal case. ADR-0043 takes the posture decision that was
 * blocked on:
 *
 *   - PRIVATE LAN OPEN BY DEFAULT: a server whose URL resolves entirely into
 *     ordinary private LAN space (RFC1918 / loopback / ULA) works with zero
 *     ceremony, plaintext http included — governed by the per-server
 *     `mcp_servers.allow_private_ranges` flag, whose null inherits the org
 *     `mcp_private_ranges_default` toggle (true by default; a hardened org
 *     flips it to strict).
 *   - THE IMDS CARVE-OUT IS UNCONDITIONAL: 169.254.0.0/16 (and the other
 *     never-legitimate ranges — CGNAT, multicast, reserved, 0.0.0.0/8, the
 *     IPv6 analogues incl. AWS's fd00:ec2::/32) are refused on this surface
 *     no matter what any flag or allow entry says. "Reach my internal tool
 *     server" is never "reach the instance metadata endpoint".
 *   - PUBLIC INTERNET STAYS DEFAULT-DENY: an MCP URL on a public host needs
 *     an `egress_allow_hosts` entry (with its plaintext opt-in for http://)
 *     exactly like every other outbound surface — a public-internet MCP URL
 *     an admin was phished into adding is the genuine SSRF/exfil risk.
 *
 * SAME TABLE, SAME GUARD, NO SECOND MECHANISM: this module is the same thin
 * adapter onto `checkEgress` / `createGuardedFetch` that `credential-egress.ts`
 * and `connection-egress.ts` are — the posture rides in as the guard's
 * ADR-0043 `privateLan` option. Both moments apply, per ADR-0034's rule:
 * WRITE TIME (`POST`/`PATCH /v1/servers` → an honest 400) and EVERY
 * `connectUpstream` (DNS moves, the toggle flips, and rows written before this
 * guard existed are in the live database right now — they are REFUSED, never
 * rewritten). Every request the MCP client transport then makes goes through
 * the same guarded fetch, so it inherits the ADR-0034 amendment-#3 pinned
 * transport (no DNS-rebind window) and the redirect refusal for free.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { auditLog, eq, mcpServers, type Db } from "@regulait/db";
import type { ExecutionRefusalReason, McpUpstreamTransport } from "@regulait/shared";
import {
  checkEgress,
  createGuardedFetch,
  type EgressAllowEntry,
  type EgressDecision,
  type EgressDenied,
  type EgressDenyCode,
  type EgressResolver,
} from "./egress-guard.js";
import {
  checkStdioClosure,
  isSseCrossOriginRefusal,
  openTransport,
  rowTransport,
  type StdioRefusalCode,
  type UpstreamLaunch,
} from "./mcp-transports.js";
import { attachLinkedStdioSession, placeStdioSession, type StdioPlacementInput, type StdioSessionFailure } from "./executor-stdio.js";
import { observeUpstream, type MetricUpstreamOutcome } from "./metrics.js";
import { identityAssertionMiddleware, type OutboundIdentity } from "./mcp-identity-assertion.js";
import { openUpstreamCredential, upstreamCredentialMiddleware } from "./mcp-upstream-credential.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { loadOrgSettings } from "./org-settings.js";
import { timeouts } from "./timeouts.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

export interface McpEgressDeps {
  resolve?: EgressResolver;
  fetchImpl?: typeof fetch;
  /**
   * ADR-0128: the deadline THIS attempt may use, which on a retry is what is
   * left of the sequence's budget rather than the full configured bound.
   * Absent = `timeouts().mcpConnectMs`, i.e. exactly the pre-retry behaviour.
   * It lives in this bag because the bag is already how a caller overrides what
   * this function would otherwise read from module state.
   */
  connectDeadlineMs?: number;
  /**
   * ADR-0188 S8: the call's outbound identity (an opted-in server only). Its
   * middleware wraps the guarded fetch, so the assertion rides only requests
   * the egress guard already allowed; absent = byte-identical to before.
   */
  outboundIdentity?: OutboundIdentity | null;
  /**
   * ADR-0190 I4: who a stdio connect runs for — the person, the project the
   * call is attributed to, the agent and the delegation grant — the inputs of
   * decision 7's required class. Absent (a sweep, a probe, a connect with no
   * call behind it) = no project, which never resolves: the placement is
   * refused `policy_unresolved` and nothing starts (fail closed, never
   * defaulted).
   */
  placement?: (Pick<StdioPlacementInput, "userId" | "projectId" | "agent" | "parentGrantId" | "interactivePerson"> & {
    /** the offer the governed decision already made (its placement row is keyed to that decision, I4/I8) */
    linkedOfferId?: string | null;
  }) | null;
  /** tests: how long to wait for the executor's per-placement report (default the offer TTLs) */
  placementTimeoutMs?: number;
}

/** Everything one decision needs: the allow-list snapshot and the EFFECTIVE
 * private-range posture (server flag, org default when the flag is null). */
export interface McpEgressPosture {
  allowList: EgressAllowEntry[];
  /** server.allowPrivateRanges ?? org.mcpPrivateRangesDefault */
  openByDefault: boolean;
}

export async function loadMcpEgressPosture(
  db: Db,
  serverAllowPrivateRanges: boolean | null | undefined,
): Promise<McpEgressPosture> {
  const [allowList, org] = await Promise.all([loadEgressAllowList(db), loadOrgSettings(db)]);
  return {
    allowList,
    openByDefault: serverAllowPrivateRanges ?? org.mcpPrivateRangesDefault,
  };
}

/** One decision against the CURRENT posture — loaded fresh every time, never
 * cached, because a write-time verdict is not a fact about the future. */
export async function checkMcpServerUrl(
  db: Db,
  url: string,
  serverAllowPrivateRanges: boolean | null | undefined,
  deps: McpEgressDeps = {},
): Promise<{ decision: EgressDecision; posture: McpEgressPosture }> {
  const posture = await loadMcpEgressPosture(db, serverAllowPrivateRanges);
  const decision = await checkEgress(url, {
    allowList: posture.allowList,
    privateLan: { openByDefault: posture.openByDefault },
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  });
  return { decision, posture };
}

/** Thrown by the connect-time guard. The MCP proxy route turns it into its
 * ordinary pre-hijack 403; the governed-tool-call and node-tool paths let it
 * ride their existing upstream-failure handling. Either way the refusal is
 * already audited and NOTHING has left the box. */
export class McpEgressBlockedError extends Error {
  /** ADR-0185 G4: the refusal's HTTP error name — `egress_blocked` here, the
   * transport refusal's own name on `McpUpstreamRefusedError` — so a route
   * maps every one of our refusals with `error: err.error` */
  readonly error: string = "egress_blocked";
  constructor(readonly decision: EgressDenied) {
    super(`egress blocked (${decision.code}): ${decision.reason}`);
    this.name = "McpEgressBlockedError";
  }
}

/** File the refusal — pointing the gateway's MCP proxy at a destination it may
 * not reach is exactly the event a governance product must be able to show
 * afterwards. */
export async function auditMcpEgressDenied(
  db: Db,
  args: {
    userId?: string | null;
    serverId?: string | null;
    url: string;
    phase: "registration" | "update" | "connect";
    decision: EgressDenied;
    reason: string;
    openByDefault: boolean;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: args.userId ?? NIL_USER,
    ...(args.serverId ? { serverId: args.serverId } : {}),
    objectType: "mcp_server",
    objectId: args.serverId ?? null,
    detail: {
      phase: args.phase,
      url: args.url,
      code: args.decision.code,
      effectiveAllowPrivateRanges: args.openByDefault,
      ...(args.decision.host ? { host: args.decision.host } : {}),
    },
    effect: "deny",
    ruleId: "mcp-server-egress-blocked",
    ruleChain: [],
    reason: args.reason,
  });
}

/**
 * ROADMAP G2 — the upstream is registered, permitted and admitted, and it did
 * not answer.
 *
 * THIS IS NOT AN EGRESS REFUSAL AND MUST NOT READ LIKE ONE. `mcp-server-egress-
 * blocked` means the gateway DECLINED to go somewhere; this means it went and
 * nothing was there. Filing both under one rule id would make "we refused to
 * reach it" and "we could not reach it" indistinguishable in the ledger, and
 * those two lead an operator to opposite places — a policy screen and a
 * network. Hence its own id.
 *
 * `effect: "deny"` because the caller's request was refused, which is the fact
 * the trail records. The reason names the deadline, so the row distinguishes a
 * refused connection from an exhausted one without the reader having to infer
 * it from a duration.
 */
export async function auditMcpUpstreamUnreachable(
  db: Db,
  args: {
    userId?: string | null;
    serverId: string;
    url: string;
    reason: string;
    timedOut: boolean;
    deadlineMs: number;
    /**
     * ADR-0128 — how many attempts the sequence actually made, and the backoffs
     * between them. They ride the ONE failure row rather than getting a row
     * each: a row per attempt would turn one outage into thousands of
     * near-identical entries, which is verbatim why the breaker files
     * transitions and not refusals. Absent on callers that do not retry.
     */
    attempts?: number;
    retryDelaysMs?: number[];
    /** the classifier's verdict on the LAST error, so the ledger says whether
     *  we declined to retry and why — a spent deadline and an unrecognised
     *  error are different operator problems. */
    retryVerdict?: string | null;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: args.userId ?? NIL_USER,
    serverId: args.serverId,
    objectType: "mcp_server",
    objectId: args.serverId,
    detail: {
      phase: "connect",
      url: args.url,
      outcome: args.timedOut ? "deadline_exceeded" : "connect_failed",
      deadlineMs: args.deadlineMs,
      ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
      ...(args.retryDelaysMs !== undefined ? { retryDelaysMs: args.retryDelaysMs } : {}),
      ...(args.retryVerdict ? { retryVerdict: args.retryVerdict } : {}),
    },
    effect: "deny",
    ruleId: "mcp-upstream-unreachable",
    ruleChain: [],
    reason: args.reason,
  });
}

/**
 * WRITE TIME, in one call — the `refuseConnectionEgressWrite` shape. Returns
 * null when the destination is permitted, or the 400 body when it is not,
 * audited either way it refuses.
 */
export async function refuseMcpServerWrite(
  db: Db,
  args: {
    url: string;
    allowPrivateRanges: boolean | null | undefined;
    userId?: string | null;
    serverId?: string | null;
    phase: "registration" | "update";
    /** names the row in the refusal, e.g. "MCP server 'repo-tools'" */
    label: string;
    deps?: McpEgressDeps;
  },
): Promise<{ error: "egress_blocked"; code: string; detail: string } | null> {
  const { decision, posture } = await checkMcpServerUrl(
    db,
    args.url,
    args.allowPrivateRanges,
    args.deps ?? {},
  );
  if (decision.ok) return null;
  const detail = `${args.label} refused: ${decision.reason}`;
  await auditMcpEgressDenied(db, {
    ...(args.userId !== undefined ? { userId: args.userId } : {}),
    ...(args.serverId !== undefined ? { serverId: args.serverId } : {}),
    url: args.url,
    phase: args.phase,
    decision,
    reason: detail,
    openByDefault: posture.openByDefault,
  });
  return { error: "egress_blocked", code: decision.code, detail };
}


// ===========================================================================
// ADR-0185 G4 — the destination decision, by transport
// ===========================================================================

/**
 * The upstream a connect would reach, as the preflight sees it. `transport`
 * and the stdio columns are optional so every existing caller's row shape
 * still fits; a row without them is re-read from the database (never assumed
 * to be Streamable HTTP when it may not be).
 */
export interface McpUpstreamRow {
  id: string;
  url: string;
  allowPrivateRanges: boolean | null;
  name?: string;
  transport?: McpUpstreamTransport;
  stdioCommand?: string | null;
  stdioArgs?: string[] | null;
  stdioCommandDigest?: string | null;
}

/** The transport refusals: all of them OURS (never retried, never charged to
 * the breaker, audited, nothing spawned or sent), and each its own HTTP error
 * name (`err.error`). */
export const MCP_UPSTREAM_REFUSALS = {
  mcp_transport_disabled: "mcp-transport-disabled",
  mcp_stdio_command_refused: "mcp-stdio-command-refused",
  /** ADR-0190 I4: a stdio row whose image is not pinned by digest (e.g. an older host-path registration) */
  mcp_stdio_image_unpinned: "mcp-stdio-image-unpinned",
  /** ADR-0190 decision 7: no executor can run this stdio server at its required isolation class */
  execution_profile_unavailable: "execution-profile",
  mcp_sse_endpoint_refused: "mcp-sse-endpoint-refused",
  /** ADR-0204: the server has an upstream credential this process cannot open; nothing is sent without it */
  mcp_upstream_credential_unavailable: "mcp-upstream-credential-unavailable",
} as const;
export type McpUpstreamRefusal = keyof typeof MCP_UPSTREAM_REFUSALS;

/**
 * A SUBCLASS of the egress refusal on purpose: every caller already treats
 * `McpEgressBlockedError` as "our own adjudication" — the proxy's pre-hijack
 * 403 and post-hijack "Denied by policy", the retry classifier's
 * non-retryable `our_own_refusal`, the health probe's `skippedOurRefusal` —
 * so a transport refusal inherits all of it with no new branch to forget.
 * `decision.code` carries the refusal's code (the stdio rule, or the refusal
 * name) for the routes that echo it.
 */
export class McpUpstreamRefusedError extends McpEgressBlockedError {
  override readonly error: McpUpstreamRefusal;
  constructor(
    error: McpUpstreamRefusal,
    reason: string,
    readonly refusalCode?: StdioRefusalCode,
    /** ADR-0190 decision 7: the fixed reason of an `execution_profile_unavailable` refusal */
    readonly executionRefusal?: ExecutionRefusalReason | "execution_profile_mismatch" | StdioSessionFailure,
  ) {
    super({ ok: false, code: (refusalCode ?? error) as unknown as EgressDenyCode, reason });
    this.error = error;
    this.name = "McpUpstreamRefusedError";
    // not "egress blocked (…)": the post-hijack "Denied by policy: <message>"
    // must name the real refusal
    this.message = `${error}: ${reason}`;
  }
}

async function refuseUpstream(
  db: Db,
  row: { id: string; transport: McpUpstreamTransport },
  error: McpUpstreamRefusal,
  reason: string,
  detail: Record<string, unknown> = {},
  refusalCode?: StdioRefusalCode,
  executionRefusal?: ExecutionRefusalReason | "execution_profile_mismatch" | StdioSessionFailure,
  userId?: string | null,
): Promise<never> {
  await db.insert(auditLog).values({
    userId: userId ?? NIL_USER,
    serverId: row.id,
    objectType: "mcp_server",
    objectId: row.id,
    detail: { phase: "connect", transport: row.transport, error, ...(refusalCode ? { code: refusalCode } : {}), ...detail },
    effect: "deny",
    ruleId: MCP_UPSTREAM_REFUSALS[error],
    ruleChain: [],
    reason,
  });
  throw new McpUpstreamRefusedError(error, reason, refusalCode, executionRefusal);
}

type FullUpstreamRow = McpUpstreamRow & { transport: McpUpstreamTransport };

/** the row with its transport columns, read from the database when the caller
 * selected a narrower shape (the rescan and probe sweeps, older callers) */
async function withTransportColumns(db: Db, row: McpUpstreamRow): Promise<FullUpstreamRow> {
  if (row.transport !== undefined) return row as FullUpstreamRow;
  const [stored] = await db
    .select({
      name: mcpServers.name,
      transport: mcpServers.transport,
      stdioCommand: mcpServers.stdioCommand,
      stdioArgs: mcpServers.stdioArgs,
      stdioCommandDigest: mcpServers.stdioCommandDigest,
    })
    .from(mcpServers)
    .where(eq(mcpServers.id, row.id));
  // an id the database does not hold keeps the caller's url, which the egress
  // check adjudicates (a `stdio:` sentinel fails it — fails closed)
  return stored ? { ...row, ...stored } : { ...row, transport: rowTransport(row) };
}

/** what the destination decision allowed; `guardedMcpConnect` opens it */
export type UpstreamDestination =
  | { transport: "streamable_http" | "sse"; row: FullUpstreamRow; posture: McpEgressPosture }
  | {
      transport: "stdio";
      row: FullUpstreamRow;
      /** the closure image (content digest), its entry point and argv — re-checked from the stored row */
      image: string;
      command: string;
      args: string[];
    };

/**
 * THE DESTINATION HALF OF THE PREFLIGHT (`preflightUpstream` runs admission
 * first, then this) and of every connect. Re-read per call, never cached.
 *
 *  1. the org must allow the row's transport (`mcp_upstream_transports`) —
 *     an admin who takes SSE or stdio away stops existing servers at once;
 *  2. Streamable HTTP and SSE: the URL egress decision, exactly as before
 *     (audited `mcp-server-egress-blocked`, `McpEgressBlockedError`);
 *  3. stdio (ADR-0190 I4): the closure rules on the stored row — the image
 *     pinned by content digest, the entry point an absolute path inside it,
 *     argv bounded. Nothing on this host is looked at or started: the
 *     placement in a sandbox is `guardedMcpConnect`'s. The row's `stdio:<name>`
 *     URL is never handed to a fetch on this branch (and it fails the egress
 *     check on any path that forgets to branch, so such a path fails closed).
 */
export async function checkUpstreamDestination(
  db: Db,
  serverRow: McpUpstreamRow,
  deps: McpEgressDeps = {},
): Promise<UpstreamDestination> {
  const row = await withTransportColumns(db, serverRow);
  const label = `MCP server '${row.name ?? row.id}'`;
  const org = await loadOrgSettings(db);
  const enabled = (org.mcpUpstreamTransports ?? []) as McpUpstreamTransport[];
  if (!enabled.includes(row.transport)) {
    await refuseUpstream(
      db,
      row,
      "mcp_transport_disabled",
      `${label} refused: the '${row.transport}' transport is not enabled for this organization ` +
        `(mcp_upstream_transports: ${JSON.stringify(enabled)}). An admin may enable it; nothing was started or sent.`,
      { enabledTransports: enabled },
    );
  }
  if (row.transport === "stdio") {
    const check = checkStdioClosure(row.stdioCommandDigest, row.stdioCommand, row.stdioArgs);
    if (!check.ok) {
      await refuseUpstream(
        db,
        row,
        check.code === "image_unpinned" ? "mcp_stdio_image_unpinned" : "mcp_stdio_command_refused",
        `${label} refused (${check.code}): ${check.detail}. ` +
          (check.code === "image_unpinned"
            ? "A stdio server registered before isolation ran from a path on the gateway host; it must be re-registered " +
              "with a closure image. Nothing was started."
            : "Nothing was started."),
        { command: typeof row.stdioCommand === "string" ? row.stdioCommand.slice(0, 512) : null },
        check.code,
      );
      throw new Error("unreachable");
    }
    return { transport: "stdio", row, image: check.image, command: check.command, args: check.args };
  }
  const { decision, posture } = await checkMcpServerUrl(db, row.url, row.allowPrivateRanges, deps);
  if (!decision.ok) {
    await auditMcpEgressDenied(db, {
      serverId: row.id,
      url: row.url,
      phase: "connect",
      decision,
      reason: `MCP upstream connect refused: ${decision.reason}`,
      openByDefault: posture.openByDefault,
    });
    throw new McpEgressBlockedError(decision);
  }
  return { transport: row.transport, row, posture };
}

/** a deadline the SDK's own timers do not cover (SSE waiting for its
 * `endpoint` event, a stdio child that never answers) — on expiry the
 * transport is closed (the child killed) and a `TimeoutError` is raised, the
 * shape `isDeadlineError` already reads as a deadline */
function withDeadline<T>(work: Promise<T>, ms: number, what: string, onExpire: () => void): Promise<T> {
  work.catch(() => {}); // the loser of the race must not surface as unhandled
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onExpire();
      reject(new DOMException(`${what} did not complete within ${ms}ms`, "TimeoutError"));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

function connectOutcome(err: unknown): MetricUpstreamOutcome {
  if (err instanceof McpEgressBlockedError) return "refused";
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) return "timeout";
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "error";
}

/**
 * CONNECT TIME — the guarded replacement for the old bare
 * `connectUpstream(serverRow.url)`. Runs the destination decision on the
 * CURRENT posture (audits and throws on refusal with nothing leaving the box
 * and nothing started), then opens the row's transport: Streamable HTTP and
 * SSE through the guarded fetch (every request re-validated, pinned to the
 * validated addresses, redirect-refused), stdio as one capped, governed child
 * process. Every outcome is observed for `/metrics`.
 */
export async function guardedMcpConnect(
  db: Db,
  serverRow: McpUpstreamRow,
  deps: McpEgressDeps = {},
): Promise<Client> {
  const startedAt = Date.now();
  let transportLabel: McpUpstreamTransport = rowTransport(serverRow);
  const observe = (outcome: MetricUpstreamOutcome) =>
    observeUpstream({ serverId: serverRow.id, transport: transportLabel, outcome }, Date.now() - startedAt);

  let dest: UpstreamDestination;
  try {
    dest = await checkUpstreamDestination(db, serverRow, deps);
  } catch (err) {
    observe(connectOutcome(err));
    throw err;
  }
  transportLabel = dest.transport;
  const label = `MCP server '${dest.row.name ?? dest.row.id}'`;
  const deadlineMs = deps.connectDeadlineMs ?? timeouts().mcpConnectMs;

  let launch: UpstreamLaunch;
  if (dest.transport === "stdio") {
    // ADR-0190 I4: decision 7 for this connect, then a sandbox whose per-placement report the gateway accepted.
    // There is NO in-process fallback: no executor at the required class is a refusal (audited, 409 envelope).
    const ctx = deps.placement ?? null;
    // a governed tools/call decided its placement in its own decision transaction: attach to that offer's session.
    // Every other connect (a manifest sync, a protocol method) is placed here, with its own audited decision 7.
    const placed = ctx?.linkedOfferId
      ? await attachLinkedStdioSession(db, ctx.linkedOfferId, deps.placementTimeoutMs ?? deadlineMs, ctx.userId ?? null)
      : await placeStdioSession(db, {
      userId: ctx?.userId ?? null,
      projectId: ctx?.projectId ?? null,
      agent: ctx?.agent ?? null,
      parentGrantId: ctx?.parentGrantId ?? null,
      // ADR-0190 owner decision C: only an interactive person's own call may use a relaxation (absent = never)
      interactivePerson: ctx?.interactivePerson === true,
      mcpServerId: dest.row.id,
      imageDigest: dest.image,
      workload: { command: dest.command, args: dest.args },
      // the placement (offer, sandbox start, accepted report) is part of the connect, inside its deadline
      timeoutMs: deps.placementTimeoutMs ?? deadlineMs,
    });
    if (placed.kind === "refused") {
      observe("refused");
      await refuseUpstream(
        db,
        dest.row,
        "execution_profile_unavailable",
        `${label} refused (${placed.reason}): ${stdioRefusalSentence(placed.reason)} Nothing was started on the gateway host, ` +
          `and nothing reached the server.`,
        { reason: placed.reason, placementId: placed.placementId, refusalRuleId: "execution-profile" },
        undefined,
        placed.reason,
        ctx?.userId ?? null,
      );
    }
    launch = { transport: "stdio", session: (placed as Extract<typeof placed, { kind: "placed" }>).session };
  } else {
    // ADR-0204: the server's static credential, read fresh for this connect. One that cannot be opened refuses the
    // connect (our own refusal, audited) rather than send without it.
    const opened = await openUpstreamCredential(db, dest.row.id);
    if (!opened.ok) {
      observe("refused");
      await refuseUpstream(
        db,
        dest.row,
        "mcp_upstream_credential_unavailable",
        `${label} refused: its upstream credential cannot be opened (${opened.reason === "data_key_unavailable" ? "the data key is not configured" : "it does not decrypt under the configured data key"}). ` +
          `Nothing was sent. An admin may set the credential again.`,
        { reason: opened.reason },
      );
    }
    const credential = opened.ok ? opened.credential : null;
    const guarded = createGuardedFetch({
      allowList: dest.posture.allowList,
      privateLan: { openByDefault: dest.posture.openByDefault },
      ...(deps.resolve ? { resolve: deps.resolve } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      // ADR-0188 S8: an assertion's "issued" row is written once the destination is allowed, before it leaves
      ...(deps.outboundIdentity ? { beforeSend: (init?: RequestInit) => deps.outboundIdentity!.beforeSend(init) } : {}),
    });
    const asserted = deps.outboundIdentity ? (identityAssertionMiddleware(deps.outboundIdentity)(guarded) as typeof fetch) : guarded;
    launch = {
      transport: dest.transport,
      url: dest.row.url,
      // ADR-0204: OUTSIDE the assertion's middleware, so its holder still receives the init the guarded fetch is given;
      // set only for the registered origin, and the guarded fetch refuses every redirect
      fetch: credential ? (upstreamCredentialMiddleware(credential, dest.row.url)(asserted) as typeof fetch) : asserted,
    };
  }

  const client = new Client({ name: "regulait-gateway", version: "0.1.0" });
  // ROADMAP G2 — a deadline on opening the session. This is the top of every
  // `POST /mcp/:serverId`, BEFORE any JSON-RPC is read, so without a bound an
  // upstream that accepts the socket and never answers `initialize` hangs the
  // caller before the governance layer has said anything at all.
  //
  // Streamable HTTP: `RequestOptions.timeout` bounds the `initialize`
  // exchange and the transport's AbortSignal bounds the HTTP request (see
  // `openTransport`) — unchanged. SSE and stdio: the same `initialize` bound,
  // plus a deadline around the WHOLE connect, because their `start()` (the
  // event stream's `endpoint` event, the child's spawn) is outside the SDK's
  // request timer; on expiry the transport is closed and a child is killed.
  const transport = openTransport(launch, { deadlineMs });
  try {
    if (launch.transport === "streamable_http") {
      await client.connect(transport, { timeout: deadlineMs });
    } else {
      await withDeadline(
        client.connect(transport, { timeout: deadlineMs }),
        deadlineMs,
        `${label} (${launch.transport}) session handshake`,
        () => void transport.close().catch(() => {}),
      );
    }
  } catch (err) {
    if (launch.transport !== "streamable_http") await transport.close().catch(() => {});
    if (launch.transport === "sse" && isSseCrossOriginRefusal(err)) {
      observe("refused");
      await refuseUpstream(
        db,
        dest.row,
        "mcp_sse_endpoint_refused",
        `${label} refused: its SSE stream named a message endpoint on another origin. Only the registered ` +
          `origin may be reached; nothing was sent there.`,
      );
    }
    observe(connectOutcome(err));
    throw err;
  }
  observe("ok");
  return client;
}

/** the plain-language sentence for each isolation refusal of a stdio connect (decision 7's fixed reasons) */
export function stdioRefusalSentence(reason: ExecutionRefusalReason | "execution_profile_mismatch" | StdioSessionFailure): string {
  switch (reason) {
    case "no_executor":
      return "No sandbox executor is available to run this stdio server. An administrator must register an executor that attests the required isolation.";
    case "attestation_stale":
      return "The sandbox executors have not proved their isolation recently enough. The executor's next self-test restores it.";
    case "class_below_required":
      return "The available sandbox isolation is weaker than this call requires, and a call is never run below its required isolation.";
    case "executor_quarantined":
      return "Every executor that could run this server is quarantined after a failed check. An administrator must review and re-enable one.";
    case "profile_retired":
      return "The execution profile assigned to this server has been retired. An administrator must assign a current profile.";
    case "policy_unresolved":
      return "The isolation this call needs could not be worked out: the call must name a project whose AI use cases give it a data sensitivity.";
    case "execution_profile_mismatch":
      return "The sandbox did not match its execution profile, so it was stopped before receiving any input and its executor was quarantined.";
    // ADR-0190 I4 (review lows): not decision 7 refusals, each labelled as what it is
    case "placement_timeout":
      return "The sandbox executor did not confirm the sandbox before the call's deadline, so the placement was withdrawn and the sandbox, if one started, got no input.";
    case "session_lost":
      return "The gateway no longer holds this call's sandbox session (it was abandoned or its executor side was lost); this is the gateway's own refusal, not the server's failure.";
  }
}

// ===========================================================================
// ADR-0185 G4 — WRITE TIME: the transport rules at registration and update
// ===========================================================================

export type McpTransportWriteResult =
  | { ok: true; stdio: { command: string; args: string[]; digest: string } | null }
  | {
      ok: false;
      status: 400 | 422;
      body: { error: McpUpstreamRefusal; detail: string; code?: StdioRefusalCode };
    };
/* ADR-0190 I4: `stdio.digest` is the closure image's content digest (stored in `stdio_command_digest`). */

/**
 * The transport half of `POST`/`PATCH /v1/servers`, in one call (the
 * `refuseMcpServerWrite` shape): the org's transport list first (422
 * `mcp_transport_disabled`), then for stdio the closure rules (400
 * `mcp_stdio_image_unpinned` for an image not pinned by digest, 400
 * `mcp_stdio_command_refused` with `code` for the entry point or argv). On
 * allow, a stdio server's pinned image digest is returned. Nothing on the
 * gateway host is looked at (ADR-0190 I4). Every refusal is audited; nothing is saved.
 */
export async function checkMcpTransportWrite(
  db: Db,
  args: {
    transport: McpUpstreamTransport;
    stdio?: { image?: unknown; command: string; args: unknown } | undefined;
    userId?: string | null;
    serverId?: string | null;
    phase: "registration" | "update";
    label: string;
  },
): Promise<McpTransportWriteResult> {
  const refuse = async (
    status: 400 | 422,
    error: McpUpstreamRefusal,
    detail: string,
    extra: Record<string, unknown> = {},
    code?: StdioRefusalCode,
  ): Promise<McpTransportWriteResult> => {
    await db.insert(auditLog).values({
      userId: args.userId ?? NIL_USER,
      ...(args.serverId ? { serverId: args.serverId } : {}),
      objectType: "mcp_server",
      objectId: args.serverId ?? null,
      detail: { phase: args.phase, transport: args.transport, error, ...(code ? { code } : {}), ...extra },
      effect: "deny",
      ruleId: MCP_UPSTREAM_REFUSALS[error],
      ruleChain: [],
      reason: `${args.label} refused: ${detail}`,
    });
    return { ok: false, status, body: { error, detail: `${detail} Nothing was saved.`, ...(code ? { code } : {}) } };
  };
  const org = await loadOrgSettings(db);
  const enabled = (org.mcpUpstreamTransports ?? []) as McpUpstreamTransport[];
  if (!enabled.includes(args.transport)) {
    return refuse(
      422,
      "mcp_transport_disabled",
      `the '${args.transport}' transport is not enabled for this organization (mcp_upstream_transports: ` +
        `${JSON.stringify(enabled)}). An admin may enable it in the org settings.`,
      { enabledTransports: enabled },
    );
  }
  if (args.transport !== "stdio") return { ok: true, stdio: null };
  if (!args.stdio) {
    return refuse(400, "mcp_stdio_command_refused", "a stdio server needs a closure image and a command.", {}, "not_absolute");
  }
  const check = checkStdioClosure(args.stdio.image, args.stdio.command, args.stdio.args);
  if (!check.ok) {
    return refuse(
      400,
      check.code === "image_unpinned" ? "mcp_stdio_image_unpinned" : "mcp_stdio_command_refused",
      `${check.detail} (${check.code}).`,
      { command: typeof args.stdio.command === "string" ? args.stdio.command.slice(0, 512) : null },
      check.code,
    );
  }
  return { ok: true, stdio: { command: check.command, args: check.args, digest: check.image } };
}
