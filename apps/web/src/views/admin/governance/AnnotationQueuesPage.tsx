/**
 * ADR-0173 batch 2c (Q) — annotation queues: setup. Admin-only.
 *
 * A queue holds traces, spans and eval results (sent from Traces, or by an
 * automation rule) for NAMED REVIEWERS to score against a RUBRIC: numeric
 * scores in a range and labels from a fixed set, with an optional comment.
 *
 *  - N-person review: an item completes only when N distinct reviewers have
 *    reviewed it; disagreement between them is recorded.
 *  - Reviewers work from their Inbox. They see previews only, every read is
 *    audited, and nobody reviews their own traces or runs.
 *  - Editing a rubric that already has reviews creates a new version; earlier
 *    reviews keep the version they were made against.
 *  - The SLA marks an item breached once, with a webhook.
 *  - The export is a CSV of ids, scores, labels and comments, audited.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Fieldset, Input, Modal, Select, Table } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { QueryGate, RemoveButton, downloadCsv, useAction, useUsers } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

type Criterion =
  | { name: string; kind: "score"; min: number; max: number; step?: number; description?: string }
  | { name: string; kind: "label"; labels: string[]; description?: string };
interface Rubric {
  criteria: Criterion[];
  commentRequired: boolean;
}
interface QueueSummary {
  id: string;
  name: string;
  description: string;
  rubricVersion: number;
  requiredReviews: number;
  slaHours: number | null;
  reviewerCount: number;
  openItems: number;
  completedItems: number;
  breachedItems: number;
  disagreements: number;
  updatedAt: string;
}
interface QueueDetail extends Omit<QueueSummary, "reviewerCount" | "openItems" | "completedItems" | "breachedItems" | "disagreements"> {
  rubric: Rubric | null;
  rubricVersions: Array<{ version: number; createdAt: string }>;
  reviewers: Array<{ id: string; name: string }>;
}
interface Item {
  id: string;
  subjectKind: "trace" | "span" | "eval_result";
  subjectId: string;
  status: "open" | "completed";
  requiredReviews: number;
  submissionCount: number;
  dueAt: string | null;
  slaBreached: boolean;
  disagreement: boolean | null;
  createdAt: string;
}

const KEYS = { queues: ["admin", "annotation-queues"] as const, items: (id: string) => ["admin", "annotation-items", id] as const };
const SUBJECT_LABEL: Record<Item["subjectKind"], string> = { trace: "Trace", span: "Span", eval_result: "Eval result" };
const ROW = { display: "flex", gap: "var(--s2)", alignItems: "center", minHeight: 32 } as const;
const BOX = { width: 18, height: 18, margin: 0, flex: "none" } as const;

/** the editable form of one criterion: labels as one comma-separated string */
interface DraftCriterion {
  name: string;
  kind: "score" | "label";
  min: string;
  max: string;
  step: string;
  labels: string;
}
const blankCriterion = (): DraftCriterion => ({ name: "", kind: "score", min: "1", max: "5", step: "1", labels: "" });
const toDraft = (c: Criterion): DraftCriterion =>
  c.kind === "score"
    ? { name: c.name, kind: "score", min: String(c.min), max: String(c.max), step: c.step !== undefined ? String(c.step) : "", labels: "" }
    : { name: c.name, kind: "label", min: "", max: "", step: "", labels: c.labels.join(", ") };
const fromDraft = (d: DraftCriterion): Criterion =>
  d.kind === "score"
    ? { name: d.name.trim(), kind: "score", min: Number(d.min), max: Number(d.max), ...(d.step.trim() ? { step: Number(d.step) } : {}) }
    : { name: d.name.trim(), kind: "label", labels: d.labels.split(",").map((l) => l.trim()).filter(Boolean) };

