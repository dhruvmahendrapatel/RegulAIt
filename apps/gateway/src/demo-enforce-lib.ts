/**
 * The "Enforce it" beat (ADR-0197 FS-8, made live by ADR-0202 decision 1), as a presenter command.
 *
 * LIVE (the default): Dana makes real governed calls through the gateway's own MCP route, `POST /mcp/:serverId`, over
 * the MCP protocol, with her own API key and the project header. Nothing here evaluates or executes a call itself:
 *  1. `tools/list` (her revoked tool is absent);
 *  2. `search_code` is denied by the gateway, audited, with her revocation named;
 *  3. `write_file` is queued by the gateway for the named approver;
 *  4. the queued approval is mirrored to every enabled ChatOps channel through the existing route
 *     (`POST /v1/chatops/approvals/:id/post`), so Slack, Teams, Outlook and any later mail channel are just entries;
 *  5. the command waits for the decision. Approved: the SAME call is retried and the gateway spends the approval and
 *     executes it. Denied, or no decision before the wait ends: nothing executes.
 *
 * SIMULATED (lane L's switch says so): exactly today's beat, the Simulation page's question asked of `POST
 * /v1/evaluate`, which executes and queues nothing, printed under the "simulated decision" label.
 *
 * The approver is never the requester: that is the gateway's rule, not this command's, and nothing here decides an
 * approval. The command's own key for Dana lives one day at most and is revoked at the end of the run.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEMO_SCRIPT_KEY_TTL_DAYS, demoKeyExpiresAt, revokeScriptKeys } from "./demo-identity.js";
import { PROJECT_HEADER } from "./project-header.js";

type Json = Record<string, any>;

export const ENFORCE_DEFAULTS = {
  requesterEmail: "dana@regulait.local",
  serverName: "repo-tools",
  projectName: "demo-project",
  deniedTool: "search_code",
  approvalTool: "write_file",
  /** five minutes: the beat is two, and the approver may be a person in another room */
  waitMs: 5 * 60_000,
  pollMs: 2_000,
} as const;

/** Fixed, so a re-run lands on the same pending approval (the gateway dedupes on the exact arguments). */
export const ENFORCE_WRITE_ARGS = {
  path: "docs/enforce-it.md",
  content: "Governed write from the Enforce it beat.\n",
  branch: "demo/enforce-it",
} as const;
const DENIED_ARGS = { pattern: "apiKey" } as const;

export interface EnforceBeatOptions {
  /** the running gateway, e.g. http://127.0.0.1:3000 */
  baseUrl: string;
  bootstrapToken: string;
  isSimulated: () => Promise<boolean>;
  requesterEmail?: string;
  serverName?: string;
  projectName?: string;
  deniedTool?: string;
  approvalTool?: string;
  writeArgs?: Record<string, string>;
  waitMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export type EnforceOutcome =
  | "simulated"
  | "executed"
  | "rejected"
  | "timed_out"
  | "unexpected"
  | "setup_error";

export interface EnforceBeatResult {
  exitCode: 0 | 1 | 2;
  outcome: EnforceOutcome;
  lines: string[];
  approvalId?: string;
}

const APPROVAL_ID = /approval '([0-9a-f-]{36})'/i;
const TERMINAL = new Set(["approved", "denied", "returned", "consumed", "superseded"]);

export async function runEnforceBeat(opts: EnforceBeatOptions): Promise<EnforceBeatResult> {
  const o = { ...ENFORCE_DEFAULTS, writeArgs: ENFORCE_WRITE_ARGS as Record<string, string>, ...opts };
  const lines: string[] = [];
  const say = (s: string) => {
    lines.push(s);
    o.log?.(s);
  };
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = o.baseUrl.replace(/\/+$/, "");
  const boot = { authorization: `Bearer ${o.bootstrapToken}` };

  async function api(method: string, url: string, body?: unknown, headers: Record<string, string> = boot) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: Json = {};
    try {
      json = (await res.json()) as Json;
    } catch {
      /* the status is the fact */
    }
    return { status: res.status, body: json };
  }
  const fail = (outcome: EnforceOutcome, why: string): EnforceBeatResult => {
    say(`SETUP  ${why}`);
    return { exitCode: 2, outcome, lines };
  };

