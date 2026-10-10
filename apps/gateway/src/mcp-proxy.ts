import type { FastifyInstance } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  and,
  approvals,
  asc,
  auditLog,
  costEvents,
  eq,
  gt,
  governancePolicyEpoch,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  isNull,
  mcpServers,
  mcpTools,
  or,
  sql,
  usageEvents,
  userAgentPolicies,
  type Db,
} from "@regulait/db";
import { visibleTools, type Decision, type GovernedActor, type ToolRef } from "@regulait/policy-kernel";
import { DelegationRefusedError, settleDelegationCharge } from "./delegation.js";
import { actorColumns, actorForGrant, delegationRefusalDecision, usdToMicros } from "./in-process-delegation.js";
import { selectTools } from "@regulait/optimizer-kernel";
import type { ModelToolDef } from "@regulait/model-provider";
import {
  APPROVAL_SIGNATURE_RECHECK_FAILED_RULE,
  approvalArgumentsPreview,
  setToolPriceSchema,
  guardrailCategoryList,
  guardrailWithheldMarker,
  toolPayloadPreview,
  admissionFindingSummary,
  type PiiHit,
  type PreparedPiiApproval,
  type ScannableTool,
  type McpUpstreamTransport,
} from "@regulait/shared";
// ADR-0070 — the tool span. A governed tool call is the other half of what a
// trace tree must show: which tool the model asked for, with which arguments,
// what came back, and — the row that matters — the ones governance refused.
import { beginTrace, finishTrace, recordSpan, type TraceContext } from "./tracing.js";
import {
  flattenFindings,
  guardrailOutcome,
  recordGuardrailDecision,
  resolveGuardrailPolicy,
  runGuardrails,
  type DispatchGuardrails,
} from "./guardrails.js";
import { approvalTargetForServer, governedEvaluate, type RetiredApproval } from "./governed-evaluate.js";
import { decodeMcpBlobs, prepareMcpPiiAction, redactMcpResult, scannableMcpText } from "./mcp-pii.js";
import { abacPrincipalFromRequest, type AbacPrincipalContext } from "./abac-principal.js";
import {
  auditMcpUpstreamUnreachable,
  checkUpstreamDestination,
  guardedMcpConnect,
  McpEgressBlockedError,
  type McpUpstreamRow,
} from "./mcp-egress.js";
import { timeouts } from "./timeouts.js";
import {
  attemptsForToolKind,
  classifyUpstreamError,
  isDeadlineError,
  newRetryReport,
  withUpstreamRetry,
  type RetryReport,
} from "./upstream-retry.js";
import {
  breakerAdmits,
  recordUpstreamFailure,
  recordUpstreamSuccess,
} from "./upstream-breaker.js";
// ADR-0097 — ADMISSION SCANNING. ADR-0043 governs the DESTINATION; this governs
// what comes back. The gate runs at the top of connectUpstream (before the only
// thing that opens an outbound socket) and the scan runs inside
// syncUpstreamTools (before the only thing that persists a tool description).
import {
  assertAdmitted,
  McpAdmissionHeldError,
  recordManifestScan,
  type McpAdmissionTrigger,
} from "./mcp-admission.js";
import { loadEntitlements } from "./entitlements.js";
// ADR-0185 G3 — the non-tool MCP methods
import {
  executeGovernedProtocolCall,
  installProtocolSurface,
  isReservedToolName,
  protocolCapabilities,
  protocolOutcomeResult,
} from "./mcp-protocol.js";
import { effectiveTechniqueMode, loadOrgSettings } from "./org-settings.js";
import { CREDENTIAL_AUDIENCE_ERROR, CREDENTIAL_AUDIENCE_RULE_ID, refuseOutboundCredentialAudience } from "./outbound-audience.js";
import {
  auditQuorumUnsatisfiableAtQueue,
  recheckApprovalSignatures,
  reusePendingToolApproval,
  supersedeOnRecheckFailure,
  toolApprovalRequirements,
  type CallFacts,
} from "./approval-signatures.js";
import {
  assertProjectAttribution,
  enforcePII,
  piiInternationalCategories,
  piiCategoryList,
  piiWithheldMarker,
  preDispatchProjectGate,
  projectMcpMode,
  projectPiiMode,
  type PiiMode,
} from "./projects.js";
import { z } from "zod";

const proxyParams = z.object({ serverId: z.string().uuid() });
/**
 * ADR-0019 pillar-5 attribution for the MCP entry point. The project rides an
 * HTTP HEADER rather than the JSON-RPC body, deliberately:
 *  - the body is the MCP protocol's own envelope; smuggling a RegulAIt field
 *    into `params` would make our proxy a non-conformant MCP server and would
 *    have to be re-injected by every client's SDK call site, per tool call;
 *  - `StreamableHTTPClientTransport` takes `requestInit.headers`, so a client
 *    sets it ONCE when constructing the transport and every tools/call on that
 *    session is attributed — which matches how a session belongs to a project;
 *  - it keeps attribution at the same layer as authorization (the API key is
 *    already a header), so both are validated before the transport is hijacked.
 * Absent header = an UNATTRIBUTED call. Since ADR-0024 (O11) it is still
 * METERED — the same usage/pricing row, with projectId NULL, surfaced in the
 * explicit "Unattributed" bucket — but carries no PII enforcement (there is no
 * project policy to enforce) and can never touch a project budget. An admin
 * can refuse unattributed calls outright with require_mcp_attribution.
 */
export /** ADR-0124 — a rule id may be a row id or a symbolic name; only the first
 * belongs in a uuid column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PROJECT_HEADER = "x-regulait-project-id";
const proxyHeaders = z.object({
  [PROJECT_HEADER]: z.string().uuid().optional(),
});
// OPTIMIZATION §8: an optional declared intent for lazy tool-loading. MCP's
// tools/list carries no request text, so the signal rides on the proxy URL.
const proxyQuery = z.object({ intent: z.string().max(2000).optional() });

// Tools without an explicit readOnlyHint are treated as writes — the
// conservative default under §3's read/write distinction.
function toolKind(tool: Tool): "read" | "write" {
  return tool.annotations?.readOnlyHint === true ? "read" : "write";
}

/** ADR-0043: the upstream connect now runs the egress guard EVERY time — the
 * per-server private-range flag (org default when null) opens ordinary private
 * LAN only, IMDS/link-local is refused unconditionally, and a public MCP host
 * needs an egress_allow_hosts entry. A refusal is audited and throws
 * McpEgressBlockedError with nothing leaving the box; on allow, every HTTP
 * request of the session goes through the pinned guarded fetch. */
/**
 * AER-024 — ADMISSION AND EGRESS ARE ADJUDICATED BEFORE THE BREAKER IS ASKED.
 *
 * The breaker (ADR-0126) used to be consulted first on both upstream paths,
 * and an open breaker answered `503 mcp_upstream_circuit_open` before
 * `connectUpstream` ever ran `assertAdmitted` (ADR-0097) or the egress URL
 * check (ADR-0043). So a server that was HELD by admission, or that pointed
 * at a destination this deployment refuses to reach, hid behind "upstream
 * unavailable" for as long as its circuit stayed open: the caller was told to
 * retry later, no deny row was filed, and a half-open probe election could be
 * spent on a request that was never permitted to go out.
 *
 * This preflight runs the SAME two gates `connectUpstream` runs, in the same
 * order (admission first — a held server is refused with no DNS lookup, the
 * standard ADR-0097 holds itself to — then the egress decision), and it is
 * SIDE-EFFECT-FREE TOWARDS THE UPSTREAM in the sense that matters: nothing
 * is connected to, nothing is sent, and the breaker is neither read nor
 * elected. It is NOT network-free — for an admitted server the egress check
 * resolves a hostname URL (one DNS lookup, bounded by the guard's deadline),
 * and that lookup now happens on every request while the breaker is open,
 * where the old order answered 503 at once. A held server is refused before
 * any lookup. A refusal is audited the way the connect-time guard audits it
 * (`mcp-admission-held` / `mcp-server-egress-blocked`, phase `connect`) and
 * thrown as the same error class, so every caller's existing mapping of
 * those two refusals applies unchanged. `connectUpstream` still re-adjudicates
 * both gates on its own (a retry attempt must never become a bypass); on the
 * allow path that is one extra read, on the refuse path it is never reached.
 */
export async function preflightUpstream(
  db: Db,
  serverRow: McpUpstreamRow,
): Promise<void> {
  await assertAdmitted(db, serverRow.id);
  // ADR-0185 G4: the destination decision (today the URL egress check, audited
  // and thrown exactly as before) — the G4 slice branches it on transport
  await checkUpstreamDestination(db, serverRow);
}

/**
 * B3S-01 (security review of batch 3) — A STDIO UPSTREAM IS NEVER STARTED FOR
 * A CALLER WITH NO ENTITLEMENT ON IT.
 *
 * Two connects happen before any per-user decision: the manifest connect a
 * `tools/list` needs, and the one-off sync a `tools/call` on a tool missing
 * from the stored manifest does. Over HTTP/SSE that is a request to an
 * admin-registered, egress-guarded URL, and an ungranted caller's
 * `tools/list` refreshing the inventory is pinned product behaviour
 * (mcp-proxy.test.ts "lists no tools for a user with no grants, but syncs the
 * inventory"; the OIDC-egress, breaker and retry suites drive the upstream the
 * same way). Over stdio the same connect SPAWNS A PROCESS on the gateway host
 * and holds one of its few process slots, so any API-key holder could start
 * it at will. So for stdio, those pre-decision connects require the caller to
 * hold at least one entitlement on the server (a tool grant, a read-only-all
 * server grant, or either through a role; a protocol grant counts). A connect
 * that follows an allow decision is unaffected.
 */
export const MCP_STDIO_NO_ENTITLEMENT_RULE_ID = "mcp-stdio-no-entitlement";

export async function holdsAnyEntitlement(db: Db, userId: string, serverId: string): Promise<boolean> {
  const e = await loadEntitlements(db, userId, serverId);
  return e.toolGrants.length + e.serverGrants.length + (e.roleToolGrants?.length ?? 0) + (e.roleServerGrants?.length ?? 0) > 0;
}

/** the refusal (one deny audit row) for a stdio pre-decision connect by a caller with no entitlement */
export async function refuseStdioWithoutEntitlement(
  db: Db,
  args: { userId: string; serverId: string; toolName?: string | null; projectId?: string | null; phase: "tools/list" | "tools/call" },
): Promise<Decision> {
  const decision: Decision = {
    effect: "deny",
    ruleId: MCP_STDIO_NO_ENTITLEMENT_RULE_ID,
    ruleChain: [],
    reason:
      `stdio MCP server ${args.serverId}: the caller holds no entitlement on it, so the gateway does not start its ` +
      `process to ${args.phase === "tools/list" ? "list its tools" : "look up an unknown tool"}`,
  };
  await db.insert(auditLog).values({
    userId: args.userId,
    serverId: args.serverId,
    toolName: args.toolName ?? null,
    detail: { phase: "stdio-entitlement", method: args.phase, projectId: args.projectId ?? null, receiptClass: "decision" },
    ...decision,
  });
  return decision;
}

export async function connectUpstream(
  db: Db,
  serverRow: McpUpstreamRow,
  opts: { retry?: RetryReport; retryAttempts?: number } = {},
): Promise<Client> {
  // ADR-0128 — THE RETRY SEQUENCE WRAPS BOTH GATES, and that is the point of
  // putting it here rather than inside `guardedMcpConnect`. A handshake is
  // idempotent so it may be repeated; an egress block or an admission hold is
  // OUR adjudication, is classified non-retryable, and therefore exits on the
  // first attempt with the gates having run exactly once. Wrapping the gates
  // also means a retry cannot become a bypass: every attempt re-adjudicates.
  //
  // The budget for the WHOLE sequence is the one configured connect deadline,
  // so retrying never extends the bound an operator set — see upstream-retry.ts.
  return withUpstreamRetry(
    async ({ deadlineMs }) => {
      // ADR-0097 — THE ADMISSION GATE, and note the ORDER. It runs BEFORE
      // `guardedMcpConnect`, which is the only function in this codebase that
      // opens an outbound MCP socket, so a held server is refused with provably
      // zero outbound attempt — the same standard ADR-0043 holds itself to,
      // proven the same way (a recording resolver that must see no lookup at
      // all). Re-read per connect, never cached: the verdict recorded at the
      // last sync is not a fact about this request, and a row written straight
      // into Postgres must be adjudicated too.
      await assertAdmitted(db, serverRow.id);
      return guardedMcpConnect(db, serverRow, { connectDeadlineMs: deadlineMs });
    },
    {
      budgetMs: timeouts().mcpConnectMs,
      ...(opts.retryAttempts !== undefined ? { maxAttempts: opts.retryAttempts } : {}),
      ...(opts.retry ? { report: opts.retry } : {}),
    },
  );
}

/** The one governed tool-call primitive, shared by the MCP proxy route (a
 * human calling a tool) and pillar 7's tool-using worker loop (a governed
 * agent calling a tool mid-run). It does EXACTLY what the proxy handler did
 * inline: resolve the tool's read/write kind (syncing the upstream manifest
 * when unknown), run the full §3 governed evaluation, write the ONE audit row
 * for the decision, and then act on it — deny stops here; require_approval
 * dedupes/inserts the queue entry and stops; an already-approved entry is
 * consumed atomically before the call runs. Only an allow (with any approval
 * consumed) reaches the upstream. The function owns the upstream connect/close
 * lifecycle. It NEVER throws for a governance outcome — callers map the
 * discriminated result to their own surface (MCP errors for the proxy, error
 * tool_result turns for the loop), so the loop can react to a denial instead
 * of crashing. `dataKey` is accepted for signature parity with the dispatch
 * core; MCP upstreams authenticate via their registered URL, so it is unused
 * today. */
