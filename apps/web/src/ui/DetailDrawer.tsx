import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./kit";
import d from "./detailDrawer.module.css";

/**
 * A1: the one detail drawer for a row's detail (a finding's triage or remediation plan, a use-case preview).
 * Non-modal, so the list behind it stays readable; Escape or Close dismisses it and focus returns to the
 * control that opened it. The heading takes focus whenever the subject changes.
 */
export function DetailDrawer(props: {
  /** small caption above the title, e.g. "Shadow-AI finding" */
  type: string;
  title: ReactNode;
  /** status badges under the title */
  meta?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  children: ReactNode;
  /** a stable id for the heading, when a caller's tests or links need one */
  headingId?: string;
  /** changes when the drawer shows another record, to move focus to the new heading */
  subjectKey?: string;
}) {
  const autoId = useId();
  const headingId = props.headingId ?? `${autoId}-title`;
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<Element | null>(null);
  const { onClose } = props;

  useEffect(() => {
    opener.current = document.activeElement;
    return () => {
      const el = opener.current;
      if (el instanceof HTMLElement && el.isConnected) el.focus();
    };
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [props.subjectKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className={d.drawer} role="dialog" aria-modal="false" aria-labelledby={headingId}>
      <div className={d.head}>
        <div className={d.titleBlock}>
          <span className={d.type}>{props.type}</span>
          <h2 id={headingId} ref={heading} tabIndex={-1} className={d.title}>
            {props.title}
          </h2>
          {props.meta ? <div className={d.meta}>{props.meta}</div> : null}
        </div>
        <Button variant="ghost" size="sm" className={d.close} onClick={props.onClose} aria-label={props.closeLabel ?? "Close details"}>
          Close
        </Button>
      </div>
      <div className={d.body}>{props.children}</div>
    </aside>
  );
}
