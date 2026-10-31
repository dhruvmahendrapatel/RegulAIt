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
import { DetailDrawer, DrawerActions } from "../../../ui/DetailDrawer";
import { Badge, Button, Card, EmptyState, RecordError, RowActions, SkeletonBlock, Table } from "../../../ui/kit";
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

interface FeedEntryView {
  key: string;
  title: string;
  instrument: string;
  effectiveDate: string;
  status: string;
  sourceUrl: string;
}

interface FeedImportReview {
  id: string;
  sourceId: string;
  sourceVersion: string;
  status: string;
  added: FeedEntryView[];
  changed: Array<FeedEntryView & { previous: FeedEntryView | null }>;
  removed: FeedEntryView[];
}

const STATUS_WORDS: Record<string, string> = {
  in_force: "In force",
  upcoming: "Upcoming",
  proposed: "Proposed",
  published: "Published",
  withdrawn: "Withdrawn",
};

function EntryLine(props: { entry: FeedEntryView; label?: string }) {
  const e = props.entry;
  return (
    <div>
      <p>
        {props.label && <span className={v.dim}>{props.label}: </span>}
        <a href={e.sourceUrl} target="_blank" rel="noreferrer noopener">
          {e.title}
        </a>
      </p>
      <p className={v.dim}>
        {e.instrument} · {STATUS_WORDS[e.status] ?? e.status} · effective {fmtDay(e.effectiveDate)} · <code>{e.key}</code>
      </p>
    </div>
  );
}

function EntryList(props: { title: string; entries: FeedEntryView[]; empty: string }) {
  return (
    <Card title={`${props.title} (${props.entries.length})`}>
      {props.entries.length === 0 ? (
        <p className={v.dim}>{props.empty}</p>
      ) : (
        <ul className={v.stack}>
          {props.entries.map((e) => (
            <li key={e.key}>
              <EntryLine entry={e} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** what an update adds, changes and removes, read before it is accepted; the decision row stays pinned */
function FeedReviewDrawer(props: { importId: string; onClose: () => void }) {
  const act = useAction();
  const q = useQuery({
    queryKey: ["admin", "regulatory-feed-imports", "review", props.importId],
    queryFn: () => api.get<{ feedImport: FeedImportReview }>(`/v1/regulatory/feed-imports/${props.importId}`),
  });
  const r = q.data?.feedImport;
  const decide = (decision: "accept" | "reject") => {
    if (act.busy || !r) return;
    void act
      .run(
        () => api.post(`/v1/regulatory/feed-imports/${r.id}/${decision}`, {}),
        decision === "accept" ? "Entries added to the regulatory feed" : "Update rejected",
      )
      .then((ok) => ok && props.onClose());
  };
  return (
    <DetailDrawer
      type="Regulatory feed update"
      title={r ? `Update of ${fmtDay(r.sourceVersion)}` : "Regulatory feed update"}
      subjectKey={props.importId}
      meta={r ? <Badge tone="warn">Review waiting</Badge> : undefined}
      onClose={props.onClose}
    >
      {q.isLoading && <SkeletonBlock lines={6} />}
      {q.error && <RecordError noun="feed update" error={q.error} onRetry={() => void q.refetch()} />}
      {r && (
        <div className={v.stack}>
          <p>
            Accepting adds these entries to the regulatory feed and removes the ones listed as removed. Hand-checked entries with the same
            key are kept. Imported entries are not mapped to your controls. The decision is recorded in the audit log.
          </p>
          <EntryList title="Entries added" entries={r.added} empty="No entry is added." />
          <Card title={`Entries changed (${r.changed.length})`}>
            {r.changed.length === 0 ? (
              <p className={v.dim}>No entry is changed.</p>
            ) : (
              <ul className={v.stack}>
                {r.changed.map((e) => (
                  <li key={e.key}>
                    {e.previous && <EntryLine entry={e.previous} label="In the feed now" />}
                    <EntryLine entry={e} label="After this update" />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <EntryList title="Entries removed" entries={r.removed} empty="No entry is removed." />
          {act.guidance ? (
            <RefusalNotice guidance={act.guidance} />
          ) : (
            act.error && (
              <div className={v.errLine} role="alert">
                {act.error}
              </div>
            )
          )}
          <DrawerActions>
            <Button variant="primary" aria-disabled={act.busy} onClick={() => decide("accept")}>
              Accept entries
            </Button>
            <Button aria-disabled={act.busy} onClick={() => decide("reject")}>
              Reject update
            </Button>
          </DrawerActions>
        </div>
      )}
    </DetailDrawer>
  );
}

export default function RegulatoryFeedSourcesPage() {
  const act = useAction();
  const [reviewing, setReviewing] = useState<string | null>(null);
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
                        <Button size="sm" variant="primary" onClick={() => setReviewing(s.pending!.id)}>
                          Review update
                        </Button>
                      ) : enabled && !s.accepted?.upToDate ? (
                        <Button
                          size="sm"
                          variant="primary"
                          aria-disabled={act.busy}
                          onClick={() => {
                            if (act.busy) return;
                            void act.run(async () => {
                              const out = await api.post<{ noChange?: boolean; feedImport?: { id: string } }>(
                                `/v1/regulatory/feed-imports/${encodeURIComponent(s.sourceId)}/proposals`,
                                {},
                              );
                              if (out.feedImport) setReviewing(out.feedImport.id);
                              return out.noChange ? "Nothing new: the feed already has these entries" : "Update ready to review";
                            }, undefined);
                          }}
                        >
                          Propose update
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
      {reviewing && <FeedReviewDrawer importId={reviewing} onClose={() => setReviewing(null)} />}
    </>
  );
}
