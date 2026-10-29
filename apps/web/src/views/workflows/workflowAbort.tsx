/**
 * Aborting a workflow instance: `POST /v1/workflows/instances/:id/abort`, a
 * driving route the gateway allows its initiator or an admin, never a
 * bootstrap credential, and refuses once the instance is terminal. The workflow
 * list's row (G11) asks first; the intake wizard's start over states the
 * consequence beside its own button and calls the same route.
 */
import { api } from "../../api/client";
import { ConfirmModal } from "../../ui/kit";

/** the kernel's terminal statuses: an instance in one accepts no event, abort included */
const TERMINAL = ["completed", "denied", "aborted", "rolled_back"];
export const canAbort = (status: string) => !TERMINAL.includes(status);

export const abortInstance = (id: string) => api.post(`/v1/workflows/instances/${id}/abort`, {});

export function AbortWorkflowDialog(props: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmModal
      open
      danger
      title={`Abort ${props.name}?`}
      confirmLabel="Abort workflow"
      body={
        <p>
          Aborting is final. The workflow stops where it is, its pending sign-offs are withdrawn, its engine runs are cancelled and it accepts no
          further step. Anything it already changed is not undone. The act is audited.
        </p>
      }
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
}