export type GovernedToolCallOutcome =
  | {
      kind: "allowed";
      content: unknown;
      pii?: McpPii;
      guardrails?: DispatchGuardrails;
      costUsd?: number | null;
    }
  | { kind: "unknown_tool" }
  /**
   * AER-022: this upstream is circuit-broken (ADR-0126) and nothing was
   * attempted. Distinct from every governance outcome around it because it says
   * nothing about the CALLER's entitlement — the call was fine and the server is
   * not — and distinct from a plain failure because we can say when to come back.
   */
  | { kind: "upstream_circuit_open"; reason: string; retryAfterMs: number }
  | { kind: "denied"; decision: Decision }
  | { kind: "pii_blocked"; reason: string; pii: McpPii }
  /** ADR-0042: a content-safety detector refused the tool ARGUMENTS. Distinct
   * from `denied` (entitlement) and `pii_blocked` (§8.4's own classifier) so a
   * caller — and the audit trail — can tell the three apart. */
  | { kind: "guardrail_blocked"; reason: string; guardrails: DispatchGuardrails }
  | { kind: "approval_required"; approvalId: string; decision: Decision }
  | { kind: "approval_consumed_race"; approvalId: string }
  /**
   * ADR-0105: a consent this call WOULD have spent had passed its
   * `expires_at`. The stale row is SUPERSEDED (visibly, with an audit fact
   * naming why) and, on the queueing path, a fresh approval carrying the
   * current digests is raised in its place — `requeuedApprovalId`. It is null
   * only on the narrow consumption race, where the replacement is raised by
   * the caller's retry rather than guessed at here.
   *
   * Distinct from `approval_required` because "your approval lapsed" and "you
   * never had one" are different things to tell a human, and distinct from
   * `approval_context_stale` because an expiry is a clock fact and a stale
   * context is a policy fact.
   */
  | {
      kind: "approval_expired";
      supersededApprovalIds: string[];
      requeuedApprovalId: string | null;
    }
  /**
   * ADR-0105: the POLICY that demanded the consent moved after it was signed —
   * a matched rule's active `config_versions` version changed, the required
   * approver changed, or the approval scope changed. Same visible disposition
   * as `approval_expired`: supersede with a reason, re-queue under the current
   * context.
   */
  | {
      kind: "approval_context_stale";
      supersededApprovalIds: string[];
      requeuedApprovalId: string | null;
    }
  /** ADR-0103: the ATTRIBUTED project's pillar-5 budget is exhausted, so the
   * project's dispatches are FROZEN and this tool call may not run (priced or
   * not — the amendment names it a project dispatch freeze, AER-002). Distinct from `denied` (entitlement) and from
   * the run/node budget the orchestrator enforces separately — this is the
   * PROJECT ledger, and it carries the same status/error the model path
   * returns so the two surfaces name the same condition identically. */
  | { kind: "budget_blocked"; status: number; error: string; detail?: string };

/** what spending an approved consent came to */
export type BoundApprovalSpend = "consumed" | "not_consumed" | "signature_recheck_failed";

/**
 * Consume only if the policy snapshot used to evaluate this call is still
 * current — and, ADR-0186 B, only if every approving passkey signature still
 * verifies against the call actually being run. The row is LOCKED, the
 * signatures are re-verified against digests recomputed from `call` (the
 * call's own arguments and context digests, target and tool), and only then
 * is it consumed. A failed recheck supersedes the approval, audits
 * `approval-signature-recheck-failed` and refuses the call, in the same
 * transaction. A passkey-mode tool-call approval spent without `call` facts
 * fails closed.
 */
export async function spendBoundApproval(
  db: Db,
  input: {
    approvalId: string;
    policyEpoch: number;
    approvalScope: "action" | "tool";
    argumentsDigest: string;
    contextDigest: string;
    /** ADR-0186 B: the target and tool of the call being run (the signed payload's other facts) */
    call?: { serverId?: string | null; connectorId?: string | null; toolName: string } | undefined;
  },
): Promise<BoundApprovalSpend> {
  return db.transaction(async (tx) => {
    const [generation] = await tx
      .select({ epoch: governancePolicyEpoch.epoch })
      .from(governancePolicyEpoch)
      .for("share");
    if (!generation || generation.epoch !== input.policyEpoch) return "not_consumed";
    const [row] = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.id, input.approvalId),
          eq(approvals.status, "approved"),
          ...(input.approvalScope === "action"
            ? [eq(approvals.argumentsDigest, input.argumentsDigest)]
            : []),
          eq(approvals.contextDigest, input.contextDigest),
          or(isNull(approvals.expiresAt), gt(approvals.expiresAt, sql`now()`))!,
        ),
      )
      .for("update");
    if (!row) return "not_consumed";
    const call: CallFacts | null = input.call
      ? { ...input.call, argumentsDigest: input.argumentsDigest, contextDigest: input.contextDigest }
      : null;
    const recheck = await recheckApprovalSignatures(tx, row, call);
    if (!recheck.ok) {
      await supersedeOnRecheckFailure(tx, row, call, recheck);
      return "signature_recheck_failed";
    }
    const consumed = await tx
      .update(approvals)
      .set({ status: "consumed" })
      .where(and(eq(approvals.id, input.approvalId), eq(approvals.status, "approved")))
      .returning({ id: approvals.id });
    return consumed.length === 1 ? "consumed" : "not_consumed";
  });
}

/** `spendBoundApproval`, answered as "was it consumed?" */
export async function consumeBoundApproval(
  db: Db,
  input: Parameters<typeof spendBoundApproval>[1],
): Promise<boolean> {
  return (await spendBoundApproval(db, input)) === "consumed";
}

/** ADR-0186 B: the refusal of a call whose approval failed the signature recheck */
export function signatureRecheckDenial(approvalId: string): Decision {
  return {
    effect: "deny",
    ruleId: APPROVAL_SIGNATURE_RECHECK_FAILED_RULE,
    ruleChain: [],
    reason:
      `approval '${approvalId}' was superseded: its approving signatures did not verify against this call, ` +
      "so nothing ran — re-submit to raise a fresh approval",
  };
}

/**
 * ADR-0105 — RETIRE A CONSENT THAT NO LONGER SATISFIES THE CALL, VISIBLY.
 *
 * A stale or expired approved row must not be silently skipped. Left sitting in
 * the queue marked `approved` it is a live-looking signature that the next
 * evaluation has to re-refuse, and that an approver reading the workbench has
 * no way to tell is dead. So it moves to `superseded` — a status the enum
 * ALREADY carries, so no DDL was needed — and the move is audited with the
 * reason named.
 *
 * `status = 'approved'` is in the predicate so this can never trample a row
 * that a concurrent caller consumed in the meantime: retiring is best-effort
 * about WHICH rows it moves, and exact about never moving one that was spent.
 *
 * Returns the ids actually retired.
 *
 * ADR-0173 batch 2b: exported for the connector write path, which retires a
 * stale connector consent the same way — `ctx.connector` names it, and the
 * audit row then sits on the connector instead of an MCP tool.
 */
export async function supersedeStaleConsent(
  db: Db,
  rows: readonly RetiredApproval[],
  ctx:
    | { userId: string; serverId: string; toolName: string; projectId: string | null; connector?: undefined }
    | { userId: string; connector: { id: string; name: string }; projectId: string | null; serverId?: undefined; toolName?: undefined },
): Promise<string[]> {
  const subject = ctx.connector ? `connector '${ctx.connector.name}'` : `tool '${ctx.toolName}'`;
  const retired: string[] = [];
  for (const row of rows) {
    const moved = await db
      .update(approvals)
      .set({
        status: "superseded",
        decisionReason:
          row.reason === "expired"
            ? "superseded: this approval passed its expiry before it was spent"
            : "superseded: the policy context this approval was granted under has changed",
      })
      .where(and(eq(approvals.id, row.id), eq(approvals.status, "approved")))
      .returning({ id: approvals.id });
    if (moved.length === 0) continue;
    retired.push(row.id);
    await db.insert(auditLog).values({
      userId: ctx.userId,
      ...(ctx.connector
        ? { objectType: "connector" as const, objectId: ctx.connector.id }
        : { serverId: ctx.serverId, toolName: ctx.toolName }),
      // the approval id rides in `detail.approvalId`, exactly as ADR-0046's
      // `approval-routed` / `approval-sla-breached` rows do, so "what happened
      // to this approval" stays ONE query on one objectType.
      detail: {
        phase: "consent-retired",
        approvalId: row.id,
        retirementReason: row.reason,
        projectId: ctx.projectId,
        receiptClass: "decision",
      },
      effect: "deny",
      ruleId: row.reason === "expired" ? "approval-expired" : "approval-context-stale",
      ruleChain: [],
      reason:
        row.reason === "expired"
          ? `approval '${row.id}' for ${subject} expired before it was spent and was superseded`
          : `approval '${row.id}' for ${subject} was granted under a policy context that has ` +
            `since changed (matched rules, their active config versions, the required approver or the ` +
            `approval scope) and was superseded`,
    });
  }
  return retired;
}

/** §8.4 PII outcome on an MCP tool call. COUNTS ONLY — inputHits/outputHits are
 * per-category counts, never the matched substrings (the same contract the
 * model and connector paths hold). */
export interface McpPii {
  mode: PiiMode;
  action: "block" | "warn" | "log" | "redact";
  inputHits: PiiHit[];
  outputHits: PiiHit[];
  withheld: boolean;
}


export async function executeGovernedToolCall(
  db: Db,
  _dataKey: string | undefined,
  args: {
    userId: string;
    serverId: string;
    toolName: string;
    arguments?: Record<string, unknown> | undefined;
    /** §5.1 Team-Lead ceiling: the tool NAMES this worker's lead chain permits.
     * null/undefined = no lead constraint (a human proxy call or a flat run).
     * Only ever narrows — a granted tool outside the ceiling is denied with
     * ruleId `lead-ceiling`, which flows into the audit trail distinctly. */
    ceilingTools?: readonly string[] | null;
    /** ADR-0019 pillar-5 attribution: the project this tool call bills to. The
     * CALLER validates it (assertProjectAttribution) before getting here.
     * null/undefined = unattributed — still metered (ADR-0024 O11: the usage
     * row lands with projectId NULL in the Unattributed bucket) but with no
     * PII enforcement, and it can never hit a project budget. */
    projectId?: string | null;
    /** ADR-0040: the session facts the ABAC principal bag needs (origin,
     * authentication strength). A session is a property of the REQUEST, so the
     * route supplies it; a worker loop with no HTTP request behind it supplies
     * nothing and the attributes degrade to the honest 'unknown'/false, never
     * to a silently-strong claim a policy could be fooled by. */
    principal?: AbacPrincipalContext;
    /** ADR-0070 — the trace this tool call's span hangs from. Absent/null =
     * record nothing (every pre-0070 caller, byte-identical). Supplied by the
     * MCP proxy route and by the orchestration worker loop, where a tool call
     * is a CHILD of the model turn that asked for it. */
    trace?: TraceContext | null | undefined;
    /** the model's own tool_use id, when the call came out of a worker loop —
     * stamped onto the span as OTel's `gen_ai.tool.call.id` */
    toolCallId?: string | undefined;
    /** ADR-0173 — correlation ids (e.g. the builder thread / tool step that
     * made this call) merged into the DECISION audit row's detail, so the
     * governed call is findable from the caller's own record. Never decides
     * anything; absent = byte-identical. */
    detail?: Record<string, unknown> | undefined;
    /**
     * ADR-0188 S4 (decision 6) — the delegation grant an in-process agent makes
     * this call under. When set, the call is decided for the sponsor `userId`
     * AND the stored actor chain, read fresh here (decision 17), and its price
     * is settled along the chain with the usage row (decision 22). Absent = a
     * person's own call (`actor: null`), byte-identical.
     */
    delegationGrantId?: string | undefined;
  },
): Promise<GovernedToolCallOutcome> {
  // ADR-0070 — the tool span. Wrapped exactly like the dispatch core's: the
  // governed body below is untouched, this times it and records ONE span from
  // whatever it returned. A refusal (entitlement, PII, guardrail, pending
  // approval) is a `denied` span carrying its reason, not an absent one.
  const traceStartedAt = new Date();
  const traceInput: { value?: Record<string, unknown> } = {};
  const outcome = await executeGovernedToolCallInner(db, _dataKey, args, traceInput);
  if (args.trace) {
    const denied =
      outcome.kind === "denied" ||
      outcome.kind === "pii_blocked" ||
      outcome.kind === "guardrail_blocked" ||
      // ADR-0103: a project-budget block is a REFUSAL, so it closes a `denied`
      // span carrying its reason — same treatment as pii_blocked, never an
      // absent span.
      outcome.kind === "budget_blocked" ||
      // ADR-0105: a lapsed or policy-stale consent is a REFUSAL, so it closes a
      // `denied` span carrying its reason — the same treatment ADR-0103 gives
      // budget_blocked, never an absent span.
      outcome.kind === "approval_expired" ||
      outcome.kind === "approval_context_stale" ||
      outcome.kind === "approval_required";
    const reason =
      outcome.kind === "denied"
        ? outcome.decision.reason
        : outcome.kind === "pii_blocked" || outcome.kind === "guardrail_blocked"
          ? outcome.reason
          : outcome.kind === "budget_blocked"
            ? `${outcome.error}${outcome.detail ? `: ${outcome.detail}` : ""}`
            : outcome.kind === "approval_required"
            ? `tool call requires approval '${outcome.approvalId}' before it may run`
            : outcome.kind === "approval_expired"
              ? `approval ${outcome.supersededApprovalIds.join(", ")} expired and was superseded` +
                (outcome.requeuedApprovalId
                  ? `; approval '${outcome.requeuedApprovalId}' now awaits sign-off`
                  : "")
              : outcome.kind === "approval_context_stale"
                ? `approval ${outcome.supersededApprovalIds.join(", ")} was granted under a policy ` +
                  `context that has since changed and was superseded` +
                  (outcome.requeuedApprovalId
                    ? `; approval '${outcome.requeuedApprovalId}' now awaits sign-off`
                    : "")
                : outcome.kind === "approval_consumed_race"
                  ? `approval '${outcome.approvalId}' was already consumed`
                  : outcome.kind === "unknown_tool"
                    ? `tool '${args.toolName}' is not in this server's manifest`
                    : null;
    const capture = args.trace.policy.captureContent;
    const max = args.trace.policy.previewMaxChars;
    await recordSpan(db, args.trace, {
      kind: "tool",
      name: args.toolName,
      status: denied ? "denied" : outcome.kind === "unknown_tool" ? "error" : "ok",
      statusReason: reason,
      startedAt: traceStartedAt,
      mcpServerId: args.serverId,
      costUsd: outcome.kind === "allowed" ? (outcome.costUsd ?? null) : null,
      // TOOL I/O. Arguments are what the model asked for; content is what the
      // governed path already decided the caller may see — on a PII/guardrail
      // withhold, that is the marker, not the payload.
      // ADR-0186 decision 32: arguments refused for carrying a credential are not stored
      inputText:
        capture && traceInput.value && !(outcome.kind === "denied" && outcome.decision.ruleId === CREDENTIAL_AUDIENCE_RULE_ID)
          ? toolPayloadPreview(traceInput.value, max)
          : null,
      outputText:
        capture && outcome.kind === "allowed" ? toolPayloadPreview(outcome.content, max) : null,
      contentWithheld:
        outcome.kind === "allowed"
          ? !!(outcome.pii?.withheld || outcome.guardrails?.withheld)
          : denied,
      attributes: {
        outcome: outcome.kind,
        ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
        ...(args.projectId ? { projectId: args.projectId } : {}),
      },
    });
  }
  return outcome;
}

