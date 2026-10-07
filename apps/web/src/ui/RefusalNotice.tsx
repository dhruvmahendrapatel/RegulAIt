/**
 * ADR-0183 batch 2.3 — renders a refusal the person can resolve themselves
 * (`api/refusals.ts`): the sentence saying what to do next, and a link to the
 * page where they do it. Shown inline beside the action that was refused, not in
 * a toast: a toast disappears, and a link that disappears on a timer is a link
 * nobody can rely on reaching.
 */
import { Link } from "react-router-dom";
import { guidanceOf, type RefusalGuidance } from "../api/refusals";
import s from "./RefusalNotice.module.css";

export function RefusalNotice(props: { guidance?: RefusalGuidance | null; error?: unknown }) {
  const g = props.guidance ?? guidanceOf(props.error);
  if (!g) return null;
  return (
    <div className={s.notice} role="alert" data-testid="refusal-guidance" data-refusal={g.code}>
      <p className={s.message}>{g.message}</p>
      <Link className={s.link} to={g.to}>
        {g.linkLabel}
      </Link>
    </div>
  );
}
