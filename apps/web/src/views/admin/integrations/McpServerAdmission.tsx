/**
 * Two MCP server controls on Integrations > MCP servers.
 *
 * 1. ADR-0097 — clearing a server the manifest scan HELD. Admin only, a reason
 *    is required (it becomes the audited record), and the gateway asks for a
 *    `settings_relax` step-up bound to the scanned manifest digest: clearing
 *    lifts a quarantine, so it is a relaxation. The clearance is pinned to that
 *    digest, so a changed manifest is scanned again and can re-hold the server.
 *    A reserved `mcp:` tool name can never be cleared (ADR-0185): the upstream
 *    must rename it.
 *
 * 2. `GET /v1/users/:userId/servers/:serverId/tools` — the tools a user would
 *    actually see in `tools/list` (entitlement-filtered discovery), as opposed
 *    to the grants the entitlement card lists.
 *
 * 3. #609 follow-up — "Sync tools now": `POST /v1/servers/:serverId/tools/sync`
 *    fetches one server's manifest on demand, through the same admission,
 *    release-age, egress, transport and scan gates as a proxied call, behind a
 *    `settings_relax` step-up bound to the server. It sits in the server's own
 *    tools card, beside the list it refreshes.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../../../api/client";
import type { McpServer, McpTool } from "../../../api/adminTypes";
import { Badge, Button, Card, EmptyState, Field, Select, Table } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { ReasonModal, optionEls, serverOpts, useAction, useUsers, userOpts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

/** owner 2026-10-30: what still stands between a newly added server and its first call, with a way to each step.
 * Shown under the register form and after a registry import, where the admin is looking. */
export function McpServerNextSteps() {
  return (
    <p className={v.hint} data-testid="mcp-next-steps">
      Before anyone can call a new server: a host outside this network needs an entry on the{" "}
      <Link to="/admin/custom-providers" style={{ textDecoration: "underline" }}>egress allow-list</Link>; a new server
      waits out the release-age cooldown unless you allow it sooner on{" "}
      <Link to="/admin/admission" style={{ textDecoration: "underline" }}>Admission review</Link>; and nobody holds a
      grant until you give one under Tool-level allow-list grants on the Servers tab. To load its tools, open the server in
      the registry and choose <strong>Sync tools now</strong>: the manifest is fetched and scanned through the same gates.
    </p>
  );
}

/** the sync route's own refusals, in words (pinned to mcp-tool-sync.ts by the test). The release-age cooldown is
 * not here: it carries its own guidance (api/refusals.ts) with a link to Admission review. */
export const TOOL_SYNC_REFUSALS: Readonly<Record<string, string>> = {
  unknown_server: "That MCP server no longer exists. Refresh the list.",
  mcp_admission_held: "The manifest scan holds this server, so nothing was synced. Review it on Admission review first.",
  egress_blocked: "This server's address is not on the egress allow-list, so the gateway did not contact it. Nothing was synced.",
  mcp_upstream_circuit_open: "This server failed several times in a row, so calls to it are paused for a short while. Try again shortly.",
  mcp_upstream_unreachable: "The server could not be reached. Check that it is running and allowed by egress, then try again.",
  mcp_upstream_timeout: "The server did not answer in time. Nothing was synced; try again later.",
  rate_limited: "This server was synced several times in the last minute. Wait a minute and try again.",
};

export function toolSyncRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const code = e.payload.error;
  return typeof code === "string" && Object.hasOwn(TOOL_SYNC_REFUSALS, code) ? TOOL_SYNC_REFUSALS[code]! : null;
}

/** `POST /v1/servers/:serverId/tools/sync`'s answer */
interface ToolSyncResult {
  toolCount: number;
  added: string[];
}

export function toolSyncSummary(serverName: string, r: ToolSyncResult): string {
  const tools = r.toolCount === 1 ? "1 tool" : `${r.toolCount} tools`;
  return r.added.length > 0 ? `Synced ${tools} from ${serverName} (${r.added.length} new)` : `Synced ${tools} from ${serverName}, no new tools`;
}

/** "Sync tools now" for one server: step-up, then the governed sync; the tools card re-reads when it lands */
export function McpSyncToolsButton(props: { server: McpServer }) {
  const act = useAction();
  const s = props.server;
  return (
    <span className={v.row}>
      <Button
        size="sm"
        // busy is aria-disabled plus a guard, so focus stays on the button
        aria-disabled={act.busy}
        aria-label={`Sync tools now on ${s.name}`}
        onClick={() => {
          if (act.busy) return;
          void act.run(async () => {
            try {
              const r = await withStepUp((h) => stepUpApi.post<ToolSyncResult>(`/v1/servers/${s.id}/tools/sync`, {}, h));
              return toolSyncSummary(s.name, r);
            } catch (e) {
              const text = toolSyncRefusal(e);
              throw text ? new Error(text) : e;
            }
          });
        }}
      >
        {act.busy ? "Syncing…" : "Sync tools now"}
      </Button>
      {act.guidance ? (
        <RefusalNotice guidance={act.guidance} />
      ) : (
        act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )
      )}
    </span>
  );
}

