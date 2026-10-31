/**
 * Framework imports — published framework content (control text) an admin
 * reviews and accepts as a NEW draft version of a compliance pack. The content
 * ships with the product, so nothing is downloaded. An import never overwrites
 * a control an admin edited unless the admin ticks it here; the mapping of each
 * control to evidence is never changed by an import.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { fmtDay, frameworkLabel, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { DetailDrawer, DrawerActions } from "../../../ui/DetailDrawer";
import { Badge, Button, Card, EmptyState, RecordError, RowActions, SkeletonBlock, Table } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { useAction } from "../adminKit";
import v from "../../views.module.css";

type ChangeKind = "added" | "text_updated" | "unchanged" | "kept_edited" | "edited_replaced" | "not_in_source";

interface ImportSource {
  sourceId: string;
  framework: string;
  title: string;
  publisher: string;
  licence: string;
  licenceUrl: string;
  textPolicy: "text" | "id_only" | "refused";
  sourceVersion: string;
  retrievedOn: string;
  controls: number;
  accepted: { id: string; sourceVersion: string; decidedAt: string; resultingPackId: string; upToDate: boolean } | null;
  pending: { id: string; createdAt: string } | null;
}

interface ControlText {
  title: string;
  description: string | null;
}

interface ImportChange {
  controlRef: string;
  kind: ChangeKind;
  current: ControlText | null;
  incoming: ControlText | null;
  upstreamChanged?: boolean;
}

interface ImportPlan {
  framework: string;
  sourceVersion: string;
  fromVersion: number | null;
  toVersion: number;
  changes: ImportChange[];
  summary: Record<ChangeKind, number>;
}

interface Proposal {
  id: string;
  sourceId: string;
  framework: string;
  status: string;
  basePackVersion: number | null;
  plan: ImportPlan;
}

const LICENCE_LABELS: Record<string, string> = {
  "US-Gov-Public-Domain": "US government work (public domain)",
  "CC0-1.0": "Public domain (CC0)",
  "Apache-2.0": "Apache 2.0",
};

const KIND_LABELS: Record<ChangeKind, string> = {
  added: "New control",
  text_updated: "Text updated",
  unchanged: "Unchanged",
  kept_edited: "Your edit is kept",
  edited_replaced: "Your edit is replaced",
  not_in_source: "Not in the source, kept",
};

function sourceState(s: ImportSource): { label: string; tone: "ok" | "warn" | "info" | "neutral" } {
  if (s.pending) return { label: "Review waiting", tone: "warn" };
  if (!s.accepted) return { label: "Not imported", tone: "neutral" };
  return s.accepted.upToDate ? { label: "Up to date", tone: "ok" } : { label: "Newer content available", tone: "info" };
}

/** which parts of a control's text differ between the pack and the source, in words */
export function changedParts(current: ControlText | null, incoming: ControlText | null): string[] {
  if (!current || !incoming) return [];
  const parts: string[] = [];
  if (current.title !== incoming.title) parts.push("title");
  if ((current.description ?? "") !== (incoming.description ?? "")) parts.push("description");
  return parts;
}

function TextSide(props: { label: string; text: ControlText; showDescription: boolean }) {
  return (
    <div>
      <p>
        <span className={v.dim}>{props.label}: </span>
        {props.text.title}
      </p>
      {props.showDescription && (
        <p>
          <span className={v.dim}>Description: </span>
          {props.text.description ?? <span className={v.dim}>none</span>}
        </p>
      )}
    </div>
  );
}

/** both sides of a control's text: the title, and the description whenever either side has one */
function TextPair(props: { change: ImportChange }) {
  const { current, incoming } = props.change;
  const parts = changedParts(current, incoming);
  const showDescription = Boolean(current?.description || incoming?.description);
  return (
    <div className={v.stack}>
      {parts.length > 0 && <p className={v.dim}>Changes: {parts.join(" and ")}</p>}
      {current && <TextSide label="In your pack" text={current} showDescription={showDescription} />}
      {incoming && <TextSide label="From the source" text={incoming} showDescription={showDescription} />}
    </div>
  );
}

