/**
 * ADR-0173 §1 — the builder agent's TOOLBOX as the model sees it, and one tool
 * call run through the governed paths.
 *
 * Nothing here decides access. The toolbox offered to the model is the agent's
 * configured toolbox RE-CHECKED FOR THE PERSON THE TURN RUNS AS (the same
 * helpers the editor and the integrations page use), so a shared agent never
 * offers a tool its user lacks; and every call goes through the one governed
 * primitive for its kind — `executeGovernedToolCall` (MCP) or
 * `executeGovernedConnectorCall` (connectors) — as that person, which re-checks
 * the grant, the kill switch, approval rules (bound to the argument digest),
 * PII, guardrails, egress, the breaker, the project budget and metering. A tool
 * the model names that is not in the re-checked toolbox is refused here
 * without a call being made.
 */
import { createHash } from "node:crypto";
import {
  builderAgentTools,
  connectors,
  eq,
  inArray,
  mcpServers,
  mcpTools,
  type BuilderAgentRow,
  type Db,
} from "@regulait/db";
import type { ModelToolDef } from "@regulait/model-provider";
import {
  approvalArgumentsDigest,
  approvalArgumentsPreview,
  redactPiiPayload,
  type InternationalPiiCategory,
} from "@regulait/shared";
import { entitledConnectorIds, entitledMcpToolIds } from "./builder-access.js";
import { executeGovernedConnectorCall } from "./connector-call.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import type { PiiMode } from "./projects.js";
import type { TraceContext } from "./tracing.js";

/** the longest tool name every provider accepts (`^[a-zA-Z0-9_-]{1,64}$`) */
const TOOL_NAME_MAX = 64;
/** what the model is handed back from one call (the thread shows a shorter preview) */
export const TOOL_RESULT_MODEL_MAX = 16_000;
export const TOOL_RESULT_PREVIEW_MAX = 2_000;

export interface ToolEntry {
  /** the model-facing name: `server__tool` for MCP, `connector__name` for a connector */
  name: string;
  /** what a person reads: "server / tool" or the connector's name */
  displayName: string;
  kind: "mcp_tool" | "connector";
  refId: string;
  /** the agent's own "Ask first" flag — a confirmation, never an approval */
  requiresApproval: boolean;
  /** connector provider kind or MCP server name (the web picks a logo from it) */
  provider: string | null;
  def: ModelToolDef;
  serverId?: string;
  toolName?: string;
  operations?: Array<"read" | "write">;
}

export interface Toolbox {
  entries: ToolEntry[];
  byName: Map<string, ToolEntry>;
  /** toolbox entries this person may not use — never offered and never named
   * to the model (the prompt says only how many there are) */
  unavailable: Array<{ displayName: string; kind: "mcp_tool" | "connector" }>;
}

function slug(s: string): string {
  const v = s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_{3,}/g, "__")
    .replace(/^[_-]+|[_-]+$/g, "");
  return v || "tool";
}

/** a short, stable fingerprint of a toolbox entry's identity */
function refHash(kind: string, refId: string): string {
  return createHash("sha256").update(`${kind}:${refId}`).digest("hex").slice(0, 8);
}

/**
 * The model-facing name of every configured toolbox entry, DETERMINISTIC and
 * independent of row order and of who is asking. A name is
 * `slug(server)__slug(tool)` (or `connector__slug(name)`) cut to 64
 * characters. When two or more entries would share a name, EVERY one of them
 * carries a short hash of its own identity (`…_<8 hex>`), so no entry "wins"
 * the plain name by being inserted first — and the clash is judged over the
 * whole configured toolbox (whatever this person may use), so a grant revoked
 * from one person cannot hand its name to a different tool.
 */
export function toolNames(items: Array<{ kind: string; refId: string; base: string }>): Map<string, string> {
  const cut = (b: string) => b.slice(0, TOOL_NAME_MAX);
  const hashed = (it: { kind: string; refId: string; base: string }) => {
    const suffix = `_${refHash(it.kind, it.refId)}`;
    return it.base.slice(0, TOOL_NAME_MAX - suffix.length) + suffix;
  };
  const counts = new Map<string, number>();
  for (const it of items) counts.set(cut(it.base), (counts.get(cut(it.base)) ?? 0) + 1);
  const out = new Map<string, string>();
  const taken = new Set<string>();
  const sorted = [...items].sort((a, b) => `${a.kind}:${a.refId}`.localeCompare(`${b.kind}:${b.refId}`));
  // the clashing names first: unique by construction
  for (const it of sorted) {
    if ((counts.get(cut(it.base)) ?? 0) < 2) continue;
    const name = hashed(it);
    out.set(`${it.kind}:${it.refId}`, name);
    taken.add(name);
  }
  // then the plain ones (a plain name equal to a hashed one is astronomically
  // unlikely; it is hashed too rather than shadowing it)
  for (const it of sorted) {
    const key = `${it.kind}:${it.refId}`;
    if (out.has(key)) continue;
    const name = taken.has(cut(it.base)) ? hashed(it) : cut(it.base);
    out.set(key, name);
    taken.add(name);
  }
  return out;
}

