/**
 * MCP definition pinning (rug-pull review): the "Changed since approval" queue on the MCP servers page, and one
 * server's changes on its own sub-page, each changed item with its patch as text and a re-approval bound to the
 * digests reviewed. Re-approving relaxes what a model is served, so it goes through `withStepUp` with a required
 * reason; nothing is selected for re-approval until the admin picks it.
 */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../../api/client";
import { fmtAt, humanize, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { SubpageTrail } from "../../../ui/ListPreview";
import { Badge, Button, Card, EmptyState, Field, RecordError, SkeletonBlock, Table, Textarea } from "../../../ui/kit";
import { useAction, useUsers } from "../adminKit";
import { ActionError } from "./McpHighRisk";
import {
  PAGE,
  approvalItem,
  describeDiff,
  pinKey,
  pinLabel,
  pinStatusLabel,
  staleSentence,
  type DefinitionPinMode,
  type DefinitionPinQueue,
  type ServerDefinitionPins,
  type StalePinItem,
} from "./mcpPinningModel";
import v from "../../views.module.css";
import m from "./mcpPinning.module.css";

const modeBadge = (mode: DefinitionPinMode) => (
  <Badge tone={mode === "block" ? "ok" : "warn"}>{mode === "block" ? "Changed items blocked" : "Changed items still served"}</Badge>
);

/** The review queue on the MCP servers page: every server with a definition changed since approval. */
export function McpChangedSinceApprovalCard() {
  const q = useQuery({
    queryKey: ["admin", "mcp-definition-pins"],
    queryFn: () => api.get<DefinitionPinQueue>(`/v1/mcp/definition-pins?limit=${PAGE}`),
  });
  const rows = q.data?.servers;
  return (
    <Card
      title="Changed since approval"
      count={rows ? rows.length : null}
      countIsLimit={q.data?.hasMore}
      countNoun={["server", "servers"]}
      attention={rows?.length ? <Badge tone="warn">{plural(rows.length, "server")} to review</Badge> : undefined}
      actions={q.data && modeBadge(q.data.mode)}
      caption="Servers serving a tool, prompt or resource that differs from what an admin approved."
    >
      <Table<DefinitionPinQueue["servers"][number]>
        columns={[
          { key: "server", header: "Server", render: (r) => r.serverName },
          { key: "pending", header: "Changed items", render: (r) => plural(r.pending, "item") },
          { key: "last", header: "Last change", render: (r) => (r.lastChangedAt ? fmtAt(r.lastChangedAt) : "Not reported") },
          {
            key: "review",
            header: <span className={m.srOnly}>Actions</span>,
            render: (r) => (
              <Link to={`/admin/mcp-servers/definition-pins/${r.serverId}`} aria-label={`Review changes on ${r.serverName}`}>
                Review changes
              </Link>
            ),
          },
        ]}
        rows={rows}
        rowKey={(r) => r.serverId}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState title="Nothing changed since approval" />}
      />
    </Card>
  );
}

const text = (s: string | null) => (s === null ? "—" : <span className={`${v.mono} ${m.value}`}>{s}</span>);

