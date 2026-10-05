/**
 * ADR-0173 batch 2c (Q) — one annotation item, for review. Outside
 * RequireAdmin: a named reviewer of the item's queue works here from their
 * Inbox. The server decides who may read (a named reviewer or an admin; anyone
 * else gets 403 and is recorded) and what (previews only for a non-admin), and
 * records every read; this page only shows what it was given.
 *
 * Content withheld by policy shows its marker; a subject deleted since it was
 * queued shows "no longer retained" and cannot be reviewed. Review is blind: a
 * reviewer sees their own review, an admin sees every review.
 */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../api/client";
import { ago } from "../../api/format";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, Card, CodeBlock, EmptyState, ErrorState, Field, Input, Select, SkeletonBlock, Textarea } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import v from "../views.module.css";

type Criterion =
  | { name: string; kind: "score"; min: number; max: number; step?: number; description?: string }
  | { name: string; kind: "label"; labels: string[]; description?: string };
interface PreviewSpan {
  id: string;
  kind: string;
  name: string;
  status: string;
  model: string | null;
  input: string | null;
  output: string | null;
  withheld: boolean;
  attributes?: unknown;
}
interface Submission {
  id: string;
  reviewerUserId: string;
  rubricVersion: number;
  values: Record<string, number | string>;
  comment: string | null;
  createdAt: string;
}
export interface AnnotationItemResponse {
  item: {
    id: string;
    queueName: string;
    subjectKind: "trace" | "span" | "eval_result";
    subjectId: string;
    traceId: string | null;
    status: "open" | "completed";
    requiredReviews: number;
    submissionCount: number;
    dueAt: string | null;
    slaBreached: boolean;
    disagreement: boolean | null;
  };
  queue: { id: string; name: string; description: string };
  rubric: { version: number; criteria: Criterion[]; commentRequired: boolean };
  preview: {
    retained: boolean;
    note: string | null;
    previewOnly: boolean;
    trace: { id: string; name: string; kind: string; status: string; startedAt: string } | null;
    spans: PreviewSpan[];
    spansTruncated: boolean;
    evalResult: { id: string; scorerKind: string; score: number; passed: boolean; input: string | null; output: string | null; withheld: boolean } | null;
  };
  you: {
    isReviewer: boolean;
    isAdmin: boolean;
    selfReview: boolean;
    canSubmit: boolean;
    blockedReason: string | null;
    submission: Submission | null;
  };
  submissions?: Submission[];
}

const BLOCKED: Record<string, string> = {
  not_a_reviewer: "You can read this item as an admin, but only the queue's named reviewers review it.",
  self_review: "This is your own trace or run, so you cannot review it.",
  already_submitted: "You have reviewed this item.",
  completed: "This item has all the reviews it needs and cannot change.",
  not_retained: "This item can no longer be reviewed: its content is no longer retained.",
};
const SUBJECT_LABEL = { trace: "Trace", span: "Span", eval_result: "Eval result" } as const;

function Text(props: { label: string; text: string | null; withheld: boolean }) {
  return (
    <div>
      <div className={v.faint} style={{ marginBottom: "var(--s0)" }}>
        {props.label} {props.withheld && <Badge tone="warn">withheld by policy</Badge>}
      </div>
      {props.text ? <CodeBlock maxHeight="220px">{props.text}</CodeBlock> : <span className={v.faint}>Nothing was captured.</span>}
    </div>
  );
}

function Preview(props: { data: AnnotationItemResponse }) {
  const p = props.data.preview;
  if (!p.retained) {
    return (
      <Card title="Content">
        <EmptyState title="No longer retained" body={`This ${SUBJECT_LABEL[props.data.item.subjectKind].toLowerCase()} was deleted under the retention policy or an erasure request after it was queued. Its reviews are kept.`} />
      </Card>
    );
  }
  return (
    <Card title="Content" actions={p.previewOnly ? <Badge tone="info" title="Each text is cut short and span attributes are not shown">previews only</Badge> : undefined}>
      <div className={v.stack}>
        {p.trace && (
          <div className={v.faint}>
            {p.trace.name} · {p.trace.kind} · {p.trace.status} · {ago(p.trace.startedAt)}
            {props.data.you.isAdmin && (
              <>
                {" · "}
                <Link to={`/admin/traces?trace=${p.trace.id}`}>open the full trace</Link>
              </>
            )}
          </div>
        )}
        {p.evalResult && (
          <div className={v.stack}>
            <div className={v.row}>
              <Badge>{p.evalResult.scorerKind}</Badge>
              <Badge tone={p.evalResult.passed ? "ok" : "danger"}>
                {p.evalResult.passed ? "passed" : "failed"} · score {p.evalResult.score}
              </Badge>
            </div>
            <Text label="Case input" text={p.evalResult.input} withheld={false} />
            <Text label="Output" text={p.evalResult.output} withheld={p.evalResult.withheld} />
          </div>
        )}
        {p.spans.map((s) => (
          <div key={s.id} className={v.stack} style={{ borderTop: "1px solid var(--border)", paddingTop: "var(--s1)" }}>
            <div className={v.row}>
              <strong style={{ fontSize: "var(--text-sm)" }}>{s.name}</strong>
              <Badge>{s.kind}</Badge>
              <Badge tone={s.status === "ok" ? "ok" : s.status === "denied" || s.status === "error" ? "danger" : "neutral"}>{s.status}</Badge>
              {s.model && <span className={v.mono}>{s.model}</span>}
            </div>
            <div className={v.grid2}>
              <Text label="Input" text={s.input} withheld={s.withheld} />
              <Text label="Output" text={s.output} withheld={s.withheld} />
            </div>
          </div>
        ))}
        {p.spansTruncated && <div className={v.faint}>Only the first spans are shown.</div>}
      </div>
    </Card>
  );
}

