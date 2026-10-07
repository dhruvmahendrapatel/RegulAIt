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
import type { McpUpstreamTransport } from "@regulait/shared";
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
  acquireStdioSlot,
  checkStdioCommand,
  isSseCrossOriginRefusal,
  loadStdioHostPolicy,
  openTransport,
  rowTransport,
  STDIO_ALLOWED_DIRS_ENV,
  STDIO_MAX_PROCS_ENV,
  type StdioRefusalCode,
  type UpstreamLaunch,
} from "./mcp-transports.js";
import { observeUpstream, type MetricUpstreamOutcome } from "./metrics.js";
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
  mcp_stdio_unavailable: "mcp-stdio-unavailable",
  mcp_stdio_command_refused: "mcp-stdio-command-refused",
  mcp_stdio_digest_mismatch: "mcp-stdio-digest-mismatch",
  mcp_stdio_busy: "mcp-stdio-busy",
  mcp_sse_endpoint_refused: "mcp-sse-endpoint-refused",
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
): Promise<never> {
  await db.insert(auditLog).values({
    userId: NIL_USER,
    serverId: row.id,
    objectType: "mcp_server",
    objectId: row.id,
    detail: { phase: "connect", transport: row.transport, error, ...(refusalCode ? { code: refusalCode } : {}), ...detail },
    effect: "deny",
    ruleId: MCP_UPSTREAM_REFUSALS[error],
    ruleChain: [],
    reason,
  });
  throw new McpUpstreamRefusedError(error, reason, refusalCode);
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
      realCommand: string;
      args: string[];
      allowedDir: string;
      maxProcs: number;
    };

/**
 * THE DESTINATION HALF OF THE PREFLIGHT (`preflightUpstream` runs admission
 * first, then this) and of every connect. Re-read per call, never cached.
 *
 *  1. the org must allow the row's transport (`mcp_upstream_transports`) —
 *     an admin who takes SSE or stdio away stops existing servers at once;
 *  2. Streamable HTTP and SSE: the URL egress decision, exactly as before
 *     (audited `mcp-server-egress-blocked`, `McpEgressBlockedError`);
 *  3. stdio: the host opt-in, then the command rules on the file as it is
 *     NOW, then the pinned digest. The row's `stdio:<name>` URL is never
 *     handed to a fetch on this branch (and it fails the egress check on any
 *     path that forgets to branch, so such a path fails closed).
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
    const policy = await loadStdioHostPolicy();
    if (policy.allowedDirs.length === 0) {
      await refuseUpstream(
        db,
        row,
        "mcp_stdio_unavailable",
        `${label} refused: this host has not enabled stdio upstreams (${STDIO_ALLOWED_DIRS_ENV} names no ` +
          `existing directory). Nothing was started.`,
      );
    }
    if (!row.stdioCommand || !row.stdioCommandDigest || !Array.isArray(row.stdioArgs)) {
      await refuseUpstream(db, row, "mcp_stdio_command_refused", `${label} refused: the stored stdio command is incomplete. Nothing was started.`, {}, "not_absolute");
    }
    const check = await checkStdioCommand(row.stdioCommand!, row.stdioArgs, policy);
    if (!check.ok) {
      await refuseUpstream(
        db,
        row,
        "mcp_stdio_command_refused",
        `${label} refused (${check.code}): ${check.detail}. Nothing was started.`,
        { command: row.stdioCommand },
        check.code,
      );
      throw new Error("unreachable");
    }
    if (check.digest !== row.stdioCommandDigest) {
      await refuseUpstream(
        db,
        row,
        "mcp_stdio_digest_mismatch",
        `${label} refused: the command file changed since it was registered (sha256 ${check.digest} ≠ pinned ` +
          `${row.stdioCommandDigest}). An admin must review the new binary and re-pin it. Nothing was started.`,
        { command: row.stdioCommand, pinnedDigest: row.stdioCommandDigest, observedDigest: check.digest },
      );
    }
    return {
      transport: "stdio",
      row,
      realCommand: check.realCommand,
      args: [...(row.stdioArgs as string[])],
      allowedDir: check.allowedDir,
      maxProcs: policy.maxProcs,
    };
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
    // ONE PROCESS PER REQUEST, capped process-wide. A full host is our own
    // refusal (audited, never charged to the upstream's breaker).
    const release = acquireStdioSlot(dest.maxProcs);
    if (!release) {
      observe("refused");
      await refuseUpstream(
        db,
        dest.row,
        "mcp_stdio_busy",
        `${label} refused: this host already runs its maximum of ${dest.maxProcs} stdio upstream process(es) ` +
          `(${STDIO_MAX_PROCS_ENV}). Retry when one finishes; nothing was started.`,
        { maxProcs: dest.maxProcs },
      );
    }
    launch = {
      transport: "stdio",
      realCommand: dest.realCommand,
      args: dest.args,
      allowedDir: dest.allowedDir,
      release: release!,
    };
  } else {
    launch = {
      transport: dest.transport,
      url: dest.row.url,
      fetch: createGuardedFetch({
        allowList: dest.posture.allowList,
        privateLan: { openByDefault: dest.posture.openByDefault },
        ...(deps.resolve ? { resolve: deps.resolve } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      }),
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

/**
 * The transport half of `POST`/`PATCH /v1/servers`, in one call (the
 * `refuseMcpServerWrite` shape): the org's transport list first (422
 * `mcp_transport_disabled`), then for stdio the host opt-in (422
 * `mcp_stdio_unavailable`) and the command rules (400
 * `mcp_stdio_command_refused` with `code`). On allow, a stdio server's pinned
 * digest is returned. Every refusal is audited; nothing is saved.
 */
export async function checkMcpTransportWrite(
  db: Db,
  args: {
    transport: McpUpstreamTransport;
    stdio?: { command: string; args: unknown } | undefined;
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
  const policy = await loadStdioHostPolicy();
  if (policy.allowedDirs.length === 0) {
    return refuse(
      422,
      "mcp_stdio_unavailable",
      `this host has not enabled stdio upstreams: ${STDIO_ALLOWED_DIRS_ENV} names no existing directory.`,
    );
  }
  if (!args.stdio) {
    return refuse(400, "mcp_stdio_command_refused", "a stdio server needs a command.", {}, "not_absolute");
  }
  const check = await checkStdioCommand(args.stdio.command, args.stdio.args, policy);
  if (!check.ok) {
    return refuse(
      400,
      "mcp_stdio_command_refused",
      `${check.detail} (${check.code}).`,
      { command: typeof args.stdio.command === "string" ? args.stdio.command.slice(0, 512) : null },
      check.code,
    );
  }
  return {
    ok: true,
    stdio: { command: args.stdio.command, args: [...(args.stdio.args as string[])], digest: check.digest },
  };
}
