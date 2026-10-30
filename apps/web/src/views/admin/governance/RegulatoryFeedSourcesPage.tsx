/**
 * Regulatory feed sources — published regulatory notices (shipped with the
 * product, never downloaded) an admin reviews before they join the regulatory
 * intelligence feed. A proposal shows what would be added, changed or removed;
 * nothing joins the feed until it is accepted, and the hand-checked entries
 * always win over an imported one with the same key.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { fmtDay, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, RowActions, Table } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { useAction } from "../adminKit";
import v from "../../views.module.css";

interface FeedDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
}

interface FeedSource {
  sourceId: string;
  title: string;
  publisher: string;
  licence: string;
  licenceUrl: string;
  sourceVersion: string;
  retrievedOn: string;
  entries: number;
  accepted: { id: string; decidedAt: string; entries: number; upToDate: boolean } | null;
  pending: { id: string; createdAt: string; diff: FeedDiff } | null;
}

const LICENCE_LABELS: Record<string, string> = {
  "US-Gov-Public-Domain": "US government work (public domain)",
  "CC0-1.0": "Public domain (CC0)",
};

function state(s: FeedSource): { label: string; tone: "ok" | "warn" | "info" | "neutral" } {
  if (s.pending) return { label: "Review waiting", tone: "warn" };
  if (!s.accepted) return { label: "Not in the feed", tone: "neutral" };
  return s.accepted.upToDate ? { label: "In the feed", tone: "ok" } : { label: "Newer entries available", tone: "info" };
}

const diffWords = (d: FeedDiff) =>
  `${plural(d.added.length, "entry added", "entries added")}, ${plural(d.changed.length, "entry changed", "entries changed")}, ` +
  `${plural(d.removed.length, "entry removed", "entries removed")}`;

export default function RegulatoryFeedSourcesPage() {
  const act = useAction();
  const [deciding, setDeciding] = useState<{ source: FeedSource; decision: "accept" | "reject" } | null>(null);
  const q = useQuery({
    queryKey: ["admin", "regulatory-feed-imports"],
    queryFn: () => api.get<{ enabled: boolean; sources: FeedSource[] }>("/v1/regulatory/feed-imports"),
  });
  const enabled = q.data?.enabled ?? false;

  return (
    <>
      <PageHeader
        title="Regulatory feed sources"
        info={
          <p>
            Published regulatory notices that ship with RegulAIt, beside the hand-checked entries of{" "}
            <Link to="/admin/governance/regulatory">Regulatory intelligence</Link>. You review what each update adds, changes or removes
            before it joins the feed. Imported entries are not mapped to your controls; the feed says so on each one.
          </p>
        }
      />
      <div className={v.stack}>
        {q.data && !enabled && (
          <Card title="Imports are off">
            <p>
              Imported feed entries are off for this organisation, so the feed shows the hand-checked entries only. An admin can turn
              imports on in <Link to="/admin/organization">Organisation settings</Link>.
            </p>
          </Card>
        )}
        {act.guidance ? (
          <RefusalNotice guidance={act.guidance} />
        ) : (
          act.error && (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          )
        )}
        <Card flush title="Sources">
          <Table<FeedSource>
            columns={[
              {
                key: "source",
                header: "Source",
                sort: (s) => s.title,
                render: (s) => (
                  <>
                    {s.title}
                    <div className={v.dim}>{s.publisher}</div>
                  </>
                ),
              },
              {
                key: "licence",
                header: "Licence",
                render: (s) => (
                  <a href={s.licenceUrl} target="_blank" rel="noreferrer noopener">
                    {LICENCE_LABELS[s.licence] ?? s.licence}
                  </a>
                ),
              },
              {
                key: "retrieved",
                header: "Retrieved",
                sort: (s) => s.retrievedOn,
                render: (s) => fmtDay(s.retrievedOn),
              },
              { key: "entries", header: "Entries", sort: (s) => s.entries, render: (s) => s.entries },
              {
                key: "state",
                header: "Status",
                render: (s) => {
                  const st = state(s);
                  return (
                    <>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {s.pending && <div className={v.dim}>{diffWords(s.pending.diff)}</div>}
                    </>
                  );
                },
              },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (s) => (
                  <RowActions
                    slot="11rem"
                    primary={
                      s.pending ? (
                        <Button size="sm" variant="primary" aria-disabled={act.busy} onClick={() => !act.busy && setDeciding({ source: s, decision: "accept" })}>
                          Accept entries
                        </Button>
                      ) : enabled && !s.accepted?.upToDate ? (
                        <Button
                          size="sm"
                          variant="primary"
                          aria-disabled={act.busy}
                          onClick={() => {
                            if (act.busy) return;
                            void act.run(async () => {
                              const out = await api.post<{ noChange?: boolean }>(`/v1/regulatory/feed-imports/${encodeURIComponent(s.sourceId)}/proposals`, {});
                              return out.noChange ? "Nothing new: the feed already has these entries" : "Update ready to review";
                            }, undefined);
                          }}
                        >
                          Propose update
                        </Button>
                      ) : undefined
                    }
                    secondary={
                      s.pending ? (
                        <Button size="sm" aria-disabled={act.busy} onClick={() => !act.busy && setDeciding({ source: s, decision: "reject" })}>
                          Reject entries
                        </Button>
                      ) : undefined
                    }
                  />
                ),
              },
            ]}
            rows={q.data?.sources ?? []}
            rowKey={(s) => s.sourceId}
            loading={q.isLoading}
            error={q.error}
            onRetry={() => void q.refetch()}
            empty={<EmptyState title="No feed sources ship with this build" body="The regulatory feed shows the hand-checked entries only." />}
          />
        </Card>
      </div>
      <ConfirmModal
        open={deciding !== null}
        title={deciding?.decision === "accept" ? `Add these entries to the regulatory feed?` : `Reject this update?`}
        body={
          deciding?.source.pending
            ? deciding.decision === "accept"
              ? `${diffWords(deciding.source.pending.diff)}. Hand-checked entries with the same key are kept. The decision is recorded in the audit log.`
              : "The feed stays as it is. The decision is recorded in the audit log."
            : undefined
        }
        confirmLabel={deciding?.decision === "accept" ? "Accept entries" : "Reject entries"}
        onCancel={() => setDeciding(null)}
        onConfirm={() => {
          const d = deciding;
          setDeciding(null);
          if (d?.source.pending)
            void act.run(
              () => api.post(`/v1/regulatory/feed-imports/${d.source.pending!.id}/${d.decision}`, {}),
              d.decision === "accept" ? "Entries added to the regulatory feed" : "Update rejected",
            );
        }}
      />
    </>
  );
}