/** the operations a connector kind supports (ADR-0121: outlook is send-only) */
export function connectorOperations(providerKind: string | null): Array<"read" | "write"> {
  return providerKind === "outlook" ? ["write"] : ["read", "write"];
}

function connectorSchema(ops: Array<"read" | "write">): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ops,
        description: "read fetches data; write changes or sends something",
      },
      object: { type: "string", description: "what to act on (a channel, repository, table, path …)" },
      payload: { type: "object", description: "the request body or read parameters", additionalProperties: true },
    },
    required: ["operation"],
    additionalProperties: false,
  };
}

/** an MCP tool's stored schema, or an open object when the manifest had none */
function mcpSchema(stored: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (stored && typeof stored === "object" && stored["type"] === "object") return stored;
  return { type: "object", properties: {}, additionalProperties: true };
}

/**
 * The agent's toolbox for `userId`, re-checked now. Connector entries need a
 * live connector grant (no full revocation); MCP entries need the kernel's
 * `visibleTools` verdict on a server whose admission does not hide its tools.
 */
export async function resolveToolbox(db: Db, agent: BuilderAgentRow, userId: string): Promise<Toolbox> {
  const rows = await db.select().from(builderAgentTools).where(eq(builderAgentTools.agentId, agent.id));
  const out: Toolbox = { entries: [], byName: new Map(), unavailable: [] };
  if (!rows.length) return out;
  const connectorIds = rows.filter((r) => r.kind === "connector").map((r) => r.refId);
  const mcpIds = rows.filter((r) => r.kind === "mcp_tool").map((r) => r.refId);
  const [connectorRows, mcpRows] = await Promise.all([
    connectorIds.length
      ? db
          .select({ id: connectors.id, name: connectors.name, kind: connectors.kind, providerKind: connectors.providerKind })
          .from(connectors)
          .where(inArray(connectors.id, connectorIds))
      : Promise.resolve([]),
    mcpIds.length
      ? db
          .select({
            id: mcpTools.id,
            name: mcpTools.name,
            serverId: mcpTools.serverId,
            serverName: mcpServers.name,
            kind: mcpTools.kind,
            description: mcpTools.description,
            inputSchema: mcpTools.inputSchema,
          })
          .from(mcpTools)
          .innerJoin(mcpServers, eq(mcpTools.serverId, mcpServers.id))
          .where(inArray(mcpTools.id, mcpIds))
      : Promise.resolve([]),
  ]);
  const [okConnectors, okTools] = await Promise.all([
    connectorIds.length ? entitledConnectorIds(db, userId) : Promise.resolve(new Set<string>()),
    mcpRows.length
      ? entitledMcpToolIds(
          db,
          userId,
          mcpRows.map((m) => ({ id: m.id, name: m.name, serverId: m.serverId, serverName: m.serverName, kind: m.kind })),
        )
      : Promise.resolve(new Set<string>()),
  ]);
  // names over the WHOLE configured toolbox (every tool that still exists),
  // before the per-person entitlement filter — see toolNames
  const names = toolNames(
    rows.flatMap((r): Array<{ kind: string; refId: string; base: string }> => {
      if (r.kind === "connector") {
        const c = connectorRows.find((x) => x.id === r.refId);
        return c ? [{ kind: r.kind, refId: r.refId, base: `connector__${slug(c.name)}` }] : [];
      }
      const m = mcpRows.find((x) => x.id === r.refId);
      return m ? [{ kind: r.kind, refId: r.refId, base: `${slug(m.serverName)}__${slug(m.name)}` }] : [];
    }),
  );
  // a stable order for the listing (the names do not depend on it)
  const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  for (const r of ordered) {
    if (r.kind === "connector") {
      const c = connectorRows.find((x) => x.id === r.refId);
      if (!c) continue;
      if (!okConnectors.has(c.id)) {
        out.unavailable.push({ displayName: c.name, kind: "connector" });
        continue;
      }
      const ops = connectorOperations(c.providerKind);
      const name = names.get(`connector:${c.id}`)!;
      out.entries.push({
        name,
        displayName: c.name,
        kind: "connector",
        refId: c.id,
        requiresApproval: r.requiresApproval,
        provider: c.providerKind ?? c.kind,
        operations: ops,
        def: {
          name,
          description:
            `Connector '${c.name}' (${c.providerKind ?? c.kind}). ` +
            `Operations: ${ops.join(", ")}.${r.requiresApproval ? " Asks the person to confirm before it runs." : ""}`,
          inputSchema: connectorSchema(ops),
        },
      });
    } else {
      const m = mcpRows.find((x) => x.id === r.refId);
      if (!m) continue;
      const displayName = `${m.serverName} / ${m.name}`;
      if (!okTools.has(m.id)) {
        out.unavailable.push({ displayName, kind: "mcp_tool" });
        continue;
      }
      const name = names.get(`mcp_tool:${m.id}`)!;
      out.entries.push({
        name,
        displayName,
        kind: "mcp_tool",
        refId: m.id,
        requiresApproval: r.requiresApproval,
        provider: m.serverName,
        serverId: m.serverId,
        toolName: m.name,
        def: {
          name,
          description:
            `${(m.description ?? "").trim() || `MCP tool '${m.name}' on '${m.serverName}'`} ` +
            `(${m.kind === "write" ? "can make changes" : "read-only"})` +
            `${r.requiresApproval ? "; asks the person to confirm before it runs" : ""}`,
          inputSchema: mcpSchema(m.inputSchema),
        },
      });
    }
  }
  for (const e of out.entries) out.byName.set(e.name, e);
  return out;
}

