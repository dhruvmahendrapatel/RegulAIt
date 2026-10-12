/**
 * Batch U4 — the one dialog every "open this record" in the batch uses: a kit
 * `Modal` (native modality, focus return) around one react-query read, with
 * the loading state announced, the refusal in words (`refusalWords`) and the
 * record rendered only when the read succeeded. Nothing is shown as loaded
 * that was not.
 */
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button, Modal, SkeletonBlock, StatusDot } from "../../ui/kit";
import { refusalWords } from "./detailModel";
import v from "../views.module.css";

export function DetailDialog<T>(props: {
  title: string;
  /** the record's kind, lower case: "rate card", "training job" */
  noun: string;
  query: Pick<UseQueryResult<T>, "data" | "error" | "isLoading" | "isError" | "refetch">;
  onClose: () => void;
  /** a route's own refusal codes, as sentences */
  refusals?: Readonly<Record<string, string>>;
  children: (data: T) => ReactNode;
  actions?: ReactNode;
}) {
  const q = props.query;
  let body: ReactNode;
  if (q.isLoading) {
    body = (
      <div className={v.stack}>
        <p role="status" className={v.faint}>
          Loading the {props.noun}…
        </p>
        <SkeletonBlock lines={4} />
      </div>
    );
  } else if (q.isError || q.data === undefined) {
    const w = refusalWords(props.noun, q.error, props.refusals);
    body = (
      <div className={v.stack} role="alert">
        <div className={v.row}>
          <StatusDot tone={w.retry ? "danger" : "neutral"} />
          <strong>{w.title}</strong>
        </div>
        <p>{w.body}</p>
        {w.retry && (
          <div>
            <Button size="sm" onClick={() => void q.refetch()}>
              Retry
            </Button>
          </div>
        )}
      </div>
    );
  } else {
    body = props.children(q.data);
  }
  return (
    <Modal
      open
      wide
      title={props.title}
      onClose={props.onClose}
      actions={
        <>
          {props.actions}
          <Button onClick={props.onClose}>Close</Button>
        </>
      }
    >
      {body}
    </Modal>
  );
}