/** One server's changes: each changed item with its diff, and the re-approval. */
export default function McpDefinitionPinsPage() {
  const serverId = useParams().serverId ?? "";
  const q = useQuery({
    queryKey: ["admin", "mcp-definition-pins", serverId],
    queryFn: () => api.get<ServerDefinitionPins>(`/v1/servers/${serverId}/definition-pins?pending=true&limit=${PAGE}`),
  });
  const users = useUsers();
  const act = useAction();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState("");
  const [checked, setChecked] = useState(false);
  const data = q.data;
  const name = data?.serverName ?? "this server";
  const chosen = (data?.pins ?? []).filter((p) => picked.has(pinKey(p)));
  const who = (id: string | null) => (id ? users.data?.users.find((u) => u.id === id)?.displayName ?? "an admin" : "the baseline");

  const approve = () => {
    setChecked(true);
    if (!reason.trim() || !chosen.length) return;
    const body = { items: chosen.map(approvalItem), reason: reason.trim() };
    void act
      .run(async () => {
        try {
          await withStepUp((h) => stepUpApi.post(`/v1/servers/${serverId}/definition-pins/approve`, body, h));
        } catch (e) {
          throw e instanceof ApiError && e.status === 409 ? new Error(staleSentence((e.payload as { items?: StalePinItem[] }).items ?? [])) : e;
        }
      }, `${plural(chosen.length, "item")} re-approved on ${name}`)
      .then((ok) => {
        if (!ok) return;
        setPicked(new Set());
        setReason("");
        setChecked(false);
      });
  };

  return (
    <>
      <SubpageTrail parent="MCP servers" parentTo="/admin/mcp-servers" current={`Changes on ${name}`} />
      <PageHeader title={`Changes on ${name}`} sub="Each item that differs from what an admin approved." />
      <div className={v.stack}>
        {!data ? (
          <Card>
            {q.isLoading ? (
              <SkeletonBlock lines={6} />
            ) : (
              <RecordError noun="server" error={q.error} onRetry={() => void q.refetch()} action={<Link to="/admin/mcp-servers">Back to MCP servers</Link>} />
            )}
          </Card>
        ) : (
          <>
            <Card title="Review" actions={modeBadge(data.mode)}>
              <p>
                {plural(data.pendingCount, "item")} changed since approval.{" "}
                {data.mode === "block" ? "Not served until re-approved." : "Still served; each use is audited."}
              </p>
              <form
                aria-label={`Re-approve changes on ${name}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  approve();
                }}
              >
                <p>
                  {plural(chosen.length, "item")} selected.{" "}
                  {data.pins.length > 0 && (
                    <Button size="sm" type="button" onClick={() => setPicked(new Set(data.pins.map(pinKey)))}>
                      Select all on this page
                    </Button>
                  )}
                </p>
                <Field label="Reason (required, audited)" error={checked && !reason.trim() ? "Say why these changes are safe" : null} grow>
                  <Textarea value={reason} maxLength={2000} rows={2} onChange={(e) => setReason(e.target.value)} onBlur={() => setChecked(true)} />
                </Field>
                <Button type="submit" variant="primary" disabled={act.busy || !chosen.length}>
                  {chosen.length ? `Re-approve ${plural(chosen.length, "item")}` : "Re-approve selected items"}
                </Button>
                <p className={v.dim}>You will be asked to confirm it's you. Each approval covers only the definition you reviewed.</p>
                <ActionError act={act} />
              </form>
            </Card>
            {!data.pins.length && (
              <Card>
                <EmptyState title="Nothing to review" />
              </Card>
            )}
            {data.pins.map((p) => (
              <Card key={pinKey(p)} title={<span className={v.mono}>{p.name}</span>} actions={<Badge tone="warn">{pinStatusLabel(p.status)}</Badge>}>
                <p className={v.dim}>
                  {humanize(p.kind)}. Approved by {who(p.approvedBy)}
                  {p.approvedAt && ` on ${fmtAt(p.approvedAt)}`}
                  {p.changedAt && `; changed ${fmtAt(p.changedAt)}`}.
                </p>
                <label className={v.row}>
                  <input
                    type="checkbox"
                    checked={picked.has(pinKey(p))}
                    onChange={(e) =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(pinKey(p));
                        else next.delete(pinKey(p));
                        return next;
                      })
                    }
                  />
                  Re-approve {pinLabel(p)}
                </label>
                {/* each operation as "what, where: approved → now served", all of it text */}
                <ul aria-label={`What changed in ${pinLabel(p)}`}>
                  {describeDiff(p.approved, p.diff).map((l, i) => (
                    <li key={i}>
                      {l.action} <span className={v.mono}>{l.path}</span>: {text(l.before)} → {text(l.after)}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
            {data.hasMore && <p className={v.dim}>Showing the first {PAGE}. Re-approve these to see the rest.</p>}
          </>
        )}
      </div>
    </>
  );
}
