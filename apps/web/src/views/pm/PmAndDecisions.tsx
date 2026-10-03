/**
 * PILLAR 8 + ADR-0010 §3/§4 — the two governed surfaces that hang off any run
 * or workflow instance: its PM-tool links, and its decision ledger.
 *
 * Both are deliberately ONE pair of components used by both detail pages,
 * because the backend contract is one pair of endpoints scoped by
 * ({runId|instanceId}) / ({objectType, objectId}). A run and a workflow
 * instance are the only two parents either endpoint accepts, so a second
 * implementation could only drift.
 *
 * PM links — GET /v1/pm/links?runId=…|instanceId=…
 *   RegulAIt stores ONLY the linkage; the PM tool owns priority, description
 *   and acceptance criteria (pillar 8: the customer's tool is the source of
 *   truth, not a shadow copy). So this card shows the link, not a cached copy
 *   of the item, and `?live=true` is offered as an explicit act: it resolves
 *   the PM-authoritative fields from the tool RIGHT NOW, and when the tool is
 *   unreachable the per-link `liveError` is rendered rather than swallowed.
 *   `drift` (the tool's reported state disagrees with the state RegulAIt's
 *   node status maps to) is surfaced and never auto-fixed — ADR-0010's rule
 *   that the run state machine is never driven from outside.
 *
 * Decisions — GET/POST /v1/decisions?objectType=&objectId=
 *   A decision is recorded locally ALWAYS. Mirroring to the PM tool is
 *   best-effort on top: a decision that materialized as a linked Decision-typed
 *   work item carries `pmMirror`; one mirrored as a tagged comment (no type
 *   mapped) leaves no link row and renders as plain "recorded locally". The
 *   card says which happened rather than implying every decision reached the
 *   customer's tool.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { DecisionRecord, PmLink } from "../../api/types";
import { ago } from "../../api/format";
import { Badge, Button, Card, EmptyState, Field, Input, Table, Textarea } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import v from "../views.module.css";

type Parent = { objectType: "run"; objectId: string } | { objectType: "workflow_instance"; objectId: string };

/** the query the links endpoint wants for this parent (exactly one of the two) */
const linkQuery = (p: Parent) =>
  p.objectType === "run" ? `runId=${p.objectId}` : `instanceId=${p.objectId}`;

interface LiveLink extends PmLink {
  live?: { state?: string; fields?: Record<string, unknown>; comments?: unknown[] } | null;
  liveError?: string;
}

