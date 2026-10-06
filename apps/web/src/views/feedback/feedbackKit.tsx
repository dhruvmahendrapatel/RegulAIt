/**
 * ADR-0182 (ADR-0175 batch D4) A13 — the pieces the feedback screens share. OWNER: A13 (D4).
 *
 *   FeedbackList     the queue table with SLA chips (FeedbackPage, FeedbackTab)
 *   FeedbackDetail   one item: what the person wrote (opening it is an audited
 *                    read), the answer form, "Open incident"
 *   FeedbackSettings the admin's four settings, strict default and relaxed copy
 *
 * Text a person wrote is rendered as text (React escapes it; `pre-wrap` keeps
 * their line breaks). Nothing here renders HTML from a submission.
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { fmtAt } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { Badge, Button, Card, EmptyState, Field, IdChip, Input, Modal, Select, Table, Textarea, type Tone } from "../../ui/kit";
import type { AdminUser } from "../../api/adminTypes";
import { QueryGate, useAction } from "../admin/adminKit";
import v from "../views.module.css";

export type FeedbackKind = "problem" | "appeal";
export type FeedbackStatus = "received" | "acknowledged" | "in_review" | "upheld" | "overturned" | "no_change" | "rejected";
export interface FeedbackSla {
  phase: "acknowledge" | "resolve" | "done";
  chip: "on_time" | "due_soon" | "breached" | "done";
  dueAt: string | null;
  breached: Array<"acknowledge" | "resolve">;
}
export interface FeedbackItem {
  id: string;
  useCaseId: string;
  useCaseName: string | null;
  kind: FeedbackKind;
  channel: "in_app" | "signed_link";
  status: FeedbackStatus;
  ownerUserId: string | null;
  ownerName?: string | null;
  traceId: string | null;
  spanId: string | null;
  incidentId: string | null;
  ackDueAt: string;
  resolveDueAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  bodyPurged: boolean;
  sla: FeedbackSla;
}
export interface FeedbackDetailView extends FeedbackItem {
  submitterUserId: string | null;
  body: string | null;
  contact: string | null;
  bodyUnavailable: null | "purged" | "no_data_key" | "undecryptable";
  bodyPurgedAt: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  contestedUserId: string | null;
  youMayResolve: boolean;
  sodConflict: null | "contested_decision_maker" | "submitter";
}

export const KIND_LABEL: Record<FeedbackKind, string> = { problem: "Problem report", appeal: "Appeal" };
export const STATUS_LABEL: Record<FeedbackStatus, string> = {
  received: "Received",
  acknowledged: "Acknowledged",
  in_review: "In review",
  upheld: "Decision upheld",
  overturned: "Decision overturned",
  no_change: "Resolved: no change",
  rejected: "Resolved: rejected",
};
const RESOLVED: FeedbackStatus[] = ["upheld", "overturned", "no_change", "rejected"];
const statusTone = (s: FeedbackStatus): Tone =>
  s === "overturned" ? "warn" : RESOLVED.includes(s) ? "ok" : s === "received" ? "info" : "neutral";

export function FeedbackStatusBadge(props: { status: FeedbackStatus }) {
  return <Badge tone={statusTone(props.status)}>{STATUS_LABEL[props.status] ?? props.status}</Badge>;
}

/** the SLA chip: on time, due within a day, overdue (with the phase), resolved */
export function SlaChip(props: { sla: FeedbackSla }) {
  const s = props.sla;
  const due = s.dueAt ? fmtAt(s.dueAt) : "";
  const what = s.phase === "acknowledge" ? "acknowledge" : "resolve";
  if (s.chip === "done") return <Badge tone="neutral">Resolved</Badge>;
  if (s.chip === "breached") {
    const late = s.breached.includes("resolve") ? "resolution" : "acknowledgement";
    return (
      <Badge tone="danger" title={`The ${late} was due ${due}`}>
        {`Overdue: ${late}`}
      </Badge>
    );
  }
  if (s.chip === "due_soon") return <Badge tone="warn" title={`Due ${due}`}>{`Due soon: ${what} by ${due}`}</Badge>;
  return <Badge tone="ok" title={`Due ${due}`}>{`On time: ${what} by ${due}`}</Badge>;
}

