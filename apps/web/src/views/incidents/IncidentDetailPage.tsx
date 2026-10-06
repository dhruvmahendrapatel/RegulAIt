/**
 * ADR-0182 (ADR-0175 batch D4) A12 — one AI incident: its facts, the
 * notification clocks (each with the cited text), the timeline, links,
 * corrective actions, containment, closing and the export.
 *
 * Who can do what is the server's decision; this page shows controls by the
 * `permissions` the detail carries (the incident's owner or an admin edits;
 * setting a clock aside, containment and the export are an admin's).
 */
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { DirectoryUser } from "../../api/types";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Fieldset, Input, Modal, Select, SeverityBadge, Table, Textarea } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import { KV, QueryGate, ReasonModal, downloadCsv, useAction } from "../admin/adminKit";
import v from "../views.module.css";
import a from "../admin/admin.module.css";
import {
  CLOCK_DISCLAIMER,
  CRITERIA,
  CRITERION_LABEL,
  DETECTION_LABEL,
  LINK_LABEL,
  LINK_TYPES,
  NOTIFICATION_LABEL,
  NOTIFICATION_TONE,
  SEVERITIES,
  STATUS_TONE,
  URGENCY_LABEL,
  URGENCY_TONE,
  eventSentence,
  impliesSerious,
  localInputToIso,
  utc,
  type IncidentClock,
  type IncidentDetail,
} from "./incidentModel";

const ROW = { display: "flex", gap: "var(--s2)", alignItems: "center", minHeight: 32 } as const;
const BOX = { width: 18, height: 18, margin: 0, flex: "none" } as const;
const QUOTE = { margin: "var(--s1) 0", paddingLeft: "var(--s2)", borderLeft: "3px solid var(--border, currentColor)" } as const;

