/**
 * ADR-0190 I3 — revoking an executor, which is terminal: confirmed by typing
 * the executor's name, then audited by the gateway. One dialog and one call,
 * used by the executor's detail and by the executor list's row (G11).
 */
import { useId, useState } from "react";
import { api } from "../../../../api/client";
import { Button, Field, Input, Modal } from "../../../../ui/kit";
import { executorRefusal } from "./isolationModel";
import v from "../../../views.module.css";

/** an executor refusal in the page's words, else the client's own reading */
export async function executorCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const text = executorRefusal(e);
    throw text ? new Error(text) : e;
  }
}

export const revokeExecutor = (id: string) => api.post(`/v1/executors/${encodeURIComponent(id)}/revoke`, {});

export function RevokeDialog(props: { name: string; onCancel: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = useState("");
  const helpId = useId();
  return (
    <Modal
      open
      title={`Revoke ${props.name}?`}
      onClose={props.onCancel}
      actions={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button variant="danger" disabled={typed !== props.name} aria-describedby={helpId} onClick={props.onConfirm}>
            Revoke permanently
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <p>
          Revoking is terminal. The executor is quarantined first if it is active, its open work is withdrawn, and it never places anything again. Its
          identity stays; a replacement needs a new identity and key. The act is audited.
        </p>
        <Field label={`Type ${props.name} to confirm`}>
          <Input value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
        </Field>
        <p id={helpId} className={v.faint}>
          {typed === props.name ? "Ready to revoke." : "The revoke button stays disabled until the name matches exactly."}
        </p>
      </div>
    </Modal>
  );
}
