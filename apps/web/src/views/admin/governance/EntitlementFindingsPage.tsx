/**
 * SaaS entitlement findings (ADR-0337 §5), at `/admin/shadow-ai/entitlement-findings`, reached from Discovery sources.
 *
 * The report the gateway computes at read time, one card per rule: its findings, what each rule cannot see (its
 * limits), and the sources it could not assess, which are never shown as findings. Any finding can be raised for a
 * second administrator's decision in Approvals; nothing executes either way, and RegulAIt never revokes a vendor-side
 * grant. An accepted risk stays listed and marked. Below, the raised reviews, with withdraw where the review's own
 * lifecycle allows it. One reducer holds the window, the reviews' cursors and the one change in flight
 * (`findingsReducer`, entitlementFindingsModel.ts).
 */
import { useReducer } from "react";
import { Link } from "react-router-dom";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorText, fmtAt } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { useSession } from "../../../session/SessionContext";
import { Badge, Button, Card, EmptyState, Field, Modal, Select, Table, Textarea, type Column } from "../../../ui/kit";
import { SubpageTrail } from "../../../ui/ListPreview";
import { QueryGate, useUsers } from "../adminKit";
import { FINDINGS_KEY, REVIEWS_KEY, fetchReport, fetchReviews, raiseReview, withdrawReview } from "./entitlementFindingsApi";
import {
  REASON_MAX,
  REVIEW_COPY,
  WINDOWS,
  changeProblem,
  findingsReducer,
  initialScreen,
  subjectOf,
  type Change,
  type Finding,
  type Flow,
  type Review,
  type Rule,
  type WindowDays,
} from "./entitlementFindingsModel";
import v from "../../views.module.css";

const APPROVALS = "/admin/approvals?objectType=saas_finding_review";

export default function EntitlementFindingsPage() {
  const [screen, dispatch] = useReducer(findingsReducer, initialScreen);
  const flow = screen.flow;
  const qc = useQueryClient();
  const me = useSession().auth?.userId ?? null;
  const users = useUsers();
  const report = useQuery({ queryKey: [...FINDINGS_KEY, screen.windowDays], queryFn: () => fetchReport(screen.windowDays) });
  const pages = useQueries({ queries: screen.reviewCursors.map((after) => ({ queryKey: [...REVIEWS_KEY, after], queryFn: () => fetchReviews(after) })) });
  const firstReviews = pages[0]!;
  const lastReviews = pages[pages.length - 1]!;
  const reviews = pages.flatMap((p) => p.data?.reviews ?? []);
  const approvers = (users.data?.users ?? []).filter((u) => u.isAdmin && !u.disabledAt && u.id !== me);

  const submit = () => {
    if (flow.phase !== "editing" && flow.phase !== "failed") return;
    const c = flow.change;
    if (changeProblem(c)) return;
    dispatch({ type: "submit" });
    const call =
      c.kind === "raise"
        ? raiseReview({ key: c.finding.key, approverUserId: c.approverUserId, reason: c.reason, windowDays: screen.windowDays }).then(() => undefined)
        : withdrawReview(c.review.id);
    call
      .then(() => {
        dispatch({ type: "succeeded" });
        void qc.invalidateQueries({ queryKey: FINDINGS_KEY });
        void qc.invalidateQueries({ queryKey: REVIEWS_KEY });
      })
      .catch((e: unknown) => dispatch({ type: "failed", message: errorText(e) }));
  };
  const busy = flow.phase === "submitting";

  return (
    <>
      <SubpageTrail parent="Discovery sources" parentTo="/admin/shadow-ai/discovery-sources" current="SaaS entitlement findings" />
      <PageHeader
        title="SaaS entitlement findings"
        sub="Grants and agents worth a second look, computed from the latest reads. These are recommendations: nothing here changes a vendor's settings."
        actions={<Link to={APPROVALS}>Decide in Approvals</Link>}
      />
      <div className={v.stack}>
        <Card title="Window">
          <div className={v.row}>
            <Field label="Usage window">
              <Select value={screen.windowDays} onChange={(e) => dispatch({ type: "window", windowDays: Number(e.target.value) as WindowDays })}>
                {WINDOWS.map((d) => <option key={d} value={d}>{d} days</option>)}
              </Select>
            </Field>
          </div>
          <p className={v.dim}>The window is a setting, not a statement about what an app needs. A grant younger than the window is not judged.</p>
          {report.data && (
            <p className={v.dim}>
              Computed {fmtAt(report.data.computedAt)}, rules version {report.data.rulesVersion}.
            </p>
          )}
          {report.data?.scanTruncated && <p className={v.errLine} role="alert">There are too many grants to examine at once, so only the first part was examined. These findings are not the whole picture.</p>}
        </Card>

        {flow.phase === "done" && (
          <Card>
            <div className={v.row}>
              <p role="status">
                {flow.change.kind === "raise" ? "Raised for review. The administrator you named decides it in Approvals; nothing changes until then, and nothing executes either way." : "The review is withdrawn. Its approval is no longer pending."}
              </p>
              <Button size="sm" onClick={() => dispatch({ type: "cancel" })}>Dismiss</Button>
            </div>
          </Card>
        )}

        <QueryGate query={report}>
          {report.data?.rules.map((rule) => (
            <RuleCard key={rule.id} rule={rule} busy={busy} onRaise={(finding) => dispatch({ type: "open", change: { kind: "raise", finding, approverUserId: "", reason: "" } })} />
          ))}
        </QueryGate>

        <QueryGate query={firstReviews}>
          <Card
            title="Raised reviews"
            actions={<Link to={APPROVALS}>Open in Approvals</Link>}
            footer={
              lastReviews.data?.next || lastReviews.isError ? (
                <div className={v.row}>
                  {pages.length > 1 && lastReviews.isError && <span className={v.errLine} role="alert">The next reviews could not be loaded.</span>}
                  <Button
                    size="sm"
                    aria-disabled={lastReviews.isLoading || undefined}
                    onClick={() => (lastReviews.isError ? void lastReviews.refetch() : lastReviews.data?.next && dispatch({ type: "moreReviews", after: lastReviews.data.next }))}
                  >
                    {lastReviews.isLoading ? "Loading…" : lastReviews.isError ? "Try again" : "Load more reviews"}
                  </Button>
                </div>
              ) : null
            }
          >
            <ReviewsTable reviews={reviews} busy={busy} onWithdraw={(review) => dispatch({ type: "open", change: { kind: "withdraw", review } })} />
          </Card>
        </QueryGate>
      </div>
      <ChangeModal flow={flow} approvers={approvers} usersFailed={users.isError} onEdit={(change) => dispatch({ type: "edit", change })} onSubmit={submit} onCancel={() => dispatch({ type: "cancel" })} />
    </>
  );
}