async function executeGovernedToolCallInner(
  db: Db,
  _dataKey: string | undefined,
  args: Parameters<typeof executeGovernedToolCall>[2],
  traceInput: { value?: Record<string, unknown> },
): Promise<GovernedToolCallOutcome> {
  const { userId, serverId, toolName } = args;
  // ADR-0185 G3: `mcp:` names are protocol grants, never tools — a tool so
  // named (which admission refuses to store) must not ride a protocol grant
  if (isReservedToolName(toolName)) return { kind: "unknown_tool" };
  const projectId = args.projectId ?? null;
  const [preparationGeneration] = await db.select({ epoch: governancePolicyEpoch.epoch }).from(governancePolicyEpoch);
  const piiMode: PiiMode | null = await projectPiiMode(db, projectId);
  const piiIntl = await piiInternationalCategories(db);
  const [serverRow] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
  if (!serverRow) return { kind: "unknown_tool" };

  const [toolRow] = await db
    .select()
    .from(mcpTools)
    .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)));
  // O10 (ADR-0027): pricing resolves TOOL-FIRST with the server's flat price
  // as the fallback. A newly discovered (just-synced) tool has no override
  // yet, so it bills at the server price; unpriced everywhere = null, never
  // an invented figure. Attributed and unattributed calls both ride this —
  // there is exactly one metering site below.
  const pricePerCallUsd = toolRow?.pricePerCallUsd ?? serverRow.pricePerCallUsd ?? null;
  // Unknown tool: sync the manifest once in case it's newly added upstream.
  let kind = toolRow?.kind;
  let upstream: Client | null = null;
  const redactActive = piiMode === "redact";
  const closeUpstream = async () => {
    if (upstream) {
      const u = upstream;
      upstream = null;
      await u.close();
    }
  };
  // AER-022 — THE BREAKER, AT THE ONE SHARED OPERATION BOUNDARY.
  //
  // ADR-0126 put admission and recording in the HTTP proxy ROUTE only. That left
  // two holes an upstream could drive through: this primitive opens its own
  // connection and runs its own `listTools`/`callTool`, and pillar-7's delegated
  // workers call it DIRECTLY (`orchestration.ts`), never passing the route at
  // all. So an upstream that completed `initialize` and then hung every real
  // operation was never circuit-broken, and each proxy request RESET the
  // accumulated failures on its successful handshake.
  //
  // The election lives here rather than in the route because there must be
  // exactly ONE per operation: `breakerAdmits` moves `breaker_opened_at` in a
  // conditional UPDATE to elect a single half-open prober, so two callers would
  // mean the route wins and this primitive then fast-fails — breaking the very
  // recovery path the election exists to protect. The route delegates tool
  // calls without connecting; it separately elects for manifest requests.
  //
  // MEMOISED, AND CONSULTED AT THE POINT OF CONTACT — not at the top of this
  // function. There are two places below that reach an upstream (the manifest
  // sync, and the call itself), and the breaker must guard both without holding
  // two elections. Checking once at the top would have done that, but it would
  // also have put the breaker AHEAD OF THE KERNEL: a call this deployment
  // forbids would come back "upstream unavailable" and file no deny row, which
  // inverts this product's first rule — governance decides, and an outage never
  // silently stands in for a decision. So the election happens on first contact
  // and its verdict is reused, leaving the governance decision where it was.
  let breakerVerdict: { refusedUntilMs: number; reason: string } | null = null;
  let breakerElected = false;
  const breakerRefusesUpstream = async (): Promise<GovernedToolCallOutcome | null> => {
    if (!breakerElected) {
      // AER-024: our own two refusals come BEFORE the breaker is asked, so a
      // held or egress-refused server is named as such — audited, as a policy
      // decision — rather than reported as an outage for as long as its
      // circuit is open. Thrown, not returned: both errors already have their
      // mapping on every surface, and neither counts as an upstream failure
      // (`operationFailed` classifies them as our own refusal).
      try {
        await preflightUpstream(db, serverRow);
      } catch (err) {
        if (redactActive) throw new Error("MCP upstream connection refused under PII redaction");
        throw err;
      }
      breakerElected = true;
      breakerVerdict = await breakerAdmits(db, serverRow);
    }
    return breakerVerdict === null
      ? null
      : {
          kind: "upstream_circuit_open",
          reason: breakerVerdict.reason,
          retryAfterMs: breakerVerdict.refusedUntilMs,
        };
  };

  /**
   * AER-022 — a SUCCESSFUL OPERATION is the only thing that closes the breaker.
   *
   * The bug this replaces recorded success after `initialize`. A handshake proves
   * the socket answered; it does not prove the server works, so treating it as
   * health erased exactly the failures that mattered. Called after `listTools`
   * and after `callTool` — the operations a caller actually wanted.
   */
  //
  // Once per operation, not once per call: this primitive may run BOTH a
  // `listTools` (the manifest-sync path above) and a `callTool`, and
  // `recordUpstreamSuccess` reads the failure count off the row SNAPSHOT taken
  // before either ran. Without the latch the second success would re-clear an
  // already-cleared breaker and file a SECOND "recovered" transition for one
  // recovery — the audit ledger's whole job here is that a transition means a
  // transition.
  let breakerCleared = false;
  const operationSucceeded = async () => {
    if (breakerCleared) return;
    breakerCleared = true;
    await recordUpstreamSuccess(db, serverRow);
  };

  /**
   * One attributable upstream failure. OUR OWN refusals are never charged here —
   * an admission hold (ADR-0097) or an egress block (ADR-0043) is a decision this
   * gateway made, and an air-gapped install refuses every host by design, so
   * counting them would report every upstream as broken where nothing is wrong.
   * Governance outcomes never reach this function at all: they are returned as
   * values rather than thrown.
   */
  const operationFailed = async (err: unknown) => {
    if (classifyUpstreamError(err).why === "our_own_refusal") return;
    await recordUpstreamFailure(db, serverRow, redactActive
      ? "MCP upstream failed during PII-redacted dispatch"
      : err instanceof Error ? err.message : String(err));
  };

  try {
    if (!kind) {
      // B3S-01: this sync is a connect BEFORE any decision; for stdio it
      // starts a process, so it needs an entitlement on the server first
      if (serverRow.transport === "stdio" && !(await holdsAnyEntitlement(db, userId, serverId))) {
        const decision = await refuseStdioWithoutEntitlement(db, { userId, serverId, toolName, projectId, phase: "tools/call" });
        return { kind: "denied", decision };
      }
      // AER-022: connect + `tools/list` is a real upstream OPERATION, so its
      // outcome belongs to the breaker — this is one of the two paths that used
      // to contact an upstream with no breaker involvement whatsoever.
      const refused = await breakerRefusesUpstream();
      if (refused) return refused;
      let upstreamTools;
      try {
        upstream = await connectUpstream(db, serverRow);
        upstreamTools = await syncUpstreamTools(db, serverId, upstream, "sync", serverRow.transport);
      } catch (err) {
        await operationFailed(err);
        if (redactActive) throw new Error("MCP upstream discovery failed under PII redaction");
        throw err;
      }
      const found = upstreamTools.find((t) => t.name === toolName);
      if (!found) {
        await operationSucceeded();
        return { kind: "unknown_tool" };
      }
      kind = toolKind(found);
    }

    // The generation was read before the server/tool snapshot above. A first
    // manifest sync changes it; redacted callers retry using that stored schema.
    let preparedPii: PreparedPiiApproval | undefined;
    const refuseTransformation = async (reason: string): Promise<GovernedToolCallOutcome> => {
      const decision: Decision = { effect: "deny", ruleId: "pii-transformation-refused", ruleChain: [], reason };
      await db.insert(auditLog).values({ userId, serverId, toolName, ...decision, detail: { projectId, phase: "pii", receiptClass: "decision" } });
      return { kind: "denied", decision };
    };
    if (piiMode === "redact") {
      const [currentTool] = await db.select().from(mcpTools).where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)));
      try {
        preparedPii = prepareMcpPiiAction(projectId, args.arguments, piiIntl, currentTool?.inputSchema);
        // The preparation validated ordinary JSON. Snapshot the original too,
        // so caller mutation cannot move either data-scope checks or identity.
        args = { ...args, arguments: structuredClone(args.arguments ?? {}) };
        traceInput.value = preparedPii.effectiveArguments;
      } catch {
        return refuseTransformation("MCP PII transformation or input schema validation failed");
      }
    } else {
      traceInput.value = args.arguments ?? {};
    }

    // ADR-0188 S4: the actor chain of a delegated call; a grant that cannot be read is a refusal
    let delegatedActor: GovernedActor | null = null;
    if (args.delegationGrantId) {
      try {
        delegatedActor = await actorForGrant(db, args.delegationGrantId, { costKnown: pricePerCallUsd != null });
      } catch (err) {
        if (!(err instanceof DelegationRefusedError)) throw err;
        const decision = delegationRefusalDecision(err);
        await db.insert(auditLog).values({ userId, serverId, toolName, ...decision, detail: { projectId, phase: "delegation", delegationGrantId: args.delegationGrantId, receiptClass: "decision" } });
        return { kind: "denied", decision };
      }
    }
    const {
      decision: evaluated,
      approvedApprovalId,
      argumentsDigest,
      approvalScope,
      contextDigest,
      policyEpoch,
      retiredApprovals,
      matchedApprovalRuleIds,
    } = await governedEvaluate(
      db,
      userId,
      serverId,
      { serverId, name: toolName, kind },
      args.arguments,
      args.ceilingTools ?? null,
      // A4: attribution feeds the deploy-context derivation for mode-scoped
      // rules (lazily — no mode-scoped rules loaded = no extra queries).
      projectId,
      // ADR-0040: the ABAC principal bag's session facts, when a request is
      // behind this call.
      args.principal,
      undefined,
      preparedPii,
      // AER-039: bind the consent to the row this call connects with
      approvalTargetForServer(serverId, serverRow),
      // ADR-0188 S4: a delegated call is decided with the stored chain, read now; a person's own call is `null`
      { actor: delegatedActor },
    );
    // ADR-0188 S4 (decision 6): the §5.1 ceiling is folded into the worker's delegation scope, so a tool the
    // lead's ceiling excludes is refused by the scope term first; it keeps its distinct `lead-ceiling` rule id
    const decision: Decision =
      delegatedActor && evaluated.effect === "deny" && evaluated.ruleId === "delegation-scope" &&
      args.ceilingTools != null && !args.ceilingTools.includes(toolName)
        ? { ...evaluated, ruleId: "lead-ceiling", reason: `tool '${toolName}' is outside the lead's ceiling for this worker (its delegation scope)` }
        : evaluated;

    if (preparedPii && preparationGeneration?.epoch !== policyEpoch) {
      return refuseTransformation("PII policy changed during action preparation; retry for fresh evaluation");
    }

    // ADR-0186 V, decision 32 — OUTBOUND CREDENTIAL AUDIENCE. The caller's
    // arguments, as they would be sent, against the registered upstream URL.
    // After the entitlement decision (an unentitled caller is denied as such)
    // and BEFORE the decision row: a refused call is recorded by this check's
    // own row, which carries rule ids and counts only, so the ledger holds no
    // ADR-0104 arguments digest of a payload refused for carrying a credential.
    // Also before the compliance, budget and approval gates (no approver is
    // asked to sign off a call that may not go out), admission/egress, the
    // breaker and the connect. The upstream URL is admin configuration and is
    // not scanned; stdio has no host and is out of scope.
    if (decision.effect !== "deny" && serverRow.transport !== "stdio") {
      const audience = await refuseOutboundCredentialAudience(db, {
        userId,
        surface: "mcp_tool",
        content: [preparedPii?.effectiveArguments ?? args.arguments ?? {}],
        destinations: [serverRow.url],
        projectId,
        subject: { serverId, toolName },
        detail: { ...(args.detail ?? {}), approvalScope, contextDigest, target: auditTarget(serverRow) },
      });
      if (audience) return { kind: "denied", decision: credentialAudienceDecision(audience.reason) };
    }

    // ADR-0104 — THE FORENSIC HALF, and it is unconditional.
    //
    // Before this, the tool-call audit row named the user, the server and the
    // tool, and said nothing whatsoever about the payload — so "which arguments
    // actually ran" was not recoverable from the ledger at all. The consent
    // fingerprint goes on EVERY tool-call audit row regardless of the governing
    // rules' `approval_scope`, because the record of what ran is not a
    // consequence of the consent semantics; it is owed either way. It is the
    // DIGEST, never the arguments: the audit log is not a place to put a
    // payload that may carry a secret, and the approver-facing rendering lives
    // scrubbed on the queue row instead.
    await db.insert(auditLog).values({
      userId,
      serverId,
      toolName,
      // ADR-0105 adds the CONSENT-CONTEXT identity beside ADR-0104's payload
      // fingerprint. Still digests only — the ledger records WHICH call ran and
      // WHICH policy governed it, never the arguments themselves.
      // ADR-0058 SCOPE: the attributed project rides the ledger row, because a
      // compliance pack's `audit_decisions` collector scopes by
      // `detail->>'projectId'` and has no other way to reach a tool decision.
      // Without it, a project-scoped evaluation of a control whose whole claim
      // is "refusals actually occur" counts ZERO — while the refusals sit in
      // the ledger, correct and invisible. `usage_events` already carried the
      // project for the same call; the two records now agree.
      // NULL for an unattributed call, exactly as the usage row is: an
      // unattributed refusal is not evidence about any project.
      // AER-039: WHERE the call was bound to go — host and manifest identity
      // only (a URL can carry credentials; the digest above binds the rest)
      detail: {
        ...(args.detail ?? {}),
        argumentsDigest,
        approvalScope,
        contextDigest,
        projectId,
        target: auditTarget(serverRow),
        receiptClass: "decision",
      },
      effect: decision.effect,
      ruleId: decision.ruleId,
      ruleChain: decision.ruleChain,
      reason: decision.reason,
    });

    if (decision.effect === "deny") return { kind: "denied", decision };

    // ADR-0023 — §8.3 mcpDefaultMode ENFORCEMENT. An ATTRIBUTED call whose
    // project's compliance cascade tightens to read_only may not execute a
    // WRITE-classified tool: denied HERE, strictly before any approval is
    // queued/consumed and before the upstream is contacted, so a forbidden
    // write executes nothing, consumes nothing and bills nothing. The denial
    // is decision-shaped (ruleId `mcp-default-mode`) so both consumers of this
    // primitive — the MCP proxy and the pillar-7 worker loop — surface it
    // through their existing `denied` handling, and it is audited like every
    // other governed deny. Compliance beats approval: a write that a rule
    // would have sent to the queue is refused outright instead — an approver
    // cannot sign away a framework's read_only posture. Unattributed calls
    // (projectId null) keep today's behaviour byte-identical — that honesty
    // gap is O11, tracked separately.
    if (kind === "write" && projectId) {
      const mcpMode = await projectMcpMode(db, projectId);
      if (mcpMode?.mode === "read_only") {
        const reason =
          `write tool '${toolName}' denied: project '${mcpMode.projectName}' (${projectId}) ` +
          `is read_only under compliance profile(s) ${mcpMode.governingTags.map((t) => `'${t}'`).join(", ")} (mcpDefaultMode)`;
        await db.insert(auditLog).values({
          userId,
          serverId,
          toolName,
          detail: {
            phase: "compliance",
            mcpDefaultMode: "read_only",
            toolKind: kind,
            projectId,
            governingTags: mcpMode.governingTags,
            receiptClass: "decision",
          },
          effect: "deny",
          ruleId: "mcp-default-mode",
          ruleChain: [],
          reason,
        });
        return {
          kind: "denied",
          decision: { effect: "deny", ruleId: "mcp-default-mode", ruleChain: [], reason },
        };
      }
    }

    // ADR-0103 — PILLAR-5 PROJECT BUDGET, MCP path. The tool-call path was
    // priced and attributed but never gated: an attributed `tools/call` loop
    // could run unbounded PAID spend against an exhausted project, and the
    // overspend then surfaced as a 409 on the MODEL path — the symptom showing
    // up somewhere other than the cause. The gate is sited HERE, in the one
    // shared primitive, exactly as §8.4 PII and the ADR-0023 mcpDefaultMode
    // enforcement above are, so BOTH entry points (the direct proxy route and
    // pillar 7's delegated worker loop) inherit it from one place — a
    // delegated worker can never bypass what a direct caller cannot.
    //
    // ORDERING. Entitlement deny and the compliance read_only posture stay
    // ahead of it: they are categorical and cheaper, and no budget makes a
    // forbidden call permissible. Budget beats approval QUEUEING, though —
    // piling a pending approval onto the queue for a call that cannot run is
    // noise for the approver. It is strictly before the approval is consumed,
    // before PII/guardrail work, and before the upstream is ever contacted, so
    // a budget-blocked call executes nothing, consumes nothing and bills
    // nothing.
    //
    // The gate itself is REUSED, not reimplemented: `preDispatchProjectGate`
    // already carries the ADR-0027 compliance ceiling (min(project budget,
    // framework ceiling), capping unbudgeted projects too), the sanctioned
    // `overageActive` overage, ADR-0021's budgetHardBlockPct, warn_only vs
    // block with strictest-wins from the cascade, and the escalation into the
    // one approvals queue with its audit row. All of it carries over here
    // unchanged — that is the point of reusing it.
    //
    // UNATTRIBUTED calls (projectId null) are unchanged and pass straight
    // through: the gate returns ok for a null project, and the call meters into
    // the disclosed ADR-0019/0024 Unattributed bucket. That is the DEFINED
    // treatment, not an oversight — a null-project row can never belong to a
    // project ledger, so there is no project budget for it to have exceeded.
    const projectBudget = await preDispatchProjectGate(db, projectId, userId);
    if (!projectBudget.ok) {
      await db.insert(auditLog).values({
        userId,
        serverId,
        toolName,
        detail: {
          phase: "project-budget",
          projectId,
          toolKind: kind,
          pricePerCallUsd,
          receiptClass: "decision",
        },
        effect: "deny",
        ruleId: "project-budget-cap",
        ruleChain: [],
        reason: `tool '${toolName}' blocked: ${projectBudget.error} — ${projectBudget.detail ?? "project budget exhausted"}`,
      });
      return {
        kind: "budget_blocked",
        status: projectBudget.status,
        error: projectBudget.error,
        ...(projectBudget.detail ? { detail: projectBudget.detail } : {}),
      };
    }

    if (decision.effect === "require_approval") {
      return queueGovernedApproval(db, {
        userId,
        serverId,
        toolName,
        projectId,
        decision,
        retiredApprovals,
        contextDigest,
        approvalScope,
        argumentsDigest,
        argumentsPreview: preparedPii?.argumentsPreview ?? approvalArgumentsPreview(args.arguments),
        argumentsPreviewKind: preparedPii ? "mcp_redacted_v1" : "arguments_v1",
        matchedApprovalRuleIds,
      });
    }

    // §8.4 PII ENFORCEMENT (pillar 3), MCP path — the third governed entry
    // point, now held to the same contract as the model and connector paths.
    // The effective piiMode comes from the ATTRIBUTED project's compliance
    // cascade; an unattributed or unclassified call falls to the ORG FLOOR
    // (ADR-0021 defaultPiiMode, null when unset — then every check below is a
    // no-op, byte-identical to the pre-floor contract). The resolver is called
    // unconditionally so all three entry points share one rule. The INPUT
    // check runs on the tool ARGUMENTS, before the approval is consumed and
    // before the upstream is contacted, so a block executes nothing, consumes
    // no approval and bills nothing.
    // ADR-0117: the jurisdiction set, resolved once for this tool call and
    // shared by the argument gate and the tool-result gate below.
    let inputHits: PiiHit[] = preparedPii ? [...preparedPii.hits] : [];
    if (piiMode && !preparedPii) {
      const chk = enforcePII(piiMode, { input: JSON.stringify(args.arguments ?? null) }, piiIntl);
      inputHits = chk.hits;
      if (chk.action === "block") {
        const reason = `input contains PII: ${piiCategoryList(chk.hits)}`;
        await db.insert(auditLog).values({
          userId,
          serverId,
          toolName,
          detail: {
            phase: "pii",
            // COUNTS ONLY — never the matched substrings
            pii: { mode: piiMode, action: "block", phase: "input", inputHits: chk.hits, outputHits: [] },
            projectId,
            receiptClass: "decision",
          },
          effect: "deny",
          ruleId: "pii-blocked",
          ruleChain: [],
          reason,
        });
        return {
          kind: "pii_blocked",
          reason,
          pii: {
            mode: piiMode,
            action: "block",
            inputHits: chk.hits,
            outputHits: [],
            withheld: false,
          },
        };
      }
    }

    // ADR-0042 GUARDRAIL ENGINE, MCP path. This entry point matters more than
    // the other two for prompt-injection specifically: ADR-0034's amendment
    // showed a governed pipe can carry ATTACKER-CHOSEN BYTES back, so tool
    // OUTPUT is exactly the surface the ADR names as in-scope. Both phases run
    // here — arguments in, tool result out — with PII excluded (its dedicated
    // path is directly above).
    const mcpGuardrails = await resolveGuardrailPolicy(db, { projectId });
    let mgInput: ReturnType<typeof runGuardrails> | null = null;
    if (mcpGuardrails.active) {
      mgInput = runGuardrails(mcpGuardrails, "input", JSON.stringify(args.arguments ?? null));
      const outcome = guardrailOutcome(mgInput);
      if (outcome) {
        await recordGuardrailDecision(db, {
          userId,
          objectType: "mcp_server",
          objectId: serverId,
          projectId,
          evaluation: mgInput,
          outcome,
          detail: { toolName, serverId },
        });
      }
      if (mgInput.action === "block") {
        const reason = `tool arguments blocked by guardrail: ${guardrailCategoryList(mgInput.blocking)}`;
        return {
          kind: "guardrail_blocked",
          reason,
          guardrails: {
            action: "block",
            phase: "input",
            findings: flattenFindings(mgInput.findings),
            withheld: false,
          },
        };
      }
    }

    if (!upstream) {
      const refused = await breakerRefusesUpstream();
      if (refused) return refused;
      try {
        upstream = await connectUpstream(db, serverRow);
      } catch (err) {
        await operationFailed(err);
        if (redactActive) throw new Error("MCP upstream connection failed under PII redaction");
        throw err;
      }
    }
    if (preparedPii) {
      const [liveGeneration] = await db.select({ epoch: governancePolicyEpoch.epoch }).from(governancePolicyEpoch);
      if (liveGeneration?.epoch !== policyEpoch) {
        return refuseTransformation("PII or governance policy changed before execution; retry for fresh evaluation");
      }
    }

    if (approvedApprovalId) {
      const refused = await consumeApprovalOrRetire(db, {
        approvedApprovalId,
        policyEpoch,
        approvalScope,
        argumentsDigest,
        contextDigest,
        userId,
        serverId,
        toolName,
        projectId,
      });
      if (refused) return refused;
    }

    // An upstream FAILURE throws out of here before any metering — a failed
    // call bills nothing, exactly like a failed model dispatch or connector
    // invoke.
    // ADR-0128 — THE ONE PLACE A RETRY WOULD HAVE BEEN A BUG. A `tools/call` is
    // an arbitrary side-effecting operation on somebody else's system: a blind
    // retry can open two pull requests or charge two cards, and it does so
    // precisely when the network is unreliable. AER-038: readOnlyHint is not
    // an idempotency contract either, so every tool receives one attempt.
    let content: Awaited<ReturnType<typeof upstream.callTool>>;
    try {
      content = await withUpstreamRetry(
        ({ deadlineMs }) =>
          upstream!.callTool({ name: toolName, arguments: preparedPii?.effectiveArguments ?? args.arguments }, undefined, {
            timeout: deadlineMs,
          }),
        {
          // G2: by far the most generous of the three deadlines, because this is
          // the upstream doing real work — a build, a query, a scan. A bound that
          // severs legitimate work is worse than the hang it replaced.
          budgetMs: timeouts().mcpCallToolMs,
          maxAttempts: attemptsForToolKind(kind),
          // ADR-0185 G5: the call is one upstream operation on /metrics. The
          // connect before it is observed separately, once per attempt, inside
          // guardedMcpConnect — so connectUpstream deliberately passes no
          // `observe` (it would count every connect twice).
          observe: { serverId: serverRow.id, transport: serverRow.transport },
        },
      );
    } catch (err) {
      // AER-022: a hung or failing `tools/call` now counts, so an upstream that
      // initializes cleanly and then fails every real operation is broken after
      // the threshold instead of never.
      //
      // A `try`/`catch` rather than `.catch()`: an async `.catch` handler that
      // rethrows still widens the inferred type to include `undefined`, which
      // no longer satisfies the SDK's `tools/call` handler signature.
      await operationFailed(err);
      if (redactActive) throw new Error("MCP upstream call failed under PII redaction");
      throw err;
    }
    // AER-022: THE operation succeeded. This — not the handshake — is what closes
    // a breaker, and it is what the old placement got wrong.
    await operationSucceeded();

    // §8.4 OUTPUT check: the tool already ran, so a block here is BILL-AND-
    // WITHHOLD — the usage row below records the honest spend, but the result
    // content is replaced by the withheld marker.
    let outputHits: PiiHit[] = [];
    let resultContent: unknown = content;
    let withheld = false;
    let blobWithheld = false;
    if (preparedPii) {
      try {
        // Re-read output policy too. A tightened policy while the tool ran may
        // withhold the result, but cannot undo the already executed operation.
        const outputMode = await projectPiiMode(db, projectId);
        const outputIntl = [...new Set([...piiIntl, ...await piiInternationalCategories(db)])];
        const transformed = redactMcpResult(content, outputIntl);
        outputHits = transformed.hits;
        resultContent = transformed.value;
        if (outputMode === "block" && outputHits.length) throw new Error("PII output blocked");
      } catch {
        withheld = true;
        resultContent = { content: [{ type: "text", text: "[output withheld: PII transformation could not be safely completed]" }], isError: true };
      }
    } else if (piiMode) {
      // B3S-04: a base64 `blob` is decoded and scanned with the rest, or —
      // when it cannot be — the result is withheld (every mode but off)
      const blobs = decodeMcpBlobs(content);
      if (blobs.unscannable) {
        withheld = true;
        blobWithheld = true;
        resultContent = {
          content: [{ type: "text", text: "[output withheld: encoded content that cannot be scanned for PII]" }],
          isError: true,
        };
      } else {
        const chk = enforcePII(piiMode, { output: scannableMcpText(content, blobs) }, piiIntl);
        outputHits = chk.hits;
        if (chk.action === "block") {
          withheld = true;
          resultContent = {
            content: [{ type: "text", text: piiWithheldMarker(chk.hits) }],
            isError: true,
          };
        }
      }
    }
    const anyHits = inputHits.length > 0 || outputHits.length > 0;
    const piiAction: McpPii["action"] = withheld ? "block" : preparedPii ? "redact" : piiMode === "warn" ? "warn" : "log";
    const pii: McpPii | null =
      piiMode && (anyHits || preparedPii || withheld)
        ? { mode: piiMode, action: piiAction, inputHits, outputHits, withheld }
        : null;

    // ADR-0042 OUTPUT phase — the tool RESULT. This is the injection-carrying
    // surface: a compromised or hostile MCP server answers with text that the
    // orchestrator will feed straight back to a model as context. A block is
    // bill-and-withhold, identical to the PII rule directly above.
    let mgOutput: ReturnType<typeof runGuardrails> | null = null;
    let mgWithheld = false;
    if (mcpGuardrails.active) {
      mgOutput = runGuardrails(mcpGuardrails, "output", scannableMcpText(content, decodeMcpBlobs(content)));
      if (mgOutput.action === "block") {
        mgWithheld = true;
        resultContent = {
          content: [{ type: "text", text: guardrailWithheldMarker(mgOutput.blocking) }],
          isError: true,
        };
      }
    }
    const mgFindings = [...(mgInput?.findings ?? []), ...(mgOutput?.findings ?? [])];
    const mcpGuardrailView: DispatchGuardrails | null = mgFindings.length
      ? {
          action: mgWithheld ? "block" : mgFindings.some((f) => f.action === "warn") ? "warn" : "log",
          phase: mgWithheld ? "output" : mgInput?.findings.length ? "input" : "output",
          findings: flattenFindings(mgFindings),
          withheld: mgWithheld,
        }
      : null;

    // PILLAR 5 (ADR-0019, widened by ADR-0024 O11): EVERY allowed, executed
    // tool call bills the server's flat per-call list price onto the SAME
    // usage ledger the model and connector paths write. Attribution decides
    // WHERE the row lands, not WHETHER it exists: an attributed call rolls up
    // in its project dashboard; an unattributed call lands with projectId NULL
    // in the explicit "Unattributed" bucket (GET /v1/costs/unattributed), so
    // the leak is visible to an admin instead of invisible. A null-project row
    // can never hit a project budget — every project rollup and the budget
    // gate filter on projectId. Unpriced server → null, never an invented
    // figure. Denied calls and upstream failures still bill nothing.
    // ADR-0188 S4: stamped with the acting agent; settled along its chain in the same transaction
    const toolUsageWrite = (h: Db) => h.insert(usageEvents).values({
      ...actorColumns(),
      userId,
      objectType: "mcp_tool",
      // usage_events has no server column; `operation` carries the tool name
      // (as it carries the operation on connector rows) and the server id
      // rides the detail jsonb.
      operation: toolName,
      // O10: tool-first price, server-flat fallback (resolved above)
      costUsd: pricePerCallUsd,
      projectId,
      detail: {
        serverId,
        toolName,
        // §8.4 COUNTS ONLY — never the matched substrings
        ...(pii ? { pii: { mode: pii.mode, action: pii.action, inputHits, outputHits } } : {}),
        // ADR-0042 COUNTS ONLY, same contract
        ...(mcpGuardrailView
          ? {
              guardrails: {
                action: mcpGuardrailView.action,
                findings: mcpGuardrailView.findings,
                withheld: mgWithheld,
              },
            }
          : {}),
      },
    }).returning({ id: usageEvents.id });
    const toolGrantId = args.delegationGrantId;
    if (toolGrantId) {
      await db.transaction(async (tx) => {
        const [u] = await toolUsageWrite(tx as unknown as Db);
        if (u) await settleDelegationCharge(tx, { usageEventId: u.id, leafGrantId: toolGrantId, amountMicros: usdToMicros(pricePerCallUsd) });
      });
    } else {
      await toolUsageWrite(db);
    }
    if (mgOutput) {
      const outcome = guardrailOutcome(mgOutput);
      if (outcome) {
        await recordGuardrailDecision(db, {
          userId,
          objectType: "mcp_server",
          objectId: serverId,
          projectId,
          evaluation: mgOutput,
          outcome,
          detail: { toolName, serverId },
        });
      }
    }
    // §8.4 audit rows for a PII event (never for a clean payload): an OUTPUT
    // block is a deny; a warn is an allow with 'pii-warned'; log stays silent
    // (its counts are already in the usage detail above).
    if (withheld) {
      await db.insert(auditLog).values({
        userId,
        serverId,
        toolName,
        detail: {
          phase: "pii",
          pii: { mode: piiMode, action: "block", phase: "output", inputHits, outputHits },
          projectId,
          receiptClass: "decision",
        },
        effect: "deny",
        ruleId: "pii-blocked",
        ruleChain: [],
        reason: preparedPii
          ? "Output could not be released under the PII policy; billed and withheld"
          : blobWithheld
            ? "output carries encoded content that cannot be scanned for PII — billed and withheld"
            : `output contains PII: ${piiCategoryList(outputHits)} — billed and withheld`,
      });
    } else if (piiMode === "warn" && anyHits) {
      await db.insert(auditLog).values({
        userId,
        serverId,
        toolName,
        detail: {
          phase: "pii",
          pii: { mode: piiMode, action: "warn", inputHits, outputHits },
          projectId,
          receiptClass: "decision",
        },
        effect: "allow",
        ruleId: "pii-warned",
        ruleChain: [],
        reason: `PII detected (${piiCategoryList([...inputHits, ...outputHits])}) — warned, tool call proceeded`,
      });
    }

    return {
      kind: "allowed",
      content: resultContent,
      ...(pii ? { pii } : {}),
      ...(mcpGuardrailView ? { guardrails: mcpGuardrailView } : {}),
      // ADR-0024 (O11): every executed call is metered, so the cost is always
      // reported back — attributed or not. O10: tool-first resolution.
      costUsd: pricePerCallUsd,
    };
  } finally {
    await closeUpstream();
  }
}

