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
 */
import { useState } from "react";
import { ApiError, api } from "../../../api/client";
import type { McpServer, McpTool } from "../../../api/adminTypes";
import { Badge, Button, Card, EmptyState, Field, Select, Table } from "../../../ui/kit";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { ReasonModal, optionEls, serverOpts, useAction, useUsers, userOpts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

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