/** the toolbox paragraph of the system prompt */
export function toolboxPrompt(box: Toolbox): string | null {
  if (!box.entries.length && !box.unavailable.length) return null;
  const lines: string[] = [
    "## Toolbox",
    "You can call the tools below. Every call runs as the person you are helping, with their permissions and " +
      "the organisation's policies: a call can be refused, can wait for the person to confirm it (\"asks first\"), " +
      "or can wait for an approver. Use a tool only when it helps, and never say a tool ran unless you received " +
      "its result.",
  ];
  for (const e of box.entries) {
    lines.push(`- \`${e.name}\` — ${e.displayName} (${e.kind === "connector" ? "connector" : "MCP tool"}${e.requiresApproval ? ", asks first" : ""})`);
  }
  // a tool the person holds no grant on is never NAMED to the model: its name
  // (and with it the existence of a connector or MCP server) is not theirs
  if (box.unavailable.length) {
    const n = box.unavailable.length;
    lines.push(`${n} tool${n === 1 ? "" : "s"} in this agent's toolbox ${n === 1 ? "is" : "are"} not available to you.`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// arguments: what is stored, and the fingerprint
// ---------------------------------------------------------------------------

/** the stored PREVIEW of a call's arguments: the ADR-0099/0102 credential scrub
 * (the approvals queue's own preview), then §8.4 PII redaction when the turn's
 * project has a PII mode. Never the raw payload. */
export function redactedArguments(
  args: Record<string, unknown>,
  piiMode: PiiMode | null,
  intl: readonly InternationalPiiCategory[],
): unknown {
  const scrubbed = approvalArgumentsPreview(args);
  if (!piiMode) return scrubbed;
  try {
    return redactPiiPayload(scrubbed, intl).value;
  } catch {
    return { withheld: "the arguments could not be safely redacted" };
  }
}

/** the approval-binding fingerprint (ADR-0104) of a call's arguments */
export function argumentsDigestFor(projectId: string | null, args: Record<string, unknown>): string {
  return approvalArgumentsDigest({ projectId, arguments: args });
}

export function toolResultText(content: unknown): string {
  const c = content as { content?: Array<{ type?: string; text?: string }> } | null;
  if (c && Array.isArray(c.content)) {
    const text = c.content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ");
    if (text) return text;
  }
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content ?? null);
  } catch {
    return "[unserialisable tool result]";
  }
}

const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}… [truncated]`);

// ---------------------------------------------------------------------------
// one governed call
// ---------------------------------------------------------------------------

export interface ToolRun {
  status: "done" | "denied" | "refused" | "error";
  /** set when the governed path queued (or re-queued) an approval */
  approvalId?: string;
  /** the approval this call wanted was raised fresh (not a resume of ours) */
  approvalKind?: "approval_required" | "approval_expired" | "approval_context_stale";
  code: string | null;
  detail: string | null;
  /** the tool_result the model is handed */
  modelText: string;
  isError: boolean;
  preview: string | null;
  withheld: boolean;
  /** argument preview must not be stored (the refusal was ABOUT the arguments) */
  argumentsRefused: boolean;
  costUsd: number | null;
}

export interface ToolRunContext {
  userId: string;
  isAdmin: boolean;
  projectId: string | null;
  trace: TraceContext | null;
  toolCallId: string;
  /** correlation for the governed call's own audit row */
  detail: Record<string, unknown>;
}

function refused(code: string, detail: string, opts: Partial<ToolRun> = {}): ToolRun {
  return {
    status: "refused",
    code,
    detail,
    modelText: detail,
    isError: true,
    preview: null,
    withheld: false,
    argumentsRefused: false,
    costUsd: null,
    ...opts,
  };
}

/** validate a connector call's arguments against the generated schema */
function connectorArgs(
  entry: ToolEntry,
  args: Record<string, unknown>,
): { ok: true; operation: "read" | "write"; object?: string; payload?: Record<string, unknown> } | { ok: false; detail: string } {
  const op = args["operation"];
  const ops = entry.operations ?? ["read", "write"];
  if (op !== "read" && op !== "write") {
    return { ok: false, detail: `'operation' is required and must be one of: ${ops.join(", ")}` };
  }
  if (!ops.includes(op)) return { ok: false, detail: `this connector does not support '${op}' (allowed: ${ops.join(", ")})` };
  const object = args["object"];
  if (object !== undefined && (typeof object !== "string" || !object.length || object.length > 256)) {
    return { ok: false, detail: "'object' must be a non-empty string of at most 256 characters" };
  }
  const payload = args["payload"];
  if (payload !== undefined && (payload === null || typeof payload !== "object" || Array.isArray(payload))) {
    return { ok: false, detail: "'payload' must be an object" };
  }
  const extra = Object.keys(args).filter((k) => !["operation", "object", "payload"].includes(k));
  if (extra.length) return { ok: false, detail: `unexpected argument(s): ${extra.join(", ")}` };
  return {
    ok: true,
    operation: op,
    ...(typeof object === "string" ? { object } : {}),
    ...(payload ? { payload: payload as Record<string, unknown> } : {}),
  };
}

/**
 * Run one call through its governed path AS `ctx.userId`. Never throws: an
 * upstream failure is an `error` result the model is told about.
 */
export async function runGovernedTool(
  db: Db,
  dataKey: string | undefined,
  entry: ToolEntry,
  args: Record<string, unknown>,
  ctx: ToolRunContext,
): Promise<ToolRun> {
  if (entry.kind === "connector") return runConnector(db, dataKey, entry, args, ctx);
  let out: Awaited<ReturnType<typeof executeGovernedToolCall>>;
  try {
    out = await executeGovernedToolCall(db, dataKey, {
      userId: ctx.userId,
      serverId: entry.serverId!,
      toolName: entry.toolName!,
      arguments: args,
      projectId: ctx.projectId,
      trace: ctx.trace,
      toolCallId: ctx.toolCallId,
      detail: ctx.detail,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      code: "tool_call_failed",
      detail: cap(msg, 300),
      modelText: `the tool failed and nothing was returned: ${cap(msg, 300)}`,
      isError: true,
      preview: null,
      withheld: false,
      argumentsRefused: false,
      costUsd: null,
    };
  }
  switch (out.kind) {
    case "allowed": {
      const text = toolResultText(out.content);
      const withheld = !!(out.pii?.withheld || out.guardrails?.withheld);
      return {
        status: "done",
        code: null,
        detail: null,
        modelText: cap(text, TOOL_RESULT_MODEL_MAX),
        isError: false,
        preview: withheld ? null : cap(text, TOOL_RESULT_PREVIEW_MAX),
        withheld,
        argumentsRefused: false,
        costUsd: out.costUsd ?? null,
      };
    }
    case "denied":
      return {
        ...refused(out.decision.ruleId, out.decision.reason),
        status: "denied",
        modelText: `blocked by governance: ${out.decision.reason}`,
      };
    case "pii_blocked":
    case "guardrail_blocked":
      return {
        ...refused(out.kind, out.reason),
        status: "denied",
        modelText: `blocked by governance: ${out.reason}`,
        argumentsRefused: true,
        withheld: true,
      };
    case "budget_blocked":
      return {
        ...refused(out.error, out.detail ?? out.error),
        status: "denied",
        modelText: `blocked by governance: ${out.error}${out.detail ? ` — ${out.detail}` : ""}`,
      };
    case "upstream_circuit_open":
      return {
        ...refused("upstream_circuit_open", out.reason),
        status: "error",
        modelText:
          `the MCP server for this tool is unavailable: ${out.reason} Do not retry it for at least ` +
          `${Math.ceil(out.retryAfterMs / 1000)}s.`,
      };
    case "approval_required":
      return refused("approval_required", `approval '${out.approvalId}' is pending sign-off`, {
        approvalId: out.approvalId,
        approvalKind: "approval_required",
      });
    case "approval_expired":
    case "approval_context_stale": {
      const what = out.kind === "approval_expired" ? "expired before it was used" : "was granted under a policy that has since changed";
      const detail =
        `approval ${out.supersededApprovalIds.join(", ")} ${what} and was superseded` +
        (out.requeuedApprovalId ? `; approval '${out.requeuedApprovalId}' was raised in its place` : "");
      return refused(out.kind, detail, {
        ...(out.requeuedApprovalId ? { approvalId: out.requeuedApprovalId, approvalKind: out.kind } : {}),
      });
    }
    case "approval_consumed_race":
      return refused("approval_consumed_race", `approval '${out.approvalId}' was already used by another call`);
    case "unknown_tool":
      return refused("unknown_tool", `the server no longer offers '${entry.toolName}'`);
  }
}

async function runConnector(
  db: Db,
  dataKey: string | undefined,
  entry: ToolEntry,
  args: Record<string, unknown>,
  ctx: ToolRunContext,
): Promise<ToolRun> {
  const parsed = connectorArgs(entry, args);
  if (!parsed.ok) return refused("invalid_arguments", parsed.detail, { modelText: `invalid arguments: ${parsed.detail}` });
  let out: Awaited<ReturnType<typeof executeGovernedConnectorCall>>;
  try {
    out = await executeGovernedConnectorCall(db, dataKey, {
      userId: ctx.userId,
      isAdmin: ctx.isAdmin,
      connectorId: entry.refId,
      operation: parsed.operation,
      object: parsed.object,
      payload: parsed.payload,
      projectId: ctx.projectId,
      trace: ctx.trace,
      detail: ctx.detail,
    });
  } catch {
    return {
      status: "error",
      code: "connector_invoke_failed",
      detail: "the connector call failed; details withheld",
      modelText: "the connector call failed and nothing was returned",
      isError: true,
      preview: null,
      withheld: false,
      argumentsRefused: false,
      costUsd: null,
    };
  }
  const b = out.body;
  const error = typeof b["error"] === "string" ? (b["error"] as string) : null;
  const detail = typeof b["detail"] === "string" ? (b["detail"] as string) : null;
  const decision = b["decision"] as { reason?: string; ruleId?: string; effect?: string } | undefined;
  const costUsd = typeof b["costUsd"] === "number" ? (b["costUsd"] as number) : null;
  if (out.status < 400) {
    const result = b["result"] as { status?: number; body?: unknown } | undefined;
    const withheld =
      !!(b["pii"] as { withheld?: boolean } | undefined)?.withheld ||
      !!(b["guardrails"] as { withheld?: boolean } | undefined)?.withheld;
    const text =
      result === undefined
        ? "allowed — this connector is governance-only, so nothing was executed"
        : toolResultText(result.body ?? null);
    return {
      status: "done",
      code: null,
      detail: null,
      modelText: cap(text, TOOL_RESULT_MODEL_MAX),
      isError: false,
      preview: withheld ? null : cap(text, TOOL_RESULT_PREVIEW_MAX),
      withheld,
      argumentsRefused: false,
      costUsd,
    };
  }
  const reason = detail ?? decision?.reason ?? error ?? `refused (${out.status})`;
  const inputRefused = error === "pii_blocked" || error === "guardrail_blocked" || error === "pii_transform_refused";
  if (out.status >= 500) {
    return { ...refused(error ?? "connector_invoke_failed", reason), status: "error", modelText: `the connector call failed: ${reason}`, costUsd };
  }
  // a 403 is a governance decision (entitlement, kill switch, PII, guardrail,
  // egress, budget); any other 4xx is a refusal about the call itself
  const denied = out.status === 403 || out.status === 402 || error === "project_budget_exhausted";
  return {
    ...refused(error ?? decision?.ruleId ?? "connector_refused", reason),
    status: denied ? "denied" : "refused",
    modelText: denied ? `blocked by governance: ${reason}` : `refused: ${reason}`,
    argumentsRefused: inputRefused,
    withheld: inputRefused || !!b["withheld"],
    costUsd,
  };
}
