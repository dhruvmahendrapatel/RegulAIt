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
  auditLog,
  costEvents,
  eq,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  mcpServers,
  mcpTools,
  usageEvents,
  userAgentPolicies,
  type Db,
} from "@regulait/db";
import { visibleTools, type Decision, type ToolRef } from "@regulait/policy-kernel";
import { selectTools } from "@regulait/optimizer-kernel";
import type { ModelToolDef } from "@regulait/model-provider";
import {
  setToolPriceSchema,
  guardrailCategoryList,
  guardrailWithheldMarker,
  toolPayloadPreview,
  admissionFindingSummary,
  type PiiHit,
  type ScannableTool,
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
import { governedEvaluate } from "./governed-evaluate.js";
import { abacPrincipalFromRequest, type AbacPrincipalContext } from "./abac-principal.js";
import { guardedMcpConnect, McpEgressBlockedError } from "./mcp-egress.js";
// ADR-0097 — ADMISSION SCANNING. ADR-0043 governs the DESTINATION; this governs
// what comes back. The gate runs at the top of connectUpstream (before the only
// thing that opens an outbound socket) and the scan runs inside
// syncUpstreamTools (before the only thing that persists a tool description).
import {
  assertAdmitted,
  McpAdmissionHeldError,
  recordManifestScan,
} from "./mcp-admission.js";
import { loadEntitlements } from "./entitlements.js";
import { effectiveTechniqueMode, loadOrgSettings } from "./org-settings.js";
import {
  assertProjectAttribution,
  enforcePII,
  piiCategoryList,
  piiWithheldMarker,
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
export async function connectUpstream(
  db: Db,
  serverRow: { id: string; url: string; allowPrivateRanges: boolean | null },
): Promise<Client> {
  // ADR-0097 — THE ADMISSION GATE, and note the ORDER. It runs BEFORE
  // `guardedMcpConnect`, which is the only function in this codebase that
  // opens an outbound MCP socket, so a held server is refused with provably
  // zero outbound attempt — the same standard ADR-0043 holds itself to, proven
  // the same way (a recording resolver that must see no lookup at all).
  // Re-read per connect, never cached: the verdict recorded at the last sync is
  // not a fact about this request, and a row written straight into Postgres
  // must be adjudicated too.
  await assertAdmitted(db, serverRow.id);
  return guardedMcpConnect(db, serverRow);
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
  | { kind: "denied"; decision: Decision }
  | { kind: "pii_blocked"; reason: string; pii: McpPii }
  /** ADR-0042: a content-safety detector refused the tool ARGUMENTS. Distinct
   * from `denied` (entitlement) and `pii_blocked` (§8.4's own classifier) so a
   * caller — and the audit trail — can tell the three apart. */
  | { kind: "guardrail_blocked"; reason: string; guardrails: DispatchGuardrails }
  | { kind: "approval_required"; approvalId: string; decision: Decision }
  | { kind: "approval_consumed_race"; approvalId: string };

/** §8.4 PII outcome on an MCP tool call. COUNTS ONLY — inputHits/outputHits are
 * per-category counts, never the matched substrings (the same contract the
 * model and connector paths hold). */
export interface McpPii {
  mode: PiiMode;
  action: "block" | "warn" | "log";
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
  },
): Promise<GovernedToolCallOutcome> {
  // ADR-0070 — the tool span. Wrapped exactly like the dispatch core's: the
  // governed body below is untouched, this times it and records ONE span from
  // whatever it returned. A refusal (entitlement, PII, guardrail, pending
  // approval) is a `denied` span carrying its reason, not an absent one.
  const traceStartedAt = new Date();
  const outcome = await executeGovernedToolCallInner(db, _dataKey, args);
  if (args.trace) {
    const denied =
      outcome.kind === "denied" ||
      outcome.kind === "pii_blocked" ||
      outcome.kind === "guardrail_blocked" ||
      outcome.kind === "approval_required";
    const reason =
      outcome.kind === "denied"
        ? outcome.decision.reason
        : outcome.kind === "pii_blocked" || outcome.kind === "guardrail_blocked"
          ? outcome.reason
          : outcome.kind === "approval_required"
            ? `tool call requires approval '${outcome.approvalId}' before it may run`
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
      inputText: capture ? toolPayloadPreview(args.arguments, max) : null,
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
): Promise<GovernedToolCallOutcome> {
  const { userId, serverId, toolName } = args;
  const projectId = args.projectId ?? null;
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
  const closeUpstream = async () => {
    if (upstream) {
      const u = upstream;
      upstream = null;
      await u.close();
    }
  };
  try {
    if (!kind) {
      upstream = await connectUpstream(db, serverRow);
      const upstreamTools = await syncUpstreamTools(db, serverId, upstream);
      const found = upstreamTools.find((t) => t.name === toolName);
      if (!found) return { kind: "unknown_tool" };
      kind = toolKind(found);
    }

    const { decision, approvedApprovalId } = await governedEvaluate(
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
    );

    await db.insert(auditLog).values({
      userId,
      serverId,
      toolName,
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

    if (decision.effect === "require_approval") {
      // Reuse an existing pending entry rather than piling up duplicates.
      const [pending] = await db
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.userId, userId),
            eq(approvals.serverId, serverId),
            eq(approvals.toolName, toolName),
            eq(approvals.status, "pending"),
          ),
        )
        .limit(1);
      const approvalId =
        pending?.id ??
        (
          await db
            .insert(approvals)
            .values({
              userId,
              serverId,
              toolName,
              ruleId: decision.ruleId,
              approverUserId: decision.approverUserId!,
            })
            .returning({ id: approvals.id })
        )[0]!.id;
      return { kind: "approval_required", approvalId, decision };
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
    const piiMode: PiiMode | null = await projectPiiMode(db, projectId ?? null);
    let inputHits: PiiHit[] = [];
    if (piiMode) {
      const chk = enforcePII(piiMode, { input: JSON.stringify(args.arguments ?? null) });
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

    if (approvedApprovalId) {
      // Atomically consume the approval; losing the race means another call
      // already spent it, so this call must go back through the queue.
      const consumed = await db
        .update(approvals)
        .set({ status: "consumed" })
        .where(and(eq(approvals.id, approvedApprovalId), eq(approvals.status, "approved")))
        .returning({ id: approvals.id });
      if (consumed.length === 0) {
        return { kind: "approval_consumed_race", approvalId: approvedApprovalId };
      }
    }

    if (!upstream) upstream = await connectUpstream(db, serverRow);
    // An upstream FAILURE throws out of here before any metering — a failed
    // call bills nothing, exactly like a failed model dispatch or connector
    // invoke.
    const content = await upstream.callTool({ name: toolName, arguments: args.arguments });

    // §8.4 OUTPUT check: the tool already ran, so a block here is BILL-AND-
    // WITHHOLD — the usage row below records the honest spend, but the result
    // content is replaced by the withheld marker.
    let outputHits: PiiHit[] = [];
    let resultContent: unknown = content;
    let withheld = false;
    if (piiMode) {
      const chk = enforcePII(piiMode, { output: JSON.stringify(content ?? null) });
      outputHits = chk.hits;
      if (chk.action === "block") {
        withheld = true;
        resultContent = {
          content: [{ type: "text", text: piiWithheldMarker(chk.hits) }],
          isError: true,
        };
      }
    }
    const anyHits = inputHits.length > 0 || outputHits.length > 0;
    const piiAction: McpPii["action"] = withheld ? "block" : piiMode === "warn" ? "warn" : "log";
    const pii: McpPii | null =
      piiMode && anyHits
        ? { mode: piiMode, action: piiAction, inputHits, outputHits, withheld }
        : null;

    // ADR-0042 OUTPUT phase — the tool RESULT. This is the injection-carrying
    // surface: a compromised or hostile MCP server answers with text that the
    // orchestrator will feed straight back to a model as context. A block is
    // bill-and-withhold, identical to the PII rule directly above.
    let mgOutput: ReturnType<typeof runGuardrails> | null = null;
    let mgWithheld = false;
    if (mcpGuardrails.active) {
      mgOutput = runGuardrails(mcpGuardrails, "output", JSON.stringify(content ?? null));
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
    await db.insert(usageEvents).values({
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
    });
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
        },
        effect: "deny",
        ruleId: "pii-blocked",
        ruleChain: [],
        reason: `output contains PII: ${piiCategoryList(outputHits)} — billed and withheld`,
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

/** Discover the upstream tool manifest and sync it into the registry (§6: auto-discovered tool inventory). */
async function syncUpstreamTools(db: Db, serverId: string, client: Client): Promise<Tool[]> {
  const { tools } = await client.listTools();
  // ADR-0097 — SCAN BEFORE UPSERT. This is the one moment the gateway sees a
  // manifest, and scanning here rather than after the upsert is what keeps a
  // poisoned description out of `mcp_tools` ENTIRELY: under `enforce` a dirty
  // manifest is never written, so no discovery surface, cache or later read can
  // hand it to a model even once. Under `off` (the shipped default) nothing
  // below runs at all and this function is byte-identical to pre-0097.
  const admission = await recordManifestScan(db, serverId, tools as ScannableTool[]);
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
      })
      .onConflictDoUpdate({
        target: [mcpTools.serverId, mcpTools.name],
        set: { kind: toolKind(tool), description: tool.description ?? null },
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
      upstream = await connectUpstream(db, serverRow);
      const upstreamTools = await syncUpstreamTools(db, serverId, upstream);
      const entitlements = await loadEntitlements(db, userId, serverId);
      const refs: ToolRef[] = upstreamTools.map((t) => ({
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
      // naming the header, and audited. Off (default) = the call runs and is
      // metered into the Unattributed bucket.
      const [interception] = await db
        .select({ requireMcpAttribution: interceptionSettings.requireMcpAttribution })
        .from(interceptionSettings)
        .where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
      if (interception?.requireMcpAttribution) {
        await db.insert(auditLog).values({
          userId,
          serverId,
          detail: { phase: "attribution", requireMcpAttribution: true },
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
    let upstream: Client;
    try {
      upstream = await connectUpstream(db, serverRow);
    } catch (err) {
      if (err instanceof McpEgressBlockedError) {
        return reply.status(403).send({
          error: "egress_blocked",
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
      throw err;
    }

    const proxy = new Server(
      { name: "regulait-gateway", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    proxy.setRequestHandler(ListToolsRequestSchema, async () => {
      // ADR-0097 DRIFT: the connect-time gate passed, but the manifest is
      // re-scanned on every sync, so a server whose tools changed mid-session
      // into something dirty is refused HERE — as a real MCP error naming the
      // reason, never a fabricated empty tool list. The dirty manifest was not
      // stored either (syncUpstreamTools scans before it upserts).
      const upstreamTools = await syncUpstreamTools(db, serverId, upstream).catch((err: unknown) => {
        if (err instanceof McpAdmissionHeldError) {
          throw new McpError(ErrorCode.InvalidRequest, `Denied by policy: ${err.detail}`);
        }
        throw err;
      });
      const entitlements = await loadEntitlements(db, userId, serverId);
      const refs: ToolRef[] = upstreamTools.map((t) => ({
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
      });
      await finishTrace(
        db,
        toolTrace,
        outcome.kind === "allowed" ? "ok" : outcome.kind === "unknown_tool" ? "error" : "denied",
      );

      switch (outcome.kind) {
        case "unknown_tool":
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
        case "denied":
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Denied by policy: ${outcome.decision.reason}`,
          );
        // §8.4 input block: denied pre-call, nothing executed, nothing billed.
        // The message names CATEGORIES only, never the matched content.
        case "pii_blocked":
          throw new McpError(ErrorCode.InvalidRequest, `Denied by policy: ${outcome.reason}`);
        // ADR-0042 input block: same shape, same honesty — a real MCP error,
        // never a fabricated empty success, and CATEGORIES only in the message.
        case "guardrail_blocked":
          throw new McpError(ErrorCode.InvalidRequest, `Denied by policy: ${outcome.reason}`);
        case "approval_required": {
          // name the approver by display name when the kernel carried one — the
          // approval id keeps the full UUID (a caller retries with it)
          const decision = outcome.decision;
          const approverLabel = decision.approverName
            ? `'${decision.approverName}' (${decision.approverUserId!.slice(0, 8)}…)`
            : `'${decision.approverUserId}'`;
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Approval required: approval '${outcome.approvalId}' is pending sign-off by ` +
              `approver ${approverLabel}. Retry after approval.`,
          );
        }
        case "approval_consumed_race":
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Approval '${outcome.approvalId}' was already consumed — retry to request a new approval.`,
          );
        case "allowed":
          return outcome.content as Record<string, unknown>;
      }
    });

    // Stateless mode: one transport per request, no session tracking yet.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void upstream.close();
    });
    await proxy.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
}
