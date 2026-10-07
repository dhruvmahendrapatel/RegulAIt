/**
 * ADR-0185 G3 — MCP PROTOCOL COVERAGE: the non-tool methods, one at a time,
 * each behind the same per-user decision as a tool call.
 *
 * Before G3 the proxy advertised `tools` only and answered every other method
 * with the SDK's -32601. That was not a pass-through, so G3 OPENS methods; it
 * does not close a hole. Each governed method passes, in order:
 *
 *   0. never one of the ALWAYS-REFUSED methods (`resources/subscribe`,
 *      `resources/unsubscribe`, `sampling/*`, `elicitation/*`, `roots/*`):
 *      refused by name and audited `mcp-method-unsupported`, whatever the org
 *      enables. Anything else outside the vocabulary stays -32601.
 *   1. THE ORG ENABLES IT (`org_settings.mcp_protocol_methods`, empty by
 *      default). Disabled = "Denied by policy", audited `mcp-method-disabled`.
 *   2. THE KERNEL DECIDES on `ToolRef{serverId, name: <grant>, kind,
 *      surface: "protocol"}` through `governedEvaluate` — grants by name
 *      (a read-only-all server grant never covers it), revocations, the lead
 *      ceiling, ABAC, data-scope rules (`resources/read` is decided on
 *      `{uri}`, so a rule with toolName `mcp:resources`, argPath `uri` is an
 *      exact allow-list), rate limits, approvals and the execution halt. One
 *      audit row for the decision, as for a tool call. The compliance
 *      read-only posture, the project budget and the approvals queue follow,
 *      through the SAME helpers the tool path uses.
 *   3. THE UPSTREAM ADVERTISES IT. Its capabilities are only known from its
 *      `initialize` answer, and nothing may reach the upstream before an allow
 *      (a deny must cost the upstream zero requests), so this check runs on
 *      the connection opened after the allow: a server that does not
 *      advertise the capability gets the handshake only, never the method,
 *      and the caller gets -32601. (ADR-0185 lists this gate second; the
 *      "connects only after an allow" rule beside it decides the order.)
 *
 * What is sent upstream is EXACTLY what was decided: the params are rebuilt
 * from the decided arguments (`_meta` and unknown keys are not forwarded), so
 * the consent digest, the data-scope check and the bytes on the wire agree.
 *
 * Content: arguments go through the same input scans as tool arguments (PII,
 * guardrails); resource contents, prompt messages, completion values and list
 * results go through the same output scans as a tool result (PII, guardrails
 * including prompt injection). An output block withholds the result.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CompleteRequestSchema,
  CompleteResultSchema,
  EmptyResultSchema,
  ErrorCode,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  LoggingMessageNotificationSchema,
  McpError,
  ProgressNotificationSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  SetLevelRequestSchema,
  type JSONRPCRequest,
  type ServerCapabilities,
  type ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { auditLog, eq, mcpServers, type Db } from "@regulait/db";
import type { Decision } from "@regulait/policy-kernel";
import {
  approvalArgumentsPreview,
  guardrailCategoryList,
  MCP_PROTOCOL_METHOD_GRANTS,
  MCP_PROTOCOL_METHODS,
  MCP_PROTOCOL_REFUSED_METHODS,
  redactPiiPayload,
  type McpProtocolGrantName,
  type McpProtocolMethod,
  type PiiHit,
} from "@regulait/shared";
import { approvalTargetForServer, governedEvaluate } from "./governed-evaluate.js";
import { recordDecision } from "./metrics.js";
import { loadOrgSettings } from "./org-settings.js";
import {
  enforcePII,
  piiCategoryList,
  piiInternationalCategories,
  preDispatchProjectGate,
  projectMcpMode,
  projectPiiMode,
} from "./projects.js";
import {
  flattenFindings,
  guardrailOutcome,
  recordGuardrailDecision,
  resolveGuardrailPolicy,
  runGuardrails,
} from "./guardrails.js";
import type { AbacPrincipalContext } from "./abac-principal.js";
import { recordSpan, type TraceContext } from "./tracing.js";
import { timeouts } from "./timeouts.js";
import { classifyUpstreamError, withUpstreamRetry } from "./upstream-retry.js";
import { breakerAdmits, recordUpstreamFailure, recordUpstreamSuccess } from "./upstream-breaker.js";
import {
  connectUpstream,
  consumeApprovalOrRetire,
  preflightUpstream,
  queueGovernedApproval,
  type GovernedToolCallOutcome,
} from "./mcp-proxy.js";

/** ADR-0185 G3: the reserved tool-name prefix. Protocol grants live under it
 * (`mcp:resources`, ...), so no upstream TOOL may carry it: a tool so named
 * would be callable under a protocol grant. Admission refuses such a manifest
 * (mcp-admission.ts); the tool path also refuses the name outright. */
