/**
 * The review task (ADR-0168 §4) — one component for every place an AI use-case
 * sign-off can be decided: the Inbox, the Approvals queue and the Review
 * workbench. A right-hand drawer shows the task, what is being decided (tier
 * and why, risks with inherent → residual ratings, controls, the questionnaire,
 * the stack) and then the decision: approve, approve with conditions, send back
 * for information, or reject.
 *
 * Separation of duties is unchanged: the proposer never decides their own use
 * case, and an admin deciding in the named reviewer's place records a reason.
 *
 * With a review policy (ADR-0168 amendment) a use case needs one review per
 * reviewer role its tier requires: the drawer says which review this is and
 * where the others stand, any member of the role may decide it, and a named
 * risk acceptor can accept residual risk on specific risks when approving.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { Approval, DirectoryUser, ReviewPolicy, UseCaseLifecycleDetail, WorkflowDetailResponse } from "../../api/types";
import { ago, humanize } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { Badge, Button, Field, Input, Select, Textarea } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import { QuestionnaireView } from "../admin/governance/UseCaseQuestionnaire";
import { shortDate, type OverviewResponse } from "../admin/governance/useCaseLifecycle";
import { REVIEW_POLICY_KEY, policyFacts } from "../admin/governance/reviewPolicy";
import {
  OUTCOMES,
  approves,
  blankCondition,
  decideErrorText,
  decisionBody,
  hasErrors,
  intakeUseCaseName,
  outcomeToast,
  reviewPosition,
  reviewStatusLabel,
  validateReview,
  type ReviewDraft,
  type ReviewErrors,
  type ReviewOutcome,
} from "./reviewDecision";
import r from "./review.module.css";
import rr from "./reviewRound.module.css";

interface UseCaseListRow { id: string; workflowInstanceId: string | null }

export function ReviewPanel(props: { approval: Approval; onDecided?: () => void; triggerLabel?: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    // focus returns to the control that opened the task
    window.setTimeout(() => trigger.current?.focus(), 0);
  }, []);
  const name = intakeUseCaseName(props.approval);
  return (
    <>
      <Button ref={trigger} size="sm" onClick={() => setOpen(true)} aria-label={`Review sign-off for ${name}`} aria-haspopup="dialog">
        {props.triggerLabel ?? "Review"}
      </Button>
      {open && createPortal(<ReviewDrawer approval={props.approval} onClose={close} onDecided={props.onDecided} />, document.body)}
    </>
  );
}

function ReviewDrawer(props: { approval: Approval; onClose: () => void; onDecided?: (() => void) | undefined }) {
  const { approval: a, onClose } = props;
  const { auth } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const titleId = useId();
  const drawer = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const me = auth?.userId ?? null;
  const isAdmin = Boolean(auth?.isAdmin);
  const name = intakeUseCaseName(a);

  // --- what is being decided ---------------------------------------------------
  const instance = useQuery({
    queryKey: ["workflow", a.instanceId],
    queryFn: () => api.get<WorkflowDetailResponse>(`/v1/workflows/instances/${a.instanceId}`),
    enabled: Boolean(a.instanceId),
    retry: false,
  });
  const useCases = useQuery({
    queryKey: ["admin", "use-cases"],
    queryFn: () => api.get<{ useCases: UseCaseListRow[] }>("/v1/use-cases"),
    enabled: !a.useCaseId,
    retry: false,
  });
  const useCaseId = a.useCaseId ?? useCases.data?.useCases.find((u) => u.workflowInstanceId && u.workflowInstanceId === a.instanceId)?.id ?? null;
  const overview = useQuery({
    queryKey: ["governance", "use-case-overview", useCaseId],
    queryFn: () => api.get<OverviewResponse>(`/v1/use-cases/${useCaseId}/overview`),
    enabled: Boolean(useCaseId),
    retry: false,
  });
  const directory = useQuery({
    queryKey: ["directory"],
    queryFn: () => api.get<{ users: DirectoryUser[] }>("/v1/users/directory"),
    retry: false,
  });
  // the review round (one review per required role) and the risks' acceptance ride on the detail read
  const detail = useQuery({
    queryKey: ["governance", "use-case-detail", useCaseId],
    queryFn: () => api.get<UseCaseLifecycleDetail>(`/v1/use-cases/${useCaseId}`),
    enabled: Boolean(useCaseId),
    retry: false,
  });
  const policy = useQuery({
    queryKey: REVIEW_POLICY_KEY,
    queryFn: () => api.get<ReviewPolicy>("/v1/governance/review-policy"),
    retry: false,
  });
  const questionnaire = useMemo(() => {
    const docs = (instance.data?.artifacts ?? []).filter((art) => art.output === "use_case_questionnaire");
    return docs.sort((x, y) => y.version - x.version)[0] ?? null;
  }, [instance.data]);

  // --- who may decide ------------------------------------------------------------
  const facts = policyFacts(policy.data, me);
  const role = a.reviewRole ?? null;
  const roleMember = facts.isRoleMember(role?.id);
  const named = (me !== null && me === a.approverUserId) || roleMember;
  const delegated = Boolean(a.delegatedFrom);
  const canDecide = named || delegated || isAdmin;
  const ownProposal = Boolean(a.selfReview) || (me !== null && me === a.userId);
  const reasonRequiredBecause = !named && !delegated && isAdmin
    ? role
      ? `You are not a member of ${role.name} — deciding this review in their place needs a recorded reason.`
      : "You are not the named reviewer — deciding in their place needs a recorded reason."
    : null;
  const awaiting = role ? `a member of ${role.name}` : a.approverName ?? "the named reviewer";

  // --- the review round ------------------------------------------------------------
  const reviews = detail.data?.reviews ?? [];
  const position = reviewPosition(reviews, a.id);
  const otherReviews = reviews.filter((rv) => rv.approvalId !== a.id);

  // --- the decision ----------------------------------------------------------------
  const [draft, setDraft] = useState<ReviewDraft>({ outcome: null, reason: "", conditions: [], acceptRisk: { on: false, riskIds: [], rationale: "" } });
  const [errors, setErrors] = useState<ReviewErrors | null>(null);
  const [submitError, setSubmitError] = useState<{ text: string; aboutRiskAcceptance: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDoc, setShowDoc] = useState(false);
  const chosen = OUTCOMES.find((o) => o.id === draft.outcome) ?? null;

  const choose = (outcome: ReviewOutcome) => {
    setDraft((d) => ({ ...d, outcome, conditions: outcome === "approve_conditions" && d.conditions.length === 0 ? [blankCondition()] : d.conditions }));
    setErrors(null);
  };
  const patchCondition = (key: string, patch: Partial<ReviewDraft["conditions"][number]>) =>
    setDraft((d) => ({ ...d, conditions: d.conditions.map((c) => (c.key === key ? { ...c, ...patch } : c)) }));

  const submit = async () => {
    const found = validateReview(draft, reasonRequiredBecause);
    if (hasErrors(found)) {
      setErrors(found);
      // land on the first problem, never on a silent no-op
      window.setTimeout(() => drawer.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-review-error]')?.focus(), 0);
      return;
    }
    setErrors(null);
    setSubmitError(null);
    setBusy(true);
    try {
      await api.post(`/v1/approvals/${a.id}/decide`, decisionBody(draft));
      toast(outcomeToast[draft.outcome!], "success");
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      void queryClient.invalidateQueries({ queryKey: ["governance"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "use-cases"] });
      props.onDecided?.();
      onClose();
    } catch (e) {
      setSubmitError(decideErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  // --- keyboard: land on the title, trap Tab, Escape closes ----------------------
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    const el = drawer.current;
    if (!el) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = [...el.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')]
        .filter((c) => c.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === heading.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ov = overview.data;
  const controls = ov ? uniqueControls(ov) : [];
  // the risks a risk acceptor may accept: the evidence list's, else the detail read's
  const riskRows: Array<{ id: string; title: string; status: string; residual: string | null }> = ov
    ? ov.risks.map((risk) => ({ id: risk.id, title: risk.title, status: risk.status, residual: risk.residual ? `${risk.residual.likelihood} × ${risk.residual.impact}` : null }))
    : (detail.data?.risks ?? []).map((risk) => ({ id: risk.id, title: risk.title ?? "Untitled risk", status: risk.status ?? "open", residual: null }));
  const acceptable = riskRows.filter((risk) => risk.status !== "accepted" && risk.status !== "closed");
  const offerAcceptance = facts.isRiskAcceptor && approves(draft.outcome) && acceptable.length > 0;
  const acceptRisk = draft.acceptRisk ?? { on: false, riskIds: [], rationale: "" };
  const patchAcceptance = (patch: Partial<typeof acceptRisk>) => setDraft((d) => ({ ...d, acceptRisk: { ...acceptRisk, ...d.acceptRisk, ...patch } }));
  const dueAt = a.assignment?.dueAt ?? null;
  const users = directory.data?.users ?? [];

  return (
    <div className={r.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={drawer} className={r.drawer} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={r.head}>
          <div className={r.headText}>
            <p className={r.kicker}>Open task</p>
            <h2 id={titleId} ref={heading} tabIndex={-1} className={r.title}>Review use case sign-off</h2>
          </div>
          <button type="button" className={r.close} onClick={onClose} aria-label="Close review">×</button>
        </div>

        <div className={r.body}>
          <dl className={r.meta}>
            <dt>Due date</dt>
            <dd>{dueAt ? <>{shortDate(dueAt)}{a.assignment?.slaState === "breached" ? <> <Badge tone="danger">Overdue</Badge></> : null}</> : <span className={r.muted}>No due date set</span>}</dd>
            <dt>Related to</dt>
            <dd>
              <span className={r.related}>
                <span className={r.typeTag}>AI use case</span>
                {useCaseId && isAdmin ? <Link to={`/admin/governance/use-cases/${useCaseId}`}>{name}</Link> : <span>{name}</span>}
              </span>
            </dd>
            <dt>Requested by</dt>
            <dd>{a.requestedByName ?? "Unknown"} · {ago(a.requestedAt)}</dd>
            {role ? (
              <>
                <dt>Review</dt>
                <dd>
                  <strong>{role.name} review</strong>
                  {position ? <span className={r.muted}> · {position.index} of {position.total} reviews</span> : null}
                </dd>
                <dt>Reviewers</dt>
                <dd>Any member of {role.name}{roleMember ? " (you are one)" : ""}{a.delegatedFrom ? ` (delegated to you by ${a.delegatedFrom})` : ""}</dd>
              </>
            ) : (
              <>
                <dt>Reviewer</dt>
                <dd>{a.approverName ?? "Not recorded"}{a.delegatedFrom ? ` (delegated to you by ${a.delegatedFrom})` : ""}</dd>
              </>
            )}
            {otherReviews.length > 0 ? (
              <>
                <dt>Other reviews</dt>
                <dd>
                  <ul className={rr.otherReviews} aria-label="Other reviews">
                    {otherReviews.map((rv) => (
                      <li key={rv.approvalId}>
                        <span>{rv.roleName}</span>
                        <Badge tone={rv.status === "approved" ? "ok" : rv.status === "denied" ? "danger" : rv.status === "returned" ? "warn" : rv.status === "superseded" ? "neutral" : "info"}>{reviewStatusLabel(rv.status)}</Badge>
                        {rv.deciderName ? <span className={r.muted}>{rv.deciderName}{rv.decidedAt ? `, ${shortDate(rv.decidedAt)}` : ""}</span> : null}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
          </dl>

          <p className={r.prompt}>
            Please review this use case and approve it, approve it with conditions, send it back for more information, or reject it.
          </p>

          <section className={r.section} aria-labelledby={`${titleId}-evidence`}>
            <h3 id={`${titleId}-evidence`} className={r.sectionTitle}>What you are deciding</h3>
            <div className={r.evidence}>
              {ov ? (
                <>
                  <EvidenceRow label="EU AI Act tier">
                    {ov.screening.screened ? (
                      <>
                        <strong>{humanize(ov.screening.tier)} tier</strong>
                        {ov.screening.reasons.length ? (
                          <ul>{ov.screening.reasons.slice(0, 3).map((reason, i) => <li key={i}>{reason.reason ?? reason.ref}</li>)}</ul>
                        ) : null}
                      </>
                    ) : <span className={r.muted}>Not screened yet</span>}
                  </EvidenceRow>
                  <EvidenceRow label="Risks">
                    {ov.risks.length === 0 ? <span className={r.muted}>No risks recorded</span> : (
                      <ul>
                        {ov.risks.map((risk) => (
                          <li key={risk.id}>
                            {risk.title}{" "}
                            <span className={r.flow}>
                              {risk.inherent.likelihood} × {risk.inherent.impact} → {risk.residual ? `${risk.residual.likelihood} × ${risk.residual.impact}` : "residual not rated"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </EvidenceRow>
                  <EvidenceRow label="Controls">
                    {controls.length === 0 ? <span className={r.muted}>No controls linked</span> : (
                      <ul>{controls.map((c) => <li key={c.controlRef}>{c.title} <span className={r.muted}>({c.controlRef})</span></li>)}</ul>
                    )}
                  </EvidenceRow>
                </>
              ) : null}
              <EvidenceRow label="Questionnaire">
                {questionnaire ? (
                  <>
                    <span>Version {questionnaire.version}{ov?.questionnaire.submittedAt ? `, submitted ${shortDate(ov.questionnaire.submittedAt)}` : ""} · </span>
                    <button type="button" className={r.linkButton} aria-expanded={showDoc} onClick={() => setShowDoc((s) => !s)}>
                      {showDoc ? "Hide questionnaire" : "View questionnaire"}
                    </button>
                    {showDoc ? <div className={r.docBox}><QuestionnaireView content={questionnaire.content} /></div> : null}
                  </>
                ) : instance.isLoading ? <span className={r.muted}>Loading…</span> : <span className={r.muted}>Not submitted</span>}
              </EvidenceRow>
              {ov ? (
                <EvidenceRow label="Stack">
                  {ov.stack.agents.length === 0 && ov.stack.vendors.length === 0 ? <span className={r.muted}>No agent, model or vendor linked</span> : (
                    <ul>
                      {ov.stack.agents.map((agent) => (
                        <li key={agent.id}>
                          {agent.name} · {agent.model ?? "default model"}{" "}
                          {agent.modelCardApproved ? null : <Badge tone="warn">No approved model card</Badge>}
                        </li>
                      ))}
                      {ov.stack.vendors.map((vendor) => <li key={vendor.id}>{vendor.name} <span className={r.muted}>· vendor, {humanize(vendor.status)}</span></li>)}
                    </ul>
                  )}
                </EvidenceRow>
              ) : null}
            </div>
            {!ov && !overview.isLoading && !(useCases.isLoading && !a.useCaseId) ? (
              <p className={r.muted}>The tier, risks and stack are on the use case record, which its owner and administrators can open.</p>
            ) : null}
          </section>

          {ownProposal ? (
            <p className={r.blocked} role="note">
              You proposed this use case, so someone independent of it decides. It stays with {awaiting}.
            </p>
          ) : !canDecide ? (
            <p className={r.blocked} role="note">Awaiting {awaiting}.</p>
          ) : (
            <form className={r.section} noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
              <fieldset className={r.outcomes}>
                <legend>Decision</legend>
                {OUTCOMES.map((o) => (
                  <label key={o.id} className={r.outcome}>
                    <input
                      type="radio"
                      name={`${titleId}-outcome`}
                      value={o.id}
                      checked={draft.outcome === o.id}
                      onChange={() => choose(o.id)}
                      aria-labelledby={`${titleId}-${o.id}`}
                      aria-describedby={`${titleId}-${o.id}-hint`}
                    />
                    <span>
                      <strong id={`${titleId}-${o.id}`}>{o.label}</strong>
                      <span id={`${titleId}-${o.id}-hint`}>{o.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {errors?.outcome ? <p className={r.error} role="alert" tabIndex={-1} data-review-error>{errors.outcome}</p> : null}

              <Field
                label={draft.outcome === "return" ? "What information is missing (required)" : reasonRequiredBecause ? "Reason (required)" : "Reason (optional)"}
                error={errors?.reason ?? null}
              >
                <Textarea
                  rows={3}
                  value={draft.reason}
                  aria-invalid={errors?.reason ? true : undefined}
                  onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))}
                  placeholder={draft.outcome === "return" ? "What the proposer needs to add or clarify" : "Why you are deciding this way"}
                />
              </Field>

              {draft.outcome === "approve_conditions" ? (
                <div className={r.conditions}>
                  <h3 className={r.sectionTitle}>Conditions</h3>
                  {draft.conditions.map((c, i) => {
                    const rowErr = errors?.rows[c.key];
                    return (
                      <div key={c.key} className={r.conditionRow} role="group" aria-label={`Condition ${i + 1}`}>
                        <div className={r.conditionHead}>
                          <span>Condition {i + 1}</span>
                          {draft.conditions.length > 1 ? (
                            <Button size="sm" variant="ghost" onClick={() => setDraft((d) => ({ ...d, conditions: d.conditions.filter((x) => x.key !== c.key) }))} aria-label={`Remove condition ${i + 1}`}>
                              Remove
                            </Button>
                          ) : null}
                        </div>
                        <div className={r.conditionText}>
                          <Field label="Condition" error={rowErr?.text ?? null}>
                            <Textarea rows={2} maxLength={500} value={c.text} aria-invalid={rowErr?.text ? true : undefined} onChange={(e) => patchCondition(c.key, { text: e.target.value })} placeholder="What must be done" />
                          </Field>
                        </div>
                        <Field label="Owner">
                          <Select value={c.ownerUserId} onChange={(e) => patchCondition(c.key, { ownerUserId: e.target.value })}>
                            <option value="">Not assigned</option>
                            {users.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.id}</option>)}
                          </Select>
                        </Field>
                        <Field label="Due date" error={rowErr?.dueAt ?? null}>
                          <Input type="date" value={c.dueAt} aria-invalid={rowErr?.dueAt ? true : undefined} onChange={(e) => patchCondition(c.key, { dueAt: e.target.value })} />
                        </Field>
                        <Field label="Applies">
                          <Select value={c.blocking ? "before" : "after"} onChange={(e) => patchCondition(c.key, { blocking: e.target.value === "before" })}>
                            <option value="before">Before go-live (holds deployment)</option>
                            <option value="after">After go-live (tracked)</option>
                          </Select>
                        </Field>
                      </div>
                    );
                  })}
                  {errors?.conditions ? <p className={r.error} role="alert" tabIndex={-1} data-review-error>{errors.conditions}</p> : null}
                  <div>
                    <Button size="sm" onClick={() => setDraft((d) => ({ ...d, conditions: [...d.conditions, blankCondition()] }))}>+ Add condition</Button>
                  </div>
                </div>
              ) : null}

              {offerAcceptance ? (
                <div className={rr.acceptance}>
                  <h3 className={r.sectionTitle}>Residual risk</h3>
                  <label className={rr.acceptToggle}>
                    <input type="checkbox" checked={acceptRisk.on} onChange={(e) => { patchAcceptance({ on: e.target.checked }); setSubmitError(null); }} aria-describedby={`${titleId}-accept-hint`} />
                    <span>Accept residual risk</span>
                  </label>
                  <p id={`${titleId}-accept-hint`} className={r.muted}>You are a named risk acceptor. The risks you choose read accepted on the record, with your rationale.</p>
                  {acceptRisk.on ? (
                    <>
                      <fieldset className={rr.riskChoices}>
                        <legend>Risks to accept</legend>
                        {acceptable.map((risk) => (
                          <label key={risk.id} className={rr.riskChoice}>
                            <input
                              type="checkbox"
                              checked={acceptRisk.riskIds.includes(risk.id)}
                              onChange={(e) => patchAcceptance({ riskIds: e.target.checked ? [...acceptRisk.riskIds, risk.id] : acceptRisk.riskIds.filter((id) => id !== risk.id) })}
                            />
                            <span>{risk.title}{risk.residual ? <span className={r.muted}> · residual {risk.residual}</span> : null}</span>
                          </label>
                        ))}
                      </fieldset>
                      {errors?.acceptRisks ? <p className={r.error} role="alert" tabIndex={-1} data-review-error>{errors.acceptRisks}</p> : null}
                      <Field label="Why the residual risk is acceptable (required)" error={errors?.acceptRationale ?? null}>
                        <Textarea
                          rows={3}
                          maxLength={2000}
                          value={acceptRisk.rationale}
                          aria-invalid={errors?.acceptRationale ? true : undefined}
                          onChange={(e) => patchAcceptance({ rationale: e.target.value })}
                          placeholder="The controls in place and why what remains is tolerable"
                        />
                      </Field>
                    </>
                  ) : null}
                  {submitError?.aboutRiskAcceptance ? <p className={r.error} role="alert">{submitError.text}</p> : null}
                </div>
              ) : null}

              {submitError && !(submitError.aboutRiskAcceptance && offerAcceptance) ? <p className={r.error} role="alert">{submitError.text}</p> : null}
            </form>
          )}
        </div>

        <div className={r.footer}>
          <Button onClick={onClose}>{canDecide && !ownProposal ? "Cancel" : "Close"}</Button>
          {canDecide && !ownProposal ? (
            <Button variant={draft.outcome === "reject" ? "danger" : "primary"} disabled={busy} onClick={() => void submit()}>
              {busy ? "Sending…" : chosen?.submit ?? "Submit decision"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EvidenceRow(props: { label: string; children: React.ReactNode }) {
  return (
    <div className={r.evidenceRow}>
      <div className={r.evidenceLabel}>{props.label}</div>
      <div className={r.evidenceValue}>{props.children}</div>
    </div>
  );
}

function uniqueControls(ov: OverviewResponse) {
  const seen = new Map<string, { controlRef: string; title: string }>();
  for (const risk of ov.risks) for (const c of risk.controls) if (!seen.has(c.controlRef)) seen.set(c.controlRef, c);
  return [...seen.values()];
}