  const users = (await api("GET", "/v1/users")).body.users as Json[] | undefined;
  const requester = users?.find((u) => u.email === o.requesterEmail);
  if (!requester) return fail("setup_error", `no user ${o.requesterEmail} (is the governance seed loaded?)`);
  const server = ((await api("GET", "/v1/servers")).body.servers as Json[] | undefined)?.find((s) => s.name === o.serverName);
  if (!server) return fail("setup_error", `no MCP server '${o.serverName}'`);

  if (await o.isSimulated()) {
    say(`SIMULATED DECISION  beat 'enforce-it' is on its fallback: the policy engine is asked, nothing runs or queues`);
    for (const tool of [o.deniedTool, o.approvalTool]) {
      const r = await api("POST", "/v1/evaluate", { userId: requester.id, serverId: server.id, toolName: tool });
      if (r.status !== 200) return fail("setup_error", `POST /v1/evaluate ${tool} -> ${r.status} ${String(r.body.error ?? "")}`);
      const d = r.body as Json;
      say(
        `  simulated decision  ${tool}: ${d.effect}  (${d.ruleId ?? "no rule"})` +
          (d.approverName ? `  requires sign-off from ${d.approverName}` : "") +
          (d.reason ? `  ${d.reason}` : ""),
      );
    }
    say("  Same answer as /ui/admin/simulation. Show that page and the advisory audit rows.");
    return { exitCode: 0, outcome: "simulated", lines };
  }

  const project = ((await api("GET", "/v1/projects")).body.projects as Json[] | undefined)?.find((p) => p.name === o.projectName);
  if (!project) return fail("setup_error", `no project '${o.projectName}'`);