function RuleCard({ rule, busy, onRaise }: { rule: Rule; busy: boolean; onRaise: (f: Finding) => void }) {
  const columns: Array<Column<Finding>> = [
    { key: "subject", header: "App or agent", render: (f) => <span>{subjectOf(f)} <span className={v.dim}>({f.source.name})</span></span> },
    { key: "grant", header: "Grant", render: (f) => (f.grant ? <span>{f.grant.scope}{f.grant.access ? <span className={v.dim}> ({f.grant.access})</span> : null}</span> : <span className={v.dim}>Not a grant</span>) },
    {
      key: "why",
      header: "Why",
      render: (f) => (
        <div>
          <p>{f.rationale}</p>
          <details>
            <summary>Evidence</summary>
            <dl>
              {f.evidence.map(([k, val]) => (
                <div key={k} className={v.row}>
                  <dt className={v.dim}>{k}</dt>
                  <dd>{val}</dd>
                </div>
              ))}
            </dl>
            <p className={v.dim}>{f.actionNote}</p>
          </details>
        </div>
      ),
    },
    {
      key: "review",
      header: "Review",
      render: (f) =>
        f.review && f.review.status === "pending" ? (
          <Badge tone={REVIEW_COPY.pending.tone}>{REVIEW_COPY.pending.label}</Badge>
        ) : (
          <div className={v.stack}>
            {f.review && <Badge tone={REVIEW_COPY[f.review.status].tone}>{REVIEW_COPY[f.review.status].label}</Badge>}
            <Button size="sm" aria-disabled={busy || undefined} aria-label={`Raise ${subjectOf(f)} for review`} onClick={() => !busy && onRaise(f)}>
              {f.review ? "Raise again" : "Raise for review"}
            </Button>
          </div>
        ),
    },
  ];
  return (
    <Card title={rule.title} caption={<span className={v.dim}>{rule.limits}</span>}>
      <div className={v.stack}>
        {rule.truncated && <p className={v.dim}>Showing {rule.findings.length} of {rule.count} findings.</p>}
        <Table columns={columns} rows={rule.findings} rowKey={(f) => f.key} empty={<EmptyState title="No findings for this rule" body={rule.notAssessable.length ? "Some sources could not be assessed; they are listed below." : undefined} />} />
        {rule.notAssessable.length > 0 && (
          <div>
            <strong>Not assessable</strong>
            <p className={v.dim}>These sources are not judged by this rule. That is not the same as having no findings.</p>
            <ul>
              {rule.notAssessable.map((n) => (
                <li key={`${n.source}:${n.reason}`}>
                  {n.source}: {n.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

function ReviewsTable({ reviews, busy, onWithdraw }: { reviews: Review[]; busy: boolean; onWithdraw: (r: Review) => void }) {
  const columns: Array<Column<Review>> = [
    { key: "what", header: "Finding", render: (r) => <span>{r.rationale}{r.subjectGone ? <span className={v.dim}> The vendor has since removed the subject.</span> : null}</span> },
    { key: "status", header: "Status", render: (r) => <Badge tone={REVIEW_COPY[r.status].tone}>{REVIEW_COPY[r.status].label}</Badge> },
    { key: "reason", header: "Reason given", render: (r) => r.reason },
    { key: "at", header: "Raised", render: (r) => fmtAt(r.createdAt) },
    {
      key: "actions",
      header: "",
      srHeader: "Actions",
      render: (r) =>
        r.canWithdraw.ok ? (
          <Button size="sm" aria-disabled={busy || undefined} aria-label={`Withdraw the review raised ${fmtAt(r.createdAt)}`} onClick={() => !busy && onWithdraw(r)}>
            Withdraw
          </Button>
        ) : null,
    },
  ];
  return <Table columns={columns} rows={reviews} rowKey={(r) => r.id} empty={<EmptyState title="No reviews raised yet" />} />;
}

function ChangeModal(props: {
  flow: Flow;
  approvers: Array<{ id: string; displayName: string; email: string }>;
  usersFailed: boolean;
  onEdit: (c: Change) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const f = props.flow;
  const open = f.phase === "editing" || f.phase === "submitting" || f.phase === "failed";
  if (!open) return <Modal open={false} title="" onClose={props.onCancel} />;
  const c = f.change;
  const busy = f.phase === "submitting";
  const problem = changeProblem(c);
  const confirm = c.kind === "raise" ? "Raise for review" : "Withdraw";
  return (
    <Modal
      open
      busy={busy}
      title={c.kind === "raise" ? `Raise ${subjectOf(c.finding)} for review` : "Withdraw this review"}
      onClose={props.onCancel}
      actions={
        <>
          <Button onClick={props.onCancel} aria-disabled={busy || undefined}>Cancel</Button>
          <Button variant="primary" aria-disabled={busy || problem != null || undefined} aria-describedby={problem ? "finding-change-problem" : undefined} onClick={() => !busy && !problem && props.onSubmit()}>
            {busy ? "Saving…" : f.phase === "failed" ? `Try again: ${confirm}` : confirm}
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        {c.kind === "raise" ? (
          <>
            <p>{c.finding.rationale}</p>
            <p>
              The administrator you name decides it in Approvals: remove or narrow the grant in the vendor's console, or accept the risk. You cannot decide your own review. Nothing executes
              either way, and the raise is audited.
            </p>
            {props.usersFailed && <p className={v.errLine} role="alert">The administrator list could not be loaded, so no one can be named.</p>}
            <Field label="Administrator who decides">
              <Select value={c.approverUserId} onChange={(e) => props.onEdit({ ...c, approverUserId: e.target.value })}>
                <option value="">Choose an administrator</option>
                {props.approvers.map((u) => <option key={u.id} value={u.id}>{u.displayName || u.email}</option>)}
              </Select>
            </Field>
            <Field label="Why it should be reviewed">
              <Textarea value={c.reason} maxLength={REASON_MAX} rows={3} onChange={(e) => props.onEdit({ ...c, reason: e.target.value })} />
            </Field>
          </>
        ) : (
          <p>The review is withdrawn and audited, and its approval is no longer pending. The finding can be raised again.</p>
        )}
        {problem && <p id="finding-change-problem" className={v.dim}>{problem}</p>}
        {f.phase === "failed" && <p className={v.errLine} role="alert">Nothing changed: {f.message}</p>}
      </div>
    </Modal>
  );
}