function ReviewForm(props: { data: AnnotationItemResponse; onDone: () => void }) {
  const { toast } = useToast();
  const { rubric, item } = props.data;
  const [values, setValues] = useState<Record<string, string>>({});
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = rubric.criteria.every((c) => (values[c.name] ?? "").trim() !== "") && (!rubric.commentRequired || comment.trim() !== "");
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        values: Object.fromEntries(rubric.criteria.map((c) => [c.name, c.kind === "score" ? Number(values[c.name]) : values[c.name]!])),
        ...(comment.trim() ? { comment } : {}),
      };
      const res = await api.post<{ item: { status: string } }>(`/v1/annotations/items/${item.id}/submissions`, body);
      toast(res.item.status === "completed" ? "Review recorded — the item is complete" : "Review recorded", "success");
      props.onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={v.stack}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {rubric.criteria.map((c) =>
        c.kind === "score" ? (
          <Field key={c.name} label={`${c.name} (${c.min} to ${c.max})`} help={c.description || undefined}>
            <Input
              type="number"
              min={c.min}
              max={c.max}
              step={c.step ?? "any"}
              value={values[c.name] ?? ""}
              onChange={(e) => setValues((x) => ({ ...x, [c.name]: e.target.value }))}
              style={{ maxWidth: 160 }}
            />
          </Field>
        ) : (
          <Field key={c.name} label={c.name} help={c.description || undefined}>
            <Select value={values[c.name] ?? ""} onChange={(e) => setValues((x) => ({ ...x, [c.name]: e.target.value }))} style={{ maxWidth: 260 }}>
              <option value="">Choose…</option>
              {c.labels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        ),
      )}
      <Field label={rubric.commentRequired ? "Comment (required)" : "Comment (optional)"}>
        <Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} rows={4} />
      </Field>
      <div className={v.faint}>{comment.length} of 2,000 characters</div>
      {error && (
        <div className={v.errLine} role="alert">
          {error}
        </div>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={busy || !ready}>
          Submit review
        </Button>
      </div>
    </form>
  );
}

function ReviewList(props: { title: string; subs: Submission[] }) {
  return (
    <Card title={props.title}>
      {props.subs.map((s) => (
        <div key={s.id} className={v.listRow} style={{ flexDirection: "column", alignItems: "stretch" }}>
          <div className={v.rowTight}>
            {Object.entries(s.values).map(([k, val]) => (
              <Badge key={k}>
                {k}: {String(val)}
              </Badge>
            ))}
            <span className={v.faint}>
              rubric version {s.rubricVersion} · {ago(s.createdAt)}
            </span>
          </div>
          {s.comment && <div style={{ fontSize: "var(--text-sm)", whiteSpace: "pre-wrap" }}>{s.comment}</div>}
        </div>
      ))}
    </Card>
  );
}

export default function AnnotationReviewPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const q = useQuery({
    queryKey: ["annotation-item", itemId],
    queryFn: () => api.get<AnnotationItemResponse>(`/v1/annotations/items/${itemId}`),
    retry: false,
  });
  if (q.isLoading) return <SkeletonBlock lines={6} />;
  if (q.error || !q.data) {
    const denied = q.error instanceof ApiError && q.error.status === 403;
    const msg = q.error instanceof Error ? q.error.message : "This item could not be loaded.";
    return (
      <>
        <PageHeader title="Review" />
        <Card>
          <ErrorState access={denied} message={denied ? "Only this queue's named reviewers and admins can read its items." : msg} />
          <div style={{ marginTop: "var(--s2)" }}>
            <Link to="/inbox">Back to Inbox</Link>
          </div>
        </Card>
      </>
    );
  }
  const d = q.data;
  return (
    <>
      <PageHeader
        title={`Review · ${d.queue.name}`}
        sub={`${SUBJECT_LABEL[d.item.subjectKind]} · ${d.item.submissionCount} of ${d.item.requiredReviews} review(s)${d.item.dueAt ? ` · due ${ago(d.item.dueAt)}` : ""}`}
      />
      <div className={v.stack}>
        <div className={v.row}>
          <Link to="/inbox">Back to Inbox</Link>
          <span className={v.grow} />
          <Badge tone={d.item.status === "completed" ? "ok" : "neutral"}>{d.item.status}</Badge>
          {d.item.slaBreached && <Badge tone="danger">past deadline</Badge>}
          {d.item.disagreement && <Badge tone="warn">reviewers disagreed</Badge>}
        </div>
        <Preview data={d} />
        <Card title={`Your review · rubric version ${d.rubric.version}`}>
          {d.you.canSubmit ? (
            <ReviewForm data={d} onDone={() => void q.refetch()} />
          ) : (
            <p className={v.faint} role="status">
              {BLOCKED[d.you.blockedReason ?? ""] ?? "You cannot review this item."}
            </p>
          )}
        </Card>
        {d.you.submission && !d.submissions && <ReviewList title="What you submitted" subs={[d.you.submission]} />}
        {d.submissions && d.submissions.length > 0 && <ReviewList title="All reviews (admin view)" subs={d.submissions} />}
      </div>
    </>
  );
}