export const MCP_RESERVED_TOOL_PREFIX = "mcp:";

export function isReservedToolName(name: string): boolean {
  return name.startsWith(MCP_RESERVED_TOOL_PREFIX);
}

/** the ServerCapabilities key each grant opens */
const CAPABILITY_OF: Record<McpProtocolGrantName, "resources" | "prompts" | "completions" | "logging"> = {
  "mcp:resources": "resources",
  "mcp:prompts": "prompts",
  "mcp:completion": "completions",
  "mcp:logging": "logging",
};

/** how each governed method is parsed, decided, sent and read back */
interface MethodSpec {
  /** the SDK's own request schema (the SDK's zod, not ours) */
  request: { safeParse(v: unknown): { success: boolean; data?: unknown } };
  result: Parameters<Client["request"]>[1];
  /** the arguments the kernel decides on — and EXACTLY the params sent upstream */
  decided: (params: Record<string, unknown>) => Record<string, unknown>;
  /** a listing is bounded like a manifest read; the rest like a tool call */
  budget: "list" | "call";
}

const cursorOnly = (p: Record<string, unknown>) => (p.cursor !== undefined ? { cursor: p.cursor } : {});

const METHOD_SPECS: Record<McpProtocolMethod, MethodSpec> = {
  "resources/list": { request: ListResourcesRequestSchema, result: ListResourcesResultSchema, decided: cursorOnly, budget: "list" },
  "resources/templates/list": {
    request: ListResourceTemplatesRequestSchema,
    result: ListResourceTemplatesResultSchema,
    decided: cursorOnly,
    budget: "list",
  },
  // THE DATA-ACCESS DECISION: the kernel sees `{uri}` and nothing else, so a
  // data-scope rule on argPath `uri` is an exact allow-list of readable URIs
  "resources/read": { request: ReadResourceRequestSchema, result: ReadResourceResultSchema, decided: (p) => ({ uri: p.uri }), budget: "call" },
  "prompts/list": { request: ListPromptsRequestSchema, result: ListPromptsResultSchema, decided: cursorOnly, budget: "list" },
  "prompts/get": {
    request: GetPromptRequestSchema,
    result: GetPromptResultSchema,
    decided: (p) => ({ name: p.name, ...(p.arguments !== undefined ? { arguments: p.arguments } : {}) }),
    budget: "call",
  },
  "completion/complete": {
    request: CompleteRequestSchema,
    result: CompleteResultSchema,
    decided: (p) => ({ ref: p.ref, argument: p.argument, ...(p.context !== undefined ? { context: p.context } : {}) }),
    budget: "call",
  },
  "logging/setLevel": { request: SetLevelRequestSchema, result: EmptyResultSchema, decided: (p) => ({ level: p.level }), budget: "call" },
};

export function isGovernedProtocolMethod(method: string): method is McpProtocolMethod {
  return (MCP_PROTOCOL_METHODS as readonly string[]).includes(method);
}

/** refused always, whatever the org enables (prefix entries end in `/`) */
export function isRefusedProtocolMethod(method: string): boolean {
  return MCP_PROTOCOL_REFUSED_METHODS.some((m) => (m.endsWith("/") ? method.startsWith(m) : method === m));
}

