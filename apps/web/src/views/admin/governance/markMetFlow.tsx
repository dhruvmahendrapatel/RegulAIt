/**
 * "Mark condition met" — the one flow, shared by the record's Conditions card and the decision summary's Next action.
 * A before-go-live condition is confirmed with a note saying what was done; an after-go-live one is marked met
 * directly. The server decides who may close a condition (`canMarkMet` on the detail read) and refuses anyone else.
 */
import { useState } from "react";
import { api } from "../../../api/client";
import type { UseCaseCondition } from "../../../api/types";
import { Button, Field, Modal, Textarea } from "../../../ui/kit";
import { useAction } from "../adminKit";
import v from "../../views.module.css";

/** what a before-go-live condition's closing note may hold (the server's limit) */
export const NOTE_MAX = 2000;

export function useMarkMetFlow(useCaseId: string, onRefresh: () => Promise<void>) {
  const action = useAction();
  const [closing, setClosing] = useState<UseCaseCondition | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const markMet = (row: UseCaseCondition, body: { note?: string }) =>
    action.run(async () => {
      await api.post(`/v1/use-cases/${useCaseId}/conditions/${row.id}/met`, body);
      await onRefresh();
    }, "Condition marked met");
  const closeDialog = () => {
    setClosing(null);
    setNote("");
    setNoteError(null);
  };
  const confirmClosing = async () => {
    if (!closing) return;
    const text = note.trim();
    if (!text) return setNoteError("Say what was done to meet this condition");
    if (text.length > NOTE_MAX) return setNoteError(`Keep the note to ${NOTE_MAX} characters or fewer`);
    if (await markMet(closing, { note: text })) closeDialog();
  };
  const start = (row: UseCaseCondition) => {
    if (row.blocking) setClosing(row);
    else void markMet(row, {});
  };
  const dialog = (
    <Modal
      open={closing !== null}
      title="Mark condition met"
      onClose={closeDialog}
      actions={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" disabled={action.busy} onClick={() => void confirmClosing()}>
            {action.busy ? "Saving…" : "Mark met"}
          </Button>
        </>
      }
    >
      {closing ? (
        <div className={v.stack}>
          <p className={v.dim}>{closing.text}</p>
          <p className={v.faint}>This condition must be met before go-live. Your note is kept with the record.</p>
          <Field label="What was done" error={noteError}>
            <Textarea
              rows={4}
              maxLength={NOTE_MAX}
              value={note}
              aria-invalid={noteError ? true : undefined}
              onChange={(event) => {
                setNote(event.target.value);
                if (noteError) setNoteError(null);
              }}
            />
          </Field>
        </div>
      ) : null}
    </Modal>
  );
  return { start, busy: action.busy, dialog };
}