/**
 * ADR-0185 G3 — THE QUEUEING HALF of a `require_approval`, shared by the tool
 * path and the protocol path (`mcp-protocol.ts`) so both queue, dedupe, stamp
 * and retire consents through ONE implementation (moved here unchanged from
 * `executeGovernedToolCallInner`). `toolName` is the tool, or a protocol
 * method's grant name (`mcp:resources`, ...).
 */
export async function queueGovernedApproval(
  db: Db,
  q: {
    userId: string;
    serverId: string;
    toolName: string;
    projectId: string | null;
    decision: Decision;
    retiredApprovals: readonly RetiredApproval[];
    contextDigest: string;
    approvalScope: "action" | "tool";
    argumentsDigest: string;
    argumentsPreview: (typeof approvals.$inferInsert)["argumentsPreview"];
    argumentsPreviewKind: "arguments_v1" | "mcp_redacted_v1";
    /** ADR-0186 A: the approval rules that matched (their max quorum is snapshotted) */
    matchedApprovalRuleIds?: readonly string[] | undefined;
  },
): Promise<
  Extract<GovernedToolCallOutcome, { kind: "approval_required" | "approval_expired" | "approval_context_stale" | "denied" }>
> {
  const {
    userId,
    serverId,
    toolName,
    projectId,
    decision,
    retiredApprovals,
    contextDigest,
    approvalScope,
    argumentsDigest,
    argumentsPreview,
    argumentsPreviewKind,
  } = q;
  // ADR-0105 — THE VISIBLE DISPOSITION, and it happens BEFORE the re-queue.
  //
  // If this call is here because a consent it was holding went stale or
  // lapsed, that row is retired NOW, with an audit fact naming why, and the
  // fresh entry raised below carries the CURRENT digests. Retire-then-
  // requeue in that order is what makes the pair legible to an approver:
  // the dead signature is marked dead, and the row asking to be signed is
  // the one bound to today's policy.
  //
  // Sited in this branch, not above the deny/compliance/budget gates: a
  // call refused for some OTHER reason has said nothing about whether the
  // stored consent is still good, and retiring on the way past would be
  // acting on a question nobody asked. A genuinely stale row is retired the
  // next time it is actually reached for.
  const superseded = retiredApprovals.length
    ? await supersedeStaleConsent(db, retiredApprovals, {
        userId,
        serverId,
        toolName,
        projectId,
      })
    : [];

  // ADR-0105 — THE TTL DIAL, read at QUEUE time. NULL is a real value and
  // is NOT defaulted away: it is the operator's recorded choice that this
  // org's approvals never expire, which knowingly reopens the gap. The
  // shipped column default is 72 hours (see migration 0107), so an org that
  // has never touched the dial gets expiry.
  const { approvalTtlHours } = await loadOrgSettings(db);

  // ADR-0186 A — DUAL CONTROL, decided at QUEUE time: the quorum this consent
  // will need (max of the matched rules' quorums and, for a project carrying an
  // in-app-only classification, the org's sensitive quorum) and how each
  // approval must be signed, snapshotted onto the row. A pool that can never
  // reach the quorum is a DENIED call, audited, not an approval nobody can give.
  const requirement = await toolApprovalRequirements(db, {
    callerUserId: userId,
    approverUserId: decision.approverUserId!,
    ruleId: decision.ruleId,
    matchedApprovalRuleIds: q.matchedApprovalRuleIds ?? [],
    projectId,
  });
  if (!requirement.satisfiable) {
    const reason = await auditQuorumUnsatisfiableAtQueue(db, {
      userId,
      req: requirement,
      projectId,
      target: { serverId, toolName },
    });
    return {
      kind: "denied",
      decision: { effect: "deny", ruleId: "approval-quorum-unsatisfiable", ruleChain: decision.ruleChain, reason },
    };
  }

  // Reuse an existing pending entry rather than piling up duplicates.
  //
  // ADR-0104 — THE DEDUP MUST KEY ON THE PAYLOAD TOO, under action scope.
  // The old dedup keyed on user/server/tool/pending only. Under a consent
  // that is bound to the arguments, that is the SAME HOLE IN A NEW PLACE: a
  // second call with a completely different payload would collapse into the
  // first call's pending row, the approver would read the first payload,
  // sign it, and the second payload would ride along on that signature.
  // Under 'tool' scope the digest is deliberately NOT in the key — one
  // pending entry standing for a tool regardless of arguments is exactly
  // what that escape hatch means, and the row's preview shows whichever
  // payload first raised it.
  const [pending] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.userId, userId),
        eq(approvals.serverId, serverId),
        eq(approvals.toolName, toolName),
        eq(approvals.status, "pending"),
        eq(approvals.contextDigest, contextDigest),
        eq(approvals.argumentsPreviewKind, argumentsPreviewKind),
        eq(approvals.approvalScope, approvalScope),
        ...(approvalScope === "action"
          ? [eq(approvals.argumentsDigest, argumentsDigest)]
          : []),
      ),
    )
    .orderBy(asc(approvals.requestedAt))
    .limit(1);
  // ADR-0186 A: reused only while its queue-time pool can still reach its quorum
  const reusable = pending && (await reusePendingToolApproval(db, pending.id)) ? pending : undefined;
  const approvalId =
    reusable?.id ??
    (
      await db
        .insert(approvals)
        .values({
          userId,
          serverId,
          toolName,
          /**
           * ADR-0124 — `approvals.rule_id` is a UUID referring to an
           * `approval_rules` row. An ORDINARY require_approval carries one.
           * The execution dial's `require_approval` mode does not: its rule
           * id is symbolic (`execution-require-approval`), because no rule
           * row demanded it — the deployment's posture did. Writing the
           * symbolic id here raised 22P02 and failed the queue outright,
           * which is the same mistake M-039 recorded: a column's type is a
           * claim about every producer. NULL is the honest value, and the
           * audit row beside this carries the symbolic id, so nothing is
           * lost.
           */
          ruleId: UUID_RE.test(decision.ruleId) ? decision.ruleId : null,
          approverUserId: decision.approverUserId!,
          // ADR-0104: the fingerprint the consent will be BOUND to, and
          // beside it the SCRUBBED payload the approver actually reads.
          // Redaction forces action scope and supplies a preview of the
          // effective snapshot; consent also binds the original digest.
          argumentsDigest,
          argumentsPreview: argumentsPreview,
          argumentsPreviewKind: argumentsPreviewKind,
          approvalScope,
          projectId,
          // ADR-0105: the POLICY identity this consent is being asked for,
          // and the clock it dies on. Both stamped HERE, at queue time —
          // the digest so the signature is bound to the policy the
          // approver is signing under, the expiry so a later dial change
          // can never extend a consent that already exists (the same
          // stamp-at-issuance discipline ADR-0098 holds for API keys).
          contextDigest,
          ...(approvalTtlHours != null
            ? { expiresAt: new Date(Date.now() + approvalTtlHours * 3_600_000) }
            : {}),
          // ADR-0186 A/B: snapshotted here, never re-read from a later dial
          quorum: requirement.quorum,
          signatureMode: requirement.signatureMode,
          approverRoleId: requirement.approverRoleId,
          // ADR-0186 A (0172): the approver named now, persisted — never reconstructed later
          namedApproverUserId: decision.approverUserId!,
        })
        .returning({ id: approvals.id })
    )[0]!.id;
  // A retirement that actually moved a row is reported as the distinct
  // outcome it is: "your approval lapsed / the policy moved, here is the
  // replacement" is a different thing to tell a caller than "you need an
  // approval". A context change outranks an expiry when both happened —
  // the policy fact is the more consequential one.
  if (superseded.length > 0) {
    const anyContext = retiredApprovals.some(
      (r) => superseded.includes(r.id) && r.reason === "context_changed",
    );
    return anyContext
      ? {
          kind: "approval_context_stale",
          supersededApprovalIds: superseded,
          requeuedApprovalId: approvalId,
        }
      : {
          kind: "approval_expired",
          supersededApprovalIds: superseded,
          requeuedApprovalId: approvalId,
        };
  }
  return { kind: "approval_required", approvalId, decision };
}