/** the clear route's own refusals, in words (pinned to mcp-admission.ts by the test) */
export const ADMISSION_CLEAR_REFUSALS: Readonly<Record<string, string>> = {
  unknown_server: "That MCP server no longer exists. Refresh the list.",
  not_held: "This server is no longer held, so there is nothing to clear. Refresh the list.",
  reserved_tool_name:
    "This server declares a tool under the reserved mcp: prefix. That cannot be cleared: the upstream must rename the tool, and the next scan decides again.",
};

export function admissionClearRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const code = e.payload.error;
  return typeof code === "string" && Object.hasOwn(ADMISSION_CLEAR_REFUSALS, code) ? ADMISSION_CLEAR_REFUSALS[code]! : null;
}

/** `clearMcpAdmissionSchema`: a reason of 1 to 2000 characters */
export const ADMISSION_REASON_MAX = 2000;
export function admissionReasonProblem(reason: string): string | null {
  if (reason.trim().length === 0) return "A reason is required.";
  if (reason.length > ADMISSION_REASON_MAX) return `The reason must be at most ${ADMISSION_REASON_MAX} characters (it has ${reason.length}). Nothing was sent.`;
  return null;
}

export function McpAdmissionClearButton(props: { server: McpServer }) {
  const act = useAction();
  const [open, setOpen] = useState(false);
  const s = props.server;
  return (
    // the registry rows toggle the tools card on click; this control must not
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Button size="sm" variant="ghost" disabled={act.busy} aria-label={`Clear hold on ${s.name}`} onClick={() => setOpen(true)}>
        Clear hold…
      </Button>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
      <ReasonModal
        open={open}
        danger
        title={`Clear the admission hold on ${s.name}?`}
        confirmLabel="Clear the hold"
        placeholder="Why this server is safe to admit (required, audited)"
        body={
          <div className={v.stack}>
            <p>
              The manifest scan held this server, so its tools are hidden from everyone and every call is refused. Clearing overrides that verdict:
              its tools become reachable again for the people already granted them.
            </p>
            <p>
              This is a relaxation. You will be asked to confirm it&apos;s you, the reason is recorded in the audit log, and the clearance is pinned to
              the manifest that was scanned: if the server&apos;s manifest changes, it is scanned again and can be held again.
            </p>
          </div>
        }
        onCancel={() => setOpen(false)}
        onConfirm={(reason) => {
          setOpen(false);
          const problem = admissionReasonProblem(reason);
          if (problem) {
            act.setError(problem);
            return;
          }
          void act.run(async () => {
            try {
              await withStepUp((h) => stepUpApi.post(`/v1/servers/${s.id}/admission/clear`, { reason }, h));
            } catch (e) {
              const text = admissionClearRefusal(e);
              throw text ? new Error(text) : e;
            }
          }, `Admission hold on ${s.name} cleared`);
        }}
      />
    </span>
  );
}

/** `GET /v1/users/:userId/servers/:serverId/tools` */
export function McpVisibleToolsCard(props: { users: ReturnType<typeof useUsers>; servers: McpServer[] }) {
  const act = useAction();
  const [userId, setUserId] = useState("");
  const [serverId, setServerId] = useState("");
  const [rows, setRows] = useState<McpTool[] | null>(null);
  const server = props.servers.find((s) => s.id === serverId);
  return (
    <Card title="What a user sees in tools/list">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          setRows(null);
          void act.run(async () => {
            const r = await api.get<{ tools: McpTool[] }>(`/v1/users/${userId}/servers/${serverId}/tools`);
            setRows(r.tools);
          }, null);
        }}
      >
        <Field label="User whose discovery to preview">
          <Select required value={userId} onChange={(e) => (setUserId(e.target.value), setRows(null))}>
            {optionEls(userOpts(props.users.data?.users), "— select —")}
          </Select>
        </Field>
        <Field label="Server to preview">
          <Select required value={serverId} onChange={(e) => (setServerId(e.target.value), setRows(null))}>
            {optionEls(serverOpts(props.servers), "— select —")}
          </Select>
        </Field>
        <Button type="submit" size="sm" disabled={act.busy}>
          Preview tools
        </Button>
      </form>
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
      {rows && (
        <Table<McpTool>
          rows={rows}
          rowKey={(t) => t.name}
          columns={[
            { key: "name", header: "Tool", render: (t) => <span className={v.mono}>{t.name}</span> },
            { key: "kind", header: "Kind", render: (t) => <Badge tone={t.kind === "write" ? "warn" : "info"}>{t.kind}</Badge> },
          ]}
          empty={
            <EmptyState
              title="No tools visible"
              body={
                server?.admissionState === "held"
                  ? "This server is held by the admission scan. While admission is enforced its tools are hidden from everyone, whatever they are granted; Admission review shows the mode."
                  : "Either this user holds no grant that reaches a tool on this server (default-deny), or the server's tools are hidden from everyone because its release is still inside the release-age quarantine. Admission review shows which."
              }
            />
          }
        />
      )}
      <p className={v.faint}>
        Discovery is filtered by entitlement: a tool the user is not granted does not appear at all, rather than failing when called. A server held by
        the admission scan shows nothing to anyone. This view ignores a deployment halt, which refuses calls without hiding what a user holds.
      </p>
    </Card>
  );
}