function QueueModal(props: { open: boolean; editing: QueueDetail | null; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const users = useUsers();
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [required, setRequired] = useState("1");
  const [sla, setSla] = useState("");
  const [criteria, setCriteria] = useState<DraftCriterion[]>([blankCriterion()]);
  const [commentRequired, setCommentRequired] = useState(false);
  const key = props.open ? (props.editing?.id ?? "new") : null;
  if (key !== lastKey) {
    setLastKey(key);
    const e = props.editing;
    setName(e?.name ?? "");
    setDescription(e?.description ?? "");
    setReviewers(e?.reviewers.map((r) => r.id) ?? []);
    setRequired(String(e?.requiredReviews ?? 1));
    setSla(e?.slaHours != null ? String(e.slaHours) : "");
    setCriteria(e?.rubric ? e.rubric.criteria.map(toDraft) : [{ ...blankCriterion(), name: "helpfulness" }]);
    setCommentRequired(e?.rubric?.commentRequired ?? false);
  }
  const setCrit = (i: number, patch: Partial<DraftCriterion>) => setCriteria((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const activeUsers = (users.data?.users ?? []).filter((u) => !u.disabledAt);
  const body = () => ({
    name,
    description,
    reviewerUserIds: reviewers,
    requiredReviews: Number(required),
    slaHours: sla.trim() ? Number(sla) : null,
    rubric: { criteria: criteria.map(fromDraft), commentRequired },
  });
  return (
    <Modal
      open={props.open}
      wide
      title={props.editing ? `Edit ${props.editing.name}` : "New annotation queue"}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={act.busy || !name.trim() || criteria.length === 0}
            onClick={() =>
              void act
                .run(
                  () => (props.editing ? api.patch(`/v1/annotation-queues/${props.editing.id}`, body()) : api.post("/v1/annotation-queues", body())),
                  props.editing ? `Queue ${name} saved` : `Queue ${name} created`,
                )
                .then((ok) => {
                  if (ok) {
                    props.onSaved();
                    props.onClose();
                  }
                })
            }
          >
            {props.editing ? "Save" : "Create queue"}
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <div className={a.formRow}>
          <Field label="Queue name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="support-answers" />
          </Field>
          <Field label="Description" grow>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </Field>
        </div>
        <div className={a.formRow}>
          <Field label="Reviews needed per item" help="N-person review: an item completes only when this many different reviewers have reviewed it.">
            <Select value={required} onChange={(e) => setRequired(e.target.value)}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "1 reviewer" : `${n} different reviewers`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Deadline (hours, optional)" help="An item still open this long after it was queued is marked past its deadline, once, and a webhook is sent.">
            <Input type="number" min={1} max={720} value={sla} onChange={(e) => setSla(e.target.value)} placeholder="no deadline" />
          </Field>
        </div>
        <Fieldset legend="Reviewers">
          <p className={v.faint}>
            Named reviewers see this queue&apos;s items in their Inbox, as previews only. Every read is recorded in the audit log, and nobody reviews
            their own traces or runs.
          </p>
          {activeUsers.map((u) => (
            <div key={u.id} style={ROW}>
              <input
                type="checkbox"
                style={BOX}
                id={`aq-rev-${u.id}`}
                checked={reviewers.includes(u.id)}
                onChange={() => setReviewers((r) => (r.includes(u.id) ? r.filter((x) => x !== u.id) : [...r, u.id]))}
              />
              <label htmlFor={`aq-rev-${u.id}`}>
                {u.displayName || u.email} <span className={v.faint}>· {u.email}</span>
              </label>
            </div>
          ))}
        </Fieldset>
        <Fieldset legend="Rubric">
          {props.editing && (
            <p className={v.faint}>
              Version {props.editing.rubricVersion}. If this version already has reviews, saving a change creates version {props.editing.rubricVersion + 1};
              earlier reviews keep the version they were made against.
            </p>
          )}
          {criteria.map((c, i) => (
            <div key={i} className={a.formRow} style={{ alignItems: "flex-end" }}>
              <Field label={`Criterion ${i + 1} name`}>
                <Input value={c.name} onChange={(e) => setCrit(i, { name: e.target.value })} placeholder="helpfulness" maxLength={64} />
              </Field>
              <Field label={`Criterion ${i + 1} type`}>
                <Select value={c.kind} onChange={(e) => setCrit(i, { kind: e.target.value as DraftCriterion["kind"] })}>
                  <option value="score">Score in a range</option>
                  <option value="label">Label from a list</option>
                </Select>
              </Field>
              {c.kind === "score" ? (
                <>
                  <Field label={`Criterion ${i + 1} lowest`}>
                    <Input type="number" value={c.min} onChange={(e) => setCrit(i, { min: e.target.value })} style={{ width: 90 }} />
                  </Field>
                  <Field label={`Criterion ${i + 1} highest`}>
                    <Input type="number" value={c.max} onChange={(e) => setCrit(i, { max: e.target.value })} style={{ width: 90 }} />
                  </Field>
                  <Field label={`Criterion ${i + 1} step`}>
                    <Input type="number" value={c.step} onChange={(e) => setCrit(i, { step: e.target.value })} style={{ width: 90 }} placeholder="any" />
                  </Field>
                </>
              ) : (
                <Field label={`Criterion ${i + 1} labels (comma-separated)`} grow>
                  <Input value={c.labels} onChange={(e) => setCrit(i, { labels: e.target.value })} placeholder="good, bad, unsure" />
                </Field>
              )}
              <Button size="sm" variant="ghost" aria-label={`Remove criterion ${i + 1}`} disabled={criteria.length === 1} onClick={() => setCriteria((cs) => cs.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          <div className={v.row}>
            <Button size="sm" disabled={criteria.length >= 10} onClick={() => setCriteria((cs) => [...cs, blankCriterion()])}>
              Add criterion
            </Button>
          </div>
          <div style={ROW}>
            <input type="checkbox" style={BOX} id="aq-comment-required" checked={commentRequired} onChange={(e) => setCommentRequired(e.target.checked)} />
            <label htmlFor="aq-comment-required">Require a comment (up to 2,000 characters)</label>
          </div>
        </Fieldset>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ItemsModal(props: { queue: QueueSummary | null; onClose: () => void }) {
  const items = useQuery({
    queryKey: KEYS.items(props.queue?.id ?? ""),
    queryFn: () => api.get<{ items: Item[] }>(`/v1/annotation-queues/${props.queue!.id}/items?limit=200`),
    enabled: !!props.queue,
  });
  return (
    <Modal open={props.queue !== null} wide title={`Items — ${props.queue?.name ?? ""}`} onClose={props.onClose} actions={<Button onClick={props.onClose}>Close</Button>}>
      <QueryGate loading={items.isLoading} error={items.error} onRetry={() => void items.refetch()}>
        <Table
          rows={items.data?.items ?? []}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No items yet" body="Send traces here from the Traces page, or with an automation rule." />}
          columns={[
            { key: "subject", header: "Subject", render: (r) => <span>{SUBJECT_LABEL[r.subjectKind]} <code>{r.subjectId.slice(0, 8)}</code></span> },
            {
              key: "status",
              header: "Status",
              render: (r) => (
                <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                  <Badge tone={r.status === "completed" ? "ok" : "neutral"}>{r.status}</Badge>
                  {r.slaBreached && <Badge tone="danger">past deadline</Badge>}
                  {r.disagreement && <Badge tone="warn">reviewers disagreed</Badge>}
                </span>
              ),
            },
            { key: "reviews", header: "Reviews", render: (r) => `${r.submissionCount} of ${r.requiredReviews}` },
            { key: "queued", header: "Queued", render: (r) => ago(r.createdAt) },
            {
              key: "actions",
              header: "",
              render: (r) => (
                <div className={v.row}>
                  <Link to={`/inbox/annotations/${r.id}`} aria-label={`Open item ${r.subjectId.slice(0, 8)}`}>
                    Open
                  </Link>
                  <RemoveButton
                    what={`item ${r.subjectId.slice(0, 8)}`}
                    consequence="Its reviews are deleted with it. Scores already recorded on the trace stay, and the audit log keeps the record."
                    onRemove={() => api.del(`/v1/annotation-queues/${props.queue!.id}/items/${r.id}`)}
                    onDone={() => void items.refetch()}
                  />
                </div>
              ),
            },
          ]}
        />
      </QueryGate>
    </Modal>
  );
}

export default function AnnotationQueuesPage() {
  const queues = useQuery({ queryKey: KEYS.queues, queryFn: () => api.get<{ queues: QueueSummary[] }>("/v1/annotation-queues") });
  const act = useAction();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<QueueDetail | null>(null);
  const [viewing, setViewing] = useState<QueueSummary | null>(null);
  const refetch = () => void queues.refetch();
  const rows = queues.data?.queues ?? [];

  return (
    <>
      <PageHeader
        title="Annotation queues"
        sub="Named people score traces, spans and eval results against a rubric."
        info={
          <p>
            Send traces to a queue from the Traces page or with an automation rule. Each queue has a rubric (scores in a range, labels from a list and an
            optional comment), named reviewers, how many different reviewers each item needs, and an optional deadline. Reviews become trace scores you
            can filter on.
          </p>
        }
      />
      <div className={v.stack}>
        <Card title="How review works">
          <ul className={v.faint} style={{ margin: 0, paddingLeft: "var(--s3)" }}>
            <li>Reviewers work from their Inbox. They see previews only, and every read is recorded in the audit log.</li>
            <li>Nobody reviews their own traces or runs, and each reviewer counts once toward the reviews an item needs.</li>
            <li>A completed item cannot change. When reviewers disagree, the item says so.</li>
            <li>Content withheld by policy shows a marker; a trace that has since been deleted shows &quot;no longer retained&quot;.</li>
            <li>The export holds ids, scores, labels and comments only. Each download is recorded in the audit log.</li>
          </ul>
        </Card>
        <QueryGate loading={queues.isLoading} error={queues.error} onRetry={refetch}>
          <Card
            title="Queues"
            actions={
              <div className={v.row}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={act.busy}
                  onClick={() =>
                    void act.run(async () => {
                      const r = await api.post<{ breached: number }>("/v1/annotation-queues/sla-sweep", {});
                      refetch();
                      return `Deadline check: ${r.breached} item(s) newly past their deadline`;
                    })
                  }
                >
                  Check deadlines now
                </Button>
                <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                  New queue
                </Button>
              </div>
            }
          >
            {rows.length === 0 ? (
              <EmptyState title="No annotation queues" body="Create a queue, then send traces to it from the Traces page." />
            ) : (
              <Table
                rows={rows}
                rowKey={(r) => r.id}
                columns={[
                  {
                    key: "name",
                    header: "Queue",
                    render: (r) => (
                      <div>
                        <strong>{r.name}</strong>
                        {r.description && <div className={v.faint}>{r.description}</div>}
                      </div>
                    ),
                  },
                  { key: "reviewers", header: "Reviewers", render: (r) => `${r.reviewerCount} · ${r.requiredReviews} per item` },
                  { key: "sla", header: "Deadline", render: (r) => (r.slaHours ? `${r.slaHours} h` : "none") },
                  {
                    key: "items",
                    header: "Items",
                    render: (r) => (
                      <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                        <Badge>{r.openItems} open</Badge>
                        <Badge tone="ok">{r.completedItems} done</Badge>
                        {r.breachedItems > 0 && <Badge tone="danger">{r.breachedItems} past deadline</Badge>}
                        {r.disagreements > 0 && <Badge tone="warn">{r.disagreements} disagreed</Badge>}
                      </span>
                    ),
                  },
                  { key: "rubric", header: "Rubric", render: (r) => `version ${r.rubricVersion}` },
                  {
                    key: "actions",
                    header: "",
                    render: (r) => (
                      <div className={v.row}>
                        <Button size="sm" variant="ghost" aria-label={`Items of ${r.name}`} onClick={() => setViewing(r)}>
                          Items
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Edit ${r.name}`}
                          onClick={() => void api.get<QueueDetail>(`/v1/annotation-queues/${r.id}`).then(setEditing, (e: Error) => toast(e.message, "error"))}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Export the reviews of ${r.name}`}
                          onClick={() => void downloadCsv(`/v1/annotation-queues/${r.id}/export`, `annotations-${r.name}.csv`, (m) => toast(m, "error"))}
                        >
                          Export CSV
                        </Button>
                        <RemoveButton
                          what={`queue ${r.name}`}
                          consequence="Its items and reviews are deleted with it. Scores already recorded on traces stay, and the audit log keeps the record."
                          onRemove={() => api.del(`/v1/annotation-queues/${r.id}`)}
                          onDone={refetch}
                        />
                      </div>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </QueryGate>
      </div>
      <QueueModal open={creating || editing !== null} editing={editing} onClose={() => { setCreating(false); setEditing(null); }} onSaved={refetch} />
      <ItemsModal queue={viewing} onClose={() => { setViewing(null); refetch(); }} />
    </>
  );
}

