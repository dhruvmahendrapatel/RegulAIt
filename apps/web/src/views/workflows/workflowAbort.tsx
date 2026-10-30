/**
 * Aborting a workflow instance: `POST /v1/workflows/instances/:id/abort`, a
 * driving route the gateway allows its initiator or an admin, never a
 * bootstrap credential, and refuses once the instance is terminal. The workflow
 * list's row (G11) asks first; the intake wizard's start over states the
 * consequence beside its own button and calls the same route.
 */
import { api } from "../../api/client";
import { Button, Modal } from "../../ui/kit";
import { RefusalNotice } from "../../ui/RefusalNotice";
import { useAction } from "../admin/adminKit";
import v from "../views.module.css";

/** the kernel's terminal statuses: an instance in one accepts no event, abort included */
const TERMINAL = ["completed", "denied", "aborted", "rolled_back"];
export const canAbort = (status: string) => !TERMINAL.includes(status);

export const abortInstance = (id: string) => api.post(`/v1/workflows/instances/${id}/abort`, {});

/**
 * The dialog stays open until the call settles, so a refusal (the instance went
 * terminal first, or the caller may not drive it) shows inside it, not only as a toast.
 */
export function AbortWorkflowDialog(props: { id: string; name: string; onClose: () => void; onAborted: () => void }) {
  const act = useAction();
  return (
    <Modal
      open
      title={`Abort ${props.name}?`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={act.busy}
            aria-busy={act.busy || undefined}
            onClick={() =>
              void act.run(() => abortInstance(props.id), "Workflow aborted").then((ok) => {
                if (ok) props.onAborted();
              })
            }
          >
            {act.busy ? "Aborting…" : "Abort workflow"}
          </Button>
        </>
      }
    >
      <p>
        Aborting is final. The workflow stops where it is, its pending sign-offs are withdrawn, its engine runs are cancelled and it accepts no
        further step. Anything it already changed is not undone. The act is audited.
      </p>
      {act.guidance ? (
        <RefusalNotice guidance={act.guidance} />
      ) : (
        act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )
      )}
    </Modal>
  );
}
