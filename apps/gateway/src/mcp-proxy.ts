import type { FastifyInstance } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
  mcpServers,
  mcpTools,
  usageEvents,
  userAgentPolicies,
  type Db,
} from "@regulait/db";
import { visibleTools, type Decision, type ToolRef } from "@regulait/policy-kernel";
import { selectTools } from "@regulait/optimizer-kernel";
import type { ModelToolDef } from "@regulait/model-provider";
import type { PiiHit } from "@regulait/shared";
import { governedEvaluate } from "./governed-evaluate.js";
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
 * Absent header = an unattributed call, byte-identical to the pre-ADR-0019
 * behaviour (no usage row, no PII enforcement — there is no project policy to
 * enforce).
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

export async function connectUpstream(url: string): Promise<Client> {
  const client = new Client({ name: "regulait-gateway", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
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
  | { kind: "allowed"; content: unknown; pii?: McpPii; costUsd?: number | null }
  | { kind: "unknown_tool" }
  | { kind: "denied"; decision: Decision }
  | { kind: "pii_blocked"; reason: string; pii: McpPii }
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
     * null/undefined = unattributed — no usage row and no PII enforcement,
     * byte-identical to the pre-ADR-0019 behaviour. */
    projectId?: string | null;
  },
): Promise<GovernedToolCallOutcome> {
  const { userId, serverId, toolName } = args;
  const projectId = args.projectId ?? null;
  const [serverRow] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
  if (!serverRow) return { kind: "unknown_tool" };

  const [toolRow] = await db
    .select()
    .from(mcpTools)
    .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)));
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
      upstream = await connectUpstream(serverRow.url);
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
    // cascade; an unattributed or unclassified call yields null and every check
    // below is a no-op. The INPUT check runs on the tool ARGUMENTS, before the
    // approval is consumed and before the upstream is contacted, so a block
    // executes nothing, consumes no approval and bills nothing.
    const piiMode: PiiMode | null = projectId ? await projectPiiMode(db, projectId) : null;
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

    if (!upstream) upstream = await connectUpstream(serverRow.url);
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

    // PILLAR 5 (ADR-0019): an ALLOWED, EXECUTED, ATTRIBUTED tool call bills the
    // server's flat per-call list price onto the SAME usage ledger the model and
    // connector paths write, so MCP spend rolls up in the project dashboard with
    // no separate reporting path. Unpriced server → null, never an invented
    // figure. UNATTRIBUTED calls write NOTHING — there is no project to bill,
    // and back-compat for the existing proxy behaviour is exact.
    if (projectId) {
      await db.insert(usageEvents).values({
        userId,
        objectType: "mcp_tool",
        // usage_events has no server column; `operation` carries the tool name
        // (as it carries the operation on connector rows) and the server id
        // rides the detail jsonb.
        operation: toolName,
        costUsd: serverRow.pricePerCallUsd ?? null,
        projectId,
        detail: {
          serverId,
          toolName,
          // §8.4 COUNTS ONLY — never the matched substrings
          ...(pii ? { pii: { mode: pii.mode, action: pii.action, inputHits, outputHits } } : {}),
        },
      });
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
      ...(projectId ? { costUsd: serverRow.pricePerCallUsd ?? null } : {}),
    };
  } finally {
    await closeUpstream();
  }
}

/** Discover the upstream tool manifest and sync it into the registry (§6: auto-discovered tool inventory). */
async function syncUpstreamTools(db: Db, serverId: string, client: Client): Promise<Tool[]> {
  const { tools } = await client.listTools();
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
      upstream = await connectUpstream(serverRow.url);
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
    }

    const upstream = await connectUpstream(serverRow.url);

    const proxy = new Server(
      { name: "regulait-gateway", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    proxy.setRequestHandler(ListToolsRequestSchema, async () => {
      const upstreamTools = await syncUpstreamTools(db, serverId, upstream);
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
      // The proxy route is now a thin governance-to-MCP-error mapper over the
      // shared primitive; the identical logic serves the worker loop too.
      const outcome = await executeGovernedToolCall(db, undefined, {
        userId,
        serverId,
        toolName,
        arguments: request.params.arguments,
        projectId,
      });

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