  const minted = await api("POST", `/v1/users/${requester.id}/keys`, {
    name: "demo-enforce",
    expiresAt: demoKeyExpiresAt(DEMO_SCRIPT_KEY_TTL_DAYS),
  });
  if (minted.status !== 201 || typeof minted.body.token !== "string") {
    return fail("setup_error", `could not issue a key for ${o.requesterEmail}: ${minted.status} ${String(minted.body.error ?? "")}`);
  }
  const keyId = minted.body.id as string;
  const asRequester = { authorization: `Bearer ${minted.body.token as string}` };
  const client = new Client({ name: "regulait-demo-enforce", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/${server.id}`), {
    requestInit: { headers: { ...asRequester, [PROJECT_HEADER]: project.id as string } },
  });
  const call = async (name: string, args: Record<string, string>): Promise<{ ok: true; text: string } | { ok: false; message: string }> => {
    try {
      const res = (await client.callTool({ name, arguments: args })) as Json;
      const text = ((res.content as Json[] | undefined) ?? []).map((c) => String(c.text ?? "")).join("\n");
      return res.isError ? { ok: false, message: text } : { ok: true, text };
    } catch (err) {
      // the SDK prefixes the JSON-RPC code once per wrap ("MCP error -32600: MCP error -32600: ..."); the gateway's
      // own sentence is what the presenter reads
      return { ok: false, message: (err instanceof Error ? err.message : String(err)).replace(/^(?:MCP error -?\d+: )+/, "") };
    }
  };

  try {
    await client.connect(transport);
    say(`LIVE  ${requester.displayName ?? o.requesterEmail} calls ${o.serverName} through the gateway, project ${o.projectName}`);
    const listed = ((await client.listTools()).tools ?? []).map((t) => t.name);
    say(`  tools/list    ${listed.join(", ")}${listed.includes(o.deniedTool) ? "" : `   (${o.deniedTool} is not offered to her)`}`);

    const denied = await call(o.deniedTool, { ...DENIED_ARGS });
    if (denied.ok) {
      say(`*** ${o.deniedTool} was ALLOWED. Expected a deny: check her revocation before presenting.`);
      return { exitCode: 1, outcome: "unexpected", lines };
    }
    say(`  ${o.deniedTool}   DENIED   ${denied.message}`);
    // the gateway's own audit row for that deny: the matched rule, and the step that took her grant away
    const audited = ((await api("GET", `/v1/audit?userId=${requester.id}&effect=deny&limit=20`)).body.entries as Json[] | undefined)?.find(
      (e) => e.toolName === o.deniedTool,
    );
    if (audited) {
      const revoked = ((audited.ruleChain as Json[] | undefined) ?? []).filter((step) => step.outcome === "revoked").map((step) => step.rule);
      say(
        `                audit: ${audited.effect}, rule ${audited.ruleId}` +
          (revoked.length ? `; her ${revoked.join(", ")} grant is REVOKED for her (per-user revocation beats the role)` : ""),
      );
    }

    const first = await call(o.approvalTool, o.writeArgs);
    if (first.ok) {
      say(`*** ${o.approvalTool} ran WITHOUT approval. Expected it to queue: check the approval rule before presenting.`);
      return { exitCode: 1, outcome: "unexpected", lines };
    }
    const approvalId = APPROVAL_ID.exec(first.message)?.[1];
    if (!approvalId) {
      say(`*** ${o.approvalTool} was refused, not queued: ${first.message}`);
      return { exitCode: 1, outcome: "unexpected", lines };
    }
    say(`  ${o.approvalTool}    QUEUED   ${first.message}`);

    const connections = ((await api("GET", "/v1/chatops/connections")).body.connections as Json[] | undefined) ?? [];
    const enabled = connections.filter((c) => c.enabled);
    if (enabled.length === 0) say("  notify        no ChatOps channel is enabled: the request is in the approver's Inbox only");
    for (const c of enabled) {
      const posted = await api("POST", `/v1/chatops/approvals/${approvalId}/post`, { connectionName: c.name });
      say(
        posted.status === 200
          ? `  notify        posted to ${c.provider} '${c.name}'${posted.body.decidable ? " with decide buttons" : " (a link; decide in the Inbox)"}`
          : `  notify        ${c.provider} '${c.name}' NOT posted (${posted.status} ${String(posted.body.error ?? "")}); the Inbox still has it`,
      );
    }

    say(`  waiting up to ${Math.round(o.waitMs / 1000)}s for the approver's decision (Inbox or chat) ...`);
    const deadline = Date.now() + o.waitMs;
    let status = "pending";
    while (Date.now() < deadline) {
      // the operator's view: a non-admin requester sees only the rows she must decide, never her own requests
      const rows = ((await api("GET", "/v1/approvals?objectType=mcp_tool")).body.approvals as Json[] | undefined) ?? [];
      status = String(rows.find((r) => r.id === approvalId)?.status ?? status);
      if (TERMINAL.has(status)) break;
      await sleep(o.pollMs);
    }
    if (status !== "approved") {
      say(
        status === "pending"
          ? `  no decision yet: nothing executed. Re-run this command after the approval; it lands on the same request.`
          : `  decision: ${status}. Nothing executed.`,
      );
      return { exitCode: status === "pending" ? 1 : 0, outcome: status === "pending" ? "timed_out" : "rejected", lines, approvalId };
    }
    const executed = await call(o.approvalTool, o.writeArgs);
    if (!executed.ok) {
      say(`*** approved, but the retry was refused: ${executed.message}`);
      return { exitCode: 1, outcome: "unexpected", lines, approvalId };
    }
    say(`  ${o.approvalTool}    APPROVED and EXECUTED   ${executed.text}`);
    say("  Every step above is in /ui/admin/audit: the deny, the queued approval, the chat post, the decision, the call.");
    return { exitCode: 0, outcome: "executed", lines, approvalId };
  } catch (err) {
    // e.g. 502 mcp_upstream_unreachable when demo:mcp is down: named, never a stack trace on stage
    say(`*** the gateway refused the MCP session: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, outcome: "unexpected", lines };
  } finally {
    await client.close().catch(() => {});
    const injector = {
      inject: async (r: { method: "POST"; url: string; headers: Record<string, string> }) => ({
        statusCode: (await api(r.method, r.url, undefined, r.headers)).status,
      }),
    };
    for (const n of await revokeScriptKeys(injector, o.bootstrapToken, [keyId])) say(`  ${n}`);
  }
}