/**
 * ADR-0185 G3 — THE CONSUMING HALF: spend the approved consent atomically, or
 * say which of the three things happened instead (moved here unchanged from
 * `executeGovernedToolCallInner`). Null = consumed, run the call.
 */
export async function consumeApprovalOrRetire(
  db: Db,
  c: {
    approvedApprovalId: string;
    policyEpoch: number;
    approvalScope: "action" | "tool";
    argumentsDigest: string;
    contextDigest: string;
    userId: string;
    serverId: string;
    toolName: string;
    projectId: string | null;
  },
): Promise<Extract<
  GovernedToolCallOutcome,
  { kind: "approval_expired" | "approval_context_stale" | "approval_consumed_race" | "denied" }
> | null> {
  const { approvedApprovalId, policyEpoch, approvalScope, argumentsDigest, contextDigest, userId, serverId, toolName, projectId } = c;
  // Atomically consume the approval; losing the race means another call
  // already spent it, so this call must go back through the queue.
  //
  // A shared lock on the policy epoch orders this consume against policy
  // writes. Their database triggers update the same row. If any write
  // committed after evaluation began, this call must evaluate again.
  //
  //   * `arguments_digest` is asserted ONLY under action scope. Under the
  //     ADR-0104 `tool` escape hatch a different payload's digest — or a
  //     legacy NULL — is exactly what the row is allowed to carry, so
  //     asserting it there would quietly delete the escape hatch.
  //   * `context_digest` must equal this call's. Legacy NULL rows re-queue.
  //   * `expires_at` must be absent or in the future, evaluated by the
  //     DATABASE's clock (`now()`), not this process's — the row is being
  //     changed there and the freshness question has to be answered there
  //     too.
  const spent = await spendBoundApproval(db, {
    approvalId: approvedApprovalId,
    policyEpoch,
    approvalScope,
    argumentsDigest,
    contextDigest,
    call: { serverId, toolName },
  });
  // ADR-0186 B: a signature that does not verify against this call refuses it
  // (the approval was superseded and audited inside the spend)
  if (spent === "signature_recheck_failed") {
    return { kind: "denied", decision: signatureRecheckDenial(approvedApprovalId) };
  }
  if (spent !== "consumed") {
    // ADR-0105 — CLASSIFY, do not return one opaque failure. Re-read the
    // row and say which of the three actually happened: somebody else spent
    // it, it lapsed, or the policy moved underneath it. The first is a
    // benign race; the other two are refusals that owe a visible
    // disposition, so the row is superseded here too. No replacement is
    // queued on this path — raising one needs a fresh evaluation under the
    // policy that has just changed, which is precisely what the caller's
    // retry does.
    const [row] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvedApprovalId));
    if (row && row.status === "approved") {
      const reason: RetiredApproval["reason"] =
        row.expiresAt != null && row.expiresAt.getTime() <= Date.now()
          ? "expired"
          : "context_changed";
      const superseded = await supersedeStaleConsent(db, [{ id: row.id, reason }], {
        userId,
        serverId,
        toolName,
        projectId,
      });
      return reason === "expired"
        ? {
            kind: "approval_expired",
            supersededApprovalIds: superseded,
            requeuedApprovalId: null,
          }
        : {
            kind: "approval_context_stale",
            supersededApprovalIds: superseded,
            requeuedApprovalId: null,
          };
    }
    return { kind: "approval_consumed_race", approvalId: approvedApprovalId };
  }
  return null;
}

