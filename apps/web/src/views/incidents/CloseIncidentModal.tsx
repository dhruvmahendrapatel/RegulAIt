/**
 * Closing an incident: the root cause and lessons learned, refused while a
 * clock is not final or a corrective action is open, and an admin's for a
 * serious, high or critical incident (`permissions.canClose`). One dialog,
 * opened from the incident page and from the register's row (G11), which
 * loads the incident's detail first so the dialog judges the same facts.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { plural } from "../../api/format";
import { Button, Field, Modal, Textarea } from "../../ui/kit";
import { useAction } from "../admin/adminKit";
import v from "../views.module.css";
import type { IncidentDetail } from "./incidentModel";

export function CloseIncidentModal(props: { open: boolean; d: IncidentDetail; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const [rootCause, setRootCause] = useState(props.d.incident.rootCause ?? "");
  const [lessons, setLessons] = useState(props.d.incident.lessonsLearned ?? "");
  const openClocks = props.d.notifications.filter((n) => n.status === "pending" || n.status === "sent_initial");
  const openActions = props.d.actions.filter((x) => x.status === "open");
  const adminOnly = !props.d.permissions.canClose;
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
            disabled={act.busy || adminOnly || !rootCause.trim() || !lessons.trim() || openClocks.length > 0 || openActions.length > 0}
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
        {adminOnly && (
          <div className={v.errLine} role="alert">
            Closing a serious, high or critical incident releases the use case&apos;s deploy gate, so an admin closes it. You may mark it resolved
            (Edit), which releases nothing.
          </div>
        )}
        {openClocks.length > 0 && (
          <div className={v.errLine} role="alert">
            {plural(openClocks.length, "notification clock")} {openClocks.length === 1 ? "is" : "are"} not final: record the complete report, or an admin marks them not required or tolled
            with a reason.
          </div>
        )}
        {openActions.length > 0 && (
          <div className={v.errLine} role="alert">
            {plural(openActions.length, "corrective action")} {openActions.length === 1 ? "is" : "are"} still open: mark each done with its evidence, or cancel it with a reason.
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

/** the register row's Close: the incident page's own dialog, on the detail the incident page reads */
export function CloseIncidentFromList(props: { id: string; onClose: () => void; onSaved: () => void }) {
  const q = useQuery({ queryKey: ["incidents", "detail", props.id], queryFn: () => api.get<IncidentDetail>(`/v1/incidents/${props.id}`) });
  if (q.error)
    return (
      <Modal open title="Close incident" onClose={props.onClose} actions={<Button onClick={props.onClose}>Cancel</Button>}>
        <div className={v.errLine} role="alert">
          The incident could not be read, so it cannot be closed from here: {q.error instanceof Error ? q.error.message : String(q.error)}
        </div>
      </Modal>
    );
  if (!q.data) return null;
  return <CloseIncidentModal open d={q.data} onClose={props.onClose} onSaved={props.onSaved} />;
}
