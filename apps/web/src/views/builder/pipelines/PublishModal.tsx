/**
 * ADR-0341 slice 3 — publishing a saved draft: what it changes against the live template, the relaxations it makes
 * (accepted only by ticking the box and giving a reason; nothing is pre-selected), then the publish, which the
 * gateway answers with a step-up request bound to the exact bytes shown here (the content hash).
 */
import { useState } from "react";
import { Button, Field, Modal, Textarea } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { plural } from "../../../api/format";
import { pipelineBuilderApi, type BuilderDraftView, type PublishResult } from "./pipelineBuilderApi";
import DiffView from "./DiffView";
import s from "./pipelineBuilder.module.css";

export const MIN_REASON = 10;

/** why the publish button cannot be used yet, or null when it can */
export function publishBlocker(view: BuilderDraftView, accepted: boolean, reason: string): string | null {
  if (view.stale) return "The template was published from elsewhere since this draft was opened.";
  if (!view.validation.valid) return `Fix ${plural(view.validation.issues.length, "problem", "problems")} first.`;
  if (view.diff.patch.length === 0) return "The draft is the same as the live template.";
  if (view.diff.relaxations.length > 0 && !accepted) return "Accept the relaxations to publish.";
  if (view.diff.relaxations.length > 0 && reason.trim().length < MIN_REASON) return `Say why, in at least ${MIN_REASON} characters.`;
  return null;
}

export default function PublishModal(props: {
  open: boolean;
  view: BuilderDraftView;
  onClose: () => void;
  onPublished: (r: PublishResult) => void;
}) {
  const { view } = props;
  const [accepted, setAccepted] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const next = (view.liveVersion ?? 0) + 1;
  const blocker = publishBlocker(view, accepted, reason);
  const relaxing = view.diff.relaxations.length > 0;

  const publish = async () => {
    if (blocker || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await pipelineBuilderApi.publish(view.template.id, {
        revision: view.draft.revision,
        ...(relaxing ? { acceptRelaxations: true, reason: reason.trim() } : {}),
      });
      props.onPublished(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={props.open}
      wide
      title={`Publish version ${next} of ${view.template.name}?`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" aria-disabled={busy || blocker !== null} onClick={() => void publish()}>
            Publish version {next}
          </Button>
        </>
      }
    >
      <div className={s.props}>
        <p className={s.dim}>
          Publishing makes this the definition every new instance starts from. Instances already running keep the
          definition they started with. You will be asked to confirm it is you.
        </p>
        <DiffView diff={view.diff} against={`the live template (version ${view.liveVersion ?? "—"})`} />
        {relaxing && (
          <>
            <label className={s.toolbar}>
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              I accept {view.diff.relaxations.length === 1 ? "this relaxation" : "these relaxations"}
            </label>
            <Field label="Why the workflow is relaxed (recorded in the audit log)">
              <Textarea value={reason} rows={3} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </>
        )}
        {view.validation.contentHash && (
          <p className={s.dim}>
            Content hash <span className={s.code}>{view.validation.contentHash.slice(0, 16)}…</span>
          </p>
        )}
        {blocker && (
          <p className={s.dim} role="status">
            {blocker}
          </p>
        )}
        {error ? (
          <>
            <RefusalNotice error={error} />
            <p className={s.fieldError} role="alert">
              {error instanceof Error ? error.message : "The publish failed."}
            </p>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