function EditModal(props: { open: boolean; d: IncidentDetail; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const directory = useQuery({ queryKey: ["directory"], queryFn: () => api.get<{ users: DirectoryUser[] }>("/v1/users/directory"), enabled: props.open });
  const i = props.d.incident;
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [title, setTitle] = useState(i.title);
  const [summary, setSummary] = useState(i.summary);
  const [severity, setSeverity] = useState(i.severity);
  const [status, setStatus] = useState(i.status === "closed" ? "resolved" : i.status);
  const [serious, setSerious] = useState(i.serious);
  const [criteria, setCriteria] = useState<string[]>(i.seriousCriteria);
  const [phi, setPhi] = useState(i.phiIndividuals !== null ? String(i.phiIndividuals) : "");
  const [owner, setOwner] = useState(i.ownerUserId ?? "");
  const key = props.open ? `${i.id}:${i.ref}` : null;
  if (key !== lastKey) {
    setLastKey(key);
    setTitle(i.title);
    setSummary(i.summary);
    setSeverity(i.severity);
    setStatus(i.status === "closed" ? "resolved" : i.status);
    setSerious(i.serious);
    setCriteria(i.seriousCriteria);
    setPhi(i.phiIndividuals !== null ? String(i.phiIndividuals) : "");
    setOwner(i.ownerUserId ?? "");
  }
  const toggle = (id: string) => setCriteria((cs) => (cs.includes(id) ? cs.filter((c) => c !== id) : [...cs, id]));
  const body = () => ({
    title: title.trim(),
    summary: summary.trim(),
    severity,
    status,
    serious: serious || impliesSerious(criteria),
    seriousCriteria: criteria,
    phiIndividuals: criteria.includes("phi_breach") && phi.trim() ? Number(phi) : null,
    ...(owner && owner !== i.ownerUserId ? { ownerUserId: owner } : {}),
  });
  return (
    <Modal
      open={props.open}
      wide
      title={`Edit ${i.ref}`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={act.busy || !title.trim()}
            onClick={() =>
              void act.run(() => api.patch(`/v1/incidents/${i.id}`, body()), `${i.ref} saved`).then((ok) => {
                if (ok) {
                  props.onSaved();
                  props.onClose();
                }
              })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <p className={v.faint}>
          Lowering the severity below high, un-marking an incident serious or moving it off its use case releases the deploy gate, so only an admin
          may do it; the change is audited. Clocks already started are never removed.
        </p>
        <div className={a.formRow}>
          <Field label="Title" grow>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Severity">
            <Select value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="open">Open</option>
              <option value="contained">Contained</option>
              <option value="resolved">Resolved</option>
            </Select>
          </Field>
        </div>
        <Field label="What happened">
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} maxLength={8000} />
        </Field>
        <Field label="Owner">
          <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Unassigned</option>
            {(directory.data?.users ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ?? u.id}
              </option>
            ))}
          </Select>
        </Field>
        <Fieldset legend="Is it serious?">
          {CRITERIA.map((c) => (
            <div key={c.id} style={ROW}>
              <input type="checkbox" style={BOX} id={`inc-edit-crit-${c.id}`} checked={criteria.includes(c.id)} onChange={() => toggle(c.id)} />
              <label htmlFor={`inc-edit-crit-${c.id}`}>
                {c.label} <span className={v.faint}>· {c.cite}</span>
              </label>
            </div>
          ))}
          <div style={ROW}>
            <input type="checkbox" style={BOX} id="inc-edit-serious" checked={serious || impliesSerious(criteria)} disabled={impliesSerious(criteria)} onChange={(e) => setSerious(e.target.checked)} />
            <label htmlFor="inc-edit-serious">Serious incident (EU AI Act)</label>
          </div>
          {criteria.includes("phi_breach") && (
            <Field label="Individuals affected (if known)">
              <Input type="number" min={0} value={phi} onChange={(e) => setPhi(e.target.value)} placeholder="unknown" />
            </Field>
          )}
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

function CloseModal(props: { open: boolean; d: IncidentDetail; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const [rootCause, setRootCause] = useState(props.d.incident.rootCause ?? "");
  const [lessons, setLessons] = useState(props.d.incident.lessonsLearned ?? "");
  const openClocks = props.d.notifications.filter((n) => n.status === "pending" || n.status === "sent_initial");
  return (
    <Modal
      open={props.open}
      wide
      title={`Close ${props.d.incident.ref}`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={act.busy || !rootCause.trim() || !lessons.trim() || openClocks.length > 0}
            onClick={() =>
              void act
                .run(() => api.post(`/v1/incidents/${props.d.incident.id}/close`, { rootCause: rootCause.trim(), lessonsLearned: lessons.trim() }), `${props.d.incident.ref} closed`)
                .then((ok) => {
                  if (ok) {
                    props.onSaved();
                    props.onClose();
                  }
                })
            }
          >
            Close incident
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        {openClocks.length > 0 && (
          <div className={v.errLine} role="alert">
            {openClocks.length} notification clock(s) are not final: record the complete report, or an admin marks them not required or tolled
            with a reason.
          </div>
        )}
        <Field label="Root cause">
          <Textarea value={rootCause} onChange={(e) => setRootCause(e.target.value)} rows={3} maxLength={8000} />
        </Field>
        <Field label="Lessons learned">
          <Textarea value={lessons} onChange={(e) => setLessons(e.target.value)} rows={3} maxLength={8000} />
        </Field>
        <p className={v.faint}>A closed incident is final. Both texts are kept with the record and in its export.</p>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ContainModal(props: { open: boolean; d: IncidentDetail; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const registry = props.d.links.filter((l) => l.objectType === "agent" && l.agentKind === "registry");
  const [agentId, setAgentId] = useState("");
  const [reason, setReason] = useState("");
  const chosen = agentId || registry[0]?.objectId || "";
  return (
    <Modal
      open={props.open}
      title={`Contain ${props.d.incident.ref}`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={act.busy || !chosen || reason.trim().length < 10}
            onClick={() =>
              void act.run(() => api.post(`/v1/incidents/${props.d.incident.id}/contain`, { agentId: chosen, reason: reason.trim() }), "Agent halted").then((ok) => {
                if (ok) {
                  props.onSaved();
                  props.onClose();
                }
              })
            }
          >
            Halt agent
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <p className={v.faint}>
          Halting refuses every dispatch to the agent at once. The halt is lifted from the execution-control page, not here.
        </p>
        {registry.length > 0 ? (
          <Field label="Agent">
            <Select value={chosen} onChange={(e) => setAgentId(e.target.value)}>
              {registry.map((l) => (
                <option key={l.objectId} value={l.objectId}>
                  {l.label ?? l.objectId}
                  {l.halted ? " (already halted)" : ""}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Agent id" help="No registry agent is linked yet; the agent you halt is linked to the incident.">
            <Input value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="agent id" />
          </Field>
        )}
        <Field label="Reason (at least 10 characters, audited)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
      </div>
    </Modal>
  );
}

function SentModal(props: { clock: IncidentClock | null; stage: "initial" | "complete"; incidentId: string; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [reference, setReference] = useState("");
  const [sentAt, setSentAt] = useState("");
  const key = props.clock ? `${props.clock.id}:${props.stage}` : null;
  if (key !== lastKey) {
    setLastKey(key);
    setRecipient(props.clock?.recipient ?? "");
    setReference(props.clock?.reference ?? "");
    setSentAt("");
  }
  const c = props.clock;
  return (
    <Modal
      open={c !== null}
      title={props.stage === "initial" ? "Record the initial report" : "Record the report as sent"}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={act.busy || !recipient.trim()}
            onClick={() =>
              void act
                .run(
                  () =>
                    api.post(`/v1/incidents/${props.incidentId}/notifications/${c!.id}/sent`, {
                      stage: props.stage,
                      recipient: recipient.trim(),
                      ...(reference.trim() ? { reference: reference.trim() } : {}),
                      ...(localInputToIso(sentAt) ? { sentAt: localInputToIso(sentAt) } : {}),
                    }),
                  "Report recorded",
                )
                .then((ok) => {
                  if (ok) {
                    props.onSaved();
                    props.onClose();
                  }
                })
            }
          >
            Record
          </Button>
        </>
      }
    >
      {c && (
        <div className={v.stack}>
          <p>{c.paragraph}</p>
          {props.stage === "initial" && (
            <p className={v.faint}>Article 73(5): an incomplete initial report may be sent first, followed by the complete report.</p>
          )}
          <Field label="Sent to">
            <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} maxLength={500} />
          </Field>
          <Field label="Reference (optional)" help="The authority's case number, a ticket or a letter reference.">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={500} />
          </Field>
          <Field label="Sent at (local time; empty = now)">
            <Input type="datetime-local" value={sentAt} onChange={(e) => setSentAt(e.target.value)} />
          </Field>
          {act.error && (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function ClocksCard(props: { d: IncidentDetail; refetch: () => void }) {
  const act = useAction();
  const [sending, setSending] = useState<{ clock: IncidentClock; stage: "initial" | "complete" } | null>(null);
  const [aside, setAside] = useState<{ clock: IncidentClock; kind: "not-required" | "toll" } | null>(null);
  const { d } = props;
  const canEdit = d.permissions.canEdit;
  return (
    <Card title="Notification clocks">
      <p className={v.faint}>{CLOCK_DISCLAIMER}</p>
      {d.notifications.length === 0 ? (
        <EmptyState
          title="No clocks"
          body="No notification clock applies: the incident is not marked serious on a high-tier or unscreened use case, and lists no PHI breach (or the org turned that regime off)."
        />
      ) : (
        <div className={v.stack}>
          {d.notifications.map((c) => (
            <div key={c.id} className={v.stackTight} data-testid={`clock-${c.clockId}`} style={{ borderTop: "1px solid var(--border, transparent)", paddingTop: "var(--s2)" }}>
              <div className={v.row} style={{ flexWrap: "wrap", gap: "var(--s1)" }}>
                <strong>{c.paragraph}</strong>
                <Badge tone={NOTIFICATION_TONE[c.status]}>{NOTIFICATION_LABEL[c.status]}</Badge>
                <Badge tone={URGENCY_TONE[c.urgency]}>{URGENCY_LABEL[c.urgency]}</Badge>
              </div>
              <span>
                Due {c.immediately ? <>immediately — no numeric limit in the text (counted from {utc(c.clockStart)})</> : <>{utc(c.dueAt)} ({c.period}, from {utc(c.clockStart)})</>}
              </span>
              {c.recipient && <span className={v.faint}>To: {c.recipient}</span>}
              {c.caveat && <span className={v.faint}>{c.caveat}</span>}
              {c.sentAt && (
                <span className={v.faint}>
                  Sent {utc(c.sentAt)}
                  {c.sentByName ? ` by ${c.sentByName}` : ""}
                  {c.reference ? ` · ref ${c.reference}` : ""}
                </span>
              )}
              {c.reason && <span className={v.faint}>Reason: {c.reason}</span>}
              {c.quote && (
                <details>
                  <summary>The cited text</summary>
                  <blockquote style={QUOTE}>{c.quote}</blockquote>
                  <span className={v.faint}>
                    {c.sourceUrl ? (
                      <a href={c.sourceUrl} target="_blank" rel="noreferrer">
                        Source
                      </a>
                    ) : null}{" "}
                    · retrieved {c.retrievedOn}
                  </span>
                </details>
              )}
              {canEdit && (c.status === "pending" || c.status === "sent_initial") && (
                <div className={v.row} style={{ flexWrap: "wrap", gap: "var(--s1)" }}>
                  {c.allowsInitialReport && c.status === "pending" && (
                    <Button size="sm" onClick={() => setSending({ clock: c, stage: "initial" })} aria-label={`Record the initial report for ${c.clockId}`}>
                      Initial report sent…
                    </Button>
                  )}
                  <Button size="sm" variant="primary" onClick={() => setSending({ clock: c, stage: "complete" })} aria-label={`Record the report for ${c.clockId}`}>
                    Report sent…
                  </Button>
                  {d.permissions.isAdmin && (
                    <>
                      <Button size="sm" onClick={() => setAside({ clock: c, kind: "not-required" })} aria-label={`Mark ${c.clockId} not required`}>
                        Not required…
                      </Button>
                      <Button size="sm" onClick={() => setAside({ clock: c, kind: "toll" })} aria-label={`Toll ${c.clockId}`}>
                        Toll…
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <SentModal clock={sending?.clock ?? null} stage={sending?.stage ?? "complete"} incidentId={d.incident.id} onClose={() => setSending(null)} onSaved={props.refetch} />
      <ReasonModal
        open={aside !== null}
        title={aside?.kind === "toll" ? "Toll this clock" : "Mark this clock not required"}
        minLength={10}
        confirmLabel={aside?.kind === "toll" ? "Toll" : "Not required"}
        body={
          <p className={v.faint}>
            {aside?.kind === "toll"
              ? "Tolling records that the notice is lawfully delayed (for example a law-enforcement request under 45 CFR 164.412). The clock stays on the record."
              : "Record why this notification does not apply. The clock stays on the record with your reason; it is never deleted."}{" "}
            {aside?.clock.paragraph}
          </p>
        }
        onCancel={() => setAside(null)}
        onConfirm={(reason) => {
          const target = aside!;
          setAside(null);
          void act.run(() => api.post(`/v1/incidents/${d.incident.id}/notifications/${target.clock.id}/${target.kind}`, { reason }), "Clock set aside").then(() => props.refetch());
        }}
      />
    </Card>
  );
}

function TimelineCard(props: { d: IncidentDetail; refetch: () => void }) {
  const act = useAction();
  const [note, setNote] = useState("");
  return (
    <Card title="Timeline">
      <ol className={v.stackTight} style={{ paddingLeft: "var(--s3)", margin: 0 }}>
        {props.d.events.map((e) => (
          <li key={e.id}>
            <span className={v.faint}>{utc(e.at)}</span> · {eventSentence(e)}
            {e.actorName ? <span className={v.faint}> · {e.actorName}</span> : null}
            {e.note ? <div style={{ whiteSpace: "pre-wrap" }}>{e.note}</div> : null}
          </li>
        ))}
      </ol>
      {props.d.permissions.canEdit && (
        <div className={a.formRow} style={{ marginTop: "var(--s2)", alignItems: "flex-end" }}>
          <Field label="Add a note" grow>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={8000} />
          </Field>
          <Button
            disabled={act.busy || !note.trim()}
            onClick={() =>
              void act.run(() => api.post(`/v1/incidents/${props.d.incident.id}/events`, { note: note.trim() }), "Note added").then((ok) => {
                if (ok) {
                  setNote("");
                  props.refetch();
                }
              })
            }
          >
            Add note
          </Button>
        </div>
      )}
    </Card>
  );
}

function LinksCard(props: { d: IncidentDetail; refetch: () => void }) {
  const act = useAction();
  const [type, setType] = useState("agent");
  const [id, setId] = useState("");
  return (
    <Card title="Linked records">
      <Table
        rows={props.d.links}
        rowKey={(l) => `${l.objectType}:${l.objectId}`}
        empty={<EmptyState title="Nothing linked" body="Link the agent, model, alert or run involved. A linked agent is what the evidence hold protects." />}
        columns={[
          { key: "type", header: "Kind", render: (l) => LINK_LABEL[l.objectType] ?? l.objectType },
          { key: "id", header: "Record", render: (l) => <span>{l.label ?? <code>{l.objectId}</code>}</span> },
          { key: "state", header: "", render: (l) => (l.halted ? <Badge tone="danger">halted</Badge> : null) },
        ]}
      />
      {props.d.permissions.canEdit && (
        <div className={a.formRow} style={{ marginTop: "var(--s2)", alignItems: "flex-end" }}>
          <Field label="Link kind">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {LINK_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Record id" grow>
            <Input value={id} onChange={(e) => setId(e.target.value)} maxLength={200} />
          </Field>
          <Button
            disabled={act.busy || !id.trim()}
            onClick={() =>
              void act.run(() => api.post(`/v1/incidents/${props.d.incident.id}/links`, { objectType: type, objectId: id.trim() }), "Linked").then((ok) => {
                if (ok) {
                  setId("");
                  props.refetch();
                }
              })
            }
          >
            Link
          </Button>
        </div>
      )}
    </Card>
  );
}

function ActionsCard(props: { d: IncidentDetail; refetch: () => void }) {
  const act = useAction();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [finishing, setFinishing] = useState<string | null>(null);
  return (
    <Card title="Corrective actions">
      <Table
        rows={props.d.actions}
        rowKey={(x) => x.id}
        empty={<EmptyState title="No corrective actions" body="Add what has to change so this does not happen again, with an owner and a due date." />}
        columns={[
          { key: "title", header: "Action", render: (x) => x.title },
          { key: "owner", header: "Owner", render: (x) => x.ownerName ?? <span className={v.faint}>unassigned</span> },
          { key: "due", header: "Due", render: (x) => (x.dueAt ? <span>{utc(x.dueAt)} {x.overdue && <Badge tone="danger">overdue</Badge>}</span> : "—") },
          { key: "status", header: "Status", render: (x) => <Badge tone={x.status === "done" ? "ok" : x.status === "cancelled" ? "neutral" : "warn"}>{x.status}</Badge> },
          { key: "evidence", header: "Evidence", render: (x) => x.evidenceRef ?? "—" },
          {
            key: "act",
            header: "",
            render: (x) =>
              props.d.permissions.canEdit && x.status === "open" ? (
                <Button size="sm" onClick={() => setFinishing(x.id)} aria-label={`Mark ${x.title} done`}>
                  Done…
                </Button>
              ) : null,
          },
        ]}
      />
      {props.d.permissions.canEdit && (
        <div className={a.formRow} style={{ marginTop: "var(--s2)", alignItems: "flex-end" }}>
          <Field label="New action" grow>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} />
          </Field>
          <Field label="Due (local time)">
            <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
          <Button
            disabled={act.busy || !title.trim()}
            onClick={() =>
              void act
                .run(() => api.post(`/v1/incidents/${props.d.incident.id}/actions`, { title: title.trim(), ...(localInputToIso(due) ? { dueAt: localInputToIso(due) } : {}) }), "Action added")
                .then((ok) => {
                  if (ok) {
                    setTitle("");
                    setDue("");
                    props.refetch();
                  }
                })
            }
          >
            Add action
          </Button>
        </div>
      )}
      <ReasonModal
        open={finishing !== null}
        title="Mark the action done"
        placeholder="evidence: a PR, a ticket, a document (required)"
        confirmLabel="Done"
        onCancel={() => setFinishing(null)}
        onConfirm={(evidenceRef) => {
          const id = finishing!;
          setFinishing(null);
          void act.run(() => api.patch(`/v1/incidents/${props.d.incident.id}/actions/${id}`, { status: "done", evidenceRef }), "Action done").then(() => props.refetch());
        }}
      />
    </Card>
  );
}

export default function IncidentDetailPage() {
  const { incidentId = "" } = useParams();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["incidents", "detail", incidentId], queryFn: () => api.get<IncidentDetail>(`/v1/incidents/${incidentId}`) });
  const [editing, setEditing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [containing, setContaining] = useState(false);
  const refetch = () => void q.refetch();
  const d = q.data;
  const i = d?.incident;
  return (
    <>
      <PageHeader
        title={i ? `${i.ref} · ${i.title}` : "AI incident"}
        crumbs={["AI incidents"]}
        sub={
          i ? (
            <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <SeverityBadge severity={i.severity} />
              {i.serious && <Badge tone="danger">serious</Badge>}
              <Badge tone={STATUS_TONE[i.status]}>{i.status}</Badge>
              <Link to="/incidents">All incidents</Link>
            </span>
          ) : (
            "The incident's timeline, links, actions and notification clocks."
          )
        }
        actions={
          d ? (
            <div className={v.row} style={{ flexWrap: "wrap", gap: "var(--s1)" }}>
              {d.permissions.canEdit && <Button onClick={() => setEditing(true)}>Edit</Button>}
              {d.permissions.canEdit && d.permissions.isAdmin && (
                <Button variant="danger" onClick={() => setContaining(true)}>
                  Contain…
                </Button>
              )}
              {d.permissions.canEdit && (
                <Button variant="primary" onClick={() => setClosing(true)}>
                  Close…
                </Button>
              )}
              {d.permissions.isAdmin && (
                <>
                  <Button onClick={() => void downloadCsv(`/v1/incidents/${d.incident.id}/export`, `incident-${d.incident.ref}.tar.gz`, (m) => toast(m, "error"))}>
                    Signed export
                  </Button>
                  <Button onClick={() => void downloadCsv(`/v1/incidents/${d.incident.id}/export?format=csv`, `incident-${d.incident.ref}-timeline.csv`, (m) => toast(m, "error"))}>
                    Timeline CSV
                  </Button>
                </>
              )}
            </div>
          ) : undefined
        }
      />
      <QueryGate loading={q.isLoading} error={q.error} onRetry={refetch}>
        {d && i && (
          <div className={v.stack}>
            {d.evidenceHold.binds && (
              <Card title="Evidence hold in force">
                <p>
                  Linked agents cannot be reconfigured until the report to the authority is recorded as sent. An admin may override one change at a
                  time with a reason; the override is audited and noted on this timeline.
                </p>
                <blockquote style={QUOTE}>{d.evidenceHold.quote}</blockquote>
                <span className={v.faint}>{d.evidenceHold.paragraph}</span>
              </Card>
            )}
            {d.gate.holds && (
              <p className={v.errLine} role="status">
                {d.gate.mode === "enforce" ? "This incident holds the use case's deploy gate" : "The deploy gate reports this incident as a warning"} until it is
                resolved.
              </p>
            )}
            <Card title="Facts">
              <KV
                rows={[
                  ["Detected by", DETECTION_LABEL[i.detectionSource] ?? i.detectionSource],
                  ...(i.sourceRef ? ([["Source reference", <code key="s">{i.sourceRef}</code>]] as Array<[string, ReactNode]>) : []),
                  ["Became aware", utc(i.awareAt)],
                  ["Occurred", utc(i.occurredAt)],
                  ["Owner", i.ownerName ?? "unassigned"],
                  ["Use case", d.useCase ? <Link key="u" to={`/admin/governance/use-cases/${d.useCase.id}`}>{d.useCase.name}</Link> : "none"],
                  ...(d.useCase
                    ? ([["EU AI Act", `${d.useCase.euAiActTier ? `${d.useCase.euAiActTier} tier` : "not screened"} · role ${d.useCase.euAiActRole}`]] as Array<[string, ReactNode]>)
                    : []),
                  ["Serious criteria", i.seriousCriteria.length ? i.seriousCriteria.map((c) => CRITERION_LABEL[c] ?? c).join("; ") : i.serious ? "serious (criteria not yet stated)" : "none"],
                  ...(i.phiIndividuals !== null ? ([["PHI individuals", String(i.phiIndividuals)]] as Array<[string, ReactNode]>) : []),
                  ["Reported by", `${i.createdByName ?? "unknown"} · ${utc(i.createdAt)}`],
                  ...(i.closedAt ? ([["Closed", `${utc(i.closedAt)}${i.closedByName ? ` by ${i.closedByName}` : ""}`]] as Array<[string, ReactNode]>) : []),
                ]}
              />
              {i.summary && <p style={{ whiteSpace: "pre-wrap" }}>{i.summary}</p>}
              {i.rootCause && (
                <>
                  <h3>Root cause</h3>
                  <p style={{ whiteSpace: "pre-wrap" }}>{i.rootCause}</p>
                </>
              )}
              {i.lessonsLearned && (
                <>
                  <h3>Lessons learned</h3>
                  <p style={{ whiteSpace: "pre-wrap" }}>{i.lessonsLearned}</p>
                </>
              )}
            </Card>
            <ClocksCard d={d} refetch={refetch} />
            <ActionsCard d={d} refetch={refetch} />
            <LinksCard d={d} refetch={refetch} />
            <TimelineCard d={d} refetch={refetch} />
          </div>
        )}
      </QueryGate>
      {d && (
        <>
          <EditModal open={editing} d={d} onClose={() => setEditing(false)} onSaved={refetch} />
          <CloseModal open={closing} d={d} onClose={() => setClosing(false)} onSaved={refetch} />
          <ContainModal open={containing} d={d} onClose={() => setContaining(false)} onSaved={refetch} />
        </>
      )}
    </>
  );
}