export function FeedbackList(props: {
  rows: FeedbackItem[] | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onOpen?: (row: FeedbackItem) => void;
  showUseCase?: boolean;
  empty: ReactNode;
}) {
  return (
    <Table
      rows={props.rows}
      loading={props.loading}
      error={props.error}
      onRetry={props.onRetry}
      rowKey={(r) => r.id}
      empty={props.empty}
      columns={[
        { key: "at", header: "Received", render: (r) => fmtAt(r.createdAt), sort: (r) => r.createdAt },
        ...(props.showUseCase === false
          ? []
          : [{ key: "uc", header: "Use case", render: (r: FeedbackItem) => r.useCaseName ?? <IdChip id={r.useCaseId} /> }]),
        { key: "kind", header: "Kind", render: (r) => `${KIND_LABEL[r.kind]}${r.channel === "signed_link" ? " (link)" : ""}` },
        { key: "status", header: "Status", render: (r) => <FeedbackStatusBadge status={r.status} /> },
        { key: "sla", header: "Response time", render: (r) => <SlaChip sla={r.sla} />, sort: (r) => r.sla.dueAt ?? "9" },
        {
          key: "owner",
          header: "Owner",
          render: (r) => (r.ownerUserId ? (r.ownerName ?? <IdChip id={r.ownerUserId} />) : <span className={v.faint}>admins</span>),
        },
        ...(props.onOpen
          ? [
              {
                key: "open",
                header: "",
                render: (r: FeedbackItem) => (
                  <Button size="sm" aria-label={`Open ${KIND_LABEL[r.kind].toLowerCase()} received ${fmtAt(r.createdAt)}`} onClick={() => props.onOpen!(r)}>
                    Open
                  </Button>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

const SEVERITIES = ["low", "medium", "high", "critical"] as const;

/** one item, opened: an audited read of what the person wrote, and the answer */
export function FeedbackDetail(props: { id: string | null; onClose: () => void }) {
  const { auth } = useSession();
  const act = useAction();
  const q = useQuery({
    queryKey: ["feedback", "item", props.id],
    queryFn: () => api.get<FeedbackDetailView>(`/v1/feedback/${props.id}`),
    enabled: !!props.id,
    // every open is an audited read: do not re-read on focus
    refetchOnWindowFocus: false,
  });
  const d = q.data;
  const [status, setStatus] = useState<string>("");
  const [note, setNote] = useState("");
  const [owner, setOwner] = useState("");
  const [incTitle, setIncTitle] = useState("");
  const [incSeverity, setIncSeverity] = useState<string>("medium");
  const isAdmin = !!auth?.isAdmin;
  // only an admin reassigns, and only an admin may list the users
  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => api.get<{ users: AdminUser[] }>("/v1/users"),
    enabled: isAdmin && !!props.id,
  });
  const resolving = RESOLVED.includes(status as FeedbackStatus);
  const statusOptions: FeedbackStatus[] = d
    ? (["acknowledged", "in_review", ...(d.kind === "appeal" ? (["upheld", "overturned"] as const) : []), "no_change", "rejected"] as FeedbackStatus[])
    : [];
  const final = d ? RESOLVED.includes(d.status) : false;

  const close = () => {
    setStatus("");
    setNote("");
    setOwner("");
    setIncTitle("");
    props.onClose();
  };
  const save = () =>
    void act
      .run(async () => {
        await api.patch(`/v1/feedback/${props.id}`, {
          ...(status ? { status } : {}),
          ...(note.trim() ? { resolutionNote: note.trim() } : {}),
          ...(owner ? { ownerUserId: owner } : {}),
        });
        await q.refetch();
      }, "Answer saved. It is recorded in the audit trail.")
      .then((ok) => {
        if (ok) {
          setStatus("");
          setOwner("");
        }
      });
  const openIncident = () =>
    void act.run(async () => {
      const r = await api.post<{ incidentId: string }>(`/v1/feedback/${props.id}/open-incident`, { title: incTitle.trim(), severity: incSeverity });
      await q.refetch();
      return `Incident opened and linked (${r.incidentId.slice(0, 8)}).`;
    });

  return (
    <Modal open={!!props.id} title={d ? `${KIND_LABEL[d.kind]} on ${d.useCaseName ?? "a use case"}` : "Feedback"} onClose={close} wide>
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {d && (
          <div className={v.stack}>
            <p className={v.hint}>Opening an item is recorded in the audit trail, with who opened it.</p>
            <div className={v.row}>
              <FeedbackStatusBadge status={d.status} />
              <SlaChip sla={d.sla} />
              <span className={v.faint}>received {fmtAt(d.createdAt)}</span>
            </div>
            <section aria-label="What the person wrote">
              <h3 className={v.sectionTitle}>What they wrote</h3>
              {d.body !== null ? (
                <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} data-testid="feedback-body">
                  {d.body}
                </p>
              ) : (
                <p className={v.faint}>
                  {d.bodyUnavailable === "purged"
                    ? `Deleted after the retention period (${d.bodyPurgedAt ? fmtAt(d.bodyPurgedAt) : ""}). The resolution record is kept.`
                    : d.bodyUnavailable === "no_data_key"
                      ? "This gateway has no data key, so the text cannot be opened."
                      : "The text could not be opened with this gateway's data key."}
                </p>
              )}
              {d.contact !== null && (
                <p>
                  <span className={v.faint}>How to reach them: </span>
                  <span style={{ overflowWrap: "anywhere" }}>{d.contact}</span>
                </p>
              )}
              {d.traceId && (
                <p className={v.faint}>
                  Cites trace <IdChip id={d.traceId} />
                  {d.spanId ? (
                    <>
                      {" "}
                      span <IdChip id={d.spanId} />
                    </>
                  ) : null}
                </p>
              )}
            </section>

            {final ? (
              <Card title="Resolution">
                <p style={{ whiteSpace: "pre-wrap" }}>{d.resolutionNote}</p>
                <p className={v.faint}>Resolved {d.resolvedAt ? fmtAt(d.resolvedAt) : ""}. The record is final.</p>
              </Card>
            ) : (
              <Card title="Answer">
                <div className={v.stack}>
                  {d.sodConflict && (
                    <p role="note" className={v.hint}>
                      {d.sodConflict === "contested_decision_maker"
                        ? "You made the decision this appeal contests, so you cannot decide it. Reassign it, or leave it to another person."
                        : "You filed this appeal, so someone else must decide it."}
                    </p>
                  )}
                  <div className={v.row}>
                    <Field label="Status">
                      <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                        <option value="">keep {STATUS_LABEL[d.status].toLowerCase()}</option>
                        {statusOptions
                          .filter((s) => s !== d.status)
                          .map((s) => (
                            <option key={s} value={s} disabled={RESOLVED.includes(s) && !d.youMayResolve}>
                              {STATUS_LABEL[s]}
                            </option>
                          ))}
                      </Select>
                    </Field>
                    {isAdmin && (
                      <Field label="Reassign to">
                        <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
                          <option value="">keep the current owner</option>
                          {(users.data?.users ?? [])
                            .filter((u) => u.id !== d.ownerUserId && !u.disabledAt)
                            .map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.displayName}
                              </option>
                            ))}
                        </Select>
                      </Field>
                    )}
                  </div>
                  <Field label={resolving ? "Resolution (required)" : "Resolution note"} grow>
                    <Textarea rows={4} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
                  </Field>
                  <div>
                    <Button variant="primary" disabled={act.busy || (!status && !note.trim() && !owner) || (resolving && !note.trim())} onClick={save}>
                      Save answer
                    </Button>
                  </div>
                </div>
              </Card>
            )}

            <Card title="Incident">
              {d.incidentId ? (
                <p>
                  Linked to <Link to={`/incidents/${d.incidentId}`}>incident {d.incidentId.slice(0, 8)}</Link>.
                </p>
              ) : (
                <div className={v.row}>
                  <Field label="Incident title" grow>
                    <Input value={incTitle} maxLength={200} onChange={(e) => setIncTitle(e.target.value)} />
                  </Field>
                  <Field label="Severity">
                    <Select value={incSeverity} onChange={(e) => setIncSeverity(e.target.value)}>
                      {SEVERITIES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="&nbsp;">
                    <Button disabled={act.busy || !incTitle.trim()} onClick={openIncident}>
                      Open incident
                    </Button>
                  </Field>
                </div>
              )}
            </Card>
          </div>
        )}
      </QueryGate>
    </Modal>
  );
}

// ---- the admin settings -----------------------------------------------------

interface FeedbackSettingValues {
  feedbackSignedLinksEnabled: boolean;
  feedbackAckSlaHours: number;
  feedbackResolveSlaDays: number;
  feedbackRetentionDays: number;
}
type SettingKey = keyof FeedbackSettingValues;
/** mirrors ACCOUNTABILITY_STRICT_DEFAULTS / _SETTING_COPY / _SETTING_LIMITS in @regulait/shared (accountability.ts) */
const STRICT: FeedbackSettingValues = {
  feedbackSignedLinksEnabled: false,
  feedbackAckSlaHours: 72,
  feedbackResolveSlaDays: 30,
  feedbackRetentionDays: 365,
};
const COPY: Record<SettingKey, { label: string; strict: string; relaxed: string; min?: number; max?: number }> = {
  feedbackSignedLinksEnabled: {
    label: "Public signed feedback links",
    strict: "Off: only signed-in users can report a problem or appeal a decision.",
    relaxed:
      "On lets a use-case owner or an admin mint a link (at most 30 days, limited uses) that people outside the organisation can use without signing in.",
  },
  feedbackAckSlaHours: {
    label: "Feedback acknowledgement time (hours)",
    strict: "72 hours from receipt to acknowledgement; a breach alerts the owner and the admins.",
    relaxed: "A longer time (up to 168 hours) lets a report wait longer before anyone is alerted.",
    min: 1,
    max: 168,
  },
  feedbackResolveSlaDays: {
    label: "Feedback resolution time (days)",
    strict: "30 days from receipt to resolution; a breach alerts the owner and the admins.",
    relaxed: "A longer time (up to 90 days) lets a report or appeal stay open longer before anyone is alerted.",
    min: 1,
    max: 90,
  },
  feedbackRetentionDays: {
    label: "Feedback body retention (days)",
    strict: "365 days: the text and contact details are deleted after a year; the resolution record is kept.",
    relaxed: "A longer retention (up to 2555 days) keeps what people wrote, and how to reach them, for longer.",
    min: 30,
    max: 2555,
  },
};
const NUMERIC: Array<Exclude<SettingKey, "feedbackSignedLinksEnabled">> = ["feedbackAckSlaHours", "feedbackResolveSlaDays", "feedbackRetentionDays"];
const isRelaxed = (k: SettingKey, val: unknown) => (k === "feedbackSignedLinksEnabled" ? val === true : Number(val) > (STRICT[k] as number));

export function FeedbackSettings() {
  const act = useAction();
  const q = useQuery({
    queryKey: ["admin", "org-settings", "feedback"],
    queryFn: () => api.get<{ settings: Partial<FeedbackSettingValues> }>("/v1/org/settings"),
  });
  const current: FeedbackSettingValues = { ...STRICT, ...(q.data?.settings ?? {}) };
  const [draft, setDraft] = useState<Partial<Record<SettingKey, string | boolean>>>({});
  const value = <K extends SettingKey>(k: K) => (draft[k] !== undefined ? draft[k] : current[k]);
  const changed: Partial<FeedbackSettingValues> = {};
  let valid = true;
  for (const k of Object.keys(STRICT) as SettingKey[]) {
    const raw = draft[k];
    if (raw === undefined) continue;
    if (k === "feedbackSignedLinksEnabled") {
      if (raw !== current[k]) changed[k] = raw as boolean;
      continue;
    }
    const n = Number(raw);
    const c = COPY[k];
    if (!Number.isInteger(n) || n < (c.min ?? 1) || n > (c.max ?? 1e9)) valid = false;
    else if (n !== current[k]) (changed as Record<string, number>)[k] = n;
  }
  const dirty = Object.keys(changed).length > 0;
  const save = () =>
    void act
      .run(async () => {
        await api.put("/v1/org/settings", changed);
        await q.refetch();
      }, "Feedback settings saved. Each change is recorded in the audit trail, and a relaxation is named as one.")
      .then((ok) => ok && setDraft({}));

  return (
    <Card title="Feedback settings (admin)">
      <span id="settings" />
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        <div className={v.stack}>
          <p className={v.hint}>
            Every setting starts at its strict value. Relaxing one is allowed and is recorded in the audit trail as a relaxation.
          </p>
          <div className={v.stackTight}>
            <label className={v.row}>
              <input
                type="checkbox"
                checked={value("feedbackSignedLinksEnabled") as boolean}
                onChange={(e) => setDraft({ ...draft, feedbackSignedLinksEnabled: e.target.checked })}
              />
              <span>{COPY.feedbackSignedLinksEnabled.label}</span>
              {isRelaxed("feedbackSignedLinksEnabled", current.feedbackSignedLinksEnabled) ? <Badge tone="warn">relaxed</Badge> : <Badge tone="ok">strict default</Badge>}
            </label>
            <p className={v.faint}>
              {current.feedbackSignedLinksEnabled ? COPY.feedbackSignedLinksEnabled.relaxed : COPY.feedbackSignedLinksEnabled.strict}
            </p>
          </div>
          {NUMERIC.map((k) => (
            <div key={k} className={v.stackTight}>
              <div className={v.row}>
                <Field label={COPY[k].label}>
                  <Input
                    type="number"
                    min={COPY[k].min}
                    max={COPY[k].max}
                    value={String(value(k))}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                  />
                </Field>
                {isRelaxed(k, current[k]) ? <Badge tone="warn">relaxed</Badge> : <Badge tone="ok">strict default</Badge>}
                <span className={v.faint}>strict default {STRICT[k]}</span>
              </div>
              <p className={v.faint}>{isRelaxed(k, current[k]) ? COPY[k].relaxed : COPY[k].strict}</p>
            </div>
          ))}
          <div>
            <Button variant="primary" disabled={act.busy || !dirty || !valid} onClick={save}>
              Save feedback settings
            </Button>{" "}
            <Button variant="ghost" disabled={act.busy} onClick={() =>
                setDraft({
                  feedbackSignedLinksEnabled: STRICT.feedbackSignedLinksEnabled,
                  feedbackAckSlaHours: String(STRICT.feedbackAckSlaHours),
                  feedbackResolveSlaDays: String(STRICT.feedbackResolveSlaDays),
                  feedbackRetentionDays: String(STRICT.feedbackRetentionDays),
                })
              }>
              Back to the strict defaults
            </Button>
          </div>
          {!valid && <p role="alert" className={v.errLine}>A number is outside its allowed range.</p>}
        </div>
      </QueryGate>
    </Card>
  );
}

export function NothingHere(props: { title: string; body: string }) {
  return <EmptyState title={props.title} body={props.body} />;
}