/** Discover the upstream tool manifest and sync it into the registry (§6: auto-discovered tool inventory).
 *
 * EXPORTED for ADR-0100: the scheduled admission re-scan drives THIS function
 * rather than one of its own, so there is exactly one implementation of "fetch
 * a manifest, adjudicate it, store what is admissible". `trigger` only labels
 * the audit row the adjudication writes — it changes no threshold, no state
 * rule and no order of operations. */
export async function syncUpstreamTools(
  db: Db,
  serverId: string,
  client: Client,
  trigger: McpAdmissionTrigger = "sync",
  /** ADR-0185 G5: the row's transport, for the `/metrics` label only */
  transport?: McpUpstreamTransport | null,
): Promise<Tool[]> {
  // G2: a manifest is small, so a slow one is a sick upstream, not a busy one.
  // ADR-0128: and reading a manifest is idempotent by definition, so it is one
  // of the two MCP operations that may simply be asked again — within the same
  // one deadline, which is the whole sequence's budget.
  const { tools } = await withUpstreamRetry(
    ({ deadlineMs }) => client.listTools(undefined, { timeout: deadlineMs }),
    { budgetMs: timeouts().mcpListToolsMs, observe: { serverId, transport } },
  );
  // ADR-0097 — SCAN BEFORE UPSERT. This is the one moment the gateway sees a
  // manifest, and scanning here rather than after the upsert is what keeps a
  // poisoned description out of `mcp_tools` ENTIRELY: under `enforce` a dirty
  // manifest is never written, so no discovery surface, cache or later read can
  // hand it to a model even once. Under `off` (the shipped default) nothing
  // below runs at all and this function is byte-identical to pre-0097.
  const admission = await recordManifestScan(db, serverId, tools as ScannableTool[], trigger);
  if (admission.mode === "enforce" && admission.state === "held") {
    throw new McpAdmissionHeldError(
      serverId,
      "held",
      admission.scan?.findings ?? [],
      `MCP server manifest refused by admission scanning: ` +
        `${admissionFindingSummary(admission.scan?.findings ?? [])}. The manifest was NOT stored ` +
        `and no tool from it was returned. An admin must review and clear the server.`,
    );
  }
  for (const tool of tools) {
    await db
      .insert(mcpTools)
      .values({
        serverId,
        name: tool.name,
        kind: toolKind(tool),
        description: tool.description ?? null,
        inputSchema: tool.inputSchema,
      })
      .onConflictDoUpdate({
        target: [mcpTools.serverId, mcpTools.name],
        set: { kind: toolKind(tool), description: tool.description ?? null, inputSchema: tool.inputSchema },
      });
  }
  return tools;
}


/** Pillar 7 tool resolution: turn a worker node's DECLARED tool servers into
 * (a) the model-facing tool defs the initiating user is ENTITLED to on those
 * servers, and (b) a full name→server map for governance routing. Reuses the
 * exact manifest sync + entitlement filter the proxy's tools/list uses, so a
 * node's tools are governed identically to a human's. The declaration is a
 * scoping hint only: a server the user can't reach, or a connect failure,
 * simply contributes nothing (never authority). The name→server map spans the
 * WHOLE manifest of each declared server — not just entitled tools — so a model
 * that asks for a manifested-but-ungranted tool still routes to
 * executeGovernedToolCall and earns a governed deny row rather than silently
 * vanishing. */
