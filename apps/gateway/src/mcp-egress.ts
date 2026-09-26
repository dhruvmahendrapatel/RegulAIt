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
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auditLog, type Db } from "@regulait/db";
import {
  checkEgress,
  createGuardedFetch,
  type EgressAllowEntry,
  type EgressDecision,
  type EgressDenied,
  type EgressResolver,
} from "./egress-guard.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { loadOrgSettings } from "./org-settings.js";
import { timeouts } from "./timeouts.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

export interface McpEgressDeps {
  resolve?: EgressResolver;
  fetchImpl?: typeof fetch;
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

/**
 * CONNECT TIME — the guarded replacement for the old bare
 * `connectUpstream(serverRow.url)`. Checks the CURRENT posture, audits and
 * throws on refusal with nothing leaving the box, and on allow hands the MCP
 * client transport the guarded fetch, so every HTTP request of the session is
 * re-validated, pinned to the validated addresses, and redirect-refused.
 */
export async function guardedMcpConnect(
  db: Db,
  serverRow: { id: string; url: string; allowPrivateRanges: boolean | null },
  deps: McpEgressDeps = {},
): Promise<Client> {
  const { decision, posture } = await checkMcpServerUrl(
    db,
    serverRow.url,
    serverRow.allowPrivateRanges,
    deps,
  );
  if (!decision.ok) {
    await auditMcpEgressDenied(db, {
      serverId: serverRow.id,
      url: serverRow.url,
      phase: "connect",
      decision,
      reason: `MCP upstream connect refused: ${decision.reason}`,
      openByDefault: posture.openByDefault,
    });
    throw new McpEgressBlockedError(decision);
  }
  const guardedFetch = createGuardedFetch({
    allowList: posture.allowList,
    privateLan: { openByDefault: posture.openByDefault },
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const client = new Client({ name: "regulait-gateway", version: "0.1.0" });
  // ROADMAP G2 — a deadline on opening the session. This is the top of every
  // `POST /mcp/:serverId`, BEFORE any JSON-RPC is read, so without a bound an
  // upstream that accepts the socket and never answers `initialize` hangs the
  // caller before the governance layer has said anything at all — and holds a
  // gateway socket for as long as the client is willing to wait.
  //
  // Both halves are needed and they stop different things. `RequestOptions
  // .timeout` bounds the `initialize` EXCHANGE, which the SDK enforces at the
  // protocol level; the AbortSignal bounds the underlying HTTP request, which
  // is what a connect to a black-holed address hangs on and which the SDK's
  // own timer never sees. The signal goes through `requestInit` because the
  // guarded fetch already forwards a caller-supplied signal
  // (`pinned-fetch.ts`) and simply had nobody supplying one.
  const deadlineMs = timeouts().mcpConnectMs;
  await client.connect(
    new StreamableHTTPClientTransport(new URL(serverRow.url), {
      fetch: guardedFetch,
      requestInit: { signal: AbortSignal.timeout(deadlineMs) },
    }),
    { timeout: deadlineMs },
  );
  return client;
}
