/**
 * Retiring a use case, with the reason the audit log records. One form, used
 * in the registry's preview drawer and behind the registry row's Retire
 * (G11), so both ask the same thing and post the same route.
 */
import { useState, type ReactNode } from "react";
import { api } from "../../../api/client";
import { Button, Field, Input, Modal } from "../../../ui/kit";
import { useAction } from "../adminKit";
import v from "../../views.module.css";

type Action = ReturnType<typeof useAction>;

export function RetireUseCaseForm(props: { id: string; act: Action; onRetired: () => Promise<unknown>; extra?: ReactNode }) {
  const [reason, setReason] = useState("");
  const { act } = props;
  return (
    <div className={v.stack}>
      <Field label="Reason for retiring (recorded in the audit log)">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Superseded by a narrower use case" />
      </Field>
      <div className={v.row}>
        <Button
          variant="danger"
          size="sm"
          disabled={act.busy || !reason.trim()}
          onClick={() =>
            void act.run(async () => {
              await api.post(`/v1/use-cases/${props.id}/retire`, { reason: reason.trim() });
              setReason("");
              await props.onRetired();
            }, "Use case retired")
          }
        >
          Retire use case
        </Button>
        {props.extra}
      </div>
    </div>
  );
}

/** the registry row's Retire: the same form in a dialog that names the use case */
export function RetireUseCaseDialog(props: { id: string; name: string; onClose: () => void; onRetired: () => Promise<unknown> }) {
  const act = useAction();
  return (
    <Modal open title={`Retire ${props.name}?`} onClose={props.onClose}>
      <RetireUseCaseForm
        id={props.id}
        act={act}
        onRetired={async () => {
          await props.onRetired();
          props.onClose();
        }}
        extra={<Button size="sm" onClick={props.onClose}>Cancel</Button>}
      />
    </Modal>
  );
}