export async function resolveNodeToolContext(
  db: Db,
  userId: string,
  serverIds: string[],
  allowNames: string[] | undefined,
  /** §5.1 Team-Lead ceiling: the tool NAMES this worker's lead chain permits.
   * null/undefined = no lead constraint. A non-null set NARROWS the visible
   * tool defs too, so the model is never even offered a tool the lead forbids —
   * belt to executeGovernedToolCall's braces (the hard per-call enforcement).
   * The name→server map still spans the whole manifest so a ceiling-excluded
   * tool the model somehow requests still routes to a governed `lead-ceiling`
   * deny rather than silently vanishing. */
  ceilingToolRefs?: readonly string[] | null,
): Promise<{ toolDefs: ModelToolDef[]; serverByTool: Map<string, string> }> {
  const toolDefs: ModelToolDef[] = [];
  const serverByTool = new Map<string, string>();
  const nameFilter = allowNames && allowNames.length > 0 ? new Set(allowNames) : null;
  const ceilingFilter = ceilingToolRefs != null ? new Set(ceilingToolRefs) : null;
  for (const serverId of serverIds) {
    const [serverRow] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    if (!serverRow) continue;
    let upstream: Client | null = null;
    try {
      // AER-024: a held or egress-refused server is refused (and audited) here,
      // before it can spend a breaker probe election it was never allowed to use
      await preflightUpstream(db, serverRow);
      if (await breakerAdmits(db, serverRow)) continue;
      let upstreamTools;
      try {
        upstream = await connectUpstream(db, serverRow);
        upstreamTools = await syncUpstreamTools(db, serverId, upstream, "sync", serverRow.transport);
      } catch (err) {
        if (classifyUpstreamError(err).why !== "our_own_refusal") {
          await recordUpstreamFailure(db, serverRow, err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
      await recordUpstreamSuccess(db, serverRow);
      const entitlements = await loadEntitlements(db, userId, serverId);
      const refs: ToolRef[] = upstreamTools
        // ADR-0185 G3: a reserved `mcp:` name is never offered as a tool
        .filter((t) => !isReservedToolName(t.name))
        .map((t) => ({
          serverId,
          name: t.name,
          kind: toolKind(t),
        }));
      const visible = new Set(visibleTools(userId, serverId, refs, entitlements).map((t) => t.name));
      for (const t of upstreamTools) {
        // first declared server wins for a shared tool name
        if (!serverByTool.has(t.name)) serverByTool.set(t.name, serverId);
        if (!visible.has(t.name)) continue;
        if (nameFilter && !nameFilter.has(t.name)) continue;
        // §5.1: the lead ceiling narrows visibility — a forbidden tool is never
        // offered to the model (it stays in serverByTool for hard enforcement).
        if (ceilingFilter && !ceilingFilter.has(t.name)) continue;
        toolDefs.push({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
        });
      }
    } catch {
      // a declared server we cannot reach contributes no tools — a hint, not authority
    } finally {
      if (upstream) await upstream.close();
    }
  }
  return { toolDefs, serverByTool };
}

export function registerMcpProxy(app: FastifyInstance, db: Db) {
  // O10 (ADR-0027): admin-only per-tool price override (NOT in
  // NON_ADMIN_ROUTES — the default gate keeps it admin-only, like the server
  // registry writes). Set on the INVENTORY row so a manifest re-sync (which
  // upserts kind/description only) can never clobber it; null clears the
  // override back to the server's flat price. Audited.
  app.patch("/v1/servers/:serverId/tools/:toolName/price", async (req, reply) => {
    const { serverId, toolName } = z
      .object({ serverId: z.string().uuid(), toolName: z.string().min(1) })
      .parse(req.params);
    const body = setToolPriceSchema.parse(req.body);
    const [before] = await db
      .select()
      .from(mcpTools)
      .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)));
    if (!before) return reply.status(404).send({ error: "unknown_tool" });
    const [row] = await db
      .update(mcpTools)
      .set({ pricePerCallUsd: body.pricePerCallUsd })
      .where(eq(mcpTools.id, before.id))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      serverId,
      toolName,
      objectType: "mcp_tool",
      objectId: before.id,
      detail: {
        phase: "tool-price",
        before: before.pricePerCallUsd,
        after: body.pricePerCallUsd,
        receiptClass: "configuration",
      },
      effect: "allow",
      ruleId: "mcp-tool-price-set",
      ruleChain: [],
      reason:
        body.pricePerCallUsd == null
          ? `per-tool price override cleared for '${toolName}' — the server's flat price applies again`
          : `per-tool price override for '${toolName}' set to $${body.pricePerCallUsd}/call (tool-first, server-flat fallback)`,
    });
    return reply.send(row);
  });

  app.post("/mcp/:serverId", async (req, reply) => {
    const { serverId } = proxyParams.parse(req.params);
    const { intent } = proxyQuery.parse(req.query);

    // Identity comes from the app-level auth hook (API key). The bootstrap
    // token has no user identity, so it cannot call tools.
    const userId = req.authCtx.userId;
    if (!userId) {
      return reply.status(403).send({ error: "bootstrap_cannot_call_tools" });
    }

    const [serverRow] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    if (!serverRow) {
      return reply.status(404).send({ error: "unknown_server" });
    }

    // ADR-0019 pillar-5 attribution. Validated EXACTLY like the invoke paths
    // validate `projectId` — a malformed id is 400, and a project the caller
    // may not bill to is 403 — and validated HERE, before the reply is hijacked
    // into an MCP transport, so the caller gets an ordinary HTTP error rather
    // than a JSON-RPC one. No header = unattributed = today's behaviour.
    let projectId: string | null = null;
    const headerParse = proxyHeaders.safeParse(req.headers);
    if (!headerParse.success) {
      return reply.status(400).send({ error: "invalid_project_id" });
    }
    projectId = headerParse.data[PROJECT_HEADER] ?? null;
    if (projectId) {
      const attribution = await assertProjectAttribution(
        db,
        projectId,
        userId,
        req.authCtx.isAdmin,
      );
      if (!attribution.ok) {
        return reply.status(attribution.status).send({ error: attribution.error });
      }
    } else {
      // ADR-0024 (O11): the admin's lever to CLOSE the unattributed gap
      // entirely — the exact mirror of the compat surfaces'
      // require_project_attribution. Rejected HERE, pre-dispatch and before
      // the reply is hijacked into an MCP transport, with a plain HTTP error
      // naming the header, and audited. ON by default (ADR-0181), and a
      // missing settings row reads as ON; off (an audited admin relaxation) =
      // the call runs and is metered into the Unattributed bucket.
      const [interception] = await db
        .select({ requireMcpAttribution: interceptionSettings.requireMcpAttribution })
        .from(interceptionSettings)
        .where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
      if (interception?.requireMcpAttribution ?? true) {
        await db.insert(auditLog).values({
          userId,
          serverId,
          detail: { phase: "attribution", requireMcpAttribution: true, receiptClass: "decision" },
          effect: "deny",
          ruleId: "mcp-attribution-required",
          ruleChain: [],
          reason:
            `unattributed MCP call rejected: this deployment requires the ${PROJECT_HEADER} ` +
            `header on every MCP tool call`,
        });
        return reply.status(400).send({
          error: "mcp_attribution_required",
          detail:
            `this deployment requires every MCP call to be attributed — set the ` +
            `${PROJECT_HEADER} header (a project you may bill to) on the MCP transport`,
        });
      }
    }

    // ADR-0043: the connect-time egress verdict surfaces HERE, before the
    // reply is hijacked into an MCP transport, as the route's ordinary
    // pre-hijack refusal shape — a plain 403 naming the real reason. The
    // refusal is already audited inside the guard and nothing left the box.
    let upstream: Client | null = null;
    // B3S-02: the close handler is registered BEFORE anything connects. A
    // client that disconnected while the upstream was still being opened (a
    // stdio spawn + initialize, an HTTP handshake) used to leave it open: the
    // handler was attached only after the connect returned, when the socket's
    // `close` had already fired, so the child kept running and its process
    // slot was never given back. Now the handler closes whatever is open when
    // it fires, and a connect that completes after it fired is closed at once
    // (below).
    let clientGone = false;
    let proxyTransport: StreamableHTTPServerTransport | null = null;
    const closeUpstreamSession = () => {
      const u = upstream;
      upstream = null;
      if (u) void u.close().catch(() => undefined);
    };
    reply.raw.on("close", () => {
      clientGone = true;
      if (proxyTransport) void proxyTransport.close();
      closeUpstreamSession();
    });
    // ADR-0128: the sequence reports into this, so the ONE failure row below can
    // say how hard we tried. A row per attempt was deliberately not written —
    // see upstream-retry.ts for why, which is verbatim the breaker's reasoning.
    const connectRetry = newRetryReport();
    const needsManifest = ListToolsRequestSchema.safeParse(req.body).success;
    // B3S-01: a stdio manifest request starts a process, so it needs an
    // entitlement on the server first (audited deny, nothing started), and an
    // entitled caller is served from the STORED manifest when there is one —
    // the process starts only for a call an allow decision admitted, or for
    // the first listing of a server whose manifest was never synced.
    let storedManifest: Tool[] | null = null;
    if (needsManifest && serverRow.transport === "stdio") {
      if (!(await holdsAnyEntitlement(db, userId, serverId))) {
        const decision = await refuseStdioWithoutEntitlement(db, { userId, serverId, projectId, phase: "tools/list" });
        return reply.status(403).send({ error: "mcp_no_entitlement", detail: decision.reason });
      }
      const stored = await db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId)).orderBy(asc(mcpTools.name));
      if (stored.length > 0) {
        storedManifest = stored.map((t) => ({
          name: t.name,
          ...(t.description !== null ? { description: t.description } : {}),
          inputSchema: (t.inputSchema ?? { type: "object" }) as Tool["inputSchema"],
          // the stored kind is what the kernel decides on; the annotation
          // carries it back so `toolKind` reads the same value
          annotations: { readOnlyHint: t.kind === "read" },
        }));
      }
    }
    /** The two refusals that are OURS, as the route's plain pre-hijack 403. */
    const ownRefusal = (err: unknown) => {
      if (err instanceof McpEgressBlockedError) {
        // ADR-0185 G4: `egress_blocked` for a destination refusal, the
        // transport refusal's own contract code otherwise (e.g.
        // `mcp_stdio_digest_mismatch`, `mcp_transport_disabled`)
        return reply.status(403).send({
          error: err.error,
          code: err.decision.code,
          detail: err.decision.reason,
        });
      }
      // ADR-0097: an admission HOLD surfaces in exactly the same place and the
      // same shape as ADR-0043's egress refusal — a plain pre-hijack 403 naming
      // the real reason, with the refusal already audited and NOTHING having
      // been attempted upstream. The findings ride along counts-only.
      if (err instanceof McpAdmissionHeldError) {
        return reply.status(403).send({
          error: "mcp_admission_held",
          detail: err.detail,
          findings: err.findings,
        });
      }
      return null;
    };
    if (needsManifest) {
      // AER-024: admission and egress are adjudicated BEFORE the breaker is
      // asked. An open circuit used to answer 503 here first, so a held or
      // egress-refused server was reported as an outage — "retry later" — for
      // as long as its breaker stayed open, with no deny row. The preflight is
      // side-effect-free towards the upstream and the breaker alike.
      try {
        await preflightUpstream(db, serverRow);
      } catch (err) {
        const refused = ownRefusal(err);
        if (refused) return refused;
        throw err;
      }
      // B3S-01: served from the stored manifest = no upstream contact, so the
      // breaker (whose half-open election a listing would spend) is not asked
      const refusal = storedManifest ? null : await breakerAdmits(db, serverRow);
      if (refusal) {
        return reply.status(503)
          .header("retry-after", String(Math.ceil(refusal.refusedUntilMs / 1000)))
          .send({ error: "mcp_upstream_circuit_open", detail: refusal.reason,
            retryAfterMs: refusal.refusedUntilMs });
      }
    }
    try {
      // Tool calls own admission in the shared primitive. Protocol setup is
      // local; only a manifest request needs a connection at this boundary.
      if (needsManifest && !storedManifest) {
        upstream = await connectUpstream(db, serverRow, { retry: connectRetry });
      }
      // B3S-02: the client left while we were connecting — close it now
      if (clientGone || reply.raw.destroyed || req.raw.socket?.destroyed) {
        closeUpstreamSession();
        reply.hijack();
        return;
      }
    } catch (err) {
      const refused = ownRefusal(err);
      if (refused) return refused;
      // ROADMAP G2 — the third refusal shape, and the one the demo runbook had
      // a troubleshooting row for: the server is registered, the egress guard
      // permitted it and admission cleared it, and the upstream did not answer.
      //
      // This USED TO `throw err`, which escaped to the global handler and
      // became `500 {"error":"internal"}` — with nothing audited. That is the
      // single error shape this product tries hardest never to emit, on a route
      // whose entire value proposition is that every refusal is named. It is
      // also, in practice, the most common failure a new deployment hits: the
      // upstream simply is not running.
      //
      // 502, not 500: the gateway is fine and the upstream is not, and that
      // distinction is the first thing an operator needs. A DEADLINE exceeded
      // reports 504 instead, because "it refused us" and "it never finished"
      // send you to different places.
      const timedOut = isDeadlineError(err);
      const detail = timedOut
        ? `upstream MCP server '${serverRow.name}' did not complete the session handshake within ${timeouts().mcpConnectMs}ms`
        : `upstream MCP server '${serverRow.name}' could not be reached at ${serverRow.url}`;
      await auditMcpUpstreamUnreachable(db, {
        userId,
        serverId: serverRow.id,
        url: serverRow.url,
        reason: detail,
        timedOut,
        deadlineMs: timeouts().mcpConnectMs,
        attempts: connectRetry.attempts,
        retryDelaysMs: connectRetry.delaysMs,
        retryVerdict: connectRetry.lastWhy,
      });
      // count it towards the breaker. This is the ONLY place a connect failure
      // is counted: an egress refusal and an admission hold return above, and
      // neither is the upstream's fault — tripping a breaker on our own policy
      // decision would mean a governance change looked like an outage.
      // ONE failure for the whole sequence, not one per attempt. The breaker's
      // threshold was chosen against the unit "one user-visible failed
      // operation"; counting attempts would silently make it three times more
      // trigger-happy without anybody changing its configuration.
      await recordUpstreamFailure(db, serverRow, detail);
      return reply.status(timedOut ? 504 : 502).send({
        error: timedOut ? "mcp_upstream_timeout" : "mcp_upstream_unreachable",
        detail,
        deadlineMs: timeouts().mcpConnectMs,
      });
    }

    // A handshake cannot establish recovery. Each handler records success
    // only after its list or call operation actually finishes.

    // ADR-0185 G3: `tools` always; resources / prompts / completions / logging
    // only when the org has enabled a method under them (none by default)
    const orgForProtocol = await loadOrgSettings(db);
    const proxy = new Server(
      { name: "regulait-gateway", version: "0.1.0" },
      { capabilities: protocolCapabilities(orgForProtocol.mcpProtocolMethods ?? []) },
    );
    // ADR-0185 G3: every non-tool request is decided by the protocol primitive
    // (refused, disabled, or governed exactly like a tool call)
    const protocolSurface = installProtocolSurface(proxy, {
      db,
      userId,
      serverId,
      projectId,
      call: async (method, params, extra) => {
        const protocolTrace = await beginTrace(db, {
          kind: "tool",
          name: `mcp ${method.slice(0, 120)}`,
          userId,
          projectId,
          sessionId: `mcp:${serverId}`,
          rootRefId: serverId,
        });
        const outcome = await executeGovernedProtocolCall(db, {
          userId,
          serverId,
          method,
          params,
          projectId,
          principal: abacPrincipalFromRequest(req),
          trace: protocolTrace,
          relay: extra.relay,
          progressToken: extra.progressToken,
        }).catch(async (err: unknown) => {
          // the same named policy refusal a tools/call raises post-hijack
          if (err instanceof McpAdmissionHeldError || err instanceof McpEgressBlockedError) {
            await finishTrace(db, protocolTrace, "denied");
            throw new McpError(ErrorCode.InvalidRequest, `Denied by policy: ${err.message}`);
          }
          throw err;
        });
        await finishTrace(
          db,
          protocolTrace,
          outcome.kind === "allowed" ? "ok" : outcome.kind === "method_not_found" || outcome.kind === "invalid_params" ? "error" : "denied",
        );
        return protocolOutcomeResult(outcome, method, mcpErrorForGovernanceOutcome);
      },
    });

    proxy.setRequestHandler(ListToolsRequestSchema, async () => {
      // ADR-0097 DRIFT: the connect-time gate passed, but the manifest is
      // re-scanned on every sync, so a server whose tools changed mid-session
      // into something dirty is refused HERE — as a real MCP error naming the
      // reason, never a fabricated empty tool list. The dirty manifest was not
      // stored either (syncUpstreamTools scans before it upserts).
      let upstreamTools: Tool[];
      if (storedManifest) {
        // B3S-01: a stdio server's stored manifest (admission scanned it when
        // it was synced; the preflight above re-checked admission and the
        // command) — no process is started to answer a listing
        upstreamTools = storedManifest;
      } else {
        if (!upstream) throw new McpError(ErrorCode.InternalError, "Missing manifest connection");
        upstreamTools = await syncUpstreamTools(db, serverId, upstream, "sync", serverRow.transport).catch(async (err: unknown) => {
          if (err instanceof McpAdmissionHeldError) {
            throw new McpError(ErrorCode.InvalidRequest, `Denied by policy: ${err.detail}`);
          }
          if (classifyUpstreamError(err).why !== "our_own_refusal") {
            await recordUpstreamFailure(db, serverRow, err instanceof Error ? err.message : String(err));
          }
          throw err;
        });
        await recordUpstreamSuccess(db, serverRow);
      }
      const entitlements = await loadEntitlements(db, userId, serverId);
      const refs: ToolRef[] = upstreamTools
        // ADR-0185 G3: a reserved `mcp:` name is never offered as a tool
        .filter((t) => !isReservedToolName(t.name))
        .map((t) => ({
          serverId,
          name: t.name,
          kind: toolKind(t),
        }));
      const visible = new Set(
        visibleTools(userId, serverId, refs, entitlements).map((t) => t.name),
      );
      const entitled = upstreamTools.filter((t) => visible.has(t.name));

      // OPTIMIZATION §8: lazy tool-loading. Governance filtering above decides
      // what the user MAY see; this decides what is WORTH sending for the
      // declared intent. Withheld tools remain fully callable — tools/call
      // never consults this selection (§12: entitlements never shrink).
      // ADR-0021: the org lazyToolLoadingEnabled toggle is the ceiling — off
      // returns the full entitled manifest with no selection pass and no
      // ledger row; the maxToolsInManifest dial rides into the kernel.
      const org = await loadOrgSettings(db);
      if (!org.lazyToolLoadingEnabled) {
        return { tools: entitled };
      }
      const [policy] = await db
        .select({ routingMode: userAgentPolicies.routingMode })
        .from(userAgentPolicies)
        .where(eq(userAgentPolicies.userId, userId));
      const selection = selectTools({
        intent: intent ?? null,
        tools: entitled.map((t) => ({
          name: t.name,
          description: t.description ?? null,
          manifestChars: JSON.stringify(t).length,
        })),
        routingMode: effectiveTechniqueMode(org, org.lazyToolLoadingEnabled, policy?.routingMode ?? null),
        maxTools: org.maxToolsInManifest,
      });
      await db.insert(costEvents).values({
        userId,
        objectType: "mcp_tool",
        objectId: serverId,
        technique: "lazy_tool_loading",
        estimatedTokensSaved: selection.estimatedTokensSaved,
        estimatedCostSavedUsd: null,
        estimationBasis: selection.estimationBasis,
        ruleId: selection.ruleId,
        detail: {
          effect: selection.effect,
          selectedCount: selection.selected.length,
          withheldCount: selection.withheld.length,
        },
      });
      const exposed = new Set(selection.selected);
      return { tools: entitled.filter((t) => exposed.has(t.name)) };
    });

    proxy.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      // ADR-0070 — a direct proxy tool call is its own one-span trace, grouped
      // by the SERVER as the session so an operator can read a client's whole
      // conversation with one MCP server as one thing. `beginTrace` returns
      // null when tracing is off, and every line below then no-ops.
      const toolTrace = await beginTrace(db, {
        kind: "tool",
        name: `mcp ${toolName}`,
        userId,
        projectId,
        sessionId: `mcp:${serverId}`,
        rootRefId: serverId,
      });
      // The proxy route is now a thin governance-to-MCP-error mapper over the
      // shared primitive; the identical logic serves the worker loop too.
      const outcome = await executeGovernedToolCall(db, undefined, {
        userId,
        serverId,
        toolName,
        arguments: request.params.arguments,
        projectId,
        // ADR-0040: SERVER-DERIVED session facts. These come from the resolved
        // session row, never from a header the caller could set.
        principal: abacPrincipalFromRequest(req),
        trace: toolTrace,
      }).catch(async (err: unknown) => {
        // AER-024: the reply is already hijacked, so the primitive's admission
        // hold / egress refusal cannot be the pre-hijack 403 the manifest path
        // answers. It is the SAME named policy refusal the manifest handler
        // raises post-hijack — never a generic internal error, and never the
        // breaker's "retry later".
        if (err instanceof McpAdmissionHeldError || err instanceof McpEgressBlockedError) {
          await finishTrace(db, toolTrace, "denied");
          throw new McpError(ErrorCode.InvalidRequest, `Denied by policy: ${err.message}`);
        }
        throw err;
      });
      await finishTrace(
        db,
        toolTrace,
        outcome.kind === "allowed" ? "ok" : outcome.kind === "unknown_tool" ? "error" : "denied",
      );

      switch (outcome.kind) {
        case "unknown_tool":
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
        case "allowed":
          return outcome.content as Record<string, unknown>;
        default:
          throw mcpErrorForGovernanceOutcome(outcome);
      }
    });

    // Stateless mode: one transport per request, no session tracking yet.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    proxyTransport = transport;
    reply.hijack();
    // B3S-02: the client may have left while the protocol surface was built
    if (clientGone || req.raw.socket?.destroyed) {
      void transport.close();
      closeUpstreamSession();
      return;
    }
    await proxy.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
    // ADR-0185 G3: notification handlers run on the microtask queue after the
    // transport dispatched them; one audit row for this request's drops
    await new Promise<void>((resolve) => setImmediate(resolve));
    await protocolSurface.flush();
  });
}