/**
 * The capabilities the proxy advertises: `tools` always, and each protocol
 * capability only when the org has enabled at least one method under it.
 * Never `subscribe` or `listChanged` — the proxy is stateless and relays
 * neither.
 */
export function protocolCapabilities(enabled: readonly string[]): ServerCapabilities {
  const caps: ServerCapabilities = { tools: {} };
  for (const method of enabled) {
    if (!isGovernedProtocolMethod(method)) continue;
    caps[CAPABILITY_OF[MCP_PROTOCOL_METHOD_GRANTS[method].grant]] = {};
  }
  return caps;
}

/** audit text: a client-chosen method name, bounded */
const methodLabel = (method: string) => method.slice(0, 200);

export type GovernedProtocolCallOutcome =
  | { kind: "allowed"; result: Record<string, unknown> }
  /** -32601: not a method this gateway knows, or the upstream does not advertise it */
  | { kind: "method_not_found" }
  /** refused always (`mcp-method-unsupported`) */
  | { kind: "unsupported"; reason: string }
  | { kind: "invalid_params"; detail: string }
  /** the upstream answered, and the output scans withheld it */
  | { kind: "output_withheld"; reason: string }
  | Exclude<GovernedToolCallOutcome, { kind: "allowed" | "unknown_tool" }>;

export interface GovernedProtocolCallArgs {
  userId: string;
  serverId: string;
  method: string;
  params?: Record<string, unknown> | undefined;
  projectId?: string | null;
  principal?: AbacPrincipalContext;
  trace?: TraceContext | null;
  /**
   * Forward an upstream notification to the caller (the route passes the
   * request's `sendNotification`). Used only when the org enables
   * `logging/setLevel`; otherwise upstream `notifications/message` and
   * `notifications/progress` are dropped. Every forwarded one has passed the
   * output scans.
   */
  relay?: ((n: ServerNotification) => Promise<void>) | undefined;
  /** the caller's own progress token, when it asked for progress */
  progressToken?: string | number | undefined;
}

/**
 * The one governed protocol-call primitive — the twin of
 * `executeGovernedToolCall`. Never throws for a governance outcome; upstream
 * failures (and our own admission/egress refusals) are thrown, as on the tool
 * path, so the route maps them the same way.
 */
export async function executeGovernedProtocolCall(
  db: Db,
  args: GovernedProtocolCallArgs,
): Promise<GovernedProtocolCallOutcome> {
  const startedAt = new Date();
  const outcome = await executeInner(db, args);
  if (args.trace) {
    const denied = outcome.kind !== "allowed" && outcome.kind !== "method_not_found" && outcome.kind !== "invalid_params";
    await recordSpan(db, args.trace, {
      kind: "tool",
      name: args.method,
      status: denied ? "denied" : outcome.kind === "allowed" ? "ok" : "error",
      statusReason: outcome.kind === "denied" ? outcome.decision.reason : "reason" in outcome ? String(outcome.reason) : null,
      startedAt,
      mcpServerId: args.serverId,
      costUsd: null,
      inputText: null,
      outputText: null,
      contentWithheld: outcome.kind !== "allowed",
      attributes: { outcome: outcome.kind, method: methodLabel(args.method) },
    });
  }
  return outcome;
}

