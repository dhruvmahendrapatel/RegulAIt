/**
 * ADR-0221 — "Supplier access" on a vendor's detail (VendorsPage loads this lazily): who outside the organisation may
 * answer this vendor's assessment, the single-use sign-in links, and the review of what they sent.
 *
 *  - Granting, a new link and revoking may ask the admin to confirm it's them (`withStepUp`, the app-wide prompt).
 *    Deciding an answer does not: the gateway does not ask for it there.
 *  - A link is shown ONCE, in a dialog, from the response that minted it. It is never put in the query cache or in
 *    browser storage, and closing the dialog drops it.
 *  - Nothing a supplier sends reaches the vendor's record on its own: accepting an answer to a control (or to a question
 *    linked to one) records it as a vendor-attested claim, rejecting sends the reason back to the supplier.
 *  - A file nobody scanned downloads only after the reviewer confirms, and the request says they did.
 *  - Every refusal is shown inline beside the action (and as a toast).
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtAt, fmtBytes, frameworkLabel, plural } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Modal, RowActions, Select, Table, type Tone } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { useToast } from "../../../ui/toast";
import { QueryGate, ReasonModal, useAction } from "../adminKit";
import { fileTypeLabel, REVIEW_STATUS_LABEL, scanLabel, SUPPLIER_LIMITS } from "../../supplier/supplierPortal";
import {
  acceptOutcome,
  ACCESS_STATE_LABEL,
  ANSWER_ACCESS_LABEL,
  answerFilePath,
  answerTargetLabel,
  canAccept,
  canDecide,
  downloadName,
  EMPTY_INVITE,
  inviteBody,
  inviteProblems,
  LINK_STATE_LABEL,
  latestLink,
  needsUnscannedConfirm,
  questionnaireLabel,
  usableQuestionnaires,
  type InviteDraft,
  type IssuedLink,
  type ReviewSubmission,
  type SupplierAccessList,
  type SupplierGrant,
  type SupplierQuestionnaire,
} from "./supplierAccessModel";
import a from "../admin.module.css";
import v from "../../views.module.css";
import sa from "./supplierAccess.module.css";

export const QUESTIONNAIRES_PATH = "/admin/vendors/questionnaires";

const accessTone = (s: SupplierGrant["state"]): Tone => (s === "active" ? "info" : s === "revoked" ? "danger" : "neutral");
const reviewTone = (s: ReviewSubmission["status"]): Tone =>
  s === "accepted" ? "ok" : s === "rejected" ? "danger" : s === "withdrawn" ? "neutral" : "warn";

const NO_CONTROL_ACCEPTED = "Accepted. This question is not linked to a control, so nothing is added to the vendor's checklist.";

/** a vendor whose assessment still takes answers */
const assessmentOpen = (status: string) => status === "proposed" || status === "under_assessment";