function ProposalDrawer(props: { proposalId: string; onClose: () => void }) {
  const act = useAction();
  const [take, setTake] = useState<Set<string>>(new Set());
  const q = useQuery({
    queryKey: ["admin", "framework-imports", "proposal", props.proposalId],
    queryFn: () => api.get<{ proposal: Proposal }>(`/v1/compliance/framework-imports/proposals/${props.proposalId}`),
  });
  const p = q.data?.proposal;
  const kept = p?.plan.changes.filter((c) => c.kind === "kept_edited") ?? [];
  const moving = p?.plan.changes.filter((c) => c.kind === "added" || c.kind === "text_updated") ?? [];
  const toggle = (ref: string) =>
    setTake((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });

  return (
    <DetailDrawer
      type="Framework import"
      title={p ? `${frameworkLabel(p.framework)} — version ${p.plan.toVersion}` : "Framework import"}
      subjectKey={props.proposalId}
      meta={p ? <Badge tone="warn">Review waiting</Badge> : undefined}
      onClose={props.onClose}
    >
      {q.isLoading && <SkeletonBlock lines={6} />}
      {q.error && <RecordError noun="import proposal" error={q.error} onRetry={() => void q.refetch()} />}
      {p && (
        <div className={v.stack}>
          <p>
            Accepting creates <strong>draft version {p.plan.toVersion}</strong>
            {p.plan.fromVersion ? ` from version ${p.plan.fromVersion}` : ""}. Nothing becomes active: activate the draft on the{" "}
            <Link to="/admin/compliance-packs">Compliance packs</Link> page after reviewing its diff there. How each control is
            evidenced is never changed by an import.
          </p>
          <p>
            {plural(p.plan.summary.added, "new control", "new controls")}, {plural(p.plan.summary.text_updated, "text update", "text updates")},{" "}
            {plural(p.plan.summary.kept_edited, "edited control kept", "edited controls kept")},{" "}
            {plural(p.plan.summary.not_in_source, "control not in the source", "controls not in the source")} (kept).
          </p>

          <Card title={`Controls you edited (${kept.length})`} info={<p>These differ from the source and were changed in your pack, or were never imported. They are kept unless you tick one to take the source text instead. The source text is new since your last import where marked.</p>}>
            {kept.length === 0 ? (
              <p className={v.dim}>No edited control differs from the source.</p>
            ) : (
              <ul className={v.stack}>
                {kept.map((c) => (
                  <li key={c.controlRef}>
                    <label>
                      <input
                        type="checkbox"
                        checked={take.has(c.controlRef)}
                        onChange={() => toggle(c.controlRef)}
                        aria-describedby={`take-${c.controlRef}`}
                      />{" "}
                      Use the source text for <code>{c.controlRef}</code>
                    </label>{" "}
                    {c.upstreamChanged && <Badge tone="info">New source text</Badge>}
                    <div id={`take-${c.controlRef}`}>
                      <TextPair change={c} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`New and updated controls (${moving.length})`}>
            {moving.length === 0 ? (
              <p className={v.dim}>No control is added or updated.</p>
            ) : (
              <ul className={v.stack}>
                {moving.map((c) => (
                  <li key={c.controlRef}>
                    <Badge tone={c.kind === "added" ? "info" : "neutral"}>{KIND_LABELS[c.kind]}</Badge> <code>{c.controlRef}</code>
                    <TextPair change={c} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

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
            <Button
              variant="primary"
              aria-disabled={act.busy}
              onClick={() => {
                if (act.busy) return;
                void act
                  .run(
                    () => api.post(`/v1/compliance/framework-imports/proposals/${p.id}/accept`, { takeIncoming: [...take].sort() }),
                    `Draft version ${p.plan.toVersion} created`,
                  )
                  .then((ok) => ok && props.onClose());
              }}
            >
              Accept as draft version {p.plan.toVersion}
            </Button>
            <Button
              aria-disabled={act.busy}
              onClick={() => {
                if (act.busy) return;
                void act
                  .run(() => api.post(`/v1/compliance/framework-imports/proposals/${p.id}/reject`, {}), "Import rejected")
                  .then((ok) => ok && props.onClose());
              }}
            >
              Reject import
            </Button>
          </DrawerActions>
        </div>
      )}
    </DetailDrawer>
  );
}

export default function FrameworkImportsPage() {
  const act = useAction();
  const [reviewing, setReviewing] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["admin", "framework-imports"],
    queryFn: () => api.get<{ enabled: boolean; sources: ImportSource[] }>("/v1/compliance/framework-imports"),
  });
  const enabled = q.data?.enabled ?? false;

  return (
    <>
      <PageHeader
        title="Framework imports"
        info={
          <p>
            Published framework content that ships with RegulAIt. Importing it creates a new draft version of a compliance pack with the
            framework's own control text. Every new control starts unmapped, and an import never overwrites text you changed unless you
            choose it. Nothing is downloaded.
          </p>
        }
      />
      <div className={v.stack}>
        {q.data && !enabled && (
          <Card title="Imports are off">
            <p>
              Framework imports are off for this organisation, so nothing can be proposed or accepted. An admin can turn them on in{" "}
              <Link to="/admin/organization">Organisation settings</Link>.
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
          <Table<ImportSource>
            columns={[
              {
                key: "framework",
                header: "Framework",
                sort: (s) => s.title,
                render: (s) => (
                  <>
                    {s.title}
                    <div className={v.dim}>
                      {s.publisher} · <code>{s.framework}</code>
                    </div>
                  </>
                ),
              },
              {
                key: "licence",
                header: "Licence",
                render: (s) => (
                  <>
                    <a href={s.licenceUrl} target="_blank" rel="noreferrer noopener">
                      {LICENCE_LABELS[s.licence] ?? s.licence}
                    </a>
                    {s.textPolicy === "id_only" && <div className={v.dim}>Cited by identifier only</div>}
                  </>
                ),
              },
              {
                key: "version",
                header: "Version",
                sort: (s) => s.sourceVersion,
                render: (s) => (
                  <>
                    {s.sourceVersion}
                    <div className={v.dim}>Retrieved {fmtDay(s.retrievedOn)}</div>
                  </>
                ),
              },
              { key: "controls", header: "Controls", sort: (s) => s.controls, render: (s) => s.controls },
              {
                key: "state",
                header: "Status",
                render: (s) => {
                  const st = sourceState(s);
                  return <Badge tone={st.tone}>{st.label}</Badge>;
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
                          Review import
                        </Button>
                      ) : enabled && !s.accepted?.upToDate ? (
                        <Button
                          size="sm"
                          variant="primary"
                          aria-disabled={act.busy}
                          onClick={() => {
                            if (act.busy) return;
                            void act.run(async () => {
                              const out = await api.post<{ noChange?: boolean; proposal?: { id: string } }>(
                                `/v1/compliance/framework-imports/${encodeURIComponent(s.sourceId)}/proposals`,
                                {},
                              );
                              if (out.proposal) setReviewing(out.proposal.id);
                              return out.noChange ? "Nothing to import: your pack already matches this content" : "Import ready to review";
                            }, undefined);
                          }}
                        >
                          Propose import
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
            empty={<EmptyState title="No framework content ships with this build" body="There is nothing to import." />}
          />
        </Card>
      </div>
      {reviewing && <ProposalDrawer proposalId={reviewing} onClose={() => setReviewing(null)} />}
    </>
  );
}