/**
 * A governance outcome (shared by the tool and protocol paths) as the MCP
 * error the proxy answers with. Moved out of the `tools/call` handler
 * unchanged, so `mcp-protocol.ts` names every refusal exactly as a tool call
 * does (ADR-0185 G3).
 */
export function mcpErrorForGovernanceOutcome(
  outcome: Exclude<GovernedToolCallOutcome, { kind: "allowed" | "unknown_tool" }>,
): McpError {
  switch (outcome.kind) {
    case "denied":
      return new McpError(
        ErrorCode.InvalidRequest,
        `Denied by policy: ${outcome.decision.reason}`,
        // ADR-0186 decision 32: the connector route's 403 code, carried in the
        // error data (a JSON-RPC answer has no HTTP status of its own)
        outcome.decision.ruleId === CREDENTIAL_AUDIENCE_RULE_ID
          ? { error: CREDENTIAL_AUDIENCE_ERROR, status: 403 }
          : undefined,
      );
    // §8.4 input block: denied pre-call, nothing executed, nothing billed.
    // The message names CATEGORIES only, never the matched content.
    case "pii_blocked":
      return new McpError(ErrorCode.InvalidRequest, `Denied by policy: ${outcome.reason}`);
    // ADR-0042 input block: same shape, same honesty — a real MCP error,
    // never a fabricated empty success, and CATEGORIES only in the message.
    case "guardrail_blocked":
      return new McpError(ErrorCode.InvalidRequest, `Denied by policy: ${outcome.reason}`);
    // ADR-0103 pillar-5 block: the attributed project's budget is
    // exhausted, so nothing ran, nothing was consumed and nothing billed.
    // The message names the same error the model path returns (409
    // project_budget_exceeded) so an operator reading either surface sees
    // one condition, not two.
    case "budget_blocked":
      return new McpError(
        ErrorCode.InvalidRequest,
        `Denied by policy: ${outcome.error}` + (outcome.detail ? ` — ${outcome.detail}` : ""),
      );
    case "approval_required": {
      // name the approver by display name when the kernel carried one — the
      // approval id keeps the full UUID (a caller retries with it)
      const decision = outcome.decision;
      const approverLabel = decision.approverName
        ? `'${decision.approverName}' (${decision.approverUserId!.slice(0, 8)}…)`
        : `'${decision.approverUserId}'`;
      return new McpError(
        ErrorCode.InvalidRequest,
        `Approval required: approval '${outcome.approvalId}' is pending sign-off by ` +
          `approver ${approverLabel}. Retry after approval.`,
      );
    }
    case "approval_consumed_race":
      return new McpError(
        ErrorCode.InvalidRequest,
        `Approval '${outcome.approvalId}' was already consumed — retry to request a new approval.`,
      );
    // ADR-0105: the two consent-freshness refusals. Both name the retired
    // row AND the replacement, so a caller reading the error knows the old
    // signature is dead and which row now needs signing — never a bare
    // "denied" that leaves them retrying into the same wall.
    case "approval_expired":
      return new McpError(
        ErrorCode.InvalidRequest,
        `Approval ${outcome.supersededApprovalIds.map((id) => `'${id}'`).join(", ")} expired ` +
          `before it was used and has been superseded.` +
          (outcome.requeuedApprovalId
            ? ` Approval '${outcome.requeuedApprovalId}' has been raised in its place and is ` +
              `pending sign-off. Retry after approval.`
            : ` Retry to raise a fresh approval.`),
      );
    case "approval_context_stale":
      return new McpError(
        ErrorCode.InvalidRequest,
        `Approval ${outcome.supersededApprovalIds.map((id) => `'${id}'`).join(", ")} was granted ` +
          `under a policy context that has since changed and has been superseded.` +
          (outcome.requeuedApprovalId
            ? ` Approval '${outcome.requeuedApprovalId}' has been raised under the current policy ` +
              `and is pending sign-off. Retry after approval.`
            : ` Retry to raise a fresh approval.`),
      );
    // Tool admission happens after governance, inside the MCP handler.
    // The response is already hijacked, so expose the retry window in the
    // MCP error; manifest admission can still return a pre-hijack HTTP 503.
    case "upstream_circuit_open":
      return new McpError(
        ErrorCode.InternalError,
        `Upstream unavailable: ${outcome.reason}. Retry after ` +
          `${Math.ceil(outcome.retryAfterMs / 1000)}s.`,
      );
  }
}

/** AER-039 — the upstream a call was bound to, safe for the audit ledger */
/** ADR-0186 decision 32: the refusal as a governed deny (every surface already maps `denied`) */
export function credentialAudienceDecision(reason: string): Decision {
  return { effect: "deny", ruleId: CREDENTIAL_AUDIENCE_RULE_ID, ruleChain: [], reason };
}

function auditTarget(row: { url: string; allowPrivateRanges: boolean | null; admissionManifestDigest: string | null }) {
  let host: string | null = null;
  try {
    host = new URL(row.url).host;
  } catch {
    host = null;
  }
  return { host, allowPrivateRanges: row.allowPrivateRanges ?? null, admissionManifestDigest: row.admissionManifestDigest ?? null };
}

/** AER-039 — the target a queued MCP consent is bound to, as an approver sees it */
export interface ApprovalBoundTarget {
  host: string | null;
  allowPrivateRanges: boolean | null;
  admissionManifestDigest: string | null;
}

/**
 * AER-039 — the target each MCP consent was BOUND to, for the review surface.
 *
 * Read back from the tool-call audit row the queueing call wrote (`auditTarget`
 * above, beside the same `contextDigest`), never from the server row's CURRENT
 * values: an approver signs what the call was evaluated against, and a server
 * edited since must not be shown as the thing being signed. The context digest
 * commits to the full target, so ANY audit row carrying the consent's own digest
 * names exactly its target; the time window is only a scan bound on the
 * (user_id, at) index. The queueing row precedes `requested_at`; the five
 * minutes after it absorb gateway/database clock skew (audit `at` is stamped by
 * the gateway, `requested_at` by Postgres). No such row — a pre-v3 consent, a
 * row not queued by the proxy — is null: shown as not recorded, never filled in
 * from the live row.
 */
export async function boundTargetsForApprovals(
  db: Db,
  approvalIds: string[],
): Promise<Map<string, ApprovalBoundTarget | null>> {
  const out = new Map<string, ApprovalBoundTarget | null>();
  if (approvalIds.length === 0) return out;
  // Raw SQL on purpose: drizzle un-qualifies column refs inside a single-table
  // select's SQL field, which would compare audit_log's columns with themselves.
  const res = await db.execute(sql`
    select a.id as "approvalId", (
      select l.detail -> 'target' from audit_log l
      where l.user_id = a.user_id
        and l.server_id = a.server_id
        and l.tool_name = a.tool_name
        and l.at <= a.requested_at + interval '5 minutes'
        and l.at > a.requested_at - interval '1 hour'
        and l.detail ->> 'contextDigest' = a.context_digest
        and jsonb_typeof(l.detail -> 'target') = 'object'
      order by l.at desc
      limit 1
    ) as "target"
    from approvals a
    where a.id in (${sql.join(approvalIds.map((id) => sql`${id}`), sql`, `)})
  `);
  for (const row of (res as unknown as { rows: Array<{ approvalId: string; target: unknown }> }).rows) {
    const t = row.target;
    if (t === null || typeof t !== "object" || Array.isArray(t)) {
      out.set(row.approvalId, null);
      continue;
    }
    const v = t as Record<string, unknown>;
    out.set(row.approvalId, {
      host: typeof v.host === "string" ? v.host : null,
      allowPrivateRanges: typeof v.allowPrivateRanges === "boolean" ? v.allowPrivateRanges : null,
      admissionManifestDigest: typeof v.admissionManifestDigest === "string" ? v.admissionManifestDigest : null,
    });
  }
  return out;
}