export default function SupplierAccessPanel(props: { vendorId: string; vendorName: string; vendorStatus: string; frameworks: string[] }) {
  const act = useAction();
  const { toast } = useToast();
  const base = `/v1/vendors/${props.vendorId}`;

  const settings = useQuery({
    queryKey: ["admin", "supplier-portal", "settings"],
    queryFn: () => api.get<{ enabled: boolean }>("/v1/supplier-portal/settings"),
  });
  const grants = useQuery({
    queryKey: ["admin", "vendor", props.vendorId, "supplier-access"],
    queryFn: () => api.get<SupplierAccessList>(`${base}/supplier-access`),
  });
  const questionnaires = useQuery({
    queryKey: ["admin", "supplier-questionnaires"],
    queryFn: () => api.get<{ questionnaires: SupplierQuestionnaire[] }>("/v1/supplier-questionnaires"),
  });
  const submissions = useQuery({
    queryKey: ["admin", "vendor", props.vendorId, "supplier-submissions"],
    queryFn: () => api.get<{ submissions: ReviewSubmission[]; disclaimer: string }>(`${base}/supplier-submissions`),
  });

  const enabled = settings.data?.enabled === true;
  const open = assessmentOpen(props.vendorStatus);
  const canGrant = enabled && open;
  const usable = usableQuestionnaires(questionnaires.data?.questionnaires ?? []);

  // the invitation form
  const [draft, setDraft] = useState<InviteDraft>(EMPTY_INVITE);
  const [tried, setTried] = useState(false);
  const problems = inviteProblems(draft);
  const shown = tried ? problems : {};

  // one link, shown once: held only while its dialog is open
  const [issued, setIssued] = useState<(IssuedLink & { email: string }) | null>(null);
  const [copied, setCopied] = useState(false);
  // row dialogs
  const [linkFor, setLinkFor] = useState<SupplierGrant | null>(null);
  const [revokeFor, setRevokeFor] = useState<SupplierGrant | null>(null);
  const [acceptFor, setAcceptFor] = useState<ReviewSubmission | null>(null);
  const [rejectFor, setRejectFor] = useState<ReviewSubmission | null>(null);
  const [unscannedFor, setUnscannedFor] = useState<ReviewSubmission | null>(null);

  const refetch = async () => {
    await Promise.all([grants.refetch(), submissions.refetch()]);
  };
  const show = (out: IssuedLink, email: string) => {
    setCopied(false);
    setIssued({ ...out, email });
  };

  const invite = () => {
    setTried(true);
    if (Object.keys(problems).length > 0 || !canGrant || act.busy) return;
    const body = inviteBody(draft);
    void act.run(async () => {
      const out = await withStepUp((h) => stepUpApi.post<IssuedLink & { access: { email: string } }>(`${base}/supplier-access`, body, h));
      setDraft(EMPTY_INVITE);
      setTried(false);
      show(out, out.access.email);
      await refetch();
    }, "Supplier access created. Copy the link now; it is shown once.");
  };

  const issueLink = (g: SupplierGrant) => {
    setLinkFor(null);
    if (act.busy) return;
    void act.run(async () => {
      const out = await withStepUp((h) => stepUpApi.post<IssuedLink>(`${base}/supplier-access/${g.id}/links`, { inviteHours: SUPPLIER_LIMITS.inviteHoursDefault }, h));
      show(out, g.email);
      await refetch();
    }, "New sign-in link created. Copy it now; it is shown once.");
  };

  const revoke = (g: SupplierGrant, reason: string) => {
    setRevokeFor(null);
    void act.run(async () => {
      await withStepUp((h) => stepUpApi.post(`${base}/supplier-access/${g.id}/revoke`, { reason }, h));
      await refetch();
    }, `Access for ${g.email} revoked. Their links and sessions stopped working.`);
  };

  const decide = (s: ReviewSubmission, decision: "accept" | "reject", reason?: string) => {
    setAcceptFor(null);
    setRejectFor(null);
    // the gateway does not ask for step-up here: the plain client, so no prompt can appear
    void act.run(async () => {
      const out = await api.post<{ attestation: unknown }>(
        `${base}/supplier-submissions/${s.id}/decision`,
        decision === "accept" ? { decision } : { decision, reason },
      );
      await refetch();
      if (decision === "reject") return "Answer rejected. The supplier sees your reason.";
      return out.attestation ? "Answer accepted and recorded as a vendor-attested claim." : NO_CONTROL_ACCEPTED;
    });
  };

  /** a clean file downloads at once; any other asks first, and the request carries the reviewer's confirmation */
  const download = (s: ReviewSubmission, acknowledged = false) => {
    setUnscannedFor(null);
    if (!s.file || act.busy) return;
    if (needsUnscannedConfirm(s.file) && !acknowledged) {
      setUnscannedFor(s);
      return;
    }
    const file = s.file;
    void act.run(async () => {
      const { body } = await api.getBlob(answerFilePath(props.vendorId, s.id, needsUnscannedConfirm(file)));
      const url = URL.createObjectURL(body);
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadName(file);
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }, "File downloaded");
  };

  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.link.url);
      setCopied(true);
    } catch {
      toast("The clipboard is not available here. Select the link and copy it yourself.", "error");
    }
  };

  const allQuestionnaires = questionnaires.data?.questionnaires ?? [];
  const targetLabel = (s: ReviewSubmission) => answerTargetLabel(s, allQuestionnaires);

  const rows = grants.data?.access ?? [];
  const subs = submissions.data?.submissions ?? [];

  return (
    <Card
      title="Supplier access"
      info={
        <p>
          Let one person at the supplier answer this vendor&apos;s assessment themselves. They sign in with a single-use link
          you send them, and can see and answer only this assessment until their access ends. Each answer waits for your
          review before it is recorded.
        </p>
      }
    >
      <div className={v.stack}>
        <QueryGate loading={settings.isPending} error={settings.error} onRetry={() => void settings.refetch()}>
          {!enabled && (
            <p className={v.hint} data-testid="supplier-portal-off">
              The supplier portal is off, so no supplier can be invited or sign in. An admin can turn it on in{" "}
              <Link className={sa.inlineLink} to={QUESTIONNAIRES_PATH}>Supplier questionnaires</Link>.
            </p>
          )}
          {enabled && !open && (
            <p className={v.hint}>This vendor&apos;s assessment no longer takes answers, so no supplier can be invited.</p>
          )}
        </QueryGate>

        {act.error && (
          <div className={v.errLine} role="alert" data-testid="supplier-access-error">
            {act.error}
          </div>
        )}
        <RefusalNotice guidance={act.guidance} />

        {/* ---- who has access ---- */}
        <section className={v.stackTight} aria-labelledby="supplier-grants-title">
          <h3 id="supplier-grants-title" className={v.sectionTitle}>People with access</h3>
          <Table<SupplierGrant>
            rows={rows}
            rowKey={(g) => g.id}
            loading={grants.isPending}
            error={grants.error}
            onRetry={() => void grants.refetch()}
            empty={<EmptyState title="No supplier has access" body="Invite the supplier's contact below to let them answer this assessment." />}
            columns={[
              {
                key: "who",
                header: "Supplier",
                render: (g) => (
                  <>
                    <div>{g.email}</div>
                    <div className={v.faint}>
                      {frameworkLabel(g.framework)}
                      {g.questionnaire ? ` · ${questionnaireLabel(g.questionnaire)}` : ""}
                    </div>
                  </>
                ),
              },
              {
                key: "access",
                header: "Access",
                render: (g) => (
                  <>
                    <Badge tone={accessTone(g.state)}>{ACCESS_STATE_LABEL[g.state]}</Badge>
                    <div className={v.faint}>{g.state === "revoked" && g.revokedAt ? `revoked ${fmtAt(g.revokedAt)}` : `ends ${fmtAt(g.expiresAt)}`}</div>
                  </>
                ),
              },
              {
                key: "signin",
                header: "Sign-in",
                render: (g) => {
                  const l = latestLink(g);
                  return (
                    <>
                      <div>{l ? LINK_STATE_LABEL[l.state] : "No link"}</div>
                      <div className={v.faint}>
                        {plural(g.liveSessions, "live session")}
                        {l && l.state === "active" ? ` · link expires ${fmtAt(l.expiresAt)}` : ""}
                        {g.links.length > 1 ? ` · ${plural(g.links.length - 1, "earlier link")}` : ""}
                      </div>
                    </>
                  );
                },
              },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (g) => (
                  <RowActions
                    slot="6rem"
                    primary={
                      g.state === "active" ? (
                        <Button
                          size="sm"
                          aria-label={`New link for ${g.email}`}
                          disabled={!enabled}
                          aria-disabled={act.busy || undefined}
                          onClick={() => !act.busy && setLinkFor(g)}
                        >
                          New link
                        </Button>
                      ) : null
                    }
                    secondary={
                      g.state !== "revoked" ? (
                        <Button size="sm" variant="danger" aria-label={`Revoke access for ${g.email}`} aria-disabled={act.busy || undefined} onClick={() => !act.busy && setRevokeFor(g)}>
                          Revoke
                        </Button>
                      ) : null
                    }
                  />
                ),
              },
            ]}
          />
        </section>

        {/* ---- invite ---- */}
        <section className={v.stackTight} aria-labelledby="supplier-invite-title">
          <h3 id="supplier-invite-title" className={v.sectionTitle}>Invite a supplier</h3>
          <form
            className={v.stack}
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              invite();
            }}
          >
            <ul className={v.hint} data-testid="supplier-invite-terms">
              <li>The sign-in link works once, is shown to you once, and expires after the hours you set.</li>
              <li>Access is limited to this vendor&apos;s assessment and ends after the days you set. You can revoke it at any time.</li>
              <li>Nothing is emailed: you copy the link and send it to the supplier yourself.</li>
            </ul>
            <div className={a.formRow}>
              <Field label="Supplier contact's email" grow error={shown.email}>
                <Input
                  type="email"
                  autoComplete="off"
                  value={draft.email}
                  disabled={!canGrant}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                  placeholder="name@supplier.example"
                />
              </Field>
              <Field label="Framework" error={shown.framework}>
                <Select value={draft.framework} disabled={!canGrant} onChange={(e) => setDraft({ ...draft, framework: e.target.value })}>
                  <option value="">Choose a framework…</option>
                  {props.frameworks.map((f) => (
                    <option key={f} value={f}>
                      {frameworkLabel(f)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {props.frameworks.length === 0 && (
              <p className={v.hint}>
                No framework has an active compliance pack. Activate one in <Link className={sa.inlineLink} to="/admin/compliance-packs">Compliance packs</Link> first.
              </p>
            )}
            <div className={a.formRow}>
              <Field label="Extra questionnaire (optional)" grow>
                <Select value={draft.questionnaireId} disabled={!canGrant} onChange={(e) => setDraft({ ...draft, questionnaireId: e.target.value })}>
                  <option value="">None, controls only</option>
                  {usable.map((q) => (
                    <option key={q.id} value={q.id}>
                      {questionnaireLabel(q)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={`Access lasts (days, 1 to ${SUPPLIER_LIMITS.accessDaysMax})`} error={shown.accessDays}>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={SUPPLIER_LIMITS.accessDaysMax}
                  value={draft.accessDays}
                  disabled={!canGrant}
                  onChange={(e) => setDraft({ ...draft, accessDays: e.target.value })}
                />
              </Field>
              <Field label={`Link works for (hours, 1 to ${SUPPLIER_LIMITS.inviteHoursMax})`} error={shown.inviteHours}>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={SUPPLIER_LIMITS.inviteHoursMax}
                  value={draft.inviteHours}
                  disabled={!canGrant}
                  onChange={(e) => setDraft({ ...draft, inviteHours: e.target.value })}
                />
              </Field>
            </div>
            <div className={v.row}>
              <Button type="submit" variant="primary" disabled={!canGrant} aria-disabled={act.busy || undefined}>
                Create access and link
              </Button>
              <span className={v.faint}>You may be asked to confirm it&apos;s you.</span>
            </div>
          </form>
        </section>

        {/* ---- review ---- */}
        <section className={v.stackTight} aria-labelledby="supplier-review-title">
          <h3 id="supplier-review-title" className={v.sectionTitle}>Answers from suppliers</h3>
          {submissions.data?.disclaimer && <p className={v.faint}>{submissions.data.disclaimer}</p>}
          <Table<ReviewSubmission>
            rows={subs}
            rowKey={(s) => s.id}
            loading={submissions.isPending}
            error={submissions.error}
            onRetry={() => void submissions.refetch()}
            empty={<EmptyState title="No answers yet" body="Answers appear here when a supplier sends them." />}
            columns={[
              {
                key: "answer",
                header: "Answer",
                render: (s) => (
                  <>
                    <div>
                      <strong>{targetLabel(s)}</strong>
                    </div>
                    <div className={`${v.faint} ${v.row}`}>
                      <span>
                        {s.supplierEmail} · sent {fmtAt(s.createdAt)}
                      </span>
                      {ANSWER_ACCESS_LABEL[s.accessState] && (
                        <Badge tone={s.accessState === "revoked" ? "danger" : "neutral"}>{ANSWER_ACCESS_LABEL[s.accessState]}</Badge>
                      )}
                    </div>
                    <div className={sa.prose}>{s.statement}</div>
                  </>
                ),
              },
              {
                key: "file",
                header: "File",
                render: (s) =>
                  s.file && s.status !== "withdrawn" ? (
                    <>
                      <div className={sa.prose}>{s.file.name}</div>
                      <div className={v.faint}>
                        {fileTypeLabel(s.file.contentType)}
                        {s.file.size != null ? ` · ${fmtBytes(s.file.size)}` : ""}
                      </div>
                      <Badge tone={s.file.scanStatus === "clean" ? "ok" : "warn"}>{scanLabel(s.file.scanStatus)}</Badge>
                    </>
                  ) : (
                    <span className={v.faint}>None</span>
                  ),
              },
              {
                key: "status",
                header: "Status",
                render: (s) => (
                  <>
                    <Badge tone={reviewTone(s.status)}>{REVIEW_STATUS_LABEL[s.status] ?? s.status}</Badge>
                    {s.status === "rejected" && s.decisionReason && <div className={v.faint}>Reason: {s.decisionReason}</div>}
                  </>
                ),
              },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (s) => (
                  <RowActions
                    slot="5.5rem"
                    primary={
                      canAccept(s) ? (
                        <Button size="sm" aria-label={`Accept answer from ${s.supplierEmail}`} aria-disabled={act.busy || undefined} onClick={() => !act.busy && setAcceptFor(s)}>
                          Accept
                        </Button>
                      ) : null
                    }
                    secondary={
                      canDecide(s) ? (
                        <Button size="sm" variant="danger" aria-label={`Reject answer from ${s.supplierEmail}`} aria-disabled={act.busy || undefined} onClick={() => !act.busy && setRejectFor(s)}>
                          Reject
                        </Button>
                      ) : null
                    }
                    rest={
                      s.file && s.status !== "withdrawn" ? (
                        <Button size="sm" variant="ghost" aria-label={`Download file ${s.file.name}`} aria-disabled={act.busy || undefined} onClick={() => !act.busy && download(s)}>
                          Download file
                        </Button>
                      ) : null
                    }
                  />
                ),
              },
            ]}
          />
        </section>
      </div>

      {/* ---- dialogs ---- */}
      <Modal
        open={issued !== null}
        title="Copy the sign-in link"
        onClose={() => setIssued(null)}
        actions={
          <Button variant="primary" onClick={() => setIssued(null)}>
            Done
          </Button>
        }
      >
        {issued && (
          <div className={v.stack}>
            <p>
              For <strong>{issued.email}</strong>. {issued.notice}
            </p>
            <div className={a.secretRow}>
              <Input readOnly aria-label="Sign-in link" value={issued.link.url} onFocus={(e) => e.currentTarget.select()} data-testid="supplier-link" />
              <Button onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</Button>
            </div>
            <p className={v.faint}>The link works until {fmtAt(issued.link.expiresAt)}, or until it is used, whichever comes first.</p>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={linkFor !== null}
        title={linkFor ? `Create a new sign-in link for ${linkFor.email}?` : "Create a new sign-in link?"}
        body={
          <p>
            Any earlier link they have not used stops working. The new link works once, is shown to you once and expires in{" "}
            {SUPPLIER_LIMITS.inviteHoursDefault} hours.
          </p>
        }
        confirmLabel="Create link"
        onConfirm={() => linkFor && issueLink(linkFor)}
        onCancel={() => setLinkFor(null)}
      />

      <ReasonModal
        open={revokeFor !== null}
        title={revokeFor ? `Revoke access for ${revokeFor.email}?` : "Revoke access"}
        body={<p>Their links and any live session stop working at once. The reason is recorded in the audit trail.</p>}
        confirmLabel="Revoke access"
        danger
        placeholder="Reason (required, recorded in the audit trail)"
        onConfirm={(reason) => revokeFor && revoke(revokeFor, reason)}
        onCancel={() => setRevokeFor(null)}
      />

      <ConfirmModal
        open={acceptFor !== null}
        title="Accept this answer?"
        body={acceptFor ? <AcceptBody s={acceptFor} label={targetLabel(acceptFor)} vendorName={props.vendorName} outcome={acceptOutcome(acceptFor, allQuestionnaires)} /> : null}
        confirmLabel="Accept answer"
        onConfirm={() => acceptFor && decide(acceptFor, "accept")}
        onCancel={() => setAcceptFor(null)}
      />

      <ConfirmModal
        open={unscannedFor !== null}
        title="Download a file that has not been scanned?"
        body={
          unscannedFor?.file ? (
            <p data-testid="supplier-unscanned-confirm">
              <strong>{unscannedFor.file.name}</strong> has not been scanned for malware. Open it only if you trust the supplier who
              sent it. The download is recorded in the audit trail.
            </p>
          ) : null
        }
        confirmLabel="Download anyway"
        danger
        onConfirm={() => unscannedFor && download(unscannedFor, true)}
        onCancel={() => setUnscannedFor(null)}
      />

      <ReasonModal
        open={rejectFor !== null}
        title="Reject this answer?"
        body={<p>The supplier sees this reason, so say what they need to change or send.</p>}
        confirmLabel="Reject answer"
        danger
        placeholder="Reason the supplier sees (required)"
        onConfirm={(reason) => rejectFor && decide(rejectFor, "reject", reason)}
        onCancel={() => setRejectFor(null)}
      />
    </Card>
  );
}

/** what accepting does, said before the reviewer confirms: a claim on the vendor's checklist, or only "accepted" */
function AcceptBody(props: { s: ReviewSubmission; label: string; vendorName: string; outcome: ReturnType<typeof acceptOutcome> }) {
  const intro = (
    <>
      The answer from {props.s.supplierEmail} for <strong>{props.label}</strong>
    </>
  );
  if (props.outcome === "no_control") {
    return (
      <p data-testid="supplier-accept-outcome">
        {intro} will be marked accepted. This question is not linked to a control, so nothing is added to the vendor&apos;s checklist.
        This cannot be undone.
      </p>
    );
  }
  if (props.outcome === "unknown") {
    return (
      <p data-testid="supplier-accept-outcome">
        {intro} will be marked accepted. If its question is linked to a control, the answer is also recorded on {props.vendorName} as a
        claim the vendor made, attributed to you, and not verified by this platform. This cannot be undone.
      </p>
    );
  }
  return (
    <p data-testid="supplier-accept-outcome">
      {intro} is recorded on {props.vendorName} as a claim the vendor made, attributed to you. It is not verified by this
      platform. This cannot be undone.
    </p>
  );
}
