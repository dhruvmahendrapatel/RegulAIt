/**
 * Batch U4 — edit a model card's authored fields (`PATCH /v1/mrm/cards/:id`).
 *
 * The dialog lists exactly which fields the save will change before it is
 * sent, and sends only those (see `cardPatch`). The route asks for no step-up
 * today; the write still goes through `withStepUp`, so a deployment that adds
 * one gets the confirm-it's-you prompt rather than a bare refusal. Bias and
 * fairness slots and evidence are not edited here: evidence has its own attach
 * and detach controls on the card.
 */
import { useState } from "react";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Button, Field, Input, Modal, Textarea } from "../../../ui/kit";
import { useAction } from "../adminKit";
import { CARD_EDIT_REFUSALS, cardPatch, draftOfCard, redactedFields, type CardDraft, type CardTextField, type EditableCard } from "./modelCardEdit";
import { ApiError } from "../../../api/client";
import v from "../../views.module.css";

const FIELD_LABEL: Record<string, string> = {
  intendedUse: "Intended use",
  limitations: "Known limitations",
  note: "Note",
  dataClaims: "Provider data claims",
  standardRefs: "Standard refs",
  pinnedModelVersion: "Pinned model version",
};

export function ModelCardEditButton(props: { card: EditableCard & { id: string }; subject: string; onSaved: () => Promise<unknown> | void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CardDraft>(() => draftOfCard(props.card));
  const act = useAction();
  const { body, problems } = cardPatch(props.card, draft);
  const changed = Object.keys(body);
  // fields the presentation scrub masked on the way out: flagged, and never re-sent unless edited
  const masked = redactedFields(props.card);
  const describedBy = (k: CardTextField) => (masked.includes(k) ? { "aria-describedby": `mc-redacted-${k}` } : {});
  const notice = (k: CardTextField) =>
    masked.includes(k) ? (
      <p id={`mc-redacted-${k}`} className={v.faint} role="note">
        This field was redacted for display; editing replaces it.
      </p>
    ) : null;
  const set = (k: keyof CardDraft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const close = () => {
    setOpen(false);
    act.setError(null);
  };
  const save = () =>
    void act
      .run(async () => {
        try {
          await withStepUp((h) => stepUpApi.patch(`/v1/mrm/cards/${props.card.id}`, body, h));
        } catch (e) {
          const code = e instanceof ApiError && typeof e.payload.error === "string" ? e.payload.error : null;
          if (code && CARD_EDIT_REFUSALS[code]) {
            const detail = e instanceof ApiError && typeof e.payload.detail === "string" ? ` ${e.payload.detail}` : "";
            throw new Error(CARD_EDIT_REFUSALS[code] + detail);
          }
          throw e;
        }
        await props.onSaved();
      }, `Model card saved (${changed.length} field${changed.length === 1 ? "" : "s"} changed)`)
      .then((ok) => {
        if (ok) setOpen(false);
      });
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setDraft(draftOfCard(props.card));
          act.setError(null);
          setOpen(true);
        }}
      >
        Edit card
      </Button>
      <Modal
        open={open}
        wide
        title={`Edit the model card for ${props.subject}`}
        onClose={close}
        actions={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={act.busy || problems.length > 0 || changed.length === 0} onClick={save}>
              {changed.length === 0 ? "Nothing to save" : `Save ${changed.length} change${changed.length === 1 ? "" : "s"}`}
            </Button>
          </>
        }
      >
        <div className={v.stack}>
          <Field label="Intended use">
            <Input value={draft.intendedUse} onChange={set("intendedUse")} required {...describedBy("intendedUse")} />
          </Field>
          {notice("intendedUse")}
          <Field label="Known limitations">
            <Textarea rows={3} value={draft.limitations} onChange={set("limitations")} {...describedBy("limitations")} />
          </Field>
          {notice("limitations")}
          <Field label="Provider data claims (JSON)">
            <Textarea rows={3} value={draft.dataClaims} onChange={set("dataClaims")} {...describedBy("dataClaims")} />
          </Field>
          {notice("dataClaims")}
          <Field label="Standard refs (comma separated)">
            <Input value={draft.standardRefs} onChange={set("standardRefs")} {...describedBy("standardRefs")} />
          </Field>
          {notice("standardRefs")}
          {props.card.agentId && (
            <Field label="Pinned model version (blank = not pinned)">
              <Input value={draft.pinnedModelVersion} onChange={set("pinnedModelVersion")} {...describedBy("pinnedModelVersion")} />
            </Field>
          )}
          {props.card.agentId && notice("pinnedModelVersion")}
          <Field label="Note">
            <Textarea rows={2} value={draft.note} onChange={set("note")} {...describedBy("note")} />
          </Field>
          {notice("note")}
          <div aria-live="polite" className={v.stack}>
            {problems.length > 0 ? (
              <ul className={v.errLine} role="alert">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : changed.length > 0 ? (
              <p>
                This save changes: <strong>{changed.map((k) => FIELD_LABEL[k] ?? k).join(", ")}</strong>. The edit is audited with the field names. It
                does not change an existing sign-off; a certified card whose content moved shows that as drift for its approver.
              </p>
            ) : (
              <p className={v.faint}>No field differs from the saved card yet.</p>
            )}
          </div>
          {act.error && (
            <p className={v.errLine} role="alert">
              {act.error}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