export function PmLinksCard(props: { parent: Parent }) {
  const { parent } = props;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [live, setLive] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const q = useQuery({
    queryKey: ["pm-links", parent.objectType, parent.objectId, live],
    queryFn: () =>
      api.get<{ links: LiveLink[] }>(`/v1/pm/links?${linkQuery(parent)}${live ? "&live=true" : ""}`),
    // a run with no PM connection configured is the normal case, not an error
    // — an empty list renders as an honest empty state
    retry: false,
  });
  const links = q.data?.links ?? [];
  const anyDrift = links.some((l) => l.drift);
  const anyOrphan = links.some((l) => l.orphanedAt);
  /** The connection to re-sync through. It comes from an EXISTING link, which
   * is the backend's documented design: each link carries its connection's
   * name precisely so a non-admin can drive pm-sync without the admin-only
   * connections list. That also means the FIRST sync cannot be started here —
   * there is no connection name to name yet — so the button is honestly
   * disabled with that reason rather than offering an action that would 404. */
  const syncConn = links.find((l) => l.connectionName)?.connectionName ?? null;

  const syncNow = async () => {
    if (!syncConn) return;
    setSyncing(true);
    try {
      const path =
        parent.objectType === "run"
          ? `/v1/runs/${parent.objectId}/pm-sync`
          : `/v1/workflows/instances/${parent.objectId}/pm-sync`;
      const r = await api.post<{
        created?: unknown[];
        verified?: unknown[];
        repaired?: unknown[];
        orphaned?: unknown[];
      }>(path, { connectionName: syncConn });
      const parts = [
        `${r.created?.length ?? 0} created`,
        `${r.verified?.length ?? 0} verified live`,
        ...((r.repaired?.length ?? 0) > 0 ? [`${r.repaired!.length} repaired`] : []),
        ...((r.orphaned?.length ?? 0) > 0 ? [`${r.orphaned!.length} ORPHANED`] : []),
      ];
      toast(`Synced with ${syncConn} — ${parts.join(", ")}`, (r.orphaned?.length ?? 0) > 0 ? "error" : "success");
      void qc.invalidateQueries({ queryKey: ["pm-links", parent.objectType, parent.objectId] });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Card title="PM work items">
      <div className={v.row}>
        <span className={v.faint} style={{ flex: 1 }}>
          regulAIt stores the <strong>link</strong>, not a copy — your PM tool owns the priority,
          description and acceptance criteria. Reading live fetches them from the tool right now;
          there is no cached copy to serve stale.
        </span>
        <Button
          size="sm"
          disabled={!syncConn || syncing}
          title={
            syncConn
              ? `link any unlinked nodes and re-verify the existing items through '${syncConn}'`
              : "nothing is linked yet, so there is no connection to sync through — an admin creates the first link from the PM connections view"
          }
          onClick={() => void syncNow()}
        >
          {syncing ? "Syncing…" : "Sync now"}
        </Button>
        <Button
          size="sm"
          disabled={links.length === 0 || q.isFetching}
          title={
            links.length === 0
              ? "nothing is linked to read"
              : "resolve the PM-authoritative fields from the tool right now"
          }
          onClick={() => setLive((x) => !x)}
        >
          {live ? "Stop reading live" : "Read live from the tool"}
        </Button>
      </div>

      {(anyDrift || anyOrphan) && (
        <div className={v.row} style={{ marginTop: "var(--s1)" }}>
          {anyDrift && (
            <Badge tone="warn" title="the PM tool reports a state that disagrees with this run's own status">
              drift detected
            </Badge>
          )}
          {anyOrphan && (
            <Badge tone="danger" title="the PM tool reports this work item as deleted">
              orphaned item
            </Badge>
          )}
          <span className={v.dim} style={{ fontSize: "var(--text-xs)" }}>
            Surfaced, never auto-fixed here: status ownership is regulAIt&apos;s, so a PM state can
            never drive this run&apos;s state machine. Auto-resolution is a per-connection admin
            policy.
          </span>
        </div>
      )}

      <Table<LiveLink>
        columns={[
          {
            key: "what",
            header: "Linked object",
            render: (l) => (
              <span className={v.mono}>
                {l.objectType === "run_node" ? `node ${l.nodeId ?? "?"}` : l.objectType.replace("_", " ")}
              </span>
            ),
          },
          {
            key: "conn",
            header: "Connection",
            render: (l) => l.connectionName ?? <span className={v.faint}>—</span>,
          },
          {
            key: "item",
            header: "Work item",
            render: (l) => (
              <a href={l.externalUrl} target="_blank" rel="noreferrer" className={v.mono}>
                {l.externalId} ↗
              </a>
            ),
          },
          {
            key: "reported",
            header: "PM-reported state",
            render: (l) =>
              l.inboundState ? (
                <span className={v.row}>
                  <span>{l.inboundState}</span>
                  {l.drift && (
                    <Badge tone="warn" title="disagrees with the state this node's status maps to">
                      drift
                    </Badge>
                  )}
                  {l.adoptedState === l.inboundState && (
                    <Badge tone="info" title="this connection adopts the PM tool's state as the declared truth">
                      adopted
                    </Badge>
                  )}
                </span>
              ) : (
                <span className={v.faint} title="the tool has not reported a state for this item yet">
                  not reported
                </span>
              ),
          },
          {
            key: "live",
            header: "Live",
            render: (l) =>
              !live ? (
                <span className={v.faint}>—</span>
              ) : l.liveError ? (
                <span className={v.dim} title={l.liveError}>
                  <Badge tone="danger">unreachable</Badge>
                </span>
              ) : l.live ? (
                <span>{l.live.state ?? <span className={v.faint}>no state</span>}</span>
              ) : (
                <span className={v.faint}>—</span>
              ),
          },
          {
            key: "synced",
            header: "Last synced",
            render: (l) => <span className={v.faint}>{l.lastSyncedAt ? ago(l.lastSyncedAt) : "never"}</span>,
          },
        ]}
        rows={links}
        rowKey={(l) => l.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={
          <EmptyState
            title="No PM work items linked"
            body="Nothing here is mapped onto your Azure DevOps / Jira / Linear board yet. Links are created when a PM connection is configured and this object syncs."
          />
        }
      />
    </Card>
  );
}

export function DecisionLedgerCard(props: { parent: Parent }) {
  const { parent } = props;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [decision, setDecision] = useState("");
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["decisions", parent.objectType, parent.objectId],
    queryFn: () =>
      api.get<{ decisions: DecisionRecord[] }>(
        `/v1/decisions?objectType=${parent.objectType}&objectId=${parent.objectId}`,
      ),
    retry: false,
  });
  const rows = q.data?.decisions ?? [];

  const record = async () => {
    setError(null);
    const d = decision.trim();
    if (!d) {
      setError("A decision needs its text — what was decided.");
      return;
    }
    setBusy(true);
    try {
      // NOTE the shape difference, which matters for honesty: POST returns
      // pmMirror as the OUTCOME of the best-effort mirror attempt
      // ({ ok, action?, externalId?, error? }), while GET returns it as the
      // resulting LINK ({ externalId, externalUrl }) or null. A failed mirror
      // is a truthy object here — reporting "mirrored" on truthiness alone
      // would claim the customer's tool has a record it does not have.
      const r = await api.post<
        DecisionRecord & {
          pmMirror?: { ok: boolean; action?: string; externalId?: string; error?: string } | null;
        }
      >("/v1/decisions", {
        objectType: parent.objectType,
        objectId: parent.objectId,
        decision: d,
        ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
      });
      setDecision("");
      setRationale("");
      const m = r.pmMirror;
      toast(
        !m
          ? "Decision recorded — kept locally (nothing here is linked to a PM tool)"
          : m.ok
            ? m.action === "work_item"
              ? `Decision recorded and mirrored to your PM tool as work item ${m.externalId}`
              : "Decision recorded and mirrored to your PM tool as a comment (no Decision type is mapped)"
            : `Decision recorded locally, but the PM mirror FAILED: ${m.error ?? "unknown error"}`,
        m && !m.ok ? "error" : "success",
      );
      void qc.invalidateQueries({ queryKey: ["decisions", parent.objectType, parent.objectId] });
      void qc.invalidateQueries({ queryKey: ["pm-links", parent.objectType, parent.objectId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Decision ledger">
      <p className={v.faint} style={{ marginTop: 0 }}>
        First-class decision records for this {parent.objectType === "run" ? "run" : "workflow"} —
        what was decided, by whom, and why. Every one is recorded locally and audited; mirroring to
        your PM tool is best-effort on top, so a decision is never lost when the tool is
        unreachable or has no Decision type mapped.
      </p>
      <div className={v.row}>
        <Field label="Decision" grow>
          <Input
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
            placeholder="e.g. Ship behind a feature flag rather than blocking the release"
          />
        </Field>
        <div style={{ alignSelf: "flex-end" }}>
          <Button variant="primary" disabled={busy} onClick={() => void record()}>
            {busy ? "Recording…" : "Record decision"}
          </Button>
        </div>
      </div>
      <Field label="Rationale (optional — why, for whoever reads this in six months)">
        <Textarea rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} />
      </Field>
      {error && (
        <div className={v.errLine} role="alert">
          {error}
        </div>
      )}
      <Table<DecisionRecord>
        columns={[
          { key: "decision", header: "Decision", render: (d) => d.decision },
          {
            key: "rationale",
            header: "Rationale",
            render: (d) => <span className={v.dim}>{d.rationale ?? "—"}</span>,
          },
          {
            key: "who",
            header: "Decided by",
            render: (d) => d.decisionMakerName ?? <span className={v.mono}>{d.decisionMakerUserId.slice(0, 8)}…</span>,
          },
          {
            key: "mirror",
            header: "PM record",
            render: (d) =>
              d.pmMirror ? (
                <a href={d.pmMirror.externalUrl} target="_blank" rel="noreferrer" className={v.mono}>
                  {d.pmMirror.externalId} ↗
                </a>
              ) : (
                <span
                  className={v.faint}
                  title="no linked work item — either no PM connection maps a Decision type (it was mirrored as a tagged comment) or there is no connection at all. The local record is authoritative either way."
                >
                  recorded locally
                </span>
              ),
          },
          {
            key: "at",
            header: "When",
            sort: (d) => d.createdAt,
            render: (d) => <span className={v.faint}>{ago(d.createdAt)}</span>,
          },
        ]}
        rows={rows}
        rowKey={(d) => d.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={
          <EmptyState
            title="No decisions recorded yet"
            body="Record the calls that shaped this work — they become part of the same single audit trail every pillar writes into."
          />
        }
      />
    </Card>
  );
}