async function executeInner(db: Db, args: GovernedProtocolCallArgs): Promise<GovernedProtocolCallOutcome> {
  const { userId, serverId, method } = args;
  const projectId = args.projectId ?? null;

  // GATE 0 — refused always, audited by name
  if (isRefusedProtocolMethod(method)) {
    const reason = `MCP method '${methodLabel(method)}' is not supported by this gateway and is always refused`;
    await db.insert(auditLog).values({
      userId,
      serverId,
      detail: { phase: "protocol", method: methodLabel(method), projectId },
      effect: "deny",
      ruleId: "mcp-method-unsupported",
      ruleChain: [],
      reason,
    });
    recordDecision({ surface: "mcp_protocol", effect: "deny" });
    return { kind: "unsupported", reason };
  }
  if (!isGovernedProtocolMethod(method)) return { kind: "method_not_found" };

  const { grant, kind } = MCP_PROTOCOL_METHOD_GRANTS[method];
  const spec = METHOD_SPECS[method];

  // GATE 1 — the org enables the method (empty by default: all refused)
  const org = await loadOrgSettings(db);
  const enabled = (org.mcpProtocolMethods ?? []) as readonly string[];
  if (!enabled.includes(method)) {
    const decision: Decision = {
      effect: "deny",
      ruleId: "mcp-method-disabled",
      ruleChain: [],
      reason: `MCP method '${method}' is not enabled for this organization (mcpProtocolMethods)`,
    };
    await db.insert(auditLog).values({
      userId,
      serverId,
      toolName: grant,
      detail: { phase: "protocol", method, projectId },
      ...decision,
    });
    recordDecision({ surface: "mcp_protocol", effect: "deny" });
    return { kind: "denied", decision };
  }

  const parsed = spec.request.safeParse({ method, params: args.params ?? {} });
  if (!parsed.success) {
    return { kind: "invalid_params", detail: `invalid ${method} request` };
  }
  const decided = spec.decided(((parsed.data as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown>);

  const [serverRow] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
  if (!serverRow) return { kind: "method_not_found" };

  // GATE 2 — the kernel, on the protocol surface
  const ref = { serverId, name: grant, kind, surface: "protocol" as const };
  const { decision, approvedApprovalId, argumentsDigest, approvalScope, contextDigest, policyEpoch, retiredApprovals } =
    await governedEvaluate(
      db,
      userId,
      serverId,
      ref,
      decided,
      null,
      projectId,
      args.principal,
      undefined,
      undefined,
      approvalTargetForServer(serverId, serverRow),
    );
  await db.insert(auditLog).values({
    userId,
    serverId,
    toolName: grant,
    detail: {
      phase: "protocol",
      method,
      argumentsDigest,
      approvalScope,
      contextDigest,
      projectId,
      target: auditTarget(serverRow),
    },
    effect: decision.effect,
    ruleId: decision.ruleId,
    ruleChain: decision.ruleChain,
    reason: decision.reason,
  });
  recordDecision({ surface: "mcp_protocol", effect: decision.effect });
  if (decision.effect === "deny") return { kind: "denied", decision };

  // ADR-0023 — a read_only project may not run a WRITE method (logging/setLevel)
  if (kind === "write" && projectId) {
    const mcpMode = await projectMcpMode(db, projectId);
    if (mcpMode?.mode === "read_only") {
      const reason =
        `write method '${method}' denied: project '${mcpMode.projectName}' (${projectId}) is read_only under ` +
        `compliance profile(s) ${mcpMode.governingTags.map((t) => `'${t}'`).join(", ")} (mcpDefaultMode)`;
      const deny: Decision = { effect: "deny", ruleId: "mcp-default-mode", ruleChain: [], reason };
      await db.insert(auditLog).values({
        userId,
        serverId,
        toolName: grant,
        detail: { phase: "compliance", method, mcpDefaultMode: "read_only", projectId, governingTags: mcpMode.governingTags },
        ...deny,
      });
      return { kind: "denied", decision: deny };
    }
  }

  // ADR-0103 — a frozen project dispatches nothing, protocol methods included
  const projectBudget = await preDispatchProjectGate(db, projectId, userId);
  if (!projectBudget.ok) {
    await db.insert(auditLog).values({
      userId,
      serverId,
      toolName: grant,
      detail: { phase: "project-budget", method, projectId },
      effect: "deny",
      ruleId: "project-budget-cap",
      ruleChain: [],
      reason: `MCP method '${method}' blocked: ${projectBudget.error} — ${projectBudget.detail ?? "project budget exhausted"}`,
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
      toolName: grant,
      projectId,
      decision,
      retiredApprovals,
      contextDigest,
      approvalScope,
      argumentsDigest,
      argumentsPreview: approvalArgumentsPreview(decided),
      argumentsPreviewKind: "arguments_v1",
    });
  }

  // INPUT SCANS — the decided arguments (a resource URI, prompt arguments,
  // completion arguments), before anything reaches the upstream
  const piiMode = await projectPiiMode(db, projectId);
  const piiIntl = await piiInternationalCategories(db);
  const inputText = JSON.stringify(decided);
  let inputHits: PiiHit[] = [];
  if (piiMode) {
    // redaction of protocol arguments is not offered (the consent and the
    // data-scope decision are bound to these exact bytes): a hit is refused
    inputHits = piiMode === "redact" ? redactPiiPayload(decided, piiIntl).hits : enforcePII(piiMode, { input: inputText }, piiIntl).hits;
    if (inputHits.length > 0 && (piiMode === "block" || piiMode === "redact")) {
      const reason =
        piiMode === "redact"
          ? `MCP method '${method}' arguments contain PII (${piiCategoryList(inputHits)}) and are not redacted on this path`
          : `input contains PII: ${piiCategoryList(inputHits)}`;
      await db.insert(auditLog).values({
        userId,
        serverId,
        toolName: grant,
        detail: { phase: "pii", method, pii: { mode: piiMode, action: "block", phase: "input", inputHits, outputHits: [] }, projectId },
        effect: "deny",
        ruleId: "pii-blocked",
        ruleChain: [],
        reason,
      });
      return { kind: "pii_blocked", reason, pii: { mode: piiMode, action: "block", inputHits, outputHits: [], withheld: false } };
    }
  }
  const guardrails = await resolveGuardrailPolicy(db, { projectId });
  if (guardrails.active) {
    const evaluation = runGuardrails(guardrails, "input", inputText);
    const g = guardrailOutcome(evaluation);
    if (g) {
      await recordGuardrailDecision(db, {
        userId,
        objectType: "mcp_server",
        objectId: serverId,
        projectId,
        evaluation,
        outcome: g,
        detail: { toolName: grant, method, serverId },
      });
    }
    if (evaluation.action === "block") {
      const reason = `${method} arguments blocked by guardrail: ${guardrailCategoryList(evaluation.blocking)}`;
      return {
        kind: "guardrail_blocked",
        reason,
        guardrails: { action: "block", phase: "input", findings: flattenFindings(evaluation.findings), withheld: false },
      };
    }
  }

  // ONLY NOW does anything reach the upstream: admission + egress first
  // (AER-024), then the breaker, then the connect.
  await preflightUpstream(db, serverRow);
  const breaker = await breakerAdmits(db, serverRow);
  if (breaker) return { kind: "upstream_circuit_open", reason: breaker.reason, retryAfterMs: breaker.refusedUntilMs };
  let upstream: Client | null = null;
  try {
    try {
      upstream = await connectUpstream(db, serverRow);
    } catch (err) {
      if (classifyUpstreamError(err).why !== "our_own_refusal") {
        await recordUpstreamFailure(db, serverRow, err instanceof Error ? err.message : String(err));
      }
      throw err;
    }

    // GATE 3 — the upstream advertises the capability (its initialize answer)
    if (!upstream.getServerCapabilities()?.[CAPABILITY_OF[grant]]) {
      await recordUpstreamSuccess(db, serverRow);
      return { kind: "method_not_found" };
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
        toolName: grant,
        projectId,
      });
      if (refused) return refused;
    }

    // upstream notifications: forwarded only when the org enables logging, and
    // only after the output scans; otherwise dropped
    const relaying = !!args.relay && enabled.includes("logging/setLevel");
    if (relaying) {
      upstream.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
        const params = await scanForRelay(n.params, { projectId, piiIntl, piiMode, guardrails });
        if (params) await args.relay!({ method: "notifications/message", params: params as never });
      });
    }
    const downstreamToken = args.progressToken;
    let result: Record<string, unknown>;
    try {
      result = (await withUpstreamRetry(
        ({ deadlineMs }) =>
          upstream!.request({ method, params: decided } as never, spec.result, {
            timeout: deadlineMs,
            ...(relaying && downstreamToken !== undefined
              ? {
                  onprogress: (p: { progress: number; total?: number; message?: string }) => {
                    void (async () => {
                      const scanned = await scanForRelay(p, { projectId, piiIntl, piiMode, guardrails });
                      if (!scanned) return;
                      await args.relay!({
                        method: "notifications/progress",
                        params: { ...(scanned as Record<string, unknown>), progressToken: downstreamToken } as never,
                      });
                    })().catch(() => undefined);
                  },
                }
              : {}),
          }),
        {
          budgetMs: spec.budget === "list" ? timeouts().mcpListToolsMs : timeouts().mcpCallToolMs,
          // AER-038's rule for tools, kept: one attempt
          maxAttempts: 1,
        },
      )) as Record<string, unknown>;
    } catch (err) {
      if (classifyUpstreamError(err).why !== "our_own_refusal") {
        await recordUpstreamFailure(db, serverRow, err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
    await recordUpstreamSuccess(db, serverRow);

    // OUTPUT SCANS — the same contract as a tool result
    let released: Record<string, unknown> = result;
    let outputHits: PiiHit[] = [];
    let withheldReason: string | null = null;
    if (piiMode === "redact") {
      try {
        // base64 blobs cannot be inspected, so they cannot be released redacted
        if (JSON.stringify(result).includes('"blob"')) throw new Error("uninspectable");
        const transformed = redactPiiPayload(result, piiIntl);
        outputHits = transformed.hits;
        released = transformed.value as Record<string, unknown>;
      } catch {
        withheldReason = "output could not be released under the PII redaction policy";
      }
    } else if (piiMode) {
      const chk = enforcePII(piiMode, { output: JSON.stringify(result) }, piiIntl);
      outputHits = chk.hits;
      if (chk.action === "block") withheldReason = `output contains PII: ${piiCategoryList(chk.hits)}`;
    }
    if (withheldReason) {
      await db.insert(auditLog).values({
        userId,
        serverId,
        toolName: grant,
        detail: { phase: "pii", method, pii: { mode: piiMode, action: "block", phase: "output", inputHits, outputHits }, projectId },
        effect: "deny",
        ruleId: "pii-blocked",
        ruleChain: [],
        reason: `${withheldReason} — withheld`,
      });
      return { kind: "output_withheld", reason: withheldReason };
    }
    if (piiMode === "warn" && (inputHits.length > 0 || outputHits.length > 0)) {
      await db.insert(auditLog).values({
        userId,
        serverId,
        toolName: grant,
        detail: { phase: "pii", method, pii: { mode: piiMode, action: "warn", inputHits, outputHits }, projectId },
        effect: "allow",
        ruleId: "pii-warned",
        ruleChain: [],
        reason: `PII detected (${piiCategoryList([...inputHits, ...outputHits])}) — warned, ${method} proceeded`,
      });
    }
    if (guardrails.active) {
      const evaluation = runGuardrails(guardrails, "output", JSON.stringify(result));
      const g = guardrailOutcome(evaluation);
      if (g) {
        await recordGuardrailDecision(db, {
          userId,
          objectType: "mcp_server",
          objectId: serverId,
          projectId,
          evaluation,
          outcome: g,
          detail: { toolName: grant, method, serverId },
        });
      }
      if (evaluation.action === "block") {
        return {
          kind: "output_withheld",
          reason: `guardrail violation: ${guardrailCategoryList(evaluation.blocking)}`,
        };
      }
    }
    return { kind: "allowed", result: released };
  } finally {
    if (upstream) await upstream.close();
  }
}

/** the output scans for one relayed upstream notification: null = drop it */
async function scanForRelay(
  payload: unknown,
  ctx: {
    projectId: string | null;
    piiIntl: Awaited<ReturnType<typeof piiInternationalCategories>>;
    piiMode: Awaited<ReturnType<typeof projectPiiMode>>;
    guardrails: Awaited<ReturnType<typeof resolveGuardrailPolicy>>;
  },
): Promise<unknown | null> {
  let value: unknown = payload;
  try {
    if (ctx.piiMode === "redact") {
      value = redactPiiPayload(payload, ctx.piiIntl).value;
    } else if (ctx.piiMode && enforcePII(ctx.piiMode, { output: JSON.stringify(payload) }, ctx.piiIntl).action === "block") {
      return null;
    }
  } catch {
    return null;
  }
  if (ctx.guardrails.active && runGuardrails(ctx.guardrails, "output", JSON.stringify(value)).action === "block") {
    return null;
  }
  return value;
}

/** AER-039 — the upstream a call was bound to, safe for the audit ledger
 * (the same shape the tool path writes) */
function auditTarget(row: { url: string; allowPrivateRanges: boolean | null; admissionManifestDigest: string | null }) {
  let host: string | null = null;
  try {
    host = new URL(row.url).host;
  } catch {
    host = null;
  }
  return { host, allowPrivateRanges: row.allowPrivateRanges ?? null, admissionManifestDigest: row.admissionManifestDigest ?? null };
}

/** The protocol outcome as the MCP answer the route returns (or throws). */
export function protocolOutcomeResult(
  outcome: GovernedProtocolCallOutcome,
  method: string,
  governanceError: (o: Exclude<GovernedToolCallOutcome, { kind: "allowed" | "unknown_tool" }>) => McpError,
): Record<string, unknown> {
  switch (outcome.kind) {
    case "allowed":
      return outcome.result;
    case "method_not_found":
      throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${methodLabel(method)}`);
    case "unsupported":
      throw new McpError(ErrorCode.InvalidRequest, `Denied by policy: ${outcome.reason}`);
    case "invalid_params":
      throw new McpError(ErrorCode.InvalidParams, outcome.detail);
    case "output_withheld":
      throw new McpError(ErrorCode.InvalidRequest, `Denied by policy: ${method} output withheld — ${outcome.reason}`);
    default:
      throw governanceError(outcome);
  }
}

/**
 * Wire the protocol surface into one proxy `Server` (one per HTTP request,
 * stateless). Every non-tool request reaches the fallback handler, so a
 * disabled method is still ANSWERED ("Denied by policy", audited) rather than
 * left to the SDK's silent -32601, and the SDK's own local `logging/setLevel`
 * handler is removed so the method is decided, not swallowed. Client
 * notifications other than `initialized` / `cancelled` are dropped, with ONE
 * `mcp-notification-dropped` audit row per HTTP request (`flush`).
 */
export function installProtocolSurface(
  proxy: Server,
  ctx: {
    db: Db;
    call: (
      method: string,
      params: Record<string, unknown> | undefined,
      extra: { relay: (n: ServerNotification) => Promise<void>; progressToken?: string | number },
    ) => Promise<Record<string, unknown>>;
    userId: string;
    serverId: string;
    projectId: string | null;
  },
): { flush: () => Promise<void> } {
  proxy.removeRequestHandler("logging/setLevel");
  proxy.fallbackRequestHandler = async (request: JSONRPCRequest, extra) => {
    const params = request.params as (Record<string, unknown> & { _meta?: { progressToken?: string | number } }) | undefined;
    const progressToken = params?._meta?.progressToken;
    return ctx.call(request.method, params, {
      relay: (n) => extra.sendNotification(n as never),
      ...(progressToken !== undefined ? { progressToken } : {}),
    }) as never;
  };
  const dropped: string[] = [];
  // the Protocol's own progress handler serves requests WE send; the proxy
  // sends none, so a client progress notification is just another drop
  proxy.setNotificationHandler(ProgressNotificationSchema, async (n) => {
    dropped.push(n.method);
  });
  proxy.fallbackNotificationHandler = async (n) => {
    dropped.push(methodLabel(n.method));
  };
  let flushed = false;
  return {
    flush: async () => {
      if (flushed || dropped.length === 0) return;
      flushed = true;
      await ctx.db.insert(auditLog).values({
        userId: ctx.userId,
        serverId: ctx.serverId,
        detail: { phase: "protocol", notifications: [...new Set(dropped)].slice(0, 20), count: dropped.length, projectId: ctx.projectId },
        effect: "deny",
        ruleId: "mcp-notification-dropped",
        ruleChain: [],
        reason: `${dropped.length} client notification(s) dropped: the gateway relays no client notifications upstream`,
      });
    },
  };
}
